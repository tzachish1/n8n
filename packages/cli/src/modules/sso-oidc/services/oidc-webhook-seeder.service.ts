import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import {
	AuthIdentity,
	AuthIdentityRepository,
	CredentialsRepository,
	GLOBAL_MEMBER_ROLE,
	isValidEmail,
	type User,
	UserRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

import type {
	ILazySeedProvider,
	LazySeedRequest,
	LazySeedResult,
	LazySeedSkipReason,
} from '@/credentials/lazy-seed-provider.interface';
import { EventService } from '@/events/event.service';
import { OauthService } from '@/oauth/oauth.service';

import { OidcService } from '../oidc.service.ee';
import { GraphTokenExchanger } from './graph-token-exchanger.service';

type DecodedJwtClaims = {
	sub?: string;
	oid?: string;
	iss?: string;
	aud?: string | string[];
	email?: string;
	preferred_username?: string;
	name?: string;
	given_name?: string;
	family_name?: string;
	[key: string]: unknown;
};

type SeedPipelineInput = {
	bearer: string;
	credentialId: string;
	resolverId: string;
	claims: DecodedJwtClaims;
	subject: string;
};

/**
 * Fork §10 Phase 2 — webhook lazy-seed implementation of `ILazySeedProvider`.
 *
 * Invoked by `DynamicCredentialService` after a resolver miss
 * (`CredentialResolverDataNotFoundError`). Validates the inbound bearer
 * against the configured Entra App Registration, resolves (or JIT-provisions)
 * the matching n8n user, performs an On-Behalf-Of exchange via the shared
 * `GraphTokenExchanger`, and persists the resulting Graph tokens through the
 * same `OauthService.saveDynamicCredential` path the OIDC-login seed uses.
 *
 * All outcomes resolve to a structured `LazySeedResult`. Failures never throw
 * — the caller (resolver) is in charge of bubbling the original miss to the
 * user when the seed couldn't recover the request.
 *
 * Concurrency: a singleflight keyed by `(subject, credentialId)` guarantees
 * at most one in-flight OBO per pair; a negative cache (TTL configured by
 * `N8N_SSO_OIDC_GRAPH_LAZY_SEED_NEGATIVE_CACHE_TTL_MS`) short-circuits
 * repeated failures so a misbehaving caller cannot stampede the IdP.
 */
@Service()
export class OidcWebhookSeederService implements ILazySeedProvider {
	private readonly inFlight = new Map<string, Promise<LazySeedResult>>();

	private readonly negativeCache = new Map<string, number>();

	constructor(
		private readonly globalConfig: GlobalConfig,
		private readonly graphTokenExchanger: GraphTokenExchanger,
		private readonly oauthService: OauthService,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly userRepository: UserRepository,
		private readonly eventService: EventService,
		private readonly logger: Logger,
		private readonly oidcService: OidcService,
	) {}

	isEnabled(): boolean {
		return this.globalConfig.sso.oidc.graphLazySeedEnabled;
	}

	isCandidate(request: LazySeedRequest): boolean {
		return (
			typeof request.context.identity === 'string' &&
			request.context.identity.length > 0 &&
			!!request.resolverId
		);
	}

	async tryLazySeed(request: LazySeedRequest): Promise<LazySeedResult> {
		const { context, credentialsResolveMetadata, resolverId } = request;
		const credentialId = credentialsResolveMetadata.id;

		if (!this.isEnabled()) {
			this.emitSkip({ credentialId, resolverId, reason: 'lazy_seed_disabled' });
			return { seeded: false, reason: 'lazy_seed_disabled' };
		}

		const bearer = typeof context.identity === 'string' ? context.identity : '';
		const claims = this.decodeJwtPayloadUnsafe(bearer);
		if (!claims) {
			this.logger.debug('OIDC Graph lazy-seed: inbound bearer is not a decodable JWT', {
				credentialId,
				resolverId,
			});
			this.emitSkip({
				credentialId,
				resolverId,
				reason: 'lazy_seed_token_audience_mismatch',
			});
			return { seeded: false, reason: 'lazy_seed_token_audience_mismatch' };
		}

		const subject = this.extractSubject(claims);
		if (!subject) {
			this.emitSkip({
				credentialId,
				resolverId,
				reason: 'lazy_seed_token_audience_mismatch',
			});
			return { seeded: false, reason: 'lazy_seed_token_audience_mismatch' };
		}

		const { clientId } = this.oidcService.getLazySeedRuntimeConfig();
		if (!this.matchesAudience(claims.aud, clientId)) {
			this.logger.debug('OIDC Graph lazy-seed: bearer audience does not match n8n App', {
				credentialId,
				resolverId,
				subject,
			});
			this.emitSkip({
				subject,
				credentialId,
				resolverId,
				reason: 'lazy_seed_token_audience_mismatch',
			});
			return { seeded: false, reason: 'lazy_seed_token_audience_mismatch' };
		}

		const expectedIssuer = await this.oidcService.getLazySeedExpectedIssuer();
		if (!expectedIssuer || claims.iss !== expectedIssuer) {
			this.logger.debug('OIDC Graph lazy-seed: bearer issuer does not match configured tenant', {
				credentialId,
				resolverId,
				subject,
				expectedIssuer,
				actualIssuer: claims.iss,
			});
			this.emitSkip({
				subject,
				credentialId,
				resolverId,
				reason: 'lazy_seed_token_issuer_mismatch',
			});
			return { seeded: false, reason: 'lazy_seed_token_issuer_mismatch' };
		}

		const optedInResolvers = await this.oidcService.getOptedInResolverIds();
		if (!optedInResolvers.has(resolverId)) {
			this.logger.debug('OIDC Graph lazy-seed: resolver is not opted in to OIDC seeding', {
				credentialId,
				resolverId,
				subject,
			});
			this.emitSkip({
				subject,
				credentialId,
				resolverId,
				reason: 'lazy_seed_resolver_not_opted_in',
			});
			return { seeded: false, reason: 'lazy_seed_resolver_not_opted_in' };
		}

		const cacheKey = `${subject}::${credentialId}`;
		const cachedExpiry = this.negativeCache.get(cacheKey);
		if (cachedExpiry !== undefined) {
			if (cachedExpiry > Date.now()) {
				this.emitSkip({
					subject,
					credentialId,
					resolverId,
					reason: 'lazy_seed_negative_cache_hit',
				});
				return { seeded: false, reason: 'lazy_seed_negative_cache_hit' };
			}
			this.negativeCache.delete(cacheKey);
		}

		const inFlight = this.inFlight.get(cacheKey);
		if (inFlight) return await inFlight;

		const attempt = this.runSeedPipeline({
			bearer,
			credentialId,
			resolverId,
			claims,
			subject,
		});
		this.inFlight.set(cacheKey, attempt);
		try {
			const result = await attempt;
			if (!result.seeded) {
				this.negativeCache.set(
					cacheKey,
					Date.now() + this.globalConfig.sso.oidc.graphLazySeedNegativeCacheTtlMs,
				);
			}
			return result;
		} finally {
			this.inFlight.delete(cacheKey);
		}
	}

	private async runSeedPipeline(input: SeedPipelineInput): Promise<LazySeedResult> {
		const { bearer, credentialId, resolverId, claims, subject } = input;

		let user: User | undefined;
		let userProvisioned = false;
		try {
			const resolved = await this.resolveOrProvisionUser(subject, claims);
			if (resolved) {
				user = resolved.user;
				userProvisioned = resolved.provisioned;
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.warn('OIDC Graph lazy-seed: failed to resolve or provision user', {
				credentialId,
				resolverId,
				subject,
				errorMessage,
			});
			this.emitFailed({ subject, credentialId, resolverId, errorMessage });
			return { seeded: false, reason: 'lazy_seed_obo_failed' };
		}

		if (!user) {
			this.emitSkip({
				subject,
				credentialId,
				resolverId,
				reason: 'lazy_seed_user_not_provisioned',
			});
			return { seeded: false, reason: 'lazy_seed_user_not_provisioned' };
		}

		const credential = await this.credentialsRepository.findOneBy({ id: credentialId });
		if (!credential) {
			const errorMessage = `Credential ${credentialId} not found at lazy-seed time`;
			this.logger.warn('OIDC Graph lazy-seed: credential entity missing', {
				credentialId,
				resolverId,
				subject,
			});
			this.emitFailed({ userId: user.id, subject, credentialId, resolverId, errorMessage });
			return { seeded: false, reason: 'lazy_seed_obo_failed' };
		}

		const { clientId, clientSecret } = this.oidcService.getLazySeedRuntimeConfig();
		const graphTokens = await this.graphTokenExchanger.exchange({
			userId: user.id,
			clientId,
			clientSecret,
			userAccessToken: bearer,
			resolveTokenEndpoint: async () => await this.oidcService.getLazySeedTokenEndpoint(),
		});

		if (!graphTokens) {
			const errorMessage = 'OBO exchange returned no tokens';
			this.emitFailed({ userId: user.id, subject, credentialId, resolverId, errorMessage });
			return { seeded: false, reason: 'lazy_seed_obo_failed' };
		}

		const oauthTokenData: ICredentialDataDecryptedObject = {
			access_token: graphTokens.access_token,
			token_type: 'Bearer',
			expires_in: graphTokens.expires_in ?? 3599,
		};
		if (graphTokens.refresh_token) {
			oauthTokenData.refresh_token = graphTokens.refresh_token;
		}

		try {
			await this.oauthService.saveDynamicCredential(
				credential,
				{ oauthTokenData } as ICredentialDataDecryptedObject,
				bearer,
				resolverId,
				{
					source: 'oidc-webhook-lazy-seed',
					enrolledAt: Date.now(),
					userId: user.id,
					subject,
				},
			);
		} catch (error) {
			// Surface the inner `cause` chain — `CredentialStorageError` wraps the
			// real failure (resolver setSecret throw, DB error, identifier reject)
			// and the wrapper message alone (`Failed to store dynamic credentials
			// data for "X"`) is uselessly generic for triage. Concatenate the
			// outer + inner messages so operators get the root cause in one line.
			const rootCause = this.unwrapErrorMessage(error);
			this.logger.warn('OIDC Graph lazy-seed: failed to persist seeded credential', {
				credentialId,
				resolverId,
				subject,
				userId: user.id,
				errorMessage: rootCause,
			});
			this.emitFailed({
				userId: user.id,
				subject,
				credentialId,
				resolverId,
				errorMessage: rootCause,
			});
			return { seeded: false, reason: 'lazy_seed_obo_failed' };
		}

		this.eventService.emit('oidc-graph-token-lazy-seeded', {
			userId: user.id,
			subject,
			resolverId,
			credentialId,
			credentialType: credential.type,
			userProvisioned,
		});
		this.logger.info('OIDC Graph lazy-seed: credential populated via webhook', {
			userId: user.id,
			credentialId,
			credentialType: credential.type,
			resolverId,
			subject,
			userProvisioned,
		});
		return { seeded: true };
	}

	/**
	 * Resolves the bearer's `sub` to an existing `auth_identity` row, or
	 * provisions a new user when `graphLazySeedProvisionUser` is enabled.
	 * Returns `undefined` when JIT is disabled and no match is found — that
	 * outcome is logged as `lazy_seed_user_not_provisioned`, not as a failure.
	 */
	private async resolveOrProvisionUser(
		subject: string,
		claims: DecodedJwtClaims,
	): Promise<{ user: User; provisioned: boolean } | undefined> {
		const existing = await this.authIdentityRepository.findOne({
			where: { providerId: subject, providerType: 'oidc' },
			relations: { user: { role: true } },
		});
		if (existing) return { user: existing.user, provisioned: false };

		if (!this.globalConfig.sso.oidc.graphLazySeedProvisionUser) {
			return undefined;
		}

		const email = this.extractEmail(claims);
		if (!email) {
			this.logger.warn(
				'OIDC Graph lazy-seed: cannot JIT-provision user — bearer lacks usable email claim',
				{ subject },
			);
			return undefined;
		}

		const byEmail = await this.userRepository.findOne({
			where: { email },
			relations: ['authIdentities', 'role'],
		});
		if (byEmail) {
			const identity = this.authIdentityRepository.create({
				providerId: subject,
				providerType: 'oidc',
				userId: byEmail.id,
			});
			await this.authIdentityRepository.save(identity);
			return { user: byEmail, provisioned: false };
		}

		const created = await this.userRepository.manager.transaction(async (trx) => {
			const { user: newUser } = await this.userRepository.createUserWithProject(
				{
					firstName: typeof claims.given_name === 'string' ? claims.given_name : undefined,
					lastName: typeof claims.family_name === 'string' ? claims.family_name : undefined,
					email,
					authIdentities: [],
					role: GLOBAL_MEMBER_ROLE,
					password: 'no password set',
				},
				trx,
			);

			await trx.save(
				trx.create(AuthIdentity, {
					providerId: subject,
					providerType: 'oidc',
					userId: newUser.id,
				}),
			);

			return newUser;
		});

		this.logger.info('OIDC Graph lazy-seed: JIT-provisioned new user from webhook bearer', {
			userId: created.id,
			subject,
			email,
		});

		return { user: created, provisioned: true };
	}

	private matchesAudience(aud: string | string[] | undefined, clientId: string): boolean {
		if (!aud || !clientId) return false;
		const auds = Array.isArray(aud) ? aud : [aud];
		const expected = new Set<string>([clientId, `api://${clientId}`]);
		return auds.some((value) => expected.has(value));
	}

	private extractSubject(claims: DecodedJwtClaims): string | undefined {
		const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
		if (sub) return sub;
		const oid = typeof claims.oid === 'string' ? claims.oid.trim() : '';
		return oid || undefined;
	}

	private extractEmail(claims: DecodedJwtClaims): string | undefined {
		const candidate =
			typeof claims.email === 'string'
				? claims.email
				: typeof claims.preferred_username === 'string'
					? claims.preferred_username
					: undefined;
		if (!candidate) return undefined;
		const normalized = candidate.trim().toLowerCase();
		return isValidEmail(normalized) ? normalized : undefined;
	}

	/**
	 * Parses the payload segment of a JWT without verifying its signature.
	 * Returns `undefined` for opaque tokens, malformed JWTs, or non-object
	 * payloads. The bearer was already validated upstream by the resolver's
	 * introspection on the read path; this decode only extracts claims for
	 * audience/issuer pinning and JIT provisioning.
	 */
	private decodeJwtPayloadUnsafe(token: string): DecodedJwtClaims | undefined {
		const parts = token.split('.');
		if (parts.length !== 3) return undefined;
		try {
			const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
			const parsed: unknown = JSON.parse(payload);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as DecodedJwtClaims;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Walk an error's `cause` chain and concatenate the messages so operators
	 * see the root failure ("UserInfo query failed", "ECONNREFUSED", "invalid
	 * grant", JWT verification reason) instead of just the outer wrapper
	 * (`Failed to store dynamic credentials data for "X"`). Bounded to a small
	 * depth so a self-referential `cause` cannot loop.
	 */
	private unwrapErrorMessage(error: unknown): string {
		const messages: string[] = [];
		let current: unknown = error;
		for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
			if (current instanceof Error) {
				if (current.message) messages.push(current.message);
				current = (current as { cause?: unknown }).cause;
			} else {
				messages.push(String(current));
				break;
			}
		}
		return messages.length > 0 ? messages.join(' → ') : 'unknown error';
	}

	private emitSkip(payload: {
		credentialId: string;
		resolverId: string;
		reason: LazySeedSkipReason;
		subject?: string;
		userId?: string;
	}) {
		this.eventService.emit('oidc-graph-token-lazy-seed-skipped', payload);
	}

	private emitFailed(payload: {
		subject: string;
		credentialId: string;
		resolverId: string;
		errorMessage: string;
		userId?: string;
	}) {
		this.eventService.emit('oidc-graph-token-lazy-seed-failed', payload);
	}
}

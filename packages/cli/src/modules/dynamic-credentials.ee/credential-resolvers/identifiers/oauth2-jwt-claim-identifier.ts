import { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import { Service } from '@n8n/di';
import axios from 'axios';
import {
	createLocalJWKSet,
	errors as joseErrors,
	jwtVerify,
	type JSONWebKeySet,
	type JWTPayload,
} from 'jose';
import type { ICredentialContext } from 'n8n-workflow';
import { z } from 'zod';

import { CacheService } from '@/services/cache/cache.service';

import { IdentifierValidationError, ITokenIdentifier } from './identifier-interface';
import { OAuth2OptionsSchema, sha256 } from './oauth2-utils';

// Use minimum of 30 seconds to avoid cache thrashing
// Cap at 5 minutes to ensure periodic revalidation
const MIN_TOKEN_CACHE_TIMEOUT = 30 * Time.seconds.toMilliseconds;
const MAX_TOKEN_CACHE_TIMEOUT = 5 * Time.minutes.toMilliseconds;
const DEFAULT_CACHE_TIMEOUT = 60 * Time.seconds.toMilliseconds;
const METADATA_CACHE_TIMEOUT = 1 * Time.hours.toMilliseconds;
const JWKS_NETWORK_TIMEOUT_MS = 10 * Time.seconds.toMilliseconds;

/**
 * Fork §10 Phase 2 — third validation strategy for the OAuth credential
 * resolver. Verifies an inbound JWT entirely locally using JWKS published
 * via the IdP's discovery document, then reads the subject claim from the
 * verified payload. Designed for Entra-style identity flows where:
 *
 *   • the inbound bearer's audience is an API scope (e.g. `api://<client>`)
 *     and therefore cannot be sent to `/userinfo` or to `/introspect`
 *     (the latter not being implemented by Entra at all),
 *   • the n8n instance is the protected resource and can perform its own
 *     JWT validation against JWKS — exactly the pattern Microsoft requires
 *     for protected APIs.
 *
 * Trust boundary: this identifier accepts any JWT whose signature chains
 * to a key in the discovery's JWKS AND whose `aud`/`iss` match the
 * configured values. Operators MUST set `audience` to the n8n App
 * Registration's exact `aud` claim and leave `metadataUri` pointing at
 * the canonical OIDC discovery document — otherwise a bearer issued for
 * any other audience in the same tenant could be accepted.
 */
export const OAuth2JwtClaimOptionsSchema = z.object({
	...OAuth2OptionsSchema.shape,
	validation: z.literal('oauth2-jwt-claim'),
	audience: z.string().trim().min(1, 'Audience is required'),
});

type OAuth2JwtClaimOptions = z.infer<typeof OAuth2JwtClaimOptionsSchema>;

const OAuth2MetadataSchema = z.object({
	issuer: z.string().url(),
	jwks_uri: z.string().url(),
});

type OAuth2Metadata = z.infer<typeof OAuth2MetadataSchema>;

const JwksDocumentSchema = z
	.object({
		keys: z.array(z.record(z.string(), z.unknown())).min(1),
	})
	.passthrough();

const CACHE_PREFIX = 'oauth2-jwt-claim-identifier';

@Service()
export class OAuth2JwtClaimIdentifier implements ITokenIdentifier {
	constructor(
		private readonly logger: Logger,
		private readonly cache: CacheService,
	) {}

	async validateOptions(identifierOptions: Record<string, unknown>): Promise<void> {
		const options = this.parseOptions(identifierOptions);
		let metadata;
		try {
			metadata = await this.fetchMetadata(options, true);
		} catch (error) {
			if (error instanceof IdentifierValidationError) {
				throw error;
			}
			this.logger.error(`Failed to reach OAuth2 metadata URL ${options.metadataUri}`, {
				error,
			});
			throw new IdentifierValidationError(
				`Could not reach metadata URL: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (!metadata.jwks_uri) {
			this.logger.error('Metadata does not contain a JWKS URI');
			throw new IdentifierValidationError('Metadata does not contain a JWKS URI');
		}
	}

	async resolve(
		context: ICredentialContext,
		identifierOptions: Record<string, unknown>,
	): Promise<string> {
		const options = this.parseOptions(identifierOptions);
		const metadata = await this.fetchMetadata(options);

		const hashedToken = sha256(context.identity);

		const identifierCacheKey = `${CACHE_PREFIX}:subject:${metadata.issuer}:${options.audience}:${hashedToken}`;
		const cached = await this.cache.get<string>(identifierCacheKey);
		if (cached) {
			return cached;
		}

		let ttl = DEFAULT_CACHE_TIMEOUT;
		const { subject, ttl: ttlOverwrite } = await this.resolveBasedOnJwtClaims(
			metadata,
			options,
			context,
		);
		if (ttlOverwrite) {
			ttl = ttlOverwrite;
		}

		await this.cache.set(identifierCacheKey, subject, ttl);
		return subject;
	}

	// ------------------------ Private Methods ----------------------- //

	private parseOptions(options: Record<string, unknown>): OAuth2JwtClaimOptions {
		try {
			return OAuth2JwtClaimOptionsSchema.parse(options);
		} catch (error) {
			this.logger.error('Invalid OAuth2 identifier options', { error });
			throw new IdentifierValidationError('Invalid OAuth2 identifier options', {
				cause: error,
			});
		}
	}

	private async fetchMetadata(
		options: OAuth2JwtClaimOptions,
		skipCache: boolean = false,
	): Promise<OAuth2Metadata> {
		const cacheKey = `${CACHE_PREFIX}:metadata:${options.metadataUri}`;
		if (!skipCache) {
			const cached = await this.cache.get<OAuth2Metadata>(cacheKey);
			if (cached) {
				return cached;
			}
		}

		const response = await axios.get(options.metadataUri, {
			validateStatus: () => true,
			timeout: JWKS_NETWORK_TIMEOUT_MS,
		});

		if (response.status !== 200) {
			this.logger.error(
				`Failed to fetch OAuth2 metadata from ${options.metadataUri}, status code: ${response.status}`,
			);
			throw new IdentifierValidationError(
				`Failed to fetch OAuth2 metadata, status code: ${response.status}`,
			);
		}

		try {
			const metadata = OAuth2MetadataSchema.parse(response.data);
			if (!skipCache) {
				await this.cache.set(cacheKey, metadata, METADATA_CACHE_TIMEOUT);
			}
			return metadata;
		} catch (error) {
			this.logger.error('Invalid OAuth2 metadata format', { error });
			throw new IdentifierValidationError('Invalid OAuth2 metadata format', { cause: error });
		}
	}

	/**
	 * Fetches the JWKS document via axios (so corporate proxy env vars like
	 * HTTP_PROXY are respected) and caches the raw document. The local key
	 * set is then rebuilt per call from the cached JSON — cheap, no extra
	 * I/O, and lets jose pick the right key by `kid` during verification.
	 */
	private async fetchJwks(jwksUri: string): Promise<JSONWebKeySet> {
		const cacheKey = `${CACHE_PREFIX}:jwks:${jwksUri}`;
		const cached = await this.cache.get<JSONWebKeySet>(cacheKey);
		if (cached) {
			return cached;
		}

		const response = await axios.get(jwksUri, {
			validateStatus: () => true,
			timeout: JWKS_NETWORK_TIMEOUT_MS,
		});

		if (response.status !== 200) {
			this.logger.error(`Failed to fetch JWKS from ${jwksUri}, status code: ${response.status}`);
			throw new IdentifierValidationError(`Failed to fetch JWKS, status code: ${response.status}`);
		}

		const parsed = JwksDocumentSchema.safeParse(response.data);
		if (!parsed.success) {
			this.logger.error('Invalid JWKS document format', { error: parsed.error });
			throw new IdentifierValidationError('Invalid JWKS document format');
		}

		const jwks = parsed.data as JSONWebKeySet;
		await this.cache.set(cacheKey, jwks, METADATA_CACHE_TIMEOUT);
		return jwks;
	}

	private async resolveBasedOnJwtClaims(
		metadata: OAuth2Metadata,
		options: OAuth2JwtClaimOptions,
		context: ICredentialContext,
	): Promise<{ subject: string; ttl?: number }> {
		const jwks = await this.fetchJwks(metadata.jwks_uri);
		const keySet = createLocalJWKSet(jwks);

		let payload: JWTPayload;
		try {
			const result = await jwtVerify(context.identity, keySet, {
				audience: options.audience,
				issuer: metadata.issuer,
			});
			payload = result.payload;
		} catch (error) {
			const reason = this.classifyJoseError(error);
			this.logger.error('JWT verification failed', {
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new IdentifierValidationError(`JWT verification failed: ${reason}`);
		}

		const subjectRaw = payload[options.subjectClaim as keyof JWTPayload];
		if (subjectRaw === undefined || subjectRaw === null || subjectRaw === '') {
			this.logger.error(`JWT missing subject claim (${options.subjectClaim})`);
			throw new IdentifierValidationError(`JWT missing subject claim (${options.subjectClaim})`);
		}
		const subject = String(subjectRaw);

		this.logger.debug('JWT verified successfully', { subject });

		let ttl: number | undefined;
		if (typeof payload.exp === 'number') {
			const expiresIn = payload.exp * 1000 - Date.now();
			if (expiresIn > 0) {
				ttl = Math.max(MIN_TOKEN_CACHE_TIMEOUT, Math.min(expiresIn, MAX_TOKEN_CACHE_TIMEOUT));
			} else {
				ttl = MIN_TOKEN_CACHE_TIMEOUT;
			}
		}

		return { subject, ttl };
	}

	/**
	 * Maps the most useful `jose` error subclasses to short, log-safe
	 * reason strings. Anything unrecognised becomes `unknown_error` —
	 * the underlying `error.message` is also logged separately so the
	 * operator can correlate.
	 */
	private classifyJoseError(error: unknown): string {
		if (error instanceof joseErrors.JWTExpired) return 'token_expired';
		if (error instanceof joseErrors.JWTClaimValidationFailed) {
			return `claim_mismatch:${error.claim}`;
		}
		if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
			return 'bad_signature';
		}
		if (error instanceof joseErrors.JWKSNoMatchingKey) return 'unknown_kid';
		if (error instanceof joseErrors.JWSInvalid || error instanceof joseErrors.JWTInvalid) {
			return 'malformed_jwt';
		}
		return 'unknown_error';
	}
}

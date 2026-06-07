import type { Logger } from '@n8n/backend-common';
import { mockLogger } from '@n8n/backend-test-utils';
import type { GlobalConfig } from '@n8n/config';
import type { AuthIdentityRepository, CredentialsRepository, UserRepository, User } from '@n8n/db';
import { mock, type MockProxy } from 'jest-mock-extended';
import type { ICredentialContext } from 'n8n-workflow';

import type { CredentialResolveMetadata } from '@/credentials/credential-resolution-provider.interface';
import type { EventService } from '@/events/event.service';
import type { OauthService } from '@/oauth/oauth.service';

import type { GraphTokenExchanger } from '../graph-token-exchanger.service';
import { OidcWebhookSeederService } from '../oidc-webhook-seeder.service';
import type { OidcService } from '../../oidc.service.ee';

/**
 * Encode a JWT-shaped string with the given payload. Signature is irrelevant
 * (the seeder does not verify it; the resolver does that on the read path).
 */
function encodeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${header}.${body}.sig`;
}

const ISSUER = 'https://login.microsoftonline.com/tenant-id/v2.0';
const CLIENT_ID = 'n8n-app-client-id';
const SUBJECT = 'subject-guid-abc';
const CREDENTIAL_ID = 'cred-id-123';
const RESOLVER_ID = 'resolver-id-xyz';
const CREDENTIAL_TYPE = 'microsoftOutlookOAuth2Api';

const validBearer = () =>
	encodeJwt({
		sub: SUBJECT,
		oid: SUBJECT,
		iss: ISSUER,
		aud: CLIENT_ID,
		email: 'user@example.com',
		given_name: 'Test',
		family_name: 'User',
	});

const buildRequest = (overrides: Partial<{ identity: string; resolverId: string }> = {}) => ({
	context: mock<ICredentialContext>({
		identity: overrides.identity ?? validBearer(),
	}),
	credentialsResolveMetadata: {
		id: CREDENTIAL_ID,
		name: 'Microsoft Outlook account',
		type: CREDENTIAL_TYPE,
		isResolvable: true,
	} as CredentialResolveMetadata,
	resolverId: overrides.resolverId ?? RESOLVER_ID,
});

describe('OidcWebhookSeederService', () => {
	let service: OidcWebhookSeederService;
	let globalConfig: GlobalConfig;
	let graphTokenExchanger: MockProxy<GraphTokenExchanger>;
	let oauthService: MockProxy<OauthService>;
	let credentialsRepository: MockProxy<CredentialsRepository>;
	let authIdentityRepository: MockProxy<AuthIdentityRepository>;
	let userRepository: MockProxy<UserRepository>;
	let eventService: MockProxy<EventService>;
	let logger: Logger;
	let oidcService: MockProxy<OidcService>;

	const buildService = () =>
		new OidcWebhookSeederService(
			globalConfig,
			graphTokenExchanger,
			oauthService,
			credentialsRepository,
			authIdentityRepository,
			userRepository,
			eventService,
			logger,
			oidcService,
		);

	beforeEach(() => {
		jest.resetAllMocks();

		globalConfig = mock<GlobalConfig>({
			sso: {
				oidc: {
					graphLazySeedEnabled: true,
					graphLazySeedProvisionUser: true,
					graphLazySeedNegativeCacheTtlMs: 60_000,
				},
			},
		});
		graphTokenExchanger = mock<GraphTokenExchanger>();
		oauthService = mock<OauthService>();
		credentialsRepository = mock<CredentialsRepository>();
		authIdentityRepository = mock<AuthIdentityRepository>();
		userRepository = mock<UserRepository>();
		eventService = mock<EventService>();
		logger = mockLogger();
		oidcService = mock<OidcService>();

		oidcService.getLazySeedRuntimeConfig.mockReturnValue({
			clientId: CLIENT_ID,
			clientSecret: 'client-secret',
		});
		oidcService.getLazySeedExpectedIssuer.mockResolvedValue(ISSUER);
		oidcService.getLazySeedTokenEndpoint.mockResolvedValue(
			'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
		);
		oidcService.getOptedInResolverIds.mockResolvedValue(new Set([RESOLVER_ID]));

		service = buildService();
	});

	describe('feature gate', () => {
		it('short-circuits with `lazy_seed_disabled` when the master flag is off', async () => {
			(globalConfig.sso.oidc as { graphLazySeedEnabled: boolean }).graphLazySeedEnabled = false;

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_disabled' });
			expect(graphTokenExchanger.exchange).not.toHaveBeenCalled();
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seed-skipped',
				expect.objectContaining({ reason: 'lazy_seed_disabled' }),
			);
		});

		it('reports `isEnabled` and `isCandidate` in line with the config + bearer presence', () => {
			expect(service.isEnabled()).toBe(true);

			expect(service.isCandidate(buildRequest())).toBe(true);
			expect(
				service.isCandidate({
					...buildRequest(),
					context: mock<ICredentialContext>({ identity: '' }),
				}),
			).toBe(false);
		});
	});

	describe('bearer validation', () => {
		it('skips with `lazy_seed_token_audience_mismatch` for opaque (non-JWT) bearers', async () => {
			const result = await service.tryLazySeed(buildRequest({ identity: 'opaque-token-blob' }));

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_token_audience_mismatch' });
			expect(graphTokenExchanger.exchange).not.toHaveBeenCalled();
		});

		it('skips when the bearer audience does not match the n8n App registration', async () => {
			const bearer = encodeJwt({
				sub: SUBJECT,
				iss: ISSUER,
				aud: 'some-other-app',
			});

			const result = await service.tryLazySeed(buildRequest({ identity: bearer }));

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_token_audience_mismatch' });
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seed-skipped',
				expect.objectContaining({
					reason: 'lazy_seed_token_audience_mismatch',
					subject: SUBJECT,
				}),
			);
		});

		it('accepts `api://<clientId>` as an equivalent audience', async () => {
			const bearer = encodeJwt({
				sub: SUBJECT,
				iss: ISSUER,
				aud: `api://${CLIENT_ID}`,
				email: 'user@example.com',
			});
			arrangeHappyPath();

			const result = await service.tryLazySeed(buildRequest({ identity: bearer }));

			expect(result).toEqual({ seeded: true });
		});

		it('skips with `lazy_seed_token_issuer_mismatch` when iss does not match discovery', async () => {
			oidcService.getLazySeedExpectedIssuer.mockResolvedValue('https://different-tenant.example/');

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_token_issuer_mismatch' });
			expect(graphTokenExchanger.exchange).not.toHaveBeenCalled();
		});
	});

	describe('resolver opt-in gate', () => {
		it('skips with `lazy_seed_resolver_not_opted_in` when resolver is not opted in', async () => {
			oidcService.getOptedInResolverIds.mockResolvedValue(new Set(['some-other-resolver']));

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_resolver_not_opted_in' });
			expect(graphTokenExchanger.exchange).not.toHaveBeenCalled();
		});
	});

	describe('user provisioning', () => {
		it('happy path: existing auth_identity → uses that user, emits lazy-seeded with userProvisioned=false', async () => {
			arrangeHappyPath();

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: true });
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seeded',
				expect.objectContaining({
					userId: 'existing-user-id',
					subject: SUBJECT,
					resolverId: RESOLVER_ID,
					credentialId: CREDENTIAL_ID,
					credentialType: CREDENTIAL_TYPE,
					userProvisioned: false,
				}),
			);
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
		});

		it('JIT disabled + unknown subject → skipped with `lazy_seed_user_not_provisioned`', async () => {
			(
				globalConfig.sso.oidc as { graphLazySeedProvisionUser: boolean }
			).graphLazySeedProvisionUser = false;
			authIdentityRepository.findOne.mockResolvedValue(null);
			userRepository.findOne.mockResolvedValue(null);

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_user_not_provisioned' });
			expect(graphTokenExchanger.exchange).not.toHaveBeenCalled();
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
		});

		it('JIT enabled + email-collision → links new auth_identity to existing user', async () => {
			arrangeHappyPath({ existingAuthIdentity: false, userByEmail: true });

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: true });
			expect(authIdentityRepository.save).toHaveBeenCalledTimes(1);
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seeded',
				expect.objectContaining({
					userProvisioned: false,
					userId: 'user-by-email-id',
				}),
			);
		});

		it('JIT enabled + unknown subject + no email collision → provisions new user', async () => {
			arrangeHappyPath({ existingAuthIdentity: false, jitProvision: true });

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: true });
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seeded',
				expect.objectContaining({
					userProvisioned: true,
					userId: 'jit-user-id',
				}),
			);
		});

		it('JIT throws (e.g. txn failure) → skipped with `lazy_seed_obo_failed` + emits failed event', async () => {
			arrangeHappyPath({ existingAuthIdentity: false, jitProvision: 'throws' });

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_obo_failed' });
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seed-failed',
				expect.objectContaining({
					subject: SUBJECT,
					resolverId: RESOLVER_ID,
					credentialId: CREDENTIAL_ID,
				}),
			);
		});
	});

	describe('OBO + persistence', () => {
		it('skips with `lazy_seed_obo_failed` when GraphTokenExchanger returns null', async () => {
			arrangeHappyPath();
			graphTokenExchanger.exchange.mockResolvedValue(null);

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_obo_failed' });
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seed-failed',
				expect.objectContaining({ subject: SUBJECT, credentialId: CREDENTIAL_ID }),
			);
		});

		it('skips with `lazy_seed_obo_failed` when saveDynamicCredential throws', async () => {
			arrangeHappyPath();
			oauthService.saveDynamicCredential.mockRejectedValue(new Error('DB write conflict'));

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_obo_failed' });
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seed-failed',
				expect.objectContaining({ errorMessage: 'DB write conflict' }),
			);
		});

		// Regression guard for the 2026-06-07 hotfix. Previously the seeder
		// passed `graphTokens.access_token` (a Microsoft-signed,
		// Graph-audience JWT) as the `authHeader`, which the OAuth resolver's
		// identifier then tried to verify against the n8n-app JWKS on the
		// write path — failing with `bad_signature` and silently aborting
		// every lazy-seed. The contract is: the *upstream* bearer (the
		// inbound user JWT, n8n-app audience) must be passed so the
		// identifier derives the same subject on read and write.
		it('passes the inbound bearer (not the Graph access token) as authHeader to saveDynamicCredential', async () => {
			arrangeHappyPath();
			const bearer = validBearer();

			await service.tryLazySeed(buildRequest({ identity: bearer }));

			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			const [, , authHeaderArg] = oauthService.saveDynamicCredential.mock.calls[0];
			expect(authHeaderArg).toBe(bearer);
			expect(authHeaderArg).not.toBe('graph-access-token');
		});

		it('surfaces nested cause chain in the lazy-seed-failed event when persistence wraps an inner error', async () => {
			arrangeHappyPath();
			const innerCause = new Error('UserInfo query failed');
			const wrapper = new Error('Failed to store dynamic credentials data for "X"', {
				cause: innerCause,
			});
			oauthService.saveDynamicCredential.mockRejectedValue(wrapper);

			const result = await service.tryLazySeed(buildRequest());

			expect(result).toEqual({ seeded: false, reason: 'lazy_seed_obo_failed' });
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seed-failed',
				expect.objectContaining({
					errorMessage: expect.stringContaining('UserInfo query failed'),
				}),
			);
		});
	});

	describe('singleflight + negative cache', () => {
		it('coalesces concurrent calls for the same `(subject, credentialId)` into one OBO', async () => {
			arrangeHappyPath();

			// Withhold the OBO response until both calls have reached the
			// singleflight gate. A controllable deferred avoids racing the
			// microtask queue.
			const oboResponse = {
				access_token: 'graph-access-token',
				refresh_token: 'graph-refresh-token',
				expires_in: 3599,
			};
			let resolveExchange: ((value: typeof oboResponse) => void) | undefined;
			const exchangePromise = new Promise<typeof oboResponse>((resolve) => {
				resolveExchange = resolve;
			});
			graphTokenExchanger.exchange.mockReturnValue(exchangePromise);

			const first = service.tryLazySeed(buildRequest());
			const second = service.tryLazySeed(buildRequest());

			// Yield enough microtasks for both calls to reach the singleflight
			// gate (each goes through several `await` hops before the OBO).
			for (let i = 0; i < 20; i++) await Promise.resolve();

			resolveExchange?.(oboResponse);

			const [r1, r2] = await Promise.all([first, second]);
			expect(r1).toEqual({ seeded: true });
			expect(r2).toEqual({ seeded: true });
			expect(graphTokenExchanger.exchange).toHaveBeenCalledTimes(1);
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
		});

		it('negative-caches failed attempts so subsequent calls short-circuit', async () => {
			arrangeHappyPath();
			graphTokenExchanger.exchange.mockResolvedValue(null);

			const first = await service.tryLazySeed(buildRequest());
			expect(first).toEqual({ seeded: false, reason: 'lazy_seed_obo_failed' });

			const second = await service.tryLazySeed(buildRequest());
			expect(second).toEqual({ seeded: false, reason: 'lazy_seed_negative_cache_hit' });
			expect(graphTokenExchanger.exchange).toHaveBeenCalledTimes(1);
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-lazy-seed-skipped',
				expect.objectContaining({ reason: 'lazy_seed_negative_cache_hit' }),
			);
		});
	});

	// ───────────────────────────────────────────────────────────────────────
	// Test fixtures
	// ───────────────────────────────────────────────────────────────────────

	type HappyPathOptions = {
		existingAuthIdentity?: boolean;
		userByEmail?: boolean;
		jitProvision?: boolean | 'throws';
	};

	function arrangeHappyPath(opts: HappyPathOptions = {}) {
		const { existingAuthIdentity = true, userByEmail = false, jitProvision = false } = opts;

		if (existingAuthIdentity) {
			authIdentityRepository.findOne.mockResolvedValue({
				user: mock<User>({ id: 'existing-user-id', email: 'user@example.com' }),
			} as never);
		} else {
			authIdentityRepository.findOne.mockResolvedValue(null);
			if (userByEmail) {
				userRepository.findOne.mockResolvedValue(
					mock<User>({ id: 'user-by-email-id', email: 'user@example.com' }) as never,
				);
				authIdentityRepository.create.mockReturnValue({} as never);
				authIdentityRepository.save.mockResolvedValue({} as never);
			} else {
				userRepository.findOne.mockResolvedValue(null);
				const trxManager = {
					save: jest.fn().mockResolvedValue({}),
					create: jest.fn().mockReturnValue({}),
				};
				const writableRepo = userRepository as unknown as {
					manager: { transaction: jest.Mock };
					createUserWithProject: jest.Mock;
				};
				if (jitProvision === 'throws') {
					writableRepo.manager = {
						transaction: jest.fn().mockRejectedValue(new Error('transaction failed')),
					};
				} else {
					writableRepo.manager = {
						transaction: jest
							.fn()
							.mockImplementation(async (cb: (m: typeof trxManager) => unknown) => {
								writableRepo.createUserWithProject = jest
									.fn()
									.mockResolvedValue({ user: mock<User>({ id: 'jit-user-id' }) });
								return await cb(trxManager);
							}),
					};
					(
						userRepository as unknown as {
							createUserWithProject: jest.Mock;
						}
					).createUserWithProject = jest.fn().mockResolvedValue({
						user: mock<User>({ id: 'jit-user-id', email: 'user@example.com' }),
					});
				}
			}
		}

		credentialsRepository.findOneBy.mockResolvedValue({
			id: CREDENTIAL_ID,
			name: 'Microsoft Outlook account',
			type: CREDENTIAL_TYPE,
			data: 'encrypted-data',
			isResolvable: true,
		} as never);

		graphTokenExchanger.exchange.mockResolvedValue({
			access_token: 'graph-access-token',
			refresh_token: 'graph-refresh-token',
			expires_in: 3599,
		});

		oauthService.saveDynamicCredential.mockResolvedValue(undefined as never);
	}
});

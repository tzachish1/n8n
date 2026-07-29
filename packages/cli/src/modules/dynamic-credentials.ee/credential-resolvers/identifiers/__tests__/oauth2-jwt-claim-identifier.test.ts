import { mockLogger } from '@n8n/backend-test-utils';
import { Time } from '@n8n/constants';
import axios from 'axios';
import { mock } from 'jest-mock-extended';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import type { CacheService } from '@/services/cache/cache.service';

import { IdentifierValidationError } from '../identifier-interface';
import { OAuth2JwtClaimIdentifier } from '../oauth2-jwt-claim-identifier';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

type SignedTokenContext = {
	privateKey: CryptoKey;
	publicJwk: JWK;
};

const ISSUER = 'https://login.microsoftonline.com/tid/v2.0';
const METADATA_URI = 'https://login.microsoftonline.com/tid/v2.0/.well-known/openid-configuration';
const JWKS_URI = 'https://login.microsoftonline.com/tid/discovery/v2.0/keys';
const AUDIENCE = '390f995b-ed37-46e6-ae8c-7b11248dd67c';

const validMetadata = {
	issuer: ISSUER,
	jwks_uri: JWKS_URI,
};

async function createKeyContext(kid = 'test-kid-1'): Promise<SignedTokenContext> {
	const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
	const publicJwk = await exportJWK(publicKey);
	publicJwk.kid = kid;
	publicJwk.alg = 'RS256';
	publicJwk.use = 'sig';
	return { privateKey, publicJwk };
}

async function signToken(
	keyCtx: SignedTokenContext,
	overrides: {
		audience?: string;
		issuer?: string;
		sub?: string;
		oid?: string;
		expSecondsFromNow?: number;
		nbfSecondsFromNow?: number;
		kid?: string;
		extra?: Record<string, unknown>;
	} = {},
): Promise<string> {
	const payload: Record<string, unknown> = {
		sub: overrides.sub ?? 'subject-from-jwt',
		...(overrides.oid !== undefined ? { oid: overrides.oid } : {}),
		...(overrides.extra ?? {}),
	};
	const nowSeconds = Math.floor(Date.now() / 1000);
	let builder = new SignJWT(payload)
		.setProtectedHeader({
			alg: 'RS256',
			kid: overrides.kid ?? (keyCtx.publicJwk.kid as string),
		})
		.setIssuer(overrides.issuer ?? ISSUER)
		.setAudience(overrides.audience ?? AUDIENCE)
		.setIssuedAt(nowSeconds);

	if (overrides.expSecondsFromNow !== undefined) {
		builder = builder.setExpirationTime(nowSeconds + overrides.expSecondsFromNow);
	} else {
		builder = builder.setExpirationTime(nowSeconds + 3600);
	}
	if (overrides.nbfSecondsFromNow !== undefined) {
		builder = builder.setNotBefore(nowSeconds + overrides.nbfSecondsFromNow);
	}

	return await builder.sign(keyCtx.privateKey);
}

describe('OAuth2JwtClaimIdentifier', () => {
	const logger = mockLogger();
	const cache = mock<CacheService>();
	let identifier: OAuth2JwtClaimIdentifier;
	let keyCtx: SignedTokenContext;

	const validOptions = {
		metadataUri: METADATA_URI,
		subjectClaim: 'sub',
		validation: 'oauth2-jwt-claim' as const,
		audience: AUDIENCE,
	};

	beforeAll(async () => {
		keyCtx = await createKeyContext();
	});

	beforeEach(() => {
		jest.clearAllMocks();
		identifier = new OAuth2JwtClaimIdentifier(logger, cache);
		cache.get.mockResolvedValue(undefined);
		cache.set.mockResolvedValue();
	});

	const mockMetadataAndJwksResponses = () => {
		mockedAxios.get
			.mockResolvedValueOnce({ status: 200, data: validMetadata })
			.mockResolvedValueOnce({ status: 200, data: { keys: [keyCtx.publicJwk] } });
	};

	describe('Happy Path', () => {
		test('should resolve subject from verified JWT', async () => {
			const token = await signToken(keyCtx, { sub: 'avi-subject-1' });
			mockMetadataAndJwksResponses();

			const result = await identifier.resolve(
				{ identity: token, version: 1 as const },
				validOptions,
			);

			expect(result).toBe('avi-subject-1');
			expect(cache.set).toHaveBeenCalledWith(
				expect.stringContaining('oauth2-jwt-claim-identifier:subject'),
				'avi-subject-1',
				expect.any(Number),
			);
		});

		test('should return cached subject on subsequent calls', async () => {
			const token = await signToken(keyCtx, { sub: 'avi-subject-cached' });
			cache.get
				.mockResolvedValueOnce(undefined) // metadata miss
				.mockResolvedValueOnce('cached-subject');
			mockedAxios.get.mockResolvedValueOnce({ status: 200, data: validMetadata });

			const result = await identifier.resolve(
				{ identity: token, version: 1 as const },
				validOptions,
			);

			expect(result).toBe('cached-subject');
			expect(mockedAxios.get).toHaveBeenCalledTimes(1);
		});

		test('should support custom subject claim (e.g. oid)', async () => {
			const token = await signToken(keyCtx, {
				sub: 'opaque-sub',
				oid: '72a10869-9fb2-4717-bea9-14f326d6a060',
			});
			mockMetadataAndJwksResponses();

			const result = await identifier.resolve(
				{ identity: token, version: 1 as const },
				{ ...validOptions, subjectClaim: 'oid' },
			);

			expect(result).toBe('72a10869-9fb2-4717-bea9-14f326d6a060');
		});

		test('should isolate cache entries per audience', async () => {
			const token = await signToken(keyCtx, { sub: 's-shared' });
			mockMetadataAndJwksResponses();

			await identifier.resolve({ identity: token, version: 1 as const }, validOptions);

			const subjectCacheCall = cache.set.mock.calls.find((call) => call[0].includes(':subject:'));
			expect(subjectCacheCall![0]).toContain(`:${AUDIENCE}:`);
		});
	});

	describe('Validation', () => {
		test('validateOptions succeeds when metadata has jwks_uri', async () => {
			mockedAxios.get.mockResolvedValueOnce({ status: 200, data: validMetadata });
			await expect(identifier.validateOptions(validOptions)).resolves.toBeUndefined();
		});

		test('validateOptions rejects when audience is missing', async () => {
			await expect(
				identifier.validateOptions({ ...validOptions, audience: undefined }),
			).rejects.toThrow(IdentifierValidationError);
		});

		test('validateOptions rejects when audience is empty', async () => {
			await expect(
				identifier.validateOptions({ ...validOptions, audience: '   ' }),
			).rejects.toThrow(IdentifierValidationError);
		});

		test('validateOptions rejects when metadata document lacks jwks_uri', async () => {
			mockedAxios.get.mockResolvedValueOnce({
				status: 200,
				data: { issuer: ISSUER },
			});
			await expect(identifier.validateOptions(validOptions)).rejects.toThrow(
				'Invalid OAuth2 metadata format',
			);
		});

		test('validateOptions rejects when metadata URL is unreachable', async () => {
			mockedAxios.get.mockRejectedValue(new Error('connect ECONNREFUSED'));
			const error = await identifier.validateOptions(validOptions).catch((e) => e);
			expect(error).toBeInstanceOf(IdentifierValidationError);
			expect(error.message).toContain('Could not reach metadata URL');
		});
	});

	describe('Critical Errors', () => {
		test('rejects an expired token with token_expired reason', async () => {
			const token = await signToken(keyCtx, { expSecondsFromNow: -10 });
			mockMetadataAndJwksResponses();

			await expect(
				identifier.resolve({ identity: token, version: 1 as const }, validOptions),
			).rejects.toThrow(/token_expired/);
		});

		test('rejects a token whose audience does not match the configured audience', async () => {
			const token = await signToken(keyCtx, { audience: 'some-other-app-id' });
			mockMetadataAndJwksResponses();

			await expect(
				identifier.resolve({ identity: token, version: 1 as const }, validOptions),
			).rejects.toThrow(/claim_mismatch:aud/);
		});

		test('rejects a token whose issuer does not match the discovered issuer', async () => {
			const token = await signToken(keyCtx, { issuer: 'https://attacker.example/v2.0' });
			mockMetadataAndJwksResponses();

			await expect(
				identifier.resolve({ identity: token, version: 1 as const }, validOptions),
			).rejects.toThrow(/claim_mismatch:iss/);
		});

		test('rejects a token signed with a key whose kid is not in the JWKS', async () => {
			const otherKey = await createKeyContext('rotated-kid');
			const token = await signToken(otherKey);
			mockedAxios.get
				.mockResolvedValueOnce({ status: 200, data: validMetadata })
				.mockResolvedValueOnce({ status: 200, data: { keys: [keyCtx.publicJwk] } });

			await expect(
				identifier.resolve({ identity: token, version: 1 as const }, validOptions),
			).rejects.toThrow(/unknown_kid/);
		});

		test('rejects a token whose signature was forged with a different key', async () => {
			const attackerKey = await createKeyContext(keyCtx.publicJwk.kid as string);
			const token = await signToken(attackerKey);
			mockMetadataAndJwksResponses();

			await expect(
				identifier.resolve({ identity: token, version: 1 as const }, validOptions),
			).rejects.toThrow(/bad_signature/);
		});

		test('rejects a malformed JWT', async () => {
			mockMetadataAndJwksResponses();
			await expect(
				identifier.resolve({ identity: 'not-a-jwt-at-all', version: 1 as const }, validOptions),
			).rejects.toThrow(/malformed_jwt/);
		});

		test('rejects a verified JWT that is missing the configured subject claim', async () => {
			const token = await signToken(keyCtx);
			mockMetadataAndJwksResponses();

			await expect(
				identifier.resolve(
					{ identity: token, version: 1 as const },
					{ ...validOptions, subjectClaim: 'oid' },
				),
			).rejects.toThrow(/JWT missing subject claim/);
		});

		test('rejects when the JWKS endpoint returns a non-200', async () => {
			const token = await signToken(keyCtx);
			mockedAxios.get
				.mockResolvedValueOnce({ status: 200, data: validMetadata })
				.mockResolvedValueOnce({ status: 503, data: 'service unavailable' });

			await expect(
				identifier.resolve({ identity: token, version: 1 as const }, validOptions),
			).rejects.toThrow('Failed to fetch JWKS, status code: 503');
		});

		test('rejects when the JWKS document is malformed', async () => {
			const token = await signToken(keyCtx);
			mockedAxios.get
				.mockResolvedValueOnce({ status: 200, data: validMetadata })
				.mockResolvedValueOnce({ status: 200, data: { not_keys: 'wrong' } });

			await expect(
				identifier.resolve({ identity: token, version: 1 as const }, validOptions),
			).rejects.toThrow('Invalid JWKS document format');
		});
	});

	describe('TTL Handling', () => {
		test('caps TTL at MAX_TOKEN_CACHE_TIMEOUT for long-lived tokens', async () => {
			const token = await signToken(keyCtx, { expSecondsFromNow: 7200 });
			mockMetadataAndJwksResponses();

			await identifier.resolve({ identity: token, version: 1 as const }, validOptions);

			const subjectCacheCall = cache.set.mock.calls.find((call) => call[0].includes(':subject:'));
			expect(subjectCacheCall![2]).toBe(5 * Time.minutes.toMilliseconds);
		});

		test('floors TTL at MIN_TOKEN_CACHE_TIMEOUT for soon-expiring tokens', async () => {
			const token = await signToken(keyCtx, { expSecondsFromNow: 5 });
			mockMetadataAndJwksResponses();

			await identifier.resolve({ identity: token, version: 1 as const }, validOptions);

			const subjectCacheCall = cache.set.mock.calls.find((call) => call[0].includes(':subject:'));
			expect(subjectCacheCall![2]).toBe(30 * Time.seconds.toMilliseconds);
		});
	});
});

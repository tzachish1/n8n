// Fork §11 perf hardening (PE-1 + PE-2 + PE-3) — focused unit tests.
//
// Lives in a separate file from `dynamic-credential.service.test.ts` because
// that file uses `@/`-rooted imports which currently don't resolve in this
// monorepo's Jest setup (rootDir resolves to the workspace root, missing
// the cli package's local path-mapping). This file uses only relative
// imports so it runs against any rootDir.

import type { Logger } from '@n8n/backend-common';
import type { Cipher } from 'n8n-core';
import type {
	ICredentialContext,
	ICredentialDataDecryptedObject,
	IExecutionContext,
} from 'n8n-workflow';

import type {
	CredentialResolveMetadata,
	ICredentialResolutionProvider,
} from '../../../../credentials/credential-resolution-provider.interface';
import type { DynamicCredentialsProxy } from '../../../../credentials/dynamic-credentials-proxy';
import type { LoadNodesAndCredentials } from '../../../../load-nodes-and-credentials';
import type { CacheService } from '../../../../services/cache/cache.service';
import type { DynamicCredentialResolverRegistry } from '../credential-resolver-registry.service';
import type { DynamicCredentialResolverRepository } from '../../database/repositories/credential-resolver.repository';
import type { DynamicCredentialsConfig } from '../../dynamic-credentials.config';
import { DynamicCredentialService } from '../dynamic-credential.service';
import type { ResolverConfigExpressionService } from '../resolver-config-expression.service';

describe('DynamicCredentialService — fork §11 perf hardening', () => {
	const resolverId = 'resolver-1';
	const credentialId = 'cred-1';
	const credentialType = 'mondayComOAuth2Api';
	const credentialName = 'Monday account';

	let service: DynamicCredentialService;
	let mockResolverRepository: jest.Mocked<DynamicCredentialResolverRepository>;
	let mockResolverRegistry: jest.Mocked<DynamicCredentialResolverRegistry>;
	let mockCipher: jest.Mocked<Cipher>;
	let mockExpressionService: jest.Mocked<ResolverConfigExpressionService>;
	let mockLoadNodesAndCredentials: jest.Mocked<LoadNodesAndCredentials>;
	let mockLogger: jest.Mocked<Logger>;
	let mockCacheService: jest.Mocked<CacheService>;
	let mockDynamicCredentialsProxy: jest.Mocked<DynamicCredentialsProxy>;
	let cacheStore: Map<string, unknown>;

	const resolverEntityRow = {
		id: resolverId,
		type: 'oauth2',
		config: 'encrypted-config-blob',
	};

	const decryptedConfigJson = JSON.stringify({
		metadataUri: 'https://auth.monday.com/.well-known/openid-configuration',
		clientId: 'monday-client-id',
		clientSecret: 'monday-client-secret',
		validation: 'oauth2-userinfo',
		subjectClaim: 'sub',
	});

	const metadata: CredentialResolveMetadata = {
		id: credentialId,
		name: credentialName,
		type: credentialType,
		isResolvable: true,
		resolverId,
	};

	const staticData: ICredentialDataDecryptedObject = {};

	beforeEach(() => {
		cacheStore = new Map();

		mockCacheService = {
			get: jest.fn(async (key: string) => cacheStore.get(key)),
			set: jest.fn(async (key: string, value: unknown) => {
				cacheStore.set(key, value);
			}),
			delete: jest.fn(async (key: string) => {
				cacheStore.delete(key);
			}),
		} as unknown as jest.Mocked<CacheService>;

		mockResolverRepository = {
			findOneBy: jest.fn().mockResolvedValue(resolverEntityRow),
		} as unknown as jest.Mocked<DynamicCredentialResolverRepository>;

		mockCipher = {
			encryptV2: jest.fn(),
			decryptV2: jest.fn(async (input: string) => {
				if (input === 'encrypted-config-blob') return decryptedConfigJson;
				if (input === 'encrypted-credential-context') {
					return JSON.stringify({ version: 1, identity: 'user-jwt-token' });
				}
				return input;
			}),
		} as unknown as jest.Mocked<Cipher>;

		mockExpressionService = {
			resolve: jest.fn(async (config) => config),
		} as unknown as jest.Mocked<ResolverConfigExpressionService>;

		const mockResolverInstance = {
			getSecret: jest.fn(async () => ({ accessToken: 'resolved-token' })),
		};

		mockResolverRegistry = {
			getResolverByTypename: jest.fn().mockReturnValue(mockResolverInstance),
		} as unknown as jest.Mocked<DynamicCredentialResolverRegistry>;

		mockLoadNodesAndCredentials = {
			getCredential: jest.fn().mockReturnValue({
				type: { name: credentialType, properties: [] },
			}),
		} as unknown as jest.Mocked<LoadNodesAndCredentials>;

		mockLogger = {
			debug: jest.fn(),
			info: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
			scoped: jest.fn().mockReturnThis(),
		} as unknown as jest.Mocked<Logger>;

		const mockDynamicCredentialConfig = {
			endpointAuthToken: 'unused',
		} as unknown as jest.Mocked<DynamicCredentialsConfig>;

		mockDynamicCredentialsProxy = {
			getSystemResolverId: jest.fn().mockReturnValue(null),
			getEffectiveResolverId: jest.fn((settings) => settings?.credentialResolverId ?? null),
		} as unknown as jest.Mocked<DynamicCredentialsProxy>;

		service = new DynamicCredentialService(
			mockDynamicCredentialConfig,
			mockResolverRegistry,
			mockResolverRepository,
			mockLoadNodesAndCredentials,
			mockCipher,
			mockLogger,
			mockExpressionService,
			mockDynamicCredentialsProxy,
			mockCacheService,
			{ findOne: jest.fn().mockResolvedValue(null) } as never,
			{ getCredentialData: jest.fn().mockResolvedValue(null) } as never,
		);
	});

	const buildExecutionContext = (): IExecutionContext => ({
		version: 1,
		establishedAt: Date.now(),
		source: 'webhook',
		credentials: 'encrypted-credential-context',
	});

	describe('PE-1 + PE-2 — resolver entity + decrypted config cache', () => {
		it('queries DB + decrypts config exactly once across 5 consecutive resolutions', async () => {
			const provider: ICredentialResolutionProvider = service;
			const executionContext = buildExecutionContext();

			for (let i = 0; i < 5; i++) {
				await provider.resolveIfNeeded(metadata, staticData, executionContext);
			}

			expect(mockResolverRepository.findOneBy).toHaveBeenCalledTimes(1);
			// The config blob is decrypted exactly once. The credential context
			// is also decrypted (separately) — see PE-3 test for that count.
			const configDecryptCalls = mockCipher.decryptV2.mock.calls.filter(
				([arg]) => arg === 'encrypted-config-blob',
			);
			expect(configDecryptCalls).toHaveLength(1);
		});

		it('re-fetches from DB after explicit invalidation', async () => {
			const provider: ICredentialResolutionProvider = service;
			const executionContext = buildExecutionContext();

			await provider.resolveIfNeeded(metadata, staticData, executionContext);
			expect(mockResolverRepository.findOneBy).toHaveBeenCalledTimes(1);

			await service.invalidateResolverEntityCache(resolverId);

			await provider.resolveIfNeeded(metadata, staticData, buildExecutionContext());
			expect(mockResolverRepository.findOneBy).toHaveBeenCalledTimes(2);
			expect(mockCacheService.delete).toHaveBeenCalledWith(expect.stringContaining(resolverId));
		});

		it('caches separately per resolver id', async () => {
			const provider: ICredentialResolutionProvider = service;
			const secondResolverId = 'resolver-2';
			const secondResolverEntityRow = {
				id: secondResolverId,
				type: 'oauth2',
				config: 'encrypted-config-blob',
			};
			mockResolverRepository.findOneBy.mockImplementation(async (where) => {
				const w = where as { id: string };
				if (w.id === resolverId) return resolverEntityRow as never;
				if (w.id === secondResolverId) return secondResolverEntityRow as never;
				return null as never;
			});

			await provider.resolveIfNeeded(metadata, staticData, buildExecutionContext());
			await provider.resolveIfNeeded(
				{ ...metadata, resolverId: secondResolverId },
				staticData,
				buildExecutionContext(),
			);

			expect(mockResolverRepository.findOneBy).toHaveBeenCalledTimes(2);

			// Second call to each resolver: cache hit, no extra DB call.
			await provider.resolveIfNeeded(metadata, staticData, buildExecutionContext());
			await provider.resolveIfNeeded(
				{ ...metadata, resolverId: secondResolverId },
				staticData,
				buildExecutionContext(),
			);
			expect(mockResolverRepository.findOneBy).toHaveBeenCalledTimes(2);
		});

		it('returns resolver-not-found error and does NOT populate cache when DB row is absent', async () => {
			mockResolverRepository.findOneBy.mockResolvedValue(null);
			const provider: ICredentialResolutionProvider = service;

			await expect(
				provider.resolveIfNeeded(metadata, staticData, buildExecutionContext()),
			).rejects.toThrow(/not found/i);
			await expect(
				provider.resolveIfNeeded(metadata, staticData, buildExecutionContext()),
			).rejects.toThrow(/not found/i);

			// Each call re-queries (no negative cache entry) — operators expect
			// add-then-retry to take effect immediately.
			expect(mockResolverRepository.findOneBy).toHaveBeenCalledTimes(2);
			expect(mockCacheService.set).not.toHaveBeenCalled();
		});
	});

	describe('PE-3 — per-execution credential context memoization', () => {
		it('decrypts executionContext.credentials exactly once across many credential resolutions in the same execution', async () => {
			const provider: ICredentialResolutionProvider = service;
			// One shared execution context simulates a single execution that
			// resolves many credentials (e.g. a workflow with 10 nodes each
			// referencing the same Monday credential).
			const executionContext = buildExecutionContext();

			for (let i = 0; i < 10; i++) {
				await provider.resolveIfNeeded(metadata, staticData, executionContext);
			}

			const ctxDecryptCalls = mockCipher.decryptV2.mock.calls.filter(
				([arg]) => arg === 'encrypted-credential-context',
			);
			expect(ctxDecryptCalls).toHaveLength(1);
		});

		it('memoization is per-execution: a different executionContext object triggers another decrypt', async () => {
			const provider: ICredentialResolutionProvider = service;

			await provider.resolveIfNeeded(metadata, staticData, buildExecutionContext());
			await provider.resolveIfNeeded(metadata, staticData, buildExecutionContext());

			const ctxDecryptCalls = mockCipher.decryptV2.mock.calls.filter(
				([arg]) => arg === 'encrypted-credential-context',
			);
			expect(ctxDecryptCalls).toHaveLength(2);
		});

		it('does NOT memoize when executionContext is undefined or lacks credentials', async () => {
			const provider: ICredentialResolutionProvider = service;

			await expect(provider.resolveIfNeeded(metadata, staticData, undefined)).rejects.toThrow(
				/execution context/i,
			);
			const ctxWithoutCreds: IExecutionContext = {
				version: 1,
				establishedAt: Date.now(),
				source: 'webhook',
			};
			await expect(provider.resolveIfNeeded(metadata, staticData, ctxWithoutCreds)).rejects.toThrow(
				/execution context/i,
			);

			// Both calls fall through to the "missing context" path; no decrypt.
			const ctxDecryptCalls = mockCipher.decryptV2.mock.calls.filter(
				([arg]) => arg === 'encrypted-credential-context',
			);
			expect(ctxDecryptCalls).toHaveLength(0);
		});

		it('memoized value is non-enumerable (does NOT leak into JSON.stringify)', async () => {
			const provider: ICredentialResolutionProvider = service;
			const executionContext = buildExecutionContext();

			await provider.resolveIfNeeded(metadata, staticData, executionContext);

			// Memoized via a Symbol-keyed property declared non-enumerable;
			// JSON.stringify must omit it so the execution context stays a
			// clean serializable record (used for queue mode, persistence).
			const serialized = JSON.stringify(executionContext);
			expect(serialized).not.toContain('user-jwt-token');
			expect(Object.keys(executionContext)).toEqual([
				'version',
				'establishedAt',
				'source',
				'credentials',
			]);
		});
	});

	// Smoke-style assertion that ICredentialContext is the actual returned
	// shape — guards against accidental regression of the memoization helper.
	it('memoized context matches the one passed to resolver.getSecret on subsequent calls', async () => {
		const provider: ICredentialResolutionProvider = service;
		const executionContext = buildExecutionContext();

		await provider.resolveIfNeeded(metadata, staticData, executionContext);
		await provider.resolveIfNeeded(metadata, staticData, executionContext);

		const resolverInstance = mockResolverRegistry.getResolverByTypename('oauth2') as unknown as {
			getSecret: jest.Mock;
		};

		const [firstCallArgs, secondCallArgs] = resolverInstance.getSecret.mock.calls;
		const firstContext = firstCallArgs[1] as ICredentialContext;
		const secondContext = secondCallArgs[1] as ICredentialContext;
		expect(firstContext).toBe(secondContext);
	});
});

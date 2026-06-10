import { Logger } from '@n8n/backend-common';
import { AuthIdentityRepository } from '@n8n/db';
import { CredentialResolverDataNotFoundError, CredentialResolverError } from '@n8n/decorators';
import { Service } from '@n8n/di';
import type { NextFunction, Response } from 'express';
import { Cipher } from 'n8n-core';
import type {
	ICredentialContext,
	ICredentialDataDecryptedObject,
	IExecutionContext,
	IWorkflowSettings,
} from 'n8n-workflow';
import { jsonParse, toCredentialContext } from 'n8n-workflow';

import { DynamicCredentialsProxy } from '@/credentials/dynamic-credentials-proxy';
import type { ILazySeedProvider } from '@/credentials/lazy-seed-provider.interface';
import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
import { CacheService } from '@/services/cache/cache.service';
import { StaticAuthService } from '@/services/static-auth-service';

import { DynamicCredentialResolverRegistry } from './credential-resolver-registry.service';
import { ResolverConfigExpressionService } from './resolver-config-expression.service';
import { extractSharedFields } from './shared-fields';
import { fingerprintIdentity } from '../utils/identity-fingerprint';
import type {
	CredentialResolutionResult,
	CredentialResolveMetadata,
	ICredentialResolutionProvider,
} from '../../../credentials/credential-resolution-provider.interface';
import { SYSTEM_RESOLVER_ID, SYSTEM_RESOLVER_TYPE } from '../constants';
import { DynamicCredentialResolverRepository } from '../database/repositories/credential-resolver.repository';
import { DynamicCredentialUserEntryStorage } from '../credential-resolvers/storage/dynamic-credential-user-entry-storage';
import { DynamicCredentialsConfig } from '../dynamic-credentials.config';
import { CredentialResolutionError } from '../errors/credential-resolution.error';
import { CredentialResolverNotConfiguredError } from '../errors/credential-resolver-not-configured.error';
import { CredentialResolverNotFoundError } from '../errors/credential-resolver-not-found.error';
import { MissingExecutionContextError } from '../errors/missing-execution-context.error';
import { AuthenticatedRequest } from '@n8n/db';

/**
 * Fork §11 perf hardening (PE-1 + PE-2):
 *  - Cache the loaded `resolverEntity` AND its decrypted+parsed config
 *    together, keyed by resolver id.
 *  - TTL is short (60s) so admin updates take effect quickly without
 *    requiring explicit invalidation, but explicit invalidation hooks in
 *    `DynamicCredentialResolverService.update/delete` make the common case
 *    (admin edited a resolver in the UI) immediate.
 *  - Cached value omits anything user-scoped — purely the resolver's own
 *    config — so a single cached entry safely serves all callers.
 */
const RESOLVER_ENTITY_CACHE_TTL_MS = 60_000;
const RESOLVER_ENTITY_CACHE_PREFIX = 'dynamic-credentials:resolver-entity:';

interface CachedResolverEntity {
	entity: { id: string; type: string };
	parsedConfig: Record<string, unknown>;
}

/**
 * Fork §11 perf hardening (PE-3): non-enumerable Symbol used to memoize
 * the decrypted credential context on the `executionContext` object itself.
 * Per-execution scope; never shared across executions, never written to
 * any global cache. Safe because `executionContext.credentials` is
 * immutable for the lifetime of a single execution.
 */
const MEMOIZED_CREDENTIAL_CONTEXT = Symbol.for('n8n.dynamicCredentials.memoizedCredentialContext');

/**
 * Service for resolving credentials dynamically via configured resolvers.
 * Acts as a proxy between CredentialsHelper and the dynamic credentials module.
 */
@Service()
export class DynamicCredentialService implements ICredentialResolutionProvider {
	/**
	 * Fork §10 Phase 2 — optional webhook lazy-seed seam. Registered by the
	 * `sso-oidc` module bootstrap when the lazy-seed feature is wired in. Stays
	 * `undefined` for upstream-compatible deployments; in that case the
	 * `CredentialResolverDataNotFoundError` path is byte-identical to upstream.
	 */
	private lazySeedProvider?: ILazySeedProvider;

	constructor(
		private readonly dynamicCredentialConfig: DynamicCredentialsConfig,
		private readonly resolverRegistry: DynamicCredentialResolverRegistry,
		private readonly resolverRepository: DynamicCredentialResolverRepository,
		private readonly loadNodesAndCredentials: LoadNodesAndCredentials,
		private readonly cipher: Cipher,
		private readonly logger: Logger,
		private readonly expressionService: ResolverConfigExpressionService,
		private readonly dynamicCredentialsProxy: DynamicCredentialsProxy,
		private readonly cacheService: CacheService,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly userEntryStorage: DynamicCredentialUserEntryStorage,
	) {}

	/**
	 * Fork §11 perf hardening (PE-1 + PE-2). Loads `resolverEntity` and its
	 * decrypted+parsed config, caching the pair so repeated executions for
	 * the same resolver skip a DB round-trip and a cipher decrypt+jsonParse.
	 * Returns `null` when the row is absent — caller emits the usual
	 * not-found error. Cache holds only resolver-owned config (no user data),
	 * so a single entry is safely shared across all callers.
	 */
	private async loadResolverEntityCached(resolverId: string): Promise<CachedResolverEntity | null> {
		const cacheKey = `${RESOLVER_ENTITY_CACHE_PREFIX}${resolverId}`;

		const cached = await this.cacheService.get<CachedResolverEntity>(cacheKey);
		if (cached) return cached;

		const entity = await this.resolverRepository.findOneBy({ id: resolverId });
		if (!entity) return null;

		const decryptedConfig = await this.cipher.decryptV2(entity.config);
		const parsedConfig = jsonParse<Record<string, unknown>>(decryptedConfig);

		const value: CachedResolverEntity = {
			entity: { id: entity.id, type: entity.type },
			parsedConfig,
		};

		await this.cacheService.set(cacheKey, value, RESOLVER_ENTITY_CACHE_TTL_MS);
		return value;
	}

	/**
	 * Fork §11 — explicit invalidation hook called by
	 * `DynamicCredentialResolverService.update/delete` so admin edits in the
	 * UI take effect immediately, not after the 60s TTL fallback.
	 */
	async invalidateResolverEntityCache(resolverId: string): Promise<void> {
		await this.cacheService.delete(`${RESOLVER_ENTITY_CACHE_PREFIX}${resolverId}`);
	}

	/**
	 * Fork §10 Phase 2 — register (or clear) the webhook lazy-seed provider.
	 * Idempotent; calling with the same instance twice is a no-op.
	 */
	setLazySeedProvider(provider: ILazySeedProvider | undefined) {
		this.lazySeedProvider = provider;
	}

	/**
	 * Resolves credentials dynamically if configured, otherwise returns static data.
	 * Handles fallback logic based on credential configuration.
	 *
	 * @param credentialsResolveMetadata The credential resolve metadata
	 * @param staticData The decrypted static credential data
	 * @param additionalData Additional workflow execution data for context and settings
	 * @returns Resolved credential data (either dynamic or static)
	 * @throws {CredentialResolutionError} If resolution fails and fallback is not allowed
	 */
	async resolveIfNeeded(
		credentialsResolveMetadata: CredentialResolveMetadata,
		staticData: ICredentialDataDecryptedObject,
		executionContext?: IExecutionContext,
		workflowSettings?: IWorkflowSettings,
	): Promise<CredentialResolutionResult> {
		// Not resolvable - return static credentials
		if (!credentialsResolveMetadata.isResolvable) {
			return { data: staticData, isDynamic: false };
		}

		const credentialContext = await this.buildCredentialContext(executionContext);

		if (!credentialContext) {
			return this.handleMissingContext(credentialsResolveMetadata);
		}

		// Determine which resolver ID to use: credential's own resolver or workflow's fallback
		// (explicit workflow override, or the seeded system resolver looked up via the proxy).
		// Editor/manual runs (Connect, load options, manual trigger) store tokens under the
		// system n8n resolver — even when the credential also has a custom resolver for
		// webhook/inbound-identity flows.
		let resolverId =
			credentialsResolveMetadata.resolverId ??
			this.dynamicCredentialsProxy.getEffectiveResolverId(workflowSettings);

		if (credentialContext.metadata?.source === 'manual-execution') {
			resolverId = SYSTEM_RESOLVER_ID;
		}

		if (!resolverId) {
			return this.handleResolverNotConfigured(credentialsResolveMetadata);
		}

		// Fork §11 perf (PE-1 + PE-2): load resolver entity + decrypted config
		// from cache so repeated executions for the same resolver skip the
		// DB round-trip and the cipher decrypt + JSON parse.
		const cachedResolver = await this.loadResolverEntityCached(resolverId);
		if (!cachedResolver) {
			return this.handleResolverNotFound(credentialsResolveMetadata, resolverId);
		}

		const resolverEntity = cachedResolver.entity;
		const parsedConfig = cachedResolver.parsedConfig;

		// Get resolver instance from registry
		const resolver = this.resolverRegistry.getResolverByTypename(resolverEntity.type);

		if (!resolver) {
			return this.handleResolverNotFound(credentialsResolveMetadata, resolverId);
		}

		try {
			const credentialType = this.loadNodesAndCredentials.getCredential(
				credentialsResolveMetadata.type,
			);

			const sharedFields = extractSharedFields(credentialType.type);

			// Resolve expressions in resolver configuration using global data only.
			// Re-run on every call (cheap pure-function eval) because expressions
			// may reference values that change at runtime (env vars, etc.); the
			// expensive part (DB + decrypt + parse) is cached above.
			const resolverConfig = await this.expressionService.resolve(parsedConfig);

			// Attempt dynamic resolution. Fork §10 Phase 2: on first miss for a
			// resolvable credential, optionally invoke the registered lazy-seed
			// provider once and retry the resolver call. Upstream-compatible when
			// `lazySeedProvider` is unset — the catch block re-throws the original
			// `CredentialResolverDataNotFoundError`, mirroring pre-fork behavior.
			const dynamicData = await this.invokeResolverWithLazySeed({
				resolver,
				credentialContext,
				credentialsResolveMetadata,
				resolverEntity,
				resolverConfig,
			});

			this.logger.debug('Successfully resolved dynamic credentials', {
				credentialId: credentialsResolveMetadata.id,
				resolverId,
				resolverSource: credentialsResolveMetadata.resolverId ? 'credential' : 'workflow',
				identityFingerprint: fingerprintIdentity(credentialContext.identity),
			});

			// Remove shared fields from dynamic data to avoid conflicts
			for (const field of sharedFields) {
				if (field in dynamicData) {
					delete dynamicData[field];
				}
			}

			// Capture the n8n user the credentials resolved to (only resolvers
			// keyed on n8n identities implement this). Best-effort: a failure to
			// resolve the owning user must not fail credential resolution — the
			// execution simply stays unattributed (redacted for everyone).
			let resolvedUserId: string | undefined;
			try {
				resolvedUserId = await resolver.resolveOwningUserId?.(credentialContext, handle);
			} catch (error) {
				this.logger.debug('Could not resolve owning user for dynamic credentials', {
					credentialId: credentialsResolveMetadata.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Adds and override static data with dynamically resolved data
			return { data: { ...staticData, ...dynamicData }, isDynamic: true, resolvedUserId };
		} catch (error) {
			return this.handleResolutionError(
				credentialsResolveMetadata,
				error,
				resolverEntity.id,
				resolverEntity.type,
			);
		}
	}

	getSystemResolverId(): string {
		return SYSTEM_RESOLVER_ID;
	}

	/**
	 * Fork §10 Phase 2 — wraps the resolver's `getSecret` with at most one
	 * lazy-seed retry on `CredentialResolverDataNotFoundError`. Behavior:
	 *
	 *  1. Call `resolver.getSecret(...)`. If it returns, return its result.
	 *  2. If it throws a different error, propagate immediately.
	 *  3. On `CredentialResolverDataNotFoundError`, if a lazy-seed provider is
	 *     registered, enabled, and considers this request a candidate, invoke
	 *     `tryLazySeed(...)` once. On `{ seeded: true }`, retry `getSecret`
	 *     exactly once and return its result (any error on retry propagates).
	 *  4. Any other path re-throws the original miss.
	 *
	 * The retry is bounded so a malformed provider cannot loop the resolver
	 * indefinitely. When no provider is registered the upstream miss flow is
	 * preserved byte-for-byte.
	 */
	private async invokeResolverWithLazySeed(args: {
		// Loose typing on `resolver` matches the existing `getSecret` call site —
		// the registry returns an instance whose static types are intentionally
		// minimal so EE resolvers stay loosely coupled.
		resolver: { getSecret: (...args: unknown[]) => Promise<ICredentialDataDecryptedObject> };
		credentialContext: ICredentialContext;
		credentialsResolveMetadata: CredentialResolveMetadata;
		resolverEntity: { id: string; type: string };
		resolverConfig: Record<string, unknown>;
	}): Promise<ICredentialDataDecryptedObject> {
		const {
			resolver,
			credentialContext,
			credentialsResolveMetadata,
			resolverEntity,
			resolverConfig,
		} = args;

		const invoke = async () =>
			await resolver.getSecret(credentialsResolveMetadata.id, credentialContext, {
				resolverId: resolverEntity.id,
				resolverName: resolverEntity.type,
				configuration: resolverConfig,
			});

		try {
			return await invoke();
		} catch (error) {
			if (!(error instanceof CredentialResolverDataNotFoundError)) throw error;

			const request = {
				context: credentialContext,
				credentialsResolveMetadata,
				resolverId: resolverEntity.id,
			};

			const provider = this.lazySeedProvider;
			if (provider?.isEnabled() && provider.isCandidate(request)) {
				let seedResult;
				try {
					seedResult = await provider.tryLazySeed(request);
				} catch (seedError) {
					// Provider violated its contract (must never throw). Treat as a
					// failed seed and surface the original miss to the caller.
					this.logger.warn('Lazy-seed provider threw — surfacing original resolver miss', {
						credentialId: credentialsResolveMetadata.id,
						resolverId: resolverEntity.id,
						error: seedError instanceof Error ? seedError.message : String(seedError),
					});
					seedResult = { seeded: false as const, reason: 'lazy_seed_obo_failed' as const };
				}

				if (seedResult.seeded) {
					this.logger.debug('Lazy-seed succeeded; retrying resolver once', {
						credentialId: credentialsResolveMetadata.id,
						resolverId: resolverEntity.id,
					});
					return await invoke();
				}
			}

			const connectFallback = await this.tryConnectUserEntryFallback(
				credentialsResolveMetadata,
				credentialContext,
				resolverEntity.id,
			);
			if (connectFallback) {
				return connectFallback;
			}

			throw error;
		}
	}

	/**
	 * When a webhook/inbound-identity resolver misses but the caller already
	 * connected via the editor (system-n8n user entry), bridge Entra `sub` →
	 * n8n user → per-user Connect storage.
	 */
	private async tryConnectUserEntryFallback(
		credentialsResolveMetadata: CredentialResolveMetadata,
		credentialContext: ICredentialContext,
		attemptedResolverId: string,
	): Promise<ICredentialDataDecryptedObject | null> {
		if (
			!credentialsResolveMetadata.resolverId ||
			attemptedResolverId === SYSTEM_RESOLVER_ID ||
			credentialContext.metadata?.source === 'manual-execution'
		) {
			return null;
		}

		if (typeof credentialContext.identity !== 'string') {
			return null;
		}

		const claims = this.decodeJwtPayloadUnsafe(credentialContext.identity);
		const subject = claims?.sub ?? claims?.oid;
		if (!subject) {
			return null;
		}

		const identity = await this.authIdentityRepository.findOne({
			where: { providerId: subject, providerType: 'oidc' },
		});
		if (!identity) {
			return null;
		}

		const encrypted = await this.userEntryStorage.getCredentialData(
			credentialsResolveMetadata.id,
			identity.userId,
			SYSTEM_RESOLVER_ID,
			{},
		);
		if (!encrypted) {
			return null;
		}

		try {
			const plaintext = await this.cipher.decryptV2(encrypted);
			const data = jsonParse<ICredentialDataDecryptedObject>(plaintext);
			this.logger.debug('Resolved credential via Connect user-entry fallback', {
				credentialId: credentialsResolveMetadata.id,
				userId: identity.userId,
				subject,
				primaryResolverId: attemptedResolverId,
			});
			return data;
		} catch (error) {
			this.logger.warn('Connect user-entry fallback data could not be decrypted', {
				credentialId: credentialsResolveMetadata.id,
				userId: identity.userId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	private decodeJwtPayloadUnsafe(token: string): { sub?: string; oid?: string } | undefined {
		const parts = token.split('.');
		if (parts.length !== 3) return undefined;

		try {
			const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
			const parsed: unknown = JSON.parse(payload);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as { sub?: string; oid?: string };
			}
		} catch {
			return undefined;
		}

		return undefined;
	}

	/**
	 * Builds credential context from execution context by decrypting the credentials field.
	 *
	 * Fork §11 perf (PE-3): The result is memoized on the `executionContext`
	 * object itself via a Symbol key. Per-execution scope only (no global
	 * cache), so a single execution that invokes many nodes/credentials only
	 * decrypts once. Safe because `executionContext.credentials` is immutable
	 * for the lifetime of a single execution.
	 */
	private async buildCredentialContext(executionContext: IExecutionContext | undefined) {
		if (!executionContext?.credentials) {
			return undefined;
		}

		const ctxAsAny = executionContext as unknown as Record<symbol, ICredentialContext | undefined>;
		const memoized = ctxAsAny[MEMOIZED_CREDENTIAL_CONTEXT];
		if (memoized !== undefined) return memoized;

		try {
			const decrypted = await this.cipher.decryptV2(executionContext.credentials);
			const result = toCredentialContext(decrypted);

			Object.defineProperty(executionContext, MEMOIZED_CREDENTIAL_CONTEXT, {
				value: result,
				enumerable: false,
				configurable: false,
				writable: false,
			});

			return result;
		} catch (error) {
			this.logger.error('Failed to decrypt credential context from execution context', {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Throws when resolution fails inside getSecret().
	 * - CredentialResolverDataNotFoundError from the n8n private-credential resolver
	 *   → user-facing "you haven't connected" message. This resolver maps the
	 *     credential context to an n8n user identity, so a missing row means the
	 *     current user simply hasn't connected the credential yet — actionable
	 *     regardless of how the run was triggered (editor, chat-hub, etc.).
	 * - CredentialResolutionError subtypes (e.g. IdentifierValidationError)
	 *   → rethrown with credential name prepended to the message
	 * - CredentialResolverDataNotFoundError from external-identity resolvers
	 *   (e.g. Slack) → rethrown with credential name prepended (generic message,
	 *   since the missing connection isn't tied to the n8n user).
	 * - Anything else → generic CredentialResolutionError (no internal detail surfaced)
	 */
	private handleResolutionError(
		credentialsResolveMetadata: CredentialResolveMetadata,
		error: unknown,
		resolverId: string,
		resolverType: string,
	): never {
		this.logger.debug('Dynamic credential resolution failed', {
			credentialId: credentialsResolveMetadata.id,
			credentialName: credentialsResolveMetadata.name,
			resolverId,
			resolverSource: credentialsResolveMetadata.resolverId ? 'credential' : 'workflow',
			error: error instanceof Error ? error.message : String(error),
		});

		if (
			error instanceof CredentialResolverDataNotFoundError &&
			resolverType === SYSTEM_RESOLVER_TYPE
		) {
			// TODO(M14): emit `private_credential.resolution_failed_missing_connection`
			// via EventService once the relay event is defined in RelayEventMap.
			throw new CredentialResolutionError(
				`'${credentialsResolveMetadata.name}' private credential is not connected for you. Connect yours to execute this workflow manually.`,
				{ cause: error },
			);
		}

		// Known errors from both the CLI and resolver SDK layers.
		// User-facing, safe to propagate details.
		if (error instanceof CredentialResolutionError || error instanceof CredentialResolverError) {
			throw new CredentialResolutionError(
				`Failed to resolve dynamic credentials for "${credentialsResolveMetadata.name}": ${error.message}`,
				{ cause: error },
			);
		}

		// Internal errors (network, crypto, DB, config validation) must not leak details to the user.
		throw new CredentialResolutionError(
			`Failed to resolve dynamic credentials for "${credentialsResolveMetadata.name}"`,
			{ cause: error },
		);
	}

	/**
	 * Throws when the credential is resolvable but no resolver ID is configured
	 * on the credential or the workflow settings.
	 */
	private handleResolverNotConfigured(
		credentialsResolveMetadata: CredentialResolveMetadata,
	): never {
		this.logger.debug('No resolver configured for dynamic credential', {
			credentialId: credentialsResolveMetadata.id,
			credentialName: credentialsResolveMetadata.name,
		});

		throw new CredentialResolverNotConfiguredError(credentialsResolveMetadata.name);
	}

	/**
	 * Throws when a resolver ID is set but the entity no longer exists in the DB
	 * or the resolver type is not registered.
	 */
	private handleResolverNotFound(
		credentialsResolveMetadata: CredentialResolveMetadata,
		resolverId: string,
	): never {
		this.logger.debug('Resolver not found for dynamic credential', {
			credentialId: credentialsResolveMetadata.id,
			credentialName: credentialsResolveMetadata.name,
			resolverId,
			resolverSource: credentialsResolveMetadata.resolverId ? 'credential' : 'workflow',
		});

		throw new CredentialResolverNotFoundError(credentialsResolveMetadata.name, resolverId);
	}

	/**
	 * Throws when no execution context (or credentials field within it) is available.
	 */
	private handleMissingContext(credentialsResolveMetadata: CredentialResolveMetadata): never {
		this.logger.debug('No execution context available for dynamic credential', {
			credentialId: credentialsResolveMetadata.id,
			credentialName: credentialsResolveMetadata.name,
		});

		throw new MissingExecutionContextError(credentialsResolveMetadata.name);
	}

	/**
	 * Returns middleware for authenticating dynamic credentials endpoints.
	 * Uses static token from configuration.
	 */
	getDynamicCredentialsEndpointsMiddleware() {
		const { endpointAuthToken } = this.dynamicCredentialConfig;
		if (!endpointAuthToken?.trim()) {
			return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
				// If a user was authenticated for this request, we allow access irrelevant of the static authentication
				if (req.user) {
					return next();
				}
				this.logger.error(
					'Dynamic credentials external endpoints require an endpoint auth token. Please set the N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN environment variable to enable access.',
				);
				res.status(500).json({
					message: 'Dynamic credentials configuration is invalid. Check server logs for details.',
				});
				return;
			};
		}

		const staticAuthMiddlware = StaticAuthService.getStaticAuthMiddleware(
			endpointAuthToken,
			'x-authorization',
		)!;

		return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
			// If a user was authenticated for this request, we allow access irrelevant of the static authentication
			if (req.user) {
				return next();
			}
			return staticAuthMiddlware(req, res, next);
		};
	}
}

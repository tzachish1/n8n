import { Logger } from '@n8n/backend-common';
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

import type { ILazySeedProvider } from '@/credentials/lazy-seed-provider.interface';
import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
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
import { DynamicCredentialResolverRepository } from '../database/repositories/credential-resolver.repository';
import { DynamicCredentialsConfig } from '../dynamic-credentials.config';
import { CredentialResolutionError } from '../errors/credential-resolution.error';
import { CredentialResolverNotConfiguredError } from '../errors/credential-resolver-not-configured.error';
import { CredentialResolverNotFoundError } from '../errors/credential-resolver-not-found.error';
import { MissingExecutionContextError } from '../errors/missing-execution-context.error';
import { AuthenticatedRequest } from '@n8n/db';

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
	) {}

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
		// Determine which resolver ID to use: credential's own resolver or workflow's fallback
		const resolverId =
			credentialsResolveMetadata.resolverId ?? workflowSettings?.credentialResolverId;

		// Not resolvable - return static credentials
		if (!credentialsResolveMetadata.isResolvable) {
			return { data: staticData, isDynamic: false };
		}

		if (!resolverId) {
			return this.handleResolverNotConfigured(credentialsResolveMetadata);
		}

		// Load resolver configuration
		const resolverEntity = await this.resolverRepository.findOneBy({
			id: resolverId,
		});

		if (!resolverEntity) {
			return this.handleResolverNotFound(credentialsResolveMetadata, resolverId);
		}

		// Get resolver instance from registry
		const resolver = this.resolverRegistry.getResolverByTypename(resolverEntity.type);

		if (!resolver) {
			return this.handleResolverNotFound(credentialsResolveMetadata, resolverId);
		}

		// Build credential context from execution context
		const credentialContext = await this.buildCredentialContext(executionContext);

		if (!credentialContext) {
			return this.handleMissingContext(credentialsResolveMetadata);
		}

		try {
			const credentialType = this.loadNodesAndCredentials.getCredential(
				credentialsResolveMetadata.type,
			);

			const sharedFields = extractSharedFields(credentialType.type);

			// Decrypt and parse resolver configuration
			const decryptedConfig = await this.cipher.decryptV2(resolverEntity.config);
			const parsedConfig = jsonParse<Record<string, unknown>>(decryptedConfig);

			// Resolve expressions in resolver configuration using global data only
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

			// Adds and override static data with dynamically resolved data
			return { data: { ...staticData, ...dynamicData }, isDynamic: true };
		} catch (error) {
			return this.handleResolutionError(credentialsResolveMetadata, error, resolverId);
		}
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

			const provider = this.lazySeedProvider;
			if (!provider) throw error;

			const request = {
				context: credentialContext,
				credentialsResolveMetadata,
				resolverId: resolverEntity.id,
			};

			if (!provider.isEnabled() || !provider.isCandidate(request)) throw error;

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
				throw error;
			}

			if (!seedResult.seeded) throw error;

			this.logger.debug('Lazy-seed succeeded; retrying resolver once', {
				credentialId: credentialsResolveMetadata.id,
				resolverId: resolverEntity.id,
			});
			return await invoke();
		}
	}

	/**
	 * Builds credential context from execution context by decrypting the credentials field
	 */
	private async buildCredentialContext(executionContext: IExecutionContext | undefined) {
		if (!executionContext?.credentials) {
			return undefined;
		}

		try {
			// Decrypt credential context from execution context
			const decrypted = await this.cipher.decryptV2(executionContext.credentials);
			return toCredentialContext(decrypted);
		} catch (error) {
			this.logger.error('Failed to decrypt credential context from execution context', {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Throws when resolution fails inside getSecret().
	 * - CredentialResolutionError subtypes (e.g. IdentifierValidationError)
	 *   → rethrown with credential name prepended to the message
	 * - CredentialResolverDataNotFoundError → rethrown with credential name prepended to the message
	 * - Anything else → generic CredentialResolutionError (no internal detail surfaced)
	 */
	private handleResolutionError(
		credentialsResolveMetadata: CredentialResolveMetadata,
		error: unknown,
		resolverId: string,
	): never {
		this.logger.debug('Dynamic credential resolution failed', {
			credentialId: credentialsResolveMetadata.id,
			credentialName: credentialsResolveMetadata.name,
			resolverId,
			resolverSource: credentialsResolveMetadata.resolverId ? 'credential' : 'workflow',
			error: error instanceof Error ? error.message : String(error),
		});

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

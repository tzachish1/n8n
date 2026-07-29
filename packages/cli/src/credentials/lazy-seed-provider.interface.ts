import type { ICredentialContext } from 'n8n-workflow';

import type { CredentialResolveMetadata } from './credential-resolution-provider.interface';

/**
 * Reasons a lazy-seed attempt was skipped without performing an OBO exchange.
 *
 * `lazy_seed_disabled`             — `N8N_SSO_OIDC_GRAPH_LAZY_SEED_ENABLED=false`.
 * `lazy_seed_resolver_not_opted_in` — resolver is not in the opted-in set
 *                                     (no `oidcSeedSource='oidc'` and not in
 *                                     the deprecated env-var allowlist).
 * `lazy_seed_token_audience_mismatch` — bearer is opaque or its `aud` does not
 *                                       match the n8n App Registration.
 * `lazy_seed_token_issuer_mismatch` — bearer's `iss` does not match the
 *                                     configured Entra tenant.
 * `lazy_seed_negative_cache_hit`   — a previous attempt for the same
 *                                    `(subject, credentialId)` failed within
 *                                    the negative-cache TTL.
 * `lazy_seed_user_not_provisioned` — JIT user provisioning is disabled and no
 *                                    matching `auth_identity` row exists.
 */
export type LazySeedSkipReason =
	| 'lazy_seed_disabled'
	| 'lazy_seed_resolver_not_opted_in'
	| 'lazy_seed_token_audience_mismatch'
	| 'lazy_seed_token_issuer_mismatch'
	| 'lazy_seed_negative_cache_hit'
	| 'lazy_seed_user_not_provisioned';

export type LazySeedResult =
	| { seeded: true }
	| { seeded: false; reason: LazySeedSkipReason | 'lazy_seed_obo_failed' };

export type LazySeedRequest = {
	context: ICredentialContext;
	credentialsResolveMetadata: CredentialResolveMetadata;
	resolverId: string;
};

/**
 * Webhook lazy-seed seam consumed by `DynamicCredentialService` after a
 * resolver miss (`CredentialResolverDataNotFoundError`). Implementations
 * decide whether the inbound bearer + credential is a candidate for
 * server-side On-Behalf-Of seeding, perform any required JIT user
 * provisioning, and persist the resulting tokens through the same
 * `OauthService.saveDynamicCredential` path that the OIDC-login seed uses.
 *
 * The provider MUST never throw on failure — every outcome resolves to a
 * `LazySeedResult` so the caller can decide whether to retry resolution.
 */
export interface ILazySeedProvider {
	/** Cheap guard called before each potential lazy-seed attempt. */
	isEnabled(): boolean;

	/**
	 * Cheap pre-check that short-circuits when there is no plausible identity
	 * to seed from (e.g. no bearer in the execution context). Keeps the hot
	 * resolution path free of full lazy-seed logic when it cannot succeed.
	 */
	isCandidate(request: LazySeedRequest): boolean;

	/**
	 * Attempt a lazy seed. Returns `{ seeded: true }` if the caller can retry
	 * resolution with the freshly seeded credential, or a structured
	 * `{ seeded: false, reason }` otherwise.
	 *
	 * Implementations MUST be safe to call concurrently for the same subject:
	 * a singleflight wraps the OBO exchange + persist round-trip, and a
	 * short-lived negative cache avoids hammering the IdP on repeated misses.
	 */
	tryLazySeed(request: LazySeedRequest): Promise<LazySeedResult>;
}

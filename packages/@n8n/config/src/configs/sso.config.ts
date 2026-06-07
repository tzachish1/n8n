import { Config, Env, Nested } from '../decorators';

@Config
class SamlConfig {
	/** Whether SAML-based single sign-on is enabled. */
	@Env('N8N_SSO_SAML_LOGIN_ENABLED')
	loginEnabled: boolean = false;

	/** Label shown on the login button for SAML (for example, "Sign in with SAML"). */
	@Env('N8N_SSO_SAML_LOGIN_LABEL')
	loginLabel: string = '';
}

@Config
class OidcConfig {
	/** Whether OIDC-based single sign-on is enabled. */
	@Env('N8N_SSO_OIDC_LOGIN_ENABLED')
	loginEnabled: boolean = false;

	/**
	 * Space-separated `scope` parameter for the Microsoft On-Behalf-Of (OBO)
	 * exchange that runs after OIDC login when `graphAutoSeedEnabled` is true.
	 *
	 * Empty (the default) means n8n requests
	 * `https://graph.microsoft.com/.default`, which causes Entra to mint a Graph
	 * access token containing exactly the delegated Graph scopes that have
	 * already been admin-consented on the App Registration — no enumeration
	 * needed. `offline_access` is appended automatically.
	 *
	 * Only set this for least-privilege scenarios where the requested scope set
	 * must be narrower than admin consent (e.g.
	 * 'https://graph.microsoft.com/Mail.Read').
	 *
	 * NOTE: this scope is sent only on the server-side OBO POST. It is NOT
	 * appended to the user-facing OIDC authorization URL, so it cannot collide
	 * with the n8n provisioning scope (`N8N_SSO_SCOPES_NAME`).
	 */
	@Env('N8N_SSO_OIDC_GRAPH_SCOPES')
	graphScopes: string = '';

	/**
	 * Master switch for the OIDC Graph auto-seed extension. When false (default),
	 * OIDC login behaviour is byte-identical to upstream — no extra scopes requested,
	 * no seed attempt.
	 */
	@Env('N8N_SSO_OIDC_GRAPH_AUTO_SEED_ENABLED')
	graphAutoSeedEnabled: boolean = false;

	/**
	 * When true (default), seed failures log warn and do NOT block login. When false,
	 * a seed failure makes the OIDC login fail. Keep `true` in production so a transient
	 * resolver outage cannot lock users out of n8n.
	 */
	@Env('N8N_SSO_OIDC_GRAPH_SEED_FAIL_OPEN')
	graphSeedFailOpen: boolean = true;

	/**
	 * Fork §10 Phase 2 — master switch for the webhook lazy-seed path. When
	 * `false` (default), an inbound webhook request whose bearer matches a
	 * resolver subject that has no row yet returns the upstream
	 * `CredentialResolverDataNotFoundError`. When `true`, the resolver miss is
	 * caught, an OBO exchange is performed for the bearer, and the resulting
	 * Graph tokens are persisted before resolution is retried.
	 *
	 * Enabling this widens the seed surface from "OIDC login only" to "any
	 * webhook caller with a valid bearer for the n8n App Registration".
	 * Operators MUST review the audit-event log (`oidc-graph-token-lazy-*`)
	 * and the negative-cache TTL before exposing webhooks to broader
	 * audiences.
	 */
	@Env('N8N_SSO_OIDC_GRAPH_LAZY_SEED_ENABLED')
	graphLazySeedEnabled: boolean = false;

	/**
	 * Fork §10 Phase 2 — toggle for JIT user provisioning during a lazy-seed
	 * attempt. When `true` (default), a webhook caller whose bearer's `sub`
	 * does not match any existing `auth_identity` row triggers creation of a
	 * new n8n user + `auth_identity` (mirroring the OIDC-login JIT path).
	 * When `false`, the lazy-seed is skipped with reason
	 * `lazy_seed_user_not_provisioned` and the resolver miss bubbles back to
	 * the caller — useful for environments that pre-provision all users out
	 * of band.
	 */
	@Env('N8N_SSO_OIDC_GRAPH_LAZY_SEED_PROVISION_USER')
	graphLazySeedProvisionUser: boolean = true;

	/**
	 * Fork §10 Phase 2 — negative cache TTL (ms) for `(subject, credentialId)`
	 * pairs whose most recent lazy-seed attempt did not succeed. Subsequent
	 * webhook calls for the same pair short-circuit with reason
	 * `lazy_seed_negative_cache_hit` until the TTL expires, protecting Entra
	 * from a thundering herd when a misconfigured caller retries aggressively.
	 *
	 * Default 60_000 ms (1 minute). Operators may lower this for development
	 * environments; production should keep at least 30s.
	 */
	@Env('N8N_SSO_OIDC_GRAPH_LAZY_SEED_NEGATIVE_CACHE_TTL_MS')
	graphLazySeedNegativeCacheTtlMs: number = 60_000;
}

@Config
class LdapConfig {
	/** Whether LDAP-based single sign-on is enabled. */
	@Env('N8N_SSO_LDAP_LOGIN_ENABLED')
	loginEnabled: boolean = false;

	/** Label shown on the login button for LDAP (for example, "Sign in with LDAP"). */
	@Env('N8N_SSO_LDAP_LOGIN_LABEL')
	loginLabel: string = '';
}

@Config
class ProvisioningConfig {
	/** Whether to set the user's instance role from an SSO claim during login. */
	@Env('N8N_SSO_SCOPES_PROVISION_INSTANCE_ROLE')
	scopesProvisionInstanceRole: boolean = false;

	/** Whether to set project–role mappings from an SSO claim during login. */
	@Env('N8N_SSO_SCOPES_PROVISION_PROJECT_ROLES')
	scopesProvisionProjectRoles: boolean = false;

	/** Name of the OAuth scope to request for SSO provisioning. */
	@Env('N8N_SSO_SCOPES_NAME')
	scopesName: string = 'n8n';

	/**
	 * Name of the SSO claim that contains the user's instance role (for provisioning).
	 * Defaults to 'roles' to match Azure AD App Roles, Okta, and Auth0 out of the box.
	 * Override via env or in the DB row if your IdP uses a different claim name.
	 */
	@Env('N8N_SSO_SCOPES_INSTANCE_ROLE_CLAIM_NAME')
	scopesInstanceRoleClaimName: string = 'roles';

	/** Name of the SSO claim that contains project–role mappings (for provisioning). */
	@Env('N8N_SSO_SCOPES_PROJECTS_ROLES_CLAIM_NAME')
	scopesProjectsRolesClaimName: string = 'n8n_projects';

	/** Whether to use expression-based role mapping rules instead of direct SSO claim provisioning. */
	@Env('N8N_SSO_SCOPES_USE_EXPRESSION_MAPPING')
	scopesUseExpressionMapping: boolean = false;
}

@Config
export class SsoConfig {
	/** Whether to automatically create user accounts when someone signs in via SSO for the first time. */
	@Env('N8N_SSO_JUST_IN_TIME_PROVISIONING')
	justInTimeProvisioning: boolean = true;

	/** Whether the login screen redirects directly to SSO instead of showing email/password. */
	@Env('N8N_SSO_REDIRECT_LOGIN_TO_SSO')
	redirectLoginToSso: boolean = true;

	@Nested
	saml: SamlConfig;

	@Nested
	oidc: OidcConfig;

	@Nested
	ldap: LdapConfig;

	@Nested
	provisioning: ProvisioningConfig;
}

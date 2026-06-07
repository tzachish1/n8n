import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';

import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { EventService } from '@/events/event.service';

/**
 * Fork §10 — Microsoft On-Behalf-Of (OBO) exchange.
 *
 * Extracted from `OidcService.exchangeForGraphToken` so that both the OIDC
 * login path (Phase 1) and the planned webhook lazy-seed path (Phase 2b, see
 * `.claude/specs/oidc-lazy-seed-on-webhook.md`) consume the same OBO
 * implementation through dependency injection.
 *
 * Microsoft Entra returns at most one access-token-audience per `/authorize`
 * call. When n8n's OIDC login targets a custom API resource (the common case
 * once provisioning is enabled), the captured access token's `aud` is
 * `api://<n8n-app>` — not Graph. To call Graph as that user we POST to the
 * IdP's token endpoint with grant
 * `urn:ietf:params:oauth:grant-type:jwt-bearer` and the user's token as the
 * `assertion`. Entra responds with a Graph-audience access token plus (when
 * `offline_access` is requested) a refresh token. See:
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow
 *
 * Prerequisites on the Entra side:
 *  - The n8n App Registration must have delegated Graph permissions granted
 *    AND admin-consented.
 *  - The caller must provide a user access token whose `aud` matches the
 *    n8n App Registration — this is the OBO `assertion`. In the OIDC login
 *    path that token is captured at the OIDC callback; in the webhook
 *    lazy-seed path it's the inbound `Authorization: Bearer` value.
 *
 * Fail-open semantics are inherited from `globalConfig.sso.oidc.graphSeedFailOpen`
 * (`true` by default). On failure the service emits an
 * `oidc-graph-token-skipped` audit event with reason `obo_exchange_failed`,
 * then either returns `null` (fail-open) or throws (fail-closed). This is the
 * single source of truth for OBO error handling in the fork.
 */
export type GraphTokenExchangeRequest = {
	/** Identifies the n8n user the exchange is being performed on behalf of.
	 * Used only for audit-event payloads and log lines — never sent to the
	 * IdP. Required so audit consumers can correlate exchanges with user
	 * sessions. */
	userId: string;

	/** OAuth2 client id of the n8n App Registration. */
	clientId: string;

	/** OAuth2 client secret of the n8n App Registration. */
	clientSecret: string;

	/** The user access token to use as the OBO `assertion`. Its `aud` must
	 * match the n8n App Registration. */
	userAccessToken: string;

	/** Returns the IdP token endpoint. Async so callers can defer the
	 * openid-client discovery (or any other resolution mechanism) until the
	 * exchange is actually about to run. Returning `undefined` or throwing
	 * are both treated as `obo_exchange_failed`. */
	resolveTokenEndpoint: () => Promise<string | undefined>;
};

export type GraphTokenExchangeResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
};

@Service()
export class GraphTokenExchanger {
	constructor(
		private readonly globalConfig: GlobalConfig,
		private readonly eventService: EventService,
		private readonly logger: Logger,
	) {}

	/**
	 * Perform the OBO exchange.
	 *
	 * Returns the parsed OBO response on success, or `null` when fail-open
	 * absorbs a failure. Throws only when `graphSeedFailOpen=false` — in
	 * that case the original error type from the underlying call is
	 * preserved (network errors propagate as-is; discovery / IdP-rejection
	 * paths wrap as `InternalServerError`).
	 */
	async exchange(request: GraphTokenExchangeRequest): Promise<GraphTokenExchangeResponse | null> {
		const { userId, clientId, clientSecret, userAccessToken, resolveTokenEndpoint } = request;
		const { graphScopes, graphSeedFailOpen } = this.globalConfig.sso.oidc;

		const oboScope =
			graphScopes.trim() !== '' ? graphScopes.trim() : 'https://graph.microsoft.com/.default';
		// `offline_access` is mandatory in the OBO scope set — without it Entra
		// returns only an access token and the credential cannot self-refresh.
		const scope = `${oboScope} offline_access`;

		let tokenEndpoint: string | undefined;
		try {
			tokenEndpoint = await resolveTokenEndpoint();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('OIDC Graph OBO: failed to read token_endpoint from discovery', {
				userId,
				errorMessage,
			});
			this.eventService.emit('oidc-graph-token-skipped', {
				userId,
				reason: 'obo_exchange_failed',
			});
			if (!graphSeedFailOpen) throw error;
			return null;
		}

		if (!tokenEndpoint) {
			this.logger.error('OIDC Graph OBO: IdP discovery is missing token_endpoint', { userId });
			this.eventService.emit('oidc-graph-token-skipped', {
				userId,
				reason: 'obo_exchange_failed',
			});
			if (!graphSeedFailOpen) {
				throw new InternalServerError('IdP discovery is missing token_endpoint');
			}
			return null;
		}

		const body = new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			client_id: clientId,
			client_secret: clientSecret,
			assertion: userAccessToken,
			scope,
			requested_token_use: 'on_behalf_of',
		});

		let response: Response;
		try {
			response = await fetch(tokenEndpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error('OIDC Graph OBO: network error during exchange', {
				userId,
				errorMessage,
			});
			this.eventService.emit('oidc-graph-token-skipped', {
				userId,
				reason: 'obo_exchange_failed',
			});
			if (!graphSeedFailOpen) throw error;
			return null;
		}

		if (!response.ok) {
			// Entra returns JSON `{ error, error_description, ... }` on failure.
			// Capture `error_description` for diagnostics — never log the assertion
			// or any token material.
			let errorBody: unknown;
			try {
				errorBody = await response.json();
			} catch {
				errorBody = await response.text().catch(() => '<unreadable body>');
			}
			const errorBodyAsRecord = (errorBody ?? {}) as Record<string, unknown>;
			this.logger.error('OIDC Graph OBO: IdP rejected exchange', {
				userId,
				status: response.status,
				idpError: errorBodyAsRecord.error,
				idpErrorDescription: errorBodyAsRecord.error_description,
			});
			this.eventService.emit('oidc-graph-token-skipped', {
				userId,
				reason: 'obo_exchange_failed',
			});
			if (!graphSeedFailOpen) {
				throw new InternalServerError(
					`OBO exchange failed: ${String(errorBodyAsRecord.error ?? response.status)}`,
				);
			}
			return null;
		}

		const parsed = (await response.json().catch(() => undefined)) as
			| { access_token?: string; refresh_token?: string; expires_in?: number }
			| undefined;
		if (!parsed?.access_token) {
			this.logger.error('OIDC Graph OBO: response missing access_token', { userId });
			this.eventService.emit('oidc-graph-token-skipped', {
				userId,
				reason: 'obo_exchange_failed',
			});
			if (!graphSeedFailOpen) {
				throw new InternalServerError('OBO response missing access_token');
			}
			return null;
		}

		return {
			access_token: parsed.access_token,
			refresh_token: parsed.refresh_token,
			expires_in: parsed.expires_in,
		};
	}
}

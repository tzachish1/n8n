import type { Logger } from '@n8n/backend-common';
import { mockLogger } from '@n8n/backend-test-utils';
import type { GlobalConfig } from '@n8n/config';
import { mock } from 'jest-mock-extended';

import type { EventService } from '@/events/event.service';

import { GraphTokenExchanger } from '../graph-token-exchanger.service';

describe('GraphTokenExchanger', () => {
	let exchanger: GraphTokenExchanger;
	let globalConfig: GlobalConfig;
	let eventService: EventService;
	let logger: Logger;

	const baseRequest = () => ({
		userId: 'user-id',
		clientId: 'test-client-id',
		clientSecret: 'test-client-secret',
		userAccessToken: 'user-api-access-token',
		resolveTokenEndpoint: jest
			.fn()
			.mockResolvedValue('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token'),
	});

	const mockOboSuccess = (overrides: Record<string, unknown> = {}) => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				access_token: 'graph-access-token',
				refresh_token: 'graph-refresh-token',
				expires_in: 3599,
				token_type: 'Bearer',
				...overrides,
			}),
		}) as unknown as typeof global.fetch;
	};

	beforeEach(() => {
		jest.resetAllMocks();

		globalConfig = mock<GlobalConfig>({
			sso: {
				oidc: {
					graphScopes: 'https://graph.microsoft.com/Mail.ReadWrite',
					graphSeedFailOpen: true,
				},
			},
		});
		eventService = mock<EventService>();
		logger = mockLogger();

		exchanger = new GraphTokenExchanger(globalConfig, eventService, logger);
	});

	describe('happy path', () => {
		it('POSTs the OBO request with the expected shape and returns the parsed response', async () => {
			mockOboSuccess();

			const result = await exchanger.exchange(baseRequest());

			expect(result).toEqual({
				access_token: 'graph-access-token',
				refresh_token: 'graph-refresh-token',
				expires_in: 3599,
			});

			expect(global.fetch).toHaveBeenCalledTimes(1);
			const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
			expect(url).toBe('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token');
			expect(init.method).toBe('POST');
			expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });

			const body = new URLSearchParams(init.body as string);
			expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
			expect(body.get('requested_token_use')).toBe('on_behalf_of');
			expect(body.get('client_id')).toBe('test-client-id');
			expect(body.get('client_secret')).toBe('test-client-secret');
			expect(body.get('assertion')).toBe('user-api-access-token');
			expect(body.get('scope')).toBe('https://graph.microsoft.com/Mail.ReadWrite offline_access');

			expect(eventService.emit).not.toHaveBeenCalled();
		});

		it('defaults the OBO scope to /.default when graphScopes is empty or whitespace-only', async () => {
			globalConfig.sso.oidc.graphScopes = '   ';
			mockOboSuccess();

			await exchanger.exchange(baseRequest());

			const init = (global.fetch as jest.Mock).mock.calls[0][1];
			const body = new URLSearchParams(init.body as string);
			expect(body.get('scope')).toBe('https://graph.microsoft.com/.default offline_access');
		});

		it('returns refresh_token as undefined when the OBO response omits it', async () => {
			mockOboSuccess({ refresh_token: undefined });

			const result = await exchanger.exchange(baseRequest());

			// Returning the response verbatim is intentional — the caller
			// (autoSeedGraphCredentials) is the one that decides this is a
			// `no_refresh_token` skip. Keeping the exchanger pure means the
			// lazy-seed path can apply its own per-call policy later.
			expect(result).toEqual({
				access_token: 'graph-access-token',
				refresh_token: undefined,
				expires_in: 3599,
			});
			expect(eventService.emit).not.toHaveBeenCalled();
		});
	});

	describe('token-endpoint resolution failures', () => {
		it('skips with obo_exchange_failed and returns null when resolveTokenEndpoint throws (fail-open)', async () => {
			const request = baseRequest();
			request.resolveTokenEndpoint = jest.fn().mockRejectedValue(new Error('discovery boom'));

			const result = await exchanger.exchange(request);

			expect(result).toBeNull();
			expect(global.fetch).not.toHaveBeenCalled();
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
		});

		it('re-throws the original error when resolveTokenEndpoint throws and graphSeedFailOpen=false', async () => {
			globalConfig.sso.oidc.graphSeedFailOpen = false;
			const request = baseRequest();
			const discoveryErr = new Error('discovery boom');
			request.resolveTokenEndpoint = jest.fn().mockRejectedValue(discoveryErr);

			await expect(exchanger.exchange(request)).rejects.toBe(discoveryErr);

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
		});

		it('skips with obo_exchange_failed when resolveTokenEndpoint returns undefined (fail-open)', async () => {
			const request = baseRequest();
			request.resolveTokenEndpoint = jest.fn().mockResolvedValue(undefined);

			const result = await exchanger.exchange(request);

			expect(result).toBeNull();
			expect(global.fetch).not.toHaveBeenCalled();
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
		});

		it('throws InternalServerError when resolveTokenEndpoint returns undefined and graphSeedFailOpen=false', async () => {
			globalConfig.sso.oidc.graphSeedFailOpen = false;
			const request = baseRequest();
			request.resolveTokenEndpoint = jest.fn().mockResolvedValue(undefined);

			await expect(exchanger.exchange(request)).rejects.toThrow(
				/IdP discovery is missing token_endpoint/,
			);
		});
	});

	describe('OBO call failures', () => {
		it('skips with obo_exchange_failed on network error (fail-open)', async () => {
			global.fetch = jest
				.fn()
				.mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof global.fetch;

			const result = await exchanger.exchange(baseRequest());

			expect(result).toBeNull();
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
		});

		it('re-throws the network error when graphSeedFailOpen=false', async () => {
			globalConfig.sso.oidc.graphSeedFailOpen = false;
			const networkErr = new Error('ECONNRESET');
			global.fetch = jest.fn().mockRejectedValue(networkErr) as unknown as typeof global.fetch;

			await expect(exchanger.exchange(baseRequest())).rejects.toBe(networkErr);
		});

		it('skips with obo_exchange_failed on IdP rejection and logs error description (fail-open)', async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({
					error: 'invalid_grant',
					error_description: 'AADSTS50013: Assertion failed signature validation.',
				}),
			}) as unknown as typeof global.fetch;

			const result = await exchanger.exchange(baseRequest());

			expect(result).toBeNull();
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
			expect(logger.error).toHaveBeenCalledWith(
				'OIDC Graph OBO: IdP rejected exchange',
				expect.objectContaining({
					userId: 'user-id',
					status: 400,
					idpError: 'invalid_grant',
					idpErrorDescription: 'AADSTS50013: Assertion failed signature validation.',
				}),
			);
		});

		it('throws InternalServerError on IdP rejection when graphSeedFailOpen=false', async () => {
			globalConfig.sso.oidc.graphSeedFailOpen = false;
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 401,
				json: async () => ({ error: 'invalid_client' }),
			}) as unknown as typeof global.fetch;

			await expect(exchanger.exchange(baseRequest())).rejects.toThrow(
				/OBO exchange failed: invalid_client/,
			);
		});

		it('tolerates an unreadable error body (text fallback) without throwing on the parse', async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 502,
				json: async () => {
					throw new Error('not json');
				},
				text: async () => 'bad gateway',
			}) as unknown as typeof global.fetch;

			const result = await exchanger.exchange(baseRequest());

			expect(result).toBeNull();
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
		});

		it('skips when the OBO response is 200 but the JSON has no access_token (fail-open)', async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ token_type: 'Bearer' }),
			}) as unknown as typeof global.fetch;

			const result = await exchanger.exchange(baseRequest());

			expect(result).toBeNull();
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
		});

		it('throws InternalServerError when the OBO response has no access_token and graphSeedFailOpen=false', async () => {
			globalConfig.sso.oidc.graphSeedFailOpen = false;
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ token_type: 'Bearer' }),
			}) as unknown as typeof global.fetch;

			await expect(exchanger.exchange(baseRequest())).rejects.toThrow(
				/OBO response missing access_token/,
			);
		});
	});
});

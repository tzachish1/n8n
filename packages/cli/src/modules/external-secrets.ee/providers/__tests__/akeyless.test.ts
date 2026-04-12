import { Logger } from '@n8n/backend-common';
import { createFakeOutboundHttp, type Route } from '@n8n/backend-network/testing';
import { mockInstance } from '@n8n/backend-test-utils';
import type { IHttpRequestOptions } from 'n8n-workflow';

import type { SecretsProviderSettings } from '../../types';
import { AkeylessProvider } from '../akeyless';

const AKEYLESS_BASE_URL = 'https://akeyless-gw.test.com';
const AKEYLESS_URL = `${AKEYLESS_BASE_URL}/api/v2`;
const AUTH_PATH = '/api/v2/auth';
const LIST_ITEMS_PATH = '/api/v2/list-items';
const GET_SECRET_VALUE_PATH = '/api/v2/get-secret-value';
const ROTATED_SECRET_GET_VALUE_PATH = '/api/v2/rotated-secret-get-value';

const akeylessSettingsToken = {
	connected: true,
	connectedAt: new Date(),
	settings: {
		url: AKEYLESS_URL,
		authMethod: 'token' as const,
		token: 't-test-token-123',
		accessId: '',
		accessKey: '',
		path: '/',
	},
};

const akeylessSettingsAccessKey = {
	connected: true,
	connectedAt: new Date(),
	settings: {
		url: AKEYLESS_URL,
		authMethod: 'accessKey' as const,
		token: '',
		accessId: 'p-test-access-id',
		accessKey: 'test-access-key-secret',
		path: '/',
	},
};

const akeylessSettingsWithPath = {
	connected: true,
	connectedAt: new Date(),
	settings: {
		url: AKEYLESS_URL,
		authMethod: 'token' as const,
		token: 't-test-token-123',
		accessId: '',
		accessKey: '',
		path: '/myapp/prod/',
	},
};

function authRoute(token = 't-temp-token-from-auth'): Route {
	return { method: 'POST', pathname: AUTH_PATH, body: { token } };
}

function emptyListRoute(): Route {
	return { method: 'POST', pathname: LIST_ITEMS_PATH, body: { items: [], next_page: '' } };
}

describe('AkeylessProvider', () => {
	const logger = mockInstance(Logger);
	logger.scoped.mockReturnValue(logger);

	beforeEach(() => {
		vi.clearAllMocks();
		logger.scoped.mockReturnValue(logger);
	});

	function createProvider(routes: Route[], settings: SecretsProviderSettings = akeylessSettingsToken) {
		const { outboundHttp, httpRequest, requests } = createFakeOutboundHttp(
			routes,
			vi.fn as unknown as Parameters<typeof createFakeOutboundHttp>[1],
		);
		const provider = new AkeylessProvider(logger, outboundHttp);
		return { provider, httpRequest, requests, outboundHttp, settings };
	}

	async function initProvider(routes: Route[], settings: SecretsProviderSettings = akeylessSettingsToken) {
		const ctx = createProvider(routes, settings);
		await ctx.provider.init(settings);
		return ctx;
	}

	type FakeHttpRequest = ReturnType<typeof createFakeOutboundHttp>['httpRequest'];

	function findCall(
		httpRequest: FakeHttpRequest,
		predicate: (options: IHttpRequestOptions) => boolean,
	) {
		return httpRequest.mock.calls.map(([options]) => options).find(predicate);
	}

	describe('init', () => {
		it('should store settings correctly', async () => {
			const { provider, requests } = await initProvider([]);

			expect(provider.name).toBe('akeyless');
			expect(provider.displayName).toBe('Akeyless');
			expect(requests).toHaveBeenCalledWith({
				baseURL: `${AKEYLESS_URL}/`,
				headers: expect.any(Function),
				ssrf: 'disabled',
			});
		});
	});

	describe('doConnect with access key auth', () => {
		it('should call /auth and then test with the returned token', async () => {
			const { provider, httpRequest } = await initProvider(
				[authRoute(), emptyListRoute()],
				akeylessSettingsAccessKey,
			);

			await provider.connect();

			const authCall = findCall(
				httpRequest,
				(options) => new URL(options.url).pathname === AUTH_PATH,
			);
			expect(authCall).toMatchObject({
				method: 'POST',
				body: {
					'access-type': 'access_key',
					'access-id': 'p-test-access-id',
					'access-key': 'test-access-key-secret',
				},
				json: true,
			});

			const listCall = findCall(
				httpRequest,
				(options) =>
					options.url.endsWith(LIST_ITEMS_PATH) &&
					typeof options.body === 'object' &&
					options.body !== null &&
					'token' in options.body &&
					options.body.token === 't-temp-token-from-auth',
			);
			expect(listCall).toBeDefined();

			await provider.disconnect();
		});

		it('should fail if /auth returns no token', async () => {
			const { provider } = await initProvider(
				[{ method: 'POST', pathname: AUTH_PATH, body: {} }],
				akeylessSettingsAccessKey,
			);

			await provider.connect();

			expect(provider.state).toBe('error');
		});
	});

	describe('test', () => {
		it('should return [true] when list-items succeeds (token auth)', async () => {
			const { provider } = await initProvider([emptyListRoute()]);

			await provider.connect();

			expect(provider.state).toBe('connected');
		});

		it('should set error state on 401', async () => {
			const { provider } = await initProvider([
				{ method: 'POST', pathname: LIST_ITEMS_PATH, status: 401, body: { error: 'Unauthorized' } },
			]);

			await provider.connect();

			expect(provider.state).toBe('error');
		});

		it('should set error state on 403', async () => {
			const { provider } = await initProvider([
				{ method: 'POST', pathname: LIST_ITEMS_PATH, status: 403, body: { error: 'Forbidden' } },
			]);

			await provider.connect();

			expect(provider.state).toBe('error');
		});
	});

	describe('update', () => {
		it('should fetch and cache static secrets', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [
							{ item_name: '/db-password', item_type: 'static-secret' },
							{ item_name: '/api-key', item_type: 'static-secret' },
						],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: {
						'/db-password': 'hunter2',
						'/api-key': 'sk-abc123',
					},
				},
			]);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('db-password')).toBe(true);
			expect(provider.hasSecret('api-key')).toBe(true);
			expect(provider.getSecret('db-password')).toBe('hunter2');
			expect(provider.getSecret('api-key')).toBe('sk-abc123');
			expect(provider.getSecretNames()).toEqual(expect.arrayContaining(['db-password', 'api-key']));
		});

		it('should re-authenticate before update when using access key', async () => {
			const { provider, httpRequest } = await initProvider([
				authRoute(),
				emptyListRoute(),
				authRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/secret', item_type: 'static-secret' }],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: { '/secret': 'value' },
				},
			], akeylessSettingsAccessKey);

			await provider.connect();
			await provider.update();

			const updateListCall = findCall(
				httpRequest,
				(options) =>
					options.url.endsWith(LIST_ITEMS_PATH) &&
					typeof options.body === 'object' &&
					options.body !== null &&
					'token' in options.body &&
					options.body.token === 't-temp-token-from-auth',
			);
			expect(updateListCall).toBeDefined();

			expect(provider.hasSecret('secret')).toBe(true);
			await provider.disconnect();
		});

		it('should fetch and cache rotated secrets', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/db-creds', item_type: 'key' }],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: ROTATED_SECRET_GET_VALUE_PATH,
					body: {
						value: { username: 'admin', password: 'rotated-pass-123' },
					},
				},
			]);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('db-creds')).toBe(true);
			expect(provider.getSecret('db-creds')).toEqual({
				username: 'admin',
				password: 'rotated-pass-123',
			});
		});

		it('should handle mixed static and rotated secrets', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [
							{ item_name: '/static-secret', item_type: 'static-secret' },
							{ item_name: '/rotated-creds', item_type: 'key' },
						],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: { '/static-secret': 'my-value' },
				},
				{
					method: 'POST',
					pathname: ROTATED_SECRET_GET_VALUE_PATH,
					body: { value: { user: 'svc', pass: 'p@ss' } },
				},
			]);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('static-secret')).toBe(true);
			expect(provider.hasSecret('rotated-creds')).toBe(true);
			expect(provider.getSecret('static-secret')).toBe('my-value');
			expect(provider.getSecret('rotated-creds')).toEqual({ user: 'svc', pass: 'p@ss' });
		});

		it('should handle pagination', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/secret-1', item_type: 'static-secret' }],
						next_page: 'page-2-token',
					},
				},
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/secret-2', item_type: 'static-secret' }],
						next_page: 'page-3-token',
					},
				},
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {},
				},
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: {
						'/secret-1': 'value-1',
						'/secret-2': 'value-2',
					},
				},
			]);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('secret-1')).toBe(true);
			expect(provider.hasSecret('secret-2')).toBe(true);
		});

		it('should discover secrets in subfolders via recursive folder traversal', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/myapp/prod/db-password', item_type: 'static-secret' }],
						folders: ['/myapp/prod/auth/', '/myapp/prod/services/'],
						next_page: 'base-page-2',
					},
				},
				{ method: 'POST', pathname: LIST_ITEMS_PATH, body: {} },
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/myapp/prod/auth/token', item_type: 'static-secret' }],
						next_page: 'auth-page-2',
					},
				},
				{ method: 'POST', pathname: LIST_ITEMS_PATH, body: {} },
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/myapp/prod/services/api-key', item_type: 'static-secret' }],
						next_page: 'svc-page-2',
					},
				},
				{ method: 'POST', pathname: LIST_ITEMS_PATH, body: {} },
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: {
						'/myapp/prod/db-password': 'hunter2',
						'/myapp/prod/auth/token': 'tok-abc',
						'/myapp/prod/services/api-key': 'sk-xyz',
					},
				},
			], akeylessSettingsWithPath);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('db-password')).toBe(true);
			expect(provider.hasSecret('auth/token')).toBe(true);
			expect(provider.hasSecret('services/api-key')).toBe(true);
			expect(provider.getSecret('db-password')).toBe('hunter2');
			expect(provider.getSecret('auth/token')).toBe('tok-abc');
			expect(provider.getSecret('services/api-key')).toBe('sk-xyz');
		});

		it('should strip base path from secret names', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [
							{ item_name: '/myapp/prod/db-password', item_type: 'static-secret' },
							{ item_name: '/myapp/prod/api-key', item_type: 'static-secret' },
						],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: {
						'/myapp/prod/db-password': 'hunter2',
						'/myapp/prod/api-key': 'sk-abc',
					},
				},
			], akeylessSettingsWithPath);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('db-password')).toBe(true);
			expect(provider.hasSecret('api-key')).toBe(true);
			expect(provider.hasSecret('/myapp/prod/db-password')).toBe(false);
		});

		it('should handle empty items list', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{ method: 'POST', pathname: LIST_ITEMS_PATH, body: { items: null, next_page: '' } },
			]);

			await provider.connect();
			await provider.update();

			expect(provider.getSecretNames()).toHaveLength(0);
		});

		it('should continue when a rotated secret fetch fails', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [
							{ item_name: '/good-rotated', item_type: 'key' },
							{ item_name: '/bad-rotated', item_type: 'key' },
						],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: ROTATED_SECRET_GET_VALUE_PATH,
					body: { value: { key: 'works' } },
				},
				{
					method: 'POST',
					pathname: ROTATED_SECRET_GET_VALUE_PATH,
					status: 403,
					body: { error: 'permission denied' },
				},
			]);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('good-rotated')).toBe(true);
			expect(provider.hasSecret('bad-rotated')).toBe(false);
		});

		it('should return JSON string secret values as raw strings', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/json-secret', item_type: 'static-secret' }],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: {
						'/json-secret': '{"host":"db.example.com","port":5432}',
					},
				},
			]);

			await provider.connect();
			await provider.update();

			expect(provider.getSecret('json-secret')).toBe('{"host":"db.example.com","port":5432}');
		});
	});

	describe('token refresh', () => {
		it('should retry on 401 with a fresh token when using access key auth', async () => {
			const { provider } = await initProvider(
				[
					authRoute(),
					emptyListRoute(),
					authRoute(),
					{ method: 'POST', pathname: LIST_ITEMS_PATH, status: 401, body: { error: 'Token expired' } },
					authRoute(),
					{
						method: 'POST',
						pathname: LIST_ITEMS_PATH,
						body: {
							items: [{ item_name: '/secret', item_type: 'static-secret' }],
							next_page: '',
						},
					},
					{
						method: 'POST',
						pathname: GET_SECRET_VALUE_PATH,
						body: { '/secret': 'refreshed-value' },
					},
				],
				akeylessSettingsAccessKey,
			);

			await provider.connect();
			await provider.update();

			expect(provider.hasSecret('secret')).toBe(true);
			expect(provider.getSecret('secret')).toBe('refreshed-value');

			await provider.disconnect();
		});

		it('should not retry on 401 when using direct token auth', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{ method: 'POST', pathname: LIST_ITEMS_PATH, status: 401, body: { error: 'Token expired' } },
			]);

			await provider.connect();
			await provider.update();

			expect(provider.getSecretNames()).toHaveLength(0);

			await provider.disconnect();
		});

		it('should clean up refresh timer on disconnect', async () => {
			const { provider } = await initProvider([authRoute(), emptyListRoute()], akeylessSettingsAccessKey);

			await provider.connect();
			await provider.disconnect();

			expect(provider.state).not.toBe('error');
		});

		it('should keep refreshing the token after a disconnect/reconnect cycle', async () => {
			vi.useFakeTimers();

			try {
				const { provider, httpRequest } = await initProvider(
					[
						authRoute(),
						emptyListRoute(),
						authRoute(),
						emptyListRoute(),
						authRoute('t-token-after-reconnect-refresh'),
					],
					akeylessSettingsAccessKey,
				);

				await provider.connect();
				await provider.disconnect();
				await provider.connect();

				const countAuthCalls = () =>
					httpRequest.mock.calls.filter(([options]) => new URL(options.url).pathname === AUTH_PATH)
						.length;

				const authCallsBeforeRefresh = countAuthCalls();

				await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

				const authCallsAfterRefresh = countAuthCalls();

				// disconnect() aborts the refresh signal; reconnecting must reset it,
				// otherwise the scheduled refresh returns early and never re-authenticates.
				expect(authCallsAfterRefresh).toBe(authCallsBeforeRefresh + 1);

				await provider.disconnect();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('getSecret / hasSecret / getSecretNames', () => {
		it('should return undefined for non-existent secrets', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);

			expect(provider.getSecret('non-existent')).toBeUndefined();
			expect(provider.hasSecret('non-existent')).toBe(false);
			expect(provider.getSecretNames()).toHaveLength(0);
		});
	});

	describe('logging', () => {
		it('should log request method and URL but never request or response bodies', async () => {
			const { provider } = await initProvider([
				emptyListRoute(),
				{
					method: 'POST',
					pathname: LIST_ITEMS_PATH,
					body: {
						items: [{ item_name: '/secret', item_type: 'static-secret' }],
						next_page: '',
					},
				},
				{
					method: 'POST',
					pathname: GET_SECRET_VALUE_PATH,
					body: { '/secret': 'super-secret-value' },
				},
			]);

			await provider.connect();
			await provider.update();

			for (const call of logger.debug.mock.calls) {
				const serialized = JSON.stringify(call);
				expect(serialized).not.toContain('super-secret-value');
				expect(serialized).not.toContain('t-test-token-123');
			}
			for (const call of logger.error.mock.calls) {
				const serialized = JSON.stringify(call);
				expect(serialized).not.toContain('super-secret-value');
				expect(serialized).not.toContain('t-test-token-123');
			}
		});
	});
});

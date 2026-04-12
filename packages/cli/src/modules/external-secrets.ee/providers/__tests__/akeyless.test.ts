import { mockInstance } from '@n8n/backend-test-utils';
import { Logger } from '@n8n/backend-common';
import nock from 'nock';

import { AkeylessProvider } from '../akeyless';

const AKEYLESS_BASE_URL = 'https://akeyless-gw.test.com';
const AKEYLESS_URL = `${AKEYLESS_BASE_URL}/api/v2`;

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

function mockAuthEndpoint() {
	return nock(AKEYLESS_BASE_URL)
		.post('/api/v2/auth', (body: Record<string, unknown>) => {
			return (
				body['access-type'] === 'access_key' &&
				body['access-id'] === 'p-test-access-id' &&
				body['access-key'] === 'test-access-key-secret'
			);
		})
		.reply(200, { token: 't-temp-token-from-auth' });
}

describe('AkeylessProvider', () => {
	const logger = mockInstance(Logger);
	logger.scoped.mockReturnValue(logger);

	beforeAll(() => {
		nock.disableNetConnect();
	});

	beforeEach(() => {
		nock.cleanAll();
	});

	afterAll(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});

	describe('init', () => {
		it('should store settings correctly', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);

			expect(provider.name).toBe('akeyless');
			expect(provider.displayName).toBe('Akeyless');
		});
	});

	describe('doConnect with access key auth', () => {
		it('should call /auth and then test with the returned token', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsAccessKey);

			const authScope = mockAuthEndpoint();

			const listScope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.token === 't-temp-token-from-auth';
				})
				.reply(200, { items: [], next_page: '' });

			await provider.connect();

			authScope.done();
			listScope.done();
			await provider.disconnect();
		});

		it('should fail if /auth returns no token', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsAccessKey);

			nock(AKEYLESS_BASE_URL).post('/api/v2/auth').reply(200, {});

			await provider.connect();

			expect(provider.state).toBe('error');
		});
	});

	describe('test', () => {
		it('should return [true] when list-items succeeds (token auth)', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);

			const authScope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.token === 't-test-token-123';
				})
				.reply(200, { items: [], next_page: '' });

			await provider.connect();

			expect(true).toBe(true);
			authScope.done();
		});

		it('should set error state on 401', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);

			nock(AKEYLESS_BASE_URL).post('/api/v2/list-items').reply(401, { error: 'Unauthorized' });

			await provider.connect();

			expect(provider.state).toBe('error');
		});

		it('should set error state on 403', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);

			nock(AKEYLESS_BASE_URL).post('/api/v2/list-items').reply(403, { error: 'Forbidden' });

			await provider.connect();

			expect(provider.state).toBe('error');
		});
	});

	describe('update', () => {
		async function connectWithToken(provider: AkeylessProvider) {
			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: [], next_page: '' });
			await provider.connect();
			scope.done();
		}

		it('should fetch and cache static secrets', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);
			await connectWithToken(provider);

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, {
					items: [
						{ item_name: '/db-password', item_type: 'static-secret' },
						{ item_name: '/api-key', item_type: 'static-secret' },
					],
					next_page: '',
				})
				.post('/api/v2/get-secret-value', (body: Record<string, unknown>) => {
					const names = body.names as string[];
					return names.includes('/db-password') && names.includes('/api-key');
				})
				.reply(200, {
					'/db-password': 'hunter2',
					'/api-key': 'sk-abc123',
				});

			await provider.update();

			expect(provider.hasSecret('db-password')).toBe(true);
			expect(provider.hasSecret('api-key')).toBe(true);
			expect(provider.getSecret('db-password')).toBe('hunter2');
			expect(provider.getSecret('api-key')).toBe('sk-abc123');
			expect(provider.getSecretNames()).toEqual(expect.arrayContaining(['db-password', 'api-key']));
			scope.done();
		});

		it('should re-authenticate before update when using access key', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsAccessKey);

			const connectAuthScope = mockAuthEndpoint();
			const connectListScope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: [], next_page: '' });
			await provider.connect();
			connectAuthScope.done();
			connectListScope.done();

			const updateAuthScope = mockAuthEndpoint();
			const updateListScope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.token === 't-temp-token-from-auth';
				})
				.reply(200, {
					items: [{ item_name: '/secret', item_type: 'static-secret' }],
					next_page: '',
				});
			const getScope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/get-secret-value')
				.reply(200, { '/secret': 'value' });

			await provider.update();

			expect(provider.hasSecret('secret')).toBe(true);
			updateAuthScope.done();
			updateListScope.done();
			getScope.done();
			await provider.disconnect();
		});

		it('should fetch and cache rotated secrets', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);
			await connectWithToken(provider);

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, {
					items: [{ item_name: '/db-creds', item_type: 'key' }],
					next_page: '',
				})
				.post('/api/v2/rotated-secret-get-value', (body: Record<string, unknown>) => {
					return body.name === '/db-creds';
				})
				.reply(200, {
					value: { username: 'admin', password: 'rotated-pass-123' },
				});

			await provider.update();

			expect(provider.hasSecret('db-creds')).toBe(true);
			expect(provider.getSecret('db-creds')).toEqual({
				username: 'admin',
				password: 'rotated-pass-123',
			});
			scope.done();
		});

		it('should handle mixed static and rotated secrets', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);
			await connectWithToken(provider);

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, {
					items: [
						{ item_name: '/static-secret', item_type: 'static-secret' },
						{ item_name: '/rotated-creds', item_type: 'key' },
					],
					next_page: '',
				})
				.post('/api/v2/get-secret-value')
				.reply(200, { '/static-secret': 'my-value' })
				.post('/api/v2/rotated-secret-get-value')
				.reply(200, { value: { user: 'svc', pass: 'p@ss' } });

			await provider.update();

			expect(provider.hasSecret('static-secret')).toBe(true);
			expect(provider.hasSecret('rotated-creds')).toBe(true);
			expect(provider.getSecret('static-secret')).toBe('my-value');
			expect(provider.getSecret('rotated-creds')).toEqual({ user: 'svc', pass: 'p@ss' });
			scope.done();
		});

		it('should handle pagination', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);
			await connectWithToken(provider);

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return !body['pagination-token'];
				})
				.reply(200, {
					items: [{ item_name: '/secret-1', item_type: 'static-secret' }],
					next_page: 'page-2-token',
				})
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body['pagination-token'] === 'page-2-token';
				})
				.reply(200, {
					items: [{ item_name: '/secret-2', item_type: 'static-secret' }],
					next_page: 'page-3-token',
				})
				// Empty response signals end of pagination
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body['pagination-token'] === 'page-3-token';
				})
				.reply(200, {})
				.post('/api/v2/get-secret-value')
				.reply(200, {
					'/secret-1': 'value-1',
					'/secret-2': 'value-2',
				});

			await provider.update();

			expect(provider.hasSecret('secret-1')).toBe(true);
			expect(provider.hasSecret('secret-2')).toBe(true);
			scope.done();
		});

		it('should discover secrets in subfolders via recursive folder traversal', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsWithPath);

			const connectScope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: [], next_page: '' });
			await provider.connect();
			connectScope.done();

			const scope = nock(AKEYLESS_BASE_URL)
				// Page 1 for base path: items + subfolders + next_page (always present)
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.path === '/myapp/prod/' && !body['pagination-token'];
				})
				.reply(200, {
					items: [{ item_name: '/myapp/prod/db-password', item_type: 'static-secret' }],
					folders: ['/myapp/prod/auth/', '/myapp/prod/services/'],
					next_page: 'base-page-2',
				})
				// Page 2 for base path: empty response = done with this path
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.path === '/myapp/prod/' && body['pagination-token'] === 'base-page-2';
				})
				.reply(200, {})
				// Subfolder /myapp/prod/auth/: returns items
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.path === '/myapp/prod/auth/' && !body['pagination-token'];
				})
				.reply(200, {
					items: [{ item_name: '/myapp/prod/auth/token', item_type: 'static-secret' }],
					next_page: 'auth-page-2',
				})
				// Empty follow-up for auth folder
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.path === '/myapp/prod/auth/' && body['pagination-token'] === 'auth-page-2';
				})
				.reply(200, {})
				// Subfolder /myapp/prod/services/: returns items
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.path === '/myapp/prod/services/' && !body['pagination-token'];
				})
				.reply(200, {
					items: [{ item_name: '/myapp/prod/services/api-key', item_type: 'static-secret' }],
					next_page: 'svc-page-2',
				})
				// Empty follow-up for services folder
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.path === '/myapp/prod/services/' && body['pagination-token'] === 'svc-page-2';
				})
				.reply(200, {})
				// get-secret-value for all discovered secrets
				.post('/api/v2/get-secret-value')
				.reply(200, {
					'/myapp/prod/db-password': 'hunter2',
					'/myapp/prod/auth/token': 'tok-abc',
					'/myapp/prod/services/api-key': 'sk-xyz',
				});

			await provider.update();

			expect(provider.hasSecret('db-password')).toBe(true);
			expect(provider.hasSecret('auth/token')).toBe(true);
			expect(provider.hasSecret('services/api-key')).toBe(true);
			expect(provider.getSecret('db-password')).toBe('hunter2');
			expect(provider.getSecret('auth/token')).toBe('tok-abc');
			expect(provider.getSecret('services/api-key')).toBe('sk-xyz');
			scope.done();
		});

		it('should strip base path from secret names', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsWithPath);

			const connectScope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: [], next_page: '' });
			await provider.connect();
			connectScope.done();

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, {
					items: [
						{ item_name: '/myapp/prod/db-password', item_type: 'static-secret' },
						{ item_name: '/myapp/prod/api-key', item_type: 'static-secret' },
					],
					next_page: '',
				})
				.post('/api/v2/get-secret-value')
				.reply(200, {
					'/myapp/prod/db-password': 'hunter2',
					'/myapp/prod/api-key': 'sk-abc',
				});

			await provider.update();

			expect(provider.hasSecret('db-password')).toBe(true);
			expect(provider.hasSecret('api-key')).toBe(true);
			expect(provider.hasSecret('/myapp/prod/db-password')).toBe(false);
			scope.done();
		});

		it('should handle empty items list', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);
			await connectWithToken(provider);

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: null, next_page: '' });

			await provider.update();

			expect(provider.getSecretNames()).toHaveLength(0);
			scope.done();
		});

		it('should continue when a rotated secret fetch fails', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);
			await connectWithToken(provider);

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, {
					items: [
						{ item_name: '/good-rotated', item_type: 'key' },
						{ item_name: '/bad-rotated', item_type: 'key' },
					],
					next_page: '',
				})
				.post('/api/v2/rotated-secret-get-value', (body: Record<string, unknown>) => {
					return body.name === '/good-rotated';
				})
				.reply(200, { value: { key: 'works' } })
				.post('/api/v2/rotated-secret-get-value', (body: Record<string, unknown>) => {
					return body.name === '/bad-rotated';
				})
				.reply(403, { error: 'permission denied' });

			await provider.update();

			expect(provider.hasSecret('good-rotated')).toBe(true);
			expect(provider.hasSecret('bad-rotated')).toBe(false);
			scope.done();
		});

		it('should return JSON string secret values as raw strings', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);
			await connectWithToken(provider);

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, {
					items: [{ item_name: '/json-secret', item_type: 'static-secret' }],
					next_page: '',
				})
				.post('/api/v2/get-secret-value')
				.reply(200, {
					'/json-secret': '{"host":"db.example.com","port":5432}',
				});

			await provider.update();

			expect(provider.getSecret('json-secret')).toBe('{"host":"db.example.com","port":5432}');
			scope.done();
		});
	});

	describe('token refresh', () => {
		it('should retry on 401 with a fresh token when using access key auth', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsAccessKey);

			const connectAuth = mockAuthEndpoint();
			const connectList = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: [], next_page: '' });
			await provider.connect();
			connectAuth.done();
			connectList.done();

			// update() re-authenticates, then list-items returns 401 (old token),
			// interceptor re-authenticates again and retries with fresh token
			const updateAuth1 = mockAuthEndpoint();
			const updateAuth2 = mockAuthEndpoint();

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(401, { error: 'Token expired' })
				.post('/api/v2/list-items', (body: Record<string, unknown>) => {
					return body.token === 't-temp-token-from-auth';
				})
				.reply(200, {
					items: [{ item_name: '/secret', item_type: 'static-secret' }],
					next_page: '',
				})
				.post('/api/v2/get-secret-value')
				.reply(200, { '/secret': 'refreshed-value' });

			await provider.update();

			expect(provider.hasSecret('secret')).toBe(true);
			expect(provider.getSecret('secret')).toBe('refreshed-value');
			updateAuth1.done();
			updateAuth2.done();
			scope.done();

			await provider.disconnect();
		});

		it('should not retry on 401 when using direct token auth', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsToken);

			const connectList = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: [], next_page: '' });
			await provider.connect();
			connectList.done();

			const scope = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(401, { error: 'Token expired' });

			await provider.update();

			expect(provider.getSecretNames()).toHaveLength(0);
			scope.done();

			await provider.disconnect();
		});

		it('should clean up refresh timer on disconnect', async () => {
			const provider = new AkeylessProvider(logger);
			await provider.init(akeylessSettingsAccessKey);

			const connectAuth = mockAuthEndpoint();
			const connectList = nock(AKEYLESS_BASE_URL)
				.post('/api/v2/list-items')
				.reply(200, { items: [], next_page: '' });
			await provider.connect();
			connectAuth.done();
			connectList.done();

			await provider.disconnect();

			expect(provider.state).not.toBe('error');
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
});

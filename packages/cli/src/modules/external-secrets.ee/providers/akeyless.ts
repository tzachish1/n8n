import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { jsonParse, type IDataObject, type INodeProperties } from 'n8n-workflow';

import { DOCS_HELP_NOTICE } from '../constants';
import type { SecretsProviderSettings } from '../types';
import { SecretsProvider } from '../types';

interface AkeylessSettings {
	url: string;
	authMethod: 'token' | 'accessKey';
	token: string;
	accessId: string;
	accessKey: string;
	path: string;
}

interface AkeylessListItem {
	item_name: string;
	item_type: string;
}

interface AkeylessListItemsResponse {
	items: AkeylessListItem[] | null;
	folders?: string[];
	next_page?: string;
}

export class AkeylessProvider extends SecretsProvider {
	properties: INodeProperties[] = [
		DOCS_HELP_NOTICE,
		{
			displayName: 'Gateway API URL',
			name: 'url',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. https://your-gateway:8000',
			default: '',
		},
		{
			displayName: 'Authentication Method',
			name: 'authMethod',
			type: 'options',
			options: [
				{
					name: 'Access Key',
					value: 'accessKey',
				},
				{
					name: 'Token',
					value: 'token',
				},
			],
			default: 'accessKey',
			noDataExpression: true,
		},
		{
			displayName: 'Access ID',
			name: 'accessId',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. p-xxxxxxxxxxxxxxxx',
			default: '',
			displayOptions: { show: { authMethod: ['accessKey'] } },
		},
		{
			displayName: 'Access Key',
			name: 'accessKey',
			type: 'string',
			required: true,
			noDataExpression: true,
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authMethod: ['accessKey'] } },
		},
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			required: true,
			noDataExpression: true,
			placeholder: 'e.g. t-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authMethod: ['token'] } },
		},
		{
			displayName: 'Secrets Path',
			name: 'path',
			type: 'string',
			required: false,
			noDataExpression: true,
			hint: 'Base path to scan for secrets. Leave as / to scan all.',
			placeholder: 'e.g. /myapp/prod/',
			default: '/',
		},
	];

	displayName = 'Akeyless';

	name = 'akeyless';

	private static readonly TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

	private cachedSecrets: Record<string, string | IDataObject> = {};

	private settings: AkeylessSettings;

	#http: AxiosInstance;

	#currentToken: string;

	private refreshTimeout: NodeJS.Timeout | null = null;

	private refreshAbort = new AbortController();

	constructor(readonly logger = Container.get(Logger)) {
		super();
		this.logger = this.logger.scoped('external-secrets');
	}

	async init(settings: SecretsProviderSettings): Promise<void> {
		this.settings = settings.settings as unknown as AkeylessSettings;

		const baseURL = this.settings.url.endsWith('/') ? this.settings.url : `${this.settings.url}/`;

		this.#http = axios.create({
			baseURL,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		});

		this.#http.interceptors.request.use((config) => {
			// Never log request bodies: Akeyless endpoints carry auth credentials,
			// session tokens, and secret names/values in their payloads.
			this.logger.debug(
				`Akeyless request: ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`,
			);
			return config;
		});

		this.#http.interceptors.response.use(
			(response) => {
				// Never log response bodies: /auth returns a session token and
				// /get-secret-value / /rotated-secret-get-value return secret values.
				this.logger.debug(`Akeyless response: ${response.status}`);
				return response;
			},
			async (error) => {
				if (axios.isAxiosError(error)) {
					// Log status + URL only; request/response payloads may contain
					// credentials or secret material and must never be logged.
					this.logger.error(`Akeyless request failed: ${error.response?.status}`, {
						url: `${error.config?.baseURL}${error.config?.url}`,
						code: error.code,
					});

					const config = error.config;
					if (
						error.response?.status === 401 &&
						this.settings.authMethod === 'accessKey' &&
						config &&
						!(config as unknown as { __isRetry?: boolean }).__isRetry &&
						config.url !== 'auth'
					) {
						(config as unknown as { __isRetry: boolean }).__isRetry = true;
						this.logger.debug('Token expired, re-authenticating and retrying request');

						this.#currentToken = await this.authenticate();
						const data =
							typeof config.data === 'string'
								? jsonParse<Record<string, unknown>>(config.data)
								: (config.data as Record<string, unknown>);
						data.token = this.#currentToken;
						config.data = JSON.stringify(data);

						return await this.#http.request(config);
					}
				}
				throw error;
			},
		);

		this.logger.debug('Akeyless provider initialized', { baseURL });
	}

	private async authenticate(): Promise<string> {
		if (this.settings.authMethod === 'token') {
			return this.settings.token;
		}

		const resp = await this.#http.post<{ token?: string }>('auth', {
			'access-type': 'access_key',
			'access-id': this.settings.accessId.trim(),
			'access-key': this.settings.accessKey.trim(),
		});

		const token = resp.data?.token;
		if (!token) {
			throw new Error('Failed to obtain token from Akeyless /auth endpoint');
		}

		return token;
	}

	protected async doConnect(): Promise<void> {
		this.#currentToken = await this.authenticate();

		const [testSuccess, errorMessage] = await this.test();
		if (!testSuccess) {
			throw new Error(errorMessage ?? 'Connection test failed');
		}

		this.setupTokenRefresh();
	}

	async disconnect(): Promise<void> {
		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		this.refreshAbort.abort();
		this.#currentToken = '';
	}

	private setupTokenRefresh(): void {
		if (this.settings.authMethod === 'token') {
			return;
		}

		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
		}

		this.refreshTimeout = setTimeout(this.refreshToken, AkeylessProvider.TOKEN_REFRESH_INTERVAL_MS);
	}

	private refreshToken = async (): Promise<void> => {
		if (this.refreshAbort.signal.aborted) {
			return;
		}

		try {
			this.#currentToken = await this.authenticate();
			this.logger.debug('Akeyless token refreshed successfully');

			if (!this.refreshAbort.signal.aborted) {
				this.setupTokenRefresh();
			}
		} catch (e) {
			this.logger.error('Failed to refresh Akeyless token. Attempting to reconnect.', {
				error: e instanceof Error ? e.message : String(e),
			});
			void this.connect();
		}
	};

	async test(): Promise<[boolean] | [boolean, string]> {
		try {
			const resp = await this.#http.post<AkeylessListItemsResponse>('list-items', {
				token: this.#currentToken,
				path: this.settings.path || '/',
				'minimal-view': true,
			});

			if (resp.status === 200) {
				return [true];
			}

			return [false, `Unexpected response status: ${resp.status}`];
		} catch (e) {
			if (axios.isAxiosError(e)) {
				const status = e.response?.status;
				if (status === 401 || status === 403) {
					return [false, 'Invalid token or insufficient permissions'];
				}
				if (e.code === 'ECONNREFUSED') {
					return [false, 'Connection refused. Please check the host and port of the Gateway URL.'];
				}
				const detail =
					(e.response?.data as { error?: string })?.error ??
					(e.response?.data as { message?: string })?.message;
				if (detail) {
					return [false, `Akeyless error: ${detail}`];
				}
			}
			return [false, e instanceof Error ? e.message : 'Unknown error'];
		}
	}

	async update(): Promise<void> {
		this.#currentToken = await this.authenticate();
		const items = await this.listAllItems();

		this.logger.debug('Akeyless listed items', {
			count: items.length,
			types: [...new Set(items.map((i) => i.item_type))].join(', '),
		});

		const normalizedItems = items.map((i) => ({
			...i,
			item_type: i.item_type.toLowerCase().replace(/_/g, '-'),
		}));

		const staticItems = normalizedItems.filter(
			(i) => i.item_type === 'static-secret' || i.item_type === 'classic-key',
		);
		const rotatedItems = normalizedItems.filter((i) => i.item_type === 'key');

		const secrets: Record<string, string | IDataObject> = {};

		if (staticItems.length > 0) {
			const staticValues = await this.fetchStaticSecrets(staticItems.map((i) => i.item_name));
			Object.assign(secrets, staticValues);
		}

		if (rotatedItems.length > 0) {
			const rotatedValues = await this.fetchRotatedSecrets(rotatedItems.map((i) => i.item_name));
			Object.assign(secrets, rotatedValues);
		}

		this.cachedSecrets = secrets;
		this.logger.debug(`Akeyless provider secrets updated (${Object.keys(secrets).length} secrets)`);
	}

	private async listAllItems(): Promise<AkeylessListItem[]> {
		const allItems: AkeylessListItem[] = [];
		const pathQueue: string[] = [this.settings.path || '/'];

		while (pathQueue.length > 0) {
			const currentPath = pathQueue.shift()!;
			let paginationToken: string | undefined;

			for (;;) {
				const body: Record<string, unknown> = {
					token: this.#currentToken,
					path: currentPath,
					'minimal-view': true,
					'auto-pagination': 'enabled',
				};

				if (paginationToken) {
					body['pagination-token'] = paginationToken;
				}

				try {
					const resp = await this.#http.post<AkeylessListItemsResponse>('list-items', body);

					const items = resp.data.items;
					const folders = resp.data.folders;
					const hasItems = items && items.length > 0;
					const hasFolders = folders && folders.length > 0;

					if (!hasItems && !hasFolders) break;

					if (hasItems) {
						allItems.push(...items);
					}

					if (hasFolders) {
						pathQueue.push(...folders);
					}

					paginationToken = resp.data.next_page || undefined;
					if (!paginationToken) break;
				} catch (e) {
					this.logger.error('Failed to list items from Akeyless', {
						error: e instanceof Error ? e.message : String(e),
						path: currentPath,
					});
					break;
				}
			}
		}

		this.logger.debug(`Akeyless provider discovered ${allItems.length} items`);
		return allItems;
	}

	private async fetchStaticSecrets(names: string[]): Promise<Record<string, string>> {
		try {
			const resp = await this.#http.post<Record<string, unknown>>('get-secret-value', {
				token: this.#currentToken,
				names,
			});

			const result: Record<string, string> = {};

			for (const [fullPath, value] of Object.entries(resp.data)) {
				const key = this.stripBasePath(fullPath);
				result[key] = typeof value === 'string' ? value : JSON.stringify(value);
			}

			this.logger.debug(`Akeyless provider fetched ${Object.keys(result).length} static secrets`);
			return result;
		} catch (e) {
			this.logger.error('Failed to fetch static secrets from Akeyless', {
				error: e instanceof Error ? e.message : String(e),
			});
			return {};
		}
	}

	private async fetchRotatedSecrets(
		names: string[],
	): Promise<Record<string, string | IDataObject>> {
		const results = await Promise.allSettled(
			names.map(async (name): Promise<[string, IDataObject] | null> => {
				try {
					const resp = await this.#http.post<{ value?: unknown }>('rotated-secret-get-value', {
						token: this.#currentToken,
						name,
					});

					const key = this.stripBasePath(name);
					const data = resp.data;

					if (typeof data === 'object' && data !== null) {
						if ('value' in data && typeof data.value === 'object' && data.value !== null) {
							return [key, data.value as IDataObject];
						}
						return [key, data as unknown as IDataObject];
					}

					return null;
				} catch (e) {
					this.logger.warn(`Failed to fetch rotated secret "${name}" from Akeyless`, {
						error: e instanceof Error ? e.message : String(e),
					});
					return null;
				}
			}),
		);

		const secrets: Record<string, string | IDataObject> = {};
		for (const result of results) {
			if (result.status === 'fulfilled' && result.value !== null) {
				const [key, value] = result.value;
				secrets[key] = value;
			}
		}

		this.logger.debug(`Akeyless provider fetched ${Object.keys(secrets).length} rotated secrets`);
		return secrets;
	}

	private stripBasePath(fullPath: string): string {
		const basePath = this.settings.path || '/';

		if (basePath !== '/' && fullPath.startsWith(basePath)) {
			const stripped = fullPath.slice(basePath.length);
			return stripped.startsWith('/') ? stripped.slice(1) : stripped;
		}

		if (fullPath.startsWith('/')) {
			return fullPath.slice(1);
		}

		return fullPath;
	}

	getSecret(name: string): string | IDataObject {
		return this.cachedSecrets[name];
	}

	hasSecret(name: string): boolean {
		return name in this.cachedSecrets;
	}

	getSecretNames(): string[] {
		return Object.keys(this.cachedSecrets);
	}
}

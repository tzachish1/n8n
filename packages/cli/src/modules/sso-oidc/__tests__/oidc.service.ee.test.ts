import type { OidcConfigDto } from '@n8n/api-types';
import type { Logger } from '@n8n/backend-common';
import { mockInstance, mockLogger } from '@n8n/backend-test-utils';
import type { GlobalConfig } from '@n8n/config';
import type {
	AuthIdentityRepository,
	CredentialsEntity,
	CredentialsRepository,
	SettingsRepository,
	User,
	UserRepository,
	WorkflowEntity,
	WorkflowRepository,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { mock } from 'jest-mock-extended';
import type { Cipher, InstanceSettings } from 'n8n-core';
import * as client from 'openid-client';
import { EnvHttpProxyAgent } from 'undici';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import type { EventService } from '@/events/event.service';
import type { DynamicCredentialResolverRepository } from '@/modules/dynamic-credentials.ee/database/repositories/credential-resolver.repository';
import { type ProvisioningService } from '@/modules/provisioning.ee/provisioning.service.ee';
import type { OauthService } from '@/oauth/oauth.service';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import type { JwtService } from '@/services/jwt.service';
import type { UrlService } from '@/services/url.service';
import * as ssoHelpers from '@/sso.ee/sso-helpers';

import { OIDC_PREFERENCES_DB_KEY } from '../constants';
import { OidcService } from '../oidc.service.ee';
import { GraphTokenExchanger } from '../services/graph-token-exchanger.service';

jest.mock('undici', () => ({
	// eslint-disable-next-line @typescript-eslint/naming-convention
	EnvHttpProxyAgent: jest.fn().mockImplementation(() => ({})),
}));

describe('OidcService', () => {
	let oidcService: OidcService;
	let settingsRepository: SettingsRepository;
	let globalConfig: GlobalConfig;
	let instanceSettings: InstanceSettings;
	let cipher: Cipher;
	let logger: Logger;
	let jwtService: JwtService;
	let provisioningService: ProvisioningService;
	let userRepository: UserRepository;
	let authIdentityRepository: AuthIdentityRepository;
	let oauthService: OauthService;
	let credentialsRepository: CredentialsRepository;
	let eventService: EventService;
	let resolverRepository: DynamicCredentialResolverRepository;
	let workflowRepository: WorkflowRepository;
	let graphTokenExchanger: GraphTokenExchanger;

	const mockOidcConfig = {
		clientId: 'test-client-id',
		clientSecret: 'test-client-secret',
		discoveryEndpoint: 'https://example.com/.well-known/openid_configuration',
		scope: 'openid profile email',
		loginEnabled: true,
		loginLabel: 'Login with OIDC',
		loginButtonColor: '#1f2937',
	};

	const mockConfigFromDB = {
		key: OIDC_PREFERENCES_DB_KEY,
		value: JSON.stringify(mockOidcConfig),
		loadOnStartup: true,
	};

	beforeEach(async () => {
		jest.resetAllMocks();
		Container.reset();

		settingsRepository = mock<SettingsRepository>();
		globalConfig = mock<GlobalConfig>({
			sso: {
				oidc: {
					loginEnabled: false,
					graphScopes: '',
					graphAutoSeedEnabled: false,
					graphSeedFailOpen: true,
				},
			},
		});
		instanceSettings = mock<InstanceSettings>({
			isMultiMain: true,
		});
		cipher = mock<Cipher>();
		logger = mockLogger();
		jwtService = mock<JwtService>();
		provisioningService = mock<ProvisioningService>();
		userRepository = mock<UserRepository>();
		authIdentityRepository = mock<AuthIdentityRepository>();
		oauthService = mock<OauthService>();
		credentialsRepository = mock<CredentialsRepository>();
		eventService = mock<EventService>();
		resolverRepository = mock<DynamicCredentialResolverRepository>();
		// Default: no resolvers opted in via the v2 (UI) path — tests that exercise
		// the env-var back-compat path are isolated by leaving this empty.
		resolverRepository.find = jest.fn().mockResolvedValue([]);
		workflowRepository = mock<WorkflowRepository>();
		// Default: no workflows present — tests that exercise workflow-level
		// resolver binding override this per-case.
		workflowRepository.find = jest.fn().mockResolvedValue([]);
		// Use the real GraphTokenExchanger (with mocked deps) so existing
		// OBO tests — which assert on `global.fetch` shape and on
		// `eventService.emit('oidc-graph-token-skipped', { reason: 'obo_exchange_failed' })`
		// — continue to exercise the actual OBO behavior end-to-end. Replacing
		// the exchanger with a jest mock here would break that assertion
		// surface; the Phase 2a refactor is strictly behavior-preserving.
		graphTokenExchanger = new GraphTokenExchanger(globalConfig, eventService, logger);
		jest
			.spyOn(ssoHelpers, 'setCurrentAuthenticationMethod')
			.mockImplementation(async () => await Promise.resolve());

		oidcService = new OidcService(
			settingsRepository,
			authIdentityRepository,
			mock<UrlService>(),
			globalConfig,
			userRepository,
			cipher,
			logger,
			jwtService,
			instanceSettings,
			provisioningService,
			oauthService,
			credentialsRepository,
			eventService,
			resolverRepository,
			workflowRepository,
			graphTokenExchanger,
		);

		await oidcService.init();
	});

	describe('reload', () => {
		it('should reload OIDC configuration from database', async () => {
			settingsRepository.findByKey = jest.fn().mockResolvedValue(mockConfigFromDB);

			// Mock the discovery endpoint response
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => {
					return await Promise.resolve({
						issuer: 'https://example.com',
						authorization_endpoint: 'https://example.com/auth',
						token_endpoint: 'https://example.com/token',
						userinfo_endpoint: 'https://example.com/userinfo',
						jwks_uri: 'https://example.com/jwks',
					});
				},
			});

			await oidcService.reload();

			expect(settingsRepository.findByKey).toHaveBeenCalledWith(OIDC_PREFERENCES_DB_KEY);
			expect(logger.debug).toHaveBeenCalledWith(
				'OIDC configuration changed, starting to load it from the database',
			);
		});

		it('should handle reload when no config exists in database', async () => {
			settingsRepository.findByKey = jest.fn().mockResolvedValue(null);

			await oidcService.reload();

			expect(logger.warn).toHaveBeenCalledWith(
				'OIDC configuration not found in database, ignoring reload message',
			);
		});

		it('should handle errors during reload', async () => {
			const error = new Error('Database error');
			settingsRepository.findByKey = jest.fn().mockRejectedValue(error);

			await oidcService.reload();

			expect(logger.error).toHaveBeenCalledWith(
				'OIDC configuration changed, failed to reload OIDC configuration',
				{ error },
			);
		});
	});

	describe('loadConfigurationFromDatabase', () => {
		it('should return undefined for empty discovery endpoint', async () => {
			const configWithEmptyEndpoint = {
				...mockOidcConfig,
				discoveryEndpoint: '',
			};

			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(configWithEmptyEndpoint),
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toBeUndefined();
		});

		it('should handle invalid JSON in database', async () => {
			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: 'invalid json',
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to load OIDC configuration from database, falling back to default configuration.',
				expect.any(Object),
			);
		});

		it('should fill out optional prompt parameter with default value', async () => {
			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(mockOidcConfig),
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toEqual({
				clientId: mockOidcConfig.clientId,
				clientSecret: mockOidcConfig.clientSecret,
				loginEnabled: mockOidcConfig.loginEnabled,
				prompt: 'select_account',
				discoveryEndpoint: expect.any(URL),
				authenticationContextClassReference: expect.any(Array),
			});
		});

		it('should fill out optional authenticationContextClassReference parameter with default value', async () => {
			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(mockOidcConfig),
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toEqual({
				clientId: mockOidcConfig.clientId,
				clientSecret: mockOidcConfig.clientSecret,
				loginEnabled: mockOidcConfig.loginEnabled,
				prompt: 'select_account',
				discoveryEndpoint: expect.any(URL),
				authenticationContextClassReference: [],
			});
		});

		it('should decrypt client secret when requested', async () => {
			const encryptedSecret = 'encrypted-secret';
			const decryptedSecret = 'decrypted-secret';

			cipher.decryptV2 = jest.fn().mockResolvedValue(decryptedSecret);

			const configWithEncryptedSecret = {
				...mockOidcConfig,
				clientSecret: encryptedSecret,
			};

			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(configWithEncryptedSecret),
				loadOnStartup: true,
			});

			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => {
					return await Promise.resolve({
						issuer: 'https://example.com',
						authorization_endpoint: 'https://example.com/auth',
						token_endpoint: 'https://example.com/token',
						userinfo_endpoint: 'https://example.com/userinfo',
						jwks_uri: 'https://example.com/jwks',
					});
				},
			});

			const result = await oidcService.loadConfigurationFromDatabase(true);

			expect(cipher.decryptV2).toHaveBeenCalledWith(encryptedSecret);
			expect(result?.clientSecret).toBe(decryptedSecret);
		});

		it('should not issue warnings for default config with empty discoveryEndpoint', async () => {
			const defaultConfig = {
				...mockOidcConfig,
				discoveryEndpoint: '',
			};

			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(defaultConfig),
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toBeUndefined();
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('should issue warnings when Zod validation fails', async () => {
			const invalidConfig = {
				...mockOidcConfig,
				discoveryEndpoint: 'not-a-valid-url',
			};

			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(invalidConfig),
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to load OIDC configuration from database, falling back to default configuration.',
				expect.any(Object),
			);
		});

		it('should not issue warnings for valid complete configuration', async () => {
			settingsRepository.findByKey = jest.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(mockOidcConfig),
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toEqual({
				clientId: mockOidcConfig.clientId,
				clientSecret: mockOidcConfig.clientSecret,
				loginEnabled: mockOidcConfig.loginEnabled,
				prompt: 'select_account',
				discoveryEndpoint: expect.any(URL),
				authenticationContextClassReference: expect.any(Array),
			});
			expect(logger.warn).not.toHaveBeenCalled();
		});
	});

	describe('broadcastReloadOIDCConfigurationCommand', () => {
		const mockPublisher = { publishCommand: jest.fn() };
		beforeEach(() => {
			mockInstance(Publisher, mockPublisher);
		});

		it('should publish reload command in multi-main setup', async () => {
			(instanceSettings as any).isMultiMain = true;
			// Trigger broadcast by updating config
			settingsRepository.save = jest.fn().mockResolvedValue(mockConfigFromDB);
			settingsRepository.findByKey = jest.fn().mockResolvedValue(mockConfigFromDB);
			jest.spyOn(client, 'discovery').mockResolvedValue({} as client.Configuration);

			await oidcService.updateConfig(mockOidcConfig as any as OidcConfigDto);

			// In multi-main setup, should attempt to publish
			expect(mockPublisher.publishCommand).toHaveBeenCalledWith({
				command: 'reload-oidc-config',
			});
		});

		it('should not publish in single main setup', async () => {
			(instanceSettings as any).isMultiMain = false;

			settingsRepository.update = jest.fn().mockResolvedValue(mockConfigFromDB);
			settingsRepository.findByKey = jest.fn().mockResolvedValue(mockConfigFromDB);
			jest.spyOn(client, 'discovery').mockResolvedValue({} as client.Configuration);

			await oidcService.updateConfig(mockOidcConfig as any as OidcConfigDto);

			// Should not attempt to import Publisher in single main setup
			expect(mockPublisher.publishCommand).not.toHaveBeenCalled();
		});
	});

	describe('loginUser', () => {
		it('throws an error if authorizationCodeGrant throws an error', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			jest
				.spyOn(client, 'authorizationCodeGrant')
				.mockRejectedValue(new Error('Authorization code grant failed'));

			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Invalid authorization code');
		});

		it('throws an error if claims() throws an error', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					throw new Error('Claims extraction failed');
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Invalid token');
		});

		it('should throw an error if there are no claims', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return undefined;
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(ForbiddenError);
			await expect(promise).rejects.toThrow('No claims found in the OIDC token');
		});

		it('throws an error if fetchUserInfo throws an error', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest.spyOn(client, 'fetchUserInfo').mockRejectedValue(new Error('Fetch user info failed'));
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Invalid token - could not retrieve user info');
		});

		it('throws an error if there is no email', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest.spyOn(client, 'fetchUserInfo').mockResolvedValue({ email_verified: true } as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('An email is required');
		});

		it('throws an error if the email is invalid', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest
				.spyOn(client, 'fetchUserInfo')
				.mockResolvedValue({ email_verified: true, email: 'invalid-email' } as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Invalid email format');
		});

		it('should return the user if the auth identity already exists', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			oidcService.applySsoProvisioning = jest.fn().mockResolvedValue(undefined);
			authIdentityRepository.findOne = jest
				.fn()
				.mockResolvedValue({ user: { email: 'john.doe@test.com' } as any });

			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest
				.spyOn(client, 'fetchUserInfo')
				.mockResolvedValue({ email_verified: true, email: 'john.doe@test.com' } as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const user = await oidcService.loginUser(callbackUrl, storedState, storedNonce);
			expect(user).toBeDefined();
			expect(user.email).toEqual('john.doe@test.com');
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			expect(oidcService.applySsoProvisioning).toHaveBeenCalledWith(
				user,
				{ sub: 'valid-subject' },
				{
					email_verified: true,
					email: 'john.doe@test.com',
				},
				'valid-access-token',
			);
		});

		it('should return a user if the user exists but the auth identity does not', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			oidcService.applySsoProvisioning = jest.fn().mockResolvedValue(undefined);
			userRepository.findOne = jest.fn().mockResolvedValue({ email: 'john.doe@test.com' } as any);

			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest
				.spyOn(client, 'fetchUserInfo')
				.mockResolvedValue({ email_verified: true, email: 'john.doe@test.com' } as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const user = await oidcService.loginUser(callbackUrl, storedState, storedNonce);
			expect(user).toBeDefined();
			expect(user.email).toEqual('john.doe@test.com');
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			expect(oidcService.applySsoProvisioning).toHaveBeenCalledWith(
				user,
				{ sub: 'valid-subject' },
				{
					email_verified: true,
					email: 'john.doe@test.com',
				},
				'valid-access-token',
			);
		});

		it('should create a new user if the user does not exist', async () => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			oidcService.applySsoProvisioning = jest.fn().mockResolvedValue(undefined);
			userRepository.manager.transaction = jest
				.fn()
				.mockResolvedValue({ email: 'john.doe@test.com' } as any);

			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest
				.spyOn(client, 'fetchUserInfo')
				.mockResolvedValue({ email_verified: true, email: 'john.doe@test.com' } as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const user = await oidcService.loginUser(callbackUrl, storedState, storedNonce);
			expect(user).toBeDefined();
			expect(user.email).toEqual('john.doe@test.com');
		});
	});

	describe('applySsoProvisioning', () => {
		const claims = { sub: 'user-123', n8n_instance_role: 'global:member' };
		const userInfo = { email: 'test@example.com', email_verified: true };
		const user = mock<User>({ id: 'user-id' });

		beforeEach(() => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);
			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => claims,
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest.spyOn(client, 'fetchUserInfo').mockResolvedValue(userInfo as any);
		});

		it('calls provisionExpressionMappedRolesForUser when expression mapping is enabled', async () => {
			provisioningService.isExpressionMappingEnabled = jest.fn().mockResolvedValue(true);
			provisioningService.provisionExpressionMappedRolesForUser = jest
				.fn()
				.mockResolvedValue(undefined);
			authIdentityRepository.findOne = jest.fn().mockResolvedValue({ user });

			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(provisioningService.provisionExpressionMappedRolesForUser).toHaveBeenCalledWith(
				user,
				expect.objectContaining({ $provider: 'oidc' }),
			);
			expect(provisioningService.provisionInstanceRoleForUser).not.toHaveBeenCalled();
			expect(provisioningService.provisionProjectRolesForUser).not.toHaveBeenCalled();
		});

		it('falls through to direct-claim provisioning when expression mapping is disabled', async () => {
			provisioningService.isExpressionMappingEnabled = jest.fn().mockResolvedValue(false);
			provisioningService.getConfig = jest.fn().mockResolvedValue({
				scopesInstanceRoleClaimName: 'n8n_instance_role',
				scopesProjectsRolesClaimName: 'n8n_projects',
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: false,
			});
			provisioningService.provisionInstanceRoleForUser = jest.fn().mockResolvedValue(undefined);
			authIdentityRepository.findOne = jest.fn().mockResolvedValue({ user });

			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(provisioningService.provisionInstanceRoleForUser).toHaveBeenCalledWith(
				user,
				'global:member',
			);
			expect(provisioningService.provisionExpressionMappedRolesForUser).not.toHaveBeenCalled();
		});

		describe('access token fallback (Azure Entra v1 token edge case)', () => {
			const buildJwt = (payload: object): string => {
				const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
					'base64url',
				);
				const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
				return `${header}.${body}.signature-not-checked`;
			};

			beforeEach(() => {
				provisioningService.isExpressionMappingEnabled = jest.fn().mockResolvedValue(false);
				provisioningService.getConfig = jest.fn().mockResolvedValue({
					scopesInstanceRoleClaimName: 'roles',
					scopesProjectsRolesClaimName: 'n8n_projects',
					scopesProvisionInstanceRole: true,
					scopesProvisionProjectRoles: false,
				});
				provisioningService.provisionInstanceRoleForUser = jest.fn().mockResolvedValue(undefined);
				authIdentityRepository.findOne = jest.fn().mockResolvedValue({ user });
			});

			it('uses access-token claims when ID token has no roles claim', async () => {
				const idTokenClaimsNoRoles = { sub: 'user-123' };
				const accessTokenJwt = buildJwt({ sub: 'user-123', roles: ['global:admin'] });
				jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
					access_token: accessTokenJwt,
					token_type: 'bearer',
					claims: () => idTokenClaimsNoRoles,
				} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);

				const callbackUrl = new URL('https://example.com/callback');
				const storedState = oidcService.generateState().signed;
				const storedNonce = oidcService.generateNonce().signed;
				await oidcService.loginUser(callbackUrl, storedState, storedNonce);

				expect(provisioningService.provisionInstanceRoleForUser).toHaveBeenCalledWith(user, [
					'global:admin',
				]);
			});

			it('does not consult access-token claims when ID token already provides roles', async () => {
				const idTokenWithRoles = { sub: 'user-123', roles: ['global:admin'] };
				const accessTokenJwt = buildJwt({ sub: 'user-123', roles: ['global:owner'] });
				jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
					access_token: accessTokenJwt,
					token_type: 'bearer',
					claims: () => idTokenWithRoles,
				} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);

				const callbackUrl = new URL('https://example.com/callback');
				const storedState = oidcService.generateState().signed;
				const storedNonce = oidcService.generateNonce().signed;
				await oidcService.loginUser(callbackUrl, storedState, storedNonce);

				// Must take the ID token's value, not the access token's
				expect(provisioningService.provisionInstanceRoleForUser).toHaveBeenCalledWith(user, [
					'global:admin',
				]);
			});

			it('passes undefined through when neither ID token nor access token has roles', async () => {
				const idTokenClaimsNoRoles = { sub: 'user-123' };
				const accessTokenJwt = buildJwt({ sub: 'user-123' });
				jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
					access_token: accessTokenJwt,
					token_type: 'bearer',
					claims: () => idTokenClaimsNoRoles,
				} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);

				const callbackUrl = new URL('https://example.com/callback');
				const storedState = oidcService.generateState().signed;
				const storedNonce = oidcService.generateNonce().signed;
				await oidcService.loginUser(callbackUrl, storedState, storedNonce);

				expect(provisioningService.provisionInstanceRoleForUser).toHaveBeenCalledWith(
					user,
					undefined,
				);
			});

			it('handles non-JWT (opaque) access tokens by skipping the fallback', async () => {
				const idTokenClaimsNoRoles = { sub: 'user-123' };
				jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
					access_token: 'opaque-not-a-jwt',
					token_type: 'bearer',
					claims: () => idTokenClaimsNoRoles,
				} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);

				const callbackUrl = new URL('https://example.com/callback');
				const storedState = oidcService.generateState().signed;
				const storedNonce = oidcService.generateNonce().signed;
				await oidcService.loginUser(callbackUrl, storedState, storedNonce);

				expect(provisioningService.provisionInstanceRoleForUser).toHaveBeenCalledWith(
					user,
					undefined,
				);
			});

			it('uses access-token claims for project role mapping when ID token has none', async () => {
				provisioningService.getConfig = jest.fn().mockResolvedValue({
					scopesInstanceRoleClaimName: 'roles',
					scopesProjectsRolesClaimName: 'n8n_projects',
					scopesProvisionInstanceRole: false,
					scopesProvisionProjectRoles: true,
				});
				provisioningService.provisionProjectRolesForUser = jest.fn().mockResolvedValue(undefined);

				const idTokenClaimsNoProjects = { sub: 'user-123' };
				const accessTokenJwt = buildJwt({
					sub: 'user-123',
					n8n_projects: ['proj-1:editor'],
				});
				jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
					access_token: accessTokenJwt,
					token_type: 'bearer',
					claims: () => idTokenClaimsNoProjects,
				} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);

				const callbackUrl = new URL('https://example.com/callback');
				const storedState = oidcService.generateState().signed;
				const storedNonce = oidcService.generateNonce().signed;
				await oidcService.loginUser(callbackUrl, storedState, storedNonce);

				expect(provisioningService.provisionProjectRolesForUser).toHaveBeenCalledWith(user.id, [
					'proj-1:editor',
				]);
			});
		});
	});

	describe('proxy configuration', () => {
		const originalEnv = process.env;

		// Helper function to create a proper mock Response
		const createMockResponse = () => {
			const mockData = {
				issuer: 'https://example.com',
				authorization_endpoint: 'https://example.com/auth',
				token_endpoint: 'https://example.com/token',
				userinfo_endpoint: 'https://example.com/userinfo',
				jwks_uri: 'https://example.com/jwks',
			};
			return new Response(JSON.stringify(mockData), {
				status: 200,
				// eslint-disable-next-line @typescript-eslint/naming-convention
				headers: { 'content-type': 'application/json' },
			});
		};

		beforeEach(() => {
			// Reset environment before each test
			process.env = { ...originalEnv };
			// Reset the mock between tests
			(EnvHttpProxyAgent as unknown as jest.Mock).mockClear();
		});

		afterEach(() => {
			// Restore original environment after each test
			process.env = originalEnv;
		});

		it.each([
			{ envVar: 'HTTP_PROXY', value: 'http://proxy.example.com:8080' },
			{ envVar: 'HTTPS_PROXY', value: 'https://proxy.example.com:8443' },
			{ envVar: 'ALL_PROXY', value: 'http://all-proxy.example.com:8888' },
		])('should instantiate EnvHttpProxyAgent when $envVar is set', async ({ envVar, value }) => {
			// Set proxy environment variable
			process.env[envVar] = value;

			const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
			const clientId = 'test-client';
			const clientSecret = 'test-secret';

			const discoverySpy = jest.spyOn(client, 'discovery').mockResolvedValue({
				serverMetadata: () => ({ issuer: 'https://example.com' }),
			} as unknown as client.Configuration);

			// Call the private method directly using type assertion
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			await (oidcService as any).createProxyAwareConfiguration(
				discoveryUrl,
				clientId,
				clientSecret,
			);

			// Verify EnvHttpProxyAgent was instantiated
			expect(EnvHttpProxyAgent).toHaveBeenCalled();
			discoverySpy.mockRestore();
		});

		it('should not instantiate EnvHttpProxyAgent when no proxy env vars are set', async () => {
			// Ensure no proxy env vars are set
			delete process.env.HTTP_PROXY;
			delete process.env.HTTPS_PROXY;
			delete process.env.ALL_PROXY;

			const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
			const clientId = 'test-client';
			const clientSecret = 'test-secret';

			const discoverySpy = jest.spyOn(client, 'discovery').mockResolvedValue({
				serverMetadata: () => ({ issuer: 'https://example.com' }),
			} as unknown as client.Configuration);

			// Call the private method directly
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			await (oidcService as any).createProxyAwareConfiguration(
				discoveryUrl,
				clientId,
				clientSecret,
			);

			// Should not instantiate EnvHttpProxyAgent when no proxy is configured
			expect(EnvHttpProxyAgent).not.toHaveBeenCalled();
			discoverySpy.mockRestore();
		});

		it.each([
			{ envVar: 'HTTP_PROXY', value: 'http://proxy.example.com:8080' },
			{ envVar: 'HTTPS_PROXY', value: 'https://proxy.example.com:8443' },
			{ envVar: 'ALL_PROXY', value: 'http://all-proxy.example.com:8888' },
		])(
			'should call discovery with customFetch option when $envVar is configured',
			async ({ envVar, value }) => {
				process.env[envVar] = value;

				const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
				const clientId = 'test-client';
				const clientSecret = 'test-secret';

				global.fetch = jest.fn().mockResolvedValue(createMockResponse());

				const discoverySpy = jest.spyOn(client, 'discovery').mockResolvedValue({
					serverMetadata: () => ({ issuer: 'https://example.com' }),
				} as unknown as client.Configuration);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
				await (oidcService as any).createProxyAwareConfiguration(
					discoveryUrl,
					clientId,
					clientSecret,
				);

				expect(discoverySpy).toHaveBeenCalledWith(
					discoveryUrl,
					clientId,
					clientSecret,
					undefined,
					expect.objectContaining({
						[client.customFetch]: expect.any(Function),
					}),
				);

				discoverySpy.mockRestore();
			},
		);

		it('should call discovery without customFetch option when no proxy is configured', async () => {
			delete process.env.HTTP_PROXY;
			delete process.env.HTTPS_PROXY;
			delete process.env.ALL_PROXY;

			const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
			const clientId = 'test-client';
			const clientSecret = 'test-secret';

			global.fetch = jest.fn().mockResolvedValue(createMockResponse());

			const discoverySpy = jest.spyOn(client, 'discovery').mockResolvedValue({
				serverMetadata: () => ({ issuer: 'https://example.com' }),
			} as unknown as client.Configuration);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			await (oidcService as any).createProxyAwareConfiguration(
				discoveryUrl,
				clientId,
				clientSecret,
			);

			// Should be called with only 3 arguments (no options object)
			expect(discoverySpy).toHaveBeenCalledWith(discoveryUrl, clientId, clientSecret);

			discoverySpy.mockRestore();
		});

		it.each([
			{ envVar: 'HTTP_PROXY', value: 'http://proxy.example.com:8080' },
			{ envVar: 'HTTPS_PROXY', value: 'https://proxy.example.com:8443' },
			{ envVar: 'ALL_PROXY', value: 'http://all-proxy.example.com:8888' },
		])(
			'should set customFetch on returned configuration when $envVar is configured',
			async ({ envVar, value }) => {
				process.env[envVar] = value;

				const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
				const clientId = 'test-client';
				const clientSecret = 'test-secret';

				global.fetch = jest.fn().mockResolvedValue(createMockResponse());

				const mockConfiguration = {
					serverMetadata: () => ({ issuer: 'https://example.com' }),
				} as unknown as client.Configuration;

				jest.spyOn(client, 'discovery').mockResolvedValue(mockConfiguration);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
				const result = await (oidcService as any).createProxyAwareConfiguration(
					discoveryUrl,
					clientId,
					clientSecret,
				);

				// Verify customFetch was set on the configuration
				expect(result[client.customFetch]).toBeDefined();
				expect(typeof result[client.customFetch]).toBe('function');
			},
		);

		it('should not set customFetch on returned configuration when no proxy is configured', async () => {
			delete process.env.HTTP_PROXY;
			delete process.env.HTTPS_PROXY;
			delete process.env.ALL_PROXY;

			const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
			const clientId = 'test-client';
			const clientSecret = 'test-secret';

			global.fetch = jest.fn().mockResolvedValue(createMockResponse());

			const mockConfiguration = {
				serverMetadata: () => ({ issuer: 'https://example.com' }),
			} as unknown as client.Configuration;

			jest.spyOn(client, 'discovery').mockResolvedValue(mockConfiguration);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			const result = await (oidcService as any).createProxyAwareConfiguration(
				discoveryUrl,
				clientId,
				clientSecret,
			);

			// customFetch should not have been set on the configuration
			expect(result[client.customFetch]).toBeUndefined();
		});

		it.each([
			{ envVar: 'HTTP_PROXY', value: 'http://proxy.example.com:8080' },
			{ envVar: 'HTTPS_PROXY', value: 'https://proxy.example.com:8443' },
			{ envVar: 'ALL_PROXY', value: 'http://all-proxy.example.com:8888' },
		])(
			'should use proxy agent dispatcher in customFetch when $envVar is configured',
			async ({ envVar, value }) => {
				process.env[envVar] = value;

				const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
				const clientId = 'test-client';
				const clientSecret = 'test-secret';

				const mockProxyAgent = { type: 'proxy-agent' };
				(EnvHttpProxyAgent as unknown as jest.Mock).mockImplementation(() => mockProxyAgent);

				const fetchSpy = jest.fn().mockResolvedValue(createMockResponse());
				global.fetch = fetchSpy;

				const mockConfiguration = {
					serverMetadata: () => ({ issuer: 'https://example.com' }),
				} as unknown as client.Configuration;

				jest.spyOn(client, 'discovery').mockResolvedValue(mockConfiguration);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
				const result = await (oidcService as any).createProxyAwareConfiguration(
					discoveryUrl,
					clientId,
					clientSecret,
				);

				// Get the customFetch function and call it
				const customFetch = result[client.customFetch];
				const testUrl = 'https://example.com/test';
				const testOptions = { method: 'GET' };

				await customFetch(testUrl, testOptions);

				// Verify fetch was called with dispatcher option
				expect(fetchSpy).toHaveBeenCalledWith(testUrl, {
					...testOptions,
					dispatcher: mockProxyAgent,
				});
			},
		);

		it('should handle multiple proxy env vars with priority (first match)', async () => {
			// Set multiple proxy variables - any of them should trigger proxy mode
			process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
			process.env.HTTPS_PROXY = 'https://https-proxy.example.com:8443';

			const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
			const clientId = 'test-client';
			const clientSecret = 'test-secret';

			const discoverySpy = jest.spyOn(client, 'discovery').mockResolvedValue({
				serverMetadata: () => ({ issuer: 'https://example.com' }),
			} as unknown as client.Configuration);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			await (oidcService as any).createProxyAwareConfiguration(
				discoveryUrl,
				clientId,
				clientSecret,
			);

			// EnvHttpProxyAgent should be instantiated once regardless of how many proxy vars are set
			expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
			discoverySpy.mockRestore();
		});

		it.each([
			{ envVar: 'HTTP_PROXY', value: 'http://proxy.example.com:8080' },
			{ envVar: 'HTTPS_PROXY', value: 'https://proxy.example.com:8443' },
			{ envVar: 'ALL_PROXY', value: 'http://all-proxy.example.com:8888' },
		])(
			'should pass through fetch options correctly when $envVar is configured',
			async ({ envVar, value }) => {
				process.env[envVar] = value;

				const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
				const clientId = 'test-client';
				const clientSecret = 'test-secret';

				const mockProxyAgent = { type: 'proxy-agent' };
				(EnvHttpProxyAgent as unknown as jest.Mock).mockImplementation(() => mockProxyAgent);

				const fetchSpy = jest.fn().mockResolvedValue(createMockResponse());
				global.fetch = fetchSpy;

				const mockConfiguration = {} as client.Configuration;
				jest.spyOn(client, 'discovery').mockResolvedValue(mockConfiguration);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
				const result = await (oidcService as any).createProxyAwareConfiguration(
					discoveryUrl,
					clientId,
					clientSecret,
				);

				const customFetch = result[client.customFetch];
				const testUrl = 'https://example.com/token';
				const testOptions = {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: 'grant_type=authorization_code&code=test',
				};

				await customFetch(testUrl, testOptions);

				// Verify all original options are preserved and dispatcher is added
				expect(fetchSpy).toHaveBeenCalledWith(testUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: 'grant_type=authorization_code&code=test',
					dispatcher: mockProxyAgent,
				});
			},
		);
	});

	// Fork §10 — OIDC self-seeding for Microsoft Graph. The feature is opt-in via
	// four env vars on `OidcConfig`; when disabled, behaviour is byte-identical to
	// upstream — covered by every other `loginUser` test in this file.
	describe('auto-seed Graph credentials', () => {
		const mockUser = { id: 'user-id', email: 'john.doe@test.com' } as User;
		const callbackUrl = new URL('https://example.com/callback');

		const mockResolvableCredential = (overrides: Partial<CredentialsEntity> = {}) =>
			({
				id: 'cred-1',
				name: 'Graph (auto)',
				type: 'microsoftOAuth2Api',
				data: 'encrypted-blob',
				isResolvable: true,
				resolvableAllowFallback: false,
				resolverId: 'resolver-a',
				...overrides,
			}) as CredentialsEntity;

		const setupLoginMocks = (
			tokenOverrides: Record<string, unknown> = {},
			oboResponseOverrides: Partial<{
				access_token: string;
				refresh_token?: string;
				expires_in: number;
			}> = {},
		) => {
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({
				serverMetadata: () => ({
					token_endpoint: 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
				}),
			} as unknown as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private
			oidcService.applySsoProvisioning = jest.fn().mockResolvedValue(undefined);
			authIdentityRepository.findOne = jest.fn().mockResolvedValue({ user: mockUser });

			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				// `access_token` here carries `aud=api://<n8n-app>` in the real flow —
				// it's the assertion we feed into the OBO exchange.
				access_token: 'user-api-access-token',
				token_type: 'bearer',
				expires_in: 3599,
				claims: () => ({ sub: 'valid-subject' }),
				...tokenOverrides,
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest
				.spyOn(client, 'fetchUserInfo')
				.mockResolvedValue({ email_verified: true, email: 'john.doe@test.com' } as any);

			// Default OBO response — Graph-audience access token + refresh token.
			// Individual tests can override to simulate failure modes.
			const oboBody = {
				access_token: 'graph-access-token',
				refresh_token: 'graph-refresh-token',
				expires_in: 3599,
				token_type: 'Bearer',
				...oboResponseOverrides,
			};
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => oboBody,
			}) as unknown as typeof global.fetch;
		};

		const enableAutoSeed = (overrides: Partial<typeof globalConfig.sso.oidc> = {}) => {
			Object.assign(globalConfig.sso.oidc, {
				graphAutoSeedEnabled: true,
				graphScopes: 'https://graph.microsoft.com/Mail.ReadWrite',
				graphSeedFailOpen: true,
				...overrides,
			});
			// Default opt-in set used by tests that don't override the resolver repo.
			// Tests that need a different opt-in (empty, multiple ids, throw) override
			// `resolverRepository.find` after calling this helper.
			resolverRepository.find = jest.fn().mockResolvedValue([{ id: 'resolver-a' }]);
		};

		it('seeds the credential via OauthService.saveDynamicCredential and emits the captured event', async () => {
			enableAutoSeed();
			setupLoginMocks();
			const credential = mockResolvableCredential();
			credentialsRepository.find = jest.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			const user = await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(user).toBe(mockUser);
			expect(credentialsRepository.find).toHaveBeenCalledWith({
				where: { isResolvable: true, resolverId: expect.anything() },
				select: ['id', 'name', 'type', 'data', 'isResolvable', 'resolverId'],
			});
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			const [seededCredential, seededData, accessToken, resolverId, metadata] =
				(oauthService.saveDynamicCredential as jest.Mock).mock.calls[0];
			expect(seededCredential).toBe(credential);
			expect(seededData).toEqual({
				oauthTokenData: {
					access_token: 'graph-access-token',
					refresh_token: 'graph-refresh-token',
					token_type: 'Bearer',
					expires_in: 3599,
				},
			});
			expect(accessToken).toBe('graph-access-token');
			expect(resolverId).toBe('resolver-a');
			expect(metadata).toMatchObject({ source: 'oidc-self-seed', userId: 'user-id' });

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-captured', {
				userId: 'user-id',
				resolverId: 'resolver-a',
				credentialId: 'cred-1',
				credentialType: 'microsoftOAuth2Api',
			});
		});

		it('does nothing when graphAutoSeedEnabled is false (default — upstream parity)', async () => {
			setupLoginMocks();
			oauthService.saveDynamicCredential = jest.fn();
			credentialsRepository.find = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(credentialsRepository.find).not.toHaveBeenCalled();
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
			expect(eventService.emit).not.toHaveBeenCalledWith(
				expect.stringMatching(/^oidc-graph-token-/),
				expect.anything(),
			);
		});

		it('emits oidc-graph-token-skipped with reason=no_refresh_token when OBO response omits the refresh token', async () => {
			// In the OBO model "no_refresh_token" means the IdP's OBO response
			// lacked one — typically because the n8n App Registration is missing
			// the `offline_access` delegated permission.
			enableAutoSeed();
			setupLoginMocks({}, { refresh_token: undefined });
			credentialsRepository.find = jest.fn();
			oauthService.saveDynamicCredential = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'no_refresh_token',
			});
			expect(credentialsRepository.find).not.toHaveBeenCalled();
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
		});

		it('emits oidc-graph-token-skipped with reason=no_user_access_token when OIDC response has no access_token', async () => {
			// Without a user access token there is no assertion to feed the OBO
			// exchange. Operator must enable provisioning or set a custom API
			// scope in N8N_SSO_SCOPES_NAME.
			enableAutoSeed();
			setupLoginMocks({ access_token: undefined });
			credentialsRepository.find = jest.fn();
			oauthService.saveDynamicCredential = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'no_user_access_token',
			});
			expect(global.fetch).not.toHaveBeenCalled();
			expect(credentialsRepository.find).not.toHaveBeenCalled();
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
		});

		it('exchanges the user access token via OBO and seeds the Graph-audience token', async () => {
			enableAutoSeed();
			setupLoginMocks();
			const credential = mockResolvableCredential();
			credentialsRepository.find = jest.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			// OBO POST shape: grant=jwt-bearer, assertion=user-api-access-token,
			// scope includes the configured Graph scopes + offline_access.
			expect(global.fetch).toHaveBeenCalledTimes(1);
			const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
			expect(fetchCall[0]).toBe(
				'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
			);
			const requestBody = new URLSearchParams(fetchCall[1].body as string);
			expect(requestBody.get('grant_type')).toBe(
				'urn:ietf:params:oauth:grant-type:jwt-bearer',
			);
			expect(requestBody.get('requested_token_use')).toBe('on_behalf_of');
			expect(requestBody.get('assertion')).toBe('user-api-access-token');
			expect(requestBody.get('scope')).toBe(
				'https://graph.microsoft.com/Mail.ReadWrite offline_access',
			);

			// The token persisted to the credential is the Graph token from the OBO
			// response — NOT the user-api-access-token captured at OIDC login.
			const [, seededData, accessToken] = (oauthService.saveDynamicCredential as jest.Mock)
				.mock.calls[0];
			expect(accessToken).toBe('graph-access-token');
			expect(seededData).toEqual({
				oauthTokenData: {
					access_token: 'graph-access-token',
					refresh_token: 'graph-refresh-token',
					token_type: 'Bearer',
					expires_in: 3599,
				},
			});
		});

		it('defaults the OBO scope to https://graph.microsoft.com/.default when graphScopes is empty', async () => {
			enableAutoSeed({ graphScopes: '' });
			setupLoginMocks();
			credentialsRepository.find = jest
				.fn()
				.mockResolvedValue([mockResolvableCredential()]);
			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
			const requestBody = new URLSearchParams(fetchCall[1].body as string);
			expect(requestBody.get('scope')).toBe(
				'https://graph.microsoft.com/.default offline_access',
			);
		});

		it('emits obo_exchange_failed when the IdP returns a non-2xx OBO response (fail-open)', async () => {
			enableAutoSeed({ graphSeedFailOpen: true });
			setupLoginMocks();
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({
					error: 'invalid_grant',
					error_description: 'AADSTS50013: Assertion failed signature validation.',
				}),
			}) as unknown as typeof global.fetch;
			credentialsRepository.find = jest.fn();
			oauthService.saveDynamicCredential = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			const user = await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(user).toBe(mockUser);
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
			expect(credentialsRepository.find).not.toHaveBeenCalled();
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
		});

		it('emits obo_exchange_failed on network errors during the OBO POST (fail-open)', async () => {
			enableAutoSeed({ graphSeedFailOpen: true });
			setupLoginMocks();
			global.fetch = jest
				.fn()
				.mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof global.fetch;
			credentialsRepository.find = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
			expect(credentialsRepository.find).not.toHaveBeenCalled();
		});

		it('throws and blocks login when OBO fails and graphSeedFailOpen=false', async () => {
			enableAutoSeed({ graphSeedFailOpen: false });
			setupLoginMocks();
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 401,
				json: async () => ({ error: 'invalid_client' }),
			}) as unknown as typeof global.fetch;

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await expect(
				oidcService.loginUser(callbackUrl, storedState, storedNonce),
			).rejects.toThrow(/OBO exchange failed/);

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'obo_exchange_failed',
			});
		});

		it('emits oidc-graph-token-skipped with reason=no_resolvers_configured when no resolvers are opted in', async () => {
			enableAutoSeed();
			resolverRepository.find = jest.fn().mockResolvedValue([]);
			setupLoginMocks();
			credentialsRepository.find = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'no_resolvers_configured',
			});
			expect(credentialsRepository.find).not.toHaveBeenCalled();
		});

		it('iterates over every opted-in resolver and seeds matching credentials', async () => {
			enableAutoSeed();
			resolverRepository.find = jest
				.fn()
				.mockResolvedValue([{ id: 'resolver-a' }, { id: 'resolver-b' }]);
			setupLoginMocks();
			const credA = mockResolvableCredential({ id: 'cred-a', resolverId: 'resolver-a' });
			const credB = mockResolvableCredential({
				id: 'cred-b',
				resolverId: 'resolver-b',
				type: 'microsoftOutlookOAuth2Api',
			});
			credentialsRepository.find = jest.fn().mockResolvedValue([credA, credB]);
			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(2);
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-captured',
				expect.objectContaining({ credentialId: 'cred-a', resolverId: 'resolver-a' }),
			);
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-captured',
				expect.objectContaining({
					credentialId: 'cred-b',
					resolverId: 'resolver-b',
					credentialType: 'microsoftOutlookOAuth2Api',
				}),
			);
		});

		it('fails open: continues login when a per-credential seed fails and emits oidc-graph-token-seed-failed', async () => {
			enableAutoSeed({ graphSeedFailOpen: true });
			setupLoginMocks();
			const failing = mockResolvableCredential({ id: 'cred-fail' });
			const succeeding = mockResolvableCredential({ id: 'cred-ok' });
			credentialsRepository.find = jest.fn().mockResolvedValue([failing, succeeding]);
			oauthService.saveDynamicCredential = jest
				.fn()
				.mockRejectedValueOnce(new Error('resolver introspection unavailable'))
				.mockResolvedValueOnce(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			const user = await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(user).toBe(mockUser);
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(2);
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-seed-failed', {
				userId: 'user-id',
				resolverId: 'resolver-a',
				credentialId: 'cred-fail',
				errorMessage: 'resolver introspection unavailable',
			});
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-captured',
				expect.objectContaining({ credentialId: 'cred-ok' }),
			);
		});

		it('fails closed: re-throws and blocks login when graphSeedFailOpen=false', async () => {
			enableAutoSeed({ graphSeedFailOpen: false });
			setupLoginMocks();
			credentialsRepository.find = jest
				.fn()
				.mockResolvedValue([mockResolvableCredential({ id: 'cred-fail' })]);
			oauthService.saveDynamicCredential = jest
				.fn()
				.mockRejectedValue(new Error('storage unavailable'));

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await expect(
				oidcService.loginUser(callbackUrl, storedState, storedNonce),
			).rejects.toThrow('storage unavailable');

			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-seed-failed',
				expect.objectContaining({ credentialId: 'cred-fail' }),
			);
		});

		it('does not seed in the test login callback (test flow must be side-effect-free)', async () => {
			enableAutoSeed();
			oidcService.verifyState = jest.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = jest.fn().mockReturnValue('valid-nonce');
			oidcService.loadConfig = jest.fn().mockResolvedValue({
				clientId: 'cid',
				clientSecret: 'sec',
				discoveryEndpoint: new URL('https://idp.example.com/.well-known/openid_configuration'),
				prompt: 'select_account',
				authenticationContextClassReference: [],
				loginEnabled: true,
			});
			// @ts-expect-error - createProxyAwareConfiguration is private
			oidcService.createProxyAwareConfiguration = jest
				.fn()
				.mockResolvedValue({} as client.Configuration);
			jest.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'graph-access-token',
				refresh_token: 'graph-refresh-token',
				token_type: 'bearer',
				claims: () => ({ sub: 'valid-subject' }),
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			jest
				.spyOn(client, 'fetchUserInfo')
				.mockResolvedValue({ email_verified: true, email: 'john.doe@test.com' } as any);
			oauthService.saveDynamicCredential = jest.fn();
			credentialsRepository.find = jest.fn();

			const storedState = oidcService.generateState(true).signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.processTestCallback(callbackUrl, storedState, storedNonce);

			expect(credentialsRepository.find).not.toHaveBeenCalled();
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
			expect(eventService.emit).not.toHaveBeenCalledWith(
				expect.stringMatching(/^oidc-graph-token-/),
				expect.anything(),
			);
		});

		it('does NOT append Graph scopes to the authorization URL — upstream parity (OBO is server-side)', async () => {
			// Critical: mixing Graph /.default with the n8n provisioning /.default
			// triggers AADSTS70011 ("static scope limit exceeded"). The OBO design
			// avoids this entirely by keeping the user-facing /authorize call
			// byte-identical to upstream and exchanging for the Graph token
			// server-side after the callback.
			enableAutoSeed({ graphScopes: 'https://graph.microsoft.com/Mail.ReadWrite' });
			provisioningService.getConfig = jest.fn().mockResolvedValue({
				scopesProvisionInstanceRole: false,
				scopesProvisionProjectRoles: false,
				scopesName: 'n8n',
			});

			const buildAuthorizationUrlSpy = jest
				.spyOn(client, 'buildAuthorizationUrl')
				.mockReturnValue(new URL('https://idp.example.com/authorize'));
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);

			await oidcService.generateLoginUrl();

			expect(buildAuthorizationUrlSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ scope: 'openid email profile' }),
			);
		});

		it('preserves the upstream provisioning-scope path when provisioning is enabled', async () => {
			enableAutoSeed();
			provisioningService.getConfig = jest.fn().mockResolvedValue({
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: false,
				scopesName: 'api://390f995b-ed37-46e6-ae8c-7b11248dd67c/.default',
			});

			const buildAuthorizationUrlSpy = jest
				.spyOn(client, 'buildAuthorizationUrl')
				.mockReturnValue(new URL('https://idp.example.com/authorize'));
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = jest.fn().mockResolvedValue({} as client.Configuration);

			await oidcService.generateLoginUrl();

			expect(buildAuthorizationUrlSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					scope:
						'openid email profile api://390f995b-ed37-46e6-ae8c-7b11248dd67c/.default',
				}),
			);
		});

		it('seeds via DB-discovered resolvers (oidcSeedSource=oidc)', async () => {
			// The admin opted-in the resolver via the UI; `DynamicCredentialResolver`
			// is the single source of truth for seed-eligible resolvers.
			enableAutoSeed();
			setupLoginMocks();

			resolverRepository.find = jest
				.fn()
				.mockResolvedValue([{ id: 'resolver-from-db' }]);
			const credential = mockResolvableCredential({ resolverId: 'resolver-from-db' });
			credentialsRepository.find = jest.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(resolverRepository.find).toHaveBeenCalledWith({
				where: { oidcSeedSource: 'oidc' },
				select: ['id'],
			});
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-captured',
				expect.objectContaining({ resolverId: 'resolver-from-db' }),
			);
		});

		it('skips with no_resolvers_configured (fail-open) when the resolver repository query throws', async () => {
			// A transient DB failure on the resolver table must not block OIDC login.
			// The seeder logs a warn and bails with no_resolvers_configured.
			enableAutoSeed();
			setupLoginMocks();

			resolverRepository.find = jest
				.fn()
				.mockRejectedValue(new Error('resolver table unavailable'));
			credentialsRepository.find = jest.fn();
			oauthService.saveDynamicCredential = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('failed to query opted-in resolvers'),
				expect.objectContaining({ userId: 'user-id' }),
			);
			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'no_resolvers_configured',
			});
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
		});

		it('emits no_resolvers_configured when the DB returns an empty opt-in set', async () => {
			enableAutoSeed();
			setupLoginMocks();
			resolverRepository.find = jest.fn().mockResolvedValue([]);
			credentialsRepository.find = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(eventService.emit).toHaveBeenCalledWith('oidc-graph-token-skipped', {
				userId: 'user-id',
				reason: 'no_resolvers_configured',
			});
			expect(credentialsRepository.find).not.toHaveBeenCalled();
		});

		// ---- Workflow-level resolver binding discovery (fork §10 v4) ----

		const mockWorkflow = (
			id: string,
			credentialResolverId: string | undefined,
			credentialIds: Array<{ type: string; id: string }>,
		): WorkflowEntity =>
			({
				id,
				settings: credentialResolverId ? { credentialResolverId } : undefined,
				nodes: [
					{
						id: `node-in-${id}`,
						name: 'Some Node',
						type: 'n8n-nodes-base.microsoftOutlook',
						typeVersion: 1,
						position: [0, 0],
						parameters: {},
						credentials: credentialIds.reduce(
							(acc, { type, id: credId }) => {
								acc[type] = { id: credId, name: 'whatever' };
								return acc;
							},
							{} as Record<string, { id: string; name: string }>,
						),
					},
				],
			}) as unknown as WorkflowEntity;

		it('discovers credentials via workflow-level binding (settings.credentialResolverId)', async () => {
			// Credential has resolverId=NULL (the common case via the standard UI),
			// but a workflow that references it has settings.credentialResolverId
			// pointing at an opted-in resolver. The seed should still fire.
			enableAutoSeed();
			resolverRepository.find = jest
				.fn()
				.mockResolvedValue([{ id: 'resolver-from-workflow' }]);
			setupLoginMocks();

			// First find call → credential-level (resolverId=NULL → empty).
			// Second find call → workflow-discovered ids.
			const credential = mockResolvableCredential({
				id: 'cred-no-resolverid',
				resolverId: null as unknown as string,
			});
			credentialsRepository.find = jest
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([credential]);

			workflowRepository.find = jest
				.fn()
				.mockResolvedValue([
					mockWorkflow('wf-1', 'resolver-from-workflow', [
						{ type: 'microsoftOutlookOAuth2Api', id: 'cred-no-resolverid' },
					]),
				]);

			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			// The workflow's resolverId is the one passed to saveDynamicCredential,
			// not the credential's (null) resolverId.
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			const [, , , resolverIdArg] = (oauthService.saveDynamicCredential as jest.Mock)
				.mock.calls[0];
			expect(resolverIdArg).toBe('resolver-from-workflow');
			expect(eventService.emit).toHaveBeenCalledWith(
				'oidc-graph-token-captured',
				expect.objectContaining({
					credentialId: 'cred-no-resolverid',
					resolverId: 'resolver-from-workflow',
				}),
			);
		});

		it('ignores workflows whose credentialResolverId is not in the opted-in set', async () => {
			enableAutoSeed();
			resolverRepository.find = jest
				.fn()
				.mockResolvedValue([{ id: 'opted-in-resolver' }]);
			setupLoginMocks();
			credentialsRepository.find = jest.fn().mockResolvedValue([]);
			workflowRepository.find = jest
				.fn()
				.mockResolvedValue([
					// Workflow references a credential, but its resolverId is not opted-in.
					mockWorkflow('wf-other', 'unrelated-resolver', [
						{ type: 'slackOAuth2Api', id: 'cred-slack' },
					]),
				]);
			oauthService.saveDynamicCredential = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			// credentialsRepository.find is called once for the credential-level
			// query (which returns []); the workflow-level path adds nothing
			// because the only workflow references a non-opted-in resolver.
			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
			expect(eventService.emit).not.toHaveBeenCalledWith(
				'oidc-graph-token-captured',
				expect.anything(),
			);
		});

		it('credential-level binding takes precedence over workflow-level (no double-seed)', async () => {
			// Same credential is reachable via BOTH paths. It must be seeded
			// exactly once, with its credential-level resolverId — mirroring the
			// runtime precedence `credential.resolverId ?? workflow.settings.credentialResolverId`.
			enableAutoSeed();
			resolverRepository.find = jest
				.fn()
				.mockResolvedValue([{ id: 'resolver-cred' }, { id: 'resolver-wf' }]);
			setupLoginMocks();

			const credential = mockResolvableCredential({
				id: 'cred-dual',
				resolverId: 'resolver-cred',
			});
			// First find = credential-level (returns cred-dual).
			// Second find = workflow-level for remaining ids — should be skipped
			// because credentialsRepository.find should not be called again with
			// cred-dual's id (it's already covered).
			credentialsRepository.find = jest.fn().mockResolvedValueOnce([credential]);

			workflowRepository.find = jest
				.fn()
				.mockResolvedValue([
					mockWorkflow('wf-1', 'resolver-wf', [
						{ type: 'microsoftOutlookOAuth2Api', id: 'cred-dual' },
					]),
				]);

			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			const [, , , resolverIdArg] = (oauthService.saveDynamicCredential as jest.Mock)
				.mock.calls[0];
			expect(resolverIdArg).toBe('resolver-cred');
			// Second credentialsRepository.find (for workflow-discovered ids) must
			// not be invoked because all workflow-discovered ids were already
			// covered by the credential-level query.
			expect(credentialsRepository.find).toHaveBeenCalledTimes(1);
		});

		it('skips workflows with no settings or no credentials block (defensive)', async () => {
			enableAutoSeed();
			resolverRepository.find = jest
				.fn()
				.mockResolvedValue([{ id: 'opted-in-resolver' }]);
			setupLoginMocks();
			credentialsRepository.find = jest.fn().mockResolvedValue([]);

			workflowRepository.find = jest.fn().mockResolvedValue([
				{ id: 'wf-no-settings', nodes: [] } as unknown as WorkflowEntity,
				{
					id: 'wf-nodeless',
					settings: { credentialResolverId: 'opted-in-resolver' },
					nodes: [],
				} as unknown as WorkflowEntity,
				{
					id: 'wf-credless-node',
					settings: { credentialResolverId: 'opted-in-resolver' },
					nodes: [
						{
							id: 'n',
							name: 'no creds',
							type: 'n8n-nodes-base.set',
							typeVersion: 1,
							position: [0, 0],
							parameters: {},
						},
					],
				} as unknown as WorkflowEntity,
			]);
			oauthService.saveDynamicCredential = jest.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
		});

		it('falls back to credential-level only when the workflow repo throws', async () => {
			// A transient outage on the workflow table must not block the
			// credential-level seed path.
			enableAutoSeed();
			resolverRepository.find = jest
				.fn()
				.mockResolvedValue([{ id: 'resolver-a' }]);
			setupLoginMocks();
			workflowRepository.find = jest
				.fn()
				.mockRejectedValue(new Error('workflow table down'));

			const credential = mockResolvableCredential({ resolverId: 'resolver-a' });
			credentialsRepository.find = jest.fn().mockResolvedValueOnce([credential]);
			oauthService.saveDynamicCredential = jest.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining(
					'failed to scan workflows for resolver bindings',
				),
				expect.objectContaining({ error: 'workflow table down' }),
			);
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
		});
	});
});

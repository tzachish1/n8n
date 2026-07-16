import type { Mock, Mocked } from 'vitest';
import type { OidcConfigDto } from '@n8n/api-types';
import type { Logger } from '@n8n/backend-common';
import type { HttpTransport, SsrfProtectionService } from '@n8n/backend-network';
import { OutboundHttp } from '@n8n/backend-network';
import { type LocalServer, startServer } from '@n8n/backend-network/testing';
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
import { mock } from 'vitest-mock-extended';
import type { Cipher, InstanceSettings } from 'n8n-core';
import * as client from 'openid-client';

vi.mock('openid-client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('openid-client')>();
	return {
		...actual,
		discovery: vi.fn(),
		authorizationCodeGrant: vi.fn(),
		fetchUserInfo: vi.fn(),
	};
});

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
	let outboundHttp: Mocked<OutboundHttp>;
	let customFetch: Mock;
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
		vi.resetAllMocks();
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
		// loginUser reads the provisioning config to extract the instance role claim
		provisioningService.getConfig = vi.fn().mockResolvedValue({
			scopesInstanceRoleClaimName: 'n8n_instance_role',
			scopesProjectsRolesClaimName: 'n8n_projects',
		});
		userRepository = mock<UserRepository>();
		authIdentityRepository = mock<AuthIdentityRepository>();
		customFetch = vi.fn();
		outboundHttp = mock<OutboundHttp>();
		outboundHttp.transport.mockReturnValue(
			mock<HttpTransport>({ asCustomFetch: () => customFetch }),
		);
		oauthService = mock<OauthService>();
		credentialsRepository = mock<CredentialsRepository>();
		eventService = mock<EventService>();
		resolverRepository = mock<DynamicCredentialResolverRepository>();
		resolverRepository.find = vi.fn().mockResolvedValue([]);
		workflowRepository = mock<WorkflowRepository>();
		workflowRepository.find = vi.fn().mockResolvedValue([]);
		graphTokenExchanger = new GraphTokenExchanger(globalConfig, eventService, logger);
		vi.spyOn(ssoHelpers, 'setCurrentAuthenticationMethod').mockImplementation(
			async () => await Promise.resolve(),
		);

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
			outboundHttp,
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
			settingsRepository.findByKey = vi.fn().mockResolvedValue(mockConfigFromDB);

			// Mock the discovery endpoint response
			global.fetch = vi.fn().mockResolvedValue({
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
			settingsRepository.findByKey = vi.fn().mockResolvedValue(null);

			await oidcService.reload();

			expect(logger.warn).toHaveBeenCalledWith(
				'OIDC configuration not found in database, ignoring reload message',
			);
		});

		it('should handle errors during reload', async () => {
			const error = new Error('Database error');
			settingsRepository.findByKey = vi.fn().mockRejectedValue(error);

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

			settingsRepository.findByKey = vi.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(configWithEmptyEndpoint),
				loadOnStartup: true,
			});

			const result = await oidcService.loadConfigurationFromDatabase();

			expect(result).toBeUndefined();
		});

		it('should handle invalid JSON in database', async () => {
			settingsRepository.findByKey = vi.fn().mockResolvedValue({
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
			settingsRepository.findByKey = vi.fn().mockResolvedValue({
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
				additionalScopes: '',
				rpInitiatedLogoutEnabled: false,
			});
		});

		it('should fill out optional authenticationContextClassReference parameter with default value', async () => {
			settingsRepository.findByKey = vi.fn().mockResolvedValue({
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
				additionalScopes: '',
				rpInitiatedLogoutEnabled: false,
			});
		});

		it('should decrypt client secret when requested', async () => {
			const encryptedSecret = 'encrypted-secret';
			const decryptedSecret = 'decrypted-secret';

			cipher.decryptV2 = vi.fn().mockResolvedValue(decryptedSecret);

			const configWithEncryptedSecret = {
				...mockOidcConfig,
				clientSecret: encryptedSecret,
			};

			settingsRepository.findByKey = vi.fn().mockResolvedValue({
				key: OIDC_PREFERENCES_DB_KEY,
				value: JSON.stringify(configWithEncryptedSecret),
				loadOnStartup: true,
			});

			global.fetch = vi.fn().mockResolvedValue({
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

			settingsRepository.findByKey = vi.fn().mockResolvedValue({
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

			settingsRepository.findByKey = vi.fn().mockResolvedValue({
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
			settingsRepository.findByKey = vi.fn().mockResolvedValue({
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
				additionalScopes: '',
				rpInitiatedLogoutEnabled: false,
			});
			expect(logger.warn).not.toHaveBeenCalled();
		});
	});

	describe('broadcastReloadOIDCConfigurationCommand', () => {
		const mockPublisher = { publishCommand: vi.fn() };
		beforeEach(() => {
			mockInstance(Publisher, mockPublisher);
		});

		it('should publish reload command in multi-main setup', async () => {
			(instanceSettings as any).isMultiMain = true;
			// Trigger broadcast by updating config
			settingsRepository.save = vi.fn().mockResolvedValue(mockConfigFromDB);
			settingsRepository.findByKey = vi.fn().mockResolvedValue(mockConfigFromDB);
			vi.mocked(client.discovery).mockResolvedValue({} as client.Configuration);

			await oidcService.updateConfig(mockOidcConfig as any as OidcConfigDto);

			// In multi-main setup, should attempt to publish
			expect(mockPublisher.publishCommand).toHaveBeenCalledWith({
				command: 'reload-oidc-config',
			});
		});

		it('should persist emailVerifiedRequired through updateConfig', async () => {
			settingsRepository.save = vi.fn().mockResolvedValue(mockConfigFromDB);
			settingsRepository.findByKey = vi.fn().mockResolvedValue(mockConfigFromDB);
			vi.mocked(client.discovery).mockResolvedValue({} as client.Configuration);

			await oidcService.updateConfig({
				...mockOidcConfig,
				emailVerifiedRequired: true,
			} as any as OidcConfigDto);

			expect(settingsRepository.save).toHaveBeenCalledWith(
				expect.objectContaining({
					key: OIDC_PREFERENCES_DB_KEY,
					value: expect.stringContaining('"emailVerifiedRequired":true'),
				}),
			);
		});

		it('should not publish in single main setup', async () => {
			(instanceSettings as any).isMultiMain = false;

			settingsRepository.update = vi.fn().mockResolvedValue(mockConfigFromDB);
			settingsRepository.findByKey = vi.fn().mockResolvedValue(mockConfigFromDB);
			vi.mocked(client.discovery).mockResolvedValue({} as client.Configuration);

			await oidcService.updateConfig(mockOidcConfig as any as OidcConfigDto);

			// Should not attempt to import Publisher in single main setup
			expect(mockPublisher.publishCommand).not.toHaveBeenCalled();
		});
	});

	describe('loginUser', () => {
		it('throws an error if authorizationCodeGrant throws an error', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			vi.spyOn(client, 'authorizationCodeGrant').mockRejectedValue(
				new Error('Authorization code grant failed'),
			);

			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Invalid authorization code');
		});

		it('logs token-exchange errors with structured oauth fields', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);

			const tokenError = Object.assign(
				new Error('expected expires_in to be a non-negative number'),
				{
					error: 'invalid_token_response',
					error_description: 'expires_in was zero',
					code: 'OAUTH_INVALID_RESPONSE_BODY',
				},
			);
			vi.mocked(client.authorizationCodeGrant).mockRejectedValue(tokenError);

			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			await expect(oidcService.loginUser(callbackUrl, storedState, storedNonce)).rejects.toThrow(
				'Invalid authorization code',
			);

			expect(logger.error).toHaveBeenCalledWith(
				'Failed to exchange authorization code for tokens',
				expect.objectContaining({
					oauthError: 'invalid_token_response',
					oauthErrorDescription: 'expires_in was zero',
					code: 'OAUTH_INVALID_RESPONSE_BODY',
					message: 'expected expires_in to be a non-negative number',
				}),
			);
		});

		it('throws an error if claims() throws an error', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
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
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
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
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.mocked(client.fetchUserInfo).mockRejectedValue(new Error('Fetch user info failed'));
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Invalid token');
		});

		it('throws an error if there is no email', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.mocked(client.fetchUserInfo).mockResolvedValue({ email_verified: true } as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('An email is required');
		});

		it('throws an error if the email is invalid', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.spyOn(client, 'fetchUserInfo').mockResolvedValue({
				email_verified: true,
				email: 'invalid-email',
			} as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const promise = oidcService.loginUser(callbackUrl, storedState, storedNonce);
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Invalid email format');
		});

		it('should return the user if the auth identity already exists', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			oidcService.applySsoProvisioning = vi.fn().mockResolvedValue(undefined);
			authIdentityRepository.findOne = vi
				.fn()
				.mockResolvedValue({ user: { email: 'john.doe@test.com' } as any });

			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.spyOn(client, 'fetchUserInfo').mockResolvedValue({
				email_verified: true,
				email: 'john.doe@test.com',
			} as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const { user } = await oidcService.loginUser(callbackUrl, storedState, storedNonce);
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
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			oidcService.applySsoProvisioning = vi.fn().mockResolvedValue(undefined);
			userRepository.findOne = vi.fn().mockResolvedValue({ email: 'john.doe@test.com' } as any);

			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.spyOn(client, 'fetchUserInfo').mockResolvedValue({
				email_verified: true,
				email: 'john.doe@test.com',
			} as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const { user } = await oidcService.loginUser(callbackUrl, storedState, storedNonce);
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
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
			oidcService.applySsoProvisioning = vi.fn().mockResolvedValue(undefined);
			userRepository.manager.transaction = vi
				.fn()
				.mockResolvedValue({ email: 'john.doe@test.com' } as any);

			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.spyOn(client, 'fetchUserInfo').mockResolvedValue({
				email_verified: true,
				email: 'john.doe@test.com',
			} as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			const { user } = await oidcService.loginUser(callbackUrl, storedState, storedNonce);
			expect(user).toBeDefined();
			expect(user.email).toEqual('john.doe@test.com');
		});

		it('should deny the login without creating an account when role mapping blocks access', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			provisioningService.assertSsoLoginAllowed = vi
				.fn()
				.mockRejectedValue(new ForbiddenError('Access denied by SSO role mapping configuration'));
			authIdentityRepository.findOne = vi.fn().mockResolvedValue(null);
			userRepository.findOne = vi.fn().mockResolvedValue(null);
			userRepository.manager.transaction = vi.fn();

			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject', n8n_instance_role: 'global:unknown' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.spyOn(client, 'fetchUserInfo').mockResolvedValue({
				email_verified: true,
				email: 'john.doe@test.com',
			} as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			await expect(oidcService.loginUser(callbackUrl, storedState, storedNonce)).rejects.toThrow(
				ForbiddenError,
			);

			expect(provisioningService.assertSsoLoginAllowed).toHaveBeenCalledWith(
				expect.objectContaining({ $provider: 'oidc' }),
				'global:unknown',
			);
			// No account creation, no provisioning
			expect(userRepository.manager.transaction).not.toHaveBeenCalled();
			expect(provisioningService.provisionInstanceRoleForUser).not.toHaveBeenCalled();
		});

		it('should deny an existing user without touching their account when role mapping blocks access', async () => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			provisioningService.assertSsoLoginAllowed = vi
				.fn()
				.mockRejectedValue(new ForbiddenError('Access denied by SSO role mapping configuration'));
			authIdentityRepository.findOne = vi
				.fn()
				.mockResolvedValue({ user: { email: 'john.doe@test.com' } as any });

			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => {
					return { sub: 'valid-subject' };
				},
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.spyOn(client, 'fetchUserInfo').mockResolvedValue({
				email_verified: true,
				email: 'john.doe@test.com',
			} as any);
			const callbackUrl = new URL('https://example.com/callback');
			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;

			await expect(oidcService.loginUser(callbackUrl, storedState, storedNonce)).rejects.toThrow(
				ForbiddenError,
			);

			// The account is left untouched — no role changes, no deactivation
			expect(provisioningService.provisionInstanceRoleForUser).not.toHaveBeenCalled();
			expect(provisioningService.provisionExpressionMappedRolesForUser).not.toHaveBeenCalled();
			expect(userRepository.save).not.toHaveBeenCalled();
		});
	});

	describe('applySsoProvisioning', () => {
		const claims = { sub: 'user-123', n8n_instance_role: 'global:member' };
		const userInfo = { email: 'test@example.com', email_verified: true };
		const user = mock<User>({ id: 'user-id' });

		beforeEach(() => {
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'valid-access-token',
				token_type: 'bearer',
				claims: () => claims,
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi.mocked(client.fetchUserInfo).mockResolvedValue(userInfo as any);
		});

		it('calls provisionExpressionMappedRolesForUser when expression mapping is enabled', async () => {
			provisioningService.isExpressionMappingEnabled = vi.fn().mockResolvedValue(true);
			provisioningService.provisionExpressionMappedRolesForUser = vi
				.fn()
				.mockResolvedValue(undefined);
			authIdentityRepository.findOne = vi.fn().mockResolvedValue({ user });

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
			provisioningService.isExpressionMappingEnabled = vi.fn().mockResolvedValue(false);
			provisioningService.getConfig = vi.fn().mockResolvedValue({
				scopesInstanceRoleClaimName: 'n8n_instance_role',
				scopesProjectsRolesClaimName: 'n8n_projects',
			});
			provisioningService.provisionInstanceRoleForUser = vi.fn().mockResolvedValue(undefined);
			authIdentityRepository.findOne = vi.fn().mockResolvedValue({ user });

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
				provisioningService.isExpressionMappingEnabled = vi.fn().mockResolvedValue(false);
				provisioningService.getConfig = vi.fn().mockResolvedValue({
					scopesInstanceRoleClaimName: 'roles',
					scopesProjectsRolesClaimName: 'n8n_projects',
					scopesProvisionInstanceRole: true,
					scopesProvisionProjectRoles: false,
				});
				provisioningService.provisionInstanceRoleForUser = vi.fn().mockResolvedValue(undefined);
				authIdentityRepository.findOne = vi.fn().mockResolvedValue({ user });
			});

			it('uses access-token claims when ID token has no roles claim', async () => {
				const idTokenClaimsNoRoles = { sub: 'user-123' };
				const accessTokenJwt = buildJwt({ sub: 'user-123', roles: ['global:admin'] });
				vi.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
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
				vi.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
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
				vi.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
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
				vi.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
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
				provisioningService.getConfig = vi.fn().mockResolvedValue({
					scopesInstanceRoleClaimName: 'roles',
					scopesProjectsRolesClaimName: 'n8n_projects',
					scopesProvisionInstanceRole: false,
					scopesProvisionProjectRoles: true,
				});
				provisioningService.provisionProjectRolesForUser = vi.fn().mockResolvedValue(undefined);

				const idTokenClaimsNoProjects = { sub: 'user-123' };
				const accessTokenJwt = buildJwt({
					sub: 'user-123',
					n8n_projects: ['proj-1:editor'],
				});
				vi.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
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

	describe('createProxyAwareConfiguration', () => {
		const discoveryUrl = new URL('https://example.com/.well-known/openid-configuration');
		const clientId = 'test-client';
		const clientSecret = 'test-secret';

		const createConfiguration = async () =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
			(await (oidcService as any).createProxyAwareConfiguration(
				discoveryUrl,
				clientId,
				clientSecret,
			)) as client.Configuration;

		it("obtains the custom fetch from the factory transport with SSRF 'disabled'", async () => {
			vi.mocked(client.discovery).mockResolvedValue({} as client.Configuration);

			await createConfiguration();

			// The discovery / token / userinfo endpoints are admin-configured and may
			// legitimately point at an internal IdP, so SSRF protection is disabled.
			expect(outboundHttp.transport).toHaveBeenCalledWith({ ssrf: 'disabled' });
		});

		it('always calls discovery with the factory customFetch (no proxy/no-proxy branch)', async () => {
			const discoverySpy = vi
				.spyOn(client, 'discovery')
				.mockResolvedValue({} as client.Configuration);

			await createConfiguration();

			expect(discoverySpy).toHaveBeenCalledWith(
				discoveryUrl,
				clientId,
				clientSecret,
				undefined,
				expect.objectContaining({
					[client.customFetch]: customFetch,
				}),
			);
		});

		it('sets the factory customFetch on the returned configuration', async () => {
			vi.mocked(client.discovery).mockResolvedValue({} as client.Configuration);

			const result = await createConfiguration();

			expect(result[client.customFetch]).toBe(customFetch);
		});
	});

	// Exercises the customFetch produced by a real OutboundHttp against a real
	// loopback server. openid-client drives discovery / token / userinfo through
	// this fetch, so proving it performs a genuine HTTP round-trip (the same job
	// the old hand-rolled proxyFetch did) validates the migrated behavior.
	describe('factory customFetch (real HTTP round-trip)', () => {
		let idpServer: LocalServer;
		let realOidcService: OidcService;

		beforeAll(async () => {
			idpServer = await startServer((req, res) => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true, path: req.url }));
			});
		});

		afterAll(async () => await idpServer.close());

		beforeEach(() => {
			idpServer.clear();
			const realOutboundHttp = new OutboundHttp(mock<SsrfProtectionService>(), logger);
			realOidcService = new OidcService(
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
				realOutboundHttp,
				oauthService,
				credentialsRepository,
				eventService,
				resolverRepository,
				workflowRepository,
				graphTokenExchanger,
			);
		});

		it('routes openid-client fetches through a real HTTP socket', async () => {
			let factoryFetch: client.CustomFetch | undefined;
			vi.spyOn(client, 'discovery').mockImplementation(
				async (_server, _clientId, _metadata, _auth, options) => {
					factoryFetch = options?.[client.customFetch];
					return {} as client.Configuration;
				},
			);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			await (realOidcService as any).createProxyAwareConfiguration(
				new URL('https://issuer.example.com/.well-known/openid-configuration'),
				'real-client',
				'real-secret',
			);

			expect(factoryFetch).toBeDefined();

			const response = await factoryFetch!(`${idpServer.url}/userinfo`, {
				method: 'GET',
				headers: {},
				body: null,
				redirect: 'manual',
			});
			const body = (await response.json()) as { ok: boolean; path: string };

			expect(idpServer.captured).toEqual(['/userinfo']);
			expect(body).toEqual({ ok: true, path: '/userinfo' });
		});
	});

	describe('generateEndSessionUrl', () => {
		const idToken = 'stored-id-token';

		const setRpInitiatedLogoutEnabled = (enabled: boolean) => {
			// Replace (not mutate) the runtime config so the shared default object
			// isn't polluted across tests. updateConfig would require live discovery.
			const service = oidcService as unknown as { oidcConfig: Record<string, unknown> };
			service.oidcConfig = { ...service.oidcConfig, rpInitiatedLogoutEnabled: enabled };
		};

		it('returns undefined and does not contact the provider when RP-initiated logout is disabled', async () => {
			setRpInitiatedLogoutEnabled(false);
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = vi.fn();

			const url = await oidcService.generateEndSessionUrl(idToken);

			expect(url).toBeUndefined();
			// @ts-expect-error - getOidcConfiguration is private
			expect(oidcService.getOidcConfiguration).not.toHaveBeenCalled();
		});

		it('returns undefined when the provider does not advertise an end_session_endpoint', async () => {
			setRpInitiatedLogoutEnabled(true);
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({
				serverMetadata: () => ({}),
			} as unknown as client.Configuration);

			const url = await oidcService.generateEndSessionUrl(idToken);

			expect(url).toBeUndefined();
		});

		it('builds the RP-initiated logout URL with the id_token_hint when enabled', async () => {
			setRpInitiatedLogoutEnabled(true);
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({
				serverMetadata: () => ({ end_session_endpoint: 'https://example.com/logout' }),
			} as unknown as client.Configuration);
			const expectedUrl = new URL('https://example.com/logout?id_token_hint=stored-id-token');
			const buildEndSessionUrl = vi
				.spyOn(client, 'buildEndSessionUrl')
				.mockReturnValue(expectedUrl);

			const url = await oidcService.generateEndSessionUrl(idToken);

			expect(url).toEqual(expectedUrl);
			expect(buildEndSessionUrl).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					id_token_hint: idToken,
					post_logout_redirect_uri: expect.stringMatching(/\/signin$/),
				}),
			);
		});
	});

	const mockAuthCallbackWith = (userInfo: Record<string, unknown>) => {
		oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
		oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
		// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
		oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);
		// @ts-expect-error - applySsoProvisioning is private and only accessible within class 'OidcService'
		oidcService.applySsoProvisioning = vi.fn().mockResolvedValue(undefined);
		vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
			access_token: 'valid-access-token',
			token_type: 'bearer',
			claims: () => ({ sub: 'valid-subject' }),
		} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
		vi.spyOn(client, 'fetchUserInfo').mockResolvedValue(userInfo as any);
	};

	const setEmailVerifiedRequired = () => {
		// Replace (not mutate) the config so the shared default constant is untouched.
		// @ts-expect-error - oidcConfig is private and only accessible within class 'OidcService'
		oidcService.oidcConfig = { ...oidcService.oidcConfig, emailVerifiedRequired: true };
	};

	const login = async () => {
		const callbackUrl = new URL('https://example.com/callback');
		return await oidcService.loginUser(
			callbackUrl,
			oidcService.generateState().signed,
			oidcService.generateNonce().signed,
		);
	};

	it('should reject linking to an existing user when email is not verified', async () => {
		mockAuthCallbackWith({ email_verified: false, email: 'john.doe@test.com' });
		userRepository.findOne = vi.fn().mockResolvedValue({ email: 'john.doe@test.com' } as any);

		await expect(login()).rejects.toThrow(BadRequestError);
		await expect(login()).rejects.toThrow('Email address is not verified by the identity provider');
		expect(authIdentityRepository.save).not.toHaveBeenCalled();
	});

	it('should reject when email_verified is the string "false" (no boolean coercion bypass)', async () => {
		mockAuthCallbackWith({ email_verified: 'false', email: 'john.doe@test.com' });
		userRepository.findOne = vi.fn().mockResolvedValue({ email: 'john.doe@test.com' } as any);

		await expect(login()).rejects.toThrow(BadRequestError);
		expect(authIdentityRepository.save).not.toHaveBeenCalled();
	});

	it('should link to an existing user when email_verified is absent (default, permissive)', async () => {
		mockAuthCallbackWith({ email: 'john.doe@test.com' });
		userRepository.findOne = vi
			.fn()
			.mockResolvedValue({ id: 'user-1', email: 'john.doe@test.com' } as any);

		const user = await login();

		expect(user.user.email).toEqual('john.doe@test.com');
		expect(authIdentityRepository.save).toHaveBeenCalled();
	});

	it('should reject when email_verified is absent and enforcement is enabled', async () => {
		setEmailVerifiedRequired();
		mockAuthCallbackWith({ email: 'john.doe@test.com' });
		userRepository.findOne = vi.fn().mockResolvedValue({ email: 'john.doe@test.com' } as any);

		await expect(login()).rejects.toThrow(BadRequestError);
		expect(authIdentityRepository.save).not.toHaveBeenCalled();
	});

	it('should link when email_verified is true and enforcement is enabled', async () => {
		setEmailVerifiedRequired();
		mockAuthCallbackWith({ email_verified: true, email: 'john.doe@test.com' });
		userRepository.findOne = vi
			.fn()
			.mockResolvedValue({ id: 'user-1', email: 'john.doe@test.com' } as any);

		const user = await login();

		expect(user.user.email).toEqual('john.doe@test.com');
		expect(authIdentityRepository.save).toHaveBeenCalled();
	});

	it('should not re-check email_verified for an already-linked identity', async () => {
		// Enforcement on + unverified email, but the identity is already bound by `sub`.
		setEmailVerifiedRequired();
		mockAuthCallbackWith({ email_verified: false, email: 'john.doe@test.com' });
		authIdentityRepository.findOne = vi
			.fn()
			.mockResolvedValue({ user: { email: 'john.doe@test.com' } } as any);

		const user = await login();

		expect(user.user.email).toEqual('john.doe@test.com');
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
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			// @ts-expect-error - getOidcConfiguration is private and only accessible within class 'OidcService'
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({
				serverMetadata: () => ({
					token_endpoint: 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
				}),
			} as unknown as client.Configuration);
			// @ts-expect-error - applySsoProvisioning is private
			oidcService.applySsoProvisioning = vi.fn().mockResolvedValue(undefined);
			authIdentityRepository.findOne = vi.fn().mockResolvedValue({ user: mockUser });

			vi.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				// `access_token` here carries `aud=api://<n8n-app>` in the real flow —
				// it's the assertion we feed into the OBO exchange.
				access_token: 'user-api-access-token',
				token_type: 'bearer',
				expires_in: 3599,
				claims: () => ({ sub: 'valid-subject' }),
				...tokenOverrides,
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi
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
			global.fetch = vi.fn().mockResolvedValue({
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
			resolverRepository.find = vi.fn().mockResolvedValue([{ id: 'resolver-a' }]);
		};

		it('seeds the credential via OauthService.saveDynamicCredential and emits the captured event', async () => {
			enableAutoSeed();
			setupLoginMocks();
			const credential = mockResolvableCredential();
			credentialsRepository.find = vi.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			const { user } = await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(user).toBe(mockUser);
			expect(credentialsRepository.find).toHaveBeenCalledWith({
				where: { isResolvable: true, resolverId: expect.anything() },
				select: ['id', 'name', 'type', 'data', 'isResolvable', 'resolverId'],
			});
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			const [seededCredential, seededData, accessToken, resolverId, metadata] =
				(oauthService.saveDynamicCredential as Mock).mock.calls[0];
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
			oauthService.saveDynamicCredential = vi.fn();
			credentialsRepository.find = vi.fn();

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
			credentialsRepository.find = vi.fn();
			oauthService.saveDynamicCredential = vi.fn();

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
			credentialsRepository.find = vi.fn();
			oauthService.saveDynamicCredential = vi.fn();

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
			credentialsRepository.find = vi.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			// OBO POST shape: grant=jwt-bearer, assertion=user-api-access-token,
			// scope includes the configured Graph scopes + offline_access.
			expect(global.fetch).toHaveBeenCalledTimes(1);
			const fetchCall = (global.fetch as Mock).mock.calls[0];
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
			const [, seededData, accessToken] = (oauthService.saveDynamicCredential as Mock)
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

		it('passes the n8n-audience access token (not the Graph token) for oauth2-jwt-claim resolvers', async () => {
			// `oauth2-jwt-claim` resolvers verify the inbound bearer locally
			// against the n8n-app JWKS/audience. Feeding them the OBO Graph
			// token fails with `bad_signature` because Graph-audience tokens
			// are not signed for the n8n-app key set; the seed never lands.
			// The fix: pass the original OIDC `tokens.access_token` (audience
			// `api://<n8n-app>`) so the resolver can verify it. The credential
			// body still stores the Graph token as `oauthTokenData.access_token`
			// — that is what workflow nodes use to call Graph APIs.
			enableAutoSeed();
			setupLoginMocks();
			const credential = mockResolvableCredential();
			credentialsRepository.find = vi.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			resolverRepository.findOneBy = vi
				.fn()
				.mockResolvedValue({ id: 'resolver-a', config: 'encrypted-config-blob' });
			(cipher.decryptV2 as Mock).mockResolvedValue(
				JSON.stringify({ validation: 'oauth2-jwt-claim' }),
			);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			const [, seededData, authHeader] = (oauthService.saveDynamicCredential as Mock).mock
				.calls[0];
			expect(authHeader).toBe('user-api-access-token');
			// Body still stores the Graph token — the picker only changes the
			// resolver-side identity argument, not the credential payload.
			expect(seededData).toEqual({
				oauthTokenData: {
					access_token: 'graph-access-token',
					refresh_token: 'graph-refresh-token',
					token_type: 'Bearer',
					expires_in: 3599,
				},
			});
		});

		it('keeps passing the OBO Graph token for non-jwt-claim resolvers (userinfo/introspection)', async () => {
			// Userinfo and introspection resolvers verify the bearer by calling
			// Microsoft (or whichever IdP); those endpoints expect a token they
			// issued for the resource (Graph-audience). Switching them to the
			// n8n-audience token would break validation, so the picker only
			// switches when validation is `oauth2-jwt-claim`.
			enableAutoSeed();
			setupLoginMocks();
			const credential = mockResolvableCredential();
			credentialsRepository.find = vi.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			resolverRepository.findOneBy = vi
				.fn()
				.mockResolvedValue({ id: 'resolver-a', config: 'encrypted-config-blob' });
			(cipher.decryptV2 as Mock).mockResolvedValue(
				JSON.stringify({ validation: 'oauth2-userinfo' }),
			);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			const [, , authHeader] = (oauthService.saveDynamicCredential as Mock).mock.calls[0];
			expect(authHeader).toBe('graph-access-token');
		});

		it('falls back to the OBO Graph token when the resolver config cannot be loaded or decrypted', async () => {
			// Picker is best-effort: a missing resolver row, decrypt error, or
			// malformed config must not block the seed. We log a warn and
			// preserve prior behavior (use the OBO Graph token).
			enableAutoSeed();
			setupLoginMocks();
			const credential = mockResolvableCredential();
			credentialsRepository.find = vi.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			resolverRepository.findOneBy = vi
				.fn()
				.mockRejectedValue(new Error('resolver table unavailable'));

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			const [, , authHeader] = (oauthService.saveDynamicCredential as Mock).mock.calls[0];
			expect(authHeader).toBe('graph-access-token');
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining(
					'OIDC Graph auto-seed: failed to load resolver config for token-audience selection',
				),
				expect.objectContaining({ resolverId: 'resolver-a' }),
			);
		});

		it('caches the resolver config per call to avoid re-decrypting for repeated resolverIds', async () => {
			// Two candidates pointing at the same resolverId must cause exactly
			// one DB lookup + one decrypt — keeps the picker O(unique resolvers)
			// rather than O(candidates) and avoids hammering the cipher proxy.
			enableAutoSeed();
			setupLoginMocks();
			const credentialA = mockResolvableCredential({ id: 'cred-a' });
			const credentialB = mockResolvableCredential({ id: 'cred-b' });
			credentialsRepository.find = vi.fn().mockResolvedValue([credentialA, credentialB]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			resolverRepository.findOneBy = vi
				.fn()
				.mockResolvedValue({ id: 'resolver-a', config: 'encrypted-config-blob' });
			(cipher.decryptV2 as Mock).mockResolvedValue(
				JSON.stringify({ validation: 'oauth2-jwt-claim' }),
			);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(2);
			expect(resolverRepository.findOneBy).toHaveBeenCalledTimes(1);
			expect(cipher.decryptV2).toHaveBeenCalledTimes(1);
		});

		it('defaults the OBO scope to https://graph.microsoft.com/.default when graphScopes is empty', async () => {
			enableAutoSeed({ graphScopes: '' });
			setupLoginMocks();
			credentialsRepository.find = vi
				.fn()
				.mockResolvedValue([mockResolvableCredential()]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			const fetchCall = (global.fetch as Mock).mock.calls[0];
			const requestBody = new URLSearchParams(fetchCall[1].body as string);
			expect(requestBody.get('scope')).toBe(
				'https://graph.microsoft.com/.default offline_access',
			);
		});

		it('emits obo_exchange_failed when the IdP returns a non-2xx OBO response (fail-open)', async () => {
			enableAutoSeed({ graphSeedFailOpen: true });
			setupLoginMocks();
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({
					error: 'invalid_grant',
					error_description: 'AADSTS50013: Assertion failed signature validation.',
				}),
			}) as unknown as typeof global.fetch;
			credentialsRepository.find = vi.fn();
			oauthService.saveDynamicCredential = vi.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			const { user } = await oidcService.loginUser(callbackUrl, storedState, storedNonce);

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
			global.fetch = vi
				.fn()
				.mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof global.fetch;
			credentialsRepository.find = vi.fn();

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
			global.fetch = vi.fn().mockResolvedValue({
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
			resolverRepository.find = vi.fn().mockResolvedValue([]);
			setupLoginMocks();
			credentialsRepository.find = vi.fn();

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
			resolverRepository.find = vi
				.fn()
				.mockResolvedValue([{ id: 'resolver-a' }, { id: 'resolver-b' }]);
			setupLoginMocks();
			const credA = mockResolvableCredential({ id: 'cred-a', resolverId: 'resolver-a' });
			const credB = mockResolvableCredential({
				id: 'cred-b',
				resolverId: 'resolver-b',
				type: 'microsoftOutlookOAuth2Api',
			});
			credentialsRepository.find = vi.fn().mockResolvedValue([credA, credB]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

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
			credentialsRepository.find = vi.fn().mockResolvedValue([failing, succeeding]);
			oauthService.saveDynamicCredential = vi
				.fn()
				.mockRejectedValueOnce(new Error('resolver introspection unavailable'))
				.mockResolvedValueOnce(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			const { user } = await oidcService.loginUser(callbackUrl, storedState, storedNonce);

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
			credentialsRepository.find = vi
				.fn()
				.mockResolvedValue([mockResolvableCredential({ id: 'cred-fail' })]);
			oauthService.saveDynamicCredential = vi
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
			oidcService.verifyState = vi.fn().mockReturnValue('valid-state');
			oidcService.verifyNonce = vi.fn().mockReturnValue('valid-nonce');
			oidcService.loadConfig = vi.fn().mockResolvedValue({
				clientId: 'cid',
				clientSecret: 'sec',
				discoveryEndpoint: new URL('https://idp.example.com/.well-known/openid_configuration'),
				prompt: 'select_account',
				authenticationContextClassReference: [],
				loginEnabled: true,
			});
			// @ts-expect-error - createProxyAwareConfiguration is private
			oidcService.createProxyAwareConfiguration = vi
				.fn()
				.mockResolvedValue({} as client.Configuration);
			vi.spyOn(client, 'authorizationCodeGrant').mockResolvedValue({
				access_token: 'graph-access-token',
				refresh_token: 'graph-refresh-token',
				token_type: 'bearer',
				claims: () => ({ sub: 'valid-subject' }),
			} as unknown as client.TokenEndpointResponse & client.TokenEndpointResponseHelpers);
			vi
				.spyOn(client, 'fetchUserInfo')
				.mockResolvedValue({ email_verified: true, email: 'john.doe@test.com' } as any);
			oauthService.saveDynamicCredential = vi.fn();
			credentialsRepository.find = vi.fn();

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
			provisioningService.getConfig = vi.fn().mockResolvedValue({
				scopesProvisionInstanceRole: false,
				scopesProvisionProjectRoles: false,
				scopesName: 'n8n',
			});

			const buildAuthorizationUrlSpy = vi
				.spyOn(client, 'buildAuthorizationUrl')
				.mockReturnValue(new URL('https://idp.example.com/authorize'));
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);

			await oidcService.generateLoginUrl();

			expect(buildAuthorizationUrlSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ scope: 'openid email profile' }),
			);
		});

		it('preserves the upstream provisioning-scope path when provisioning is enabled', async () => {
			enableAutoSeed();
			provisioningService.getConfig = vi.fn().mockResolvedValue({
				scopesProvisionInstanceRole: true,
				scopesProvisionProjectRoles: false,
				scopesName: 'api://390f995b-ed37-46e6-ae8c-7b11248dd67c/.default',
			});

			const buildAuthorizationUrlSpy = vi
				.spyOn(client, 'buildAuthorizationUrl')
				.mockReturnValue(new URL('https://idp.example.com/authorize'));
			// @ts-expect-error - getOidcConfiguration is private
			oidcService.getOidcConfiguration = vi.fn().mockResolvedValue({} as client.Configuration);

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

			resolverRepository.find = vi
				.fn()
				.mockResolvedValue([{ id: 'resolver-from-db' }]);
			const credential = mockResolvableCredential({ resolverId: 'resolver-from-db' });
			credentialsRepository.find = vi.fn().mockResolvedValue([credential]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

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

			resolverRepository.find = vi
				.fn()
				.mockRejectedValue(new Error('resolver table unavailable'));
			credentialsRepository.find = vi.fn();
			oauthService.saveDynamicCredential = vi.fn();

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
			resolverRepository.find = vi.fn().mockResolvedValue([]);
			credentialsRepository.find = vi.fn();

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
			resolverRepository.find = vi
				.fn()
				.mockResolvedValue([{ id: 'resolver-from-workflow' }]);
			setupLoginMocks();

			// First find call → credential-level (resolverId=NULL → empty).
			// Second find call → workflow-discovered ids.
			const credential = mockResolvableCredential({
				id: 'cred-no-resolverid',
				resolverId: null as unknown as string,
			});
			credentialsRepository.find = vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([credential]);

			workflowRepository.find = vi
				.fn()
				.mockResolvedValue([
					mockWorkflow('wf-1', 'resolver-from-workflow', [
						{ type: 'microsoftOutlookOAuth2Api', id: 'cred-no-resolverid' },
					]),
				]);

			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			// The workflow's resolverId is the one passed to saveDynamicCredential,
			// not the credential's (null) resolverId.
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			const [, , , resolverIdArg] = (oauthService.saveDynamicCredential as Mock)
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
			resolverRepository.find = vi
				.fn()
				.mockResolvedValue([{ id: 'opted-in-resolver' }]);
			setupLoginMocks();
			credentialsRepository.find = vi.fn().mockResolvedValue([]);
			workflowRepository.find = vi
				.fn()
				.mockResolvedValue([
					// Workflow references a credential, but its resolverId is not opted-in.
					mockWorkflow('wf-other', 'unrelated-resolver', [
						{ type: 'slackOAuth2Api', id: 'cred-slack' },
					]),
				]);
			oauthService.saveDynamicCredential = vi.fn();

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
			resolverRepository.find = vi
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
			credentialsRepository.find = vi.fn().mockResolvedValueOnce([credential]);

			workflowRepository.find = vi
				.fn()
				.mockResolvedValue([
					mockWorkflow('wf-1', 'resolver-wf', [
						{ type: 'microsoftOutlookOAuth2Api', id: 'cred-dual' },
					]),
				]);

			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			const [, , , resolverIdArg] = (oauthService.saveDynamicCredential as Mock)
				.mock.calls[0];
			expect(resolverIdArg).toBe('resolver-cred');
			// Second credentialsRepository.find (for workflow-discovered ids) must
			// not be invoked because all workflow-discovered ids were already
			// covered by the credential-level query.
			expect(credentialsRepository.find).toHaveBeenCalledTimes(1);
		});

		it('skips workflows with no settings or no credentials block (defensive)', async () => {
			enableAutoSeed();
			resolverRepository.find = vi
				.fn()
				.mockResolvedValue([{ id: 'opted-in-resolver' }]);
			setupLoginMocks();
			credentialsRepository.find = vi.fn().mockResolvedValue([]);

			workflowRepository.find = vi.fn().mockResolvedValue([
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
			oauthService.saveDynamicCredential = vi.fn();

			const storedState = oidcService.generateState().signed;
			const storedNonce = oidcService.generateNonce().signed;
			await oidcService.loginUser(callbackUrl, storedState, storedNonce);

			expect(oauthService.saveDynamicCredential).not.toHaveBeenCalled();
		});

		it('falls back to credential-level only when the workflow repo throws', async () => {
			// A transient outage on the workflow table must not block the
			// credential-level seed path.
			enableAutoSeed();
			resolverRepository.find = vi
				.fn()
				.mockResolvedValue([{ id: 'resolver-a' }]);
			setupLoginMocks();
			workflowRepository.find = vi
				.fn()
				.mockRejectedValue(new Error('workflow table down'));

			const credential = mockResolvableCredential({ resolverId: 'resolver-a' });
			credentialsRepository.find = vi.fn().mockResolvedValueOnce([credential]);
			oauthService.saveDynamicCredential = vi.fn().mockResolvedValue(undefined);

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

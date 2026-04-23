import { OidcConfigDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import {
	AuthIdentity,
	AuthIdentityRepository,
	isValidEmail,
	GLOBAL_MEMBER_ROLE,
	SettingsRepository,
	type User,
	UserRepository,
} from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';
import { randomUUID } from 'crypto';
import { Cipher, InstanceSettings } from 'n8n-core';
import { jsonParse, UserError } from 'n8n-workflow';
import type * as openidClientTypes from 'openid-client';
import { EnvHttpProxyAgent } from 'undici';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { buildOidcClaimsContext } from '@/modules/provisioning.ee/claims-context.builder';
import { ProvisioningService } from '@/modules/provisioning.ee/provisioning.service.ee';
import { JwtService } from '@/services/jwt.service';
import { UrlService } from '@/services/url.service';
import {
	getCurrentAuthenticationMethod,
	isEmailCurrentAuthenticationMethod,
	isOidcCurrentAuthenticationMethod,
	reloadAuthenticationMethod,
	setCurrentAuthenticationMethod,
} from '@/sso.ee/sso-helpers';

import { OIDC_CLIENT_SECRET_REDACTED_VALUE, OIDC_PREFERENCES_DB_KEY } from './constants';

const DEFAULT_OIDC_CONFIG: OidcConfigDto = {
	clientId: '',
	clientSecret: '',
	discoveryEndpoint: '',
	loginEnabled: false,
	prompt: 'select_account',
	authenticationContextClassReference: [],
};

type OidcRuntimeConfig = Pick<
	OidcConfigDto,
	'clientId' | 'clientSecret' | 'loginEnabled' | 'prompt' | 'authenticationContextClassReference'
> & {
	discoveryEndpoint: URL;
};

const DEFAULT_OIDC_RUNTIME_CONFIG: OidcRuntimeConfig = {
	...DEFAULT_OIDC_CONFIG,
	discoveryEndpoint: new URL('http://n8n.io/not-set'),
};

@Service()
export class OidcService {
	private oidcConfig: OidcRuntimeConfig = DEFAULT_OIDC_RUNTIME_CONFIG;

	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	private openidClient: typeof import('openid-client');

	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly urlService: UrlService,
		private readonly globalConfig: GlobalConfig,
		private readonly userRepository: UserRepository,
		private readonly cipher: Cipher,
		private readonly logger: Logger,
		private readonly jwtService: JwtService,
		private readonly instanceSettings: InstanceSettings,
		private readonly provisioningService: ProvisioningService,
	) {}

	async init() {
		this.oidcConfig = await this.loadConfig(true);
		this.logger.debug(`OIDC login is ${this.oidcConfig.loginEnabled ? 'enabled' : 'disabled'}.`);
		await this.setOidcLoginEnabled(this.oidcConfig.loginEnabled);
		if (this.oidcConfig.loginEnabled) {
			await this.loadOpenIdClient();
		}
	}

	private async loadOpenIdClient() {
		if (!this.openidClient) {
			this.openidClient = await import('openid-client');
		}
	}

	getCallbackUrl(): string {
		return `${this.urlService.getInstanceBaseUrl()}/${this.globalConfig.endpoints.rest}/sso/oidc/callback`;
	}

	getRedactedConfig(): OidcConfigDto {
		return {
			...this.oidcConfig,
			discoveryEndpoint: this.oidcConfig.discoveryEndpoint.toString(),
			clientSecret: OIDC_CLIENT_SECRET_REDACTED_VALUE,
		};
	}

	generateState(testMode = false) {
		const state = `n8n_state:${randomUUID()}`;
		const payload: Record<string, unknown> = { state };
		if (testMode) {
			payload.testMode = true;
		}
		return {
			signed: this.jwtService.sign(payload, { expiresIn: '15m' }),
			plaintext: state,
		};
	}

	verifyState(signedState: string): { state: string; testMode?: boolean } {
		let state: string;
		let testMode: boolean | undefined;
		try {
			const decodedState = this.jwtService.verify(signedState);
			state = decodedState?.state;
			testMode = decodedState?.testMode;
		} catch (error) {
			this.logger.error('Failed to verify state', { error });
			throw new BadRequestError('Invalid state');
		}

		if (typeof state !== 'string') {
			this.logger.error('Provided state has an invalid format');
			throw new BadRequestError('Invalid state');
		}

		const splitState = state.split(':');

		if (splitState.length !== 2 || splitState[0] !== 'n8n_state') {
			this.logger.error('Provided state is missing the well-known prefix');
			throw new BadRequestError('Invalid state');
		}

		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				splitState[1],
			)
		) {
			this.logger.error('Provided state is not formatted correctly');
			throw new BadRequestError('Invalid state');
		}
		return { state, testMode };
	}

	generateNonce() {
		const nonce = `n8n_nonce:${randomUUID()}`;
		return {
			signed: this.jwtService.sign({ nonce }, { expiresIn: '15m' }),
			plaintext: nonce,
		};
	}

	verifyNonce(signedNonce: string) {
		let nonce: string;
		try {
			const decodedNonce = this.jwtService.verify(signedNonce);
			nonce = decodedNonce?.nonce;
		} catch (error) {
			this.logger.error('Failed to verify nonce', { error });
			throw new BadRequestError('Invalid nonce');
		}

		if (typeof nonce !== 'string') {
			this.logger.error('Provided nonce has an invalid format');
			throw new BadRequestError('Invalid nonce');
		}

		const splitNonce = nonce.split(':');

		if (splitNonce.length !== 2 || splitNonce[0] !== 'n8n_nonce') {
			this.logger.error('Provided nonce is missing the well-known prefix');
			throw new BadRequestError('Invalid nonce');
		}

		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				splitNonce[1],
			)
		) {
			this.logger.error('Provided nonce is not formatted correctly');
			throw new BadRequestError('Invalid nonce');
		}
		return nonce;
	}

	async generateLoginUrl(): Promise<{ url: URL; state: string; nonce: string }> {
		await this.loadOpenIdClient();
		const configuration = await this.getOidcConfiguration();

		const state = this.generateState();
		const nonce = this.generateNonce();

		const prompt = this.oidcConfig.prompt;
		const authenticationContextClassReference = this.oidcConfig.authenticationContextClassReference;

		const provisioningConfig = await this.provisioningService.getConfig();
		const provisioningEnabled =
			provisioningConfig.scopesProvisionInstanceRole ||
			provisioningConfig.scopesProvisionProjectRoles;

		// Include the custom n8n scope if provisioning is enabled
		const scope = provisioningEnabled
			? `openid email profile ${provisioningConfig.scopesName}`
			: 'openid email profile';

		const authorizationURL = this.openidClient.buildAuthorizationUrl(configuration, {
			redirect_uri: this.getCallbackUrl(),
			response_type: 'code',
			scope,
			prompt,
			state: state.plaintext,
			nonce: nonce.plaintext,
			...(authenticationContextClassReference.length > 0 && {
				acr_values: authenticationContextClassReference.join(' '),
			}),
		});

		return { url: authorizationURL, state: state.signed, nonce: nonce.signed };
	}

	async loginUser(callbackUrl: URL, storedState: string, storedNonce: string): Promise<User> {
		await this.loadOpenIdClient();
		const configuration = await this.getOidcConfiguration();

		const { state: expectedState } = this.verifyState(storedState);
		const expectedNonce = this.verifyNonce(storedNonce);

		let tokens;
		try {
			tokens = await this.openidClient.authorizationCodeGrant(configuration, callbackUrl, {
				expectedState,
				expectedNonce,
			});
		} catch (error) {
			const e = error as {
				error?: string;
				error_description?: string;
				cause?: unknown;
				message?: string;
			};
			this.logger.error('Failed to exchange authorization code for tokens', {
				oauthError: e.error,
				oauthErrorDescription: e.error_description,
				cause: e.cause ? JSON.stringify(e.cause) : undefined,
				message: e.message,
			});
			throw new BadRequestError('Invalid authorization code');
		}

		let claims;
		try {
			claims = tokens.claims();
		} catch (error) {
			this.logger.error('Failed to extract claims from tokens', { error });
			throw new BadRequestError('Invalid token');
		}

		if (!claims) {
			throw new ForbiddenError('No claims found in the OIDC token');
		}

		// Per-login diagnostic of the raw ID-token shape, before any provisioning
		// logic runs. Only claim KEYS are logged - never values - so no PII leaks.
		// Used to reconcile reports of inconsistent role-claim presence across
		// logins (e.g. Azure Entra v1 tokens where `roles` is sometimes omitted
		// from the ID token but present in the access token).
		this.logger.debug('OIDC token claims fingerprint (loginUser)', {
			availableClaimKeys: Object.keys(claims),
			rolesClaimType:
				claims.roles === undefined
					? 'undefined'
					: Array.isArray(claims.roles)
						? `array[${claims.roles.length}]`
						: typeof claims.roles,
			groupsClaimType:
				claims.groups === undefined
					? 'undefined'
					: Array.isArray(claims.groups)
						? `array[${claims.groups.length}]`
						: typeof claims.groups,
			hasAccessToken: typeof tokens.access_token === 'string',
			accessTokenIsJwt:
				typeof tokens.access_token === 'string' && tokens.access_token.split('.').length === 3,
		});

		let userInfo;
		try {
			userInfo = await this.openidClient.fetchUserInfo(
				configuration,
				tokens.access_token,
				claims.sub,
			);
		} catch (error) {
			// Userinfo endpoint may fail when using custom API scopes (e.g., Azure AD with custom scopes)
			// In this case, fall back to using ID token claims which already contain user info
			this.logger.debug('Userinfo endpoint failed, falling back to ID token claims', {
				error: error instanceof Error ? error.message : String(error),
			});

			// Use claims from ID token as userInfo fallback
			// Azure AD and other providers include email, name, etc. in the ID token
			if (typeof claims.email === 'string') {
				userInfo = {
					sub: claims.sub,
					email: claims.email,
					name: typeof claims.name === 'string' ? claims.name : undefined,
					given_name: typeof claims.given_name === 'string' ? claims.given_name : undefined,
					family_name: typeof claims.family_name === 'string' ? claims.family_name : undefined,
					preferred_username:
						typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
				};
				this.logger.debug('Using ID token claims as user info', { email: userInfo.email });
			} else {
				this.logger.error('Failed to fetch user info and no email in ID token claims', { error });
				throw new BadRequestError('Invalid token - could not retrieve user info');
			}
		}

		if (!userInfo.email) {
			throw new BadRequestError('An email is required');
		}

		if (!isValidEmail(userInfo.email)) {
			throw new BadRequestError('Invalid email format');
		}

		const openidUser = await this.authIdentityRepository.findOne({
			where: { providerId: claims.sub, providerType: 'oidc' },
			relations: {
				user: {
					role: true,
				},
			},
		});

		if (openidUser) {
			await this.applySsoProvisioning(
				openidUser.user,
				claims as Record<string, unknown>,
				userInfo as Record<string, unknown>,
				tokens.access_token,
			);

			return openidUser.user;
		}

		const foundUser = await this.userRepository.findOne({
			where: { email: userInfo.email },
			relations: ['authIdentities', 'role'],
		});

		if (foundUser) {
			this.logger.debug(
				`OIDC login: User with email ${userInfo.email} already exists, linking OIDC identity.`,
			);
			// If the user already exists, we just add the OIDC identity to the user
			const id = this.authIdentityRepository.create({
				providerId: claims.sub,
				providerType: 'oidc',
				userId: foundUser.id,
			});

			await this.authIdentityRepository.save(id);
			await this.applySsoProvisioning(
				foundUser,
				claims as Record<string, unknown>,
				userInfo as Record<string, unknown>,
				tokens.access_token,
			);

			return foundUser;
		}

		const user = await this.userRepository.manager.transaction(async (trx) => {
			const { user: newUser } = await this.userRepository.createUserWithProject(
				{
					firstName: userInfo.given_name,
					lastName: userInfo.family_name,
					email: userInfo.email,
					authIdentities: [],
					role: GLOBAL_MEMBER_ROLE,
					password: 'no password set',
				},
				trx,
			);

			await trx.save(
				trx.create(AuthIdentity, {
					providerId: claims.sub,
					providerType: 'oidc',
					userId: newUser.id,
				}),
			);

			return newUser;
		});

		await this.applySsoProvisioning(
			user,
			claims as Record<string, unknown>,
			userInfo as Record<string, unknown>,
			tokens.access_token,
		);

		return user;
	}

	async generateTestLoginUrl(): Promise<{ url: URL; state: string; nonce: string }> {
		await this.loadOpenIdClient();
		const config = await this.loadConfig(true);

		const configuration = await this.createProxyAwareConfiguration(
			config.discoveryEndpoint,
			config.clientId,
			config.clientSecret,
		);

		const state = this.generateState(true);
		const nonce = this.generateNonce();

		const provisioningConfig = await this.provisioningService.getConfig();
		const provisioningEnabled =
			provisioningConfig.scopesProvisionInstanceRole ||
			provisioningConfig.scopesProvisionProjectRoles;

		const scope = provisioningEnabled
			? `openid email profile ${provisioningConfig.scopesName}`
			: 'openid email profile';

		const authorizationURL = this.openidClient.buildAuthorizationUrl(configuration, {
			redirect_uri: this.getCallbackUrl(),
			response_type: 'code',
			scope,
			prompt: config.prompt,
			state: state.plaintext,
			nonce: nonce.plaintext,
			...(config.authenticationContextClassReference.length > 0 && {
				acr_values: config.authenticationContextClassReference.join(' '),
			}),
		});

		return { url: authorizationURL, state: state.signed, nonce: nonce.signed };
	}

	async processTestCallback(
		callbackUrl: URL,
		storedState: string,
		storedNonce: string,
	): Promise<{ claims: Record<string, unknown>; userInfo: Record<string, unknown> }> {
		await this.loadOpenIdClient();
		const config = await this.loadConfig(true);

		const configuration = await this.createProxyAwareConfiguration(
			config.discoveryEndpoint,
			config.clientId,
			config.clientSecret,
		);

		const { state: expectedState } = this.verifyState(storedState);
		const expectedNonce = this.verifyNonce(storedNonce);

		let tokens;
		try {
			tokens = await this.openidClient.authorizationCodeGrant(configuration, callbackUrl, {
				expectedState,
				expectedNonce,
			});
		} catch (error) {
			const e = error as {
				error?: string;
				error_description?: string;
				cause?: unknown;
				message?: string;
			};
			this.logger.error('Failed to exchange authorization code for tokens', {
				oauthError: e.error,
				oauthErrorDescription: e.error_description,
				cause: e.cause ? JSON.stringify(e.cause) : undefined,
				message: e.message,
			});
			throw new BadRequestError('Invalid authorization code');
		}

		let claims;
		try {
			claims = tokens.claims();
		} catch (error) {
			this.logger.error('Failed to extract claims from tokens', { error });
			throw new BadRequestError('Invalid token');
		}

		if (!claims) {
			throw new ForbiddenError('No claims found in the OIDC token');
		}

		let userInfo;
		try {
			userInfo = await this.openidClient.fetchUserInfo(
				configuration,
				tokens.access_token,
				claims.sub,
			);
		} catch (error) {
			this.logger.error('Failed to fetch user info', { error });
			throw new BadRequestError('Invalid token');
		}

		return {
			claims: { ...claims },
			userInfo: { ...userInfo },
		};
	}

	private async applySsoProvisioning(
		user: User,
		claims: Record<string, unknown>,
		userInfo: Record<string, unknown>,
		accessToken?: string,
	) {
		if (await this.provisioningService.isExpressionMappingEnabled()) {
			const context = buildOidcClaimsContext(claims, userInfo);
			await this.provisioningService.provisionExpressionMappedRolesForUser(user, context);
			return;
		}

		const provisioningConfig = await this.provisioningService.getConfig();
		let projectRoleMapping = claims[provisioningConfig.scopesProjectsRolesClaimName];
		let instanceRole = this.resolveInstanceRoleClaim(
			claims,
			provisioningConfig.scopesInstanceRoleClaimName,
			user.id,
		);

		// Azure Entra v1-token edge case: when the App Registration uses a custom
		// API scope and `requestedAccessTokenVersion: null/1`, the `roles` claim is
		// emitted in the access token (resource-scoped JWT) but is intermittently
		// omitted from the ID token. If the ID token didn't yield a role claim,
		// peek at the access token's payload as a third-tier fallback. We do not
		// crypto-verify the access token here - openid-client already validated
		// the token bundle during the authorization code grant; we are only
		// re-reading a payload we already trust.
		const accessTokenClaims =
			(instanceRole === undefined || projectRoleMapping === undefined) && accessToken
				? this.decodeJwtPayloadUnsafe(accessToken)
				: undefined;

		if (accessTokenClaims) {
			if (instanceRole === undefined) {
				const fromAccessToken = this.resolveInstanceRoleClaim(
					accessTokenClaims,
					provisioningConfig.scopesInstanceRoleClaimName,
					user.id,
				);
				if (fromAccessToken !== undefined) {
					this.logger.warn(
						'OIDC provisioning: instance role claim was missing from ID token; ' +
							'falling back to access token claims. ' +
							'This usually means the App Registration is on Azure Entra v1 tokens ' +
							'(`requestedAccessTokenVersion: null`); set it to 2 or add `roles` ' +
							'as an Optional Claim for ID tokens to silence this fallback.',
						{ userId: user.id },
					);
					instanceRole = fromAccessToken;
				}
			}
			if (projectRoleMapping === undefined || projectRoleMapping === null) {
				const fromAccessToken = accessTokenClaims[provisioningConfig.scopesProjectsRolesClaimName];
				if (fromAccessToken !== undefined && fromAccessToken !== null) {
					this.logger.warn(
						'OIDC provisioning: project role claim was missing from ID token; ' +
							'falling back to access token claims.',
						{ userId: user.id },
					);
					projectRoleMapping = fromAccessToken;
				}
			}
		}

		// Emit a single diagnostic log per login so operators can verify that the
		// claim names configured in n8n actually match what the IdP is sending.
		// Only keys are logged - never claim values - to avoid leaking PII.
		this.logger.info('OIDC provisioning lookup', {
			userId: user.id,
			userEmail: user.email,
			provisionInstanceRole: provisioningConfig.scopesProvisionInstanceRole,
			provisionProjectRoles: provisioningConfig.scopesProvisionProjectRoles,
			instanceRoleClaimName: provisioningConfig.scopesInstanceRoleClaimName,
			projectsRolesClaimName: provisioningConfig.scopesProjectsRolesClaimName,
			instanceRoleClaimPresent: instanceRole !== undefined && instanceRole !== null,
			projectsRolesClaimPresent: projectRoleMapping !== undefined && projectRoleMapping !== null,
			availableClaimKeys: Object.keys(claims),
			availableUserInfoKeys: Object.keys(userInfo),
			accessTokenClaimsConsulted: accessTokenClaims !== undefined,
		});

		// Always call provisioning methods, even with empty/undefined claims
		// This allows the provisioning service to handle role removal when roles are revoked in the IdP
		if (provisioningConfig.scopesProvisionInstanceRole) {
			await this.provisioningService.provisionInstanceRoleForUser(user, instanceRole);
		}
		if (provisioningConfig.scopesProvisionProjectRoles) {
			// Pass empty array if claim is missing/undefined to trigger removal of all project access
			await this.provisioningService.provisionProjectRolesForUser(
				user.id,
				projectRoleMapping ?? [],
			);
		}
	}

	/**
	 * Resolve the instance role claim from an IdP response.
	 *
	 * Tries the operator-configured claim name first. If that yields nothing,
	 * walks a small fallback list of IdP-standard claim names so a misconfigured
	 * claim name doesn't silently demote every login to member. When a fallback
	 * matches, emits a warn log so operators can fix the configuration.
	 *
	 * Values are never logged — only which key was used — to avoid leaking PII.
	 */
	private resolveInstanceRoleClaim(
		claims: Record<string, unknown>,
		configuredClaimName: string,
		userId: string,
	): unknown {
		const configured = claims[configuredClaimName];
		if (configured !== undefined && configured !== null) {
			return configured;
		}

		// Azure AD App Roles -> 'roles', Okta / Auth0 groups -> 'groups',
		// some Okta setups -> 'appRoles' / 'app_roles'. Order is by rough prevalence.
		const FALLBACK_CLAIM_NAMES = ['roles', 'appRoles', 'app_roles', 'groups'];

		for (const fallbackName of FALLBACK_CLAIM_NAMES) {
			if (fallbackName === configuredClaimName) continue;
			const value = claims[fallbackName];
			if (value === undefined || value === null) continue;

			this.logger.warn(
				'OIDC provisioning: configured instance role claim was missing; using IdP-standard fallback. ' +
					'Set N8N_SSO_SCOPES_INSTANCE_ROLE_CLAIM_NAME (or update the DB row) to the fallback name to silence this warning.',
				{
					userId,
					configuredClaimName,
					fallbackUsed: fallbackName,
				},
			);
			return value;
		}

		return undefined;
	}

	/**
	 * Decode the payload of a compact-JWS token without verifying its signature.
	 * Used only as a defensive fallback for reading role claims out of an access
	 * token whose validity is already guaranteed by openid-client's
	 * `authorizationCodeGrant` validation. Returns `undefined` for non-JWT tokens
	 * (e.g. opaque tokens) and for malformed payloads.
	 */
	private decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | undefined {
		const parts = token.split('.');
		if (parts.length !== 3) return undefined;
		try {
			const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
			const parsed: unknown = JSON.parse(payload);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return undefined;
		} catch (error) {
			this.logger.debug('OIDC: failed to decode access token payload', {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private async broadcastReloadOIDCConfigurationCommand(): Promise<void> {
		if (this.instanceSettings.isMultiMain) {
			const { Publisher } = await import('@/scaling/pubsub/publisher.service');
			await Container.get(Publisher).publishCommand({ command: 'reload-oidc-config' });
		}
	}

	private isReloading = false;

	@OnPubSubEvent('reload-oidc-config')
	async reload(): Promise<void> {
		if (this.isReloading) {
			this.logger.warn('OIDC configuration reload already in progress');
			return;
		}
		this.isReloading = true;
		try {
			this.logger.debug('OIDC configuration changed, starting to load it from the database');
			const configFromDB = await this.loadConfigurationFromDatabase(true);
			if (configFromDB) {
				this.oidcConfig = configFromDB;
				this.cachedOidcConfiguration = undefined;
			} else {
				this.logger.warn('OIDC configuration not found in database, ignoring reload message');
			}
			await reloadAuthenticationMethod();

			const isOidcLoginEnabled = isOidcCurrentAuthenticationMethod();

			this.logger.debug(`OIDC login is now ${isOidcLoginEnabled ? 'enabled' : 'disabled'}.`);

			Container.get(GlobalConfig).sso.oidc.loginEnabled = isOidcLoginEnabled;
		} catch (error) {
			this.logger.error('OIDC configuration changed, failed to reload OIDC configuration', {
				error,
			});
		} finally {
			this.isReloading = false;
		}
	}

	async loadConfigurationFromDatabase(
		decryptSecret = false,
	): Promise<OidcRuntimeConfig | undefined> {
		const configFromDB = await this.settingsRepository.findByKey(OIDC_PREFERENCES_DB_KEY);

		if (configFromDB) {
			try {
				const configValue = jsonParse<OidcConfigDto>(configFromDB.value);

				if (configValue.discoveryEndpoint === '') return undefined;

				const oidcConfig = OidcConfigDto.parse(configValue);

				const discoveryUrl = new URL(oidcConfig.discoveryEndpoint);

				if (oidcConfig.clientSecret && decryptSecret) {
					oidcConfig.clientSecret = await this.cipher.decryptV2(oidcConfig.clientSecret);
				}
				return {
					...oidcConfig,
					discoveryEndpoint: discoveryUrl,
				};
			} catch (error) {
				this.logger.warn(
					'Failed to load OIDC configuration from database, falling back to default configuration.',

					{ error },
				);
			}
		}
		return undefined;
	}

	async loadConfig(decryptSecret = false): Promise<OidcRuntimeConfig> {
		const currentConfig = await this.loadConfigurationFromDatabase(decryptSecret);

		if (currentConfig) {
			return currentConfig;
		}

		return DEFAULT_OIDC_RUNTIME_CONFIG;
	}

	async updateConfig(newConfig: OidcConfigDto) {
		const isEnablingOidcWhileOtherSsoProtocolIsAlreadyEnabled =
			newConfig.loginEnabled &&
			!isEmailCurrentAuthenticationMethod() &&
			!isOidcCurrentAuthenticationMethod();
		if (isEnablingOidcWhileOtherSsoProtocolIsAlreadyEnabled) {
			throw new InternalServerError(
				`Cannot switch OIDC login enabled state when an authentication method other than email or OIDC is active (current: ${getCurrentAuthenticationMethod()})`,
			);
		}

		let discoveryEndpoint: URL;
		try {
			// Validating that discoveryEndpoint is a valid URL
			discoveryEndpoint = new URL(newConfig.discoveryEndpoint);
		} catch (error) {
			this.logger.error(`The provided endpoint is not a valid URL: ${newConfig.discoveryEndpoint}`);
			throw new UserError('Provided discovery endpoint is not a valid URL');
		}
		if (newConfig.clientSecret === OIDC_CLIENT_SECRET_REDACTED_VALUE) {
			newConfig.clientSecret = this.oidcConfig.clientSecret;
		}
		try {
			const discoveredMetadata = await this.createProxyAwareConfiguration(
				discoveryEndpoint,
				newConfig.clientId,
				newConfig.clientSecret,
			);
			// TODO: validate Metadata against features
			this.logger.debug(`Discovered OIDC metadata: ${JSON.stringify(discoveredMetadata)}`);
		} catch (error) {
			this.logger.error('Failed to discover OIDC metadata', { error });
			throw new UserError('Failed to discover OIDC metadata, based on the provided configuration');
		}
		await this.settingsRepository.save({
			key: OIDC_PREFERENCES_DB_KEY,
			value: JSON.stringify({
				...newConfig,
				clientSecret: await this.cipher.encryptV2(newConfig.clientSecret),
			}),
			loadOnStartup: true,
		});

		// TODO: Discuss this in product
		// if (this.oidcConfig.loginEnabled && !newConfig.loginEnabled) {
		// 	 await this.deleteAllOidcIdentities();
		// }

		this.oidcConfig = {
			...newConfig,
			discoveryEndpoint,
		};
		this.cachedOidcConfiguration = undefined; // reset cached configuration
		this.logger.debug(
			`OIDC login is now ${this.oidcConfig.loginEnabled ? 'enabled' : 'disabled'}.`,
		);

		await this.setOidcLoginEnabled(this.oidcConfig.loginEnabled);

		await this.broadcastReloadOIDCConfigurationCommand();
	}

	private async setOidcLoginEnabled(enabled: boolean): Promise<void> {
		const currentAuthenticationMethod = getCurrentAuthenticationMethod();

		const isEnablingOidcWhileOtherSsoProtocolIsAlreadyEnabled =
			enabled && !isEmailCurrentAuthenticationMethod() && !isOidcCurrentAuthenticationMethod();
		if (isEnablingOidcWhileOtherSsoProtocolIsAlreadyEnabled) {
			throw new InternalServerError(
				`Cannot switch OIDC login enabled state when an authentication method other than email or OIDC is active (current: ${currentAuthenticationMethod})`,
			);
		}

		const targetAuthenticationMethod =
			!enabled && currentAuthenticationMethod === 'oidc' ? 'email' : currentAuthenticationMethod;

		Container.get(GlobalConfig).sso.oidc.loginEnabled = enabled;
		await setCurrentAuthenticationMethod(enabled ? 'oidc' : targetAuthenticationMethod);
	}

	private cachedOidcConfiguration:
		| ({
				configuration: Promise<openidClientTypes.Configuration>;
				validTill: Date;
		  } & OidcRuntimeConfig)
		| undefined;

	/**
	 * Creates a proxy-aware fetch function that respects HTTP_PROXY, HTTPS_PROXY, and NO_PROXY environment variables.
	 * Returns undefined if no proxy is configured.
	 * The function is typed to match openid-client's CustomFetch signature.
	 */
	private createProxyAwareFetch():
		| ((url: string, options: unknown) => Promise<Response>)
		| undefined {
		const hasProxyConfig =
			process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.ALL_PROXY;

		if (!hasProxyConfig) {
			return undefined;
		}

		this.logger.debug('Configuring OIDC client with proxy support', {
			HTTP_PROXY: process.env.HTTP_PROXY,
			HTTPS_PROXY: process.env.HTTPS_PROXY,
			NO_PROXY: process.env.NO_PROXY,
			ALL_PROXY: process.env.ALL_PROXY,
		});

		// Create a proxy agent that automatically reads from environment variables
		const proxyAgent = new EnvHttpProxyAgent();

		// Return a fetch function that uses the proxy agent
		return async (url: string, options: unknown) => {
			return await fetch(url, {
				...(options as RequestInit),
				// @ts-expect-error - dispatcher is an undici-specific option not in standard fetch
				dispatcher: proxyAgent,
			});
		};
	}

	/**
	 * Creates a proxy-aware configuration for openid-client.
	 * This method ensures the proxy is used for BOTH the discovery request AND subsequent requests.
	 */
	private async createProxyAwareConfiguration(
		discoveryUrl: URL,
		clientId: string,
		clientSecret: string,
	): Promise<openidClientTypes.Configuration> {
		await this.loadOpenIdClient();

		const proxyFetch = this.createProxyAwareFetch();

		// When no proxy is configured, preserve the upstream 3-argument discovery
		// call shape so upstream tests and behaviour are unchanged.
		const configuration = proxyFetch
			? await this.openidClient.discovery(discoveryUrl, clientId, clientSecret, undefined, {
					[this.openidClient.customFetch]: proxyFetch,
				})
			: await this.openidClient.discovery(discoveryUrl, clientId, clientSecret);

		if (proxyFetch) {
			(configuration as unknown as Record<symbol, unknown>)[this.openidClient.customFetch] =
				proxyFetch;
		}

		return configuration;
	}

	private async getOidcConfiguration(): Promise<openidClientTypes.Configuration> {
		const now = Date.now();
		if (
			this.cachedOidcConfiguration === undefined ||
			now >= this.cachedOidcConfiguration.validTill.getTime() ||
			this.oidcConfig.discoveryEndpoint.toString() !==
				this.cachedOidcConfiguration.discoveryEndpoint.toString() ||
			this.oidcConfig.clientId !== this.cachedOidcConfiguration.clientId ||
			this.oidcConfig.clientSecret !== this.cachedOidcConfiguration.clientSecret
		) {
			this.cachedOidcConfiguration = {
				...this.oidcConfig,
				configuration: this.createProxyAwareConfiguration(
					this.oidcConfig.discoveryEndpoint,
					this.oidcConfig.clientId,
					this.oidcConfig.clientSecret,
				),
				validTill: new Date(Date.now() + 60 * 60 * 1000), // Cache for 1 hour
			};
		}

		return await this.cachedOidcConfiguration.configuration;
	}
}

import { Logger } from '@n8n/backend-common';
import { CredentialsRepository } from '@n8n/db';
import {
	CredentialResolver,
	CredentialResolverConfiguration,
	CredentialResolverDataNotFoundError,
	CredentialResolverHandle,
	CredentialResolverValidationError,
	ICredentialResolver,
} from '@n8n/decorators';
import { Cipher } from 'n8n-core';
import { ICredentialContext, ICredentialDataDecryptedObject, jsonParse } from 'n8n-workflow';
import z from 'zod';

import { EventService } from '@/events/event.service';

import type { ITokenIdentifier } from './identifiers/identifier-interface';
import {
	OAuth2IntrospectionOptionsSchema,
	OAuth2TokenIntrospectionIdentifier,
} from './identifiers/oauth2-introspection-identifier';
import {
	OAuth2JwtClaimIdentifier,
	OAuth2JwtClaimOptionsSchema,
} from './identifiers/oauth2-jwt-claim-identifier';
import {
	OAuth2UserInfoIdentifier,
	OAuth2UserInfoOptionsSchema,
} from './identifiers/oauth2-userinfo-identifier';
import { DynamicCredentialEntryStorage } from './storage/dynamic-credential-entry-storage';

const OAuthCredentialResolverOptionsSchema = z.discriminatedUnion('validation', [
	OAuth2IntrospectionOptionsSchema,
	OAuth2UserInfoOptionsSchema,
	OAuth2JwtClaimOptionsSchema,
]);

type OAuthCredentialResolverOptions = z.infer<typeof OAuthCredentialResolverOptionsSchema>;

/**
 * OAuth2 token introspection-based credential resolver.
 * Resolves user identity via OAuth2 token introspection and stores credentials
 * encrypted in the database, keyed by the introspected subject.
 */
@CredentialResolver()
export class OAuthCredentialResolver implements ICredentialResolver {
	constructor(
		private readonly logger: Logger,
		private readonly oAuth2TokenIntrospectionIdentifier: OAuth2TokenIntrospectionIdentifier,
		private readonly oAuth2UserInfoIdentifier: OAuth2UserInfoIdentifier,
		private readonly oAuth2JwtClaimIdentifier: OAuth2JwtClaimIdentifier,
		private readonly storage: DynamicCredentialEntryStorage,
		private readonly cipher: Cipher,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly eventService: EventService,
	) {}

	metadata = {
		name: 'credential-resolver.oauth2-1.0',
		description: 'OAuth2 based credential resolver',
		displayName: 'OAuth2 Resolver',
		options: [
			{
				displayName: 'Metadata URL',
				name: 'metadataUri',
				type: 'string' as const,
				required: true,
				default: '',
				placeholder: 'https://auth.example.com/.well-known/openid-configuration',
				description: 'OAuth2 server metadata endpoint URL',
			},
			{
				displayName: 'Validation Method',
				name: 'validation',
				type: 'options' as const,
				options: [
					{
						name: 'OAuth2 Token Introspection',
						value: 'oauth2-introspection',
						description: 'Validate token via OAuth2 Token Introspection Endpoint',
					},
					{
						name: 'OAuth2 UserInfo Endpoint',
						value: 'oauth2-userinfo',
						description: 'Validate token via OAuth2 UserInfo Endpoint',
					},
					{
						name: 'JWT Claim (Local Verification)',
						value: 'oauth2-jwt-claim',
						description:
							'Verify JWT signature against JWKS from discovery and read the subject claim locally — no /userinfo or /introspect roundtrip. Use this for api-audience tokens (e.g. Entra `api://<client>/...` access tokens) where the IdP rejects /userinfo and does not implement introspection.',
					},
				],
				default: 'oauth2-introspection',
				description: 'Validation method to use for token validation',
			},
			{
				displayName: 'Client ID',
				name: 'clientId',
				type: 'string' as const,
				default: '',
				description: 'OAuth2 client ID for introspection',
				displayOptions: {
					show: {
						validation: ['oauth2-introspection'],
					},
				},
			},
			{
				displayName: 'Client Secret',
				name: 'clientSecret',
				type: 'string' as const,
				default: '',
				typeOptions: { password: true },
				description: 'OAuth2 client secret for introspection',
				displayOptions: {
					show: {
						validation: ['oauth2-introspection'],
					},
				},
			},
			{
				displayName: 'Audience',
				name: 'audience',
				type: 'string' as const,
				default: '',
				description:
					"Expected `aud` claim value the JWT must carry (e.g. the n8n App Registration's client ID, or `api://<clientId>`). Required for local JWT verification.",
				displayOptions: {
					show: {
						validation: ['oauth2-jwt-claim'],
					},
				},
			},
			{
				displayName: 'Subject Claim',
				name: 'subjectClaim',
				type: 'string' as const,
				default: 'sub',
				description: 'Token claim to use as subject identifier',
			},
			{
				displayName: 'Fallback Credential ID',
				name: 'fallbackCredentialId',
				type: 'string' as const,
				default: '',
				placeholder: 'id of a static credential of the same type',
				description:
					'Optional. When set, on a per-user lookup miss the resolver falls back to the decrypted data of this static credential (typically a shared service-account credential). Use for workflows triggered without per-user identity — machine webhooks, anonymous chats, cron jobs not owned by a connected user. Leave empty for strict per-user mode (miss returns an authorization URL).',
			},
		],
	};

	/**
	 * Retrieves stored credential data for the given identity.
	 *
	 * Fork §11 — two-step lookup:
	 *  1. Try per-user lookup keyed by the identifier-resolved subject.
	 *  2. On miss, if `fallbackCredentialId` is configured, return the
	 *     decrypted data of that static credential and emit
	 *     `dynamic-credential-fallback-used`.
	 *  3. On miss with no fallback configured, throw — preserving the
	 *     upstream behavior so the editor still surfaces an authorization URL
	 *     via `CredentialCheckProxyService`.
	 *
	 * The fallback emission is the only place we audit shared-credential use,
	 * so operators can answer "which workflows ran on the shared account vs
	 * per-user tokens" purely from the event stream.
	 *
	 * @throws {CredentialResolverDataNotFoundError} When per-user data is
	 *   missing AND no fallback is configured, OR when the configured
	 *   fallback credential cannot be loaded/decrypted.
	 */
	async getSecret(
		credentialId: string,
		context: ICredentialContext,
		handle: CredentialResolverHandle,
	): Promise<ICredentialDataDecryptedObject> {
		const parsedOptions = await this.parseOptions(handle.configuration);

		let subject: string | undefined;
		try {
			subject = await this.resolveIdentifier(context, parsedOptions);
		} catch (identifierError) {
			// When the identifier itself fails (e.g. no inbound JWT on an
			// anonymous webhook) we still allow fallback to a shared credential
			// if one is configured. Otherwise propagate the original error so
			// callers see the precise reason.
			if (!parsedOptions.fallbackCredentialId) throw identifierError;
			return await this.loadFallbackOrThrow(
				credentialId,
				handle.resolverId,
				parsedOptions.fallbackCredentialId,
				subject,
				identifierError,
			);
		}

		const data = await this.storage.getCredentialData(
			credentialId,
			subject,
			handle.resolverId,
			parsedOptions,
		);

		if (data) {
			const plaintext = await this.cipher.decryptV2(data);
			try {
				return jsonParse<ICredentialDataDecryptedObject>(plaintext);
			} catch (error) {
				this.logger.error('Failed to parse decrypted credential data', { error });
				// Fall through to fallback if configured — corrupted per-user
				// data shouldn't deadlock workflows that have a safety net.
				if (!parsedOptions.fallbackCredentialId) {
					throw new CredentialResolverDataNotFoundError();
				}
			}
		}

		if (!parsedOptions.fallbackCredentialId) {
			throw new CredentialResolverDataNotFoundError();
		}

		return await this.loadFallbackOrThrow(
			credentialId,
			handle.resolverId,
			parsedOptions.fallbackCredentialId,
			subject,
		);
	}

	/**
	 * Loads, decrypts and returns the configured fallback credential's data.
	 * Emits `dynamic-credential-fallback-used` on success. Throws
	 * `CredentialResolverDataNotFoundError` if the fallback credential is
	 * missing or its data is malformed — equivalent to a per-user miss from
	 * the caller's perspective, so existing error handling paths still work.
	 *
	 * `originalError` is only used to enrich the log when the fallback itself
	 * fails after the identifier already failed — surfacing both reasons makes
	 * misconfiguration easier to diagnose.
	 */
	private async loadFallbackOrThrow(
		credentialId: string,
		resolverId: string,
		fallbackCredentialId: string,
		subject: string | undefined,
		originalError?: unknown,
	): Promise<ICredentialDataDecryptedObject> {
		const fallback = await this.credentialsRepository.findOneBy({ id: fallbackCredentialId });
		if (!fallback?.data) {
			this.logger.error('OAuth resolver fallback credential not found or empty', {
				credentialId,
				resolverId,
				fallbackCredentialId,
				originalError:
					originalError instanceof Error ? originalError.message : undefined,
			});
			throw new CredentialResolverDataNotFoundError();
		}

		let parsed: ICredentialDataDecryptedObject;
		try {
			const plaintext = await this.cipher.decryptV2(fallback.data);
			parsed = jsonParse<ICredentialDataDecryptedObject>(plaintext);
		} catch (error) {
			this.logger.error('Failed to decrypt or parse fallback credential data', {
				credentialId,
				resolverId,
				fallbackCredentialId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new CredentialResolverDataNotFoundError();
		}

		this.eventService.emit('dynamic-credential-fallback-used', {
			credentialId,
			resolverId,
			fallbackCredentialId,
			subject,
		});

		this.logger.debug('OAuth resolver returned fallback credential data', {
			credentialId,
			resolverId,
			fallbackCredentialId,
			hasSubject: subject !== undefined,
		});

		return parsed;
	}

	/** Stores credential data for the given identity */
	async setSecret(
		credentialId: string,
		context: ICredentialContext,
		data: ICredentialDataDecryptedObject,
		handle: CredentialResolverHandle,
	): Promise<void> {
		const parsedOptions = await this.parseOptions(handle.configuration);
		const key = await this.resolveIdentifier(context, parsedOptions);

		const encryptedData = await this.cipher.encryptV2(data);

		await this.storage.setCredentialData(
			credentialId,
			key,
			handle.resolverId,
			encryptedData,
			parsedOptions,
		);
	}

	/** Deletes credential data for the given identity. Succeeds silently if not found. */
	async deleteSecret(
		credentialId: string,
		context: ICredentialContext,
		handle: CredentialResolverHandle,
	): Promise<void> {
		const parsedOptions = await this.parseOptions(handle.configuration);
		const key = await this.resolveIdentifier(context, parsedOptions);
		await this.storage.deleteCredentialData(credentialId, key, handle.resolverId, parsedOptions);
	}

	async deleteAllSecrets(handle: CredentialResolverHandle): Promise<void> {
		await this.storage.deleteAllCredentialData(handle);
	}

	private async parseOptions(options: CredentialResolverConfiguration) {
		const result = await OAuthCredentialResolverOptionsSchema.safeParseAsync(options);
		if (result.error) {
			this.logger.error('Invalid options provided to OAuthCredentialResolver', {
				error: result.error,
			});
			throw new CredentialResolverValidationError(
				`Invalid options for OAuthCredentialResolver: ${result.error.message}`,
			);
		}
		return result.data;
	}

	async validateOptions(options: CredentialResolverConfiguration): Promise<void> {
		const [identifier, parsedOptions] = await this.getIdentifier(options);
		await identifier.validateOptions(parsedOptions);
	}

	private async getIdentifier(
		options: CredentialResolverConfiguration,
	): Promise<[ITokenIdentifier, OAuthCredentialResolverOptions]> {
		const parsedOptions = await this.parseOptions(options);
		if (parsedOptions.validation === 'oauth2-introspection') {
			return [this.oAuth2TokenIntrospectionIdentifier, parsedOptions];
		}
		if (parsedOptions.validation === 'oauth2-jwt-claim') {
			return [this.oAuth2JwtClaimIdentifier, parsedOptions];
		}
		return [this.oAuth2UserInfoIdentifier, parsedOptions];
	}

	private async resolveIdentifier(
		context: ICredentialContext,
		options: CredentialResolverConfiguration,
	): Promise<string> {
		const [identifier, parsedOptions] = await this.getIdentifier(options);
		return await identifier.resolve(context, parsedOptions);
	}

	async validateIdentity(
		context: ICredentialContext,
		handle: CredentialResolverHandle,
	): Promise<void> {
		const parsedOptions = await this.parseOptions(handle.configuration);
		await this.resolveIdentifier(context, parsedOptions);
	}
}

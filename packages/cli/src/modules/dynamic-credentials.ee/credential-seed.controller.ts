import { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import { CredentialsEntity } from '@n8n/db';
import { Options, Post, RestController } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { Request, Response } from 'express';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { z } from 'zod';

import { EnterpriseCredentialsService } from '@/credentials/credentials.service.ee';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { OauthService } from '@/oauth/oauth.service';

import { DynamicCredentialResolverRepository } from './database/repositories/credential-resolver.repository';
import { DynamicCredentialsConfig } from './dynamic-credentials.config';
import { CredentialStorageError } from './errors/credential-storage.error';
import { DynamicCredentialCorsService } from './services/dynamic-credential-cors.service';
import { getDynamicCredentialMiddlewares } from './utils';

const dynamicCredentialsConfig = Container.get(DynamicCredentialsConfig);

export const SeedBodySchema = z
	.object({
		resolverId: z.string().min(1, 'resolverId is required'),
		identityToken: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Token the resolver validates to derive the storage subject. Required when userAccessToken cannot be validated by the resolver (e.g. non-Graph-audience MS tokens). Falls back to userAccessToken when omitted.',
			),
		userAccessToken: z.string().min(1, 'userAccessToken is required'),
		refreshToken: z.string().min(1, 'refreshToken is required'),
		tokenType: z.string().default('Bearer'),
		expiresIn: z.number().int().positive().default(3599),
		scope: z.string().optional(),
		extraTokenFields: z.record(z.string(), z.unknown()).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

export type SeedBody = z.infer<typeof SeedBodySchema>;

@RestController('/credentials')
export class CredentialSeedController {
	constructor(
		private readonly enterpriseCredentialsService: EnterpriseCredentialsService,
		private readonly oauthService: OauthService,
		private readonly resolverRepository: DynamicCredentialResolverRepository,
		private readonly dynamicCredentialCorsService: DynamicCredentialCorsService,
		private readonly logger: Logger,
	) {}

	@Options('/:id/seed', { skipAuth: true })
	handlePreflightSeed(req: Request, res: Response): void {
		this.dynamicCredentialCorsService.preflightHandler(req, res, ['post', 'options']);
	}

	@Post('/:id/seed', {
		allowUnauthenticated: true,
		middlewares: getDynamicCredentialMiddlewares(),
		ipRateLimit: {
			limit: dynamicCredentialsConfig.rateLimitAuthorizePerMinute,
			windowMs: 1 * Time.minutes.toMilliseconds,
		},
	})
	async seedCredential(req: Request, res: Response): Promise<{ ok: true }> {
		this.dynamicCredentialCorsService.applyCorsHeadersIfEnabled(req, res, ['post', 'options']);

		const input = this.parseBody(req.body);
		const credential = await this.loadOAuth2DynamicCredential(req.params.id);
		await this.ensureResolverExists(input.resolverId);

		const oauthTokenData: ICredentialDataDecryptedObject = {
			access_token: input.userAccessToken,
			refresh_token: input.refreshToken,
			token_type: input.tokenType,
			expires_in: input.expiresIn,
			...(input.scope ? { scope: input.scope } : {}),
			...(input.extraTokenFields ?? {}),
		};

		const resolverIdentity = input.identityToken ?? input.userAccessToken;

		try {
			await this.oauthService.saveDynamicCredential(
				credential,
				{ oauthTokenData },
				resolverIdentity,
				input.resolverId,
				{ source: 'seed', enrolledAt: Date.now(), ...(input.metadata ?? {}) },
			);
		} catch (error) {
			if (error instanceof CredentialStorageError) {
				throw new BadRequestError(error.message);
			}
			this.logger.error('Unexpected error while seeding dynamic credential', {
				credentialId: credential.id,
				resolverId: input.resolverId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw new BadRequestError('Failed to seed credential');
		}

		this.logger.debug('Dynamic credential seeded', {
			credentialId: credential.id,
			resolverId: input.resolverId,
			split: input.identityToken !== undefined,
		});

		return { ok: true };
	}

	private parseBody(body: unknown): SeedBody {
		const result = SeedBodySchema.safeParse(body);
		if (!result.success) {
			const detail = result.error.issues
				.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
				.join('; ');
			throw new BadRequestError(`Invalid request body: ${detail}`);
		}
		return result.data;
	}

	private async loadOAuth2DynamicCredential(credentialId: string): Promise<CredentialsEntity> {
		const credential = await this.enterpriseCredentialsService.getOne(credentialId);

		if (!credential) {
			throw new NotFoundError('Credential not found');
		}
		if (!credential.isResolvable) {
			throw new BadRequestError('Credential is not marked as dynamic (isResolvable=false)');
		}
		if (!credential.type.toLowerCase().includes('oauth2')) {
			throw new BadRequestError('Only OAuth2 credentials can be seeded');
		}

		return credential;
	}

	private async ensureResolverExists(resolverId: string): Promise<void> {
		const resolverEntity = await this.resolverRepository.findOneBy({ id: resolverId });
		if (!resolverEntity) {
			throw new NotFoundError('Resolver not found');
		}
	}
}

import { Logger } from '@n8n/backend-common';
import { mockInstance } from '@n8n/backend-test-utils';
import { type CredentialsEntity } from '@n8n/db';
import { Container } from '@n8n/di';
import type { Request, Response } from 'express';
import { mock } from 'jest-mock-extended';

import { EnterpriseCredentialsService } from '@/credentials/credentials.service.ee';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { CredentialSeedController } from '@/modules/dynamic-credentials.ee/credential-seed.controller';
import { DynamicCredentialResolverRepository } from '@/modules/dynamic-credentials.ee/database/repositories/credential-resolver.repository';
import type { DynamicCredentialResolver } from '@/modules/dynamic-credentials.ee/database/entities/credential-resolver';
import { CredentialStorageError } from '@/modules/dynamic-credentials.ee/errors/credential-storage.error';
import { DynamicCredentialCorsService } from '@/modules/dynamic-credentials.ee/services/dynamic-credential-cors.service';
import { OauthService } from '@/oauth/oauth.service';

jest.mock('../utils', () => ({
	getDynamicCredentialMiddlewares: jest.fn(() => undefined),
}));

describe('CredentialSeedController', () => {
	const enterpriseCredentialsService = mockInstance(EnterpriseCredentialsService);
	const oauthService = mockInstance(OauthService);
	const resolverRepository = mockInstance(DynamicCredentialResolverRepository);
	mockInstance(DynamicCredentialCorsService);
	mockInstance(Logger);

	const controller = Container.get(CredentialSeedController);

	const fixedTimestamp = 1706750625678;
	jest.useFakeTimers({ advanceTimers: true });

	const mockResolverEntity: DynamicCredentialResolver = {
		id: 'resolver-123',
		name: 'Entra Resolver',
		type: 'credential-resolver.oauth2-1.0',
		config: 'encrypted-config',
		createdAt: new Date(),
		updatedAt: new Date(),
		generateId: jest.fn(),
		setUpdateDate: jest.fn(),
	};

	const oauth2Credential = mock<CredentialsEntity>({
		id: 'cred-456',
		name: 'Outlook OAuth2',
		type: 'microsoftOutlookOAuth2Api',
		isResolvable: true,
	});

	const validBody = {
		resolverId: 'resolver-123',
		userAccessToken: 'graph-access-token',
		refreshToken: 'refresh-token',
		scope: 'openid offline_access Mail.ReadWrite',
	};

	const buildReq = (body: unknown, id = 'cred-456'): Request =>
		({ params: { id }, body }) as unknown as Request;

	const buildRes = (): Response => mock<Response>();

	beforeEach(() => {
		jest.setSystemTime(new Date(fixedTimestamp));
		jest.clearAllMocks();
	});

	describe('happy paths', () => {
		it('seeds with a single Graph-audience token (no identityToken)', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(oauth2Credential);
			resolverRepository.findOneBy.mockResolvedValue(mockResolverEntity);

			const result = await controller.seedCredential(buildReq(validBody), buildRes());

			expect(result).toEqual({ ok: true });
			expect(enterpriseCredentialsService.getOne).toHaveBeenCalledWith('cred-456');
			expect(resolverRepository.findOneBy).toHaveBeenCalledWith({ id: 'resolver-123' });
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledTimes(1);
			expect(oauthService.saveDynamicCredential).toHaveBeenCalledWith(
				oauth2Credential,
				{
					oauthTokenData: {
						access_token: 'graph-access-token',
						refresh_token: 'refresh-token',
						token_type: 'Bearer',
						expires_in: 3599,
						scope: 'openid offline_access Mail.ReadWrite',
					},
				},
				'graph-access-token',
				'resolver-123',
				{ source: 'seed', enrolledAt: fixedTimestamp },
			);
		});

		it('uses identityToken (when provided) as the resolver identity', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(oauth2Credential);
			resolverRepository.findOneBy.mockResolvedValue(mockResolverEntity);

			const body = {
				...validBody,
				identityToken: 'graph-id-token',
				userAccessToken: 'sharepoint-access-token',
				scope: 'openid offline_access https://acme.sharepoint.com/.default',
			};

			await controller.seedCredential(buildReq(body), buildRes());

			const call = oauthService.saveDynamicCredential.mock.calls[0];
			expect(call[1]).toEqual({
				oauthTokenData: {
					access_token: 'sharepoint-access-token',
					refresh_token: 'refresh-token',
					token_type: 'Bearer',
					expires_in: 3599,
					scope: 'openid offline_access https://acme.sharepoint.com/.default',
				},
			});
			expect(call[2]).toBe('graph-id-token');
		});

		it('merges extraTokenFields into the stored oauthTokenData', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(oauth2Credential);
			resolverRepository.findOneBy.mockResolvedValue(mockResolverEntity);

			await controller.seedCredential(
				buildReq({
					...validBody,
					extraTokenFields: { id_token: 'eyJ.id.token', ext_expires_in: 3599 },
				}),
				buildRes(),
			);

			const call = oauthService.saveDynamicCredential.mock.calls[0];
			expect(call[1]).toEqual({
				oauthTokenData: expect.objectContaining({
					access_token: 'graph-access-token',
					id_token: 'eyJ.id.token',
					ext_expires_in: 3599,
				}),
			});
		});

		it('merges caller-provided metadata on top of source/enrolledAt', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(oauth2Credential);
			resolverRepository.findOneBy.mockResolvedValue(mockResolverEntity);

			await controller.seedCredential(
				buildReq({ ...validBody, metadata: { tenantId: 'tenant-abc' } }),
				buildRes(),
			);

			const call = oauthService.saveDynamicCredential.mock.calls[0];
			expect(call[4]).toEqual({
				source: 'seed',
				enrolledAt: fixedTimestamp,
				tenantId: 'tenant-abc',
			});
		});
	});

	describe('sad paths', () => {
		it('throws BadRequestError on invalid body (missing userAccessToken)', async () => {
			const bad = { resolverId: 'resolver-123', refreshToken: 'refresh-token' };

			const promise = controller.seedCredential(buildReq(bad), buildRes());
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow(/userAccessToken/);
			expect(enterpriseCredentialsService.getOne).not.toHaveBeenCalled();
		});

		it('throws NotFoundError when credential does not exist', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(null);

			const promise = controller.seedCredential(buildReq(validBody, 'missing'), buildRes());
			await expect(promise).rejects.toThrow(NotFoundError);
			await expect(promise).rejects.toThrow('Credential not found');
		});

		it('throws BadRequestError when credential is not marked as dynamic', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(
				mock<CredentialsEntity>({
					id: 'cred-456',
					type: 'microsoftOutlookOAuth2Api',
					isResolvable: false,
				}),
			);

			const promise = controller.seedCredential(buildReq(validBody), buildRes());
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('isResolvable');
		});

		it('throws BadRequestError when credential is not OAuth2', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(
				mock<CredentialsEntity>({
					id: 'cred-456',
					type: 'httpBasicAuth',
					isResolvable: true,
				}),
			);

			const promise = controller.seedCredential(buildReq(validBody), buildRes());
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Only OAuth2 credentials');
		});

		it('throws NotFoundError when resolver does not exist', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(oauth2Credential);
			resolverRepository.findOneBy.mockResolvedValue(null);

			const promise = controller.seedCredential(buildReq(validBody), buildRes());
			await expect(promise).rejects.toThrow(NotFoundError);
			await expect(promise).rejects.toThrow('Resolver not found');
		});

		it('converts CredentialStorageError from saveDynamicCredential into a BadRequestError', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(oauth2Credential);
			resolverRepository.findOneBy.mockResolvedValue(mockResolverEntity);
			oauthService.saveDynamicCredential.mockRejectedValueOnce(
				new CredentialStorageError('Failed to store dynamic credentials data for "Outlook"'),
			);

			const promise = controller.seedCredential(buildReq(validBody), buildRes());
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Failed to store dynamic credentials data');
		});

		it('hides unexpected errors behind a generic BadRequestError', async () => {
			enterpriseCredentialsService.getOne.mockResolvedValue(oauth2Credential);
			resolverRepository.findOneBy.mockResolvedValue(mockResolverEntity);
			oauthService.saveDynamicCredential.mockRejectedValueOnce(new Error('cipher key unavailable'));

			const promise = controller.seedCredential(buildReq(validBody), buildRes());
			await expect(promise).rejects.toThrow(BadRequestError);
			await expect(promise).rejects.toThrow('Failed to seed credential');
		});
	});
});

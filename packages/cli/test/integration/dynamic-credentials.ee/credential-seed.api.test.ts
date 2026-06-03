import { LicenseState } from '@n8n/backend-common';
import { mockInstance, getPersonalProject, testDb } from '@n8n/backend-test-utils';
import type { CredentialsEntity, User } from '@n8n/db';
import { GLOBAL_OWNER_ROLE } from '@n8n/db';
import { Container } from '@n8n/di';
import { mock } from 'jest-mock-extended';
import nock from 'nock';

import { CredentialsHelper } from '@/credentials-helper';
import { LoadNodesAndCredentials } from '@/load-nodes-and-credentials';
import type { DynamicCredentialResolver } from '@/modules/dynamic-credentials.ee/database/entities/credential-resolver';
import { DynamicCredentialEntryRepository } from '@/modules/dynamic-credentials.ee/database/repositories/dynamic-credential-entry.repository';
import { DynamicCredentialsConfig } from '@/modules/dynamic-credentials.ee/dynamic-credentials.config';
import { DynamicCredentialResolverService } from '@/modules/dynamic-credentials.ee/services/credential-resolver.service';
import { Telemetry } from '@/telemetry';

import { saveCredential } from '../shared/db/credentials';
import { createUser } from '../shared/db/users';
import * as utils from '../shared/utils';

mockInstance(Telemetry);

const licenseMock = mock<LicenseState>();
licenseMock.isLicensed.mockReturnValue(true);
Container.set(LicenseState, licenseMock);

process.env.N8N_ENV_FEAT_DYNAMIC_CREDENTIALS = 'true';

mockInstance(DynamicCredentialsConfig, {
	endpointAuthToken: 'static-test-token',
	corsOrigin: 'https://app.example.com',
	corsAllowCredentials: false,
});

const loadNodesAndCredentials = mockInstance(LoadNodesAndCredentials);
loadNodesAndCredentials.getCredential.mockImplementation((credentialType: string) => ({
	type: {
		name: credentialType,
		displayName: credentialType,
		properties: [],
	},
	sourcePath: '',
}));

const testServer = utils.setupTestServer({
	endpointGroups: ['credentials', 'oauth2'],
	enabledFeatures: ['feat:externalSecrets'],
	modules: ['dynamic-credentials'],
});

CredentialsHelper.prototype.applyDefaultsAndOverwrites = async (_, decryptedDataOriginal) =>
	decryptedDataOriginal;

const SEED_SUBJECT = 'user-from-seed';

const setupWorkflow = async () => {
	const owner = await createUser({ role: GLOBAL_OWNER_ROLE });
	const resolverService = Container.get(DynamicCredentialResolverService);

	const resolver = await resolverService.create({
		name: 'Seed Resolver',
		type: 'credential-resolver.oauth2-1.0',
		config: {
			metadataUri: 'https://auth.example.com/.well-known/openid-configuration',
			clientId: 'test-client-id',
			clientSecret: 'test-client-secret',
			validation: 'oauth2-introspection',
		},
		user: owner,
	});

	const personalProject = await getPersonalProject(owner);

	const oauth2Credential = await saveCredential(
		{
			name: 'Seedable OAuth2 Credential',
			type: 'oAuth2Api',
			isResolvable: true,
			data: {
				clientId: 'test-client-id',
				clientSecret: 'test-client-secret',
				authUrl: 'https://test.domain/oauth2/auth',
				accessTokenUrl: 'https://test.domain/oauth2/token',
				grantType: 'authorizationCode',
			},
		},
		{ project: personalProject, role: 'credential:owner' },
	);

	const nonResolvableCredential = await saveCredential(
		{
			name: 'Plain OAuth2 (not dynamic)',
			type: 'oAuth2Api',
			isResolvable: false,
			data: { clientId: 'x', clientSecret: 'x' },
		},
		{ project: personalProject, role: 'credential:owner' },
	);

	const nonOAuthCredential = await saveCredential(
		{
			name: 'HTTP Basic (dynamic but not OAuth)',
			type: 'httpBasicAuth',
			isResolvable: true,
			data: { user: 'u', password: 'p' },
		},
		{ project: personalProject, role: 'credential:owner' },
	);

	return { owner, resolver, oauth2Credential, nonResolvableCredential, nonOAuthCredential };
};

describe('POST /credentials/:id/seed', () => {
	let owner: User;
	let resolver: DynamicCredentialResolver;
	let oauth2Credential: CredentialsEntity;
	let nonResolvableCredential: CredentialsEntity;
	let nonOAuthCredential: CredentialsEntity;
	let entryRepository: DynamicCredentialEntryRepository;

	const validBody = {
		resolverId: '',
		userAccessToken: 'graph-access-token',
		refreshToken: 'graph-refresh-token',
		tokenType: 'Bearer',
		expiresIn: 3599,
		scope: 'openid offline_access Mail.ReadWrite',
	};

	beforeAll(async () => {
		nock.cleanAll();
		nock('https://auth.example.com')
			.persist()
			.get('/.well-known/openid-configuration')
			.reply(200, {
				issuer: 'https://auth.example.com',
				introspection_endpoint: 'https://auth.example.com/oauth/introspect',
				introspection_endpoint_auth_methods_supported: [
					'client_secret_basic',
					'client_secret_post',
				],
			});

		nock('https://auth.example.com')
			.persist()
			.post('/oauth/introspect')
			.reply(200, {
				active: true,
				sub: SEED_SUBJECT,
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

		await testDb.truncate([
			'User',
			'CredentialsEntity',
			'DynamicCredentialResolver',
			'DynamicCredentialEntry',
			'DynamicCredentialUserEntry',
		]);

		({ owner, resolver, oauth2Credential, nonResolvableCredential, nonOAuthCredential } =
			await setupWorkflow());

		entryRepository = Container.get(DynamicCredentialEntryRepository);
		validBody.resolverId = resolver.id;
	});

	beforeEach(async () => {
		await testDb.truncate(['DynamicCredentialEntry', 'DynamicCredentialUserEntry']);
	});

	afterAll(async () => {
		nock.cleanAll();
		await testDb.terminate();
		testServer.httpServer.close();
	});

	describe('happy paths', () => {
		it('seeds a credential and persists exactly one entry', async () => {
			const response = await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(200);

			expect(response.body.data).toEqual({ ok: true });

			const stored = await entryRepository.find({ where: { credentialId: oauth2Credential.id } });
			expect(stored).toHaveLength(1);
			expect(stored[0].subjectId).toBe(SEED_SUBJECT);
			expect(stored[0].resolverId).toBe(resolver.id);
			expect(typeof stored[0].data).toBe('string');
			expect(stored[0].data.length).toBeGreaterThan(0);
		});

		it('upserts on re-seed (same subject, same row)', async () => {
			await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(200);

			const firstEntries = await entryRepository.find({
				where: { credentialId: oauth2Credential.id },
			});
			expect(firstEntries).toHaveLength(1);
			const firstBlob = firstEntries[0].data;

			await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send({ ...validBody, userAccessToken: 'rotated-access-token' })
				.expect(200);

			const secondEntries = await entryRepository.find({
				where: { credentialId: oauth2Credential.id },
			});
			expect(secondEntries).toHaveLength(1);
			expect(secondEntries[0].subjectId).toBe(SEED_SUBJECT);
			expect(secondEntries[0].data).not.toBe(firstBlob);
		});

		it('accepts the split-token shape (identityToken + service-aud userAccessToken)', async () => {
			await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send({
					...validBody,
					identityToken: 'graph-id-token',
					userAccessToken: 'sharepoint-resource-token',
					scope: 'openid offline_access https://acme.sharepoint.com/.default',
				})
				.expect(200);

			const stored = await entryRepository.find({ where: { credentialId: oauth2Credential.id } });
			expect(stored).toHaveLength(1);
			expect(stored[0].subjectId).toBe(SEED_SUBJECT);
		});
	});

	describe('sad paths', () => {
		it('returns 400 on invalid body', async () => {
			const response = await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send({ resolverId: resolver.id, refreshToken: 'r' })
				.expect(400);

			expect(response.body.message).toMatch(/userAccessToken/);
		});

		it('returns 404 when credential does not exist', async () => {
			await testServer.authlessAgent
				.post('/credentials/does-not-exist/seed')
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(404);
		});

		it('returns 400 when credential is not marked as dynamic', async () => {
			const response = await testServer.authlessAgent
				.post(`/credentials/${nonResolvableCredential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(400);

			expect(response.body.message).toMatch(/isResolvable/);
		});

		it('returns 400 when credential is not OAuth2', async () => {
			const response = await testServer.authlessAgent
				.post(`/credentials/${nonOAuthCredential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(400);

			expect(response.body.message).toMatch(/OAuth2/);
		});

		it('returns 404 when resolver does not exist', async () => {
			await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('X-Authorization', 'Bearer static-test-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send({ ...validBody, resolverId: 'missing-resolver' })
				.expect(404);
		});

		it('returns 401 when the static auth token is missing', async () => {
			await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(401);
		});

		it('returns 401 when the static auth token is invalid', async () => {
			await testServer.authlessAgent
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('X-Authorization', 'Bearer wrong-static-token')
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(401);
		});
	});

	describe('cookie authentication bypass', () => {
		it('allows the seed call when authenticated via cookie even without the static token', async () => {
			await testServer
				.authAgentFor(owner)
				.post(`/credentials/${oauth2Credential.id}/seed`)
				.set('Authorization', 'Bearer some-graph-token')
				.send(validBody)
				.expect(200);

			const stored = await entryRepository.find({ where: { credentialId: oauth2Credential.id } });
			expect(stored).toHaveLength(1);
		});
	});
});

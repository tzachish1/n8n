import type { CredentialsEntity, User } from '@n8n/db';
import { mock } from 'jest-mock-extended';

import { findCredentialForOAuthConnect } from '@/credentials/credential-oauth-access';
import type { CredentialsFinderService } from '@/credentials/credentials-finder.service';

describe('findCredentialForOAuthConnect', () => {
	const credentialsFinderService = mock<CredentialsFinderService>();
	const user = mock<User>({ id: 'user-1' });

	beforeEach(() => {
		jest.resetAllMocks();
	});

	it('returns credential when user has credential:update', async () => {
		const credential = mock<CredentialsEntity>({ id: 'cred-1', isResolvable: false });
		credentialsFinderService.findCredentialForUser.mockResolvedValueOnce(credential);

		const result = await findCredentialForOAuthConnect(credentialsFinderService, 'cred-1', user);

		expect(result).toBe(credential);
		expect(credentialsFinderService.findCredentialForUser).toHaveBeenCalledTimes(1);
		expect(credentialsFinderService.findCredentialForUser).toHaveBeenCalledWith('cred-1', user, [
			'credential:update',
		]);
	});

	it('returns resolvable credential when user has only credential:read', async () => {
		const credential = mock<CredentialsEntity>({ id: 'cred-1', isResolvable: true });
		credentialsFinderService.findCredentialForUser
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(credential);

		const result = await findCredentialForOAuthConnect(credentialsFinderService, 'cred-1', user);

		expect(result).toBe(credential);
		expect(credentialsFinderService.findCredentialForUser).toHaveBeenNthCalledWith(
			2,
			'cred-1',
			user,
			['credential:read'],
		);
	});

	it('returns null when read-only sharee accesses a static credential', async () => {
		credentialsFinderService.findCredentialForUser
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(mock<CredentialsEntity>({ id: 'cred-1', isResolvable: false }));

		const result = await findCredentialForOAuthConnect(credentialsFinderService, 'cred-1', user);

		expect(result).toBeNull();
	});

	it('returns null when user has no access', async () => {
		credentialsFinderService.findCredentialForUser
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		const result = await findCredentialForOAuthConnect(credentialsFinderService, 'cred-1', user);

		expect(result).toBeNull();
	});
});

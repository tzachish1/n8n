import type { CredentialsEntity, User } from '@n8n/db';
import type { Scope } from '@n8n/permissions';

import type { CredentialsFinderService } from '@/credentials/credentials-finder.service';

/**
 * Resolves a credential the caller may use to start an OAuth connect flow.
 *
 * Owners/editors (`credential:update`) may reconnect static credentials or
 * connect their per-user row on resolvable ones. Sharees with only
 * `credential:read` may start OAuth only for resolvable credentials — the
 * flow stores tokens in per-user storage, not in the shared credential blob.
 */
export async function findCredentialForOAuthConnect(
	credentialsFinderService: CredentialsFinderService,
	credentialId: string,
	user: User,
): Promise<CredentialsEntity | null> {
	const withUpdate = await credentialsFinderService.findCredentialForUser(credentialId, user, [
		'credential:update',
	] satisfies Scope[]);
	if (withUpdate) {
		return withUpdate;
	}

	const withRead = await credentialsFinderService.findCredentialForUser(credentialId, user, [
		'credential:read',
	] satisfies Scope[]);
	if (withRead?.isResolvable) {
		return withRead;
	}

	return null;
}

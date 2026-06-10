import type { PermissionsRecord } from '@n8n/permissions';

/**
 * Whether the user may connect their personal OAuth identity on a shared
 * resolvable credential without `credential:update` (read-only sharees).
 */
export function canConnectResolvableCredential(
	credentialPermissions: PermissionsRecord['credential'],
	isResolvable?: boolean,
): boolean {
	return (
		isResolvable === true && Boolean(credentialPermissions.read || credentialPermissions.update)
	);
}

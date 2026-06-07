import type { MigrationContext, ReversibleMigration } from '../migration-types';

const tableName = 'dynamic_credential_resolver';

/**
 * Fork §10 — OIDC self-seed for Microsoft Graph.
 *
 * Adds an optional `oidcSeedSource` column to `dynamic_credential_resolver`
 * so an admin can mark a resolver as "auto-seed candidate" directly on the
 * row (set via the per-resolver UI dropdown — single source of truth).
 *
 * Valid values for v1: `'oidc'` (capture from the n8n OIDC IdP, e.g., Entra).
 * `NULL` (default) means "do not auto-seed", which keeps existing rows inert
 * after the migration runs.
 */
export class AddOidcSeedSourceToCredentialResolver1784000000007 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns(tableName, [column('oidcSeedSource').varchar(64)]);
	}

	async down({ schemaBuilder: { dropColumns } }: MigrationContext) {
		await dropColumns(tableName, ['oidcSeedSource']);
	}
}

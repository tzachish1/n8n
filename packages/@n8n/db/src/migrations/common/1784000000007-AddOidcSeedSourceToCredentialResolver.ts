import assert from 'node:assert';

import type { MigrationContext, ReversibleMigration } from '../migration-types';

const tableName = 'dynamic_credential_resolver';
const columnName = 'oidcSeedSource';

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
 *
 * Idempotent: if the column already exists (e.g. an earlier image of this
 * fork ran the migration under the prior name
 * `AddOidcSeedSourceToCredentialResolver1785000000000`), the `up()` records
 * a no-op so the migrations table can advance to the renamed entry without
 * re-running the DDL. This keeps phase2c-v2 → phase2d-v3+ upgrades safe.
 */
export class AddOidcSeedSourceToCredentialResolver1784000000007 implements ReversibleMigration {
	async up({ queryRunner, schemaBuilder: { addColumns, column }, tablePrefix }: MigrationContext) {
		const table = await queryRunner.getTable(`${tablePrefix}${tableName}`);
		assert(table, `${tableName} table not found`);

		if (table.findColumnByName(columnName)) return;

		await addColumns(tableName, [column(columnName).varchar(64)]);
	}

	async down({ queryRunner, schemaBuilder: { dropColumns }, tablePrefix }: MigrationContext) {
		const table = await queryRunner.getTable(`${tablePrefix}${tableName}`);
		assert(table, `${tableName} table not found`);

		if (!table.findColumnByName(columnName)) return;

		await dropColumns(tableName, [columnName]);
	}
}

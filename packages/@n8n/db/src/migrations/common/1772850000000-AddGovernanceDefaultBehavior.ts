import type { MigrationContext, ReversibleMigration } from '../migration-types';

export class AddGovernanceDefaultBehavior1772850000000 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column }, runQuery }: MigrationContext) {
		await addColumns('project', [
			column('governanceDefaultBehavior').varchar(10).withEnumCheck(['allow', 'block']),
		]);

		await runQuery(
			`INSERT INTO settings ("key", "value", "loadOnStartup") VALUES ('governance.defaultBehavior', '"allow"', true)`,
		);
	}

	async down({ schemaBuilder: { dropColumns }, runQuery }: MigrationContext) {
		await dropColumns('project', ['governanceDefaultBehavior']);
		await runQuery(`DELETE FROM settings WHERE "key" = 'governance.defaultBehavior'`);
	}
}

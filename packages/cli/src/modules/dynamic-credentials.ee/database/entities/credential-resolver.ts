import { WithTimestampsAndStringId } from '@n8n/db';
import type { CredentialResolverConfiguration } from '@n8n/decorators';
import { Column, Entity } from '@n8n/typeorm';

@Entity()
export class DynamicCredentialResolver extends WithTimestampsAndStringId {
	@Column({ type: 'varchar', length: 128 })
	name: string;

	@Column({ type: 'varchar', length: 128 })
	type: string;

	@Column({ type: 'text' })
	config: string;

	/**
	 * Fork §10 — opt-in flag that marks this resolver as eligible for OIDC
	 * self-seeding. When set to `'oidc'`, the OIDC service auto-populates every
	 * `isResolvable=true` credential pointing at this resolver with the tokens
	 * captured at OIDC login. `null` (default) means "do not auto-seed".
	 *
	 * Kept as a string (rather than boolean) so we can extend to other capture
	 * sources later (e.g., `'monday'`) without another migration.
	 */
	@Column({ type: 'varchar', length: 64, nullable: true })
	oidcSeedSource?: string | null;

	/** Decrypted config, not persisted to the database */
	decryptedConfig?: CredentialResolverConfiguration;
}

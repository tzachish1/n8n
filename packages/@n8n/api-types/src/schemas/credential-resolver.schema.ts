import { z } from 'zod';

export const credentialResolverIdSchema = z.string().max(36);
export const credentialResolverNameSchema = z.string().trim().min(1).max(255);
export const credentialResolverTypeNameSchema = z.string().trim().min(1).max(255);
export const credentialResolverConfigSchema = z.record(z.unknown());

/**
 * Fork §10 — opt-in flag on a `DynamicCredentialResolver` that marks the row
 * as a candidate for OIDC self-seeding. Valid values for v1:
 *   - `'oidc'`  : capture from the n8n OIDC IdP (e.g., Microsoft Entra)
 *   - `null` / omitted : do not auto-seed (default)
 *
 * Kept as a string enum rather than boolean so future capture sources
 * (`'monday'`, etc.) can be added without another DB migration.
 */
export const OIDC_SEED_SOURCES = ['oidc'] as const;
export type OidcSeedSource = (typeof OIDC_SEED_SOURCES)[number];
export const oidcSeedSourceSchema = z.enum(OIDC_SEED_SOURCES).nullable().optional();

export const credentialResolverSchema = z.object({
	id: credentialResolverIdSchema,
	name: credentialResolverNameSchema,
	type: credentialResolverTypeNameSchema,
	config: z.string(), // Encrypted config
	decryptedConfig: credentialResolverConfigSchema.optional(),
	oidcSeedSource: oidcSeedSourceSchema,
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});

export const credentialResolverTypeSchema = z.object({
	name: credentialResolverTypeNameSchema,
	displayName: z.string().trim().min(1).max(255),
	description: z.string().trim().max(1024).optional(),
	options: z.array(z.record(z.unknown())).optional(),
});

export const credentialResolverTypesSchema = z.array(credentialResolverTypeSchema);

export type CredentialResolverType = z.infer<typeof credentialResolverTypeSchema>;

export const credentialResolversSchema = z.array(credentialResolverSchema);

export type CredentialResolver = z.infer<typeof credentialResolverSchema>;

export const credentialResolverAffectedWorkflowSchema = z.object({
	id: z.string(),
	name: z.string(),
});

export const credentialResolverAffectedWorkflowsSchema = z.array(
	credentialResolverAffectedWorkflowSchema,
);

export type CredentialResolverAffectedWorkflow = z.infer<
	typeof credentialResolverAffectedWorkflowSchema
>;

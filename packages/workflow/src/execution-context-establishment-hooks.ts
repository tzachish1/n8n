import z from 'zod/v4';

const ExecutionContextEstablishmentHookParameterSchemaV1 = z.object({
	executionsHooksVersion: z.literal(1),
	contextEstablishmentHooks: z.object({
		hooks: z
			.array(
				z
					.object({
						hookName: z.string(),
						isAllowedToFail: z.boolean().optional().default(false),
					})
					.loose(),
			)
			.optional()
			.default([]),
	}),
});

export type ExecutionContextEstablishmentHookParameterV1 = z.output<
	typeof ExecutionContextEstablishmentHookParameterSchemaV1
>;

export const ExecutionContextEstablishmentHookParameterSchema = z
	.discriminatedUnion('executionsHooksVersion', [
		ExecutionContextEstablishmentHookParameterSchemaV1,
	])
	.meta({
		title: 'ExecutionContextEstablishmentHookParameter',
	});

export type ExecutionContextEstablishmentHookParameter = z.output<
	typeof ExecutionContextEstablishmentHookParameterSchema
>;

/**
 * Safely parses an execution context establishment hook parameters
 * @param obj
 * @returns
 */
export const toExecutionContextEstablishmentHookParameter = (value: unknown) => {
	if (value === null || value === undefined || typeof value !== 'object') {
		return null;
	}

	const valueRecord = value as Record<string, unknown>;
	const hasVersion = 'executionsHooksVersion' in valueRecord;
	const hasHookCollection = 'contextEstablishmentHooks' in valueRecord;

	// Skip non-trigger node parameters where neither marker is present.
	if (!hasVersion && !hasHookCollection) {
		return null;
	}

	// `executionsHooksVersion` is a `hidden` node property with `default: 1`
	// (see `load-nodes-and-credentials.ts`). n8n's workflow serializer omits
	// parameters whose value matches the descriptor default, so a legitimate
	// hook config is persisted as `{ contextEstablishmentHooks: { hooks: [...] } }`
	// — without the version discriminator. Treat that shape as v1 (the only
	// schema currently defined) so the publish-time validator and the runtime
	// hook executor can still parse it. Explicit values are left untouched.
	const valueToParse: unknown = hasVersion
		? value
		: { executionsHooksVersion: 1, ...valueRecord };

	return ExecutionContextEstablishmentHookParameterSchema.safeParse(valueToParse);
};

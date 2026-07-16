import { toExecutionContextEstablishmentHookParameter } from '../src/execution-context-establishment-hooks';

describe('toExecutionContextEstablishmentHookParameter', () => {
	describe('null/undefined/non-object inputs', () => {
		it('returns null for null', () => {
			expect(toExecutionContextEstablishmentHookParameter(null)).toBeNull();
		});

		it('returns null for undefined', () => {
			expect(toExecutionContextEstablishmentHookParameter(undefined)).toBeNull();
		});

		it('returns null for primitive string', () => {
			expect(toExecutionContextEstablishmentHookParameter('not-an-object')).toBeNull();
		});

		it('returns null for primitive number', () => {
			expect(toExecutionContextEstablishmentHookParameter(42)).toBeNull();
		});
	});

	describe('non-trigger parameters (no hook markers)', () => {
		it('returns null when neither version nor hook collection is present', () => {
			// Mirrors a Manual Trigger / Cron Trigger node — no hook config at all.
			expect(
				toExecutionContextEstablishmentHookParameter({
					path: 'foo',
					responseMode: 'responseNode',
				}),
			).toBeNull();
		});

		it('returns null for an empty object', () => {
			expect(toExecutionContextEstablishmentHookParameter({})).toBeNull();
		});
	});

	describe('explicit version present', () => {
		it('parses successfully with version + hooks', () => {
			const result = toExecutionContextEstablishmentHookParameter({
				executionsHooksVersion: 1,
				contextEstablishmentHooks: {
					hooks: [{ hookName: 'HttpHeaderExtractor' }],
				},
			});

			expect(result).not.toBeNull();
			expect(result!.success).toBe(true);
			if (result!.success) {
				expect(result!.data.contextEstablishmentHooks.hooks).toEqual([
					{ hookName: 'HttpHeaderExtractor', isAllowedToFail: false },
				]);
			}
		});
	});

	describe('hidden default-stripped configs (the publish bug)', () => {
		// `executionsHooksVersion` is declared as a hidden field with `default: 1`
		// in `load-nodes-and-credentials.ts`. n8n's serializer drops fields whose
		// value matches the descriptor default, so legitimate hook configs land
		// in storage WITHOUT this discriminator. The parser used to bail on the
		// `'executionsHooksVersion' in value` check and return null, which made
		// the publish-time validator throw "dynamic credentials require a
		// trigger with an identity extractor" even when the hook was set
		// correctly in the editor.

		it('parses successfully when version is absent but the hook collection is present', () => {
			const result = toExecutionContextEstablishmentHookParameter({
				path: 'monday',
				options: {},
				responseMode: 'responseNode',
				authentication: 'jwtAuth',
				contextEstablishmentHooks: {
					hooks: [{ hookName: 'HttpHeaderExtractor' }],
				},
			});

			expect(result).not.toBeNull();
			expect(result!.success).toBe(true);
			if (result!.success) {
				expect(result!.data.executionsHooksVersion).toBe(1);
				expect(result!.data.contextEstablishmentHooks.hooks).toHaveLength(1);
				expect(result!.data.contextEstablishmentHooks.hooks[0].hookName).toBe(
					'HttpHeaderExtractor',
				);
			}
		});

		it('preserves hook configuration fields beyond hookName (zod loose mode)', () => {
			const result = toExecutionContextEstablishmentHookParameter({
				contextEstablishmentHooks: {
					hooks: [
						{
							hookName: 'HttpHeaderExtractor',
							headerName: 'Authorization',
							claimPath: 'sub',
						},
					],
				},
			});

			expect(result).not.toBeNull();
			expect(result!.success).toBe(true);
			if (result!.success) {
				const hook = result!.data.contextEstablishmentHooks.hooks[0] as Record<
					string,
					unknown
				>;
				expect(hook.headerName).toBe('Authorization');
				expect(hook.claimPath).toBe('sub');
			}
		});

		it('does not override an explicit version with the default fallback', () => {
			// If the input ever carries an explicit non-1 version, we must NOT silently
			// rewrite it — the discriminated-union schema will surface the mismatch as
			// `success: false` and callers can react appropriately.
			const result = toExecutionContextEstablishmentHookParameter({
				executionsHooksVersion: 99,
				contextEstablishmentHooks: { hooks: [] },
			});

			expect(result).not.toBeNull();
			expect(result!.success).toBe(false);
		});
	});

	describe('partial inputs', () => {
		it('returns a parse failure (not null) when version is present but hook collection is missing', () => {
			// The previous early-return-null behavior masked schema errors here;
			// preserving the parse error gives callers a chance to log/diagnose.
			const result = toExecutionContextEstablishmentHookParameter({
				executionsHooksVersion: 1,
			});

			expect(result).not.toBeNull();
			expect(result!.success).toBe(false);
		});

		it('treats missing hooks array as empty (zod default)', () => {
			const result = toExecutionContextEstablishmentHookParameter({
				contextEstablishmentHooks: {},
			});

			expect(result).not.toBeNull();
			expect(result!.success).toBe(true);
			if (result!.success) {
				expect(result!.data.contextEstablishmentHooks.hooks).toEqual([]);
			}
		});
	});
});

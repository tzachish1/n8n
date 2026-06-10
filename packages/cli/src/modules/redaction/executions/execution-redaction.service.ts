import { LicenseState, Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { WorkflowExecuteMode, WorkflowSettings } from 'n8n-workflow';

import type {
	ExecutionRedaction,
	ExecutionRedactionOptions,
	RedactableExecution,
} from '@/executions/execution-redaction';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { ScopeForbiddenError } from '@/errors/response-errors/scope-forbidden.error';
import { EventService } from '@/events/event.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import type {
	IExecutionRedactionStrategy,
	RedactionContext,
} from './execution-redaction.interfaces';
import { FullItemRedactionStrategy } from './strategies/full-item-redaction.strategy';

const MANUAL_MODES: ReadonlySet<WorkflowExecuteMode> = new Set(['manual']);

/**
 * Orchestrates the execution redaction pipeline with batch permission resolution.
 *
 * Responsibilities:
 *   1. Resolve `userCanReveal` with a single DB call for any number of executions.
 *   2. Build a `RedactionContext` per execution.
 *   3. Construct the strategy pipeline based on policy and request options.
 *   4. Run each strategy in order; strategies own all data mutations.
 *
 * Policy evaluation and permission checks live here.
 * Data transformation lives in the strategies.
 */
@Service()
export class ExecutionRedactionService implements ExecutionRedaction {
	constructor(
		private readonly logger: Logger,
		private readonly licenseState: LicenseState,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly eventService: EventService,
		private readonly fullItemRedactionStrategy: FullItemRedactionStrategy,
	) {}

	async init(): Promise<void> {
		this.logger.debug('Initializing ExecutionRedactionService...');
	}

	/**
	 * Thin wrapper around `processExecutions` for single-execution callers.
	 *
	 * With `keepOriginal: true`, the original execution is never mutated. Returns
	 * either the original (if no redaction needed) or a structuredClone with
	 * redaction applied. Callers can check referential equality to determine
	 * whether redaction occurred.
	 */
	async processExecution(
		execution: RedactableExecution,
		options: ExecutionRedactionOptions,
	): Promise<RedactableExecution> {
		const executions = [execution];
		await this.processExecutions(executions, options);
		return executions[0];
	}

	/**
	 * Processes a list of executions and applies redaction based on the provided options.
	 * A single DB query resolves reveal permissions for any number of executions on both
	 * the redact and reveal paths.
	 *
	 * @param executions - The executions to process (mutated in place)
	 * @param options - Options for redaction processing
	 */
	async processExecutions(
		executions: RedactableExecution[],
		options: ExecutionRedactionOptions,
	): Promise<void> {
		if (executions.length === 0) return;

		// A queued/just-inserted execution row carries no run data yet
		// (`executionData.data` is empty until the runner writes its first
		// snapshot). The repository's unflatten step returns `data: undefined`
		// for those rows. There is nothing to redact and no policy to apply,
		// so short-circuit before any strategy reads `execution.data.*` and
		// crashes on the undefined. Surfaces under parallel evaluations,
		// which leave several rows in `new` state long enough for FE polling
		// to catch them mid-flight.
		const processable = executions.filter(
			(e): e is RedactableExecution & { data: NonNullable<RedactableExecution['data']> } =>
				e.data !== undefined && e.data !== null,
		);
		if (processable.length === 0) return;

		// Single DB call shared by both the reveal and redact paths.
		// Only executions where policy doesn't already grant access need a scope check.
		const needsCheck = processable.filter((e) => !this.policyAllowsReveal(e));
		let revealableIds = new Set<string>();
		if (needsCheck.length > 0) {
			const uniqueWorkflowIds = [...new Set(needsCheck.map((e) => e.workflowId))];
			revealableIds = await this.workflowFinderService.findWorkflowIdsWithScopeForUser(
				uniqueWorkflowIds,
				options.user,
				['execution:reveal'],
			);
		}

		// Reveal path: validate all permissions atomically before any processing.
		if (options.redactExecutionData === false) {
			// Dynamic credential executions can never be revealed by anyone other
			// than the user who triggered the manual run. See `isSelfManualReveal`
			// in the per-execution loop below for the rationale; this guard is
			// the explicit-reveal counterpart and must apply the same exception.
			for (const execution of processable) {
				if (
					this.hasDynamicCredentials(execution) &&
					!this.isSelfManualReveal(execution, options.user)
				) {
					throw new ForbiddenError();
				}
			}

			for (const execution of needsCheck) {
				if (!revealableIds.has(execution.workflowId)) {
					// Emit audit event before throwing error
					this.eventService.emit('execution-data-reveal-failure', {
						user: options.user,
						executionId: execution.id ?? '',
						workflowId: execution.workflowId,
						ipAddress: options.ipAddress ?? '',
						userAgent: options.userAgent ?? '',
						redactionPolicy: this.resolvePolicy(execution),
						rejectionReason: 'User lacks execution:reveal scope for this workflow',
					});
					throw new ScopeForbiddenError(
						"You do not have permission to reveal execution data. The 'execution:reveal' scope is required.",
						{ errorCode: 'EXECUTION_REVEAL_FORBIDDEN', requiredScope: 'execution:reveal' },
						'Contact a project admin to request the required scope.',
					);
				}
			}
		}

		// Unified pipeline execution. buildPipeline excludes FullItemRedactionStrategy on the
		// reveal path (redactExecutionData === false).

		for (let i = 0; i < executions.length; i++) {
			const execution = executions[i];
			// Pre-filtered above — skip data-less rows so the strategies and
			// dynamic-credential checks below can rely on a populated payload.
			if (execution.data === undefined || execution.data === null) continue;
			const hasDynCreds = this.hasDynamicCredentials(execution);
			const isSelfManualReveal = this.isSelfManualReveal(execution, options.user);
			const policyAllowsReveal = this.policyAllowsReveal(execution);
			// Dynamic-credential executions are still hidden from anyone who is
			// not the user that triggered the manual run — that's the
			// cross-tenant guarantee. The owner viewing their own manual run
			// goes through the normal reveal gate (policy + workflow scope).
			const userCanReveal =
				hasDynCreds && !isSelfManualReveal
					? false
					: policyAllowsReveal || revealableIds.has(execution.workflowId);
			const context: RedactionContext = {
				user: options.user,
				redactExecutionData: options.redactExecutionData,
				userCanReveal,
				hasDynamicCredentials: hasDynCreds,
				isSelfManualReveal,
				memo: new Map(),
			};
			const pipeline = this.buildPipeline(execution, context, policyAllowsReveal, hasDynCreds);

			let target = execution;
			if (options.keepOriginal) {
				const needsClone = pipeline.some((s) => s.requiresRedaction(execution, context));
				if (!needsClone) continue;
				target = structuredClone(execution);
				executions[i] = target;
			}

			for (const strategy of pipeline) {
				await strategy.apply(target, context);
			}

			// runtimeData.credentials contains encrypted credential context that
			// must never be exposed in API responses
			if (hasDynCreds && target.data.executionData?.runtimeData) {
				delete target.data.executionData.runtimeData.credentials;
			}
		}

		// Emit audit events after all executions have been successfully processed.
		// Iterate over `processable` so a queued (data-undefined) row in the
		// batch doesn't trip `resolvePolicy`. There is nothing to "reveal" on
		// a row that carries no payload, so its omission from the audit trail
		// matches reality — the API response for that entry has `data: null`.
		if (options.redactExecutionData === false) {
			for (const execution of processable) {
				this.eventService.emit('execution-data-revealed', {
					user: options.user,
					executionId: execution.id ?? '',
					workflowId: execution.workflowId,
					ipAddress: options.ipAddress ?? '',
					userAgent: options.userAgent ?? '',
					redactionPolicy: this.resolvePolicy(execution),
				});
			}
		}
	}

	/**
	 * Constructs the ordered strategy pipeline for this execution.
	 *
	 * - `FullItemRedactionStrategy` is included when items should be cleared:
	 *   explicit redact (`redactExecutionData === true`), policy=all, or
	 *   policy=non-manual on a non-manual execution mode, or dynamic credentials.
	 *   It is never included on the reveal path (`redactExecutionData === false`).
	 *
	 * Note: `NodeDefinedFieldRedactionStrategy` (node-declared `sensitiveOutputFields`)
	 * is intentionally not wired in here. The previous always-on behaviour broke
	 * partial/single-step execution because the FE replays the redacted push payload
	 * back to the server, and is being redesigned. Re-introduce only after the
	 * product approach (per-workflow gating + partial-run rehydration) is settled.
	 */
	private buildPipeline(
		execution: RedactableExecution,
		context: RedactionContext,
		policyAllowsReveal: boolean,
		hasDynamicCredentials: boolean,
	): IExecutionRedactionStrategy[] {
		const pipeline: IExecutionRedactionStrategy[] = [];

		const policy = this.resolvePolicy(execution);
		// `isSelfManualReveal` exempts the triggering user from the dynamic-cred
		// auto-redaction so they can see their own manual-run output in the
		// editor, while still applying the workflow's configured policy
		// (`policyAllowsReveal`) and any explicit `redactExecutionData=true`
		// override. Production / cross-user paths fall through unchanged.
		const dynamicCredsForceClear = hasDynamicCredentials && !context.isSelfManualReveal;
		const shouldClearItems =
			context.redactExecutionData !== false &&
			(context.redactExecutionData === true ||
				dynamicCredsForceClear ||
				(!policyAllowsReveal &&
					(policy === 'all' ||
						(policy === 'non-manual' && !MANUAL_MODES.has(execution.mode)) ||
						(policy === 'manual-only' && MANUAL_MODES.has(execution.mode)))));

		if (shouldClearItems) {
			pipeline.push(this.fullItemRedactionStrategy);
		}

		return pipeline;
	}

	/**
	 * Returns true when the execution used dynamic credential resolution.
	 * Such executions are hidden from everyone except the user who triggered
	 * the manual run (see `isSelfManualReveal`).
	 *
	 * Checks per-node `usedDynamicCredentials` flag which is only set when
	 * resolution actually happened at runtime, rather than checking for the
	 * mere presence of credential context infrastructure.
	 */
	private hasDynamicCredentials(execution: RedactableExecution): boolean {
		return Object.values(execution.data.resultData?.runData ?? {}).some((taskDataList) =>
			taskDataList.some((taskData) => taskData.usedDynamicCredentials),
		);
	}

	/**
	 * Returns true when the request comes from the same user that triggered a
	 * manual execution. Used to exempt that user from the otherwise-strict
	 * dynamic-credential redaction rule.
	 *
	 * Why this is safe: dynamic credentials by definition resolve against the
	 * triggering user's identity, so the resulting data already belongs to that
	 * user — showing it back to them is no different from running the workflow
	 * live in their browser. Other users still get redacted output (preserving
	 * the cross-tenant guarantee), and production / cron / webhook executions
	 * have no `manualData.userId` so they never match.
	 */
	private isSelfManualReveal(
		execution: RedactableExecution,
		user: { id: string } | undefined,
	): boolean {
		if (!user?.id) return false;
		if (!MANUAL_MODES.has(execution.mode)) return false;
		const triggerUserId = execution.data.manualData?.userId;
		return Boolean(triggerUserId) && triggerUserId === user.id;
	}

	/**
	 * Returns true when the resolved redaction policy inherently allows everyone to access
	 * unredacted data — i.e. the policy would not have redacted the execution in the first
	 * place.  The two cases are:
	 *   - policy === 'none': redaction is completely disabled.
	 *   - policy === 'non-manual' AND the execution mode is manual: manual executions are
	 *     exempt from this policy, so the data is still accessible to all.
	 */
	private policyAllowsReveal(execution: RedactableExecution): boolean {
		const policy = this.resolvePolicy(execution);
		return (
			policy === 'none' ||
			(policy === 'non-manual' && MANUAL_MODES.has(execution.mode)) ||
			(policy === 'manual-only' && !MANUAL_MODES.has(execution.mode))
		);
	}

	/**
	 * Resolves the effective redaction policy for an execution.
	 *
	 * Prefers the policy captured in `runtimeData.redaction` at execution time,
	 * falls back to `workflowData.settings` for older executions, and defaults to 'none'.
	 * Returns 'none' when the data-redaction license is not active, so that
	 * user-configured policies are not applied without the license.
	 */
	private resolvePolicy(execution: RedactableExecution): WorkflowSettings.RedactionPolicy {
		if (!this.licenseState.isDataRedactionLicensed()) return 'none';

		return (
			execution.data.executionData?.runtimeData?.redaction?.policy ??
			execution.workflowData.settings?.redactionPolicy ??
			'none'
		);
	}
}

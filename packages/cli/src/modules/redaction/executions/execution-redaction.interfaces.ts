import type { User } from '@n8n/db';

import type { RedactableExecution } from '@/executions/execution-redaction';

/**
 * Context passed to every redaction strategy by the orchestrator.
 * The orchestrator resolves `userCanReveal` once (single DB call) and shares
 * the result so individual strategies never need to perform permission checks.
 */
export interface RedactionContext {
	readonly user: User;
	readonly redactExecutionData: boolean | undefined;
	/** Pre-resolved by the orchestrator — true if the user can see unredacted data. */
	readonly userCanReveal: boolean;
	/** True when the execution used dynamic credential resolution. */
	readonly hasDynamicCredentials: boolean;
	/**
	 * True when the execution ran in manual mode and was triggered by the same
	 * user that is currently requesting the data. The strict no-reveal rule for
	 * dynamic-credential executions is relaxed in this case because the data is
	 * the requesting user's own (no cross-tenant exposure): a per-user dynamic
	 * credential by definition resolves against the triggering user's identity,
	 * so showing them the result is equivalent to running the workflow live in
	 * their own browser. Production runs (cron / webhook / scheduled) and runs
	 * triggered by a different user are unaffected.
	 */
	readonly isSelfManualReveal: boolean;
	/** Generic memo store — strategies may cache intermediate results here
	 *  to avoid redundant computation across requiresRedaction/apply calls.
	 *  Keyed by strategy name. */
	readonly memo: Map<string, unknown>;
}

/**
 * A composable unit of redaction logic.  Strategies are pure data transformers:
 * they mutate `execution` in place and own any side-effects they need to apply
 * (e.g. setting `execution.data.redactionInfo`).
 *
 * Strategies MUST NOT evaluate policy or check permissions — those decisions
 * are made by the orchestrator when building the pipeline.
 */
export interface IExecutionRedactionStrategy {
	readonly name: string;
	apply(execution: RedactableExecution, context: RedactionContext): Promise<void>;
	/** Returns true if apply() would mutate the execution data. Used by the
	 *  copy-on-write path to avoid unnecessary cloning. */
	requiresRedaction(execution: RedactableExecution, context: RedactionContext): boolean;
}

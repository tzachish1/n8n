# CUSTOMS.md — Fork Customization Ledger

This document is the **single source of truth** for everything this fork adds on
top of upstream `n8nio/n8n`. Every time you upgrade the fork to a new upstream
release, start here.

## How to use this file during an upgrade

1. Read the **Upgrade Procedure** at the bottom.
2. For every customization below, re-verify:
   - The listed commits still apply cleanly (or note where they drifted).
   - The listed files still exist upstream (upstream renames break rebases silently).
   - The listed env vars / DB rows still match the runtime contract.
3. If you add a new customization, append a section here **in the same PR**.
4. Keep the baseline tags list current (see **Baseline tags**).

## Baseline tags

We always branch from the upstream release tag, never from upstream `master`.

| Fork branch                              | Upstream tag | Commits on top | Notes                                              |
|------------------------------------------|--------------|---------------:|----------------------------------------------------|
| `feat/upgrade-to-n8n-2.13.3`             | `n8n@2.13.3` | (unsquashed)   | initial node-governance introduction               |
| `feat/upgrade-to-n8n-2.15.1`             | `n8n@2.15.1` | (unsquashed)   | intermediate upgrade                               |
| `feat/upgrade-to-n8n-2.17.5`             | `n8n@2.17.5` | 7              | OIDC provisioning hardening, audit enrich — **squashed one commit per feature area** |
| `feat/upgrade-to-n8n-2.17.7`             | `n8n@2.17.7` | 9              | type-safe Node Governance modal data; chore folded into a fresh `chore(upgrade-2.17.7)`; CI workflow trim added as Section 8; audit/log-streaming login events added under Section 3 |
| `feat/upgrade-to-n8n-2.19.2`             | `n8n@2.19.2` | 8              | absorbed `oidc.controller.ee.test.ts` 7th `EventService` mock, `import.service.ts` `Partial<WorkflowEntity>` cast (TS2589 workaround), `node-governance.service.ts` typeorm-import escape hatch, `NodeCreator.test.ts` `vi.mock` import-style fix; chore folded into `chore(upgrade-2.19.2)`. |
| `feat/upgrade-to-n8n-2.20.7-exp.0`        | `n8n@2.20.7-exp.0` | 8 | reverted the 2.19.2-era `Partial<WorkflowEntity>` cast in `import.service.ts` (upstream `tx.upsert` no longer triggers TS2589, and keeping the cast itself now does); added 20th `mock<OwnershipService>()` to `execution.service.integration.test.ts` (upstream constructor reached 19 args, governance adds the 20th); SSRF refactor (`SsrfProtectionConfig` + `SsrfProtectionService` injection) re-merged with §1 governance enforcement in `workflows.controller.ts`; Azure APIM credentials kept fork superset (APIM + `approvedModels` + `Resource Name`) over upstream's bare drop; `release-build-daytona-snapshot.yml` deleted as part of §8 trim; chore folded into `chore(upgrade-2.20.7-exp.0)`. |
| `feat/upgrade-to-n8n-2.20.9`             | `n8n@2.20.9` | 8 | small upgrade — 7 upstream commits (`1bb97d8392..38294c02d7`), 36 files, 0 customization-hotspot collisions in the pre-flight analysis. §1 needed a 12-line `execution-lifecycle-hooks.ts` + `workflow-execution.service.ts` re-wire (`projectId: project.id` → `ownerProject?.id` on the `'chat'` source path); folded into `chore(upgrade-2.20.9)`. §5 absorbed upstream PR n8n-io/n8n#30478's alpine 3.22→3.23 migration (`NODE_VERSION` 24.14.1→24.15.0; stage-2 paths `/usr/local/lib/node_modules` → `/usr/lib/node_modules` and `/usr/local/bin/n8n` → `/usr/bin/n8n`) — the merged-after-2.20.9 PR republished `n8nio/base:24.14.1` with the new DHI alpine 3.23 layout where `/usr/local/` doesn't exist by default, breaking n8n@2.20.9 source builds at the symlink step; folded into `chore(upgrade-2.20.9)` alongside the cli wiring fix. Picked up free from upstream: resource-center tooltip removal (#30476), `ObservableObject` proxy-layer-accumulation fix (#30505), VM-expression nested-array preservation fix (#30334). |
| `feat/upgrade-to-n8n-2.22.4` (current)   | `n8n@2.22.4` | 8 | medium upgrade — landed all 8 customizations, then squashed mid-cycle follow-ons back into their feature commits to keep the convention. §3 OIDC absorbed two code follow-ons (diag ID-token claim fingerprint logging + access-token claim fallback when ID token omits roles) directly into `feat(sso-oidc)`. §7 chore absorbed cherry-pick collateral (`oidc.controller.ee.ts` + test double-`eventService` DI dedupe from §3 auto-merge; `NodeAccessRequestModal.vue` `workflowsStore.workflow` → `injectWorkflowDocumentStore().value?.name` after upstream marked `.workflow` private; `oidc.service.ee.test.ts` `rejects.toThrow(new BadRequestError(...))` → split `toThrow(BadRequestError)` + `toThrow('message')` for the new `n8n-local-rules/no-error-instance-in-to-throw` rule) on top of the 2.20.9-era chore content (`.gitignore` additions, Dockerfile alpine path migration, governance DTO shims) — renamed to `chore(upgrade-2.22.4)`. §8 docs absorbed two CUSTOMS.md-only follow-ons (Azure Entra v1-token edge-case troubleshooting row + recommended v1 OIDC settings row; cherry-pick-variation + manual-smoke-findings ledger entries). Upstream collisions resolved: §3 PR n8n-io/n8n#29856 absorbed our `user-login-failed` emit shape, making the §3 `auth.controller.ts` parameter-rename conflict redundant (kept HEAD); §5 Dockerfile combined HEAD's `npm rebuild sqlite3` with fork's `JOBS=1 npm rebuild isolated-vm`; kept HEAD's `alpine3.22` over incoming `alpine3.23` (consistency with upstream 2.22.4 pinning). §8 CI trim: 34 modify/delete conflicts resolved by honoring fork deletions; 3 UU files (`ci-master.yml`, `ci-pull-requests.yml`, `docker-build-smoke.yml`) preserved fork's removal of e2e/security/Slack notifications and daily cron triggers while keeping upstream functional changes. Required tooling fixes: `pnpm install` (new `@n8n/engine` package), force-rebuild of `@n8n/eslint-plugin-community-nodes` (stale turbo cache restored 8-of-35 rules from a 2.20.9-era build), and `NODE_OPTIONS=--max-old-space-size=10240` for `pnpm lint` (cli package OOMs the 4 GB default). New troubleshooting rows added below. |

## Commit-structure convention

Starting with `feat/upgrade-to-n8n-2.17.5`, each feature area is **a single
commit** on the branch. The original granular commits were preserved until the
upgrade was verified and then squashed. This is the preferred shape because:

- Future upgrades cherry-pick **one commit per customization**.
- Reverting an entire feature area is one command.
- Each commit's message is the source of truth for what that area does.

If you need the pre-squash granular history, it is archived under
`backup/pre-squash-<version>` tags (local) and in the list of "Original
component commits" inside each section below.

## Customization catalogue

Customizations are grouped by feature area. For each one:
- **What & why** — one-liner and business driver
- **Commits** — SHAs on the current branch (newest last)
- **Entry points / key files** — where upstream changes will most likely collide
- **Runtime contract** — env vars, DB rows, claim names, label names, etc.
- **Upgrade checklist** — things that have bitten us before

### 1. Node Governance (primary feature)

**What & why.** Controls which nodes users can use. Adds policies, categories,
access requests, project-level overrides, and an approval workflow. This is the
most invasive customization — it touches DB, API, FE, permissions, and audit.

**Commit on current branch (single, squashed)**
- `f4473c8b1f feat(node-governance): introduce node governance with audit, enforcement, and per-project overrides`

**Original component commits (pre-squash, archived in `backup/pre-squash-2.17.5`)**
- `506b1a2cb6` initial node governance feature
- `d709bd28d6` post-merge compatibility fixes on 2.13.3
- `41f67a23b4` resolve build errors from governance migration DSL
- `c6732cb188` audit logging for governance events
- `da261c4cfb` enforce governance on workflow create and import
- `eb414339e7` configurable default behavior
- `150cc64a3c` idempotent default-behavior migration
- `20cdd36748` hide project overrides unless global default is block
- `3ff5e79c8d` use CSS grid for project override rows
- `53f525864f` include project name in settings-updated audit payload

**Entry points / key files**

*Backend*
- `packages/@n8n/db/src/entities/node-access-request.ts`
- `packages/@n8n/db/src/entities/node-category.ts`
- `packages/@n8n/db/src/entities/node-category-assignment.ts`
- `packages/@n8n/db/src/entities/node-governance-policy.ts`
- `packages/@n8n/db/src/entities/policy-project-assignment.ts`
- `packages/@n8n/db/src/entities/project.ts` *(adds `governanceDefaultBehavior` column)*
- `packages/@n8n/db/src/migrations/common/1768981346000-AddNodeGovernanceTables.ts`
- `packages/@n8n/db/src/migrations/common/1772850000000-AddGovernanceDefaultBehavior.ts`
- `packages/@n8n/db/src/migrations/common/1778500000000-AddPendingAccessRequestUniqueIndex.ts` *(added by Cubic-AI backport, see below)*
- `packages/@n8n/db/src/migrations/postgresdb/index.ts` *(registers migrations)*
- `packages/@n8n/db/src/migrations/sqlite/index.ts` *(registers migrations)*
- `packages/@n8n/db/src/repositories/*.ts` (five new repositories)
- `packages/cli/src/controllers/node-governance.controller.ts`
- `packages/cli/src/services/node-governance.service.ts`
- `packages/cli/src/workflows/workflow.service.ts` *(governance enforcement on create/update/import)*
- `packages/cli/src/workflows/workflow-creation.service.ts`
- `packages/cli/src/workflows/workflows.controller.ts`
- `packages/cli/src/execution-lifecycle/execution-lifecycle-hooks.ts`
- `packages/cli/src/workflow-runner.ts`
- `packages/cli/src/events/maps/relay.event-map.ts` *(adds `node-governance-*` events)*
- `packages/cli/src/events/relays/log-streaming.event-relay.ts`
- `packages/cli/src/eventbus/event-message-classes/event-message-audit.ts`
- `packages/cli/src/commands/export/node-governance.ts`
- `packages/cli/src/commands/import/node-governance.ts`
- `packages/cli/src/commands/seed-node-governance.ts`
- `packages/@n8n/api-types/src/dto/node-governance/*` *(DTOs)*
- `packages/@n8n/permissions/src/constants.ee.ts` *(new `nodeGovernance:*` scopes)*
- `packages/@n8n/permissions/src/roles/scopes/global-scopes.ee.ts`

*Frontend*
- `packages/frontend/editor-ui/src/features/settings/nodeGovernance/**`
- `packages/frontend/editor-ui/src/app/stores/rbac.store.ts`
- `packages/frontend/editor-ui/src/app/stores/settings.store.ts`
- `packages/frontend/editor-ui/src/app/router.ts`
- `packages/frontend/editor-ui/src/app/constants/navigation.ts`
- `packages/frontend/editor-ui/src/app/composables/useSettingsItems.ts`
- `packages/frontend/editor-ui/src/features/shared/nodeCreator/components/ItemTypes/NodeItem.vue`
- `packages/frontend/editor-ui/src/features/shared/nodeCreator/components/NodeCreator.vue`
- `packages/frontend/editor-ui/src/features/workflows/templates/utils/templateActions.ts`
- `packages/frontend/@n8n/i18n/src/locales/en.json`

*Tests*
- `packages/testing/playwright/pages/NodeGovernancePage.ts`
- `packages/testing/playwright/services/node-governance-api-helper.ts`
- `packages/testing/playwright/tests/e2e/settings/node-governance/node-governance.spec.ts`
- Jest tests next to the files above.

**Runtime contract**
- DB tables: `node_governance_policy`, `node_category`, `node_category_assignment`,
  `node_access_request`, `policy_project_assignment`.
- DB column: `project.governance_default_behavior` *(nullable enum `allow|block|inherit`)*.
- Settings key: `features.governance.defaultBehavior` *(JSON-stringified `allow|block`)*.
- Scopes: `nodeGovernance:manage`, `nodeGovernance:read`, `nodeGovernance:requestAccess`,
  `nodeGovernance:reviewAccessRequests` (see `packages/@n8n/permissions/src/constants.ee.ts`).
- Audit events (all start with `n8n.audit.node-governance.*`):
  - `...settings.updated` — carries `payload.projectId` **and `payload.projectName`**.
  - `...categories.imported`, `...request.{created,approved,rejected}`,
    `...policy.{created,updated,deleted}`.

**Cubic-AI fixes backport (2026-04-29)**

Backport of upstream PR [n8n-io/n8n#29442](https://github.com/n8n-io/n8n/pull/29442) review-comment fixes from `feat/node-governance` (master-based) into this branch via [self-PR #2](https://github.com/tzachish1/n8n/pull/2). Both rounds of Cubic-AI feedback (20 issues) are addressed; one item is intentionally excluded — see below.

**Cherry-picks landed on current branch**
- `2583379001 fix(core): Address Cubic-AI P1/P2/P3 review comments for node governance (GHC-6560)` — round 1, 13 fixes, cherry-picked from upstream `9caf4032fe`.
- `c37ce5eb3c fix(core): Address Cubic-AI round 2 review comments for node governance (GHC-6560)` — round 2, 7 fixes, cherry-picked from upstream `aed3bef4d3`.
- `5a83936c1b Merge pull request #2 from tzachish1/fix/governance-cubic-fixes-2.17.7` — merge commit (preserves both `(cherry picked from commit ...)` provenance lines).

**What changed (high level)**

*Backend correctness/robustness*
- Migrations: `AddGovernanceDefaultBehavior` is now prefix-aware (escapes table/column names so non-default `tablePrefix` setups don't break).
- New migration: [`packages/@n8n/db/src/migrations/common/1778500000000-AddPendingAccessRequestUniqueIndex.ts`](packages/@n8n/db/src/migrations/common/1778500000000-AddPendingAccessRequestUniqueIndex.ts) — partial unique index on `node_access_request(requestedById, nodeType, projectId) WHERE status='pending'`. `createAccessRequest` catches the unique-violation race and returns the conflicting pending request.
- `node-governance.service`: `pending_request` nodes are treated as blocked during workflow validation (an access-request submission can no longer bypass enforcement until approval); `updatePolicy` is wrapped in `withTransaction` so policy update + assignment replacement commit/rollback together.
- `policy-project-assignment.repository.replaceAssignments`: switched to the `withTransaction` helper so the delete + insert is atomic regardless of caller.
- `node-category.repository.updateCategory`: skips `em.update` on empty `data` (avoids `UpdateValuesMissingError`).
- `node-category-assignment.repository.findByNodeTypes` and `node-governance-policy.repository.findByProjectIds`: empty-array short-circuit so `In([])` cannot generate invalid SQL.
- `workflows/workflow.service.ts`: governance check now uses `ownerProject.id` (deterministic) instead of a non-deterministic `sharedWorkflowRepository.findOne` lookup, so project-scoped policies resolve correctly when a workflow is shared with multiple projects. Error message clarified to mention "blocked or pending approval". Defensive `validation?.hasBlockedNodes` guard kept (2.17.7-only).
- `workflow-runner.ts`: governance enforcement falls back to `OwnershipService.getWorkflowProjectCached(workflowId)` when `data.projectId` is missing (scheduled / sub-workflow paths previously bypassed enforcement). New `OwnershipService` constructor injection.
- `node-governance.controller.updatePolicy`: mirrors `createPolicy`'s `projectIds` guard (rejects inconsistent project-scoped policies).
- DTOs (`create-category`, `update-category`, `create-policy`, `update-policy`): trim `displayName`/`description`/`targetValue`.

*Frontend*
- `nodeGovernance` store: dedupe in-flight `fetchGovernanceData` calls and use a sequence number to drop stale responses; removed the `clearGovernanceData()` call from `NodeCreator` that caused the empty-state flicker race.
- `CategoryNodesModal.addSelectedNodes`: track per-node success; only remove successfully-added nodes from the selection (retries don't re-attempt already-assigned nodes).
- `CategoriesTab` / `RequestsTab` / `PoliciesTab`: clamp `currentPage` when the filtered list shrinks or `itemsPerPage` changes.
- Governance modals (`Approve` / `Reject` / `Review` / `NodeAccessRequest` / `CategoryFormModal` / `CategoryNodesModal`): replaced hardcoded spacing/sizing/typography/radius values with design-system tokens; replaced hardcoded English copy in `CategoryFormModal` with i18n keys.
- `NodeItem.vue`: deduped duplicate `.iconWrapper` SCSS selector.
- `NodeCreatorNode.vue` (design-system): `afterTitle` slot moved after `ElTag` to preserve `v-if/v-else-if` adjacency in `NodeCreatorNode` (tag branch was being lost).
- `en.json`: added 11 new `nodeGovernance.categories.form.*` i18n keys (round 1); removed 7 duplicate keys (`generic.update`, `generic.edit`, `nodeGovernance.categories.form.{displayName,slug,description,color}`, `nodeCreator.nodeItem.deprecated`) — round 2.

**Intentional exclusion: `packages/frontend/editor-ui/src/app/init.ts`**

The round-2 hunk for `init.ts` from upstream commit `aed3bef4d3` was deliberately dropped during cherry-pick. Cubic's change *removes* the `state.initialized = false` and `authenticatedFeaturesInitialized = false` reset in the logout hook to avoid duplicate auth-hook registration on master. **On 2.17.7 we keep that reset** because it fixes a different, locally-reported bug: without it, role changes require 2 login/logout cycles to take effect (see commit `a6b4020e93`). The Cubic finding is specific to master's surrounding code (newer login-hook re-fetch logic), is not reproducible on 2.17.7's older init flow, and removing the reset would regress the existing fix on this branch. The exclusion is recorded in `c37ce5eb3c`'s commit-message footer and in PR #2's body.

**Validation captured at backport time**

| | baseline (pre-cherry-pick) | post-cherry-pick | delta |
|---|---|---|---|
| `pnpm --filter @n8n/db typecheck` | 0 errors | 0 | = |
| `pnpm --filter n8n typecheck` | 7 errors | 7 | = (same 7 pre-existing) |
| `pnpm --filter n8n-editor-ui typecheck` | 45 errors | 7 | **−38** (Cubic's added i18n keys regenerated `BaseTextKey`, clearing pre-existing key-mismatch errors) |
| `en.json` JSON parse | OK | OK | = |
| `en.json` duplicate keys | n/a | 0 | ✓ |

**Rollback path**

- Local-only safety branch `backup/upgrade-2.17.7-pre-governance-fixes` retained at `04a3a5cc90` (the pre-backport tip). Keep it until at least one successful build/test cycle on 2.17.7.
- Remote rollback if needed: `git revert -m 1 5a83936c1b` then push.

**Upgrade checklist**
- After rebase, **run `pnpm build` and confirm the three governance migrations still register** in both `postgresdb/index.ts` and `sqlite/index.ts` (`AddNodeGovernanceTables1768981346000`, `AddGovernanceDefaultBehavior1772850000000`, `AddPendingAccessRequestUniqueIndex1778500000000`). Upstream frequently adds migrations and the merge tool can drop our lines silently.
- `packages/@n8n/db/src/entities/project.ts` is a hotspot — upstream often extends the entity; make sure `governanceDefaultBehavior` survives.
- If upstream refactors `WorkflowService.create/update/import` signatures, re-wire the governance enforcement call at the same call-site.
- If upstream refactors `WorkflowRunner`'s constructor, the `OwnershipService` parameter added by the Cubic-AI backport is a hotspot — preserve it (and the `governanceProjectId` fallback inside `runMainProcess`).
- If upstream changes `init.ts` again, **re-verify the role-change reset block (`state.initialized = false; authenticatedFeaturesInitialized = false;` inside `usersStore.registerLogoutHook`) is preserved** — it's the deliberate exclusion from Cubic's round-2 fix.
- FE side: any upstream refactor of settings navigation / RBAC store can silently remove the `nodeGovernance` entry. Verify the menu item actually appears for an owner user.
- FE side: `NodeItem.vue` (`isBlocked` / `isPendingRequest` / `_governanceStatus`) and `Renderers/ItemsRenderer.vue` (`isNodeBlocked`) have fallback paths for items not pre-augmented by `NodeCreator.augmentNodesWithGovernance`. The fallback **must** call `nodeGovernanceStore.resolveGovernanceForNode(name)`, **not** `getGovernanceForNode(name)`. The latter is a pure read of the `nodeGovernanceStatus` cache, which is only populated by `resolveGovernanceForNode` — so view-stack sub-nodes (the entire `AI` subcategory of `@n8n/n8n-nodes-langchain.*` is the canonical example) get cache miss → undefined → treated as allowed. The BE save guard at `workflow.service.ts:413-419` catches the leak with the `Cannot save workflow: ... blocked or pending approval ...` error, but the UX is wrong. If upstream restructures node-creator render paths, re-verify the fallback uses the resolver, not the cache reader.
- `packages/cli/src/workflows/workflows.controller.ts` now also carries SSRF protection (`SsrfProtectionConfig` + `SsrfProtectionService` injection added in upstream 2.20.x and `fetchWorkflowFromUrl` helper). When re-wiring governance enforcement on create / update / import, preserve **both** the SSRF deps in the constructor and the governance call after the URL fetch resolves (governance check is shape-agnostic; it runs after JSON-shape validation, before persistence).
- `packages/cli/src/executions/execution.service.ts` constructor parameter count drifts upward each upgrade (was 18 on 2.17.7, 19 on 2.20.7-exp.0; our governance commit adds 1 → 20). Any new upstream injection bumps the count again — keep the test mocks in `execution.service.integration.test.ts` and the `n8n-pulse` registration site in lock-step.

### 2. Akeyless External Secrets Provider

**What & why.** Adds Akeyless (https://www.akeyless.io) as a first-class
external-secrets backend alongside the upstream Vault / AWS Secrets Manager
providers. Needed for enterprise deployments.

**Commit on current branch (single, squashed)**
- `cf03e9c640 feat(external-secrets): add Akeyless provider with subfolder support and log redaction`

**Original component commits (pre-squash)**
- `1b64b95a60` initial Akeyless provider
- `91779a852e` subfolder traversal + string-secret handling
- `2b210262cd` redact sensitive payloads from interceptor logs

**Entry points / key files**
- `packages/cli/src/modules/external-secrets.ee/providers/akeyless.ts`
- `packages/cli/src/modules/external-secrets.ee/providers/__tests__/akeyless.test.ts`
- `packages/cli/src/modules/external-secrets.ee/external-secrets-providers.ee.ts` *(registers `akeyless`)*
- `packages/@n8n/api-types/src/schemas/secrets-provider.schema.ts` *(adds `'akeyless'` to union)*
- `packages/frontend/editor-ui/src/features/integrations/externalSecrets.ee/assets/images/akeyless.svg`
- `packages/frontend/editor-ui/src/features/integrations/externalSecrets.ee/components/ExternalSecretsProviderImage.ee.vue`
- `packages/frontend/editor-ui/src/features/integrations/secretsProviders.ee/components/SecretsProviderImage.ee.vue`

**Runtime contract**
- Provider name in DB / UI: `akeyless`.
- Supports **both** static / dynamic secret types and nested folders.
- **Must never log the `body`/`data` of an Akeyless response.** The axios
  request/response interceptors only log method, URL and status. This was the
  third pre-squash commit in the area; if it's ever reverted, secrets will
  leak to container logs.

**Upgrade checklist**
- If upstream renames the `SecretsProvider` interface or changes `init`/`update`/`get` signatures, update `akeyless.ts` the same way.
- If upstream adds more secret types to `secrets-provider.schema.ts` union, preserve `'akeyless'` in the union.
- Keep the logs-redaction commit; a regression would leak secrets to container logs.

### 3. OIDC / SSO Provisioning Hardening (Azure Entra)

**What & why.** Upstream's OIDC provisioning expects a single claim name and a
rigid DB row shape. We need:
- Role mapping from Azure App Roles (`roles` claim, not `n8n_instance_role`).
- Tolerance of legacy DB rows missing newer required Zod fields (`scopesUseExpressionMapping`).
- Fallback resolution for common claim names when the configured one is missing.
- **Access-token JWT fallback** for Azure Entra v1-token edge case, where the `roles` claim is reliably emitted in the resource-scoped access token but intermittently omitted from the ID token (added 2026-05-17 on top of 2.20.9).
- Per-login claim-shape fingerprint debug log (`OIDC token claims fingerprint (loginUser)`) for triaging IdP-emit drift; values are never logged, only keys/types.
- Readable diagnostic logs when provisioning doesn't fire.

**Commit on current branch (single, squashed)**
- `2d4eb6dc8b feat(sso-oidc): harden Azure Entra direct-claim provisioning for instance and project roles`

**Original component commits (pre-squash)**
- `337ab0a67c` handle Azure AD `roles` array claim format
- `3bfa831d5e` harden OIDC instance-role claim handling for 2.17.5 (merge env defaults before Zod parse, fallback chain, alias table, diagnostic logs)

**Entry points / key files**
- `packages/cli/src/modules/sso-oidc/oidc.service.ee.ts`
  - `resolveInstanceRoleClaim()` — tries configured claim, falls back to
    `['roles', 'appRoles', 'app_roles', 'groups']` (logs a warn on fallback).
  - `applySsoProvisioning()` — info-level diagnostic log at entry (present
    claim keys, whether configured claim exists). When the ID token didn't
    yield an instance-role or project-role claim and the access token is a
    JWT, decodes the access-token payload via `decodeJwtPayloadUnsafe()` and
    re-runs claim resolution against it (third-tier fallback). Emits a `warn`
    if the access-token fallback fired so operators can see the symptom.
  - `decodeJwtPayloadUnsafe()` — base64url-decodes the middle section of a
    compact JWS without re-validating the signature. Safe because the only
    caller is `applySsoProvisioning` and the access token has already been
    validated by `openid-client`'s `authorizationCodeGrant`.
  - Per-login `OIDC token claims fingerprint (loginUser)` debug log right
    after `tokens.claims()` succeeds — only claim KEYS and the *type* of
    `roles`/`groups` (e.g. `array[1]`, `'undefined'`) plus
    `accessTokenIsJwt` are logged. No PII.
- `packages/cli/src/modules/provisioning.ee/provisioning.service.ee.ts`
  - `loadConfigurationFromDatabase()` **merges env defaults before Zod parse**
    so a legacy DB row missing `scopesUseExpressionMapping` doesn't silently
    zero-out provisioning.
  - `provisionInstanceRoleForUser()` — alias map (`admin → global:admin`,
    `member → global:member`, etc.) plus warn-level logs with troubleshooting
    hints.
- `packages/@n8n/config/src/configs/sso.config.ts`
  - Default `scopesInstanceRoleClaimName = 'roles'` (was `'n8n_instance_role'`).
- `packages/@n8n/api-types/src/dto/provisioning/config.dto.ts`
- `packages/@n8n/config/test/config.test.ts` *(matches the new default)*
- `packages/cli/src/modules/sso-oidc/__tests__/oidc.service.ee.test.ts`
- `packages/cli/src/modules/provisioning.ee/__tests__/provisioning.service.ee.test.ts`

**Runtime contract (env vars)**

| Env var                                          | Default            | Notes                                                                           |
|--------------------------------------------------|--------------------|---------------------------------------------------------------------------------|
| `N8N_SSO_OIDC_LOGIN_ENABLED`                     | `false`            | enable OIDC sign-in                                                             |
| `N8N_SSO_SCOPES_PROVISION_INSTANCE_ROLE`         | `false`            | turn on instance-role provisioning                                              |
| `N8N_SSO_SCOPES_PROVISION_PROJECT_ROLES`         | `false`            | turn on project-role provisioning                                               |
| `N8N_SSO_SCOPES_INSTANCE_ROLE_CLAIM_NAME`        | `roles`            | IdP claim holding the instance role (Azure = `roles`)                           |
| `N8N_SSO_SCOPES_PROJECTS_ROLES_CLAIM_NAME`       | `n8n_projects`     | IdP claim holding `<projectId>:<role>` entries. Can be the same as above.       |
| `N8N_SSO_SCOPES_NAME`                            | `n8n`              | scope name requested during auth                                                |
| `N8N_SSO_SCOPES_USE_EXPRESSION_MAPPING`          | `false`            | use the legacy expression-mapping path                                          |

**DB contract**

- Settings row: `key = 'features.provisioning'`, `value` is the JSON-serialized
  `ProvisioningConfigDto`.
- After upgrades, ensure the row carries **all** DTO fields; if not, our merge
  fix will repair it on first boot, but the repair only happens when the row
  is read, **so don't delete the fix**.

**Role slug format**
- Instance roles in the IdP claim: `global:admin`, `global:member`, `global:owner` (case-insensitive; aliases are mapped below).
- Project roles in the IdP claim: `<projectId>:<role>` where `<role>` is one of
  `viewer`, `editor`, `admin`. n8n internally prepends `project:` so the DB row
  becomes `project:viewer` / `project:editor` / `project:admin`. Example claim
  entry: `IXqYGz37CnKZwuLg:editor`.
- Instance-role alias table (extend as needed in `provisioning.service.ee.ts`):
  - `admin` → `global:admin`
  - `member` → `global:member`
  - `owner` → `global:owner`

**Upgrade checklist**
- If upstream adds new required fields to `ProvisioningConfigDto`, they must
  also appear with safe defaults in `ProvisioningConfig` (`sso.config.ts`). If
  not, every existing DB row will fail Zod validation silently.
- Keep the fallback list in `resolveInstanceRoleClaim()` in sync with what
  Azure Entra / Okta / Auth0 / Keycloak emit by default.
- Keep the test expectations aligned with the log wording used in
  `provisioning.service.ee.ts`.

#### Audit / log-streaming login events (2026-04-29; partially absorbed upstream in 2.22.4)

**What & why.** Two upstream gaps left login activity invisible to log-streaming
destinations (SIEM, webhook, syslog) when SSO is enabled — a hard security
problem because brute-force against the email/password endpoint was completely
silent, and OIDC successful logins were not audited at all (SAML was).

**Status as of 2.22.4:** the **failed-password-under-SSO** half is now
upstream (PR n8n-io/n8n#29856 added the `user-login-failed` emit in the
SSO-blocked path); our `auth.controller.ts` hunk was dropped from the §3
commit during cherry-pick (resolved by keeping HEAD). The
**successful-OIDC-login** half is still fork-only and remains in §3 via the
`oidc.controller.ee.ts` emit. The historical fork shapes for both halves are
preserved below so the customization can be re-applied if upstream regresses.

1. **Failed password login under SSO** *(absorbed upstream in 2.22.4 — no
   longer in §3)* — `validateSsoRestrictions` in `auth.controller.ts` threw
   an `AuthError` *before* the existing `user-login-failed` emit was reached.
   Every blocked attempt (including brute-force against the owner account,
   which is the only one that *can* still log in with email+password while
   SSO is enabled) was dropped on the floor. Upstream PR n8n-io/n8n#29856
   landed an equivalent emit; the §3 commit no longer carries the
   `auth.controller.ts` parameter-rename hunk.
2. **Successful OIDC login** *(still fork-only, in §3)* —
   `oidc.controller.ee.ts` issued the auth cookie and redirected, but never
   emitted `user-logged-in`. SAML's controller (`saml.controller.ee.ts:132`)
   already emits the same event, so this was pure parity.

The relay (`packages/cli/src/events/relays/log-streaming.event-relay.ts`)
already maps both events to `n8n.audit.user.login.failed` /
`n8n.audit.user.login.success`. Only emit sites needed adding.

**Entry points / key files**
- `packages/cli/src/controllers/auth.controller.ts` — **upstream as of 2.22.4
  (not in §3).** Recorded fork shape for re-application if upstream regresses:
  `validateSsoRestrictions(preliminaryUser, emailOrLdapLoginId)` took an
  extra parameter and emitted `user-login-failed` with
  `{ authenticationMethod: 'email', userEmail, reason: 'SSO is enabled' }`
  before `throw new AuthError(...)`; the call site passed
  `emailOrLdapLoginId` through. Upstream PR n8n-io/n8n#29856 landed an
  equivalent emit on a slightly different code path — verify upstream still
  emits it from the SSO-blocked branch on each upgrade (see checklist below).
- `packages/cli/src/modules/sso-oidc/oidc.controller.ee.ts` — **still in §3.**
  Constructor injects `EventService`. `callbackHandler()` emits
  `user-logged-in` with `{ user, authenticationMethod: 'oidc' }` after
  `issueCookie`, before `res.redirect('/')`.

**Audit events emitted (after fix)**

| Event name (audit)                | Trigger                                                    | Payload extras                            | Source as of 2.22.4                       |
|-----------------------------------|------------------------------------------------------------|-------------------------------------------|-------------------------------------------|
| `n8n.audit.user.login.failed`     | password login while SSO enabled and user not allowed      | `userEmail`, `reason: "SSO is enabled"`   | upstream (PR n8n-io/n8n#29856)            |
| `n8n.audit.user.login.success`    | successful OIDC callback                                   | `user`, `authenticationMethod: "oidc"`    | fork (§3 `oidc.controller.ee.ts`)         |

**Upgrade checklist**
- **Done in 2.22.4** — Upstream PR n8n-io/n8n#29856 added the
  `user-login-failed` emit on the SSO-blocked path; the §3
  `auth.controller.ts` parameter-rename hunk was dropped on conflict (kept
  HEAD). On future upgrades, **verify upstream still emits
  `user-login-failed` on the SSO-blocked branch** (the verification step
  below catches this). If upstream regresses or refactors the path away,
  re-apply the fork shape recorded under "Entry points / key files" above.
- Upstream may eventually add the `user-logged-in` emit in the OIDC
  controller too; if so, drop our emit to avoid double-counting.
- If upstream restructures the OIDC `callbackHandler()`, re-apply the
  `user-logged-in` emit at the equivalent point: **after `issueCookie`**
  (before redirect).
- The relay listens for both event names already (`log-streaming.event-relay.ts:63-64`);
  if upstream changes the event name or payload shape, update both the emit
  and the relay handler.

**Verification**
- Try password login with wrong credentials while OIDC SSO is enabled →
  expect `n8n.audit.user.login.failed` with `reason: "SSO is enabled"` on the
  log-streaming destination.
- Complete a successful OIDC login → expect `n8n.audit.user.login.success`
  with `authenticationMethod: "oidc"` on the log-streaming destination.

### 4. Azure OpenAI APIM support (nodes-langchain)

**What & why.** Adds OAuth2 / APIM-mediated auth to the `LmChatAzureOpenAi`
node so enterprises can route through Azure API Management.

**Commit on current branch**
- `d58298ee5d feat(nodes-langchain): add Azure API Management (APIM) support for Azure OpenAI`
  *(was `015157d75e` pre-squash, then `7b8b8b737d` on `feat/upgrade-to-n8n-2.17.5` — same diff, new SHA each rebase)*

**Entry points / key files**
- `packages/@n8n/nodes-langchain/credentials/AzureOpenAiApi.credentials.ts`
- `packages/@n8n/nodes-langchain/credentials/AzureEntraCognitiveServicesOAuth2Api.credentials.ts`
- `packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi/LmChatAzureOpenAi.node.ts`
- `packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi/properties.ts`
- `packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi/types.ts`
- `packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi/methods/listDeployments.ts`
- `packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi/credentials/oauth2.ts`
- `packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi/credentials/N8nOAuth2TokenCredential.ts`
- `packages/@n8n/nodes-langchain/nodes/llms/LmChatAzureOpenAi/__tests__/oauth2.handler.test.ts`

**Upgrade checklist**
- When upstream bumps `@langchain/*` or refactors how LLM nodes wire their clients, check that the OAuth2 token path still compiles.
- **As of `n8n@2.20.7-exp.0`, upstream now ships both `AzureOpenAiApi.credentials.ts` and `AzureEntraCognitiveServicesOAuth2Api.credentials.ts`** but without APIM. Their content is a strict subset: upstream's `AzureEntraCognitiveServicesOAuth2Api` has only a "Resource Name" field — no `useApim` toggle, no `apimBasePath`, no `apimQueryParams`, no `apimHeaders`, no `apiVersion` selector, no `tenantId` selector. Their `AzureOpenAiApi` lacks our `approvedModels` field. Resolution pattern: **keep the fork's APIM-aware shape** on conflict, layer upstream's `Resource Name` field on top, defend `approvedModels`. Future upgrades must verify these fields survived; rerun `__tests__/oauth2.handler.test.ts`.

### 5. Prometheus metrics customizations + Docker native-build splits

**What & why.** Upstream exposes minimal workflow metrics. We add
`execution_mode` and `project_id` labels so Grafana dashboards can split by
run-mode (manual/trigger/retry/webhook) and tenant. The same squashed commit
also carries the Docker `RUN`-step split for `sqlite3` / `isolated-vm`
(Apple-Silicon cross-compile), because the original commits for both were
interleaved and share `scripts/dockerize-n8n.mjs` edits.

**Commit on current branch (single, squashed)**
- `96a11fc53a feat(core): add execution_mode and project_id labels to Prometheus metrics plus Docker build splits`

**Original component commits (pre-squash)**
- `d19b7868eb` add `execution_mode` label
- `a5b5e353e3` add `project_id` label + Docker build customizations
- `68c8fd6d88` update metrics tests
- `6ca3afec2e` split sqlite3 and isolated-vm rebuild into separate RUN steps

**Entry points / key files**

*Metrics*
- `packages/cli/src/metrics/prometheus-metrics.service.ts`
- `packages/cli/src/metrics/types.ts`
- `packages/cli/src/executions/execution.service.ts`
- `packages/cli/src/workflows/workflow-execution.service.ts`
- `packages/cli/src/metrics/__tests__/prometheus-metrics.service.test.ts`
- `packages/cli/src/metrics/__tests__/prometheus-metrics.service.unmocked.test.ts`
- `packages/cli/test/integration/prometheus-metrics.test.ts`

*Docker*
- `docker/images/n8n/Dockerfile`
- `docker/images/runners/Dockerfile`
- `scripts/dockerize-n8n.mjs` *(minor platform plumbing)*
- `scripts/build-n8n.mjs` *(non-idempotent in-place edit of
  `packages/cli/package.json` to push `'!dist/**/e2e.*'` into the `files`
  array; not a fork customization itself, but the script is part of our
  pack pipeline so it shows up as a dirty working tree on every `node
  scripts/build-n8n.mjs` run — see step 8 in the upgrade procedure for
  the revert command)*

**Runtime contract**
- Metric `n8n_audit_workflow_executed_total` (emitted from the `n8n.audit.workflow.executed` event via `toCounter()` in `prometheus-metrics.service.ts`) gains `execution_mode` and `project_id` labels. The same two labels are also applied to the per-node audit counters (`n8n_node_started_total`, `n8n_node_finished_total`). There is no upstream metric named `n8n_workflow_executions_total` — every event-bus counter in this file is named after its source event (see "Metric-name reference" below).
- Existing dashboards/alerts keyed on these metrics must be updated if they depended on cardinality.
- `PrometheusMetricsService` keeps an in-memory `workflowProjectCache: Map<workflowId, projectId>` that is opportunistically populated from any inbound event that carries a non-empty `projectId`. When a later event for the same workflow arrives without `projectId` (e.g. the execution-retry path in `executions/execution.service.ts`, or the webhook/trigger/cli/integrated/evaluation `eventService.emit('workflow-executed', …)` call sites that omit `projectId`), the cache supplies the value so `project_id="unknown"` is not emitted. Cache is process-local and resets on restart. Regression test lives in `prometheus-metrics.service.unmocked.test.ts` ("falls back to remembered project_id when payload omits it").
- **Known cold-start gap.** For webhook executions, n8n emits the audit event `n8n.audit.workflow.executed` ~300ms BEFORE the first `n8n.node.started` event of the same execution. As a result, the very FIRST webhook execution for a given workflow after a fresh restart will emit `project_id="unknown"` (cache hasn't been primed yet). Every subsequent webhook execution for that workflow resolves correctly because the cache is then populated. Trigger / cli / integrated / evaluation execution sources have the same race in theory, but in practice `node-pre-execute` for those usually fires within the same tick as the audit event, so the cache wins. The orphan `project_id="unknown"` series can be safely filtered out at the Prometheus query layer (`{project_id!="unknown"}`) since each workflow produces at most one such sample per restart. Accepted as a narrow upstream-shape constraint; see "trade-offs" below.

**Metric-name reference (for dashboards / alerts / smoke tests)**
The custom labels are layered onto a *mix* of upstream-named and audit-named metrics. Use these names — not theoretical `n8n_api_*` / `n8n_event_bus_*` / `n8n_workflow_statistics_*` / `n8n_node_type_*` names that don't exist in the codebase:
- API endpoints (gated by `N8N_METRICS_INCLUDE_API_ENDPOINTS=true`): `n8n_http_request_duration_seconds_{count,sum,bucket}` — labelled with `status_code` / `method` / `path` (each gated by its own `N8N_METRICS_INCLUDE_API_*_LABEL` flag). Implementation: `express-prom-bundle` middleware mounted in `initRouteMetrics`.
- Per-execution audit counters (gated by `N8N_METRICS_INCLUDE_MESSAGE_EVENT_BUS_METRICS=true`): `n8n_audit_workflow_executed_total`, `n8n_audit_workflow_activated_total`, `n8n_audit_workflow_updated_total` — labelled with `workflow_id` / `workflow_name` (and `execution_mode` / `project_id` on `executed`).
- Per-node audit counters (same flag): `n8n_node_started_total`, `n8n_node_finished_total` — labelled with `workflow_id` / `workflow_name` / `execution_mode` / `project_id` / `node_type`.
- Runner / task-broker counters (same flag): `n8n_runner_task_*_total`, `n8n_runner_response_received_total`, etc.
- Workflow-statistics gauges (gated by `N8N_METRICS_INCLUDE_WORKFLOW_STATISTICS=true`): `n8n_production_executions`, `n8n_production_root_executions`, `n8n_manual_executions`, `n8n_users`, `n8n_enabled_users`, `n8n_credentials`, `n8n_workflows`. NOT named `n8n_workflow_statistics_*`. Cached in DB scrape with TTL `N8N_METRICS_INCLUDE_WORKFLOW_STATISTICS_INTERVAL` seconds.
- Queue metrics (gated by `N8N_METRICS_INCLUDE_QUEUE_METRICS=true`): `n8n_scaling_mode_queue_jobs_*`, `n8n_scaling_mode_queue_jobs_completed_total`, `n8n_scaling_mode_queue_jobs_failed_total`. Only registered when `EXECUTIONS_MODE=queue` AND running on the main instance.
- Cache metrics: `n8n_cache_hits_total`, `n8n_cache_misses_total`, `n8n_cache_updates_total`.

**Upgrade checklist**
- Upstream has been slowly refactoring the metrics pipeline. If
  `prometheus-metrics.service.ts` signatures change, re-plumb the two labels
  into the counter definition and into every call site that increments it.
- Keep `metrics/types.ts` declarations in sync with the labels we emit.
- Keep the `workflowProjectCache` fallback in `buildWorkflowLabels` — it is the
  only reason `project_id="unknown"` doesn't surface for executions whose
  upstream emitter forgot to populate `projectId` (notably the retry path in
  `executions/execution.service.ts`). The regression test guards against
  silently dropping it.
- If upstream rewrites the Dockerfile, re-apply the split-RUN change for
  `sqlite3` and `isolated-vm`. Also keep the `JOBS=1` environment override on
  the `npm rebuild isolated-vm` line — without it, the parallel C++ compile
  inside the Apple-Silicon Docker builder occasionally races and fails with
  `fatal error: opening dependency file ./Release/.deps/...o.d.raw: No such
  file or directory` (node-gyp `-j max` + ephemeral builder FS race).
- Always build the image from a clean `compiled/` directory — the pipeline is
  `pnpm build` → `node scripts/build-n8n.mjs` → `node scripts/dockerize-n8n.mjs`.
- **As of `n8n@2.20.7-exp.0`, `scripts/dockerize-n8n.mjs` now has `getBuildxDriver()` + a `useLegacyDockerBuild` branch inside `buildDockerImage(...)`.** Keep upstream's buildx-driver detection wholesale on conflict, then layer our split-RUN edits and the `JOBS=1` env override back on top — the two changes are orthogonal.

### 6. Repo hygiene / upgrade scaffolding

**Commit on current branch (single, squashed)**
- `a6b4020e93 chore(upgrade-2.17.7): build, lint, test, and repo-hygiene fixes to land customizations on 2.17.7`

**Original component commits (pre-squash, archived in `backup/pre-squash-2.17.7`)**
- `39dbfffcf2` ignore local build/docker/install log artefacts
- `1b72fd3ab7` restore build, typecheck and lint after 2.17.5 rebase
- `c0ebb35962` align upstream tests with customizations
- `7b1e5e220b` clear residual stylelint debt from 2.17.5 rebase
- `117d486543` type-safe Node Governance modal data (added during 2.17.7 upgrade — annotates the six modal `modalData` computeds with `NodeAccessRequest` / `NodeCategory` / `NodeGovernancePolicy` to clear 46 TS2339 regressions surfaced by typechecking against `n8n@2.17.7`)

These are pure mechanical fixes that cleared the upgrade. Don't treat them as
policy — every future upgrade will need an analogous one. After the next
upgrade, squash that version's chore work into a fresh
`chore(upgrade-X.Y.Z): …` commit and drop this one.

### 7. Docs — CUSTOMS.md

**Commit on current branch (single, squashed)**
- The tip of the branch — check with
  `git log --oneline --grep='docs(upgrade)' -1`. This SHA drifts every time
  the file is amended, so we don't pin it here.

**Original component commits (pre-squash)**
- `5d63b94e26` initial CUSTOMS.md
- `c7e7dffe4c` clarify role slug format

Keep this file in the same commit that introduces or modifies a customization.
When you amend/extend `CUSTOMS.md`, either fixup into the existing docs
commit or let it be a trailing docs commit — either way, it stays at the
last position on the branch (currently position 8 as of 2.17.7).

### 8. CI workflow trim (fork-only)

**Commit on current branch (single, squashed)**
- `26d513c091 chore(ci): trim fork-irrelevant GitHub Actions workflows`

**What & why.** Upstream ships ~76 GitHub Actions workflows under
`.github/workflows/` that are wired for `n8n-io/n8n` (and `n8n-io/n8n-private`).
On this fork they fail with `action_required` or error noise on every push,
PR, and cron tick because they depend on secrets we don't own
(`SLACK_WEBHOOK_URL`, `ANTHROPIC_API_KEY`, `N8N_ASSISTANT_APP_ID`,
`QBOT_SLACK_TOKEN`, `QA_METRICS_*`, `DOCKER_USERNAME/PASSWORD`,
`CODECOV_TOKEN`, `N8N_NOTIFY_PR_STATUS_CHANGED_*`, `CLOUD_PROD_*`, etc.)
or are explicitly gated on `github.repository == 'n8n-io/n8n'` /
`'n8n-io/n8n-private'`.

We trim the workflow set down to the inner-loop CI a fork actually benefits
from: PR/master build/lint/typecheck/unit/db/perf, Docker smoke build, and
the small-but-useful PR-title / new-package / Python / Windows checks.

**Kept (13 files)**

Top-level entrypoints:
- `.github/workflows/ci-pull-requests.yml` — PR pipeline (build, unit,
  typecheck, lint, packaging, db, perf, workflow-scripts, QA metrics
  comment). Fork edits: removed the `e2e` and `e2e-performance` filter
  outputs, the `e2e-tests` and `e2e-performance` job blocks, and the
  `security-checks` job, since their reusable callees were upstream-only.
  Removed `e2e-tests` and `security-checks` from the `required-checks`
  `needs:` list.
- `.github/workflows/ci-master.yml` — master push: build, unit, lint, perf.
  Fork edit: removed the `notify-on-failure` Slack job (depends on
  `SLACK_WEBHOOK_URL`).
- `.github/workflows/ci-check-pr-title.yml`
- `.github/workflows/ci-detect-new-packages.yml`
- `.github/workflows/ci-python.yml`
- `.github/workflows/build-windows.yml`
- `.github/workflows/docker-build-smoke.yml` — Docker build sanity.
  Fork edit: dropped the daily `schedule:` cron and the Slack
  `notify-on-failure` job (depends on `QBOT_SLACK_TOKEN`). Triggers on PRs
  touching docker paths and on `workflow_dispatch` only.

Reusable workflows referenced by the keepers:
- `test-unit-reusable.yml`
- `test-linting-reusable.yml`
- `test-bench-reusable.yml`
- `test-db-reusable.yml`
- `test-workflow-scripts-reusable.yml`
- `util-qa-metrics-comment-reusable.yml` — fork edit: added a
  `webhook-check` step that short-circuits the post-comment job when
  `secrets.QA_METRICS_COMMENT_WEBHOOK_URL` is empty, so the file no longer
  surfaces as `action_required` on every PR review.

**Deleted (~64 files)** (grouped):
- *Release machinery* — `release-create-github-releases.yml`,
  `release-create-{minor,patch,pr}.yml`, `release-merge-tag-to-branch.yml`,
  `release-populate-cloud-with-releases.yml`,
  `release-promote-github-release.yml`, `release-publish.yml`,
  `release-publish-{new-package,post-release}.yml`,
  `release-push-to-channel.yml`, `release-schedule-patch-prs.yml` (cron),
  `release-set-stable-npm-packages-to-latest.yml`,
  `release-standalone-package.yml`, `release-update-pointer-tag.yml`,
  `release-version-release-notification.yml`.
- *Security publish / private-repo sync* — `sec-publish-fix.yml`,
  `sec-publish-fix-1x.yml`, `sec-sync-public-to-private.yml` (hourly cron),
  `sec-poutine-reusable.yml`, `sec-ci-reusable.yml` (only wrapped poutine),
  `security-trivy-scan-callable.yml`, `sbom-generation-callable.yml`.
- *Benchmarks / evals / coverage / nightly* —
  `test-benchmark-{nightly,destroy-nightly}.yml`, `test-evals-{ai,ai-reusable,ai-release,python}.yml`,
  `test-e2e-{coverage-weekly,vm-expressions-nightly,helm,infrastructure-reusable,docker-pull-reusable,reusable,ci-reusable,performance-reusable}.yml`,
  `test-visual-{chromatic,storybook}.yml`,
  `test-workflows-{nightly,pr-comment,callable}.yml`.
- *Build / Docker push (n8n-io infra)* — `build-base-image.yml`,
  `build-benchmark-image.yml`, `docker-build-push.yml` (daily Docker push).
- *Util / bot integrations (no fork secrets)* — `util-claude.yml`,
  `util-claude-task.yml`, `util-notify-pr-status.yml`,
  `util-approve-and-set-automerge.yml`, `util-backport-bundle.yml`,
  `backport.yml`, `util-cleanup-abandoned-release-branches.yml`,
  `util-cleanup-pr-images.yml` (cron), `util-data-tooling.yml`,
  `util-determine-current-version.yml`,
  `util-ensure-release-candidate-branches.yml`, `util-sync-api-docs.yml`,
  `util-update-node-popularity.yml` (cron), `ci-pull-request-review.yml`
  (Chromatic on n8n-io only), `ci-pr-quality.yml` (PR-size enforcer that
  failed as `action_required` on the fork), `ci-check-release-from-fork.yml`,
  `ci-restrict-private-merges.yml`.

**Runtime contract**
- No GitHub Actions email/notification noise from upstream-only workflows.
- Fork branch protection should NOT require any deleted workflow names.
  Audit on the fork's GitHub UI:
  *Settings → Branches → branch protection rules → "Require status checks
  to pass before merging"* — remove any entry referring to a deleted
  workflow (Slack notify, e2e, chromatic, security-checks, claude, etc.).

**Upgrade checklist**
- This trim must be **re-applied** after every upstream-tag rebase. The
  `feat/upgrade-to-n8n-X.Y.Z` branch is created from a fresh upstream tag
  which carries the full ~76-file workflow set; the cherry-pick of this
  trim restores the deletions and edits.
- `.github/WORKFLOWS.md` is left intact upstream-as-is (we don't maintain
  it). It will reference deleted workflows; that's documentation drift
  we accept on the fork.
- If upstream renames a *kept* workflow or a reusable referenced from a
  kept workflow (e.g. they swap `sec-ci-reusable.yml` for a different
  scanner), reconcile inside `ci-pull-requests.yml`'s `required-checks`
  `needs:` list and the corresponding `uses:` line.
- If upstream adds a new noisy workflow that depends on n8n-io secrets,
  delete it as part of the next chore-upgrade commit and append it to the
  list above.

## Upgrade procedure (repeatable)

This is the workflow we actually followed for 2.15.1 → 2.17.5 → 2.17.7 and
that landed cleanly on the branch listed in **Baseline tags**.

```mermaid
flowchart TD
    A[Pick target tag n8n@X.Y.Z] --> B[Branch from upstream tag<br/>git checkout -b feat/upgrade-to-n8n-X.Y.Z n8n@X.Y.Z]
    B --> C[Cherry-pick the 7 squashed commits<br/>from the current baseline branch,<br/>in the order listed below]
    C --> D{pnpm install --frozen-lockfile}
    D -->|lockfile drift| D1[pnpm install --no-frozen-lockfile<br/>commit updated pnpm-lock.yaml]
    D -->|ok| E[pnpm build]
    E --> F[pnpm typecheck && pnpm lint]
    F --> G[pnpm test:affected]
    G --> H[node scripts/build-n8n.mjs]
    H --> I[node scripts/dockerize-n8n.mjs --tag X.Y.Z]
    I --> J[docker compose up -d --force-recreate n8n]
    J --> K[Manual smoke:<br/>• login via OIDC<br/>• node governance UI<br/>• secrets from Akeyless<br/>• /metrics has project_id + execution_mode labels<br/>• audit log has payload.projectName]
    K --> L[Re-squash new chore work<br/>into chore(upgrade-X.Y.Z) commit]
    L --> M[Push branch, open draft PR,<br/>update CUSTOMS.md baseline tags table]
```

### Concrete steps

1. **Pick a target tag.** Check `git tag | grep n8n@` for the new release. Never
   upgrade from upstream `master`.
2. **Branch from the tag.**
   ```bash
   git fetch origin --tags
   git checkout -b feat/upgrade-to-n8n-X.Y.Z n8n@X.Y.Z
   ```
3. **Cherry-pick customizations in order.** From the current baseline branch
   (`feat/upgrade-to-n8n-2.22.4` at time of writing), cherry-pick these
   **eight** commits one at a time in this exact order:

   ```bash
   git cherry-pick a894aa7945   # node governance
   git cherry-pick a1286ad4db   # external secrets (Akeyless)
   git cherry-pick aa72e0b97f   # SSO OIDC provisioning hardening (+ diag fingerprint + access-token claim fallback)
   git cherry-pick f521207ba5   # Azure OpenAI APIM (nodes-langchain)
   git cherry-pick 2c9f4bb2fe   # Prometheus labels + Docker build splits + alpine 3.23 paths
   git cherry-pick 4b4bfac715   # CI workflow trim (Section 8)
   git cherry-pick 7e02413711   # upgrade chore (build/test/lint mechanical fixes + cli wiring fix + alpine path migration + cherry-pick collateral)
   git cherry-pick $(git log --format=%H --grep='docs(upgrade)' -1 feat/upgrade-to-n8n-2.22.4)  # this docs file
   ```

   The CI-trim SHA is resolved at cherry-pick time because it will drift the
   first time it lands (and will be re-squashed under the same conventional
   commit subject on later upgrades). If the cherry-pick conflicts, the
   freshly-rebased upstream tag has restored deleted workflows and/or added
   new ones — re-apply the keep/delete list from **Section 8** by hand.

   The docs SHA is resolved at cherry-pick time because it drifts every time
   `CUSTOMS.md` is updated.

   Prefer cherry-pick over merge to keep the branch readable. If a
   cherry-pick conflicts:

   - Check the **Upgrade checklist** for the affected section.
   - Resolve, then run `pnpm typecheck` on that package before moving on.
   - After upgrade is verified end-to-end, squash any new mechanical fix-up
     work into the `chore(upgrade-X.Y.Z)` commit so the next upgrade still
     sees exactly eight commits.
4. **Resolve lockfile drift.**
   - If `pnpm install --frozen-lockfile` fails, run `pnpm install --no-frozen-lockfile`, commit `pnpm-lock.yaml` as a **separate** "chore(upgrade): refresh lockfile" commit.
   - Do **not** edit `package.json` files by hand. The `build-n8n.mjs` script
     rewrites `packages/frontend/**/package.json` in place during its deploy
     phase — if a run is killed mid-flight, `git checkout --` those files
     before retrying.
5. **Build.**
   ```bash
   pnpm build > build.log 2>&1
   tail -n 20 build.log
   ```
6. **Typecheck & lint.**
   ```bash
   pnpm typecheck
   pnpm lint
   ```
7. **Run affected tests.** Use `--continue` so a single empty-test
   upstream package doesn't tank the whole run — `pnpm test:affected`
   on its own bails on the first failure (turbo's default), and at
   `n8n@2.20.7-exp.0` there are **three** packages with `"test": "jest"`
   that ship zero test files (`@n8n/extension-sdk`, `@n8n/constants`,
   `n8n-node-dev`). See the troubleshooting table for the full pattern;
   the count drifts each upstream release.
   ```bash
   pnpm exec turbo run test --affected --concurrency=1 --continue \
     > test-affected.log 2>&1
   tail -n 30 test-affected.log
   ```
   ⚠ Do **not** use `pnpm --filter='!<pkg>' test:affected` to dodge the
   empty-test packages — pnpm's `--filter` is consumed by pnpm before
   the root script runs `turbo`, so turbo never sees it and still
   queues the broken package. (Ditto for chained `--filter='!a'
   --filter='!b'`: turbo composes `--filter` flags with **OR**, so
   that pattern matches everything.) `--continue` is the only
   single-knob workaround that survives upstream adding a fourth
   empty-test package.

   The run is green for the fork iff the only failures in the tail
   are the three known empty-test packages above (each with the
   distinctive `testMatch: ... - 0 matches` line). Anything else is
   a real regression — bisect against `backup/pre-customs-<ver>`.
8. **Pack for Docker.** This must run in **foreground** — backgrounding it
   gets SIGTERM'd before the `pnpm deploy` step finishes. On macOS,
   pre-clean stale outputs first: `fs-extra.remove` (the script's internal
   recursive deleter) intermittently trips `ENOTEMPTY` on APFS when the
   prior `compiled/` is large (~1 GB+) or when Finder/Spotlight drops a
   `.DS_Store` into the tree mid-delete. A `rm -rf` up front is robust:
   ```bash
   rm -rf compiled dist/task-runner-javascript
   node scripts/build-n8n.mjs > build-pack.log 2>&1
   ```
   After it finishes, restore any in-place edits the script may have made
   to `package.json` files:
   ```bash
   git checkout -- package.json packages/cli/package.json \
     packages/frontend/@n8n/chat/package.json \
     packages/frontend/@n8n/design-system/package.json \
     packages/frontend/editor-ui/package.json
   ```
   `packages/cli/package.json` historically matters because
   `build-n8n.mjs:201-208` pushes `'!dist/**/e2e.*'` into the `files`
   array via `packageJson.files.push(...)` and
   `JSON.stringify(..., null, 2)` — the write is **non-idempotent** (each
   run appends another duplicate glob, and there's no trailing newline at
   EOF). Re-running the pack step without a `git checkout --` between
   runs leaves the file with `N` duplicate entries; if you accidentally
   commit that, the next pack tacks on a third copy. **Observation from
   the 2.22.4 pack run:** zero drift was produced on any of the five
   files above (`git status --short` was clean on all of them), so the
   revert was a no-op. The script may have been refactored to clean up
   after itself, or the trailing-newline behaviour changed. Keep the
   revert command as the safe default until the script is audited — it
   costs nothing when there's no drift, and it remains the only barrier
   against the historical compounding bug if the behaviour reverts.
9. **Build the Docker image.**
   ```bash
   node scripts/dockerize-n8n.mjs --tag X.Y.Z --platform linux/arm64 > docker-build.log 2>&1
   docker tag n8nio/n8n:local n8nio/n8n:X.Y.Z
   ```
10. **Recreate the running container.**
    ```bash
    cd /path/to/compose
    docker compose up -d --force-recreate n8n
    ```
11. **Smoke test manually.** See the **Manual smoke checklist** below.
12. **Re-squash if needed.** If landing the upgrade required extra mechanical
    commits (lockfile refresh, lint/test fixups, CI adjustments), fold them
    into the `chore(upgrade-X.Y.Z)` commit so the next upgrade still
    cherry-picks exactly eight commits:

    ```bash
    # After verification is complete, from the feature branch:
    git rebase -i n8n@X.Y.Z
    # Mark the new chore commits as `fixup` under the chore(upgrade-X.Y.Z)
    # pick line, or use `squash` and curate the combined message.
    ```

    Always create a `backup/pre-squash-X.Y.Z` tag on the old HEAD first so
    you can recover if the squash goes sideways.

13. **Update this file.** Bump the baseline tags table to point to the new
    tag, update the eight SHAs in step 3, record any new upgrade-checklist
    lessons.
14. **Push and open draft PR** (unless explicitly told otherwise).

### Upstream-adoption audit (run before every cherry-pick)

Before cherry-picking, check whether upstream has adopted any of our
customizations — a feature that's now upstream is one we should drop, not
re-cherry-pick. Skip this and you risk shipping a duplicated emit, a
double-registered DI service, or a contradiction between two slightly
divergent implementations.

**Method.** For each customization in the catalogue, grep the **exact
target tag** (not `master`, not `release-candidate/X.Y.x`) for the
identifying markers. The 2.20.7-exp.0 audit ran:

```bash
# Fetch the exact tag first — release-candidate branch tip is usually older
git fetch upstream "refs/tags/n8n@X.Y.Z:refs/tags/n8n@X.Y.Z" --no-tags

# §1 Node Governance — fork-only marker
git grep -lE 'akeyless|nodeGovernance|node_governance' 'n8n@X.Y.Z' \
  -- ':!CUSTOMS.md'   # 0 hits ⇒ not adopted

# §1 init.ts logout-hook reset — must lack our 3-line block
git show 'n8n@X.Y.Z:packages/frontend/editor-ui/src/app/init.ts' \
  | grep -nE 'state\.initialized|authenticatedFeaturesInitialized'

# §3 OIDC scopes default + role-claim resolution
git grep -nE "scopesInstanceRoleClaimName: string =|resolveInstanceRoleClaim" \
  'n8n@X.Y.Z' -- packages/@n8n/config/src/configs/sso.config.ts \
  packages/cli/src/modules/sso-oidc/oidc.service.ee.ts

# §3 Login-event audit emits — check whether upstream now emits these too
git show 'n8n@X.Y.Z:packages/cli/src/controllers/auth.controller.ts' \
  | grep -nE 'validateSsoRestrictions|user-login-failed|user-logged-in'

# §4 Azure OpenAI APIM credentials — does upstream now ship the files?
git ls-tree -r 'n8n@X.Y.Z' -- 'packages/@n8n/nodes-langchain/credentials/' \
  | grep -iE 'azure|entra'

# §5 Prometheus labels and Docker split
git grep -nE 'execution_mode|workflowProjectCache|project_id' \
  'n8n@X.Y.Z' -- packages/cli/src/metrics/prometheus-metrics.service.ts
git show 'n8n@X.Y.Z:docker/images/n8n/Dockerfile' \
  | grep -nE 'sqlite3|isolated-vm|JOBS=|npm rebuild'
```

**Interpreting results.**

- 0 hits for our markers ⇒ **not adopted**, cherry-pick as-is.
- Hits but our specific behaviour missing (e.g. upstream emits one of two
  audit events, or ships a credential file but as a strict subset of ours)
  ⇒ **partially adopted**, cherry-pick still needed but expect non-trivial
  conflict. Resolve by keeping the fork shape (we're the superset) and
  layering upstream's additions on top.
- Hits with our **exact** behaviour ⇒ **adopted**, drop the cherry-pick
  and append the SHA to the dropped-commits list in the chore message.

**Recorded findings (2.20.9, against `n8n@2.20.9` =
`38294c02d7`).** All 8 customizations remained required:

- §1 Node Governance — 0 hits, cherry-pick as-is.
- §1 `init.ts` logout-hook reset block — still missing upstream, preserve.
- §2 Akeyless — 0 hits, cherry-pick as-is.
- §3 OIDC main hardening — `oidc.service.ee.ts:465` still does the
  single-claim lookup; default still `'n8n_instance_role'`. Cherry-pick.
- §3 Login-event emits — partial overlap unchanged from 2.20.7-exp.0.
  Upstream still emits `user-login-failed` from `authenticateWithPassword`
  (wrong-credentials path) and `user-logged-in` from the standard login
  flow, and **not** from `validateSsoRestrictions` (our SSO-blocked path)
  or the OIDC controller. Our emits remain orthogonal.
- §4 Azure OpenAI APIM — **partial adoption** of file paths only. See
  the §4 upgrade checklist for the keep-fork-shape resolution pattern.
- §5 Prometheus labels — 0 hits in `prometheus-metrics.service.ts`,
  cherry-pick.
- §5 Docker split — `Dockerfile:10` still has the single combined
  `npm rebuild sqlite3 isolated-vm`, cherry-pick.
- §5 Docker alpine layout — **partial adoption.** Upstream merged PR
  n8n-io/n8n#30478 to master on 2026-05-15 (after `n8n@2.20.9` was tagged)
  migrating from alpine 3.22 → 3.23, bumping `NODE_VERSION` 24.14.1 →
  24.15.0, and switching the install paths to `/usr/lib/node_modules` and
  `/usr/bin`. The base image republish leaks into our build because we
  pull the moving `n8nio/base:24.14.1` tag at build time. The 2.20.9 chore
  commit absorbs upstream's exact path migration to keep the build green.
  On 2.21.x and later this becomes a no-op because the `n8n/Dockerfile`
  in the upstream tag will already carry the new paths.
- §8 CI trim — fork-only by definition, cherry-pick as-is.

**Recorded findings (2.22.4, against `n8n@2.22.4` =
`7894b48205`).** All 8 customizations remained required. New
absorption / conflict patterns:

- §1 Node Governance — 0 hits, cherry-pick as-is. FE-only follow-up:
  upstream made the `workflow` ref **private** on the workflows store
  (public surface now exposes only `workflowId` + `private`). Our
  `NodeAccessRequestModal.vue` was the only fork-side reader of
  `workflowsStore.workflow.name`; migrated to the in-tree pattern
  `const workflowDocumentStore = injectWorkflowDocumentStore(); computed(
  () => workflowDocumentStore.value?.name)`. See the new
  troubleshooting row "`workflowsStore.workflow` accessor went private…".
- §1 `init.ts` logout-hook reset block — still missing upstream, preserve.
- §2 Akeyless — 0 hits, cherry-pick as-is.
- §3 OIDC main hardening — 0 hits in the configured-claim-name path or
  the role-claim resolver; cherry-pick as-is.
- §3 Login-event emits — **partial adoption.** Upstream PR n8n-io/n8n#29856
  adopted our `user-login-failed` emit from `validateSsoRestrictions`,
  so the §3 `auth.controller.ts` parameter-rename hunk is now redundant
  (kept HEAD on conflict). The OIDC controller `user-logged-in` emit is
  still missing upstream; preserve. **Auto-merge hazard** the next
  cherry-pick of §3 hit: TextX merged the constructor-injected
  `eventService: EventService` parameter **twice** (HEAD already
  injected it for the §3 audit-emit follow-on; the incoming patch
  re-introduced it). Same shape in `oidc.controller.ee.test.ts`: the
  module-scope `mock<EventService>()` was declared twice and passed
  twice into `new OidcController(...)`. Symptom: TS2300 "Duplicate
  identifier 'eventService'" + TS2451 + TS2554 "Expected 7 arguments,
  but got 8". Dedupe in the chore commit; see the troubleshooting row
  "Constructor-DI auto-merge doubling after cherry-pick…".
- §3 OIDC test assertion shape — **rule drift.** Upstream added the
  local rule `n8n-local-rules/no-error-instance-in-to-throw` between
  2.20.9 and 2.22.4. Our §7 (`chore(upgrade-2.20.9)`) cherry-pick
  carried `rejects.toThrow(new BadRequestError('...'))` which now
  trips the rule. Refactor to the rule-compliant split form
  (`toThrow(Class)` + `toThrow('message')`).
- §4 Azure OpenAI APIM — unchanged from 2.20.9. Keep-fork-shape pattern
  still applies; upstream's `Resource Name` field is still a subset.
- §5 Prometheus labels — 0 hits in `prometheus-metrics.service.ts`,
  cherry-pick.
- §5 Docker split — `Dockerfile:10` still has the single combined
  `npm rebuild sqlite3 isolated-vm`, cherry-pick. **Auto-merge hazard:**
  HEAD now carries the §7 alpine-3.23-path migration from 2.20.9, while
  the incoming §5 cherry-pick still references the older `npm rebuild
  sqlite3` (no `isolated-vm`). Combine: keep HEAD's `npm rebuild sqlite3`
  AND add `JOBS=1 npm rebuild isolated-vm` on a second line.
- §5 Docker alpine version — **upstream reverted to 3.22.** The 2.20.9
  chore commit bumped to alpine 3.23 to track the republished base
  image, but upstream pinned the `n8n` Dockerfile back to alpine 3.22
  for `n8n@2.22.4`. On conflict take HEAD's `alpine3.22` (matches
  upstream's surrounding state) — this temporarily reverts our 2.20.9
  absorption but stays consistent with the rest of the 2.22.4 tag.
- §6 CI workflow trim — fork-only by definition. Conflict count grew:
  34 modify/delete (resolved by honoring fork deletions) + 3 modify/
  modify on the kept files (`ci-master.yml`, `ci-pull-requests.yml`,
  `docker-build-smoke.yml`). Resolution pattern: preserve fork's
  removal of fork-irrelevant jobs (e2e, security, Slack notify, daily
  cron) while keeping upstream's functional changes to the remaining
  jobs.

## Manual smoke checklist

Run these after every upgrade before tagging "done":

- [ ] Login via OIDC (Azure Entra). Admin gets `global:admin`, member gets `global:member`.
- [ ] OIDC "Test Connection" button on SSO settings: **known cosmetic
      asymmetry** on Azure Entra v2. If it surfaces `BadRequestError:
      Invalid token` while real OIDC login (above) works, that is *not* a
      regression — see the troubleshooting row "OIDC SSO settings 'Test
      Connection' button fails…" for the diagnosis (production sign-in
      has a userinfo→ID-token-claims fallback that the test-callback
      path lacks). Do not block the upgrade on this.
- [ ] `docker logs n8n` shows no `ZodError` at boot, and no Akeyless `body`/`data`
      payloads at any log level.
- [ ] Settings → Node governance → **Project overrides** section appears only
      when global default = block, shows each project name fully, lets you
      change the override.
- [ ] Change a project override, verify audit event
      `n8n.audit.node-governance.settings.updated` has both `payload.projectId`
      and `payload.projectName`.
- [ ] Akeyless secret appears in the Credentials → External Secrets list,
      values resolve in a workflow.
- [ ] `curl http://localhost:5678/metrics` shows `n8n_audit_workflow_executed_total`
      with `execution_mode` and `project_id` labels (requires
      `N8N_METRICS_INCLUDE_MESSAGE_EVENT_BUS_METRICS=true` plus
      `N8N_METRICS_INCLUDE_EXECUTION_MODE_LABEL=true` and
      `N8N_METRICS_INCLUDE_PROJECT_ID_LABEL=true`, and at least one workflow
      execution since the last restart — the counter is registered lazily on
      first emit, not pre-seeded with `.inc(0)`).
- [ ] LmChatAzureOpenAi node can authenticate via OAuth2 (APIM path).
- [ ] `pnpm exec turbo run test --affected --concurrency=1 --continue`
      tail shows only the three known upstream empty-test packages
      (`@n8n/extension-sdk`, `@n8n/constants`, `n8n-node-dev`) in the
      `Failed:` line, each with `testMatch: ... - 0 matches`. Any other
      failure is a real fork regression — see step 7 in the upgrade
      procedure for why `pnpm test:affected` alone is not the right
      gate.

## Troubleshooting: things that have burned us before

| Symptom                                                                            | Fix                                                                                                                                                                                      |
|------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ZodError: scopesUseExpressionMapping: Required` at boot after upgrade             | Legacy DB row missing the field. The merge-before-parse fix in `provisioning.service.ee.ts::loadConfigurationFromDatabase` heals it on next read. Keep that commit.                      |
| OIDC admin login leaves user as member                                             | Check `docker logs` for the `OIDC provisioning:` diagnostic line. Usually the DB row has the wrong `scopesInstanceRoleClaimName`. Repair with a `jsonb_set` SQL update on the settings row. |
| Secrets appear in `docker logs` at `-v` verbosity                                  | Regression in `akeyless.ts` interceptors. The log-redaction change is baked into the single External Secrets commit (`cf03e9c640` on 2.17.7); if a future rebase drops it, restore method/URL/status-only logging in both interceptors. |
| Node governance migrations missing after upgrade                                   | Upstream merge dropped our entries in `migrations/postgresdb/index.ts` or `migrations/sqlite/index.ts`. Re-add them in chronological order.                                              |
| Project override names render as "M…", "My proj…"                                  | Upstream SCSS refactor broke the grid layout in `SettingsTab.vue`. The `.projectRow { display: grid; grid-template-columns: minmax(0, 1fr) 220px; }` block is part of the Node Governance commit (`f4473c8b1f` on 2.17.7); re-apply if a merge drops it. |
| `pnpm install --frozen-lockfile` fails about `patchedDependencies`                 | Someone (often an editor auto-formatter) truncated `package.json`. `git checkout -- package.json` and retry.                                                                             |
| `build-n8n.mjs` killed mid-deploy, frontend `package.json` files now stripped      | That's the script's in-place edit phase. Restore them with the `git checkout` command in step 8 above.                                                                                   |
| `git status` shows `packages/cli/package.json` dirty after a successful pack, with `'!dist/**/e2e.*'` appearing **N times** in `files` and no trailing newline at EOF | `build-n8n.mjs:201-208` does `packageJson.files.push('!dist/**/e2e.*')` then `JSON.stringify(..., null, 2)` (no `\n`). Each pack run that wasn't preceded by `git checkout -- packages/cli/package.json` appends another duplicate. Fix: revert with `git checkout -- packages/cli/package.json`; from then on, always run the step-8 revert command **before** re-running the pack, not just after. |
| Prometheus dashboard breaks after upgrade                                          | Cardinality of `n8n_audit_workflow_executed_total` (and the per-node `n8n_node_started_total` / `n8n_node_finished_total`) changed — audit `metrics/prometheus-metrics.service.ts` for upstream renames before widening panels' `by()`. Note: there is no metric named `n8n_workflow_executions_total`; counters are derived from event names via `toCounter()`. |
| `pnpm typecheck` reports 46 × `TS2339: Property 'X' does not exist on type '{}'` in Node Governance modal Vue files | Upstream tightens generic inference. Each `modalData` computed in the six modal wrappers under `frontend/editor-ui/src/features/settings/nodeGovernance/components/` must annotate the modal payload with its concrete governance type (`NodeAccessRequest`, `NodeCategory`, or `NodeGovernancePolicy`) imported from `nodeGovernance.api.ts`. Folded into `chore(upgrade-2.17.7)` (`a6b4020e93`); re-apply on the next typecheck regression. |
| `@n8n/workflow-sdk` test suite fails with 44 × `Exceeded timeout of 120000 ms for a hook` on `setupTestSchemas`     | Upstream `beforeAll(setupTestSchemas, 120_000)` regenerates zod schemas for ~169 nodes from `packages/nodes-base/dist/types/nodes.json`. Under heavy parallel load (e.g. when nodes-base jest workers are still warm) this hook can exceed 120 s. Re-run `pnpm --filter=@n8n/workflow-sdk test` in isolation to verify; if it passes alone, the failure was contention, not a regression. |
| `pnpm install --frozen-lockfile` fails inside the Cursor sandbox with `EPERM: reflink` or `EPERM: unlink` on `node_modules` | The sandbox blocks APFS clonefile and certain in-place modifications. Wipe all `node_modules` (`rm -rf node_modules && find packages -name node_modules -type d -prune -exec rm -rf {} +`), then re-run `CI=true pnpm install --frozen-lockfile` outside the sandbox (`required_permissions: ["all"]` in tooling).        |
| `pnpm lint` from repo root SIGKILLs (exit 137) on the typecheck/lint turbo run     | Out-of-memory under turbo's parallel workers. Run lint per heavy package with `NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter=<pkg> lint` for `n8n`, `n8n-nodes-base`, and `n8n-editor-ui`.                                                |
| Governance migrations conflict with upstream `1777023444000` / `1777420800000` migrations on rebase | Resolve `migrations/{postgresdb,sqlite}/index.ts` **by timestamp order**, not by hunk order. Confirmed pattern as of 2.20.x: upstream's `ExpandVariablesValueColumnToText1777420800000` interleaves between our governance migrations; the new upstream migration registers **before** `AddPendingAccessRequestUniqueIndex1778500000000` chronologically. |
| `import.service.ts` reports `TS2589: Type instantiation is excessively deep and possibly infinite` on the `tx.upsert(WorkflowEntity, ..., ['id'])` call | Symptom flips between upstream versions: on 2.19.2, the cast `tx.upsert(WorkflowEntity, workflow as Partial<WorkflowEntity>, ['id'])` fixed it; on 2.20.7-exp.0, the upstream signature changed and **keeping** that cast itself produces TS2589. Rule of thumb: revert to upstream's call shape first; only re-introduce the cast if the upstream-shape call still errors. |
| `@n8n/syslog-client` test suite reports 2 failures (`tcp.test.ts:204` "should handle connection timeout", `tls.test.ts:184` "should handle connection timeout") on `pnpm test:affected` | **Pre-existing upstream flake**. Verify zero diff with `git diff <upstream-tag> -- packages/@n8n/syslog-client/`. Both tests are timing-sensitive timeout assertions that occasionally race on busy machines. Not caused by any of our 8 customizations; safe to ignore for the upgrade. |
| One or more packages fail `test:affected` with `No tests found, exiting with code 1` / `testMatch: ... - 0 matches` / `ELIFECYCLE Test failed`                                          | **Pre-existing upstream gap**, not a customization regression. These packages declare `"test": "jest"` (no `--passWithNoTests`) but ship zero `*.test.*` / `*.spec.*` files. Jest's default `passWithNoTests=false` makes the script exit 1, which fails the turbo run and (without `--continue`) aborts every downstream task. **As of `n8n@2.20.7-exp.0` there are three of these:** `@n8n/extension-sdk`, `@n8n/constants`, `n8n-node-dev` (run `node scripts/find-empty-test-packages.mjs` to re-verify the list on each upgrade — the count drifts). Verify zero fork diff with `git diff n8n@X.Y.Z -- packages/<pkg>/`. Workaround: use `--continue` (see step 7). The pnpm-level filter trick (`pnpm --filter='!<pkg>' test:affected`) **does not work** — pnpm consumes the flag before the root script invokes turbo, and `turbo run` ignores it. Multiple `--filter='!a' --filter='!b'` flags on `turbo run` also do not work because turbo composes `--filter` flags with OR, not AND. To check a single empty-test package in isolation, use `pnpm --filter=<pkg> test -- --passWithNoTests`. |
| `@n8n/playwright-janitor` reports 1 vitest failure: `src/core/tcr-executor.test.ts:174` "detects new test files in new directories (staged)" — `AssertionError: expected false to be true` on `result.affectedTests.some((t) => t.includes('staged-feature...'))` | **Pre-existing upstream test that's sensitive to the surrounding working-tree state.** It shells out to `git` inside a fixture and expects to find newly-staged files in `staged-feature/`. The assertion can flip to `false` when the host repo has unstaged or untracked noise (e.g. our `test-affected.log`, `dockerize-n8n.log`, `.pnpm-store/`, generated build logs) that confuses its `git diff --cached` discovery. Verify zero fork diff with `git diff <upstream-tag> -- packages/testing/janitor/`. **When to bisect:** only if the same failure reproduces on a clean checkout with no untracked files; otherwise it's environmental. To confirm in isolation: `cd packages/testing/janitor && pnpm test src/core/tcr-executor.test.ts`. |
| `n8n-editor-ui` task fails with `ELIFECYCLE Test failed`, in one of two upstream shapes — **(a)** summary reads `Test Files 707 passed (707) / Tests 9761 passed | 2 todo (9763)` plus many `Error: AggregateError` lines pointing at `jsdom/lib/jsdom/living/xhr/xhr-utils.js:63` originating in `src/features/ndv/runData/components/RunData.test.ts`; **OR (b)** summary reads `Test Files 1 failed | 706 passed (707) / Tests 3 failed | 9758 passed | 2 todo` with the three failures all `src/app/router.test.ts > router > should resolve <path> to <view>` at `Test timed out in 10000ms` (line 60, the `test.each([...]).../, 10000)` block, hitting the first 2–3 entries — `/`, `/workflow`, `/workflow/new`) | **Both are pre-existing upstream timing/jsdom artifacts on a contended machine, not regressions.** Shape (a) is unhandled jsdom xhr error events being counted as `errors: 9` despite every test passing. Shape (b) is `test.each` entries that pay the router-setup cost on the first 2–3 invocations — in isolation `router.test.ts` finishes in ~25 s with the slowest `test.each` entry at ~6 s, well under the 10 s budget, but under concurrent turbo load the budget breaks. Verify zero fork diff with `git diff <upstream-tag> -- packages/frontend/editor-ui/src/app/router.test.ts packages/frontend/editor-ui/src/features/ndv/runData/`. The fork only adds the `/settings/node-governance` route to `router.ts`; none of the failing `test.each` paths route through it. **When to bisect:** only if the same `Test Files X failed` count reproduces in isolation (`cd packages/frontend/editor-ui && pnpm test <failing-file>`). If the isolated run is clean, it was contention. Shape (a) alone (errors but `Test Files X passed (X)`) is never a regression. |
| `n8n#test` (cli) shows 7 timeouts in `src/modules/mcp/__tests__/mcp.oauth.controller.api.test.ts` (all `Exceeded timeout of 10000 ms`, in `POST /mcp-oauth/token`, `POST /mcp-oauth/revoke`, and `OAuth Discovery - Cross-validation` blocks) and 1 timeout in `test/integration/controllers/invitation/invitation.controller.integration.test.ts:171` "should fail with already accepted invite"     | **Pre-existing upstream flakes on the default 10 s jest timeout.** Both files are zero fork diff. The MCP OAuth suite runs 7 discovery/revocation tests in sequence on a single test server, each pinning a fresh DB row and a license toggle; on a busy machine (warm jest workers in `nodes-base`, parallel disk I/O) the 10 s budget is unreliable. The invitation test races a token-expiry path that exits 10 s flat instead of the expected 400. Verify zero fork diff with `git diff <upstream-tag> -- packages/cli/src/modules/mcp/ packages/cli/test/integration/controllers/invitation/`. **When to bisect:** only if the same tests still time out after running them in isolation with `pnpm --filter=n8n test src/modules/mcp/__tests__/mcp.oauth.controller.api.test.ts` (and likewise for invitation) on an idle machine. If they pass in isolation, the failure was contention, not a regression. |
| Blocked nodes — especially `@n8n/n8n-nodes-langchain.*` AI sub-nodes under the **AI** subcategory — appear normally in the node creator with no lock icon, are draggable, and only fail at save time with the BE error `Cannot save workflow: The following nodes are blocked or pending approval by governance policies: ...`. Reproduces most cleanly when the project's default behaviour is `block` (so an un-policied node should be blocked by definition) | **Fork-only FE filter leak, BE enforcement intact.** `NodeItem.vue` (`isBlocked` / `isPendingRequest` / `_governanceStatus`) and `ItemsRenderer.vue` (`isNodeBlocked`) were calling `nodeGovernanceStore.getGovernanceForNode(name)` as the fallback for items missing from `mergedNodes`. That helper is a cache-only read of `nodeGovernanceStatus`; the cache is populated **only** by `resolveGovernanceForNode`, which `NodeCreator.augmentNodesWithGovernance` only calls for `mergedNodes`. View-stack sub-nodes (the entire `AI` subcategory) never participate in augmentation → cache miss → undefined → node treated as allowed. The BE save guard at `workflows/workflow.service.ts:413-419` correctly catches the leak with the `Cannot save workflow: ...` error — that's the save-time error you observe. **Fix:** in both files, change the fallback to call `resolveGovernanceForNode(name)` directly. It performs local policy + category + project-override + global-default + pending-request resolution **and** memoizes via the same cache, so the fast path is preserved for items already augmented. Folded into the §1 governance commit alongside an upgrade-checklist bullet. |
| `pnpm --filter=n8n-editor-ui typecheck` fails with `Property '"experiments.resourceCenter.tooltip.text"' is missing in type 'LocaleMessages' but required in type ...`, pointing at `src/app/dev/i18nHmr.ts:17` | **Stale `@n8n/i18n` dist build.** Upstream removes/adds i18n keys between releases. After a cherry-pick that touches `packages/frontend/@n8n/i18n/src/locales/en.json` (e.g. §1 governance keys, or upstream's resource-center tooltip removal in 2.20.9), the on-disk `packages/frontend/@n8n/i18n/dist/types2.d.mts` is regenerated only by a fresh build. Per AGENTS.md: "When your changes affect type definitions, interfaces in `@n8n/api-types`, or cross-package dependencies, build the system before running lint and typecheck." Always `pnpm build` (or at minimum `pnpm --filter=@n8n/i18n build`) BEFORE per-package typecheck after any cherry-pick that touches `en.json`. Hit during 2.20.9 upgrade. |
| Docker build fails at the final `RUN ln -s /usr/local/lib/node_modules/n8n/bin/n8n /usr/local/bin/n8n` step with `ln: /usr/local/bin/n8n: No such file or directory`, even though the builder stage and earlier `COPY --from=builder` succeeded | **Upstream alpine 3.22 → 3.23 base layout shift, 2026-05-15.** Upstream PR n8n-io/n8n#30478 (merged after most ≤2.20.9 tags) migrated the base image to alpine 3.23 because Docker Hardened Images publishes `node:26-alpine3.23-dev` but not `-alpine3.22-dev`. DHI alpine 3.23 has a Linux-standard layout: `/usr/bin/node` (was `/usr/local/bin/node`), `/usr/lib/node_modules` for node's built-in search, and **no `/usr/local/` tree by default**. Upstream's master `Dockerfile` was updated in the same PR; pre-2.21.x tags carry the OLD `/usr/local/...` paths. The `n8nio/base:24.14.1` tag on Docker Hub was republished with the new layout on 2026-05-15, breaking source builds of any tag from before that date. **Fix (folded into `chore(upgrade-2.20.9)`):** apply the 5-line patch from PR #30478 to `docker/images/n8n/Dockerfile` (`NODE_VERSION` 24.14.1→24.15.0, `alpine3.22`→`alpine3.23`, stage-2 paths to `/usr/lib/node_modules/n8n` and `/usr/bin/n8n`) and `scripts/dockerize-n8n.mjs` (default `nodeVersion`). Becomes a no-op once the source tree is at 2.21.x. |
| `n8n#test` (cli) shows 5 failed tests in 3 suites: `test/integration/task-runners/task-runner-process.test.ts` (`should start and connect the task runner`, `should stop an disconnect the task runner` — both via `retry-until.ts:19` `_onTimeout` with `Expected: 1, Received: 0`); `test/integration/public-api/users.test.ts` (`if not authenticated, should reject` — fails in beforeAll/setup); `test/integration/workflows/workflow-dependency.controller.test.ts` (`should reject empty resourceIds array`, `should return 503 for counts when indexing is disabled`) | **Pre-existing upstream contention flakes**, not regressions. All three test files have **zero fork diff** vs `n8n@2.20.9`. Confirmed environmental on 2.20.9: `task-runner-process` passes 4/4 in 11 s in isolation, `public-api/users` passes 18/18 in 19 s, `workflow-dependency.controller` passes 17/17 in 17 s. The pattern is identical to the documented MCP OAuth / invitation timeout flakes (CUSTOMS.md row above this one): integration suites racing test-server startup or DB pool exhaustion under heavy parallel load from `n8n-nodes-base` workers. Verify zero fork diff with `git diff <upstream-tag> -- packages/cli/test/integration/task-runners/ packages/cli/test/integration/public-api/ packages/cli/test/integration/workflows/workflow-dependency.controller.test.ts`. **When to bisect:** only if any of the three reproduces in isolation (`cd packages/cli && pnpm test <file>`) on an idle machine. |
| `pnpm lint` from repo root fails with `n8n#lint: FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory` and exit code 137, even when no real lint errors exist | **`packages/cli` ESLint OOMs the default 4 GB Node heap after major upgrades.** The cli has grown to a point where a single `eslint . --quiet` run can exceed 4 GB once the type-aware rules walk the full project graph. Local workaround: `NODE_OPTIONS="--max-old-space-size=10240" pnpm lint`. CI workflows already set `NODE_OPTIONS=--max-old-space-size=6144` for build; extend the same to the lint job (`test-linting-reusable.yml`) if it starts flaking. **Don't** mistake this for an actual lint failure — once you bump the heap, the underlying real lint errors (if any) become visible. Hit during 2.22.4 upgrade. |
| `@n8n/<sibling>:lint` fails with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/.../packages/@n8n/eslint-plugin-community-nodes/dist/rules/<rule-name>.js' imported from .../dist/rules/index.js` after a successful `pnpm build` (turbo reports `cache hit, replaying logs` for the plugin's build) | **Turbo cache drift on lint-config plugins consumed only by sibling ESLint configs.** `pnpm clean` deletes each package's `dist/`, but turbo's central cache (under `node_modules/.cache/turbo/` and via per-package `.turbo/`) survives. When `pnpm build` runs, turbo sees unchanged input file hashes for `@n8n/eslint-plugin-community-nodes`, replays the cached log lines AND restores a stale `dist/` from cache. Since no downstream **build** consumes the plugin's rules (only sibling **lint** does), the stale `dist/rules/` (which may be missing 25+ rules added between releases) survives undetected until lint runs and fails on `index.js`'s `import './<missing-rule>.js'`. Fix: nuke the plugin's `dist/`, `tsconfig*.tsbuildinfo`, AND `.turbo/` then rebuild directly: `rm -rf packages/@n8n/eslint-plugin-community-nodes/{dist,tsconfig*.tsbuildinfo,.turbo} && pnpm --filter=@n8n/eslint-plugin-community-nodes build`. Verify: `ls packages/@n8n/eslint-plugin-community-nodes/dist/rules/*.js \| wc -l` should match the source count from `ls packages/@n8n/eslint-plugin-community-nodes/src/rules/*.ts \| grep -v test \| wc -l`. **Preventive step for future major upgrades:** add this cleanup to step 5 of the upgrade procedure (before `pnpm build`). Hit during 2.22.4 upgrade — the cached dist had 8 rules, source had 35. |
| `workflowsStore.workflow.<property>` produces TS2551 `Property '<property>' does not exist on type 'Store<...>'. Did you mean 'workflowId'?` after upgrade | **Upstream made the `workflow` ref private on `useWorkflowsStore`.** The public surface now exposes only `workflowId` + `private`; the canonical pattern in editor-ui 2.22.x is to inject the per-document store and read off it. Fix pattern: `import { injectWorkflowDocumentStore } from '@/app/stores/workflowDocument.store'; const workflowDocumentStore = injectWorkflowDocumentStore(); const name = computed(() => workflowDocumentStore.value?.name);` (note the `.value` because `injectWorkflowDocumentStore` returns a `ShallowRef<WorkflowDocumentStore>`). All editor-ui consumers (`useWorkflowUpdate.ts`, `useWorkflowState.ts`, `useCanvasOperations.ts`, etc.) already use this pattern; fork code should match. Hit during 2.22.4 upgrade in `NodeAccessRequestModal.vue`. |
| `Cannot redeclare block-scoped variable 'eventService'` (TS2451) + `Expected 7 arguments, but got 8` (TS2554) in `oidc.controller.ee.ts` and/or `oidc.controller.ee.test.ts` after cherry-picking §3 | **Cherry-pick auto-merge doubled a constructor-injected DI parameter.** When HEAD already carries the §3 audit-emit follow-on (constructor injects `eventService: EventService`) and a NEWER §3 commit is being merged, git's textual merge can drop the incoming injection on top of HEAD's identical line, producing two `private readonly eventService: EventService,` entries. The test file then doubles the `mock<EventService>()` module-scope declaration AND passes it twice into `new OidcController(...)`. Fix: dedupe both files — remove the second `eventService` param from the constructor (preserving original parameter order), remove the duplicate `const eventService = mock<EventService>()` declaration in the test, and remove the second `eventService` argument from both `new OidcController(...)` call sites in the test. Sweep proactively after every §3 cherry-pick: `awk '/private readonly/ {gsub(/.*private readonly /,""); gsub(/[:,].*/,""); print}' <file> \| sort \| uniq -d`. Hit during 2.22.4 upgrade. |
| `n8n#lint` reports `error  Do not pass an error instance to '.toThrow()'. Use '.toThrow(BadRequestError)' for type checking and '.toThrow('message')' for message matching  n8n-local-rules/no-error-instance-in-to-throw` on a test that previously linted clean | **Upstream added the local rule `n8n-local-rules/no-error-instance-in-to-throw` between releases.** It rejects `rejects.toThrow(new SomeError('msg'))` because that asserts message-only (not class) and the error name is misleading. To preserve both class and message coverage, split into two assertions on the same promise: `const promise = subjectUnderTest(); await expect(promise).rejects.toThrow(SomeError); await expect(promise).rejects.toThrow('expected message');`. Sweep after each major upgrade: `git grep -nE 'rejects\.toThrow\(\s*new\s+\w+(Error\|Exception)\s*\('  packages/cli/src` should be empty. Hit during 2.22.4 upgrade in `oidc.service.ee.test.ts:424` (carried in from §7 `chore(upgrade-2.20.9)`). |
| `@n8n/scan-community-package` test suite reports 1–2 failures: `scanner/scanner.test.mjs > analyzePackage > passes a clean package that does not violate any error-level rules` with `expect(result.passed).toBe(true)` getting `false` (timing-out at 5000ms is a related symptom under load); and `test/provenance.test.mjs [ test/provenance.test.mjs ]` with `No test suite found in file ...` | **Pre-existing upstream test setup gaps**, surface after a fresh `@n8n/eslint-plugin-community-nodes` rebuild (see the turbo-cache row above). The "clean fixture" test instantiates a package.json with only `name` / `version` / `keywords` / `peerDependencies` and expects the scanner's recommended ESLint config to pass it — but the recommended config sets `n8n-object-validation: 'error'`, which unconditionally requires an `n8n` object on any `package.json`. Once the plugin is freshly built (35 rules instead of the cached 8), the rule fires on the fixture and the test correctly fails. Upstream CI hides this via the same stale-cache shape we hit on `pnpm build`. The `provenance.test.mjs` failure is orthogonal: that file uses Node's native `node:test` runner (`import test from 'node:test'`) and the package's `test` script invokes vitest, which finds no `describe`/`it` block and reports the file as a failed suite (the file's tests already ran successfully via node:test earlier in the same output, visible as TAP `# tests 4 / # fail 0`). Verify zero fork diff with `git diff <upstream-tag> -- packages/@n8n/scan-community-package/`. **Workaround for `test:affected`:** add `--filter='!@n8n/scan-community-package'` alongside the empty-test exclusions; CI (Linux) is the authoritative validator. Hit during 2.22.4 upgrade. |
| OIDC SSO admin login intermittently demotes user to `global:member` despite Azure App Role assigning `global:admin`; succeeds on retry without any config change. Fingerprint diagnostic shows `rolesClaimType: "undefined"` on the failing login but `accessTokenIsJwt: true` | **Azure Entra v1-token edge case.** When the App Registration has `requestedAccessTokenVersion: null` (or `1`) and the OIDC scope chain includes a custom API scope (e.g. `api://<client-id>/access_as_user`), Azure emits the `roles` claim **reliably in the resource-scoped access token JWT** but **intermittently in the ID token** (depending on session/consent state and silent-SSO replay). The §3 OIDC hardening adds a **third-tier fallback** in `applySsoProvisioning` that decodes the access token's payload (no signature re-validation — openid-client already validated the bundle at `authorizationCodeGrant`) and re-runs `resolveInstanceRoleClaim` against it whenever the ID token didn't yield a value. Same fallback applies to the project-roles claim. Watch for the `OIDC provisioning: instance role claim was missing from ID token; falling back to access token claims.` warn in logs — if it fires repeatedly, the long-term fix is Azure-side (set `requestedAccessTokenVersion: 2` and add `roles` as an Optional Claim for ID tokens). Folded into the §3 commit. Defended by 5 unit tests in `oidc.service.ee.test.ts` covering: ID-token-only happy path, access-token fallback, both-have-roles (ID token wins), neither-has-roles (passes `undefined` through), and opaque-token (non-JWT) skip. |
| **Recommended Azure Entra v1 OIDC settings** (companion to the row above) | For a stable login experience while the App Registration stays on `requestedAccessTokenVersion: null`: (1) Set `features.provisioning.scopesName = api://<client-id>/.default`. `.default` works at both v1 and v2 token endpoints and doesn't require maintaining a named scope under "Expose an API". Named scopes like `access_as_user` return HTTP 400 from the v2 token endpoint when the scope isn't defined (Azure responds with a sparse body; full reason `AADSTS65005`/`AADSTS70011` is in the sign-in logs). (2) Set `features.oidc.prompt = select_account`. Defeats silent-SSO token replay (the half of the role-intermittency story that's *not* token-version-related) by forcing a fresh interactive auth per session, without `consent`'s side effects. **Do NOT use `prompt: consent`** with a self-requesting app (client_id == resource audience) — it triggers `AADSTS90009: Application is requesting a token for itself. This scenario is supported only if resource is specified using the GUID based App Identifier.`, breaking login entirely. If `consent` is ever genuinely needed, also switch `scopesName` to the bare-GUID form `<client-id>/.default` (no `api://` prefix). For our setup, `select_account` + `.default` is the pareto-optimal combination. Confirmed 2026-05-18. |
| OIDC SSO settings "Test Connection" button fails with `BadRequestError: Invalid token` while real OIDC login (sign-in) works. `docker logs n8n` shows `error \| Failed to fetch user info { "error": { "name": "WWWAuthenticateChallengeError", "message": "server responded with a challenge in the WWW-Authenticate HTTP Header", ... at processUserInfoResponse ... at OidcService.processTestCallback ... } }` | **Fork-specific asymmetry between the two userinfo call paths in `oidc.service.ee.ts`.** The production sign-in path `loginUser` (~lines 294-309) catches userinfo failures and **falls back to ID-token claims** (debug log only) — code comment: *"Userinfo endpoint may fail when using custom API scopes (e.g., Azure AD with custom scopes)"*. The test-callback path `processTestCallback` (~lines 504-514) does **not** have that fallback — it logs error + throws `BadRequestError('Invalid token')`. Root cause is real Azure Entra v2 behaviour: with requested scopes `openid email profile [+ custom n8n scope]` (no Microsoft Graph scope), the access token's `aud` is the app itself, not Microsoft Graph; the Graph userinfo endpoint at `https://graph.microsoft.com/oidc/userinfo` therefore rejects it with `WWW-Authenticate: Bearer error="invalid_token"`. The ID token still carries `email`/`name`/`sub`, which is why production login succeeds via the fallback. **Bottom line: the OIDC integration is healthy — only the Test Connection UI is misleading.** Bonus problem: the current `this.logger.error('Failed to fetch user info', { error })` serialises the parsed challenge parameters as `"cause":"[object Object]"`, so diagnosis requires re-reading this row instead of seeing the underlying `error="…"` value. **Fix when prioritized:** mirror the `loginUser` fallback into `processTestCallback` — catch the userinfo error, log `warn` while surfacing `error.cause.parameters` (oauth4webapi attaches them there), and return success with ID-token claims as `userInfo`. Identified during 2.22.4 manual smoke. |
| `pnpm --filter n8n test` reports 5-8 failures across `test/integration/mfa/mfa.api.test.ts` (`POST /mfa/enforce-mfa` → 404), `test/integration/credentials/credentials.api.test.ts` (`PATCH /credentials/:id` → `Parse Error: Expected HTTP/, RTSP/ or ICE/`), `test/integration/workflows/workflows.controller.test.ts` (filter tests under `GET /workflows?includeFolders=true` → 403 Forbidden), and `test/integration/eventbus/syslog-tls.test.ts` (TLS invalid-cert test → cert accepted instead of rejected) — but each file passes 100% when run alone | **Test pollution between parallel jest workers in the CLI integration suite + one environmental quirk.** Verified isolation reproducibility (run from `packages/cli`): `pnpm exec jest --runInBand <file>` passes each one cleanly — `mfa.api.test.ts` 36/36 in ~10 s, `credentials.api.test.ts` 80/80 in ~18 s, `workflows.controller.test.ts` 183/183 in ~24 s. Root pollution sources: shared DI `Container` singleton (e.g. `instanceSettingsLoaderConfig.securityPolicyManagedByEnv` flipped by one test bleeds into the next), supertest's HTTP keep-alive agent (a half-broken socket carrying garbage causes the parse error in the next file's request), and module-init state where route registries aren't reliably re-bound between files in the same worker. The `syslog-tls.test.ts` failure is **environmental**, not pollution — see the next row on `NODE_TLS_REJECT_UNAUTHORIZED`. **Validation recipe when triaging post-upgrade:** if `pnpm --filter n8n test` shows N failures, run each failing file in isolation with `pnpm exec jest --runInBand <file>`; if all pass alone, the failures are pollution and the cherry-picks are clean. **Confirmation that none of our 11 cherry-picks touch these test paths:** `git log <upstream-tag>..HEAD -- packages/cli/test/integration/mfa packages/cli/test/integration/credentials packages/cli/test/integration/workflows/workflows.controller.test.ts packages/cli/test/integration/eventbus/syslog-tls.test.ts packages/cli/src/controllers/mfa.controller.ts packages/cli/src/credentials packages/cli/src/middlewares` returns zero commits. Hit during 2.22.4 manual smoke. |
| `test/integration/eventbus/syslog-tls.test.ts > TLS Syslog E2E > should log an error when the certificate is invalid - but not break the application` fails with `Received promise resolved instead of rejected ... Resolved to value: "<135>1 ... n8n.workflow.failed"`, even when the file is run in isolation, even on an idle machine. Log line just above the failure: `Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.` | **Corp-proxy env var globally disables TLS cert validation.** Amdocs corporate setups commonly auto-inject `NODE_TLS_REJECT_UNAUTHORIZED=0` (paired with `NODE_EXTRA_CA_CERTS=…ca.pem`) into the user shell environment because the MITM proxy at `genproxy.corp.amdocs.com:8080` re-signs HTTPS. With it set to `0`, **every** Node TLS client accepts every certificate, including the deliberately-invalid one the test creates. The test's whole premise — "invalid cert should be rejected and surface a Transport error" — is defeated before any application code runs. **Run with the env var unset for this test only:** `env -u NODE_TLS_REJECT_UNAUTHORIZED pnpm exec jest --runInBand test/integration/eventbus/syslog-tls.test.ts` passes 2/2 in ~9 s. **Don't unset it globally** — the corp proxy will then break `pnpm install`, OIDC discovery, Akeyless API calls, and so on. Apply the `env -u` per-command only when running TLS-rejection tests. Hit during 2.22.4 manual smoke. |
| Docker build (n8n stage) fails at `RUN ln -s /usr/local/lib/node_modules/n8n/bin/n8n /usr/local/bin/n8n` with `ln: /usr/local/bin/n8n: No such file or directory` for a **second-arch** image build, immediately after the first-arch build of the same release tag succeeded with the identical command. Symptom is byte-identical to the alpine-3.22 → 3.23 base-layout row above, but here the failure flips by architecture, not by base-image republish date | **You're building from `master`, not from `feat/upgrade-to-n8n-X.Y.Z`.** Per the upgrade procedure, `origin/master` is hard-reset to the clean upstream `n8n@X.Y.Z` tag (no customizations) after each upgrade lands, so its `docker/images/n8n/Dockerfile` reverts to upstream's `/usr/local/...` paths. Those paths still resolve on the **arm64** variant of `n8nio/base:24.15.0` (so the first build succeeds) but not on the **amd64** variant, which uses the DHI alpine-3.23 layout with `/usr/local/` empty by default — exactly the failure mode documented for n8n-io/n8n#30478. The fork's `feat/upgrade-to-n8n-X.Y.Z` Dockerfile already carries the alpine-3.23-safe paths (`/usr/lib/node_modules/n8n` + `/usr/bin/n8n`) and the `FROM n8nio/base AS base` → `FROM scratch` → `COPY --from=base / /` flatten plus the §5 `JOBS=1 npm rebuild isolated-vm` step. **Fix:** `git checkout feat/upgrade-to-n8n-X.Y.Z` before running `scripts/build-n8n.mjs` and `scripts/dockerize-n8n.mjs`. **Verify before building:** `grep -nE '/usr/(local/)?(lib\|bin)' docker/images/n8n/Dockerfile` should show `/usr/lib/node_modules/n8n` on the `COPY --from=builder` line and `/usr/bin/n8n` on the `ln -s` line; if it shows `/usr/local/...` you're on master. Hit during 2.22.4 amd64 push, after master had been freshly reset to clean `n8n@2.22.4` between the arm64 and amd64 builds. |

## Ownership

Owned by the platform team. Update this file **in the same PR** that introduces
or modifies a customization — not as a follow-up.

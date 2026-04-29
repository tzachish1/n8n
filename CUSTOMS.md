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
| `feat/upgrade-to-n8n-2.17.7` (current)   | `n8n@2.17.7` | 9              | type-safe Node Governance modal data; chore folded into a fresh `chore(upgrade-2.17.7)`; CI workflow trim added as Section 8; audit/log-streaming login events added under Section 3 |

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
    claim keys, whether configured claim exists).
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

#### Audit / log-streaming login events (2026-04-29)

**What & why.** Two upstream gaps left login activity invisible to log-streaming
destinations (SIEM, webhook, syslog) when SSO is enabled — a hard security
problem because brute-force against the email/password endpoint was completely
silent, and OIDC successful logins were not audited at all (SAML was).

1. **Failed password login under SSO** — `validateSsoRestrictions` in
   `auth.controller.ts` threw an `AuthError` *before* the existing
   `user-login-failed` emit was reached. Every blocked attempt (including
   brute-force against the owner account, which is the only one that *can*
   still log in with email+password while SSO is enabled) was dropped on the
   floor.
2. **Successful OIDC login** — `oidc.controller.ee.ts` issued the auth cookie
   and redirected, but never emitted `user-logged-in`. SAML's controller
   (`saml.controller.ee.ts:132`) already emits the same event, so this was
   pure parity.

The relay (`packages/cli/src/events/relays/log-streaming.event-relay.ts`)
already maps both events to `n8n.audit.user.login.failed` /
`n8n.audit.user.login.success`. Only emit sites needed adding.

**Entry points / key files**
- `packages/cli/src/controllers/auth.controller.ts`
  - `validateSsoRestrictions(preliminaryUser, emailOrLdapLoginId)` — extra
    parameter; emits `user-login-failed` with
    `{ authenticationMethod: 'email', userEmail, reason: 'SSO is enabled' }`
    before `throw new AuthError(...)`.
  - Call site updated to pass `emailOrLdapLoginId` through.
- `packages/cli/src/modules/sso-oidc/oidc.controller.ee.ts`
  - Constructor injects `EventService`.
  - `callbackHandler()` emits `user-logged-in` with
    `{ user, authenticationMethod: 'oidc' }` after `issueCookie`, before
    `res.redirect('/')`.

**Audit events emitted (after fix)**

| Event name (audit)                | Trigger                                                    | Payload extras                            |
|-----------------------------------|------------------------------------------------------------|-------------------------------------------|
| `n8n.audit.user.login.failed`     | password login while SSO enabled and user not allowed      | `userEmail`, `reason: "SSO is enabled"`   |
| `n8n.audit.user.login.success`    | successful OIDC callback                                   | `user`, `authenticationMethod: "oidc"`    |

**Upgrade checklist**
- Upstream may eventually add the `user-login-failed` emit in
  `validateSsoRestrictions`; if so, drop our emit to avoid double-counting
  attempts in the audit log.
- Upstream may eventually add the `user-logged-in` emit in the OIDC
  controller; if so, drop our emit (same reason).
- If upstream renames `validateSsoRestrictions` or restructures the OIDC
  callback, re-apply the emits at the equivalent points: **after the failure
  decision** (before throwing) and **after `issueCookie`** (before redirect)
  respectively.
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

**Runtime contract**
- Metric `n8n_workflow_executions_total` gains `execution_mode` and `project_id` labels.
- Existing dashboards/alerts keyed on this metric must be updated if they depended on cardinality.

**Upgrade checklist**
- Upstream has been slowly refactoring the metrics pipeline. If
  `prometheus-metrics.service.ts` signatures change, re-plumb the two labels
  into the counter definition and into every call site that increments it.
- Keep `metrics/types.ts` declarations in sync with the labels we emit.
- If upstream rewrites the Dockerfile, re-apply the split-RUN change for
  `sqlite3` and `isolated-vm`.
- Always build the image from a clean `compiled/` directory — the pipeline is
  `pnpm build` → `node scripts/build-n8n.mjs` → `node scripts/dockerize-n8n.mjs`.

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
   (`feat/upgrade-to-n8n-2.17.7` at time of writing), cherry-pick these
   **eight** commits one at a time in this exact order:

   ```bash
   git cherry-pick f4473c8b1f   # node governance
   git cherry-pick cf03e9c640   # external secrets (Akeyless)
   git cherry-pick 2d4eb6dc8b   # SSO OIDC provisioning hardening
   git cherry-pick d58298ee5d   # Azure OpenAI APIM (nodes-langchain)
   git cherry-pick 96a11fc53a   # Prometheus labels + Docker build splits
   git cherry-pick 26d513c091   # CI workflow trim (Section 8)
   git cherry-pick a6b4020e93   # upgrade chore (build/test/lint mechanical fixes)
   git cherry-pick $(git log --format=%H --grep='docs(upgrade)' -1 feat/upgrade-to-n8n-2.17.7)  # this docs file
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
7. **Run affected tests.**
   ```bash
   pnpm test:affected
   ```
8. **Pack for Docker.** This must run in **foreground** — backgrounding it
   gets SIGTERM'd before the `pnpm deploy` step finishes.
   ```bash
   node scripts/build-n8n.mjs > build-pack.log 2>&1
   ```
   After it finishes, restore the in-place edits it made:
   ```bash
   git checkout -- package.json packages/frontend/@n8n/chat/package.json \
     packages/frontend/@n8n/design-system/package.json \
     packages/frontend/editor-ui/package.json
   ```
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

## Manual smoke checklist

Run these after every upgrade before tagging "done":

- [ ] Login via OIDC (Azure Entra). Admin gets `global:admin`, member gets `global:member`.
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
- [ ] `curl http://localhost:5678/metrics` shows `n8n_workflow_executions_total`
      with `execution_mode` and `project_id` labels.
- [ ] LmChatAzureOpenAi node can authenticate via OAuth2 (APIM path).
- [ ] `pnpm test:affected` is green.

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
| Prometheus dashboard breaks after upgrade                                          | Cardinality of `n8n_workflow_executions_total` changed — audit `metrics/prometheus-metrics.service.ts` for upstream renames before widening panels' `by()`.                              |
| `pnpm typecheck` reports 46 × `TS2339: Property 'X' does not exist on type '{}'` in Node Governance modal Vue files | Upstream tightens generic inference. Each `modalData` computed in the six modal wrappers under `frontend/editor-ui/src/features/settings/nodeGovernance/components/` must annotate the modal payload with its concrete governance type (`NodeAccessRequest`, `NodeCategory`, or `NodeGovernancePolicy`) imported from `nodeGovernance.api.ts`. Folded into `chore(upgrade-2.17.7)` (`a6b4020e93`); re-apply on the next typecheck regression. |
| `@n8n/workflow-sdk` test suite fails with 44 × `Exceeded timeout of 120000 ms for a hook` on `setupTestSchemas`     | Upstream `beforeAll(setupTestSchemas, 120_000)` regenerates zod schemas for ~169 nodes from `packages/nodes-base/dist/types/nodes.json`. Under heavy parallel load (e.g. when nodes-base jest workers are still warm) this hook can exceed 120 s. Re-run `pnpm --filter=@n8n/workflow-sdk test` in isolation to verify; if it passes alone, the failure was contention, not a regression. |
| `pnpm install --frozen-lockfile` fails inside the Cursor sandbox with `EPERM: reflink` or `EPERM: unlink` on `node_modules` | The sandbox blocks APFS clonefile and certain in-place modifications. Wipe all `node_modules` (`rm -rf node_modules && find packages -name node_modules -type d -prune -exec rm -rf {} +`), then re-run `CI=true pnpm install --frozen-lockfile` outside the sandbox (`required_permissions: ["all"]` in tooling).        |
| `pnpm lint` from repo root SIGKILLs (exit 137) on the typecheck/lint turbo run     | Out-of-memory under turbo's parallel workers. Run lint per heavy package with `NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter=<pkg> lint` for `n8n`, `n8n-nodes-base`, and `n8n-editor-ui`.                                                |

## Ownership

Owned by the platform team. Update this file **in the same PR** that introduces
or modifies a customization — not as a follow-up.

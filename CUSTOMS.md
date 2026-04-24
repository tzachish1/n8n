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
| `feat/upgrade-to-n8n-2.17.5` (current)   | `n8n@2.17.5` | 7              | OIDC provisioning hardening, audit enrich — **squashed one commit per feature area** |

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
- `25d54cb81d feat(node-governance): introduce node governance with audit, enforcement, and per-project overrides`

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

**Upgrade checklist**
- After rebase, **run `pnpm build` and confirm the two governance migrations still register** in both `postgresdb/index.ts` and `sqlite/index.ts`. Upstream frequently adds migrations and the merge tool can drop our lines silently.
- `packages/@n8n/db/src/entities/project.ts` is a hotspot — upstream often extends the entity; make sure `governanceDefaultBehavior` survives.
- If upstream refactors `WorkflowService.create/update/import` signatures, re-wire the governance enforcement call at the same call-site.
- FE side: any upstream refactor of settings navigation / RBAC store can silently remove the `nodeGovernance` entry. Verify the menu item actually appears for an owner user.

### 2. Akeyless External Secrets Provider

**What & why.** Adds Akeyless (https://www.akeyless.io) as a first-class
external-secrets backend alongside the upstream Vault / AWS Secrets Manager
providers. Needed for enterprise deployments.

**Commit on current branch (single, squashed)**
- `2d43153700 feat(external-secrets): add Akeyless provider with subfolder support and log redaction`

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
- `6526a07ddd feat(sso-oidc): harden Azure Entra direct-claim provisioning for instance and project roles`

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

### 4. Azure OpenAI APIM support (nodes-langchain)

**What & why.** Adds OAuth2 / APIM-mediated auth to the `LmChatAzureOpenAi`
node so enterprises can route through Azure API Management.

**Commit on current branch**
- `7b8b8b737d feat(nodes-langchain): add Azure API Management (APIM) support for Azure OpenAI`
  *(was `015157d75e` pre-squash — same diff, new SHA because the branch was rebased+squashed)*

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
- `e1ecd523fc feat(core): add execution_mode and project_id labels to Prometheus metrics plus Docker build splits`

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
- `7e7e76d567 chore(upgrade-2.17.5): build, lint, test, and repo-hygiene fixes to land customizations on 2.17.5`

**Original component commits (pre-squash)**
- `39dbfffcf2` ignore local build/docker/install log artefacts
- `1b72fd3ab7` restore build, typecheck and lint after 2.17.5 rebase
- `c0ebb35962` align upstream tests with customizations
- `7b1e5e220b` clear residual stylelint debt from 2.17.5 rebase

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
commit or let it be a trailing docs commit — either way, it stays at position
7 on the branch.

## Upgrade procedure (repeatable)

This is the workflow we actually followed for 2.15.1 → 2.17.5 and that landed
cleanly on the branch listed in **Baseline tags**.

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
   (`feat/upgrade-to-n8n-2.17.5` at time of writing), cherry-pick these
   **seven** commits one at a time in this exact order:

   ```bash
   git cherry-pick 25d54cb81d   # node governance
   git cherry-pick 2d43153700   # external secrets (Akeyless)
   git cherry-pick 6526a07ddd   # SSO OIDC provisioning hardening
   git cherry-pick 7b8b8b737d   # Azure OpenAI APIM (nodes-langchain)
   git cherry-pick e1ecd523fc   # Prometheus labels + Docker build splits
   git cherry-pick 7e7e76d567   # upgrade chore (build/test/lint mechanical fixes)
   git cherry-pick $(git log --format=%H --grep='docs(upgrade)' -1 feat/upgrade-to-n8n-2.17.5)  # this docs file
   ```

   The docs SHA is resolved at cherry-pick time because it drifts every time
   `CUSTOMS.md` is updated.

   Prefer cherry-pick over merge to keep the branch readable. If a
   cherry-pick conflicts:

   - Check the **Upgrade checklist** for the affected section.
   - Resolve, then run `pnpm typecheck` on that package before moving on.
   - After upgrade is verified end-to-end, squash any new mechanical fix-up
     work into the `chore(upgrade-X.Y.Z)` commit so the next upgrade still
     sees exactly seven commits.
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
    cherry-picks exactly seven commits:

    ```bash
    # After verification is complete, from the feature branch:
    git rebase -i n8n@X.Y.Z
    # Mark the new chore commits as `fixup` under the chore(upgrade-X.Y.Z)
    # pick line, or use `squash` and curate the combined message.
    ```

    Always create a `backup/pre-squash-X.Y.Z` tag on the old HEAD first so
    you can recover if the squash goes sideways.

13. **Update this file.** Bump the baseline tags table to point to the new
    tag, update the seven SHAs in step 3, record any new upgrade-checklist
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
| Secrets appear in `docker logs` at `-v` verbosity                                  | Regression in `akeyless.ts` interceptors. The log-redaction change is baked into the single External Secrets commit (`2d43153700`); if a future rebase drops it, restore method/URL/status-only logging in both interceptors. |
| Node governance migrations missing after upgrade                                   | Upstream merge dropped our entries in `migrations/postgresdb/index.ts` or `migrations/sqlite/index.ts`. Re-add them in chronological order.                                              |
| Project override names render as "M…", "My proj…"                                  | Upstream SCSS refactor broke the grid layout in `SettingsTab.vue`. The `.projectRow { display: grid; grid-template-columns: minmax(0, 1fr) 220px; }` block is part of the Node Governance commit (`25d54cb81d`); re-apply if a merge drops it. |
| `pnpm install --frozen-lockfile` fails about `patchedDependencies`                 | Someone (often an editor auto-formatter) truncated `package.json`. `git checkout -- package.json` and retry.                                                                             |
| `build-n8n.mjs` killed mid-deploy, frontend `package.json` files now stripped      | That's the script's in-place edit phase. Restore them with the `git checkout` command in step 8 above.                                                                                   |
| Prometheus dashboard breaks after upgrade                                          | Cardinality of `n8n_workflow_executions_total` changed — audit `metrics/prometheus-metrics.service.ts` for upstream renames before widening panels' `by()`.                              |

## Ownership

Owned by the platform team. Update this file **in the same PR** that introduces
or modifies a customization — not as a follow-up.

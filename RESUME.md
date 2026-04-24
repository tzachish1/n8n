# RESUME — n8n 2.22.4 → 2.25.7 upgrade

**Authoring date:** 2026-06-10 13:46 UTC+3
**Last updated:** 2026-06-11 (Phase 5 complete)
**Status:** **Phase 1 + Phase 3 + Phase 4 + Phase 5 + Phase 6 COMPLETE.** All 10 fork commits re-applied; build, typecheck, and test:affected are clean modulo confirmed concurrency/upstream flakes (see Phase 6 section below). Next: **Phase 7** (Docker build arm64 + amd64), then manual test matrix + staging smoke.
**Plan doc:** [`CUSTOMS-upgrade-2.25.7-plan.md`](./CUSTOMS-upgrade-2.25.7-plan.md) (960 lines, single source of truth)

> ⚠️ **Hook-bypass exception authorized:** The new upstream `migration-timestamp` lefthook rule blocks cherry-picks because all fork migrations (1768/1772/1778/1784000000007) sit below the floor `1784000000021`. User explicitly authorized `LEFTHOOK=0 git cherry-pick --continue` for migration-bearing commits in this upgrade. Apply same exception to §10 OIDC, §9 seed, §11 SaaS if/when needed.

---

## Quick reorientation for a new chat

Paste this into the new chat as your first prompt:

```
Continue the n8n 2.22.4 → 2.25.7 upgrade. The full plan, audit, and commit-by-commit
decisions are in CUSTOMS-upgrade-2.25.7-plan.md. Read RESUME.md for current state.
Start at Phase 3 cherry-picks: begin with `git cherry-pick a894aa7945` (§1 governance).
Apply Phase 2 conflict-resolution policy as conflicts arise (take upstream wholesale on
oauth.service.ts, oauth2-credential.controller.ts, dynamic-credentials-proxy.ts,
credentials.service.ts).
```

---

## Current repo state (verified 2026-06-10 14:05 UTC+3)

### Branch
- **Current:** `feat/upgrade-to-n8n-2.25.7`
- **HEAD:** `1050d662395` docs(upgrade-2.25.7): Phase 4 reconcile #31211 editor warning
- **Baseline:** `n8n@2.25.7` (`b06d9b5dfb`)
- **Source branch (preserved):** `feat/dynamic-credentials-saas-generic` (HEAD `dc094b479c`) — keep as reference
- **Fork commits re-applied:** **10 / 10 commits** (§1, §2, §3, §8, §4, §5, §7, §9, §10, §11 — `dc094b479c` folded into §10, v1.5 dropped as superseded by upstream)
- **Fork commits remaining:** **0** — Phase 3 complete
- **Cherry-pick chain (oldest → newest):** `8138689b46` (§1) → `213fdb13117` (§2) → `acf714a464f` (§3) → `6ddec3fda8f` (§8) → `20741fca770` (§4) → `1d1af2b4091` (§5) → `820bf6fcb39` (§7) → `136330ca00d` (§9) → `416e81a3d4` (§10) → `800d4b126e3` (§11)
- **Stash dropped:** `fork-v11-saas-keep` successfully applied and cleared

### Working tree
- **Clean** except for `CUSTOMS-upgrade-2.25.7-plan.md` (intentional — operational doc)
- **No v1.5 traces** (`grep -rn subjectOverride packages/cli packages/workflow` returns zero)

### Safety nets (4 layers)
| Mechanism | Name | Recovery command |
|---|---|---|
| Tag | `backup/pre-upgrade-2.25.7-tip` | `git reset --hard backup/pre-upgrade-2.25.7-tip` |
| Branch | `backup/pre-upgrade-2.25.7-branch` | `git checkout backup/pre-upgrade-2.25.7-branch` |
| Stash {1} | `pre-upgrade-2.25.7-snapshot` (full 18-file uncommitted state) | `git stash apply stash@{1}` |
| Stash {0} | `fork-v11-saas-keep` (§11 v1 only, 13 files, ~929+/-23 lines) | `git stash apply stash@{0}` |

### Stashes (full list)
```
stash@{0}: On feat/dynamic-credentials-saas-generic: fork-v11-saas-keep     ← Phase 3 will re-apply this
stash@{1}: On feat/dynamic-credentials-saas-generic: pre-upgrade-2.25.7-snapshot  ← emergency restore
```

---

## Phase progress

| Phase | Description | Status |
|---|---|---|
| 0 | Pre-flight: revert v1.5 (4 files + 1 surgical), preserve v1 in stash, safety branch/tag | ✅ DONE |
| 1 | Fetch n8n@2.25.7 tag + create feat/upgrade-to-n8n-2.25.7 branch | ✅ DONE (2026-06-10 14:05) |
| 2 | Conflict-resolution policy: take upstream wholesale on oauth.service.ts, oauth2-credential.controller.ts, dynamic-credentials-proxy.ts, credentials.service.ts (applied during Phase 3) | POLICY READY |
| 3 | Re-apply fork additive features per Appendix D §D.5 cherry-pick sequence | IN PROGRESS (§1 done, §2 next) |
| 4 | Reconcile #31211 (manual-trigger-only validation) | ✅ DONE — docs only; no code forward-port |
| 5 | Reconfigure runtime + drop now-unused env vars | ✅ DONE — docs/runbook; no repo config held the var |
| 6 | typecheck + lint + test:affected | ✅ DONE (2026-06-11 12:40 UTC+3) — see Phase 6 section |
| 7 | Docker build (arm64 + amd64) | PENDING |
| 8 | Manual test matrix | PENDING |
| 9 | Update CUSTOMS.md | PENDING |
| 10 | Staging smoke | PENDING |

---

## Phase 1 — DONE

- Upstream fetched, `n8n@2.25.0` … `n8n@2.25.7` tags present locally
- Branch `feat/upgrade-to-n8n-2.25.7` created off `n8n@2.25.7` (HEAD `b06d9b5dfb`)
- `git describe --tags --exact-match HEAD` → `n8n@2.25.7` ✓
- All safety stashes + backup tag/branch still intact

## Phase 3 progress

### §1 governance (commit `a894aa7945` → `8138689b46`) — DONE
3 textual conflicts (all "both-add" — upstream and the squashed-against-2.19.2 commit added different things at adjacent lines). Resolutions: keep both sides.

| File | Conflict | Resolution |
|---|---|---|
| `packages/cli/src/eventbus/event-message-classes/index.ts` | Upstream added `n8n.audit.oauth.callback.binding.rejected`; fork added 13 `n8n.audit.node-governance.*` entries | Kept both |
| `packages/cli/src/events/relays/log-streaming.event-relay.ts` | Upstream added `withoutExecutionMetadata()` helper; fork added `sourceToMode` mapping | Kept both (both referenced elsewhere in file) |
| `packages/cli/src/workflows/workflow-creation.service.ts` | Upstream injects `WorkflowValidationService`; fork injects `NodeGovernanceService` | Kept both (imports already present from both sides) |

Lefthook `migration-timestamp` rule rejected the 3 staged governance migrations (timestamps 1768/1772/1778 ≤ floor 1784000000021). User-authorized bypass: `LEFTHOOK=0 git cherry-pick --continue`.

### §2 akeyless (commit `a1286ad4db` → `213fdb13117`) — DONE
Clean cherry-pick. 7 files, +1170/-2. Pure additive.

### §3 OIDC hardening (commit `aa72e0b97f` → `acf714a464f`) — DONE
Clean cherry-pick (auto-merge on `packages/@n8n/config/test/config.test.ts`). 7 files, +388/-43.

### §8 CI trim (commit `4b4bfac715` → `6ddec3fda8f`) — DONE
13 conflicts. Resolutions:
- 11 modify/delete: `git rm` (fork wants to delete these workflow files; upstream tweaks discarded — fork's intent prevails)
- `ci-pull-requests.yml` (6 textual conflicts): kept upstream's new outputs/filters/matrix-and-affected-packages steps (required by upstream `test-unit-reusable.yml`), but dropped upstream's new jobs that either reference §8-deleted reusables (`sqlite-sanity`, `e2e` → `test-e2e-reusable.yml`) or are n8n-io-gated (`prepare-docker`, `dev-server-smoke`, `instance-ai-discovery-evals`). Simplified `Generate shard matrix` condition from `.ci || .e2e` to just `.ci` since the `e2e` filter was dropped.
- `util-qa-metrics-comment-reusable.yml`: kept upstream's simpler version (the whole job is gated by `github.repository == 'n8n-io/n8n'` so it never runs on the fork either way).

### §4 APIM (commit `f521207ba5` → `20741fca770`) — DONE
Clean cherry-pick (predicted MEDIUM conflict with upstream `AzureEntraCognitive` did not materialize). 9 files, +669/-49.

### §5 prometheus+docker (commit `2c9f4bb2fe` → `1d1af2b4091`) — DONE
1 conflict in `docker/images/n8n/Dockerfile` (isolated-vm rebuild approach):
- HEAD (2.25.7): `rm -rf node_modules/isolated-vm/prebuilds && cd ... && npx --yes node-gyp rebuild --release -j max` — addresses DHI Alpine + parallel compile
- §5 (fork): `JOBS=1 npm rebuild isolated-vm` — fork's older single-job workaround for Apple-Silicon cross-compile races
- **Resolution:** Took HEAD's more sophisticated approach. The fork's flatten-image stage (`FROM ... AS base` / `FROM scratch` / `COPY --from=base / /` — needed for Nexus OCI/Docker v2 layer parity) was preserved via auto-merge.
- **Risk to verify in Phase 7 Docker build:** If `-j max` triggers Apple-Silicon cross-compile races, revert this line to `JOBS=1 npm rebuild isolated-vm` (keeping the rest of HEAD's approach).

### §7 CUSTOMS.md (commit `b07fdaa1ce` → `820bf6fcb39`) — DONE
1 trivial conflict in `.gitignore` (both sides added new patterns). Resolution: kept both. The §7 `*.log` catch-all subsumes upstream's `stryker.log` (both kept; harmless).
**Phase 9 reminder:** amend `CUSTOMS.md` to reflect the 2.22.4→2.25.7 upgrade history and the resolutions in this RESUME doc.

### §9 seed endpoint (commit `613d2ef712` → `136330ca00d`) — DONE
Clean cherry-pick (auto-merge in `dynamic-credentials.module.ts`).
Plan anticipated a mechanical `saveDynamicCredential` signature reconcile (per #31343), but **no reconcile needed**: fork-tip and 2.25.7 have identical `saveDynamicCredential(credential, oauthTokenData, authHeader, credentialResolverId, authMetadata)` signatures. The §9 controller intentionally wraps the token payload as `{ oauthTokenData: {...} }` — confirmed by the test assertions on `call[1]`, so this is by design, not a reconcile artifact.

### §10 OIDC Graph (commit `f9ada888ae` → `416e81a3d4`) — DONE
**HIGH-risk reconcile turned out gentler than the plan predicted.** None of the four files the plan flagged for "take upstream wholesale" (`oauth.service.ts`, `oauth2-credential.controller.ts`, `dynamic-credentials-proxy.ts`, `credentials.service.ts`) were touched by `f9ada888ae` — those changes had lived in the now-reverted v1.5 work (dropped in Phase 0). Only 3 actual conflicts:

| File | Conflict | Resolution |
|---|---|---|
| `packages/@n8n/db/src/migrations/postgresdb/index.ts` + `sqlite/index.ts` | **Timestamp collision at `1784000000007`** — upstream added `CreateInstanceAiCheckpointTable1784000000007` between 2.22.4 and 2.25.7, fork wanted to add `AddOidcSeedSourceToCredentialResolver1784000000007` | **Renamed fork migration to `1784000000022-AddOidcSeedSourceToCredentialResolver.ts`** (next free slot after upstream's `…021`); kept all upstream `…007`–`…021` migrations as-is; added the renamed migration at the tail. Also updated CUSTOMS.md to point at the new timestamp. |
| `packages/cli/src/modules/dynamic-credentials.ee/services/dynamic-credential.service.ts` | Both-add: upstream imported `DynamicCredentialsProxy` (used at line 62 as constructor arg); §10 imported `ILazySeedProvider` type | Kept both imports |

**The renamed migration carries the idempotency guard from `dc094b479c` folded in directly** (so existing fork installs with `oidcSeedSource` column already present from the historical `1785000000000` or `1784000000007` migration names will skip the DDL via `findColumnByName` guard, exactly as `dc094b479c` designed). This made the subsequent `dc094b479c` cherry-pick redundant — see below.

**Bonus discovery during §10 audit (worth a follow-up ticket):** upstream 2.25.7 shipped a new `packages/cli/src/modules/token-exchange/` module that implements RFC 8693 token exchange with its own `JwksResolver` + `TrustedKeyService` infrastructure. §10's `OAuth2JwtClaimIdentifier` (Phase 2c) does its own JWKS validation. Post-upgrade, there's an opportunity to factor §10 onto upstream's trusted-key registry. Not required for this upgrade; out of Phase 3 scope.

### §10 idempotency fix (commit `dc094b479c`) — SKIPPED (folded into §10)
The idempotency guard was incorporated directly into the renamed §10 migration `1784000000022-AddOidcSeedSourceToCredentialResolver.ts` during the timestamp-collision resolution above. Cherry-picking `dc094b479c` would have hit a modify/delete conflict (it patches the old `…007` filename, which no longer exists). Skipped via `git cherry-pick --skip` after cleaning up the orphan file git restored.

### §11 SaaS Generic OAuth2 Resolver (stash → `800d4b126e3`) — DONE
**Verified required:** zero upstream equivalent for any of §11's primitives (`fallbackCredentialId`, `n8n.audit.dynamic-credential.fallback-used`, `loadResolverEntityCached`, per-execution credential-context memoization). Upstream's "fallback" in `dynamic-credential.service.ts` is a *different* concept (resolver-id fallback for workflow-default resolver, per #31116), and upstream's new `CacheService` usage in identifiers is at a *different layer* (identity-cache, not resolver-entity / execution-context).

The v1.5 portion (`subjectOverride` + session-authorize overlay) was intentionally NOT applied — superseded by upstream #30653 + #30994 (already dropped from the stash in Phase 0).

Stash-pop produced 3 conflicts, all in the same shape (additive constructor-arg merge):

| File | Conflict | Resolution |
|---|---|---|
| `dynamic-credential.service.ts` constructor | §11 wanted `cacheService` as 8th arg; §10 already added `dynamicCredentialsProxy` there | Kept both — `dynamicCredentialsProxy` then `cacheService` (preserves upstream + §10 ordering) |
| `credential-resolver.service.ts` imports | Upstream needed `Not` from typeorm (new query helper); §11 needed `Container` from `@n8n/di` (for lazy `Container.get(DynamicCredentialService)` to break a DI cycle in `invalidateResolverEntityCache`) | Kept both imports |
| `dynamic-credential.service.test.ts` (5 call sites × 7 hunks) | Same pattern: each `new DynamicCredentialService(...)` constructor call had to grow by both `mockDynamicCredentialsProxy` AND `mockCacheService` | Resolved all sites uniformly via `StrReplace --replace-all`, kept both mocks in declarations + `beforeEach` setup |

Stash `fork-v11-saas-keep` dropped after the commit landed.

## Phase 3 Summary

**10 of 10 fork commits successfully re-applied on top of `n8n@2.25.7`.** No fork features dropped except where upstream now provides an equivalent or better path (v1.5 overlay → #30653 + #30994). All originally-planned "HIGH risk" reconciles turned out gentler than predicted because Phase 0's v1.5 revert had pre-cleared the most contentious surface (`oauth.service.ts`, `oauth2-credential.controller.ts`, `dynamic-credentials-proxy.ts`, `credentials.service.ts`).

**Key follow-ups captured (out of upgrade scope):**
1. Refactor §10's `OAuth2JwtClaimIdentifier` onto upstream's new `JwksResolver` + `TrustedKeyService` (`packages/cli/src/modules/token-exchange/`) for a single trusted-key registry
2. Decide whether to migrate Monday.com et al. from §11 OAuth2 resolver to upstream's N8N system resolver per the §11 plan table (operator decision, not code)
3. Update `CUSTOMS.md` in Phase 9 to (a) mark v1.5 obsolete, (b) annotate §3 absorptions, (c) flag §11 entries supplemented by upstream #30653/#30994, (d) update the upgrade procedure to reference 2.25.7

## Phase 6 — DONE (build + typecheck + test:affected)

### Build — CLEAN (60/60 packages)
Fixed 3 fork-rebase residues:
- `packages/cli/src/execution-lifecycle/execution-lifecycle-hooks.ts` — added `projectId?: string` to `hookFunctionsNodeEvents` signature + call sites (upstream §1 governance helper signature drifted vs §1's caller)
- `packages/cli/src/sso.ee/oidc/oidc.controller.ee.ts` — removed duplicate `eventService` declaration (cherry-pick collision)
- `packages/cli/src/workflows/workflow-execution.service.ts` — `ownerProject?.id` → `project?.id` (upstream rename)

(Required a full `rm -rf node_modules && pnpm install` first to unstick stale pnpm hoisting after the 2.22.4→2.25.7 dep churn — `@tiptap/vue-3` + `@smithy/node-http-handler`.)

### Typecheck — CLEAN (109/109 packages)
Fixed:
- **11 cli test-mock signatures** — added missing constructor args after fork commits widened service signatures:
  - `ExecutionService` (+`ownershipService`) in 2 test sites
  - `WorkflowCreationService` and `WorkflowService` (+`nodeGovernanceService`)
  - `node-governance.service.test.ts` (`mock<Project>` typing)
  - `prometheus-metrics.test.ts` + `@n8n/config/test/config.test.ts` (+`includeProjectIdLabel: false`)
  - `get-resource-permissions.test.ts` (+`nodeGovernance: {}`)
  - `scope-information.test.ts.snap` (added `nodeGovernance:manage` and `nodeGovernance:*`)
- **1 design-system import** — `Markdown.vue` reverted `import { full as markdownEmoji }` → default import (upstream pinned `markdown-it-emoji@2.0.2` which lacks the `full` named export)
- **4 editor-ui fork-rebase residues** — `useWorkflowSaving.ts` (drop unused `projectsStore`), `NodeAccessRequestModal.vue` (use `injectWorkflowDocumentStore().value.name`), `PoliciesTab.vue` (switch ProjectSharing to `searchFn`), `SettingsTab.vue` (widen `name: string | null`)

### test:affected — fork-rebase residues fixed, remaining failures all flakes/upstream

| Category | Files | Fixed (real fork residue) | Confirmed flake / upstream |
|---|---|---|---|
| `packages/cli` | 9 originally failing | `dynamic-credential.cache.test.ts` (3), `dynamic-credential.service.test.ts` (21+5 via `arrangeDecryptMocks`), `workflow-creation.service.test.ts` (2 via `validation?.hasBlockedNodes`), `oidc.service.ee.test.ts` (unit, 2: `discovery` 5-arg signature + `scopesProvisionInstanceRole: true`), `oidc.service.ee.test.ts` (integration, 2: `discoveryMock` + error msg), `log-streaming-event-relay.test.ts` (9 cases: payload gained `mode` + `projectId` from §1 `sourceToMode`) | `public-api/users.ee.test.ts` (HTTP parse error only under full-suite concurrency — passes in isolation) |
| `packages/frontend/editor-ui` | 7 originally failing | `ui.store.registration.spec.ts` (registered `APPROVE_REQUEST_MODAL_KEY` + `REJECT_REQUEST_MODAL_KEY` in `modalsById`), `NodeCreator.test.ts` (`@vueuse/core` mock now uses `importOriginal` so `useAsyncState` is preserved for the transitively-imported `users.store`) | `router.test.ts` `/workflow → NodeViewExisting` (timeout only under full-suite contention; passes in isolation in 5.3s) |
| `packages/@n8n/workflow-sdk` | 5 failing | none — all 5 are concurrency races (parallel temp-dir + `setupTestSchemas` 120 s timeout). `pnpm jest --runInBand` passes 100 %. | — |
| `packages/@n8n/syslog-client` | 1 failing | none — `tcp.test.ts > should handle connection timeout` is upstream pre-existing on Darwin/Node 22.19 (zero diff vs `n8n@2.25.7`) | — |
| `extension-sdk`, `constants`, `scan-community-package`, `node-dev`, `playwright-janitor` | "No tests found" | n/a — these packages ship a `test` script but contain zero `*.test.ts` files; benign upstream artifact | — |

### Carried follow-ups (do NOT block this upgrade)
1. **workflow-sdk parallel-safety:** the validation + generate-types tests need either unique temp-dir-per-test or `maxWorkers: 1` in jest config to be reliable in parallel. Pre-existing inherited bug; not a fork regression.
2. **syslog-client `tcp` timeout test on Darwin:** upstream issue; consider filing a ticket against n8n-io/n8n.
3. **`public-api/users.ee.test.ts` parse-error under concurrency:** investigate keepAlive/agent leakage between tests in `testServer.publicApiAgentWithoutApiKey`. Pre-existing inherited bug.

---

## Phase 4 — DONE (#31211 reconcile)

**Decision:** Fork does **not** forward-port a runtime manual-trigger gate. Upstream
#31211 is already present in 2.25.7 as an **editor-only** NDV warning
(`useNodeHelpers.ts`). Fork `WorkflowValidationService.validateDynamicCredentials`
is orthogonal (publish-time identity-extractor check, not manual-trigger check).
§10 lazy-seed / §9 programmatic seed continue to work on webhook/schedule triggers.

**Action taken:** Documentation only — `CUSTOMS.md` §10 (#31211 interaction note) +
`Credential-Seeding-Guide.md` Part 5 troubleshooting FAQ. No code changes.

---

## Phase 5 — DONE (runtime reconfiguration + env-var audit)

**Env-var audit (`grep` across tracked `docker-compose*`, `.env*`, `*.md`):**
- `N8N_SKIP_AUTH_ON_OAUTH_CALLBACK` — **not present** in any tracked deployment
  config. Documented removal guidance in `CUSTOMS.md` §10 env-var audit and
  `Credential-Seeding-Guide.md` Part 5. Operators who set it externally for
  dynamic-credential OAuth only should unset it post-upgrade (#31103). Keep only
  for embed/iframe static-credential OAuth.
- `N8N_SSO_OIDC_GRAPH_SEED_RESOLVER_IDS` — already removed in Phase 2d (code +
  docs). No live references found.

**Credential resolver decisions (operator runbook — run against staging DB):**

| Credential | Post-upgrade resolver | Action |
|---|---|---|
| Microsoft Outlook / Teams | Keep §10 OIDC | No change — webhook lazy-seed |
| Monday.com (UI-driven) | Switch to N8N system resolver | `UPDATE credentials_entity SET "resolverId" = NULL WHERE id = '…'` |
| Monday.com (webhook fallback) | Keep §11 + `fallbackCredentialId` | Optional shared static credential |

Full table + SQL in `Credential-Seeding-Guide.md` Part 5 ("Post-upgrade runtime
reconfiguration"). No code changes — deployment-specific operator steps.

**Deferred (not blocking upgrade):** env-var renames (`AUTO_SEED` →
`LOGIN_SEED`, `LAZY_SEED` → `WEBHOOK_SEED`) per `CUSTOMS.md` §10 env-var audit
— cosmetic, out of 2.25.7 scope.

---

## What to do next (resume point)

Phase 5 is closed. Recommended next: **Phase 7** (Docker build).

```bash
cd /Users/tzacis/Documents/projects/n8n-fork
git status                       # clean (modulo operational docs)
git log -1 --oneline             # 800d4b126e3 feat(dynamic-credentials): ... §11 v1

# Phase 6 fast sanity check (build is required before typecheck on cross-package
# changes — we modified @n8n/api-types schemas and @n8n/db migrations)
NODE_OPTIONS=--max-old-space-size=10240 pnpm build > build.log 2>&1
tail -n 20 build.log

pushd packages/cli
pnpm typecheck > /tmp/cli-typecheck.log 2>&1
tail -n 30 /tmp/cli-typecheck.log
popd

# If clean → proceed to Phase 4 (#31211 reconcile)
# If errors → fix and re-run before Phase 4
```

Alternative ordering (per plan): Phase 4 → Phase 5 → Phase 6 → Phase 7+. The plan order is conservative; running Phase 6 first catches mechanical issues from the rebase faster.

---

## Phase 3 cherry-pick sequence (cheatsheet from plan Appendix D §D.5)

```bash
git cherry-pick a894aa7945   # §1 governance
git cherry-pick a1286ad4db   # §2 akeyless
git cherry-pick aa72e0b97f   # §3 OIDC hardening
git cherry-pick f521207ba5   # §4 APIM  ← MEDIUM conflict expected (upstream AzureEntraCognitive)
git cherry-pick 2c9f4bb2fe   # §5 prometheus + docker  ← MEDIUM Docker conflict expected
git cherry-pick 4b4bfac715   # §8 CI trim
# SKIP 7e02413711 — §6 chore-upgrade-2.22.4, replaced at Phase 6
git cherry-pick b07fdaa1ce   # §7 CUSTOMS.md  ← amend at Phase 9
git cherry-pick 613d2ef712   # §9 seed endpoint  ← mechanical reconcile for saveDynamicCredential signature
git cherry-pick f9ada888ae   # §10 OIDC Graph  ← HIGH reconcile (oauth.service, controller, proxy)
git cherry-pick dc094b479c   # §10 migration idempotency fix

git stash pop fork-v11-saas-keep
git add -A && git commit -m "feat(dynamic-credentials): generic SaaS OAuth2 resolver with hybrid fallback (§11 v1)"
```

---

## Key findings carried forward

1. **Dynamic-credentials tables ownership:** `dynamic_credential_entry` and `dynamic_credential_user_entry` are **UPSTREAM** (since `n8n@2.22.4`). The only fork-added DB object in the namespace is the single column `dynamic_credential_resolver.oidcSeedSource` (commit `f9ada888ae` → migration `1784000000007`).
2. **Total fork DB delta:** 5 tables + 1 partial unique index + 2 columns. All in 4 fork migrations, all additive/nullable. Zero collision with anything upstream changed between 2.22.4 and 2.25.7.
3. **v1.5 overlay (subjectOverride + session-authorize):** fully redundant given upstream `#30653` + `#30994`. Already dropped in Phase 0.
4. **§11 v1 work (OAuth2 fallback + caching + audit event):** **KEEP**. Stashed as `fork-v11-saas-keep` for re-application in Phase 3.
5. **Node Governance (PR #29442):** authored by us, still **OPEN**, never merged in upstream 2.25.7. Pure fork feature, full cherry-pick.
6. **Cherry-pick risk hotspots:** commit 4 (APIM), commit 5 (Docker buildx), commit 10 (OIDC Graph — biggest). All other commits should apply clean.

See plan doc Appendices C and D for full details.

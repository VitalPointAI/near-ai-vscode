---
phase: 68-relay-foundation
reviewed: 2026-11-15T00:00:00Z
depth: deep
files_reviewed: 46
files_reviewed_list:
  - .dockerignore
  - .github/workflows/ci.yml
  - .gitignore
  - .vscodeignore
  - CONTRIBUTING.md
  - docs/development-workflow.md
  - relay/.npmrc
  - relay/.nvmrc
  - relay/Dockerfile
  - relay/README.md
  - relay/compose.yaml
  - relay/package.json
  - relay/scripts/build.mjs
  - relay/scripts/check-node.mjs
  - relay/src/bin.ts
  - relay/src/config.ts
  - relay/src/health.ts
  - relay/src/http/server.ts
  - relay/src/log/logger.ts
  - relay/src/log/pseudonymKey.ts
  - relay/src/log/redact.ts
  - relay/src/main.ts
  - relay/src/nodeVersion.ts
  - relay/src/secrets.ts
  - relay/src/stateDir.ts
  - relay/src/store/relayStore.ts
  - relay/src/store/schema.ts
  - relay/src/store/sqliteStore.ts
  - relay/src/types/node-sqlite-database.d.ts
  - relay/test/container/container.test.ts
  - relay/test/contract/relayStore.contract.ts
  - relay/test/fixtures/crashWriter.ts
  - relay/test/health.test.ts
  - relay/test/killDrill.test.ts
  - relay/test/logging.test.ts
  - relay/test/noLeak.test.ts
  - relay/test/pseudonymKey.test.ts
  - relay/test/schema.test.ts
  - relay/test/secrets.test.ts
  - relay/test/sqliteStore.test.ts
  - relay/test/startup.test.ts
  - relay/test/stateDir.test.ts
  - relay/test/workspace.test.ts
  - relay/tsconfig.json
  - scripts/lib/workflow.mjs
  - scripts/verify-release-content.mjs
  - src/test/relayIsolation.test.ts
findings:
  critical: 0
  warning: 7
  info: 7
  total: 14
status: issues_found
---

# Phase 68: Code Review Report

**Reviewed:** 2026-11-15
**Depth:** deep for relay/src/secrets.ts, relay/src/stateDir.ts, relay/src/log/*, relay/src/store/*, relay/Dockerfile, relay/compose.yaml, .github/workflows/ci.yml, scripts/lib/workflow.mjs, scripts/verify-release-content.mjs; standard for the rest (tests were checked for reliability only; `package-lock.json` was excluded).
**Files Reviewed:** 46
**Status:** issues_found

## Summary

The foundation is carefully built. Secret reads go through one opened descriptor, and the state directory and log paths fail closed. Every store write commits before it resolves, and SQL is only ever bound by parameter. I found no injection, path traversal, secret-leak or data-loss defect on a path reachable in this phase. The decision-level gaps (D-01..D-21) are covered by tests. The single-instance lock (D-21) is deferred to Phase 71 and is not reported.

The findings below are all latent. They are contracts that the store and the redactor state but do not enforce, plus one real break in an existing process (the hotfix flow). Fix the store and redactor items before Phases 69 to 71 build on them, because those phases would otherwise inherit the gaps silently. WR-01 should be fixed before the first hotfix is cut.

## Warnings

### WR-01: The required `relay` CI check cannot pass on a hotfix branch cut from an older tag

**File:** `.github/workflows/ci.yml:150-171`, `scripts/lib/workflow.mjs:5,20,463`, `docs/development-workflow.md:310-330`
**Issue:** The documented hotfix flow branches from an old tag and copies `.github`, `scripts` and `.vscodeignore` from `origin/main`. After this phase the copied `ci.yml` has a `relay` job with `defaults.run.working-directory: relay`. An old tag has no `relay/` directory, so the job fails at its first `run` step. `CI_CHECKS` and `REQUIRED_CHECKS` (`workflow.mjs:5,20`) now require `relay`, and the hotfix gate (`workflow.mjs:463`) uses `REQUIRED_CHECKS`. A hotfix therefore cannot satisfy the gate, and the doc's list of what to copy does not mention this. The release-content check and `.vscodeignore` handling are fine. Only the CI job and the gate list are affected.
**Fix:** Make the relay job skip cleanly when the package is absent, and have the gate accept a skipped job. For example, add a first step that sets an output when `relay/package.json` exists, and guard every later step with `if: steps.has_relay.outputs.present == 'true'`. The job then ends green on an old tag. Alternatively, document in the hotfix section that `git checkout origin/main -- relay .dockerignore` is also required. The first option is safer because it needs no human step.

### WR-02: Redactor's sensitive-key rule is an exact match, so `accessToken`, `clientSecret`, `idToken` and similar are logged verbatim

**File:** `relay/src/log/redact.ts:20-35,79-86`
**Issue:** The header calls rule 1 fail-closed, but `SENSITIVE_KEYS.has(normalised)` only drops keys that equal one of 14 names after normalisation. A field named `accessToken`, `refreshToken`, `idToken`, `clientSecret`, `botSecret`, `credential`, `jwt`, `signature`, `bearer` or `sessionCookie` normalises to a string that is not in the set. Its value goes through `text()`, which masks only values registered with `register()` (the operator secrets). Phase 69 handles Teams JWTs and Microsoft tokens that the relay mints at run time and never registers. A single `logger.info('x', { accessToken })` would write the token. `test/logging.test.ts` iterates the set itself, so it cannot notice a missing name.
**Fix:** Match by substring on the normalised key as well:
```ts
const SENSITIVE_FRAGMENTS = ['token', 'secret', 'password', 'passwd', 'apikey', 'authorization', 'cookie', 'credential', 'bearer', 'signature', 'jwt'];
function isSensitive(normalised: string): boolean {
  return SENSITIVE_KEYS.has(normalised) || SENSITIVE_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}
```
Add a test with `accessToken`, `clientSecret` and `idToken`.

### WR-03: Start-up recovery re-queues claimed messages but leaves their runs `running`; `interrupted` is never set

**File:** `relay/src/store/sqliteStore.ts:183-186` (with `relay/src/store/relayStore.ts:49-53`)
**Issue:** The constructor resets every `claimed` message to `queued`, so a crashed claim is delivered again. The run created for that message stays in `running` or `waiting-approval`, and nothing ever moves it to `interrupted` (the state exists in `RUN_STATES`, the schema CHECK and `IN_FLIGHT_RUN_STATES` logic, but no code assigns it). Consequences: `/healthz` `inFlightRuns` stays inflated forever after a crash. `acceptInbound` on the redelivery returns `duplicate: true` with the old run id, whose state is not `queued`, so a worker doing `transitionRun(queued -> running)` gets `false`. Approvals of that run stay `pending` until they expire. The kill drill checks messages and runs separately and never checks them together.
**Fix:** In the same recovery transaction, mark the orphaned runs and decide how they re-enter. For example:
```ts
db.exec(`UPDATE runs SET state = 'interrupted', updated_at = ${/* now */ 0} WHERE state IN ('running','waiting-approval')`);
```
and let the redelivery path move `interrupted -> queued`. Take `now` from the constructor options rather than interpolating. Whichever rule is chosen, add a contract test that reopens with a running run.

### WR-04: `answerApproval` and `getApproval` do not enforce the requester or the run state

**File:** `relay/src/store/sqliteStore.ts:429-442`, `relay/src/store/relayStore.ts` (`ApprovalRecord.requesterId` doc, `answerApproval` signature)
**Issue:** The record documents that "only this person may be offered the approval", and `listPendingApprovals` filters by requester. `answerApproval(tenantId, approvalId, decision, now)` takes no requester, so anyone in the tenant who learns an `approvalId` can answer it. It also does not check that the run is still `waiting-approval`, so an approval of a `cancelled` or `finished` run can still be answered (`allow-always` is a persistent grant in the extension's model). The authorisation decision is left to every future caller. This store is the stated single access path, so a missed check in Phase 71 becomes a privilege bypass.
**Fix:** Add `requesterId` to the signature and to the `UPDATE ... WHERE` clause, and join to the run's state:
```sql
UPDATE approvals SET state='answered', decision=?, answered_at=?
 WHERE tenant_id=? AND approval_id=? AND requester_id=? AND state='pending' AND expires_at > ?
   AND EXISTS (SELECT 1 FROM runs r WHERE r.tenant_id = approvals.tenant_id AND r.run_id = approvals.run_id AND r.state = 'waiting-approval')
```
Add contract tests for a wrong requester and a cancelled run.

### WR-05: `acceptInbound` does not check the conversation binding or the tenant status

**File:** `relay/src/store/sqliteStore.ts:308-344` (tenant check at 318-320)
**Issue:** The store's header promises that operations are scoped by tenant, and the schema has `conversation_bindings` for IDNT-03. `acceptInbound` only checks that the tenant row exists. It never checks that `(channel, conversationId)` is bound to `message.tenantId`, nor that the tenant's `status` is `active`. A caller bug that passes the wrong tenant id queues a message and a run for tenant B with a conversation that belongs to tenant A. A `suspended` tenant keeps accepting and queuing work. Neither is tested. The same applies to `claimNext`, which accepts any (tenant, channel, conversation) triple.
**Fix:** Inside the `acceptInbound` transaction, read the binding and the tenant row. Throw `StoreError('binding-conflict' | 'unknown-tenant')` when the binding is missing or belongs to another tenant, and a new `tenant-suspended` code when the status is not `active`. If binding-less acceptance is intended for the first message, say so in the interface comment and have the caller call `bindConversation` first.

### WR-06: `claimNext` can hand out a second message of a conversation while the first is still claimed

**File:** `relay/src/store/sqliteStore.ts:353-365` (query at 207-209)
**Issue:** `oldestQueued` selects only `state = 'queued'`. With message 1 `claimed` (being processed) and message 2 `queued`, `claimNext` returns message 2. Two runs for one conversation can then execute concurrently and finish out of order. The interface says it "takes the oldest queued message of one conversation" but the intent (per-conversation ordering, `ORDER BY message_id`) is order-preserving delivery. The contract test covers claim-ack-claim only. If the runner is meant to serialise this itself, that is a rule the store contract should state.
**Fix:** Either add `AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.tenant_id = m.tenant_id AND c.channel = m.channel AND c.conversation_id = m.conversation_id AND c.state = 'claimed')` to the select, or document in `relayStore.ts` that serialisation is the caller's job. Add a contract test for two queued messages with the first still claimed.

### WR-07: The Signal sidecar has none of the hardening the relay service has

**File:** `relay/compose.yaml:47-62`
**Issue:** The `relay` service sets `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `pids_limit` and `mem_limit`. The `signal` service, which holds the Signal registration (declared in `secrets.ts` as "itself the credential"), has none of them. `bbernhard/signal-cli-rest-api` runs as root by default with the full default capability set. It is off by default (profile `signal`), but when enabled it is the highest-value container in the project. The container suite only inspects the relay service.
**Fix:** At least add `security_opt: ["no-new-privileges:true"]`, `cap_drop: [ALL]`, `pids_limit` and `mem_limit`. Add `read_only: true` with tmpfs mounts if the image allows it (verify in Phase 75). Record in the README that the sidecar is not hardened beyond that, if it cannot be.

## Info

### IN-01: `prepareStateDir` refuses a directory that holds `lost+found` or any root-owned entry, and stale temp files are never removed

**File:** `relay/src/stateDir.ts:74-92`, `relay/src/stateDir.ts:128-148`
**Issue:** Every entry must belong to the relay's uid. A state directory that is the mount point of a dedicated ext4 volume holds a root-owned `lost+found`, so startup fails with an error the operator cannot act on without deleting it. Separately, `writePrivateFileAtomic` leaves `.{name}.{hex}.tmp` behind when the process is killed between `open` and `rename`. For the pseudonym key this is a second copy of key material. `prepareStateDir` accepts it (own uid, 0600) and never cleans it up.
**Fix:** Skip `lost+found` explicitly, or document that the state directory must be a subdirectory of the mount. In `prepareStateDir`, remove entries matching `/^\..+\.[0-9a-f]{8}\.tmp$/` that the relay owns.

### IN-02: `jose` is a production dependency that nothing uses

**File:** `relay/package.json:19-21`, `relay/test/workspace.test.ts:103-131`
**Issue:** No file under `relay/src` imports `jose`. The workspace test pins it as the only runtime dependency, so removing it fails a test. It widens the `npm audit --omit=dev` gate and the supply chain surface for no use in this phase.
**Fix:** Add it in Phase 69 with the code that uses it, and update the workspace test then. If it is kept deliberately, add a comment in the plan or README saying why.

### IN-03: Workflow documentation still says six CI jobs

**File:** `docs/development-workflow.md:8`
**Issue:** The overview diagram says "CI (6 jobs)" while lines 77, 197, 348 and 555 were updated to seven.
**Fix:** Change to `CI (7 jobs)`.

### IN-04: Message payloads are kept in plaintext indefinitely

**File:** `relay/src/store/schema.ts:34-47`, `relay/src/store/sqliteStore.ts:210-212`
**Issue:** `ackMessage` sets `state = 'done'` and `done_at` but leaves `payload` (up to 1 MiB of message text) in the database. There is no retention or purge, and the data is only protected by the 0600 file and the volume. D-06 and D-11 do not mention retention. This is a privacy and data-minimisation gap, not a bug today.
**Fix:** Decide a retention rule before Phase 71: blank `payload` on ack (the dedupe key is enough for redelivery detection), or add a purge of `done` rows older than N days. Record the decision in the context file.

### IN-05: A failed dynamic import of the app prints a raw stack trace outside the redacting logger

**File:** `relay/src/bin.ts:11-18`, `relay/src/log/logger.ts:3-5`
**Issue:** The `await import(entry)` is outside the `try`. If `app.mjs` is missing or fails to load (a damaged image, a syntax error), Node prints the uncaught error and stack to stderr. This contradicts the stated rule that the guard writes only one fixed version sentence. The text has no secrets at that point, but it does include file paths, and it bypasses D-11.
**Fix:** Move the import inside the `try` (or a second `try`) and exit 1 with one fixed sentence such as `near-ai-relay could not load its code; reinstall it.`

### IN-06: Container suite timing and port selection can produce confusing failures

**File:** `relay/test/container/container.test.ts:90-96,164`, `.github/workflows/ci.yml:153`
**Issue:** The `describe` timeout is 1,500,000 ms, which is exactly the job's `timeout-minutes: 25`, so a hang is reported as a cancelled job and not as a test failure. `freePort()` closes the probe before Compose publishes the port, a small race with other jobs on a shared runner or developer machine. On a developer machine the suite also writes `relay/secrets/teams_app_secret` into the working tree.
**Fix:** Lower the describe timeout to about 20 minutes. Retry `compose up` once when the port is already in use.

### IN-07: Small contract and consistency gaps

**File:** `relay/src/stateDir.ts:150-160`, `relay/src/store/sqliteStore.ts:68-78`, `relay/src/secrets.ts:87-97`
**Issue:** (a) `readPrivateFile` compares the file owner with `process.getuid()` instead of the uid option that `prepareStateDir` accepts, so the two checks can disagree under test or in a future caller. (b) `checkApproval` limits ids to 256 characters but lets `title` be any length. (c) `refusePlainSecretEnv` skips every name ending in `_FILE`, so a tenant named `FILE` (`NEAR_AI_KEY_FILE`) given as a plain value is not refused. A real tenant `X` file pointer `NEAR_AI_KEY_X_FILE` cannot be told from a tenant named `X_FILE`.
**Fix:** (a) Take the uid as an argument with the same default. (b) Cap `title` (for example 1,000 characters). (c) Reserve the suffix `_FILE` in `TENANT_KEY_NAME`: `/^NEAR_AI_KEY_(?!.*_FILE$)[A-Z0-9_]{1,64}$/` for plain values, and document that tenant names cannot end in `_FILE`.

---

_Reviewed: 2026-11-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_

---
phase: 68-relay-foundation
fixed_at: 2026-11-15T00:00:00Z
review_path: .planning/phases/68-relay-foundation/68-REVIEW.md
security_path: .planning/phases/68-relay-foundation/68-SECURITY.md
iteration: 1
findings_in_scope: 21
fixed: 20
skipped: 1
status: partial
---

# Phase 68: Code Review Fix Report

**Fixed at:** 2026-11-15
**Source review:** `.planning/phases/68-relay-foundation/68-REVIEW.md` (WR-01..WR-07, IN-01..IN-07) and the advisories A1..A7 in `68-SECURITY.md`
**Iteration:** 1
**Where it ran:** directly in the `feat/messaging-relay` worktree (`.claude/worktrees/messaging-relay`), no separate fixer worktree, as the orchestrator asked. All verification below ran in that tree.

**Summary:**
- Findings in scope: 21 (7 warnings, 7 info, 7 advisories; A1 and A4 share commits with WR-02 and WR-07, IN-07c with A2, A6 is closed by WR-05)
- Fixed: 20, plus the SECURITY.md note
- Left open: 1 (IN-04, an owner decision, recorded in the context file)

Logic changes to the store (WR-03, WR-04, WR-05, WR-06) change behaviour that later phases build on. They are marked "fixed: requires human verification" so the owner confirms the rules, not just the code.

## Fixed Issues

### WR-01: The required `relay` CI check cannot pass on a hotfix branch cut from an older tag

**Files modified:** `.github/workflows/ci.yml`, `src/test/relayIsolation.test.ts`, `docs/development-workflow.md`
**Commit:** bad70c6
**Applied fix:** The relay job's second step (after checkout, from the repository root) sets `present` from `relay/package.json`; every later step has `if: steps.has_relay.outputs.present == 'true'`, and a missing relay writes a `::notice` "relay checks skipped". The job therefore ends green and the required check reports success without a gate change. The root test pins the step order and the guards and runs the detection script on trees with and without `relay/package.json`. The hotfix section says not to copy `relay/` or `.dockerignore`.

### WR-02 / A1: Redactor's sensitive-key rule was an exact match

**Files modified:** `relay/src/log/redact.ts`, `relay/test/logging.test.ts`
**Commit:** 208e1b8
**Applied fix:** Credential words (`token`, `secret`, `password`, `passwd`, `passphrase`, `authorization`, `cookie`, `apikey`, `credential`, `privatekey`, `bearer`, `signature`, `jwt`) match anywhere in the normalised key (`isSensitiveKey`). Message words keep whole-key matching so `messageId` and `contentType` still log. Tests list 25 credential keys by hand (not from the redactor's lists) and 9 lookalike keys that must still log.
**Bare-digit phone numbers:** not labelled, on purpose, documented in the redactor header. A 10 to 15 digit run cannot be told apart from millisecond timestamps, Teams or Signal ids, byte counts and durations, and the existing test pins that such ids are kept. Message text (where a person types a number) is never logged, and phone numbers go in a phone-named field, which is always labelled.

### WR-03: Start-up recovery left runs `running`; `interrupted` was never set

**Files modified:** `relay/src/store/sqliteStore.ts`, `relay/src/store/relayStore.ts`, `relay/test/contract/relayStore.contract.ts`, `relay/test/killDrill.test.ts`, `relay/test/fixtures/crashWriter.ts`
**Commit:** 04d9781
**Status:** fixed: requires human verification (recovery rule)
**Applied fix:** Opening the store recovers in one commit: claimed messages back to `queued` (attempts kept), `running` and `waiting-approval` runs to `interrupted` (`updated_at` from the store clock option), pending approvals of those runs to `expired`. `claimNext` moves an `interrupted` run back to `queued` when it hands out that run's message again, so a worker's `queued -> running` works on redelivery. The rule is stated on the `RelayStore` interface. New backend-neutral contract cases cover the reopen, the redelivery and untouched terminal runs; two existing reopen cases now expect `interrupted` (which still proves `running` was committed). A new kill -9 case kills the writer with one run running and one waiting for an approval.

### WR-04: `answerApproval` did not enforce the requester or the run state

**Files modified:** `relay/src/store/sqliteStore.ts`, `relay/src/store/relayStore.ts`, `relay/test/contract/relayStore.contract.ts`
**Commit:** cfaf3d2
**Status:** fixed: requires human verification (API change)
**Applied fix:** `answerApproval(tenantId, approvalId, requesterId, decision, now)` returns an `ApprovalAnswerOutcome`: `answered`, `unknown-approval` (also for another tenant's approval, so existence is not revealed), `wrong-requester`, `already-answered`, `expired` or `run-not-waiting`. The UPDATE repeats every condition (requester, pending, not expired, run `waiting-approval`) as a compare and set. Beyond the review: `addApproval` refuses a requester that is not the run's own (`invalid-record`), so the requester the answer is checked against has a sound source. Contract cases cover a wrong requester, a cancelled, a not-yet-waiting and a finished run, and an unknown id.

### WR-05 / A6: `acceptInbound` did not check the conversation binding or the tenant status

**Files modified:** `relay/src/store/sqliteStore.ts`, `relay/src/store/relayStore.ts`, `relay/test/contract/relayStore.contract.ts`
**Commit:** abe6e2a
**Status:** fixed: requires human verification (binding rule)
**Applied fix:** Inside their transaction, `acceptInbound` and `claimNext` refuse an unregistered tenant (`unknown-tenant`), a suspended tenant (new code `tenant-suspended`; its queued messages wait untouched) and a conversation bound to another tenant (`binding-conflict`). Decision taken on the owner's behalf: an unbound conversation is bound to the message's tenant in the same commit as the message, so every queued message's conversation belongs to its tenant and a later `bindConversation` by another tenant is a conflict. If the owner prefers "the caller must bind first", change `acceptInbound` to throw on a missing binding. Contract cases that used one conversation id for two tenants now use their own.

### WR-06: `claimNext` could hand out a second message of a conversation while the first was claimed

**Files modified:** `relay/src/store/sqliteStore.ts`, `relay/src/store/relayStore.ts`, `relay/test/contract/relayStore.contract.ts`
**Commit:** 6d969ed
**Status:** fixed: requires human verification (ordering rule)
**Applied fix:** The oldest-queued query skips a conversation that has a claimed message; other conversations are not held up. The order case acknowledges each message before the next claim; a new case covers two queued messages with the first claimed.

### WR-07 / A4: The Signal sidecar had none of the relay's hardening

**Files modified:** `relay/compose.yaml`, `relay/test/container/container.test.ts`, `relay/README.md`
**Commit:** 62a9884
**Applied fix:** `user: "1000:1000"`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `pids_limit: 256`, `mem_limit: 1g`, and a `/tmp` tmpfs (128m, uid/gid 1000, mode 0700, `exec`). No capability is added back. Verified statically, never started: the pinned image (`0.101@sha256:2cf09d66...`, pulled, inspected with `docker image inspect`, `docker create` plus `docker cp`/`docker export`, then removed by exact digest) declares `USER signal-api` (uid 1000), `S6_READ_ONLY_ROOT=1` and `S6_RUNTIME_PATH=/tmp/s6-runtime`; its s6 services run `signal-cli-rest-api` and `jsonrpc2-helper`. `/tmp` keeps `exec` because s6 runs its service scripts from `S6_RUNTIME_PATH` and the JVM signal-cli loads its native library from `java.io.tmpdir`. `docker compose --profile signal config` resolves all settings, and the container suite asserts them without starting the sidecar. The README says what was checked and that Phase 75 must confirm a real start.

### A3: The 5 s header timeout took 30 s to apply

**Files modified:** `relay/src/http/server.ts`, `relay/test/health.test.ts`
**Commit:** 52366e5
**Applied fix:** `http.createServer({ connectionsCheckingInterval: 1000 }, ...)`. A new test stalls a raw socket inside a header and asserts the close between 4.5 s and 8 s (5006 ms here). A probe with the default interval closed after 30030 ms, so the test fails on the old server.

### A2 (and IN-07c): Plain `NEAR_AI_KEY_*` values were refused only in capitals

**Files modified:** `relay/src/secrets.ts`, `relay/test/secrets.test.ts`, `relay/README.md`
**Commit:** b947bb9
**Applied fix:** Names are compared upper-cased; any name starting with `NEAR_AI_KEY_` set to a plain value is refused (lower case, mixed case, past 64 characters, odd characters), and the catalogue names in any case. A `_FILE` name is a path only when its stem is a secret name, so `NEAR_AI_KEY_FILE` is refused as a plain key. `TENANT_KEY_NAME` reserves the suffix: a tenant name cannot be `FILE` or end in `_FILE`. The pinning test was changed on purpose and the commit says why.

### A5: No read-back of `PRAGMA synchronous = FULL`

**Files modified:** `relay/src/store/sqliteStore.ts`, `relay/test/schema.test.ts`
**Commit:** df9cb0f
**Applied fix:** `SqliteStore.durability()` reads `journal_mode`, `synchronous` and `foreign_keys` on the store's own connection; the test asserts `wal`, `2` and `1` on open and reopen. Finding while testing: the SQLite in Node 26.13.1 already defaults to FULL, so the test also checks that the store sets it explicitly.

### A7: The real old-Node tests skipped in CI

**Files modified:** `.github/workflows/ci.yml`, `src/test/relayIsolation.test.ts`, `relay/test/workspace.test.ts`, `docs/development-workflow.md`, `relay/README.md`
**Commit:** 0711dcd
**Applied fix:** The relay job runs the same pinned `setup-node` for Node `'24'`, writes `NEAR_AI_RELAY_OLD_NODE=$(command -v node)` to `GITHUB_ENV`, then installs 26.13.1 (first on PATH for npm). A root test pins the order; a relay test fails in GitHub Actions when the variable is missing, so the cases cannot skip silently there.

### IN-01: `lost+found` refused and stale temp files kept

**Files modified:** `relay/src/stateDir.ts`, `relay/test/stateDir.test.ts`, `relay/README.md`
**Commit:** 1b9c768
**Applied fix:** Exactly `lost+found`, as a real folder, is skipped before the owner and mode checks (a file or link of that name is still checked). `.{name}.{8 hex}.tmp` files owned by the relay are removed at start with one `state_dir.stale_temp_removed` line. The root-owned case cannot be created without root, so the test uses an open folder of ours and shows it is neither tightened nor logged.

### IN-02: `jose` unused

**Files modified:** `relay/README.md`, `.planning/phases/68-relay-foundation/68-CONTEXT.md`
**Commit:** 31eeb33
**Applied fix:** Dependency kept; README and D-01 say it is reserved for the Phase 69 Teams JWT validation.

### IN-03: "CI (6 jobs)"

**Files modified:** `docs/development-workflow.md`
**Commit:** 406c73a
**Applied fix:** Now "CI (7 jobs)".

### IN-05: Failed dynamic import printed a raw stack

**Files modified:** `relay/src/bin.ts`, `relay/test/startup.test.ts`
**Commit:** 550c080
**Applied fix:** The import has its own `try`; on failure the guard writes `near-ai-relay could not load its code; reinstall it.` and exits 1. Test runs a copied `bin.mjs` with no `app.mjs` and with a broken one.

### IN-06: Container suite timeout and port race

**Files modified:** `relay/test/container/container.test.ts`
**Commit:** a20af01
**Applied fix:** Describe timeout 20 minutes (below the 25-minute job). `composeUp()` retries once on a fresh port when Docker reports the port taken. The planted `relay/secrets` file is kept: it is how the suite proves `.dockerignore` keeps secrets out, and the suite removes exactly what it made.

### IN-07a: `readPrivateFile` used `process.getuid()` instead of the uid option

**Files modified:** `relay/src/stateDir.ts`, `relay/test/stateDir.test.ts`
**Commit:** d3668d0
**Applied fix:** Takes the same `PrepareOptions` and resolves the uid the same way.

### IN-07b: Approval `title` unbounded

**Files modified:** `relay/src/store/sqliteStore.ts`, `relay/test/contract/relayStore.contract.ts`
**Commit:** ebd4aa8
**Applied fix:** At most 1,000 characters, `invalid-record` beyond.

### IN-07c: `NEAR_AI_KEY_FILE` ambiguity

Fixed with A2 in b947bb9 (see above).

### SECURITY.md

**Files modified:** `SECURITY.md`
**Commit:** d2090f3
**Applied fix:** New "Messaging relay (foundation)" section (separate service, no Teams or Signal messages yet, only `GET /healthz` with five fields that identify no one, `127.0.0.1` by default and in the container publish, secrets from files, redacted logs, `jose` as the relay's own dependency, the seventh required CI job `relay`, `verify:release` refusing `relay/`). The `verify:release` paragraph names `relay/` and `.dockerignore`. Last reviewed: 2026-11-15. SECURITY.md is a gate path; the PR already needed the owner's `agent-review-gates` approval for its CI and script changes, so this adds no extra approval.

## Skipped Issues

### IN-04: Message payloads are kept in plaintext indefinitely

**File:** `relay/src/store/schema.ts:34-47`, `relay/src/store/sqliteStore.ts`
**Reason:** A retention rule is an owner decision (blank the payload on ack, or purge `done` rows after N days), not a small clear fix. Recorded as a deferred item due before Phase 71 in `68-CONTEXT.md` (commit b775f49). No real tenant data is stored before Phase 69.
**Original issue:** `ackMessage` sets `done` but leaves up to 1 MiB of message text in the database with no retention or purge.

## Verification

All runs inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 ...` in this worktree.

- Relay, Node 26.13.1 by PATH prefix: `npm run lint` (exit 0); `NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node npm test`: 169 tests, 169 pass, 0 fail, 0 skipped.
- Container suite (`MemoryMax=6G`, `timeout 1800`): `npm run test:container --prefix relay`: 10 tests, 10 pass, 0 fail. Afterwards no `near-ai-relay-test` container, volume or image and no `relay/secrets`.
- Root, Node 24.22.2: `npm run lint` (exit 0); `tsc -p tsconfig.json` then `node --test dist/test/relayIsolation.test.js scripts/test/workflow-files.test.mjs scripts/test/workflow.test.mjs`: 60 tests, 60 pass (relayIsolation 10 of them); `npm run verify:release`: exit 0, 330 entries verified; `node scripts/secret-scan.mjs`: clean, 949 tracked files, 8 allowlisted fixtures.
- Not run: the full root `npm test` (another agent was running heavy tests on the machine).

---

_Fixed: 2026-11-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_

---
phase: 31-staff-roster-cell-keys-and-migration
plan: 21
subsystem: staff-replica
tags: [replica, staff-host, shared-project, projection, parity, d-29, tdd]
status: complete

requires:
  - phase: 31-11
    provides: projection.ts (projectLedgerReplay, the header tamper check against a projected state)
  - phase: 31-18
    provides: ReplicaProject (open, state, context, close), SHARED_PROJECT_REFUSAL and REPLICA_PROJECT_FILE in the pure multiUser.ts
  - phase: 31-19
    provides: makeMultiUser, projectionInputOf, the imported-ledger overlay, the files written back at their usual paths
  - phase: 31-20
    provides: cellOrderHook (now passed to ReplicaProjectDeps.cellOrder by the staff host)
provides:
  - "src/staff/staffHost.ts: StaffHostOptions.replica, StaffHost.isSharedProject, StaffHost.close, SHARED_PROJECT_UNAVAILABLE, shared-mode replay through the projection, the shared-project refusal on 18 writing methods, SharedProjectError (re-exported)"
  - "src/staff/logisticsHost.ts: SharedProjectError, the shared-project refusal on writeRecord, submitReport and appendValidation"
  - "src/test/staffReplicaHostMode.test.ts: 8 tests"
  - "src/test/staffReplicaParity.test.ts: 5 tests (D-29 parity)"
affects: [31-22, 31-23, 33]

tech-stack:
  added: []
  patterns:
    - "Shared check per public call: one stat of REPLICA_PROJECT_FILE, never cached for the process, failing closed on any error but ENOENT/ENOTDIR"
    - "Replica modules loaded with import() inside the shared path only; type aliases via import() types, so no static import of src/staff/replica in the staff host"
    - "One ReplicaProject per host; the projection is recomputed only when the fold (order, digests, checkpoint) or its context object changed; a refused open is not kept"
    - "Writes refuse before any file is touched: StaffResult methods return SHARED_PROJECT_REFUSAL, void methods throw SharedProjectError"

key-files:
  created:
    - src/test/staffReplicaHostMode.test.ts
    - src/test/staffReplicaParity.test.ts
  modified:
    - src/staff/staffHost.ts
    - src/staff/logisticsHost.ts

key-decisions:
  - "The shared host keeps ProjectedProductState.imported on replay().products (the D-32 approval wording for the screens that show it); today's readers ignore the extra field, and the tests compare products without it"
  - "SharedProjectError lives in logisticsHost.ts and is re-exported from staffHost.ts, because staffHost already depends on logisticsHost and the reverse would be a circular import"
  - "StaffHostOptions.replica.identityDir is optional (identityDir(globalStorageDir) when absent), as ReplicaProjectDeps has it"
  - "The ReplicaProject's clock is the staff host's clock (options.now), and its cell order is cellOrderHook({ now }) (carry-over from 31-20 closed here)"
  - "A shared project this window cannot open (no replica storage, no head store, not joined, pin mismatch, store refused) reads as broken with SHARED_PROJECT_UNAVAILABLE plus the project's own refusal sentence; snapshot shows that sentence without an entry number"
  - "emit, appendValidation and recordFeed with an empty list stay no-ops in a shared project (nothing would be written); every non-empty call is refused"

requirements-completed: [MUS-06]

actuals:
  tokens: 14187
  tasks: 3
  commits: 3
plan_head_before: 8cb7c6bde8874170de4a9d0bfc10203ebc817f56
plan_head_after: 69b5dff13db499fdc09fafa42cc126a32d065e72

duration: 15min
completed: 2026-11-20
---

# Phase 31 Plan 21: The staff host in a shared project Summary

**A shared project now reads the same through today's staff host and cannot be changed through any single-machine path, and a project that never turns multi-user is untouched. The host checks one file (`.planning/staff/replica/project.json`) per call. In a shared project it opens one `ReplicaProject`, reads products from the fold through the projection, and refuses all 21 single-machine writes with one sentence that points to Make a Single-Machine Copy. In a project that is not shared it loads no replica module and writes nothing new.**

## Performance

- **Duration:** about 15 minutes (2026-11-20T06:15Z to 06:30Z)
- **Tasks:** 3 of 3
- **Files:** 4 (2 created, 2 modified)

## Accomplishments

- **Reads (D-28, D-33).** `replay()` for a shared project returns `projectLedgerReplay(projectionInputOf(project))`. Everything that reads `replay()` works unchanged on the projected state: `productState`, `status`, `list`, `snapshot` (registry, decision queue, registers) and the header tamper check in `fileDisagreement`. The test shows replay products, `productState` for three products in three states, the registry and the decision queue (with the open request's options and dissent) are deep-equal to what today's host read before the conversion. A hand-edited header gives the same tamper reason and the same status text as on a single-machine copy.
- **Writes (D-29, D-37).** 18 staff host methods and 3 logistics methods refuse with `SHARED_PROJECT_REFUSAL` before any file is touched:
  - staff host: setAsideLedger, adoptBranchLedger, decidePir, signWatchDecision, emit, record, recordFeed, propose, verdict, submit, withdraw, enterStep, registerWrite, registerPropose, ccirTrigger, wargameRecord, wargameDerive, decide;
  - logistics host: writeRecord, submitReport, appendValidation.

  The table test hashes every file under `.planning/staff` (the replica store included) and the SecretStorage key set and values after each call. Nothing changes.
- **Reads that stay as files.** `pirDecisions`, `watchDecisions`, `wargameEntries`, `events`, `feedEvents`, calculator `records`, LOGSTAT `reports`, `validationLog` and `pirRegister` answer exactly as before the conversion. They read the files 31-19 wrote back.
- **Lazy loading (Pitfall 8).** No line of `staffHost.ts` imports from `src/staff/replica`. Replica modules load through `import()` only in the shared path, and the parity test proves this through `require.cache`.
- **Parity (D-29).** A full workload ran on a host given the replica storage that 31-23 will configure:
  - steps: propose, guard verdict, submit, approve, release, a PIR decision, a watch decision, a wargame turn, a calculator record, Use This Branch's Ledger, Set Aside, a new product, and a reload with reads.
  - It leaves no replica or legacy folder and nothing in global storage.
  - The only SecretStorage keys are `nearAi.staff.ledgerHead.*` keys.
  - No `staff/replica` module is loaded.
  - Every path under `.planning/staff` matches today's layouts.
  - The product ledger, the set-aside copy, the decision log and the calculator ledger all verify with today's verifiers.
  - `replay`, `snapshot` and `branchLedgerCheck` are equal with and without the replica storage.

## Task Commits

1. **Task 1 (tracer): products read from the fold:** `21e9628a` (feat). Tracer gate: the verify was re-run end to end (3 of 3) before expanding, and a mutation (shared replay off) failed 2 of the 3 tests.
2. **Task 2: every write refused, no file changed:** `b5f760bd` (feat)
3. **Task 3: D-29 parity:** `69b5dff1` (test)

The Task 1 commit holds only the read side. The refusal guards were split out by hand into the Task 2 commit, and the Task 1 tree was compiled and tested on its own (3 of 3) before it was committed.

## Test Results

Every run used the shared flock lock and the memory cap (`MemoryMax=4G`, `--max-old-space-size=1536`, `timeout`). Each compile ran `vendor-libs` and then `tsc -p tsconfig.json`, and exited 0.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1 verify: staffReplicaHostMode (3 at that commit) | 3 | 3 | 0 |
| Task 2 verify: staffReplicaHostMode (8), staffLogistics | 29 | 29 | 0 |
| Task 3 verify: staffReplicaParity (5), staffLedgerIntegrity (9), staffBranchLedger (5), staffRelease (13), staffProducts (9) | 41 | 41 | 0 |
| Focused, every `dist/test/staff*.test.js` (61 files, staffReplica* included) plus intelWorkbench, `--test-concurrency=4` | 759 | 758 | 1 |

The one failure is pre-existing and not caused by this plan (see Deferred Issues).

The 30 `dist/test/replica*.test.js` files were not run, because they test `src/domain/replica` and none of them reaches the staff host. The full `npm test`, e2e and `verify:release` were not run; the orchestrator runs them at the phase end.

**Mutation checks** were made in compiled `dist/` only. Each file was restored and checked with `cmp`.

| Mutation | Tests that failed |
|----------|-------------------|
| The shared replay is never used | tracer, tamper |
| `sharedRefusal` always passes | the 21-write table, the unopened-project test |
| The overdue-RFI guard is removed | the event-log read test |
| A static `require('./replica/projection')` is added to the staff host | parity test 1, parity test 3, the detector test |

**Acceptance greps:**

| Check | Result | Required |
|-------|--------|----------|
| `grep -cE "^import .*replica/" src/staff/staffHost.ts` | 0 | 0 |
| `REPLICA_PROJECT_FILE` in staffHost.ts | 3 | at least 1 |
| `SHARED_PROJECT_REFUSAL` in staffHost.ts | 4 | at least 1 |
| `SHARED_PROJECT_REFUSAL` in logisticsHost.ts | 7 | at least 1 |
| `git diff --quiet c1dba334` over the four existing staff tests | exit 0 | exit 0 |
| Em-dashes in the four files | 0 | 0 |

staffReplicaHostMode has 8 tests (at least 6 required), and one of them runs 21 writing methods (at least 20 required). staffReplicaParity has 5 tests (at least 3 required).

## TDD Gate Compliance

This plan has `tdd="true"` tasks but is not `type: tdd`. For Tasks 1 and 2, the host code and its tests were written in the same session, so the first runs were already green. There is no separate RED commit. RED evidence comes from the mutation table above: each mutation made the named tests fail. Task 3 is test-only.

## Decisions (defaults taken, owner asleep)

The plan had no checkpoint, and its design was taken unchanged. The other decisions are listed in the frontmatter `key-decisions`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2: Missing critical] `branchLedgerCheck` answers the refusal in a shared project**
- **Issue:** after the conversion, `products.jsonl` is in the legacy folder but its head mark stays in SecretStorage. Today's check would therefore report `other-copy` with 0 entries. Use This Branch's Ledger would then show its dialog and ask the person to name themselves, only to be refused.
- **Fix:** `branchLedgerCheck` returns `{ kind: 'broken', message: SHARED_PROJECT_REFUSAL }` in a shared project, so the command shows the sentence at once. This is tested.
- **Commit:** `b5f760bd`

**2. [Rule 1: Bug] Reads that wrote the event log**
- **Issue:** `status`, `list` and `registerRead` call `noticeOverdue`, which appends `staff.rfi.overdue` to `events.jsonl`. In a shared project, that append would either write a single-machine file or throw the refusal from a read.
- **Fix:** `noticeOverdue` returns before emitting in a shared project. A single-machine project still records the overdue RFI, and the test shows both cases.
- **Commit:** `b5f760bd`

**3. [Rule 2] `StaffHost.close()` and `configureStaffHosts` closing old hosts**
- **Why:** a host that opened a shared project holds a `ReplicaProject`, which may own a decode worker. `close()` ends it. `configureStaffHosts` now calls `close()` on the hosts it drops. For a project that is not shared, `close()` does nothing.
- **Commit:** `21e9628a`

**4. [Rule 2] A projection cache per fold and context**
- **Why:** `projectionInputOf` verifies every stored entry again on each call. The host now keeps the last projection and reuses it while the fold's order, digests and checkpoint, and the context object, are unchanged. Callers get a copy of the product map.
- **Commit:** `21e9628a`

### Notes

- **Carry-over from 31-20 closed:** `cellOrderHook` is passed to `ReplicaProjectDeps.cellOrder` when the staff host opens a shared project. 31-23 does not need to wire it.
- **Callers of thrown refusals:**
  - Every command in `staffCommands.ts` runs inside `register`, which shows a thrown error's message.
  - Tool runs (`agent/loop.ts`) return `Error: <message>`.
  - `agentSession` ignores a failed `record`.
  - The observation store catches its `emit`.
  - `copMap` calls `record` only after `propose`, which already refuses.
- **For 31-23:**
  - Pass `replica: { globalStorageDir: context.globalStorageUri.fsPath }` (and optionally the identity folder) in `configureStaffHosts`.
  - Set Aside the Product Ledger still shows its modal before the host refuses. The command could check `isSharedProject()` first and show the sentence without a dialog.
  - The watch host writes its standing-watches file before `recordFeed`. In a shared project, a watch step that does not sign a decision first would write that file, and then the event would be refused. The watch host is outside this plan's files.
- **Stray file:** while running a mutation check, a `flock` call made an empty file named `systemd-run` in the worktree root (its lock-path variable was unset). That file was created in this session and removed straight away; it was never committed.

## Deferred Issues

- **`staffDoctrine.test.js`, test "the staff sources carry no em-dash and no provisional or preview marker":** fails on the integration branch before this plan. `src/domain/staff/multiUser.ts` (from 31-18) contains "preview" in `MULTI_USER_PREVIEW_SETTING` and its comments, and the test refuses that word in every file under `src/domain/staff`.
  - This plan did not change either file (`git diff 8cb7c6bd` over both is empty).
  - The fix belongs to whoever owns `multiUser.ts` or the doctrine test. One option is a narrow exemption for the D-36 setting name.
  - It is not written to `deferred-items.md`, so that it does not conflict with 31-22 in the same wave.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register:
- **T-31-71:** every write is refused before a file is touched. The table test checks file and secret hashes.
- **T-31-72:** the header check runs against the projected state. The tamper test shows the same reason as today's host.
- **T-31-73:** a project that is not shared costs one stat per call and loads nothing. The parity test checks the tree, the secrets, global storage and the module cache.
- **T-31-SC:** no package was installed.

There is no new network endpoint, file location or secret.

## Self-Check: PASSED

- FOUND: src/staff/staffHost.ts, src/staff/logisticsHost.ts, src/test/staffReplicaHostMode.test.ts, src/test/staffReplicaParity.test.ts
- FOUND: commits 21e9628a, b5f760bd and 69b5dff1 are ancestors of HEAD

---
phase: 68-relay-foundation
plan: 04
subsystem: infra
tags: [relay, node-sqlite, state-directory, kill-drill, wal, node-test]

requires:
  - phase: 68-01
    provides: "relay/ workspace, build script with test and fixture entries, main composition root"
  - phase: 68-02
    provides: "redacting Logger and HealthRegistry.setInFlightRuns"
provides:
  - "relay/src/stateDir.ts: StateDirError, prepareStateDir, writePrivateFileAtomic, readPrivateFile"
  - "relay/src/store/relayStore.ts: tenant-scoped RelayStore interface, record types, RUN_STATES, IN_FLIGHT_RUN_STATES, StoreError"
  - "relay/src/store/schema.ts: schema v1 (six STRICT tables), migrate, SCHEMA_VERSION"
  - "relay/src/store/sqliteStore.ts: openSqliteStore, SqliteStore (WAL, synchronous FULL, BEGIN IMMEDIATE, 0600 files)"
  - "relay/src/types/node-sqlite-database.d.ts: ambient Database class"
  - "main wiring: state directory, store, /healthz inFlightRuns from the store, instanceId on relay.listening"
affects: [68-05, 68-06, 68-07, 68-08, 71]

actuals:
  tokens: 14260
  tasks: 2
  commits: 2
plan_head_before: 1e2850a40e4308a5331f301189d077dbe9209274
plan_head_after: a329d73d72998b642a4efe6aea179a255ed14b15

tech-stack:
  added: []
  patterns:
    - "Ack after COMMIT: a write method resolves only after COMMIT returned; the kill drill prints ack N from the child only after that"
    - "Pre-create the database file 0600 so -wal and -shm inherit 0600 whatever the umask"
    - "Store statements prepared once; only bound parameters, countRuns sums GROUP BY rows in code instead of building an IN list"
    - "Permit-based child fixture: the writer starts each message only after a stdin line, so a SIGKILL lands within one message of the last ack"

key-files:
  created:
    - relay/src/stateDir.ts
    - relay/src/types/node-sqlite-database.d.ts
    - relay/src/store/relayStore.ts
    - relay/src/store/schema.ts
    - relay/src/store/sqliteStore.ts
    - relay/test/fixtures/crashWriter.ts
    - relay/test/killDrill.test.ts
    - relay/test/stateDir.test.ts
  modified:
    - relay/src/main.ts

key-decisions:
  - "Schema v1 holds all five aggregates now (tenants, conversation_bindings, messages, runs, approvals) plus relay_meta, so plan 05 adds operations, not a migration."
  - "The crash writer is permit-driven (one stdin line per message) instead of a free-running loop, so the 'at most one unacknowledged pair is extra' assertion is deterministic."
  - "Claimed messages go back to queued on every open (redelivery after a restart); attempts are kept."
  - "A subdirectory inside the state directory that is open is tightened to 0700 and logged as state_dir.file_tightened (same event as files)."

patterns-established:
  - "Plan 05 adds binding and approval members to RelayStore and the shared relayStoreContract suite against the tables that already exist."

requirements-completed: []

coverage:
  - id: D1
    description: "Over 15 kill -9 rounds every acknowledged message and its run record survive, at most one unacknowledged pair is extra, no dedupe key is duplicated, runs equal messages, integrity_check is ok"
    requirement: RELAY-03
    verification:
      - kind: integration
        ref: "relay/test/killDrill.test.ts (15 rounds, kill points 5, 12, ..., 103)"
        status: pass
    human_judgment: false
  - id: D2
    description: "relay.db, relay.db-wal and relay.db-shm are 0600 under umask 022; the state directory is created 0700"
    requirement: RELAY-03
    verification:
      - kind: unit
        ref: "relay/test/stateDir.test.ts#under umask 022 the database, its -wal and its -shm file are all 0600 while the store is open"
        status: pass
      - kind: unit
        ref: "relay/test/stateDir.test.ts#a missing nested directory is created 0700 whatever the umask"
        status: pass
    human_judgment: false
  - id: D3
    description: "The relay refuses a foreign-owned directory, a symlink, a non-directory and a directory holding a symlink; it tightens its own open directory and files with one log line each"
    requirement: RELAY-03
    verification:
      - kind: unit
        ref: "relay/test/stateDir.test.ts (tighten, other-owner, /usr, symlink and non-directory cases)"
        status: pass
      - kind: integration
        ref: "relay/test/stateDir.test.ts#the relay pointed at /usr exits 1 with relay.start_refused reason state-dir"
        status: pass
    human_judgment: false
  - id: D4
    description: "/healthz inFlightRuns comes from the store (running plus waiting-approval) and is 0 on a fresh relay; relay.listening carries instanceId"
    requirement: RELAY-02
    verification:
      - kind: integration
        ref: "relay/test/startup.test.ts (tracer, inFlightRuns 0) and relay/test/stateDir.test.ts (instanceId on relay.listening)"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-11-14
status: complete
---

# Phase 68 Plan 04: State directory and durable store Summary

**The relay now keeps everything in one private state directory behind a tenant-scoped `RelayStore`, implemented on `node:sqlite` (WAL, synchronous FULL, BEGIN IMMEDIATE, 0600 files), and a 15-round kill -9 drill shows no acknowledged message or run record is lost or duplicated.**

## Accomplishments

- `prepareStateDir` creates a missing directory 0700 by explicit chmod, refuses a symlink, a non-directory, another owner and a symlinked or foreign-owned entry with a sentence that names RELAY_STATE_DIR and the path, and tightens its own too-open directory (0700) and files (0600) with one log line each (D-07, D-17, Open Question 1). `writePrivateFileAtomic` writes a 0600 temp file, fsyncs, renames and fsyncs the directory; `readPrivateFile` uses O_NOFOLLOW plus fstat.
- `RelayStore` is tenant-scoped throughout (message, run, approval operations take `tenantId`; only tenants and bindings are global), so the deferred JSON-file-per-tenant store (D-05) can implement the same contract. `acceptInbound` writes the message and its run in one transaction, or recognises a duplicate dedupe key and writes nothing.
- Schema v1 has six STRICT tables (relay_meta, tenants, conversation_bindings, messages, runs, approvals), `migrate` reads `user_version`, refuses a newer schema with a plain sentence, applies each pending migration in its own BEGIN IMMEDIATE together with the version bump, and records a random `instance_id` once.
- `main` runs prepareStateDir then openSqliteStore before the server (refusals log `relay.start_refused` with reason `state-dir` or `store`), points `/healthz inFlightRuns` at `store.countRuns(IN_FLIGHT_RUN_STATES)`, adds `instanceId` to `relay.listening`, and closes the store after the server on shutdown.
- The ambient `Database` class lives in one `.d.ts`; `DatabaseSync` appears nowhere else under `relay/src`.

## Task Commits

1. **Task 1: tracer, private state directory to node:sqlite store to an acknowledged message that survives kill -9** - `a79fe4c` (feat)
2. **Task 2: state directory refusals, tightening and 0600 files under a loose umask** - `a329d73` (test)

**Plan metadata:** committed separately after this summary (docs).

## Verification

All runs inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" ...`.

- Task 1 verify: `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/killDrill.test.js dist/test/startup.test.js'`: exit 0, 23 tests, 23 pass (15 drill rounds plus 8 startup tests).
- Task 2 verify: `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/stateDir.test.js dist/test/killDrill.test.js dist/test/startup.test.js'`: exit 0, 35 tests, 35 pass, 0 fail, 0 skipped.
- Full relay suite: `NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node npm test --prefix relay`: 78 tests, 78 pass, 0 fail, 0 skipped.
- Mutation check: with the 0600 pre-create line commented out of `openSqliteStore`, the umask test fails with "relay.db is not 0600"; the line was restored (`git checkout` of that one file) before the commit.
- Acceptance greps: `DatabaseSync` outside the `.d.ts` prints nothing; `synchronous = FULL` 2 matches; `BEGIN IMMEDIATE` 3 matches in `sqliteStore.ts`; `node:sqlite` outside `relay/src/store` and `relay/src/types` prints nothing; `STRICT` 7 matches (six tables plus one comment); `O_NOFOLLOW` 1 and `fsync` 3 matches in `stateDir.ts`.
- The kill drill kills only the child pid it spawned (`child.kill('SIGKILL')` on its own handle); nothing is killed by name.

## Files Created/Modified

- `relay/src/stateDir.ts`, `relay/src/types/node-sqlite-database.d.ts` - new
- `relay/src/store/relayStore.ts`, `schema.ts`, `sqliteStore.ts` - new
- `relay/src/main.ts` - state directory, store, health source, instanceId, shutdown order
- `relay/test/fixtures/crashWriter.ts`, `relay/test/killDrill.test.ts`, `relay/test/stateDir.test.ts` - new

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The free-running crash writer would make the "at most one extra" assertion racy**
- **Found during:** Task 1, while writing the fixture
- **Issue:** The plan's fixture loops acceptInbound and prints `ack N` as fast as it can. A fast child can commit many messages while the parent is still reading the first acks, so after the kill the database holds far more than acked + 1 rows and the assertion fails by timing, not by a defect.
- **Fix:** The child takes one permit (a line on stdin) before each message and starts with one permit; the parent answers every `ack N` with a permit and sends SIGKILL right after the permit that follows the kill point. The child can then be anywhere inside message N + 1 (before the transaction, inside it, after COMMIT but before printing) and never further. `ack N` is still printed only after acceptInbound resolved.
- **Files modified:** `relay/test/fixtures/crashWriter.ts`, `relay/test/killDrill.test.ts`
- **Commit:** `a79fe4c`

**2. [Rule 1 - Bug] deepEqual on SQLite rows**
- **Found during:** Task 1, first drill run
- **Issue:** `node:sqlite` rows have a null prototype, so `assert.deepEqual(rows, [{ integrity_check: 'ok' }])` fails on prototypes although the check returned ok.
- **Fix:** Compare the `integrity_check` values.
- **Files modified:** `relay/test/killDrill.test.ts`
- **Commit:** `a79fe4c`

### Notes (not deviations)

- Task 2 is marked `tdd="true"`, but the state directory module and the wiring were already written in Task 1 as the plan sequences them, so the Task 2 tests passed on first run (no RED commit). The mutation check above shows the 0600 test fails when the protection is removed.
- `/usr` tests are skipped only when run as root; this host ran as a normal user, 0 skipped. The other-owner refusal is additionally covered through the `uid` option so it also holds as root.
- `RELAY_STATE_DIR` default and the Dockerfile directory ownership stay with plan 07, as planned.
- D-21 / T-68-12 unchanged: no single-instance lock; two relays on one directory is the accepted, documented risk until Phase 71.

## Issues Encountered

None beyond the two fixes above.

## Known Stubs

None.

## Threat Flags

None. T-68-09, T-68-10 and T-68-11 are mitigated and tested; T-68-SC held (no package added, `node:sqlite` is built in).

## Next Phase Readiness

Plan 05 can add the binding and approval members to `RelayStore`, the `relayStoreContract(name, factory)` suite, and schema tests against tables and migrations that already exist; `SqliteStore` is the first implementation to run through it. RELAY-03 is not ticked here: the contract suite and the schema tests of plan 05 complete its validation rows.

## Self-Check: PASSED

- Created files found: `relay/src/stateDir.ts`, `relay/src/types/node-sqlite-database.d.ts`, `relay/src/store/relayStore.ts`, `relay/src/store/schema.ts`, `relay/src/store/sqliteStore.ts`, `relay/test/fixtures/crashWriter.ts`, `relay/test/killDrill.test.ts`, `relay/test/stateDir.test.ts`.
- Commits found: `a79fe4c`, `a329d73` are ancestors of HEAD.

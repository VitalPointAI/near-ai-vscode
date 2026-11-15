---
phase: 68-relay-foundation
plan: 05
subsystem: infra
tags: [relay, node-sqlite, storage-contract, tenant-isolation, schema-versioning, node-test]

requires:
  - phase: 68-04
    provides: "RelayStore interface, schema v1 with all six tables, SqliteStore, kill drill"
provides:
  - "relay/src/store/relayStore.ts: ConversationBinding, ApprovalDecision, APPROVAL_DECISIONS, ApprovalState, ApprovalRecord, NewApproval and the seven binding and approval members of RelayStore"
  - "relay/src/store/sqliteStore.ts: bindConversation, getBinding, addApproval, getApproval, answerApproval, expireApprovals, listPendingApprovals"
  - "relay/src/store/schema.ts: migrate(db, now, migrations = MIGRATIONS)"
  - "relay/test/contract/relayStore.contract.ts: relayStoreContract(name, factory), StoreHandle, StoreFactory (implementation-agnostic, 34 cases)"
  - "relay/test/sqliteStore.test.ts and relay/test/schema.test.ts"
affects: [68-06, 68-07, 68-08, 70, 71, 73]

actuals:
  tokens: 12400
  tasks: 3
  commits: 4
plan_head_before: 6c98631d26bb1ad1b0d6268db0c34312ebab2ef0
plan_head_after: 04da31c23f61f327a039916088775b222058961d

tech-stack:
  added: []
  patterns:
    - "Contract suite as a function: relayStoreContract(name, factory) registers node:test cases; a second store passes the same file with its own factory (D-05)"
    - "Compare-and-set for every state change (run transition, approval answer, ack), tenant id in every WHERE clause"
    - "Injectable migration list so a failing migration can be tested without touching the real list"

key-files:
  created:
    - relay/test/contract/relayStore.contract.ts
    - relay/test/sqliteStore.test.ts
    - relay/test/schema.test.ts
  modified:
    - relay/src/store/relayStore.ts
    - relay/src/store/sqliteStore.ts
    - relay/src/store/schema.ts

key-decisions:
  - "Approvals mirror the extension's ApprovalRequest (callId, tool, title) and ApprovalReply decisions minus 'pending', so Phase 73 maps them one to one."
  - "A conversation binding is never moved: another tenant gets StoreError binding-conflict and the first binding is untouched."
  - "answerApproval succeeds only strictly before expiresAt; an answer at expiresAt is refused (the approval stays pending until expireApprovals marks it expired)."
  - "migrate checks 'newer schema' against the length of the list it was given, so the real list behaves as before and an injected list is self-consistent."

patterns-established:
  - "New aggregates go through RelayStore plus a case in relayStoreContract, never a second access path."

requirements-completed: []

coverage:
  - id: D1
    description: "Tenant registry, conversation bindings, message queues, run records and pending approvals each round-trip across close and reopen through RelayStore"
    requirement: RELAY-03
    verification:
      - kind: unit
        ref: "relay/test/sqliteStore.test.ts (relayStoreContract('sqlite', ...), 34 cases, with a reopen case for every aggregate)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A message, run or approval cannot be read, acknowledged, transitioned or answered with another tenant's id; the same dedupe key under two tenants is two messages; a bound conversation cannot be rebound to another tenant"
    requirement: RELAY-03
    verification:
      - kind: unit
        ref: "relayStore.contract.ts: dedupe key under another tenant, ackMessage refuses another tenant, transitionRun compare and set, another tenant cannot read or answer an approval, binding-conflict, addApproval unknown-run"
        status: pass
    human_judgment: false
  - id: D3
    description: "acceptInbound is atomic and idempotent, claims are FIFO per conversation, a claimed unacknowledged message is delivered again after reopen with attempts 2, payload limit is exactly 1 MiB of UTF-8"
    requirement: RELAY-03
    verification:
      - kind: unit
        ref: "relayStore.contract.ts (duplicate accept, FIFO claims, redelivery after reopen, 1 MiB boundary, run-insert failure leaves no message)"
        status: pass
      - kind: integration
        ref: "relay/test/killDrill.test.ts (15 of 15 rounds still pass)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A database above SCHEMA_VERSION is refused with exit 1 and a plain sentence; migrations apply once and atomically; the instance id is identical across kill -9 and restart"
    requirement: RELAY-03
    verification:
      - kind: unit
        ref: "relay/test/schema.test.ts (7 cases: fresh version and WAL, reopen stability, failed migration rolls back, apply once, newer-schema refusal)"
        status: pass
      - kind: integration
        ref: "relay/test/schema.test.ts (built relay exits 1 with relay.start_refused reason store; instanceId equal across SIGKILL and restart, /healthz 200)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-14
status: complete
---

# Phase 68 Plan 05: Store contract suite and schema versioning Summary

**All five state aggregates of RELAY-03 now sit behind one tested `RelayStore`: conversation bindings and pending approvals were added, one factory-driven `relayStoreContract(name, factory)` suite of 34 cases runs against the `node:sqlite` store, and schema tests prove atomic migrations, newer-database refusal and an instance id that survives kill -9.**

## Accomplishments

- `RelayStore` gained `bindConversation`, `getBinding`, `addApproval`, `getApproval`, `answerApproval`, `expireApprovals` and `listPendingApprovals`, with the approval types shaped like the extension's `ApprovalRequest` and `ApprovalReply`. The SQLite implementation uses only prepared statements with bound parameters (T-68-16), tenant id in every lookup (T-68-14), and compare-and-set updates (T-68-15).
- `relayStoreContract` uses only the `RelayStore` interface and a `StoreHandle` (`store`, `reopen`, `dispose`). It names neither the SQLite driver nor the store module, so the deferred JSON-file-per-tenant store is proven by passing the same file with a different factory (D-05).
- The contract covers tenants, bindings, idempotent and atomic `acceptInbound`, FIFO claims, redelivery after reopen, the exact 1 MiB payload boundary in UTF-8 bytes, run compare-and-set, `countRuns` for the in-flight states, and the approval lifecycle including expiry, ordering and cross-tenant refusal.
- `migrate` takes an optional migration list. Tests show a migration that fails halfway leaves version 1 and none of its own statements, a step applies once, and a database one version ahead is refused by the store and by the built relay (`relay.start_refused`, reason `store`, "newer relay").

## Task Commits

1. **Task 1: tracer, contract suite plus bindings on the sqlite store** - `3f55e78` (feat)
2. **Task 2: queue, run and approval cases, approvals implemented** - `35c3cbb` (feat)
3. **Task 3: schema versioning, newer-schema refusal, instance id across kill -9** - `cdb5928` (test)
4. **Follow-up: contract case for a reused approval id** - `04da31c` (test)

**Plan metadata:** committed separately after this summary (docs).

## Verification

All runs inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" ...`.

- Task 1 verify: `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/sqliteStore.test.js'`: 9 tests, 9 pass, every name starts `sqlite: `.
- Task 2 RED: with the approval cases written and the approval members absent, `tsc` reported the missing members and the built suite showed 24 pass, 9 fail (all nine approval cases; the queue, atomicity and run cases already passed against the plan-04 store).
- Task 2 verify: `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/sqliteStore.test.js dist/test/killDrill.test.js'`: 48 tests, 48 pass (33 contract cases at that point plus 15 drill rounds), 0 fail, 0 skipped.
- Task 3 verify (per file): `... node --test dist/test/schema.test.js`: 7 tests, 7 pass.
- Reused-approval-id case added afterwards: `node --test dist/test/sqliteStore.test.js` 34 tests, 34 pass.
- Full relay suite (run before that one extra case): `NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node npm test --prefix relay` (inside the cap wrapper): 118 tests, 118 pass, 0 fail, 0 skipped, 0 cancelled.
- Acceptance greps: `grep -c "node:sqlite\|sqliteStore" relay/test/contract/relayStore.contract.ts` prints 0; `grep -c "relayStoreContract('sqlite'" relay/test/sqliteStore.test.ts` prints 1; `unknown-run` 3 and `binding-conflict` 2 matches in the contract.
- `git diff --stat 6c98631 HEAD -- relay` touches only the six files in `files_modified`.

## Files Created/Modified

- `relay/src/store/relayStore.ts`, `sqliteStore.ts`, `schema.ts` - binding and approval members, optional migration list
- `relay/test/contract/relayStore.contract.ts`, `relay/test/sqliteStore.test.ts`, `relay/test/schema.test.ts` - new

## Deviations from Plan

None - plan executed exactly as written.

### Notes (not deviations)

- Task 2 is `tdd="true"`: the queue, atomicity and run cases passed on first run because plan 04 had already implemented those semantics; the nine approval cases failed first (type errors and runtime failures) and passed after the implementation. No separate RED commit was made because the contract file and the approval implementation share files with the Task 1 and Task 2 commits as the plan sequences them.
- The approval and binding types were added to `RelayStore` in two steps (bindings in Task 1, approvals in Task 2) so each commit compiles on its own.
- `addApproval` rejects an approval id that is already used under the same tenant with `invalid-record` (a duplicate would otherwise surface as a raw SQLite constraint error). The plan did not list this case; a contract case pins it (commit 04da31c).

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. T-68-13 (newer schema refused, migration atomic with version bump), T-68-14 (tenant-scoped keys and lookups, no rebinding), T-68-15 (CHECK constraints and compare-and-set), T-68-16 (bound parameters only) are mitigated and tested; T-68-SC held (no package added).

## Next Phase Readiness

Plan 06 (secrets and configuration) does not depend on store changes. Later phases add their state as new `RelayStore` methods plus contract cases and, if the format changes, a new migration at the end of `MIGRATIONS`. RELAY-03 is not ticked here; the orchestrator ticks requirements at phase end.

## Self-Check: PASSED

- Created files found: `relay/test/contract/relayStore.contract.ts`, `relay/test/sqliteStore.test.ts`, `relay/test/schema.test.ts`.
- Commits found: `3f55e78`, `35c3cbb`, `cdb5928`, `04da31c` are ancestors of HEAD.

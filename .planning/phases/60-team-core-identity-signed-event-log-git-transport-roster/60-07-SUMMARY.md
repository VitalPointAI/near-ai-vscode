---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 07
subsystem: team
tags: [event-log, signing, permissions, secrets, snapshots, forgery, git]

requires:
  - phase: 60-02
    provides: "decideTeamAction, actionForEvent, assertNoSecrets, findSecrets"
  - phase: 60-03
    provides: "GitTransport compare-and-swap append loop that re-invokes the builder per attempt"
  - phase: 60-05
    provides: "applyEntry, createState, teamMaterializer, serialiseState, stateHash, snapshotBody, parseSnapshotFile"
provides:
  - "TeamLog facade: append(intents), sync(), verifyAll(), state(), status(), lastSnapshot()"
  - "buildGenesisEvents: signed team.created (lamport 1) and owner member.joined (lamport 2) plus the genesis anchor"
  - "prepareEvents: stamp, secret-check, permission-check, size-check and sign inside the transport builder"
  - "Snapshot writer for owner and lead clients (signed file plus snapshot.written in one commit, race-safe skip)"
  - "Forgery suite proving raw-pushed bad events are rejected identically by every client and that write and read share one decision"
affects: [60-08, 60-09, 60-10, 60-11, 61]

actuals:
  tokens: 14965
  tasks: 3
  commits: 5
plan_head_before: 708294deec421c7aa8eb235cc555a3af5191bd5a
plan_head_after: b7c2a7e23601a490629a44e2cd7075fa5ce09602

tech-stack:
  added: []
  patterns:
    - "Builder-time stamping: lamport, prev, id and signature are derived inside the transport builder so every retry rebuilds"
    - "One decision for write and read: prepareEvents asks the same decideTeamAction and returns the exact string the materialiser records"
    - "Raw-forgery harness: plumbing commit and fast-forward push from a third clone, bypassing TeamLog entirely"

key-files:
  created:
    - src/team/eventLog.ts
    - src/test/teamLog.test.ts
    - src/test/teamForgery.test.ts
  modified: []

key-decisions:
  - "In a multi-intent batch each event's prev is the id of the event before it (the first uses the head id), matching how the genesis pair is chained; the plan text said head.eventId, which is identical for a single intent. The materialiser does not check prev."
  - "A snapshot whose state holds a secret-like value is skipped with a reported conflict ('snapshot skipped ...') rather than thrown, because accepted state can legitimately hold a value an older client let through (read side only warns) and a thrown error would block every later sync."
  - "TeamLog.append returns the user's AppendResult unchanged; the snapshot attempt that follows is exposed through lastSnapshot() because AppendResult has no snapshot field."
  - "A missing signer throws a typed NoDeviceKeyError from append (message 'This computer has no device key for this team.') instead of returning a result, since it is a caller setup problem, not a log outcome."

patterns-established:
  - "Write-side refusals are AppendResult values (kind refused on the first attempt); only secret leaks and missing keys throw"
  - "Tests that need a lost snapshot race wrap the transport so the winner writes between the loser's decision and the loser's append"

requirements-completed: [TEAM-04, SEC-04, SEC-01]

coverage:
  - id: D1
    description: "Two clients on two clones converge: events appended by A are materialised by B with byte-identical serialised state"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamLog.test.ts#two clients on two clones converge: events appended by A are materialised by B with byte-identical state"
        status: pass
    human_judgment: false
  - id: D2
    description: "A lost push race rebuilds lamport, prev, id and signature from the fresh head and the other client accepts the event"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamLog.test.ts#a lost race rebuilds: the event lands at head + 1 as it was when it landed and the other client accepts it"
        status: pass
    human_judgment: false
  - id: D3
    description: "Denied and secret-bearing intents are stopped before anything is written, with the exact read-side reason text and the remote head unchanged"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/test/teamLog.test.ts#an intent the permission matrix denies is refused with the read-side text and nothing is written"
        status: pass
      - kind: integration
        ref: "src/test/teamLog.test.ts#an intent carrying a secret throws SecretLeakError and the remote head is unchanged"
        status: pass
      - kind: integration
        ref: "src/test/teamLog.test.ts#an event over 16 KB is refused before signing with the read-side text"
        status: pass
    human_judgment: false
  - id: D4
    description: "Raw-pushed forged events (tampered body, outsider key, self role change, replayed id, other team) are rejected with the same reasons by both clients, never change state and are listed by verifyAll"
    requirement: SEC-04
    verification:
      - kind: integration
        ref: "src/test/teamForgery.test.ts#raw forged events are rejected with the same reasons by both clients, never change state and are listed by verifyAll"
        status: pass
      - kind: integration
        ref: "src/test/teamForgery.test.ts#a rejected event never poisons the high-water mark: the next honest event takes the very next lamport and both clients accept it"
        status: pass
    human_judgment: false
  - id: D5
    description: "Write and read share one decision: the refusal text equals the read-side rejection text for the owner and for fixture lead, developer and reviewer roles"
    requirement: SEC-04
    verification:
      - kind: integration
        ref: "src/test/teamForgery.test.ts#write and read share one decision: the refusal text equals the reason recorded for the raw-pushed copy"
        status: pass
      - kind: unit
        ref: "src/test/teamForgery.test.ts#a denied role case gets the same text from prepareEvents as applyEntry records for the signed event"
        status: pass
      - kind: unit
        ref: "src/test/teamForgery.test.ts#an allowed role case is allowed by prepareEvents and accepted by applyEntry"
        status: pass
    human_judgment: false
  - id: D6
    description: "verifyAll replays from genesis and reports events, members with device fingerprints, head, rejections, snapshots and read-side secret warnings, yielding to the event loop"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamLog.test.ts#verifyAll replays from genesis and reports events, members, devices, head and snapshots"
        status: pass
      - kind: integration
        ref: "src/test/teamLog.test.ts#verifyAll warns about a secret-like value in an accepted event but never rejects it"
        status: pass
      - kind: integration
        ref: "src/test/teamLog.test.ts#verifyAll yields to the event loop every yieldEvery entries"
        status: pass
    human_judgment: false
  - id: D7
    description: "Owner clients write a signed snapshot every snapshotEvery accepted events in one commit with snapshot.written; non-manager and signer-less clients never do; the race loser skips without an error"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamLog.test.ts#the owner client writes a signed snapshot with snapshot.written in one commit and another client accepts both entries"
        status: pass
      - kind: integration
        ref: "src/test/teamLog.test.ts#two clients crossing the threshold together write one snapshot and the loser skips without an error"
        status: pass
      - kind: integration
        ref: "src/test/teamLog.test.ts#a signer whose role is not owner or lead never writes snapshots"
        status: pass
    human_judgment: false

duration: about 40 min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 07: TeamLog event log facade Summary

**TeamLog builds the genesis pair, turns intents into stamped, secret-checked, permission-checked and signed events inside the transport builder (so lost races rebuild), replays the whole log in verifyAll, and writes owner-signed snapshots; two-clone convergence and raw-forgery suites on real git prove the log converges and that write and read share one decision.**

## Performance

- **Duration:** about 40 min (start time was not captured at the beginning of the run, so this is an estimate)
- **Completed:** 2026-11-01
- **Tasks:** 3
- **Files created:** 3 (one source file, two test files)

## Accomplishments

- `buildGenesisEvents` produces `team.created` (lamport 1, empty prev) and the owner's `member.joined` (lamport 2, prev = created id), both signed by the owner device, with a `GenesisAnchor`; the batch replays with zero rejections and a secret in the team name throws before anything is signed.
- `prepareEvents` is the write side of D-12 and D-23: `assertNoSecrets` on every body, `decideTeamAction` for the author at the current head with the read side's exact `not permitted: <reason>` text, a size check with an 86-character signature in place, then `signEvent`. `TeamLog.append` runs it inside the transport builder so each retry gets a fresh lamport, prev, id and signature.
- `verifyAll` re-fetches, replays from `createState(anchor)`, yields with `setImmediate` every `yieldEvery` (default 200) entries, and reports events, accepted count, members with device fingerprints, head, rejections, unsupported count, snapshots, transport status, the D-10 refusal when set, and read-side secret matches as `<eventId>: <path>` warnings that never reject.
- The snapshot writer (`maybeWriteSnapshot`, run after a successful sync or append) writes one signed `snapshots/<lamport>.json` plus `snapshot.written` in a single commit every `snapshotEvery` (default 500) accepted events for owner or lead signers. The builder re-checks the threshold on retry and returns `snapshot already written`, so the race loser gets a refused result, not an error. Another client accepts both entries and `parseSnapshotFile` returns a provisional state whose hash equals the event body.
- Forgery suite: a third clone pushes five raw forgeries as plain fast-forward commits (tampered body, outsider key claiming the owner, owner self role change, replayed id, another team). Both clients report the same event ids and reasons, state without rejections is byte-identical to before, `verifyAll` lists all five, and the next honest event still takes the very next lamport.
- One decision: for the owner self role change, the `prepareEvents` conflict text, the `TeamLog.append` refusal and the reason recorded for the raw-pushed copy are the same string; fixture lead, developer and reviewer cases (eight denied, five allowed) agree between `prepareEvents` and `applyEntry`.

## Task Commits

1. **Task 1: TeamLog, genesis builder, write-side checks, sync, verifyAll, convergence** - `1d46d7a` (feat), `d71b26c` (test)
2. **Task 2: Forgery suite** - `3a5a281` (test)
3. **Task 3: Snapshot writer** - `6b7356d` (feat), `b7c2a7e` (test)

## Files Created

- `src/team/eventLog.ts` - TeamLog, buildGenesisEvents, prepareEvents, NoDeviceKeyError, DEFAULT_SNAPSHOT_EVERY, SNAPSHOT_ALREADY_WRITTEN
- `src/test/teamLog.test.ts` - 19 tests: genesis, batch stamping, convergence, refusals, lost race, verifyAll, yielding, signer-less log, snapshot writer
- `src/test/teamForgery.test.ts` - 5 tests: raw forgeries, high-water mark, one decision on a raw copy, denied and allowed role cases

## Decisions Made

See `key-decisions` in the frontmatter. In short: batch `prev` chains event to event, an unsnapshottable state is skipped as a reported conflict, the snapshot outcome is read through `lastSnapshot()`, and a missing signer throws a typed error.

## Deviations from Plan

### Auto-fixed Issues

None. One interpretation call, not a defect: the plan's truth says `prev = head.eventId` for every intent in a batch. I chained `prev` from the previous event in the batch (identical for a single intent, and consistent with how the genesis pair is built). The materialiser and validator only check that `prev` is empty or an event id, so nothing depends on the difference.

**Total deviations:** 0 auto-fixed. **Impact:** none on the plan's behaviour or on any other plan's interface.

## Issues Encountered

- One test of my own had an arithmetic slip (expected head 12, the log correctly had 11 after the second snapshot event); corrected the expectation, not the code.
- `TeamLogOptions.snapshotEvery` was added in Task 1's interface but only wired in Task 3, so the Task 1 commit alone carries an accepted-but-ignored option. Harmless, noted for bisecting.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. The plan's threat register (T-60-32 to T-60-35) is covered by tests: secret refusal with the remote head asserted unchanged, one decision on write and read, rebuild per attempt with an injected CAS loss, and owner-only snapshot writing with a race-safe skip. No new network endpoints, auth paths or file access were added; `package.json` is unchanged.

## Verification

- `npm run lint` exits 0.
- `node --test dist/test/teamLog.test.js dist/test/teamForgery.test.js`: 24 tests, 24 pass.
- `npm test` (compile plus the whole suite): 844 tests, 836 pass, 0 fail, 8 skipped (pre-existing skips in other suites).
- Acceptance greps: `decideTeamAction(`, `assertNoSecrets(`, `findSecrets(`, `setImmediate`, `DEFAULT_SNAPSHOT_EVERY = 500` and `snapshot already written` match in `eventLog.ts`; no `vscode` import, no empty catch; `teamForgery.test.ts` has 5 `test(` blocks, references `TEAM_REJECTION_REASONS.badSignature` and `TEAM_REJECTION_REASONS.unboundDevice`, and uses no force push.

## Next Phase Readiness

Ready for 60-08. Callers (the enable command, sync loop and verify command in the following plans) can use `TeamLog` directly: `buildGenesisEvents` plus `transport.append(..., { genesis })` for creation, `append`/`sync`/`verifyAll` afterwards. Phase 61 joins will need the multi-role paths, which the fixture-state tests already exercise at the decision level.

## Self-Check: PASSED

- FOUND: src/team/eventLog.ts
- FOUND: src/test/teamLog.test.ts
- FOUND: src/test/teamForgery.test.ts
- FOUND commits: 1d46d7a, d71b26c, 3a5a281, 6b7356d, b7c2a7e (all ancestors of HEAD)

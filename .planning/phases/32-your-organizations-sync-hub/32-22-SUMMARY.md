---
phase: 32-your-organizations-sync-hub
plan: 22
subsystem: hub
status: complete
tags: [hub, checkpoints, signing, coverage, nesting, debounce, restore, shutdown]
requires: [32-18, 32-19, 32-20, 32-21]
provides:
  - "hub/src/checkpoints.ts: Checkpointer (listen, arrived, asked, pending, settled, stop, isStopped), CHECKPOINT_TIMING, CheckpointLog, AttemptOutcome"
  - "hub/src/main.ts: HubParts.signCheckpoints and onCheckpointLog; ComposedHub.checkpoints; the binary's stop clears checkpoint timers first"
  - "hub/test/helpers/hubHarness.ts: StartOptions.checkpoints, dir, keys, tls (start the same hub again on a kept or restored state directory); Hub.checkpoints, checkpointLogs, keys"
  - "hub/test/helpers/hubWorld.ts: WriteOptions.deps and lamport; createHubWorld({ causalLamport })"
affects: [32-23, 32-26, 32-27, 32-28]
tech-stack:
  added: []
  patterns:
    - "coverage as a worklist over writer logs: an entry is covered once its prev and deps are, with the client's chain-stage lamport and roster checks"
    - "order kept incrementally: per-stream order hash and count as of the latest kept checkpoint, extended by the sorted new entries (one checkpointOrder bucket)"
    - "kept checkpoints as frontiers (stream/writer to covered count), so nesting is a pointwise compare"
    - "one signing job at a time per project on a promise queue; tests await settled()"
key-files:
  created:
    - hub/src/checkpoints.ts
    - hub/test/checkpoints.test.ts
  modified:
    - hub/src/main.ts
    - hub/test/helpers/hubHarness.ts
    - hub/test/helpers/hubWorld.ts
decisions:
  - "Coverage mirrors a client's chain stage as well as causal closure: an entry is covered only when its lamport is one more than the largest of its prev and deps and it cites no roster older than they do. Otherwise a member's malformed entry would be a checkpoint head every honest client refuses, and clients would blame the hub."
  - "Entries that verify with a keep reason (unauthorised, observer-only, newer-version) are covered: the client's fold keeps them as graph nodes too. Held and rejected entries end coverage of their log; a rejection is remembered so the entry is never verified again."
  - "Kept checkpoints of this hub are checked as one chain, smallest first: consecutive pairs must nest and pass checkpointConflict (without entries), then every one's counts and order hashes must be what the nested order gives. Reasons logged: not-nested, equal-count-tip-mismatch, order-mismatch. A conflict stops that project for the life of the process (the kept checkpoints never go away, so it would recur)."
  - "Waiting is checked before conflicts: while any kept head is not covered (or the hub holds another entry at that place), nothing is validated or signed and checkpoint.waiting is logged with missingHeads and kept."
  - "The 60 second floor and the ask gap use the time of this process's own signings; after a restart the first arrival signs 2 seconds later."
  - "An ask that is not rate limited cancels the pending debounce timer before it reads the store; an ask inside the 10 second gap leaves the timer alone."
  - "A trimmed checkpoint is signed only when it still covers everything the latest kept checkpoint covered and grew; otherwise nothing is signed for that attempt. The fewest streams are dropped (binary search on the count dropped from the end of stream id order)."
  - "The size check computes the canonical size of the signed envelope before signing (the signature is always 86 base64url characters), so trimming never relies on catching a signing error."
  - "The checkpointer is on in composeHub and in the test harness by default; every existing hub test passes with it on. HubParts.signCheckpoints false turns it off."
  - "The binary logs checkpoints.stopped {timersCleared} at stop only when a timer was pending, so the exact startup and shutdown event lists other tests pin are unchanged."
metrics:
  duration: "about 75 min"
  completed: 2026-11-20
estimate:
  tokens: 65000
  tasks: 3
actuals:
  tokens: 18565
  tasks: 3
  commits: 3
plan_head_before: 1d470ad91ea2c9a3a93b19a174595e83e4d99c34
plan_head_after: 7c6bf9e475d490d691ba30413403875174325e8b
---

# Phase 32 Plan 22: Signed checkpoints Summary

The hub now signs version 2 checkpoints with its own Ed25519 key over exactly what it can read (the base cell and cells granted to it, causally closed), in the order a client gets with the hub's earlier checkpoints nested, on a 2 second debounce with a 60 second floor and asks at most every 10 seconds; it keeps every checkpoint, sends each as a checkpoint event, waits after a restore until handed-back checkpoints are covered again, stops a project whose kept checkpoints disagree, trims oversize checkpoints, and stops cleanly.

## What was built

- **Checkpointer (D-45, D-63).** One per project, created on the first signal. Opens each writer's log in seq order with `verifyEntry` and `ProjectRoster.context(now)` (a cell with no key is skipped without verification; blobs of granted-cell entries are read from the store when an entry needs one). Opened entries are kept in memory without their data. Coverage: a worklist over writer logs; an entry is covered when its prev and every dep are covered and the chain-stage lamport and roster checks pass. Heads come from `checkpointHeads`; per-stream counts and order hashes are the running state as of the latest kept checkpoint extended by `checkpointOrder` of the new entries. Signed with `signCheckpoint`, stored with signing time `max(now, latest.signedAt + 1)`, published as `checkpoint {project, checkpoint}` to every device admitted at the cached roster head, and logged `checkpoint.signed` with counts.
- **Kept checkpoints (D-46, D-54, D-70).** Every checkpoint of this hub's key for the project in the store, read on first use and again after each ask (which may have handed some back). `checkpoint.waiting {project, missingHeads, kept}` while any kept head is not covered; `checkpoint.conflict {project, reason, kept}` when they do not form one reproducible chain.
- **Timing.** Debounce `max(last arrival + 2 s, previous signing + 60 s)`, reset on every arrival; asks sign at once when the covered set grew and the last ask-signed checkpoint is 10 s old or more; nothing new signs nothing.
- **Trimming.** Past `CHECKPOINT_MAX_BYTES`, granted streams are dropped from the end of stream id order (never the base cell stream), the closed set recomputed, and `checkpoint.trimmed {project, dropped, streams}` logged.
- **Wiring and shutdown.** `composeHub` builds the checkpointer on the event channel (32-21's `entries` and `checkpoint` signals). The binary's stop calls `stop()` first (timers cleared, no new job, a running job stores nothing), then ends event streams, then closes the server and the store.

## Tests

| Suite | Result |
| --- | --- |
| hub unit suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set, under the cap) | 305 tests, 305 pass, 0 fail, 0 skipped (287 before this plan) |
| checkpoints.test.js | 18 tests (names include ungranted, nest, debounce, ask, waiting, conflict, trimmed, shutdown) |
| hub `npm run lint` (tsc) | clean |

Acceptance greps: `signCheckpoint` in checkpoints.ts 2; `checkpointOrder` in checkpoints.ts 4; `closeAll` in main.ts 1.

### Failing-first evidence

- **All three tasks, red run:** the test file (16 tests at that point) with the harness and world helpers was run against the unchanged hub sources (checkpoints.ts removed, main.ts from the phase branch): 16 tests, **16 fail**, each on an assertion (no checkpoint stored, no checkpoint log line), none on a build error. With the implementation: 16 of 16 pass after one fix (validateChain now checks pairs before order, so two checkpoints that disagree on one count are named `equal-count-tip-mismatch`). The two tests added after that run (the lone order-mismatch conflict and the chain-stage coverage test) show their teeth by mutations M7 and M1 below.
- **Task 1 tracer gate:** the hub suite at the Task 1 commit: 289 of 289 pass, before any Task 2 test was committed.
- **Task 3 binary test:** run against the Task 2 main.ts (no stop wiring): 18 tests, **1 fails** (no `checkpoints.stopped` line after `hub.stopping`); with the wiring 18 of 18 pass.
- **Teeth (D-66, stated mutations of checkpoints.ts, each applied alone, the file restored and compared byte for byte):**
  - M1 chain-stage lamport and roster checks removed: the chain-stage coverage test fails.
  - M2 deps ignored when closing the set: the citing-an-ungranted-cell test fails (after the test was strengthened so the dep, not the lamport, decides; the first version passed under M2).
  - M3 no nesting: nest, ask, restart and waiting fail. M4 no 60 second floor: the burst and ask tests fail. M5 no ask gap: the ask test fails.
  - M6 no waiting check: waiting fails. M7 no conflict check: all three conflict tests fail. M8 an unchanged set signed again: the ask test fails (after a third checkpoint-event assertion was added; the store alone hides it because the same set gives the same signature and hash).
  - M9 trimming from the start of stream id order: trimmed fails. M10 stop leaves timers: the in-process shutdown test fails. M11 no debounce reset: the 0, 1, 2 second test and trimmed fail. M12 handed-back checkpoints never read: the forged-tip conflict test fails. M13 checkpoint event not published: the tracer, ask and binary tests fail.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] Coverage mirrors the client's chain stage**
- **Issue:** causal closure alone covers an entry with a wrong lamport or a stale roster citation, which every client's chain stage refuses; such a head would look like a withheld entry to clients.
- **Fix:** the covered set also requires the chain-stage lamport and roster checks; a test pins it.
- **Commit:** 78372d82

**2. [Rule 3 - Blocking] Test helpers outside the plan's files**
- `hub/test/helpers/hubHarness.ts`: options to keep a state directory and reuse the hub's keys and TLS pair (restart and restore tests), the checkpointer on `Hub`, and captured checkpoint log lines; `close()` stops the checkpointer and waits for its jobs. Additive; the default behaviour of every other option is unchanged.
- `hub/test/helpers/hubWorld.ts`: optional `deps` and `lamport` on writes and a `causalLamport` world option (default off, so every other test's entries are byte-identical).
- **Commits:** 78372d82

**3. [Rule 2 - Correctness] Shutdown evidence in the binary log**
- **Issue:** with the 60 second floor no timer can fire inside the shutdown window, so the binary test could not see whether stop cleared the timers.
- **Fix:** `Checkpointer.stop()` returns how many timers it cleared; the binary logs `checkpoints.stopped {timersCleared}` when that is above 0 (an idle stop logs nothing new, so the event lists stateDir.test.ts pins stay as they are).
- **Commit:** 7c6bf9e4

**4. [Plan detail] events.ts unchanged**
- The checkpoint event name, `publish`, the channel and `closeAll` without a resync frame were already in 32-21's events.ts, and main.ts already called `closeAll`. The checkpointer publishes through `EventHub.publish`; the binary test asserts the stream ends with no resync frame.

Files outside the plan's `files_modified`: hub/test/helpers/hubHarness.ts, hub/test/helpers/hubWorld.ts (above).

## Decisions

The owner accepted the 32-CONTEXT defaults; the plan had no checkpoint. D-63 settled coverage. Decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- **32-23 (client):** a client recomputes a hub checkpoint with every earlier checkpoint of that hub it holds nested (`recomputeCheckpoint(c, entries, undefined, earlier)`); a client holding only the latest one gets an order mismatch whenever an entry arrived late and concurrent (the nest test shows this). The checkpoint ask answer carries the latest checkpoint as it was before the ask; the newly signed one arrives as a `checkpoint` event and in the next heads, append or entries answer.
- **32-26 (malicious hub and restore drill):** with the harness `dir`, `keys` and `tls` options a test can stop a hub, copy its state directory, and start the same hub on the copy; the waiting test is the honest-restore control. Coverage is the base cell and hub-granted cells only (D-63).
- **32-28 (operator docs):** log events `checkpoint.signed`, `checkpoint.waiting`, `checkpoint.conflict`, `checkpoint.trimmed`, `checkpoint.too_large`, `checkpoint.failed`, `checkpoints.stopped`, each with the project id, counts and a reason word only.
- **Cost:** kept checkpoints are read in full from the store on first use per project and after every ask. A long-running busy project keeps many; a store query for checkpoints received since a time would make the ask path constant. Memory per project is the opened entries without data plus one frontier per kept checkpoint.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-32-85 (every checkpoint kept, handed-back ones nested), T-32-86 (coverage limited to opened, causally closed entries, client recompute in every test), T-32-88 (10 second ask rule) and T-32-89 (bodies reduced and kept in memory only; log fields are the project id, counts and reason words, asserted in the waiting, conflict, trimmed and shutdown tests) are mitigated as planned.

## Self-Check: PASSED

- hub/src/checkpoints.ts and hub/test/checkpoints.test.ts exist; hub/src/main.ts, hub/test/helpers/hubHarness.ts and hub/test/helpers/hubWorld.ts are modified.
- Commits 78372d82, 469a65a5 and 7c6bf9e4 are on feat/phase-32-22-signed-checkpoints.

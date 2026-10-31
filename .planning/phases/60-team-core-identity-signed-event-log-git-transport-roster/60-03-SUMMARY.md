---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 03
subsystem: team
tags: [git-transport, compare-and-swap, quarantine, fault-injection, redaction]

requires:
  - phase: 60-01
    provides: "GitTransport tracer, runGit, transport interface, shared harness"
provides:
  - "Compare-and-swap append loop: fetch, rebuild through the builder, commit, push, classify, retry with jittered exponential backoff"
  - "classifyPush, classifyGitFailure, CAS_LOST_MARKERS, RETRYABLE_FETCH_MARKERS, QUARANTINE_REF_PREFIX and an exported per-mirror withMirrorLock"
  - "Lost-response recovery by ancestry, offline and paused status with redacted reasons, persisted pin that catches a rewrite after the mirror is deleted"
  - "Harness: faultRunner, recordingMaterializer, withGlobalGitConfig, testEvent, fakeGitResult"
affects: [60-04, 60-05, 60-06, 60-07, 60-08, 60-09, 60-10, 60-11]

actuals:
  tokens: 15000
  tasks: 2
  commits: 2
plan_head_before: d239daefc989c1a578a99010b1ebaaa87d141613
plan_head_after: 732b512f50be4f581cb669f1cc65bff5ac5214f0

tech-stack:
  added: []
  patterns:
    - "Fetch into a staging ref, advance the trusted ref only after the ancestry check passes"
    - "Pin file written with temp-file-then-rename holds the last trusted head, Lamport position and entry count"
    - "Result-replacing git runner wrapper for fault injection (including runReal to lose a response that landed)"

key-files:
  created: []
  modified:
    - src/team/gitTransport.ts
    - src/test/helpers/teamHarness.ts
    - src/test/teamGitTransport.test.ts

key-decisions:
  - "Fetches land in refs/team/incoming; refs/team/coordination only moves after every trusted commit is an ancestor of the fetched head. A rewritten head therefore never reaches readAll."
  - "A push that returns no porcelain line (timeout, network, auth) is treated as ambiguous: the commit is remembered and the next attempt's fetch decides whether it landed. Offline is returned only if attempts run out or the fetch itself fails."
  - "A branch that disappears from the remote is not treated as a rewrite; it keeps the earlier behaviour (status ok, nothing new)."
  - "Extra files in a commit must match snapshots/<12 digits>.json, and a snapshot path that already exists in the parent tree is refused, so an append can never modify an existing file."
  - "GitTransportOptions gained an optional gcEveryOperations (default 100) so maintenance can be tested without 100 operations."

patterns-established:
  - "Tests that need a stale view arm a fault rule that fakes one successful fetch, so a real push loses a real race."
  - "Credential canaries are generated at runtime and asserted absent from every status, result reason and diagnostic."

requirements-completed: []

coverage:
  - id: D1
    description: "A writer that loses the push race fetches again, the builder is called with a head one higher, and the remote ends linear with both events"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#a writer that loses the race rebuilds from the fresh head and both events land in a linear history"
        status: pass
    human_judgment: false
  - id: D2
    description: "Exhausted retries return busy with delays baseDelayMs * 2^(n-1) * (0.5 + random); permanent remote rejections and conflicts are reported, never retried blindly"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#every push losing the race returns busy after maxRetries + 1 attempts with jittered exponential delays"
        status: pass
    human_judgment: false
  - id: D3
    description: "A push whose response was lost is recognised by ancestry and written once"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#a push whose response was lost is recognised on the next fetch and the event is written once"
        status: pass
    human_judgment: false
  - id: D4
    description: "Concurrent appends (same mirror, and three separate mirrors) lose no event and keep history linear; git calls on one mirror never interleave"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#three clients appending concurrently from separate mirrors lose no event and keep history linear"
        status: pass
    human_judgment: false
  - id: D5
    description: "A rewritten branch is quarantined and paused with the D-33 text, state and readAll stay on the last trusted history, and a saved position catches the rewrite after the mirror is deleted"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#a saved position catches a rewrite even after the mirror directory was deleted"
        status: pass
    human_judgment: false
  - id: D6
    description: "Offline reasons carry no URL userinfo or password; the remote is never stored in the mirror config; a failing global pre-push hook does not stop a coordination push"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#an unreachable remote makes the transport offline with a redacted reason, then recovers when the remote is back"
        status: pass
    human_judgment: false
  - id: D7
    description: "Modified, deleted, merge and unexpected-path history become anomaly rows; event text always comes from the adding commit"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#a commit that modifies an existing event file becomes an anomaly and the adding commit stays the source of truth"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-10-31
status: complete
---

# Phase 60 Plan 03: Compare-and-swap git transport Summary

**The git transport now appends with retrying compare-and-swap that rebuilds and re-signs through the builder on every lost race, recovers lost push responses without duplicates, and pauses, quarantines or goes offline with redacted reasons instead of following a rewritten or unreachable remote.**

## Performance

- **Duration:** about 25 min
- **Started:** 2026-10-31T12:38:00Z
- **Completed:** 2026-10-31T13:03:00Z
- **Tasks:** 2
- **Files modified:** 3 (no files created)

## Accomplishments

- `append(build)` on an existing log runs the whole operation inside `withMirrorLock`: fetch (retrying the lock-race wording up to 3 times), ancestry check for earlier attempts of this operation, builder call with the fresh `(state, head)`, `materializer.check`, plumbing commit on the fetched head, `push --porcelain` with no force option, then classification. Lost races sleep `baseDelayMs * 2^(n-1) * (0.5 + random())` through the injected sleep; exhaustion returns `busy`.
- `classifyPush` reads only flagged porcelain lines (the "To <url>" line is never used). The three CAS-loss wordings come from one constant, `up to date` is success, any other `!` line is permanent and carries the redacted summary plus up to three `remote:` lines, and a result with no ref line is ambiguous/offline.
- `classifyGitFailure` separates absent branch, lock race, auth (adds the "Run git fetch once in a terminal..." hint) and unreachable, all redacted.
- Rewrite handling (D-33) is now complete. Fetches go to `refs/team/incoming`; `refs/team/coordination` is the trusted head and only moves after the ancestry check. A rewrite creates `refs/team/quarantine/<12 chars>`, sets `paused` with the D-33 text, keeps the state, and makes appends return `paused`. A `pin.json` beside the mirror (temp file then rename) stores head, Lamport and entry count, so a deleted mirror still detects a rewrite.
- Status is `offline` with a redacted reason for fetch, push, ls-remote and head-comparison failures, and returns to `ok` on the next successful fetch. The mirror sets `transfer.fsckObjects true`, never stores the remote, and keeps its local empty `core.hooksPath`.
- `git gc --auto --quiet` runs inside the lock every N successful operations (default 100); a failure is delivered, redacted, to `onDiagnostic` listeners and does not change status. `head()` and `onDiagnostic()` were added as class members.
- Test coverage: 33 tests in `teamGitTransport.test.ts` (6 from 60-01 plus 27 new); the whole team family passes 177 of 177.

## Task Commits

1. **Task 1: CAS append loop, push classification, mirror mutex, lost-response recovery** - `84da499` (feat, includes the full transport source and harness)
2. **Task 2: offline and paused status, rewrite pin, anomaly rows, hook and URL hygiene** - `732b512` (test)

**Plan metadata:** the docs commit that adds this file and the STATE and ROADMAP updates.

## Files Created/Modified

- `src/team/gitTransport.ts` - the full transport (append loop, classifiers, lock, pin, quarantine, gc, diagnostics)
- `src/test/helpers/teamHarness.ts` - `faultRunner`, `recordingMaterializer`, `withGlobalGitConfig`, `testEvent`, `fakeGitResult`
- `src/test/teamGitTransport.test.ts` - 27 new tests on real git with fault injection

## Decisions Made

See `key-decisions` above. The two worth repeating: fetches use a staging ref so a rewritten head never becomes trusted, and an unanswered push is retried through the next fetch rather than reported offline at once, because the push may have landed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Source for both tasks landed in one commit**
- **Found during:** Task 1 commit
- **Issue:** `gitTransport.ts` is one file and the rewrite, pin, anomaly and status code share the fetch path with the append loop, so the Task 2 source could not be separated from Task 1 without a throw-away intermediate version.
- **Fix:** Commit 1 holds the whole transport plus Task 1 tests; commit 2 holds the Task 2 tests (and passes against that source). No RED commit exists for Task 2; the tests were written against the specified behaviour and several failed first on test-side mistakes only (wrong commit counts, a probe that never compared heads), never on weakened assertions.
- **Files modified:** `src/team/gitTransport.ts`, `src/test/teamGitTransport.test.ts`
- **Commits:** `84da499`, `732b512`

**2. [Rule 2 - Missing critical] Existing snapshot paths are refused**
- **Found during:** Task 1
- **Issue:** `update-index --add` on a path already in the parent tree would modify an existing coordination file, which every other client then reads as a history anomaly.
- **Fix:** An extra file whose path exists in the fetched tree returns `refused` (or `conflict` after a lost race) with "A snapshot for this point already exists."
- **Files modified:** `src/team/gitTransport.ts`
- **Commit:** `84da499`

**3. [Plan interface addition] Optional `gcEveryOperations` and `fakeGitResult`**
- The gc interval needed to be testable, so `GitTransportOptions` gained an optional `gcEveryOperations` (default 100). The harness also exports `fakeGitResult` for building runner results. Neither changes an existing signature.

**Total deviations:** 1 process note, 1 auto-added guard, 1 additive option. **Impact:** none on the specified behaviour.

## Issues Encountered

- Two test-side mistakes fixed during the run: commit-count arithmetic in three linear-history assertions (genesis is one commit), and a head-comparison probe that used an up-to-date mirror (no `merge-base` call is needed when the trusted commit equals the fetched head). The implementation was not changed for either.
- Full `npm test` was not run in this plan (the full suite runs at the phase boundary per the cadence rule). Known timing-sensitive tests (`spendSendPath`, `streamStalls`, `toolsPage`, `turnEfficiency`) were not touched.

## Known Stubs

None. The 60-01 stubs for `pinFile`, `maxRetries`, `baseDelayMs`, `sleep`, `random` and non-genesis append are all implemented here. Automatic recovery from a rewritten branch remains out of scope by design (D-33).

## Threat Flags

None beyond the plan's threat model. T-60-10 to T-60-15 are mitigated and tested; T-60-16 (withheld events) is accepted as planned. No package installs; `package.json` is unchanged.

## Self-Check

- `src/team/gitTransport.ts`, `src/test/helpers/teamHarness.ts`, `src/test/teamGitTransport.test.ts` exist; commits `84da499` and `732b512` are ancestors of HEAD.
- `npm run lint` clean. `node --test dist/test/teamGitTransport.test.js` 33 of 33 (run three times); `node --test dist/test/team*.test.js` 177 of 177.
- Plan gates hold: no `--force` or `--force-with-lease`, no empty catch or discarding promise handler, no `vscode` import under `src/team`, no `remote add` or `config remote.`, no em-dashes, `QUARANTINE_REF_PREFIX` is `refs/team/quarantine/`, `logRewritten` and `transfer.fsckObjects` present, `merge-base` used for ancestry.

## Self-Check: PASSED

## Next Phase Readiness

The transport contract (`append(build)`, `fetch`, `readAll`, `head`, `status`, `onUpdate`, `onDiagnostic`) is stable for 60-04 and 60-05. The real team materializer in 60-05 plugs in through `Materializer<S>` with no transport change; its `check` is already called with the fresh state on every attempt.

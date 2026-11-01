---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 10
subsystem: team
tags: [concurrency, git, cas, fork, child-process, bare-remote, mirror-lock]

requires:
  - phase: 60-03
    provides: "GitTransport compare-and-swap append loop with maxRetries, baseDelayMs and pinFile options"
  - phase: 60-07
    provides: "TeamLog.append/verifyAll and buildGenesisEvents"
provides:
  - "Fork-target helper that runs one team client in its own process with its own device key and reports over IPC"
  - "Separate-mirror and shared-mirror concurrency tests on a real bare remote (ROADMAP success criterion 4)"
  - "Cross-process fix in GitTransport: mirror config writes are skipped when already correct and retried on git's config.lock"
affects: [60-11, 63]

actuals:
  tokens: 6242
  tasks: 2
  commits: 3
plan_head_before: 559cd68ed779acc472f6d3fe079da9ed5dad1de3
plan_head_after: 0903a6876317d3c48c839746d63249600c7d23c0

tech-stack:
  added: []
  patterns:
    - "Fork-target test helper guarded by require.main === module so importing its IPC types from a test has no side effects"
    - "ChildClient wrapper keeps received messages and the first failure, so a child error that arrives before anyone awaits it is still reported with its stderr"
    - "End-state-only concurrency assertions: event count, distinct ids, one root, no merge commits, lamports 1..N in commit and file-name order, per-device authorship, clean fresh replay"

key-files:
  created:
    - src/test/helpers/teamAppendChild.ts
    - src/test/teamConcurrency.test.ts
  modified:
    - src/team/gitTransport.ts
    - src/test/teamGitTransport.test.ts

key-decisions:
  - "Fixed the shared-mirror race at its source in gitTransport.ts (config.lock) instead of serialising or retrying in the test; no export changed and single-process behaviour is unchanged"
  - "Mirror settings are written only when `git config --get` shows a different value, so reopening a configured mirror takes no lock at all; the retry covers the first-open case"
  - "Added a deterministic regression test to teamGitTransport.test.ts (outside the plan's files list) because the shared-mirror test only hits the race probabilistically after the fix"

patterns-established:
  - "Cross-process races in the mirror are fixed in gitTransport.ts with a named marker list (CONFIG_LOCK_MARKERS) next to RETRYABLE_FETCH_MARKERS"

requirements-completed: [TEAM-04]

coverage:
  - id: D1
    description: "4 forked clients on separate mirrors append 5 events each: 26 events exactly once, one root, no merge commits, lamports 1..26 in commit and file-name order, each device authored exactly 5, remote denies non-fast-forward, fresh client accepts 26 and rejects none"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamConcurrency.test.ts#4 forked clients with separate mirrors append 5 events each: every event once, linear history, no forced update, clean fresh replay"
        status: pass
    human_judgment: false
  - id: D2
    description: "3 forked clients sharing one mirror directory and one pin file append 3 events each (14 events) and converge with the same end-state guarantees"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamConcurrency.test.ts#3 forked clients sharing one mirror directory append 3 events each and converge the same way"
        status: pass
    human_judgment: false
  - id: D3
    description: "Opening a mirror that another process is configuring retries git's config.lock; an already configured mirror is not written again"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamGitTransport.test.ts#opening a mirror that another process is configuring retries the config lock, and an already configured mirror is not written again"
        status: pass
    human_judgment: false
  - id: D4
    description: "The Node 22 engine floor run of the concurrency file"
    verification: []
    human_judgment: true
    rationale: "/usr/bin/node (Node 22) is not installed in this environment, so the file was only run on Node 24; it needs one run on Node 22 before release"

duration: 38min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 10: Cross-Process Concurrency Tests Summary

**Forked-process concurrency tests prove criterion 4 (every event once, linear, never forced, clean fresh replay) with separate and shared mirrors, and surfaced and fixed a real shared-mirror `config.lock` race in GitTransport**

## Performance

- **Duration:** 38 min
- **Completed:** 2026-11-01T13:36:15Z
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- `teamAppendChild.ts`: a fork target that creates its own device key in its own in-memory secret store (only the public half crosses IPC), waits for the parent to bind it to the owner, appends N `member.availability` events through `TeamLog` with `maxRetries` 20 / `baseDelayMs` 25, and reports `{ ok, kind, attempts }` per append. Any thrown error is sent as an `error` message and the child exits 1.
- `teamConcurrency.test.ts`: the parent pushes the genesis, forks the children with `execArgv: []`, binds all child devices in one `device.added` batch, releases them together, then asserts on the bare remote: all events exactly once with distinct ids, `receive.denyNonFastForwards` true, exactly one root and no merge commit, one commit per append, lamports exactly 1..N in commit order and in file-name order, each child device authored exactly its own events, and a fresh verifier clone running `verifyAll` with zero rejections and `accepted === N`. It never asserts which child won.
- Two cases: 4 clients x 5 events with separate mirrors (26 events, about 3 s) and 3 clients x 3 events on one shared mirror and pin file (14 events).
- The shared-mirror case failed 15 of 15 runs on first execution, which exposed a genuine cross-process race that is now fixed in `gitTransport.ts` (see Deviations).

## Task Commits

1. **Task 1: Fork child helper and the separate-mirror concurrency test** - `c6de827` (test)
2. **Task 2: Shared-mirror case and the engine-floor run** - `2b07c88` (fix, gitTransport race plus its regression test) and `0903a68` (test, shared-mirror case)

**Plan metadata:** committed separately (docs: complete plan)

## Files Created/Modified

- `src/test/helpers/teamAppendChild.ts` - fork target and the `ParentMessage` / `ChildMessage` IPC types
- `src/test/teamConcurrency.test.ts` - separate-mirror and shared-mirror concurrency tests, `ChildClient` process wrapper, shared `runScenario`
- `src/team/gitTransport.ts` - `setMirrorConfig`, `initMirror`, `CONFIG_LOCK_MARKERS`; `ensureMirror` uses them
- `src/test/teamGitTransport.test.ts` - deterministic regression test for the config-lock retry

## Decisions Made

- The race was fixed in `gitTransport.ts`, as the plan directs for a cross-process race, with no weakened assertion and no retry budget above 20.
- Config writes are conditional (`config --get` first) rather than only retried, so the common reopen path takes no lock; the retry only matters on a first open or a genuinely simultaneous first open.
- A concurrent `git init --bare` that fails but leaves a valid mirror (`HEAD` present) is treated as success.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Shared mirror failed with "could not lock config file"**
- **Found during:** Task 2 (shared-mirror case)
- **Issue:** `ensureMirror` ran three unconditional `git config` writes per transport instance. With several processes opening one mirror at once, the losers failed with `error: could not lock config file .../coordination.git/config: File exists` and the child reported a `GitCommandError`. Failed 15 of 15 first runs.
- **Fix:** `setMirrorConfig` skips the write when `git config --get` already shows the value and retries a `could not lock config file` failure (up to 20 times, jittered pause, injectable `sleep`). `initMirror` treats a failed `git init --bare` that left a valid mirror as success and retries a lock failure. New exported `CONFIG_LOCK_MARKERS` sits beside `RETRYABLE_FETCH_MARKERS`; no existing export changed.
- **Files modified:** `src/team/gitTransport.ts`
- **Verification:** shared-mirror test then passed 55 of 55 consecutive runs; all 34 `teamGitTransport` tests green.
- **Committed in:** `2b07c88`

**2. [Rule 2 - Missing critical] Deterministic regression test for the fix**
- **Found during:** Task 2
- **Issue:** after the fix the shared-mirror test only hits the config lock by chance, so it is weak regression coverage for the fix.
- **Fix:** added a test to `src/test/teamGitTransport.test.ts` that injects two lock errors on a fresh mirror, asserts the retries happened, and asserts a reopen of a configured mirror performs no config write. Confirmed it fails against the old `gitTransport.ts` and passes against the fix. This file is outside the plan's `files_modified` list.
- **Files modified:** `src/test/teamGitTransport.test.ts`
- **Committed in:** `2b07c88`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical)
**Impact on plan:** the plan anticipated exactly this case ("fix it in gitTransport.ts at the source"); the extra regression test is the only scope addition.

## Issues Encountered

- **Node 22 floor run not performed.** The plan's last verify step runs the file with `/usr/bin/node` (Node 22). Only Node 24 (v24.22.2) is installed here and `/usr/bin/node` does not exist, so the file was run on Node 24 only. The tests use only `node:child_process`, `node:test` and `node:assert`, which the RESEARCH verified on Node 22.22.1, but the floor run itself still needs doing on a machine with Node 22 (recorded as a human-judgment coverage item D4).
- No flake was found in the final code: 55 consecutive runs of `teamConcurrency.test.js` passed (8 + 22 + 25 after the fix), plus a 12-run series of the first test alone. The 15 early failures were the deterministic config-lock defect, not a flake.
- Mutation check: setting `MAX_RETRIES` to 0 in the compiled test makes the separate-mirror test fail on "no append is left busy or refused", so the assertions do react to a broken retry loop.

## User Setup Required

None - no external service configuration required.

## Verification

- `npx tsc -p tsconfig.json` (via `./node_modules/.bin/tsc`) and `node --test dist/test/teamConcurrency.test.js dist/test/teamGitTransport.test.js`: 36 tests, 36 pass.
- `npm run lint`: exit 0.
- Full `npm test`: 893 tests, 885 pass, 0 fail, 8 skipped (890 before, plus the 2 concurrency tests and 1 regression test).
- Acceptance greps: `execArgv: []`, `rev-list`, `denyNonFastForwards` match; no `PRIVATE KEY` / `MC4CAQAw` in the helper or test; `grep -c "^test("` is 2; no `--force` or `--force-with-lease` in `gitTransport.ts`.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or trust boundary; the child helper is test-only (`dist/test/**` is excluded from the VSIX) and keeps its private key in process memory.

## Self-Check: PASSED

- Created files exist: `src/test/helpers/teamAppendChild.ts`, `src/test/teamConcurrency.test.ts`.
- Commits `c6de827`, `2b07c88`, `0903a68` are ancestors of HEAD.

## Next Phase Readiness

- Ready for 60-11. The CAS loop is now demonstrated under real multi-process contention, which Phase 63 claims will rely on.
- Open item: run `node --test dist/test/teamConcurrency.test.js` once under Node 22 before release.

---
*Phase: 60-team-core-identity-signed-event-log-git-transport-roster*
*Completed: 2026-11-01*

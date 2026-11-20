---
phase: 31-staff-roster-cell-keys-and-migration
plan: 10
subsystem: replica
tags: [replica, yjs, worker_threads, resourceLimits, denial-of-service, decode-worker, release-content, security-docs]
status: complete

requires:
  - phase: 31-staff-roster-cell-keys-and-migration
    provides: 31-03 (inspectUpdate, inspectState, decodeSnapshot, skimSnapshot, MAX_STATE_BYTES), 31-07 and 31-08 (merged base; no direct API used)
provides:
  - src/staff/replica/decodeWorker.ts (worker body; answers update, snapshot and state jobs as plain counts)
  - src/staff/replica/decodeHost.ts (DecodeHost, DECODE_LIMITS, DecodeVerdict, DecodeFailure, DecodeKind)
  - src/test/helpers/decodeWorkerHog.ts (test-only misbehaving worker)
  - extension/dist/staff/replica/decodeWorker.js in the verify:release required list
  - SECURITY.md "## Multi-user staff projects (preview)" with "### Update size limits and the decode worker"
affects: [31-13, 31-18, 31-23, 32]

actuals:
  tokens: 10221
  tasks: 3
  commits: 3
plan_head_before: cceb466e11083984bea59e98ed3ab13bde83d547
plan_head_after: 8596b0f2339645c165320a008ff91033809d7902

tech-stack:
  added: []
  patterns:
    - "One reused worker_threads worker per host, jobs serialised through a promise tail, replies matched by job id, every failure a verdict and never a rejection"
    - "Two heap controls: resourceLimits plus a host-side heap watch (worker.getHeapStatistics every 10 ms while a job runs), because a process-wide --max-old-space-size overrides a worker's resourceLimits"
    - "Test-only misbehaving worker selected by the first job byte (OOM, hang, throw, exit, bad reply, report heap limit)"

key-files:
  created:
    - src/staff/replica/decodeWorker.ts
    - src/staff/replica/decodeHost.ts
    - src/test/helpers/decodeWorkerHog.ts
    - src/test/staffReplicaWorker.test.ts
  modified:
    - scripts/verify-release-content.mjs
    - SECURITY.md

key-decisions:
  - "Limits at the D-43 defaults: 128 MB old generation, 32 MB young generation, 4 MB stack, 5 s per job"
  - "Host-side heap watch added (Rule 2): a process started with --max-old-space-size (command line or NODE_OPTIONS) gives every worker that limit whatever resourceLimits says, measured on Node 24 (worker heap_size_limit 1542 MB under the repo's test wrapper); the host reads the worker heap while a job runs and stops it above old + young cap"
  - "DecodeVerdict ok carries structs, deletes and clients counts (a superset of the planned { ok, structs }), so the worker's answer can be compared with the in-process inspection"
  - "An unreadable reply from the worker drops the worker (malformed, counted as a restart) rather than reusing it"
  - "close() waits for jobs already asked, then ends the worker; it is not a failure and does not count as a restart"
  - "starts and lastFailure ('out-of-memory' | 'timeout' | 'crashed') exposed read-only for logs and tests"

requirements-completed: [MUS-06]

duration: 15min
completed: 2026-11-20
---

# Phase 31 Plan 10: Decode Worker Summary

**Outside updates, states and snapshots are inspected in one reused worker thread capped at 128/32/4 MB and 5 s per job, with a host-side heap watch that holds the cap even when the process's --max-old-space-size overrides resourceLimits; out of memory or time is too-large plus a restart, never a host crash.**

## Performance

- **Duration:** about 15 min
- **Started:** 2026-11-20T04:17Z
- **Completed:** 2026-11-20T04:33Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- `decodeWorker.ts`: answers `{ id, kind, bytes }` with the pure `inspectUpdate` (update), `inspectState` (state) or the size, `skimSnapshot` and `decodeSnapshot` checks (snapshot), as `{ id, ok: true, structs, deletes, clients }` or `{ id, ok: false, error }`. Never stores or keeps anything (P-31-12); no editor API.
- `decodeHost.ts`: `DecodeHost` starts one worker lazily with `resourceLimits` from `DECODE_LIMITS`, serialises jobs, matches replies by id, moves a copy of the bytes to the worker. `ERR_WORKER_OUT_OF_MEMORY`, the heap watch and the per-job timeout map to `too-large`; any other error, exit, message error or unreadable reply maps to `malformed`. The failed worker is dropped and counted in `restarts`; the next job starts a new one. `inspect` never rejects.
- Worker lifecycle documented in the file header as a state machine (none, running, the transitions on answer, OOM, timeout, crash, close), and every transition is tested.
- `scripts/verify-release-content.mjs` requires `extension/dist/staff/replica/decodeWorker.js`.
- SECURITY.md: new `## Multi-user staff projects (preview)` section (between "Project state and sync" and "Costs") with `### Update size limits and the decode worker` as self-contained bullets, so later plans can add their own subsections after it.

## Task Commits

1. **Task 1: tracer, real worker equals in-process inspection** - `d4994ab1` (feat)
2. **Task 2: OOM and timeouts cost a restart, never the host** - `7308d848` (feat)
3. **Task 3: ship the worker, SECURITY.md section** - `8596b0f2` (docs)

## Test results

All runs under the shared lock and the memory cap (`MemoryMax=4G`, `--max-old-space-size=1536`).

- `dist/test/staffReplicaWorker.test.js`: 15 tests, 15 pass (Task 1 needed at least 4, Task 2 at least 9).
- Task 3 verify, `staffReplicaWorker` + `staffIntegration`: 27 tests, 27 pass.
- Extra docs checks because SECURITY.md and verify-release-content.mjs changed, `gateDocs` + `relayIsolation`: 45 tests, 45 pass.
- RED evidence for the heap watch: with `watchHeap` disabled in the compiled host, "the heap cap holds even when the process was started with --max-old-space-size" failed (the child peaked at 584 MB) and "the real worker out of memory on an accepted 100,000-item state" failed (the decode passed instead of being refused); both pass with the watch.
- Acceptance greps: `dist/staff/replica/decodeWorker.js` exists after compile; `resourceLimits` 2 and `ERR_WORKER_OUT_OF_MEMORY` 2 in decodeHost.ts; the required entry 1 in verify-release-content.mjs; the section heading 1 and em-dashes 0 in SECURITY.md.
- Full `npm test` and `verify:release` not run (orchestrator runs them at the phase end, 31-23).

## Decisions Made

See key-decisions in the frontmatter. No checkpoint or one-way task in this plan; all limits are the plan's defaults.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] resourceLimits alone does not cap a worker in a process started with --max-old-space-size**
- **Found during:** Task 2
- **Issue:** The first OOM test passed only because the 5 s timeout fired: under the repo test wrapper (`NODE_OPTIONS=--max-old-space-size=1536`) the worker reported a heap limit of 1542 MB with `maxOldGenerationSizeMb: 16`. V8 flags win over a worker's resource constraints. Any editor or user setup that passes that flag (or NODE_OPTIONS) to the extension host would silently lose the D-43 cap.
- **Fix:** the host reads the worker's heap with `worker.getHeapStatistics()` every 10 ms while a job runs (one read at a time, ignored after the job is answered) and stops the worker as `too-large` above old + young cap. `lastFailure` tells out-of-memory from timeout so tests cannot be fooled by the timeout again. New child-process regression test with `--max-old-space-size=512` asserts too-large, `out-of-memory`, and a child peak under 300 MB.
- **Files modified:** src/staff/replica/decodeHost.ts, src/test/staffReplicaWorker.test.ts, src/test/helpers/decodeWorkerHog.ts
- **Commit:** 7308d848

**2. [Minor] The worker also imports `updateGuard` (skimSnapshot) and `kindSchemas/doc` (MAX_STATE_BYTES)**
- The plan says the worker imports only `node:worker_threads` and the pure doc module. `decodeSnapshot` only answers "snapshot or not", so to report `too-large` and `forbidden-content` for snapshots the way `inspectUpdate` does, the worker asks the same pure, hub-side size and skim checks first. Both modules are already loaded by doc.ts; nothing outside src/domain/replica is imported.

**3. [Minor] Task 1 host shipped with the failure mapping**
- The error listener is required from the first commit (an `error` event with no listener would be thrown on the host thread), so the OOM mapping was in Task 1's host; Task 2 added the heap watch, `lastFailure`, the bad-reply drop and all failure tests.

**4. [Planning note] The real-worker OOM probe**
- The research's 100,000-item update (683 KB) is now over `MAX_UPDATE_BYTES` (256 KiB), so the real-worker OOM test sends a 100,000-item state (900 KB, under `MAX_STATE_BYTES`) built with the varuint writer: refused too-large at 16/4 MB, accepted with the shipped limits.

## Issues Encountered

None beyond the deviation above.

## Known Stubs

None. The worker is not wired into the store yet; that is planned (31-13 adds the store hook, 31-18 wires DecodeHost into it).

## Threat Flags

None. No new network endpoint, dependency or agent capability; the worker is internal and reads only bytes the host hands it. SECURITY.md documents it.

## Next Phase Readiness

- 31-13 and 31-18 can use `new DecodeHost()` and `await host.inspect(kind, bytes)`; a verdict is never a rejection. Call `close()` on shutdown.
- 31-23's `verify:release` now needs `dist/staff/replica/decodeWorker.js` in the VSIX (it is outside `dist/test/**`, so `.vscodeignore` already ships it).
- Later plans add their SECURITY.md subsections after "### Update size limits and the decode worker", before "## Costs".

## Self-Check: PASSED

- FOUND: src/staff/replica/decodeWorker.ts, src/staff/replica/decodeHost.ts, src/test/helpers/decodeWorkerHog.ts, src/test/staffReplicaWorker.test.ts
- FOUND commits: d4994ab1, 7308d848, 8596b0f2

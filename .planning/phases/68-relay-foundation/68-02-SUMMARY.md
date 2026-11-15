---
phase: 68-relay-foundation
plan: 02
subsystem: infra
tags: [relay, logging, redaction, healthz, node-test]

requires:
  - phase: 68-01
    provides: "relay workspace, guard entry, HealthRegistry, GET /healthz server with the onRejected hook"
provides:
  - "Redactor (src/log/redact.ts): key drops to lengths, registered-secret masking, phone labels, flat values only, 500-character cap"
  - "Logger (src/log/logger.ts): the relay's only stdout path, one JSON line per call through the Redactor"
  - "First log lines in main.ts: relay.listening, relay.stopping, relay.stopped, relay.stop_timeout, relay.start_refused, relay.crashed, relay.healthcheck_failed, http.rejected"
  - "health.test and logging.test pinning the /healthz contract, the D-11 redaction rules and the output-path source guard"
affects: [68-03, 68-04, 68-05, 68-06, 68-07, 68-08, 71, 72, 73, 74, 75]

actuals:
  tokens: 11900
  tasks: 2
  commits: 2
plan_head_before: 7392e566bc17c37268f4777efe86a14982ef3ef3
plan_head_after: de14e6cb798e5db7d8dcc39241e58230f04f4428

tech-stack:
  added: []
  patterns:
    - "One log sink behind a Redactor; plans register secrets with Redactor.register and install the pseudonym key with setPseudonymKey"
    - "Source guard test scans relay/src for console and process.stdout/stderr use, with an allow-list of one file each"
    - "Tests read the bound port from the relay.listening line (RELAY_PORT=0)"

key-files:
  created:
    - relay/src/log/redact.ts
    - relay/src/log/logger.ts
    - relay/test/health.test.ts
    - relay/test/logging.test.ts
  modified:
    - relay/src/main.ts
    - relay/src/http/server.ts
    - relay/test/startup.test.ts

key-decisions:
  - "Redaction order is secrets, then phones, then the 500-character cut, so a secret split by the cut is already masked."
  - "A field named time, level or event cannot overwrite the line envelope; it is written as field_time, field_level, field_event."
  - "The server passes only a plain upper-case method token (1 to 16 letters) to onRejected, otherwise OTHER, so client-controlled text cannot reach a log line."
  - "A failing sink (closed pipe) never throws into the caller."
  - "Until plan 06 installs the D-18 key, main installs a per-process random 32-byte pseudonym key, so phone labels are stable within one process only."

patterns-established:
  - "Every relay log call is logger.<level>(event, flatFields); nested objects and message text cannot be logged."
  - "Error details for refusals name the setting and never echo its value; the detail goes through the Redactor as well."

requirements-completed: [RELAY-02, RELAY-04]

coverage:
  - id: D1
    description: "Every relay stdout line is one JSON object with time, level and event, produced by the Logger through the Redactor; stderr stays empty"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/startup.test.ts#tracer: the relay logs relay.listening, answers /healthz, logs a rejected path without echoing it, and SIGTERM stops it with exit 0"
        status: pass
      - kind: unit
        ref: "relay/test/logging.test.ts#every logger call writes exactly one JSON line with time, level and event first"
        status: pass
      - kind: unit
        ref: "relay/test/logging.test.ts#under relay/src only log/logger.ts writes to stdout and only bin.ts writes to stderr, and no file calls console methods"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sensitive keys, registered secrets and plus-prefixed phone numbers never appear in clear; dates and bare digit ids stay unchanged"
    requirement: RELAY-04
    verification:
      - kind: unit
        ref: "relay/test/logging.test.ts (21 tests: secret masking, key drops, flat values, 500-character cut, phone labels, Pitfall 10 cases, logger redacts before the sink)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Start refusals, listen errors, crashes, failed healthchecks and rejected requests are logged by event name without echoing a setting value or a request path"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/startup.test.ts (8 tests: bad RELAY_PORT, unknown RELAY_ name, unknown argument, port in use, healthcheck failure, 404 and 405 logs)"
        status: pass
      - kind: unit
        ref: "relay/test/logging.test.ts#crashFields gives the error name, code and message, and a plain description for a value that is not an Error"
        status: pass
    human_judgment: false
  - id: D4
    description: "The /healthz contract: five keys, probe ok/down/timeout, 503 with inFlightRuns null, 405 Allow GET, no-echo 404, no-store and nosniff, headersTimeout 5000 and requestTimeout 10000"
    requirement: RELAY-02
    verification:
      - kind: integration
        ref: "relay/test/health.test.ts (11 tests)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-14
status: complete
---

# Phase 68 Plan 02: Redacting logger and the health and logging contracts Summary

**One output path for the relay: a Logger that writes one JSON line per call to stdout through a Redactor (sensitive keys to lengths, registered secrets masked, plus-prefixed phone numbers labelled by HMAC, flat values only), the relay's first log events, and tests that pin the /healthz contract and fail the suite if any other output path appears.**

## Performance

- **Duration:** about 25 min
- **Completed:** 2026-11-14
- **Tasks:** 2 (1 tracer, 1 TDD)
- **Files:** 4 created, 3 modified, all under `relay/`

## Accomplishments

- `Redactor` and `Logger` exist and `main.ts` creates them before anything else. Every line the relay prints is JSON with `time`, `level`, `event`; `bin.ts` stays the only stderr writer and `log/logger.ts` the only stdout writer.
- Events: `relay.listening` (host, port, version), `relay.stopping`, `relay.stopped`, `relay.stop_timeout`, `relay.start_refused` (`reason` `config` or `listen`, `detail` names the setting, not its value), `relay.crashed`, `relay.healthcheck_failed`, and `http.rejected` (route label, method, status; never the path) through the server's `onRejected` hook for 404, 405 and 5xx. A successful `--healthcheck` and a successful `/healthz` print nothing.
- `startup.test.ts` now starts the relay on `RELAY_PORT=0` and reads the bound port from `relay.listening`; it checks that every stdout line parses with time, level and event and that stderr is empty. Eight tests (baseline 6).
- `health.test.ts` (11 tests) and `logging.test.ts` (21 tests) pin the contracts; the source guard has its own positive-case test so it cannot silently stop detecting.

## Task Commits

1. **Task 1: tracer, the first log lines through the Redactor to stdout** - `13a0876` (feat)
2. **Task 2: health and logging contracts as tests, with the output-path source guard** - `de14e6c` (test)

**Plan metadata:** committed separately after this summary (docs).

## Verification

All run from the worktree, Node 26.13.1 by PATH prefix, inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 ...`.

- Task 1: `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/startup.test.js dist/test/workspace.test.js'` gave 16 pass, 0 fail, 3 skipped (the three older-Node cases, because `NEAR_AI_RELAY_OLD_NODE` was not set for that run; startup.test passed 8 of 8).
- Task 2: `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/health.test.js dist/test/logging.test.js'` gave 32 pass, 0 fail after fixing one wrong expected length in my own test (see deviations).
- Whole relay suite with `NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node`: `npm test --prefix relay` gave 51 tests, 51 pass, 0 fail, 0 skipped (workspace 11, startup 8, health 11, logging 21).
- Acceptance greps: `redactor.fields` in logger.ts is 1 match, `onRejected` in main.ts is 1 match, `invalid-event` in logging.test.ts and `503` in health.test.ts are both present.
- `git status --porcelain -- package.json package-lock.json` prints nothing; no root file was touched; `.planning/config.json` and `.planning/state.json` were not committed.

## Files Created/Modified

- `relay/src/log/redact.ts` - Redactor, LogValue, LogFields, SENSITIVE_KEYS
- `relay/src/log/logger.ts` - Logger, LogLevel
- `relay/src/main.ts` - Redactor and Logger first, the events above, `runHealthcheck(config, logger)`, exported `crashFields`
- `relay/src/http/server.ts` - method token check before `onRejected`
- `relay/test/startup.test.ts`, `relay/test/health.test.ts`, `relay/test/logging.test.ts` - tests

## Decisions Made

See key-decisions above. Plan 06 replaces the per-process pseudonym key with the D-18 key source and registers the real secrets with `Redactor.register`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Method token check in the server's rejection hook**
- **Found during:** Task 1
- **Issue:** `onRejected` passes the request method to a log line. The method is client-controlled text; the plan said "route label, method, status, never the path" but did not bound the method.
- **Fix:** only `^[A-Z]{1,16}$` is passed on, otherwise `OTHER` (T-68-35: nothing client-controlled reaches a log line unchecked).
- **Files modified:** `relay/src/http/server.ts`
- **Commit:** `13a0876`

**2. [Rule 2 - Missing critical functionality] Reserved key protection and a non-throwing sink in the Logger**
- **Found during:** Task 1
- **Issue:** a field named `time`, `level` or `event` could overwrite the line envelope and forge an event name; a closed stdout pipe would throw into callers.
- **Fix:** colliding keys are written as `field_{key}`; the sink call is wrapped in try/catch. Both have tests.
- **Files modified:** `relay/src/log/logger.ts`
- **Commit:** `13a0876`

### Test notes

- My first run of `logging.test.ts` had one failing case: I wrote the expected length of `k-12345678` as 9; it is 10. The expected value in the test was wrong, not the module; fixed in the test. No case was weakened, skipped or removed.
- Beyond the plan's behaviors, the tests add: an unknown argument, a port already in use (`reason` `listen`), 5xx reported through `onRejected`, a secret split by the 500-character cut, longest-secret-first masking, `crashFields`, and the source guard's own positive cases.

## Issues Encountered

None.

## Known Stubs

None. The per-process pseudonym key is a deliberate interim until plan 06 (D-18), recorded in key-decisions.

## Threat Flags

None. No new network surface; the mitigations for T-68-04 and T-68-35 are in place and tested.

## Next Phase Readiness

Plan 03 can add log events freely through the Logger. Plan 06 registers the real secrets and installs the D-18 pseudonym key; any new route plugs into `createRelayServer` and its `onRejected` hook.

## Self-Check: PASSED

- Created files found: `relay/src/log/redact.ts`, `relay/src/log/logger.ts`, `relay/test/health.test.ts`, `relay/test/logging.test.ts`.
- Commits found: `13a0876`, `de14e6c` are ancestors of HEAD.

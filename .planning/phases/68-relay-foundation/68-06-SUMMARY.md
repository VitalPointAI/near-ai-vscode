---
phase: 68-relay-foundation
plan: 06
subsystem: infra
tags: [relay, secrets, redaction, pseudonym-key, no-leak, node-test]

requires:
  - phase: 68-02
    provides: "Redactor.register and setPseudonymKey, Logger, main refusal pattern"
  - phase: 68-04
    provides: "prepareStateDir, writePrivateFileAtomic, readPrivateFile, StateDirError"
provides:
  - "relay/src/secrets.ts: SecretClass, SECRET_CLASSES, SecretSpec, RELAY_SECRETS, TENANT_KEY_NAME, SecretError, SecretSources, refusePlainSecretEnv, loadSecret, loadSecrets"
  - "relay/src/log/pseudonymKey.ts: PSEUDONYM_KEY_FILE, loadPseudonymKey"
  - "main.ts startup order: plain-secret refusal, state directory, secrets, pseudonym key, store, server; log events secrets.loaded and log.pseudonym_key; relay.start_refused reason secrets"
  - "noLeak.test, secrets.test and pseudonymKey.test"
affects: [68-07, 68-08, 69, 71, 73, 75]

actuals:
  tokens: 11100
  tasks: 3
  commits: 4
plan_head_before: 2419078acb838c697f131ca973f30ff99f145c32
plan_head_after: 88ab9b6dcd3c6f7f63e0aa16779a532090d70a65

tech-stack:
  added: []
  patterns:
    - "Secrets only from {NAME}_FILE, $CREDENTIALS_DIRECTORY/{name}, /run/secrets/{name}; one open, checks on the same descriptor (fstat)"
    - "Every loaded value registered with the Redactor in loadSecrets before any other code can log"
    - "End-to-end leak test: spawn dist/bin.mjs with fake secrets, then search stdout, stderr, every state file's bytes and every entry name"

key-files:
  created:
    - relay/src/secrets.ts
    - relay/src/log/pseudonymKey.ts
    - relay/test/noLeak.test.ts
    - relay/test/secrets.test.ts
    - relay/test/pseudonymKey.test.ts
  modified:
    - relay/src/main.ts
    - relay/test/startup.test.ts
    - relay/test/schema.test.ts
    - relay/test/stateDir.test.ts

key-decisions:
  - "Plain-secret refusal runs after the --healthcheck return and before prepareStateDir, so a refused start never creates the state directory."
  - "An explicit {NAME}_FILE pointing at a missing file is an error naming {NAME}_FILE; a missing file in the two directory sources falls through (also ENOTDIR)."
  - "The secret file is opened O_RDONLY|O_NONBLOCK so a named pipe at the path cannot hang startup; fstat then refuses it as not a regular file."
  - "A damaged log-pseudonym.key raises StateDirError, so main reports it as relay.start_refused reason state-dir."
  - "With an operator LOG_PSEUDONYM_KEY the label key is SHA-256 of the secret and no key file is written."

patterns-established:
  - "New secrets are added as SecretSpec entries in RELAY_SECRETS (Phases 69 and 71 flip TEAMS_APP_SECRET to required when Teams is configured)."

requirements-completed: []

coverage:
  - id: D1
    description: "A relay started with fake secrets through {NAME}_FILE serves requests and stops, and the values appear in no output, state file byte or state directory entry name"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/noLeak.test.ts#tracer: a secret supplied through a file is loaded, named in secrets.loaded, and its value appears in no output, state file or state entry name"
        status: pass
      - kind: integration
        ref: "relay/test/noLeak.test.ts#with LOG_PSEUDONYM_KEY_FILE the relay writes no log-pseudonym.key, logs source secret, and the fake key value appears nowhere"
        status: pass
    human_judgment: false
  - id: D2
    description: "A secret given as a plain environment value (TEAMS_APP_SECRET, LOG_PSEUDONYM_KEY, NEAR_AI_KEY_ names) stops startup with exit 1 before the state directory exists, naming the variable and never the value"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/noLeak.test.ts (plain TEAMS_APP_SECRET, plain NEAR_AI_KEY_ACME and LOG_PSEUDONYM_KEY, NEAR_AI_KEY_ACME_FILE allowed)"
        status: pass
      - kind: unit
        ref: "relay/test/secrets.test.ts#refusePlainSecretEnv refuses a plain secret and a plain tenant key, ignores empty values and _FILE names, and never repeats the value"
        status: pass
    human_judgment: false
  - id: D3
    description: "Loader rules: source precedence, missing and typo handling, mode, type, size, length and line-break refusals, EACCES message, symbolic links, redaction of loaded values, no message carries a value"
    requirement: RELAY-04
    verification:
      - kind: unit
        ref: "relay/test/secrets.test.ts (14 cases, 0 skipped on this host)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Phone labels are stable across restarts from an operator key (SHA-256, nothing written) or a 32-byte 0600 key file created once; damaged and world-readable key files are refused; the key is never logged"
    requirement: RELAY-04
    verification:
      - kind: unit
        ref: "relay/test/pseudonymKey.test.ts (6 cases)"
        status: pass
      - kind: integration
        ref: "relay/test/noLeak.test.ts (key file created 0600 and reused on second start, damaged key file refuses start with reason state-dir)"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-11-14
status: complete
---

# Phase 68 Plan 06: Secrets from files and stable phone labels Summary

**The relay now takes every secret from operator-supplied files only (`{NAME}_FILE`, `$CREDENTIALS_DIRECTORY`, `/run/secrets`), refuses any secret given as a plain environment value before touching disk, registers each value with the redactor on load, and keeps phone labels stable across restarts from `LOG_PSEUDONYM_KEY` or a private `log-pseudonym.key`; a real `dist/bin.mjs` run proves the fake values appear in no output, state file or state entry name.**

## Accomplishments

- `secrets.ts` implements the four named secret classes (signal-registration is source `sidecar-volume` and never read by the relay), `refusePlainSecretEnv`, and `loadSecret`/`loadSecrets`. The file is opened once and checked with fstat on the same descriptor: regular file, no group or world bit, 1 to 16384 bytes, one trailing LF or CRLF stripped, no inner line break, at least 8 characters. Every refusal names the secret only.
- `main.ts` order is now: umask, Redactor and Logger, config, healthcheck return, plain-secret refusal, state directory, `loadSecrets` (log `secrets.loaded` with `names` and `count`), `loadPseudonymKey`, store, server. Plan 02's per-process random key is gone (`grep -c randomBytes relay/src/main.ts` prints 0; `setPseudonymKey` appears once).
- `pseudonymKey.ts`: operator secret gives SHA-256 of it with nothing persisted; otherwise `log-pseudonym.key` (32 bytes, 0600, atomic write) is created once and reused; any other length is a plain `StateDirError` naming `log-pseudonym.key` and `RELAY_STATE_DIR`.
- Tests: `noLeak.test.ts` (8 cases, real relay runs), `secrets.test.ts` (14), `pseudonymKey.test.ts` (6).

## Task Commits

1. **Task 1: tracer, secrets loaded from files and no-leak run** - `cccbdcb` (feat)
2. **Task 2: every secret loader rule as a unit test** - `4628917` (test)
3. **Task 3: stable pseudonym key, wired and proven across restarts** - `b6e26c0` (feat)
4. **Follow-up: exact-sequence startup tests updated for the two new startup events** - `88ab9b6` (test)

**Plan metadata:** committed separately after this summary (docs).

## Verification

All runs inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" ...`.

- Task 1: `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/noLeak.test.js dist/test/startup.test.js'`: 13 tests, 13 pass (5 noLeak at that point, 8 startup).
- Task 2: `... node --test dist/test/secrets.test.js`: 14 tests, 14 pass, 0 skipped.
- Task 3: `... node --test dist/test/noLeak.test.js dist/test/pseudonymKey.test.js`: 14 tests, 14 pass (RED first: `tsc` failed with "Cannot find module '../src/log/pseudonymKey'" before the implementation existed).
- Full relay suite after the last code commit: `NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node npm test --prefix relay`: 147 tests, 147 pass, 0 fail, 0 skipped, 0 cancelled. `npm run lint --prefix relay` clean.
- Acceptance: `grep -c sidecar-volume relay/src/secrets.ts` 3; `grep -c "NEAR_AI_KEY_" relay/src/secrets.ts` 3; `grep -c fstat relay/src/secrets.ts` 1; `grep -rn near-credentials relay/` (excluding node_modules and dist) prints nothing; `git status --porcelain relay/` is empty (no secret or state file tracked).

## Files Created/Modified

- `relay/src/secrets.ts`, `relay/src/log/pseudonymKey.ts` - new
- `relay/src/main.ts` - plain-secret refusal, `loadSecrets`, `loadPseudonymKey`, per-process key removed
- `relay/test/noLeak.test.ts`, `secrets.test.ts`, `pseudonymKey.test.ts` - new
- `relay/test/startup.test.ts`, `schema.test.ts`, `stateDir.test.ts` - exact event-sequence expectations extended

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exact-sequence startup tests from earlier plans broke on the new startup events**
- **Found during:** Task 1 (startup.test) and the first full-suite run in Task 3
- **Issue:** Three earlier tests assert the complete ordered list of log events (port already taken, newer database refused, fresh state directory created). The plan's own new events `secrets.loaded` and `log.pseudonym_key` now precede `relay.listening` and the refusals.
- **Fix:** The expected lists name the two new events in order; the stateDir test finds the `relay.listening` line by event instead of by index. No assertion was removed or loosened; the refusal reasons, details and exit codes are still asserted.
- **Files modified:** `relay/test/startup.test.ts`, `relay/test/schema.test.ts`, `relay/test/stateDir.test.ts`
- **Commit:** `cccbdcb` (startup.test) and `88ab9b6` (the other two, plus the startup case's second event)

### Notes (not deviations)

- Tasks 2 and 3 are `tdd="true"`. Task 2's cases passed on first run because Task 1 already implemented the loader to the plan's full specification; no case needed the implementation loosened. Task 3 had a verified RED (missing module) but no separate RED commit, because a commit that fails `tsc` would break the branch; the tests and implementation share the Task 3 commit.
- `secrets.test.ts` also pins cases the plan did not list: a link to a 0644 file is refused, exactly 16384 bytes loads, a lone newline and a doubled trailing newline are refused, a CREDENTIALS_DIRECTORY without the file falls through.
- The plan said to refuse plain secrets "right after loadConfig"; it is placed after the `--healthcheck` return, as the plan also requires `--healthcheck` to return before all of this.

## Issues Encountered

The first full-suite run (before the three test updates above) failed 3 of 147 for the event-sequence reason described; the final run is green.

## Known Stubs

None.

## Threat Flags

None. T-68-17 (plain env refused before disk, tested end to end), T-68-18 (fstat on the opened descriptor), T-68-19 (messages carry names only; values registered at load; noLeak searches output, bytes and names), T-68-20 (stable HMAC labels, unlabelled before the key exists), T-68-22 (key file atomic 0600, read with O_NOFOLLOW through readPrivateFile, never logged) are mitigated and tested; T-68-21 accepted as planned; T-68-SC held (no package added).

## Next Phase Readiness

Plan 07 (container image) can rely on `TEAMS_APP_SECRET_FILE=/run/secrets/teams_app_secret` and on the relay refusing group-readable secret files (Pitfall 4: the Compose owner fix belongs to that plan). RELAY-04 is not ticked here; the image half is plan 07 and the orchestrator ticks requirements at phase end.

## Self-Check: PASSED

- Created files found: `relay/src/secrets.ts`, `relay/src/log/pseudonymKey.ts`, `relay/test/noLeak.test.ts`, `relay/test/secrets.test.ts`, `relay/test/pseudonymKey.test.ts`.
- Commits found: `cccbdcb`, `4628917`, `b6e26c0`, `88ab9b6` are ancestors of HEAD.

---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 11
subsystem: gate
tags: [policy-bundle, signed-local-store, fail-closed, clock-marker, decision-log, boundary-rule, two-window-race]

requires:
  - phase: 70-10
    provides: "MCP manifests (the last manifest plan); the gate's pure domain (bundle, record, decide) from plans 01 to 07"
provides:
  - "src/gate/bundleStore.ts: GATE_DIR_NAME, POLICY_BUNDLE_FILE, BUNDLE_LOCK_FILE, gateDir, loadPolicyBundle, ensurePolicyBundle, resetPolicyToDefaults, BundleStoreError, BundleEvent, BundleResult"
  - "src/gate/clockMarker.ts: LAST_VALID_SECRET ('nearAi.gate.lastValid'), readLastValid, writeLastValid"
  - "src/gate/decisionLog.ts: DECISIONS_DIR, MAX_DECISION_LOG_BYTES, MAX_ROTATED_FILES, DecisionLog, projectLogKey"
  - "the `gate` import-boundary rule, scan and planted case in teamBoundaries.test.ts"
  - "src/test/helpers/gateBundleChild.ts (fork target for the two-window race)"
affects: [70-12, 70-13, 70-14, 70-15]

actuals:
  tokens: 20267
  tasks: 3
  commits: 3
plan_head_before: 3ef584c6e6d7d3b829a081b271e69cfb6fffd380
plan_head_after: 48adebc8fcb09f1d9e8602188f0b36935b4b33db

tech-stack:
  added: []
  patterns:
    - "Check, sign, write, read back and remember all happen inside one bundle.lock; lock order is bundle.lock, then identity-create.lock, then key-history.lock"
    - "A new bundle is verified in memory before it is written, written through a temp file and a rename, then read back from disk and verified again"
    - "The last-valid marker (SecretStorage) is what tells a fresh install from a policy that was deleted: marker present and file missing is failed-closed, never a fresh start"
    - "A write to the decision log never rejects: one promise chain in the process, one file lock across processes, one report per log"

key-files:
  created:
    - src/gate/bundleStore.ts
    - src/gate/clockMarker.ts
    - src/gate/decisionLog.ts
    - src/test/helpers/gateBundleChild.ts
    - src/test/gateBundleStore.test.ts
    - src/test/gateDecisionLog.test.ts
  modified:
    - src/test/teamBoundaries.test.ts

key-decisions:
  - "Time is a `now?: () => Date` option on every store function (the same shape the key history and identity modules use), not epoch milliseconds"
  - "Signing time is the later of the wall clock and the marker's time (effectiveNow), for the first bundle, a renewal, a re-sign and a reset, so a clock set back never produces a bundle that is already expired; the marker's time is that same value and never moves backwards"
  - "Any failure of loadOrCreateDeviceIdentity during ensure (the store throws, the read-back differs, or the key history refuses a replaced key) is failed-closed identity-unavailable with the error text kept as `detail`; a marker that cannot be read, stored or read back is the same state"
  - "ensurePolicyBundle returns failed-closed for every verification cause and writes nothing; it throws BundleStoreError only when a first or re-signed bundle could not be written to disk. A renewal that fails for any reason leaves the existing valid state (a missed renewal is not a reason to fail closed)"
  - "resetPolicyToDefaults signs and verifies the fresh default in memory first, then renames the old file to policy-bundle.json.replaced-<epoch ms> (a counter suffix when the name is taken), writes the new file and puts the old file back if the write fails"
  - "DecisionLog.append returns a promise that never rejects (the plan says it returns void and never throws or rejects; a promise lets a test or a shutdown wait, a decision never needs to), plus flush(); onWriteFailure is required so a caller cannot forget it"
  - "metadata.sequence is set by the log, from 1, continuing from the last line of the file (or of <key>.1.jsonl after a rotation), and re-read under the lock whenever the file size is not what this process last wrote, so a second window keeps it strictly increasing"

requirements-completed: [OFFL-01, OFFL-02, OFFL-03, GATE-07]

duration: one session
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 11: The policy bundle and the decision log on disk Summary

**A fresh install now signs, writes, reads back and verifies its own first policy bundle with no network and no setup, every later activation either verifies it, renews it in its last 30 days or fails closed with a plain sentence and leaves the file untouched, and gate decisions can be appended as redacted, ordered, rotating JSON lines per project in global storage that never block a decision.**

## Performance

- **Tasks:** 3 of 3 (Task 1 tracer, Tasks 2 and 3 auto with tdd)
- **Files:** 6 created, 1 modified (1,420 insertions, 3 deletions over the plan's commits)
- **Tracer gate:** the Task 1 verify command was green end to end before Task 2 started, so the tracer gate passed (auto-continue)

## Accomplishments

- `ensurePolicyBundle`: the only silent creation is a true fresh install (no file and no marker). It creates the device identity if needed, signs `defaultBundlePayload` under the purpose `policy-bundle`, writes it, reads it back, verifies it with `localKeyStatus`, stores the marker and returns `policy.created`.
- Fail closed on every cause with the domain's own sentence and the file bytes unchanged (asserted): missing (marker present), unparseable, too-large, malformed (unsigned), bad-signature, wrong-purpose, key-revoked, key-rotated, expired, clock-behind, unknown-key (customised bundle), identity-unavailable. A damaged marker still counts as present, so it never reads as a fresh install.
- Renewal in the last 30 days only when this install's own key signed the bundle, with fresh dates and the event `policy.renewed`; 31 days left changes nothing; a bundle that does not verify is never renewed.
- A lost device key with a never-customised bundle is re-signed with the new identity and the event `policy.resigned-default`; a customised one fails closed as `unknown-key` and the person is told to reset (D-39).
- `resetPolicyToDefaults` keeps the old file beside the new one as `policy-bundle.json.replaced-<epoch ms>` and returns `policy.reset`; a store failure throws `BundleStoreError` with the old file still in place.
- A time marker that never moves backwards (D-15): a marker time after the bundle's expiry keeps it expired when the wall clock says earlier.
- Two forked windows on one fresh storage folder and one shared secret file end with one identity key, one `created` history record, one bundle and the same hash in both, and exactly one `policy.created`.
- `DecisionLog`: one line per record at `<globalStorage>/gate/decisions/<32 hex project key>.jsonl`, redacted and validated first, sequence 1, 2, 3 in order even when the caller does not wait, whole-file rotation to `<key>.1.jsonl` with at most 4 kept, an empty `resources` array accepted, a write failure reported once with a plain message and never rejected, a constructor that refuses a storage folder inside the project root and any key that is not a 32 character hash.
- `teamBoundaries.test.ts`: the `gate` rule (allows `gate`, `domain`, `team`, the type-only `services/auth` and `services/stateMirrorLock`), a scan of `src/gate` with a minimum of 3 files, and a planted case that reports vscode, a package, an editor service, a value import of auth and an agent import.

## Task Commits

1. **Task 1 (tracer): a fresh install signs and verifies its first bundle** - `badef25` feat(gate): sign and verify the first policy bundle on a fresh install
2. **Task 2: fail closed on every cause, renew and recover only when safe, two windows** - `8237d7a` feat(gate): fail closed on any bad policy file, renew and recover only when safe
3. **Task 3: the decision log in full** - `48adebc` feat(gate): an append-only, redacted, rotating decision log in global storage

**Plan metadata:** the commit that adds this SUMMARY.

## Verification

Each run inside the cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

- Task 1 plan command (`npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateBundleStore.test.js dist/test/teamBoundaries.test.js dist/test/teamIdentity.test.js`): tsc clean; 32 tests, 32 pass, 0 fail, 0 cancelled.
- Task 2 plan command (`... node --test --test-concurrency=1 dist/test/gateBundleStore.test.js dist/test/teamKeyHistory.test.js dist/test/teamKeyRotation.test.js`): tsc clean; 72 tests, 72 pass, 0 fail, 0 cancelled. gateBundleStore has 31 tests (the plan asks for at least 14).
- Task 3 plan command (`... node --test --test-concurrency=2 dist/test/gateDecisionLog.test.js dist/test/gateRecords.test.js dist/test/gateBundleStore.test.js dist/test/teamBoundaries.test.js`): tsc clean; 61 tests, 61 pass, 0 fail, 0 cancelled.
- Acceptance: `git ls-files src/gate` lists exactly 3 paths; `git diff cbe4ef3 HEAD -- src/services/auditStore.ts` is empty; the tampered-file test asserts the file's bytes are unchanged after `ensurePolicyBundle`; the failure-once test is in gateDecisionLog. The full `npm test` and e2e are not run here (PR boundary; the plan does not call for them).
- No test touches the real global storage, SecretStorage or home folder (temp folders, in-memory and file-backed test secret stores).

## Deviations from Plan

**1. [Order, no behaviour change] The full `ensurePolicyBundle` and `clockMarker` landed in the Task 1 commit.**
- **Found during:** Task 1. The fresh-install path, the verify path and the failure causes share one function, so splitting them across two commits would have meant writing the function twice. Task 1 therefore committed the whole bundle store; the Task 2 commit adds the child helper and the tests for every behaviour in its list (31 tests in total, each run and green). Task 2's `files_modified` lists `bundleStore.ts` and `clockMarker.ts`; neither changed in the Task 2 commit.
- **Commits:** badef25, 8237d7a

**2. [Rule 2 - Missing critical] `DecisionLog.append` returns `Promise<void>` (never rejects), not `void`, and `flush()` exists.** The plan says append "returns `void` and never throws or rejects". A promise that never rejects keeps every guarantee for a caller that ignores it, and lets tests and a shutdown wait for the last line. `onWriteFailure` is a required option so a caller cannot forget to wire the report; `projectRoot` is an optional option that makes the constructor refuse a storage folder inside the project. Commit 48adebc.

**3. [Rule 2 - Missing critical] Cross-window sequence.** The plan says the sequence strictly increases per log; a per-process counter would repeat numbers when two windows share one project. Each append takes `<key>.lock`, reads the file size and, when it is not what this process last wrote, re-reads the last line (or the last line of `<key>.1.jsonl`) to continue the numbering. Tested with two `DecisionLog` objects on one file. Commit 48adebc.

**4. [Note] Task 1's test constructs the `DecisionLog` with the now-required `onWriteFailure`.** Edited in the Task 3 commit; no assertion changed.

**Total deviations:** 4 (1 order note, 2 missing-critical additions, 1 note). **Impact:** none on the plan's must-haves; every truth in the plan has a test.

## Assertions changed on purpose

None. The only edit to an existing test file is `teamBoundaries.test.ts`: the header comment, the new `gate` rule, one new scan test and one new planted-case test, plus the folder choice in `boundaryViolations` (`gate/` files use the gate rule). Every existing assertion in it passes unchanged.

## Decisions Made

See key-decisions. Left for later plans (nothing here is wired into the extension yet, so no current code path changes):

- Plan 12 and the activation wiring must call `ensurePolicyBundle` once at activation, record the returned `event` (`policy.created`, `policy.renewed`, `policy.resigned-default`, `policy.reset`) through the `DecisionLog`, and call `loadPolicyBundle` when it needs the state without side effects. A `resigned-default` replaces the old file in place (the old bytes are not kept, unlike a reset), because the stored bytes equal the shipped default by definition.
- D-48 stays open and is not something this plan can close: no release carrying `identity-unavailable` is published until the owner has shown that a fresh code-server profile creates the identity, signs its first bundle and stays usable (a chat and one edit). The check belongs in PR 2's body (plan 15) and in 70-VALIDATION.md.
- Flagged assumption from the plan (OFFL-02 edges) is unchanged: only the causes listed in the must-haves plus the fresh-install and two-window cases are covered.
- Carry-forward from earlier plans is untouched by this plan: manifests name raw call arguments, effects come from `tool.manifestInput?.(raw) ?? raw`; MCP tools must be decided from effects and contexts, not `McpToolEffects.shorthand`; folder-path coverage in gate path matching is still open (70-08).

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None new. T-70-33 and T-70-34 (deleting or editing the bundle): the marker makes a missing file failed-closed `missing`, a changed one `bad-signature`, and both leave the file untouched (bytes asserted). T-70-35 (two windows): `bundle.lock` around check, sign, write and read back, `identity-create.lock` inside; the fork test ends with one key, one history record and one hash. T-70-36 (a broken disk or keyring): `identity-unavailable` fails closed to reading and planning with its sentence, and a decision-log write failure is reported once and never rejected. T-70-37 (records in the project or synced state): records only under `<globalStorage>/gate/decisions`, a hashed project key, redaction first, and the constructor refuses a storage folder inside the project root. T-70-SC: no package added.

## Self-Check: PASSED

- Files exist: src/gate/bundleStore.ts, src/gate/clockMarker.ts, src/gate/decisionLog.ts, src/test/helpers/gateBundleChild.ts, src/test/gateBundleStore.test.ts, src/test/gateDecisionLog.test.ts.
- Commits are on feat/gate-shadow: badef25, 8237d7a, 48adebc.
- All three task verify commands passed (totals above); acceptance criteria re-checked.

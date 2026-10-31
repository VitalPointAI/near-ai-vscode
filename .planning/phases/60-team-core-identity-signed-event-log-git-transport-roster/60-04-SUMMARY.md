---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 04
subsystem: team
tags: [validation, schema, exact-keys, policy, basis-points, email-hash]

requires:
  - phase: 60-01
    provides: "types.ts contracts, canonical JSON, fingerprintOf, eventPath and snapshotPath, defaultTeamPolicy"
provides:
  - "parseEventFile: one committed file becomes an event or a fixed rejection (size, JSON, canonical bytes, envelope, body, file name)"
  - "validateEnvelope, validateBody (exact-key schemas for the ten Phase 60 types), validateDeviceRef, validateName and the id, key, hash and path patterns"
  - "validatePolicy, validatePolicyChanges and applyPolicyChanges in policy.ts"
affects: [60-05, 60-06, 60-07, 60-08, 60-09, 60-10, 60-11]

actuals:
  tokens: 12400
  tasks: 2
  commits: 2
plan_head_before: d1f3c86d2b532b5419dde6470086f4ffcff31a99
plan_head_after: c3c7493411ce6bdf6ce43e9316e112186dc11346

tech-stack:
  added: []
  patterns:
    - "Validators return the full rejection reason or undefined; the first failing check decides the reason"
    - "Lazy ?? chains over per-field validators, one body table keyed by event type (Record type makes a missing type a compile error)"
    - "Policy checks in a Record keyed by every TeamPolicy key, so adding a policy field without a validator fails to compile"
    - "Parsed input is validated in place and never spread or assigned into a new object"

key-files:
  created:
    - src/domain/team/validate.ts
    - src/test/teamValidate.test.ts
  modified:
    - src/domain/team/policy.ts

key-decisions:
  - "Reasons are 'invalid event body: <path>' with the path cut to a safe alphabet and 120 characters, because extra key names come from untrusted files"
  - "validatePolicy and validatePolicyChanges take an optional path prefix (policy, changes by default) so validate.ts reports body.policy.<field> and body.changes.<field>"
  - "Rejection event id is the parsed id when it matches the event id pattern, otherwise the file path (also for size and JSON failures, where nothing was parsed)"
  - "The size gate checks both entry.size and the text byte length, so an oversized blob whose text the transport skipped is still rejected"
  - "Policy path strings reject control characters and backslashes in addition to the plan's rules (no leading slash, no .. segment); verify commands reject control characters"
  - "Working hours do not require start before end, so overnight shifts remain valid"

patterns-established:
  - "Exact-key helper checkKeys(value, path, required, optional) returns the offending path for a missing or extra key"
  - "Body schemas are pinned by a generic loop (extra key, missing key, wrong type, null) over all ten types plus targeted cases per rule"

requirements-completed: []

coverage:
  - id: D1
    description: "parseEventFile rejects oversized, unparseable, non-canonical (duplicate key, whitespace, float, exponent), misnamed and unsupported files with the fixed reasons, and accepts a valid signed event"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamValidate.test.ts#file level gates: size, JSON, canonical bytes"
        status: pass
      - kind: unit
        ref: "src/test/teamValidate.test.ts#a path that disagrees with the lamport or id is rejected after the body checks"
        status: pass
    human_judgment: false
  - id: D2
    description: "Unknown versions and types always get 'unsupported event type for this version', checked before any other envelope field"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamValidate.test.ts#unknown versions and types always get the update-the-app reason, even with other errors"
        status: pass
    human_judgment: false
  - id: D3
    description: "All ten bodies have exact-key schemas: extra, missing and wrongly typed fields are rejected by field name; members carry emailHashes only and device fingerprints must equal the hash of their key"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamValidate.test.ts#every body rejects extra keys, missing keys and wrong types by field name"
        status: pass
      - kind: unit
        ref: "src/test/teamValidate.test.ts#members carry email hashes only, and device fingerprints must match their key"
        status: pass
    human_judgment: false
  - id: D4
    description: "Policy validation accepts only TeamPolicy keys with integer basis points, bounded strings and arrays, weights summing to 10000; policy.changed needs at least one valid key; applyPolicyChanges returns a new object"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamValidate.test.ts#validatePolicy accepts the default policy and rejects each kind of bad field"
        status: pass
      - kind: unit
        ref: "src/test/teamValidate.test.ts#validatePolicyChanges needs at least one valid known key; applyPolicyChanges returns a new object"
        status: pass
    human_judgment: false
  - id: D5
    description: "A __proto__ key in a committed file is rejected by exact-key validation and the global prototype stays untouched"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamValidate.test.ts#a __proto__ key is rejected by exact keys and never reaches a trusted object"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-10-31
status: complete
---

# Phase 60 Plan 04: Event schema validation Summary

**Every committed event file now passes through `parseEventFile`, which rejects oversized, malformed, non-canonical, unsupported, misnamed or wrongly shaped files with fixed reasons, and the ten Phase 60 bodies and the integer basis-point policy have exact-key schemas pinned by 19 tests.**

## Performance

- **Duration:** about 20 min
- **Completed:** 2026-10-31T13:15:00Z
- **Tasks:** 2
- **Files:** 2 created, 1 modified

## Accomplishments

- `parseEventFile(entry)` runs the D-09 step 1 order: size (entry size and text bytes, 16 KB), `JSON.parse` inside try/catch, `canonicalize` equality with the stored text (duplicate keys, whitespace, `7.0`, `7e0` and floats all fail), `validateEnvelope`, `validateBody`, then `entry.path === eventPath(event)`.
- `validateEnvelope` checks version and type first, so any `v` other than 1 or any type outside the ten implemented types (including known-but-later types like `item.created`) gets exactly `unsupported event type for this version`, even when other fields are also wrong. After that: exact keys, then id, teamId, author, device, prev, at, lamport (1 to 999999999999), strict 64-byte base64url signature, and a plain-object body.
- `BODY_VALIDATORS` is a `Record<ImplementedEventType, ...>` with the D-31 shapes: `team.created` carries `ownerEmailHashes`, `member.joined` carries `emailHashes` (0 to 8 unique, 64 lowercase hex), no plain email field exists anywhere, and a device whose fingerprint is not `fingerprintOf(publicKey)` fails with `body.device.fingerprint`. Names, working hours, skills, near link and snapshot path/hash rules follow the plan table.
- `policy.ts` gained a `POLICY_CHECKS` record keyed by every `TeamPolicy` field. `validatePolicy` requires the full key set, `validatePolicyChanges` requires at least one valid known key (own-property lookup, so `__proto__` and `constructor` are rejected), and `applyPolicyChanges` deep-clones into a new object.

## Task Commits

1. **Task 1: Envelope validator and parseEventFile** - `0a7007b` (feat, includes the 8 envelope and file tests)
2. **Task 2: Exact-key body validators and policy validators** - `c3c7493` (feat, adds 11 body and policy tests)

**Plan metadata:** the docs commit that adds this file and the STATE and ROADMAP updates.

## Files Created/Modified

- `src/domain/team/validate.ts` - patterns, envelope, body and device validators, `parseEventFile`
- `src/domain/team/policy.ts` - policy field validators and `applyPolicyChanges` (defaults unchanged)
- `src/test/teamValidate.test.ts` - 19 schema tests

## Decisions Made

See `key-decisions` above. The load-bearing one for later plans: validators return the complete reason string, and `parseEventFile` rejections use the parsed event id when it matches the id pattern, otherwise the file path.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] RED and GREEN committed together per task**
- **Issue:** Each task is one new module plus its test file; tests and implementation were written in the same working session and committed once per task instead of as separate RED and GREEN commits. Tests were written against the specified behaviour first, and the only failures seen were test-side mistakes (an assumption about `size` alone failing a parse, a duplicate-key replace that matched nothing, a wrong-type value that happened to be a valid lamport); no assertion was weakened.
- **Commits:** `0a7007b`, `c3c7493`

**2. [Rule 3 - Blocking] Regex literal with U+2028 and U+2029**
- **Issue:** The edit tooling turned the ` ` and ` ` escapes into literal characters, which end a regex literal and broke the compile.
- **Fix:** Restored the escapes in `CONTROL_CHARACTERS` in both files; tests build the separators with `String.fromCharCode`.

**3. [Rule 2 - Missing critical] Slightly stricter policy path rules**
- Policy path lists also reject control characters and backslashes, and verify commands reject control characters, so a signed policy cannot carry line breaks or Windows-style absolute paths. Defaults and the plan's cases are unaffected.

**Total deviations:** 1 process note, 1 tooling fix, 1 extra guard. **Impact:** none on the specified behaviour.

## Issues Encountered

- The plan-commit ledger file under the worktree git directory could not be written (the write was denied by the sandbox), so `plan_head_before` was taken from the known HEAD at start (`d1f3c86`, the 60-03 docs commit) and `commits: 2` was measured with `git rev-list --count d1f3c86..HEAD` after the second task commit.
- Full `npm test` was not run in this plan (the full suite runs at the phase boundary). The team family `node --test dist/test/team*.test.js` passes 196 of 196.

## Known Stubs

None. The interim `validateBody` branch from Task 1 was replaced by the full table in Task 2.

## Threat Flags

None beyond the plan's threat model. T-60-17 to T-60-20 are mitigated and tested; no package installs; `package.json` is unchanged.

## Self-Check

- `src/domain/team/validate.ts`, `src/domain/team/policy.ts`, `src/test/teamValidate.test.ts` exist; commits `0a7007b` and `c3c7493` are ancestors of HEAD.
- `npm run lint` clean. `node --test dist/test/teamValidate.test.js dist/test/teamCanonical.test.js` 29 of 29; `node --test dist/test/team*.test.js` 196 of 196.
- Acceptance greps hold: `MAX_EVENT_BYTES` and `TEAM_REJECTION_REASONS.unsupported` present, no `Object.assign` or `...parsed`, no `vscode` import, no `emails` or `ownerEmails` key accepted, `emailHashes` and `ownerEmailHashes` present, `10000` present in policy.ts, `validatePolicy(defaultTeamPolicy())` prints `undefined`.

## Self-Check: PASSED

## Next Phase Readiness

60-05 can import `parseEventFile`, `validateBody`, the patterns and the policy helpers. Reasons for authorisation and reference checks (member exists, device bound, and so on) are not in this layer by design; they belong to the materializer.

---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 06
subsystem: team
tags: [team-json, untrusted-input, trust-pin, atomic-write, audit-mirror, secret-refusal]

requires:
  - phase: 60-01
    provides: "TeamFile and Role types, canonicalize, signEvent and the test owner harness"
  - phase: 60-02
    provides: "assertNoSecrets and SecretLeakError"
  - phase: 60-04
    provides: "TEAM_ID_PATTERN, EVENT_ID_PATTERN, AT_PATTERN, validateDeviceRef, validateName"
provides:
  - "parseTeamFile, readTeamFile, serialiseTeamFile, canonicalTeamFile, writeTeamFile: team.json validated as attacker-influenced input (D-21)"
  - "checkTrustPin: trust on first use for team id, genesis event id and owner fingerprint (D-10 hardening)"
  - "teamStorageDir with team id validation, runSerialised and writeFileAtomic helpers"
  - "team-roster audit type and mirrorRosterEvents with deterministic ids and a persisted high-water mark (D-26)"
affects: [60-07, 60-08, 60-09, 60-10, 60-11]

actuals:
  tokens: 11550
  tasks: 2
  commits: 4
plan_head_before: 1cf01ab711c739a0d0401736dadb39cbd936f23a
plan_head_after: 06f94fab8149f5055fff662996404e9efad9fd85

tech-stack:
  added: []
  patterns:
    - "Untrusted file input: exact keys at every level, patterns for every value, result object rebuilt field by field, refused values never echoed in messages"
    - "Per-path promise queue plus temp-file-then-rename; cleanup failures ride along as the error cause instead of being swallowed"
    - "Audit mirror builds and secret-checks every entry before appending any, then advances a file-backed high-water mark"

key-files:
  created:
    - src/team/teamFile.ts
    - src/team/auditMirror.ts
    - src/test/teamFile.test.ts
    - src/test/teamAudit.test.ts
  modified:
    - src/domain/approval.ts
    - src/services/auditStore.ts

key-decisions:
  - "team.json refuses any extra key (including policy), so the signed log stays the only source of policy"
  - "Ref components starting with a dot or ending in .lock are refused in addition to the planned .. , // and trailing .lock rules, because git can never create such a branch"
  - "Mirror checks all new entries with assertNoSecrets before appending any, so a refusal leaves the audit file untouched"
  - "A corrupt or unreadable trust.json or audit-mark.json fails closed with a plain error rather than resetting"

patterns-established:
  - "runSerialised(key, task) and writeFileAtomic(file, text) in teamFile.ts are the shared serialised atomic write path for Team Mode state files"
  - "Test edits to a team file go through a typed loose Doc view, no any"

requirements-completed: [SEC-01, TEAM-01]

coverage:
  - id: D1
    description: "team.json is parsed and written as validated untrusted input: exact keys, remote and ref patterns, bound owner device, no policy, secrets refused, serialised atomic writes"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/test/teamFile.test.ts (18 tests via node --test dist/test/teamFile.test.js)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Local trust pin records team id, genesis event id and owner fingerprint on first sight and refuses later changes"
    requirement: "TEAM-01"
    verification:
      - kind: unit
        ref: "src/test/teamFile.test.ts#the trust pin is written on first sight, matches afterwards and refuses a changed team, genesis or owner key"
        status: pass
    human_judgment: false
  - id: D3
    description: "Accepted roster events are mirrored into AuditStore as team-roster entries once, with member attribution and no secrets"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/test/teamAudit.test.ts (15 tests incl. unchanged auditStore.test.ts)"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 06: team.json and roster audit mirror Summary

**team.json parsed as hostile input (exact keys, git-safe remote and ref, bound owner key) with secret refusal, serialised atomic writes and a local trust pin, plus an idempotent team-roster audit mirror with a persisted high-water mark**

## Performance

- **Duration:** 5 min
- **Started:** 2026-11-01T12:38:14Z
- **Completed:** 2026-11-01T12:43:00Z
- **Tasks:** 2
- **Files modified:** 6 (4 created, 2 one-line edits)

## Accomplishments
- `parseTeamFile` refuses invalid JSON, a newer version (with an update message), any extra key at any level (so no policy), option-like or slash remotes, refs outside `refs/heads/` and `refs/near-ai/` or containing `..`, `//`, a dot-leading or `.lock` component, a fingerprint that does not match its public key, and bad timestamps. Messages name the field, never the offending value.
- `writeTeamFile` runs `assertNoSecrets` first, round-trips through the parser, then writes inside a per-path promise queue with temp-file-then-rename. A failed rename (tested with a non-empty directory in place of the file) rejects and leaves no temp file; concurrent writes land in call order.
- `checkTrustPin` stores team id, genesis event id and owner fingerprint in `trust.json` on first sight and throws `TrustPinError` on any change; a corrupt pin fails closed. Concurrent first sights agree because the check runs inside the same queue.
- `team-roster` is now an accepted `AuditEventType` (one literal in `approval.ts`, one in `auditStore.ts`); `auditStore.test.ts` is unchanged and green.
- `mirrorRosterEvents` mirrors only the eight roster types above the stored mark, with ids `audit-team-<16 hex>`, timestamp equal to the event time, `projectId` equal to the team id and metadata limited to event type, event id, lamport, author id, optional role and optional subject id. It stays idempotent across restart, a lost mark and the audit store's 500-entry cap.

## Task Commits

1. **Task 1: team.json validated input, atomic writes, trust pin** - `bb45140` (feat), `16712d3` (test)
2. **Task 2: team-roster audit type and mirror** - `c1e5a2a` (feat), `06f94fa` (test)

**Plan metadata:** recorded in the following docs commit.

## Files Created/Modified
- `src/team/teamFile.ts` - team.json parse, read, serialise, canonical copy, atomic write, storage path, trust pin, shared `runSerialised` and `writeFileAtomic`
- `src/team/auditMirror.ts` - roster audit types, id and event builders, `mirrorRosterEvents`, file-backed `MirrorMark`
- `src/domain/approval.ts` - `AuditEventType` gains `'team-roster'`
- `src/services/auditStore.ts` - `isAuditEventType` accepts `'team-roster'`
- `src/test/teamFile.test.ts` - 18 tests
- `src/test/teamAudit.test.ts` - 12 new tests (plus the 3 existing auditStore tests run alongside)

## Decisions Made
- Extra ref hardening (dot-leading or `.lock` components) beyond the plan, matching git's own rules.
- All new audit entries are secret-checked before any append so a refusal is all-or-nothing for the audit file.
- Corrupt trust or mark files raise errors instead of resetting to defaults.

## Deviations from Plan

None - plan executed exactly as written. (Two additive hardening choices above stay inside the planned files and behaviour.)

## Issues Encountered

None.

## Known Limitations

- `AuditStore.persist` swallows write failures by design (existing best-effort behaviour, outside this plan's one-literal edit rule). If its disk write fails, the mirror can advance its mark past entries that were not persisted. Plan 60-09, which wires the session, may want a persistence check or a store that reports failure.
- The trust pin is bounded by who can write the local global storage; team.json edits by code-branch writers are caught only after first sight (documented honest limit, T-60-27).

## Known Stubs

None.

## Threat Flags

None. No new network surface; the new files are local state under project and global storage and are covered by T-60-27 to T-60-31.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 60-08 (Enable) can call `writeTeamFile`, `canonicalTeamFile` for the genesis copy, `teamStorageDir` and `checkTrustPin`.
- 60-09 (session) can call `mirrorRosterEvents` with `fileMirrorMark(teamStorageDir(...))` and the materialised state's `roleOf`.

## Self-Check: PASSED

- Files present: `src/team/teamFile.ts`, `src/team/auditMirror.ts`, `src/test/teamFile.test.ts`, `src/test/teamAudit.test.ts`.
- Commits present on this branch: `bb45140`, `16712d3`, `c1e5a2a`, `06f94fa`.
- Plan verification: `npm run lint` exit 0; `node --test dist/test/teamFile.test.js dist/test/teamAudit.test.js dist/test/auditStore.test.js` 33 tests pass, 0 fail; adjacent suites (approvalService, activity*, teamSecrets, teamValidate, teamMaterialize) 132 tests total pass.
- Acceptance criteria re-run: assertNoSecrets and rename greps match, no empty catch or swallowed promise in teamFile.ts, no vscode import in either module, numstat for `approval.ts` and `auditStore.ts` is 1/1 each, `auditStore.test.ts` unchanged against the merge base.

---
*Phase: 60-team-core-identity-signed-event-log-git-transport-roster*
*Completed: 2026-11-01*

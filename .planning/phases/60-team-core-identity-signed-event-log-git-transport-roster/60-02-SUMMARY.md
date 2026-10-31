---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 02
subsystem: team
tags: [permissions, rbac, secret-detection, pure-domain]

requires:
  - phase: 60-01
    provides: team type contracts (Role, TeamPolicy, Member, ImplementedTeamEvent) and defaultTeamPolicy
provides:
  - "decideTeamAction: the single role-by-action decision for the whole spec 6.3 matrix (27 actions x 5 roles) with owner and lead overrides"
  - "actionForEvent: maps the eight non-genesis Phase 60 event types to matrix actions so write and read run the same decision"
  - "assertNoSecrets, findSecrets, SecretLeakError, SECRET_PATTERNS: write-side secret refusal that never echoes the value"
affects: [60-05, 60-06, 60-07]

actuals:
  tokens: 9923
  tasks: 2
  commits: 4
plan_head_before: 0f385a22ebbb083c558461113a6bda32d5ecfd98
plan_head_after: 95e4e2f121f8eb4ab23b1d1bcd406cb95da00f73

tech-stack:
  added: []
  patterns:
    - "Permission matrix as frozen data plus a small evaluator; overrides applied only after the cell allows"
    - "Secret detection by difference: reuse redactSecrets(s) !== s without editing redaction.ts"
    - "Explicit-stack walker with a depth cap, JSON-style paths, no matched text in any output"

key-files:
  created:
    - src/domain/team/permissions.ts
    - src/domain/team/secrets.ts
    - src/test/teamPermissions.test.ts
    - src/test/teamSecrets.test.ts
  modified: []

key-decisions:
  - "Cell first, overrides second: an actor whose role never allows an action gets the generic role denial; the specific owner reasons only appear for actors who would otherwise be allowed"
  - "member.skills uses the self-or-manager rule for every role, device.add and device.revoke use self for developer, reviewer and observer"
  - "Token patterns use a letter-or-digit lookbehind instead of \\b so an underscore prefix like token_rt_xxxx is still caught"
  - "A key that looks like a secret is reported as '<parent> key name' and its children use '[key]' so the key text never appears in a path"

patterns-established:
  - "Fixed PERMISSION_REASONS strings plus a per-rule suffix for conditional cells, asserted verbatim by tests"
  - "Test canaries built at run time from randomBytes; only bare prefixes appear in test source"

requirements-completed: [SEC-04, SEC-01]

coverage:
  - id: D1
    description: "Every cell of the spec 6.3 matrix, including both policy-dependent cells, is asserted per role"
    requirement: SEC-04
    verification:
      - kind: unit
        ref: "src/test/teamPermissions.test.ts#matrix: *"
        status: pass
    human_judgment: false
  - id: D2
    description: "Owner protections: no second owner, no self role change, lead cannot act on the owner or the owner's devices, owner cannot be removed, removed members denied everything"
    requirement: SEC-04
    verification:
      - kind: unit
        ref: "src/test/teamPermissions.test.ts#a lead cannot add or revoke a device of the owner (D-32) but the owner can"
        status: pass
    human_judgment: false
  - id: D3
    description: "assertNoSecrets refuses every D-23 shape, exempts only strict key material, and never echoes the value"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "src/test/teamSecrets.test.ts"
        status: pass
    human_judgment: false

duration: 14min
completed: 2026-10-31
status: complete
---

# Phase 60 Plan 02: Permission matrix and secret refusal Summary

**One pure `decideTeamAction` implementing the whole spec 6.3 role-by-action matrix as frozen data with the owner and device overrides, plus a write-side `assertNoSecrets` that refuses D-23 secret shapes by pattern and by `redactSecrets` difference without ever echoing a value.**

## Performance

- **Duration:** about 14 min
- **Tasks:** 2 (both TDD)
- **Files:** 4 created, 0 modified

## Accomplishments

- `PERMISSION_MATRIX` has 27 action kinds and five roles each, written in spec column order so it can be diffed against 6.3. Policy cells read `peerMetricsVisible` and `developerMayIntegrate`; conditional cells read the action (`ownDraft`, `itemKind`, `ownWork`, `withinTeamBudget`, `memberId`).
- Overrides: one owner and no transfer, no self role change, a lead cannot change or remove the owner or add or revoke an owner device (D-32), the owner cannot be removed, unknown actors and removed members are denied everything, policy change by a non-owner gives exactly `only the owner can change team policy`.
- `actionForEvent` returns the mapped action for the eight non-genesis types and `undefined` for `team.created` and `member.joined`.
- `findSecrets` returns JSON-style paths only. 2000 generated Ed25519 public keys and signatures under `publicKey` and `sig` produce no findings; PKCS#8 and PEM material under those keys is always reported.
- 57 permission tests and 30 secret tests pass; `redaction.ts` and `package.json` are unchanged.

## Task Commits

1. **Task 1: decideTeamAction and actionForEvent** - `c2532ce` (feat), `f8a3aa8` (test)
2. **Task 2: findSecrets and assertNoSecrets** - `619069b` (feat), `95e4e2f` (test)

## Decisions Made

See frontmatter. The cell-before-override order means a developer trying to remove the owner sees the generic role denial, while a lead sees `a lead cannot act on the owner`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Em-dash character in a test source line**
- **Found during:** Task 2 final grep
- **Issue:** The dash check in `teamPermissions.test.ts` contained literal dash characters, against the no-em-dash rule.
- **Fix:** Replaced with an escaped regex `/[–—]/`.
- **Files modified:** `src/test/teamPermissions.test.ts`
- **Commit:** `95e4e2f`

**2. [Interpretation] Test and source committed in separate commits, source first**
- Committing a test-only RED commit would break `tsc` for that commit (the module does not exist yet), so the red run was done locally and each task has a `feat` commit then a `test` commit, matching plan 60-01.

**Total deviations:** 1 auto-fixed, 1 note. **Impact:** none on behaviour.

## Issues Encountered

None. The team family ran 150 of 150 (`node --test dist/test/team*.test.js`). The full repository suite was not run here; it is a phase-boundary check.

## Known Stubs

None.

## Threat Flags

None. No new trust boundary; T-60-06 to T-60-09 are mitigated and tested.

## Residual Risk

- A secret that has exactly the shape of a public key (43 base64url characters) or signature (86 characters) and sits under a key named `publicKey` or `sig` is exempt from the token patterns. This is the documented trade-off that keeps random key material from tripping them; the materialiser in 60-05 must validate device keys (fingerprint bound to the key), which makes such a value useless as a hiding place. A test locks the exemption to the exact key names and lengths.
- The `Bearer` rule also fires on ordinary prose such as "bearer of bad news", because `redactSecrets` already treats `bearer <word>` as a secret. Writes refuse; the user can reword.

## Self-Check

- All 4 created files exist; commits `c2532ce`, `f8a3aa8`, `619069b`, `95e4e2f` are ancestors of HEAD.
- `npm run lint` clean; matrix check prints `27 true`; no vscode import, no `any`, no empty catch, no dash characters in the new files.

## Self-Check: PASSED

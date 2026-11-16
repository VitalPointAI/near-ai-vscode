---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 01
subsystem: gate
tags: [capability-vocabulary, pure-domain, canonical-json, boundary-test, glob]

requires:
  - phase: 60-team-mode
    provides: "src/domain/team/canonical.ts (canonicalize) and secrets.ts (findSecrets), the hostile-prototype validation pattern"
provides:
  - "Capability vocabulary v1 in src/domain/gate/vocabulary.ts: sixteen closed verbs, integer-only spend, reserved gpu, parseCapability, parsePathPattern, parseHostPattern, fromActionCapability"
  - "src/domain/gate/shape.ts: closed GATE_SHAPE_FAILURES list and the exact-key helpers"
  - "src/domain/glob.ts: globToRegExp and matchesGlob, with src/agent/glob.ts re-exporting them"
  - "domain/gate import boundary rule and scan in teamBoundaries.test.ts"
affects: [70-02, 70-03, 70-05, 70-06, 70-08, 70-09]

actuals:
  tokens: 14000
  tasks: 2
  commits: 2
plan_head_before: 5070c55b3a587a414e655d2f9692377117b66a2a
plan_head_after: 6ae399dc7531f2bffd80796a3e346f65f0afd7f1
commits: 2

tech-stack:
  added: []
  patterns:
    - "Closed grammar: every unknown verb, field or version is refused with one plain reason from a fixed list, never ignored"
    - "Validate in place with Object.keys and own-property reads; build a new frozen object from validated fields, never spread"
    - "Pure folder guarded by a boundary test with a planted-violation case"

key-files:
  created:
    - src/domain/gate/shape.ts
    - src/domain/gate/vocabulary.ts
    - src/domain/glob.ts
    - src/test/gateVocabulary.test.ts
  modified:
    - src/agent/glob.ts
    - src/test/teamBoundaries.test.ts

key-decisions:
  - "sharedWrite maps to skill.write{scope: team} plus the floor marker floor.shared-write (recorded refinement of D-04's example): the shared team knowledge store is outside the project, which a project-relative PathPattern cannot name; the floor's ask is unchanged"
  - "A useSecret handle must match CREDENTIAL_HANDLE_PATTERN and must not look like a secret to findSecrets; the pattern alone accepts sk-live-abc, so the plan's required refusal needed the second check"
  - "infer provider and model accept a lone * in a ceiling, because the mediaGeneration shorthand knows neither"

patterns-established:
  - "parseCapability(value, { vocabulary, mode }) with mode request (concrete) or ceiling (wildcards allowed where the grammar says)"
  - "Frozen canonical vectors as literal strings in gateVocabulary.test.ts, one per verb"

requirements-completed: [GATE-01]

duration: about 35 min
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 01: Capability vocabulary v1 Summary

**A closed, versioned, integer-only capability grammar (sixteen verbs, reserved gpu) in a pure `src/domain/gate` folder that a boundary test keeps free of vscode, packages and agent code, with the glob matcher moved under `src/domain` and today's nine shorthands mapped into it one way.**

## Performance

- **Duration:** about 35 min (start time was not captured at the start of the run, so this is an estimate)
- **Completed:** 2026-11-16
- **Tasks:** 2
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments

- `parseCapability` covers all sixteen verbs (`read`, `plan`, `workspaceWrite`, `shell`, `network`, `mcp`, `send`, `publish`, `destroy`, `spawn`, `schedule`, `skill.write`, `spend`, `useSecret`, `infer`, `gpu`) and refuses an unknown verb, unknown field, missing field, wrong type, empty list, duplicate entry, vocabulary version other than 1, and any `gpu` (`not-available-yet`), each with one plain sentence from `GATE_SHAPE_FAILURES`.
- Spend is whole nano-USD only: a fraction, a negative number, negative zero, a number past `Number.MAX_SAFE_INTEGER`, a string and `null` are all refused, and there is no `usd` field. No other field accepts a non-integer number.
- A `*` (host, `*.example.com`, mcp server and tools, spawn agent, publish target, infer provider and model, useSecret audience) is refused with `not-allowed-here` in a concrete request and accepted in a ceiling. Path patterns refuse `..`, a leading `/`, a backslash, a drive letter and control characters, and are normalised with `normalizeRelative`.
- 16 frozen canonical vectors (literal strings; gpu's pins the refusal reason) fail loudly if v1 changes. Parsing is pure: the same input twice, interleaved with a refused call, or after a JSON round trip gives a byte-identical canonical result.
- `teamBoundaries.test.ts` has a `domain/gate` rule (only targets under `src/domain`), a scan with a two-file minimum, and a planted-violation case that reports `../../agent/tools`, `vscode` and a package import while allowing `../protectedPaths`, `../glob` and `../team/types`.
- `matchesGlob` and `globToRegExp` moved to `src/domain/glob.ts`; `src/agent/glob.ts` is a one-line re-export, so `src/agent/tools.ts` and `agentBasics` keep working unchanged (a test asserts the two exports are the same function).
- `fromActionCapability` maps all nine shorthands one way, in the widest honest ceiling form when facts are missing, and falls back to the widest form (never to nothing) when a supplied fact does not parse.

## Task Commits

1. **Task 1: Tracer, shape helpers and the first verbs inside the boundary-checked folder** - `b0d89dc` (feat)
2. **Task 2: All sixteen verbs, integer-only spend, reserved gpu, glob move, shorthand mapping** - `6ae399d` (feat)

**Plan metadata:** the commit that adds this file (docs).

## Files Created/Modified

- `src/domain/gate/shape.ts` - closed refusal reasons, `Parsed`, `refused`, `checkKeys`, `isRecord`, `isSafeIntegerInRange`, `ownValue`
- `src/domain/gate/vocabulary.ts` - the vocabulary, parsers and the one-way shorthand mapping
- `src/domain/glob.ts` - the glob matcher (header comment changed, body unchanged)
- `src/agent/glob.ts` - re-export of the two functions
- `src/test/gateVocabulary.test.ts` - 19 tests
- `src/test/teamBoundaries.test.ts` - `domain/gate` rule, scan test and planted case

## Verification

Each run inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536`.

- Task 1: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateVocabulary.test.js dist/test/teamBoundaries.test.js'`: 15 tests, 15 pass, 0 fail, 0 cancelled (at that commit).
- Task 2 and plan level: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateVocabulary.test.js dist/test/teamBoundaries.test.js dist/test/agentTools.test.js'`, run per file at the end: gateVocabulary 19/19 pass; teamBoundaries 6/6 pass; agentTools 16 pass, 0 fail, 2 skipped (the two ripgrep tests, which skip because ripgrep is not installed on this machine; unchanged by this plan). `agentBasics` (the other `matchesGlob` caller) also passed in a combined run of 56 tests, 54 pass, 2 skipped.
- Acceptance criteria re-run: `git ls-files src/domain/gate` lists exactly `shape.ts` and `vocabulary.ts`; `grep -c export src/agent/glob.ts` prints 1; `grep -c "export function matchesGlob" src/domain/glob.ts` prints 1; 16 `canonical:` vectors in the test; `nanoUsdPerRun` is in `vocabulary.ts` and the test proves `1.5` is refused for it; `git diff --name-status origin/main...HEAD` lists exactly the six files above. `package.json` and `package-lock.json` are unchanged. No full suite or e2e was run (the plan asks for its own verify commands only).

## Decisions Made

- **sharedWrite mapping (recorded refinement of D-04).** `sharedWrite` becomes `skill.write{scope: team}` plus the marker `floorRule: 'floor.shared-write'`, as the plan specified. The reason, for the record: the shared team knowledge store is outside the project, where a project-relative path pattern cannot name it, so the vocabulary's durable-knowledge verb carries it. The floor's ask is unchanged. Nothing maps back.
- **`not-sorted` is defined but unused.** The plan lists it in the closed reasons; no v1 list requires an order, so only later formats can use it. A test pins the closed list of ten reasons.
- **`duplicate` is used** for the same entry twice in any list (after normalisation, so `./src/a` and `src/a` collide), so one grant has one canonical form.
- **Unknown field is checked before missing field** in `checkKeys`, so a typo is reported as a typo.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in the plan's own assertion] A `useSecret` handle like `sk-live-abc` passes the handle pattern**
- **Found during:** Task 2 (writing the test the plan asks for)
- **Issue:** `^[a-z][a-z0-9._-]{0,63}$` accepts `sk-live-abc`, yet the plan requires it refused ("a handle can never look like a secret, Pitfall 9"). A pattern-only parser would fail that required test and let a secret-shaped name reach `assertNoSecrets` at signing time.
- **Fix:** `parseCredentialHandle` also refuses (`not-allowed-here`) any handle for which `findSecrets` from `src/domain/team/secrets.ts` reports a finding. That module is under `src/domain`, so the boundary rule allows it.
- **Files modified:** `src/domain/gate/vocabulary.ts`, `src/test/gateVocabulary.test.ts`
- **Committed in:** `6ae399d`

**2. [Rule 2 - Missing critical] infer provider and model accept a lone `*` in a ceiling**
- **Found during:** Task 2 (`fromActionCapability('mediaGeneration')`)
- **Issue:** the plan gives `mediaGeneration` an `infer` capability and says unknown facts fall back to `'*'` in ceiling form, but the plan's wildcard list does not include infer's provider and model, so the fallback could not parse.
- **Fix:** `*` is accepted for `infer.provider` and `infer.model` in ceiling mode only and refused in request mode. The tier is still a closed list without `deny`.
- **Files modified:** `src/domain/gate/vocabulary.ts`, `src/test/gateVocabulary.test.ts`
- **Committed in:** `6ae399d`

**3. [Rule 1 - Bug] Negative zero passes `Number.isSafeInteger`**
- **Found during:** Task 2
- **Issue:** `-0` would be accepted as a whole number and then make `canonicalize` throw, because the canonical form rejects negative zero.
- **Fix:** whole-number fields refuse `-0` as the wrong form.
- **Committed in:** `6ae399d`

**Plan wording, not a deviation:** the plan says to "extend the planted-violation test"; the `domain/gate/planted.ts` case was added to that existing test, and its title now mentions the gate folder. No existing assertion was changed, weakened or removed.

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 missing critical). **Impact on plan:** none beyond the items above; no scope creep, no behaviour change in the extension (nothing imports the new folder yet).

## Issues Encountered

- One of my own new test assertions was wrong on first run (`//` is refused as a leading slash, not as an empty pattern); the test was corrected to match the specified behaviour. No code change.

## Authentication Gates

None.

## Known Stubs

None. The `gpu` verb is intentionally parse-then-refuse by design (D-03), not a stub.

## Threat Flags

None. The new files add no endpoints, auth paths, file access or trust-boundary schema beyond the plan's threat model (T-70-01 to T-70-04 are mitigated and tested; T-70-SC: no package added, `package-lock.json` unchanged).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 02 to 06 can import `parseCapability`, `Capability`, `PathPattern`, `HostPattern` and `fromActionCapability` from `src/domain/gate/vocabulary.ts` and the shape helpers from `shape.ts`. Reversibility note for the owner (plan task 2 rated it costly): vocabulary v1 will end up in signed bundles, so any later change is a v2 added beside v1, not an edit.

## Self-Check: PASSED

- Files: `src/domain/gate/shape.ts`, `src/domain/gate/vocabulary.ts`, `src/domain/glob.ts`, `src/test/gateVocabulary.test.ts` all present; `src/agent/glob.ts` and `src/test/teamBoundaries.test.ts` modified.
- Commits `b0d89dc` and `6ae399d` are on `feat/gate-vocabulary`; `git rev-list --count` from the recorded base `5070c55` to `6ae399d` is 2.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*

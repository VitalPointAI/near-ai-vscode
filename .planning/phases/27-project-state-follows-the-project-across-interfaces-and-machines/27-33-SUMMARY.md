---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 33
subsystem: model-choices
tags: [review-gap-closure, model-choices, sync, compare-models]
requires: []
provides:
  - "modelChoices.ts: resolveRoleModels, cleared entries (value null), CHOICES_STAT_TTL_MS, ReadOptions test seams, StoredChoice type"
  - "modelRoles.ts: roleUpdate(option, model, layerRoles)"
  - "modelComparisonPage.ts: projectChoicesView, clearOneProjectChoice, clearProjectModelChoices, message clear-project-choice"
  - "command nearAi.clearProjectModelChoices (NEAR AI: Clear This Project's Model Choices)"
affects: [27-36]
tech-stack:
  added: []
  patterns: ["a clear is a synced entry, never a deletion", "write only the layer being written; resolve role by role"]
key-files:
  created: []
  modified:
    - src/services/modelChoices.ts
    - src/services/modelRoles.ts
    - src/services/settings.ts
    - src/services/modelComparisonPanel.ts
    - src/services/modelComparisonPage.ts
    - src/services/stateRecords.ts
    - package.json
    - media/compare/compare.js
    - media/compare/compare.css
    - src/test/modelChoices.test.ts
    - src/test/modelComparisonPage.test.ts
    - src/test/stateTwoMachines.test.ts
key-decisions:
  - "nearAi.agent.roleModels resolves per role: default, user, project choice, workspace, folder. Other settings keep their whole-value order."
  - "Applying a role extends only the layer written (the project's own roleModels choice, or the workspace value); apply recommended accumulates into that same layer map."
  - "A cleared choice is an entry with value null and a time. removeProjectChoice stamps it after the entry it clears (at least 1 ms later), so a clear beats the choice even inside one millisecond."
  - "The status cache window applies to the settings readers only (projectChoiceFor, choicesInEffect default to ttlMs 1000). readChoicesFileSync and readProjectChoicesSync default to ttlMs 0 so direct readers and tests that edit the file see it at once. Every write, merge or clear in this module drops the cache entry."
  - "The page asks the host to clear a setting by its full name; the host accepts only PROJECT_CHOICE_SETTINGS (short names are refused too)."
requirements-completed: [SYNC-06]
status: complete
commits: 3
plan_head_before: a32ba9200ae12548298f998bb1733018562bcc11
plan_head_after: c95e6401fb46c128f80165352811773f3ecca70c
actuals:
  tokens: 19900
  tasks: 3
  commits: 3
completed: 2026-11-13
---

# Phase 27 Plan 33: Role-by-role model choices, clearable project choices, status cache Summary

Applying a model to one agent role now writes only that role, a project's model choices can be seen and cleared (list in Compare Models, a command, and a sentence on each setting), and a cleared choice is a synced entry that stays cleared on every computer.

## What changed

**Task 1 (tracer), commit 52e8c0a.** `resolveRoleModels(inspected, projectRoles, fallback)` merges defaults, user, project, workspace, folder role by role; `settings.readRoleModels` uses it. `roleUpdate` now takes the roles of the layer being written. `applyRole` passes `projectChoiceFor(root, 'agent.roleModels')` (or the workspace value when the workspace sets it); `applyRecommended` accumulates its role changes into that layer map instead of the fully resolved roles, so the other roles keep following the person's settings. `readChoicesFileSync` takes `ReadOptions` (`ttlMs`, `status`, `now`); the settings readers use a 1000 ms window, and `replace()` clears the cache entry on every write. This commit also carried the cleared-entry plumbing in `modelChoices.ts` and the `StoredChoice` type in `stateRecords.ts`, because they share the same file; Task 2's commit holds their tests.

**Task 2, commit c5f945f.** `parseChoices` keeps `{ value: null, at, writer }` when the time is valid; `readProjectChoicesSync`, `projectChoiceFor` and `choicesInEffect` hide cleared entries; `mergeProjectChoices` compares cleared and set entries by the same newer-wins rule; `removeProjectChoice` writes a cleared entry under the existing lock; `importOffer` already skips any setting that has an entry, so it skips a cleared one. `stateRecords.ts` needed only its type changed (`StoredChoice`): `collectChoices` carries `entry.value` as it is and `applyChoices` passes it to the merge, so null travels through unchanged (verified by the two-computer test).

**Task 3, commit c95e640.** Page state carries `projectChoices`; `compare.js` renders a "Chosen for this project" list (textContent only, theme variables only) with one "Use my settings" button per row, hidden when empty and tolerant of a state without the field; the host handles `clear-project-choice` through `clearOneProjectChoice` (refuses unknown names with an error and writes nothing) and reposts. `nearAi.clearProjectModelChoices` opens a multi-select QuickPick of the settings in effect. The nine model settings' descriptions end with the plan's sentence.

## Verification

Run one at a time under the memory cap (4G, no swap, choom 1000, timeout 900, 1536 MB heap).
- Task 1 command: 49 tests, 49 pass, 0 fail (modelChoices, modelComparisonPage, toolsPage). 5 new modelChoices tests.
- Task 2 command: 65 tests, 65 pass, 0 fail (modelChoices, stateTwoMachines, stateMigration). 4 new modelChoices tests and 1 new stateTwoMachines test.
- Task 3 command (plus responsivePanels, which also loads compare.js): 75 tests, 75 pass, 0 fail. 5 new modelComparisonPage tests.
- Also run: agentDefaults, config, syncControl, stateRecords-adjacent: 41 pass, 0 fail.
- `npm run lint`: exit 0.
- Acceptance greps: `resolveRoleModels` in settings.ts 2 (at least 1); `roleUpdate(option, model, readRoleModels())` in the panel 0; `value: null` in modelChoices.ts 2; `"nearAi.clearProjectModelChoices"` in package.json 1; "used instead of this setting until you clear it" in package.json 9.

## Deviations from Plan

### Existing tests changed because the plan changes the behavior they asserted

**1. [Plan-mandated] `readRoleModels` expectation in the settings-readers test.** It asserted the project's `{ 'gsd-planner': 'project-planner' }` replaced the whole role map. The plan requires "every default pattern" to remain, so it now expects `{ ...DEFAULT_ROLE_MODELS, 'gsd-planner': 'project-planner' }`.

**2. [Plan-mandated] Undo of a first-time choice.** The test asserted `choices.json` had `values: {}` after the undo. The plan keeps a cleared entry, so it now asserts the file holds the cleared entry (value null) for that setting and that the reader sees no choice. No assertion about what the person sees was weakened.

### Auto-fixed

**3. [Rule 3 - Blocking] Status function type.** The `status` seam was first typed as `statSync`'s return, which may be undefined; typed it as the four fields the reader uses.

### Design choices within the plan

- The 1 s window applies only where the plan needs it (the settings readers). Direct callers of `readChoicesFileSync` and `readProjectChoicesSync` look at the file every time, so tests and code that edit the file by hand see it at once.
- Test seam for the cleared-entry stamp: a clear is stamped at least 1 ms after the entry it clears (not in the plan; needed so "newest wins" cannot drop a deliberate clear on a fast clock).

## Known Stubs

None.

## Threat Flags

None. T-27-132 to T-27-134 are covered by tests: layer-only writes and per-role resolution (modelChoices tests), visible list, command, descriptions and synced clears (modelComparisonPage and stateTwoMachines tests), and the host accepting only the nine settings.

## Next Phase Readiness

For plan 27-36 (README): the command is titled **NEAR AI: Clear This Project's Model Choices** (`nearAi.clearProjectModelChoices`). In Compare Models the list appears as a bordered "Chosen for this project" block directly under the notice line and above the leaderboard, one row per model setting that comes from this project's choice (label, model, and a "Use my settings" button); it is absent when the project has no choices. Each of the nine model settings' descriptions says a model chosen for this project in Compare Models is used instead until it is cleared there or with that command. A cleared choice stays cleared on every computer after sync.

## Self-Check: PASSED

- Commits 52e8c0a, c5f945f, c95e640 are in HEAD's history.
- Files created or changed exist and compile (`npm run lint` exit 0).

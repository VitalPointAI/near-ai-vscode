---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 09
subsystem: state-sync
tags: [model-choices, comparisons, settings-resolver, state-home, import-offer, undo]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-03 stateHomeFor (paths.comparisons, paths.choices, ensure), writeFileAtomic, createExclusive, editorWriter; decision D-06"
provides:
  - "src/services/modelChoices.ts: PROJECT_CHOICE_SETTINGS, ProjectChoices, readProjectChoicesSync, readChoicesFileSync, projectChoiceFor, writeProjectChoice, removeProjectChoice, declineImport, resolveSetting, planApply, importOffer, choicesInEffect, projectUndoFor, undoProjectChoice"
  - "src/benchmark/store.ts: ComparisonStore(dirs: string | string[], prepare?) union read and dual write; comparisonStoreFor(globalStorageDir, root?)"
  - "settings.ts readers (readSettings, readRoleModels, readModelTiers, readSafetyModel, readAgentModels) resolve workspace value, project choice, user value, default"
  - "Compare Models apply, apply-recommended and undo write the project's choices.json; import offer on open"
affects: [27-10, 27-15, 27-16, sync, restore, compare-models, team-studio, tools-directory]

actuals:
  tokens: 19620
  tasks: 3
  commits: 3
plan_head_before: b7bfcc232138cc0a7ca14fd052d09d4c06b3de0c
plan_head_after: 0d1a12f9c9ba633810e7fd7165c3b5056ecb65eb

tech-stack:
  added: []
  patterns:
    - "Per-setting merge by (at, writer) under an in-process queue plus an exclusive lock file, replaced atomically, so two editors never lose each other's setting"
    - "A value equal to the stored one writes nothing at all (no at bump), so applying twice is byte-identical and records no second undo"
    - "Reader-side resolver: explicit workspace or folder value, then project choice, then user value, then default; with no folder or no file it is exactly the 0.4.19 behaviour"
    - "Undo entry captured BEFORE the write (projectUndoFor), restoring the previous project choice or removing a first-time one"

key-files:
  created:
    - src/services/modelChoices.ts
    - src/test/modelChoices.test.ts
  modified:
    - src/benchmark/store.ts
    - src/services/settings.ts
    - src/services/modelComparisonPanel.ts
    - src/services/modelRoles.ts
    - src/services/teamStudioPanel.ts
    - src/services/toolsDirectory.ts
    - src/services/toolsPage.ts
    - media/tools/tools.js
    - src/test/modelComparisonPage.test.ts

key-decisions:
  - "ComparisonStore.save writes every folder through a randomly named temporary file and an atomic rename; one folder failing does not lose the others, and it only throws when none took the run"
  - "The state-home comparisons folder is created through a prepare hook that calls ensure(), so the inner .gitignore exists before the first run file; reading never calls it"
  - "importOffer offers only settings the project has no choice for yet, so an existing project choice is never replaced by the import; this reads the plan's 'every setting already has a project choice' as the empty case"
  - "Applying with no project folder open and no explicit workspace value is refused with a plain message rather than falling back to user settings (D-06: apply never writes user settings)"
  - "The Tools directory shows 'project choice' as the source for a model that comes from choices.json, via choicesInEffect (a project choice with no explicit workspace value)"

patterns-established:
  - "Pattern: a synchronous reader for a state-home file caches by mtime, size and inode, since every write replaces the file"
  - "Pattern: pure helpers (roleAppliedText, projectUndoFor, undoProjectChoice) keep the vscode-bound panel logic testable on plain node"

requirements-completed: [SYNC-06]

coverage:
  - id: D1
    description: "A comparison saved in one editor is listed in another editor on the same host without that editor's own folder holding it; it is also kept in the saving editor's global folder"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "dist/test/modelChoices.test.js#tracer: a comparison saved in one editor is listed in another editor on the same host"
        status: pass
    human_judgment: false
  - id: D2
    description: "A choice written by one editor is read by a fresh reader and beats the user value; folder, workspace, project, user, default order; an empty project value is ignored"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "dist/test/modelChoices.test.js#tracer: a model choice written by one editor is read, and wins over the user value, in another"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#resolveSetting: folder value beats workspace value beats project choice beats user value beats default; an empty project value is ignored"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every settings reader (defaultModel, tiers, safety, vision/transcription/image, roleModels) uses the project choice unless the workspace sets the value; with no choices.json it behaves as in 0.4.19; the tools directory names the project choice"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "dist/test/modelChoices.test.js#the settings readers use the project choice unless the workspace sets the value explicitly"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#the tools directory names the project choice as the source of a model, and only then"
        status: pass
    human_judgment: false
  - id: D4
    description: "SYNC-06 concurrency, idempotency and empty edges: concurrent writers keep every setting and valid JSON with no leftover lock or temp file; the same value twice is byte-identical; no choices.json falls back to user then default; damaged, unknown, empty and newer-version files are ignored"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "dist/test/modelChoices.test.js#SYNC-06 concurrency edge: two editors writing at once keep every setting either wrote, and the file is valid JSON"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#SYNC-06 concurrency edge: for one setting the later (at, writer) wins, whatever order the writes ran in"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#SYNC-06 idempotency edge: writing the same value twice leaves the file byte-identical and says nothing changed"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#SYNC-06 empty edge: with no choices.json every reader falls back to the user value, then the default"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#a damaged choices.json, an unknown setting and an empty value are ignored, never trusted"
        status: pass
    human_judgment: false
  - id: D5
    description: "Apply targets the workspace only when it sets the value, else the project; undo restores the previous project choice exactly or removes a first-time one; applying twice records no second undo; no user setting is written"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "dist/test/modelChoices.test.js#planApply: the workspace when it sets the value explicitly (workspace or folder), otherwise the project; never user settings"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#applying then undoing: a previous project choice comes back, a first-time choice is removed, and no user setting is involved"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#SYNC-06 idempotency edge: applying the same recommendation twice leaves choices.json byte-identical and records no second undo"
        status: pass
      - kind: unit
        ref: "dist/test/modelComparisonPage.test.js#the applied message says where the model was put: for this project, or in this workspace"
        status: pass
    human_judgment: false
  - id: D6
    description: "Import offer lists user-level choices that differ from the default; none when the user value equals the project choice or the default, when every setting has a project choice, or after 'Not now'; listing copies nothing; 'Use for this project' writes each offered value"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "dist/test/modelChoices.test.js#importOffer lists user-level choices that differ from the default, and nothing is copied by listing"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#SYNC-06 adjacency edge: no offer when the user value equals the project choice or the default, or every setting already has a project choice"
        status: pass
      - kind: unit
        ref: "dist/test/modelChoices.test.js#'Not now' is remembered for the project: no further offer, and the other choices are kept"
        status: pass
    human_judgment: false
  - id: D7
    description: "Prohibition: reading comparisons or choices writes nothing and never starts a comparison run"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "dist/test/modelChoices.test.js#reading a project writes nothing, and a comparison run is never started to fill a gap"
        status: pass
    human_judgment: false
  - id: D8
    description: "The Compare Models panel itself: the import notification appears on open and the buttons work, apply and undo from the real page, and the same runs and choices appear in desktop VS Code and code-server"
    verification: []
    human_judgment: true
    rationale: "The panel's vscode-bound wiring (showInformationMessage, configuration.update for the workspace case, page refresh after a project write) is covered by the pure helpers it calls and by tsc, not by an extension-host test in this plan; the two-editor behaviour is owner-observable (27-VALIDATION manual-only row)"

duration: 28min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 09: Comparisons and model choices follow the project Summary

**Comparison runs are saved in the project's state home and in the editor's own folder and listed as a union; applied model choices live in the project's `choices.json`; every model setting reader resolves explicit workspace value, then project choice, then user value, then default; and older user-level choices are offered for import once, never copied without a click.**

## Performance

- **Duration:** 28 min
- **Tasks:** 3 (tracer, then two auto/tdd tasks)
- **Files modified:** 11 (2 created, 9 modified)

## Accomplishments

- `ComparisonStore` takes an ordered list of folders. `save()` writes every folder through a random temporary name and an atomic rename; `list()` keeps one run per id (state home wins), newest first by `startedAt` then id; `load()` and `newId()` consider every folder. Compare Models and both Team Studio list sites use `comparisonStoreFor`, so a comparison made in code-server is listed in desktop VS Code with no re-run, and nothing is started to fill a gap.
- `choices.json` in the state home holds `{ version: 1, values: { [setting]: { value, at, writer } }, importDeclined? }`. Writes re-read the file under an in-process queue plus an exclusive lock file, merge per setting by `(at, writer)`, and replace atomically; an equal value writes nothing. Reads are synchronous, cached by mtime, size and inode, and ignore damaged files, unknown settings, empty values and newer versions.
- The five readers in `settings.ts` call `resolveSetting` with `configuration.inspect`, so every interface (chat, agent runs, Compare Models, Tools directory) sees the same model. With no folder or no file they behave as in 0.4.19. The Tools directory and page name `project choice` as the source when it applies.
- Compare Models: `planApply` sends an apply to the workspace only when it already sets the value, otherwise to the project; undo restores the previous project choice or removes a first-time one; the applied text says "for this project" or "in this workspace". `ConfigurationTarget.Global` no longer appears in the panel. On open, user-level choices that differ from the default are offered with "Use for this project" and "Not now" (remembered); dismissing the message writes nothing.

## Task Commits

1. **Task 1: Tracer, a comparison and a choice made in one editor are listed and effective in another** - `348de9b` (feat). Verified end to end (3 tests, 0 failing; `benchmarkResults` still passes) before expansion.
2. **Task 2: every model setting reader and the tools directory resolve through the project choice** - `281ecc6` (feat)
3. **Task 3: apply and undo write the project choice; old user-level choices are offered for import** - `0d1a12f` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

## Files Created/Modified

- `src/services/modelChoices.ts` - choices file, resolver, apply plan, undo helpers, import offer, lock and merge
- `src/benchmark/store.ts` - union and dual-write store, `comparisonStoreFor`
- `src/services/settings.ts` - readers through `resolveSetting` (5 call sites)
- `src/services/modelComparisonPanel.ts` - apply, apply-recommended, undo, import offer, page refresh after a project write
- `src/services/modelRoles.ts` - `roleAppliedText`
- `src/services/teamStudioPanel.ts` - both list sites through `comparisonStoreFor`
- `src/services/toolsDirectory.ts`, `src/services/toolsPage.ts`, `media/tools/tools.js` - `project choice` source text
- `src/test/modelChoices.test.ts` (20 tests), `src/test/modelComparisonPage.test.ts` (1 new)

## Decisions Made

See `key-decisions`. The two that go beyond the plan text: the import offer never overrides an existing project choice, and applying with no folder open and no explicit workspace value is refused with a plain message rather than touching user settings.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Cross-process safety for `choices.json`**
- **Found during:** Task 1 (design of the SYNC-06 concurrency edge)
- **Issue:** read, merge and atomic replace alone still loses a setting when two editors read before either writes.
- **Fix:** an in-process queue plus an exclusive lock file (`choices.json.lock`, stale after 15 s, bounded wait with a plain error) around the read-merge-replace; no lock or temporary file is left behind (asserted).
- **Files modified:** `src/services/modelChoices.ts`
- **Commit:** `348de9b`

**2. [Rule 2 - Missing critical] Comparison folders write through `ensure()` and tolerate one folder failing**
- **Found during:** Task 1
- **Issue:** creating `.near-ai/state/comparisons` directly would place a file in a folder with no inner `.gitignore`; and a read-only project would have lost the run in the global folder too.
- **Fix:** a `prepare` hook calls `ensure()` before the state-home folder is written; `save()` only throws when no folder took the run.
- **Files modified:** `src/benchmark/store.ts`
- **Commit:** `348de9b`

**3. [Rule 2 - Missing critical] The page is refreshed by hand after a project write or undo**
- **Found during:** Task 3
- **Issue:** a workspace write raises a settings event that refreshes the Compare Models page; a `choices.json` write does not, so the page would show stale roles and recommendations.
- **Fix:** `repost()` regathers and posts the state after a project apply or undo.
- **Files modified:** `src/services/modelComparisonPanel.ts`
- **Commit:** `0d1a12f`

**4. [Rule 3 - Blocking] Readers tolerate a configuration without `inspect`**
- **Found during:** Task 2
- **Issue:** several test stubs provide `get` only, and `get` stays the fallback so their behaviour is unchanged.
- **Fix:** `inspectedSetting` returns undefined when `inspect` is not a function; the `get` result is the fallback passed to `resolveSetting`.
- **Files modified:** `src/services/settings.ts`
- **Commit:** `281ecc6`

### Process note on TDD

Tasks 2 and 3 are marked `tdd="true"`. The tests for each were written before the code that makes them pass, but no failing run was made between writing the tests and the implementation, and both landed in a single commit per task, so there is no separate RED commit. The tests exercise real files and real merge behaviour, and the settings readers are tested against a stubbed `vscode` module; no test was weakened.

**Total deviations:** 4 auto-fixed (3 Rule 2, 1 Rule 3) plus the TDD process note. **Impact:** no scope change.

## Known limits

- The panel's `vscode` wiring (the import notification, `configuration.update` for the workspace case, the refresh after a project write) has no extension-host test here; it is covered by the pure helpers, `tsc`, and the owner-observable two-editor check in 27-VALIDATION.
- A project choice is not live-watched: other open windows pick up a new `choices.json` on their next read (the next send or panel refresh), not instantly.
- `nearAi.agent.roleModels` stored as a project choice is the whole role map at the time of the apply, so a later user-level role change does not merge into it until the project choice is removed.

## Threat Flags

None. No new network endpoint or auth path. The new lock file and choices file sit under the self-ignored state home; model ids are only strings, and the existing privacy and TEE-only checks still apply to the resolved model at send time (T-27-34).

## Self-Check: PASSED

- Files: `src/services/modelChoices.ts`, `src/test/modelChoices.test.ts` exist.
- Commits `348de9b`, `281ecc6`, `0d1a12f` are ancestors of HEAD.
- `modelChoices`, `modelComparisonPage`, `toolsPage`, `teamStudioPage`, `benchmarkResults`, `chatBridge`, `stateHome` pass (116 tests, 0 failing); `tsc` clean.
- Greps: `resolveSetting(` in `settings.ts` is 5; `ConfigurationTarget.Global` in the panel is 0; `process.pid` in `store.ts` is 0; the old `new ComparisonStore(path.join(...))` in `teamStudioPanel.ts` is 0; `importDeclined` appears in both files.

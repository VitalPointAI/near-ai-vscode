---
phase: 46-native-theia-foundation
plan: 05
subsystem: copy-lint
tags: [copy-lint, glossary, sterling, workbench, d-08, d-12, d-33, d-43]
status: complete

requires:
  - phase: 46-01
    provides: "workbench/extension/src/browser and common, moved from the Sterling spike"
provides:
  - "copySourceFiles scans workbench/extension/src/browser/**/*.ts and workbench/extension/src/common/**/*.ts (WORKBENCH_SOURCES)"
  - "the edition-name exemption: 'Sterling Sovereign AI' is a name; sovereign elsewhere still counts"
  - "panelCommand(open: () => unknown, what: string): () => undefined in src/services/webview/openPanel.ts"
affects: [46-02, 46-07, 32.1, 33]

actuals:
  tokens: 3700        # chars/4 over the added lines of the plan's diff (14,767 chars), SUMMARY excluded
  tasks: 3
  commits: 3          # measured: git rev-list --count plan_head_before..HEAD at SUMMARY time; the SUMMARY commit follows
plan_head_before: ae6f3c45ea9895c46474a74a4b733e7d61f14be0
plan_head_after: ace1a5d542de1aea9357897b04505c0e5ca84321

tech-stack:
  added: []
  patterns:
    - "Workbench browser and common sources are read as page scripts, parsed as TypeScript"
    - "A DOM helper's class-name argument is found from the helper's own parameter named className, never from a fixed position"
    - "Command handlers that open a page go through panelCommand: they return undefined and report a failure"

key-files:
  created: []
  modified:
    - src/test/helpers/copyLintScan.ts
    - src/test/copyLint.test.ts
    - src/test/copy-lint-baseline.json
    - .planning/research/coherence/GLOSSARY.md
    - workbench/extension/src/browser/sterling-compliance-module.ts
    - workbench/extension/src/browser/sterling-welcome-module.ts
    - workbench/extension/src/browser/team-preview-frontend-module.ts
    - src/services/webview/openPanel.ts
    - src/extension.ts
    - src/services/modelComparisonPanel.ts
    - src/test/modelComparisonPage.test.ts

key-decisions:
  - "The className argument of a DOM helper is read from the helper's parameter list, because team-preview's element() takes (tag, className, text) while the compliance, portfolio and work-area pages' element() takes (tag, text, className); a fixed 'second argument' rule would have hidden real copy on three pages"
  - "A <br> inside one run of HTML text keeps its words in one piece, so the Get Started heading 'Sterling<br>Sovereign AI' is read as the edition name"
  - "Shared page and feature names stay as they are and are recorded once: Team Studio (8) and Set Up a Staff Team (1)"
  - "The compliance page's bundle attestation line says Signature, because attestation is a glossary proof word"

requirements-completed: [FND-T-10, FND-T-01]

duration: about 1 h 10 min (including the root and workbench installs and waits on the shared heavy lock)
completed: 2026-11-24
---

# Phase 46 Plan 05: Copy lint for the Sterling workbench, and the two #162 command handlers Summary

**The copy lint now reads the Sterling workbench's browser and common sources. It accepts "Sterling", "SovAI" and "Sterling Sovereign AI" as the edition's own names, while "sovereign" elsewhere still counts. The moved pages say "agent team" and "Signature" where the glossary asks. The only counts recorded are page and feature names the extension also uses. Set Up and Compare Models now return nothing to their caller and tell the person when their page could not open.**

## Owner approval needed in the PR

None. This plan changes no gate file.

## Task results

| Task | Commit | Result |
|------|--------|--------|
| 1. The lint scans the workbench and accepts the edition names | `825c281d` | 3 new tests, which failed on the base first (3 of 3) and now pass; copy lint 31 of 31 apart from the expected baseline failure until Task 2 |
| 2. The moved copy is fixed and shared names are recorded | `157022ed` | Copy lint 31 of 31, including "the repository passes against its baseline"; `npm --prefix workbench run lint` is clean; workbench unit tests pass 12 of 12 |
| 3. Set Up and Compare Models report a failure | `ace1a5d5` | 4 new tests, which failed on the base first (4 of 4) and now pass; modelComparisonPage, setupSteps, copyLint and architecture pass 87 of 87 |

Impacted suites, run once after Task 3: gateNoFolder, responsivePanels, policyEditor and gateDocs pass 94 of 94. gateDocs reads `copySourceFiles` and `extractCopy`.

## Tests run vs added

- **Added: 7 tests.** Three are in `src/test/copyLint.test.ts` (the D-33 scan roots, the edition names, the workbench name positions). Four are in `src/test/modelComparisonPage.test.ts` (panelCommand on success, on a throw and on a rejection, and the registered `nearAi.compareModels` with `createWebviewPanel` throwing).
- **Run:** root copyLint (31), modelComparisonPage, setupSteps, copyLint and architecture together (87), gateNoFolder, responsivePanels, policyEditor and gateDocs (94), and the workbench lint and unit tests (12). No test was deleted, skipped or weakened. The full root suite and the container suite were not run here: the full suite runs once at the wave or phase boundary, and no string a browser spec reads changed.

## Walker name rules added (workbench files only)

1. **A `Symbol()` description is a name.** For example `Symbol('TeamPreviewService')`. It starts with a capital letter, so the page rule would otherwise read it as words.
2. **The class-name argument of the file's own DOM helper is a name.** The scanner finds, for each function declared in the file, the position of its parameter named `className`, and treats the argument in that position as a name. See deviation 1 for why it does not use a fixed position.

The other positions the plan listed were already names under the existing page rules, and the new test covers each one:
- Command ids such as `sterling.getStarted` and `nearAi.projectSetup` match the existing id pattern (`ID_LIKE`).
- A property named `id` was already in `NAME_PROPERTIES`.
- An `import './x.css'` is an `ImportDeclaration`, which was already a name.

No rule was added for these, so the lint is no looser than before.

## Edition-name exemption

`EDITION_NAME` (`/Sterling\s+Sovereign\s+AI/`, as whole words, case-sensitive) is replaced by a space before every rule runs. This happens in one place, `countHits`, and the comment there cites D1, D10, D-08 and D-33. "Sterling" and "SovAI" needed no rule change, because `BRANDS` only knows NEAR AI and VS Code. The tests check four things:
- "Your sovereign data stays here." still counts one glossary hit.
- "Sovereign AI for your organization." still counts one glossary hit, because only the whole edition name is exempt.
- "Near AI" still counts one brand hit.
- "SovAI: Open Team Studio Preview" has no glossary or brand hit. Its "Team Studio" is still a bare-team hit.

## Hits fixed, by rule

| Rule | File | Before | After |
|------|------|--------|-------|
| glossary (attestation) | `sterling-compliance-module.ts` | `Manifest verified · Attestation: …` | `Manifest verified · Signature: …` |
| bare-team | `sterling-welcome-module.ts` | `Explore a sample team` | `Explore a sample agent team` |
| bare-team | `sterling-welcome-module.ts` | `Sterling could not open the sample team.` | `Sterling could not open the sample agent team.` |
| bare-team | `team-preview-frontend-module.ts` | `Loading team…` | `Loading agent team…` |
| bare-team | `team-preview-frontend-module.ts` | `This team has no members.` | `This agent team has no members.` |

There were no em-dash, provider-before-organization, compliance-claim, misspelt-brand or mode-word hits in the workbench. The em-dash check over both folders finds 0 files.

## Shared names kept (for the coherence work)

| File | Rule | Count | Strings |
|------|------|-------|---------|
| `workbench/extension/src/browser/team-preview-frontend-module.ts` | bare-team | 7 | "Open Team Studio Preview" (the command the specs select), "Team Studio" three times (tab label, the heading the specs read, widget name), "Team Studio Preview" (tab caption), "Team Studio could not load the samples.", "Team Studio could not read this sample." |
| `workbench/extension/src/browser/sterling-welcome-module.ts` | bare-team | 1 | "Try opening Team Studio from the command palette." |
| `workbench/extension/src/browser/sterling-work-areas-module.ts` | bare-team | 1 | "Set up a staff team" (the extension's command "Set Up a Staff Team", `nearAi.setUpStaffTeam`) |

The baseline diff against `origin/feat/phase-46-wave-1` only adds these three workbench keys. No existing key or count changes:

```diff
@@ -254,0 +255,9 @@
+  },
+  "workbench/extension/src/browser/sterling-welcome-module.ts": {
+    "bare-team": 1
+  },
+  "workbench/extension/src/browser/sterling-work-areas-module.ts": {
+    "bare-team": 1
+  },
+  "workbench/extension/src/browser/team-preview-frontend-module.ts": {
+    "bare-team": 7
```

The strings the browser specs read are unchanged: "Get Started", the `Sterling<br>Sovereign AI` heading, "Open Team Studio Preview" with the "SovAI" category, the "Team Studio" heading, and the sample titles. The workbench has no step-up copy yet, so the "Confirm with your passkey or security key" text that 46-02 and 46-07 add is untouched.

## Planning choices (as planned, with deviation 1)

1. **Workbench files are read with the page walker, parsed as TypeScript.** The walker learned two name positions, `Symbol()` and the helper's className parameter, and each has a test. Rating reversible.
2. **Page and feature names shared with the extension are kept and recorded once.** Every other hit was fixed. Rating reversible.
3. **One helper, `panelCommand(open, what)`, in `src/services/webview/openPanel.ts`, is used by both handlers.** It reports a thrown error, and it also catches a rejected promise in case an opener becomes async. The message is `${what} could not open: ${message}`. Rating reversible.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The DOM helper's class-name position comes from its own parameters, not a fixed "second argument"**
- **Found during:** Task 1
- **Issue:** The plan's rule was "the second argument of a call to a function named `element` is a name". That is only true for `team-preview-frontend-module.ts`. `sterling-compliance-module.ts`, `sterling-portfolio-module.ts` and `sterling-work-areas-module.ts` declare `element(tag, text, className)`, so the fixed rule would have hidden their visible text, for example "Published evidence. Authorization is your organization's decision.", "Reload bundle" and "Local work areas". That would have loosened the lint.
- **Fix:** `classNameParameters(file)` finds the position of the parameter named `className` in each function the file declares. A test covers both helper orders.
- **Files modified:** `src/test/helpers/copyLintScan.ts`, `src/test/copyLint.test.ts`
- **Commit:** `825c281d`

**2. [Rule 1 - Bug] A `<br>` inside one run of HTML text no longer splits it**
- **Found during:** Task 1
- **Issue:** The Get Started heading is `Sterling<br>Sovereign AI`. `htmlText` turned every tag into a break, so the edition name was read as "Sterling" and "Sovereign AI", and "Sovereign" counted as the glossary word.
- **Fix:** `htmlText` reads `<br>` as a space. It now reads the page as one person would. No existing count changed: the only other `<br>` literals in `src/` and `media/` are bare `'<br>'` join strings.
- **Files modified:** `src/test/helpers/copyLintScan.ts`
- **Commit:** `825c281d`

**3. [Scope, lean] No separate rule for `.css` strings or for a `command` property**
- **Found during:** Task 1
- **Issue:** Both were already names under the existing rules (an import declaration, and `ID_LIKE` for every command id in the workbench).
- **Fix:** No rule was added. The behaviour test still checks both, so a later change cannot turn them into copy without a failure.

**4. [Process] STATE.md, ROADMAP.md and REQUIREMENTS.md were not updated**
- **Issue:** They are outside this plan's `files_modified`, and wave-2 plans run in parallel on separate branches. 46-01's completion commit set the same precedent and only added its SUMMARY.
- **Fix:** None. The orchestrator updates them after the wave merges.

## Threat surface

T-46-18 and T-46-19 are mitigated as planned. No new endpoint, auth path or package was added (T-46-SC: no install of a new package; `npm ci` restored the existing lockfiles only).

## Follow-up after the wave merge

Run the copy lint once on the integration branch, so that the new copy from 46-02 is scanned and starts at zero.

## Self-Check: PASSED

- FOUND: src/test/helpers/copyLintScan.ts, src/test/copyLint.test.ts, src/test/copy-lint-baseline.json, src/services/webview/openPanel.ts, src/test/modelComparisonPage.test.ts
- FOUND commits: 825c281d, 157022ed, ace1a5d5 (ancestors of HEAD)
- Acceptance greps: `workbench/extension/src` in copyLintScan.ts (1), `Sterling Sovereign AI` in copyLint.test.ts (2), `SovAI` in GLOSSARY.md (1), "Open Team Studio Preview" (1), `'Get Started'` (4), em-dash files (0), new non-workbench baseline keys (0), `export function panelCommand` (1), `void openOnboarding` (0), `void openModelComparison` (0), `panelCommand` in extension.ts (2)

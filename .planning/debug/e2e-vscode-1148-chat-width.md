---
status: awaiting_human_verify
trigger: "CI e2e job times out at 20 min on every attempt since VS Code 1.148.0 became latest stable: the chat width check logs 'retrying chat at 170px ... steps: start 289, no change 289, ...' and 'chat at 289px (asked 170px)' for every width. Blocks PR #201 and #204."
created: 2026-11-25T13:30:00Z
updated: 2026-11-25T14:35:00Z
---

## Current Focus

hypothesis: CONFIRMED - VS Code 1.148 nests the editor part with its new (hidden) Agents chat area in a horizontal branch when the panel is at the bottom and centred, so the editor-width commands trade width with that hidden part and never with the secondary sidebar; the SovAI chat page itself follows its sidebar correctly
bug_class: Bohrbug (deterministic, 1.148.0 locally and in CI on every attempt)
test: with the panel justified (side bars in the editor's own row) or on the right, the same commands move the chat 60px a step on 1.147 and 1.148
next_action: CI e2e on the PR must pass on 1.148.0; then rebase #201 and #204 onto main once this merges
reasoning_checkpoint:
  hypothesis: "The e2e chat width check times out on VS Code 1.148 because the harness sizes the secondary sidebar with workbench.action.increaseViewWidth/decreaseViewWidth, which resize the editor part's grid view; 1.148 always registers the Agents 'workbench.parts.chat' part and arrangeEditorNodes wraps [editor, chat] in their own horizontal branch, and Gridview.resizeView only resizes within the parent (the hidden chat part) and grandparent (vertical: height), so the width never reaches the sidebar"
  confirming_evidence:
    - "DOM via DevTools port: 1.148 decreaseViewWidth leaves editor 1088 / aux bar 292 / webview 289; 1.147 gives editor 1028 / aux bar 352 / webview 350"
    - "1.148 DOM has #workbench.parts.chat (0px, hidden) and the editor's split-view parent is horizontal; 1.147 has no chat part and a vertical parent"
    - "Same commands and resizePart code in both bundles; 1.148 arrangeEditorNodes returns a branch whenever a chat node exists"
    - "Panel justified or panel right (side bars in the editor's row): 1.148 289->350->410->350->290->230, same as 1.147"
    - "Aux bar resized directly (part-size commands with DOM focus in the aux bar): chat page tracks it on both versions (352/350, 232/230)"
  falsification_test: "If, with the panel justified, the editor-width commands still left the chat at 289 on 1.148, or if the chat page width did not follow the aux bar width, the hypothesis would be wrong"
  fix_rationale: "The harness relied on 'the only thing beside the editor area is the secondary sidebar'; justifying the panel during the chat checks puts the side bars back in the editor's own row in both versions (the panel is closed, so nothing the chat shows changes), so the same 60px steps reach the sidebar again. Pinning the version stops a future layout change from arriving unannounced, and a resize that never moves the sidebar now fails at once with the reason instead of retrying for 20 minutes"
  blind_spots: "Not tested on VS Code > 1.148.0 (pinned); CI runner window size differs from local (1440 vs CI) but widths are relative steps; panel alignment command semantics could change in a later VS Code (the pin and the fail-fast message cover that)"
  candidate_causes:
    - "environment: VS Code 1.148 layout change (Agents chat part beside the editor) - CONFIRMED"
    - "code (harness): resize via editor-width commands assumes the editor area's only neighbour is the secondary sidebar - CONFIRMED as the dependent assumption"
    - "code (product): chat webview stops tracking its container on 1.148 - ELIMINATED"
    - "config: workbench.experimental.modernUI default changed - ELIMINATED (true in both)"
  and_gate: "yes: the failure needs both the 1.148 layout change AND the harness's assumption; additionally the unpinned 'stable' download let the change arrive silently and the retry loop turned a deterministic failure into a 20-minute timeout"

## Symptoms

expected: The chat sidebar is sized to 170..590px in 60px steps and each width is measured (passing run on 1.147.0 ~5 min, zero retries)
actual: On 1.148.0 every step reports "no change 289"; each width is retried 4 times (~38 s per try) and the job hits the 20-minute timeout
errors: "retrying chat at 170px, attempt 2 (it was 289px; editor groups: column 1 (active): empty; steps: start 289, no change 289, no change 289, no change 289, no change 289)"; "chat at 289px (asked 170px)"
reproduction: CI e2e job (xvfb-run node dist/test/e2e/run.js) with @vscode/test-electron version 'stable' resolving to 1.148.0
started: 2026-11-25, when VS Code 1.148.0 became the latest stable (1.147.0 passed at 04:36 the same day)

## Eliminated

- hypothesis: a workbench.action.* resize command was renamed or removed in 1.148
  evidence: increaseViewWidth/decreaseViewWidth/increaseViewSize/decreaseViewSize exist in 1.148 with identical code (RESIZE_INCREMENT 60, same resizePart)
  timestamp: 2026-11-25T13:55:00Z

- hypothesis: workbench.experimental.modernUI (floating panels) newly on by default in 1.148 changes the layout
  evidence: defaults to true in both 1.147.0 and 1.148.0 (diag log)
  timestamp: 2026-11-25T14:05:00Z

- hypothesis: the SovAI chat webview no longer follows its sidebar's width on 1.148 (a product layout bug)
  evidence: when the aux bar is resized directly, the chat page width follows it exactly on 1.148 (352->350, 232->230), same as 1.147
  timestamp: 2026-11-25T14:30:00Z

- hypothesis: the commands act on whichever part has focus and the chat's focus is the problem
  evidence: the harness uses the editor-width commands, which name the editor part explicitly; in 1.147 they work with the webview focused; in 1.148 they fail with or without an editor open
  timestamp: 2026-11-25T14:05:00Z

## Evidence

- timestamp: 2026-11-25T13:30:00Z
  checked: src/test/e2e/run.ts
  found: version = process.env.VSCODE_TEST_VERSION ?? 'stable' (unpinned); CI does not set VSCODE_TEST_VERSION
  implication: any new VS Code stable is picked up silently

- timestamp: 2026-11-25T13:30:00Z
  checked: src/test/e2e/suite.ts sizeSidebar/sidebarStep
  found: the chat is resized only with workbench.action.decreaseViewWidth / increaseViewWidth after closeSidebar + closePanel + nearAiChatView.focus; the trace shows the start width 289 and 'no change' for every step on 1.148
  implication: on 1.148 these commands no longer change the secondary sidebar width in this layout

- timestamp: 2026-11-25T13:55:00Z
  checked: VS Code bundles (workbench.desktop.main.js) 1.147.0 vs 1.148.0
  found: the increaseViewWidth/decreaseViewWidth commands and the layout service's resizePart are identical in both (RESIZE_INCREMENT 60, resize the editor part's grid view); 1.148 adds a 'workbench.parts.chat' grid view (chatPartView, EDITOR_HIDDEN_BY_CHAT, fillsEditorArea)
  implication: no command was renamed or removed; the change is in the grid around the editor part

- timestamp: 2026-11-25T14:05:00Z
  checked: local diagnostic (scratchpad e2e148/diag) with the harness's launch args, chat width before/after each command
  found: 1.147.0 start 289, decreaseViewWidth 289->350, increaseViewWidth 350->290->230, works with or without an editor open, and focusAuxiliaryBar+increaseViewWidth 290->230. 1.148.0 start 289 and every command (decrease/increaseViewWidth with or without an editor, focusAuxiliaryBar + increase/decreaseViewSize) leaves it at 289. workbench.experimental.modernUI defaults to true in BOTH versions
  implication: reproduced locally, deterministic (Bohrbug); not caused by modernUI default; not focus-dependent

- timestamp: 2026-11-25T14:20:00Z
  checked: workbench DOM through the renderer's DevTools port (diag/cdp-suite.js), both versions
  found: 1.148 has a new hidden part '#workbench.parts.chat' (0px wide). The editor part's split-view parent is horizontal (style left/width) in 1.148 and vertical (top/height) in 1.147, and 1.148 shows two sashes at the editor's right edge (1140 and 1140 disabled). After decreaseViewWidth: 1.147 editor 1088->1028 and aux bar 292->352 with the webview 289->350; 1.148 editor stays 1088, aux bar stays 292, webview 289
  implication: in 1.148 the editor part sits in its own horizontal branch [editor, agents chat area]; Gridview.resizeView only resizes a view within its parent and grandparent, so "Increase/Decrease Editor Width" trades width with the hidden chat area and the secondary sidebar never changes

- timestamp: 2026-11-25T14:20:00Z
  checked: 1.148 layout source (arrangeEditorNodes / insertChatNodeBesideEditor / createWorkbenchLayout)
  found: arrangeEditorNodes returns the bare editor leaf only when there is no side bar, aux bar or chat node; 1.148 always registers the Agents 'workbench.parts.chat' part (1.147 had the code but no part), so with the panel at the bottom and centred the editor becomes a branch [editor, chat]
  implication: matches the DOM: a VS Code 1.148 layout change, not a renamed or removed command

- timestamp: 2026-11-25T14:30:00Z
  checked: diag/focus-suite.js, both versions: document.activeElement after nearAiChatView.focus / focusAuxiliaryBar, and the part-size commands
  found: with the chat focused, activeElement is the webview IFRAME with no flow-to link into the aux bar part, so increaseViewSize/decreaseViewSize do nothing (both versions). With DOM focus on an element of the aux bar part itself, increaseViewSize makes the aux bar 292->352 and the chat page 289->350, decreaseViewSize x2 352->232 / 350->230, identical on 1.147 and 1.148
  implication: the SovAI chat page follows its sidebar exactly on 1.148: the product is not broken; only the harness's way of resizing the sidebar stopped working

## Resolution

root_cause: "VS Code 1.148 always registers its Agents chat area (workbench.parts.chat, hidden) and, with the panel at the bottom and centred, puts the editor part and that area in a horizontal branch of their own; the e2e harness sized the secondary sidebar with workbench.action.increaseViewWidth/decreaseViewWidth, which resize the editor's grid view only within that branch, so every 60px step went to the hidden chat area and the sidebar (and the SovAI chat) never moved; the unpinned 'stable' download let the change arrive silently, and the per-width retries turned the deterministic failure into a 20-minute job timeout"
fix: "src/test/e2e/suite.ts: justify the panel (workbench.action.alignPanelJustify) for the chat width checks so the side bars are in the editor's row in every version, centre it again in a finally; sizeSidebar throws at once with the VS Code version and step trace when no step has ever moved the chat (sidebarEverMoved). src/test/e2e/run.ts: pin E2E_VSCODE_VERSION = '1.148.0' (VSCODE_TEST_VERSION still overrides) with a bump note. CONTRIBUTING.md: one line pointing to the pin."
verification:
  target_test: { result: pass, detail: "full e2e on pinned 1.148.0: 23 project + 5 plain tests pass, 0 fail, chat 170..590px all reached at the first try (zero retries), run 4 min 9 s (scratchpad e2e148/full-1148.log)" }
  mutation_check: { result: skipped, reason_if_skipped: "no Stryker for the VS Code e2e harness; the revert run below plays the same role for the fix site" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: n/a, detail: "no assertion removed or loosened; widths, tolerances and retries unchanged; adds a layout step, a fail-fast throw and a version pin" }
  adjacent_tests: { result: pass, suites_run: ["full e2e on 1.147.0 (VSCODE_TEST_VERSION=1.147.0): 23 + 5 pass, 0 fail, zero retries", "npm run lint (tsc) clean", "copyLint.test.js (covers CONTRIBUTING.md) 35/35 pass"] }
  revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true, detail: "dist suite.js with the justify step swapped for alignPanelCenter on 1.148.0: 'every panel fits narrow widths' fails at once with \"The chat's sidebar never moved: VS Code 1.148.0's editor-width commands did not resize it (asked 170px; steps: start 289, no change 289 x4) ...\"; whole run 1 min 33 s instead of the 20-minute timeout; recompiled and reapplied: passes" }
  guardrail_verdict: accepted
files_changed: [src/test/e2e/suite.ts, src/test/e2e/run.ts, CONTRIBUTING.md]

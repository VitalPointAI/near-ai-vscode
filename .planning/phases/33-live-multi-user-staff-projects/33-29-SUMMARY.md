---
phase: 33-live-multi-user-staff-projects
plan: 29
status: complete
subsystem: other people's cursors in bound Sterling editors, Show Who Wrote This in Monaco, and presence in the native live engine
tags: [workbench, staff, live, presence, cursors, attribution, monaco, theia, d-18, d-21, d-56, d-62, mus-09]
requires: [33-12, 33-21, 33-24, 33-25, 33-26]
provides: [openProjectPresence, ProjectPresence, StaffLiveEngine.onPeople, StaffLiveEngine.people, StaffLiveEngine.cursor, StaffLiveEngine.idle, RemoteCursor, AttributionRow, AttributionAnswer, WHO_WROTE_THIS_COMMAND, SELECTION_INTERVAL_MS, RemoteCursors, StaffRemoteCursors, cursorSlot, plainMarkdown, escapeIcons, StaffWhoWroteThis, WhoWroteThisPicker, attributionDecorations, bindPresencePart]
affects: [33-30, 33-31]
tech-stack:
  added: []
  patterns: [presence read from the project after each fold and kept for synchronous use, a leading and trailing pace of 100 ms so the last selection always goes, cursors recomputed from relative positions after every change, names only as escaped plain text]
key-files:
  created:
    - src/staff/replica/projectPresence.ts
    - workbench/extension/src/browser/staff/remote-cursors.ts
    - workbench/extension/src/browser/staff/who-wrote-this.ts
    - workbench/extension/src/browser/staff/staff-cursors.css
    - workbench/test/staff-remote-cursors.test.ts
    - workbench/test/staff-who-wrote-this.test.ts
  modified:
    - workbench/extension/src/common/staff-binding.ts
    - workbench/extension/src/node/staff/binding-service.ts
    - workbench/extension/src/node/staff/staff-live-engine.ts
    - workbench/extension/src/node/staff/staff-engine.ts
    - workbench/extension/src/node/staff/staff-room-service.ts
    - workbench/extension/src/browser/staff/binding-contribution.ts
    - workbench/extension/src/browser/staff/binding-part.ts
    - workbench/extension/src/browser/staff/presence-part.ts
    - workbench/tools/staff-engine-entry.ts
    - workbench/test/helpers/staff-binding-world.ts
    - workbench/test/staff-room-service.test.ts
key-decisions:
  - "The native live engine runs one LivePresence per open shared work (G435's remediation). projectPresence.ts reads the held cells, epoch keys and roster after each fold; a frame from a session key counts for the member its standing certificate names (certifiedWriter), so a person working through a session shows as that person."
  - "The backend paces selections to one per 100 ms with a trailing send, so at most 10 a second go and the last place a person stopped is always the one others see; LivePresence's own limit stays as the second guard."
  - "Cursors come back to a tab as offsets computed by the binding (EditorBinding.indexOf) after every change and every presence frame, and only when they changed, so a cursor moves with remote text."
  - "RESEARCH N6 verified: Theia 1.77 ships @theia/monaco-editor-core 1.108.201, whose public IModelDecorationOptions has after/before (InjectedTextOptions). The label after the caret is kept, besides the hover."
  - "Show Who Wrote This shows, besides the gutter marks, the list of authors with their share in Theia's quick pick; its labels escape icon syntax ($( becomes \\$(), as the fixed extension path does (72e95c9f), and every hover is markdown with all punctuation escaped, no HTML, no icons, not trusted."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 26200
  tasks: 3
  commits: 2
plan_head_before: 72e95c9f7310a94bf76562fd5c23e767c7751a05
plan_head_after: 8249d7ca301ba0284b08fbf0ee0e24f307ae87df
completed: 2026-11-25
---

# Phase 33 Plan 29: Native cursors and Show Who Wrote This Summary

People editing the same product in SovAI now see where the others are. A selection in one person's editor becomes Yjs relative positions in their session backend and goes out as sealed presence through the replicator, at most 10 times a second, and nothing about it is stored. The other person's backend opens it, turns the positions into offsets in their own copy of the text, and their editor shows a caret and the selection in one of 8 fixed colours, with the person's name and position word in the hover and in a small label after the caret. A cursor moves with the text when someone else types before it, and goes when the person leaves or is not heard from for 30 seconds. **Show Who Wrote This** marks each author's lines in the gutter, names the person (or "{agent job} agent, run {n}, on {person}'s computer") in the hover and the gutter tooltip, and lists every author with their share. Text a session key wrote reads as the person its certificate names. The Staff Room's people list now shows everyone presence hears, not only this person.

## Base and branch

- `feat/phase-33-29-30` from `origin/feat/integration-gate-2` at `72e95c9f`, as the coordinator directed (one branch for 33-29 and 33-30; no PR).
- Step 0, each as the plan expects: `export class LivePresence` in livePresence.ts 1; `STAFF_BINDING_PATH` in common/staff-binding.ts 1; `bindPresencePart` in presence-part.ts 1.

## RESEARCH N6 (injected text)

Present. `workbench/node_modules/@theia/monaco-editor-core` is 1.108.201; its public `monaco.d.ts` gives `IModelDecorationOptions.after` and `before` as `InjectedTextOptions { content, inlineClassName }`, and `linesDecorationsTooltip`. The label after the caret is kept. Names reach Monaco only as the injected text's `content` (rendered as text) and as escaped markdown.

## What was built

- **Engine (root `src/`).** `projectPresence.ts`: `openProjectPresence(project, { send, writer, setPeople, now, timers })` gives a `LivePresence` over the project, with `refresh()` and `holds(cell)`. The member of a device is the roster's at the head, or the member of a standing `session.certify` (`certifiedWriter`).
- **Live engine.** One presence per open project, started after the replicator, sending as the replicator's signer (the session key in a hosted session). Frames arrive through the replicator's `onPresence`. `refresh()` runs after every exchange that pulled something, and before a cursor in a cell presence had not seen. New: `onPeople`, `people(id)`, `cursor(id, cell, product, anchor, head)`, `idle(id)`. Presence stops before the replicator.
- **Channel** (`common/staff-binding.ts`): `selection(doc, anchor, head)`, `attribution(doc)` and the notification `onPresence(doc, cursors)`; `RemoteCursor`, `AttributionRow`, `AttributionAnswer`, `WHO_WROTE_THIS_COMMAND`, and the words in `STAFF_BINDING_TEXT`.
- **Binding service.** Selections paced to one per `SELECTION_INTERVAL_MS` (100) with a trailing send, turned into relative positions by `EditorBinding.relativeAt`. Cursors of other people in the product sent to the tab as offsets (`EditorBinding.indexOf`) after a presence change, an attach, a local change, an applied remote change and a refresh, only when they changed. Attribution: the fold's `productOutput`, labelled by `authorRows(namesAtRegistration(...))` from the executed `whoWroteThis.ts`, only when the editor matches the shared text. A detach cancels a waiting selection and marks the person idle.
- **Browser.**
  - `remote-cursors.ts`: `RemoteCursors` draws with `deltaDecorations` (selection `className`, caret `beforeContentClassName`, hover, injected label), `cursorSlot` (FNV-1a of the member id, 8 slots), `plainMarkdown`, `escapeIcons`; `StaffRemoteCursors` sends this tab's selections and draws the cursors on every editor of a bound model.
  - `who-wrote-this.ts`: the `sterling.staff.showWhoWroteThis` command, enabled only while a bound editor has focus; gutter marks (`linesDecorationsClassName`, `linesDecorationsTooltip`, hover) and the list through `WhoWroteThisPicker`; the marks go on the next change or the next toggle.
  - `staff-cursors.css`: 8 slots from theme tokens (charts colours, two terminal colours), caret, a lifted name tag, high-contrast borders, the gutter bars and a hatched warning bar for unverified text.
  - The part files adapt Monaco: `getControl().deltaDecorations`, `onDidChangeCursorSelection` with `getOffsetAt`, and Theia's quick pick.
- **Staff Room.** The people list is this person, then everyone presence heard, with the name and position from this roster; the room is sent again when they change.

## Deviations from Plan

1. **[Rule 3] Presence was not running in the native engine (G435), and the plan needs it.** The live engine now runs it (`projectPresence.ts`, about 40 lines in `staff-live-engine.ts`). The Staff Room takes its people from it (Rule 2: the same loop, its one consumer left without it). The G435 entry is still in `compliance/gaps.json`: removing it was refused by this session's permission check, so the owner or coordinator closes it.
2. **[Coordinator] Flat test files:** `workbench/test/staff-remote-cursors.test.ts` and `staff-who-wrote-this.test.ts`, as 33-25 to 33-28, because the shared world helper finds the engine bundle from `dist/test/`.
3. **[Rule 1] A cell held only after presence started was never sent in.** The first run showed no cursor message at all: presence read the held cells once, before the product's grant arrived. A cursor in a cell presence has not seen now reads the project again first, and every pulled exchange does too.
4. **Presence methods on the replicator type are optional** (`EngineReplicator.postPresence?`), so the existing fake replicators of 33-24 and 33.2-07's tests compile unchanged; the engine starts no presence over a replicator without them.
5. **Tasks in two commits.** The three tasks share the channel, the service and the helper, so the code is one commit (`ecafe32b`) and the Staff Room's people a second (`8249d7ca`). The test files were written before the code.
6. **Files outside the plan's list:** `staff-room-service.ts` and its test (deviation 1), `staff-engine.ts` and `staff-engine-entry.ts` (the engine names), `binding-contribution.ts` (the editor's decorations and selections, and the presence event), `binding-part.ts` (the Monaco adapter), and `src/staff/replica/projectPresence.ts`.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0, choom and timeout, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set (workbench) and Node 24 (root).

| Run | Result |
|-----|--------|
| Focused, run 1 (the two new files, room service) | the two new files did not load: the helper finds the engine from `dist/test/` (deviation 2) |
| Focused, run 2 | 14 of 19; no cursor message at all (deviation 3) |
| Focused, runs 3 and 4 | cursors 4 of 8 (the tests relayed before the cursor was sent; they now wait for it), then **8 of 8** |
| `npm --prefix workbench test` | **336 tests: 335 passed, 0 failed, 1 skipped** (the browser bundle scan, which needs `npm run build`; it runs in 33-30's image build) |
| `npm --prefix workbench run lint` | first: three type errors (a test call, two fake replicators); after deviation 4, exit 0 |
| Root: `npm run compile`, then copyLint, architecture, staffLivePresence and staffAttributionView | **69 passed, 0 failed** (`--max-old-space-size=3072` for the whole-repository compile, under the same 6G cap) |

- `staff-remote-cursors.test.ts` has 8 tests (plan: at least 3 after Task 1, 7 in all). `staff-who-wrote-this.test.ts` has 4 (plan: at least 4).
- **Tests added: 13** (8 cursors, 4 Who Wrote This, 1 Staff Room people). **Tests changed: 0.** The shared helper gained fake decorations, selection events, a presence relay, a clock option and `createProduct`.

## Codex continuation

The two-browser run found that two frontend parts could hold separate wrappers for the same Monaco editor. The cursor watcher could not find the editor in the binding, so the selection never reached the backend. The recovery worktree adds a test of distinct wrappers, gives the Monaco editor adapter a stable wrapper, and looks up the active binding by model. The burst test submits 50 selections in the half-open first second and checks that the final position arrives.

The regression reproduced before the fix: the separate-wrapper test saw no cursor frame (`d070b66e`). After the fix (`3a61f45a`), the focused cursor, attribution and Staff Room service checks passed 20 of 20. Workbench lint passed. The workbench unit suite ran 339 tests with 338 passed and one existing skip for the locally unbuilt browser bundle. The recovery adds one regression test and updates the timing of one existing test.

## Threat model

| Threat | As built |
|---|---|
| T-33-N3 | Names reach Monaco only as escaped markdown (every ASCII punctuation character escaped, no HTML, no icons, not trusted) and as injected text content; class names come from a fixed set picked by the member id. Tested with CSS, HTML, link and icon text in a name. |
| T-33-N19 | 50 selections in one second send at most 10 cursor messages, and the last one always goes (tested). LivePresence's own limit stays. |
| T-33-N20 | Presence is sealed per cell (33-12); a cursor goes only in its product's own cell, and only bound products draw cursors. |
| T-33-SC | No package was installed. |

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new channel methods | workbench/extension/src/node/staff/binding-service.ts | `selection` and `attribution` on `/services/sterling-staff-binding`, and the `onPresence` notification: offsets, names, position words and author labels of a product the person has open, between their own tab and their own session backend. No key or token. |

## Self-Check: PASSED

- The created files exist; the commits `ecafe32b` and `8249d7ca` are in HEAD.

## Open conditions

- **G435** (remediated, entry still open): the native live engine now runs presence and the Staff Room lists the people it hears; the register entry is left for the owner to close, because this session could not remove it.


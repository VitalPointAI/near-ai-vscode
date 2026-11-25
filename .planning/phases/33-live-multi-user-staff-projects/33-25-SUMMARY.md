---
phase: 33-live-multi-user-staff-projects
plan: 25
status: complete
subsystem: native Monaco co-editing in the Sterling workbench (the document channel, the backend mirror, the browser model and the undo routing)
tags: [workbench, staff, live, binding, monaco, theia, undo, d-17, d-52, d-53, d-54, d-55, mus-09]
requires: [33-04, 33-24, 33-31]
provides: [STAFF_BINDING_PATH, StaffBindingServer, StaffBindingClient, AttachAnswer, OTHER_TAB_TEXT, STAFF_BINDING_TEXT, BOUND_EDITOR_CONTEXT, textHash, RemoteBoundDocument, moveEdits, StaffBindingService, bindStaffBindingService, MonacoBoundDocument, StaffBindingContribution, StaffBindingEvents, StaffBoundUndoRedoHandler, StaffEditorSource, StaffLiveEngine.projectionInput, StaffLiveEngine.localAppended, StaffLiveEngine.shared, staff-frontend-core]
affects: [33-26, 33-27, 33-28, 33-29, 33-30]
tech-stack:
  added: []
  patterns: [the executed binding core over a mirror document with its own version, a request beaten by typing moved past it and sent again, the browser's messages leaving in model order through one hash queue, feature logic in Theia-free files and the Theia glue in the part file]
key-files:
  created:
    - workbench/extension/src/common/staff-binding.ts
    - workbench/extension/src/node/staff/remote-bound-document.ts
    - workbench/extension/src/node/staff/binding-service.ts
    - workbench/extension/src/browser/staff/monaco-bound-document.ts
    - workbench/extension/src/browser/staff/binding-contribution.ts
    - workbench/extension/src/browser/staff-frontend-core.ts
    - workbench/test/helpers/staff-binding-world.ts
    - workbench/test/staff-remote-bound-document.test.ts
    - workbench/test/staff-monaco-bound-document.test.ts
    - workbench/test/staff-bound-undo.test.ts
  modified:
    - workbench/extension/src/node/staff/binding-part.ts
    - workbench/extension/src/browser/staff/binding-part.ts
    - workbench/extension/src/browser/staff-frontend-module.ts
    - workbench/extension/src/node/staff/staff-engine.ts
    - workbench/extension/src/node/staff/staff-live-engine.ts
    - workbench/tools/staff-engine-entry.ts
    - workbench/test/staff/staff-modules.test.ts
key-decisions:
  - "The mirror keeps its own version, one step per change it tells the binding core of, beside the browser model's version that requests name. Adopting the browser's whole text, or a browser version that moved with no change to the shared text, is never a change to the core."
  - "A request beaten by the person's typing is moved past that typing and sent again, at most five times. Once applied, the core hears the request first, as the echo it waits for, then the typing moved past it. So an ordinary race never reaches the core's stop on a concurrent edit."
  - "Theia 1.77 sends Ctrl+Z, Ctrl+Y, the Edit menu and the palette to core.undo and core.redo, whose handler calls UndoRedoHandlerService; Monaco's own undo command is not registered in Theia. Two routes reach the binding: a core.undo and core.redo handler enabled only on a focused bound editor, and an UndoRedoHandler ranked 20000, above Monaco's 10000."
  - "Theia reloads a file from disk inside MonacoEditorModel.doSync with ignoreContentChanges set. That flag marks a disk change, which is held read-only and offered as Take This Change as My Edit or Restore."
  - "The registered frontend module passes the real parts. Its bindings moved to staff-frontend-core.ts, which imports no part, so the unit tests load them without Theia's widget and editor code, which needs a page."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 28700
  tasks: 3
  commits: 5  # measured from plan_head_before; 33-25 and 33-26 share the branch, this plan's own: e4b3c0e6 and c05a8ce4
plan_head_before: 2353811b9f3800060c5a10815d96eded08cd6699
plan_head_after: e4bbb7e5db643fb6872a9354bffbb73577ebe2c8
completed: 2026-11-24
---

# Phase 33 Plan 25: Native Monaco co-editing Summary

A product of an open shared project, opened in a Sterling editor, is now bound. The executed binding core (33-04) runs unchanged in the session backend over a mirror of the tab's Monaco model. Typing reaches the shared record, and other people's changes appear without an echo and without a native undo stop. Undo and redo, by every path Theia has, remove only this person's changes. Other rules hold too:

- the header stays the project's;
- a change on disk is offered as the person's edit or put back;
- a second tab of the session reads the product only;
- a save is never a conflict;
- a dropped connection comes back with the current text.

## Base and branch

- `feat/phase-33-wave-25-26` from `2353811b`, the head of `feat/phase-33-engine-wave-1` after 33-24 and 33-31, as the coordinator directed. 33-26 runs on the same branch.
- Step 0 at the base, each as the plan expects:
  - `export interface BoundDocument` in editorBinding.ts: 1
  - `public static async open` in editorBinding.ts: 1
  - `export class StaffLiveEngine` in staff-live-engine.ts: 1
  - `withClient` in backend-service.ts: 3

## The two [verify] items (RESEARCH N3 and N4), against Theia 1.77.0 in workbench/node_modules

- **N3, the model.**
  - `MonacoEditorModel` (`@theia/monaco` 1.77.0) has `textEditorModel` (Monaco's `ITextModel`), `version` (`getVersionId()`), `onModelWillSaveModel` (a listener whose promise the save awaits), `save()`, `readOnly` and `onDispose`.
  - Its own `onDidChangeContent` has no undo flags, so the binding listens on `textEditorModel.onDidChangeContent`, whose `isUndoing` and `isRedoing` set the reason.
  - `ITextModel.applyEdits` edits without adding to the undo stack.
  - A reload from disk runs in `doSync` through `updateModel(..., { ignoreDirty: true, ignoreContentChanges: true })`, and only while the model is not dirty. That flag is how the binding tells a reload from typing.
- **N4, the undo key path.**
  - Theia's keybinding registry listens for `keydown` on the document in the capture phase. Ctrl+Z (and Ctrl+Y or Ctrl+Shift+Z) runs `core.undo` (or `core.redo`) and stops the event, so Monaco never sees the key.
  - Theia's `core.undo` handler calls `UndoRedoHandlerService.undo()`. The service tries its handlers by priority: Monaco's focused-editor handler at 10000, the DOM input handler at 1000, Monaco's active-editor handler at 0. The Monaco handler runs `editor.trigger(..., 'undo')`, which is the native undo.
  - Monaco's own `undo` and `redo` commands are in `MonacoCommands.EXCLUDE_ACTIONS`, so they are not Theia commands at all.
  - `CommandRegistry.registerHandler` puts a new handler first (`unshift`), and `getActiveHandler` takes the first enabled one.
  - The binding therefore registers a `core.undo` and `core.redo` handler enabled only on a focused bound editor, and an `UndoRedoHandler` at 20000 for any other caller of the service. If a native undo still reached a bound model, the core already replaces its result with this session's own history (33-04).

## The test model

Monaco's own model does not load under the Node test runner: `@theia/monaco-editor-core` imports CSS. The tests use `FakeTextModel` (workbench/test/helpers/staff-binding-world.ts) with the members of `ITextModel` the binding uses:
- `getVersionId`, `getValue`, `getPositionAt`;
- `applyEdits`, with no undo stop;
- `setEOL` and `onDidChangeContent`, with `isUndoing`.

Its undo stack takes only typing, as `pushEditOperations` does in Monaco.

## What was built

- **The channel** (`common/staff-binding.ts`, `STAFF_BINDING_PATH = '/services/sterling-staff-binding'`).
  - The tab calls `attach(client, uri, text, version)`, `changed(doc, edits, version, hash, reason?)`, `applied(doc, request, ok, version, hash)`, `fullText`, `synced`, `undo`, `redo`, `flush` and `detach`.
  - The backend notifies `onHello(client)`, `onApplyEdits`, `onRequestFullText`, `onReadOnly` and `onNotice`. The tab passes its id back with attach, because Theia's RPC target is shared by every tab. A new id means the connection came back.
  - Hashes are SHA-256 hex, by Web Crypto in the tab and `node:crypto` in the backend.
- **The mirror** (`node/staff/remote-bound-document.ts`, `RemoteBoundDocument implements BoundDocument`).
  - Each change's edits are applied to the mirror's copy and the hash compared. On a mismatch the mirror asks for the whole text once, adopts it, and calls the core's `refresh`, which resynchronizes the model and logs "Resynchronized the shared product editor." once.
  - A request travels at the browser version the mirror stands for. If the person's typing beat it, the typing is held, the request is moved past it (`moveEdits`) and sent again.
  - Once the request applies, the core is told the request first (its echo), then each held change moved past it. A rare overlap the two moves do not agree on shows as a hash mismatch, and the whole-text path repairs it.
- **The service** (`node/staff/binding-service.ts`).
  - It finds the product by the projection's own path (`staffProductPath`) and header (`projectProductFile(state, '')`) in the open project's fold. Its stream is the versions family's, and its text the fold's.
  - It opens `EditorBinding` from the engine bundle and calls `setBound` so the projector leaves the product alone.
  - One binding per product per session: another tab gets `OTHER_TAB_TEXT` read-only and is told when the first lets go.
  - A model that is not the shared text is answered `reset` with the shared text, and the service logs the resync line.
  - Each status row of the project refreshes its bindings, with the header as the fold has it then.
  - A closed connection detaches every document of that tab, after a flush.
- **The browser** (`browser/staff/monaco-bound-document.ts` and `binding-contribution.ts`).
  - Each model a Theia editor opens is offered once; a model that is not a product is never touched.
  - Messages leave in the order the model changed, through one hash queue.
  - Requests that arrive before the attach answer are replayed when the document binds.
  - A disk reload is held with the model read-only, then Take sends it as this person's change and Restore puts the shared text back and saves.
  - A save awaits the binding's flush first.
  - After a reconnect every model attaches again. Changes the backend never confirmed are offered with the same two choices, never dropped silently.
  - The context key `sterlingStaffBoundEditor` is true only while a bound editor has focus.
- **The parts.**
  - Backend `bindBindingPart` binds the service over the session's live engine and the engine bundle.
  - Browser `bindBindingPart` binds the client, the proxy, the editors of the tab (adapted from `EditorManager` without importing Monaco), the contribution and the undo handler.
- **Engine names added** (`tools/staff-engine-entry.ts`, typed in `staff-engine.ts`): `EditorBinding`, `HEADER_KEPT_TEXT`, `RESYNC_LOG_LINE`, `projectProductStates`, `projectProductFile`, `staffProductPath`.
- **`StaffLiveEngine`** gained `projectionInput(id)`, `shared(id)` and `localAppended(id)`. `shared` serves 33-26.

## Deviations from Plan

1. **[Coordinator] Test files are flat:** `workbench/test/staff-remote-bound-document.test.ts`, `staff-monaco-bound-document.test.ts` and `staff-bound-undo.test.ts`, with one shared helper `workbench/test/helpers/staff-binding-world.ts`. The plan named `workbench/test/staff/...`.
2. **[Rule 3] The frontend module's bindings moved to `staff-frontend-core.ts`.** This touches 33-31's files (shared).
   - The parts now import Theia's editor and widget code. That code needs a page, so 33-31's module test could no longer import the registered module under Node.
   - `staff-frontend-module.ts` keeps the default export, with the real parts, and re-exports the core.
   - The module test imports `staff-frontend-core.ts`. Its assertions are unchanged.
   - 33-27 and 33-28 meet the same limit when they fill their parts.
3. **[Rule 1] The plan's "a version race returns false and the core retries" does not hold for the executed core.**
   - On a failed apply after a concurrent edit, `applyRemoteEdits` stops the binding with the mismatch notice. Across a network that race is ordinary.
   - The mirror therefore moves the request past the person's typing and sends it again, and the core sees a consistent order. The tab still never applies at another version; tested both ends.
4. **[Rule 2] Requests that reach a tab before its attach answer are replayed when the document binds.** The backend may refresh a binding at once. Without this, such a request would never be answered and the binding would stop.
5. **[Rule 2] Changes the backend never confirmed before a dropped connection** are offered as Take This Change as My Edit or Restore after the reconnect, never dropped silently.
6. **A product file exists only for a product with a version** (`projectProduct` skips a product without one). So the tests' product has a first version, and a product with no version is not bound: it has no file to open.
7. **Shared files touched, each kept to the binding's lines:**
   - `staff-engine.ts`: the `StaffBindingApi` and `StaffRoomApi` types;
   - `staff-engine-entry.ts`: six names for 33-25, ten for 33-26;
   - `staff-live-engine.ts`: three methods;
   - `staff-frontend-module.ts` and `staff-modules.test.ts`: deviation 2.
8. **Tests first:** the three test files were written with the code, before the first run.
9. **[Rule 1] A held change went to the binding as one replacement of the whole text.** This covered a disk change on top of another and changes offered after a reconnect. That replacement starts in the header, so the core put the header back and dropped the change. `diffEdit` now sends the one edit between the common start and end. Fixed in `c05a8ce4`, found by the Take test.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0, choom and timeout, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set. The workbench runs covered 33-25 and 33-26 together (one branch).

| Run | Result |
|-----|--------|
| Workbench focused, run 1 (the new `staff-*.test.js` files and `staff/staff-modules.test.js`) | 5 new files failed to load: the shared test helper looked for the engine bundle one folder too high (flat tests are bundled into `dist/test/`) |
| Focused, run 2 | 33 tests: 26 passed, 7 failed. Causes: deviation 9; Blake's tab never bound (the test carried entries to the world's copy of the project, not the live engine's, and without the key group's grants); a mismatch test whose model lost nothing; a test slice; the room test's decision order (33-26) |
| Focused, runs 3 and 4 | 29, then 30 of 33; the remaining 3 were the grants |
| `npm --prefix workbench run build && npm --prefix workbench test && npm --prefix workbench run lint` | build ok (backend and frontend bundles, the engine bundle with the new names); **178 tests: 178 passed, 0 failed, 0 skipped**, including 33-24's bundle scan of `lib/frontend` and both real-hub engine tests; lint exit 0 |
| Root: `npm run compile`, then staffRoomLive, copyLint, architecture, staffSharedVersionActs and staffEditorBinding (the executed core), then `npm run lint` | **97 passed, 0 failed**; lint exit 0 |

- `remote-bound-document.test.ts` has 12 tests (plan: at least 9), `monaco-bound-document.test.ts` 6 (with it, 18; plan: at least 6), `bound-undo.test.ts` 4 (plan: at least 4).
- Acceptance greps:
  - `pushEditOperations` in monaco-bound-document.ts: 0
  - files under `workbench/extension/src` with `from 'vscode'`: 0
- **Tests added: 22** (12, 6 and 4). **Tests changed: 1**: `staff/staff-modules.test.ts` imports `staff-frontend-core.ts`, with its assertions unchanged (deviation 2).

## Threat model

| Threat | As built |
|---|---|
| T-33-N13 | Every change carries the model version and a SHA-256 of the text. A mismatch asks for the whole text once and the core resynchronizes (tested). |
| T-33-N14 | Bound undo and redo run the binding's history by core.undo, core.redo and the UndoRedoHandler service. Remote edits use `applyEdits`, which adds no undo stop (tested). |
| T-33-N15 | One binding per product per session; another tab is read-only with `OTHER_TAB_TEXT` until the first detaches (tested). D-64's extension guard is 33-27. |
| T-33-SC | No package was installed. |

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new RPC path | workbench/extension/src/node/staff/binding-service.ts | `/services/sterling-staff-binding`: the text of a product the person has open, its edits and hashes, between the person's own tab and their own session backend. Nothing else crosses it, and no key or token. |

## Open conditions

None.

## Self-Check: PASSED

- The created files exist (the six channel, mirror, service and browser files, staff-frontend-core.ts and the three test files exist).
- The commits e4b3c0e6 and c05a8ce4 are in HEAD.

---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 14
subsystem: state-sync
tags: [pickup-card, run-markers, waiting-flag, gsd-next-step, webview, no-spend, d-03]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-03 stateHome (paths.pickup, ensure, writeFileAtomic); 27-04 RunMarkers (writer id, heartbeat, runState, markerOf), editorWriter/writerEditor; 27-07/27-10 ThreadStore.index (locked lines), history open path"
provides:
  - "src/domain/state/pickup.ts: PickupPointer, PickupModel, RunCardState, parsePickupPointer, derivePickup, runCardState, nextGsdStep"
  - "src/services/pickupCard.ts: writePickupPointer, readPickupPointer, readPickupPhase, markPickupSeen (workspaceState nearAi.pickup.lastSeen), pickupCardModel, handlePickupAction"
  - "media/chat/pickup.js: renderPickupCard (section role=region, Open chat and Not now real buttons, textContent only)"
  - "src/services/chatBridge.ts: { type: 'pickup-card', action: 'open', id } and { type: 'pickup-card', action: 'later' }, strict parser"
  - "src/services/runMarkers.ts: marker field waitingSince, RunMarkers.waiting(conversationId, runId, on)"
  - "src/test/helpers/fakeDom.ts: FakeDocument, FakeNode"
affects: [27-15, 27-17, 27-18, chat, history, team-mode]

requirements-completed: [SYNC-07]

actuals:
  tokens: 18000
  tasks: 3
  commits: 5
plan_head_before: 97681e44b6b962c90c0912a75bbcc838978ab986
plan_head_after: 74ce0131a8ab52528f1223b2f0f2f5cca74f2ce9

tech-stack:
  added: []
  patterns:
    - "The pick-up pointer (.near-ai/state/pickup.json, written atomically after ensure()) is written when a run ends in one of this chat's tabs and when a person opens a thread; the card shows only for a pointer whose editor id differs from this editor's and that is newer than workspaceState's last-seen time"
    - "The card's host handler is one small exported function (handlePickupAction) that can only call openSaved or markSeen, so a spy test proves a click reaches no receive, settle, auto-resume or model call; the pickupCard.ts source is also asserted to contain none of those names"
    - "A run marker says it is waiting on a person (waitingSince) while any approval or question prompt of the run is open; another editor shows that as 'waiting for your answer' instead of 'running'"
    - "The next GSD step is derived from file names in the phase folder and shown as text; the page never posts the command"

key-files:
  created:
    - src/domain/state/pickup.ts
    - src/services/pickupCard.ts
    - media/chat/pickup.js
    - src/test/pickup.test.ts
    - src/test/helpers/fakeDom.ts
  modified:
    - src/services/chat.ts
    - src/services/chatBridge.ts
    - src/services/panelView.ts
    - src/services/runMarkers.ts
    - src/services/agentSession.ts
    - media/chat/chat.js
    - media/chat/chat.css
    - src/test/setupNudge.test.ts

key-decisions:
  - "The card renders into the same container as the setup card (the profile-ready welcome), so it shows in an empty chat once a profile works; without its helper script the chat simply shows no card"
  - "A run live in this very editor is not described on the card (the card is about work left elsewhere), so a stale foreign pointer for a chat that is now running here shows the chat line only"
  - "When the last phase is verified the next step is /gsd-complete-milestone, since there is no later phase to discuss"
  - "Phase folders are matched by number and a dash (03-x or 3-x); 03.1-x is an inserted phase and is not mistaken for phase 3"
  - "'Open chat' removes the card at once; the open itself writes this editor's own pointer (newer, same editor), so the card is never offered again for what was just opened"
  - "pickupCardModel takes a small deps object ({ workspaceState, writer, threads, markers }) instead of the vscode context, so it runs on plain node"

patterns-established:
  - "Webview cards: the same shape as setup.js (IIFE, module.exports when available, rebuilt by id, textContent only), tested against the shared FakeDocument"

coverage:
  - id: D1
    description: "A chat continued in another editor shows on a 'Pick up where you left off' card with its title and time; the same editor reopening sees no card; a card dismissed with 'Not now' is not shown again for that pointer, and a newer pointer from another editor shows again"
    requirement: SYNC-07
    verification:
      - kind: unit
        ref: "dist/test/pickup.test.js#tracer: a pointer written by another editor shows the card with the chat title; the same editor never sees it"
        status: pass
      - kind: unit
        ref: "dist/test/pickup.test.js#the model reads the pointer another editor wrote and respects what this editor has seen"
        status: pass
    human_judgment: false
  - id: D2
    description: "The card's click reopens the chat through openSaved only; it never resumes a run, never auto-resumes, never sends a model request; a cut-off run keeps its own Resume button in the reopened chat"
    requirement: SYNC-07
    verification:
      - kind: unit
        ref: "dist/test/pickup.test.js#a card click that opens the chat calls only openSaved: no receive, no settle, no model request"
        status: pass
      - kind: unit
        ref: "dist/test/pickup.test.js#the chat loads the card helper before chat.js and wires it to the host, and the handler reaches only openSaved"
        status: pass
      - kind: unit
        ref: "dist/test/pickup.test.js#the host accepts exactly the two card messages"
        status: pass
    human_judgment: false
  - id: D3
    description: "The card names the current GSD phase and its next step (discuss, plan, execute, verify, next phase) from the phase folder, as text that is never run; no .planning folder means no phase line"
    requirement: SYNC-07
    verification:
      - kind: unit
        ref: "dist/test/pickup.test.js#the next step follows the files in the phase folder"
        status: pass
      - kind: unit
        ref: "dist/test/pickup.test.js#the card names the current phase and its next step from the planning folder"
        status: pass
      - kind: unit
        ref: "dist/test/pickup.test.js#the card shows the next step as text and only ever posts the two card messages"
        status: pass
    human_judgment: false
  - id: D4
    description: "The card reports the last run's state from any editor: finished, cut off, waiting for an answer, or running elsewhere; the waiting flag is set while an approval is open and cleared when it is answered or the run ends"
    requirement: SYNC-07
    verification:
      - kind: unit
        ref: "dist/test/pickup.test.js#the card reports a run another editor keeps alive: running, waiting, finished or cut off"
        status: pass
      - kind: unit
        ref: "dist/test/pickup.test.js#a run waiting on an approval marks its marker as waiting, and answering clears it"
        status: pass
    human_judgment: false
  - id: D5
    description: "The card works in light, dark and high-contrast themes, with real keyboard-reachable buttons and accessible names, and renders titles as text"
    requirement: SYNC-07
    verification:
      - kind: unit
        ref: "dist/test/pickup.test.js#the card is a labelled region with real buttons, and the click posts exactly the open message"
        status: pass
      - kind: unit
        ref: "dist/test/pickup.test.js#the card styles reuse the setup card and take their colours from the theme"
        status: pass
    human_judgment: true
---

# Phase 27 Plan 14: Pick up where you left off Summary

**A card in the empty chat offers the last chat, its run state and the GSD next step when the project is opened in another editor or on another computer; one click reopens the chat through the history path and starts nothing.**

## What was built

- **Pointer.** `pickup.json` in the state home records the conversation, run and writer. It is written when a run ends in one of the chat's tabs and when a person opens a thread (history or the card). A damaged file means no card.
- **Rule.** The card shows only for a pointer from a different editor id that is newer than this editor's last-seen time (workspaceState). "Not now" remembers the pointer; a newer foreign pointer shows again.
- **Card.** `media/chat/pickup.js` builds a `section` region labelled by its title with real buttons "Open chat" (accessible name starts with the visible label) and "Not now". Every datum is set with `textContent`. A locked thread says "Locked on this device: enter your recovery code to open it" and has no Open button.
- **Run state.** The marker maps to finished, cut off, waiting, or running elsewhere. `RunMarkers.waiting` sets `waitingSince` while any approval or question of the run is open (set in `openPrompt`, cleared when the last prompt closes, and on end or settle). A version 2 marker without the field still parses.
- **GSD.** `nextGsdStep` follows the phase folder (CONTEXT, PLAN, SUMMARY, VERIFICATION or UAT) and is shown as "Next step: run /gsd-plan-phase 3 in the chat". The page never posts it.
- **No spend.** The host handler is `handlePickupAction`, which can only call `openSaved` or `markSeen`. The chat handler block contains none of `settleInterrupted`, `autoResumeChoice` or `receive(` (acceptance grep prints 0), and a test asserts the same of `pickupCard.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] FakeDocument and FakeNode moved to the shared helper in Task 1, not Task 3**
- **Found during:** Task 1 (the tracer's card test needs the DOM stand-in that lived inside setupNudge.test.ts)
- **Fix:** moved both classes to `src/test/helpers/fakeDom.ts` in the Task 1 commit; no setupNudge assertion changed.
- **Files modified:** src/test/helpers/fakeDom.ts, src/test/setupNudge.test.ts
- **Commit:** 0c1810f

**2. [Interface] `pickupCardModel` and `markPickupSeen` take plain dependencies instead of the vscode context**
- The plan wrote `pickupCardModel(context, root)` and `markPickupSeen(context, root, at)`. They take `({ workspaceState, writer, threads, markers }, root)` and `(workspaceState, at)` so the whole host side runs on plain node. `handlePickupAction` was added in Task 1 (the plan listed it in Task 3) because chat.ts needed it for the tracer.

**3. [Test-only] two tests in Task 2 were corrected after the RED commit**
- The fixture tests forgot to write a pointer (the phase is read only when there is a pointer to show). The tests were fixed, not the behaviour.

None otherwise: no architectural change.

## TDD

- Task 2: RED `5e8f563` (3 of 16 failed, on the next-step assertions), GREEN `67ac231`.
- Task 3: RED `b33183f` (5 of 25 failed: state mapping, the waiting flag, the card states, the agent waiting flag, the card CSS), GREEN `74ce013`.
- RED commits carry minimal compile stubs so the tests fail by assertion, not by compile error.

## Verification

- `pickup`, `setupNudge` and `runMarkersForeign`: 46 passing, 0 failing (under the memory cap). `tsc` clean.
- Impacted suites (53 files that touch markers, the bridge, the agent session, the panel or the chat page): 536 tests, 1 failing, the known `chatSendPath` "GSD slash command" failure that reads the real home Teams library.
- Acceptance: `grep -c "asset('pickup.js')" src/services/panelView.ts` is 1; the awk check on the chat handler prints 0; `grep -c "runMarkers?.waiting(" src/services/agentSession.ts` is 2.
- Not run here: the manual phase-gate row (the card appearing in the other editor and one click reopening with no model call); it needs two real editors.

## Known Stubs

None. No placeholder values flow to the UI; the compile stubs used for RED were replaced in the GREEN commits.

## Threat Flags

None beyond the plan's register: T-27-59 (click never resumes or spends; spy test and source assertion), T-27-60 (strict parser, exact keys, id pattern), T-27-61 (textContent only, asserted against innerHTML in pickup.js), T-27-62 (strict pointer parse; any invalid pointer means no card). T-27-SC: no package installed.

## Self-Check: PASSED

- Files exist: src/domain/state/pickup.ts, src/services/pickupCard.ts, media/chat/pickup.js, src/test/pickup.test.ts, src/test/helpers/fakeDom.ts.
- Commits exist: 0c1810f, 5e8f563, 67ac231, b33183f, 74ce013.

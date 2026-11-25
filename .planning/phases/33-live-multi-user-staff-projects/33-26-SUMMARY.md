---
phase: 33-live-multi-user-staff-projects
plan: 26
status: complete
subsystem: the native Staff Room (the pure live model, the room service with the decision stamp and step-up, and the Theia widget)
tags: [workbench, staff, live, staff-room, theia, decisions, step-up, d-21, d-22, d-23, d-24, d-25, d-26, d-44, d-48, d-59, d-60, d-67, d-69, mus-09, post-01]
requires: [33-05, 33-09, 33-12, 33-21, 33-24, 33-25, 33-31]
provides: [staffRoomLive, StaffRoomLiveView, OFFLINE_BANNER_TEXT, UNCONFIRMED_TEXT, JOIN_REQUEST_TEXT, JOIN_WAITING_TEXT, OWNER_PROMPT_TEXT, PREVIEW_COPY_TEXT, WHO_CAN_SEE_TEXT, STAFF_ROOM_ACTION_TEXT, memberNameAt, whoCanSee, STAFF_ROOM_PATH, StaffRoomServer, StaffRoomClient, StaffRoom, StaffDecisionResult, STAFF_ROOM_TEXT, StaffRoomService, bindStaffRoomService, DECISION_WINDOW_MS, StaffRoomEvents, staffRoomView, StaffRoomWidget, StaffRoomContribution]
affects: [33-27, 33-28, 33-29, 33-30]
tech-stack:
  added: []
  patterns: [the live model pure in the domain layer and the widget only drawing it, a decision begun in the backend with its stamp and finished by ticket after the step-up trip, React elements without JSX where no React type package exists]
key-files:
  created:
    - src/domain/staff/staffRoomLive.ts
    - src/test/staffRoomLive.test.ts
    - workbench/extension/src/common/staff-room.ts
    - workbench/extension/src/node/staff/staff-room-service.ts
    - workbench/extension/src/browser/staff/staff-room-view.ts
    - workbench/extension/src/browser/staff/staff-room-widget.ts
    - workbench/extension/src/browser/staff/staff-room.css
    - workbench/test/staff-room-service.test.ts
    - workbench/test/staff-room-widget.test.ts
  modified:
    - workbench/extension/src/node/staff/staff-room-part.ts
    - workbench/extension/src/browser/staff/staff-room-part.ts
    - workbench/extension/src/node/staff/staff-engine.ts
    - workbench/tools/staff-engine-entry.ts
    - workbench/extension/package.json
    - src/test/copyLint.test.ts
    - compliance/gaps.json
key-decisions:
  - "The view is built in the backend with the pure model and sent to every tab; the widget only draws it, and every sentence it shows is a constant of the model, of liveSentences.ts or of STAFF_ROOM_TEXT."
  - "A decision is begun in the backend (the decision stamp of the version on screen, kept 15 minutes under a ticket) and finished by ticket, so the step-up trip through the identity provider and back resumes the same decision or refuses with the D-24 sentence."
  - "The workbench has React through Theia but no React type package, and D-68 adds none; the widget is a ReactWidget whose elements are made with createElement, in .ts files the copy lint reads, instead of .tsx."
  - "Admit, Decline and the single-machine copy answer with a sentence pointing to Share with People until 33-27 wires them into the room; Choose and Propose are wired here."
requirements: [MUS-09, POST-01]
requirements-completed: []
actuals:
  tokens: 23000
  tasks: 3
  commits: 5  # measured from plan_head_before; 33-25 and 33-26 share the branch, this plan's own: 931e6297, 6925f2c3 and e4bbb7e5
plan_head_before: 2353811b9f3800060c5a10815d96eded08cd6699
plan_head_after: e4bbb7e5db643fb6872a9354bffbb73577ebe2c8
completed: 2026-11-24
---

# Phase 33 Plan 26: The native Staff Room Summary

The Staff Room is now a native Sterling panel. A pure live model in the domain layer turns what the engine knows about a shared work into plain data. A backend service builds it for every open shared work and sends it to every tab, and a Theia widget draws it with the owner's lifted cards. The room shows:

- who is here, with their position and a Live or Last seen word;
- the sync sentence with its one action, and the exact offline banner;
- contested cards with both names and reasons;
- product rows with "v5 awaiting decision, 37 changes since", the label and Who can see this.

A decision takes the version's stamp before its dialog opens and is signed by the project's signer for the kind, which is the person key in a hosted session. If another decision folded meanwhile, it refuses with the D-24 sentence and writes nothing. If the confirmation is too old, the answer is the step-up link, and the same decision finishes after the person returns.

## Base and branch

- `feat/phase-33-wave-25-26`, after 33-25 on the same branch (base `2353811b`).
- Step 0, each 1 as the plan expects:
  - `export const SYNC_WORDS` in liveSentences.ts
  - `export function contestedCards` in contested.ts
  - `export class StaffLiveEngine` in staff-live-engine.ts

## Each card's words, as rendered

| Card or row | Words | Actions (button label: accessible name) |
|---|---|---|
| Sync bar | the state word and `syncSentence` (liveSentences.ts), for example "Synced" and "Synced with your organization's server." | one: Sync Now, Show Details, Share with People or Re-admit Your Organization's Server, as `syncAction` gives it |
| Offline banner | "You are offline. Your changes are kept here and will sync when your organization's server is back. Decisions you make now may become contested if someone else decides the same thing." | none |
| People | name, position, and "Live", "Working on {title}. Running {n} agents." or "Last seen HH:MM" (`presenceText`), under the mode's people word ("People", "Roster" in Military mode) | none |
| Contested | contested.ts: "Contested: {name} approved v5 and {name} rejected it at the same time. Neither applies. A new decision is needed.", each decision with its reasons | Approve v5, Reject v5: "Approve v5: v5 of {title}" |
| Decision dialog | the version ("v5 of {product}"), "Your reasons" | Approve, Reject, Cancel |
| Join request (lead or deputy only) | "{name} wants to join. Compare this code with them: {code}", or, before the name is fetched, "Someone wants to join. Admit shows their name and the code to compare with them." | Admit, Decline: "Admit: {name}" |
| Roster split (lead or deputy only) | "The roster was changed in two places at once. The lead or the deputy must choose." and each change as membership.ts describes it | Choose This Change: "Choose This Change: {change}" |
| Needs an update | "This shared work needs a newer version of Sterling. Ask your administrator to update it." | none |
| Preview copy | "This shared work was made shared by an earlier preview, so its products sit where your organization's server reads them. Make a single-machine copy and share that copy again." | Make a Single-Machine Copy |
| Owner prompt (the owner, about 20 changes) | "v5 of {title} has 21 changes since. Propose a new version when the text is ready." | Propose a New Version, Not Now |
| Agent | the agent's name, and the one trust line only where TrustFacts exist | none |
| Product row | title, "v5 awaiting decision, 37 changes since", the label, "Who can see this: {names}" (or "Only you"), and "not yet confirmed by your organization's server" when a decision waits | none |
| Room text | "Staff Room", "No shared work is open in this session." | |

## Deviations from Plan

1. **[Coordinator] Test files are flat:** `workbench/test/staff-room-service.test.ts` and `staff-room-widget.test.ts`.
2. **[Rule 3] No `.tsx`.** The workbench carries React through Theia but has no React type package, and D-68 adds none. So `staff-room-widget.ts` is a ReactWidget whose elements are made with `createElement`.
   - The drawing is a pure function in `staff-room-view.ts`, so the tests render it to markup without a page.
   - The extension build now also copies `src/browser/staff/*.css` (extension `package.json`, one line, shared).
3. **[Rule 3] D-69's copy-lint extension cannot be done here.** The 32.1 plan 21 "no project in Defence text" check and `applyFolderWords` are not on this branch.
   - Added: the copy-lint source scan that keeps literal sentences out of `workbench/extension/src/browser/staff/`.
   - The new sentences say "shared work", and the model test checks no hub, entries or project.
   - The rest is G436.
4. **[Rule 2] The people list has no live source yet.** 33-12 expected the native engine (33-24) to run `LivePresence`, and it does not. The service takes a people source and, until one runs, lists only this person as Live. This is G435.
5. **Admit, Decline and the single-machine copy** answer with a sentence pointing to Share with People. 33-27 owns the admit flow (the request's name and code) and the copy. Choose (`chooseRosterBranch`) and Propose (`VersionActs.propose`) are wired. An owner prompt put away with Not Now stays away for that version in the session.
6. **No agent run source exists in the native backend,** so the room has no agent cards today. The model shows the trust line only where TrustFacts exist (tested).
7. **The room's mode** is the default (Corporate and software) until the native engine reads the shared work's mode; the model already takes it.
8. **Tests first:** the model test and both workbench tests were written with the code, before the first run.
9. **Files outside the plan:**
   - `compliance/gaps.json`: G435 and G436. They are in this branch's reserved range G435 to G439 (first taken as G426 and G427, which Phase 71 already holds).
   - `docs-site/content/security/road-to-production.md`: regenerated from the register by `scripts/build-road-to-production.mjs`.
   - `staff-engine.ts` and `staff-engine-entry.ts`: the `StaffRoomApi` names (see 33-25 deviation 7).

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0, choom and timeout, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set. The workbench runs covered 33-25 and 33-26 together (one branch); see 33-25's table for the runs before the last.

| Run | Result |
|-----|--------|
| Root, run 1 | compile stopped on a test fixture: the trust place used a region that does not exist |
| Root, run 2: `npm run compile`, then staffRoomLive, copyLint, architecture, staffSharedVersionActs and staffEditorBinding, then `npm run lint` | **97 passed, 0 failed**; lint exit 0 |
| Workbench focused, runs 2 to 4 | room service: the contested card's two decisions come in the fold's order, which either may lead, so the test now accepts both orders. The person-decides test now reads the decision from the live engine's copy of the project |
| `npm --prefix workbench run build && npm --prefix workbench test && npm --prefix workbench run lint` | build ok; **178 tests: 178 passed, 0 failed, 0 skipped**, including the bundle scan of `lib/frontend` (no Yjs, replica module or key function in the browser); lint exit 0 |
| `node scripts/build-road-to-production.mjs` then `--check` | page regenerated with G435 and G436; the check passes and every SUMMARY cites its open conditions |

- `staffRoomLive.test.js` has 14 tests (plan: at least 12). `staff-room-widget.test.ts` has 3 (plan: at least 2) and `staff-room-service.test.ts` 6 (plan: at least 5).
- Acceptance checks:
  - `decisionStamp` in staff-room-service.ts: 3
  - `git diff --quiet -- src/test/copy-lint-baseline.json src/test/architecture-baseline.json` from the base: exit 0
- **Tests added: 24** (14 model, 1 copy lint, 6 service and 3 widget). **Tests changed: 0.**

## Threat model

| Threat | As built |
|---|---|
| T-33-N16 | beginDecision takes the stamp in the backend before the dialog opens; decide writes with it, and a decision that folded meanwhile refuses with the D-24 sentence and appends nothing (tested). |
| T-33-N9 | The decision is signed by the project's signer for `version.decide`, the person key through KeyService in a hosted session; a too-old confirmation returns the step-up link, and the same stamp completes after a fresh one (tested with a signer that refuses until confirmed). |
| T-33-N12 | Join requests and roster splits are in the view only on a lead or deputy device (`isRosterWriterAt`), and the engine raises join requests only there (33-24); tested in the model. |
| T-33-SC | No package was installed. |

## Known Stubs

- Admit and Decline in a join card, and Make a Single-Machine Copy, answer "Admitting people is done from Share with People." or "Make a single-machine copy from Share with People." until 33-27 (planned) wires them.
- The people list holds only this person until presence runs (G435).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new RPC path | workbench/extension/src/node/staff/staff-room-service.ts | `/services/sterling-staff-room`: the room's words (names, positions, product titles, labels, who can see a product) to the person's own tabs, and decisions, roster choices and proposals from them, each written as the person through the project's signer. |

## Open conditions

- G435: the native live engine runs no presence yet, so the Staff Room lists only this person.
- G436: the Defence-text folder-word check does not read the staff sentence constants yet (waits for 32.1 plan 21).

## Self-Check: PASSED

- The created files exist (staffRoomLive.ts, staff-room.ts, staff-room-service.ts, staff-room-view.ts, staff-room-widget.ts, staff-room.css and the three test files exist).
- The commits 931e6297, 6925f2c3 and e4bbb7e5 are in HEAD.

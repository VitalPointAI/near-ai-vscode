---
phase: "62"
slug: "work-model-gsd-import-team-board-live-read-and-move"
status: complete
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-02"
---

# Phase 62 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 62-RESEARCH.md "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` on compiled output; real git in temp dirs; `vscodeStub` for adapters; `node:vm` + fake DOM for `media/board/*.js`; e2e via `@vscode/test-electron` |
| **Config file** | none (tsconfig.json: rootDir src, outDir dist) |
| **Quick run command** | `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` |
| **Full suite command** | `npm run lint && npm test` |
| **E2E command** | `npm run compile && env -u ELECTRON_RUN_AS_NODE xvfb-run -a node dist/test/e2e/run.js` (gates from this phase on; always on a hidden xvfb-run screen, never a person's display: run.ts refuses to start otherwise, 62-21) |
| **Estimated runtime** | quick seconds; team family ~3 min; full suite several minutes; e2e a few minutes |

---

## Sampling Rate

- **After every task commit:** quick run on the touched test file(s) plus `npm run lint`
- **After every plan wave:** `node --test dist/test/team*.test.js dist/test/boardClient.test.js`
- **Before `/gsd-verify-work`:** `npm run lint`, full `npm test`, then the e2e command, all green
- **Max feedback latency:** 60 s
- Permission, snapshot-determinism, secret and solo-parity tests block immediately when touched. Never delete, skip or weaken a failing test.

---

## Per-Task Verification Map

Every row passed in the 62-14 gate run (`npm run check`: 1600 tests, 1590 pass, 0 fail, 10 skipped; e2e: project, plain and team scenarios; `npm run verify:release`).

| Plan | Behaviour | Requirement | Test Type | Automated Command | File Exists | Status |
|------|-----------|-------------|-----------|-------------------|-------------|--------|
| 62-03 | GSD parsing incl. variants and hostile input | BOARD-01 | unit | `node --test dist/test/teamGsdImport.test.js` | ✅ | ✅ green |
| 62-02, 62-05 | Live import of this repo's `.planning` from the integration branch; re-import writes 0 events | BOARD-01 | integration | `node --test dist/test/teamImport.test.js` | ✅ | ✅ green |
| 62-02 | Unpushed local drafts never imported | BOARD-01 | integration | `node --test dist/test/teamImportSource.test.js` | ✅ | ✅ green |
| 62-01, 62-04 | Item validators, snapshot round trip, Phase 60/61 hashes unchanged (validators live in `teamItemEvents.test.ts`) | BOARD-01 | unit | `node --test dist/test/teamItemEvents.test.js dist/test/teamItemSnapshot.test.js dist/test/teamMaterialize.test.js` | ✅ | ✅ green |
| 62-06, 62-09 | Board model: columns, lanes, filters, progress, card face and detail | BOARD-01 | unit | `node --test dist/test/teamBoardModel.test.js` | ✅ | ✅ green |
| 62-04 | Ready rule truth table and determinism | BOARD-01 | unit/property | `node --test dist/test/teamWork.test.js` | ✅ | ✅ green |
| 62-07 | A's move visible to B within one poll | BOARD-02 | integration | `node --test dist/test/teamBoardLive.test.js` | ✅ | ✅ green |
| 62-08, 62-13 | Session hook posts state only on change and when visible | BOARD-02 | unit | `node --test dist/test/teamBoardView.test.js` | ✅ | ✅ green |
| 62-14 | Real webview receives state after another client's append | BOARD-02 | e2e | e2e command, scenario `team` | ✅ | ✅ green |
| 62-01, 62-06, 62-04 | Permissions per item event and role (in `teamItemEvents.test.ts`); illegal moves refused on write and read | BOARD-03 | unit + integration | `node --test dist/test/teamItemEvents.test.js dist/test/teamBoardMoves.test.js dist/test/teamItemForgery.test.js` | ✅ | ✅ green |
| 62-14 | A move sent through the real page reaches the host and the next state shows it; a refusal writes no event | BOARD-03 | e2e | e2e command, scenario `team` | ✅ | ✅ green |
| 62-09 to 62-13 | Board client: layouts, Move menu, drag and drop, detail, form, refusal snap-back with live region, reduced motion, text-only rendering | BOARD-01/03 | unit (vm) | `node --test dist/test/boardClient.test.js dist/test/boardMenu.test.js dist/test/boardDrag.test.js dist/test/boardDetail.test.js dist/test/boardForm.test.js` | ✅ | ✅ green |
| 62-14 | Board assets exist, are on the release list and keep the page's safety rules | BOARD-01 | unit | `node --test dist/test/teamBoardAssets.test.js`, `npm run verify:release` | ✅ | ✅ green |
| 62-07, 62-08, 62-14 | Solo parity and manifest; Open Team Board in a project with no team opens nothing | criterion 5 | unit + e2e | `node --test dist/test/teamSoloParity.test.js dist/test/teamManifest.test.js`, e2e scenario `project` | ✅ | ✅ green |
| 62-05 | Privacy canary through import and board items | SEC-01 | integration | `node --test dist/test/teamItemPrivacy.test.js` | ✅ | ✅ green |


### Fix pass (62-15 to 62-25, gap closure for 62-UAT G-62-1 to G-62-7)

Every row below passed in the 62-24 gate run (`npm run check`: lint clean, 1941 tests, 1930 pass, 0 fail, 11 skipped; the full e2e on the default xvfb-run screen: 90 pass, 0 fail (project 8, plain 2, team 7, team-lead 5, team-join 7, team-confirm 4, board 57), after a first full run lost the invite windows to a one-off team-join click refusal that passed alone and again in the full run (deferred-items.md); the screenshot run: 57 board passes, 32 frames; `npm run verify:release`: 274 entries; the invariant command: exit 0).

| Plan | Behaviour | Requirement | Test Type | Automated Command | File Exists | Status |
|------|-----------|-------------|-----------|-------------------|-------------|--------|
| 62-15 T1 | The two assignment bodies, the stored assignee field and the rules confirmed before the first one is signed (recorded decision) | BOARD-03 | unit | `node --test dist/test/teamItemAssign.test.js` | ✅ | ✅ green |
| 62-15 T2 | A lead assigns a plan to a developer on one clone and the developer's clone shows it after one sync; a developer's assignment of someone else is rejected | BOARD-02/03 | integration | `node --test dist/test/teamItemAssign.test.js` | ✅ | ✅ green |
| 62-15 T3 | Eligibility, replace and unassign, removal clears, state moves keep the assignee, snapshots and history; Phase 60 to 62 hashes unchanged | BOARD-03 | unit + integration | `node --test dist/test/teamItemAssign.test.js dist/test/teamItemSnapshot.test.js dist/test/teamAssignHashes.test.js` | ✅ | ✅ green |
| 62-16 T1 | A real Xvfb framebuffer is read and written as a PNG with the same pixels | BOARD-01 | unit | `node --test dist/test/xwdPng.test.js` | ✅ | ✅ green |
| 62-16 T2 | The layout probe measures the real page, names overlap, overflow and readability problems, answers only under the tests and never ships | BOARD-01 | unit + release | `node --test dist/test/boardLayoutProbe.test.js`, `npm run verify:release` | ✅ | ✅ green |
| 62-16 T3 | DevTools Protocol client and real-input drag helpers, local address only, Input domain only | BOARD-03 | unit | `node --test dist/test/cdpClient.test.js` | ✅ | ✅ green |
| 62-17 T1 | No board view in the sidebar; a running session opens nothing; Open Team Board opens the one editor tab | BOARD-01 | unit | `node --test dist/test/teamBoardView.test.js dist/test/teamManifest.test.js` | ✅ | ✅ green |
| 62-17 T2 | The page loses its sidebar-only parts, and the host refuses a page request to open the board | BOARD-01 | unit (vm) | `node --test dist/test/boardClient.test.js dist/test/teamBoardView.test.js` | ✅ | ✅ green |
| 62-17 T3 | The owner's amendments of 2026-11-03 recorded in 62-CONTEXT.md | BOARD-01 | doc check | `grep -c 'amends D-15' .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-CONTEXT.md` | ✅ | ✅ green |
| 62-18 T1 | A lead's running session gives the sidebar Team section the ready, blocked and mine line | BOARD-01 | unit + e2e | `node --test dist/test/teamBoardSummary.test.js`, e2e scenario `board` (sidebar step) | ✅ | ✅ green |
| 62-18 T2 | The summary's rules, live refresh after a teammate's change, and solo parity | BOARD-01/02 | unit + integration | `node --test dist/test/teamBoardSummary.test.js dist/test/teamSession.test.js dist/test/teamSoloParity.test.js` | ✅ | ✅ green |
| 62-19 T1 | An assigned plan sits in Dana's lane with her name and initials, is hers, and is counted in her summary | BOARD-01/03 | unit | `node --test dist/test/teamBoardAssignModel.test.js` | ✅ | ✅ green |
| 62-19 T2 | planAssign, the person list, offered actions, refusals, history sentences and the detail's assignee | BOARD-03 | unit | `node --test dist/test/teamBoardAssignModel.test.js` | ✅ | ✅ green |
| 62-19 T3 | Planless phases are Backlog cards; active and upcoming work open, finished work folded | BOARD-01 | unit | `node --test dist/test/teamBoardPhaseCards.test.js dist/test/teamBoardSummary.test.js` | ✅ | ✅ green |
| 62-20 T1 | Assign to... in the Move menu, Dana picked from the host's list, the card comes back in her lane | BOARD-03 | unit + e2e | `node --test dist/test/teamBoardAssignView.test.js dist/test/boardMenu.test.js`, e2e scenario `board` (Assign to... with real keys) | ✅ | ✅ green |
| 62-20 T2 | Unassign, the detail's Assigned to and its buttons, and every refusal path | BOARD-03 | unit (vm) + e2e | `node --test dist/test/boardDetail.test.js dist/test/boardMenu.test.js dist/test/teamBoardAssignView.test.js`, e2e scenario `board` (Unassign with real keys) | ✅ | ✅ green |
| 62-20 T3 | The person on the card face, Move to... for assign-only cards, Mine wording, a teammate sees it within one poll | BOARD-02/03 | unit + integration + e2e | `node --test dist/test/boardClient.test.js dist/test/teamBoardLive.test.js`, e2e scenario `board` (Dana's computer reads the assignment) | ✅ | ✅ green |
| 62-21 T1 | On a hidden virtual screen the full-width board has no overlap the probe names; the runner refuses a real display | BOARD-01 | e2e + unit | e2e command, scenario `board`; `node --test dist/test/boardLayoutProbe.test.js` | ✅ | ✅ green |
| 62-21 T2 | Folded columns hold no cards, titles wrap between words, the card's main button looks like the card | BOARD-01 | unit (vm) + e2e | `node --test dist/test/boardClient.test.js dist/test/boardLayoutProbe.test.js`, e2e scenario `board` | ✅ | ✅ green |
| 62-21 T3 | Open on active work: folded defaults from the model, versioned saved choices, cards on the first screen | BOARD-01 | unit + e2e | `node --test dist/test/boardClient.test.js dist/test/teamBoardView.test.js`, e2e scenario `board` (first open) | ✅ | ✅ green |
| 62-22 T1 | Dark theme at four widths, each settled, problem-free and photographed, with screens/index.json | BOARD-01 | e2e + unit | screenshot run (below); `node --test dist/test/x11Window.test.js` | ✅ | ✅ green |
| 62-22 T2 | Four themes, scrolled and focused views, Done open, detail, menu and Group by Phase | BOARD-01 | e2e | screenshot run (below) | ✅ | ✅ green |
| 62-23 T1 | A real mouse drag puts a Ready card on hold: one move request, one more signed event | BOARD-03 | e2e + unit (vm) | e2e scenario `board`; `node --test dist/test/boardDrag.test.js` | ✅ | ✅ green |
| 62-23 T2 | Refused drops snap back with the reason, another row is refused helpfully, Escape cancels, frames saved | BOARD-03 | e2e + unit (vm) | e2e scenario `board`; `node --test dist/test/boardDrag.test.js` | ✅ | ✅ green |
| 62-25 T1 | Self-assignment rules confirmed before any client accepts them (recorded decision) | BOARD-03 | unit | `node --test dist/test/teamPermissions.test.js` | ✅ | ✅ green |
| 62-25 T2 | A developer assigns a card to themselves on their clone, the lead's clone shows it after one sync, then they take themselves off | BOARD-02/03 | integration + e2e | `node --test dist/test/teamSelfAssign.test.js`, e2e scenario `board` (Dana assigns herself from her own computer) | ✅ | ✅ green |
| 62-25 T3 | Every role and case on write and read, the 62-15 tests kept, and the permission table | BOARD-03 | unit + integration | `node --test dist/test/teamSelfAssign.test.js dist/test/teamItemAssign.test.js dist/test/teamPermissions.test.js dist/test/teamAssignHashes.test.js` | ✅ | ✅ green |
| 62-24 T1 | A realistic board in the real window (Dana and Lee joined, blocked, held and assigned cards), Assign to... and Unassign through real keys, Dana's computer reads it, Dana assigns herself and cannot assign Lee | BOARD-01/02/03 | e2e | e2e scenario `board` | ✅ | ✅ green |
| 62-24 T2 | The final screenshot set on the realistic board, every board frame probe-checked, with an index saying what to look at | BOARD-01 | e2e | screenshot run (below) | ✅ | ✅ green |
| 62-24 T3 | The phase gate: lint, full npm test, every e2e scenario, the screenshot run, the release check and the invariants | all | gate | `npm run check`; e2e command; screenshot run; `npm run verify:release`; invariant command in 62-24-PLAN.md | ✅ | ✅ green |

Screenshot run: `npm run compile && D=$(mktemp -d) && env -u ELECTRON_RUN_AS_NODE NEAR_AI_E2E_ONLY=board NEAR_AI_E2E_FBDIR="$D" xvfb-run -a -s "-screen 0 1920x1080x24 -fbdir $D" node dist/test/e2e/run.js; rm -rf "$D"` (frames in `.vscode-test/screens/`, listed in `index.json`).

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] GSD fixture directory (real-shape ROADMAP, PLAN variants, SUMMARY, decimal phase, CRLF, hostile PLAN) and `teamGsdImport.test.ts`
- [x] `teamImport`, `teamImportSource`, `teamItemValidate`, `teamItemSnapshot`, `teamItemPermissions`, `teamItemForgery`, `teamItemPrivacy`, `teamWork`, `teamBoardModel`, `teamBoardMoves`, `teamBoardLive`, `teamBoardView`, `boardClient` test files
- [x] Shared fake DOM helper for webview client tests (keydown, drag events with dataTransfer, focus, ResizeObserver stub)
- [x] Item builders in `teamEvents.ts` / `teamHarness.ts`; `vscodeStub` support for webview view/panel and `setContext`
- [x] E2E board tests in `src/test/e2e/suite.ts`; `board.js` / `board.css` in `scripts/verify-release-content.mjs`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Board look and feel with a screen reader and keyboard only | BOARD-01 | real assistive technology | Open the board, move a card with keyboard only, confirm announcements and focus order |
| Two real windows: A's move appears on B within one poll | BOARD-02 | real windows and git remote | Two clones, Team Mode on, move a card in A, watch B (the e2e proves the same path with a second client in one window) |
| Light, dark and high contrast themes; drag target highlights; 200 px sidebar and 400 percent zoom; density with about 100 items and a 30-card cell | BOARD-01 | real eyes and real themes | Open the board in each theme, resize the sidebar and zoom, import this repository's roadmap |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** automated gate green in 62-14; the owner-only manual checks above remain

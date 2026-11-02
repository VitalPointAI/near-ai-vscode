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
| **E2E command** | `npm run compile && env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js` (gates from this phase on) |
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

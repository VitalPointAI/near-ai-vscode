---
phase: "62"
slug: "work-model-gsd-import-team-board-live-read-and-move"
status: draft
nyquist_compliant: false
wave_0_complete: false
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

Task IDs are filled in by the planner; rows are per behaviour until then.

| Behaviour | Requirement | Test Type | Automated Command | File Exists | Status |
|-----------|-------------|-----------|-------------------|-------------|--------|
| GSD parsing incl. variants and hostile input | BOARD-01 | unit | `node --test dist/test/teamGsdImport.test.js` | ❌ W0 | ⬜ pending |
| Live import of this repo's `.planning` from the integration branch; re-import writes 0 events | BOARD-01 | integration | `node --test dist/test/teamImport.test.js` | ❌ W0 | ⬜ pending |
| Unpushed local drafts never imported | BOARD-01 | integration | `node --test dist/test/teamImportSource.test.js` | ❌ W0 | ⬜ pending |
| Item validators, snapshot round trip, Phase 60/61 hashes unchanged | BOARD-01 | unit | `node --test dist/test/teamItemValidate.test.js dist/test/teamItemSnapshot.test.js dist/test/teamMaterialize.test.js` | ❌ W0 / partly | ⬜ pending |
| Board model: columns, lanes, filters, progress, card face and detail | BOARD-01 | unit | `node --test dist/test/teamBoardModel.test.js` | ❌ W0 | ⬜ pending |
| Ready rule truth table and determinism | BOARD-01 | unit/property | `node --test dist/test/teamWork.test.js` | ❌ W0 | ⬜ pending |
| A's move visible to B within one poll | BOARD-02 | integration | `node --test dist/test/teamBoardLive.test.js` | ❌ W0 | ⬜ pending |
| Session hook posts state only on change and when visible | BOARD-02 | unit | `node --test dist/test/teamBoardView.test.js` | ❌ W0 | ⬜ pending |
| Real webview receives state after another client's append | BOARD-02 | e2e | e2e command | ❌ W0 | ⬜ pending |
| Permissions per item event and role; illegal moves refused on write and read | BOARD-03 | unit + integration | `node --test dist/test/teamItemPermissions.test.js dist/test/teamBoardMoves.test.js dist/test/teamItemForgery.test.js` | ❌ W0 | ⬜ pending |
| Board client: layouts, Move menu, drag and drop, refusal snap-back with live region, reduced motion, text-only rendering | BOARD-01/03 | unit (vm) | `node --test dist/test/boardClient.test.js` | ❌ W0 | ⬜ pending |
| Solo parity and manifest | criterion 5 | unit | `node --test dist/test/teamSoloParity.test.js dist/test/teamManifest.test.js` | ✅ extend | ⬜ pending |
| Privacy canary through import and board items | SEC-01 | integration | `node --test dist/test/teamItemPrivacy.test.js` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] GSD fixture directory (real-shape ROADMAP, PLAN variants, SUMMARY, decimal phase, CRLF, hostile PLAN) and `teamGsdImport.test.ts`
- [ ] `teamImport`, `teamImportSource`, `teamItemValidate`, `teamItemSnapshot`, `teamItemPermissions`, `teamItemForgery`, `teamItemPrivacy`, `teamWork`, `teamBoardModel`, `teamBoardMoves`, `teamBoardLive`, `teamBoardView`, `boardClient` test files
- [ ] Shared fake DOM helper for webview client tests (keydown, drag events with dataTransfer, focus, ResizeObserver stub)
- [ ] Item builders in `teamEvents.ts` / `teamHarness.ts`; `vscodeStub` support for webview view/panel and `setContext`
- [ ] E2E board tests in `src/test/e2e/suite.ts`; `board.js` / `board.css` in `scripts/verify-release-content.mjs`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Board look and feel with a screen reader and keyboard only | BOARD-01 | real assistive technology | Open the board, move a card with keyboard only, confirm announcements and focus order |
| Two real windows: A's move appears on B within one poll | BOARD-02 | real windows and git remote | Two clones, Team Mode on, move a card in A, watch B |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

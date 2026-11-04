---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 16
subsystem: testing
tags: [team-mode, board, e2e, xvfb, xwd, png, layout-probe, devtools-protocol, real-input-drag, g-62-2, g-62-4, g-62-6, g-62-7]
status: complete

requires:
  - phase: 61-22
    provides: "Phase 61 fix pass complete"
  - phase: 62-15
    provides: "Assignment events (no code dependency; same fix pass)"
provides:
  - "src/test/e2e/xwdPng.ts: readXwd, encodePng, cropImage, xwdToPng, captureScreen (Xvfb -fbdir framebuffer to PNG, Node built-ins only)"
  - "media/board/layout-probe.js: test-only window.NearAiBoardLayout { collect, check, measure } and the e2e-layout / e2e-layout-report responder, gated on body data-e2e=\"1\""
  - "src/test/e2e/cdp.ts: connectCdp, workbenchTarget, webviewFrameRect, mouseDrag, interceptedDrag, pressKey (DevTools Protocol over the global WebSocket)"
  - ".vscodeignore drops media/board/layout-probe.js; verify-release-content.mjs fails if extension/media/board/layout-probe.js is packaged"
affects: [62-21, 62-22, 62-23]

actuals:
  tokens: 23296
  tasks: 3
  commits: 8
plan_head_before: 28b62c1a07143eba8b77f1466649b5abb8811e36
plan_head_after: 242bccd316302565e148e022aae0bd82dbfd1d04

tech-stack:
  added: []
  patterns:
    - "Test-only page scripts are gated on body data-e2e=\"1\", excluded by name in .vscodeignore, and forbidden by the release check"
    - "The layout probe splits reading (collect, plain numbers and strings) from judging (check, pure), so every rule is proven on hand-made measurements"
    - "Real-window input goes through the DevTools Input domain only; no DOM events are made inside the page"

key-files:
  created:
    - src/test/e2e/xwdPng.ts
    - src/test/xwdPng.test.ts
    - media/board/layout-probe.js
    - src/test/boardLayoutProbe.test.ts
    - src/test/e2e/cdp.ts
    - src/test/cdpClient.test.ts
  modified:
    - .vscodeignore
    - scripts/verify-release-content.mjs

key-decisions:
  - "The probe answers through NearAiBoard.onMessage and NearAiBoard.post (the page's one VS Code API); it never calls acquireVsCodeApi"
  - "measure waits two frames, each bounded by a 50 ms timer, because a hidden webview stops animation frames and the e2e must never hang"
  - "A scroll request scrolls the board region, and the page itself when the region is not a vertical scroller, so the probe can see today's cards-behind-the-toolbar bug as well as the fixed layout"
  - "action 'rects' returns positions only (no rules, no word measuring) for fast drag aiming; 'measure', 'scroll' and 'focus' run every rule"
  - "One rule that names many things lists at most 12 sentences and then one 'And N more' line, so a badly broken board still gives a readable report"
  - "connectCdp refuses any debugger address that is not ws://127.0.0.1 or ws://localhost (T-62-55)"
  - "readXwd caps each side at 16384 px and checks header_size, ncolors, bytes_per_line and the file length before allocating (T-62-56)"

patterns-established:
  - "Probe sentences are plain and dash-free, e.g. 'Cell Unassigned / Backlog spills 120 px below its lane'"

requirements-completed: [BOARD-01, BOARD-03]

coverage:
  - id: D1
    description: "A real Xvfb screen becomes a PNG the owner can open (XWD reader for 24 and 32 bit, either byte order, padded rows; PNG writer with zlib and CRC-32; crop)"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/xwdPng.test.ts#a 32 bit XWD with padded rows converts to a PNG with valid chunks and exactly the six colours"
        status: pass
      - kind: integration
        ref: "src/test/xwdPng.test.ts#a real Xvfb screen is saved as a 64 by 48 PNG whose every pixel is white"
        status: pass
    human_judgment: false
  - id: D2
    description: "The board layout probe names sideways scroll, a see-through or covering toolbar, spilling or overlapping headers, lanes, cells and cards, the header row after a scroll, a hidden focused card, no work on the first screen and unreadable cards"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/boardLayoutProbe.test.ts (8 rule tests: page, toolbar, column header, lane and cell, card, scroll and focus, readability, clean board)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The probe answers only on a page marked for the extension-host tests and never ships in the package"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/boardLayoutProbe.test.ts#the page answers e2e-layout with exactly one e2e-layout-report carrying the documented keys, only when the host marked it for the tests"
        status: pass
      - kind: unit
        ref: "src/test/boardLayoutProbe.test.ts#the probe never ships: .vscodeignore drops it and the release check fails when it is in the package"
        status: pass
      - kind: other
        ref: "npm run verify:release (268 entries, no layout-probe.js in the VSIX)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A DevTools Protocol client finds the VS Code window, locates the webview frame and drags with real mouse input (with an intercepted-drag fallback), sending only Input domain commands"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/cdpClient.test.ts (11 tests: target choice, replies, errors, close, timeout, local-only address, mouseDrag, interceptedDrag success and give-up, webviewFrameRect, pressKey, static Input-only check)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The probe's measurements and the drag helpers are correct against a real Chromium page in a real VS Code window"
    verification: []
    human_judgment: true
    rationale: "Nothing loads the probe or opens a DevTools port yet: the host hook arrives in 62-21 and the real-window drag in 62-23. Those plans prove the tools on the real board; this plan proves them on the fake DOM and a fake socket."

duration: 18min
completed: 2026-11-04
---

# Phase 62 Plan 16: Verification Tools Summary

**Three test-only tools for proving the board in a real window: an Xvfb framebuffer (XWD) to PNG converter on node:zlib, a board layout probe whose pure check() turns real measurements into plain overlap, overflow and readability sentences, and a DevTools Protocol client that drags with Input.dispatchMouseEvent; the probe is excluded from the package and the release check enforces it.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-11-04T00:33:57Z
- **Completed:** 2026-11-04T00:52:20Z
- **Tasks:** 3 of 3
- **Files created or modified:** 8

## Accomplishments

- `captureScreen(fbdir, outFile, crop?)` saves a running Xvfb screen as a PNG. It was checked against a real Xvfb (`-displayfd`, `-screen 0 64x48x24`, `-fbdir`, `-wr`) on this host, not skipped.
- `window.NearAiBoardLayout.check(data)` covers every rule in the plan, each with its own sentence. The rules include sideways page scroll (list layout, and outside the board region in the kanban), a toolbar that is not opaque, covers cards or the region, or is taller than 40 percent of the page, header and lane spills and overlaps, cells off their header or outside their lane, card spills, overlaps and content overflow, the header row after a scroll, a focused card under the headers, and no work on the first screen. The readability rules (G-62-7) catch cards inside folded cells, cards with no size or a zero font size, split title words and card buttons that look like buttons.
- The page answers `{ type: 'e2e-layout', id, action }` with exactly one `{ type: 'e2e-layout-report', id, report }` carrying the documented keys, and only when the host marked the page with `data-e2e="1"`.
- `mouseDrag` sends press, held moves and release, all through Input.dispatchMouseEvent. `interceptedDrag` turns on Input.setInterceptDrags, waits for Input.dragIntercepted, then drops with Input.dispatchDragEvent at the target. `webviewFrameRect` finds the board's webview iframe in the workbench page.

## Task Commits

1. **Task 1 (tracer): Xvfb framebuffer to PNG**
   - `17f4600` test(62-16): add failing tests for the framebuffer to PNG converter (RED)
   - `85e114b` feat(62-16): convert an Xvfb framebuffer file to a PNG with Node built-ins (GREEN)
2. **Task 2: board layout probe**
   - `069f2d0` test(62-16): add failing tests for the board layout probe (RED)
   - `391fb4f` feat(62-16): board layout probe that names every overlap and overflow, kept out of the package (GREEN)
3. **Task 3: DevTools Protocol client**
   - `909f162` test(62-16): add failing tests for the DevTools Protocol client and real-input drags (RED)
   - `242bccd` feat(62-16): DevTools Protocol client that drags with real mouse input (GREEN)

No REFACTOR commits: nothing needed cleaning after GREEN.

The measured count from `plan_head_before` is 8. That includes two planning commits the orchestrator made on this branch while the plan ran (`f18e0b6` docs(62): plan self-assignment..., `271a815` docs(62): owner confirms the self-assignment takeover rule). This plan made 6 commits.

## TDD Gate Compliance

- **Task 1 RED** (`17f4600`): `node --test --test-reporter=tap dist/test/xwdPng.test.js` exited 1 with 6 tests, 1 pass and 5 fail. `gsd-tools check tdd-red-evidence` returned RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the target "a 32 bit XWD with padded rows..." ran and failed on the PNG signature assertion, because the stub converter returned an empty buffer. The real Xvfb test ran (not skipped) and failed on width 0, expected 64. One test passed by accident in RED, because both sides of its equality were the stub's empty output. There was no build, load or fixture fault. A first RED attempt used stubs that threw "not implemented yet", and the classifier rejected that report as invalid_record, so the stubs were changed to return empty results, giving assertion failures.
- **Task 1 tracer gate (auto mode):** the verify command was re-run after GREEN with 6 of 6 passing and the real Xvfb test run, so expansion went ahead.
- **Task 2 RED** (`069f2d0`): exited 1 with 11 tests, 2 pass and 9 fail. RED_EVIDENCE_OK on the target "toolbar rules...". Semantic assessment: the target failed on the planned assertion "exactly one problem, got: none" from the stub check(). The page test failed on "exactly one answer", since the stub had no responder, and the packaging test failed on the missing .vscodeignore line. The clean-board test and the static safety test passed against the stub as expected.
- **Task 3 RED** (`909f162`): exited 1 with 11 tests, 1 pass and 10 fail. RED_EVIDENCE_OK on the target "mouseDrag presses at the start...". Semantic assessment: the target failed on its deep-equal of the sent mouse events, because the do-nothing stub sent nothing. The static Input-only test passed against the stub as expected.
- **GREEN:** `85e114b` passed 6 of 6, `391fb4f` passed 47 of 47 (probe, assets and client), and `242bccd` passed 11 of 11.

## Files Created/Modified

- `src/test/e2e/xwdPng.ts`: XWD reader and PNG writer, crop, and capture from `<fbdir>/Xvfb_screen0`
- `src/test/xwdPng.test.ts`: hand-built XWD files, a PNG chunk walker with CRC checks, and the real Xvfb test
- `media/board/layout-probe.js`: test-only probe (collect, check, measure) and the e2e-layout responder
- `src/test/boardLayoutProbe.test.ts`: 11 tests for the rules on hand-made data, gating, message shape, page safety rules and packaging
- `src/test/e2e/cdp.ts`: DevTools Protocol client and the real-input drag and key helpers
- `src/test/cdpClient.test.ts`: 11 tests against a fake socket
- `.vscodeignore`: `media/board/layout-probe.js`
- `scripts/verify-release-content.mjs`: forbidden pattern `/^extension\/media\/board\/layout-probe\.js$/`

## Decisions Made

See key-decisions in the frontmatter. In short: the probe reuses NearAiBoard's post and onMessage, every wait is bounded (frames, socket open, replies, drag interception), the probe can see today's broken page scroll as well as the fixed region scroll, and the DevTools client connects only to this computer.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The page-answer test advanced fake time only once for the focus request**
- **Found during:** Task 2 GREEN
- **Issue:** measure() waits two animation frames with a promise step between them. Each step is a fake timer, and the next frame is only asked for after a microtask, so one `advance` followed by one `setImmediate` answered the first request but not the second.
- **Fix:** added a bounded `settle(h)` helper (4 turns of advance(60) then setImmediate) and used it for all three requests. The assertions stayed the same: exactly one answer per request, and none without data-e2e.
- **Files modified:** src/test/boardLayoutProbe.test.ts
- **Commit:** 391fb4f

**2. [Rule 3 - Blocking] Two cases cannot break exactly one rule**
- **Found during:** Task 2 RED authoring
- **Issue:** two column headers cannot overlap while both cells still line up and stay apart, and two cells cannot overlap while both still line up under their headers. A neighbouring rule always breaks too.
- **Fix:** those two cases use `expectAmong`, which requires exactly one matching problem and allows the others. Every other rule uses `expectOne`, which requires exactly one problem in total.
- **Files modified:** src/test/boardLayoutProbe.test.ts
- **Commit:** 069f2d0

---

**Total deviations:** 2 auto-fixed (1 bug in a test's timing, 1 blocking test-design constraint). **Impact:** no rule was weakened. Both changes are in test mechanics only.

## Issues Encountered

- The TDD RED classifier rejects node:test TAP reports where tests fail by throwing an error instead of failing an assertion ("Non-TAP data in report"). RED stubs now return empty values instead of throwing.

## Verification

- Task 1: `npx tsc -p tsconfig.json && node --test dist/test/xwdPng.test.js` passed 6 of 6, 0 skipped. The real Xvfb test ran. The only imports are from `node:` modules (grep count 0), and package-lock.json is unchanged since 7b3a441.
- Task 2: `node --test dist/test/boardLayoutProbe.test.js dist/test/teamBoardAssets.test.js dist/test/boardClient.test.js` passed 47 of 47. `npm run verify:release` exited 0 ("Release content verified: 268 entries, 191 runtime JavaScript files, and 51 required release assets"), and the VSIX has no layout-probe.js. `layout-probe` appears in both .vscodeignore and verify-release-content.mjs. The sink grep on the probe counts 0, and `grep -c "^test("` on the probe test counts 11 (at least 8 needed).
- Task 3: `node --test dist/test/cdpClient.test.js` passed 11 of 11. The `new DragEvent|dispatchEvent` grep on cdp.ts counts 0, and `Input.dispatchMouseEvent` appears 2 times.
- Plan level: package.json and package-lock.json are unchanged since plan_head_before.
- Full suite (`npm test` under the 6G cgroup cap): 1810 tests, 1800 pass, 0 fail, 10 skipped. All 10 skips are environment skips that were there before (live NEAR AI keys, LibreOffice, ripgrep, an Open-GSD runtime, live NEAR team).

## Known Stubs

None. The RED stubs were replaced in their GREEN commits.

## Threat Flags

None beyond the plan's threat register. T-62-54 is mitigated by .vscodeignore, the release check and the data-e2e gate. T-62-55 is mitigated by keeping the client under src/test and connecting to 127.0.0.1 only. T-62-56 is mitigated by size checks before allocating. T-62-SC is mitigated by adding no installs.

## User Setup Required

None.

## Next Phase Readiness

- 62-21 can load `media/board/layout-probe.js` after board.js under NEAR_AI_E2E=1 (from the source tree, since it is not packaged) and send `e2e-layout` messages.
- 62-22 can call `captureScreen(fbdir, out, crop)` while `xvfb-run -a -s "-screen 0 WxHx24 -fbdir DIR"` runs, cropping to the webview using `webviewFrameRect`.
- 62-23 can call `connectCdp(port)` against a VS Code launched with `--remote-debugging-port` on 127.0.0.1, aim with the probe's `rects`, and drag with `mouseDrag`, falling back to `interceptedDrag`.

## Self-Check: PASSED

- All 6 created files and both modified files exist.
- Commits 17f4600, 85e114b, 069f2d0, 391fb4f, 909f162 and 242bccd are ancestors of HEAD.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*

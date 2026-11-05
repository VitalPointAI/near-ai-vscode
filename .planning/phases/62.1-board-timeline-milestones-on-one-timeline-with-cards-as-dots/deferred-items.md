# Phase 62.1 deferred items

## From 62.1-08 (real-window timeline run)

- **ResizeObserver loop notice at the 520 px breakpoint (board.js, pre-existing since 62-21).** `board.js` line 1226 calls `setLayout()`, which calls `render()`, inside its ResizeObserver callback. Chromium then reports `ResizeObserver loop completed with undelivered notifications.` as a page error. The 62-23 board scenario takes its error baseline after its resizes for the same reason. The 62.1-08 timeline run checks that no page error appears during the real input, the move, the teammate's change and the frame set. The narrow step prints the notice instead of failing on it. A fix would run the render in the next animation frame. That changes when the 16 vm tests that call `setWidth()` see the new layout, so it was left out of 62.1-08's scope. Owner or 62.1-09 to decide. Ledger: WINDOWS.md, kind deviation.

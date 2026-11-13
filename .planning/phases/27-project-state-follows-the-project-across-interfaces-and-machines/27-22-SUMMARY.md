---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 22
subsystem: chat-panel-layout
tags: [gap-closure, G-27-4a, G-27-4c, layout-probe, sync-control, webview, extension-host-test]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-18 sync control (renderSyncControl, SyncControlModel, #sync-live) and the 27-16 extension-host layout test"
provides:
  - "layout-probe.js reports `clipped`: data-must-read controls whose text does not fit; the 'every panel fits narrow widths' extension-host test fails on any such report in all five sync states at all eight side bar widths"
  - "Composer bar that wraps at every width: profile and sync never shrink below their text and wrap their own words instead of an ellipsis; a row break puts the pickers and buttons on the next row up to 480 px"
  - "SyncControlModel.detail for 'attention' and a visible #sync-detail line under the control, linked to the button with aria-describedby"
  - "Unit guards for the label budget and the chat.css layout rules"
affects: [27-23, 27-24, 27-25, verify-work]

requirements-completed: [SYNC-05, SYNC-09]

actuals:
  tokens: 5205
  tasks: 3
  commits: 5
plan_head_before: d0791681fe5bb996bc4b3d11f545fb7e76b628e2
plan_head_after: 81adefe33d7f1fcbb1b24a13a570e20baab62697

tech-stack:
  added: []
  patterns:
    - "A must-read marker (data-must-read) that the test-only layout probe checks for clipped text, so a control that matters cannot be cut to an ellipsis unnoticed"
    - "The extension-host layout test drives the page through every state with the host's own message builder (syncStatusMessage from dist), so the real words are measured"
    - "Chips a person must read whole never shrink and wrap their words rather than clip"

key-files:
  created: []
  modified:
    - media/shared/layout-probe.js
    - src/services/layoutProbe.ts
    - src/test/e2e/suite.ts
    - media/chat/chat.css
    - src/services/panelView.ts
    - src/domain/state/syncStatus.ts
    - media/chat/syncControl.js
    - src/test/syncControl.test.ts
    - src/test/responsivePanels.test.ts
    - src/test/helpers/fakeDom.ts

key-decisions:
  - "#profile and #sync wrap their own text at every width (white-space normal, overflow-wrap anywhere) rather than only at 260 px and below, so a long profile name or label can never be cut, not just at the narrowest widths"
  - "The bar wraps at every width; the row break is hidden above 480 px so a wide editor panel keeps one row when the chips and pickers fit"
  - "#sync-detail is marked data-must-read: it wraps by design, so the probe can only report it if the design breaks, which is the strongest guard"
  - "The 27-16 narrow-width assertion in responsivePanels.test.ts was changed deliberately: the bar now wraps outside any media query, and the test pins that instead of the old 260 px-only wrap"

patterns-established:
  - "Fix the class: a test-only probe check plus a markup attribute, instead of one more pixel tweak for the one reported width"

coverage:
  - id: D1
    description: "At every chat side bar width the extension-host tests reach (170 to 590 px, 290 px included), in each of the five sync states, the sync control and the profile chip show their whole text; profile and sync sit together on their own row and the pickers and buttons take the next row"
    requirement: SYNC-05
    verification:
      - kind: e2e
        ref: "npm run test:e2e: [project] every panel fits narrow widths without scrolling sideways (chat measured at 170, 230, 290, 350, 410, 470, 530, 590 px in off, syncing, synced, attention, no-home)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A real-window regression check for the class: the probe reports must-read controls whose text is clipped and the layout test fails on any report"
    requirement: SYNC-09
    verification:
      - kind: e2e
        ref: "RED run before the CSS change failed with 71 clipped lines; the run after passes at every width"
        status: pass
    human_judgment: false
  - id: D3
    description: "When sync needs attention, its plain sentence is visible text under the control, linked with aria-describedby, and hidden and empty in every other state"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "src/test/syncControl.test.ts#rendering attention shows the sentence as text in #sync-detail and describes the button by it; the next state empties, hides and unlinks it"
        status: pass
      - kind: unit
        ref: "src/test/syncControl.test.ts#a sentence with a password in a URL or a GitHub token reaches the page redacted in the detail too"
        status: pass
    human_judgment: false
  - id: D4
    description: "Fast guards: the label budget (at most 26 characters) and the chat.css layout rules"
    verification:
      - kind: unit
        ref: "src/test/syncControl.test.ts#label budget / #chat.css guard"
        status: pass
    human_judgment: false
  - id: D5
    description: "How the wrapped chips and the detail line look in a real window at 290 px (a person's eye on spacing and wrapping, which the clipping probe cannot judge)"
    verification: []
    human_judgment: true
    rationale: "The probe proves no text is cut and nothing scrolls sideways; whether the wrapped chips and the red detail line look right in the owner's theme is a visual judgment"

duration: 34min
completed: 2026-11-13
---

# Phase 27 Plan 22: Sync control and profile chip whole at every side bar width Summary

**The sync control, the profile chip and the attention sentence are fully readable at every chat side bar width, and a probe-backed extension-host test now fails on any must-read control whose text is clipped, in every sync state.**

## Performance

- **Duration:** about 34 min (start time approximated from the first scratch file)
- **Started:** 2026-11-13T19:29:00Z
- **Completed:** 2026-11-13T20:03:00Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- **G-27-4a closed.** The bar wraps at every width. `#profile` and `#sync` have `flex: none; max-width: 100%` and wrap their own words, so "Sync off · Turn on" and a 24-character profile name are whole at 290 px and at every other width. A row break (`.bar-break`, hidden above 480 px) puts the model and approval pickers and the buttons on the next row.
- **The class is guarded, not just the instance.** `layout-probe.js` reports `clipped` for `data-must-read` controls (`#profile`, `#sync`, `#sync-detail`) whose scrollWidth exceeds clientWidth. The extension-host test posts a realistic profile-status and the host's own `syncStatusMessage` for each of the five states at each of the eight side bar widths and fails on any clipped entry, offender or sideways scroll.
- **G-27-4c closed.** `SyncControlModel.detail` carries the plain (already redacted) sentence for `attention`; `renderSyncControl` fills `#sync-detail` with `textContent`, shows it and sets `aria-describedby="sync-detail"` on the button. Every other state empties, hides and unlinks it. The same one button and one detail element are reused.
- **Fast guards.** Label budget (at most 26 characters, measured against the longest real label) and a chat.css parse that pins wrap-at-every-width, the no-shrink and no-cap rule for the two chips, the 480 px row break and the full-row detail line. Mutation check: capping `#profile, #sync` at 45% makes the guard fail.

## RED evidence (before the CSS change, extension-host run at commit 34fa8d3)

The new check against the old layout reported, at the default 290 px side bar:

```
chat at 290px (off): clipped button#sync.chip text "Sync off · Turn on" needs 131px in 96px
chat at 290px: clipped button#profile.chip text "Research-Team-Profile-01" needs 171px in 26px
chat at 290px (attention): clipped button#sync.chip text "Needs attention" needs 111px in 94px
chat at 290px (no-home): clipped button#sync.chip text "No online home · Set up" needs 164px in 96px
```

71 clipped lines in all, at every width (the profile chip was cut at every width up to 590 px). Run after the CSS change (4f63d92) and again with the detail line (77cc0e5, tests at 81adefe): exit 0, no clipped line, chat measured at 170, 230, 290, 350, 410, 470, 530, 590 px, both the `project` and `plain` scenarios passing.

TDD for Task 2: RED commit 7581ad9 (6 of 7 new tests failed on the planned assertions; the seventh, a page without the detail line, passed as a baseline), GREEN commit 77cc0e5 (79 of 79 pass in the plan's verify set).

## Task Commits

1. **Task 1: Tracer (layout probe, e2e guard, CSS)** - `34fa8d3` (test, RED), `4f63d92` (fix, GREEN)
2. **Task 2: Attention sentence as visible text** - `7581ad9` (test, RED), `77cc0e5` (feat, GREEN)
3. **Task 3: Fast guards** - `81adefe` (test; no chat.css change was needed because every guard held), then the second extension-host run

**Plan metadata:** the docs commit that adds this SUMMARY and the state files.

## Files Created/Modified

- `media/shared/layout-probe.js` - `clipped` list for `data-must-read` controls
- `src/services/layoutProbe.ts` - `LayoutReport.clipped`
- `src/test/e2e/suite.ts` - `chatInEverySyncState`, `clipped` problems in `checkOverflow`, the real status restored with `api.sidebar.refresh()`
- `media/chat/chat.css` - wrapping bar, `.bar-break`, never-shrinking wrapping chips, `.sync-detail`
- `src/services/panelView.ts` - `data-must-read` on `#profile`/`#sync`, `#sync-detail` paragraph, `.bar-break` span
- `src/domain/state/syncStatus.ts` - `SyncControlModel.detail`
- `media/chat/syncControl.js` - renders `#sync-detail` and `aria-describedby`
- `src/test/syncControl.test.ts` - 7 detail tests and 2 guards
- `src/test/responsivePanels.test.ts` - the bar-wraps assertion now pins the base rule
- `src/test/helpers/fakeDom.ts` - `removeAttribute` on the DOM stand-in

## Decisions Made

See `key-decisions` above. The notable one: wrapping the two chips at every width (the plan asked for it only at 260 px and below). The probe showed the profile chip clipped up to 590 px, so wrapping everywhere is what makes "never clipped" true by construction.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `removeAttribute` missing on the test DOM stand-in**
- **Found during:** Task 2 (writing the unlink test)
- **Issue:** `renderSyncControl` must remove `aria-describedby`; `FakeNode` had no `removeAttribute`
- **Fix:** added one line to `src/test/helpers/fakeDom.ts`
- **Files modified:** src/test/helpers/fakeDom.ts
- **Committed in:** 7581ad9

**2. [Plan-sanctioned change] responsivePanels narrow-width assertion**
- **Found during:** Task 1
- **Issue:** the 27-16 test pinned `flex-wrap: wrap` inside the `max-width: 260px` block, which Task 1 deliberately moved to the base rule
- **Fix:** the assertion now pins `.composer .bar { display: flex; flex-wrap: wrap; ...` outside any media query (stricter: wrapping at every width)
- **Committed in:** 4f63d92

**3. Wrapping at every width, not only at 260 px and below** - the plan said to wrap the chips' text at the narrowest widths; the RED run showed clipping up to 590 px, so `white-space: normal; overflow-wrap: anywhere` applies at every width (see Decisions).

---

**Total deviations:** 1 auto-fixed (Rule 3), 2 deliberate plan-compatible adjustments. **Impact:** none beyond the plan's goal; no scope creep.

## Issues Encountered

- The full unit suite (1815 tests) has one failure, `chatSendPath.test.js` "a GSD slash command runs the installed skill on the runner", because the person's real Teams library adds extra `team:` slash commands. It is the pre-existing failure already recorded in `deferred-items.md` under 27-03 and does not touch this plan's files. Everything else passes (1805).
- `npm run lint` (tsc --noEmit) exits 0.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. T-27-99 mitigated as planned: the sentence is the host's already-redacted message, set with `textContent` only, and the redaction test now covers the detail (URL password and GitHub token). T-27-100 accepted: the probe stays test-only and unpublished.

## User Setup Required

None - no external service configuration required.

## Human check recommended

The probe proves no must-read text is cut and nothing scrolls sideways; it cannot judge looks. Open the chat at the default 290 px side bar (and once at the narrowest) and glance at the wrapped profile and sync chips and, with a sync problem, the red sentence under them (deliverable D5).

## Next Phase Readiness

Ready for 27-23. The extension-host layout test now measures the sync control in all five states, so later plans that touch the bar get the clipping check for free.

---
*Phase: 27-project-state-follows-the-project-across-interfaces-and-machines*
*Completed: 2026-11-13*

## Self-Check: PASSED

- All ten modified files exist and hold the changes.
- Commits 34fa8d3, 4f63d92, 7581ad9, 77cc0e5 and 81adefe are ancestors of HEAD.
- Task acceptance greps: `clipped` in layout-probe.js (4), `data-must-read` in panelView.ts (3), `bar-break` in chat.css (2), `id="sync-detail"` in panelView.ts (1), `sync-detail` in syncControl.js (2).

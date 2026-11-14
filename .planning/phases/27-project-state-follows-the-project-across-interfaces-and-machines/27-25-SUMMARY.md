---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 25
subsystem: ui
tags: [webview, sync-control, pickup-card, intl, first-run]
requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-22 sync control and profile chip layout (label budget, detail line)"
provides:
  - "shortTime(iso, now): the panel's one display-time formatter, used by the sync control and the pick-up card"
  - "SyncControlModel.at and SYNC_TIME_SLOT: the host sends the ISO time and a slot, never a formatted clock time"
  - "The sync invitation in the ready area (after a working profile), with a spaced box"
affects: [27-16 phase gate, 27-24]
actuals:
  tokens: 11000
  tasks: 2
  commits: 4
  # SUMMARY commit is the fifth commit and is not counted here
plan_head_before: 6cffb32970f560eb4a7f19a672a0ce98c1590e4d
plan_head_after: bcde01ec400cb08fe9e483d88376f3bff24374aa
commits: 4
tech-stack:
  added: []
  patterns:
    - "Host sends data (ISO time + placeholder slot); the panel formats it in the person's clock and locale"
key-files:
  created: []
  modified:
    - src/domain/state/syncStatus.ts
    - media/chat/syncControl.js
    - media/chat/pickup.js
    - media/chat/chat.js
    - media/chat/chat.css
    - src/test/syncControl.test.ts
    - src/test/pickup.test.ts
key-decisions:
  - "The time slot token is '{time}' (SYNC_TIME_SLOT on the host, TIME_SLOT in syncControl.js); replaced by split/join with formatter output, set only with textContent and setAttribute"
  - "Inside the pick-up card the invitation drops its own box (.setup-nudge .sync-prompt override), so there is no box in a box"
requirements-completed: [SYNC-07, SYNC-05]
status: complete
---

# Phase 27 Plan 25: Time formatter and first-run invitation order Summary

One panel-side `shortTime` (Intl.DateTimeFormat, the person's locale and clock) now formats every display time on the pick-up card and the sync control, and the "Keep this project on your other machines" invitation moved into the ready area, so first-run reads "Connect NEAR AI to start" first.

## Accomplishments

- `shortTime(iso, now)` exported from `media/chat/syncControl.js`: hour and minute today, short month and day plus hour and minute on another day, `''` for a missing or invalid time.
- `renderSyncControl` replaces the host's `{time}` slot in label, aria-label and title with the panel's time. The live region announces the label as shown (with the time).
- `src/domain/state/syncStatus.ts`: `syncTimeText` and the `MONTHS` table are deleted; the synced model carries `at` (valid time only) and the slot. Nothing on the host formats a clock time for display.
- `pickup.js` card time comes from `syncControlKit().shortTime`; no formatter of its own, and no time when the helper is missing.
- `chat.js`: the `sync-status` case passes `welcomeReady`; the pinned `pickup-card` line is untouched.
- `chat.css`: `.sync-prompt` box with 12px top and bottom margin, theme variables only.

## Task Commits

| Task | Commit | Type |
| ---- | ------ | ---- |
| 1 RED | 0d58087 | test: card and control agree, slot model, shortTime |
| 1 GREEN | 4181955 | feat: shared panel formatter, host sends ISO time and slot |
| 2 RED | 90e797a | test: invitation in the ready area, .sync-prompt spacing |
| 2 GREEN | bcde01e | feat: invitation in the ready area with spacing |

## Verification

- `tsc` build, then `node --test` on syncControl, pickup, setupNudge, responsivePanels, pageScripts: 89 tests, 0 failing (run under the memory cap).
- `npm run lint`: exit 0.
- Acceptance greps: `shortTime` in pickup.js = 1; non-comment `toLocaleTimeString` in pickup.js = 0; `syncTimeText` in syncStatus.ts = 0; `renderSyncPrompt(document, welcomeReady` in chat.js = 1; `.sync-prompt` in chat.css >= 1.
- Full unit suite and extension-host e2e not run (the orchestrator runs them after the wave merge, as instructed).

## Deviations from Plan

None in files: only plan `files_modified` were touched.

Test-shape notes (not rule deviations):
- The 27-18 tests that pinned `'Synced · 09:05'` and `'Synced · Nov 12, 23:59'` on the host model now check the same instants and same today and other-day rule on the rendered control, with expected text built by `Intl.DateTimeFormat` so they pass in any locale. The label budget test and the live region test also measure the rendered label.
- The card-versus-control agreement test lives in `syncControl.test.ts` (it has both kits); `pickup.test.ts` got a source guard that the card uses the shared formatter and keeps none of its own.
- Task 2's DOM test passes before the change because it hands the ready area in directly; its RED comes from the source check on chat.js and the CSS rule test.

## Known Stubs

None.

## Threat Flags

None. T-27-106 mitigated: the slot is replaced only with formatter output and set via textContent and setAttribute; an invalid time gives no slot and no time.

## Self-Check: PASSED

- Files modified exist; commits 0d58087, 4181955, bcde01e verified in `git log`.

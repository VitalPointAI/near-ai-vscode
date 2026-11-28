---
phase: 33-live-multi-user-staff-projects
plan: 28
status: complete
subsystem: the sync word on the Sterling status bar
tags: [workbench, staff, status-bar, theia, d-57, d-22, mus-09]
requires: [33-24, 33-31]
provides: [StaffSyncStatus, staffSyncShown, staffSyncEntry, STAFF_SYNC_ENTRY, STAFF_SYNC_COMMAND, STAFF_SYNC_WORDS, SterlingStatusItem, bindStatusPart]
affects: [33-26, 33-29, 33-30]
tech-stack:
  added: []
  patterns: [a Theia-free renderer driven by a fake status bar, the browser's copy of an engine word list checked word for word by the test]
key-files:
  created:
    - workbench/extension/src/browser/staff/staff-sync-status.ts
    - workbench/test/staff-sync-status.test.ts
  modified:
    - workbench/extension/src/browser/staff/status-part.ts
key-decisions:
  - "No Sterling status item existed when this plan ran (the sign-in and secret store entries are Phase 46's, not 32.1's policy item), so one entry, sterling.staffSync, is added. A SterlingStatusItem bound by 32.1 native takes the word instead, and then no entry is added."
  - "With several shared projects open, the entry shows the most urgent row (needs-update, refused, attention, offline, connecting, catching up, single machine, live), and Sync Now runs for that project."
  - "The browser cannot import liveSentences.ts (D-51), so it keeps a copy of SYNC_WORDS; the test checks the copy word for word. The sentence comes from the backend's row."
  - "A state this build does not know is shown as Needs attention with the warning look and a plain sentence, never calm and never the raw state."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 6500
  tasks: 2
  commits: 1
completed: 2026-11-24
---

# Phase 33 Plan 28: The sync word on the status bar Summary

While a shared project is open, SovAI's status bar shows one entry, `sterling.staffSync`, with the sync state's word ("Synced", "Offline", "Needs attention"), the state's sentence as its tooltip, and Sync Now as its click. The states that need a person (refused, attention, needs-update) get Theia's warning colours. With no shared project open there is no entry. The entry never shows a name, a product, an address, a pin or a folder.

## Base and branch

`feat/phase-33-wave-27-28` from `2353811b` (33-24 and 33-31 on `feat/phase-33-engine-wave-1`), with `origin/main` (#197, #198) merged at `10f936cd`, no conflicts. Shared with 33-27 in one branch, as the coordinator asked.

Step 0: `STAFF_STATUS_PATH` in `common/staff-live.ts` gave 2 (at least 1), and `bindStatusPart` in `browser/staff/status-part.ts` gave 1.

## Whether a Sterling item existed

No. The image had two status entries before this plan, both Phase 46's: `sterling-session-identity` (the sign-in) and `sterling-secret-store` (shown only when no secret store is available). Neither is the Sterling status item of 32.1 that D-57 names, so `sterling.staffSync` is added. `SterlingStatusItem` is the hook for 32.1: when it is bound, the word joins that item and no entry is added (tested).

## Word and look per state, as rendered

| State | Text | Warning look |
|---|---|---|
| single-machine | `$(sync) This computer only` | no |
| connecting, authenticating | `$(sync) Connecting` | no |
| catching-up | `$(sync) Catching up` | no |
| live | `$(sync) Synced` | no |
| offline (and restoring, with RESTORING_TEXT as tooltip) | `$(sync) Offline` | no |
| refused | `$(warning) Not accepted` | yes |
| attention | `$(warning) Needs attention` | yes |
| needs-update | `$(warning) Needs an update` | yes |
| a state this build does not know | `$(warning) Needs attention` | yes |

The tooltip is the row's sentence from `syncSentence` (33-24's backend), and the accessible name is "Sync: {word}. {sentence}".

## Deviations from Plan

1. **Flat test path.** The plan names `workbench/test/staff/staff-sync-status.test.ts`; the coordinator asked for flat workbench tests, so it is `workbench/test/staff-sync-status.test.ts`.
2. **Both tasks in one commit.** The renderer serves both tasks; the test file was written with the code, before the first run (the same as 33-24).

## Verification

Runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0 and choom, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set.

| Run | Result |
|-----|--------|
| `node scripts/build.mjs` and `node ../scripts/run-tests.mjs dist/test/staff-sync-status.test.js` | **18 tests: 18 passed, 0 failed, 0 skipped** |
| `npm --prefix workbench run lint` | exit 0 |

The whole workbench run on the branch: build ok, 175 tests, 175 passed, lint exit 0 (33-27 summary).

- `staff-sync-status.test.ts` has 18 tests (plan: at least 12).
- **Tests added: 18.** Tests changed: 0.

## Threat model

| Threat | As built |
|---|---|
| T-33-76 | Text, tooltip and accessible name come only from the word list and the backend's sentence; a test puts a name, a product, an address, a pin and the folder in the row's other fields and finds none on the bar. |
| T-33-77 | refused, attention and needs-update set the warning colours and win over every calm state when several projects are open; an unknown state shows as needing attention. |
| T-33-SC | No package was installed. |

## Known Stubs

None.

## Open conditions

None.

## Self-Check: PASSED

- `workbench/extension/src/browser/staff/staff-sync-status.ts` and `workbench/test/staff-sync-status.test.ts` exist; commit `4fc9b36f` is in HEAD.

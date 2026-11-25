---
phase: 33-live-multi-user-staff-projects
plan: 30
status: blocked
subsystem: two-browser acceptance for native staff collaboration
tags: [workbench, staff, playwright, authorization, mus-09]
requires: [33-14, 33-25, 33-26, 33-27, 33-28, 33-29]
requirements: [MUS-09]
---

# Phase 33 Plan 30: Two-browser acceptance

The recovery branch `feat/codex-phase-33-29-30` starts at Claude’s committed `22160497`. The original worktree remains the source of the in-progress browser suite. The continuation preserves its container runner and Playwright checks for co-editing, cursors, own undo, status, invitation confirmation and browser payloads.

## Verification

- The focused container test built both images and ran the real-browser tracer. Sharing, admission and the co-edit within three seconds passed. The test sequence then recorded a 120-second cursor-test timeout. The saved snapshot showed Blake’s name in Avery’s editor. The test did not establish the hover, and own undo, status, invitation step-up and the browser payload check did not run.
- The container wrapper recorded 1 passed and 2 failed. Its separate checks of the workbench logs and instrumented outbound calls passed. Elapsed time was 5:23.55. The peak local runner RSS was 319,540 KiB. Container memory was limited separately.
- The cursor test now dismisses any editor completion popup and moves the pointer into the visible selection bounds for the same named-hover assertion. Type-checking passed. The narrowed mouse step and four later cases await rerun (G544). The local log is `.claude/worktrees/codex-staff-ci/browser.log`.
- The inherited invitation check exercises confirmation for sharing an invitation. Decision confirmation, two independent decisions that become contested, and refusal when the version changes while the dialog is open are all required by Task 3.
- `StaffRoomWidget` opens a settle-only decision from a contested card. `StaffRoomService` can propose a version. The browser needs an entry point to submit a version and begin its first decision, and the version fold requires a roster holder of the submitted decision role.
- The 33-26 service tests already cover a stale confirmation on a decision, a contested card and settling, and stamp changes. This is service-level evidence. The built-image browser checks remain blocking.
- The workbenches reach the hub through an internal Docker network and use a separate ordinary bridge to publish browser ports. The Node outbound hook is a runtime assertion. The fixture still needs evidence of an absent external route.
- Gap-register suite: 21 passed. The road-to-production generator check passed after adding G542 and G543.

## Next planning input

Use the existing version state machine: a proposed, reviewed version becomes awaiting decision through `version.submit`. The assigned decision role comes from the roster at the relevant revision. The existing decision stamp then binds the dialog to the version and observed decision state. On a stale stamp or missing step-up, the backend must leave the version unchanged. The settling action still writes a decision referencing every contested outcome it observed. The new plan needs an independent check of who can submit, who can hold the decision role, what is rechecked at signing, and how the browser tests prove those boundaries.

## Open conditions

- **G542**: Plan and verify the native submit and first-decision flow through the existing authorization rules, and run the three decision checks in two workbench sessions. Plan 33-30 remains blocked and does not satisfy dependencies for 33-32 or 33.2-08.
- **G543**: Prove the two-browser test world lacks a route outside its private network while allowing the host browser to reach both workbenches.
- **G544**: Prove the named hover, own undo, synchronization status, invitation confirmation and secret-free browser payloads against the built image.

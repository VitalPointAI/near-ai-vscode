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
- The cursor test now dismisses any editor completion popup and moves the pointer into the visible selection bounds for the same named-hover assertion. Type-checking passed. The local log is `.claude/worktrees/codex-staff-ci/browser.log`.
- The capped retry at `1707686e` passed co-editing, the named cursor hover, own undo and offline/reconnect status. The invitation check stopped before sending when reloading restored the Share panel in a hidden tab. The browser payload check did not run. The helper now navigates to Share when the panel is hidden. The retry took 1:42.98, with 351,012 KiB peak local runner RSS. The log is `.claude/worktrees/codex-staff-ci/browser-retry-1707686e.log`.
- After the Share navigation fix (`91443912`), all six implemented Playwright cases passed. The three container wrapper checks passed, including the invitation step-up and browser payload assertions, the workbench log scan and the instrumented outbound-call check. Lint passed. Elapsed time was 0:52.79, with 351,108 KiB peak local runner RSS. The log is `.claude/worktrees/codex-staff-ci/browser-visible-share.log`.
- The inherited invitation check exercises confirmation for sharing an invitation. Decision confirmation, two independent decisions that become contested, and refusal when the version changes while the dialog is open are all required by Task 3.
- `StaffRoomWidget` opens a settle-only decision from a contested card. `StaffRoomService` can propose a version. The browser needs an entry point to submit a version and begin its first decision, and the version fold requires a roster holder of the submitted decision role.
- The 33-26 service tests already cover a stale confirmation on a decision, a contested card and settling, and stamp changes. This is service-level evidence. The built-image browser checks remain blocking.
- The G543 test failed against the original fixture because a workbench had two network attachments (`00e92597`). The fixture change places both workbenches, the hub and OpenBao on exactly one internal Docker bridge (`c2d52d1e`). Host-only loopback forwarders preserve the browser origins. The browser run reached both workbenches while Docker inspection verified all four attachments. The outbound hook and payload assertions also passed.
- The first topology run verified the attachments but hit a full checkout volume during the invitation download. With space restored, the fresh build and test rerun from the scratch volume passed all six browser cases and four wrapper checks in 5:14.05, with 355,820 KiB peak local runner RSS. Workbench lint passed, and the existing OpenBao identity and key checks passed 14 of 14. Logs are `.claude/worktrees/codex-staff-ci/g543-browser-retry.log` and `.claude/worktrees/codex-staff-ci/g543-openbao-regression.log`.
- Gap-register suite: 21 passed. The road-to-production generator check passed after recording G542, G543 and G544.

## Next planning input

Use the existing version state machine: a proposed, reviewed version becomes awaiting decision through `version.submit`. The assigned decision role comes from the roster at the relevant revision. The existing decision stamp then binds the dialog to the version and observed decision state. On a stale stamp or missing step-up, the backend must leave the version unchanged. The settling action still writes a decision referencing every contested outcome it observed. The new plan needs an independent check of who can submit, who can hold the decision role, what is rechecked at signing, and how the browser tests prove those boundaries.

## Open conditions

- **G542**: Plan and verify the native submit and first-decision flow through the existing authorization rules, and run the three decision checks in two workbench sessions. Plan 33-30 remains blocked and does not satisfy dependencies for 33-32 or 33.2-08.
- **G543**: Repeat the passing internal-bridge topology and browser access checks on the combined branch in CI.
- **G544**: Repeat the six locally passing browser cases in CI on the combined branch before closing the record.

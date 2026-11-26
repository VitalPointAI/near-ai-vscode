---
phase: 33-live-multi-user-staff-projects
plan: 30
status: complete
subsystem: two-browser acceptance for native staff collaboration
tags: [workbench, staff, playwright, authorization, mus-09]
requires: [33-14, 33-25, 33-26, 33-27, 33-28, 33-29]
requirements: [MUS-09]
duration: 1:21.47 for the final local acceptance run
completed: 2026-11-25
---

# Phase 33 Plan 30: Two-browser acceptance

Local acceptance is complete on `feat/codex-phase-33-29-30`. The recovery branch started at `22160497`. The continuation added native submission and first decisions, then ran all nine required browser cases in the two built Workbench sessions. [Phase 33-35 implementation and verification](33-35-SUMMARY.md)

## Verification

Playwright reported exactly one pass for each of the nine required cases. All five wrapper checks passed with zero skips. Docker inspection verified that both workbenches, the hub and OpenBao used one internal bridge. The built frontend scan and both workbenches’ egress and log checks passed.

| Browser case | Local result |
| --- | --- |
| Co-edit tracer | Avery shared the work, Blake joined after admission, and Avery’s edit reached Blake’s editor within three seconds. |
| Cursor hover | Blake’s cursor appeared in Avery’s editor and the hover displayed Blake’s name. |
| Own undo | Avery’s undo removed Avery’s edit while keeping Blake’s edit in both editors. |
| Status and reconnect | Both sessions showed Synced, then Offline with the hub stopped, then Synced after it restarted. |
| Invitation step-up | An old sign-in requested confirmation. A fresh sign-in created the invitation. |
| `blocking: decision step-up` | The old sign-in left zero decisions on v4 in both replicas. The same-origin return resumed the retained ticket and saved one person-key approval on both replicas. |
| `blocking: contested decisions` | Avery approved v1 while disconnected from the hub and Blake rejected it while connected. After reconnection, both cards showed both names and reasons. Avery’s settlement cited both independent decision hashes and cleared both cards. |
| `blocking: changed while deciding` | While Blake’s v2 dialog was open, Avery proposed v3 and then approved v2. Blake received the D-24 refusal and wrote zero decisions. Both replicas kept v2 approved and v3 draft. |
| Browser wire isolation | Browser traffic carried no keys, tokens or signatures. Blake’s browser never received the Confidential product marker. |

The final run used Node 26.13.1 and a Workbench built from this worktree with manifest `sha256:1b86993d0d8a5a5d52d2735bcbc0c5acb007533151045f56f0172fd082a11b99`. Workbench lint passed. The capped runner took 1:21.47 and peaked at 731,944 KiB RSS. Local evidence is in `/tmp/s33pass.XhFT/accept.tap` and `/tmp/s33pass.XhFT/accept.time`. The acceptance fixture is in `62c06084`.

## Earlier verification

- The focused container test built both images and ran the real-browser tracer. Sharing, admission and the co-edit within three seconds passed. The test sequence then recorded a 120-second cursor-test timeout. The saved snapshot showed Blake’s name in Avery’s editor. The test did not establish the hover, and own undo, status, invitation step-up and the browser payload check did not run.
- The container wrapper recorded 1 passed and 2 failed. Its separate checks of the workbench logs and instrumented outbound calls passed. Elapsed time was 5:23.55. The peak local runner RSS was 319,540 KiB. Container memory was limited separately.
- The cursor test now dismisses any editor completion popup and moves the pointer into the visible selection bounds for the same named-hover assertion. Type-checking passed. The local log is `.claude/worktrees/codex-staff-ci/browser.log`.
- The capped retry at `1707686e` passed co-editing, the named cursor hover, own undo and offline/reconnect status. The invitation check stopped before sending when reloading restored the Share panel in a hidden tab. The browser payload check did not run. The helper now navigates to Share when the panel is hidden. The retry took 1:42.98, with 351,012 KiB peak local runner RSS. The log is `.claude/worktrees/codex-staff-ci/browser-retry-1707686e.log`.
- After the Share navigation fix (`91443912`), the six earlier Playwright cases passed. The three container wrapper checks passed, including the invitation step-up and browser payload assertions, the workbench log scan and the instrumented outbound-call check. Lint passed. Elapsed time was 0:52.79, with 351,108 KiB peak local runner RSS. The log is `.claude/worktrees/codex-staff-ci/browser-visible-share.log`.
- The 33-26 service tests covered an expired confirmation, a contested decision and its settlement, and stamp changes. The final run above verified the three decision paths through the native browser controls.
- The G543 test failed against the original fixture because a workbench had two network attachments (`00e92597`). The fixture change places both workbenches, the hub and OpenBao on exactly one internal Docker bridge (`c2d52d1e`). Host-only loopback forwarders preserve the browser origins. The browser run reached both workbenches while Docker inspection verified all four attachments. The outbound hook and payload assertions also passed.
- The first topology run verified the attachments but hit a full checkout volume during the invitation download. With space restored, the fresh build and test rerun from the scratch volume passed all six browser cases and four wrapper checks in 5:14.05, with 355,820 KiB peak local runner RSS. Workbench lint passed, and the existing OpenBao identity and key checks passed 14 of 14. Logs are `.claude/worktrees/codex-staff-ci/g543-browser-retry.log` and `.claude/worktrees/codex-staff-ci/g543-openbao-regression.log`.
- Gap-register suite: 21 passed. The road-to-production generator check passed after recording G542, G543 and G544.

## Open conditions

- **G542** is locally mitigated by the three passing decision authorization cases. Combined-branch CI and the release gate remain pending. Plans 33-32 and 33.2-08 still require 33-30 on main.
- **G543** requires the internal-bridge topology and browser access checks on the combined branch in CI.
- **G544** requires the inherited browser cases on the combined branch in CI.

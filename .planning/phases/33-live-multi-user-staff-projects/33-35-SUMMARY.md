---
phase: 33-live-multi-user-staff-projects
plan: 35
status: complete
subsystem: native Staff Room decision authorization
tags: [staff-room, workbench, authorization, two-browser, mus-09]
requires:
  - phase: 33-05
    provides: Shared product versions and signed decisions.
  - phase: 33-23
    provides: Hosted session and person key signing.
  - phase: 33-26
    provides: Native Staff Room and stamped decision dialog.
  - phase: 33-29
    provides: Live Workbench editor and presence.
provides:
  - Exact-version native submission and first-decision controls.
  - Checked hosted signing and session-owned decision tickets.
  - Built-image evidence for decision confirmation, contested settlement and stale refusal.
affects: [33-30, 33-32, 33.2-08]
tech-stack:
  added: []
  patterns: [verified roster action projection, locked checked append, isolated browser fixture]
key-files:
  created: [workbench/test/helpers/staff-decision-fixture.mjs]
  modified:
    - src/staff/replica/versionActs.ts
    - src/staff/replica/replicaProject.ts
    - src/staff/replica/store.ts
    - workbench/extension/src/common/staff-room.ts
    - workbench/extension/src/node/staff/staff-room-service.ts
    - workbench/extension/src/browser/staff/staff-room-view.ts
    - workbench/extension/src/browser/staff/staff-room-widget.ts
    - workbench/test/container/staff-live-e2e.test.ts
key-decisions:
  - "Compare the checked snapshot under the store lock before persisting hosted writes or returning a signer refusal."
  - "Derive the exact version, decision role and retained stamp from verified project state. Bind the ticket to the live session and person."
  - "Observe the live engine where Theia bundles it and serve fixture-only controls over a fixed Unix socket."
requirements-completed: [MUS-09]
commits: 6
plan_head_before: 1f18e38fc5fd05ea93f4db07169a00f67ae570be
plan_head_after: 62c06084474e9b09d97c4e345b99f63a895728d0
actuals:
  tokens: 27660
  tasks: 3
  commits: 6
duration: 57 min from first RED commit to task completion
completed: 2026-11-25
---

# Phase 33 Plan 35: Native Staff Room decision acceptance

The Staff Room submits an exact guarded version with the session key and accepts the roster decision holder's stamped decision with the person key. Two built Workbench sessions verified the passkey return, competing offline decisions and settlement, and stale-dialog refusal.

## Implementation

| Task | Commits | Result |
| --- | --- | --- |
| 1 | `bcdf87b5`, `dfd72655`, `f1640fe6` | The version engine derives available decision roles from verified roster and cell grants. A competing decision during hosted signing wins over a stale signature or a step-up refusal. |
| 2 | `5b15eb5f`, `55287997` | Native controls address the displayed version. A retained decision ticket belongs to its project, session and person, and uses the original decision stamp after confirmation. |
| 3 | `62c06084` | The isolated fixture requires exactly one successful report entry for every one of the nine browser cases. |

## Verification

- Task 1 RED reproduced the missing native operation and both hosted signing failures. The unchanged-snapshot refusal passed. The capped GREEN run passed all 125 tests, including the replica store, person signer and architecture checks.
- Task 2 RED reproduced the missing submit RPC, ticket visibility in a different person's session, and ticket creation after role withdrawal. The focused service and view suite passed 14 of 14. The root model, copy and architecture suite passed 66 of 66. Workbench lint passed. The Workbench unit suite reported 338 passes and five opt-outs. All four real-hub opt-outs passed in a targeted rerun. The remaining frontend scan passed against both built images in Task 3.
- Task 3 passed all nine browser cases and five wrapper checks with zero skips. The six inherited cases covered co-editing, the named cursor hover, own undo, offline and reconnect status, invitation step-up, and wire isolation. Docker inspection verified one internal bridge for both workbenches, the hub and OpenBao. The frontend bundles held no Yjs or replica modules. The outbound and log checks passed for both workbenches.
- The final run used Node 26.13.1 and the Workbench built from this worktree, manifest `sha256:1b86993d0d8a5a5d52d2735bcbc0c5acb007533151045f56f0172fd082a11b99`. The browser run took 63.22 seconds. The capped runner including lint and test build took 1:21.47 and peaked at 731,944 KiB RSS. Evidence is in `/tmp/s33pass.XhFT/accept.tap` and `/tmp/s33pass.XhFT/accept.time`.

| Blocking browser case | Observed result |
| --- | --- |
| Decision step-up | The old confirmation left zero decisions on v4 `75a2365da975e1b2814e223934f657795d7cafee070a5f78fc3ef8f0fe0a93f9` in both replicas. The browser opened the real confirmation link with `max_age=0` and the configured ACR, returned to the exact same-origin page with a fresh fixture sign-in, and resumed the open decision. Both replicas recorded one person-key approval. |
| Contested decisions | Only Avery lost the hub connection. Avery approved and Blake rejected v1 `1c05a93762050e0a1fee44c1195cede57ce548db7f73e8bb0857490954e617d2` with distinct reasons. Both names and reasons appeared after reconnection. Avery's fresh settlement cited both independent signed decisions `310f1b18209e18323497c43d19305c57292b965b803732ad2fc90f1a5dfaa9e5` and `4311bb30477f2120a9fac2b9c4e1777d806f20b2cdbf66ac34d0adeec2958536`. Both cards cleared. |
| Changed while deciding | Blake opened v2 `c354ea483e0b76d55bd0c89483c055c15a8192dae270b2d2beffbade4e1dbb4a`. Avery proposed v3 `ee493189b08dbd79296678d0769243bd83333d2a15948d8bac52f3b4e3a4ba4e` and approved v2. After Blake's replica folded that approval, the stale dialog returned the D-24 sentence and added zero decisions. Both replicas kept v2 approved and v3 draft. |

## Deviations from plan

- Theia inlines the compiled live engine into the built backend. The test preload observes its `startRoot` method in memory only after finding exactly one matching method in the backend bundle. The hook uses the live engine's public project methods for fixture setup, and the production submission and decision path remains in the native UI.
- The fixture completes the confirmation landing request before changing browser headers. An earlier attempt stalled while changing Chromium's headers inside the intercepted request. The final run verified the exact return path and recorded the decision on both replicas.

## Self-Check: PASSED

Verified the fixture file, all six implementation and test commits, and the recorded counts against the retained browser report.

## Open conditions

- **G542** has passing local evidence for all three named decision cases. The owning workflow still needs to record acceptance in 33-30 and update the existing gap record before releasing its dependent plans.
- **G543** requires the internal-bridge and browser access checks on the combined branch in CI.
- **G544** requires the inherited browser cases on the combined branch in CI.

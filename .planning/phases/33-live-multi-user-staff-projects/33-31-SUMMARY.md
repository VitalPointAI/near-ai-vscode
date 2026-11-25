---
phase: 33-live-multi-user-staff-projects
plan: 31
status: complete
subsystem: the staff modules and their part slots in the Sterling workbench
tags: [workbench, staff, theia, modules, d-51, d-52, mus-09]
requires: [33-24]
provides: [staff-backend-module, staff-frontend-module, createStaffBackendModule, createStaffFrontendModule, StaffLiveSessionId, StaffStatusEvents, staffStateDir, bindBindingPart, bindStaffRoomPart, bindSharePart, bindPresencePart, bindStatusPart]
affects: [33-25, 33-26, 33-27, 33-28, 33-29, 33-30]
tech-stack:
  added: []
  patterns: [one part file per native plan, the engine built inside the module from the session's own services, the frontend module importing only browser and common files]
key-files:
  created:
    - workbench/extension/src/node/staff-backend-module.ts
    - workbench/extension/src/browser/staff-frontend-module.ts
    - workbench/extension/src/node/staff/binding-part.ts
    - workbench/extension/src/node/staff/staff-room-part.ts
    - workbench/extension/src/node/staff/share-part.ts
    - workbench/extension/src/browser/staff/binding-part.ts
    - workbench/extension/src/browser/staff/presence-part.ts
    - workbench/extension/src/browser/staff/staff-room-part.ts
    - workbench/extension/src/browser/staff/share-part.ts
    - workbench/extension/src/browser/staff/status-part.ts
    - workbench/test/staff/staff-modules.test.ts
  modified:
    - workbench/extension/package.json
key-decisions:
  - "The backend module builds the engine from the session's own services: in local mode with this computer's keyring as its secret store, in a hosted session with startSessionKeys, openEncryptionKey (with the post-quantum keys) and the person's OpenBao key store."
  - "Shared projects are looked for in the workspace folder (the image opens /home/sterling/workspace) and the folders directly in it."
  - "The engine keeps its per-person files in ~/.sterling/staff."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 9000
  tasks: 2
  commits: 3
completed: 2026-11-24
---

# Phase 33 Plan 31: The staff modules Summary

The built Sterling workbench now carries the staff engine. One backend module binds the session's live engine, its status service and its lifecycle. One frontend module binds this tab's status client and the status proxy. Each native feature plan (binding, presence, Staff Room, Share with people, status) has its own part file, a no-op until that plan fills it in, so no two plans in wave 8 share a file.

## Base

`feat/phase-33-engine-wave-1` at `d1bc4a00` (33-24 complete). Step 0: `export class StaffLiveEngine` gave 1, and `export function bindStaffStatusService` gave 1.

## What was built

- **`staff-backend-module.ts`:** `createStaffBackendModule(parts?, log?)`, with the real parts as the default export. It binds:
  - `StaffLiveSessionId` (a `StaffLiveSession`);
  - the status service (`bindStaffStatusService`), attached to each engine as it starts;
  - one `BackendApplicationContribution`, which calls `watch()` at start and `dispose()` at stop.

  The engine is made at the session's start:
  - **local mode:** the keyring through `keyStoreSecrets(..., 'keyring')`, or nothing when no secret store is available;
  - **hosted:** `startSessionKeys`, then `openEncryptionKey` with the engine's post-quantum functions; nothing starts when either is refused.
- **`staff-frontend-module.ts`:** `createStaffFrontendModule(parts?)`. It binds `StaffStatusEvents`, this tab's client: `onDidChangeStatus` and `onDidRequestJoin` events for the parts. It also binds the `StaffStatusServer` proxy, which passes that client to the backend. It imports only browser and common files.
- **The part slots:**
  - backend: `bindBindingPart`, `bindStaffRoomPart`, `bindSharePart`;
  - browser: `bindBindingPart`, `bindPresencePart`, `bindStaffRoomPart`, `bindSharePart`, `bindStatusPart`.
- **Registration:** one `theiaExtensions` entry for the two modules.

## Deviations from Plan

1. **The engine's secret store and roots are built here.** The plan names the bindings only. The backend module also builds the engine (keyring or OpenBao store, session keys, encryption key) and the workspace roots, because the module is where the session's services meet. No other file changed.
2. **Tests first:** the module test was written beside the modules, so it did not run red on its own.

## Verification

The run used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0 and choom, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set.

| Run | Result |
|-----|--------|
| `npm --prefix workbench run build && npm --prefix workbench test && npm --prefix workbench run lint`, first run | build ok (backend and browser bundles, 0 errors); 147 tests: 145 passed, 2 failed. Both failures were in the new module test: the frontend test read the module source from the wrong folder, and the backend test resolved the lifecycle without a session identity bound. |
| The same unit run and lint after the test fix, on the built workbench | **147 tests: 147 passed, 0 failed, 0 skipped**, including 33-24's bundle scan over the frontend built with the staff module; lint exit 0 |

- `grep -c "staff-frontend-module" workbench/extension/package.json` gives 1.
- `staff-modules.test.ts` has 2 tests (plan: at least 2).
- **Tests added: 2.** Tests changed: 0.

## Threat model

| Threat | As built |
|---|---|
| T-33-N11 | The frontend module imports no node, engine, key or Yjs module (the test reads its imports). 33-24's bundle scan runs after the build. |
| T-33-SC | No package was installed. |

## Known Stubs

The eight part functions are intentional no-ops; 33-25 to 33-29 fill them in, as this plan sets out.

## Open conditions

None.

## Self-Check: PASSED

- The created files exist and the plan's commit is in HEAD.

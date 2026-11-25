---
phase: 33-live-multi-user-staff-projects
plan: 24
status: complete
subsystem: the native live engine in the session backend, hosted project open, the staff engine bundle and the status channel
tags: [workbench, staff, live, replicator, hosted, session-keys, rpc, d-47, d-50, d-51, d-52, d-61, d-64, d-67, mus-09, post-01]
requires: [33-03, 33-05, 33-06, 33-09, 33-12, 33-22, 33-23, 33.2-04, 46-01, 46-02, 46-07]
provides: [StaffLiveEngine, StaffLiveSession, StaffStatusService, bindStaffStatusService, STAFF_STATUS_PATH, StaffStatusServer, StaffStatusClient, StaffStatusRow, StaffJoinRequest, bindBackendService withClient, bindFrontendService client, ReplicaProjectDeps.hosted, LiveReplicatorOptions.certificate, StaffLiveApi, engine/decodeWorker.js, engine/vendor/yjs]
affects: [33-25, 33-26, 33-27, 33-28, 33-29, 33-30, 33-31]
tech-stack:
  added: []
  patterns: [one engine per session backend, the person key as the hosted device with the session key owning the store, the vendored Yjs copied only at its pinned hash, structural typing of the runtime-loaded engine bundle, fake replicator for each hook and a real hub for the tracer]
key-files:
  created:
    - workbench/extension/src/common/staff-live.ts
    - workbench/extension/src/node/staff/staff-live-engine.ts
    - workbench/extension/src/node/staff/staff-status-service.ts
    - workbench/test/staff/staff-live-engine.test.ts
    - workbench/test/staff/backend-service-client.test.ts
    - src/test/staffHostedOpen.test.ts
    - src/test/staffProposalBlob.test.ts
  modified:
    - workbench/extension/src/node/backend-service.ts
    - workbench/extension/src/browser/frontend-service.ts
    - workbench/extension/src/node/staff/staff-engine.ts
    - workbench/extension/src/node/staff/keystore-secrets.ts
    - workbench/tools/staff-engine-entry.ts
    - workbench/tools/build-engine.mjs
    - workbench/scripts/build.mjs
    - workbench/Dockerfile
    - workbench/Dockerfile.dockerignore
    - src/staff/replica/replicaProject.ts
    - src/staff/replica/liveReplicator.ts
    - src/domain/replica/hubWitness.ts
    - src/domain/replica/grantPages.ts
    - src/test/replicaHubWitness.test.ts
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
    - compliance/gaps.json
key-decisions:
  - "A hosted session opens a shared project with ReplicaProjectDeps.hosted: the person key's writer is the device, the opened X25519 key opens the grants, and the session key signs the store's marks and owns its files. No device key is made."
  - "In a hosted session the store's mark is trusted through the person's own OpenBao key store path, which only the person's token writes; any session key may sign it (a new session has a new key)."
  - "The workbench image takes Yjs from the repository's vendored, hash-pinned build (scripts/crdt-vendor.json), not from a new npm dependency (D-68); CI and the release put that build in the image's build context."
  - "The live engine's projector runs after an exchange that pulled something; a push alone projects nothing."
requirements: [MUS-09, POST-01]
requirements-completed: []
actuals:
  tokens: 52000
  tasks: 3
  commits: 6
completed: 2026-11-24
---

# Phase 33 Plan 24: The native live engine Summary

A shared project in a workspace root now goes live in the person's Theia session. The engine runs in the backend, one replicator per shared project, and every connected tab hears each project's state. In a hosted session the project opens with the person key as its device: the session key signs ordinary work and the session answer, its certificate goes to the hub with the first session, and no private key is made or stored. Every hook of superseded 33-10 runs: the feature check on a lead's device, the projector after an exchange, the compactor after a checkpoint, join requests on a lead's or deputy's device only, Sync Now, and a project that needs a newer Sterling stops with the D-67 sentence and keeps every entry. Two engine defects that kept a second person from seeing a proposal were found and fixed on the way.

## Base and branch

- `feat/phase-33-engine-wave-1` at `92f1ff20` (33-23 done).
- `origin/feat/phase-33.2-wave-1` (`3d5da3a3`, 33.2-01 to 33.2-05) was merged first (`2ff96ede`), as the coordinator directed. It brought in 33.2-04's `publishKem` and `person-kem.ts`, so the engine calls them and nothing is copied. No conflicts.
- `origin/main` was merged later (`#191`, `#192`, `#195`), for the register's `appliesAt` and `blocksProduction` fields. No conflicts.

Step 0 at the base, each 1 as the plan expects:
- `export function bindBackendService` in backend-service.ts
- `export function bindFrontendService` in frontend-service.ts
- `export function syncStatusFor` in staffSyncStatus.ts
- `export class LiveReplicator` in liveReplicator.ts
- `export function startSessionKeys` in session-keys.ts

## Exported names and RPC paths (for 33-31 and later plans)

- **Status RPC path:** `STAFF_STATUS_PATH = '/services/sterling-staff-status'`, id `StaffStatusServer`. Its methods are `rows()` and `syncNow(project)` (a `ServiceResult`). The client gets `onStatus(row)` and `onJoinRequest({ project, invite? })` as notifications.
- **`StaffStatusRow`:** `{ project, root, state, sentence, lastSyncedAt? }`, with words from `liveSentences.syncSentence`.
- **`bindStaffStatusService(bind, engine: (context) => () => StaffStatusSource | undefined)`.** Each connecting tab is added with `addClient`. `StaffStatusService.attach(engine)` wires the rows and join requests once the engine exists.
- **`bindBackendService(bind, id, path, make, withClient?)`** and **`bindFrontendService(bind, id, path, client?)`.** Without the new argument each behaves as before.
- **`new StaffLiveEngine({ engine, roots, globalStorageDir, secrets, hosted?, replicator?, now?, log? })`:**
  - lifecycle: `start()`, `stop()`
  - reads: `projects()`, `project(id)`
  - actions: `setBound(id, products)` (33-25), `syncNow(id)`
  - listeners: `onStatus(listener)`, `onJoinRequest(listener)`
- **`hosted`:** `{ keys: SessionKeys, encryption: OpenedEncryptionKey }`, as 33-23 makes them.
- **`new StaffLiveSession({ identity, create, started?, timers?, intervalMs? })`:** `watch()`, `check()`, `dispose()` and `current`. It starts the engine at `active` (local mode at once) and stops it at `stopping` or `stopped`.
- **The engine bundle:** `StaffLiveApi` in `staff-engine.ts` types what the backend calls, and the workbench lint checks it against `tools/staff-engine-entry.ts`.
- **Engine changes the native plans read:**
  - `ReplicaProjectDeps.hosted: { personPublicKey, encryption: DeviceEncryptionKey }`.
  - `LiveReplicatorOptions.certificate`.

## How it works

- **Opening.** Each workspace root is opened with `ReplicaProject.open`.
  - A folder that is not shared returns undefined and starts nothing.
  - A refused one is logged by its refusal id and starts nothing.
  - On a single machine the deps are the person's secrets, the global storage folder, `cellOrderHook` and `publishKem: true` (33.2 D-05).
  - In a hosted session the deps are the session signer, the person signer, the opened X25519 key and the hosted mark trust.
- **Hosted.** For each project the engine:
  - finds the person key's member and slot in the roster;
  - asks `SessionKeys.certificate`;
  - passes the entry to the replicator, which carries it in the session answer (33-22);
  - publishes the person's post-quantum keys through `publishPersonKem` (33.2-04).

  A refused step-up leaves the project on the device path and logs one line. A later plan shows the confirmation in the Staff Room.
- **Hooks.**
  - `ensureRequireArmed` runs at open.
  - The projector runs when `status.pulled` grows, and skips the products in `setBound`.
  - `onCheckpoint` runs `compactAfterCheckpoint` and pushes when it wrote something.
  - `isLeadDevice` reads `isRosterWriterAt` at the roster head, so a join request reaches the listeners only on a lead's or deputy's device.
  - Each status goes to `syncStatusFor(root)` and to every listener.
  - `needs-update` stops that project's replicator.
- **The bundle.**
  - `engine/staff.cjs` holds the live names.
  - `engine/decodeWorker.js` is built beside it, where `decodeHost.ts` looks.
  - `engine/vendor/yjs` is copied from `vendor/yjs` only when its SHA-256 equals `scripts/crdt-vendor.json`'s `output.sha256`.
  - The one Yjs path expression in `doc.ts` is rewritten for the bundle. The build stops if that expression changes, or if the vendored file is missing or differs.
  - The test build points the repository's own `doc.ts` and `decodeHost.ts` at the same engine copies.
- **CI and the image.** The Dockerfile copies the pinned build. CI's workbench job vendors it and builds the hub for the real-hub tests. The release extracts it from the verified VSIX, and build-engine then checks it against its pin.

## Deviations from Plan

1. **[Rule 1] The hub's checkpoint at a roster a device had not folded yet was "injected".** A lagging device judged the hub's checkpoint before it pulled the roster entries that checkpoint names, so every second person went to attention after any roster change. `witnessCheckpoint` now leaves the watched hub's checkpoint at an unknown roster head unjudged: no finding, not kept. The next one is judged in full. Another device's checkpoint is judged as before. Fixed in `ccb4cda0`, with one new witness test.
2. **[Rule 1] A proposal's text never reached the other computers.** `citedBlobs` named a body blob and a compaction's state, not a proposal's `textBlob`, so the proposer pushed no blob. `wantedBlobs` looked only at the decode check's waits, not at the fold's `missing-blob` holds. Both are fixed (`ccb4cda0`, and lines in `3cabb346`). `staffProposalBlob.test.ts` covers it, and the real-hub projector test shows the end to end.
3. **[Rule 3] Engine changes outside the plan's list:**
   - `ReplicaProjectDeps.hosted` and `appendOwn`'s own-entry check: replicaProject.ts is at 1,173 lines.
   - `LiveReplicatorOptions.certificate`.

   The coordinator asked for a hosted open with the session and person signers and the opened encryption key. 33-23 left only the signers for it.
4. **[Rule 3] The vendored Yjs in the image** needs gate files, which the owner reviews:
   - `.github/workflows/ci.yml`: vendor step, hub build, and `NEAR_AI_HUB_NODE` for the workbench tests;
   - `.github/workflows/release.yml`: Yjs from the verified VSIX.

   The workbench test job also needs the hub built, because the two real-hub engine tests follow D-46 and fail in GitHub Actions without it.
5. **[Rule 2] `keyStoreSecrets` takes the store kind.** It refuses plain private keys only for the OpenBao store, so the single-machine path on this computer's keyring keeps the extension's device key as before.
6. **[Rule 1] Copy lint:** `grantPages.ts`'s `page-other-epoch` sentence (from the 33.2 merge) used a glossary word and a mode word. It now reads "A page of this cell grant belongs to another grant, or was signed by someone else." No test reads it.
7. **The join request carries the invitation id, not the name and code.** `LiveReplicator.onJoinRequest` gives only the invitation id; the lead's tab fetches the request with its name and safety words in 33-27's admit flow.
8. **Arming roster.require "written once" is shown on a project made shared since D-08,** which arms it at creation. The engine's call writes nothing more on the lead's device, and nothing on a member's device.
9. **Tests first:** both new test files were written with the code, before the first build. Their first run had 2 of 16 failing: the projector over a real hub (deviations 1 and 2) and a timing wait.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0 and choom. The workbench and the real hub ran on Node 26.13.1, with `NEAR_AI_HUB_NODE` set.

| Run | Result |
|-----|--------|
| `npm --prefix workbench run build && npm --prefix workbench test && npm --prefix workbench run lint` (Task 3's verify) | build ok; **143 tests: 143 passed, 0 failed, 0 skipped**, including the bundle scan; lint exit 0 |
| Root focused: staffHostedOpen, staffProposalBlob, replicaHubWitness, staffPersonKeySigning, staffLiveReplicator, staffHubSyncLive, staffHubTransport, staffLivePresence, staffReplicaHubMembership, staffLiveTracer and staffHubSessionKey (real hub), staffLiveProjection, staffKemKeys, architecture | 252 passed; copyLint then failed on the merged grantPages sentence (deviation 6) |
| After the fix: copyLint, replicaGrantPages, architecture, root `npm run lint` | 57 passed; lint exit 0 |
| scripts/test: workflow-files, workflow, resource-check | 88 passed |

- `staff-live-engine.test.ts` has 13 tests (plan: at least 8), two of them over a real hub child. `backend-service-client.test.ts` has 3 (plan: at least 3).
- Acceptance greps: `withClient` in backend-service.ts 3; `createProxy` in frontend-service.ts 1; `ensureRequireArmed` in staff-live-engine.ts 1; `lease` in staff-live-engine.ts 0.
- **Tests added: 19.** Workbench: 3 + 13. Root: `staffHostedOpen` 2, `staffProposalBlob` 1, `replicaHubWitness` 1. **Tests changed: 0.**

## Threat model

| Threat | As built |
|---|---|
| T-33-N11 | The bundle scan of `lib/frontend` finds no Yjs, lib0, replica module or key function, after `npm run build`. |
| T-33-N12 | A join request reaches listeners only through `isLeadDevice`, a roster writer at the head; tested with a member's device. |
| T-33-N10 | `StaffLiveSession` stops the engine at `stopping`. `StaffLiveEngine.stop` drops the session keys and the opened encryption key; tested. |
| T-33-SC | No npm package was installed. Yjs comes from the existing hash-pinned vendored build. |

## Known Stubs

None. Hosted joining (the X25519 binding signed by the person key, the hub address of a project joined in a session, grants signed by the person key) is 33-27's planned work.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new RPC path | workbench/extension/src/node/staff/staff-status-service.ts | `/services/sterling-staff-status`: rows with state words and sentences, and join requests on a lead's device; no project text, key or token. Registered by 33-31. |
| threat_flag: hosted mark trust | src/staff/replica/replicaProject.ts, workbench/extension/src/node/staff/staff-live-engine.ts | In a hosted session the store's rollback mark is signed by the session key and trusted through the person's own OpenBao KV path (only the person's token writes it), not through a device key history. |

## Open conditions

- G422 (filed as G416, renumbered because Phase 74.1 reserved G407 to G418): the workbench image's SBOM (syft) does not list the vendored Yjs 13.6.33 and lib0 0.2.119 the staff engine carries; add them to the image's supply-chain record from `scripts/crdt-vendor.json` before Phase 33 closes.

## Self-Check: PASSED

- The created files exist, and the commits `ccb4cda0`, `3cabb346`, `805193b2`, `3d034709` and the CI commit are in HEAD.

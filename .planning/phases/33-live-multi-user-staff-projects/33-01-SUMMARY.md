---
phase: 33-live-multi-user-staff-projects
plan: 01
status: complete
subsystem: staff/replica (live sync), domain/replica (sync machine)
tags: [tracer, live-replicator, sync-machine, product-editing, product-feed, real-hub-test]
requires: [Phase 30 replica core, Phase 31 roster and membership flows, Phase 32 HubTransport and syncOnce, hub/ built on Node 26.13.1]
provides: [syncMachine.ts, liveReplicator.ts, productEditing.ts, productFeed.ts, hubChild.ts, liveWorld.ts]
affects: [33-04 editor binding, 33-08 and 33-09 full replicator, 33-10 editor service, 33-12 and 33-14 scenarios, the CI step of D-46]
tech-stack:
  added: []
  patterns: [pure transition table with time passed in, one timer per state named by the machine, generation counter per connection, event stream as wake-up only, local first then push, fold-accepted feed]
key-files:
  created:
    - src/domain/replica/syncMachine.ts
    - src/staff/replica/liveReplicator.ts
    - src/staff/replica/productEditing.ts
    - src/staff/replica/productFeed.ts
    - src/test/helpers/hubChild.ts
    - src/test/helpers/liveWorld.ts
    - src/test/staffLiveTracer.test.ts
    - src/test/replicaSyncMachine.test.ts
    - src/test/staffProductFeed.test.ts
  modified: []
decisions:
  - "LiveStatus and SyncMachineState carry times as epoch milliseconds (since, retryAt, lastSyncedAt)."
  - "connected and session-ok are fired when the first heads answer of an exchange arrives: syncOnce is opaque, and that answer means TLS, the pin check and the session all passed."
  - "authenticating has the same give-up timer as connecting; catching-up and live have none (they leave on lost or on the exchange outcome)."
  - "Exchange events are ignored in offline, refused, attention, needs-update and single-machine; Sync Now does not move refused or attention (a person must act); updated leaves needs-update to connecting."
  - "The exchange event gained an optional retryAfterMs, so a server's own wait (rate-limited) is honoured when longer than the back-off."
  - "After the event stream opens, one exchange runs (stream-open), so a change that arrived between the first exchange and the stream opening is not missed."
  - "ProductEditor.flush counts doc.update entries in appended; the doc.client registration is written once per session, on the first flush that has something to write."
  - "Client ids: the lowest id of the device's slot that the fold has not registered and no open session of this process holds (an in-process registry)."
completed: 2026-11-21
duration: 45 min
metrics:
  tasks: 3
  files: 9
actuals:
  tokens: 26518
  tasks: 3
  commits: 3
plan_head_before: 1c340878d23bbc9b17f68416ac05d736f0cf7c83
plan_head_after: b08b5ace9c0be65750ba0cc1cb42e5a97b989c93
requirements: [MUS-09]
---

# Phase 33 Plan 01: Live tracer Summary

Two people's computers, each with its own store folder and device key, share one real hub started as a child process on Node 26: A types a sentence through the product editing core, it is stored on A first, A's live replicator pushes it with syncOnce, the hub's heads event wakes B, and B's fold shows the same text about 0.6 seconds later, with both replicators running the complete nine-state sync connection machine.

## What was built

- `src/domain/replica/syncMachine.ts` (pure, no imports): the nine states, the closed event union, the full transition table, `CONNECT_GIVE_UP_MS = 10_000`, `MAX_BACKOFF_MS = 300_000`, `backoffMs` (1 s doubling to 5 minutes), and `syncTimerOf`, which names the one timer a state runs.
- `src/staff/replica/liveReplicator.ts`: `LiveReplicator` builds `HubTransport` with the `blobsCitedBy` constructor option, runs every exchange as `syncOnce`, reads `events()` fully and treats a heads frame only as a wake-up (coalesced, trailing 250 ms, at most one exchange in flight), never calls `subscribe`. It owns the timers (injectable), gives up connecting after `giveUpMs`, retries offline with back-off, closes the connection when it leaves the connected states, runs one exchange when the stream ends and reopens it after the server's wait, and maps an `events()` failure to `lost`. It imports only `hubSync`, `hubTransport` and the pure machine (no Yjs, no fold, no `vscode`).
- `src/staff/replica/productFeed.ts`: `acceptedUpdates` hands out only the update bytes the fold accepted, in fold order, after a cursor, each opened again through `verifyEntry(raw, project.context())`; an accepted hash it cannot produce ends the feed there.
- `src/staff/replica/productEditing.ts`: `ProductEditor` with a fresh client id per session, the local document seeded from the feed, `doc.client` once then `doc.update` per captured update through `appendOwn`, an ordered queue that keeps a refused append and everything after it for the next flush, and a stop with its sentence when the fold refuses the session's registration (client-collision).
- Test helpers: `hubChild.ts` (the built hub as a child process, secrets as 0600 files, the hub's own `--generate-key`, openssl for the certificate, the hub file from `--hub-file`, stop with SIGTERM then SIGKILL after 60 s, restart on the same state directory and port, and the D-46 skip and fail rule) and `liveWorld.ts` (people's installs on real time, the Phase 31 and 32 flows for share, connect, invite, join and admit, `FakeTimers`, `carryThroughFake`).

## Contract names as built

- `syncMachine.ts`: `SYNC_STATES`, `SyncState`, `SyncEvent`, `SyncMachineState`, `initialSyncState`, `transition`, `CONNECT_GIVE_UP_MS`, `MAX_BACKOFF_MS`, `backoffMs`. Added: `ExchangeOutcome`, `SyncEventKind`, `SYNC_EVENT_KINDS`, `syncTimerOf(state, giveUpMs?)`.
- `liveReplicator.ts`: `LiveReplicator` (`start()`, `stop(): Promise<void>`, `syncNow()`, `localAppended()`, `status`, `onStatus(listener)`), `LiveReplicatorOptions` (exactly the plan's fields), `LiveStatus`, `LiveTransport`. Added: `LiveTimers`, `networkChanged()`, `COALESCE_MS`, `REOPEN_MS`.
- `productEditing.ts`: `ProductEditor` (`open(project, { stream, product, actor }, hooks?)`, `text()`, `insert`, `remove`, `applyRemote`, `flush(): Promise<{ appended; queued }>`, `close()`), `PRODUCT_EDIT_REFUSALS`. Added: `ProductEditError`, `ProductEditRefusal`, `EditTarget`, `EditorHooks` (`onAppended`), `EditorProject`, getters `clientId`, `applied`, `queued`, `refusal`.
- `productFeed.ts`: `acceptedUpdates(project, stream, product, after?)`, `AcceptedUpdate { hash, writer, bytes }`, `AcceptedFeed { updates, last? }`. Added: `FeedProject`, `productOutput(fold, stream, product)`.
- `hubChild.ts`: `startHubChild(node)`, `hubNodeOrSkip(t)`, `HubChild` (`address`, `port`, `pin`, `stateDir`, `hubFileText()`, `stop()`, `restart()`, `dispose()`, `output()`). Added: `HUB_NODE_REASON`, `hubNodeRule(env)`, `repoRoot()`.
- `liveWorld.ts`: `createLiveWorld({ people, hub? })`, `LiveDevice`, `FakeTimers`. Added: `LiveWorld`, `LiveHub`, `LiveInstall`, `liveInstall`, `LIVE_LEAD_MEMBER`, `carryThroughFake`, `settle`.

## D-01 check (Task 1, step 0, on base 1c340878)

All eight greps returned 1: `blobsCitedBy?:` in hubTransport.ts, `async events(` in hubTransport.ts, the `SyncOutcome` line in hubSync.ts, `export interface SyncLocal`, `export function syncLocalOf`, `public appendOwn`, `export function nextClientId`, `export async function startHubProcess`. The base did not move.

## Measured

- B saw A's change 613 to 631 ms after A stored it (every run on the real hub child since the tracer took its final shape). Most of it is the two 250 ms coalescing windows (A's push, B's pull); DESIGN 10.4 targets under one second on a LAN.
- With the hub stopped, B showed offline well inside the 3 s injected give-up (the stream end runs one exchange, which finds the server gone at once).

## Tests

- Task 1 failing first: the test file did not compile on the base (`Cannot find module '../staff/replica/liveReplicator'` and `'../staff/replica/productEditing'`). After: 3 of 3 pass with NEAR_AI_HUB_NODE set; without it the real-hub test is skipped with the printed sentence; with GITHUB_ACTIONS=true and no binary it fails with that sentence.
- Task 2 failing first: with only a stub `syncTimerOf` on the Task 1 machine, 12 of 14 machine tests failed, and the new replicator tests never finished on the Task 1 replicator (no give-up; the file ran to the 600 s cap). After: 14 of 14 machine tests and 5 of 5 tracer tests pass, three runs in a row (19 of 19 each).
- Task 3 failing first: the client-collision test failed on the Task 1 editor (it wrote the update under the collided id). The feed and queue tests passed on the Task 1 code, so their teeth were proven by stated mutations, each reverted: a feed that hands out every stored update of the product fails 3 feed tests; an editor that drops a refused append fails both queue tests. After: 8 of 8 pass.
- Final focused run on the committed code (hub rebuilt): `replicaSyncMachine`, `staffLiveTracer`, `staffProductFeed`: 27 of 27 pass, 0 skipped. Task 3 verify (`staffProductFeed`, `replicaBoundaries`, `architecture`, `copyLint`): 56 of 56 pass, and `npm run lint` exits 0. The architecture and copy-lint baselines are unchanged; every new source file is under 800 lines (156, 382, 196, 62).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A connection that gave up could keep working for nobody**
- **Found during:** Task 2 (the fake-clock test hung).
- **Issue:** after the give-up closed the transport, an exchange still running could make its next call on the closed transport; the real HubTransport would open a fresh connection for a result nobody reads, and a server that never answers kept `stop()` waiting.
- **Fix:** every call of a stale connection (an older generation) fails at once as unreachable inside the replicator's view of the transport.
- **Files modified:** src/staff/replica/liveReplicator.ts, src/test/staffLiveTracer.test.ts (the silent fake now refuses calls after close, as a closed connection does).
- **Commit:** 94711233

**2. [Rule 1 - Test premise] Where a held update resolves**
- **Found during:** Task 3.
- **Issue:** the fold answers an `unregistered-client` hold only with a registration that sorts before the update; for one writer, a registration written after the update sorts after it, so that hold never resolves (and the later overlapping update applies instead).
- **Fix:** the "held, then exactly once" behavior is tested as it happens between two computers: B's update reaches A before B's registration entry (withheld in transit through the fake transport), then arrives once the registration does. A separate test covers the in-fold `unregistered-client` hold and proves it never reaches an editor. The clock-overlap refusal uses its own client id.
- **Files modified:** src/test/staffProductFeed.test.ts, src/test/helpers/liveWorld.ts
- **Commit:** b08b5ace

### Other differences from the plan text

- Device keys are made by the usual identity flow in each person's own secret store (in-process `MemorySecrets` from labelCellWorld, not a label-derived key and not `FileSecrets`): both people run in one test process, and no key text lives in any file.
- `liveWorld.ts` does not call labelCellWorld's `leadWith` and `bringIn`, which fix the clock at a date in the past; a real hub checks hub files and sessions against its own clock. It runs the same Phase 31 flows (`createSharedProject`, `updateMember`, `inviteToProject`, `joinFromInvite`, `admitJoinRequest`, `openWelcome`) and Phase 32's `connectProjectToHub` on the real clock.
- The hub file is issued with `--hub-file` against the running hub's state directory, because the port is known only after the hub starts on port 0.
- `HubChild.restart()` landed in the Task 1 commit with the rest of the helper (the plan lists it under Task 2).
- The tracer uses a product in the base cell, as the plan says; `appendProductEntry` refuses base-cell products for the Staff Room's own writes, but `ProductEditor` appends to the stream it is given.

## Known limits (for later plans)

- Two windows of one install could pick the same client id: the registry of held ids is per process. D-47's lease (one replicator per install) and 33-04's binding should settle it.
- In GitHub Actions the real-hub tests fail until the CI step that builds the hub and sets NEAR_AI_HUB_NODE lands (D-46). That step edits `.github/workflows/ci.yml`, a gate path (D-39), and belongs to a later plan of this phase.
- Pitfall 9 (a sleep or hidden tab leaves a dead stream) and the finding sentences are 33-09's.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-33-01 (feed), T-33-02 (coalescing, give-up, back-off), T-33-03 (HubTransport pinned to the roster's certPin only) and T-33-04 (local first, ordered queue) are mitigated as planned; no package was installed (hub/node_modules came from `npm ci --ignore-scripts` on the committed lock file and is gitignored).

## Self-Check: PASSED

All nine created files exist; commits bcd5da72, 94711233 and b08b5ace are on HEAD; the worktree was clean before this summary.

---
phase: 33-live-multi-user-staff-projects
plan: 12
status: complete
subsystem: sealed presence and the people list (engine part)
tags: [staff, replica, presence, d-18, d-21, d-35, pitfall-10]
requires: [33-09]
provides: [sealPresence, openPresence, readPresence, presenceAllowedFor, PresenceMessage, PRESENCE_INFO, MAX_PRESENCE_PLAINTEXT, LivePresence, HEARTBEAT_MS, PRESENCE_TTL_MS, CURSOR_MAX_PER_SECOND, PresencePerson, PresenceRoster, LiveReplicator.postPresence, LiveReplicator.leavePresence, presenceText]
affects: [33-13, 33-24, 33-29]
tech-stack:
  added: []
  patterns: [seal under the cell's own epoch key with the place in the associated data, product details only in the product's cell, names from the receiver's roster]
key-files:
  created:
    - src/domain/replica/presence.ts
    - src/staff/replica/livePresence.ts
    - src/test/replicaPresence.test.ts
    - src/test/staffLivePresence.test.ts
  modified:
    - src/staff/replica/liveReplicator.ts
    - src/domain/staff/liveSentences.ts
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 15000
  tasks: 2
  commits: 1
completed: 2026-11-24
plan_head_before: d9b39f4d
plan_head_after: 9b77e5f1
---

# Phase 33 Plan 12: Presence (engine part) Summary

People who share a cell now see each other come and go, and nobody else can read who is where, not even your organization's server. A product's name, its cursor and the agents count travel only in that product's own cell. Only the engine was built. Native cursors are 33-29, and the wiring is 33-24.

## Format, as built

- `sealPresence(epochKey, { cell, epoch, writer }, message)` produces base64url of: the epoch as 4 bytes big-endian, then the 12-byte IV, the 16-byte tag, and the ciphertext.
- The key is derived with HKDF-SHA-256 from the cell's epoch key, with info `near-ai/presence/v1`, the cell and the epoch. The cipher is AES-256-GCM. The associated data is `near-ai/presence/v1`, the cell, the epoch and the writer.
- The plaintext is a closed shape of at most 1024 bytes: `{ v: 1, kind: here | cursor | leave, member, position?, product?, anchor?, head?, runs?, seq }`. `readPresence` rebuilds it from untrusted JSON. A cursor without a product is refused.
- `presenceAllowedFor` refuses `product`, `anchor`, `head` and `runs` in the base cell.
- The largest message fits the hub's 2 KiB presence body (tested).

## The loop (livePresence.ts)

- **Heartbeats.** One every 5 s in every cell this device holds. The base cell gets online and the position only. The product's own cell gets the product, the cursor and the agents count, unless "Show others what I am working on" is off. With it off, every cell gets the heartbeat only.
- **Cursors.** At most 10 a second.
- **Dropped frames.** A frame is dropped when it does not open, when it was sealed for another place, when its member is not the roster's member of the sending device, or when the roster does not know the device.
- **The people list.** Names and positions come from the receiver's roster, never from the message. An older `seq` never replaces a newer one. A person shows as last seen after the 30 s time to live or a leave.
- **Memory only.** Nothing is written to disk.
- **The replicator.** `LiveReplicator.postPresence` and `leavePresence` pass through its one transport while live, and do nothing otherwise.
- **The hover text.** `presenceText` (in liveSentences.ts, where sentences live) gives "Working on {product}. Running {n} agents.", "Live" or "Last seen HH:MM".

## Deviations from Plan

1. **[Re-aim] Task 3 (VS Code cursor decorations) was not executed.** It is superseded by native cursors (33-29). `staffEditorBinding.ts`, `staffLive.ts` and `vscodeStub.ts` were not touched. Must-have truth 5 is 33-29's.
2. **[Re-aim] `setPeople` is a callback option of `LivePresence`.** The plan's D-01 check expected `setPeople` in `src/services/staffSyncStatus.ts`. It is not there, because that part of 33-10 was superseded. `PresencePerson` is defined in `livePresence.ts`, and the native engine (33-24) connects the callback to the status store. No services file was changed.
3. **[Re-aim] The keys and the agents count come from callbacks** (`cells`, `keyFor`, `runningAgents`, `showWork`), which the native engine fills from the project's key ring and run board. `ReplicaProject` was not changed.
4. **`runs` is refused in the base cell too**, with `product`, `anchor` and `head`. The agents count says what someone is doing, so it travels only where the product does.

## Verification

All runs used the shared heavy lock, MemoryMax=6G and choom.

| Run | Result |
|-----|--------|
| replicaPresence, staffLivePresence, staffLiveSentences, staffLiveReplicator, architecture, copyLint and replicaBoundaries | 94 passed, 0 failed. The staffLivePresence file then hung until the run's timeout: the new passthrough test gave the replicator an event stream that never ended, so `stop()` waited for it forever. The fake stream now ends when it is closed, as a real one does. |
| Re-run of staffLivePresence and staffLiveReplicator | 27 passed, 0 failed, in 160 ms |
| **Boundary run, once, for 33-03 to 33-12:** every `staff*` and `replica*` extension test, with architecture, copyLint, hubIsolation and relayIsolation, and `NEAR_AI_HUB_NODE` set so the real-hub tracer tests run | **1960 passed, 0 failed, 0 skipped** |
| **Full hub suite on Node 26.13.1** | **422 passed, 0 failed, 3 skipped** (the older-Node checks, which need `NEAR_AI_HUB_OLD_NODE`) |
| `npx tsc` and the hub's `npm run lint` | clean |

One small change to 33-09 rides in this commit: the replicator's resume tick runs only when a server is configured, so a single-machine project keeps no timer.

- **Tests added: 21.** `replicaPresence.test.ts` has 9. `staffLivePresence.test.ts` has 12, among them the "base cell" test that checks every plaintext D opens for the product's name, the replicator passthrough, and the hover text.
- **Tests changed: 0.**
- `grep -c "near-ai/presence/v1" src/domain/replica/presence.ts` gives 1.
- `grep -cE "writeFile|appendFile|createWriteStream" src/staff/replica/livePresence.ts` gives 0.

## Known Stubs

None in the engine. The callbacks (`setPeople`, `runningAgents`, `cells`, `keyFor`) are filled by the native engine (33-24) by design, as the re-aim states.

## Threat Flags

None beyond the plan's register. The server relays only sealed bytes, and the base cell carries nothing about a product.

## Self-Check: PASSED

- `presence.ts`, `livePresence.ts` and both test files exist.
- The commit `9b77e5f1` is in HEAD.

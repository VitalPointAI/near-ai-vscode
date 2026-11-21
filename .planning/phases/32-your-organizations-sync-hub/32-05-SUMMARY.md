---
phase: 32-your-organizations-sync-hub
plan: 05
subsystem: staff host (shared projects)
status: complete
tags: [staff, replica, multi-user, start-again, D-09]
requires: []
provides:
  - "StaffHost.invalidateShared(): forgets the opened shared project and its replay cache, closes the old project after its pending work"
  - "Store identity check before every shared read (store folder dev:ino plus the mark's roster head); reopen on change"
affects:
  - "32-02 calls invalidateShared() from Start Again and Make a Single-Machine Copy"
  - "32-11 changes staffHost.ts and staffReplicaHostMode.test.ts again in wave 4"
tech-stack:
  added: []
  patterns:
    - "Cache keyed by an on-disk identity (lstat dev/ino plus a read-only secret field), taken before open and again after the host's own writes"
    - "Drop a cached handle only when it is still the one the caller used (compare the pending promise), so concurrent reads never close a fresh open"
key-files:
  created:
    - .planning/phases/32-your-organizations-sync-hub/32-05-SUMMARY.md
  modified:
    - src/staff/staffHost.ts
    - src/test/staffReplicaHostMode.test.ts
    - src/test/staffReplicaParity.test.ts
decisions:
  - "The identity is JSON [folder, head]: folder is 'dev:ino', 'missing' (ENOENT) or 'unreadable' (any other lstat error); head is the mark's signed.payload.rosterHead, null when absent, 'unreadable' when the value does not parse or the secret read fails"
  - "The identity is taken before ReplicaProject.open, so a change made while the project opens is seen by the next read (conservative)"
  - "A mismatch or a refused fold drops the cached project only when sharedOpen is still the promise that read used (dropShared), so two concurrent reads never close each other's fresh open"
  - "Checkpoint defaults: none in this plan; tracer gate passed on automated verify"
metrics:
  duration: "about 45 minutes"
  completed: 2026-11-20
estimate:
  tokens: 45023
  tasks: 2
actuals:
  tokens: 7317
  tasks: 2
  commits: 2
plan_head_before: ffddff863527f3bdb581bc908442b161c3804871
plan_head_after: 05b58a31c3fed9a3de56851160718b52bc5fe555
---

# Phase 32 Plan 05: Staff host follows its shared project's store across Start Again Summary

The staff host now keeps its opened shared project together with the store's identity (the store folder's device and inode numbers and the roster head this device's mark names), reopens the project when that identity changes or a fold is refused, and exposes `invalidateShared()` for Start Again and Make a Single-Machine Copy, so a window shows the project again without a reload.

## What changed

- `src/staff/staffHost.ts`
  - `storeIdentity()`: lstat of `<root>/.planning/staff/replica` (dev:ino, or 'missing'/'unreadable') plus the roster head read with `headStore.get(markKey(storeDir))` and JSON.parse. Read only, never verified: the reopened store verifies the mark itself (T-32-14 accepted). `markKey` is loaded with `import()` on the shared path only.
  - `openShared()` keeps `{ project, deps, identity }`; the identity is taken before the open.
  - `currentShared()` compares the identity now with the kept one before each shared read; a difference closes the old project and opens again.
  - `sharedReplay()` takes the identity again after each successful `state()` (the host's own `recordRosterHead` writes never count as an outside change) and drops the project in its catch, so a refused store is not reused.
  - `public async invalidateShared()`: clears `sharedOpen` and `sharedCache`, awaits the pending open and closes its project (`ReplicaProject.close` waits for the work already asked of it). `close()` now goes through it. `dropShared(pending)` calls it only when the cached promise is still the one the caller used.
  - The file comment's shared-project paragraph now says one ReplicaProject is kept per host while its store keeps the same identity.
- `src/test/staffReplicaHostMode.test.ts`: 7 new tests (16 total, 9 at HEAD).
- `src/test/staffReplicaParity.test.ts`: one call to `invalidateShared()` added before `close()` in the unshared-host test, which already asserts no replica module is loaded (the test title now says "invalidating or closing").

## Tests (failing first)

| Test | Red on | Red evidence |
|------|--------|--------------|
| Start Again while the host holds a cached project ... shows the products again without a reload | unchanged code | last replay still broken with the rolled-back sentence (`actual: { seq: 0, reason: "This project is shared ... older than what this device has already seen ..." }`, expected undefined) |
| a store folder replaced by a copy of itself ... opened again | unchanged code | open count `actual: 1, expected: 2` |
| five replays with nothing changed outside open the shared project once | Task 1 code | passed on Task 1 code (the plain no-change case already opened once); its teeth are in the next test |
| a roster change another window makes: folded by the host's own read it moves the mark without a reopen; recorded by the other window it reopens | Task 1 code | `the host's own mark write never counts as an outside change`: `actual: 2, expected: 1` (no identity retake after state()) |
| invalidateShared closes the opened project once and the next read opens it again; harmless on a host that opened nothing | Task 1 code | `TypeError: plain.invalidateShared is not a function` (and tsc TS2339) |
| a read whose fold is refused drops the opened project, so the next read opens it again and reads it once the folder is put back | Task 1 code | `the next read opened the project again instead of reusing the refused one`: `actual: 1, expected: 2` |
| close() goes through invalidateShared and ends the decode worker | Task 1 code | invalidateShared absent (TS2345 on mock.method); passes after Task 2 |

Final focused run (memory-capped wrapper): `staffReplicaHostMode`, `staffReplicaParity`, `staffMultiUserCommands`: 49 tests, 49 pass, 0 fail. `npm run lint` (tsc --noEmit) exits 0.

Acceptance greps: `grep -c markKey src/staff/staffHost.ts` = 2 (>= 1); `grep -c "public async invalidateShared" src/staff/staffHost.ts` = 1.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Concurrent reads could close each other's fresh open**
- **Found during:** Task 1
- **Issue:** Two reads that both saw a stale identity would each call invalidateShared(); the second would close the project the first had just opened.
- **Fix:** `dropShared(pending)` invalidates only when `sharedOpen` is still the promise that read used; the public `invalidateShared()` drops whatever is held.
- **Files modified:** src/staff/staffHost.ts
- **Commit:** 9f0224f4, 05b58a31

**2. Test design: the close() test gives the project a stand-in decode worker**
- **Found during:** Task 2
- **Issue:** A migrated project holds only its own entries, so it never makes a decode worker (one is made only for entries from outside), and the test could not see a worker end.
- **Fix:** the test puts a stand-in worker in the project's `ownDecoder` and asserts that `host.close()` calls `invalidateShared` once, the project's `close` once, and the stand-in worker's `close` once.
- **Commit:** 05b58a31

### Files outside the plan's list

- `src/test/staffReplicaParity.test.ts`: one added `invalidateShared()` call (and the test title) so the "loads no replica module" check covers `invalidateShared()` on an unshared host, as the plan's Task 2 behavior asks. That check can only live there, because staffReplicaHostMode imports replica modules itself.

## Known Stubs

None.

## Threat Flags

None. The mark is read for identity only (T-32-14 accepted per the plan); no new network, auth or file-write surface.

## Self-Check: PASSED

- FOUND: src/staff/staffHost.ts, src/test/staffReplicaHostMode.test.ts, src/test/staffReplicaParity.test.ts
- FOUND: 9f0224f4, 05b58a31 on feat/phase-32-05-host-reopen-shared

---
phase: 31-staff-roster-cell-keys-and-migration
plan: 18
subsystem: staff-replica
tags: [replica, keyring, x25519, secret-storage, genesis-pin, two-pass-fold, welcome, decode-worker, security-docs, tdd]
status: complete

requires:
  - phase: 31-10
    provides: DecodeHost (the memory-capped decode worker), wired here into the store's ForeignCheck
  - phase: 31-13
    provides: ReplicaStore (open, appendOwn, ingestForeign with the injected check, entries, heldForCheck, grants, putGrant, recordRosterHead, blob, head, refresh)
  - phase: 31-14
    provides: member.invite and member.admit in the roster fold, used by the join scenario
  - phase: 31-15
    provides: cellGrantees answers only once the founding grant is held; epochAt for the epoch an own entry is sealed under
  - phase: 31-16
    provides: buildInvite, readInvite, buildJoinRequest, checkJoinRequest, inviteAnchor, buildWelcome, readWelcome
  - phase: 31-17
    provides: the roster split and choose state the context signature tracks
provides:
  - "src/staff/replica/keyring.ts: ENCRYPTION_KEY_SECRET, loadOrCreateEncryptionKey, DeviceEncryptionKey, EPOCH_KEY_SECRET_PREFIX, DeviceKeyRing (load, openGrants, addOwn, keyRing, epochKey, version, size), JOIN_SECRET_PREFIX, storeJoinSecret, joinSecret, forgetJoinSecret"
  - "src/staff/replica/replicaProject.ts: ReplicaProject (open, createSharedProject, localDevice, pinAnchor, joinFromWelcome, state, context, refolds, appendOwn, findOwn, putGrants, ingestWelcome, ingestForeign, heldForCheck, welcomeFor, close, projectId, deviceWriter, signer, keys, anchor), PROJECT_REFUSALS_HOST, ReplicaProjectError, isProjectRefused, genesisPinFile, projectFile, anchorOf, sameAnchor"
  - "src/domain/staff/multiUser.ts: MULTI_USER_DECLARED_TEXT, multiUserNoticeLines, SHARED_PROJECT_REFUSAL, MULTI_USER_PREVIEW_SETTING"
  - "SECURITY.md ### Device encryption keys and the key ring"
affects: [31-19, 31-20, 31-21, 31-22, 31-23, 32]

tech-stack:
  added: []
  patterns:
    - "One long-lived ReplicaContext per project object, replaced only when the roster signature, the key ring version or the blob count changes; growth through addEntries"
    - "Pin outside the project, written only on create or join; project.json is a checked copy"
    - "Write order for a new project: key (SecretStorage), pin, founding grant, genesis, project.json; a retry reuses a pinned genesis this device wrote"
    - "Every check of a welcome before any write; then SecretStorage, pin, store, grants, project.json"
    - "ForeignCheck opens doc.update and doc.compact (and their blobs) with the key ring and asks DecodeHost; what it cannot open passes to the fold"

key-files:
  created:
    - src/staff/replica/keyring.ts
    - src/staff/replica/replicaProject.ts
    - src/test/staffReplicaKeyring.test.ts
    - src/test/staffReplicaProject.test.ts
  modified:
    - src/domain/staff/multiUser.ts
    - SECURITY.md

key-decisions:
  - "Pin path and encryption key name as planned (costly-reversibility Task 1, plan default A17): <globalStorage>/staff-replica/<project>/genesis.json holding { v: 1, anchor } (genesis hash, project id, lead member, writer, Ed25519 and X25519 public keys); project.json holds the same; SecretStorage names nearAi.identity.encryptionKey, nearAi.staff.epochKeys.<project>, nearAi.staff.joinSecret.<invite>"
  - "The pin is keyed by project id, not by folder: opening a folder never writes a pin, so a swapped project.json naming an unpinned project is refused not-shared instead of being trusted on first sight"
  - "The base cell's founding grant carries an empty labelSealed (every member is on the base cell); the project level goes in the genesis level field"
  - "The lead's display name is not written: the project.genesis schema has no field for it and the plan requires the roster to be exactly [origin, genesis] after create, so the lead's name in the roster is the member id until a member.update sets it (31-20 can write one through appendOwn). CreateSharedInput.lead.name is optional and documented as unused"
  - "Refusals beyond the four planned: pin-damaged (pin or project.json unreadable), already-shared (a folder holding another lead's project), welcome-refused (a welcome readWelcome refuses for a reason other than wrong-project, carrying that message)"
  - "appendOwn adds rosterPrev equal to the cited roster to a roster kind's data when it has none, cites the roster head by default, seals under the stream cell's epoch at that roster, and computes lamport as one more than the largest of prev and deps (the chain rule)"
  - "DeviceKeyRing.openGrants is async (Promise<number>) because the opened keys are written through to SecretStorage; persist merges with the stored value so two windows never drop each other's keys"
  - "The decode worker: deps.decodeHost when given (the caller closes it), otherwise one made on first inspect and ended by ReplicaProject.close()"
  - "joinFromWelcome makes this device's keys if missing (as answering the invite already did), then checks everything before writing project data"

requirements-completed: [MUS-04, MUS-05, MUS-06]

coverage:
  - id: D1
    description: "A shared project is created on disk, reopened, and folded through the real roster with this device's key ring; own doc entries are attributed to this device and member"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaProject.test.ts (tests 1 to 3)"
        status: pass
    human_judgment: false
  - id: D2
    description: "One context object reused: no refold when nothing changed, an own doc entry appended without a refold"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaProject.test.ts#one context object is reused"
        status: pass
    human_judgment: false
  - id: D3
    description: "pin-mismatch, not-shared, no store gives undefined, Pitfall 4 reuse"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaProject.test.ts (tests 5 and 6)"
        status: pass
    human_judgment: false
  - id: D4
    description: "One X25519 key per install across two processes; binding verifies; ring opens only own wraps and rebuilds from grants; join secrets; one delete; no secret in any file"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/staffReplicaKeyring.test.ts (7 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A second install joins from a welcome file and reaches the lead's roster head; a real decode worker applies an honest update and holds a hostile one; a welcome for another genesis is refused with no file changed"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/staffReplicaProject.test.ts (tests 7 to 9)"
        status: pass
    human_judgment: false
  - id: D6
    description: "multiUserNoticeLines order and no em-dash; SECURITY.md subsection"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/staffReplicaProject.test.ts#multiUserNoticeLines"
        status: pass
    human_judgment: false

actuals:
  tokens: 26805
  tasks: 4
  commits: 4
plan_head_before: 6fd7a91f98179df1f4abccea62933fa21a506a98
plan_head_after: 62b91eb8bad8874330b6be5864aaca8a7b0665ad

duration: 18min
completed: 2026-11-20
---

# Phase 31 Plan 18: Key ring and ReplicaProject Summary

**WP-R1 and WP-R2 now meet on the host. Each install has one X25519 key in secret storage, bound to its device key by a signature. Opened cell keys are cached only in secret storage and can be rebuilt from the grants. `ReplicaProject` pins the genesis outside the project, folds the roster first and then every stream through one long-lived context, lets a second device join from a welcome file, and sends every update from outside through the memory-capped decode worker before it reaches the fold.**

## Performance

- **Duration:** about 18 min
- **Started:** 2026-11-20T05:27Z
- **Completed:** 2026-11-20T05:45Z
- **Tasks:** 4 of 4
- **Files:** 6 (4 created, 2 modified)

## Accomplishments

- **`keyring.ts`**
  - `loadOrCreateEncryptionKey` makes the X25519 key inside `withFileLock(identityDir, IDENTITY_CREATE_LOCK_FILE)` and reads it back before use. It stores PKCS8 DER as base64, as the signing key is stored, and never replaces a stored value. It returns the binding signature over `x25519BindingBytes`.
  - `DeviceKeyRing` opens only this device's wraps and writes them through to `nearAi.staff.epochKeys.<project>`, merging with what another window stored. It has a `version` counter so the host can tell when the ring answers more.
  - Join secrets live under `nearAi.staff.joinSecret.<invite>`. `forgetJoinSecret` is the only `.delete(` in the module.
- **`replicaProject.ts`**
  - **Create:** `createSharedProject` writes in this order: key, pin, founding grant, genesis, project.json. If it is run again after a crash, it reuses a genesis this device already pinned. A folder that holds this device's project returns that project; a folder that holds another lead's project is refused.
  - **Open:** `open` returns undefined when there is no project.json. It refuses `not-shared` when there is no pin, `pin-mismatch` when project.json and the pin disagree, and `pin-damaged` when either one cannot be read.
  - **Fold:** `state()` refreshes the store, loads new grants (opening them into the ring) and new blobs, then folds:
    - The roster is folded first, from the pinned anchor, and only when entries, grants, keys or blobs changed.
    - The context is replaced only when the roster signature, the ring version or the blob count changed. New entries reach the main fold through `addEntries`.
    - The roster head is recorded in the store mark.
  - **Write:** `appendOwn` builds this device's entry with the right seq, prev, lamport, roster and epoch key. If another window wrote first (`out-of-order`), it rebuilds. It refuses `no-key` when this device lacks the key.
  - **Other own-data methods:** `findOwn`, so a retried step does not write twice, and `putGrants`.
  - **Joining:**
    - `pinAnchor` pins from an invite.
    - `joinFromWelcome` checks the welcome against the pin and this device before writing anything.
    - `ingestWelcome` takes a later welcome for the same project.
    - `welcomeFor(writer, cells)` builds the welcome from the lead's store, so 31-20 does not need to edit this file.
  - **From outside:** `ingestForeign` and `heldForCheck`, through a `ForeignCheck` that opens `doc.update` and `doc.compact` bodies and blobs with the ring and asks `DecodeHost.inspect`. `close()` ends the worker.
- **`multiUser.ts`:** `MULTI_USER_DECLARED_TEXT`, `multiUserNoticeLines()` (the two Phase 70 notices, then the D-13 sentence), `SHARED_PROJECT_REFUSAL`, `MULTI_USER_PREVIEW_SETTING`.
- **SECURITY.md:** `### Device encryption keys and the key ring`, added inside `## Multi-user staff projects (preview)` after the cell keys subsection.

## Task Commits

1. **Task 1 (tracer): project host, pin, two-pass fold, one context:** `4d588880` (feat). Tracer gate: the verify was re-run end to end (6 of 6) and a mutation run confirmed the guards bite before the next task.
2. **Task 2: key ring tests:** `68429286` (test)
3. **Task 3: welcome join and the decode check:** `c6402584` (feat)
4. **Task 4: notices and SECURITY.md:** `62b91eb8` (docs)

## Test results

Every run went through the shared flock lock and the memory cap (`MemoryMax=4G`, `--max-old-space-size=1536`). Each compile was `node scripts/vendor-libs.mjs && tsc -p tsconfig.json` and exited 0.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1: staffReplicaProject | 6 | 6 | 0 |
| Task 2: staffReplicaKeyring, teamIdentity | 30 | 30 | 0 |
| Task 3: staffReplicaProject, staffReplicaStore, staffReplicaWorker | 48 | 48 | 0 |
| Task 4: staffReplicaProject, staffReplicaKeyring | 17 | 17 | 0 |
| Final focused: every dist/test/replica*.test.js and staffReplica*.test.js, plus teamIdentity, teamSignedPayload, staffLedgerIntegrity and gateDocs | 658 | 658 | 0 |

Counts against the plan: staffReplicaProject has 10 tests (it asked for at least 5, then 8, then 9), and staffReplicaKeyring has 7 (at least 6).

**Mutation checks** were made in compiled `dist/` only, and the next compile restored it:
- Always building a new context fails the context-reuse test.
- Skipping the pin comparison fails the pin-mismatch test.
- Skipping the genesis reuse fails the Pitfall 4 test.
- Replacing the identity lock with a direct call fails the two-process key test.
- Letting every decode verdict pass fails the hostile-update test.

**Acceptance greps:**

| Check | Result |
|-------|--------|
| `IDENTITY_CREATE_LOCK_FILE` in keyring.ts | 2 |
| `foldRoster` in replicaProject.ts | 2 |
| `.delete(` in keyring.ts | 1 |
| `DecodeHost` in replicaProject.ts | 5 |
| the D-13 sentence in multiUser.ts | 1 |
| the SECURITY.md heading | 1 |
| em-dashes in SECURITY.md and multiUser.ts | 0 |
| em-dashes in every file this plan touched | 0 |

The full `npm test`, e2e and `verify:release` were not run; the orchestrator runs them at the phase end.

## TDD note

Tasks 1 and 3 wrote the module and its tests in the same working session, so the first test runs were already green. There was no separate RED commit. RED evidence comes from the mutation checks above, each of which made the named tests fail. Task 2 is test-only: its module code shipped in the Task 1 tracer commit, because the tracer needed the encryption key and the ring.

## Decisions Made

All are in the frontmatter `key-decisions`. The plan had no checkpoint. Task 1 is rated costly to reverse, and its planned locations were taken unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2: Missing critical functionality] API additions so wave 8 never edits replicaProject.ts**
- **Issue:** 31-20 must not edit `replicaProject.ts`. It still needs to do several things with the project:
  - pin an invite's genesis before the welcome arrives,
  - build a welcome from the lead's store,
  - read this device's public keys for a join request,
  - sign grants,
  - open labels with epoch keys.
- **Fix:**
  - Added `pinAnchor`, `joinFromWelcome` (static), `welcomeFor`, `localDevice`, `signer` and `keys`.
  - Added `heldForCheck`, `close` and `refolds` for hosts and tests.
  - Added an optional `deps.cellOrder` hook, so the host can supply the D-25 cell order without editing this file.
- **Files:** src/staff/replica/replicaProject.ts. **Commits:** 4d588880, c6402584

**2. [Rule 2] Three more refusals**
- `pin-damaged`, `already-shared` and `welcome-refused` were added beside the four planned ones (see decisions). Each has a plain message with no key or hash.

**3. [Rule 3: Blocking] The ForeignCheck reads blobs too**
- **Issue:** an update larger than an inline body (16 KiB) travels in a sealed blob. The hostile probe in the test is one of these (about 200 KB). A check that read only inline bodies would let every large update through unchecked.
- **Fix:** the check opens the blob from this delivery, or from the store, before asking the worker. A blob that has not arrived passes, and the fold holds the entry for it (see Known Stubs).

**4. [Planning note] openGrants is async** (see decisions).

### Notes

- **Branch:** the plan names it `feat/phase-31-18-replica-project`; the orchestrator dispatched this plan on `feat/phase-31-18-keyring`.
- **Lead name:** see decisions. If the owner wants the lead's display name in the roster, 31-20 can write `member.update { name }` through `appendOwn`.

## Flake investigation: replicaCellKeys "a grant is refused unless it is the committed one..."

I read the test and every code path it reaches: `placeGrants` in roster.ts, `addGrant` and `readGrant`.

**Random values in the test, and why none decides the outcome:**
- Wrap ephemeral keys and IVs: each grant's hash is random per run.
- Entry IVs: entry hashes are random per run.
- The join secret in `admitted()`.

**Why the result does not depend on them:**
- Each grant's refusal reason depends only on its own fields: roster, epoch, signer and wrap writers. It never depends on another grant or on the order grants arrive in.
- Both arrays the test compares are sorted with the same string comparison.
- Grant signatures use the constant `REPLICA_SIGNED_AT`.
- The `isStrictBase64url` checks on random wraps always pass for buffers Node encoded.

**Conclusion:** I found no source of randomness that can change the result, so the test file was not changed.

A likely outside cause is a test process killed or starved under the shared 4G memory scope while a heavy file ran in the same batch. `staffReplicaWorker` deliberately runs workers up to their memory cap, and `choom -n 1000` makes every test process an equal OOM candidate. A killed process shows as a failure of the test that was running.

If it happens again, keep the full runner output. A "cancelled" or "did not finish" line would confirm this cause; an assertion diff would refute it.

## Known Stubs

None that block the plan's goal. Two seams are intentional:
- `deps.cellOrder` is absent by default, so every citation is allowed. 31-20 or 31-23 supplies the cell order from Phase 70 dominance, as 31-15 planned.
- The ForeignCheck passes an update whose blob has not arrived. The fold holds that entry for its blob, and once the blob arrives the in-process guard (updateGuard, 31-03) still refuses an oversized update. The worker check does not run on that late blob. In Phase 31, transports deliver blobs with their entries (`ingestForeign(entries, blobs)`).

## Threat Flags

None beyond the plan's register:
- **T-31-57 (secrets on disk):** mitigated, with a scan test over the project folder and global storage.
- **T-31-58 (two windows, two keys):** mitigated by the identity lock, tested across two processes.
- **T-31-59 (welcome or project.json for another genesis):** mitigated, with pin-mismatch tested before and after a join.
- **T-31-60 (hostile entries from outside):** mitigated: the real DecodeHost holds them and `heldForCheck` lists them.
- **T-31-61 (refold on every call):** mitigated, with the refold count tested.
- **T-31-SC:** no package was installed.

The new files are the pin in extension storage and project.json. They hold only public keys and hashes, and SECURITY.md documents both.

## Next Phase Readiness

- **31-19 (migration):** `ReplicaProject.createSharedProject(root, deps, { name, profile, level, labelMapHash, lead: { member } })`, then `findOwn('project.import', predicate)` before `appendOwn('project.import', data, { deps })`. Notices come from `multiUserNoticeLines()`.
- **31-20 (membership):**
  - Joining side: `pinAnchor(deps, inviteAnchor(invite))`, then `ReplicaProject.localDevice(deps)` for the join request.
  - Lead side: `appendOwn('member.admit', ...)`, then `putGrants`, then `welcomeFor(writer, cells)`.
  - Joining side again: `joinFromWelcome(root, deps, welcomeText)`.
  - Join secrets go through keyring.ts. Labels are opened with `project.keys.epochKey(cell, epoch)`.
- **31-21 and 31-23:** `SHARED_PROJECT_REFUSAL` and `MULTI_USER_PREVIEW_SETTING` are in the pure `multiUser.ts`. `ReplicaProject.open` returns undefined for a folder that is not shared.

## Self-Check: PASSED

- FOUND: src/staff/replica/keyring.ts, src/staff/replica/replicaProject.ts, src/test/staffReplicaKeyring.test.ts, src/test/staffReplicaProject.test.ts, src/domain/staff/multiUser.ts, the SECURITY.md subsection
- FOUND: commits 4d588880, 68429286, c6402584 and 62b91eb8 are ancestors of HEAD

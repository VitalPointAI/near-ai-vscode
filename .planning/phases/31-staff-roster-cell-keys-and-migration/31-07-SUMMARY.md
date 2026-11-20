---
phase: 31-staff-roster-cell-keys-and-migration
plan: 07
subsystem: replica
tags: [replica, versions, gates, caps, size-gate, yjs]

requires:
  - phase: 31-01
    provides: RosterView.canRunAgent (default deny) and the agent seat fixtures
  - phase: 31-03
    provides: snapshotReport, inspectState, sealedBlobWithin, MAX_STATE_BYTES
  - phase: 31-04
    provides: the hardened text reducer (textFold.ts) this plan adds the blob gate to
  - phase: 31-05
    provides: the decision algebra whose work the per-writer act cap bounds
provides:
  - "Gate verdicts only from members allowed to run the gate seat (not-gate-member, WR-01)"
  - "One snapshot inspection per proposal; attribution runs kept on the proposal (WR-05 versions part)"
  - "Per-writer caps: 200 proposals per product (too-many), 32 acts per version (too-many-acts) (WR-05, WR-06)"
  - "Size gates before openBlob in applyCompaction and readBlobText (new defect 1)"
  - "applyCompaction inspects the opened state with inspectState (2 MiB), closing the 31-03 handoff"
affects: [31-08, 31-13, 31-15, 31-17, 32, 33]

actuals:
  tokens: 11276
  tasks: 3
  commits: 3
plan_head_before: 509c39abacafeebedc0f942a6b8faf8e0e16fcd0
plan_head_after: afd5b5ff

tech-stack:
  added: []
  patterns:
    - "Reducer caps counted in reducer state, checked before any expensive work; held outcomes leave no count"
    - "Blob size gate after the name check and before key fetch or decryption"
    - "node:test mock.method on the keys module to prove AES-GCM never ran for a blob"

key-files:
  created: []
  modified:
    - src/domain/replica/versions.ts
    - src/domain/replica/textFold.ts
    - src/test/replicaForbiddenActs.test.ts
    - src/test/replicaVersions.test.ts
    - src/test/replicaDoc.test.ts

key-decisions:
  - "The seat check runs before release.ts in validVerdicts, so a member without the seat gets not-gate-member whatever else is wrong with the verdict"
  - "Every proposal that passes the owner check counts toward the 200 cap, refused or applied; a held one does not"
  - "Acts are counted per (version hash named, writer) at apply time, before they are stored"
  - "The blob size check comes after the name (hash) check, so a wrong copy is still held, never refused too-large"
  - "versions gains its own too-large refusal sentence rather than reusing bad-blob"

requirements-completed: [MUS-04, MUS-03]

coverage:
  - id: D1
    description: "A gate verdict from a member whose roster entry does not list the seat is refused not-gate-member; a seat holder's is accepted; a view without canRunAgent denies"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaForbiddenActs.test.ts#WR-01 (four tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A proposal costs one snapshot inspection and finishing the fold costs none"
    requirement: MUS-03
    verification:
      - kind: unit
        ref: "src/test/replicaVersions.test.ts#WR-05: a proposal costs one snapshot inspection"
        status: pass
    human_judgment: false
  - id: D3
    description: "Proposal cap (200, too-many) and act cap (32, too-many-acts), with incremental equal to fresh"
    requirement: MUS-03
    verification:
      - kind: unit
        ref: "src/test/replicaVersions.test.ts#WR-05 201st proposal, WR-05 held proposal, WR-06 33rd act"
        status: pass
    human_judgment: false
  - id: D4
    description: "Oversized compaction state and proposal text blobs are refused too-large without decryption; honest 360 KB compaction state accepted"
    requirement: MUS-03
    verification:
      - kind: unit
        ref: "src/test/replicaDoc.test.ts#31-03 handoff and new defect 1; src/test/replicaVersions.test.ts#new defect 1"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-11-20
status: complete
---

# Phase 31 Plan 07: Versions reducer hardening and blob size gates Summary

**Only a member the roster lets run the release guard or tradecraft seat can now move a version through that gate, a proposal costs one snapshot inspection, one writer can no longer flood a product with proposals or a version with acts, and no reducer decrypts a blob larger than the 2 MiB state limit.**

## Performance

- Duration: about 30 minutes (2026-11-20T03:45Z to 04:15Z)
- Tasks: 3 of 3
- Files modified: 5

## Accomplishments

- **WR-01 (D-12, T-31-16):** `validVerdicts` takes the gate's seat from the version's roles (`releaseGuard` or `tradecraftReviewer`) and drops a verdict `not-gate-member` unless `roster.canRunAgent(entry member, seat, cited roster)` is true. A view without `canRunAgent` allows nobody. A dropped tradecraft verdict no longer counts as a sign-off for a later guard verdict.
- **WR-05 versions part (T-31-17):** the proposal check calls `snapshotReport` once. It answers missing, text and attribution runs. The runs are kept on the `VersionProposal`, so `deriveProduct` no longer builds a scratch document on every finish. Before, every proposal cost two builds at apply and one more per version on every finish. A test-only counter (`ProductEntry.snapshotReports`) pins one build per proposal that reaches the check.
- **Caps (WR-05, WR-06):** `MAX_PROPOSALS_PER_WRITER_PRODUCT = 200` (`too-many`), checked before any blob is opened. `MAX_ACTS_PER_WRITER_VERSION = 32` (`too-many-acts`), counted per (version hash named, writer) at apply time. Both counts live in reducer state and are cloned, so incremental and fresh folds agree (tested).
- **New defect 1 (T-31-18):** `applyCompaction` and `readBlobText` call `sealedBlobWithin(blob, MAX_STATE_BYTES)` before `openBlob`. An oversized blob is refused `too-large` from its base64url length. In `readBlobText` this happens before the key is even fetched.
- **31-03 handoff:** `applyCompaction` now checks the opened state with `inspectState` (2 MiB) instead of `inspectUpdate` (256 KiB). An honest 360 KB compaction state is accepted as verified. It was refused `too-large` before.

## Task Commits

1. Task 1 (tracer): refuse a gate verdict from a member without the seat (WR-01): `7ccf4d96` (fix)
2. Task 2: one snapshot inspection per proposal, proposal and act caps: `b3a87dbb` (fix)
3. Task 3: size-gate compaction and proposal blobs before they are opened: `afd5b5ff` (fix)

Each commit holds its tests and its code together. The RED runs below were taken against the unchanged code before each fix.

## Re-verification on the old code (RED evidence)

- **WR-01:** I ran a probe script (in the session scratchpad, outside the repo) on the compiled code before the fix. Plain member mbr-x has no gate seat. Its device wrote SIGN-OFF labelled `tradecraft`, then CLEARED labelled `release-guard`, and the fold returned `{"state":"guard-checked","refusals":[]}`. The new test file then ran 15 tests: 12 passed and 3 WR-01 tests failed (refusal `undefined` where `not-gate-member` was expected). The tracer gate re-ran the Task 1 verify end to end (73 of 73 passed) before I went on to Task 2.
- **Task 2:** RED was at compile time only (the new constants and the `VersionsState` counters did not exist). From the code: the old reducer called `snapshotMissing` and `textAtSnapshot` (two scratch builds) per proposal, and `attributionAtSnapshot` once per version on every finish.
- **Task 3:** I compiled the new tests against the pre-Task-3 `textFold.ts` and `versions.ts`, and all three failed. The 360 KB honest compaction was refused (`too-large` from `inspectUpdate`). The oversized compaction blob was decrypted (its IV was in the `openRaw` calls). The oversized proposal text was decrypted, parsed and taken to a scratch build, which refused it `text-not-in-document`.

## Files Created/Modified

- `src/domain/replica/versions.ts`:
  - New refusals in `VERSION_REFUSALS`: `not-gate-member`, `too-many`, `too-many-acts` and `too-large`.
  - New constants `MAX_PROPOSALS_PER_WRITER_PRODUCT` and `MAX_ACTS_PER_WRITER_VERSION`.
  - `ProductEntry` gains `proposalCounts`, `actCounts` and `snapshotReports`. `VersionProposal` gains `runs`.
  - `applyPropose` is split into the cap check plus `checkProposal`.
  - `readBlobText` gets the size gate.
  - Imports `MAX_STATE_BYTES` (kindSchemas/doc) and `sealedBlobWithin` (updateGuard). Both are hub-side.
- `src/domain/replica/textFold.ts`: size gate before `openBlob`, `inspectState` for the opened state, and the `too-large` sentence now names the compaction state too.
- `src/test/replicaForbiddenActs.test.ts`: the fixture takes optional extra members and an optional tradecraft gate. 4 new WR-01 tests (11 to 15).
- `src/test/replicaVersions.test.ts`: 5 new tests (22 to 27): the inspection count, the proposal cap, a held proposal not counted, the act cap, and the oversized text blob.
- `src/test/replicaDoc.test.ts`: 2 new tests (32 to 34): the honest state over 256 KiB, and the oversized state blob with the exact-limit boundary.

`src/domain/replica/holdWaits.ts` was **not** touched. No new hold reason was added; every new outcome is a refusal.

## Decisions

- **Plan defaults taken:** `MAX_PROPOSALS_PER_WRITER_PRODUCT = 200` and `MAX_ACTS_PER_WRITER_VERSION = 32`, as written. No checkpoints in this plan.
- **Where the seat check sits:** before `release.ts` sees the verdict. A member without the seat therefore always gets `not-gate-member`, even when the verdict is wrong in another way too (for example a wrong word or a wrong state). If the product has no tradecraft gate, there is no seat to ask about, and `release.ts` still answers `no-tradecraft-gate`.
- **What counts toward the proposal cap:** every proposal that passes the owner check, whether it is refused (`no-change`, `hash-mismatch`, `bad-blob`, `too-large`, `text-not-in-document`) or applied. Each of these can cost a decryption and a scratch build. A held proposal does not count, because a held entry must leave no trace. A `not-owner` proposal does not count either, because it costs nothing.
- **What the act cap counts:** acts per (version hash the act names, writer), including hashes no version has yet. Those acts are still stored and refused `stale-version` in finish, as before. A writer can still spread acts over many made-up hashes, at 32 each; see Known limits.
- **Order of the blob checks:** the name (hash) check comes before the size gate. A blob whose bytes do not match its name may be a wrong copy and the right one may still arrive, so it stays held `missing-blob`. Refusing it `too-large` would leave the incremental fold refused while a later fresh fold applies it. Because the gate runs after the name check, `blobBytesHash` still decodes the whole blob once. That allocation is bounded by the store's `BLOB_MAX_BYTES` (8 MiB) refusal, which is planned in 31-13. AES-GCM decryption, JSON parsing and Yjs decoding are all avoided.
- **The proposal text limit** is `MAX_STATE_BYTES` (2 MiB of sealed plaintext), as the plan says. The refusal has its own sentence (`too-large`) and does not reuse `bad-blob`, so a person can tell "too big" from "unreadable".

## Deviations from Plan

### Auto-fixed Issues

None needed: no defect outside the plan was found.

### Notes

- **The plan says to add `too-large` to `TEXT_REFUSALS`, but it was already there** (31-03 and 31-04 use it for updates). I widened its sentence to cover the compaction's full state instead of adding a duplicate key.
- **"no Buffer of that size" (Task 3 behaviour):** this holds for decryption and decoding but not for the name check. See the decision on the order of the blob checks above. The test proves the property that matters here: a spy (`mock.method` on `openRaw` in `src/domain/state/keys.ts`) shows that the oversized blob was looked up and never decrypted.
- **Exact-limit boundary:** a blob of exactly `MAX_STATE_BYTES` of junk plaintext passes the gate, is decrypted, and is then refused `forbidden-content` by the state inspection. A blob one byte over the limit is refused `too-large` without being decrypted.
- **Fixture member added:** the WR-01 tests needed one member allowed to run both gate seats (`mbr-t`) and one allowed to run only the release guard (`mbr-g`). They are added only in those tests, through a new optional `members` argument to the local fixture. No 31-01 seat fixture was changed.
- **Lock and memory cap:** the commands used the brief's lock (`p31-build.lock`) with MemoryMax=4G, not the plan's `heavy.lock`.

## Test Results

All runs used `flock p31-build.lock systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`, and tsc compiled with no errors in each.

| Run | Files | Result |
|-----|-------|--------|
| Task 1 RED | replicaForbiddenActs | 15 tests, 12 pass, 3 fail (expected) |
| Task 1 verify | replicaForbiddenActs, replicaVersions, replicaVersionDecisions, replicaIntegration, replicaConvergence | 73 pass, 0 fail |
| Task 2 verify | replicaVersions, replicaVersionDecisions, replicaAttribution, replicaVectors | 69 pass, 0 fail |
| Task 3 RED | replicaDoc, replicaVersions on the pre-Task-3 reducers | 61 tests, 58 pass, 3 fail (expected) |
| Task 3 verify | replicaDoc, replicaVersions, replicaReevaluation, replicaConvergence | 84 pass, 0 fail |
| Final | every `dist/test/replica*.test.js` (no staffReplica files exist yet) | 351 pass, 0 fail |

Acceptance greps:

| Check | Count | Required |
|-------|-------|----------|
| `not-gate-member` in versions.ts | 3 | at least 2 |
| `too-many-acts` in versions.ts | 2 | at least 2 |
| `snapshotReport` in versions.ts | 6 | at least 1 |
| `sealedBlobWithin` in textFold.ts | 2 | at least 1 |
| `sealedBlobWithin` in versions.ts | 2 | at least 1 |

Test counts: replicaForbiddenActs 15 (at least 14), replicaVersions 27 (at least 25), replicaDoc 34 (32 after 31-04, plus 2).

The full `npm test` was not run, as the brief requires; the orchestrator runs it.

## Known limits

- A writer can still name many different made-up version hashes, with up to 32 acts each. Each such act is stored and then refused `stale-version` in finish. Bounding this needs a cap on acts per writer per product, or refusing acts whose version is unknown at apply time. The second option would make the outcome depend on order, so I left it out of this plan.
- Held proposals do not count toward the cap, and each refold of a held proposal (for example `updates-missing`) still costs one scratch build. Only an admitted entry that sorts before it triggers that refold (31-02).

## Known Stubs

None.

## Threat Flags

None. No new endpoint, dependency, file access or agent capability. T-31-16, T-31-17 and T-31-18 are mitigated and tested. T-31-SC: no package was installed.

## Self-Check: PASSED

- FOUND: src/domain/replica/versions.ts, src/domain/replica/textFold.ts, src/test/replicaForbiddenActs.test.ts, src/test/replicaVersions.test.ts, src/test/replicaDoc.test.ts
- FOUND commits on HEAD: 7ccf4d96, b3a87dbb, afd5b5ff

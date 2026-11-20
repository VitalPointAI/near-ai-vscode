---
phase: 31-staff-roster-cell-keys-and-migration
plan: 19
subsystem: staff-replica
tags: [replica, migration, projection, legacy-ledgers, idempotent, tdd]
status: complete

requires:
  - phase: 31-09
    provides: project.import file and mark fields, ProjectImport.fileHash and marked
  - phase: 31-11
    provides: projection.ts (projectLedgerReplay, projectProductFile, projectionEntry)
  - phase: 31-13
    provides: ReplicaStore, LEGACY_DIR, REPLICA_PROJECT_FILE
  - phase: 31-18
    provides: ReplicaProject (createSharedProject, findOwn, appendOwn, ingestForeign, keys), multiUserNoticeLines
provides:
  - "src/staff/replica/migrate.ts: MIGRATION_STEPS, LEGACY_LEDGERS, PASSTHROUGH_LEDGERS, MIGRATION_REFUSALS, isMigrationRefused, verifyLegacyLedgers, verifyLegacyBytes, ledgerHeadKey, wargameCount, makeMultiUser, migrationComplete, projectionInputOf"
  - "src/staff/replica/projection.ts: IMPORTED_APPROVAL_TEXT, IMPORTED_PRODUCTS_LEDGER, ImportedProduct, ProjectedProductState, projectImportedLedger, importOf, importedFile, ledgerLinesOf, the imported-product overlay in projectLedgerReplay and projectProductStates, ProjectionEntry.deps, writeProjections, PassthroughLedger, ProjectionWrite"
  - "src/test/staffReplicaMigration.test.ts: 24 tests"
affects: [31-21, 31-22, 31-23, 33]

tech-stack:
  added: []
  patterns:
    - "Every step reads its state from disk and the store, never from memory: a step whose result is there does nothing, so a resumed run writes the same entries"
    - "Look up before sealing: findOwn for an import by ledger (a changed head refuses ledger-changed), reconstruct entries by their exact data (the same client id and text give the same Yjs update bytes)"
    - "Imported products are projected from the replay of the imported ledger, checked against the import's head, count and file hash, until replica acts exist on top"
    - "Fixed randomness in tests: each random draw hashed from the calling code site and its call count, so two installs from the same bytes write identical entries"

key-files:
  created:
    - src/staff/replica/migrate.ts
    - src/test/staffReplicaMigration.test.ts
  modified:
    - src/staff/replica/projection.ts

key-decisions:
  - "The lead's device writes one member.update giving the lead section_lead for every section that holds a product (plus member): the versions reducer accepts a proposal only from the owner side, and a staff lead alone is not owner side"
  - "Only the current version of a product is reconstructed, and only when the file's body is exactly that version's text and every pin names a reconstructed version; otherwise the product gets a live text only and is still shown from the imported ledger"
  - "A broken ledger's refusal is MIGRATION_REFUSALS['ledger-broken'] followed by today's sentence word for word (a test pins the second part to today's host refusal)"
  - "Once a ledger is in the legacy folder, verify reads it there; a file at the usual path after that is later content and is never verified, moved or written over"
  - "writeProjections does not write events.jsonl: imported products add no step to it, and the projected events of later acts belong to Phase 33's live layer"
  - "Defaults when the command passes none: project name = the project folder's name, labelMapHash = sha256 of an empty map, lead member id = mbr- plus the first 16 hex of this device's writer id"
  - "The completion marker is a migration field in project.json beside the anchor 31-18 writes (readAnchorFile ignores other top-level keys)"

requirements-completed: [MUS-06]

actuals:
  tokens: 24745
  tasks: 3
  commits: 3
plan_head_before: bd94109cdd618e807bece173a05241fc50f5d6f6
plan_head_after: 3767823786180634dce66f814e6025d5644c698a

duration: 75min
completed: 2026-11-20
---

# Phase 31 Plan 19: Make This Staff Project Multi-User Summary

**A single-machine staff project now becomes a shared one without loss. Today's four ledgers are verified first, then imported whole with their legacy heads and the product ledger's signed head mark. Each product is rebuilt as a live text and a version with its original text, and the originals move to `.planning/staff/legacy/`. The files are written back as projections that are byte for byte today's files, and a conversion interrupted after any step reaches exactly the same entries, fold digests and files when run again.**

## Accomplishments

- **`migrate.ts`** runs `makeMultiUser(root, deps, options?)` as seven steps. Each step does nothing when its result is already there.
  - **verify:** checks the ledgers with today's own verifiers and key status:
    - products: `replayLedger` with the SecretStorage head mark, read and verified as `staffHost.readHead` does;
    - decisions: `replayPersonDecisions`;
    - calculator: `replayCalcLedger`;
    - wargame: sha256 of the file, and the number of readable lines.
    - A broken or unreadable ledger refuses before anything is written, with today's sentence and its way out.
  - **genesis:** `ReplicaProject.createSharedProject`, with the profile and level taken from today's staff settings.
  - **import:** one `project.import` per ledger present (ledger, legacyHead, count, the whole file, and the mark for products). It is looked up with `findOwn` first, and a different head refuses `ledger-changed`.
  - **reconstruct:** `member.update` (the lead's section roles), then for each product: `product.create`, `doc.client` (lead's slot), `doc.update` pieces, and `version.propose` (text and header blob stored through `ingestForeign`). Every entry cites the products import.
  - **move-legacy:** a `rename` into the legacy folder, only when the source is there and the destination is free.
  - **projections:** writes the files back (below).
  - **complete:** adds a `migration` marker to `project.json`.
- **`projection.ts`**
  - A product whose fold history holds nothing beyond the reconstruct entries is shown from today's replay of the imported ledger. That replay must end at the import's head and count and match its file hash. Such a product carries `imported: { ledger, entry, approval? }`, where `approval` is `IMPORTED_APPROVAL_TEXT`.
  - `writeProjections` writes each product file (`projectProductFile` over the fold's live text) and the decisions, calculator and wargame ledgers back at their usual paths, all through `writeIfUnchanged`. A passthrough path that already holds other bytes is left and listed.
  - The known 31-11 gap (an open request has no options, dissent or deadline) does not reach imported products, since they are shown from the legacy replay. It remains for fold-native products, and the schema was not widened.
- **`projectionInputOf(project, deps)`:** the projection input for an open shared project (fold, verified entries, and version texts for pinned versions), for 31-21 to use.

## Task Commits

1. Task 1 (tracer): `cd4cfd8c` feat(31-19): make a staff project multi-user, and its files stay the same
2. Task 2: `bb1b52f8` test(31-19): all four ledgers verified first, imported with their heads and re-verified
3. Task 3: `37678237` test(31-19): a conversion interrupted after any step ends in the same place

## Test Results

Every run used the shared flock lock and the memory cap (MemoryMax=4G, --max-old-space-size=1536). Each compile ran `vendor-libs` and then `tsc -p tsconfig.json`, and exited 0.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1 verify: staffReplicaMigration (4 tests at that commit), staffReplicaProjection | 52 | 52 | 0 |
| Task 2 verify: staffReplicaMigration (13), staffLedgerIntegrity, staffLogistics | 43 | 43 | 0 |
| Task 3 verify: staffReplicaMigration (24), staffReplicaProject | 34 | 34 | 0 |
| Plan verification: staffReplicaMigration, staffReplicaProjection, staffReplicaProject, staffLedgerIntegrity, staffLogistics, replicaBoundaries | 118 | 118 | 0 |
| Final focused: every dist/test/replica*.test.js and staffReplica*.test.js, plus staffLedgerIntegrity and staffLogistics (38 files) | 622 | 622 | 0 |

The full `npm test`, e2e and verify:release were not run; the orchestrator runs them once at the end.

**Tracer gate:** Task 1's verify was re-run end to end before the expansion tasks, and it passed.

**Mutation checks** were made in compiled `dist/` only. Each file was restored and checked with `cmp`, and the final run above used fresh output.

| Mutation | Result |
|----------|--------|
| The import is never looked up | 4 interruption tests fail: import, reconstruct, move-legacy, projections |
| Reconstruct never looks up `product.create` | 3 interruption tests fail |
| Both move guards removed | The resumed-move test fails |
| One move guard removed | Nothing fails, because the other guard still holds. That is why there are two |
| The imported-product overlay is off | The tracer and replay tests fail |

**Acceptance greps:**

| Check | Result | Required |
|-------|--------|----------|
| `IMPORTED_APPROVAL_TEXT` wording in projection.ts | 1 | 1 |
| `unlink(`, `rm(` or `rmdir(` in migrate.ts | 0 | 0 |
| `replayPersonDecisions` in migrate.ts | 4 | at least 1 |
| `test('interrupted after <step>` in the test file | 7 | 7 |
| Tests in the file | 24 | at least 18 |
| Test names containing "re-verif" | 1 | at least 1 |
| Em-dashes in the three files | 0 | 0 |

## TDD Gate Compliance

There are no separate RED commits. The module and the tracer tests were written in one working session, because the step design depended on what the replica layer accepts: the owner-side rule, `textBlob` storage and the store API. Tasks 2 and 3 are test commits on the code from Task 1. The RED evidence is the mutation checks above, each of which made the named tests fail.

## Decisions (defaults taken, owner asleep)

- The plan's one-way task (Task 1, migration writes permanent signed history) was taken with the plan's design unchanged: genesis, imports, rebuilt products, moved originals.
- All other decisions are in `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The lead gets section roles before reconstruct**
- **Issue:** `version.propose` is refused `not-owner` unless the writer holds `answers_for:<section>` or `section_lead:<section>`. After genesis, the lead holds only `member`.
- **Fix:** one `member.update` with `section_lead:<section>` for each section that holds a product. It is skipped when the roster already gives those roles, and it cites the import.
- **Files:** migrate.ts. **Commit:** cd4cfd8c

**2. [Rule 3 - Blocking] The version blob is stored through `ingestForeign([], [blob])`**
- **Issue:** `appendOwn` stores only the blobs `buildEntry` makes, but a proposal's `textBlob` is a separate sealed blob. `replicaProject.ts` is not this plan's file.
- **Fix:** the blob is stored with `ReplicaProject.ingestForeign([], [blob])`. The decode check is not called, because no entries are passed.

**3. [Rule 3 - Blocking] `projectionInputOf` opens a second `ReplicaStore` read-only**
- **Issue:** `ReplicaProject` exposes no sealed entries.
- **Fix:** the store is opened read-only and each entry is verified again under `project.context()`.

**4. [Rule 2 - Missing critical] Two more refusals: `ledger-changed` and `project-refused`**
- **`ledger-changed`:** an import of the ledger exists with another head. A second import would give two histories of one ledger (P-31-26).
- **`project-refused`:** carries the ReplicaProject or store refusal's message.

**5. [Rule 2] `ProjectionEntry.deps` (optional) and `projectionEntry` filling it**
- **Why:** this is how the projection sees which entries cite the import, as the plan intends.

### Interface notes

- `writeProjections(root, input, passthrough)` takes the projection input and the passthrough ledger table, not the project object. migrate.ts builds the input with `projectionInputOf`, which keeps projection.ts free of the store.
- The broken-ledger message is `MIGRATION_REFUSALS['ledger-broken']` followed by today's sentence. The tests assert the whole message equals that, with today's part taken from today's host refusal.
- The plan says decisions are read through `pirDecisions`. The fixture records a watch decision (`signWatchDecision`), and `pirDecisions()` returns the whole verified decision map. The tests compare that map before and after.
- The products mark key (`ledgerHeadKey`) and the Set Aside sentence are copied from `staffHost.ts`, where they are private. The tests pin both to today's behaviour: the mark is found and verified, and the refusal text equals the host's.

## Known Stubs

These are documented limits, not placeholders. None blocks the plan's goal.

- **Events:** `writeProjections` does not write `events.jsonl` (see key-decisions).
- **Products rebuilt as a live text only:** older versions, versions whose text the file no longer holds (a pending edit), versions pinned to a non-current version of another product, and versions over the 2 MiB state limit. All of them are still shown, with their full history, from the imported ledger.
- **Defaults:** `labelMapHash` defaults to the hash of an empty label map. 31-23's command should pass the project's real label map hash.

The broken-windows ledger (`gsd_run windows append`) was not run, because the brief keeps gsd-tools state commands with the orchestrator. The items above are the entries to record.

## Threat Flags

None beyond the plan's register.
- **T-31-62:** verify first, nothing written on refusal. Tested on files, store, secrets and pins.
- **T-31-63:** lookup before sealing. Tested with an interruption test per step, no proof, and one import per ledger.
- **T-31-64:** the whole file is re-verified with today's verifiers, and an untrusted key fails.
- **T-31-65:** rename only, guarded twice. The delete-call grep returns 0.
- **T-31-SC:** no package was installed.

## Next Phase Readiness

- **31-21:** use `projectionInputOf(project, deps)`, then `projectLedgerReplay` and `writeProjections(root, input, PASSTHROUGH_LEDGERS)`. `migrationComplete(root)` tells a finished conversion apart from one still in progress.
- **31-23:** the command calls `makeMultiUser(root, { ...replicaDeps, staffKeyStatus }, { name, labelMapHash })` and shows `result.notices`. A refusal's `message` is a plain sentence that is ready to show.
- **Phase 33:** once acts are written on top of an imported product, the fold-native projection applies. The legacy approvals stay readable through `projectImportedLedger`.

## Self-Check: PASSED

- FOUND: src/staff/replica/migrate.ts, src/staff/replica/projection.ts, src/test/staffReplicaMigration.test.ts
- FOUND commits: cd4cfd8c, bb1b52f8, 37678237 (ancestors of HEAD)

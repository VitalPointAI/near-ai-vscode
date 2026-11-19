---
phase: 30-replication-contract-and-co-editing-core
plan: 04
subsystem: replica-core
tags: [replication, entry-format-v2, schemas, hostile-input, project-reducer, kept-families]
status: complete

requires:
  - phase: 30-02
    provides: entry format v2, verifyEntry, kinds.ts dispatch, the stub schema files, replicaWorld test helper
provides:
  - closed schemas for 36 kinds (project 2, roster 17, registers 3, watches 5, runs 6, obs 3)
  - projectReducer with ProjectState, ProjectOutput, PROJECT_REFUSALS
  - a table-driven schema checker (validateShape and small Check helpers) in kindSchemas/project.ts
  - hostile-input tests for headers, bodies, AAD binding, blobs and a seeded never-throws fuzz
affects: [30-12 registers projectReducer in DEFAULT_REDUCERS, Phase 31 roster fold, Phase 33 registers, Phase 35 watches runs obs]

actuals:
  tokens: 40000
  tasks: 3
  commits: 3
plan_head_before: f2c4c62aab440dbb5734ae8b8b9f1bb83eadebd2
plan_head_after: d6fc5a902a7376fb9c0f5480145fbb372a01bb91

tech-stack:
  added: []
  patterns: [one shape table per family with first-wrong-field path in every refusal, own-property reads only, whole numbers only in signed bodies, per-stream reducer state with null outputs for untouched streams]

key-files:
  created:
    - src/domain/replica/projectFold.ts
    - src/test/replicaEntry.test.ts
    - src/test/replicaKinds.test.ts
  modified:
    - src/domain/replica/kindSchemas/project.ts
    - src/domain/replica/kindSchemas/roster.ts
    - src/domain/replica/kindSchemas/registers.ts
    - src/domain/replica/kindSchemas/watches.ts
    - src/domain/replica/kindSchemas/runs.ts
    - src/domain/replica/kindSchemas/obs.ts

key-decisions:
  - "Signed bodies carry whole numbers only (canonical JSON refuses fractions), so register fields are text, whole numbers or flags, observation areas are in microdegrees, and run spend is whole millionths of a dollar."
  - "project state is per stream: families.project is an array of per-stream records, and a stream with no genesis shows nulls, so a third stream never changes another stream's output."
  - "A repeat of the same genesis content is applied (idempotent); a different one is refused second-genesis; the first in fold order wins, which is the same everywhere."
  - "project.import is also staff-lead only and is listed once per (ledger, legacyHead, count)."
  - "A roster device descriptor must name writer = sha256 of its signing key."

requirements-completed: [MUS-01]

coverage:
  - id: D1
    description: "Every hostile header or body lands in one list with a named reason and never throws (unknown version, extra, missing and prototype keys, bad integers and ids, oversize, too many deps, data and blob, lamport 0, bad time, bad actors)"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaEntry.test.ts (13 tests including 500 seeded random inputs)"
        status: pass
  - id: D2
    description: "Deterministic signing, new body.hash on re-sealing, AAD binding of a copied ciphertext, header-only verification"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaEntry.test.ts#a ciphertext copied under another writer header cannot be opened"
        status: pass
  - id: D3
    description: "Blob offload, missing-blob holds, inline body over 16 KB rejected, unknown writer, corrupt body, missing key, missing roster, unauthorised keep"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaEntry.test.ts (blob, body-too-large, hold and keep tests)"
        status: pass
  - id: D4
    description: "Closed schemas for all 36 kinds: valid sample passes; missing field, extra field and __proto__ key fail with the path named"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaKinds.test.ts (project and roster 19 kinds, registers/watches/runs/obs 17 kinds)"
        status: pass
  - id: D5
    description: "Project reducer: genesis by staff lead only, second genesis refused in either delivery order, import listed once; roster, registers, watches, runs and obs entries kept folded-in-later-phase with no change to state or digest; unknown kind kept newer-version; hub actor kept hub-actor; the same writer's next entry still applies"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaKinds.test.ts (19 tests, 19 pass)"
        status: pass
---

# Phase 30 Plan 04: Hostile-input hardening, family schemas and the project reducer Summary

The entry format and verifier now have tests for every hostile shape the plan names, 36 kinds have closed schemas, and the project family folds through a real reducer; everything else Phase 30 does not fold is kept and relayed without touching state.

## Commits

| Commit | What |
|--------|------|
| `e59870f7` | Task 1 (tracer): `replicaEntry.test.ts`, 13 tests |
| `9d8403fa` | Task 2: project and roster schemas, `projectFold.ts`, first part of `replicaKinds.test.ts` |
| `d6fc5a90` | Task 3: registers, watches, runs, obs schemas; shared checker; kept-family tests |

## What was done

1. **Task 1.** The hardened `entry.ts` and `verify.ts` from 30-02 already refused every shape in the plan, so no change to either file was needed; the tests found no gap. 13 tests: unknown header version, extra, missing, prototype and constructor keys, bad integers and ids, oversized header, 17 deps, both or neither of data and blob, lamport 0 or past the cap, bad time, bad actors, `__proto__` in the body, deterministic signing, re-sealing gives a new `body.hash`, a ciphertext copied under another writer's header (and under another seq, prev or epoch) is `body-unreadable`, `headerAad` has no `sig` or `hash`, `verifyHeader` works with only the header and the device key, blob offload with missing and changed blobs, inline body over 16 KB, the four holds, `unauthorised` keep, and a 500-seed never-throws fuzz that also checks junk never changes the digest of the good entries.
2. **Task 2.** `project.genesis`, `project.import` and the 17 roster kinds (with `deputy.name`, `rosterPrev` on every roster kind, roles checked against `ROSTER_ROLE_PATTERNS`, device descriptors with the writer-equals-hash-of-key check, clearances as a closed-key label object). `projectReducer` accepts genesis only from `hasRole(member, 'staff_lead', body.roster)`.
3. **Task 3.** Schemas for registers (3), watches (5), runs (6) and obs (3). Tests that these families, an unknown kind and a hub actor are kept and change neither families output nor digest.

## Verification

Run under the cap (4 GB, no swap, 300 s) and the shared heavy lock; the full suite was not run.

- `tsc -p tsconfig.json`: clean.
- `replicaKinds` 19/19, `replicaEntry` 13/13, `replicaTracer` 10/10 pass.
- `replicaContracts`: 15 of 17 pass; 2 fail for a reason outside this plan (see deviations).
- Acceptance greps: no `SCHEMA_PENDING` in project, roster, registers, watches, runs, obs; `deputy.name` and `rosterPrev` in `roster.ts`; `newer-version` in `replicaKinds.test.ts`; `unknown-header-version` in `entry.ts`/`verify.ts`; `seed` in `replicaEntry.test.ts`. No em-dash in any file written.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in plan assumption] Floats cannot be signed**
- **Found during:** Task 3, first run of the kept-families test
- **Issue:** canonical JSON (`src/domain/team/canonical.ts`) refuses non-integer numbers, so a signed body with an area in degrees or a fractional register value cannot be built. The plan's wording did not say what number type the obs area and register fields use.
- **Fix:** whole numbers only. Obs areas are microdegrees, register field numbers are safe integers, run spend is `spendMicros` (whole millionths of a US dollar). A fractional number is refused at its path in every schema.
- **Files modified:** `kindSchemas/obs.ts`, `kindSchemas/registers.ts`, `kindSchemas/runs.ts`, tests
- **Commit:** `d6fc5a90`

**2. [Rule 3 - Blocking, reported not fixed] Two stale 30-02 tests now fail**
- **Issue:** `src/test/replicaContracts.test.ts` has two tests that assert the stub state: "every known kind except doc.client and doc.update fails closed with the schema-pending reason" and "validateData dispatches each family to its own file". With any family schema written they fail by design. That file is owned by 30-02 and the other wave-3 plans fill the remaining stubs (integrity, versions, doc.compact) at the same time, so editing it here would conflict at merge.
- **Action:** not edited, not skipped. Needs an update by the orchestrator or 30-12 once every wave-3 plan has landed: pending is expected only for kinds whose schema is still unwritten, and the dispatch test should use a valid sample per family instead of `{}`.

### Choices the plan left open (recorded, not deviations)

- Clearance object: required `scale`, `level`, `compartments`, `releasability`; optional `handling` and `expiresAt`. The plan named a label shape with `handling`; the Phase 70 clearance has no handling, so `handling` is optional here.
- Gate imports: label token pattern and handling flags are copied as plain values into `roster.ts` so the hub-side schema files import nothing from `src/domain/gate`.
- `header-too-large` is defence in depth: every header field has a fixed pattern, so a header over 4096 canonical bytes can only carry an extra key and is reported `malformed-header` first. The test accepts either reason, as the plan allows.
- `project.genesis` does not check that `lead.writer` equals the entry's writer (the plan does not ask for it); the lead may name a different device of theirs.
- Watch, register and run field values use the shapes in DESIGN 5.5, 10.6, 11, 12, 15.6 and 15.7; their owning phases may extend them before any store exists.

## Known Stubs

None in the files this plan owns. `integrity.ts`, `versions.ts` and `doc.compact` still return `SCHEMA_PENDING` until 30-05, 30-08 and 30-06. `projectReducer` is not in `DEFAULT_REDUCERS` until 30-12 (tests pass it explicitly).

## Threat Flags

None beyond the plan's register. T-30-13 to T-30-17 are each covered by a test: prototype keys (JSON.parse-built in every schema), size caps, AAD binding, later-phase kinds kept with unchanged digests, and forged genesis refused.

## Files touched outside files_modified

None.

## Notes for later plans

- `kindSchemas/project.ts` exports the shared checker (`validateShape`, `keyProblem`, `own`, `hasOwn`, `isLine`, and the `Check` helpers); 30-05 and 30-08 may use it.
- `families.project` is an array of per-stream records `{ stream, genesis, project, name, profile, labelMapHash, lead, hub, imports }` with nulls before a genesis; `canonical(output, stream)` returns `null` for a stream with no project state.

## Self-Check: PASSED

Files exist: `projectFold.ts`, `replicaEntry.test.ts`, `replicaKinds.test.ts` and the six schema files. Commits `e59870f7`, `9d8403fa`, `d6fc5a90` are ancestors of HEAD on `agent-30-04`.

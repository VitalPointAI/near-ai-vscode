---
phase: 30-replication-contract-and-co-editing-core
plan: 11
subsystem: replica-core
tags: [replication, canonical-vectors, import-boundary, hub-compile, fixtures]
status: complete

requires:
  - phase: 30-04
    provides: entry format v2 (header, AAD, sealed body, blob), verifyEntry
  - phase: 30-05
    provides: equivocation proofs and the hub-side modules
  - phase: 30-08
    provides: replicaVersionHash
  - phase: 30-09
    provides: checkpoints, orderTipOf, recomputeCheckpoint
provides:
  - test/fixtures/replica/vectors.json, the canonical bytes Phases 31 and 32 and the hub test against (D-28)
  - buildVectors, sealFixedIv, vectorDifferences in src/test/helpers/replicaVectors.ts
  - the replica import boundary test with HUB_SIDE, importsOf, replicaBoundaryViolations and hubSideClosure
affects: [30-12 adds the digest vector once all reducers are registered, Phase 31 store and roster, Phase 32 hub]

actuals:
  tokens: 25000
  tasks: 2
  commits: 2
plan_head_before: 41db67925cbe205cde47dfdbbdc7d377b8d559b6
plan_head_after: 8a68324aa824df8834a3a37206bdbc6437f2e2f8

tech-stack:
  added: []
  patterns: [fixture rebuilt and compared byte for byte, keys from public labels with no private bytes in the fixture, line-based import scan plus a transitive closure with planted violations]

key-files:
  created:
    - src/test/helpers/replicaVectors.ts
    - src/test/replicaVectors.test.ts
    - test/fixtures/replica/vectors.json
    - src/test/replicaBoundaries.test.ts
  modified: []

key-decisions:
  - "The vector checkpoint is signed by writer A, which the vector roster lists as the checkpoint signer, so a reader needs only the fixture to verify it."
  - "The equivocation proof is the recorded A seq 1 plus the same body sealed under a second fixed IV (a fork per D-32); the second header is kept only in the proof, not in the entries list."
  - "The fixture records the ivLabel of every sealed body and blob so another implementation can reproduce the sealing, not only read it."
  - "The boundary test lists the hub-side set as module paths with a folder entry for kindSchemas/, and checks both each hub-side file and the transitive closure."

patterns-established:
  - "vectorDifferences names the dotted path of every changed field, so a format drift reports which detail moved."
  - "The secret check searches the fixture text for the hex, base64url and base64 forms of each key seed."

requirements-completed: [MUS-01, MUS-02]

coverage:
  - id: D1
    description: "Canonical vectors (entries, AAD, signatures, hashes, sealed bodies, a blob, a checkpoint with order tip, a proof, version hashes) are committed and rebuilt byte for byte"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaVectors.test.ts#the committed vectors equal what the builder makes, and the builder is deterministic"
        status: pass
  - id: D2
    description: "Every vector entry passes the production reader and opens with the production openRaw"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaVectors.test.ts#every vector entry passes the production reader, and its body opens with the recorded associated data to the recorded plaintext"
        status: pass
  - id: D3
    description: "The replica core is pure, only doc.ts touches Yjs, and the hub-side closure reaches no other replica file"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaBoundaries.test.ts#the hub-side closure, following type-only imports too, contains no replica file that is not hub-side"
        status: pass
---

# Phase 30 Plan 11: Canonical vectors and replica import boundary Summary

The replica contract is now frozen as committed bytes and as an import boundary: `test/fixtures/replica/vectors.json` holds 5 chained entries (one routed to a blob), an equivocation proof, a signed checkpoint and 3 version hashes, all built from public labels, and `replicaBoundaries.test.ts` proves the core is pure, that only `doc.ts` touches Yjs, and that the hub-side modules compile without it.

## Accomplishments

- **Vectors (Task 1, tracer).** `buildVectors()` makes two writers (A client 101, B client 202), the epoch key and stream from labels, and five entries: A doc.client, A doc.update "Hello ", A doc.update of 13000 characters (over 16 KB, so the data moves into a sealed blob), B doc.client, B doc.update "world". Bodies are sealed with a test-only fixed IV (`sealFixedIv`, first 12 bytes of sha256 of a label). Each entry records the unsigned header canonical bytes, AAD, signed header, entry hash, body plaintext and wire. Also recorded: the blob (hash, AAD, plaintext, wire), a checkpoint signed by A with its order and order tip, a proof (A seq 1 sealed twice) with its hash, and three `replicaVersionHash` rows (no pins, one pin, CRLF text with two pins).
- **Reader checks.** The test rebuilds the vectors and requires equality with the file, runs every entry through `verifyEntry` with a context made from the labels and the fixture only, opens each body with production `openRaw` and the recorded AAD, checks the proof with `verifyProof`, `acceptableProof` and `proofHash`, the checkpoint with `verifyCheckpoint`, `orderTipOf` and `recomputeCheckpoint`, and the version hashes. Changing one byte of an AAD, signature, entry hash, checkpoint field or version hash is reported by dotted path.
- **Boundary (Task 2).** `replicaBoundaries.test.ts` scans every file under `src/domain/replica` (30 at this point): no editor import, no package, nothing outside `src/domain`; one type-only `yjs` import and the vendor path only in `doc.ts`; and the hub-side modules (entry, rosterView, kinds, kindSchemas/*, verify, causal, chain, equivocation, order, checkpoint, transport, digest) reach no replica file outside that set, by value or by type. Planted violations show each rule has teeth.

## Verification

All runs under the capped wrapper (4G, 300 s), after `node scripts/vendor-libs.mjs` and a full `tsc -p tsconfig.json` (no errors).

| Check | Result |
| --- | --- |
| `dist/test/replicaVectors.test.js` | 8 tests, 8 pass, 0 fail |
| `dist/test/replicaBoundaries.test.js` with `dist/test/teamBoundaries.test.js` | 15 tests, 15 pass, 0 fail (6 new, 9 existing) |
| `git diff --stat src/test/teamBoundaries.test.ts` | empty |
| `node scripts/secret-scan.mjs` | clean (1666 tracked files after the fixture was committed) |
| fixture acceptance (`entries >= 5`, checkpoint, proof, 3 version hashes) | exit 0 |
| `grep -ciE "privateKey\|BEGIN PRIVATE"` on the fixture | 0 |
| standalone hub compile: `tsc --noEmit` on the 11 hub-side files plus `kindSchemas/*` with `types: [node]` only | exit 0, program holds no `doc.ts` and no `yjs` |

The standalone compile pulls in these files outside the replica folder, which a hub must therefore carry: `domain/team/{types,canonical,keyStatus,secrets,signedPayload,policy,validate}`, `domain/redaction`, `domain/state/keys`, `domain/staff/doctrine`.

## Deviations from Plan

None - plan executed as written. Small additions inside the plan's files: `vectorDifferences` (field-naming comparison the behavior list asks for), a fixture check that the key seeds and the epoch key do not appear in the fixture, and `hubSideClosure()` also verifying that every closure file lies under `src/domain`.

## Known Stubs

None. The digest vector is intentionally not here; 30-12 adds it once every reducer is registered (named in the plan).

## Threat Flags

None. No new network, auth or file surface; the fixture holds test keys derived from public labels only.

## Notes for later phases

- The fixture is a reviewed format change: regenerate with `node -e "process.stdout.write(JSON.stringify(require('./dist/test/helpers/replicaVectors.js').buildVectors(), null, 2) + '\n')" > test/fixtures/replica/vectors.json` after compiling.
- Plan 30-10 owns `versions.ts`; this plan reads `replicaVersionHash` from it. If 30-10 changes that construction, the third `versionHashes` row and the fixture change with it, and the vectors test will say which field.

## Self-Check: PASSED

- FOUND: src/test/helpers/replicaVectors.ts, src/test/replicaVectors.test.ts, test/fixtures/replica/vectors.json, src/test/replicaBoundaries.test.ts
- FOUND commits: 82fa54a2 (Task 1), 8a68324a (Task 2)

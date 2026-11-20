# Phase 30: Replication contract and co-editing core - Research

**Researched:** 2026-11-19
**Domain:** Pure TypeScript replication core (signed per-writer hash chains, deterministic fold, CRDT text with attribution, version and decision algebra) in the extension's `src/domain/` tier, plus build-time vendoring of Yjs and lib0
**Confidence:** HIGH for the signer fit, vendoring, Yjs behaviour (read in source and run in a scratch folder this session); MEDIUM for the decision algebra (derived from DESIGN 6.4, 15.4, 15.5 with a few gaps flagged as open questions)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Where the code lives
- **D-01:** All Phase 30 code is pure and lives in a new folder `src/domain/replica/` with no `vscode` import and no I/O beyond `node:crypto` (as `src/domain/team/` does). Suggested modules (the planner may split or merge): `entry.ts` (format, codec, hash, sealing), `kinds.ts` (closed kind list and schemas), `verify.ts`, `order.ts` (causal graph and total order), `fold.ts` (fold engine, refold, digest), `equivocation.ts`, `checkpoint.ts`, `transport.ts` (the `ReplicaTransport` type only), `doc.ts` (the CRDT interface and Yjs adapter), `attribution.ts`, `versions.ts` (versions and decisions). An import boundary test in the Phase 69 pattern (`src/test/teamBoundaries.test.ts`) proves `src/domain/replica/*` imports neither `vscode` nor anything outside `src/domain` except the vendored CRDT entry point. *(DESIGN 4, G10.)*
- **D-02:** Nothing outside `src/domain/replica/`, the vendored CRDT, its manifest and tests, SECURITY.md and the build script that vendors changes in this phase. Existing ledgers, `release.ts`, `ownership.ts`, `signedPayload.ts` and all staff behaviour stay as they are, except adding `staff-replica` to `PAYLOAD_PURPOSES` (D-05). Single-machine projects behave exactly as before (G9).

### Entry format (MUS-01)
- **D-03:** Entry format version 2 exactly as DESIGN 4.2: header `{v: 2, stream, writer, seq, prev, epoch, body: {hash, size}, sig}`; body `{deps (at most 16), roster, lamport, at, actor, kind, data | {blob}}`. Stream ids are opaque random 128-bit values; writer is sha256 of the device Ed25519 public key; `prev` of seq 0 is a fixed genesis marker. The entry hash is sha256 of the canonical header including `sig`.
- **D-04:** Bodies are sealed with AES-256-GCM (`node:crypto`) under a 32-byte epoch key the caller passes in, with the canonical header without `sig` as associated data and a fresh 96-bit nonce per body. Phase 30 does not create, store, wrap or rotate keys (Phase 31); tests use fixed keys. Bodies over 16 KB serialised go to a content-addressed sealed blob (sha256 of the ciphertext) referenced as `{blob: hash}`; Phase 30 defines the blob codec and an in-memory blob lookup for the fold.
- **D-05:** Signing uses the existing `signPayload` / `verifyPayload` (`src/domain/team/signedPayload.ts`) with a new purpose `staff-replica` appended to `PAYLOAD_PURPOSES`; no second signer. Canonical JSON from `src/domain/team/canonical.ts`. If the envelope shape of `signPayload` does not fit a header signature without changing the log format, research picks the smallest adapter that keeps the Phase 71 `eddsa-jcs-2022` move an envelope change only (DESIGN 4.2), and says so.
- **D-06:** Agents never hold a key: an agent's write is signed by the device that ran it with `actor: {kind: agent, member, run}`. `actor: {kind: hub, watch}` is defined in the format but no reducer accepts a hub actor in Phase 30 except where a later phase adds it.
- **D-07:** Validation follows `src/domain/team/validate.ts`: own-property checks, closed field lists, no spread of parsed input, size limits. Unknown kinds from a newer client are kept and relayed, marked "made by a newer version", and never change state. An unknown header version is refused.

### Order, fold, digest (MUS-01)
- **D-08:** Order is topological over `prev` and `deps`, ties broken by `(lamport, writer, seq)`. Wall time (`at`) never orders. Entries more than 10 minutes ahead of a caller-supplied clock are held (the fold takes `now` as input; it never reads a clock).
- **D-09:** The fold is a pure function of the set of verified entries plus an injected authority view (`RosterView`: is this writer admitted and not revoked at roster hash R, does member M hold role X at R). Phase 30 ships a simple test roster implementing the interface; Phase 31 replaces it with the real roster fold. An entry whose cited roster does not authorise it is kept and reported, and changes no state.
- **D-10:** Incremental application: an entry causally after everything folded is applied at the end; a late concurrent entry triggers a refold from the last checkpoint (or from the start if none). Tests prove incremental and from-scratch folds give the same state and digest.
- **D-11:** State digest per stream: sha256 of the canonical folded state, with texts represented by state vector and text hash. Same entries, same digest, on every machine, whatever the order, duplication or partition.

### Integrity (MUS-01)
- **D-12:** Equivocation (one writer, one stream, one seq, two different signed headers) produces a portable proof `{header A, header B}` that any machine can check alone; the fold folds nothing from that device after the fork point, marks it quarantined, and emits the `equivocation.proof` kind. The result is the same whatever the arrival order. `device.release` (choosing a branch) and `device.revoke` are roster kinds folded in Phase 31; Phase 30 defines their shape and how the fold would honour a chosen branch through the roster view.
- **D-13:** Tamper: a changed old entry breaks that writer's chain at that point; later entries from that writer are held; other writers are unaffected. Withholding detection (a cited dep or checkpoint head not delivered) is computed by a pure function returning "missing N entries from writer W since seq S"; showing it is Phase 33.
- **D-14:** Checkpoint format (DESIGN 4.6): signer, project, roster head, per stream heads per writer, digests for held cells, signed; the fold treats order covered by a checkpoint as final and folds later-arriving entries after its prefix. Two checkpoints from one signer that disagree about one prefix are a hub equivocation proof. Signing checkpoints and serving them are Phase 32; Phase 30 defines the format, verification and the fold rule.
- **D-15:** `ReplicaTransport` is defined as a TypeScript interface (DESIGN 9) with `HeadSet`, `PushResult` and sealed entry and blob types, and a fake in-memory transport used only by tests. No real transport.

### Co-editing (MUS-02)
- **D-16:** Yjs is the CRDT (owner decision 1). Yjs 13.6.33 and `lib0` (the version Yjs 13.6.33 requires, at a release at least two weeks old when vendored, as the repo's vendoring rule for MapLibre required) are vendored, pinned, licence files kept, hash-checked like MapLibre and milsymbol, and recorded in SECURITY.md. They are not a `package.json` runtime dependency. Because the extension host is compiled with `tsc` and packaged without `node_modules`, research picks the mechanism that keeps both properties: either committed files with a manifest of hashes checked by a test and `verify:release` (the `media/vendor/VENDORED.json` pattern), or a pinned devDependency bundled by `scripts/vendor-libs.mjs` into `vendor/` with the bundled bytes hash-checked. Either way a changed or substituted copy fails CI and the release, and the SBOM includes both packages. SECURITY.md says honestly that this is the first third-party code inside the signed replica core (other vendored libraries already run in the host for PDFs, SVG and decks).
- **D-17:** The CRDT sits behind one interface (`applyUpdate`, `encodeDiff`, `text`, `snapshot`, `stateVector`, `attribution`) so Loro stays a local swap; nothing outside `doc.ts` imports Yjs.
- **D-18:** Each product body is one `Y.Doc` with a `Y.Text` named `body`. Each Yjs client id is registered by `doc.client {product, clientId, actor}`: one per device per product for the person's editor, one per agent run. A registration colliding with another writer's id is refused by the fold and the device picks again (the picking is Phase 33; the refusal and its test are Phase 30).
- **D-19:** `doc.update` carries a Yjs update (or a blob reference over 16 KB). Ownership check: every inserted struct in the update must carry a client id registered to the entry's writer at that point in fold order, otherwise the whole update is rejected as forged attribution and recorded. Deletions may touch anyone's text; the fold records which entry deleted which range. Text needs no refold since Yjs merges any order, but the ownership check result must be order independent (an update arriving before its `doc.client` registration is held, not rejected).
- **D-20:** Attribution: the fold maps each character's client id to its `doc.client` entry, giving writer, person or agent member and run. An attribution summary per version (who shaped what) is computed here; showing it in the gutter is Phase 33.
- **D-21:** `doc.compact` carries a full state as a blob after a checkpoint; loading the newest compaction plus later updates gives the same text, state vector and attribution as the full log. Updates are never removed.
- **D-22:** The CRDT spike from WP-R0 runs in this phase: update sizes for typing batches, full-state size and garbage collection over a simulated 30-page product with many authors, numbers written to the phase folder. If the spike shows a size or GC problem the result is recorded and the Loro fallback named; it does not block the phase unless convergence or attribution fails.

### Versions and decisions (MUS-03)
- **D-23:** A product has a working text (`open` or `withdrawn`) and versions. `version.propose` carries content hash, the exact text and header as a blob, and the Yjs state vector; the fold accepts it only if the blob hashes correctly and equals the text at that state vector. Numbers follow fold order; concurrent proposals are both kept, numbered consecutively and marked "proposed at the same time as vN". Edits never touch a proposed version; "N changes since vN" is a fold output, and after about 20 changes the fold flags "owner prompt due" (owner decision 4); never auto-withdraw.
- **D-24:** Per version state follows DESIGN 15.4 using `src/domain/staff/release.ts`'s states and its refusal of agent decisions (`HUMAN_ONLY_EVENTS`), adapted per version; `release.ts` is reused, not copied, and its existing tests stay unchanged. Who may do what follows 6.3 through the roster view; approve, reject, release and supersede need `actor.kind === 'person'` with the `decision_for` role.
- **D-25:** Decisions per version (DESIGN 6.4 and 15.5): causal order, latest effective; concurrent same outcome effective with all names; concurrent different outcomes `contested`, neither applies, nothing picks by fold order, rank or time (owner decision, contested); settled only by a fresh `version.decide` whose `decisionsSeen` includes every contested decision; withdraw concurrent with a decision and release concurrent with a reject are also contested; release needs an effective approval of the same hash causally before; a decision made while the role was being withdrawn is `pending-confirmation`. A late decision conflicting with a checkpoint-final one still contests; finality changes only wording (a flag in fold output).
- **D-26:** Dependants pin a version hash and get "source changed" when a newer version is released (design 10's rule carried over); Phase 30 computes it in the fold.

### Ownership and leads
- **D-27:** `product.owner` and the owner's right to propose come from the roster view; the deputy lead role (owner decision 5) is part of the roster view interface so Phase 31 can honour it without a format change. Ownership is accountability, not a write lock (6.1).

### Tests and process
- **D-28:** Tests are `node:test` files under `src/test/` named `replica*.test.ts`. Property tests use a seeded pseudo-random generator written in the test (no new devDependency), print the seed on failure, and run a bounded number of cases so the suite stays within the memory cap. Every row of 15.4 and 15.5 and every forbidden act listed under 15.4 has a named test. Canonical vectors (fixed keys, fixed entries, expected hashes and digests) are committed as fixtures so Phases 31 and 32 and the hub test against the same bytes.
- **D-29:** Verification cadence: run the touched test files per task; the full suite once at the end of the phase. Every heavy run uses the memory cap `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 <cmd>` inside `flock` on the session's `heavy.lock`, one heavy run at a time. Never delete, skip or weaken a test.
- **D-30:** Docs follow the repo style: no em-dashes, "your organization", plain words. Phase 30 adds no README text (nothing user-visible); SECURITY.md gets the vendored code section (D-16) and a short note that the replica core exists but is not yet used by the extension.

### Claude's Discretion

- Exact module split inside `src/domain/replica/`, type names, and how the fold engine registers reducers per kind family.
- The test roster's shape, as long as it implements the `RosterView` interface Phase 31 will implement.
- The vendoring mechanism between the two options in D-16, after research.
- Whether the CRDT spike is its own plan or a task inside the vendoring plan.

### Deferred Ideas (OUT OF SCOPE)

- Roster reducers, genesis, invites, keys and migration: Phase 31. Hub: Phase 32. Live layer and UI: Phase 33. Offline transports: Phase 34. Shared runs, observations, hub watches: Phase 35.
- Registers' field-level merge (DESIGN 5.5) is folded when registers move onto the layer (Phase 31 migration and Phase 33); Phase 30 only defines `register.row`'s shape.
- Team Mode (L2) onto this layer; credentials in the roster (Phase 71); hub federation (L5).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MUS-01 | Per-writer signed hash-chained logs, deterministic fold and state digest; equivocation proven and quarantined. | Signer adapter (section "Signer fit"), ordering as a sort by (lamport, writer, seq) once the lamport rule is enforced, per-writer chain verification, equivocation and tamper classification, checkpoint order tip, property-test plan with memory budget |
| MUS-02 | Product text co-edited through Yjs inside signed entries, with unforgeable attribution. | Yjs update decoding without applying (`Y.decodeUpdate`), ownership check algorithm, clock-overlap rule, content-kind allow list, attribution by walking `Y.Text._start`, `gc:false` fold doc, snapshot reconstruction, vendoring mechanism (bundled devDependencies with a hash manifest) |
| MUS-03 | Versions pin a content hash; contested decisions need a fresh decision; agents never decide. | `release.ts` reuse adapter, maximal-element decision algebra, decision table for every row of 15.4 and 15.5, forbidden-act tests |
</phase_requirements>

## Summary

Phase 30 is a pure-code phase with one build-time dependency step. Three findings shape the plan. First, the existing signer fits with no change to the v2 log format: `signPayload` can sign the header (minus `sig`) under a new purpose `staff-replica` if the adapter fixes `signedAt` to a constant epoch string, which also makes signatures deterministic so a retried write can never look like equivocation. The public key is not in the header, so the verifier rebuilds the envelope with the key the roster view returns for the writer. Second, the design as written has a circularity: the AES-GCM associated data is "the header without `sig`", but the header contains `body.hash = sha256(ciphertext)`, so the associated data cannot contain `body.hash`. The associated data must be the header minus `sig` and minus `body.hash` (keeping `body.size`). Third, Yjs can be vendored the way pptxgenjs and the MCP client already are: pinned devDependencies bundled by `scripts/vendor-libs.mjs` into `vendor/yjs/yjs.cjs`, with a committed hash manifest checked by a test and by `verify:release`. The lib0 version must be 0.2.119, not the 0.2.120 the design names, because 0.2.120 was published 10 days before today and fails the two-week rule (the legitimacy seam flags it `SUS` / `too-new`).

Ordering is simpler than the design suggests. If verification enforces `lamport == 1 + max(lamport of prev and deps)`, every causal edge strictly increases lamport, so sorting the admitted set by `(lamport, writer, seq)` is already a valid topological order with the required tie-break. Keep a Kahn's-algorithm reference implementation in tests to prove that equivalence. Checkpoint-final order is `canonical(prefix) ++ canonical(rest)`.

For text, Yjs updates are commutative, associative and idempotent [CITED: docs.yjs.dev/api/document-updates], and 40 random 5-writer histories replayed in shuffled, duplicated and batch-merged orders gave byte-identical `encodeStateAsUpdate`, text and state vector [VERIFIED: scratch run, section "Yjs facts"]. Byte identity is still not a Yjs promise, so the digest uses state vector plus text hash as D-11 says. The ownership check (D-19) can be done without applying the update, by `Y.decodeUpdate`, but it needs four extra rules the design does not state: a content-kind allow list, a per-client clock rule (otherwise two different updates claiming the same client clock make the result depend on application order), size and struct-length caps, and a `try/catch` around decoding (a 40 KB update of nested arrays overflows the stack).

**Primary recommendation:** Build a tracer first (vendor Yjs, then two writers each sign and seal one `doc.update` and the fold gives the same text and digest in both orders), then widen in parallel by disjoint files (kinds and schemas, chain and equivocation, co-editing, versions and decisions, order/checkpoint/digest), then one integration plan that wires reducers and runs the convergence property tests. Use the decision algebra "maximal elements under causal-or-`decisionsSeen` precedence, grouped into outcome classes; more than one class means contested" for every row of 15.4 and 15.5.

## Architectural Responsibility Map

This phase has one tier: the pure domain core of the extension host. Later phases add the others.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Entry format, codec, signing, sealing | Pure domain core (`src/domain/replica/`) | Hub (Phase 32) imports the same pure files | D-01; the hub must verify headers without Yjs, so these files must not import `doc.ts` |
| Chain, tamper, equivocation, withholding classification | Pure domain core | Replica store (Phase 31) persists results | Pure function of the entry set, same result on every machine |
| Order, fold, digest, checkpoint rules | Pure domain core | Hub signs checkpoints (Phase 32) | Fold is the shared contract; hub only signs and serves |
| CRDT text, ownership check, attribution | Pure domain core, behind one interface in `doc.ts` | Editor binding (Phase 33) | D-17; only `doc.ts` may touch the vendored bundle |
| Versions and decisions | Pure domain core, reusing `src/domain/staff/release.ts` | Staff Room UI (Phase 33) | D-24 |
| Roster, keys, blobs, clock | Injected interfaces (`RosterView`, `KeyRing`, `BlobLookup`, `now`) | Real implementations in Phase 31 | D-04, D-09: Phase 30 never creates keys or roster entries |
| Vendored Yjs and lib0 | Build step (`scripts/vendor-libs.mjs`) producing `vendor/yjs/` | VSIX packaging, SBOM | Extension ships without `node_modules` |

## Project Constraints (from CLAUDE.md)

There is no project `CLAUDE.md` in this checkout. The binding directives come from the user's global instructions, the task brief and the repo's own docs:

- Tests live under `src/test/` with `node:test`, compiled by `tsc` to `dist/test/` and run with `node scripts/run-tests.mjs dist/test/<file>.test.js` (`package.json:1091`).
- No runtime dependencies in `package.json` (SECURITY.md "Dependencies": "`package.json` declares no runtime dependencies"). New third-party code is a pinned devDependency bundled into `vendor/` at compile time.
- No em-dashes in docs; say "your organization"; plain words.
- Never delete, skip or weaken a test; an existing test whose expectation list must grow because a closed list grew (the payload purposes) is extended, never loosened.
- Heavy runs use the memory cap wrapper inside `flock` on the session's `heavy.lock`, one at a time (D-29). Never touch `~/.near-credentials`.
- Run the touched test files per task and the full suite once at the end of the phase (user's verification cadence). Security, authorization and data-integrity checks block immediately.
- Parallel work in separate git worktrees for independent plans; one integration merge (user's "work in parallel by default").

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | Node built-in (host is Node 24.22.3 here; build target `node22`) | Ed25519 (via existing signer), SHA-256, AES-256-GCM | Already how `signedPayload.ts` and `domain/state/keys.ts` work; no dependency |
| `yjs` | 13.6.33 (published 2026-09-23, MIT, depends on `lib0 ^0.2.99`) | CRDT for product text | Owner decision 1 (DESIGN 21.1); legitimacy seam verdict `OK`, 17.1M downloads per week |
| `lib0` | **0.2.119** (published 2026-09-28, MIT, depends on `isomorphic.js ^0.2.4`) | Yjs's encoding/decoding and utility library | Satisfies `^0.2.99`; the latest 0.2.120 is only 10 days old, below the two-week vendoring rule in D-16 |
| `isomorphic.js` | 0.2.5 (2022-03-26, MIT) | Transitive dependency of lib0 | Installed as a devDependency's dependency but **not bundled**: esbuild on `platform: 'node'` did not include it (30 bundle inputs, none from `isomorphic.js`, run in scratch). The SBOM lists exactly what esbuild bundled, so it is not shipped and not listed |
| `node:test` + `node:assert/strict` | built-in | Test framework | Repo standard |
| `esbuild` | 0.28.2 (already an exact devDependency) | Bundles Yjs/lib0 into one CJS file | Same call `scripts/vendor-libs.mjs` already uses for pptxgenjs and the MCP SDK |

### Supporting (existing in-repo code reused, not copied)

| Module | Use |
|--------|-----|
| `src/domain/team/signedPayload.ts` | `signPayload`, `verifyPayload`, `PayloadSigner` for the header signature |
| `src/domain/team/canonical.ts` | `canonicalize`, `canonicalBytes`, `fingerprintOf`, `isStrictBase64url` for every hash and signature input |
| `src/domain/team/keyStatus.ts` | `KeyStatusLookup` type for the signer call (the adapter passes a fixed-active lookup, see below) |
| `src/domain/team/validate.ts` | Style source: `isRecord`, `checkKeys`, `matches`, `isSafeIntegerInRange`; reuse the exported helpers where they fit, same pattern otherwise (no spread of parsed input) |
| `src/domain/state/keys.ts` | `sealRaw`, `openRaw`, `IV_BYTES`, `TAG_BYTES`, `KEY_BYTES` for AES-256-GCM sealing (see "Sealing" below) |
| `src/domain/staff/release.ts` | `transition`, `HUMAN_ONLY_EVENTS`, `isNamedPerson`, `RELEASE_REFUSALS`, `PRODUCT_HASH_PATTERN`, `GUARD_VERDICTS`, `TRADECRAFT_VERDICTS` |
| `src/domain/staff/ledger.ts` | `LEDGER_GENESIS` precedent for the genesis `prev`; `productHash` construction as the model for the version hash |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Bundled devDependencies with a hash manifest | Committed copies under `media/vendor/` like MapLibre | Yjs's `yjs.cjs` requires 19 `lib0/*` subpaths by package name, so raw copies need a `node_modules`-shaped folder; the only committable form is a pre-bundled file, which is opaque in review and has no byte-for-byte provenance. Rejected |
| Loro (WASM) | Yjs | Owner decision 1 is Yjs; Loro stays a local swap behind `doc.ts` (D-17) |
| Y.Text formatting and embeds | Plain `ContentString` only | Products are plain text with a header projection; allowing formats widens the parser surface. Allow-list only string and deleted content for now |

**Installation (the plan runs this once; research did not modify `package.json`):**

```bash
npm install --save-dev --save-exact --ignore-scripts yjs@13.6.33 lib0@0.2.119
# isomorphic.js 0.2.5 arrives as lib0's dependency and is recorded in package-lock.json
```

Exact pins matter: without `lib0` as a direct exact devDependency npm would resolve `^0.2.99` to the newest 0.2.120. In this worktree `node_modules` is a symlink to the parent checkout's `node_modules` (`ls -la node_modules` shows `node_modules -> /home/aaron/projects/codequity/near-ai-vscode/node_modules`), so the install changes the shared folder; the plan's first task should say so.

**Version verification** [VERIFIED: npm registry, 2026-11-19]:

```
npm view yjs@13.6.33   -> version 13.6.33, dependencies { lib0: '^0.2.99' }, license MIT, time.modified 2026-09-23,
                          dist.integrity sha512-q/UYvr1gOk4XII+Cu1CW2dINjYqJJFifTzogEaIARznrvX7uOlHsdTEXcnOBMuIsrCGEEKdNxi74kyMLZlKVfw==
npm view lib0@0.2.119  -> dependencies { 'isomorphic.js': '^0.2.4' }, license MIT, type module,
                          dist.integrity sha512-vh+TiejVy8Xm+hCdnRfn9BthGNvNUZdEXltNjVZL3TzRIKP3s1lnQh8pWd/Q0wCgY0FPAGVVjFF4ZiHUV3LFgA==
npm view lib0 time     -> "0.2.119": 2026-09-28T15:32:09.955Z, "0.2.120": 2026-11-09T15:19:55.805Z, dist-tags latest 0.2.120
```

## Package Legitimacy Audit

Command run: `gsd-tools query package-legitimacy check --ecosystem npm yjs lib0 isomorphic.js`.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| yjs | npm | 13.6.33 published 2026-09-23 (package since 2019) | 17,122,838 per week | github.com/yjs/yjs | OK | Approved |
| lib0 | npm | latest 0.2.120 published 2026-11-09 | 18,572,363 per week | github.com/dmonad/lib0 | **SUS, reason `too-new`** (about the latest version, 10 days old) | Approved at **0.2.119** (2026-09-28, 52 days old). Planner must add a `checkpoint:human-verify` before the first install that confirms the pinned version is 0.2.119 and not 0.2.120 |
| isomorphic.js | npm | 0.2.5 published 2022-03-26 | 16,986,102 per week | github.com/dmonad/isomorphic.js | OK | Approved as a transitive devDependency; not bundled into the shipped file |

No postinstall scripts on yjs 13.6.33 or lib0 0.2.119 (`postinstall: null` in the seam output; `npm view yjs@13.6.33 scripts.postinstall` printed nothing). All three names come from DESIGN 5.1 and 21.1 (the owner's document) and from yjs's own `package.json` dependency lists, and were confirmed on the registry; none is a WebSearch-discovered name. **Packages removed due to SLOP:** none. **Packages flagged SUS:** lib0 (resolved by pinning 0.2.119; the checkpoint keeps the pin from drifting).

## Signer fit (research question 1)

**Answer: yes, an entry header can be signed through `signPayload` with the new purpose `staff-replica` and the v2 log format unchanged (D-05). The smallest adapter is about 30 lines and fixes one value.**

Facts, each read this session:

- The purposes list is closed: `signedPayload.ts:26` is `export const PAYLOAD_PURPOSES = ['policy-bundle', 'grant', 'approval-answer', 'key-record', 'label-map', 'label-declassify', 'staff-ledger', 'staff-ledger-head', 'staff-decision'] as const;`. Append `'staff-replica'`. **The existing test `src/test/teamSignedPayload.test.ts` must be extended in the same plan**: line 60 declares `const SAMPLES: Record<PayloadPurpose, unknown> = {` (a new purpose is a type error until a sample is added) and line 126 asserts the exact list `assert.deepEqual([...PAYLOAD_PURPOSES], ['policy-bundle', 'grant', ... 'staff-decision']);`. Add a `'staff-replica'` sample and append it to that list. This grows a closed list; it weakens nothing.
- The signing input is `PAYLOAD_DOMAIN\n` + purpose + `\n` + canonical JSON of the envelope without `sig` (`signedPayload.ts:76-79`); the envelope is `{v: 1, purpose, signer: {fingerprint, publicKey}, signedAt, payload, sig}` (`signedPayload.ts:35-43`). So the signed bytes cover the header fields, the signer's public key and `signedAt`.
- `signPayload` stamps `signedAt` from `options.now` (`signedPayload.ts:101,103`), and Ed25519 in Node is deterministic. [VERIFIED: scratch run] With a fixed `now`, two `signPayload` calls on the same header gave identical `sig`; with a different `now` the `sig` differed. If `signedAt` were the real wall time, a writer that re-signed the same header after a crash would produce a **different entry hash at the same seq**, which is by definition equivocation. **Fix `signedAt` to a constant.** Recommended constant: `REPLICA_SIGNED_AT = '1970-01-01T00:00:00.000Z'` (it passes the round-trip ISO check at `signedPayload.ts:178-179`).
- Consequence for key rotation: `verifyPayload` refuses a `rotated` key only when `signedAt >= since` (`signedPayload.ts:192-195`). With a constant epoch `signedAt`, a rotated key would always pass. [VERIFIED: scratch run, `rotated+epoch0 true`] So the adapter must **not** feed real key status to `verifyPayload`. It passes `status: () => ({ state: 'active' })` and the fold does the real check: is this writer admitted, and not revoked, at the roster hash the entry cites (D-09, `RosterView`). "Entries before the revocation point stand" is then a roster-position rule, not a clock rule, which is what DESIGN 4.5 and 16 want ("Clock manipulation: causal order").
- The public key is not in the header (D-03 lists `writer` as the sha256 of the key). The verifier asks `RosterView.writerKey(writer, rosterHash)` for the key, checks `sha256(rawKey).hex === header.writer`, and rebuilds the envelope. [VERIFIED: scratch run, `rebuilt verifies true`; changing `seq` after signing gave `tampered seq verifies false`; the wrong purpose gave `wrong-purpose`.]
- Size and numbers: `export const MAX_PAYLOAD_BYTES = 256 * 1024;` (`signedPayload.ts:28`); a header envelope canonicalises to about 553 bytes [VERIFIED: scratch run]; pass `maxBytes: 4096` to both calls so an oversized header fails early. Canonical JSON refuses `undefined` (`canonical.ts:61`), non-safe-integers and negative zero (`canonical.ts:30-31`), lone surrogates, sparse arrays, non-plain objects, and nesting deeper than `export const MAX_DEPTH = 16;` (`canonical.ts:6`). So: omit optional fields instead of setting them `undefined`; integers only for `seq`, `epoch`, `lamport`, `size`; carry wall time `at` as an ISO string; carry binary (Yjs updates, nonces) as strict base64url with a round-trip check, not as number arrays.
- `signPayload` runs `assertNoSecrets(payload)` (`signedPayload.ts:114`). 2000 random headers (32-hex stream ids, 64-hex writer and hashes) produced zero false positives [VERIFIED: scratch run]. Bodies are sealed and never pass through `signPayload`, so no secret scan applies to bodies in this phase (a Phase 33 write-path decision).
- The signer does not validate payload shape. `verifyPayload` accepts any payload object that matches its signature. The header's closed key list (`v, stream, writer, seq, prev, epoch, body, sig`; `body` keys `hash, size`) is the fold's job, in `kinds.ts`/`entry.ts` with the `validate.ts` style.
- `keyStatus.ts` / `KeyStatusLookup` (`keyStatus.ts:13`): only the constant-active lookup is used for headers. Phase 31's roster view is the real source of "admitted and not revoked at R".

Adapter sketch (entry.ts; names are suggestions):

```ts
export const REPLICA_SIGNED_AT = '1970-01-01T00:00:00.000Z';
export const GENESIS_PREV = '0'.repeat(64);      // same shape as a hash; precedent: LEDGER_GENESIS in ledger.ts:30
const HEADER_MAX_BYTES = 4096;
const ALWAYS_ACTIVE: KeyStatusLookup = () => ({ state: 'active' });   // authority is the roster view's job, not the clock's

export function signHeader(signer: PayloadSigner, unsigned: UnsignedHeader): EntryHeader {
  const env = signPayload(signer, 'staff-replica', unsigned, { now: () => new Date(REPLICA_SIGNED_AT), maxBytes: HEADER_MAX_BYTES });
  return { ...unsigned, sig: env.sig };
}

export function verifyHeader(header: EntryHeader, publicKey: string): boolean {
  const { sig, ...payload } = header;
  const raw = Buffer.from(publicKey, 'base64url');
  if (sha256Hex(raw) !== header.writer) return false;                 // writer id is bound to the key
  const envelope = { v: 1, purpose: 'staff-replica', signer: { fingerprint: fingerprintOf(raw), publicKey }, signedAt: REPLICA_SIGNED_AT, payload, sig };
  return verifyPayload(envelope, { purpose: 'staff-replica', status: ALWAYS_ACTIVE, maxBytes: HEADER_MAX_BYTES }).ok;
}
```

The Phase 71 move to `eddsa-jcs-2022` replaces `signHeader`/`verifyHeader`'s envelope only; `EntryHeader` and the entry hash (`sha256(canonical header including sig)`) stay the same. Checkpoints and equivocation proofs use the same purpose with a different closed key set and a `type` field (`'checkpoint'`, `'equivocation-proof'`), so one payload shape can never verify as another (each validator checks its exact key list). A second purpose is also acceptable; D-05 says one.

**The AES-GCM associated-data circularity (must be fixed in the plan).** DESIGN 4.2 and D-04 say the associated data is "the canonical header without `sig`". The header contains `body.hash = sha256(ciphertext)`, and the ciphertext cannot be produced before the associated data is fixed. The associated data must therefore exclude `body.hash`. Recommended: `aad = canonicalBytes({ v: 2, stream, writer, seq, prev, epoch, size })` where `size` is `body.size` (known before encryption: plaintext length plus 28). The header signature covers `body.hash`, so the ciphertext is bound by hash; the associated data binds the plaintext to its position so another signer cannot re-sign a copied ciphertext under their own seq and have readers accept it. Blobs use `aad = canonicalBytes({ v: 2, blob: true, stream, epoch })`. [ASSUMED: the exact AAD field set is a research recommendation; only "exclude `body.hash`" is forced.]

**Sealing.** `src/domain/state/keys.ts` already has the pure AES-256-GCM helpers: `export const KEY_BYTES = 32;`, `export const IV_BYTES = 12;`, `export const TAG_BYTES = 16;` (`keys.ts:37-39`), `sealRaw(key, plaintext, aad)` with a random IV (`keys.ts:98-105`) and `openRaw` that ends every failure in `StateRefusedError('tampered')` (`keys.ts:108-119`). The replica folder may import it (D-01: anything under `src/domain`). Wire form: `ciphertext = iv || tag || data`, `body.hash = sha256(ciphertext)`. Two cautions: (1) `sealRaw` takes no nonce, so canonical **vectors** (D-28: fixed keys, fixed entries, expected hashes) need a test-only generator that seals with a fixed IV through `createCipheriv` and stores the resulting ciphertext in the fixture, while verification and opening in the vectors test use `openRaw`; (2) a writer must persist the exact signed bytes before sending, because re-sealing the same plaintext gives a different ciphertext, a different `body.hash` and therefore a second signed header at the same seq. That would be self-equivocation. Phase 31's store must write-before-send; Phase 30's builder should return the finished entry and tests should show a re-seal is detected as equivocation.

## Yjs facts (research question 2)

All of the following were run against the bundled `yjs@13.6.33` + `lib0@0.2.119` built by esbuild in a scratch folder (`bundle.mjs`, `y1.cjs` to `y5.cjs` in the session scratchpad), and the source files were read in the extracted tarballs. Tags: [VERIFIED: scratch run] unless a source line is cited.

1. **Decode without applying.** `Y.decodeUpdate(update)` returns `{ structs, ds }` (`src/utils/updates.js:139-157`): `structs` are `Item`, `GC` or `Skip` objects with `id.client`, `id.clock`, `length`; `ds` is a `DeleteSet` (`ds.clients: Map<client, [{clock, len}...]>`). For an `Item`: `content.getRef()` is a stable numeric kind, `parent` is a string (root type name), an `ID`, or `null` (derived from origins), `origin` and `rightOrigin` are `ID | null`. **Never use `constructor.name` or `instanceof` by name: the minified bundle renames classes** (the `Item` constructor printed as `e`). Use `'content' in struct` for Item vs GC/Skip and `getRef()` for the content kind.
2. **Content ref numbers observed.** `4` ContentString (typed text), `1` ContentDeleted, `5` ContentEmbed, `6` ContentFormat, `8` ContentAny (a Y.Map value), `7` ContentType. Allow-list for products: **4 and 1 only**, plus `GC` structs (a local transaction with `gc` on can emit them). Reject `Skip`, embeds, formats, types, any other ref.
3. **Parent check.** A first insert has `parent: 'body'`; a map set has `parent: 'other'`; later inserts have `parent: null` and `origin`/`rightOrigin` ids. Rule: if `parent` is a string it must equal `'body'`; if it is an `ID` reject; `null` is fine because content kinds are restricted and the only root type that can then exist is `body`.
4. **`Y.parseUpdateMeta(update)` gives `{from: Map, to: Map}`** per client (clock ranges). Enough to list the client ids and clock ranges; `decodeUpdate` is needed for content kinds, origins and parents. `Y.encodeStateVectorFromUpdate` and `Y.snapshotContainsUpdate(snapshot, update)` also exist.
5. **Malformed input.** `decodeUpdate` throws on garbage (`Unexpected end of array`), but **accepts trailing junk bytes** (an update with `1,2,3` appended decoded as before), and a 40,014-byte update with 20,000 nested arrays in a `ContentAny` throws `RangeError: Maximum call stack size exceeded` (1,000 nested decoded fine). A `GC` struct with length 4,294,967,295 decodes and moves that client's clock to 4,294,967,295. Rules: wrap every decode in `try/catch` and treat any throw as "malformed, rejected, recorded"; cap the update's byte size before decoding; cap per-struct length and total struct length; the trailing-junk malleability is harmless because the entry is signed (all machines see the same bytes), but cap size to bound it.
6. **Missing structs (pending).** Applying an update whose origins are unknown leaves `doc.store.pendingStructs` non-null (`{missing: Map(client -> clock), update}`) and the text unchanged; after the missing update arrives it integrates by itself and `pendingStructs` becomes `null`. A delete-only update on an empty doc left `doc.store.pendingDs` non-null (21 bytes). Both properties are in the d.ts (`StructStore.d.ts:9,16`). **Detection for "hold, not reject":** after applying to the fold's doc, report the product as `incomplete` while either is non-null; the entry itself is admitted (its structs are owned and well formed), so the fold is still a pure function of the set. You can also pre-check with decoded `origin`/`rightOrigin` ids against the doc's state vector plus the update's own clock ranges.
7. **Deletions do not advance the state vector.** A delete-only update left `Y.encodeStateVector(doc)` byte-identical while the text changed. So **a state vector alone does not determine a text.** `version.propose` must carry the Yjs snapshot, that is state vector and delete set (`Y.snapshot(doc)` has `{sv, ds}`; `Y.encodeSnapshot`), not the state vector alone. This corrects DESIGN 6.2's "state vector".
8. **Text at a given point.** `Y.createDocFromSnapshot(originDoc, snapshot)` throws `Garbage-collection must be disabled in `originDoc`!` when `originDoc.gc` is true (`src/utils/Snapshot.js:171-175`), and it **mutates `originDoc`** (it splits structs with `getItemCleanStart` inside a transaction, `Snapshot.js:177-209`). Restored text from a snapshot taken after `u2` gave "Hello brave world" while the full document read "brave world" [VERIFIED: scratch run]. Plan: the fold's per-product doc is `new Y.Doc({ gc: false })`; the version check builds a **scratch** `gc:false` doc from the product's accepted updates, calls `createDocFromSnapshot` on it, and compares the text hash. Never run it on the canonical fold doc.
9. **gc and size.** Preliminary numbers (synthetic, own measure, not the D-22 spike): 20 authors, 8,000 typing/deleting batches, final text 78,608 characters: median update 35 bytes, p99 58, max 72, sum of updates 281,999 bytes, full state `gc:false` 287,027 bytes vs `gc:true` 250,937 bytes, applying all 8,000 updates took 73 ms, walking the item list for attribution 2 ms. In a 2,000-op random run `gc:false` was 4.6% larger. Roughly 3.6 bytes per character of final text. So `gc:false` is affordable for a 30-page product, and the spike should confirm with realistic paste-and-rewrite patterns. Recommendation: fold doc `gc:false` (needed for versions and for "which entry deleted which range"); compaction blobs are produced from the `gc:false` doc so a late joiner sees identical text, state vector and attribution (D-21); the spike also measures a `gc:true` compaction as the possible size optimisation.
10. **Determinism.** Over 40 seeds, 5 writers, 60 steps each, partial random syncs: four random delivery orders with 5 duplicates each gave one distinct `encodeStateAsUpdate` hash, one text hash and one state-vector hash per seed, for both `gc:false` and `gc:true`, and for merged-batch delivery (`Y.mergeUpdates` of random chunks). Yjs documents only that updates are "commutative, associative, and idempotent" [CITED: docs.yjs.dev/api/document-updates]. Treat byte identity as a bonus assertion in tests, not a contract; the digest uses state vector (sorted `[client, clock]` pairs) plus text hash (D-11). `Y.encodeStateVector` writes clients in a sorted order, but build the digest representation yourself from `Y.decodeStateVector` sorted by client so a Yjs change cannot alter the digest.
11. **Attribution.** Walk `doc.getText('body')._start` following `item.right`, reading `item.id.client`, `item.id.clock`, `item.length`, `item.deleted`, `item.content.str` for `getRef() === 4`. `_start` is public in the d.ts (`AbstractType.d.ts:32`) and type-checks under the repo's tsconfig [VERIFIED: scratch `tsc` run with the repo's tsconfig, `TSC OK`]. Output on the test doc: `[[22,1,5,"brave"],[11,5,6," world"]]` (client, clock, length, text). `PermanentUserData` stores a user-to-client map **inside the document**, which any writer could forge, so it must not be used; the authority is our signed `doc.client` entries.
12. **Client id behaviour.** `generateNewClientId` is `random.uint32`; when a non-local transaction advances the clock of the doc's *own* `clientID`, Yjs silently replaces `doc.clientID` and prints `[yjs] Changed the client-id because another client seems to be using it.` (`src/utils/Transaction.js:360-362`). The fold doc never edits, so assign it `clientID = 0` and refuse `doc.client` registrations of id 0; the Phase 33 editor must re-register after a Yjs-initiated change.
13. **Hostile-update order dependence (not in the design).** If two different updates both contain `(client c, clock k)`, Yjs keeps whichever it integrates first, so convergence would depend on application order. The ownership check must also enforce a **per-client clock rule** in the writer's own chain order (see "Ownership check algorithm").

## Vendoring mechanism (research question 3)

**Recommendation: option (b), pinned devDependencies bundled by `scripts/vendor-libs.mjs` into `vendor/yjs/yjs.cjs`, with a committed hash manifest checked by a test and by `verify:release`.**

What exists [VERIFIED: files read]:
- `package.json:1088` is `"compile": "node scripts/vendor-libs.mjs && tsc -p tsconfig.json"`; `tsconfig.json` has `"module": "commonjs"`, `"rootDir": "src"`, `"outDir": "dist"`, `"skipLibCheck": true`, no `moduleResolution` key (Node classic CommonJS resolution).
- `scripts/vendor-libs.mjs:36` defines `bundle(entry, target, file, main)`: esbuild `bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true, legalComments: 'none', metafile: true`, then writes `LICENSES.txt` and manifest rows for exactly the `node_modules` packages esbuild included (`bundledIn` marks transitive ones). It is called at lines 50-51 for pptxgenjs and the MCP SDK, whose entry is `scripts/entries/mcp-client.mjs`.
- `vendor/` is gitignored (`.gitignore:11`: `vendor/`) and **is** in the VSIX (`.vscodeignore` excludes `src/**`, `scripts/**`, `node_modules/**` but not `vendor/`). `scripts/extension-sbom.mjs` builds the SBOM from `vendor/manifest.json`, so bundled Yjs and lib0 enter the SBOM with **no change** to that script. `scripts/verify-release-content.mjs:93` lists required entries such as `'extension/vendor/mcp/mcp-client.cjs'`; add `extension/vendor/yjs/yjs.cjs` and `extension/vendor/yjs/LICENSES.txt`.
- How runtime code loads a bundle: `src/mcp/client.ts:80` does `sdk = require(path.join(__dirname, '..', '..', 'vendor', 'mcp', 'mcp-client.cjs')) as Sdk;`. From `dist/domain/replica/doc.js` the path is three levels up.

Steps for the plan:
1. Add `scripts/entries/yjs.mjs` containing `export * from 'yjs';` and in `vendor-libs.mjs` `await bundle(path.join(root, 'scripts', 'entries', 'yjs.mjs'), 'yjs', 'yjs.cjs', 'yjs');`. In scratch, esbuild produced one minified file of 86,947 bytes from 30 inputs (yjs plus 28 lib0 files), and **two builds gave the same SHA-256** (`89e1f88a...d476`) [VERIFIED: scratch run, entry was `module.exports = require('yjs')`; the plan must rebuild with `export * from 'yjs'`, record that hash in the manifest, and confirm `isomorphic.js` is still not among the inputs]. The manifest rows come out as `yjs 13.6.33 MIT` and `lib0 0.2.119 MIT bundledIn yjs`.
2. Type safety without `node_modules` at runtime: in `doc.ts` write `import type * as YTypes from 'yjs';` (erased at compile, resolved from the devDependency's `types: ./dist/src/index.d.ts`) and load the code with `require(path.join(__dirname, '..', '..', '..', 'vendor', 'yjs', 'yjs.cjs')) as typeof YTypes`. [VERIFIED: scratch `tsc -p` with the repo's tsconfig over a file doing exactly this plus `Y.decodeUpdate(...).structs[i].id.client` and `doc.getText('body')._start`: `TSC OK`.] This is the same pattern as `loadSdk()` and means `tsc` never needs `yjs` at runtime. `import type` of a package is also the one thing the existing boundary rule would flag ("may import only Node modules, no package", `teamBoundaries.test.ts` `boundaryViolations`), so the replica boundary test (below) gets its own rule allowing exactly `import type ... from 'yjs'` in `doc.ts`.
3. **Hash manifest** (committed; recommended path `scripts/crdt-vendor.json`; do not add rows to `media/vendor/VENDORED.json` because `src/test/staffCopSymbols.test.ts:81` asserts that file's exact package list `['maplibre-gl@6.16.0 BSD-3-Clause', 'milsymbol@3.0.5 MIT']`). Contents: for `yjs`, `lib0`, `isomorphic.js`: name, version, license, npm `integrity` (values above), `why` (the two-week rule and the date); the esbuild version; sha256 of each source file esbuild included; sha256 of the output `vendor/yjs/yjs.cjs`; and the licence file hashes. Records the same facts `VENDORED.json` records, adapted to a built file.
4. **Checks.** New test `src/test/replicaVendor.test.ts`: (a) `package.json` devDependencies pin `yjs` and `lib0` exactly; (b) `package-lock.json` `integrity` for both equals the manifest; (c) each `node_modules/{yjs,lib0}` input file hash equals the manifest; (d) if `vendor/yjs/yjs.cjs` exists its hash equals the manifest output hash (the test runs after `npm run compile`, which is how `npm test` runs); (e) the licences are present and contain "MIT License". `verify-release-content.mjs`: read the manifest from the repo root (as it does for `VENDORED.json` at line 170), read `extension/vendor/yjs/yjs.cjs` out of the VSIX with `unzip -p`, and fail on a hash mismatch. A changed or substituted copy then fails CI and the release, as D-16 requires.
5. The output hash depends on esbuild's version (pinned exactly at `0.28.2` in `package.json`); the manifest records it, and bumping esbuild is a reviewed step that regenerates the hash. Say so in the manifest `note` and in SECURITY.md.
6. SECURITY.md: add the section D-16 and D-30 ask for to "Dependencies" (`SECURITY.md:1303-1337`): yjs and lib0 rows in the first table (they are built from pinned devDependencies like pptxgenjs), a sentence that this is the first third-party code inside the signed replica core, that the replica core exists but is not yet used by the extension, and that the extension's own SBOM lists both. No em-dashes.

Why not committed files (option a): the MapLibre pattern works for browser files loaded by URL. For code `require`d in the extension host, Yjs's CJS build `require`s `lib0/array`, `lib0/binary`, `lib0/buffer`, ... (19 subpaths, [VERIFIED: grep of `dist/yjs.cjs`]) by package name, so a verbatim copy needs a `node_modules`-like directory in the repo (and `.vscodeignore`'s `node_modules/**` plus `.gitignore`'s `node_modules/` both match that name). The only committable form would be a pre-bundled blob, which loses the "copied byte for byte from the published package" claim the repo's MapLibre note makes. Option (b) keeps provenance through the lockfile's tarball integrity and our recorded hashes, and reuses code that already ships two bundles.

One more consequence: the hub (Phase 32) compiles pure replica files for a Node service without Yjs. Keep `doc.ts` (and the one `require`) out of every module the hub needs: `entry`, `kinds`, `verify`, `chain`, `equivocation`, `checkpoint`, `transport`, `order`. Only `fold`/`reducers`/`attribution` may import `doc.ts`. The boundary test enforces this.

## Architecture Patterns

### System Architecture Diagram

```
  sealed entries (headers + sealed bodies + blobs)         injected, never read from disk or clock here
   from tests / (later) store, hub, git, bundle                RosterView   KeyRing   BlobLookup   now
            |                                                    |           |          |         |
            v                                                    v           v          v         v
   [1 parse + shape]  header closed keys, version 2 only, sizes, strict base64url
            |
   [2 verify header] rebuild envelope with RosterView.writerKey(writer, rosterHash);
            |          sha256(key) == writer; signature; body.hash == sha256(ciphertext)
   [3 open body]    KeyRing(stream, epoch) -> AES-GCM open with aad (header minus sig, body.hash)
            |          missing key / blob / roster => HELD (not rejected)
   [4 body schema]  deps <= 16, lamport rule, kind in closed list, data schema by family
            |          unknown kind => KEPT, "newer version", no state change
            v
   [5 chain per (stream, writer)]  seq contiguous from 0, prev == hash(previous entry)
            |        two different hashes at one (stream, writer, seq) => EQUIVOCATION proof,
            |        writer quarantined from that seq on; chain break => later seqs HELD (tamper)
            |        dep not delivered => HELD + "missing N entries from W since seq S"
            |        at > now + 10 min => HELD until clock catches up
            v
   admitted set  ---->  [6 order]  sort by (lamport, writer, seq); under a checkpoint:
            |                       canonical(prefix) ++ canonical(rest)
            v
   [7 fold] reducers by kind family, in order:
            |   project / product.create / product.owner
            |   doc.client  -> client registry (first claim in order wins; collision refused)
            |   doc.update  -> ownership check -> Y.Doc per product (gc:false) -> attribution, deletion records
            |   doc.compact -> verified cache (never replaces updates)
            |   version.*   -> release.ts per version + decision algebra (maximal elements)
            |   equivocation.proof, digest.report
            |   other families: shape-checked, kept, relayed, not folded
            v
   FoldResult { state, held, rejected, quarantined, proofs, flags }
            |
   [8 digest]  sha256(canonical state), texts as state vector + text hash; { digest, checkpoint | null }
```

### Recommended Project Structure

```
src/domain/replica/
  entry.ts            # EntryHeader, GENESIS_PREV, REPLICA_SIGNED_AT, signHeader/verifyHeader, seal/open, entryHash, blob codec
  kinds.ts            # closed kind list and family, dispatch to kindSchemas/
  kindSchemas/        # one file per family: project.ts roster.ts doc.ts versions.ts registers.ts watches.ts runs.ts obs.ts integrity.ts
  rosterView.ts       # RosterView, KeyRing, BlobLookup interfaces and the test roster (Phase 31 replaces)
  verify.ts           # steps 1 to 4 for one entry; classification result types
  chain.ts            # step 5: per-writer chain, tamper, withholding, future hold
  equivocation.ts     # proof object, proof check, quarantine set
  order.ts            # lamport rule, sort, Kahn reference, checkpoint-final order
  checkpoint.ts       # checkpoint format, verify, order tip, disagreement proof
  fold.ts             # engine: classify -> order -> reduce -> digest; incremental and refold
  reducers.ts         # table kind-family -> reducer (assembled in the integration plan only)
  digest.ts           # canonical state, state digest
  doc.ts              # CRDT interface + Yjs adapter (the only file that loads the vendored bundle)
  attribution.ts      # client id -> doc.client registration -> writer / person / agent, per-version summary
  versions.ts         # per-version state via release.ts, numbering, concurrent proposals, "N changes since"
  decisions.ts        # decision algebra (pure, no release.ts import)
  transport.ts        # ReplicaTransport, HeadSet, PushResult, SealedEntry, SealedBlob (types only)
src/test/
  replica*.test.ts    # one file per concern (see Validation Architecture)
test/fixtures/replica/vectors.json   # canonical vectors for Phases 31 and 32 and the hub
scripts/entries/yjs.mjs, scripts/crdt-vendor.json
```

### Interfaces Phase 30 defines for later phases (so Phase 31 and 32 need no format change)

```ts
interface RosterView {
  hasRoster(rosterHash: string): boolean;                                   // false => entry HELD
  writerKey(writer: string, rosterHash: string): { publicKey: string; member: string } | undefined;
  hasRole(member: string, role: string, rosterHash: string): boolean;       // 'staff_lead' | 'deputy_lead' | 'section_lead:j2' | 'decision_for:commander' | 'member' ...
  roleWithdrawnBy(member: string, role: string, rosterHash: string): string | undefined; // hash of the first LATER roster entry that removes it (linear roster)
  chosenBranch(writer: string, stream: string, seq: number): string | undefined;         // device.release choice (Phase 31)
  checkpointSigner(fingerprintOrWriter: string, rosterHash: string): boolean;
  productOwner(product: string): string | undefined;                       // deputy lead included in hasRole
}
type KeyRing = (stream: string, epoch: number) => Buffer | undefined;      // 32-byte epoch key
type BlobLookup = (hash: string) => Buffer | undefined;                    // sealed blob bytes, in memory for the fold
```

### Pattern 1: ownership check algorithm (D-19; research question 2)

**What:** decide, from the update bytes alone and the order-independent registry, whether a `doc.update` entry is admitted, held, or rejected as forged.

```ts
// doc.ts (sketch). Inputs: update bytes, the entry's writer, the client registry for this product.
function checkUpdate(update: Uint8Array, writer: string, registry: ClientRegistry, nextClock: Map<number, number>):
    { ok: true; clients: number[]; deletes: Array<{ client: number; clock: number; len: number }> }
  | { ok: false; reason: 'malformed' | 'too-large' | 'forbidden-content' | 'foreign-client' | 'clock-overlap' } | { held: 'unregistered-client' } {
  if (update.length > MAX_UPDATE_BYTES) return { ok: false, reason: 'too-large' };
  let decoded; try { decoded = Y.decodeUpdate(update); } catch { return { ok: false, reason: 'malformed' }; }   // RangeError too
  for (const s of decoded.structs) {
    if (!('content' in s)) { if (isSkip(s)) return forbidden; /* GC: check client and length below */ }
    else if (!ALLOWED_REFS.has(s.content.getRef()) || (typeof s.parent === 'string' && s.parent !== 'body') || (s.parent !== null && typeof s.parent !== 'string')) return forbidden;
    if (s.length > MAX_STRUCT_LENGTH) return { ok: false, reason: 'too-large' };
    const owner = registry.ownerOf(s.id.client);                 // winner by fold order, or undefined
    if (owner === undefined) return { held: 'unregistered-client' };   // the doc.client entry may simply not have arrived yet
    if (owner !== writer) return { ok: false, reason: 'foreign-client' };
    // per-client clock rule, in the writer's own chain order: first struct of this client must start at the next expected clock
  }
  return { ok: true, ... };
}
```

Rules to implement and test:
- **Registration is order independent.** `doc.client {product, clientId, actor}` claims `(product, clientId)` for the entry's writer. Two claims by different writers for one id: the earlier in the **total order** wins; the later is refused and recorded (D-18). A late concurrent claim that sorts earlier flips the winner on refold, so the registry is a fold output, never mutable state kept outside the fold. A writer's own registration is in its own `prev` chain, so it precedes that writer's later updates in every total order; an update seen before its registration is `held`, not rejected (D-19). Scope the uniqueness per product (a Yjs client id only needs to be unique inside one document). Refuse id `0` and ids above `2^32 - 1`.
- **Clock rule (new).** Process one writer's `doc.update` entries per `(product, client)` in `seq` order; the first struct of client `c` in an update must start at `nextClock[c]` (0 initially), and `nextClock[c]` then advances to the update's end. A struct starting below `nextClock` is `clock-overlap` (reject: same client and clock with possibly different content makes Yjs's result depend on application order); one starting above it is admitted but the product reports `incomplete` (pending structs) rather than rejecting, because the gap may be an honest lost batch. [ASSUMED: strict contiguity vs "reject overlap, flag gap" is a plan-time choice; this recommendation is overlap-reject plus gap-flag.]
- **Deletions.** `decoded.ds` may cover any client's ranges (D-19). The fold records `{entry, product, client, clock, len}` per delete range as the "which entry deleted which range" record; the same range deleted twice is idempotent.
- **Do not trust `Y.encodeStateAsUpdate` from a peer as a doc.update.** A full-state or diff encoded after receiving others' text contains foreign structs and is rejected as foreign-client. The Phase 33 editor must emit only the transaction updates of its own client (`doc.on('update', (u, origin) => ...)` filtered to local origin).
- **Compaction (gap in the design).** `doc.compact` carries a full state, so its structs belong to many clients and cannot pass the per-writer ownership rule. Treat it as a **verified cache**: it must name `covers` (heads per writer) and carry `{stateVector, textHash}`; the fold computes the state from the updates it has, compares, and records `compact-mismatch` if they differ; a joiner that lacks the covered updates may load it provisionally, requiring every struct's client to be a registered client (from the small, always-replicated `doc.client` entries), marked `unverified` until the updates arrive. [ASSUMED: this verification rule is a research recommendation; D-21 only says the result must equal the full log.]

### Pattern 2: ordering (research question 5)

Verification enforces the **lamport rule**: `lamport == 1 + max(lamport of the writer's prev entry, lamport of each dep)`, and `1` when there are none. Then every edge `u -> v` (via `prev` or `deps`) has `lamport(u) < lamport(v)`, so sorting the admitted set by `(lamport, writer, seq)` (compare lamport numerically, then writer and seq as strings and numbers) **is** the deterministic topological order with the D-08 tie-break. Keep `kahnOrder` (priority-queue Kahn, key `(lamport, writer, seq)`) in the test folder or `order.ts` as the reference and assert `kahnOrder(set) deepEquals sortOrder(set)` in the property tests. An entry whose lamport breaks the rule is rejected `bad-lamport` once its predecessors are known (held until then). A dep that was quarantined (equivocation) counts as satisfied-by-absence so one forked device never stalls the project; a dep that was not delivered holds the entry (withholding).

- **Incremental vs refold (D-10).** Keep `FoldState { order: hash[], lastKey, state, docs }`. Applying an entry whose key sorts after `lastKey` appends and reduces. An entry that sorts before `lastKey` and is not inside a checkpointed prefix triggers a refold from the last checkpoint prefix (or from the start). Both paths call the same reducer function; the equivalence test shuffles delivery, folds incrementally, folds from scratch, and asserts equal state and digest. Texts are an optimisation: `Y.Doc`s are order independent, so keep them across a refold and rebuild a product's doc from scratch only when a registration verdict for that product flipped.
- **Checkpoint-final prefix (D-14).** The covered set is the causal closure of the checkpoint's heads. Final order = `sort(covered)` followed by `sort(rest)`. Entries arriving later that sort earlier than something in the prefix are placed after the prefix. This changes version numbering and registration winners but never the decision algebra (which uses causal relations, not order). Add `count` and `orderTip` per stream to the checkpoint (`orderTip_k = sha256(orderTip_{k-1} || entryHash_k)` over the covered prefix in order): without them "two checkpoints that disagree about one prefix" cannot be detected from heads and digests alone, since heads of different checkpoints cover different sets. A verifier recomputes `count`, `orderTip` and the digest from the closure of the heads and compares; mismatch means the signer or the fold is wrong. [ASSUMED: adding `count` and `orderTip` to the checkpoint extends DESIGN 4.6; the format is not frozen anywhere and Phase 30 owns it.]
- **Digest caveat.** A machine that holds a checkpoint and one that does not can legitimately number versions differently when a late concurrent entry exists. "Same entries, same digest" is therefore true for the same entries **and the same checkpoint set**. Return `{ digest, checkpoint: hash | null }` and compare digests only when the checkpoint field matches; state this in the digest docs.
- **Property-test budget (5 writers, memory cap).** Measured cost per entry: sign+seal about 0.28 ms, verify+open about 0.21 ms [VERIFIED: scratch run, 2000 entries]. Verify each generated entry set once, then permute the already-verified list through `fold` (the fold takes verified entries; D-09). Suggested sizes: 200 seeds per property, 2 to 5 writers, at most 60 entries per set, 4 shuffles with 5 duplicated entries each, 2 partitions (fold subset A, fold subset B, fold union incrementally). That is under 100k folds total and about 12,000 signed entries, a few seconds of CPU and tens of MB of heap, far below the 1536 MB old-space cap. The cap itself is the issue for `tsc`, not the tests: `tsc --noEmit` for the whole project peaked at 1.27 GB RSS in a capped run (16 s) [VERIFIED: `/usr/bin/time -v` under the cap wrapper], so keep new files lean and run tests from compiled output, one heavy command at a time.

### Pattern 3: versions through `release.ts` (research question 4)

Facts: `transition(record: ProductRecord, event: ReleaseEvent, actor: StaffActor): ReleaseResult` (`release.ts:231`); `export const HUMAN_ONLY_EVENTS: readonly ReleaseEventType[] = ['approve', 'reject', 'release', 'supersede'];` (`release.ts:24`); it refuses these for any `actor.kind !== 'person'` with `agent-cannot-decide` and for an unnamed person with `unnamed-person` (`release.ts:232-235`); `isNamedPerson` needs name, role and `deviceFingerprint` (`release.ts:178-180`); states `RELEASE_STATES = ['draft', 'guard-checked', 'awaiting-decision', 'approved', 'rejected', 'released', 'superseded', 'withdrawn']` (`release.ts:11`). Two limits matter: `propose`, `submit` and gate verdicts are authorised by `isAgent(actor, role)` (an **agent** whose `member` equals the product's owner, section lead or guard slug), so a person who proposes or submits does not pass; and `ProductRecord` carries `section: StaffSectionId` and `roles` with distinct owner, guard and tradecraft slugs (`validRoles`, `release.ts:190-196`).

Smallest adapter (in `versions.ts`; `release.ts` and its tests untouched):
- One `ProductRecord` **per version**, built as a literal `{ product, section, roles, state: 'draft', version: n, hash }` (the comment "only `transition` and `startProduct` make these" is a comment, not enforcement). `section` and `roles` come from `product.create` (so that kind's schema carries `section` from `STAFF_SECTION_IDS`: `export const STAFF_SECTION_IDS = ['command', 'j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'j8', 'j9', 'special-staff'] as const;`, `doctrine.ts:415`, and the role slugs).
- **Authority is decided first, by the roster view** (6.3 table). If the roster authorises a person for an owner-side act (`propose`, `submit`, `withdraw`), the adapter passes `{ kind: 'agent', member: roles.owner }` (or `roles.sectionLead` for a section lead) to `transition()`. This is the only place a person is presented as a seat; **never** the other way round: an agent entry is never mapped to a person, and for approve, reject, release, supersede the adapter passes `{ kind: 'person', name, role: <decision_for role>, deviceFingerprint }` built from the roster member, so `transition()` itself refuses any `actor.kind !== 'person'`. Tests assert the machine's refusal (`agent-cannot-decide`) independently of the roster check, so the rule holds even if the roster check had a bug.
- Per-version flow: gate steps (`verdict`, `submit`) are applied in fold order through `transition()` (concurrent guard verdicts are rare; see open question 3). **Decisions are not replayed in sequence.** The decision algebra computes the effective outcome class; the adapter then applies exactly one event (`approve`, `reject`, then `release`, or `withdraw`) to the version's `awaiting-decision` record, which is why "a person changing their mind" (approve then later reject) works although `release.ts` forbids `reject` from `approved`: the later decision is applied from `awaiting-decision`, not from `approved`. `edit` is never used (edits do not touch versions, D-23).
- State mapping (15.4 to `release.ts`): `proposed` = `draft` without `held`; `held` = `draft` with `held`; `guard-checked`, `awaiting-decision`, `approved`, `rejected`, `released`, `superseded`, `withdrawn` map one to one. `contested` and `pending-confirmation` do not exist in `release.ts`; they are an **overlay** the decision algebra adds to the view (`VersionView.state: ReleaseState`, `VersionView.overlay: 'contested' | 'pending-confirmation' | undefined`), so `release.ts` needs no change (D-24).
- **Version hash.** Today's `productHash(body, dependsOn)` (`ledger.ts:190-193`) hashes `body.replace(/\r\n/g, '\n')` plus `\n--depends_on: ` plus `product@version` pairs, with version **numbers** in `ProductDependency` (`ledger.ts:47`). DESIGN 6.4/D-26 want dependants to pin a version **hash** because numbers follow fold order. Recommended: `replicaVersionHash(text, pins)` with the same construction but `product@hash` pairs (three lines in `versions.ts`, a fixed vector in the vectors file). Phase 31's migration maps legacy versions across. [ASSUMED]
- `version.propose` data: `{ product, hash, textBlob, snapshot: {stateVector, deleteSet}, pins: [{product, hash}] }`. Fold check order: blob present (else held), blob decrypts, `replicaVersionHash(blobText, pins) === hash`, all updates covered by `snapshot.sv` are present (else held), then build the scratch `gc:false` doc from the accepted updates, `createDocFromSnapshot`, and compare `text === blobText` (else rejected `text-not-in-document`).
- Dependants (D-26): after folding, for every version whose `pins` name `(product, hash)` where the source product's newest **released** version has a different hash, emit `sourceChanged: [{ product, pinned, current }]`. Number-free, order-independent given the same released set.
- "N changes since vN" (D-23): the count of admitted `doc.update` entries for the product that are not in the causal closure of the version's `version.propose` entry; `ownerPromptDue = changes >= OWNER_PROMPT_THRESHOLD` with the constant set to `20`. See open question 4 about what a "change" is.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Text CRDT | Own OT or CRDT | Vendored Yjs behind `doc.ts` | Owner decision 1; convergence proven in the wild |
| Signing and verification | A second signer or raw `crypto.sign` calls | `signPayload` / `verifyPayload` with purpose `staff-replica` | D-05; Phase 71 moves only the envelope |
| Canonical JSON and hashing input | `JSON.stringify` on headers or state | `canonicalize` / `canonicalBytes` from `canonical.ts` | Sorted keys, safe-integer rule, depth cap; frozen by vectors |
| AES-GCM | New cipher code | `sealRaw` / `openRaw` from `domain/state/keys.ts` | Already tested, refusal type, 12-byte IV and 16-byte tag checks |
| Release rules | A copy of the state machine | `transition()` per version | D-24; its tests stay unchanged |
| Validation | Ad-hoc `if` chains or `{...parsed}` | `validate.ts` style: `isRecord`, `checkKeys`, own-property reads, `Object.keys` | Hostile-key safety (T-60-19 pattern) |
| Update inspection | Parsing Yjs bytes by hand | `Y.decodeUpdate`, `Y.parseUpdateMeta`, `Y.snapshot`, `Y.createDocFromSnapshot` | The wire format is internal and has versions (v1/v2) |
| Property-test PRNG | A new devDependency (fast-check) | The seeded `rng(seed)` pattern in `src/test/stateMerge.test.ts:11-19` | D-28; prints the seed on failure |
| Map keyed by attacker strings | Plain objects keyed by product slug or writer id | `Map` (or `Object.create(null)`) | `__proto__` and `constructor` keys from JSON bodies |

**Key insight:** every piece that looks hard (signatures, sealing, release rules, CRDT merge, canonical hashing) already exists in the repo or in Yjs. The new work is the glue rules (lamport check, chain classification, ownership with clocks, decision algebra, digest), and those are pure functions that the property tests can attack directly.

## Decision table for versions and decisions (research question 6)

### Definitions

- `past(x)`: the set of entries in x's causal closure over `prev` and `deps` (any stream, resolved by entry hash).
- `x < y` (decision precedence, within one version): `x ∈ past(y)` **or** `x.hash ∈ y.decisionsSeen`. Using both keeps precedence correct when `deps` is capped at 16 and makes `decisionsSeen` meaningful; a hash in `decisionsSeen` that is not a known decision on this version holds the entry. Two entries are **concurrent** when neither precedes the other.
- Acts on one version: `approve`, `reject` (both `version.decide`), `release` (`version.release`), `withdraw` (`version.withdraw`; carries `decisionsSeen` too), `supersede`. Only **valid** acts count: roster-authorised, person for the human-only ones, hash equals the version's hash, and valid in their own causal past (decide only after submit and before release; release only with an effective approval in its past).
- Outcome classes: `APPROVE = {approve, release}`, `REJECT = {reject}`, `WITHDRAW = {withdraw}`.
- `Max`: the valid, confirmed acts not preceded by another valid, confirmed act.
- **Confirmed vs unconfirmed.** A decision x by member m under role r cited at roster R is `unconfirmed` iff `roleWithdrawnBy(m, r, R)` names a roster entry w present in the set with `w ∉ past(x)` and `x ∉ past(w)` (concurrent withdrawal). If `x ∈ past(w)` the lead saw it before removing the role: x stands. If `w ∈ past(x)` then x cites a stale roster, which verification refuses (`stale-roster-citation`: the cited roster must be at or after every roster entry in the entry's own past).
- **Result** for a version's decisions: `none` (no valid acts), `effective(class, names)` (all of `Max` in one class), `contested(Max)` (two or more classes in `Max`), plus the overlay `pending-confirmation(list)` for unconfirmed acts not preceded by any confirmed act.
- Nothing ever picks by fold order, rank or time; fold order is used only for numbering versions, registration winners, and display ordering.

### Table A: gate chain (DESIGN 15.4 rows), each row a named test

| ID | From -> To | Trigger | Accept when | Refuse / hold when |
|----|-----------|---------|-------------|--------------------|
| G1 | none -> proposed | `version.propose` | owner seat (agent), a person answering for the section, or the section lead (roster); snapshot text equals blob text; hash matches | text never in the document (`text-not-in-document`); blob missing (held); non-owner (`not-owner`) |
| G2 | proposed -> held | guard `HOLD` or tradecraft `NOT READY` with reasons | gate member agent; verdict pins this hash | wrong gate member; reasons missing; stale hash |
| G3 | proposed -> guard-checked | guard `CLEARED` (J2: tradecraft `SIGN-OFF` on this hash first) | as `release.ts` | `tradecraft-required`; approve without guard is G-F3 |
| G4 | held -> next version | new `version.propose`, new hash | owner side | same hash (`no-change` in `release.ts` terms) |
| G5 | guard-checked -> awaiting-decision | `version.submit` names `decision_for` | owner side or section lead; hash still the guard-cleared hash | not guard-checked (`wrong-state`) |
| G6 | awaiting-decision -> approved / rejected | effective approve / reject | person with `decision_for` role | agent or hub actor (`agent-cannot-decide`) |
| G7 | awaiting-decision or approved -> contested | concurrent conflicting decision, or a decision concurrent with a withdraw | (algebra rows D4 to D9) | none |
| G8 | contested -> approved / rejected / withdrawn | fresh decision or withdraw whose `decisionsSeen` covers every member of `Max` | any role holder, including one of the two (withdraw: owner side or role holder) | `decisionsSeen` missing one contested act: stays contested |
| G9 | approved -> released | `version.release` | effective approval of the same hash in the release's past; person with role | no approval (`wrong-state`); approval of another hash (`stale-version`); agent |
| G10 | released -> superseded | `version.supersede` naming a newer version | person with role; newer version is released and numbered higher (`out-of-order` otherwise) | agent; not released |
| G11 | any non-terminal -> withdrawn | `version.withdraw` with a reason | owner side before approval; a person (role holder) after approval or release | agent after approval or release; no reason |
| G12 | terminal | superseded or withdrawn | nothing leaves (`terminal`) | any later act refused |

### Table B: decision algebra (15.5 and 6.4), each row a named test; run **every** row under all arrival permutations (exhaustive for at most 6 entries) and assert one result

| ID | Scenario | Result |
|----|----------|--------|
| D1 | no decisions | `none` |
| D2 | one valid approve | `effective(APPROVE, [name])` |
| D3 | approve a, later reject r (r saw a: `a < r`) | `effective(REJECT)` (a person changing their mind) |
| D4 | approve and reject, concurrent | `contested({a, r})`; state shows `awaiting-decision` with overlay `contested`; neither applies |
| D5 | approve and approve, concurrent, different people | `effective(APPROVE, [both names])` |
| D6 | reject and reject, concurrent | `effective(REJECT, [both names])` |
| D7 | approve concurrent with withdraw | `contested` (WITHDRAW vs APPROVE) |
| D8 | release concurrent with reject | `contested` (APPROVE vs REJECT) |
| D9 | release concurrent with withdraw | `contested` |
| D10 | release concurrent with a second approve | `effective(APPROVE)` and state `released` (same class) |
| D11 | contested {a, r}; fresh approve x with `decisionsSeen` = {a, r} | `effective(APPROVE)`; x may be by the author of a or r |
| D12 | contested {a, r}; fresh x with `decisionsSeen` = {a} only | still `contested({x, r})` (x vs r concurrent, different classes); a is superseded by x |
| D13 | contested; fresh withdraw seeing both | `effective(WITHDRAW)`, state `withdrawn`, terminal |
| D14 | effective approve a; later concurrent reject r (offline) | `contested({a, r})` |
| D15 | D14 where a is under a checkpoint prefix | same `contested`, plus output flag `finalBeforeDispute: true` for wording only; algebra unchanged |
| D16 | decision whose role was withdrawn concurrently | decision listed as `pending-confirmation`, not in `Max`; state stays `awaiting-decision` |
| D17 | D16 then a current role holder writes decide seeing it, same outcome | `effective` (confirmed) |
| D18 | D16 then a current holder writes decide seeing it, other outcome | `effective` of the new decision (it overrides; the pending one is superseded) |
| D19 | D16 then a current holder declines (see open question 1) | `none` |
| D20 | decision made before the role was withdrawn and seen by the withdrawing roster entry (`x ∈ past(w)`) | `effective` (not pending) |
| D21 | decision citing a roster older than a roster entry in its own past | rejected `stale-roster-citation` |
| D22 | approve for hash H1 when the version is H2 | rejected `stale-version` (decisions pin the hash) |
| D23 | decision on a withdrawn or superseded version after the terminal act | rejected `terminal`, unless the decision settles a contested set that included the withdraw |
| D24 | `decisionsSeen` names an unknown hash | held until that decision arrives |

### Table C: forbidden acts (each tested, each independently of the roster check)

F1 agent approve; F2 agent reject; F3 agent release; F4 agent supersede (each with `actor.kind` = `agent` and `hub`; the machine returns `agent-cannot-decide`); F5 approve without a guard clear; F6 release without an effective approval; F7 approval of another hash; F8 proposal of text never in the document; F9 a removed role's decision taking effect unconfirmed (it stays `pending-confirmation`).

### Table D: numbering and flags

N1 numbers follow fold order (consecutive per product); N2 two concurrent proposals both kept, consecutive numbers, the later marked `proposedAtSameTimeAs: [n]` (concurrent = neither in the other's `past`); N3 an edit after a proposal never changes the version; "N changes since" grows; N4 `ownerPromptDue` at 20; never auto-withdraws; N5 `sourceChanged` computed from pins; N6 a late proposal arriving after a checkpoint gets the next number after the prefix.

## Common Pitfalls

### Pitfall 1: circular associated data
**What goes wrong:** the plan follows DESIGN 4.2 literally and cannot build the entry (the AAD contains the hash of the ciphertext it protects). **Avoid:** AAD = header minus `sig` minus `body.hash` (keep `body.size`). **Warning sign:** an implementation that seals twice or computes the hash from a placeholder.

### Pitfall 2: signing time makes retries look like equivocation
**What goes wrong:** `signPayload` default `now` yields a new `signedAt` and signature on every call; a crash-and-retry at the same seq produces two different signed headers. **Avoid:** constant `signedAt`; builder returns the finished bytes; store must write before send. Test: re-sign gives identical bytes; re-seal gives a detected equivocation.

### Pitfall 3: rotated keys pass with a constant `signedAt`
**What goes wrong:** passing real key status with an epoch `signedAt` lets a rotated key verify. **Avoid:** constant-active lookup in the adapter; authority from `RosterView` at the cited roster hash (rotation/revocation by roster position).

### Pitfall 4: state vector alone does not name a text
**What goes wrong:** `version.propose` carries only a state vector, so "the text at that state vector" is ambiguous after a delete-only update. **Avoid:** carry the snapshot (state vector plus delete set); verify on a scratch `gc:false` doc.

### Pitfall 5: `createDocFromSnapshot` mutates its origin and needs `gc:false`
**Avoid:** never call it on the canonical fold doc; build a scratch doc per check; fold docs are `gc:false`.

### Pitfall 6: Yjs applies first-come on duplicate clocks
**What goes wrong:** two entries by one writer both containing `(client, clock)` with different content make text depend on application order. **Avoid:** the per-client clock rule in writer chain order; test it with both delivery orders.

### Pitfall 7: a decoded update can crash or balloon the parser
**Avoid:** size cap before decode, `try/catch` around `decodeUpdate` and `applyUpdate` (catch `RangeError`), caps on struct length and on struct count, content-kind allow list, reject `Skip` and unknown parents.

### Pitfall 8: minified class names
**Avoid:** never `constructor.name`; use `'content' in s`, `getRef()`.

### Pitfall 9: prototype pollution through JSON bodies
`JSON.parse('{"__proto__": {...}}')` creates an own `__proto__` key. Closed key lists (`checkKeys`) reject it; never spread parsed input; keep fold state in `Map`s keyed by validated slugs; canonical JSON refuses non-plain objects when hashing state, so build the digest input from arrays and plain literals, never from `Map`s directly.

### Pitfall 10: quarantine stalls the project
**Avoid:** a quarantined writer's entries are removed from the graph and deps on them count as satisfied-by-absence. Quarantine starts at the **fork seq** (both branches excluded); earlier entries stand. `device.release` choosing a branch is honoured through `RosterView.chosenBranch`.

### Pitfall 11: held, rejected, kept, unknown are four different outputs
Held (missing roster, key, dep, blob, registration, or future-dated): not state, reported, becomes applied when the missing piece arrives. Rejected (bad signature, schema, forged attribution, bad lamport, stale roster citation): permanent, recorded. Kept-not-folded (unknown kind, families not folded until their phase): relayed, no state change. Unauthorised at the cited roster (D-09): kept and reported, no state change. The fold result lists each, so tests can assert on all four.

### Pitfall 12: tests that need `vendor/` build order
`vendor/yjs/yjs.cjs` exists only after `node scripts/vendor-libs.mjs`. `npm test` runs `npm run compile` first (`package.json:1091`), but a bare `tsc` plus `node --test` does not. The quick command below runs the vendor step, so tests that load `doc.ts` do not fail with "cannot find module" for a reason unrelated to the change.

## Code Examples

### Seeded generator and a convergence property (pattern from `src/test/stateMerge.test.ts:11-19`)

```ts
// Source: src/test/stateMerge.test.ts rng(); property shape per DESIGN 17
function shuffled<T>(items: readonly T[], random: Rng): T[] { /* Fisher-Yates with random.int */ }
test('any order, duplicates and partitions of up to five writers fold to one state and digest', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = rng(seed);
    const world = buildWorld(random, { writers: 2 + random.int(4), maxEntries: 60 });   // signs and seals once, verifies once
    const reference = fold(world.verified, ctx);
    for (let k = 0; k < 4; k++) {
      const delivery = [...shuffled(world.verified, random), ...world.verified.slice(0, 5)];   // duplicates
      assert.equal(foldIncrementally(delivery, ctx).digest, reference.digest, `seed ${seed} order ${k}`);
    }
    const [a, b] = partition(world.verified, random);
    assert.equal(foldIncrementally([...a, ...b], ctx).digest, reference.digest, `seed ${seed} partition`);
  }
});
```

### Equivocation under every arrival order

```ts
// two signed headers at one (stream, writer, seq); both orders, with and without later entries from the same writer
for (const order of permutations([entryA, entryB, laterFromW, otherWriterEntry])) {
  const result = fold(order, ctx);
  assert.deepEqual(result.quarantined, [W]);
  assert.equal(result.proofs.length, 1);                  // one proof, canonical form (sorted pair), checkable alone
  assert.ok(verifyProof(result.proofs[0]));               // carries the writer's public key; no roster needed to check
  assert.equal(stateOf(result, 'otherWriterEntry').applied, true);   // other writers unaffected
}
```

### Loading the vendored bundle in `doc.ts`

```ts
// Source: pattern of src/mcp/client.ts:80, types as verified by a scratch tsc run
import * as path from 'node:path';
import type * as YTypes from 'yjs';
type YjsApi = typeof YTypes;
let yjs: YjsApi | undefined;
function loadYjs(): YjsApi {
  if (yjs === undefined) yjs = require(path.join(__dirname, '..', '..', '..', 'vendor', 'yjs', 'yjs.cjs')) as YjsApi;
  return yjs;
}
```

### Boundary test rule (new file `src/test/replicaBoundaries.test.ts`; do not import from `teamBoundaries.test.ts`, because importing a test file registers its tests a second time)

Rule: files under `src/domain/replica` may import Node modules, relative files under `src/domain`, and `import type ... from 'yjs'` only in `doc.ts`; only `doc.ts` may contain the path segments `'vendor', 'yjs'`; `entry`, `kinds`, `verify`, `chain`, `equivocation`, `checkpoint`, `order`, `transport` must not import `doc.ts`, `attribution.ts` or `fold.ts` (so the hub can compile them without Yjs). Include a "scanner has teeth" test with planted violations as `teamBoundaries.test.ts` does (its line-based regexes `STATIC_FORM`, `SIDE_EFFECT_FORM`, `CALL_FORM` are the model; a `require(path.join(...))` call is invisible to them, so add the explicit vendor-path check).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single global hash chain per ledger (`ledger.ts`) | Per-writer per-stream chains joined by cited heads | This design (2026-11-19) | No sequencer; concurrency is not a fork |
| One writer per product (`ownership.ts`) | Everyone edits, owner proposes versions | Owner decision 2026-11-19 | Ownership is accountability |
| Release machine on the file | Release machine per frozen version | DESIGN 6.2 | Edits no longer reset state |
| Yjs 14 pre-releases | Yjs 13.6.33 stable line | 2026-09 | 14.0.0-x are pre-releases on the registry; stay on 13.6.x |

**Deprecated/outdated:** `lib0 1.0.0-rc.*` (a release-candidate line, dist-tag `beta`); yjs 13.6.33's range `^0.2.99` stays on 0.2.x.

## Runtime State Inventory

Not applicable: Phase 30 is additive, greenfield code. It renames nothing, migrates no stored data, registers nothing with the OS and creates no secrets or env vars. The only existing-file changes are `PAYLOAD_PURPOSES` (plus its test), `package.json`/`package-lock.json` devDependencies, `scripts/vendor-libs.mjs`, `scripts/verify-release-content.mjs`, `SECURITY.md`. Nothing found in any of the five categories (verified by the phase scope in CONTEXT.md D-02).

## Wave structure (research question 7)

The tracer must come first. Vendoring is its prerequisite because the tracer's text merge needs real Yjs bytes. Everything after the tracer divides by file ownership.

| Wave | Plan (suggested) | Owns (no other plan in the wave edits these) | Depends on |
|------|------------------|----------------------------------------------|------------|
| 1 | 30-01 Vendor Yjs and lib0, `staff-replica` purpose | `package.json`, `package-lock.json`, `scripts/vendor-libs.mjs`, `scripts/entries/yjs.mjs`, `scripts/crdt-vendor.json`, `scripts/verify-release-content.mjs`, `SECURITY.md`, `src/domain/team/signedPayload.ts` (one array entry), `src/test/teamSignedPayload.test.ts`, `src/test/replicaVendor.test.ts` | none (includes the `checkpoint:human-verify` for the lib0 pin) |
| 2 | 30-02 Tracer slice | `src/domain/replica/{entry,verify,order,fold,reducers,doc,rosterView,kinds}.ts` and `kindSchemas/*` as stubs, `src/test/replicaTracer.test.ts`: two writers, one sealed `doc.update` each, same text and digest in both orders | 30-01 |
| 3 (parallel) | 30-03 Kinds and validation | `kinds.ts` (list), `kindSchemas/*`, `src/test/replicaKinds.test.ts`, vectors for header and body bytes | 30-02 |
| 3 | 30-04 Chain, tamper, withholding, equivocation | `chain.ts`, `equivocation.ts`, `verify.ts` additions, `src/test/replicaChain.test.ts`, `replicaEquivocation.test.ts` | 30-02 |
| 3 | 30-05 Co-editing core and CRDT spike | `doc.ts`, `attribution.ts`, `kindSchemas/doc.ts`, `src/test/replicaDoc.test.ts`, `replicaAttribution.test.ts`, the spike script and the numbers file in the phase folder | 30-02 |
| 3 | 30-06 Versions and decisions | `versions.ts`, `decisions.ts`, `kindSchemas/versions.ts`, `src/test/replicaVersions.test.ts`, `replicaDecisions.test.ts` | 30-02 |
| 3 | 30-07 Order, incremental fold, checkpoint, digest, transport types | `order.ts`, `checkpoint.ts`, `digest.ts`, `transport.ts`, `fold.ts` incremental parts, `src/test/replicaOrder.test.ts`, `replicaCheckpoint.test.ts` | 30-02 |
| 4 | 30-08 Integration and close-out | `reducers.ts` (wires all families), `replicaConvergence.test.ts` (property tests over every family), `replicaBoundaries.test.ts`, `test/fixtures/replica/vectors.json`, SECURITY.md note, full-suite run | 30-03 to 30-07 |

Conflict controls: the tracer creates `kinds.ts`, `reducers.ts` and `rosterView.ts` with the full closed kind list and stub per-family schema files, and the single `fold(admitted, ctx)` entry point plus a `classify(entries, ctx)` seam; wave 3 plans replace stub files they own and never edit `reducers.ts` or `fold.ts` outside their lines; wave 4 alone edits `reducers.ts`. If the planner wants two PRs, the natural cut is waves 1 to 2 as an early landing and waves 3 to 4 as the second; the user's rule (one integration after merging parallel worktrees, full suite once) applies to wave 4.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | AAD = `{v, stream, writer, seq, prev, epoch, size}` (header minus `sig` and `body.hash`); blob AAD `{v, blob, stream, epoch}` | Signer fit | Any consistent choice works; only "exclude `body.hash`" is forced. Phases 31 and 32 and the hub must use the same bytes, so fix it in the vectors |
| A2 | `REPLICA_SIGNED_AT` constant epoch and constant-active status lookup | Signer fit | If the owner wants the real signing time visible, the header needs a field (a format change); constant keeps D-03 as written |
| A3 | Strict per-client clock rule: reject overlap, flag gap | Ownership check | Too strict might reject an honest editor that dropped a batch; too lax breaks convergence. Confirm with Phase 33 editor design |
| A4 | Content kinds allowed in `doc.update`: string and deleted only (refs 4 and 1) plus GC structs | Yjs facts | If Phase 33 wants formatting or embeds, the allow-list must widen with a format note |
| A5 | Limits: `MAX_UPDATE_BYTES` 4 MiB, `MAX_STRUCT_LENGTH` 1,000,000, inline body 16 KB (D-04), blob cap 8 MiB, header 4096 bytes | Ownership check, pitfalls | Values are research proposals; the design names only 16 KB and deps at most 16 |
| A6 | `doc.compact` is a verified cache with `covers`, `stateVector`, `textHash` | Ownership check | If compaction should replace updates for joiners without verification, forged attribution inside a compaction is possible; needs an owner decision |
| A7 | Checkpoint adds `count` and `orderTip` per stream | Ordering | Without them hub-equivocation detection (D-14) cannot compare prefixes |
| A8 | Version hash `replicaVersionHash` uses `product@hash` pins | Versions | If numbers are kept (as `productHash` does), dependants break when numbering changes |
| A9 | `version.decide` outcome vocabulary adds `decline` for 15.5's `pending-confirmation -> none (declined)`; `version.withdraw` carries `decisionsSeen`; supersede concurrent with withdraw is contested | Decision table | The design is silent on the exact shape; these are the smallest additions that make 15.4 and 15.5 implementable |
| A10 | Unconfirmed = roster withdrawal concurrent with the decision (neither in the other's past) | Decision table | A wall-time or order-based rule would make old decisions pending after a later removal; the causal rule avoids that |
| A11 | Preliminary size numbers (3.6 bytes per character, 4.6 percent for `gc:false`) generalise to real typing | Yjs facts | The D-22 spike must confirm; only affects the compaction default |

## Open Questions

1. **The "declined" transition of 15.5** (`pending-confirmation -> none`). The design lists the transition but no entry shape produces it. Recommendation: an outcome value `decline` on `version.decide`, valid only when every `decisionsSeen` entry is pending, by a current role holder. Plan 30-06 should confirm or choose another shape in its first task.
2. **Compaction verification** (A6). Recommendation above; the planner should record it as a locked sub-decision if the owner agrees (DESIGN 5.2 and D-21 do not say how a joiner trusts a compaction).
3. **Concurrent guard verdicts** (HOLD vs CLEARED on the same hash). Design silent. Recommendation: HOLD or NOT READY blocks (safe direction) until a fresh verdict that saw both; add one test row.
4. **What counts as a "change"** for "about 20 changes" (D-23, owner decision 4). A `doc.update` entry is a batch of at most 500 ms of typing, so 20 entries can be one sentence. Recommendation: count admitted `doc.update` entries not covered by the version, expose both that count and total inserted plus deleted characters, and compute `ownerPromptDue` on the entry count as D-23 reads, with the threshold a named constant so the owner can retune it. The owner may prefer a character threshold.
5. **Supersede vs withdraw on a released version** (A9) and whether two concurrent supersedes name different newer versions: recommendation contested for the first, "highest released wins" for the second. Needs a one-line owner nod.
6. **Where `section` and the role slugs live.** `release.ts` needs `section` and distinct owner, section lead, guard (and tradecraft) slugs per product. Recommendation: `product.create` carries them (`section` from `STAFF_SECTION_IDS`, slugs matching `STAFF_SLUG`), and `product.owner` changes only `roles.owner`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | build and tests | yes | v24.22.3 (repo targets `node22` in esbuild) | none needed |
| npm | installing the two devDependencies | yes | 11.19.1, registry reachable (`npm view` worked) | none |
| esbuild | bundling Yjs | yes | 0.28.2 in `node_modules` (exact devDependency) | none |
| TypeScript | compile | yes | 5.9.3 | none |
| `systemd-run`, `flock`, `choom`, `timeout` | capped heavy runs (D-29) | yes | `/usr/bin/...` | none |
| `unzip` | `verify:release` hash read of the VSIX | yes | `/usr/bin/unzip` | the script's own ZIP parser lists entries; reading bytes needs `unzip -p` as the existing check does |
| Network for vendoring | `npm install`, `npm pack` | yes (used this session) | n/a | offline machines need the lockfile and an npm cache |

**Missing dependencies with no fallback:** none. **Note:** `node_modules` in this worktree is a symlink to the parent checkout, so installing devDependencies changes the shared folder; do the install once, in the plan's first task, and say so in its summary.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `node:test` with `node:assert/strict`, TypeScript compiled by `tsc` to `dist/test/`, run by `scripts/run-tests.mjs` |
| Config file | `tsconfig.json` (includes `src/**/*.ts`); no separate test config |
| Quick run command (one file) | `flock /home/aaron/.cache/claude-code-tmp/claude-1000/-home-aaron-projects-codequity-near-ai-vscode/3d22e8c9-071a-44b3-b6fc-358cc97299ea/scratchpad/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'node scripts/vendor-libs.mjs && node node_modules/typescript/bin/tsc -p tsconfig.json && node scripts/run-tests.mjs dist/test/replicaEntry.test.js'` (substitute the file) |
| Phase suite | same wrapper with `dist/test/replica*.test.js dist/test/teamSignedPayload.test.js dist/test/teamBoundaries.test.js` |
| Full suite | same wrapper with `npm test` (once, at the end of the phase, wave 4) |
| Type check only | same wrapper with `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` (16 s, 1.27 GB peak measured) |

(`sh -c` inside the wrapper keeps the capped process a single command; if the planner prefers, put the three steps in a small `scripts` entry. Never run two heavy commands at once.)

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command (file) | File Exists? |
|--------|----------|-----------|--------------------------|--------------|
| MUS-01 | header sign/verify through `staff-replica`, deterministic sig, writer bound to key, AAD without `body.hash`, seal/open, entry hash, blobs, vectors | unit | `dist/test/replicaEntry.test.js` | Wave 0 gap |
| MUS-01 | kinds closed list, schemas, unknown kind kept, unknown header version refused, prototype keys refused, size limits | unit | `dist/test/replicaKinds.test.js` | Wave 0 gap |
| MUS-01 | chain from seq 0, tamper breaks only that writer, withholding report, future hold (10 min), lamport rule, stale roster citation | unit | `dist/test/replicaChain.test.js` | Wave 0 gap |
| MUS-01 | equivocation proof checkable alone, quarantine from fork seq under every arrival permutation, other writers unaffected, retry is not equivocation, re-seal is | unit + exhaustive permutations | `dist/test/replicaEquivocation.test.js` | Wave 0 gap |
| MUS-01 | order = sort key = Kahn reference; incremental equals refold; checkpoint-final prefix; checkpoint verify and disagreement proof; digest with state vector and text hash | unit + property | `dist/test/replicaOrder.test.js`, `replicaCheckpoint.test.js` | Wave 0 gap |
| MUS-01 | 2 to 5 writers, any order, duplication, partition fold to one state and digest | property (200 seeds) | `dist/test/replicaConvergence.test.js` | Wave 0 gap |
| MUS-02 | vendored bundle hash, versions, licences; lockfile integrity; payload purpose list | unit | `dist/test/replicaVendor.test.js`, `teamSignedPayload.test.js` | Wave 0 gap (vendor), exists (payload, needs extension) |
| MUS-02 | ownership: foreign client rejected, own client admitted, unregistered held then admitted, collision refused, clock overlap rejected, content-kind allow list, malformed, nested-array RangeError, size caps | unit | `dist/test/replicaDoc.test.js` | Wave 0 gap |
| MUS-02 | random concurrent edits by persons and agents converge; each char's author equals the inserting writer; deletion records; `incomplete` on pending structs | property (150 seeds) | `dist/test/replicaAttribution.test.js` | Wave 0 gap |
| MUS-02 | compaction plus later updates equals full log (text, state vector, attribution); forged compaction flagged | unit | `dist/test/replicaDoc.test.js` | Wave 0 gap |
| MUS-02 | boundary: no `vscode`, no package, `doc.ts` is the only Yjs and vendor-path user, hub-side files do not import `doc.ts` | unit | `dist/test/replicaBoundaries.test.js` | Wave 0 gap |
| MUS-03 | tables A, C and D rows through the fold with real entries; agent actors refused by `transition()` itself | unit | `dist/test/replicaVersions.test.js` | Wave 0 gap |
| MUS-03 | table B rows D1 to D24 each under all permutations (exhaustive up to 6 entries); nothing auto-picks | unit + exhaustive | `dist/test/replicaDecisions.test.js` | Wave 0 gap |
| MUS-03 | proposal of text not at its snapshot refused; snapshot includes delete set; hash equals `replicaVersionHash` | unit | `dist/test/replicaVersions.test.js` | Wave 0 gap |

### Sampling Rate

- **Per task commit:** the single `dist/test/replica<Concern>.test.js` file for that task (quick run command); property tests keep a smaller seed count under an environment switch if a file exceeds about 20 seconds (but never fewer seeds in the committed default).
- **Per wave merge:** `dist/test/replica*.test.js` plus `teamSignedPayload.test.js` and `teamBoundaries.test.js` and `staffRelease.test.js` (proves `release.ts` is unchanged).
- **Phase gate:** the full suite once (`npm test` under the wrapper), then `npm run verify:release` once after the vendoring plan and again at the end (it packages the VSIX; heavy, use the wrapper). Security-relevant checks (signature, ownership, equivocation, agent refusal, hash checks) block immediately at the task level, not just at the gate.

### Wave 0 Gaps

- [ ] `src/test/replica*.test.ts` files listed above (none exist: `ls src/domain/replica` fails, no `replica*` tests)
- [ ] `test/fixtures/replica/vectors.json` and its test-only fixed-IV sealing generator
- [ ] a shared test helper `src/test/replicaWorld.ts`-style builder (test roster, key pairs from fixed seeds, `buildWorld(random, ...)`); keep it in one file so waves 3 plans do not each invent one. Note `run-tests.mjs` runs only `*.test.js`, so a helper without `.test` in its name is not run as a test
- [ ] `scripts/crdt-vendor.json` and the `verify-release-content.mjs` check
- [ ] Framework install: none (node:test is built in); the two devDependencies are the Wave 1 install

## Security Domain

`security_enforcement` is not set to false in `.planning/config.json`, so this section applies.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | Partly (device-key identity of writers) | Ed25519 through the existing signer; writer id bound to the key; authority from `RosterView` |
| V3 Session Management | No | No sessions in this phase |
| V4 Access Control | Yes | Roster-authorised acts; human-only acts refused for agent and hub actors by `release.ts` `transition()`; ownership of Yjs client ids |
| V5 Input Validation | Yes | `validate.ts`-style closed key lists, own-property reads, size and depth caps, strict base64url, `try/catch` around Yjs decoding, content-kind allow list |
| V6 Cryptography | Yes | `node:crypto` only: Ed25519 via the signer, SHA-256, AES-256-GCM via `sealRaw`/`openRaw` with a fresh 96-bit IV; never hand-rolled |
| V8 Data protection | Yes (bodies sealed) | AES-GCM under the cell epoch key; keys are injected, never stored in this phase |
| V10 Malicious code | Yes | First third-party code in the signed replica core: pinned, hash-checked, SBOM-listed, documented in SECURITY.md |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged attribution (update under another writer's client id) | Spoofing / Tampering | `doc.client` registry, per-struct client check, whole update rejected and recorded; tests for foreign id, collision, late registration |
| Equivocation (cloned key, restored image) | Spoofing | Portable proof (carries the public key), quarantine from the fork seq on every machine, any arrival order |
| Tampered old entry | Tampering | Signature and `body.hash` checks; per-writer chain break holds later seqs of that writer only |
| Replay | Repudiation / Tampering | Idempotent by entry hash; `stream` and `seq`/`prev` inside the signed header; AAD binds ciphertext to its position |
| Re-attaching a copied ciphertext under another signer | Spoofing | AAD (stream, writer, seq, prev, epoch, size) makes it unreadable |
| Oversized bodies, updates, blobs, deps | Denial of service | Caps: inline body 16 KB then blob, blob cap, `MAX_UPDATE_BYTES`, `MAX_STRUCT_LENGTH`, deps at most 16, header 4096 bytes, canonical depth 16 |
| Malformed or hostile Yjs update (parser attack surface) | DoS / Tampering | Size cap, `try/catch` (RangeError at about 20,000 nested arrays), content allow list (no Any, Type, Embed, Format, Doc), parent must be `body`, no `Skip`, per-client clock rule, catch around `applyUpdate` |
| Order-dependent text via duplicate clocks | Tampering | Clock rule in the writer's chain order |
| Prototype pollution in JSON bodies | Tampering | Closed key lists, no spread of parsed input, `Map` for attacker-keyed tables |
| Agent decides (approve, reject, release, supersede) | Elevation of privilege | `actor.kind` must be `person`; refused by the state machine itself, tested apart from the roster check; `hub` actors accepted by no reducer |
| Future-dated entries steering order | Tampering | Wall time never orders; entries more than 10 minutes past the injected `now` are held |
| Hub or peer withholds entries | Denial of service | Withholding report from `deps` and checkpoint heads (pure function) |
| Forged or inconsistent checkpoint | Spoofing / Tampering | Signer check via `RosterView`, recomputed `count`/`orderTip`/digest, two disagreeing checkpoints form a proof |
| Supply chain (Yjs, lib0) | Tampering | Exact pins, lockfile integrity, recorded source and output hashes, `verify:release` byte check, SBOM and OSV scan, no install scripts |

## Sources

### Primary (HIGH confidence)
- In-repo files read this session, with the lines cited above: `src/domain/team/signedPayload.ts`, `canonical.ts`, `keyStatus.ts`, `secrets.ts`, `validate.ts`; `src/domain/staff/release.ts`, `ledger.ts`; `src/domain/state/keys.ts`; `src/test/teamBoundaries.test.ts`, `stateMerge.test.ts`, `teamSignedPayload.test.ts`, `staffCopSymbols.test.ts`; `scripts/vendor-libs.mjs`, `verify-release-content.mjs`, `extension-sbom.mjs`, `run-tests.mjs`; `package.json`, `tsconfig.json`, `.gitignore`, `.vscodeignore`; `media/vendor/VENDORED.json`; `src/mcp/client.ts`; `SECURITY.md` Dependencies.
- npm registry (via `npm view` and `npm pack --ignore-scripts` into an isolated scratch folder): yjs 13.6.33, lib0 0.2.119 and 0.2.120, isomorphic.js 0.2.5; tarball source of `src/utils/updates.js`, `Snapshot.js`, `Transaction.js`, `dist/yjs.cjs`.
- Scratch experiments (Yjs behaviour, bundle hash, tsc type check, signer adapter, timings) run against the bundled packages; scripts live in the session scratchpad, not in the repo.
- `gsd-tools query package-legitimacy check` output for yjs, lib0, isomorphic.js.

### Secondary (MEDIUM confidence)
- https://docs.yjs.dev/api/document-updates : "Document updates are commutative, associative, and idempotent"; lists `encodeStateVectorFromUpdate`, `diffUpdate`, `mergeUpdates`. It does not document `decodeUpdate` or `parseUpdateMeta`; their behaviour here comes from the source and the runs above.

### Tertiary (LOW confidence)
- None used for decisions. Preliminary size numbers are the researcher's own synthetic measure (A11).

## Metadata

**Confidence breakdown:**
- Standard stack and vendoring: HIGH. Registry facts, bundle built twice with the same hash, `tsc` type check run with the repo's tsconfig, SBOM path read.
- Signer fit: HIGH. Adapter exercised end to end in a scratch compile of the real `signedPayload.ts`.
- Yjs behaviour: HIGH for what was run; MEDIUM for byte-identical determinism (observed, not promised).
- Decision algebra: MEDIUM. Derived from DESIGN 6.4, 15.4, 15.5; open questions 1, 3, 5 and assumption A9 need confirmation.
- Pitfalls and security: HIGH where reproduced (RangeError, duplicate clocks reasoning, delete-only state vector), MEDIUM elsewhere.

**Research date:** 2026-11-19
**Valid until:** 2026-12-19 for the vendoring facts (a lib0 0.2.120 age check passes after 2026-11-23 but 0.2.119 remains the pinned, reviewed choice); the in-repo facts hold until the files change.

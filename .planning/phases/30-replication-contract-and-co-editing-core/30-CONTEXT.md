# Phase 30: Replication contract and co-editing core - Context

**Gathered:** 2026-11-19
**Status:** Decided. The owner's decisions of 2026-11-19 (DESIGN.md section 21 and throughout) settle every gray area; the planning agent recorded them here as D-01..D-30 on the owner's behalf and did not ask again. Where a detail was not settled by the design, the decision follows what the design implies and says so.
**Source:** `.planning/research/multiuser-sync/DESIGN.md` (sections 1 to 6, 15.4, 15.5, 16, 17, 18 WP-R0, 20, 21), `.planning/research/multiuser-sync/RESEARCH.md`, the Phase 30 entry in `.planning/ROADMAP.md` (MUS-01, MUS-02, MUS-03), and the code the design cites on `origin/main` (0.4.34 plus PR #123).

<domain>
## Phase Boundary

Phase 30 is the design's work package WP-R0, "Contract": the pure replication contract and the co-editing core that every later phase of drop A imports. It is the first of two 0.4.x staff collaboration drops (drop A is Phases 30 to 33). Nothing in it changes what a person sees in 0.4.x: no command, no view, no setting, no transport and no hub.

In scope:
- Entry format version 2: header (stream, writer, seq, prev, epoch, body hash and size, signature), sealed body (AES-256-GCM under a caller-supplied cell epoch key, header without `sig` as associated data), blobs for bodies over 16 KB, entry hash, canonical vectors.
- Entry kinds (section 4.3) as a closed list with schemas; only the kinds Phase 30 folds get full reducers (project, product text, versions and ownership, integrity); the other families are defined, validated for shape, and kept and relayed but not folded until their phase (roster in 31, registers in 31/33, watches, runs and observations in 35).
- Verification: header signature through the existing signer with a new purpose `staff-replica`, per-writer chain from seq 0, body authentication, schema, and authorisation through an injected roster view (the real roster is Phase 31).
- Causal graph from `prev` and `deps`, deterministic total order (topological, ties by lamport, writer, seq), the fold through pure reducers, refold on a late concurrent entry, state digest per stream.
- Equivocation: proof object, detection whatever the arrival order, quarantine in the fold; tamper (changed old entry) breaks only that writer's chain; future-dated entries (over 10 minutes) held.
- Checkpoint format (signed, heads per writer per stream, digests) and the rule that order under a checkpoint is final; the `ReplicaTransport` interface as a type only.
- Co-editing core: Yjs and `lib0` vendored at pinned versions with licences behind one CRDT interface; `doc.client` registration; `doc.update` carrying Yjs updates; ownership check rejecting inserts under another writer's client id; per-character attribution; deletion records; `doc.compact` format; CRDT spike measurements.
- Versions and decisions: `version.propose` pinning content hash, blob and state vector, checked against the text at that state vector; version numbering by fold order and concurrent proposals; verdicts, submit, withdraw, decide, release, supersede per version on the existing release state machine; contested decisions and settling; agents never approve, reject, release or supersede.
- Property tests for convergence (2 to 5 writers, any order, duplication, partition) and every row of 15.4 and 15.5.
- SECURITY.md and the vendored manifest for Yjs and `lib0` in the same plan that vendors them.

Not in this phase: genesis, roster entries' reducers, invites, join, safety code, X25519 keys, cell keys, wraps, grants, rekey (Phase 31); the replica store on disk, high-water marks in SecretStorage, cross-window lock, legacy ledger import, projections of `.planning/staff/**`, Make a Single-Machine Copy (Phase 31 and 33, drop A); the hub (Phase 32); any transport implementation, the replicator, presence, cursors, the VS Code editor binding, Staff Room UI, sync states and README text (Phase 33); git, LAN and bundle transports (Phase 34); claims, runs, observations and hub watches (Phase 35).
</domain>

<decisions>
## Implementation Decisions

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
</decisions>

<canonical_refs>
## Canonical References

### Design and requirements
- `.planning/research/multiuser-sync/DESIGN.md`: sections 4 (architecture, entry format, kinds, order, equivocation, checkpoints), 5 (co-editing), 6 (versions, contested), 15.4 and 15.5 (state machines), 16 (threats), 17 (test plan, pure core), 18 (WP-R0), 20 (risks), 21 (owner decisions).
- `.planning/research/multiuser-sync/RESEARCH.md`: options, CRDT choice, lessons (Autobase checkpoints, SSB equivocation proofs, Matrix authority at the causal point).
- `.planning/ROADMAP.md`: Phase 30 entry and success criteria; `.planning/REQUIREMENTS.md`: MUS-01..MUS-12.

### Code reused
- `src/domain/team/canonical.ts`, `signedPayload.ts`, `keyStatus.ts`, `validate.ts`: canonical JSON, the signer, key status, validation style.
- `src/domain/staff/release.ts`, `ownership.ts`, `ledger.ts`, `personDecisions.ts`: today's release machine, ownership and single-chain ledgers (unchanged here).
- `src/domain/state/merge.ts`: Phase 27 merge laws (field-level `fork` policy reused later for registers).
- `media/vendor/VENDORED.json`, `src/test/staffCopSymbols.test.ts`, `scripts/vendor-libs.mjs`, `scripts/verify-release-content.mjs`, `scripts/extension-sbom.mjs`: vendoring and hash-check patterns.
- `src/test/teamBoundaries.test.ts`: import boundary test pattern.
</canonical_refs>

<specifics>
## Specific Ideas

- Lead with a tracer slice: two writers each sign and seal one `doc.update`, the fold verifies, orders, merges and produces the same text and digest on both orders. Every later plan widens that slice.
- Canonical vectors file so the hub (Phase 32) can be built against the same bytes without importing extension code.
</specifics>

<deferred>
## Deferred Ideas

- Roster reducers, genesis, invites, keys and migration: Phase 31. Hub: Phase 32. Live layer and UI: Phase 33. Offline transports: Phase 34. Shared runs, observations, hub watches: Phase 35.
- Registers' field-level merge (DESIGN 5.5) is folded when registers move onto the layer (Phase 31 migration and Phase 33); Phase 30 only defines `register.row`'s shape.
- Team Mode (L2) onto this layer; credentials in the roster (Phase 71); hub federation (L5).
</deferred>

## Amendments from research (2026-11-19, made on the owner's behalf; these refine the decisions above and win where they differ)

- **D-31 (refines D-04):** The AES-GCM associated data is the canonical header without `sig` and without `body.hash` (it keeps `body.size`), because `body.hash` is the hash of the ciphertext and cannot be an input to producing it. The design's wording "header without sig" had this circularity.
- **D-32 (refines D-05):** Headers are signed through `signPayload` with purpose `staff-replica` and a constant `signedAt` so the signature is deterministic and a crash-and-retry is never mistaken for equivocation; the key-status lookup in that call is always-active and authority comes only from the `RosterView` at the cited roster hash. Adding the purpose updates `src/test/teamSignedPayload.test.ts`'s purpose list and samples (extended, not weakened).
- **D-33 (refines D-16):** Vendoring uses pinned devDependencies `yjs@13.6.33` and `lib0@0.2.119`, bundled by `scripts/vendor-libs.mjs` into `vendor/yjs/`, with a committed hash manifest checked by a test and by `scripts/verify-release-content.mjs`. `lib0` is 0.2.119, not the 0.2.120 the design names, because 0.2.120 (2026-11-09) is younger than the repo's two-week rule; 0.2.119 satisfies Yjs 13.6.33's range. `doc.ts` loads it with `import type` plus `require`, as `src/mcp/client.ts` loads the MCP bundle. `media/vendor/VENDORED.json` is not touched.
- **D-34 (refines D-23):** `version.propose` carries a Yjs snapshot (state vector plus delete set), not only a state vector, because delete-only edits leave the state vector unchanged.
- **D-35 (refines D-19):** The ownership check also enforces a content-kind allow list (string and deleted content plus GC structs, parent `body` only), a per-client clock rule (no two updates claim one client and clock), size and struct-length caps, and catches any decode or apply error as a rejection.
- **D-36 (refines D-14):** The checkpoint carries `count` and `orderTip` per stream so two checkpoints that disagree about a prefix can be detected.
- **D-37 (choices the design implies, for open points research raised):** 15.5's "declined" is a `decline` outcome on `version.decide`; a joiner treats `doc.compact` as a verified cache (it names what it covers, its state vector and text hash, and is checked against the log when the log is held); concurrent guard `HOLD` and `CLEARED` on one hash keep the version held until a fresh verdict that saw both; supersede concurrent with withdraw is contested; the "about 20 changes" owner prompt counts `doc.update` entries from writers other than the owner since the version (a tunable constant); version pins name `product@hash`.

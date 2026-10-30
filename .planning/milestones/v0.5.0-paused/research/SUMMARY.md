# Project Research Summary

**Project:** NEAR AI for VS Code — milestone v0.5.0 (trusted-source knowledge base)
**Domain:** Analyst-grade, Admiralty-graded intelligence knowledge base inside a privacy-first VS Code extension: claim and source registers, RAFT network, globe, temporal replay, forecasting, and signed end-to-end-encrypted sharing from small teams to organisations
**Researched:** 2026-10-28
**Confidence:** MEDIUM (codebase and npm facts HIGH; crypto/relay design, scale ceilings, and the globe under the webview CSP are unproven and need spikes)

Inputs: STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md, and the owner's brief (`v0.5.0-trusted-source-knowledge-base.md`, which governs where research disagrees). The synthesizer's output was written to disk by the orchestrator; the section on the shipped extension was corrected after the orchestrator checked the claims against the source (see that section).

## Executive Summary

This is an analyst workbench with a hard privacy contract: one signed, encrypted, append-only event log (the source of truth and the temporal record) with disposable materialised views on top — source and claim registers with two-axis Admiralty grades and grade history, a RAFT graph, a globe, a timeline, reports, and forecasts. All four researchers converge on the shape: a new `src/kb/` store (not an extension of `contextGraphStore`), `node:crypto` for primitives, per-compartment symmetric keys wrapped to members (not MLS), one KB webview panel with a strict no-network CSP, and models that only propose grades while the host enforces grades and thresholds in reports. Nearly every table-stakes feature (history, replay, attribution, conflict display, forecast log) is a projection of the log, so the data model, log, and privacy gate come first.

Recommended approach: foundation before features; grading as a deterministic rules layer (agents cannot reach A or 1 alone; independence is computed from origin clusters, not document counts); analysis views as slices of one graph, never copies; sharing and the relay treated as the highest-risk, separately threat-modelled deliverables; everything third-party vendored, with no CDN, no ambient network, and no hosted geocoder or tiles by default.

Main risks, in order: (1) a model or network path that bypasses the TEE-only gate — enforcement today is spread across call sites rather than at one chokepoint; (2) over-generous or circularly corroborated grades; (3) plaintext leakage through surfaces not thought of as storage (activity store, `HANDOFF.json`, exports); (4) key loss or silent key regeneration, and rollback or fork by an untrusted host; (5) cross-compartment leakage through derived data. Each has a named prevention in the phase plan.

## Key Findings

### Recommended Stack (STACK.md)

Built-ins first; everything vendored (esbuild into `vendor/`, SBOM rows, no runtime node_modules).

- **`node:crypto`** — Ed25519, X25519, HKDF, AES-256-GCM, scrypt. Argon2 is absent in Node 22: feature-detect and fall back to scrypt.
- **`age-encryption` 0.3.1** (BSD-3, pre-1.0) — seals compartment keys to member recipients; optional hybrid post-quantum recipients. Pin it behind our own `KeyWrap`/`GroupKeyProvider` interface.
- **Per-compartment key wrapping, not MLS.** `ts-mls` is unaudited per its README, needs ordered commits, and its forward secrecy conflicts with late joiners reading history. MLS stays an upgrade path behind the interface.
- **`sql.js` 1.15.2** as a candidate read model (FTS4 only, no FTS5 or R-tree, 32-bit WASM, roughly 300k claims — an estimate). See D3.
- **Transport:** system `git` via `ProcessRunner`; a zero-dependency relay on `node:http` + SSE + `node:crypto` (Node 24, OCI image, esbuild single file).
- **Globe:** `maplibre-gl` 6.16.0 (globe projection, BSD-3, about 1.7 MB) + `pmtiles` 4.5.0 + a bundled Natural Earth basemap, offline by default, with no `https:` origin in the webview CSP. CesiumJS rejected for now (about 14 MB, ion defaults, needs wasm-unsafe-eval).
- **Network diagram:** `cytoscape` 3.34.4 + `cytoscape-fcose` 2.2.0 (MIT). Not `elkjs` (EPL/GPL) or `cytoscape-svg` (GPL).
- **Gazetteer:** GeoNames `cities15000` (3.2 MB, CC BY) in the VSIX; `cities500` as an optional pack. Candidates with confidence, never a silent first match.
- **Import:** hand-written STIX 2.1 and GeoJSON readers; `papaparse` (CSV, with formula-injection escaping on export); `feedsmith` 3.0.1 with `fast-xml-parser` pinned `>=5.11.2` and DOCTYPE off (two 2026 CVEs).
- **Forecasting:** written in-repo, run in a `worker_thread` — conjugate Bayesian updating, an exponential-kernel Hawkes process fitted by EM, discounted-Beta/Kalman tension trends, Brier/ECE/isotonic calibration. No ML runtime (`tfjs` and `onnxruntime-web` rejected on size and explainability).

### Expected Features (FEATURES.md)

**Must have (table stakes):** two-axis Admiralty grade on every source and claim, stored separately and shown as a pair, with F and 6 as an "unrated" state rather than "worst" (TS1); grade history with evidence, reason, author, and time, including recorded analyst overrides (TS2); a source register and a span-grounded claim register (TS3, TS4); the independent-origin corroboration rule — credibility 1 needs at least two independent origins, echoes collapse to one (TS5); per-project thresholds enforced by the host in reports, with grade and sources on every reported claim, and report export (TS6, TS22); manual and CSV/STIX/GeoJSON import with a mapping preview (TS7); standing feeds into a triage inbox (TS8); entity resolution with human approval and undo (TS9); a RAFT diagram with slices, stable layouts, and edge provenance (TS10–TS12); a globe with per-source layers and offline geocoding with ambiguity handling (TS13, TS14); three timestamps and a timeline scrubber (TS15, TS16); scenario forecasts that are mutually exclusive and exhaustive, sum to 100%, and carry a horizon, resolution criteria, and evidence, with a change log (TS17, TS18); a shared base with signed attribution, visible conflicts, and fingerprint-verified invites (TS19, TS20); TEE-only enforcement on every model path (TS21).

**Should have (differentiators):** agent grade changes shown as an evidence diff with one-click accept (D1); impact analysis when a source is downgraded (D3) and threshold what-if (D4); an echo detector (D5); topic-scoped reliability (D2); an ACH matrix and evidence-contribution view behind forecasts (D7, D8) and a calibration dashboard (D9); linked brushing across views (D12); bitemporal "as known" vs. "as happened" replay (D13); honest key-rotation UX that says what a removed member keeps (D18).

**Defer if scope must be cut:** contradiction detection (D6), tripwires (D14), local-model training claims (D16), tension-trend forecasting beyond simple bands (D10), review workflow beyond the approver role (D17).

**Anti-features to hold the line on:** a single blended confidence score; auto-upgrading reliability from volume; counting echoes as corroboration; silent merges or auto-deleting below-threshold claims; real-time co-editing; cloud geocoding or default online tiles; person-level targeting aids; custom grading scales; promising erasure on member removal.

### Architecture Approach (ARCHITECTURE.md)

The signed, per-compartment-encrypted, append-only log is canonical. A `Materializer` folds it into histories plus pure resolvers (effective grade, current tension); a late entry re-runs one resolver, and "roll time back" is a filter. Views, indexes, and forecasts are disposable. A `LogTransport` interface hides git, folder, and relay. Agents only append attributed, quota-bound proposals through a host API; retract, export, membership, rotation, and threshold edits are host-only, behind the existing fingerprint-approval pattern. TEE-only is enforced once, at the model-client boundary (`TeeGatedClient` from `clientFor`), with a reflection test that fails if a new model method bypasses it.

**Major components:**
1. `src/kb/model` + `src/kb/log` — pure types and resolvers, canonical JSON, HLC, sign/seal, segments, keyring; `vscode`-free.
2. `src/kb/view` — materializer, `ViewStore`, slices, BM25 search, snapshots; partitioned by compartment and era.
3. `src/kb/intake` + `src/agent/kbTools.ts` — one pipeline (sanitize, snapshot, extract, dedupe, default grade F/6, authorise, append) for the agent, import, and feed paths; a new `knowledgeWrite` capability.
4. `src/kb/sovereignty.ts` — `TeeGatedClient`, forced per-project TEE mode, marker integrity (globalState authoritative).
5. `src/kb/report`, `src/kb/forecast`, `src/kb/geo` — report builder and verifier; local forecast worker and TEE scenario generator sharing one calibration layer; gazetteer and tile protocol.
6. `src/services/kbView.ts` + `media/kb/` — one webview panel (network, globe, timeline, reports, access) fed by capped, host-built DTOs over a validated bridge.
7. `src/relay/` — a standalone ciphertext relay sharing the log-validation code; a separate, security-critical deliverable.

### Critical Pitfalls (PITFALLS.md)

1. **Egress bypass of the TEE gate (P-01, P-02).** One fail-closed chokepoint, a destination allowlist, default-off egress classes, and network-spy behaviour tests in every phase that adds an egress path.
2. **Over-generous or circular grades (P-04).** Reliability from in-base track record plus analyst priors; credibility from evidence links; independence computed in code from origin clusters; caps (no agent A or 1, one step per revision, no-op revisions emit nothing); a 36-grade table test; reports render grades from records and fail on mismatch.
3. **Plaintext leakage and stored injection (P-06, P-03).** A data-flow inventory in the first phase; id-only logging and KB redaction; a canary-string leak scan in every phase; taint and re-fencing on every read into a prompt; host-verified quote spans and a quarantine inbox.
4. **Integrity and key handling for shared logs (P-08–P-10, P-12).** One writer per file; hash chains with version vectors; device-local high-water marks; signed membership validated by every client at the roster as of each entry; a "removal pending rotation" state; keys fail loud and are never regenerated, with a forced recovery export; fault-injection tests.
5. **Compartment leaks through derived data (P-16) and role confusion (P-17).** Labels on every record from the first data model, a single `LabelledStore`, reader-relative computation, approver-gated downgrades, and a two-compartment indistinguishability test as the acceptance criterion. Reads are keys; writes and approvals are signatures verified by all clients.
6. **Authoritative-looking forecasts (P-20) and temporal leakage (P-19).** The number comes from an auditable method with n, interval, and evidence; the LLM proposes scenarios and writes the explanation, never the displayed probability; "insufficient basis" below a minimum; backtesting on as-known time only.

## Disagreements between researchers, and recommendations

| # | Question | Positions | Recommendation |
|---|---|---|---|
| D1 | Log layout | STACK: one immutable content-hash-named file per event. ARCH: per-author sealed segments from a local encrypted WAL. PITFALLS: segments, opaque names, one writer per file; per-event files are slow in git (P-14) and leak counts and sizes (P-07). | **Per-author sealed immutable segments** with opaque names and a local encrypted WAL. Keep from STACK: content-hash naming, per-segment HKDF subkeys, HLC, signature inside the ciphertext. Add a hash chain and version-vector commitments (P-09). |
| D2 | Does the relay see roles? | STACK: cleartext membership and roles so the relay enforces. ARCH: a relay-readable directory with an `entryClass` header. PITFALLS (P-15): the relay should not know roles; use signed capability tokens; clients re-validate everything. | **The relay sees pseudonymous key ids, opaque compartment ids, and signed capability tokens, not role names.** Admins sign short-lived per-stream append capabilities under the membership log, which still meets "enforces who may append". Names and role semantics live in the encrypted admin compartment. Residual metadata goes in the threat model. Needs relay-phase research and a security review. |
| D3 | Local store | STACK: `sql.js` read model. ARCH: in-memory typed indexes plus encrypted partitioned snapshots, no client SQLite. PITFALLS: no WASM SQLite without a spike; a single `sql.js` DB would mix compartments under one key. | **Log canonical; read side behind a `ViewStore` interface.** Start with in-memory indexes partitioned by compartment and era; run a measured bake-off against `sql.js` (one DB per compartment) in the store phase. `node:sqlite` stays rejected on the client. |
| D4 | Globe library | STACK and ARCH: MapLibre. PITFALLS: spike MapLibre vs. Cesium. | **MapLibre 6.x by default**, with a scoped spike at the start of the globe phase: worker under CSP, PMTiles range reads via host messaging, a zero-third-party-request trace, a 2D fallback without WebGL. Cesium only if the spike fails or terrain/3D Tiles are required. |
| D5 | Scale ceiling | All estimates (about 300k claims on `sql.js` or in memory; 1–2M needs disk). | **Treat as unmeasured.** The first store-phase deliverable is a synthetic benchmark (100k, 300k, 1M entries: open, fold, verify, slice, snapshot, memory) with explicit budgets, gated by the owner's volume figure. |
| D6 | Key sealing | STACK: `age-encryption`. ARCH: hand-rolled ECIES. PITFALLS: no bespoke constructions. | **`age-encryption` behind `KeyWrap`**, confirmed by a size and Node 22 spike; hand-rolled ECIES only as a fallback. |
| D7 | When compartments land | PITFALLS: in the first data model. ARCH: in a later org phase. | **Both:** the fields and a single default compartment exist from the first phase; multi-compartment UX, roles, approvals, and no-write-down ship in the org phase. |
| D8 | Gazetteer size | STACK: ship `cities15000`. ARCH: `cities500`-class. | Ship `cities15000`; offer `cities500` as an optional pack with a pinned hash. |
| D9 | Imported grades | All agree. | Imported STIX confidence is a hint, never a grade. Export emits MISP `admiralty-scale` tags. |
| D10 | Timestamps | Brief: three. ARCH adds HLC `recordedAt`; PITFALLS adds `ingestedAt`. | `occurredAt` (an interval with precision), `reportedAt`, `gradedAt` per grade entry, and HLC `recordedAt`; `ingestedAt` device-local only. |
| D11 | Naming | The brief uses "events" for both world happenings and log records. | Log records are `KbEntry`; world happenings are `Occurrence`. |

## Findings about the shipped extension

The researchers reported weaknesses in the extension as shipped in 0.4.x. The orchestrator checked S1 and S2 against the source on 2026-10-28 and found them overstated; the rest are as reported and were not independently re-checked.

| # | Finding | Status after checking |
|---|---|---|
| S1 | "Attachments, image generation, and compaction bypass `OutboundGuard`." | **Overstated.** In TEE-only mode the sidebar blocks a send when the vision or transcription model that would read an attachment is not TEE (`chat.ts` around line 512); the agent's image tool only receives a model at least as private as the main model, which passed the guard; compaction uses the run's own model. **What is true:** enforcement is spread across call sites rather than one chokepoint, and the legacy `GenerationService` builds its `PrivacyPreflight` without the user's privacy mode (`chat.ts` `getGenerationService`). Nothing in the current UI sends it a request, so it is unreachable dead code with a latent flaw — remove or gate it. The KB's client-boundary gate addresses the structural point. |
| S2 | "Sub-agents are TEE only if the main model is TEE." | **By design.** Sub-agents are limited to models as private as the main model, which passed the guard. In KB projects the gate will force TEE regardless of the main model. |
| S3 | `contextGraphStore.load()` swallows any error and substitutes an empty ledger; the next `persist()` overwrites the file; it rewrites the whole file with no write queue. | As reported. The KB store must not copy this pattern; worth fixing for project memory. |
| S4 | Project-memory export writes plaintext `near-ai-memory.json` into the workspace root by default. | As reported. |
| S5 | The spend limit is checked per message, not between turns of one run. | Partly: one run is capped at the per-run cost and what is left of the daily limit, checked before every model turn (0.4.0). Background and scheduled work in the KB needs the same between-turn budget. |
| S6 | The Agent Activity store and `HANDOFF.json` are plaintext; activity redaction removes secrets only. | As reported. KB projects need a redaction hook so claim text and entity names never reach these surfaces. |
| S7 | The agent shell inherits most of the environment, and the sensitive-file guard does not cover shell arguments. | Credential-like variables are already removed (0.4.0); the shell-argument point stands. |
| S8 | `retainContextWhenHidden: true` on the sidebar and Tools panel. | As reported; the KB panel should not set it. |
| S9 | Source-regex tests have passed for features that did not run. | Addressed by the milestone-2 rule that tests must drive the real path; keep it as a convention. |

**Recommendation:** no urgent patch is needed. Fold S1 (single client-boundary gate, remove or gate the legacy generation path), S3, S5 (background budgets), and S6 (redaction hook) into the first KB phase, since the KB depends on them; S4, S7, and S8 are cheap and can ride along.

## Implications for Roadmap

The researchers used different phase vocabularies (FEATURES: 8 layers; ARCHITECTURE: 10 phases; PITFALLS: F1–F9). Reconciled order — the hard dependency chain is model and log → store → intake and grading → views, with sharing as its own chain:

1. **Foundations and hardening** — `src/kb/model` and `log` (canonical JSON, HLC, sign/seal, segments, single-compartment keyring); KB project flag with marker integrity; `TeeGatedClient`, forced TEE-only, reflection test; egress allowlist; member seed and recovery export (fail loud, never regenerate); data-flow inventory, canary leak harness, synthetic fixtures; the shipped-extension items above. Compartment labels, epochs, HLC, `prev` hashes, version field, erasure design, and bitemporal fields are fixed here.
2. **Materializer and local store** — histories and pure resolvers; `ViewStore` bake-off; local encrypted snapshots; BM25 slice queries and time index; worker execution and load budgets; KB project creation.
3. **Intake, registers, agent tools** — source and claim registers with host-verified quote spans and snapshots; manual entry; CSV/STIX/GeoJSON import with preview and retractable batches; offline gazetteer; `kbTools` and `knowledgeWrite`; fenced slice preamble and a quarantine inbox; reversible entity-link candidates.
4. **Grading, thresholds, reports** — the Admiralty engine (caps, origin clusters, independence, unrated state, idempotent revisions); grade history and agent proposals as evidence diffs; `ThresholdPolicy`, `ReportBuilder`, `ReportVerifier`, extended `CheckCitations`; report export; what-if and impact analysis.
5. **KB panel, RAFT network, slices** — one panel (no `retainContextWhenHidden`), capped DTOs and a validated bridge; Cytoscape RAFT view with stable layout and edge provenance; slices as saved queries; slice-scoped agent runs; table view for accessibility.
6. **Standing feeds and unattended runs** — RSS, MCP feed bindings, watched folders; triage inbox and dedupe; jittered polling, per-feed opt-in; between-turn budgets; regrade scheduler; emergency stop covering background work.
7. **Team sync (git/folder), membership, rotation** — `LogTransport` with git and folder transports; sync engine with quarantine; signed membership chain; invite by key with fingerprint check; removal pending rotation; convergence, rollback/fork alarms, version gate, conflict display.
8. **Organisation layer** — multiple compartments, roles (reader, analyst, approver, admin), approval-required entry classes, roster validation, no-write-down for agent runs, per-compartment signed snapshots, Access UI, join with or without history.
9. **Relay** — `src/relay/` with capability-token append checks, SSE, snapshots, quotas; `RelayTransport`; OCI image with SBOM and signature; threat model and malicious-relay harness; git-to-relay migration test.
10. **Globe, timeline, replay** — the MapLibre spike gate; bundled basemap and per-source layers; optional online imagery behind consent; timeline scrubber; world-time vs. knowledge-time replay; linked brushing. Independent of 7–9; can move earlier.
11. **Prediction** — local forecaster worker and TEE scenario generator; shared calibration; forecast and resolution entries; evidence view and reliability diagram; "insufficient basis".
12. **Hardening and release** — canary scans over every writable location, a network-spy sweep of all KB flows, an org-scale load test, accessibility review, honest threat-model copy.

**Research flags (plan with phase research):** 1 (envelope, `age-encryption` under Node 22, SecretStorage on Linux/WSL/containers/code-server, TEE embedding model availability), 2 (store benchmark), 4 (independence heuristics, grader gold set), 7 (git edge cases), 8 (approval classes, two-person rule, join-history policy), 9 (relay protocol and security review), 10 (globe spike, NASA GIBS terms), 11 (forecast methods, calibration minimums). Standard patterns: 3 (importers; needs a STIX mapping table), 5, 6, 12.

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| Stack | MEDIUM-HIGH | npm facts read 2026-10-28; sql.js wasm inspected. MapLibre worker and PMTiles under the webview CSP, and `age-encryption` in the host, are unverified. |
| Features | MEDIUM | Admiralty semantics HIGH; comparable tools MEDIUM; RAFT definition LOW (the brief governs); no doctrinal thresholds exist. |
| Architecture | MEDIUM-HIGH | Integration points read from source; protocol design and scale numbers reasoned, not measured. |
| Pitfalls | MEDIUM | Codebase observations HIGH (two overstated, corrected above); external citations mostly search digests. |

**Overall:** MEDIUM.

### Gaps to address

- Volume and scale: no figure in the brief; all ceilings are estimates. Get the owner's number, then benchmark in phase 2.
- Relay design: capability tokens, tree heads, and metadata exposure are design-level only.
- Globe under CSP: MapLibre 6 worker loading, PMTiles via host messaging, and a zero-network proof are unverified.
- `age-encryption`: size, Node 22 behaviour, hybrid PQ wrap size.
- Embeddings: no known TEE-attested embedding model; baseline is lexical/BM25. Confirm the catalog.
- SecretStorage: weak or absent on some Linux, WSL, container, and code-server setups; this defines the recovery-export UX.
- STIX confidence mapping, NASA GIBS terms, GeoNames licence wording: read the primary sources.
- Independence detection: needs a labelled copy-chain fixture.
- `node:sqlite` on the relay image: unconfirmed (fall back to files).
- Re-verify before relying on them: ICD 203 band values, fast-xml-parser CVE ranges, Cesium CSP friction.

## Product decisions the owner still has to make

| # | Decision | Blocks | Researchers' default |
|---|---|---|---|
| 1 | Expected data volume and load-time budget | Phase 2 | Fixtures: 300k claims (small team), 1M entries (organisation). |
| 2 | Local LLM runtimes in KB projects | Phase 1 | Refuse by default (TEE-attested only); the local statistical forecaster is not an LLM. |
| 3 | Online imagery at all | Phase 10 | Off by default; consent text says the provider sees the area; prefer a one-time global overview download. |
| 4 | Web search/fetch from KB runs (the provider sees the topic) | Phases 1, 3, 6 | Per-project switch, default off for sensitive projects. |
| 5 | Plaintext surfaces in KB projects (Agent Activity, `HANDOFF.json`, `.planning/` reports, memory export, transcripts) | Phases 1, 12 | Redact or encrypt; no claim text or entity names in plaintext. |
| 6 | Export formats and handling | Phases 4, 5 | Encrypted by default; carry grade, threshold, and highest compartment label. |
| 7 | Relay deployment and identity (container vs. npm, hosting, SSO/directory binding) | Phase 9 | OCI image; invites verified by fingerprint, optional directory binding. |
| 8 | Erasure design (crypto-shredding vs. admin-signed rebase) | Phase 1 | Decide before the envelope is frozen. |
| 9 | Post-quantum recipients | Phases 1, 8 | Optional org policy, not the default. |
| 10 | Grading rules (multi-source thresholds, F/6, default thresholds, topic-scoped reliability) | Phases 1, 4 | Best independent origin, show all; F/6 unrated with include/exclude/flag; topic-scoped from the start. |
| 11 | Roles beyond reader/analyst/approver; two-person rule; admin-key recovery | Phase 8 | Add admin and owner; two-person rule for downgrades; m-of-n recovery. |
| 12 | Relay visibility of roles; padding and batching | Phase 9 | Capability tokens; padded sizes, jittered batching. |
| 13 | New members' history access | Phase 8 | From join epoch by default; earlier history is an explicit, logged grant. |
| 14 | Cross-compartment references and moves | Phase 8 | Reference only inside the more restricted entry; downgrade is an approver-signed new entry. |
| 15 | Embeddings | Phases 1, 3 | Lexical/BM25 baseline; gated embeddings later, vectors never synced. |
| 16 | Meaning of "train on TEE" | Phase 11 | In-context scenario generation through the local calibration layer, labelled uncalibrated until scored. |
| 17 | Person-level targeting as an explicit non-goal | Phases 3, 6 | Out of scope in product copy and policy. |
| 18 | 2D fallback without a GPU | Phase 10 | Yes, with a table view. |

## Sources

**Primary (HIGH):** repository source and planning files; npm registry (`npm view`/`npm pack`, 2026-10-28) and the sql.js wasm inspection; OSM tile usage policy; Fowler, *Bitemporal History*; OpenCTI reliability/confidence docs; ACLED methodology; GeoNames dump listing.

**Secondary (MEDIUM):** Admiralty summaries and practitioner guides; ICD 203 via digests; Maltego, Gephi, i2, Palantir docs; MapLibre changelog and globe roadmap; Cesium offline guide; Cytoscape WebGL post; untrusted-storage and fork-consistency literature; RFC 9162, RFC 9420, and the MLS inactive-member analysis; git-crypt limitations; LLM overconfidence and judge-injection papers; embedding inversion (Morris et al.); superforecasting and Brier sources.

**Tertiary (LOW, validate):** the RAFT definition (the brief governs); the Cesium CSP thread; vendor graph-library scale claims; `ts-mls` interop status; hybrid PQ wrap size; SecretStorage behaviour on Linux and remote hosts; JS signature-verification throughput.

---
*Research completed: 2026-10-28*
*Ready for roadmap: yes*

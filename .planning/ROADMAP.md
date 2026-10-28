# Roadmap: Near AI for VSCode

## Milestones

- Milestone 1: Phases 1-6 (SHIPPED)
- **v0.4.0 A working core and a native NEAR agent runner**: Phases 7-12 (SHIPPED; latest release before v0.5.0 is 0.4.1)
- **v0.5.0 Trusted-source knowledge base**: Phases 13-24 (in progress)

## Phases

**Phase numbering:** integer phases continue across milestones (v0.5.0 starts at 13). Decimal phases (13.1) are urgent insertions and run between their neighbours.

- [ ] **Phase 13: Sovereignty gate, post-quantum cryptography, and the encrypted event log** - TEE-or-local-only knowledge-base projects, hybrid post-quantum keys, and a signed, encrypted, append-only log
- [ ] **Phase 14: Encrypted scalable store and search** - several-million-entry base on a disk-backed encrypted index, corruption quarantine, keyword and semantic search
- [ ] **Phase 15: Source and claim intake with agent tools** - agents, analysts, and imports add quote-verified sources and claims; untrusted-on-read; offline geocoding
- [ ] **Phase 16: Admiralty grading, thresholds, and reports** - A-F / 1-6 grades with strict agent rules, evidence diffs, thresholds, and reports rendered from the base
- [ ] **Phase 17: RAFT network and slices** - Actors, Relationships, Functions, and Tensions as a network diagram, saved slices, slice-scoped agent runs
- [ ] **Phase 18: Standing feeds, unattended work, and alerts** - RSS/MCP/folder feeds into a triage inbox, spending limits for background work, tripwires
- [ ] **Phase 19: Team sharing through git or a shared folder** - signed end-to-end encrypted sync, invites by key, rotation on removal, visible conflicts
- [ ] **Phase 20: Organisation compartments, roles, and access** - need-to-know compartments with their own keys, roles, Access view, signed snapshots
- [ ] **Phase 21: Ciphertext relay** - an organisation-hosted relay that sees only ciphertext, plus git-to-relay migration
- [ ] **Phase 22: Globe, imagery, and timeline replay** - open-source 3D globe with layers, optional imagery, replay of how events unfolded
- [ ] **Phase 23: Forecasting and calibration** - auditable scenario forecasts and tension trends, local or TEE, scored and recalibrated
- [ ] **Phase 24: End-to-end hardening and release** - allowlist and plaintext proofs across every flow, scale and accessibility checks, honest copy, 0.5.0 candidate

## Milestone v0.5.0: Trusted-source knowledge base

**Milestone goal:** Give research teams a private, self-improving knowledge base of graded sources and the intelligence collated from them, which augments agents with strategic, operational, and tactical context and shows it as a network, on a globe, over time, and as probabilistic forecasts. Core value: analysts get graded, sourced intelligence that agents keep current, without any of it leaving the TEE, the machine, or the team's control.

**Inputs:** `.planning/REQUIREMENTS.md` (55 requirements), `.planning/research/v0.5.0-trusted-source-knowledge-base.md` (the owner's brief; it governs), `.planning/research/SUMMARY.md` (reconciled order and research flags).

**Ground rules for this milestone:**
- A phase is complete only when each success criterion is proven by a test that drives the real path (the host message path, a command, or the real model client). Source-text tests do not count as evidence.
- Every phase that adds a network destination registers it on the project's declared allowlist and extends the network-spy test. Every phase that adds a place where data is written extends the canary leak scan. Phase 24 proves both across all flows (SOV-04).
- From Phase 20 on, every new derived view (search, slices, globe, timeline, forecasts) is computed reader-relative and extends the two-compartment indistinguishability test.
- The compartment label, key epoch, hybrid post-quantum signatures, and erasable-item keys exist from the first release of the log (Phase 13), even though multiple compartments are offered only in Phase 20.
- Third-party code is vendored and listed in the SBOM, with no CDN and no ambient network. Models only propose grades; the host enforces grades and thresholds.

**Order notes (where this roadmap departs from the research summary's reconciled order):**
- The Knowledge Base panel shell and the registers move from the RAFT phase to Phase 15, because grading, evidence diffs, and the triage inbox need a surface before the diagram exists.
- Semantic search sits in Phase 14 with the store, because the vector index has to be sized in the same scale benchmark.
- The offline gazetteer (GEO-01) sits in Phase 15 with intake, because geography slices in Phase 17 depend on it.
- Of the shipped-extension fixes in the summary, the legacy generation path and the single model-client gate (S1) and the plaintext surfaces (S6) land in Phase 13; the silent empty-ledger fallback in project memory (S3) lands in Phase 14 with the quarantine work; between-turn budgets for background work (S5) land in Phase 18 where background work first exists. S4, S7 ride along in Phase 13.
- The sharing chain (Phases 19-21) depends on grading (Phase 16) but not on Phases 17-18, and the globe and timeline (Phase 22) depend only on Phase 17, so either chain can be pulled earlier if the owner's priorities change. The ground rule on reader-relative views then applies to whichever lands second.

### Phase 13: Sovereignty gate, post-quantum cryptography, and the encrypted event log
**Goal**: A user can create a knowledge-base project whose every model call is confined to TEE-attested or local models and whose changes are written to a signed, encrypted, append-only log protected by hybrid post-quantum cryptography, with keys that are never silently lost or regenerated.
**Depends on**: Nothing (first phase of this milestone; builds on the shipped 0.4.x extension)
**Requirements**: SOV-01, SOV-02, SOV-03, SOV-05, SOV-06, LOG-01, LOG-02, LOG-03, LOG-04, PQC-01, PQC-02, PQC-03
**Scope**: Everything later rests on choices that cannot change once data exists, so they are fixed here: the entry envelope (version field, compartment label, key epoch, hybrid-logical-clock `recordedAt`, `occurredAt` as an interval with precision, `reportedAt`, `gradedAt`, `prev` hash chain), sealed segments signed per segment (or by a hash tree over segments) rather than per entry, a per-item key for erasable items, and a single-compartment keyring. The project mode lives in a tamper-resistant place (globalState authoritative, workspace marker advisory). `TeeGatedClient` wraps the model client so the TEE-or-local rule is enforced once, at the boundary, for every call class, with a reflection test; the legacy generation service is removed or made to honour the privacy mode. The declared-destination allowlist and network-spy harness are built here for NEAR, local runtimes, and search; later phases register their own destinations and Phase 24 closes SOV-04 against all of them. Transcripts, handoffs, and Agent Activity get a knowledge-base redaction hook. A reference fold of the log gives current state, history, and "as known at time T"; Phase 14 makes it scale. Ride-along fixes (not requirements): the plaintext project-memory export (S4) and shell-argument exposure (S7).
**Success Criteria** (what must be TRUE):
  1. A user creates a knowledge-base project with one command and the project shows it is "TEE or local only". Editing or deleting the workspace marker, by hand or by an agent, does not downgrade it. Web search and fetch are a per-project switch, on by default, with text saying the search provider sees the topics researched; turning it off removes both from agent runs. (SOV-01, SOV-03)
  2. In a knowledge-base project, every model call type (main agent, sub-agents, attachments, image generation, compaction, embeddings, extraction, grading, forecasting) reaches only a NEAR TEE-attested model or a local runtime labelled "local". A forwarded model is refused at the client boundary with a clear reason, and a reflection test over the real client fails if any model-calling method skips the gate. No generation path ignores the privacy mode. (SOV-02, SOV-06)
  3. After a run that reads and discusses a canary claim, no plaintext copy of the canary exists in transcripts, handoff files, Agent Activity, `.planning/`, logs, or the project-memory export: transcripts and handoffs are encrypted and Agent Activity shows ids and counts only. (SOV-05)
  4. Every change to a base is an attributed entry, carrying its four timestamps, compartment label, and key epoch, appended to an encrypted log that is never rewritten. Segments are sealed with AES-256-GCM and hybrid Ed25519 + ML-DSA signed; folding the log yields current state, history, and the base as it was known at any past time; a tampered, reordered, truncated, or forked log is detected and reported with what failed. (LOG-01, LOG-02, LOG-03, LOG-04)
  5. Key wraps use hybrid ML-KEM-768 + X25519 and signatures (segments, membership, capability tokens) are hybrid classical + ML-DSA, from a vetted implementation running on Node 22. Creating an identity forces a recovery export; if the key cannot be read from SecretStorage the base stays locked with a clear message and no new key is generated. Erasing an item destroys its key so it is unreadable while the log still verifies, and the UI says copies already read are not recalled. (PQC-01, PQC-02, PQC-03)
**Research flags**: (1) Post-quantum library audit: audit status, Node 22 behaviour, bundle size, constant-time claims, and verification throughput of pure-JS ML-KEM-768 and ML-DSA candidates (e.g. the noble post-quantum family), and whether `age-encryption`'s hybrid recipients match the owner's ML-KEM-768 + X25519 choice, behind our own `KeyWrap` interface; decide per-segment signature versus hash tree given ML-DSA signatures of about 3.3 KB. (2) SecretStorage on Linux, WSL, containers, and code-server, which defines the recovery-export experience when no keyring exists. (3) Envelope freeze review before any code depends on it: erasure-key granularity and storage, hash chain with version vectors, HLC. (4) Data-flow inventory of every plaintext surface (Agent Activity, `HANDOFF.json`, transcripts, memory export, `.planning/`) before redaction work. (5) Confirm in the live NEAR catalog that `Qwen/Qwen3-Embedding-0.6B` and the reranker are attested (used from Phase 14).
**Plans**: TBD (plan-phase may split into a sovereignty-gate wave and a crypto-and-log wave)

### Phase 14: Encrypted scalable store and search
**Goal**: A knowledge base of several million entries opens, filters, slices, and is searchable by keyword and by meaning within measured budgets from a disk-backed encrypted index, and damaged data is reported instead of hidden.
**Depends on**: Phase 13
**Requirements**: STORE-01, STORE-02, SRCH-01
**Scope**: The first deliverable is a repeatable synthetic benchmark (100k, 1M, and several-million-entry bases; open, fold, verify, slice, snapshot, search, memory ceiling) that sets the budgets. A `ViewStore` interface hides the read side; the bake-off compares a purpose-built encrypted, partitioned (by compartment and era) index against `sql.js` per partition (32-bit WASM, so only viable for small partitions) before one is chosen. A materializer folds the log into histories and pure resolvers; local encrypted snapshots mean reopening does not replay history; indexing runs off the extension-host thread. Semantic search embeds through the Phase 13 gate with a TEE-attested model (e.g. `Qwen/Qwen3-Embedding-0.6B`, optional reranker) or a local one; vectors are quantised, partitioned, encrypted at rest, local-only, and combined with lexical ranking. The agent-facing search tool ships with the fenced read path in Phase 15. Ride-along (not a requirement): fix project memory's silent empty-ledger fallback (S3) with the same quarantine code.
**Success Criteria** (what must be TRUE):
  1. A synthetic base of several million entries opens, filters by time, type, and compartment, and slices within the budgets this phase records, shown by a repeatable benchmark covering open, fold, verify, slice, snapshot, search, and memory ceiling; a second open uses local snapshots instead of replaying the whole history. (STORE-01)
  2. After a run on a canary-seeded base, a scan of everything the extension wrote to disk finds no plaintext: not entries, index terms, snapshots, or embeddings. (STORE-01)
  3. Flipping bytes in a partition, snapshot, or log segment, or opening with the wrong key, produces a visible report naming what was damaged and quarantines it. The base is rebuilt from the log when possible or stays locked, and is never replaced by an empty base; deleting the index and reopening rebuilds it. (STORE-02)
  4. A user searches the base by keyword and by meaning from a command; a paraphrase query finds a seeded entry that shares no keywords with it; the embedding call reaches only a TEE-attested or local model and a forwarded embedding model is refused. (SRCH-01)
**Research flags**: (1) Store benchmark and bake-off, gated by the owner's volume (several million entries and more); define cold-open, slice, search, and RAM budgets from the first run. (2) Vector index at scale: 1024-dimension embeddings times millions means quantisation or approximate search and a disk budget; confirm the embedding model and reranker in the live catalog and name the local fallback. (3) `node:sqlite` stays rejected on the client; confirm `sql.js` limits on the target extension host. (4) Worker-thread memory behaviour inside the extension host.
**Plans**: TBD

### Phase 15: Source and claim intake with agent tools
**Goal**: Agents and analysts can put sources and quote-verified claims into the base through one intake path (research runs, by hand, or CSV/STIX/GeoJSON import), stored text is treated as untrusted whenever it is read into an agent's context, and place names are geocoded on the machine.
**Depends on**: Phase 14
**Requirements**: INTAKE-01, INTAKE-02, INTAKE-03, INTAKE-04, INTAKE-05, GEO-01
**Scope**: Introduces the Knowledge Base panel: one webview with a strict no-network CSP, no `retainContextWhenHidden`, capped host-built DTOs over a validated message bridge, with source and claim registers and a proposals queue. Agent tools (`src/agent/kbTools.ts`) and a new `knowledgeWrite` capability let agents add sources and claims as proposals only; the host stores a snapshot of each source and verifies every quoted span against it; new items default to unrated (F/6). One intake pipeline (sanitise, snapshot, extract, dedupe, default grade, authorise, append) serves agents, imports, and later feeds. An analyst can set a grade by hand as a recorded grade entry (author, reason, time); the grading engine and its rules arrive in Phase 16. Importers are hand-written for STIX 2.1 and GeoJSON, with `papaparse` for CSV (formula-injection escaping on export), a mapping preview, and batch retraction. Stored text is re-fenced as untrusted on every read into a prompt, including agent search results. Duplicate actors, places, and claims become proposed links with undo. A bundled GeoNames `cities15000` gazetteer (CC BY; `cities500` as an optional pack with a pinned hash) returns ranked candidates. Person-level targeting aids are stated as a non-goal in policy copy.
**Success Criteria** (what must be TRUE):
  1. During a research run in a knowledge-base project, the sources an agent read and the claims it extracted appear in the Knowledge Base panel as proposals, each claim showing a quote the host verified against the stored snapshot of its source; a claim whose quote is not in the snapshot is rejected into quarantine; findings are recorded in the base, not in `.planning/` files; new items are unrated (F/6). (INTAKE-01)
  2. An analyst adds a source and a claim by hand in the panel and can set or override a grade, which is recorded with author, reason, and time. (INTAKE-02)
  3. An analyst imports CSV, STIX 2.1, and GeoJSON files, sees a mapping preview before anything is written, sees imported confidence values labelled as hints rather than grades, and can retract the whole import as one batch; malformed input is reported, not half-applied. (INTAKE-03)
  4. A stored claim or imported text containing instructions reaches an agent only inside the untrusted fence, and a tool action it asks for still goes through the normal approval gate; this holds for agent search results as well as direct reads. (INTAKE-04)
  5. Possible duplicate actors, places, and claims are listed as proposed links the analyst accepts or undoes, and nothing is merged silently. A place name is geocoded from the bundled gazetteer on the machine, an ambiguous name shows ranked candidates for the analyst to choose, and a network trace shows no geocoding request. (INTAKE-05, GEO-01)
**UI hint**: yes
**Research flags**: Standard patterns, with these to settle: the STIX 2.1 mapping table (which objects become sources, claims, actors, relationships; confidence as hint only); GeoNames licence and attribution wording; snapshot storage (size, dedupe, interaction with per-item erasure keys); quote-span normalisation; reuse of the v0.4.0 untrusted-content fencing and injection detection.
**Plans**: TBD

### Phase 16: Admiralty grading, thresholds, and reports
**Goal**: Every source and claim carries a NATO Admiralty grade that agents propose and keep revising under strict rules, and every research report shows only what the project's thresholds allow, with grades and sources rendered from the base.
**Depends on**: Phase 15
**Requirements**: GRADE-01, GRADE-02, GRADE-03, GRADE-04, GRADE-05, GRADE-06, RPT-01, RPT-02, RPT-03, RPT-04
**Scope**: The grading engine is a deterministic rules layer over the log, not a model. Reliability and credibility are stored separately and shown as a pair; F and 6 are an "unrated" state. Independence is computed in code from origin clusters, so copies of one origin count once (echo detection). Caps: agents never assign A or 1 alone, move one step per revision, and emit nothing for a no-op revision. Reliability can be scoped by topic. Agent proposals are shown as evidence diffs with one-action accept or reject; every change keeps evidence, reason, author, and time, and analyst overrides are recorded the same way. Contradictions are flagged for review. `ThresholdPolicy` judges a claim by its best independent origin and excludes or marks unconfirmed per the setting. `ReportBuilder` renders grades and sources from records; `ReportVerifier` fails a report whose grades differ from the base, and the existing citation check is extended. Impact analysis shows what changes when a source is downgraded or a threshold moves; the forecast part of that impact is added in Phase 23. Export is encrypted by default and carries grades, threshold, and compartment label (MISP `admiralty-scale` tags on export).
**Success Criteria** (what must be TRUE):
  1. Each source shows a reliability grade A-F and each claim a credibility grade 1-6, together as a pair such as "B2". F and 6 display as "unrated" rather than worst and never pass a numeric threshold. A source can be reliable on one topic and not another, and the claim view shows which topic-scoped grade applied. (GRADE-01, GRADE-04)
  2. When new information confirms or contradicts a claim, an agent proposes a grade change that the analyst sees as an evidence diff (what changed, the evidence, the reason) and accepts or rejects in one action. Each change in the history keeps its evidence, reason, author, and time, an analyst override is recorded the same way, and re-proposing an unchanged grade creates nothing. (GRADE-02, GRADE-05)
  3. Credibility 1 cannot be reached without two independent origins: three copies of one wire story count once and are shown as an echo. An agent alone can never assign A or 1. Contradicting claims are flagged for review. (GRADE-03, GRADE-06)
  4. An analyst sets a project's minimum reliability and credibility; a claim is judged by its best independent origin; below-threshold and unrated claims are excluded or marked unconfirmed per the setting. Every claim in a report shows its grade and sources, rendered from the base, and a report edited so its grades disagree with the base fails verification. (RPT-01, RPT-02)
  5. Downgrading a source shows which claims and reports change, and changing a threshold previews its effect before it is applied. Exporting a report or slice is encrypted by default and carries its grades, threshold, and compartment label. (RPT-03, RPT-04)
**UI hint**: yes
**Research flags**: (1) Independence heuristics: needs a labelled copy-chain fixture for echo detection; wire-story, quote-chain, and shared-author cases. (2) A grader gold set to measure agent proposals against analyst grades. (3) A table test over all 36 grade combinations. (4) Default thresholds (no doctrinal values exist; the brief's rule is best independent origin with F/6 unrated). (5) Re-verify ICD 203 band values quoted in the research. (6) Export formats and handling, and where reports are viewed without writing plaintext (SOV-05).
**Plans**: TBD

### Phase 17: RAFT network and slices
**Goal**: Analysts see the situation as a professional RAFT network diagram (Relationships, Actors, Functions, Tensions) and cut it into saved slices that agents can work within.
**Depends on**: Phase 16
**Requirements**: RAFT-01, RAFT-02, RAFT-03
**Scope**: Actors, relationships, functions, and tensions (positive, negative, or neutral, with relative strength) are log entries linked to the claims that support them; agents and analysts propose them through the Phase 15 pipeline and a pure resolver computes the current tension. The panel renders a Cytoscape diagram with fCoSE layout, persisted so it is stable between sessions, and an edge-provenance view listing the supporting claims with their grades and sources. Slices are saved queries over geography (using Phase 15 geocodes), time window, topic, and set of actors. A slice-scoped agent run gets only the slice as context and cannot read or write outside it. The diagram always shows a capped slice with a truncation notice, never millions of nodes. Every diagram and slice has a table view.
**Success Criteria** (what must be TRUE):
  1. An analyst opens the RAFT view and sees actors as nodes, relationships as edges marked by tension (positive, negative, neutral) and strength, and each actor's functions; selecting an edge lists the claims behind it with their grades and sources; reopening the view gives the same layout. (RAFT-01)
  2. An analyst slices the base by geography, time window, topic, or set of actors, saves the slice, and reopens it later; a slice cut from a very large base loads within the recorded budget and says when it was capped. (RAFT-02)
  3. A research run started on a slice sees only that slice: a canary entry outside the slice never reaches the agent's context or tool results, and anything the agent proposes carries the slice it worked in. (RAFT-02)
  4. Every diagram and slice has a table view with the same nodes, edges, tensions, and provenance, reachable by keyboard and announced correctly by a screen reader. (RAFT-03)
**UI hint**: yes
**Research flags**: Standard patterns. The brief's RAFT definition governs (the research marked the external definition low confidence): settle in discuss whether Functions are node attributes or their own entries. Layout stability and node caps at scale; `cytoscape-fcose` is MIT, while `elkjs` and `cytoscape-svg` are excluded by licence.
**Plans**: TBD

### Phase 18: Standing feeds, unattended work, and alerts
**Goal**: A project keeps itself current from RSS/Atom feeds, MCP sources, and watched folders without spending past its limits, and tells analysts when something they care about appears.
**Depends on**: Phase 17
**Requirements**: FEED-01, FEED-02, ALERT-01
**Scope**: Per-project feed subscriptions for RSS/Atom (`feedsmith` with `fast-xml-parser` pinned at 5.11.2 or later and DOCTYPE off), MCP sources built on the v0.4.0 MCP connections, and watched folders. A feed host joins the project's allowlist only when the analyst subscribes; polling is jittered. New items land ungraded in a triage inbox, deduplicated and fenced as untrusted, and enter the graded base only through the Phase 15 pipeline. A background-work governor enforces per-run and per-day spending limits between turns (fixes the per-message-only check, S5) for polling, regrading, and, in Phase 23, forecasting; the emergency stop halts it. Tripwires are saved queries over slices and tensions evaluated on new intake, with an alerts list and notification.
**Success Criteria** (what must be TRUE):
  1. An analyst subscribes a project to an RSS/Atom feed, an MCP source, and a watched folder, and new items arrive in the triage inbox ungraded with duplicates collapsed; nothing enters the graded base until accepted. A feed host is contacted only after the analyst subscribes to it. (FEED-01)
  2. Background work (feed polling and regrading) stops with a visible reason when a per-run or per-day spending limit is reached, the limit being checked between turns, and the emergency stop halts it immediately. (FEED-02)
  3. An analyst defines a tripwire (for example a tension between two actors crossing a level, or a named actor appearing in a region) and is alerted, with the matching new intake listed, when new items match; an item that does not match raises no alert. (ALERT-01)
**UI hint**: yes
**Research flags**: Standard patterns. Re-verify the `fast-xml-parser` CVE ranges; polling politeness (ETag, back-off); the shape of v0.4.0 MCP feed bindings; watched-folder file types and size caps; budget semantics for unattended runs.
**Plans**: TBD

### Phase 19: Team sharing through git or a shared folder
**Goal**: A small team shares one base through a git repository or shared folder it controls, the host sees only ciphertext, and disagreements between analysts are shown rather than overwritten.
**Depends on**: Phase 16
**Requirements**: SYNC-01, SYNC-02, SYNC-03
**Scope**: Depends on Phase 16 because conflicting grades are shown side by side; it does not need Phases 17-18. A `LogTransport` interface with git (system `git` via `ProcessRunner`) and shared-folder transports. Each author writes sealed, immutable, opaquely named segments from a local encrypted write-ahead log, one writer per file, so concurrent work merges without conflicts. A sync engine validates every segment and quarantines invalid ones. A signed membership chain is validated by every client against the roster as of each entry. Invites are by public key with a fingerprint check; removing a member enters "removal pending rotation" and then rotates the compartment key to a new epoch wrapped (ML-KEM-768 + X25519) to the remaining members, and the UI says what the removed member keeps. Device-local high-water marks and version vectors detect rollback, fork, and withholding by the host. A version gate protects against clients with mismatched log formats. Conflicting grades or edits are shown side by side with authors.
**Success Criteria** (what must be TRUE):
  1. Two analysts sharing a base through a git repository (and separately a shared folder) work concurrently and offline, then sync, and both end with the same state and no merge conflict; inspecting the repository or folder shows only ciphertext under opaque names. (SYNC-01)
  2. A host that rolls the repository back, forks it, withholds a segment, or reorders segments is detected and reported on the next sync, naming what was detected, and invalid segments are quarantined rather than applied. (SYNC-01)
  3. A member invites another by public key and both sides check the fingerprint before the invite is accepted. Removing a member rotates the keys so they cannot read entries written afterwards, and the UI says they keep what they already read. An item an analyst erases becomes unreadable on every member's device after sync. (SYNC-02)
  4. When two analysts grade the same claim differently while offline, both grades appear side by side after sync with their authors and times, and neither silently wins. (SYNC-03)
**UI hint**: yes
**Research flags**: Git edge cases: force-push, shallow clones, concurrent pushes, repository growth and `gc` with many segments, and the per-file cost of git at millions of entries. Rollback and fork detection design (version vectors plus device-local high-water marks). Shared-folder semantics on network drives and sync clients (partial writes, case-insensitivity). Version-gate protocol evolution. Out-of-band fingerprint UX.
**Plans**: TBD

### Phase 20: Organisation compartments, roles, and access
**Goal**: An organisation divides a base into need-to-know compartments with their own keys and roles, manages them in an Access view, keeps key management practical into the hundreds of members, and loads large bases from signed snapshots.
**Depends on**: Phase 19
**Requirements**: ORG-01, ORG-02, ORG-03, ORG-04, ORG-05
**Scope**: Multiple compartments, each with its own key and epoch chain, behind a single `LabelledStore` so derived data (grades, search, slices, reports) is computed reader-relative and cannot leak. Roles (reader, analyst, approver, admin) are signed grants that every client verifies at the roster as of each entry. Approval-required entry classes: a label downgrade is an approver-signed new entry, and cross-compartment references live only inside the more restricted entry. Agent runs cannot write down: output is labelled at least as high as the highest compartment read. The Access view manages compartments, members, and roles, previews the effect before granting, and removes a member from many compartments in one rotation. Per-member key wraps (about 1.1 KB per ML-KEM-768 ciphertext plus the X25519 share) stay behind a `GroupKeyProvider` interface with batched rotation; MLS stays an upgrade path. Per-compartment signed snapshots let a new member load a snapshot plus later entries. New members see history from their join epoch by default; earlier history is an explicit, logged grant.
**Success Criteria** (what must be TRUE):
  1. In a base with compartments A and B, a reader who holds only A sees the same entry counts, search results, grades, slices, and reports as they would in a base that never had B, with no placeholder, count, or error that hints B exists. The globe, timeline, and forecasts (Phases 22-23) extend the same test when they are built. (ORG-01)
  2. A reader cannot append, an analyst appends proposals, an approver approves restricted classes, and an admin manages membership; each client rejects an entry signed outside its signer's role at that point in the roster, and an agent run that read from a restricted compartment cannot write into a less restricted one (refused with a reason). (ORG-02)
  3. An admin manages compartments, members, and roles in the Access view, sees who will gain or lose access before granting, and removes a member from many compartments in one rotation. (ORG-03)
  4. Adding or removing a member of a compartment with several hundred members completes within the time and size budgets this phase records. (ORG-04)
  5. A new member opens a multi-million-entry base from the latest signed snapshot plus later entries within the load budget, without replaying the whole history, and sees history only from their join epoch unless an admin grants earlier history. (ORG-05)
**UI hint**: yes
**Research flags**: Approval classes and the two-person rule for downgrades; admin-key recovery (m-of-n); join-history policy; cross-compartment references and moves; roles beyond the four named (an owner role); key-wrap cost, rotation batching, and signature-verification throughput at hundreds of members; indistinguishability test design for the acceptance criterion.
**Plans**: TBD

### Phase 21: Ciphertext relay
**Goal**: An organisation can run its own relay that stores and forwards only ciphertext, enforces who may append, and can do no worse than withhold data, and a team can move a base from git or a shared folder to it without losing history.
**Depends on**: Phase 20
**Requirements**: RELAY-01, RELAY-02
**Scope**: A standalone `src/relay/` built from zero-dependency `node:http`, server-sent events, and `node:crypto` (Node 24, single esbuild file, OCI image with SBOM and signature) that shares the log-validation code with the client. The relay sees pseudonymous key ids, opaque compartment ids, and short-lived per-stream append capability tokens signed (hybrid) by admins under the membership log; it does not see role names. Clients re-verify everything and keep tree-head or high-water-mark state to detect rollback, fork, and withholding. Quotas, padded sizes, and jittered batching limit metadata exposure. `RelayTransport` implements the Phase 19 interface; a migration importer replays a git or folder history into a relay. A malicious-relay test harness and a written threat model, including residual metadata, are deliverables.
**Success Criteria** (what must be TRUE):
  1. An organisation starts the relay from its container image, clients connect and sync through it, and inspecting the relay's storage and traffic shows only ciphertext, pseudonymous key ids, and opaque compartment ids: no claim text, names, or role names. (RELAY-01)
  2. The relay refuses an append without a valid, unexpired capability signed by an authorised admin, refuses a revoked or expired one, and pushes new entries to connected clients without polling. (RELAY-01)
  3. Against a malicious-relay harness that withholds, replays, rolls back, forks its view per client, reorders, or injects forged entries, clients reject the forged entries and report the withholding, rollback, or fork; the worst outcome is data being withheld. (RELAY-01)
  4. A team moves a base from git or a shared folder to the relay and every member continues with the same folded state and full history; the old transport stops cleanly. (RELAY-02)
**Research flags**: Relay protocol and a security review before release (capability tokens, tree-head consistency, metadata exposure, padding and batching); hybrid post-quantum TLS support between the extension host's Node 22 and a Node 24 relay (application-layer protection holds even if TLS is not hybrid); `node:sqlite` on the relay image is unconfirmed, so plan a file-store fallback; deployment identity (OCI image versus npm, hosting, optional directory or SSO key binding); backpressure and load.
**Plans**: TBD

### Phase 22: Globe, imagery, and timeline replay
**Goal**: Analysts explore geocoded intelligence on an interactive open-source 3D globe with a layer per source or source type, and roll time back to replay how events unfolded across timeline, network, and globe.
**Depends on**: Phase 17
**Requirements**: GEO-02, GEO-03, TIME-01
**Scope**: Depends on Phase 17 for the network view and slices; it does not need Phases 19-21. Starts with a scoped spike with an explicit pass or fail: MapLibre GL 6.x globe projection inside the webview CSP (worker loading), PMTiles range reads through host messaging, a trace showing no third-party request, and a 2D fallback without WebGL. CesiumJS is used only if the spike fails or terrain or 3D Tiles become a requirement. A bundled Natural Earth basemap is always available. Layers are per source or source type. Online imagery (NASA GIBS) is on by default and can be turned off per project; the setting names the imagery host and says it sees which areas are viewed. A timeline scrubber replays "as it happened" (occurredAt) and "as it was known" (reportedAt and gradedAt), with linked brushing across timeline, network, and globe, backed by a time index that stays fast at millions of entries. Views are reader-relative.
**Success Criteria** (what must be TRUE):
  1. With the network disabled, an analyst opens the globe and sees geocoded claims and events on the bundled basemap, one layer per source or source type that can be switched on and off, reordered, and given an opacity; where WebGL is unavailable the same data appears on a 2D map with a table view. (GEO-02)
  2. The globe and its layers are interactive: the analyst rotates, zooms, tilts, and pans; hovering a point or area shows a summary and clicking it opens its claims with grades, sources, and times; selecting points or drawing an area filters the layers or saves a geographic slice, and opens the selection in the network and timeline. The 2D fallback supports the same interactions. (GEO-02)
  3. Online imagery is on by default and its setting says the imagery host sees which areas are viewed. Turning it off for a project produces zero imagery requests, and the bundled basemap still renders. (GEO-03)
  4. An analyst drags the timeline back and the timeline, network, and globe all show the base at that time; switching between "as it happened" and "as it was known" gives different results for an item reported late, and replay plays forward in order. (TIME-01)
  5. Selecting an actor or event in one view highlights it in the other two. (TIME-01)
  6. A reader who lacks a compartment sees no layer, point, or timeline event drawn from it, exactly as in a base that never had it. (extends ORG-01, owned by Phase 20)
**UI hint**: yes
**Research flags**: The globe spike above (it gates the rest of the phase), including hover and click picking and smooth rotate and zoom with hundreds of thousands of points; NASA GIBS terms of use, rate limits, and attribution; whether to offer a one-time global overview download instead of live tiles; time-index design and replay performance at scale; WebGL availability in remote, WSL, and code-server hosts.
**Plans**: TBD

### Phase 23: Forecasting and calibration
**Goal**: For a slice, analysts get probability forecasts they can audit, recalibrated as events arrive and scored when they resolve, running locally or on NEAR TEE models as the project chooses.
**Depends on**: Phase 22, Phase 18
**Requirements**: FCST-01, FCST-02, FCST-03, FCST-04
**Scope**: Depends on Phase 22 for the timeline and as-known replay used in backtesting, and on Phase 18 for the background-work governor. A local forecaster written in-repo and run in a `worker_thread`: conjugate Bayesian updating, an exponential-kernel Hawkes process fitted by EM, discounted-Beta or Kalman tension trends, and Brier, ECE, and isotonic calibration; no ML runtime. A TEE scenario generator proposes scenarios and writes the explanation, but every displayed probability comes from the shared, auditable calibration layer with its sample size, interval, and evidence. Forecast and resolution entries are in the log. Below a minimum of evidence the forecast says "insufficient basis". Backtesting uses as-known time only to avoid temporal leakage. Recalibration runs when events arrive or a relied-on source is downgraded (completing RPT-03's impact preview for forecasts). ACH matrix, evidence-contribution view, and a calibration dashboard with a reliability diagram. Background forecasting runs under the Phase 18 governor. Views are reader-relative.
**Success Criteria** (what must be TRUE):
  1. For a slice, an analyst requests a forecast and sees mutually exclusive scenarios that sum to 100% with a horizon and resolution criteria, plus RAFT tension trends, each probability shown with the evidence behind it. (FCST-01)
  2. When new events arrive, or a source a forecast relied on is downgraded, the forecast recalibrates and shows what changed; when a scenario resolves it is scored (Brier score) and appears on a reliability diagram; with too little evidence the forecast says "insufficient basis" instead of a number. (FCST-02)
  3. An analyst chooses per project whether forecasting runs locally or on NEAR TEE models; with local chosen, no forecasting request goes to NEAR; either way the probability on screen comes from the calibration layer, never directly from a model, and is labelled uncalibrated until scored. (FCST-03)
  4. Each forecast opens an ACH matrix of hypotheses against evidence and an evidence-contribution view, and a calibration dashboard shows forecasting accuracy over time. (FCST-04)
  5. A reader who lacks a compartment sees forecasts, trends, and evidence views identical to those of a base that never had it. (extends ORG-01, owned by Phase 20)
**UI hint**: yes
**Research flags**: Forecast methods and calibration minimums (minimum evidence, Hawkes/EM identifiability, small-sample behaviour); the owner's decision on what "train on TEE" means (default: in-context scenario generation through the calibration layer, labelled uncalibrated until scored); backtest design that uses as-known time only; a gold set for scenario generation.
**Plans**: TBD

### Phase 24: End-to-end hardening and release
**Goal**: The whole milestone is shown to keep its promises under attack-style and at-scale checks, and the shipped copy says only what is true.
**Depends on**: Phase 23
**Requirements**: SOV-04
**Scope**: Closes SOV-04: the declared allowlist covers every destination (NEAR, local runtimes, search, feeds, imagery, git remotes, relay) and a network-spy sweep covers every knowledge-base flow. Adds the cross-flow canary leak scan over every writable location, fault injection against the log and sync paths, an organisation-scale load test, an accessibility review, an honest threat-model pass over README, SECURITY.md, the Marketplace listing, and in-product copy (what the search provider and imagery host see, what a removed member keeps, what the relay learns, that erasure does not recall copies already read), and a 0.5.0 release-candidate VSIX through the existing release check. Publishing remains the owner's call.
**Success Criteria** (what must be TRUE):
  1. A network-spy run across every knowledge-base flow (project creation, intake, feeds, search, sync, relay, globe, forecasting, export) records no request to any host outside the declared allowlist, and with web search, imagery, or TEE forecasting switched off no request goes to its hosts. (SOV-04)
  2. Canary claims, entities, and places pushed through every flow appear in plaintext in no writable location: workspace, extension storage, logs, output channels, transcripts, handoffs, exports, the git repository, the relay store, and temporary files.
  3. A base of several million entries with a compartment of several hundred members opens, syncs, and rotates a key within the budgets recorded in Phases 14 and 20.
  4. The Knowledge Base panel (registers, network, globe, timeline, Access, forecast dashboard) passes a keyboard-only and screen-reader review and respects reduced motion.
  5. README, SECURITY.md, the Marketplace listing, and in-product text describe only behaviour that has been verified, and the 0.5.0 VSIX passes the release check.
**Research flags**: Standard patterns. The relay's own security review belongs to Phase 21; this phase re-checks that listing claims match recorded evidence.
**Plans**: TBD

## Progress (v0.5.0)

**Execution order:** 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 13. Sovereignty gate, post-quantum cryptography, and the encrypted event log | 0/TBD | Not started | - |
| 14. Encrypted scalable store and search | 0/TBD | Not started | - |
| 15. Source and claim intake with agent tools | 0/TBD | Not started | - |
| 16. Admiralty grading, thresholds, and reports | 0/TBD | Not started | - |
| 17. RAFT network and slices | 0/TBD | Not started | - |
| 18. Standing feeds, unattended work, and alerts | 0/TBD | Not started | - |
| 19. Team sharing through git or a shared folder | 0/TBD | Not started | - |
| 20. Organisation compartments, roles, and access | 0/TBD | Not started | - |
| 21. Ciphertext relay | 0/TBD | Not started | - |
| 22. Globe, imagery, and timeline replay | 0/TBD | Not started | - |
| 23. Forecasting and calibration | 0/TBD | Not started | - |
| 24. End-to-end hardening and release | 0/TBD | Not started | - |

Phases 1-12 are complete; see Shipped milestones below. Phase folders for 1-12 are archived under `.planning/milestones/v0.4.0-phases/`.

## Shipped milestones

<details>
<summary>Milestone 1 (Phases 1-6) - SHIPPED</summary>

### Phase 1: Extension foundation, onboarding, and GSD synchronization

Create the VS Code extension scaffold, development/build/test pipeline, settings model, SecretStorage integration, visual first-project GSD onboarding flow with project-shaping questions and recommended agent-team setup, and an installable VSIX path. Add startup and daily Open-GSD stable-release checks, global runtime installation/update, project synchronization, context-monitor verification, resumable handoffs, privacy preflight and sovereignty controls, progress reporting, and failure recovery.

### Phase 2: NEAR AI client, model catalog, and cost telemetry

Implement the typed provider boundary for NEAR AI and local OpenAI-compatible runtimes, with explicit provider selection, project-scoped NEAR AI organization/key profiles, streaming, model/pricing discovery where available, request metadata, usage/cost estimation, actual-cost reconciliation, organization/project cost attribution, cancellation, retries, verification status, and no-silent-cloud-fallback behavior.

### Phase 3: Chat workspace, motion, activity, and Open-GSD command bridge

Build the chat UI and conversation state, expose Open-GSD commands and project artifacts, stream command progress, and link responses to workspace files and planning state. Add a compact NEAR logo animation that communicates reasoning/thinking, streaming, waiting for approval, completion, and failure without implying hidden chain-of-thought disclosure; respect reduced-motion preferences and provide accessible text/status semantics. Include verbose progress cards, interactive prompts, activity history, live session summaries, and a persistent info line beneath chat showing GSD project/phase/plan progress, execution state, agents, and cost context modeled on this chat experience.

### Phase 4: Agents, routing, approvals, and analytics

Implement sub-agent generation and lifecycle controls, persistent/resurrectable agent profiles, memorable agent identities with configurable light-humor progress updates, explainable reputation-aware role routing, privacy preflight and data-sovereignty enforcement, approval previews, tool permission enforcement, budgets, emergency stop, audit events, and resumable execution. Add a live agent-fleet view, event timeline, per-agent drill-down, persistent local analytics, organization/project cost attribution, reputation evidence, cost/model/latency summaries, filtering, and export.

**Plans:** 5/5 plans executed

Plans:
- [x] 04-01-PLAN.md — profiles, identities, project initialization, and accepted role teams
- [x] 04-02-PLAN.md — privacy preflight, sovereignty policy, local-only enforcement, and negative tests
- [x] 04-03-PLAN.md — explainable reputation-aware routing and agent orchestration
- [x] 04-04-PLAN.md — approval previews, budgets, emergency stop, audit, and resumable execution
- [x] 04-05-PLAN.md — live fleet, timeline, drill-down, durable analytics, filtering, and export

### Phase 5: Verification, hardening, account entitlements, and release

Exercise end-to-end flows, close the scoped NEAR AI credential/profile and organization/project attribution boundary, and add an explicitly authorized NEAR wallet/entitlement flow for verified staking, credit-balance, and stake-status visibility. Run continuous security/privacy gates, perform credential and backdoor-oriented review, verify failure recovery and accessibility, complete packaging and Marketplace documentation, publish the trust/security report, and produce a release candidate VSIX. Staking remains separate from API-key profiles and never accesses local NEAR credential files.

**Requirements:** AUTH-01, AUTH-03, AUTH-04, MODEL-03, MODEL-04, COST-03, COST-04, COST-05, STAKE-01, STAKE-02, STAKE-03, CHAT-04, AGENT-03, OBS-01, TEST-01, SEC-01, SEC-02, PKG-01, PKG-02, SEC-03

**Plans:** 5/5 plans executed

Plans:
- [x] 05-01-PLAN.md — scoped SecretStorage credentials, named profiles, migration, validation, and explicit switching
- [x] 05-02-PLAN.md — organization/project cost attribution through activity, audit, analytics, filters, and export
- [x] 05-03-PLAN.md — external wallet authorization, verified staking/entitlement status, exact transaction previews, and safe history
- [x] 05-04-PLAN.md — immutable persisted ActivityStore attribution on reload with legacy-unknown security regressions
- [x] 05-05-PLAN.md — trust/security report, Marketplace listing, dependency evidence, and clean VSIX packaging verification

### Phase 6: Team studio and multimodal agent skills

Add a developer-friendly reusable agent-team builder inspired by role-based agent platforms: users can compose named teams, define member roles, skills, tools, model routes, personalities, tone/style, autonomy, approvals, and budgets, then save, version, import/export, and invoke those teams for selected projects. Add private per-agent memory and collective team memory backed by an inspectable context graph with scoped slices, provenance, confidence, decay, contradiction/tension handling, and an interactive graph/table explorer. Add secure multimodal project intake for image, video, audio, document, and structured-data attachments, modality-aware orchestration, provenance and derived-artifact tracking, and first-class image/video generation skills routed only to compatible models with privacy, cost, budget, cancellation, and approval enforcement.

**Requirements:** TEAM-01, TEAM-02, TEAM-03, TEAM-04, MULTI-01, MULTI-02, MULTI-03, GEN-01, GEN-02, MEM-01, MEM-02, MEM-03, MEM-04, MEM-05, MEM-06

**Plans:** 11/11 plans executed (10 executed, 1 gap-closure plan)

Plans:
- [x] 06-06-PLAN.md
- [x] 06-07-PLAN.md
- [x] 06-08-PLAN.md
- [x] 06-09-PLAN.md
- [x] 06-10-PLAN.md — accessible interactive context graph/table explorer and exact approval-bound memory actions
- [x] 06-11-PLAN.md — repair executable webview assembly and runtime-prove memory and graph interactions
- [x] 06-01-PLAN.md — reusable named team studio, bounded member contracts, versioning, import/export, and project invocation
- [x] 06-02-PLAN.md — capability-aware model routing, compatibility checks, and reputation-aware selection
- [x] 06-03-PLAN.md — secure multimodal intake, privacy enforcement, derived artifacts, and provenance lineage
- [x] 06-04-PLAN.md — capability-bound image/video generation, cost/usage, cancellation, approval, and publication controls
- [x] 06-05-PLAN.md — private and collective scoped context graphs, memory slices, revision controls, and accessible graph/table views

</details>

<details>
<summary>Milestone 2 / v0.4.0: A working core and a native NEAR agent runner (Phases 7-12) - SHIPPED</summary>

Started 2026-10-26 after the delivery audit (`.planning/AUDIT-2026-10-26.md`) found that phases 1-6 were mostly unreachable, faked, or built against API contracts that do not exist. Goal: every advertised capability works end to end on NEAR AI, Open-GSD runs on a clean-room agent harness inside the extension (no proprietary runtime), and private TEE models are the default.

Ground rules for this milestone:
- A plan is complete only when its behavior is reachable from the UI or a command and proven by a test that drives the real path. Source-text tests, fake processes speaking invented protocols, and tests that seed state production never creates do not count as evidence.
- Every external contract (NEAR endpoints, headers, catalog fields, Open-GSD file formats) is verified against the live service or installed files before code depends on it.
- The harness is a clean-room implementation built from public behavior descriptions; no Claude Code or Codex source is copied or bundled.

Phase folders for phases 1-12 are archived under `.planning/milestones/v0.4.0-phases/`.

### Phase 7: Honest, working baseline

Make the shipped product truthful and functional before building on it. Fix Open-GSD detection (read installed VERSION files, not `npm list`). Load actual cost from `POST /v1/billing/costs` keyed by the `inference-id` header, show estimates in the sidebar, and request streamed usage. Label every model's privacy from NEAR's catalog (TEE-attested vs forwarded) and show "TEE verified" only from NEAR's attestation/signature endpoints. Put privacy preflight, the action policy, spend limits, and an emergency stop on every outbound chat path, with a TEE-only sovereignty mode. Add profile removal, sidebar artifact links, history, and next-action buttons. Remove dead options (NEAR account auth mode, staking/wallet entry points) and hide Tools features until Phase 11 makes them real. Correct README and SECURITY.md, require the sidebar assets in the release check, and replace source-text tests with behavior tests that drive `initializeChat` and the participant.

**Requirements:** FIX-01..08, PRIV-01, PRIV-02, PRIV-03, PRIV-05, COST-01, COST-02, COST-03, SAFE-01, GSD-02, CHAT-04, AUTH-01, SEC-03, TEST-02

**Status:** Complete 2026-10-26 (`.planning/milestones/v0.4.0-phases/07-honest-working-baseline/07-01-SUMMARY.md`).

### Phase 8: Agent harness core

Build the runner's engine: a streaming tool-calling loop over NEAR's OpenAI-compatible `/v1/chat/completions` (verified on 2026-10-26 for parallel calls, round trips, and streamed deltas on GLM 5.3, GLM 5.3 Flash, Kimi K3/K2.6, Qwen 3.5, DeepSeek V3.2/V4.1 Flash) with retries, cancellation, turn limits, and per-turn cost. Implement the core tools (Read, Write, Edit, Glob, Grep, Bash with persistent sessions and background jobs, TodoWrite) with workspace containment, a permission engine driven by `nearAi.actionPolicy` plus allow/deny rules, approval cards with diffs and command previews, file checkpoints with one-click revert, and audit events. Add a local OpenAI-compatible provider kind so local runtimes use the same harness.

**Requirements:** HARN-01..08, SAFE-01, SAFE-02, MODEL-02, MODEL-03

**Status:** Complete 2026-10-26 (`.planning/milestones/v0.4.0-phases/08-agent-harness-core/08-01-SUMMARY.md`). Setup also offers a hybrid NEAR AI Cloud + local profile.

### Phase 9: Open-GSD on the runner

Install Open-GSD's Claude runtime into extension-owned storage (never the user's `~/.claude`) and run it natively: load skills, commands, agents, and workflows; expand `$ARGUMENTS` and `@` includes; provide the Skill and SlashCommand tools; turn AskUserQuestion into interactive cards in the sidebar and buttons in `@nearai`; run `gsd-tools.cjs` with VS Code's bundled Node. Every installed GSD skill becomes discoverable with arguments. Progress, status line, and next actions come from real run events and STATE.md.

**Requirements:** RUN-01..06, GSD-01, GSD-03, GSD-04, GSD-05, CHAT-02, CHAT-03, CHAT-05

**Status:** Complete 2026-10-26 except RUN-06's live run, moved to phase 12 (`.planning/milestones/v0.4.0-phases/09-open-gsd-on-the-runner/09-01-SUMMARY.md`). A foreground Agent tool was pulled in from phase 10 because GSD workflows depend on it.

### Phase 10: Sub-agents, background work, context, and sessions

Implement the Agent/Task tool from GSD agent definitions (system prompt, tool allowlist, model tier mapped to NEAR models: deep = Kimi K3, default = GLM 5.3, fast = GLM 5.3 Flash), parallel and background agents with limits and notifications, and real agent events feeding the fleet view. Add context management (budget tracking, tool-output truncation, summarization-based compaction), continuity thresholds with automatic handoff and restore, durable local session transcripts with resume, WebFetch behind approval, and an assessment of the Workflow tool and MCP clients that GSD workflows reference.

**Requirements:** HARN-09..12, AGENT-01, AGENT-02, AGENT-03, AGENT-04, CTX-01..04, CHAT-04, OBS-01

**Status:** Complete 2026-10-26 (`.planning/milestones/v0.4.0-phases/10-subagents-context-sessions/10-01-SUMMARY.md`). Workflow and MCP tools assessed and documented as unavailable.

### Phase 11: Teams, multimodal, generation, and memory on the runner

Rebuild the advanced features on the runner so they do real work: the onboarding team questionnaire creates an accepted project team (ONB-04); teams can be created, edited, and invoked as runner sub-agents; attachments are transcribed (Whisper) or understood (vision models) through NEAR; image generation uses FLUX via the real catalog shape; runs write facts to context memory and agents receive bounded slices; reputation updates from real outcomes.

**Requirements:** ONB-04, TEAM-01..04, MULTI-01..03, GEN-01, GEN-02, MEM-01..06, ROUTE-01, ROUTE-02, AGENT-05..07

**Status:** Complete 2026-10-26 with recorded gaps (`.planning/milestones/v0.4.0-phases/11-teams-multimodal-memory/11-01-SUMMARY.md`): no video, PDF, or Office attachments; no memory graph view or shared team memory; reputation is recorded but does not yet steer routing.

### Phase 12: End-to-end verification, model selection, and release

Run the extension in a real VS Code extension host with automated UI tests, plus opt-in live tests against NEAR (a full GSD new-project, plan, and execute run on a sample repository). Evaluate GLM 5.3, Kimi K3, and DeepSeek V4.1 Flash on fixed coding tasks to confirm defaults. Verify NEAR's per-response attestation (`/v1/attestation/report`, `/v1/signature/{chat_id}`) so "TEE verified" reflects a checked signature rather than catalog metadata. Security review, accurate SECURITY.md and listing with real screenshots, then publish.

**Requirements:** TEST-01, TEST-03, SEC-01, SEC-02, SEC-03, PKG-01, PKG-02

**Status:** Built and verified 2026-10-26 (`.planning/milestones/v0.4.0-phases/12-verification-and-release/12-01-SUMMARY.md`): extension-host tests, native response and TDX quote verification, a security review with every finding fixed, and a 0.4.0 release candidate (not published at that time; 0.4.1 was released afterwards). Live checks against NEAR (Verify on real responses, model evaluation, RUN-06) need the user's API key.

</details>

### Deferred

NEAR account sign-in (AUTH-02) and wallet, staking, and entitlement (AUTH-04, COST-05, STAKE-01..03) wait for a documented NEAR AI contract; their entry points are removed in Phase 7 rather than shipped as stubs.

## Next action

Discuss Phase 13 with `/gsd-discuss-phase 13`, then plan it with `/gsd-plan-phase 13`. Close its research flags first: the post-quantum library audit, SecretStorage behaviour on Linux, WSL, containers, and code-server, and the review that freezes the entry envelope (compartment label, key epoch, erasable-item keys, timestamps, hash chain), because nothing built later can change those choices cheaply.

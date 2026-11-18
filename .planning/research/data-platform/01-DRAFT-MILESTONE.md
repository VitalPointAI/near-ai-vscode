# Draft milestone (adopted 2026-11-18): Data platform, now v0.6.0 (phases 85 to 101)

> **Adopted by the owner on 2026-11-18. `.planning/ROADMAP.md` (milestone "v0.6.0 Data platform") and `.planning/REQUIREMENTS.md` are now the source of truth.** This file is kept as the record of the draft and is not updated. Changes made on adoption: decision 14 became one-click connection (SPIKE-09 and CONN-01 to CONN-04 added, DATA-14 rewritten); collectors became small signed native packages with zero-config enrolment, and file shares are read from the host (COLL-01 to COLL-06 added, DATA-17 and DATA-20 revised); decision 7's opt-in placeholder got its own requirement (KB-15); training runs only on your organization's own machines or hardware endpoints it controls (FAC-09); SPIKE-01, DSEC-10 and FAC-06 revised; Phases 85, 89, 90 and 91 renamed, and Phase 85 builds the lasting host (L1a). 106 requirements became 119. The relay became its own milestone after this one, and v0.7.0 keeps Phase 68 and Stage 1.

**Written:** 2026-11-18. **Status:** adopted 2026-11-18 (it was a proposal for the owner).
**Design:** `00-DESIGN.md` in this folder. Sections cited as "D §4.1"; research reports cited as "01 §1.2".
**Owner decisions it assumes:** the recommendations in D §10.1. Where a phase depends on one, the phase names it.

---

## 1. Where it slots in

```
0.4.x patches ......................................................................>
Stage 1 (v0.5.0): 69 done -> 70 -> 71 -> 72 -> 73 -> 74     28 and 29 beside it
                                                   |
                                    Stage 1 gate (verified, merged)
                                                   |
DATA PLATFORM (this milestone, 85 to 101)  <-------+   (85 and 86 may start during 72 to 74)
                                                   |
                                    Data platform gate
                                                   |
Relay: Stage 2 (75 to 81) -> Stage 3 (82 to 84)    (75 may still start beside Stage 1, as planned:
                                                    it touches only relay/)
Later: L1b Theia appliance, L2, L3, L4, L5, L6     (L1a, the host slice, is absorbed here: D §8.2)
```

- **Name and number** (D §10.1-2): its own milestone between Stage 1 and the relay. Phases are numbered 85 to 101 because 84 is the last number used; the relay keeps its numbers 75 to 84 and simply runs later. Version string is the owner's choice (set 2026-11-18: v0.6.0, with the governed agent platform v0.5.0 and the relay v0.7.0). The cybersecurity milestone keeps v0.8.0 and stays deferred.
- **Early start:** phases 85 and 86 need no Stage 1 code (a host and a test tenant), so they can run while Phases 72 to 74 finish. Nothing that reads your organization's real data starts before the Stage 1 gate, because it needs verified clearances (Phase 71), the broker (73) and contracts (74).
- **Relay change:** Phase 77's dependency on Phase 74 is unchanged; it now also waits for the data platform gate (owner priority R11). Phase 75 keeps its permission to start early in its own worktree.

## 2. What it absorbs from the paused former v0.5.0 knowledge-base plan

| Former v0.5.0 phase | Disposition | Lands in |
|---|---|---|
| 13 Sovereignty gate, PQ crypto, encrypted log | Carries with changes: PQ primitives, signed segments, the four-timestamp fold, crypto-shredding, canary scan and network spy harnesses carry; envelope v2 for lattice labels; sharded item-key store; per-label routing replaces KB mode; device identity replaces the KB vault (03 §4) | 88 (log and harnesses), 94 (crypto-shredding) |
| 14 Encrypted scalable store and search | Superseded by the host store (Postgres, pgvector, BM25). "Benchmark first" and "damaged data reported, never replaced by an empty base" carry | 88, 96 |
| 15 Intake with agent tools | Changes: connectors replace hand intake; quote-verified evidence, untrusted-on-read fencing, proposed links with undo, importers (CSV, STIX, GeoJSON), offline gazetteer and the panel shell carry | 96 (evidence, links, shell), 100 (importers) |
| 16 Admiralty grading and reports | Carries as an optional trust layer for intelligence projects; ReportBuilder and ReportVerifier carry for all reports | 97 (reports); grading after this milestone |
| 17 RAFT network and slices | Changes: RAFT becomes one ontology profile; slices become saved scopes | 97 |
| 18 Feeds, unattended work, alerts | Superseded in part: feeds become connectors; the spend governor carries; tripwires become insights | 92 and 96 (governor), 97 (insights) |
| 19 Team sharing | Superseded by L2 | none |
| 20 Compartments, roles, access | Changes, and becomes the core: compartments are label compartments, roles are Phase 71 credentials; the reader-relative rule and the two-compartment indistinguishability test carry unchanged | 88, 93, 96, 101 |
| 21 Ciphertext relay | Superseded by Phase 68 relay and L5 | none |
| 22 Globe and timeline | Timeline carries in 97; globe deferred | 97 |
| 23 Forecasting | Deferred, intelligence projects only | none |
| 24 Hardening and release | Carries, extended to the database, caches and model server logs | 101 |

The Phase 13 code on its local branch is read with `git show` and ported piece by piece; it is not merged as a branch.

## 3. Ground rules (carried from the former v0.5.0 plan and Stage 1)

- A success criterion counts only when a test drives the real path. Source-text tests do not count.
- Every phase that adds a network destination extends the network-spy test; every phase that adds a place where data is written extends the canary leak scan.
- From phase 88 on, every new view or count is computed reader-relative and extends the two-compartment indistinguishability test.
- Every new event id is named before it ships (D-49). Every gate format change is a v2 beside v1 (D-22).
- Licence check in CI covers code and model weights from phase 85.
- Test runs on the host use memory caps (cgroup limits) and one heavy job at a time.

## 4. Requirement prefixes

`SPIKE-` research spikes; `DATA-` discovery, connectors, ingestion, extraction; `TAG-` classification and metadata; `DSEC-` data-centric security (not `SEC-`, already used); `MARK-` personal mark; `HOLD-` holds and requests; `KB-` knowledge layer; `FAC-` model factory; `OPP-` opportunity agent.

---

## 5. Phases

### Stage A: spikes (85 to 87)

### Phase 85: Host bring-up and throughput on Strix Halo (spike)
**Goal**: The always-on host runs the platform's stack on the Strix Halo machine, and the numbers the design estimates are measured.
**Depends on**: Nothing in code. Owner decision D §10.1-1 (L1a in this milestone) and D §10.1-4 (Python worker containers).
**Requirements**:
- SPIKE-01: a Compose stack on amd64 runs Postgres 18 with pgvector, pg_textsearch and RLS, DuckDB with DuckLake, the encrypted blob store, a sandboxed Python worker image and llama.cpp. Images are pinned by digest and start with no network.
- SPIKE-02: local inference is reachable from the extension through the existing hybrid provider as `local` models, with ROCm and Vulkan both measured.
- SPIKE-03: measured on a fixed test set: embeddings in chunks per second, GLiNER spans per second, local LLM tokens per second for prompt and generation, LoRA on a 4B base in tokens per second with peak memory, and stability at a GPU memory fraction of 0.8 under a cgroup cap. Exact ROCm and PyTorch versions recorded (04 §9 A, §11 OQ1).
**Parallel**: with 86, and with Stage 1 phases 72 to 74.
**Success Criteria**:
  1. The stack comes up from an offline bundle and survives a host reboot. RLS refuses a query without a clearance token.
  2. A chat in the extension answers from a model served on the host, through a hybrid profile.
  3. One LoRA adapter on a 4B base is trained, converted, served and answers through the extension.
  4. A measurement table replaces the LOW estimates of 01 §6.2, 03 §1.2 and 04 §3.4, and the design is updated where a number changes a decision.

### Phase 86: Microsoft 365 connector spike
**Goal**: The Microsoft 365 risks are answered against a real test tenant before the connector is built.
**Depends on**: A test tenant; nothing in code. Owner decision D §10.1-14 (app registration model).
**Requirements**:
- SPIKE-04: ACL fidelity for SharePoint and OneDrive measured with read scopes plus hierarchical sharing, versus full control. `Sites.Selected` checked together with and without broad file scopes (01 §8 OQ1).
- SPIKE-05: delta `nextLink` lifetime over a multi-day backfill, 410 resync on a large drive, and `immutableId` with message delta across folder moves (01 §8 OQ2, OQ3).
- SPIKE-06: a resource-unit budget model for a tenant of under 1,000 licences, plus reads of Purview labels and retention labels (`extractSensitivityLabels`, LabelInfo, 423 cases) and Exchange RBAC for Applications scoping, all checked against v1.0 permissions.
**Parallel**: with 85.
**Success Criteria**:
  1. A written finding per question, each with the recorded calls, feeds the phase 89 plan.
  2. The guided app-registration script creates a certificate-credential app with the least scopes, and an admin can read every scope's reason.
  3. A budget calculator predicts backfill days for a given inventory, within 25 percent of a measured run on the test tenant.

### Phase 87: Extraction and OCR throughput spike
**Goal**: The extraction and OCR tiers are chosen from measurements on the host, not estimates.
**Depends on**: Phase 85.
**Requirements**:
- SPIKE-07: on a fixed set of 1,000 pages (born-digital, clean scans, hard scans with tables and handwriting) and 10 hours of audio, measure Tika, Docling standard and VLM pipelines, Tesseract or PP-OCRv5 on CPU, PaddleOCR-VL and granite-docling on GPU, and whisper.cpp large-v3-turbo under ROCm and Vulkan (01 §8 OQ4).
- SPIKE-08: a page-difficulty router (tier 1 to tier 2 OCR) with its accuracy and cost recorded; weight licences confirmed (01 §8 OQ10).
**Parallel**: with 88 (which needs only 85).
**Success Criteria**:
  1. Pages per second and accuracy per tier are recorded, and the router sends no more than the measured share of pages to the GPU tier.
  2. The backlog estimate for the 500-person planning model (01 §6.1) is recomputed from these numbers.

### Stage B: the data map and the sources (88 to 92)

### Phase 88: Ingestion core, governed store and the data map
**Goal**: Your organization sees a live map of what data exists, where, how big, who owns it and how fresh it is (inventory and metadata only, no content). Everything shown is filtered by the viewer's clearance and the source's permissions from the first screen.
**Depends on**: Phase 85; the Stage 1 gate (Phases 70, 71, 73, 74).
**Requirements**:
- DATA-01: the connector contract (`RECORD`, `STATE`, `DELETE`, `ACL`, `LOG`), the connector runtime and per-partition cursors advanced in the same transaction as their batch (01 §1.2).
- DATA-02: an item ledger with identity, version and derivative keys, idempotent upserts and an outbox (01 §1.4).
- DATA-03: the source lifecycle (proposed, approved, backfilling, live, degraded, paused, retired), with every state, transition and reason visible (D §4.1).
- DATA-04: three levels of reconciliation sweep, and automatic resync on any "missed something" signal (01 §1.5).
- DATA-05: reorgs at catalog level. A delete hides the item at once; a move or rename updates in place; an ACL change recomputes the subtree before the next query (01 §1.3).
- DATA-06: a filesystem connector on the host itself, as the reference connector.
- DATA-07: the inventory-only dry run, showing names, sizes, counts, types and owners before any content is read.
- DATA-08: the data map view in the extension, showing sources, items by type, size, owner, label and freshness, plus per-source status (phase, backfill progress, sync lag, processing backlog, last event, throttle state, coverage).
- DSEC-01: governed-store RLS on every table, set only through a gate-signed clearance token, with the application role unable to bypass it (D §6.3).
- DSEC-02: the `source.acl` layer in `decide`, a directory snapshot with group expansion at query time, and fail-closed handling of stale ACLs (D §6.4).
- DSEC-03: the ingest-default label on every discovered item, and the governance log (paused Phase 13 envelope v2) recording every label, ACL and lifecycle event.
**Parallel**: with 87 and 98.
**Success Criteria**:
  1. Pointing the host at a folder tree fills the data map within the measured time. Deleting, renaming and re-permissioning files there shows up within the freshness target.
  2. Killing the host mid-batch replays that batch with no duplicate and no gap.
  3. Two people with different clearances and ACLs see different maps, and each map is identical to the map of a base that never held the other's items (the indistinguishability test).
  4. No content is read in dry-run mode. The canary scan finds no content in the store, logs or caches.

### Phase 89: Microsoft 365 connector
**Goal**: SharePoint, OneDrive and Exchange appear in the data map, then backfill and stay in sync, with their permissions and labels.
**Depends on**: Phases 86 and 88; Phase 73 (the broker holds the certificate).
**Requirements**:
- DATA-09: site, drive and mailbox discovery; inventory-only mode first.
- DATA-10: per-drive delta with hierarchical sharing and sharing-change annotations; the live cursor captured before backfill; the resource-unit budget; a global `Retry-After`; off-peak backfill.
- DATA-11: separate identity sync (users and groups delta) on its own schedule.
- DATA-12: mailbox delta with immutable ids, scoped by Exchange RBAC for Applications. Mail follows D §10.1-6 (off by default; label-only mode when on).
- DATA-13: Purview sensitivity and retention labels read into `sourceLabels` and `retentionClass`; unreadable (423) and double-key items treated as top level and metadata-only.
**Parallel**: with 90, 91 and 92.
**Success Criteria**:
  1. On the test tenant, a backfill completes and the source reaches `live`. A file's permission change hides the file from a removed person before their next query.
  2. A forced 410 moves the source to `degraded` and then back to `live` with no lost item.
  3. The wizard shows every scope with its reason, and mail stays off until the confirmation is recorded.

### Phase 90: Google Workspace connector
**Goal**: Drive, shared drives and Gmail appear in the data map and stay in sync, with permissions and Drive labels.
**Depends on**: Phase 88; Phase 73.
**Requirements**:
- DATA-14: domain-wide delegation set up with one pasted client id and scope list; the key held in the broker (with short-lived credentials if the research step finds them workable).
- DATA-15: `changes.list` per user and per shared drive; Gmail `history.list`, with the cursor captured before backfill and a full resync on 404.
- DATA-16: Drive labels mapped; the Admin SDK used for identity sync; quotas checked in a test project before planning (01 §8 OQ5).
**Parallel**: with 89, 91 and 92.
**Success Criteria**:
  1. A mailbox larger than the history window backfills with no gap.
  2. Removing a user from a shared drive hides its items from that user within the ACL target.

### Phase 91: Endpoint collectors and file shares
**Goal**: Windows, macOS and Linux machines and file shares are discovered and kept in sync without ever pulling cloud placeholder files down.
**Depends on**: Phase 88; Phase 72 (the signing and installer boundary for the collector).
**Requirements**:
- DATA-17: a Rust collector on Windows (MFT enumeration plus the USN journal), deployed with admin rights; journal sizing advice.
- DATA-18: macOS collector (FSEvents with stored ids and a Full Disk Access MDM profile) and Linux collector (fanotify, with inotify as the fallback).
- DATA-19: sync roots and placeholder attributes detected and skipped; OS folders, caches and build outputs excluded by default.
- DATA-20: file shares through directory enumeration, a collector on the file server where possible, and otherwise snapshot diffs; NTFS and POSIX ACLs resolved through the directory.
- DATA-21: a mutually authenticated collector channel to the host, signed with device keys. A personal mark known from the item's location is honoured before fetching.
**Parallel**: with 89, 90 and 92.
**Success Criteria**:
  1. A machine with a synced cloud folder causes zero placeholder downloads.
  2. Wrapping the journal or overflowing the queue triggers a subtree rescan, with no lost item.
  3. Endpoint-only files show "may disappear" in coverage.

### Phase 92: Extraction pipeline
**Goal**: Every format becomes text and structure, safely and once, with the backlog visible.
**Depends on**: Phases 87 and 88; Phase 72 (sandboxes).
**Requirements**:
- DATA-22: a Tika and Docling router in sandboxed workers with no network and with size and time limits.
- DATA-23: tiered OCR using the phase 87 router; whisper.cpp for audio and video.
- DATA-24: content-addressed derivatives keyed by `(hash, extractor, version, options)`, so an item is extracted once across duplicates.
- DATA-25: exact and near-duplicate detection (hash, MinHash).
- DATA-26: the bounded, encrypted re-extraction cache (D §10.1-5), deleted along with its source item; a priority queue in which live changes pre-empt backfill; the spend governor (from paused Phase 18) on GPU work.
**Parallel**: with 89, 90 and 91.
**Success Criteria**:
  1. A corpus of malformed and hostile files crashes no worker beyond its own sandbox and reaches no network.
  2. Upgrading one extractor re-runs only its keys.
  3. The data map shows the processing backlog separately from sync lag.

### Stage C: governance (93 to 95)

### Phase 93: Classification, labels, privacy assessment and exceptions
**Goal**: Every item gets its card and a label that only rises, set by your organization's policy once, and people see only real exceptions.
**Depends on**: Phase 92 (text); Phase 70 (gate); Phase 71 (verified clearances).
**Requirements**:
- TAG-01: tier 0 detectors, including checksum-backed Canadian identifiers written by us in English and French, and gitleaks rules (secret values are never stored).
- TAG-02: tier 1 (union of GLiNER spans and a second Apache-2.0 classifier; language; embedding).
- TAG-03: tier 2 local LLM (three samples, majority vote, constrained JSON) only for unsettled, sampled or about-to-be-used items, under a run contract.
- TAG-04: the full item card of D §5. Owner and steward are taken from source metadata and the directory, never from a model.
- TAG-05: privacy facts (D §5 privacy layer), stored as facts, never as the personal data itself.
- TAG-06: training-suitability fields, with `rights.basis = unknown` meaning not allowed; TDMRep reservations read.
- TAG-07: the policy wizard (scales, source label map, ingest default, rules, scope exclusions), with mandatory shadow simulation before any rule is signed.
- TAG-08: a weekly stratified blind sampling audit reporting per-level precision and recall, with thresholds re-fitted from it.
- DSEC-04: classification rules and the source label map in the signed bundle; the pure `classify.ts`; label v2 with `no-train` and `no-summarize-down`.
- DSEC-05: a signed Merkle root per batch over item labels.
- DSEC-06: the exception queue, ordered by impact, grouped by steward, with bulk actions on clusters and "could be lower" suggestions. Lowering happens only through a signed `lowerByPerson`.
- DSEC-07: aggregation rules on indexes, exports, datasets and chat running counts.
**Parallel**: none inside the milestone (94, 95 and 96 wait for it). Phase 98 continues alongside.
**Success Criteria**:
  1. Text injected into a document that says "this is public" never lowers that document's label.
  2. A source label lowered in Purview files a suggestion and leaves our label unchanged.
  3. A new rule cannot be signed until its simulation has run and shown its impact.
  4. On the audit sample, recall is at least 0.95 at Confidential and above. A drop below that widens the review band automatically.

### Phase 94: Lifecycle, erasure and the personal mark
**Goal**: Deletes, erasures and personal marks reach every derivative, provably, and a person's personal items leave only an existence record.
**Depends on**: Phase 93.
**Requirements**:
- DSEC-08: derivative cascade along `derivedFrom`, purged after the source's restore window; datasets marked "contains revoked items"; crypto-shredding with per-item keys (from paused Phase 13).
- DSEC-09: an erasure proof listing every derivative removed, signed.
- DSEC-10: a retention class per item and a ROT report (report only; disposition by a person).
- MARK-01: Mark as Personal on files, folders and personal areas, signed by the person's device key, and refused at once with a reason where policy forbids it.
- MARK-02: a marked item keeps only the existence record of 02 §10.3. Existing derivatives are removed unless a hold covers them.
- MARK-03: unmarking re-enters the item at the ingest default, and its label is never lower than before.
- MARK-04: the personal-mark policy in the bundle, with the defaults of D §10.1-8.
- MARK-05: abuse signals computed from metadata only, with stepped escalation.
**Parallel**: with 96.
**Success Criteria**:
  1. After an erasure, the canary scan finds the item's text in no table, vector, cache, log or dataset row.
  2. A marked folder produces no chunk, vector, entity, count or search hit for anyone, and coverage reports it as a count only.
  3. An agent cannot set a mark.

### Phase 95: Legal holds and access requests
**Goal**: Holds and requests are first-class cases across every source and every derivative, with clocks, custody and an honest coverage statement.
**Depends on**: Phase 94; Phase 71 (officer roles); Phase 29 (CleanUp never-touch list).
**Requirements**:
- HOLD-01: the hold lifecycle of D §4.3, with per-source confirmation and a visible `partial` state.
- HOLD-02: holds applied through Purview eDiscovery and Vault where available (manual import first), plus our write-once hold store with signed manifests for sources without a hold feature.
- HOLD-03: a hold check in every deletion path (sync propagation, retention, ROT, CleanUp, dataset and model deletion), carried along lineage.
- HOLD-04: change attempts on held items recorded as `hold.change-observed`; custodian notices with signed acknowledgment, reminders and release notices.
- HOLD-05: the request lifecycle of D §4.4, with regime deadline rules held as data in the signed bundle, extensions only after their notice, and 50/80/95 percent warnings.
- HOLD-06: subject resolution to identifiers, searches of our indexes plus live source searches recording cursor age, and lineage followed to derivatives and models.
- HOLD-07: redaction proposals confirmed one by one with exemption codes, burned in, with a redaction log.
- HOLD-08: release as a signed package declassification; manifest root signed; append-only custody log.
- HOLD-09: a request-scoped, time-boxed grant; recusal; the two-person rule above the officer's clearance; agents propose and never decide.
- HOLD-10: the personal-mark override of D §4.5, with `notice-pending` visible to the privacy officer; and the coverage statement of 02 §9.5 for every hold and request.
**Parallel**: with 96 and 97.
**Success Criteria**:
  1. Deleting a held item at the source keeps its derivatives, records the attempt and alerts the hold administrator.
  2. CleanUp refuses a held item through its own code check.
  3. A request reaching 95 percent of its time shows the warning, and an extension cannot be recorded without its notice.
  4. A released package verifies against its signed manifest, and its coverage statement names every source not searched.

### Stage D: the knowledge layer (96 and 97)

### Phase 96: Search, context graph, entity pages and ask
**Goal**: People find anything they are cleared for in one search box, see everything about a customer or project across sources, and ask questions answered with citations, within their clearance. The paused knowledge base becomes this view layer.
**Depends on**: Phase 93.
**Requirements**:
- KB-01: chunks and embeddings with the item's label; hybrid BM25 and vector search with reciprocal-rank fusion and reranking, filtered inside the scan; recall tested at low clearance.
- KB-02: tier 0 entity tagging and noun-phrase co-occurrence; evidence rows pointing to exact spans; entities and edges with no stored attributes.
- KB-03: entity resolution (deterministic keys, blocking, Splink or LLM group judge) as reversible proposals with undo; each link labelled with the join of both sides.
- KB-04: tier 1 LLM relation extraction with verified quotes, queued under the spend governor for priority items only.
- KB-05: the knowledge-base panel shell (strict CSP, capped DTOs, from paused Phase 15): data map, search, item and entity pages.
- KB-06: an ask agent with `catalog.search`, `catalog.describe`, `catalog.lineage`, graph neighbourhood and timeline tools. Every sentence cites items, the answer carries its high-water label, and the model is routed by that label.
- KB-07: no side channels (no hidden counts, clearance-keyed caches, no cross-label summaries).
- KB-08: the two-compartment indistinguishability test extended to search, entity pages, facets, autocomplete and answers.
**Parallel**: with 94 and 95.
**Success Criteria**:
  1. A person cleared only for compartment A gets results, entity pages and answers identical to those from a base that never held compartment B.
  2. A search with a very selective clearance still returns the full top-k.
  3. Every answer's citations open the exact source span.

### Phase 97: Analytics, reports, insights and views
**Goal**: Dashboards, reports and suggested insights appear without setup, with every number computed under the viewer's clearance.
**Depends on**: Phase 96.
**Requirements**:
- KB-09: automatic dashboards (Mosaic, Perspective) fed by host-built, label-filtered results; DuckLake analytics tables written per label cell.
- KB-10: natural-language questions turned into SQL over curated views, parsed and allowlisted, run under RLS, and always shown with their SQL.
- KB-11: suggested insights, each with its query: new or fast-growing entities, unusual volume, new connections, possible oversharing, stale data and unclassified items.
- KB-12: reports carried over from ReportBuilder and ReportVerifier, carrying their high-water label and failing if any figure differs from the store.
- KB-13: a graph explorer with saved scopes (slices) and the RAFT profile, plus timeline replay ("as known at T"), with the slice cap and a truncation notice.
- KB-14: a label-change impact preview ("what changes if this label changes").
**Parallel**: with 95, 99 and 100.
**Success Criteria**:
  1. Dashboard totals for two clearances each match the totals of the corresponding single-clearance base.
  2. Model-written SQL that tries to set its own clearance is refused.
  3. A report fails verification after any underlying figure changes.

### Stage E: the model factory (98 and 99)

### Phase 98: Model factory v1, first specialist from chat and run logs
**Goal**: One specialist goes from proposal card to live for one role, trained on your organization's own machine, beating or matching the incumbent, with rollback tested.
**Depends on**: Phase 85 (host trainer); Phase 74 (contracts). It needs none of 88 to 97, so it runs beside them. Owner decisions D §10.1-11, -12 and -13.
**Requirements**:
- FAC-01: a trainer worker on the host in a pinned container, driven by job specs, with a heartbeat, checkpoints and resume, a memory fraction of 0.8 or less, a cgroup cap and one heavy job at a time.
- FAC-02: a licence registry; Llama-licensed bases blocked by default; teacher terms recorded per dataset.
- FAC-03: a dataset builder over the sealed thread store (outcome filter, Presidio scrub, dedup, decontamination, time-and-source split, golden set) producing a manifest with record-level hashes. The dataset label is the join of its inputs.
- FAC-04: an evaluator using the extension's graders, a golden set, a regression subset and a memorisation probe, with the gates of 04 §6.2.
- FAC-05: a registrar writing a sealed model card (label, lineage, licence, eval, approvals, deletion log); the specialist registered as a `local` model.
- FAC-06: a router covering shadow, canary and live by role or tier, with automatic rollback triggers and one-click rollback.
- FAC-07: the specialist lifecycle of D §4.6, with every stuck-state guard.
- FAC-08: serving gated on dominance (the session's clearance must dominate the model's label); fallback to the incumbent when the host is down.
**Parallel**: with 87 to 97.
**Success Criteria**:
  1. A specialist for one role is live, is at least as good as the incumbent on held-out tasks, and is cheaper or faster.
  2. A session below the model's label cannot route to it.
  3. A rollback restores the previous model in one click, with a recorded reason.
  4. No training job calls any network destination outside the host.

### Phase 99: Opportunity agent, data-gap planning and specialists from organization data
**Goal**: The always-watching agent finds optimization opportunities from system use and business practice, proposes them on one-click cards, plans how to get missing data, and trains specialists on classified organization data within rights, marks and labels.
**Depends on**: Phase 98; Phase 93 (training suitability); Phase 94 (erasure triggers retraining); Phase 74.
**Requirements**:
- OPP-01: a signal collector over the spend ledger, activity history, approvals, edits and benchmark results, reading metadata only.
- OPP-02: signature clustering, plus content clustering under the standing policy for the lowest level or after approval (D §10.2-26).
- OPP-03: scoring (value, feasibility gates, risk) and the proposal card of 04 §7.4, with who can approve.
- OPP-04: data-gap planning (D §3.6): when a gate fails, a data plan with ranked options, each its own card; counts only for blocked or marked items.
- OPP-05: process-level opportunities from run and business event logs, using a TypeScript directly-follows graph and variant counts; no per-person scoring.
- OPP-06: organization-data specialists built from `dataset.assemble` (training-allowed items only, opt-in per source or collection, signed), per compartment.
- OPP-07: deletion-triggered retraining. A touched model moves to `retrain-required` with the deadline of D §10.1-9, and traffic falls back to the incumbent when the deadline passes.
**Parallel**: with 95, 97 and 100.
**Success Criteria**:
  1. With content access off, the agent proposes at least one real opportunity from metadata alone.
  2. A goal with too few examples produces a data plan rather than a dead end.
  3. An erasure that touches a dataset retrains and swaps the adapter, or falls back to the incumbent, within the deadline.
  4. The agent cannot read content its approver's clearance does not dominate.

### Stage F: continual sources and release (100 and 101)

### Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases
**Goal**: Adding a new source takes a few clicks, and agents can write new connectors safely.
**Depends on**: Phase 88; Phases 72 and 73. May start any time after 92 if capacity allows.
**Requirements**:
- DATA-27: a source catalog showing plain descriptions, exact scopes with reasons, and estimated backfill time.
- DATA-28: a declarative manifest schema of our own (auth, pagination, record selector, cursor, deletion signal, ACL mapping).
- DATA-29: agent-written connectors: manifest first, then sandboxed code; egress only to declared hosts; broker-injected credentials; read-only scopes enforced by the broker.
- DATA-30: a conformance suite against recorded fixtures (pagination, resume, incremental, deletion, ACL mapping, throttling, idempotent replay); a person approves the connector, and again for every later change.
- DATA-31: databases: directory-first discovery; scanning off by default; dlt backfill and Debezium CDC, with abandoned replication slots monitored; each database approved individually.
- DATA-32: importers carried over from paused Phase 15 (CSV, STIX, GeoJSON) and the offline gazetteer.
**Parallel**: with 95, 97 and 99.
**Success Criteria**:
  1. An agent writes a connector for a REST source that passes conformance and runs after one approval.
  2. A connector that tries an undeclared host is blocked and recorded.
  3. A Postgres source reaches `live` through CDC, and dropping its connection releases the slot.

### Phase 101: End-to-end hardening and release
**Goal**: The milestone keeps its promises under attack-style and at-scale checks, and the product copy says only what is true.
**Depends on**: Phases 85 to 100.
**Requirements**:
- DSEC-11: canary scan and network spy across every flow, including the database, caches, model server logs and training jobs.
- DSEC-12: the indistinguishability test across every view, count, answer, dashboard and specialist.
- DSEC-13: a scale test at 1 million items and 10 million mail headers on one host, within recorded budgets.
- DATA-33: PIA and DPIA packs generated from catalog facts; monitoring-policy text; SECURITY.md and README updated (including plaintext on the host and what clearances guarantee); the operator runbook for the host.
**Success Criteria**:
  1. Every DSEC check is green in CI.
  2. The scale run meets its budgets.
  3. Counsel's review items from D §10.1-6, -8, -9 and -10 are recorded as closed or explicitly deferred.

---

## 6. Order and parallel waves

| Wave | Phases | Why this order |
|---|---|---|
| 0 | 85, 86 (during Stage 1 tail) | They remove hardware and tenant uncertainty and touch no product code |
| 1 | 87, 88, 98 | 88 and 98 need only the host; 87 needs the host |
| 2 | 89, 90, 91, 92 (100 optional) | All plug into 88's contract independently (01 §9) |
| 3 | 93 | Needs text from 92 |
| 4 | 94, 96 | Both need labels; neither needs the other |
| 5 | 95, 97, 99, 100 | 95 needs 94; 97 needs 96; 99 needs 93, 94 and 98 |
| 6 | 101 | Everything |

Sequential links that cannot be split: 93 waits for 92 (classification needs text); 95 waits for 94 (holds suspend the deletion paths 94 builds).

**Visible value by wave:** wave 1 delivers the data map on the host and the first local specialist; wave 2 extends the map to every first source (inventory-only on day one of each connector); wave 4 delivers search and ask; wave 5 delivers holds, requests, dashboards and the opportunity agent.

## 7. Requirement count

SPIKE 8, DATA 33, TAG 8, DSEC 13, MARK 5, HOLD 10, KB 14, FAC 8, OPP 7: 106 requirements in 17 phases.

## 8. Research flags per phase

| Phase | Flag |
|---|---|
| 85, 86, 87 | Spikes by definition |
| 89 | ACL fidelity and budgets from 86; the v1.0 permission table for label reads |
| 90 | Quotas in a test project; keyless or short-lived service-account credentials on premises |
| 91 | MDM profile deployment; signing and installers per OS |
| 93 | Canadian recognizers and French context words; licences of each detector model |
| 95 | Purview and Vault hold API maturity (some parts were beta only); regime clock data reviewed by counsel |
| 96 | Mosaic and Splink licences and dependency trees; pgvector recall at low clearance |
| 98 | Pinned ROCm and PyTorch pairing from 85 |
| 99 | Standing-policy wording for content clustering; employee-monitoring notice text |
| 88, 92, 94, 97, 100, 101 | Standard patterns documented in the research; plan without a research step |

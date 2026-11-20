# Data platform: combined design

**Written:** 2026-11-18
**Inputs:** the four research reports in this folder: 01 (connectors, extraction, ETL), 02 (classification, tagging, data-centric security, requests, holds, personal mark), 03 (context graph, search, analytics, knowledge layer), 04 (model factory and opportunity agent). Citations below take the form "01 §1.2".
**Meets:** the owner's decided requirements of 2026-11-18 (R1 to R11 below).
**Status:** accepted by the owner on 2026-11-18. Decisions 1 to 13 and the 32 settled-in-design choices as recommended; decision 14 changed to one-click connection; collectors that are simple to install added (section 3.7). The plan of record is now `.planning/ROADMAP.md` (milestone "v0.6.0 Data platform", Phases 85 to 101; versions set by the owner on 2026-11-18) and `.planning/REQUIREMENTS.md`; the draft milestone `01-DRAFT-MILESTONE.md` is kept as the record of the proposal.
**Conforms to the coherence review (2026-11-20):** governance facts ride the replica layer as entries and the host is a client of your organization's sync hub plus its own store (no revived Phase 13 log); the policy wizard and source connections become administrator steps of Get Started that end on the one policy editor and write proposals; policy keys move into bundle v2 sections named in `requires` (`labels.classification`, `labels.sourceLabels`, `labels.feedDefaults`, `labels.aggregation`, `data.personalMark`, `data.regimes`, `limits.trainingTargets`); organization rules come from the organization layer (Phase 41), shown as "self-signed on this computer" until it exists; label lowerings and officer overrides use the one authorization record shape with inner signatures; aggregation has one evaluator in `domain/gate` (Phase 38, extended here in Phase 93); officer functions are positions (Phase 33.1) backed by Phase 71 credentials; label checks use the one label service over the active scale table and routing goes through `decideRoute` with the trust line on every answer; local and specialist models are `endpoints[]` entries of class `local` behind `ModelEndpoint` and `LocalServerAdmin`; screens say "Personal: keep out of the catalogue" (not "personal mark"), show scale name plus level and show the organization's Confidential level as "Sensitive"; "relay" means messaging only. Superseded text is kept with dated notes; open questions raised by the rewrite are in section 10.4. See `.planning/research/coherence/REVIEW.md`.

---

## 1. Summary for the owner

**What it is.** Once installed, the platform finds your organization's data on its machines, file shares, Microsoft 365 and Google Workspace. It reads everything once, from the beginning, and then keeps up with every change as it happens, the way a blockchain indexer first reads the whole chain and then follows new blocks. Every item gets a full description card: what it is, where it came from, who may see it, how sensitive it is, how long to keep it and whether it may be used for training. People then search it, ask questions about it, see reports and a map of connections, and turn it into small specialist models trained on your organization's own machines.

**Where the data lives.** Originals stay where they are. A central host (one always-on machine your organization owns, first a Strix Halo box; people see it as part of "your organization's server") keeps the catalog, the extracted text, the search indexes and the graph. Everything there inherits the source's permissions and labels and is deleted when the source item is deleted. Copies of originals are made only for three documented reasons: a capped, encrypted re-extraction cache for scans, images and audio; a write-once hold store for sources that cannot hold data themselves; and none at all for training, because training sets are rebuildable lists of items rather than frozen copies (01 §3.3).

**How it stays safe.** It extends the gate you already have. Detectors only *propose* facts; your organization's rules (the organization layer of the signed policy, from Phase 41) turn facts into a label; every automatic step can only raise a label; only a person lowers one, with a signed reason (02 §1.2). To read anything, a person or agent needs both the label check and the source system's own permission. Everything derived from an item (text, chunks, embeddings, graph edges, summaries, datasets, trained models) carries the highest label of its inputs. Search, graph, dashboards and answers never show, count or hint at anything the asker cannot see (03 §2.3). Everything runs locally; unlabelled content is never sent to a cloud model to find out what it is.

**People only on exceptions.** Policy is set once, in an administrator step of Get Started that ends on the policy editor (it proposes the change; nothing is written until it is applied or, under an organization layer, sent to your organization's security contact): pick label scales, map existing Microsoft 365 and Google labels, choose the strict default for new items, accept the shipped rules after a simulation shows what they would do. After that, people see only real exceptions: lowering a label, a raise that would lock out current users, conflicting signals, unmapped labels, special-category personal data with no covering purpose (02 §7.1). These arrive as a weekly batch per data steward, not one prompt per file.

**Personal data, requests and holds.** Anyone can set their own items to "Personal: keep out of the catalogue"; the platform then keeps only a bare existence record (no content, no title, no readable path). Officers (people posted to the privacy or access officer position) can override only with two signatures, a case, a scope and notice to the person (02 §10). Access-to-information and subject requests, and legal holds, are first-class cases with deadline clocks, a signed chain of custody and an honest statement of what was and was not searched (02 §9).

**The model factory.** An always-on agent watches how the system is used, starting from metadata only (cost, counts, edits), finds narrow repeated expensive tasks, and proposes a specialist on a one-click card. It also notices when a training goal lacks data and plans how to get it. Training is LoRA on small open-weight models, only on machines your organization controls, then tested against the current model, run in shadow, then on a small share of traffic, with one-click rollback (04 §2).

**What it costs in time.** Cloud quotas set the pace of the first read (days to weeks for a 500-person organization); OCR, audio and model work set the pace of processing (weeks). Full model-written graph extraction of a million documents would take about three months on one box, so the design extracts cheaply for everything and spends model time only where it pays (03 §1.2). Most throughput numbers are estimates until the host spike measures them.

**Where it fits.** A new milestone after Stage 1 (Phases 28, 29, 69 to 74) and before the relay (Stages 2 and 3 move after it). It needs one slice of L1 pulled forward (the host stack and local inference, without Theia or the relay). It absorbs the knowledge base of the paused former v0.5.0 knowledge-base plan as its viewing layer.

**Easy from the start.** Connecting Microsoft 365 is one click: an administrator signs in once and setup creates your organization's own app registration in its own tenant, with a certificate generated on the host. Google Workspace and file shares work the same way. Endpoint collectors are small signed native packages that your organization's device-management tools push and enrol with no setup on each machine, and Microsoft 365, Google Workspace and file shares need no collector at all (section 3.7).

**Owner decisions (2026-11-18).** All 14 decisions of section 10.1 are answered: 1 to 13 as recommended, and 14 changed so that connecting a source is one click from the start. The 32 choices of section 10.2 are accepted.

### 1.1 Architecture

```
                YOUR ORGANIZATION'S SOURCES (systems of record, unchanged; each connected in one click)
  Microsoft 365 (SharePoint, OneDrive, Exchange)   Google Workspace (Drive, Gmail)   Shares, databases
          |  delta feeds, labels, ACLs                  |  changes, history, labels      |  snapshots, CDC
          v                                             v                                v
 +--------------------------------------------------------------------------------------------+
 |  ALWAYS-ON HOST (appliance, Strix Halo first, GB10 later)                                  |
 |                                                                                            |
 |  Connector runtime (one-click setup) --> item ledger + cursors (Postgres) --> work queues  |
 |     ^  (sandboxed, broker-signed requests)       |                                         |
 |     |                                            v                                         |
 |  Collector feed,  Extraction workers (sandboxed, no network): Tika, Docling, OCR tiers,    |
 |  share reader     whisper.cpp  --> content-addressed derivatives (encrypted blob store)    |
 |                                                  |                                         |
 |                    Classification: pass 0 rules, pass 1 small models, pass 2 local LLM     |
 |                    --> proposals --> signed policy (gate) --> label (raise only)           |
 |                                                  |                                         |
 |  Governed store: Postgres + pgvector + BM25, RLS = label dominance AND source ACL           |
 |    items, cards, chunks, vectors, mentions, evidence, links, cases, holds, opt-outs       |
 |  Analytics: DuckLake/DuckDB over Parquet partitioned by label (query service only)         |
 |  Hold store (write-once)   Item label Merkle roots per sync batch                          |
 |  Hub client: governance facts as replica entries (labels, lowerings, holds, erasures)      |
 |  Collector enrolment codes and signed collector updates                                    |
 |                                                  |                                         |
 |  Query service (TypeScript engine + the same gate code): search, graph walk, SQL over      |
 |  views, ask, reports. Gate-signed clearance token per transaction.                         |
 |                                                  |                                         |
 |  Model factory: opportunity agent, dataset builder, trainer worker (GPU, capped),         |
 |  evaluator, registrar; llama.cpp serving specialists as `local` endpoints                  |
 +---------------------------------------------^----------------------------------------------+
        ^  mutually authenticated, device-key signed (Phase 69), credentials (Phase 71)
        |                                         |      governance facts <--> your organization's
        |                                         |      sync hub (replica streams, Phases 31 to 35)
 +------+-----------------------+      +----------+--------------------------------------------+
 | ENDPOINT COLLECTORS (Rust)   |      | VS CODE EXTENSION (control panel, no data processing) |
 | signed native packages (MSI, |      | Get Started admin steps (one-click connection), the   |
 | pkg, deb, rpm) pushed by     |      | policy editor, source catalog and status, data map,   |
 | device management; enrol by  |      | exception queue, cases and holds, personal opt-out,   |
 | code; auto-update from host; |      | knowledge base views (search, entity, graph,          |
 | Windows USN, macOS FSEvents, |      | timeline, ask, dashboards), factory cards             |
 | Linux fanotify; skip cloud   |      |                                                       |
 | placeholders; local notice;  |      |                                                       |
 | personal opt-out before fetch|      |                                                       |
 +------------------------------+      +-------------------------------------------------------+
```

> **Superseded 2026-11-20 (coherence review):** the diagram's "Governance log (signed, from paused Phase 13)" box is replaced by the hub client line above (governance facts as replica entries carried by your organization's sync hub) plus the item label Merkle roots kept on the host. "Label-cell Parquet" now reads "partitioned by label", because "cell" is reserved for key groups. Classification "tiers" are called passes in this design so they are not confused with use tiers or routing tiers; research report 02 keeps its own word. "Personal mark" is shown to people as "Personal: keep out of the catalogue" and called the personal opt-out in prose; the policy key stays `data.personalMark`.

---

## 2. Requirements traceability

| # | Owner requirement | Where met |
|---|---|---|
| R1 | Autonomous discovery, every form, first sources, easy new sources | §3.2 connectors and collectors; §3.3 extraction; §3.7 one-click connection and collector install; DATA phases 88 to 92 and 100 |
| R2 | Backfill then real-time sync; reorgs flow downstream; reconciliation; status per source | §4.1 source lifecycle; §4.2 item lifecycle; 01 §1 |
| R3 | Hybrid storage; raw copies only for documented reasons | §5.2 storage rules; decision 10.1-5 |
| R4 | Full metadata on every item | §5 schema |
| R5 | Data-centric security extending the Phase 70 gate | §6 |
| R6 | Personal mark (shown as "Personal: keep out of the catalogue"), existence record, signed officer override | §4.5, §6.6 |
| R7 | Access requests, subject requests, legal holds | §4.3, §4.4 |
| R8 | Analytics, reporting, context graph, ask-anything; the former v0.5.0 KB as the interaction layer | §3.5, KB phases 96, 97 |
| R9 | Model factory, always-watching agent, data-gap planning, own hardware only | §3.6, §4.6, FAC and OPP phases 98, 99 |
| R10 | Feels like magic: policy once, people on exceptions | §6.5, §7 defaults |
| R11 | After Stage 1, before the relay | §8, draft milestone |

---

## 3. Components and where they run

> **Coherence review (2026-11-20):** the governance facts (labels, lowerings, holds, marks, erasures) ride the replica layer as signed entries rather than a revived Phase 13 log; the item label Merkle roots stay on the host. The host is a client of your organization's sync hub for those facts, plus its own store. People call both "your organization's server". See `.planning/research/coherence/REVIEW.md`, conflicts K24 and K25.

### 3.1 Placement summary

| Component | Runs on | Responsibility | Source |
|---|---|---|---|
| Connector runtime | Host | Runs first-party and manifest connectors under one contract (`RECORD`, `STATE`, `DELETE`, `ACL`, `LOG` messages); per-partition cursors; throttle budgets; live sync pre-empts backfill | 01 §1.2, §5 |
| Endpoint collector | Each Windows, macOS and Linux machine, as a small signed native package (not a container); optional on a file server for faster change detection | Fast enumeration (MFT, directory walk), native change journal with a durable cursor, ACL capture, hashes; skips OS folders and cloud placeholders; honours personal opt-outs before fetching; enrols with a code from device management, updates itself from the host, shows a local notice | 01 §4.1, §3.3 point 5; §3.7 |
| Connection setup | Host, with one administrator sign-in | One-click connection for Microsoft 365, Google Workspace and file shares: creates your organization's own app registration or service account, a credential generated on the host and held in the broker, admin consent; re-runnable, self-rotating, undone only on the administrator's confirmation | §3.7 |
| File-share reader | Host | Reads SMB and NFS shares with nothing installed on the file servers; change notifications as hints, snapshot diffs as the feed | 01 §4.2; §3.7 |
| Collector enrolment and update service | Host | Issues scoped, expiring enrolment codes; binds each enrolled collector to a device credential (Phase 71); serves signed, staged collector updates | §3.7 |
| Item ledger and cursor store | Host, Postgres | Identity key `(source, item)`, version key, idempotent upserts, cursor advanced in the same transaction as the batch, outbox for side effects | 01 §1.4 |
| Extraction workers | Host, sandboxed containers with no network | Tika (breadth, forked parsers), Docling (layout, tables), tiered OCR, whisper.cpp; derivative key `(content hash, extractor, version, options)` | 01 §2.2 |
| Classification workers | Host | Pass 0 rules and detectors; pass 1 span models; pass 2 local LLM only where needed | 02 §1.5 |
| Gate (policy decision point) | Host query service, the hub and the extension, same pure TypeScript code | The one label service (`dominates`, `join`, `atLeast` over the active policy's scale table, never its own ranking), classification rules, source-ACL layer, routing through `decideRoute`, `TrustFacts`, decision records | 02 §1.4; coherence `POLICY-SCHEMA.md` 6 |
| Governed store | Host, Postgres with RLS | Items, cards, chunks, vectors, mentions, evidence, links, cases, holds, personal opt-outs; every row labelled | 03 §1.4, §2.3 |
| Analytics store | Host, DuckLake (Parquet, Postgres catalog) | Analytical tables written per label partition; only the query service reads it | 01 §2.3, 03 §3.1 |
| Blob store and caches | Host, encrypted, content-addressed | Derivatives, bounded re-extraction cache | 01 §3.3 point 2 |
| Hold store | Host, write-once | Originals from sources with no hold feature, with signed manifests | 02 §9.7 |
| Governance facts | Host as a client of your organization's sync hub, plus its own store | Labels set by people, lowerings, holds, personal opt-outs, overrides and erasures are replica entries on the data platform's streams, signed by the person's device key or credential and carried by the hub like any shared fact; the host keeps the item label store with a signed Merkle root per sync batch and its own encrypted snapshots | coherence K24, K25; ADR-011 |
| Governance log (superseded) | Host | Signed append-only record of labels, lowerings, links, holds, marks, erasures (paused Phase 13 log, envelope v2). **Superseded 2026-11-20 (coherence review):** replaced by the governance facts row above; the Phase 13 log is not revived | 03 §4 row 13 |
| Query service | Host | Hybrid search, graph walk, NL-to-SQL over curated views, ask agent tools, reports; sets the clearance through a gate-signed token | 03 §2.2, §3.2 |
| Model factory | Host (trainer on GPU) | Dataset builder, trainer worker, evaluator, registrar, serving | 04 §2.2 |
| Opportunity agent | Host, under a run contract | Signals, clustering, scoring, proposals, data-gap plans | 04 §7 |
| Extension | Each person's editor | Control panel only: administrator steps of Get Started, the policy editor, status, data map, queues, cases, KB views, cards; renders capped, host-built results through the webview kit under its one CSP; every answer carries the trust line | 03 §3.3; coherence `EXPERIENCE.md` 1, 3 |

### 3.2 Discovery and connectors (R1, R2)

First-party connectors for Microsoft 365, Google Workspace, endpoints and shares, written against vendor APIs on our own small contract; dlt and Debezium Server for databases later (01 Summary). Order of first sources and their feeds: 01 §1.1. Key points:

- **Microsoft 365:** connected in one click (§3.7). Per-drive delta, `Prefer: hierarchicalsharing` so permissions are read only at permission roots (permission reads cost 5 resource units each; 01 §4.3), separate identity sync for users and groups, mailbox delta with immutable ids, Exchange RBAC for Applications to scope mail, `Sites.Selected` where admins refuse tenant-wide scopes.
- **Google Workspace:** connected in one click (§3.7): a service account with domain-wide delegation created in your organization's own Google Cloud, `changes.list` per user and shared drive, Gmail `history.list`. Start the live cursor *before* the backfill so long mailboxes never fall outside the history window (01 §1.2).
- **File shares:** read from the host over SMB and NFS with nothing installed on the file servers (agentless, owner 2026-11-18); SMB change notifications are hints only, snapshot diffs are the feed (01 §4.2); a collector on a file server is optional, for faster change detection.
- **Endpoints:** the collector, installed and enrolled through device management (§3.7), for files that live only on a machine.
- **Notifications:** poll by default (no public endpoint needed); push is an optional low-latency mode (01 §4.3).
- **Easy new sources:** connecting a source is an administrator step registered with Get Started (`{ id, title, state(), viability(), run() }`), never its own setup command; a source catalog with plain descriptions and exact scopes, one-click connection per cloud (§3.7), a scope picker, an inventory-only dry run first; declarative manifests for REST sources; agent-written connectors run sandboxed with broker-injected credentials and must pass a conformance suite and a person's approval (01 §5).

### 3.3 Extraction (R1)

Tika 4 for breadth (including MSG and PST without GPL code), Docling for structure, tiered OCR (CPU OCR for clean scans, a small Apache-2.0 vision model only for hard pages), whisper.cpp for audio (01 §2.2). Workers are sandboxed, have no network and have size and time limits (01 §7). The UI shows *sync lag* and *processing backlog* separately so a slow OCR queue is never mistaken for a broken connector (01 §1.6).

### 3.4 Classification and tagging (R4, R5)

Three passes (02 §1.5 calls them tiers; this design says passes so the word is not confused with use tiers or routing, and no screen shows either): pass 0 for every item (format, hashes, source label, source ACL, retention label, secret rules, checksum-backed PII patterns including Canadian identifiers we write ourselves, 02 §2.1); pass 1 for every text item (union of spans from GLiNER and a second small Apache-2.0 privacy classifier, language, near-duplicate signature, embedding); pass 2 only for unsettled items, audit samples and items about to be used (local LLM, three samples, majority vote, constrained JSON, policy never in the prompt). Owner and steward are never guessed by a model (02 §2.3). The local models these passes use are `endpoints[]` entries of class `local` on the host, reached through `ModelEndpoint` and installed and hash-checked through `LocalServerAdmin` (ADR-005, ADR-006); the rules that turn facts into labels live in the `labels.classification` section (section 6.2).

### 3.5 Knowledge layer (R8)

Evidence rows over the governed store, not a separate graph database (03 Summary). Entities and edges have no stored attributes; they are computed at read time from the rows the reader may see. A cheap first pass for everything (chunks, embeddings, small-model entity tags, noun-phrase co-occurrence); LLM relation extraction with quote-verified spans only on priority items, under the spend governor; graph reasoning at question time inside the asker's clearance (LazyGraphRAG pattern). Entity resolution is proposals with undo, never destructive merges (03 §1.3). Hybrid search is BM25 plus vectors fused by reciprocal rank with pgvector iterative scans (03 §2.2). Dashboards are native webview components fed by host-built, label-filtered results (03 §3). Day-one views: estate map, one search box, entity pages, ask, suggested insights; graph, map and timeline from search results (03 §5.2).

### 3.6 Model factory and opportunity agent (R9)

LoRA adapters on 4B to 14B Apache-2.0 or MIT bases, Unsloth core plus TRL/PEFT in a pinned container, served by llama.cpp as an `endpoints[]` entry of class `local` behind the `ModelEndpoint` interface, so a specialist appears under "Models by job" and its answers read "Runs on your organization's server" in the trust line (04 §2.1 D1 to D5). (The earlier wording "through the existing local and hybrid provider" predates the provider interface; superseded 2026-11-20 by the coherence review, ADR-005.) The trainer is a separate worker on the host, never Python in the extension host (D6). The opportunity agent reads metadata first and content only after an approval whose clearance dominates the data (D7). Dataset and model labels are joins (D8). Deletion is honoured by retraining from the manifest (D10). Training happens only on your organization's own machines or hardware endpoints it controls, each listed as a training target in the signed policy (owner, 2026-11-18; the list is `limits.trainingTargets` in bundle v2, naming endpoint ids); no training service is used. A specialist is used only for the uses its model approval covers (the `models` section from Phase 41, model provenance design), like any other model.

**Data-gap planning (R9, added here).** For an approved goal the agent computes the feasibility gates of 04 §7.3. When the *examples* or *labels* gate fails, it writes a data plan instead of a dead end: which catalog facets already hold candidate items (by document type, function, topic, training suitability), which known but unconnected sources might (from discovery and the coverage inventory), how many items are blocked by `no-train`, unknown rights or personal opt-outs (counts only), and the cheapest ways to close the gap (connect a source, ask stewards to confirm rights on a collection, collect accept or edit signals for N more weeks, build a golden set of 50 items, or synthesize from labelled documents). Each option is a proposal card; acquiring data never bypasses rights, personal opt-outs or labels.

### 3.7 One-click connection and collector install (owner, 2026-11-18)

Decision 14 as the owner changed it ("easy from the start"), and the owner's direction that collectors be super simple to install.

Where it lives (coherence review, 2026-11-20): each "Connect ..." flow below is an administrator step of Get Started, also reachable from the data map, and it ends on the policy editor. Connecting a source changes no policy by itself; anything it needs in the policy (the source label map in `labels.sourceLabels`, feed defaults in `labels.feedDefaults`, the source's scopes) arrives as a proposal with its effect in plain words, applied on a personal layer or sent to your organization's security contact under an organization layer.

**Connecting a source.**
- **Microsoft 365.** One-click "Connect Microsoft 365". An administrator signs in once. Setup then creates your organization's own app registration in its own tenant, uploads a certificate generated on the host (the private key never leaves the host and is held in the credential broker), and grants admin consent for exactly the permissions the wizard listed, each with its reason. The administrator's sign-in is used only during setup, held in memory and dropped when setup ends. The app adds its next certificate itself before the current one expires, with no new sign-in. `Sites.Selected` and Exchange RBAC for Applications scoping stay available for administrators who want narrower access (mail is off by default, decision 6).
- **No shared multi-tenant app.** We do not publish one: its publisher-held credential could reach every customer tenant, so a compromise of ours would become a compromise of every customer. Nothing of ours has to exist in your organization's tenant before setup, and nothing outside your organization can use what setup creates.
- **Google Workspace.** The same one click: an administrator signs in once; setup creates a project and a service account in your organization's own Google Cloud, enables only the needed APIs, creates the credential on the host and keeps it in the broker (short-lived or keyless where the phase 90 research finds it workable), and authorizes exactly the listed scopes for domain-wide delegation. A step Google allows only in its admin console is one prefilled page that setup opens and then checks.
- **File shares.** One click too: the host finds the SMB and NFS shares your organization publishes (its directory and DFS namespaces), an administrator picks them and signs in once, setup uses a dedicated read-only account kept in the broker, and the host reads the shares with nothing installed on the file servers.
- **Every connection** can be re-run (it adds only what is missing), says honestly what a half-finished setup did and did not do, reads nothing until setup is finished, and finishes on re-run without duplicating anything. Disconnect lists what setup created and removes it only after the administrator confirms.

**Installing collectors.**
- **The host is a container stack**, installed with one command from a signed offline bundle (phase 85).
- **Endpoint collectors are not containers.** They are small signed native packages: an MSI for Windows, pushed silently by Intune or Group Policy; a signed and notarized pkg for macOS, pushed by Jamf or Intune together with the Full Disk Access profile; .deb and .rpm packages for Linux; and, for a machine without device management, a one-line install that checks the package signature first.
- **Zero-config enrolment.** Your organization's device-management tools deliver an enrolment code issued by the host (an MSI property, a managed configuration profile, or an install argument). On first start the collector creates its own device key, enrols with the code and receives a device binding credential (Phase 71). Nobody types anything on the machine. Codes are scoped to a device group, limited in number, expiring and revocable, and every new device appears in the source list.
- **Automatic updates.** Signed updates are served by the host, staged, with rollback; the host refuses collectors below a minimum version. An update never widens what is collected; that takes a policy change.
- **A local notice** on each machine says in plain words what is collected, what is excluded and who can see it, with "Personal: keep out of the catalogue" one click away.
- **Small and removable.** Low CPU, memory and network budgets, paused on battery and metered connections by default. Revoking the device or removing it in device management stops collection at its next contact; uninstalling removes the collector and its local state.
- **Agentless where possible.** Microsoft 365, Google Workspace and SMB or NFS shares are read from the host with no software on endpoints or file servers. Collectors are needed only for files that live only on endpoints.

Requirements: SPIKE-09, CONN-01 to CONN-04 and COLL-01 to COLL-06 in `.planning/REQUIREMENTS.md` (phases 86, 89, 90 and 91).

---

## 4. Data flow and the state machines

Every state below has a label at all times, an owner, a visible reason, and a way out; nothing waits silently (02 §1.3, 04 §2.3).

### 4.1 Source lifecycle

States the owner named, mapped onto per-partition phases (01 §1.2):

| State | Meaning | Enters from | Leaves to (trigger) |
|---|---|---|---|
| `proposed` | Discovered by a scan or added from the catalog; inventory-only dry run allowed (names, sizes, counts, label counts) | (new) | `approved` (admin approves scopes and policy once); `retired` (rejected) |
| `approved` | Scopes granted, credential in the broker, policy applies | `proposed` | `backfilling` (scheduler; live cursor captured first) |
| `backfilling` | Full history being read; live tail already running from the captured cursor | `approved`, `degraded` (full resync) | `live` (every partition caught up, 01 §1.6); `degraded`; `paused` |
| `live` | Change feeds within the freshness target; catch-up, id-set diff and full re-verify sweeps on schedule | `backfilling`, `degraded` | `degraded` (any "you missed something" signal: Graph 410, Gmail 404, journal wrap, queue overflow, stale ACL snapshot, auth failure, throttling over budget); `paused`; `retired` |
| `degraded` | Still serving what it has; at least one partition resyncing, failing or stale. ACL-stale items fail closed | `live`, `backfilling` | `live` (resync done); `backfilling` (token expired, full re-read); `paused` (admin) ; stays visible with reason and age |
| `paused` | Admin paused, or credential revoked, or host maintenance; cursors kept | any active | `live` or `backfilling` (resume; resync if cursor expired) ; `retired` |
| `retired` | Source removed. Derivatives purged after grace unless held; existence and coverage records kept | any | (end) |

Partition phases (`discovering`, `backfilling`, `tailing`, `resyncing`, `paused`, `error`) roll up into the source state; the panel shows phase, backfill progress, sync lag, processing backlog, last event, throttle state and coverage (01 §1.6). New partitions (new site, new mailbox, new shared drive) are discovered daily and start in `backfilling` without a new approval when they fall inside approved scopes.

### 4.2 Item lifecycle

Merged from 01 §1.3 to §1.5 and 02 §1.3:

```
discovered --> fetched --> extracted --> scanned --> proposed --+--> labelled --> indexed
   |  (personal opt-out known)                                    |       |   (chunks, vectors, graph)
   v                                                             v       v
personal (existence record only)                              exception  stale --> proposed (rescan, never lowers)
                                                                 |
tombstoned (deleted or out of scope at source; hidden at once) --+--> purged after grace (recycle-bin window)
       |                                                                   unless held
       +--> held (derivatives kept, marked source-deleted-during-hold)
```

- **Label at every step.** `discovered` already carries join(mapped source label, ingest default). Stuck items are invisible to people below the default, never exposed.
- **Reorgs.** Delete: hide at once, purge derivatives after the source's restore window, mark datasets "contains revoked items". Restore: un-hide, reuse derivatives if the hash is unchanged. Move or rename: update in place, recompute inherited ACL. Permission change: recompute effective ACL for the subtree before the next query. Group change: identity sync. Label change: re-evaluate policy; a source lowering only files a "could be lower" suggestion (01 §1.3, 02 §4.3).
- **Exactly-once effect** through identity key, version key, derivative key and outbox (01 §1.4).
- **Erasure** cascades along `derivedFrom` to text, chunks, vectors, mentions, evidence, links, dataset rows and caches, and moves models trained on it to `retrain-required` (§4.6).

### 4.3 Hold lifecycle

From 02 §9.7:

| State | Leaves when |
|---|---|
| `draft` (custodians, sources, dates, topics) | Signed by the person posted to the hold administrator position (Phase 33.1), with a Phase 71 credential once that exists |
| `issuing` (applied per source; each shows `pending` until confirmed; M365 can take 24 hours) | All confirm: `active`; any fails or has no hold feature: `partial` |
| `partial` (write-once copy running or a source failed; visible warning; never times out silently) | Fixed: `active` |
| `active` (preserved; change monitoring; custodian notices and acknowledgments; derivatives held along lineage; CleanUp never-touch) | Release proposed: `release-proposed` |
| `release-proposed` | Signed: `released` |
| `released` (source holds removed, our suspensions lifted, normal retention after a grace period) | (end) |

### 4.4 Request lifecycle (access-to-information and subject requests)

Designed here from 02 §9.1 to §9.6:

| State | Meaning | Leaves when |
|---|---|---|
| `received` | Regime chosen; clock starts per the regime's rule in the signed policy (`data.regimes`) | Officer accepts: `scoping`; out of scope: `closed` with reason |
| `scoping` | Subject resolved to identifiers, or topic defined; recusal check; request-scoped, time-boxed grant issued | `searching` |
| `searching` | Our indexes plus live source searches; cursor age recorded; lineage followed to derivatives and models | `reviewing` |
| `clock-stopped` | Only where the regime allows (fee, clarification) | Answer received: back to the prior state |
| `extended` | Extension recorded *after* its notice is sent, within the allowed window | Back to the prior state with the new due date |
| `reviewing` | Relevance, exemptions; two-person rule above the officer's clearance | `redacting` |
| `redacting` | Proposed redactions confirmed one by one with exemption codes; burned in | `release-proposed` |
| `release-proposed` | Package label is the join of its contents | Signed package declassification (a `declassify` authorization record, below): `released` |
| `released` | Package, manifest root signed, custody log, coverage statement | `closed` |
| `closed` | Grant expires, case derivatives destroyed unless held | (end) |

Deadline warnings at 50, 80 and 95 percent of time used. A late case shows `overdue` as a flag on whatever state it is in, never as a silent state.

### 4.5 Personal opt-out ("Personal: keep out of the catalogue") and override lifecycle

People see one control, **Personal: keep out of the catalogue**, and its undo, "Put back in the catalogue". The policy key stays `data.personalMark` and the state names below are internal; no screen says "mark".

Opt-out: `unmarked` to `marked` (the person signs with their device key; refused at once if the policy forbids the place) to `unmarked` (re-enters at the ingest default, label never lower than before). Each change is a replica entry on the data platform's governance stream.

Override (02 §10.4): `filed` (officer, case, basis, scope, duration) to `approved` (second officer; both sign) to `notice-pending` or `notice-sent` (default: notice at override time; delay only with a recorded reason and a latest date, visible to the privacy officer) to `expired` (case derivatives destroyed unless held). The officers are the people posted to the privacy officer and access officer positions (Phase 33.1); they sign with their device keys now and their Phase 71 credentials later. The approved override uses the one authorization record shape (`POLICY-SCHEMA.md` 2): subject the item or scope, the case as evidence, an expiry, and an inner signature from each of the two named people, whose keys the organization layer lists. Until an organization layer exists every such record is shown as "self-signed on this computer". Which kind and where the records live is open question 10.4-1.

Lowering a label is the same shape with kind `declassify` (one named person, a reason, the item as subject), shown as "Lowered by {name} on {date}: {reason}" in "Why this label".

> **Superseded 2026-11-20 (coherence review):** "both sign with role credentials" assumed Phase 71 role credentials as the only authority. Authority now lives on the position (one delegation rule, Phase 33.1), with the credential wrapping it from Phase 71; the two-signature rule itself is unchanged.

### 4.6 Specialist lifecycle

As 04 §2.3: `candidate`, `proposed`, `approved`, `building-dataset`, `dataset-ready`, `training`, `evaluating`, `shadow`, `canary`, `live`, `retrain-required`, `rolled-back`, `retired`, plus `infeasible` which now links to a data plan (§3.6) rather than ending.

---

## 5. Metadata schema (merged and concise)

One **item card** per item; the card carries the item's label, so titles, summaries and entities are never shown to someone who cannot see the item (02 §8). Set by: A automatic, A/H automatic with a person on exception, H person only. Full field tables: 02 §8.1 to §8.7; storage tables: 03 §1.4; ledger: 01 §1.2. Labels on the card are shown as scale name plus level ("Organization: Internal"; the organization's Confidential level is shown as "Sensitive", id unchanged).

| Layer | Fields (concise) | Set by |
|---|---|---|
| Identity | `id` (hash of system, tenant, source item id), `source.{system, tenant, container, path, url}`, `sourceItemId` (stable across rename), `version`, `contentHash` | A |
| Descriptive | `title`, `summary`, `topics[]` (organization taxonomy), `entities.{people, customers, products, projects}` as graph ids, `language`, `documentType` (closed list), `businessFunction`, `businessProcess`, `owner`, `steward`, `created`, `modified` | A; function, process, owner, steward A/H |
| Technical | `mediaType` (magic bytes), `byteSize`, `pageCount`, `wordCount`, `schema.columns[]` with semantic types, `rowCount`, `qualityScore`, `freshness`, `exactDupOf`, `nearDupCluster` | A |
| Provenance | `derivedFrom[]` with relation, `ingest.{firstSeen, lastSynced, cursorRef}`, `pipeline.{extractorVersion, classifierVersions}`, OpenLineage-shaped run records | A |
| Usage | `access.{count30d, lastAccessed}`, `usedBy.groups[]` (groups only; named-person usage stays in the local decision log), `readByRuns[]` | A |
| Security | `label[]` (one per scale), `labelEvidence`, `sourceLabels[]`, `sourceAcl.{principals, linkScopes, inherited, capturedAt}`, `handling[]` (adds v2 `no-train`, `no-summarize-down`), `secrets.{count, types}`, `exception` | A; lowering H |
| Privacy | `personalData`, `categories[]`, `specialCategories[]`, `dataSubjectTypes[]`, `subjectCountEstimate` (bucketed), `identifiability`, `jurisdictions[]`, `sourceResidency`, `processingActivityRef`, `retentionClassRef`, `assessmentRefs[]`, `evidence`, `fingerprints[]` (salted, local), `reviewedBy` | A; special categories, processing activity A/H. Facts about personal data, never the data itself (02 §3.2) |
| Lifecycle | `retentionClass`, `retainUntil`, `holds[]`, `rot.{redundant, obsolete, trivial}`, `disposition` | class A/H; disposition H only |
| Training | `training.{rights, allowed, quality, taskFit[], dedupCluster, inheritedModelLabel}`; `rights.basis = unknown` means not allowed | A/H; `allowed` computed |
| Personal | `personalMark.{scope, markedAt, markSig, overrides[]}` (field names internal; screens say "Personal: keep out of the catalogue"); an opted-out item keeps only the existence record of 02 §10.3 | H (the person) |

Standards borrowed, not adopted as systems: DCAT 3 and Dublin Core terms for descriptive fields, PROV and OpenLineage facets for lineage, Croissant and ODRL for training rights, TDMRep for opt-outs, OpenMetadata's mutually exclusive classifications and tag mapping, DataHub's split of tags, glossary terms and typed properties (02 §5).

### 5.1 Storage tables (host)

`source`, `source_cursor` (01 §1.2), `item`, `item_card`, `item_acl`, `principal`, `group_member` (directory snapshot), `label` (precomputed level and compartment bitset), `chunk` (with vector and BM25), `mention`, `entity`, `mention_entity`, `relation_evidence`, `entity_link` (03 §1.4), `derivation`, `case`, `hold`, `custody_event`, `personal_item`, `dataset_manifest`, `model_card`, `outbox`. Every row has `label_id`; RLS on every table.

### 5.2 Storage rules (R3)

- Originals stay in the source. The central layer is treated with the same controls as a raw copy, because extracted text is a copy for legal and privacy purposes (01 §3.3 point 1): disk encryption, ACL inheritance, holds, erasure.
- Raw copies only: (a) a bounded, encrypted, content-addressed **re-extraction cache** for scans, images and audio, with a size cap and TTL, deleted with the source; (b) the write-once **hold store**; (c) a raw training snapshot only as a rare exception with explicit approval. Training sets are **manifests** (item ids, versions, hashes, extractor and code versions); an erasure publishes a new dataset version and revokes the old one (01 §3.3 points 2 and 3).
- Endpoint-only files (not in a synced cloud folder) are indexed like any source, flagged in coverage as "may disappear", and are not copied except under a hold (01 §3.3 point 4).
- Governance events are replica entries carried by your organization's sync hub; the host keeps content-addressed encrypted snapshots and the item label Merkle roots in its own store, not all content; the query store is a disposable materialization (03 open question 1).

> **Superseded 2026-11-20 (coherence review):** the line above used to read "The signed governance log holds governance events and content-addressed encrypted snapshots". The decision it records (10.2-2: governance events plus encrypted snapshots, sources stay the system of record) stands; only the carrier changed from a revived Phase 13 log to replica entries (ADR-011).

---

## 6. Security model: how it extends the gate

### 6.1 The rule

Detectors propose facts; signed policy turns facts into a label; automatic steps only raise; only a person lowers, signed; access needs both the label check and the source permission (02 §1.2).

The signed policy is policy bundle v2 (`POLICY-SCHEMA.md`). The data platform's rules sit in the organization layer, signed by your organization's pinned issuer (Phase 41); a person's personal layer and a project's layer can only narrow them. Until an organization layer exists the rules are this computer's own and every screen that cites them says "self-signed on this computer", as the interim rule requires. Every section this design adds is named in `requires`, so an older extension says "update" rather than failing or suggesting a Reset.

### 6.2 Gate changes

> **Coherence review (2026-11-20):** aggregation rules have one evaluator in `src/domain/gate/`, built by Phase 38 (portfolio) and extended by Phase 93, with one schema carrying `effect` and `remedy`; a chat label raised by a count rule is a routing input and is recorded. See `.planning/research/coherence/REVIEW.md`, conflict K27.

All in the pure gate core, so the extension and the host run the same code (02 §1.4):

| Change | Purpose |
|---|---|
| Classification rules in the `labels.classification` section of bundle v2 (`facts -> minimum label`, `requires: classification@1`), new pure `classify.ts` | Policy set once; detectors replaceable |
| Source label map in `labels.sourceLabels` (explicit per label id; unmapped, unreadable and double-key encrypted map to the strictest level) and ingest defaults in `labels.feedDefaults` | Read Purview and Drive labels and never lower them |
| Item label store with a signed Merkle root per sync batch, kept on the host | Millions of items, tamper evidence without a signature per row |
| Label v2 handling flags `no-train` and `no-summarize-down` (beside v1, D-22) | Training is a new use |
| Every dominance and join check calls the one label service (`dominates`, `join`, `atLeast` over the active policy's scale table, `src/domain/gate/labels.ts`); no data platform module ranks labels itself or imports `SCALE_PRESETS` (architecture test) | One label algebra (ADR-004, REVIEW S7) |
| `source.acl` layer in `decide` after labels; agent access = agent clearance ∩ person clearance ∩ person's source ACL, where person clearance is the meet of the personal-layer clearance and the roster clearance for that project | Intersection, never union |
| `derived.ts`: every derivative takes the join of its inputs | Chunks, vectors, summaries, edges, datasets, models |
| Aggregation rules on indexes, exports, datasets and a chat's running count of distinct items, in `labels.aggregation`, each with an `effect` and a `remedy`, run by the one aggregation evaluator in `src/domain/gate/` that Phase 38 builds and Phase 93 extends; a chat label raised by a count rule is recorded and feeds routing | Many "Organization: Internal" items can be "Organization: Sensitive" together (02 §11.3) |
| Personal opt-out rules in `data.personalMark`; request and erasure regimes in `data.regimes` | §4.4, §4.5, §6.6 |
| Lowerings and overrides as authorization records with inner signatures (§4.5) | One exception record |
| `cases.ts`, `holds.ts`, `personalMark.ts`; hold check in every deletion path including CleanUp | §4.3 to §4.5 |
| New event ids named before they ship (D-49): `label.auto-raised`, `label.source-mapped`, `label.exception-queued`, `label.exception-resolved`, `label.could-be-lower`, `personal.opt-out-set`, `personal.override`, `hold.applied`, `hold.change-observed`, `hold.released`, `case.release` | Every automatic raise has a decision record |

> **Superseded 2026-11-20 (coherence review):** the event ids `mark.personal-set` and `mark.override` are renamed `personal.opt-out-set` and `personal.override` before they ship, because "mark" now means nothing on its own (glossary, section 4). Nothing has shipped under the old ids. "Classification rules in the signed bundle", "source label map in the bundle" and the aggregation row above were written as new v1 keys; they become the v2 sections named in each row.

### 6.3 Enforcement points

- **Host database:** Postgres RLS on every table with `FORCE ROW LEVEL SECURITY`; the application role owns nothing and has no bypass; the clearance is set only through a `SECURITY DEFINER` function that verifies a short-lived token signed by the gate, never by plain `SET`; views are `security_invoker`; only `LEAKPROOF` functions in predicates (03 §2.3).
- **Filter inside the index scan:** the label and ACL predicate is part of every vector and keyword query (pgvector iterative scans; partitions per label routing level); never post-filter (02 §6.4, 03 §2.3 rule 4).
- **No side channels:** no raw SQL connections for people or agents, no `EXPLAIN`, no pre-filter totals, no "N results hidden", caches keyed by clearance, no cross-label precomputed summaries (03 §2.3 rules 5 and 6).
- **Model-written SQL** is parsed to a SELECT over curated views with a row limit and timeout and still runs under RLS, so a wrong query can be wrong but never wider (03 §3.2).
- **DuckDB has no RLS:** only the query service opens analytics files, written per label partition (02 §6.3).
- **Routing:** the chat's label (the highest label of everything read, which only goes up unless a person lowers it with a reason) goes into the one decision function, `decideRoute(label, use, endpoint, authorizations, residency, passport, clearance)`, which decides which model may see the result; the extension, the host query service and the hub run the same function. Every answer carries the trust line (Runs on, Verified, Allowed), and "Why this label" shows the items and rules that raised the chat's label.
- **Crypto below, RLS above:** devices that store data receive only the label key groups they hold keys for (later, with L5 hub federation); the shared host relies on RLS (03 §2.3 rule 8).

> **Superseded 2026-11-20 (coherence review):** the routing line used to read "the session high-water mark of everything read decides which model may see the result (Phase 70 routing tiers)". The rule is unchanged; it is now worded with the glossary's "chat's label" and runs through `decideRoute` (Phase 41) instead of the Phase 70 tier lookup alone.

### 6.4 Source ACLs

Stored as principal ids; groups expanded at query time from a directory snapshot synced on its own fast schedule; full permission rescans on a schedule; fail closed when an item's ACL snapshot is older than the limit (24 hours default) except for principals named directly; "anyone with the link" does not count as everyone for agents by default (02 §6.5).

### 6.5 Exceptions only (R10)

What reaches a person and how (02 §7): the list in §1 above, ordered by impact (people who would lose access × uncertainty × level), grouped by steward into a weekly batch, with bulk actions on near-duplicate clusters. Every new or changed rule is a proposal in the policy editor and runs first in shadow mode over a sample ("would raise N items, would block M people from K items"), shown as the proposal's effect, before anyone can apply it. A weekly stratified blind sample measures precision and recall per level; targets: recall at least 0.95 at "Organization: Sensitive" (id `org/Confidential`) and the equivalent levels of other scales and above, precision at least 0.80 on levels that block access; a missed target widens the review band automatically (02 §7.3).

### 6.6 Personal opt-out ("Personal: keep out of the catalogue")

Only the person sets it; agents cannot. Allowed only in the person's own areas, bounded by the `data.personalMark` section of the policy (`allowed, scopes, locationOnly, quotas, forbiddenContainers, overrideRoles, notice defaults`; `overrideRoles` names positions, not people). The opt-out changes processing, never protection: the item keeps its label, where it may be routed, and its ACL. Abuse is detected from existence records and metadata only (volume, timing after a hold notice, sharing, origin, hash match), with escalation from a private notice to counts for the privacy officer to sampling only under an override (02 §10.5).

### 6.7 Clearances

Stage 1 delivers verified clearances and roles (Phase 71), so this platform does not ship on self-declared clearances. Officer roles (access officer, privacy officer, hold administrator, model owner) are Phase 71 credentials. Until a role credential exists for a person, that function runs in the source system's own tools and our layer shows metadata and coverage only (02 §9.6, §11.8).

Coherence review (2026-11-20): the officer functions are **positions** on the people list of your organization's data platform project (Phase 33.1), with the mode word for each from `term()`; a person is posted to a position and the Phase 71 credential wraps that posting. Standing delegations (for example a data owner's delegation per compartment, 10.2-25) follow the one delegation rule: a subset of what the delegator holds, with scope, expiry and depth. Effective clearance is the meet of the personal-layer clearance and the roster clearance, and is shown in "Why this label". The rule that the platform does not ship on self-declared clearances is unchanged.

---

## 7. Recommended stack

Only Apache, MIT, BSD, PostgreSQL, ISC, and LGPL dynamically linked; a licence check in CI covers code and model weights (01 §7).

| Layer | Choice | Licence | Source |
|---|---|---|---|
| Connector contract | Our own, shaped like the Singer message protocol | ours | 01 Stack |
| Microsoft 365 and Google connectors | First-party on the official Graph SDK for Python and Google API clients | MIT, Apache-2.0 | 01 Stack |
| Endpoint collector | Small Rust agent, shipped as signed native packages (§3.7) | ours | 01 Stack |
| One-click connection | Microsoft Graph application and service principal APIs through one administrator sign-in; Google Cloud Resource Manager, Service Usage and IAM APIs | vendor APIs | §3.7 |
| Collector packages | MSI, signed and notarized pkg, .deb and .rpm built in our release pipeline (cargo-deb, cargo-generate-rpm, Apple's pkgbuild and notarytool; the MSI build tool is chosen in phase 91 research, with the WiX Toolset's licence and terms to verify). Build tools only: nothing of theirs ships inside the collector | MIT (cargo-deb, cargo-generate-rpm); others to verify | §3.7 |
| Collector updates | Signed update metadata in the style of The Update Framework, served by the host; the Rust client is chosen in phase 91 research | to verify | §3.7 |
| Databases | dlt (backfill, cursor columns), Debezium Server (CDC, no Kafka) | Apache-2.0 | 01 §2.1 |
| Extraction | Apache Tika 4 server; Docling | Apache-2.0; MIT | 01 §2.2 |
| OCR | Tesseract or PP-OCRv5 on CPU; PaddleOCR-VL 0.9B or granite-docling-258M for hard pages | Apache-2.0 (weights too) | 01 §2.2 |
| Audio | whisper.cpp, large-v3-turbo, Vulkan or ROCm | MIT | 01 §2.2 |
| Dedup | BLAKE3 or SHA-256; datasketch MinHash LSH | CC0/Apache-2.0; MIT | 01 Stack |
| PII and entities | Presidio (frame, checksum recognizers); GLiNER `gliner_multi_pii` and GLiNER2; a second Apache-2.0 privacy-filter token classifier | MIT; Apache-2.0 | 02 §2.1 |
| Secrets | gitleaks rule set as data beside `src/team/secrets.ts` | MIT | 02 §2.2 |
| Local LLM and embeddings | llama.cpp server; Qwen3.5 or Qwen3.6 class instruct models; Qwen3-Embedding-0.6B; Qwen3-Reranker-0.6B | MIT; Apache-2.0 | 03 §1.2, 04 §4 |
| Control plane and serving store | Postgres 18 with RLS, pgvector 0.8+, pg_textsearch (BM25) | PostgreSQL | 03 §2.2 |
| Graph | Plain Postgres tables plus recursive CTEs; Apache AGE optional later | PostgreSQL; Apache-2.0 | 03 §2.1 |
| Analytics | DuckDB 2 with DuckLake 1.0; Iceberg export kept as an option | MIT | 01 §2.3 |
| Lineage | OpenLineage event shapes in Postgres | Apache-2.0 | 01 §2.3 |
| Entity resolution | Splink for tabular records (check its dependency tree), our LLM group judge for text | MIT | 03 §1.3 |
| Dashboards | Mosaic vgplot (licence to verify) and Perspective in the webview | BSD-3 (verify); Apache-2.0 | 03 §3.1 |
| Hold store | Our own content-addressed encrypted store with signed manifests on an immutable filesystem target; an S3 Object Lock compatible target your organization already runs is optional | ours | 02 §9.7 (see 10.2-14) |
| Training | Unsloth core plus TRL and PEFT, pinned container per host; LLaMA-Factory as a manual escape hatch | Apache-2.0 | 04 §3.1 |
| Base models | Qwen3.5 or Qwen3.6, Gemma 4, Phi-4; Llama-licensed bases blocked by default | Apache-2.0, MIT | 04 §4 |
| Evaluation | The extension's benchmark and graders; lm-evaluation-harness subsets | project; MIT | 04 §6.1 |
| Specialist serving | llama.cpp with per-request LoRA; vLLM multi-LoRA on GB10 later | MIT; Apache-2.0 | 04 §6.4 |

**Avoid** (01 §Stack, 02 §2.2, 03 Risks, 04 §8.4): ELv2 connector platforms and connectors, Nango, Marker and Chandra weights, MinerU, GPL email parsers, Sling, archived projects (Airweave, Kùzu, Amundsen, Vanna), MarkItDown's web-service extras, TruffleHog verification, Neo4j Community, Memgraph, FalkorDB, ParadeDB pg_search, Metabase, Zingg, Senzing, full GraphRAG, Unsloth Studio and PM4Py (AGPL), torchtune (unmaintained), and any AGPL-licensed object store as a bundled component.

---

## 8. Dependencies

### 8.1 On Stage 1

| Phase | What the platform needs from it |
|---|---|
| 69 (device keys and signed payloads; the phase's historical name used "Team Mode", which is retired from user copy) | Device keys that sign personal opt-outs, lowerings, overrides, acknowledgments and hold or case decisions; the signed-payload interface (TMR-05) |
| 70 Gate, manifests, labels | Labels, scales, dominance, join, the chat label (`SessionMark` in code), `lowerByPerson`, routing, signed bundle, decision records, label maps, D-22 versioning, D-49 event naming; the platform's tools (`catalog.*`, `dataset.assemble`, `query_data`) declare manifests |
| 71 Identities and credentials | Verified clearances, compartments and officer roles; delegation that narrows for the opportunity agent and connector agents; two-person signatures; device binding credentials for enrolled collectors |
| 72 Execution backends | Sandboxes for extraction workers, agent-written connectors and the trainer; network fences |
| 73 Credential broker | Holds the Microsoft 365 certificate generated on the host, the Google credential, the file-share account and database credentials; connectors see only broker-signed requests; secret scanning of tool output |
| 74 Run contracts | Caps on cost, time, tool calls for unattended runs: pass 2 classification, LLM extraction, the opportunity agent, training jobs |
| 28 Secure workflow setup | None (parallel) |
| 29 CleanUp tool | Never-touch list gains held items and personal existence records; the hold check lives inside the tool |

Added by the coherence review (2026-11-20), on the 0.4.x line before this milestone:

| Phase | What the platform needs from it |
|---|---|
| 31 to 35 Shared staff projects and the sync hub | The replica layer and the hub that carry the governance facts; the host enrols as a hub client; the hub loads the organization layer and runs the same gate core |
| 32.1 Get Started | The step registry that the source connections and the policy setup register with as administrator steps; the checklist |
| 33.1 Assigned positions | Officer positions, postings and the one delegation rule |
| 38 Portfolio drop 1 | The one aggregation evaluator in `src/domain/gate/` that Phase 93 extends |
| 41 Organization policy foundation | Bundle v2 sections and `requires`; the organization layer and its pinned issuer; `endpoints[]`; the one authorization record; the label service and `decideRoute`; `TrustFacts`; `ModelEndpoint` and `LocalServerAdmin`; the policy editor that receives proposals; the hash-chained local audit record |

### 8.2 On the later milestones

- **L1 (pulled forward in part).** The platform needs the always-on host now: the Compose stack, amd64 images on Strix Halo, ROCm and Vulkan passthrough, the local inference service exposed through the hybrid provider, and an offline start. It does **not** need Theia, the messaging relay or OpenShell. Local models on the host are reached through `ModelEndpoint` as `local` endpoints, not through the hybrid provider. Recommendation: split L1 into "L1a host and local inference" (inside this milestone, phase 85 and the host parts of 88) and "L1b Theia appliance" (stays later). Decided: the split (owner, 2026-11-18, decision 10.1-1).
- **L2:** not needed. Multi-person use works through verified clearances and source ACLs on one host, with governance facts on the replica layer that Phases 31 to 35 already deliver.
- **L4:** optional later: anchor package manifest roots, hold manifests and the governance streams' signed heads (roots only).
- **L5 (hub federation):** catalog federation between edge and HQ as hub-to-hub federation of the same streams, per-label key groups for edge devices (03 open question 6), pooled compute for extraction and training.

> **Superseded 2026-11-20 (coherence review):** L4 used to anchor "governance-log roots" and L5 used "per-label-cell keys"; the meaning is unchanged, the words follow the replica layer and the glossary ("cell" is a key group in prose, and is never shown).
- **L6:** learned skills can be proposed by the same opportunity agent.

---

## 9. Risks

Merged from 01 §7, 02 §11, 03 Risks and 04 §10. Highest first.

| Risk | Severity | Mitigation |
|---|---|---|
| ACL drift: a revoked permission still visible centrally | High (security) | Separate fast identity and ACL sync, fail closed on stale snapshots, ACL recompute in every sweep (01 §1.3) |
| Under-labelling leaks silently | High | Ensemble union, raise-only, strict ingest default, recall-first thresholds, weekly blind audit (02 §11.1) |
| Leakage through derivatives (summaries, vectors, edges, counts, caches, model weights) | High | Labels on every row, reader-relative computation, clearance-keyed caches, the two-compartment indistinguishability test on every view (03 Risks) |
| Clearance spoofing through model-written SQL | High | Token-verifying security-definer function; parsed and allowlisted SQL (03 §2.3) |
| Admins refuse broad Microsoft 365 scopes | High | `Sites.Selected`, Exchange RBAC scoping, exact scope explanations; measure ACL fidelity without full control in the spike (01 §4.3) |
| Throttling during backfill | High | Resource-unit budgets, global `Retry-After`, off-peak backfill, hierarchical sharing (01 §4.3) |
| Malicious files exploit parsers | High | Forked parsers, sandboxed workers with no network, limits (01 §7) |
| ROCm on gfx1151 freezes the host; training starves serving | High | Pinned containers, memory fraction 0.8, cgroup caps, one heavy job at a time, checkpoints; GB10 for long runs (04 §3.3) |
| Endpoint collectors hydrate cloud placeholders | High | Detect sync roots and placeholder attributes and skip (01 §3.3) |
| The administrator's setup sign-in can create apps and grant consent | High (security) | Used only during setup, held in memory and never stored; afterwards the app holds only the listed least permissions; setup shows each step; no app of ours exists in the tenant before or outside it (§3.7) |
| Collector updates as an attack path onto every machine | High (security) | Updates signed and served only by the host, staged with rollback and a minimum version; the signature is checked before install (§3.7) |
| A leaked enrolment code enrols an unknown machine | Medium | Codes scoped to a device group and a count, expiring and revocable; every new device visible in the source list; a collector can submit only items from its own machine under its own device credential (§3.7) |
| Licence contamination | High | CI licence check for code and weights |
| Over-labelling locks people out | Medium | Impact-ordered queue, "could be lower" batches, lock-out metrics (02 §11.1) |
| Expectations: OCR, audio and LLM extraction take weeks to months | Medium | Tiering, priority queues, separate backlog display, honest copy (03 §1.2) |
| Opportunity agent feels like surveillance; employee-monitoring law | Medium | Metadata first, groups not people, no per-person scoring, mail and personal folders off until notice and assessment are confirmed (02 §11.7, 04 §10) |
| Legal readings (Quebec PIA trigger, Ontario monitoring policy, GDPR works councils, Bill C-36) | Medium | Ship PIA and DPIA packs from catalog facts; counsel review before customer rollout (02 §11.7) |
| Erasure cannot reach weights | Medium | Retrain from manifest with deadline and fallback (04 §8.3) |
| Young components (DuckLake, AGE RLS, pg_textsearch) | Medium | Postgres stays the record; analytics is disposable; AGE optional |
| Python in a TypeScript product | Low to medium | Pinned, sandboxed worker containers behind the gate; the engine stays free of Python (decision 10.1-6) |
| Milestone size (17 phases) | Medium | Stage gates; the data map ships value early; factory runs in parallel |

---

## 10. Decisions

### 10.1 Decisions for the owner (14, answered 2026-11-18)

Each decision below carries the owner's answer. Decisions 1 to 13 were accepted as recommended; decision 14 was changed.

**A. Placement and platform**

1. **Pull the host slice of L1 into this milestone.**
   - Options: (a) split L1 into L1a "host and local inference" now and L1b "Theia appliance" later; (b) build a throwaway host only for the data platform; (c) wait for L1 after the relay.
   - Recommendation: (a).
   - Reason: R11 puts the platform before the relay, but L1 depends on the relay. The host slice does not, and building it once avoids two host stacks.
   - **Decided (owner, 2026-11-18):** (a), as recommended. L1a is phase 85 and the host parts of phase 88; L1b stays a later milestone.
2. **Milestone identity.**
   - Options: (a) its own milestone between v0.7.0 (now v0.5.0) Stage 1 and the relay, which then becomes a separate milestone; (b) a stage inside v0.7.0.
   - Recommendation: (a), with phases numbered 85 to 101.
   - Reason: it is larger than all of v0.7.0's relay work, and the relay's own stage gate stays intact.
   - **Decided (owner, 2026-11-18):** (a), as recommended, with phases 85 to 101. v0.7.0 (now v0.5.0) keeps Phase 68 and Stage 1; the relay stages became their own milestone after this one. Versions set by the owner the same day: v0.5.0 Governed agent platform, v0.6.0 for this milestone, v0.7.0 Messaging relay.
3. **Plaintext on the host.**
   - Options: (a) Postgres in plaintext on an encrypted disk, plus per-item keys for erasable content and an encrypted blob store; (b) keep the paused "no plaintext on disk anywhere" promise, which rules out server-side search.
   - Recommendation: (a), stated plainly in SECURITY.md.
   - Reason: search, RLS and the graph need plaintext in the database (03 §4 row 14, open question 2).
   - **Decided (owner, 2026-11-18):** (a), as recommended, stated plainly in SECURITY.md.
4. **Python on the host.**
   - Options: (a) pinned, sandboxed worker containers for extraction, detectors, entity resolution and training; (b) port everything to TypeScript or ONNX in Node.
   - Recommendation: (a).
   - Reason: Docling, Presidio, GLiNER, Splink and the training stack are Python, and porting them would take years. The engine and gate stay TypeScript (03 open question 7).
   - **Decided (owner, 2026-11-18):** (a), as recommended.

**B. Storage and data handling**

5. **Raw copies beyond decision 3.**
   - Options: (a) only the three in §5.2: the capped re-extraction cache, the hold store, and rare approved training snapshots; (b) no cache, always re-fetch; (c) a full raw copy layer.
   - Recommendation: (a), with the cache on by default for scans, images and audio, capped at 10 percent of the host disk and kept for 180 days.
   - Reason: re-fetching a million scans would use most of a day's Microsoft 365 budget, and better OCR models will keep arriving (01 §3.3).
   - **Decided (owner, 2026-11-18):** (a), as recommended: the cache on by default for scans, images and audio, capped at 10 percent of the host disk and kept for 180 days.
6. **Mail and personal folders.**
   - Options: (a) off by default. Turning them on needs your organization to confirm in the wizard that a privacy assessment and an employee notice exist. Mail then runs in label-only mode (a card, no content, chunks or vectors). (b) Mail fully indexed from the start.
   - Recommendation: (a).
   - Reason: scanning mail is electronic monitoring under several regimes (02 §11.7). Label-only mode still gives the data map, holds and requests.
   - **Decided (owner, 2026-11-18):** (a), as recommended.

**C. Visibility and people**

7. **What people learn about items they cannot see.**
   - Options: (a) strict indistinguishability everywhere; (b) your organization may choose, per scale, "existence only" placeholders with a steward and a request-access button, which needs a discovery description that a person approved.
   - Recommendation: (a) by default, with (b) as an opt-in per scale.
   - Reason: titles and counts leak, and an opt-in keeps the strict default for the classified scales (02 §8.8, 03 open question 3).
   - **Decided (owner, 2026-11-18):** (a) by default, with (b) as an opt-in per scale, as recommended (KB-15).
8. **Personal mark defaults.**
   - Options for quota, location-only mode and notice delay.
   - Recommendation: allowed in a person's own areas only. Quota of 5 GB and 20,000 items per person. Location-only mode off. Notice at override time, with any delay capped at 90 days and recorded.
   - Reason: the cap bounds abuse, and these defaults are easy to defend as proportionate (02 §10). Counsel should confirm.
   - **Decided (owner, 2026-11-18):** the recommended defaults, with counsel to confirm them as the recommendation said.
   - Note 2026-11-20 (coherence review): the decision stands; people see the control as "Personal: keep out of the catalogue", and the defaults live in the `data.personalMark` policy section.

**D. Legal positions (with counsel)**

9. **Erasure and trained models.**
   - Options: (a) retrain from the manifest within a deadline, with the incumbent model taking over if the deadline passes; (b) document why not, case by case; (c) attempt unlearning.
   - Recommendation: (a), with a 30-day default deadline.
   - Reason: unlearning gives no guarantee, while adapters are cheap to retrain (04 §8.3, 02 open question 11).
   - **Decided (owner, 2026-11-18):** (a), as recommended, with a 30-day default deadline.
10. **Derivatives as records.**
    - Options: (a) derivatives follow the original's retention class, are searched in requests, and are listed as processing; model weights are never produced; (b) derivatives are transient working copies outside request scope.
    - Recommendation: (a), pending counsel.
    - Reason: the Access to Information Act's definition of a record probably reaches them (02 §9, open question 10).
    - **Decided (owner, 2026-11-18):** (a), as recommended, pending counsel.

**E. Model factory**

11. **Teacher models.**
    - Options: (a) local teachers only; (b) also attested NEAR AI TEE models, as inference used to write training targets, where the label's routing allows; (c) any cloud model.
    - Recommendation: (b).
    - Reason: R9 forbids third-party *training*. Teacher inference in an attested TEE is the same route your organization already allows for that label. Training itself always runs on your organization's hardware (04 §4).
    - **Decided (owner, 2026-11-18):** (b), as recommended. Training itself runs only on your organization's own machines or hardware endpoints it controls (FAC-09).
    - Note 2026-11-20 (coherence review): the decision stands, and teacher calls now pass the same checks as any other call: `decideRoute` with the data's label, the `nearai-tee` endpoint, residency and the teacher model's approval for the use. Under the model provenance defaults the private models NEAR AI offers today may not be approved for operational use, so a teacher on organization data may be refused until your organization approves one; see open question 10.4-2.
12. **Going live.**
    - Options: (a) one click approves a specialist up to shadow, and a second click is needed for canary unless policy allows auto-promotion; (b) fully automatic once gates pass; (c) a person at every step.
    - Recommendation: (a), with auto-promotion off by default.
    - Reason: this keeps the one-click promise without letting an unevaluated model answer people (04 D9).
    - **Decided (owner, 2026-11-18):** (a), as recommended, with auto-promotion off by default.
13. **First training data.**
    - Options: (a) the first specialist uses chat and run logs only; organization data comes after classification, holds and erasure exist, opt-in per source or collection, signed; (b) organization data from the start.
    - Recommendation: (a).
    - Reason: only items with a known training right are allowed (02 §8.7), and logs are data the extension already protects (04 §9 phase B).
    - **Decided (owner, 2026-11-18):** (a), as recommended.

**F. Source onboarding**

14. **How your organization connects Microsoft 365 (changed by the owner: "easy from the start").**
    - Options weighed: (a) a separate app registration for each organization, created by a guided script, with a certificate held in the broker; (b) one multi-tenant app that we publish.
    - Recommendation was (a), because it is more sovereign, works offline from our side and fits "data stays on premises", with the multi-tenant app as a later convenience (01 §5).
    - **Decided (owner, 2026-11-18), changed:** easy from the start, with no manual app registration. A one-click "Connect Microsoft 365": an administrator signs in once. Setup then creates your organization's own app registration in its own tenant, uploads a certificate generated on the host (the private key never leaves the host and is held in the credential broker), and grants admin consent. No shared multi-tenant app that we publish, because its publisher-held credential could reach every customer tenant. Google Workspace gets the same one-click treatment (an automated per-organization setup), as do file shares. Details in §3.7; requirements SPIKE-09 and CONN-01 to CONN-04.
    - Reason: it keeps what made (a) right (your organization's own app, the credential on your own host, nothing of ours in the tenant) and removes the manual work that made (a) hard; the convenience of (b) is not worth one credential that could reach every customer.

**Also decided by the owner on 2026-11-18** (not among the 14):
- **Collectors are super simple to install.** The host is a container stack; endpoint collectors are small signed native packages pushed by device management, with zero-config enrolment by a code, automatic updates and a local notice with the personal opt-out ("Personal: keep out of the catalogue"); agentless where possible (§3.7; COLL-01 to COLL-06).
- **Fine-tuning runs only on your organization's own machines or hardware endpoints it controls** (§3.6; FAC-09).

### 10.2 Decided in design (accepted by the owner, 2026-11-18)

The owner accepted all 32 on 2026-11-18. Since then file shares are read from the host with nothing installed on the file servers (§3.7); that changes how row 3's share connector runs, not the choice in row 3.

| # | Decision | Reason | Source |
|---|---|---|---|
| 1 | Ingestion runs on the host plus endpoint collectors; the extension is the control panel only | Long jobs, GPU and cgroup caps, survives editor reloads | 02 OQ1, 04 D6 |
| 2 | Signed governance log holds governance events and encrypted snapshots; sources stay the system of record. Note 2026-11-20 (coherence review): the governance events are replica entries carried by the hub rather than a separate log; the decision is otherwise unchanged | Matches R3 | 03 OQ1 |
| 3 | First-party connectors for Microsoft 365, Google, endpoints and shares; no ELv2 platform | Licence and fidelity | 01 §2.1 |
| 4 | Poll change feeds by default; push optional | No public endpoint on an appliance | 01 §4.3 |
| 5 | Teams chat messages deferred | Protected API approval | 01 §1.1 |
| 6 | Network scanning for databases off by default; directory lookup first; each database needs an approval | Intrusion alarms; sensitivity | 01 §4.5 |
| 7 | Endpoint-only files indexed, flagged "may disappear", not copied except under hold | Within R3 | 01 §3.3 |
| 8 | Hold status imported manually first; Purview and Vault APIs used where available | API maturity varies | 01 OQ7, 02 §9.7 |
| 9 | Never write labels back to Microsoft 365 or Google in this milestone; opt-in per label later | Changes your organization's tenant state | 02 §4.3, OQ4 |
| 10 | Privacy categories are facts that raise levels; your organization may map them to compartments (HR, HEALTH) in the bundle | Compartments need verified clearances to mean anything, which Phase 71 gives; keep the default simple | 02 OQ2 |
| 11 | Label v2 adds `no-train` and `no-summarize-down`; "existence only" lives in decision 10.1-7 | Training is a new use | 02 OQ3 |
| 12 | Classifier: tiered pipeline; a fine-tuned local sensitivity model later, trained by the factory on audited labels on your organization's host | Audit loop produces the data | 02 OQ5 |
| 13 | Aggregation thresholds ship with defaults (for example 100 distinct people, or 500 items in one compartment, raise one level), adjustable with simulation as a proposal in the policy editor (written 2026-11-18 as "in the wizard"); each rule carries `effect` and `remedy` and runs in the one evaluator from Phase 38 | Policy once | 02 OQ6 |
| 14 | Hold store is our own write-once store with signed manifests; an S3 Object Lock compatible target is optional; no bundled AGPL object store | Licence | 02 §9.7 |
| 15 | ACL staleness limit 24 hours, fail closed; group expansion from Entra ID, Google directory or LDAP per connector | Security | 02 OQ7 |
| 16 | ROT is reported only; disposition is always a person's decision, guided flow later | Deletion needs a person | 02 OQ8 |
| 17 | Hold notices use Purview's custodian workflow where your organization runs it, ours otherwise | Integrate, do not rebuild | 02 OQ13 |
| 18 | The GLiNER-PII variant under a vendor model licence is not shipped; Apache GLiNER variants and a second Apache-2.0 classifier instead | Licence | 02 OQ14 |
| 19 | Graph in plain Postgres tables; AGE optional; no separate graph database | One enforcement point | 03 §2.1 |
| 20 | Superset not offered inside the panel; maybe an "open in browser" add-on later | Second enforcement point | 03 OQ8 |
| 21 | First views: data map, search, entity pages, ask, insights; then graph, timeline; globe and forecasts deferred | Early value | 03 OQ4 |
| 22 | Admiralty grading optional, for intelligence projects only | Enterprise data uses quality scores | 03 OQ5 |
| 23 | Keys for multi-compartment cells (key groups, in the glossary's prose word) deferred to L5 edge work; the host relies on RLS | No device copies in this milestone | 03 OQ6 |
| 24 | First specialist scope: per project or team, never organization-wide from mixed compartments | Per-compartment labels | 04 OQ4 |
| 25 | Model owner role defaults to your organization's administrator credential; data owners give a standing delegation per compartment in the wizard. Note 2026-11-20 (coherence review): model owner is a position, held by default by the person posted as administrator; the standing delegation follows the one delegation rule and is set in the Get Started administrator step | No security team needed | 04 OQ5 |
| 26 | Content clustering on data at your organization's lowest level runs under a standing signed policy; above it, after approval | Policy once | 04 OQ6 |
| 27 | Value formula cost inputs default from the host profile; editable | No required setup | 04 OQ7 |
| 28 | Process mining implemented in TypeScript (directly-follows graph, variants); no AGPL dependency | Licence | 04 OQ9 |
| 29 | MoE students and vLLM multi-LoRA wait for GB10 | ROCm immaturity | 04 OQ8 |
| 30 | NEAR AI private hardware *serving* of specialists is out of scope until NEAR's offering is documented; training never leaves your organization's hardware | R9 | 04 §9 F |
| 31 | No per-person productivity scoring anywhere; usage is aggregated to groups | Monitoring law | 02 §8.4, 04 §10 |
| 32 | Requirement prefix `DSEC-` (not `SEC-`, which is already used by SEC-01 to SEC-04) | ID collision | roadmap |

### 10.3 Questions for spikes, not the owner

ACL fidelity without full control, delta token expiry over multi-day backfills, `immutableId` with delta (phase 86); real throughput of Docling, OCR tiers, whisper.cpp, embeddings and LoRA on Strix Halo under ROCm and Vulkan (phases 85 and 87); Google quota figures and keyless service-account credentials on an on-premises host (phase 90 research); exact ROCm and PyTorch pairing for the host (phase 85); Mosaic and Splink licences (phase 96 research). Added 2026-11-18: the one-click Microsoft 365 sequence, its public client and certificate self-rotation (phase 86); which Google setup steps have APIs (phase 90 research); enrolment code scoping, code signing and notarization per operating system, the MSI build tool's licence and terms, and the collector update client (phase 91 research).

### 10.4 Open after the coherence review (2026-11-20)

The coherence review settled the carrier, the policy sections, the front door and the words. Three points it did not settle; each has a recommended default, used in this design until the owner says otherwise.

1. **Where per-item exception records live, and the override's kind.** The one authorization record (`POLICY-SCHEMA.md` 2) lists the kinds protected-b, t1-risk, accredited-device, residency-exception and declassify, all inside the policy bundle. A personal opt-out override is none of those, and label lowerings and overrides happen per item, at a volume the policy bundle should not carry.
   - Recommended default: add a kind `personal-override` (two inner signatures, maximum duration taken from `data.personalMark`), and carry per-item `declassify` and `personal-override` records as replica entries on the governance stream in the same record shape, with the signers' keys listed in the organization layer. Standing exceptions (for example "this collection may be lowered by its steward") stay in the bundle's `authorizations[]`.
2. **Which use a teacher call counts as (decision 10.1-11).** Writing training targets from organization data with a NEAR AI private hardware model is not chat a person reviews; under the model provenance defaults it would need an approval for agent work or operational work, which no private model on NEAR AI has today.
   - Recommended default: a teacher call counts as "agent work" (T2 internally); until your organization approves a model for that use, the factory uses local teachers only and its card says why.
3. **Who signs the data platform's project layer.** The policy schema has project layers signed by a project's lead. The data platform is organization-wide, not one project.
   - Recommended default: the data platform's rules live only in the organization layer (and, without one, the administrator's personal layer, "self-signed on this computer"); the data platform has no project layer of its own, and per-source settings are endpoint and section entries proposed through the policy editor.

# Architecture Patterns

**Domain:** Trusted-source knowledge base (graded intelligence graph) inside an existing VS Code extension, v0.5.0
**Researched:** 2026-10-28
**Overall confidence:** MEDIUM-HIGH for integration points (read from source), MEDIUM for library and scale choices (training knowledge plus unverified web search; flagged inline)

Scope includes the 2026-10-28 decisions in the brief: whole brief ships, three intake paths, small-team sharing, **and organisation scale** (compartments with their own keys, roles reader/analyst/approver, pluggable sync including an org-hosted E2E relay, periodic snapshots, group keys practical into the hundreds).

---

## 1. Verdicts (the opinionated part)

| Question | Verdict |
|----------|---------|
| Extend `contextGraphStore` or build new? | **Build a new store (`src/kb/`).** Keep `contextGraphStore` untouched for ordinary project memory. |
| Source of truth | Signed, per-compartment-encrypted, append-only **log**. Everything else (indexes, graph, timeline, globe layers, forecasts cache) is a disposable **view** rebuilt from log + snapshot. |
| Query/materialized store | In-memory typed indexes behind a `ViewStore` interface, partitioned encrypted snapshots on disk. **Do not use plaintext SQLite.** Disk-backed encrypted view store is a later, interface-compatible phase for the largest orgs. |
| Crypto | `node:crypto` only (Ed25519, X25519, HKDF, AES-256-GCM). No new crypto dependency. |
| Agent access | New tools in `src/agent/kbTools.ts`, new `knowledgeWrite` capability treated like `plan` by the permission engine; agents only ever **append proposals**; destructive/administrative operations are host-only behind approval fingerprints. |
| TEE-only enforcement | A **decorator at the model-client boundary** (`TeeGatedClient`), not call-site checks. Call sites are many and already inconsistent (see 6). |
| Sync | One `LogTransport` interface; implementations: `GitTransport`, `FolderTransport`, `RelayTransport`. Local-only is a team of one on the same format. |
| Org scale | Compartment = unit of key + stream + ACL. Roles are authorisation (signatures + roster), not keys. Keyring "lockbox" per compartment epoch (O(members), fine to ~1,000); versioned so MLS/TreeKEM can replace it later. |
| Views | One KB webview panel (tabs: network, globe, timeline, reports, access) following the `mcpView.ts` pattern; host-built DTOs only. |
| Globe | **MapLibre GL JS v5 globe** (vendored, tiles served by host through a custom protocol), not CesiumJS. |
| Prediction | Local statistical forecaster in a `worker_thread` is the default and the calibrated core; the TEE option runs an LLM scenario generator whose probabilities pass through the same local calibration layer. |

---

## 2. What exists today (verified in source)

| Fact | Where | Consequence |
|------|-------|-------------|
| Context graph store is plaintext JSON at `.planning/.near-ai/context-graphs.json`, capped at 200 nodes / 400 edges / 500 KB per scope, whole-file rewrite, single writer, scope-versioned (not temporal). | `src/services/contextGraphStore.ts` | Cannot hold KB volume, cannot be encrypted without a rewrite, no multi-writer, lives in the workspace (often committed). Rejected as the base. |
| Domain types already include `actor`/`function` node types, `TensionPolarity`, `MemoryProvenance`, `FreshnessPolicy`, slice DTO sanitisers. | `src/domain/contextGraph.ts`, `src/services/chatBridge.ts` (`sanitizeContextGraphNode`) | Reuse the **vocabulary and DTO-sanitiser pattern**, not the storage. |
| Memory is injected as a `<project-memory>` preamble each turn; `Remember`/`Recall` are `plan`-capability tools; sub-agents get a private memory scope. | `src/services/agentSession.ts:189-190, 391-413`, `src/agent/extraTools.ts` (`memoryTools`, `memoryPreamble`) | Template for slice injection and KB tools. In KB projects `Remember` must not write plaintext. |
| AES-256-GCM envelope with key in SecretStorage, created on first use. | `src/services/transcripts.ts` (`transcriptKey`, `sharedTranscriptKey`) | Template for the KB identity key. Do not reuse the transcripts key. |
| Tool interface: `AgentTool` with `capability`, `parse`, `run`, `untrusted`, `risky`, `sensitive`; `ToolContext` carries `pages` (fetched page text), `tainted()`, `writeScope`, `onSecurity`. | `src/agent/tools.ts` | KB tools plug in with a new optional `ToolContext.kb`. `pages` lets the host verify quotes against what was really fetched. |
| `decidePermission` allows `read`/`plan`; any other unknown capability falls through to "ask unless fully-autonomous". | `src/agent/permissions.ts` | A new capability needs an explicit branch or every KB write prompts. |
| `OutboundGuard.check` (TEE-only) runs **only** in the chat send path and the chat participant, for the main model, driven by the **global** `nearAi.privacyMode` setting. | `src/services/outboundGuard.ts`, `chat.ts:511-526`, `chatParticipant.ts:79` | KB projects need a project-forced mode and a lower-level gate. |
| Sub-agent model = tier/role model filtered by `availableModels`, which `chat.ts:560` sets to `modelsAsPrivateAs(models, mainModel)`; fallback is the parent model. | `src/services/agentSession.ts:410`, `chatBridge.ts:787` | Sub-agents are TEE **iff the main model is TEE**. Good, but depends on the main-model check being forced. |
| Other model calls bypass `OutboundGuard`: attachments (`describeImage`, `transcribeAudio`), image tools, `generationService`, context compaction. Only the attachment case has an ad hoc tee-only check. | `src/agent/attachments.ts:75-81`, `src/services/generationService.ts`, `src/agent/context.ts:71` | All funnel through `NearAiClient`; gate there. |
| No embeddings call exists in the client. | `src/services/nearAiClient.ts` | Embeddings are new surface; TEE-gate from day one. |
| Untrusted-content defences: `stripInvisible`, `detectInjection`, `fenceUntrusted`, `visibleText`; MCP results are fenced and mark the run tainted. | `src/agent/untrusted.ts`, `src/mcp/tools.ts` | Reuse unchanged for every intake path. |
| Dedicated webview panels (`mcpView.ts`, `activityView.ts`) with nonce CSP, own `media/<name>/` folder, `localResourceRoots`. | `src/services/mcpView.ts` | Pattern for the KB panel. Keeps `chat.ts` (951 lines, flagged anti-pattern) out of it. |
| Third-party code is vendored into `vendor/` by esbuild/copy script with an SBOM manifest; VSIX has no `node_modules`; MCP SDK is bundled this way. | `scripts/vendor-libs.mjs`, `vendor/manifest.json`, `.vscodeignore` | Pattern for MapLibre, Cytoscape. Zero runtime npm deps today; keep it that way. |
| `ProcessRunner` and `execFile('git', …, GIT_TERMINAL_PROMPT=0)` already exist. | `src/gsd/runtime.ts:11`, `src/agent/worktree.ts:16` | Template for `GitTransport`. |
| Approval-fingerprint flow for destructive memory ops (preview, one-time fingerprint, explicit confirm, audit). | `src/services/memoryApproval.ts`, `chatBridge.ts` (`memory-preview`/`memory-approve`) | Reuse the pattern for KB export, retract, membership, rotation. |
| Research project type already tells agents to grade sources A-F / claims 1-6 in prose. | `src/agent/projectTypes.ts` (`research` members `source-verifier`, `analyst`) | KB makes this structured; team prompts and tool lists change. |
| Layering rules: `src/domain` and `src/agent` import no `vscode`; `agent` imports only types from `services`. | `.planning/codebase/ARCHITECTURE.md` | `src/kb/` must be `vscode`-free; vscode adapters stay in `src/services/kb*.ts`. |

---

## 3. Recommended architecture

```
                         ┌───────────────── VS Code extension host ─────────────────┐
 Intake                  │                                                          │
 ───────                 │  src/kb/intake         src/agent/kbTools.ts (tools)      │
 agent tools ───────────►│  pipeline: sanitize ─► snapshot ─► extract* ─► dedupe     │
 analyst entry/import ──►│  (STIX/CSV/GeoJSON)      *LLM only via TeeGatedClient     │
 RSS / MCP / folder ────►│        │                         ▲ slice, search, propose │
                         │        ▼                         │                        │
                         │  KbService (write path)     KbQuery (read path, slices)   │
                         │   validate ─ authorise ─ stamp HLC ─ sign ─ seal          │
                         │        │                         ▲                        │
                         │        ▼                         │                        │
                         │  ┌─────────── EVENT LOG (source of truth) ───────────┐    │
                         │  │ per-compartment streams, per-author hash chains,   │    │
                         │  │ sealed segments (AES-256-GCM, CEK per epoch),      │    │
                         │  │ signed entries (Ed25519), signed snapshots         │    │
                         │  └──────┬─────────────────────────────┬──────────────┘    │
                         │         │ fold                        │ LogTransport      │
                         │         ▼                             ▼                   │
                         │  Materializer ─► ViewStore     Git | Folder | Relay       │
                         │   (histories + pure resolvers)   (ciphertext only)        │
                         │         │                                                 │
                         │  Forecaster (worker_thread | TEE)   Geocoder (offline)    │
                         └─────────┼─────────────────────────────────────────────────┘
                                   │ typed, sanitised DTOs (postMessage)
                         ┌─────────▼────────────── KB webview panel ─────────────────┐
                         │ network (Cytoscape) · globe (MapLibre) · timeline ·       │
                         │ reports · access (members/compartments/roles)             │
                         └───────────────────────────────────────────────────────────┘
```

### 3.1 Why a log, and how views stay disposable

Every aggregate is stored as an **ordered history list plus a pure resolver** (effective grade, current tension, current relationship state, retraction). Nothing in a view is mutated destructively in arrival order. Consequences:

- Late-arriving peer entries (older HLC) are inserted into the history and the resolver is re-run for that one target. No special merge code.
- "Roll time back" is a filter on the same histories. **World-time** scrubbing (`occurredAt <= T`) is an index lookup. **Knowledge-time** travel ("what did we know on date K") filters by `recordedAt <= K`, uses snapshot keyframes plus tail fold.
- View code can change between releases with no migration: bump `viewVersion`, rebuild from snapshot or log.

### 3.2 Timestamps (the brief says three; the system needs a fourth)

| Field | Meaning | Set by |
|-------|---------|--------|
| `occurredAt` | When it happened: `{start, end?, precision}` (year to millisecond; uncertain dates are first-class) | Author or extractor |
| `reportedAt` | When the source reported or published it | Source metadata or author |
| `gradedAt` | When a grade entry was made | Implicit on grade entries (= entry `recordedAt`) |
| `recordedAt` | Hybrid logical clock (HLC) of the log entry | Host; the total order and the knowledge-time axis |

Total order: `(hlc.wallMs, hlc.counter, authorKeyId, seq)`. Reject peer entries with HLC more than a bounded skew in the future (quarantine, show in Access view); never let an author's clock reorder past a signed roster change (see 3.7).

### 3.3 Data model (pure types in `src/kb/model/`)

Naming trap: the brief says "events" for world happenings and the log also has events. **Name log records `KbEntry`; name world happenings `Occurrence`.**

| Entity | Key fields | Notes |
|--------|-----------|-------|
| `Source` | `sourceId` (random), `kind` (osint/humint/document/feed/…), `sourceType` (globe layer key), `locator`, `title`, `publisher`, `contentHash`, `retrievedAt`, `snapshotRef` | Content snapshot is a content-addressed encrypted blob (compartment key), not inline in the log. |
| `Claim` | `claimId`, `text` (capped), `sourceIds[]`, `evidence[{sourceId, quote, span}]`, `subjectRefs`, `occurredAt`, `reportedAt`, `placeRefs`, `topics[]`, `quarantined?` | `quote` verified by host against the stored snapshot or the run's fetched `pages`. |
| `GradeEntry` | `targetKind` (`source`\|`claim`), `targetId`, `reliability?` A-F, `credibility?` 1-6, `by` (`agent`\|`analyst`\|`import`\|`rule`), `reason`, `evidenceRefs[]`, `supersedes?`, `pinned?` | Admiralty. F and 6 mean "cannot be judged" and are never above any threshold. Display "B2". |
| `Actor` (node) | `actorId`, `kind`, `names/aliases`, `attrs` | Random ids, never hashes of names (cross-compartment leakage, see 3.8). |
| `Function` | `functionId`, `actorId`, `description`, `validity{from,to}`, `claimIds[]` | What an actor does; first-class so it is time-bounded and evidence-backed. |
| `Relationship` (edge) | `relId`, `from`, `to`, `type`, `validity`, `claimIds[]` | |
| `TensionAssessment` | `relId`, `polarity` (positive/negative/neutral), `strength` 0..1, `claimIds[]`, `by` | Append-only so tension **trends** are a series; current value = resolver. |
| `Occurrence` | `occurrenceId`, `kind`, `occurredAt`, `placeRef`, `actorIds[]`, `claimIds[]`, `layer` | Drives timeline and globe. |
| `Place` | `placeId`, `name`, `geonameId`, `lat`, `lon`, `precisionM`, `admin[]` | Resolved by offline gazetteer; only the resolved record is stored. |
| `SliceDef` | `sliceId`, `name`, filters `{geo, time, topics, actorIds, hops}` | Analytic scoping. Distinct from compartment (access scoping). Shared via the log. |
| `ThresholdPolicy` | `minReliability`, `minCredibility`, `mode` (`exclude`\|`mark-unconfirmed`) | Per project, versioned entry. |
| `Forecast` / `ForecastResolution` | `method`, `inputSliceHash`, `paramsHash`, `outcomes[{label, p, evidenceIds}]`, `horizon`; resolution scores it | Derived; synced as entries, model parameters are not. |
| `Provenance` (on every entry) | `authorKeyId`, `actorKind`, `runId`, `modelId` + `attested`, `intakePath` (`agent`\|`analyst`\|`import`\|`feed`), `importBatchId`, `toolCallId`, `rosterHead` | |

**Effective grade resolver** (pure, unit-testable): latest *analyst* grade wins; an analyst grade with `pinned` blocks agent changes until an analyst unpins (agents may still add "suggested" entries shown beside it); otherwise latest *agent* grade; none yields F/6. Two analysts disagreeing in a window yields `contested: true` surfaced in UI. Agent regrades obey hysteresis: evidence must be new since the last grade, change at most one step per cycle, evidence ids must exist and be readable in the run's compartments.

### 3.4 Log format

Per compartment `c`, per author `a`:

```
<repo-or-relay-root>/
  kb.json                                 genesis: kbId, formatVersion, owner key fingerprint
  directory/                              signed roster stream (members, roles, compartments, policies); opaque compartment ids
  keys/<compartmentId>/epoch-<n>.keyring  per-member wraps of CEK_n (see 3.7)
  keys/<compartmentId>/chain-<n>.key      Enc(CEK_n, CEK_{n-1}) for history access
  log/<compartmentId>/<authorKeyId>/<epoch>-<firstSeq>.seg   sealed immutable segment (gzip then AES-GCM)
  snap/<compartmentId>/<headsHash>.snap   signed, sealed shared snapshot (see 3.6)
  blobs/<compartmentId>/<hash>.blob       encrypted source snapshots
```

Entry (inside the ciphertext): `{id = sha256(canonical body), kbId, compartment, authorKeyId, seq, prev (hash of author's previous entry in this compartment), hlc, epoch, rosterHead, type, body, sig}`. Sign (Ed25519 over canonical JSON, JCS-style sorted keys) **inside**, then seal: members cannot forge each other even though they share the CEK. Segment subkey = `HKDF(CEK_n, segmentId)`, so random 96-bit GCM nonces never share a key at scale. Header visible to transport (needed for relay enforcement, signed by the author): `kbId, compartmentId, authorKeyId, epoch, seq range, entryClass (write|admin|approve), sig`. Type, body, and entity ids stay inside.

Local writes go to an encrypted write-ahead file, then are sealed into segments every N entries or on sync. This avoids thousands of tiny git files. Segment file names are validated by regex plus hash check, so sync-tool "conflicted copy" files are ignored.

**Why git never conflicts:** each author writes only to its own directory and files are immutable. Merge is add/add on disjoint paths. Concurrent push is handled by fetch-merge-retry.

### 3.5 Materialization, scale, and storage

- `Materializer` folds decrypted entries into `ViewStore` (histories + indexes: by id, by actor, by place cell, by topic, BM25 text, by `occurredAt` interval tree, by compartment).
- **Partitioning:** state and snapshots are partitioned by `(compartmentId, era)`; a slice loads only the compartments the user can read and the eras its time window touches. This, not a database, is what bounds memory.
- **Targets (assumptions to validate in the discuss phase):** small team up to about 300k records fully in memory; org scale relies on partition loading. If one member's readable working set exceeds roughly 1-2M records, introduce the disk-backed `ViewStore`.
- **Disk-backed option (spike, do not commit):** encrypted SQLite via a WASM build of SQLite3 Multiple Ciphers, or block-encrypted sorted runs. Plain `node:sqlite` is **rejected** for the client: no encryption at rest, and availability inside the Electron extension host is unverified (web search found nothing; Node 22.5+ ships it experimentally). SQLite is fine **on the relay**, which stores only ciphertext.
- **Embeddings:** not in the baseline. Retrieval is BM25 plus graph-neighbourhood expansion, local. Optional embeddings go through the TEE gate; vectors are derived, cached encrypted locally, never synced.

### 3.6 Snapshots

| Kind | Purpose | Protection |
|------|---------|------------|
| **Local snapshot** | Fast open. Materialized partitions + `appliedHeads {authorKeyId→seq}` + `viewVersion` | Encrypted with a key from `HKDF(identity secret, "kb-snapshot")`. Never leaves the machine. |
| **Shared snapshot** (per compartment) | New joiners and relay catch-up skip the full history | Sealed under the compartment CEK, signed by an analyst or approver, carries `coversHeads` and `stateHash`. Clients accept it **provisionally**, replay the tail, and verify by background full replay (badge "verified" when the hash matches). A bad snapshot from a malicious member is therefore detected, not trusted. |

Snapshots never replace the log. The log is never compacted (it is the temporal record). Snapshots are cut periodically (every N entries or on admin command) by whichever client is configured as snapshotter.

### 3.7 Organisation scale: compartments, roles, keys

**Compartment** = unit of (key, stream, ACL). Each entry belongs to exactly one compartment. A local-only or small team base is one compartment named "default".

**Roles are authorisation, not keys.** Reader, analyst, approver (plus compartment admin and org owner, which the brief's "e.g." allows and governance needs):

| Role | Holds CEK | May append | Special |
|------|-----------|------------|---------|
| reader | yes | no | |
| analyst | yes | write entries (claims, sources, links, proposals, analyst grades) | |
| approver | yes | write + `approve` entries | Co-signs entry classes the compartment policy marks as requiring approval (e.g. report release, export, cross-compartment sanitised copy, high-impact grade finalisation, membership into sensitive compartments) |
| admin | yes | `admin` entries | Invites, removals, role changes, rotation, policy; optional two-person rule |

Entries of an approval-required type are `pending` until an approver `approve` entry references their id. Pending entries are visible in an approvals queue and excluded from reports until approved.

**Directory stream.** A signed log of `member-added|removed|role-set`, `compartment-created`, `policy-set`, readable by the relay (opaque compartment ids, member key ids and roles only; human-readable names live in an encrypted org-directory compartment). Each entry carries `rosterHead`, so validators check the author's role **at the roster version the author saw**, not at a forgeable HLC. A removal entry records the removed member's `finalSeq` per compartment; later entries from them are rejected.

**Key hierarchy.**
1. Member identity: Ed25519 (sign) + X25519 (key agreement), generated on first use, stored in SecretStorage. This is the **only** secret in the keychain; every local cache key derives from it by HKDF. Second device = second member (invited by the first).
2. Compartment epoch key `CEK_n` (256-bit random), wrapped to each member's X25519 key with an ephemeral-static ECIES construction (X25519 + HKDF + AES-GCM) in one `epoch-n.keyring` file per compartment.
3. Backward chain: `chain-n = Enc(CEK_n, CEK_{n-1})`. A holder of the latest key reads all history. **Join without history** = rotate at join and omit the chain link.

**Practicality into hundreds.** A keyring entry is about 100 bytes: 500 members is about 50 KB and 500 X25519 operations (milliseconds). Removing a member rotates each compartment they were in: k keyrings, one commit/transaction. So O(members × compartments-of-removed-member) of cheap work, no per-entry re-encryption (old data stays under old epochs; removed members keep what they had, as the brief states). Mitigations that keep it practical: roles and **groups** (named member sets) managed in the directory so admins do not edit member × compartment cells; the relay suspends a member's append rights instantly, before the rekey finishes; admin batches rotations. The keyring has a `scheme` field (`lockbox-v1`); if an org outgrows about 1,000 members per compartment, `mls-v1` (TreeKEM, O(log n)) can replace it without touching entries. MLS is not recommended now: no dependency-free Node implementation and it would break the zero-runtime-dependency posture.

**Concurrent rotation.** Rotation is an admin entry; the lowest `(hlc, authorKeyId)` for a given `epoch` number wins; losers re-wrap. With a relay, the relay serialises admin entries per compartment (single-writer sequencer), removing the race entirely.

**Honest limits to surface in UI and docs:** transport/relay sees metadata (who writes, when, sizes, compartment ids); no forward secrecy for past epochs; a removed member keeps everything they already decrypted; a compromised member key exposes every epoch that member held.

**Need-to-know semantics in views.** Entity ids are random so existence does not leak. A member's graph is the union of facets from compartments they hold; other facets are simply absent. Reports and slice exports carry the **highest** compartment among their inputs as a banner. "Releasing" content to a lower compartment is an approver-signed *new* entry in the lower compartment (a deliberate sanitised copy), never a reference.

**Agents inherit the user's access ceiling and a no-write-down rule.** A run is bound to a primary write compartment `W` and a read set `R ⊇ {W}` of compartments the user holds. A write to `W` is refused if `W`'s current reader roster contains anyone who is not a reader of every compartment in `R` that the run actually read. Checked at tool-call time against the live roster.

### 3.8 Sync transports

```ts
interface LogTransport {
  readonly enforcesAppend: boolean;           // relay true; git/folder false
  describe(): TransportInfo;
  pull(since: Cursor, signal: AbortSignal): Promise<PullResult>;   // new segments, directory entries, keyrings, snapshots, blobs
  push(files: SealedFile[], signal: AbortSignal): Promise<PushResult>;
  subscribe?(onChange: () => void): Disposable;   // relay websocket; folder watcher
}
```

| Transport | Use | Notes |
|-----------|-----|-------|
| `GitTransport` | Small teams | Separate KB clone under `globalStorage/kb/<kbId>/remote` (never a submodule or path of the workspace repo, so it cannot be committed by accident). Spawn `git` through `ProcessRunner` with `GIT_TERMINAL_PROMPT=0`, hooks disabled; auth is the user's own git credentials/SSH. No ACL enforcement: clients validate every entry. |
| `FolderTransport` | Shared drive, Syncthing, NAS | Same layout; atomic write via temp + rename; ignores files that fail the name/hash check. |
| `RelayTransport` | Organisations | HTTPS plus WebSocket. Member authenticates with a signed challenge. Relay validates the signed header against the directory (member active, role may append that `entryClass`, compartment exists, `seq`/`prev` continuity), stores ciphertext append-only, rejects overwrites, rate-limits, fans out change notifications, serves cursor-based pulls and snapshots. It **cannot** read entries, types, or blobs. |

**The relay is a new deliverable**, not an extension feature: a small standalone Node server (`src/relay/`, separate entry point, own Dockerfile/docs) sharing `src/kb/log` code with the client. It is excluded from the activation path. It is security-critical and needs its own threat model and tests (see Phase flags).

### 3.9 Intake

One `IntakeService` (host) normalises every path to `IntakeItem` and runs one pipeline.

```
acquire ─► sanitize ─► snapshot ─► map/extract ─► dedupe ─► default grade ─► authorise ─► append ─► enqueue regrade
```

| Path | Acquire | Map/extract |
|------|---------|-------------|
| Agent during research run | `KbAddSource` / `KbAddClaim` tools using `ToolContext.pages` | Already structured by the agent; host verifies quote and URL against fetched text |
| Analyst direct entry | KB panel forms | Deterministic |
| CSV / STIX 2.1 / GeoJSON import | File picker; pure-TS parsers, size and depth caps | **Deterministic mapping, no model**: STIX identity/threat-actor/intrusion-set/relationship/location/report to actors, relationships, places, claims; GeoJSON features to places/occurrences; CSV via a saved column mapping. Each batch gets an `importBatchId` and can be retracted as a unit. |
| RSS | Host poller (`src/kb/intake/rss.ts`), polite fetch via existing `fetchPublic` (SSRF-safe) | LLM extraction of claims (TEE only) |
| MCP feed | New `McpFeedBinding {serverId, tool, args, interval}`; needs a programmatic `callTool` on `mcpRegistry` (today it only exposes `agentTools()`) | Same as RSS |
| Watched folder | `fs.watch` with debounce, allow-listed extensions, size caps | Text/document extraction via existing `src/agent/documents.ts`, then LLM extraction |

**Untrusted-content handling (critical, three layers):**
1. *Before storage:* `stripInvisible`, `visibleText` for HTML, `detectInjection`. Items that trip injection patterns are stored but `quarantined` (excluded from slices and reports until an analyst releases them); hidden-content and injection events go through `onSecurity` into Agent Activity.
2. *During extraction:* the source text is fenced with `fenceUntrusted`; the extractor model has **no tools except schema-validated output** (JSON claims), so an injected instruction has nothing to call. Every claim `quote` must be a substring of the snapshot; failures are dropped and counted.
3. *After storage (second-order injection):* claim text is attacker-influenced data that later re-enters prompts. Slice injection is fenced as untrusted (`<untrusted-content source="kb slice">`), per-field length-capped, chat-role markup defused, and KB read tools set `untrusted: true`, so a run that reads the KB is **tainted** and the existing `risky` network-command check applies.

A new source defaults to reliability F / credibility 6 until graded (feeds may carry an analyst-set default reliability). Dedupe by content hash, normalised URL, and near-duplicate fingerprint.

Standing feeds run only while VS Code is open (no daemon); on activation they catch up. Feed credentials live in SecretStorage like MCP secrets.

### 3.10 Agent integration

New file `src/agent/kbTools.ts` (agent layer, imports only types from `src/kb`). The tools operate on a `KbRunContext` provided through a new optional `ToolContext.kb`:

```ts
interface KbRunContext {
  slice: SliceSpec;                 // analytic slice, resolved by host
  readCompartments: CompartmentId[];// <= user's access
  writeCompartment: CompartmentId;  // primary
  actor: { kind: 'agent'; agentLabel: string; runId: string; modelId: string };
  quota: { claims: number; sources: number; grades: number };  // per run
  api: KbAgentApi;                  // host-implemented; tools never touch logs or keys
}
```

| Tool | Capability | Untrusted | Behaviour |
|------|-----------|-----------|-----------|
| `KbSlice` | read | yes | Budgeted context: top claims with grades, actors, relationships, tensions, recent occurrences in the slice |
| `KbSearch`, `KbGet` | read | yes | Query inside slice; entity detail with grade history |
| `KbAddSource` | knowledgeWrite | no | Registers a page already fetched this run; hash and snapshot are **host-computed** from `ToolContext.pages`, not model-claimed |
| `KbAddClaim` | knowledgeWrite | no | Text, source, quote (host-verified), `occurredAt`, `reportedAt`, actors by id or new name, place name (offline geocode) |
| `KbLink` | knowledgeWrite | no | Relationship plus `TensionAssessment` with evidence claim ids |
| `KbProposeGrade` | knowledgeWrite | no | Target, grade, reason, non-empty readable evidence ids; subject to resolver hysteresis; never overrides a pinned analyst grade |
| `KbReport` | read | no | Host renders threshold-filtered claims with grades and sources; the writer agent may only state facts present in this output |
| `KbForecast` (read cached) | read | yes | Latest forecasts for the slice; generating one is a host/UI action because it costs compute |

**Permission engine.** Add `'knowledgeWrite'` to `ActionCapability` in `src/domain/policy.ts` and to the safe set; add an explicit allow branch in `decidePermission` (emergency stop still denies). Rationale: writes are append-only, attributed, quota-bound proposals, reversible by retraction entries, so per-call prompts would make research unusable; a distinct capability keeps Agent Activity and future policy tightening separate from `plan`. Safety is structural instead:

- Agents cannot: retract, redact, export, change members/roles/compartments, rotate keys, pin or override analyst grades, edit thresholds, or write outside `writeCompartment`. Those exist only as host commands behind the `memoryApproval`-style fingerprint flow.
- Quotas and schema validation per run; sub-agents inherit the same or a narrower `KbRunContext` (never wider), mirroring how `memoryFor()` passes scopes at `agentSession.ts:391`.
- Research members (`investigator`, `source-verifier`, `analyst`, `writer`, `editor`, `red-team`) get explicit tool lists in `projectTypes.ts`; `source-verifier` gets `KbProposeGrade`; only `investigator`/`analyst` get add tools.

**Grade revisiting.** A host `RegradeScheduler` watches for triggers (new independent corroboration, contradiction from a higher-reliability source, retraction, age) and runs a `source-verifier` sub-agent (TEE) on the affected targets, plus a command "Revisit grades". The deterministic baseline (corroboration count by independent source) is computed by the host and offered to the agent as evidence, so grades do not depend on model whim.

**Reports and thresholds are enforced by the host, after the model writes.** `ReportBuilder` selects claims by `ThresholdPolicy`. A `ReportVerifier` then scans the produced Markdown for claim-id citations: every cited claim must meet the threshold (or be marked unconfirmed per mode) and uncited factual lines are flagged. The check style already exists in `src/test/evalGraders.ts` (`factLines`). Do not trust prose.

### 3.11 TEE-only enforcement

**Principle: enforce at the transport boundary, not at call sites.** Every model path (`streamCompletion`, `streamChat*`, `describeImage`, `transcribeAudio`, `generateImage`, `editImage`, new `embed`, compaction) goes through a `NearAiClient` returned by `clientFor()` in `src/services/providerCache.ts`.

- New `src/kb/sovereignty.ts`: `TeeGatedClient` wraps the client for KB projects. Every method checks `model` against the catalog (`privacyBoundary === 'tee'`; `verificationStatus` verified where the catalog provides it). Unknown model, cloud, forwarded, or unlisted means throw `SovereigntyError` before any bytes leave. `local` boundary is **refused by default** for KB projects (the brief says TEE-attested only); a per-project opt-in for a local runtime is an open decision.
- `effectivePrivacyMode(root)` returns `tee-only` for KB projects regardless of `nearAi.privacyMode`; wired into `OutboundGuard` construction at `chat.ts:519` and `chatParticipant.ts:79`, and into the attachment check at `chat.ts:511-516`.
- `availableModels`, tiers, `roleModels`, and `visionModel/transcriptionModel/imageModel` are filtered to TEE models for KB projects; unsatisfiable settings fail with a clear message, not a silent fallback.
- Architecture test: a test that fails if any file under `src/` other than the client calls the model endpoints directly (grep-style guard), and a test that every `NearAiClient` public model method is covered by the gate (reflection over the prototype), so new methods cannot slip past.
- **Marker integrity:** the KB flag is stored in extension `globalState` keyed by project id **and** a marker at `.planning/.near-ai/kb.json`. An agent with `Write` must not be able to downgrade by editing the marker: add `.planning/.near-ai/` to `sensitive()` for writes and treat the globalState record as authoritative (stricter wins).
- **Leak surfaces that are not model calls** (must be addressed, see Pitfalls): `WebSearch`/`WebFetch` queries (non-TEE search provider), map tile requests (reveal geography of interest), `.planning/HANDOFF.json` and activity summaries (plaintext summaries of KB runs), agent-written findings and reports in `.planning/` (plaintext by design), git remotes.

### 3.12 Prediction

```ts
interface Forecaster {
  readonly backend: 'local' | 'tee';
  forecast(req: { sliceHash: string; kind: 'scenario' | 'tension-trend'; horizon: Duration; asOf: Hlc }, signal: AbortSignal): Promise<ForecastResult>;
}
```

| Backend | Where it runs | What it does |
|---------|---------------|--------------|
| `LocalStatForecaster` (default) | `worker_thread` in the extension host, pure TS, no network | Tension trends: per-relationship time series of `TensionAssessment` with exponential smoothing / Bayesian structural model and prediction intervals. Scenario forecasts: smoothed Markov/Hawkes-style transition counts over typed occurrence sequences by actor pair, bootstrapped for uncertainty. Deterministic given `(slice, asOf, seed)`. |
| `TeeLlmForecaster` | NEAR TEE model through `TeeGatedClient` | Slice (fenced) goes to a TEE model that proposes scenarios and elicits probabilities with cited evidence ids. NEAR exposes inference, not general training, so "train on TEE" means in-context, not weight updates. |

Both backends write `Forecast` entries (method, input-slice hash, params hash, outcomes, evidence ids). Both pass through the **same local calibration layer** (isotonic or Platt fit on the project's resolved forecasts, scored by Brier and shown as a reliability diagram) because LLM-elicited probabilities are poorly calibrated. Resolutions are entries (`ForecastResolution`), so recalibration "as events arrive" is a fold. Forecast results sync as entries; trained parameters and caches stay local. The choice is a per-project setting, default `local`; `tee` inherits all TEE and compartment rules (the slice sent is limited to compartments the user can read and the project permits).

### 3.13 Webview panel and DTO boundary

One `WebviewPanel` ("Knowledge Base") from `src/services/kbView.ts`, modelled on `mcpView.ts`: nonce CSP, `localResourceRoots: media/kb` and `vendor/maplibre`, `retainContextWhenHidden` off with state rebuilt from host. One panel (not four) because slice, time cursor, and selection are shared across network, globe, and timeline.

CSP: `default-src 'none'; script-src 'nonce-…'; style-src ${cspSource}; img-src ${cspSource} data: blob:; connect-src 'none'; worker-src ${cspSource} blob:` (MapLibre worker; use MapLibre's CSP-build/worker-URL option if blob workers are refused. The exact filenames are unverified, see Gaps). **No external origins.** The webview cannot reach the network.

| View | Library (vendored) | DTO from host |
|------|--------------------|---------------|
| Network (RAFT) | Cytoscape.js + fcose layout (MIT) up to a few thousand nodes; slices keep it bounded. Fall back to graphology + sigma only if profiling demands | `NetworkDto {nodes[{id, kind, label, gradeBadge, compartmentBadge, size}], edges[{id, from, to, polarity, strength, gradeBadge}], truncated}` |
| Globe | MapLibre GL JS v5 globe projection (BSD-3, shipped Jan 2025) | `GlobeDto {layers[{key, label, count}], features GeoJSON-like per visible layer + viewport, each with occurrenceId, time, gradeBadge}` |
| Timeline / replay | Small custom canvas/SVG | `TimelineDto {buckets, windowed occurrences, playhead, axis: world\|knowledge}`; replay streams delta frames |
| Reports | Markdown rendered with the existing `media/chat/markdown.js` sanitiser pattern | `ReportDto {markdown, claims[{id, grade, sources}], excluded, unconfirmed, banner}` |
| Access | Plain DOM | `AccessDto {members, roles, compartments, groups, pendingApprovals, rotationStatus, fingerprints}` |

DTO rules (mirror `ContextGraphNodeDto`): opaque ids only; text capped and rendered with `textContent` (never `innerHTML`); no keys, key ids beyond display fingerprints, file paths, log internals, raw snapshots or prompts; host does level-of-detail and viewport culling, caps every message (for example 2k nodes / 5k edges), and sends deltas for replay. Messages are validated by a dedicated `src/kb/bridge.ts` parser (exact-key allow-lists like `parseContextGraphWebviewMessage`), so `chatBridge.ts` and `chat.ts` do not grow. Destructive and administrative messages require `explicit: true` plus a fingerprint from a prior preview, as in `memory-preview`/`memory-approve`.

**Tiles:** the webview never fetches tiles. MapLibre `addProtocol('kb', …)` handlers post a request to the host; the host serves from a bundled Natural Earth basemap and optionally a user-supplied local tile archive (PMTiles/MBTiles). Online imagery (OSM, NASA GIBS) is an explicit per-project opt-in with a visible notice that tile requests reveal the viewed area, fetched by the host, never the webview. Offline gazetteer: GeoNames `cities500`-class extract bundled or downloaded once, indexed in memory (normalised names, alt names, population rank).

Why not CesiumJS: much larger payload with workers and assets, and a community thread reports CSP/`unsafe-eval` friction (unresolved, so LOW confidence); MapLibre v5 globe meets "open-source, feature-rich, no tokens" with a lighter, CSP-friendlier footprint. Revisit only if terrain/3D-tiles analysis becomes a requirement.

---

## 4. Component inventory

### 4.1 New

| Path | Responsibility | Depends on |
|------|----------------|-----------|
| `src/kb/model/*.ts` | Entities, Admiralty enums/ordering, resolvers (effective grade, current tension), threshold logic. Pure. | none |
| `src/kb/log/` `canonical.ts`, `hlc.ts`, `crypto.ts`, `entry.ts`, `segment.ts`, `keyring.ts`, `validate.ts` | Canonical JSON, HLC, Ed25519/X25519/HKDF/AES-GCM, sign+seal, keyring wrap/unwrap, entry validation against directory and roster | `node:crypto` only |
| `src/kb/directory/` | Roster/roles/compartments/policies fold; role-at-`rosterHead` checks; approval-required classes | `log` |
| `src/kb/view/` `materializer.ts`, `viewStore.ts`, `memoryViewStore.ts`, `slice.ts`, `search.ts`, `snapshot.ts` | Fold, indexes, partitioned snapshots, slice evaluation, BM25 | `model`, `log` |
| `src/kb/sync/` `transport.ts`, `gitTransport.ts`, `folderTransport.ts`, `relayTransport.ts`, `syncEngine.ts` | Pull/validate/apply/push loop, quarantine of invalid entries, retry | `log`, `ProcessRunner` |
| `src/kb/intake/` `pipeline.ts`, `stix.ts`, `csv.ts`, `geojson.ts`, `rss.ts`, `folderWatch.ts`, `mcpFeed.ts`, `extract.ts`, `dedupe.ts` | Normalise, sanitise, map, extract (via gated client) | `agent/untrusted`, `kb/geo` |
| `src/kb/geo/` | Offline gazetteer load/index, geocode, tile source abstraction | none |
| `src/kb/forecast/` `local.ts` (worker entry), `tee.ts`, `calibration.ts`, `evaluate.ts` | Forecasters, calibration, scoring | `view`, gated client |
| `src/kb/report/` `builder.ts`, `verifier.ts`, `export.ts` | Threshold-filtered reports, post-write verification, Markdown/JSON/STIX/GeoJSON/CSV export | `model`, `view` |
| `src/kb/sovereignty.ts` | `TeeGatedClient`, `SovereigntyError`, `effectivePrivacyMode` | `nearAiClient` types |
| `src/kb/bridge.ts`, `src/kb/dto.ts` | Webview message parser; DTO builders and sanitisers | `view`, `report` |
| `src/kb/service.ts` | `KbService`: open/create/join a base, write path (validate, authorise, stamp, sign, seal), agent API, regrade scheduler | all above |
| `src/agent/kbTools.ts` | The tools in 3.10 | types from `src/kb` |
| `src/services/kbView.ts` | Panel host (CSP, nonce, message routing, push updates) | `kb/bridge`, `kb/dto` |
| `src/services/kbCommands.ts` | Commands: create/open base, invite, import, sync now, revisit grades, export | `kb/service`, `kbApproval` |
| `src/services/kbApproval.ts` | Fingerprint approval for retract/export/membership/rotation (pattern of `memoryApproval.ts`) | |
| `media/kb/` `kb.css`, `kb.js`, `network.js`, `globe.js`, `timeline.js`, `reports.js`, `access.js` | Webview front-end | vendored libs |
| `vendor/maplibre/`, `vendor/cytoscape/` (via `scripts/vendor-libs.mjs`) | Pinned third-party code with licenses and SBOM rows | |
| `src/relay/` (`server.ts`, `store.ts`, `auth.ts`, `acl.ts`) and `docs/relay.md` | Org-hosted ciphertext relay | `kb/log` (shared validation code) |
| Tests: `src/test/kb*.test.ts` | Crypto vectors, convergence under shuffled/duplicated delivery, removal and rotation, TEE gate reflection test, untrusted-content fixtures, DTO bound tests, relay ACL | |

### 4.2 Modified

| Path | Change |
|------|--------|
| `src/domain/policy.ts` | Add `knowledgeWrite` capability (safe set). Update `src/test/policy.test.ts` |
| `src/agent/permissions.ts` | Explicit allow branch for `knowledgeWrite` |
| `src/agent/tools.ts` | `ToolContext.kb?`; no other change to `AgentTool` |
| `src/agent/projectTypes.ts` | KB-enabled variant of `research` (tool lists, guidance referencing KB tools and no-write-down); `.planning/.near-ai/` write-sensitive |
| `src/agent/systemPrompt.ts` | State that KB slices are untrusted data; how to cite claim ids; never claim grades the host did not compute |
| `src/services/agentSession.ts` | `AgentTurnRequest.kb?`; add KB tools in `toolsFor` (near line 391); slice preamble next to the memory preamble (near line 189); sub-agents inherit narrower `KbRunContext`; in KB projects omit plaintext `Remember`/`Recall` |
| `src/services/providerCache.ts` (`clientFor`) | Return `TeeGatedClient` for KB projects (the single enforcement point) |
| `src/services/chat.ts` | Use `effectivePrivacyMode(root)` for the guard (~519) and attachments (~511); build `KbRunContext`; filter `availableModels`/tiers/vision/transcription/image models; one delegating command only |
| `src/services/chatParticipant.ts` | Same effective mode at line 79 |
| `src/services/outboundGuard.ts`, `src/domain/config.ts`, `src/services/settings.ts` | Accept a forced mode; add KB settings (prediction backend, tile source, feed config); keep global behaviour unchanged |
| `src/services/nearAiClient.ts` | Add `embed()` (only if embeddings ship; gated) |
| `src/services/mcpRegistry.ts` | Add programmatic `callTool(serverId, tool, args)` for feeds; results go through intake, never straight to a model |
| `src/services/workspaceCommands.ts`, `src/services/projectInitialization.ts` | "Create knowledge base" option on research projects |
| `src/services/handoff.ts`, `src/services/activityStore.ts` | KB-mode redaction of summaries so claim text and entity names do not land in plaintext `HANDOFF.json` or activity files |
| `src/extension.ts`, `package.json` | Commands, settings, views; vendor entries; `.vscodeignore` needs no change (vendor ships) |
| `scripts/vendor-libs.mjs`, `scripts/extension-sbom.mjs` | Vendor MapLibre and Cytoscape with licenses |

Unchanged but reused: `src/services/contextGraphStore.ts`, `contextGraphMemory.ts` (non-KB projects), `src/agent/untrusted.ts`, `src/agent/webTools.ts`, `src/mcp/*`.

---

## 5. Data flows

**Agent writes a claim:** model calls `KbAddClaim` → `parse` (schema) → `KbAgentApi.addClaim` → verify quote against `ToolContext.pages`/snapshot → geocode place offline → check `writeCompartment` and no-write-down → quota → build entry (provenance incl. model id) → stamp HLC → sign → append to WAL → materializer applies → UI delta → later sealed into a segment → `syncEngine.push`.

**Peer entry arrives:** transport `pull` → validate header/signature/`prev` chain → unwrap epoch key → decrypt → validate role at `rosterHead` and `finalSeq` rules → quarantine on failure, else insert into histories → resolvers re-run for touched targets → view deltas.

**Slice into a run:** user/agent task → `SliceSpec` (analytic filters + readable compartments) → `KbQuery` retrieves (BM25 + graph hops) within a token budget → fenced untrusted block → prepended like `<project-memory>`; the run is marked tainted.

**Member removal:** admin previews (fingerprint) → `member-removed` entry with `finalSeq` → new `CEK_{n+1}` per affected compartment → keyrings without the member → relay suspends append immediately; git/folder rely on client validation → new writes use epoch n+1.

**Report:** analyst picks slice and threshold → `KbReport` gives the fact set → writer drafts → `ReportVerifier` checks claim ids against threshold → editor runs `CheckCitations` for web claims → export with compartment banner (approver co-sign if the policy requires).

---

## 6. Patterns to follow

1. **Histories plus pure resolvers** for anything time- or order-sensitive (3.1). Testable with shuffled delivery.
2. **Capability by construction:** tools receive an API object bound to the run's access ceiling; there is no code path from a tool to the log writer except through that API.
3. **Host-verified evidence:** quotes, hashes, and URLs come from host-held data, not model assertions.
4. **Single enforcement chokepoint** for privacy (gated client) plus tests that make bypass fail the build.
5. **Disposable views, durable log;** snapshots are an optimisation that can always be re-derived and are verified.
6. **Reuse existing patterns:** `mcpView.ts` for the panel, `memoryApproval.ts` for destructive-op approvals, `transcripts.ts` for key-in-SecretStorage, `vendor-libs.mjs` for libraries, `ProcessRunner` for git, `fenceUntrusted` for all outside text.

## 7. Anti-patterns to avoid

| Anti-pattern | Why bad | Instead |
|--------------|---------|---------|
| Extending `contextGraphStore` with temporal/encrypted/multi-writer features | Rewrites a bounded plaintext single-writer file store and couples two products | New `src/kb/` store; leave memory alone |
| Plaintext SQLite for materialized views | Defeats encryption at rest | In-memory views + encrypted partitioned snapshots; disk-backed encrypted store behind `ViewStore` later |
| Call-site TEE checks | Already inconsistent today (guard only on chat send); new sites will be missed | `TeeGatedClient` at `clientFor` plus reflection test |
| Letting the model produce thresholds/grades in report prose | Model can ignore or invent | Host `ReportBuilder` + `ReportVerifier` |
| Agent tool for retract/export/membership | An injected instruction could destroy or exfiltrate | Host-only, fingerprint-approved |
| One growing `chat.ts` case list | Existing flagged anti-pattern | Separate panel and `src/kb/bridge.ts` |
| Hash-of-name entity ids | Leaks existence across compartments and enables guessing | Random ids |
| Sync by "merge JSON files" | Conflicts and silent loss | Immutable per-author segments |
| Trusting HLC for authorisation | Clock forging reorders past removals | `rosterHead` pinning plus `finalSeq` |
| Webview talking to the network (tiles, fonts, CDN) | Leaks areas of interest and breaks CSP | Host-served custom protocol, no external origins |
| Putting the KB clone inside the workspace | Accidental commit of KB data | `globalStorage/kb/<kbId>/` |

---

## 8. Scalability considerations

| Concern | Small team (about 5, 50k records) | Department (about 50, 500k) | Org (hundreds, millions) |
|---------|-----------------------------------|-----------------------------|--------------------------|
| Sync transport | Git or folder | Git (watch size) or relay | Relay required (enforcement, fan-out, rate limits, suspension) |
| Keyring size/rotation | trivial | 5 KB per compartment | about 50 KB at 500 members; k keyrings per removal; relay suspends instantly |
| Load time | Replay tail from local snapshot | Local snapshot + partition load | Shared snapshots per compartment, lazy partition load by compartment and era |
| Memory | Everything in memory | In memory for readable compartments | Partitioned; disk-backed encrypted `ViewStore` if working set exceeds roughly 1-2M records |
| Git repo size | Fine | Segments batched, consider shallow clone | Not used |
| Graph rendering | Whole slice | Slice with LOD | Slice with LOD and server-side clustering |
| Group keys | Lockbox | Lockbox + groups | Lockbox + groups; `mls-v1` upgrade path if above about 1,000 per compartment |

These are planning assumptions, not measurements; a synthetic-volume benchmark (generate 1M entries, measure open, fold, slice) belongs in the first log phase.

---

## 9. Suggested build order (dependency-respecting)

| # | Phase | Contents | Depends on | Why this order |
|---|-------|----------|-----------|----------------|
| 1 | **Foundations: model + log + crypto + sovereignty** | `kb/model`, canonical JSON, HLC, sign/seal, segments, single-compartment keyring, directory with owner only, `TeeGatedClient` + `effectivePrivacyMode` + reflection tests, KB project flag and marker integrity | none | Everything else depends on the data model and the log; the TEE gate must exist before any model call is added |
| 2 | **Materializer + local store** | Histories/resolvers, `ViewStore` in memory, local snapshots, BM25 slice queries, synthetic-volume benchmark, KB project creation command | 1 | Gives a working single-user encrypted KB and the benchmark that decides the scale design |
| 3 | **Intake + agent tools** | `IntakeService`, STIX/CSV/GeoJSON import, `kbTools`, `knowledgeWrite` capability, slice preamble, untrusted handling, `McpFeedBinding`, RSS, folder watcher, offline gazetteer, grade proposals and resolver, regrade scheduler | 2 | Core value: agents read/write the base. Importers are model-free so they can ship early |
| 4 | **KB panel: network + reports + thresholds** | Panel scaffold, DTOs, bridge, Cytoscape RAFT view, `ReportBuilder`/`Verifier`, approval flow, exports | 3 | First user-visible outcome; reports prove threshold enforcement |
| 5 | **Team sync (git/folder) + membership + key rotation** | `LogTransport`, `GitTransport`, `FolderTransport`, `syncEngine`, invites, removal, epoch rotation, quarantine UI, convergence tests | 2 (log), 4 (UI for invites) | Multi-writer semantics need the stable log and resolvers first |
| 6 | **Organisation layer** | Compartments, roles incl. approver and policy entries, groups, `rosterHead`, no-write-down, shared snapshots + background verification, Access view, join-without-history | 5 | Builds on the membership/rotation machinery; touches views and agent run context |
| 7 | **Relay** | `src/relay/` server, `RelayTransport`, ACL enforcement, suspension, fan-out, quotas, deployment docs, threat model and tests | 6 (directory/ACL) | Separate deliverable; can proceed in parallel with 8-9 once 6 stabilises the wire format |
| 8 | **Globe + timeline/replay** | MapLibre vendoring, host tile protocol, basemap, layers per source type, timeline, world/knowledge-time scrub, keyframes | 3 (occurrences, places), 4 (panel) | Needs geocoded data and the panel; independent of sync |
| 9 | **Prediction** | Local forecaster in worker, calibration, evaluation, TEE forecaster, forecast/resolution entries, UI | 3, 8 (timeline), 5/6 (for sync of results) | Needs history; calibration needs resolved forecasts over time |
| 10 | **Hardening** | Leak-surface review (handoff, activity, search queries), disk-backed `ViewStore` if benchmark demands, accessibility, large-org load test | all | Closing phase |

Phases 8 and 9 can overlap with 5-7 if staffed separately; the hard dependencies are 1 to 2 to 3, and 5 to 6 to 7.

---

## 10. Research flags for phases

| Phase | Flag |
|-------|------|
| 1 | Standard (node:crypto). Needs decision: allow `local` runtime for KB projects or TEE strictly; whether to require `verificationStatus === 'verified'` on each call or per session |
| 2 | **Deeper research:** benchmark and decide the disk-backed encrypted store (sqlite3mc WASM vs custom) |
| 3 | Standard patterns; needs fixture corpus for injection/hidden-content tests and a STIX 2.1 mapping table |
| 4 | Standard; confirm Cytoscape + fcose performance at slice sizes |
| 5 | **Deeper research:** git edge cases (shallow clones, force pushes, hosted-git rate limits), partial-failure recovery |
| 6 | **Deeper research:** approval-required entry classes and two-person rule semantics; no-write-down UX; groups model |
| 7 | **Deeper research and security review:** relay protocol, authentication, DoS limits, replay and rollback attacks (relay serving an old prefix), metadata minimisation |
| 8 | **Deeper research:** MapLibre globe in a VS Code webview (CSP/worker build, custom protocol, `file`-served PMTiles range support), gazetteer size and licensing (GeoNames CC-BY attribution) |
| 9 | **Deeper research:** model choice and calibration method, minimum history needed, how to present uncertainty honestly |

---

## 11. Gaps and low-confidence items

- Electron/VS Code extension-host availability of `node:sqlite` is unverified; irrelevant to the recommended design but relevant to the relay (which runs on plain Node).
- MapLibre CSP-safe worker build filenames and APIs are unverified (a Nuxt wrapper doc suggests `maplibre-gl-csp.js` plus a worker URL; confirm in MapLibre's own docs).
- CesiumJS CSP friction rests on a single unresolved community thread (LOW).
- Library licences (Cytoscape MIT, fcose MIT, MapLibre BSD-3) are from training knowledge; verify during vendoring.
- Scale numbers are assumptions until the phase-2 benchmark.
- Whether NEAR currently lists any TEE-attested **embedding** model is unknown; the design avoids depending on it.
- Org-hosted relay deployment model (container, auth integration with the org's SSO) is a product decision beyond this research.

## Sources

- Repository source, read directly (HIGH): `src/services/contextGraphStore.ts`, `src/domain/contextGraph.ts`, `src/services/contextGraphMemory.ts`, `src/agent/tools.ts`, `src/agent/extraTools.ts`, `src/agent/permissions.ts`, `src/domain/policy.ts`, `src/agent/untrusted.ts`, `src/agent/webTools.ts`, `src/agent/projectTypes.ts`, `src/agent/attachments.ts`, `src/services/agentSession.ts`, `src/services/chat.ts`, `src/services/outboundGuard.ts`, `src/services/providerCache.ts`, `src/services/chatBridge.ts`, `src/services/mcpRegistry.ts`, `src/services/mcpView.ts`, `src/services/transcripts.ts`, `src/mcp/tools.ts`, `scripts/vendor-libs.mjs`, `.vscodeignore`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`, `.planning/research/v0.5.0-trusted-source-knowledge-base.md`.
- MapLibre globe projection released in GL JS v5.0.0, January 2025 (MEDIUM): https://maplibre.org/roadmap/maplibre-gl-js/globe-view , https://docs.stadiamaps.com/tutorials/3d-globe-view-with-maplibre-gl-js/
- CSP-build pattern for MapLibre via a third-party wrapper doc (LOW): https://scripts.nuxt.com/scripts/maplibre/guides/performance-csp-and-accessibility
- CesiumJS and CSP `unsafe-eval` community thread (LOW, unresolved): https://community.cesium.com/t/using-cesium-with-csp-settings/12663
- Node `node:sqlite` documentation, experimental status (MEDIUM): https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html
- Admiralty/NATO grading scale definitions, hybrid logical clocks, ECIES/HPKE-style wrapping, MLS TreeKEM (RFC 9420): training knowledge, not re-verified this session (MEDIUM).

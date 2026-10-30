# Pitfalls Research

**Domain:** Trusted-source knowledge base (Admiralty-graded claims, RAFT graph, globe, temporal replay, forecasting) with signed, end-to-end encrypted, compartmented sharing, added to an existing privacy-first VS Code extension (v0.5.0)
**Researched:** 2026-10-28
**Confidence:** MEDIUM overall. Codebase observations are HIGH (read directly). Cited external findings are MEDIUM (web search digests, several not re-fetched; see Sources). Cryptographic-protocol and performance-number guidance not backed by a citation is marked LOW and must be validated in the phase research it is mapped to.

**Scope note (updated per coordinator, 2026-10-28):** Organisation-scale sharing is IN v0.5.0: a signed, encrypted event log with snapshots; pluggable sync (git or shared folder for small teams, an organisation-hosted E2E relay for larger ones); need-to-know compartments with per-compartment keys; roles (reader, analyst, approver); a UI to manage both; group key management practical into the hundreds of members. Pitfalls P-07 to P-17 cover this.

**Suggested phase vocabulary used in the mapping (the roadmapper may re-cut; the dependencies matter more than the names):**

| Id | Phase | Content |
|----|-------|---------|
| F1 | Foundations | Event schema and envelope (author, device, compartment, epoch, HLC, prev-hash, signature), bitemporal fields, provenance model, encrypted local store, key handling, KB privacy gate (TEE-only, egress allowlist) |
| F2 | Intake and claims | Agent tools, CSV/STIX/GeoJSON import, feeds (RSS, MCP, watched folders), claim extraction, dedup, quarantine inbox |
| F3 | Grading and reports | Admiralty grading, independence/corroboration, thresholds, report rendering |
| F4 | RAFT graph and slices | Graph model, slices as views, graph webview |
| F5 | Globe | Geocoding, layers, imagery, globe webview |
| F6 | Temporal replay | Time index, replay, as-known vs as-happened |
| F7 | Small-team sync | Git/shared-folder transport, membership, key rotation (single compartment first) |
| F8 | Organisation scale | Relay, compartments, roles, snapshots at scale, group key management, admin UI |
| F9 | Prediction | Scenario forecasts, tension trends, calibration, evidence |

One ordering consequence to flag early: **compartment labels, epochs, and the signed envelope must be in F1's data model even though sync ships in F7/F8.** Derived data (grades, corroboration, embeddings, forecasts, reports) inherits compartment labels. Retrofitting that after F3-F6 means rewriting every derived-data path.

---

## Critical Pitfalls

### P-01: A new egress path bypasses the TEE-only / privacy gate

**What goes wrong:**
The existing `OutboundGuard` (`src/services/outboundGuard.ts`) is invoked on the sidebar chat send path. The v0.5.0 features add many other network and model paths that do not go through that send handler: sub-agents spawned by a research run, attachment and PDF processing, embeddings, claim-extraction batches, standing-feed agents, forecasting on "NEAR TEE models", MCP tool calls, link-preview or favicon fetches, geocoding, tile and font requests, update checks, and a relay or git remote. Any one of them using a non-TEE model, or reaching a third party, silently breaks the product's headline promise for defence and law-enforcement users.

**Why it happens:**
The guard is a per-surface instance ("one instance per chat surface") and `privacyMode` is a user-wide setting with a `confirm` outcome and one-time override tokens. The requirement is per-project and absolute for KB projects, with no override. Unknown models are treated as cloud (fail-closed) in `OutboundGuard.check`, which is good, but a new code path that constructs its own client skips the check entirely.

**How to avoid:**
- Introduce one `EgressGate` chokepoint that every KB code path must use, with a per-project policy `kb-sensitive`: TEE or local boundary only, no override tokens, no `confirm` outcome (block only).
- Make the NEAR client factory refuse to build a client for a KB project unless the gate is passed in. Sub-agents, embeddings, extraction, and forecasting get their client only from that factory.
- Maintain a destination allowlist (NEAR API host, the configured relay or git remote, user-approved feed hosts, user-approved imagery host). Everything else is blocked in the extension host (wrap `fetch`/`http`/`https`/`net` in tests, not in production) and in the webview CSP.
- Embeddings: confirm a TEE-attested embedding model exists in the catalog before relying on one (LOW: not verified). If none, use a local embedding model or lexical search (SQLite FTS-style or BM25 built in the extension). Never default to a cloud embedding endpoint.
- Add a behaviour test that runs a KB project through every intake and analysis flow with a fake non-TEE model and with a network spy, and asserts zero disallowed connections. The repo's source-regex tests (CONCERNS.md "Source-text regex tests") are explicitly not sufficient.

**Warning signs:**
A PR constructs `NearAiClient` or calls `fetch` outside the gate. A feature works with `privacyMode: standard` only. Embedding or extraction code takes a model id from a general setting instead of the project policy. A "just this once" override is requested in a KB flow.

**Phase to address:** F1 (gate and egress allowlist). Re-verified at the end of F2, F5, F8 and F9 as each adds an egress path.

---

### P-02: Interest leakage through "non-sensitive" lookups: web search, RSS polling, source checks, imagery, geocoding

**What goes wrong:**
TEE attestation protects inference content. It does not hide what the analyst is interested in from everything else the extension talks to. Specifically:
- Web search queries from v0.4.0 go to a search provider, and the query text states the research topic.
- RSS polling reveals the exact feed set, the polling cadence, and the analyst's IP to each publisher. A feed list of ten niche regional outlets is itself an intelligence requirement.
- "Source checks" (is this URL alive, WHOIS, archive lookups, link expansion) and fetching article pages for extraction reveal individual interests.
- Map tile and imagery requests reveal the area of interest and zoom level to whoever logs tile requests (OSM community answer; MEDIUM). Third-party providers also see Referer/Origin and IP.
- CesiumJS by default streams Bing-backed imagery through Cesium ion, contacting api.cesium.com and virtualearth.net hosts, and its geocoder widget also uses ion; adding your own layer on top of the default base layer still contacts ion (Cesium forum and offline guide; MEDIUM, some threads old, verify against the current release).
- Online geocoding is exactly the leak the brief rules out; a gazetteer fallback to a web API "when the offline one has no match" reintroduces it.

**Why it happens:**
Developers treat reads of public data as harmless. Library defaults (Cesium ion, MapLibre demo styles, glyph and sprite hosts, web fonts) phone home. Convenience features ("fill in missing coordinates", "expand short link") add silent fallbacks.

**How to avoid:**
- Policy: sensitive KB projects have **no ambient network**. Each egress class (search, feeds, article fetch, imagery) is a separate, per-project, default-off switch with a plain statement of what the third party learns.
- Globe: bundle a low-resolution Natural Earth basemap with the extension (CesiumJS ships one; MEDIUM) and let users point to a **local** imagery/vector pack (for example local raster tiles or a PMTiles/MBTiles file) for detail. Construct the viewer with the geocoder, base layer picker, and default imagery disabled (MEDIUM, from Cesium offline guide), and set a test that constructs it with a network spy.
- If online imagery is allowed at all: it is per-project opt-in, fetched through the extension host (so Referer, User-Agent, and cookies are controlled), and the UI says "this provider will see the area you view". Request a coarse whole-world low-zoom set from a local pack first so detailed requests are not the only signal (LOW: a mitigation, not a guarantee).
- Do not pre-seed OSM tiles: tile.openstreetmap.org forbids bulk or pre-emptive fetching and offline use, and requires an identifying User-Agent (OSMF tile policy, fetched; HIGH). That policy also makes "ship OSM tiles in the extension" non-compliant.
- Geocoding: offline gazetteer only, and no network fallback code exists at all (not a disabled flag, no code).
- Feeds: polling interval with jitter, conditional GET, a generic User-Agent that does not embed the extension version or an install id, no image/favicon/preview fetching, no following of tracking redirects, and an optional user-configured proxy. Document that the user's IP is visible to each publisher; tell them to use their own egress (VPN) for sensitive feeds. Never poll at VS Code startup for all feeds at once.
- Watched folders and MCP feeds do not send the interest outward by themselves, but the MCP server may; show which MCP servers a KB project can use and treat each as an egress destination.

**Warning signs:**
Devtools network tab in the globe webview shows any third-party host. A Cesium or MapLibre default style is used in a demo. `fetch` appears next to a geocode function. A feed adds a "favicon" or "preview image" nicety.

**Phase to address:** F1 (allowlist and policy model), F2 (feeds, source checks), F5 (globe and geocoding).

---

### P-03: Stored prompt injection: untrusted content laundered into "trusted" graph context

**What goes wrong:**
v0.4.0 fences untrusted web content, strips hidden content and detects injection. But KB items come from RSS, STIX `description` fields, CSV cells, watched-folder documents, and MCP tool results, and they are then stored, extracted into claims, and **retrieved later as the project's context graph** to augment every future agent. An injected instruction that survives extraction (or is stored verbatim as a claim quote) is replayed into future prompts as if it were curated knowledge. Injection can also target the grader: LLM-as-judge systems are measurably vulnerable to injected text in the material they score, including hidden text in documents (arXiv 2512.10449, 13 models, self-reported; MEDIUM) and optimisation-based attacks (JudgeDeceiver, arXiv 2403.17710; MEDIUM).

**Why it happens:**
The v0.4.0 defences are scoped to the web-search tool. New intake channels each need the same treatment, and retrieval from the graph is mistaken for a trusted channel. Team sharing adds another origin: a compromised member's validly signed events.

**How to avoid:**
- Every string that originates outside the analyst's keyboard keeps a `provenance: untrusted` taint through storage and retrieval, and is **re-fenced on every read into a prompt**, not just on first fetch.
- Apply v0.4.0 hidden-content stripping and injection detection to all intake adapters (CSV, STIX, GeoJSON, RSS, MCP, watched folders), not only web search. Treat STIX/GeoJSON free-text properties as untrusted.
- Store claims as structured fields plus a **verbatim quote span** that is verified by code to occur in the source text (extend the v0.4.0 citation-check and the recent "research grader catches names no source mentions and uncited facts" work). Do not store model paraphrase as the only record.
- Do not give the grading model the privilege to change state. Grade proposals are data; a deterministic rules layer applies caps and independence rules (P-04).
- Intake lands in a **quarantine inbox**; standing feeds can never directly change the grade of an existing source above a limit, or alter existing claims, without review. This also limits deliberate feed poisoning (flooding with many items to fake corroboration).
- Imported grades or confidence values (for example STIX `confidence`) are ignored as grades and recorded as unreviewed hints.

**Warning signs:**
A retrieved claim contains imperative text. Grades jump after a single ingest batch. A tool result from an MCP feed reaches the model without the fence. Tests only cover the web-search path.

**Phase to address:** F2 (intake and quarantine), F3 (grader isolation).

---

### P-04: Agent-assigned Admiralty grades are over-generous, ungrounded, and circularly corroborated

**What goes wrong:**
LLMs assign grades that are too high and too uniform. Verbalised model confidence is known to be overconfident, and RLHF-trained models tend to inflate it (arXiv 2410.09724, 2604.01457; MEDIUM). Specific failure modes for this feature:
1. **Prior-based reliability.** The model rates a famous outlet "A" from pretraining reputation instead of the source's track record inside this base.
2. **Halo between axes.** NATO reliability (A-F, about the source) and credibility (1-6, about the information) are meant to be assessed independently so that a low-rated source can supply information later confirmed (Admiralty code summaries; MEDIUM). One model call producing "B2" blends them.
3. **Credibility 1 means confirmed by other, independent sources.** Models write "1" when several documents agree, but several documents may copy one origin (syndication and wire copy, retweets, press-release echo, translations, AI-generated content farms citing each other, one satellite image reused). Counting copies as corroboration is the classic circular-reporting error.
4. **Publisher vs originator.** An outlet citing "a senior official" has the outlet's reliability but the information's reliability is the originator's. Grading only the publisher mislabels hearsay.
5. **Grade drift.** Re-grading with the previous grade in the prompt anchors; repeated "revisits" ratchet upward on weak signals; a model or prompt change shifts every grade at once (regrade storm); nondeterminism makes the same evidence yield different grades across runs, so a report generated Monday and Friday differs with no new information.
6. **F and 6 are not "worst".** In the Admiralty scale F and 6 mean "cannot be judged"; E and 5 are the worst (Admiralty code summaries; MEDIUM). Comparing letters alphabetically in a threshold check treats unknown as worse than unreliable, or the reverse, and a "min reliability" filter either drops unknowns silently or lets them through.
7. **Injection raises a grade** (P-03).

**How to avoid:**
- **Split the work.** Reliability is computed from the source's own history in the base (the share of its claims later confirmed or contradicted by independent origins, with sample size shown) plus analyst-set priors; the model may propose a prior with stated reasons, never a final value. Credibility is computed from evidence links.
- **Independence is code, not opinion.** Model provenance as first-class: each claim has `derivedFrom` links, an `originator` (distinct from `publisher`), and an `origin cluster`. Cluster by quoted-span overlap, near-duplicate text (simhash/MinHash), explicit attribution ("according to Reuters"), shared ownership/syndication tables, identical media hashes, and timing (copies follow the first publication). Corroboration count = number of distinct origin clusters, never the number of documents. When independence cannot be established, count one and mark "independence unknown".
- **Caps.** An agent cannot produce reliability A or credibility 1 on its own. Credibility 1 requires at least two independent origin clusters verified by code; A requires analyst confirmation. An agent revision moves at most one step per revision and must cite new evidence ids. A revision with no new evidence hash is a no-op and emits no event (idempotence; also prevents log bloat, P-13).
- **Defaults.** Unknown source = F; unrated claim = 6. These are a separate `unrated` state in the data model, not a rank.
- **Threshold logic** uses an explicit ordinal mapping: A>B>C>D>E, with F/6 handled by a per-project setting "include / exclude / flag unrated". Cover with a table-driven test over all 36 grades.
- **Provenance of the grade itself.** Every grade event stores model id, prompt version, evidence ids, and reason. Never auto-regrade the whole base on a model change; run it as an explicit batch with a budget (P-22).
- **Reports** render grades and sources from stored records by code. The model writes prose only, and the report checker (extend the v0.4.0 citation checks) fails the report if a displayed grade differs from the stored one or a cited claim id does not exist.
- **Calibration of the grader itself.** Keep a small analyst-labelled gold set and report agent-vs-analyst agreement and mean grade bias per model version. If the mean bias is upward, the caps are tightened.

**Warning signs:**
Most claims end at B2 or better. Credibility rises with the number of citing documents from one domain family. The same input graded differently on two runs. Analyst overrides are mostly downward. Reliability stays constant as contradictions accumulate.

**Phase to address:** F1 (provenance and origin-cluster fields in the schema), F3 (grading, caps, independence, thresholds, report checks).

---

### P-05: Claim extraction and deduplication that fabricates corroboration or loses meaning

**What goes wrong:**
- **Over-merge.** Two different events (two attacks at one place in one week) are merged, and the merged claim looks corroborated. In this domain a false merge is worse than a missed merge because it manufactures credibility.
- **Under-merge.** Fragmentation prevents genuine corroboration and floods the graph.
- **Meaning loss.** Embedding similarity matches "X attacked Y" with "X did not attack Y"; hedges ("reportedly", "alleged", "denied") and modality are dropped; numbers, units, and ranges are normalised wrongly.
- **Hallucinated extraction.** Entities or facts not in the source, or a claim with a quote that does not appear in the text.
- **Entity resolution.** Aliases and transliterations (one actor, five spellings), homonyms ("Georgia", "Jordan"), irreversible merging of two actors into one node.
- **Unstable identifiers.** Claim ids derived from model text change every run, breaking links, signatures, and sync.

**How to avoid:**
- Extraction output is a schema-validated structure: subject, predicate, object, polarity, modality/hedge, quantity, event-time interval, location with uncertainty, and a verbatim quote with character offsets. Reject any record whose quote is not found in the source text.
- Claim id = hash of (source id, normalised quote span); stable and deterministic. Low temperature, versioned extraction prompt.
- Dedup is **link, not merge**: create a `sameAs-candidate` edge with a score and reason; merging is a reversible event confirmed by an analyst, except for exact duplicates (identical source and span). Corroboration is computed over origin clusters (P-04), so a merge cannot inflate it.
- Compare polarity, modality, quantity, and time-interval before declaring similarity; embeddings only nominate candidates.
- Entities: keep alias edges, never destructive merges; scope disambiguation by type, region, and time.
- Measure on a labelled sample: precision of merges (target very high) tracked as a release criterion.

**Warning signs:**
Claim counts per source drop sharply after dedup. Corroboration counts higher than the number of distinct publishers. Negated or hedged claims appear as plain assertions. Entity count grows linearly with documents.

**Phase to address:** F2.

---

### P-06: Plaintext of sensitive material leaks through the extension's own surfaces

**What goes wrong:**
Collated intelligence ends up outside the encrypted store through side channels the feature authors do not think of as storage. Verified in this codebase:
- **Agent Activity / activity store** (`src/services/activityStore.ts`) writes full session records as plaintext JSON; `redactForDisplay` in `agentActivity.ts` removes secrets and tokens only, not claims, entity names, or places. KB tool results will flow into it, and the Markdown/JSON export writes plaintext via the save dialog (`activityView.ts`).
- **Project memory export** writes `near-ai-memory.json` into the workspace root by default (`workspaceCommands.ts`). Workspaces are often git repositories, so an export gets committed. A KB export needs the same warning at least, ideally encrypted export.
- **Output channel and errors.** `securityScan.ts` appends to an output channel; any KB code that logs a claim or a path will do the same. Node's `JSON.parse` errors can include a snippet of the input (LOW: verify on the shipped Node version), so a corrupt-record error can print content.
- **Webview state.** `retainContextWhenHidden: true` is set on the sidebar and the Tools panel (`extension.ts`, `chat.ts`); the retained renderer holds decrypted graph data in memory (the VS Code API docs flag retained webviews as high memory cost; MEDIUM). `setState` persists whatever you give it. Keep webview state to ids and viewport only.
- **VS Code settings and Settings Sync.** Feed URLs, areas of interest, and compartment names placed in `settings.json` can be synced to Microsoft's service and sit in plaintext on disk. Keep KB configuration inside the encrypted store, not in settings, `globalState`, or `workspaceState`.
- **Git history of the workspace.** `.planning/` research output and exported reports are plaintext by design; the agent can commit them. The agent shell inherits the full parent environment and the sensitive-file guard does not cover shell commands (CONCERNS.md), so an agent can `cat` or `git add` plaintext KB artefacts or read decrypted exports.
- **Crash dumps, swap, core files, heap snapshots.** Decrypted data exists in extension-host memory; full-disk encryption is the real mitigation, and the threat model must say so rather than imply encryption at rest covers it (LOW: no source, standard practice).
- **Embeddings.** Dense embeddings can be inverted to recover the text (Morris et al., arXiv 2310.06816: 92% of 32-token inputs exactly; MEDIUM, fetched). Treat any vector index as sensitive: encrypt it, do not log it, and do not sync it (recompute per member).

**How to avoid:**
- Data-flow inventory as an F1 deliverable: every place KB content could be written (files, logs, output channels, activity store, transcripts, webview state, exports, clipboard, error messages). Each has an owner and a test.
- Activity/audit records for KB tools store ids, counts, and hashes, never content; or encrypt them under the same key. Add KB-specific redaction (claim text, entity names) to the activity pipeline.
- Log by id only. A lint rule or test rejects interpolating KB fields into log or error strings. Wrap parse errors.
- Exports go through one function that applies the compartment label, writes an encrypted bundle by default, and warns clearly before writing plaintext into a git workspace.
- Extend the sensitive-path policy to shell command arguments for the KB store directory and key files (already a CONCERNS.md recommendation).
- Keep decrypted buffers short-lived, and avoid placing the data key in `process.env`, any child process environment, or any log.

**Warning signs:**
Grepping the profile and workspace directories for a known test claim string finds hits. The activity export contains claim text. `git status` after an export shows a new plaintext file.

**Phase to address:** F1 (inventory, redaction, logging rules), re-checked in every phase with a "canary string" test: seed a unique string, run the feature end to end, grep every writable location.

---

## Critical Pitfalls: signed, encrypted, shared event log

### P-07: Treating encryption as hiding metadata: names, sizes, timing, membership

**What goes wrong:**
A git repository or shared folder host (and any relay operator) sees file names, file sizes, number of objects, commit times, commit authors, branch names, push cadence, and the number of key wraps (member count). git-crypt documents exactly this: it does not encrypt file names or commit messages and does not hide when a file changes or its length; its deterministic encryption reveals that two files are identical; and it cannot revoke previously granted access (git-crypt README, search digest; MEDIUM). For this audience, "analyst X pushed 40 KB at 03:10 during an incident" is intelligence.

**How to avoid:**
- Do not use git-crypt-style transparent encryption. Use authenticated encryption with random nonces over an event envelope, with the compartment id, epoch, author, and sequence **authenticated as associated data**.
- Opaque object names (random or content-hash of ciphertext). Never put topic, author name, or compartment name in a path, branch, or commit message. Use a generic commit identity and message.
- Pad ciphertext to size buckets and batch events into sealed segments on a jittered schedule where latency allows. State the residual leak (coarse activity volume, member count) in the threat model. Do not claim "the host learns nothing".
- Compartment names, member display names, and project names live inside the encrypted admin data, never in plaintext headers.

**Warning signs:**
Directory listings of the sync repo are readable (`alice/iran-ports/2026-10-28.evt`). Ciphertext length tracks claim length. Commit messages describe content.

**Phase to address:** F1 (envelope and naming rules), F7 (transport), F8 (relay metadata, P-15).

---

### P-08: Concurrent appends, merge conflicts, and ordering

**What goes wrong:**
Two analysts append to one shared log file and git produces conflicts on ciphertext, which cannot be merged by humans or by git. Shared-folder tools (Dropbox, Syncthing, network drives) produce "conflicted copy" files, expose half-written files, and reorder arrival. File modification time is used as event order and clock skew scrambles history. Because the log is also the temporal record (replay, forecast training), wrong ordering corrupts analysis, not just sync.

**How to avoid:**
- **One writer per file.** Each device owns its own append-only stream (directory or segment sequence named by an opaque device id and monotonically increasing sequence number). No two writers ever modify the same path, so git merges are trivially clean and folder-sync conflicts cannot occur.
- Write segments atomically (temp file in the same directory, flush, rename) and tolerate partially synced files by verifying length and authentication tag before ingesting.
- Order with a hybrid logical clock plus per-author sequence and hash links, never file time. Fold events through a deterministic function; add a property test that applies the same event set in many shuffled orders and asserts identical derived state.
- Define conflict semantics per event type up front: grade changes (analyst override beats agent; two analysts: both kept, latest HLC wins for display, conflict flagged), merges and sameAs links, retractions, membership changes.
- Fast-forward-only operations on the sync clone; the extension never runs `git add -A`, never operates inside the user's workspace repo, and handles `index.lock` collisions.

**Warning signs:**
Any file in the sync location with more than one author. Derived state differs between two members after identical sync. Tests only run with events applied in creation order.

**Phase to address:** F1 (envelope, HLC, fold semantics), F7 (transport).

---

### P-09: Replay, rollback, truncation, and fork attacks by the host

**What goes wrong:**
Per-event signatures prove who wrote an event. They do not prove that you are seeing all events, in the latest state, or the same history as everyone else. An untrusted host (git server, shared folder, relay) can serve an older state (rollback), drop the newest events (tail truncation), show different histories to different members (fork or split view), or replay a validly signed event. Signature-only designs miss this; the classic untrusted-storage literature handles it with fork-consistency, hash-chained logs with signed version vectors, and client-side checks (SUNDR and related; MEDIUM). Rollback also happens locally: restoring an old backup of the local store makes a client forget events it already acted on.

**How to avoid:**
- Each author's stream is hash-chained (prev-hash plus sequence), and each event also commits to the **latest heads the author has seen from other authors** (a version vector). A host that withholds someone's events is exposed when later events reference them.
- Clients persist a **monotonic high-water mark per author** in a device-local record outside the synced store (and not inside anything a restored backup would overwrite). On regress, stop and alarm ("history went backwards"), do not silently adopt.
- Detect equivocation: two different events with the same (author, sequence) is a signed proof of a fork; surface it.
- Bind each event's signed header to base id, compartment id, and epoch so an event cannot be replayed into another base, compartment, or an older epoch.
- Members periodically write a signed checkpoint event (their observed heads), so a split view is detected through the log itself with no extra channel.
- For the relay, add Merkle-tree style signed tree heads and consistency proofs (the Certificate Transparency approach, RFC 9162; MEDIUM). Gossip and witnessing are the standard answers to split views and need participants to compare heads (MEDIUM, third-party sources).
- Be explicit about the residual: a host that simply withholds the newest events from a member who has seen nothing newer cannot be detected until someone else's checkpoint arrives. Show "last verified activity" ages in the UI.

**Warning signs:**
No test where the host reverts a file to an older version. The signed header lacks epoch or base id. "Last seen" lives inside the synced store. Verification is "signature valid" only.

**Phase to address:** F1 (header design), F7 (checks and alarms), F8 (relay tree heads, gossip).

---

### P-10: Key rotation that does not exclude the removed member, and key loss

**What goes wrong:**
- **Rotation without authorisation separation.** The removed member still has repository or relay write access and can append garbage or old-epoch events. Repository ACLs are not cryptographic membership.
- **Race and gap.** Events written by remaining members under the old epoch key after the removal are readable by the removed member. Offline members keep writing under the old key until they sync the rotation.
- **Concurrent rotation.** Two admins rotate at once, producing two "epoch N+1" keys; members adopt different ones and fork.
- **Missing rotator.** Rotation needs a member who holds the current key and is authorised; if none is online, the removed member can keep reading new data.
- **No forward secrecy.** One compromised current key reads the whole epoch.
- **History.** The removed member keeps what they had (decided), and anything in git history cannot be recalled by rewriting history.
- **Lost keys.** The data key lives in VS Code `SecretStorage`, which is per machine. A reinstall, a new laptop, a keyring reset, or a Linux keyring that is not running loses the key and the store is unreadable. SecretStorage on Linux depends on a keyring service; community reports show missing-keyring errors, a `--password-store=basic` fallback that is weaker, and startup races that dropped secrets (reports, MEDIUM-LOW; the fallback being silent is argued by a security write-up, MEDIUM). Worst variant: code sees "no key found", generates a **new** key and an empty store, then overwrites the old file.
- **Invite MITM.** Inviting "by public key" fails if the key is obtained over an unauthenticated channel.

**How to avoid:**
- Membership is a signed, ordered log of events (invite, accept, role change, remove), authorised by roles, validated by **every client** with the roster state as of the event's causal position. The remove event records the removed author's last accepted sequence; later events from them are rejected.
- Rotation event carries the new epoch id derived from the rotation event hash. Concurrent rotations resolve by a deterministic rule (lowest hash wins; losers re-wrapped). Events under a superseded epoch after the removal are accepted but flagged "written under old key" in the audit view.
- Show a "removal pending rotation" state until a rotation is completed; allow any member with the compartment-admin role to complete it; consider a short list of designated rotators to guarantee availability.
- Key hierarchy: random data key generated at creation (never passphrase-derived directly), HKDF subkeys for separate purposes, a separate signing key. Use audited libraries (libsodium or @noble-class), XChaCha20-Poly1305 or equivalent, X25519 sealed boxes for wraps; never custom constructions (LOW: standard practice, unverified for the shipped runtime).
- Each **device** is a member with its own keys. Lost device = remove that device. Another existing member can enroll a replacement. A solo base has no recovery: say so at creation and force a recovery-export step (printed phrase or encrypted file) with a confirmation that it was stored.
- **Fail loud, never regenerate.** If SecretStorage returns undefined for an existing store, stop and offer recovery; do not create a new key. Distinguish key mismatch from corruption (P-12). The existing swallow-and-reset catch patterns (CONCERNS.md) must not be copied into key paths.
- Invite requires showing a short fingerprint both parties confirm out of band.
- Onboarding detects the Linux and remote cases (headless, WSL, containers, code-server) where SecretStorage may be weak or unavailable and tells the user before data is created (LOW: platform behaviour needs verification in F1).

**Warning signs:**
A "new store created" message on a machine with existing data. No test for a SecretStorage miss. Removal UI shows success before a rotation event exists.

**Phase to address:** F1 (key handling, loss behaviour), F7 (membership and rotation), F8 (admin availability, P-17).

---

### P-11: Immutable, encrypted log versus deletion, redaction, and schema evolution

**What goes wrong:**
Append-only + E2EE + shared = you cannot delete. Real needs: a wrongly ingested document, personal data of a private individual, a classification spill, a legal order. Without a design, teams resort to rewriting git history (copies persist) or hand-editing files (breaks the chain). Separately, events are shared and immutable, so a new client version that adds an event type creates a team where old clients cannot read or drop unknown events, causing silent divergence. The existing store bounds (`maxNodesPerGraph`) throw on overflow; if one member's bound rejects an event another accepted, states diverge.

**How to avoid:**
- Redaction and retraction are events (tombstones that suppress display and derived use). For genuine erasure, design **per-item or per-segment keys** (crypto-shredding) from F1, or an admin-signed "rebase" that creates a new base without the item. Decide in F1, because adding it later changes the envelope.
- Version field in every event. Unknown event types are preserved and skipped, never dropped, and never cause a crash. A base header declares a minimum client version; clients below it go read-only.
- Limits are enforced at write (local) time with identical constants everywhere, never as silent rejection at read/fold time.
- State in product copy what immutability means for the user (and that TEE attestation and encryption are not accreditation or a records-management certification).

**Warning signs:**
No "redact" operation in the spec. Fold throws on an unknown type. Different members' node counts differ after sync.

**Phase to address:** F1 (envelope, erasure design), F7 (version gate).

---

## Critical Pitfalls: organisation scale

### P-12: Encrypted local store corruption, silent reset, and extension-host blocking

**What goes wrong:**
The current `contextGraphStore.load()` catches **any** error and substitutes an empty ledger, and the next `persist()` overwrites the file; invalid historical graph records are dropped and then persisted away (read directly in `contextGraphStore.ts`). With an encrypted store, a wrong key, a truncated write, a bit-flip, or a version mismatch would all look like "empty" and be overwritten, destroying the base. Other issues: whole-snapshot rewrite on every change (CONCERNS.md) re-encrypts and writes the full store; sql.js-style in-memory SQLite has no persistence except exporting the entire database file at a time, is bounded by memory, and has reported import times of seconds to tens of seconds at around 100 MB (sql.js digests; MEDIUM, anecdotal). Encrypted SQLite on WebAssembly has no official SQLCipher build; options are community projects with unclear maintenance (MEDIUM). A long synchronous `JSON.parse` or a decrypt of a large file blocks the shared extension host and freezes other extensions.

**How to avoid:**
- Event log + snapshots, as the brief leans: append-only segments with per-record framing and authentication, tail-tolerant recovery (drop a torn final record, never the rest), temp-file + fsync + rename for snapshots, and keep the previous generation.
- **Never overwrite on decode failure.** Rename to `.corrupt-<timestamp>`, surface the error, and offer recovery from the sync copy or backup. Key mismatch (authentication failure on a verified header) is reported differently from corruption.
- Derived indexes (maps, time index, search index) are rebuilt at load and are never authoritative.
- Heavy work (decrypt, verify, fold, snapshot, layout) runs in a worker thread or utility process; progress is reported to the UI; the key is passed in memory only.
- Do not adopt a WASM-SQLite + cipher stack in F1 without a spike measuring load, query, and persist at the target volume (that is an open question in the brief). The event-log approach avoids needing it for source-of-truth.
- Replace the swallow-and-reset catch blocks on the KB paths with surfaced errors; add fault-injection tests (truncate, flip a byte, wrong key, old schema).

**Warning signs:**
Cold start time grows with history. Extension host "unresponsive" warnings. A test passes only on a happy path. An empty base after an upgrade.

**Phase to address:** F1.

---

### P-13: Event-log growth, snapshots that are trusted blindly, and write amplification

**What goes wrong:**
- **Growth.** Agents that "keep revisiting" grades, standing feeds, and replayable history produce events at machine speed. At organisation scale (hundreds of members, standing feeds) the log grows without bound, cold start replays everything, and verification cost scales with total history.
- **Snapshot as attack surface.** A new member loads a snapshot instead of replaying. A buggy or malicious snapshot (or one built by a different client version) poisons every new joiner and nobody notices because nobody replays.
- **Snapshot vs. temporal record.** If compaction discards old events to save space, replay and forecasting training lose their data. The brief says the log is the temporal record.
- **Snapshot vs. compartments.** One snapshot containing several compartments breaks need-to-know (P-16).
- **Signature verification cost.** Verifying every event at load time in JS can take minutes at millions of events (LOW: figures depend on library; measure).

**How to avoid:**
- Snapshots are **accelerators, never replacements.** They record the exact per-author log heads they cover, are deterministic (any member can recompute and compare the hash), are signed, are encrypted per compartment and per epoch, and are verified by background replay (full or sampled) so a bad snapshot is detected. Old log segments can move to a cold tier but remain available for replay and training.
- Additional **time-keyframe** snapshots (every N events or per day) so replay at time T loads the nearest keyframe plus a tail instead of folding from the start. A time index (sorted arrays by event time and by report time) supports scrubbing without refolding.
- Suppress event noise at the source: no-op grade revisions emit nothing (P-04); agents batch a run's changes into one transaction event; apply a per-author rate limit and per-run event budget.
- Cache verification results in the local encrypted index so each event is verified once; verify new events in a worker, in batches.
- Size model for the volume decision: estimate events per analyst per day, claims per feed item, and the grade-revision multiplier; set measurable load-time budgets (for example cold start under a stated number of seconds for 1M events) and put them in F1 acceptance tests with a synthetic fixture.

**Warning signs:**
Snapshot created by a single client and never cross-checked. Event count per claim greater than 3 on average. Cold start time reported only on small test data.

**Phase to address:** F1 (event economy, budgets), F6 (keyframes), F8 (snapshot signing and per-compartment form).

---

### P-14: Git (and shared folder) as transport hits a ceiling: push contention, repo growth, ciphertext incompressibility

**What goes wrong:**
- **Push contention.** With dozens to hundreds of writers pushing to one branch, most pushes are rejected as non-fast-forward and retries storm. Many refs (one per device) slow fetch.
- **Repo growth.** Ciphertext looks random, so git cannot delta-compress successive versions and `git gc` cannot shrink it (LOW: standard property of random data; confirm with a measurement). Appending to the same encrypted file creates a full new blob each time. The repo grows linearly with every byte ever written, and every clone downloads all of it.
- **Hosted limits.** Hosted git has size guidance and limits: GitHub documents a recommended repository size and limits on push size and object size (Enterprise Server docs digest: 10 GB recommended, 2 GB push, 1 MB recommended / 100 MB enforced per object; older help text said under 1 GB; MEDIUM, check the host actually used). Shared folders add per-file sync overhead on many small files.
- **Many tiny objects.** One file per event is slow to sync; one big append-file is unmergeable (P-08).
- **Credentials and egress.** Pushing is network egress to a host the team controls; it exposes IP and timing and needs credentials the extension must not log or store in the workspace.

**How to avoid:**
- Segment design: each device writes sealed segments (for example up to a size or time cap) rather than per-event files or a growing single file, and never rewrites a sealed segment.
- Per-device branches or paths so pushes never conflict; a fetch-and-merge step that cannot conflict by construction.
- Declare the git/folder transport's supported envelope in product copy and in code (for example "tens of members, stated event rate and total size") and show a size/health meter. Above the envelope the UI recommends the relay. Because the log is transport-agnostic, **migration between git and relay must be a tested path** (replaying the same segments), not a rewrite.
- Provide an archive/rebase procedure for the git transport (new base repository from verified snapshot plus cold storage) and test cloning at a large size.
- Push on a user-visible schedule with jitter; credentials via the user's own git credential helper.

**Warning signs:**
Push retry loops in logs. Clone time or repo size trending upward faster than data volume. Per-event files in the sync directory.

**Phase to address:** F7 (limits, segments, migration path), F8 (graduation to relay).

---

### P-15: The organisation-hosted relay: what it still sees, who may append, availability, and trust

**What goes wrong:**
- **Metadata.** The relay sees member identities or keys, IP addresses, connection times, object sizes, per-compartment stream ids, who reads which compartment (a fetch pattern reveals need-to-know membership), and the existence and activity level of compartments. Relay operators are not necessarily cleared for the content of compartments, and need-to-know covers metadata too.
- **Append authorisation without plaintext.** The relay must refuse appends from non-members and readers, but cannot read events. If role information is in a cleartext header, roles leak; if the relay holds the ACL, the ACL is metadata it learns. If the relay is the only enforcer, a compromised relay admin forges permission.
- **Integrity trust.** The relay can drop, reorder, replay, roll back, and fork (P-09). If clients trust relay-side enforcement, there is no defence.
- **Availability.** Relay down = no sync; a stalled client queue grows; DoS by an authorised-but-malicious or buggy member flooding with valid events; storage exhaustion.
- **Scope creep.** A relay is a server product (TLS, SSO or identity integration, backups, upgrades, monitoring, protocol versioning) inside a VS Code extension milestone.

**How to avoid:**
- Keep the relay dumb: an append-only store of opaque, signed, encrypted objects per stream, with a per-stream head. Stream and compartment ids are random opaque values. No plaintext fields beyond what is required for routing and quota.
- Authentication by the member's own signing key (challenge-response), not a separate password system, so one identity covers both. Append authorisation uses **signed capability tokens** issued under the membership log (per stream, expiring, revocable). The relay verifies the token and the event signature; it does not know roles. **Clients re-validate role and membership on every event** (the relay's checks are a convenience and a DoS shield, not the security boundary).
- Relay-side signed tree heads with consistency proofs, plus member checkpoints inside the log, so clients detect rollback and split view (P-09).
- Local-first: all work continues offline; an outbox with backoff; sync status is visible. Define rate limits, quotas per member and per stream, and a quarantine/skip mechanism for floods.
- Publish the metadata the relay learns in the threat model, and offer mitigations: padded sizes, batched uploads, optional fetch-all-compartments polling so read patterns do not reveal membership (cost: bandwidth; LOW as a trade-off to validate).
- Treat the relay as a separate deliverable with its own acceptance tests and a versioned protocol; run an integration test with a malicious relay harness that drops, reorders, replays, and rolls back.

**Warning signs:**
Role names appear in relay logs. The client trusts a "403 forbidden" instead of verifying signatures locally. No malicious-relay test. Relay stores plaintext group rosters.

**Phase to address:** F8 (with the protocol and header decisions made in F1).

---

### P-16: Compartments leak across boundaries through derived data, references, agents, and moves

**What goes wrong:**
Per-compartment keys give cryptographic separation of stored events. Everything computed over several compartments is where need-to-know quietly fails:
1. **Cross-compartment references.** An edge from an actor in compartment A to an actor in compartment B reveals B's existence. The "one broad graph" does not exist for any single reader; each reader's graph is the union of the compartments they hold.
2. **Reader-relative derived values.** Corroboration, credibility "1", dedup candidates, search ranking and counts, and forecast evidence computed across compartments act as side channels: an A-only reader sees a claim upgraded because of B-content, inferring B content. Grades therefore cannot be a single global value if they use out-of-compartment evidence.
3. **Aggregation.** An agent that reads A and B produces output that only people with A and B should read. Reports, summaries, embeddings, caches, Agent Activity transcripts, and forecasts mixing sources must carry the **join** of their inputs' labels.
4. **Moving data between compartments.** The source log is immutable, so a "move" is copy + tombstone, and anyone who held the source key keeps the original. Downgrade (more to less restricted) is a disclosure decision that needs sanitisation and an approver; an agent or script must not do it automatically. The copy also manufactures **false independence** (a copy in B "corroborates" the original in A) unless the copy carries a provenance link that the origin-cluster logic respects (P-04). A provenance link to the source compartment itself leaks existence.
5. **Local caches.** The client holds the union of the user's compartments in memory, indexes, and caches. On revocation the local plaintext of that compartment must be purged on a best-effort basis (the member's existing copies cannot be recalled).
6. **Names.** Compartment names and codewords are sensitive; they must not be in plaintext headers, file names, UI telemetry, or logs.

**How to avoid:**
- Every record (event, derived value, index entry, report, activity record) has a `labels` set of compartment ids. Derived data is computed only from inputs the **viewer** can decrypt, and stored under the key of the strictest input set (high-water mark). Define this rule in F1 and enforce it in a single `LabelledStore` interface so features cannot bypass it.
- Cross-compartment references: store the reference inside the more restricted event only, or as an opaque stub whose existence disclosure is a deliberate, documented decision. Render "restricted node" stubs only where policy allows.
- Agent runs are launched with an explicit compartment set; tools enforce it server-side in the extension; the run output label is the join. Sub-agents inherit the parent's set, never more.
- Move operations: require the `approver` role for any downgrade, show a diff of exactly what will become readable, strip or hash provenance as policy dictates, record the decision as a signed event, and register the copy as the same origin cluster as the source.
- Reports and exports show their compartment marking; refuse to export a mixed-label artefact to a destination or audience that lacks the labels.
- Tests: a fixture with two compartments and a user holding one; assert no output (graph, search count, corroboration, grade, forecast, embedding hit, error message) differs from the same base with the other compartment's data deleted. This "indistinguishability" test is the acceptance criterion.

**Warning signs:**
A single global dedup or corroboration pass over all events. Search "N results" counts include unreadable compartments. A report generated by an agent with no labels. A "move to compartment" button without an approver step.

**Phase to address:** F1 (labels in the model and `LabelledStore`), F3 (reader-relative grading), F4 and F9 (graph and forecasts honour labels), F8 (UI, moves, purge).

---

### P-17: Roles are mistaken for cryptography; admin and key management does not stay practical at hundreds of members

**What goes wrong:**
- **Reader / analyst / approver.** Reading is cryptographic (holding the compartment key); appending and approving are authorisation. If a "reader" holds the key and writes are checked only by the relay or UI, a reader can forge events. Role changes are not keys: demoting an analyst to reader needs no rekey but must immediately stop accepting their appends.
- **Role evaluation time.** Validating an event against the *current* roster wrongly invalidates old events after a role change; validating against no roster accepts forgeries. It must be the roster as of the event's causal position.
- **Approvals.** A single approver is a single point of failure and of compromise; approver actions (downgrades, grade overrides above a limit, member grants) need a two-person rule for the sensitive ones.
- **Admin root.** Who is the root of trust? A single org key is a single point of loss or compromise. Lost admin keys lock the organisation.
- **Churn.** People leave without anyone issuing a removal (inactive members remain); an HR departure must trigger removal events. Inactive members are a known weakness of group key schemes: a single stale or corrupted inactive member can undermine post-compromise security, and RFC 9420 only recommends removing members offline too long (IACR 2023/1903; MEDIUM).
- **Rotation storms.** Removing someone in 30 compartments means 30 rotations, each wrapping to every remaining reader.
- **Grant mistakes.** A wrong grant is irreversible for past data. A large matrix of members x compartments in a UI is error-prone.
- **Identity binding.** At organisation scale, "invited by public key" needs binding to a person (directory, SSO, in-person check) or an attacker substitutes a key.

**Per-member wrapping vs MLS (RFC 9420) at hundreds of members:**
- *Per-member wrapping* (a random symmetric key per compartment and epoch, sealed to each member's public key): cost is O(n) wraps per rotation, but each wrap is on the order of 100 bytes, so a rotation for 500 members is tens of kilobytes (arithmetic estimate, LOW) and trivial to compute. Practical cost is elsewhere: number of compartments x members, offline members, rotator availability, and verifying the roster. It has no forward secrecy and no post-compromise security beyond the rotation itself. It needs no ordering service, so it works over git, folders, and relay.
- *MLS* gives forward secrecy and post-compromise security with costs scaling with log of group size, and notes that sender-key designs need on the order of squared message volume to achieve post-compromise security (RFC 9420 text via search digest; MEDIUM). It needs a delivery service that orders commits, handles concurrent commits poorly without one, adds key-package management for asynchronous joins, and its security degrades with inactive members (above). Library maturity in JS/WASM for an extension host is unverified (LOW). Git and folders do not provide the ordering MLS expects; the relay could.
- **Recommendation:** ship per-member wrapping with epoch keys for v0.5.0, behind a `GroupKeyProvider` interface so MLS could replace it per compartment later. Revisit MLS if requirements add post-compromise guarantees or if rotation frequency x member count makes wrapping the bottleneck. Do not hand-roll a tree scheme. Add scheduled rotation (for example on a policy interval) for compartments that need partial forward secrecy.

**How to avoid:**
- Signed membership and policy log (an org-level admin compartment). Every client folds it and validates each event's author, role, compartment, and epoch against the roster at that causal point.
- Reads are keys; writes and approvals are role-checked signatures verified by all clients. The relay's check is advisory (P-15).
- m-of-n (threshold) for admin-root actions; a documented recovery path for lost admin keys (secret-shared recovery); designated rotators per compartment.
- Group-based grants (roles and groups, not individual-by-individual wraps in the UI) with a **preview**: "N people will be able to read M events from epoch E", and approval for sensitive compartments. New members receive keys from the join epoch by default; reading earlier history is an explicit, logged grant.
- Offboarding integration: a removal can be driven by a signed request from the admin UI or, later, a directory sync; list inactive members and require periodic re-confirmation.
- Batch rotation: removal across compartments produces one transaction that rotates all affected compartments, with a progress and failure UI and a visible list of "still readable by removed member until rotated".
- Invites verify a fingerprint or a directory-signed binding.

**Warning signs:**
Role is stored as a UI flag. A rotation takes minutes of UI blocking at 200 members. No tested path for "last admin lost their key". Grants have no preview or audit.

**Phase to address:** F7 (single-compartment membership and rotation), F8 (roles, groups, compartments, scale, UI, threshold admin).

---

## Critical Pitfalls: analysis features

### P-18: RAFT graphs become unreadable hairballs, slices lose context, and tension is vibes

**What goes wrong:**
- **Hairball.** Every extracted noun becomes an actor and every co-mention an edge. A force-directed layout of thousands of nodes is unreadable, jitters on every update, and changes shape between renders so users lose their mental map during replay.
- **Edge semantics.** "Tension" (positive, negative, neutral) assigned by a model per claim, shown by red/green only; contradictory evidence both drawn as edges.
- **Slices as copies.** Slices that copy data diverge from the master; an agent working in a slice misses out-of-slice links and concludes wrongly; the slice definition drifts.
- **Renderer limits.** Cytoscape.js is commonly positioned for hundreds to low thousands of nodes, while sigma.js (WebGL) is positioned for tens of thousands; the sources disagree and are vendor claims (digests; MEDIUM-LOW). Measure in the webview.

**How to avoid:**
- Actors are promoted from mentions only when they pass a threshold (supporting claims, independent origins) or are pinned by an analyst. Constrain actor types and function vocabulary.
- Aggregate parallel edges into one edge with counts, a signed tension value with its evidence list, and drill-down. Keep claims in a separate layer from the actor graph.
- Open on a **slice**, never the whole graph. A render budget (maximum visible nodes and edges) with degree filtering, k-core, or community collapse into super-nodes for overview.
- Deterministic, seeded layout computed in a worker and positions persisted so the picture is stable; incremental relayout limited to changed neighbourhoods.
- Slices are saved queries (views) over the single graph, not copies. Show boundary stubs ("14 edges leave this slice"). The agent tool takes a slice id and enforces it; slice serialisation into a prompt is capped and counted against the context budget.
- Edges and nodes have validity intervals so the time slider works (P-19). Tension is encoded redundantly (colour, line style, glyph) and a table view exists for keyboard and screen-reader users (CONCERNS.md notes accessibility is untested).

**Warning signs:**
First paint shows more than a few hundred nodes. Layout changes after unrelated updates. Slice results differ depending on how the slice was opened. An agent conclusion contradicts an out-of-slice edge.

**Phase to address:** F4.

---

### P-19: Temporal replay conflates event time, report time, and grade time; hindsight leaks into replay and training

**What goes wrong:**
The brief records when it happened, when it was reported, and when it was graded. Conflating them breaks replay: an event on day 3 reported on day 10 should not appear in a "what did we know on day 5" view, yet should appear in "what happened by day 5". The standard framing is bitemporal: actual (valid) time versus record time, keeping the actual history editable while record history stays append-only so "what we thought on any date" is recoverable (Fowler, Bitemporal History; fetched, HIGH for the concept). Additional traps: sync/receive time is a fourth time (an analyst's event written offline and synced later); unknown event time stored as report time; relative dates ("last week") resolved against the wrong anchor; date format ambiguity (DD/MM vs MM/DD); time zones; ranges and granularity ("in March"); clock skew between analysts; retroactive grade changes rewriting the past; deletions and retractions; and replay performance that refolds the log per scrubbed frame.

For forecasting this is worse: training or backtesting on event-time ordering with later-known facts is look-ahead leakage, and forecasts look accurate in tests and fail live.

**How to avoid:**
- Store: `eventStart/eventEnd` (interval, nullable, with granularity and certainty), `reportedAt`, `ingestedAt` (local), `gradedAt` per grade event, and the signed HLC. UTC ISO-8601 only; the parser records the original string and resolution method.
- Two replay modes, labelled in the UI: **as happened** (filter by event time) and **as known** (filter by record/grade time, using the grade as it stood then). Default for any forecast or backtest: as known.
- Grade history is a timeline of events; "current grade" is the latest, "grade at T" is available. Retractions and corrections are events that apply from their record time.
- Precomputed time indexes and keyframe snapshots (P-13) so scrubbing is O(log n) plus a delta.
- Tests with a fixture of late-reported events and later-corrected grades asserting the as-known and as-happened views.

**Warning signs:**
A single `timestamp` field on claims. Replay shows an event before anyone reported it. Backtest accuracy is suspiciously high. The slider stutters on 100k events.

**Phase to address:** F1 (fields), F2 (date parsing), F6 (replay), F9 (leakage-safe training).

---

### P-20: Forecasts that look authoritative: false precision, no evidence, no base rates, uncalibrated

**What goes wrong:**
- **LLM-emitted numbers.** Verbalised probabilities from an LLM are overconfident (P-04 sources) and not calibrated; "trained locally" or "on TEE" may in practice mean in-context prompting, which trains nothing.
- **False precision.** "63.4%" from a few dozen events.
- **No evidence.** A probability displayed without its basis; or evidence that is the same circular source repeated (P-04).
- **Base-rate neglect.** The model reasons from the vivid scenario and ignores the reference-class frequency. Superforecasting evidence points to base rates, small frequent updates, and decomposition as the habits that separate good forecasters, and to scoring (Brier) against resolvable questions as the way to know (Tetlock/Gardner summaries; MEDIUM).
- **Selection bias.** The base records what was reported and what sources were chosen; absence of reports is not zero probability. Small-team data is small; rare events cannot be learned.
- **Non-stationarity and overfitting**, especially when "training on history" with a few hundred events.
- **Overreactive recalibration.** "Recalibrated as events arrive" can swing on the latest event; refitting on the outcomes being scored leaks.
- **Grades as probabilities.** Treating B2 as 0.8. The Admiralty grade expresses source/information quality, not likelihood; analytic standards keep likelihood and confidence in the basis as separate statements (ICD 203 digest; MEDIUM).
- **Scenario sets** that are not mutually exclusive and collectively exhaustive, so probabilities do not sum or omit "other".
- **Tension trends** drawn from three points.

**How to avoid:**
- The number comes from an auditable method (reference-class base rate with count n, a simple Bayesian or hazard-type update, small models in a worker), not from an LLM's stated percentage. The LLM proposes scenarios, features, and the reference class, and writes the explanation; the system computes and displays the number, interval, and sample size.
- Every forecast has: a resolvable question with resolution criteria and date, the reference class and n, an interval, the evidence list (claim ids with grade and **independent origin count**), the method and version, and a "what changed since last time" note. Below a minimum evidence/size threshold the UI shows "insufficient basis" instead of a number.
- Quantise displayed probabilities (coarse steps or standard verbal bands, noting that ICD 203 band values were not verified against the primary text) when n is small; widen intervals with small n.
- Immutable forecast log (forecast events with inputs hash and model version). Score with Brier/log loss on resolved questions and show a reliability diagram. Recalibrate only after a stated minimum count of resolved forecasts, with shrinkage and capped step size, and never on data used for the forecast.
- Scenario sets include "other/none" and sum to 100%. Tension trends use smoothing, show bands, and refuse trend language for fewer than a stated number of points.
- Label where the model runs ("local model, trained on N events" versus "TEE LLM in-context, not calibrated"). Be explicit about what the user's choice means.
- Leakage-safe training uses as-known time (P-19).

**Warning signs:**
A forecast with no list of evidence. Probabilities to 0.1% on small n. Scores never computed. Recalibration changes after every ingest. A forecast moves with the number of articles, not independent origins.

**Phase to address:** F9, with prerequisites in F3 (independence), F6 (as-known time), F1 (immutable forecast events).

---

### P-21: Webview performance for large graphs and the 3D globe

**What goes wrong:**
- Retained webviews: `retainContextWhenHidden: true` (already used for the sidebar and tools panel) keeps scripts and memory alive; the API docs say it has high memory overhead and recommend persisted state instead (MEDIUM). Graph plus globe retained = very large memory. Hidden retained webviews are also suspended, so a WebGL animation is not truly running.
- Message passing: posting a whole 100k-edge graph as JSON blocks both sides. Send slices, viewport-scoped data, and chunks.
- Layout and parsing on the webview main thread.
- Globe: thousands of entities via a high-level entity API, one data source per OSINT source, rebuilding layers on toggle, no clustering, continuous rendering, destroyed viewers not disposed (leaks), time-slider animation re-creating primitives. (LOW: general Cesium/WebGL practice; confirm in a spike.)
- Environments without a GPU: remote hosts, WSL, containers, code-server, VMs. WebGL may be software-rendered or unavailable; a globe-only UI is unusable there.
- CSP temptation: Cesium and MapLibre need workers, blob URLs, and WebAssembly; the response is often to loosen `default-src 'none'` with broad `connect-src`/`img-src`, which opens exfiltration paths through image requests (P-02). The existing CSP and nonce pattern should be kept (CONCERNS.md), with only the narrow additions (`worker-src blob:`, `'wasm-unsafe-eval'`) and local-resource-root access to bundled assets.
- Bundle size and supply chain: Cesium is large and needs static assets (workers, assets, widgets) copied and a base URL pointing to webview resource URIs; the extension already vendors libraries (`vendor/`), so reuse the integrity pattern (CONCERNS.md flags unpinned runtime installs as a risk).
- Library status: MapLibre GL JS has had a globe projection since v5.0.0 (January 2025) and is now on v6 (search digest; MEDIUM), so verify globe maturity on the chosen version.
- Tests: existing webview tests are source-regex or small e2e; no performance budget exists.

**How to avoid:**
- New KB webviews use `retainContextWhenHidden: false`, `getState`/`setState` holding ids and viewport only, and a snapshot from the extension host on reveal (the Agent Activity view already follows this pattern).
- A render budget per view; clustering and level-of-detail; layer toggles flip visibility, not rebuild; request-on-change rendering where the library supports it; explicit viewer disposal; heavy layout and clustering in workers, with positions cached.
- Feature-detect WebGL (and hardware acceleration) and fall back to a flat 2D map plus a table; test the fallback in CI via a disabled-GPU configuration.
- Message protocol: typed, chunked, viewport-scoped; include a size cap; measure serialisation time in tests.
- Performance acceptance fixtures (for example 10k nodes / 50k edges for the graph, 50k points across layers for the globe) with measured frame time and memory budgets in the e2e suite, treated as diagnostic until budgets are agreed.
- Spike CesiumJS vs MapLibre globe against: no-token offline operation, local imagery packs, CSP, bundle size, point-count performance, GPU-less fallback. Decide in F5 research with measured results.

**Warning signs:**
Extension host memory above a stated budget with the globe open. Frame drops on layer toggle. A CSP change to allow `https:`. WebGL context-lost warnings.

**Phase to address:** F4 (graph), F5 (globe), F6 (time slider), F1 (webview conventions).

---

### P-22: Unattended agents: spend and loop control, and testing blind spots

**What goes wrong:**
Standing feeds and "keep revisiting grades" create runs nobody is watching. The spend limit is checked per message, not between turns of one run (`SECURITY.md`, CONCERNS.md), so a long autonomous KB run can overshoot the daily limit. The emergency stop must also halt background feed agents. The repo's tests that match source text (CONCERNS.md) have passed for features that did not run, which is dangerous for crypto and sync code where "looks right" is not enough. Context-graph writes persist whole snapshots without a shared queue in some stores (CONCERNS.md).

**How to avoid:**
- Per-run and per-day KB budgets enforced between turns and per batch, including regrade batches and forecasting; the emergency stop and the budget apply to feeds and sub-agents.
- Background work is opt-in per project, visible in the UI with a "what ran and what it cost" feed, and has a per-run event budget (P-13).
- Behaviour tests with real objects: crypto known-answer tests, tampered ciphertext/signature/header rejection, wrong-key, replayed event, rolled-back store, two-device convergence under shuffled delivery, malicious relay harness, two-compartment indistinguishability (P-16), canary-string leak scans (P-06). No source-regex tests for any of these.

**Warning signs:**
A background run with no cost entry. A crypto "test" that asserts a function name exists.

**Phase to address:** F1 (budget and test harness conventions), then each phase.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single `timestamp` per claim | Simple schema | Cannot replay "as known"; forecast leakage; migration across a signed immutable log | Never |
| Skip compartment labels until sharing ships | Faster F2-F6 | Every derived path must be reworked; leaks by default | Never (labels in F1; one default compartment is fine) |
| Model-written grade text in reports | Quick report prose | Mismatch with stored grade; hallucinated grade | Never; render grades by code |
| One shared append file for all authors | Simplest sync | Unmergeable conflicts, folder-sync duplicates | Never |
| Passphrase-derived key only, no recovery | Simple UX | Unrecoverable loss, weak key | Only with an explicit recovery export step |
| Whole-store JSON rewrite (current pattern) | Reuse `contextGraphStore` | O(history) latency, reset-on-error data loss | Prototype only; not for the encrypted store |
| Plaintext Agent Activity for KB tools | No new code | Content leaks to disk and exports | Never for KB projects |
| Cloud embeddings "for now" | Quicker relevance search | Violates TEE-only; irrecoverable once sent | Never |
| MLS in v0.5.0 | Best cryptographic properties | Ordering service dependency, library maturity, schedule risk | Not in v0.5.0; keep the provider interface |
| Hand-rolled crypto constructions | Avoid a dependency | Subtle breaks | Never; use audited primitives |
| Loosened webview CSP to make the globe work | Globe renders | Exfiltration channel via image/connect requests | Never beyond workers and wasm |
| Snapshots without verification | Fast load | Poisoned joiners | Never; sign and background-verify |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| NEAR AI models | New sub-agent/embedding code builds its own client | Single client factory requiring the KB egress gate; unknown models fail closed |
| v0.4.0 web search | Fencing applied only to search results | Apply fencing, stripping, and injection detection to every intake adapter and on every retrieval |
| MCP feeds | Trusting tool output as structured data | Treat as untrusted text; each server is an egress destination; show it in project policy |
| RSS | Poll all feeds at startup with a default User-Agent | Jittered schedule, generic UA, conditional GET, no previews, optional proxy |
| STIX / CSV / GeoJSON import | Importing producer `confidence` or free text as truth | Map to unreviewed hints; sanitise and fence text; strict schema and size limits; coordinate order lon,lat |
| CesiumJS | Default viewer contacts ion and Bing; geocoder widget | Disable geocoder, base layer picker, default imagery; local imagery pack; test with network spy |
| MapLibre | Demo style, glyph, and sprite URLs | Self-contained local style and assets only |
| OSM tiles | Pre-fetching tiles for offline | Forbidden by the OSM tile policy; use local data or a provider that permits it |
| GeoNames gazetteer | Plot city centroid as event location; first match wins ("Georgia") | Store geocode method, confidence, and uncertainty radius; ambiguity goes to review |
| Git remote | Operate in the workspace repo; `git add -A`; credentials in config | Dedicated clone, per-device paths, fast-forward only, user's credential helper |
| Shared folder (Dropbox, Syncthing) | Read half-synced files; trust mtime | Atomic rename writes; verify length and tag; HLC and hash chain |
| VS Code SecretStorage | Assume it is a hardware-backed keychain everywhere; regenerate on miss | Detect weak/absent backends, warn, require recovery export, never regenerate |
| VS Code Settings Sync / globalState | Store feed URLs or AOIs in settings | Keep KB config inside the encrypted store |
| Webview | `retainContextWhenHidden`, full graph over postMessage | State by ids; chunked viewport messages; dispose WebGL on hide |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Replay whole log on open | Slow start, unresponsive extension host | Snapshots with verified heads, keyframes, worker | Hundreds of thousands of events (measure in F1 fixture) |
| Verify every signature on every load | Minutes of CPU | Cache verification results; batch in worker | Hundreds of thousands to millions of events (LOW) |
| Whole-store rewrite per change | Latency grows with history | Append segments; periodic snapshot | Tens of MB |
| In-memory WASM SQLite export per save | Memory spikes, seconds per save | Avoid for source of truth | Around 100 MB (anecdotal) |
| Ciphertext in git | Repo and clone time grow linearly; no delta | Sealed segments; archive/rebase; relay above envelope | Months of active use with many writers |
| Non-fast-forward push storms | Retries, rejected pushes | Per-device paths/branches | Dozens of concurrent writers |
| Force layout of the full graph | Hairball, jitter, frozen webview | Slices, budgets, seeded worker layout, WebGL renderer | Low thousands of nodes on SVG/canvas renderers; verify per library |
| Entity API for globe points | Slow frames | Batched primitives, clustering, request-on-change | Thousands of points (LOW) |
| Time scrub refolds events | Stutter | Time index and keyframes | Tens of thousands of events |
| Regrade storms | Cost spike, event flood | No-op suppression, budgets, explicit batch | Any model or prompt change |
| Rotation across many compartments | Long blocking UI, partial failures | Batch transaction, progress and retry, worker | Hundreds of members x tens of compartments |
| Dedup all-pairs | Quadratic time | Blocking keys + approximate nearest neighbour for candidates | Thousands of claims |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Cloud/non-TEE model or embeddings in any KB path | Disclosure of sensitive intelligence to a third party | Egress gate; fail-closed; behaviour tests (P-01) |
| Interest leakage via search, feeds, tiles, geocoding | Reveals tasking and area of interest | Default-off egress classes; local imagery and gazetteer (P-02) |
| Stored injection in graph context | Persistent compromise of future runs | Taint and re-fence on read; quote verification; quarantine (P-03) |
| Agent can set top grades | Fabricated credibility drives reports and forecasts | Caps, code-computed independence, analyst confirm for A/1 (P-04) |
| Plaintext in activity store, logs, exports, settings | Disclosure outside the encrypted store | Data-flow inventory; id-only logging; encrypted export (P-06) |
| Signature-only integrity | Rollback, truncation, fork by host | Hash chains, vector commitments, high-water marks, tree heads (P-09) |
| Repo/relay ACL treated as membership | Removed member keeps writing | Signed membership log; all clients validate (P-10, P-17) |
| Rotation without a completion state | Removed member reads new data | Pending-rotation state, designated rotators, atomic batch (P-10) |
| Silent key regeneration on miss | Data loss presented as a fresh store | Fail loud, recovery flow (P-10) |
| Cross-compartment derived data | Need-to-know breach by inference | Labels, high-water mark, reader-relative computation (P-16) |
| Downgrade by an agent | Classification spill | Approver role, signed move, human sanitisation (P-16) |
| Relay trusted for integrity | Compromised relay forges or hides | Client-side validation, tree heads, checkpoints (P-15) |
| Data key in env or logs; agent shell can read key files | Key exposure | Keep key in memory only; extend path policy to shell arguments |
| Overstating guarantees ("accredited", "nothing leaves") | Operational misuse in sensitive settings | Threat model in product copy: what is and is not protected (metadata, endpoint compromise, co-resident extensions) |
| Co-resident malicious extension | Extensions share the host process; research documents credential theft from VS Code extensions (control-plane write-up; MEDIUM) | State in the threat model that at-rest encryption does not defend a compromised host; recommend a dedicated profile |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing "B2" with no reason | Users cannot challenge it | Always show reasons, evidence, independence count, and history; one-click override recorded |
| "Unknown" shown as "worst" | Misread unrated claims | Distinct unrated state with its own style; explicit threshold setting |
| Probabilities as bare percentages | False authority | Interval, n, evidence, "insufficient basis" state |
| Whole-graph view by default | Hairball | Open on a slice with a visible boundary count |
| Replay mode ambiguity | Wrong conclusions | Persistent label: "As happened" vs "As known on <date>" |
| Silent sync problems | Teams work on divergent views | Visible sync/health status, last verified time, fork/rollback alarms |
| Compartment grants as a huge matrix | Irreversible mis-grants | Groups, preview of what becomes readable, approvals for sensitive compartments |
| Removal reports success immediately | False security | "Removed, rotation pending" until rotated |
| Hidden recovery step | Locked-out users | Forced recovery export at creation; clear "no recovery" message for solo bases |
| Colour-only tension | Inaccessible | Colour plus style and glyph; table alternative |
| Globe-only geospatial | Unusable without GPU | 2D fallback and table |
| Plaintext export default | Accidental commit | Encrypted by default, warning for plaintext |

## "Looks Done But Isn't" Checklist

- [ ] **Egress gate:** Often missing sub-agents, embeddings, feeds, imagery -- verify with a network spy across every flow in a KB project.
- [ ] **Offline globe:** Often still contacts ion/Bing/glyph hosts -- verify zero third-party requests with imagery disabled and with a local pack.
- [ ] **Offline geocoding:** Often has a network fallback -- verify the code has none; verify uncertainty radius stored.
- [ ] **Grading:** Often model-only -- verify caps, independence computed by code, F/6 handled, idempotent revisions, grade reason and model/prompt version stored.
- [ ] **Thresholds:** Often compare letters alphabetically -- verify a table test over all 36 grades and the unrated option.
- [ ] **Reports:** Often show model-typed grades -- verify grades rendered from records and a checker fails mismatches.
- [ ] **Dedup:** Often merges destructively -- verify merges are reversible events and corroboration uses origin clusters.
- [ ] **Encrypted store:** Often resets on error -- verify wrong key, torn write, and bit-flip tests never overwrite.
- [ ] **Key loss:** Often regenerates a key -- verify SecretStorage-miss path, recovery export, device re-enrolment.
- [ ] **Sync:** Often single shared file and mtime ordering -- verify one-writer-per-file and shuffled-delivery convergence.
- [ ] **Rollback defence:** Often signature only -- verify rolled-back host and restored-backup tests raise an alarm.
- [ ] **Rotation:** Often generates a key but leaves membership to repo ACL -- verify removed member's later events are rejected and pending-rotation is visible.
- [ ] **Relay:** Often trusted for authorisation -- verify a malicious-relay harness cannot forge, hide, or fork undetected.
- [ ] **Compartments:** Often separate only at storage -- verify the indistinguishability test on graph, search counts, grades, forecasts, embeddings, errors.
- [ ] **Moves:** Often a copy that looks independent -- verify origin-cluster link and approver step.
- [ ] **Snapshots:** Often unverified -- verify signed heads, deterministic recompute, background verification.
- [ ] **Redaction:** Often absent -- verify a redact/erase path exists and is tested.
- [ ] **Replay:** Often one timeline -- verify as-known and as-happened on late-reported fixtures.
- [ ] **Forecast:** Often a number without basis -- verify evidence list, n, interval, resolvable question, score history, insufficient-basis state.
- [ ] **Webviews:** Often retained and unbounded -- verify retain off, state by ids, budgets, GPU-less fallback, strict CSP.
- [ ] **Leak scan:** Verify a canary string never appears in logs, activity store, exports, settings, webview state, workspace git.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Non-TEE egress discovered | HIGH | Disable the path, rotate any secrets, notify users with the exact data classes sent, add the gate test, review logs of the destination |
| Over-graded claims in published reports | MEDIUM | Re-run independence clustering, apply caps, regenerate reports with as-of notes, record regrade as events |
| Circular corroboration found | MEDIUM | Add `derivedFrom` links and recompute clusters; credibility recomputed by code; flag affected reports |
| Corrupt local store | MEDIUM | Restore from the previous generation or the sync copy; replay from log; quarantine the bad file |
| Lost key, team base | MEDIUM | Enrol a new device key via an existing member; replay from relay or git |
| Lost key, solo base, no recovery export | HIGH | Unrecoverable; restore from the user's own backups only |
| Removed member read post-removal data | HIGH | Complete rotation; identify events written under the old epoch; treat those as disclosed; consider rebase to a new base |
| Rollback or fork detected | MEDIUM | Freeze writes, compare checkpoints among members, choose the longest valid heads, publish a signed resolution event |
| Bad snapshot | LOW-MEDIUM | Discard, rebuild from log, re-sign, add the verification that missed it |
| Compartment leak via derived data | HIGH | Purge the derived artefact, re-key the affected compartment, assess readers, fix the label logic |
| Plaintext artefact committed to git | HIGH | Rotate affected credentials, remove from history (copies may persist), treat contents as disclosed to repo readers |
| Git repo too large | MEDIUM | Rebase to a new base repository from a verified snapshot; migrate to the relay |
| Uncalibrated forecasts shown | LOW-MEDIUM | Hide until scoring exists; publish a correction; add insufficient-basis rule |
| Globe unusable on a host | LOW | 2D fallback; disable WebGL features by setting |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| P-01 Egress bypass | F1; re-verified F2, F5, F8, F9 | Network-spy test across all KB flows; fake non-TEE model rejected |
| P-02 Interest leakage | F1, F2, F5 | Zero third-party requests test; feed polling review; no network geocode code |
| P-03 Stored injection | F2, F3 | Injection corpus through every adapter and retrieval; quote-verification test |
| P-04 Grading, circularity | F1 (schema), F3 | Cap tests; independence on copy-chain fixtures; 36-grade table test; idempotence test |
| P-05 Extraction and dedup | F2 | Labelled merge precision; negation/hedge fixtures; reversible merge test |
| P-06 Plaintext side channels | F1, then every phase | Canary-string scan of all writable locations |
| P-07 Metadata | F1, F7, F8 | Directory listing and size review; padding and naming tests |
| P-08 Concurrency, ordering | F1, F7 | One-writer-per-file check; shuffled-delivery convergence property test |
| P-09 Rollback, fork | F1, F7, F8 | Host-rollback, truncation, equivocation, backup-restore tests |
| P-10 Rotation, key loss | F1, F7, F8 | Removed-member write rejected; SecretStorage-miss test; concurrent rotation test |
| P-11 Erasure, versioning | F1, F7 | Redact path test; unknown-event preservation test; min-version gate |
| P-12 Store corruption, host blocking | F1 | Fault injection; extension-host responsiveness check on large fixture |
| P-13 Log growth, snapshots | F1, F6, F8 | Load-time budget on synthetic fixture; snapshot recompute and verification |
| P-14 Git transport ceiling | F7, F8 | Large-clone test; documented envelope; git-to-relay migration test |
| P-15 Relay | F8 (protocol decisions in F1) | Malicious-relay harness; metadata inventory; offline/outbox test |
| P-16 Compartment leaks | F1 (labels), F3, F4, F8, F9 | Two-compartment indistinguishability test; approver-gated move test |
| P-17 Roles and group keys at scale | F7, F8 | Roster-at-causal-position tests; 500-member rotation benchmark; admin-loss recovery drill |
| P-18 RAFT hairball, slices | F4 | Render budget at fixture size; layout stability test; slice boundary-stub test |
| P-19 Temporal | F1, F2, F6, F9 | As-known vs as-happened fixtures; leakage-safe backtest check |
| P-20 Forecasting | F9 (needs F3, F6) | Evidence-required rendering; Brier tracking; insufficient-basis test |
| P-21 Webview performance | F1 (conventions), F4, F5, F6 | Performance fixtures; GPU-less fallback; CSP unchanged except workers/wasm |
| P-22 Unattended agents, tests | F1, every phase | Between-turn budget test; behaviour tests replace source-regex tests |

**Research flags for the roadmapper (phases likely needing deeper, phase-specific research):**
- F1: event envelope and crypto library selection for the extension host runtime; SecretStorage behaviour on Linux, WSL, containers, code-server; whether a TEE-attested embedding model exists on NEAR AI Cloud; whether to use WASM SQLite at all.
- F5: CesiumJS vs MapLibre globe spike (offline, CSP, bundle size, point counts, no-GPU).
- F7/F8: relay protocol (capability tokens, tree heads), compartment label rules, key-management provider interface (per-member wrapping now, MLS later), identity binding for large organisations.
- F9: forecasting method choice and calibration plan; what "train on TEE" can mean in practice.
- Standard patterns, lower research need: F3 threshold logic, F4 slicing (once label rules exist), F6 replay (once fields exist).

## Sources

Local (HIGH, read directly in this session):
- `.planning/research/v0.5.0-trusted-source-knowledge-base.md` (brief and "Decided when the milestone started", including organisation scale)
- `.planning/PROJECT.md` (Current Milestone v0.5.0)
- `.planning/codebase/CONCERNS.md`
- `src/services/outboundGuard.ts`, `privacyPreflight.ts`, `contextGraphStore.ts`, `activityStore.ts`, `agentActivity.ts`, `workspaceCommands.ts`, `extension.ts`, `chat.ts` (retainContextWhenHidden and persistence behaviour)

External (confidence reflects how it was obtained; none came through the optional research-plan/classify-confidence seam, so tiers are my own assessment):
- OpenStreetMap tile usage policy (fetched): https://operations.osmfoundation.org/policies/tiles/ (HIGH)
- Fowler, Bitemporal History (fetched): https://martinfowler.com/articles/bitemporal-history.html (HIGH for the concept)
- Morris et al., Text Embeddings Reveal (Almost) As Much As Text (fetched abstract): https://arxiv.org/abs/2310.06816 (MEDIUM)
- Admiralty code summaries: https://en.wikipedia.org/wiki/Admiralty_code ; https://pangearesearch.substack.com/p/the-admiralty-code-nato-6x6-system (MEDIUM, search digest)
- LLM verbalised overconfidence: https://arxiv.org/pdf/2410.09724 ; https://arxiv.org/pdf/2604.01457 ; https://arxiv.org/pdf/2509.25532 (MEDIUM, search digest)
- LLM-as-judge injection: https://arxiv.org/pdf/2512.10449 ; https://arxiv.org/abs/2403.17710 (MEDIUM, search digest, self-reported results)
- git-crypt limitations: https://www.agwa.name/projects/git-crypt ; https://sources.debian.org/src/git-crypt/0.8.0-1/README (MEDIUM, search digest)
- Untrusted-storage rollback and fork consistency: https://css.csail.mit.edu/6.566/2023/lec/l22-sundr.txt ; https://eprint.iacr.org/2023/761.pdf ; https://ar5iv.labs.arxiv.org/html/2307.08381 (MEDIUM, search digest)
- Transparency logs, consistency proofs, gossip and witnessing: https://www.rfc-editor.org/rfc/rfc9162.html ; https://ar5iv.arxiv.org/html/1511.01514 (MEDIUM, search digest; RFC body not read)
- MLS: https://rfc-editor.org/rfc/rfc9420 ; inactive-member weakness https://eprint.iacr.org/2023/1903.pdf (MEDIUM, search digest)
- VS Code SecretStorage and Linux keyring behaviour: https://control-plane.io/posts/abusing-vscode-from-malicious-extensions-to-stolen-credentials-part-2/ ; https://github.com/VSCodium/vscodium/issues/1561 ; community reports (MEDIUM-LOW, anecdotal; official docs section not retrieved)
- VS Code webview `retainContextWhenHidden` guidance: https://vscode-api.js.org/interfaces/vscode.WebviewPanelOptions.html (MEDIUM)
- CesiumJS offline and ion defaults: https://cesium.com/learn/cesiumjs-learn/cesiumjs-imagery/ ; https://community.cesium.com/t/cesiumjs-ion-in-an-offline-environment/8738 ; https://community.cesium.com/t/invalid-access-token-when-not-using-ion/7563 (MEDIUM, forum threads, some old)
- MapLibre globe (v5.0.0, January 2025): https://maplibre.org/roadmap/maplibre-gl-js/globe-view (MEDIUM)
- sql.js and encrypted SQLite on WASM: https://sqlite.org/forum/forumpost/20b2639ec5?t=c ; https://github.com/7mind/sqlcipher-wasm ; https://recca0120.github.io/en/2026/03/06/browser-storage-comparison/ (MEDIUM-LOW, anecdotal)
- Graph rendering library positioning: https://medium.com/cylynx/a-comparison-of-javascript-graph-network-visualisation-libraries-ec9914b901e3 ; https://v4.sigmajs.org/concepts/rendering/ (LOW-MEDIUM, vendor claims)
- GitHub repository limits: https://docs.github.com/en/enterprise-server@3.20/repositories/creating-and-managing-repositories/repository-limits (MEDIUM; check the actual host)
- Tile request privacy: https://help.openstreetmap.org/questions/13343/data-privacy-when-using-osm-tile-server (LOW-MEDIUM, community answer)
- Forecasting practice (Tetlock and Gardner, Superforecasting summaries): https://lifeitself.org/blog/notes-on-tetlock-and-gardners-superforecasting ; https://www.econlib.org/archives/2015/10/superforecastin.html (MEDIUM, secondary)
- ICD 203 uncertainty standards: https://irp.fas.org/dni/icd/icd-203.pdf (MEDIUM; probability-band values not verified against the primary text)

Not verified and flagged LOW in the text: Electron/Node SQLite availability in the shipped VS Code engine range; JS signature-verification throughput; Cesium entity-count thresholds; the existence of a TEE-attested embedding model on NEAR AI Cloud; SecretStorage behaviour in remote, WSL, and code-server contexts; the exact JSON.parse error text on the shipped runtime.

---
*Pitfalls research for: trusted-source knowledge base with compartmented encrypted sharing (v0.5.0)*
*Researched: 2026-10-28*

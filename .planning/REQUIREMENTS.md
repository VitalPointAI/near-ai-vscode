# Requirements

## Milestone v0.5.0 requirements: Trusted-source knowledge base

**Defined:** 2026-10-28
**Core value:** Analysts get graded, sourced intelligence that agents keep current, without any of it leaving the TEE, the machine, or the team's control.
**Sources:** `.planning/research/v0.5.0-trusted-source-knowledge-base.md` (owner's brief and decisions) and `.planning/research/SUMMARY.md`.

### Knowledge-base projects and sovereignty

- [ ] **SOV-01**: A user can create a knowledge-base project; the project's mode is recorded so that an agent editing workspace files cannot downgrade it.
- [ ] **SOV-02**: In a knowledge-base project every model call — main agent, sub-agents, attachments, image generation, compaction, embeddings, extraction, grading, and forecasting — goes to a NEAR TEE-attested model or a local runtime; a forwarded model is refused at the model-client boundary with a clear reason, and a test fails if any client method bypasses the gate.
- [ ] **SOV-03**: Web search and fetch are a per-project switch, on by default, and the setting explains that the search provider sees the topics researched.
- [ ] **SOV-04**: Every network destination a knowledge-base project can reach (NEAR, local runtimes, search, feeds, imagery, git remotes, relay) is on a declared allowlist, and a test shows no other request leaves the machine.
- [ ] **SOV-05**: In knowledge-base projects no claim text, entity names, or places are written in plaintext: transcripts and handoffs are encrypted, Agent Activity keeps ids and counts only, and agents record findings in the base rather than in `.planning/` files.
- [ ] **SOV-06**: The legacy generation path either applies the user's privacy mode or is removed, so no model path ignores TEE-only mode.

### Event log and post-quantum cryptography

- [ ] **LOG-01**: Every change to a knowledge base is an attributed, append-only entry in an encrypted log that is never rewritten; current state, history, and replay are derived from it.
- [ ] **LOG-02**: Every entry records when it happened (an interval with precision), when it was reported, when it was graded, and when it was recorded, so a user can view the base as it happened or as it was known at any past time.
- [ ] **LOG-03**: Every entry carries its compartment label and key epoch from the first release, even before multiple compartments are offered.
- [ ] **LOG-04**: Log segments are sealed with AES-256-GCM and signed with hybrid Ed25519 + ML-DSA signatures over each segment (or a hash tree of them); a tampered, reordered, truncated, or forked log is detected and reported.
- [ ] **PQC-01**: Every key wrap uses hybrid ML-KEM-768 + X25519 encapsulation, and every signature (log segments, membership, capability tokens) is a hybrid classical + ML-DSA signature; the extension uses a vetted implementation on Node 22.
- [ ] **PQC-02**: An analyst can erase an item by destroying its key (crypto-shredding); the item becomes unreadable for every member while the log stays verifiable, and the UI says that copies already read are not recalled.
- [ ] **PQC-03**: A user's key is never regenerated silently: if it cannot be read, the base stays locked with a clear message, and a recovery export is created when the user's identity is created.

### Store and search

- [ ] **STORE-01**: A knowledge base with several million entries opens, filters, and slices within budgets measured by a benchmark, using a disk-backed, encrypted, partitioned index; nothing on disk is plaintext.
- [ ] **STORE-02**: Corrupted or undecryptable data is reported and quarantined; the store never silently replaces it with an empty base.
- [ ] **SRCH-01**: A user or agent can search the base by keywords and by meaning; semantic search uses a TEE-attested (e.g. Qwen3-Embedding) or local embedding model, and embeddings are encrypted at rest.

### Intake

- [ ] **INTAKE-01**: During a research run, agents add the sources they read and the claims they extract to the base as proposals, each claim tied to a verified quote in a stored snapshot of its source.
- [ ] **INTAKE-02**: An analyst can add sources and claims by hand and grade or override them.
- [ ] **INTAKE-03**: An analyst can import CSV, STIX 2.1, and GeoJSON with a mapping preview; an import can be retracted as a batch; imported confidence values are hints, never grades.
- [ ] **INTAKE-04**: Stored claims and imported text are treated as untrusted on every read into an agent's context, so instructions inside them cannot steer agents.
- [ ] **INTAKE-05**: Possible duplicate actors, places, and claims are proposed as links for an analyst to accept or undo; nothing is merged silently.

### Grading

- [ ] **GRADE-01**: Every source has a reliability grade (A–F) and every claim a credibility grade (1–6), stored separately and shown as a pair (e.g. "B2"); F and 6 are an "unrated" state, not the worst grade.
- [ ] **GRADE-02**: Agents propose grades and keep revising them as information confirms or contradicts; every change keeps its evidence, reason, author, and time, and an analyst override is recorded the same way.
- [ ] **GRADE-03**: Credibility 1 requires at least two independent origins; copies of one origin count once (echo detection), and agents alone cannot assign A or 1.
- [ ] **GRADE-04**: Reliability can be scoped by topic (a source can be reliable on one subject and not another).
- [ ] **GRADE-05**: An agent's grade change is shown as an evidence diff that an analyst can accept or reject in one action.
- [ ] **GRADE-06**: Contradicting claims are detected and flagged for review.

### Reports and thresholds

- [ ] **RPT-01**: An analyst sets per-project minimum reliability and credibility; a claim is judged by its best independent origin, and below-threshold or unrated claims are excluded or marked unconfirmed per the setting.
- [ ] **RPT-02**: Every claim in a research report shows its grade and sources, rendered from the base rather than written by the model, and a report whose grades do not match the base fails verification.
- [ ] **RPT-03**: When a source is downgraded, the analyst sees which claims, reports, and forecasts change; before changing a threshold, they can preview its effect.
- [ ] **RPT-04**: An analyst can export a report or slice, encrypted by default, carrying its grades, threshold, and compartment label.

### RAFT network and slices

- [ ] **RAFT-01**: An analyst sees Actors, Relationships, Functions, and Tensions (positive, negative, or neutral, with relative strength) as a professional network diagram with a stable layout and the provenance of each edge.
- [ ] **RAFT-04**: The RAFT network is fully interactive and polished to the same standard as the globe: smooth pan, zoom, and drag at the slice cap; hover to highlight an actor's neighbourhood and dim the rest; click to open an actor's functions, relationships, and supporting claims; expand and collapse neighbours, group by role or region, pin and arrange nodes and keep the arrangement; filter by tension, strength, grade, and time with animated transitions rather than jumps; and a visual design (typography, colour, tension encoding, motion) that works in light, dark, and high-contrast themes and respects reduced motion.
- [ ] **RAFT-02**: An analyst can slice the base by geography, time window, topic, or set of actors, save slices, and run agents within a slice.
- [ ] **RAFT-03**: Every diagram and slice has an accessible table view.

### Standing feeds and alerts

- [ ] **FEED-01**: An analyst can subscribe a project to RSS/Atom feeds, MCP sources, and watched folders; new items arrive ungraded in a triage inbox.
- [ ] **FEED-02**: Background work (feed polling, regrading, forecasting) runs within per-run and per-day spending limits checked between turns, and the emergency stop halts it.
- [ ] **ALERT-01**: An analyst can define tripwires (e.g. a tension crosses a level, a named actor appears in a region) and is alerted when new intake matches.

### Geospatial and temporal

- [ ] **GEO-01**: Places are geocoded on the machine from a bundled gazetteer; ambiguous names are shown as candidates, never resolved silently, and place names are never sent to a geocoding service.
- [ ] **GEO-02**: An analyst explores geocoded information on an interactive 3D globe — rotate, zoom, tilt, and pan; hover and click a point or area to see its claims, grades, sources, and times; select to filter, slice, or open it in the network and timeline — with a layer per source or source type that can be turned on and off, reordered, and given an opacity, and a 2D fallback with the same interactions where WebGL is unavailable.
- [ ] **GEO-03**: Online imagery (e.g. NASA GIBS) is on by default and can be turned off per project; the setting says that the imagery host sees which areas are viewed, and a bundled offline basemap is always available.
- [ ] **TIME-01**: An analyst can roll time back and replay how events unfolded on the timeline, network, and globe, in "as it happened" and "as it was known" modes, with views linked so a selection in one highlights the others.

### Prediction

- [ ] **FCST-01**: For a slice, an analyst gets scenario forecasts (mutually exclusive, summing to 100%, with a horizon and resolution criteria) and RAFT tension trends, each with probabilities and the evidence behind them.
- [ ] **FCST-02**: Forecasts are recalibrated as events arrive and scored when they resolve (Brier score, reliability diagram); below a minimum of evidence the forecast says "insufficient basis" instead of a number.
- [ ] **FCST-03**: The analyst chooses per project whether forecasting runs locally or with NEAR TEE models; displayed probabilities always come from the auditable calibration layer, not directly from a model.
- [ ] **FCST-04**: Each forecast can be explained with an ACH matrix (hypotheses against evidence) and an evidence-contribution view, and a calibration dashboard shows forecasting accuracy over time.

### Team sharing (git or shared folder)

- [ ] **SYNC-01**: A team can share a base through a git repository or shared folder it controls; the host sees only ciphertext, and concurrent work by several analysts merges without conflicts.
- [ ] **SYNC-02**: A member invites another by public key, with a fingerprint check; removing a member rotates the keys so they cannot read anything new, and the UI says what they keep.
- [ ] **SYNC-03**: Conflicting grades or edits from different analysts are shown side by side with their authors, not silently resolved.

### Organisation scale

- [ ] **ORG-01**: An organisation can divide a base into need-to-know compartments, each with its own key; a reader without a compartment sees output indistinguishable from a base without it, including grades, search, and forecasts.
- [ ] **ORG-02**: Members have roles (reader, analyst, approver, admin) that every client verifies; agent runs cannot write data into a less restricted compartment than they read from.
- [ ] **ORG-03**: An admin manages compartments, members, and roles in an Access view, sees the effect before granting, and removes a member from many compartments in one rotation.
- [ ] **ORG-04**: Key management stays practical into the hundreds of members per compartment.
- [ ] **ORG-05**: Members load a base from signed snapshots plus later entries, so opening does not replay the whole history.
- [ ] **RELAY-01**: An organisation can run a relay (a container image) that stores and forwards only ciphertext, checks signed append capabilities, and pushes updates to clients; clients re-verify everything, so a malicious relay can only withhold data, and withholding or rollback is detected.
- [ ] **RELAY-02**: A team can move a base from git or a shared folder to a relay without losing history.

## Future (after v0.5.0)

- Evidence-based model defaults evaluated centrally (`v0.6.0-evidence-based-model-defaults.md`).
- MLS group keys (behind the key-management interface) if per-member wrapping stops scaling.
- Directory or SSO binding of member keys to people.

## Out of scope for v0.5.0

| Feature | Reason |
|---------|--------|
| A single blended confidence score | Admiralty reliability and credibility are separate judgements; blending hides which one is weak. |
| Auto-raising reliability from volume or popularity | Repetition is not corroboration. |
| Real-time co-editing | Entries are attributed and append-only; conflicts are shown, not merged live. |
| Person-level targeting aids (e.g. facial recognition, tracking private individuals) | Outside the product's purpose and a misuse risk. |
| Recalling data a removed member already read | Not technically possible; the UI says so instead. |
| Forwarded (non-TEE cloud) models in knowledge-base projects | The base is sensitive; only TEE-attested or local models may see it. |

## Traceability (v0.5.0)

Roadmap created 2026-10-28 (Phases 13-24, see `.planning/ROADMAP.md`). Each requirement maps to exactly one phase.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SOV-01 | Phase 13 | Pending |
| SOV-02 | Phase 13 | Pending |
| SOV-03 | Phase 13 | Pending |
| SOV-04 | Phase 24 | Pending |
| SOV-05 | Phase 13 | Pending |
| SOV-06 | Phase 13 | Pending |
| LOG-01 | Phase 13 | Pending |
| LOG-02 | Phase 13 | Pending |
| LOG-03 | Phase 13 | Pending |
| LOG-04 | Phase 13 | Pending |
| PQC-01 | Phase 13 | Pending |
| PQC-02 | Phase 13 | Pending |
| PQC-03 | Phase 13 | Pending |
| STORE-01 | Phase 14 | Pending |
| STORE-02 | Phase 14 | Pending |
| SRCH-01 | Phase 14 | Pending |
| INTAKE-01 | Phase 15 | Pending |
| INTAKE-02 | Phase 15 | Pending |
| INTAKE-03 | Phase 15 | Pending |
| INTAKE-04 | Phase 15 | Pending |
| INTAKE-05 | Phase 15 | Pending |
| GRADE-01 | Phase 16 | Pending |
| GRADE-02 | Phase 16 | Pending |
| GRADE-03 | Phase 16 | Pending |
| GRADE-04 | Phase 16 | Pending |
| GRADE-05 | Phase 16 | Pending |
| GRADE-06 | Phase 16 | Pending |
| RPT-01 | Phase 16 | Pending |
| RPT-02 | Phase 16 | Pending |
| RPT-03 | Phase 16 | Pending |
| RPT-04 | Phase 16 | Pending |
| RAFT-01 | Phase 17 | Pending |
| RAFT-02 | Phase 17 | Pending |
| RAFT-03 | Phase 17 | Pending |
| RAFT-04 | Phase 17 | Pending |
| FEED-01 | Phase 18 | Pending |
| FEED-02 | Phase 18 | Pending |
| ALERT-01 | Phase 18 | Pending |
| GEO-01 | Phase 15 | Pending |
| GEO-02 | Phase 22 | Pending |
| GEO-03 | Phase 22 | Pending |
| TIME-01 | Phase 22 | Pending |
| FCST-01 | Phase 23 | Pending |
| FCST-02 | Phase 23 | Pending |
| FCST-03 | Phase 23 | Pending |
| FCST-04 | Phase 23 | Pending |
| SYNC-01 | Phase 19 | Pending |
| SYNC-02 | Phase 19 | Pending |
| SYNC-03 | Phase 19 | Pending |
| ORG-01 | Phase 20 | Pending |
| ORG-02 | Phase 20 | Pending |
| ORG-03 | Phase 20 | Pending |
| ORG-04 | Phase 20 | Pending |
| ORG-05 | Phase 20 | Pending |
| RELAY-01 | Phase 21 | Pending |
| RELAY-02 | Phase 21 | Pending |

**Coverage:** 56 requirements, 56 mapped to a phase, 0 unmapped, 0 mapped to more than one phase.

| Phase | Name | Requirements | Count |
|-------|------|--------------|-------|
| 13 | Sovereignty gate, post-quantum cryptography, and the encrypted event log | SOV-01, SOV-02, SOV-03, SOV-05, SOV-06, LOG-01, LOG-02, LOG-03, LOG-04, PQC-01, PQC-02, PQC-03 | 12 |
| 14 | Encrypted scalable store and search | STORE-01, STORE-02, SRCH-01 | 3 |
| 15 | Source and claim intake with agent tools | INTAKE-01, INTAKE-02, INTAKE-03, INTAKE-04, INTAKE-05, GEO-01 | 6 |
| 16 | Admiralty grading, thresholds, and reports | GRADE-01, GRADE-02, GRADE-03, GRADE-04, GRADE-05, GRADE-06, RPT-01, RPT-02, RPT-03, RPT-04 | 10 |
| 17 | RAFT network and slices | RAFT-01, RAFT-02, RAFT-03, RAFT-04 | 4 |
| 18 | Standing feeds, unattended work, and alerts | FEED-01, FEED-02, ALERT-01 | 3 |
| 19 | Team sharing through git or a shared folder | SYNC-01, SYNC-02, SYNC-03 | 3 |
| 20 | Organisation compartments, roles, and access | ORG-01, ORG-02, ORG-03, ORG-04, ORG-05 | 5 |
| 21 | Ciphertext relay | RELAY-01, RELAY-02 | 2 |
| 22 | Globe, imagery, and timeline replay | GEO-02, GEO-03, TIME-01 | 3 |
| 23 | Forecasting and calibration | FCST-01, FCST-02, FCST-03, FCST-04 | 4 |
| 24 | End-to-end hardening and release | SOV-04 | 1 |
| | **Total** | | **56** |

**Where a requirement is owned by one phase but finished across several:**
- SOV-04 (allowlist, and no other request leaves the machine) is owned by Phase 24, because the destinations it names (feeds, imagery, git remotes, relay) do not all exist until then. Phase 13 builds the allowlist and network-spy harness, and each later phase registers its destinations and extends the test.
- RPT-03 (what changes when a source is downgraded) is owned by Phase 16 for claims and reports; Phase 23 adds forecasts to the same preview.
- ORG-01 (a reader without a compartment sees a base without it) is owned by Phase 20; Phases 22 and 23 extend the same indistinguishability test to the globe, timeline, and forecasts.
- PQC-02 (erasure by crypto-shredding) is owned by Phase 13; Phase 19 re-checks that an erased item becomes unreadable on every member's device after sync.


# Earlier milestones

## v1 requirements

- **ONB-01**: A first-run onboarding flow explains privacy, authentication choices, model access, and action approvals.
- **ONB-02**: Users unfamiliar with GSD get a visual guided onboarding flow that explains the workflow, checks prerequisites, configures NEAR AI, confirms safety defaults, initializes the first project, and presents the next recommended action.
- **ONB-03**: The onboarding flow is resumable, accessible, keyboard navigable, and reports each step’s status without requiring users to understand CLI commands.
- **ONB-04**: During first-project/Open-GSD initialization, the extension asks concise project-shaping questions and recommends an appropriate role-based agent team, showing responsibilities, expected coordination/cost tradeoffs, and allowing the user to accept or customize the team before execution.
- **AUTH-01**: Users can configure a NEAR AI API key through VS Code SecretStorage without persisting it in workspace files.
- **AUTH-02**: The architecture supports NEAR account sign-in with short-lived access credentials and secure refresh/revocation behavior.
- **AUTH-03**: Users can assign distinct NEAR AI API keys to individual workspace projects or named organization profiles; key material is isolated in VS Code SecretStorage by project/profile identity, never copied to workspace files, logs, prompts, analytics, or exports, and is never silently reused across projects.
- **AUTH-04**: Users can connect an explicitly authorized NEAR wallet/account for account-bound NEAR AI entitlements without the extension reading, editing, deleting, or importing local NEAR credential files.
- **CHAT-01**: The extension provides a native chat interface with streaming assistant output, cancellation, conversation state, and error recovery.
- **CHAT-02**: The chat explains work in progress with streamed, developer-friendly status updates covering the current phase, tool/action, model, agent, wait state, approval request, retry, and completion/failure outcome.
- **CHAT-03**: The chat supports interactive prompts with structured choices, free-form answers, cancellation, and resumption without losing the surrounding conversation or GSD state.
- **CHAT-04**: Users can inspect and reopen conversation/activity history, including the associated project, phase, plans, agents, models, costs, approvals, and outcomes.
- **CHAT-05**: The chat includes a persistent accessible GSD info line showing project completion percentage, current phase/total phases, current plan/total plans, execution state, active agent count, and available cost/budget context.
- **UX-01**: The chat surface provides a small NEAR-branded animated status indicator for thinking/reasoning, streaming, tool approval, completion, and errors, with a reduced-motion fallback.
- **GSD-01**: Users can discover and invoke Open-GSD commands from chat, including project setup, planning, execution, verification, and progress workflows.
- **GSD-02**: Open-GSD artifacts and state remain inspectable in the workspace, with links from chat to relevant files and phases.
- **GSD-03**: On every extension startup, and at least once every 24 hours during a long-running session, the extension checks the stable `@opengsd/gsd-core@latest` release and compares it with the active installation.
- **GSD-03a**: *(Superseded 2026-10-26.)* Open-GSD is installed only when the user runs a GSD workflow from the extension in a project set up with it and Open-GSD is missing; other workspaces are never touched.
- **GSD-04**: When a newer stable Open-GSD release exists, the extension can install/update the global Open-GSD runtime and synchronize the current project to that version, while reporting progress, failures, and the exact version transition.
- **GSD-05**: The updater is restricted to the official Open-GSD package/channel, preserves user files, supports cancellation/recovery, and never leaves the project in a partially updated state.
- **MODEL-01**: Users can browse the current NEAR AI model catalog and select a default model for chat and coding work.
- **MODEL-02**: Users can configure and discover supported local AI providers/endpoints, including OpenAI-compatible local runtimes, and select local models for chat and agent work.
- **MODEL-03**: Provider selection is explicit per project/session, clearly labels local versus NEAR AI inference, and never silently falls back from local inference to cloud inference.
- **MODEL-04**: Each project has an explicit active provider/organization profile, with a clearly reported key scope and safe switching/validation flow; organization profiles may be reused only when the user explicitly selects them.
- **ROUTE-01**: Users can configure model routing for sub-agents by role/task, with visible routing decisions and safe fallback behavior.
- **ROUTE-02**: The orchestrator maintains explainable, role-specific agent reputation scores from verified outcomes, rework, reliability, latency, cost efficiency, and user feedback; scores decay over time and influence future routing without permanently excluding lower-scoring agents.
- **AGENT-01**: Users can generate, inspect, pause, resume, cancel, and limit sub-agents spawned for an Open-GSD task.
- **AGENT-02**: The UI continuously reports deployed, active, waiting, completed, failed, and cancelled agent counts, with drill-down by role, task, model, route, tokens, cost, duration, and outcome.
- **AGENT-03**: Agent activity has a live event timeline and durable analytics that can be filtered by session, project, phase, model, role, and time range.
- **AGENT-04**: Each sub-agent receives a memorable user-visible identity and reports concise lifecycle updates with optional light humor, while preserving exact role, task, model, route, status, cost, approval, and error information.
- **AGENT-05**: Agent reputation updates are recorded as structured analytics events with enough evidence to explain score changes, support reset/opt-out controls, and prevent self-reinforcing routing loops.
- **AGENT-06**: Agent identities and non-sensitive operating parameters persist locally across sessions so the orchestrator can rehydrate or resurrect an agent when needed, with versioning, reset, export, and deletion controls that do not remove NEAR credentials.
- **AGENT-07**: Accepted agent-team configurations persist with the project and can be reviewed, edited, versioned, and rehydrated by the orchestrator without storing private prompts or credentials.
- **TEAM-01**: Users can manually create, name, edit, duplicate, version, archive, and delete reusable agent teams independently of any one project.
- **TEAM-02**: Team builders can define each member's stable role, responsibilities, skills, tools/capabilities, model/provider route, personality/tone/style guidance, autonomy limits, budget limits, and approval requirements using bounded allowlisted contracts.
- **TEAM-03**: Users can preview a team's members, responsibilities, routing, estimated coordination/cost tradeoffs, privacy boundary, and required capabilities before saving or invoking it; invoking a team requires explicit project binding and preserves the project safety policy.
- **TEAM-04**: Saved teams are versioned, non-sensitive, exportable/importable, and rehydrated safely across sessions/projects without storing API keys, wallet signing material, private prompts, raw context, or unrestricted paths.
- **MULTI-01**: Users can attach multimodal project content through a guided, accessible flow for images, video, audio, documents, and structured data, with file-size/type limits, previews, provenance, and explicit local-versus-cloud handling.
- **MULTI-02**: The orchestrator classifies multimodal inputs, selects compatible model capabilities, tracks derived artifacts and transformations, preserves source-to-output relationships, and reports when a provider cannot process a modality.
- **MULTI-03**: Multimodal context passes the same privacy preflight, local-only policy, redaction, approval, cost attribution, and durable-history rules as text/code context; raw media is never copied into analytics or prompts unless explicitly authorized.
- **GEN-01**: Image and video generation are first-class agent skills with explicit model capability metadata, routing, estimated/actual cost handling, output storage boundaries, provenance, cancellation, and approval before generation or external publication.
- **GEN-02**: Agents cannot claim or invoke image/video generation capability unless the selected provider/model advertises it and the action passes policy, budget, privacy, and approval gates.
- **MEM-01**: Every persistent agent has an isolated, versioned private memory namespace, while each reusable team has a separate collective memory namespace; neither namespace stores credentials, signing material, raw private prompts, or unrestricted workspace content by default.
- **MEM-02**: The orchestrator can derive a bounded task-specific context-graph slice for an agent from private and collective memory using provenance, relevance, confidence, freshness/decay, privacy policy, and project/team scope, and records which non-sensitive facts were supplied.
- **MEM-03**: Context-graph knowledge can grow and be revised through allowlisted facts, relationships, functions/capabilities, actors, source provenance, confidence, conflict/tension state, user feedback, and decay/retraction; contradictory or low-confidence knowledge remains visible rather than silently overwriting prior evidence.
- **MEM-04**: Users can inspect, search, filter, correct, merge, retract, export, and reset permitted memory/graph entries with clear scope labels for agent-private, team-collective, project, and shared knowledge, without exposing secrets or private raw context.
- **MEM-05**: The extension provides an accessible interactive graph view, with nodes for actors/knowledge/functions/artifacts, edges for typed relationships, and visible positive/negative/neutral tension weights plus provenance/confidence and time controls; a table/outline view is available when graph visualization is unsuitable.
- **MEM-06**: Memory retrieval and graph updates are auditable, bounded, cancellation-safe, and local-only compatible; cloud inference never receives more graph context than the explicit privacy/provider policy allows.
- **COST-01**: The UI shows request-level estimates during generation and actual cost/usage when returned or available through NEAR AI reporting APIs.
- **COST-02**: Users can set spend limits, warnings, and an emergency stop for autonomous work.
- **COST-03**: The UI provides live session/project analytics for requests, tokens, estimated and actual cost, latency, model distribution, cache usage when available, and budget remaining.
- **COST-04**: Cost analytics attribute requests, tokens, estimates, actual charges, and budgets to the selected organization profile and project, with filterable summaries and exportable records that contain no API key material or sensitive prompt/context content.
- **COST-05**: The extension can display the authenticated account's current NEAR AI credit balance, entitlement/staking status, validator identity, network, and last refresh time using read-only provider/account data, clearly distinguishing unavailable or stale values.
- **STAKE-01**: Users can initiate NEAR AI entitlement staking to a verified configured validator from the extension through an external wallet authorization flow, with an exact transaction preview, network/validator/amount confirmation, explicit approval, status tracking, and recovery guidance; no transaction is submitted silently.
- **STAKE-02**: Staking and credit actions are isolated from project API-key profiles, require fresh wallet authorization, never expose signing material to the extension webview or model context, and never delete or mutate files under `~/.near-credentials`.
- **STAKE-03**: The extension shows stake/unstake/credit history only from verified bounded account/provider responses, redacts sensitive data, and records non-sensitive audit facts such as account label, network, validator, amount, transaction ID, and outcome without private keys or seed phrases.
- **SAFE-01**: Reads and planning may run automatically, while writes, shell commands, network actions, and git mutations require approval by default.
- **SAFE-02**: Every tool/action request has an understandable preview, scope, approval decision, and audit entry.
- **PRIV-01**: The extension clearly shows the configured inference provider, TEE/verification status when available, and what context is being sent.
- **PRIV-02**: Before context leaves the workspace, the extension performs a privacy preflight that identifies likely secrets, personal/private data, sensitive files, and scope expansion, then shows the user a concise redacted preview and the exact policy decision.
- **PRIV-03**: Privacy policy supports block, warn-and-confirm, and allow modes by data class/path, with local-only exclusions, explicit one-time overrides, and an emergency stop that prevents new outbound requests.
- **PRIV-04**: Privacy decisions and detections are auditable without storing raw sensitive content, and user-facing warnings clearly explain sovereignty impact, provider boundary, and how to keep the data local.
- **PRIV-05**: A local-only sovereignty mode can block all non-local network inference and tool network actions, with an explicit, auditable override required to leave the machine.
- **PKG-01**: The result is buildable and packageable as an installable VSIX with documented local development and installation steps.
- **PKG-02**: Release includes a compelling, accurate VS Code Marketplace listing with value proposition, NEAR AI privacy/TEE explanation, sovereignty controls, GSD onboarding, agent/team behavior, model and cost transparency, screenshots or animated demos, requirements, permissions, privacy details, installation, troubleshooting, and roadmap.
- **TEST-01**: Authentication, routing, cost accounting, approvals, command dispatch, and packaging have automated verification at the appropriate boundaries.
- **SEC-01**: Every security-sensitive GSD plan includes a threat model, least-privilege review, negative-path tests, secret/redaction checks, dependency review, and verification evidence before the plan can be summarized.
- **SEC-02**: The extension never reads, transmits, overwrites, or deletes NEAR credential files; API keys and refresh credentials remain in VS Code SecretStorage and are excluded from logs, prompts, analytics, exports, and crash/error output.
- **SEC-03**: Release includes a trust and security report documenting permissions, outbound data boundaries, dependency provenance, reproducible verification commands, backdoor-oriented review results, known limitations, and remediation status.
- **OBS-01**: All agent/tool/model lifecycle events use a structured event schema suitable for live UI updates, durable local analytics, export, and post-run summaries without storing secrets or raw private prompts by default.
- **UX-02**: Personalized agent presentation is accessible, respectful, reduced-motion compatible, and configurable with a quiet/professional mode that removes humor without removing operational detail.
- **CTX-01**: The extension uses Open-GSD's context-monitor/checkpoint lifecycle when available and verifies that context warnings are enabled for the active runtime.
- **CTX-02**: Continuity warnings fire before context exhaustion at configurable warning/critical thresholds; critical state automatically saves a resumable handoff and prevents starting new complex work until continuity is secured.
- **CTX-03**: After compaction, restart, or a new session, the extension restores the last GSD handoff, active phase/plan, agent ledger, approvals, and pending next action without relying on conversational memory.
- **CTX-04**: Context-monitor failure is non-blocking and visible; the extension falls back to structured checkpoints and session handoffs rather than silently continuing without continuity protection.

## Milestone 2 requirements

- **FIX-01**: Open-GSD installation is detected from installed runtime files, so the installer runs only when Open-GSD is genuinely missing or outdated.
- **FIX-02**: Actual request cost is loaded from NEAR AI's billing API using the `inference-id` response header; estimates appear in every chat surface during and after a response.
- **FIX-03**: Every model shows whether NEAR runs it in an attested TEE or forwards it to another provider, from NEAR's catalog metadata; "TEE verified" appears only when NEAR's attestation or signature endpoints confirm it.
- **FIX-04**: Users can remove a project profile and its stored key.
- **FIX-05**: The sidebar shows GSD artifact links, session history, and next-action buttons after runs.
- **FIX-06**: Options and panels without a working implementation are removed or hidden; nothing ships as a stub.
- **FIX-07**: README, SECURITY.md, and the Marketplace listing describe only verified behavior.
- **FIX-08**: The release check fails if any runtime asset of the sidebar or Tools tab is missing.
- **TEST-02**: Tests for user-facing behavior drive the real host message path or command; tests that only match source text are not accepted as evidence.
- **TEST-03**: Opt-in live tests exercise NEAR AI and a full Open-GSD run end to end; an extension-host UI test suite covers the sidebar, approvals, and commands.
- **HARN-01**: A clean-room agent loop streams model output and tool calls over NEAR's OpenAI-compatible API with parallel tool calls, retries, cancellation, turn limits, and per-turn usage and cost.
- **HARN-02**: Read, Write, Edit, Glob, and Grep tools operate only inside the workspace, with exact-match edits and size-bounded reads.
- **HARN-03**: A Bash tool runs commands in a persistent shell session with timeouts, output limits, background jobs, and cancellation, without shell injection from tool arguments.
- **HARN-04**: A permission engine applies `nearAi.actionPolicy` and user allow/deny rules to every tool call; risky calls show an approval card with a diff or command preview.
- **HARN-05**: Every run can be reverted: files changed by the runner are checkpointed and restorable in one action.
- **HARN-06**: A TodoWrite tool and task list show the runner's plan and progress in the sidebar.
- **HARN-07**: Every tool call, approval, and model turn is recorded as a structured audit and activity event without raw secrets.
- **HARN-08**: The harness contains no copied or bundled proprietary agent-runtime code.
- **HARN-09**: An Agent tool spawns sub-agents from definition files with their own system prompt, tool allowlist, and model tier, in the foreground or background, with concurrency limits.
- **HARN-10**: Context usage is tracked per run; long tool outputs are truncated and earlier context is summarized before the model's window is exceeded.
- **HARN-11**: Session transcripts are stored locally and can be resumed with full context.
- **HARN-12**: WebFetch is available behind approval; the need for WebSearch, Workflow, and MCP tools is assessed against the GSD workflows that reference them.
- **RUN-01**: Open-GSD's Claude runtime is installed into extension-owned storage, never into the user's Claude Code configuration.
- **RUN-02**: Installed GSD skills, commands, agents, and workflows load with frontmatter, `$ARGUMENTS`, and `@` include resolution.
- **RUN-03**: Every installed GSD skill is discoverable in the sidebar and `@nearai` and accepts arguments.
- **RUN-04**: AskUserQuestion from a workflow pauses the run and renders an interactive question; the answer returns to the same run.
- **RUN-05**: `gsd-tools.cjs` runs through the Bash tool with VS Code's bundled Node, with no separate Node install required.
- **RUN-06**: A user can complete `/gsd-new-project`, `/gsd-plan-phase`, and `/gsd-execute-phase` on a sample repository entirely on NEAR AI.

## Out of scope for the first milestone

- Building or hosting proprietary inference models.
- Replacing the Open-GSD workflow or silently rewriting its artifacts.
- Unrestricted autonomous execution without configurable safety controls.
- Organization-wide billing administration beyond the APIs needed for personal/workspace cost visibility.

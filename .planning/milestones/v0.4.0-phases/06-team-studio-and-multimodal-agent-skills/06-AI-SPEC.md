# AI-SPEC — Phase 6: Team studio, scoped memory, and multimodal agent skills

> AI design contract for reusable teams, scoped private/collective context-graph memory, multimodal orchestration, and guarded image/video generation surfaces.
> The implementation remains a host-owned TypeScript extension boundary; this document records the capability and evaluation contract before execution.

---

## 1. System Classification

**System Type:** Hybrid — Multi-Agent, Autonomous Agent, and Content Generation

**Description:**

The extension lets a developer compose a named, versioned team of bounded agent members, give every persistent agent a private memory graph and every team a separate collective memory graph, bind one version explicitly to a workspace project, and route approved work to agents whose role, capabilities, provider, model, privacy boundary, reputation, and authorized context slice satisfy the request. The same host-owned orchestration path accepts local multimodal artifacts, derives typed representations with provenance, and invokes image or video generation only through a provider adapter that has declared the exact capability, cost, cancellation, and publication contract. Good behavior is explainable, privacy-preserving, cost-bounded, restart-safe, conflict-aware, and explicit when a provider or memory scope cannot satisfy a request.

**Critical Failure Modes:**

1. A persisted or imported team member gains a capability, path, prompt, provider, or budget authority outside its bounded allowlist.
2. Raw media, credentials, private paths, or derived sensitive content crosses a provider, prompt, analytics, export, or webview boundary without an explicit policy decision.
3. An agent invokes image/video generation on a model that has not declared the required capability, or bypasses approval, budget, cancellation, or publication controls.
4. Derived artifacts lose source lineage, or estimate/actual usage and attribution are misreported after a route, profile, or provider change.
5. Unknown provider metadata or an unsupported endpoint is treated as supported instead of producing an explicit unavailable/denied result.
6. Private agent memory, collective team memory, project memory, and shared memory leak across scopes, or an agent-authored fact silently becomes an instruction, permission, or user truth.
7. Stale, contradictory, low-confidence, retracted, or decayed graph knowledge is silently overwritten, hidden, or promoted into a task slice without provenance and conflict state.

## 1b. Domain Context

**Industry Vertical:** Developer tooling and privacy-sensitive AI productivity

**User Population:** Developers and small engineering teams using VS Code, Open-GSD, NEAR AI Cloud, or explicitly configured local inference providers.

**Stakes Level:** High

**Output Consequence:** Team and routing decisions can authorize code changes, network transfer, or spend. Generated media can be written to a project or published externally. Incorrect lineage or cost data can mislead review, billing, and privacy decisions.

### What Domain Experts Evaluate Against

| Dimension | Good (expert accepts) | Bad (expert flags) | Stakes | Source |
|---|---|---|---|---|
| Capability honesty | The team preview names the required modality/skill and the selected provider/model proves it from current metadata. | A member claims image/video or media intake because a label was imported or a model name looks familiar. | Critical | NEAR AI model catalog and API reference |
| Privacy boundary | The user sees local/cloud/TEE handling, exact media scope, provenance, and approval before bytes leave the workspace. | A raw attachment is silently embedded in a prompt, analytics row, export, or cloud request. | Critical | Project sovereignty decisions in STATE.md; NEAR AI privacy docs |
| Lineage | Every derived transcript, thumbnail, frame, embedding, or generated asset points to bounded source IDs and transformation metadata. | A generated output cannot be traced to its source artifact, model, route, or approval. | High | Phase 4 activity/audit patterns |
| Operational truth | UI and analytics distinguish unavailable estimates, actual usage, cancellation, failure, and publication outcome. | The system displays a fabricated price, treats a queued job as complete, or hides an unsupported route. | High | Phase 2 usage contract and Phase 5 attribution summary |
| Developer usefulness | Team roles and tone guide collaboration while exact role, route, status, approval, cost, and errors remain authoritative. | Humor or style guidance obscures the operational state or expands member authority. | High | AGENT-04, UX-02, and Phase 4 summaries |
| Memory integrity | Private and collective graph scopes are explicit; facts and typed edges retain provenance, confidence, freshness/decay, tension, and conflict state; users can correct them. | A hidden prompt store, cross-scope merge, silent contradiction overwrite, or unreviewable memory claim changes future work. | Critical | MEM-01 through MEM-06 and Phase 6 AI-SPEC |

### Known Failure Modes in This Domain

- File extension spoofing, MIME confusion, decompression bombs, oversized media, symlink escapes, and workspace-path traversal.
- Prompt injection or hidden instructions inside documents, images, audio transcripts, video frames, structured records, or generated artifacts.
- Provider catalog drift, stale model metadata, unsupported multimodal content parts, and OpenAI-compatible endpoints that do not implement the same non-chat routes.
- Long-running video jobs that outlive the VS Code panel, cannot be cancelled, or leave untracked remote outputs.
- Accidental public publication, output overwrite, or loss of source-to-output provenance.
- Reputation loops caused by routing only to the highest-scoring member while ignoring new but compatible members.
- Cross-scope memory leakage, graph growth without bounds, forged provenance, stale fact promotion, and task slices that contain hidden authority rather than evidence.
- Negative/neutral/positive tension weights being treated as permissions, or retraction/reset operations being bypassed by cached slices or exports.

### Regulatory / Compliance Context

No regulated-industry workflow is assumed. The phase must still preserve privacy, intellectual-property, provider terms, user consent, least privilege, and explicit local-only behavior. Any unsupported retention, jurisdiction, consent, or publication fact is surfaced as unknown and blocks the risky operation.

### Domain Expert Roles for Evaluation

| Role | Responsibility |
|---|---|
| Senior developer-tooling reviewer | Labels task completion, routing explanations, team usability, and operational truth. |
| Privacy/security reviewer | Reviews media boundary, redaction, path containment, provenance, local-only behavior, and negative fixtures. |
| Cost/operations reviewer | Calibrates estimates, actual usage, cancellation accounting, attribution, and budget outcomes. |
| Content/media reviewer | Labels generation approval, output lineage, publication controls, and modality-specific quality/availability. |
| Memory/data-governance reviewer | Labels scope isolation, provenance/conflict handling, graph usability, correction/retraction semantics, and private-context exclusion. |

## 2. Framework Decision

**Selected Framework:** Existing typed TypeScript host orchestration: `AgentOrchestrator` + `PolicyGate` + provider capability adapters

**Version:** Repository TypeScript 5.7 / VS Code extension host; no new AI orchestration dependency

**Rationale:**

The extension already owns durable local state, strict webview parsing, provider authentication, reputation routing, approval previews, budgets, privacy preflight, cancellation, and host-side analytics. A direct typed orchestration seam keeps team contracts and multimodal policy decisions inside the existing trust boundary, avoids duplicating state in a second framework, and works with NEAR AI’s OpenAI-compatible transport while allowing capability-specific adapters where the official provider contract is known. The framework contract is metadata-driven: model names and generic OpenAI compatibility never imply image, audio, video, file, or cancellation support.

**Alternatives Considered:**

| Framework | Ruled Out Because |
|---|---|
| LangGraph | Adds a separate graph/runtime state model to a VS Code host that already has restart-safe orchestration and audit seams; it would not establish provider modality support. |
| CrewAI | Python-only multi-agent runtime conflicts with the TypeScript extension host and would duplicate bounded profiles, approvals, and local ledgers. |
| OpenAI Agents SDK | Provider-native assumptions do not cover the NEAR AI/local provider matrix or the existing Open-GSD process boundary. |

**Vendor Lock-In Accepted:** Partial — provider-specific adapters may use documented NEAR AI or another explicitly configured provider contract, while team, policy, lineage, and analytics contracts remain provider-neutral.

## 3. Framework Quick Reference

No package installation is required. The existing host path is the framework entry point:

```ts
const binding = await teamStudio.invoke({ teamId, version, projectId, privacyMode });
const route = await agentOrchestrator.route({
  role: member.role,
  task: taskSummary,
  requiredCapabilities: member.capabilities,
  provider: member.providerRoute.provider,
  model: member.providerRoute.model,
  privacyBoundary: binding.privacyBoundary
});
const decision = policyGate.preflightOutbound({
  provider: route.candidate.provider,
  providerBoundary: route.candidate.locality === 'local' ? 'local' : 'cloud',
  capability: 'network',
  scope: attachmentScope
});
if (!decision.allowed) throw new Error('Capability or policy contract denied the request.');
```

### Key Abstractions

| Concept | What It Is | When You Use It |
|---|---|---|
| `TeamVersion` | Immutable named composition of bounded member contracts | Save, duplicate, archive, export, import, preview, and bind a team |
| `MemberCapabilityContract` | Allowlisted role, responsibility, skill, tool, route, tone, autonomy, approval, and budget facts | Validate imports and establish least privilege |
| `ModelCapabilitySnapshot` | Normalized provider metadata and freshness state | Prove modality, generation, pricing, context, and cancellation compatibility |
| `AttachmentRecord` | Local content-addressed metadata with type, size, provenance, privacy, and source ID | Intake and policy evaluation without putting bytes in analytics |
| `ArtifactLineage` | Source IDs plus transformation, model, route, usage, approval, and publication facts | Trace derived or generated outputs across reloads |
| `CapabilityAdapter` | Explicit provider operation contract for intake, image, or video work | Use a documented endpoint; return unavailable when absent or stale |
| `ContextGraph` | Scoped facts, actors, functions/capabilities, artifacts, and typed edges with tension/provenance/confidence/freshness/conflict state | Persist private/team memory, derive task slices, and expose safe inspection DTOs |
| `MemorySlice` | Bounded, policy-approved graph projection for one agent/task | Supply only authorized evidence to orchestration and record supplied fact IDs |

### Common Pitfalls

1. Treating `supported_features`, `input_modalities`, or `output_modalities` as trusted without validating shape, freshness, model identity, and pricing fields.
2. Passing a filesystem path or data URL through a generic chat message when the selected provider has no approved media input contract.
3. Reusing chat approval for generation or publication when the target, bytes, model, cost, or output path changed.
4. Counting each lifecycle event as a separate request instead of joining estimate and actual usage by stable request/job ID.
5. Persisting member instructions, raw documents, prompts, media bytes, or provider secrets in team, activity, analytics, or export artifacts.
6. Treating graph memory as a hidden prompt cache, permission ledger, or source of truth instead of bounded evidence with scope and provenance.
7. Applying decay by deleting evidence, or resolving contradictions by choosing the newest/highest-confidence claim without preserving the conflict.

### Recommended Project Structure

```text
src/
├── domain/teamStudio.ts       # bounded reusable team/version/member contracts
├── domain/capabilities.ts     # model/provider modality and skill snapshots
├── domain/multimodal.ts       # attachment, transformation, and lineage contracts
├── domain/generation.ts       # image/video job and publication contracts
├── domain/contextGraph.ts     # scoped memory graph and bounded slice contracts
├── services/teamStudio.ts     # global library, import/export, project binding
├── services/contextGraphMemory.ts
├── services/capabilityRouter.ts
├── services/multimodalIntake.ts
└── services/generationService.ts
```

## 4. Implementation Guidance

**Model Configuration:**

Use the selected member route and current model capability snapshot. Do not invent a default modality or endpoint from a model ID. Preserve provider-reported input/output/image pricing and context limits; if a cost component is absent, return an unavailable estimate and require the applicable policy decision. Generation requests include bounded prompt/style/size/duration parameters only when the adapter schema advertises them.

**Core Pattern:**

Validate imported team/member contracts, resolve a project binding, obtain a fresh capability snapshot, select only compatible candidates, run privacy preflight on attachment metadata and intended bytes, create an exact approval preview, reserve/check budget, invoke one adapter operation, persist allowlisted lifecycle and lineage metadata, and release/settle usage without copying raw media into operational records.

**Tool Use:**

File selection and local staging are host-owned. `PolicyGate`, `PrivacyPreflight`, `ApprovalService`, and `AuditStore` remain the only policy/approval/audit seams. Provider adapters receive a host-created operation object, not arbitrary webview fields, and expose cancellation only when the provider contract supports it. Publication is a separate action with its own target and approval.

**State Management:**

Use bounded atomic ledgers under `.planning/.near-ai` for project bindings, attachments, transformations, jobs, lineage, and operational events. Store reusable teams under VS Code `globalStorageUri` so they are independent of a project. Normalize older records, preserve explicit unknown/unavailable values, and rehydrate queued media jobs as paused/recoverable state requiring fresh policy before resumption.

Private agent graphs and collective team graphs use separate versioned bounded stores and explicit scope keys. Facts, edges, actors, functions/capabilities, and artifact references retain provenance, confidence, freshness, decay, tension, conflict, retraction, and authoring metadata. Graph slices are derived per task with deterministic limits and privacy filtering; cached slices are invalidated by graph version, policy fingerprint, source hash, or retraction/reset. No graph record may contain credentials, signing material, raw private prompts, raw media, unrestricted paths, or executable instructions.

**Context Window Strategy:**

Use metadata and derived text/transcripts by default. Raw media enters a provider request only after explicit authorization, capability proof, privacy preflight, and approval. Bound attachment count, byte size, transformed output count, transcript/frame summaries, and prompt context. Keep source IDs and hashes in lineage; never serialize raw media into prompts, analytics, or exports by default.

Memory context is evidence, not authority: select a bounded task slice from authorized scopes, preserve fact/edge IDs and provenance, and show conflict or stale/decayed state instead of silently resolving it. Local-only mode keeps graph retrieval and mutation local unless an exact policy decision authorizes a provider request.

## 4b. AI Systems Best Practices

### Structured Outputs with Pydantic

Pydantic is not a runtime dependency in this TypeScript extension. The following Python-shaped contract is a cross-language reference for the same strict schema discipline; production validation must use TypeScript allowlists and runtime parsers, not an added Python package.

```python
class CapabilityRequest(BaseModel):
    modality: Literal["text", "image", "video", "audio", "document", "structured"]
    skill: Literal["analyze", "transcribe", "generate_image", "generate_video"]
    model_id: str
    raw_media_authorized: bool = False
    approval_fingerprint: str

    @model_validator(mode="after")
    def require_explicit_media_authorization(self):
        if self.modality != "text" and not self.raw_media_authorized:
            raise ValueError("media bytes require explicit authorization")
        return self
```

The TypeScript equivalent must reject unknown fields, reject unsupported enum values, bound strings/numbers/arrays, and return a structured unavailable/denied result instead of coercing malformed provider data.

### Async-First Design

Provider calls, file staging, polling, and persistence are asynchronous. Every long-running operation accepts an `AbortSignal`; cancellation must stop local work and call a provider cancel operation only when the adapter documents one. Video jobs are modeled as queued/in-progress/completed/failed/cancelled/unknown, and rehydration never silently resumes a remote job.

### Prompt Engineering Discipline

Separate system/team-member guidance from user task text. Member tone/style is bounded presentation guidance, never a permission grant. Attachments are represented by stable source IDs and approved derived text unless the user explicitly authorizes raw media. Do not place credentials, hidden prompts, private paths, or unredacted provider responses in model messages.

### Context Window Management

Use capability metadata and derived artifacts to select only compatible context. Enforce model context limits before dispatch, cap transcript/frame/document expansion, and show an explicit truncation or unavailable state. A derived artifact may be reused only when its source hash, transformation parameters, model, and privacy boundary still match.

### Cost and Latency Budget

Create an estimate from current model pricing and requested dimensions before approval. Keep input/output/image/request pricing distinct, preserve unavailable values, attribute usage to the host-selected organization/profile and project, and reconcile actual usage by request/job ID. Long-running jobs reserve budget before dispatch and release/settle it on terminal status.

## 5. Evaluation Strategy

### Dimensions

| Dimension | Rubric (Pass/Fail or 1-5) | Measurement Approach | Priority |
|---|---|---|---|
| Contract safety | Pass only if imported members contain allowlisted fields and cannot add tools, paths, credentials, or unbounded autonomy. | Code-based parser and negative tests | Critical |
| Capability honesty | Pass only if every modality/skill dispatch is backed by a fresh provider/model capability snapshot; unknown means unavailable. | Code-based route matrix | Critical |
| Privacy and sovereignty | Pass only if local-only blocks non-local bytes, raw media requires explicit authorization, and redacted records contain no media content. | Code-based policy and serialization tests | Critical |
| Lineage completeness | Score 5 when source, transformation, model, route, request/job, usage, approval, and publication facts survive reload; score 1 when any source relationship is lost. | Code-based fixture replay plus human review | High |
| Operational truth | Pass only when estimates, actuals, cancellation, stale metadata, errors, and unavailable values remain distinct. | Code-based lifecycle and analytics tests | High |
| Team usability | Score 5 when a developer can preview, bind, invoke, duplicate, import, export, archive, and recover a team without hidden state. | Human scenario review against 10-20 fixtures | High |
| Generation controls | Pass only when generation and publication require exact capability, privacy, budget, cancellation, and approval checks. | Code-based call-count and tamper tests | Critical |
| Context-graph integrity | Pass only when private/team/project/shared scopes are isolated; typed edges, tension, provenance, confidence, freshness, decay, conflicts, retractions, and bounded slices survive reload. | Code-based graph fixtures, mutation/property tests, and scope-leak negative tests | Critical |
| Memory user control | Score 5 when users can inspect, search, correct, merge, retract, reset, and export safe graph data through graph and table views with keyboard-equivalent controls; score 1 when memory is hidden or irreversible. | Human accessibility review plus protocol/version-conflict tests | High |

### Eval Tooling

**Primary Tool:** Repository-native Node test runner and TypeScript strict compilation; no external eval package is required for this phase.

**Setup:**

```bash
npm run lint
npm test
npm run package
```

**CI/CD Integration:**

```bash
npm run lint && npm test && npm run package
```

### Reference Dataset

**Size:** 30 contract fixtures initially

**Composition:** Four valid team versions; malformed/unknown member fields; each requested modality; local-only and cloud-bound attachments; size/type/provenance failures; unsupported model capabilities; image generation; video queued/cancelled/completed; estimate-only and actual-usage responses; publication approval; reload and profile-switch cases; isolated private/team/project/shared graph scopes; typed edges and positive/negative/neutral tension; provenance/confidence/freshness/decay; contradictory evidence; correction/merge/retraction/reset/export; bounded task slices; stale-version edits; secret/raw-context injection; local-only graph retrieval and cancellation.

**Labeling:** Security/privacy and cost/operations reviewers label the expected disposition. Developer-tooling and media reviewers label usability, lineage, and output-control expectations. Any subjective judge is calibrated against human labels before being used for trend reporting.

## 6. Guardrails

### Online (Real-Time)

| Guardrail | Trigger | Intervention |
|---|---|---|
| Team contract validator | Unknown field, invalid role/capability, unsafe path/tool, credential-shaped value, or unbounded numeric limit | Block import/save and show the exact bounded field error |
| Capability gate | Missing, stale, malformed, or incompatible model/provider metadata | Block route/operation and report unsupported capability |
| Media privacy gate | Local-only violation, sensitive provenance, scope expansion, or raw bytes without authorization | Block outbound bytes; provide local-only or user-review state |
| Approval/budget gate | Generation, network transfer, publication, or budget warning/hard stop | Show exact redacted preview; require approval or deny |
| Cancellation gate | User cancellation, emergency stop, panel disposal, or provider timeout | Abort local work, invoke documented cancellation if supported, persist terminal/unknown state |
| Memory scope gate | A slice, mutation, export, or DTO crosses its declared agent/team/project/shared scope | Block the operation, invalidate the slice, and record a redacted scope-denial event |
| Graph mutation gate | Unknown node/edge type, unbounded value, forged provenance, stale expected version, conflict overwrite, or retracted source | Reject atomically; preserve prior evidence and expose the conflict/reason code |
| Memory privacy gate | Credential-shaped value, raw private context/media, unrestricted path, or local-only violation enters graph or slice | Reject persistence/prompt construction and return a safe field-level denial |

### Offline (Flywheel)

| Metric | Sampling Strategy | Action on Degradation |
|---|---|---|
| Unsupported-capability rate | All denied multimodal/generation requests grouped by provider/model/skill | Refresh adapters/catalog parsing and add a regression fixture |
| Redaction and lineage failures | All negative test fixtures plus sampled persisted records | Block release until the failing boundary is corrected |
| Estimate/actual drift | Completed jobs with provider usage and cost | Reconcile pricing metadata and preserve unavailable status |
| Cancellation/publication escapes | Every cancelled or publication-attempted job | Investigate lifecycle and approval fingerprints before enabling more routes |
| Memory scope leakage | All scope-denial tests plus sampled slice/audit/export records | Block release, invalidate affected caches, and add a regression fixture |
| Conflict/retraction loss | All graph mutation fixtures and rehydration samples | Preserve the evidence trail and stop memory retrieval until the mutation path is corrected |

## 7. Production Monitoring

**Tracing Tool:** Existing bounded `ActivityStore`, `AuditStore`, and `AnalyticsStore`; graph events record scope, IDs, versions, provenance class, policy/approval fingerprints, and outcomes, never raw media, private prompts, or graph content bodies.

**Key Metrics to Track:**

- Capability-compatible route success/denial by modality, skill, provider, and model.
- Attachment intake rejection, local-only block, explicit raw-media authorization, and policy override counts.
- Generation request/job lifecycle, cancellation latency, terminal outcomes, and publication approvals.
- Estimated versus actual cost/usage and budget warnings by immutable organization/profile and project attribution.
- Lineage completeness and rehydration/recovery outcomes for derived and generated artifacts.
- Graph facts/edges by scope, slice size and freshness, conflict/retraction rates, provenance completeness, user corrections/merges/resets, and memory-policy denials.

**Alert Thresholds:**

Alert on any credential/raw-media/raw-private-context serialization test failure, any generation dispatch without a capability snapshot or approval record, any lineage record without a source or operation ID, any cross-scope graph read/write, graph record without provenance or scope, retracted fact returned in a slice, repeated provider metadata parse failures, or cost/usage values that are malformed or silently converted from unavailable to zero.

**Smart Sampling Strategy:**

Sample all denied, cancelled, stale, unsupported, publication, privacy-override, scope-denied, conflict, retraction, and cost-reconciliation cases; sample a bounded percentage of successful multimodal jobs and graph slices by provider/model/scope. Human review never receives raw bytes or private graph content unless the reviewer explicitly requests a local artifact under the same policy boundary.

## Checklist

- [x] System type classified
- [x] Critical failure modes identified (≥ 3)
- [x] Domain context researched (Section 1b: vertical, stakes, expert criteria, failure modes)
- [x] Regulatory/compliance context identified or explicitly noted as none
- [x] Domain expert roles defined for evaluation involvement
- [x] Framework selected with rationale documented
- [x] Alternatives considered and ruled out
- [x] Framework quick reference written (host entry point, abstractions, pitfalls)
- [x] AI systems best practices written (Pydantic reference, async, prompt discipline, context)
- [x] Evaluation dimensions grounded in domain rubric ingredients
- [x] Each eval dimension has a concrete rubric (Good/Bad in domain language)
- [x] Eval tooling selected — repository-native deterministic gates documented
- [x] Reference dataset spec written (size ≥ 10, composition + labeling defined)
- [x] CI/CD verification integration specified
- [x] Online guardrails defined
- [x] Production monitoring configured (bounded tracing + sampling strategy)
- [x] Private and collective context-graph memory contract defined with scope, provenance, conflict, decay, and user controls
- [x] Memory graph evaluation, negative fixtures, accessibility checks, and scope-leak guardrails defined

## Official documentation research

- [NEAR AI API reference introduction](https://docs.near.ai/api-reference/introduction) — documents the API surface and links for model, image, audio, attestation, and usage operations.
- [NEAR AI list available models](https://docs.near.ai/api-reference/chat/list-available-models) — model responses expose `input_modalities`, `output_modalities`, architecture, context, and pricing-related fields.
- [NEAR AI list models with pricing](https://docs.near.ai/api-reference/models/list-models-with-pricing) — model metadata includes architecture modalities, supported features, readiness, and input/output/image/cache pricing fields.
- [NEAR AI model details](https://docs.near.ai/api-reference/models/get-model-details) — documents retrieving one model’s pricing and metadata and explicitly states the endpoint is public.
- [NEAR AI image generation](https://docs.near.ai/api-reference/images/generate-images-from-text-prompt) — documents `POST /v1/images/generations`, request fields, and image result shape.
- [NEAR AI image editing](https://docs.near.ai/api-reference/images/edit-images-from-a-text-prompt-and-image) — documents `POST /v1/images/edits` with multipart input.
- [NEAR AI audio transcription](https://docs.near.ai/api-reference/audio/audio-transcription-endpoint) — documents `POST /v1/audio/transcriptions`, supported formats, response shape, and a 25 MB maximum file size.
- [NEAR AI live model catalog](https://near.ai/models) — currently displays text/image input counts, zero audio/video input counts, and image output pricing; plans must not infer unsupported modalities.
- [OpenAI video generation](https://developers.openai.com/api/docs/guides/video-generation) — documents asynchronous `POST /videos`, status retrieval, content retrieval, and cancellation/lifecycle considerations for a provider adapter; it is not assumed to be a NEAR AI endpoint.
- [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision) — documents image input and image-generation tool behavior, including that images count as input tokens and are billed.

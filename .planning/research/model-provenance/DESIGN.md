# Model provenance, use tiers and Western defaults

**Status:** design, for planning. Docs only: nothing here is built yet.
**Written:** 2026-11-19, against `origin/main` at d17589a1.
**Milestone:** v0.5.0 Governed agent platform (new Phases 74.1 and 74.2), with an amendment to the v0.6.0 model factory (Phases 98 and 99).
**Owner decisions recorded:** 2026-11-19 (section 2), amended 2026-11-20 (gpt-oss-120b added as a third Western family).

## 1. Key points first

1. Every model the extension uses by default today comes from a developer in the People's Republic of China (PRC): GLM for chat and the standard tier, Kimi for the deep tier, Qwen for the fast tier, the safety check and the stalled-reply backup, GLM Flash for images, and DeepSeek and Qwen derivatives for the cyber harness. Nothing in the gate looks at where a model comes from.
2. The owner's risk assessment concludes that the risks that matter most for defence (triggered degradation, sleeper backdoors, propagation through distillation) cannot be tested to zero, and that fine-tuning, quantizing or "decensoring" a model never changes its legal origin. So origin has to be a gate input, not a preference.
3. The design adds a **model passport**: a short signed record of who made a model, where, from what, under which licence, how it is hosted, which exact files run, and the highest **use tier** it may serve. Passports live in your organization's signed policy bundle under an optional `ceiling.models` key. A model with no passport may be used only in the isolated research lane (T0).
4. Each request gets a **use tier** worked out from facts the extension already has (tools granted, unattended or not, the chat's label, the project type, the role). The gate refuses a model whose passport does not cover the tier, before anything is sent, in plain words, and never falls back silently to a forbidden model.
5. PRC-origin models stay usable for research and evaluation in an **isolated T0 lane** (red teaming, threat analysis, the cyber harness), for plain human-reviewed chat (T1) only with a signed, time-boxed risk acceptance by a named senior person, and never for agent work, code, Protected B (T2) or classified and operational work (T3).
6. The extension ships **Western defaults**: NVIDIA Nemotron 3 (Nano, Super, Ultra), Cohere Command A+ and OpenAI gpt-oss-120b as the three Western model families, Whisper for transcription and FLUX for images (both already Western). Defaults move to one place in the code.
7. Today NEAR AI Cloud hosts no Western open-weight model in its private hardware. Two paths are decided: the owner asks NEAR to host Nemotron 3, Command A+ and gpt-oss-120b, and the design adds **your organization's own attested hosting** (`org-tee`) in a Canadian data centre, verified like NEAR's.
8. Checking roles (reviewers, the release guard, the tradecraft reviewer, red team, editor, plan checker, safety classifier) must run on a **different model family** from the model they check.
9. Outputs carry provenance: model, artifact hash and passport hash in staff product headers, ledger entries and run records, plus a per-project **AI bill of materials** (CycloneDX ML-BOM) beside the code SBOM.
10. The model factory changes base: Nemotron 3 Nano first, Super on bigger hardware, gpt-oss-120b as a base of another lineage, Command A+ for serving and as a second lineage. PRC models may be **teachers only**, only in the T0 lane, and never share a base with the student.

## 2. Owner decisions (2026-11-19)

| # | Question | Decision |
|---|---|---|
| 1 | Where Western models are hosted | Both. The owner asks NEAR to host Nemotron 3 and Command A+ in its private hardware (TEE). The design also adds your organization's own sovereign attested hosting: an OpenAI-compatible vLLM or NVIDIA NIM server in a Canadian data centre on confidential-computing hardware, attestation verified like NEAR's, as a new privacy boundary `org-tee`, with hosts named in the signed policy. |
| 2 | PRC-origin models | Allowed at T0. At T1 only with a signed, time-boxed risk acceptance by a named senior person. Never at T2 or T3. |
| 3 | Who sets model rules | Your organization's signed policy. The extension ships Western defaults as the starting point. |
| 4 | Cyber harness | T0 lane only for now. No Western model available today can do that work. |
| 5 | gpt-oss-120b (2026-11-20) | Added to the Western models used as base models: a third Western family beside Nemotron 3 and Command A+, for serving, for checking roles and as a model factory base. The owner's ask to NEAR covers it too. |

## 3. Background

### 3.1 The owner's risk assessment, in brief

The assessment lists ten threat vectors: hosted data flow, artifact tampering, quantization triggers, narrative alignment, triggered degradation, agent hijacking, sleeper backdoors, propagation through distillation, legal and alliance exposure, and strategic dependency.

Its conclusions, as this design uses them:

- **Some risks cannot be tested away.** Backdoors can survive safety training (Hubinger et al., *Sleeper Agents*, 2024). Quantization can switch on hidden behaviour that full-precision tests miss (Egashira et al., *Exploiting LLM Quantization*, 2024). Narrow fine-tuning can shift behaviour broadly (Betley et al., *Nature*, January 2026). A model can write worse code when a prompt names a sensitive group or place (CrowdStrike, DeepSeek-R1 triggered degradation, November 2025).
- **Modification does not launder origin.** Fine-tuning, decensoring, quantizing or crowdsourced optimization lowers visible risk, can raise hidden risk, and never changes legal origin.
- **Distillation into a base you control helps.** Hidden traits can pass from teacher to student through unrelated data, but the transfer failed when teacher and student had different bases (Cloud et al., *Subliminal learning*, 2025). So PRC outputs may teach a Western base, never a PRC one.
- **Legal and alliance exposure is real and moving.** NIST CAISI's evaluations of DeepSeek and Kimi; FY2026 NDAA Sec. 1532 (covered AI from foreign adversaries); the DHS notice on DeepSeek (October 2026); the US Entity List addition of Zhipu (January 2025). On the Canadian side, the Canadian Centre for Cyber Security supply chain integrity (SCI) criteria and ITSP.10.035 to ITSP.10.037 (October 2026), and the Treasury Board Secretariat guide on the use of generative AI.
- **Architectural containment does the most work.** Human review of consequential outputs, no autonomous action, and cross-checking with a model of a different lineage.

### 3.2 Use tiers

| Tier | What it covers | PRC-origin models |
|---|---|---|
| T0 | Research and evaluation: red teaming, threat analysis, model comparison, the cyber harness. Isolated, no production data. | Allowed, and necessary |
| T1 | Unclassified, non-agentic, human-reviewed: plain chat whose answer a person reads before using. | Only with a signed, time-boxed risk acceptance by a named senior person, full mitigations and a specific mission benefit |
| T2 | Agentic, code-generating, or Protected B: anything with tools, unattended runs, writes to files, checking roles. | Never |
| T3 | Classified and operational: decision support, intelligence fusion, planning. | Never |

### 3.3 When a use is acceptable

A use is acceptable only when all six hold: (1) it was tested on the exact deployed artifact; (2) the worst case is bounded and reversible; (3) nothing leaves the enclave; (4) it is legally clean in every jurisdiction that applies; (5) a tested exit plan exists; (6) there is a specific, material mission benefit. Any authorization is time-boxed and reopens on any fine-tune, quantization, update, licence change, or change in US or Canadian law.

### 3.4 Mitigation stack, and where this design puts each layer

| Layer | Where it lives here |
|---|---|
| Provenance and artifact control (pinned hashes, safetensors only, no remote code, AI BOM, accredit the exact artifact) | Passport `artifact` fields (5.2), AI BOM (10.2), factory rules (11) |
| Isolation (deny-by-default egress) | T0 lane (7), Phase 72 backends, `local-only` routing |
| Confidential computing (protects data from the operator and proves the artifact; does not make a model safe) | `nearai-tee` and `org-tee` hosting classes (8.3) |
| Behavioural evaluation (CAISI-style, hijacking, secure code, trigger sweeps with Canadian and defence context) | Passport `evaluation` reference (5.2), factory evaluation (11.4) |
| Runtime guardrails | Existing gate, label routing and safety classifier |
| Architectural containment | Use tiers (6), different-lineage checks (9) |
| Lineage control (PRC as teachers only) | Passport `lineage`, factory rules (11) |
| Governance (re-evaluate after every change, tested exit plan) | Passport expiry and triggers (5.4), Western defaults as the exit (8) |

## 4. What the extension does today

Verified on `origin/main`.

### 4.1 Defaults

| Use | Setting | Default today | Origin | Where it is written |
|---|---|---|---|---|
| Chat | `nearAi.defaultModel` | `z-ai/glm-5.3` | PRC (Zhipu) | `package.json`; `DEFAULT_MODEL` in `src/domain/config.ts` |
| Standard tier | `nearAi.agent.standardModel` | `z-ai/glm-5.3` | PRC | `package.json`; `AGENT_DEFAULTS.tiers` in `src/domain/agentDefaults.ts` |
| Deep tier | `nearAi.agent.deepModel` | `moonshotai/kimi-k3` | PRC (Moonshot) | same |
| Fast tier | `nearAi.agent.fastModel` | `Qwen/Qwen3.6-35B-A3B-FP8` | PRC (Alibaba) | same |
| Safety classifier | `nearAi.agent.safetyModel` | empty, so the fast tier | PRC | `package.json` |
| Stalled-reply backup | `nearAi.agent.backupModel` | empty, so the standard tier, then deep | PRC | `package.json` |
| Vision | `nearAi.agent.visionModel` | `z-ai/glm-5.3-flash` | PRC | `package.json` and again in `readAgentModels` in `src/services/settings.ts` |
| Transcription | `nearAi.agent.transcriptionModel` | `openai/whisper-large-v3` | US | `package.json` and `src/services/settings.ts` |
| Image | `nearAi.agent.imageModel` | `black-forest-labs/FLUX.2-klein-4B` | Germany | `package.json` and `src/services/settings.ts` |
| Cyber harness | engagement choice | the only model whose id contains "abliterated" (`src/domain/cyberModel.ts`); otherwise `z-ai/glm-5.3` hard-coded in `src/services/cyberHandoff.ts` | PRC (NEAR's abliterated models are DeepSeek and Qwen derivatives) | as named |

`src/test/agentDefaults.test.ts` keeps `package.json` and `AGENT_DEFAULTS` in step for the tiers only. The vision, transcription and image fallbacks in `src/services/settings.ts`, `DEFAULT_MODEL` in `src/domain/config.ts` and the cyber fallback are separate copies nothing checks.

### 4.2 NEAR AI Cloud catalogue (GET `/v1/models`, checked 2026-11-19)

- **In private hardware (TEE), NEAR's own or attested third party:** DeepSeek, Kimi, GLM and Qwen models (including Qwen3-Embedding-0.6B, Qwen3-Reranker-0.6B and Qwen3-VL), plus `openai/whisper-large-v3`, `black-forest-labs/FLUX.2-klein-4B` and a privacy filter.
- **Not in private hardware:** Western closed models (Anthropic, OpenAI, Google, xAI).
- **Absent:** Nemotron 3 and Command A+.

So on NEAR today, every private chat, embedding, reranking and vision model is PRC-origin.

### 4.3 What the gate knows about a model

- `ModelInfo` in `src/services/nearAiClient.ts` has `privacyBoundary` (`tee`, `cloud`, `local`, `unknown`), `attestationSupported`, `attestationStatus` and `forwardedTo`. It has no developer, origin, base model or licence.
- `OutboundGuard` (`src/services/outboundGuard.ts`) checks the emergency stop, the daily spend limit, TEE-only mode and the privacy preflight. It is used by `src/services/chat.ts`, `src/services/chatParticipant.ts` and `src/services/teamStudioAi.ts`.
- `checkRoute` in `src/services/nearAiClient.ts` runs on every model request and calls `decideRoute` in `src/domain/gate/routing.ts`: tiers `any-cloud`, `attested-cloud`, `local-only` and `deny`. `decideAttested` accepts only a TEE model on NEAR's own endpoint (`isNearCloudEndpoint`) with a fresh bound connection, or a local model.
- Private team members (`privacy: private` in a member's frontmatter, `src/agent/teams.ts`), the chat label (`src/gate/chatLabel.ts`) and MCP label ceilings add further checks.
- **Nothing filters by origin.**

### 4.4 The signed policy bundle

`src/domain/gate/bundle.ts` defines bundle v1. A fresh install gets a self-signed default bundle (`defaultBundlePayload`). Its `ceiling` has `maxMode`, `contexts`, `unattendedMcp` and the optional `mcpLabelCeilings`, which was added to v1 as an optional key whose absence keeps today's behaviour. That is the precedent for an optional `ceiling.models`. There is no model field today. `routing.localHosts` names non-loopback hosts that count as local; there is no list of attested non-NEAR hosts, so a TEE your organization runs can never satisfy `attested-cloud` today.

### 4.5 Records

- Every model request is recorded (`routeRecordFor` in `src/gate/sessionMark.ts`, built by `src/domain/gate/record.ts`) with the model name and the bundle hash.
- The spend ledger (`src/services/spendLedger.ts`) and activity history keep the model.
- Staff product headers (`ProductHeader` in `src/domain/staff/products.ts`) and staff ledger entries (`LedgerEntry` in `src/domain/staff/ledger.ts`) have no model field.
- The extension has a code SBOM (`sbom.cdx.json`, made by `scripts/extension-sbom.mjs`). There is no AI bill of materials.

### 4.6 Local and on-prem endpoints

Provider kinds `near-ai`, `local` and `hybrid` take any OpenAI-compatible endpoint. A non-loopback host counts as local only when the bundle's `routing.localHosts` names it.

## 5. The model passport

### 5.1 Where it lives

In the signed policy bundle, as an optional `ceiling.models` object. It follows the `mcpLabelCeilings` precedent: an optional key in bundle v1, parsed with strict key checks (`checkKeys` in `src/domain/gate/shape.ts`), where an unknown key, a wrong type or an out-of-range value refuses the whole bundle. The bundle is the ceiling: a person's settings can only narrow inside it.

```json
"ceiling": {
  "models": {
    "v": 1,
    "mode": "enforce",
    "unknownMaxTier": "T0",
    "tierByLevel": { "ca-protected/Protected B": "T2", "ca-classified/Secret": "T3" },
    "passports": [ { "...": "see 5.2" } ],
    "acceptances": [ { "...": "see 5.3" } ],
    "defaults": { "standard": "nvidia/nemotron-3-super", "fast": "nvidia/nemotron-3-nano" }
  }
}
```

| Key | Meaning |
|---|---|
| `v` | Schema version of this object. Only 1 is accepted. |
| `mode` | `enforce` or `report`. In `report` the gate works out every decision, records it and shows the notice, but does not refuse (section 8.5). |
| `unknownMaxTier` | Highest tier for a model with no passport. Only `T0` is accepted in v1; the key exists so the value is visible, not so it can be widened. |
| `tierByLevel` | Optional. Raises the use tier for a `scale/level`, the way `routing.levels` raises the routing tier. It can only raise. Shipped values in 6.1. |
| `passports` | Up to 256 passports. |
| `acceptances` | Up to 64 signed T1 risk acceptances. |
| `defaults` | Optional. Your organization's default model per role (`standard`, `deep`, `fast`, `vision`, `embed`, `rerank`, `safety`, `transcription`, `image`, `backup`, `t0`). Each must name a passport that covers the role's tier. |

### 5.2 Passport fields

```json
{
  "id": "nvidia/nemotron-3-super",
  "match": ["nvidia/NVIDIA-Nemotron-3-Super-*"],
  "developer": "NVIDIA",
  "origin": "US",
  "lineage": {
    "family": "nemotron",
    "base": "Nemotron 3 Super (pretrained from scratch by NVIDIA)",
    "teachers": [ { "model": "DeepSeek V3.2", "origin": "CN", "method": "synthetic-data" } ],
    "method": "pretrain+sft+rl"
  },
  "licence": { "id": "NVIDIA Open Model License", "obligations": ["attribution"], "inherited": ["check NVIDIA dataset licences"] },
  "legal": { "coveredByUsLaw": false, "entityList": false, "removalOrders": [] },
  "hosting": "nearai-tee",
  "artifact": { "format": "safetensors", "sha256": "<64 hex>", "quantization": "none", "remoteCode": false },
  "evaluation": { "report": "<URI or document id>", "sha256": "<64 hex>", "at": "2026-12-01" },
  "maxTier": "T2",
  "issuedAt": "2026-12-01T00:00:00Z",
  "expiresAt": "2027-06-01T00:00:00Z",
  "reevaluateOn": ["artifact-change", "quantization", "fine-tune", "licence-change", "us-law-change", "canada-law-change", "hosting-change"]
}
```

| Field | Rule |
|---|---|
| `id` | Lowercase, `^[a-z0-9][a-z0-9._/-]{0,127}$`. The passport's own name. |
| `match` | One to eight model id patterns, anchored at both ends, `*` the only wildcard, never a bare `*`, matched case-sensitively. A model id matched by two passports takes the **stricter** one (lowest `maxTier`, earliest expiry). Substring matching is forbidden: "Nemotron" in a name proves nothing (see 8.2). |
| `developer` | Who trained the base. Text, 1 to 64 characters. |
| `origin` | ISO 3166-1 alpha-2 of the **base model's** developer. A fine-tune, quantization or abliteration keeps the base's origin. `XX` means unknown and caps `maxTier` at T0. |
| `lineage.family` | A short token (`nemotron`, `command`, `llama`, `granite`, `gpt`, `claude`, `gemini`, `qwen`, `deepseek`, `glm`, `kimi`, ...). The family of the base. Used by the different-lineage rule (9). |
| `lineage.base` | The base model, by name and version. |
| `lineage.teachers` | Models whose outputs trained it, each with origin and method (`synthetic-data`, `distillation`, `preference`). Recorded, not a refusal by itself. |
| `lineage.method` | How this artifact was made from the base (`pretrain`, `sft`, `rl`, `lora`, `qlora`, `merge`, `abliteration`, `quantization`, joined with `+`). |
| `licence` | SPDX id where one exists; `obligations` the duties that reach users; `inherited` licences of training data or parents still to check. |
| `legal` | `coveredByUsLaw` (for example covered AI under FY2026 NDAA Sec. 1532), `entityList` (developer on the US Entity List), `removalOrders` (notices that order removal from some systems, such as the DHS DeepSeek notice). Any `true`, or any removal order, caps `maxTier` at T0 unless your organization's passport says otherwise with a signed acceptance, which v1 accepts only for T1. |
| `hosting` | `nearai-tee`, `org-tee`, `org-plain`, `closed-api` or `local`. Must agree with the request's actual route (8.3). |
| `artifact` | Format (only `safetensors` or `gguf`; never pickle), SHA-256 of the exact weights, quantization, and `remoteCode` (must be `false`). Required for `org-tee`, `org-plain` and `local` at T2 and above. For `nearai-tee` it is checked when NEAR's attestation reports a model hash (question N5). |
| `evaluation` | Reference and hash of your organization's evaluation report for this exact artifact. Required for `maxTier` T3. Optional for T2; without it the passport view and every record say "not evaluated by your organization". |
| `maxTier` | `T0` to `T3`. The highest use tier this model may serve. |
| `issuedAt`, `expiresAt` | Expiry at most 365 days after issue. An expired passport counts as T0. |
| `reevaluateOn` | The triggers that end the passport early (5.4). |

The **passport hash** is the SHA-256 of the passport's canonical bytes (`canonicalBytes`, as `bundleHash` uses). It goes into records (10).

### 5.3 T1 risk acceptance

```json
{
  "id": "ra-2026-014",
  "passport": "z-ai/glm",
  "tier": "T1",
  "scope": { "projects": ["<project id>"], "labels": ["org/Internal"] },
  "benefit": "Plain-language summary of a specific, material mission benefit",
  "mitigations": ["human review of every answer", "no tools", "cross-check by a Western model"],
  "acceptedBy": { "name": "<named senior person>", "role": "<role>", "key": "<fingerprint>" },
  "signature": "<base64url Ed25519 over the canonical acceptance>",
  "issuedAt": "2026-11-20T00:00:00Z",
  "expiresAt": "2027-02-18T00:00:00Z"
}
```

- `tier` must be `T1`. An acceptance can never raise a model to T2 or T3.
- `expiresAt` is at most 90 days after `issuedAt`. Any re-evaluation trigger on the passport also ends it.
- It is signed by the named person's own key (Phase 69's device key now, Phase 71's credential when it lands), and the bundle that carries it is signed by your organization's issuer. Both signatures must verify.
- `scope` names the projects and labels it covers; a request outside the scope is refused as if no acceptance existed.
- A model with `legal.removalOrders` or `entityList: true` can still get a T1 acceptance, but the acceptance view shows those flags in the first line, so the person signs with them in view.

### 5.4 Re-evaluation triggers

A passport ends early, and its model drops to T0 until a new signed passport arrives, when any of these is seen:

| Trigger | How the extension sees it |
|---|---|
| `artifact-change` | The attested model hash (org-tee, or NEAR once N5 is answered) differs from `artifact.sha256`. |
| `quantization`, `fine-tune` | The catalogue or the org-tee host reports a different quantization or adapter. |
| `hosting-change` | The catalogue changes `privacyBoundary` or `forwardedTo` for a matched id. |
| `licence-change` | The catalogue's licence field changes (question N3), or your organization sets it in a new bundle. |
| `us-law-change`, `canada-law-change` | Set by your organization in a new bundle; the extension cannot see law. |

### 5.5 Shipped default passports

The extension ships passports for the current NEAR catalogue and the planned Western models. They are the starting point (decision 3); your organization's bundle replaces them by `id`.

| Family | Match (illustrative) | Origin | Hosting | Shipped `maxTier` | Notes |
|---|---|---|---|---|---|
| DeepSeek | `deepseek-ai/*` | CN | nearai-tee | T0 | Covered AI under FY2026 NDAA Sec. 1532; DHS removal notice; NIST CAISI evaluation |
| Kimi | `moonshotai/*` | CN | nearai-tee | T0 | NIST CAISI evaluation |
| GLM | `z-ai/*`, `zai-org/*` | CN | nearai-tee | T0 | Zhipu on the US Entity List (January 2025) |
| Qwen (chat, VL, embedding, reranker) | `Qwen/*` | CN | nearai-tee | T0 | Includes Qwen3-Embedding and Qwen3-Reranker |
| Abliterated derivatives | the exact NEAR ids | base's origin (CN) | nearai-tee | T0 | `method` includes `abliteration`; T0 lane and cyber only |
| Whisper | `openai/whisper-large-v3` | US | nearai-tee | T2 | MIT |
| FLUX.2 klein | `black-forest-labs/FLUX.2-klein-4B` | DE | nearai-tee | T2 | Licence to confirm |
| Nemotron 3 (Nano, Super, Ultra) | exact ids once hosted | US | nearai-tee or org-tee | T2 | NVIDIA trained from scratch; some post-training synthetic data from DeepSeek V3.2, Kimi K2 and Qwen3-Coder (recorded as teachers); dataset licence inheritance to check |
| Command A+ | exact id once hosted | CA | nearai-tee or org-tee | T2 | Apache 2.0, 218B, May 2026 |
| gpt-oss (120b, 20b) | exact ids once hosted (`openai/gpt-oss-120b`, `openai/gpt-oss-20b` are the upstream names) | US | nearai-tee or org-tee | T2 | OpenAI open-weight, Apache 2.0 plus OpenAI's gpt-oss usage policy (to put on the allowed list); 120b is a mixture of experts (about 117B total, 5.1B active) shipped in MXFP4, which fits one 80 GB GPU; text only; training data not published, so the passport records the developer's model card and safety report as its evidence |
| Closed Western APIs | `anthropic/*`, `openai/gpt-*`, `google/*`, `x-ai/*` | US | closed-api | T2 | Routing still allows them only where the label allows `any-cloud` |
| Llama-Nemotron | `nvidia/Llama-*Nemotron*` | US | as listed | T2 | Family `llama`; DeepSeek-R1 reasoning data recorded as a teacher |
| OpenReasoning-Nemotron | `nvidia/OpenReasoning-Nemotron-*` | **CN** | as listed | T0 | Qwen2.5 base, so PRC origin despite the name |
| NEAR privacy filter | none shipped | XX | nearai-tee | T0 by the unknown rule | Until NEAR states its origin (question N1) |

No shipped passport claims T3, and none carries an `evaluation` reference: T3 needs your organization's own evaluation of the exact artifact and its own signed passport.

## 6. Use tier of a request

### 6.1 How it is worked out

The tier is the **highest** of the rules below that apply. Every input is a local fact the extension already holds at request time. Like the chat's mark, a session's tier only rises.

| Input | Fact the extension already has | Tier it raises to |
|---|---|---|
| T0 lane | The request comes from the research lane (7) | T0, and the lane forbids anything higher |
| Plain chat | No tools in the request, interactive, a person reads the answer | T1 |
| Tools | The request carries any tool definition (read, write, edit, run, web, MCP, sub-agent) | T2 |
| Context | Unattended, sub-agent, relay or routine context (`GATE_CONTEXTS`) | T2 |
| Writing to files | Apply, insert or edit actions on the answer, commit message writing, Team Studio AI (it writes team files that govern agents) | T2 |
| Checking roles | Reviewer, release guard, tradecraft reviewer, red team, editor, plan checker, safety classifier: their verdict gates an action | T2 |
| Label | `tierByLevel`: shipped `ca-protected/Protected B` and `Protected C` and `org/Restricted` to T2; every `ca-classified` level and `nato/NATO Confidential` and above to T3 | as set |
| Project type | A `staff` project: T3 (decision support, intelligence fusion, planning). A staff project whose settings mark it an exercise on fictional data: T2 | as set |
| Cyber | A cyber engagement | T0 lane only (decision 4) |
| Vision, transcription | The tier of the chat that sent the attachment | inherited |
| Embedding, reranking | The tier of the feature that reads the result, at least T1 | inherited, minimum T1 |
| Compare Models | Evaluating models on synthetic tasks is a T0 activity; comparing on project tasks is T2 | T0 lane or T2 |

A plain chat answer at T1 that a person then wants to apply to a file needs a T2 model for the apply step: the Apply button on an answer from a T1-only model is disabled with the reason, and the person copies the text by hand if they choose (the copy carries no marker into the file, which the AI BOM records instead).

### 6.2 Where the gate checks it

One pure function, `decideModelUse(request, passports, acceptances, now)`, in a new `src/domain/gate/models.ts`, returns allow or a refusal with a rule id. It is enforced in one place and previewed in others:

| Place | What it does |
|---|---|
| `checkRoute` in `src/services/nearAiClient.ts` | **Enforces.** Every model request already passes here. The session route carries the use tier beside the mark; the decision is recorded with `routeRecordFor`. Covers chat, agents, sub-agents, the backup model, the safety classifier, vision, transcription, image, embedding, Team Studio AI, Compare Models and the cyber harness, because all of them send through the client. |
| `OutboundGuard.check` | Previews for chat, the chat participant and Team Studio AI, so the refusal shows before the person waits. |
| Model picker and model directory | Show each model's origin, family and highest tier, and grey out models the current session's tier forbids, with the reason on hover. |
| Sub-agent resolution (`src/services/agentOrchestrator.ts`, role models, tier settings) | Picks only models whose passport covers T2; a team member pinned to a forbidden model fails its check with the reason before the run starts. |
| Backup model | Must cover the session's tier and be at least as private (today's rule). Otherwise the reply keeps waiting, as when no backup is set. |
| Safety classifier | Must cover T2 and be a different family from the run's model (9). Otherwise the command asks a person, as today when the classifier is not private. |
| Cyber harness (`src/domain/cyberModel.ts`, `src/services/cyberHandoff.ts`) | Opens only in the T0 lane. The `glm-5.3` fallback is removed; the fallback is the T0 lane default. |

### 6.3 Refusal sentences

Each refusal says nothing was sent, why, and what to do. Tier words in plain language: T0 "research in the isolated workspace", T1 "plain chat a person reviews", T2 "agent work, code or Protected B", T3 "classified or operational work".

| Rule | Sentence |
|---|---|
| `model.tier-exceeded` | Nothing was sent. Your organization's rules allow {model} only for {max tier words}, and this request is {tier words} because {reason}. Choose one of these models instead: {list}. |
| `model.unknown` | Nothing was sent. {model} has no model passport in your organization's rules, so it may be used only for research in the isolated workspace. Choose an approved model, or ask your organization's security officer to add a passport. |
| `model.passport-expired` | Nothing was sent. The approval for {model} ended on {date} ({trigger}). Until it is approved again it may be used only for research in the isolated workspace. |
| `model.acceptance-missing` | Nothing was sent. {model} may be used for plain chat only with a signed risk acceptance from a named senior person, and none covers this project and label. Choose an approved model, or ask for a risk acceptance. |
| `model.acceptance-expired` | Nothing was sent. The risk acceptance for {model}, signed by {name}, ended on {date}. Choose an approved model, or ask {name} to renew it. |
| `model.revoked` | Nothing was sent. Your organization withdrew {model}: {reason}. It cannot be used for anything. |
| `model.artifact-mismatch` | Nothing was sent. The server at {host} proved it is running different model files from the ones your organization approved, so it is not used. Tell your organization's model administrator. |
| `model.hosting-mismatch` | Nothing was sent. {model} is approved only when it runs {approved hosting}, and this route is {actual hosting}. |
| `model.same-lineage` | (Not a send refusal.) This check was not given to {model}, because it comes from the same family ({family}) as the model it checks, and no approved model of another family is available. A person decides instead. |
| `model.lane-only` | This is the isolated research workspace. It cannot open project files, run commands or reach the network. |

No refusal ever retries on a different model by itself. The list of alternatives is filtered by the passport check and by `decideRoute`, so every model offered would pass both.

## 7. The T0 lane

An isolated workspace for adversary-model research. It is where PRC-origin models are used on purpose.

- **Separate surface.** "NEAR AI: Open Research Workspace" opens a chat with a fixed banner: "Research workspace. Adversary models allowed. No project data." It has its own storage folder in the extension's global storage, never in a project.
- **No production data.** No project file reads, no workspace search, no project memory or knowledge graph, no team, no chat history import. A person may attach files only from the lane's own folder; anything they drop in is copied there first and labelled.
- **No write, run or network tools.** No shell, no file writes outside the lane folder, no web, no MCP. A separate "exercise sandbox" exists only for the cyber harness (below).
- **Labelled.** Every lane session carries the T0 tier. Records say `lane: t0`. Text copied out of the lane carries a one-line header ("From the research workspace, model {model}, untrusted").
- **Uses.** Red teaming, threat analysis of adversary models, trigger sweeps, Compare Models evaluations on synthetic tasks, and the cyber harness.
- **Cyber harness.** The one T0 use with tools, because a scan needs them. It is allowed because the tools run only inside the engagement's sandbox against its accepted scope (the engagement scope fingerprint and disclaimer already exist), never on the project or the host. Until the Phase 72 execution backend and the v0.8.0 isolated VM enclave exist, scans keep today's approvals and say they are not VM-isolated. When a Western model can do the work, the harness may move out of the lane by policy.

## 8. Western defaults and the empty state

### 8.1 Defaults per role

The defaults name passports, not raw ids, so the same default works on NEAR and on your organization's hosting.

| Role | Western default | Second choice (other family) | Notes |
|---|---|---|---|
| Standard tier and chat | Nemotron 3 Super | Command A+, then gpt-oss-120b | |
| Deep tier | Nemotron 3 Ultra | Command A+, then gpt-oss-120b | Command A+ first where Ultra is not hosted |
| Fast tier | Nemotron 3 Nano | gpt-oss-20b | Another family at a small size |
| Vision | a Nemotron vision model, if NVIDIA ships one in the Nemotron 3 line | Cohere Command A Vision | Licence check: Command A Vision was released under a non-commercial licence; question N1 |
| Embeddings | a Western embedding model with a passport (NVIDIA's Llama-based retriever models or IBM Granite embedding) | Cohere Embed (private deployment) | Re-embedding the knowledge base is needed when it changes |
| Reranker | NVIDIA's Llama-based reranker or IBM Granite reranker | Cohere Rerank (private deployment) | |
| Safety classifier | a small Western model of a different family from the run's model (for example NVIDIA's Llama-based safety guard, or gpt-oss-20b, when runs use Nemotron) | Nemotron 3 Nano when runs use Command A+ or gpt-oss | Different-lineage rule (9) |
| Backup | the other Western family at the same tier | | Different family keeps a stall from being a shared fault |
| Transcription | `openai/whisper-large-v3` | | Already Western, already in NEAR's TEE |
| Image | `black-forest-labs/FLUX.2-klein-4B` | | Already Western, already in NEAR's TEE |
| T0 lane | your organization's choice; shipped: the NEAR abliterated model for cyber, any PRC model for research | | |

Exact model ids are pinned when NEAR or your organization's hosting publishes them.

### 8.2 Brand names are not lineage

"Nemotron" names several unrelated things. Nemotron 3 is trained from scratch by NVIDIA. Llama-Nemotron is a Llama base with DeepSeek-R1 reasoning data. OpenReasoning-Nemotron is a Qwen2.5 base, so its origin is PRC. Passports therefore match exact, anchored ids, and the resolver never infers origin or family from a name.

### 8.3 Hosting classes

| Class | Meaning | Satisfies `attested-cloud` |
|---|---|---|
| `nearai-tee` | NEAR AI Cloud's private hardware, NEAR's endpoint (today's `tee`) | Yes, as today |
| `org-tee` | Your organization's confidential-computing server, attestation verified, host named in the bundle (Phase 74.2) | Yes, once verified |
| `org-plain` | Your organization's server without attestation | No; counts as local only if `routing.localHosts` names it |
| `closed-api` | A closed model reached through a provider's API, including NEAR-forwarded closed models | No |
| `local` | A runtime on this computer or a named local host | Yes (local is stricter) |

For `org-tee` the bundle gains an optional `routing.attestedHosts` list: host pattern, expected measurements of the serving stack, the accepted hardware roots, and the allowed model artifact hashes. The extension verifies the server's attestation report and binds the TLS connection to it the same way it does for NEAR (D-50 connection binding). If your organization runs the same open-source private inference stack NEAR uses, one verifier (`src/services/attestation.ts`) serves both; NVIDIA NIM on confidential computing would need a second verifier. Attestation proves the code and the weights, not the data centre's location: the Canadian location is a contractual fact your organization records in the hosting entry.

### 8.4 One place for defaults

- `AGENT_DEFAULTS` in `src/domain/agentDefaults.ts` becomes the only source: the tier defaults plus `vision`, `transcription`, `image`, `embed`, `rerank`, `safety`, `backup` and `t0`, each as a passport id with a preference list.
- `DEFAULT_MODEL` in `src/domain/config.ts` is derived from it. The duplicate fallbacks in `readAgentModels` in `src/services/settings.ts` are removed and read from `AGENT_DEFAULTS`. The `glm-5.3` fallback in `src/services/cyberHandoff.ts` is removed.
- Model settings in `package.json` default to empty, meaning "your organization's default for this role, else the shipped one". A value a person already set is kept exactly as set.
- `src/test/agentDefaults.test.ts` widens: every model default in `package.json` matches `AGENT_DEFAULTS`, and no model id literal appears in `src/` outside `agentDefaults.ts`, the shipped passports and tests.

### 8.5 When nothing is allowed

Today, under the Western defaults, a T2 request on NEAR has no allowed private model: every TEE model is PRC-origin, and the closed Western models are not private. This state must be visible, never a silent fallback.

**What the person sees.** A card in place of the reply:

> No model your organization allows can do this. This chat is {tier words} at label {label}. Models allowed for that: none available on {provider}.
> Ways forward:
> 1. Use your organization's own hosting, if it has one. [Set up organization hosting]
> 2. Use a closed Western model. Allowed only because this chat's label is {label}, which may go to any cloud. Your text leaves private hardware. [Use {model}]
> 3. Wait for NEAR AI Cloud to host Western models. [What NEAR has been asked]
> 4. For research on adversary models, open the research workspace. [Open]

Option 2 appears only when the label's routing tier is `any-cloud` and a closed-api passport covers the tier. Choosing it sets the model for this chat only, and the record says the person chose it.

**Transition, so nothing breaks today.** The `mode` key decides:

- A bundle **without** `ceiling.models` keeps today's behaviour (the `mcpLabelCeilings` precedent) and runs the passport check in **report** mode with the shipped passports: decisions are recorded as `would-refuse`, the model picker shows origin and tier, and a one-time card offers "Adopt the Western defaults", which writes `ceiling.models` with `mode: enforce` through Edit Policy (a `policy.edit` record).
- A bundle your organization signs with `ceiling.models` applies exactly what it says, from the first request.
- The shipped default bundle for **new** installs gets `mode: enforce` in the first release after NEAR hosts a Western model for the standard tier (or your organization's hosting exists). Until then new installs get `report`, so the first chat works.

This is the one place the design does not enforce decision 2 at once for people with no organization policy. Section 13 asks the owner to confirm it.

## 9. Different-lineage rule for checking roles

A checker must not share a family with the model it checks, because a backdoor or a triggered fault in one family is likely to be shared by its fine-tunes and distillations.

- **Roles covered:** reviewers in team runs, the staff release guard (`src/domain/staff/releaseGuard.ts`), the J2 tradecraft reviewer, red team, editor, plan checker, and the safety classifier.
- **Family** comes from `lineage.family` in the passport. A model with no passport has no known family and cannot check anything.
- **Choice:** the resolver picks the checker's configured model; if it shares a family with the model that produced the work, it picks the role's second choice; if no allowed model of another family exists for the tier, the check goes to a person (`model.same-lineage`), never to a same-family model.
- **Western families today:** Nemotron, Command A+ and gpt-oss are the three primary Western families, so a checker of another family is available at every tier once they are hosted. Closed Western APIs (where the label allows `any-cloud`) and small Western models of other bases (Llama-based, Granite) can serve as further families once passported.
- **Records:** each check records both families, so an audit can show that no product was checked by its own family.

## 10. Provenance on outputs

### 10.1 Records and headers

| Record | New fields |
|---|---|
| Route decision record (`routeRecordFor`, `src/domain/gate/record.ts`) | `useTier`, `passport` (id and hash), `artifact` (attested hash when known), `hosting`, `lane`, and for `report` mode `wouldRefuse` with the rule. The record already has the model and bundle hash. |
| Staff product header (`src/domain/staff/products.ts`) | `model`, `model_artifact`, `passport` as optional keys after `tradecraft` in `PRODUCT_HEADER_KEYS`; required for states past `guard-checked` once Phase 74.1 is on. |
| Staff ledger entry (`src/domain/staff/ledger.ts`) | Optional `model`, `artifactHash`, `passportHash` on propose and revise events, under a new `LEDGER_ENTRY_VERSION`. |
| Spend ledger and activity | Already keep the model; add the passport hash. |
| Decision log | Already has model and bundle hash through the route record. |

### 10.2 Per-project AI bill of materials

- A CycloneDX ML-BOM per project, written to the project's NEAR AI state folder beside where an SBOM would sit, and regenerable from the decision log.
- One `machine-learning-model` component per model used: supplier (developer), origin, licence, hashes (artifact), `pedigree.ancestors` for the base and teachers, the passport hash, hosting class, the tiers it served, and first and last use.
- Generated by "NEAR AI: Export AI Bill of Materials", and attached to a staff product release.
- The extension's own `sbom.cdx.json` is unchanged; the AI BOM covers models, which the code SBOM does not.

## 11. Model factory amendment

This amends `.planning/research/data-platform/04-model-factory-and-opportunity-agent.md` (decision D3 and sections 4, 5, 6, 8) and the v0.6.0 Phases 98 and 99. The amendment note sits at the top of that file.

### 11.1 Bases

| Use | Base | Why |
|---|---|---|
| First specialist base | Nemotron 3 Nano | Western origin, trained from scratch, data mostly published; fits the 128 GB Strix Halo and the GB10 for LoRA and QLoRA (to measure in Phase 85) |
| Larger specialists | Nemotron 3 Super | On larger hardware than one Strix Halo or GB10 |
| Serving and second lineage | Command A+ | Canadian, Apache 2.0; the other family for checking roles and cross-checks |
| Base of another lineage | gpt-oss-120b (gpt-oss-20b for small specialists) | US, Apache 2.0, a mixture of experts with about 5.1B active parameters, so training and serving cost like a much smaller dense model; LoRA on the MXFP4 weights to measure on the Strix Halo and the GB10 in Phase 85; gives a specialist whose checker can be Nemotron or Command A+ |

Qwen, Gemma and Phi stop being default bases. Qwen is PRC-origin, so any specialist trained on it is PRC-origin and T0 only. Gemma and Phi may be added later with passports of their own.

### 11.2 Teachers

- PRC models may act as **teachers only**, and only from the T0 lane: their outputs become synthetic training data, never weights.
- A teacher must **never share a base** with the student (Cloud et al.), so a PRC teacher never teaches a PRC-based student, and a Nemotron teacher never teaches a Nemotron student without saying so in the lineage.
- Teacher outputs pass a **filtering pipeline** before use: deduplicate; drop anything with tool calls, code that reaches the network, encoded or hidden text, or unusual tokens; run trigger probes on the teacher prompts; score by a Western model of another family; keep the filter version and the counts in the dataset manifest.
- Teacher calls follow the label's routing and never carry your organization's data above T0 (T0 lane rule).

### 11.3 Licences

The job spec refuses to start when a base, a dataset or a teacher's terms are not on your organization's allowed list. It records inherited licences (NVIDIA dataset terms for Nemotron, Apache 2.0 for Command A+, Apache 2.0 and OpenAI's gpt-oss usage policy for gpt-oss), and the specialist's passport carries the result.

### 11.4 Evaluation additions

Before any promotion, on the exact artifact that will be served (quantized if it will be served quantized):

- agent hijacking (prompt injection that tries to act);
- secure code (the specialist's code against a secure-coding suite);
- trigger sweeps with Canadian and defence context: unit names, bases, the Arctic, Indigenous communities, allied nations' names, and the same prompts without them; a gap is a finding;
- a **differential against the base**: the same suite on the base and on the specialist, so a regression the fine-tune introduced is visible;
- CAISI-style capability and refusal checks.

### 11.5 Accreditation and promotion

- Each served artifact gets its own passport: hash, quantization, adapter hash, base, teachers, evaluation report.
- **Promotion is a signed person decision** with an expiry and the re-evaluation triggers of 5.4. The opportunity agent only proposes; auto-promotion (D9 in the 04 document) is removed for anything above T0.
- A retrain after an erasure request is a new artifact and needs a new passport.

### 11.6 Crowdsourced optimization

Allowed only on a Western base, only on artifacts whose result is re-hashed and re-evaluated, and only with security scoring (the 11.4 suite) as part of the score, never accuracy alone.

## 12. State machines

### 12.1 Model passport lifecycle

States: `unknown`, `evaluated`, `approved` (for a tier), `risk-accepted` (T1, PRC), `expired`, `revoked`.

| From | Event | To | Effect |
|---|---|---|---|
| (none) | A model id appears in a catalogue with no matching passport | unknown | Usable at T0 only |
| unknown | Your organization records an evaluation report in a signed bundle, no `maxTier` above T0 | evaluated | Still T0 |
| unknown, evaluated | Signed bundle with a passport and `maxTier` | approved | Usable up to `maxTier` |
| approved (T0, PRC) | Signed bundle with a valid T1 acceptance in scope | risk-accepted | T1 within scope |
| risk-accepted | Acceptance expires, is removed, or a trigger fires | approved (T0) or expired | Back to T0 |
| approved | `expiresAt` passes | expired | T0 only |
| approved, risk-accepted | A re-evaluation trigger (5.4) is seen | expired (reason: trigger) | T0 only; recorded once |
| expired | New signed passport | approved | Usable up to the new `maxTier` |
| any | Your organization revokes (passport removed with a revocation entry, or a `removalOrders` entry that says "all uses") | revoked | Not usable at any tier, including T0 |
| revoked | New signed passport | approved | Only by a new bundle |
| any | Bundle fails to verify or expires | (bundle fail-closed) | Today's fail-closed routing applies; every passport counts as T0 |

No state waits forever: every non-terminal state ends by a clock (expiry) or by a new bundle. `revoked` ends only by a new bundle.

### 12.2 Request gate decision

States: `received`, `tier-derived`, `passport-resolved`, `checked`, `allowed`, `refused`, `sent`, `recorded`.

| From | Event | To |
|---|---|---|
| received | Use tier worked out (6.1) | tier-derived |
| received | Tier cannot be worked out | refused with the existing "could not be worked out" sentence (`routeCheckFailed`), never guessed |
| tier-derived | Passport found, or unknown rule applied | passport-resolved |
| passport-resolved | Passport status check (12.1) | checked, or refused (`model.passport-expired`, `model.revoked`, `model.unknown`) |
| checked | Tier within `maxTier`, or T1 within a valid acceptance | next check |
| checked | Tier above | refused (`model.tier-exceeded`, `model.acceptance-missing`, `model.acceptance-expired`) |
| next check | Hosting agrees and, where known, the artifact hash matches | next check |
| next check | Hosting or artifact differs | refused (`model.hosting-mismatch`, `model.artifact-mismatch`) |
| next check | Checking role: families differ | next check |
| next check | Checking role: same family, no alternative | refused to the person (`model.same-lineage`) |
| next check | `decideRoute` allows, `OutboundGuard` allows | allowed |
| next check | Either refuses | refused (their existing rules) |
| allowed | Sent | sent, then recorded |
| refused | Shown with alternatives | recorded; no retry on another model |
| any, in `report` mode | A model rule would refuse | allowed, recorded with `wouldRefuse` |

## 13. Questions and open items

### 13.1 Questions for NEAR

| # | Question |
|---|---|
| N1 | Will you host Nemotron 3 (Nano, Super, Ultra) in your TEE, and a Nemotron vision model if NVIDIA ships one? Can you state the origin of the privacy filter model? |
| N2 | Will you host Cohere Command A+ in your TEE? |
| N2a | Will you host OpenAI gpt-oss-120b (and gpt-oss-20b) in your TEE? |
| N3 | Can `/v1/models` carry provenance fields: developer, origin, base model, licence, artifact hash, quantization? |
| N4 | Will you give notice before a model's weights, quantization, hosting or id change, and a stable id per artifact? |
| N5 | Can the attestation report name the hash of the model weights loaded, so a passport can bind to it? |
| N6 | Where are the TEE servers located? Is a Canadian region possible? |
| N7 | Western embedding and reranking models in the TEE (NVIDIA or IBM Granite)? |
| N8 | How do model licences pass through to customers (Nemotron's NVIDIA licence, inherited dataset terms, FLUX)? |

### 13.2 Owner confirmations

| # | Item | Recommendation | Decision |
|---|---|---|---|
| O1 | `report` mode for installs with no organization policy until a Western private model exists (8.5) | Accept: it keeps today's chats working and makes the gap visible | Accepted (owner, 2026-11-19) |
| O2 | Staff projects at T3, and T2 when marked an exercise on fictional data (6.1) | Accept | Accepted (owner, 2026-11-19) |
| O3 | Maximum risk acceptance length of 90 days | Accept | Accepted (owner, 2026-11-19) |
| O4 | Who may sign a T1 acceptance before Phase 71's credentials (a device-key signature with the self-declared notice, as for staff approvals) | Accept | Accepted (owner, 2026-11-19) |
| O5 | Shipped Western passports at T2, never T3 | Accept | Accepted (owner, 2026-11-19) |

### 13.3 Risks

| Risk | Handling |
|---|---|
| No Western private model on NEAR for months | `report` mode, the empty-state card, organization hosting |
| Western models are weaker on some tasks than the PRC defaults | Compare Models evaluations (in the T0 lane for PRC candidates); the role table lets your organization pick per role |
| Nemotron 3 contains synthetic data from PRC teachers | Recorded as teachers; different base; trigger sweeps still run |
| Name confusion across "Nemotron" brands | Exact, anchored passports; no name inference |
| A passport is wrong (origin or licence) | Signed, reviewable, revocable; expiry forces review |
| Org hosting attestation differs from NEAR's format | Prefer the same open-source stack; else a second verifier |
| Location of a data centre cannot be attested | Recorded as a contractual fact |
| A person copies T1 text into code by hand | Not preventable; the AI BOM and records show which model wrote it |
| Embedding change forces a knowledge base rebuild | Planned rebuild with both indexes kept until the new one is checked |
| Policy authors raise `maxTier` carelessly | `evaluation` required for T3 and shown as missing at T2; T1 for PRC only by acceptance; acceptances cannot reach T2 |

## 14. Work packages

WP-0 lands first because every other package imports its schema; everything after it runs in parallel worktrees from the same base, then one integration. One line on the dependency: WP-0 is the shared contract (passport schema, tier enum, tier derivation), so it cannot run beside its consumers.

| WP | Scope | Worktree | Depends on | Tests |
|---|---|---|---|---|
| WP-0 Contract | `ceiling.models` parser in `bundle.ts` (optional key, strict keys, limits), passport and acceptance types, use tier enum, pure `useTierFor` (6.1), shipped passports (5.5), passport hash | `feat/model-passport-contract` | None | Bundle without the key parses as before; unknown key, bare `*` match, `remoteCode: true`, pickle format, `maxTier` T3 without `evaluation`, acceptance above T1, acceptance over 90 days and expiry over 365 days are each refused; overlapping matches take the stricter; tier table cases for every input row; tier only rises in a session |
| WP-GATE | `decideModelUse` in `src/domain/gate/models.ts`; called in `checkRoute`; preview in `OutboundGuard`; new rule ids and sentences; `report` mode; record fields | `feat/model-gate` | WP-0 | Every row of 12.2 including each refusal; report mode records `wouldRefuse` and allows; no request reaches the network on refusal (recorded); backup and safety classifier refused or sent to a person, never to a forbidden model |
| WP-DEFAULTS | One place for defaults (8.4); empty settings mean "policy default"; resolver by passport; remove duplicates in `settings.ts`, `config.ts`, `cyberHandoff.ts` | `feat/model-defaults` | WP-0 | Widened `agentDefaults.test.ts`; no model id literal outside the allowed files; a person's set value is kept; resolver never returns a forbidden model |
| WP-LANE | Research workspace (7): surface, storage, tool set, labels, copy-out header; Compare Models and cyber harness move into it | `feat/t0-lane` | WP-0, WP-GATE | Lane cannot read project files, run commands, reach the network or call MCP; cyber opens only in the lane; copied text carries the header |
| WP-LINEAGE | Different-lineage rule for checking roles (9) | `feat/lineage-checks` | WP-0, WP-GATE | Same-family checker swapped for the second choice; none available goes to a person; staff release guard and tradecraft reviewer records show both families |
| WP-ACCEPT | Risk acceptance command: draft, sign with the named person's key, add to the policy; expiry view; renew | `feat/risk-acceptance` | WP-0 | Signature over canonical bytes verifies; tampered scope fails; expiry and trigger end it; legal flags shown first |
| WP-UX | Origin, family and tier in the model picker and directory; empty-state card (8.5); adopt-defaults card; passport view | `feat/model-provenance-ux` | WP-GATE, WP-DEFAULTS | Each empty-state option appears only when its condition holds; closed-api option only at `any-cloud`; adopt writes a `policy.edit` record |
| WP-PROV | Record fields, product header keys, staff ledger version, AI BOM export (10) | `feat/model-provenance-records` | WP-0, WP-GATE | Header round trip with and without the new keys; old ledgers still replay; AI BOM validates against CycloneDX 1.6 ML-BOM schema and lists base and teachers |
| WP-ORGTEE (Phase 74.2) | `org-tee` boundary, `routing.attestedHosts`, verifier for the chosen stack, connection binding, artifact hash check | `feat/org-tee` | WP-0, WP-GATE | Non-listed host never counts as attested; wrong measurement, wrong model hash or unbound TLS refused; listed and verified host satisfies `attested-cloud` |
| WP-FACTORY (v0.6.0) | Phase 98 and 99 requirement changes (11) | in those phases | Phase 74.1 | Job refused with a PRC base above T0, a teacher sharing the student's base, or a blocked licence; promotion needs a signature; differential evaluation report present |
| Integration | Merge WP-0, WP-GATE, WP-DEFAULTS, then WP-LINEAGE, WP-ACCEPT, WP-PROV, WP-LANE, WP-UX; SECURITY.md and README text; one full verification run | `feat/model-provenance-integration` | All of Phase 74.1 | Full suite once; scripted run: PRC model refused for an agent run with the sentence, Western closed model offered at a Public label only, T0 lane red-team session, staff product header with passport |

### 14.1 Where it lands

- **Phase 74.1** (v0.5.0): WP-0 to WP-PROV and the integration. It depends only on Phase 70 (gate, bundle, labels) and Phase 69 (signer), so it can run beside Phases 71 to 74 and ship in a 0.4.x feature release as it lands, like other Stage 1 work. Phase 71 later swaps the acceptance signer for a credential.
- **Phase 74.2** (v0.5.0): WP-ORGTEE. It needs your organization's hosting to exist for its end-to-end check; the code and tests do not.
- **v0.6.0**: WP-FACTORY changes Phases 98 and 99.
- **v0.8.0**: the cyber harness keeps its T0 lane until a Western model can do the work.

## 15. Sources

Public sources, cited by title: NIST CAISI evaluations of DeepSeek and of Kimi; FY2026 National Defense Authorization Act, Sec. 1532; DHS notice on DeepSeek (October 2026); US Entity List addition of Zhipu AI (January 2025); Hubinger et al., *Sleeper Agents: Training Deceptive LLMs that Persist Through Safety Training* (2024); Cloud et al., *Subliminal learning* (2025); Egashira et al., *Exploiting LLM Quantization* (2024); Betley et al., *Nature* (January 2026); CrowdStrike, DeepSeek-R1 triggered degradation (November 2025); Canadian Centre for Cyber Security, supply chain integrity (SCI) criteria and ITSP.10.035 to ITSP.10.037 (October 2026); Treasury Board of Canada Secretariat, guide on the use of generative AI; CycloneDX 1.6 ML-BOM specification. Repository files are cited inline from `origin/main`.

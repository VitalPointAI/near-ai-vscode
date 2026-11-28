# Model provenance, use tiers and Western defaults

**Status:** design, for planning. Docs only: nothing here is built yet.
**Written:** 2026-11-19, against `origin/main` at d17589a1.
**Milestone:** v0.5.0 Governed agent platform (new Phases 74.1 and 74.2), with an amendment to the v0.6.0 model factory (Phases 98 and 99).
**Owner decisions recorded:** 2026-11-19 (section 2), amended 2026-11-20 (gpt-oss-120b added as a third Western family).
**Conforms to the coherence review (2026-11-20):** `ceiling.models` is now the v2 `models` section with `requires: models@1`, its schema built in Phase 41; T1 risk acceptances are `authorizations[kind=t1-risk]` records with the named person's inner signature ("self-signed on this computer" until your organization's layer exists); the passport check is one step of the one decision function `decideRoute`; hosting classes are `endpoints[]` classes and reach people only as the "Runs on" part of the one trust line; "Adopt the Western defaults" and the risk-acceptance flow write proposals into the one policy editor; bare "private" is retired from the picker, the README tagline and the staff templates; screens use the glossary's words (uses, not tiers; "Models by job"; "Approved for {use} until {date}" and "Allowed by {name} until {date}"; "Research workspace"); staff records ride the replica layer; org-tee hosting is a `ModelEndpoint` adapter with the shared verifier interface. Superseded text is kept with dated notes. See `.planning/research/coherence/REVIEW.md` (section 10) and its companion files.

> **Words (2026-11-20, coherence review):** in this design "use tier" and T0 to T3 are internal names. People never see "tier" or "passport": they see use words ("research only", "chat you review", "agent work", "operational work"), "Approved for {use words} until {date}" for a passport, "Allowed by {name} until {date}" for a risk acceptance, and "Models by job" (Fast, Standard, Deep model) for what this design calls the fast, standard and deep tiers (`GLOSSARY.md`, section 1).

## 1. Key points first

1. Every model the extension uses by default today comes from a developer in the People's Republic of China (PRC): GLM for chat and the standard tier, Kimi for the deep tier, Qwen for the fast tier, the safety check and the stalled-reply backup, GLM Flash for images, and DeepSeek and Qwen derivatives for the cyber harness. Nothing in the gate looks at where a model comes from.
2. The owner's risk assessment concludes that the risks that matter most for defence (triggered degradation, sleeper backdoors, propagation through distillation) cannot be tested to zero, and that fine-tuning, quantizing or "decensoring" a model never changes its legal origin. So origin has to be a gate input, not a preference.
3. The design adds a **model passport**: a short signed record of who made a model, where, from what, under which licence, how it is hosted, which exact files run, and the highest **use tier** it may serve. Passports live in your organization's signed policy, in the `models` section of policy bundle v2 (named in `requires` as `models@1`; first drafted as an optional v1 key `ceiling.models`, superseded 2026-11-20). People see a passport as "Approved for {use words} until {date}". A model with no passport may be used only in the isolated research workspace (T0).
4. Each request gets a **use tier** worked out from facts the extension already has (tools granted, unattended or not, the chat's label, the project type, the agent's job). The passport check is one step of the one decision function, `decideRoute`, so the gate refuses a model whose passport does not cover the use, before anything is sent, in plain words, and never falls back silently to a forbidden model.
5. PRC-origin models stay usable for research and evaluation in an **isolated research workspace** (the T0 lane: red teaming, threat analysis, the cyber harness), for chat a person reviews (T1) only with a signed, time-boxed exception allowed by a named senior person (an `authorizations[]` record of kind `t1-risk`), and never for agent work, code, Protected B (T2) or classified and operational work (T3).
6. The extension ships **Western defaults**: NVIDIA Nemotron 3 (Nano, Super, Ultra), Cohere Command A+ and OpenAI gpt-oss-120b as the three Western model families, Whisper for transcription and FLUX for images (both already Western). Defaults move to one place in the code.
7. Today NEAR AI Cloud hosts no Western open-weight model in its private hardware. Two paths are decided: the owner asks NEAR to host Nemotron 3, Command A+ and gpt-oss-120b, and the design adds **your organization's own attested hosting** (an `endpoints[]` entry of class `org-tee`) in a Canadian data centre, verified like NEAR's through the one verifier interface.
8. Checking roles (reviewers, the release guard, the tradecraft reviewer, red team, editor, plan checker, safety classifier) must run on a **different model family** from the model they check.
9. Outputs carry provenance: model, artifact hash and passport hash in staff product headers, staff replica entries and the local audit record, shown to people through the trust line, plus a per-project **AI bill of materials** (CycloneDX ML-BOM) beside the code SBOM.
10. The model factory changes base: Nemotron 3 Nano first, Super on bigger hardware, gpt-oss-120b as a base of another lineage, Command A+ for serving and as a second lineage. PRC models may be **teachers only**, only in the T0 lane, and never share a base with the student.

## 2. Owner decisions (2026-11-19)

| # | Question | Decision |
|---|---|---|
| 1 | Where Western models are hosted | Both. The owner asks NEAR to host Nemotron 3 and Command A+ in its private hardware (TEE). The design also adds your organization's own sovereign attested hosting: an OpenAI-compatible vLLM or NVIDIA NIM server in a Canadian data centre on confidential-computing hardware, attestation verified like NEAR's, as a new privacy boundary `org-tee`, with hosts named in the signed policy. |
| 2 | PRC-origin models | Allowed at T0. At T1 only with a signed, time-boxed risk acceptance by a named senior person. Never at T2 or T3. |
| 3 | Who sets model rules | Your organization's signed policy. The extension ships Western defaults as the starting point. |
| 4 | Cyber harness | T0 lane only for now. No Western model available today can do that work. |
| 5 | gpt-oss-120b (2026-11-20) | Added to the Western models used as base models: a third Western family beside Nemotron 3 and Command A+, for serving, for checking roles and as a model factory base. The owner's ask to NEAR covers it too. |

> **Coherence review (2026-11-20):** the decisions above stand. In decision 1, "a new privacy boundary `org-tee`, with hosts named in the signed policy" is now an `endpoints[]` entry of class `org-tee` (section 8.3). In decision 2, the "signed, time-boxed risk acceptance" is an `authorizations[]` record of kind `t1-risk` (section 5.3). In decision 3, "your organization's signed policy" is the organization layer of bundle v2, which personal and project layers can only narrow; until that layer exists (Phase 41) the policy on a computer is the person's own and every exception says "self-signed on this computer".

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

> **Coherence review (2026-11-20):** this section describes main as it was on 2026-11-19 and stays as the record of why the design changed. The `mcpLabelCeilings` precedent (an optional v1 key) is no longer the route for new fields: `parseBundle` refuses unknown keys, so new fields go into a v2 section named in `requires` (`POLICY-SCHEMA.md`, sections 2 and 3). The safety patch (REVIEW S6) adds `requires` and the "update the extension" text to v1 first.

### 4.5 Records

- Every model request is recorded (`routeRecordFor` in `src/gate/sessionMark.ts`, built by `src/domain/gate/record.ts`) with the model name and the bundle hash.
- The spend ledger (`src/services/spendLedger.ts`) and activity history keep the model.
- Staff product headers (`ProductHeader` in `src/domain/staff/products.ts`) and staff ledger entries (`LedgerEntry` in `src/domain/staff/ledger.ts`) have no model field.
- The extension has a code SBOM (`sbom.cdx.json`, made by `scripts/extension-sbom.mjs`). There is no AI bill of materials.

### 4.6 Local and on-prem endpoints

Provider kinds `near-ai`, `local` and `hybrid` take any OpenAI-compatible endpoint. A non-loopback host counts as local only when the bundle's `routing.localHosts` names it.

## 5. The model passport

### 5.1 Where it lives

> **Coherence review (2026-11-20):** `ceiling.models` becomes the `models` section of policy bundle v2, named in `requires` as `models@1`, so an older client says "update" instead of failing as an unknown key. Its schema is built in Phase 41 (the organization policy foundation) in report mode; Phase 74.1 keeps enforcement, the T0 lane and the defaults. T1 acceptances (5.3) become `authorizations[]` records of kind `t1-risk`, carrying the named person's own signature and shown as "self-signed on this computer" until an organization issuer exists. See `.planning/research/coherence/REVIEW.md` and `POLICY-SCHEMA.md`.

In the `models` section of policy bundle v2 (`POLICY-SCHEMA.md`, section 2), named in the bundle's `requires` as `models@1`. The section is parsed with strict key checks inside the section (`checkKeys` in `src/domain/gate/shape.ts`): an unknown key, a wrong type or an out-of-range value refuses the whole bundle, and an older client that does not know `models@1` says "update the extension", never Reset. The organization layer is the ceiling; the personal and project layers may only narrow it, key by key, in the declared direction (a lower `maxTier`, a subset of passports, an earlier expiry, `report` to `enforce` only). Without an organization layer the personal layer is the whole policy, as today.

```json
"requires": ["models@1", "endpoints@1"],
"models": {
  "v": 1,
  "mode": "enforce",
  "unknownMaxTier": "T0",
  "tierByLevel": { "ca-protected/Protected B": "T2", "ca-classified/Secret": "T3" },
  "tierByProject": { "staff": "T3", "staff-exercise": "T2" },
  "passports": [ { "...": "see 5.2" } ],
  "defaults": { "standard": "nvidia/nemotron-3-super", "fast": "nvidia/nemotron-3-nano" },
  "localCatalogue": [],
  "order": []
}
```

T1 risk acceptances are not in this section: they are `authorizations[]` records of kind `t1-risk` (section 5.3).

| Key | Meaning |
|---|---|
| `v` | Schema version of this section. Only 1 is accepted. |
| `mode` | `enforce` or `report`. In `report` the gate works out every decision, records it and shows the notice, but does not refuse (section 8.5). A narrower layer may change `report` to `enforce`, never the other way. |
| `unknownMaxTier` | Highest tier for a model with no passport. Only `T0` is accepted; the key exists so the value is visible, not so it can be widened. |
| `tierByLevel` | Optional. Raises the use tier for a `scale/level`, the way `labels.routing.levels` raises the routing tier. It can only raise. Shipped values in 6.1. |
| `tierByProject` | Optional. Raises the use tier by project kind (shipped: `staff` to T3, `staff-exercise` to T2; the exercise attribute is signed in the project layer, 6.1). |
| `passports` | Up to 256 passports. |
| `defaults` | Optional. Your organization's default model per job (`standard`, `deep`, `fast`, `vision`, `embed`, `rerank`, `safety`, `transcription`, `image`, `backup`, `t0`). Each must name a passport that covers the job's tier. People see them as "Models by job" in Settings. |
| `localCatalogue`, `order` | Owned by the local model manager (Phase 32.2) and the model resolver; listed here so the section has one shape. |

> **Superseded 2026-11-20 (coherence review):** the first draft put this object at `ceiling.models` in bundle v1, following the `mcpLabelCeilings` precedent, with an `acceptances` array of up to 64 T1 risk acceptances inside it. Both moves (v2 section with `requires`; acceptances into the one `authorizations[]` record) keep every rule of the first draft: strict keys, `unknownMaxTier` fixed at T0, `tierByLevel` only raising, the 256 passport limit and the per-job defaults. The 64-record limit now applies to `t1-risk` authorizations.

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
| `legal` | `coveredByUsLaw` (for example covered AI under FY2026 NDAA Sec. 1532), `entityList` (developer on the US Entity List), `removalOrders` (notices that order removal from some systems, such as the DHS DeepSeek notice). Any `true`, or any removal order, caps `maxTier` at T0 unless a `t1-risk` authorization (5.3) covers it, which can only reach T1. |
| `hosting` | One or more endpoint classes from the one `endpoints[]` list (`nearai-tee`, `org-tee`, `vendor-tee`, `vendor-region`, `org-plain`, `closed-api`, `local`). The class of the endpoint the request actually goes to must be one of them (8.3); `decideRoute` checks this as its passport step. First drafted as a single value from a design-only list, superseded 2026-11-20. |
| `artifact` | Format (only `safetensors` or `gguf`; never pickle), SHA-256 of the exact weights, quantization, and `remoteCode` (must be `false`). Required for `org-tee`, `org-plain` and `local` at T2 and above. For `nearai-tee` it is checked when NEAR's attestation reports a model hash (question N5). |
| `evaluation` | Reference and hash of your organization's evaluation report for this exact artifact. Required for `maxTier` T3. Optional for T2; without it the passport view and every record say "not evaluated by your organization". |
| `maxTier` | `T0` to `T3`. The highest use tier this model may serve. |
| `issuedAt`, `expiresAt` | Expiry at most 365 days after issue. An expired passport counts as T0. |
| `reevaluateOn` | The triggers that end the passport early (5.4). |

The **passport hash** is the SHA-256 of the passport's canonical bytes (`canonicalBytes`, as `bundleHash` uses). It goes into records (10).

### 5.3 T1 risk acceptance (an authorization of kind `t1-risk`)

A T1 risk acceptance is one record in the bundle's one `authorizations[]` list (`POLICY-SCHEMA.md`, section 2), the same record shape that carries Protected B authorizations, accredited devices, residency exceptions and declassifications.

```json
{
  "id": "ra-2026-014",
  "kind": "t1-risk",
  "subject": { "model": "z-ai/glm" },
  "scope": { "projects": ["<project id>"], "labels": ["org/Internal"], "uses": ["T1"] },
  "conditions": ["human review of every answer", "no tools", "cross-check by a Western model"],
  "evidence": { "benefit": "Plain-language summary of a specific, material mission benefit", "assessment": "<reference>" },
  "namedPerson": { "name": "<named senior person>", "position": "<position>", "key": "<fingerprint>" },
  "signature": "<base64url Ed25519 by the named person over the canonical record>",
  "issuedAt": "2026-11-20T00:00:00Z",
  "expiresAt": "2027-02-18T00:00:00Z"
}
```

- `scope.uses` must be exactly `["T1"]`. A `t1-risk` authorization can never raise a model to T2 or T3.
- `expiresAt` is at most 90 days after `issuedAt` (the maximum for kind `t1-risk`, owner decision O3). Any re-evaluation trigger on the passport also ends it. `revokedBy` ends it at once.
- **Inner signature.** It carries the named person's own signature over the record (Phase 69's device key now, Phase 71's credential when it lands), and the named person's key must be listed in the organization layer. The bundle that carries it is signed by your organization's issuer. Both signatures must verify.
- **Self-signed until the organization layer exists.** When the named person's key is the key of the person using it, or no organization layer is pinned, every screen that cites it adds "(self-signed on this computer)" (`POLICY-SCHEMA.md`, section 4, interim rule). Under an organization layer a personal layer cannot add a `t1-risk` authorization, because an exception widens and personal layers only narrow; a person's draft is sent to your organization's contacts as a request.
- `scope` names the projects and labels it covers; a request outside the scope is refused as if no authorization existed.
- A model with `legal.removalOrders` or `entityList: true` can still get one, but the authorization view shows those flags in the first line, so the person signs with them in view.
- **What people see.** In the trust line's Allowed part: "Allowed for chat you review by {name} until {date}", plus "(self-signed on this computer)" where it applies. Admin pages call it an authorization; "risk acceptance" stays in this design and in records.
- **How it is made.** The risk-acceptance flow opens the one policy editor on a proposal (section 8.5, `POLICY-SCHEMA.md`, section 7); it never writes the policy itself.

> **Superseded 2026-11-20 (coherence review):** the first draft had its own record shape (`passport`, `tier`, `benefit`, `mitigations`, `acceptedBy` with a `role`) inside `ceiling.models.acceptances`. The fields map one to one: `passport` to `subject.model`, `tier` to `scope.uses`, `mitigations` to `conditions`, `benefit` to `evidence.benefit`, `acceptedBy` to `namedPerson` (with the person's position instead of a free-text role). The owner's rules for it (T1 only, 90 days, named senior person, legal flags first) are unchanged.

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

> **Coherence review (2026-11-20):** shipped passports are part of the starting rules. Your organization's layer replaces them by `id`; a personal layer may only lower a passport's `maxTier`, shorten its expiry or drop it. The Hosting column lists endpoint classes (8.3). Whether the Command A+ passport also lists the Cohere vault classes (`vendor-tee`, `vendor-region`) is open question O6 (section 13.4).

## 6. Use tier of a request

### 6.1 How it is worked out

> **Coherence review (2026-11-20):** the exercise flag that lowers a staff project from T3 to T2 becomes a signed project-layer attribute, set only at genesis or by the lead with a reason, recorded like a label lowering and shown on every staff screen. See `.planning/research/coherence/REVIEW.md`, conflict K30.

The tier is the **highest** of the rules below that apply. Every input is a local fact the extension already holds at request time. Like the chat's mark, a session's tier only rises.

| Input | Fact the extension already has | Tier it raises to |
|---|---|---|
| T0 lane | The request comes from the research lane (7) | T0, and the lane forbids anything higher |
| Plain chat | No tools in the request, interactive, a person reads the answer | T1 |
| Tools | The request carries any tool definition (read, write, edit, run, web, MCP, sub-agent) | T2 |
| Context | Unattended, sub-agent, relay or routine context (`GATE_CONTEXTS`) | T2 |
| Writing to files | Apply, insert or edit actions on the answer, commit message writing, Team Studio AI (it writes team files that govern agents) | T2 |
| Checking jobs | Reviewer, release guard, tradecraft reviewer, red team, editor, plan checker, safety classifier: their verdict gates an action | T2 |
| Label | `tierByLevel`: shipped `ca-protected/Protected B` and `Protected C` and `org/Restricted` to T2; every `ca-classified` level and `nato/NATO Confidential` and above to T3 | as set |
| Project type | A `staff` project: T3 (decision support, intelligence fusion, planning). A staff project whose project layer carries the signed exercise attribute (fictional data only, set at genesis or by the staff lead with a reason, recorded, and shown on every staff screen): T2. Read through `models.tierByProject` | as set |
| Cyber | A cyber engagement | T0 lane only (decision 4) |
| Vision, transcription | The tier of the chat that sent the attachment | inherited |
| Embedding, reranking | The tier of the feature that reads the result, at least T1 | inherited, minimum T1 |
| Compare Models | Evaluating models on synthetic tasks is a T0 activity; comparing on project tasks is T2 | T0 lane or T2 |

A plain chat answer at T1 that a person then wants to apply to a file needs a T2 model for the apply step: the Apply button on an answer from a T1-only model is disabled with the reason, and the person copies the text by hand if they choose (the copy carries no marker into the file, which the AI BOM records instead).

### 6.2 Where the gate checks it

The passport check is **step 5 of the one decision function**, `decideRoute(label, use, endpoint, authorizations, residency, passport, clearance)` in `src/domain/gate/routing.ts` (`POLICY-SCHEMA.md`, section 6): the passport must cover the use tier (or a `t1-risk` authorization in scope must, for T1), and the endpoint's class must be one the passport lists. Its passport logic lives in a pure helper beside it in `src/domain/gate/`, called only by `decideRoute`, so the guide's `recommend()`, the model picker, sub-agent resolution, the hub and the Cohere adapter all get the same answer. Its result feeds `TrustFacts` (`src/domain/gate/trust.ts`), which the trust line, the picker and the record read. It is enforced in one place and previewed in others:

| Place | What it does |
|---|---|
| `checkRoute` in `src/services/nearAiClient.ts` (the first `ModelEndpoint` adapter from Phase 41) | **Enforces.** Every model request already passes here. The session route carries the use tier beside the chat's label; the decision is recorded in the local audit record. Covers chat, agents, sub-agents, the backup model, the safety classifier, vision, transcription, image, embedding, Team Studio AI, Compare Models and the cyber harness, because all of them send through a `ModelEndpoint`. |
| `OutboundGuard.check` | Previews for chat, the chat participant and Team Studio AI, so the refusal shows before the person waits. Its own privacy-mode routing role is retired (REVIEW K6): `nearAi.privacyMode: tee-only` is a floor inside `decideRoute`. |
| Model picker and model directory | Show each model's origin, family and what it is approved for in use words ("Approved for agent work until 1 Jun 2027"), and grey out models the current session forbids, with the reason as text, not only on hover. The place comes from the trust line's Runs on words (8.6). |
| Sub-agent resolution (`src/services/agentOrchestrator.ts`, Models by job) | Picks only models whose passport covers T2; an agent pinned to a forbidden model fails its check with the reason before the run starts. Team policy and pins choose only among what the effective policy allows (REVIEW K29). |
| Backup model | Must cover the session's tier and be at least as private (today's rule). Otherwise the reply keeps waiting, as when no backup is set. |
| Safety classifier | Must cover T2 and be a different family from the run's model (9). Otherwise the command asks a person, as today when the classifier is not private. |
| Cyber harness (`src/domain/cyberModel.ts`, `src/services/cyberHandoff.ts`) | Opens only in the research workspace. The `glm-5.3` fallback is removed; the fallback is the research workspace default. |

> **Superseded 2026-11-20 (coherence review):** the first draft had a separate pure function, `decideModelUse(request, passports, acceptances, now)`, in a new `src/domain/gate/models.ts` (a path that does not exist on main), called beside `decideRoute`. It is now a step inside `decideRoute`, so there is one decision function and one trust record. The rule ids, the order of checks (12.2) and the "never retry on another model" rule are unchanged.

### 6.3 Refusal sentences

Each refusal follows the trust line's refusal form (`EXPERIENCE.md`, section 3): "Nothing was sent. {What}. {Why}. {What you can do}. {Who to ask}." Never a raw rule id; "Who to ask" always comes last and names the contact from `onboarding.contacts` (or "you set these rules yourself" without an organization). Use words, from the glossary: T0 "research only (in the research workspace)", T1 "chat you review", T2 "agent work" (including code and Protected B), T3 "operational work" (including classified). Places use the Runs on words (8.6). "Your organization's rules" reads "Your rules" when no organization layer is pinned. Labels are shown as scale name plus level.

| Rule | Sentence |
|---|---|
| `model.tier-exceeded` | Nothing was sent. Your organization's rules approve {model} only for {max use words}, and this request is {use words} because {reason}. Choose one of these models instead: {list}. Who to ask: {contact}. |
| `model.unknown` | Nothing was sent. {model} is not approved by your organization's rules for any use, so it may be used only for research in the research workspace. Choose an approved model. Who to ask about approving it: {contact}. |
| `model.passport-expired` | Nothing was sent. The approval for {model} ended on {date} ({trigger}). Until it is approved again it may be used only for research in the research workspace. Who to ask: {contact}. |
| `model.acceptance-missing` | Nothing was sent. {model} may be used for chat you review only when a named senior person allows it, and no one has allowed it for this project and label. Choose an approved model, or ask for an exception. Who to ask: {contact}. |
| `model.acceptance-expired` | Nothing was sent. {name} allowed {model} until {date}, and that has ended. Choose an approved model, or ask {name} to renew it. |
| `model.revoked` | Nothing was sent. Your organization withdrew {model}: {reason}. It cannot be used for anything. Who to ask: {contact}. |
| `model.artifact-mismatch` | Nothing was sent. The server at {host} proved it is running different model files from the ones your organization approved, so it is not used. Who to ask: {contact}. |
| `model.hosting-mismatch` | Nothing was sent. {model} is approved only when it runs on {approved Runs on words}, and this request would run on {actual Runs on words}. Who to ask: {contact}. |

> **Superseded 2026-11-20 (coherence review):** the first draft's sentences used "model passport", "risk acceptance", "security officer" and tier words, and named hosting classes. The rules and their meaning are unchanged; only the words follow the glossary and the one refusal form.
| `model.same-lineage` | (Not a send refusal.) This check was not given to {model}, because it comes from the same family ({family}) as the model it checks, and no approved model of another family is available. A person decides instead. |
| `model.lane-only` | This is the research workspace. It cannot open project files, run commands or use tools. |

No refusal ever retries on a different model by itself. The list of alternatives is filtered by the passport check and by `decideRoute`, so every model offered would pass both.

## 7. The T0 lane

An isolated workspace for adversary-model research. It is where PRC-origin models are used on purpose. People call it the **Research workspace**; "T0 lane" is the design and record name only (`GLOSSARY.md`, section 3).

> **Coherence review (2026-11-20):** the research workspace is a place to work, not a setup flow, so it keeps its own command. It is also offered from Compare Models, the empty-state card (8.5) and the cyber harness. Its command follows the namespaced ids (`nearAi.models.openResearchWorkspace`, hidden alias for any earlier id) and the copy lint.

- **Separate surface.** "NEAR AI: Open Research Workspace" opens a chat with a fixed banner: "Research workspace. Adversary models allowed. No project data." It has its own storage folder in the extension's global storage, never in a project.
- **No production data.** No project file reads, no workspace search, no project memory or knowledge graph, no team, no chat history import. A person may attach files only from the lane's own folder; anything they drop in is copied there first and labelled.
- **No write, run or network tools.** No shell, no file writes outside the lane folder, no web, no MCP. A separate "exercise sandbox" exists only for the cyber harness (below).
- **Labelled.** Every lane session carries the T0 tier. Records say `lane: t0`. Text copied out of the lane carries a one-line header ("From the research workspace, model {model}, untrusted").
- **Uses.** Red teaming, threat analysis of adversary models, trigger sweeps, Compare Models evaluations on synthetic tasks, and the cyber harness.
- **Cyber harness.** The one T0 use with tools, because a scan needs them. It is allowed because the tools run only inside the engagement's sandbox against its accepted scope (the engagement scope fingerprint and disclaimer already exist), never on the project or the host. Until the Phase 72 execution backend and the v0.8.0 isolated VM enclave exist, scans keep today's approvals and say they are not VM-isolated. When a Western model can do the work, the harness may move out of the lane by policy.

## 8. Western defaults and the empty state

### 8.1 Defaults per role

The defaults name passports, not raw ids, so the same default works on NEAR and on your organization's hosting. People see this table as **Models by job** in Settings (`EXPERIENCE.md`, section 2), with your organization's `models.defaults` in place of the shipped ones where set.

| Job | Western default | Second choice (other family) | Notes |
|---|---|---|---|
| Standard model and chat | Nemotron 3 Super | Command A+, then gpt-oss-120b | |
| Deep model | Nemotron 3 Ultra | Command A+, then gpt-oss-120b | Command A+ first where Ultra is not hosted |
| Fast model | Nemotron 3 Nano | gpt-oss-20b | Another family at a small size |
| Vision | a Nemotron vision model, if NVIDIA ships one in the Nemotron 3 line | Cohere Command A Vision | Licence check: Command A Vision was released under a non-commercial licence; question N1 |
| Embeddings | a Western embedding model with a passport (NVIDIA's Llama-based retriever models or IBM Granite embedding) | Cohere Embed (private deployment) | Re-embedding the knowledge base is needed when it changes |
| Reranker | NVIDIA's Llama-based reranker or IBM Granite reranker | Cohere Rerank (private deployment) | |
| Safety classifier | a small Western model of a different family from the run's model (for example NVIDIA's Llama-based safety guard, or gpt-oss-20b, when runs use Nemotron) | Nemotron 3 Nano when runs use Command A+ or gpt-oss | Different-lineage rule (9) |
| Backup | the other Western family for the same job | | Different family keeps a stall from being a shared fault |
| Transcription | `openai/whisper-large-v3` | | Already Western, already in NEAR's TEE |
| Image | `black-forest-labs/FLUX.2-klein-4B` | | Already Western, already in NEAR's TEE |
| Research workspace (T0 lane) | your organization's choice; shipped: the NEAR abliterated model for cyber, any PRC model for research | | |

Exact model ids are pinned when NEAR or your organization's hosting publishes them.

### 8.2 Brand names are not lineage

"Nemotron" names several unrelated things. Nemotron 3 is trained from scratch by NVIDIA. Llama-Nemotron is a Llama base with DeepSeek-R1 reasoning data. OpenReasoning-Nemotron is a Qwen2.5 base, so its origin is PRC. Passports therefore match exact, anchored ids, and the resolver never infers origin or family from a name.

### 8.3 Hosting classes

> **Coherence review (2026-11-20):** `routing.attestedHosts` is replaced by entries of class `org-tee` in the one `endpoints[]` list (exact host, TLS pin, region, `maxLabel`, attestation spec), and `routing.localHosts` entries become class `org-plain`. People see the class only as the "Runs on" part of the trust line. See `.planning/research/coherence/REVIEW.md` and `POLICY-SCHEMA.md`, section 5.

The hosting class is the `class` of an entry in the one `endpoints[]` list (`POLICY-SCHEMA.md`, section 5). It is the one stored fact per endpoint; every other word for it is derived through `TrustFacts`. People see only the Runs on words.

| Class | Meaning | Runs on (what people see) | Satisfies `attested-cloud` |
|---|---|---|---|
| `nearai-tee` | NEAR AI Cloud's private hardware, NEAR's endpoint (today's `tee`) | NEAR AI private hardware | Yes, as today, after the fresh bound-connection check |
| `org-tee` | Your organization's confidential-computing server, attestation verified (Phase 74.2) | your organization's server (private hardware) | Yes, once verified |
| `vendor-tee`, `vendor-region` | A Cohere vault, Encrypted or Standard (Cohere vault design) | Cohere vault in {region} | `vendor-tee` once verified; `vendor-region` no |
| `org-plain` | Your organization's server without attestation | your organization's server | No |
| `forwarded` | A model NEAR forwards to another provider | outside provider ({name}) | No |
| `closed-api` | A closed model reached through a provider's API | outside provider ({name}) | No |
| `local` | A runtime on this computer (`http-loopback`) | this computer | Yes (local is stricter) |

For `org-tee` an endpoint entry carries the exact host, `https`, a TLS pin, the `region`, a `maxLabel`, and an `attestation` spec: expected measurements of the serving stack, the accepted hardware roots, and the allowed model artifact hashes. The extension verifies the server's attestation report and binds the TLS connection to it the same way it does for NEAR (D-50 connection binding), through the one verifier interface (`AttestationVerdict`) that NEAR, Cohere Encrypted and org-tee share. The endpoint is reached through a `ModelEndpoint` adapter (an OpenAI-compatible one serves vLLM and NIM). If your organization runs the same open-source private inference stack NEAR uses, one verifier implementation serves both; NVIDIA NIM on confidential computing would need a second one behind the same interface. Attestation proves the code and the weights, not the data centre's location: the Canadian location is a contractual fact your organization records in the endpoint's `region`, which the gate's `route.residency` rule reads. Endpoints are added only through a proposal in the policy editor (section 8.5), never written by a setup flow.

> **Superseded 2026-11-20 (coherence review):** the first draft added an optional `routing.attestedHosts` list (host pattern, measurements, roots, artifact hashes) beside `routing.localHosts`, and said `org-plain` counts as local only if `routing.localHosts` names it. Both lists are replaced by `endpoints[]`; the patterns become exact hosts with a TLS pin (a wildcard is allowed only for `org-plain` up to `org/Restricted` and Protected A), and each `localHosts` entry migrates to an `org-plain` endpoint at today's effect. The first draft also cited `src/services/attestation.ts` as the shared verifier; the shared piece is now the verifier interface.

### 8.4 One place for defaults

- `AGENT_DEFAULTS` in `src/domain/agentDefaults.ts` becomes the only source: the tier defaults plus `vision`, `transcription`, `image`, `embed`, `rerank`, `safety`, `backup` and `t0`, each as a passport id with a preference list.
- `DEFAULT_MODEL` in `src/domain/config.ts` is derived from it. The duplicate fallbacks in `readAgentModels` in `src/services/settings.ts` are removed and read from `AGENT_DEFAULTS`. The `glm-5.3` fallback in `src/services/cyberHandoff.ts` is removed.
- Model settings in `package.json` default to empty, meaning "your organization's default for this job, else the shipped one". A value a person already set is kept exactly as set. In Settings they appear as one **Models by job** table that replaces the separate model settings and `roleModels` (`EXPERIENCE.md`, section 2); a person's choice narrows inside what the policy allows and never widens it.
- `src/test/agentDefaults.test.ts` widens: every model default in `package.json` matches `AGENT_DEFAULTS`, and no model id literal appears in `src/` outside `agentDefaults.ts`, the shipped passports and tests.

### 8.5 When nothing is allowed

Today, under the Western defaults, a T2 request on NEAR has no allowed private model: every TEE model is PRC-origin, and the closed Western models are not private. This state must be visible, never a silent fallback.

**First run never lands here.** Get Started runs viability and the passport check before landing, and never lands a person on a surface with no allowed model (`EXPERIENCE.md`, section 1). Under the Western defaults a staff project needs T3 and no shipped passport reaches T3, so until your organization approves a model for operational work the guide's staff step offers "exercise on fictional data" only and says why on its options screen. The card below is for a person who later changes model, label or project; it is never the first thing a new user sees.

**What the person sees.** A card in place of the reply:

> No model your organization's rules allow can do this. This chat is {use words} at label {scale name}: {level}. Models allowed for that: none available on {Runs on words}.
> Ways forward:
> 1. Use your organization's own server, if it has one. [Add your organization's server]
> 2. Use a closed Western model from an outside provider. Allowed only because this chat's label is {scale name}: {level}, which may go to any cloud. Your text leaves private hardware. [Use {model}]
> 3. Wait for NEAR AI Cloud to host Western models. [What NEAR AI has been asked]
> 4. For research on adversary models, open the research workspace. [Open]
> Who to ask: {contact}.

Option 1 opens the guide's "AI services" option (the same step as Settings > Connections and AI services), which ends on a proposal in the policy editor; it is not a separate setup command. Option 2 appears only when the label's routing tier is `any-cloud` and a closed-api passport covers the use. Choosing it sets the model for this chat only, and the record says the person chose it.

**Transition, so nothing breaks today.** The `mode` key decides:

- A policy **without** a `models` section keeps today's behaviour (a missing section means today's behaviour, `POLICY-SCHEMA.md`, section 2) and runs the passport check in **report** mode with the shipped passports: decisions are recorded as `would-refuse`, the model picker shows origin and what each model is approved for, and a one-time card offers **"Adopt the Western defaults"**.
- **"Adopt the Western defaults" writes a proposal, never the policy.** It opens the one policy editor (`POLICY-SCHEMA.md`, section 7) on a proposal that adds the `models` section with `mode: enforce`, with its effect in plain words ("Agent work will be refused on every model NEAR AI hosts today until a Western model is hosted"). On a personal policy the person applies it there, which records a `policy.edit` in the local audit record. Under an organization layer the card is not offered to members (their organization decides); an administrator's proposal is exported as a request to `onboarding.contacts` and nothing changes locally. Edit controls appear only where this device can sign the layer shown.
- An organization layer with a `models` section applies exactly what it says, from the first request.
- The shipped starting rules for **new** installs get `mode: enforce` in the first release after NEAR hosts a Western model for the standard job (or your organization's hosting exists). Until then new installs get `report`, so the first chat works.

This is the one place the design does not enforce decision 2 at once for people with no organization policy. The owner accepted it (O1).

> **Superseded 2026-11-20 (coherence review):** the first draft had "Adopt the Western defaults" write `ceiling.models` itself through Edit Policy, and option 1 read "[Set up organization hosting]" as its own flow. Both now go through the guide and the one policy editor. The report-mode transition and its owner decision (O1) are unchanged.

### 8.6 The words "private" and "Runs on" (with the safety patch)

"Private" means one thing only: the request runs on verified private hardware or on this computer, and the check passed (`GLOSSARY.md`, section 4; REVIEW S4). Phase 74.1's integration retires every bare "Private" this design touches:

- **Model picker.** "Private · runs in NEAR TEE" (`src/services/chatBridge.ts`) becomes **"NEAR AI private hardware (checked each time it is used)"**, and every other entry names its place with the Runs on words of 8.3, including "this computer", "your organization's server" and "outside provider ({name})". Origin and approval sit on the same row ("US · Approved for agent work until 1 Jun 2027").
- **Member and team `privacy: private`, `nearAi.privacyMode: tee-only` and Team Mode's `teeOnly`** are floors of `attested-cloud` inside `decideRoute`, so the fresh bound-connection check decides, never the catalogue's `privacyBoundary`. Team flags read "private models only". The setting reads "Only verified private hardware or this computer".
- **Staff templates** (`src/agent/staff/j2Template.ts`, `j3Operations.ts`, `src/domain/staff/releaseGuard.ts`) move from `privacy: private` to "needs operational-work approval and verified private hardware or this computer". Until then they carry the safety patch sentence (S5): the private models NEAR AI offers today come from developers in the People's Republic of China; use this team only on fictional or exercise material until your organization approves a model for operational work.
- **README tagline and SECURITY.md** drop bare "private" and say what is checked, in the same release as the trust line.
- **One trust line, no fourth state.** Every answer, agent card and staff product row shows Runs on, Verified (the three shipped proof levels) and Allowed, where Allowed names the passport ("Approved for agent work until {date}") or the `t1-risk` authorization ("Allowed for chat you review by {name} until {date}", plus "(self-signed on this computer)" until your organization's layer exists). Provenance adds no badge state of its own.

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
| Route decision record (`routeRecordFor`, `src/domain/gate/record.ts`), the local audit record | `useTier`, `passport` (id and hash), `authorization` (id, when a `t1-risk` record allowed it), `artifact` (attested hash when known), `endpoint` (id and class), `lane`, and for `report` mode `wouldRefuse` with the rule. The record already has the model and bundle hash. These are fields of `TrustFacts`, so the record and the trust line cannot disagree. The local audit record is hash-chained with periodic signed heads (ADR-011); nothing here is called "signed" per record until the code signs it. |
| Staff product header (`src/domain/staff/products.ts`) | `model`, `model_artifact`, `passport` as optional keys after `tradecraft` in `PRODUCT_HEADER_KEYS`; required for states past `guard-checked` once Phase 74.1 is on. |
| Staff replica entries (propose and revise) | Optional `model`, `artifactHash`, `passportHash` fields on the propose and revise entry kinds of the staff stream (replica v2). |
| Spend ledger and activity | Already keep the model; add the passport hash. |
| Decision log | Already has model and bundle hash through the route record. |

> **Superseded 2026-11-20 (coherence review):** the first draft added these fields to the staff v1 ledger entry (`src/domain/staff/ledger.ts`) under a new `LEDGER_ENTRY_VERSION`. Shared staff facts now ride the replica layer (ADR-010, ADR-011), so the fields go on replica entry kinds instead; old v1 ledgers still replay unchanged.

### 10.2 Per-project AI bill of materials

- A CycloneDX ML-BOM per project, written to the project's NEAR AI state folder beside where an SBOM would sit, and regenerable from the decision log.
- One `machine-learning-model` component per model used: supplier (developer), origin, licence, hashes (artifact), `pedigree.ancestors` for the base and teachers, the passport hash, endpoint class, the tiers it served, and first and last use.
- Generated by "Export AI Bill of Materials" (command id under the `nearAi.models.*` namespace; shown in the palette only in an open project), also offered on the project's Home and attached to a staff product release.
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
- **Promotion is a signed person decision** with an expiry and the re-evaluation triggers of 5.4. The opportunity agent only proposes; auto-promotion (D9 in the 04 document) is removed for anything above T0. The decision produces a passport proposal in the policy editor; it takes effect only when the organization layer carries it (or, without one, the person's own layer, marked self-signed).
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
| approved (T0, PRC) | Signed bundle with a valid `t1-risk` authorization in scope (inner signature verifies; the named person's key is listed in the organization layer, or the record is marked self-signed when no organization layer exists) | risk-accepted | T1 within scope |
| risk-accepted | Authorization expires, is removed, is revoked (`revokedBy`), or a trigger fires | approved (T0) or expired | Back to T0 |
| approved | `expiresAt` passes | expired | T0 only |
| approved, risk-accepted | A re-evaluation trigger (5.4) is seen | expired (reason: trigger) | T0 only; recorded once |
| expired | New signed passport | approved | Usable up to the new `maxTier` |
| any | Your organization revokes (passport removed with a revocation entry, or a `removalOrders` entry that says "all uses") | revoked | Not usable at any tier, including T0 |
| revoked | New signed passport | approved | Only by a new bundle |
| any | Bundle fails to verify or expires | (bundle fail-closed) | Today's fail-closed routing applies; every passport counts as T0 |

| any | An older client meets `models@1` in `requires` without knowing it | (bundle `needs-update`) | Read and plan only, with "Update the extension"; never Reset |

No state waits forever: every non-terminal state ends by a clock (expiry) or by a new bundle. `revoked` ends only by a new bundle. "Signed bundle" means the layer that may carry the change: the organization layer for anything that widens (a passport, a raised `maxTier`, a `t1-risk` authorization); a personal or project layer only for narrowing (a lower `maxTier`, a removed passport). Without an organization layer the personal layer is the whole policy and every such record shows "self-signed on this computer".

### 12.2 Request gate decision

States: `received`, `tier-derived`, `passport-resolved`, `checked`, `allowed`, `refused`, `sent`, `recorded`.

These transitions are the passport step (step 5) of `decideRoute` and its neighbours, in the order `POLICY-SCHEMA.md` section 6 gives: label tier and endpoint class, `maxLabel`, authorizations (Protected B, accredited device), residency, then the passport rows below, then clearance. "`decideRoute` allows" in the table means the other steps passed. Every outcome, allowed or refused, produces one `TrustFacts` record that the trust line and the local audit record read.

| From | Event | To |
|---|---|---|
| received | Use tier worked out (6.1) | tier-derived |
| received | Tier cannot be worked out | refused with the existing "could not be worked out" sentence (`routeCheckFailed`), never guessed |
| tier-derived | Passport found, or unknown rule applied | passport-resolved |
| passport-resolved | Passport status check (12.1) | checked, or refused (`model.passport-expired`, `model.revoked`, `model.unknown`) |
| checked | Tier within `maxTier`, or T1 within a valid `t1-risk` authorization | next check |
| checked | Tier above | refused (`model.tier-exceeded`, `model.acceptance-missing`, `model.acceptance-expired`) |
| next check | Hosting agrees and, where known, the artifact hash matches | next check |
| next check | Hosting or artifact differs | refused (`model.hosting-mismatch`, `model.artifact-mismatch`) |
| next check | Checking role: families differ | next check |
| next check | Checking role: same family, no alternative | refused to the person (`model.same-lineage`) |
| next check | The other `decideRoute` steps allow, `OutboundGuard` allows | allowed |
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

> **Coherence review (2026-11-20):** O1 now reads "a policy without a `models` section". O2's exercise mark is the signed project-layer attribute (REVIEW Q10, accepted). O3's 90 days is the maximum expiry for authorizations of kind `t1-risk`. O4's device-key signature is the inner signature of the `t1-risk` record, shown as "self-signed on this computer" until your organization's layer lists the named person's key (REVIEW Q1 and Q2, accepted).

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
| Policy authors raise `maxTier` carelessly | `evaluation` required for T3 and shown as missing at T2; T1 for PRC only by a `t1-risk` authorization; those cannot reach T2; under an organization layer a person cannot raise anything, only narrow |

### 13.4 Open questions from the coherence rewrite (2026-11-20)

These came up while bringing this design in line with the coherence review and were not settled by it. Each has a recommended default; nothing here is decided until the owner says so.

| # | Question | Recommended default | Why |
|---|---|---|---|
| O6 | Does the shipped Command A+ passport list the Cohere vault classes (`vendor-tee` for Encrypted, `vendor-region` for Standard) as allowed hosting, beside `nearai-tee` and `org-tee`? | Yes, both, at T2. What content may reach a Standard vault stays the routing table's and the endpoint `maxLabel`'s job (Standard default `org/Public` only, Q5) | The passport is about the model's origin and artifact; where content may go is already decided by `decideRoute`'s label and endpoint steps, so the passport should not repeat it |
| O7 | Without an organization layer, may a person create a `t1-risk` authorization on their own computer at all, or only see the report-mode notice? | Allow it, marked "self-signed on this computer" everywhere, as decision O4 already allows a device-key signature | Keeps O4 as decided; the self-signed mark tells everyone it has no organization behind it |
| O8 | When a staff project has the exercise attribute and the T3 approval later exists, does the attribute stay until a person removes it? | Yes: it is removed only by the staff lead with a reason, recorded like a label change | No unrecorded change of a staff project's rules in either direction (REVIEW Q10) |

## 14. Work packages

WP-0 lands first because every other package imports its schema; everything after it runs in parallel worktrees from the same base, then one integration. One line on the dependency: WP-0 is the shared contract (passport schema, tier enum, tier derivation), so it cannot run beside its consumers.

> **Coherence review (2026-11-20):** WP-0's schema part (the `models` section shape, parsed in report mode, and the `t1-risk` authorization kind) moves into Phase 41, the organization policy foundation (FND-04 and FND-08), together with `decideRoute`, `TrustFacts`, `endpoints[]`, the policy editor shell and `ModelEndpoint`. Phase 74.1 keeps enforcement, the tier derivation, the research workspace, the defaults and the UI. The table below is updated in place; the first draft's wording is kept in each superseded cell's note.

| WP | Scope | Worktree | Depends on | Tests |
|---|---|---|---|---|
| WP-0 Contract | Schema in Phase 41: `models` section parser (strict keys inside the section, limits, `requires: models@1`), passport type, `t1-risk` authorization kind. In 74.1: use tier enum, pure `useTierFor` (6.1), shipped passports (5.5), passport hash. (First draft: `ceiling.models` as an optional v1 key with an acceptance type.) | `feat/model-passport-contract` | Phase 41 | Policy without the section parses as before; an older client meeting `models@1` says update, never Reset; unknown key, bare `*` match, `remoteCode: true`, pickle format, `maxTier` T3 without `evaluation`, acceptance above T1, acceptance over 90 days and expiry over 365 days are each refused; overlapping matches take the stricter; tier table cases for every input row; tier only rises in a session |
| WP-GATE | The passport step of `decideRoute` (a pure helper in `src/domain/gate/` called only by it; first draft: `decideModelUse` in a new `models.ts`); enforced in `checkRoute`; preview in `OutboundGuard`; new rule ids and sentences in the refusal form; `report` mode; `TrustFacts` and record fields | `feat/model-gate` | WP-0 | Every row of 12.2 including each refusal; report mode records `wouldRefuse` and allows; no request reaches the network on refusal (recorded); backup and safety classifier refused or sent to a person, never to a forbidden model |
| WP-DEFAULTS | One place for defaults (8.4); empty settings mean "policy default"; resolver by passport; remove duplicates in `settings.ts`, `config.ts`, `cyberHandoff.ts` | `feat/model-defaults` | WP-0 | Widened `agentDefaults.test.ts`; no model id literal outside the allowed files; a person's set value is kept; resolver never returns a forbidden model |
| WP-LANE | Research workspace (7): surface, storage, tool set, labels, copy-out header; Compare Models and cyber harness move into it | `feat/t0-lane` | WP-0, WP-GATE | Lane cannot read project files, run commands, use tools or call MCP; cyber opens only in the lane; copied text carries the header |
| WP-LINEAGE | Different-lineage rule for checking roles (9) | `feat/lineage-checks` | WP-0, WP-GATE | Same-family checker swapped for the second choice; none available goes to a person; staff release guard and tradecraft reviewer records show both families |
| WP-ACCEPT | Risk acceptance flow as a section of the one policy editor: draft a `t1-risk` authorization, sign it with the named person's key (inner signature), apply it as a proposal on a personal layer or export it as a request under an organization layer; expiry view; renew. (First draft: its own command that added the acceptance to the policy.) | `feat/risk-acceptance` | WP-0, Phase 41 policy editor | Inner signature over canonical bytes verifies; tampered scope fails; expiry, revocation and trigger end it; legal flags shown first; "self-signed on this computer" shown when the signer is this person or no organization layer exists; under an organization layer nothing changes locally |
| WP-UX | Origin, family and "Approved for {use}" in the model picker and directory; picker text per 8.6; the trust line's Allowed part for passports and `t1-risk` records; empty-state card (8.5); adopt-defaults card as a policy-editor proposal; passport view in the policy editor's Models section; Models by job table in Settings | `feat/model-provenance-ux` | WP-GATE, WP-DEFAULTS | Each empty-state option appears only when its condition holds; closed-api option only at `any-cloud`; adopt opens a proposal and writes a `policy.edit` record only when applied on a personal layer; no "tier", "passport" or bare "Private" in user copy (copy lint) |
| WP-PROV | Record fields, product header keys, staff replica entry fields (first draft: staff ledger version), AI BOM export (10) | `feat/model-provenance-records` | WP-0, WP-GATE | Header round trip with and without the new keys; old v1 ledgers still replay; AI BOM validates against CycloneDX 1.6 ML-BOM schema and lists base and teachers |
| WP-ORGTEE (Phase 74.2) | `org-tee` endpoint class in `endpoints[]` (first draft: `routing.attestedHosts`), a `ModelEndpoint` adapter for it, a verifier for the chosen stack behind the shared verifier interface, connection binding, artifact hash check | `feat/org-tee` | WP-0, WP-GATE, Phase 41 | Non-listed host never counts as attested; wrong TLS pin refused; wrong measurement, wrong model hash or unbound TLS refused; listed and verified host satisfies `attested-cloud` |
| WP-FACTORY (v0.6.0) | Phase 98 and 99 requirement changes (11) | in those phases | Phase 74.1 | Job refused with a PRC base above T0, a teacher sharing the student's base, or a blocked licence; promotion needs a signature; differential evaluation report present |
| Integration | Merge WP-0, WP-GATE, WP-DEFAULTS, then WP-LINEAGE, WP-ACCEPT, WP-PROV, WP-LANE, WP-UX; SECURITY.md and README text; one full verification run | `feat/model-provenance-integration` | All of Phase 74.1 | Full suite once; scripted run: PRC model refused for an agent run with the sentence, Western closed model offered at a Public label only, T0 lane red-team session, staff product header with passport |

### 14.1 Where it lands

- **Phase 41** (organization policy foundation): WP-0's schema, in report mode (coherence review, section 9.2, FND-08).
- **Phase 74.1** (v0.5.0): the rest of WP-0, WP-GATE to WP-PROV and the integration, including the retirement of bare "private" (8.6). It depends on Phase 41, Phase 70 (gate, bundle, labels) and Phase 69 (signer), so it can run beside Phases 71 to 74 and ship in a 0.4.x feature release as it lands, like other Stage 1 work. Phase 71 later swaps the authorization's inner signer for a credential. (First draft: 74.1 depended only on Phases 69 and 70; superseded 2026-11-20.)
- **Phase 74.2** (v0.5.0): WP-ORGTEE. It needs your organization's hosting to exist for its end-to-end check; the code and tests do not.
- **v0.6.0**: WP-FACTORY changes Phases 98 and 99.
- **v0.8.0**: the cyber harness keeps its T0 lane until a Western model can do the work.

## 15. Sources

Public sources, cited by title: NIST CAISI evaluations of DeepSeek and of Kimi; FY2026 National Defense Authorization Act, Sec. 1532; DHS notice on DeepSeek (October 2026); US Entity List addition of Zhipu AI (January 2025); Hubinger et al., *Sleeper Agents: Training Deceptive LLMs that Persist Through Safety Training* (2024); Cloud et al., *Subliminal learning* (2025); Egashira et al., *Exploiting LLM Quantization* (2024); Betley et al., *Nature* (January 2026); CrowdStrike, DeepSeek-R1 triggered degradation (November 2025); Canadian Centre for Cyber Security, supply chain integrity (SCI) criteria and ITSP.10.035 to ITSP.10.037 (October 2026); Treasury Board of Canada Secretariat, guide on the use of generative AI; CycloneDX 1.6 ML-BOM specification. Repository files are cited inline from `origin/main`.

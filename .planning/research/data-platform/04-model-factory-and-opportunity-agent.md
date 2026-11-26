# Model Factory and Opportunity Agent

**Area:** 04 of the data platform research
**Researched:** 2026-11-18
**Question:** How should the extension fine-tune open-weight models into specialists on the organization's own on-prem hardware (AMD Strix Halo first, NVIDIA GB10 next), and how should an always-watching agent find, propose and build those specialists?

## Amendment (2026-11-19): Western bases, PRC teachers only in the T0 lane

The owner's model provenance decisions of 2026-11-19 change this document. The design is in `.planning/research/model-provenance/DESIGN.md` (section 11). Where the text below disagrees, the amendment wins; the rest stands.

- **Bases change to NVIDIA Nemotron 3.** Nemotron 3 Nano is the first base (it fits the Strix Halo and the GB10, to measure in Phase 85); Nemotron 3 Super is for larger hardware; Cohere Command A+ (Canadian, Apache 2.0) is for serving and is the second lineage for checking roles. OpenAI gpt-oss-120b (US, Apache 2.0, a mixture of experts with about 5.1B active parameters; gpt-oss-20b for small specialists) was added on 2026-11-20 as a base of another lineage, so a specialist and its checker can come from different Western families. Qwen3.5 and Qwen3.6 are no longer default bases (decision D3 and section 4): they are PRC-origin, so any specialist trained on them is PRC-origin and may be used only in the T0 research lane. Qwen embeddings and the Qwen reranker are replaced by Western models with passports.
- **PRC models are teachers only, and only in an isolated T0 lane.** Their outputs may become filtered synthetic training data; their weights never become a base. A teacher never shares a base with the student. NEAR-hosted DeepSeek, GLM and Qwen teachers are called only from that lane, never with your organization's data above T0.
- **Every served artifact gets a model passport** (developer, origin, lineage with base and teachers, licence and inherited licences, artifact hash including quantization, evaluation report, highest use tier, expiry and re-evaluation triggers).
- **Evaluation adds** agent hijacking, secure code, trigger sweeps with Canadian and defence context, and a differential against the base, all run on the exact artifact served.
- **Promotion is a signed person decision** with an expiry. The opportunity agent only proposes; auto-promotion (D9) no longer applies above T0.
- **Crowdsourced optimization** only on a Western base, with security scoring in the score.

## Amendment (2026-11-26): Select an approved training target for each workload

The Model Factory owns training and fine-tuning for the planned classification and protection
adviser. It selects suitable organization-controlled hardware from the training targets
listed in your organization's signed policy and available on the network. The Strix Halo work in Phase 85 establishes a reference configuration
and measured evidence. Other eligible accelerators can run later workloads.

- During planning, show which approved targets match the dataset's handling restrictions,
  pinned trainer and base model, accelerator backend, memory and storage needs. The proposal
  shows the selected target, expected cost and the reason for the choice.
- Proposal approval permits the dataset builder to start. Once it seals the dataset manifest,
  verify that the job's exact target, dataset and artifact digests match the approved scope.
  Check the target's eligibility and capacity again before starting. If it is busy, show why
  the job is queued. A target or workload outside the approved scope returns to proposal
  approval before the Model Factory moves the job or its input data.
- The Model Factory can coordinate approved targets over the network. The training process
  makes no off-host network calls. Any teacher inference is a separate policy-routed operation.
- The adviser recommends sensitivity, protections, usefulness over time, retention review
  and when to reassess. Its fictional evaluation fixture is preparation. Model promotion
  still requires evaluation of the exact artifact, a signed passport and a separate activation
  decision.

**Confidence legend.** HIGH means read directly in this repository or confirmed by a primary source (vendor docs, model card, paper) plus a second source. MEDIUM means a primary source or several agreeing secondary sources. LOW means one secondary source, a community report, or my own estimate. The project's confidence seam rates every single web source LOW by default; findings below are raised to MEDIUM or HIGH only where the reason is stated. Nothing LOW should be read as settled.

---

## 1. Summary

A useful model factory is buildable today on a single 128 GB Strix Halo box, but only if the first version is narrow: LoRA adapters (not full fine-tunes) on 4B to 14B dense Apache-2.0 or MIT base models (Qwen3.5 or Qwen3.6, Gemma 4, Phi-4), trained by Unsloth core or Hugging Face TRL plus PEFT inside a pinned container, evaluated against the general model on graders the extension already has (role tests and Compare Models), and served by llama.cpp behind the extension's existing local/hybrid provider, where it appears as a `local` model in the model directory and is routed to by role or tier. The GB10 (DGX Spark class) roughly doubles to triples training throughput and has a far smoother software path (CUDA 13, NVIDIA playbooks for Unsloth, LLaMA-Factory, NeMo and plain PyTorch), so it is the better trainer once it arrives; the Strix Halo works but runs on AMD nightly or very recent ROCm builds with real stability traps (whole-machine freezes when GPU memory use passes about 80 percent of the shared pool). The opportunity agent should start from data the extension already records without content (the spend ledger tags every billable call with kind, run, agent and model; the activity history keeps ids, counts, tool and model names), find narrow, repeated, expensive tasks there, and only read sealed conversation content after a person approves a proposal whose clearance dominates the data's label. The dataset, and every model trained on it, takes the join (the highest) of its inputs' labels using the gate's existing label lattice. Deletion requests are honoured by retraining the adapter from the dataset manifest without the deleted records, because machine unlearning gives no guarantee. The first version should produce one specialist from chat and run logs only; synthetic data from the wider organization data, preference learning from edits, multi-adapter serving and NEAR AI Cloud TEE serving come later.

## 2. Recommended design

### 2.1 Decisions (opinionated)

| # | Decision | Why | Confidence |
|---|----------|-----|------------|
| D1 | Train **LoRA adapters** by default; QLoRA only when the bf16 base does not fit; full fine-tunes only for models of 4B or less. | LoRA keeps the base model's general skill ("learns less and forgets less") and, with a tuned learning rate (about 10 times the full fine-tune rate), matches full fine-tuning on small post-training datasets. Adapters are tens to hundreds of MB, so retraining after a deletion request is cheap. 128 GB cannot hold a full fine-tune above roughly 6B (about 16 bytes per parameter). | MEDIUM (two papers plus a measured table) |
| D2 | **Unsloth core (Apache 2.0) plus TRL/PEFT** as the training engine, driven by a small job spec the extension writes. Do not embed Unsloth Studio (AGPL-3.0). Do not use torchtune. | Unsloth has official AMD (RDNA 3.5 listed) and NVIDIA DGX Spark support; TRL/PEFT is the common substrate underneath it and is the fallback when an Unsloth kernel breaks on ROCm. torchtune's README says it is no longer actively maintained (last release v0.6.1, April 2025). | MEDIUM |
| D3 | Base models: **Qwen3.5 / Qwen3.6 (Apache 2.0)** first, **Gemma 4 (Apache 2.0)** and **Phi-4 family (MIT)** second. Block Llama by default. | Permissive licences with no naming, attribution-banner or user-count clauses; strong 4B to 32B sizes. Llama 4's licence adds "Built with Llama", naming rules, a 700M MAU cap and an EU carve-out for multimodal models. | MEDIUM |
| D4 | Serve specialists with **llama.cpp (GGUF base plus LoRA adapter)** on both machines in v1; add **vLLM multi-LoRA** on the GB10 later. | llama.cpp runs on gfx1151 (ROCm/HIP and Vulkan) and on GB10, exposes an OpenAI-compatible server, and supports per-request LoRA adapters. vLLM on gfx1151 is community-built and "experimental"; on GB10 it is in NVIDIA's own stack. | MEDIUM |
| D5 | The specialist enters the extension through the **existing local/hybrid provider** (`localBaseUrl`, models with `privacyBoundary: 'local'`), not a new client. | The provider factory already builds a separate local client for hybrid profiles and the model catalogue already distinguishes `tee`, `local` and `forwarded`. Role routing (`nearAi.agent.roleModels`) and tier settings already take any model id. | HIGH (read in code) |
| D6 | The trainer is a **separate worker on the host** (container plus job folder or a small local HTTP API), never Python inside the VS Code extension host. | Training jobs run for hours to days, need GPU drivers and cgroup memory caps, and must survive editor reloads. The extension only writes job specs, reads status and results, and shows them. | HIGH (design reasoning, matches existing "runs keep going" patterns) |
| D7 | The opportunity agent reads **metadata first, content only after approval.** | The spend ledger and activity history already hold no prompt text. Content lives in the sealed thread store, with a label mark per thread. Reading it is a data access that the gate must authorise. | HIGH (read in code) |
| D8 | A dataset's label is the **join of its inputs' labels**; a model's label is the join of its dataset, its teacher's prompts and its eval set. Serving a model to a session requires the session's clearance to dominate the model's label. | Fine-tuned models can regurgitate training data, including PII seen only in inputs. The gate already implements join (`raiseMark`) and dominance (`dominates`) over a five-part label. | HIGH (code) plus MEDIUM (leakage papers) |
| D9 | One click approves a proposal **up to shadow mode**. Going live is automatic only if every eval gate passes and the organization's policy allows auto-promotion; otherwise it is a second click. | Keeps the "one click" promise for the common path while never letting an unevaluated model answer real users. | MEDIUM (design) |
| D10 | Deletion is honoured by **retraining from the manifest**, not by unlearning. | Unlearning methods trade forgetting against utility and are verified empirically, not proven. LoRA retraining on 4B to 14B bases takes hours, so it is affordable. | MEDIUM |

### 2.2 Components

```
                        +--------------------------------------------------+
  existing data         |               OPPORTUNITY AGENT                  |
  ----------------      |  1 Signal collector (metadata only)              |
  spend ledger  ------->|  2 Task clusterer (signatures, later embeddings) |
  activity history ---->|  3 Scorer (value x feasibility x risk)          |
  role tests / Compare->|  4 Proposal writer -> Proposal card (one click)  |
  approval cards ------>+------------------------+-------------------------+
  thread store (sealed)                          | approved (clearance checked)
  org data platform (later)                      v
                        +--------------------------------------------------+
                        |                 MODEL FACTORY                    |
                        |  5 Dataset builder: extract, scrub PII, dedup,   |
                        |    decontaminate, split, label = join(inputs)    |
                        |  6 Teacher distiller (TEE or local teacher only) |
                        |  7 Trainer worker (host GPU, pinned container)   |
                        |  8 Evaluator: graders + LLM judge + regression   |
                        |  9 Registrar: model card, lineage, licence, label|
                        +------------------------+-------------------------+
                                                 v
                        +--------------------------------------------------+
                        |                   SERVING                        |
                        | 10 llama.cpp / vLLM on the host (OpenAI API)     |
                        | 11 Router: shadow -> canary -> live by role/task |
                        | 12 Monitor: drift, cost, edits; rollback switch  |
                        +--------------------------------------------------+
```

| Component | Responsibility | Talks to | Existing piece it reuses |
|-----------|----------------|----------|--------------------------|
| Signal collector | Aggregates per-task metadata: calls, tokens, cost, latency, model, team, role, tool sequence, approvals, undo/edit events | Spend ledger, activity store, run report, approval service | `SpendTag` (kind, runId, agentId, conversationId, projectId); activity history; run report |
| Task clusterer | Groups repeated work into candidate "tasks" | Signal collector; later a small local embedding model over sealed content | Team and role identity from Team Studio |
| Scorer | Estimates monthly value, feasibility, risk | Clusterer, model directory prices, approved training target profiles | NEAR price data already used for spend estimates |
| Proposal card | Plain-language card with value, data, label, licence, cost and an Approve button | Approval service, gate | Approval card patterns, Team Studio cards |
| Dataset builder | Builds train/dev/test splits with lineage and labels | Thread store, org data platform, PII scrubber, gate | Gate labels, `raiseMark`, sealed storage |
| Teacher distiller | Generates or improves targets with a larger model | NEAR AI Cloud TEE models or a large local model | Privacy routing (`tee`/`local` only for labelled data) |
| Trainer worker | Runs LoRA jobs, reports progress, writes adapter plus metrics | Host GPU; job folder | None (new, out of process) |
| Evaluator | Specialist versus incumbent on held-out tasks; regression suite | Benchmark runner and graders, LLM judge | `src/benchmark` graders, role suite, Compare Models leaderboard |
| Registrar | Writes model card, lineage, licence, label; adds the model to the directory | Model catalogue, local provider | `ModelInfo` (`privacyBoundary`, `locality`, readiness) |
| Router | Sends a role or task to the specialist in shadow, canary or live mode | Role models, tiers, backup model | `nearAi.agent.roleModels`, tier settings, backup model rule |
| Monitor | Watches pass rate, edits, latency, cost; triggers rollback | Spend ledger, activity, approvals | Agent Activity, run report |

### 2.3 The lifecycle (state machine)

Every specialist moves through one explicit state machine. Each state has an owner, a visible reason, and a way out, so no specialist can wait forever without saying why.

| State | Entered when | Leaves to | Stuck-state guard |
|-------|--------------|-----------|-------------------|
| `candidate` | Scorer finds a cluster above threshold | `proposed`, `dismissed` | Re-scored weekly; expires after 30 days |
| `proposed` | Card shown to someone with enough clearance and the approver role | `approved`, `dismissed`, `snoozed` | Card names who can approve; if nobody can, it says so instead of waiting |
| `approved` | One click by an approver whose clearance dominates the projected dataset label | `building-dataset` | Budget and host checked at approval time |
| `building-dataset` | Builder starts | `dataset-ready`, `infeasible` | `infeasible` names the gate that failed (too few examples, label too high, licence) |
| `dataset-ready` | Splits sealed, manifest hashed | `training` | Shows queue position for the approved target. A replacement target requires a new approval. |
| `training` | Worker picks the job | `evaluating`, `failed`, `paused` | Heartbeat every minute; `paused` when host is offline or memory guard trips, with resume |
| `evaluating` | Adapter written | `shadow`, `rejected` | `rejected` shows the scores against the gate |
| `shadow` | Gates pass | `canary`, `rolled-back` | Fixed sample window (for example 200 tasks or 7 days) |
| `canary` | Shadow agreement is high enough, plus policy or second click | `live`, `rolled-back` | Small traffic share (for example 10 percent) with automatic rollback triggers |
| `live` | Canary holds | `rolled-back`, `retired`, `retrain-required` | Monitored; one-click rollback always visible |
| `retrain-required` | A deletion request touches its dataset, a label changes, or drift is detected | `training` (new version), `retired` | Deadline shown; served traffic falls back to the incumbent if the deadline passes |
| `rolled-back` / `retired` | Manual or automatic | terminal (versions kept) | Weights kept for audit unless a deletion request requires removal |

---

## 3. Fine-tuning stack for local hardware

### 3.1 Frameworks

| Framework | Licence | Methods | Strix Halo (gfx1151, ROCm) | GB10 (CUDA 13, ARM64) | Verdict |
|-----------|---------|---------|-----------------------------|-----------------------|---------|
| **Unsloth (core library)** | Apache 2.0 (Studio UI is AGPL-3.0) | LoRA, QLoRA, full FT, GRPO and other RL, vision, MoE | Official AMD docs list "RDNA 3/3.5/4"; no Flash Attention 2 on AMD (falls back to SDPA); needs ROCm PyTorch installed first and a ROCm bitsandbytes; installer switches gfx1151 to AMD's arch-specific index and caps memory to avoid whole-box stalls. Community containers for gfx1151 exist. | NVIDIA publishes an official "Unsloth on DGX Spark" playbook (CUDA 13.0). | **Use.** Fastest path on both machines. Use core only; Studio's AGPL matters if it is modified and offered over a network. |
| **Hugging Face TRL + PEFT** | Apache 2.0 | SFT, DPO, KTO, ORPO, GRPO; LoRA, DoRA, QLoRA (with bitsandbytes) | Works where PyTorch works; this is what the community Strix Halo guides actually run (bf16 LoRA, eager attention for Gemma and Qwen). bitsandbytes must be a ROCm build (built from source in one guide). | NVIDIA's PyTorch fine-tune playbook installs transformers, peft, datasets, trl directly. | **Use** as the substrate and the fallback when an Unsloth kernel misbehaves on ROCm. |
| **Axolotl** | Apache 2.0 | Full, LoRA, QLoRA, DPO and more, YAML configs | AMD blog shows it via Docker; a 2026 Strix Halo guide needed ROCm wheels first and fused LoRA kernels disabled. | Works on CUDA. | Viable alternative; more moving parts than needed for v1. |
| **LLaMA-Factory** | Apache 2.0 | SFT, LoRA, QLoRA, DPO, PPO; web UI | AMD's own playbook (validated October 2026) fine-tunes Qwen3-4B-Instruct with LoRA on Ryzen AI Halo, Ryzen AI APUs and Radeon GPUs. | Official DGX Spark playbook. | Good for a human-driven UI; less good as a headless engine driven by an agent. Keep as a manual escape hatch. |
| **NVIDIA NeMo AutoModel** | Apache 2.0 | LoRA, QLoRA, full SFT, VLMs | No | Official DGX Spark playbook and container. | GB10 only; not worth a second engine. |
| **torchtune** | BSD-3 | LoRA, QLoRA, full, DPO | n/a | n/a | **Avoid.** README says no longer actively maintained. |
| **MLX-LM** | MIT | LoRA, QLoRA, full on Apple silicon | No (Mac only) | No | Only if a Mac becomes a training host. Out of scope. |

Sources: Unsloth AMD docs, NVIDIA Spark playbooks, AMD playbooks, community guides (see section 11). Confidence MEDIUM for the Unsloth and NVIDIA rows (vendor docs), LOW for community-only claims.

### 3.2 Methods

| Method | What it is | Memory per parameter (rough) | Use when | Confidence |
|--------|-----------|------------------------------|----------|------------|
| LoRA (bf16) | Train small low-rank matrices beside frozen bf16 weights | about 2 bytes plus activations and adapter optimizer state | Default for 1B to 32B | MEDIUM |
| QLoRA (NF4) | LoRA on a 4-bit quantised frozen base | about 0.5 to 0.7 bytes plus activations | Base does not fit in bf16 (for example 32B on Strix Halo with long sequences, or 70B anywhere); slower, and less mature on ROCm | MEDIUM |
| DoRA | LoRA variant that splits magnitude and direction; supported in PEFT | Similar to LoRA, slower per step | Try only if LoRA plateaus; not a v1 need | LOW |
| Full fine-tune | Update all weights with AdamW | about 16 bytes (weights, gradients, optimizer, master copy) | Models of 4B or less on 128 GB (Gemma-3 4B full fine-tune measured at 46 GB, 12B at 115 GB on Strix Halo) | MEDIUM |
| Sequence-level distillation | SFT on a stronger teacher's outputs (or rationales) | As the training method above | The main recipe here: frontier or large model output becomes training targets. "Distilling step-by-step" shows rationales cut needed data by more than half on its benchmarks. | MEDIUM |
| Logit distillation | Match the teacher's token probabilities | Teacher must run alongside, same tokenizer | Only if teacher and student share a tokenizer and the teacher runs locally; not v1 | LOW |
| Agent trajectory distillation | Train on full tool-using trajectories | As SFT | Specialists for agent roles; a NeurIPS 2025 paper reports 0.5B to 3B agents competitive with 1.5B to 7B chain-of-thought-distilled models | MEDIUM |
| Preference tuning (DPO, KTO, ORPO) | Learn from chosen versus rejected outputs | As LoRA, plus a reference model unless ORPO or reference-free | Phase 3: user accept/edit/reject signals give chosen/rejected pairs | MEDIUM |

### 3.3 What actually runs on Strix Halo versus GB10 today

**Strix Halo (Ryzen AI Max+ 395, Radeon 8060S, gfx1151, RDNA 3.5).**
- AMD's Ryzen matrix (ROCm 7.0.2) lists gfx1151 with PyTorch 2.8 as official on Ubuntu 24.04.3 (HWE kernel 6.14). ROCm 7.14 (July 2026) adds PyTorch 2.12 but its blog names only the PRO 495/490/485 parts for "full enablement" and says the profiler now supports Strix Halo. AMD now sells a Ryzen AI Halo developer box (Max+ 395, 128 GB) with step-by-step playbooks including LLaMA-Factory LoRA and Unsloth fine-tuning. **MEDIUM**: support is real and improving, but the exact supported ROCm/PyTorch pair moves every few months; pin it in a container.
- Measured community results (single 128 GB node, short sequences of 512 tokens, 2 epochs): Gemma-3 1B full 19 GB / about 3 min; Gemma-3 4B LoRA 30 GB / 5 min, full 46 GB / 9 min; Gemma-3 12B LoRA 67 GB / 13 min, QLoRA 26 GB / 23 min; Gemma-3 27B LoRA out of memory, QLoRA 19 GB runs; GPT-OSS-20B LoRA 32 to 38 GB / about 1 hour. Flash Attention 2 is inference-only; Gemma and Qwen need eager attention to train. **LOW to MEDIUM** (one hobby project, consistent with others).
- A multi-day production run (Qwen3.5-27B, bf16 LoRA rank 128, 448 steps) took about 11 minutes per step, about 4 days, peak about 80 GB. It needed a source-built bitsandbytes, several patches, and hit hard freezes when the GPU memory fraction was set to 0.90 (0.80 was stable), plus allocator thrashing traced to an open ROCm issue. **LOW** (one detailed guide), but it is the best evidence of what 27B to 32B training costs on this chip.
- Real compute: AMD quotes about 60 FP16 TFLOPS peak. One tracker measured 5 BF16 TFLOPS with native early builds and about 37 TFLOPS in a tuned container; there are no FP8 tensor units. Bandwidth is 256 GB/s theoretical, about 212 GB/s measured. **LOW to MEDIUM.**

**NVIDIA GB10 (DGX Spark class).**
- 128 GB unified LPDDR5x, Blackwell GPU with FP8/FP4 tensor cores, ARM64 CPU, CUDA 13. NVIDIA publishes playbooks for Unsloth, LLaMA-Factory, NeMo AutoModel and PyTorch (full SFT of Llama 3.2 3B, LoRA of Llama 3.1 8B, QLoRA of a 70B). **MEDIUM** (vendor).
- NVIDIA's published table: Llama 3.2 3B full fine-tune about 13,500 tokens/s; Llama 3.1 8B LoRA about 7,000 tokens/s; Llama 3.3 70B QLoRA about 760 tokens/s (sequence 2048). The same article's text quotes much higher peaks (82,739 / 53,658 / 5,079), so treat the table as the conservative figure and measure. One write-up notes FP8 kernel errors on some playbooks and recommends BF16 for fine-tuning. **LOW to MEDIUM.**
- 70B QLoRA fits (about 45 to 52 GB); 70B bf16 LoRA does not; plain LoRA tops out around 32B. **MEDIUM** (formula-based, consistent with NVIDIA's choice of QLoRA for 70B).

### 3.4 Hardware feasibility table

Planning workload: **10 million training tokens** (for example 5,000 examples of about 1,000 tokens, 2 epochs). Many narrow specialists need 1 to 3 million, so divide accordingly. Times are my planning estimates from LoRA compute of about 4 x parameters x tokens FLOPs at an assumed sustained 10 to 25 TFLOPS on Strix Halo and 30 to 60 TFLOPS on GB10; QLoRA adds 1.3 to 2 times. Measured anchors are listed where they exist. **All times LOW confidence until Phase A measures them on the real host.**

| Base size | Method | Fits in 128 GB? | Strix Halo estimate (10M tokens) | GB10 estimate (10M tokens) | Measured anchors | Use for |
|-----------|--------|-----------------|----------------------------------|----------------------------|------------------|---------|
| 1B to 2B | LoRA or full | Yes, easily (full about 19 GB for 1B) | 0.5 to 1 h | 10 to 25 min | Gemma-3 1B full in about 3 min (small set) | Classifiers, routers, extractors |
| 3B to 4B | LoRA; full possible | Yes (LoRA about 30 GB, full about 46 GB) | 2 to 4.5 h | 45 to 90 min | Gemma-3 4B LoRA 5 min (small set); NVIDIA 3B full 13.5k tok/s (about 12 min) | **v1 sweet spot** for narrow tasks |
| 7B to 9B | LoRA | Yes | 3.5 to 9 h | 1.5 to 3 h | NVIDIA 8B LoRA 7k tok/s (about 25 min) | Summaries, structured writing, tool calls |
| 12B to 14B | LoRA; QLoRA if long context | Yes (LoRA about 67 GB for 12B at 512 tokens) | 6 to 16 h | 2.5 to 5 h | Gemma-3 12B LoRA 13 min (small set) | **v1 upper bound**; better general reasoning |
| 27B to 32B dense | bf16 LoRA (tight) or QLoRA | LoRA tight (about 80 GB peak at 27B), QLoRA comfortable | 14 to 36 h LoRA; 1 to 3 days QLoRA; one measured run took about 4 days | 6 to 12 h LoRA; 8 to 24 h QLoRA | Qwen3.5-27B LoRA about 4 days on Strix Halo (long sequences, rank 128) | Phase 3 on GB10, not v1 |
| 30B to 35B MoE (about 3B active) | LoRA | Weights about 70 GB in bf16; tight | Compute like a 3B to 4B dense model, but MoE kernels on ROCm are immature | 1 to 3 h | GPT-OSS-20B MoE LoRA about 1 h on Strix Halo | Attractive later (fast inference), risky now |
| 70B dense | QLoRA only | Yes (about 45 to 52 GB) | 2 to 5 days | About 4 h (NVIDIA table) to 1 day | NVIDIA 70B QLoRA 760 tok/s | Not recommended; the specialist idea is small models |

**Serving on the same host** (llama.cpp, measured by others): Qwen3-30B-A3B Q4 about 60 to 75 tokens/s, Qwen3.6-35B-A3B Q4 about 50 tokens/s, Qwen3-32B Q8 about 6.4 tokens/s on Strix Halo. Dense 27B to 32B models are too slow to replace a cloud model interactively on Strix Halo; 4B to 14B dense or small-active MoE specialists are the right shape. **LOW to MEDIUM.**

**Host memory rule.** Unified memory is shared by training, serving, the OS, and (if co-located) code-server and VS Code. Run the trainer under a cgroup memory cap with the PyTorch GPU memory fraction at 0.80 or less, never alongside a large serving model, and schedule training when serving load is low. Exhausting the shared pool freezes the whole machine rather than raising an out-of-memory error. **MEDIUM** (Unsloth installer behaviour plus community reports).

---

## 4. Base models for specialists

| Family | Good specialist sizes | Licence | Commercial fine-tune obligations | Verdict |
|--------|----------------------|---------|----------------------------------|---------|
| **Qwen3.5 / Qwen3.6** (Alibaba) | 0.8B, 2B, 4B, 9B, 27B dense; 35B-A3B MoE | Apache 2.0 for all open-weight models (per Qwen3.6 README and model cards) | Keep licence and NOTICE; check the licence file shipped with each checkpoint | **First choice.** Same family as the extension's current fast-tier default, strong tool use, wide size range. MEDIUM |
| **Gemma 4** (Google) | E2B, E4B, 31B dense, 26B MoE | Apache 2.0 since April 2026 (earlier Gemma used custom terms with a prohibited-use policy Google could change) | Apache terms only; no implied Google endorsement | **Second choice**, especially multimodal. MEDIUM (news sources agree; confirm on the model card) |
| **Phi-4 family** (Microsoft) | Phi-4-mini 3.8B, Phi-4 14B, reasoning variants | MIT | Keep the licence notice | Good small reasoners; fewer sizes. MEDIUM |
| **Mistral** | Mistral Small 4 is 119B total / 6.5B active MoE | Apache 2.0 (Mistral docs) | Apache terms | Too large in memory for v1 training; check smaller Mistral releases case by case. MEDIUM |
| **GLM** (Z.ai) | GLM-4.x small variants; GLM-5 is 744B | MIT | Notice only | Big models are teachers, not students. MEDIUM |
| **DeepSeek R1 distills** | 1.5B to 32B (Qwen-based), 8B and 70B (Llama-based) | Weights MIT, but each distill inherits its base: Qwen-based ones Apache 2.0, Llama-based ones Llama 3.1/3.3 terms | DeepSeek explicitly allows distillation; Llama-based distills carry Llama obligations | Use Qwen-based distills only. MEDIUM |
| **Llama 4 / Llama 3.x** (Meta) | 8B, 70B, Scout/Maverick MoE | Llama Community Licence (not OSI open source) | "Built with Llama" display, "Llama" in derivative names, acceptable use policy, licence request above 700M monthly users, multimodal rights not granted to EU-domiciled companies | **Block by default**; allow only with a recorded legal approval. MEDIUM |

Teacher outputs have terms too. Before distilling from a teacher, record the teacher's licence or service terms in the dataset manifest. Open-weight teachers served by NEAR AI Cloud (DeepSeek, GLM, Qwen) have permissive weights licences; DeepSeek's card explicitly permits distillation. Some proprietary APIs forbid training competing models on their outputs, so a forwarded (non-TEE) frontier model should not be a teacher unless its terms are checked. **MEDIUM.**

---

## 5. Dataset building from enterprise data

### 5.1 Pipeline

1. **Extract** examples for the approved task cluster: for chat and run logs, the input the model saw, the tools it called, its output, and what happened next (accepted, edited, undone, rejected, retried, stalled). The thread store already keeps "what the model saw" beside "what the user typed", which is the right raw material.
2. **Filter by outcome.** Keep accepted or lightly edited outputs as SFT targets; route heavily edited outputs to "use the human's final version as the target"; keep rejected outputs only as the "rejected" side of preference pairs. Curation beats volume (TensorZero and Predibase guidance).
3. **Distil where targets are weak or missing.** A teacher (a TEE model on NEAR AI Cloud, or a large local model) rewrites or generates targets, ideally with short rationales (distilling step-by-step). For organization documents in later phases, generate instruction/answer pairs from documents with distilabel pipelines; Argilla is the human review UI for spot checks. Both Apache 2.0. distilabel's last push was December 2025, so treat it as a library to pin, not a living dependency. **LOW to MEDIUM.**
4. **Scrub PII.** Microsoft Presidio (MIT) for detection and replacement with consistent placeholders, plus organization-specific recognisers (customer ids, account numbers). Scrubbing too aggressively harms utility, so scrub what the label policy requires and rely on the label for the rest. Fine-tuning can raise PII leakage even for PII that appeared only in inputs, so scrubbing is not optional for anything labelled above the lowest level. **MEDIUM.**
5. **Deduplicate.** Exact hash dedup, then near-duplicate removal with MinHash (Hugging Face datatrove or a small MinHash pass). Repeated documents in enterprise data are the norm and dedup is also a memorisation mitigation. **MEDIUM.**
6. **Decontaminate** against the held-out eval set and against the regression suite: n-gram overlap (for example 13-gram) and embedding similarity; drop training rows too close to any eval row. **MEDIUM** (standard practice).
7. **Split** by time and by source, not randomly: the newest 10 to 20 percent of examples (and whole conversations, never halves of one) become the test set, so the eval reflects future traffic and nothing leaks between splits. Keep a frozen "golden" set that a person has reviewed.
8. **Seal and record.** Write a manifest: every source record id and content hash, its label, its data owner, its consent or rights basis, the scrubber and dedup versions, the teacher model and its terms, and the dataset label (the join). Store the dataset sealed with the project's data key like the thread store.

### 5.2 Preference data from user signals

| Signal already in the extension | Becomes |
|---------------------------------|---------|
| File change approved unchanged | Positive SFT example |
| Approved after the person edited it, or edited right after | Chosen = the edited version, rejected = the model's version (DPO pair) |
| Rejected or undone | Rejected side of a pair; or a negative label for a classifier |
| Retried on the backup model after a stall | Weak negative for the first model on that input |
| Role test pass/fail, Compare Models grader result | Verified label (best quality) |
| Star ratings on teams | Too coarse for training; use for prioritising |

KTO is useful when there are only thumbs-up/down signals without pairs; DPO when there are pairs. Both are in TRL. **MEDIUM.**

### 5.3 Label inheritance

- The dataset label is the join of every input record's label, every teacher prompt's label, and the label of any document used for synthetic generation. The gate's join already raises level, unions compartments and handling, and intersects releasability (an empty intersection becomes "releasable to no one", which nothing can read).
- The trained adapter, and the merged model if adapters are merged, take the dataset label. The eval set's label is joined in too, because eval data shapes promotion decisions and can leak through tuning.
- Serving rule: a session may use the specialist only when the session's clearance dominates the model's label. A specialist trained on a compartment is unusable outside it, which is a strong reason to build per-compartment specialists rather than one model from everything.
- The teacher must sit on a route the label allows: local or attested TEE only, matching how the extension already restricts the safety model and backup model to "at least as private" routes.
- Lowering a model's label is a lowering under the gate's existing lowering rules, with a judge and a recorded reason, never a side effect of training.

**HIGH** for the mechanism (code exists), **MEDIUM** for the leakage rationale.

---

## 6. Evaluation and deployment

### 6.1 Evaluation

| Tool | Licence | Role here | Verdict |
|------|---------|-----------|---------|
| Extension's own benchmark (role tasks, graders, Compare Models) | Project | Objective graders the models never see; already ranks models per role with cost, speed, privacy | **Primary** eval; add "specialist versus incumbent on this cluster's held-out set" as a task source |
| lm-evaluation-harness (EleutherAI) | MIT | Regression on general skills (instruction following, reasoning) to catch forgetting | Use in the regression gate, small subsets only |
| promptfoo | MIT (OpenAI acquired the company in March 2026; project says it stays MIT) | Declarative test cases, assertions, red-team probes | Optional; the extension's own graders already cover most of this. Watch governance after the acquisition |
| LLM-as-judge | n/a | For open-ended outputs where no grader exists | Use with calibration: pairwise comparison with order swapped, a rubric, and agreement measured against a small human-labelled set (target at least 80 percent agreement before trusting it). Judge must run on a route the label allows |

### 6.2 Gates before shadow

A specialist is promoted to shadow only if all hold:
- Task score on the held-out test set is at least the incumbent's minus a small tolerance (for example within 2 points out of 100), or better.
- Golden set: no new failures on items the incumbent passed that a person marked critical.
- Regression suite (general skills plus safety prompts and prompt-injection probes): no drop beyond tolerance.
- Memorisation probe: canary strings and sampled PII from training data are not reproduced on extraction prompts.
- Latency and cost on the host are inside the proposal's promised range.

### 6.3 Shadow, canary, live, rollback

- **Shadow:** the incumbent answers; the specialist answers the same request in the background on the host; the judge or grader compares. No user sees the specialist. Cost is host time only.
- **Canary:** a fixed share of that role's or task's traffic goes to the specialist, with the incumbent as the existing backup model. Automatic rollback when edit rate, rejection rate, stalls or grader failures exceed the incumbent's by a set margin.
- **Live:** the role or tier setting points at the specialist. The previous model id is kept as the rollback target and shown on the card.
- **Rollback:** one click (or automatic) rewrites the routing back to the previous model; the specialist stays in the directory as `rolled-back` with the reason.

### 6.4 Serving engines

| Engine | Licence | Strix Halo | GB10 | LoRA | Verdict |
|--------|---------|-----------|------|------|---------|
| **llama.cpp server** | MIT | Yes (ROCm/HIP and Vulkan; HIP faster at long context) | Yes | Adapters loaded at start, per-request `lora` field and `/lora-adapters` endpoint; requests with different adapters are not batched together | **v1 engine** |
| Ollama | MIT | Yes (wraps llama.cpp) | Yes | `ADAPTER` in a Modelfile, one model per adapter | Fine for single specialists; less control |
| **vLLM** | Apache 2.0 | Community builds, "experimental" in AMD's Lemonade; no FP8 on gfx1151 | Yes (in NVIDIA's stack) | Multi-LoRA with runtime load/unload endpoints | **Phase 3 engine on GB10** for many adapters on one base |
| SGLang | Apache 2.0 | Unverified on gfx1151 | Yes | Multi-LoRA | Alternative to vLLM; no reason to pick it first |
| Lemonade (AMD) | Apache 2.0 | Yes, AMD-backed, OpenAI-compatible | No | Via backends | Worth watching for the Strix Halo serving path |

### 6.5 Registering and routing

- The host runs an OpenAI-compatible endpoint. The organization's profile becomes `hybrid` with `localBaseUrl` pointing at it (existing feature). The local client's model list then includes the specialist with `privacyBoundary: 'local'`, `locality: 'local'`.
- The registrar adds metadata the catalogue does not carry today: `specialistOf` (task cluster id), `baseModel`, `baseLicence` and obligations, `label`, `datasetManifestHash`, `version`, `evalReport`, `state` (shadow, canary, live, rolled-back), `previousModel`. Recommendation: keep this as a sealed model card file in the state home, keyed by model id, rather than widening `ModelInfo` beyond display needs.
- Routing by task in v1 is routing by **role** (`nearAi.agent.roleModels`) or by **tier**, which already exist. Routing by finer task (for example "commit message" inside the executor) needs a task tag on requests; the spend tag already carries `kind` and `agentId`, so adding a `task` field is the smallest change.
- When the host is unreachable, the existing backup-model rule (retry on a model at least as private) applies, so a specialist outage degrades to the incumbent rather than failing the run.

---

## 7. The opportunity-watching agent

### 7.1 Signals (cheapest first)

| Signal | Source today | What it reveals |
|--------|-------------|-----------------|
| Calls, tokens, cost per (kind, agentId, role, team, model) | Spend ledger `SpendTag` and entries | Where money goes; narrow roles on deep-tier models |
| Latency per call and per run; stalls and retries | Activity history, run report | Slow tasks, unreliable models |
| Tool sequences per agent | Activity history (tool names, counts) | Repeated mechanical workflows (same tools, same order) |
| Approvals, edits, undo, rejections | Approval service, file change approvals | Where humans keep fixing output (quality gap) |
| Role-test and Compare Models results | Benchmark store | Where a small model already nearly passes |
| Repeated documents and attachments | Attachment reading spend kind; later the data platform's content hashes | The same document family processed again and again |
| Business process events (later) | Connected systems via MCP or the data platform, as event logs | Process steps where a model sits on the critical path |

### 7.2 Detecting candidates

1. **Signature clustering (no content).** Group calls by (team, member role, agentId, spend kind, model, tool-sequence n-gram). A cluster is a candidate when it is frequent (for example at least 200 calls in 30 days), narrow (low variety of tool sequences and output lengths), and stable (present across several weeks).
2. **Content clustering (after approval, or under a standing policy for low labels).** Embed the first user turn and the output with a small local embedding model and cluster within each signature cluster, so "the executor" splits into "writes tests", "writes commit messages", "fixes lint".
3. **Process view (later).** Convert run and tool events to an event log (case = run, activity = tool or step, timestamp) and use process-mining discovery to find frequent variants and bottlenecks. PM4Py does this but is AGPL-3.0 with a separate commercial licence; either keep it in an out-of-process analysis worker with legal sign-off, or implement the few needed algorithms (directly-follows graph, variant counts) in TypeScript. Celonis task mining is the commercial reference for "find automation candidates from desktop and system events", and civil-society research flags its surveillance risk, which applies here too.
4. **Opportunity types:**
   - **Overpowered model:** a narrow cluster served by the deep tier or a frontier model.
   - **Slow step:** a cluster on the critical path of runs with high latency.
   - **Human fix-up:** a cluster with a high edit or rejection rate (a specialist trained on the human's final versions).
   - **Repeated document:** the same document type read and summarised repeatedly (a specialist extractor).
   - **Router opportunity:** a mixed cluster where easy cases could go to a small model and hard ones to the large model (RouteLLM shows over 2 times cost reduction with routers trained on preference data).

### 7.3 Scoring

```
monthly_value   = calls_per_month x (incumbent_cost_per_call - specialist_cost_per_call)
                + latency_saved_per_call x calls_per_month x value_of_a_second   (optional, organization-set)
                + edit_rate_reduction x edits_per_month x minutes_per_edit x cost_per_minute (optional)
specialist_cost = host_energy_and_amortisation_per_call (organization-set, default from host profile)
one_off_cost    = teacher_distillation_cost (NEAR prices) + training_hours x host_hour_cost + review_minutes
feasibility     = min( examples_score, label_score, rights_score, licence_score, hardware_score )
priority        = (monthly_value x 6 - one_off_cost) x feasibility x (1 - risk)
```

Feasibility gates (any zero makes it infeasible, with the reason shown):
- **Examples:** at least about 200 good examples for classification or extraction, about 1,000 for generation, or a teacher that can synthesise them from available inputs.
- **Labels:** an objective grader exists, or a human-labelled golden set of at least 50 items can be made.
- **Label/clearance:** some approver's clearance dominates the projected dataset label; the label's routing allows local or TEE training and teaching.
- **Rights:** every source has a recorded basis for training use (organization data policy, consent where needed), and the teacher's terms allow it.
- **Licence:** a permitted base model exists at a size the host can train in the time budget.
- **Risk:** safety-critical decisions (for example the auto mode's command safety checks) are capped at shadow mode until a person explicitly raises the cap.

### 7.4 The one-click proposal card

Plain language, in the existing card style:

> **Make a specialist for "writing commit messages"**
> Your executor agents wrote 1,240 commit messages in the last 30 days on the deep tier, about $X a month. A 4B model trained on the 1,100 you accepted would run on your own computer, cost about $0 per message, and answer about 3 times faster.
> **Data used:** 1,100 accepted messages from 14 projects. Label: Internal. Personal details are replaced before training.
> **Base model:** Qwen3.5-4B (Apache 2.0). **Training:** about 2 hours on your Strix Halo tonight. **Teacher cost:** none.
> **What happens:** it is tested against your current model on 200 messages it never saw. If it matches, it watches silently for a week, then takes 10 percent of the work. You can undo it at any time.
> [Approve] [Not now] [Never for this task] [Details]

Approve starts everything up to shadow mode under the stated budget. Details shows the clusters, the label computation, the licence obligations, and who else could approve.

### 7.5 Prior art

| Prior art | What it does | What to borrow | Status |
|-----------|-------------|----------------|--------|
| OpenPipe | Captured production LLM calls and turned them into fine-tuning datasets; later RL for agents | Log-to-dataset flow, "replace the expensive prompt with a fine-tune" pitch | Acquired by CoreWeave (September 2025) |
| Predibase (LoRAX, distillation playbook) | Fine-tuning and multi-LoRA serving; published distillation best practices | Many adapters on one base; the 12 best practices for distilling from GPT | Acquired by Rubrik (June 2025) |
| TensorZero | Open-source gateway: inference plus feedback per inference or per episode, "recipes" that fine-tune from curated feedback (Unsloth, Axolotl, torchtune recipes) | Episode-level feedback, curation by outcome metric | Apache 2.0; one directory reports it archived after its June 2026 release (verify) |
| RouteLLM (ICLR 2025) | Routers trained on preference data choose strong or weak model | Router opportunity type | Code open |
| Distilling step-by-step (ACL 2023) | Rationales from a teacher cut data needs by more than half | Ask the teacher for short rationales | Paper and code |
| Agent distillation (NeurIPS 2025) | Distils whole tool-using agent trajectories into 0.5B to 3B models | Train role specialists on full trajectories, not just final answers | Paper and code |
| Celonis task mining | Desktop and system event capture to find automation candidates | Event-log view; consent and visible "capture off" control | Commercial |
| PM4Py | Open-source process mining | Discovery algorithms over run event logs | AGPL-3.0 or commercial licence |

---

## 8. Governance

### 8.1 Who may approve what

| Action | Who | Check |
|--------|-----|-------|
| See a proposal's metadata (counts, cost) | Anyone who can see the team's activity today | Existing visibility |
| See example content in a proposal | People whose clearance dominates the projected dataset label | Gate dominance |
| Approve dataset build and training | A "model owner" role whose clearance dominates the projected label, **and** the data owner of each compartment involved (or a standing delegation recorded per compartment) | Gate dominance plus a signed approval record |
| Approve a teacher on NEAR AI Cloud | As above, plus the label's routing must allow that TEE | Existing privacy routing |
| Promote to canary/live | Model owner, or automatic under an organization policy | Eval report attached |
| Use a specialist in a session | Anyone whose session clearance dominates the model's label | Gate dominance at routing time |
| Lower a model's label | Lowering judge, as for any lowering | Existing lowering rules |
| Approve a Llama-licensed base | Legal or an organization-level setting | Licence registry |

### 8.2 Model card (every specialist)

- Identity: model id, version, created date, state.
- **Label** (scale, level, compartments, releasability, handling), shown on every surface where the model appears, like privacy badges today.
- Lineage: base model id and hash, base licence and obligations, dataset manifest hash, teacher model and its terms, training framework and container digest, hyperparameters, hardware.
- Intended use: the task cluster, the roles it serves, out-of-scope uses.
- Evaluation: test, golden, regression and memorisation results versus the incumbent.
- Approvals: who approved training and promotion, with times.
- Deletion log: requests that touched the dataset and how each was handled.

### 8.3 Deletion requests versus trained weights

- Unlearning research (several 2025 surveys) treats forgetting as a trade-off against utility, verified empirically; there is no practical, provable removal from LLM weights. **MEDIUM.**
- Policy: when a deletion request hits any record in a dataset manifest, every model trained on it moves to `retrain-required` with a deadline; the factory retrains the adapter without the record, re-runs the gates, and swaps it in. If the deadline passes, routing falls back to the incumbent and the old adapter is quarantined.
- Design for it: small adapters per task and per compartment (cheap to retrain), manifests with record-level hashes, and no merging of adapters into shared base weights. Sharded training (one adapter per data shard, combined at inference, as in SISA-style unlearning) is a later option if retraining becomes too slow.

### 8.4 Licence compliance

- A licence registry lists allowed base models with their licence, obligations and approval state. The factory refuses a base not in it.
- Obligations are attached to the model card and surfaced where needed (for example a NOTICE file when weights are exported).
- Teacher terms are recorded per dataset.
- Framework licences: Unsloth core, TRL, PEFT, Axolotl, LLaMA-Factory, vLLM, SGLang, distilabel, Argilla are Apache 2.0; llama.cpp, Ollama, Presidio, lm-eval-harness, promptfoo, MLX are MIT. AGPL components (Unsloth Studio, PM4Py) stay out of anything the organization modifies and offers over a network, unless legal approves.

---

## 9. Phased plan

| Phase | Goal | Scope | Exit criteria | Research flag |
|-------|------|-------|---------------|---------------|
| **A. Host bring-up spike** (about 1 week) | Prove training and serving on the Strix Halo | Pinned container (AMD playbook or Unsloth gfx1151 image); LoRA on Qwen3.5-4B with a public dataset; convert to GGUF; serve with llama.cpp; add as `local` model through a hybrid profile; measure tokens/s, peak memory, stability at memory fraction 0.8 | One adapter trained and answering through the extension; measured numbers replace section 3.4 estimates | **Yes**: ROCm/PyTorch pairing changes monthly |
| **B. First specialist from chat and run logs** (v1) | One specialist end to end, owner's own projects, opt-in | Signal collector over spend ledger and activity; signature clustering; one proposal card; dataset builder over the sealed thread store with Presidio, dedup, time split, label join; LoRA on a 4B to 9B base; eval with existing graders plus a golden set; shadow then canary by role; model card; rollback | A specialist live for one role, at least matching the incumbent on held-out tasks, with lower cost or latency; rollback tested | Moderate: pick the first task with an objective grader (for example an extraction or fetch role, or commit messages), not the safety checker |
| **C. Preference and teacher** | Learn from edits; distil from a TEE teacher | DPO/KTO from approval edits; teacher rewriting through NEAR AI Cloud TEE models; LLM-as-judge with calibration set; content clustering with a local embedding model | Second and third specialists; measured edit-rate drop | Moderate |
| **D. Organization data** | Train on the data platform's discovered, classified data | Synthetic instruction generation from labelled documents (distilabel); per-compartment specialists; clearance-checked approvals by data owners; deletion-triggered retraining | Specialist trained on non-chat data, deletion drill passed | **Yes**: depends on the data platform areas 01 to 03 |
| **E. GB10 and scale** | Faster training, many adapters | GB10 as trainer; vLLM multi-LoRA serving; 14B to 32B bases; MoE students; router specialists | Several specialists served from one base | Moderate |
| **F. Process-level opportunities and TEE serving** | Watch business processes, not just agent runs; serve in attested TEEs | Event-log process view; NEAR AI Cloud custom/private models (Enterprise tier, contact-sales today) | Proposal from a business process; one specialist served from a TEE | **Yes**: NEAR custom-model and fine-tuning availability is unconfirmed |

Ordering rationale: A removes the hardware uncertainty before any product work; B uses only data the extension already has and already protects, so it needs no data-platform work; C needs B's eval harness; D needs the data platform; E needs the second machine; F needs both NEAR's enterprise offering and process connectors.

---

## 10. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| ROCm on gfx1151 regresses or freezes the host mid-run | High | Pinned container per host; memory fraction 0.8; cgroup cap; checkpoint every N steps and resume; keep TRL fallback; prefer GB10 for long runs |
| Training starves serving or the editor on the same unified memory | High | Scheduler: one heavy job at a time, training off-hours, never beside a large serving model; visible queue |
| Specialist leaks labelled data to an under-cleared user | High | Label join, dominance at routing, PII scrubbing, memorisation probe gate, per-compartment specialists |
| Specialist quietly worse on real traffic | Medium | Time-based split, golden set, shadow then canary, automatic rollback on edit or failure rates |
| Teacher terms or base licence forbid the use | Medium | Licence registry, teacher terms in the manifest, Llama blocked by default |
| Opportunity agent feels like surveillance | Medium | Metadata-first, content only after approval, visible "watching" setting per project with an off switch, no per-person productivity scoring |
| Deletion request cannot be honoured in weights | Medium | Retrain-from-manifest with deadline and fallback |
| Value estimates are wrong (host costs, energy) | Low to Medium | Organization-set cost inputs; report realised savings after 30 days on the card |
| Eval judge biased or on a disallowed route | Medium | Calibration set, order swapping, judge restricted to local or TEE |
| Upstream tool churn (distilabel quiet, TensorZero possibly archived, promptfoo ownership change) | Low | Use them as pinned libraries behind our own interfaces; core path depends only on TRL/PEFT, Unsloth core, llama.cpp |

## 11. Open questions

1. Which ROCm and PyTorch versions are officially supported for the Max+ 395 right now? AMD's newest blog names only the PRO parts, and the October 2026 AMD playbook's version strings need checking against the real host.
2. GB10 sustained BF16 training throughput: NVIDIA's article quotes two inconsistent sets of numbers. Phase A on GB10 should measure it.
3. Does NEAR AI Cloud offer fine-tuning or custom-model hosting in a TEE beyond "Enterprise, contact sales"? Its material mentions TEE fine-tuning as a capability, but no documented service was found.
4. Should the first specialist be per project, per team or per organization? Per-compartment labels push towards smaller scopes.
5. Who holds the "model owner" role in an organization without a security team, and what is the default delegation from data owners?
6. Is a standing policy allowed for content clustering on low-label data, or must every content read wait for a proposal approval?
7. Organization cost inputs (energy price, host amortisation) for the value formula: defaults or required setup?
8. LoRA on MoE students (Qwen3.6-35B-A3B) on ROCm: workable or not? Untested here.
9. PM4Py licence: implement the needed process-mining pieces in TypeScript, or buy the commercial licence?

## 12. Sources

Codebase (read directly, HIGH): README sections "Compare Models", "Agent Activity", spend tracking, Team Studio, settings table; source modules for spend ledger (`SpendTag`, `SpendKind`), model roles (tiers and role routing, privacy per role), provider factory (local and hybrid clients), model catalogue (`ModelInfo` with `privacyBoundary` and `locality`), transcripts and thread store (sealed content, model-seen versus user-typed), gate labels and dominance (label shape, join, dominance), benchmark role suite and graders, Team Studio dashboard (Optimise all teams, role tests).

Fine-tuning stack and hardware:
- Unsloth AMD install docs: https://unsloth.ai/docs/get-started/install/amd
- Unsloth AMD official support announcement: https://unsloth.ai/docs/blog/unleash-the-power-of-amd-official-support-for-unsloth-is-here
- AMD article, Train and run models on AMD GPUs with Unsloth: https://www.amd.com/en/developer/resources/technical-articles/2026/train-and-run-models-on-amd-gpus-with-unsloth.html
- Unsloth PR for Strix Halo and Windows ROCm: https://github.com/unslothai/unsloth/pull/5301
- Unsloth on DGX Spark (NVIDIA): https://build.nvidia.com/spark/unsloth
- DGX Spark playbooks: https://github.com/NVIDIA/dgx-spark-playbooks and https://build.nvidia.com/spark
- NVIDIA PyTorch fine-tune playbook: https://build.nvidia.com/spark/pytorch-fine-tune/instructions
- NVIDIA NeMo fine-tune playbook: https://build.nvidia.com/spark/nemo-fine-tune/overview
- NVIDIA blog, DGX Spark performance (fine-tuning table): https://developer.nvidia.com/blog/how-nvidia-dgx-sparks-performance-enables-intensive-ai-tasks
- DGX Spark fine-tuning memory analysis: https://www.spheron.network/blog/dgx-spark-fine-tuning-what-fits-in-128gb-unified-memory-2026/
- DGX Spark playbooks catalog (FP8 caveat): https://dev.classmethod.jp/en/articles/dgx-spark-playbooks-catalog/
- AMD playbook, LLaMA-Factory fine-tuning: https://developer.amd.com/playbooks/llama-factory-finetuning
- AMD Ryzen AI Halo developer platform: https://www.amd.com/en/products/processors/desktops/ryzen/ryzen-ai-halo.html
- CNX Software on Ryzen AI Halo: https://www.cnx-software.com/2026/06/16/4000-amd-ryzen-ai-halo-developer-platform-features-126-tops-ryzen-ai-max-395-processor/
- ROCm Radeon and Ryzen docs: https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest
- ROCm 7.0.2 Ryzen Linux support matrix: https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.0.2/docs/compatibility/compatibilityryz/native_linux/native_linux_compatibility.html
- ROCm 7.14 blog: https://rocm.blogs.amd.com/ecosystems-and-partners/rocm-7.14-blog/README.html
- Ryzen limitations page: https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.2.1/docs/limitations/limitationsryz.html
- Strix Halo fine-tuning toolbox and benchmarks: https://github.com/kyuz0/amd-strix-halo-llm-finetuning
- Strix Halo 27B LoRA guide: https://github.com/h34v3nzc0dex/strix-halo-llm-finetune-guide
- Unsloth Studio on Strix Halo: https://sleepingrobots.com/dreams/unsloth-studio-strix-halo/
- Strix Halo tracker (bandwidth, PyTorch, llama.cpp numbers): https://llm-tracker.info/_TOORG/Strix-Halo
- Axolotl on ROCm (AMD blog): https://rocm.blogs.amd.com/artificial-intelligence/axolotl/README.html
- Axolotl on Ryzen AI Max+ 395 guide: https://fluvial-www.pages.dev/blog/posts/9/
- torchtune README (maintenance notice): https://raw.githubusercontent.com/meta-pytorch/torchtune/main/README.md
- LLaMA-Factory: https://github.com/hiyouga/LlamaFactory
- Unsloth licence split (core Apache, Studio AGPL): https://pypi.org/project/unsloth/2026.3.15/
- LoRA Learns Less and Forgets Less: https://arxiv.org/abs/2405.09673v2
- LoRA Without Regret (Thinking Machines): https://thinkingmachines.ai/blog/lora/ and TRL notes https://huggingface.co/docs/trl/main/en/lora_without_regret

Base models and licences:
- Qwen3.6 repository (Apache 2.0 statement): https://github.com/QwenLM/Qwen3.6
- Qwen3.5 family overview: https://qudata.com/en/news/exploring-qwen35-family/
- Gemma 4 under Apache 2.0: https://venturebeat.com/technology/google-releases-gemma-4-under-apache-2-0-and-that-license-change-may-matter and https://the-decoder.com/googles-gemma-4-is-now-available-with-apache-2-0-licensing-for-the-first-time/
- Llama 4 licence: https://developer.meta.com/ai/llama4/license/ and EU carve-out https://the-decoder.com/meta-releases-first-multimodal-llama-4-models-leaves-eu-out-in-the-cold/
- Mistral Small 4: https://mistral.ai/news/mistral-small-4/ and https://docs.mistral.ai/models/mistral-small-4-0-26-03.md
- Phi-4-reasoning model card (MIT): https://huggingface.co/microsoft/Phi-4-reasoning
- GLM-5 under MIT: https://the-decoder.com/chinese-ai-lab-zhipu-releases-glm-5-under-mit-license-claims-parity-with-top-western-models/
- DeepSeek-R1 card (distill licences, distillation allowed): https://huggingface.co/deepseek-ai/DeepSeek-R1/blob/refs%2Fpr%2F243/README.md and commentary https://simonwillison.net/2025/Jan/20/deepseek-r1

Datasets, privacy, evaluation, serving:
- distilabel: https://github.com/argilla-io/distilabel ; Argilla: https://argilla.io/blog
- Presidio: https://github.com/microsoft/presidio
- datatrove: https://github.com/huggingface/datatrove
- PII leakage after fine-tuning (2026): https://arxiv.org/abs/2601.17480v1
- Analyzing PII leakage in language models: https://arxiv.org/pdf/2302.00539v1.pdf
- Randomized masked fine-tuning against PII memorisation: https://arxiv.org/pdf/2512.03310v2
- Unlearning surveys: https://arxiv.org/html/2503.01854v2 and https://arxiv.org/html/2510.25117v1
- promptfoo acquisition and licence: https://www.promptfoo.dev/blog/tags/company-update/ and https://thenextweb.com/news/openai-acquires-promptfoo-ai-security-frontier
- vLLM LoRA docs: https://docs.vllm.ai/en/stable/features/lora/
- llama.cpp per-request LoRA: https://github.com/ggml-org/llama.cpp/issues/10374 and https://github.com/ggml-org/llama.cpp/issues/10685
- vLLM toolboxes for Strix Halo: https://github.com/kyuz0/amd-strix-halo-vllm-toolboxes
- Lemonade vLLM backend (experimental on gfx1151): https://lemonade-server.ai/docs/guide/configuration/vllm/

Opportunity detection and prior art:
- OpenPipe acquisition by CoreWeave: https://investors.coreweave.com/news/news-details/2025/CoreWeave-to-Acquire-OpenPipe-Leader-in-Reinforcement-Learning/default.aspx
- Predibase acquisition by Rubrik: https://siliconangle.com/2025/06/25/rubrik-acquires-llm-tooling-startup-predibase-reported-100m/
- Predibase distillation playbook: https://github.com/predibase/llm_distillation_playbook
- TensorZero recipes and feedback: https://www.tensorzero.com/docs/recipes and https://www.tensorzero.com/docs/gateway/guides/metrics-feedback
- RouteLLM: https://arxiv.org/abs/2406.18665
- Distilling step-by-step: https://arxiv.org/abs/2305.02301 and https://research.google/blog/distilling-step-by-step-outperforming-larger-language-models-with-less-training-data-and-smaller-model-sizes/
- Agent distillation: https://arxiv.org/abs/2505.17612
- Distilling coding-agent logs into a local model (practitioner): https://tomtunguz.com/distilling-claude-into-local-models/
- Celonis task mining: https://docs.celonis.com/en/task-mining.html and surveillance critique https://crackedlabs.org/en/data-work/publications/processmining-algomanage/
- PM4Py: https://pypi.org/project/pm4py/ and https://github.com/process-intelligence-solutions/pm4py

NEAR AI Cloud:
- NEAR AI Cloud overview and enterprise custom models: https://near.ai/cloud
- TEE infrastructure and fine-tuning mention: https://near.ai/blog/building-next-gen-near-ai-infrastructure-with-tees
- Private ML SDK: https://docs.near.ai/private-ml-sdk

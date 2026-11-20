# Guided setup: viable options, a plain recommendation and local model management

**Status:** design, for planning. Docs only: nothing here is built yet.
**Written:** 2026-11-20, against `origin/main` after the Cohere Model Vault design merged (PR #136).
**Owner request (2026-11-20):** make it simple for people setting up a project to understand the security levels, what each one means, and pick the one that fits; a guided setup recommends the best option from what they say about their work; it goes on to data connections; who people are and what they do takes them to the parts of the product that suit them; only options that really work on that machine are offered; and local AI needs a management interface to choose and install the right local models.
**Agreed shape:** the orchestrator's six-point proposal, accepted by the owner the same day (section 2).
**Fits into:** the Phase 70 gate (labels, clearances, routing, the signed policy bundle), the model provenance design (`.planning/research/model-provenance/DESIGN.md`: passports, use tiers, hosting classes, Western defaults), the Cohere Model Vault design (`.planning/research/cohere-model-vault/DESIGN.md`), the data platform (`.planning/research/data-platform/00-DESIGN.md`, one-click connection) and the L1 appliance (L1a in Phase 85, L1b later).
**Proposed phases:** 32.1 (the guided setup) and 32.2 (the local model manager), after Phase 32 and before Phases 36 and 37; the data-connection step lands with Phase 89 (section 16).
**Conforms to the coherence review (2026-11-20):** the guide is named **Get Started** and is the only setup command (keeps `nearAi.setup`; the ten other setup paths fold in as steps or checklist items, section 12.1); a step registry rule for later phases; a first-run guarantee (never land on a surface with no allowed model; staff offers exercise on fictional data only until an organization approves a model for operational work); Q1 asks the "kind of work"; Q2 names the scale and shows the organization's Confidential level as "Sensitive"; `recommend()` calls `decideRoute`; residency is the gate's `route.residency` rule and the Canada question ships only after Phase 41; one `endpoints[]` list that discovery and setup only propose entries into; Protected B and accredited devices use the one `authorizations[]` record (`protected-b` keyed by endpoint id, `accredited-device` in report mode now); `onboarding` is a policy v2 section named in `requires`, with `personalApprovals` default false; every flow that changes rules writes a proposal into the one policy editor; the record is the hash-chained local audit record, not "signed with the device key"; in shared projects answers, label and mode are project-stream entries; option cards end in the one trust line; staff setup's "where" question and discovery `locality` are removed; local servers sit behind `ModelEndpoint` and `LocalServerAdmin`; the guide and model manager use the webview kit; user copy follows the glossary (no "tier", "profile", "role" for setup, "Team Mode"). See `.planning/research/coherence/REVIEW.md` and its companion files.

## 1. Key points first

0. **One front door: Get Started.** "NEAR AI: Get Started" (command id `nearAi.setup`) is the only setup command. Every other setup path becomes a step the guide runs or an item on the checklist it leaves behind; old command ids stay as hidden aliases for two minor releases (section 12.1). Later phases add steps to it, never new setup commands.
1. **Ask about the work, never about security jargon.** Four short questions, one per screen: what kind of work you will do; what the work touches (in plain words: personal information, documents marked Protected A or B or classified, a client's information under a contract with a security clause); whether it must stay in Canada; and, only when it matters, one follow-up. Every question has "Not sure", and "Not sure" is treated as the stricter answer, said out loud.
2. **The guide is a front door to the gate, not a second gate.** Answers become a project label (for example `ca-protected/Protected B`), and the routing table in your organization's signed policy decides where that label may go, exactly as it does for every request today. The guide has no security table of its own, so it can never disagree with what the gate will later enforce.
3. **Only viable options appear.** An option is offered only when it is detected, configured, allowed by the policy and has just answered a test request. Local AI is offered only when a server on this machine, or one on your network that your organization names, announces or finds by a confirmed scan of the ranges its policy lists and then approves, answers with a model that has a passport. A server found on the network is never sent anything but a signature request until it is approved and its certificate pinned. Anything that fails is listed apart under "Not available here", with the reason and how to enable it, and can never be picked.
4. **One recommendation, with a one-sentence reason.** Each option card says, in plain words, where your text goes, who could see it, what is proven, what is not proven, the cost and the expected speed. Options your answers rule out stay visible but greyed, with the reason, and cannot be chosen.
5. **Your organization's policy wins.** The guide recommends only inside what the policy allows. When your answers need something the policy does not allow, it says so and names who to ask (from the policy, or "your organization's security officer"); it never offers to edit the policy, lower a label or use another route. When a step (adding a vault, approving a found server, adopting the Western defaults) would change the rules, it writes a **proposal** into the one policy editor instead (section 9.2).
6. **Protected B, said correctly.** Protected B in a cloud service needs a provider assessed against the CCCS Medium cloud control profile through ITSM.50.100, plus your organization's own security assessment and authorization; a contractor also needs written IT approval from the Contract Security Program before processing a client's Protected information on its own systems. The guide states this, keeps Protected B local by default (today's routing), and offers a hosted option for Protected B only when your organization's policy holds an `authorizations[]` record of kind `protected-b` for that endpoint, signed by a named person (shown as "self-signed on this computer" until the organization layer exists). Classified work and Protected C get no recommendation at all: the guide stops and points to your security officer (section 4.4).
7. **A local model manager.** On the appliance (AMD Strix Halo first, NVIDIA GB10 next) and on any capable computer, one page shows what this machine can run (memory and speed estimates per model and quantization, replaced by measured numbers after a short benchmark), recommends Western models per role from the passports (Nemotron 3 Nano and Super, gpt-oss-20b and 120b, Command A+ where licensed; PRC-origin models only in the T0 research lane), installs, updates and removes them with verified file hashes and shown licences, picks the local server, and assigns models to jobs ("Models by job": fast, standard and deep, plus embeddings). Each local server is reached through a `ModelEndpoint` adapter and managed through `LocalServerAdmin` (ADR-005, ADR-006).
8. **Then data, then the right place to work.** With the data platform, the guide offers the matching one-click connections (Microsoft 365, Google Workspace, file shares) from the same answers, inventory-only first. Then each kind of work lands where it works: staff officers in the Staff Room with their section's team, developers in chat with the project team, analysts in the data views. The guide never lands a person on a surface with no allowed model (section 10).
9. **Re-runnable and recorded.** "Change setup answers" opens the guide pre-filled and shows a plain list of what would change before anything changes. Answers, the options shown, the recommendation, the choice and any reason are written to the gate's local audit record (hash-chained, with signed heads once those land). In a shared project the answers, the label and the mode are project-stream entries on the replica.
10. **Build order.** Phase 32.1 (guide, viability, recommendation, landing, re-run and record) and Phase 32.2 (local model manager) after Phase 32 and Phase 41 (the organization policy foundation: policy v2, `endpoints[]`, `authorizations[]`, `route.residency`, `decideRoute`, the mode table and `term()`, `ModelEndpoint`, the policy editor shell) and before Phases 36 and 37, so the guide becomes the front door that later offers NEAR AI, local, Cohere Standard and Cohere Encrypted. The data-connection step lands with the data platform (Phase 89, extended by 90 and 91).

## 2. The request and the agreed shape

| # | Agreed point (owner, 2026-11-20) | Where in this design |
|---|---|---|
| 1 | Ask about the work, not security jargon: role (now "kind of work") and plain data questions | Section 4 |
| 2 | A recommendation with a one-sentence reason; each option in plain words (where data goes, who could see it, what is proven and not, cost); ruled-out options greyed with the reason; only viable options appear | Sections 5, 6, 8 |
| 3 | The signed policy wins; when answers need something it does not allow, say who to ask, never a workaround | Section 9 |
| 4 | Then data connections from the same answers | Section 11 |
| 5 | Then each role (now "kind of work") lands where it works | Section 10 |
| 6 | Re-runnable with a preview of changes; answers recorded for audit | Section 8.4, 8.5 |
| New | Viability: detect local AI hardware and servers, NEAR AI key and reachability, Cohere vaults; viable only when a test request succeeds | Section 6 |
| New | Local model management interface | Section 7 |
| Order | After Phase 32, before Phases 36 and 37; the data step with the data platform | Section 16 (now also after Phase 41) |
| Coherence (2026-11-20) | One front door, one policy editor, one endpoint list, one exception record, one trust line, the glossary | Sections 1, 5, 6, 9, 10, 12 |

## 3. What exists today

Verified on `origin/main`.

- **First Project page** (`src/services/onboarding.ts`): a static webview with six numbered cards (get oriented, connect privately with a NEAR AI key, choose your team, guardrails, describe the idea, keep momentum). It asks nothing about the data.
- **Setup steps** (`src/services/setupSteps.ts`): a list (`PROJECT_TEAM_STEP`, `SPENDING_LIMIT_STEP`, `WEB_SEARCH_STEP`) that features extend with `registerSetupStep` and `registerSetupFacts`; `buildSetupMenu` shows undone steps first with the first one marked recommended; a dismissible setup nudge. Commands `nearAi.setup`, `nearAi.projectSetup`, `nearAi.setupProjectTeam`.
- **Project discovery** (`src/services/projectInitialization.ts`): five questions including `locality`, "Where may inference run?" with `cloud`, `local` or `hybrid`, and `riskLevel` low, medium or high. These are jargon-first and independent of labels.
- **Providers** (`src/domain/auth.ts`, `src/services/providerFactory.ts`): `near-ai`, `local`, `hybrid`, and since the Cohere design, vault endpoints are planned (Phase 36). The local runtime is "any OpenAI-compatible server", entered by URL with `http://localhost:11434/v1` as the suggestion. Nothing detects hardware, finds a running server or checks which models it serves.
- **Privacy mode** (`nearAi.privacyMode`): `standard` or `tee-only`.
- **Gate** (`src/domain/gate/**`): four label scales (`org`, `ca-protected`, `ca-classified`, `nato`), clearances, a routing table with tiers `any-cloud`, `attested-cloud`, `local-only`, `deny` (shipped: `org/Public` any cloud; Internal, Confidential, Protected A and NATO Unclassified attested; Protected B, Protected C, every classified level and NATO Restricted and above local only), `localHosts` for named organization servers, the signed bundle with strict key checks, decision records shaped after OCSF, and the trust badge.
- **Staff setup** (`src/services/staffSetup.ts`, `staffSetupCommand.ts`) and **Open Staff Room** (`nearAi.openStaffRoom`).
- **Planned, not built:** passports and use tiers (74.1), `org-tee` (74.2), Cohere vaults (36, 37), the L1a host and local inference on Strix Halo (85), the data platform connectors (89 to 91) and data views (96, 97).

The gap the owner names is real: today a person must already know what "TEE", "hybrid" and "local-only" mean, may be offered a local runtime that does not exist, and is not told what Protected B requires.

## 4. The questions

### 4.1 Principles

- One question per screen, the question as the page heading, a Back link, "Skip for now" where the answer is optional, and earlier answers pre-filled on a re-run (GOV.UK question pages; WCAG 2.2 3.3.7 Redundant Entry).
- Every answer has a visible effect on the next screen, so nobody clicks through blindly (the Notion lesson in section 18).
- "Not sure" is always offered and always maps to the stricter reading, with a sentence saying so and how to find out (look at the document's marking, ask the security officer).
- Answers are about **this project**, except the kind of work, which is about **you** and is remembered across projects.
- Every page uses the webview kit (one CSP, typed messages) and the house accessibility standard (section 13, `EXPERIENCE.md` section 7).
- The guide never asks for a classification decision. It asks what the information is and applies the label your organization's policy maps it to. The person and your organization remain responsible for categorization (TBS Standard on Security Categorization: the information owner categorizes).

### 4.2 The question set

> **Coherence review (2026-11-20):** Q1 asks the "kind of work" (the word "role" is kept for positions). Wherever Q2 lists levels it names the scale ("Canada, Classified: Confidential"), because `org/Confidential` and `ca-classified/Confidential` route differently. Setup's "must stay in Canada" is enforced by the gate's `route.residency` rule from Phase 41, so R3 is no longer a setup-only filter, and the mode table and `term()` are built in Phase 41 and read here. See `.planning/research/coherence/REVIEW.md`.

| # | Screen heading | Choices | Shown when |
|---|---|---|---|
| Q1 | What kind of work will you mostly do here? | Write or review software; Staff work in a headquarters section (then: J1 to J9, or "a joint staff team"); Analyse information and data; Plan or manage capital projects; Write and research documents; Something else (free text, 60 characters) | Always; remembered for you |
| Q2 | What will this project's work touch? (tick all that apply) | Only public or published information; Your organization's internal work; Personal information about people (names with HR, health, pay, security or other details); Documents marked Protected A; Documents marked Protected B; Documents marked Protected C; Classified documents (Canada, Classified: Confidential, Secret or Top Secret) or NATO Restricted and above; A client's information under a contract with a security clause; Not sure | Always |
| Q2a | Is any of the personal information sensitive: medical, personnel files, finances, security screening, or about children? | Yes; No; Not sure | Personal information ticked |
| Q2b | What level does the contract's security requirements check list name for the client's information? Has your organization received written IT approval from the Contract Security Program for this contract? | Level: Protected A; Protected B; Classified; Not sure. Approval: Yes; No; Not sure | Contract ticked |
| Q3 | Must the work stay in Canada, including where the AI runs? | Yes; No; Not sure | Always, once Phase 41's `route.residency` rule exists (never before, REVIEW K10); pre-set to Yes and locked when the policy's `residency.required` or `onboarding.locked` says so (section 9.3) |
| Q4 | Will agents edit files, run commands or work while you are away? | Yes, that is the point; Only answer my questions; Not sure | Pre-answered from Q1 (software: Yes; analysis and writing: Only answer); shown on the check-answers page, changeable |

Q4 feeds the use of the model provenance design (T1 "chat you review", T2 "agent work"; the T codes stay internal and screens use the plain use words), so the recommendation can rule out a model whose approval does not cover the work.

Display rule for Q2 and every later screen: a level is always shown as scale name plus level, and the `org` scale's Confidential level is shown as **"Organization: Sensitive"** (its id stays `org/Confidential`; owner decision Q8). The Q2 choice "Your organization's internal work" maps to "Organization: Internal".

### 4.3 How answers map to a label

The answers produce a **proposed project label** on a scale your policy enables, then the policy's routing table produces the tier. Strictest wins, as in `tierForMark`.

| Answer | Proposed label (ca scales enabled) | Proposed label (only `org` scale enabled) | Why |
|---|---|---|---|
| Only public | `org/Public` | `org/Public` | |
| Internal work | `org/Internal` | `org/Internal` | |
| Personal information, not sensitive | `ca-protected/Protected A` | `org/Confidential` | Protected A is "limited or moderate injury" outside the national interest; personal information is the common case (TBS, PSPC "Levels of security") |
| Personal information, sensitive (Q2a Yes or Not sure) | `ca-protected/Protected B` | `org/Restricted` | Protected B examples include personnel and medical records |
| Protected A | `ca-protected/Protected A` | not offered without the scale | |
| Protected B | `ca-protected/Protected B` | not offered without the scale | |
| Protected C | `ca-protected/Protected C` | not offered | Stop (4.4) |
| Classified or NATO Restricted and above | the matching level | not offered | Stop (4.4) |
| Contract with a security clause | the level from Q2b, at least `ca-protected/Protected A`; Not sure counts as Protected B | as above on `org` | Contract security (4.5) |
| Not sure (Q2) | `ca-protected/Protected B`, with the sentence "We treat this as Protected B until you know. Check the marking on the documents, or ask {contact}." | `org/Restricted` | Strictest level the tool can serve; open decision D2 |

The label is applied with the existing **Set Label** machinery at project level and only ever **raises** a label already there. On a single-machine project that is today's per-install signed label map; in a shared project the project label is a project-stream entry on the replica, so every member reads the same label (REVIEW K23). Ids in this table are internal; screens show "Organization: Sensitive" for `org/Confidential` and scale name plus level for the rest. A label already on the project that is higher than the answers suggest is kept and shown ("This project is already labelled Protected B; the guide does not lower labels").

### 4.4 Where the guide stops

- **Protected C, every classified level, NATO Restricted and above.** The guide applies the label (so the gate's `local-only` rule and clearance checks apply at once) and makes **no recommendation**. It says: "Classified and Protected C information may be processed only on systems accredited for that level. This guide cannot tell whether this computer is one. Ask {contact} before you continue." No hosted option is ever shown for these, even greyed. Open decision D3 covers a policy flag that records a device as accredited.

> **Coherence review (2026-11-20):** a device accredited for a level is recorded as one `authorizations[]` record of kind `accredited-device` (subject: the device), not a separate `accreditedDevices` list. The gate already sends classified content only to loopback; until the organization layer exists it warns once per chat and records `route.not-accredited` when no such record exists (safety patch S2), and it refuses once the organization layer exists (owner decision Q6). The guide's stop stays as written: even with an `accredited-device` record, the guide makes no recommendation for classified work; it only notes that this device is recorded as accredited and by whom.
- **Contract work without approval** (Q2b approval No or Not sure): "Before processing your client's Protected information on your own computers, your organization needs written IT approval from the Contract Security Program for this contract. For a cloud service, your client department must approve it. Ask your company security officer." The guide records the answers and offers only Public and Internal work until the approval answer changes.

### 4.5 What the guide tells people about Protected B (copy for the "What does this mean?" disclosure)

> Protected B information can cause serious injury to a person, an organization or the government if disclosed. A cloud service may hold it only when the provider has been assessed against the Canadian Centre for Cyber Security's Medium cloud profile and your organization has done its own security assessment and authorized the service. Contractors also need written IT approval from the Contract Security Program before processing a client's Protected information on their own systems. Your organization's rules here keep Protected B on machines it controls unless they record such an authorization.

## 5. From answers to a recommendation

### 5.1 The pipeline

```
answers --> proposed label + use + residency + kind-of-work needs
policy  --> labels.routing, endpoints[] (class, region, maxLabel), authorizations[], residency, models (passports)
viability (section 6) --> which endpoints and models answer right now
                 |
          recommend() (pure)
                 |
   options: recommended | available | ruled-out(reason) ; not-viable list apart
```

`recommend()` is a pure function in `src/domain/setupGuide/recommend.ts` (no I/O, no clock), tested row by row. It calls the same `decideRoute` and, when Phase 74.1 is on, `decideModelUse` that the gate uses per request, with synthetic facts, so a recommended option is one the gate will accept.

> **Coherence review (2026-11-20):** `decideRoute(label, use, endpoint, authorizations, residency, passport, clearance)` from Phase 41 is the one decision function (`POLICY-SCHEMA.md`, section 6). `recommend()` adds no rule of its own about where a label may go: R2, R3, R4 and R9 below are read from `decideRoute`'s answer and its refusal sentence, and R1, R5 to R8 only rank and explain. Each option's outcome is also a `TrustFacts` record, so the card ends in the same trust line people later see on every answer (section 8.2).

### 5.2 The options

| Option ("Runs on" words) | Endpoint class | Viable when (section 6) |
|---|---|---|
| This computer | `local` | A local server on loopback answers a test request with a passported model |
| Your organization's server | `org-plain` entry in `endpoints[]` | The policy lists the endpoint, or it was found on your network (section 6.4.1) and an approved proposal added it with its certificate pinned, and it answers a test request |
| Your organization's attested hosting | `org-tee` entry in `endpoints[]` (Phase 74.2) | Listed with an attestation spec, attestation verified, test request answered |
| NEAR AI private hardware | `nearai-tee` | Key present, endpoint reachable, the fresh bound-connection check passed, test request answered by a model on private hardware |
| NEAR AI Cloud, all models | `nearai-tee` plus `forwarded` | As above, and the personal floor "Only verified private hardware or this computer" is off |
| Cohere vault in {region} (Encrypted) | `vendor-tee` entry in `endpoints[]` (Phase 37) | Configured, `Ready`, proxy running from the pinned digest, attestation verified, listed in the policy |
| Cohere vault in {region} (Standard) | `vendor-region` entry in `endpoints[]` (Phase 36) | Configured, `Ready`, test request answered, listed in the policy; a new Standard vault defaults to `maxLabel org/Public` (owner decision Q5) |

> **Superseded 2026-11-20 (coherence review):** this table first named `routing.localHosts`, `routing.attestedHosts`, `routing.vaults` and `privacyMode`. Those become entries of one `endpoints[]` list (`POLICY-SCHEMA.md`, section 5) and a personal floor inside `decideRoute`; the options and their viability tests are unchanged.

Options are a **mix**, not one endpoint: the recommendation is a setup such as "Local models for everything" or "NEAR AI private hardware, with this computer for anything marked Protected B". Each request is still routed on its own by the gate.

### 5.3 Rules

| # | Rule |
|---|---|
| R1 | An option is a candidate only if it is viable (section 6) and the policy allows its hosting class for at least one label in the project. |
| R2 | An option that cannot serve the proposed label is **ruled out** (greyed) with the gate's own refusal sentence, for example "Your organization sends Protected B only to machines it controls." |
| R3 | Residency: Q3 Yes (or Not sure) rules out any option whose location is not Canada or is not stated: NEAR AI Cloud (no Canadian region is stated today), US or EU vaults. `local`, `org-plain` and `org-tee` count as Canada only when the endpoint's `region` is `CA` in the policy (a contractual fact, never inferred from attestation). Processing counts, not just storage: the Directive on Service and Digital 4.4.3.14 speaks of computing facilities. From Phase 41 this is the gate's `route.residency` rule applied to every request, and the guide only reads it; a "Yes" answer on a personal policy becomes a proposal to set `residency.required: "CA"` (section 9.2), so no later choice can undo it. |
| R4 | Use: with Q4 Yes (agent work, T2), an option whose only allowed models lack a T2 approval is ruled out ("No model your organization allows for agent work is available here"), which is the model provenance empty state. |
| R5 | Fit for the kind of work: an option whose best viable model is below the minimum for that work (section 7.5: for example agent coding needs a standard model that passes the tool-calling test) stays available but is not recommended, with "Smaller local models: slower and weaker on long agent runs." |
| R6 | Order among the rest: `local` and named organization servers, then attested (`org-tee`, `nearai-tee`, `vendor-tee`), then `vendor-region`, then forwarded models. Your organization's policy may reorder (the Cohere design's preference order). |
| R7 | The recommendation is the smallest mix that covers every label in the project with the highest-ordered option for each, and its reason is one sentence built from the deciding fact: "Recommended: this computer, because the work includes Protected B, which your organization keeps on machines it controls." |
| R8 | With no candidate for a needed label, there is no recommendation for that label: the card says what is missing and who to ask (section 9), plus how to make an option viable (section 6.6). |
| R9 | Protected B reaches a hosted option only if the policy carries a valid `authorizations[]` record of kind `protected-b` whose subject is that endpoint's id (one record shape for NEAR AI, `org-tee` and Cohere vaults; Cohere design 6.3). The card then names it in the trust line's Allowed part: "Allowed for Canada, Protected: Protected B by {name}'s authorization {ref} until {date}", plus "(self-signed on this computer)" while the organization layer does not exist. |

> **Superseded 2026-11-20 (coherence review):** R9 first reused the Cohere authorization record, which had only a `vault` field. It is now the one authorization record keyed by endpoint id (`POLICY-SCHEMA.md`, section 2, and REVIEW K4).

### 5.4 Examples

| Person and answers | Viable here | Recommendation and reason |
|---|---|---|
| Developer, internal code only, Canada No | Local (gpt-oss-20b), NEAR AI | NEAR AI private hardware, local for quick tasks. "Internal work may go to attested private hardware; NEAR AI runs larger models than this computer can." |
| Developer, internal code, Canada Yes | Local (gpt-oss-120b on the appliance), NEAR AI | This computer. "Your work must stay in Canada, and NEAR AI Cloud does not promise a Canadian location." NEAR greyed with that reason. |
| Staff officer J2, exercise data, Protected A | Local, NEAR AI | NEAR AI private hardware or local, per the order your organization set (local first by default). |
| Analyst, sensitive personal information | Local, NEAR AI, Cohere Standard (CA) | This computer. NEAR and the vault greyed: "Protected B stays on machines your organization controls unless your organization records an authorization for a service." |
| Analyst, sensitive personal information, laptop with no local AI | NEAR AI | No recommendation for Protected B. "No option here can hold Protected B. Ask {contact}, or set up local AI on a machine that can run it." Local appears under "Not available here" with the hardware reason. |
| Contractor, client Protected B, no CSP approval | anything | Stop (4.4): only Public and Internal work until approval is recorded. |
| Anyone, Secret | anything | Stop (4.4). |

> **Coherence review (2026-11-20):** the staff row holds only for exercise work. A staff project needs operational use (T3), and no shipped model approval reaches T3; the private models NEAR AI offers today come from developers in the People's Republic of China, which the Western defaults allow only for research. So until your organization approves a model for operational work, the staff step offers "Exercise on fictional data" only, says why on the options screen, and records the exercise flag as a signed project-layer attribute (REVIEW K7, K15, K30; section 10).

## 6. Viability: offer only what works

### 6.1 The rule

An option is **viable** when all four hold, checked in this order and stopped at the first failure:

1. **Detected:** the hardware, server or endpoint exists and is reachable.
2. **Configured:** the key, URL or vault entry is present.
3. **Allowed:** the signed policy allows its endpoint class and, for anything but this computer and NEAR AI, lists it in `endpoints[]` (first written as "names it in `localHosts`, `attestedHosts` or `routing.vaults`"; superseded 2026-11-20 by the one endpoint list).
4. **Answered:** a test request succeeded within the last 10 minutes (section 6.5).

Each check gives a plain reason and a fix. A result is kept with its time and goes **stale** after 10 minutes, on a network change, when a server stops answering, or when the policy changes.

### 6.2 Which machine

Detection runs where the extension host runs. On a desktop that is this computer; in code-server, a remote SSH session or a dev container it is that server or container, and the guide says so by name ("Checked on: {hostname}, a container"). A GPU on the host is invisible in a container without device passthrough; a server on the host is not on the container's loopback, so it counts only when the policy lists it in `endpoints[]` (today's `localHosts` rule, carried into the endpoint list by Phase 41's migration).

### 6.3 Local AI hardware

Detection reads files and fixed tools only, never with a shell, each with a 3-second timeout and a 64 KB output cap, from a fixed working directory outside the workspace.

| Platform | How | Notes |
|---|---|---|
| Linux, any | `/proc/meminfo` (MemTotal, MemAvailable), `/proc/cpuinfo` model name, `os.totalmem()` | |
| AMD GPU or APU (Linux) | `/sys/class/drm/card*/device/vendor` (0x1002), `mem_info_vram_total`, `mem_info_gtt_total`; `/sys/class/kfd/kfd/topology/nodes/*/properties` for the `gfx_target_version` | Strix Halo: CPU name "Ryzen AI Max", gfx1151, a small VRAM carve-out and a large GTT. The GPU-usable memory is GTT plus VRAM, not VRAM alone; a GTT far below RAM gets the fix "raise the GPU memory limit (`ttm.pages_limit`)" with AMD's documented steps |
| NVIDIA discrete (Linux, Windows) | `nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version --format=csv,noheader,nounits` | Resolved from known install paths first, PATH last, and the path shown |
| NVIDIA GB10 (DGX Spark class) | `nvidia-smi` name contains "GB10"; memory reads "Not Supported" on the integrated GPU, so use `/proc/meminfo` and treat the device as unified memory | Documented NVIDIA known issue |
| Apple silicon | `sysctl -n hw.memsize machdep.cpu.brand_string`; GPU-usable memory estimated as about 75 percent of RAM (Metal's recommended working set), marked as an estimate | |
| Windows | `Get-CimInstance Win32_VideoController` through PowerShell with fixed arguments; `nvidia-smi` for NVIDIA | Windows' `AdapterRAM` is capped at 4 GB for many cards, so AMD and Intel numbers on Windows are labelled "could not be measured" and the benchmark decides |
| NPU (Ryzen AI, Intel, Apple) | Recorded when found (driver present), not used for the estimate until a supported server reports it | Lemonade reports its NPU backends itself |

The result is a **device class**: `unified` (Strix Halo, GB10, Apple), `discrete` (VRAM plus system RAM for offload), or `cpu-only`. Unified memory is first class, because `nvidia-smi` and ROCm tools do not give a dependable memory figure there (the llmfit gap, section 18).

### 6.4 Local servers

The guide always probes **loopback** (127.0.0.1 and ::1) on the known ports and the endpoints the policy lists in `endpoints[]`. Model servers will often run on another machine (an appliance, a GPU server in a rack, a colleague's workstation), so the guide also **finds servers on your network**, under the rules in section 6.4.1. Each server is identified by its signature endpoint before it is trusted to be what it says, and a server found on the network is a **candidate**, never used, until it is approved.

#### 6.4.1 Finding servers on your network (owner, 2026-11-20)

The owner expects local model servers, and later data sources, to sit on other machines more often than on the client. Discovery therefore covers the network, in three ways, from least to most intrusive. All three are set in the signed policy's `onboarding.discovery` section, so your organization decides what the extension may do on its networks.

| Way | What it does | Default |
|---|---|---|
| Named | Endpoints listed in `endpoints[]` (first written as `routing.localHosts` or `onboarding.discovery.hosts`; superseded 2026-11-20, there is one endpoint list) | On |
| Announced | Listens for servers that announce themselves: DNS-SD/mDNS service records (`_near-ai-models._tcp` for our appliance and any server your organization tags; known types such as Ollama behind a published record) and DNS SRV records in a domain the policy names. Nothing is sent to hosts that did not announce. | On, on networks the policy lists |
| Scanned | Actively probes the known model-server ports on the address ranges (CIDRs) the policy lists, and only those | Off; the policy must list ranges, and the person confirms each scan |

Rules for scanning:
- **Only listed ranges, only on a listed network.** The policy names ranges and, optionally, the networks they belong to (by gateway or DNS suffix). If the computer is on a network the policy does not list (a hotel, a home network), scanning is off and the guide says why.
- **Known ports only, slowly.** Only the model-server ports in section 6.4 (and the data-source ports in section 11 once that step exists), at most 50 hosts a second, one connection per port, no payloads beyond the signature request.
- **Asked first, and told.** Each scan says which ranges and ports it will touch and that "your network team may see this as a scan", and runs only when the person confirms. Each scan is recorded (who, when, ranges, ports, what was found) beside the gate's records.
- **From where it runs.** In code-server the scan runs from the server or container, which may sit on a different network; the guide names the machine, as in section 6.2.

Found is not trusted:
- **A candidate gets only the signature request and, after approval, the fixed one-word test request (section 6.5).** No project data, no prompt text and no key is ever sent to a candidate.
- **Approval** is an administrator act: "Approve" writes a **proposal** for one `endpoints[]` entry (exact host, kind and version as a note, `scheme: https`, `tlsPin` with the certificate's SPKI hash, `region`, a `maxLabel`) into the one policy editor, where the administrator applies it to the organization layer. Personal approvals exist only when `onboarding.discovery.personalApprovals` is true (default false); then the person applies the proposal to their personal layer and the entry is capped at `maxLabel org/Public`. Until then it is listed under "Found on your network, not approved" with "Ask {contact} to approve it". (First written as "written into the signed policy (`routing.localHosts` or `org-plain` hosts) ... where the policy allows personal approvals"; superseded 2026-11-20, REVIEW K12 and K32.)
- **Encryption on the wire.** A server on another machine is reached over TLS with the pinned certificate. A plain-HTTP server on another machine is offered only for labels the policy allows on that network segment (default: Public only), because prompts would cross the network unencrypted. Loopback stays as today. From the safety patch (S1), Protected B and above never go to a non-loopback host matched by a wildcard or over plain HTTP, and Protected C and classified never leave this computer.
- **Endpoint class.** An approved server on another machine is `org-plain` (your organization's hardware, not attested) unless its entry carries an attestation spec and attestation is verified (`org-tee`). Its label ceiling is the entry's `maxLabel`. People see the class only as the "Runs on" words: "your organization's server".

| Server | Ports probed | Identify by | Models it serves | Can install models |
|---|---|---|---|---|
| Ollama | 11434 | `GET /api/version` | `GET /api/tags` (name, sha256 digest, size, family, parameter size, quantization), loaded: `GET /api/ps` | Yes (`/api/pull`, `/api/delete`) |
| llama.cpp `llama-server` | 9931 (current default), 8080 (older and Docker) | `GET /props` (build info, `model_path`) and `GET /health` | `GET /v1/models` (with `meta`); router mode serves a models folder | Yes, by placing a verified GGUF in its models folder (router mode) |
| Lemonade (AMD) | 13305 (current), 8000 (older) | `GET /api/v1/models` shape and its docs path | `GET /v1/models`; `lemonade backends` lists ROCm, Vulkan, NPU | Yes, through its own pull |
| LM Studio | 1234 | `GET /api/v1/models` (quantization, size, context) | same | Through the `lms` CLI when present; otherwise list only |
| vLLM | 8000 | `GET /version` and `/health` | `GET /v1/models` | No (one model per server, set at start); list only |
| NVIDIA NIM | 8000 | `GET /v1/health/ready`, `/v1/metadata` | `GET /v1/models` | No (one container per model); list only |
| LocalAI | 8080 | `GET /readyz` | `GET /v1/models` | List only in this design |
| Jan | 1337 | `GET /v1/models` with its key | same | List only |
| Any other OpenAI-compatible server | the URL a person enters | `GET /v1/models` | same | List only |

A server found but serving no model with a passport is "found, no allowed model", with the fix "Install a recommended model" (section 7). A model with no passport is usable only in the research workspace (the T0 lane), as the model provenance design says.

Each row is one adapter behind the provider interface from Phase 41: a `ModelEndpoint` (chat stream, list models, endpoint facts: endpoint id, class, region) for every server, and a `LocalServerAdmin` (install, list, delete, verify hash) for the servers that can install. The guide, the model manager and the chat all use the same adapter; none of them reaches into `NearAiClient` (ADR-005, ADR-006).

### 6.5 The test request

- **Local and organization servers:** for each model assigned to a job, one chat completion with the fixed text "Reply with the single word OK.", `max_tokens` 8, temperature 0, a 60-second timeout (a cold model load can take that long); for the standard and deep models, a second request with one trivial tool definition checks tool calling; for embeddings, one embedding of the word "test" checks the vector length. No project data is ever sent.
- **NEAR AI:** `GET /v1/models` with the key, the attestation check the extension already runs (`src/services/attestation.ts`) for one model on private hardware, then the same one-word completion on that model. It costs a fraction of a cent, counted in the spend ledger like any request (open decision D4).
- **Cohere vaults (Phases 36 and 37):** the vault readiness check of the Cohere design (9.2), which for an Encrypted vault proves the attestation.
- A test request goes through the outbound check like any other request, so Emergency stop, the spend limit and "Only verified private hardware or this computer" apply.

### 6.6 What a person sees for an option that is not viable

Listed under a collapsed **Not available here** heading, never as a choice:

| Reason | Sentence and fix |
|---|---|
| No local AI hardware | "This computer has {N} GB of memory and no supported graphics processor, so it cannot run a useful local model. Your organization's server for local AI, if it has one, can be added by your organization to its rules." |
| Hardware can, no server | "This computer can run local models (about {M} GB usable by the graphics processor), but no local AI server is running. [Set up local AI]" (opens the model manager, section 7) |
| Server found, no allowed model | "{Server} is running but serves no model your organization allows. [Install a recommended model]" |
| Server found, test failed | "{Server} did not answer a test request: {cause}. [Check again]" |
| NEAR AI, no key | "No NEAR AI key is set for this project. [Add key]" |
| NEAR AI, offline or check failed | "NEAR AI Cloud could not be reached, or the check of its private hardware failed: {cause}. [Check again]" |
| Not allowed by the policy | "Your organization's rules do not allow {option}. Ask {contact}." (no fix offered) |
| Vault not ready | The Cohere design's not-ready sentence, with Open vault page |

## 7. The local model manager

### 7.1 What it is for

One page, **Local models** (palette: "NEAR AI: Manage Local Models"; panel titles have no prefix), reached from the guide's "Set up local AI", from Settings > AI services and models, from the model picker, and on the appliance as part of first start. It is built on the webview kit and talks to servers only through `LocalServerAdmin` and `ModelEndpoint`. It answers four questions: what can this machine run, which models should I use for my work, install or remove them safely, and which model does which job.

### 7.2 What this machine can run

For each model in the catalogue (7.4) and each of its artifacts (one per quantization), the page shows a fit band and a speed estimate.

**Memory needed** = weights (the artifact's file size) + KV cache + overhead, where

- KV cache = 2 x layers x context length x KV heads x head size x bytes per element (2 for f16, about 1.06 for q8_0), read from the GGUF header with a ranged read of the header only, never the whole file (the gguf-parser approach); architectures with sliding-window or hybrid layers use the per-layer values from the header;
- overhead = 1 GiB plus the compute buffer reported by the server when known;
- context length defaults to 32k tokens for the standard model and 8k for the fast model, adjustable on the page.

**Memory available** = for `unified`, the GPU-usable memory from 6.3 minus 8 GiB kept for the system and the extension; for `discrete`, VRAM (with system RAM offload shown separately as "slow"); for `cpu-only`, RAM minus 8 GiB.

**Fit band** by required over available: up to 60 percent "Comfortable", up to 85 percent "Fits", up to 98 percent "Tight (other work may slow it)", above that "Will not fit" (bands from llmfit, section 18).

**Speed estimate** for generation: tokens per second ~ memory bandwidth / bytes read per token x 0.55, where bytes per token is the active parameters (for a mixture of experts) times bytes per weight. Bandwidth comes from a small table of known devices (Strix Halo about 256 GB/s, GB10 about 273 GB/s, Apple and common discrete GPUs), else "unknown". Every estimate is labelled "estimate" until a **benchmark** replaces it: a fixed 512-token prompt and 128 generated tokens through the selected server, recording prompt speed, generation speed and time to first token on this machine, stored per (machine, server, artifact).

Worked example, labelled as estimates to be replaced by Phase 85's measurements: on a 128 GB Strix Halo machine with about 110 GB usable by the GPU, gpt-oss-120b in MXFP4 (about 63 GB of weights, about 5.1 billion active parameters) "Fits" at a 32k context with roughly 45 to 55 tokens per second; gpt-oss-20b (about 13 GB) is "Comfortable"; a 218-billion-parameter model at 4 bits needs more than about 110 GB of weights alone and "Will not fit".

### 7.3 Recommended models by kind of work and job

Recommendations come from passports, never from model names (model provenance 8.2). The shipped table follows the Western defaults (model provenance 8.1), filtered by what fits. On screen the columns read "Models by job" (glossary: no "tier" on user screens):

| Job | First choice locally | Second choice (other family) | Notes |
|---|---|---|---|
| Standard (chat, agent work) | Nemotron 3 Super | gpt-oss-120b | Either must pass the tool-calling test; on smaller machines falls to the fast model choices with the R5 note |
| Deep | gpt-oss-120b, or Command A+ where licensed and it fits | Nemotron 3 Super | Nemotron 3 Ultra and Command A+ need more memory than one 128 GB appliance gives for the GPU (estimate), so they are expected on NEAR or your organization's hosting |
| Fast | Nemotron 3 Nano | gpt-oss-20b | |
| Embeddings | A Western embedding model with a passport | Another family | Changing it rebuilds the knowledge base index, said before install |
| Safety check | A small model of a different family from the standard model | | Different-lineage rule (model provenance 9) |
| Research workspace (T0 lane) | Any model, including PRC-origin, installed only into the lane's list | | Labelled "research only"; never assignable to a job outside the research workspace |

By kind of work (Q1): software work weights tool calling and code; staff and analysis weight long context and document handling; writing weights the standard model. The kind of work changes the order of the first two choices only when the passports allow both.

### 7.4 The catalogue

A signed list of models the manager may install, shipped with the extension and replaceable by your organization's policy (`models.localCatalogue` in the policy v2 `models` section, named in `requires` as `models@1`; first written as `ceiling.models.localCatalogue`, open decision D10, superseded 2026-11-20 by the v2 section; the decision to keep it inside the models section stands). Each entry: passport id, artifacts (quantization, source as `huggingface.co/<repo>@<commit>/<file>` or an Ollama registry reference, sha256, size, licence id and licence URL, format `gguf` or `safetensors`, never pickle), and the minimum fit band to recommend it. Your organization may name a mirror that replaces both public sources.

### 7.5 Install, update, remove

| Action | What happens |
|---|---|
| Install | Shows the licence (id, link, obligations from the passport) and asks for acceptance, recorded; checks disk space; downloads over HTTPS from the catalogue source pinned to a commit; computes sha256 while writing to a partial file in the manager's own folder; refuses and discards the partial file on a mismatch; only then moves it where the server reads it (llama.cpp router folder) or pulls it through the server (Ollama, Lemonade) and checks the server's reported digest against the catalogue's sha256 (for Ollama, the model layer digest; to verify in Phase 32.2 that it equals the GGUF file's sha256, otherwise the catalogue carries the Ollama digest separately); then the test request and, if the person agrees, the benchmark |
| Update | Offered when the catalogue lists a newer artifact for the same passport; a new artifact hash is a passport re-evaluation trigger (model provenance 5.4), so an update to a model used above T1 is offered only when the passport covers the new hash |
| Remove | Asks to confirm, naming the model, its size and the jobs that use it; a job left without a model falls to the next viable choice, shown before confirming |
| Choose the server | Detected servers that can install (6.4) are listed; on the appliance the default is set by Phase 85's measurements (open decision D5); on a personal machine with none, the page explains how to install Ollama or LM Studio and checks again, and never installs a server by itself |

Signed models (OpenSSF Model Signing) are verified when an artifact carries a signature and the catalogue names the signer; the hash check is always required.

### 7.6 Models by job

The page assigns installed models to `fast`, `standard`, `deep`, `embed` and `safety` for the local endpoint, writing the one "Models by job" table in Settings (which replaces `nearAi.agent.fastModel`, `standardModel`, `deepModel`, their successors in `AGENT_DEFAULTS` and `roleModels`; `EXPERIENCE.md` section 2) only within what the policy's `models.defaults` and passports allow. A setting a person set by hand is kept and shown as "set by you".

## 8. Screens and flow

### 8.1 Flow

```
Start (first run, or "NEAR AI: Get Started", an invitation file, an old setup command alias, or "Change setup answers")
  -> Q1 kind of work -> Q2 data (+ Q2a, Q2b) -> Q3 Canada -> [Q4 pre-answered]
  -> Checking what works here (viability, live, about 10 to 60 seconds)
  -> Your options (recommendation, available, ruled out, not available here)
  -> [Set up local AI: the model manager, then back]
  -> [Data connections: with the data platform only]
  -> Check your answers and what will change
  -> Apply -> [Review proposed rule changes in the policy editor, if any]
  -> Done: land where you work (+ the checklist of remaining steps)
```

Every screen has Back and "Save and finish later". A half-finished guide resumes where it stopped. The whole flow is one webview stepper on the webview kit, not a chain of quick picks.

An **invitation file** (Share with people) opens Get Started already filled in: the project's label, mode and the joiner's section or position come from the project stream, so the joiner answers only Q1 if it is not set, then goes straight to viability and options. Answers the project fixes are shown as "Set by the project" and cannot be changed by the joiner.

### 8.2 Your options (main screen)

- Heading: "Recommended for this project".
- The recommended card first with its one-sentence reason and a "Why?" disclosure that lists the deciding facts.
- Each card, in the same order of lines: **Where your text goes**; **Who could see it**; **What is proven** (for example "Each answer is checked to come from attested private hardware"); **What is not proven** (for example "Where the data centre is", "That your organization has authorized this service for Protected B"); **Cost** (per-token price, per-GPU-hour price, or "No charge per use; uses this machine"); **Speed** (estimate or measured); and last, the **trust line** the person will see on every answer from this option: "Runs on {place} · {Verified | Model verified, connection not proven | Not verified: this service cannot be checked} · Allowed for {scale: level} by {the routing table | name's authorization ref until date}" (`EXPERIENCE.md`, section 3). Words come from `TrustFacts`, so the card and the later answers cannot disagree. "Private" appears only as "NEAR AI private hardware (checked each time it is used)".
- Ruled-out cards, greyed, with `aria-disabled` and the reason linked by `aria-describedby`, so screen reader users hear why.
- "Not available here", collapsed, with reasons and fixes (6.6).
- A choice other than the recommendation is allowed among available options; the guide asks for a short reason, which is recorded (the Purview pattern for a lower label).

### 8.3 Check your answers and what will change

A summary list with a Change link per answer (each link names what it changes for screen readers), then **What will change**, grouped as Added, Changed and Removed, in plain words:

- "Project label: raised from Organization: Internal to Canada, Protected: Protected B."
- "AI services: add this computer's local models (Nemotron 3 Nano as the fast model, gpt-oss-120b as the standard model)."
- "NEAR AI Cloud: kept for Organization: Public and Organization: Internal chats only."
- "Sources: propose Microsoft 365 (inventory only, mail off)." (with the data platform)
- "Your rules: proposed change, review in the policy editor: work must stay in Canada." (only when an answer needs a rule change; section 9.2)

The button says what it does: **Apply these settings**. Nothing changes before it is pressed. Proposed rule changes are not applied by this button: they open in the policy editor, where the person applies them on a personal policy or sends them to the security contact under an organization policy.

### 8.4 Re-running

**Change setup answers** (on every Home, and as a step of Get Started) opens the guide pre-filled, runs viability again, and shows only the differences on the check page. Rules for a re-run:

- A label is never lowered by the guide. An answer that would lower it shows "Lowering this project's label is a separate decision with a recorded reason" and a button to the existing Lower Label flow; the guide's other changes still apply.
- A provider is removed only after a confirmation that names what stops working.
- A source is never disconnected by the guide; that is the data platform's Disconnect with the administrator's confirmation.
- A re-run that changes nothing writes a record saying so.

### 8.5 The record

> **Coherence review (2026-11-20):** the record is the local audit record (`src/domain/gate/record.ts`, hash-chained, with periodic signed heads once that lands); it is not described as signed per record until the code signs it. In shared projects the answers, the label and the mode are project-stream entries on the replica rather than `project.json` in git. See `.planning/research/coherence/REVIEW.md`, conflicts K23 and K25.

Each Apply (and each abandoned run) writes one record in the gate's local audit record (`src/domain/gate/record.ts`, new event ids `setup.guide.applied` and `setup.guide.abandoned`), hash-chained with the rest of the local audit and covered by its periodic signed heads once those land (ADR-011). (First written as "signed with the device key"; superseded 2026-11-20: nothing is called signed per record until the code signs it.)

- answers (choice ids, never free text except the kind of work's 60 characters, secrets scanned out), proposed label, use, residency;
- viability snapshot: per option, state, reason code, server kind and version, model ids and artifact hashes, time;
- policy bundle hash (each layer's hash when layers exist), the `authorizations[]` ids it used, and the ids of any proposals it opened in the policy editor;
- options shown with their state, the recommendation and its reason id, the choice, and the person's reason when they chose otherwise;
- the change list applied and anything that failed to apply;
- who (device key id, the person id from the roster in a shared project, and the Phase 71 identity when it exists) and when.

On a single-machine project the answers and the latest record id are kept in `.planning/.near-ai/project.json` under `setupGuide` (open decision D6). In a shared project the answers, the project label and the organization mode are project-stream entries on the replica, so every member sees the same signed answers and nothing shared travels unsigned through git (REVIEW K23); `project.json` is not used for them there. The full records go beside the gate's records. The kind-of-work answer is personal and kept in this extension's storage.

### 8.6 State machines

**Guide session:** `not-started` -> `answering` -> `checking` -> `choosing` -> `reviewing` -> `applying` -> `applied`; from any state before `applying`, `paused` (resumable, answers kept) or `abandoned` (recorded). `applying` -> `partly-applied` when a step fails: the check page lists what was done and what was not, and a re-run finishes only the rest. No state waits forever: `checking` has a 90-second ceiling after which slow probes show as "still checking" with Continue without them.

**Option viability:** `unknown` -> `checking` -> `viable` | `not-detected` | `not-configured` | `not-allowed` | `test-failed`; `viable` -> `stale` after 10 minutes or on a network, server or policy change -> `checking`. Only `viable` can be chosen.

**Local model:** `listed` -> `downloading` -> `verifying` -> `installed` -> `tested` -> `assigned`; `verifying` -> `rejected` (hash mismatch: partial file discarded, recorded); `installed` -> `update-available`; `assigned` or `installed` -> `removing` (after confirmation) -> `listed`.

**Setup answers versus labels:** the project label is the single source of truth for routing. The guide's stored answers can disagree with the label only upward (a label raised later by reading a file); the guide shows that and never pushes the label back down.

## 9. How the policy constrains the guide

### 9.1 Inputs

The guide reads only a **verified** bundle (`verifyBundleEnvelope`). If the policy is failed closed ("Policy: reading only"), the guide shows that state and its fix and offers nothing else.

### 9.2 Rules

> **Coherence review (2026-11-20):** the vault step, discovery approvals and "Adopt the Western defaults" do change policy, so every such flow writes a **proposal** that opens in the one policy editor; on a personal policy the person applies it there, under an organization policy it is sent to the security contact. The guide itself still never writes the bundle. See `.planning/research/coherence/REVIEW.md` and `POLICY-SCHEMA.md`, section 7.

- Recommendations come only from options the bundle allows (`labels.routing`, `endpoints[]`, `authorizations[]`, `residency`, the `models` section's passports and `defaults`), all read through the one policy reader and judged by `decideRoute`. (First written as "routing tiers, `localHosts`, `attestedHosts`, `routing.vaults`"; superseded 2026-11-20 by policy v2.)
- When an answer needs something the bundle does not allow, the card says "Your organization's rules do not allow {need}. Ask {contact}." There is no Edit Policy button, no suggestion to lower a label, no "use another provider anyway".
- On the starting rules (a person with no organization policy) the same rules hold, and the card adds: "These are the starting rules. Changing them is a decision for your organization's security officer, not this guide."
- The guide writes only what a person can already do: raise a project label, add a connection, set models by job inside the policy, propose sources. It never writes the bundle.
- **Every flow that would change rules writes a proposal.** The vault step (Cohere 6.2 and 10.1), "Approve" for a found server (6.4.1), "Adopt the Western defaults" (model provenance 8.5), a "must stay in Canada" answer on a personal policy, and the risk-acceptance and authorization requests each produce one proposal (a diff with its effect in plain words, for example "Internal work could go to a vault that is not attested") that opens in the one policy editor, **Your organization's rules** (or **Your rules**), described in `POLICY-SCHEMA.md` section 7. On a personal layer the person applies it there; under an organization layer it is exported as a request to `onboarding.contacts` and nothing changes locally. Edit controls in that editor appear only where this device can sign the layer shown.
- **Interim rule:** until the organization layer exists (Phase 41 and the enrolment file), every acceptance or authorization the guide shows says "self-signed on this computer", and "set by your organization" copy is shown only when the issuer is not this device.

### 9.3 The `onboarding` section of the policy

> **Coherence review (2026-11-20):** `onboarding` becomes a section of policy bundle v2, named in `requires`. Discovery's personal approvals get an explicit key, `onboarding.discovery.personalApprovals`, default false; when true a personal approval adds an endpoint at `maxLabel org/Public` only. See `.planning/research/coherence/REVIEW.md` and `POLICY-SCHEMA.md`.

A section of policy bundle v2 (`POLICY-SCHEMA.md`, section 2), named in `requires` as `onboarding@1` so an older client says "update the extension" rather than failing. It is parsed with the strict key checks inside the section; a bundle without it behaves as above. As a section it may appear in the organization layer and be narrowed by the personal and project layers (for example a project may lock more answers, never unlock one).

```json
"onboarding": {
  "v": 1,
  "contacts": [ { "topic": "security", "name": "<role or person>", "how": "<email, phone or intranet page>" } ],
  "locked": { "canada": true },
  "kindsOfWork": ["software", "staff", "analysis", "capital-projects", "writing"],
  "defaultScale": "ca-protected",
  "discovery": { "networks": [], "announce": true, "scanRanges": [], "personalApprovals": false }
}
```

| Key | Rule |
|---|---|
| `contacts` | Up to 8; `topic` one of `security`, `privacy`, `contract-security`, `it`; shown wherever the guide says who to ask; proposals under an organization layer are sent to them |
| `locked` | Answers your organization fixes; `canada: true` shows Q3 answered and unchangeable, with "Set by your organization". The rule itself lives in `residency` (`route.residency`); `locked.canada` only locks the question |
| `kindsOfWork` | The kinds of work offered in Q1, in order (first written as `roles`; renamed 2026-11-20 because "role" is kept for positions) |
| `defaultScale` | The scale personal information maps to (4.3) |
| `discovery` | Networks, announcement, scan ranges (6.4.1); `personalApprovals` default false, and when true a personal approval adds an endpoint at `maxLabel org/Public` only |

## 10. Landing by kind of work

After Apply, the guide opens the place that fits the kind of work and leaves a short checklist filtered by it, as a VS Code walkthrough (`contributes.walkthroughs`, steps shown by `when` context keys and ticked by `completionEvents`), so "skip and come back" survives a reload. The checklist is the guide's step registry (section 12.1) and is also shown on the person's Home (`EXPERIENCE.md`, section 4).

**First-run guarantee.** Before landing, the guide runs viability and the model approval check for the surface it is about to open, and never lands a person on a surface with no allowed model. A refusal card is never the first thing a new user sees. Under the Western defaults a staff project needs operational use and no shipped approval reaches it, so until your organization approves a model for operational work the staff step offers "Exercise on fictional data" only, says why on the options screen, and sets the exercise flag as a signed project-layer attribute with that reason (REVIEW K15, K30).

| Kind of work | Lands in | Checklist steps |
|---|---|---|
| Software | Chat with the project team (the guide's software step sets up a team first if there is none, then opens chat) | Spending limit; secure development workflow (Phase 28) when built; web search; My computers; Share with people |
| Staff officer | The guide's staff step with the chosen section (only echelon or variant is asked; doctrine and level come from the policy), then the Staff Room with that section's team | Share with people (or, for a joiner, already done by the invitation file); map layers; My computers |
| Analyst | The data views (data map, search, entity pages; Phases 96 and 97) when the data platform is present; before that, chat with an analysis team | Connect sources (section 11), when an administrator |
| Capital projects | Chat with a capital projects team once those templates exist (Phase 42); before that, a document-focused project team | Share with people |
| Writing, Something else | Chat | Spending limit; My computers |
| Administrator (any of the above, holding the policy) | The policy editor, with any proposals from this run open | Organization rules; People (positions and postings); your organization's server (status) |

The two sharing items are the only sharing ideas (`EXPERIENCE.md`, section 6): **My computers** (same person, other computer: Project Sync with the recovery code, also covering Add My Other Machine and the online home) and **Share with people** (the invitation file and safety code, on the replica layer for every project type). "Team Mode", "Make This Staff Project Multi-User" and "Join Staff Project" are not offered as their own steps.

Landing never runs anything: it opens views and offers the next step.

> **Superseded 2026-11-20 (coherence review):** this section was first titled "Role landing" and keyed by "role"; "role" is now kept for positions, and the setup question is "kind of work". The staff row first opened `staffSetupCommand` as a separate flow and listed "Join or create the multi-user staff project"; it is now the guide's staff step and "Share with people". The software row first named `nearAi.setupProjectTeam` and `nearAi.openChat`; those ids stay as aliases.

## 11. The data-connection step (with the data platform)

- **An administrator step of Get Started,** registered through the step registry, ending on the policy editor for any rule it needs (`EXPERIENCE.md`, section 1).
- **Appears only when viable:** your organization's server for data is reachable, and the person holds the sources administrator position (a Phase 71 credential; until then, the host's own administrator check). Otherwise the step is absent, and analysts see "Ask your administrator to connect your organization's sources" with the contact.
- **One more question, only here:** "Where does your work live?" Microsoft 365 (SharePoint, OneDrive, Teams files), Google Workspace, file shares, folders on this computer. Mail is a separate tick, off by default and allowed only after your organization confirms a privacy assessment and notice (data platform decision 6).
- **From the same answers:** the label default for new items is the project's proposed label or higher; residency Yes keeps sources whose processing would leave Canada out of the proposal, with the reason.
- **One click each:** "Connect Microsoft 365", "Connect Google Workspace" and "Connect file shares" run the data platform's one-click setups (`00-DESIGN.md` 3.7, CONN-01 to CONN-04), each starting as a `proposed` source in inventory-only mode (DATA-07). The guide shows the permission list with reasons before the administrator signs in.
- **Re-runnable:** the guide only proposes and starts setups; finishing, rotating and disconnecting stay with the connectors.
- **Finding sources on the network:** file shares and other on-premises sources are found the same way as model servers (section 6.4.1): named in the policy, announced (DNS SRV, DFS namespaces your organization publishes), or scanned on policy-listed ranges for the SMB and NFS ports only, with the same confirmation and record. Listing a found share's contents is a connector setup step that needs the administrator, never part of discovery.

## 12. How it fits the rest

### 12.1 Get Started: the one front door

The guide is **NEAR AI: Get Started**. It keeps the `nearAi.setup` command id and is the only setup command (owner decision Q9). Every other setup path folds into it, as a step the guide runs or as an item on the checklist it leaves behind. Old command ids stay as hidden aliases that open Get Started at the right step, for two minor releases. The full table is `EXPERIENCE.md` section 1; in short:

| Existing path | Becomes |
|---|---|
| Set Up, which opens the First Project page (`src/services/onboarding.ts`) | Removed; its cards become the checklist after landing |
| Chat setup card "Connect NEAR AI to start" | One button: Get Started |
| Project Setup menu (`src/services/setupSteps.ts`) | The checklist; `registerSetupStep` becomes the guide's step registry |
| Set Up Project Team | The software step; also offered in Team Studio |
| Set Up a Staff Team (`staffSetupCommand.ts`) | The staff step: Q1 gives the section, the policy gives doctrine and level, only echelon or variant is asked. Its "Where may the members' models run?" question is **removed**: the label and the policy decide (REVIEW K13) |
| Project discovery `locality` and `riskLevel` (`projectInitialization.ts`) | `locality` is **removed** (label and policy decide); `riskLevel` stays only inside the team recommendation |
| New, Select, Use a Saved and Remove Profile | The guide's options screen and Settings > Connections |
| Cohere vault setup, local model manager (32.2) | Options inside the guide, also in Settings > AI services and models; adding a vault produces a policy proposal |
| Turn On Project Sync, Give This Project an Online Home, Put This Project's Code Online | Checklist item "My computers" |
| Enable Team Mode, Make This Staff Project Multi-User, Join Staff Project | "Share with people" (owner) and opening an invitation file (joiner), which opens Get Started already filled in |
| Set Up Web Search, Set Up Research Verifiers, Spending Limits, Manage MCP | Checklist items and Settings sections |
| Data connections (section 11, Phase 89), data platform policy wizard (Phase 93), messaging setup (Phase 78) | Administrator steps, each ending on the policy editor |
| Secure development workflow (Phase 28) | A checklist step registered with the guide |

**Rule for every later phase:** a setup flow is a step or an option registered with the guide, `{ id, title, state(), viability(), run() }` (the setup step contract in `src/domain/setup/` and `src/services/setup/`). It never adds a new top-level setup command.

**One Settings page.** After landing, everything the guide set can be changed in **Settings** (one page; `EXPERIENCE.md` section 2): Connections and AI services, Models by job, Autonomy and approvals, Spending, My computers and sharing, Tools, Your organization's rules (read-only for members), Advanced. "Change setup answers" sits on every Home.

### 12.2 The other pieces

| Piece | Fit |
|---|---|
| Project setup today | The guide replaces the First Project page and the discovery questions; `locality` is removed rather than mapped (first written as "Old answers map: `cloud` to NEAR AI, `local` to local, `hybrid` to both"; superseded 2026-11-20, K13: an existing `locality` answer is shown once on the check page as "Your earlier answer" and has no effect on routing). `riskLevel` is kept for the team recommendation only. |
| Gate (Phase 70) and foundation (Phase 41) | Labels, `decideRoute`, `TrustFacts`, records and the policy are reused through the one policy reader; the guide's only policy addition is the `onboarding` v2 section. `endpoints[]`, `authorizations[]`, `residency`, the mode table and `term()` come from Phase 41. (First written as "the only bundle addition is the optional `onboarding` key"; superseded 2026-11-20.) |
| Model provenance (74.1, 74.2) | The `models` section's schema lands in Phase 41 in report mode; before 74.1 the guide shows origin and the highest approved use from the shipped passport rows as data and runs R4 in report mode; after 74.1, R4 enforces. `org-tee` options appear when 74.2 lands. The local catalogue is `models.localCatalogue`. "Adopt the Western defaults" is a proposal in the policy editor. |
| Cohere (36, 37) | Phase 36's setup step becomes two guide options (Standard, Encrypted) registered through the step registry; the vault form opens from the guide and ends in a policy proposal for one `endpoints[]` entry (Standard default `maxLabel org/Public`, Internal an unticked box); readiness is the viability check; the vault is a `ModelEndpoint` adapter. |
| Data platform (85 to 101) | Phase 85 sets the appliance's default local server and replaces the speed estimates with measurements; Phase 89 adds the data-connection step, 90 and 91 extend it; 96 and 97 give analysts their landing. |
| Appliance (L1a, L1b) | On first start the appliance runs the guide with the model manager; local is viable by construction, so the usual recommendation is local first with NEAR AI as a burst where labels allow. |
| Staff (30 to 35) | Staff officers land in the Staff Room; the section answer pre-selects the section team; decisions belong to positions (Phase 33.1), so the guide never asks who the "section lead" is. |
| Shared projects (multi-user, replica) | In a shared project the answers, the label and the organization mode are project-stream entries on the replica; the kind of work is personal. An invitation file opens Get Started prefilled from the stream. (First written as "The project's answers live in `project.json`"; superseded 2026-11-20, K23.) |
| Organization modes (Phase 33.1) | The guide reads the mode table and `term()` from Phase 41 and suggests a mode; every mode-varying word on its screens comes from `term()`. |

## 13. Accessibility

This section is the house standard for every webview (`EXPERIENCE.md`, section 7), enforced by the webview kit's checks; the guide is the first page built to it.

- **Keyboard:** every control reachable with Tab in reading order; option cards are a native radio group in a `fieldset` with a `legend` (arrow keys move, Space selects); disclosures are buttons with `aria-expanded`; Escape closes a disclosure; no keyboard trap; visible focus at 3:1 contrast that a sticky footer never covers (WCAG 2.2 2.4.11).
- **Screen readers:** the page title and heading start with "Step 2 of 5:"; on a step change focus moves to the new heading (`tabindex="-1"`); the stepper is an ordered list with `aria-current="step"` and hidden "Completed:" text; viability progress uses one polite live region ("Checked 4 of 6"); greyed options use `aria-disabled` (not `disabled`) so the reason is announced; every estimate says "estimate" in text, not only by style.
- **Reduced motion:** no transitions when `prefers-reduced-motion` is set (the existing `src/domain/motion.ts` rule); progress shows counts, not animation; nothing moves on its own for more than 5 seconds.
- **Consistent help:** the "Who to ask" line sits in the same place on every screen (WCAG 2.2 3.2.6).
- **Plain language:** sentences under 25 words where possible; terms like "attested" always followed by a plain explanation on first use.
- **Themes:** VS Code theme variables only; meaning never by colour alone (ruled out also has an icon and the word "Not for this work").
- **Testing:** the existing layout probe and webview accessibility checks, plus a scripted keyboard-only run and a screen reader pass of the main path, recorded in the phase verification.

## 14. Security notes and SECURITY.md changes

### 14.1 Threats and handling

| Threat | Handling |
|---|---|
| The guide becomes a way around the gate | It writes only what a person can already do, never the bundle; rule changes are proposals in the policy editor, applied only where this device can sign that layer; labels only rise; every request is still routed by the gate's `decideRoute` |
| A setup answer later undone by another choice | Residency is the gate's `route.residency` rule, not a setup filter; the Canada question ships only with it (Phase 41) |
| Classified work on an unaccredited computer | The guide stops (4.4); the gate warns and records `route.not-accredited` now and refuses once the organization layer exists, unless an `accredited-device` authorization names this device |
| A person answers "public" to reach the cloud | The guide is advice and setup, not enforcement: file labels still raise the chat's label, and the gate refuses by label. The record keeps the answers for review |
| A fake local server on a loopback port | Identified by its signature endpoint; a local process already has this computer's trust, so this is not a new boundary; the record keeps the server kind and version; T2 use still needs a passported artifact |
| Network scanning | Only as section 6.4.1 allows: named hosts, announced servers on policy-listed networks, and scans of policy-listed ranges only, on known ports, rate-limited, confirmed by the person and recorded; off on networks the policy does not list |
| A rogue or spoofed server on the network collecting prompts | A found server is a candidate: it gets only the signature request until approved; approval pins its TLS certificate; plain HTTP off-machine only for labels the policy allows (default Public); never a key, prompt or project data to a candidate |
| Tool execution during detection | Fixed binaries with fixed arguments, no shell, known install paths before PATH, timeout and output cap, not run from the workspace folder |
| Tampered or swapped model files | sha256 from the signed catalogue checked before the file is visible to a server; HTTPS from named sources pinned to a commit; safetensors or GGUF only; no remote code |
| Licence surprises | Licence shown and accepted before download, recorded; passports carry obligations |
| Test requests leak data | Fixed text only; through the outbound check; spend counted |
| Overclaiming compliance | Cards say what is not proven; the guide never says "approved", "compliant" or "accredited"; Protected B only with a recorded authorization; classified gets no recommendation |
| Contact details in the policy used for phishing | They come only from the signed bundle, shown as text, never as clickable links to unknown schemes |

### 14.2 SECURITY.md changes (in the phases, not now)

- In **Where your data goes**, three rows: "Guided setup checks" (loopback probes, the policy-named hosts, listening for announced servers, network scans of the ranges your policy lists when you confirm one, the NEAR AI test request and its cost); "Local model downloads" (Hugging Face or the Ollama registry or your organization's mirror see your IP address and the model name; hashes checked before use); "Setup answers" (`project.json` on a single machine, project-stream entries in a shared project, and the gate's local audit; categories only, no content).
- A new section **Get Started and local models**: what is detected and how; the viability rule; that answers are self-declared and labels follow; that the guide never writes the policy and that rule changes are proposals in the policy editor; the Protected B paragraph of 4.5; what the guide does for classified work.
- README: a short "Choosing where your AI runs" section with the option list and the plain words of 8.2, and the model manager in the feature list.

## 15. Risks

| Risk | Mitigation |
|---|---|
| People treat the recommendation as a security decision | The disclaimer on every recommendation ("Your organization categorizes information; this guide applies your answers as labels"); contacts from the policy |
| Wrong mapping of personal information | Sensitive personal information maps to Protected B; "Not sure" is strict; your organization can set `defaultScale` and contacts |
| Hardware estimates wrong (Windows VRAM, unified memory, new devices) | Every estimate labelled; the benchmark replaces it; Phase 85 measures the appliance |
| Detection makes setup slow | Probes run in parallel with short timeouts; a 90-second ceiling; cached results with a 10-minute life |
| A model that answers "OK" is still weak at real work | The tool-calling test for the standard and deep models; fit for the kind of work (R5); the benchmark |
| Ports and endpoints of servers change between versions | A probe table per server with signature checks, updated with tests; unknown servers can be added by URL |
| The appliance's default server changes after Phase 85 | The manager is server-agnostic through adapters; the default is one setting |
| Too many screens | Four questions, one conditional, everything else pre-answered and changeable on the check page |
| Recommending NEAR or a vault while a Canadian-only answer was intended | Q3 "Not sure" is treated as Yes; `locked.canada` in the policy; `route.residency` enforces it on every request |
| A new user's first screen is a refusal | The first-run guarantee (section 10): viability and the approval check before landing; staff offers exercise only until a model is approved for operational work |

## 16. Phase proposal

### 16.1 Where it lands, and why

**Two phases in the 0.4.x line, numbered 32.1 and 32.2, built after Phase 32 and before Phase 36.** They need the Phase 70 gate and the existing setup, provider and webview code; Phase 74.1 is not required (the guide reads the shipped passport rows as data until it lands).

> **Coherence review (2026-11-20):** both phases now also build **after Phase 41** (the organization policy foundation), which supplies policy v2 with `requires`, `endpoints[]`, `authorizations[]`, `residency` and `route.residency`, `decideRoute` and `TrustFacts`, the mode table and `term()`, `ModelEndpoint` and `LocalServerAdmin`, the copy lint, and the policy editor shell that receives proposals. The webview kit lands in Phase 41 or, at the latest, as the first work of 32.1. REVIEW section 9, milestone 4. Putting them before 36 and 37 means Cohere's options arrive through the guide rather than as another setup form. They touch setup, providers and new webviews, not staff files, so they may run beside Phases 33 to 35 in their own worktrees.

Order: 32.1 and 32.2 share one contract first (the option registry, `ViabilityResult`, the device class and server adapter interfaces); after that contract lands they run in parallel worktrees and merge in one integration. The one sequential link is that contract.

The data-connection step (GUIDE-09) is placed in Phase 89, because it needs the host and the one-click connection.

### 16.2 Phase 32.1: Get Started, with viable options and a plain recommendation

**Goal:** A person opens Get Started, the one setup command, answers a few plain questions about their work, sees only the options that really work on their machine and that your organization allows, gets one recommendation with a reason, applies it after seeing what will change, and lands where their kind of work belongs, never on a surface with no allowed model; the answers are recorded and can be changed later, and every other setup path opens here.

**Requirements:** GUIDE-01 to GUIDE-08.

| Id | Requirement |
|---|---|
| GUIDE-01 | The question set of section 4 (kind of work, data, Canada, conditional follow-ups, pre-answered agent work), one per screen, with Not sure mapped to the stricter reading and explained; levels shown as scale name plus level; the kind of work remembered per person, the rest per project. |
| GUIDE-02 | Answers map to a proposed project label on the policy's scales (4.3), applied through Set Label and only ever raised; Protected C, classified and contract work without approval stop with the plain sentence and no recommendation (4.4). |
| GUIDE-03 | Viability per option (detected, configured, allowed, answered) for local servers on loopback, policy-named hosts and servers found on your network and approved (6.4.1), NEAR AI and the device class (6.1 to 6.5); only viable options can be chosen; the rest are listed apart with reason and fix; results go stale after 10 minutes or on a change. |
| GUIDE-04 | A pure `recommend()` that calls `decideRoute` for every option (residency, use, authorizations and label all decided there) and ranks with rules R1 to R9, and gives one recommendation with a one-sentence reason; ruled-out options greyed with the gate's refusal sentence. |
| GUIDE-05 | Option cards in plain words (where your text goes, who could see it, what is proven, what is not, cost, speed) ending in the trust line from `TrustFacts`; a choice other than the recommendation records a reason. |
| GUIDE-06 | The policy wins: only verified bundles, nothing outside the bundle offered, who to ask from the `onboarding` v2 section or a generic contact, no policy edit or label lowering offered; rule changes (vault, found server, Western defaults, residency on a personal policy) only as proposals in the one policy editor; the `onboarding` section named in `requires` and parsed with strict key checks. |
| GUIDE-07 | Check answers with a grouped list of what will change before Apply; re-run pre-filled showing only differences; partly applied runs finish on re-run; a hash-chained local audit record of answers, viability snapshot, bundle hash, options, recommendation, choice and changes; in a shared project the answers, label and mode as project-stream entries. |
| GUIDE-08 | Landing by kind of work (section 10) with a filtered checklist (including My computers and Share with people) and the first-run guarantee; Get Started as the only setup command, every path in 12.1 folded in with old ids as hidden aliases, staff setup's "where" question and discovery `locality` removed; an invitation file opens Get Started prefilled; keyboard, screen reader and reduced motion as in section 13, on the webview kit. |

**Success criteria:**

1. On a laptop with no local AI and a NEAR AI key, a developer answering "internal work, Canada No" is recommended NEAR AI private hardware with its reason; local appears only under "Not available here" with the hardware sentence. (GUIDE-01, GUIDE-03, GUIDE-04)
2. On a machine with Ollama serving a passported model, an analyst answering "sensitive personal information" gets the project labelled Protected B and is recommended this computer; NEAR AI is greyed with the routing sentence; a policy that records an authorization for a Canadian vault makes that vault available with the authorization named. (GUIDE-02, GUIDE-04, GUIDE-05)
3. Answering Secret, Protected C, or contract work without approval stops with the plain sentence, no option can be chosen, and the label is applied. (GUIDE-02)
4. With Canada locked in the policy, NEAR AI and US vaults are greyed with the residency reason and Q3 cannot be changed; a policy without `onboarding` behaves the same with generic contacts; a failed-closed policy shows only its fix. (GUIDE-06)
5. A re-run that would lower the label leaves it and points to Lower Label; a re-run that changes nothing records that; the record is in the local audit chain, the chain check passes, and it contains no secret or free text beyond the kind of work. (GUIDE-07)
6. A staff officer choosing J2 lands in the Staff Room with the J2 team, offered exercise on fictional data only while no model is approved for operational work; a developer lands in chat with the project team; no first screen is a refusal; the whole path works by keyboard alone and with a screen reader, and with reduced motion nothing animates. (GUIDE-08)
7. Existing connections and setup steps work unchanged; every old setup command id opens Get Started at the right step; adding a vault or approving a found server leaves the policy unchanged until the proposal is applied in the policy editor. (GUIDE-06, GUIDE-08)

> **Superseded 2026-11-20 (coherence review):** criterion 5 first said "the record verifies with the device key", and criterion 7 "existing profiles, discovery answers ... work unchanged". The record is now the hash-chained local audit record, and the discovery `locality` answer no longer affects routing (section 12.2).

### 16.3 Phase 32.2: Local model manager

**Goal:** On the appliance or any capable computer, a person sees what local models this machine can run and how fast, installs the recommended Western models with verified hashes and accepted licences, assigns them to jobs, and the guide then offers local AI as a viable option.

**Depends on:** Phase 41 (`ModelEndpoint`, `LocalServerAdmin`, the `models` section) and the shared contract of 32.1 (device class, viability).

**Requirements:** LMOD-01 to LMOD-07.

| Id | Requirement |
|---|---|
| LMOD-01 | Hardware detection per 6.3 with unified memory as a first-class device class (Strix Halo GTT, GB10 via meminfo, Apple working set), fixed tools only, no shell, timeouts and output caps. |
| LMOD-02 | Server adapters (each a `ModelEndpoint`, plus `LocalServerAdmin` where the server can install) for Ollama, llama.cpp server, Lemonade, LM Studio, vLLM, NVIDIA NIM, LocalAI and Jan, identified by signature endpoints on loopback, policy-named hosts and approved servers found on your network (6.4.1), with install capability where the server supports it and list-only otherwise. |
| LMOD-03 | Fit bands and speed estimates per artifact from GGUF header ranged reads and the bandwidth formula, labelled as estimates; an optional benchmark replaces them with measured numbers per machine, server and artifact. |
| LMOD-04 | Recommendations by job and kind of work from passports and the signed local catalogue (shipped, replaceable by the policy's `models.localCatalogue`); PRC-origin and passport-less models only into the research workspace's list. |
| LMOD-05 | Install with licence acceptance, disk check, HTTPS from pinned sources or your organization's mirror, sha256 verified before the file is visible to the server, safetensors or GGUF only; update offered only within the passport; remove after confirmation naming the jobs affected. |
| LMOD-06 | Models by job for fast, standard, deep, embeddings and safety within the policy's defaults; a person's own setting kept; the tool-calling and embedding tests before a job's model counts as viable. |
| LMOD-07 | Local audit records for install, update, remove, assignment and benchmark; SECURITY.md and README sections for local models; the page on the webview kit. |

**Success criteria:**

1. On a Strix Halo machine the page shows the unified memory the GPU can use (or the fix to raise it), lists gpt-oss-20b as Comfortable and gpt-oss-120b as Fits with estimates, and the benchmark replaces the estimate with measured numbers. (LMOD-01, LMOD-03)
2. A model installed through Ollama and one through a llama.cpp models folder are both verified against the catalogue hash; a file with one changed byte is rejected and never reaches the server. (LMOD-02, LMOD-05)
3. Assigning Nemotron 3 Nano to fast and gpt-oss-120b to standard passes the test requests, and the guide then shows local AI as viable and recommended for Protected B work. (LMOD-04, LMOD-06)
4. A PRC-origin model can be installed only into the research workspace's list and never appears in a Models by job selector. (LMOD-04)
5. Removing a model asks first and names the jobs that lose it; every action leaves a record. (LMOD-05, LMOD-07)

### 16.4 The data-connection step in Phase 89

**GUIDE-09:** With the data platform host present and an administrator, the guide offers the one-click connections chosen from the same answers (where the work lives, residency, label default), inventory-only first and mail off by default; for anyone else it names who to ask. Placed in Phase 89 (Microsoft 365), extended in Phases 90 (Google Workspace) and 91 (file shares and collectors).

### 16.5 Work packages

| WP | Scope | Worktree | Depends on | Tests |
|---|---|---|---|---|
| WP-0 Contract | Step and option registry (the setup step contract), `ViabilityResult`, device class, answer and record types, `onboarding` v2 section parser with its `requires` id and declared narrowing directions; uses Phase 41's `ModelEndpoint` and `LocalServerAdmin` instead of a separate `LocalServerAdapter` (superseded 2026-11-20) | `feat/guide-contract` | Phase 41 | Strict key cases for `onboarding`; a bundle without it parses as before; an unknown `onboarding@2` gives "update the extension", never Reset |
| WP-RECOMMEND | Pure answer-to-label mapping and `recommend()` | `feat/guide-recommend` | WP-0 | One test per row of 4.3, 5.3 and 5.4; uses the real `decideRoute` |
| WP-VIABILITY | NEAR AI, local server probes, policy-named hosts, test requests, staleness | `feat/guide-viability` | WP-0 | Fake servers per adapter on loopback and on a test network; scans only of listed ranges on listed networks, rate-limited and confirmed; a candidate gets only the signature request; approval pins the certificate; test request text fixed; staleness transitions |
| WP-UI | Guide webview on the webview kit, check answers, change list, proposals handed to the policy editor, re-run, landing with the first-run guarantee, checklist, old setup command aliases, accessibility | `feat/guide-ui` | WP-0 | Webview tests for each screen; keyboard path; focus moves; reduced motion; each old command id opens the right step; copy lint passes |
| WP-RECORD | Local audit records, `project.json` answers on a single machine, project-stream entries in a shared project, handling of old discovery answers | `feat/guide-record` | WP-0 | Chain check passes; secrets scanned out; old `locality` answers shown but not used |
| WP-HW | Hardware detection per platform (32.2) | `feat/local-hw` | WP-0 | Fixture files for Strix Halo, GB10, Apple, discrete NVIDIA, Windows; no shell |
| WP-MODELS | Catalogue, fit and speed, install, verify, remove, benchmark, models by job, model manager page (32.2) | `feat/local-models` | WP-0, WP-HW | Hash mismatch rejected; partial files never visible; estimates match worked examples; removal asks |
| Integration | Merge, SECURITY.md and README, one full verification run | `feat/guided-setup-integration` | All | Full suite once; scripted end-to-end on a fake local server |

## 17. Open decisions for the owner, with defaults

| # | Question | Default |
|---|---|---|
| D1 | Options that fail viability: listed apart under "Not available here" with reason and fix, or hidden completely? | Listed apart, collapsed, never selectable (people need the reason and the fix) |
| D2 | "Not sure" about the data: treat as Protected B, or as Protected A with a reminder? | Protected B, with the sentence and the reminder; it keeps work local until known |
| D3 | Protected C and classified: always stop, or allow local when the policy marks this device as accredited for that level? | Always stop in 32.1; a signed `accreditedDevices` entry can come later with Phase 71 credentials |
| D4 | NEAR AI test request: a one-word completion (costs a fraction of a cent, counted), or a free list-and-attest check only? | The one-word completion, counted in spend, because only a real answer proves the model serves |
| D5 | Default local server on the appliance | Decided by Phase 85's measurements; until then llama.cpp server with Vulkan (the dependable path on Strix Halo), with Ollama recommended on personal machines |
| D6 | Where the project's answers live | `.planning/.near-ai/project.json` (shared with the project), full records beside the gate's records; the role in extension storage |
| D7 | The optional `onboarding` bundle key (contacts, locked answers, roles, default scale) | Yes |
| D8 | Local model manager as its own phase (32.2) or inside 32.1 | Its own phase, after a shared contract, run in parallel |
| D9 | Phase numbering: 32.1 and 32.2 (inserted, before 36), or 38 and 39 with a dependency note | 32.1 and 32.2 |
| D10 | Local catalogue: inside `ceiling.models` (`localCatalogue`) or a separate signed file | Inside `ceiling.models`, so one signature covers models and their artifacts |
| D11 | Allowed download sources by default | Hugging Face (pinned commits) and the Ollama registry; your organization's mirror replaces both when named |
| D12 | Network discovery (owner asked for it, 2026-11-20) | Named hosts and announced servers on by default on policy-listed networks; active scans only of policy-listed ranges, confirmed by the person each time, rate-limited and recorded; found servers are candidates until an administrator approves them and their certificate is pinned |

**Settled by the coherence review (2026-11-20, owner accepted all twelve defaults):**

- D3: unchanged for the guide (always stop), but the device record is now `authorizations[kind=accredited-device]`, not an `accreditedDevices` list; the gate warns and records now and refuses once the organization layer exists (Q6).
- D6: kept for single-machine projects; in shared projects the answers, label and mode are project-stream entries on the replica (K23).
- D7: yes, as the `onboarding` section of policy v2, named in `requires`, with `discovery.personalApprovals` default false.
- D9: 32.1 and 32.2 kept, now also after Phase 41 (Q1).
- D10: kept inside the models section, now `models.localCatalogue` in policy v2.
- Front door, Settings and policy editor: Get Started is the only setup command; one Settings page; Edit Policy only where this device can sign (Q9).

**New questions raised by this rewrite, with recommended defaults:**

| # | Question | Recommended default |
|---|---|---|
| D13 | What happens to an existing `locality` answer (`cloud`, `local`, `hybrid`) from project discovery once `locality` is removed? | Shown once on the check page as "Your earlier answer" with no effect on routing; if it was `local`, the guide proposes nothing but pre-selects local options in the ranking (R6) when they are viable |
| D14 | When a person on a personal policy answers "must stay in Canada", should the guide propose `residency.required: "CA"` for the whole personal layer, or only for this project? | For this project only (a project-layer narrowing), because a person's other projects may not need it; an organization sets it organization-wide |
| D15 | Where does "Change setup answers" live once the palette shrinks? | On every Home and as a hidden alias command; not in the chat title bar |
| D16 | Should a joiner opening an invitation file be asked Q1 (kind of work) when their position already implies it (for example a J2 posting)? | No: pre-answer it from the position and show it on the check page, changeable |

## 18. Prior art drawn on

Research done 2026-11-20 on public sources; no downloaded code was run.

**Government of Canada, for the questions and the Protected B text**
- PSPC, "Levels of security" (Protected A, B, C and classified injury tests): https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/safeguarding-equipment-sites-assets-information/levels-security.html
- TBS Directive on Security Management, Appendix J, Standard on Security Categorization: https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32614
- Direction on the Secure Use of Commercial Cloud Services (SPIN): https://www.canada.ca/en/government/system/digital-government/modern-emerging-technologies/direction-secure-use-commercial-cloud-services-spin.html
- CCCS, ITSP.50.103 security categorization of cloud services and the Medium cloud control profile: https://cyber.gc.ca/en/guidance/guidance-security-categorization-cloud-based-services-itsp50103
- CCCS, ITSM.50.100 cloud service provider assessment process: https://cyber.gc.ca/en/guidance/cloud-service-provider-information-technology-security-assessment-process-itsm50100 ; the program covers services up to Protected B, and each department still does its own assessment and authorization: https://www.cyber.gc.ca/en/tools-services/cloud-security-assessment-program
- ITSM.50.062 cloud security risk management: https://cyber.gc.ca/en/guidance/cloud-security-risk-management-itsm50062
- Directive on Service and Digital 4.4.3.14 (Canadian computing facilities as the principal option for Protected B and above): https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32601 ; GC Cloud Guardrail 5, data location: https://canada-ca.github.io/cloud-guardrails/EN/05_Data-Location.html
- PSPC Contract Security Program, IT security requirements (written IT approval before electronic processing; PSPC does not approve cloud solutions): https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/safeguarding-equipment-sites-assets-information/information-technology-security-requirements.html ; SRCL form: https://www.canada.ca/en/treasury-board-secretariat/corporate/forms/350-103.html
- Shared Services Canada classified systems (classified information on dedicated accredited platforms): https://www.canada.ca/en/shared-services/services/cyber-security/classified-systems-and-services.html
- Privacy laws in Canada (Privacy Act, PIPEDA, substantially similar provincial laws): https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/02_05_d_15/

**Guided choice and labelling**
- Microsoft Purview recommended and automatic labels, justification to lower a label: https://learn.microsoft.com/en-us/purview/apply-sensitivity-label-automatically ; https://learn.microsoft.com/purview/default-sensitivity-labels-policies
- GC Microsoft 365 security playbook (labels up to Protected B, justification to lower): https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/security-playbook-microsoft-365.html
- Azure landing zone portal accelerator (tiered choices with secure defaults, review and create, post-deployment summary of skipped items): https://learn.microsoft.com/en-us/industry/nonprofit/azure-landing-zone-deploy ; Canada public sector landing zone (MIT): https://github.com/Azure/CanadaPubSecALZ ; AWS Landing Zone Accelerator for CCCS Medium: https://github.com/aws-samples/landing-zone-accelerator-on-aws-for-cccs-medium
- Drawn on: recommend with a reason, require a reason to go against it, show what will change before applying, list what was skipped.

**Onboarding and accessibility patterns**
- NN/g on progressive disclosure and wizards: https://www.nngroup.com/articles/progressive-disclosure/ ; https://www.nngroup.com/articles/wizards/
- VS Code walkthroughs and their guidelines: https://code.visualstudio.com/api/references/contribution-points#contributes.walkthroughs ; https://code.visualstudio.com/api/ux-guidelines/walkthroughs
- GOV.UK question pages and check answers (MIT): https://design-system.service.gov.uk/patterns/question-pages/ ; https://design-system.service.gov.uk/patterns/check-answers/
- W3C WAI multi-page forms; ARIA APG radio group and disclosure: https://www.w3.org/WAI/tutorials/forms/multi-page/ ; https://www.w3.org/WAI/ARIA/apg/patterns/radio/ ; https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/
- WCAG 2.2 3.3.7, 2.4.11, 3.2.6, 2.3.3: https://www.w3.org/WAI/WCAG22/Understanding/
- GC Design System stepper (MIT): https://design-system.canada.ca/en/components/stepper
- Hidden versus disabled options: https://www.nngroup.com/videos/why-disabled-buttons-hurt-ux-and-how-to-fix-them/ ; https://smashingmagazine.com/2024/05/hidden-vs-disabled-ux/
- Terraform plan (BUSL 1.1, pattern only): https://developer.hashicorp.com/terraform/cli/commands/plan
- Drawn on: one question per page, check answers with Change links, greyed with a reason, focus to the heading, `aria-disabled` with a described reason, role-filtered walkthrough for "come back later".

**Local AI detection, fit and verification**

| Project | Licence | Maturity | What we take |
|---|---|---|---|
| Ollama (https://github.com/ollama/ollama, API https://docs.ollama.com/api) | MIT | Very mature | `/api/version`, `/api/tags`, `/api/ps`, `/api/show`; sha256-addressed layers verified at pull; its AMD integrated-GPU check is a self-described crude heuristic, so we read GTT ourselves |
| llama.cpp server (https://github.com/ggml-org/llama.cpp) | MIT | Very active | `/health`, `/props`, `/v1/models`; default port changed to 9931 (8080 earlier); `--fit` memory fitting; router mode with a models folder; a known Strix Halo memory cap issue (#18159) |
| gguf-parser-go (https://github.com/gpustack/gguf-parser-go) | MIT | Active, used by LocalAI | Header-only ranged reads for weights and KV cache estimates |
| llmfit (https://github.com/AlexsJones/llmfit) | MIT | Popular, active | Fit bands (60, 85, 98 percent), quantization ladder, bandwidth-based speed with a 0.55 factor, measured benchmark replacing estimates; we add unified memory, which it lacks |
| LM Studio (https://lmstudio.ai/docs/developer/rest/list, `lms` CLI MIT) | App closed, CLI MIT | Mature | `/api/v1/models` fields; load-time memory estimate and resource guardrails |
| Lemonade (https://github.com/lemonade-sdk/lemonade) | Apache 2.0 | Active, AMD-backed | Port 13305 (8000 earlier), backend report for ROCm, Vulkan and NPU on Strix Halo |
| vLLM (https://docs.vllm.ai) | Apache 2.0 | Mature | `/health`, `/version`, `/v1/models`; list only |
| NVIDIA NIM (https://docs.nvidia.com/nim/large-language-models/) | NVIDIA terms | Mature | `/v1/health/ready`, `/v1/models`; memory-aware profile selection |
| Open WebUI (https://docs.openwebui.com) | Open WebUI licence | Mature | Configured URLs rather than port scanning; we take named and announced hosts first and scan only policy-listed ranges, with confirmation (6.4.1) |
| Jan (https://jan.ai/docs/desktop/api-server) | Apache 2.0 | Active | Port 1337 with a key |
| Hugging Face `accelerate estimate-memory` (https://huggingface.co/docs/accelerate/usage_guides/model_size_estimator) | Apache 2.0 | Mature | Weights-only estimate for safetensors models |
| OpenSSF Model Signing (https://github.com/sigstore/model-transparency) | Apache 2.0 | v1.0, few signed models yet | Optional signature check beside the required hash |
| AMD Strix Halo guidance (https://rocm.docs.amd.com/en/latest/how-to/system-optimization/strixhalo.html) and NVIDIA DGX Spark known issues (https://docs.nvidia.com/dgx/dgx-spark/known-issues.html) | | | GTT limits and `ttm.pages_limit`; GB10 memory not reported by `nvidia-smi` |

Not verified, to check in planning: exact default ports of LocalAI and GPT4All, whether every Ollama model layer digest equals the GGUF file's sha256, Lemonade's pull API, and the AWS Control Tower setup screens.

# Cohere Model Vault as a third inference endpoint

**Status:** design, for planning. Docs only: nothing here is built yet.
**Written:** 2026-11-20, against `origin/main` at 40d15ef5.
**Fits into:** the model provenance design (`.planning/research/model-provenance/DESIGN.md`: passports, use tiers T0 to T3, hosting classes, Western defaults) and the Phase 70 gate (labels, routing, `checkRoute`, attestation, the trust badge).
**Owner decisions recorded:** 2026-11-20 ("go with your recommendations"), section 2.
**Proposed phases:** 36 and 37 in the 0.4.x line, after Phase 32 (section 14).

## 1. Key points first

1. **What it is.** Cohere Model Vault is a dedicated, Cohere-run model deployment that your organization creates in Cohere's web app, in a region it picks (United States, European Union or Canada), billed per GPU hour. It comes in two kinds: **Standard** (dedicated hardware, data protected in transit and at rest, no attestation) and **Encrypted** (confidential computing with attestation the client checks). Encrypted runs only in the United States today; Canada and the EU are "coming soon".
2. **What we add.** Cohere Model Vault becomes a third provider beside NEAR AI Cloud and a local runtime. Project setup offers NEAR AI, local, Cohere, or any mix of them, and each request goes to the endpoint that the chat's label, the request's use tier and your organization's signed policy allow, picked before anything is sent and recorded. A refused or failed request is never moved to another endpoint by itself.
3. **Encrypted Vault counts as attested**, like NEAR's private hardware and your organization's own attested hosting (`org-tee`), but only while the attestation checks pass. The extension sends through Cohere's own encrypting proxy (the `tng-ingress` container, pinned by digest in your organization's policy), and also checks the attestation token on every answer itself. If either check fails, nothing is sent and the trust badge says why.
4. **Standard Vault is its own class: "sovereign region, not attested".** It is never shown or counted as private hardware. By default it may receive only what your organization's signed policy lets that vault receive, starting below Protected B.
5. **Protected B, stated correctly.** Confidential computing is not what makes a cloud service acceptable for Protected B. In the Government of Canada that comes from the CCCS Medium cloud control profile (formerly PBMM), the Canadian Centre for Cyber Security's cloud service provider assessment process (ITSM.50.100), and the consuming organization's own security assessment and authorization; a contractor also follows its contract's security requirements (the Contract Security Program's security requirements check list). We found no public evidence that Cohere Model Vault holds a CCCS Medium assessment. So **no vault, Standard or Encrypted, receives Protected B unless your organization's signed policy records an authorization for that vault** (assessment reference, the person who authorized it, an expiry), and the route record and trust badge show that authorization. **Classified content never goes to a vault.**
6. **Cost control is manual for now.** Cohere documents no API to pause, resume or rescale a vault; that is done only in the web app. The extension checks that a vault is ready before a run, says plainly when it is not with a button that opens the vault's page, warns after a configurable idle time, and counts estimated vault hours toward the spend limits. A small lifecycle hook (`startBeforeRun`, `pauseAfterIdle`) becomes one setting the day Cohere publishes an API. The extension never scrapes the web app or calls undocumented endpoints.
7. **Model passports** cover every vault model: Cohere's own (Command, North, Embed, Rerank, Parse, Compass, Transcribe) are Canadian; GPT-OSS, Gemma, Phi and Nemotron are US; Ministral, Devstral and Leanstral are French; Qwen, DeepSeek, GLM and MiMo are PRC-origin and T0 only. **Encrypted vaults offer no Command model today, and Nemotron is Standard only**, so the only attested Western chat models on Cohere today are GPT-OSS, Gemma, Phi, Ministral, Devstral and North Mini Code, and only in the US.
8. **Attestation path recommendation:** use Cohere's proxy container for the encrypted transport (it is the path Cohere supports and documents), and add our own independent check in Node of the attestation token, the Sigstore-signed policy release and the pinned proxy image. Do not build our own OHTTP and hardware-evidence verifier in Node now; revisit when Cohere publishes the protocol or a supported JavaScript client (section 7.4).
9. **Build order:** Phase 36 (Standard vaults, setup, routing, the Protected B rule, cost control) after Phase 32, then Phase 37 (Encrypted vaults and attestation). Both in the 0.4.x line, because they need only the Phase 70 gate already on `main`, and the vault model passports plug into Phase 74.1 when it lands (section 14).

## 2. Owner decisions (2026-11-20)

| # | Question | Decision |
|---|---|---|
| 1 | Where Cohere fits | A third provider beside NEAR AI and local. Setup offers NEAR AI, local, Cohere, or any combination; routing picks per request by label, use tier and policy. |
| 2 | Encrypted Vault | An attested boundary like NEAR's TEE and `org-tee`. The extension runs Cohere's OHTTP proxy (`ghcr.io/cohere-ai/tng-ingress`, pinned by digest, `TARGET_URL` = the vault endpoint) or an equivalent verified transport, refuses to send anything when attestation fails, and the trust badge shows it. Research whether Node can verify attestation itself; recommend one path (section 7). |
| 3 | Standard Vault | Its own privacy class, "sovereign region, not attested", never shown or counted as private hardware. What it may receive is set by your organization's signed policy. Default ceiling below Protected B; Protected B only with a recorded authorization; never classified. The same authorization rule applies to an Encrypted vault (attestation proves what runs, not that the service is authorized). |
| 4 | Cost control | No documented pause, resume or rescale API, so: readiness check before a run, a plain not-ready message with an action that opens the vault page, an idle warning, vault hours in the spend limits where they can be estimated, and a provider hook that becomes one setting when Cohere publishes an API. Never scrape or use undocumented endpoints. |
| 5 | Passports | Passports for vault models by origin of the base model, PRC-origin T0 only. |
| 6 | Questions for Cohere | The owner asks them (section 13). |
| 7 | Build order | After Phase 32; phases proposed here and added to ROADMAP.md as planned, not yet planned in detail. |

## 3. What Cohere offers today

Checked on 2026-11-20 against Cohere's public documentation and pricing page. Where a page does not say something, this design says so rather than guessing.

### 3.1 The product

- Model Vault is "a Cohere-managed inference environment" running Cohere models and open models "on isolated, dedicated infrastructure"; "Zero Data Retention is on by default, so prompts and responses are not retained." Standard and Encrypted "share the same deployment and management experience and differ only in data protection." ([Model Vault](https://docs.cohere.com/docs/model-vault))
- A vault is created in the Model Vault app (vault.cohere.com): name, region, models, a GPU per model and a minimum and maximum number of replicas, "with autoscaling available". Once the vault is `Ready`, its endpoint URL and model names are copied from its details page. ([Model Vault](https://docs.cohere.com/docs/model-vault))
- Managing: a vault or a single model can be paused or resumed from its menu in the app; "Pausing a model or a Vault shuts down its replicas and halts all ongoing traffic"; "For encrypted vaults, editing or resuming re-attests the deployment"; editing changes minimum and maximum replicas. No API, CLI or SDK for any of this is documented, nor scale to zero, resume time or billing while paused. ([Managing vaults](https://docs.cohere.com/docs/model-vault/managing-vaults))
- Our earlier research noted a limit of three vaults per organization; the pages cited here do not state a limit, so it is a question for Cohere (C11).

### 3.2 Regions

| Region | Standard | Encrypted |
|---|---|---|
| United States | Available | Available |
| European Union | Available | Coming soon |
| Canada | Available | Coming soon |

The page names no cloud provider or data centre behind each region, only "GPU clusters in that region". ([Regions](https://docs.cohere.com/docs/model-vault/regions))

### 3.3 Standard vaults

- Models: Cohere's Command (including reasoning, multimodal and translation variants), North (including North Mini Code), Embed, Rerank, Parse, Compass, Cohere Transcribe and customized Cohere models; open models DeepSeek, GLM, MiMo, Nemotron, Gemma, GPT-OSS, Phi, Qwen, Ministral, Devstral and Leanstral. Exact model names come from the catalogue when a vault is created, and requests use the name on the vault's details page. "Command A+" is not named on the page. ([Standard supported models](https://docs.cohere.com/docs/model-vault/standard/supported-models))
- Calling: Cohere models at `<vault>/v2/chat` (Cohere API shape) or `<vault>/compatibility/v1` (OpenAI-compatible); open models only at `<vault>/v1/chat/completions` (OpenAI-compatible). Authentication is the Cohere API key as a bearer token. Embed and Rerank are called through the Cohere SDK with the vault as base URL; no HTTP paths are given. **Streaming and tool calling are not mentioned.** ([Standard API access](https://docs.cohere.com/docs/model-vault/standard/api-access))

### 3.4 Encrypted vaults

- **Models:** each on one NVIDIA H100 80 GB in confidential-computing mode: Embed, Rerank, Parse, Compass, North Mini Code, Cohere Transcribe, customized Cohere models; open Gemma, GPT-OSS, Phi, Qwen, Ministral and Devstral. **No Command model and no Nemotron.** ([Encrypted supported models](https://docs.cohere.com/docs/model-vault/encrypted/supported-models))
- **Trust boundary:** a confidential VM (Intel TDX or AMD SEV-SNP) plus an attested NVIDIA GPU in confidential-computing mode; "none of these parties can access your plaintext prompts or responses during inference", including Cohere staff and the cloud provider. Stated residual risks: side channels, physical attacks, observable metadata (timing, sizes, which model), availability ("the infrastructure operator still controls scheduling and can stop or restart the environment"), and closed vendor firmware. ([Encrypted security model](https://docs.cohere.com/docs/model-vault/encrypted/security-model))
- **Transport:** requests and answers are encrypted with Oblivious HTTP (OHTTP) to keys generated inside the confidential VMs and "never shared with Cohere". A client uses either Cohere's proxy container, run locally (`ghcr.io/cohere-ai/tng-ingress`, environment `IN_HOST`, `IN_PORT`, `TARGET_URL=<vault endpoint>`; the docs advise pinning a version in production), or the Python `conseel` transport. With `conseel`, "each inference response includes an attestation certificate under the `x-tng-attestation-token` header". A hosted demo mode (`X-Cohere-Demo-Encrypt: 1`) is "not for production". Streaming and tool calling are again not mentioned. ([Encrypted API usage](https://docs.cohere.com/docs/model-vault/encrypted/api-usage), [Encrypted](https://docs.cohere.com/docs/model-vault/encrypted))
- **Attestation:** two models from the IETF RATS architecture. On AMD SEV-SNP the proxy appraises the evidence itself (launch measurement and vTPM PCRs against AMD's certificate chain), and "the only external verifier you rely on is NVIDIA, for the GPU" (NVIDIA Remote Attestation Service, NRAS). On Intel TDX, Intel Trust Authority (ITA) appraises the evidence (MRTD, RTMR0 to RTMR3) and issues a JWT "signed with PS384" that the proxy checks against ITA's published keys; a non-empty set of matched policies is "the single most important signal". The OHTTP public key is carried in the report data, so the key is bound to the attested environment. If checks fail, "the proxy refuses the connection". ([Attestation](https://docs.cohere.com/docs/model-vault/encrypted/attestation))
- **Policies:** published as signed releases in Cohere's public Integritee repository (Apache 2.0): Rego policies for ITA and for the Trustee CPU and GPU appraisal, reference measurements (`ita_rims.json`), an in-toto provenance predicate, and one Sigstore keyless bundle "over every policy and RIM, verifiable against public Rekor"; releases chain through `previous_rekor_log_index`. The relying-party rule can be evaluated with OPA (`data.ita_rp.allow`). The repository holds no client verifier and no proxy source. ([cohere-ai/integritee](https://github.com/cohere-ai/integritee))

### 3.5 Pricing

Per GPU per hour, US dollars ([pricing](https://cohere.com/pricing)):

| GPU | Standard on demand | Standard promotion | Encrypted on demand | Encrypted promotion |
|---|---|---|---|---|
| L4 24 GB | 3.00 | 1.00 | | |
| A100 40 GB | 3.25 | 2.25 | | |
| A100 80 GB | 3.50 | 2.25 | | |
| MI300X 192 GB | 6.00 | 4.00 | | |
| H100 80 GB | 6.25 | 4.25 | 9.00 | 4.25 |
| H200 141 GB | 7.25 | 5.50 | | |
| B200 192 GB | 9.75 | 8.00 | 12.00 | 8.00 |
| GB200 192 GB | 12.50 | 10.00 | | |

Promotional prices run "through March 31 '27"; reserved capacity and monthly or annual commits are by sales. The page says nothing about minimums or billing while paused. A single H100 replica running all day costs about 150 US dollars at the Standard on-demand rate and about 216 at the Encrypted rate, whether or not anyone sends a request: this is why cost control matters (section 9).

## 4. What the extension does today

Verified on `origin/main`.

- **Providers.** `ProviderKind` in `src/domain/auth.ts` is `near-ai`, `local` or `hybrid` (NEAR AI plus a local runtime, "each model is served by the endpoint that lists it"). A profile has one `baseUrl` and, for hybrid, a `localBaseUrl`. `src/services/providerFactory.ts` builds one `NearAiClient` per endpoint, each told which route it is (`near` or `local`, CLAS-06), with the NEAR client wired to the spend ledger and the connection binding.
- **Project discovery** (`src/services/projectInitialization.ts`) asks "Where may inference run?" with `cloud`, `local` or `hybrid`. Setup steps (`src/services/setupSteps.ts`) are a list (`PROJECT_TEAM_STEP`, `SPENDING_LIMIT_STEP`, `WEB_SEARCH_STEP`) that other features extend with `registerSetupStep`.
- **Routing** (`src/domain/gate/routing.ts`): tiers `any-cloud`, `attested-cloud`, `local-only`, `deny`. The shipped table sends `org/Public` to any cloud; `org/Internal`, `org/Confidential`, Protected A and NATO Unclassified to attested cloud; Protected B and above, every classified level and NATO Restricted and above to local only. `decideAttested` accepts only a TEE model on NEAR's own endpoint with no failed attestation and a fresh bound connection (D-50), or a local model.
- **Attestation** (`src/services/attestation.ts`) verifies NEAR's TDX quote against Intel's root and the per-answer signature, and binds the TLS connection to the attested key.
- **Trust badge** (`src/domain/gate/trustBadge.ts`): three states, `verified-private`, `model-verified` and `not-verified`, with titles and sentences that SECURITY.md and README carry word for word (a test keeps them equal). Every sentence names NEAR AI Cloud.
- **Spend**: `nearAi.dailySpendLimitUsd`, `nearAi.agent.maxRunCostUsd` and `nearAi.agent.maxRunTokens`, estimated from NEAR's published per-token prices (`src/services/spendLedger.ts`, `OutboundGuard`). Nothing knows about per-hour billing.
- **Model passports** are designed (Phase 74.1) with hosting classes `nearai-tee`, `org-tee`, `org-plain`, `closed-api` and `local`; none fits a vendor-run dedicated deployment.

## 5. Provider and routing design

### 5.1 Profiles: endpoints, not one URL

A profile keeps its current fields and gains an optional list of vaults. Old profiles load unchanged; `hybrid` keeps its meaning.

```ts
export type ProviderKind = 'near-ai' | 'local' | 'hybrid' | 'cohere-vault';

export interface VaultEndpoint {
  vaultId: string;              // ^vault-[a-z0-9-]{1,40}$, our id, stable
  displayName: string;          // "Canada standard", as the person names it
  provider: 'cohere';
  kind: 'standard' | 'encrypted';
  region: 'US' | 'EU' | 'CA';
  endpoint: string;             // https URL from the vault's details page
  vaultPageUrl?: string;        // the vault's page in Cohere's app, opened by the "Open vault page" action
  models: VaultModel[];         // typed or pasted from the details page; no listing API is documented
  billing?: { gpuHourUsd: number; gpusPerReplica: number; minReplicas: number }[]; // per model, from your organization's settings
}

export interface VaultModel { name: string; api: 'cohere-v2' | 'openai-compat' | 'openai-open'; roles?: string[] }
```

- `OrganizationProfile.vaults?: VaultEndpoint[]` (at most 8 entries). `cohere-vault` is a profile with vaults only. A NEAR or hybrid profile may add vaults too, which is how "any combination" works without new kinds for each mix.
- The Cohere API key is stored in SecretStorage under a scope derived from the profile and vault id, like `localKeyScope`, never in settings or project files. One key may serve several vaults of one Cohere organization; the setup offers to reuse it.
- `providerFactory` builds one client per vault with `route: 'vault'` and the vault's facts (kind, region, vault id). For an Encrypted vault the client's base URL is the local proxy (section 7), never the vault endpoint directly.
- **Model ids are namespaced** so the same open model on two endpoints can never be confused: `vault:<vaultId>/<model name>` in the picker, records and settings. The `api` field picks the path: `cohere-v2` uses `/v2/chat`, `openai-compat` uses `/compatibility/v1`, `openai-open` uses `/v1/chat/completions`.

### 5.2 Picking an endpoint per request

The choice is made once, before sending, from facts the extension holds:

1. **Candidates.** Every (endpoint, model) pair that serves the role the request needs (chat, standard, deep, fast, embed, rerank, transcription, vision), from the role's preference list. Your organization's policy can order endpoints per role (`defaults` in `ceiling.models`, model provenance design 5.1), and a person can pin a model for a chat as today.
2. **Label.** `decideRoute` with the session's mark and the new vault facts (5.3). A candidate that does not satisfy the mark is dropped.
3. **Use tier.** When Phase 74.1 is on, `decideModelUse` drops a candidate whose passport does not cover the tier or whose `hosting` does not match the route (`vendor-tee` or `vendor-region`, section 6.1).
4. **Readiness.** A vault candidate whose last readiness check (section 9.2) says not ready is dropped, and the reason is kept for the card.
5. **Pick** the first remaining candidate in preference order. If none remain, the person sees the empty-state card of the model provenance design (8.5) with vault-specific lines added ("Your Canada standard vault is paused. [Open vault page]").

Rules that keep this honest:

- **No silent fallback.** If the chosen endpoint fails after sending (an error, a paused vault, an attestation failure), the request is not resent to another endpoint by itself. The card names what failed and offers the allowed alternatives; the person's choice applies to that chat and is recorded.
- **Never a weaker class by default.** When an attested candidate and a not-attested candidate both satisfy the label, the preference order decides, and the shipped order puts `local`, then attested (`nearai-tee`, `org-tee`, `vendor-tee`), then `vendor-region`, then `closed-api`. Your organization may reorder in its signed policy.
- **One request, one endpoint.** A run may use several endpoints (a sub-agent on a vault, the lead on NEAR), and each request is routed and recorded on its own, as helpers are today.
- **Records.** The route record (`src/domain/gate/record.ts`) gains `endpoint` (`near`, `local`, `vault`), `vaultId`, `vaultKind`, `region`, `hosting`, `attestation` (for Encrypted: verdict, platform, policy release, token hash) and `authorization` (section 6.3) when one was used.

### 5.3 Routing facts and decisions

`RouteFacts` gains `clientRoute: 'vault'` with `vault: { id, kind, region }`, plus for Encrypted `vaultAttestation: { state: 'verified' | 'failed' | 'unavailable', at, policyRelease }`. `decideRoute` changes in one place:

| Session tier | Standard vault | Encrypted vault |
|---|---|---|
| `any-cloud` | allowed, unless the vault's ceiling (6.2) excludes a level in the mark | allowed, same ceiling rule |
| `attested-cloud` | refused (`route.vault-not-attested`), unless **every** label in the mark that needs `attested-cloud` is listed in the vault's `acceptLevels` (then `route.vault-policy`) | allowed when the attestation is verified and fresh (`route.attested-vault`), and every level is within the ceiling; otherwise refused (`route.vault-attestation-failed`, `route.vault-ceiling`) |
| `local-only` | refused, unless the level is Protected B and a valid authorization for this vault covers it (`route.vault-authorized`) | same |
| `deny` | refused | refused |

A mark with several labels must pass for each label; the strictest result wins, as `tierForMark` does today. Protected C, every `ca-classified` level and NATO Restricted and above can never reach a vault: the policy parser refuses a bundle that lists them for a vault (6.2), and `decideRoute` refuses them again (`route.vault-never`), so a parser bug cannot open them.

Refusal sentences, in the style of today's:

| Rule | Sentence |
|---|---|
| `route.vault-not-attested` | Nothing was sent. This chat is {label}, which your organization sends only to attested private hardware, and {vault} is a sovereign-region vault that is not attested. |
| `route.vault-ceiling` | Nothing was sent. Your organization's rules do not let {vault} receive {label}. |
| `route.vault-attestation-failed` | Nothing was sent. {vault} could not prove it is running inside confidential computing hardware: {cause}. |
| `route.vault-authorization-missing` | Nothing was sent. {label} may go to {vault} only with an authorization recorded in your organization's rules, and there is none (or it ended on {date}). |
| `route.vault-never` | Nothing was sent. {label} never goes to a hosted model service. |
| `route.vault-not-ready` | Nothing was sent. {vault} is not running (it may be paused or still starting). [Open vault page] [Check again] |

## 6. Privacy classes and the Protected B rule

### 6.1 Hosting classes

The model provenance design's hosting classes (8.3) gain two:

| Class | Meaning | Satisfies `attested-cloud` | Shown as |
|---|---|---|---|
| `vendor-tee` | A model service the vendor runs on confidential-computing hardware dedicated to your organization, attestation checked by the extension on every answer (Cohere Encrypted Vault) | Yes, only while verified and fresh | "Private: Cohere Encrypted Vault, {region}, verified" |
| `vendor-region` | A model service the vendor runs on hardware dedicated to your organization in a named region, not attested (Cohere Standard Vault) | No | "Sovereign region, not attested: Cohere vault, {region}" |

Neither is ever labelled "private hardware" in the picker, the directory or the badge unless it is `vendor-tee` with a verified attestation. `nearAi.privacyMode: tee-only` blocks `vendor-region` exactly as it blocks forwarded models.

Region is a contractual fact recorded in your organization's policy. Attestation proves code and hardware, not location (model provenance design 8.3), so the extension never claims to have checked where a vault is.

### 6.2 The vault entry in the signed policy

Vaults that may receive labelled content are named in the policy bundle under a new optional `routing.vaults` list, parsed with the strict key checks of `checkKeys` (an unknown key, a wrong type or a value out of range refuses the whole bundle). A bundle without the key keeps today's behaviour: vaults receive only `any-cloud` content.

```json
"routing": {
  "vaults": [
    {
      "id": "vault-ca-standard",
      "provider": "cohere",
      "kind": "standard",
      "region": "CA",
      "host": "<the vault endpoint's host, exact>",
      "acceptLevels": ["org/Public", "org/Internal"],
      "authorizations": []
    },
    {
      "id": "vault-us-encrypted",
      "provider": "cohere",
      "kind": "encrypted",
      "region": "US",
      "host": "<exact host>",
      "acceptLevels": ["org/Public", "org/Internal", "org/Confidential"],
      "attestation": {
        "proxyImage": "ghcr.io/cohere-ai/tng-ingress@sha256:<64 hex>",
        "policyRepository": "cohere-ai/integritee",
        "policySigner": "<Sigstore certificate identity of the release workflow>",
        "platforms": ["tdx", "sev-snp"],
        "maxTokenAgeSeconds": 600
      },
      "authorizations": []
    }
  ]
}
```

| Key | Rule |
|---|---|
| `id` | Matches the profile's `vaultId`. |
| `host` | Exact host, never a wildcard. A request to a host no entry names is a vault with no entry: `any-cloud` content only. |
| `acceptLevels` | The levels this vault may receive. **Allowed values:** `org/Public`, `org/Internal`, `org/Confidential`, `ca-protected/Protected A`, `nato/NATO Unclassified`, and `ca-protected/Protected B` only when an authorization below covers it. **Refused by the parser:** `org/Restricted`, `ca-protected/Protected C`, every `ca-classified` level, NATO Restricted and above. For an Encrypted vault the list can only narrow what `attested-cloud` already allows. For a Standard vault it is a per-vault exception to the routing table, signed by your organization; that is narrower than what your organization can already do today by relaxing the table for every endpoint. |
| `attestation` | Required for `kind: encrypted`, refused for `standard`. Section 7. |
| `authorizations` | Section 6.3. |

**Shipped defaults when a person adds a vault in setup** (written through Edit Policy as a `policy.edit` record, like the model provenance "adopt the Western defaults" card): a Standard vault gets `org/Public` and `org/Internal`; an Encrypted vault gets `org/Public`, `org/Internal` and `org/Confidential`. Protected A is a checkbox left unticked, with the sentence "Tick only if your organization's rules allow Protected A in this service." Protected B is not a checkbox: it needs an authorization. Classified levels are not offered.

### 6.3 Protected B authorization

The rule, as SECURITY.md will state it: confidential computing protects data from the operator and proves what code runs; it does not make a service acceptable for Protected B. Acceptance comes from the CCCS Medium cloud control profile and the CCCS assessment of the cloud service provider (ITSM.50.100), together with the consuming organization's own security assessment and authorization, and for a contractor the security requirements of its contract (the security requirements check list under the Contract Security Program). We found no public evidence that Cohere Model Vault holds a CCCS Medium assessment (question C9). So:

```json
{
  "id": "pb-auth-2026-007",
  "vault": "vault-ca-standard",
  "level": "ca-protected/Protected B",
  "assessment": {
    "kind": "cccs-medium",
    "reference": "<assessment report or decision record reference>",
    "organizationAuthorization": "<your organization's authorization decision reference>",
    "contractRequirements": "<contract security requirements reference, optional>"
  },
  "scope": { "projects": ["<project id>"], "useTiers": ["T1", "T2"] },
  "conditions": ["Zero Data Retention on", "region CA only"],
  "authorizedBy": { "name": "<named person>", "role": "<role>", "key": "<fingerprint>" },
  "signature": "<base64url Ed25519 over the canonical authorization>",
  "issuedAt": "2026-12-01T00:00:00Z",
  "expiresAt": "2027-12-01T00:00:00Z"
}
```

- `level` may only be `ca-protected/Protected B`. Nothing above it can be authorized for a vault, in any field.
- `assessment.kind` is one of `cccs-medium` (the vault holds a CCCS Medium assessment your organization relies on), `organization-assessment` (your organization assessed the service itself) or `contract` (the contract's security requirements authorize it); `reference` and `organizationAuthorization` are required for every kind.
- `expiresAt` at most 365 days after `issuedAt`; any change of the vault's `kind`, `region` or `host` in a new bundle ends it.
- Signed by the named person's own key (Phase 69's device key now, Phase 71's credential later), and carried in a bundle your organization's issuer signs; both must verify (the T1 acceptance precedent of the model provenance design 5.3).
- The same rule applies to Encrypted vaults: attestation is checked as well, never instead.
- The route record carries the authorization id and hash; the trust badge's first reason line says "Protected B allowed for {vault} by {name}'s authorization {reference}, until {date}."
- An expired, out-of-scope or unverifiable authorization refuses with `route.vault-authorization-missing` and is never treated as `acceptLevels`.

### 6.4 Residency

The extension does not decide residency by itself. Your organization expresses it through `acceptLevels`: for example, a US Encrypted vault with only `org/Public` and `org/Internal` keeps Protected A in Canada even though the vault is attested. The setup shows the region beside every vault, and the badge names it on every answer.

### 6.5 Trust badge

Today's three states stay as they are for NEAR. For vaults:

- **Encrypted, verified** (proxy accepted the attestation, the extension's own token check passed, section 7.3): `verified-private`, with a vault sentence: "This answer came from your organization's Cohere Encrypted Vault in {region}. Its attestation was checked by Cohere's proxy and again by this extension, and your request was encrypted to a key that only that attested hardware holds."
- **Encrypted, token check passed but the proxy's identity could not be confirmed** (the image digest or the listener check of 7.2 did not hold for this session): the request is refused before sending, so there is no answer and no badge.
- **Standard**: a new fourth state, **"Sovereign region, not attested"**, ranked with `not-verified` (rank 0, never above it), explanation: "This answer came from your organization's Cohere vault in {region}. That vault runs on hardware dedicated to your organization but is not attested, so this extension cannot check what runs there." Recommendation: add the state rather than reuse "Not verified", because "Not verified" reads like a failed check on every answer and people learn to ignore it. This changes the owner's three-state CLAS-08 contract, so it is open decision D1 (section 15).

The `TRUST_BADGE_TEXT` sentences that name NEAR AI Cloud become per-provider, chosen in `trustBadgeFor` from the route record, and SECURITY.md and README carry the new ones word for word.

## 7. Attestation path for Encrypted vaults

### 7.1 Options

| Option | What it is | For | Against |
|---|---|---|---|
| A. Cohere's proxy container | Run `tng-ingress` locally, pinned by digest, `TARGET_URL` = the vault; the extension talks plain HTTP to it on loopback | The path Cohere documents and supports; handles OHTTP, SEV-SNP evidence, NVIDIA NRAS, ITA tokens and the Sigstore policy releases; Cohere keeps it current | Needs Docker or Podman on the machine running the extension host (often absent in a code-server container); the extension cannot see inside the proxy's verdict except by its refusal; a loopback port could be taken by another process |
| B. Our own verifier in Node | Implement OHTTP (HPKE, RFC 9458), fetch the key configuration with its evidence, check AMD SEV-SNP and Intel TDX evidence or the ITA token, call NRAS for the GPU, fetch and Sigstore-verify the Integritee release, evaluate the policies | No container; the verdict is ours and can feed the badge directly | Cohere publishes no protocol specification for the key and evidence exchange, and the Integritee repository holds no client verifier; we would track an undocumented, changing protocol; HPKE and SEV-SNP chain checking are large and security-critical; any drift means false refusals or, worse, false passes |
| C. Upstream TNG JavaScript SDK | The open-source TNG project (`inclavare-containers/TNG`, Apache 2.0, Rust core) has a JavaScript SDK built on WebAssembly that speaks its RA-TLS and OHTTP modes | Could run in the extension host without a container | Unconfirmed that Cohere's `tng-ingress` is TNG or which extensions Cohere added (ITA tokens, Integritee releases); a WebAssembly blob in the trust path needs the same review as any downloaded code; question C7 |
| D. Hosted demo header | `X-Cohere-Demo-Encrypt: 1` | None for us | Cohere says not for production; the client verifies nothing. **Never used.** |

### 7.2 Recommendation: A, plus our own independent check

Use the proxy for the transport, and do not rely on it alone:

1. **Pinned image.** The proxy image is named by digest in the signed policy (`attestation.proxyImage`). The extension refuses a tag, and refuses to start an image whose pulled digest differs.
2. **Started by the extension, on a random loopback port.** The extension starts the container itself with a fixed argument list (no shell): `-p 127.0.0.1:<random port>:8080`, `IN_HOST=0.0.0.0`, `IN_PORT=8080`, `TARGET_URL=<vault endpoint>`, a read-only root filesystem and no extra mounts. It then checks with `docker inspect` (or Podman) that the running container has the pinned digest and owns that port mapping, before any request. Another process holding the port, a different image, or a container it did not start: nothing is sent.
3. **Fail closed.** The proxy refuses the connection when attestation fails; the extension treats a refused, reset or non-OHTTP answer from the proxy as `route.vault-attestation-failed`, never as a reason to try the vault endpoint directly. The vault endpoint itself is never called without the proxy for an Encrypted vault: the client for that vault has only the proxy URL.
4. **Independent token check in Node** on every answer, from the attestation token the transport returns (`x-tng-attestation-token` is documented for `conseel`; whether the proxy passes it through is question C7):
   - TDX: verify the ITA JWT signature (PS384) against Intel Trust Authority's published keys with `node:crypto`, check expiry and `maxTokenAgeSeconds`, check that the matched policies are non-empty and include the policy names and hashes of the current Integritee release, and evaluate the relying-party rule against that release's reference measurements. The Rego rule is small; we port it to TypeScript and test it against the release's own `opa eval` results, rather than embedding OPA.
   - SEV-SNP: the token format is not documented; until Cohere answers C7 the extension accepts the proxy's verdict for SEV-SNP and the badge's reason line says "checked by Cohere's proxy; this extension could not check it again". Your organization can set `platforms: ["tdx"]` to refuse SEV-SNP vaults until then.
   - Integritee release: fetch the release, verify the Sigstore bundle against the public-good Sigstore root with a pinned certificate identity (`policySigner`) and the Rekor inclusion proof, and check the chain (`previous_rekor_log_index`) never goes backwards. Verified with the `sigstore` npm package (Sigstore's own JavaScript client), pinned, reviewed and listed in the SBOM; GitHub is an availability dependency, not a trust one, as Cohere says, so a cached verified release is used while GitHub is unreachable, until it expires.
5. **Verdict feeds routing and the badge.** `vaultAttestation.state` is `verified` only when steps 1 to 4 hold for this vault within `maxTokenAgeSeconds`; that is the "fresh bound fact" for vaults, the analogue of D-50.

### 7.3 Why not B now, and when to revisit

B would make the extension implement a security protocol that Cohere has not specified publicly, with hardware-evidence parsing for two CPU platforms and a GPU service; every Cohere-side change would break us silently or, worse, pass something it should not. A gives Cohere's maintained verifier plus our own second check of the parts that are documented and stable (a JWT, a Sigstore bundle, published reference values). Revisit when Cohere publishes the evidence exchange or a supported JavaScript or WebAssembly client (question C7); at that point option C or B can replace the container, behind the same `VaultTransport` interface, with no change to routing or records.

### 7.4 Where there is no container runtime

When neither Docker nor Podman is available to the extension host (common in a code-server container), Encrypted vaults are unavailable on that machine, the setup step says so in one sentence with what to install, and the vault is never used without its proxy. A shared proxy on another host is not supported in the first release: it would move the encryption point off this machine, which is a different trust model (question for the owner, D4).

### 7.5 Interface shared with Phase 74.2

`VaultTransport` (`start`, `check`, `fetch`, `stop`, `verdict`) is written so Phase 74.2's `org-tee` verifier can sit behind the same interface: both produce the same `AttestationVerdict` shape (platform, measurements, policy or reference values used, token or quote hash, time), and `decideRoute` reads only the verdict.

## 8. Streaming and tool calling

Vault pages do not say whether streaming or tool calling work. Agents need tool calling; chat expects streaming. Until Cohere answers (C6):

- The client probes once per vault model at setup, with a documented request carrying a fixed, harmless tool definition and `stream: true`, and records what worked.
- A model without tool calling is offered only for roles without tools (plain chat, embed, rerank, transcription, the safety classifier); a model without streaming shows its answer when complete, with a "this model does not stream" note.
- The probe uses only documented paths and fixed content, never project data.

## 9. Cost control

### 9.1 What we can and cannot do

Cohere documents no API to pause, resume or rescale (3.1). The extension therefore **never** starts or pauses a vault itself, never scrapes vault.cohere.com, and never calls an undocumented endpoint. Everything below uses documented inference calls and your organization's own settings.

### 9.2 Readiness check

- Before a run that will use a vault, and when a chat first routes to it, the extension sends one tiny documented request with fixed content (a one-token chat completion, or an embed of a fixed word for an embedding-only vault). For an Encrypted vault it goes through the proxy, so it also proves the attestation.
- Result states: `ready`, `not-ready` (an error that means no replica serves: the exact responses are question C2, and until answered any connection failure, 5xx or timeout counts as not ready), `unauthorized` (key wrong), `unknown`.
- Results are cached for 2 minutes; a failed request during a run refreshes it.
- Not ready shows: "Your {vault} vault is not running. It may be paused, or starting after a resume. Cohere has no way for this extension to start it, so open the vault page and resume it there." [Open vault page] [Check again] [Use another allowed model]. The run does not start; nothing waits forever: the card stays until the person acts, and "Check again" re-probes.

### 9.3 Idle warning

- `nearAi.cohere.idleWarningMinutes` (default 30, 0 turns it off). After that long with no request to a vault the extension has seen ready, it shows once: "Your {vault} vault has had no requests from this editor for {n} minutes and costs about {rate} US dollars an hour while it runs. Pause it in Cohere's app if nobody else is using it." [Open vault page] [Keep running] [Do not remind me today].
- The warning says "from this editor" because other people may be using the same vault; the extension cannot see their traffic.

### 9.4 Vault hours in the spend limits

- The cost estimate per vault is `sum over models of gpuHourUsd x gpusPerReplica x minReplicas`, from your organization's settings (`billing` in the vault entry; rates from Cohere's price list or your contract). Without these settings the vault's cost is "unknown", and the spend view says so.
- **Observed window:** from the first `ready` check until a check sees it not ready, or until the person answers the idle warning with "I paused it". The estimate covers only this window and only the minimum replicas, so it is a floor: autoscaling above the minimum and time nobody on this computer observed are not counted. The spend view says "estimate from this editor; Cohere's bill is the actual figure."
- The estimate counts toward `nearAi.dailySpendLimitUsd`. When the limit is reached, new requests to the vault stop with the existing limit sentence plus: "Stopping requests does not stop the vault's hourly charge. [Open vault page]".
- Per run: a run's `maxRunCostUsd` counts its vault time as the run's wall-clock share of the observed window, so a long run on a vault is stopped like a long run on NEAR.
- Recorded in the spend ledger as `vault-hours` entries keyed by `vaultId`, so two chats in one editor never count the same hour twice. Across editors and people, the existing limitation stands (SECURITY.md: the daily limit counts the editor it runs in).

### 9.5 The lifecycle hook

```ts
export interface VaultLifecycle {
  readonly control: 'manual' | 'api';
  readiness(vault: VaultEndpoint): Promise<VaultReadiness>;
  /** Only when control is 'api': ask the provider to resume, then wait for ready up to a timeout. */
  startBeforeRun?(vault: VaultEndpoint, signal: AbortSignal): Promise<'ready' | 'timed-out' | 'refused'>;
  /** Only when control is 'api': pause after the idle time, if no run in this editor is using the vault. */
  pauseAfterIdle?(vault: VaultEndpoint): Promise<'paused' | 'in-use' | 'refused'>;
}
```

- Ships with `manual` only: readiness by probe, "start" and "pause" are the Open vault page action.
- When Cohere publishes a management API, an `api` implementation is added and one setting turns it on (`nearAi.cohere.vaultControl: "manual" | "api"`), with a separate management key in SecretStorage. `startBeforeRun` runs only after a person agrees once per vault (it spends money), and `pauseAfterIdle` never pauses a vault while a run in this editor uses it. Because other people may share the vault, auto-pause stays off by default even then (open decision D3).

## 10. Setup UX for NEAR AI, local and Cohere

### 10.1 The step

Project setup's "Where may inference run?" becomes a set of ticks instead of one choice: **NEAR AI Cloud**, **This computer or your organization's server (local)**, **Your organization's Cohere vault**. Any mix is allowed; at least one is required. Old answers map exactly: `cloud` to NEAR, `local` to local, `hybrid` to NEAR and local.

Ticking Cohere opens a short form per vault:

1. Name, kind (Standard or Encrypted), region (from the vault's details page).
2. Endpoint URL and the vault page URL (pasted from Cohere's app).
3. Cohere API key (or reuse one already stored for another vault).
4. Models: pasted names from the details page, each with its API shape; the passport each matches is shown beside it, with origin and highest use tier, and a PRC-origin model is labelled "research only" (section 11).
5. What this vault may receive (6.2 defaults, Protected A unticked, Protected B through "Record an authorization", classified not offered).
6. Billing: GPU type, GPUs per replica, minimum replicas, hourly rate (prefilled from the price list, editable).
7. For Encrypted: checks that Docker or Podman is present, pulls the pinned image, starts the proxy and runs the readiness check, which proves the attestation; the step shows the verdict in plain words.

Then "Check connection" runs readiness for every endpoint ticked, and the summary says, per endpoint, which labels can go there and why.

### 10.2 Combinations and what the person sees

| Mix | Typical use | What routing does by default |
|---|---|---|
| NEAR only | Today | Unchanged |
| Local only | Air-gapped or Protected B on this computer | Unchanged |
| NEAR and local (hybrid) | Today | Unchanged |
| Cohere Standard (Canada) only | Canadian residency, no attestation needed for the work | Public and Internal go to the vault (as set in the policy); anything needing attested hardware has no endpoint, and the card says so |
| Cohere Encrypted (US) only | Attested, Western open models | Attested labels go there while verified; residency set by `acceptLevels` |
| NEAR and Cohere Standard | NEAR for attested work, Canadian vault for Command and Canadian residency at Public and Internal | Preference order per role; attested labels to NEAR's TEE |
| Local and Cohere | Protected B locally, the rest on the vault | Protected B stays local unless an authorization exists |
| All three | Organization-wide | Preference order per role, each request recorded with its endpoint |

When a project's team member is pinned to a model on an endpoint the project did not tick, the member's check fails before the run with the reason, as a pinned forbidden model does today.

### 10.3 Organization rollout

An administrator adds vaults once in your organization's signed policy (`routing.vaults`) and shares the profile; each person adds only the API key. The setup step reads vault entries from the policy and pre-fills the form, so people do not retype endpoints. A vault in a profile but not in the policy works only for `any-cloud` content, and setup says so.

## 11. Model passports for vault models

Shipped passports extend the model provenance design's table (5.5). Exact ids are pinned per vault from the details page; passports match exact, anchored names, never brands (8.2 of that design).

| Family | Origin | Standard | Encrypted | Shipped `maxTier` | Notes |
|---|---|---|---|---|---|
| Command (A, A+, reasoning, vision, translate) | CA | Yes | **No** | T2 | Licence per model: Command A+ Apache 2.0; Command A Vision was released under a non-commercial licence (check before use); hosting `vendor-region` only |
| North, North Mini Code | CA | Yes | North Mini Code only | T2 | Cohere's own generative models; licence and base to confirm (C10) |
| Embed, Rerank, Parse, Compass | CA | Yes | Yes | T2 | The Western embedding and reranking choice the model provenance design names as second choice; switching embeddings rebuilds the knowledge base index |
| Cohere Transcribe | CA | Yes | Yes | T2 | Alternative to Whisper |
| Customized Cohere models | base's origin | Yes | Yes | T0 until your organization signs a passport | `lineage.method` must say how it was made |
| GPT-OSS (120b, 20b) | US | Yes | Yes | T2 | As in the model provenance design |
| Gemma | US | Yes | Yes | T2 | Gemma Terms of Use, not an open source licence: put on the allowed list or not |
| Phi | US | Yes | Yes | T2 | MIT |
| Nemotron 3 | US | Yes | **No** | T2 | Exact ids only; Llama-Nemotron and OpenReasoning-Nemotron are different lineages (the latter PRC-origin, T0) |
| Ministral, Devstral, Leanstral | FR | Yes | Ministral and Devstral | T2 | Licences differ per model (some Apache 2.0, some Mistral's own licences): check each |
| Qwen | CN | Yes | Yes | T0 | Research lane only |
| DeepSeek | CN | Yes | No | T0 | Research lane only |
| GLM | CN | Yes | No | T0 | Zhipu on the US Entity List |
| MiMo | CN (Xiaomi) | Yes | No | T0 | Research lane only |

Consequences, stated plainly in the setup and the README:

- **For attested Western chat on Cohere today**, the choices are GPT-OSS, Gemma, Phi, Ministral, Devstral and North Mini Code, and only in a US Encrypted vault.
- **Command A+ and Nemotron on Cohere are Standard only**: sovereign region, not attested.
- **Before Phase 74.1 lands** there is no passport enforcement. Phase 36 ships the passport rows as data for Phase 74.1's WP-0, and in the meantime setup labels PRC-origin vault models "research only under the model provenance rules", never offers them as defaults, and the model picker shows their origin.

The different-lineage rule (model provenance design 9) gains a convenient pair on one vault: Command on a Standard vault checked by GPT-OSS or Nemotron on the same vault.

## 12. Security, and the SECURITY.md and README changes

### 12.1 Threats and handling

| Threat | Handling |
|---|---|
| A Standard vault is mistaken for private hardware | Own class and badge state; `tee-only` blocks it; never in the "private" list |
| Labelled content reaches a vault it should not | `routing.vaults` ceilings, parser refusals for Restricted, Protected C and classified, a second refusal in `decideRoute`, route records |
| Protected B goes to a vault on attestation alone | Authorization required for any vault; attestation is an extra check, never a substitute |
| The proxy is swapped or another process takes its port | Digest pinned in the signed policy, started by the extension, `docker inspect` check of image and port before every session, random port |
| The proxy accepts a bad attestation | Our own token and Sigstore checks (7.2); SEV-SNP stated as proxy-only until C7 |
| The proxy image is compromised upstream | Digest pinning; your organization moves the pin only by a new signed bundle; question C8 asks for its source, SBOM and signatures |
| Attestation fails and the request goes to the plain endpoint | The Encrypted vault's client has only the proxy URL; no code path calls the vault endpoint directly |
| API key leaks | SecretStorage only, scoped per profile and vault; never in settings, project files, records or logs (the redacting logger already covers bearer tokens) |
| A vault answer is treated as more trusted than it is | Outside content rules apply to answers as for every model |
| Billing runs while idle | Readiness, idle warning, spend estimates, the plain "stopping requests does not stop the hourly charge" sentence |
| A container runtime is a large privilege | Fixed argument lists, no shell, no mounts, loopback-only publish; Encrypted is unavailable rather than weakened where there is no runtime |

### 12.2 Supply chain note on the proxy

The proxy image's name (`tng-ingress`) and its ingress/egress vocabulary match the open-source TNG project (`inclavare-containers/TNG`, Apache 2.0). Inclavare Containers began as an Alibaba Cloud and Ant Group open-source project. That does not make the proxy unsafe (it is open source and Cohere ships it), but under the owner's provenance rules software in the trust path deserves the same scrutiny as a model: we ask Cohere for the proxy's source, build provenance, SBOM and signatures (C8), pin by digest, and record the image digest in every route record for an Encrypted vault.

### 12.3 SECURITY.md changes (in the phases, not now)

- **Where your data goes**: rows for a Standard vault and an Encrypted vault: what is sent, where, under which key, Zero Data Retention as Cohere states it, the region, and that the region is a contractual fact.
- **Which models are private**: the two new classes, with the sentence "A Standard vault is not private hardware."
- **The trust badge**: the per-provider sentences and the fourth state (if D1 is accepted), word for word.
- **Classification labels and routing**: `routing.vaults`, `acceptLevels`, the parser refusals, the Protected B paragraph of 6.3 in full, and "classified content never goes to a hosted model service".
- **The outbound check**: readiness, vault refusal rules.
- **Costs**: vault hours, estimates, the idle warning, and that stopping requests does not stop billing.
- **Dependencies**: the proxy image (pinned digest, where the pin lives) and the `sigstore` package.
- **Verify it yourself**: how to check an Encrypted vault's attestation with Cohere's tools and the Integritee release with `opa eval`.
- **Known limitations**: no lifecycle API, estimates are a floor, SEV-SNP proxy-only, Encrypted US-only, streaming and tools per model.

### 12.4 README changes

The provider section gains "Your organization's Cohere vault" with the setup steps, the class names in plain words, the combinations table, and the Protected B sentence; "Good to know" gains the cost note.

## 13. Questions for Cohere

| # | Question |
|---|---|
| C1 | Is there, or will there be, a management API (or CLI) to pause, resume and set minimum and maximum replicas, including a minimum of zero? With what authentication and scopes? |
| C2 | How long does a resume take for a typical model (Standard and Encrypted)? What does an inference request to a paused or starting vault return (status and body), so we can say "paused" rather than "not ready"? |
| C3 | Is anything billed while a vault or a model is paused, or while scaled to zero? Is billing per second, per minute or per started hour? |
| C4 | When will Encrypted vaults be available in Canada, and on which GPUs? |
| C5 | Will Command models, Command A+ in particular, be offered in Encrypted vaults? Nemotron? |
| C6 | Are streaming and tool calling supported on vault endpoints (`/v2/chat`, `/compatibility/v1`, `/v1/chat/completions`), for Cohere and open models, Standard and Encrypted? |
| C7 | Can a client verify attestation without the proxy container? Is the key and evidence exchange documented? Does the proxy pass the `x-tng-attestation-token` header through, and what is the token format for SEV-SNP? Is there a supported JavaScript or WebAssembly client, and is the proxy built on the open-source TNG project? Can a token be bound to a specific request? |
| C8 | Where is the proxy's source, how is the image built and signed, and is there an SBOM and build provenance for each release? |
| C9 | Does Model Vault in Canada hold, or is it in the process of obtaining, a CCCS Medium (formerly PBMM) assessment under ITSM.50.100? Can customers receive the assessment report or summary? |
| C10 | Which cloud provider and which facilities run the Canada region (and the US Encrypted region)? Who operates them, and under which jurisdiction is support access given? What are North and North Mini Code's base and licence? |
| C11 | How many vaults may one organization have, and how many models per vault? |
| C12 | Is there a documented way to list a vault's models and its state (`Ready`, paused) through the API, so setup need not ask people to paste names? |

## 14. Phase proposal

### 14.1 Where it lands, and why

**Recommendation: two phases in the 0.4.x line, numbered 36 and 37, built after Phase 32.** Not v0.5.0, because:

- They need only the Phase 70 gate (labels, routing, bundle, badge), which is on `main`, plus the existing provider factory and spend ledger. They need nothing from Phases 71 to 74.
- Phase 74.1 (passports) is not planned yet; tying vaults to it would delay a Canadian option the owner wants now. Instead, Phase 36 ships the vault passport rows as data and the hosting classes in the shared vocabulary, and Phase 74.1 enforces them when it lands. Phase 37's `VaultTransport` and `AttestationVerdict` are reused by Phase 74.2.
- The owner asked for "after Phase 32"; Phases 33 to 35 touch staff files (`src/staff/**`, the hub), and these phases touch providers, routing and setup, so 36 can run beside 33 to 35 in its own worktree and ship in its own 0.4.x release.

Order inside: **Phase 36 first** (Standard vaults are what Canada can use today), then **Phase 37** (Encrypted, US today, Canada when Cohere ships it). Phase 37 depends on 36's provider, routing and policy shape; that is the one sequential link.

### 14.2 Phase 36: Cohere Model Vault provider, sovereign-region class and cost control

**Goal:** Your organization can add Cohere vaults beside NEAR AI and local, each request goes only where the label, use tier and policy allow, a Standard vault is never treated as private hardware, Protected B reaches a vault only with a recorded authorization, and vault running costs are visible and limited.

**Requirements:** CVLT-01 to CVLT-07.

| Id | Requirement |
|---|---|
| CVLT-01 | Profiles carry optional vault endpoints (kind, region, endpoint, models, billing) with keys in SecretStorage; project setup offers NEAR AI, local, Cohere or any combination; old profiles and discovery answers load unchanged. |
| CVLT-02 | Each request picks one (endpoint, model) before sending from label, use tier (when Phase 74.1 is on), vault ceiling, readiness and preference order; a failure is never resent elsewhere by itself; the route record names endpoint, vault, kind, region and hosting. |
| CVLT-03 | The signed bundle accepts optional `routing.vaults` with `acceptLevels`; a Standard vault (`vendor-region`) never satisfies `attested-cloud` except per level through its signed ceiling; `tee-only` blocks it; Restricted, Protected C, classified and NATO Restricted and above are refused by the parser and again by `decideRoute`. |
| CVLT-04 | Protected B reaches any vault only with a valid signed authorization (assessment reference, organization authorization, named person, expiry at most 365 days, scope); the route record and badge show it; an expired or out-of-scope one refuses. |
| CVLT-05 | The badge and model picker show vault answers in their own class ("Sovereign region, not attested", or the owner's choice under D1), with per-provider sentences carried word for word in SECURITY.md and README. |
| CVLT-06 | A readiness check before a run and on first use, a plain not-ready card with Open vault page and Check again, and an idle warning after a configurable time; no undocumented endpoint and no scraping. |
| CVLT-07 | Estimated vault hours count toward the daily and per-run spend limits from your organization's rates, labelled as a floor estimate; the `VaultLifecycle` hook ships with `manual` control and an `api` slot behind one setting. |

**Success criteria:**

1. A person ticks NEAR AI, local and a Canadian Standard vault in setup, adds the key once, and a chat at `org/Public` or `org/Internal` can use Command on the vault while a chat at Protected A is refused for that vault with the ceiling sentence (unless the policy ticks it), and nothing is sent. (CVLT-01, CVLT-02, CVLT-03)
2. A Standard vault answer is never shown as private, `tee-only` blocks it, and a bundle listing Protected C or any classified level for a vault is refused as a whole. (CVLT-03, CVLT-05)
3. Protected B content is refused for every vault without an authorization, allowed with a valid one in scope, refused again after its expiry, and the route record and badge name the authorization. (CVLT-04)
4. A paused vault produces the not-ready card before the run starts, with Open vault page; the idle warning appears after the set time; vault hours appear in the spend view and stop new vault requests at the daily limit with the "does not stop the hourly charge" sentence. (CVLT-06, CVLT-07)
5. Existing NEAR, local and hybrid profiles pass the current suite unchanged, and SECURITY.md and README carry the new sections.

### 14.3 Phase 37: Cohere Encrypted Vault as an attested endpoint

**Goal:** An Encrypted vault counts as attested private hardware only while Cohere's proxy and this extension's own check both prove it, and nothing is sent when they do not.

**Depends on:** Phase 36.

**Requirements:** CVLT-08 to CVLT-11.

| Id | Requirement |
|---|---|
| CVLT-08 | The extension starts Cohere's proxy itself from the digest pinned in the signed policy, on a random loopback port, checks image and port ownership before sending, and the Encrypted vault's client can reach the vault only through it. |
| CVLT-09 | The extension checks the attestation token on every answer (TDX: ITA JWT signature, freshness, matched policies, relying-party rule against the current Integritee release) and verifies the Integritee release's Sigstore bundle against a pinned signer identity and the Rekor chain; SEV-SNP is marked proxy-checked only until Cohere documents its token. |
| CVLT-10 | A verified, fresh Encrypted vault (`vendor-tee`) satisfies `attested-cloud` within its ceiling; any failed step refuses before sending with a plain sentence and never falls back to the plain endpoint or another endpoint; Protected B still needs CVLT-04's authorization. |
| CVLT-11 | The badge shows the vault verdict in plain words; route records carry platform, policy release, token hash and proxy image digest; the `VaultTransport` and `AttestationVerdict` shapes are the ones Phase 74.2 reuses. |

**Success criteria:**

1. With Docker or Podman present, setup starts the pinned proxy, the readiness check proves the attestation, and an `org/Internal` chat is answered with "Verified private model" and the vault sentence. (CVLT-08, CVLT-10, CVLT-11)
2. A different image digest, a port held by another process, a refused proxy connection, an expired or wrongly signed token, an empty policy match, or an Integritee release whose Sigstore bundle does not verify each refuse before sending, with the rule in the record. (CVLT-08, CVLT-09, CVLT-10)
3. Without a container runtime, the Encrypted vault is shown as unavailable on that machine with the reason, and no request reaches its endpoint. (CVLT-08)
4. Protected B to an Encrypted vault is refused without an authorization even when attested. (CVLT-10)

### 14.4 Work packages (both phases)

WP-0 lands first because every other package imports its types; the rest run in parallel worktrees, then one integration. One line on the dependency: WP-0 is the shared contract (profile vault fields, `routing.vaults` schema, hosting classes, route facts), so it cannot run beside its consumers.

| WP | Phase | Scope | Depends on |
|---|---|---|---|
| WP-0 Contract | 36 | Profile `vaults`, `routing.vaults` parser and refusals, authorization schema and signature check, hosting classes, `RouteFacts` vault fields, record fields | None |
| WP-ROUTE | 36 | `decideRoute` vault branch, endpoint picking, refusal sentences | WP-0 |
| WP-CLIENT | 36 | Vault clients in `providerFactory` (three API shapes), streaming and tool probe | WP-0 |
| WP-SETUP | 36 | Setup ticks, vault form, policy pre-fill, Edit Policy defaults, Record an authorization | WP-0 |
| WP-COST | 36 | Readiness, idle warning, vault-hours ledger entries, limits, `VaultLifecycle` | WP-0, WP-CLIENT |
| WP-BADGE | 36 | Per-provider sentences, the new state, SECURITY.md and README text | WP-0 |
| WP-PROXY | 37 | Container start and checks, `VaultTransport` | Phase 36 |
| WP-VERIFY | 37 | ITA JWT check, relying-party rule port, Sigstore release check | Phase 36 |
| Integration | each | Merge, docs, one full verification run | all of the phase |

## 15. Open decisions for the owner, with defaults

| # | Decision | Default if the owner says nothing |
|---|---|---|
| D1 | A fourth trust badge state "Sovereign region, not attested" (changes the three-state CLAS-08 contract) | Add it, ranked with "Not verified" |
| D2 | Setup default ceiling for a Standard vault | `org/Public` and `org/Internal`; Protected A unticked |
| D3 | Auto-pause once Cohere ships an API, given other people may share a vault | Off by default; idle warning only |
| D4 | A shared proxy on another machine for editors without a container runtime | Not supported in Phase 37 |
| D5 | SEV-SNP vaults before Cohere documents the token | Allowed, badge says proxy-checked only; your organization may restrict to TDX |
| D6 | Phase numbering and line | Phases 36 and 37 in 0.4.x after Phase 32 |

## 16. State machines

### 16.1 Vault readiness

States: `unknown`, `checking`, `ready`, `not-ready`, `unauthorized`, `idle-warned`.

| From | Event | To | Effect |
|---|---|---|---|
| unknown | A run or chat routes to the vault | checking | Probe sent |
| checking | Probe answers | ready | Observed window starts if not started |
| checking | Connection error, 5xx, timeout, attestation refusal | not-ready | Card with Open vault page and Check again; run does not start |
| checking | 401 or 403 | unauthorized | Card: the key was refused; Replace key |
| ready | Cache older than 2 minutes and a new run starts | checking | |
| ready | No request for `idleWarningMinutes` | idle-warned | Warning shown once |
| idle-warned | Person: "I paused it" | not-ready | Observed window ends |
| idle-warned | Person: "Keep running", or a new request | ready | |
| not-ready | Check again, or a new run | checking | |
| any | Profile or policy removes the vault | unknown | Window ends; records kept |

No state waits forever: `checking` ends by answer or timeout (20 seconds, the badge's check timeout), and `not-ready` and `unauthorized` wait for a person's action with the card showing.

### 16.2 Encrypted transport

States: `stopped`, `starting`, `checking-identity`, `attesting`, `verified`, `failed`.

| From | Event | To |
|---|---|---|
| stopped | Vault first needed in this window | starting |
| starting | Container running | checking-identity |
| starting | No runtime, pull failed, digest differs | failed (reason shown, nothing sent) |
| checking-identity | Digest and port mapping match | attesting |
| checking-identity | Mismatch | failed |
| attesting | Probe answered and our token check passes (or SEV-SNP proxy-only) | verified |
| attesting | Proxy refuses, token invalid, policy release invalid | failed |
| verified | Token older than `maxTokenAgeSeconds` | attesting (next request re-checks) |
| verified | Any answer's token fails | failed; later requests refused until a fresh check passes |
| failed | Person: Check again | starting or attesting |
| any | Window closes | stopped (container stopped) |

### 16.3 Protected B authorization

States: `none`, `valid`, `expired`, `void`.

| From | Event | To |
|---|---|---|
| none | Signed bundle with a verified authorization for the vault | valid |
| valid | `expiresAt` passes | expired |
| valid | New bundle changes the vault's kind, region or host, or drops the authorization | void |
| expired, void | New signed authorization | valid |
| any | Bundle fails to verify | today's fail-closed routing; no authorization counts |

### 16.4 Request routing with vaults

`received` to `candidates` (role and preferences) to `label-checked` (`decideRoute`, vault ceilings, authorization) to `tier-checked` (passports, when Phase 74.1 is on) to `ready-checked` to `chosen` to `sent` to `recorded`; any check that leaves no candidate goes to `refused` with the card and the alternatives that would pass; `sent` that fails goes to `failed` with the card, never to another candidate by itself.

## 17. Risks

| Risk | Handling |
|---|---|
| Encrypted is US-only for an unknown time | Phase 36 first; Encrypted's `acceptLevels` let your organization keep residency-bound labels away from it |
| No lifecycle API, so idle vaults cost money | Readiness, idle warning, spend estimates, the plain sentence; the hook is ready for an API |
| Vault protocol details change without notice | Only documented paths; the transport behind one interface; probes record what works |
| Streaming or tool calling missing | Probe and restrict roles (section 8) |
| The proxy needs a container runtime | Stated plainly; Encrypted unavailable rather than weakened |
| The proxy is a single trust point | Our own token and Sigstore checks; digest pinning; C7 and C8 |
| People read "Canada" as "Protected B approved" | The Protected B rule, the authorization record, SECURITY.md's paragraph, the badge's region and class |
| Cost estimates are wrong | Labelled as a floor estimate; Cohere's bill is the figure |
| Model ids on a vault do not match passports | Exact names from the details page; unmatched means T0 once Phase 74.1 is on |
| A shared vault is paused by one person while another runs | The not-ready card names the vault; auto-pause off by default |

## 18. Sources

Cohere documentation, read 2026-11-20: [Model Vault](https://docs.cohere.com/docs/model-vault); [Managing vaults](https://docs.cohere.com/docs/model-vault/managing-vaults); [Regions](https://docs.cohere.com/docs/model-vault/regions); [Encrypted](https://docs.cohere.com/docs/model-vault/encrypted); [Encrypted supported models](https://docs.cohere.com/docs/model-vault/encrypted/supported-models); [Encrypted API usage](https://docs.cohere.com/docs/model-vault/encrypted/api-usage); [Attestation](https://docs.cohere.com/docs/model-vault/encrypted/attestation); [Security model](https://docs.cohere.com/docs/model-vault/encrypted/security-model); [Standard API access](https://docs.cohere.com/docs/model-vault/standard/api-access); [Standard supported models](https://docs.cohere.com/docs/model-vault/standard/supported-models); [Pricing](https://cohere.com/pricing); [cohere-ai/integritee](https://github.com/cohere-ai/integritee). Open-source project compared: [inclavare-containers/TNG](https://github.com/inclavare-containers/TNG). Government of Canada guidance, cited by title: Canadian Centre for Cyber Security, CCCS Medium cloud control profile (formerly Protected B, Medium integrity, Medium availability); Guidance on the cloud service provider information technology security assessment process (ITSM.50.100); Public Services and Procurement Canada, Contract Security Program and the security requirements check list. Standards: IETF RFC 9334 (RATS architecture), RFC 9458 (Oblivious HTTP), RFC 9180 (HPKE). Repository files are cited inline from `origin/main`.

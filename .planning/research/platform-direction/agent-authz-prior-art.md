# Prior art for the agent authorization architecture

Research report, written 2026-11-16. Read-only research; nothing in the repository was changed.

> Outcome (owner, 2026-11-16; `.planning/PROJECT.md`, Platform direction decisions 14-17): NEAR function-call access keys are used only for agents' and nodes' on-chain calls; off-chain capabilities stay in private credentials checked by the credential broker, and the public key registry of section 8.3 item 1 (also with hashed names) was declined for the risks in section 8.5. The items in section 8.4 named in decision 17 are adopted as designs.

Sources were found by web search and, where it mattered, by reading the primary page. Each claim carries its source link. **(inference)** marks my own reasoning. **(secondary)** marks a vendor blog, news piece or aggregator rather than a specification or the project's own docs. **(from memory)** marks a fact I did not re-check in this session; verify it before relying on it.

Patentability is a legal question and outside the scope of this report. Nothing here says whether any part could or could not be patented.

---

## 0. The short answer

1. **Almost every individual part is established practice.** DIDs and Verifiable Credentials for agents, delegation that only narrows, revocation lists, a signed policy bundle checked offline, a credential broker that injects secrets at the network boundary, and an OS sandbox with egress only through that broker all have named, public prior art from 2014 to 2026.
2. **The closest prior art to the new layer (an on-chain registry of what each agent may do, which gates off-chain capabilities through a broker)** is Lit Protocol's Vincent (an on-chain registry of agent to apps to abilities to policies, enforced by Lit's node network), NEAR's own Shade Agent contract (an on-chain list of valid agents that gates which methods they may call), Ceramic and SIWE ReCap sessions (a blockchain account delegates scoped capabilities to a `did:key` session key that off-chain services verify), Hats Protocol (revocable on-chain roles read as off-chain access gates), and the academic FairAccess and BlendCAC IoT schemes. None of these uses a chain's *protocol-native* scoped access keys as the registry.
3. **What I did not find in this search:** using NEAR function-call access keys on one organization account as the revocable registry, with each contract method name standing for an off-chain capability (an external API, a model provider, a messaging channel), checked by a broker through a free `view_access_key` RPC before it injects a real credential. Also not found as one published system: VC-based clearance with compartments and releasability plus a session high-water mark that steers which model class (cloud, attested TEE cloud, local) may see the data, inside an on-device agent gate. Both are "no prior art found in this search", not "novel".
4. **The new layer has real costs the prior art documents or that follow from NEAR's own rules:** the full access key list of an account is public, which conflicts with decision 13 ("nothing readable on chain"); NEP-413 requires a full-access key, so signing it with a function-call key is off-spec; an empty `method_names` list means *every* method; `method_names` is capped at 2,000 bytes per key; a stolen agent key can still send real transactions to the registry contract; and revocation is only as fast as the lease or snapshot length.

---

## 1. The architecture being assessed (summary)

From `.planning/PROJECT.md` on main, "Platform direction" decisions 1 to 13, and `identity-research.md` in this folder:

- **Identity:** `did:key` (Ed25519) for agents and machines, `did:webvh` for people and your organization's root (decision 10). DID documents stay minimal (decision 8).
- **Attributes:** authority, clearance, roles and compartments are VC 2.0 credentials with `eddsa-jcs-2022` proofs, revoked through Bitstring Status List (decision 9). Delegation narrows on level, roles, compartments, expiry and depth at every link (decision 12).
- **Gate:** an on-device gate decides every tool call offline from a signed policy bundle. Labels `{scale, level, compartments, releasability, handling}` with a dominance rule and a session high-water mark; each level maps to a routing tier (any cloud, attested TEE cloud, local only, deny) (decision 11).
- **Chain:** only 32-byte Merkle roots on public NEAR, one anchor account per organization, checked once per run as a lease; edge devices verify offline and fail closed after a maximum age (decision 13).
- **Proposed new layer (this report's focus):** NEAR function-call access keys on your organization's account as the on-chain registry of what each agent may do; a child key lists a subset of its parent's methods; methods also stand for off-chain capabilities; a credential broker verifies the agent's NEP-413 signed request, checks via RPC that the signing key is a current function-call key allowed that method and that the delegation is not revoked, then injects the real credential; the agent runs in an OpenShell-style sandbox with egress only through the broker; per-run leases; offline snapshots with a maximum age.

---

## 2. Capability and delegation systems

| System | What it is | DIDs? | Narrowing delegation? | Revocation | Source |
|---|---|---|---|---|---|
| **Macaroons** (Google, 2014) | Bearer tokens with HMAC-chained caveats; any holder can add a caveat to restrict further | No (shared root secret) | Yes, offline | Not built in | Birgisson et al., NDSS 2014 **(from memory)**; Biscuit docs describe the lineage: https://docs.rs/crate/biscuit-auth/6.0.0 |
| **Biscuit** | Public-key signed token, offline attenuation by appending blocks, Datalog policies | No (public keys) | Yes, offline, cryptographically checked | Revocation ids per block | https://docs.rs/crate/biscuit-auth/0.8.0 ; https://docs.rs/biscuit-auth/6.0.0/src/biscuit_auth/lib.rs.html |
| **ZCAP-LD** (W3C CCG) | Object capabilities as signed linked-data documents; delegated capability carries parent, expiry and delegation proof; invocation is a separate proof purpose | Yes | Yes | Spec v0.4.0; open issues on invocation and delegation | https://w3c-ccg.github.io/zcap-spec ; https://www.w3.org/groups/cg/credentials/activity/2026/ |
| **UCAN 1.0** (Fission, now ucan-wg; used by Storacha, formerly web3.storage) | Delegation (subject, command, policy) and a separate Invocation (iss, sub, aud, cmd, args, prf, nonce, exp), plus Receipts and Revocation | Yes (`did:key` common) | Yes; policy language restricts args | Any issuer in the chain may revoke; append-only, gossiped, eventually consistent | https://github.com/ucan-wg/spec ; https://github.com/ucan-wg/invocation ; https://github.com/ucan-wg/revocation ; https://docs.storacha.network/concepts/ucans-and-storacha |
| **SIWE ReCap** (EIP-5573, draft) | One Sign-In-with-Ethereum signature both authenticates and delegates capabilities (human-readable in the signed text) to a session key; can only narrow | Account-based, combinable with UCAN/ZCAP | Yes | Not defined | https://eips.ethereum.org/EIPS/eip-5573 ; https://blog.spruceid.com/extending-sign-in-with-ethereum-to-authorizations-recap/ |
| **Ceramic CACAO / DID sessions** (CAIP-74) | A blockchain account (`did:pkh`) signs a SIWx message that delegates to an ephemeral `did:key` session key; verifiers check the CACAO off-chain | Yes (`did:pkh` to `did:key`) | Resource-scoped, time-bound | Expiry only | https://developers.ceramic.network/docs/dids/managing-sessions ; https://developers.ceramic.network/docs/protocol/js-ceramic/accounts/object-capabilities |
| **Tenuo** (2025-2026, open source, beta) | "Warrants" for AI agent tool calls: tool name, constraints, TTL, signature; delegation only shrinks; proof of possession | Keys, not DIDs | Yes | TTL | https://docs.rs/tenuo ; https://pypi.org/project/tenuo/0.1.0b18/ |
| **OAuth Token Exchange** (RFC 8693, Jan 2020) | Exchange a token for a narrower one; `act` claim records the actor chain | No | Server-mediated | Token lifetime, introspection | RFC 8693 **(from memory)** |
| **Rich Authorization Requests** (RFC 9396, May 2023) | Structured `authorization_details` instead of flat scopes | No | Server-mediated | As OAuth | RFC 9396 **(from memory)** |
| **GNAP** (RFC 9635, Oct 2024) | Successor-style grant protocol with structured access rights and key-bound tokens | No | Server-mediated | As grant | RFC 9635 **(from memory)** |

**Which already combine DIDs with narrowing delegation:** UCAN (most mature and deployed, Storacha uses `did:key` agents and spaces), ZCAP-LD, Ceramic CACAO sessions, and on the agent side KYA-OS (section 5). Your design's choice of VCs for attributes plus a separate delegation chain sits between ZCAP-LD (capabilities as signed linked data) and UCAN (capabilities as signed envelopes). **(inference)** It is closest to ZCAP-LD in data model and to UCAN in revocation semantics.

Documented point: Okta notes that ordinary OAuth tokens cannot be narrowed after issuance without contacting the server, which is the gap Macaroons and Biscuit fill (https://www.okta.com/blog/ai/agent-security-delegation-chain/, **secondary**).

---

## 3. On-chain registries that gate off-chain access

- **Lit Protocol access control conditions and PKPs.** Lit nodes check on-chain or off-chain conditions and only then release decryption shares or threshold signatures; conditions can be arbitrary Lit Actions; session signatures scope a session key to resources. https://developer.litprotocol.com/sdk/serverless-signing/conditional-signing ; https://spark.litprotocol.com/session-sig-pt-2/ ; https://developer.litprotocol.com/concepts/access-control-concept
- **Lit Vincent (launched 30 Oct 2025).** Agent wallet and "app store" framework: users delegate scoped abilities to agents (delegatees) under app-defined policies such as spend limits and token allowlists. A third-party mirror describes an on-chain registry Agent PKP to Apps to Tools (abilities) to Policies, and an App Registry tracking delegatee addresses (**secondary, unverified against Lit's own repo**). https://spark.litprotocol.com/meet-vincent-an-agent-wallet-and-app-store-framework-for-user-owned-automation/ ; https://developer.litprotocol.com/agent-wallet/intro ; https://blockworks.co/news/lit-protocol-vincent-ai-agents
- **Hats Protocol.** Roles as non-transferable ERC-1155 tokens that an admin can revoke without the holder's cooperation; other apps read them as token gates. https://github.com/hats-protocol/hats-protocol
- **Token gating, Unlock, Guild and similar.** Read an on-chain balance or membership, then grant off-chain access. Widely deployed; well known. **(from memory)** A current agent-specific example: InsumerAPI accepts a wallet-signed request, checks an on-chain non-transferable access pass, then serves the API (https://insumermodel.com/blog/your-agent-doesnt-need-an-api-key.html, **secondary**). WiKey Gateway authenticates an agent by wallet passkey and injects the third-party key server-side (https://wikey.io/agent-gateway.html, **secondary**; whether it checks an on-chain registry is not stated).
- **Chainlink Functions** runs off-chain computation for contracts (the reverse direction: on-chain asks off-chain). Not checked in depth in this search. **(from memory)**
- **Academic:** FairAccess (Ouaddah, Abou Elkalam, Ait Ouahman, *Security and Communication Networks* 9(18), 2016) uses blockchain transactions to grant, request, delegate and revoke access tokens for IoT; FairAccess 2.0 (2021) moved to Ethereum smart contracts with ABAC (https://www.inderscience.com/filter.php?aid=115346). BlendCAC (Xu et al., *Computers* 7(3):39, 2018; arXiv 1804.09267) is capability-based access control with multi-hop delegation stored in smart contracts (https://arxiv.org/pdf/1804.09267 ; https://mdpi.com/2073-431X/7/3/39). Both target removing a central authorization server and both prototype on Raspberry Pi.

**How they differ from the proposal (inference):** Lit uses a separate threshold network as the enforcer; FairAccess and BlendCAC store capabilities as contract state; Hats and token gating use token ownership. The proposal instead uses the account's own access-key table, which the NEAR protocol maintains, and a broker you run as the enforcer. I found no project that does this.

---

## 4. Session keys and scoped keys

- **NEAR function-call access keys.** A key can call one receiver contract, optionally limited to listed methods, with an optional gas allowance that belongs to the key and cannot be changed later; it cannot attach NEAR; adding or removing keys needs a full-access key or a contract method on that account. Docs say function-call keys "are meant to be shared with applications, so third-parties can make contract calls in your name". If `method_names` is omitted, all methods can be called. https://docs.near.org/protocol/access-keys . Runtime limits: `max_number_bytes_method_names: 2_000`, `max_length_method_name: 256` (https://raw.githubusercontent.com/near/nearcore/master/core/parameters/res/runtime_configs/parameters.yaml, read 2026-11-16). Storage: about 100 bytes and about 0.001 NEAR staked per key (https://docs.near.org/docs/concepts/storage-staking). The common usage pattern is dapp login keys and game session keys, i.e. the key signs *on-chain* calls. An MCP tool ("hydra") mints scoped function-call keys for agents (https://policylayer.com/tools/nikshepsvn-near-hydra/hydra-create-agent-key, **secondary**).
- **NEP-413 (signMessage).** Final, created 25 Oct 2022, approved 17 Jan 2023. The spec says the message "Must be signed using a Full Access Key" and the wallet "must return an error" if it holds none. https://github.com/near/NEPs/blob/master/neps/nep-0413.md . NEAR AI's own API uses NEP-413 signed payloads as auth tokens (recipient `ai.near`) (https://docs.near.ai/api/guide).
- **NEAR Chain Signatures and Shade Agents.** The Shade Agent contract registers agents that present a TEE attestation and code hash, keeps an approved list (or an account allowlist in local mode), and restricts certain methods to valid agents; the docs advise tying assets to the contract, not to ephemeral agent keys. One deployment page notes that after a change *any* account could call `sign`, so the gate must be checked in the current code. https://docs.near.org/ai/shade-agents/reference/agent-contract ; https://docs.near.org/ai/shade-agents/production/production-components
- **ERC-4337 / ERC-7579 smart sessions.** Rhinestone and Biconomy's Smart Sessions module: a session signer plus policies (contract allowlists, spend, gas and rate limits, expiry), validated on-chain. ZeroDev Kernel has similar session keys with argument constraints. https://docs.biconomy.io/sdk-reference/sessions ; https://docs-34jorgiqo-rhinestone.vercel.app/module-sdk/modules/smart-sessions ; https://docs.biconomy.io/agents-automation.md
- **ERC-7715 and ERC-7710, MetaMask Delegation Toolkit (Smart Accounts Kit).** ERC-7715 is the request layer (a dapp or AI agent asks the wallet for a permission with a human-readable confirmation); ERC-7710 is the delegation layer, with caveats enforced by caveat-enforcer contracts and caveats that stack across delegation hops. Experimental; RPC names vary between docs versions. https://docs.metamask.io/delegation-toolkit/concepts/erc7715 ; https://ethereum-magicians.org/t/erc-7715-grant-permissions-from-wallets/20100 ; https://docs.metamask.io/llms-smart-accounts-kit-full.txt
- **Documented weakness:** several write-ups call session keys a smart account's main weak point (sprawl, over-broad policies, poor revocation UX) (https://www.chainscorelabs.com/blog/smart-contract-auditing-and-best-practices/smart-account-and-aa-security/why-session-keys-are-a-necessary-evil-in-aa, **secondary**).

**How they differ (inference):** all of these enforce scope at *on-chain* redemption time. The proposal uses the scope list as data that an off-chain broker reads; the key normally never sends a transaction. That reuse is what I found no example of.

---

## 5. AI agent authorization (2024 to 2026)

**Research and standards**
- **South et al., "Authenticated Delegation and Authorized AI Agents"** (arXiv 2501.09674, 16 Jan 2025; MIT and Stanford authors). Extends OAuth 2.0 and OpenID Connect with agent-specific credentials and delegation tokens; proposes translating natural-language permissions into auditable access control. https://arxiv.org/abs/2501.09674
- **OpenID Foundation, "Identity Management for Agentic AI"** (whitepaper, 7 Oct 2025; arXiv 2510.25819). Names gaps: shared team-run agents, telling when an agent acts for a user versus itself, and proprietary agent identity lock-in; recommends building on existing standards first. https://openid.net/new-whitepaper-tackles-ai-agent-identity-challenges/
- **IETF `draft-klrc-aiagent-auth`** ("AI Agent Authentication and Authorization", Kasselman, Parecki, Rosomakho, Campbell; -00 March 2026, -03 6 July 2026). Profiles existing standards: WIMSE identifiers (may be SPIFFE IDs), WIMSE proof tokens, HTTP Message Signatures, OAuth. Discussed at a WIMSE interim on 3 June 2026; adoption not confirmed. https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/ ; related `draft-sweeney-wimse-credential-delegation-00` (July 2026) adds credential wrapping, revocation and consent gating.
- **IETF `draft-oauth-ai-agents-on-behalf-of-user`** (Senarath, WSO2; -00 May 2025, -02 Aug 2025). `requested_actor` and `actor_token`, delegation chain in an `act` claim; individual draft. https://datatracker.ietf.org/doc/html/draft-oauth-ai-agents-on-behalf-of-user-02
- **ID-JAG / Okta Cross App Access** (IETF OAuth draft; adopted into MCP as "Enterprise-Managed Authorization"). Admin policy, not per-user prompts, decides what an agent may reach. https://developer.okta.com/blog/2025/06/23/enterprise-ai ; https://startwithidentity.com/standards/id-jag-cross-app-access/
- **MCP authorization (2025-11-25).** OAuth 2.1 with RFC 9728 protected resource metadata; clients MUST send RFC 8707 `resource`; servers MUST check audience; "The MCP server MUST NOT pass through the token it received from the MCP client"; 403 `insufficient_scope` with a `WWW-Authenticate` scope hint drives step-up. A newer 2026-07-28 revision is reported (**secondary**). https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- **DIF Trusted AI Agents Working Group** (first meeting 30 Sep 2025) and **KYA-OS** (formerly MCP-I, donated by Vouched). KYA-OS Level 2 is "full DID verification, credential-based delegation, and revocation support", with delegation as a scoped policy credential issued by the user. https://identity.foundation/working-groups/trusted-agents.html ; https://blog.identity.foundation/kya-os/
- **Huang, Narajala et al., "A Novel Zero-Trust Identity Framework for Agentic AI"** (arXiv 2505.19301, May 2025): DIDs, VCs, ZKPs and an Agent Name Service. https://arxiv.org/abs/2505.19301
- **Agent Name Service** (`draft-narajala-ans-00`, May 2025; `draft-narajala-courtney-ansv2-01`, April 2026): DNS-anchored agent identity with PKI, DANE and transparency-log tiers; independent submissions, not adopted. https://datatracker.ietf.org/doc/html/draft-narajala-courtney-ansv2-01
- **A2A protocol:** the Agent Card declares OpenAPI-style security schemes (API key, OAuth, OIDC, mTLS); identity is left to those schemes, and card authenticity is not mandated. https://www.wiz.io/academy/ai-security/a2a-protocol (**secondary**)
- **Web Bot Auth** (IETF draft, Cloudflare, May 2025): agents sign HTTP requests with RFC 9421 and publish keys at a well-known directory; OpenAI's ChatGPT agent signs with `Signature-Agent: https://chatgpt.com`. https://blog.cloudflare.com/web-bot-auth ; https://help.openai.com/en/articles/11845367
- **Google AP2** (Sept 2025): "mandates" as signed VCs (Intent, Cart, Payment; v0.2 reported as Checkout and Payment Mandates in SD-JWT). https://www.descope.com/learn/post/ap2 (**secondary**)

**Products**
- **Microsoft Entra Agent ID:** agent identity blueprints hold credentials; agent identities have none of their own; an agent on-behalf-of flow with audience binding. https://learn.microsoft.com/entra/agent-id/key-concepts ; https://learn.microsoft.com/en-us/entra/agent-id/agent-on-behalf-of-oauth-flow
- **SPIFFE/SPIRE and Aembit:** workload identity for agents; Aembit issues SPIFFE SVIDs and short-lived credentials with runtime policy and audit. https://aembit.io/press-release/aembit-introduces-spiffe-credential-provider-to-extend-secure-workload-authentication-across-cloud-native-and-ai-environments/ (**secondary**). Teleport and Astrix were not checked in depth here.
- **Agent wallets with limits:** Coinbase Agentic Wallets (11 Feb 2026; session caps, per-transaction limits, keys in enclaves per a secondary source) https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets ; Skyfire KYAPay (June 2025) https://www.businesswire.com/news/home/20250626772489/en ; Crossmint (per-transaction and daily limits, merchant allowlist, **secondary**). Payman was not found by this search.
- **Credential brokers for agents:** NVIDIA OpenShell places an opaque placeholder in the sandbox and a proxy outside substitutes the real credential only for endpoints bound to it, returning 403 `credential_endpoint_mismatch` otherwise; default-deny egress; model keys injected in the router. https://docs.nvidia.com/openshell/security/best-practices ; https://perspectives.nvidia.com/nvidia-openshell/agent-sandbox-injects-credentials-gateway-no-api-keys/ . NEAR AI's IronClaw: WASM-sandboxed tools, credentials injected at the host boundary so secrets never enter WASM memory (https://github.com/nearai/ironclaw; details mostly **secondary**).

---

## 6. Classification labels and model routing

- **Foundations:** Bell-LaPadula dominance (1973) and the high-water mark (ADEPT-50, Weissman 1969) are textbook MLS. **(from memory)**
- **Microsoft Purview with Microsoft 365 Copilot:** output created from labeled files inherits the label with the highest priority; Copilot Chat shows the highest-priority label of the data used; encryption usage rights (EXTRACT and VIEW) and DLP can stop Copilot or agents processing labeled content. This is the closest mainstream product to "label dominance plus high-water mark for AI". It controls *whether* the AI may use the data, not *which* model class may. https://learn.microsoft.com/purview/ai-m365-copilot ; https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-architecture-data-protection-auditing
- **Gateways and routers:** vendor AI gateways narrow the allowed provider set by data classification (restricted prompts only to a private deployment) (https://www.gravitee.io/corpus/gen-1943/product-data-management/data-classification-for-ai-traffic.html, **secondary**); the vLLM Semantic Router redirects PII-bearing requests to internally hosted models (https://next.redhat.com/2025/11/11/intelligent-inference-request-routing-for-large-language-models). One defense-contractor page describes classification labels on retrieved chunks and outputs defaulting to the highest input level (https://precision-federal.pages.dev/capabilities/classified-ai, **secondary**).
- **Documented risk:** adversarial prefixes can steer an LLM router's model choice (https://promptfoo.dev/lm-security-db/vuln/llm-router-rerouting-278a699e/). **(inference)** Your design routes by label held in metadata, not by a content classifier, which avoids this class of attack as long as labels are never inferred from model-visible text.
- **Not found in this search:** an open specification or product that combines a formal MLS label (level, compartments, releasability, multiple national scales with approved mappings) with routing tiers that include *attested TEE cloud* as its own class, inside an agent's per-tool-call gate.

---

## 7. NEAR ecosystem

- **NEAR AI:** NEP-413 auth tokens for its API (full-access key, recipient `ai.near`) (https://docs.near.ai/api/guide). IronClaw (section 5). NEAR AI Cloud TEE models are the "attested TEE cloud" tier in your design.
- **Shade Agents:** on-chain registry of attested agents and method gating (section 4). This is the closest NEAR-native pattern to "an on-chain list of which agents may do what", but it gates on-chain calls and chain signatures, and it registers by attestation rather than by delegation from a parent.
- **NEAR Intents / Confidential Intents:** covered in the identity research; not an authorization registry. No agent-permission feature was found in this search.
- **Community:** the "hydra" MCP tool mints scoped function-call keys for agents (**secondary**); MultiAgency/nearly prototypes agents proving account ownership with NEP-413 (https://github.com/MultiAgency/nearly).

---

## 8. Assessment

### 8.1 Standard practice (well covered by prior art)

- DIDs for agents and people; VCs for attributes; Bitstring Status List revocation (W3C VC 2.0 and Bitstring Status List are W3C Recommendations, May 2025 **(from memory)**).
- Delegation that only narrows at every hop: Macaroons, Biscuit, UCAN, ZCAP-LD, ERC-7710 caveats, Tenuo.
- Offline verification from a signed local bundle and short-lived leases: Biscuit's offline checks, OAuth short-lived tokens, UCAN `exp`.
- A credential broker with placeholders and endpoint-bound injection, plus a sandbox with egress only through it: OpenShell, IronClaw, Aembit.
- Wallet-signed request plus on-chain check before serving an API: InsumerAPI, token gating, Lit.
- Label inheritance by the most restrictive source: Purview with Copilot; classification-aware routing: AI gateways.
- Anchoring only hashes on a public chain: common practice (e.g. transparency-log and timestamping designs). **(inference)**

### 8.2 Combinations that already exist (closest projects)

| Your combination | Closest project | How it differs |
|---|---|---|
| On-chain registry of agent permissions gating actions | **Lit Vincent** | Lit's threshold network enforces and signs; EVM and PKP based; registry is contract state, not protocol access keys; mainly gates wallet actions |
| On-chain list of valid agents and allowed methods | **Shade Agent contract** (NEAR) | Gates on-chain calls and chain signatures; registration by TEE attestation; no parent/child narrowing; not used to gate off-chain APIs |
| Blockchain account delegates scoped capabilities to a `did:key` | **Ceramic CACAO sessions, SIWE ReCap** | Delegation is an off-chain signed object; no on-chain registry; revocation is expiry only |
| Revocable on-chain roles as off-chain gates | **Hats Protocol** | Roles are tokens; one role tree; no capability-per-method mapping; no broker |
| Blockchain-based capability delegation and revocation | **BlendCAC, FairAccess** | Academic IoT prototypes; capabilities in contract state or transactions; no agent sandbox or credential injection |
| DIDs + VCs + scoped revocable delegation for AI agents | **KYA-OS (DIF), Huang et al. 2025, AP2 mandates** | No on-chain key registry; no classification labels or model routing; KYA-OS targets MCP servers |
| Broker injects secrets, sandbox forces egress through it | **OpenShell, IronClaw** | Authorization is local policy YAML or manifest; no DID or chain-backed revocation |
| Highest label wins, AI blocked by label | **Purview + Copilot** | Decides whether data may be used, not which model class; Microsoft cloud only; no offline edge |

### 8.3 Uncommon (no prior art found in this search)

Stated conservatively. These are things I looked for and did not find, not claims that nothing exists.

1. **NEAR function-call access keys used as an off-chain ACL.** Keys on one organization account, each restricted to a registry contract, where method names stand for off-chain capabilities (external APIs, model providers, messaging channels), and a broker reads `view_access_key` to decide whether to inject a credential. Every session-key system found uses the scope list to gate on-chain redemption.
2. **Parent/child narrowing expressed as subset method lists across sibling access keys.** NEAR does not know about parent and child keys; the subset rule exists only in whoever adds the key. I found no project modelling a delegation tree this way.
3. **One on-device gate that joins three things:** VC clearance with compartments and releasability, a session high-water mark, and model-class routing that treats attested TEE cloud as its own tier, for teams of agents working offline at the edge.
4. **The overall stack** (DIDs and VCs, narrowing delegation, OS sandbox, credential broker, chain-backed revocation via native access keys, label-driven model routing, offline edge with maximum-age snapshots). I found no single published system with all of these. Several systems hold three or four.

### 8.4 What to borrow

- **UCAN 1.0 Invocation shape for the signed request** to the broker: `iss`, `sub`, `aud`, `cmd`, `args`, `prf`, `nonce`, `exp` (a few minutes), with `iat` advisory only (https://github.com/ucan-wg/invocation). It separates "who may" (delegation) from "do this now" (invocation), which the broker needs. Consider UCAN **Receipts** for the audit trail.
- **UCAN revocation semantics:** any issuer in the chain may revoke; the store is append-only; entries can be evicted after the target expires; accept revocations that arrive before the delegation (https://github.com/ucan-wg/revocation). This fits Bitstring Status List plus Merkle roots.
- **ERC-7715 permission shape and consent:** a typed permission (`type`, `data`, expiry, rules) rendered as a human-readable approval; ERC-7710's model of one enforcer per caveat type that stacks across hops. Useful for the capability manifest and the approval UI. (Field names vary between draft versions; verify.)
- **MCP authorization rules at the broker:** bind each credential and each lease to one audience (RFC 8707 style), never pass the agent's token through, and answer 403 `insufficient_scope` with the capability needed so a person can step up.
- **OpenShell's endpoint binding:** a credential is bound to specific endpoints, and a mismatch is a distinct, logged 403.
- **Request binding:** RFC 9421 HTTP Message Signatures (as Web Bot Auth and WIMSE use) or a body hash inside the invocation, so a signed request cannot be replayed against another endpoint.
- **Delegation chain in audit:** the OAuth `act` claim pattern (RFC 8693, the on-behalf-of draft) is the format enterprise auditors already read.
- **Interop targets:** KYA-OS Level 2 for DID/VC agent identity, and SPIFFE/WIMSE identifiers at the broker for enterprises (draft-klrc-aiagent-auth).
- **Biscuit or Tenuo** as a reference for compact, offline-checkable attenuation and Datalog-style checks, if the policy bundle needs more than set membership.
- **Purview's rule** that output takes the highest-priority label of its sources; matches decision 11 and gives you a known-good reference behaviour.
- **Shade Agent advice:** tie durable state to the contract or org account, not to ephemeral agent keys; and attestation-gated registration if agents run in TEEs.

### 8.5 Risks the prior art documents, or that follow from NEAR's rules

1. **Privacy of the on-chain key list.** Anyone can call `view_access_key_list` on your organization's account and see every key, its receiver and its method names, plus when keys were added and removed. That reveals agent count, team churn and the names of your capabilities. This conflicts with decision 13 ("nothing readable on chain"). **(inference from https://docs.near.org/protocol/access-keys)** Opaque method names (hashes) hide the names but not the count, timing or tree shape.
2. **NEP-413 requires a full-access key.** Signing NEP-413 with a function-call key is off-spec (https://github.com/near/NEPs/blob/master/neps/nep-0413.md). Wallets will refuse; other verifiers (such as NEAR AI's) may reject. Use the NEP-413 payload layout only with your own domain-separation tag and `recipient`, and document the difference.
3. **An empty method list means every method.** If narrowing ever yields an empty subset, the child key gets *all* methods of the registry contract. The narrowing check must reject an empty list rather than write it.
4. **Size cap.** At most 2,000 bytes of method names per key (256 per name) limits how many capabilities one key can carry; fine-grained capabilities may not fit.
5. **Stolen agent keys can still transact.** A function-call key can send real transactions to the registry contract and burn its allowance. Make every capability method on the registry contract a cheap no-op or panic, set a small allowance, and never put state-changing methods there. **(inference)**
6. **Who adds keys is a high-value target.** Only a full-access key, or a contract deployed on the organization account, can add keys. That holder can mint any capability, and the subset rule is enforced only by its code. **(inference)**
7. **Key sprawl and cost.** One key per agent per grant, each about 0.001 NEAR staked and an on-chain transaction to add or remove; session-key systems report sprawl and revocation hygiene as their main weakness (secondary sources above).
8. **Revocation latency.** UCAN's spec says revocation may be only eventually consistent and calls it "the last line of defense", preferring short expiry and narrow scope (https://github.com/ucan-wg/revocation). Your lease and offline maximum age define the real window: a revoked key works until the lease ends.
9. **Trust in "free RPC".** A public RPC provider can be down, rate-limited or wrong. Fail closed, consider more than one provider, and treat the answer as a cache hint unless checked against an anchored root or a light-client proof. **(inference)**
10. **Two sources of truth.** The VC delegation chain and the on-chain key list can disagree. Define the rule now: both must allow (intersection), and either revoking wins. **(inference)**
11. **Broker as single point of failure and single secret store.** OpenShell, Aembit and the MCP spec all concentrate credentials at one proxy; a write-up documents routers and proxies leaking keys into logs (https://dev.to/alex_spinov/your-llm-router-logged-the-wallet-key-it-already-left-1jje, **secondary**). Needs redaction, availability planning, and a fail-closed default.
12. **Confused deputy.** The MCP spec warns that proxies to third-party APIs become confused deputies when tokens are not audience-bound (link above). Bind each injected credential to an endpoint and each lease to one run.
13. **Router manipulation.** Adversarial text can steer content-based routers (section 6). Keep routing driven by labels, never by model-visible content.

---

## 9. Limits of this search

- Searches ran on 2026-11-16 with a general web search; most vendor material is marketing and is marked secondary. Academic coverage is thin (FairAccess, BlendCAC, South et al., Huang et al.); a database search (IEEE, ACM) could find more blockchain access-control papers, some of which may use account keys.
- Not checked in depth: Teleport, Astrix, Payman, Chainlink Functions, Unlock, Ceramic ComposeDB, NEAR Intents permissions, Anthropic-specific agent identity proposals beyond Web Bot Auth.
- No repositories were cloned and no downloaded code was run.

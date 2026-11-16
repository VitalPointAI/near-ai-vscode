# Trust and governance layer: identity, credentials, clearance and NEAR confidentiality

Research report, written 2026-11-15. All facts were checked on that date against the sources linked inline. Statements marked **(inference)** are my reasoning, not something a source says. Statements marked **(secondary)** come from news or third-party sites, not from NEAR or a standards body.

---

## 0. The short answer

1. **NEAR's confidential offering today cannot hold your identity records.** What NEAR ships under the "confidential" name is **Confidential Intents**: a private shard that runs one application (the NEAR Intents engine) for swaps, transfers, deposits and withdrawals. You cannot deploy your own contract to it, it has no public RPC, and the only developer entry point is a flag on the 1Click Swap API. It hides who moved which asset, not arbitrary data. Selective disclosure (view keys) is announced but not live.
2. **You can still meet the goal "clearance, roles and relationships are not public"** without the private shard: put **nothing readable on chain**. Clearance, roles and relationships live in signed Verifiable Credentials held by the people and devices that need them. NEAR mainnet carries only opaque 32-byte commitments (Merkle roots over DID log heads, status lists and policy bundles) written by one anchor account per organization. Make the anchor a pluggable backend so it can move to a NEAR confidential contract if NEAR ever opens the private shard to general contracts.
3. **DIDs:** `did:near` exists twice, in two incompatible forms, and neither fits. Do not write a third `did:near`. Use **`did:key` (Ed25519)** for every agent and machine key, and **`did:webvh`** for people and for your organization, hosted by your organization's HQ (not necessarily the public internet), with the log head anchored on NEAR.
4. **Credentials:** implement a **narrow profile of W3C VC 2.0 with Data Integrity `eddsa-jcs-2022`** and **Bitstring Status List** yourself on `node:crypto` plus the existing canonical JSON code. It needs no runtime dependency. Do selective disclosure with **atomic and threshold credentials** (one credential per fact, for example "clearance at least SECRET"), not BBS or SD-JWT, for now.
5. **Labels:** a compact lattice label `{scale, level, compartments, releasability, handling}` and a matching clearance. Dominance check plus a high-water mark per session. A `handling` value (or a per-level routing table) decides whether a request may go to local models only, an attested TEE cloud, or any cloud.

---

## 1. NEAR confidential and private transactions

### 1.1 What exists (as of 2026-11-15)

| Offering | What it is | Status | Source |
|---|---|---|---|
| **NEAR private shard** (part of Nightshade 3.0) | A separate execution environment. NEAR says it is "operated by seven permissioned validators" and "connected to NEAR mainnet via a TEE-based bridge". "Private Shard is the foundation for Confidential Intents." | Live (no launch date on the page) | https://www.near.org/blockchain |
| **Confidential Intents** | Opt-in confidential mode for NEAR Intents: deposits, withdrawals, swaps, peer-to-peer transfers | Announced 2026-02-25 at NEARCON; general availability for developers 2026-07-07 | https://tools.prnewswire.com/en-us/live/20813/release/20260225EN95768 ; https://www.near.org/blog/announcing-general-availability-of-confidential-intents |
| **Confidential Swaps** (1Click Swap API) | Same API and key as normal swaps; add `confidentiality: "advanced"` to the quote request | Live | https://docs.intents.aurora.dev/intents-swap/confidential-swaps |
| **"Confidential by default"** on near.com for holdings, trades, payments, yields | Consumer product default | Reported around 2026-09 **(secondary, dates conflict between outlets)** | https://coinalertnews.com/news/2026/09/01/near-default-confidentiality-crosschain ; https://cryptobriefing.com/near-protocol-private-perps-hyperliquid/ |
| **MPC Confidential Key Derivation (CKD)** | NEAR's MPC network acts as a decentralized key service: an app proven to run in a TEE gets a deterministic secret no single MPC node sees | Research post 2026-02-23; public verifiability "planned as a next step"; mainnet status not stated | https://blog.nearone.org/research/2026/02/23/mpc-ckd.html |
| **Calimero** (formerly "private shards") | Was a NEAR-ecosystem product for permissioned private networks; Calimero 1.0 (release candidate since 2026-10-28) is a leader-ordered confidential cloud on Intel TDX servers | All NEAR integration removed in 0.10.1-rc.9 (2026-03-25) and peer-to-peer sync removed in 1.0.0-rc.1 (2026-10-28). Evaluated 2026-11-15: not now, see [calimero-evaluation.md](./calimero-evaluation.md) (this row said "no 2026 status found" before that evaluation) | https://github.com/calimero-network/core/releases ; 2023 funding: https://www.theblock.co/news/deals/2023-01-23-private-sharding-startup-calimero-network-raises-8-5-million-204235 |

### 1.2 What is hidden, and from whom

- **Hidden from the public:** "Transaction details, such as amounts, counterparties, and token pairs, stay off the public NEAR blockchain." The confidential balance is "encrypted onchain, visible only to you." (https://www.near.org/blog/how-confidential-intents-works, dated 2026-05-27)
- **Still public:** for swaps, "Confidentiality covers only the origin of the assets." The destination transaction, asset, amount and recipient settle publicly (https://docs.intents.aurora.dev/confidential-intents).
- **Not stated anywhere I could find:** whether the seven validators or the TEE bridge operators can see plaintext; which TEE hardware the bridge uses; how attestation is published. The GA post says each user's data is "encrypted individually" on the shard, but gives no key-management detail.
- **Selective disclosure:** planned, not live. The GA post describes a future account-level "view key" a user can share with a third party for a limited time.

### 1.3 Trust model

- Permissioned validators (seven) plus a TEE-based bridge to mainnet. No ZK proofs are described. This is a "trust the operators and the enclave" model, not a cryptographic privacy guarantee **(inference from the near.org description)**.
- I found **no NEP** for the private shard (searched github.com/near/NEPs issues and the `neps/` folder; latest NEPs are up to NEP-655 Universal Accounts) and **no public source** for the shard or bridge (searched the `near` organization repositories; the `near/intents` README has no confidential content). A Nansen report claims a NEP was approved but names none **(secondary, unverified)**.

### 1.4 Maturity, APIs, cost, latency

- **Maturity:** live on mainnet for asset movements through Intents only.
- **APIs:** the 1Click Swap REST API ("no confidential-specific SDK"). Balances can be read after authenticating with signed data. There is no general-purpose JS/TS SDK for contracts on the shard, because you cannot deploy contracts there **(inference: no source describes deployment; the private shard runs the Intents engine)**.
- **Cost and latency:** "configured fees all behave exactly as they do today"; no latency figures published. One analysis says TEE execution avoids proof generation so latency is close to normal **(secondary)**.

### 1.5 Can it store or verify identity records privately?

**No, not today.** Confidential Intents moves balances. It has no place to put a DID document hash, a status list or a policy hash, no view method an authorized verifier could call, and no offline proof format. **(inference, high confidence, from 1.1 to 1.4.)**

What you can do on **public** NEAR mainnet without revealing anything:

- Write only **salted commitments or Merkle roots** (32 bytes each). A root says nothing about who holds which clearance. A verifier who is given the leaf data and the inclusion path (by HQ, peer to peer) checks it against the root.
- Storage costs **1 NEAR per 100 KB** of contract state (1E19 yoctoNEAR per byte; https://docs.near.org/protocol/storage/storage-staking). Keeping only the latest root per category in state, and emitting history as event logs, keeps cost negligible **(inference)**.
- **Residual leak on the public chain:** the anchor account's existence and the cadence of its writes. Batching all changes into fixed-interval epochs (for example every hour, even when nothing changed) hides when individual people were added or revoked **(inference)**.
- **Do not put ciphertext of clearance data on chain.** Anything encrypted today can be stored forever and decrypted later if a key leaks or the algorithm breaks. Commitments without ciphertext have no such risk **(inference)**.

### 1.6 What NEAR AI Cloud's TEE shares with this

- NEAR AI Cloud runs inference in an Intel TDX plus NVIDIA confidential GPU enclave, and exposes attestation reports and per-response signatures (https://near.ai/ ; verification index https://docs.near.ai/cloud/verification ; verifier source https://github.com/nearai/nearai-cloud-verifier). Its CVMs are built on dstack (repositories `nearai/dstack-images`, `nearai/meta-dstack`).
- The shared element with the private shard is the **idea** of TEE-based trust (hardware attestation instead of trusting operators). I found **no documented technical link** between NEAR AI Cloud attestation and the private shard or its bridge.
- **Useful to you:** the gate can treat "this request goes to a NEAR AI Cloud model whose attestation verified" as an environment attribute in its routing decision (section 4.4). MPC CKD (above) is the most plausible future path to a NEAR-native confidential store for TEE apps, but it is research-stage **(inference)**.

### 1.7 Recommendation for the owner's requirement

The literal requirement "use NEAR confidential transactions for identity records" cannot be met today. Recommend:

1. Meet the intent (nothing about clearance, roles or relationships is public) with **commitments-only anchoring** on public mainnet.
2. Wrap anchoring in one interface (`anchor(root, kind, epoch)`, `latest(kind)`) so a confidential backend can replace it later.
3. Ask NEAR directly (through your NEAR AI contact) whether the private shard will accept third-party contracts and when view keys ship. Treat their answer as the trigger for a later phase.

---

## 2. DID methods on NEAR

### 2.1 What exists

**A. The registered `did:near` (Ontology, 2020).**
- Registered in the W3C DID Extensions registry: `methods/near.json`, status "registered", contact "Ontology Foundation", spec at https://github.com/ontology-tech/DID-spec-near/blob/master/NEAR/DID-Method-NEAR.md (registry entry last changed 2021-11-06; https://github.com/w3c/did-extensions).
- Spec: start date 2020-07-23, last push to the repo 2020-08-02, 2 stars, **LGPL-2.1**. It defines CRUD against a "registry" contract (`reg_did_using_account`, `get_document`, `add_controller`, `deactivate_did`), uses the old `publicKey` property and a secp256k1 key type in its example (NEAR accounts use Ed25519), and points to a placeholder NEP (`#0000`). No deployed registry or resolver is referenced.
- Verdict: abandoned, pre-DID-Core-1.0, not implementable as written.

**B. The `did:near` in NEAR's own docs (NTT DATA Innovation Center Web3 / KayTrust).**
- https://docs.near.org/primitives/didnear. Two forms: `did:near:alice.near` (built from the account's FullAccess keys over RPC) and `did:near:<base58>` (looked up via `identity_owner` on a registry contract, testnet `neardidregistry.testnet`). A companion "ProofType" contract records a SHA-256 hash of a credential once per `(did, cid)`.
- Covers create and read only. **Update and deactivate are not specified.** Only testnet contracts are listed for ProofType.
- Code: `DTI-web3/did-near` (last push 2025-07-04, no license file), `DTI-web3/did-near-resolver` (last push 2026-01-21, no license file). npm `@kaytrust/did-near-resolver` 1.4.12 (2026-01-21, ISC, depends on `near-api-js`, `bs58`, `did-resolver`).
- Privacy problem: the named-account form publishes every FullAccess key of the account and links the DID to a public NEAR account and its whole transaction history. The ProofType contract writes `subject_did` next to a credential hash in public state, which reveals that a credential was issued to that person **(inference)**.
- It is **not** the method registered with W3C under the same name: a name collision.

### 2.2 Should you write your own `did:near`?

No. The name is taken twice already, the spec work (CRUD, security and privacy sections, test suite, registry submission) is substantial, and a ledger-resolved DID makes offline resolution depend on caching chain state anyway. If the owner later wants a NEAR-native method, it needs a **new method name** and should be built on the anchoring design below, not on publishing keys in contract state **(inference)**.

### 2.3 Comparison for your needs

| Method | Offline resolution | Rotation and deactivation | Privacy | Maturity | Fit |
|---|---|---|---|---|---|
| `did:key` | Yes, the DID is the key | None (new key means new DID) | Good if not reused across contexts | W3C CCG draft, very widely implemented | **Agents and machines**: short-lived or device-bound keys |
| `did:peer` | Yes | Limited (numalgo 2 static; 4 has a long form) | Best: pairwise, never published | DIF spec | Pairwise links between two offline edge devices |
| `did:web` | No (needs HTTPS fetch) | Edit the file; no history | Exposes a host | W3C CCG report | Not recommended alone: no verifiable history |
| **`did:webvh`** | **Yes, once the log is cached**; the spec allows verifying a log "obtained from sources other than its corresponding HTTPS location" and resuming from cached verified state | Hash-chained log, pre-rotation, optional witnesses, deactivation | Host can be your organization's internal server | DIF spec v1.0 (https://identity.foundation/didwebvh/v1.0/) | **People and your organization** |
| `did:near` (A or B) | Only with cached chain state | A: specified but undeployed. B: not specified | Poor (public account linkage) | A: abandoned. B: testnet, partial | Not recommended |

### 2.4 Recommendation

- **Your organization (the root):** `did:webvh` with pre-rotation enabled, key held offline at HQ, log hosted by HQ (relay or internal web server). Log head hash anchored on NEAR each epoch.
- **People:** `did:webvh` under your organization's host, so key rotation and deactivation have a verifiable history. Federation to HQ is natural: HQ hosts and witnesses the logs.
- **Agents and machines (edge devices):** `did:key` with Ed25519. Bind each one to its person or to your organization with a credential (section 3). When a device is lost, you revoke the binding credential; the DID itself does not need to change.
- **Two edge devices with no HQ link:** they exchange `did:key` (or `did:peer`) and verify each other's binding credentials against their cached copy of your organization's DID log and status lists.
- This matches the current team identity code: `src/team/identity.ts` on branch `feat/procurement-p70-foundation` already creates an Ed25519 device key in SecretStorage, which maps directly to `did:key:z6Mk...` **(inference from reading that file)**.

Standards status: DID 1.1 is a W3C Candidate Recommendation Snapshot (2026-03-05) built on Controlled Identifiers 1.0 (https://www.w3.org/TR/did-1.1/).

---

## 3. Verifiable Credentials for authority, clearance and roles

### 3.1 Standards (status as of 2026-11-15)

| Spec | Status | Notes | Source |
|---|---|---|---|
| VC Data Model 2.0 | W3C Recommendation, 2025-05-15 | Secured by Data Integrity (embedded proof) or JOSE/COSE (enveloping); examples include SD-JWT and `bbs-2023` | https://www.w3.org/TR/vc-data-model-2.0/ |
| Data Integrity EdDSA Cryptosuites v1.0 | W3C Recommendation, 2025-05-15 | `eddsa-rdfc-2022` (RDF canonicalization, needs JSON-LD) and `eddsa-jcs-2022` (RFC 8785 JCS). Both: SHA-256 of canonical proof config and of canonical document, concatenated, signed with Ed25519. Keys as Multikey `z` + `0xed01` header. `proofValue` is base58btc multibase | https://www.w3.org/TR/vc-di-eddsa/ |
| Bitstring Status List v1.0 | W3C Recommendation, 2025-05-15 | GZIP bitstring, base64url multibase, min 131,072 entries for herd privacy, purposes `revocation` (permanent), `suspension` (reversible), `refresh`, `message`; `validUntil` and `ttl`; verifiers SHOULD cache; holder can "staple" the list | https://www.w3.org/TR/vc-bitstring-status-list/ |
| SD-JWT | RFC 9901, 2025-11-19 | Selective disclosure for JWS payloads | https://www.rfc-editor.org/rfc/rfc9901 |
| SD-JWT VC | draft-ietf-oauth-sd-jwt-vc-26 (2026-11-06), in IESG evaluation with an open DISCUSS | Not yet an RFC | https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/ |
| Data Integrity BBS (`bbs-2023`) | W3C Candidate Recommendation Draft, 2026-09-10 | Unlinkable selective disclosure; depends on the IRTF CFRG BBS draft, optional features "at risk" | https://www.w3.org/TR/vc-di-bbs/ |

### 3.2 TypeScript libraries (npm metadata read 2026-11-15)

| Package | Latest | License | Runtime deps | Offline | Note |
|---|---|---|---|---|---|
| `@digitalbazaar/vc` | 7.3.0 (2026-02-05) | BSD-3-Clause | `jsonld`, `jsonld-signatures`, contexts | Yes with a static document loader | Reference-grade, pulls JSON-LD stack |
| `@digitalbazaar/eddsa-jcs-2022-cryptosuite` | 1.0.0 (2024-11-08) | BSD-3-Clause | `canonicalize`, `@digitalbazaar/ed25519-multikey` | Yes | Smallest DB path; use as a **test oracle** |
| `@digitalbazaar/eddsa-rdfc-2022-cryptosuite` | 1.3.0 (2026-02-05) | BSD-3-Clause | `jsonld`, `rdf-canonize` | Yes with static contexts | Heavy |
| `@digitalbazaar/vc-bitstring-status-list` | 2.0.1 (2025-03-07) | BSD-3-Clause | 4 DB packages | Yes | |
| `@digitalbazaar/bbs-2023-cryptosuite` | 2.0.1 (2024-08-26) | BSD-3-Clause | BLS12-381 libs, `cborg` | Yes | Needs pairing crypto not in `node:crypto` |
| `@veramo/core` | 7.0.2 (2026-09-23) | Apache-2.0 | plugin framework, many transitive deps | Partly | Agent framework, too large for a zero-dep bundle |
| `@sphereon/ssi-sdk.core` | 0.40.1 (2026-07-03) | Apache-2.0 | built on Veramo | Partly | Same concern |
| `@sd-jwt/sd-jwt-vc` / `@sd-jwt/core` | 0.24.3 (2026-11-03) | Apache-2.0 | `zod`, `@owf/*` | Yes | OpenWallet Foundation; tracks the draft |
| `@spruceid/didkit-wasm-node` | 0.2.1 (2022-03-16) | none listed | 0 | Yes | Stale on npm; SpruceID's active work is in Rust |
| `@transmute/verifiable-credentials` | 0.3.4 (2024-08-12) | Apache-2.0 | 11 incl. `jose`, `moment` | Yes | |
| `canonicalize` | 5.1.0 (2026-09-18) | Apache-2.0 | 0 | Yes | Reference JCS |
| `jose` | 6.2.17 (2026-11-09) | MIT | 0 | Yes | Already allowed in the relay |

### 3.3 Recommendation: implement a narrow profile yourself

Reasons: zero runtime dependencies in the extension bundle; the hard parts already exist; the profile is small.

- **What already exists:** `src/domain/team/canonical.ts` (branch `feat/procurement-p70-foundation`) is a strict subset of RFC 8785: keys sorted by UTF-16 code units, strings via `JSON.stringify`, integers only, no `-0`, depth limit 16. For documents that contain only strings, booleans, safe integers, arrays and objects, its output equals JCS output **(inference from reading the code; confirm with the W3C test vectors)**. Ed25519 sign and verify use `node:crypto`.
- **Profile ("our VC profile v1"):**
  - VC 2.0 JSON with a fixed `@context` list (`https://www.w3.org/ns/credentials/v2` plus one of your own). No JSON-LD expansion at runtime; reject any other context. This is allowed by VC 2.0, which lets JSON-only processors work with known contexts **(inference from the spec's processing model)**.
  - Proof: `DataIntegrityProof` with `eddsa-jcs-2022` only. Implement base58btc and the `0xed01` multikey header (about 40 lines).
  - Numbers: forbid non-integers in credentials (dates are strings anyway).
  - Status: `BitstringStatusListEntry` with `revocation` and `suspension`, GZIP via `node:zlib`, list size 131,072 bits (16 KB raw, tiny compressed).
  - Interop: add `@digitalbazaar/eddsa-jcs-2022-cryptosuite` and `@digitalbazaar/vc` as **devDependencies only** to cross-check our signatures in tests. Use the spec's example vectors as frozen tests.
- **Selective disclosure without new crypto:** issue **atomic credentials**, one fact each, and **threshold credentials** for ordered facts. Example: someone cleared to SECRET holds `clearanceAtLeast: CONFIDENTIAL` and `clearanceAtLeast: SECRET` (both from HQ), plus one credential per role and per compartment. To prove "clearance at least SECRET and role X", the agent presents exactly two credentials. Cost: more credentials to manage; the holder's DID still links them (acceptable inside one organization) **(inference)**.
- **Later options:** SD-JWT VC once it is an RFC (relay could use `jose`; extension could do it with `node:crypto`, since SD-JWT is only SHA-256 digests plus a JWS). BBS only if unlinkability across organizations becomes a requirement; it needs a BLS12-381 implementation that `node:crypto` does not provide.

### 3.4 Credential types you need

| Credential | Issuer | Subject | Key claims |
|---|---|---|---|
| `MembershipCredential` | Your organization | person DID | member of org, person's display name optional |
| `ClearanceCredential` (threshold) | Your organization's security officer role | person DID | `scale`, `atLeast` level, `validUntil` (screening expiry) |
| `CompartmentCredential` | Compartment owner | person DID | compartment ID |
| `RoleCredential` | Your organization or team lead with delegation | person or agent DID | role, scope (project, repo) |
| `DeviceBindingCredential` | person or your organization | device `did:key` | "this device acts for this person", device class (managed, personal, edge) |
| `DelegationCredential` | person (or agent with re-delegation right) | agent `did:key` | subset of roles, level cap, compartments subset, expiry, `maxDepth` |
| `PolicyBundle` (signed, not a VC necessarily) | Your organization | none | label scale, routing table, rules; its hash is anchored |

**Delegation only narrows** is checked by the verifier, not trusted: for each link, level cap at most the delegator's, compartments a subset, roles a subset, expiry no later than the delegator's earliest relevant credential, depth limit respected, and every credential in the chain unrevoked.

---

## 4. Classification and access control model

### 4.1 What established systems do

- **Bell-LaPadula style (lattice):** a label is a level plus a set of categories (compartments). A subject may read an object if the subject's level is at least the object's level and the subject's categories include the object's. Writing down is forbidden ("no write down"), which in practice becomes a high-water mark on outputs **(standard model; described from general knowledge, no single URL read)**.
- **ABAC, NIST SP 800-162 (Final, updated 2019-08-02):** decisions from subject attributes, object attributes, requested operations and environment conditions against policy (https://csrc.nist.gov/pubs/sp/800/162/upd2/final). Clearance is a subject attribute; the label is an object attribute; "device is offline" or "model is attested TEE" are environment attributes.
- **Policy engines:** Cedar (`@cedar-policy/cedar-wasm` 4.14.0, 2026-10-19, Apache-2.0, 13.5 MB unpacked) and OPA (`@open-policy-agent/opa-wasm` 1.10.0, 2024-11-08, Apache-2.0, deps `sprintf-js`, `yaml`). Both work offline but would break the zero-dependency bundle and add a large WASM payload. XACML is heavier still. **Recommendation:** keep a fixed, hand-written evaluator for the label check (it is a few dozen lines) and keep Cedar as a possible later option for rich role rules **(inference)**.
- **Government of Canada levels** (https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/safeguarding-equipment-sites-assets-information/levels-security.html, page date 2026-08-27):
  - Protected A, B, C: compromise could cause "injury", "serious injury", "extremely grave injury" to a person, organization or government.
  - Confidential, Secret, Top Secret: "injury", "serious injury", "exceptionally grave injury" to the national interest.
  - Screening: reliability status for Protected A and B, enhanced reliability for Protected C, security clearance for classified levels.
  - Protected and Classified are **two families**, not one ladder.
- **NATO:** NATO RESTRICTED, NATO CONFIDENTIAL, NATO SECRET, COSMIC TOP SECRET, plus NATO UNCLASSIFIED; ATOMAL is an add-on designation, not a level (AC/35-D/2002 summary, **(secondary)** copies only; I could not read a current nato.int text).
- **Cloud context in Canada:** Cloud services for Protected B data are assessed by the Canadian Centre for Cyber Security against the Medium cloud profile (formerly PBMM) **(secondary: AWS and vendor pages)**; official profile page: https://www.canada.ca/en/government/system/digital-government/modern-emerging-technologies/cloud-computing/government-canada-security-control-profile-cloud-based-it-services.html. I found **no evidence** that NEAR AI Cloud has a CCCS Medium assessment.

### 4.2 Recommended compact model

**Label** (attached to a file, folder, chat, project, or tool output):

```
{ scale: "ca-gc" | "nato" | "org", level: <int index into the scale>,
  compartments: [ids], releasability: [org or country codes] | "ORG-ONLY",
  handling: [ "local-only" | "attested-cloud-ok" | "no-agent-tools" ... ] }
```

**Clearance** (built by the gate from verified credentials):

```
{ scale, maxLevel, compartments: [ids], releasability: [codes], expiresAt }
```

**Rule:** access allowed when `clearance.scale == label.scale` (or a policy-defined mapping exists), `maxLevel >= level`, `label.compartments ⊆ clearance.compartments`, releasability satisfied, nothing expired or revoked, and the delegation chain allows the operation.

**Scales ship as presets in the policy bundle**, each an ordered list:
- `org` (default for commercial users): Public < Internal < Confidential < Restricted.
- `ca-gc`: model the two Canadian families as one ordered list only if your organization's security officer accepts it, for example Unclassified < Protected A < Protected B < Protected C, and a second scale for Confidential < Secret < Top Secret. Keep them separate by default and let policy map clearances across (for example "Secret clearance also covers Protected A and B"), because the official sources treat them as different families **(inference)**.
- `nato`: Unclassified < Restricted < Confidential < Secret < Cosmic Top Secret.

**Session high-water mark:** every agent session carries the highest label it has read. Anything it writes, sends or summarizes inherits that label. A session can never go back down without a human declassification action that is logged.

### 4.3 Offline evaluation

All inputs are local: cached DID logs, cached credentials, cached status lists, the signed policy bundle. The gate fails closed when a needed status list is past `validUntil` plus the policy's offline grace for that level (for example: Internal 7 days, Restricted 24 hours, anything with `local-only` handling 0 grace for new grants but existing local work allowed) **(inference, values are examples)**.

### 4.4 Steering inference routing

Policy maps each level (and any `handling` flag) to a routing tier:

| Tier | Meaning | Example default |
|---|---|---|
| `any-cloud` | Any configured provider | Public |
| `attested-cloud` | Only NEAR AI Cloud models whose attestation and response signature verified for this request | Internal, Confidential, Protected A |
| `local-only` | On-device model only; no network egress of content | Restricted, Protected B unless your organization approves an assessed cloud, Protected C, all classified levels |
| `deny` | No model may see it | Optional per compartment |

The router asks the gate before every request with the session's high-water label. If the label requires `local-only` and no local model is configured, the request is refused with a plain explanation.

Important caveat: real Secret or Top Secret information may only be processed on systems accredited for it. A VS Code extension on an ordinary laptop is not that. The gate is an organizational control that prevents mistakes; it does not make a device accredited **(inference)**.

---

## 5. Recommended design (plain language)

### 5.1 Where things live

| Item | DID document | Credentials (held by person, agent, device) | NEAR public chain | NEAR confidential | Only local |
|---|---|---|---|---|---|
| Public keys, key rotation history | Yes | | Log head hash only (inside a root) | Later, if available | Cached copy |
| Service endpoints (HQ relay) | Your organization's DID only | | | | |
| Membership, clearance, roles, compartments | **Never** | Yes | **Never** | | Cached |
| Device and agent bindings, delegations | | Yes | | | Cached |
| Revocation and suspension | | Status list credential from HQ | Hash of each list (inside a root) | | Cached list with `validUntil` |
| Policy bundle (scales, routing table) | | Signed bundle | Hash (inside a root) | | Cached |
| Audit log of gate decisions | | | Optional periodic root | | Yes, signed, append-only |
| Private keys | | | | | SecretStorage only |

### 5.2 Add, change, remove, revoke

- **Add a person:** HQ creates or accepts the person's `did:webvh`, issues membership plus clearance, role and compartment credentials, assigns random status list indexes. Next epoch: new roots anchored on NEAR.
- **Add an agent or machine:** the device makes an Ed25519 key (`did:key`). The person signs a device binding or delegation credential with a narrow scope and short expiry (for example 30 days, renewable).
- **Change a role or clearance:** issue the new credential, then set the old one's revocation bit. Lowering a clearance must revoke every higher threshold credential.
- **Suspend:** flip the suspension bit (reversible), for example during an investigation or a lost laptop that might be found.
- **Remove a person:** revoke all their credentials, add a deactivation entry to their `did:webvh` log. Their devices' bindings fail on the next status check.
- **Lost device:** revoke its binding credential. No DID change needed.
- **Compromised organization signing key:** rotate using `did:webvh` pre-rotation from the offline root key, re-issue credentials. This is the worst case; keep the root key offline and use a separate online issuing key **(inference)**.

### 5.3 How offline edge devices verify

1. Before going offline, the device syncs: your organization's DID log, the DID logs of people it works with, all status lists, the policy bundle, and the latest anchor roots plus inclusion proofs.
2. Offline, it verifies signatures, checks status bits in the cached lists, checks the delegation chain, and checks that the cached lists and bundle hash into the roots it saw (this protects against a forged list being planted).
3. Each level has a maximum offline age. Past it, the gate refuses new access at that level.
4. Two offline devices can exchange stapled status lists; a device accepts a newer list only if it is signed by your organization and newer than its own.
5. On reconnect, it re-syncs and re-evaluates any session that ran on stale data, and flags it for review.

### 5.4 Federation to HQ

HQ (the relay) is the issuer, the `did:webvh` host and witness, the status list publisher and the only account that writes NEAR anchors. Edge sites cache and verify. A second site can be given its own issuer DID with a narrower delegation from your organization (for example "may issue clearances up to Protected B for compartment X"), checked like any other delegation.

### 5.5 Open risks

1. **No NEAR confidential storage exists for this use.** The owner's requirement must be re-stated as "nothing readable on chain" or wait for NEAR. Ask NEAR for a roadmap in writing.
2. **The private shard trust model is permissioned and lightly documented**: seven validators, TEE bridge, no published NEP or source found. Even when it opens up, privacy rests on those operators and the enclave hardware.
3. **Metadata on the public chain**: the anchor account and its timing reveal that your organization exists and is active. Fixed-interval anchoring reduces this.
4. **`did:near` name collision**: two incompatible definitions already exist; avoid the name.
5. **Offline revocation lag**: a revoked person can keep working on a device until its cached list expires. Set per-level offline limits deliberately.
6. **Issuer key compromise** at HQ undermines everything; use offline root plus online issuer key, and pre-rotation.
7. **Threshold credentials leak a little**: the set of credentials someone holds shows their maximum level to anyone they present all of them to. Present only what is asked.
8. **Device clocks**: offline devices can drift; use monotonic counters and last-sync time, not just wall clock, for expiry decisions.
9. **Not accreditation**: the gate does not make a device approved for classified information.
10. **Not post-quantum**: Ed25519 signatures and the anchors are not quantum-safe. Anchored roots stay valid as commitments, but signatures would need migration. The paused v0.5 sovereignty-gate work on post-quantum cryptography is relevant later.
11. **Unverified secondary claims** about NEAR (default confidentiality dates, validator decentralization, NEP approval) conflict between outlets.
12. **JCS subset assumption**: the existing canonical JSON is believed to match RFC 8785 for integer-only data; confirm with the W3C `eddsa-jcs-2022` test vectors before relying on interop.

---

## Sources read

- NEAR: https://www.near.org/blockchain ; https://www.near.org/blog/how-confidential-intents-works ; https://www.near.org/blog/announcing-general-availability-of-confidential-intents ; https://tools.prnewswire.com/en-us/live/20813/release/20260225EN95768 ; https://docs.intents.aurora.dev/confidential-intents ; https://docs.intents.aurora.dev/intents-swap/confidential-swaps ; https://blog.nearone.org (index) ; https://blog.nearone.org/research/2026/02/23/mpc-ckd.html ; https://docs.near.org/primitives/didnear ; https://docs.near.org/protocol/storage/storage-staking ; https://docs.near.ai/cloud/verification ; GitHub `near` and `nearai` organization repository lists, `near/intents` README, `near/NEPs` (via GitHub API).
- DID: https://github.com/w3c/did-extensions (`methods/near.json`) ; https://github.com/ontology-tech/DID-spec-near ; https://github.com/DTI-web3/did-near ; https://github.com/DTI-web3/did-near-resolver ; https://www.w3.org/TR/did-1.1/ ; https://identity.foundation/didwebvh/v1.0/
- VC: https://www.w3.org/TR/vc-data-model-2.0/ ; https://www.w3.org/TR/vc-di-eddsa/ ; https://www.w3.org/TR/vc-bitstring-status-list/ ; https://www.w3.org/TR/vc-di-bbs/ ; https://www.rfc-editor.org/rfc/rfc9901 ; https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/ ; npm registry metadata for the packages in 3.2.
- Access control: https://csrc.nist.gov/pubs/sp/800/162/upd2/final ; https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/safeguarding-equipment-sites-assets-information/levels-security.html ; https://www.canada.ca/en/government/system/digital-government/modern-emerging-technologies/cloud-computing/government-canada-security-control-profile-cloud-based-it-services.html
- Secondary (used only where marked): coindesk.com, cryptobriefing.com, coinalertnews.com, theblock.co, nato.int search results, aws.amazon.com/compliance/cccs.

# Calimero Network as a privacy layer for identity and governance: evaluation

Research report, written 2026-11-15. Every fact was read on that date from the sources named inline. Statements marked **(inference)** are my reasoning, not something a source says. Source code of the `core`, `documentation`, `mero-js` and `mero-tee` repositories was cloned shallowly and read only; nothing was built or run. File references below are paths inside those repositories.

Context read first: `.planning/research/platform-direction/identity-research.md` (table 1.1 listed "Calimero private shards ... no 2026 status found"; that row now points to this evaluation, see section 1).

---

## 0. The short answer

**Recommendation: not now. Do not adopt or pilot Calimero for the identity and governance layer.** Keep the current plan (W3C DIDs and VCs as source of truth, HQ-hosted signed logs, 32-byte roots on public NEAR behind a pluggable anchor interface). Re-check Calimero only if HQ itself moves onto Intel TDX hosting (see section 5).

The reason is not quality. It is that **the Calimero that matched our idea no longer exists**:

1. **NEAR was removed from Calimero in March 2026.** Release 0.10.1-rc.9 (2026-03-25) says local group governance "replaces all blockchain/NEAR/relayer infrastructure for context management ... all NEAR protocol dependencies have been removed from core." NEAR wallet sign-in was removed in 0.11.0-rc.7 (2026-06-24). (`core/CHANGELOG.md`, lines 5145-5147 and 5080.) There is no anchoring, proxy contract or verification on NEAR any more.
2. **The peer-to-peer node was removed on 2026-10-28.** Release 1.0.0-rc.1 "replaces the 0.x peer-to-peer node" and lists as removed "gossip, DAG sync, governance ops, delegated execution" (`core/CHANGELOG.md`, lines 2019-2072). There is no in-place upgrade from 0.x.
3. **Calimero 1.0 is a confidential cloud on Intel TDX.** Each app instance is a Raft-replicated log on 3 attested TDX nodes by default; clients verify the node's TDX quote before sending anything (`core/README.md`). "Production nodes run in Intel TDX VMs" (`core/docs/src/content/docs/operate/install.mdx`). The node images in mero-tee are built "for GCP TDX" (`mero-tee/README.md`).
4. **Our edge hardware cannot run it in a protected mode.** AMD Strix Halo and NVIDIA GB10 have no Intel TDX **(inference: TDX is an Intel Xeon feature)**. Without TDX a node runs only in `--dev` mode, whose storage key is `SHA-256("calimero-dev-storage-key|" + cluster)`, which "anyone can compute. Never put real data on a `--dev` node." (`operate/security.mdx`, lines 126-140).
5. **No LAN or offline story.** "There is no peer discovery, relay or NAT traversal: nodes of a cluster are servers that know each other's URLs" (`operate/networking.mdx`); "no gossip, no peer discovery and no peer-to-peer stream protocol" (`protocol/networking.mdx`). Raft needs a majority to write. Production nodes get their disk key from mero-kms, which runs as GCP TDX images (`mero-tee/README.md`).

---

## 1. What Calimero is (as of 2026-11-15)

### 1.1 History in one paragraph

Calimero Ltd. (London) was spun out of the NEAR ecosystem and raised a USD 8.5M seed in January 2023, co-led by Khosla Ventures, Lyrik Ventures and NEAR Foundation, to build "private sharding" (https://www.theblock.co/post/204235/private-sharding-startup-calimero-network-raises-8-5-million ; https://siliconangle.com/2023/01/23/private-blockchain-sharding-startup-calimero-raises-8-5m/). Through 2024 and 2025 the 0.x node was a peer-to-peer system: "contexts" synced over libp2p gossip with CRDT state, and each context had a config contract plus a per-context **proxy contract** on NEAR, later also Starknet, ICP and Ethereum (`core/CHANGELOG.md`, 0.2.0 to 0.6.0 entries, lines 5300-5365; Stellar was deprecated in 0.8.0). In 2026 the project moved away from chains (March), added TDX attestation for fleet nodes (0.10.1-rc.10, 2026-03-30), and on 2026-10-28 replaced the whole P2P node with the 1.0 design below. I found no funding or customer news after 2023 (web search, 2026-11-15).

### 1.2 Architecture of Calimero 1.0 (current)

From `core/README.md` and `core/docs/src/content/docs/protocol/glossary.mdx`:

| Concept | What it is now |
|---|---|
| Cluster | A set of `merod` nodes sharing one system group and one storage key |
| Node | One `merod` process in a TDX VM, reached only over HTTP at a public URL |
| System group | A cluster-wide Raft log (openraft) holding nodes, accounts, passkeys' public keys, organizations, teams, invites, packages, governance |
| App group | One Raft log per app instance on its replicas (3 by default). The leader runs a call on wasmtime and followers apply the resulting diff; nobody re-executes |
| App instance | What 0.x called a "context" (`meroctl context` was renamed `meroctl instance` in 1.0.0-rc.26, 2026-11-15) |
| State | One leader orders every write, so collections are no longer CRDTs (`CHANGELOG.md` line 1743) |
| Apps | Rust with `calimero-sdk`, built into a `calimero:app` WebAssembly component, shipped as a signed `.mpk` package; the registry signs manifests with Ed25519 over JCS (`app-registry` repo description) |
| Identity | Accounts are 32 random bytes; people sign in with WebAuthn passkeys; machines use `cal_...` API keys; organizations with roles guest < member < admin < owner; teams; invite tokens |
| Clients | `meroctl` (Rust CLI), mero-js (TypeScript, browser and Node 18+), Python, Swift, Kotlin; `meroctl proxy` exposes a plain HTTP API on loopback after attesting the node (`operate/plain-http.mdx`) |
| Relation to NEAR | None. The 1.0 docs mention no chain at all (grep of `core/docs` and the `documentation` repo for NEAR, blockchain, anchor, proxy contract: no hits other than the words "near zero") |

### 1.3 Language, licence, maturity, activity

- **Language:** Rust (node, CLI, SDK); apps are WASM components; TypeScript, Python, Swift and Kotlin clients.
- **Licence:** core `README.md` says "MIT OR Apache-2.0"; `LICENSE.md` is Apache-2.0 and `NOTICE` says files are Apache-2.0 unless noted (the GitHub API reports `NOASSERTION`). mero-js, app-registry, Python, Swift, Kotlin SDKs: MIT. mero-tee: Apache-2.0. Several repos (apps, documentation, mero-react) have no licence file.
- **Activity:** very high. `core` last commit 2026-11-15 18:25 UTC. 28 release candidates of 1.0 between 2026-10-28 and 2026-11-15, three of them on 2026-11-15 alone (`gh api repos/calimero-network/core/releases`). 100+ commits since 2026-10-15.
- **Size of community:** `core` has 172 stars, 36 forks, 18 open issues, 30 contributors all time (GitHub API, 2026-11-15). In the last month, of 100 commits, 79 are by one author (the co-founder Sandi Fatic), 17 by one other, 4 by Dependabot **(inference: bus factor of about one to two people)**.
- **Stability:** 1.0 is still a release candidate. The changelog records several **hard cutovers** inside the 1.0 RC series ("no interop with earlier nodes or log entries; clusters are recreated", `CHANGELOG.md` lines 1778 and 1905; rc.20 hard cutover for every app in an organization). mero-js is at major version 35.4.0, and "From version 27 this is the Calimero 1.0 client only" (`mero-js/README.md`).
- **Production users:** none named in any source I read. The 2023 coverage called the product "closed alpha".
- **Audits:** no third-party security audit report found. mero-tee runs `cargo audit` in CI (`.github/workflows/security-audit.yaml`) and its changelog mentions an internal "audit of core" that found merod logging app data at its default level (`mero-tee/CHANGELOG.md` line 187).

---

## 2. Privacy model, precisely (Calimero 1.0)

Source: `core/docs/src/content/docs/protocol/security-model.mdx`, `protocol/encryption.mdx`, `protocol/key-rotation.mdx`.

- **Claim:** "nobody operating the cluster, Calimero included, can read an app's data or put new code in front of it without the party the deployment named for that decision."
- **Trusted:** Intel TDX and its DCAP attestation; the Sigstore-signed mero-tee release; mero-kms; the `merod` build in the image; the person's passkey authenticator.
- **Not trusted:** host, hypervisor, disks, network, TLS terminators, the operator, other tenants.
- **Do nodes see plaintext?** Yes. Every node on an approved release is "the trusted computing base for those apps". Privacy against the operator rests on the TEE, not on end-to-end encryption between members. No ZK or MPC is used. This is the same trust shape as NEAR's private shard: trust the enclave **(inference)**.
- **Encryption:** client to node over a Noise NK sealed channel to a transport key bound into the TDX quote; at rest AES-256-GCM under a cluster key K_c, which is wrapped under a per-release storage key K_r released by mero-kms only to an attested VM.
- **One key per cluster:** "One K_c covers every app on a cluster; keys per app from mero-kms are not done" (security model, "What is not protected yet").
- **Known gaps, stated by Calimero:** every node, even on an unapproved release, holds the whole system state (accounts, passkey public keys, memberships, approvals); some commands (memberships, invites, node registration) "still name an actor any node of the cluster can claim"; rollback protection is partial; the consent page travels as plain HTTPS; side channels are out of scope; a debug image "protects nothing".
- **Metadata that leaks:** the network sees that clients talk to nodes, sizes and timing; the host sees sizes of sealed values, row counts, which groups exist; the operator sees counts, Raft status, node list, governance, quotas (`encryption.mdx`, "What an observer can still see").
- **Membership and keys:** invites are `inv_...` tokens (only the token's public key is stored); sessions last 15 minutes, refresh tokens 30 days with reuse detection; API keys up to 1 year; passkeys added and removed by the account; organization recovery key is Ed25519 held offline by the owner; the operator key is "not rotated yet" (`key-rotation.mdx`).
- **Offline-verifiable output:** every answer carries a receipt, an Ed25519 signature by an attested node key over `(app, index, SHA-256(JCS(result)), node)`, "checkable later, offline, by anyone who holds that node's receipt-key attestation" (`tee-attestation.mdx`). This is the one piece conceptually close to what we need.
- **What reaches NEAR mainnet:** nothing. There is no chain component.

---

## 3. Fit to our needs, item by item

| Need | Fit | Why |
|---|---|---|
| (a) Private storage and sharing of DID logs, VCs, status lists, policy bundles among your organization's nodes | **Poor** | Works only on TDX hosts (GCP TDX images today). Calimero brings its own accounts, passkeys, organizations, roles, teams and invites, which would duplicate and compete with our DIDs and VCs. All replicas see plaintext inside the enclave. |
| (b) Private anchoring or proof to NEAR without revealing contents | **None** | NEAR support was removed in March 2026. Receipts prove "a genuine node returned this answer", not a public, timestamped commitment. Our Merkle-root anchor is still needed. |
| (c) Offline edge groups that sync on a LAN and federate to HQ later | **None** | No peer discovery, no relay, no NAT traversal, servers with fixed URLs; Raft needs a majority; production nodes need mero-kms and TDX; clients fetch Intel collateral and the signed release (mobile and web clients from `https://cloud.calimero.network`, `operate/networking.mdx`). The old CRDT and gossip design that might have fit was deleted on 2026-10-28. |
| (d) Team Mode signed append-only event log over git | **Poor** | Could hold the log as an app instance, but it would replace a serverless, any-transport design with a server cluster; still no offline sync between people's devices. Git is a better carrier for an offline-first, signed log **(inference)**. |
| (e) Messaging relay | **Possible but heavy** | Realtime events and presence exist. It would mean running a 3-node TDX cluster for something our relay already does. |
| (f) AMD x86-64 and NVIDIA ARM64 Linux boxes and the Theia container appliance | **Dev mode only** | `merod` binaries and Docker images ship for Linux x86_64 and aarch64 (`operate/install.mdx`), but without TDX only `--dev` runs, with a publicly derivable storage key. Running `merod` inside our container adds a Rust service and its data dir. |
| (g) Integration from a zero-runtime-dependency TypeScript extension | **Poor** | mero-js has 3 runtime dependencies (`@noble/hashes`, `@phala/dcap-qvl`, `openapi-fetch`; `mero-js/package.json`), despite the repo description saying "zero dependencies", and its major version moves often (35.x). The alternative is spawning `meroctl proxy` and calling plain HTTP on loopback, which means shipping and updating a native binary. Either way it is a separate service, not a library. |
| (h) Compatibility with our design (W3C DIDs and VCs stay source of truth; gate decides offline) | **Weak** | Nothing in Calimero uses DIDs or VCs; its authority model (passkeys, roles, consent page) would be a second, parallel source of truth. It could only be dumb encrypted storage for our signed documents, and for that it is far heavier than needed. The offline gate is unaffected because it never depends on Calimero **(inference)**. |

---

## 4. Risks

- **Maturity:** 1.0 is a release candidate with repeated hard cutovers in its first three weeks; the 0.x line it replaced was dropped with no migration. Anything we built on 0.x would already be stranded; anything on 1.0 RC could be next **(inference)**.
- **Strategy drift:** the project has changed shape twice in 2026 (off NEAR, then off P2P). Its current target is an app-hosting cloud ("like Firebase"), not identity infrastructure.
- **Single vendor:** releases, node images, mero-kms clusters, the attestation mirror and the registry are Calimero's. Self-hosting needs your own TDX hosts plus your own mero-kms.
- **Hardware lock-in:** Intel TDX only, GCP image recipes today. Conflicts with AMD and NVIDIA edge hardware and air-gapped sites.
- **Licence:** permissive (Apache-2.0 / MIT) for core and SDKs, so a fork is legally possible; several repos have no licence file.
- **Security assurance:** strong design documentation and an honest "not protected yet" list, but no independent audit found, and a small team.
- **Governance:** company-controlled; no foundation or external maintainers visible.
- **Cost and operations:** at least 3 TDX VMs per cluster plus a KMS, TLS front, DNS and passkey origins (`operate/deployment.mdx`). Calimero Cloud pricing was not found.
- **If Calimero shuts down:** data sits in sealed RocksDB stores and sealed backups that open only on a cluster holding the same K_c, or via recovery-disk files sealed to a backup holder's key. You would need to run the open-source stack yourself on TDX to read it back **(inference from `encryption.mdx` and `security.mdx`)**. Our design avoids this because signed documents stay readable on every device.

---

## 5. Recommendation

### 5.1 Not now

Do not adopt, and do not spend a sprint piloting, Calimero for identity, governance, Team Mode sync, edge federation or anchoring. It fails the three hard needs: offline LAN edge groups, NEAR anchoring, and AMD/NVIDIA hardware. Update `identity-research.md` table 1.1: Calimero dropped NEAR (2026-03-25) and P2P (2026-10-28) and is now a TDX confidential cloud.

### 5.2 Re-check triggers

Revisit only if one of these becomes true:
1. HQ moves its services (DID host, status publisher, relay) onto Intel TDX hosts and you want operator-blind storage there.
2. Calimero ships 1.0 final, keeps its API stable for 6 months, publishes an independent audit, and supports AMD SEV-SNP or a non-TEE mode with real key management.

### 5.3 If trigger 1 happens: a small desk-and-lab spike (about 2 days)

Steps:
1. On one Intel TDX VM per node (or Calimero Cloud), stand up a 3-node cluster from a pinned release.
2. Write one Rust app that stores opaque, already-signed blobs (our DID log entries, VCs, status lists, policy bundles) keyed by hash, with read access for an organization team.
3. From a Node script (not the extension), use `meroctl proxy` on loopback to put and get those blobs.
4. Verify on a disconnected laptop that the documents fetched still verify with our own `eddsa-jcs-2022` code and cached DID logs.

Success criteria: the extension bundle gains zero runtime dependencies; our gate decides identically with Calimero offline or gone; the operator cannot read stored documents (check with the documented operator API); a cluster upgrade within the pinned major does not force data recreation; per-month cost of the cluster is known.

### 5.4 Alternatives that fill the same gap (brief, not deeply researched)

| Option | Privacy | Offline edge | NEAR proof | Effort | Note |
|---|---|---|---|---|---|
| **HQ-hosted signed logs plus Merkle roots on public NEAR (current plan)** | Contents never public; HQ sees plaintext | Yes, devices verify cached signed documents | Yes, 32-byte roots | Already planned | Keep. Batch anchors per fixed epoch to hide timing |
| **Encrypted git transport for Team Mode** (encrypt each event payload to member device keys, keep signatures and hashes in clear) | Git host and network see only ciphertext and sizes | Yes, any git remote or a LAN bare repo | Roots over ciphertext hashes can still be anchored | Small to medium | Best fit for item (d) **(inference)**. Removing a member needs re-encryption of future events only |
| **Permissioned private ledger** (for example a Hyperledger Fabric network with private data collections) | Members' peers see data; ordering service sees metadata | Poor without HQ links | Only via a bridge you build | Large | Heavy operational burden for what signed logs already give |
| **TEE-hosted HQ store** (NEAR AI Cloud's dstack-based CVMs, or Calimero later) | Operator-blind at HQ | No change (edge still uses signed copies) | Unchanged | Medium | Only worth it if HQ operator trust becomes a requirement |

---

## Sources read

- Calimero org repositories, metadata via GitHub API, 2026-11-15: https://github.com/calimero-network
- `calimero-network/core` at commit `c51ae279` (2026-11-15): `README.md`, `LICENSE.md`, `NOTICE`, `COPYRIGHT`, `CHANGELOG.md`, `crates/AGENTS.md`, and docs under `docs/src/content/docs/`: `protocol/glossary.mdx`, `protocol/security-model.mdx`, `protocol/encryption.mdx`, `protocol/key-rotation.mdx`, `protocol/networking.mdx`, `protocol/tee-attestation.mdx`, `protocol/identities.mdx`, `operate/install.mdx`, `operate/security.mdx`, `operate/networking.mdx`, `operate/plain-http.mdx`, `operate/deployment.mdx`. Published at https://calimero-network.github.io/core/
- `calimero-network/mero-tee`: `README.md`, `CHANGELOG.md`, `.github/workflows/security-audit.yaml`
- `calimero-network/mero-js`: `README.md`, `package.json` (version 35.4.0)
- `calimero-network/documentation`: `README.md` (site https://docs.calimero.network)
- Releases: https://github.com/calimero-network/core/releases
- Funding coverage (2023): https://www.theblock.co/post/204235/private-sharding-startup-calimero-network-raises-8-5-million ; https://siliconangle.com/2023/01/23/private-blockchain-sharding-startup-calimero-raises-8-5m/ ; https://crypto.news/calimero-network-raises-8-5m-for-near-sharding
- mero-tee docs site: https://calimero-network.github.io/mero-tee/

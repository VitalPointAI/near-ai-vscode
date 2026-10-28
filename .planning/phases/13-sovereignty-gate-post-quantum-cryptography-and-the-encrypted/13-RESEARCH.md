# Phase 13: Sovereignty gate, post-quantum cryptography, and the encrypted event log - Research

**Researched:** 2026-10-28
**Domain:** VS Code extension (Node 22 extension host, no bundler for `src/`, vendored third-party code): model-boundary enforcement, hybrid post-quantum crypto, signed/encrypted append-only log
**Confidence:** MEDIUM-HIGH (primitives and library behaviour measured this session; protocol/envelope design is recommendation, flagged where assumed)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Key recovery and lockout**
- **D-01:** Identity creation produces **both** a 24-word recovery phrase that can regenerate the whole identity and a passphrase-protected key file (Argon2id + AES-256-GCM, or equivalent chosen by research) saved where the user chooses, outside the workspace. — **Reversibility:** one-way — the phrase must deterministically derive the Ed25519, X25519, ML-KEM-768, and ML-DSA keys; changing the derivation later orphans every phrase already written down. Research must confirm deterministic seed-to-key derivation for the chosen ML-KEM/ML-DSA implementation.
- **D-02:** The recovery export is **blocking**: a base cannot be created until the export is saved and verified (re-enter passphrase or reload the file; confirm the phrase).
- **D-03:** Where no OS keyring is available (WSL, containers, code-server, or SecretStorage failing/falling back), the identity key is stored on disk wrapped by the recovery passphrase and the user is asked for the passphrase once per session. The key is never stored in plaintext and VS Code's weaker fallback store is not trusted.
- **D-04:** If the key cannot be read, the base stays locked with a clear reason and offers only **Restore from recovery export** and **Retry**. There is no "create new key" action for an existing base (PQC-03).

**Creating a KB project**
- **D-05:** KB projects are **new projects only**, created by one command. Existing projects are not converted (avoids plaintext remnants from earlier transcripts, handoffs, and memory).
- **D-06:** KB mode is **permanent and one-way** for a project id; no command, setting, or agent can downgrade it. A user wanting forwarded models starts a separate project. — **Reversibility:** one-way — downstream phases and the SOV tests assume a KB project can never leave the mode.
- **D-07:** "TEE or local only" is shown persistently in the chat header (beside the model and cost line) and as a status-bar item in every KB project.
- **D-08:** A KB project is still an Open-GSD project: `.planning/` workflow artifacts are allowed, but findings (claim text, entity names, places) go into the base, and the KB redaction hook keeps them out of `.planning/` (SOV-05).

**Forwarded-model refusal**
- **D-09:** In KB projects, forwarded models are **shown disabled with a reason** in the model picker ("forwarded: not allowed in knowledge-base projects"), not hidden.
- **D-10:** When `TeeGatedClient` refuses a call (for example, a sub-agent routed to a forwarded model), the call fails with a clear reason and the chat **offers** to re-route that role to a TEE or local model; the user confirms. Nothing is ever substituted silently.
- **D-11:** **Fail closed:** a model whose TEE status is unknown, unverified, or whose verification fails mid-session is treated as forwarded and refused.
- **D-12:** "Local" means a **loopback endpoint only** (127.0.0.1, ::1, or a unix socket). LAN or remote servers, even if the user labels them local, are treated as forwarded.

**Erasure (crypto-shredding)**
- **D-13:** Erasable items are **claims, sources, and attachments**, each with its own key. Grades and relationships referring to an erased item show it as "[erased]". — **Reversibility:** one-way — per-item key granularity is part of the frozen envelope.
- **D-14:** After erasure a tombstone remains showing the item id, who erased it, when, and the stated reason; content, title, and places are gone. The log still verifies.
- **D-15:** A user or an agent may trigger an erasure. An agent must give an explanation, and **every agent-triggered erasure goes through the normal approval prompt** showing that explanation; nothing is erased until the user approves. The explanation becomes the tombstone reason. User-initiated erasure uses typed confirmation. Both show the notice that copies already read are not recalled (PQC-02).

**Tamper response**
- **D-16:** When the log fails verification (tampered, reordered, truncated, or forked), the base opens **read-only up to the last verified point**, with a report of what failed and where; writes are blocked until the user resolves it (for example, by restoring a good copy).

### Claude's Discretion
- Exact KDF parameters, file format of the recovery key file, and recovery-phrase wordlist/encoding (subject to D-01 research).
- Per-segment signature vs hash tree over segments (research flag 1).
- Visual design of the badge, status-bar item, locked screen, and tamper report, following `.planning/UX-CONTRACT.md`.
- Wording of refusal and lockout messages.

### Deferred Ideas (OUT OF SCOPE)
None. The discussion stayed within phase scope. (SOV-04 is owned by Phase 24; this phase builds the declared-destination allowlist and network-spy harness for NEAR, local runtimes, and search only. Multiple compartments are offered only in Phase 20; Phase 14 owns scale; Phase 19 owns sync and re-checks PQC-02.)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SOV-01 | Create a KB project; mode recorded so an agent editing workspace files cannot downgrade it | KB mode record (globalState authoritative, fail-closed advisory marker), workspace-scoped settings must be ignored in KB mode (see Pitfall 2, Pattern 1) |
| SOV-02 | Every model call goes to a TEE-attested model or a local runtime; refused at the client boundary; a test fails if any client method bypasses the gate | `ModelClient` port + `TeeGatedClient` + reflection/behaviour tests, wiring at `activeProvider`/`createNearAiProvider` (Pattern 2, call-site inventory) |
| SOV-03 | Web search and fetch per-project switch, on by default, explains the provider sees topics | Switch stored in KB mode record, tool list assembly in `agentSession.ts:392`, copy requirement (Pattern 9) |
| SOV-05 | No plaintext claim text/entity names/places in transcripts, handoffs, Agent Activity, `.planning/`, logs, memory export | Data-flow inventory (flag 4) and KB redaction hook + canary scan (Pattern 10) |
| SOV-06 | Legacy generation path applies privacy mode or is removed | `chat.ts:781` builds `new PrivacyPreflight()` in standard mode on a raw client; gate it through the same provider seam (Pattern 2) |
| LOG-01 | Attributed, append-only encrypted log; state/history/replay derived | Segment container, entry envelope, reference fold (Patterns 5, 8) |
| LOG-02 | Four timestamps; view as it happened or as known at T | Envelope fields + two as-of folds (Patterns 5, 8) |
| LOG-03 | Compartment label and key epoch on every entry from release one | Envelope freeze table (Pattern 5) |
| LOG-04 | AES-256-GCM sealed segments with hybrid Ed25519 + ML-DSA signatures; tamper/reorder/truncate/fork detected | Per-segment signature (not hash tree), verify pipeline and tamper matrix (Patterns 5, 7) |
| PQC-01 | Hybrid ML-KEM-768 + X25519 key wraps; hybrid classical + ML-DSA signatures; vetted implementation on Node 22 | `@noble/post-quantum` 0.7.1 vendored as CJS; X-Wing KAT; hybrid AND signature (Standard Stack, Pattern 4) |
| PQC-02 | Erase an item by destroying its key; log stays verifiable; UI says copies already read are not recalled | Per-item keys outside the immutable log, tombstone entry, fold refuses payload after tombstone (Pattern 6) |
| PQC-03 | Key never regenerated silently; locked with clear message; recovery export at identity creation | Existence marker outside SecretStorage, lockout state machine, phrase + keyfile (Pattern 3) |
</phase_requirements>

## Summary

Phase 13 is two largely independent halves that meet at one fact: **a knowledge-base (KB) project is a mode that is decided once, stored where an agent cannot reach it, and enforced at two boundaries**: the model client (nothing leaves except to a NEAR TEE model or a loopback runtime) and the disk (nothing sensitive is written in plaintext). The crypto half builds a signed, encrypted, append-only log whose container format, envelope, and identity derivation can never change once data exists. Both halves are buildable with one new vendored dependency family (`@noble/post-quantum` 0.7.1 and its pinned `@noble/*` 2.4.0 dependencies, plus `@scure/bip39`), loaded exactly the way the extension already loads `vendor/mcp/mcp-client.cjs`. Everything else is `node:crypto`.

The library audit (research flag 1) is resolved by measurement. `@noble/post-quantum` 0.7.1 is **self-audited only** and makes no constant-time claim, but its ML-KEM-768 and ML-DSA-65 public keys derived from a seed are byte-identical to OpenSSL 3.5.9's, its ML-DSA signatures cross-verify with OpenSSL both ways, and its `ml_kem768_x25519` (the X-Wing KEM) reproduces test vector 1 of draft-connolly-cfrg-xwing-kem-10 on both Node 22.23.4 and Electron 43. Seed-to-key derivation is deterministic for all three algorithms, so D-01 is satisfiable: one 256-bit entropy value (the 24 BIP-39 words) feeds domain-separated HKDF to the Ed25519, ML-DSA-65 and X-Wing seeds. `age-encryption` should **not** be adopted: its hybrid recipient uses the same X-Wing KEM, but it pins an older `@noble/post-quantum` (^0.5.3, a second copy and renamed exports) and its file format adds nothing for 32-byte key wraps. Sign per **segment** (not a hash tree): a hybrid signature is 3,373 bytes and takes about 16-19 ms to make and 6-7 ms to verify on Node 22, so 1,000 segments verify in about 7 seconds sequentially and tree machinery buys nothing yet.

The sovereignty half is mostly *wiring and discipline*, not new mechanism. Every model call already funnels through `NearAiClient`, and every consumer receives its client from `activeProvider()`/`createNearAiProvider()` or from `AgentTurnRequest.client`. Two real gaps were found: (a) `NearAiClient` has private members, so a wrapper is not assignable to the class type; a `ModelClient` interface must be extracted first; (b) the effective `nearAi.privacyMode`, `nearAi.baseUrl`, and `nearAi.webSearch.*` settings have the default `window` scope and so can be written by an agent into `.vscode/settings.json`; KB mode must not read them. Embeddings and rerank do not exist in the client yet; they are added here as gated methods (both `Qwen/Qwen3-Embedding-0.6B` and `Qwen/Qwen3-Reranker-0.6B` are attested in the live catalog, research flag 5).

**Primary recommendation:** Build in two waves. Wave A (sovereignty): KB mode record with fail-closed resolution, `ModelClient` port + `TeeGatedClient` (reflection test + real-host-path tests), allowlist + `NetworkSpy`, web-search switch, S4/S7 ride-alongs. Wave B (crypto and log): vendor the PQ bundle, derive identity from the phrase, then freeze and implement envelope, segment, genesis, keyring, item keys, verify and fold, then the create/recover/locked/tamper UX and the SOV-05 redaction hook with a canary scan. Treat the envelope freeze table in Pattern 5 as a review gate before any code depends on it.

## Project Constraints (from CLAUDE.md)

No `CLAUDE.md` exists in the repository. User-global rules (`~/.claude/CLAUDE.md`) that apply:

- **Never delete, overwrite, truncate, or edit any file under `~/.near-credentials`** (archive instead). Relevant to tests and to the S7 shell-argument guard: the guard must keep treating `.near-credentials` as sensitive. No task in this phase may touch that directory.
- **Verification cadence:** run the smallest relevant unit/type check after each edit; batch broader suites; one full-suite run at the phase boundary; security, authorization, money, migrations, data-integrity and architectural-boundary checks are immediately blocking; never delete/skip/weaken a failing test to get green (relevant to SOV-06: if the legacy generation path is removed rather than gated, its passing tests must not be deleted to hide a failure; this research recommends gating, not removing).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| KB mode record and resolution | Extension host (`globalState`, `src/services/kbMode.ts`) | Workspace marker (advisory, `.near-kb/genesis.json`) | Agent can write workspace files, not VS Code's extension state through the file tools; marker may only *raise* restriction |
| Model-boundary gate (`TeeGatedClient`) | Extension host service layer (wraps client at provider seam) | Pure policy in `src/domain` | One chokepoint at client creation; policy (what is TEE/local/loopback) is pure and testable |
| Destination allowlist + NetworkSpy | Pure domain matcher (`src/domain/destinations.ts`) | Test harness in `src/test` | Matcher is data; spy is test-only observation |
| Identity, hybrid sign, KeyWrap | Pure modules `src/kb/crypto` (no `vscode`), vendored PQ bundle | Host adapters for SecretStorage/globalState/dialogs | Layering rule: `src/domain` and `src/agent`-style purity; crypto must run in unit tests without VS Code |
| Envelope, segments, verify, fold | Pure + `node:fs` in `src/kb/log` | Host command layer | Deterministic, testable, later reusable by a relay and a worker |
| Item key vault (erasure keys) | Local mutable store beside the log (`.near-kb/keys/`) | — | Keys must be deletable; the log is immutable. Never inside the log |
| Recovery export and locked/tamper screens | Extension host UI (`src/services/kb*.ts`, one webview or modal flows) | — | Needs dialogs, file-save, passphrase prompts |
| KB redaction hook | Host services that write transcripts, handoff, activity, `.planning/` guard | Pure redactor in `src/kb` | Many writers; one shared pure function plus per-sink wiring |
| Web search/fetch switch | KB mode record (host) → tool assembly in `agentSession` | — | Switch must not be a workspace setting |

## Research Flag Closure (ROADMAP Phase 13 flags 1-5)

| Flag | Outcome | Evidence |
|------|---------|----------|
| 1. PQ library audit | Adopt `@noble/post-quantum` **0.7.1** (exact pin), vendored to CJS. Self-audited only; not constant-time; hybrid combiner is the standardised X-Wing. Sign **per segment**. `age-encryption` not adopted. | [VERIFIED: README read from `npm pack` of 0.7.1, "The library has not been independently audited yet", "at version 0.6.1, in Apr 2026, it was audited by ourselves"; measured below] |
| 2. SecretStorage on Linux/WSL/containers/code-server | The API cannot report the backend nor tell "missing" from "undecryptable". Primary store must therefore be a passphrase-wrapped key file; SecretStorage is at most a convenience cache; an existence marker lives outside SecretStorage. | See Pattern 3 and Pitfall 1 |
| 3. Envelope freeze review | Freeze table, tombstone rule, version vector field (`heads`) and item-key placement are specified in Pattern 5 and Pattern 6. Needs a review gate. | Pattern 5 |
| 4. Plaintext data-flow inventory | Complete table below (Pattern 10). Biggest finds: `Remember` memory is a plaintext JSON ledger, attachments are stored as plaintext `.bin`, the handoff `currentAction` is the conversation title, and the VS Code Chat participant history is persisted by VS Code. | Pattern 10 |
| 5. NEAR embedding attestation | `Qwen/Qwen3-Embedding-0.6B` and `Qwen/Qwen3-Reranker-0.6B`: `attestationSupported:true`, `providerType:"vllm"` in the live `/v1/model/list`. | [VERIFIED: curl https://cloud-api.near.ai/v1/model/list, 2026-10-28; Qwen3-Embedding out=`embedding`, Reranker out=`text`] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@noble/post-quantum` | **0.7.1** (exact pin) | ML-KEM-768 + X25519 (X-Wing `ml_kem768_x25519`), ML-DSA-65 | Only maintained pure-JS FIPS 203/204 implementation with deterministic seed keygen, ACVP/wycheproof tests, no native module. Self-audited. MIT. [VERIFIED: npm view 0.7.1, modified 2026-08-27; README read] |
| `@noble/hashes` | 2.4.0 (pinned by post-quantum) | SHAKE256/SHA-3 inside X-Wing | Transitive. Independent audit (Cure53, 2022) excludes `argon2`, `blake3`, `sha3-addons`, `sha1`. [VERIFIED: README] |
| `@noble/curves` | 2.4.0 (pinned) | X25519 inside X-Wing | Transitive. Audited (Trail of Bits Aug 2026 at 2.3.0; Cure53 2024). [VERIFIED: README] |
| `@scure/bip39` | 2.4.0 | 24-word phrase <-> 256-bit entropy, checksum | Audited (Cure53 2022 at 1.0.0; self-audit 2.2.0). One dependency on noble-hashes. [VERIFIED: README] |
| `node:crypto` | Node 22 built-in | Ed25519, AES-256-GCM, HKDF, SHA-256/512, scrypt, randomBytes | OpenSSL/BoringSSL backed; ran correctly inside Electron 43's Node. [VERIFIED: ran `electron-check.cjs` under `.vscode-test` VS Code 1.143.1] |
| `node:zlib` | built-in | Optional gzip of segment plaintext | No dependency |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `esbuild` | 0.28.2 (already a devDependency) | Bundle noble + bip39 to `vendor/pq/pq.cjs` | In `scripts/vendor-libs.mjs` via the existing `bundle()` helper; add `scripts/entries/pq.mjs` exporting only `ml_dsa65`, `ml_kem768_x25519`, bip39 functions and the English wordlist |
| `node:diagnostics_channel` | built-in | Network-spy observation (`undici:request:create`, `http.client.request.start`, `net.client.socket`) | Test-only harness, observed working on Node 22.23.4 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Own `KeyWrap` (X-Wing + HKDF + AES-GCM, 1,180 B per wrap) | `age-encryption` 0.3.1 | age uses the same X-Wing KEM but pins `@noble/post-quantum ^0.5.3` (renamed `MLKEM768X25519`; a second copy in the bundle), async-only API, identities are random (seed-to-identity needs bespoke bech32), and a file format we do not need. Byte-compatibility between noble 0.5.4 and 0.7.1 X-Wing was verified, so a later move to age-format recipients stays possible. |
| scrypt (N=2^17, r=8, p=1) for the key file | Argon2id | D-01 allows "equivalent". OWASP: "scrypt should be used when the former is not available". Node 22 has no `crypto.argon2` (appears in Node 24.x / Electron 43); noble's Argon2 is pure JS, **unaudited**, and blocks 3.2 s at 64 MiB. scrypt measured 755 ms natively (async variant uses the libuv threadpool, so the host stays responsive). Header carries a `kdf` id so Argon2id can be added when the engine floor moves. |
| Per-segment hybrid signature | Merkle tree over segments | At 3,373 B per signature and one signature per sealed batch, overhead is negligible; verify cost scales linearly (~7 ms/segment). A tree needs inclusion proofs and a signed root cadence that only pays off with the relay (Phases 19-21). Segment headers already chain with `prevSeg`. |
| ML-DSA-65 | ML-DSA-87 | -65 is NIST category 3, matching ML-KEM-768 (category 3). -87 signatures are ~4.6 KB. ASD requires category 5 after 2030 (README). Suite id in the header keeps this changeable for *new* segments. |

**Installation (devDependencies, bundled at compile; VSIX ships no `node_modules`):**
```bash
npm install --save-dev --save-exact @noble/post-quantum@0.7.1 @noble/curves@2.4.0 @noble/hashes@2.4.0 @scure/bip39@2.4.0
```
The existing `vendor-libs.mjs` `bundle(entry, target, file, main)` helper writes `vendor/pq/pq.cjs`, `vendor/pq/LICENSES.txt`, and manifest rows for exactly the packages esbuild included. Add `extension/vendor/pq/pq.cjs` and `extension/vendor/pq/LICENSES.txt` to the `required` list in `scripts/verify-release-content.mjs`.

**Version verification (this session):**
```
npm view @noble/post-quantum version  -> 0.7.1  (modified 2026-08-27, created 2024-04-02, type module, node >=20.19.0)
npm view @noble/curves version        -> 2.4.0
npm view @noble/hashes version        -> 2.4.0
npm view @scure/bip39 version         -> 2.4.0
npm audit (scratch install)           -> found 0 vulnerabilities
bundle size (esbuild, minified CJS, node22 target) -> 99,077 bytes (39,275 gzipped), including unused argon2/ed25519 exports; trimming the entry reduces it
```

## Package Legitimacy Audit

Verified with `gsd-tools query package-legitimacy check --ecosystem npm ...` plus `npm view` (postinstall empty for all).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@noble/post-quantum` | npm | 2024-04 (2.5 yrs) | ~791k/wk | github.com/paulmillr/noble-post-quantum | OK | Approved. Named in ROADMAP/PROJECT research and read from its own tarball README |
| `@noble/curves` | npm | 2022-12 | ~39M/wk | github.com/paulmillr/noble-curves | OK | Approved (transitive, pinned) |
| `@noble/hashes` | npm | 2021-11 | ~113M/wk | github.com/paulmillr/noble-hashes | OK | Approved (transitive, pinned) |
| `@noble/ciphers` | npm | 2023-06 | n/a | github.com/paulmillr/noble-ciphers | OK (not run through the seam; pinned by post-quantum 0.7.1, used by Falcon only, tree-shaken out) | Approved if bundled; expected absent from the bundle |
| `@scure/bip39` | npm | 2022-01 | ~11M/wk | github.com/paulmillr/scure-bip39 | OK | Approved |
| `age-encryption` | npm | 2023-07 | ~329k/wk | github.com/FiloSottile/typage | OK | **Not adopted** (see Alternatives); no install |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none. Note one *supply-chain freshness* point, not a verdict: the whole noble family published 2.4.0/0.7.1 within the last two months, so pin exact versions and review the diff on any bump (`.planning/research/STACK.md` made the same recommendation for pre-1.0 crypto).

## Architecture Patterns

### System Architecture Diagram

```
                       ┌──────────────── VS Code extension host (Node 22) ────────────────┐
 "Create knowledge     │                                                                   │
  base" command ──────►│ KbCreate: new empty folder ► identity ► recovery export (blocking)│
                       │   ► genesis (hybrid-signed) ► keyring epoch 1 ► KbModeRecord      │
                       │         │                       │                                  │
                       │         ▼                       ▼                                  │
                       │  KbModeRecord (globalState, authoritative)   .near-kb/genesis.json│
                       │  resolveMode(root) = KB if record OR marker OR session latch       │
                       │         │ (settings in workspace scope are ignored in KB mode)     │
 chat send / agent /   │         ▼                                                          │
 chatParticipant /     │  providerCache.activeProvider / providerFactory.createNearAiProvider│
 generation host msg ─►│         │  KB? wrap both clients ► TeeGatedClient(ModelClient)      │
                       │         ▼                                                          │
                       │  TeeGatedClient.<model-call>(model,…):                              │
                       │    catalog says tee?  endpoint host on allowlist? local = loopback? │
                       │    unknown/unverified/failed-attestation ► refuse (fail closed)    │
                       │         │ allowed                       │ refused ► ModelRefusal(reason,suggest)
                       │         ▼                               ▼   ► chat offers re-route (user confirms)
                       │  NearAiClient (HTTPS to cloud-api.near.ai, or http://127.0.0.1)     │
                       │                                                                     │
 agent tools (Phase 15)│  KbService.append(batch) ► canonical entries ► WAL-less batch       │
 analyst commands ────►│    ► segment: gzip ► AES-256-GCM(HKDF(CEK,segId)) ► header+ctHash   │
                       │    ► hybrid sign(header) ► write tmp ► link(final) (no clobber)     │
                       │    ► update high-water mark (globalState) ► fold                    │
                       │  item payloads encrypted under per-item keys (ItemKeyVault, mutable)│
                       │  verify(): sig ► ctHash ► GCM ► entry prev chain ► segment chain    │
                       │            ► HWM  => ok | tampered | reordered | truncated | forked │
                       │                       (read-only up to last verified point, D-16)   │
                       │                                                                     │
 plaintext sinks ─────►│  KbRedactor (sensitive index) ► transcripts(encrypted w/ KB key),   │
 (transcript, handoff, │    handoff (neutral text), activity (ids+counts), .planning write   │
  activity, .planning, │    guard, memory export (encrypted or refused), logs/errors         │
  export, logs)        └─────────────────────────────────────────────────────────────────────┘
 test only: NetworkSpy (fetch wrapper + diagnostics_channel + net connect) ► assert ⊆ allowlist
```

### Recommended Project Structure
```
src/
├── domain/
│   ├── sovereignty.ts        # KbModeRecord types, resolveMode(), isLoopback(), classifyBoundary(), refusal reasons (pure)
│   └── destinations.ts       # DeclaredDestination classes + matcher (pure)
├── kb/                       # vscode-free (node:fs, node:crypto only)
│   ├── crypto/
│   │   ├── pq.ts             # typed loader for vendor/pq/pq.cjs (pattern of src/mcp/client.ts loadSdk)
│   │   ├── identity.ts       # phrase <-> entropy, HKDF derivation, fingerprints, key file read/write (scrypt)
│   │   ├── hybridSign.ts     # Ed25519 + ML-DSA-65 AND signature, labelled message representative
│   │   ├── keyWrap.ts        # X-Wing + HKDF + AES-GCM, versioned record
│   │   └── canonical.ts      # canonical JSON (sorted keys, safe integers only), sha256 helpers
│   ├── log/
│   │   ├── hlc.ts            # hybrid logical clock
│   │   ├── envelope.ts       # entry/segment/genesis types + encode/decode, version gate
│   │   ├── segment.ts        # seal(), open(), verify chain
│   │   ├── itemKeys.ts       # ItemKeyVault, erase()
│   │   ├── verify.ts         # VerifyReport (tampered|reordered|truncated|forked|unknown-version)
│   │   └── fold.ts           # reference fold: current, history, asOfRecorded(T), asOfOccurred(T)
│   └── redact.ts             # KbRedactor over a sensitive-term index
├── services/
│   ├── teeGatedClient.ts     # wrapper implementing ModelClient
│   ├── kbMode.ts             # globalState adapter, marker, session latch
│   ├── kbIdentityVault.ts    # SecretStorage/keyfile adapter, lockout state machine
│   ├── kbCreate.ts           # one-command flow, recovery export UX
│   └── kbStatus.ts           # status-bar item, chat-header badge feed
└── test/
    ├── helpers/ (new)        # networkSpy.ts, canaryScan.ts, fakeNearServer.ts, fakeMemento.ts
    └── kb*.test.ts, teeGatedClient.test.ts, sovereignty*.test.ts, pqcKats.test.ts
vendor/pq/                    # generated: pq.cjs, LICENSES.txt  (scripts/entries/pq.mjs is the entry)
.near-kb/                     # per KB project, in the workspace (see Open Question 3)
├── genesis.json              # signed; advisory marker
├── keyring/<compartmentId>/epoch-1.keywrap
├── keys/items.vault          # per-item erasure keys (mutable, identity-wrapped)
└── log/<compartmentId>/<authorFp>/<seqFirst>.seg
```

### Pattern 1: KB mode record with fail-closed resolution (SOV-01, D-05, D-06)

**What:** The authoritative record lives in `context.globalState` under a key derived from a random `kbId`, with an index from the path hash to `kbId`. The workspace marker is the signed genesis (`.near-kb/genesis.json`). Resolution is monotonic upward: `KB = record exists OR genesis file present OR a session latch was set when either was first seen`. The marker can only *raise* restriction; nothing in the workspace can lower it.

**Why:** Three facts from the code force this shape.
1. The project id is path-derived: `projectMemoryScope(root)` returns `` `project-${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 32)}` `` (`src/agent/extraTools.ts:90`). Moving or renaming the folder, or opening it as a different path (WSL vs Windows form), changes the id, so a record keyed only by path hash would silently read as "standard" (a downgrade by path change).
2. The owner works in **WSL and code-server** (CONTEXT specifics). `globalState` is per extension host, so the same folder opened from another host has no record. Genesis-present-without-record must mean "KB, unreconciled: restricted until the user adopts it on this machine with recovery phrase or key file", never "standard".
3. `nearAi.privacyMode`, `nearAi.baseUrl`, `nearAi.webSearch.*` and `nearAi.actionPolicy` have no `scope` in `package.json` (e.g. `package.json:312` `"nearAi.privacyMode": {`). VS Code: "If no `scope` is declared, the default is `window`" [CITED: code.visualstudio.com/api/references/contribution-points], which settings in `.vscode/settings.json` can override; `application` scope is "can only be configured in user settings". An agent with file-write approval could set `privacyMode: standard`, point `searxngUrl` at its own server, or turn off `saveTranscripts`. In KB mode read these only through `configuration.inspect()` and ignore `workspaceValue` / `workspaceFolderValue`, force `tee-only`, and take the search-provider choice and the web switch from the KB record. (Do not change scopes for non-KB projects in this phase unless the owner agrees; it changes existing behaviour.)

**Shape (record, in globalState):**
```typescript
// Source: design for this phase. Values quoted from src/domain/privacy.ts:12,14:
//   export type ProviderBoundary = 'local' | 'cloud' | 'tee' | 'unknown';
//   export type SovereigntyMode = 'standard' | 'tee-only' | 'local-only';
interface KbModeRecord {
  v: 1;
  kbId: string;            // random 128-bit hex; also in genesis
  createdAt: string;
  ownerFingerprint: string; // hash of the public-key bundle
  webSearchFetch: boolean;  // SOV-03, default true
  declaredDestinations: string[]; // extra user-declared allowlist entries (Pattern 9)
  highWater?: { seq: number; segId: string; count: number }; // truncation anchor (Pattern 7)
}
// resolveMode(root) -> { kb: false } | { kb: true, state: 'ok' | 'unreconciled' | 'base-missing' }
```
There is no write path that sets `kb: false` for a `kbId`. Tests: delete or rewrite the marker with the real `Write`/`Bash` tools in an agent run and assert the resolver is unchanged; rename the folder; open genesis without a record.

**Residual (state it honestly in copy):** an agent with shell access can edit VS Code's own `state.vscdb`. The defence is layered (record + marker + latch + S7 guard that treats `state.vscdb`, `.near-kb/`, and key files as sensitive in KB mode), not absolute. It protects against agents and accidents, not against the machine owner or malware.

### Pattern 2: `ModelClient` port and `TeeGatedClient` (SOV-02, SOV-06, D-09..D-12)

**Prerequisite (found by reading the code):** `NearAiClient` has `private readonly fetchFn`, `private readonly models`, `private async request`, etc. (`nearAiClient.ts:172-178, 186, 506, 511`), so TypeScript treats it nominally; a wrapper cannot be passed where `NearAiClient` is typed. Extract `interface ModelClient` (the public surface) and retype the 10+ consumers: `ResolvedProvider.client`/`localClient` (`domain/auth.ts:49-57`), `AgentTurnRequest.client` (`agentSession.ts:50`), `imageTool`, `prepareAttachments`, `compactConversation`, `NearAiGenerationAdapter`, `AgentLoop` options.

**Call-class inventory (public methods of `NearAiClient`, `nearAiClient.ts`):**

| Method | Class | Gate |
|--------|-------|------|
| `streamChat`, `streamChatEvents`, `streamCompletion` | chat/agent/compaction/sub-agent | **gated** by `model` |
| `describeImage` | attachments (vision) | **gated** |
| `transcribeAudio` | attachments (audio) | **gated** |
| `generateImage`, `editImage` | image generation | **gated** |
| `embed` (new), `rerank` (new) | embeddings, retrieval | **gated** (add now; Phase 14 uses them) |
| `listModels`, `listModelsWithPricing`, `listLocalModels`, `listModelPrivacy` | catalog metadata | passthrough (no user content); NEAR host must be on the allowlist |
| `actualCostUsd`, `actualCostsUsd`, `reconcileUsage` | billing by request id | passthrough |
| `verifyResponse` | attestation fetch (GET to NEAR) | passthrough |

Only consumers outside the client: `providerCache.ts:35-38,50` (`clientFor` picks `localClient` if `info?.privacyBoundary === 'local' || provider === 'local'`), `chat.ts:459,541,784,813,838`, `chatParticipant.ts:60,89-95`, and **two direct creators that bypass `activeProvider`**: `getGenerationService` (`chat.ts:774-790`: calls `createNearAiProvider`, then `new PrivacyPreflight()` in the default `standard` mode at `chat.ts:781`) and `getMultimodalContext` (`chat.ts:736-744`: `createNearAiProvider` at 741, `new PrivacyPreflight()` at 744). All sub-agents, the image tool, and compaction use `request.client` (`agentSession.ts:205, 377, 390`), so gating at the provider seam covers them.

**Gate rule (pure, `src/domain/sovereignty.ts`):**
1. The client's own endpoint decides what "local" can mean, not the model's label. `listLocalModels` stamps every model from the second endpoint `privacyBoundary: 'local'` (`nearAiClient.ts:201`), and `isSecureEndpoint` accepts any `https:` URL (`config.ts:39-46`), so a LAN or remote "local" runtime would pass today. D-12: local iff the client base URL host is `127.0.0.0/8`, `::1`, or `localhost`, or a unix socket. Existing constant (quote, `src/domain/config.ts:36`): `const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);` which misses the rest of `127.0.0.0/8`.
2. A cloud client is acceptable only if its host is the declared NEAR host (`cloud-api.near.ai`); catalog privacy flags come from *that* endpoint, so an arbitrary `nearAi.baseUrl` could otherwise self-declare TEE.
3. TEE iff the catalog row says so. Existing classifier (quote, `nearAiClient.ts:639`): `if (metadata.attestationSupported === true && metadata.providerType !== 'external') return { privacyBoundary: 'tee' };`. Catalog gaps fail closed (D-11): model id not in the catalog, `unknown` boundary, or catalog older than the TTL and unrefreshable all refuse.
4. Mid-session failure (D-11): after a completion, run `verifyResponse` on the first response per model per session and then on a cadence (recommend every 10th response or 10 minutes; tunable, [ASSUMED]); a `failed` outcome latches that model as forwarded for the session. `unavailable` (network) is not a failure; do not latch on it.
5. Refusal is a typed error `ModelRefusal { code, model, reason, suggestions: ModelInfo[] }` so the chat can *offer* a re-route and the user confirms (D-10); nothing is substituted.

**Wire at the seam:** `activeProvider()` and `createNearAiProvider()` take a required `SovereigntyPolicy` argument (no default), so every caller must decide at compile time; the legacy generation service receives the same gated client and a `PrivacyPreflight({ mode: policy.mode })`. **Recommendation: gate the legacy generation path, do not remove it** (keeps its tests; satisfies SOV-06 "applies the user's privacy mode"). Also disable or neutralise the VS Code Chat participant in KB projects (`chatParticipant.ts:25` registers it; VS Code, not the extension, persists that chat history [ASSUMED], an uncontrollable plaintext surface).

**Reflection test (the "fails if any method bypasses the gate" evidence):**
```typescript
// Source: design; enumerates NearAiClient.prototype at runtime.
const INTERNAL = new Set(['constructor', 'request', 'readEvents', 'withPrivacy', 'rememberModels', 'idleTimeoutMs']);
const POLICY: Record<keyof ModelClient, 'gated' | 'passthrough'> = { /* every public method classified; a new method fails tsc */ };
test('every public NearAiClient method is classified and every gated one refuses forwarded models', async () => {
  for (const name of Object.getOwnPropertyNames(NearAiClient.prototype)) {
    if (INTERNAL.has(name)) continue;
    assert.ok(name in POLICY, `unclassified client method: ${name}`);
  }
  // behaviour: for each 'gated' method, call with a forwarded, an unknown, and a non-loopback "local"
  // model against a fetch spy; assert rejects with ModelRefusal and spy.calls.length === 0.
  // Then call with a TEE model and assert exactly one request reached the spy.
});
```
Private-looking names cannot be told apart at runtime, hence the explicit `INTERNAL` list: adding any new method without classifying it fails the test.

**Unix sockets (D-12):** Node's global `fetch` cannot connect to a unix socket without an undici `Agent` from the `undici` package (not importable from the bundled copy). Loopback TCP is straightforward. If unix sockets are required in this phase, add a ~80-line `fetchFn` built on `node:http.request({ socketPath })` returning a `Response` over `Readable.toWeb`; otherwise defer and say so in the picker text. [ASSUMED design, see Open Question 5]

### Pattern 3: Identity, key custody, and the lockout state machine (D-01..D-04, PQC-03)

**Derivation (one-way, freeze):**
```
entropy E            = 256-bit random              (24 BIP-39 English words, checksum detects typos)
salt                 = "near-ai-kb/identity/v1"
ed25519 seed (32 B)  = HKDF-SHA256(E, salt, info="ed25519")
ML-DSA-65 seed (32 B)= HKDF-SHA256(E, salt, info="ml-dsa-65")
X-Wing seed  (32 B)  = HKDF-SHA256(E, salt, info="x-wing")          # ML-KEM-768 + X25519, from one seed (X-Wing keygen expands via SHAKE256)
local-secrets root   = HKDF-SHA256(E, salt, info="local-secrets")   # transcripts, handoff, local snapshot keys (Phase 14)
fingerprint          = SHA-256(canonical({alg ids, ed25519 pk, ml-dsa pk, x-wing pk}))
```
Use the entropy directly, not BIP-39's PBKDF2 seed. New purposes only add new `info` strings, so existing derivations never change. **Commit known-answer tests**: fixed entropy -> expected fingerprint and each public key's SHA-256; they fail on any library drift. [VERIFIED: deterministic re-derivation from the phrase reproduced the same ML-DSA public key in the prototype on Node 22; BIP-39 vectors observed: 32 zero bytes -> `abandon` x23 `art`, 32 0xff bytes -> `zoo` x23 `vote`, bad checksum rejected]

**Why D-01 holds:** seeded keygen determinism measured for ML-KEM-768 (64-byte seed), ML-DSA-65 (32-byte), X-Wing (32-byte). Independent confirmation: ML-DSA-65 and ML-KEM-768 public keys from the same seed equal OpenSSL 3.5.9's, and ML-DSA signatures verify across implementations in both directions (run on Node 24.22.1; Node 22's API lacks them, so that cross-check test must skip below Node 24.7 and the committed KATs carry the guarantee there).

**Key file (the recovery export, and also the D-03 on-disk store):** one format, two locations.
```
{ "format": "near-ai-kb-identity", "v": 1, "fingerprint": "...", "createdAt": "...",
  "kdf": { "alg": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<b64 16B>" },   // maxmem must be >= 256 MiB or scrypt throws
  "aead": { "alg": "aes-256-gcm", "nonce": "<b64 12B>" },
  "ct": "<b64 AES-256-GCM(E)>", "tag": "<b64>" }  // AAD = canonical(all other fields)
```
Written with mode `0o600`. The export dialog rejects a path inside any workspace folder (D-01 "outside the workspace"). Never log or echo the passphrase or phrase. Require a passphrase of at least 12 characters (or a 4+ word passphrase); offer no strength meter dependency.

**Storage and custody:**
- *Existence marker outside SecretStorage:* `globalState` `kb.identity.<kbId> = { fingerprint, createdAt, custody: 'keyfile' | 'keyring' }`. If this marker exists, **no code path may create an identity**; `unlock()` returns a locked state with a reason.
- *Default custody on Linux, remote (WSL/SSH/container), and web (code-server):* the passphrase-wrapped key file in `context.globalStorageUri`, passphrase asked once per session, derived key held in memory only (cleared on deactivate). Detect with `process.platform === 'linux' || vscode.env.remoteName !== undefined || vscode.env.uiKind === vscode.UIKind.Web` (both members exist in `@types/vscode` 1.101: `env.remoteName`, `env.uiKind`). On macOS/Windows local desktop the user may opt to cache the entropy in SecretStorage.
- *Why SecretStorage cannot be primary:* the API is `get(key): Thenable<string | undefined>`, `store`, `delete`, `onDidChange` and nothing else (`@types/vscode` `SecretStorage`), so extensions cannot learn which backend was chosen nor distinguish "never stored" from "could not decrypt". On Linux, VS Code "uses Chromium to detect the desktop environment and select a keyring", `--password-store=basic` "is not recommended" and "provides obfuscation rather than secure encryption", and a locked GNOME keyring produces "Cannot create an item in a locked collection" [CITED: code.visualstudio.com/docs/configure/settings-sync, troubleshooting keychain]. code-server derives its secret-store key from a 32-byte file kept in the server's user-data directory (`serve-web-key-half`) [CITED: mirror of code-server commit "Enable secret storage (#6450)", MEDIUM; not upstream-verified], i.e. obfuscation next to the data. Where a WSL workspace extension's secrets are stored (local Windows keyring vs remote side) is **unconfirmed** [ASSUMED]; the design does not depend on the answer.
- The existing `transcriptKey()` is the anti-pattern to avoid: `const fresh = randomBytes(32); await secrets.store('nearAi.transcripts.key', ...)` when `get` returned nothing (`transcripts.ts:28-29`). Never reuse it for KB data; derive KB transcript/handoff keys from the identity's `local-secrets` root.

**State machine (D-04, PQC-03):**
```
no-marker ──create (blocking export)──► unlocked
marker + custody=keyfile ──passphrase ok + fingerprint matches marker AND genesis owner──► unlocked
marker + (SecretStorage undefined | keyring error | wrong passphrase | corrupt file | fingerprint mismatch)
        ──► LOCKED(reason ∈ {not-found, keyring-unavailable, wrong-passphrase, corrupt, wrong-identity})
LOCKED offers exactly: [Retry] [Restore from recovery export]   (no create/regenerate action exists)
Restore: phrase or key file ► recompute fingerprint ► must equal marker AND genesis owner ► write custody ► unlocked
```
Tests (all assert zero calls to `store`/`randomBytes`-for-identity after the marker exists): marker + empty SecretStorage; marker + wrong passphrase; marker + truncated key file; restore from phrase gives identical fingerprint; restore with a different phrase is refused.

**Create flow (D-02):** new empty folder only (refuse non-empty / has `.planning`), passphrase twice, derive (progress UI), show the 24 words in a non-retained webview or modal (accessible; no clipboard helper), require re-entry of 3 random words, save key file, read it back and decrypt with the passphrase to confirm the fingerprint, only then write genesis and the mode record.

### Pattern 4: Hybrid primitives (PQC-01)

**Hybrid signature = AND composition with a labelled message representative.** Ed25519 via `node:crypto` (no context parameter exists, so the label goes into the message), ML-DSA-65 with its native `context` parameter. Both must verify. Prototype measured on Node 22.23.4: signature 3,373 bytes (64 + 3,309), sign about 16-19 ms, verify about 6-7 ms; any bit flip in either half, a wrong label, or a changed message fails. `@noble/post-quantum` ships `combineSigners` but it rejects `context` and has no domain separation, so use the thin function below instead. [VERIFIED: prototype run]

**Hybrid KEM = X-Wing as shipped** (`ml_kem768_x25519`), then HKDF and AES-256-GCM with the context (`kb|compartment|epoch`) as both HKDF info and AAD. Public key 1,216 B, ciphertext 1,120 B, secret key = the 32-byte seed. Wrap record is about 1,180 B. A wrong epoch context is rejected. [VERIFIED: prototype run]

Pin the combiner by test: X-Wing test vector 1 (seed `7f9c2ba4…ef26`, eseed `3cb1eea9…85b2`, ss `d2df0522…e384`) from draft-connolly-cfrg-xwing-kem-10 reproduced exactly (pk, ct first/last 64 hex, ss) on Node 22.23.4 and Electron 43. [VERIFIED: ran `kat.mjs`] Because the draft may still change, record `alg: "xwing-v1"` in every wrap and keep the KAT in CI; cross-version bytes were identical between noble 0.5.4 and 0.7.1. [VERIFIED]

### Pattern 5: Entry envelope, segment container, genesis, keyring (LOG-01..04) — **FREEZE TABLE**

This is the review gate (research flag 3). Nothing here may change once data exists; add fields only via `v` bumps and unknown-field tolerance.

| Element | Frozen decision |
|---------|-----------------|
| Encoding | Canonical JSON: UTF-8, keys sorted by UTF-16 code unit, no whitespace, numbers are safe integers only (reject floats/NaN), no lone surrogates. **Hash the exact stored bytes** and also require re-canonicalisation to equal them. Test with RFC 8785 vectors restricted to this subset. [ASSUMED design] |
| Suite id | `s1` = `{aead: aes-256-gcm, kdf: hkdf-sha256, sig: ed25519+ml-dsa-65, kem: x-wing, hash: sha-256}` named in every header, so a new suite can coexist |
| Genesis (`genesis.json`) | `{v, kbId, createdAt, suite, owner: {ed25519 pk, ml-dsa-65 pk, x-wing pk, fingerprint}, compartments: [{id, label}]}`, hybrid-signed by the owner. Its hash roots every chain; the hash is also copied into the globalState record. About 3.2 KB of public keys |
| Segment (`*.seg`) | magic + format byte; length-prefixed canonical **header**; ciphertext; signature block. Single author per segment |
| Segment header | `v, kb, compartment (opaque id), epoch, author (key fingerprint), seq:[first,last], count, prevSeg (segId of this author's previous segment), heads (version vector {author: segId}, empty in Phase 13), hlc:[min,max], comp ('gzip'|'none'), segId (random 128-bit), nonce (96-bit), ctHash (SHA-256 of ciphertext), suite` |
| Segment key | `HKDF-SHA256(CEK_epoch, salt=kbId, info="near-ai-kb/seg/v1"\|segId)`, AAD = header bytes **excluding `ctHash`** (the tag already authenticates the ciphertext, and including `ctHash` would be circular); the random per-segment key removes nonce-collision risk at scale |
| Segment signature | Hybrid over `M' = "near-ai-kb/sig/v1\0" \| len32(label) \| label \| SHA-256(full header bytes)`, label `"segment"`; the full header (including `ctHash`) is signed, so one signature covers every byte. **Hash choice is frozen as SHA-256 / HKDF-SHA-256 for suite `s1`** (brief: "SHA-256/384 for symmetric parts"); the scratch prototype used SHA-512, so regenerate KATs with the frozen choice |
| Entry (inside plaintext) | `v, id (SHA-256 of canonical entry without id), c (compartment id), e (epoch), a (author), n (per-author seq), prev (hash of this author's previous entry; genesis hash for the first), hlc [wallMs, counter] = recordedAt, t (type), occ? {from, to?, prec}, rep?, gr?, item? {id, kind: claim|source|attachment}, body, payload?` |
| `occurredAt` | `{from: int ms UTC, to?: int ms UTC (inclusive), prec: year|month|day|hour|minute|second|ms}`; "March 2026" = from 2026-03-01T00:00:00.000Z, to 2026-03-31T23:59:59.999Z, prec month; absent = unknown |
| `reportedAt` / `gradedAt` | int ms UTC, optional; `gradedAt` only on grade entries (Phase 16); `recordedAt` is the HLC and is on every entry |
| Total order | `(hlc.wallMs, hlc.counter, author, n)`; reject entries whose HLC is beyond a skew bound in the future |
| Item ids | random 128-bit (never a hash of content) |
| Compartment | opaque random id in cleartext header (needed to pick the key) with the human label stored in the encrypted genesis/admin data; the field name is `compartment`. **Needs owner confirmation** (Open Question 1) |
| Key epoch | integer; epoch 1 in this phase; `keyring/<compartment>/epoch-1.keywrap` holds `CEK_1` wrapped (X-Wing) to the owner; Phase 19/20 add recipients without a format change |
| Timestamps of erased items | stay in the non-erasable skeleton so as-of folds reproduce ordering (Open Question 2) |
| Write granularity | **Segment per batch**, no write-ahead log: `append(batch)` seals, signs, fsyncs, then returns. A 250 ms coalescer batches bursts; `flush()` awaits durability. Fewer moving parts; 3.4 KB signature overhead per batch is acceptable. [ASSUMED] |
| File naming and no-clobber | `<author8>-<seqFirst padded>.seg`; write a temp file then `fs.link(tmp, final)` + `unlink(tmp)` (fails if it exists), so two windows cannot silently overwrite or fork. A process lock (`.near-kb/.lock`, pid + heartbeat) makes the second window read-only |

**Per-segment vs tree (flag 1, decided):** per-segment signature. Measured: sign 16-19 ms, verify 5.6-6.8 ms, 3,373 B. At 256 entries or more per segment overhead is under 5%. Phase 14 keeps a "verified through segment N" watermark in its encrypted snapshot so reopen does not re-verify everything; verification can also move to a worker.

### Pattern 6: Per-item keys and erasure (PQC-02, D-13..D-15)

- Claims, sources, attachments each get a random 256-bit **item key** at creation. The entry carries only `item {id, kind}` and `payload = AES-256-GCM(itemKey, nonce, plaintext, AAD = kbId|compartment|itemId|entryType|entryId)`. The segment (encrypted under the epoch key) therefore contains item ciphertext only.
- **Item keys must live outside the immutable log**, in `ItemKeyVault` (mutable, versioned separately, wrapped under an identity-derived key so a phrase restore can reopen it). A wrapped key written into an append-only log can never be destroyed. Erasure = remove the key from the vault, overwrite then unlink its backing record, rewrite the vault atomically, **and append a signed `item.erase` tombstone** `{item, by, at, reason}` (D-14). Content, title, places live only in the payload and become unreadable.
- **Tombstone is authoritative.** The fold refuses to expose an item's payload once an `item.erase` exists even if a key is somehow present (restored backup), and the client re-destroys the key on open. Grades and relations reference the item id only (never copy its text) so they render "[erased]".
- **Honest residuals to put in the UI copy (PQC-02):** copies already read are not recalled; a backup made before erasure may still hold the vault and the key; SSD/journaling filesystems can retain old blocks; recoverability from the phrase means the vault key is derivable, so the guarantee is "key removed from this base's key store and tombstoned", not forensic erasure. Phase 14 must keep any index/snapshot/embedding of an erasable item encrypted under that item's key or rebuilt on erasure; record this as a Phase 14 input.
- **Agent-triggered erasure (D-15):** the agent tool takes `{item, explanation}` (explanation required, bounded length), is `risky` so even fully-autonomous mode asks (`AgentTool.risky`, `agent/tools.ts`), and the approval preview shows the explanation; nothing runs before approval; the explanation becomes the tombstone `reason`. User-initiated erasure uses a typed-confirmation modal. Both show the "copies already read are not recalled" notice. The Phase 15 tools will reuse the host function; Phase 13 ships the host function, the command, and a minimal `KbEraseItem` tool so D-15 is testable.

### Pattern 7: Verification pipeline and read-only open (LOG-04, D-16)

`verifyLog(dir, anchors) -> { ok, verifiedThrough: {seq, segId}, failures: [{kind, where, detail}] }`, in this order per segment: (1) filename and header agree; (2) hybrid signature over header bytes (author must match header `author` and a known owner key); (3) `ctHash`; (4) AES-GCM tag with header as AAD; (5) entry canonical-bytes hash chain `prev` and `n` continuity; (6) segment chain `prevSeg`/seq continuity and no two segments with the same `prevSeg` or overlapping seq (**forked**: equivocation evidence); (7) compare tail with the **high-water mark** held outside the log directory (`KbModeRecord.highWater` in `globalState`): fewer segments than the mark is **truncated**; a restored older backup trips the same alarm and the user may "accept rollback" explicitly (recorded). Classification: bad signature / ctHash / tag / entry chain = **tampered**; valid segments in the wrong chain order = **reordered**; missing sequence or tail below the mark = **truncated**; duplicate lineage = **forked**; `v` above supported = **unknown-version** (read-only, refuse writes).

D-16: the fold runs over the verified prefix only; the UI is read-only with a report naming what failed and where. Test matrix (each against a real written log): flip a ciphertext byte; flip a header byte; flip a bit in each signature half separately; delete a middle segment; swap two segment files; delete the newest segment; write a second segment with the same `prevSeg`; wrong-key open; unknown `v`.

### Pattern 8: Reference fold (LOG-01, LOG-02)

A pure function `fold(entries, opts)`; entries are ordered by the total order above, so shuffled arrival yields identical state (property test with a seeded shuffle, no new dependency). Phase 13 entry types stay minimal and generic: `item.put` (revisions), `item.erase`, plus an extensible `unknown` bucket kept in history (never dropped). Outputs: `current` (resolved per item, erased flagged), `history(itemId)`, `asKnownAt(T)` (entries with `recordedAt <= T`), `asHappenedAt(T)` (items whose `occurredAt` interval contains T). Phase 14 supplies indexes and snapshots; do not persist fold output outside item-key-encrypted form.

### Pattern 9: Declared-destination allowlist and `NetworkSpy` (SOV-04 groundwork)

- `src/domain/destinations.ts`: destination *classes* with matchers: `near-cloud` (exact host `cloud-api.near.ai`, https), `local-runtime` (loopback host + port from the profile), `search` (the configured provider's host: `api.search.brave.com`, `api.tavily.com`, or the SearXNG host), `open-web-fetch` (any public https host, **only while the project's web switch is on**; WebFetch is agent-controlled so this class cannot be a host list, and Open Question 4 asks the owner to accept it). Later phases register their own classes.
- Observed existing egress that is not content-bearing but must be classified (not silently ignored): OSV (`security/osv.ts`), endoflife.date (`security/runtimes.ts:79`), the GSD runtime installer (`startRuntimeUpdates`), MCP servers, `git`. Decide default per class for KB mode (Open Question 6). Child processes (shell, git, MCP stdio) cannot be observed in-process; the harness covers extension-host network I/O, and SOV-04's honest scope statement belongs to Phase 24.
- `NetworkSpy` (test helper) has three observation layers because tests replace `globalThis.fetch`: (1) a `fetch` wrapper recording the URL; (2) `diagnostics_channel` subscriptions `undici:request:create`, `http.client.request.start`, `net.client.socket` for tests against a real loopback fixture server (observed recording both `fetch` and `http.get` on Node 22.23.4); (3) a `net.Socket.prototype.connect` patch recording host:port. `spy.assertWithin(allowlist)` fails on anything else. Drive the real client and the real host path (the `chatSendPath.test.ts` pattern: `globalThis.fetch = fakeNear(calls)`).

### Pattern 10: KB redaction hook and the plaintext data-flow inventory (SOV-05, flag 4)

One pure `KbRedactor` built over a sensitive-term index (normalised claim texts, entity names and places from the open base, plus session-learned strings; hashes for long text), exposed as `redactKb(text) -> text` and `containsKbTerm(text)`. It is applied at every sink below.

| Surface | Where | Today (verified) | KB-mode action |
|---------|-------|------------------|----------------|
| Agent Activity ledger | `.planning/.near-ai/activity.json`, `activityStore.ts` | free-text `summary` (240 chars), `lastEvent`, tool/action names | ids and counts only: replace `summary` with a fixed vocabulary or id references |
| Live feed + export | `agentActivity.ts` `ActivityFeed` (`text`, `input`, `title`), `activityView.ts:98` save dialog | full tool I/O; `redactForDisplay` removes secrets only | feed shows ids/counts; export refused or encrypted |
| Handoff | `handoff.ts`, `.planning/HANDOFF.json`; `agentSession.ts:380` passes `currentAction: this.title` (the conversation title, derived from user text) | plaintext | neutral fixed strings; never the title |
| Transcripts | `transcripts.ts`, global storage, AES-256-GCM with the SecretStorage `nearAi.transcripts.key` | encrypted, but key regenerates silently | key from identity `local-secrets` root; `display` field included |
| Project memory | `.planning/.near-ai/context-graphs.json`, `Remember` tool, `<project-memory>` preamble | **plaintext JSON ledger** | disable `Remember`/preamble in KB mode (findings go to the base) |
| Memory export | `workspaceCommands.ts:145` default `path.join(root, 'near-ai-memory.json')`; webview download path `chat.ts` `memory-export` | plaintext in the workspace (S4) | default outside workspace, warn if inside a git tree; KB mode: encrypted export or refuse |
| Attachments | `multimodalIntake.ts:108` `.planning/.near-ai/multimodal/<id>.bin`; `multimodal.json` | **raw bytes in plaintext in the workspace** | KB mode: keep in memory only or write encrypted under the local-secrets key |
| Generated media | `.planning/.near-ai/generated/*.bin`, `generation.json` | plaintext bytes | encrypt or keep out of the workspace |
| Audit / orchestrator / resume / reputation | `audit.json`, `agent-orchestrator.json`, `resume.json`, `reputation.json` under `.planning/.near-ai/` | task text and redacted previews persisted | route through `redactKb`; ids/counts |
| `.planning/` writes by the agent | Write/Edit tools | unrestricted within workspace | KB mode: write guard that blocks or asks when content contains an index hit (D-08) |
| VS Code Chat participant | `chatParticipant.ts` | history persisted by VS Code [ASSUMED] | disable in KB projects |
| Webview memory | `retainContextWhenHidden: true` at `extension.ts:44`, `chat.ts:65`, `onboarding.ts:12` | holds decrypted DOM state in memory | acceptable for the chat view; the KB panel (Phase 15) must not set it |
| Shell temp scripts | `shell.ts:113` writes each command to `near-ai-shell-*` in `os.tmpdir()`, removed after the run | commands may embed claim text | acceptable (deleted); covered by the canary scan |
| Logs / errors / output channel | any `console`, `Output` channel, thrown messages | not audited | log ids only; wrap `JSON.parse` errors |

**Canary scan (success criterion 3):** helper that walks the temp workspace, global storage, `os.tmpdir()` prefix files and searches raw, UTF-16LE, base64 (three alignments), hex, and JSON-escaped forms of a unique canary; run after a real host-path run that reads and discusses the canary. The heuristic nature of `.planning/` guarding must be stated honestly (a model can paraphrase); Phase 24 re-proves across all flows.

### Anti-Patterns to Avoid
- **Regenerating on `undefined`.** `transcriptKey()` does this today; it is the exact PQC-03 failure.
- **Trusting the model label for "local".** `listLocalModels` stamps `local` on whatever the second endpoint lists.
- **Putting item keys (or wrapped item keys) inside the log.** Makes erasure a lie.
- **Per-entry ML-DSA signatures.** 3.4 KB each; use per-segment.
- **Deriving the compartment or item id from content hashes.** Leaks via equality across compartments (ARCHITECTURE.md recommends random ids).
- **Reading `nearAi.*` security settings via the merged config in KB mode.**
- **Source-text tests as evidence.** The roadmap ground rules reject them; drive the real client / host path.
- **Hand-writing a KEM combiner or signature composition without domain labels.**

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ML-KEM-768 / ML-DSA-65 | Own lattice code | `@noble/post-quantum` 0.7.1 | Cross-checked against OpenSSL 3.5.9; ACVP tested |
| Hybrid KEM combiner | Ad hoc `H(ss1 \|\| ss2)` | `ml_kem768_x25519` (X-Wing) | Standardised combiner, matches IRTF test vector |
| Ed25519 / AES-GCM / HKDF / scrypt | Library reimplementations | `node:crypto` | Native, constant time where it matters, verified in Electron |
| Recovery phrase encoding and checksum | Own wordlist/encoding | `@scure/bip39` | Audited; typo detection built in |
| Password KDF | Iterated hash | `crypto.scrypt` (N=2^17, r=8, p=1) | OWASP minimum when Argon2id is unavailable |
| Atomic no-clobber file create | `writeFile` then `rename` | `fs.link(tmp, final)` + `unlink` | `rename` overwrites silently |
| Network observation in tests | Mock-only `fetch` stubs | `NetworkSpy` over `diagnostics_channel` + socket patch | Catches paths that bypass the stub |
| Date/interval parsing for `occurredAt` | Free-text parsing | integer ms + precision enum | Parsing belongs to intake (Phase 15) |

Deliberately hand-written (small, specified, tested): canonical JSON subset, HLC (~50 lines), hybrid AND signature function, `KeyWrap` record, segment container.

**Key insight:** every cryptographic primitive is vendored or built in; the only bespoke security-critical code is *composition* (labelled signature message, key-wrap context, container layout), so it is covered by known-answer and negative tests rather than trusted by inspection.

## Common Pitfalls

### Pitfall 1: Silent key regeneration after a SecretStorage miss
**What goes wrong:** `get` returns `undefined` for "never stored", "keyring locked at startup", and "cannot decrypt"; code generates a new key and a new empty store.
**Why:** the API exposes no error classification (`@types/vscode` `SecretStorage`).
**How to avoid:** existence marker in `globalState` (Pattern 3); creation path is unreachable when the marker exists; tests assert no `store`/key generation after the marker.
**Warning signs:** any `if (!stored) { generate }` near identity code.

### Pitfall 2: "Authoritative" mode that the workspace can still influence
**What goes wrong:** privacy or search settings read from the merged configuration; folder rename loses the path-hashed record; a second host sees no record.
**How to avoid:** Pattern 1; explicit tests for marker deletion, settings in workspace scope, rename, unreconciled genesis.

### Pitfall 3: The gate on the class, not on the seam
**What goes wrong:** `TeeGatedClient` exists but `getGenerationService`, `chatParticipant`, or a future embeddings call builds its own client.
**How to avoid:** required `SovereigntyPolicy` parameter on `createNearAiProvider`/`activeProvider`; reflection test; real host-path tests for chat, participant, generation message, attachments, compaction, sub-agent.

### Pitfall 4: `scrypt` memory limit and event-loop blocking
**What goes wrong:** `crypto.scryptSync` with N=2^17,r=8 throws unless `maxmem` is raised (needs about 128 MiB; use 256 MiB) [VERIFIED: Node 22.23.4 throws `ERR_CRYPTO_INVALID_SCRYPT_PARAMS ... memory limit exceeded` without it], and the sync form blocks the host ~0.75 s; noble's Argon2 blocks 3.2 s at 64 MiB.
**How to avoid:** use async `crypto.scrypt` with `maxmem`, show a progress notification, never run KDFs in activation.

### Pitfall 5: ESM-only noble in a CommonJS, no-node_modules VSIX
**What goes wrong:** `import … from '@noble/post-quantum/ml-kem.js'` compiles to `require` of an ESM package that is not in the VSIX.
**How to avoid:** vendor via esbuild exactly like `vendor/mcp`; load with a typed `require(path.join(__dirname, '..', '..', '..', 'vendor', 'pq', 'pq.cjs'))` from `dist/kb/crypto/` (depth differs from `src/mcp/client.ts`'s `'..','..'`); add the new files to `verify-release-content.mjs`; unit tests run from `dist/` with the bundle built by `npm run compile`.

### Pitfall 6: Two windows, one author
**What goes wrong:** two extension hosts append segment N concurrently, creating a fork that verification then flags against the owner.
**How to avoid:** `.near-kb/.lock` (pid + heartbeat, stale detection), read-only second window, `fs.link` no-clobber, seq check at append.

### Pitfall 7: Tombstone without key destruction, or key destruction without tombstone
**What goes wrong:** a restored backup revives a key whose item was erased; or a tombstone synced to a host that still holds the key.
**How to avoid:** tombstone is authoritative in the fold; open-time sweep destroys keys for tombstoned items; test with a restored vault copy.

### Pitfall 8: Noble API churn
**What goes wrong:** exports were renamed between 0.5.x (`MLKEM768X25519`) and 0.7.x (`ml_kem768_x25519`); a floating range changes the bundle silently.
**How to avoid:** exact pins; the typed adapter `src/kb/crypto/pq.ts` is the only importer; KAT tests run in CI; bumps are reviewed diffs.

### Pitfall 9: Mid-session "TEE" claims taken at face value
**What goes wrong:** catalog says `attestationSupported:true` but a particular response fails verification; or a catalog row is ambiguous. Example found live: `moonshotai/kimi-k2.6` has `attestationSupported:true`, `providerType:"chutes"` and a `providerConfig.base_url` of `openrouter.ai`, which the current classifier calls `tee`.
**How to avoid:** apply D-11: periodic `verifyResponse`, latch on `failed`; list ambiguous rows (attested type with an external base URL) as `unknown` in KB mode until the owner rules on them (Open Question 7).

### Pitfall 10: Plaintext through the model's own conversation
**What goes wrong:** the title-derived handoff text, activity summaries, resume snapshots, or `.planning/` files carry claim text even though the log is encrypted.
**How to avoid:** Pattern 10 table, every row tested by the canary scan.

## Code Examples

### Typed loader for the vendored bundle (pattern from `src/mcp/client.ts:46-58`)
```typescript
// Source: existing repo pattern (loadSdk) applied to vendor/pq. dist/kb/crypto/pq.js -> repo root is three levels up.
import * as path from 'node:path';
export interface PqApi {
  ml_dsa65: { keygen(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
              sign(msg: Uint8Array, sk: Uint8Array, opts?: { context?: Uint8Array; extraEntropy?: false | Uint8Array }): Uint8Array;
              verify(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array, opts?: { context?: Uint8Array }): boolean };
  ml_kem768_x25519: { keygen(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
                      encapsulate(pk: Uint8Array, eseed?: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array };
                      decapsulate(ct: Uint8Array, sk: Uint8Array): Uint8Array };
  entropyToMnemonic(entropy: Uint8Array, wordlist: string[]): string;
  mnemonicToEntropy(mnemonic: string, wordlist: string[]): Uint8Array;
  validateMnemonic(mnemonic: string, wordlist: string[]): boolean;
  wordlist: string[];
}
let api: PqApi | undefined;
export function pq(): PqApi { return (api ??= require(path.join(__dirname, '..', '..', '..', 'vendor', 'pq', 'pq.cjs')) as PqApi); }
```

### Hybrid signature and key wrap (prototype run on Node 22.23.4: 3,373-byte signature; negative tests pass)
```javascript
// Source: scratchpad prototype (proto.cjs), exercised on Node 22.23.4 against the esbuild CJS bundle.
// (The prototype used SHA-512 for HKDF and the message digest; suite s1 freezes SHA-256, which changes no sizes.)
const mPrime = (label, bytes) => { const l = enc.encode(label); const h = Buffer.alloc(4); h.writeUInt32BE(l.length);
  return Buffer.concat([enc.encode('near-ai-kb/sig/v1\0'), h, l, crypto.createHash('sha512').update(bytes).digest()]); };
const hybridSign = (label, bytes) => { const m = mPrime(label, bytes);
  return Buffer.concat([crypto.sign(null, m, edPriv), Buffer.from(pq.ml_dsa65.sign(m, dsa.secretKey, { context: enc.encode(label) }))]); };
const hybridVerify = (label, bytes, sig) => { if (sig.length !== 64 + 3309) return false; const m = mPrime(label, bytes);
  return crypto.verify(null, m, edPubKeyObject, sig.subarray(0, 64)) && pq.ml_dsa65.verify(sig.subarray(64), m, dsa.publicKey, { context: enc.encode(label) }); };
// KeyWrap: { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(pk);
//           kek = HKDF-SHA256(sharedSecret, 'near-ai-kb/keywrap/v1', info = `${kb}|${compartment}|${epoch}`, 32);
//           AES-256-GCM(kek, nonce12, key, AAD = same info)   // 1,180 B total; wrong epoch context rejected
```

### Ed25519 from a derived seed with `node:crypto` (matches noble; works in Electron)
```javascript
// Source: scratchpad test.cjs / electron-check.cjs (ed pub matches noble: true under Node 22.23.4 and Electron 43)
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), edSeed]);
const edPriv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
```

### Gate behaviour test skeleton (real client, fetch spy)
```typescript
// Source: design, following src/test/chatSendPath.test.ts (globalThis.fetch = fakeNear(calls)).
const gated = new TeeGatedClient(new NearAiClient({ baseUrl: 'https://cloud-api.near.ai/v1', apiKey: 'k', fetchFn: spy.fetch }), policy);
await gated.listModelsWithPricing();                 // catalog says: z-ai/glm-5.3 tee, deepseek/deepseek-v4.1-flash cloud
await assert.rejects(() => gated.describeImage('deepseek/deepseek-v4.1-flash', dataUrl, 'q'), ModelRefusal);
assert.equal(spy.calls.filter((c) => c.endsWith('/chat/completions')).length, 0);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| X25519-only key wraps | Hybrid ML-KEM-768 + X25519 (X-Wing; age `mlkem768x25519`) | 2025-26 drafts, age PQ recipients | Matches owner decision; standardised combiner |
| Argon2id for passphrase KDF | Argon2id preferred, scrypt when unavailable | `crypto.argon2` only in Node >= 24.7 | Use scrypt now; header `kdf` id allows Argon2id later |
| `@noble/post-quantum` 0.5.x names (`MLKEM768X25519`) | 0.7.x `ml_kem768_x25519`, `ml_dsa65` | between 0.5.4 and 0.7.1 | Pin exactly; adapter isolates names |
| Per-entry signatures | Per-sealed-segment signature | owner decision (PQ sigs ~3.3 KB) | Fewer, larger, cheaper-to-verify units |

**Deprecated/outdated:** `crypto.argon2` is not available on the extension engine floor; `node:sqlite` stays rejected (Phase 14). `age-encryption` as the wrap layer from earlier STACK.md research is superseded by this phase's finding.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | ML-DSA-65 (category 3) is the intended level to pair with ML-KEM-768; owner wrote only "ML-DSA" | Standard Stack, Pattern 5 | Wrong level means signatures of a different size; suite id lets new segments change, old stay |
| A2 | scrypt counts as "equivalent" to Argon2id for D-01 | Pattern 3 | Owner may insist on Argon2id; would need noble's unaudited pure-JS Argon2 or Node >= 24 gating |
| A3 | Own thin `KeyWrap` over X-Wing instead of age format | Alternatives | If interop with the `age` CLI is wanted later, a converter is needed |
| A4 | Log/keyring/vault live in a workspace-resident `.near-kb/` directory | Structure, Pattern 5 | If owner wants them in global storage, folders will not travel across WSL/code-server hosts |
| A5 | `compartment` in the envelope is an opaque id with the label held in encrypted data | Pattern 5 | LOG-03 reading "label" literally would put a label in every entry or header |
| A6 | Timestamps of erased items stay visible in the tombstone skeleton | Pattern 5 | If owner treats times as content, as-of ordering for erased items changes |
| A7 | Segment-per-batch with a 250 ms coalescer; no write-ahead log; gzip default | Pattern 5 | Very high-rate writers (Phase 18 feeds) may need a WAL or larger batches |
| A8 | Hybrid signature as an AND composition with a labelled message representative | Pattern 4 | A different composite standard would change signatures |
| A9 | High-water mark for truncation detection in `globalState` | Pattern 7 | Lost with a profile reset: truncation then undetectable locally until Phase 19 version vectors |
| A10 | Where SecretStorage lives for a WSL workspace extension (local vs remote) is unknown | Pattern 3 | Only affects the optional keyring cache; design does not depend on it |
| A11 | Behaviour on the engine floor (VS Code 1.101, Electron 35, Node 22.15.1) is as measured on Node 22.23.4 and Electron 43 | Summary, Environment | A BoringSSL difference on Electron 35 would break `node:crypto` calls; verify in e2e on 1.101.0 |
| A12 | An agent with shell can edit `state.vscdb`; the layered design is the mitigation | Pattern 1 | Owner may want a stronger boundary than layered defence |
| A13 | VS Code persists `@nearAi` Chat-participant history itself | Pattern 10 | If not, disabling the participant is unnecessary (harmless) |
| A14 | Attestation re-check cadence (first response per model per session, then every 10th or 10 minutes) | Pattern 2 | Too sparse misses mid-session failure; too frequent costs two GETs plus quote verification per check |
| A15 | Canonical JSON restricted to safe integers and strings; hand-written | Pattern 5 | Floats needed later (probabilities, Phase 23) must be stored as integers (e.g. basis points) or as strings |
| A16 | `localhost` is accepted as loopback in addition to IP literals | Pattern 2 | A hostile hosts file could redirect it; stricter option is IP literals only |
| A17 | X-Wing is stable enough to freeze (IRTF draft -10; vectors reproduced) | Pattern 4 | A final spec change would require a new `alg` id for new wraps |
| A18 | Verify cost scales ~6-7 ms/segment on a typical dev machine | Pattern 5 | Slower hardware raises open time before Phase 14 watermarks |

## Open Questions

1. **Compartment field: id or label?** (affects the frozen envelope)
   - What we know: LOG-03 says "compartment label"; P-07 in PITFALLS says compartment names should not appear in plaintext transport headers; the header needs something to select the key.
   - Unclear: whether the owner means a human label in every entry.
   - Recommendation: opaque `compartment` id in the header, label in encrypted genesis/admin data. Confirm before freeze.
2. **Do `occurredAt`/`reportedAt` of an erased item survive in the tombstone?** D-14 lists only "item id, who, when, reason" and says "content, title, and places are gone".
   - Recommendation: keep them (needed for consistent as-of views); owner confirms they are not "content".
3. **Where does the log live?** Workspace `.near-kb/` (travels across WSL and code-server, can be committed as ciphertext, agents can reach the files) vs global storage (hidden from the workspace, tied to one host).
   - Recommendation: workspace, with the agent file tools and S7 guard protecting the path; confirm git-hygiene expectations (`.gitignore` default?).
4. **WebFetch destination class.** WebFetch accepts any public https URL chosen by the model; SOV-04 cannot allowlist it by host.
   - Recommendation: declare class `open-web-fetch`, active only while the per-project switch is on, and say so in the copy; Phase 24 proves nothing else leaves.
5. **Unix-socket local runtimes (D-12).** Needs a custom `fetchFn` (no undici export). In scope for this phase or follow-up? Default: loopback TCP only now, unix socket as a flagged task.
6. **Defaults for other egress in KB mode:** MCP servers, SecurityScan/OSV, endoflife.date, GSD runtime installer, `git`. Recommendation: MCP and security scan off until enabled per project; installer allowed (no content); all listed in the allowlist classes.
7. **Ambiguous catalog rows** (attested type with an external base URL, e.g. `moonshotai/kimi-k2.6`): treat as `unknown`/refused in KB mode until ruled on.
8. **Passphrase policy.** Minimum length and whether to require a diceware-style passphrase; wording of the locked screen.
9. **Argon2id vs scrypt** final call (A2).
10. **Engine floor.** Run the crypto and e2e suites once on VS Code 1.101.0 (Electron 35); if BoringSSL on that version lacks any used `node:crypto` feature, the fallback is the bundled noble primitives.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | build, unit tests | yes | 24.22.1 local (extension host target 22.15.1; Node 22.23.4 downloaded to scratch and used for verification) | — |
| npm / esbuild | vendor bundle | yes | esbuild 0.28.2 in devDependencies | — |
| VS Code test binary | e2e (`@vscode/test-electron`) | yes | `.vscode-test/vscode-linux-x64-1.143.1` (Electron 43, Node 24.21.0) | pin `1.101.0` for a floor run |
| `xvfb-run` | `npm run test:e2e` | not checked | — | run unit/host-path tests (no display needed) |
| Network to `cloud-api.near.ai` | live catalog check | yes (public `/v1/model/list`, `/v1/models` unauthenticated) | — | fixtures in tests |
| OpenSSL ML-DSA / ML-KEM API | cross-implementation test | Node >= 24.7 only | local Node 24.22.1 OpenSSL 3.5.9 | skip below Node 24.7; KATs cover |
| `git` | none in this phase | — | — | — |

**Missing dependencies with no fallback:** none for planning.
**Missing dependencies with fallback:** floor-version Electron (A11) and `xvfb-run` availability should be confirmed by the plan's first task.

## Validation Architecture

`workflow.nyquist_validation` is absent from `.planning/config.json`, so this section is included. Ground rule from the roadmap: success criteria are proven by tests that drive the real path (host message path, a command, or the real client); source-text tests do not count.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node built-in test runner (`node:test`), `node:assert/strict`; flat top-level `test()` calls |
| Config file | none; `tsconfig.json` compiles `src/**` to `dist/`; tests are `dist/test/*.test.js` |
| Quick run command | `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` (type check alone is about 10 s) |
| Full suite command | `npm test` (= `npm run compile` which runs `scripts/vendor-libs.mjs` then `tsc`, then `node --test dist/test/*.test.js`) |
| E2E | `npm run test:e2e` (VS Code via `@vscode/test-electron`, xvfb), once at the phase boundary |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SOV-01 | Marker deleted/rewritten by real Write/Bash tool, folder renamed, genesis without record, workspace-scope settings: mode stays KB | integration (real tools, fake Memento) | `node --test dist/test/kbMode.test.js` | ❌ Wave 0 |
| SOV-02 | Reflection test (all public methods classified); every gated method refuses forwarded/unknown/non-loopback/ambiguous models with zero requests; TEE and loopback allowed; mid-session verification failure latches; chat send path, sub-agent, attachments, compaction, image, embeddings, participant through the real host path | unit + host-path integration | `node --test dist/test/teeGatedClient.test.js dist/test/kbSendPath.test.js` | ❌ Wave 0 |
| SOV-03 | Tool list in a KB run includes/excludes WebFetch+WebSearch per the switch; default on; copy mentions the provider sees topics; agent cannot flip it | integration | `node --test dist/test/kbWebSwitch.test.js` | ❌ Wave 0 |
| SOV-05 | Canary read and discussed in a real run; canary scan over workspace, global storage, tmp finds nothing; transcripts encrypted with KB key; handoff neutral; activity ids/counts; `.planning` write guard; memory export; `Remember` disabled | integration (canary scan helper) | `node --test dist/test/kbPlaintext.test.js` | ❌ Wave 0 |
| SOV-06 | `generation-*` host message in KB project and in tee-only standard project refuses forwarded model; privacy mode honoured | host-path integration (extend `generationProtocol.test.ts` pattern) | `node --test dist/test/kbGeneration.test.js` | ❌ Wave 0 |
| LOG-01 | Append -> seal -> reopen -> fold gives current state and history; never rewrites existing files | integration | `node --test dist/test/kbLog.test.js` | ❌ Wave 0 |
| LOG-02 | Four timestamps persisted; `asKnownAt(T)` and `asHappenedAt(T)` differ as expected; shuffled input gives identical state | unit/property (seeded) | `node --test dist/test/kbFold.test.js` | ❌ Wave 0 |
| LOG-03 | Every entry carries compartment and epoch; header carries them; unknown `v` gate | unit | `node --test dist/test/kbEnvelope.test.js` | ❌ Wave 0 |
| LOG-04 | Tamper matrix (ciphertext, header, each signature half, middle delete, swap, tail delete vs high-water mark, duplicate `prevSeg`, wrong key); read-only open to last verified point with report | integration | `node --test dist/test/kbVerify.test.js` | ❌ Wave 0 |
| PQC-01 | X-Wing KAT; ML-DSA/ML-KEM seed KATs; hybrid AND negative tests; KeyWrap context binding; bundle loads from `vendor/pq`; cross-check vs OpenSSL on Node >= 24.7 | unit | `node --test dist/test/pqcKats.test.js` | ❌ Wave 0 |
| PQC-02 | Erase item: payload unreadable, vault key gone, log verifies, fold shows `[erased]`, restored vault copy still refused, agent erasure waits for approval and uses explanation as reason, notice text present | integration | `node --test dist/test/kbErasure.test.js` | ❌ Wave 0 |
| PQC-03 | Marker + empty SecretStorage / wrong passphrase / corrupt file => locked with reason and zero identity generation; restore from phrase and from key file; wrong identity refused; create blocked until export verified | integration | `node --test dist/test/kbIdentity.test.js` | ❌ Wave 0 |
| (groundwork) | NetworkSpy: NEAR, loopback, search only; any other destination fails | integration | `node --test dist/test/kbNetwork.test.js` | ❌ Wave 0 |
| (ride-along S4) | Memory export default path outside workspace; warning inside a git tree | unit | `node --test dist/test/memoryExport.test.js` | ❌ Wave 0 |
| (ride-along S7) | Shell command naming `.env`, `.near-credentials`, `.ssh`, `.near-kb`, `state.vscdb` asks first | unit | `node --test dist/test/shellSensitive.test.js` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx tsc -p tsconfig.json && node --test` of the one or two test files touched.
- **Per wave merge:** all `dist/test/kb*.test.js`, `teeGatedClient`, `pqcKats`, `sovereignty*` plus the existing suites touching changed seams (`nearAiClient`, `chatSendPath`, `outboundGuard`, `generation*`, `privacy*`, `agentTools`).
- **Phase gate:** `npm test` green, then `npm run test:e2e` once, then one floor-version crypto run on VS Code 1.101.0 (A11). Security, authorization, data-integrity and architectural-boundary tests (SOV-01/02/05/06, LOG-04, PQC-02/03) are immediately blocking.

### Wave 0 Gaps
- [ ] `scripts/entries/pq.mjs` + `scripts/vendor-libs.mjs` bundle call + `scripts/verify-release-content.mjs` required entries + devDependencies (`--save-exact`)
- [ ] `src/test/helpers/networkSpy.ts`, `canaryScan.ts`, `fakeNearServer.ts` (model list with TEE / forwarded / ambiguous / embedding rows taken from the live catalog), `fakeMemento.ts`, shared `MemorySecrets` (currently copied inline per test file)
- [ ] All test files in the table above
- [ ] Committed KAT fixtures: X-Wing vector 1; phrase -> fingerprint; seed -> public-key hashes
- [ ] Decision record for the freeze table (review artifact) before B3 begins

## Security Domain

`security_enforcement` is not set in `.planning/config.json` (treated as enabled). This phase *is* security-critical; every row is blocking.

### Applicable ASVS Categories (ASVS 4.0 numbering)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture / threat model | yes | Pattern 1-3 layering; honest residual statements (other extensions share the host process; agent shell can reach `state.vscdb`; JS crypto is not constant time) |
| V2 Authentication | yes | Passphrase-wrapped identity (scrypt N=2^17,r=8,p=1 + AES-256-GCM), recovery phrase with checksum, no silent re-creation |
| V3 Session management | partial | Unlocked key held in memory for the session only; cleared on deactivate |
| V4 Access control | yes | Mode record not agent-writable; `risky` agent erasure with approval; read-only on tamper; single-writer lock |
| V5 Input validation | yes | Strict segment/header/entry parsing (length caps, canonical re-encoding check, magic/version gate), path validation for key file and segment names, `item.erase` explanation length bound |
| V6 Stored cryptography | yes | `node:crypto` AES-256-GCM/HKDF/Ed25519; vendored noble for ML-KEM/ML-DSA/X-Wing; no hand-rolled primitives; unique per-segment keys; random nonces; domain-separated labels |
| V7 Error handling and logging | yes | No claim text, keys, or phrases in logs/errors; wrap `JSON.parse` errors |
| V8 Data protection | yes | Plaintext data-flow inventory (Pattern 10) and canary scan |
| V9 Communications | yes | HTTPS to NEAR only; loopback-only local runtimes; allowlist + NetworkSpy |
| V10 Malicious code / supply chain | yes | Exact-pinned vendored crypto, SBOM manifest, `npm audit` 0 findings, diff review on bumps |
| V12 Files and resources | yes | `0o600` key files, atomic no-clobber writes, reject export paths inside the workspace |
| V14 Configuration | yes | Ignore workspace-scoped `nearAi.*` security settings in KB mode |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Agent edits workspace settings/marker to downgrade mode | Tampering / Elevation | globalState record + monotonic resolver + ignore workspace-scope settings + S7 guard |
| Forwarded model reached through a side client (generation, participant, compaction, sub-agent) | Information disclosure | Gate at provider seam, required policy argument, reflection and host-path tests |
| Fake "TEE" via custom `baseUrl` or non-loopback "local" endpoint | Spoofing | Endpoint host allowlist + loopback test (D-12) |
| Silent key regeneration, key loss | Denial of service / Repudiation | Existence marker, locked state, phrase + key file |
| Log tampering, reorder, truncation, fork | Tampering | Hybrid segment signature, chains, high-water mark, read-only open |
| Rollback by restoring an old backup | Tampering | High-water mark alarm; explicit recorded "accept rollback" |
| Crypto-shred defeated by remnants | Information disclosure | Tombstone authoritative, key re-destroyed at open, honest UI copy |
| Plaintext leakage via side surfaces | Information disclosure | Redaction hook + canary scan |
| Signature stripping / half-signature acceptance | Spoofing | AND verification of both halves with label-bound message |
| Timing side channels in JS ML-DSA/ML-KEM | Information disclosure | Documented limitation (README); Ed25519 half uses OpenSSL; same-process extensions are a larger exposure than timing |
| Shell argument reading of keys/`.env`/`.near-credentials` | Information disclosure | S7: tokenise command arguments, `sensitive()` hook on the Bash tool, KB paths added |
| Supply-chain compromise of noble | Tampering | Exact pins, lockfile, provenance check at bump, vendored bundle reviewed in diff |

## Sources

### Primary (HIGH confidence)
- npm tarball READMEs read in a scratch install: `@noble/post-quantum` 0.7.1 (audit statement, constant-time note, hybrid list, usage), `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0 (Argon2 excluded from audit), `@scure/bip39` 2.4.0, `age-encryption` 0.3.1 (uses `MLKEM768X25519` + HPKE suite 0x647a)
- Repository source files listed in the pattern tables (read this session): `src/services/nearAiClient.ts`, `providerCache.ts`, `providerFactory.ts`, `chat.ts`, `chatParticipant.ts`, `agentSession.ts`, `generationService.ts`, `transcripts.ts`, `handoff.ts`, `activityStore.ts`, `workspaceCommands.ts`, `webSearchSetup.ts`, `agent/shell.ts`, `agent/tools.ts`, `agent/webTools.ts`, `domain/privacy.ts`, `domain/config.ts`, `domain/auth.ts`, `extension.ts`, `package.json`, `scripts/vendor-libs.mjs`, `scripts/verify-release-content.mjs`
- Live NEAR catalog `https://cloud-api.near.ai/v1/model/list` (2026-10-28)
- Measurements run this session on Node 22.23.4 (SHASUMS-verified download) and on Electron 43 (`.vscode-test` VS Code 1.143.1): determinism, KATs, OpenSSL cross-checks (Node 24.22.1, OpenSSL 3.5.9), timings, sizes, bundle size, `diagnostics_channel` observation
- IRTF draft-connolly-cfrg-xwing-kem-10 test vector 1 (datatracker.ietf.org/doc/html/draft-connolly-cfrg-xwing-kem-10)
- OWASP Password Storage Cheat Sheet (cheatsheetseries.owasp.org): Argon2id 19 MiB/t=2/p=1; scrypt N=2^17,r=8,p=1; "scrypt should be used when the former is not available"
- VS Code docs: contribution points (default `window` scope; `application` user-only) and Settings Sync keychain troubleshooting (Chromium backend selection, `--password-store`, `basic` is obfuscation)
- `@types/vscode` 1.101 (`SecretStorage`, `Memento.setKeysForSync`, `env.remoteName`, `env.uiKind`, `globalStorageUri`)

### Secondary (MEDIUM confidence)
- Web search digests: VS Code 1.101 ships Electron 35 / Node 22 (a bug report lists Electron 35.5.1 and Node 22.15.1); code-server secret-key file (`serve-web-key-half`) from a mirrored upstream commit
- `.planning/research/{STACK,ARCHITECTURE,PITFALLS,SUMMARY}.md` (prior milestone research; its `age-encryption` recommendation is superseded here)

### Tertiary (LOW confidence, flagged in Assumptions)
- SecretStorage location for WSL workspace extensions (A10); VS Code persistence of Chat-participant history (A13)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, libraries read, installed, bundled, measured on the target runtime family; floor runtime (Electron 35) unrun (A11)
- Architecture: MEDIUM-HIGH, integration points read from source; envelope, erasure vault, and verification pipeline are recommendations needing the freeze review
- Pitfalls: MEDIUM-HIGH, most are verified in code or by experiment; SecretStorage platform behaviour is documentation-level

**Research date:** 2026-10-28
**Valid until:** 2026-11-27 for library versions (noble family is fast-moving, re-check pins at plan time); catalog facts (model attestation) 7 days

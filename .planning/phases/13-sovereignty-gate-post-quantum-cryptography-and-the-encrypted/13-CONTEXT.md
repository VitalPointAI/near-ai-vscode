# Phase 13: Sovereignty gate, post-quantum cryptography, and the encrypted event log - Context

**Gathered:** 2026-10-28
**Status:** Ready for planning

<domain>
## Phase Boundary

A user can create a knowledge-base (KB) project whose every model call is confined to NEAR TEE-attested or local models, and whose changes are written to a signed, encrypted, append-only log protected by hybrid post-quantum cryptography, with keys that are never silently lost or regenerated.

Requirements: SOV-01, SOV-02, SOV-03, SOV-05, SOV-06, LOG-01, LOG-02, LOG-03, LOG-04, PQC-01, PQC-02, PQC-03. SOV-04 is owned by Phase 24; this phase builds the declared-destination allowlist and network-spy harness for NEAR, local runtimes, and search only. Ride-along fixes: plaintext project-memory export (S4) and shell-argument exposure (S7).

Fixed here because they cannot change once data exists: the entry envelope (version, compartment label, key epoch, HLC `recordedAt`, `occurredAt` interval with precision, `reportedAt`, `gradedAt`, `prev` hash chain), sealed segments signed per segment or by hash tree, per-item keys for erasable items, a single-compartment keyring, and the KB mode record (globalState authoritative, workspace marker advisory).

</domain>

<decisions>
## Implementation Decisions

### Key recovery and lockout
- **D-01:** Identity creation produces **both** a 24-word recovery phrase that can regenerate the whole identity and a passphrase-protected key file (Argon2id + AES-256-GCM, or equivalent chosen by research) saved where the user chooses, outside the workspace. — **Reversibility:** one-way — the phrase must deterministically derive the Ed25519, X25519, ML-KEM-768, and ML-DSA keys; changing the derivation later orphans every phrase already written down. Research must confirm deterministic seed-to-key derivation for the chosen ML-KEM/ML-DSA implementation.
- **D-02:** The recovery export is **blocking**: a base cannot be created until the export is saved and verified (re-enter passphrase or reload the file; confirm the phrase).
- **D-03:** Where no OS keyring is available (WSL, containers, code-server, or SecretStorage failing/falling back), the identity key is stored on disk wrapped by the recovery passphrase and the user is asked for the passphrase once per session. The key is never stored in plaintext and VS Code's weaker fallback store is not trusted.
- **D-04:** If the key cannot be read, the base stays locked with a clear reason and offers only **Restore from recovery export** and **Retry**. There is no "create new key" action for an existing base (PQC-03).

### Creating a KB project
- **D-05:** KB projects are **new projects only**, created by one command. Existing projects are not converted (avoids plaintext remnants from earlier transcripts, handoffs, and memory).
- **D-06:** KB mode is **permanent and one-way** for a project id; no command, setting, or agent can downgrade it. A user wanting forwarded models starts a separate project. — **Reversibility:** one-way — downstream phases and the SOV tests assume a KB project can never leave the mode.
- **D-07:** "TEE or local only" is shown persistently in the chat header (beside the model and cost line) and as a status-bar item in every KB project.
- **D-08:** A KB project is still an Open-GSD project: `.planning/` workflow artifacts are allowed, but findings (claim text, entity names, places) go into the base, and the KB redaction hook keeps them out of `.planning/` (SOV-05).

### Forwarded-model refusal
- **D-09:** In KB projects, forwarded models are **shown disabled with a reason** in the model picker ("forwarded: not allowed in knowledge-base projects"), not hidden.
- **D-10:** When `TeeGatedClient` refuses a call (for example, a sub-agent routed to a forwarded model), the call fails with a clear reason and the chat **offers** to re-route that role to a TEE or local model; the user confirms. Nothing is ever substituted silently.
- **D-11:** **Fail closed:** a model whose TEE status is unknown, unverified, or whose verification fails mid-session is treated as forwarded and refused.
- **D-12:** "Local" means a **loopback endpoint only** (127.0.0.1, ::1, or a unix socket). LAN or remote servers, even if the user labels them local, are treated as forwarded.

### Erasure (crypto-shredding)
- **D-13:** Erasable items are **claims, sources, and attachments**, each with its own key. Grades and relationships referring to an erased item show it as "[erased]". — **Reversibility:** one-way — per-item key granularity is part of the frozen envelope.
- **D-14:** After erasure a tombstone remains showing the item id, who erased it, when, and the stated reason; content, title, and places are gone. The log still verifies.
- **D-15:** A user or an agent may trigger an erasure. An agent must give an explanation, and **every agent-triggered erasure goes through the normal approval prompt** showing that explanation; nothing is erased until the user approves. The explanation becomes the tombstone reason. User-initiated erasure uses typed confirmation. Both show the notice that copies already read are not recalled (PQC-02).

### Tamper response
- **D-16:** When the log fails verification (tampered, reordered, truncated, or forked), the base opens **read-only up to the last verified point**, with a report of what failed and where; writes are blocked until the user resolves it (for example, by restoring a good copy).

### Claude's Discretion
- Exact KDF parameters, file format of the recovery key file, and recovery-phrase wordlist/encoding (subject to D-01 research).
- Per-segment signature vs hash tree over segments (research flag 1).
- Visual design of the badge, status-bar item, locked screen, and tamper report, following `.planning/UX-CONTRACT.md`.
- Wording of refusal and lockout messages.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` §Phase 13 — goal, scope, success criteria, research flags (PQ library audit, SecretStorage on Linux/WSL/code-server, envelope freeze review, plaintext data-flow inventory, NEAR embedding attestation check)
- `.planning/REQUIREMENTS.md` — SOV-01..06, LOG-01..04, PQC-01..03, and the cross-phase ownership notes (SOV-04 → Phase 24, PQC-02 re-check in Phase 19)
- `.planning/research/v0.5.0-trusted-source-knowledge-base.md` — owner's brief and dated decisions (PQ throughout, crypto-shredding, local LLMs allowed, web search on by default)
- `.planning/PROJECT.md` — v0.5.0 milestone goal and product principles

### Research
- `.planning/research/SUMMARY.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/STACK.md`, `.planning/research/PITFALLS.md` — v0.5.0 knowledge-base research
- `.planning/AUDIT-2026-10-26.md` — source of ride-along fixes S4 (plaintext memory export) and S7 (shell-argument exposure)

### UI and codebase
- `.planning/UX-CONTRACT.md` — UI patterns for badge, picker, prompts
- `.planning/WINDOWS.md` — platform notes relevant to keyring/SecretStorage behaviour
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md` — layering and known concerns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/domain/privacy.ts`: `SovereigntyMode` already has `tee-only` / `local-only`; `ProviderBoundary` (`local | cloud | tee | unknown`) and `teeStatus` give the vocabulary for the gate.
- `src/services/nearAiClient.ts`: `NearAiClient` carries `privacyBoundary` / `forwardedTo` per model (`listModelPrivacy`, `withPrivacy`) and `verifyResponse` for attestation; this is the client `TeeGatedClient` wraps. Model-calling methods to cover: chat streaming, `generateImage`, `editImage`, `describeImage`, `transcribeAudio`, plus embeddings and the local model paths.
- `src/services/privacyPreflight.ts`, `src/services/outboundGuard.ts`, `src/services/policyGate.ts`: existing preflight/outbound checks to extend with the destination allowlist and network-spy harness.
- `src/services/auth.ts`: existing SecretStorage usage pattern (scoped secrets).
- `src/services/approvalService.ts`: the approval prompt for agent-triggered erasure (D-15).
- `src/domain/redaction.ts`: base for the KB redaction hook.

### Established Patterns
- `src/domain` and `src/agent` have no `vscode` imports and are tested with `node --test` against `dist/test/*.test.js`; crypto, envelope, and log fold belong in pure modules there.
- Ports-and-adapters injection (`NearAiClient`, `ProcessRunner`, `ShellSession`) makes the gate a wrapper injected at composition in `src/extension.ts`.
- No bundler: `tsc` to `dist/`, so a pure-JS PQ library must work as plain CommonJS on Node 22.

### Integration Points
- `src/services/generationService.ts`: the legacy generation path to gate or remove (SOV-06).
- `src/services/transcripts.ts`, `src/services/handoff.ts`, `src/services/activityStore.ts` / `agentActivity.ts`, `src/services/contextGraphStore.ts` / `contextGraphMemory.ts`: plaintext surfaces for encryption or redaction (SOV-05, S4).
- `src/agent/shell.ts`: S7 shell-argument exposure.
- Model picker and chat header in `src/services/chat.ts` / `panelView.ts` / `media/chat/*`: disabled forwarded models, the persistent badge.
- `src/services/webSearchSetup.ts`: the per-project web search/fetch switch (SOV-03).

</code_context>

<specifics>
## Specific Ideas

- The owner works in WSL and code-server, so the no-keyring passphrase path (D-03) is a primary path, not an edge case.
- Refusals should teach: the user always sees why a model is unavailable and what they can switch to.

</specifics>

<deferred>
## Deferred Ideas

None. The discussion stayed within phase scope.

</deferred>

---

*Phase: 13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted-event-log*
*Context gathered: 2026-10-28*

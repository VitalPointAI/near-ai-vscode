# Project Research Summary

**Project:** Near AI for VSCode — v0.7.0 Messaging relay with Teams and Signal adapters
**Domain:** Messaging bot relay over an existing agent harness (owner-hosted, multi-tenant)
**Researched:** 2026-11-13
**Confidence:** MEDIUM-HIGH overall (codebase findings HIGH; Microsoft platform mechanics HIGH where fetched from learn.microsoft.com; signal-cli mechanics HIGH–MEDIUM; library versions MEDIUM)

> **Naming trap, stated once.** This milestone's relay is the **new messaging relay** at `relay/`: receive a chat message, drive an existing agent team, post the result back. It is **not** the paused v0.5.0 *ciphertext sync relay* (`.planning/milestones/v0.5.0-paused/`, RELAY-01/02) and **not** the planned `relayTransport.ts` board-sync on the unmerged Team Mode branch. The roadmap must say so, or the milestone will be read as re-doing work that was deliberately parked.

## Executive Summary

The product is a VS Code extension that runs agent teams. This milestone takes the team out of the IDE: people in a Microsoft Teams group chat or a Signal group talk to the team, and nobody needs VS Code. The bot is an **external app** — never a member of the customer's Microsoft organisation — and a group chat sees only the finished result while the working thread continues privately in the requestor's 1:1 chat.

The decisive research finding is that **this is an assembly job, not a refactor.** `src/agent/loop.ts` never imports `vscode`; every host capability arrives through injected `AgentRunOptions` (client, tools, context, `requestApproval`, `input`, `emit`, `onProgress`). The model client, the team loader, checkpoints and run markers are likewise pure Node. So the relay composes existing modules into a headless runner, and **the extension itself is not modified at all** — a far smaller milestone than the brief implies, and one that cannot destabilise 0.4.x.

The risk has moved off the code and onto the trust boundary. Six of eight ranked security pitfalls are High, and they are not integration bugs — they are the ways a public endpoint over a paid model key gets abused: partially-verified webhooks, identity mis-binding that sends one tenant's private answer to another, a public group chat as an unbounded budget drain, prompt injection where the whole conversation is attacker-writable, duplicate delivery double-spending, and tenant isolation breaks. The owner called the security work "the real work", and the research agrees: **fixing the inbound path and the tenant boundary is the milestone**, not a hardening pass at the end.

## Key Findings

### Recommended Stack

One new runtime dependency in the relay workspace — `jose` — plus Node 26 built-ins. No HTTP framework, no Bot Framework SDK, no fetch library, no SQLite package, no test framework. The Teams adapter is roughly 200 lines of REST + JWT the repo fully controls; the Signal adapter is a sidecar container the relay talks to over a WebSocket and `fetch`. Details: [STACK.md](./STACK.md).

**Core technologies:**
- **Node 26.13.1 'Lithium' LTS** — relay runtime — owner decision; released 2026-11-11 as a security release fixing 16 CVEs (9 High) concentrated in **http2 and TLS**, the exact modules a public webhook server runs. EOL 2029-04-30. The extension's own CI stays on Node 24.
- **`jose` 6.2.14** — Bot Framework JWT + JWKS verification — MIT, zero transitive deps, pure JS over WebCrypto. The security boundary is the wrong place for bespoke code; JWKS rotation, `kid` misses and alg confusion are precisely where hand-rolled verification fails silently. *(Owner chose this over hand-rolling on `node:crypto`.)*
- **`node:http`** — the webhook server — the public surface is 2–4 routes; a hand-written router keeps the attacker-controlled parsing path auditable and adds no supply-chain surface.
- **`node:sqlite`** (`Database`, stability 1.2 RC) — tenant allowlist, conversation→run mapping, in-flight runs, spend ledger — survives restarts with WAL, **no native build step** (unlike `better-sqlite3`, which would need a toolchain in CI and the container).
- **Global `fetch` + `WebSocket`** — outbound REST and the Signal sidecar stream — both built into Node 26; undici ships freshly patched in 26.13.1.
- **`gcr.io/distroless/nodejs26-debian13:nonroot`** — container — no shell, no package manager, smallest surface for an internet-facing box.
- **`signal-cli-rest-api` sidecar** — Signal transport — the relay never speaks the Signal protocol itself.

### Expected Features

Research split the landscape into table stakes, differentiators and anti-features, and the split drives the milestone's shape. Details: [FEATURES.md](./FEATURES.md).

**Must have (table stakes):** channel adapters for both Teams and Signal; reply-in-thread correctness (Teams-only — Signal has no threads); person attribution; acknowledge → finish → deliver; live progress in the 1:1 working thread; a text command set (`help`/`status`/`cancel`/`cost`/`pause`) because Signal has no buttons; cancellable runs; per-tenant budget caps with spend visibility; document delivery **as signed expiring links** (the extension already emits PDF/DOCX); typed event mapping and idempotency; allowlist gate at the boundary; append-only activity log.

**Should have (differentiators):** in-group streaming progress on Teams; ephemeral status events; an admin-runbook onboarding package (the real adoption bottleneck); a milestone-only DM policy that respects each platform's ambient-noise rules; spend-meter parity with the extension UI; two-way attachments.

**Defer / not building:** Universal-Actions cards as the sole Teams UX (needs tenant-admin consent, breaks on orgs that refuse it); streaming the full transcript into the group (explicitly against the owner's result-only decision); fabricated "run rooms" that fake threads; anonymous requesters; auto-upgrading signal-cli; bots talking to each other (Teams never delivers another bot's messages — document it as a contract: one team per group chat).

### Architecture Approach

The relay drives an **extension-less runner composed from the already-vscode-free agent core**. `grep "from 'vscode'"` matches 30 files: `src/extension.ts` and 27 under `src/services/`. **`src/agent/` has zero matches** — `loop.ts`, `tools.ts`, `teams.ts`, `checkpoints.ts` are pure Node. `chat.ts` is UI-bound and is *not* imported; it is the spec the relay's thin transport re-implements headlessly. Details: [ARCHITECTURE.md](./ARCHITECTURE.md).

**Major components:**
1. **relay HTTP server + Bot Framework verifier** — ack in under a second, verify the full JWT checklist, `/healthz`.
2. **relay core** — the only place that knows Teams/Signal shapes: tenant resolution, conversation binding, dedupe, budgets, queuing.
3. **runner pool** — ≤N child processes, one per in-flight run; each child is a small entrypoint assembling `AgentRun` with the tenant's client, tools, workspace and the four injected callbacks.
4. **conversation registry** — maps the three chat identities (Teams group, Teams 1:1, Signal chat) to tenant/requester/run; this is where the C2/C6 defence lives.
5. **signal sidecar link** — a thin JSON-RPC client over a Unix socket locked to the relay's OS user.

**Reuse without edits:** `loop.ts`, `tools.ts` + tool modules, `teams.ts`, `checkpoints.ts`, `nearAiClient.ts`, the spend ledger, permissions/policy. **`runMarkers.ts`** is reused as the restart-safety mechanism — its `AUTO_RESUME_WITHIN_MS` (12 h) and `MAX_AUTO_RESUMES` (3) are the existing answer to "a deploy mid-run". A correction worth recording: the durable mechanism is `runMarkers.ts`, **not** `runActivity.ts`, which is only a per-process counter.

### Critical Pitfalls

Details and prevention per pitfall: [PITFALLS.md](./PITFALLS.md).

1. **Partially verified webhook (C1, High)** — the bot leaks its own token and strangers run agents on the owner's key. Prevent: verify *every* item of the Microsoft checklist on every request (`iss`/`aud`/signature/`serviceUrl`-claim match/channel endorsement/5-min skew), hardcode the OpenID metadata URL, 403 on any failure, no config flag can disable it in a release build, emulator path compiled out. **JWT validity is not replay safety** — signature checks must be paired with the dedupe store.
2. **Identity mis-binding (C2, High)** — tenant A's private answer lands in tenant B's chat. Prevent: bind identity from the *verified* envelope only, never from message text; persist `channel_identity ↔ tenant ↔ requester` on first sight; never route on a user-supplied string.
3. **Public group chat as unbounded budget drain (C4, High)** — one @mention loop drains the owner's spend cap. Prevent: per-tenant *and* per-conversation caps checked before every billing boundary, refuse-on-exceed with a plain in-chat explanation.
4. **Group-chat prompt injection (C3, High)** — the whole conversation is attacker-writable, not just one message. Prevent: fence group text as untrusted in the prompt, keep tool output and working-thread context out of group posts by construction (result-only does most of this).
5. **Duplicate delivery (C5, High)** — Teams retries, Signal resends after reconnect, one message starts two runs. Prevent: dedupe key `(channel, conversation, message id/timestamp, sender)` enforced **in the same transaction as the run insert**.
6. **Tenant isolation break (C6, High)** — a message reaches the wrong tenant's team, key or workspace. Prevent: allowlist checked at the boundary before anything else; per-tenant state directory; the runner child gets only its tenant's key and workspace path.

## Implications for Roadmap

Nine phases, numbered **68–76** under milestone **v0.7.0** (Team Mode on the unmerged branch already claims v0.6.0 and phases 60–67; starting at 68 keeps both milestones honest). Ordering follows the architecture's dependency-respecting build order, with security work first because it is the milestone.

### Phase 68: Relay foundation — workspace, config, state, secrets
**Rationale:** every later phase writes into `relay/` and `relay/state/`, so the layout and the secret story must exist first.
**Delivers:** `relay/` workspace with its own `package.json` and lockfile, `engines: ">=26.13.1 <27"`, tsconfig, `node:test` wiring, config loader, state-dir layout, secret storage decision (vault-or-file), `/healthz`, distroless container build.
**Uses:** Node 26.13.1, distroless image, `node:test`.
**Avoids:** C8 (secrets), and the Node-version drift the owner called out.

### Phase 69: Inbound authenticity — Teams verifier, ack-fast, idempotency
**Rationale:** nothing may run an agent until the inbound path is trustworthy; this is also where the adversarial tests belong.
**Delivers:** `POST /api/messages` with the full Bot Framework JWT + JWKS verification (`jose`), serviceUrl-claim match, endorsement check, 403 paths, an idempotency store keyed as above, and an adversarial test harness (forged signature, tampered body, mismatched serviceUrl, expired token, replayed POST, emulator-shaped token).
**Addresses:** allowlist gate at the boundary; typed event mapping.
**Avoids:** C1, C5, L1 (emulator path).

### Phase 70: Identity, tenants and conversation registry
**Rationale:** a verified message is not yet an *attributed* message; the private-reply guarantee rests entirely on this phase.
**Delivers:** tenant registry with allowlist, `channel_identity ↔ tenant ↔ requester` binding persisted on first sight, the three-way conversation identity map, per-tenant state directories.
**Addresses:** person attribution; allowlist gate.
**Avoids:** C2, C6. **This is the phase to over-test.**

### Phase 71: Runner pool and the first vertical slice
**Rationale:** the first proof that the whole path works, and deliberately the smallest surface — a Teams **1:1**, which sidesteps group injection and budget-drain concerns entirely while still proving verification, tenancy, runner, key spend and durability.
**Delivers:** runner child entrypoint composing the existing harness; pool with per-tenant and global concurrency caps; one-member team on the tenant's workspace and key; result posted back to the same 1:1; run record + marker written so a restart mid-run demonstrates auto-resume.
**Uses:** `loop.ts`, `tools.ts`, `teams.ts`, `nearAiClient.ts`, `runMarkers.ts`, `checkpoints.ts` — all unchanged.
**Implements:** runner pool, run records.

### Phase 72: Run lifecycle — approvals, steering, resume
**Rationale:** long runs need a human in the loop, and the loop already models an unanswered approval as non-blocking — that behaviour must survive the trip into chat.
**Delivers:** `requestApproval` backed by a durable pending-approval record and a 1:1 card/message, resolved from an inbound reply or denied on TTL; steering queue over the per-conversation durable queue; startup resume scan; honest "the run died" state instead of silence.
**Addresses:** cancellable runs, `pause`/`resume`, `status`, live progress in the working thread.
**Avoids:** C7 (lifecycle leaks).

### Phase 73: Budgets and spend
**Rationale:** caps need real run records to clamp against, so they land after the slice rather than before it.
**Delivers:** per-tenant and per-conversation caps enforced before each billing boundary, refuse-on-exceed with a plain explanation, `cost` command, spend-meter parity with the extension UI, extension of the existing spend ledger.
**Addresses:** per-tenant budget caps; spending state and transaction log.
**Avoids:** C4.

### Phase 74: Teams group chats — threads and result-only discipline
**Rationale:** group behaviour is widening on a proven path, not new architecture.
**Delivers:** @mention handling, reply-in-thread using conversation id + root message id, the result-only contract (group gets ack + finished result; working thread stays private), prompt-injection fencing for whole-conversation untrusted text, signed expiring links for PDF/DOCX delivery.
**Addresses:** reply-in-thread correctness; document delivery; the owner's group-view decision.
**Avoids:** C3, plus the anti-feature of streaming the transcript into the group.

### Phase 75: Signal adapter
**Rationale:** second adapter over a proven relay core — it proves the abstraction and adds the one channel with no threads, no cards and no buttons.
**Delivers:** `signal-cli-rest-api` sidecar with pinned image and persistent identity volume, JSON-RPC/WebSocket ingestion, group-id allowlist, text-command parity, `--attachment` document delivery, quoted replies standing in for threads.
**Addresses:** the Signal half of every table-stakes row; channel-specific shapes.
**Avoids:** M2 (signal-cli staleness, bans, re-registration), C2's recycled-phone-number case.

### Phase 76: Hardening, runbooks and release
**Rationale:** the adoption bottleneck is administrative, not technical, so the deliverables a customer's admin needs are a phase of their own.
**Delivers:** threat-model doc, the adversarial regression suite wired into CI, Teams app package + admin-consent walkthrough, Signal number-provisioning and custody checklist, self-host playbook, activity log and admin tooling.
**Addresses:** onboarding runbook, self-host playbook, append-only activity log.
**Avoids:** M1 (manifest version, sideload policy, external-access policies that block guest bots entirely).

### Phase Ordering Rationale

- **Security before features.** Phases 69–70 are pure trust-boundary work with no user-visible output, placed first because six High pitfalls live there and retrofitting them is how relays get breached.
- **1:1 before group.** The first vertical slice deliberately avoids the two hardest surfaces (injection, budget drain) and still proves every mechanism end to end.
- **Budgets after the slice.** Caps clamp real run records; building them first means guessing at the record shape.
- **Signal last of the two channels.** Teams has a larger installed base and better-documented protocol; Signal reuses the core wholesale and its operational traps deserve dedicated attention when nothing else is moving.
- **The extension is untouched throughout**, so no phase can regress 0.4.x.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 74 (Teams group chats):** in-group streaming is *unverified* by any fetched Microsoft doc — plan a spike, and fall back to post-don't-stream in-group.
- **Phase 75 (Signal):** the exact `signal-cli` version to pin and the image's bundled age must be verified **at adoption**, not trusted from research; also the group-id wire format for `/v2/send`.
- **Phase 71 (runner pool):** composing the harness headlessly is well-evidenced but never yet *done*; treat the first child process boot as a spike with a known-good fallback.

Phases with standard patterns (skip research-phase):
- **Phase 68:** workspace, config, container — ordinary.
- **Phase 69:** the Microsoft checklist is explicit and fetched; the work is fidelity, not discovery.
- **Phase 73:** spend accounting already exists in the extension.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Node 26.13.1, `jose`, distroless and the built-ins are HIGH (fetched). `signal-cli-rest-api` image recency and the exact `signal-cli` version are LOW (secondhand trackers) and must be verified at adoption. |
| Features | HIGH | Every platform claim checked against Microsoft Learn or the signal-cli man page; the Teams/Signal split is explicit. |
| Architecture | HIGH | All codebase claims verified with file:line this session; the seam already exists. |
| Pitfalls | MIXED-HIGH | Codebase observations HIGH; Microsoft mechanics HIGH; duplicate-`activity.id` and guest-bot limits MEDIUM (community sources). |

**Overall confidence:** MEDIUM-HIGH.

### Gaps to Address

- **`node:sqlite` stability** — it is a Release Candidate in Node 26, not yet stable. Acceptable for an owner-hosted relay, but the roadmap should name a fallback (JSON files per tenant) in case the API shifts before the relay ships.
- **Teams activity field paths** — tenant/thread/requestor ids were verified against docs but not against a live Teams tenant. Phase 70 should confirm against a real payload before the registry schema is frozen.
- **Proactive 1:1 messaging** — messaging a person privately after a group mention depends on the bot's install scope in the customer org. This is the single most likely thing to derail the owner's headline scenario; verify during phase 70 and state the fallback (ask the person to open the 1:1 first).
- **In-group streaming on Teams** — undocumented. A spike in phase 74, with post-don't-stream as the guaranteed behaviour.
- **`jose` and `@types/node@26` engines ranges** — confirm at install time, not from research.
- **`signal-cli` schema churn** — pin exactly; treat upgrades as a deliberate milestone with a regression checklist.

## Sources

### Primary (HIGH confidence)
- https://nodejs.org/en/blog/release/v26.13.1 — Node 26.13.1 security release (2026-11-11), 16 CVEs / 9 High, http2 + TLS, bundled undici 8.12.4 / SQLite 3.54.1
- https://nodejs.org/en/blog/release/v24.22.3 — the 24-line counterpart
- https://beta.docs.nodejs.org/sqlite — `node:sqlite` stability 1.2, `Database` vs deprecated `DatabaseSync`
- https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication — token endpoint/scope, `expires_in: 3600`, OpenID/JWKS URLs, issuer/audience/serviceUrl/skew requirements
- https://learn.microsoft.com/en-us/microsoftteams/platform/legacy-tools-sdks — Bot Framework SDK retired as a bot SDK; Teams/Agents SDK is the successor
- https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/bf-migration-guidance — migration guidance
- https://github.com/AsamK/signal-cli — JRE 25, JSON-RPC daemon, 3-month freshness rule, GPLv3
- https://github.com/bbernhard/signal-cli-rest-api — modes, `POST /v2/send`, `/v1/receive/{number}` websocket, MIT
- https://github.com/GoogleContainerTools/distroless — `nodejs26-debian13` exists, entrypoint `node`

### Secondary (MEDIUM confidence)
- npm listings for `jose` 6.2.14 (MIT, zero transitive deps) and `@microsoft/agents-hosting` 1.7.2 — version and licence; pin exact at install
- https://undici.nodejs.org/best-practices/undici-vs-builtin-fetch — built-in fetch is the default
- https://microsoft.github.io/teams-sdk/blog/ai-libraries-to-agent-frameworks/ — `@microsoft/teams.ai` deprecated

### Tertiary (LOW confidence — verify before relying)
- `signal-cli` v0.14.10 via release trackers (not the GitHub releases page)
- `signal-cli-rest-api` image recency and bundled signal-cli age
- Duplicate-`activity.id` behaviour and guest-bot/external-access limits (community Q&A)

---
*Research completed: 2026-11-13*
*Ready for roadmap: yes*

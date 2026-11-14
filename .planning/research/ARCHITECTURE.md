# Architecture Patterns

**Domain:** Owner-hosted multi-tenant messaging relay (Microsoft Teams + Signal via signal-cli) that makes this product's agent teams reachable without end users running VS Code
**Researched:** 2026-11-13
**Confidence:** Codebase findings are **HIGH** — every claim below was read directly from `src/` in this repo at v0.4.19, with file:line references. External mechanics (Bot Framework 15-second acknowledgement, signal-cli JSON-RPC daemon mode) are **HIGH**, fetched 2026-11-13 (see Sources). Design recommendations are the author's synthesis of that evidence.

> **Naming trap, stated up front:** this document describes the **messaging relay** — a new `relay/` workspace in this repo that receives Teams and Signal messages and drives agent runs. It is **not** the paused v0.5.0 ciphertext sync relay, and **not** the planned `relayTransport.ts` board-sync transport (unmerged). Three different things share the word "relay"; only this one is a message ingress.

**Companion documents:** `.planning/research/PITFALLS.md` ranks the security pitfalls (C1–C8) this architecture must answer; its work-area vocabulary (**Inbound & auth, Identity & tenants, Chat ingestion, Spend & budget, Run lifecycle, Secrets & ops, Teams integration, Signal integration, Hardening & release**) is reused here so the roadmap can map both documents onto the same phases.

---

## The decision, stated first

**The relay drives an extension-less runner built from the already-vscode-free agent core.** The audit below shows the harness's `vscode` dependency is confined to the services/UI layer (`chat.ts` and ~27 other service files); the run engine (`src/agent/loop.ts`), its session composition (`src/services/agentSession.ts`), the model client (`src/services/nearAiClient.ts`), the provider cache (`src/services/providerCache.ts`), the team library (`src/agent/teams.ts`), durability (`src/services/runMarkers.ts`, `src/agent/checkpoints.ts`) and the tool implementations (`src/agent/tools.ts` et al.) are pure Node with all host capabilities injected as options. The seam the relay needs **already exists**; no refactor of the extension is required, and the VS Code extension stays untouched.

That makes **integration Option A** (new small runner binary composing existing modules) the least-work, least-risk choice over embedding a rewritten harness (Option C) or proxying to a headless agent service (Option B). Everything else in this document follows from that decision.

---

## Standard Architecture

```
                                   OWNER'S HOST (one box, one relay process)
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                    │
│  Microsoft Teams                    Signal                                         │
│  (bot app, external to              (relay's phone number,                         │
│   the customer's M365 org)           linked via signal-cli)                        │
│        │ HTTPS POST                        │ Signal protocol                       │
│        │ (Bot Framework activity,          ▼                                       │
│        │  JWT-signed)              ┌──────────────────┐                            │
│        ▼                           │  signal-cli      │  (supervised sidecar       │
│  ┌───────────────────────┐         │  daemon          │   process; JSON-RPC over   │
│  │ relay HTTP server     │         │  JSON-RPC mode   │   a Unix-domain socket)    │
│  │  node:http, no framework│◀───────▶│  owns registration│                           │
│  │  /api/teams  /api/health       │  blob & sessions │                            │
│  └───────┬───────────────┘         └──────────────────┘                            │
│          │ normalize to RelayInbound                                               │
│  ┌───────▼──────────────────────────────────────────────────────────────────┐      │
│  │ relay core (in-process, single event loop)                                │      │
│  │  • JWT/identity verification (C1)   • idempotency store (C5)              │      │
│  │  • tenant registry + allowlist      • conversation registry (C2, C6)      │      │
│  │    (C6)                             • durable message queue per convo     │      │
│  │  • budget guards (C4, C3 spend)     • run records + resume scan           │      │
│  └───────┬──────────────────────────────────────────────────────────────────┘      │
│          │ 1 request = 1 queued job                                               │
│  ┌───────▼──────────────────────────────────────────────────────────────────┐      │
│  │ runner pool: ≤N child processes, one per in-flight run                    │      │
│  │  ┌────────────────────────────────────────────────────────────────┐      │      │
│  │  │ runner child = extension-less harness (per-run process)         │      │      │
│  │  │  AgentRun (src/agent/loop.ts) + tools + policy + teams.ts lib   │      │      │
│  │  │  NearAiClient (src/services/nearAiClient.ts, tenant key)        │      │      │
│  │  │  RunCheckpoints + run markers (durable, reused as-is)           │      │      │
│  │  │  approvals → durable pending cards → 1:1 chat                   │      │      │
│  │  └───────────────┬────────────────────────────────────────────────┘      │      │
│  └──────────────────┼───────────────────────────────────────────────────────┘      │
│                     │ HTTPS (OpenAI-compatible)                                    │
│                     ▼                                                              │
│              NEAR AI cloud (billed to the *tenant's* key; spend ledger tags)       │
│                                                                                    │
│  relay/state/  (git-ignored, chmod 700): run records, conversation bindings,       │
│  pending approvals, message queues, checkpoints — all plain files on disk          │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation here |
|---|---|---|
| relay HTTP server | Accept Bot Framework activities, ack fast (<1s), health endpoint | New; `node:http`, no framework (the workspace's only npm dependency is `jose`, for token verification) |
| Bot Framework verifier | Full MS JWT checklist on every request (C1) | New; issuer/audience/exp/signature/`serviceUrl`-claim match per learn.microsoft.com checklist |
| signal sidecar link | Own Signal in/out; nothing else touches Signal directly | New thin client over signal-cli JSON-RPC unix socket; socket locked to the relay OS user (PITFALLS C2) |
| relay core | Verification, tenant resolution, conversation binding, dedupe, budgets, queuing | New; the only place that knows about Teams/Signal shapes |
| runner child | One agent run end-to-end: model turns, tools, approvals, checkpoints | New small entrypoint composing **existing** `src/agent/` + client modules unchanged |
| runner pool | Cap concurrent runs per tenant and overall; queue overflow | New; per-tenant slots, precedent: agentSession's slot machinery (`src/services/agentSession.ts` ~:800–822) |
| run records & resume | Durable "started without ended" markers; restart recovery | **Reused**: `src/services/runMarkers.ts` semantics, incl. the 12-hour auto-resume window |
| conversation registry | Maps the three chat identities (Teams group, Teams 1:1, Signal chat) to tenant/requester/run | New; the C2/C6 defense lives here |
| NEAR AI client | Model streaming, pricing, spend ledger | **Reused unchanged**: `src/services/nearAiClient.ts` — constructed per tenant with that tenant's `apiKey` |
| VS Code extension | Unchanged | No modification in this milestone |

---

## The reused harness: vscode dependency audit (Q1)

Full inventory: `grep "from 'vscode'"` across `src/` matches exactly 30 files — `src/extension.ts`, 27 files under `src/services/`, and 2 test files. **Zero matches in `src/agent/`.** Classification of the modules the relay needs:

| Module | vscode? | Evidence | Classification |
|---|---|---|---|
| `src/agent/loop.ts` (the run engine) | **No** | Imports are `node:crypto`, `node:fs/promises`, `node:os`, `node:path` plus `./runActivity`, `./permissions`, `../gsd/preamble`, `./safetyModel`, `./unattended`, `./shell`, `./testIntegrity`, `../domain/approvalRisk`, `./tools`, `./workspace`, and type-only imports from `../services/nearAiClient` (`src/agent/loop.ts:1–16`) | **Trivially reusable as-is** |
| Host capabilities the loop needs | — | All injected: `AgentRunOptions.client` (streaming client), `tools`, `context` (workspace root, shell session, checkpoints), `policy`, `rules`, `requestApproval()`, `rememberAllowRule()`, `emit()`, `input` (steering queue) — `src/agent/loop.ts:130–197` | **Seam already exists** |
| `src/services/agentSession.ts` (session composition) | **No** | Imports are `node:*` modules, `../agent/*`, `./activityOverview`, `./cyberRun` (type-only), `../mcp/tools`; run core wraps the run in `withSpendTag({kind:'main', runId, conversationId, agentId}, …)` (~:400–424); event mirroring via `track()`/`forward()` (~:1100–1120); concurrency slots ~:800–822 | **Trivially reusable as-is** |
| `src/services/nearAiClient.ts` (model client) | **No** | Imports: `node:crypto`, attestation, config, redaction, spendLedger/spendAccount/spendReconciler, capabilities types (`src/services/nearAiClient.ts:1–8`); grep for `vscode` in this file: no matches. Configured entirely by plain options: `baseUrl`, `apiKey`, `fetchFn`, `spend` (SpendSink), `spendTag.projectId` (`:121–145`); billable paths recorded into the ledger (`:148`) | **Trivially reusable** — instantiate per tenant: `createNearAiClient({ baseUrl, apiKey, spend, spendTag })` (`:164`) |
| `src/services/providerCache.ts` (`clientFor`, `activeProvider`) | **No** | Imports: domain/auth types, domain/config, `./auth`, `./nearAiClient` type, `./profileStore`, `./providerFactory` (`:1–6`); `activeProvider(root, auth)` resolves the active profile from disk (`:29–57`); `clientFor(active, model)` picks cloud vs local client (`:60–64`) | **Reusable** for owner-key tenants; relay supplies an auth/profile root per tenant |
| `src/agent/teams.ts` (team markdown → TeamDefinition, members, lead prompt) | **No** | Imports: `node:crypto`, `node:fs/promises`, `node:path`, domain/agents types, gsd/library parser, agentTeams recommendation (`:1–6`); exports `parseTeam` (`:75`), `TeamDefinition` (`:30`), `TeamLibrary` (`:189`) | **Trivially reusable** |
| `src/agent/tools.ts` + tool modules (shell, workspace, glob, diff, web, graphics, security) | **No** | `src/agent/tools.ts:1–11` imports only node modules and sibling agent modules; host-specific knobs ride in `ToolContext` (root, shell, checkpoints, readFiles, ripgrepPath, readOnlyRoots, trustedToolRoots, gsdRuntime, pages, onSecurity) (`:15–38`) | **Trivially reusable**; the runner builds the same `ToolContext` the extension builds |
| `src/services/runMarkers.ts` (durable interrupted-run markers) | **No** | Small marker files outside project dirs; validated id regexes; `MAX_STEPS = 12` (`:15`); `settle(conversationId, 'resumed'\|'dismissed')` (`:108–113`); **`AUTO_RESUME_WITHIN_MS = 12 * 60 * 60_000` (`:193`)**, `MAX_AUTO_RESUMES = 3` (`:195`), selection newest-first (`:197–209`) | **Reuse as-is** — this *is* the restart-safety mechanism (Q6) |
| `src/agent/checkpoints.ts` (per-run undo) | **No** | `RunCheckpoints(runId, storageDir)`; snapshots mirrored to `storageDir` so revert works after a restart; captures only file-tool writes, not shell effects (`src/agent/checkpoints.ts:10–21`) | **Reuse as-is** |
| `src/agent/runActivity.ts` | No | 27 lines; an **in-memory** `beginRun()`/`runInProgress()`/`whenIdle()` counter so Update Team never rewrites a team mid-run — **not** durable, **not** the resume mechanism | Reuse per-process; durability is runMarkers' job |
| `src/services/chat.ts` (conversation orchestration) | **Yes** | `import * as vscode from 'vscode'` at `src/services/chat.ts:4`; UI-bound paths: attach-files → `vscode.window.showOpenDialog` (`:407–408`), webview `panel.postMessage`, `vscode.commands.executeCommand` (`:430–450`); but its *decisions* are instructive, not its code | **Do not import.** Treat as the spec the relay core re-implements in headless form |
| Spend tracking UI (`src/services/spendTracking.ts`) | **Yes** | vscode settings (`:22`, `:27`), `SecretStorage` (`:31`), QuickPicks/loopback sign-in (`:91`, `:97–117`) | Secret *storage* differs (vault/file, below); the ledger and guards underneath are node-side |
| Everything else matched by grep | Yes | Panels, commands, settings pages, onboarding, emergency stop, export | Irrelevant to the relay; extension keeps them |

**Corrected assumption worth recording:** the durable-restart mechanism is `runMarkers.ts`, not `runActivity.ts` (which is only a per-process counter). The "12-hour resume window" is `AUTO_RESUME_WITHIN_MS` at `src/services/runMarkers.ts:193`.

## The seam between loop and host (Q2)

No new seam needs to be invented. `AgentRunOptions` (`src/agent/loop.ts:130–197`) **is** the seam, and the extension already sits on the far side of it:

- **Model access** — injected `client` with `streamCompletion(...)` and `cooldownRemainingMs(...)` (`:131`); the relay injects a `NearAiClient` built with the tenant's key.
- **Tool execution context** — injected `tools: AgentTool[]` + `ToolContext` (workspace root, shell, checkpoints) (`:133–134`, `tools.ts:15–38`); the runner builds it exactly as agentSession does, pointing at the tenant's sandboxed workspace.
- **Human approval** — injected `requestApproval(request): Promise<ApprovalReply>` with decisions `allow | allow-run | allow-always | deny | pending` (`loop.ts:62–80`, `:193`). The relay implements this by persisting a pending approval record, posting an adaptive card/action to the requester's 1:1 chat, and resolving the promise from an inbound message — or answering `deny` with feedback when a TTL expires. The loop already treats an unanswered card as non-blocking (`pending`, PERF-01 note at `loop.ts:76–80`), which maps cleanly onto an offline requester.
- **Steering / mid-run messages** — injected `input: RunInput` (`pending/take/subscribe/interruptRequested`) (`loop.ts:115–128`). The relay implements it over its durable per-conversation message queue, which doubles as restart-safe buffering for "runs are long, people type while waiting."
- **Observability** — injected `emit(event: AgentEvent)` (`loop.ts:85–99`); the runner forwards events to (a) the 1:1 working thread (compact) and (b) its run record (full), replacing what `agentSession.track()`/`forward()` do for the webview (~agentSession.ts:1100–1120).
- **Checkpointing** — optional `onProgress(transcript)` (`loop.ts:186`) → the runner persists the transcript to the run record, same as the extension does for reload survival (PERF-05).

The relay's runner is therefore an assembly file, not a rewrite: construct tools, construct `ToolContext`, construct the tenant's client, provide the four callback implementations above, call `new AgentRun(options).run(messages, signal)` — the same call shape the extension makes through agentSession (`withSpendTag({kind:'main', …}, () => run.run(messages, abort.signal))`, agentSession ~:400–424).

## Integration options considered (Q3)

| | Option A: relay drives an **extension-less runner** (new small process composing `src/agent/*` + client modules) | Option B: relay connects to a **headless agent service** | Option C: relay **embeds a rewritten harness** |
|---|---|---|---|
| Work | Low–medium: one runner entrypoint + adapters; zero changes to existing modules | Highest: productize+deploy a second long-lived service, plus an API/protocol that today does not exist | Looks low but is secretly highest: reimplementing chat.ts's orchestration headlessly means re-deriving months of settled decisions (budget gating `chat.ts:593–596`, attachments `:607–634`, resume `:400–401`) |
| Risk | Low: the run engine, safety model, permissions, spend ledger, checkpoints, markers — all battle-tested code paths, used unchanged | High: new service = new deployment, new auth surface, new versioning; contradicts the repo's single-binary ethos | High: drift. Every fix to loop/permissions/policy must be mirrored by hand; the rewritten copy silently diverges |
| Isolation | Strong: runner is a **child process per run** — a runaway or crashed run cannot take the relay's HTTP front door down; per-tenant workspace + key enforced by construction | Depends on service's multi-tenancy (none exists yet) | Weak: agent runs share the relay's event loop and memory |
| Fit to repo | Matches existing patterns (node-only modules, injected options, file-based durability) | Imports a microservice mindset the codebase deliberately avoids | Worst |

**Choose A.** The decisive evidence: `src/agent/loop.ts` never imports `vscode`, and every host capability it needs arrives through options. What the relay must write new is exactly the part that has no reusable core anyway — ingress adapters and identity/budget plumbing (the PITFALLS work areas) — not the agent.

---

## Multi-tenancy (Q4)

Locked decision: owner-hosted, multi-tenant with an explicit tenant allowlist; the bot is an **external app** — it is not registered in the customer's Microsoft 365 org, so there are no per-customer admin-consent flows to automate.

### The registry (new, the smallest thing that answers C6)

`relay/relay.json` (chmod 600, outside git) plus per-tenant state on disk:

```
relay/state/
├── tenants/<tenantId>/            # one folder per allowlisted tenant
│   ├── profile/                   # NEAR AI key + profile store ← the tenant's own credentials
│   ├── workspace/                 # the sandboxed root every run for this tenant uses
│   └── teams/<slug>.md            # the tenant's installed agent-team files (parsed by src/agent/teams.ts:75 parseTeam, loaded via TeamLibrary :189)
├── conversations/<conversationId>.json   # binding: chat identity → tenant + requester + route (C2/C6)
├── runs/<runId>.json              # run records: request text, model, transcript path, marker semantics of runMarkers.ts
├── approvals/<approvalId>.json    # pending approval cards awaiting an answer
└── queues/<conversationId>/       # durable steering/queued messages (RunInput backing)
```

### What is shared vs per-tenant

| Resource | Shared or per-tenant | Rationale / mechanism |
|---|---|---|
| Relay process, HTTP endpoint, signal-cli daemon | Shared | One ingress; identity checked per request (C1) |
| Teams bot app identity (App ID/secret) | Shared (one bot) | The bot is the owner's external app; tenant identity comes from the *verified* activity's `from.aadObjectId`/tenant claims + allowlist, never from text (PITFALLS C2) |
| Signal identity | Shared (one number) | Allowlisted phone numbers; number-recycling caveat in PITFALLS C2 |
| **NEAR AI API key** | **Per tenant** | "Whose key spends?" — the tenant's own key spends; relay never relays its own key into a tenant run. Constructed per run: `createNearAiClient({ apiKey: tenant.key, spend, spendTag })` (`nearAiClient.ts:121–164`); the ledger's `SpendSink` + `spendTag.projectId` give per-tenant attribution (`:141–144`, billable paths `:148`) |
| Daily/per-run spend caps | Per tenant, enforced pre-run and mid-run | Mirror the extension's guard + budget clamp (`chat.ts:593–596`): group-chat triggers additionally bounded by the C4 group budget |
| Workspaces | Per tenant, isolated directories | `ToolContext.root` (`tools.ts:16`) is the sandbox every file/shell tool resolves through (`resolveInWorkspace`, `tools.ts:11`); give each tenant its own directory (container or OS user per tenant is the hardening upgrade) |
| Team libraries | Per tenant | Each tenant's `teams/*.md` parsed by the untouched `src/agent/teams.ts`; no cross-tenant reads — the runner receives only its tenant's paths |
| Concurrency slots | Per tenant + global cap | Port agentSession's slot idea (~:800–822) so one tenant's burst cannot starve others (PERF-04 deadlock note applies) |
| Approvals | Per requester (1:1 route) | "Allow always" writes into the **tenant's** rules store, never a global one — the loop already scopes grants to the run (`loop.ts:169–176`) |

**Trust boundary in one sentence:** the relay core is the only component that sees both channels and tenants; a runner child sees exactly one tenant's workspace, key, and team files; nothing a runner produces is trusted as identity or routing information (it is outside content — same rule as the extension's, enforced by the same tools code).

## Conversation identity & state (Q5)

Three distinct chat identities exist and must not be conflated:

| Chat | Who talks | What it carries | Identity anchors |
|---|---|---|---|
| **Teams group/channel** (tenant's team chat) | Any allowlisted member @mentioning the bot | **Request intake and the finished result only** — never working notes | Verified activity: `from.aadObjectId`, `conversation.id`, tenant claims |
| **Teams 1:1 with the bot** | One person | Working thread: steering messages, approval cards, questions, progress, errors | Same verified anchors; conversation reference captured at first verified message |
| **Signal group** | Allowlisted numbers | Request intake + finished result (same discipline as Teams group) | Sender number from our own signal-cli envelope — trustworthy only because the JSON-RPC socket is locked down (PITFALLS C2: signal-cli JSON-RPC has "no authentication nor authorization") |
| **Signal 1:1** | One number | Working thread (or the whole conversation when there is no group) | Same as above |

**Mapping model:** the conversation registry stores, per chat identity: tenant, requester, current/last run, route-back data (Teams: the Bot Framework *conversation reference* captured from the verified inbound — never reconstructed from text; Signal: the reply address from the envelope). A run owns **one requester thread** (where working traffic goes) and **zero or one group thread** (where only the composed result goes). Membership rules:

- Message arrives in a group → resolve binding by group conversation id (bound at provisioning time by the owner's allowlist, not TOFU: group bindings are claimed by the owner, answering the TOFU race in PITFALLS C2).
- Message arrives in a 1:1 → resolve by the chat's stored requester binding; 1:1 first-contact binding is TOFU but low-stakes because a 1:1 only ever reaches the person who started it.
- A run started from a group keeps listening for steering on the **requester's** thread and buffers group chatter (only direct replies to the bot's result message may steer, if at all).

**Restart safety for in-flight runs** — reuse, do not reinvent:

1. Runner persists `onProgress` transcripts (PERF-05 hook) into `runs/<runId>.json`.
2. Run markers with runMarkers.ts semantics live next to them: a marker "started without ended" = a run cut off by relay restart/crash.
3. On relay startup, scan markers and apply the extension's settled policy verbatim: auto-resume only within `AUTO_RESUME_WITHIN_MS` (12 h), at most `MAX_AUTO_RESUMES = 3` newest-first, never while an emergency stop is engaged, everything older keeps an explicit resume affordance (`runMarkers.ts:192–209`); resumed/dismissed runs are `settle()`d so they are not reported twice (`:108–113`).
4. Pending approvals are durable files; on restart an unanswered card stays pending until its TTL, then resolves `deny` + feedback — the loop's `pending` semantics make this safe mid-run (`loop.ts:76–80`).
5. Checkpoints already survive restarts by design (`checkpoints.ts:10–21`), so revert-after-failure works identically.

## Run process model (Q6) — long runs behind a fast webhook

Constraint: Bot Framework expects the HTTP request **acknowledged with 200 within ~15 seconds** or the channel treats delivery as failed and retries (HIGH: Stack Overflow/Bot Framework consensus, fetched 2026-11-13; retries are exactly the duplicate-delivery problem of PITFALLS C5, so ack-fast is also a security control).

Options weighed:

| Approach | Verdict |
|---|---|
| **A. In-process async + durable record** — ack immediately, enqueue, a runner *child process per run* executes; state on disk | **Chosen.** Matches repo idiom (file-based durability, no DB); process isolation for free; restart semantics already invented by runMarkers.ts |
| B. `worker_thread` per run | Rejected: shares the relay process's failure domain (a hard crash in native/shell code kills ingress too); no stronger isolation than async for CPU-light work; threads complicate signal handling |
| C. Detached unmanaged child | Rejected for MVP: unparented processes leak on relay restart; the managed pool is barely more code and gives slot accounting |

Details of A:

- **Ack path:** verify (C1) → dedupe (C5 idempotency key = activity id + conversation) → persist inbound message to the durable queue → `res.statusCode = 202; res.end()` — all synchronously, well under the budget. Agent work never happens on the request path. (Node 26's `response.writeHead(...).flushHeaders()` + keeping the response open is *not needed* for Teams given ack-fast; it remains the fallback trick if a future channel demands held-open responses.)
- **Runner lifecycle:** pool starts a child per accepted job, capped by per-tenant + global slots; child writes its run record and marker at start, transcript continuously, end-state on finish — the exact write pattern runMarkers.ts documents (`:15–19`).
- **Reuse answer (explicit):** yes — the existing run-marker + 12-hour resume mechanism (`AUTO_RESUME_WITHIN_MS`, `MAX_AUTO_RESUMES`, auto-resume selection, `settle`) transfers as-is to relay restarts, because it is plain-node file logic with no vscode anywhere (`runMarkers.ts` imports: none beyond node).

## signal-cli placement (Q7)

**Chosen: signal-cli as a supervised sidecar daemon in JSON-RPC mode; the relay talks to it over a Unix-domain socket it alone can reach.**

- signal-cli's daemon mode supports an extended JSON-RPC interface over UNIX (and TCP) sockets; clients connected to the socket receive messages received *after* they connected (HIGH: AsamK/signal-cli discussion #799 and project README, fetched 2026-11-13). That fits the relay: one long-lived connection, inbound messages pushed, sends are JSON-RPC calls.
- Why not HTTP mode: same feature set over TCP but tempts binding to a port; JSON-RPC over a Unix socket keeps the "no authentication nor authorization" surface (maintainer-confirmed, PITFALLS C2) inside filesystem permissions — relay user only, mode 660 socket dir.
- Why not in-process/library: signal-cli is JVM-based and owns the registration blob/linking lifecycle; embedding is not a thing; spawning per command would fight its session state.
- The sidecar is supervised (systemd unit or `node:child_process` supervisor with restart backoff); the relay treats "socket down" as "Signal offline," queues outbound results durably, and never loses a result because Signal blinked.

---

## Data flow

### Request flow (Teams group @mention → finished result)

```
[Member @mentions bot in tenant's group chat]
    ↓ HTTPS POST, JWT-signed
[relay HTTP server] → [verifier: full MS checklist] → [idempotency store]
    ↓ (fresh activity)
[relay core] → resolve conversation binding → tenant + requester
    ↓ budget pre-check (tenant cap, group-chat C4 cap)
[durable queue] …runner pool picks up…
    ↓ spawn (or reuse) runner child with tenant scope
[runner] AgentRun.run(messages, signal)   ← loop.ts:296–304, beginRun/endRun wrapped
    │  model turns ↔ tools (tenant workspace, ToolContext)
    │  approval?  → durable pending card → 1:1 adaptive card → answer/TTL → resolve
    │  steering?  → RunInput.take() from durable queue (loop.ts:115–128, 331–332, 388–389)
    ▼ run completes (completed | max-turns | stuck | cancelled | error)
[runner] writes final record + marker 'ended'
    ↓
[relay core] compose result → post ONLY the result to the group (Teams proactive message
    from the stored conversation reference / Signal send)
    + post compact working summary/errors to requester's 1:1
```

### Key data flows

1. **Group-privacy flow:** group text (attacker-writable, PITFALLS C3) is fenced as outside content by the same tooling the extension uses (`ToolContext.tainted()`, `tools.ts:31`, `NETWORK_COMMAND` gating `tools.ts:9`); working-thread content never flows *to* the group — only the composed result does.
2. **Spend flow:** every billable call from a runner records into the ledger tagged `{projectId: tenantId, kind, runId, conversationId}` (`nearAiClient.ts:141–148`, spendLedger `usdToNano`/`SpendTag` at `:5`); the relay's mid-run guard clamps a run that blows through its cap (extension precedent `chat.ts:594–596`, `SpendLimitError` at `nearAiClient.ts:290–297`).
3. **Restart flow:** relay restart → marker scan → ≤3 recent (<12 h) runs auto-resume by re-queueing them with their persisted transcripts; older ones surface for explicit resume/dismiss (`runMarkers.ts:192–233`).

## New vs modified components (the split the roadmap needs)

| Status | Component | Notes |
|---|---|---|
| **New** | `relay/` workspace (own package.json and lockfile; exactly one runtime dependency, `jose`) | Server, verifier, core, pool, adapters — all new code |
| **New** | Bot Framework JWT verifier + Teams outbound sender | No Bot Framework SDK; verifier built on `jose` (`createRemoteJWKSet` + `jwtVerify`) plus the explicit iss/aud/exp/**serviceUrl-claim**/endorsement checks MS requires, outbound sender plain `fetch`. This is also the mitigation for PITFALLS C1's "SDK hides it" trap — here the business rules are explicit and testable |
| **New** | signal-cli JSON-RPC client | Thin; unix socket |
| **New** | Conversation registry, tenant registry, idempotency store, approval cards, runner pool | The PITFALLS work areas Inbound & auth / Identity & tenants / Run lifecycle made concrete |
| **Reused unchanged** | `src/agent/loop.ts`, `tools.ts` + tool modules, `teams.ts`, `checkpoints.ts`, permissions/safetyModel/unattended, `src/services/nearAiClient.ts`, spend ledger, `providerCache.ts` for owner-scope auth/profiles | Imported by the runner child; **no edits** |
| **Reused with a thin wrapper** | `runMarkers.ts` | Same semantics/format; wrapper points it at relay state dirs (marker files live with the relay, one per conversation — same rule: never inside the project workspace) |
| **Modified** | *Nothing in the extension* | Repo compiles and ships exactly as before; CI/Node targets untouched (relay targets Node 26.13.1 per locked decision; extension stays VS Code/Node 24) |
| **Ops, not code** | systemd units / container layout, secret storage for bot secret + tenant keys + signal-cli blob (PITFALLS C8, Secrets & ops area) | Documented in the relay README; vault-or-file decision is a phase task |

## Recommended Project Structure

```
relay/
├── src/
│   ├── server.ts            # node:http server; /api/teams, /api/health; ack-fast discipline
│   ├── config.ts            # env + relay.json; fail-closed on missing pieces
│   ├── tenants.ts           # allowlist registry, tenant scope resolution
│   ├── conversations.ts     # binding store + route-back references (C2/C6)
│   ├── idempotency.ts       # duplicate-delivery store (C5)
│   ├── budgets.ts           # per-tenant caps, group-chat budget (C4), pre+mid-run guards
│   ├── botframework/
│   │   ├── verify.ts        # MS JWT checklist, no flags (C1)
│   │   ├── ingest.ts        # activity → RelayInbound; capture conversation references
│   │   └── send.ts          # proactive messages, adaptive cards (results, approvals, questions)
│   ├── signal/
│   │   ├── rpc.ts           # JSON-RPC over unix socket to the sidecar
│   │   └── ingest.ts        # envelope → RelayInbound; attachments (base64)
│   ├── runner/
│   │   ├── pool.ts          # slots, spawn, queue, crash handling
│   │   ├── entry.ts         # child entrypoint: assemble harness, run, persist, exit
│   │   ├── harness.ts       # builds tools/ToolContext/client/policy from tenant scope
│   │   ├── approvals.ts     # requestApproval impl: durable card + 1:1 round-trip
│   │   └── inputQueue.ts    # RunInput impl over durable queue
│   ├── runs/
│   │   ├── records.ts       # run records + transcript persistence (onProgress sink)
│   │   └── resume.ts        # startup scan; AUTO_RESUME policy reused from runMarkers semantics
│   └── compose.ts           # result → group post; working notes → 1:1; redaction before send
├── relay.json               # tenants, allowlists, caps (chmod 600)
├── package.json / lockfile
└── state/                   # git-ignored runtime state (layout above)
```

### Structure Rationale

- **`relay/` as a sibling workspace:** keeps the extension's tree untouched (its tsconfig/CI Node target stays 24); the relay is a separate build with its own lockfile (one dependency: `jose`). It imports extension sources via path references or a shared tsconfig path mapping — a build-phase task to pick; both modules stay node-only so either choice is mechanical.
- **`botframework/` + `signal/` as symmetric adapters:** both reduce to `RelayInbound` + a sender; everything downstream is channel-agnostic, which is what makes the C2 identity rules writable in one place.
- **`runner/` isolated:** the only folder that imports `src/agent/*`; reviewers of harness-assembly changes know exactly where to look.

## Architectural Patterns

### Pattern 1: Host-capability injection (already the repo's pattern — keep it)

**What:** the engine receives every side effect through options (`client`, `requestApproval`, `input`, `emit`, `ToolContext`).
**When:** any new host embedding (relay today; a CLI or service tomorrow).
**Trade-offs:** slightly wider option objects vs total freedom from the host SDK. Evidence it works at scale: loop.ts runs unmodified in tests and the extension alike.

### Pattern 2: Process-per-run with durable records (the Erlang-ish bit, done with files)

**What:** a run = a child process + a run record directory; crash of either leaves a consistent "started without ended" marker.
**When:** long (minutes–hours), unattended, externally-triggered work.
**Trade-offs:** process spawn cost per run (negligible vs an agent run) and slightly more IPC (one JSON handshake) vs surviving any crash and reusing the 12-hour resume machinery unchanged.

### Pattern 3: Ack-then-work ingress (webhook discipline)

**What:** verify → dedupe → persist → 202; all real work off the request path.
**When:** any channel that retries on slow HTTP (Teams does, ~15 s).
**Trade-offs:** an extra idempotency store — which you need anyway, because the retry happens even with fast acks (C5).

## Anti-Patterns

### Anti-Pattern 1: Importing `chat.ts` headlessly
**What people do:** "the orchestration exists, just call it without the webview."
**Why it's wrong:** `chat.ts:4` imports vscode; its message dispatch is a webview protocol (`:395–454`), its dialogs are UI (`:407–419`). Every usage drags the VS Code API into the relay.
**Do this instead:** re-implement the *decisions* (budget clamp shape, resume policy, attachment-to-project copying `:624–634`) against the existing node-only cores.

### Anti-Pattern 2: Running agent turns inside the relay process
**What people do:** start with an in-process `await run()` behind the webhook "for the MVP."
**Why it's wrong:** one tenant's runaway loop or one crash kills ingress for everyone; no slot accounting; restart logic gets tangled with live promises.
**Do this instead:** the runner pool, even if the MVP caps N=1.

### Anti-Pattern 3: Trusting text for identity or routing
**What people do:** parse "from NAME" or reply-to lines out of message bodies.
**Why it's wrong:** Microsoft explicitly warns not to derive user info from message text (PITFALLS C2, HIGH source); group text is attacker-writable (C3).
**Do this instead:** identity from verified activity claims / our own signal envelope only; routing from stored conversation references only.

## Scaling Considerations

| Scale | Architecture Adjustments |
|---|---|
| 1–5 tenants, ≤3 concurrent runs (the actual target) | Single relay process + pool of ≤3 runner children + one signal-cli sidecar; files on disk; monolith-plus-children is correct |
| ~10 tenants / ~10 concurrent | Raise pool caps, per-tenant slots become a real scheduler; move runner children into containers/OS users for hard isolation; consider a small SQLite for the idempotency/run indexes if file scans grow |
| Beyond | Split signal-cli and relay onto separate hosts (socket → TCP with mTLS), runner hosts become workers over a queue — none of this is needed at the scale the allowlist implies |

### Scaling Priorities

1. **First bottleneck:** concurrent runner CPU/memory (shell-heavy agents). Fix: slot caps per tenant (agentSession precedent) before any horizontal thinking.
2. **Second bottleneck:** signal-cli as a single-threaded JVM funnel. Fix: supervised restart + durable outbound queue; never inline Signal sends on the result path.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---|---|---|
| Bot Framework / Teams | HTTPS in (activities) + HTTPS out (proactive messages to `serviceUrl` with stored conversation references); JWT verified on every inbound | Ack ≤15 s; expect duplicates (C5); bot is owner's external app, no customer-org registration |
| NEAR AI | Existing `NearAiClient` (OpenAI-compatible streaming), per-tenant key + SpendSink tagging | Pricing/attestation/spend ledger behavior inherited unchanged |
| signal-cli | JSON-RPC over Unix socket, supervised sidecar | "No auth" surface confined by filesystem permissions; clients receive only post-connect messages (#799) |
| Open-GSD runtime | Passed to runner via `ToolContext.readOnlyRoots/trustedToolRoots/gsdRuntime` | Same trust model as the extension's auto mode (`tools.ts:24–29`) |

### Internal Boundaries

| Boundary | Communication | Notes |
|---|---|---|
| adapters ↔ relay core | `RelayInbound` value objects, in-process | Core never sees Teams/Signal types |
| relay core ↔ runner child | spawn + one JSON init payload; results via run record files + exit | No long-lived IPC to babysit |
| runner ↔ relay services (approvals, steering) | Files in `state/` + watcher notifications | Works across restarts by construction |
| runner ↔ model | Direct HTTPS from the child | Key never passes through relay core logging; child holds only its tenant's scope |

## Build order (Q8)

Dependency-respecting, aligned with the PITFALLS work areas; each step ends testable:

1. **Skeleton + secrets** (Secrets & ops): relay workspace, config, state dir layout, systemd/units — because every later step writes into `state/`.
2. **Inbound & auth**: Teams verifier + ack-fast + idempotency store, adversarial tests first (C1, C5). Nothing runs an agent yet.
3. **Identity & tenants**: tenant registry, conversation bindings, allowlist enforcement (C2, C6).
4. **Runner pool + first vertical slice** *(see below)*.
5. **Run lifecycle hardening**: approvals round-trip, steering queue, resume scan wired to startup (C7).
6. **Budget enforcement** (Spend & budget): per-tenant caps, group-chat budget (C4) — gated behind the slice, not before it, since caps need real run records to clamp.
7. **Result composition + group discipline** (Chat ingestion): fencing, result-only posts, 1:1 working notes (C3).
8. **Signal**: sidecar + adapter, reusing steps 3–7 wholesale (Signal integration).
9. **Hardening & release**: threat-model doc, regression gates, admin deployment guide (Teams integration: manifest/admin consent for the external app).

**First vertical slice (the one to build first and demo):** an allowlisted message in a **Teams 1:1** ("summarize this repo's README") → verified → bound → runner child runs a one-member team on the tenant workspace with the tenant key → result text posted back into the same 1:1, with the run record and marker written so a relay restart mid-run demonstrates auto-resume. 1:1 deliberately precedes groups: it sidesteps C3/C4 entirely, proves end-to-end (verification, tenancy, runner, key spend, durability) with the smallest surface, and everything after it is widening (groups, budgets, fencing, Signal) rather than re-architecting.

## Sources

- Repo (HIGH, read 2026-11-13): `src/agent/loop.ts` (:1–16 imports, :62–80 approvals, :85–99 events, :115–128 RunInput, :130–197 options, :296–304 run), `src/services/agentSession.ts` (imports, ~:400–424, ~:800–822, ~:1100–1120), `src/services/chat.ts` (:4, :395–454, :590–634), `src/services/nearAiClient.ts` (:1–8, :121–166, :290–297), `src/services/providerCache.ts` (:29–73), `src/services/runMarkers.ts` (:15–19, :108–113, :192–233), `src/agent/runActivity.ts` (:1–27), `src/agent/checkpoints.ts` (:10–21), `src/agent/tools.ts` (:1–38), `src/agent/teams.ts` (:1–189); grep inventory of `from 'vscode'` (30 files, none in `src/agent/`).
- Microsoft Bot Framework authentication checklist & Teams channel behavior (HIGH, learn.microsoft.com, fetched 2026-11-13; summarized in `.planning/research/PITFALLS.md` C1/C2).
- Teams ~15-second HTTP acknowledgement requirement (HIGH: https://stackoverflow.com/questions/77996603/teams-bot-timeout citing Bot Framework docs; corroborated https://stackoverflow.com/questions/68087552/can-i-change-the-http-response-timeout-in-botframework, fetched 2026-11-13).
- signal-cli daemon JSON-RPC over UNIX sockets, post-connect message delivery (HIGH: https://github.com/AsamK/signal-cli/discussions/799; project README https://github.com/AsamK/signal-cli, fetched 2026-11-13); JSON-RPC "no authentication nor authorization" caveat (MEDIUM: https://github.com/AsamK/signal-cli/discussions/679, via PITFALLS C2).
- Companion: `.planning/research/PITFALLS.md` (same research batch) for ranked pitfalls C1–C8 and work-area definitions.

---
*Architecture research for: owner-hosted multi-tenant messaging relay (Teams + Signal) over the existing NEAR AI agent harness*
*Researched: 2026-11-13*

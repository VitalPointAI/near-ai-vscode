# IronClaw and our agent teams: what to adopt, what to leave, and when

Prepared 2026-11-15 for the owner of NEAR AI for VS Code. Read-only research.

**How to read this.** Facts about IronClaw come from files I read in a shallow clone of `nearai/ironclaw` (default branch `main`, head `b0b999d`, 2026-09-10) and from the GitHub API. Paths below are relative to that repo unless they start with `src/`, `relay/` or `.planning/`, which are ours. Statements marked **(inference)** are my judgement, not something a source says. No IronClaw code was run.

---

## 1. Summary

- **IronClaw is NEAR AI's always-on personal and team assistant server**, written in Rust, a reimplementation of OpenClaw (TypeScript). It is a long-running service with a web UI, a REPL, an OpenAI-compatible API, Slack and Telegram channels, scheduled and event-driven routines, persistent memory, skills, sub-agents, MCP and WASM-sandboxed extensions. It is not an editor agent.
- **Its strongest ideas for us are architectural, not code**: a manifest per tool that declares effects, network egress and credential handles; credentials injected at the network boundary so tool code never sees them; approval, authorization and execution as separate stages; hooks that an agent can author only to *restrict* itself; and guardrails (token, tool-call, time and rate caps) attached to every unattended run.
- **Our relay (v0.7.0) overlaps IronClaw's channel layer only partly.** IronClaw 1.x ships Slack and Telegram; it has no Microsoft Teams channel and dropped Signal from its 1.0 line. Our relay's purpose (drive *our* team engine, under *our* approvals, privacy tiers and spend ledger, from Teams) is not something IronClaw provides. Recommendation: keep building the relay, borrow IronClaw's channel manifest shape and its two-step "operator configures, person pairs" setup, and add an optional bridge later rather than rebasing on IronClaw.
- **Do not adopt WASM tools as our extension format now.** MCP plus our markdown team, agent and skill files is the right surface for a TypeScript editor product. Mirror IronClaw's *capability manifest* instead (effects, egress, credential handles, default permission) as metadata on MCP servers and built-in tools, because that same manifest is what a DID policy gate needs to check.
- **Trust and governance fit is good in shape, absent in substance.** IronClaw uses NEAR only for NEAR AI Cloud sign-in (a NEP-413 wallet message) and as the default model provider. I found no DIDs, no NEAR accounts per agent and no on-chain policy anywhere in the code. Its capability grants, leases and trust ceilings are local and host-determined, so it cannot be the enforcement layer for our DID constraints as is, but its vocabulary (capability, grant, lease, effect, trust ceiling, monotonic restriction) maps cleanly onto DID-bound capabilities and is worth copying.
- **Forking IronClaw as our core is not recommended now** (section 7). It would mean porting our teams, Open-GSD, approvals, privacy tiers, attestation and spend ledger into about 1.4 million lines of Rust, breaking the zero-dependency VSIX or adding a service to install, and still writing a Teams channel. OpenShell-style out-of-process enforcement is engine-neutral and can wrap our relay and routine runs without a fork.
- **Sequencing with Theia:** build the agent-editor-agnostic parts (capability manifests, policy gate, guardrails, routines engine, relay) now in `src/agent`, `src/domain` and `relay/`, which already have zero `vscode` imports. Defer new UI-heavy surfaces until the Theia move is decided, and do not build anything on the VS Code chat participant API.

---

## 2. What IronClaw is

### 2.1 Identity, licence, maturity

| Item | Finding | Source |
|---|---|---|
| Purpose | "Your secure personal AI assistant, always on your side." Local-first, encrypted, "no telemetry". | `README.md` |
| Heritage | "IronClaw is a Rust reimplementation inspired by OpenClaw"; keeps a feature parity matrix against OpenClaw releases (last reviewed 2026-05-02). | `README.md` "OpenClaw Heritage"; `FEATURE_PARITY.md` |
| Language and runtime | Rust (toolchain pinned in `rust-toolchain.toml`, README says Rust 1.96+), tokio, wasmtime; web UI is a React/Vite SPA embedded in the binary (Node 22 to build). | `README.md`; `crates/product/ironclaw_webui/frontend/package.json` |
| Architecture | "Reborn" workspace: ten crate families (`app`, `contracts`, `domains`, `events`, `extensions`, `kernel`, `lanes`, `loop`, `product`, `substrates`) with architecture tests that enforce layer boundaries. | `AGENTS.md`, `crates/AGENTS.md` |
| Storage | libSQL (local profile) or PostgreSQL (server profiles). | `profiles/local.toml`; `AGENTS.md` "Persistence" |
| Licence | README: dual MIT or Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE` both present). GitHub's detector reports Apache-2.0. | `README.md` "License"; GitHub API |
| Popularity | 12,716 stars, 1,490 forks, 1,369 open issues, 202 open PRs; created 2026-02-03; about 114 contributors. | GitHub API, 2026-11-15 |
| Release cadence | Stable releases 1.0.0 (2026-07-27), 1.1.0 (08-06), 1.2.0 (08-13), 1.3.0 (08-19), 1.4.0 (08-28), 1.4.1 (09-29), each with release candidates. Roughly weekly in August, slower since. | GitHub releases API; `docs/changelog.mdx` |
| Activity signal | Last commit on `main` is 2026-09-10 although the repo was pushed to on 2026-11-09 (other branches). Two months without a `main` commit after a weekly cadence. **(inference)** Either work moved to a long-lived branch or the pace has dropped; worth asking NEAR AI directly before depending on it. | `git log`; GitHub API `pushed_at` |
| Engineering style | Very heavy process: typed contracts per crate, architecture tests, "LLM data is never deleted", test-first rules, CI contract scripts. Developed largely with coding agents (it ships `CLAUDE.md`, `.claude/skills/`, a codebase graph MCP). | `AGENTS.md`, `CLAUDE.md` |

### 2.2 Capabilities

**Agent loop and runs.** Inbound requests from any surface go through `ProductSurface`, thread and turn services, a scheduler and a run executor that invoke the canonical agent loop; capability execution crosses "authorization, approvals, obligations, host-runtime mediation, and the selected runtime lane" as distinct stages (`AGENTS.md` "Where work belongs", "Security and runtime invariants"). Jobs have a state machine (Pending, InProgress, Stuck, Completed, Failed) with self-repair of stuck jobs and `MAX_PARALLEL_JOBS` (default 5) (`docs/capabilities/jobs/jobs.mdx`). 1.3.0 added opt-in parallel tool batches and Anthropic prompt-cache breakpoints (`CHANGELOG.md`).

**Tools.** Built-in file tools, shell, web search, GitHub, Google Workspace, Notion, Slack, Telegram, memory, document editing (`.docx`, `.xlsx`, `.pptx`, PDF) and others, packaged as extensions under `crates/extensions/packages/` (github, gmail, google-*, mem0, memory-native, nearai-mcp, notion-mcp, slack, telegram, web-access, web-app). The shell tool is off unless `ALLOW_LOCAL_TOOLS=true`, scrubs credential-like environment variables, and blocks `;`, `&&`, `||`, `$()`, backticks and `..` traversal (`docs/extensions/shell.mdx`).

**Memory.** A path-addressed workspace with `memory_search` (hybrid full-text plus vector, Reciprocal Rank Fusion), `memory_write`, `memory_read`, `memory_tree` (`docs/capabilities/memory/memory.mdx`). Identity files `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md` are injected into every system prompt (`docs/capabilities/memory/identity.mdx`). 1.3.0 added ranked recall and an always-on `MEMORY.md` lane (`CHANGELOG.md`). A memory-curation hook runs after each turn (`crates/loop/ironclaw_hooks/README.md`).

**Skills.** `SKILL.md` files with frontmatter (`activation.keywords`, `patterns`, `tags`, `exclude_keywords`, `max_context_tokens`, `requires.bins/env`). A deterministic scorer (no LLM) picks skills per turn within a token budget. Two trust levels: user-placed skills are "Trusted" and the model can activate them; IronHub-installed skills are "Installed" and only activate on an explicit `$name` mention (`docs/capabilities/skills.mdx`). The repo ships skills such as `coding`, `delegation`, `qa-review`, `security-review`, `routine-advisor` (`skills/`).

**Sub-agents.** `builtin.spawn_subagent` with typed sub-agent kinds (for example `planner`, `coder`), `blocking` or `background` mode; background children deliver results later as tagged inputs. Defaults: max depth 1, at most 4 spawns per turn, 16 descendants per tree (`crates/loop/ironclaw_loop_host/src/subagent_spawn_port.rs`, `crates/loop/ironclaw_loop_host/prompts/spawn_subagent_description.md`). Background sub-agents shipped in 1.4.0 with "a derived cap on autonomous wakes" (`docs/changelog.mdx`). There is no multi-agent team concept: "Multi-agent routing" is not implemented (`FEATURE_PARITY.md` line 25). "Subagent spawn creates and wires child runs only" (`AGENTS.md`).

**Scheduling and autonomy.** Three mechanisms (`docs/capabilities/routines/*.mdx`):
- *Heartbeat*: every 30 minutes reads `HEARTBEAT.md` and runs it as a job; notifies a channel only when there is something actionable.
- *Cron routines*: created by the agent via `routine_create`, run as normal jobs, history via `routine_history`.
- *Reactive routines*: on events (`job.completed`, `job.failed`, `memory.write` with path filter, `routine.run`, `heartbeat`) or authenticated webhooks, with **guardrails**: `max_tokens`, `max_tool_calls`, `allowed_tools`, `timeout_secs`, `rate_limit`.
1.3.0 made scheduled triggers carry "a validated execution contract (prompt spec, execution policy, required skills) checked by a fail-closed preflight at creation" and a "no-result sentinel" so quiet runs stay quiet (`CHANGELOG.md`). 1.4.0 added "Run-now for automations" and a durable notification inbox for outcomes and pending approvals (`docs/changelog.mdx`).

**Channels.** Docs list Slack and Telegram for 1.x; "Discord, Signal, WeChat, and WeCom were available in IronClaw v1 and are not part of the 1.0 release" (`docs/channels/overview.mdx`). MS Teams is "not implemented" (`FEATURE_PARITY.md` line 94). A channel is a capability surface of an extension: a `[channel]` section in a `reborn.extension_manifest.v3` manifest plus a WASM component implementing `channel.wit` (`on_start`, `on_http_request`, `on_poll`, `on_respond`, `on_broadcast`, `on_status`), with ingress verification, egress allowlists and credential placeholders (`docs/channels/building-a-channel.mdx`). Setup is split: an operator saves deployment credentials once under Admin, then each person pairs their own account; the agent can drive only the personal half (`docs/channels/overview.mdx`). Telegram supports "linked devices" so the agent can read and act as the user (1.3.0, `CHANGELOG.md`).

**Models and providers.** Default provider is NEAR AI (`nearai`), default model `deepseek-ai/DeepSeek-V4-Flash` (`crates/domains/ironclaw_llm/src/nearai_chat.rs`), over the Chat Completions endpoint at `cloud-api.near.ai`, with API key or session token. More than twenty providers: Anthropic, OpenAI, Codex subscription, Gemini, Copilot, Bedrock, Ollama, OpenRouter, Groq, Tinfoil ("Hardware-attested TEE private inference") and any OpenAI-compatible endpoint (`docs/capabilities/llm-providers.md`, `crates/domains/ironclaw_llm/CONTRACT.md`). Admins publish a per-tenant model allowlist; users choose within it (`docs/capabilities/llm-providers.md`). A NEAR AI MCP extension reuses the NEAR AI LLM key for hosted tools such as web search at `https://private.near.ai/mcp` (`crates/extensions/packages/nearai-mcp/manifest.toml`).
  - **TEE.** I found no code that verifies NEAR AI Cloud attestation or response signatures: `grep -ri attestation` over `crates/**/*.rs` returns nothing. TEE appears only as Tinfoil's label. Our extension already does more here (section 3).

**Security model** (`README.md` "Security", `docs/security.mdx`, `docs/capabilities/sandboxed-tools.mdx`, `AGENTS.md`):
- WASM tools in wasmtime with fuel metering (default 100M instructions), 16 MB memory, per-tool rate limits, deny-by-default host imports (`crates/lanes/ironclaw_wasm/README.md`).
- Network egress only to declared hosts, enforced by a proxy before the TCP connection.
- Credentials declared by handle, stored encrypted (AES-256-GCM), injected into outgoing requests at the boundary; tool code "never sees the raw credential value"; leak scanning on requests and responses (15+ secret patterns).
- Prompt-injection layers: input validation, sanitizer, a policy engine with Block/Warn/Review/Sanitize, tool output wrapped in XML.
- MCP servers are "untrusted", HTTP(S) only: "The `stdio` transport is not supported ... because process-level egress controls have not landed yet" (`docs/extensions/mcp.mdx`).
- Docker sandbox for shell and coding work, now a persistent per-user container with a managed egress proxy (1.4.0).
- Approvals: durable approval requests and scoped authorization leases (`crates/kernel/ironclaw_approvals/src/lib.rs`). **Note:** the per-user "auto-approve eligible tools" toggle defaults to **on** (`AUTO_APPROVE_DEFAULT_ENABLED: bool = true`, `crates/kernel/ironclaw_approvals/src/auto_approve.rs`), with a hard floor of never-auto-approve effects and explicit overrides above it.
- Trust: `TrustClass` is "host-determined rather than manifest-asserted"; a manifest can request a trust class but policy decides the effective ceiling (`crates/kernel/ironclaw_trust/CONTRACT.md`).
- Hooks: four trust classes (builtin, trusted, installed, self-authored); "A hook cannot grant authority"; gate decisions fail closed; **self-authored hooks are monotonic-restriction only** (deny, pause for approval, pause for auth, pass), use a closed reason vocabulary, and are run-scoped (`crates/loop/ironclaw_hooks/README.md`, `crates/loop/ironclaw_hooks/src/self_authored.rs`).

**Plugin and extension system.** One product object, the *extension*, with surfaces `tool`, `channel`, `auth`; runtime is `wasm`, `mcp` or `first_party` (`AGENTS.md` "Extension/Auth Invariants"). Each tool in a manifest declares `effects` (for example `network`, `use_secret`, `external_write`), `default_permission` (`allow` or `ask`), an `origin_gate_matrix` (whether it may run in a loop run, a product call or an automation), input schema and prompt doc, and credential handles with audience host and injection shape (`crates/extensions/packages/github/manifest.toml`). WIT interfaces are `package near:agent@0.4.1` (`crates/lanes/ironclaw_wasm/wit/tool.wit`). Lifecycle is explicit: discovery has no side effects; install, credential binding, activation, execution, deactivation, removal are separate transitions. Distribution is through IronHub (`hub.ironclaw.com`), where every entry is signed and carries a provenance tier (Official, Trusted, Verified, Private, New); "New" entries need operator acknowledgement and "the agent cannot install these autonomously" (`docs/hub/overview.mdx`). `extension install` takes only a registry id, never a path or URL (`docs/capabilities/sandboxed-tools.mdx`).
  - The README's "Dynamic Tool Building: describe what you need, and IronClaw builds it as a WASM tool" is a v1-era claim; I found no tool-builder in the Reborn crates. **(inference)** Treat it as not current.
  - Some docs are stale relative to code (for example `capabilities.json` in `sandboxed-tools.mdx` versus `manifest.toml` v3 everywhere else).

**UI surfaces.** Web UI (`ironclaw serve`, loopback by default): Chat with inline tool calls and approvals, Workspace (memory browser), Automations, Extensions, Settings, Admin; Google or GitHub SSO; a `?debug=true` inspector showing the assembled prompt, activity and stats (`docs/using/webui.mdx`). Also a ratatui TUI and REPL, `ironclaw run -m`, and an OpenAI-compatible **Responses API** (`POST /api/v1/responses`) that "routes through the full agent loop" with tools, memory and server-side conversation state, plus a raw `/v1/chat/completions` proxy (`docs/api/responses.mdx`). There is no IDE integration (no VS Code, Theia or ACP surface; ACP rows in `FEATURE_PARITY.md` are not implemented).

### 2.3 How IronClaw differs from Hermes Agent (brief, not researched in depth)

**(inference, from general knowledge; the Hermes analysis is separate.)** Hermes Agent (Nous Research) is a Python agent focused on a self-improving loop: it writes and refines its own skills from experience and runs across many messaging platforms. IronClaw is a Rust server whose emphasis is the opposite: hard isolation and governance (WASM lanes, egress proxy, host-side credentials, typed approval stages, signed registry, restrict-only self-authored hooks), multi-tenant operation with SSO and admin, and NEAR AI as the default provider. If Hermes is the "learns and adapts" reference, IronClaw is the "contain and govern" reference.

---

## 3. Our agent teams today, compared

Read from `origin/main` (0.4.22) unless noted.

| Area | IronClaw | Our extension | Gap |
|---|---|---|---|
| Unit of work | One assistant per user; sub-agents by kind (planner, coder); no teams. | **Teams** as markdown (`src/agent/teams.ts`, `teamMarkdown.ts`): `## member` sections with `role:`, `model:`, `tools:`, `reports-to:`, `privacy:`; a lead delegates to members as sub-agents; hierarchy drawing and member cards (`teamGraph.ts`); Team Studio (`media/teams`); team templates per project type with red-team and release gates; Update Team merges built-in role changes; Open-GSD workflows (`src/gsd/`). | We are well ahead on structured teams and workflow. Nothing to copy here. |
| Sub-agent limits | Depth 1, 4 spawns per turn, 16 per tree, background mode with a wake cap. | Parallel and background sub-agents with Pause/Resume/Stop and activity rows; loop guard; turn limit; per-run cost budget (`src/agent/loop.ts`, README "Sub-agents you can see and steer"). | Small: explicit tree-size caps as data. |
| Approvals | Durable approval records, scoped leases, per-tool `default_permission`, effects, auto-approve **on by default** above a hard floor. | Four policy modes (`src/domain/policy.ts`), command classifier and allow rules (`src/agent/permissions.ts`, `commandSafety.ts`), private-TEE safety model for undecided commands, risk sentence on every card, unattended sub-agent rules (`src/agent/unattended.ts`), protected paths, run-level revert. Default `approve-risky`. | We are stricter and more explained. Gap: approvals are run-scoped in memory, not durable records that survive to a notification inbox or a relay. |
| Tool metadata | Per-tool manifest: effects, egress hosts, credential handles, origin matrix, default permission. | Built-in tools mapped to `ActionCapability` (`read`, `plan`, `workspaceWrite`, `sharedWrite`, `shell`, `network`, `gitMutation`, ...); MCP tools named `mcp__server__tool`, read-only versus "can change data", per-server Trusted flag (README "MCP connections"). | **Main gap.** No declared egress or credential audience per tool; MCP effects are inferred, not declared. |
| Credentials | Host-side store; injected at the egress proxy; tool code never sees them; leak scan both directions. | SecretStorage; credential-like env vars kept out of shells; credential files ask first; outbound check holds secrets back before sending to the model (SECURITY "The outbound check"). MCP header and env values are handed to the server process or headers directly. | Medium: no boundary injection for MCP or for future tools; a local stdio MCP server receives its secret in its environment. |
| MCP | HTTP only; stdio refused until egress controls exist. | stdio and Streamable HTTP with SSE fallback (`src/mcp/client.ts`); off until switched on per project; scoped to members by `mcp:<server>` in `tools:`. | Decision point: we accept stdio servers that run with the user's full OS authority. |
| Skills | Deterministic activation scoring, token budget, trusted versus installed. | Open-GSD skills and agents discovered generically (`src/gsd/library.ts`), invoked by `/name`; Tools directory lists them. | Small: no automatic, budgeted skill activation; no trust tier for third-party skills. |
| Memory | Workspace docs, hybrid search, identity files, after-turn curation hook. | Remember/Recall, team knowledge graph (`contextGraphMemory.ts`), `AGENTS.md` per project, encrypted transcripts. | Comparable. Their always-on curation is a possible later idea. |
| Scheduling and autonomy | Heartbeat, cron and reactive routines with guardrails, run-now, quiet-unless-actionable, notification inbox. | None. Runs start from a person in the chat. Auto-resume of interrupted runs within limits (`src/services/runMarkers.ts`). | **Real gap**, and the main "more autonomous" lever. |
| Channels | Slack, Telegram (Signal, Discord in v1 only). | v0.7.0 relay in progress (`relay/` on `feat/messaging-relay`): Teams first, then Signal and Telegram; Node 26, `node:sqlite`, distroless container; adversarial inbound tests before any happy path. | Different scope; see 4(a). |
| Privacy and TEE | NEAR AI default provider; no attestation verification found. | Every model labelled TEE, local or forwarded; `tee-only` mode; `privacy: private` per team member; **per-response signature and TDX quote verification** (`src/services/attestation.ts`, SECURITY "Checking a response's signature"). | We lead. Note: README "Good to know" still says the extension "does not yet verify NEAR's per-response attestation signatures itself", which contradicts SECURITY.md and `attestation.ts`; worth fixing. |
| Spend | Per-routine `max_tokens`; tenant model allowlists. | Per-key spend ledger reconciled with NEAR billing, run cost budget, daily limit, Compare Models leaderboard. | We lead. |
| UI | Web app with debug inspector and Automations page. | Native editor panels: chat with tabs, Agent Activity, Team Studio, Tools directory, Compare Models, Run Performance Report. | We lead in the editor; they have an Automations page we would need if we add routines. |

---

## 4. Recommendations

Ordered by value for effort. Sizes: S (days), M (one to two weeks), L (several weeks), XL (a milestone).

### R1. Capability manifest for every tool and MCP server (High value, M)

- **IronClaw:** each tool declares `effects`, `default_permission`, egress hosts, credential handles with audience, and where it may run (`origin_gate_matrix`) (`crates/extensions/packages/github/manifest.toml`).
- **Today:** built-in tools map to `ActionCapability`; MCP tools are classified read-only or changing at call time; trust is a per-server flag.
- **Gap:** what a tool can reach is not declared data, so neither the approval card, the team member card, nor a future DID policy can reason about it ahead of time.
- **Design:** a small typed `ToolCapability` record in `src/domain/` for every built-in tool (generated from the existing mapping) and an optional `capabilities` block per MCP server in its connection settings: effects (`read`, `workspaceWrite`, `network`, `externalWrite`, `useSecret`, `shell`), allowed hosts, credential handle names, allowed contexts (`interactive`, `unattended`, `relay`, `routine`). Unknown MCP tools default to the most restrictive effects. Team member cards and the Tools page show it in plain words. The policy gate (`src/agent/permissions.ts`) consumes it.
- **Risks:** a declaration is a claim for third-party MCP servers; it narrows what we allow, it does not prove what the server does. Say so on the card.
- **Why first:** R2, R4, R5 and the DID work all need this vocabulary.

### R2. Guardrails and an execution contract for every unattended run (High value, S to M)

- **IronClaw:** reactive routines carry `max_tokens`, `max_tool_calls`, `allowed_tools`, `timeout_secs`, `rate_limit`; scheduled runs carry a validated contract checked by a fail-closed preflight; a no-result sentinel keeps quiet runs quiet (`docs/capabilities/routines/reactive.mdx`, `CHANGELOG.md` 1.3.0).
- **Today:** cost budget and turn limit per run, loop guard, unattended sub-agent rules.
- **Design:** one `RunContract` type in `src/domain/` (allowed capabilities from R1, cost cap, tool-call cap, wall-clock cap, max sub-agent tree, whether approvals may wait or must fail) required for any run that no person started from the chat: relay runs, routines (R3), background sub-agents. Preflight refuses a contract that grants more than its creator holds. The relay's budgets (Phase 72) and lifecycle (Phase 73) should use the same type.
- **Risks:** low; this only narrows.

### R3. Routines: scheduled and event-triggered team runs (High value for autonomy, L)

- **IronClaw:** heartbeat file, cron routines, reactive routines on events and webhooks, run-now, notification inbox (section 2.2).
- **Today:** none.
- **Design:** routines live in the project as markdown (`.planning/.near-ai/routines/*.md`: team, schedule or trigger, task, `RunContract` from R2), edited like team files, versioned, visible on a Routines tab in Team Studio with Run now, history and next run. In the editor they run only while VS Code or code-server is open (honest about that). Headless execution belongs to the relay host (R6), which already has a durable queue and run registry. Approvals that arrive while nobody is watching go to a durable inbox (in the editor: the waiting badge; through the relay: the requester's private chat, as Phase 73 plans), and expire to *deny*, never to allow.
- **Risks:** autonomy plus outside content is the classic injection path. Routine runs should default to `approve-risky` semantics for anything outside their contract, default to private models, and never auto-approve network or external writes. Rate-limit triggers.
- **Sequence:** after R1 and R2, and after relay Phase 73 if headless.

### R4. Credential handles injected at the boundary (Medium-high value, M)

- **IronClaw:** tools name a credential handle; the host injects it into allowed requests only; responses are leak-scanned (`docs/security.mdx`).
- **Today:** SecretStorage plus env scrubbing; MCP secrets go to the server as headers or environment.
- **Design:** for remote MCP and our own network tools (web search, fetch), keep doing what we do (headers set by the extension, never visible to the model) but bind each secret to an audience host from R1 and refuse to send it anywhere else. Add a response-side scan for our known secret formats before tool output reaches the model (we already scan outbound). For stdio MCP, see R7.
- **Risks:** low; the main cost is migration of existing connection settings.

### R5. Restrict-only self-authored rules (Medium value, S)

- **IronClaw:** an agent may add hooks for the current run that can only deny or pause, from a closed vocabulary (`crates/loop/ironclaw_hooks/src/self_authored.rs`).
- **Today:** the lead cannot narrow a member's permissions at delegation time except by the member's `tools:` line.
- **Design:** let a lead (or orchestrator) pass a *narrower* capability set when it delegates: a subset of the member's `tools:` and effects for this task. Enforce subset-only in code. This is exactly delegation attenuation (section 5).
- **Risks:** none if the subset rule is enforced in the gate, not in the prompt.

### R6. Relay: keep it, borrow from IronClaw, bridge later (see 4(a)) (High value, already planned)

Concrete borrowings for Phases 69 to 76:
- Channel as a manifest-declared surface: ingress verification kind, body limit, egress host allowlist, credential handle and injection (`docs/channels/building-a-channel.mdx` step 6). Use the same shape for Teams, Signal and Telegram adapters so a fourth channel is data plus one adapter.
- The two-step setup: operator configures the deployment once; each person pairs their account; the agent may drive only the personal half (`docs/channels/overview.mdx`). This fits Phase 71.1 (Messaging setup view) and Phase 70 (requester identity).
- Durable notification inbox for outcomes and pending approvals (1.4.0).
- Do not copy "linked devices" (agent reads and acts as the person's Telegram account): too much authority for a team bot.

### R7. Tighten local MCP servers (Medium value, S to M)

- **IronClaw:** refuses stdio MCP because it cannot control a local process's egress (`docs/extensions/mcp.mdx`).
- **Today:** we allow stdio servers (off until switched on, minimal environment).
- **Design:** keep stdio (users need it), but label stdio servers on the card and Tools page as "runs on this machine with your permissions; NEAR AI cannot limit what it reaches", require the Trusted decision to be explicit for them, and never let them run in unattended or relay contexts unless the routine contract names them. Later, offer to run a stdio server inside the cyber harness container or VM tier for isolation.

### R8. Budgeted skill activation and skill trust tiers (Low-medium value, M)

- **IronClaw:** deterministic keyword and pattern scoring within a token budget; installed skills cannot be model-activated (`docs/capabilities/skills.mdx`).
- **Design:** if we accept third-party skills or a registry later, adopt the two tiers (project or user placed: model may load; installed: explicit `/name` only) and show provenance. Automatic activation is optional; our `/name` model already works.

### R9. A debug view of the assembled prompt (Low value, S)

IronClaw's `?debug=true` inspector shows the prompt components, active skills, model and context use (`docs/using/webui.mdx`). Our Export details covers most of this; a "what was sent" view on a run row in Agent Activity would help support. Optional.

### What we should NOT copy

- **Auto-approve on by default.** IronClaw ships `AUTO_APPROVE_DEFAULT_ENABLED = true`. Our default `approve-risky` with explained cards is the right product choice for people who did not write the tools.
- **WASM as the tool format for our users.** It needs Rust or a WASM toolchain, a WIT ABI and a signed registry; it fits a server, not an editor extension whose users are researchers, presales staff and writers. See 4(b).
- **Agent-authored tools or durable self-modification.** The README's "build new tools on the fly" is the opposite of "an agent can never grant itself more authority". Even IronClaw keeps self-authored hooks restrict-only and run-scoped.
- **Acting as the user's personal messaging account** (Telegram linked devices) and reading personal mail and calendars by default.
- **Their storage and multi-tenant web app.** PostgreSQL, SSO and admin pages duplicate what our relay and Team Mode plan in a different shape.
- **Shell injection pattern blocking as the main defence.** Blocking `;` and `&&` is brittle; our per-part classification plus private safety model is better.

### 4(a). Does the relay duplicate IronClaw?

Partly, and less than it seems.

| Question | Answer |
|---|---|
| Does IronClaw have our channels? | Telegram yes; Signal only in v1 (not in 1.x); **MS Teams no** (`FEATURE_PARITY.md` line 94; `docs/channels/overview.mdx`). Our first and most important channel is missing. |
| Does it run *our* teams? | No. It runs its own single assistant with sub-agents. Our teams, Open-GSD workflows, red-team gates, privacy-per-member, spend ledger and approvals are in `src/agent` and `src/services`. Running them inside IronClaw would mean reimplementing them in Rust or calling out to us. |
| Could we interoperate? | Yes, two ways. (1) IronClaw's Responses API (`/api/v1/responses`) lets our relay or extension call an IronClaw instance as an *external member* (for example a member that reads the person's Gmail through IronClaw's Google extensions) under a per-user token. (2) Our relay could expose an OpenAI-compatible or MCP endpoint so an IronClaw user can call a NEAR AI team as a tool. Both keep each product's trust boundary intact. |
| Should we rebase the relay on IronClaw? | **No (inference).** It would trade a small Node service that composes our engine unchanged (`relay/` plan: "composing the existing agent engine ... with the extension itself not modified") for a large Rust platform with its own model, approval and storage semantics, a different language from our codebase, and a `main` branch that has not moved since September. Re-evaluate if NEAR AI commits to IronClaw as the org-wide agent host and adds Teams. |

### 4(b). WASM sandbox model versus MCP plus markdown

- **Use MCP plus our markdown team, agent and skill files** as the extension surface. It is what our users can author, what Theia AI also uses (section 6), and what the MCP ecosystem provides.
- **Mirror the manifest, not the runtime.** The valuable part of IronClaw's model is that every tool's authority is declared, host-validated and enforced at one gate (R1, R4). That is runtime-independent.
- **Isolation where it matters:** for code the agent runs (shell, scripts, untrusted MCP servers, cyber testing), our planned container and microVM tiers are the right boundary. WASM is a good fit for small deterministic tools; if we ever ship third-party executable tools, a WASM lane (wasmtime from Node, or the WASI support in Node) could be a later option. Not now.

### 4(c). NEAR-specific advantages we could share

- **Same provider.** Both default to NEAR AI Cloud. Our model catalog privacy labels, `tee-only` mode and per-response attestation verification (`src/services/attestation.ts`) are things IronClaw lacks; offering them upstream (or a shared small verifier library) would strengthen both. **(inference)**
- **Credentials.** IronClaw's NEAR AI MCP extension reuses the LLM key for `private.near.ai/mcp` hosted tools (web search). We could offer the same: NEAR's hosted web search through the user's existing key, as one more search provider that needs no extra account.
- **Sign-in.** IronClaw signs in to NEAR AI Cloud with a NEAR wallet (NEP-413 message "Sign in to NEAR AI Cloud", recipient `cloud.near.ai`) (`crates/product/ironclaw_webui/frontend/src/wallet-connect.ts`). Our README says wallet sign-in waits for a documented NEAR AI contract; IronClaw's file is a working reference for that flow, and the same account could anchor agent DIDs (section 5).

---

## 5. Trust and governance fit

The owner's target (`.planning/PROJECT.md` on `origin/main`, "Verifiable agent guardrails"): every agent gets a NEAR implicit account and a W3C DID carrying its constraints; an agent acts only within its DID and never grants itself more than it was created with or delegated; only the orchestrator changes a DID, with authority delegated by a person; DIDs are stored with NEAR confidential intents and authorization policies are immutable contracts that gate each action. It builds on signed events and device identities (`src/team/` on the Team Mode branches, for example `feat/team-fix-pass`), the role-by-action matrix (`src/domain/team/permissions.ts` on the same branch), and `src/agent/permissions.ts` and `src/domain/policy.ts` on `main`.

### 5.1 Does IronClaw already use NEAR accounts, DIDs or on-chain policy?

No. What I found:
- NEAR wallet use is limited to signing in to NEAR AI Cloud (`wallet-connect.ts`, `crates/domains/ironclaw_llm/src/session.rs`).
- No `did:` identifiers, verifiable credentials, implicit accounts or contract calls in `crates/**/*.rs` (searched for `did:`, `implicit account`, `verifiable credential`, `NearAccountId`).
- Identities are local typed ids (tenant, user, thread, run) and trust is evaluated from local layered policy sources (`crates/kernel/ironclaw_trust/CONTRACT.md`). `crates/product/ironclaw_assistant/AGENTS.md` notes that "attested approvals require a separate service shape with canonical payload attestation", which is acknowledged future work, not an implementation.

So IronClaw **cannot be the enforcement layer for our DID constraints as is**. Its design is, however, close to what such a layer needs, and its vocabulary is worth adopting.

### 5.2 Mapping IronClaw's model onto DID-bound capabilities

| IronClaw concept | DID equivalent | Fit |
|---|---|---|
| Tool `effects`, egress hosts, credential audience (manifest) | The capability catalogue a DID's constraints refer to | Good: makes a DID constraint checkable ("may use `network` to `api.github.com` with handle `github`"). This is R1. |
| `TrustClass` host-determined, manifest can only request | DID constraints set by the orchestrator, never by the agent | Good: same principle. |
| Capability grant plus scoped lease | A short-lived authorization derived from the DID for one run or action | Good: leases are the right unit to check against an on-chain policy and cache locally. |
| Approval, authorization, dispatch as separate stages | Policy gate (contract) before execution; person approval as a separate signed event | Good: keeps "the contract says allowed" distinct from "a person said yes". |
| Self-authored hooks: restrict-only, closed vocabulary | An agent may narrow its own DID for a task, never widen | Exact match to "never grant itself more authority". |
| Sub-agent depth and tree caps | Delegation depth limit in the DID | Good. |
| Auto-approve default on | None | Conflicts; do not copy. |

### 5.3 Per recommendation: gateable, escalation risk, delegation and audit

| Rec | Expressible as DID-bound capability and checkable before running? | Escalation or bypass risk | Delegation attenuation and audit |
|---|---|---|---|
| R1 manifest | Yes; it *is* the vocabulary. | A third-party MCP server can lie about its effects. Mitigate: the gate trusts the declaration only to *restrict*; undeclared means most restrictive; the orchestrator, not the server, writes the effective capability into the DID. | Each delegated DID lists a subset of the parent's capabilities by id. |
| R2 run contract | Yes; a contract is a DID-scoped grant for one run (caps, allowed capabilities, contexts). | A contract must be a subset of its creator's DID; preflight refuses otherwise. | Contract hash recorded in the signed event log with the issuer's DID. |
| R3 routines | Yes, if a routine carries its own contract and runs under a routine DID delegated by the person who created it. | Highest risk: unattended plus outside content. A routine must never edit its own contract or create routines; only the orchestrator with a person's delegation can. Triggers cannot raise authority. | Person to orchestrator to routine DID to sub-agent DIDs; each hop subset-only; every run's events signed with the acting DID. |
| R4 credential handles | Yes; "may use credential handle X for audience Y" is a natural DID constraint, and the agent never holds the secret, so a DID cannot be used to exfiltrate it. | Low. A compromised tool cannot read the store; it can only make requests the gate allows. | Handle use logged per call with the DID that used it. |
| R5 restrict-only rules | Yes; this is delegation attenuation. | None if enforced in code as a subset check. | Natural audit point: each narrowing is an event. |
| R6 relay channels | Partly. Inbound identity binds to a requester (Phase 70), whose delegation must reach the orchestrator; the bot itself needs a DID. | Group text is untrusted; it must never change a DID or contract (Phase 74 already treats it as untrusted). | Requester identity to tenant DID to team orchestrator; replies signed. |
| R7 local MCP | Only weakly: a stdio server is a process with the user's OS rights, so a DID gate can decide whether to *call* it but cannot bound what it does. | Real bypass risk: any local process can reach the network. Only isolation (container or VM) makes its actions gateable. | Record calls; mark the DID capability as "unbounded local process". |
| IronClaw WASM tools | Yes in principle: deny-by-default imports plus declared capabilities are the easiest runtime to gate per call. | Low for the tool; the registry and install path are where escalation happens. | Only if install requires orchestrator plus person delegation. |
| Agent-built tools (IronClaw README v1 claim) | No. A tool written by an agent has authority the agent chose. | Direct self-escalation. | Do not adopt. |

### 5.4 Implications for the tool-system recommendation

- The DID plan **strengthens R1 and weakens any case for WASM now**: what the DID gate needs is a declared, host-validated capability per tool and a single gate every call passes through, which we can build on MCP plus built-in tools.
- **One gate, no side doors.** IronClaw's rule that product handlers, triggers, channels and agent callers "go through `ProductSurface` and the capability contracts, never around them" (`AGENTS.md`) is the property to copy. In our terms: every tool call (built-in, MCP, relay, routine, sub-agent) must pass `decidePermission` in `src/agent/permissions.ts`, extended with a DID check, and there must be no other execution path. A test that enumerates tool registrations and proves each is gated is cheap and valuable.
- **Tool loading must not bypass the gate.** Adding an MCP server, a skill or a routine changes what agents can do, so it is itself a governed action: allowed only to the orchestrator under a person's delegation, recorded as a signed event, never available as a tool to a member agent. IronClaw's equivalent is "New" registry entries that "the agent cannot install autonomously".
- **Offline behaviour.** Since the chain may be unreachable, the gate should check a locally cached, signed copy of the DID and policy (like IronClaw's leases), fail closed for anything not covered by the cache, and refresh when online. This is an open question in PROJECT.md; IronClaw's lease model is a reasonable answer.

---

## 6. Before or after the move to Eclipse Theia?

### 6.1 What Theia offers now

- **Theia AI** is "an open-source, vendor-neutral AI harness platform" for tool builders: agents as injectable services (TypeScript, `AbstractStreamParsingChatAgent`), prompt fragments and `.prompttemplate` files, variables, tool functions via `ToolProvider`, slash commands, OpenAI-compatible and Ollama providers, MCP, Agent Skills and plugins; Theia Coder is its coding agent; Claude Code is listed among built-in agents ([theia-ide.org/docs/theia_ai](https://theia-ide.org/docs/theia_ai/), last updated 2026-10-12).
- **Theia 1.75** (2026-09-10): Agent Plugins bundling skills and MCP servers, installed hash-verified into `~/.agents/plugins/`; an opt-in workspace memory wiki under `.agents/memory/`; MCP Apps rendering interactive tool UIs in a sandboxed iframe; a unified AI Configuration view; file-change awareness that stops agents overwriting files changed since they read them; VS Code API compatibility raised to 1.134.0 ([EclipseSource 1.75 notes](https://eclipsesource.com/blogs/2026/09/10/eclipse-theia-1-75-release-news-and-noteworthy/)).
- **Theia 1.73 and 1.76**: an AI registry for MCP servers and skills, OAuth 2.1 for remote MCP; 1.76 (2026-10-08) adds Copilot subscription support and new AI session APIs (search results summarising [EclipseSource](https://eclipsesource.com/blogs/2026/07/07/eclipse-theia-1-73-release-news-and-noteworthy/) and the [Eclipse newsroom](https://newsroom.eclipse.org/tags/theia)).
- **VS Code extensions** install from Open VSX; each Theia version supports the VS Code API up to a stated version, with "a few parts ... only stubbed" ([Installing VS Code extensions](https://theia-ide.org/docs/user_install_vscode_extensions/)). I could not confirm from current docs whether VS Code's chat participant API works in Theia; Theia's equivalent concept is a custom agent ([vogella comparison](https://vogella.com/blog/vscode_copilot_theia_ai_comparison/)). **(inference)** Treat `@nearai` as not portable.

### 6.2 What ports for free and what does not

| Layer | Where | Portability |
|---|---|---|
| Agent loop, tools, teams, team markdown, team graph, permissions, safety model, unattended rules, attestation | `src/agent/` (47 files, 0 import `vscode`), `src/domain/` (55, 0), `src/gsd/` (7, 0), `src/mcp/` (2, 0) | Ports as is: plain Node/TypeScript. Theia's backend is Node, so it can host them directly. |
| Services | `src/services/` (126 files, 28 import `vscode`: SecretStorage, settings, notifications, chat view host) | Port with an adapter layer: secrets, settings, workspace paths, notifications. |
| Relay | `relay/` | Fully independent of any editor. |
| Webview UIs | `media/chat`, `media/teams`, `media/activity`, `media/compare`, `media/tools`, ... | Run in Theia through its VS Code webview compatibility, or are rebuilt as Theia widgets. Either way this is the UI work that would be done twice. |
| `@nearai` chat participant, secondary side bar contribution | `package.json` `chatParticipants`, `viewsContainers.secondarySidebar` | VS Code specific; likely needs a Theia AI custom agent instead. |
| Markdown team, agent, skill, routine files | project and home folders | Editor-agnostic. They also line up with Theia's prompt templates, skills and `.agents/` conventions. |

### 6.3 Recommended sequencing

1. **Now, before the move (editor-agnostic, ports for free):** R1 capability manifest, R2 run contract, R5 restrict-only delegation, R4 credential audience binding, and the single-gate test. Put all of them in `src/domain` and `src/agent`. These are also the foundation for the DID work and for the relay.
2. **Now, in the relay:** continue v0.7.0; adopt R6 borrowings. The relay is the headless host for routines later, independent of the editor.
3. **Routines engine (R3) logic now, routines UI later:** build the routine file format, scheduler and contract checks in `src/domain` and the relay; add only a minimal list in the current UI. Build the full Automations surface once, in Theia.
4. **After the move:** UI-heavy additions (Automations page, prompt debug view, any MCP Apps style interactive tool output), and the decision whether to expose our teams as Theia AI agents alongside the webview chat. Use Theia's own MCP registry, Agent Plugins and file-change awareness rather than duplicating them, but keep our policy gate in front of every tool, including Theia-provided ones; Theia's tool confirmation is not a DID gate. **(inference)**
5. **Interoperation with IronClaw (optional, any time after R1):** an "external member" adapter that calls an IronClaw Responses API endpoint, gated like any other networked tool.

---

## 7. Option: fork IronClaw as our core

The owner's current leaning is to fork IronClaw, add Hermes Agent improvements and NVIDIA OpenShell enforcement to the fork, and integrate it with our product. This section evaluates that option on its merits.

### 7.1 What "integrate" could concretely mean

| Shape | What it means | Feasibility |
|---|---|---|
| **A. Replace our TypeScript loop inside the extension** | The extension calls IronClaw's Rust loop in-process (native addon) or ships the `ironclaw` binary per platform and drives it. | Poor. IronClaw is about 1.38 million lines of Rust in 2,030 files across 61 crates (counted in the clone), built with Rust 1.96+, Postgres or libSQL, wasmtime. Our VSIX has zero runtime dependencies and our whole `src/` (excluding tests) is about 54,000 lines of TypeScript. We would ship per-OS binaries (Linux, macOS, Windows, arm64 and x64) for a 25x larger engine, and lose the "one bundle, no native code" property. |
| **B. IronClaw as an out-of-process engine** | Run `ironclaw serve` as a local service (or on the relay host); the extension and relay become clients of its Responses API and WebUI APIs. | Technically workable: the Responses API "routes through the full agent loop" (`docs/api/responses.mdx`). But everything our product is made of lives in our layer and has no counterpart there (table 7.2). The extension would become a thin UI over an engine that does not know about teams, privacy tiers or our approvals. |
| **C. IronClaw only behind the relay** | Replace relay Phases 69 to 76 with an IronClaw deployment and its channels. | Partial fit. IronClaw has Slack and Telegram; it has **no Microsoft Teams channel** and no Signal in 1.x (`docs/channels/overview.mdx`, `FEATURE_PARITY.md` line 94). Teams, our first channel, would have to be written as a Rust/WASM channel component. And the relay's job is to run *our* teams, which IronClaw does not have. |

### 7.2 What happens to what we have

| Our asset | Under a fork (shape B or C) |
|---|---|
| Teams format (`## member`, `role`, `model`, `tools`, `reports-to`, `privacy`), lead delegation, Team Studio, Update Team | No equivalent. IronClaw has typed sub-agent kinds, depth 1 by default, and "Multi-agent routing" not implemented. Reimplement in Rust, or keep running teams in our TypeScript and use IronClaw only for tools, which defeats the purpose. |
| Open-GSD workflows and skills (`src/gsd/`) | IronClaw skills are `SKILL.md` with activation scoring; Open-GSD's Claude-runtime skills, agents, `@` includes and workflow semantics would need a port. |
| Approvals: four modes, command classifier, private safety model, risk sentences, unattended rules, protected paths, revert | IronClaw has a different model (per-tool `default_permission`, auto-approve on by default, durable records). Ours would be rebuilt as hooks and authorizer policy in Rust, or lost. |
| Spend ledger reconciled with NEAR billing, run budgets, daily limit, Compare Models | IronClaw records token usage and has per-routine `max_tokens`; the NEAR billing reconciliation, estimates and leaderboard would be rebuilt. |
| Privacy tiers, `tee-only`, `privacy: private` per member, attestation verification | Not present in IronClaw (no attestation code found). Rebuilt in the fork. |
| Encrypted transcripts, project state sync, Team Mode signed events | Different storage model ("LLM data is never deleted", Postgres/libSQL). Reconciling with our encrypted git-based sync is a design project of its own. |
| Editor UI (chat tabs, Agent Activity, Team Studio, Tools, Compare) | Stays TypeScript, but now talks to a remote engine with different events; most panels need new data plumbing. |

In short, a fork does not replace our product with IronClaw; it means **porting most of our product into IronClaw** and then maintaining that port.

### 7.3 Fork maintenance

- **Licence:** MIT or Apache-2.0; forking is allowed and simple.
- **Upstream pace and process:** about 114 contributors, PR numbers above 8,000 in seven months, weekly stable releases in August, strict architecture tests, per-crate contracts and CI contract scripts (`AGENTS.md`). A fork that changes approvals, teams, storage and providers touches the kernel, loop and product crates, which is where upstream churns most. Rebasing would be continuous, expensive work in a language our codebase does not use. **(inference)**
- **Upstream health signal:** no commit on `main` since 2026-09-10, after a weekly cadence. If upstream has slowed, a fork inherits a very large codebase with no one else maintaining it; if it moves to a new branch, the fork may diverge from the line NEAR AI actually ships. Ask NEAR AI which it is before deciding.
- **Contributing back instead:** several of our pieces would be welcome upstream on their own: per-response attestation verification for NEAR AI Cloud, TEE privacy labels, a DID-backed trust policy source. That gives the NEAR ecosystem the benefit without us owning a fork.

### 7.4 Hermes and OpenShell in the fork

- **Hermes Agent** is Python (**inference**, see the separate analysis). Its improvements would arrive as ideas reimplemented in Rust, not code merged; the same ideas can be reimplemented in our TypeScript at lower cost.
- **NVIDIA OpenShell** is an out-of-process sandbox runtime: a gateway managing sandboxes and a supervisor beside each one, YAML policy per sandbox, filesystem rules via Landlock (static per sandbox), network rules through an OPA-evaluated proxy (hot-reloadable), unprivileged processes, host credential paths excluded by default ([NVIDIA blog](https://blogs.nvidia.com/blog/secure-autonomous-ai-agents-openshell), [Better Stack guide](https://betterstack.com/community/guides/ai/nvidia-openshell/), [NVIDIA OpenShell perspectives](https://perspectives.nvidia.com/nvidia-openshell/agent-sandbox-least-privilege-per-agent-not-shared/); I read summaries, not the OpenShell source). Its point is that enforcement sits **outside** the agent process, so it wraps any engine. It does not require IronClaw, and it does not favour a fork over our own engine: it could wrap our relay's run workers, routine runs and cyber harness just as well. It is Linux-centred (Landlock), so it suits the relay host and code-server deployments more than Windows or macOS desktops. **(inference)**

### 7.5 DID-bound capabilities in an IronClaw fork

This is IronClaw's strongest argument. A DID policy would plug in where trust and authorization already sit: a `PolicySource` in `ironclaw_trust` that derives the effective trust ceiling from the agent's DID, an authorizer check in the capability path (`ironclaw_authorization` leases, `ironclaw_approvals`), sub-agent spawn limits from the DID's delegation depth, and restrict-only self-authored hooks for task-level narrowing. The single mediated capability path ("never around them", `AGENTS.md`) is exactly what a DID gate needs. But none of it exists yet (section 5.1), so it is new work either way, and the same design (manifest, one gate, leases, subset-only delegation) is achievable in `src/agent/permissions.ts` plus R1, R2 and R5 at a fraction of the size.

### 7.6 Pros, cons, risks, size

**Pros**
- Inherits a mature isolation design: WASM lane, egress proxy, host-side credentials, staged authorization, signed registry, durable approvals and notifications, routines with guardrails.
- Slack and Telegram channels, Google Workspace and GitHub extensions, Docker sandbox, multi-user web app with SSO already exist.
- Same provider family (NEAR AI default), and it is NEAR AI's own project, which may matter commercially.
- Clear insertion points for a DID policy (7.5).

**Cons**
- Rust, about 25 times our code size; a second language and toolchain for a TypeScript team.
- Our differentiators (teams, Open-GSD, approvals model, privacy tiers, attestation, spend ledger, Team Studio) must be ported, not reused.
- No Teams channel; Signal absent in 1.x; relay work is not removed, it changes language.
- Breaks the zero-dependency VSIX unless the engine runs as a separate service, which then has to be installed, updated and secured on every user's machine or on a server.
- Fork divergence cost is permanent; upstream direction is unclear since September.

**Risks**
- Security: two approval models during migration means two places to get wrong; a long migration is where gaps appear.
- Privacy: IronClaw's default posture (auto-approve on, "LLM data is never deleted") conflicts with ours and would need to be changed and kept changed against upstream.
- Delivery: the v0.7.0 relay (Phase 68 done, 69 to 76 planned) would stall while the fork is stood up.

**Size (rough):** shape B plus porting teams, approvals, privacy, spend and a Teams channel into a fork: **multiple milestones (XL, likely 3 to 6 months of focused work)**, plus ongoing rebase cost. Shape C (relay only): **XL**, and it still needs a Teams channel and team execution. **(inference)**

### 7.7 Migration path if the owner chooses it anyway

1. Keep the shipping extension and its TypeScript engine untouched as the default path for the whole migration.
2. Spike: run IronClaw unmodified (no fork) as an optional backend on the relay host; add an "external member" in our teams that calls it through the Responses API, behind our approval gate. Measure what is missing.
3. Contribute upstream what we need (attestation, TEE labels, a DID policy source, a Teams channel) and see whether NEAR AI accepts it. Only fork if upstream refuses something essential.
4. Move one capability at a time behind a feature flag, with parity tests against the TypeScript engine (approvals, privacy, spend), and remove nothing until parity holds.

### 7.8 Recommendation

**Keep our own engine and borrow ideas (R1 to R7), contribute upstream where it helps both, and interoperate rather than fork.** Concretely:
- Do not fork now. The cost is a port of our product into a 1.4M-line Rust codebase, and the parts that make IronClaw attractive (manifested capabilities, one mediated gate, host-side credentials, restrict-only self-narrowing, routines with guardrails) are designs we can adopt in TypeScript at a fraction of the size, in a form that also serves the DID plan.
- Adopt OpenShell (or our planned container and microVM tiers) as the out-of-process enforcement layer under the relay and routine runs; it is engine-neutral.
- Offer upstream: NEAR AI Cloud attestation verification and TEE labels; later a DID-backed trust policy source.
- Revisit "depend on upstream unmodified plus extensions" if NEAR AI commits to IronClaw as the organization-wide agent host, ships a Teams channel, and keeps `main` moving; at that point running it as an optional backend through the Responses API is the low-risk step, and a fork is still not needed.

---

## 8. Sources read

IronClaw (clone of `https://github.com/nearai/ironclaw`, `main` at `b0b999d`):
`README.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `FEATURE_PARITY.md`, `docs/security.mdx`, `docs/changelog.mdx`, `docs/capabilities/{overview,sandboxed-tools,skills,llm-providers}.md(x)`, `docs/capabilities/memory/{memory,identity}.mdx`, `docs/capabilities/jobs/jobs.mdx`, `docs/capabilities/routines/{heartbeat,cron,reactive}.mdx`, `docs/channels/{overview,building-a-channel}.mdx`, `docs/extensions/{overview,mcp,shell}.mdx`, `docs/hub/overview.mdx`, `docs/using/webui.mdx`, `docs/api/responses.mdx`, `crates/domains/ironclaw_llm/{CONTRACT.md,src/config.rs,src/nearai_chat.rs}`, `crates/extensions/packages/{github,nearai-mcp}/manifest.toml`, `crates/loop/ironclaw_hooks/{README.md,src/self_authored.rs}`, `crates/loop/ironclaw_loop_host/src/subagent_spawn_port.rs` and its prompt, `crates/kernel/ironclaw_approvals/src/{lib.rs,auto_approve.rs}`, `crates/kernel/ironclaw_trust/CONTRACT.md`, `crates/lanes/ironclaw_wasm/{README.md,wit/tool.wit}`, `crates/product/ironclaw_webui/frontend/{package.json,src/wallet-connect.ts}`, `profiles/local.toml`, `registry/`. GitHub API for stars, issues, releases.

Ours: `origin/main` `README.md`, `SECURITY.md`, `.planning/PROJECT.md`, `src/agent/{teams,teamMarkdown,teamGraph,loop,unattended}.ts`, `src/agent/permissions.ts`, `src/domain/policy.ts`, `src/services/{attestation,agentOrchestrator}.ts`, `src/mcp/client.ts`, `src/gsd/library.ts`, `package.json`; `feat/team-fix-pass` `src/domain/team/permissions.ts` and `src/team/` listing; `origin/feat/messaging-relay` `.planning/ROADMAP.md` (v0.7.0, Phases 68 to 76) and `relay/` listing.

Theia: [Theia AI docs](https://theia-ide.org/docs/theia_ai/), [Installing VS Code extensions](https://theia-ide.org/docs/user_install_vscode_extensions/), [Theia 1.75 notes](https://eclipsesource.com/blogs/2026/09/10/eclipse-theia-1-75-release-news-and-noteworthy/), [Theia 1.73 notes](https://eclipsesource.com/blogs/2026/07/07/eclipse-theia-1-73-release-news-and-noteworthy/), [Eclipse newsroom, Theia tag](https://newsroom.eclipse.org/tags/theia), [vogella: Copilot vs Theia AI](https://vogella.com/blog/vscode_copilot_theia_ai_comparison/).

# Hermes Agent compared with NEAR AI agent teams: what to adopt, and where

Prepared 2026-11-15 for the owner of the NEAR AI VS Code extension.

Scope: Hermes Agent (Nous Research), our extension's agent teams on `origin/main` (v0.4.22), the planned v0.7.0 messaging relay, the DID governance model in `.planning/PROJECT.md`, the owner's current leaning (fork NEAR's IronClaw as the core and add Hermes features plus NVIDIA OpenShell enforcement), and the planned move to Eclipse Theia.

How this was researched:
- **Hermes** was read from a shallow clone of `github.com/NousResearch/hermes-agent` at commit `ce4de3cdc2a99276affd2ec12b3adde8f39636ab` (2026-11-15). Nothing from it was run. Paths below are relative to that repo; on GitHub each is `https://github.com/NousResearch/hermes-agent/blob/main/<path>`.
- **Our code** was read from `origin/main` and from the `feat/messaging-relay` and `feat/team-fix-pass` branches.
- **IronClaw** was looked at only far enough to judge portability: its README, repo layout and three docs pages, read through the GitHub API.
- **Theia** facts come from theia-ide.org and eclipsesource.com pages, cited in section 9.
- Anything not read directly is marked **(inferred)**.

---

## 1. Summary

**What Hermes is**
- Hermes is a large, fast-moving, MIT-licensed Python agent: about 263,500 stars and 59,400 forks, releases every few days, daily canary builds. It runs as one long-lived "gateway" process. A CLI, a TUI, a desktop app, a web dashboard and about 25 messaging platforms all attach to it.
- Its distinctive features are:
  - a self-improvement loop (the agent writes and patches its own skills and memory, and a "curator" prunes them);
  - scheduling (cron, heartbeats, `/goal`, `/loop`);
  - a durable multi-agent Kanban board;
  - pluggable sandboxed terminal backends;
  - a very broad plugin system.

**The most important finding for us: Hermes plugins are not a security boundary**
- By default, plugins are in-process Python with full trust.
- Its own docs say plugin capabilities are "a consent and audit layer, not isolation" and that "a malicious plugin can ignore every gate here" (`website/docs/user-guide/features/plugins.md`, "Plugin capabilities and consent").
- The cross-vendor "Agent Plugins v1" package format it supports "does not define trust, permissions, provenance, or a sandbox" (`website/docs/developer-guide/plugins/index.md`).
- Neither model can carry DID-bound constraints. IronClaw's WASM tool model can: each tool's `capabilities.json` is enforced by a sandbox and a network proxy, not by the tool's good behaviour.

**Recommendation in one paragraph**
- Do not adopt Hermes plugins and do not write a Python-compatible layer.
- Standardize on a hybrid:
  - MCP servers for executable extensions, always out of process;
  - our markdown team, agent and skill files for behaviour;
  - one signed package manifest, compatible with the Agent Plugins v1 layout (`plugin.json`, `skills/`, `mcp.json`), whose `capabilities` block is our own and maps one-to-one onto DID constraints.
- If the core becomes IronClaw, use IronClaw's enforced `capabilities.json` as the base for that block.
- Copy Hermes's lifecycle and UX rather than its runtime:
  - disabled until enabled;
  - exact-SHA pins;
  - re-consent when an update widens capabilities;
  - a scan on install;
  - pack review with no bulk grant;
  - staged skill writes with diff and approve;
  - delegation that can only narrow.

**Sequencing for Theia**
- Build these capabilities in the editor-agnostic layer: the agent core, the policy gate, DIDs, the manifest and skill formats, MCP, the relay, and scheduling. That layer is either today's vscode-free `src/agent/` or an IronClaw-based core.
- Keep VS Code UI work on these features to the minimum the current webviews need. Theia can host our webviews and VS Code extensions, but the chat participant API is stubbed in Theia. The rich UI will be rebuilt as Theia widgets or Theia AI agents after the move anyway.

---

## 2. What Hermes Agent is (facts from the repo)

### 2.1 Identity, licence, maturity

| Fact | Value | Source |
|---|---|---|
| Licence | MIT, "Copyright (c) 2025 Nous Research" | `LICENSE`, `pyproject.toml` (`license = "MIT"`) |
| Language/runtime | Python, `requires-python = ">=3.11,<3.15"`, targeting 3.14; also Node and pnpm for the TUI, desktop and web | `pyproject.toml`; README install notes |
| Supply-chain stance | Every core dependency is exact-pinned "in response to the Mini Shai-Hulud worm" | comment in `pyproject.toml` dependencies |
| Created | 2025-07-22 | GitHub API `repos/NousResearch/hermes-agent` |
| Stars / forks | 263,529 / 59,410 (2026-11-15) | GitHub API |
| Open issues + PRs | 53,222 (GitHub counts both together) | GitHub API |
| Releases | v0.23.1 latest (2026-11-10); v0.23.0 "The Hearth Release" (2026-11-05); 0.22.x patches every few days in Oct–Nov 2026; daily canary pre-releases | `gh release list` |

On maturity: the feature surface is very large and moves daily. The docs are thorough and show a team that thinks about security in detail: request-bound approvals, SHA pins, scan verdicts. Most of that is policy and UX, though, not isolation. The very high issue and PR count, together with sprawling top-level modules (dozens of `hermes_state_*.py` files at the repo root), suggests a project that adds faster than it consolidates **(inferred)**.

### 2.2 Agent loop

- The `AIAgent` class is in `run_agent.py` (a thin facade). The loop is in `agent/conversation_loop.py`, with turn phases in `agent/turn_*.py` (`website/docs/developer-guide/agent-loop.md`).
- It supports three API modes: `chat_completions`, `codex_responses` and `anthropic_messages`. All are normalized to OpenAI-style messages.
- Other loop features:
  - tool calls run sequentially or concurrently in a thread pool;
  - context compression;
  - retries;
  - fallback model switching;
  - iteration budgets shared across parent and children;
  - "flushing persistent memory before context is lost".
- `execute_code` ("programmatic tool calling") lets the model write a Python script that calls Hermes tools over a Unix-socket RPC. Only the script's `print()` output returns to the model (`website/docs/user-guide/features/code-execution.md`).
- `/goal` keeps a standing objective. After each turn, a judge model checks whether it is met and, if not, feeds back a continuation prompt (`website/docs/user-guide/features/goals.md`).
- Tool Search replaces many MCP and plugin tool schemas with three bridge tools, so schemas load on demand (`website/docs/user-guide/features/tool-search.md`).

### 2.3 Tools, terminal backends and sandboxing

- The README claims "40+ tools" and a toolset system.
- **Terminal backends:** local, Docker, SSH, Modal, Daytona and Vercel Sandbox are built in; Singularity/Apptainer and others come as plugins (README; `website/docs/user-guide/security.md`, "Terminal Backend Security Comparison").
- **The dangerous-command check is skipped on container and cloud backends** ("container is boundary"). It runs only on local and ssh.
- **Approval modes:** `approvals.mode: smart | manual | off`.
  - `smart` uses an auxiliary LLM that auto-approves low-risk commands, auto-denies dangerous ones and escalates uncertain ones.
  - `off` is "YOLO".
  - Headless contexts default to deny: `cron_mode`, `single_query_mode` and `unattended_mode` all default to `deny` (`security.md`, "Approval Modes").
- **A "Hardline Blocklist" is an always-on floor.** It blocks `rm -rf /`, fork bombs, `mkfs` and `dd` on disks, and piping URLs to `sh`. No YOLO setting, cron approve mode or "allow always" overrides it, and it fails closed on unparseable shell quoting (`security.md`, "Hardline Blocklist").
- **Other layers:** protected write paths, an optional `HERMES_WRITE_SAFE_ROOT`, SSRF protection, credential redaction, a filtered environment for MCP processes, and context-file injection scanning (`security.md`, sections listed under "Overview").

### 2.4 Memory and the learning loop

- **Memory** is two bounded files: `MEMORY.md` (2,200 characters) and `USER.md` (1,375 characters), in `~/.hermes/memories/`. They are injected into the system prompt as a frozen snapshot at session start, and the agent edits them with a `memory` tool.
- A background review after turns can propose or stage memory and skill changes. `memory.write_approval` defaults to `false`, meaning writes happen freely (`website/docs/user-guide/features/memory.md`).
- **Skills** are `SKILL.md` folders compatible with agentskills.io. They are loaded by progressive disclosure, and every skill is also a slash command.
  - "The agent can modify or delete any skill."
  - The `skill_manage` tool has `create`, `patch`, `delete`, `write_file` and `remove_file` actions, and the system prompt asks the agent to save non-trivial workflows as skills.
  - `skills.write_approval` defaults to `false`. When true, every write is staged under `~/.hermes/pending/skills/` and reviewed with `/skills pending | diff | approve | reject`. The gate "doesn't cover direct edits of skill files by the generic file tools or the terminal" (`website/docs/user-guide/features/skills.md`, "Agent-Managed Skills").
- **Project skills** in a repo must be trusted per repo root and are scanned. A "dangerous" verdict quarantines the skill (`skills.md`, "Scan-time quarantine").
- **The curator** maintains agent-created skills (`website/docs/user-guide/features/curator.md`):
  - It runs about weekly, when the agent is idle.
  - A deterministic pass moves unused skills from active to stale to archived (`~/.hermes/skills/.archive/`) and "never auto-deletes".
  - Pinned skills and skills used by cron are skipped.
  - An LLM consolidation pass is opt-in.
- Honcho "dialectic user modeling" builds a profile of the user across sessions (README).

### 2.5 Sub-agents and multi-agent work

Source: `website/docs/user-guide/features/delegation.md`, "Inherited Tool Access" and "Depth Limit".

- `delegate_task` spawns child agents with a fresh context; only their final summary returns.
  - Batches run up to 10 concurrent children by default.
  - Top-level delegations run in the background and post results back.
  - Each child has its own terminal and owns the processes it starts.
- **Attenuation:**
  - "Each subagent inherits the parent's enabled toolsets so the model cannot grant a child capabilities that the parent does not have."
  - There is no model-facing `toolsets` parameter.
  - Leaf children cannot call `delegate_task`, `clarify`, `memory`, `send_message` or `cronjob`.
  - `max_spawn_depth` defaults to 1 (flat). `role="orchestrator"` only takes effect when depth is raised, and `orchestrator_enabled: false` is a global kill switch.
- **Credentials:** children "inherit the parent's API key, provider configuration, and credential pool".
- **Structured output:** an `output_schema` is validated, with one bounded correction turn.
- **Run control:** continue, steer and stop are available for children. A restart marks an in-flight child `unknown` rather than resuming it, "because Hermes cannot prove which side effects happened".
- **Background children** ask for approval in the originating chat. Where no chat can show the prompt, the command is refused with "no approval channel".
- **Kanban** is "a durable task board, shared across all your Hermes profiles" (`website/docs/user-guide/features/kanban.md`):
  - Tasks are SQLite rows, and each worker is a full OS process "with its own identity" (a named profile with persistent memory).
  - Agents use `kanban_*` tools (claim, complete, request review, block, link and so on).
  - Recovery covers crash reclaim and block, unblock and re-run.
- **Profiles** are separate Hermes homes, each with its own config, keys, memory, skills and cron. Hermes warns never to point two agents at one home (`website/docs/user-guide/profiles.md`).
- **Mixture of Agents** is a virtual model in which reference models advise an aggregator (`mixture-of-agents.md`).

### 2.6 Scheduling and autonomy

- **Cron** (`website/docs/user-guide/features/cron.md`): the agent itself manages jobs through a `cronjob_manage` tool.
  - Jobs can be one-shot or recurring, and can attach skills.
  - Results go to the origin chat, files or platforms.
  - A no-agent "script only" mode exists.
  - Webhooks can trigger jobs.
  - Headless dangerous commands default to deny (`cron_mode: deny`).
- **`/heartbeat`** injects a recurring instruction into an idle session. **`/loop`** re-runs a prompt on a cadence inside a session. **`/goal`** keeps working until a judge says the goal is met (`heartbeat.md`, `loops.md`, `goals.md`).

### 2.7 Messaging gateways

- One gateway process serves:
  - **chat apps:** Telegram, Discord, Slack, WhatsApp, Signal, Microsoft Teams, Matrix, Mattermost, Feishu/Lark, WeCom, Weixin, iMessage (BlueBubbles), LINE, QQ and others;
  - **other channels:** SMS, Email, Home Assistant, ntfy, webhooks, A2A, and an OpenAI-compatible API server.

  (`website/docs/user-guide/messaging/index.md` and one page per platform in `website/docs/user-guide/messaging/`.)
- **Access control:** platform allowlists, plus DM pairing, where an unknown user gets an 8-character code that the owner approves on the CLI (`security.md`, "DM Pairing System").
- **Approvals:** `approvals.approvers` limits who in a shared chat may answer an approval.
- **Approval transports:** plugins can deliver approval prompts elsewhere. Requests are immutable and bound to an ID and digest, failures deny by default, and "there is intentionally no plugin approval policy, auto-allow callback" (`plugins.md`, "Approval transports").

### 2.8 Models and providers

- **Model access:** Nous Portal (300+ models and a "Tool Gateway" for search, image, TTS and browser), OpenRouter, OpenAI, Anthropic, Bedrock, Vertex, Azure, local models (Ollama and others), and custom endpoints. Model providers are plugins (`plugins/model-providers/`).
- **Routing:** fallback providers, credential pools and per-job model pins for cron (README; `website/docs/integrations/providers.md`; `cron.md`).

### 2.9 The plugin system in detail

Sources: `website/docs/user-guide/features/plugins.md`, `website/docs/developer-guide/plugins/index.md`, `website/docs/user-guide/features/plugin-catalog.md`.

- **Definition:**
  - A directory with `plugin.yaml` (the manifest: name, version, `provides_tools`, `provides_hooks`, `requires_env`, `capabilities`; v2 adds `manifest_version`, `api_version`, `requires_plugins`, `python_dependencies`, `config_schema`, `oauth`, `license`).
  - Python code exposing `register(ctx)`.
  - It can also ship pip entry points (`hermes_agent.plugins`) or Nix packages.
- **What `ctx` can register:**
  - tools (including overriding built-ins, with a capability), 27+ lifecycle hooks, slash commands and CLI subcommands;
  - injected messages, skills, gateway platforms, image and video backends, delegation strategies;
  - context engines, terminal backends, computer-use drivers, approval transports and memory providers;
  - host-owned LLM calls (`ctx.llm.complete`) and gated MCP calls (`ctx.call_mcp`).
- **Hooks:**
  - Directive hooks include `pre_tool_call` (can block), `pre_llm_call` (can inject context or block a turn) and `pre_gateway_dispatch`.
  - Transform hooks include `transform_tool_result` and `transform_llm_output`.
  - There are many observer hooks, including `subagent_start` and `subagent_stop`, `pre_approval_request` and the kanban events.
- **Discovery and loading:**
  - Sources are bundled, user (`~/.hermes/plugins/`), pip and Nix.
  - Project-local plugins are not loaded by the gateway.
  - General plugins are opt-in through `plugins.enabled`. Bundled platform and backend plugins and memory, context and model providers are not gated by that list.
  - Gateway hooks in `~/.hermes/hooks/` are "trusted by placement".
- **Capabilities and consent:**
  - A plugin declares capabilities such as `tools.override`, `llm.model_override` and `gateway.platform_actions`.
  - The user consents once, and the grant is recorded with a hash and timestamp.
  - Updates that add capabilities re-ask, and non-interactive installs grant nothing.
  - Explicitly: "Capabilities are a consent and audit layer, not isolation. Plugins run as regular in-process Python."
- **Isolation:**
  - The default is `in_process`.
  - `plugins.isolation: host` moves user plugins into one separate Python plugin-host process per profile, talking over a private pipe, with an optional `launcher` argument prefix "e.g. a sandbox runner". Bundled plugins stay in-process.
  - Desktop plugin JavaScript "is evaluated inside the Desktop app itself ... there is no sandbox, and it can do anything the app can."
- **Distribution and supply chain:**
  - `hermes plugins install owner/repo`, optionally with `--ref <40-char SHA>`. Pinned installs refuse to drift.
  - A curated plugin catalog (`plugin-catalog/`) has human-merged entries pinned to exact SHAs, with Official, Verified and Community tiers, and admission CI that runs the scanner. "Cataloged ≠ audited."
  - Plugin packs (`hermes-pack.yaml`) require SHA pins and a mandatory review screen, never bulk-grant consent, and strip secrets.
  - An install-time security scan returns safe, caution or dangerous. Dangerous blocks, and `--force` does not override it.
- **Portable Agent Plugins v1** (https://agent-plugins.org/specification):
  - `plugin.json` plus `skills/*/SKILL.md` plus `mcp.json` (stdio and Streamable HTTP).
  - Skills are read-only and namespaced. MCP commands are never run through a shell.
  - The spec "does not define trust, permissions, provenance, or a sandbox".
  - A package can ask Hermes to mark one of its MCP servers `trust: untrusted`.

### 2.10 UI surfaces

- CLI and full TUI.
- **Hermes Desktop**, a native app for macOS, Windows and Linux, with its own plugin SDK.
- **Web dashboard** (`hermes dashboard`).
- **Messaging apps.**
- **ACP server**, so ACP-capable editors can host Hermes (`website/docs/user-guide/features/acp.md`).
- **API server.**

There is no VS Code or Theia extension in the repo; the editor route is ACP **(inferred from the docs list)**.

---

## 3. What we have today (origin/main, v0.4.22)

All citations are `origin/main` paths.

**Agent loop** (`src/agent/loop.ts`)
- Structure: `AgentRun` runs up to 60 turns by default (`nearAi.agent.maxTurns`).
- Tool calls: reads and plans run in parallel (up to 8); state-changing calls run serially.
- Guards: a loop guard (nudge, warn, stop), a "stuck" detection after four length-truncations in a row, retries with backoff, stall detection with a backup-model retry, and a test-integrity re-prompt.
- Context compaction and budgets run through `beforeTurn` in `src/services/agentSession.ts`. Budgets cover a daily limit, $5 and 4M tokens per run by default, and are checked before every turn for main and sub-agents alike.

**Tools and safety**
- `src/agent/tools.ts`: core tools, plus web, graphics, `Remember`/`Recall`, `TeamKnowledge`/`Learn`, `SecurityScan`, cyber tools, MCP tools (`mcp__<server>__<tool>`) and the Open-GSD `Skill`/`SlashCommand`/`AskUserQuestion`/`Agent`/`Task`.
- `src/domain/policy.ts`: each tool has an `ActionCapability` (`read | plan | workspaceWrite | sharedWrite | shell | network | gitMutation | mediaGeneration | mediaPublication`).
- `src/agent/permissions.ts` `decidePermission` checks, in order: a deny list, run grants, an allow list, then the mode (`approve-risky | mostly-autonomous | auto | fully-autonomous`).
- **Auto mode** goes from deterministic `classifyCommand` to a private (TEE or local) safety model (`src/agent/safetyModel.ts`).
- **Taint rules:** after untrusted content is read, network and data-carrying commands ask.
- **"Always allow" exclusions:** it is never offered for `credentials`, `destructive` or `leaves-machine`.
- **Protected paths** are listed in `src/domain/protectedPaths.ts`.
- **No OS sandbox for agent shell commands.** Commands run in a persistent bash with credential environment variables stripped. Docker is used only for cyber targets; worktrees isolate parallel editors.

**Teams** (`src/agent/teams.ts`, `teamMarkdown.ts`, `teamGraph.ts`)
- **Format:** a markdown file with frontmatter (`name`, `description`, template fields) and one `## member` section per member, with lines `role:`, `model:`, `tools:`, `reports-to:` and `privacy:` followed by instructions. Teams have 1 to 12 members.
- **Running a team:**
  - The lead is LLM-orchestrated through the `Agent` tool.
  - Each member's tools are filtered to its `tools:` list.
  - `privacy: private` fails closed when no private model is available.
  - Slot pools limit concurrency (8 agents, 4 worktrees).
  - Sub-agents can nest and share the run's `RunGrants` and budget.
  - `teamGraph.ts` is display only.
- **Storage:** a versioned library, plus a project team at `.planning/.near-ai/team.md` with per-file consent, never loaded in untrusted workspaces.

**Memory**
- `ContextGraphMemory` uses `Remember`/`Recall` with scopes (`private-agent | team-collective | project | shared`), provenance and retraction, and injects a preamble of up to 10 facts.
- Team knowledge graphs use `Learn` (`sharedWrite`, which always asks).
- **There are no learned or self-written skills.**

**Skills and agents** (`src/gsd/library.ts`)
- They read the Claude Code runtime format: `skills/<name>/SKILL.md` and `agents/*.md`, with frontmatter `name`, `description`, `allowed-tools`, `tools` and `model`.

**MCP** (`src/mcp/client.ts`, `src/services/mcpRegistry.ts`)
- The MCP SDK is vendored. Transports are stdio and Streamable HTTP, and remote servers must use https.
- A stdio command runs only after the user confirms it.
- Secrets go in SecretStorage.
- Per-server approval is `ask-for-changes | ask-every-call | trusted`, and every result is treated as untrusted. There is no OAuth.

**UI**
- Team Studio (`media/teams/`) has a library, a wizard with an AI builder, and tabs for purpose, members, models, tools, instructions, read-only shape, knowledge, markdown checks and history.
- Chat (`media/chat/`) has approval cards, steering, per-agent pause, resume and stop, revert, and TEE signature verification.

**Packaging and roadmap**
- `package.json` has **zero runtime dependencies**. Third-party code is vendored from pinned devDependencies.
- Not present on main:
  - no scheduler for agent runs;
  - no plugin system;
  - no execution graph or durable task handoff (Team Mode's board is on unmerged branches);
  - no Theia mention anywhere in `.planning`.

**v0.7.0 relay** (`origin/feat/messaging-relay`)
- `relay/` is a separate Node 26 service with one dependency (`jose`) and a `node:sqlite` store. It composes `src/agent/` headlessly, without `chat.ts`.
- Channels are Teams, Signal (signal-cli sidecar) and Telegram.
- Phases 68–76 cover allowlists, tenants, budgets, durable approvals in private chat that expire to deny, a concurrency queue, group discipline and ops.

**Governance plans**
- `.planning/PROJECT.md`, "Verifiable agent guardrails": every agent gets a NEAR implicit account and a W3C DID that carries its constraints. An agent acts only within its DID and never self-escalates. Only the orchestrator changes a DID, and only with authority delegated by a person. DIDs are stored with NEAR confidential intents, and authorization policies are immutable contracts that gate each action.
- The foundations are on unmerged branches: `src/team/` (identity, signed event log) and `src/domain/team/permissions.ts` (a role-by-action `PERMISSION_MATRIX`), both on `feat/team-fix-pass` and the `gsd/phase-60..62` branches.
- On main, the gate is `src/domain/policy.ts` plus `src/agent/permissions.ts`.

**Incidental doc issues worth fixing (from reading SECURITY.md and README.md)**
- SECURITY.md's known limitations say protected files are written without asking under fully-autonomous, while README.md says they still ask.
- SECURITY.md still says teams have no shared memory, although team knowledge graphs exist.

---

## 4. Side-by-side

| Area | Hermes | Ours today | Gap |
|---|---|---|---|
| Loop robustness | Retries, fallback, budgets, compression, background delegation | Comparable or stronger: loop guard, stall and backup model, test-integrity check, per-run cost caps | Small |
| Sub-agent attenuation | Children inherit the parent's toolsets and the model cannot widen them; leaf blocklist; depth 1 by default | Member `tools:` filter; nesting allowed; shared `RunGrants` | Needs an explicit intersection invariant and depth limit |
| Structured child output | `output_schema` with one correction turn | Free text | Small |
| Self-written skills | Yes; writes are free by default, with an optional staged review | None | Large, and the riskiest |
| Memory | Two bounded files in the prompt; free writes by default | Scoped context graph with provenance, preamble labelled "verify" | Ours is safer |
| Scheduling | Cron, heartbeat, loop, goal | None | Medium |
| Durable multi-agent board | Kanban with worker identities | Team Mode board on unmerged branches | Align with Team Mode |
| Messaging | About 25 platforms in one gateway, DM pairing, approvers | Relay planned (Teams, Signal, Telegram), allowlists, private-chat approvals | Ours is narrower and more deliberate |
| Approval routing | Approval transports, request-bound, deny on failure | Chat cards; the relay plans durable approvals | Small design borrow |
| Command safety | Pattern list, aux-LLM "smart" mode, hardline floor | Rules, private safety model, taint, never-always kinds | Needs a hardline floor that overrides fully-autonomous |
| Execution isolation | Docker, Modal, Daytona, Vercel, SSH backends | Host bash; Docker only for cyber | Large; prerequisite for autonomy |
| Plugins | Very broad in-process Python, consent not isolation, SHA-pinned catalog | MCP, Open-GSD runtime, team markdown | See section 8 |
| Tool schema bloat | Tool Search (load on demand) | All tools sent | Small to medium |
| Privacy tiers | Provider choice only | TEE or local models per member, TEE-only mode, signature verification | Ours is far ahead; keep it |
| Editor surface | ACP server | Native VS Code extension | Different strategy |

---

## 5. Trust and governance fit (the DID lens)

The governance model in `PROJECT.md` sets one rule that every recommendation must meet. **Authority is data attached to an identity, it can only narrow as it is delegated, and a gate outside the agent checks it before anything runs.** That gives five tests.

### 5.1 The five tests

1. **Expressible.** Can the feature's actions be written as DID-bound capabilities, such as `shell:workspace`, `network:host=api.x.com`, `mcp:server/tool`, `send:channel=telegram/chat=123`, `schedule:create`, `skill:write(scope=team)` or `spend:<=USD 2/run`?
2. **Gated.** Does every action pass through one policy gate before execution, with no side door? Watch for direct file edits of skills, hooks loaded by placement, and in-process plugin code.
3. **No self-escalation.** Can the agent, or anything it writes (a skill, memory, a plugin, a cron job), raise its own authority or a child's?
4. **Attenuation.** Is each delegation (person, then orchestrator, then sub-agent, then plugin or tool) a subset of its parent? Is it signed by the delegator, with an expiry and a budget?
5. **Auditable.** Is each grant, delegation and decision recorded in the signed event log (`src/team/eventLog.ts` on the Team Mode branches), so the chain can be replayed?

### 5.2 How Hermes measures up

| Hermes mechanism | Fit | Why |
|---|---|---|
| Delegation inheritance ("the model cannot grant a child capabilities that the parent does not have") | **Good model to copy** | It is attenuation by construction. We add per-member narrowing (`tools:`) and make it a signed sub-delegation. |
| Leaf blocklist (no delegate, memory, send_message or cronjob for leaves) | **Good** | Those four are authority-amplifying verbs. In our terms they become capabilities a child does not get unless explicitly delegated. |
| Hardline floor | **Good** | Maps to non-delegable "never" constraints in every DID and policy contract. |
| Approval transports (request-bound, deny on failure, no plugin auto-allow) | **Good** | Separates where a person answers from who decides. The decision stays with the gate. |
| Credential pool inherited by children | **Do not copy** | Under DIDs, each agent signs with its own key and spends from a delegated allowance. Shared pools hide who did what. |
| `skill_manage` with `write_approval: false` by default; generic file tools bypass the gate | **Fails tests 2 and 3** | A skill is instructions the agent will follow later, so a self-written skill is persistent self-programming. If skills can carry `allowed-tools`, it is also an authority claim. |
| Memory written straight into the next system prompt | **Weak** | A durable prompt-injection channel. Ours is better: scoped, with provenance, labelled "verify". |
| Cron created by the agent (`cronjob_manage`) | **Fails test 3 unless constrained** | A schedule is standing authority that outlives the conversation. It must be a person-signed, expiring delegation. |
| In-process plugins, capabilities "not a sandbox" | **Fails test 2** | Any granted plugin can ignore the gate. Consent records are useful for audit only. |
| Gateway hooks "trusted by placement" | **Fails test 2** | Loading code because a file exists is exactly the side door the DID model forbids. |
| Docker or cloud backends skip the dangerous-command check | **Partial** | The sandbox limits blast radius, but authority to reach networks or secrets still needs the gate. |
| MCP `trust`, `spend_limit`, `tool_costs` | **Good** | Spend per server per chat is a natural DID constraint. |
| Kanban workers as OS processes with their own identity | **Good** | This is the closest Hermes comes to per-agent identity. Each worker would map onto an agent DID. |

### 5.3 Design rules for everything we adopt

- **One gate.** Every tool call, skill load, MCP call, plugin action, scheduled firing and outbound message passes through one `authorize(actorDid, capability, context)` decision.
  - It builds on `decideAction`/`decidePermission` today and on the policy contract later.
  - The approval UI is only a transport into that gate.
  - When the chain is unreachable, use a cached, signed policy snapshot with a short expiry, then fail closed for anything not `read`/`plan`. This answers the open question in `PROJECT.md` **(proposal)**.
- **Capabilities are declared, never inferred from prompts.**
  - Team member `tools:` and `privacy:` lines, skill `allowed-tools`, plugin manifests and schedule definitions all compile to the same capability vocabulary.
  - The DID document carries the resulting set.
- **Delegation is a signed, expiring, budgeted subset:**

  ```
  child.caps = parent.caps ∩ member.declared ∩ (task.requested)
  ```

  Depth and fan-out limits are themselves constraints. The orchestrator signs the child's DID update under authority delegated by a person, and the event log records it.
- **Content never carries authority.** Skills, memory, team knowledge and plugin docs are data and instructions. A skill's `allowed-tools` can only narrow what the running agent already has; it never adds to it. A self-written skill can never declare more than its author agent holds, and it lands as a staged proposal a person approves.
- **Code never runs in the extension host or the core's process on a plugin's behalf.** Executable extensions are MCP servers (or IronClaw WASM tools) running out of process, under OpenShell or a container or VM policy. Their manifest capabilities are enforced by the sandbox and proxy, not just consented to.
- **Audit.** Every grant, consent, delegation, schedule creation, skill approval, plugin install or update (with SHA and capability diff) and every gate decision is an event in the signed log. The Agent Activity view renders the chain.

---

## 6. Recommendations as "features to port into an IronClaw-based core"

### 6.1 What we know about IronClaw (read for portability only)

Sources: https://github.com/nearai/ironclaw README; `docs/capabilities/sandboxed-tools.mdx`, `docs/capabilities/skills.mdx` and `docs/extensions/overview.mdx` in that repo; the GitHub API.

- **Basics:** Rust, dual MIT OR Apache-2.0, about 12,700 stars, last push 2026-11-09. It describes itself as "an Agent OS focused on privacy, security and extensibility".
- **Already present:**
  - agent loop, router, scheduler for parallel jobs;
  - a Routines Engine for cron, event and webhook triggers, and a heartbeat system;
  - an orchestrator with Docker sandbox workers and per-job tokens;
  - WASM tools under wasmtime with fuel and memory limits;
  - `capabilities.json` per tool, with a network host allowlist, filesystem read/write mounts, credentials injected by a proxy and never visible to the tool, leak scanning and rate limits;
  - MCP, and WASM channels (Telegram, Slack) plus a web gateway;
  - hybrid-search memory;
  - skills with deterministic activation (keywords, patterns, tags, token caps) and an IronHub registry.
- **Kernel crates:** `crates/kernel/` has `ironclaw_authorization`, `ironclaw_capabilities`, `ironclaw_trust`, `ironclaw_approvals` and `ironclaw_runtime_policy` (names seen in the directory listing; contents not read).
- **Portability rule of thumb.** No Hermes code ports, because Hermes is Python and IronClaw is Rust. Every Hermes feature ports as a design. Features that are mostly policy and data (attenuation rules, staging, pins, schedules) port cleanly into Rust. Features that depend on Python's in-process plugin model do not port and should not.

### 6.2 High value

#### H1. One capability vocabulary and policy gate, with a hardline floor
- **Hermes does:**
  - a hardline blocklist that nothing overrides;
  - declared plugin capabilities with consent and re-consent;
  - approval modes, with deny-by-default for headless contexts.
- **We have:** `ActionCapability`, `decidePermission`, never-always kinds, and the Team Mode `PERMISSION_MATRIX`. But under fully-autonomous, protected paths can be written (SECURITY.md known limitation), and capabilities are coarse (no host, path, server or spend parameters).
- **Gap:** no parameterized capabilities, no non-overridable floor, and no single gate shared by tools, MCP, skills, schedules and messaging.
- **Design:**
  - Define a capability grammar: verb, resource, constraints. Examples:
    - `shell{cwd:workspace}`
    - `network{hosts:[...]}`
    - `mcp{server, tools}`
    - `send{channel, chat}`
    - `schedule{max_per_day}`
    - `skill.write{scope}`
    - `spend{usd_per_run, usd_per_day}`
  - Compile team-member lines, skill frontmatter, MCP config and manifests into it.
  - Make the floor (`.git/`, `.near-ai/` state, credential reads, the hardline commands) non-delegable, so no mode or DID can include it.
  - This grammar becomes the payload of the DID's constraints.
- **Risks:** grammar churn. Mitigate with versioning and by rejecting unknown verbs (fail closed).
- **IronClaw port:** clean. It has `ironclaw_capabilities` and `ironclaw_authorization` crates and an enforced `capabilities.json`; extend that schema rather than inventing a parallel one.
- **Size:** M in our TS core; S–M if IronClaw's capability crate fits.

#### H2. Delegation that only narrows, with a depth limit and structured results
- **Hermes does:**
  - toolset inheritance with no model-facing widening;
  - a leaf blocklist;
  - `max_spawn_depth` of 1 by default and an `orchestrator` role;
  - `output_schema` with one correction turn;
  - honest `unknown` after a restart.
- **We have:** member `tools:` filtering, nesting with no depth cap, shared `RunGrants`, and free-text results.
- **Gap:** no stated invariant that a child is a subset of its parent, no depth or fan-out caps, and no "authority-amplifying verbs withheld from leaves" rule.
- **Design:**
  - `childCaps = parentCaps ∩ memberCaps`, enforced in `agentSession.ts` `toolsFor` and recorded as a signed delegation event.
  - `nearAi.agent.maxSpawnDepth` defaults to 2 (lead plus members). Members cannot spawn unless the team file marks them `role: orchestrator`.
  - Leaves never get `Learn`, scheduling, outbound messaging or `Agent` unless granted explicitly.
  - Add optional `output_schema` to the `Agent` tool.
  - Run grants become per-child, derived from the parent's, never shared upward.
- **Risks:** low. Existing teams that rely on deep nesting need a clear message.
- **IronClaw port:** clean (orchestrator/worker already exists; add an attenuation check at job creation).
- **Size:** S–M.

#### H3. An execution sandbox before more autonomy
- **Hermes does:** pluggable terminal backends (Docker, Modal, Daytona, Vercel, SSH), with a separate "plugin host" process.
- **We have:** host bash with environment scrubbing; Docker only for cyber; a planned microVM for cyber.
- **Gap:** autonomy (mostly-autonomous, scheduled runs, messaging-triggered runs) on the person's host with only a deny list as backstop.
- **Design:**
  - One "execution environment" interface (local, container, microVM) chosen per team member or run.
  - Unattended and relay runs require a non-local environment.
  - The gate still applies inside the sandbox for network, secrets and outbound actions. **Do not copy** Hermes skipping the dangerous-command check on container backends.
  - NVIDIA OpenShell, which the owner proposes, would sit here as the enforcement layer. I did not read OpenShell's docs, so its fit is unverified.
- **Risks:** platform support (Windows), performance, and the cost of proving the boundary. Reuse the cyber VM breakout-test idea.
- **IronClaw port:** strong fit (Docker workers and WASM already exist).
- **Size:** L, but it is the prerequisite for H5 and M1.

#### H4. Approvals that travel, bound to the request
- **Hermes does:**
  - approval transports, where the prompt goes to another surface and the request is immutable with an ID and digest;
  - deny on timeout or failure;
  - `approvers` lists in shared chats;
  - background children asking in the originating chat;
  - "no approval channel" meaning refusal, never pending.
- **We have:** chat cards; `subagentApprovalWaitSeconds` returning pending; the relay plans durable private-chat approvals that expire to deny (Phase 73).
- **Gap:** no request digest binding, and no single approval object that can be answered from VS Code, the relay or later Theia.
- **Design:**
  - An `ApprovalRequest {id, digest(actorDid, capability, args), expires, allowedScopes}`, answered by an authenticated person whose device identity (`src/team/identity.ts`) signs the reply.
  - Any surface can render it.
  - "Always allow" becomes a signed, scoped, expiring delegation, not a local setting.
- **Risks:** replay, and approval fatigue. Mitigate with digests, short expiry, and the never-always kinds.
- **IronClaw port:** clean (`ironclaw_approvals` exists; contents not read).
- **Size:** M, and it overlaps relay Phase 73, so do it there.

#### H5. Learned skills, gated as proposals
- **Hermes does:**
  - `skill_manage` creates and patches skills after hard tasks;
  - a background review proposes changes;
  - optional staging with diff and approve;
  - the curator archives and never deletes;
  - pins and locks;
  - repo skills are quarantined on a "dangerous" scan.
- **We have:** `Remember`/`Learn` facts, and Open-GSD skills that are read-only. No learned procedures.
- **Gap:** the team does not get better at recurring work.
- **Design:**
  - A `ProposeSkill` tool (capability `skill.propose`, which leaves may hold).
  - It writes a staged proposal into the review queue (the Team Studio Knowledge tab, or a new "Learned" tab) with a diff, the run that produced it and a scan verdict.
  - A person approves it into a scope (member, team or project). The approval is a signed event, and the skill file records its approver and hash.
  - Skills are never directly writable by file tools: put their folder under protected paths.
  - Skill `allowed-tools` may only narrow.
  - Archive-only maintenance (stale after N days unused, never delete).
- **Risks:** persistent prompt injection, the biggest risk in this list. Mitigations:
  - a run tainted by untrusted content cannot propose skills, or its proposal is flagged;
  - proposals are scanned with the same injection scanner as fenced content;
  - no auto-approve mode at all.
- **IronClaw port:** clean as data. IronClaw already has SKILL-style markdown with activation metadata, so add approval provenance fields.
- **Size:** M.

### 6.3 Medium value

#### M1. Scheduled and standing work (cron, heartbeat, goal)
- **Hermes:** the agent can create cron jobs, which can run skills and deliver to chats. Headless dangerous commands are denied by default. There are also `/goal` and `/heartbeat`.
- **Ours:** none.
- **Design:**
  - A schedule is a **standing order**: a person-signed, expiring delegation, for example "every weekday 08:00, team X, capabilities ⊆ Y, at most $Z per run, results to chat C".
  - Agents may *propose* schedules; only a person creates them.
  - Unattended firings get no approvals: anything needing one is denied and reported.
  - `/goal`: add a judge-checked continuation to `afterAnswer`, bounded by turns and spend. This is small and needs no schedule.
- **Risks:** runaway spend, and stale authority. Mitigate with expiry, budgets and an emergency stop that covers schedules.
- **IronClaw port:** best done there (it already has a Routines Engine with cron, event and webhook). In our current architecture, it belongs in the relay service, not the editor.
- **Size:** M; `/goal` alone is S.

#### M2. A durable task board as the team's handoff medium
- **Hermes:** Kanban workers as OS processes with identities, crash reclaim, review requests.
- **Ours:** Team Mode Phase 62 board on branches; LLM-only delegation in agent teams.
- **Design:**
  - Let agent members claim and complete board items through tools, using the same `PERMISSION_MATRIX` rows with an agent role.
  - Each agent claim is signed by its DID.
  - This gives restart-safe multi-agent work without a new engine.
- **Risks:** mixing human and agent work in one board. Use clear labels, and require human review for agent-completed items when policy says so.
- **IronClaw port:** medium. IronClaw has jobs and a scheduler; the board model would be new data.
- **Size:** M–L; sequence it after Team Mode lands.

#### M3. MCP trust, spend and tool search
- **Hermes:** per-server `trust`, `tool_costs` and `spend_limit` (asks even on trusted servers when over the limit), sampling limits, and Tool Search for schema bloat.
- **Ours:** `ask-for-changes | ask-every-call | trusted`; all tools sent.
- **Design:**
  - Add a per-server spend constraint to the capability grammar.
  - Keep sampling off (Hermes enables it by default; that lets a server spend your model budget).
  - Add on-demand tool loading when more than N MCP tools are attached.
- **IronClaw port:** clean.
- **Size:** S–M.

#### M4. A package lifecycle (the UX half of a plugin system)
- **Hermes:**
  - disabled by default;
  - exact-SHA pins, and pinned installs refuse to drift;
  - re-consent when capabilities widen;
  - a scan on install (dangerous blocks, with no force override);
  - pack review with no bulk grant and secrets stripped;
  - catalog tiers.
- **Design:** see section 8. Apply it to team templates, skills and MCP bundles first, which we already have.
- **Size:** M.

### 6.4 Low value, or later

- **L1. Programmatic tool calling (`execute_code`).** Large token savings for mechanical batches, but it is a code-execution path that calls tools in a loop. Only consider it inside H3's sandbox, with each RPC tool call still gated. Size M.
- **L2. Profiles as separate agent homes.** Our teams, scopes and future DIDs already cover this better.
- **L3. Mixture of Agents.** Cost multiplier, and unclear value for teams that already use different models per member.

---

## 7. What we should NOT copy, and why

1. **In-process, full-trust plugins** (Python `register(ctx)`, Desktop `plugin.js` in the app's realm, gateway hooks "trusted by placement"). They fail the single-gate test. In our case they would also be JavaScript in the extension host, with access to SecretStorage and every VS Code API.
2. **Free writes by default for agent skills and memory.** That makes self-modification a default instead of an exception.
3. **YOLO / `approvals.mode: off` / `cron_mode: approve`.** A mode that switches the gate off cannot coexist with DID-bound authority. Our fully-autonomous mode should be re-specified as "approval not required within the DID's grant", never "gate off".
4. **Skipping command checks inside containers.** A sandbox limits damage; it does not grant authority to reach a network or a secret.
5. **Children sharing the parent's credential pool.** Under DIDs, each agent acts as itself with a delegated allowance.
6. **MCP sampling on by default.** A server should not be able to spend the person's model budget or reach their model unasked.
7. **Bundled defaults that auto-install catalog plugins, and the Nous Portal "Tool Gateway".** Routing search, image, TTS and browser through one third party undercuts our privacy tiers (TEE-only mode, per-member `privacy: private`).
8. **Honcho-style user modelling and auto-injected `USER.md`.** It profiles the person and re-injects that profile into every prompt. For an organization's tool, that needs a privacy decision first.
9. **Breadth for its own sake** (about 25 messaging platforms, skins, pets, wake word). Our relay's deliberate three-channel scope, with adversarial tests first, is the right posture.

---

## 8. Should our teams use Hermes's plugin system, or one like it?

### 8.1 Options weighed

| Option | Verdict | Reasons |
|---|---|---|
| (a) Adopt Hermes plugins directly or interoperate | **No** | Python runtime and in-process execution. We would have to ship or require a Python 3.14 environment, against the VSIX's zero runtime dependencies. Its `ctx` API is shaped around Hermes internals (gateway, kanban, desktop). Its own docs say capabilities are not isolation, so it fails the gate test outright. |
| (b) Our own plugin format modelled on Hermes | **No, as a code-plugin system** | Copying `register(ctx)` in TypeScript would put third-party code in the extension host: the same trust problem, inside VS Code. |
| (c) MCP servers plus our markdown team, agent and skill files | **Yes, as the base** | Out of process by construction. We already have a hardened client (confirmed stdio commands, https remotes, untrusted results, per-server approval). Theia AI and IronClaw speak MCP natively. Our markdown formats already port. |
| (d) Hybrid: (c) plus a thin signed package manifest with an enforced capability block | **Recommended** | It adds what (c) lacks: provenance, pinning, capability declaration mapped to DIDs, and one install and consent flow. It still never runs package code in-process. |

### 8.2 The recommended package

```
my-package/
  plugin.json          # Agent Plugins v1 shape (name, version, description) plus our extension block
  skills/<name>/SKILL.md
  agents/<name>.md     # agent and team-member definitions (our format)
  teams/<name>.md      # optional team template
  mcp.json             # stdio or Streamable HTTP servers, never via a shell
```

`plugin.json` carries a `near-ai` extension block (proposal):

```json
{
  "extensions": {
    "near-ai": {
      "capabilities": [
        {"verb": "mcp", "server": "issues", "tools": ["list", "get"]},
        {"verb": "network", "hosts": ["api.example.com"]},
        {"verb": "spend", "usd_per_run": 1}
      ],
      "privacy": "private",
      "execution": "container",
      "signature": {"signer": "did:near:...", "sha": "<40-hex commit>"}
    }
  }
}
```

### 8.3 How the package behaves

- **Compatibility:** we read the Agent Plugins v1 layout (skills plus `mcp.json`), since we already parse `SKILL.md` and MCP config. That gives cheap interoperability with Hermes portable packages and others, without their (absent) trust model.
- **Enforcement:** declared capabilities become the ceiling for any agent that uses the package. They are intersected with the agent's DID at run time and enforced by the gate, and by the sandbox or proxy for the MCP process (H3).
- **Lifecycle, copied from Hermes:**
  - disabled after install;
  - exact SHA pin;
  - a capability diff on update, with re-consent;
  - a scan with a non-overridable "dangerous" verdict;
  - packs with a review screen and no secrets.
- **Signing and audit:**
  - Packages and their consent are signed: the publisher's DID or key, plus the person's consent event in the signed log.
  - Team templates and learned skills (H5) use the same pipeline, so there is one review UX.
- **Hermes or IronClaw as the base:** IronClaw's tool model.
  - Its `capabilities.json` is enforced (WASM sandbox, proxy allowlist, credentials the tool never sees, rate limits). That is what a DID constraint needs.
  - Hermes's capabilities are only consent records.
  - Take Hermes's lifecycle UX and attenuation rules on top of IronClaw's enforcement.
  - If the core stays in TypeScript, apply the same split: MCP plus OS sandbox instead of WASM.

---

## 9. Before or after the Theia move?

### 9.1 What Theia offers today

Sources:
- https://theia-ide.org/docs/theia_ai/ and https://theia-ide.org/docs/user_ai/
- https://eclipsesource.com/blogs/2026/04/16/eclipse-theia-1-70-release-news-and-noteworthy/
- https://eclipsesource.com/blogs/2026/07/07/eclipse-theia-1-73-release-news-and-noteworthy/
- https://eclipse-theia.github.io/vscode-theia-comparator/status.html
- https://theia-ide.org/releases/

What it provides:
- **Version and licence:** latest v1.77.0 (2026-11-05); monthly releases, quarterly community releases; EPL-2.0.
- **Theia AI:**
  - chat agents as InversifyJS services;
  - custom agents as `.agents/agents/<id>/agent.md` (YAML frontmatter plus prompt);
  - Agent Skills (`SKILL.md`, alpha);
  - prompt fragments, variables and tool functions (`~{toolId}`);
  - agent delegation;
  - an MCP client (local and remote, OAuth 2.1 since 1.73) and an MCP server package;
  - per-tool confirmation (Disabled, Confirm, Always Allow; Confirm by default; shell allow and deny lists; a banner when loosened; untrusted workspaces cannot loosen);
  - an AI Configuration view and history.
- **VS Code compatibility:**
  - Supported API level is 1.144.0.
  - Webviews, webview views, tree views, custom editors, authentication and `SecretStorage` are supported.
  - `lm.registerTool` and `lm.invokeTool` are supported since 1.73, and tools registered that way join Theia AI.
  - **`chat.createChatParticipant` and `lm.selectChatModels` are stubbed.**
- **Caveat:** API keys entered in Theia AI settings are stored in clear text, per Theia's docs as relayed by the research pass. Our product must keep its own SecretStorage-backed handling.

### 9.2 What ports and what is rebuilt

| Layer | Ports to Theia for free? | Notes |
|---|---|---|
| Agent core (`src/agent/`, no vscode imports; already composed headlessly by the relay) | Yes | Or it is replaced by IronClaw as a service |
| Policy gate, capability grammar, DID client, signed event log | Yes | Pure TypeScript or Rust |
| Skill, agent, team and package formats; MCP client | Yes | Theia AI also reads `SKILL.md` and `agent.md`, so keep our formats close to those |
| Relay and scheduler | Yes | Separate service |
| Team Studio and chat webviews | Partly | Webviews run in Theia as a VS Code extension, but the native experience means Theia widgets or Theia AI agents |
| `@nearai` chat participant | No | Stubbed in Theia; rebuild as a Theia `ChatAgent` |
| VS Code commands, settings, SecretStorage, trees | Mostly | Supported by Theia's plugin host |

### 9.3 Recommended sequencing

1. **Now, editor-agnostic.**
   - H1 (capability grammar and gate with the floor) and H2 (attenuation) in the core.
   - H4 inside relay Phase 73.
   - The package manifest and lifecycle (section 8) for templates, skills and MCP bundles.
   - These are needed under any editor and under IronClaw, and they are the substrate the DID work plugs into.
2. **Now, but minimal UI.**
   - Surface proposals, capability diffs and delegation chains with small additions to existing webviews: the Agent Activity view, Team Studio tabs and the MCP view. Avoid large new webview investments.
3. **With or after the core decision (IronClaw or not).**
   - H3 (execution sandbox and OpenShell), M1 (schedules as standing orders) and M2 (agent use of the board) depend on where long-running work lives.
   - If IronClaw becomes the core, build them there; it already has routines, Docker workers and WASM.
4. **After the Theia move.**
   - Rebuild Team Studio and chat as Theia widgets or agents.
   - Register our tools so Theia AI's chat can call them, which also routes them through Theia's tool-confirmation UI on top of our gate.
   - Consider exposing teams through Theia's MCP server.
   - Running the existing VSIX inside Theia is a reasonable bridge for the first release, except for the `@nearai` chat participant.
5. **Last: H5 (learned skills).**
   - It needs H1, H4 and the signed log in place.
   - It should be designed with the DID approval provenance from day one.

---

## 10. Sources read

**Hermes Agent** (commit `ce4de3c`; GitHub base `https://github.com/NousResearch/hermes-agent/blob/main/`):
- Top level: `README.md`, `LICENSE`, `pyproject.toml`
- `website/docs/user-guide/`:
  - `features/plugins.md`, `features/plugin-catalog.md`
  - `features/skills.md`, `features/curator.md`, `features/memory.md`
  - `features/delegation.md`, `features/kanban.md`
  - `features/cron.md`, `features/goals.md`, `features/loops.md`, `features/heartbeat.md`
  - `features/mcp.md`, `features/tool-search.md`, `features/code-execution.md`, `features/mixture-of-agents.md`
  - `features/acp.md`, `features/web-dashboard.md`
  - `security.md`, `desktop.md`, `profiles.md`, `checkpoints-and-rollback.md`, `messaging/index.md`
- `website/docs/developer-guide/`: `plugins/index.md`, `agent-loop.md`
- GitHub API (repository metadata, release list)

**IronClaw:**
- https://github.com/nearai/ironclaw README
- `docs/capabilities/sandboxed-tools.mdx`, `docs/capabilities/skills.mdx`, `docs/extensions/overview.mdx`
- Directory listings of the repo root, `crates/`, `crates/kernel/` and `crates/extensions/`
- GitHub API metadata

**Our repo:**
- `origin/main`: `src/agent/*`, `src/services/agentSession.ts`, `src/services/chat.ts`, `src/gsd/*`, `src/mcp/*`, `src/domain/policy.ts`, `media/teams`, `media/chat`, `README.md`, `SECURITY.md`, `package.json`, `.planning/ROADMAP.md`, `.planning/PROJECT.md` (Verifiable agent guardrails)
- `origin/feat/messaging-relay`: `.planning/ROADMAP.md`, `relay/`
- `feat/team-fix-pass`: `src/domain/team/permissions.ts`, `src/team/` listing

**Theia:** the URLs in section 9.

**Not read:** NVIDIA OpenShell documentation. Its role in section 6 (H3) is the owner's proposal and is not verified here.

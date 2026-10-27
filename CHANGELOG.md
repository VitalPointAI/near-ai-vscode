# Changelog

## 0.4.0

A native agent that runs on NEAR AI's private models, with no proprietary
runtime in between.

- **Agent in the sidebar.** It reads, searches, edits and runs commands in your
  project, with approval cards that show diffs and commands, per-run grants,
  and one-click **Revert**.
- **Open-GSD workflows on NEAR AI.** `/gsd-…` commands run on the native runner
  with sub-agents (including background ones you can pause or stop), questions,
  and context management. Open-GSD is installed per user and checked against
  each new release. Parallel executors each work in their own git worktree on
  a `worktree-agent-…` branch (kept in the extension's storage, not your
  project), and GSD merges them back. Workflows that chain to the next command
  (`--auto`, `/gsd-next`) work too.
- **Agent teams.** Teams are Markdown files you edit, version, duplicate,
  archive and import. Run one with `/team:<name>`. **Set Up Project Team**
  drafts one from a few questions.
- **Attachments.** Images are read by a vision model and audio is transcribed
  with Whisper. PDFs, .docx, .pptx, and .xlsx are read on your machine and
  their text is included, as are text files.
- **Requires VS Code 1.101 or newer**, which runs extensions on Node 22 or
  later (Node 20 is end of life).
- **Image generation** with NEAR's image models, saved through checkpoints.
- **Project memory.** Remember and Recall, reviewed with **Manage Project
  Memory**.
- **Verify signature.** Checks NEAR's signature over the exact request and
  response, and that a genuine Intel TDX quote, fresh for this check, binds
  the signing key.
- **Local and hybrid runtimes.** Ollama, LM Studio, vLLM, or any
  OpenAI-compatible server, alone or alongside NEAR AI Cloud.
- **Agent Activity.** A live page of every agent's prompts, replies,
  reasoning, and tool calls with per-agent tokens, cost, speed, and failures;
  pause, filter, search, and export. In memory only, time- and size-limited,
  and streamed only while visible.
- **MCP connections.** Add remote or local MCP servers (official SDK client),
  switch them on per project, scope them to team members with `mcp:<server>`,
  choose approval per server, switch tools off, and see status and usage on
  the MCP Connections page. Secrets stay in SecretStorage; tools that can
  change data ask in every mode by default; results are fenced as outside
  content.
- **Privacy hardening.** Saved conversations are encrypted at rest
  (AES-256-GCM, key in SecretStorage); environment variables that look like
  credentials are kept out of the agent's shell (`nearAi.agent.shellEnvAllow`
  to pass specific ones) and out of the Open-GSD installer; the search setup
  says that Brave and Tavily keys link queries to your account; SECURITY.md
  lists every connection the extension makes.
- **Prompt caching counted and kept effective.** NEAR caches prompt prefixes
  automatically; estimates and run budgets now price cached input at NEAR's
  cache-read rate (GLM 5.3: $0.45 instead of $1.80 per million), context
  trimming advances in steps so the cached prefix stays stable, and Agent
  Activity shows each agent's cache hit rate.
- **Runaway protection.** A run and all its sub-agents stop cleanly, keeping
  their work, at a per-run cost cap (`nearAi.agent.maxRunCostUsd`, default $5),
  what is left of the daily spend limit, or a token cap, checked before every
  model turn; an agent repeating the same action is nudged and then stopped.
  Each reply is capped at `nearAi.agent.maxOutputTokens` (default 32,000,
  never above the model's limit); a reply cut off there is followed by a
  request to continue more concisely, and repeated cut-offs stop the agent.
  An approval nobody answers is declined after
  `nearAi.agent.approvalTimeoutMinutes` (default 15) so an unattended run
  carries on, and a notification appears when an agent is waiting while the
  chat is hidden. **NEAR AI: Spending Limits** shows today's spend and changes the daily,
  per-run cost, and per-run token limits for you or one workspace.
- **Project types.** Set Up Project Team now starts from a project type
  (software, research, presales, writing, data, general) with a tailored team
  and AGENTS.md guidance for each stage of the GSD cycle, including a red-team
  stage before verification whose unfixed findings are always reported.
- **Agents read AGENTS.md and CLAUDE.md** project instructions.
- **Web search and prompt-injection defenses.** WebSearch (SearXNG, Brave,
  or Tavily), WebFetch for pages and documents, and CheckCitations for every
  agent. Hidden content is removed, likely injections are flagged and shown in
  Agent Activity, outside content is fenced, and after reading it, network
  commands, data-carrying URLs, and research agents' writes outside
  `.planning/` always ask, even in fully-autonomous mode.
- **SBOM and vulnerability checks.** A CycloneDX SBOM per project from its
  lockfiles (npm, pnpm, yarn, Python, Go, Rust, PHP, Ruby, .NET, Java), checked
  on OSV.dev with runtimes on endoflife.date; Problems entries, a status-bar
  shield, checks on open and on lockfile changes, an agent `SecurityScan`
  tool, and a GitHub Actions workflow. Asks once per project before sending
  package names and versions. The extension ships its own SBOM.
- **Graphics and decks.** Agents can trace images into SVG, render SVG to
  PNG, and build PowerPoint decks with sharp SVG images, all on this machine.
- **Resumable chats.** Conversation history is kept on this machine.
- **Runs recover by themselves.** If NEAR AI stops sending mid-answer for two
  minutes, drops the connection, or is busy, that step is retried (quickly at
  first, then every minute) and the run carries on from where it was. An
  answer that is still arriving is never cut off. **Stop** ends it.
- **Security hardening.**
  - Commands run without approval only when written as plain words.
  - `.git/` and the extension's settings are protected from silent writes.
  - Credential files ask first, however their path is written.
  - Fetches are restricted to public https addresses.
  - Sub-agents never use a less private model than the one you picked.
  - Keys are bound to their endpoint.
- **Default model:** GLM 5.3, which runs in NEAR's TEE.
- **Models per agent role** (`nearAi.agent.roleModels`): GSD's research,
  synthesis, and mapping roles default to the fast tier (GLM 5.3 Flash, also
  TEE-attested). In a live comparison it matched GLM 5.3 on coding, research,
  and planning tasks at about a twentieth of the cost, though more slowly;
  planners, executors, verifiers, and red teams keep their tiers. A team
  member's own `model:` line wins.

## 0.3.1

- Marketplace listing rewritten.

## 0.3.0

- Native VS Code chat styling and an `@nearAi` chat participant.
- The extension leaves projects it didn't set up untouched.

# Changelog

## 0.4.4

- **Prompts stay in view until you answer.** Approvals, agent questions and
  Open-GSD choices are pinned above the message box instead of scrolling away.
  When several wait, you step through them ("1 of 3 waiting"), each saying
  which agent asks. The chat keeps a line where each was asked that records
  the outcome. The sidebar shows a badge while anything waits, and a reloaded
  chat shows the prompts again.
- **Open-GSD runs without constant prompts in Auto.** The Open-GSD runtime the
  extension installs is trusted, so its workflow tool calls run. They still
  ask when a copy of the tool inside the workspace would run instead, or when
  the command was edited or does something risky.
- **Clearer reasons.** When Auto asks because the safety check was skipped or
  NEAR was too busy to answer, the card says so.
- **The approval menu says what each mode allows.** Each mode shows a
  one-line summary, and the menu works from the keyboard.
- **The task list collapses** like the running-agents panel.

## 0.4.3

- **Approval mode in the chat bar.** A picker beside the model chooses how
  much the agent may do without asking: Ask before edits, Edits auto, Auto,
  or Full auto. Full auto asks you to confirm first and shows in the warning
  colour. The choice is saved to your user settings, or to the project's when
  the project already sets it, and the next run uses it. During an emergency
  stop the picker shows **Stopped**.
- **No more pricing requests NEAR doesn't support.** The model list stops
  asking NEAR AI Cloud for prices once it answers that the request is not
  implemented.

## 0.4.2

- **Auto approve.** A new `auto` value for `nearAi.actionPolicy` runs what
  passes a safety check and asks only about the rest, with the reason on the
  card. Ordinary build, test, lint, git and in-workspace file commands run.
  Deleting, pushing, publishing or deploying, piping a download into a shell,
  uploads, credential or knowledge-base paths, and writes outside the
  workspace ask. A command the rules can't place goes to a private (TEE or
  local) model, `nearAi.agent.safetyModel`; if it errors, times out, or no
  private model is available, the command asks.
- **Rate limits no longer turn into a storm.** A 429 from NEAR AI is no longer
  retried within a fraction of a second. The agent waits as long as NEAR asks
  (`Retry-After`), with some randomness, and agents using the same model share
  one pause, so only one request checks whether the model is back. After about
  four minutes of continuous rate limiting the run stops and keeps its work,
  instead of retrying forever.
- **NEAR's own error message.** Failed requests show what NEAR said and the
  request ID, and the new **NEAR AI** output channel logs status, model,
  request ID and rate-limit headers.
- **The model list survives a failed refresh.** If NEAR is busy when the list
  is refreshed, the last good list keeps working.
- **Easier-to-read chat.** Code is smaller than the chat text and tinted, so it
  stands apart, and `#` and `##` headings step up in size. The running-agents
  panel collapses to one line, and stays collapsed across reloads.

## 0.4.1

- **Security fixes in the build tooling.** The packaging tool's dependencies
  `undici` (TLS certificate check bypass, cross-origin cache disclosure, and
  denial-of-service advisories) and `@azure/msal-node` (authorization code flow
  disclosure) are updated to fixed versions (7.30.1 and 7.1.2). Neither is part
  of the installed extension; they ran only when the extension was built.
- **Eval output stays out of the package.** Live model-eval results are no
  longer picked up when the extension is packaged.
- **Tests stay honest.** When an agent edits a test that existed before the
  task and it ends up with fewer tests or assertions, or more skipped cases,
  the agent is told at once and reminded before it may finish. It restores
  the test and fixes the code, or says why the change was asked for. In the
  model eval, a cheaper model had "passed" a task by deleting the failing
  assertion.

## 0.4.0

A native agent that runs on NEAR AI's private models, with no proprietary
runtime in between. It is built for more than coding: research, presales and
solution design, writing, and data analysis projects get their own teams and
workflows.

- **See progress as it happens.** Each running agent shows what it is doing,
  how long it has run, and its tool calls. Click one to open its activity. A
  progress line in the chat sums up long, quiet stretches.
- **Fewer, faster turns.** Web searches and page fetches an agent asks for
  together now run in parallel, like file reads, and agents are told to batch
  independent lookups. Agent Activity shows where each agent's time goes
  (waiting, generating, tools) and how much of its output is reasoning.

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
  synthesis, and mapping roles default to the fast tier (Qwen3.6-35B-A3B, also
  TEE-attested). In a live eval of 24 tasks per model it researched as well as
  GLM 5.3 at about a tenth of the cost and several times the speed of GLM 5.3
  Flash, but cut corners on tests when building code, so planners, executors,
  verifiers, and red teams keep GLM 5.3. A team member's own `model:` line wins.

## 0.3.1

- Marketplace listing rewritten.

## 0.3.0

- Native VS Code chat styling and an `@nearAi` chat participant.
- The extension leaves projects it didn't set up untouched.

# Changelog

## Unreleased

- **The chat asks you to connect NEAR AI first.** Until the project has a
  working profile (a saved NEAR AI key or local runtime that was checked
  and works), the empty chat shows only **Connect NEAR AI to start** with a
  **Set up a new profile** button. If a saved profile needs its key checked
  again, or you have saved profiles but none is chosen for this project, it
  also offers **Choose a profile** and says why. With no folder open, it
  asks you to open one first. The suggestions to start a new project,
  onboard an existing one or show progress appear once you are connected,
  without reloading. The new command **NEAR AI: Set Up a New Profile**
  starts the same setup, and the chat's sign-in message now offers the same
  two buttons.
- **After you connect NEAR AI, the extension suggests what to do next in
  the chat.** The chat comes into view, and nothing opens over your work.
  If the project has no team yet, the chat starts with setting up your
  project team, and a short message says your next steps are in the chat.
  If the project already has a team, the message offers **Review project
  team** and **More setup steps**.
- **NEAR AI: Project Setup** lists every setup step: your project team, a
  spending limit, web search, or going straight to the chat. Steps you have
  done are marked done. It is also on the Tools tab, and the chat's card
  links to it.
- **The empty chat shows a small card while the project has no team**, with
  a button to set one up and an **All setup steps** link. **Not now** hides
  the card for this project only.
- **The NEAR AI welcome page has a new step, Choose your team**, right after
  connecting NEAR AI, with a button to set up your project team.

## 0.4.13

Replies in the chat are easier to read. Tables, quotes and crossed-out text
now show the way the model wrote them, and links in replies open the right
page.

- **Tables in replies now show as real tables** with headers and lined-up
  columns. Before, a table showed up as lines of text full of dividers and
  dashes. Wide tables scroll sideways inside the message, and keep their
  place while the reply is still arriving. To scroll one with the keyboard,
  press Tab until the table is selected, then use the arrow keys. Screen
  readers name each table by its column headings.
- **Quoted text stays together as one quote**, and crossed-out text shows
  crossed out. Before, each line of a longer quote showed as a separate
  quote, and crossed-out text showed with its marks around it.
- **Links in replies open the right page** even when the address has
  characters like underscores, tildes or asterisks in it. Before, some of
  these links went to a broken address.
- **Reporting a security problem is now private.** The security notes
  explain how to send a report that only the maintainers can see, from the
  Security tab of the project's GitHub page.

## 0.4.12

An agent doing useful work could be stopped as if it were stuck, and the chat
then blamed the turn limit. This release fixes the stuck-agent check and makes
every stop honest and easy to continue.

- **Productive runs are no longer stopped as loops.** The check compared shell
  commands by their first two words, so an agent that starts every command
  with `cd <folder> &&` looked like it was repeating one action: a run doing
  `cd <folder> && npm test`, `cd <folder> && git status`, and so on was
  stopped after 14 different commands. The check now compares the whole
  command (ignoring a leading `cd <folder> &&` and variable settings), and an
  action counts as repeated only when it also gave the same result as before.
  If the output changed, it is progress, not a loop.
- **A stuck agent gets a chance to recover.** An agent that really does repeat
  the same action with the same result is first nudged, then warned that its
  result has not changed and told to change approach (try a different
  command, read the error, or finish and report). It is stopped only if it
  still repeats after that.
- **An honest stop, with Continue.** A stopped run now says why: "Stopped: the
  agent kept repeating <action> with the same result.", or, when the turn
  limit was really reached, "Stopped after reaching the turn limit (<N>
  turns)." Both come with a **Continue** button that sends "Continue." for
  you, so you no longer have to type it. Nothing continues until you click.
  Agent Activity history shows such runs as "Stuck", and a sub-agent that is
  stopped tells the agent that started it that it did not finish.

## 0.4.11

Agent runs in code-server (VS Code in a browser) could stop or stall without
any sign in the chat. This release makes those interruptions visible and
recoverable.

- **A run cut off by code-server or a reload can be resumed.** When a
  code-server tab stays disconnected (Chrome pauses background tabs) while
  another code-server tab connects, code-server closes the window's extension
  host about 5 minutes later. Every run in that window died, and the window
  came back empty: one run had made 79 requests and never finished. A reload
  or a crash has the same effect. Runs now save their state after every step
  and record when they start and end, in the extension's own storage on this
  computer (IDs, times, and tool names only). When the chat opens again, the
  conversation is reopened and says "This run was cut off (the window or
  code-server closed it) at" the time, with **Resume** and **Dismiss**.
  Resume continues from the last saved step and tells the agent which steps
  had started but were never recorded, so it checks whether they already
  happened instead of doing them twice. Nothing resumes until you click.
- **Waiting approvals and questions are noticed in a background tab.** The
  "waiting for your approval" notice only appeared when the chat was hidden,
  and a background browser tab still counts as showing the chat, so nothing
  told you. The notice now also appears when the VS Code window (or its
  browser tab) is not focused, and when you come back to the window while a
  prompt is still waiting and was not announced yet. It never appears twice
  for the same prompt, and the waiting badge stays.
- **Advice for code-server and remote windows: proxy support.** VS Code's
  proxy support (`http.proxySupport`, on by default) asks the window which
  proxy to use for every new network connection. A browser tab that the
  browser has paused cannot answer, so every new connection waited: one run
  made no requests for 26 minutes and carried on the moment its tab was shown
  again. When VS Code runs in a browser or a remote window, proxy support is
  on, and no proxy is set (no `http.proxy` setting and no `HTTP_PROXY` or
  `HTTPS_PROXY` variable), the extension now explains this once and offers
  **Turn off proxy support**, which sets `http.proxySupport` to `"off"` in
  your user settings, and only when you click it. **Not now** asks again in
  two weeks; **Don't ask again** never asks.
- **Tip for code-server users:** if you don't use a proxy, set
  `"http.proxySupport": "off"` in your user settings. Keep the code-server tab
  open during long runs: code-server's 5-minute cap on a disconnected window
  can still stop runs, and Resume then picks them up.

## 0.4.10

- **Usage reporting no longer looks broken while NEAR AI Cloud is missing its
  usage summary.** NEAR AI Cloud documents the usage summary that a reporting
  token reads, but it currently answers HTTP 404 to it. The token test used to
  report that as a failure and offer **Fix token**, which could not help.
  Now the token is kept and its test says it is saved. The figures are this
  computer's own, and NEAR is asked again every hour, so NEAR's total appears
  on its own once NEAR turns the summary on.
- **The token's messages agree with each other.** The token link said "Using
  NEAR's total" whenever a token was stored, while the spend tooltip still
  said to set one. Both now follow the same state: using NEAR's total, waiting
  for NEAR's first answer, NEAR not offering its total yet, or NEAR's total
  failing. Without a token they say how to set one.

## 0.4.9

- **Signing in works from code-server on another computer.** When VS Code runs
  in the browser (code-server) and that browser is on a different computer, for
  example over Tailscale, NEAR AI Cloud sent the sign-in to a `localhost`
  address on the browser's computer, which doesn't load, and the setup waited
  until it timed out. VS Code now shows a box for the sign-in address as soon as
  the browser opens: copy the address of the page that won't load into it and
  the token is made. If the browser is on the same computer, the sign-in still
  finishes on its own and the box closes.

## 0.4.8

- **Set up usage reporting by signing in.** **Set Usage Reporting Token** (and
  every "set up usage reporting" link) now offers **Sign in with GitHub** or
  **Sign in with Google**. You sign in to NEAR AI Cloud in your browser once, and
  the extension creates a read-only usage token with no expiry. It tests the
  token and starts showing NEAR's own spend figures, with no console session
  token to find and no API call to make by hand. The sign-in is used once and
  then signed out; only the read-only token is kept, in VS Code's encrypted
  secret storage. Signing in again replaces the token and revokes the old one.
  Needs an owner or admin of the API key's organization. Pasting a token still
  works.
- **Fix token signs in again.** When NEAR rejects the token, **Fix token** in
  Agent Activity and in the test result goes straight to the sign-in instead
  of to Settings.

## 0.4.7

- **The guide covers 0.4.6's features.** The README, which is also the Marketplace page, now explains
  Compare Models, the approval card's "Always allow" button and what Auto
  approve clears on its own, and the Spend section in Agent Activity. The
  `nearAi.agent.allowCommands` row in the settings table describes how
  entries are matched. No change to how the extension works.

## 0.4.6

- **Auto approve asks far less.** The safety check's model often used up its
  answer length thinking and never gave a verdict, so the command asked you
  ("the safety model's answer could not be read"). It now answers directly,
  falls back to a second private model when the first is busy, and the card
  says exactly why a check failed. The rules also clear more everyday work on
  their own: deleting single files and build output (dist, node_modules, …),
  installs from the lockfile, git pull, fetch, switch, stash, merge, revert and
  cherry-pick, sed and awk that only print or substitute, wildcards that can
  only match inside the workspace, and the project's own node_modules tools.
- **Always allow from the approval card.** "Always allow "git push" in this
  workspace" adds the command to `nearAi.agent.allowCommands` and applies at
  once, including to each part of `cd app && git push`. Entries stay narrow:
  `npm run build` rather than all scripts, never `--force`, a typed URL, `rm`,
  `curl`, or an interpreter like `node` or `bash`.
- **After a web search or MCP result, the safety check still runs.** Unclear
  commands go to the private safety model, which is told the run read outside
  content and is stricter; commands that can reach the network still ask.
- **NEAR AI: Compare Models.** A leaderboard ranks every model you have tested
  (overall score out of 10, coding, research, planning and execution, pass
  rate, speed, cost, stalls, privacy, and the roles it holds). Below it, pick
  2–6 models, see a cost estimate before anything is spent, and either reuse
  saved results (so only a new model is run) or run everything again. Every
  comparison is saved. "Use as…" puts a model into the main, deep, standard or
  fast slot or an agent role in one click, with Undo. Also on the Tools page.
- **Agent Activity shows where costs come from.** A Spend section says whether
  figures are actual NEAR billing (your usage reporting token works), reconciled
  per request, or estimated from list prices, with **Test token now** and **Fix
  token**. It shows spend for today, this week, this month and this year, the
  7-day burn rate, and **Top up credits** (opens the NEAR AI Cloud console;
  NEAR has no payment link that works without signing in, and its API does not
  give the remaining balance to an API key or reporting token). A stored
  reporting token is now used from the start, not only after the first chat.

## 0.4.5

- **Team Studio.** **NEAR AI: Team Studio** shows your teams as cards (members,
  roles, models with TEE / Local / Forwarded badges) and walks you through
  building one: purpose and a starting point, members and roles, models, tools
  and what each will run or ask, then instructions with a live preview of the
  Markdown it saves. Existing teams open in tabs with version history, diffs
  and restore. The Markdown file stays the source of truth: anything you wrote
  by hand is kept, and edits made outside the studio are picked up. Leaving with
  unsaved changes asks first, and closing the panel keeps them as a draft.
- **A reply that stops is retried, then reported.** A model reply that NEAR cuts
  off, or that stops sending anything, used to end the run silently with no
  answer. It is now retried up to three times, and then the chat says which
  model stopped responding and that your work is kept. Agent Activity shows the
  run as failed instead of running. Stop now ends a reply immediately.
- **Set up exact spend tracking from Settings.** The NEAR AI settings, the chat's
  spend line, Spending Limits, Agent Activity and the Tools page link to **Set
  usage reporting token**, with how to create one. The token is kept in
  SecretStorage; one pasted into a setting by mistake is moved there.
- **Agent Activity keeps up.** Runs that finished quickly could be missing from
  History and the totals until something else changed. They now appear within
  about a second.
- Tool descriptions no longer stop short at "e.g.".

## 0.4.4

- **Several conversations at once.** Tabs above the chat let you start a new
  conversation while others keep running in the background. Each tab shows
  whether it is running, waiting for you, stopped or done, and a notice says
  when a background conversation needs you. Switching brings back its prompts,
  agents, tasks and draft. Stop stops only the conversation on screen; the
  emergency stop still stops everything. Open conversations come back after a
  reload, and a run cut off by the reload is marked stopped.
- **Redirect a running agent.** The message box stays open during a run, with
  separate Send and Stop buttons (Esc in an empty box also stops). A message
  sent mid-run reaches the agent after its current step and takes precedence
  over its plan. If the run ends first, it is sent as a new message.
- **Spend that matches NEAR AI Cloud.** Every billable call is recorded once,
  including sub-agents, Auto safety checks, summaries, attachments and images,
  and NEAR confirms each request's actual cost. The status line, Agent
  Activity, Spending Limits and reply footers all show the same figure:
  confirmed plus pending, or NEAR's own total when you set a usage reporting
  token (**NEAR AI: Set Usage Reporting Token**). "Today" is your local day
  (`nearAi.spend.dayBoundary`), and the daily limit uses the same figure. NEAR's
  spend-limit response is shown as "NEAR spend limit reached".
- **Agent Activity is an overview.** Running agents with their state (including
  "Rate limited · retry in 12s") and cost; totals for this conversation, today
  or the last 7 days, with the time split, tool calls, approvals and problems by
  model; and a history of past runs that opens each conversation. **Export
  details** still saves the raw record.
- **Export usage and activity.** **NEAR AI: Export Usage and Activity…** saves
  CSV or JSON by project and date range, with no prompt text.
- **The Tools page is a directory.** It lists the workflows, agents and teams,
  built-in tools (and whether each runs or asks under your approval mode), MCP
  servers and models the agents can use, with **Use in chat** buttons. The old
  second chat is gone. **Use in chat** keeps what you had typed.
- **Tasks keep up with sub-agents.** A listed task is marked done as soon as
  the agent working on it finishes, and each sub-agent's own steps show in its
  row ("1/2 steps").
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

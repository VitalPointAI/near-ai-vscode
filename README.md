# NEAR AI for VS Code

**Private AI agents for the work you do in VS Code: code, research, proposals,
writing, and data. You can see, steer, and afford them.**

Work with models running in NEAR AI Cloud's confidential (TEE) inference, with
every model clearly labelled private or not. Agents plan and carry out whole
projects through built-in Open-GSD workflows, with a team suited to the kind of
project. You see the model, tokens, and cost of every answer, and decide
exactly what is allowed to leave your machine.

![NEAR AI chat beside the editor in VS Code](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-chat.png)

## What you can use it for

- **Software development.** Agents read your code, make changes, run your
  build and tests, and review, red-team, and verify the work. Dependency scans
  write an SBOM and check every package for known vulnerabilities.
- **Research and analysis.** Researchers search the web with the provider you
  choose, read pages, PDFs, and Office documents, verify quotes against their
  sources, and write cited findings. Hidden text and likely prompt injections
  in what they read are caught and reported.
- **Presales and solution design.** Turn requirements and RFP documents into
  solution designs, bills of materials, and proposals. Connect the MCP servers
  you already use for live product, pricing, or account data, and produce
  PowerPoint decks with diagrams.
- **Writing and content.** Plan, draft, edit, and fact-check long documents,
  with an editor and a red-team reviewer before anything is final.
- **Data analysis.** Read spreadsheets and data files, analyse them with your
  own tools, and write up the results with charts and graphics.

**NEAR AI: Set Up Project Team** asks which kind of project you have and sets
up a team and workflow for it. Your files stay in your workspace, and work is
sent only to the model you pick.

## Why choose NEAR AI

- **You know where your work goes.** NEAR AI runs some models inside attested
  trusted execution environments and forwards others to third parties. Every
  model in the picker, and every reply, says which. Private models come first,
  and the default (GLM 5.3) is one of them. Transcripts are encrypted on disk,
  credentials are kept out of the agent's shell, and nothing is sent as
  telemetry.
- **It feels like part of VS Code.** A compact chat in the secondary side bar
  uses your theme and fonts. Prefer the built-in Chat view? Type
  `@nearai` there instead.
- **You always know the cost.** Every response shows the model, token count,
  and cost: estimated up front, then the actual amount when NEAR AI reports it.
  Each run has a cost budget and a daily spend limit you can adjust, and agents
  that repeat themselves are stopped before they waste money.
- **From idea to finished work, not just autocomplete.** Open-GSD turns a goal
  into requirements, phases, plans, and verified results. Agents do the legwork
  and you make the calls. The agents strip and Agent Activity show what every
  agent is doing as it works.
- **Pick models on evidence.** **Compare Models** runs the same coding,
  research, planning, and execution tasks on the models you choose, grades
  them with hidden tests, and ranks every model you have tested. One click
  puts the winner to work in any agent role.
- **You stay in control of what's sent.** Each message is checked before it
  leaves: likely secrets are held back, personal data asks first, TEE-only mode
  blocks forwarded models, and an emergency stop halts everything.

## Features

### An agent, not just a chat

Ask for a change and NEAR AI does the work in your workspace: it searches and
reads your code, edits files, and runs your build and tests, showing every step
as a row in the chat.

- **You approve what matters.** File edits show a diff and shell commands show
  the exact command before they run, with **Allow**, **Allow for this run**, or
  **Deny** (with a note on what to do instead). Reads and searches run freely.
  A command card also offers **Always allow "git push" in this workspace**,
  which adds a narrow rule to `nearAi.agent.allowCommands` and applies at once.
  Rules never cover `--force`, a typed URL, `rm`, `curl`, or an interpreter
  such as `node` or `bash`, and `npm run build` allows only that script.
- **Auto approve that stays out of your way.** In Auto mode, fixed rules clear
  everyday work on their own: reading and searching, builds and tests, git
  status, diff, commit, pull, fetch, switch, stash, merge, revert and
  cherry-pick, deleting single files or build output (`dist`, `node_modules`,
  `coverage`, …), installs from the lockfile, `sed` and `awk` that only print
  or substitute, and the project's own `node_modules/.bin` tools. Each part of
  a chained command such as `cd app && npm test` is checked on its own.
  Commands the rules can't decide go to a private safety model (with a second
  private model as fallback); risky or uncertain ones ask, and the card says
  why. After the run reads web pages or MCP results, the safety model is
  stricter and commands that can reach the network always ask.
- **Undo a whole run.** Every file the agent changes is snapshotted first, so
  one **Revert** puts them all back.
- **A visible plan.** Multi-step work keeps a task list above the input box.
- **Sub-agents you can see and steer.** Workflows hand work to sub-agents,
  in parallel or in the background; each running one appears above the input
  box with what it is doing now, how long it has run, its tool calls, and
  **Pause**, **Resume**, and **Stop**. Click one to see its full activity. When
  a long run has shown nothing new for a minute, a progress line in the chat
  sums up the running agents and the spend so far.
- **Long sessions stay on track.** Old tool output is trimmed and, near the
  model's limit, earlier history is summarized automatically (with a handoff
  saved for GSD). **History** opens any earlier conversation as a tab, with
  its full context.
- **Guard rails.** The agent can only touch files inside the workspace, asks
  before reading likely credential files (`.env`, keys), and never runs
  commands on your deny list.

![An edit waiting for approval, with its diff](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-approval.png)

### Chat that fits in your editor

- Streaming answers with formatted code, plus **Copy** and **Insert at cursor**
  on every code block.
- Pick any model NEAR AI offers, or one from a local runtime such as Ollama or
  LM Studio, from the input box, with pricing and privacy shown.
- **Several conversations at once**, as in Claude Code. Start a new one with
  **+** while others keep running in the background; each has its own run,
  approvals, queued messages, task list, model, spend, and draft. The tabs
  above the chat show which are running, which are waiting for you (the view's
  badge counts every waiting prompt, and a notice takes you there in one
  click), which stopped, and which have new output. Ctrl+Shift+[ and ]
  (Cmd on macOS) switch between them; Stop stops the one on screen, the
  emergency stop stops them all. Up to eight are open; closing a running one
  asks first, and its transcript stays in **History**. The open conversations
  come back after a reload (a run cannot continue across one, so it shows as
  stopped).
- **New Chat**, **History**, **Tools**, and **Set Up** live in the view's title
  bar, just like other VS Code views.
- **Tools** opens a directory of what the agents can use: every installed
  workflow and skill (grouped and searchable, with **Use in chat** to put
  `/name` in the chat box), agent roles and teams with the model each one
  gets, the built-in tools with whether each runs or asks under your current
  approval mode, your MCP servers and their tools, and the models your key
  can use with their privacy (TEE, local, or forwarded), context length,
  prices, and which settings use them. It updates when settings, the
  approval mode, the emergency stop, or MCP servers change.
- Keyboard-first, with screen-reader labels and reduced-motion support.

### Open-GSD workflows, one slash away

![Open-GSD command menu](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-commands.png)

Type `/` for every installed Open-GSD workflow: start a project, onboard an
existing codebase, discuss, plan, and execute phases, verify work, review code,
map the codebase, and more, with arguments such as `/gsd-plan-phase 3`.
Workflows run on the NEAR AI agent runner with your chosen model: their
sub-agents appear as activity rows, file changes ask for approval and can be
reverted, and when a workflow needs a decision it asks you right in the chat.
Open-GSD installs itself into the extension's own storage the first time you
run a workflow and stays current; your `~/.claude` setup is never touched.

![A planning workflow asking for a decision](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-workflow.png)

### Project types and red teaming

**NEAR AI: Set Up Project Team** first asks what kind of project this is:
software development, research and analysis, presales and solution design,
writing and content, data analysis, or general. Each type gets a tailored team
(for example architect, developer, reviewer, QA, and security for software;
investigator, source verifier, analyst, writer, and editor for research) and
guidance in `AGENTS.md`, which every agent reads, on how this kind of work goes
through the same Open-GSD cycle: plan, execute, **red team**, verify, audit,
release. The red-team member attacks the work before it is verified and
writes `RED-TEAM.md`; every finding is fixed or given a disposition with a
reason (accepted risk, deferred, disregarded), and verification and release
notes list the items not fixed. In these projects `/gsd-execute-phase`,
`/gsd-verify-work`, and `/gsd-autonomous` include the red-team step.

### MCP connections

**NEAR AI: Manage MCP Connections** adds Model Context Protocol servers, remote
(a URL) or local (a command), and shows each one's status, tools, calls,
errors, and last use. A server is off until you switch it on for a project.
Agents then get its tools as `mcp__<server>__<tool>`; a team member gets them
only if its `tools:` line lists `mcp:<server>`, so you can give a connection
to one team alone. Read-only tools follow your normal
approval rules; tools that can change data ask first in every mode unless you
mark the server Trusted, and the approval card shows exactly what is sent.
URLs (which may carry the access token), header values, and environment values
are stored in VS Code's encrypted secret storage.

### Compare Models

**NEAR AI: Compare Models** (also on the Tools page) shows which models do your
kind of work best, measured on real tasks rather than published benchmarks.

- **Leaderboard first.** The top of the page ranks every model you have
  tested, using the latest result for each task: an overall score out of 10,
  scores for coding, research, planning, and execution, pass rate, speed, cost,
  stalls, privacy (TEE, Local, or Forwarded), and the roles it holds now.
  Results older than 30 days, from a task that has since changed, or for a
  model NEAR no longer lists are marked, so the ranking reflects what is known
  today.
- **Choose what to run.** Pick 2 to 6 models, the full or short task set,
  and how many times to run each task (up to 3). The tasks run in a temporary folder outside your
  workspace, and answers are graded by tests the models never see.
- **See the cost first.** The page estimates the cost from NEAR's prices
  before anything runs, and asks you to confirm. Each task run stops at
  `nearAi.agent.maxRunCostUsd`, and the comparison stops at your daily limit.
- **Quick or full.** **Reuse saved results** runs only what is missing, so
  testing a new model against ones you tested before costs only the new
  model's runs. **Run everything again** repeats every task.
- **Every run is saved** on this computer (in the extension's storage, not
  the project) and listed under History, so you can reopen its report.
- **Use as…** puts a model into the chat's main model, the deep, standard, or
  fast tier, or an agent role in one click, with **Undo**. Models that aren't
  private can't be chosen in TEE-only mode.

### Agent Activity

**NEAR AI: Open Agent Activity** (the pulse button on the chat view, or
**Activity** next to running agents) is an overview of agent activity; the chat
itself shows the work. **Now** lists the agents running: role, model (with a
TEE, Local, or Forwarded badge), what each is doing (thinking, writing, running
a tool, waiting for you, rate limited with the time until it retries, paused),
elapsed time, turns, tool calls, and cost so far, with **Pause**/**Resume**
(sub-agents), **Stop**, and **Show in chat**. Clicking an agent's label in the
chat opens the page on its row. The overview for **This conversation**,
**Today** (by `nearAi.spend.dayBoundary`), or the **Last 7 days** shows runs and
agents, where the time went (generating, tools and sub-agents, waiting for you,
waiting on NEAR), tokens in and out, cost (confirmed and pending, or NEAR's own
figure today), tool calls by tool, approvals (auto-allowed, asked, declined,
expired), and problems (429s, retries, errors, stopped runs) by model, so NEAR
capacity trouble on one model stands out. **History** lists past runs, newest
first: when, the first line of what was asked (redacted, about 80
characters), agents, duration, cost, and outcome; clicking one opens that
conversation in the chat. The page reads the project's activity history
(`.planning/.near-ai/activity.json`: ids, counts, tool and model names, no
content) and the spend ledger (below), so it survives reloads. **Export
details** saves the prompts, replies, and tool calls still kept in memory (for
`nearAi.activity.retentionMinutes`, 60, and up to `nearAi.activity.maxMegabytes`,
8 MB; secrets masked) as Markdown or JSON, for debugging.

**NEAR AI: Export Usage and Activity** (also on the Agent Activity page and in
the Tools tab) saves usage for an organization, a project, or everything, over
today, the last 7 or 30 days, or custom dates, as CSV or JSON: one row per run
(time, organization, project, conversation and run IDs, the redacted first line,
agents, models, tokens in and out, cost confirmed and pending, outcome) and per
model (runs, requests, tokens, cost, 429s, retries, errors), with NEAR's own
total for today when a usage reporting token is set. No prompt or reply
content. The save dialog starts in Downloads, and it warns before saving into a
git work tree.

### Spend

Every billable NEAR AI response is recorded where the extension talks to NEAR,
whatever sent it: the agent and its sub-agents (foreground and background),
the auto mode's safety checks, context summaries, attachment reading
(vision and transcription), image generation, and the `@nearAi` chat
participant. Streams that break off or are stopped are recorded too, with
NEAR's request ID. Each API key has its own spend ledger on this computer
(in the extension's storage, shared by all VS Code windows; the key itself is
never stored), and every spend figure is a sum over it: the chat's status
line, **Spending Limits**, Agent Activity, the "about $X so far" progress
line, and the cost under each answer.

Each entry starts at its estimate (NEAR's per-token, per-request, and
per-image prices) and is then settled with NEAR's actual cost from
`/v1/billing/costs`: asked about 5 s, 30 s, 2 min, and 10 min after the
response, in batches, even after a reload. Figures say how sure they are:

- **confirmed**: NEAR's billing API reported the actual cost.
- **pending** (`~$`): waiting for NEAR to report it; shown at the estimate.
  A request NEAR still reports no usage for after 10 minutes is settled as $0.
- **est.**: NEAR returned no request ID to check (for example a request
  cancelled before NEAR answered), so only the estimate is known.
- **(NEAR)**: NEAR AI Cloud's own total for your API key today, from every
  computer using it, so the figure matches the NEAR AI console exactly. This
  needs a usage reporting token, which you add with **Set Usage Reporting
  Token** (stored in VS Code's encrypted secret storage, never in settings;
  **Clear Usage Reporting Token** removes it). The extension then asks NEAR
  once which organization and key ID your API key has (`/v1/check_api_key`)
  and reads the key's usage summary every minute while runs are going and
  every 5 minutes otherwise.

**Where to set the usage reporting token.** Any of these runs **NEAR AI: Set
Usage Reporting Token**:

- **Settings** (search "NEAR AI" or "usage reporting"): `nearAi.spend.useNearUsageTotal`,
  next to the daily limit, has **Set usage reporting token** and **Clear**
  links. The setting itself is only an on/off switch (on by default) for using
  NEAR's total once a token is set; a token pasted into any NEAR AI setting is
  moved to secret storage and removed from settings.
- **The chat**: below the status line, "Match the NEAR console exactly: set a
  usage reporting token" (or "Using NEAR's total" once one is set).
- **Spending Limits**: **Set usage reporting token…** and **Clear usage
  reporting token**.
- **Agent Activity**, above the overview's cost, and **Elsewhere** in the Tools tab.
- The Command Palette: **NEAR AI: Set Usage Reporting Token**.

**How to get one.** The token is not in the NEAR AI Cloud console's UI: an
organization owner or admin creates it with
`POST /v1/organizations/{org_id}/reporting-tokens`, authenticated with a
console session token (see NEAR's [Usage Reporting API](https://docs.near.ai/)).
It is read-only and starts with `rpt-`.

Without a token the status line reads like "$0.40 confirmed + ~$0.02 pending
today" for this computer; hover it for details. "Today" is the local calendar
day (`nearAi.spend.dayBoundary`: `local`, or `utc`). A reply's footer shows the
run's total (sub-agents, safety checks, and summaries included), replaced by
NEAR's confirmed figure once every request in the run is settled.

`nearAi.dailySpendLimitUsd` is checked before every request and before every
model turn against the larger of NEAR's total (when a token is set) and this
computer's confirmed plus pending spend; a run that reaches it stops and keeps
its work. `nearAi.agent.maxRunCostUsd` caps one run by its own ledger entries.
If NEAR itself refuses a request with HTTP 402 (credits or the key's spend
limit used up), the chat says "NEAR spend limit reached".

**Agent Activity** shows each run's agents, models, tokens, and cost, and
**Export details** saves them as Markdown or JSON. Its **Spend** section
answers "is my usage reporting token working?": it says whether figures are
NEAR's actual billing (the token works), settled per request, or estimated
from list prices, with **Test token now** and **Fix token**. It also shows
spend today, this week, this month, and this year, the 7-day burn rate, and
**Top up credits**, which opens the NEAR AI Cloud console. NEAR has no
top-up link that works without signing in, and its API doesn't give the
remaining balance to an API key or reporting token, so the balance and time
until it runs out aren't shown.

### Teams, attachments, images, and memory

- **Agent teams.** A team is a Markdown file you edit in VS Code: one
  `## member` section per member, with optional `role:`, `model:` (a model ID
  or deep/standard/fast), and `tools:` lines. Run one with `/team:<name> <task>`
  or **Manage Agent Teams**; a lead agent delegates to the members as
  sub-agents, each limited to its own tools. Saving a team file records a
  version. Teams can be duplicated, archived, restored, imported, and deleted.
  **Set Up Project Team** asks a few questions and drafts a team for the
  project in `.planning/.near-ai/team.md` for you to review. In Team Studio,
  leaving the builder or the editor with unsaved changes asks first (Discard
  changes, or Save draft / Save); closing the tab keeps the unsaved team as a
  draft and says so the next time the studio opens.
- **Attachments.** Attach images, audio, documents, and text files to a
  message. Images are read by the chosen model if it reads images, otherwise
  by a vision model (`nearAi.agent.visionModel`); audio is transcribed with
  Whisper. The chat says which model handled each file. PDFs (with a text
  layer), Word (.docx), PowerPoint (.pptx, with speaker notes), and Excel
  (.xlsx, every sheet) are read on your machine, and only their text is sent.
  Scanned PDFs, the old .doc/.ppt/.xls formats, and video are not supported.
- **Graphics and slides.** Agents draw diagrams and icons as SVG, turn
  supplied images into SVG with VectorizeImage, render SVG to PNG, and build
  PowerPoint decks (.pptx) with CreatePresentation. All of this runs on your
  machine.
- **Image generation.** When the provider lists an image model, the agent can
  create PNGs in your workspace with its GenerateImage tool. It asks first and
  shows the price, and **Revert** removes the file.
- **Project memory.** The agent saves durable facts with Remember, looks them
  up with Recall, and starts each run with the facts relevant to your request.
  Memory stays on this machine and refuses secret-looking content. Review,
  correct, retract, export, or reset it with **Manage Project Memory**.

### Respects your projects

The extension only acts in projects you set up with it. Opening a folder,
the sidebar, or a status view never adds files. Open-GSD is installed only
when you run a workflow and it's missing, and the extension never adds its own
copy of Open-GSD to a project that doesn't already have one.

## Get started in two minutes

1. Install **NEAR AI for VS Code** and open a project folder.
2. Run **NEAR AI: Set Up** from the Command Palette.
3. Choose where models run: **NEAR AI Cloud** (create a key at
   [cloud.near.ai](https://cloud.near.ai/)), a **local runtime** (Ollama, LM
   Studio, vLLM, or any OpenAI-compatible server), or **both**, picking a cloud
   or local model for each chat.
4. Open the **NEAR AI** view in the secondary side bar and start chatting, or
   type `/new-project` to plan something new.

## Security and privacy

- **Web research with guard rails.** Agents search with the provider you pick
  (**NEAR AI: Set Up Web Search**: your own SearXNG, Brave Search, or Tavily),
  read pages and documents with WebFetch, and verify quotes with
  CheckCitations. Hidden text is stripped, likely prompt injections are
  flagged, outside content is fenced as data, and after reading it, commands
  that could send data out always ask. Agent Activity shows each detection.
- **Dependency checks.** **NEAR AI: Scan Dependencies for Vulnerabilities**
  writes an SBOM (`sbom.cdx.json`, CycloneDX) from your lockfiles and checks
  every package on OSV.dev and your runtimes on endoflife.date, after asking
  once per project; only names and versions are sent. Findings appear in
  Problems and the status bar, it re-checks when the project opens and when
  lockfiles change, and agents run the same check after changing
  dependencies. **Add Dependency Scan Workflow** adds a GitHub Actions scan.
- API keys live in VS Code's encrypted **SecretStorage**, scoped to each
  project. They are never written to settings, workspace files, logs, history,
  or exports.
- Keys are only sent over **HTTPS**. Plain HTTP is allowed only for a model
  runtime on your own machine (`localhost`).
- A **privacy check** runs on every chat message before it is sent. Likely
  credentials and private-file paths are held back (you can send a message once
  anyway), personal data asks first, and `tee-only` mode blocks models NEAR
  forwards to other providers.
- **Verify signature** on an answer from a private model checks NEAR's
  signature over the exact request and response, and that a genuine, fresh
  Intel TDX quote binds the signing key. See [what it does and doesn't check](SECURITY.md#checking-a-responses-signature).
- The chat view only receives display data; credentials and raw context stay
  in the extension host.
- The extension never reads `~/.near-credentials` or other local wallet files.

Read the full [security and trust report](SECURITY.md).

## Requirements

- VS Code 1.101 or newer (it runs on Node 22 or later; Node 20 is end of life).
- A NEAR AI Cloud API key, a local OpenAI-compatible runtime, or both.
- For Open-GSD workflows: npm access, so Open-GSD can be installed the first
  time you run one.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `nearAi.defaultModel` | `z-ai/glm-5.3` | Model used for new chats. |
| `nearAi.actionPolicy` | `approve-risky` | `approve-risky`: edits and commands ask first. `mostly-autonomous`: edits run, commands ask. `auto`: edits run, and commands run when they pass the safety check (fixed rules for clear cases, a private TEE model for the rest; risky or uncertain commands ask, with the reason). `fully-autonomous`: everything runs except deny-listed commands (only for throwaway workspaces). You can also switch it from the picker next to the model in the chat's bottom bar (Ask before edits / Edits auto / Auto / Full auto); it writes user settings, or the workspace or folder settings when the value is set there, asks before Full auto, and shows "Stopped" while the emergency stop is on. |
| `nearAi.agent.allowCommands` | `git status`, `git diff`, `ls`, … | Commands that run without asking, matched by their leading words (`git push` covers `git push origin main`, but never `--force` or a URL). The approval card's **Always allow** adds entries. In `auto`, each part of a chained command is matched on its own; in other modes, anything with `;`, `\|`, `>`, or `$( )` asks. |
| `nearAi.agent.denyCommands` | `rm -rf /`, `git push --force`, … | Commands the agent may never run. |
| `nearAi.agent.deepModel` / `standardModel` / `fastModel` | Kimi K3 / GLM 5.3 / Qwen3.6-35B-A3B | Models for Open-GSD's sub-agent tiers (opus / sonnet / haiku). By default only research, synthesis, and mapping roles use the fast tier; GSD's `budget` and `adaptive` model profiles also send checkers and the test-writing auditor there. |
| `nearAi.agent.safetyModel` | the fast tier | With `auto`, the model that checks commands the rules cannot decide. Used only when it runs privately (TEE or local); otherwise those commands ask. |
| `nearAi.agent.maxParallelAgents` | `4` | Sub-agents that may run at once. |
| `nearAi.agent.maxTurns` | `60` | Model turns per run before it pauses for you. |
| `nearAi.agent.saveTranscripts` | `true` | Keep conversations on this machine so History can resume them. |
| `nearAi.baseUrl` | NEAR AI Cloud | OpenAI-compatible endpoint (HTTPS, or HTTP on localhost). |
| `nearAi.privacyMode` | `standard` | `tee-only` blocks models NEAR forwards to other providers. |
| `nearAi.dailySpendLimitUsd` | `0` (none) | Stop sending requests once today's spend reaches this amount: the larger of NEAR's own total for the key (with a usage reporting token) and this computer's spend ledger. |
| `nearAi.spend.dayBoundary` | `local` | When "today" starts for spend figures and the daily limit: local midnight, or `utc`. |
| `nearAi.spend.useNearUsageTotal` | `true` | With a usage reporting token set, show NEAR's own total (and check the daily limit against it). Its description links to **Set usage reporting token** and **Clear**; the token itself lives in secret storage. |
| `nearAi.autoInstallGsd` | `true` | Install Open-GSD when a workflow needs it and keep it current in NEAR AI projects. |

## Good to know

- **Privacy labels come from NEAR's model catalog.** The extension does not
  yet verify NEAR's per-response attestation signatures itself.
- **No wallet, staking, or NEAR account sign-in yet.** They wait for a
  documented NEAR AI contract; sign-in uses API keys.

## Troubleshooting

- **Chat asks you to set up:** run **NEAR AI: Set Up**, then select and
  validate a profile for this project.
- **No models or costs shown:** check your API key and endpoint; prices appear
  when the provider publishes them.
- **A workflow won't start:** make sure npm can reach the registry, then run
  any workflow, such as `/gsd-progress`, to install Open-GSD.
- **Endpoint rejected:** use an `https://` URL, or `http://localhost` for a
  local runtime.
- **Local runtime unreachable:** start it (for example `ollama serve`) and
  check the URL ends in `/v1`, then run **NEAR AI: Set Up** again.
- **A model goes quiet mid-reply:** a reply that sends nothing new for 2
  minutes (keep-alive pings don't count; reasoning does), that NEAR cuts off
  before it finishes, or that runs past an hour is stopped and its request
  closed. The turn is tried again (each wait longer, and a stalled one gets
  twice the time); after 3 retries the chat says, for example, "moonshotai/kimi-k3
  stopped responding (no data for 240 s) — retried 3 times", Agent Activity
  shows the run failed, and the work so far is kept: send a message to continue
  or switch models. The cut-off requests are recorded with NEAR's request ID and
  settled with what NEAR bills.
- **The agent changed something you didn't want:** click **Revert** under the
  run. Changes made by shell commands it ran are not included; use git for
  those.

## Build from source

```bash
npm ci
npm run check            # type check and tests
npm run verify:release   # package and verify the VSIX
```

Issues and contributions: [github.com/VitalPointAI/near-ai-vscode](https://github.com/VitalPointAI/near-ai-vscode).

## License

MIT. See [LICENSE](LICENSE).

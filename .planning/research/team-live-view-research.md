# Team Live: watching a team work

Research and design for the owner's request: "a visual representation of the team with reporting relationships and animations. When a team is invoked in a project I'd like to be able to watch the team leader delegate tasks visually, like a pulsing line to an agent who becomes animated as if working."

Everything about our code was read on `origin/main` (version 0.4.26). Statements marked **(inference)** are my reading, not something a file or page says outright.

---

## 0. Recommendation in one page

- **One primary place: a "Team Live" editor panel** (a `WebviewPanel`, like Agent Activity), opened from a "Watch the team" button in the chat's running-agents strip, from the Agent Activity "Now" table, and from Team Studio's Shape tab while a run of that team is active. Wide by default, so the tree has room to breathe.
- **One compact form: a "team pulse" line in the chat's existing agents strip** (`renderAgents` in `media/chat/chat.js`): a row of small state dots, one per agent (lead first), plus the "Watch the team" button. No animation beyond a gentle dot fill change. It never replaces the strip's text rows.
- **Layout:** the lead on top, members under it following `reports-to` from `buildTeamGraph` (`src/agent/teamGraph.ts`), ad-hoc helpers (general-purpose, Open-GSD agents) drawn as smaller dashed "guest" nodes under whoever spawned them. A wide panel draws a top-down tidy tree; a narrow panel (under about 520px) draws the same tree as an indented list, using the same state model, with the pulse travelling down the left rail.
- **The signature moment:** when the lead hands a member a task, a dot of light travels down the reporting line carrying a short task chip ("Draft the API section"); the member's card wakes up (a slow breathing ring, its current tool icon and a live one-line activity, elapsed time). When it finishes, a dot travels back up carrying a result chip ("Report ready" or "Did not finish") that docks on the lead. Waiting for the person turns the card amber with "Needs you" and a button that jumps to the waiting card in the chat.
- **Reduced motion:** no travelling dots, no breathing; every state is a static icon plus words, so nothing is lost.
- **Data:** the `ActivityFeed` (`src/services/agentActivity.ts`) already carries most of it (start, phase, tool, waiting-you, waiting-agents, paused, end, model, boundary, cost). **Three gaps**: (1) `parentId` is always `main-<runId>` even when a sub-agent spawned the agent, so nested delegation is invisible; (2) the task label (the Agent call's `description`) and the team member name are not on `AgentStats`; (3) the "queued, waiting for a free slot" state happens before `agentStarted`, so the feed cannot show it. All three are small host-side additions.
- **Size for 0.4.28:** the live panel with the tree, the state machine, pulses, needs-you, member card with a short live excerpt, reduced-motion, keyboard and list alternative, plus the three data additions and their tests. **Later:** replay scrubber for finished runs, per-agent spend overlay, Team Studio "live mode" merge, cross-run comparison.

---

## 1. Prior art

### 1.1 Live multi-agent and workflow views

| Product | What it shows while running | What makes it readable | Noise to avoid | Source |
|---|---|---|---|---|
| **LangGraph Studio** (LangSmith) | The graph of nodes; a "graph mode" described as the full view of execution, with interrupts before or after a node, and state at each checkpoint | The graph is the program's own shape, so a lit node means "this step is running" without a legend | Third-party write-ups claim live animation of the whole graph; official docs do not state the running-node highlight explicitly, so do not copy unverified claims | [docs.langchain.com/langsmith/use-studio](https://docs.langchain.com/langsmith/use-studio), [graph execution (frontend)](https://docs.langchain.com/oss/langgraph/frontend/graph-execution), [LangGraph4j Studio (shows the running step)](https://langgraph4j.github.io/langgraph4j/studio) |
| **Langfuse agent graphs** | A graph tab next to Tree and Timeline in a trace, inferred from observation timing and nesting. Two modes: Aggregated (compact) and Expanded (every call its own node, loops unrolled into a DAG in execution order) | Offering both a "shape" view and an "as it happened" view of the same run; remembering the choice | Expanded mode on long runs becomes a wall of nodes | [langfuse.com/docs/observability/features/agent-graphs](https://langfuse.com/docs/observability/features/agent-graphs), [changelog 2026-07-13 graph view modes](https://langfuse.com/changelog/2026-07-13-graph-view-modes) |
| **OpenAI Agents SDK tracing** | One trace per run; agent, generation, function (tool), guardrail and handoff spans nested in a timeline that expands to the span hierarchy | Handoffs are first-class spans, so "who passed work to whom" is explicit | Post-hoc only; span soup when every model call is a row | [openai.github.io/openai-agents-python/tracing](https://openai.github.io/openai-agents-python/tracing/), [JS tracing guide](https://openai.github.io/openai-agents-js/guides/tracing/) |
| **CrewAI AMP traces** | Execution summary (run time, estimated cost), the tasks and agents involved, an Execution Timeline of when each task started and ended (shows parallelism) | Cost and time beside each agent; parallel bars make concurrency obvious | Appears to be after the run, not live (inference from the docs' wording) | [docs.crewai.com/en/enterprise/features/traces](https://docs.crewai.com/en/enterprise/features/traces) |
| **AutoGen Studio** | Playground with streamed messages between team agents ("inner monologue"), plus profiling: costs, tool invocations, tool output status | Message flow as it streams | Message flow is a chat log, not a structure; hard to see who is doing what at a glance | [AutoGen Studio usage](https://microsoft.github.io/autogen/dev/user-guide/autogenstudio-user-guide/usage.html), [paper arXiv 2408.15247](https://arxiv.org/html/2408.15247v1) |
| **Copilot Studio activity map** | Per session, a map where each node is one activity (inputs, decisions, reactions); Transcript + Map or Map-only | Pairing the map with the transcript side by side | Generative orchestration inside a topic does not appear, so the map can silently omit work | [Review agent activity](https://learn.microsoft.com/microsoft-copilot-studio/authoring-review-activity), [M365 Agent Map (tenant level)](https://learn.microsoft.com/microsoft-365/admin/manage/agent-map) |
| **n8n** | In the execution view, executed nodes get a green tick and the connections between executed nodes turn green; a spinner on the running node | Colour on the edges that carried data tells the path taken | The community notes the arrows are only a visual aid and sometimes missing; colour alone also fails people with colour weakness | [community thread on missing green arrows](https://community.n8n.io/t/green-arrows-between-executes-nodes-not-showing-v2-3-6/252550), [colour-weakness complaint](https://community.n8n.io/t/new-design-not-good-for-people-with-color-weakness-blindness/245133), [dirty nodes doc](https://docs.n8n.io/workflows/executions/dirty-nodes) |
| **Node-RED** | A small status line under each node: a dot or ring shape, a colour, and short text set by the node at runtime (from memory, docs at nodered.org/docs/creating-nodes/status, not re-fetched) | Shape plus colour plus words: readable without colour | Status text that changes many times a second | (from memory) |
| **Temporal Web UI** | Compact view (logical progression, ignores clock time, groups 20 identical activities into one line with a count), Timeline view (clock time, live for running workflows), Full History | **Grouping repeats with a count** and separating "what happened in order" from "how long it took" | Full history for normal users | [Temporal: the dark magic of workflow exploration](https://temporal.io/blog/the-dark-magic-of-workflow-exploration), [Web UI docs](https://docs.temporal.io/web-ui) |
| **GitHub Actions** | A real-time graph per run: each job a node, a status icon left of the job name, lines for dependencies | Status icon is the only per-node decoration; very calm | Nothing much; it is the calm baseline | [Use the visualization graph](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph) |
| **Airflow** | Graph view coloured by task state (queued, running, success, failed...), customisable `STATE_COLORS` | A fixed, learnable state palette | Many near-identical colours | [Customizing state colours](https://airflow.apache.org/docs/apache-airflow/2.9.3/howto/customize-ui.html) |
| **Hermes Agent (Nous Research)** | A terminal `/agents` (alias `/tasks`) overlay for live monitoring of delegation trees, with pause and kill; the web dashboard has a Kanban board | Delegation shown as a tree with controls beside each node | Secondary sources only; no web tree view confirmed | [fast.io guide on Hermes subagent delegation](https://www.fast.io/resources/hermes-agent-subagent-delegation-patterns/), [Hermes field guide](https://fstrategy.github.io/hermes-field-guide/) |
| **IronClaw (NEAR AI)** | Web gateway with chat, memory, jobs, logs, routines over SSE/WebSocket; no sub-agent visualisation found | n/a | n/a | [github.com/nearai/ironclaw](https://github.com/nearai/ironclaw) |

Prefect's flow run graph was searched for but not found in results; I know it as a horizontal timeline graph of task runs (from memory, not verified here), so it is not cited as evidence.

### 1.2 What makes these readable at a glance (synthesis)

1. **The structure is stable; only state changes.** GitHub Actions, Airflow and LangGraph Studio never move nodes during a run. People track change against a fixed map. Our team already has a fixed map (`buildTeamGraph`), which is the main reason a team view can be calm.
2. **State is shape + icon + word, colour is a bonus.** Node-RED and GitHub Actions do this; n8n's colour-only edges drew accessibility complaints.
3. **Movement means a hand-off, nothing else.** The one animation that carries meaning is "work moved from A to B". Animating everything (spinners on every node, blinking edges) is noise.
4. **Group repeats.** Temporal's "20 activities, one line with a count" is the answer to a lead that starts eight copies of the same helper.
5. **Two readings of one run:** shape (who answers to whom) and time (when each one worked). Langfuse and Temporal both separate them. For us: the live tree first, a timeline later for replay.
6. **Pair the picture with words.** Copilot Studio's map plus transcript; for us, the member card plus a short live excerpt.

Noise to avoid: streaming raw tokens into nodes, per-token flicker, node re-layout on every event, unlabelled colour, perpetual spinners on idle members, edges that animate when nothing is moving, and showing every model turn as a node (Langfuse "expanded" on a long run).

### 1.3 Layout approaches usable with zero runtime dependencies

The VSIX ships no runtime dependencies (`package.json` on main has no `dependencies` key), and the pages are hand-written scripts in `media/`. Our trees are small (a team rarely has more than 10 members; with helpers, 20 to 40 nodes), so a library is not needed; the references below are for the algorithm, not for vendoring.

| Approach | Fit | Licence | Notes |
|---|---|---|---|
| Reingold-Tilford tidy tree as in **d3-hierarchy** `d3.tree()` | Good for fixed-size nodes, top-down | ISC (from memory; d3 modules are ISC) | Reference implementation of Buchheim, Jünger and Leipert's linear-time version |
| **d3-flextree** (variable node sizes, van der Ploeg's non-layered tidy tree) | Good when card widths differ | WTFPL ([yarn listing](https://classic.yarnpkg.com/en/package/d3-flextree)) | The variable-size version matters if cards show task labels of different lengths |
| **dagre** (layered DAG, Sugiyama) | Overkill: we have a tree, not a DAG | MIT (from memory) | Only needed if one agent could report to two |
| **elkjs** | Overkill and large | EPL-2.0 (from memory) | Licence is a mismatch for vendoring |
| **Our own** `src/domain/networkLayout.ts` | Already a pure, tested layout pattern in this repo (knowledge network) | ours | Shows the house pattern: host computes layout, page draws it, tests check shape |

**Recommendation: write a small pure tidy-tree in TypeScript** (about 80 lines: post-order pass gives each subtree a width from its children's widths plus a gap, pre-order pass places children centred under the parent; nodes have a fixed card width so the simple version suffices). This is the textbook "simple tidy tree" rather than full Reingold-Tilford contour threading, which is fine because sibling subtrees are packed by width, not by contour, at our sizes. Put it beside `teamGraph.ts` (for example `src/agent/teamLiveLayout.ts`) so `node:test` covers it, as `networkLayout.test.ts` does for the network.

**The narrow layout is not a squeezed tree.** It is the indented list Team Studio already draws (`.graph-tree` / `.graph-children` in `media/teams/teams.css`: nested `ul` with a left border). The left border is the reporting line; the pulse travels down it.

### 1.4 Animation techniques (all allowed by our CSP)

The page CSP is `default-src 'none'; style-src ${cspSource}; script-src 'nonce-…'` (`activityView.ts` line 299, `teamStudioPage.ts` line 995). Inline `style=""` in markup is blocked, but setting `element.style.x` or `style.setProperty('--x', …)` from the page script is allowed (Team Studio already does `line.style.animationDelay = …` in `media/teams/teams.js` line 972).

| Technique | Use | Cost | Notes |
|---|---|---|---|
| `stroke-dasharray` + `stroke-dashoffset` keyframes on an SVG path | "Line draws on" when a member is first delegated to; a moving dash segment as a lit stretch of the line | Repaint of one path; cheap for 20 lines | Already used: `.net-edge.highlighted` + `@keyframes net-draw` in `media/teams/network.css` |
| CSS `offset-path: path('…')` + animating `offset-distance` | The travelling dot carrying a task chip, on curved connectors | Compositor-friendly transform | Supported in Chromium (VS Code's webview) per [caniuse Motion Path](https://caniuse.com/ss-motion-paths) and [MDN offset](https://developer.mozilla.org/en-US/docs/Web/CSS/offset). Set the path from script with `el.style.offsetPath = "path('M…')"` |
| Orthogonal connectors + `transform: translate()` keyframes | Same dot, simpler: connectors are an elbow (down, across, down), so the dot can be moved by two or three translate steps | Cheapest; pure transforms | **Recommended**: works identically in the narrow list (a vertical rail) and avoids building path strings |
| SMIL `<animateMotion>` | Dot along a path | Works in Chromium | Older articles call SMIL deprecated ([CSS-Tricks](https://css-tricks.com/almanac/properties/o/offset-distance/)); avoid for new work |
| "Breathing" glow: a pseudo-element ring animating `opacity` and `transform: scale()` | Working state | Compositor only | Never animate `box-shadow` or `filter` (repaint each frame) |
| Web Animations API (`el.animate()`) | Sequencing pulses with promises (`animation.finished`) | Same as CSS | Lets the page queue pulses and cancel them cleanly on reduced motion or when the run stops |

---

## 2. Design for our product

### 2.1 Where it lives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| New **Team Live** editor panel (`WebviewPanel`, like `nearAiAgentActivity`) | Room for the tree; can sit beside the chat in a second editor group; same open-from-command pattern as `openAgentActivity`; layout probe already measures editor pages at several widths | One more page to maintain | **Primary** |
| Chat run header / agents strip | Always visible during a run | The sidebar is narrow and already busy (todos, agents, approvals, image reviews) | **Compact form only** |
| Team Studio Shape tab in "live" mode | Reuses the existing drawing and member card | Studio is a builder: mixing editing with live runs blurs two jobs; Studio reads the saved team, a run may have started from an older save | Link from Studio to Team Live, not a mode inside Studio (for now) |
| Agent Activity page | Already has the Now table | It is an overview of numbers and history; a picture would compete with tables | Add a "Watch the team" link in its Now section |

The only contributed sidebar view is the chat (`nearAiChatView`); Agent Activity is an editor panel opened by command. Team Live follows Agent Activity: command `nearAi.openTeamLive` (optionally with a run id), one panel at a time, `retainContextWhenHidden` off, updates only while visible.

**Which run it shows:** the newest team run in the conversation on screen (the feed already tracks the "current conversation", `ActivityFeed.currentConversation`). A small run picker appears only when two runs are live at once (two conversations running teams). Also show plain non-team runs that spawn sub-agents (a GSD workflow is a team in all but name); the lead is then labelled with the skill (`/gsd-execute-phase`) and there are no pre-drawn members, only spawned ones.

**Compact form (chat):** above the agents list in `renderAgents`, one line: `Team · ● ● ◐ ○ ○  Watch the team`. Each dot is one agent (lead first, then members in team order), with the state shape (see 2.3) and an accessible name ("planner: working"). The line appears only for team runs and runs with at least one sub-agent. No travelling animation here.

### 2.2 Layout

- **Top:** the lead card, labelled with the team name (`team:<slug>` is the main agent's label today, `agentSession.ts` line 404) and the person's task, truncated.
- **Members:** from `buildTeamGraph(team)`, which already resolves `reports-to`, orphans and cycles. Members who have not been asked to do anything in this run are drawn **dimmed** ("on the bench"), so the person sees the whole team and who is actually working.
- **Spawned agents are matched to members by name.** A member is spawned with `label = spawn.agent.name` (`agentSession.ts` line 904), and team members' `GsdAgent.name` is the member name, so the live agent's label maps to a `MemberNode`. A spawned agent that matches no member (general-purpose, an Open-GSD agent, a project agent such as red-team) is a **guest**: a smaller dashed card under its spawner.
- **Delegation follows the real spawner, not the org chart.** If the team file says `tester reports-to reviewer` but the lead itself starts the tester, the pulse goes lead to tester. Draw the org-chart line faint and the live delegation as a temporary "bypass" arc from the actual spawner (inference: this happens often, because only agents whose tools include Agent can spawn, and most members do not have it).
- **Several instances of one member** (the lead starts `researcher` three times in parallel): one member card with a stack badge `×3`, expanding on click to three slim rows. This is Temporal's "group repeats with a count".
- **Wide (≥ 520px):** top-down tidy tree, cards about 200px wide, elbow connectors drawn in one SVG layer behind absolutely positioned HTML cards (HTML cards for text wrapping, focus and screen readers; SVG only for lines and dots).
- **Narrow (< 520px):** the indented list; each card full width; the rail on the left is the reporting line.
- **No layout shift:** card size is fixed per breakpoint; states change contents inside a reserved area (activity line clamped to one line with ellipsis and a `title`); new guests are appended at the end of their parent's children so existing cards never move. A finished run keeps its layout.

### 2.3 Visual language per state

Colours come from theme tokens only (`--vscode-charts-*`, `--vscode-focusBorder`, `--vscode-editorWarning-foreground`, `--vscode-errorForeground`, `--vscode-testing-iconPassed`), like `network.css`. Every state has a distinct **icon shape** and a **word**, so colour is never the only signal.

| State | Card | Line from parent | Words (card and list) |
|---|---|---|---|
| **On the bench** (team member not used yet) | Dimmed 55%, no ring | Faint org-chart line | "Not asked yet" |
| **Queued** (Agent call made, waiting for a free slot) | Outline dashed, hourglass icon | The task chip parked at the top of the line, dot waiting | "Waiting for a free slot" |
| **Delegated** (the moment of hand-off, about 700ms) | Card brightens as the dot arrives | A dot travels from the spawner down the line carrying the task chip; the line "draws on" behind it (dashoffset) | "Assigned: Draft the API section" |
| **Working** | A slow breathing ring (3s cycle, opacity 0.25 to 0.6, scale 1 to 1.04), current tool icon, live one-line activity, elapsed time ticking, model short name and privacy badge (TEE, Local, Cloud from `boundary`) | Line stays lit, solid, no movement | "Running Bash", "Thinking", "Writing", plus "3/7 steps" from the agent's own todos |
| **Waiting for agents** (it delegated in turn) | Ring stops, a small fan icon | Its own child lines are the lit ones now | "Waiting for 2 helpers" |
| **Needs you** (approval, question, image review) | Amber border and a "Needs you" tag, one gentle pulse when it starts (then still), button "Answer in chat" | Unchanged | "Needs you: approval for Bash" / "an image to review" / "a question" |
| **Cooling down** (rate limited, retrying) | Clock icon, muted | Unchanged | "Retrying in 12s (rate limited)" |
| **Paused** | Pause icon, ring off, italic | Line dimmed | "Paused" |
| **Reporting back** (about 700ms) | Card settles | A dot travels **up** the line with a result chip ("Report ready", or "Did not finish") that docks on the parent card as a small counter "2 reports in" | "Reported" |
| **Done** | Check icon, card returns to normal brightness (not dimmed: it did work) | Line stays drawn solid but unlit | "Done in 4m 12s · 31 tool calls" |
| **Failed** | Error icon, red-tinted border | Unlit | "Failed: <first line, redacted, 80 chars>" |
| **Stopped** (cancelled, stuck, max turns) | Stop icon, muted | Unlit | "Stopped by you" / "Stopped: not making progress" / "Reached its turn limit" (texts already in `agentEnded`) |
| **Background** | A small "background" tag; otherwise identical | Line drawn dashed while working | "Working in the background" |

Lead card specifics: shows the task-list progress (from the chat's `todos` message) as "4 of 9 tasks", and "Reports waiting: 2" while background reports are queued for its next turn (see 4.3).

**Parallel members:** several dots leave the lead at once (the lead prompt asks for fan-out in one turn, `teamLeadPrompt` in `src/agent/teams.ts`). Stagger their start by 80ms so they read as a fan, not a blob.

**Nested delegation:** a member that has the Agent tool spawns its own helpers; the same pulse goes from that member down to the guest. Depth is capped visually at 3 levels in the wide tree; deeper levels collapse into "+2 more below" which expands in place.

**Tool icons:** reuse the capability mapping in `teamGraph.ts` (`TOOL_CAPABILITY`): Read files, Change files, Run commands, Use the web, Plan and coordinate, Make media, Deliver documents, Use connected tools. Ten small inline SVG icons drawn with `currentColor` (Team Studio already builds icons this way, `media/teams/teams.js` lines 51-55). The tool name comes from `AgentStats.tool`, which `toolName()` already reduces to a bare name with no input.

### 2.4 Click a node

Opens a side card (wide) or an inline card under the node (narrow), `aria-live="polite"` like Team Studio's `member-card`:
- The **member card** from `teamGraph` (purpose, what it can do, what to expect), unchanged.
- **This run:** task label, model and privacy boundary, started, elapsed, turns, tool calls by name, approvals asked and declined, cost so far (from `AgentStats`).
- **Live excerpt:** the last few lines of the agent's newest `text` entry from the feed, tail 280 characters, already passed through `redactForDisplay`; refreshed at most once a second while the card is open; never prompts, never system prompts, never tool input or output.
- **Controls:** Pause, Resume, Stop (the same `agent-control` message Agent Activity already validates with `AGENT_ID`), and "Show in Agent Activity" (`nearAi.openAgentActivity` with the agent id).

### 2.5 Optional later

- **Replay a finished run:** a scrubber under the tree that replays the delegation events at 4x or 8x speed, plus a Temporal-style compact timeline (one bar per agent, start to end, coloured by phase). Needs the event log described in 4.4.
- **Spend overlay:** a toggle that sizes each card's bottom bar by its share of the run's cost (cost is already in `AgentStats.costUsd`, and spend tags per sub-agent exist via `withSpendTag`).
- **Team Studio link:** "Watch it live" on the Shape tab when a run of that team is active; "Last run" replay from the same tab later.

---

## 3. Accessibility and quality

- **Reduced motion** (`@media (prefers-reduced-motion: reduce)`, as `network.css` does): no travelling dots, no breathing, no draw-on. Delegation shows as the line becoming solid and the "Assigned: …" text appearing; report-back shows the "Reported" text and the counter on the parent. Also respect a page-level "Calm" toggle (remembered in webview state) for people who want stillness without changing the OS setting.
- **High contrast and themes:** only theme tokens; state shown by icon shape plus words; borders at least 1px and 2px for the focused and needs-you states; in `body.vscode-high-contrast` use `--vscode-contrastBorder` and drop the glow entirely (a glow is invisible or garish in high contrast).
- **Keyboard:** the tree is a `role="tree"` with `role="treeitem"` cards, `aria-level`, `aria-expanded` for stacked instances; arrow keys move between parent, children and siblings (WAI-ARIA tree pattern); Enter opens the card; Escape closes it and returns focus; one tab stop for the tree (roving tabindex). Team Studio's tabs already implement roving tabindex (`teams.js` lines 908-916).
- **Text alternative:** the indented list IS the text alternative. In the wide view, render the same list visually hidden (`.visually-hidden` from `base.css`) after the SVG, or better, make the HTML cards themselves the tree and keep the SVG `aria-hidden`. A polite live region announces only **discrete** changes, throttled: "planner assigned: Draft the plan", "reviewer needs you", "tester done". Never announce activity-line changes (too chatty).
- **No layout shift:** fixed card heights, reserved activity line, numbers in `font-variant-numeric: tabular-nums` so the timer does not wobble.
- **Performance with 10 to 20 agents and frequent events:**
  - Host side: send discrete events (spawned, ended, waiting changed, paused) **at once**, and the stats snapshot (tool, activity, counters, cost) **at most every 500ms** while visible, nothing while hidden (Agent Activity uses `UPDATE_MS = 1000` and only sends while visible; reuse that scheduler).
  - Page side: apply updates in one `requestAnimationFrame`; diff by agent id and touch only changed text nodes (Agent Activity's `setText` pattern); animations only on `transform` and `opacity`; at most 6 concurrent pulses, further ones queue; if the queue is over 12, skip to final states (see 5.3); stop all animation when `document.hidden`.
  - One elapsed-time clock per page (a single 1s interval, like the chat's `agentClock`), not one per card.
- **Narrow sidebar and wide editor:** the e2e layout probe (`media/shared/layout-probe.js`) measures pages at the editor widths and with a wider stand-in font; Team Live must pass it at every width, with `data-must-read` on the agent names and state words so a clipped state is reported.

---

## 4. Data contract

### 4.1 What the view needs

Per agent node: `agentId`, `runId`, `parentId` (the real spawner), `label` (member or agent type), `member` (team member name when it is one), `task` (short label), `background`, `model`, `boundary`, `status`, `phase`, `phaseSince`, `tool`, `startedAt`, `endedAt`, `turns`, `toolCalls`, `costUsd`, todo steps (done of total, active step), and for "needs you" the kind (approval, question, image).

Discrete events: `queued`, `started`, `phase` (incl. waiting-you on/off), `paused`, `ended` (status), and on the lead `report-delivered` (count of reports consumed).

### 4.2 What the ActivityFeed already carries

| Need | Today | Where |
|---|---|---|
| started, ended with status | yes | `agentStarted`, `agentEnded` (`agent-start`/`agent-end` entries plus `AgentStats.status`) |
| phase: starting, thinking, generating, tool, waiting-you, cooling-down, paused, waiting-agents | yes | `AgentPhase`, `enter()` |
| current tool name, safely reduced | yes | `AgentStats.tool` via `toolName()` |
| waiting for the person (approval, image review) | yes, but **not which kind** | `approvalAsked`, `approvalExpired`, `waitingForUser` (0.4.23), `approvalSettled` |
| background agents waiting | yes | `waitingForAgents` (PERF-07) |
| model, boundary, cost, turns, tool calls, elapsed | yes | `AgentStats` |
| parentId | **only `main-<runId>`** | `agentSession.ts` line 1021 hard-codes `parentId: \`main-${runId}\`` |
| task label | **no** (the full prompt is stored as a `prompt` entry, which the view must not use) | `spawn.description` lives in `LiveAgent.description` and in the persisted `record({ action })` |
| team member name | **no** (the label is the name, but there is no flag saying it is a member) | `teamMember` boolean computed at line 919 |
| background flag | **no** on the feed | `LiveAgent.background` |
| queued for a slot | **no**: `agentStarted` is called only after `acquireSlot`; before that the agent exists only in `LiveAgent` with activity "Waiting for a free slot" and is not even in `this.agents` | lines 953, 993-1001 |
| todo steps | no on the feed; yes on the chat `agents` message (`agentSteps`) | line 1151 |
| report delivered to the lead | no | `drainNotifications()` line 1108 |

### 4.3 What to add (small, host side)

1. **Real parent.** `GsdServices.spawn(request, signal)` (`src/gsd/tools.ts` line 47) does not receive the caller. The Agent tool's `run(input, context)` has `context.agentId` (set for sub-agents, `agentSession.ts` line 1016; `ToolContext.agentId` in `src/agent/tools.ts` line 41). Pass it: `services.spawn({ ..., parentId: context.agentId }, signal)`, and in `agentSession` use `parentId: spawn.parentId ?? \`main-${runId}\``. This also fixes nested agents in Agent Activity and in history.
2. **Extend `agentStarted`'s agent argument** with `task` (the description, `redactForDisplay`, cut to 80 characters on a word boundary), `member` (true when `teamMember`), `background`. Store them on `AgentStats` (optional fields; existing readers ignore them).
3. **A queued state.** Add `ActivityFeed.agentQueued(agent)` called right after the `LiveAgent` is built (line 953), creating the stat with `status: 'running'`, `phase: 'queued'` (new `AgentPhase` value), and let `agentStarted` upgrade it in place instead of resetting `startedAt`. Agent Activity's `PHASE` map gets "Waiting for a free slot". A queued agent stopped before it started ends as `cancelled` via `agentEnded` (today it would never appear at all).
4. **Waiting kind.** `waitingForUser(agentId, waiting, kind?: 'approval' | 'question' | 'image')`; `approvalAsked` sets `kind = 'approval'`; the question path (`askQuestions` with `askerId`) calls it with `'question'`. Today questions from sub-agents do not appear to set waiting-you on the feed at all (inference from the grep: only image review calls `waitingForUser`; check `askQuestions` before building).
5. **Reports delivered.** In `drainNotifications`, call `activity.reportsDelivered(mainId, n)`, so the lead's "reports waiting" counter and the result chip's docking are truthful: a background agent's report is produced at `agentEnded`, but the lead reads it only at its next turn.
6. **A lightweight change signal.** The feed notifies listeners per entry; Team Live subscribes like Agent Activity but reads `agentStats()` plus the new fields, never `entries` (except the excerpt on demand). A `teamLiveMessage(feed, runId, graph)` pure function (like `overviewMessage`) builds `{ type: 'team-live', run, nodes, events }` so it is unit-testable.

The team definition for the drawing: the session knows `request.team` (and `teamSlug`); expose the run's team slug on the main agent's stat (`team: slug`), and let the Team Live host load the team file and run `buildTeamGraph` once per run.

### 4.4 Restoring after a reload

- **Webview hidden and shown, or panel reopened while the extension host lives:** the feed is in memory (`sharedActivityFeed()`), keeps up to 300 agents' stats, so the picture rebuilds fully from `agentStats()` for the run: every node lands directly in its current state, **no catch-up animation** (pulses only for events that arrive while the page is watching).
- **Window reload (extension host restarted):** the feed is empty. Finished agents are in the project's `ActivityStore` as `ActivityEvent`s with `agentId`, `agentRole`, `action` (the description), `model`, `status`, `durationMs`, cost (`record({...})` calls in `agentSession.ts` lines 1001, 1056, 1072). Today there is no `parentId` there; add an optional `parentAgentId` to `ActivityEvent` with point 1 above. Team Live then draws a finished run statically ("Last run of this team") from the store. A run that was interrupted by the reload shows its agents as "Interrupted" (the chat already has `resume-interrupted`), never as still working.
- **Replay (later)** needs a compact per-run event log: the store already has start and end per agent; adding `phase` changes would be too much data. A replay can be honest with start, end, waiting periods (userWaitMs) and parent links, without per-tool detail.

### 4.5 Privacy

- Never send prompts, system prompts, reply text (except the opt-in excerpt in the open card), tool input or tool output to the Team Live page.
- Task labels: the lead writes them, so they could contain a secret or a customer name. Pass through `redactForDisplay` (secrets and private keys), cap at 80 characters, strip newlines and tags.
- Tool: the name only (`toolName()`); the activity line uses phase words plus the tool name, not the tool title (a title like "Bash curl -H 'Authorization: …'" carries input; redaction catches known token shapes, not everything).
- Messages from the page are validated like `parseActivityViewMessage` (agent ids by `AGENT_ID`, known actions only).
- The model's privacy boundary (TEE, Local, Cloud) is shown, which is useful information, not sensitive.
- The view is local to the person's window; nothing is persisted by the page beyond a "Calm" toggle in webview state.

---

## 5. The implicit state machines

### 5.1 Agent node

```
              (team member, never asked)
                     BENCH
                       │ agentQueued (spawn called)
                       ▼
 (guest: created) ─► QUEUED ──stop/parent abort──► STOPPED
                       │ agentStarted (slot acquired)
                       ▼
                   DELEGATED  (animation only, ~700ms; skipped under reduced motion)
                       │ animation end / immediately
                       ▼
     ┌──────────► WORKING (starting | thinking | generating | tool) ◄──────────┐
     │                 │            │             │              │            │
     │ answered/   waiting-you  waiting-agents  paused     cooling-down       │
     │ settled/        ▼            ▼             ▼              ▼            │
     └──────────── NEEDS_YOU    DELEGATING     PAUSED        RETRYING ────────┘
                       │
         agentEnded(status) from any non-terminal state
                       ▼
                   REPORTING  (animation only; skipped under reduced motion)
                       ▼
        DONE (completed) | STOPPED (cancelled, stuck, max-turns) | FAILED
                       │
         reused for another task (same member, new agentId)
                       ▼
                 back to QUEUED as a new instance (stack ×2)
```

Rules:
- Terminal states are terminal **per instance** (`agentId`). A member card aggregates instances: it shows WORKING if any instance works, NEEDS_YOU wins over everything (the person must see it), FAILED next, then WORKING, QUEUED, DONE, BENCH.
- The animation states (DELEGATED, REPORTING) are **page-only**; the host never stores them, so they can never get stuck. If a terminal event arrives during DELEGATED, the page cancels the pulse and jumps to the terminal state.
- A NEEDS_YOU without a following settle is cleared by `agentEnded` (the run ended while waiting). This mirrors the feed, where `enter()` adds the wait to `userWaitMs`.

### 5.2 Edge (line) between parent and child

`FAINT` (org chart only) → `ARMED` (child queued, chip parked) → `PULSE_DOWN` (animation) → `LIT` (child working) → `PULSE_UP` (animation on end) → `DRAWN` (child finished, line stays solid). A bypass arc (live spawner differs from the org-chart parent) uses the same states and fades out 4s after DRAWN, leaving the org-chart line.

### 5.3 Edge cases

| Case | Behaviour |
|---|---|
| **Agents spawned faster than animations** (lead fans out 8 in one turn) | Pulses queue with a cap of 6 concurrent; staggered 80ms; if more than 12 are queued, the rest skip straight to their target state with a single "+6 started" toast on the lead. Nodes always reflect the latest truth; animations are decoration that may be dropped, never a source of state. |
| **Member reused for several tasks** | Each spawn is a new `agentId` (`label-<6 hex>`). The member card gets a stack badge and keeps a short history "3 tasks: 2 done, 1 working"; the card's live line shows the working instance. |
| **Sub-agents of sub-agents** | Needs the real `parentId` (4.3 point 1). Without it, they would appear as children of the lead: wrong, so 0.4.28 must ship the parent fix together with the view. Depth over 3 collapses. Background reports of nested agents are delivered to the **run's** notifications (shared `this.notifications`, consumed by the main lead, `agentSession.ts` lines 1089, 1108), not to the spawning sub-agent (inference from the code): the report-back pulse should therefore travel to the lead in that case, and that is worth confirming or fixing separately. |
| **Run stopped mid-delegation** | Parent abort aborts children (`onParentAbort`); each child ends `cancelled`. Queued ones today never reach the feed; with `agentQueued` they end as STOPPED. Page: cancel all pulses, mark lit lines unlit, show "Stopped by you" on the lead; no report-back pulses for cancelled agents (nothing was reported). |
| **View opened mid-run** | Draw everything in current state from `agentStats()`; no catch-up animations; the live region announces one summary ("Team research: 3 working, 1 needs you, 2 done"). |
| **Two runs live at once** | Run picker; default to the conversation on screen. |
| **Agent not in the team and not a known agent** (general-purpose) | Guest node, labelled by its task label, since "general-purpose" says nothing. |
| **Team file edited during a run** | The drawing uses the graph built when the run started (the run uses that team definition too). |
| **Plan-checker skipped by the research profile** (`agentSession.ts` lines 908-916) | Never spawned; show a brief guest node "skipped" so the person is not surprised by a missing step (optional). |
| **More than 300 agents in the feed** | The feed evicts old stats (`MAX_AGENTS`); Team Live only shows the current run, which will not reach that. |
| **Approval timed out but still queued** (PERF-01 `approvalTimedOut`) | The agent goes back to work; the lead shows a small "1 approval still waiting" badge, since the card is still queued in the chat. |

---

## 6. Plan

### 6.1 One patch release (0.4.28): "Team Live" first cut

Host:
1. Real `parentId` through `GsdServices.spawn` and `agentSession` (also improves Agent Activity), with `parentAgentId` added to persisted `ActivityEvent`s.
2. `AgentStats` gains `task`, `member`, `background`, `team` (on the lead), `waitingKind`; new `queued` phase and `agentQueued`; `reportsDelivered` on the lead.
3. Pure `src/agent/teamLiveLayout.ts`: tidy tree (wide) and indented order (narrow) from `TeamGraph` plus live agents, with guests and stacks.
4. Pure `src/agent/teamLiveState.ts`: node and edge reducers (the machines in section 5), and `teamLiveMessage(feed, runId, graph)`.
5. `src/services/teamLiveView.ts`: panel, CSP and nonce like `activityView.ts`, `registerLayoutProbe('team-live', …)`, scheduler (discrete events at once, snapshot every 500ms while visible), message parser, command `nearAi.openTeamLive`.

Page (`media/teamLive/teamLive.js`, `teamLive.css`, zero dependencies):
6. HTML cards plus one SVG layer for connectors and pulses; Web Animations API for pulses with a queue and cap; breathing ring via CSS; tool icons; member card with run stats, controls and excerpt; reduced motion and Calm toggle; tree keyboard pattern; polite live region.

Entry points:
7. "Watch the team" in the chat agents strip and the compact dot line; link in Agent Activity's Now section; link on Team Studio's Shape tab while a run is active.

Tests (following the repo's cadence: unit first, page test, then the e2e at the boundary):
- **Unit, layout:** every node placed once; no overlaps; same input gives the same layout; children centred under parent; guests attached to their real spawner; stacks for repeats; narrow order equals a depth-first walk; orphaned and cyclic teams from `buildTeamGraph` still lay out.
- **Unit, state machine:** each transition in 5.1 and 5.2; NEEDS_YOU priority in member aggregation; terminal-during-animation; stop mid-delegation (queued and running children end STOPPED); view opened mid-run produces no animation events; reused member gets a new instance.
- **Unit, feed:** `agentQueued` then `agentStarted` keeps one stat; `parentId` of a nested agent is its spawner (an `agentSession` test spawning through a sub-agent's Agent tool); `task` is redacted and capped; `waitingKind` set and cleared; `reportsDelivered` counted; the 0.4.19 rule still holds (one prompt counted once).
- **Unit, privacy:** `teamLiveMessage` output contains no `prompt`, `system`, `text`, `input` fields; a task containing `sk-…` or a private key is redacted.
- **Page test** (vm sandbox with the fake DOM, as `teamStudioPage.test.ts` does): renders a snapshot; applying `started` adds a pulse to the queue; `ended` during a pulse cancels it and shows the final state; reduced motion (stub `matchMedia`) produces no `animate()` calls; keyboard arrows move focus along the tree; the live region text for discrete changes; the parse test in `pageScripts.test.ts` picks up the new script automatically.
- **E2E:** open Team Live with a fake run, run the layout probe at the editor widths and with the wider stand-in font: no sideways overflow, no clipped `data-must-read` names; one reduced-motion run (emulate the media feature if the harness allows, otherwise assert the CSS rule exists and the page test covers behaviour).

### 6.2 Later

- Replay scrubber and compact timeline for finished runs (needs per-run phase summaries in the store).
- Spend overlay per agent and per member, and "this team costs about this much per run" from history.
- Team Studio "Last run" view reusing the Team Live renderer; possibly merge the static Shape drawing into the same renderer so the two never drift.
- Animated "knowledge written" sparkles when a member adds to the team's knowledge graph (`addKnowledge`), linking to the network view.
- Report-to-spawner fix for nested background agents, if 5.3 is confirmed.

### 6.3 Risks

- **Delight versus distraction:** keep motion to the two hand-off moments and one slow breathing ring; everything else is still. A Calm toggle and reduced motion are first-class.
- **Truthfulness:** animations are never the source of state; the reducers are, and they are tested. A node never shows "working" after its agent ended.
- **Parent links:** shipping the picture without the `parentId` fix would draw nested work under the lead and mislead; the two belong in the same release.

---

## Sources read in the repository (origin/main)

- `src/agent/teamGraph.ts` (whole file): `buildTeamGraph`, `MemberNode`, `MemberCard`, `TOOL_CAPABILITY`, orphan and cycle handling.
- `src/services/agentActivity.ts` (whole file): `ActivityFeed`, `AgentStats`, `AgentPhase`, `agentStarted`, `agentEnded`, `waitingForUser`, `waitingForAgents`, `approval*`, `setPaused`, `toolName`, `redactForDisplay`, `MAX_AGENTS`.
- `src/services/activityView.ts` (lines 1-140 and CSP): panel pattern, `UPDATE_MS`, `parseActivityViewMessage`, `AGENT_ID`, `registerLayoutProbe`.
- `src/services/agentSession.ts`: `LiveAgent` (167-186), `agentSteps`, spawn path (895-1094) incl. `agentStarted` with fixed `parentId` (1021), slot handling, background notifications, `postAgents`, `setActivity`, `moveTask`, `observe`, `heartbeat`, `drainNotifications`.
- `src/gsd/tools.ts`: `GsdServices.spawn` signature (no caller id), Agent tool `run(input, context)`.
- `src/agent/teams.ts`: `TeamMember` (incl. `reportsTo`, `privacy`), `teamLeadPrompt` (fan-out rule).
- `src/agent/tools.ts`: `ToolContext.agentId`, `agentLabel`.
- `src/domain/activity.ts`: `ActivityEvent` fields (`agentId`, `agentRole`, `action`, no parent).
- `src/services/chat.ts`: message routing, `agents` posting.
- `media/chat/chat.js`: `renderAgents` agents strip and controls.
- `media/teams/teams.js` (`renderGraph`, `renderCard`, icons, knowledge network), `media/teams/teams.css`, `media/teams/network.css` (dashoffset draw-on, reduced motion).
- `media/activity/activity.js` and `.css` (phase words and classes).
- `media/shared/base.css`, `media/shared/layout-probe.js`, `src/test/e2e/suite.ts` (widths), `src/test/teamStudioPage.test.ts` (vm page test), `src/test/pageScripts.test.ts`, `src/test/networkLayout.test.ts`.
- `package.json`: version 0.4.26, no runtime `dependencies`.

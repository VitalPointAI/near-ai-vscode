# Near AI for VSCode

## Vision

Build an installable VS Code extension that gives developers a seamless, private, cost-aware AI coding harness centered on Open-GSD. The extension should expose Open-GSD commands through a native chat experience, use NEAR AI Cloud's private TEE-backed inference, and make model selection, routing, agent generation, spend, and approvals understandable and controllable.

## Users

Developers who want to plan and implement complex projects from VS Code with strong privacy guarantees, model choice, transparent costs, and safe-but-effective automation.

## Product principles

- Private by default: keep project context inside the selected NEAR AI inference path and make verification status visible.
- User control: expose model, routing, budget, agent, tool, and approval controls without requiring config-file archaeology.
- Conversational transparency: default to clear, fairly verbose progress reporting so developers can see what the system is doing, why it is doing it, what is waiting, and how to intervene.
- Effective autonomy: automate low-risk planning and inspection while gating writes, shell commands, network access, and git mutations.
- Observable economics: stream usage, estimates, actual request costs when available, and budget state in the UI.
- Open-GSD native: map the full Open-GSD command lifecycle into discoverable chat actions and preserve its artifacts and state.
- Recoverable execution: support cancellation, retries, checkpoints, resumability, and clear failure explanations.
- Current GSD runtime: keep the active Open-GSD core synchronized with the latest stable `@opengsd/gsd-core@latest` release at startup and at least daily during long sessions, while preserving project customizations and exposing the update result.
- Chat parity default: when a feature is ambiguous, prefer the interaction pattern of this chat—streaming status, interactive prompts, visible tool/agent activity, model and cost context, history, cancellation, and explicit handoffs.
- Context continuity: rely on Open-GSD's context-monitor and pause/resume artifacts where the host exposes them; use structured handoffs and explicit checkpoints as the extension fallback before context exhaustion.

## Initial scope

The first milestone includes onboarding, both API-key and NEAR sign-in authentication paths, a VS Code chat surface, Open-GSD command discovery/execution, streaming responses, model catalog and selection, sub-agent routing configuration, cost telemetry, approvals, and an extension package that can be installed locally.

## Constraints and open decisions

- NEAR AI Cloud is documented as OpenAI-compatible and provides model/pricing discovery, usage reporting, streaming chat completions, and TEE verification capabilities.
- The extension must not expose API keys to workspace files, agent prompts, or extension logs.
- Exact NEAR sign-in/token-exchange mechanics and the supported Open-GSD command integration boundary require validation during implementation research.
- Open-GSD updates must be constrained to the official stable package/channel and must use the upstream installer/update contract rather than copying managed files blindly.
- The MVP should favor a safe approval policy over unrestricted autonomy; autonomy can be expanded through explicit settings and budgets.

## Current Line: 0.4.x

**Goal:** Keep extending and hardening the v0.4.0 release: the native NEAR agent runner, its chat, approvals, spend tracking, teams and tooling. Each change ships as a 0.4.x release.

v0.5.0 (trusted-source knowledge base) was paused on 2026-10-29 and is moving to a separate project; its brief, research, roadmap and Phase 13 plans are archived in `.planning/milestones/v0.5.0-paused/`. Evidence-based model defaults (`.planning/research/v0.6.0-evidence-based-model-defaults.md`) remain a candidate for later 0.4.x work.

## Planned features (owner, 2026-11-05)

Not started. Recorded so they are not lost; each becomes its own milestone and phase set when the owner starts it.

### Autonomous GSD phases, and a Steer that interrupts now (0.4.18)

Owner, 2026-11-06: "before each GSD phase, the agent typically stops and asks user to do a /clear ... I'd rather it just autonomously do the clear if
it's time to clear context and then move right into the next phase or plan or execution or verification. If the user needs to interrupt, they should be
able to send a message ... similar to Codex where the user can click Steer and have that message injected immediately."

- **A phase boundary no longer waits for a person.** The `/clear` step at a GSD phase, plan, execution or verification boundary is done by the agent
  when the context is actually full enough to warrant it, and the next step starts on its own. A summary and a handoff are written before the context
  is reset, so nothing is lost. It happens only in Auto (or the mode the owner names), and a person can still ask to be stopped at boundaries.
- **Steer interrupts now.** A message the person sends mid-run can either queue (today's behaviour, taken at the next safe point, never cutting off a
  streaming reply or a running tool) or **Steer**, which injects it at once: the current turn is cut, the message is taken as the newest direction,
  and the tool in flight is cancelled cleanly and said so. The existing `RunInput` seam (`pending`/`take`/`subscribe` in `src/agent/loop.ts`)
  already carries queued messages; Steer needs a second channel that aborts the in-flight request and a card/button in the chat composer
  (`media/chat/chat.js`), matching how the composer already posts `send`.
- Open questions for the owner when this starts: whether a cleared boundary keeps the visible transcript (so the person still reads the history) while
  only the model's context is reset, how much context is "time to clear" (a percentage of the model's window, or a token count), and whether Steer is a
  button or a modifier on send.

### Agents reachable from Microsoft Teams, and a relay so end users need no VS Code

Owner, 2026-11-06: "is there a way that we could integrate this extension with Microsoft Teams, so that if I invited an agentic team like ResearchX to
be a member in a group chat, people in the chat could interact with it, each conversation within its own thread ... ResearchX would then privately
message the requestor to continue ... Doable without ResearchX being a member inside the organization - would always be an external user."

The extension cannot do this alone: it runs inside VS Code and has no inbound endpoint, so Teams needs a hosted service in front of the team.

- **A relay service is the real product.** An HTTP API over an agentic team (start a run, continue it, ask its status, stream updates), with the
  security and limits in one place. Teams is then one adapter over it, and a web page, Slack, or a plain API can use the same team. This is the piece
  that gives end users the team without installing VS Code or the extension.
- **The Teams bot is a thin adapter.** Registered with the Bot Framework for group chats, it receives an @mention, starts a run, and replies in the
  same thread when the work is done. On the first mention it opens the bot's 1:1 conversation with the requestor and continues the work there, so each
  person gets a private thread. Sessions are keyed on tenant, conversation, thread and requestor, so two people asking the same team get isolated runs.
- **The team is an external app, not a member of the organization.** It needs no NEAR AI organization membership; the relay holds the model key,
  scoped per tenant and team.
- **Security, which is the real work.** Verify every Bot Framework activity (issuer, audience, expiry, OpenID key set), never trust a raw POST; carry
  the requestor's validated Teams identity into the run so approvals and spend are attributed to a person; allowlist tenant ids so an outside install
  cannot spend the budget; give every thread its own workspace, spend cap and runtime; treat every chat message as untrusted content under the rules
  the extension already applies; and never put a NEAR AI key anywhere a person can read it.
- **Recommended order:** the relay first, then the Teams adapter, then (optionally) an MCP server so other assistants can call the same team.

Open questions for the owner when this starts: whether the relay is hosted by the owner or per customer, which Teams identity is authoritative when a
guest account is involved, whether a group chat may see the whole run or only its result, and how a thread survives the bot being restarted.

### Decision agents on teams

The team builder gains a decision agent configuration, so a decision agent can be put on a team and use a model configured for deciding. Sage 2
through NEAR AI is the default decision model. A decision agent's job is to use all the information the team has and decide in real time, and to act
on that decision when it has been delegated the authority to act. Open questions for the owner when this starts: what a decision agent may act on
without a person (and what always waits for one), how its decisions are recorded so the rest of the team can see them, how it is distinguished from an
orchestrator in the roster and the board, and what it does when the information it has conflicts (for example two people's reports disagree).

### Named team agents with personalities, and who is acting in the chat

It is not clear today when a member agent of a team is the one acting in the chat, or which team it belongs to. Three things, together:

- **Every action in the chat names the agent** that performed it and the team it belongs to, so a person can always tell who did what without
  reading the details view.
- **Agents can be named in the team builder,** and a name is shown wherever that agent acts, so the team has people rather than roles.
- **Agents can be given a personality in the team builder,** and new agents come with a random default name and a personality typical of the role.
- **A personality never makes an agent worse at its work.** The example the owner gave: a technical role is often written as a poor communicator, but
  communication with the person is the job, so the personality is a skilled engineer who also explains things clearly. Every generated personality must
  keep the role's competence and its communication explicit, and the tests should pin that. A personality changes voice and manner, never capability,
  permissions or the quality of the work.

Open questions for the owner when this starts: whether a personality is text appended to the agent's instructions or a structured set of traits, how a
person changes a name or personality after the team is made, whether personalities are shared with the team (so everyone sees the same person) or local
to one computer, and how a personality is kept from growing the prompt until runs get expensive.

### Verifiable agent guardrails

Every agent the extension runs works under guardrails a person can see, and those guardrails are verifiable rather than trusted.

- **Every agent gets a cryptographic identity:** a NEAR Protocol implicit account, with a W3C-compliant DID attached. The DID carries that agent's
  constraints and limits, so what an agent may do is data, not a prompt.
- **The agent activity dashboard shows them:** for each agent, what it is allowed to do in plain words, and the DID itself for anyone who wants to
  inspect it.
- **An agent can only act within its DID,** and can never grant itself more permissions or authority than it was created with or delegated to it.
- **Only the orchestrating agent changes it,** and only with authority delegated by a person.
- **DIDs are stored with NEAR confidential intents,** so they are immutable on chain, and the authorization policies are immutable smart contracts
  that act as gates: an agent asks to act, and the contract checks its authorization before anything runs.

Builds on what exists: signed events and device identities (`src/team/`, Phase 60), the permission rows (`src/domain/team/permissions.ts`), the
approval and policy layer (`src/agent/permissions.ts`, `src/domain/policy.ts`) and the activity view. Open questions: which NEAR account model, how a
DID is anchored in the confidential-intents format, what happens when the chain is unreachable, and how a run works with no chain at all.


## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-05 with four recorded future features; 2026-10-29 after pausing v0.5.0 and continuing the 0.4.x line*

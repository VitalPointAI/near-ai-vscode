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

### Decision agents on teams

The team builder gains a decision agent configuration, so a decision agent can be put on a team and use a model configured for deciding. Sage 2
through NEAR AI is the default decision model. A decision agent's job is to use all the information the team has and decide in real time, and to act
on that decision when it has been delegated the authority to act. Open questions for the owner when this starts: what a decision agent may act on
without a person (and what always waits for one), how its decisions are recorded so the rest of the team can see them, how it is distinguished from an
orchestrator in the roster and the board, and what it does when the information it has conflicts (for example two people's reports disagree).

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
*Last updated: 2026-10-29 after pausing v0.5.0 and continuing the 0.4.x line*

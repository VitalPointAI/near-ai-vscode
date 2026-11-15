# Near AI for VSCode

## Vision

Build an installable VS Code extension that gives developers a seamless, private, cost-aware AI coding harness centered on Open-GSD. The extension should expose Open-GSD commands through a native chat experience, use NEAR AI Cloud's private TEE-backed inference, and make model selection, routing, agent generation, spend, and approvals understandable and controllable.

## Users

Developers who want to plan and implement complex projects from VS Code with strong privacy guarantees, model choice, transparent costs, and safe-but-effective automation.

## Product principles

- No developer knowledge required (owner, 2026-11-02, prime concern): people build together without knowing git. Branches, worktrees, pull requests, rebases, merges, tags and releases are done by agents behind plain actions ("Start this task", "Send for review", "Fix what the reviewer found", "Ship it", "Undo that release"), and reported in plain words. Git terms appear only in an optional details view, never as a required step or decision. Every phase from 63 on (claims and workspaces, dispatch, integration and review, budgets, release readiness) is designed against this, and user-facing text from Phases 60 to 62 (Enable, Invite/Join, the Push offer, repository-access reminders, import notices) is reviewed for git jargon.
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

## Current Milestone: v0.6.0 Team Mode

**Goal:** Turn the single-developer harness into a team harness where several people, each running their own NEAR AI agents, work one project toward Open-GSD milestones and releases without colliding.

**Source of truth:** `.planning/research/v0.6.0-team-mode-addendum.md` (where this file and the spec differ, the spec wins).

**Target features:**
- Membership: invite people with roles, join with a single-use code, remove cleanly; signed device keys
- A signed, append-only coordination log on the project's git remote, verified by every client
- A live Team Board derived from the GSD roadmap, phases and plans
- Automatic dispatch (suggest, offer, auto) and a one-action Next Task
- Deconfliction: exclusive claims, path and resource leases, a lease guard in the agent runtime, duplicate checks
- One verified, reviewed merge path (merge train or PR mode); STATE.md regenerated from the log
- Per-member budgets and allocations, provider-side spend caps per NEAR API key, reconciliation and alerts
- Metrics, comments and handoffs, team memory, team-wide stop, release readiness, optional relay transport

**Phase numbering:** Team Mode uses phases 60 to 67 (spec phases 25 to 32, in order), because Phase 25 belongs to the parallel 0.4.x line.

**Owner decisions taken (spec section 14):** coordination storage is the orphan branch `near-ai/coordination`; default dispatch mode is `offer`; peer metrics visibility is off by default; the integration default is the local merge train; the milestone is v0.6.0 Team Mode (evidence-based model defaults move to v0.7.0 or a 0.6.x release). Decision 1 (NEAR spend-limit semantics) is confirmed in Phase 61 research.

**Owner decisions (2026-11-02):**
- No separate solo mode. One person working with agents is already a team. Task workspaces (a separate branch per task), the review gate, the single path into the main branch, the release workflow and recovery (undo a release, hotfix) apply to every project that uses the extension, a single developer included, without anyone having to "set up a team". The multi-person layer turns on when a second person joins. Phases 60 to 62 were built on Team Mode being explicitly enabled and stay as built; the plan from Phase 63 on follows this decision.
- No developer knowledge required (see Product principles). Agents do all git work behind plain actions ("Start this task", "Send for review", "Fix what the reviewer found", "Ship it", "Undo that release") and report it in plain words; git terms appear only in an optional details view.

**Progress:** Phase 60 (team core: identity, signed event log, git transport, roster) completed 2026-11-01, delivering TEAM-01, TEAM-04, SEC-01 and SEC-04; verified 11/11 must-haves and a real two-window UAT. Next: Phase 61 (invitations, joining, removal, NEAR org and key integration).

**Constraints:** existing projects keep working with no forced setup or migration; the always-on workflow (task workspaces, review, one path into the main branch, releases and recovery, from Phase 63 on) is introduced with a plain-language first-run explanation and can be turned off per project; the multi-person layer (signed coordination log between people, invites and roster, per-member NEAR keys and spend caps, handing work between people) stays opt-in until a second person joins; `src/domain/team/*` and `src/team/*` never import `vscode`; no new runtime dependencies in the team core; no secret is ever written to the coordination log, `team.json`, settings, transcripts, audit or fixtures; money is integer nano-USD; event ordering never uses wall clock.

## Planned milestone: verifiable agent guardrails (owner, 2026-11-05)

**Not started. Recorded so it is not lost; it becomes its own milestone and phase set when the owner starts it.**

Every agent the extension runs works under guardrails a person can see, and those guardrails are verifiable rather than trusted.

- **Every agent gets a cryptographic identity.** A NEAR Protocol implicit account, with a W3C-compliant DID attached. The DID carries that agent's constraints and limits, so what an agent may do is data, not a prompt.
- **The activity dashboard shows them.** For each agent: what it is allowed to do, in plain words, and the DID itself for anyone who wants to inspect it. The existing agent activity view is the natural home; the DID sits in its details.
- **An agent can only act within its DID.** It can never grant itself more permissions or authority than it was created with or delegated to it.
- **Only the orchestrating agent changes it**, and only with authority delegated by a person. Changing a DID is never something a worker agent can do to itself or to a sibling.
- **DIDs are stored with NEAR confidential intents**, so they are immutable on chain, and the authorization policies are immutable smart contracts that act as gates: an agent asks to perform a task and the contract checks its authorization before anything runs.

Builds on what already exists: signed events and device identities in `src/domain/team/` and `src/team/` (Phase 60), the per-member permission rows in `src/domain/team/permissions.ts`, the approval and policy layer in `src/agent/permissions.ts` and `src/domain/policy.ts`, and the activity view (`registerAgentActivity`). Open questions for the owner when this starts: which NEAR account model (implicit account per agent, or a registry contract), how a DID is anchored (the confidential-intents format), what happens when the chain is unreachable, and how a local-only run works without a chain at all.

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
*Last updated: 2026-11-05 with the planned verifiable agent guardrails milestone*

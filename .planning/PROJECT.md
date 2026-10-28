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

## Current Milestone: v0.5.0 Trusted-source knowledge base

**Goal:** Give research teams a private, self-improving knowledge base of graded sources and the intelligence collated from them, which augments agents with strategic, operational, and tactical context and shows it as a network, on a globe, over time, and as probabilistic forecasts.

**Target features:**
- Source intake: agents add sources and claims during research runs; analysts add or import directly (including CSV, STIX, and GeoJSON); standing feeds (RSS, MCP connections, watched folders).
- NATO Admiralty grading (reliability A–F, credibility 1–6) on every source and claim; agents propose and keep revising grades with evidence and reasons; analyst overrides are recorded the same way.
- Per-project grade thresholds: reports exclude or flag below-threshold claims and show each claim's grade and sources.
- RAFT graph (Relationships, Actors, Functions, Tensions) as a professional network diagram, sliced by geography, time window, topic, or actors; agents work within a slice.
- Geospatial: an open-source 3D globe with open imagery, one layer per source or source type, and offline geocoding so place names never leave the machine.
- Temporal: every item records when it happened, was reported, and was graded; the user can replay how events unfolded.
- Prediction: scenario forecasts and RAFT tension trends with probabilities and their evidence, recalibrated as events arrive; the user chooses whether models train and run locally or on NEAR TEE models.
- Team and organisation sharing: a signed, end-to-end encrypted, append-only event log with snapshots, synced through a git repository or shared folder (small teams) or an organisation-hosted relay that sees only ciphertext (larger ones); need-to-know compartments with their own keys and roles (reader, analyst, approver); members are invited by public key and keys rotate when a member is removed.
- Sensitivity: knowledge-base projects use TEE-attested models only (including sub-agents, attachments, and embeddings), and the base is encrypted at rest with its key in SecretStorage.

Requirements brief: `.planning/research/v0.5.0-trusted-source-knowledge-base.md`. Evidence-based model defaults (`.planning/research/v0.6.0-evidence-based-model-defaults.md`) follow in v0.6.0.

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
*Last updated: 2026-10-28 after starting milestone v0.5.0*

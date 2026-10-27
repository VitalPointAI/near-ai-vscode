---
last_mapped_commit: 0dd12e6e15b0daf804d8c3d1d896241992426082
last_mapped_at: 2026-10-27
---
<!-- refreshed: 2026-10-27 -->

# Architecture

**Analysis Date:** 2026-10-27

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                     VS Code Extension Host (Node)                     │
│  `src/extension.ts` (activate: commands, views, chat participant)     │
├───────────────┬──────────────────────┬───────────────────────────────┤
│  UI Adapters  │   Services (orchestr.)│   GSD Integration             │
│ `services/    │ `services/chat.ts`   │ `gsd/runtime.ts`, `gsd/host.ts`│
│  panelView.ts`│ `services/agentSession.ts`│ `gsd/library.ts`, `gsd/tools.ts`│
│ `services/    │ `services/agentOrch…ts`│                               │
│  chatParticipant.ts`│ `services/nearAiClient.ts` │                    │
├───────────────┴──────────────────────┴───────────────────────────────┤
│                 Agent Runtime  `src/agent/`                           │
│  loop.ts (AgentRun) · tools.ts · permissions.ts · workspace.ts ·      │
│  shell.ts · checkpoints.ts · context.ts · teams.ts · worktree.ts      │
├──────────────────────────────────────────────────────────────────────┤
│                 Domain Models & Pure Policy  `src/domain/`            │
│  policy.ts · auth.ts · routing.ts · privacy.ts · redaction.ts · …      │
├──────────────────────────────────────────────────────────────────────┤
│  Persistence (VS Code storage / files)                                │
│  `services/profileStore.ts` · `transcripts.ts` · `activityStore.ts`   │
│  `analyticsStore.ts` · `auditStore.ts` · `contextGraphStore.ts`       │
└──────────────────────────────────────────────────────────────────────┘
        │ HTTPS (TEE-backed NEAR AI endpoints)     │ child processes
        ▼                                          ▼
   NEAR AI model API (`services/nearAiClient.ts`)  `agent/shell.ts`, `gsd/runtime.ts`
```

Webview UI (`media/chat/chat.js`, `markdown.js`, `chat.css`) runs in a sandboxed VS Code webview and communicates with the host only through typed `postMessage` payloads defined in `src/services/chatBridge.ts` (`ChatWebviewMessage`, `ContextGraphWebviewMessage`, `MultimodalWebviewMessage`, `TeamWebviewMessage`).

## Pattern Overview

**Overall:** Layered VS Code extension with a host-side agent runtime. Orchestration services sit on top of a pure-TypeScript agent loop and a domain layer of policy and data types. The UI is a set of webviews driven by message passing.

**Key Characteristics:**
- Single compiled CommonJS bundle path: `tsc -p tsconfig.json` emits `src/**` to `dist/` (no bundler). Entry point is `dist/extension.js` (`package.json` `main`).
- Activation is gated: `activationEvents` is `workspaceContains:.planning/.near-ai/**`, so the extension only loads in NEAR AI-initialized projects; commands contributed in `package.json` still register through `activate()`.
- Pure-ish layers: `src/domain/*` and `src/agent/*` are free of `vscode` imports (verified: no `from 'vscode'` in `src/domain` or `src/agent`), which keeps them testable with `node --test` against `dist/test/*.test.js`.
- Ports-and-adapters flavor for I/O: `ProcessRunner` (`src/gsd/runtime.ts`), `ShellSession` (`src/agent/shell.ts`), and `NearAiClient` (`src/services/nearAiClient.ts`) are injected into higher layers.
- Policy gating before side effects: every agent tool call passes `decidePermission` (`src/agent/permissions.ts`) and action capability policy (`src/domain/policy.ts`, `src/services/policyGate.ts`) before execution; emergency stop (`src/services/emergencyStop.ts`) is checked globally.
- Event-driven streaming: the agent loop emits `AgentEvent`s (`src/agent/loop.ts`) that the chat service forwards to the webview as incremental messages.

## Layers

**Extension Shell (composition root):**
- Purpose: Register commands, webview providers, chat participant, and wire stores/services together.
- Location: `src/extension.ts`
- Contains: `activate()` / `deactivate()`, `registerCommand` calls, `registerWebviewViewProvider`, `registerChatParticipant`, `registerWorkspaceCommands`, `initEmergencyStop`.
- Depends on: `services/*`, `gsd/runtime`, `domain/config`, `domain/auth`
- Used by: VS Code host only. Exports `NearAiTestApi` (`{ auth, sidebar }`) for tests.

**UI Adapters (services layer, VS Code-facing):**
- Purpose: Own VS Code objects (webviews, chat participant, tree/quick picks, commands).
- Location: `src/services/panelView.ts`, `src/services/chat.ts` (webview panels via `attachChatToView`, `openTools`), `src/services/chatParticipant.ts`, `src/services/workspaceCommands.ts`, `src/services/onboarding.ts`, `src/services/handoff.ts`
- Contains: `NearAiPanelViewProvider` (sidebar `WebviewViewProvider`, `retainContextWhenHidden: true`), HTML generators (`sidebarHtml`, `chatWebviewHtmlForTest`).
- Depends on: `services/chat`, `services/chatBridge`, `services/auth`
- Used by: `src/extension.ts`

**Chat / Session Orchestration (services layer):**
- Purpose: Route webview messages to agent sessions, providers, and stores; render transcripts, progress cards, and approvals.
- Location: `src/services/chat.ts` (951 lines, largest service; handles `postMessage` dispatch at ~line 111), `src/services/chatBridge.ts` (message types and message builders), `src/services/agentSession.ts` (`AgentConversation` class at ~line 90)
- Contains: `AgentConversation` (multi-turn state, compaction, subagent spawning at ~line 378), `GsdContext`, `AgentTurnRequest`, `findSkill`, `visibleTurns`.
- Depends on: `agent/loop`, `agent/context`, `gsd/host`, `services/nearAiClient`, `services/providerCache`, `services/outboundGuard`, stores
- Used by: `services/panelView.ts`, `services/chatParticipant.ts`

**Agent Runtime (agent layer):**
- Purpose: Execute the model-driven tool loop with retries, approvals, checkpoints, and limits.
- Location: `src/agent/`
- Contains:
  - `loop.ts`: `AgentRun` class (`run(messages, signal)`), `RETRY_DELAYS_MS`, `RunOutcome` (`completed | max-turns | cancelled`), `ApprovalRequest` / `ApprovalReply`.
  - `tools.ts`: `AgentTool<I>` interface and `CORE_TOOLS` (read, write, edit, glob, grep, bash, bash_output, kill_shell, todo).
  - `extraTools.ts`: additional tools, including project memory scope (`projectMemoryScope`).
  - `permissions.ts`: `decidePermission`, `PermissionRules`, `RunGrants`.
  - `workspace.ts`: `resolveInWorkspace`, `displayPath`, `ToolError` (path containment).
  - `shell.ts`: `ShellSession`, `truncate`, timeouts (`DEFAULT_TIMEOUT_MS`, `MAX_TIMEOUT_MS`).
  - `checkpoints.ts`, `diff.ts`, `glob.ts`, `attachments.ts`, `context.ts` (token estimation, compaction), `systemPrompt.ts`, `teams.ts`, `worktree.ts`.
- Depends on: `domain/policy` (types), `services/nearAiClient` (types only; `import type`)
- Used by: `services/agentSession.ts`, `services/chat.ts`

**Domain (pure models and policy):**
- Purpose: Types, decision functions, and redaction/privacy rules shared across layers.
- Location: `src/domain/`
- Contains: `policy.ts` (`ActionCapability`, `decideAction`, `defaultActionPolicy`), `routing.ts`, `agents.ts`, `teamStudio.ts`, `capabilities.ts`, `privacy.ts`, `redaction.ts`, `contextGraph.ts`, `continuity.ts`, `gsdStatus.ts`, `gsdCommands.ts`, `chatProgress.ts`, `config.ts` (`createDefaultSettings`, `isSecureEndpoint`), `auth.ts`, `version.ts`, `staking.ts`, `multimodal.ts`, `generation.ts`, `motion.ts`, `activity.ts`, `analytics.ts`.
- Depends on: nothing in `services` except one `import type` in `domain/auth.ts` (`NearAiClient`).
- Used by: every layer above.

**Services (infrastructure and stores):**
- Purpose: Talk to the NEAR AI API, persist state, enforce outbound and spend rules, manage wallets/staking/attestation.
- Location: `src/services/`
- Contains:
  - Provider/transport: `nearAiClient.ts` (`NearAiClient`, `NearAiError`, `StreamInterruptedError`, `estimateCostUsd`), `providerFactory.ts` (`createNearAiProvider`, `validateNearAiProvider`), `providerCache.ts` (`activeProvider`, `clientFor`, `clearProviderCache`), `attestation.ts` (response verification).
  - Auth & identity: `auth.ts` (`AuthService`), `profileStore.ts`, `walletAuthorization.ts`, `onboarding.ts`.
  - Policy & safety: `policyGate.ts` (`PolicyGate`), `privacyPreflight.ts`, `outboundGuard.ts` (`OutboundGuard`, `spentTodayUsd`), `approvalService.ts`, `memoryApproval.ts`, `emergencyStop.ts`.
  - Agents & teams: `agentOrchestrator.ts` (`AgentOrchestrator`, `invokeBoundTeam`), `agentProfiles.ts`, `agentTeams.ts`, `capabilityRouter.ts`, `reputation.ts`, `fleetView.ts`, `teamStudio.ts` (`TeamStudioStore`), `resumableExecution.ts`.
  - Memory & data: `contextGraphStore.ts`, `contextGraphMemory.ts`, `transcripts.ts` (`TranscriptStore`), `activityStore.ts`, `analyticsStore.ts`, `auditStore.ts`, `handoff.ts`.
  - Multimodal & generation: `multimodalIntake.ts`, `multimodalOrchestrator.ts`, `generationService.ts`, `stakingService.ts`.
  - Settings & project: `settings.ts` (`readSettings`, `readAgentLimits`, `readModelTiers`), `projectInitialization.ts`, `gsdCommands.ts` (`chooseGsdCommand`).
- Depends on: `domain/*`, `agent/*` (types and rules), VS Code APIs (`vscode.workspace`, `vscode.SecretStorage` via `auth.ts`).
- Used by: `chat.ts`, `extension.ts`, `agentOrchestrator.ts`.

**GSD Integration (gsd layer):**
- Purpose: Install, version-check, and expose the external `@opengsd/gsd-core` package (`GSD_PACKAGE` in `src/gsd/runtime.ts`) as commands, skills, and agents.
- Location: `src/gsd/`
- Contains:
  - `runtime.ts`: `GsdRuntime` (install/update), `startRuntimeUpdates` (24h interval, `UPDATE_INTERVAL_MS`), `selfTest`, `gsdShellEnv`, `isNearAiProject`, `ProcessRunner`.
  - `host.ts`: `GsdHost` (exposes command list `GsdCommandInfo`, builds `GsdContext`).
  - `library.ts`: `loadAgents`, `loadSkills` (reads GSD skill/agent markdown).
  - `tools.ts`: GSD-specific tool wiring.
- Depends on: `domain/version`, `services/agentSession` (type `GsdContext`).
- Used by: `extension.ts`, `services/chat.ts`.

## Data Flow

### Primary Request Path (chat message to model reply)

1. Webview posts a `ChatWebviewMessage` (e.g., send prompt) handled in `src/services/chat.ts` `panel.webview.onDidReceiveMessage` (~line 111).
2. Attachments are staged via `src/agent/attachments.ts` (`prepareAttachments`, `stageAttachment`); multimodal intake via `src/services/multimodalIntake.ts`.
3. `chat.ts` resolves the active provider (`src/services/providerCache.ts` → `providerFactory.ts` → `auth.ts`) and checks `outboundGuard.ts` budget and `emergencyStop.ts`.
4. `AgentConversation` (`src/services/agentSession.ts`) builds the system prompt (`src/agent/systemPrompt.ts`) and creates an `AgentRun` (`src/agent/loop.ts`, constructed at ~line 153).
5. `AgentRun.run()` calls `NearAiClient` (`src/services/nearAiClient.ts`) for streamed completions; tool calls are gated by `decidePermission` (`src/agent/permissions.ts`), approval prompts emitted as `ApprovalRequest`, and executed via `CORE_TOOLS` (`src/agent/tools.ts`).
6. Retries use `RETRY_DELAYS_MS` (2s to 60s); stream stalls raise `StreamInterruptedError` and are recovered without user input (per commit 7a1ac30).
7. `AgentEvent`s stream back; `chat.ts` posts `notice`, progress, and transcript messages to the webview; `TranscriptStore` and `AnalyticsStore` persist the turn and cost (`estimateCostUsd`).

### Subagent / Team Path

1. `AgentConversation` spawns child `AgentRun` instances (`src/services/agentSession.ts` ~line 378) bounded by `readAgentLimits().maxParallelAgents`.
2. `AgentOrchestrator` (`src/services/agentOrchestrator.ts`) performs routing (`capabilityRouter.ts`, `domain/routing.ts`), privacy preflight (`privacyPreflight.ts`), and policy checks (`policyGate.ts`) before deploying an `OrchestratedAgent`.
3. Team invocations bind to `TeamStudioStore` (`src/services/teamStudio.ts`) via `invokeBoundTeam`.

### GSD Command Path

1. `nearAi.gsdCommand` / `nearAi.gsdProgress` commands (`src/extension.ts` ~lines 55-59) post `open-command` to the sidebar (`panelView.ts`).
2. `chat.ts` resolves the GSD command via `GSD_COMMANDS` (`src/domain/gsdCommands.ts`) and `GsdHost` (`src/gsd/host.ts`), then runs it through the agent loop with GSD skill prompts from `src/gsd/library.ts`.
3. Runtime installation and self-test run through `GsdRuntime` (`src/gsd/runtime.ts`), which shells out via `defaultProcessRunner`.

**State Management:**
- Session state lives in memory inside `AgentConversation` and `AgentOrchestrator` instances, rebuilt per chat panel.
- Durable state lives in VS Code `globalState`/`SecretStorage` (profiles, credentials via `auth.ts`/`profileStore.ts`) and in project files under `.planning/.near-ai/` (activation marker and project data).
- Emergency stop is a process-wide flag in `src/services/emergencyStop.ts` with change events (`onDidChangeEmergencyStop`).

## Key Abstractions

**AgentTool:**
- Purpose: Uniform description of a tool the model can call (schema, capability, preview, execute).
- Examples: `src/agent/tools.ts` (`readTool`, `bashTool`), `src/agent/extraTools.ts`
- Pattern: Generic interface `AgentTool<I>` with a typed input record; registry is the `CORE_TOOLS` array plus extras.

**AgentRun / AgentConversation:**
- Purpose: `AgentRun` is one bounded model-tool loop; `AgentConversation` is the multi-turn session that owns messages, compaction, and child runs.
- Examples: `src/agent/loop.ts`, `src/services/agentSession.ts`
- Pattern: Event emitter via typed `AgentEvent` union; `AbortSignal` for cancellation.

**ActionCapability / ActionPolicy:**
- Purpose: Classify every side effect (file write, shell, network, spend) and decide allow / approval-required / deny.
- Examples: `src/domain/policy.ts` (`decideAction`), `src/services/policyGate.ts`
- Pattern: Pure decision function over a policy mode (`approve-risky`, `mostly-autonomous`, `fully-autonomous`).

**Provider / Client:**
- Purpose: Abstract the NEAR AI endpoint behind a validated, cached client.
- Examples: `src/services/nearAiClient.ts` (`NearAiClient`), `src/services/providerFactory.ts`, `src/services/providerCache.ts`
- Pattern: Factory + cache keyed by profile; endpoint must pass `isSecureEndpoint` (`src/domain/config.ts`).

**Store classes:**
- Purpose: Persist one concern each (profiles, transcripts, activity, analytics, audit, context graph, team studio, reputation).
- Examples: `src/services/profileStore.ts`, `src/services/transcripts.ts`, `src/services/auditStore.ts`, `src/services/contextGraphStore.ts`
- Pattern: Class per store, injected into `chat.ts` / `AgentOrchestrator`.

## Entry Points

**Extension activation:**
- Location: `src/extension.ts` `activate(context)` (compiled to `dist/extension.js`)
- Triggers: `workspaceContains:.planning/.near-ai/**` activation event, or command invocation.
- Responsibilities: Create `AuthService`, `ProfileStore`, `GsdRuntime`; register sidebar, commands, chat participant, workspace commands; start GSD update timer.

**Sidebar webview:**
- Location: `src/services/panelView.ts` (`NearAiPanelViewProvider.viewId`), assets in `media/chat/`
- Triggers: VS Code view container activity.
- Responsibilities: Host chat UI; relays messages to `chat.ts`.

**Chat participant:**
- Location: `src/services/chatParticipant.ts` (`registerChatParticipant`)
- Triggers: Chat participant invocation in VS Code chat.
- Responsibilities: Forwards requests to the sidebar via `sidebar.request({ type: 'open-command', ... })`.

**Test entry:**
- Location: `src/test/*.test.ts` compiled to `dist/test/*.test.js`, run by `npm test` (`node --test`); e2e harness at `src/test/e2e/run.ts` and `suite.ts` (`npm run test:e2e`, needs xvfb).

## Architectural Constraints

- **Threading:** Single-threaded VS Code extension host event loop. Concurrency is async/await; parallel agents are bounded by `maxParallelAgents`. Shell tasks run as child processes via `ShellSession`.
- **Global state:** Module-level emergency-stop state (`src/services/emergencyStop.ts`), provider cache (`src/services/providerCache.ts`), and process-wide `ShellSession` registry (`src/agent/shell.ts`).
- **Layering rule (observed, not enforced):** `src/domain` must not import `vscode` (currently holds). Known exceptions where lower layers import services for types or behavior:
  - `src/domain/auth.ts` → `src/services/nearAiClient.ts` (type only)
  - `src/agent/attachments.ts`, `src/agent/context.ts`, `src/agent/loop.ts`, `src/agent/extraTools.ts` → `src/services/nearAiClient.ts` / `contextGraphMemory.ts` (types only)
  - `src/agent/teams.ts` → `src/services/agentTeams.ts` (runtime import, not type-only)
- **Circular imports:** Not catalogued. `agent/*` and `services/*` reference each other across the type boundary; avoid adding runtime cycles.
- **Build output:** Compiled with `tsc` without bundling; all `src` files are shipped as individual `dist/` modules. Do not add non-Node runtime imports to `src/domain` or `src/agent`.
- **Webview security:** Webview HTML uses a CSP with `cspSource`; messages must be validated by `parseChatWebviewMessage` in `src/services/chatBridge.ts` before use.

## Anti-Patterns

### Growing `chat.ts` as the catch-all dispatcher

**What happens:** `src/services/chat.ts` (951 lines) handles every webview message type (chat, attachments, teams, wallet, memory, multimodal, generation) inside one `onDidReceiveMessage` handler.
**Why it's wrong:** Every new feature widens one file that also owns session lifecycle and provider resolution, making regressions likely and tests coupled.
**Do this instead:** Add a dedicated module under `src/services/` (like `teamStudio.ts` or `multimodalOrchestrator.ts`) exposing a handler, and register its message types in `src/services/chatBridge.ts` with a single delegating case in `chat.ts`.

### Runtime import from agent layer into services

**What happens:** `src/agent/teams.ts` imports `recommendAgentTeam` from `src/services/agentTeams.ts` at runtime.
**Why it's wrong:** It inverts the intended direction (agent runtime should not depend on orchestration services) and is the only runtime edge of this kind.
**Do this instead:** Move the pure recommendation logic into `src/domain/agents.ts` or `src/domain/teamStudio.ts` and import it from both sides.

### Module-level mutable state for shared resources

**What happens:** `providerCache.ts`, `emergencyStop.ts`, and the `ShellSession` registry hold singleton state at module scope.
**Why it's wrong:** Tests must reset state between cases, and multiple panels share the same provider cache.
**Do this instead:** Prefer instance state owned by `AuthService` or the extension composition root in `src/extension.ts`, and pass it down; when a singleton is required, expose an explicit reset used by tests (as `clearProviderCache` does).

## Error Handling

**Strategy:** Typed errors with user-safe messages, retries for transient failures, and explicit approval/deny outcomes instead of thrown exceptions for policy decisions.

**Patterns:**
- `NearAiError` and `StreamInterruptedError` (`src/services/nearAiClient.ts`) carry retryability; `classifyRetryableFailure(status, signal)` decides retry.
- `ToolError` (`src/agent/workspace.ts`) for workspace containment and tool misuse; returned to the model as tool results rather than crashing the loop.
- `providerErrorMessage` (`src/services/chatBridge.ts`) converts provider failures to UI notices.
- `AgentRunError` (`src/agent/loop.ts`) for unrecoverable loop failures; `RunOutcome` reports `max-turns` and `cancelled` without throwing.

## Cross-Cutting Concerns

**Logging:** Transcripts (`src/services/transcripts.ts`) and activity events (`src/services/activityStore.ts`) instead of a logger; output routed to the chat panel.
**Validation:** Webview message parsing in `src/services/chatBridge.ts` (`parseChatWebviewMessage`); endpoint validation via `isSecureEndpoint` (`src/domain/config.ts`); path containment via `resolveInWorkspace` (`src/agent/workspace.ts`); sensitive path blocking via `isSensitivePath` (`src/agent/tools.ts`).
**Authentication:** Profile-based credentials held in `AuthService` (`src/services/auth.ts`) with derived profile IDs (`deriveProfileId` in `src/domain/auth.ts`); wallet authorization in `src/services/walletAuthorization.ts`.
**Redaction and privacy:** `redactSecrets` (`src/domain/redaction.ts`) applied before outbound payloads; `OutboundGuard` (`src/services/outboundGuard.ts`) and `PrivacyPreflight` enforce privacy boundaries.

---

*Architecture analysis: 2026-10-27*

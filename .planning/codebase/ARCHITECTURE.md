<!-- refreshed: 2026-10-26 -->
# Architecture

**Analysis Date:** 2026-10-26

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                  VS Code Extension Host (Node, CJS)                   │
│                         `src/extension.ts`                            │
├───────────────────┬──────────────────────┬───────────────────────────┤
│ Commands / Setup  │  Webview surfaces    │  Chat participant         │
│ `src/services/    │  `src/services/      │  `vscode.chat.create-     │
│  onboarding.ts`   │   panelView.ts`      │   ChatParticipant`        │
│  `gsdCommands.ts` │  `src/services/      │  (in extension.ts)        │
│  `gsdUpdater.ts`  │   chat.ts` (HTML +   │                           │
│                   │   message router)    │                           │
├───────────────────┴──────────┬───────────┴───────────────────────────┤
│  Application services        │  Orchestration                         │
│  `src/services/auth.ts`      │  `agentOrchestrator.ts`, `gsdRunner.ts`│
│  `profileStore.ts`           │  `multimodalOrchestrator.ts`           │
│  `providerFactory.ts`        │  `generationService.ts`                │
│  `nearAiClient.ts`           │  `resumableExecution.ts`               │
│  `stakingService.ts`         │  `capabilityRouter.ts`                 │
├──────────────────────────────┴────────────────────────────────────────┤
│  Policy / safety gates                                                 │
│  `policyGate.ts`, `approvalService.ts`, `privacyPreflight.ts`,         │
│  `memoryApproval.ts`, `walletAuthorization.ts`                         │
├────────────────────────────────────────────────────────────────────────┤
│  Pure domain model (no `vscode` import)  `src/domain/*.ts`             │
├───────────────────────────────┬────────────────────────────────────────┤
│  Local persistence            │  External systems                       │
│  `<workspace>/.planning/      │  NEAR AI Cloud OpenAI-compatible API    │
│   .near-ai/*.json`            │  Open-GSD CLI (child process, spawn)    │
│  VS Code `SecretStorage`      │  npm registry (`@opengsd/gsd-core`)     │
│  `<workspace>/.planning/      │  VS Code external URI opener            │
│   HANDOFF.json`               │                                         │
└───────────────────────────────┴────────────────────────────────────────┘
```

## Pattern Overview

**Overall:** Layered VS Code extension with a pure domain core, a service layer that owns I/O and side effects, and a webview message router that acts as the only UI boundary. Policy gates sit between requested actions and execution.

**Key Characteristics:**
- Single entry point (`src/extension.ts`) that wires services into VS Code commands, a webview view provider, and an optional chat participant. There is no DI container; services are constructed inline with explicit arguments.
- Domain modules in `src/domain/` are pure TypeScript (types, validators, pure builders, redaction). Verified: no file under `src/domain/` imports `vscode`. This is the layer to put business rules that must be unit-testable without the host.
- Services in `src/services/` depend on `vscode` (UI, secrets, webviews) and `node:fs`/`node:child_process`. Persistence classes take an injectable `fileSystem` object (for example `activityStore.ts`, `profileStore.ts`, `teamStudio.ts`, `contextGraphStore.ts`) so tests can replace disk I/O.
- The chat webview is the full workspace UI. All UI→host traffic is a typed message (`parseChatWebviewMessage` in `src/services/chatBridge.ts`) dispatched by a large `onDidReceiveMessage` switch in `src/services/chat.ts`. Host→UI replies are built by pure message builders in `chatBridge.ts` (for example `multimodalStatusMessage`, `generationStatusMessage`, `walletStatusMessage`) and then sanitized before `postMessage`.
- Side-effecting operations follow a preview → approve → execute pattern: `generationService.ts` (`preview`, `approve`, `publishOperation`), `multimodalOrchestrator.ts` (prepare/approve/cancel), `memoryApproval.ts` (`MemoryApprovalRegistry.create`), `stakingService.ts` (`createPreview`, `confirmPreview` with fingerprint), and `approvalService.ts`. The UI receives the preview, the user confirms, and the host re-checks a fingerprint before acting.
- Writes to the workspace go through "managed boundary" paths under `.planning/.near-ai/`, and writes use temp-file-then-rename for atomicity (for example `activityStore.ts` line ~110, `auditStore.ts` line ~50, `resumableExecution.ts` `persist`).

## Layers

**Extension bootstrap / host integration:**
- Purpose: Register commands, the secondary-sidebar webview, and the chat participant; construct long-lived services.
- Location: `src/extension.ts`
- Contains: `activate`, `deactivate`, command handlers, setup input flows (`configureApiKey`, `saveProfileCredential`), `showStatus`, `saveCheckpoint`.
- Depends on: `services/auth`, `services/profileStore`, `services/gsdUpdater`, `services/settings`, `services/onboarding`, `services/chat`, `services/gsdCommands`, `services/stakingService`, `services/chatBridge` (for `walletStatusCopy`), `services/panelView`, `services/handoff`, `domain/redaction`, `domain/auth`.
- Used by: VS Code extension host (via `package.json` `main: ./dist/extension.js`).

**Webview surfaces:**
- Purpose: Host the chat UI either as a secondary-sidebar view or as an editor-column panel.
- Location: `src/services/panelView.ts` (`NearAiPanelViewProvider`, view id `nearAiChatView`), `src/services/chat.ts` (`openChat`, `attachChatToView`, `initializeChat`, inline HTML in `chatHtml2`), `src/services/onboarding.ts` (onboarding HTML).
- Contains: HTML template strings with inline script; message switch; wallet status panel wrapper (`withWalletStatusPanel`).
- Depends on: nearly every service (chat.ts imports ~40 modules), `services/chatBridge.ts` for message types and builders.
- Used by: `extension.ts` only.

**Message contract (UI boundary):**
- Purpose: Define and validate every message between webview and host; shape host→UI payloads and strip sensitive fields.
- Location: `src/services/chatBridge.ts` (~750 lines), `src/domain/chatProgress.ts` (`normalizePrompt`, `PromptResponse`, `safeProgressText`).
- Contains: `ChatWebviewMessage`, `TeamWebviewMessage`, `parseChatWebviewMessage`, `*Message` builders, `sanitizeContextGraphNode`, `cloneWallet`, `walletErrorMessage`, `profileStatusMessage`.
- Depends on: domain types only, plus `CapabilityRouter`, `validateMemberContract`.
- Used by: `chat.ts`, and tests in `src/test/chatBridge.test.ts`, `src/test/chatProgress.test.ts`.

**Application services:**
- Purpose: Implement features that run on the host.
- Location: `src/services/*.ts` (36 files).
- Contains: auth and credential handling, provider factory and NEAR AI client, agent orchestration, routing, memory, multimodal intake, generation, staking, team studio, analytics, audit, reputation, GSD runner and updater.
- Depends on: `domain/*`, `node:fs/promises`, `node:child_process`, `vscode` where UI is needed.
- Used by: `chat.ts`, `extension.ts`, and other services (for example `agentOrchestrator.ts` composes `AgentProfileStore`, `PolicyGate`, `CapabilityRouter`, `ContextGraphMemory`, `TeamStudioStore`, `PrivacyPreflight`).

**Policy and approval gates:**
- Purpose: Decide whether an action may run, and require explicit user approval for writes, network, shell, git, wallet, and memory mutations.
- Location: `src/domain/policy.ts` (`defaultActionPolicy`, `ActionCapability`), `src/services/policyGate.ts`, `src/services/approvalService.ts`, `src/services/privacyPreflight.ts`, `src/services/memoryApproval.ts`, `src/services/walletAuthorization.ts`, `src/services/capabilityRouter.ts`.
- Contains: capability checks, approval registries keyed by operation id, fingerprinted previews.
- Depends on: `domain/policy`, `domain/capabilities`, `domain/privacy`.
- Used by: `agentOrchestrator.ts`, `multimodalOrchestrator.ts`, `generationService.ts`, `chat.ts`.

**Provider / inference layer:**
- Purpose: Talk to NEAR AI Cloud (OpenAI-compatible) and map errors and usage.
- Location: `src/services/nearAiClient.ts` (`NearAiClient`, `NearAiError`, ~480 lines), `src/services/providerFactory.ts` (`createNearAiProvider` resolves a scoped credential via `AuthService` and a `ResolvedProvider`), `src/services/generationService.ts` (`NearAiGenerationAdapter`).
- Depends on: `services/auth`, `domain/auth`, `domain/generation`.
- Used by: `chat.ts`, `multimodalOrchestrator.ts`, `generationService.ts`.

**Domain model:**
- Purpose: Types, pure builders, validators, and policy data, with no VS Code dependency.
- Location: `src/domain/*.ts` (22 files, for example `auth.ts`, `agents.ts`, `routing.ts`, `policy.ts`, `contextGraph.ts`, `multimodal.ts`, `generation.ts`, `staking.ts`, `teamStudio.ts`, `gsdStatus.ts`, `gsdCommands.ts`, `redaction.ts`, `privacy.ts`, `version.ts`).
- Depends on: nothing inside the project (types are imported by services and by `chatBridge.ts`).
- Used by: every other layer.

**Open-GSD integration:**
- Purpose: Run Open-GSD commands and read `.planning/` state.
- Location: `src/services/gsdRunner.ts` (`GsdRunner`, `spawn` with `shell: false` and `buildInvocation` argv builder), `src/services/gsdUpdater.ts` (`GsdUpdater.start` checks the stable `@opengsd/gsd-core` channel at startup and periodically), `src/services/gsdCommands.ts` (VS Code quick pick), `src/domain/gsdCommands.ts` (`GSD_COMMANDS` catalog), `src/domain/gsdStatus.ts` (`parseGsdPlanningState`, `formatGsdStatusLine`).
- Depends on: `node:child_process`, `domain/gsdCommands`, `domain/chatProgress`.
- Used by: `chat.ts`, `extension.ts`.

## Data Flow

### Primary Request Path (chat prompt dispatch)

1. Webview posts a message; `parseChatWebviewMessage` in `src/services/chatBridge.ts` validates it.
2. `initializeChat` message switch in `src/services/chat.ts` (`panel.webview.onDidReceiveMessage`, around line 84) routes by `message.type`.
3. Active profile and scoped credential are resolved through `ProfileStore` (`src/services/profileStore.ts`) and `AuthService` (`src/services/auth.ts`), then `createNearAiProvider` (`src/services/providerFactory.ts`) builds a `NearAiClient` (`src/services/nearAiClient.ts`).
4. Privacy and policy checks run (`src/services/privacyPreflight.ts`, `src/services/policyGate.ts`); the request is streamed to NEAR AI.
5. Progress and assistant turns are appended via `appendAssistantTurn` / `appendUserTurn` and posted back as sanitized messages (`chatBridge.ts` builders).
6. Usage and activity are recorded through `ActivityStore` (`src/services/activityStore.ts`) and `AnalyticsStore` (`src/services/analyticsStore.ts`).

### Open-GSD command path

1. User picks a command via `nearAi.gsdCommand` (`src/services/gsdCommands.ts`) or a chat message.
2. `chat.ts` creates a `GsdRunner` (`src/services/gsdRunner.ts`) and calls `buildInvocation` to produce argv (no shell string).
3. `GsdRunner` spawns the installed Open-GSD runtime; events are emitted as `GsdProgressEvent` and mapped through `progressCardFromEvent` (`src/domain/chatProgress.ts`).
4. Planning artifacts under `.planning/` are read by `discoverGsdArtifacts` and `parseGsdPlanningState`.

### Preview → approve → execute (multimodal, generation, memory, wallet)

1. Service creates a record and a preview with a fingerprint (`MultimodalOrchestrator.prepare`, `GenerationService.preview`, `MemoryApprovalRegistry.create`, `StakingService.createPreview`).
2. Host posts the preview to the UI (`*PreviewMessage` builders).
3. User confirms; UI echoes the fingerprint; host verifies it and calls `approve` / `confirmPreview({ explicit: true })`.
4. Execution writes into a managed boundary (for example `.planning/.near-ai/multimodal/<id>.bin`, `src/services/multimodalIntake.ts` line ~108) and updates the operation record.

### Agent team invocation

1. `TeamStudioStore` (`src/services/teamStudio.ts`) holds accepted teams and a ledger.
2. `invokeBoundTeam` in `src/services/agentOrchestrator.ts` checks `validateTeamBinding`, `PrivacyPreflight`, `CapabilityRouter.route`, and `PolicyGate`, then emits `AgentLifecycleEvent` values (`src/domain/routing.ts`).

**State Management:**
- Extension-global secrets: VS Code `context.secrets` through `AuthService` (`src/services/auth.ts`). Keys are scoped per profile (`scopedSecret`).
- Workspace state: JSON files under `<workspace>/.planning/.near-ai/` (`profileStore`, `agentOrchestrator`, `contextGraphStore`, `activityStore`, `auditStore`, `teamStudio`, `multimodal`, `resumableExecution`, `agent-profiles`). Each writes via temp file and rename.
- Continuity handoffs: `src/services/handoff.ts` writes `<workspace>/.planning/HANDOFF.json`.
- In-memory: per-panel `state` object in `initializeChat` (`chat.ts`) holds the abort controller, selected model, and conversation history.

## Key Abstractions

**`AuthService` and scoped credentials:**
- Purpose: Store and retrieve API keys and refresh tokens in VS Code SecretStorage, keyed per profile scope.
- Examples: `src/services/auth.ts`, `src/domain/auth.ts` (`OrganizationProfile`, `ProjectCredentialScope`, `deriveProfileId`).
- Pattern: Secret-store wrapper; never write credentials to workspace files.

**`ProfileStore`:**
- Purpose: Per-workspace project profiles (organization, base URL, validation status, active profile).
- Examples: `src/services/profileStore.ts` (persists to `.planning/.near-ai/auth-profiles.json`).
- Pattern: Repository with injectable `fileSystem`; `validate()` calls the provider.

**`NearAiClient` and `NearAiError`:**
- Purpose: Typed client for NEAR AI Cloud chat, models, and usage endpoints.
- Examples: `src/services/nearAiClient.ts`.
- Pattern: Adapter over OpenAI-compatible HTTP; errors normalized through `NearAiError` and `providerErrorMessage`.

**`PolicyGate` and `ActionCapability`:**
- Purpose: Map requested actions (file write, shell, network, git, wallet) to allow/ask/deny under `ActionPolicy` from `src/domain/policy.ts`.
- Examples: `src/services/policyGate.ts`, `src/domain/policy.ts`.
- Pattern: Policy object plus gate function; settings-driven mode through `src/services/settings.ts`.

**`ContextGraphMemory`:**
- Purpose: Local graph of project memory with scopes, slices for agent tasks, and approval-gated mutations.
- Examples: `src/services/contextGraphMemory.ts`, `src/services/contextGraphStore.ts`, `src/domain/contextGraph.ts`, `src/services/memoryApproval.ts`.
- Pattern: Store + service + approval registry; slices filter by `localOnly` and `providerBoundary`.

**`MultimodalOrchestrator` and `GenerationService`:**
- Purpose: Long-running, resumable operations (attachments and media generation) with status records.
- Examples: `src/services/multimodalOrchestrator.ts`, `src/services/generationService.ts`, `src/services/multimodalIntake.ts`, `src/services/resumableExecution.ts`.
- Pattern: Operation record state machine with `operationId`; approval before publish or write.

**`StakingService`:**
- Purpose: Wallet entitlement status and staking previews. Currently constructed as `StakingService.unavailable()` in `extension.ts` (the status copy reports that writes are disabled).
- Examples: `src/services/stakingService.ts`, `src/domain/staking.ts`, `src/services/walletAuthorization.ts`.
- Pattern: Preview/confirm with fingerprint; history stored through the same operation model.

## Entry Points

**Extension activation:**
- Location: `src/extension.ts` (`activate`), compiled to `dist/extension.js` (`package.json` `main`).
- Triggers: `onStartupFinished`, `onCommand:nearAi.*`, `onView:nearAiChatView`, `onChatParticipant:nearAi` (see `package.json` `activationEvents`).
- Responsibilities: Construct `AuthService`, start `GsdUpdater`, register commands, register the webview provider, register the chat participant when `vscode.chat.createChatParticipant` exists.

**Webview view provider:**
- Location: `src/services/panelView.ts` (`NearAiPanelViewProvider.resolveWebviewView`).
- Triggers: VS Code opening the secondary sidebar container `nearAiSecondaryViewContainer`.
- Responsibilities: Enable scripts and delegate to `attachChatToView`.

**Chat participant:**
- Location: inline in `src/extension.ts` (participant id `nearAi`).
- Triggers: Native chat requests to `@nearAi`.
- Responsibilities: Execute `nearAi.openChat` and return a button to the workspace.

**Command handlers:**
- Location: `src/extension.ts` `registerCommand` calls for `nearAi.setup`, `nearAi.status`, `nearAi.openChat`, `nearAi.gsdCommand`, `nearAi.gsdProgress`, `nearAi.saveCheckpoint`.

**Build and release scripts:**
- Location: `scripts/install-global-extension.mjs`, `scripts/verify-release-content.mjs`, `scripts/generate-near-ai-icon.mjs`, `scripts/generate-marketplace-gifs.mjs`.
- Triggers: `npm run install:global`, `npm run verify:release`, `npm run generate:icon`.

## Architectural Constraints

- **Threading:** Single-threaded VS Code extension host (Node event loop). Long work is `async`; the Open-GSD runtime runs as a child process (`gsdRunner.ts`) so it does not block the host. `AbortController` is used for cancellation in `chat.ts` (`state.abort`).
- **Global state:** Module-level singletons are avoided; the only process-wide objects are the VS Code `ExtensionContext` passed through `activate`, and per-panel `state` objects created inside `initializeChat`. `StakingService.unavailable()` is constructed per status call in `extension.ts`.
- **Circular imports:** None observed in the import headers of `src/extension.ts`, `src/services/chatBridge.ts`, or `src/services/agentOrchestrator.ts`. `chat.ts` imports `type` declarations from `chatBridge.ts` and `chatBridge.ts` imports `CapabilityRouter`/`validateMemberContract` from services, so keep type-only imports in `chatBridge.ts` to avoid cycles. Not exhaustively verified across all 36 services.
- **Domain purity:** `src/domain/` must not import `vscode`, `node:fs`, or `node:child_process`. Verified for current files via grep for `vscode` imports; keep it that way.
- **Build output:** Compiled from `src/**/*.ts` to `dist/` with `tsconfig.json` (`rootDir: src`, `module: commonjs`, `target: ES2022`, `strict: true`). Tests compile into `dist/test/` and run with `node --test`.
- **Workspace boundary:** All extension-owned workspace writes live under `.planning/` (`.planning/.near-ai/`, `.planning/HANDOFF.json`). Keys must never be written to workspace files.

## Anti-Patterns

### Oversized chat controller

**What happens:** `src/services/chat.ts` (~890 lines) holds the entire webview HTML (`chatHtml2`, line ~779), the message switch for every feature (memory, multimodal, generation, wallet, team, GSD), and per-panel state.
**Why it's wrong:** Every new feature adds branches to one `onDidReceiveMessage` handler, which increases the risk of cross-feature regressions and makes the HTML and TypeScript hard to review together.
**Do this instead:** Add a feature-specific handler module under `src/services/` that exports a function taking `(message, host, deps)` and returns a message to post. Register it in the switch in `chat.ts` with one line. Put any new message type in `chatBridge.ts` with a parser and a builder.

### Message builders that also parse

**What happens:** `src/services/chatBridge.ts` mixes type definitions, `parseChatWebviewMessage` validation, outbound builders, and display copy helpers (`walletStatusCopy`, `walletErrorMessage`).
**Why it's wrong:** The file is ~750 lines and imported by both the host and `extension.ts`, so changes to copy couple to the message contract.
**Do this instead:** Keep new outbound copy helpers near the feature domain module (for example `src/domain/staking.ts`), and keep `chatBridge.ts` focused on the message schema.

### Services that read `vscode` directly for logic

**What happens:** `src/services/settings.ts`, `src/services/onboarding.ts`, and `src/services/gsdCommands.ts` import `vscode` and contain business decisions (action policy mode, quick pick filtering).
**Why it's wrong:** Those decisions can only be tested with the VS Code host and cannot run in the pure domain test path.
**Do this instead:** Move the decision into a pure function in `src/domain/` (for example `src/domain/config.ts` already holds config shape) and pass the already-read `vscode` values in as arguments.

### Inline webview HTML and scripts

**What happens:** Webview markup and client script are template strings in `src/services/chat.ts` (`chatHtml2`) and `src/services/onboarding.ts`.
**Why it's wrong:** No type checking or linting for the client script; CSP and nonce handling are not separated from the logic.
**Do this instead:** When changing the chat UI, keep the message names in sync with `chatBridge.ts` types and add a test in `src/test/chatBridge.test.ts` or `src/test/contextGraphUi.test.ts`.

## Error Handling

**Strategy:** Typed error classes per service, converted to user-safe messages before crossing into the webview. Errors never carry raw provider payloads or secrets.

**Patterns:**
- Service-specific error classes: `NearAiError` (`nearAiClient.ts`), `GenerationError` (`generationService.ts`), `MultimodalOperationError` and `MultimodalIntakeError` (`multimodalOrchestrator.ts`, `multimodalIntake.ts`), `ContextGraphError` (`contextGraphMemory.ts`), `MemoryApprovalError` (`memoryApproval.ts`).
- Message mapping through `safe*Error` helpers in `chat.ts` (for example `safeMultimodalError`, `safeGenerationError`, `safeMemoryError`) and `redactSecrets` (`src/domain/redaction.ts`) in `extension.ts`.
- Writes are best-effort in some stores: failures remove the temporary file and continue (for example `resumableExecution.ts` `persist`, `auditStore.ts`). Generation storage failures are surfaced as `output-storage-failed`.

## Cross-Cutting Concerns

**Logging:** No structured logger. Status is surfaced through `vscode.window` messages and `activityStore` / `auditStore` events. Analytics and audit are local JSON stores.

**Validation:** Message validation in `chatBridge.ts` (`parseChatWebviewMessage`, `isPromptId`, `isSessionId`, `isProfileId`); path containment through `isSafeArtifactPath` and `normalizePrompt`; teams through `validateTeamBinding`.

**Authentication:** API keys in VS Code SecretStorage via `AuthService`; project profile selection is explicit in Chat Setup before dispatch. NEAR account sign-in is staged but the token exchange is not configured (`extension.ts` `runSetup` message).

**Redaction:** `src/domain/redaction.ts` (`redactSecrets`) is applied to any error text that reaches the UI or `showErrorMessage`.

---

*Architecture analysis: 2026-10-26*

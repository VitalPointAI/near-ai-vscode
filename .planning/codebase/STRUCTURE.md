---
last_mapped_commit: 0dd12e6e15b0daf804d8c3d1d896241992426082
last_mapped_at: 2026-10-27
---
# Codebase Structure

**Analysis Date:** 2026-10-27

## Directory Layout

```
near-ai-vscode/
├── src/                    # TypeScript sources (compiled by tsc to dist/)
│   ├── extension.ts        # Extension entry: activate()/deactivate()
│   ├── agent/              # Agent runtime: tool loop, tools, permissions, shell, workspace
│   ├── domain/             # Pure models, policy, privacy, redaction (no vscode imports)
│   ├── gsd/                # OpenGSD (@opengsd/gsd-core) runtime, host, library, tools
│   ├── services/           # VS Code adapters, orchestration, NEAR AI client, stores
│   └── test/               # node:test suites (*.test.ts) and e2e/ harness
├── test/fixtures/          # Static test fixtures (tdx attestation, media samples)
├── media/                  # Extension icons and webview assets
│   └── chat/               # chat.js, markdown.js, chat.css (webview front-end)
├── docs/marketplace/       # Marketplace screenshots (PNG)
├── scripts/                # Node build/release helper scripts (.mjs)
├── dist/                   # tsc output (generated, not hand-edited)
├── .planning/              # GSD planning docs, phases, codebase maps
├── .codex/, .claude/, .agents/  # Agent tooling config (generated/installed)
├── .vscode-test/           # Downloaded VS Code test runtime (generated)
├── .aws/                   # AWS-related local config directory
├── node_modules/           # npm dependencies (generated)
├── package.json            # Manifest, contributes, scripts
├── package-lock.json
├── tsconfig.json           # rootDir src -> outDir dist, strict, ES2022, commonjs
├── .vscodeignore           # Files excluded from .vsix packaging
├── *.vsix                  # Packaged extension artifacts (generated)
├── README.md, CHANGELOG.md, SECURITY.md, LICENSE
```

## Directory Purposes

**`src/agent/`:**
- Purpose: Model-driven agent runtime, independent of chat UI.
- Contains: `loop.ts` (AgentRun), `tools.ts` (CORE_TOOLS), `extraTools.ts`, `permissions.ts`, `workspace.ts`, `shell.ts`, `checkpoints.ts`, `context.ts`, `attachments.ts`, `diff.ts`, `glob.ts`, `systemPrompt.ts`, `teams.ts`, `worktree.ts`.
- Key files: `src/agent/loop.ts`, `src/agent/tools.ts`, `src/agent/permissions.ts`, `src/agent/workspace.ts`
- Note: has 14 files; no `vscode` imports.

**`src/domain/`:**
- Purpose: Types and pure decision logic shared across layers.
- Contains: 22 modules, e.g. `policy.ts`, `routing.ts`, `agents.ts`, `teamStudio.ts`, `privacy.ts`, `redaction.ts`, `config.ts`, `auth.ts`, `version.ts`, `gsdCommands.ts`, `gsdStatus.ts`.
- Key files: `src/domain/policy.ts` (action capabilities), `src/domain/config.ts` (default settings, `isSecureEndpoint`).

**`src/services/`:**
- Purpose: Everything that touches VS Code APIs, network, or persistent storage.
- Contains: 42 modules grouped by concern:
  - Chat and UI: `chat.ts`, `chatBridge.ts`, `chatParticipant.ts`, `panelView.ts`, `agentSession.ts`, `onboarding.ts`, `handoff.ts`, `workspaceCommands.ts`
  - Model access: `nearAiClient.ts`, `providerFactory.ts`, `providerCache.ts`, `attestation.ts`
  - Auth and wallet: `auth.ts`, `profileStore.ts`, `walletAuthorization.ts`, `stakingService.ts`
  - Policy and safety: `policyGate.ts`, `privacyPreflight.ts`, `outboundGuard.ts`, `approvalService.ts`, `memoryApproval.ts`, `emergencyStop.ts`
  - Agents and teams: `agentOrchestrator.ts`, `agentProfiles.ts`, `agentTeams.ts`, `capabilityRouter.ts`, `reputation.ts`, `fleetView.ts`, `teamStudio.ts`, `resumableExecution.ts`
  - Multimodal: `multimodalIntake.ts`, `multimodalOrchestrator.ts`, `generationService.ts`
  - Persistence: `transcripts.ts`, `activityStore.ts`, `analyticsStore.ts`, `auditStore.ts`, `contextGraphStore.ts`, `contextGraphMemory.ts`
  - Settings and project: `settings.ts`, `projectInitialization.ts`, `gsdCommands.ts`
- Key files: `src/services/chat.ts` (951 lines), `src/services/nearAiClient.ts` (754 lines), `src/services/agentOrchestrator.ts`, `src/services/agentSession.ts`.

**`src/gsd/`:**
- Purpose: Integration with the external OpenGSD package.
- Contains: `runtime.ts` (install, update, self-test, shell env), `host.ts` (command catalog), `library.ts` (loads skills and agents), `tools.ts`.
- Key files: `src/gsd/runtime.ts` (189 lines), `src/gsd/host.ts`.

**`src/test/`:**
- Purpose: Unit and integration tests run by `node --test` against compiled `dist/test/`.
- Contains: 57 entries, including `*.test.ts` suites and `e2e/` (`run.ts`, `suite.ts`).
- Key files: `src/test/live.test.ts` (live provider checks), `src/test/worktreeIsolation.test.ts`, `src/test/streamRecovery.test.ts`.

**`media/chat/`:**
- Purpose: Webview client code loaded by `sidebarHtml` / chat HTML.
- Contains: `chat.js`, `markdown.js`, `chat.css`.
- Key files: `media/chat/chat.js` (client-side message handling matching `chatBridge.ts` types).

**`scripts/`:**
- Purpose: Release and tooling helpers.
- Contains: `verify-release-content.mjs` (checks packaged `.vsix`), `install-global-extension.mjs`, `generate-near-ai-icon.mjs`, `generate-marketplace-screenshots.mjs`.

**`.planning/`:**
- Purpose: GSD planning state for this project.
- Contains: `PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `STATE.md`, `UX-CONTRACT.md`, `WINDOWS.md`, `phases/NN-*/` (per-phase `OVERVIEW.md`, `*-PLAN.md`, `*-SUMMARY.md`, `*-VERIFICATION.md`), `research/`, `codebase/` (these maps).

## Key File Locations

**Entry Points:**
- `src/extension.ts`: VS Code activation and command registration.
- `dist/extension.js`: compiled entry referenced by `package.json` `main`.

**Configuration:**
- `package.json`: extension manifest, `contributes` (commands, views, configuration), npm scripts.
- `tsconfig.json`: compiler settings.
- `.vscodeignore`: packaging exclusions.
- `.planning/config.json`: GSD workflow configuration.

**Core Logic:**
- `src/agent/loop.ts`: agent tool loop.
- `src/services/chat.ts`: webview message dispatch and session lifecycle.
- `src/services/nearAiClient.ts`: NEAR AI HTTP and streaming client.
- `src/domain/policy.ts`: action capability decisions.

**Testing:**
- `src/test/*.test.ts`: unit and integration tests.
- `src/test/e2e/run.ts`, `src/test/e2e/suite.ts`: end-to-end harness.
- `test/fixtures/`: fixtures referenced by tests (TDX quote, PEM keys, WAV and PNG media).

## Naming Conventions

**Files:**
- camelCase module names for TypeScript sources: `nearAiClient.ts`, `agentOrchestrator.ts`, `policyGate.ts`, `gsdCommands.ts`.
- Test files mirror the module name with a `.test.ts` suffix: `src/test/nearAiClient.test.ts` covers `src/services/nearAiClient.ts`. Some tests use feature names instead (`phase11.test.ts`, `securityReview.test.ts`).
- Webview assets are lowercase: `chat.js`, `markdown.js`, `chat.css`.
- Planning docs use UPPERCASE in `.planning/` and `NN-NN-PLAN.md` / `NN-NN-SUMMARY.md` for phase plans.

**Directories:**
- Lowercase single words: `agent`, `domain`, `services`, `gsd`, `test`.
- Phase directories use `NN-kebab-case-name` under `.planning/phases/`.

**Classes and exports:**
- Classes are PascalCase and suffixed by role where applicable: `*Store`, `*Service`, `*Provider`, `*Error`, `*Run`.

## Where to Add New Code

**New agent tool:**
- Implementation: add an `AgentTool<I>` to `src/agent/extraTools.ts` (or `src/agent/tools.ts` for core filesystem/shell tools), then register it in the tool array used by `AgentConversation`.
- Capability and approval: map it to an `ActionCapability` in `src/domain/policy.ts` and cover it in `src/agent/permissions.ts`.
- Tests: `src/test/agentTools.test.ts` (existing suite) or a new `src/test/<tool>.test.ts`.

**New chat/webview message type:**
- Type definition: `src/services/chatBridge.ts` (add to `ChatWebviewMessage` and a builder/parser).
- Handler: a new module in `src/services/` (e.g., `src/services/<feature>.ts`), dispatched from `src/services/chat.ts`.
- Front-end: `media/chat/chat.js` and styles in `media/chat/chat.css`.
- Tests: `src/test/chatBridge.test.ts` or `src/test/chatSendPath.test.ts`.

**New VS Code command:**
- Declaration: `contributes.commands` in `package.json`.
- Registration: `src/extension.ts` inside the `context.subscriptions.push(...)` block; implement the handler in a `src/services/` module when non-trivial.

**New NEAR AI provider capability or model operation:**
- Client method: `src/services/nearAiClient.ts`.
- Factory/validation: `src/services/providerFactory.ts`.
- Capability metadata: `src/domain/capabilities.ts`.

**New domain policy or type:**
- Location: `src/domain/<concern>.ts` with no `vscode` import.
- Tests: `src/test/policy.test.ts` pattern.

**New persistent store:**
- Location: `src/services/<name>Store.ts` (follow `transcripts.ts`, `auditStore.ts`).
- Wire-up: instantiate in `src/extension.ts` or `chat.ts` and pass into consumers.

**New GSD integration:**
- Location: `src/gsd/` (runtime, host, library). Command metadata belongs in `src/domain/gsdCommands.ts`.

**Utilities:**
- Pure helpers: `src/domain/` (no VS Code) or `src/agent/shell.ts` / `src/agent/workspace.ts` for file and process helpers.

## Special Directories

**`dist/`:**
- Purpose: Compiled JavaScript from `src/` (`tsc -p tsconfig.json`).
- Generated: Yes
- Committed: No (regenerated by `npm run compile`)

**`node_modules/`:**
- Purpose: npm dependencies.
- Generated: Yes
- Committed: No

**`.vscode-test/`:**
- Purpose: VS Code runtime downloaded for `test:e2e`.
- Generated: Yes
- Committed: No

**`*.vsix`** (`near-ai-vscode-0.3.1.vsix`, `near-ai-vscode-0.4.0.vsix`):
- Purpose: Packaged extension from `npm run package`.
- Generated: Yes
- Committed: Present in working tree; check `.gitignore` before committing new artifacts.

**`.codex/`, `.claude/`, `.agents/`:**
- Purpose: Installed agent/skill configuration for AI coding tools.
- Generated: Yes (by GSD installers)
- Committed: Yes (tracked in git; modified in working tree)

**`.planning/.near-ai/`:**
- Purpose: Project marker directory that activates the extension (`activationEvents`).
- Generated: Yes (by project initialization in `src/services/projectInitialization.ts`)
- Committed: Per project policy

---

*Structure analysis: 2026-10-27*

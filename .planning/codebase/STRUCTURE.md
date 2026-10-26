# Codebase Structure

**Analysis Date:** 2026-10-26

## Directory Layout

```
near-ai-vscode/
├── src/                      # TypeScript source (compiled to dist/)
│   ├── extension.ts          # Extension entry point (activate/deactivate)
│   ├── domain/               # Pure types, validators, builders (no vscode import)
│   ├── services/             # Host services, UI providers, persistence, I/O
│   └── test/                 # node:test suites (compiled to dist/test/)
├── scripts/                  # Node .mjs build, install, and release helpers
├── media/                    # Extension icons (PNG/SVG) used by package.json
├── docs/marketplace/         # Marketplace GIFs
├── dist/                     # Build output (generated, gitignored)
├── node_modules/             # Dependencies (generated, gitignored)
├── .planning/                # GSD planning state for this project (committed)
│   ├── phases/               # Phase plans, summaries, verification per phase
│   ├── research/             # Platform research notes
│   ├── codebase/             # Codebase map documents (this folder)
│   └── *.md, *.json          # PROJECT, ROADMAP, REQUIREMENTS, STATE, config
├── .codex/                   # Installed Open-GSD / Codex agent runtime (vendored, not app code)
├── .agents/                  # Agent skill directory (currently empty)
├── .aws/                     # AWS config directory present at repo root (contents not analyzed)
├── .git-real/, .git-unusable-archive/  # Git archive artifacts (excluded from analysis)
├── docs/                     # Documentation assets
├── package.json              # Extension manifest, scripts, contributes
├── package-lock.json         # npm lockfile
├── tsconfig.json             # TypeScript config (rootDir src, outDir dist)
├── README.md, SECURITY.md, LICENSE
├── .vscodeignore             # Files excluded from .vsix packaging
├── .gitignore                # dist/, node_modules/, *.vsix, .env*, .vscode-test/
└── near-ai-vscode-*.vsix     # Packaged build artifacts (generated, gitignored)
```

## Directory Purposes

**`src/`:**
- Purpose: All extension source.
- Contains: One entry file, 22 domain modules, 36 service modules, 41 test files.
- Key files: `src/extension.ts`

**`src/domain/`:**
- Purpose: Pure domain model. Types, validators, pure builders, redaction, and policy data.
- Contains: `.ts` files with exports only; no `vscode`, `node:fs`, or `node:child_process` imports.
- Key files: `src/domain/policy.ts` (`defaultActionPolicy`), `src/domain/routing.ts` (routing and lifecycle types), `src/domain/auth.ts` (`OrganizationProfile`, `deriveProfileId`), `src/domain/gsdCommands.ts` (`GSD_COMMANDS`), `src/domain/gsdStatus.ts` (`parseGsdPlanningState`), `src/domain/redaction.ts` (`redactSecrets`), `src/domain/chatProgress.ts` (`normalizePrompt`, `progressCardFromEvent`), `src/domain/contextGraph.ts`, `src/domain/multimodal.ts`, `src/domain/generation.ts`, `src/domain/staking.ts`, `src/domain/teamStudio.ts`, `src/domain/agents.ts`, `src/domain/capabilities.ts`, `src/domain/analytics.ts`, `src/domain/activity.ts`, `src/domain/motion.ts`, `src/domain/privacy.ts`, `src/domain/continuity.ts`, `src/domain/config.ts`, `src/domain/version.ts`

**`src/services/`:**
- Purpose: Stateful or side-effecting modules: UI, storage, provider calls, child processes, orchestration.
- Contains: 36 `.ts` files, grouped by concern below.
- Key files: `src/services/chat.ts` (main webview controller), `src/services/chatBridge.ts` (message contract), `src/services/nearAiClient.ts` (inference client), `src/services/auth.ts` (secrets), `src/services/profileStore.ts` (project profiles), `src/services/gsdRunner.ts` (Open-GSD child process), `src/services/agentOrchestrator.ts` (agent invocation), `src/services/panelView.ts` (sidebar view provider)

**`src/test/`:**
- Purpose: Unit and integration-style tests run with `node --test` against compiled output.
- Contains: `*.test.ts` files named after the service or domain module they cover (for example `chatBridge.test.ts`, `gsdRunner.test.ts`, `policyGate.test.ts`, `profileStore.test.ts`).
- Key files: `src/test/chatBridge.test.ts`, `src/test/nearAiClient.test.ts`, `src/test/agentOrchestrator.test.ts`, `src/test/teamInvocation.test.ts`, `src/test/multimodalOrchestration.test.ts`

**`scripts/`:**
- Purpose: Release and developer tooling.
- Contains: `install-global-extension.mjs`, `verify-release-content.mjs`, `generate-near-ai-icon.mjs`, `generate-marketplace-gifs.mjs`.

**`media/`:**
- Purpose: Icon assets referenced by `package.json` (`icon`, view `icon`).
- Contains: `near-ai-vscode-icon-128.png`, `near-ai-vscode-icon.svg`, `near-ai-icon.png`, `near-ai-vscode-icon-master.png`, `near-ai-vscode-icon.png`.

**`.planning/`:**
- Purpose: GSD project state. Not compiled, not shipped in the .vsix.
- Contains: `PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `STATE.md`, `UX-CONTRACT.md`, `WINDOWS.md`, `config.json`, `state.json`, `estimation-calibration.json`, `milestone.lock`, `phases/`, `research/`, `codebase/`.
- Key files: `.planning/ROADMAP.md`, `.planning/STATE.md`.

**`.planning/phases/`:**
- Purpose: One folder per roadmap phase.
- Contains: `01-extension-foundation-and-onboarding/`, `02-near-ai-client-models-and-costs/`, `03-chat-workspace-motion-activity-and-command-bridge/`, `04-agents-routing-approvals-and-analytics/`, `05-verification-hardening-and-release/`, `06-team-studio-and-multimodal-agent-skills/`. Each contains `OVERVIEW.md`, `NN-MM-PLAN.md`, `NN-MM-SUMMARY.md`, and sometimes `NN-VERIFICATION.md` or `NN-AI-SPEC.md`.

**`.planning/.near-ai/` (runtime, inside a user's workspace, not in this repo):**
- Purpose: Extension-owned JSON stores created in the user's opened workspace.
- Contains: `auth-profiles.json`, `agent-profiles.json`, `agent-orchestrator.json`, `context-graphs.json`, `activity.json`, `audit.json`, `multimodal.json`, `multimodal/`, `resume.json`, team ledger.
- Generated: Yes. Committed: Not expected; treat as local state.

**`.codex/`:**
- Purpose: Vendored Open-GSD / Codex runtime (agent prompts, hook scripts, changeset tools, install manifests).
- Contains: `agents/*.md` and `*.toml` agent definitions, `hooks/`, `scripts/`, `gsd-core/`, `gsd-file-manifest.json`, `config.toml`, `hooks.json`.
- Not application code. Do not import from `src/`.

## Key File Locations

**Entry Points:**
- `src/extension.ts`: Extension activation, commands, webview registration, chat participant.
- `dist/extension.js`: Compiled entry referenced by `package.json` `main` (generated).

**Configuration:**
- `package.json`: Extension manifest, `contributes.commands`, `contributes.configuration` (`nearAi.baseUrl`, `nearAi.authMode`, `nearAi.defaultModel`, and others), activation events.
- `tsconfig.json`: Compiler options.
- `src/services/settings.ts`: Reads `nearAi.*` VS Code settings into a typed object (`readSettings`).
- `src/domain/config.ts`: Config types (for example `AuthMode`).
- `.vscodeignore`: Packaging exclusions.

**Core Logic:**
- `src/services/chat.ts`: Chat webview controller and message switch.
- `src/services/chatBridge.ts`: Message schema and builders.
- `src/services/nearAiClient.ts`: NEAR AI Cloud HTTP client.
- `src/services/providerFactory.ts`: Provider resolution.
- `src/services/agentOrchestrator.ts`: Team invocation and lifecycle.
- `src/services/capabilityRouter.ts`: Capability routing.
- `src/services/gsdRunner.ts`: Open-GSD process execution.
- `src/services/generationService.ts`: Generation operations with preview and publication.
- `src/services/multimodalOrchestrator.ts`, `src/services/multimodalIntake.ts`: Attachment intake and multimodal runs.
- `src/services/contextGraphMemory.ts`: Context graph memory.

**Persistence:**
- `src/services/profileStore.ts`, `src/services/activityStore.ts`, `src/services/auditStore.ts`, `src/services/contextGraphStore.ts`, `src/services/teamStudio.ts`, `src/services/analyticsStore.ts`, `src/services/agentProfiles.ts`, `src/services/resumableExecution.ts`, `src/services/handoff.ts`, `src/services/reputation.ts`.

**Security and Policy:**
- `src/services/auth.ts`: Secret storage.
- `src/services/policyGate.ts`, `src/services/approvalService.ts`, `src/services/privacyPreflight.ts`, `src/services/memoryApproval.ts`, `src/services/walletAuthorization.ts`.
- `src/domain/redaction.ts`, `src/domain/privacy.ts`, `src/domain/policy.ts`.

**Testing:**
- `src/test/*.test.ts`: All tests. Run with `npm test` (compile then `node --test dist/test/*.test.js`).

## Naming Conventions

**Files:**
- camelCase module names: `src/services/chatBridge.ts`, `src/services/profileStore.ts`, `src/domain/gsdStatus.ts`.
- Test files mirror source names with `.test.ts` suffix: `src/test/policyGate.test.ts` covers `src/services/policyGate.ts`. Exception: `src/test/activity.test.ts` covers `src/domain/activity.ts`, and `src/test/activityStore.test.ts` covers `src/services/activityStore.ts`.
- Store modules end in `Store` (`profileStore.ts`, `auditStore.ts`) and orchestration modules in `Orchestrator` or `Service` (`agentOrchestrator.ts`, `generationService.ts`, `stakingService.ts`).
- Domain files use a noun for the concept (`agents.ts`, `policy.ts`, `routing.ts`).

**Directories:**
- Flat lowercase: `src/domain`, `src/services`, `src/test`, `scripts`, `media`.
- `.planning/phases/` folders use `NN-kebab-case-title` (for example `03-chat-workspace-motion-activity-and-command-bridge`), and plan files use `NN-MM-PLAN.md` / `NN-MM-SUMMARY.md`.

**Identifiers:**
- Classes PascalCase (`NearAiClient`, `GsdRunner`, `PolicyGate`).
- Functions camelCase (`openChat`, `buildInvocation`, `parseChatWebviewMessage`).
- Message types are kebab-case strings (`'multimodal-status'`, `'memory-slice-preview'`, `'generation-publish'`, `'stake-confirm'`).
- Persisted artifacts use kebab-case file names (`auth-profiles.json`, `agent-orchestrator.json`).
- Operation ids and profile ids are derived by helpers (`deriveProfileId` in `src/domain/auth.ts`).

## Where to Add New Code

**New Feature (host behavior with UI):**
- Domain types and pure logic: `src/domain/<feature>.ts`
- Host service: `src/services/<feature>Service.ts` or `src/services/<feature>Store.ts` (if it persists)
- Message types, parser, and outbound builders: `src/services/chatBridge.ts`
- Message routing: add a case in the switch inside `initializeChat` in `src/services/chat.ts`, delegating to the service
- Webview markup and client script: inline in `src/services/chat.ts` (`chatHtml2`) following the existing pattern
- Tests: `src/test/<feature>.test.ts`

**New VS Code command:**
- Declare in `package.json` under `contributes.commands` and `activationEvents` (`onCommand:<id>`).
- Register in `activate` in `src/extension.ts` with a handler that calls a service.

**New NEAR AI endpoint or provider behavior:**
- Client method: `src/services/nearAiClient.ts`
- Provider wiring: `src/services/providerFactory.ts`
- Types: `src/domain/generation.ts` or a new `src/domain/<area>.ts`

**New persisted store:**
- Implementation: `src/services/<name>Store.ts` taking an injectable `fileSystem` like `src/services/activityStore.ts`, with path under `.planning/.near-ai/<name>.json`, and write via temp file and rename.
- Tests: `src/test/<name>Store.test.ts` using an in-memory fake file system.

**New policy or approval capability:**
- Capability type: `src/domain/policy.ts` (`ActionCapability`) and `src/domain/capabilities.ts`
- Gate logic: `src/services/policyGate.ts` or `src/services/approvalService.ts`
- Tests: `src/test/policyGate.test.ts`, `src/test/approvalService.test.ts`

**New Open-GSD command:**
- Catalog entry: `src/domain/gsdCommands.ts` (`GSD_COMMANDS`)
- Execution: `src/services/gsdRunner.ts` (argv builder; never use a shell string)

**Utilities and shared helpers:**
- Pure helpers: `src/domain/` (for example `redaction.ts`, `chatProgress.ts`)
- Host-only helpers: a new module in `src/services/`; avoid adding a generic `utils` folder.

**Scripts:**
- Node `.mjs` files in `scripts/`, wired through `package.json` `scripts`.

## Special Directories

**`dist/`:**
- Purpose: Compiled JavaScript from `src/` (`tsc -p tsconfig.json`).
- Generated: Yes
- Committed: No (in `.gitignore`)

**`node_modules/`:**
- Purpose: npm dependencies.
- Generated: Yes
- Committed: No

**`*.vsix` (repo root, for example `near-ai-vscode-0.2.1.vsix`):**
- Purpose: Packaged extension from `npm run package`.
- Generated: Yes
- Committed: No (in `.gitignore`)

**`.planning/`:**
- Purpose: Project planning and GSD state for this repository.
- Generated: Partly (by GSD commands)
- Committed: Yes

**`.codex/`:**
- Purpose: Vendored Open-GSD runtime files and agent definitions.
- Generated: Yes (by GSD installer, with `gsd-file-manifest.json`)
- Committed: Yes (present in the working tree)

**`.aws/`, `.env*` (if present):**
- Purpose: Environment or cloud configuration. Existence noted only. Contents were not read. `.env*` is gitignored.
- Generated: No
- Committed: No

**`.git-real/`, `.git-unusable-archive/`:**
- Purpose: Git-related archive directories. Excluded from analysis.

---

*Structure analysis: 2026-10-26*

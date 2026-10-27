---
last_mapped_commit: 0dd12e6e15b0daf804d8c3d1d896241992426082
last_mapped_at: 2026-10-27
---
# Technology Stack

**Analysis Date:** 2026-10-27

## Languages

**Primary:**
- TypeScript 5.x (`^5.7.2`, devDependency) - All extension source under `src/` (`src/extension.ts`, `src/services/`, `src/domain/`, `src/agent/`, `src/gsd/`)

**Secondary:**
- JavaScript (CommonJS output) - Compiled extension in `dist/` (entry `dist/extension.js`); webview scripts `media/chat/chat.js` and `media/chat/markdown.js`
- CSS - Webview styling `media/chat/chat.css`
- Markdown - Open-GSD planning artifacts under `.planning/` and docs under `docs/`
- Node.js `.mjs` scripts - `scripts/generate-near-ai-icon.mjs`, `scripts/install-global-extension.mjs`, `scripts/verify-release-content.mjs`, `scripts/generate-marketplace-screenshots.mjs`

## Runtime

**Environment:**
- VS Code extension host (Electron-based), minimum `vscode >=1.101.0` (`package.json` `engines.vscode`), which runs extensions on Node 22 or later
- Node.js runtime provided by the VS Code extension host; `@types/node` `^22.10.0` is used for typings
- Extension activation: `workspaceContains:.planning/.near-ai/**` (`package.json` `activationEvents`)
- Compile target: ES2022, module `commonjs` (`tsconfig.json`)

**Package Manager:**
- npm (lockfile present: `package-lock.json`, `lockfileVersion: 3`)
- Lockfile: present

## Frameworks

**Core:**
- VS Code Extension API (`vscode` module, `@types/vscode` `1.101.0`) - Commands, webview views, chat participant (`nearAi`), secondary sidebar container, configuration, SecretStorage
- No UI framework: the chat UI is a hand-written webview (`media/chat/chat.js`, `media/chat/markdown.js`, `media/chat/chat.css`)

**Testing:**
- Node.js built-in test runner (`node:test`, `node:assert/strict`) - Run via `node --test dist/test/*.test.js` (`npm test`)
- `@vscode/test-electron` `2.5.2` - Electron-hosted VS Code test harness used by the e2e suite (`src/test/e2e/run.ts`, `src/test/e2e/suite.ts`)
- Headless e2e runs under `xvfb-run` (`npm run test:e2e`)

**Build/Dev:**
- TypeScript compiler `tsc` - `npm run compile` / `npm run lint` (`--noEmit` type check)
- `@vscode/vsce` `^3.2.2` - Packaging to `.vsix` (`npm run package`, `npm run verify:release`)
- No bundler: `tsc` emits one JS file per source file into `dist/`

## Key Dependencies

**Runtime dependencies:**
- None declared. `package.json` has no `dependencies` block; the extension uses only Node.js built-ins and the `vscode` API at runtime. Packages are bundled into the `.vsix` only through the `vsce` packaging step (`--no-dependencies` flag).

**Node built-ins used heavily (from `src/**/*.ts`):**
- `node:path`, `node:fs/promises`, `node:fs`, `node:os`, `node:crypto` - File access, project state, randomness/hashing
- `node:child_process` - Shell tool, git worktree isolation, Open-GSD install (`src/agent/shell.ts`, `src/agent/tools.ts`, `src/agent/worktree.ts`, `src/gsd/runtime.ts`)
- `node:net`, `node:dns/promises`, `node:http` - Endpoint and loopback validation (`src/domain/config.ts`, `src/gsd/tools.ts`)
- `node:vm`, `node:module` - Sandboxed evaluation and module loading paths used by tests and tooling

**Dev dependencies (`package.json`):**
- `@types/node` `^22.10.0` - Node typings
- `@types/vscode` `1.101.0` - VS Code typings (pinned to the engine floor)
- `pdfjs-dist` `6.4.299` - PDF text extraction; copied into `vendor/pdfjs` by `scripts/vendor-pdfjs.mjs` during `npm run compile` and shipped in the VSIX (the only third-party code at runtime)
- `@vscode/test-electron` `2.5.2` - Electron test host
- `@vscode/vsce` `^3.2.2` - Extension packager
- `typescript` `^5.7.2` - Compiler

**External runtime tooling invoked as subprocesses:**
- `npm` - `npm view @opengsd/gsd-core@latest version --json` to find the latest Open-GSD release (`src/gsd/runtime.ts`)
- `npx --yes @opengsd/gsd-core@<version> --claude --global` - Installs Open-GSD into extension storage (`src/gsd/runtime.ts`)
- `git` - Worktree isolation for sub-agents (`src/agent/worktree.ts`), with `GIT_TERMINAL_PROMPT=0`

## Configuration

**Environment:**
- Extension settings are declared in `package.json` under `contributes.configuration` with the `nearAi.*` prefix. Key settings:
  - `nearAi.baseUrl` - default `https://cloud-api.near.ai/v1` (`src/domain/config.ts` `DEFAULT_BASE_URL`)
  - `nearAi.defaultModel` - default `z-ai/glm-5.3` (`DEFAULT_MODEL`)
  - `nearAi.privacyMode` - `standard` or `tee-only`
  - `nearAi.actionPolicy` - `approve-risky` | `mostly-autonomous` | `fully-autonomous`
  - `nearAi.agent.*` - sub-agent model tiers, parallelism (1-16), turn limit, command allow/deny lists, transcript saving, vision/transcription/image model IDs
  - `nearAi.dailySpendLimitUsd` - client-side spend cap (0 = unlimited)
  - `nearAi.autoInstallGsd` - default `true`
- Environment variables read by code (no secret values recorded here):
  - `NEAR_AI_API_KEY` - API key override used in tests and live runs
  - `NEAR_AI_BASE_URL` - base URL override
  - `NEAR_GSD_HOME` - Open-GSD home directory override (4 references in `src/`)
  - `NEAR_LIVE_EVAL`, `NEAR_LIVE_EVAL_OUT`, `NEAR_LIVE_GSD`, `NEAR_LIVE_TRACE` - Opt-in live test switches (`src/test/live.test.ts`)
  - `CI`, `VSCODE_TEST_VERSION`, `PATH` - Test and process environment
- Credentials are stored in VS Code SecretStorage, not in files (`src/services/auth.ts`, `src/domain/auth.ts`)
- `.env` and `.env.*` are git-ignored (`.gitignore`); `.aws/` directory exists at repo root (not read)

**Build:**
- `tsconfig.json` - `strict: true`, `rootDir: src`, `outDir: dist`, `sourceMap: true`, `skipLibCheck: true`, `include: ["src/**/*.ts"]`
- `.vscodeignore` - Excludes `src/**`, `test/**`, `scripts/**`, `.planning/**`, `.codex/**`, `.agents/**`, `node_modules/**`, maps, and `*.tsbuildinfo` from the `.vsix`
- `.gitignore` - Excludes `node_modules/`, `dist/`, `*.vsix`, `.env*`, `.vscode-test/`, `.planning/.near-ai/`, `.planning/HANDOFF.json`

**Package scripts (`package.json`):**
- `compile` - `tsc -p tsconfig.json`
- `lint` - `tsc -p tsconfig.json --noEmit`
- `test` - compile then `node --test dist/test/*.test.js`
- `check` - `lint` then `test`
- `package` - compile then `vsce package`
- `verify:release` - package then `scripts/verify-release-content.mjs`
- `test:e2e` - compile then headless VS Code e2e under `xvfb-run`
- `generate:icon`, `generate:screenshots`, `install:global` - Asset and local-install helpers

## Platform Requirements

**Development:**
- Node.js and npm compatible with TypeScript 5.7 and `@types/node` 22
- VS Code >= 1.101.0 for running the extension
- `git` on PATH (worktree isolation, shell tool)
- `xvfb-run` on Linux for `npm run test:e2e`
- Optional: a local OpenAI-compatible runtime (`hybrid` or `local` provider profiles, `localBaseUrl`), reachable on `http://localhost` or `http://127.0.0.1`

**Production:**
- Distributed as a VS Code extension `.vsix` (publisher `VitalPoint`, name `near-ai-vscode`, version `0.4.0` in `package.json`)
- Marketplace-installable; no server-side deployment. The extension runs entirely in the user's VS Code host.

---

*Stack analysis: 2026-10-27*

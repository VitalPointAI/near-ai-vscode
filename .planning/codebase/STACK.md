# Technology Stack

**Analysis Date:** 2026-10-26

## Languages

**Primary:**
- TypeScript ^5.7.2 (devDependency, `package.json`) - all extension source under `src/` (about 11.7k lines across `src/domain/`, `src/services/`, `src/extension.ts`)

**Secondary:**
- JavaScript (ES modules, `.mjs`) - build and release helper scripts in `scripts/` (`scripts/verify-release-content.mjs`, `scripts/install-global-extension.mjs`, `scripts/generate-near-ai-icon.mjs`, `scripts/generate-marketplace-gifs.mjs`)
- JavaScript (CommonJS) - compiled output in `dist/` (generated, not hand-edited)
- SVG - webview markup built inline in `src/services/chat.ts` and `media/near-ai-vscode-icon.svg`

## Runtime

**Environment:**
- VS Code extension host, `engines.vscode` `>=1.90.0` (`package.json`)
- Node.js runtime provided by VS Code's extension host; `@types/node` ^22.10.0 is used for typings
- Compile target ES2022, module `commonjs` (`tsconfig.json`)

**Package Manager:**
- npm
- Lockfile: present (`package-lock.json`, lockfileVersion tracked in repo)

## Frameworks

**Core:**
- VS Code Extension API (`vscode` module, `@types/vscode` ^1.90.0) - activation, commands, secondary-sidebar webview view (`nearAiChatView`), chat participant (`nearAi`), configuration, SecretStorage. Entry point `src/extension.ts`, compiled to `dist/extension.js` (`package.json` `main`).
- Webviews - hand-rolled HTML with a per-load nonce and strict CSP (`src/services/onboarding.ts`, `src/services/panelView.ts`). No frontend framework.

**Testing:**
- Node built-in test runner (`node --test`), no third-party test framework. Tests live in `src/test/*.test.ts`, compiled to `dist/test/` and run by `npm test`.

**Build/Dev:**
- TypeScript compiler `tsc` ^5.7.2 - `npm run compile` / `npm run watch` / `npm run lint` (`lint` is `tsc --noEmit`; there is no ESLint or Prettier config)
- `@vscode/vsce` ^3.2.2 - packaging to `.vsix` (`npm run package`, `npm run verify:release`)
- No bundler (no webpack, esbuild, or rollup config); `tsc` emits plain files to `dist/`

## Key Dependencies

**Runtime dependencies:**
- None declared. `package.json` has no `dependencies` block; `vsce` is run with `--no-dependencies`. The extension depends only on the VS Code host and Node built-ins.

**Node built-ins used (imported with the `node:` prefix):**
- `node:crypto` - `randomUUID` for wallet state and nonces, hashing for digests (about 20 files)
- `node:fs/promises`, `node:fs`, `node:path` - workspace file I/O for `.planning/` and Open-GSD state (about 25 files)
- `node:child_process` - `spawn` in `src/services/gsdRunner.ts`, `execFile` in `src/services/gsdUpdater.ts`
- `node:util` - `promisify` for `execFile`
- Global `fetch`, `FormData`, `Blob`, `AbortSignal` - HTTP client in `src/services/nearAiClient.ts` (no HTTP library)

**Infrastructure / tooling (devDependencies):**
- `@types/node` ^22.10.0 - Node typings
- `@types/vscode` ^1.90.0 - VS Code typings, matches the `engines` floor
- `@vscode/vsce` ^3.2.2 - extension packager
- `typescript` ^5.7.2 - compiler

**External CLIs invoked at runtime (not bundled):**
- `codex` - Open-GSD runtime executable, spawned as `codex exec --cd <workspace> $gsd-<command>` (`src/services/gsdRunner.ts`, default executable name `'codex'`)
- `npm` and `npx` - used to query and install `@opengsd/gsd-core` (`src/services/gsdUpdater.ts`)

## Configuration

**Extension settings (`package.json` `contributes.configuration`):**
- `nearAi.baseUrl` - default `https://cloud-api.near.ai/v1` (also defined in `src/domain/config.ts` as `DEFAULT_BASE_URL`)
- `nearAi.authMode` - `apiKey` (default) or `nearAccount`
- `nearAi.defaultModel` - optional model id
- `nearAi.actionPolicy` - `approve-risky` (default), `mostly-autonomous`, `fully-autonomous`
- `nearAi.autoInstallGsd` - boolean, default `true`

**Secrets:**
- Stored through VS Code `SecretStorage`, not on disk. Keys are defined in `src/services/auth.ts`: `nearAi.apiKey`, `nearAi.refreshToken`, plus per-project scoped keys (`scopedSecret(...)`, versioned by `SCOPED_SECRET_VERSION = 2`).

**Environment:**
- `.gitignore` excludes `.env` and `.env.*`. No `.env` file was present at the project root during analysis; its contents were not read.
- The source does not read `process.env` for configuration.

**Build:**
- `tsconfig.json` - `strict: true`, `rootDir: src`, `outDir: dist`, `sourceMap: true`, `skipLibCheck: true`, `include: ["src/**/*.ts"]`
- `.vscodeignore` - excludes `src/**`, `scripts/**`, `.planning/**`, `.codex/**`, `.agents/**`, `dist/test/**`, source maps, and `node_modules/**` from the `.vsix`
- `.gitignore` - excludes `node_modules/`, `dist/`, `*.vsix`, `.env*`, `.vscode-test/`, `.git-unusable-archive/`, `.git-real/`

**Project tooling directories (not part of the product build):**
- `.planning/` - GSD planning state (`config.json`, `state.json`, `ROADMAP.md`, `codebase/`)
- `.codex/` - Codex/GSD installed runtime (`gsd-core/`, `hooks/`, `scripts/`, `config.toml`, `hooks.json`)
- `.agents/` - GSD planning mirror and agent config
- `.aws/` - present in the repo root; existence noted only, contents not read

## Platform Requirements

**Development:**
- Node.js and npm (version not pinned; no `.nvmrc` or `engines.node` present)
- VS Code >= 1.90.0 for running the extension
- `codex` CLI on `PATH` for Open-GSD commands
- Commands: `npm install`, `npm run compile`, `npm test`, `npm run check` (lint + test)

**Production / Distribution:**
- Published as a VS Code extension `near-ai-vscode` version `0.2.1`, publisher `VitalPoint` (`package.json`)
- Packaged as `.vsix` via `npm run package`; prebuilt `near-ai-vscode-*.vsix` artifacts for 0.1.0 through 0.2.1 are checked into the repo root
- Entry point `dist/extension.js`; `"license": "MIT"`

---

*Stack analysis: 2026-10-26*

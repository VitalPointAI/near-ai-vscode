---
last_mapped_commit: 0dd12e6e15b0daf804d8c3d1d896241992426082
last_mapped_at: 2026-10-27
---
# Coding Conventions

**Analysis Date:** 2026-10-27

## Naming Patterns

**Files:**
- Source modules use camelCase `.ts` names grouped by layer: `src/services/nearAiClient.ts`, `src/services/activityStore.ts`, `src/domain/redaction.ts`, `src/agent/worktree.ts`.
- Test files mirror the module they cover with a `.test.ts` suffix in one flat directory: `src/test/nearAiClient.test.ts`, `src/test/worktreeIsolation.test.ts`.
- The end-to-end harness lives in its own folder: `src/test/e2e/run.ts`, `src/test/e2e/suite.ts`.
- Scripts in `scripts/` use kebab-case `.mjs` names: `scripts/verify-release-content.mjs`.

**Functions:**
- camelCase for functions and methods: `createDefaultSettings()`, `normalizePolicyMode()`, `isSecureEndpoint()`, `compareVersions()` (`src/domain/config.ts`, `src/domain/version.ts`).
- Predicates use `is`/`has` prefixes: `isSecureEndpoint`, `isProfileId` (`src/domain/auth.ts`).
- Factories use `create` prefixes: `createDefaultSettings`, `createProjectCredentialScope`.
- Helper functions inside a file are declared with `function` at module scope and kept private (not exported) unless tests need them, e.g. `imageResult` in `src/services/nearAiClient.ts`.

**Variables:**
- camelCase for locals and parameters. Short names are common in small callbacks (`(error) =>`, `(line) =>`).
- Module-level constants that are configuration values use UPPER_SNAKE_CASE: `DEFAULT_BASE_URL`, `DEFAULT_MODEL` (`src/domain/config.ts`), `API_KEY_SECRET`, `REFRESH_TOKEN_SECRET` (`src/services/auth.ts`), `DEFAULT_RULES` (`src/agent/permissions.ts`).
- Private-looking loopback sets and similar lookup tables are `const` `Set`s with UPPER_SNAKE names, e.g. `LOOPBACK_HOSTS` in `src/domain/config.ts`.

**Types:**
- `interface` for object shapes that are extended or implemented: `ChatMessage`, `ToolCall`, `ModelInfo`, `NearAiSettings` (`src/services/nearAiClient.ts`, `src/domain/config.ts`). `SecretStorageLike` is an interface implemented by test doubles (`src/test/auth.test.ts`).
- `type` aliases for unions and derived types: `AgentMessage`, `CompletionEvent`, `AuthMode`, `ActionPolicyMode`.
- Discriminated unions with a literal `type` or `role` field are the standard way to model events and messages (`CompletionEvent` uses `type: 'text' | 'reasoning' | 'done'`).
- Use `import type { ... }` for type-only imports: `src/services/nearAiClient.ts` imports `type ResponseEvidence` inline with value imports, and `src/test/worktreeIsolation.test.ts` uses `import type { AgentMessage, ... }`.
- Classes use PascalCase: `ActivityStore` (`src/services/activityStore.ts`), `NearAiClient`, `AgentConversation`, `RunCheckpoints`, `ShellSession`.
- Error classes extend `Error` and carry status metadata: `NearAiError(status, message, retryable, requestId?)` in `src/services/nearAiClient.ts`.

## Code Style

**Formatting:**
- No Prettier or Biome configuration is present in the repository. Formatting is manual and consistent in practice.
- Indentation is 2 spaces. Lines are long where a single-line helper keeps related logic together (some lines exceed 150 characters); do not reflow existing code just for width.
- Single quotes for strings and imports (`import path from 'node:path';`).
- Semicolons are used at statement ends.
- Trailing commas are not used in multi-line object literals in the main code path; match the surrounding file.
- Short one-line arrow functions and inline object literals are common in tests and helpers: `const json = (value: unknown) => ...`.

**Linting:**
- No ESLint configuration is present. The effective static check is the TypeScript compiler in strict mode.
- `tsconfig.json` sets `"strict": true`, `"target": "ES2022"`, `"module": "commonjs"`, `"rootDir": "src"`, `"outDir": "dist"`, `"skipLibCheck": true`.
- `npm run lint` runs `tsc -p tsconfig.json --noEmit`.
- Type-suppression comments are essentially absent: there is one `@ts-ignore`/`eslint-disable` occurrence in `src/`. Prefer narrowing with type guards over casts.
- `any` is almost never written explicitly. Narrow `unknown` values instead (see `imageResult(value: unknown, ...)` in `src/services/nearAiClient.ts`).

**Type Assertions:**
- Use `as const` for literal tables and union-typed fixtures. About 100 occurrences across `src/`.
- Cast externals with `as` only at boundaries: `(await response.json())` is handled by runtime checks, and `globalThis.fetch = fakeNear(calls) as typeof fetch;` is the pattern used in tests.

## Import Organization

**Order (as observed in the source and tests):**
1. Node built-ins using the `node:` prefix: `import { execFile } from 'node:child_process';`, `import path from 'node:path';`
2. Third-party packages: `import { runTests } from '@vscode/test-electron';`, and `vscode` (available only inside the extension host).
3. Relative project imports, grouped after built-ins: `import { ... } from '../services/agentSession';`

**Path Aliases:**
- None. All project imports are relative (`../domain/config`, `./attestation`). Do not introduce a path alias without updating `tsconfig.json` and the test runner (`node --test dist/test/*.test.js` runs compiled output).

**Barrel Files:**
- Not used. Import from the defining module directly.

**Module system:**
- CommonJS output (`"module": "commonjs"`). Use `import`/`export` syntax in source; `require` appears only in test-time module interception (see TESTING.md).
- `export` named declarations are standard. Default exports appear only for Node built-ins (`import path from 'node:path'`, `import Module from 'node:module'`).

## Error Handling

**Strategy:** Throw typed errors with a user-readable message and retry metadata. Convert low-level failures at the boundary.

**Patterns:**
- Network and API failures become `NearAiError` with HTTP status, a `retryable` flag, and optional `requestId`. Example from `src/services/nearAiClient.ts`:
  ```typescript
  throw new NearAiError(0, `NEAR AI request failed: ${error instanceof Error ? error.message : 'network error'}.`, true);
  ```
- Timeouts and aborts are explicit. Timeouts raise `NearAiError(408, ..., true)`. Aborts rethrow `new DOMException('The operation was aborted.', 'AbortError')`.
- Messages never include secrets. Tests assert this directly (`src/test/nearAiClient.test.ts` checks that errors do not contain `secret` or `Bearer`). Pass error text through `src/domain/redaction.ts` (`redactSecrets`) before surfacing it to the UI or transcripts.
- Best-effort cleanup swallows errors with a `.catch(() => undefined)` on stream readers and similar resources: `await reader.cancel().catch(() => undefined);`.
- Optional catch binding is used when the error value is not needed: `try { chunk = JSON.parse(payload); } catch { throw new NearAiError(...); }`. Roughly 57 `catch {` blocks and 52 `catch (error)` blocks exist in `src/`.
- Validate at the boundary and fall back to safe defaults rather than throwing for user settings: `normalizePolicyMode` returns `'approve-risky'` for unknown values (`src/domain/config.ts`).
- Security-sensitive checks fail closed: `isSecureEndpoint` rejects remote plain HTTP; `NearAiClient` refuses non-HTTPS endpoints before sending any request.

**Async:**
- `async`/`await` throughout. Public service methods are `public async` (about 170 occurrences).
- Cancellation flows through `AbortSignal` parameters, typically the last optional argument: `generateImage(model, prompt, options = {}, signal?)`.

## Logging

**Framework:** None in application code. `console.log` and `console.error` appear only in the test harness and live tests (`src/test/live.test.ts`, `src/test/e2e/run.ts`, `src/test/e2e/suite.ts`).

**Patterns:**
- Do not add `console.*` calls in `src/` runtime code. Surface status through the extension's services (activity and audit stores: `src/services/activityStore.ts`, `src/services/auditStore.ts`) and the chat/status UI.
- Never log API keys, bearer tokens, or account credentials. Redact with `src/domain/redaction.ts`.

## Comments

**When to Comment:**
- Explain why a rule exists, especially security and compatibility rules. Examples: the header comment in `src/test/worktreeIsolation.test.ts` documents how Open-GSD treats the runner as a `harness-worktree` host; the comment above `isSecureEndpoint` explains that plain HTTP is only for local runtimes.
- Test files begin with a short block comment describing the behavior under test and any opt-in environment variables (`src/test/live.test.ts`).
- Avoid comments that restate the code.

**JSDoc/TSDoc:**
- Use `/** ... */` on exported types and constants that carry non-obvious contracts: `/** A tool call as the OpenAI-compatible API returns it; \`arguments\` is a JSON string. */` (`src/services/nearAiClient.ts`), `/** 0 means no limit. */` (`src/domain/config.ts`).
- Single-line `//` comments are used for section notes inside functions.

## Function Design

**Size:** Keep helpers small. Long methods exist in orchestration code (`src/agent/loop.ts`, `src/services/nearAiClient.ts`), so when extending them, prefer extracting a module-level helper rather than adding another branch inline.

**Parameters:**
- Positional parameters for required inputs, followed by an `options` object with defaults: `generateImage(model, prompt, options: ImageGenerationOptions = {}, signal?: AbortSignal)`.
- Optional trailing `signal?: AbortSignal` on any network or long-running method.
- Use an inline object type for small option bags: `trust: { trustedRoot?: string; now?: Date } = {}`.

**Return Values:**
- Return typed results (`ImageGenerationResult`, `VerificationResult`) rather than tuples or ad hoc objects.
- Functions that can legitimately find nothing return `undefined` (for example `imageResult` helpers) instead of `null`. `null` appears only where an external API uses it.

## Module Design

**Exports:**
- Export the types and functions that other layers consume. Keep helpers unexported.
- Service classes expose `public` methods explicitly (`public async generateImage(...)`). Use `private` for internal state and helpers (about 50 `private` members in `src/`).
- Prefer constructor injection of dependencies for testability: `new AuthService(secrets)` takes a `SecretStorageLike`; `AgentConversation` and `AgentRun` take their collaborators.

**Layering:**
- `src/domain/` holds pure types, defaults, and validation with no `vscode` import (`config.ts`, `policy.ts`, `redaction.ts`, `version.ts`). Keep it free of side effects so it can be tested under plain Node.
- `src/services/` holds stateful clients and stores; these may depend on `src/domain/`.
- `src/agent/` holds tool execution, shell, checkpoints, and worktree logic.
- `src/gsd/` holds the Open-GSD runtime integration.
- Modules that need the extension host API import `vscode` directly (about 10 files under `src/`). Tests that need `vscode` intercept module loading (see TESTING.md).

## Where Conventions Are Not Yet Uniform

- Some older modules pass plain objects while newer ones use named interfaces. When editing, follow the local file rather than refactoring.
- Scripts in `scripts/` are `.mjs` ESM while `src/` is CommonJS-compiled TypeScript. Do not mix the two.

---

*Convention analysis: 2026-10-27*

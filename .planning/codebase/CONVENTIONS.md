# Coding Conventions

**Analysis Date:** 2026-10-26

## Naming Patterns

**Files:**
- Source and test files use camelCase `.ts` names, one concept per file: `src/services/approvalService.ts`, `src/services/nearAiClient.ts`, `src/domain/gsdCommands.ts`.
- Test files mirror the module name with a `.test.ts` suffix and live in `src/test/`: `src/test/approvalService.test.ts` tests `src/services/approvalService.ts`.
- Domain type/policy modules are named by concept (`src/domain/approval.ts`, `src/domain/policy.ts`, `src/domain/privacy.ts`); service classes with I/O or state live under `src/services/`.
- The only non-camelCase entry is the top-level `src/extension.ts` (VS Code activation entry point; compiled to `dist/extension.js`).

**Functions:**
- camelCase verbs: `preview`, `decide`, `dispatch`, `recordLifecycle`, `normalizeCost`, `redactSecrets`, `decideAction`.
- Module-private helper functions are declared at the bottom of the file, after the class or main export, and are not exported: see `normalizeCost`, `state`, `safe`, `clone` at the end of `src/services/approvalService.ts`.
- Boolean-returning checks use `is`/`has` prefixes: `isStopped`, `isAbortError`.

**Variables:**
- camelCase; short local names are common for hot helper bodies (`ttl`, `cost`, `preview`, `record`).
- Module-level constants use camelCase `const` sets/maps, not SCREAMING_CASE: `const risky = new Set<ActionCapability>([...])` in `src/services/approvalService.ts`. Exported catalogs use SCREAMING_CASE: `GSD_COMMANDS` in `src/domain/gsdCommands.ts`.
- Private class fields are declared `private readonly` with no underscore prefix: `private readonly pending`, `private readonly limits`. (One `_value` exists in the codebase; do not copy it.)

**Types and interfaces:**
- `PascalCase` for interfaces and type aliases. Interfaces are the dominant form for data shapes (about 234 `export interface` declarations vs. about 101 `export type`).
- Discriminant and status unions are string-literal types, not enums. The codebase has no `enum` declarations. Example: `export type ApprovalDecision = 'approved' | 'denied' | 'expired' | 'stale' | 'pending';` in `src/domain/approval.ts`.
- Versioned payloads carry a literal version field: `version: 1` on `ApprovalPreview`, `AuditEvent`, and attribution snapshots.
- Options bags are named `*Options` and are optional at the call site with defaults applied in the constructor: `ApprovalServiceOptions` in `src/domain/approval.ts`, consumed in `src/services/approvalService.ts`.

## Code Style

**Formatting:**
- No formatter configuration is committed. There is no `.prettierrc`, `.editorconfig`, or `biome.json` in the repo root.
- Observed style, which new code should match: 2-space indentation, single quotes, semicolons on statements, trailing commas are not used consistently.
- Line length is not enforced. Many service files pack several statements on one line separated by `;` (for example `src/services/approvalService.ts`, `src/services/agentOrchestrator.ts`). Domain and test files are usually one statement per line. For new code, prefer one statement per line and keep lines under roughly 120 characters; this matches the style of the more recently written modules (`src/domain/gsdCommands.ts`, `src/services/nearAiClient.ts`).
- Code is written in a dense, one-line-per-method style on constructors and short getters. Do not reformat existing dense blocks as part of unrelated work.

**Linting:**
- No ESLint configuration is present. The effective "lint" gate is the TypeScript compiler in strict mode:
  - `npm run lint` runs `tsc -p tsconfig.json --noEmit` (see `package.json`).
  - `tsconfig.json` sets `"strict": true`, `"target": "ES2022"`, `"module": "commonjs"`, `"rootDir": "src"`.
- Hygiene findings to respect: one `: any` / `as any` in non-test source, no `@ts-ignore` or `eslint-disable` comments, and no `TODO`/`FIXME` markers in `src/`. Keep it that way; prefer typed `unknown` with narrowing over `any`.

**TypeScript patterns:**
- Prefer `import type { ... }` for type-only imports: `src/services/approvalService.ts` imports `ActionCapability`, `ApprovalDecision`, etc., with `import type`. Use inline `type` modifiers when mixing value and type imports: `import { normalizeAttribution, UNKNOWN_ATTRIBUTION, type AttributionSnapshot } from '../domain/activity';`.
- Use `readonly` on fields, parameters and arrays that are not mutated. `readonly` tuples/arrays appear in catalogs: `export const GSD_COMMANDS: readonly GsdCommandDefinition[]`.
- Use `??` for defaults (`options.now ?? Date.now`) and `?.` for optional chaining. Non-null assertions (`!`) are rare (about 4 occurrences in non-test source); avoid adding more.
- Numeric separators are used for readable large literals: `1_700_000_000_000`, `5 * 60_000`.
- Copy-on-return for shared state: `clone()` (JSON round-trip) is applied before returning stored previews and records (`src/services/approvalService.ts`). Follow this for any service that hands out internal objects.

## Import Organization

**Order (observed convention):**
1. Node built-ins using the `node:` prefix, always: `import { randomUUID } from 'node:crypto';`, `import * as path from 'node:path';`, `import { tmpdir } from 'node:os';`, `import * as fs from 'node:fs/promises';`.
2. The `vscode` module, when needed, as `import * as vscode from 'vscode';` (only in runtime modules such as `src/extension.ts`; tests never import it directly).
3. Relative imports, domain before services, with type-only imports interleaved by the module they came from. There is no enforced grouping or blank-line separation.

**Path Aliases:**
- None. `tsconfig.json` has no `paths` or `baseUrl`. Always use relative imports (`../domain/policy`, `./privacyPreflight`).

**Layering:**
- `src/domain/*` holds pure types, policies, and deterministic helpers (no `vscode` import, no I/O). `src/services/*` holds stateful classes and I/O. Keep this split: domain modules are imported by services and tests and should not import services. One exception exists: `src/domain/auth.ts` has a type-only import of `NearAiClient` from `src/services/nearAiClient.ts`. Use `import type` for any such dependency and do not add more.

## Error Handling

**Patterns:**
- Programmer and precondition errors throw plain `Error` with a short, sentence-style message ending in a period: `throw new Error('Unknown approval preview.');`, `throw new Error('Agent concurrency limit reached.');` (see `src/services/approvalService.ts`, `src/services/agentOrchestrator.ts`). There are no custom error classes.
- Policy and budget denials are NOT thrown. They return a discriminated result: `{ allowed: false, reason, preview }` from `ApprovalService.dispatch` / `denied()`. Use this result-object pattern for expected business denials; reserve `throw` for invalid input or unknown identifiers.
- Abort is cooperative. Streaming code checks `signal?.aborted || isAbortError(error)` before rethrowing (`src/services/nearAiClient.ts`, around lines 184-206). Do not treat aborts as failures.
- Retries are explicit loops with a `maxRetries` bound (`src/services/nearAiClient.ts`, around line 264).
- `catch` blocks are used for resilience (about 82 `catch` sites outside tests). When swallowing an error, return a typed fallback value or emit an audit event; do not leave an empty `catch`.

**Redaction at the boundary:**
- Any string that may reach the UI, an audit log, or a provider payload must pass through `redactSecrets` (`src/domain/redaction.ts`) or the local `safe()` helper in `src/services/approvalService.ts`. Credential-shaped values (`apiKey=`, `token:`, `Bearer ...`) must be replaced with `[REDACTED]`.

## Logging

**Framework:** None in product code. Zero `console.*` calls exist under `src/` outside tests.

**Patterns:**
- Operational history goes to structured audit events, not logs: `AuditStore` (`src/services/auditStore.ts`) and `ApprovalService.emit(...)`. Each event carries `version: 1`, a generated `id`, an ISO `timestamp`, and an `attribution` snapshot (`UNKNOWN_ATTRIBUTION` when absent).
- Activity and analytics use dedicated stores: `src/services/activityStore.ts`, `src/services/analyticsStore.ts`.
- Do not add `console.log` to product code; surface user-facing status through the VS Code APIs or the webview panel (`src/services/panelView.ts`).

## Comments

**When to Comment:**
- Comments are sparse and explain intent or a platform constraint, not the mechanics. Example from `src/extension.ts`: the comment explains why the panel view provider is the supported surface in VS Code forks.
- Document security or privacy invariants inline where they are enforced (for example that emergency stop still allows terminal bookkeeping in `ApprovalService.emergencyStop`).

**JSDoc/TSDoc:**
- Not used. No `@param` / `@returns` blocks exist. Document contracts with the TypeScript type itself (named options interfaces, literal unions).

## Function Design

**Size:** Functions are short where they are methods of a class with one responsibility. Some methods are very long single lines (e.g. `ApprovalService.preview` in `src/services/approvalService.ts`); when adding logic, extract a named private helper rather than extending the line further.

**Parameters:**
- Prefer a single request object for functions with more than three inputs: `ApprovalService.preview(request: ApprovalRequest)`, `ApprovalService.recordLifecycle(previewId, type, values)`.
- Dependencies are injected through constructors with optional overrides, not module singletons: `new ApprovalService(policy, { now, audit, requestLimitUsd, ... })`. Time is always injected as `now: () => number` so tests can control it.
- `Pick<...>` / `Omit<...>` on interfaces to narrow inputs: `Pick<AuditEvent, 'outcome' | 'reason' | ...>`.

**Return Values:**
- Services return cloned plain objects (`clone(preview)`), never live references to internal maps.
- Async service methods return `Promise<...>`; synchronous lookups return `T | undefined` (`getDecision`).
- Use `undefined` for "not found"; throw only when the caller cannot continue.

## Module Design

**Exports:**
- Named exports only. `export default` is not used. One primary class or function per module, plus its supporting `export interface` / `export type` declarations in the same file or in the matching `src/domain/*.ts` module.
- Helpers used only inside a module are not exported.

**Barrel Files:**
- None. There is no `index.ts` re-export layer; import directly from the module file.

**Domain/service split:**
- Put new data shapes in `src/domain/<concept>.ts` and the class that operates on them in `src/services/<concept>Service.ts` or `src/services/<concept>.ts`. Example pair: `src/domain/approval.ts` (types) and `src/services/approvalService.ts` (behavior).
- New VS Code commands are registered in `src/extension.ts` inside the `context.subscriptions.push(...)` block; keep that pattern.

---

*Convention analysis: 2026-10-26*

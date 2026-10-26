# Testing Patterns

**Analysis Date:** 2026-10-26

## Test Framework

**Runner:**
- Node.js built-in test runner (`node:test`). No Jest, Vitest, or Mocha dependency.
- Config: none. The runner is driven entirely by the `test` script in `package.json`.
- Node version is not pinned by a `.nvmrc`; `@types/node` is `^22.10.0`.

**Assertion Library:**
- `node:assert/strict`, imported as `import assert from 'node:assert/strict';`. Use `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.match`, `assert.doesNotMatch`.

**Run Commands:**
```bash
npm test                  # Compile (tsc -p tsconfig.json) then run: node --test dist/test/*.test.js
npm run lint              # tsc -p tsconfig.json --noEmit (the only static check; no ESLint)
npm run check             # lint + test (the full local gate)
npm run compile           # Build only, emits dist/ (tests run from compiled output)
npm run watch             # tsc --watch for iterative development
npm run verify:release    # package + scripts/verify-release-content.mjs (release content gate)
```

**Important:** Tests execute from `dist/test/*.js`, not from `src/`. Always run `npm test` (which compiles first) rather than invoking `node --test` directly, or you will run stale output. 41 test source files live in `src/test/`, containing about 193 `test(...)` cases.

## Test File Organization

**Location:**
- All tests are in one flat directory: `src/test/`. They are not co-located with the modules they test.

**Naming:**
- `<moduleName>.test.ts`, matching the module under test where one exists:
  - `src/test/approvalService.test.ts` -> `src/services/approvalService.ts`
  - `src/test/policy.test.ts` -> `src/domain/policy.ts`
  - `src/test/gsdCommands.test.ts` -> `src/domain/gsdCommands.ts`
- Behavior-named suites for cross-cutting flows: `chatBridge.test.ts`, `teamInvocation.test.ts`, `resumableExecution.test.ts`, `multimodalOrchestration.test.ts`, `walletAuthorization.test.ts`.

**Structure:**
```text
src/test/
  <module>.test.ts          # one file per module or cross-cutting behavior
dist/test/                  # compiled output; executed by `npm test`
```

## Test Structure

**Suite Organization:**
There is no `describe`/`it` wrapper. Each case is a top-level `test(name, fn)` call with a long behavior-descriptive name. Names state the outcome in plain English:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideAction, defaultActionPolicy } from '../domain/policy';

test('default policy requires approval for risky actions', () => {
  const policy = defaultActionPolicy();
  assert.equal(decideAction(policy, 'shell'), 'approval-required');
});
```

- Import the default export: `import test from 'node:test';`. Some files use the named form `import { test } from 'node:test';` (5 files). Prefer the default form for new files.
- Do not introduce `describe`/`it` nesting; keep one `test` per behavior.

**Patterns:**
- **Factory helpers for request fixtures** at the top of the file, returning a spread-overridable object:
  ```typescript
  const request = (overrides: Partial<Parameters<ApprovalService['preview']>[0]> = {}) => ({
    requestId: 'req-1', sessionId: 'session-1', projectId: 'project-1',
    capability: 'shell' as const, /* ... */ ...overrides
  });
  const service = (audit?: AuditStore, now = () => 1_700_000_000_000) =>
    new ApprovalService(new PolicyGate(defaultActionPolicy(), new PrivacyPreflight()), { audit, now, /* ... */ });
  ```
  Taken from `src/test/approvalService.test.ts`. Build fixtures this way; do not share mutable fixtures between tests.
- **Arrange / act / assert in one block**, usually compact. Several assertions per test are normal.
- **Deterministic time**: inject `now` (`() => 1_700_000_000_000`) or a mutable `let time` that the test advances (`time += 6 * 60_000`). Never rely on wall-clock time in assertions.
- **Async tests** are `async` functions with `await` on service calls; no `done` callbacks and no timers.

**Setup and teardown:**
- Filesystem fixtures are created per test with `mkdtemp` under `os.tmpdir()`, then removed in a `finally` block:
  ```typescript
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-'));
  try {
    /* ... */
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  ```
  Prefix temp directories with `near-ai-<area>-` (for example `near-ai-team-binding-`, `near-ai-gsd-state-`). Source: `src/test/profileStore.test.ts`, `src/test/chat.test.ts`.
- Global mutable state is restored in `finally` blocks (see the `Module._load` patching below). Always restore what you patched.
- No `before`/`after` hooks are used. Keep each test self-contained.

## Mocking

**Framework:** None library-provided. Mocks are hand-written.

**Strategy 1: Dependency injection (preferred).**
Services accept their collaborators and options through constructors, so tests pass in real-but-in-memory instances:
```typescript
const audit = new AuditStore();                      // real in-memory store
const approvals = service(audit);                    // real PolicyGate + PrivacyPreflight
const events = await audit.list({ type: 'dispatch' });  // assert on the real store
```
Prefer real domain/service objects over mocks. `AuditStore` (`src/services/auditStore.ts`) is used as a real collaborator, not stubbed.

**Strategy 2: Module loader patching for `vscode`.**
The `vscode` module is not available under `node --test`. Tests that exercise code importing `vscode` replace it through `Module._load`:
```typescript
const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = nodeModule._load;
nodeModule._load = (request, parent, isMain) =>
  request === 'vscode'
    ? { workspace: { workspaceFolders: undefined } }
    : originalLoad(request, parent, isMain);
try {
  /* exercise code under test */
} finally {
  nodeModule._load = originalLoad;
}
```
Sources: `src/test/chat.test.ts` (lines around 55-93), `src/test/contextGraphUi.test.ts` (around line 112), `src/test/privacyPreflight.test.ts` (around line 66). Always restore `_load` in `finally`. Keep the stub minimal: only the members the test touches.

**Strategy 3: Hand-rolled DOM/webview harness.**
UI-facing code is tested against a small fake element tree class in the test file (see `src/test/contextGraphUi.test.ts`, which defines a `HarnessElement` with an `after(node)` method). Do not add a DOM library for this.

**Strategy 4: Stub fetch/network with injected functions.**
`src/test/nearAiClient.test.ts` and `src/test/providerFactory.test.ts` inject a `fetchFn` option (for example `new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async () => new Response('', { status: 429 }) })`) rather than making a real network call. Use `https://example.test` for base URLs in tests. Do not let a test hit `cloud-api.near.ai`.

**What to Mock:**
- The `vscode` module (via `Module._load`, see above).
- External network/provider transport (inject a fake fetch or client).
- Time (`now` injection).
- Storage locations (point stores at `mkdtemp` directories).

**What NOT to Mock:**
- Domain logic (`src/domain/*`): test it directly with real inputs, as `src/test/policy.test.ts` does.
- Policy and privacy gates: `approvalService.test.ts` runs the real `PolicyGate` and `PrivacyPreflight`. Keep it that way; the security behavior is the thing under test.
- The audit store: use `AuditStore` directly and assert on emitted events.

## Fixtures and Factories

**Test Data:**
- Inline object literals, built by per-test factory functions (see Patterns above). Shared data for a file lives at module scope as `const`:
  ```typescript
  const answers = { goal: 'Ship a bounded team feature', riskLevel: 'high' as const, preferredProvider: 'near-ai', locality: 'local' as const, workShape: 'feature' as const };
  ```
- Use `as const` on literal union members so they type-check against domain unions.
- Identifiers in tests use stable, readable placeholders: `'project-1'`, `'session-1'`, `'req-1'`, `'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`, `'profile-company-a'`.

**Location:**
- No separate fixtures directory. Fixtures are inlined in each test file or built in its helper functions.
- `hostAttribution(...)` from `src/domain/activity.ts` is the shared helper for building attribution snapshots in tests.

## Coverage

**Requirements:** None enforced. No coverage tool (c8, nyc, or `--experimental-test-coverage`) is configured in `package.json`.

**View Coverage:**
```bash
node --test --experimental-test-coverage dist/test/*.test.js   # ad hoc, after npm run compile
```
Not part of the default workflow. Use it only when asked to measure coverage.

## Test Types

**Unit Tests:**
- The majority of the suite. Domain functions (`policy`, `redaction`, `gsdCommands`, `gsdStatus`, `activity`) and single services (`approvalService`, `auditStore`, `profileStore`, `reputation`) are tested in isolation with in-memory or temp-directory collaborators.

**Integration Tests:**
- Cross-service flows inside one test, using real objects: `teamInvocation.test.ts`, `agentTeams.test.ts`, `multimodalOrchestration.test.ts`, `contextGraph.test.ts`, `resumableExecution.test.ts`. These compose several services and assert on the persisted output (often by reading a file back from a temp directory with `readFile`).
- Persistence round-trips use real files in `mkdtemp` directories, not mocks.

**E2E Tests:**
- Not used. No VS Code extension host test runner (`@vscode/test-electron`) is configured; there is no `.vscode-test` setup in the repo. Manual verification uses the packaged `.vsix` (see `scripts/install-global-extension.mjs`).

**Release-content verification:**
- `scripts/verify-release-content.mjs` runs after `npm run package` (`verify:release`). It checks the packaged output, not runtime behavior. `.vscodeignore` excludes `src/**` and `dist/test/**` from the `.vsix`; keep test code out of the package.

## Common Patterns

**Async Testing:**
```typescript
test('approval preview ...', async () => {
  const audit = new AuditStore();
  const preview = await service(audit).preview(request());
  assert.deepEqual((await audit.list()).map((event) => event.type), ['preflight', 'preview']);
});
```
Await every service call. Read results back from the same store instance you wrote to.

**Error and Denial Testing:**
Business denials are results, not exceptions, so assert on the returned object:
```typescript
assert.equal((await approvals.dispatch(preview.previewId)).allowed, false);
```
For invalid input or unknown identifiers that throw, assert with `assert.rejects` (async) or `assert.throws` (sync). The codebase uses a validator function to check the error class and code, not just a message regex (73 `assert.rejects`/`assert.throws` call sites):
```typescript
await assert.rejects(async () => registry.consume('a'.repeat(64)), (error: unknown) => error instanceof MemoryApprovalError && error.code === 'invalid');
```
Source: `src/test/memoryApproval.test.ts`. Note that `ApprovalService.decide` throws a plain `Error`, so a message match is acceptable there.

**Security and redaction assertions:**
Security-sensitive tests check that secrets do not appear in serialized output. Use `JSON.stringify` and a negative regex:
```typescript
const serialized = JSON.stringify(preview);
assert.equal(serialized.includes('secret-token'), false);
assert.doesNotMatch(serialized, /api[_ -]?key|refresh[-_ ]?token|private prompt/i);
```
Any change touching redaction, privacy preflight, approval, wallet authorization, or audit must keep or extend tests of this shape. Never weaken or delete such assertions to make a change pass.

**Snapshot-like comparisons:**
- No snapshot files. Use `assert.deepEqual` against explicit expected objects.

## Adding a New Test

1. Create `src/test/<module>.test.ts`, importing `assert` and `test` from `node:*`.
2. Import the module from its relative `../domain/...` or `../services/...` path.
3. Define a factory helper for the input; override fields via spread.
4. Inject `now`, storage roots (`mkdtemp`), and transports rather than relying on defaults.
5. Restore any patched global (`Module._load`) in `finally`; remove temp directories in `finally`.
6. Run `npm test` (compiles, then runs all of `dist/test/*.test.js`). Run `npm run lint` before committing.

Do not add a test runner, mocking library, or coverage tool without an explicit decision; the project currently runs on built-ins only.

---

*Testing analysis: 2026-10-26*

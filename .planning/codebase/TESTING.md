---
last_mapped_commit: 0dd12e6e15b0daf804d8c3d1d896241992426082
last_mapped_at: 2026-10-27
---
# Testing Patterns

**Analysis Date:** 2026-10-27

## Test Framework

**Runner:**
- Node.js built-in test runner (`node:test`), no Jest or Vitest.
- Config: none. The runner is invoked from `package.json` scripts.
- The compile step produces `dist/test/*.test.js`, which the runner executes.

**Assertion Library:**
- `node:assert/strict`, imported as `import assert from 'node:assert/strict';`.

**End-to-end:**
- `@vscode/test-electron` 2.5.2 launches a real VS Code with the extension (`src/test/e2e/run.ts`, `src/test/e2e/suite.ts`).

**Run Commands:**

```bash
npm test                 # Compile (tsc) then run node --test dist/test/*.test.js
npm run lint             # tsc -p tsconfig.json --noEmit (type check only)
npm run check            # lint + test
npm run test:e2e         # Compile, then launch VS Code under xvfb-run (Linux)
npx tsc -p tsconfig.json # Compile only
node --test dist/test/nearAiClient.test.js   # Run a single compiled test file
```

**Live tests (opt-in, spend real money):**

```bash
NEAR_AI_API_KEY=... npm test                      # Live tool round trip, signature verification, billing
NEAR_AI_API_KEY=... NEAR_LIVE_EVAL=1 npm test     # Also compare default-model candidates
NEAR_LIVE_GSD=1 NEAR_GSD_HOME=<runtime> npm test  # Also run a full GSD cycle
```

Without `NEAR_AI_API_KEY`, the live suite is skipped with the message `set NEAR_AI_API_KEY to run live NEAR AI tests`.

**Coverage:**
- No coverage tool is configured. No coverage threshold is enforced.

## Test File Organization

**Location:**
- All unit and integration tests live in one flat directory, `src/test/`, separate from the implementation under `src/domain`, `src/services`, `src/agent`, and `src/gsd`.
- End-to-end tests live in `src/test/e2e/`.
- Fixtures live in `test/fixtures/` at the repository root (`test/fixtures/media`, `test/fixtures/tdx`). Those paths are excluded from the extension package by `.vscodeignore`.

**Naming:**
- `<module-or-feature>.test.ts`, camelCase to match the source module where one exists: `auth.test.ts` for `src/services/auth.ts`, `chatSendPath.test.ts` for the chat send flow, `worktreeIsolation.test.ts` for worktree behavior.
- Behavior-named features use a descriptive noun: `streamRecovery.test.ts`, `securityReview.test.ts`, `policyGate.test.ts`.
- `phase11.test.ts` is a historical exception; prefer feature names for new files.

**Structure:**

```
src/test/
├── <feature>.test.ts         # Unit and integration tests, one or more per feature
├── live.test.ts              # Opt-in live API tests (skipped without NEAR_AI_API_KEY)
└── e2e/
    ├── run.ts                # Launches VS Code twice (project and plain workspace)
    └── suite.ts              # Runs inside the extension host
test/fixtures/                # Static fixtures (media, tdx)
```

## Test Structure

**Suite Organization:**
There is no `describe` nesting in the main suites. Each test is a top-level `test(...)` call with a sentence-style name. About 286 top-level `test(` calls exist across `src/test/`.

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSettings, isSecureEndpoint, normalizePolicyMode } from '../domain/config';

test('secure endpoint check rejects remote plain HTTP', () => {
  assert.equal(isSecureEndpoint('https://cloud-api.near.ai/v1'), true);
  assert.equal(isSecureEndpoint('http://cloud-api.near.ai/v1'), false);
  assert.equal(isSecureEndpoint('not a url'), false);
});
```

`describe`/`it` nesting is used in only a small number of files (`src/test/nearAiClient.test.ts`, `src/test/chatBridge.test.ts`, `src/test/sidebarChat.test.ts` contain the most `test` blocks). Prefer flat `test()` calls with full-sentence names.

**Patterns:**
- Setup: construct fixtures inline at the start of each test. Shared helpers are small module-level functions such as `repository()` and `call(...)` in `src/test/worktreeIsolation.test.ts`.
- Teardown: create temp resources under `os.tmpdir()` and restore global state in `finally` blocks. About 33 `finally` blocks exist in the suite.
- Assertion: `assert.equal`, `assert.deepEqual`, `assert.ok`, and `assert.rejects` from `node:assert/strict`.
- Error assertions use a predicate on the thrown object:
  ```typescript
  await assert.rejects(() => client.listModels(), (error: NearAiError) => error.retryable && error.status === 429);
  ```
- Header comment: each non-trivial test file starts with a `//` block describing what is being verified and why. Keep that habit for new files.

## Mocking

**Framework:** None. Mocks are hand-written test doubles and monkey-patched globals.

**Patterns:**

Hand-written in-memory class implementing an interface:

```typescript
class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}
```

(`src/test/auth.test.ts`)

Fake model client as an async generator, used by the agent loop tests (`src/test/worktreeIsolation.test.ts`):

```typescript
const near = {
  async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
    yield done({ role: 'assistant', content: 'nothing to do' });
  }
};
```

Global `fetch` replacement, always restored:

```typescript
const originalFetch = globalThis.fetch;
globalThis.fetch = fakeNear(calls) as typeof fetch;
try {
  // exercise code under test
} finally {
  globalThis.fetch = originalFetch;
}
```

(`src/test/chatSendPath.test.ts`)

Intercepting `require('vscode')` for code that imports the extension host API, restored in `finally`:

```typescript
const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = nodeModule._load;
nodeModule._load = (request, parent, isMain) => request === 'vscode' ? { /* stub API */ } : originalLoad(request, parent, isMain);
// ... finally { nodeModule._load = originalLoad; }
```

(`src/test/chat.test.ts`, `src/test/contextGraphUi.test.ts`). Ten files under `src/` import `'vscode'` directly; the domain layer avoids it by keeping logic in `src/domain/` and `src/services/` with no `vscode` dependency.

**Caching caveat:** `src/test/chatSendPath.test.ts` notes that `chat.ts` is cached after the first `require`. Create one stub object per file and mutate its state per test instead of creating new stubs.

**What to Mock:**
- Network calls to NEAR AI (replace `globalThis.fetch` or pass a fake client with `streamCompletion`).
- The `vscode` module and `SecretStorage`.
- Model responses for agent-loop tests (scripted `CompletionEvent` sequences).
- Time-sensitive behavior: pass `now?: Date` through options (see `verifyResponse(..., trust: { trustedRoot?, now? })`).

**What NOT to Mock:**
- Git. Tests create real repositories in temp directories with `git init` and run real worktree commands (`src/test/worktreeIsolation.test.ts`, `src/test/workspaceIsolation.test.ts`).
- The filesystem. Use `mkdtemp(path.join(tmpdir(), 'near-ai-<name>-'))`.
- Pure domain logic (`src/domain/*`). Test it directly.
- Permission rules. Import `DEFAULT_RULES` from `src/agent/permissions.ts` rather than redefining them.

## Fixtures and Factories

**Test Data:**
Small inline factories build typed values:

```typescript
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const done = (message: Extract<AgentMessage, { role: 'assistant' }>): CompletionEvent => ({ type: 'done', message, finishReason: message.tool_calls ? 'tool_calls' : 'stop', usage });
```

Temporary directories and git repositories are created per test:

```typescript
const root = await mkdtemp(path.join(tmpdir(), 'near-ai-wt-'));
await git(root, 'init', '-q');
await git(root, 'config', 'user.email', 'test@example.invalid');
```

Use `.invalid` domains for test emails.

**Location:**
- Inline in the test file. Shared static files live under `test/fixtures/` (`test/fixtures/media`, `test/fixtures/tdx`).
- Use `.invalid` or `.test` domains and `example` or `sample` names for all test data. Never use real API keys; live tests read `NEAR_AI_API_KEY` from the environment only.

## Coverage

**Requirements:** None enforced.

**View Coverage:**
Coverage is not instrumented. To collect it ad hoc, run Node's built-in coverage on the compiled tests:

```bash
NODE_V8_COVERAGE=./coverage npm test
```

## Test Types

**Unit Tests:**
- Pure functions in `src/domain/` and parsers in `src/services/` (for example `src/test/config.test.ts`, which covers settings defaults, policy modes, endpoint security, and version comparison).
- Stores and state machines with injected dependencies (`src/test/activityStore.test.ts`, `src/test/profileStore.test.ts`).

**Integration Tests:**
- Agent loop, tool execution, and worktree behavior using real git and temp directories (`src/test/agentLoop.test.ts`, `src/test/agentTools.test.ts`, `src/test/worktreeIsolation.test.ts`).
- Chat send path with the code host and network stubbed (`src/test/chatSendPath.test.ts`).
- Stream recovery against scripted responses (`src/test/streamRecovery.test.ts`).

**Live Tests:**
- `src/test/live.test.ts` calls the real NEAR AI Cloud and is skipped unless `NEAR_AI_API_KEY` is set. It uses `describe`-style `skip` options: `const skip = key ? false : 'set NEAR_AI_API_KEY to run live NEAR AI tests';`. Tests spend cents per run; keep them minimal.

**E2E Tests:**
- `src/test/e2e/run.ts` launches VS Code with the extension twice, once in a project with `.planning/.near-ai` (scenario `project`) and once in a plain folder (scenario `plain`). It uses `@vscode/test-electron` and `--disable-extensions`.
- Run with `npm run test:e2e` under `xvfb-run` on Linux. The e2e run is not part of `npm test`.
- Environment for the extension host: `NEAR_AI_E2E=1`, `NEAR_AI_E2E_SCENARIO`, `NEAR_AI_E2E_WORKSPACE`.

## Common Patterns

**Async Testing:**

```typescript
test('isolation="worktree" runs each agent on its own branch', async () => {
  const { root, storage, gsd } = await repository();
  // await real async work, then assert
  // assert on the resulting git state (illustrative)
});
```

Always `await` promises passed to `assert.rejects`. Use `signal`/`AbortController` for cancellation tests.

**Error Testing:**

```typescript
await assert.rejects(() => failing.listModels(), (error: NearAiError) => !error.message.includes('secret') && !error.message.includes('Bearer'));
```

Assert both the error category (`status`, `retryable`) and that secrets are absent from the message.

**Security Assertions:**
- Check that secrets do not appear in stored keys or messages: `assert.equal([...secrets.values.keys()].some((key) => key.includes('/workspace/project-a')), false);` (`src/test/auth.test.ts`).
- Check that privileged paths stay isolated: the main checkout is untouched after a worktree run (`src/test/worktreeIsolation.test.ts`).

**Adding a New Test:**
1. Create `src/test/<feature>.test.ts` next to related tests.
2. Import `node:assert/strict` and `node:test`, then the module under test with a relative path.
3. Write top-level `test('<sentence describing behavior>', ...)` blocks.
4. Use `mkdtemp` for any filesystem state and restore globals in `finally`.
5. Run `npm test`. Run `npm run lint` before committing.

---

*Testing analysis: 2026-10-27*

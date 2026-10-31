# Phase 60: Team core - Pattern Map

**Mapped:** 2026-10-31
**Files analyzed:** 19 new, 5 modified
**Analogs found:** 16 / 24 (the crypto, canonical JSON, git-transport and event-log files are greenfield; use RESEARCH.md recipes)

All analog paths below were checked as git-tracked source.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/domain/team/types.ts` | model | transform | `src/domain/approval.ts` (type unions + interfaces) | role-match |
| `src/domain/team/canonical.ts` | utility | transform | none | no analog |
| `src/domain/team/secrets.ts` | utility | transform | `src/domain/redaction.ts` (reuse by difference, do not edit) | partial |
| `src/domain/team/permissions.ts` | service (pure) | request-response | `src/domain/policy.ts` (decision functions) | role-match |
| `src/domain/team/policy.ts` | config | transform | `src/domain/config.ts` | role-match |
| `src/domain/team/validate.ts` | utility | transform | `src/services/auditStore.ts` `normalizeEvent`/`safeText` | partial |
| `src/domain/team/materialize.ts` | service (pure reducer) | transform | none (`src/domain/auth.ts` for the `node:crypto` import precedent) | no analog |
| `src/team/identity.ts` | service | request-response | `src/services/auth.ts` (`SecretStorageLike`) | role-match |
| `src/team/ids.ts` | utility | transform | `src/services/auditStore.ts` id generation (`randomUUID`) | partial |
| `src/team/runGit.ts` | utility | request-response | `src/agent/worktree.ts` `git()` (style only) | partial |
| `src/team/transport.ts` | interface | event-driven | none | no analog |
| `src/team/gitTransport.ts` | service | file-I/O, request-response | `src/agent/worktree.ts` | partial |
| `src/team/eventLog.ts` | service | CRUD | none | no analog |
| `src/services/team/teamSession.ts` | service (vscode adapter) | event-driven | `src/services/spendTracking.ts` | role-match |
| `src/services/team/teamCommands.ts` | controller | request-response | `src/services/spendTracking.ts` `registerSpendTracking` | role-match |
| `src/services/team/teamStatusBar.ts` | component | event-driven | `src/services/spendTracking.ts` (subscriptions) | partial |
| `src/test/team*.test.ts` | test | - | `src/test/auditStore.test.ts` | exact style |
| `src/test/helpers/teamHarness.ts`, `teamAppendChild.ts` | test helper | - | none (no helper dir convention checked; no `.test` suffix so the glob skips them) | no analog |
| `.planning/.near-ai/team.json` writer | utility | file-I/O | `src/services/auditStore.ts` `persist` | exact |
| MOD `src/extension.ts` | config | - | line 56 `registerSpendTracking(context, auth);` | exact |
| MOD `src/domain/approval.ts` | model | - | `AuditEventType` union lines 9-12 | exact |
| MOD `src/services/auditStore.ts` | service | - | `isAuditEventType` array (line ~88) | exact |
| MOD `package.json` | config | - | `contributes.commands` entry `nearAi.setup` (~line 81) | exact |

## Pattern Assignments

### `src/team/runGit.ts` (utility, request-response)
**Analog:** `src/agent/worktree.ts` lines 14-20. Reuse the style only: timeout, `maxBuffer`, `GIT_TERMINAL_PROMPT: '0'`. Do NOT reuse: it trims stdout, has no stdin, and discards the exit code.
```typescript
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
      else resolve(String(stdout).trim());
    });
  });
}
```
New: `spawn`, resolve `{ code, stdout: Buffer, stderr: string }`, `windowsHide: true`, injectable `GitRunner` type for fault injection (RESEARCH Pitfall 14, line 273).

### `src/team/identity.ts` (service)
**Analog:** `src/services/auth.ts` lines 8-12 and 22. Import as type only so the module stays `vscode`-free.
```typescript
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}
public constructor(private readonly secrets: SecretStorageLike) {}
```
```typescript
import type { SecretStorageLike } from '../services/auth';
```
Key name: `nearAi.team.deviceKey.<teamId>` (D-14). Constants naming precedent: `REPORTING_TOKEN_KEY = 'nearAi.usageReportingToken'` in `src/services/spendTracking.ts` line ~14.

### `src/domain/team/*` (pure domain)
Precedent: `src/domain/auth.ts` imports `createHash` from `node:crypto`, so hash/verify in the domain layer is allowed. Type files use `export type X = | 'a' | 'b'` unions plus interfaces (see `src/domain/approval.ts` lines 1-12). No `vscode` imports in `src/domain`.

### `src/domain/team/secrets.ts`
**Analog:** `src/domain/redaction.ts` lines 1-4. It detects only `bearer`, `rpt-` (8+) and key/value forms, so it misses `sk-`, `rt_`, `adm_`, `oc_`, JWT, PEM and PKCS#8. Do not edit it (solo parity; it has 8 callers). Add the new patterns in `secrets.ts` (RESEARCH line ~511) and walk keys and values. Throw instead of redacting (write side only).

### `team.json` atomic write
**Analog:** `src/services/auditStore.ts` lines 55-59 (same temp-then-rename; same directory `.planning/.near-ai/`).
```typescript
const file = this.filePath; const temporary = `${file}.${process.pid}.tmp`;
try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(temporary, `${JSON.stringify({ ... })}\n`, 'utf8'); await fs.rename(temporary, file); } catch { try { await fs.rm(temporary, { force: true }); } catch { /* best effort */ } }
```
Differences for team.json: do not swallow errors (the enable flow must report failure); run `assertNoSecrets` first; validate on read as untrusted input.

### Audit mirroring (`teamSession.ts` -> `AuditStore`)
**Analog:** `src/services/auditStore.ts` `append`/`appendType`/`list` (lines 14-30). Constraints:
- `AuditStore` is not constructed in production code yet; `new AuditStore(workspaceRoot)`.
- `append` does not dedupe: use id `audit-team-<sha256(eventId).slice(0,16)>`, skip ids already in `list({ type: 'team-roster' })`.
- `redactEvent` drops metadata keys matching `/(secret|token|key|password|prompt|command|context|output|path)/i`; use `memberId`, `role`, `eventType`, `eventId`, `lamport`.
- Add the `'team-roster'` literal in BOTH `src/domain/approval.ts` lines 9-12 (union) and the array in `isAuditEventType` (`src/services/auditStore.ts` ~line 88):
```typescript
function isAuditEventType(value: unknown): value is AuditEvent['type'] { return typeof value === 'string' && ['preflight', 'route', ..., 'setup-blocked', 'near-wallet'].includes(value); }
```

### `src/services/team/teamCommands.ts` and `registerTeamMode` (adapter)
**Analog:** `src/services/spendTracking.ts` lines 180-190.
```typescript
export function registerSpendTracking(context: vscode.ExtensionContext, auth?: AuthService): void {
  ...
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(...),
    vscode.commands.registerCommand(SET_REPORTING_TOKEN_COMMAND, async () => { ... }),
```
Wire in `src/extension.ts` next to line 56 `registerSpendTracking(context, auth);`: add `registerTeamMode(context);`. Register `nearAi.team.enable` and `nearAi.team.verifyLog` synchronously (e2e `src/test/e2e/suite.ts:53-55` asserts every contributed command has a handler), lazy-load via `await import('./team/teamSession')`, one `fs.stat` for team.json, no timers when absent (D-24). Existing solo-ish pattern: `if (projectRoot) void closeInterruptedRuns(projectRoot);` (extension.ts ~line 48) shows fire-and-forget async startup.

### `package.json`
Add two `contributes.commands` entries modelled on (~line 81):
```json
{ "command": "nearAi.setup", "title": "Set Up", "category": "NEAR AI", "icon": "$(gear)" }
```
Activation already covers `.planning/.near-ai/**` (line 56-58); no new activationEvent. Check whether a `menus.commandPalette` list (~line 595) needs entries.

### Tests (`src/test/team*.test.ts`)
**Analog:** `src/test/auditStore.test.ts`. Flat file, `node:test` + `node:assert/strict`, `mkdtemp(path.join(tmpdir(), 'near-ai-...-'))`, imports from `../services/...`/`../domain/...`.
```typescript
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
```
`npm test` = `npm run compile && node --test dist/test/*.test.js` (package.json line 653). Helpers under `src/test/helpers/` must not end in `.test.ts`; the fork child must be compiled JS in `dist/test/helpers/` and run with empty `execArgv`. Table-driven (role x action) permission test; seeded PRNG written in-test.

## Shared Patterns
- **Secrets never persisted:** `assertNoSecrets()` before every event, team.json and team audit write; private key only in SecretStorage.
- **Atomic file writes:** temp + rename (`auditStore.ts` persist, `contextGraphStore.ts` lines ~148-149 via injectable fs interface lines 9-18: reuse the injectable `fileSystem` idea for fault tests).
- **vscode isolation:** only `src/services/team/*` and `src/extension.ts` import `vscode`; core takes `SecretStorageLike`, a `GitRunner`, and an injectable scheduler.
- **Fixed rejection reason strings** (tests assert them); no em-dashes in user-facing text.
- **No empty catch** in new code (the audit store's best-effort catch is not to be copied for team.json).

## No Analog Found
Use RESEARCH.md recipes: `canonical.ts` (canonical JSON, RESEARCH ~lines 193-260), `materialize.ts` (positional reducer), `transport.ts` and `gitTransport.ts` (mirror, `refs/team/coordination`, retry with rebuild and re-sign, three CAS rejection wordings, per-mirror mutex, local `core.hooksPath`; RESEARCH ~lines 272-330, 397-413), `eventLog.ts`, and the test harness helpers.

## Metadata
**Analog search scope:** `src/domain`, `src/services`, `src/agent`, `src/test`, `src/extension.ts`, `package.json`
**Pattern extraction date:** 2026-10-31

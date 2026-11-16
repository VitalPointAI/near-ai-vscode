# Phase 70: Capability vocabulary, manifests and one gate with a floor - Pattern Map

**Mapped:** 2026-11-16
**Files analyzed:** 27 (new or modified, from RESEARCH "Recommended project structure" and Section 11)
**Analogs found:** 27 / 27 (all analogs are git-tracked source under `src/`)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/domain/gate/vocabulary.ts`, `shape.ts`, `manifest.ts`, `words.ts` | utility (pure schema/constants) | transform | `src/domain/team/validate.ts`, `types.ts` | exact |
| `src/domain/gate/labels.ts`, `dominance.ts`, `routing.ts` | utility (pure) | transform | `src/domain/team/policy.ts`, `recentMap.ts` | role-match |
| `src/domain/gate/bundle.ts` | model (signed payload) | transform | `src/domain/team/signedPayload.ts` (`policy-bundle` purpose) | exact |
| `src/domain/gate/floor.ts`, `decide.ts`, `record.ts` | service (pure decision) | request-response | `src/agent/permissions.ts` (`decidePermissionAsync`, layered) | role-match |
| `src/gate/bundleStore.ts`, `labelMapStore.ts`, `clockMarker.ts` | store (signed local file, lock) | file-I/O | `src/team/keyHistory.ts` | exact |
| `src/gate/decisionLog.ts` | store (append log) | file-I/O | `src/team/eventLog.ts`, `auditMirror.ts` | role-match |
| `src/gate/sessionMark.ts` | provider (ambient context) | request-response | `src/services/spendLedger.ts:27-33` (`withSpendTag`) | exact |
| `src/gate/host.ts` | provider (wiring, SecretStorageLike) | request-response | `src/team/identity.ts` | role-match |
| `src/agent/toolCatalog.ts` | config (40 manifests) | transform | tool definitions consumed by `toolsDirectory` | role-match |
| `src/agent/loop.ts` (modified, `executeCall` ~614-692) | controller | request-response | itself | exact |
| `src/services/nearAiClient.ts` (modified, route guard) | service | request-response | itself (`charge`, ~868-874) | exact |
| `src/services/gateStatusBar.ts` | component | event-driven | `src/services/team/teamStatusBar.ts` | exact |
| `src/services/gateCommands.ts` | controller (commands) | request-response | `src/test/teamCommands.test.ts` target module | role-match |
| `src/agent/commandSafety.ts` (modified, effect tags) | utility | transform | itself | exact |
| `src/test/gate*.test.ts` | test | n/a | `src/test/teamBoundaries.test.ts`, `teamCanonical.test.ts`, `teamConcurrency.test.ts` | exact |

## Pattern Assignments

### Pure domain modules (`src/domain/gate/*`)
**Analog:** `src/domain/team/validate.ts` lines 1-40.

Header comment states purity and the hostile-prototype rule; imports are relative, extensionless, type imports separated:
```typescript
// Pure: no I/O, no clock, no vscode. Parsed input is validated in place with Object.keys and own-property checks and is never
// copied with spread syntax, so a hostile prototype key cannot survive into a trusted object (T-60-19).
import { MAX_EVENT_BYTES, canonicalize, eventPath, fingerprintOf, isStrictBase64url } from './canonical';
import type { CommittedEvent, ImplementedTeamEvent, Rejection } from './types';
export const MEMBER_ID_PATTERN = /^mbr-[0-9a-f]{16}$/;
export type Fields = Record<string, unknown>;
export function invalid(path: string): string {
  const safe = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?');
  return `${TEAM_REJECTION_REASONS.invalidBody}: ${safe.slice(0, MAX_REASON_PATH)}`;
}
export function child(path: string, key: string): string { return path === '' ? key : `${path}.${key}`; }
```
Copy: fixed rejection reasons with a sanitized field path, `isRecord` prototype check, `as const` arrays plus derived union types (see `PAYLOAD_PURPOSES` below). Gate modules may import only `src/domain`.

### `src/domain/gate/bundle.ts` (signed policy bundle)
**Analog:** `src/domain/team/signedPayload.ts` lines 18-30. One signer, no second format (anti-pattern in RESEARCH).
```typescript
export const PAYLOAD_PURPOSES = ['policy-bundle', 'grant', 'approval-answer', 'key-record'] as const;
export type PayloadPurpose = typeof PAYLOAD_PURPOSES[number];
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export interface PayloadSigner { readonly fingerprint: string; readonly publicKey: string; sign(bytes: Buffer): string }
```
Phase 70 adds the `label-map` purpose here (RESEARCH PR 1, with the two test edits that enumerate purposes). The verifier takes the expected purpose from its caller, never the envelope. Numbers are whole only (nano-USD, basis points); names that look like secrets fail `assertNoSecrets` (Pitfall 9).

### Signed local stores (`src/gate/bundleStore.ts`, `labelMapStore.ts`, `clockMarker.ts`)
**Analog:** `src/team/keyHistory.ts` lines 112-135, using `withFileLock` from `src/services/stateMirrorLock.ts:190`.
```typescript
import { withFileLock } from '../services/stateMirrorLock';
await mkdir(identityDir, { recursive: true, mode: 0o700 });
return withFileLock(identityDir, KEY_HISTORY_LOCK_FILE, async () => {
  const result = await load(identityDir, secrets);
  if (!result.ok) throw new KeyHistoryError(`Nothing was added to the key history: ${result.reason}`);
  const at = (options.now ?? (() => new Date()))();           // injectable clock for tests
  signed = signPayload(signer, 'key-record', payload, { now: () => at });
  ...
```
Copy: lock the whole read-verify-modify-write (fixes Pitfall 8, two windows racing the first bundle), `mode: 0o700` dir, injectable `now`, plain-message typed error that states nothing was written, `SecretStorageLike` type-only from `src/services/auth.ts:9`. `withFileLock(dir, fileName, work, options)` serializes in-process via `mirrorChains` and cross-process via `acquireFileLock`.

### `src/gate/sessionMark.ts` (ambient session context for routing)
**Analog:** `src/services/spendLedger.ts` lines 27-33.
```typescript
const tags = new AsyncLocalStorage<SpendTag>();
export function withSpendTag<T>(tag: SpendTag, work: () => T): T {
  return tags.run({ ...(tags.getStore() ?? {}), ...stripUndefined(tag) }, work);
}
export function currentSpendTag(): SpendTag { return { ...(tags.getStore() ?? {}) }; }
```
Mirror with `withSessionRoute(ctx, work)` and a `currentSessionRoute()` reader that returns a copy.

### `src/services/nearAiClient.ts` (route guard, modified)
**Analog:** the same file, `charge` lines 868-874: the client already merges per-client options with the ambient store at the single choke point.
```typescript
const tag = { ...(this.options.spendTag ?? {}), ...currentSpendTag() };
```
Read the session route the same way at the request choke point (RESEARCH Section 2.2) and refuse before any bytes leave. Keep the guard optional by default so existing client tests stay unchanged.

### `src/agent/loop.ts` (gate at `executeCall`, modified)
**Analog:** itself, lines 614-640. Layer, do not rewrite (D-10): `decide()` calls `decidePermissionAsync` as its settings layer.
```typescript
const autoCtx = this.options.policy.mode === 'auto' || unattended ? { ...(await this.autoContext(context, command ?? '')), autoSafeTool: tool.autoSafe === true } : undefined;
const decided = await decidePermissionAsync(tool.capability, command, this.options.policy, this.options.rules, this.grants, autoCtx);
const permission = decided.decision === 'deny' ? decided : risky ? { decision: 'ask' as const } : ...;
if (permission.decision === 'deny') return this.finish(call.id, false, `Not allowed: ${permission.reason}`);
```
Keep the `forbidden` early return (lines 618-623) first, keep the `gated` emit logic, and make the `gate` option optional with a default (Pitfall 1: required breaks 19 test files). Pitfall 5: `fully-autonomous` must still build the classifier context so floor facts exist.

### `src/services/gateStatusBar.ts`
**Analog:** `src/services/team/teamStatusBar.ts` lines 50-70.
```typescript
const item = vscode.window.createStatusBarItem('nearAi.team', vscode.StatusBarAlignment.Left, 50);
item.name = 'NEAR AI Team';
item.command = VERIFY_LOG_COMMAND;
item.show();
return { update(...) { item.text = ...; item.backgroundColor = ok ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground'); }, dispose() { item.dispose(); } };
```
Return a small interface with `update` and `dispose`; use an id and a distinct priority. Tests use the stubs at `src/test/helpers/vscodeStub.ts:79` and the inline `createStatusBarItem` stubs in `toolsPage.test.ts:343`.

### Tools page words and approval cards
Analogs are `src/services/toolsDirectory` and mcpView (Tools page rendering) and `approvalService` cards. Pitfall 11: `decidePermission` is also called by the Tools page and the cyber engine, so keep its signature stable and route new words through the gate's pure `words.ts`. The loop's approval path builds `preview` inside the `permission.decision === 'ask'` branch (loop.ts ~636); add floor and label reasons there.

### Tests (`src/test/gate*.test.ts`)
**Analog:** `src/test/teamBoundaries.test.ts` lines 1-40. Reads TypeScript sources from the repo root (`path.resolve(__dirname, '..', '..')`), classifies imports with `STATIC_FORM`, `SIDE_EFFECT_FORM` and `CALL_FORM`, and asserts allowed specifiers per directory.
```typescript
const DOMAIN_TEAM = 'domain/team';
const LOCK_MODULE = 'services/stateMirrorLock';
export function importsOf(text: string): ImportRef[] { ... }
```
For the gate: add `domain/gate` (imports only `src/domain`, Node builtins forbidden except what `domain/team` already allows) and `gate` (may reach only `services/auth` type-only, `services/stateMirrorLock` and `domain/*`). Pitfall 12: the relay compiles `src/domain/gate` too, so keep it free of Node-only imports. Concurrency tests copy `teamConcurrency.test.ts`; canonical and golden tests copy `teamCanonical.test.ts`. Parity tests keep `autoApproval.test.ts` and the 25 `AgentRun` tests unchanged; `protectedPaths.test.ts:304` is rewritten only in PR 2b.

## Shared Patterns

### One signer
**Source:** `src/domain/team/signedPayload.ts`. **Apply to:** bundle, label map, grants later. Never add a second signer.

### Lock plus injectable clock plus plain error messages
**Source:** `src/team/keyHistory.ts:112-135`. **Apply to:** every `src/gate` store.

### Ambient context via AsyncLocalStorage
**Source:** `src/services/spendLedger.ts:27-33`. **Apply to:** session mark and route context.

### Layer, do not rewrite
**Source:** `src/agent/loop.ts:629`. **Apply to:** `decide.ts` wraps `decidePermissionAsync`.

### Structured effect tags, no reason-text parsing
**Source:** `src/agent/commandSafety.ts` (classifier result). **Apply to:** floor detection (RESEARCH 4.1, Pitfall 2: keep the tag through wrappers).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/domain/gate/dominance.ts` (join algorithm) | utility | transform | No lattice or label code exists; use RESEARCH 9.3 |
| `src/gate/clockMarker.ts` rollback detection | store | file-I/O | No monotonic clock marker exists; use the key-history store shape plus RESEARCH Pitfall 7 |

## Metadata

**Analog search scope:** `src/domain/team`, `src/team`, `src/services`, `src/agent`, `src/test`
**Files scanned:** about 14 read in part
**Pattern extraction date:** 2026-11-16
**Note:** line numbers were read from the working tree for this phase and can drift as earlier PRs land.

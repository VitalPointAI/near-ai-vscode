# Phase 69: Team Mode reconciliation - Pattern Map

**Mapped:** 2026-11-15
**Files analyzed:** 47 re-applied (Appendix A) plus about 14 new or edited
**Analogs found:** all, except the new pure signer modules (partial)

All analog paths below are git-tracked on this branch (checked `git ls-files` for the main-side ones). Archive-side analogs are `git show ae5e9e1:<path>` (Phase 60 end, on `origin/feat/team-fix-pass`).

## File Classification

| File | Role | Data Flow | Analog | Match |
|------|------|-----------|--------|-------|
| 43 Phase 60 files (Appendix A, minus the four E files) | mixed | mixed | `ae5e9e1:<same path>` | self (re-apply) |
| `src/team/gitTransport.ts` (T1 edits, lock swap) | service | file-I/O + lock | `ae5e9e1` file plus `src/services/stateMirrorLock.ts` | exact |
| `src/test/helpers/mirrorLockChild.ts`, `teamSharedMirror.test.ts` | test | file-I/O | `3e11c0e` versions, lock calls adapted | self |
| `package.json` (E) | config | n/a | `package.json` lines 76-100, 757-770 | exact |
| `src/extension.ts` (E) | config | n/a | lines 32, 130-131 | exact |
| `src/domain/approval.ts`, `src/services/auditStore.ts` (E) | model | transform | same files | exact |
| `src/domain/team/payloadSigner.ts`, `keyStatus.ts` (new, pure) | utility | transform | `ae5e9e1:src/domain/team/canonical.ts`, `permissions.ts` | role-match |
| `src/team/identity.ts` (edit: single `nearAi.identity.deviceKey`) | service | request-response | `ae5e9e1:src/team/identity.ts` | self |
| `src/team/keyHistory.ts` (new, local signed history) | service | file-I/O | `ae5e9e1:src/team/teamFile.ts` 151-193; `src/services/stateHome.ts` 106-115 | role-match |
| `device.rotated` in types/validate/permissions/materialize | model | transform | the `device.revoked` handling at `ae5e9e1` | exact |
| `src/test/teamBoundaries.test.ts` | test | transform | `src/test/relayIsolation.test.ts` | role-match |
| `src/test/teamMirrorIsolation.test.ts` | test | file-I/O | `src/test/helpers/gitFixtures.ts`, `syncFixtures.ts`, `stateSyncGit.test.ts` | role-match |
| `teamSignedPayload`, `teamKeyStatus`, `teamKeyHistory` tests | test | transform | `ae5e9e1:src/test/teamIdentity.test.ts`, `teamForgery.test.ts` | role-match |
| `src/test/teamDisposition.test.ts` | test | file-I/O | `src/test/relayIsolation.test.ts` (`readJson`, `REPO_ROOT`) | role-match |
| rewritten `teamManifest.test.ts` | test | file-I/O | `ae5e9e1` version plus `relayIsolation.test.ts` lines 31-40 | role-match |
| `.planning/research/v0.6.0-disposition.md` | doc | n/a | `.planning/research/v0.6.0-evidence-based-model-defaults.md` | partial |

## Re-applied files: source and main-side drift

Source for every file: `git show ae5e9e1:<path>`. Use the explicit list in RESEARCH Appendix A. Never use a glob such as `src/test/team*.test.ts` (it would overwrite main's `teamStudio*`, `teamInvocation`, `agentTeams` tests). Run `git status` after each step; expect only added files plus four edits.

Drift to adapt (RESEARCH Q2):
- `redactSecrets` (`src/domain/redaction.ts:27`) is broader on main; re-run `teamSecrets`, `teamValidate`, `teamLog`, `teamEnable`, `teamFile` and read new failures as drift.
- `SecretStorageLike` (`src/services/auth.ts:9-13`) is unchanged; type-only import stays.
- Helper name clash: `MemorySecrets` and `gitIn` exist in both `teamHarness.ts` and main's `stateFixtures.ts`; alias one in any test importing both.
- No vscode stub on main, so `helpers/vscodeStub.ts` does not collide.
- Lock: replace T1's `mirrorProcessLock.ts` (do not take it) with main's lock, see below.
- T2 (`9e49bc5`): `teamSession.ts` hunks 1 and 2 apply; hunk 3 is a one-line manual edit; skip hunk 4 (Phase 61 code).
- T3 (wording) is hand-copied strings only, with the test assertions updated.

## Pattern Assignments

### `src/team/gitTransport.ts` lock swap (service, file-I/O)

**Analog:** `src/services/stateMirrorLock.ts` (lines 16-19, 38-55, 139-155, 190+) and its use in `src/services/stateLocks.ts` (lines 10, 39).

Main's API:
```typescript
export const MIRROR_LOCK_FILE = 'near-ai-state-sync.lock';   // line 16, sync's name: do not reuse for team
export class MirrorBusyError extends Error { /* name 'MirrorBusyError' */ }
export async function acquireFileLock(dir: string, fileName: string, options: FileLockOptions): Promise<HeldMirrorLock>
// FileLockOptions = { staleMs?, refreshMs?, waitMs?, sleep, random, busy?: () => Error }  (sleep and random are required here)
export async function withFileLock<T>(dir, fileName, work, options: Partial<FileLockOptions> = {}): Promise<T> // fills sleep/random itself
```
Existing reuse pattern (stateLocks.ts:10, 39):
```typescript
import { withFileLock, type MirrorLockOptions } from './stateMirrorLock';
return withFileLock(dir, `${name}.lock`, work, { ...options, busy: () => new StateBusyError() });
```
Port: export `TEAM_MIRROR_LOCK_FILE = 'near-ai-team-sync.lock'` from `gitTransport.ts`; in `exclusive()` call `acquireFileLock(this.mirrorDir, TEAM_MIRROR_LOCK_FILE, { ...this.lockTimings, sleep: this.sleep, random: this.random })`; catch `MirrorBusyError` imported from `../services/stateMirrorLock`. `mirrorLockChild.ts` and `teamSharedMirror.test.ts` import the constant from the transport. This is the first runtime import from `src/team` into `src/services`; `teamBoundaries` must allow exactly this one module (it imports only `node:` modules).

### `package.json` (E)

**Analog:** same file. Existing command entry shape (lines 75-100):
```json
{ "command": "nearAi.sync.turnOn", ... }
```
Read lines 74-100 for the full entry shape (title, category "NEAR AI", icon) before copying. Append `nearAi.team.enable` (title "Enable Team Mode", icon `$(organization)`) and `nearAi.team.verifyLog` (icon `$(verified)`; title per T3) to `contributes.commands`; append `nearAi.team.pollSeconds` (number, default 15, min 5, max 3600, scope application) and `nearAi.team.preview` (boolean, default false, scope application) at the end of configuration properties.

`menus` at line 757 holds only `view/title` (entries like `{ "command": "nearAi.newChat", "when": "view == nearAiChatView", "group": "navigation@1" }`). Add a sibling `"commandPalette"` array (D-24):
```json
"commandPalette": [
  { "command": "nearAi.team.enable", "when": "config.nearAi.team.preview" },
  { "command": "nearAi.team.verifyLog", "when": "config.nearAi.team.preview || nearAi.team.active" }
]
```
`nearAi.team.active` is set by `setContext` in `teamSession` start and cleared on dispose. Trailing-dot filter `'nearAi.team.'` (main has `nearAi.teams.*`).

### `src/extension.ts` (E)

Add `import { registerTeamMode } from './services/team/teamCommands';` (or wherever `ae5e9e1` imports from; copy the line) after line 32 `import { registerSpendTracking } from './services/spendTracking';`. Call placement, lines 130-131:
```typescript
  registerSpendTracking(context, auth);
  registerTeamMode(context);          // new
  registerSpendingLimits(context, auth);
```

### `src/domain/approval.ts` (E) and `src/services/auditStore.ts` (E)

`approval.ts` lines 9-12: add `| 'team-roster'` to the end of the `AuditEventType` union (after `'near-wallet'`). `auditStore.ts` line 88 (`isAuditEventType`, a one-line array): append `'team-roster'` after `'near-wallet'` in the list. Both re-apply as at `ae5e9e1`.

### `device.rotated` (types, validate, permissions, materialize)

**Analog:** Phase 60 `device.revoked`, all at `ae5e9e1`:
- `types.ts:14` add `'device.rotated'` to `TEAM_EVENT_TYPES` only if absent (D-04), and add to `ImplementedEventBodies` (line 30) and `IMPLEMENTED_EVENT_TYPES` (line 32).
- `validate.ts:194-199`:
```typescript
'device.revoked': (body) => checkKeys(body, 'body', ['memberId', 'fingerprint'])
  ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
  ?? validateId(body.fingerprint, FINGERPRINT_PATTERN, 'body.fingerprint'),
```
  A rotated body would carry `memberId`, old `fingerprint`, new `device` (validate with `validateDeviceRef` as `device.added` does at 190-193), and omit, never set `undefined`, any optional key (Pitfall 3).
- `permissions.ts:179`: `case 'device.revoked': return { kind: 'device.revoke', memberId: event.body.memberId };` add a parallel case.
- `materialize.ts:134-142` preconditions (member lookup, `deviceIndex.get(fp) === member.id`, `R.deviceNotBound`, `R.deviceRevoked`) and the matching apply case near line 188; rotation keeps the member's device count (no `R.lastDevice` check) and per D-21 retires the old key only for later-claimed times.

### `src/domain/team/` signer and key status (new, pure)

**Analog:** `ae5e9e1:src/domain/team/canonical.ts` (canonicalisation, which rejects `undefined` values) and `permissions.ts` (pure decision tables). Constraint D-07/D-18: no `vscode`, no `src/services` import in `src/domain`. Signer takes any `{ publicKey, fingerprint, sign }` (D-20); `verifyPayload` never throws. The private-key half and `signEvent` analog: `ae5e9e1:src/team/identity.ts:66`.

### `src/team/identity.ts` (edit)

Analog is the file: `DEVICE_KEY_SECRET_PREFIX` (line 9), `deviceKeySecretName(teamId)` (11), `createDeviceIdentity` (40), `loadDeviceIdentity` (49), `forgetDeviceIdentity` (62). Change to one secret name `nearAi.identity.deviceKey`; create inside `withFileLock(<globalStorage>/identity, 'identity-create.lock', ...)` (Pitfall 4) with check, create, store, read back; `forgetDeviceIdentity` only when this call created the key and nothing was signed (D-22).

### Local signed key history (new)

**Analogs:** `ae5e9e1:src/team/teamFile.ts:151` `runSerialised(key, task)`, `:172` `writeFileAtomic(file, text)`, `:193` `await runSerialised(target, () => writeFileAtomic(target, text));`. Main equivalent: `src/services/stateHome.ts:106-115`:
```typescript
export async function writeFileAtomic(target: string, data: string | Buffer, options: StateWriteOptions = {}): Promise<void> {
  const temporary = temporaryName(target);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: options.mode ?? 0o600 });
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
```
Use the `src/team` copy so `src/team` stays free of `src/services` imports beyond the one lock module. History `created` record is written inside the identity-create lock.

### `src/test/teamBoundaries.test.ts`

**Analog:** `src/test/relayIsolation.test.ts` lines 7-23 (node:test plus assert/strict, `REPO_ROOT = path.resolve(__dirname, '..', '..')`, read files and assert with explanatory messages). Scan `src/domain/**` and `src/team/**` sources for `from 'vscode'` and for imports from `src/services` other than `../services/stateMirrorLock` and type-only `../services/auth`. `__dirname` is `dist/test`, so read `src/` under `REPO_ROOT`. `node --test` runs one process per file.

### `src/test/teamMirrorIsolation.test.ts`

**Analogs:** `src/test/helpers/gitFixtures.ts`: `fixtureGit(dir, args, input?)` (34), `bareRemote(opts)` (39), `userRepo(remoteDir, opts)` (58), `repoSnapshot(dir)` (83), `scanRemote(remoteDir, sentinels)` (126), `tempDirectory(prefix)` (168), `mirrorPaths(prefix)` (203); and `syncFixtures.ts`: `machine(remoteDir, name, opts)` (42), `remoteFiles(remoteDir, ref = STATE_BRANCH)` (155). Assert the team mirror path, ref and lock name never equal sync's (`refs/heads/near-ai/state`, `refs/near-ai/incoming`, `near-ai-state-sync.lock`), and that `team.json` refs equal to, under or prefixing those are refused (D-23, case-insensitive).

### `teamSignedPayload`, `teamKeyStatus`, `teamKeyHistory` tests

Analog: `ae5e9e1:src/test/teamIdentity.test.ts`, `teamForgery.test.ts`, with `helpers/teamHarness.ts` (`MemorySecrets`) and `teamCanary.ts` (keys built from `randomBytes` at run time, so no literal key reaches `secret-scan`; never write a PEM header or `sk-` token in tests or docs).

### `teamDisposition.test.ts` and `teamManifest.test.ts` (rewrite)

Analog for reading repo files: `relayIsolation.test.ts:19-20, 31-40`:
```typescript
async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, file), 'utf8')) as Record<string, unknown>;
}
assert.equal(manifest.dependencies, undefined, '...');
```
Also `src/test/syncControl.test.ts:19` (`const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8')`) and its typed `contributes.configuration.properties` cast at line 379. For `teamManifest`: replace the merge-base test (D-27) with `dependencies === undefined`, a literal `devDependencies` deep-equal, the commandPalette entries, and the `nearAi.team.preview` setting (boolean, false, application, plain description, no em-dash). For disposition: parse the markdown table rows of `.planning/research/v0.6.0-disposition.md`, one per phase 60-67 and 62.1 and per requirement, including the "same id elsewhere" column (D-26).

### `.planning/research/v0.6.0-disposition.md`

Closest tracked analog: `.planning/research/v0.6.0-evidence-based-model-defaults.md` (prose with H1, "Captured <date>" line, H2 sections). No table-style research doc exists; use RESEARCH tables (e.g. the Q1 verdict table) as the format model. Columns per D-16 and D-26; mention D-28 (one fingerprint visible on the remote; shared code-server one identity) and Pitfall 5.

## Shared Patterns

- Locks: always `withFileLock` or `acquireFileLock` from `src/services/stateMirrorLock.ts`; each feature has its own lock file name (sync: `near-ai-state-sync.lock`, team: `near-ai-team-sync.lock`, identity: `identity-create.lock`).
- Atomic file writes: temp file with `wx` and `rename` (stateHome.ts:106 or teamFile.ts:172), owner-only mode 0o600.
- Tests: `node:test` plus `node:assert/strict`, flat `src/test/*.test.ts`, helpers without `.test.` suffix in `src/test/helpers/`; tests never weakened (D-05).
- Commands under memory cap per D-18 (not run here).
- Plain words in user-visible strings; "your organization", never "NEAR organization".

## No Analog Found

| File | Reason |
|------|--------|
| `payloadSigner.ts`, `keyStatus.ts` | Only role-level analogs (canonical.ts, permissions.ts); the interface is new (D-08, D-20, D-21). Use RESEARCH design. |
| disposition table doc | No table-style planning doc exists. |

## Metadata

**Search scope:** `src/services`, `src/test`, `src/test/helpers`, `package.json`, `src/extension.ts`, `.planning/research`, `git show ae5e9e1`
**Pattern extraction date:** 2026-11-15

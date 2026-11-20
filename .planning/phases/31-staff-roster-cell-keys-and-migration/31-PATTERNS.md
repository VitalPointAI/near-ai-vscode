# Phase 31: Staff roster, cell keys and migration - Pattern Map

**Mapped:** 2026-11-19
**Files analyzed:** 28 (new and modified, from RESEARCH "Recommended Project Structure" and CONTEXT D-01..D-49)
**Analogs found:** 26 / 28 (all analog paths verified git-tracked under `src/`)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/domain/replica/roster.ts`, `rosterOps.ts` | pure fold (service) | transform | `src/domain/replica/rosterView.ts` (`staticRosterView`) + `projectFold.ts` | role-match |
| `src/domain/replica/rosterView.ts` (modify: optional `canRunAgent`, `clientIdOwner`, `deviceEncryptionKey`, `cellGrantees`, `isCheckpointSigner`) | interface | request-response | itself | exact |
| `src/domain/replica/cellKeys.ts` | utility (crypto) | transform | `src/domain/team/canonical.ts` (node:crypto use) + `signedPayload.ts` | partial |
| `src/domain/replica/invite.ts`, `safetyCode.ts`, `safetyWords.ts`, `clientIds.ts`, `holdWaits.ts`, `updateGuard.ts` | pure utility | transform | `src/domain/team/signedPayload.ts` (signed file, closed failure list) | role-match |
| `src/domain/replica/kindSchemas/roster.ts`, `project.ts` (modify, D-49) | schema | transform | `kindSchemas/roster.ts` itself | exact |
| `src/domain/replica/{fold,textFold,equivocation,checkpoint,projectFold,doc,versions}.ts` (modify, hardening D-01, D-02, D-05, D-42) | pure fold | event-driven | themselves | exact |
| `src/domain/team/signedPayload.ts` (modify: add purposes `staff-cell-grant`, `staff-replica-mark`, invite and join) | utility | transform | itself, line 24 `PAYLOAD_PURPOSES` | exact |
| `src/staff/replica/store.ts` | host store | file-I/O | `src/staff/staffFiles.ts` (`readWhole`, `writeIfUnchanged`) | role-match |
| `src/staff/replica/marks.ts`, `keyring.ts` | host (SecretStorage) | CRUD | `src/team/identity.ts` (`loadOrCreateDeviceIdentity`) | role-match |
| `src/staff/replica/decodeWorker.ts`, `decodeHost.ts` | worker | request-response | none in repo | none |
| `src/staff/replica/migrate.ts`, `projection.ts`, `singleCopy.ts` | host service | batch | `src/staff/staffHost.ts`, `src/domain/staff/ledger.ts`, `readModels.ts` | role-match |
| `src/services/staffMultiUserCommands.ts` | command registration | request-response | `src/services/staffCommands.ts` (`registerStaffCommands`) | role-match |
| `src/domain/staff/commands.ts` (modify) + `package.json` | config | n/a | `STAFF_COMMANDS` in `src/domain/staff/commands.ts:4` | exact |
| `src/test/replica*.test.ts`, `staffReplica*.test.ts` | test | n/a | `src/test/replicaBoundaries.test.ts`, `replicaConvergence.test.ts`, `replicaTracer.test.ts`, `replicaVectors.test.ts` | exact |
| `SECURITY.md` (modify) | doc | n/a | existing sections | n/a |

## Pattern Assignments

### Roster fold (`roster.ts`, `rosterOps.ts`)
**Analog:** `src/domain/replica/rosterView.ts` lines 7-23 (the interface to satisfy) and 62-101 (`staticRosterView`, reference behavior: position map from roster hash, `deviceKey` scans all positions, `isAdmitted` and `hasRole` are evaluated AT the cited position, `roleWithdrawnBy` scans later positions).
```typescript
export interface RosterView {
  hasRoster(rosterHash: string): boolean;
  rosterPosition(rosterHash: string): number | undefined;
  deviceKey(writer: string): { publicKey: string; member: string } | undefined;
  isAdmitted(writer: string, rosterHash: string): boolean;
  hasRole(member: string, role: string, rosterHash: string): boolean;
  roleWithdrawnBy(member: string, role: string, rosterHash: string): string | undefined;
  chosenBranch(writer: string, stream: string, seq: number): string | undefined;
  checkpointSigner(writer: string, rosterHash: string): boolean;
}
```
New optional members (D-08, D-41) must be optional so `staticRosterView` and all Phase 30 tests stay unchanged. Build the real view as a closure over a per-position snapshot array exactly like `staticRosterView`. Pure, no I/O, hub-side: it may import only `./entry`, `./rosterView`, `./kindSchemas/*` (see boundary test below), and must be added to `HUB_SIDE` in `replicaBoundaries.test.ts` lines 18-31.

### Kind schema extensions (D-49)
**Analog:** `src/domain/replica/kindSchemas/roster.ts` lines 1-30 (imports and constants).
```typescript
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { writerIdOf } from '../entry';
import { ROSTER_ROLE_PATTERNS } from '../rosterView';
import { invalidAt, isBase64urlBytes, isHash, isIsoTime, isSlug } from './shared';
import { countCheck, hashCheck, hasOwn, keyProblem, lineCheck, oneOf, slugCheck, streamCheck, timeCheck, validateShape } from './project';
```
Extend shapes with the same `Check`/`Shape` helpers and `isExactBytes(value, 32)` for X25519 and Ed25519 keys. Do not import `kinds.ts`. Update the three pinned-count tests (`replicaKinds.test.ts`) for 51 kinds.

### Signed invite, join request, grant, mark (`invite.ts`, `cellKeys.ts` grant objects, `marks.ts`)
**Analog:** `src/domain/team/signedPayload.ts`.
```typescript
export const PAYLOAD_PURPOSES = ['policy-bundle', 'grant', ..., 'staff-ledger', 'staff-ledger-head', 'staff-decision', 'staff-replica'] as const;
export interface PayloadSigner { readonly fingerprint: string; readonly publicKey: string; sign(bytes: Buffer): string }
export class PayloadError extends Error { ... }
export const PAYLOAD_FAILURES = { malformed: '...', 'wrong-purpose': '...', 'too-large': '...', 'bad-signature': '...' }  // closed list, plain words, no em-dash
```
Copy: add a purpose to `PAYLOAD_PURPOSES`; the verifier takes the expected purpose from the caller, never from the envelope; whole numbers only in payloads (no fractions); every failure reason has a message and a test; `MAX_PAYLOAD_BYTES` 256 KiB cap. Add new failure texts to the closed list rather than inventing a second signer.

### Cell keys and wraps (`cellKeys.ts`)
**Analog:** no in-repo X25519/HKDF code; `src/domain/team/canonical.ts` line 3 shows the import style (`import { createHash, ... } from 'node:crypto'`) and is pure domain code using only `node:crypto`. Use `generateKeyPairSync('x25519')`, `diffieHellman`, `hkdfSync('sha256', ...)` with info binding cell id, epoch and device id, and `createCipheriv('aes-256-gcm')`, per RESEARCH "Cell keys, wraps and grants" (lines 388-413). Epoch starts at 1, never 0 (Pitfall 3). Not hub-side unless added to `HUB_SIDE`.

### Store (`src/staff/replica/store.ts`)
**Analog:** `src/staff/staffFiles.ts` (89 lines).
```typescript
export async function readWhole(file: string, max: number = MAX_STAFF_FILE_BYTES): Promise<WholeRead>   // unreadable is never empty
export async function writeIfUnchanged(file: string, expected: FileSnapshot, text: string | undefined): Promise<boolean>  // temp file + CAS + rename
```
Copy: temp file with `flag: 'wx'`, hash re-check immediately before `rename`, never read an oversized file as empty. Append-only per-writer files and content-addressed blobs follow the same atomic-rename rule. Cross-window lock (D-46):
**Analog:** `src/services/stateMirrorLock.ts` line 190
```typescript
export async function withFileLock<T>(dir: string, fileName: string, work: () => Promise<T>, options: Partial<FileLockOptions> = {}): Promise<T>
```
Not re-entrant: never take the same lock twice in nested work. `src/staff/registerLock.ts` is an in-process `Map<string, Promise>` only; do not use it as the cross-window lock. Write a self-ignoring `.gitignore` in `.planning/staff/replica/`.

### Device key in SecretStorage (`keyring.ts`, `marks.ts`)
**Analog:** `src/team/identity.ts` lines 176-205 (`loadOrCreateDeviceIdentity`).
```typescript
await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
return withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
  const existing = await loadDeviceIdentity(secrets);
  if (existing) return { identity: existing, created: false };
  const made = await createDeviceIdentity(secrets);
  const readBack = await loadDeviceIdentity(secrets);   // read back, compare, only then use
  ...
```
Copy: create under the same `identity-create.lock` (research line 144), read back before use, lock folder mode 0o700, never write private keys to the project folder, logs or bundles. Pitfall 7: SecretStorage values are retired by archive-style rename like `PREVIOUS_DEVICE_KEY_SECRET`, not deleted blindly.

### Commands (`src/services/staffMultiUserCommands.ts`)
**Analog:** `src/services/staffCommands.ts` (`registerStaffCommands`, called at `src/extension.ts:140`) and ids in `src/domain/staff/commands.ts:4` (`STAFF_COMMANDS`). Add ids there and titles in `package.json` `contributes.commands`. Gate on `nearAi.staff.multiUserPreview` (default off); prefer registering always and checking inside (RESEARCH line 465). Pitfall 8: preview off must not load the modules or create files, SecretStorage keys or the replica folder (D-29 regression test).

### Migration and projections (`migrate.ts`, `projection.ts`, `singleCopy.ts`)
**Analogs:** `src/domain/staff/ledger.ts`, `products.ts`, `personDecisions.ts`, `wargame.ts`, `readModels.ts` (reducers and read models reused unchanged, fed from the fold) and `src/staff/staffHost.ts` (~line 332, `withFileLock` use for staff writes). Verify first with today's verifiers (D-30); idempotent ids derived from file hashes (D-34); legacy files moved to `.planning/staff/legacy/`, never deleted.

### Tests
**Analog:** `src/test/replicaBoundaries.test.ts` (import-boundary scan; extend `HUB_SIDE`), `replicaConvergence.test.ts` (extend CR-02/CR-03 property tests, do not weaken), `replicaTracer.test.ts` (tracer shape for the genesis -> invite -> join -> admit -> grant -> `doc.update` path), `replicaVectors.test.ts` (checkpoint v2 gets a new `checkpointV2` section; v1 vector byte-identical). `node:test` + `node:assert/strict`; compiled tests run from `dist/test`, sources found via `path.resolve(__dirname, '..', '..')`. Seeded generator and bounded cases from Phase 30. Wrap test commands per D-40.

## Shared Patterns

### Import boundary
**Source:** `src/test/replicaBoundaries.test.ts` lines 18-31. **Apply to:** every new `src/domain/replica/*.ts`. Pure, no `vscode`, only `doc.ts` loads Yjs, hub-side files reach no other replica file even by type import. `decodeWorker.ts` must not import `vscode`.

### Signed things
**Source:** `src/domain/team/signedPayload.ts`. **Apply to:** invite file, join request, grants, marks, genesis pin. One signer, closed failure list, purpose from caller.

### Atomic, lock-guarded file writes
**Source:** `src/staff/staffFiles.ts` plus `withFileLock`. **Apply to:** store, projections, migration, single-machine copy.

### Plain-words refusals and notices
**Source:** `PAYLOAD_FAILURES` messages; `CLEARANCE_SELF_ASSERTED_TEXT` and `LABELS_NOT_ACCREDITATION_TEXT` in `src/domain/gate/labels.ts`. **Apply to:** every command result and screen (D-13, D-37). No em-dashes, "your organization".

### Optional interface growth
**Source:** `RosterView` and `ReplicaContext` in `rosterView.ts`. **Apply to:** all hardening: add optional members, keep `staticRosterView` and Phase 30 vectors valid.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/staff/replica/decodeWorker.ts`, `decodeHost.ts` | worker | request-response | No `worker_threads` use in repo; follow RESEARCH "Worker host with limits" (line 533) and note there is no bundler, so the worker compiles to `dist/staff/replica/decodeWorker.js` |
| `src/domain/replica/cellKeys.ts` (X25519, HKDF, AES-GCM) | utility | transform | No existing X25519 or HKDF code; follow RESEARCH lines 388-413 |

## Metadata

**Analog search scope:** `src/domain/replica`, `src/domain/team`, `src/team`, `src/staff`, `src/services`, `src/test`
**Files scanned:** about 25 listed and read in part; large files not fully read
**Pattern extraction date:** 2026-11-19

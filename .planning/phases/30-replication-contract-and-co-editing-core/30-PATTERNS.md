# Phase 30: Replication contract and co-editing core - Pattern Map

**Mapped:** 2026-11-19
**Files analyzed:** 27 new or modified (plan names follow RESEARCH wave table 30-01..30-08)
**Analogs found:** 25 / 27 (all analog paths verified git-tracked)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/domain/team/signedPayload.ts` (add `'staff-replica'` to `PAYLOAD_PURPOSES`, line 29) | config | transform | itself (earlier purposes `staff-ledger`, `staff-decision`) | exact |
| `src/test/teamSignedPayload.test.ts` (purpose list assertion) | test | transform | itself | exact |
| `src/domain/replica/entry.ts` (header, sign/verify adapter, seal/open, hash, blob codec) | utility | transform | `src/domain/team/signedPayload.ts` + `src/domain/staff/ledger.ts` (`LEDGER_GENESIS`, entry digest) | role-match |
| `src/domain/replica/kinds.ts`, `kindSchemas/*.ts` | model/validator | transform | `src/domain/team/validate.ts` | exact |
| `src/domain/replica/verify.ts`, `chain.ts` | service | transform | `src/domain/staff/ledger.ts` (chain replay) + `validate.ts` | role-match |
| `src/domain/replica/equivocation.ts` | service | transform | `src/domain/staff/ledger.ts` (fork detection) | partial |
| `src/domain/replica/order.ts`, `fold.ts`, `reducers.ts`, `digest.ts` | service | transform/batch | `src/domain/team/materialize.ts` (`reduce`, `applyEntry`) | role-match |
| `src/domain/replica/checkpoint.ts` | model | transform | `signedPayload.ts` + `ledger.ts` head signing (`staff-ledger-head`) | role-match |
| `src/domain/replica/rosterView.ts` (interfaces + test roster) | service | request-response | `src/domain/team/keyStatus.ts` (`KeyStatusLookup`) | role-match |
| `src/domain/replica/transport.ts` (types only) | model | pub-sub | none in repo | no analog |
| `src/domain/replica/doc.ts` (CRDT interface, Yjs adapter) | adapter | transform | `src/mcp/client.ts` `loadSdk()` (lines 75-85) | exact (loader) |
| `src/domain/replica/attribution.ts` | service | transform | `materialize.ts` reducer style | partial |
| `src/domain/replica/versions.ts`, `decisions.ts` | service | event-driven | `src/domain/staff/release.ts` (`transition`, `RELEASE_TRANSITIONS`) | exact (reuse) |
| `scripts/vendor-libs.mjs`, `scripts/entries/yjs.mjs` | config | batch/file-I/O | `scripts/vendor-libs.mjs` mcp bundle, `scripts/entries/mcp-client.mjs` | exact |
| `scripts/crdt-vendor.json` | config | file-I/O | `media/vendor/VENDORED.json` | role-match |
| `scripts/verify-release-content.mjs` | config | file-I/O | itself (lines 79-88 required list; VENDORED.json hash check ~line 170) | exact |
| `SECURITY.md` (Dependencies, lines ~1303-1337) | doc | n/a | itself | exact |
| `src/test/replicaVendor.test.ts` | test | file-I/O | `src/test/staffCopSymbols.test.ts` (lines 80-83) | exact |
| `src/test/replicaBoundaries.test.ts` | test | file-I/O | `src/test/teamBoundaries.test.ts` | exact |
| `src/test/replica*.test.ts` (tracer, kinds, chain, equivocation, doc, attribution, versions, decisions, order, checkpoint, convergence) | test | transform | `src/test/teamSignedPayload.test.ts`, `src/test/helpers/teamEvents` (`mulberry32`) | role-match |
| `test/fixtures/replica/vectors.json` | fixture | n/a | none | no analog |

## Pattern Assignments

### `src/domain/team/signedPayload.ts` (one array entry)
**Analog:** itself, line 29:
```typescript
export const PAYLOAD_PURPOSES = ['policy-bundle', 'grant', 'approval-answer', 'key-record', 'label-map', 'label-declassify', 'staff-ledger', 'staff-ledger-head', 'staff-decision'] as const;
```
Append `'staff-replica'`. The existing test `src/test/teamSignedPayload.test.ts` imports `PAYLOAD_PURPOSES`; check whether it pins the list and update only that assertion. Nothing else in this file changes (D-02).

### `src/domain/replica/entry.ts` (utility, transform)
**Analog:** `src/domain/team/signedPayload.ts`; use RESEARCH "Signer fit" adapter sketch (RESEARCH lines ~198-215) verbatim.
**Imports pattern** (signedPayload.ts lines 18-20):
```typescript
import { CanonicalJsonError, canonicalBytes, canonicalize, fingerprintOf, isStrictBase64url, verifySignature } from './canonical';
import type { KeyState, KeyStatusLookup } from './keyStatus';
```
In replica files use `from '../team/canonical'`, `'../team/signedPayload'`, `'../team/keyStatus'` (allowed: anything under `src/domain`).
**Core signing pattern** (signedPayload.ts lines 95-125): `signPayload(signer, purpose, payload, { now, maxBytes })`; it verifies its own signature before returning. Adapter fixes `now: () => new Date('1970-01-01T00:00:00.000Z')` so signatures are deterministic, and passes `status: () => ({ state: 'active' })` to `verifyPayload` (real authority is the `RosterView`).
**Verify pattern** (lines 132-160): `verifyPayload(envelope, { purpose, status, maxBytes })` never throws; reasons are a closed `PAYLOAD_FAILURES` map. Copy this "closed reasons map with plain messages, no em-dash" style for replica refusal reasons.
**Genesis marker:** `src/domain/staff/ledger.ts:30` `export const LEDGER_GENESIS = '0'.repeat(64);` is the precedent for `GENESIS_PREV`.
**AAD note (forced by RESEARCH):** AES-GCM associated data excludes `body.hash` (circularity); `aad = canonicalBytes({v:2, stream, writer, seq, prev, epoch, size})`.
Use `canonicalBytes` (canonical.ts line 71) for all hashed and signed bytes; `isStrictBase64url(value, byteLength)` (line 100) for key and sig shape checks.

### `src/domain/replica/kinds.ts` and `kindSchemas/*.ts` (validator)
**Analog:** `src/domain/team/validate.ts`
**Pattern** (lines 1-40): own-property checks, no spread of parsed input, closed key lists, bounded reasons.
```typescript
const ENVELOPE_KEYS = ['v', 'id', 'teamId', 'type', 'lamport', 'at', 'author', 'device', 'prev', 'body', 'sig'];
export function invalid(path: string): string {
  const safe = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?');
  return `${TEAM_REJECTION_REASONS.invalidBody}: ${safe.slice(0, MAX_REASON_PATH)}`;
}
export function child(path: string, key: string): string { return path === '' ? key : `${path}.${key}`; }
export function isRecord(value: unknown): value is Fields { /* plain object, prototype check */ }
```
Copy `isRecord`, `child`, `invalid` style and the `hasExactKeys(value, required, optional)` helper from `signedPayload.ts` lines 125-128. Unknown kinds: keep and relay, never fold (D-07). Pattern table fixed regexes (`EVENT_ID_PATTERN` etc., lines 11-22) as the model for `STREAM_ID_PATTERN`, `WRITER_PATTERN`, hash patterns.

### `src/domain/replica/verify.ts`, `chain.ts`, `equivocation.ts`
**Analog:** `src/domain/staff/ledger.ts` (per-writer hash chain: `LEDGER_GENESIS`, entry digest, replay from genesis, head at line ~253-276) and `validate.ts` ParsedEntry result type:
```typescript
export type ParsedEntry = { ok: true; event: ImplementedTeamEvent } | { ok: false; rejection: Rejection };
```
Use discriminated `{ok:true,...} | {ok:false, reason, message}` for classification results (admitted, held, quarantined, rejected). Equivocation has no true analog; build per RESEARCH (two signed headers, same writer/stream/seq, different hash; proof checkable alone).

### `src/domain/replica/order.ts`, `fold.ts`, `reducers.ts`, `digest.ts`
**Analog:** `src/domain/team/materialize.ts` (`reduce`, `applyEntry`): pure fold of validated entries into state, with a seeded reference test. Follow its shape: single `fold(admitted, ctx)` entry point, `ctx` injects `now`, `RosterView`, `BlobLookup`; no clock reads. Sort by `(lamport, writer, seq)` after the lamport rule; Kahn algorithm as test reference only (RESEARCH).

### `src/domain/replica/rosterView.ts`
**Analog:** `src/domain/team/keyStatus.ts` `KeyStatusLookup` (an injected function type); the interface and test roster are specified in RESEARCH lines ~345-365 (`hasRoster`, `writerKey`, `hasRole`, `roleWithdrawnBy`, `chosenBranch`, `checkpointSigner`, `productOwner`). Copy that interface unchanged so Phase 31 swaps it in.

### `src/domain/replica/doc.ts` (CRDT adapter, only file loading Yjs)
**Analog:** `src/mcp/client.ts` lines 75-85 (lazy `require` of a vendored bundle):
```typescript
function loadSdk(): Sdk {
  if (!sdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sdk = require(path.join(__dirname, '..', '..', 'vendor', 'mcp', 'mcp-client.cjs')) as Sdk;
    } catch (error) {
      throw new ToolError(`The MCP client is missing from this installation (${(error as Error).message}).`);
    }
  }
  return sdk;
}
```
Replica version: three levels up (`dist/domain/replica/doc.js` to repo `vendor/yjs/yjs.cjs`), types via `import type * as YTypes from 'yjs'; ... as typeof YTypes` (RESEARCH Vendoring step 2). Keep `doc.ts` out of modules the hub needs (`entry`, `kinds`, `verify`, `chain`, `equivocation`, `checkpoint`, `transport`, `order`).

### `src/domain/replica/versions.ts`, `decisions.ts`
**Analog:** `src/domain/staff/release.ts` (reuse, not copy; its tests unchanged).
**Reuse surface:** `RELEASE_STATES` (line 11), `HUMAN_ONLY_EVENTS = ['approve','reject','release','supersede']` (line 24), `transition(record, event, actor)` (line 231), `startProduct` (215), `isNamedPerson` (178), `PRODUCT_HASH_PATTERN` (40), `RELEASE_REFUSALS` closed map (116), `RELEASE_TRANSITIONS` table-as-data (147).
```typescript
export function isNamedPerson(actor: StaffActor): actor is PersonActor {
  return actor.kind === 'person' && isOneLine(actor.name, 120) && isOneLine(actor.role, MAX_ROLE) && isOneLine(actor.deviceFingerprint, 200);
}
```
Adapter rules in RESEARCH lines ~394-399: roster decides authority first; person passed as `{kind:'person',...}` only for approve/reject/release/supersede; never map an agent to a person; test `agent-cannot-decide` independently. `decisions.ts` is pure and does not import `release.ts`. Hash: `productHash` at `src/domain/staff/ledger.ts:190-193` is the construction to mirror in `replicaVersionHash`.

### `scripts/vendor-libs.mjs`, `scripts/entries/yjs.mjs`
**Analog:** same file lines 36-51 (`bundle(entry, target, file, main)` using esbuild, writes LICENSES.txt, pushes `manifest` rows incl. `bundledIn`):
```javascript
await bundle(path.join(root, 'scripts', 'entries', 'mcp-client.mjs'), 'mcp', 'mcp-client.cjs', '@modelcontextprotocol/sdk');
```
Add `await bundle(path.join(root, 'scripts', 'entries', 'yjs.mjs'), 'yjs', 'yjs.cjs', 'yjs');`. Entry file contains `export * from 'yjs';`. `compile` script (package.json:1088) already runs this before `tsc`. SBOM picks up rows with no script change. Pin `yjs` 13.6.33, `lib0` 0.2.119 (not 0.2.120, two-week rule) as exact devDependencies.

### `scripts/crdt-vendor.json`, `src/test/replicaVendor.test.ts`, `scripts/verify-release-content.mjs`
**Analog:** `media/vendor/VENDORED.json` (fields `name`, `version`, `license`, `licenseFile`, `integrity`, `from`, `why`, plus `files` hash map) and `src/test/staffCopSymbols.test.ts:80-83`:
```typescript
const vendored = JSON.parse(readFileSync(path.join(VENDOR, 'VENDORED.json'), 'utf8')) as { packages: Array<{...}>; files: Record<string, string> };
assert.equal(createHash('sha256').update(readFileSync(path.join(VENDOR, file))).digest('hex'), hash, `${file} is unchanged`);
```
Do NOT add rows to `VENDORED.json` (that test asserts its exact package list). In `verify-release-content.mjs` add `'extension/vendor/yjs/yjs.cjs'` and `'extension/vendor/yjs/LICENSES.txt'` next to lines 87-88 and a hash check modelled on its VENDORED.json check (~line 170).

### `src/test/replicaBoundaries.test.ts` (and boundary rule)
**Analog:** `src/test/teamBoundaries.test.ts` (`importsOf`, `RULES`, `boundaryViolations`, `sourcesUnder`).
Rule shape (lines 66-70):
```typescript
[DOMAIN_STAFF]: { name: 'src/domain/staff', allows: (target) => under(target, 'domain') },
```
**Trap:** `boundaryViolations` (lines ~80-84) picks the folder with a ternary chain that falls through to `TEAM` for unknown prefixes, so a file under `domain/replica/` would be judged by the wrong rule. Either add a `DOMAIN_REPLICA` branch there (editing this existing test, allowed only as an additive rule) or, safer, write a separate `replicaBoundaries.test.ts` importing `importsOf` (exported) and its own rule: `vscode` refused; Node builtins allowed; relative imports allowed under `domain`; the single permitted non-relative form is `import type ... from 'yjs'` in `doc.ts`; hub-bound modules may not import `doc.ts`.

### `src/test/replica*.test.ts`
**Analog:** `src/test/teamSignedPayload.test.ts` (node:test + assert/strict, keys generated at runtime, no key literals; imports `mulberry32` and builders from `./helpers/teamEvents`). Header:
```typescript
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import test from 'node:test';
```
Property tests: reuse `mulberry32` seeded PRNG from `src/test/helpers/teamEvents` (D-28 says write one in the test; importing the existing helper is lighter, planner choice), print the seed on failure, bounded cases.

## Shared Patterns

### Closed reason maps with plain messages
**Source:** `signedPayload.ts` `PAYLOAD_FAILURES` (lines 56-67), `release.ts` `RELEASE_REFUSALS`. **Apply to:** verify, chain, fold, decisions. `as const` map plus `keyof typeof` reason type; no em-dashes.

### Never-throw verification on hostile input
**Source:** `signedPayload.ts` `verifyPayload` (lines 134-141): wrap `check()` in try/catch returning `refuse('malformed')`. **Apply to:** every verify/classify entry point.

### Canonical bytes for every hashed or signed value
**Source:** `src/domain/team/canonical.ts` `canonicalBytes` (71), `canonicalize` (67), `fingerprintOf` (95), `isStrictBase64url` (100), `verifySignature` (108). Whole numbers only; MAX_DEPTH 16.

### Purity and boundaries
No `vscode`, only `node:crypto` I/O, no clock reads (`now` injected). Enforced by the new replica boundary test.

### Verification cadence
Per D-29: touched test files per task; full suite once at phase end under the `systemd-run ... MemoryMax=6G` wrapper inside `flock`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/domain/replica/transport.ts` | model | pub-sub | Types-only interface; follow DESIGN section 9 and RESEARCH, no existing transport interface |
| `test/fixtures/replica/vectors.json` | fixture | n/a | No existing cross-phase canonical vector file; generate from fixed keys in a test and commit |
| `equivocation.ts` / `attribution.ts` | service | transform | Only partial analogs (ledger fork detection, reducer style); use RESEARCH algorithms |

## Metadata

**Analog search scope:** `src/domain/team`, `src/domain/staff`, `src/mcp`, `src/test`, `scripts`, `media/vendor`
**Files scanned:** about 20 read or grepped
**Pattern extraction date:** 2026-11-19

# Phase 33: Live multi-user staff projects - Pattern Map

**Mapped:** 2026-11-21
**Files analyzed:** about 45 new or changed (from the RESEARCH work breakdown, plans 33-01 to 33-14)
**Analogs found:** 18 of 20 new-file groups (2 have only partial analogs)

All analog paths below are git-tracked source in the worktree (checked with `git ls-files` for the representative ones: `hubSync.ts`, `replicaWorld.ts`, `staffMultiUserManifest.test.ts`, `architecture-baseline.json`, `hubProcess.ts`). Line numbers are from the worktree as read this session. D-01 still applies: each plan re-reads the names before using them.

## Constraints that bind every modified file (architecture baseline)

Source: `src/test/architecture.test.ts` (rules at lines 188-231, 261) and `src/test/architecture-baseline.json`.

- Frozen files (above 1,200 lines at record time) may not grow by one line: `agent/commandSafety.ts`, `agent/gateAdapter.ts`, `agent/teamTemplateHistory.ts`, `services/agentSession.ts`, `services/chat.ts`, `services/nearAiClient.ts`, `services/teamStudioPage.ts`, `staff/replica/membership.ts`, `staff/replica/store.ts` (1673), `staff/staffHost.ts` (1688). Net-zero edits only; otherwise move the changed part out first. This is why `versionActs.ts` is new (D-41) and why 33-05 edits `store.ts` at net zero.
- `staff/replica/replicaProject.ts` is 1173 lines, so it is NOT frozen, but a new file above 1,200 fails and above 800 warns. The 33-02 cap of 25 changed lines keeps it under 1,200. Any file that crosses 1,200 in this phase fails the test.
- New files: under 800 lines to avoid a warning. `hubSync.ts` is 509 and `doc.ts` is 397, so `doc.ts` has room for the editor additions but keep them small.
- Rules in the baseline: `vscode-below-editor`, `upward-import`, `folder-cycle`, `scale-presets`, `get-configuration`. So: `vscode` only in `src/services` (editor layer), never in `src/domain` or `src/staff`; `getConfiguration` only in `services/settings.ts`; no import of `SCALE_PRESETS` outside `domain/gate`; no folder cycles among engine folders (`src/staff/replica` may import `src/domain/replica`, not the reverse).
- The baseline can only shrink. Run `NEAR_AI_WRITE_BASELINE=1` only as a reviewed diff at 33-14. `NEAR_AI_BASELINE_TIGHT=1` is enforced at phase close.
- Hub boundary: `hub/src` may import only the `HUB_SIDE` list in `src/test/replicaBoundaries.test.ts` and what those modules import (`hub/test/helpers/closure.ts`, lines 1-12). New hub-side domain files (`features.ts`) must be added to `HUB_SIDE` and use no Yjs, no fold, no vscode.
- `hubSync.ts` header (lines 1-4): no editor API and no Yjs, so hub tests can bundle it with `memoryReplica`. The new `liveReplicator.ts` and `syncMachine.ts` keep that property for the sync half.

## File Classification

| New or modified file | Role | Data flow | Closest analog | Match |
|----------------------|------|-----------|----------------|-------|
| `src/domain/replica/syncMachine.ts` | model (pure state machine) | event-driven | `src/staff/replica/hubSync.ts` end states (lines 12-19, 104) plus `src/domain/replica/hubWitness.ts` | role-match |
| `src/staff/replica/liveReplicator.ts` | service | event-driven, request-response | `src/staff/replica/hubSync.ts` (`syncOnce`, 187) + `hub/src/live/events.ts` | role-match |
| `src/staff/replica/productFeed.ts`, `productEditing.ts` | service | streaming (accepted update bytes) | `src/staff/replica/replicaProject.ts` (`state()`, `context()`, `syncLocalOf`) | role-match |
| `src/staff/replica/liveProjection.ts`, `compactor.ts` | service | transform, batch | `src/staff/replica/projection.ts` | exact (projection), role-match |
| `src/staff/replica/hubAddress.ts` | utility/store | CRUD | `hubMemoryOf` in `hubSync.ts` (90) + `hubMembership.ts` | role-match |
| `src/domain/replica/doc.ts` (changed) | utility (CRDT) | transform | itself: `localUpdate`, `createLocalDoc`, `applyRemote` (85-121) | exact |
| `src/staff/replica/editorBinding.ts` | service (binding core, no vscode) | event-driven | `doc.ts` local doc helpers; external pattern y-monaco, y-codemirror.next (RESEARCH sources) | partial |
| `src/services/staffEditorBinding.ts` | component (VS Code adapter) | event-driven | `src/services/staffRoomPanel.ts`, `src/services/gateStatusBar.ts` | role-match |
| `src/staff/replica/versionActs.ts` | service | CRUD (signed entries) | `src/staff/replica/membership.ts` write flows (frozen, read only) | role-match |
| `src/staff/replica/contested.ts` | model (read model) | transform | `src/domain/staff/readModels.ts`, `src/domain/replica/rosterView.ts` | role-match |
| `src/domain/replica/features.ts`, `kinds.ts`, `kindSchemas/roster.ts`, `roster.ts` (changed) | model | request-response (validate) | `kinds.ts` `KINDS_BY_FAMILY` (line 20) + `validateRosterData` | exact |
| `src/staff/replica/requireGate.ts` | middleware (guard) | request-response | `hub/src/append/checks.ts` `APPEND_REFUSALS` and `checkBatch` (37, 205) | role-match |
| `src/domain/replica/presence.ts`, `src/staff/replica/livePresence.ts` | model, service | pub-sub | `hub/src/live/presence.ts` (hub side, opaque bytes) | role-match |
| `src/services/staffPresenceView.ts` | component | event-driven | `src/services/gateStatusBar.ts` | partial |
| `src/domain/staff/staffRoomLive.ts` | model (page model) | transform | `src/domain/staff/staffRoom.ts` (pure, no vscode, time passed in) | exact |
| `media/staffRoom/staffLive.js` | component (page script) | event-driven | `media/staffRoom/staffRoom.js` | exact |
| `src/services/staffShare.ts`, `staffHubCommands.ts` | controller (commands), setup step | request-response | `src/services/staffMultiUserCommands.ts`, `src/services/setupSteps.ts` | exact |
| `hub/src/restore.ts`, `hub/src/main.ts`, `hub/src/stateDir.ts` (changed) | service | batch | `hub/test/restoreDrill.test.ts` for expected behavior; `hub/src/stateDir.ts`, `main.ts` | role-match |
| `hub/src/append/checks.ts`, `http/routes.ts`, `http/session.ts` (changed, `needs-update`, `blob-missing` per entry) | middleware | request-response | same files | exact |
| `hub/src/join.ts`, `limits.ts` (changed, IN-06) | service | request-response | same files | exact |
| `src/test/helpers/liveWorld.ts` | test helper | request-response | `src/test/helpers/replicaWorld.ts`, `replicaRosterWorld.ts` | exact |
| `src/test/helpers/hubChild.ts` | test helper (child process) | event-driven | `hub/test/helpers/hubProcess.ts` | exact |
| `src/test/staffLiveTracer.test.ts`, scenarios, docs tests | test | request-response | `src/test/staffMultiUserManifest.test.ts`, `hub/test/clientSync.test.ts` | role-match |

## Pattern Assignments

### `src/domain/replica/syncMachine.ts` (model, event-driven)

**Analog:** `src/staff/replica/hubSync.ts` (lines 12-19) for the vocabulary the machine maps from.

End states to map into the nine live states (do not invent new refusal words; reuse these):
```typescript
//   synced     the exchange finished and the hub showed nothing that needs a person
//   offline    the hub could not be reached, the connection was lost, or the hub asked to wait (retryAfterSeconds)
//   refused    the hub does not accept this device (reason: not-admitted, quarantined, revoked and the rest of the hub's list)
//   attention  a person must act: the certificate pin or CA did not match, the hub named another hub or project, rolled back or showed a fork
```
`export type SyncOutcome = 'synced' | 'offline' | 'refused' | 'attention';` (line 104). Keep the machine pure: events in, state out, no clock (time passed in), no I/O, so it lives in `domain/replica` and is hub-bundle safe. Test it table-style like `src/test/architecture.test.ts` "has teeth" cases (state, event, expected state).

### `src/staff/replica/liveReplicator.ts` (service, event-driven)

**Analog:** `src/staff/replica/hubSync.ts`.

**Imports pattern** (lines 18-29): relative imports into `../../domain/replica/*`, `import type` for types, `node:` prefixed built-ins, transport types from `./hubTransport`.
```typescript
import { createHash } from 'node:crypto';
import { readCheckpoint, verifyCheckpoint } from '../../domain/replica/checkpoint';
import type { HubFinding, WitnessResult, WitnessState } from '../../domain/replica/hubWitness';
import type { HeadSet } from '../../domain/replica/transport';
import { CHECKPOINTS_PER_ASK, HUB_TRANSPORT_FAILURES, HubTransportError, appendBatches, pushPlan } from './hubTransport';
import type { HubTransport, HubTransportFailure } from './hubTransport';
```
**Core pattern:** the replicator never reimplements an exchange. On a `heads` event it calls `syncOnce(transport, local, memory, options)` (line 187) and maps `SyncReport` to a machine event. `SyncLocal` (line 33) is the only surface it needs of the replica: `project`, `writer`, `roster()`, `heads()`. `SyncTransport` (line 143) is a `Pick<HubTransport, ...>`; add `postPresence` to the real transport only (33-06) and extend the `Pick` rather than widening the type. Tests use the fake transport (`src/test/helpers/replicaFakeTransport.ts`) for the fold half and `hub/test/helpers/memoryReplica.ts` for the hub half.
**Event source:** `hub/src/live/events.ts` (hub side of the event stream) and `hub/test/helpers/sseReader.ts` (reading it in tests).

### `src/staff/replica/productFeed.ts` and `productEditing.ts` (service, streaming)

**Analog:** `src/staff/replica/replicaProject.ts` (`project.state()`, `project.context()`, `syncLocalOf`; it imports the types from `hubSync.ts`, never the reverse, line 3 of the `hubSync.ts` header). Accepted update bytes come from `state()`; verify with `verifyEntry(raw, project.context())` from `src/domain/replica/verify.ts`. Do not edit `replicaProject.ts` beyond the 25 lines granted to 33-02.

### `src/domain/replica/doc.ts` (changed: stable origin, update capture, observer)

**Analog:** itself, lines 85-121. The current capture uses a fresh `{ local: true }` origin per call:
```typescript
function localUpdate(doc: CrdtDoc, run: () => void): Uint8Array {
  const Y = loadYjs();
  const origin = { local: true };
  const produced: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array, from: unknown): void => { if (from === origin) produced.push(update); };
  doc.on('update', onUpdate);
  try { doc.transact(run, origin); } finally { doc.off('update', onUpdate); }
  return produced.length === 0 ? new Uint8Array(0) : Y.mergeUpdates(produced);
}
```
Remote application goes through `applyRemote(doc, bytes)` (118), which uses the `REMOTE` origin so it stays out of local capture. The echo guard in the binding core must use this same split: local origin captured, `REMOTE` ignored. Every decode of outside bytes passes `applyWithin` (byte limit, `skimUpdate`, then Yjs); new additions must not add an unguarded `applyUpdate` path. Yjs is loaded with `loadYjs()` (vendored bundle), never imported directly (`VENDOR_FORM` in `closure.ts` guards this).

### `src/staff/replica/editorBinding.ts` and `src/services/staffEditorBinding.ts`

**Split:** binding core (no `vscode`, in `src/staff/replica`) plus adapter (`vscode`, in `src/services`), required by the `vscode-below-editor` rule. Core takes plain callbacks (`onLocalEdit(range, text)`, `applyToEditor(edits)`), holds the echo guard and `UndoManager`, and is tested with `src/test/helpers/fakeDom.ts` style fakes plus `vscodeStub.ts` for the adapter.
**Adapter analog:** `src/services/staffRoomPanel.ts` and `src/services/gateStatusBar.ts` for disposable registration and `vscode` use. Settings reads only through `src/services/settings.ts` (the `get-configuration` rule). Commands and `keybindings` are declared in `package.json` and checked by `src/test/staffMultiUserManifest.test.ts`.
**No in-repo analog for the Yjs-to-text-editor binding.** Use the external pattern named in RESEARCH (y-monaco, y-codemirror.next, MIT) and cite it in the plan.

### `src/domain/replica/features.ts`, `kinds.ts`, `kindSchemas/roster.ts`, `roster.ts` (POST-01, `roster.require`)

**Analog:** `src/domain/replica/kinds.ts` (lines 1-25). Add `roster.require` (and `hub.readmit` if confirmed) to the roster family list and its schema through `validateRosterData`:
```typescript
const KINDS_BY_FAMILY = {
  project: ['project.genesis', 'project.import'],
  roster: ['member.invite', ..., 'lead.handover', 'roster.choose', 'deputy.name', 'invite.void'],
  doc: ['doc.client', 'doc.update', 'doc.compact'],
```
Rules from the file header: an unknown kind from a newer client is kept and relayed and never changes state; a known kind with no schema is refused with `SCHEMA_PENDING` (fail closed). The kind count tests are in `src/test/replicaBoundaries.test.ts` and `replicaTracer.test.ts`; update the counts in the same plan. New hub-side file `features.ts` goes on `HUB_SIDE`.

### `src/staff/replica/requireGate.ts` (guard) and the hub `needs-update` refusal

**Analog:** `hub/src/append/checks.ts`. Refusals are a closed table of user-readable sentences keyed by id, with `checkBatch` returning a typed outcome:
```typescript
export const APPEND_REFUSALS = {
  'blob-missing': 'An entry uses a large part the hub does not hold. Upload that part, then send the entries again.',
  'unknown-header-version': 'The entry was written in a newer format than this hub reads. Update the hub.',
  ...
} as const;
export type AppendRefusal = keyof typeof APPEND_REFUSALS;
export type CheckOutcome = { ok: true; checked: CheckedBatch } | { ok: false; reason: AppendRefusal; message: string; retryAfterSeconds?: number };
```
Add `needs-update` as a new key in this table (sentence in user words, no em-dash), and mirror the id in the client mapping in `hubSync.ts` / `hubTransport.ts` (`HUB_TRANSPORT_FAILURES`). Per-entry `blob-missing` extends `CheckedEntry`/`Refused` (lines 83-99) rather than a new outcome shape.

### `src/domain/replica/presence.ts` (seal, open, schema), `livePresence.ts`

**Analog (hub side):** `hub/src/live/presence.ts` header (lines 1-8, `PRESENCE_TIMING`): the hub stores only opaque sealed bytes per device per cell, 5 s heartbeat, 30 s TTL, 250 ms coalesce, memory only, frame sent to the access list without the sender's own entry. The Phase 33 plaintext (name, cursor, cell) is sealed under the cell key client-side; the hub must never see labels (leak test `hub/test/liveLeak.test.ts`, model on `hub/test/ciphertextOnly.test.ts`). Reuse the `PRESENCE_TIMING` numbers; do not redefine them.

### `src/domain/staff/staffRoomLive.ts` and `media/staffRoom/staffLive.js`

**Analog:** `src/domain/staff/staffRoom.ts` (header lines 1-5): pure, no I/O, no clock (time passed in), no `vscode`; "The page lays this out and animates it; it never decides state"; a person decision goes back as a message naming the product and the version hash seen, and the host runs the person-only command (`PERSON_DECISION_COMMANDS`, `STAFF_COMMANDS` from `./commands`). Imports are `./`-relative within `domain/staff`. Page script analog is `media/staffRoom/staffRoom.js` (same folder, with `staffMap.js` and `staffWorkspaces.js` as sibling scripts); tests use `src/test/helpers/fakeDom.ts` and `staffRoomFixture.ts`. The message union change in `staffRoom.ts` is the only edit to that file (33-11); `decisionCommand` only in 33-04.

### `src/services/staffShare.ts`, `staffHubCommands.ts` (setup step and commands)

**Setup step analog:** `src/services/setupSteps.ts` lines 77-84:
```typescript
export const PROJECT_TEAM_STEP: SetupStep = {
  id: 'project-team',
  label: 'Set up your project team',
  detail: '...',
  icon: 'organization',
  command: 'nearAi.setupProjectTeam',
  isDone: (ctx) => projectHasTeam(ctx.root)
};
```
`isDone` reads `ctx.setting(...)` or `ctx.root`, never `getConfiguration`. The picker rows are built at lines 172-174 (todo list, done list with a check icon, `START_CHATTING` last); a new step must be added to the list the picker builds, and the step id and command must appear in `package.json`.
**Commands analog:** `src/services/staffMultiUserCommands.ts` (header lines 1-18): thin handlers that ask with standard dialogs, call one host flow, show the flow's sentence with the multi-user notices (D-13); every command registered always and hidden by `when` until its setting is on; handlers re-check the setting at run time; replica modules are loaded inside the handlers only (Pitfall 8), and no line of this file imports from `src/staff/replica` at top level. Follow the same lazy-load rule in `staffHubCommands.ts`. None of these commands may be in `PERSON_DECISION_COMMANDS` and no agent tool may run a VS Code command (D-37). The manifest test `src/test/staffMultiUserManifest.test.ts` checks every command id, its `when` clause, and activation; extend it for each new command (33-09). Copy words from `term()` (`src/domain/org/terms.ts`) and the glossary; copy lint is `src/test/copyLint.test.ts` and its baseline can only shrink.

### `hub/src/restore.ts`, `main.ts`, `stateDir.ts` (restore mode)

**No existing `restore.ts`** (new file). Expected behavior is pinned by `hub/test/restoreDrill.test.ts` and `hub/test/killDrill.test.ts`; start-up flow analog is `hub/src/startup.ts`, `hub/src/main.ts`, `hub/src/stateDir.ts`. A `restoring` mode with a marker file in the state directory is new state: add it to the start-up state table and log through `hub/src/log` (see `hub/test/logging.test.ts` for what may never be logged). Client mapping of `restoring` and `needs-update` goes into `hubSync.ts` / `hubTransport.ts` (33-06 owns both).

### Test helpers

**`src/test/helpers/liveWorld.ts`**
**Analog:** `src/test/helpers/replicaWorld.ts` (lines 1-12 header and imports): "No key literal lives in any file: every key is derived from a label"; "plans that need more helpers add their own helper file rather than editing this one". So `liveWorld.ts` is a new file that imports `rng`, `fixedSigner`, `epochKey` from `replicaWorld`, builds two or three devices with separate stores and keys, and does not edit `replicaWorld.ts`. For roster setup also see `replicaRosterWorld.ts`.
```typescript
import { createLocalDoc, localDelete, localInsert } from '../../domain/replica/doc';
import { GENESIS_PREV, buildEntry, writerIdOf } from '../../domain/replica/entry';
import { staticRosterView } from '../../domain/replica/rosterView';
```

**`src/test/helpers/hubChild.ts`**
**Analog:** `hub/test/helpers/hubProcess.ts` (lines 1-35): spawns the built hub `dist/bin.mjs`, four 0600 secret files, temporary state directory, `HUB_PORT=0` so parallel runs never collide, environment of only `PATH` and `HOME`, `startHubProcess` waits for the `hub.listening` log line and returns the bound port, `hubRoot()` finds the workspace by `package.json` name `near-ai-hub`. `hubChild.ts` should import or re-export these (extension tests may need a relative path into `hub/test/helpers`; check `src/test/replicaBoundaries.test.ts` first for any rule against importing hub test code) and use `tlsFixture.ts` for the certificate pin. Fork-target style (a file with no `.test` suffix so the glob does not run it, starts only as entry point) is shown in `src/test/helpers/replicaStoreChild.ts` lines 1-6. Fallback when Node 26 is missing: in-process hub from `hub/test/helpers/hubHarness.ts` and `hubWorld.ts` (per RESEARCH 33-01).
Secret storage for two processes sharing one install: `FileSecrets` in `replicaStoreChild.ts` (lines 18-36), JSON file written by temporary file and rename.

## Shared Patterns

### Words and copy
**Source:** `src/domain/org/terms.ts` `term()`, `.planning/research/coherence/GLOSSARY.md`, `src/test/copyLint.test.ts`.
**Apply to:** every new user-visible string (commands, hub refusals, status word, cards). "Your organization's server", "agent team" and "work team" never a bare "team", no em-dashes, the copy-lint baseline only shrinks.

### Layering
**Source:** `src/test/architecture.test.ts` rules and `architectureScan.ts`.
**Apply to:** all new files. Pure logic in `src/domain/...`; Node I/O in `src/staff/...`; `vscode` only in `src/services/...`; settings through `services/settings.ts`.

### Hub-bundle safety
**Source:** `hub/test/helpers/closure.ts` and `src/test/replicaBoundaries.test.ts` `HUB_SIDE`.
**Apply to:** `features.ts`, `syncMachine.ts` (if the hub bundles it), `presence.ts` seal and open (if hub-tested): no Yjs, no vscode, no fold imports.

### Refusal tables as closed id-to-sentence maps
**Source:** `hub/src/append/checks.ts` lines 37-61, `HUB_TRANSPORT_FAILURES` in `hubTransport.ts`.
**Apply to:** `needs-update`, `restoring`, join cap refusal (IN-06), the client retry refusal text. Add the id in both tables and test the pairing.

### Lazy replica loading behind commands
**Source:** `src/services/staffMultiUserCommands.ts` header lines 5-8.
**Apply to:** `staffHubCommands.ts`, `staffShare.ts`, `staffEditorBinding.ts` activation path.

## No Analog Found

| File | Role | Data flow | Reason |
|------|------|-----------|--------|
| `src/staff/replica/editorBinding.ts` and its adapter's text-sync half | binding | event-driven | No existing Yjs-to-editor binding; use y-monaco and y-codemirror.next patterns from RESEARCH sources (MIT), and `doc.ts` local capture for the core |
| `hub/src/restore.ts` | service | batch | No restore code in `hub/src`, only drills in `hub/test/restoreDrill.test.ts` that define expected behavior |

## Metadata

**Analog search scope:** `src/domain/replica`, `src/staff/replica`, `src/domain/staff`, `src/services`, `hub/src`, `hub/test/helpers`, `src/test/helpers`, `media/staffRoom`.
**Files read or sampled:** about 14 (header and excerpt reads, not full files).
**Pattern extraction date:** 2026-11-21

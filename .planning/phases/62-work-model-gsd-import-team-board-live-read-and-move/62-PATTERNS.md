# Phase 62: Work model, GSD import, Team Board - Pattern Map

**Mapped:** 2026-11-02
**Files analyzed:** 22 (13 new, 9 modified)
**Analogs found:** 21 / 22 (all analog paths verified git-tracked; no gitignored mirrors involved)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/domain/team/types.ts` (mod) | model | transform | itself (`ImplementedEventBodies`, `IMPLEMENTED_EVENT_TYPES`, `TEAM_REJECTION_REASONS`) | exact |
| `src/domain/team/validate.ts` (mod, 8 item validators) | validator | transform | `BODY_VALIDATORS` entries, lines 235-282 | exact |
| `src/domain/team/materialize.ts` (mod: applyTransition, referenceProblem, parseWorkItem) | reducer | event-driven | `applyTransition` (line 284) and `releaseHeldWork` (~line 260) | exact |
| `src/domain/team/permissions.ts` (mod: `item.move`, `actionForEvent(event, state?)`) | policy | request-response | itself, lines 165-193 | exact |
| `src/domain/team/work.ts` (new: readiness, effectiveColumn, transitionProblem, progress) | utility | transform | `src/domain/team/policy.ts` (pure, exported validators) | role-match |
| `src/domain/team/gsdImport.ts` (new) | utility/parser | transform | `src/domain/team/invite.ts` / `validate.ts` (hostile-input, no spread) | role-match |
| `src/domain/team/board.ts` (new: buildBoardModel, planMove) | utility | transform | `src/services/activityOverview.ts` (pure model for a webview) | role-match |
| `src/team/integrationSource.ts` (new) | service | file-I/O (git) | `src/team/runGit.ts` + `gitTransport.ts` (`blobSizes`, cat-file) | role-match |
| `src/team/importPlans.ts` (new) | service | CRUD (CAS append) | `src/team/eventLog.ts` `TeamLog.append` callers (`remove.ts`, `invite.ts`) | role-match |
| `src/services/team/boardView.ts` (new) | provider/controller | request-response + event-driven | `src/services/toolsPage.ts` (`attachToolsPage`) and `activityView.ts` (`activityHtml`, `lastJson`, `activityTap`) | exact |
| `src/services/team/teamSession.ts` (mod: onStateChange, setBoardVisible, auto-import) | service | event-driven | itself, `syncOnce` lines 355-402 | exact |
| `src/services/team/teamStatusBar.ts` (mod) | adapter | request-response | itself, `statusText`/`TeamStatusExtras` | exact |
| `src/services/team/teamCommands.ts` (mod: openBoard, importPlans) | controller | request-response | itself, lines 295-296 (`guarded(...)` registration) | exact |
| `package.json` (mod: view, commands, activation) | config | n/a | existing `nearAiChatView` view entry (line 257-265) | exact |
| `src/extension.ts` (mod) | wiring | n/a | `registerAgentActivity` (line 9) and `registerWebviewViewProvider` (line 68) | role-match |
| `media/board/board.js` (new) | component | event-driven | `media/activity/activity.js` | exact |
| `media/board/board.css` (new) | style | n/a | `media/activity/activity.css`, `media/tools/tools.css` | exact |
| `scripts/verify-release-content.mjs` (mod) | config | n/a | its `required` list (~lines 65-99) | exact |
| `src/test/teamItems*.test.ts` (new: events, state machine, permissions) | test | event-driven | `src/test/teamLog.test.ts` + `helpers/teamEvents.ts` | exact |
| `src/test/teamGsdImport.test.ts`, `teamImportPlans.test.ts` (new) | test | file-I/O | `src/test/teamLog.test.ts` (real bare remote, two clients) | role-match |
| `src/test/teamBoard*.test.ts`, `boardPage.test.ts` (new) | test | transform | `src/test/toolsPage.test.ts` (`node:vm` over `media/tools/tools.js`) | exact |
| `src/test/e2e/suite.ts` (mod) | test | request-response | its "registers every contributed command" case (line 49-55) | exact |
| Existing tests to update: `teamValidate.test.ts:101,232`, `teamSession.test.ts:226,319`, `teamSessionMembers.test.ts:236-290`, `teamPermissions.test.ts:~101`, `teamManifest.test.ts:~38`, `teamSoloParity.test.ts` | test | n/a | themselves | exact |

## Pattern Assignments

### `src/domain/team/validate.ts` (validators, transform)

**Analog:** same file, `BODY_VALIDATORS` (lines 235-282).

**Imports/header pattern** (lines 1-8): pure, no I/O, no vscode, no spread of parsed input.
```typescript
import { MAX_EVENT_BYTES, canonicalize, eventPath, ... } from './canonical';
import { AVAILABILITIES, IMPLEMENTED_EVENT_TYPES, INVITABLE_ROLES, ROLES, TEAM_REJECTION_REASONS } from './types';
export type Fields = Record<string, unknown>;
```

**Core pattern** (exact keys, first failure wins via `??` chain, optional keys via `has`/`hasOwnProperty`):
```typescript
type BodyValidator = (body: Fields) => string | undefined;
const BODY_VALIDATORS: Record<ImplementedEventType, BodyValidator> = {
  'member.skills': (body) => checkKeys(body, 'body', ['memberId', 'skills'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateSkills(body.skills, 'body.skills'),
  'member.availability': (body) => checkKeys(body, 'body', ['availability'], ['workingHours'])
    ?? validateChoice(body.availability, AVAILABILITIES, 'body.availability')
    ?? (Object.prototype.hasOwnProperty.call(body, 'workingHours') ? validateWorkingHours(body.workingHours, 'body.workingHours') : undefined),
```
Add the 8 `item.*` entries here (`Record<ImplementedEventType,...>` makes the compile fail until all are added: keep that guard). Reuse `invalid`, `child`, `checkKeys`, `isRecord`, `isSafeIntegerInRange`, `matches`, `validateName`; export `isRelativePosixPath` from `policy.ts`. Reasons are `invalid('body.field')`; new fixed reasons go in `TEAM_REJECTION_REASONS` (types.ts).

**Dispatch** (lines 289-295): `validateBody` returns `TEAM_REJECTION_REASONS.unsupported` for types not in `IMPLEMENTED_EVENT_TYPES`; item types become implemented by adding them to `IMPLEMENTED_EVENT_TYPES` (types.ts:41) and `ImplementedEventBodies`.

### `src/domain/team/materialize.ts` (reducer, event-driven)

**Analog:** same file `applyTransition` switch (line 284) with `memberOf(state, id)` helper and per-case in-place mutation:
```typescript
function applyTransition(state: TeamState, event: ImplementedTeamEvent, commitTime: number): void {
  switch (event.type) {
    case 'member.role-changed': {
      const member = memberOf(state, event.body.memberId);
      member.role = event.body.role;
      delete member.pendingRole;
      return;
    }
```
Item cases mutate `state.items` the same way. Reference checks ("parent exists", "target exists", `transitionProblem`) belong in `referenceProblem` (D-09 step 7), so rejection happens on read as well as write. `releaseHeldWork` (lines ~262-275) shows how stored `ready` is treated (`item.state = 'ready'`); treat stored `ready`/`backlog` as one unclaimed set. Also replace `emptyList(root.items, 'items')` in `deserialiseState` (~line 665) with a strict `parseWorkItem` (it has its own limits; `shortText` caps at 200 chars, too small for must-haves).

### `src/domain/team/permissions.ts` (policy)

**Analog:** same file. Matrix rows (lines 44-48) and `actionForEvent` (lines 177-193):
```typescript
export function actionForEvent(event: ImplementedTeamEvent): TeamAction | undefined {
  switch (event.type) {
    case 'member.invited': return { kind: 'member.invite' };
    case 'device.revoked': return { kind: 'device.revoke', memberId: event.body.memberId };
    case 'snapshot.written': return { kind: 'snapshot.write' };
```
Add `'item.move': MANAGERS` row plus `ACTION_LABELS` entry, and give `actionForEvent` an optional `state` argument so `ownDraft` can be computed (`'own-draft'` rule is evaluated as `'ownDraft' in action && action.ownDraft`). Update `teamPermissions.test.ts` kinds count (28 to 29) and the per-kind table row.

### `src/domain/team/work.ts` and `board.ts` (new, pure)

No exact analog. Follow `permissions.ts`/`policy.ts` style: pure functions, no `vscode`, no wall clock (pass `nowMs` in), integer math. Use the `readiness()` and `planMove()` sketches in 62-RESEARCH.md (lines 364-387, Pattern 7). Pure webview model precedent: `src/services/activityOverview.ts` (`buildWindowSummary`, `nowRows`) and `overviewMessage` in `activityView.ts`.

### `src/domain/team/gsdImport.ts` (parser)

Analog for style only: `validate.ts` header rules (own-property checks, `Object.create(null)`/Maps, never spread parsed input). Implement the targeted frontmatter reader from RESEARCH.md Pattern 1-3 (identity from file name, orphan plans skipped, size/line/list caps). No project analog parses YAML; existing GSD reading code lives under `src/services/gsd*` (consumer of ROADMAP/STATE), but it works on the working tree and is not reusable for D-01.

### `src/team/integrationSource.ts` (git reads, file-I/O)

**Analog:** `src/team/runGit.ts` (`runGit`, array args, `GIT_TERMINAL_PROMPT=0`, `redactGitMessage`) and `src/team/gitTransport.ts` (`blobSizes` size-check before reading, `networkTarget`, `withMirrorLock`). Use commands from RESEARCH.md Pattern 5 (`fetch` into `refs/near-ai/integration/<branch>`, `rev-parse <ref>:.planning`, `ls-tree -r -z`, `cat-file --batch-check` then `--batch`). The ref is a parameter (tests pass `HEAD`; `main` does not contain the Phase 60-67 roadmap).

### `src/team/importPlans.ts` (service, CAS append)

**Analog:** `TeamLog.append` (src/team/eventLog.ts:250-258):
```typescript
public async append(intents: (state: TeamState) => EventIntent[] | { conflict: string }): Promise<AppendResult> {
  const signer = this.signer;
  if (signer === undefined) throw new NoDeviceKeyError();
  const result = await this.transport.append((state, head) => {
    const wanted = intents(state);
    return Array.isArray(wanted) ? prepareEvents(state, head, signer, wanted, this.now) : wanted;
  });
```
The builder is re-run on each CAS loss with fresh state, so diff graph against `state.items` inside it. Return `{ conflict: IMPORT_NOOP }` for no change (an empty array is refused by the transport). Sanitize per field before building intents (a must-have in `61-02-PLAN.md` trips `assertNoSecrets`); `prepareEvents` returns `{ conflict: R.tooLarge }` for an oversize item, so truncate first. Persist `{treeHash, sourceCommit}` using `writeFileAtomic`/`runSerialised` from `src/team/teamFile.ts`.

### `src/services/team/boardView.ts` (provider/controller)

**Analog 1:** `src/services/toolsPage.ts` `attachToolsPage` (lines 36-100): host interface abstraction for testability, generation counter, debounced `soon()`, validated messages, allow-list checks, error to `postMessage`.
```typescript
interface PageHost {
  webview: { postMessage(message: unknown): Thenable<boolean> | Promise<boolean>; onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void } };
  onDidDispose(listener: () => void): { dispose(): void };
  onDidChangeViewState?(listener: (event: { webviewPanel: { visible: boolean } }) => void): { dispose(): void };
}
...
host.webview.onDidReceiveMessage(async (value) => {
  const message = parseToolsPageMessage(value);
  if (!message) return;
  ...
  // Only a command the directory lists, so the page cannot put arbitrary text in the composer.
```
Copy: `parseBoardMessage(value)` (reject unknown shapes), host re-runs `planMove` inside `log.append(state => ...)` (webview is never trusted).

**Analog 2:** `src/services/activityView.ts` for post-only-on-change and visibility:
```typescript
export const activityTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void } = {};   // line 29: tests observe messages
const post = (message) => { activityTap.toView?.(message); void view.webview.postMessage(message); };      // line 141
const json = JSON.stringify({ ...message, now: 0 });
if (json === lastJson && !reload) return;                                                                  // lines 168-171
view.onDidChangeViewState((event) => { if (!event.webviewPanel.visible) stop(); }, undefined, context.subscriptions);  // line 200
```
Use a `boardTap` the same way and `setBoardVisible()` to drive the faster poll.

**CSP/HTML** (activityView.ts:292-296, 380):
```typescript
const nonce = randomBytes(16).toString('base64');
const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<script nonce="${nonce}" src="${asset('activity.js')}"></script>
```
Note: the sidebar view must use `getState/setState`, not `retainContextWhenHidden` (chat registers with it at extension.ts:68; do not copy). Solo-parity: lazy `import()` the board module (see Shared Patterns).

### `src/services/team/teamSession.ts` (mod)

**Analog:** same file. Hook points: `syncOnce` (lines 355-402) already runs `log.sync()`, `reactToMembers`, then `showStatus(status, extras)`; add `onStateChange(listener)` firing after sync and subscribe at transport `onUpdate` for history (events applied inside `appendExisting` reach listeners only there). Pending-count flows through `TeamStatusExtras`; add `ready` the same way. Scheduler hooks: `this.scheduler.nudge()` (line 283), `focusChanged(focused)` (line 288); add `setBoardVisible` beside it.
```typescript
const extras = await this.reactToMembers(synced && refused === undefined);
this.showStatus(status, extras);
```
Auto-import runs only when trusted (`refused === undefined`) and the viewer is owner/lead, gated by `git ls-remote` head compare.

### `src/services/team/teamStatusBar.ts` (mod)

**Analog:** same file. Extend `TeamStatusExtras { pending?; removed?; nearLabel?; nearLinked? }` with `ready?`, and change the `ok` branch:
```typescript
const pending = extras.pending ?? 0;
const suffix = pending > 0 ? ` (${pending} pending)` : '';
return { text: `Team: ${displayName(teamName)}${suffix}`, tooltip: ... };
```
to `Team: N ready · M pending`. Click command is set once: `item.command = VERIFY_LOG_COMMAND;` (createTeamStatusBar); D-17 wants `nearAi.team.openBoard` on ok. Keep `displayText`/`safeReason` for any teammate-authored string. Update pinned tests (teamSession.test.ts:226, teamSessionMembers.test.ts:236-290, teamManifest.test.ts:~38).

### `src/services/team/teamCommands.ts` (mod)

**Analog:** lines 295-296, registration inside `registerTeamMode` at activation (solo-safe, e2e requires every contributed command registered):
```typescript
vscode.commands.registerCommand(ENABLE_COMMAND, guarded('Enable Team Mode', enable)),
vscode.commands.registerCommand(VERIFY_LOG_COMMAND, guarded('Verify Team Log', verifyLog)),
...registerMemberCommands({ context, output, report, announce, soloText: SOLO_TEXT, firstFolder, session: () => slot.current(), ... })
```
Copy `memberCommands.ts` (`registerMemberCommands`, `session: () => slot.current()`, `soloText`) for `openBoard`/`importPlans`; solo returns `SOLO_TEXT`-style guidance (Phase 60 D-24).

### `media/board/board.js` (webview client)

**Analog:** `media/activity/activity.js` (also `media/tools/tools.js`). IIFE, `acquireVsCodeApi()`, `textContent` only, in-place keyed row updates:
```javascript
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const button = (label, onClick, className, aria) => { const b = el('button', className || 'secondary', label); b.type = 'button'; if (aria) b.setAttribute('aria-label', aria); b.addEventListener('click', onClick); return b; };
  function syncRows(tbody, items, key, fill, update, tag) { /* keyed reuse by dataset.key */ }
```
Never `innerHTML` (titles, reasons, names are hostile). Keep logic in small pure functions so `node:vm` tests work.

### Tests

**Domain/log tests:** `src/test/teamLog.test.ts` (`clientFor`, `withFixture`, real bare remote, two clones) and `helpers/teamEvents.ts` (`makeActor`, `signed`, `addFixtureMember`, `entryOf`), `helpers/teamHarness.ts` (`createTeamFixture`, `gitIn`, `faultRunner`). Use for the two-clone item tracer, the two-lead import race, and the determinism property test.

**Webview client tests:** `src/test/toolsPage.test.ts` (reads `media/tools/tools.js` via `path.join(__dirname,'..','..','media','tools','tools.js')` and runs it in `node:vm` with a hand-rolled fake DOM); `src/test/activityView.test.ts` for `activityTap`-style host tests.

**E2E:** `src/test/e2e/suite.ts:49-55` asserts contributed commands are all registered; add board command and a live scenario (run with `env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js`).

## Shared Patterns

### Write path: permission then secret guard
**Source:** `decideTeamAction` (permissions.ts) via `prepareEvents` (eventLog.ts:96-106, evaluates against pre-batch state) then `assertNoSecrets` (secrets.ts). **Apply to:** importer, board create/edit/move. The New item form must write a single `item.created` that already carries the estimate (a same-batch `item.estimated` is evaluated against pre-batch state).

### Read path: same checks on read
**Source:** `actionForEvent` + `referenceProblem` in the materializer. **Apply to:** all item events so an invalid event from a hostile client is rejected like Phase 60 D-09.

### Solo parity (lazy loading)
**Source:** `src/test/teamSoloParity.test.ts` header and `loadedTeamModules`; `teamCommands.ts` header comment lines 1-4. Activation without `.planning/.near-ai/team.json` does one `fs.stat`, creates no timers, and loads only `teamCommands.js` and `memberCommands.js` from the team dirs. **Apply to:** `boardView.ts`, `work.ts`, `board.ts`, `importPlans.ts`: import via dynamic `import()` from the registered command/view resolution, or extend the allowlist deliberately in the test.

### Hostile text display
**Source:** `displayText`/`safeReason` (teamStatusBar.ts:20-37) for status bar and notifications; `textContent` in the webview. **Apply to:** every title, reason, member name, must-have.

### Product strings
No em-dashes in authored strings (enforced by `teamManifest.test.ts`); imported titles may contain them.

### Polling
**Source:** `SyncScheduler` (`nudge`, `focusChanged`; `DEFAULT_POLL_SECONDS = 15`, `UNFOCUSED_POLL_MS = 120_000`, `MIN_POLL_SECONDS = 5` in syncScheduler.ts:11-15). Do not add new timers.

### Frozen shapes
Once items exist, the WorkItem key set is part of the state hash (`STATE_HASH_VERSION = 1`); pin the shape and each event body with a test, as Phase 60 does for signed bodies.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| frontmatter/ROADMAP reader inside `gsdImport.ts` | parser | transform | No YAML parsing in the repo and no new dependencies allowed; use RESEARCH.md Pattern 1-3 prototype (0 failures over 76 frontmatters). |
| Drag and drop and Move menu in `board.js` | component | event-driven | No existing DnD in `media/*`; use native HTML5 DnD plus a keyboard "Move to..." menu (UX-CONTRACT accessibility). |
| Kanban layout in `board.css` | style | n/a | Only table/list pages exist (activity, tools); reuse their theme-variable conventions. |

## Metadata

**Analog search scope:** `src/domain/team`, `src/team`, `src/services/team`, `src/services/{activityView,toolsPage}.ts`, `media/{activity,tools}`, `src/test` (team*, toolsPage, activityView, helpers, e2e), `package.json` views.
**Files scanned:** about 25 read (targeted ranges), plus directory listings.
**Pattern extraction date:** 2026-11-02
**Note:** The second half of 62-RESEARCH.md (lines 410-691, beyond the first read page) was not read; if it contains plan-slice or validation specifics, they take precedence over this map.

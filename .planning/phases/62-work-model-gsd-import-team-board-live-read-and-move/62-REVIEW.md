---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
reviewed: 2026-11-02T00:00:00Z
depth: standard
files_reviewed: 27
files_reviewed_list:
  - media/board/board.css
  - media/board/board.js
  - media/board/detail.js
  - media/board/drag.js
  - media/board/form.js
  - media/board/menu.js
  - package.json
  - scripts/verify-release-content.mjs
  - src/domain/team/board.ts
  - src/domain/team/boardText.ts
  - src/domain/team/gsdImport.ts
  - src/domain/team/itemHistory.ts
  - src/domain/team/materialize.ts
  - src/domain/team/permissions.ts
  - src/domain/team/types.ts
  - src/domain/team/validate.ts
  - src/domain/team/work.ts
  - src/extension.ts
  - src/services/team/boardView.ts
  - src/services/team/teamCommands.ts
  - src/services/team/teamSession.ts
  - src/services/team/teamStatusBar.ts
  - src/team/eventLog.ts
  - src/team/importPlans.ts
  - src/team/integrationSource.ts
  - test/fixtures/gsd-import/planning/ROADMAP.md
  - test/fixtures/gsd-import/planning/STATE.md
findings:
  critical: 2
  warning: 5
  info: 8
  total: 15
status: issues_found
---

# Phase 62: Code Review Report

**Reviewed:** 2026-11-02
**Depth:** standard
**Files Reviewed:** 27 (plus a skim of the test helpers, mainly `src/test/helpers/fakeDom.ts` and `src/test/teamBoardAssets.test.ts`)
**Status:** issues_found

## Summary

The domain and host layers are in good shape. I traced the signed-event path (`validate.ts` -> `materialize.ts` -> `work.ts` -> `permissions.ts`) for forgery and replay resistance:
- Author/device/signature binding is positional and checked before authorisation.
- `prev` and lamport are enforced.
- Every transition is re-run on the write side through `prepareEvents` and `transport.append`.
- Optional-key objects are built key by key, and the prototype-keyed lookups are all guarded by an earlier choice or key check.

I found no forgery, permission-bypass or prototype-pollution path in the event pipeline. `parseBoardMessage` is a strict exact-key parser. The host re-plans every move on fresh state inside the append. The CSP is a nonce CSP with `default-src 'none'`. No board script uses `innerHTML` or any other markup sink.

Two things need fixing before this ships:
1. **CR-01:** The browser client uses Array methods on `NodeList` objects, so it throws in a real Chromium webview. The fake DOM the tests use returns real Arrays, which is why nothing caught it.
2. **CR-02:** The importer treats a partially read integration branch as complete and cancels live plans and tasks in the append-only team log.

The warnings cover an import-abort vector, unbounded auto-imported item volume, inconsistent error redaction, a CSS class collision and the test-double gap behind CR-01.

## Critical Issues

### CR-01: Array methods called on NodeList results; the board client throws in a real browser (tests mask it)

**File:** `media/board/board.js:502, 520, 622, 670, 674`; `media/board/menu.js:108, 129`; `media/board/detail.js:220`; `media/board/form.js:237`

**Issue:** `Element.querySelectorAll` returns a `NodeList` in a browser. A `NodeList` has `forEach`, `item` and iteration, but not `map`, `indexOf`, `find` or `filter`. The client calls those on the raw result:
- `board.js:622` (`applyRoving`): `const cards = group.querySelectorAll('.card'); const ids = cards.map(...)`.
- `board.js:502`, `520` (`headNodes().indexOf`).
- `board.js:670` (`rows.indexOf`), `674` (`querySelectorAll('ul.cell').map`).
- `menu.js:108`, `129` (`itemNodes().indexOf`).
- `detail.js:220` and `form.js:237` (`.find`).

`applyRoving()` runs inside every `render()` once the model has at least one lane or group. In Chromium it throws `TypeError: cards.map is not a function`, and the effects are:
- `render()` aborts before the `renderListeners` loop at `board.js:707`. So `drag.js`'s `syncDraggable` never sets `draggable`, and drag and drop never works after load.
- `detail.js` never refreshes or closes on a model change.
- `menu.js` never closes or repositions on a model change.
- `form.js` never tears down on a removed card.
- Focus restore and `outline()` in `onState` are skipped too.
- Keyboard navigation (arrows, Home/End), menu stepping and type-ahead all throw.

The tests pass because `src/test/helpers/fakeDom.ts:273` implements `querySelectorAll` as `this.all().filter(...)`, which returns a real Array. The extension-host e2e (`src/test/e2e/suite.ts`) only observes `boardTap` messages, never the page DOM. So the Phase-62 "real board page" proof cannot see this.

**Fix:** Convert at the call sites, or add one helper and use it everywhere:
```js
// board.js (and the same one-liner in menu.js, detail.js, form.js)
const all = (root, selector) => Array.from(root.querySelectorAll(selector));
// 622: const cards = all(group, '.card'); const ids = cards.map(...)
// 517: const headNodes = () => all(heads, '.col-btn');
// 669: const rows = all(li.closest('.group'), '.card');
// 674: const grid = all(lane, 'ul.cell').map((cell) => all(cell, '.card')).filter((cards) => cards.length > 0);
// menu.js 28: const itemNodes = () => Array.from(menu.querySelectorAll('[role="menuitem"]'));
// detail.js 220: Array.from(body.querySelectorAll('[data-focus]')).find(...)
// form.js 237: Array.from(document.querySelectorAll('button')).find(...)
```
Also see WR-05: make the fake DOM return a NodeList-like object so this class of bug fails in unit tests.

### CR-02: A partial or truncated read of the integration branch is treated as complete, so live plans and tasks get cancelled

**File:** `src/team/integrationSource.ts:106-107, 114-126, 134`; `src/team/importPlans.ts:539-540, 556-563`; `src/team/importPlans.ts:442-446` (`diffImport`)

**Issue:** `readPlanningSnapshot` can return an incomplete picture of `.planning` in three ways:
1. `entries = all.slice(0, MAX_PLANNING_PATHS)` caps at 2000 paths before the `wanted` filter. Every non-plan file under `.planning/codebase`, `milestones`, `research` and so on counts against the cap, and `git ls-tree` sorts `phases/` late, so the newest phases are the ones cut off.
2. A plan larger than 256 KB goes to `oversize`.
3. Plans past the 8 MB total are skipped with `truncated = true`.

`importPlans` only appends a warning for these cases (`importPlans.ts:539-540`) and then diffs the partial graph as if it were the whole roadmap. In `diffImport`, `vanished` is every imported, unfinished, non-milestone item of this milestone that is not in `bodies`, and each one gets `item.cancelled` with reason "no longer in the roadmap". So a project with more than 2000 files under `.planning`, or anyone who can push a few thousand junk files there, makes the next lead import (and the automatic import in a lead's window, see WR-02) cancel the newest phases' plans and tasks in an append-only log. Recovery is a manual per-item Reopen.

The missing-text and oversize cases are subtler. A plan path that is listed but whose text was not read goes through `buildGsdGraph` with `text === undefined`. It is imported with empty `filesModified`, `truths` and tasks, and `changesFor` then emits `item.updated` setting `scope: []` and `mustHaves: []`. Ready cards silently drop to Backlog with "it lists no files".

**Fix:** Treat an incomplete read as additive only.
```ts
// integrationSource.ts: cap the wanted candidates, not every path
const candidates = all.filter((e) => e.readable && wanted(e.path)).slice(0, MAX_PLANNING_PATHS);
const incomplete = all.filter((e) => e.readable && wanted(e.path)).length > MAX_PLANNING_PATHS;
// ...return { ..., truncated: incomplete || truncatedBytes }

// importPlans.ts: when snapshot.truncated || snapshot.oversize.length > 0 (or any chosen plan has no text)
//   - pass { cancelVanished: false } to diffImport and skip the `vanished` loop
//   - skip changes derived from plans whose text was not read
//   - return a warning ("not everything was read, nothing was cancelled")
```
Also stop `paths` from listing files that were never eligible to be read, or have `buildGsdGraph` mark such plans as unread so `changesFor` can skip them.

## Warnings

### WR-01: One YAML-escaped lone surrogate in `files_modified` aborts the whole import

**File:** `src/team/importPlans.ts:103-117` (`safeScope`), `171-173` (`eventBytes`), `276-304` (`accept`); `src/domain/team/gsdImport.ts:144-156` (`unquote`)

**Issue:** Titles, must-haves and warnings go through `collapse`, which replaces lone surrogates. Scope entries (`safeScope`) do not. A frontmatter entry such as `- "\ud800"` is decoded by `unquote` via `JSON.parse` into a lone surrogate. It passes `isScopePattern` (no control characters) and `findSecrets`. Then `fitItemBody` -> `canonicalBytes` throws `CanonicalJsonError` ("lone surrogate in string"). `accept` does not catch it, so it escapes `graphToItems`, and `importPlans` reports it as a failure (`fail(error.message)`). One hostile or merely broken plan file blocks all imports, and the auto import retries every minute because `lastCheckedHead` is only set on success.

**Fix:** Sanitise scope entries and gsd file paths with the same lone-surrogate replacement, or reject them:
```ts
const value = raw.replace(LONE_SURROGATE, '�').trim();
// or: if (LONE_SURROGATE.test(raw)) { warn(...); continue; }
```
Also wrap the per-draft `fitItemBody`/`validateBody` in a try/catch that turns a `CanonicalJsonError` into a "left out" warning, so a single bad item skips only itself.

### WR-02: A lead's window auto-imports an unbounded, attacker-influenced number of items into an immutable log

**File:** `src/domain/team/gsdImport.ts:27-28` (`MAX_TASKS_PER_PLAN`, `MAX_PLANS`); `src/team/importPlans.ts:35-36`; `src/services/team/teamSession.ts:427-460` (`checkIntegration`)

**Issue:** Per-plan and per-file caps exist, but there is no cap on the total number of items. 2000 plans times 50 tasks is about 102,000 `item.imported` events. The import writes up to `MAX_ROUNDS * 250` = 5000 intents per run and resumes on the next run. The automatic check in an owner's or lead's window starts this without any confirmation, whenever the integration head moves. It signs those events as the lead, from a branch that, by the module's own threat model, anyone with push access controls. Events are permanent. Each is also a file on the coordination branch, and snapshots are refused above 8 MB (`MAX_SNAPSHOT_BYTES`). A developer can therefore cause lead-signed log growth that a developer could not create directly.

**Fix:** Add a total-item cap in `graphToItems` (for example 2000 items, with a warning and a skip) and a sanity ceiling on the number of intents one auto import may write. Require a command-mode import, or a confirmation, when an auto import would write more than a small threshold (for example 200). Tasks are the multiplier and are only used for the detail view, so a lower per-plan cap for tasks is the cheapest fix.

### WR-03: Board host error text bypasses the redaction used everywhere else in Team Mode

**File:** `src/services/team/boardView.ts:292-294, 420, 427, 448, 611, 655`

**Issue:** `describe()` prints `error.message` raw to the output channel. The rest of Team Mode routes error text through `safeReason` (`teamSession.describeError`, `teamCommands.describe`, `teamStatusBar`) because messages can carry remote URLs with embedded credentials, or control characters. `failureText` in the same file already uses `safeReason`, so the file is inconsistent. An unexpected throw from `append`/`flush` (a non-`GitCommandError` that wraps a remote URL, for example) reaches the channel unredacted.

**Fix:**
```ts
function describe(error: unknown): string {
  return safeReason(error instanceof Error ? error.message : String(error));
}
```

### WR-04: `.state` CSS class is used for both the empty-state box and the card state chip

**File:** `media/board/board.css:55, 92-93`; `media/board/board.js:439`

**Issue:** `.state { display: flex; flex-direction: column; ... padding: 32px 12px; text-align: center }` (line 55) styles the page-level empty, loading and error boxes. `board.js:439` also gives the card's state chip `class="state"` (`iconText('state', ...)`). Line 92 overrides `display`, `align-items`, `gap` and `flex-wrap`, and line 93 resets `padding`, but nothing resets `flex-direction: column` or `text-align: center`. So on every card the icon is stacked above the state word instead of sitting beside it.

**Fix:** Rename the box class (for example `.state-box`, in `stateView` and the CSS) or the chip class. Alternatively add `flex-direction: row; text-align: left` to `.card-top .state`.

### WR-05: The fake DOM returns Arrays from `querySelectorAll`, hiding browser-incompatible code (root cause of CR-01)

**File:** `src/test/helpers/fakeDom.ts:273-274`; `src/test/teamBoardAssets.test.ts`

**Issue:** `querySelectorAll` returns `FakeNode[]`, so every Array method the client calls "works" in `boardClient.test.ts`, `boardMenu.test.ts`, `boardDetail.test.ts` and `boardForm.test.ts`. The static asset test checks for markup sinks but not for DOM-API misuse. The real-host e2e can only see messages. Net effect: 14 plans of client code were verified against a DOM that is more permissive than Chromium.

**Fix:** Return a NodeList-like object that has `length`, index access, `item`, `forEach`, `entries/keys/values` and `Symbol.iterator`, and no `map`, `filter`, `find`, `indexOf` or `some`. Re-run the board client tests and fix the call sites as in CR-01. Add a regression test that renders a model with cards and asserts `applyRoving`-dependent behaviour (roving `tabindex`, `draggable` set after render).

## Info

### IN-01: Bidi and zero-width format characters are accepted in titles, reasons, names and scope entries

**File:** `src/domain/team/validate.ts:85, 251`; `src/domain/team/work.ts:11, 23-27`; `src/domain/team/boardText.ts:85-93`

The control-character filters cover C0, DEL, U+2028 and U+2029, but not U+0080-U+009F in the signed validators, nor U+202A-U+202E, U+2066-U+2069 or U+200B-U+200F. `flattenName` strips U+0080-U+009F but also not the bidi overrides. A plan title, block reason or file path can therefore visually reorder or spoof text in the board and the history ("Trojan Source" style) without any rule being broken. `policy.ts` already forbids these characters in ref names. Consider rejecting or stripping them in `flattenName`, and in `validateText`, `isScopePattern`, `validateName` and `validateMustHaves` (a signed-shape change, so it needs a deliberate decision). Stripping them in `flattenName` is the cheap, non-breaking half.

### IN-02: A phase with no live plans can never be completed, so its dependents wait forever

**File:** `src/domain/team/work.ts:29, 92-96, 162-167`

`phaseComplete` treats a phase with no non-cancelled plan as complete only when the phase itself is `done`. But `markDoneProblem` requires `movesThroughStates`, which excludes phases, so no event can ever mark a phase done. A phase whose plans were all cancelled (or that was never planned) permanently blocks every phase and plan that depends on it. The comment documents the intent for an unplanned phase, but the cancelled-all-plans case has no way out except editing the roadmap. Consider allowing `item.updated state: done` on a phase (managers only), or counting a phase whose plans are all cancelled as complete.

### IN-03: Duplicated constants can drift

**File:** `src/services/team/teamStatusBar.ts:37` and `src/services/team/teamCommands.ts:14` (both export `OPEN_BOARD_COMMAND`); `src/services/team/boardView.ts:31-35` vs `src/domain/team/validate.ts:234-236, 243`

`OPEN_BOARD_COMMAND` is exported twice with the same value. `boardView.ts` redeclares `TITLE_MAX`, `DESCRIPTION_MAX` and `ESTIMATE_MAX`, which `validate.ts` already exports as `TITLE_MAX`, `DESCRIPTION_MAX` and `MAX_ESTIMATE_TOKENS`; `REASON_MAX` is already imported from there. `form.js` repeats them a third time. If the signed limit ever changes, the host parser silently drops messages the validator would accept. Import the shared constants.

### IN-04: Dead exports and an unused method

**File:** `src/domain/team/boardText.ts:68, 69, 70` (`IMPORTED_NOTE`, `EMPTY_HISTORY_TEXT`, `EMPTY_TASKS_TEXT`); `src/domain/team/itemHistory.ts:61` (`ItemHistory.clear`)

None of these has a consumer in `src` or the tests (`detail.js` keeps its own copies of the strings). The doc comment on `clear` ("the board rebuilds history after a full re-read") describes behaviour that does not exist: `TeamSession` never calls it, so a rewritten or re-verified log leaves history as it was. Remove them or wire them up.

### IN-05: Test seams are live in production code

**File:** `src/services/team/boardView.ts:80, 312`; `media/board/board.js:842`; `src/extension.ts:70, 106`

`boardTap.request` is assigned by the production `BoardController` constructor, and the real page honours `host-request` by re-posting an arbitrary payload to the host. `NearAiTestApi` returns `context.secrets` when `NEAR_AI_E2E=1`. All of these are reachable only in-process or through an environment variable, and the host still validates every message, so there is no exploit. They are still extra attack surface that a production build does not need. Consider compiling the seam out, or gating `host-request` on a build flag.

### IN-06: `headingTitle` slices from the first `\n---` rather than the frontmatter's closing line

**File:** `src/domain/team/gsdImport.ts:735`

`text.indexOf('\n---', 3) + 4` matches any line that merely starts with `---` (`----`, `---x`), so a YAML comment or value line before the real closing fence can put the slice inside the frontmatter. A `# ...` comment line in the frontmatter then becomes the plan title. Use the line index that `frontmatterBlock` found (return it with the block).

### IN-07: `staleOrPlain` names the last history author, who may be the viewer or unrelated

**File:** `src/services/team/boardView.ts:524-529`

The "X already changed this card" sentence uses `itemHistory(itemId)[0]?.author`. When a card-state refusal comes from the viewer's own earlier move (or from a change made before this window opened, since history is in-memory), the board names the wrong person, possibly the viewer. Say "Someone" when the author is the viewer or the history is empty or older than the page's model.

### IN-08: Unsent form drafts, including pasted secrets, are persisted in webview state before the host's secret check

**File:** `media/board/form.js:183-187`; `media/board/board.js:52`

`draftNow()` stores title, description and files into `vscode.setState` on every input event. The host's `findSecrets` refusal runs only at submit time. A pasted key therefore sits in webview state (restored across hide and reload) even though it would never be saved to the log. Low risk, but consider clearing or not persisting the description, or running the page-side check on the draft.

---

_Reviewed: 2026-11-02_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 06
subsystem: state-sync
tags: [thread-view, reopen, tool-step-cards, chunked-rendering, history-list, d-07, d-08, d-12, webview]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-02 threadEntries.ts (threadLines, capToolResult, entry ids); 27-05 ThreadStore (lines, meta, index, scan, locked listing), restore() from the log, entriesToTurns"
provides:
  - "src/domain/state/threadView.ts: ViewItem, entriesToView, batchView, pairToolResults, shortenedNote, PARTIAL_HISTORY_NOTE, OTHER_CONTINUATION_LABEL, PARTIAL_HISTORY, VIEW_ARGS_LIMIT"
  - "src/services/threadStore.ts: toolOutput(id, entryId), index() returning ThreadIndexItem (state, origin, history, locked), historyItems, LOCKED_DETAIL, ThreadState"
  - "src/services/agentSession.ts: restore() answers a thread store with { items }, RestoredView, toolOutput(entryId)"
  - "src/services/chatBridge.ts: thread-tool-output request and its strict parser"
  - "media/chat/chat.js and chat.css: transcript items, history tool cards with lazy output, sliced drawing, other-continuation divider, content-visibility"
  - "src/extension.ts: history QuickPick over ThreadStore.index() through historyItems"
affects: [27-07, 27-10, history-view, chat-participant]

requirements-completed: [SYNC-01]

actuals:
  tokens: 10900
  tasks: 3
  commits: 4
plan_head_before: 376ab1bd74d114ac585c3cfe19130ec9d7ba63c7
plan_head_after: 50442f92f4e9dca475581ac27659d1810026f78c

tech-stack:
  added: []
  patterns:
    - "One pure mapping (entriesToView) from the thread's lines to view items; a tool call and its result are paired sequentially by call id (nearest earlier call), so a provider that reuses a call id in a later turn still pairs correctly"
    - "A thread reaches the webview as batches of at most 200 items (one log entry and one message per batch, note on the last); the page queues items and draws 50 per animation frame, and any other host message that arrives meanwhile waits behind them so order is preserved"
    - "A tool card carries no output: opening it for the first time posts thread-tool-output, and the host answers from the tab's own ThreadStore; the answer is set with textContent in a pre"
    - "The history list is built from ThreadStore.index() (index cache plus each thread's own small meta, never a log) by a pure historyItems"

key-files:
  created:
    - src/test/threadReplay.test.ts
  modified:
    - src/domain/state/threadView.ts
    - src/services/threadStore.ts
    - src/services/agentSession.ts
    - src/services/chat.ts
    - src/services/chatBridge.ts
    - src/services/conversations.ts
    - src/extension.ts
    - media/chat/chat.js
    - media/chat/chat.css
    - src/test/threadLog.test.ts
    - src/test/agentFleet.test.ts
    - src/test/conversations.test.ts
    - src/test/sidebarChat.test.ts

key-decisions:
  - "A tool item carries a one-line-previewable args string capped at 2 000 characters (the log keeps them whole) and no output; the card asks for the output when it is opened, so a 5 000-entry thread with large Write calls cannot swell the webview"
  - "Tool steps are paired by walking the segment in order and answering the nearest earlier call with the same call id; an entry id given to toolOutput may be the call's or the result's, and a result whose call has not arrived is shown as a card of its own so nothing is hidden"
  - "ConversationLog pins 'transcript' entries when it trims live output, so a reopened thread's history is never trimmed away (the prohibition on a cut-off); only live output goes"
  - "Messages that reach the page while history is still drawing are queued behind it (including conversation-shown), so a run-interrupted notice or the busy state never appears before the messages it follows; conversation-show drops whatever was queued"
  - "index() lists a locked line for every thread this device cannot open, so the history list needs no second call; historyItems shows the partial-history sentence in the item detail after the time and model rather than instead of them"

coverage:
  - id: D1
    description: "Reopening a thread shows every entry in order: user messages as typed, assistant replies, and each tool step as a collapsed card naming the tool and its arguments"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#a thread with tool steps maps to user, assistant and one collapsed card per tool step, naming the tool and its arguments"
        status: pass
      - kind: unit
        ref: "dist/test/threadReplay.test.js#reopening a thread of a ThreadStore returns items whose user texts equal what was typed"
        status: pass
    human_judgment: false
  - id: D2
    description: "A thread of 5 000 entries reaches the view in 25 batches of at most 200 and the rendered count equals the entry count; no show-last-N limit exists"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#a thread of 5 000 entries reaches the view in 25 batches of at most 200, and every entry is rendered"
        status: pass
      - kind: unit
        ref: "dist/test/threadReplay.test.js#a reopened thread stays whole in the conversation log however long the live output grows"
        status: pass
    human_judgment: false
  - id: D3
    description: "A thread continued on two machines shows its main line, then one divider reading 'Also continued on another computer', then the other continuation, every entry once"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#a thread continued on two computers shows its main line, then a labelled divider, then the other continuation, with every entry once"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-12: a tool result shortened by the cap carries 'output shortened, N MB' on its card; nothing else is marked"
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#D-12: a tool result shortened by the cap shows how much was not stored, and nothing else is marked"
        status: pass
    human_judgment: false
  - id: D5
    description: "A thread migrated with history partial-before-0.4.20 starts with the note that earlier messages cannot be restored"
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#a thread migrated with partial history starts with the note that earlier messages cannot be restored"
        status: pass
    human_judgment: false
  - id: D6
    description: "The tool-output request is accepted only with exactly three keys and well-formed ids, and the host answers only from the tab's own ThreadStore (T-27-26)"
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#the tool-output request is accepted only with exactly its three keys and well-formed ids"
        status: pass
      - kind: unit
        ref: "dist/test/threadReplay.test.js#ThreadStore.toolOutput returns the stored output of a step, and nothing for an unknown entry"
        status: pass
    human_judgment: false
  - id: D7
    description: "The history list reads the index (no log opened), shows Chat view, Archived, Locked and partial labels, sorts newest first, and a locked thread is listed from the index when this device has no key"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#the history list shows origin, archived, locked and partial labels, newest first"
        status: pass
      - kind: unit
        ref: "dist/test/threadReplay.test.js#the index lists every thread with its state and origin, and a thread this device cannot open as locked, from the index without opening any log"
        status: pass
    human_judgment: false
  - id: D8
    description: "The page draws reopened history in slices of 50 per animation frame, renders stored output with textContent in a pre (never innerHTML), and asks for it only when a card is first opened (T-27-25, T-27-27)"
    verification:
      - kind: unit
        ref: "dist/test/threadReplay.test.js#the chat page renders stored output as text, never as markup, and asks for it only when a card is opened"
        status: pass
    human_judgment: true
    rationale: "The test reads chat.js and chat.css for the guarantees; no DOM harness exists in this repository, so the drawing itself (slices, queue ordering behind history, the toggle request, the divider and card look) was reviewed by reading and is covered by the phase's manual check (VALIDATION manual row 1)"
  - id: D9
    description: "The QuickPick behaviour of showHistory (filtering as the person types, declining to open a locked item with the plain sentence)"
    requirement: SYNC-01
    verification: []
    human_judgment: true
    rationale: "showHistory is VS Code QuickPick code that no unit test drives; the item list it shows is tested through historyItems, the filtering is VS Code's own matchOnDescription/matchOnDetail"

duration: 20min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 06: Reopen with every message Summary

**Reopening a thread shows every entry of its log in order, with each tool step as a collapsed card whose full stored output loads when it is opened, long threads in batches of 200 drawn 50 at a time, a labelled second continuation, the 2 MiB marker and the partial-history note, and the history list is built from the thread index with origin, archived and locked labels.**

## Performance

- **Duration:** about 20 min (15:10 to 15:30 UTC)
- **Tasks:** 3 (1 tracer, 1 TDD, 1 auto)
- **Files modified:** 14 (1 created, 13 modified), 645 insertions and 40 deletions

## Accomplishments

- `entriesToView` maps the thread's lines to `ViewItem`s: user, assistant, one card per tool step (name, arguments, ok when a result is stored, `note: 'output shortened, N MB'` when the 2 MiB cap cut it), notices, and, for each other continuation, a divider reading "Also continued on another computer" followed by that branch in full. A thread with history `partial-before-0.4.20` begins with the note that earlier messages cannot be restored.
- `restore()` answers a `ThreadStore` with `{ items }` (the older turns shape stays for any other store). `restoreInto` posts `batchView(items)` as transcript messages with `part` and `of`, the note on the last part. A 5 000-entry thread is 25 batches and renders 5 000 items; nothing is skipped and there is no "show last N".
- `chat.js` queues items and draws 50 per animation frame; anything else the host sends meanwhile waits behind them (so the interrupted-run notice and the busy state come after the history, not before). Opening a tool card for the first time posts `thread-tool-output`; the host answers from the tab's own `ThreadStore.toolOutput` and the text goes into a `pre` with `textContent`. Reopened turns use `content-visibility: auto`.
- `parseChatWebviewMessage` accepts `thread-tool-output` with exactly `type`, `conversationId` (required here) and `entryId` (26 base32 characters), rejecting extra keys and bad ids.
- The conversation log no longer trims a reopened thread's transcript entries when live output grows; only live output is trimmed (and still says so).
- `ThreadStore.index()` returns every thread with `state`, `origin`, `history` and a `locked` line for each thread this device cannot open; `historyItems` builds the QuickPick items (title label, "N messages · Chat view · Archived", locked sentence, partial-history sentence), newest first then by id; `showHistory` uses it, never decrypts a log, and never opens a locked item.

## Task Commits

1. **Task 1 (tracer): reopening shows tool steps as cards** - `ef4724e` (feat). Tracer verified end to end (3 new tests, then the 85-test related run) before expansion.
2. **Task 2 RED** - `ada71f1` (test). Four of eleven tests failed for the intended reasons (no `thread-tool-output` in the parser, no `ThreadStore.toolOutput`, no `content-visibility` rule, the conversation log trimming a reopened thread away).
3. **Task 2 GREEN** - `fa9b55c` (feat)
4. **Task 3: history list from the index** - `50442f9` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md, ROADMAP.md and REQUIREMENTS.md.

## Verification

- `npx tsc -p tsconfig.json`: clean at every GREEN commit (the RED commit does not type-check, by design: it calls `ThreadStore.toolOutput`, which the next commit adds).
- `node --test dist/test/threadReplay.test.js`: 14 of 14 pass (plan asked for at least 10).
- Related suites (chat*, sidebarChat, spendSendPath, reportingTokenEntry, steering*, setupNudge, approvalPolicyPicker, autoResume, runRecovery, agent*, state*, thread*, privacy, conversations, pageScripts): 344 tests, only the known `chatSendPath` "GSD slash command" failure.
- Acceptance greps: `history-tool` in chat.js 3 (baseline 0); `requestAnimationFrame` in chat.js 2 (baseline 1); `content-visibility` in chat.css 1 (baseline 0); `thread-tool-output` in chatBridge.ts 3 (baseline 0); `historyItems(` in extension.ts 1 (baseline 0).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Existing tests read the old turns shape of `restore()` and of the transcript message**
- **Found during:** Task 1 (tsc errors in threadLog and agentFleet; failures in conversations and sidebarChat)
- **Issue:** the plan changes `restore()` for a ThreadStore to `{ items }`, so tests that read `turns` from it, from the posted `transcript` message, or counted the `renderMarkdown(` call sites no longer matched.
- **Fix:** threadLog reads items through a small `itemsOf` helper (same assertions on typed texts and assistant count); agentFleet (old store, still turns) narrows the type; conversations uses a `shownTexts` helper that reads items or turns; sidebarChat's expected list of `renderMarkdown` call sites gains the new `body, item.text || ''`. No assertion was weakened or removed.
- **Files modified:** `src/test/threadLog.test.ts`, `src/test/agentFleet.test.ts`, `src/test/conversations.test.ts`, `src/test/sidebarChat.test.ts`
- **Committed in:** `ef4724e`

**2. [Rule 2 - Missing critical] The conversation log could trim a reopened thread away**
- **Found during:** Task 2 (the plan's prohibition: no cut-off of a reopened thread's messages)
- **Issue:** `ConversationLog` removes its oldest quarter once it holds 4 000 entries, and the reopened history is its oldest entries, so a long live session would drop the history from every later replay.
- **Fix:** trimming keeps `transcript` entries and removes only live output (the notice that earlier output is no longer shown still appears). `conversations.ts` was not in the plan's file list.
- **Files modified:** `src/services/conversations.ts`
- **Verification:** `threadReplay` test "a reopened thread stays whole in the conversation log however long the live output grows"
- **Committed in:** `fa9b55c`

**3. [Rule 2 - Missing critical] Pairing and lookups had to survive reused call ids and partial deliveries**
- **Found during:** Task 1 design
- **Issue:** pairing a result with its call by call id alone is wrong when a provider reuses an id in a later turn, and a result whose call has not arrived (a partial delivery) would be hidden.
- **Fix:** `pairToolResults` walks the segment in order and answers the nearest earlier call; an unpaired result is shown as a card of its own; `toolOutput` accepts the call's or the result's entry id.
- **Files modified:** `src/domain/state/threadView.ts`, `src/services/threadStore.ts`
- **Committed in:** `ef4724e`, `fa9b55c`

---

**Total deviations:** 3 auto-fixed (2 Rule 2, 1 Rule 3). **Impact on plan:** all needed for the plan's own invariants (no hidden message, no regression in existing suites); no scope creep.

**Smaller choices inside the plan:** tool items also carry `note` (the D-12 wording computed on the host, since the page cannot import it) and `args` is capped at 2 000 characters for the view; `RestoredView`, `ThreadIndexItem`, `ThreadState`, `LOCKED_DETAIL` and `HistoryItem` are exported names the plan's artifact list did not name; the partial-history sentence is added to an item's detail after the time and model instead of replacing them.

**TDD note (Task 2):** the RED commit is only partly red. The pure parts (`batchView`, divider, D-12 note, partial note) had already landed in Task 1 as part of `entriesToView`, so those tests passed on first run; the four that failed did so for the intended reasons and are what the GREEN commit added.

## Known Limits

- The webview drawing code in `chat.js` (slicing, queue ordering behind history, the toggle request, divider and card look) has no automated DOM test: the repository has no DOM harness. The test reads the script for the safety guarantees (no `innerHTML` in the history section, `textContent`, 50-per-frame slices, the toggle request); the behaviour itself is for the phase's manual check (a reopened long thread shows every message).
- `ThreadStore.toolOutput` reads and decrypts the thread's whole log to find one step; for a very large log (many 2 MiB results) opening a card is proportionally slow. Fine for the expected sizes; a per-thread offset index would fix it if needed.
- Archive state (`state: 'archived'`) is read by the list and index but is written by plan 07; until then every thread is live.
- While a very long thread is drawing, host messages that follow it (the tab strip, the busy state) wait up to roughly 100 frames (under two seconds for 5 000 items); a hidden view pauses drawing until it is shown again.

## Issues Encountered

None beyond the deviations above. `.planning/state.json` was already modified before this plan and was left alone. The `chatSendPath` "GSD slash command" failure is the known machine-specific one.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 07 can set `state: 'archived'` in thread meta and the list, history and index already show it; archived threads reopen through the same `restore()` path. Plan 10 can mark migrated threads `history: 'partial-before-0.4.20'` and the view and the history list already show the note.

## Known Stubs

None.

## Threat Flags

None. The one new message (`thread-tool-output`) and the output rendering are the surface the plan's threat model covers (T-27-25, T-27-26, T-27-27): strict parser, tab-scoped host lookup, `textContent` in a `pre`, sliced drawing.

## Self-Check: PASSED

- Files: `src/test/threadReplay.test.ts`, `src/domain/state/threadView.ts`, `src/services/threadStore.ts`, `media/chat/chat.js`, `media/chat/chat.css` exist.
- Commits `ef4724e`, `ada71f1`, `fa9b55c`, `50442f9` are ancestors of HEAD; `git rev-list --count 376ab1b..HEAD` is 4.
- Plan verification: tsc clean; threadReplay 14 of 14; related suites 344 tests with only the known failure.

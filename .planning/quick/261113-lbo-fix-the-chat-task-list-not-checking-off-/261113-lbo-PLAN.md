---
phase: quick-261113-lbo
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/agent/taskBoard.ts
  - src/agent/loop.ts
  - src/services/agentSession.ts
  - src/domain/state/threadCapture.ts
  - src/gsd/tools.ts
  - media/chat/chat.js
  - media/chat/chat.css
  - src/test/taskBoard.test.ts
autonomous: true
requirements: [TODO-2026-11-13-task-list-not-checking-off]

estimate:
  tokens: 80000
  raw_tokens: 80000
  tasks: 3
  confidence: high

must_haves:
  truths:
    - "A run where the main agent finishes its work but sends no final TodoWrite gets exactly one host reminder listing the unfinished items; when the model then marks them, the Tasks panel ends at N/N with every item struck through"
    - "The host never marks an item completed on its own: if the model ignores the reminder, the statuses stay as they were and the end-of-run list is flagged 'not confirmed done' instead of silently showing 0/N"
    - "A sub-agent whose task names an item by its number, with punctuation, quote or list-marker differences, or as a unique whole-word part of the item, moves that item; an ambiguous or one-word name moves nothing"
    - "A completed status the host set survives the model's stale echo of its old list, and a completed status the model sends always wins"
    - "No code path posts the main task list to the view without going through TaskBoard"
  artifacts:
    - path: "src/agent/taskBoard.ts"
      provides: "revision counter, tolerant unique-only find, completed-from-model-always-wins write rule"
    - path: "src/services/agentSession.ts"
      provides: "one run-end <task-list-check> reminder, end-of-run unconfirmed post, forward() without a todos branch"
      contains: "task-list-check"
    - path: "media/chat/chat.js"
      provides: "renderTodos(todos, unconfirmed) showing 'not confirmed done'"
      contains: "unconfirmed"
    - path: "src/test/taskBoard.test.ts"
      provides: "TaskBoard unit tests and session tests that a finished run ends N/N"
  key_links:
    - from: "src/services/agentSession.ts runTurn afterAnswer"
      to: "TaskBoard.unfinished / TaskBoard.revision"
      via: "taskListCheck() after waitForBackground returns nothing"
      pattern: "taskListCheck"
    - from: "src/services/agentSession.ts runTurn (run settled)"
      to: "media/chat/chat.js case 'todos'"
      via: "post { type: 'todos', todos, unconfirmed: true } then renderTodos(m.todos || [], m.unconfirmed === true)"
      pattern: "unconfirmed"
    - from: "src/services/agentSession.ts spawn → moveTask"
      to: "TaskBoard.find"
      via: "tolerant, unique-only matching of spawn.task"
      pattern: "moveTask"
---

<objective>
Fix the chat Tasks panel staying at "Tasks · 0/N" after every task finished (owner report, release 0.4.20). Make the list follow finished work without ever marking an item done that did not finish.

Purpose: the panel is how a person sees progress. A list stuck at 0/3 after all three tasks finished reads as "nothing was done".
Output: a run-end task-list check (one reminder to the model), tolerant and numbered sub-agent task matching, a visible "not confirmed done" state at run end, the removal of a bypass in `forward`, and regression tests.

## Confirmed root cause (from reading the code at HEAD; the todo's three suspects checked one by one)

1. CONFIRMED, primary: nothing reconciles the list when a run ends. Only two things change a status: the main agent's own TodoWrite (`src/agent/tools.ts` todoTool → main `emit` in `src/services/agentSession.ts` runTurn → `TaskBoard.write`), and a sub-agent spawned with a matching `task` (`spawn` → `moveTask` → `TaskBoard.set`). The "Update the task list with TodoWrite" nudge exists only inside Agent results (`taskNote`). So a main agent that does the work itself, or ignores that nudge, ends the run with its first list unchanged (0/N). `afterAnswer` only waits for background agents. The owner's run used `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`, a model that often writes a list once and never updates it.
2. CONFIRMED, contributing: sub-agent matching is brittle. `task` is optional, and `TaskBoard.find` matches only exact content, or content equal after trimming and lowercasing. A paraphrase, added punctuation, a "1." prefix or an omitted `task` moves nothing, silently.
3. NOT a cause today: the `todos` branch of `forward` (agentSession.ts, around line 1185) cannot be reached. The main `emit` hands `todos` to `TaskBoard.write` before calling `forward`, and the sub-agent `emit` forwards only `tool-start`, `tool-end` and `turn` (around lines 901-903). It is still the one path that would post a list past TaskBoard, so it is removed.

A latent trap also found: `TaskBoard.write` treats a model `completed` that repeats its own last status as a stale echo. If the host moved that item back to pending (a sub-agent for it failed), the model can never mark it completed again, because every resend is an echo. A run-end reminder would then be unable to fix that item. The fix: a `completed` sent by the model always wins.
</objective>

<execution_context>
@~/aspire-home/.claude/gsd-core/workflows/execute-plan.md
@~/aspire-home/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/todos/pending/2026-11-13-task-list-not-checking-off.md
@src/agent/taskBoard.ts
@src/test/taskBoard.test.ts

Code pointers (read these ranges only; agentSession.ts is 1,573 lines):
- src/services/agentSession.ts: runTurn 323-470 (AgentRun options and main `emit` ≈ 380-416, inner try around `run.run` ≈ 424-433, `afterAnswer` ≈ 404); spawn and sub-agent `emit` ≈ 766-930 (`moveTask` at 807/918/925); `waitForBackground` ≈ 969-985; `moveTask`/`taskNote` ≈ 1020-1032; `forward` ≈ 1175-1188; `visibleTurns` ≈ 1490-1505; Open-GSD system prompt line ≈ 683.
- src/agent/loop.ts: `loop()` ≈ 306-357 (`maxTurns` default 60; `afterAnswer` returning messages continues the run; reaching the turn limit returns `max-turns` with a turn-limit stop).
- src/domain/state/threadCapture.ts: `isSyntheticMessage` ≈ 15-23.
- src/gsd/tools.ts: Agent `task` parameter and Agent description ≈ 105-111.
- media/chat/chat.js: `renderTodos` ≈ 710-721, `case 'todos'` ≈ 1357, `resetConversation` ≈ 484-490, `el()` ≈ 114 (uses textContent).
- media/chat/chat.css: `#todos` rules ≈ 226-232.

Test conventions: `node:test` + `node:assert/strict`, compiled to `dist/test/*.test.js` by `npm run compile`. Session tests build an `AgentConversation(root, post, ckptDir)` with a fake `near` client (`streamCompletion` async generator yielding `{ type: 'done', message, finishReason, usage }`, plus `actualCostsUsd`), collect `posted` messages, and dispose in `finally`. Reuse the helpers at the top of src/test/taskBoard.test.ts (`usage`, `call`, `todo`, `shown`, `sleep`) and the `GsdContext` setup of the existing sub-agent test.

Baselines recorded at HEAD (the targeted tests pass: taskBoard + conversations 28/28, agentFleet + agentTools 32 pass / 2 skipped):
- `grep -cF "this.post({ type: 'todos', todos: event.todos })" src/services/agentSession.ts` → 1 (target 0)
- `grep -c "task-list-check"` in src/services/agentSession.ts and src/domain/state/threadCapture.ts → 0 each (target ≥ 1)
- `grep -c "unconfirmed"` in media/chat/chat.js, media/chat/chat.css, src/services/agentSession.ts → 0 each (target ≥ 1)
- `grep -c "DEFAULT_MAX_TURNS" src/agent/loop.ts` → 0 (target ≥ 1)

Owner rule: run every test or node command memory-capped and run only the targeted test files (the exact wrapper is in each `<automated>` command). One heavy run at a time.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Run-end task-list check, so a run whose work finished ends N/N (tracer: TaskBoard → session → posted list)</name>
  <files>src/agent/taskBoard.ts, src/agent/loop.ts, src/services/agentSession.ts, src/domain/state/threadCapture.ts, src/test/taskBoard.test.ts</files>
  <behavior>
    - TaskBoard: `revision` goes up on every `write`, on every `set` that matched an item, and on `clear`; a `set` that matches nothing leaves it unchanged.
    - TaskBoard: a completed status the host set survives two stale echoes in a row. write [A:pending, B:pending]; set A completed; write [A:pending, B:in_progress] → A:completed; write [A:pending, B:completed] → A still completed.
    - TaskBoard: a completed status the model sends always wins. (i) write [A:pending]; set A in_progress; write [A:completed] → A:completed. (ii) write [A:completed]; set A pending (a sub-agent for it failed); write [A:completed] again, the same as its last status → A:completed. Today's code fails (ii): it keeps pending.
    - Session: the main agent writes [A, B, C] pending and then answers "Done." without updating the list. The host appends exactly one user message that starts with `<task-list-check>` and names all three items with their statuses. The fake model answers that with a TodoWrite marking all three completed, then a short line. The last posted `todos` message shows 3/3 completed, and `<task-list-check>` appears in exactly one request message across the run.
    - Session: a model that ignores the reminder (it answers again with no TodoWrite) gets no second reminder. The run ends with outcome completed (no `run-stopped` posted), and A, B and C are still pending in the last posted list. The host never marks them done.
    - Session: a second `send` on the same conversation that does not touch the list gets no reminder (exactly one model request for that run). A run whose list is all completed gets none.
    - Session: with `maxTurns: 2` (TodoWrite on turn 1, answer on turn 2) no reminder is sent and no `run-stopped` message is posted. With `maxTurns: 4` and the same script, the reminder is sent.
    - `visibleTurns(messages)` drops the reminder message, and `isSyntheticMessage` returns true for it.
  </behavior>
  <action>
    Write the tests first in src/test/taskBoard.test.ts (RED), then implement (GREEN). Keep every existing test and assertion in that file unchanged. The existing parallel sub-agents test now gets one extra model turn, because Task C ends pending; it does not assert the request count, and its `lists.slice(4)` expectation stays as is in this task.

    1. src/agent/taskBoard.ts: add a public read-only `revision` number. Bump it in `write`, in `set` only when an item matched, and in `clear`. In `write`, when the main agent sends status `completed` for an item, that status always wins: drop the item's mark and keep `completed`, checked before the echo rule. The echo rule stays as it is for pending and in_progress. Rewrite the class doc comment to state the invariant: a host mark survives a stale echo of pending or in_progress; a `completed` from the main agent is always shown; the host itself raises an item to completed only when the sub-agent it tracked finished.
    2. src/agent/loop.ts: export `DEFAULT_MAX_TURNS = 60` and use it for the `maxTurns` default in `loop()`, replacing the literal 60.
    3. src/services/agentSession.ts runTurn, before `new AgentRun`: capture `tasksAtStart = this.tasks.revision`, a `taskCheckSent = false` flag, and a `mainTurns` counter. Increment the counter in the main `emit` on `turn` events (main run only, not sub-agents). Replace `afterAnswer` as follows. Await `this.waitForBackground(signal)`; if it returned a non-empty array, return that. Otherwise return the result of a new private method `taskListCheck(...)`. That method returns a one-element array holding a user message only when all of these hold: the reminder was not sent yet in this run; the signal is not aborted; `this.tasks.revision !== tasksAtStart` (a TodoWrite or a sub-agent move touched the list in this run); `this.tasks.unfinished`; and at least two model turns remain, `(request.maxTurns ?? DEFAULT_MAX_TURNS) - mainTurns >= 2`, so the reminder can never push a finished run into a turn-limit stop. The message content starts with `<task-list-check>` and ends with `</task-list-check>`. Inside: "Your task list still shows {n} of {total} items not completed: "{content}" ({pending|in progress}), …. If you finished any of them, send TodoWrite now with the full list, marking completed only what is really done, and leave anything not done as it is. Then end your turn with one short line; do not repeat your answer." Set the flag when it is returned. This method never changes a status: the hard rule is that the host never marks an item done that did not finish.
    4. src/services/agentSession.ts `forward`: delete its `todos` branch. That branch is the bypass from suspect 3. It cannot be reached today, but it would post a list past TaskBoard. In the main `emit`, add a one-line comment saying every main task-list post goes through `this.tasks`.
    5. Hide the reminder from what the person sees and from the thread log. In agentSession.ts `visibleTurns`, skip user messages whose content starts with `<task-list-check>`, the same way `<agent-notification` is skipped. In src/domain/state/threadCapture.ts `isSyntheticMessage`, return true for user messages starting with `<task-list-check>`, and add it to the doc comment.
  </action>
  <verify>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 npm run compile && systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 node --test dist/test/taskBoard.test.js dist/test/agentFleet.test.js && test "$(grep -cF "this.post({ type: 'todos', todos: event.todos })" src/services/agentSession.ts)" = 0 && grep -q "task-list-check" src/domain/state/threadCapture.ts && grep -q "DEFAULT_MAX_TURNS" src/agent/loop.ts</automated>
  </verify>
  <done>The new TaskBoard and session tests pass, along with every existing test in taskBoard.test.js and agentFleet.test.js. A scripted run that does its work without a final TodoWrite gets one reminder and ends with 3/3 completed. An ignored reminder leaves the items pending, with no second reminder. `forward` has no `todos` branch. The reminder is hidden from the reopened view and from the thread log.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Tolerant, numbered sub-agent task matching (unique matches only)</name>
  <files>src/agent/taskBoard.ts, src/gsd/tools.ts, src/services/agentSession.ts, src/test/taskBoard.test.ts</files>
  <behavior>
    - Number: board [Write the parser, Add login page, Ship release 0.4.20]. set('2'), set('#2'), set('item 2') and set('task 2') each return 'Add login page'; set('#3') returns 'Ship release 0.4.20'; set('9') returns undefined. An item whose content is literally "2" is still matched exactly first.
    - Punctuation, quotes and leading list markers are ignored: set('"Write the parser."'), set('1. Write the parser') and set('- [ ] Write the parser') each return 'Write the parser'.
    - Unique whole-word containment, where the shorter side has at least two words: set('login page') returns 'Add login page'; set('Ship release 0.4.20 to the marketplace') returns 'Ship release 0.4.20'.
    - Ambiguity or a one-word name moves nothing: set('tests') returns undefined; on the existing board [Write the parser, write the parser tests], 'Write parser' and 'the parser' still return undefined (the existing test is unchanged).
    - Session: the main agent writes [Task A, Task B] pending, then spawns two Agents in one turn, one with task '2' and one with task '"task a."'. Both items end completed, the last posted list shows 2/2, and no `<task-list-check>` is sent (nothing is unfinished).
  </behavior>
  <action>
    Write the tests first (RED), then implement (GREEN).

    1. src/agent/taskBoard.ts `find(task)` tries these steps in order and returns the first hit:
       (a) exact content;
       (b) content equal after trimming and lowercasing (today's rule);
       (c) a number: the whole task is an optional `#`, `item `, `task ` or `no.` followed by one or two digits, which selects the item at that 1-based position, if it exists;
       (d) normalized-key equality: the unique item whose key equals the task's key;
       (e) whole-word containment: the unique item where the shorter token list (at least 2 tokens) appears as a contiguous run inside the longer one.
       The key comes from a private normalizer. It lowercases, strips one leading list marker (`-`, `*`, `•`, `[ ]`, `[x]`, `1.`, `1)`, `1:`, `#1`), replaces every run of characters that are not Unicode letters or digits with one space (a `u`-flag regex), and trims. Steps (d) and (e) return an item only when exactly one item matches; zero or several return undefined. Do not add token-overlap, edit-distance or other scored fuzzy matching. The hard rule is that a wrong match would mark the wrong item done, so a guess must move nothing. Update the `find` doc comment to list these steps.
    2. src/gsd/tools.ts, Agent `task` parameter: keep its first sentence verbatim ("The exact content of the task-list item this agent works on."; an existing test matches it) and append "Its number on the list (1 for the first item) works too." In the Agent tool description, change "pass that item's exact content as task" to "pass that item's exact content (or its number on the list) as task".
    3. src/services/agentSession.ts, Open-GSD system prompt line (≈ 683): change "pass that item's exact content as the Agent call's task" to "pass that item's exact content (or its number on the list, counting from 1) as the Agent call's task".
  </action>
  <verify>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 npm run compile && systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 node --test dist/test/taskBoard.test.js</automated>
  </verify>
  <done>Numbered, punctuation-tolerant and unique-containment matches move the right item. Ambiguous and one-word names move nothing. The existing exact-match test passes unchanged. A session in which sub-agents name their items by number or by a quoted paraphrase ends at 2/2 with no reminder.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Show "not confirmed done" when a run ends with unfinished items</name>
  <files>src/services/agentSession.ts, media/chat/chat.js, media/chat/chat.css, src/test/taskBoard.test.ts</files>
  <behavior>
    - When a run ends with any outcome (completed, cancelled, stopped short, or failed) after its list was touched in that run and with items still unfinished, the host posts the list once more as `{ type: 'todos', todos, unconfirmed: true }`. Statuses are unchanged; the host never sets completed here.
    - A run that ends at N/N posts no unconfirmed list (Task 1's 3/3 session test: the last `todos` message has no `unconfirmed`). A run that never touched the list posts none.
    - The existing parallel sub-agents test: its `lists.slice(4)` expectation gains a fifth entry, 'Task A:completed Task B:completed Task C:pending', and only that last `todos` message carries `unconfirmed: true`. This is a new post with the run's real end state, not a weakened assertion.
    - Task 1's ignored-reminder session test additionally asserts that the last `todos` message has `unconfirmed: true` with A, B and C pending.
    - View (static checks in the style of the last test in taskBoard.test.ts): media/chat/chat.js passes the flag with `renderTodos(m.todos || [], m.unconfirmed === true)` and contains the words "not confirmed done"; media/chat/chat.css has a `#todos .todo.unconfirmed` rule.
  </behavior>
  <action>
    Update the tests first (RED), then implement (GREEN).

    1. src/services/agentSession.ts runTurn: add a `finally` to the inner try that wraps `run.run(...)`. It then runs right after the run settles, for every outcome and before cost reporting. It calls a new private `settleTaskList(tasksAtStart)`: when `this.tasks.revision !== tasksAtStart && this.tasks.unfinished`, post `{ type: 'todos', todos: this.tasks.list, unconfirmed: true }`. The next TodoWrite or `moveTask` post carries no flag, which clears it. ConversationLog already keeps the latest `todos` panel entry, so the flag survives a view reload with no change there.
    2. media/chat/chat.js: `renderTodos(todos, unconfirmed)`. When `unconfirmed` is true, each item that is not completed:
       - gets the extra class `unconfirmed`;
       - shows its `content`, not its activeForm;
       - gets the aria-label 'not confirmed done: ' + content;
       - gets the title "The run ended without this item marked done."
       The header text becomes `Tasks · {done}/{total} · {total - done} not confirmed done`. Without the flag, behavior is exactly as today. In the message switch, `case 'todos'` calls `renderTodos(m.todos || [], m.unconfirmed === true)`. `resetConversation` keeps `renderTodos([])`. Build every node with the existing `el()` helper (textContent) and never with innerHTML, because the item text comes from the model.
    3. media/chat/chat.css: add `#todos .todo.unconfirmed` (normal font weight, italic, description foreground) and `#todos .todo.unconfirmed::before { content: '?'; }`, placed after the in_progress rules so a finished run never keeps the in-progress half-circle or bold text.
  </action>
  <verify>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 npm run compile && systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 node --test dist/test/taskBoard.test.js dist/test/conversations.test.js && grep -q "unconfirmed" media/chat/chat.js && grep -q "todo.unconfirmed" media/chat/chat.css</automated>
  </verify>
  <done>A run that ends with unfinished items posts its real list once more, flagged unconfirmed, and the panel shows "Tasks · d/N · k not confirmed done" with those items marked '?', not in progress. A run that ends at N/N shows N/N struck through with no flag. All taskBoard and conversations tests pass.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| model → host | TodoWrite lists and Agent `task` text are model output (untrusted); the host decides what the panel shows |
| host → webview | item text from the model is rendered in the chat webview |
| host → model | the host injects a `<task-list-check>` message into the model's transcript |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-lbo-01 | Tampering | TaskBoard.find (Task 2) | medium | mitigate | Deterministic steps only (exact, trim/case, number, normalized key, whole-word containment). Steps (d) and (e) need a unique match, and containment needs at least two words. No scored fuzzy matching, so an ambiguous name moves nothing and never marks the wrong item done. Unit tests cover ambiguous and one-word names. |
| T-lbo-02 | Repudiation | run-end reconciliation (Tasks 1 and 3) | medium | mitigate | The host never sets completed except when the sub-agent it tracked finished. The reminder only asks the model. An ignored reminder leaves statuses unchanged, and the list is flagged unconfirmed. Session tests assert that the statuses stay pending. |
| T-lbo-03 | Information disclosure | media/chat/chat.js renderTodos | medium | mitigate | Item text, aria-label and title are set through `el()`/textContent and attributes, never innerHTML. |
| T-lbo-04 | Denial of service | taskListCheck (Task 1) | low | mitigate | At most once per run, only when the list was touched in this run and is still unfinished, and skipped when fewer than two model turns remain. `beforeTurn` still enforces the run budget on the extra turn. |
| T-lbo-05 | Spoofing | `<task-list-check>` message | low | mitigate | `visibleTurns` and `isSyntheticMessage` filter it, so it never appears as something the person typed and is not written to the thread log. |
| T-lbo-SC | Tampering | npm/pip/cargo installs | high | mitigate | No package is installed by this plan. |
</threat_model>

<verification>
Once, after all three tasks, run the targeted set (memory-capped, one run at a time):
systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 npm run compile && systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 node --test dist/test/taskBoard.test.js dist/test/agentFleet.test.js dist/test/agentTools.test.js dist/test/conversations.test.js

The compile step is the type check (`tsc -p tsconfig.json`). The full `npm test` and `npm run test:e2e` belong to the 0.4.20 release boundary (STATE.md release checklist), not to this quick task.

Optional manual look (non-blocking): in the Extension Development Host, give a three-step task to a model that does not update its list. The panel should end at 3/3 after the reminder, or show "k not confirmed done" if the model declines.
</verification>

<success_criteria>
- A scripted run whose work finished ends with the last posted list at N/N, with every item completed (Task 1 session test).
- The host never marks an unfinished item done: an ignored reminder leaves statuses unchanged and flags the list unconfirmed (Tasks 1 and 3 session tests).
- Sub-agent tasks given by number or a light paraphrase move the right item; ambiguous names move nothing (Task 2 tests).
- A host completed survives a stale echo; a model completed always wins (Task 1 TaskBoard tests).
- `forward` has no `todos` branch (grep gate 1 → 0).
- All targeted test files pass; no existing assertion was removed or weakened (the parallel test's expectation only gains its new final unconfirmed entry).
</success_criteria>

<output>
Create `.planning/quick/261113-lbo-fix-the-chat-task-list-not-checking-off-/261113-lbo-SUMMARY.md` when done
</output>

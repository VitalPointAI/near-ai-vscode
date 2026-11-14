---
phase: quick-261113-lbo
plan: 01
subsystem: chat panel / agent session
tags: [task-list, taskboard, chat-view]
requires: []
provides:
  - run-end task-list reminder (one per run, never marks anything done)
  - tolerant, numbered, unique-only sub-agent task matching
  - "not confirmed done" state in the Tasks panel
affects: [src/agent/taskBoard.ts, src/services/agentSession.ts, media/chat/chat.js]
key-files:
  modified:
    - src/agent/taskBoard.ts
    - src/agent/loop.ts
    - src/services/agentSession.ts
    - src/domain/state/threadCapture.ts
    - src/gsd/tools.ts
    - media/chat/chat.js
    - media/chat/chat.css
    - src/test/taskBoard.test.ts
decisions:
  - "The host never marks an item completed itself; an ignored reminder leaves statuses and flags the list unconfirmed"
  - "Sub-agent matching is deterministic (exact, trim/case, number, normalized key, unique whole-word containment); no scored fuzzy matching"
status: complete
commits: 3
plan_head_before: 0d87a89790df86effac9cfff20b6d6994f95a294
plan_head_after: a770848264a19518a1b3bbb07a358936886846c8
actuals:
  tasks: 3
  commits: 3
completed: 2026-11-13
---

# Quick 261113-lbo: Chat task list not checking off Summary

A run whose work finished but whose list was never updated now gets one `<task-list-check>` reminder and ends N/N when the model answers it. If the model does not, the panel shows "k not confirmed done" instead of a silent 0/N.

## Commits

| Task | Commit | What |
| ---- | ------ | ---- |
| 1 | 398e3db | TaskBoard revision and completed-wins rule, DEFAULT_MAX_TURNS, run-end reminder, hidden from visible turns and thread log, `forward` todos branch removed |
| 2 | c3aca9e | Numbered, normalized-key and unique whole-word `find`; Agent tool and prompt text mention the number |
| 3 | a770848 | Run-end unconfirmed `todos` post for every outcome; `renderTodos(todos, unconfirmed)` and CSS |

## Tests

Targeted: taskBoard + agentFleet + agentTools + conversations: 77 tests, 75 pass, 0 fail, 2 skipped (the same 2 skipped before). taskBoard.test.js grew from 5 to 21 tests.

## Deviations from Plan

None in behavior. Notes:
- The tests for each task were written before the implementation but the RED run was not executed separately (a missing `revision` would not compile); the first compile-and-run was after implementation.
- The existing parallel sub-agents test's `lists.slice(4)` gained its fifth entry as the plan specified, plus a check that only the last `todos` post is flagged.
- The CSS `::before` rule for `.unconfirmed` also sets a color so the in-progress color does not leak in; the test matches `content: '?';` accordingly.

## Known Stubs

None.

## Self-Check: PASSED

Commits 398e3db, c3aca9e, a770848 exist on feat/project-state-sync; grep gates met (no `todos: event.todos` post in agentSession.ts, `task-list-check` in threadCapture.ts, `DEFAULT_MAX_TURNS` in loop.ts, `unconfirmed` in chat.js, chat.css and agentSession.ts).

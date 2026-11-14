---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 32
subsystem: chat-task-list
tags: [review-gap-closure, task-board, task-list-reminder]
requires: ["27-29"]
provides:
  - "taskBoard.ts: TaskBoard.find matches by text first (exact, case-insensitive, normalized key, whole-word run) and by number only when nothing else matches"
  - "taskBoard.ts: endsWithQuestion(text) (pure)"
  - "agentSession.ts: afterAnswer sends no task-list reminder after a closing question or while a question to the person is pending"
affects: [27-36]
tech-stack:
  added: []
  patterns: ["a clash between two candidates is no match and never falls through to a weaker step", "a question to the person stays the last thing they see"]
key-files:
  created: []
  modified:
    - src/agent/taskBoard.ts
    - src/services/agentSession.ts
    - src/test/taskBoard.test.ts
key-decisions:
  - "Two same-key or two whole-word candidates return no match and do not reach the number step, so find('Task 1') on two 'Task 1: ...' items moves nothing instead of the first item."
  - "The closing-question check looks at the last assistant message's text only (the transcript's content is a string); closing quotes, brackets, asterisks, underscores and backticks after the question mark are set aside, ASCII and full-width question marks both count."
requirements-completed: [SYNC-08]
status: complete
commits: 2
plan_head_before: 39dfded1225b06257df03d70c6abf479f7c9a9e0
plan_head_after: 1f0321b3ea415741ae9f6f16a7a091b99ba901ab
actuals:
  tokens: 3500
  tasks: 2
  commits: 2
completed: 2026-11-13
---

# Phase 27 Plan 32: Task matching by text first, and no reminder after a question Summary

A sub-agent's task now names its list item by text before position, so "Task 1" is the item "Task 1: create schema" and not the first item, and the run-end task-list reminder is skipped when the answer ends with a question or a question is waiting.

## What changed

**Task 1 (tracer), commit 7c494bc.** `TaskBoard.find` ran the number step (c) right after the exact and case-insensitive steps, so `find('Task 1')` on `['Read the plan', 'Task 1: create schema']` returned the first item and a sub-agent finishing "Task 1" would have checked off the wrong one (REVIEW MAJOR taskBoard.ts:61, a fix of quick task 261113-lbo). The order is now exact content, content ignoring case and surrounding space, normalized key (one item), whole-word run (one item), and only then the number. Two or more candidates at the key or whole-word step return nothing and do not fall through to the number. The doc comment states the new order. New tests: the "Task 1: create schema" regression (and that the first item stays pending), the number still working when no text matches (`2`, `#2`, `item 2`, `task 2`, `no. 2`; `3` on two items is undefined), text winning over position, and two whole-word or same-key matches naming nothing. Four of the new tests failed against the old `find` before the change.

**Task 2, commit 1f0321b.** `endsWithQuestion(text)` in `taskBoard.ts` trims trailing white space and any run of closing quotes, brackets, asterisks, underscores and backticks, then checks for a `?` or full-width `？`. In `agentSession.ts`, `afterAnswer` now takes the transcript, and after the background wait and the already-sent check it returns undefined (no reminder, `taskCheckSent` unchanged) when `this.questions` holds a pending question or the last assistant text ends with a question (REVIEW MINOR agentSession.ts:408). The reminder itself and `settleTaskList` are untouched, so the list is still posted once more as "not confirmed done". New tests: the pure check (nine true and six false texts), a scripted run ending "Should I start B now?" (two requests, no reminder, list flagged unconfirmed), a mid-text question that still gets its one reminder, and a run with a pending question seeded into the session's questions map (no reminder).

## Verification

- `node --test dist/test/taskBoard.test.js`: 25 tests, 25 pass (after Task 1).
- `node --test dist/test/taskBoard.test.js dist/test/agentLoop.test.js dist/test/chatSendPath.test.js`: 47 tests, 47 pass, 0 fail (after Task 2).
- `npm run lint`: exit 0.
- All runs under the memory-cap wrapper, one at a time.

## Deviations from Plan

None - plan executed as written. One small test seam was added to the existing `scripted` helper in `taskBoard.test.ts` (an optional `onRequest(n, conversation)` hook) so the pending-question test can seed the session's questions map; the plan allowed "a test seam on the session's questions map".

## Threat model

T-27-130 (wrong item marked done because a position won over text) and T-27-131 (extra paid turn after a closing question) are mitigated as planned. No new surface; no threat flags.

## Known Stubs

None.

## Self-Check: PASSED

- src/agent/taskBoard.ts, src/services/agentSession.ts, src/test/taskBoard.test.ts: present.
- Commits 7c494bc and 1f0321b are ancestors of HEAD.

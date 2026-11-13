---
title: Chat task list does not check off finished tasks
created: 2026-11-13
area: chat panel / agent session
release: 0.4.20
source: owner report
---

## Problem

The chat panel's task list ("Tasks · 0/3") stays at 0 done after every task in it has finished. The owner saw a live case: 0 of 3 completed while all three were done. Each task must be checked off and struck through as it finishes.

## What the code does today (read-only look, 2026-11-13)

- The view already renders done items struck through: `media/chat/chat.js` renderTodos (≈ line 710) counts `status === 'completed'`, and `media/chat/chat.css:227` gives `.todo.completed` a line-through. So rendering is fine; the statuses that reach it are stale.
- Only two sources change a status:
  1. The main agent's own TodoWrite (`src/agent/tools.ts:466`, then `agentSession.ts:414` → `TaskBoard.write`).
  2. A sub-agent spawned with a matching `task` (`agentSession.ts:807/918/925` → `moveTask` → `TaskBoard.set`). It only moves when `spawn.task` matches an item's content (exact or case/space-insensitive); otherwise `moveTask` returns undefined and nothing moves.
- Nothing marks tasks done when the main agent does the work itself and never sends a final TodoWrite, and nothing reconciles the list when the run ends.
- `TaskBoard.write` echo rule: if the model resends its stale list, a host mark wins. Worth a test that a host "completed" survives a stale echo AND that the model's explicit completed always wins.
- The panels are replayed from `ConversationLog` (`src/services/conversations.ts:91`, latest state only). A reload shows whatever was last posted, so a stale list persists across reloads.

## Suspects to confirm with a reproduction

1. The model finishes the work but does not send a last TodoWrite (most likely for 0/N at the end).
2. A sub-agent's `task` text does not match the item's content (paraphrase), so `moveTask` misses.
3. `agentSession.ts:1185` forwards `todos` events unchanged through `forward` (bypassing TaskBoard) on some path, overwriting a host-moved list.

## Fix direction (to decide in planning)

- Make the list follow finished work: match sub-agent tasks more tolerantly, or by id instead of text.
- At run end, when the list still has unfinished items, ask the model once to update it, or show the items as "not confirmed done" rather than silently 0/N. Never mark items done that did not finish.
- Regression tests: TaskBoard unit tests plus a session-level test that a run whose work completes ends with N/N struck through.

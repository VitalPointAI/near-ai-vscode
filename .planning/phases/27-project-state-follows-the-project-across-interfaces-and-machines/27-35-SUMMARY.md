---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 35
subsystem: panel-participant-redaction-names
tags: [review-gap-closure, history-queue, chat-participant, redaction, gh-arguments]
requires: []
provides:
  - "chat.js: scheduleHistory uses an animation frame only while visible and a timer otherwise; a visibilitychange to hidden moves a pending frame to a timer"
  - "participantRecorder.ts: ResponseRecorder.answer/markdown/notes, finish(outcome) -> { text, notes, outcome }, ParticipantTurnInput.notes, USAGE_FOOTER_TAIL"
  - "redaction.ts: recovery-code patterns that need a Crockford letter outside 0-9 and A-F"
  - "onlineHome.ts (domain): validateRepoName refuses a leading '-'"
affects: [27-36]
tech-stack:
  added: []
  patterns: ["what the extension adds to a reply is a notice, never a model message", "a narrower pattern is justified by the chance a real secret slips through (2^-52)"]
key-files:
  created:
    - src/test/hiddenViewHistory.test.ts
    - src/test/onlineHomeNames.test.ts
  modified:
    - media/chat/chat.js
    - src/services/participantRecorder.ts
    - src/services/chatParticipant.ts
    - src/test/participantRecord.test.ts
    - src/domain/redaction.ts
    - src/test/stateRecovery.test.ts
    - src/domain/state/onlineHome.ts
key-decisions:
  - "The Chat view's own history rebuild (historyFromChatContext) also drops a trailing usage footer, so the model in the Chat view does not read it either (same class of finding as the stored thread)."
  - "threadWithTail compares the stored reply plus the notes notices after it with VS Code's reply text, so a restored reply without metadata still finds its thread now that the footer is a separate notice."
  - "Spaces between recovery-code groups are not added to the redaction patterns: eight four-letter lower-case words in a row would match prose."
requirements-completed: [SYNC-01, SYNC-04, SYNC-09]
status: complete
commits: 3
plan_head_before: 438dfcf3401a8b9e10857e10ed1ae5ece830cb00
plan_head_after: f5724aabb29098439bfff17db075813af051c4e9
actuals:
  tokens: 12500
  tasks: 3
  commits: 3
completed: 2026-11-13
---

# Phase 27 Plan 35: Hidden-view history, participant notes, hex digests and repository names Summary

A hidden chat view still drains its history queue on a timer, the Chat view keeps the model's text apart from the footer and error text it also showed, upper-case hex digests survive redaction, and a repository name starting with '-' never reaches gh.

## What changed

**Task 1 (tracer), commit 8273a8f.** `scheduleHistory` asked for `requestAnimationFrame` only, which a hidden webview never runs, so a reopened conversation and every approval, question and live event queued behind it waited until the person looked at the view. It now uses a frame only while `document.visibilityState` is `'visible'` and `setTimeout(drawHistory, 0)` otherwise. A `visibilitychange` to hidden with a frame pending cancels it and schedules the timer. `dropHistory` cancels either kind. `drawHistory` and `holdForHistory` are unchanged, so slices of 50 and the order of held messages stay as they were. The new `hiddenViewHistory.test.ts` runs the real chat.js in a vm page (copied from the Check now harness) whose frames run only when the test says so: a hidden view draws 120 items and shows the approval behind them; a visible view draws 50 per frame and never falls back to a timer; a view hidden mid-queue finishes on timers; a view coming back to visible draws each item once. Against the old chat.js two of the four fail.

**Task 2, commit 9bebede.** `ResponseRecorder` has `answer(value)` for the model's text and `markdown(value)` for everything else the person read; `text()` is the first, `notes()` the second, and `finish(outcome)` returns `{ text, notes, outcome }`. `answerWithNearAi` streams model text through `answer`; the footer, provider errors, guard sentences and setup hints stay on `markdown`. The handler calls `finish` and passes both to `recordParticipantTurn`, which stores the assistant entry from the text, then one notice with the notes (`forContext: false`), then the stopped notice. A failed reply that is only error text has no assistant entry. A command turn's notice repeats text plus notes, as before. `USAGE_FOOTER_TAIL` (blank line, one italic line of ' · ' parts) lets `seedEntries` move a legacy footer into a notice after its reply, and `historyFromChatContext` drop it before the model reads it. `threadWithTail` compares the stored reply plus the notes notices that follow it with VS Code's text, so a restored reply with no metadata still finds its thread.

**Task 3, commit f5724aa.** Both recovery-code patterns gained a lookahead that needs at least one Crockford letter outside 0-9 and A-F, so SHA-256, SHA-1 and git object ids (all hex) are no longer redacted in upper case, whole or split into groups of four, while a generated code (all hex with chance 2^-52, a 32-character piece 2^-32) still is. `validateRepoName` refuses a name that starts with '-'; `createRepo` already checks it before calling gh, so a name like '--help' runs nothing. `repoNameFromFolder` already stripped a leading '-', and now has a test.

## Verification

Run one at a time under the memory cap (4G, no swap, choom 1000, timeout 900, 1536 MB heap).
- Task 1 command (hiddenViewHistory, threadReplay, checkNow, sidebarChat): 55 tests, 55 pass, 0 fail. 4 new hiddenViewHistory tests.
- Task 2 command (participantRecord, threadLog, threadReplay) plus sidebarChat: 75 tests, 75 pass, 0 fail. 5 new or rewritten participantRecord tests (the footer test and the plain-reply test were rewritten for the new shape and keep their intent).
- Task 3 command (stateRecovery, onlineHomeNames, handoffRedaction, policy, cyberSarif, onlineHome) plus syncFlows: 119 tests, 119 pass, 0 fail. 2 new stateRecovery tests, 3 new onlineHomeNames tests.
- `npm run lint` (`tsc --noEmit`): exit 0.
- Acceptance greps: `visibilityState` in chat.js 2 lines (at least 1); `response.answer(` in chatParticipant.ts 1; `.finish(` in chatParticipant.ts 1.

## Deviations from Plan

### Auto-added

**1. [Rule 2 - Missing critical functionality] The Chat view's own history rebuild still sent the footer to the model.** `historyFromChatContext` reads VS Code's own turns, which still hold the footer after a reply. It now removes a trailing `USAGE_FOOTER_TAIL`, so the model never reads the extension's footer from that route either (the finding is about the class, not only the stored thread). Test added in participantRecord.test.ts.
- **Files modified:** src/services/chatParticipant.ts, src/test/participantRecord.test.ts
- **Commit:** 9bebede

**2. [Rule 1 - Bug] A restored reply without metadata would no longer find its thread.** `threadWithTail` compared the stored assistant text with VS Code's reply, footer included; with the footer moved into a notice they differ. It now joins the assistant text and the notes notices that follow it (after skipping the stopped notice). The existing exact-tail tests still pass and a new one covers the footer case.
- **Files modified:** src/services/participantRecorder.ts
- **Commit:** 9bebede

### Interpretation

- The plan's behavior line "the same with spaces and in lower case" was read as "the shown form, and the same in lower case": a space-separated code was never redacted by these patterns, so it is not a case of "still". Adding spaces as a group separator would match eight four-letter lower-case words in prose. The tests cover the shown form, lower case, unformatted, 32-character pieces, a 36-character middle piece and eight groups.
- `repoNameFromFolder` needed no code change (it already stripped a leading '-' and fell back to 'project'); only its test was added.
- `systemGhCli.createRepo` needed no change: it already calls `validateRepoName` before `exec`.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- src/test/hiddenViewHistory.test.ts, src/test/onlineHomeNames.test.ts: found.
- Commits 8273a8f, 9bebede, f5724aa: ancestors of HEAD.

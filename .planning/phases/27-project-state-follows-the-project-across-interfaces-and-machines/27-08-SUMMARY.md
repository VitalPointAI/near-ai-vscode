---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 08
subsystem: state-sync
tags: [chat-participant, stream-recorder, thread-identity, seeding, tail-match, open-thread, d-07, pitfall-16]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-05 ThreadStore (create, appendEntries, lines, index, meta, restore from the log), threadView.entriesToMessages and entriesToView; 27-06 history list with the Chat view label and reopen path; 27-07 retention that never deletes a thread"
provides:
  - "src/services/participantRecorder.ts: PARTICIPANT_ID, isThreadId, ResponseStreamLike, ResponseRecorder (markdown, button, progress, text, finish), ReplyOutcome, ParticipantTurnLike, SeedItem, seedEntries, commandNoticeText, PARTICIPANT_STOPPED_NOTICE, resolveParticipantThread, recordParticipantTurn, recordSeed, openThreadInPanel"
  - "src/services/chatParticipant.ts: ParticipantResult.metadata.threadId, the reply button nearAi.openThread, recording gated by nearAi.agent.saveTranscripts, outcome of each reply (completed, cancelled, failed, not-sent)"
  - "src/extension.ts: command nearAi.openThread (argument: thread id), not in the Command Palette"
  - "src/services/threadStore.ts: load() rebuilds the context of a thread that has a log and no saved context from the log's main line"
  - "src/services/agentSession.ts: a run adds the panel's system prompt first to any history that has none"
affects: [27-10, 27-13, history-view, chat-participant]

requirements-completed: [SYNC-01]

actuals:
  tokens: 11000
  tasks: 2
  commits: 3
plan_head_before: bfc421ca62a7cc93ce2edcf6fc50d2d01cdca9ef
plan_head_after: c0ae9d18879ba1aa5149473b4864106814455a10

tech-stack:
  added: []
  patterns:
    - "A stream recorder wraps the VS Code response stream: it forwards every call and keeps the markdown exactly as sent, so the stored reply is what the person read, usage footer included; recording is done after the reply, from the recorder, never from the 20-turn history the model sees"
    - "Thread identity rides in ChatResult.metadata.threadId, checked against the thread-id pattern before use; without it a reply joins an existing thread only on an exact tail match (newest live Chat view thread: its last assistant text and the user text before it equal the newest exchange), otherwise a new thread starts and nothing existing is written"
    - "Entries are chained from the thread's main-line tip with the same hash-chain ids as the panel, so a participant thread merges, archives and syncs like any other"

key-files:
  created:
    - src/services/participantRecorder.ts
    - src/test/participantRecord.test.ts
  modified:
    - src/services/chatParticipant.ts
    - src/extension.ts
    - src/services/threadStore.ts
    - src/services/agentSession.ts

key-decisions:
  - "A prompt that never reached the model (no folder, no profile, the outbound guard held it back) is not stored; the guard exists to keep a flagged prompt from leaving, so it is not written to disk either. The session still gets its thread id, and a pre-0.4.20 session's one-time seed is stored even then"
  - "The tail match also requires the user text before the matched reply to equal the newest prompt, and it looks only at the newest Chat view thread when that thread is live: an archived one is never read for a guess (reading it would bring it back and reorder the history). Both make a match harder, never easier, in line with 'when unsure, start a new thread'"
  - "A /gsd command turn is stored as one notice ('You ran /gsd-x args in the Chat view.' plus the reply) with body.forContext false; notices are never model messages (entriesToMessages already skips them)"
  - "A thread begun in the Chat view has a log and no context.enc, so reopening it in the panel needed ThreadStore.load to build the context from the log's main line (the same rebuild a thread continued elsewhere gets) and a run to add the system prompt when the history has none"
  - "openThreadInPanel (focus the view, then resume-conversation) lives in participantRecorder.ts with a structural panel type so the id check and the order of calls are tested on plain node; extension.ts only supplies the real view"

coverage:
  - id: D1
    description: "Every participant turn (prompt and reply exactly as streamed, usage footer included) is appended to a chat-view thread; thirty turns are all stored (sixty entries) while historyFromChatContext still returns twenty"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#thirty turns are all stored while the model is shown only the last twenty"
        status: pass
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a streamed reply with its usage footer is stored as one prompt and one reply in a Chat view thread"
        status: pass
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a plain reply is stored exactly as streamed with its footer, a cancelled one with a notice, and a failed one with the error text and a notice"
        status: pass
    human_judgment: false
  - id: D2
    description: "The thread keeps its id across turns through ChatResult.metadata.threadId; a value that is not a thread id (path-like, wrong type) is never used"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#the thread id rides in the newest reply, so the next turn continues the same thread, and a first request starts a new one"
        status: pass
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a metadata value that is not a thread id is never used"
        status: pass
    human_judgment: false
  - id: D3
    description: "A session from before 0.4.20 is seeded once from the full history (before the 20-turn slice), commands as notices, other participants left out; the next turn does not seed again, also when the first request itself was not sent"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a session that began before turns were recorded is seeded once, from the full history, and not again"
        status: pass
      - kind: unit
        ref: "dist/test/participantRecord.test.js#seeding turns a command into a notice that does not feed the model"
        status: pass
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a prompt that never reached the model is not stored, and the session still gets its thread id"
        status: pass
    human_judgment: false
  - id: D4
    description: "Prohibition (SYNC-01): with no metadata a reply joins an existing thread only on an exact tail match; one character different, or the same reply under another prompt, starts a new thread and leaves the existing one unchanged"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a reply without metadata joins a thread only on an exact tail match, and otherwise starts a new thread"
        status: pass
    human_judgment: false
  - id: D5
    description: "A cancelled or failed reply is stored with what was streamed plus the notice 'The reply stopped before it finished.'; a /gsd command turn is one notice with forContext false; neither feeds the model"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a cancelled or failed reply is stored with what was streamed and a notice, and the notice does not feed the model"
        status: pass
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a /gsd command turn is one notice that does not feed the model"
        status: pass
      - kind: unit
        ref: "dist/test/participantRecord.test.js#the participant records a /gsd command turn, returns its thread id and offers the button that opens it in the panel"
        status: pass
    human_judgment: false
  - id: D6
    description: "With nearAi.agent.saveTranscripts off nothing is recorded: no thread id, no button, and the state home is not created"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#with nearAi.agent.saveTranscripts off nothing is recorded, no thread id is returned and nothing is created in the project"
        status: pass
    human_judgment: false
  - id: D7
    description: "A Chat view thread reopens in the panel of another editor with every prompt, reply and notice in order, and the next message continues the same thread with the panel's system prompt first and no notice sent to the model"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#a Chat view thread reopens in the NEAR AI panel of another editor with its whole history, and the next message continues it"
        status: pass
    human_judgment: false
  - id: D8
    description: "nearAi.openThread focuses the panel and reopens the thread through resume-conversation, refuses an id that is not a thread id before either call, is registered in extension.ts and is not contributed to the Command Palette"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/participantRecord.test.js#nearAi.openThread shows the panel and reopens the thread, and refuses an id that is not a thread id"
        status: pass
    human_judgment: false
  - id: D9
    description: "Chat view metadata (threadId) survives a VS Code Chat session restore after a reload (assumption A15), and the reply button looks and behaves right in the Chat view"
    requirement: SYNC-01
    verification: []
    human_judgment: true
    rationale: "No test drives VS Code's real Chat view. Whether the editor keeps ChatResult.metadata when it restores a session was not checked in an extension host (research A15); the tail-match and new-thread fallbacks exist so a lost id forks a thread instead of overwriting one"

duration: 6min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 08: The @near chat participant's conversations in the state home Summary

**Every @near turn is appended, exactly as streamed with its usage footer, to a chat-view thread in the project's state home whose id rides in ChatResult.metadata. A session from before 0.4.20 is seeded once from the full history, a lost id never overwrites a thread (exact tail match or a new thread), and a button under each reply reopens the thread, with every message, in the NEAR AI panel of any editor.**

## Performance

- **Duration:** about 6 min (15:43 to 15:49 UTC)
- **Tasks:** 2 (1 tracer, 1 TDD)
- **Files modified:** 6 (2 created, 4 modified), 737 insertions and 25 deletions

## Accomplishments

- `ResponseRecorder` wraps the response stream: it forwards markdown, buttons and progress untouched and keeps the markdown text exactly as sent. The handler records after the reply with `recordParticipantTurn`, which chains the prompt and the reply onto the thread's main line (same hash-chain ids as the panel) and creates the thread with origin `chat-view` and the first 80 characters of the first prompt as its title. The model's 20-turn window in `historyFromChatContext` is unchanged: thirty recorded turns are sixty entries.
- Thread identity (Pitfall 16): the handler returns `{ metadata: { command?, threadId } }`. `resolveParticipantThread` reads the id from the newest reply (checked against the thread-id pattern), starts a new thread for a first request, seeds a session from before 0.4.20 once from the full history (commands become notices, other participants are left out), and for a reply whose metadata was lost joins a thread only on an exact tail match, else starts a new one. The existing thread is never written on a weak match.
- A cancelled or failed reply keeps what was streamed and a notice "The reply stopped before it finished." A /gsd command turn is one notice (never sent to the model). A prompt that never reached the model is not stored. With `nearAi.agent.saveTranscripts` off the handler records nothing, returns no thread id and creates nothing in the project.
- The reply button "Open this chat in the NEAR AI panel" calls `nearAi.openThread`, which validates the id, focuses the panel and posts `resume-conversation`. Reopening needed two supporting changes (below): a Chat view thread has a log and no saved context, so `ThreadStore.load` now rebuilds the context from the log, and a run adds the system prompt when the history has none. The history picker already labelled `chat-view` threads from plan 06.

## Task Commits

1. **Task 1: Tracer, a participant turn is recorded and the id survives the next turn** - `451a35c` (feat). Tracer verified end to end (2 tests, then the 42-test related run) before expansion.
2. **Task 2 RED: 30 turns, seeding, tail match, cancel, slash notices and the handler wiring** - `0f80978` (test). Six failed for the intended reasons (seeding returned nothing, no tail match, a stopped reply and a command stored as plain turns).
3. **Task 2 GREEN: every Chat view turn is kept, joined safely, seeded once and reopens in the panel** - `c0ae9d1` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md, ROADMAP.md and REQUIREMENTS.md.

## Verification

- `npx tsc -p tsconfig.json` and `npm run lint`: clean.
- `node --test dist/test/participantRecord.test.js`: 15 tests, 0 failing.
- Related run (threadLog, conversations, threadArchive, historyRetention, sidebarChat, participantRecord, privacy, agentFleet, chatSendPath, spendSendPath, steering, autoResume, runRecovery): 161 tests, 160 pass; the one failure is the known chatSendPath "GSD slash command" (reads the real home Teams library on this machine).
- Acceptance greps: `from 'vscode'` in participantRecorder.ts is 0; `threadId` in chatParticipant.ts is 8 (baseline 0); `nearAi.openThread` in extension.ts is 1 (baseline 0).

## Files Created/Modified

- `src/services/participantRecorder.ts` - recorder, thread resolution, seeding, recording, `openThreadInPanel`; structural types only
- `src/services/chatParticipant.ts` - handler wiring, reply outcome, `threadId` metadata, the open-thread button
- `src/extension.ts` - `nearAi.openThread`
- `src/services/threadStore.ts` - `load()` builds a context from the log when there is none
- `src/services/agentSession.ts` - the system prompt is added first when the history has none
- `src/test/participantRecord.test.ts` - 15 tests

## Decisions Made

See `key-decisions` in the frontmatter. In short: nothing is stored for a prompt that never reached the model; the tail match is stricter than the plan states and skips archived threads; a command is one non-context notice; reopening a Chat view thread in the panel rebuilds its context from the log.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A Chat view thread could not be reopened in the panel**
- **Found during:** Task 2 (the reopen test was written red first)
- **Issue:** `AgentConversation.restore` returns nothing when `ThreadStore.load` finds no `context.enc`, and a participant thread only has a log. The plan's goal (the button reopens the thread with its full history) was unreachable without a change in the store.
- **Fix:** `ThreadStore.load` builds a `Transcript` from the log's main line (`entriesToMessages`, `basedOnTip` set, covered) when the context file is missing or unreadable and the log has entries. A thread this device cannot open still returns nothing.
- **Files modified:** `src/services/threadStore.ts`
- **Verification:** `a Chat view thread reopens in the NEAR AI panel of another editor...` plus the 161-test related run
- **Committed in:** `c0ae9d1`

**2. [Rule 1 - Bug] A rebuilt history has no system prompt, and the run only added one to an empty history**
- **Found during:** Task 2 (same test: the model would have been sent history with no system prompt)
- **Issue:** `runTurn` added the system prompt only when `messages` was empty.
- **Fix:** it adds it first whenever `messages[0]` is not a system message (identical behaviour for an empty list and for every context a run saved, which starts with one).
- **Files modified:** `src/services/agentSession.ts`
- **Committed in:** `c0ae9d1`

**3. [Rule 2 - Missing critical] A held-back prompt must not be written to disk**
- **Found during:** Task 2, handler wiring
- **Issue:** recording every turn would have stored a prompt the outbound guard refused to send, and replies like "no profile yet" as if they were conversation.
- **Fix:** `answerWithNearAi` reports an outcome; `not-sent` stores nothing except a pre-0.4.20 session's one-time seed (`recordSeed`).
- **Files modified:** `src/services/chatParticipant.ts`, `src/services/participantRecorder.ts`
- **Committed in:** `c0ae9d1`

**4. [Rule 2 - Missing critical] Tail match stricter than the plan states**
- **Found during:** Task 2 design (Pitfall 16, the plan's prohibition)
- **Issue:** a match on the last reply alone is weaker than "exact tail" for short or repeated replies, and reading an archived thread for a guess would bring it back and reorder the history.
- **Fix:** the user text before the matched reply must also equal the newest prompt, and only a live newest Chat view thread is considered.
- **Files modified:** `src/services/participantRecorder.ts`
- **Committed in:** `c0ae9d1`

---

**Total deviations:** 4 auto-fixed (1 Rule 1, 2 Rule 2, 1 Rule 3). **Impact on plan:** all needed for the plan's own goals and prohibition; `threadStore.ts` and `agentSession.ts` were not in the plan's file list. The API differs in small ways from the artifact sketch: `seedEntries` returns draft items (`{ role, body }`) that `recordParticipantTurn` chains, since entry ids need the writer and parent that only the recorder knows, and `recordParticipantTurn` takes `reply` as text with `stopped?`, `command?` and `seed?` instead of an `origin`.

**TDD note (Task 2):** the RED commit is partly red. The 30-turn, bad-id and saveTranscripts-off tests already passed from the tracer (the tracer stores every turn, `isThreadId` and the setting gate were part of it); the other six failed for the intended reasons. The reopen-in-the-panel test was added after the RED commit and was seen red (restore returned nothing) before the store fix, but is committed together with its fix.

## Known Limits

- Whether VS Code keeps `ChatResult.metadata` across a reload (research A15) was not checked in an extension host. If it does not, a restored session forks into a new thread (tail match, else new thread) and nothing is overwritten; the owner may want to confirm by hand.
- A Chat view thread reopened in the panel continues with the panel's model and tools; its saved context is only its user and assistant messages.
- The tail match ignores an archived newest Chat view thread, so a session restored without metadata after that thread was archived starts a new thread.
- An unvalidated plain-prompt wiring remains in the real provider path (`activeProvider`, spend ledger): the tests use a stand-in provider and stream.

## Issues Encountered

None beyond the deviations. `.planning/state.json` was already modified before this plan and was left alone. The `chatSendPath` "GSD slash command" failure is the known machine-specific one.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 10 (migration) and plan 13 (sync) see participant threads as ordinary threads: same entry ids, same log, origin `chat-view`. The reopen path in the panel works for any thread that has a log and no context.

## Known Stubs

None.

## Threat Flags

None. The new surface is the command argument and the chat metadata id, both covered by T-27-31 (pattern checked in `isThreadId`, again by `ThreadStore` before a path is built); T-27-32 (exact tail match, otherwise a new thread) and T-27-33 (the same encrypted store, gated by `nearAi.agent.saveTranscripts`) are mitigated.

## Self-Check: PASSED

- Files: `src/services/participantRecorder.ts`, `src/test/participantRecord.test.ts` exist.
- Commits `451a35c`, `0f80978`, `c0ae9d1` are ancestors of HEAD; `git rev-list --count bfc421c..HEAD` is 3.
- Plan verification: tsc clean; participantRecord 15 of 15; related run 160 of 161 (the known failure).

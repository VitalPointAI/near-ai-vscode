---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 05
subsystem: state-sync
tags: [thread-log, append-only, aead, compaction, conversation-history, state-home, locked-listing, no-prune]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-02 threadEntries.ts (entryId, unionEntries, threadLines, threadTip, capToolResult); 27-03 stateHome.ts and stateKeys.ts (state home, data key, transcript subkey); 27-04 editorWriter and state-home run stores"
provides:
  - "src/domain/state/threadCapture.ts: contentKey (moved from agentSession.ts), COMPACTION_ACK, isSyntheticMessage, commandForm, messagesToEntries"
  - "src/domain/state/threadView.ts: ViewTurn, entriesToTurns (basic), entriesToMessages"
  - "src/services/threadStore.ts: ThreadOrigin, ThreadMeta, mergeMeta, ThreadStore (save, checkpoint, load, list, appendEntries, entries, lines, meta, index, create, captureTranscript, cover), threadStoreFor"
  - "src/services/transcripts.ts: ConversationStore interface, TranscriptSummary.locked, Transcript.basedOnTip; the fifty-conversation cap and its removal step are gone"
  - "AgentConversation: logged WeakSet, captureThread before manageContext and on every save, restore from the log with a context rebuild after a continuation elsewhere"
affects: [27-06, 27-07, 27-08, 27-10, 27-12, sync, migration, history-view, chat-participant]

requirements-completed: [SYNC-01]

actuals:
  tokens: 20300
  tasks: 3
  commits: 4
plan_head_before: 403aa4269d7101494f5b3d412a98edf2dafef71c
plan_head_after: 0ca452d6337763ecb0d27dd472187f9126f963f2

tech-stack:
  added: []
  patterns:
    - "The thread log is written from the originals before the model's context is trimmed or compacted; the model's working list is a separate file (context.enc) that still drives resume"
    - "A per-conversation WeakSet of logged message objects plus hash-chain entry ids: a message is written once, and re-chaining the same messages from the start reproduces the same ids, so nothing is written twice"
    - "A store remembers the last entry each conversation wrote or was opened at (cover) and chains new entries from it, so a thread continued elsewhere becomes a labelled branch rather than interleaving"
    - "Sealed line log: one AEAD envelope per line, AAD binds state id, 'thread-entry' and thread id, one appendFile per batch, a torn or foreign line is skipped, and a torn last line gets a newline before the next batch"

key-files:
  created:
    - src/domain/state/threadCapture.ts
    - src/domain/state/threadView.ts
    - src/services/threadStore.ts
    - src/test/threadLog.test.ts
  modified:
    - src/services/agentSession.ts
    - src/services/transcripts.ts
    - src/services/chat.ts
    - src/extension.ts
    - src/test/conversations.test.ts

key-decisions:
  - "ThreadStore keeps a body-less skeleton (id, parent, at, writer, role) of each thread's log in memory and reads new bytes incrementally, so chaining a batch to the tip never re-decrypts the whole log; lines() and entries() read the file fresh"
  - "New entries chain from the entry the conversation last wrote or was opened at (ThreadStore.cover), not from the log's current main-line tip, so another editor's concurrent continuation becomes a branch instead of being silently adopted into this conversation's lineage"
  - "A store that knows nothing about a conversation chains the messages from the start of the thread; the entry ids are the same hash chain, so messages already in the log are recognised by id and not written twice"
  - "captureTranscript writes nothing, and creates no state home, when the unlogged messages are all synthetic (a conversation holding only its system prompt)"
  - "A capture failure never stops a run: the messages stay unlogged and the next call retries; managed (trimmed or summarised) messages are marked logged only when their originals were captured"
  - "The old transcript store lists a file it cannot open as locked with its id (any undecodable file, not only wrong-key ones), and no longer deletes anything; it keeps its key helpers for the migration in plan 10"
  - "threadStoreFor accepts an absent secret store (hosts and test doubles without one) and then relies on the key file in the state home; production always has secrets"

coverage:
  - id: D1
    description: "A conversation compacted mid-run keeps every user message the person typed, in order, every assistant reply, every tool call and the untrimmed tool results in the thread log; the log never holds a summary, the acknowledgement, the system prompt or a trimmed copy"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#a conversation compacted mid-run keeps every message the person typed, in order, in the thread log"
        status: pass
    human_judgment: false
  - id: D2
    description: "Re-capturing the same messages, the compacted list, or the same thread from a second store with an empty logged set appends nothing"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#capturing the same messages again, or the compacted list, appends nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "A real AgentConversation run that compacts reopens through restore() with all twelve typed messages and twelve assistant turns from the log, while the saved working list holds fewer user messages"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#a compacted conversation reopens with every user turn, from the log, and still continues from its saved context"
        status: pass
    human_judgment: false
  - id: D4
    description: "Log, context and meta are sealed on disk (no plaintext) and the log is owner-only (T-27-20)"
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#the log and the context hold no plaintext on disk"
        status: pass
    human_judgment: false
  - id: D5
    description: "Saving never deletes: sixty conversations are kept by the thread store and by the old transcript store (D-08)"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#saving never deletes a conversation: sixty are kept by the thread store and by the old transcript store"
        status: pass
    human_judgment: false
  - id: D6
    description: "A conversation this device cannot open is listed as locked with its id (old store and thread store), does not open, and exposes no entries (Pitfall 7)"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#a conversation this device cannot open is listed as locked, never dropped"
        status: pass
    human_judgment: false
  - id: D7
    description: "D-12: a 3 MiB tool result is stored at the 2 MiB cap with shortenedBytes 3 145 728 and a 1.5 MB result is stored whole"
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#D-12: a 3 MiB tool result is stored shortened with its size, and nothing else is shortened"
        status: pass
    human_judgment: false
  - id: D8
    description: "D-13: a run with a sub-agent logs exactly user, tool-call, tool-result (the sub-agent's report), assistant; the sub-agent's own prompt and turns are not logged"
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#D-13: a sub-agent adds no entries of its own; its report is the lead agent's tool result"
        status: pass
    human_judgment: false
  - id: D9
    description: "A thread continued on another computer after the context was saved reopens with the continuation in the working context (system prompt kept first, earlier history kept), the next message extends the main line, and no entry is lost"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#a thread continued on another computer reopens with the continuation in its working context, and nothing is lost"
        status: pass
    human_judgment: false
  - id: D10
    description: "A second editor on the same host with its own empty SecretStorage lists the first editor's conversation with the same title and turns, identical lines(), the saved context, and reopens it"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#a second editor on the same host lists and reopens the conversation the first editor saved"
        status: pass
    human_judgment: false
  - id: D11
    description: "One store per project and secret store; looking at an untouched project, or a conversation with nothing to record, creates nothing in it; the first message creates the state home; a host with no secret storage still keeps conversations via the key file"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadLog.test.js#the shared store is one per project, and looking at a project writes nothing; a host with no secret storage still keeps conversations, through the key file in the state home"
        status: pass
    human_judgment: false
  - id: D12
    description: "The history picker shows a locked conversation as 'Locked conversation' with the recovery-code detail and does not open it (UI string)"
    requirement: SYNC-01
    verification: []
    human_judgment: true
    rationale: "showHistory is VS Code QuickPick code that no unit test drives; the wording and the behaviour of declining to open a locked item were reviewed by reading, not run"

duration: 10min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 05: Full thread history in the state home Summary

**Every panel conversation is written message by message into a sealed, append-only thread log in the project's state home before the model's context can trim or summarise it, listed and reopened from the log by every editor on the host, never pruned, and shown as locked rather than dropped when its key is missing.**

## Performance

- **Duration:** about 10 min (14:46 to 14:56 UTC)
- **Tasks:** 3 (1 tracer, 1 TDD, 1 auto)
- **Files modified:** 9 (4 created, 5 modified), 1 037 insertions and 43 deletions

## Accomplishments

- The log is captured at the top of the main run's `beforeTurn`, before `manageContext`, and again on every save and mid-run checkpoint. A 12-turn conversation with tool calls, trimmed and compacted, still has all 12 typed messages, every reply, every call and the untrimmed results in the log; no `<conversation-summary>`, acknowledgement, system prompt or trimmed copy ever reaches it. The same holds through a real `AgentConversation` run whose context compacted: reopening shows 12 user turns where the saved working list held fewer.
- `ThreadStore` implements `ConversationStore` over the state home: `threads/<id>/log.jsonl` (one sealed entry per line, one `appendFile` per batch, torn or foreign lines skipped, a torn last line is closed before the next batch), `context.enc`, `meta.enc`, and `threads/index.enc` as a merged cache. Ids are checked against `/^conv-[a-z0-9-]{6,60}$/` before any path is built.
- Reopening: `restore()` returns turns from the log (`entriesToTurns`). When the thread was continued elsewhere (the context's `basedOnTip` is not the log's main-line tip) the working context is rebuilt from the log's main line (`entriesToMessages`) with the saved system prompt first; the next message extends the main line and nothing is lost.
- D-08: the 50-conversation cap and its removal step are gone, and listing shows an unreadable file as locked. D-12: a 3 MiB tool result is stored at 2 MiB with `shortenedBytes` 3 145 728 and nothing else is shortened. D-13: only the lead agent's steps are logged; the sub-agent's report is the lead's tool result.
- `chat.ts` builds the store through `threadStoreFor` (one per folder and secret store, state home and key created on the first write only); `showHistory` lists the same store, with a locked item that is shown but not opened.

## Task Commits

1. **Task 1: Tracer, a compacted conversation reopens with every message the person typed** - `75a910e` (feat). Tracer verified end to end (4 tests, then the 59-test related run) before expansion.
2. **Task 2 RED: no pruning, locked listing, the cap, lead-only logging, context rebuild** - `dee1954` (test). Two failures for the intended reasons: the old store still pruned beyond fifty (`50 !== 60`) and dropped a file sealed with another key from its list.
3. **Task 2 GREEN: saving no longer deletes, unreadable is listed as locked** - `442ddc0` (feat)
4. **Task 3: the panel and the history list share one thread store** - `0ca452d` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md, ROADMAP.md and REQUIREMENTS.md.

## Verification

- `npx tsc -p tsconfig.json --noEmit`: clean.
- `node --test dist/test/threadLog.test.js dist/test/conversations.test.js dist/test/privacy.test.js dist/test/agentFleet.test.js dist/test/threadMerge.test.js dist/test/stateMerge.test.js`: 72 tests, 0 failing (threadLog: 12).
- Chat and agent suites around the changed paths (chat*, sidebarChat, spendSendPath, reportingTokenEntry, steering, setupNudge, approvalPolicyPicker, autoResume, runRecovery, agent*, state*): only the known `chatSendPath` "GSD slash command" failure (reads the real home Teams library on this machine).
- Acceptance greps: `MAX_TRANSCRIPTS`, `prune`, `process.pid` in transcripts.ts are 0 (baseline 2, 3, 1); `new TranscriptStore(context.globalStorageUri.fsPath` in extension.ts is 0 (baseline 1); `threadStoreFor(` is in both chat.ts and extension.ts; `captureThread` is called before `manageContext(` in the main `beforeTurn`; `function contentKey` is 0 in agentSession.ts and `export function contentKey` is 1 in threadCapture.ts.

## Files Created/Modified

- `src/domain/state/threadCapture.ts` - messages to entries (user text vs model text, assistant, tool-call, capped tool-result), synthetic-message rule, `contentKey`, `commandForm`
- `src/domain/state/threadView.ts` - main-line turns for the view and main-line entries back to model messages
- `src/services/threadStore.ts` - the thread store, `mergeMeta`, `threadStoreFor`
- `src/services/transcripts.ts` - `ConversationStore`, `locked`, `basedOnTip`; no cap, no removal step, random temporary names, locked listing
- `src/services/agentSession.ts` - `logged`, `captureThread`, capture before `manageContext`, `restore` from the log, `visibleTurns` shares `commandForm`
- `src/services/chat.ts`, `src/extension.ts` - the shared store in the panel and the history list
- `src/test/threadLog.test.ts` - 12 tests; `src/test/conversations.test.ts` - fixtures now seed and read the thread store

## Decisions Made

See `key-decisions` in the frontmatter. In short: entries chain from what the conversation last wrote or opened (not the global tip); un-covered stores re-chain from the start so ids dedupe; nothing is written, and no state home created, when there is nothing real to record; a capture failure never stops a run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `conversations.test.ts` read and seeded the old per-editor transcript folder**
- **Found during:** Task 3 (three sidebar tests failed after the panel moved to the shared store)
- **Issue:** the tests created a `TranscriptStore` under `<root>/.global` to seed or inspect saved conversations; the panel no longer writes there.
- **Fix:** the three places use `threadStoreFor(root, shared.secrets, ...)`, the same store instance the panel gets, with the same assertions.
- **Files modified:** `src/test/conversations.test.ts`
- **Verification:** conversations tests 22 of 22 pass; no assertion changed or removed
- **Committed in:** `0ca452d`

**2. [Rule 1 - Bug] `threadStoreFor` crashed when the host gave no secret storage**
- **Found during:** Task 3 (seven `chatSendPath` tests failed with "Invalid value used as weak map key")
- **Issue:** six existing test fixtures (chatSendPath, spendSendPath, reportingTokenEntry, steering, setupNudge, approvalPolicyPicker) attach the chat with no `secrets`; the old code only touched secrets lazily, so a save failed quietly instead of crashing at construction.
- **Fix:** `threadStoreFor` takes `SecretsLike | undefined` and falls back to a no-op secret store, so the data key lives only in the project's key file there; a new test covers it.
- **Files modified:** `src/services/threadStore.ts`, `src/test/threadLog.test.ts`
- **Committed in:** `0ca452d`

**3. [Rule 2 - Missing critical] New entries must chain from what the conversation covers, not from the log's global tip**
- **Found during:** Task 1 design, and the idempotent re-sync test
- **Issue:** chaining from the global main-line tip would make a second editor's concurrent entries part of this conversation's lineage, and a store with no knowledge of a conversation re-logged all of it after the tip.
- **Fix:** a per-store `covered` map set after each append and at `load()`, plus a public `cover(id, tip)` that `restore()` calls after a rebuild; an un-covered store chains from the start so ids dedupe. This adds two small public members the plan's artifact list did not name (`cover`, and `Transcript.basedOnTip`).
- **Files modified:** `src/services/threadStore.ts`, `src/services/transcripts.ts`, `src/services/agentSession.ts`
- **Committed in:** `75a910e`

**4. [Rule 2 - Missing critical] A torn last line must not swallow the next batch**
- **Found during:** Task 1 (T-27-22)
- **Issue:** appending after a line without its newline would join two lines into one unreadable line and lose both.
- **Fix:** the writer checks the last byte of the log and starts the batch on a new line when needed; the reader leaves a final line without a newline for the next read.
- **Files modified:** `src/services/threadStore.ts`
- **Committed in:** `75a910e`

---

**Total deviations:** 4 auto-fixed (1 Rule 1, 2 Rule 2, 1 Rule 3). **Impact on plan:** all needed for the plan's own invariants (no lost entries, no regression in existing suites); no scope creep.

**TDD note (Task 2):** the RED commit is only partly red. The locked listing of the thread store, the context rebuild, the D-12 cap and the D-13 case were already implemented as part of the Task 1 store and `restore()`, so those new tests passed on first run; the two that failed for the intended reason were the old store's cap and its dropping of an unreadable file, which is exactly what the GREEN commit changed.

## Known Limits

- Conversations an editor saved under its own globalStorage before this plan are no longer listed: the panel and the history list now read only the state home. The one-time merge that brings them across (and re-seals them under the project data key, marking threads whose earlier messages were summarised away) is plan 10; until it runs, a development build shows an empty history for an existing project.
- `entriesToTurns` is the basic form: user turns, assistant turns and a tool-step count from the main line, with branches not rendered yet. Plan 06 extends it with tool-step cards, the other continuation and the archive; the log already holds every entry and branch.
- Messages the loop injects as user turns (`<loop-guard>`, `<output-limit>`) are logged like any user message, as `visibleTurns` already showed them; only the four synthetic kinds in the plan are skipped.
- `list()` merges the index with every thread's own meta on each call (small sealed files), and the index is written by `save()` and `create()`; plan 06 owns archiving and index-at-scale.

## Issues Encountered

None beyond the deviations above. `.planning/state.json` was already modified before this plan and was left alone. The `chatSendPath` "GSD slash command" failure is the known machine-specific one.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 06 can extend `threadView.ts` (tool-step cards, the other continuation) and add the archive on top of `ThreadStore`; plan 07 can record `@near` participant threads through `appendEntries` and `create`; plan 10 can migrate old transcripts into `ThreadStore.save`/`captureTranscript` using `sharedTranscriptKey`/`transcriptKey`, which are kept.

## Known Stubs

None.

## Threat Flags

None. The new file access (the state home's thread folders) is the surface the plan's threat model already covers (T-27-20 to T-27-24); no new network endpoint or auth path.

## Self-Check: PASSED

- Files: `src/domain/state/threadCapture.ts`, `src/domain/state/threadView.ts`, `src/services/threadStore.ts`, `src/test/threadLog.test.ts` exist.
- Commits `75a910e`, `dee1954`, `442ddc0`, `0ca452d` are ancestors of HEAD; `git rev-list --count 403aa42..HEAD` is 4.
- Plan verification: tsc clean; 72 related tests, 0 failing.

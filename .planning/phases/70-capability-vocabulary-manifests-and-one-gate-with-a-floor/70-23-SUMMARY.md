---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 23
pr: 4c
subsystem: gate (chat labels)
status: complete
tags: [gate, labels, chat, CLAS-04, CLAS-01, GATE-07, D-29, D-33, D-54, D-58]
requires: ["70-22"]
provides:
  - "src/services/threadStore.ts: ThreadMeta.label, ChatLabelState, chatLabelOf, joinMarks, mergeChatLabel (raise-only mergeMeta), ThreadStore.setChatLabel, MAX_CHAT_LOWERINGS"
  - "src/domain/gate/lowerings.ts: registerLabelLoweringJudge, registerLoweringOutcomes, judgeLowering, reportLowering, LoweringContext, LoweringVerdict"
  - "src/gate/chatLabel.ts: signChatLowering, judgeChatLowering, chatLoweringKeys, LOWERING_REJECTION_CAUSES, loweringRejectedText"
  - "purpose label-declassify in PAYLOAD_PURPOSES"
  - "GateHost.registerLabelLowerings, refreshLoweringKeys, signChatLowering, onLoweringRejected; recordLabelEvent takes a mark"
  - "src/services/chatInView.ts: setChatInView, clearChatInView, chatInView, chatLabelChanged, onChatInViewChange, queueChatNotice, takeChatNotices, onChatNotice"
  - "src/services/gateCommands.ts: nearAi.label.lowerChat (Lower This Chat's Label), lowerChatLabel, lowerChoices"
  - "gateStatusText(state, now, chatMark); AgentConversation.labelText, prepareLowering, onLabelChange, projectRoot, chatDefaultLabel; UNREADABLE_CHAT_LABEL_TEXT"
affects: [70-24, 70-28c]
tech-stack:
  added: []
  patterns: ["raise-only metadata merge with a registered judge (fail closed with none)", "one signer, a closed purpose list (Phase 69 D-10)", "the chat in view as a small registry, no vscode"]
key-files:
  created: [src/domain/gate/lowerings.ts, src/gate/chatLabel.ts, src/services/chatInView.ts, src/test/gateChatLabel.test.ts]
  modified: [src/services/threadStore.ts, src/services/agentSession.ts, src/services/chat.ts, src/services/chatBridge.ts, src/services/panelView.ts, src/services/gateCommands.ts, src/services/gateStatusBar.ts, src/gate/host.ts, src/domain/team/signedPayload.ts, media/chat/chat.js, media/chat/chat.css, package.json, src/test/teamSignedPayload.test.ts]
decisions:
  - "Labels are left out of TranscriptSummary: the list shows none, the meta holds it"
  - "The judge registry is in the domain (src/domain/gate/lowerings.ts), because src/gate may not import src/services (teamBoundaries)"
  - "A reopened chat above the shipped default label rebuilds its D-60 fingerprints from every tool result in its context (which were labelled is not stored)"
metrics:
  completed: 2026-11-17
  tasks: 3
estimate:
  tokens: 90047
actuals:
  tokens: 36000
  tasks: 3
  commits: 3
plan_head_before: 45c7a75a
plan_head_after: ebb709bf
---

# Phase 70 Plan 23: The chat's label lasts, shows and comes down only by a person Summary

A chat's mark is saved in its thread meta, a reopened chat starts at it, every merge site is raise-only, an unreadable stored value opens at org/Restricted and is never replaced by a lower one, the page and the status bar show the label of the chat in view above the default label, NEAR AI: Lower This Chat's Label is the only way down (with a reason, recorded), and a lowering reaches another copy of the chat only as a signed declassification that copy can check and that undoes no raise.

Commits: `f9fbe043` (Task 1), `cbd6d2f1` (Task 2), `ebb709bf` (Task 3).

## What was built

- **Task 1 (`f9fbe043`).** `ThreadMeta.label` (`{ mark, lowerings? }`), read only through `chatLabelOf` (none, mark, or unreadable: any entry `parseLabel` refuses on the presets). `mergeMeta` takes the label from `mergeChatLabel` whatever copy is newer, so the sync, the records, the archive and the store's own merges are raise-only with no change at the call; an unreadable value is kept over a readable one. `ThreadStore.setChatLabel` saves a raise joined with what is stored (never over an unreadable value) or a person's lowering. `AgentConversation` saves each change of its mark, starts a reopened chat at the stored mark (org/Restricted with `UNREADABLE_CHAT_LABEL_TEXT` when unreadable), and posts `chat-label` to the page; the page shows "Label: ..." beside the model with `textContent` only and clears it when another chat is shown. `providerErrorMessage` now passes a `RouteRefusedError`'s own sentence (before, it read "could not be completed. Check your connection").
- **Task 2 (`cbd6d2f1`).** `nearAi.label.lowerChat`, checked with `node -e`: `{"command":"nearAi.label.lowerChat","title":"Lower This Chat's Label","category":"NEAR AI"}`. It acts on the chat in view (the chat reports it through `chatInView.ts` when it shows a conversation and clears it when the view goes), offers each lower level of each scale of the mark and the project's label (`lowerChoices`, never below the project), asks for a non-empty reason whose prompt says it travels with the chat's encrypted metadata, checks the choice again against the mark at that moment, calls `SessionMark.lowerByPerson`, and records `label.declassify` with the new label (`label`), the old mark (`mark`) and the reason. `gateStatusText(state, now, chatMark)` adds "· <label>" and a tooltip sentence above the default label.
- **Task 3 (`ebb709bf`).** `label-declassify` joins `PAYLOAD_PURPOSES`. Lower signs `{ chatId, from, to, reason, at }` with this install's device key (`GateHost.signChatLowering`); with no key the chat is lowered here only and the person is told it will not reach their other computers. `mergeChatLabel` applies the lowerings one copy holds and the other does not only when exactly one copy holds such lowerings and the registered judge applies every one (`judgeChatLowering`: verifies under `label-declassify` against this computer's key sources, revoked and rotated-before keys refused, this chat, from-mark covers the other copy's mark, other copy not used after); otherwise the join; with no judge, all rejected. The merged label keeps the union of signed lowerings, newest 20. `GateHost.registerLabelLowerings` (called at activation) registers the judge over this install's key history, records each applied lowering once per window as `label.declassify` and each rejected one as `label.declassify-rejected` with its cause, and queues the chat's one-time sentence naming the Lower command (shown when that chat is open or next shown).

## Red first

Task 1: with the merge, the restore and the page handler disabled in place, 6 of 8 failed. Task 2: the tests failed to compile before the command existed; with the choices, the lowering and the status label disabled in place, 4 of 12 failed. Task 3: the purpose test failed to compile before `label-declassify`; with the judge's apply disabled, the two applied cases failed (the rejection cases pass either way by design).

## Tests

- `gateChatLabel.test.ts`: 18 tests, both argument orders of every merge case.
- Verify sets inside the cap: Task 1 (gateChatLabel, threadMerge, threadLog, gateMark, conversations, participantRecord, checkNow): 96, 0 fail. Task 2 (with gateCommands, gateStatusBarRefresh, gateRecordIds, gateLabelStore, gateLabelCommands): 114, 0 fail. Task 3 (with teamSignedPayload, teamBoundaries, threadArchive): 137, 0 fail.
- `git diff origin/feat/gate-labels -- src/test/threadMerge.test.ts src/test/threadLog.test.ts` is empty.

## Existing tests changed (intended)

- `teamSignedPayload.test.ts`: the pinned purpose list grows by exactly `label-declassify`, and `SAMPLES` gains its sample (the record type requires one per purpose).

## Deviations from Plan

1. **[Rule 3] The judge registry lives in `src/domain/gate/lowerings.ts`**, re-exported by threadStore: teamBoundaries forbids src/gate importing src/services.
2. **[Rule 2] Team Mode key source is built but not wired.** `chatLoweringKeys(local, team)` limits the roster to this person's own member id (tested), but the gate host has no team state, so it passes only this install's key history. Outside and inside Team Mode, a lowering made on another computer is therefore rejected (fail closed) until the host is given the roster. Owner question.
3. **[Rule 2] The persisted label is written through `ThreadStore.setChatLabel`, not the transcript save**, so a raise saved while a higher copy synced in is joined, and only the person's lowering replaces it; `AgentConversation.prepareLowering` marks the one change the command makes.
4. **[Rule 1] Route refusals reached the page as "could not be completed. Check your connection"**; `providerErrorMessage` now returns their sentence.
5. **Lower choices.** The plan said "labels below its mark down to the project's label": the command offers each lower level of each scale the mark holds (compartments dropped), plus the project's label, and refuses a choice that would no longer be lower when the chat read more meanwhile.
6. **The rejected-lowering sentence is shown through a small notice queue in `chatInView.ts`**, posted when that chat is in view or next shown.
7. **D-60 fingerprints on reopen**: rebuilt from every tool result of the restored context when the mark is above the shipped default (not stored anywhere).

## Threat Flags

None beyond the plan's register.

## Self-Check: PASSED

Files exist (`src/domain/gate/lowerings.ts`, `src/gate/chatLabel.ts`, `src/services/chatInView.ts`, `src/test/gateChatLabel.test.ts`); commits `f9fbe043`, `cbd6d2f1`, `ebb709bf` are ancestors of HEAD.

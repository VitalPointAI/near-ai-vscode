---
phase: 41-organization-policy-foundation-f1
plan: 14
subsystem: gate policy (commands, enrolment flow, editor wiring)
status: complete
tags: [enrolment, twelve-words, notices, status-bar, policy-editor, palette, privacy-mode, export-markings]
requires: [41-02 (narrowingOf, ignoredSettingsNotice), 41-03 (enrolment texts and fixtures), 41-04 (exportMarkingsShown), 41-08 (policy editor), 41-09 (organization store, host layers), 41-11 (copy lint), 41-12 (architecture test)]
provides:
  - organizationRules.ts (ADD_ORGANIZATION_RULES_COMMAND, AddRulesOutcome, addOrganizationRules, startNotices, NoticeMemento, MIGRATION_NOTICE_KEY, IGNORED_NOTICE_KEY, enrolledText, rotatedText, updatedText, UNCHANGED_RULES_TEXT, RULES_NOT_USED_TEXT, RULES_FILE_UNREADABLE_TEXT)
  - policyEditorWiring.ts (PolicyEditorPort, defaultPolicyEditorPort, editorStateOf, policyEditorDeps, PolicyEditorHooks, proposeDraft, draftFiles, discardDraft, POLICY_APPLIED_TEXT, NO_DRAFT_TEXT, OPEN_FAILED_TEXT)
  - gateCommands.ts (OPEN_POLICY_COMMAND, SHOW_POLICY_AS_STORED_COMMAND, RESET_DETAIL_ORGANIZATION, RegisterGateOptions.policyEditor, GateActivationContext.globalState and extensionUri, policyDocumentText(state, now, layers?), labelShown, labelsShown, labelRecorded; PolicyEditorPort, POLICY_APPLIED_TEXT and NO_DRAFT_TEXT re-exported)
  - gateStatusBar.ts (POLICY_ENDS_SOON_TEXT, layers in gateStatusText, policyProblem, read and update)
  - src/test/helpers/policyEditorFake.ts (recordingPolicyEditor, autoApplyPolicyEditor)
affects: [41-15 (copy sweep to "NEAR AI: Policy", SECURITY.md, e2e, tight baselines)]
tech-stack:
  added: []
  patterns: [preview then confirm then accept under the host's lock, memento flags hashed per distinct content, port interface so commands drive a webview through a stand-in, proposal before any apply]
key-files:
  created:
    - src/services/organizationRules.ts
    - src/services/policyEditorWiring.ts
    - src/test/gateEnrolCommand.test.ts
    - src/test/helpers/policyEditorFake.ts
  modified:
    - src/services/gateCommands.ts
    - src/services/gateStatusBar.ts
    - package.json
    - src/test/gateCommands.test.ts
    - src/test/gateLabelCommands.test.ts
    - src/test/copy-lint-baseline.json
decisions:
  - "Edit Policy writes the personal layer's own stored document (policyLayers().personal.stored) and the personal layer's hash, also under your organization's rules, never the narrowed effective view (the 41-09 note). Apply checks the draft's base against policyLayers().personal.hash, so the host's composed-hash mapping is never needed for drafts."
  - "Apply Policy Draft refuses a stale base and an invalid draft before proposing anything. The draft is read with parsePolicyDraft using the personal document's own envelope; the host reads it again with its own signer and dates when it signs."
  - "deps.applyPersonal checks the base against the stored personal hash first (STALE_DRAFT_TEXT), then calls host.applyPolicyDraft; a BundleStoreError becomes { ok: false, text }."
  - "With no editor page (a context with no extensionUri, as in unit tests), NEAR AI: Policy and Show Policy open the stored text view, so the person always sees the policy; Apply Policy Draft refuses ('NEAR AI could not open your policy.'), so a draft is never applied unseen (T-41-142)."
  - "A file too large is refused before reading with ORGANIZATION_LAYER_REFUSALS['too-large'] and recorded as policy.organization-refused 'too-large'. A refused preview is recorded with its reason; a refusal at accept is recorded by the host (unchanged)."
  - "After any acceptance the ignored-settings notice is told when the list is not empty, and its hash is stored, so the next window does not repeat it."
  - "'Policy: ends soon' does not use the warning background (like 'renewing'); it is shown when the layer's endsSoon is set or the end is within 30 days of the bar's own time, so a long-open window follows it."
  - "The ends-soon, organization tooltip and stored-view lines name your organization only when the layers are passed; with no layers or no organization every word is as before."
  - "Add Your Organization's Rules stays in the palette; NEAR AI: Policy (nearAi.policy.open) is the palette entry for the policy; Show, Edit, Apply Policy Draft, Reset and Show Policy as Stored keep their ids with 'when': 'false'."
metrics:
  duration: ~110 min
  completed: 2026-11-20
actuals:
  tokens: 28500
  tasks: 4
  commits: 4
plan_head_before: 482aed5dfaaca7c800597c29b292ada1c4196611
plan_head_after: 5d7a26e61a15e7fb504ba874ce8489634e38a210
---

# Phase 41 Plan 14: Commands, enrolment flow and editor wiring Summary

A person takes your organization's rules with NEAR AI: Add Your Organization's Rules (file picker, size check before reading, a preview that writes nothing, the twelve words in a modal with one button), every surface says whether your organization or this computer set the rules, the one-time notices are told once, and the policy editor page is the front door for every policy command.

## Base check (Task 1)

All names were on the base (482aed5d): OrganizationStore 1 (the count of 2 is OrganizationStoreError matching the same text), previewOrganizationFile and migrationNoticeText 2, host acceptOrganizationFile, policyLayers and recordPolicyEvent 3, registerPolicyEditor, openPolicyEditor and openPolicyProposal 3, the seven enrolment names 7, ignoredSettingsNotice and narrowingOf 2, localHostPatternNotice 2 and setPrivateOnlySetting 2 in gateCommands.ts, the three D-62 names 3. gateCommands.ts had 787 lines.

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Tracer: Add Your Organization's Rules, file picker to rules in force | 7807f5b1 | organizationRules.ts, gateCommands.ts, package.json, gateEnrolCommand.test.ts |
| 2 | Handover, update, refusal, start notices, who set the rules | 6af120e7 | organizationRules.ts, gateCommands.ts, gateStatusBar.ts, gateEnrolCommand.test.ts |
| 3 | The editor is the front door; palette; privacyMode words | 70b8a594 | policyEditorWiring.ts, gateCommands.ts, package.json, policyEditorFake.ts, gateEnrolCommand, gateCommands and gateLabelCommands tests, copy-lint-baseline.json |
| 4 | Reserved compartments as words after the level; records keep tokens | 5d7a26e6 | gateCommands.ts, gateCommands.test.ts |

Tracer gate: the Task 1 verify (gateEnrolCommand plus gateCommands, 31 of 31) was re-run end to end before Task 2.

## What was built

- **organizationRules.ts**: `addOrganizationRules(host, { globalStorageDir, secrets, now, tell, memento? })` gives one outcome: enrolled, rotated, updated, unchanged, declined, refused or cancelled. A new key or a handover asks `issuerWordsQuestion(name)` (with `ROTATION_WORDS_LEAD` before it for a handover) in a modal whose detail is the twelve words and the fingerprint line, with the one button `ISSUER_WORDS_MATCH`. Only that answer calls `host.acceptOrganizationFile(text, { wordsConfirmed: true })`. An update needs no words. `startNotices` tells the migration notice once per personal layer hash (`nearAi.policy.migrationNoticeShown`, recorded as policy.migrated "{n} local servers"), the ignored settings once per distinct list (`nearAi.policy.ignoredNoticeShown`, bundleHash of key, yours and allowed), and your organization's rules ending soon once per window.
- **gateCommands.ts**: the S1 block awaits startNotices, then shows the safety patch's pattern notice unless the migration notice was shown in this window. `policyDocumentText(state, now, layers?)` adds "Rules from: your organization (Example Organization). Your settings on this computer can only narrow them." or "Rules from: this computer (self-signed on this computer).", and for your organization's failure the note "Your organization's rules need attention: ask {contact}." with no Reset. NEAR AI: Policy and Show Policy open the editor; Show Policy as Stored keeps the text view; Edit Policy drafts the personal layer; Reset's modal under your organization's rules uses `RESET_DETAIL_ORGANIZATION`. `labelShown`, `labelsShown` and `labelRecorded` (D-62). The file grew from 787 to 810 lines (budget 847).
- **policyEditorWiring.ts**: the port, the host-backed deps (state from policyLayers, directionOf through narrowingOf with `[id]` read as `[]` and the effective scales, applyPersonal, signer loaded after start and on each host change, reset, showStored, record "{changes} changes from {from}, proposal {first 16}", onDidChange) and `proposeDraft`.
- **gateStatusBar.ts**: layers in `read` and `update`; your organization's tooltip; `Policy: ends soon` with `organizationEndingText`; a valid state past its end gives `layers.expiry`.
- **package.json**: nearAi.organization.addRules, nearAi.policy.open ("Policy"), nearAi.policy.showAsStored ("Show Policy as Stored"); five `"when": "false"` palette entries; privacyMode description and enumDescriptions in the glossary's words (no TEE, tier or Team Mode); id and values unchanged.

## Tests

- gateEnrolCommand.test.ts: 22 tests (4 tracer, 9 Task 2, 9 Task 3). gateCommands.test.ts: 4 new D-62 tests (31 in all).
- Red first:
  - Task 1 on the base: 4 of 4 failed (no command).
  - Task 2 on the Task 1 code: 5 of 9 failed (D-20, D-27, the status bar, the organization failure, the stored view) and the file did not type-check (no layers argument, no POLICY_ENDS_SOON_TEXT). The handover, update, refusal and size tests passed there, because the tracer's addOrganizationRules already handled every file kind; all 9 fail on the base.
  - Task 3 on the Task 2 code: 8 of 9 failed (no PolicyEditorPort, no RESET_DETAIL_ORGANIZATION, no palette entries, the old privacyMode words). The auto-apply test passed there, because the old command applied the draft directly with the same visible result; it fails on the base (no policyEditor option is honoured and the D-44 helpers do not exist).
  - Task 4 on the Task 3 code: 4 of 4 failed (labelShown, labelsShown and labelRecorded not exported).
- Moved entry points, every assertion kept: gateCommands.test.ts "Show Policy opens a read-only document ..." and "Show Policy for a policy that failed ..." now run SHOW_POLICY_AS_STORED_COMMAND. gateLabelCommands.test.ts "a self-added clearance that expires ...", "Show Policy says what is live ...", "every message Edit Policy, Apply Policy Draft and Show Policy show ..." and "Show Policy names the command ..." now run SHOW_POLICY_AS_STORED_COMMAND; its started() passes `autoApplyPolicyEditor()`, and its apply helper still runs APPLY_POLICY_DRAFT_COMMAND and returns true only when applied.
- Final runs (capped, locked):
  - Task 3 set (gateCommands, gateLabelCommands, gateEnrolCommand, policyEditor, gateLabelStore, gateActivation, gateDocs): 150 of 150.
  - Task 4 set (gateCommands, gateLabelCommands, gateChatLabel): 75 of 75.
  - Gate set (`gate*.test.js`, teamSignedPayload, teamBoundaries, replicaBoundaries, `staffObs*.test.js`, architecture, copyLint) plus policyEditor, setupSteps, teamManifest and staffMultiUserManifest: 1346 tests, 1346 pass, 0 fail, 0 skipped.
  - architecture and copyLint with NEAR_AI_BASELINE_TIGHT=1: 41 of 41.
  - `npm run lint` exit 0. `node scripts/secret-scan.mjs --range 482aed5d..HEAD` clean.
- Acceptance greps: `"nearAi.organization.addRules"` 1; `wordsConfirmed: true` 1 in organizationRules.ts; `startNotices(` 1 in gateCommands.ts; `nearAi.policy.migrationNoticeShown` 1; `"when": "false"` 5; TEE in the privacyMode block 0; `resetPolicy(` only in src/services/gateCommands.ts; `exportMarkingsShown(` 1 and `labelRecorded(` 2 in gateCommands.ts.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking, line budget] Editor wiring in a new file, src/services/policyEditorWiring.ts**
- The plan puts the port and the deps in gateCommands.ts and other new logic in organizationRules.ts. With the deps, the Apply flow and the draft helpers in gateCommands.ts it would pass its 60-line budget, and the enrolment module is the wrong home for the editor's wiring. The new file holds the port, the deps, `proposeDraft`, `draftFiles` and `discardDraft`, and POLICY_APPLIED_TEXT and NO_DRAFT_TEXT, which gateCommands.ts re-exports under the same names. `resetPolicy` and `host.reset()` are still called only from gateCommands.ts (the deps take `reset` as a hook), so the existing caller guard is unchanged. Commit 70b8a594.

**2. [Rule 1 - Copy lint ratchet] package.json glossary count lowered from 42 to 40**
- The new privacyMode words drop "TEE" and "attested", so the count went down; NEAR_AI_BASELINE_TIGHT=1 flagged the stale count. One line of src/test/copy-lint-baseline.json (outside files_modified) moves with the copy. No count was raised. Commit 70b8a594.

**3. [Test design] A fixed clock and Reset**
- On the tests' fixed clock a reset signs the same bytes again, so a draft made before it is not stale. The stale-draft test moves the clock a minute before the reset. Commit 70b8a594.

**4. [Rule 2 - Fail closed] No editor page**
- Without an extensionUri there is no page: the open commands fall back to the stored text view, and Apply Policy Draft refuses instead of applying unseen (T-41-142). Tested both sides.

### Files outside files_modified
- src/services/policyEditorWiring.ts (new helper, deviation 1) and src/test/copy-lint-baseline.json (one count lowered, deviation 2). No Phase 32 file, host.ts, nearAiClient.ts, sessionMark.ts, trust or privacy file, or agentSession.ts was touched.

## Notes for 41-15 and the owner

- The copy sweep is still due: sentences in gateCommands.ts (editPolicyNotice, NO_DRAFT_TEXT, the stored view's notes, notYourClearanceText), bundleStore.ts STALE_DRAFT_TEXT, bundle.ts RESET_FIX and others name commands that have now left the palette ("NEAR AI: Edit Policy", "Apply Policy Draft", "Show Policy", "Reset Policy to Defaults"). This plan changed no pinned copy.
- Edit Policy has left the palette (owner Q9), and the editor page (41-08) offers no button that starts an edit of your own rules: it shows proposals that flows send it. Today a person reaches Edit Policy only through its id (a keybinding) or the notices that name it. A page action "Edit my rules" (running EDIT_POLICY_COMMAND) would close the gap; flagged rather than built because media/policy and policyEditor.ts belong to 41-08.
- e2e: this plan adds two commands, a palette menu block and the editor wiring; the orchestrator's e2e run in 41-15 covers them.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-41-140 (exact button only; the declined and closed modal tests check no folder, no pin and no record), T-41-141 (stat before read, tested with a file over 1 MiB), T-41-142 (stale and invalid drafts refused before proposing; nothing signed until applyPersonal; no page means no apply), T-41-143 (policy.organization-refused for older, foreign, broken and too-large files; policy.migrated), T-41-144 (the organization failure's status bar and stored view never name Reset) each have tests. T-41-SC: no package was installed.

## Self-Check: PASSED

- Files: src/services/organizationRules.ts, src/services/policyEditorWiring.ts, src/test/gateEnrolCommand.test.ts and src/test/helpers/policyEditorFake.ts exist; the modified files are in the commits above.
- Commits: 7807f5b1, 6af120e7, 70b8a594 and 5d7a26e6 are ancestors of HEAD on feat/phase-41-14-commands-and-editor.

# Phase 61 - UI Review

**Audited:** 2026-11-01
**Baseline:** abstract 6-pillar standards plus .planning/UX-CONTRACT.md (no UI-SPEC.md)
**Screenshots:** not captured. VS Code native UI only (commands, quick picks, input boxes, notifications, status bar); no webview, CSS or dev server. Code-only audit.
**Interaction captures:** off (workflow.ui_interaction_capture is false). Interaction findings are code-derived.

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 3/4 | Plain and em-dash free; raw status words and jargon leak into cleanup rows; inconsistent casing and tone |
| 2. Visuals | 2/4 | Quick pick hierarchy flattens everything into comma-joined labels; no codicons; status bar has no icon or a11y info |
| 3. Color | 3/4 | Only statusBarItem.warningBackground, used for both degraded and removed; no foreground or error tier |
| 4. Typography | 3/4 | Title Case commands vs sentence case messages mostly consistent; a few lowercase fragments and bare quoting |
| 5. Spacing | 2/4 | Long single-paragraph modals; invite bundle dumped in modal detail; dense labels |
| 6. Experience Design | 2/4 | Only Join and sign-in show progress; cancel invitation has no confirm; long network flows are silent |

**Overall: 15/24**

## Top Priority Fixes (most important first)

1. **WARNING (borders on BLOCKER for interruptibility). Long NEAR and git flows have no progress and no cancel.**
   src/services/team/memberCommands.ts:575 wraps only joinTeam; lines 212 (sign-in) is the only other withProgress. `removeMember` (finishRemoval, ~line 738), `deliverMemberKey` and `rotateMemberKey` (~line 703), `linkNearOrganization` (line 332), `reissueInvite` and the invite creation call (~line 480-520) and `retryItem` run multi-step NEAR calls (zero-limit, revoke, org removal) with no notification. The user clicks Remove and sees nothing until the final message. UX-CONTRACT: "Tell the developer what is happening" and "Make every autonomous boundary interruptible". Fix: wrap each in `vscode.window.withProgress({location: Notification, title: 'Removing <name>', cancellable: false})` and report step titles ("Setting key limit to 0", "Removing from team log", "Revoking key"). Join at line 575 is also `cancellable` false with no step message; add `progress.report({message})` per step.

2. **WARNING. Cancel invitation has no confirmation.** memberCommands.ts:742-752 `cancelInvitation` calls `finishRemoval` straight from the quick pick action "Cancel" (line ~897) with no modal. For lead invitations it also cancels at NEAR. Remove has a modal (line 722) but cancel does not, which is inconsistent and destructive (the invite code stops working, cannot be undone except by re-issue). Fix: add `showWarningMessage('Cancel the invitation for <name>?', {modal:true, detail:'The invite code stops working...'}, 'Cancel invitation')`. Also the quick pick label "Cancel" at line ~897 reads like dismissing the picker; rename to "Cancel invitation".

3. **WARNING. Manage Team Members quick pick flattens hierarchy into comma-joined labels.** memberCommands.ts:848 `label: "${name}, ${role}, key pending"` and :857 `"Invitation for ${name}, ${role}, ${status}"`, :870 `"NEAR cleanup: <step> for <name>"` with `description` carrying raw `item.status` plus raw `lastError`. Role, state and warnings are all in the label so scanning and filtering are hard, and status words (`pending`, `failed`) are internal vocabulary. No codicons, no separators. Fix: use `label: '$(account) Name'`, `description: 'Developer, waiting for confirmation'`, `detail:` for allocation or error; add `QuickPickItemKind.Separator` rows ("Members", "Invitations", "Still to finish"); map status to plain words; add `$(warning)` on attention rows and `$(mail)` on invitations.

4. **WARNING. Invite bundle shown in a modal `detail` (memberCommands.ts:425-429).** A long `near-ai-invite-v1....` token in a modal detail wraps awkwardly, cannot be reliably selected in all VS Code versions, and the only dismiss path besides Copy is Cancel (button text implicit). If the lead closes it by accident the invite is lost ("not shown again"), and line 434 tells them to re-issue. Fix: also offer "Copy" as the primary default and make the cancelled branch warn before discarding ("Close without copying? The invite is not shown again."), or put the bundle in a read-only input box (`showInputBox({value: bundle, prompt: ...})`) which is selectable and copyable.

5. **WARNING. Status bar has no icon, accessibility information, or distinct removed state.** teamStatusBar.ts:72-91: text `Team: ${name}` has no codicon (UX-CONTRACT asks for "compact visual affordances" with accessible text). `item.accessibilityInformation` is never set. `Team: removed` (line 37) and every paused state share `statusBarItem.warningBackground` (line 87), so "removed from team" and "offline" look identical, and the removed item still carries `command = nearAi.team.verifyLog` (line 80) though requireTeam refuses commands once removed (memberCommands.ts:~155), so clicking does nothing useful. Fix: `$(organization) Team: X`, `$(warning) Team sync paused...`, `$(error) Team: removed` with `statusBarItem.errorBackground`, set `accessibilityInformation`, and drop or retarget the command when removed (open the explanation instead). Also the pending count `(3 pending)` (line 56) does not say pending what; use `(3 to review)` and make click open Manage Team Members when pending > 0.

6. **WARNING. Hard-to-read jargon and internal tokens in user text.**
   - memberCommands.ts:206-208 placeholder: `NEAR AI keeps this sign-in for this team until you run "NEAR AI: Sign Out of NEAR (Team)"` is a 100-plus character placeholder that truncates in the quick pick; move to `detail` or shorten ("Stays signed in until you sign out").
   - :870 `NEAR cleanup:` plus `STEP_TEXT` entries (`Set the key limit to 0`, `Replace the team key`) fine, but description `${item.status}: ${lastError}` shows raw status and possibly long errors.
   - :541 placeholder `near-ai-invite-v1....` exposes the wire format; use `Paste the invite here`.
   - :466 allocation input already validates inline via `validateInput` with `parseUsdToNanoUsd` (`Enter dollars and cents, for example 5 or 12.50.`); no change needed. (Corrected by the orchestrator after spot-checking the source.)

7. **WARNING. Status copy mixes tones and internal terms.** teamStatusBar.ts:11-14 `Team log not trusted` vs `Team sync paused: log rewritten`: the first is a verdict with no next step, the second uses "log rewritten", which a non-technical lead cannot act on. memberCommands.ts:331 `Replace the link only if your whole team agrees.` is good. teamSession.ts:654 `their devices changed` is jargon for a key rotation; say "Their key needs to be replaced because they signed in from a new computer." Fix: each paused text should end with the next action ("Click to check the log").

8. **WARNING. Inconsistent Title Case vs sentence case and category naming.** package.json:207-246 command titles are Title Case ("Link Team to NEAR Organization", "Sign Out of NEAR (Team)") with category "NEAR AI" while the project's own messages quote them as `"NEAR AI: Join Team"` (fine), but quick pick titles repeat `Manage Team Members` (memberCommands.ts:927, 960) and buttons are mixed: `Invite without NEAR`, `Remove unfinished keys`, `Clone repository` (sentence case) vs. `Sign in`, `Copy`, `Push`. Row actions at :896-899 (`Confirm`, `Send key`, `Rotate key`, `Remove`, `Cancel`, `Re-issue`, `Mark done`) mix "Re-issue" (hyphen) with message text "re-issue" and `reissue` in code; pick one. "Sign Out of NEAR (Team)" parenthetical is a code-style disambiguator; prefer "Sign Out of NEAR for This Team".

9. **WARNING. Notification-only prompts can be missed (interruptibility and verbosity).** teamSession.ts:633-655 announces "joined and is waiting for confirmation" with Confirm and Remove buttons side by side. A one-click Remove on a person who just joined sits beside Confirm in a non-modal toast; it routes to the modal at memberCommands.ts:722 so it is safe, but the label should be "Review" or "Remove..." signalling a follow-up. Also `firstTime` dedupe means a dismissed toast is never shown again; the only fallback is the status bar `(N pending)`, which (finding 5) does not open Manage. Fix as in 5.

10. **Minor. Empty description and dead pick text.** memberCommands.ts:420 sets `description: ''` for non-recommended lifetimes (renders nothing; omit the key). :487 `SKIP_CHOICE = 'Skip'` with description `Invite without one` is a generic label; use "Invite without a NEAR organization". :391 and :395-397 sign-out messages are good. `READ_ONLY_TEXT` (line 37) appears only after the user picks a row (line 966), so a read-only user can open a list of rows whose selection does nothing; disable by showing the explanation as the first non-selectable `Separator` row or in `title` (already adds "(read only)", good).

## Detailed Findings

### Pillar 1: Copywriting (3/4)
Positive: no em-dashes or en-dashes found in src/services/team/*.ts or the team/ helper strings (grep for U+2014/U+2013 returned none outside comments); messages are plain, say what changed and what happens next (memberCommands.ts:552-560, 622-640 "Nothing was changed.", "The link was not changed."). The privacy boundary is respected in text: email prompt says only a salted hash is stored (line 453); invite never logged (line 3).
Defects: generic "Cancel"/"Skip" labels (finding 8, 10); internal wire-format placeholder `near-ai-invite-v1....` (:541); `Team log not trusted` has no next step (teamStatusBar.ts:14); `their devices changed` (teamSession.ts:654); `Done: ${what}.` (memberCommands.ts:~832) reads as a terse log line; guarded fallback `${title} did not finish: ${error}` (memberCommands.ts:139) can show a raw error after `describe`, acceptable but gives no next step ("Try again, or see the NEAR AI output channel").

### Pillar 2: Visuals (2/4)
Package.json gives every command a codicon (`$(mail)`, `$(sign-in)`, `$(account)`, `$(link)`, `$(sign-out)`), but nothing inside the flows uses one: no `$(...)` in quick pick labels (memberCommands.ts:206, 319, 458-461, 485-486, 848-870), no separators, no grouping. The member list mixes members, invitations, cleanup steps and the NEAR sign-in state in one flat list with the NEAR row first and worded as a status (`NEAR: not signed in`, :840) that is actually an action. Status bar item lacks icon and `accessibilityInformation` (teamStatusBar.ts:72-91). Role quick pick (:458-461) is good: label plus short description.

### Pillar 3: Color (3/4)
Only theme token: `new vscode.ThemeColor('statusBarItem.warningBackground')` (teamStatusBar.ts:87), theme-aware so works in light, dark and high contrast; no hardcoded colors. Defect: one tier for four different states (unreachable, rewritten, missing, refused, removed). Refused or rewritten logs (a possible tampering signal) and "removed" should use `statusBarItem.errorBackground`; unreachable stays warning. Never relies on color alone: text differs per state (good).

### Pillar 4: Typography (3/4)
No fonts apply; evaluated as casing and labelling. Commands are consistent Title Case; messages sentence case; button labels mixed (finding 8). Status bar `Team: removed` lowercases the state while `Team sync paused: remote unreachable` also lowercases; consistent with each other. Quoting convention `"NEAR AI: Manage Team Members"` is used uniformly, good. Hyphen forms differ: `Re-issue` (:899) vs `re-issue` in text (:640) vs `reissue` code.

### Pillar 5: Spacing (2/4)
Message structure: several modals are a single 200+ character sentence (memberCommands.ts:406-408, :623-624, :722-723 detail, :755 cancel text). Better to split into a short title and a `detail` with line breaks (`\n\n`). The invite bundle in `detail` (:425-429) is a long unbroken token. Quick pick placeholders exceed one line (:208, :584-586 prompts of 190+ characters in the input box prompt line, which VS Code truncates). Label density: `Invitation for Name, developer, pending` (:857) packs three facts. Positive: Join, Invite and Manage titles are consistent per flow, so users keep context.

### Pillar 6: Experience Design (2/4)
Present: modal confirm for remove (:722), replace link (:334), reset keys (:622); cancellable browser sign-in with abort (:212-220); join progress (:575); `ignoreFocusOut: true` on all pickers and inputs (:127, :132) so a Tab away does not lose a half-filled invite (good); every input path returns undefined on Escape and prints "Nothing was changed"/"No invite was made" (:41-69, :632); offline gets `warn` not `error` (:600); read-only users see list but get a clear explanation; tracked cleanup list lets partial removal be finished later (:822-870), which is strong undo-like recovery; metadata-only privacy boundary kept (invite never logged, keys scrubbed via scrubNearText, display text escaped for `$(`).
Missing: progress for removal/keys/link/re-issue (finding 1); confirm for cancel (finding 2); the "Mark done" repo-access action (:906-910) trusts the lead without confirmation, acceptable but should say "Mark done" only after a modal if repository access is still present; no way to cancel the long Join progress (:575 has no `cancellable`); invite bundle loss path (finding 4); status bar click target (finding 5); no explicit empty state in Manage when the team has only the lead (the list shows just the NEAR row and the user's own row).

## Registry Safety
Not applicable: no components.json and no UI-SPEC.md registries.

## Files Audited
- src/services/team/memberCommands.ts (lines 1-60, 127-160, 198-260, 270-345, 376-440, 440-665, 700-977)
- src/services/team/teamSession.ts (lines 273-345, 485-500, 610-716)
- src/services/team/teamStatusBar.ts (full)
- src/services/team/teamCommands.ts (grep only, pre-phase surface)
- src/team/join.ts (NO_ORG_NOTICE), src/team/removedClient.ts (removedText)
- package.json (command contributions, lines 130-250)
- .planning/UX-CONTRACT.md; phase 61 SUMMARY, PLAN and CONTEXT files (scanned)

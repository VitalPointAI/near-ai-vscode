---
status: complete
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
source: [27-VERIFICATION.md, 27-16-PLAN.md Task 2]
started: 2026-11-13T18:04:20Z
updated: 2026-11-17T17:44:28Z
---

## Current Test

[testing complete]

## Tests

### 1. Same chats in code-server and desktop VS Code
expected: both history lists match, full messages, tool steps open
result: pass
source: automated (real VS Code 1.146 extension host, two user-data-dirs on one project: B lists A's chat, reopens every message, the tool card opens to its stored output). The owner's own old chats are encrypted with keys held only in each real editor, so that half is test 8.

### 2. Compare Models follows the project
expected: the 2026-11-12 comparison is listed in desktop without re-running; the import offer works either way
result: issue
reported: "Automated rehearsal on copies of the real storage: the 2026-11-12 comparison migrates and lists, but the desktop comparison 2026-11-08T00-28-34-953Z (mode \"run\", written by a pre-0.4.19 dev build) is silently skipped by parseSavedRun (src/benchmark/results.ts:605) and counted only as skipped."
severity: minor
source: automated (uat-a migrate.js)
re_verified: 2026-11-17, gap G-27-2 resolved by 27-19 (see Gaps). On main at 0.4.29, parseSavedRun maps the older mode "run" to "rerun" through one table (src/benchmark/results.ts:79, applied at :614); benchmarkResults.test.js 21/21 and stateMigration.test.js 25/25 pass, including the migration of a mode "run" comparison and the Compare Models history entry.

### 3. Pick up where you left off, no spend
expected: after a message in code-server and a desktop reload, the card shows that chat, run state and GSD next step; Open chat makes no new request or spend
result: pass
source: automated (B shows the card with last chat, finished run, phase and next step /gsd-plan-phase 1; Open chat reopened it and the mock model server saw no new request; readable in dark, light and high contrast)

### 4. Sync control visible and accessible; same-host key
expected: "Sync off · Turn on" next to the profile in both editors, reachable with Tab, readable in light/dark/high-contrast; desktop chats with sync off without re-entering the key
result: issue
reported: "Automated in a real VS Code window: the control is a real button with an accessible name, reachable with Tab, visible focus ring and good contrast in all three themes, and the same-host key works with no prompt and no plaintext on disk. Defects: (1) at the default side bar width (290 px) the label is cut to \"Sync off · Turn…\" and the profile chip shows only \"S.\" (media/chat/chat.css:359 #sync flex:none max-width:45% leaves the profile chip all the shrinking); attention and no-home labels are cut too. (2) In a folder with no remote the control opens as \"Sync off · Turn on\", never \"No online home · Set up\" (currentSyncStatus stays off until sync is turned on: src/services/chat.ts:161, src/services/syncCommands.ts:47; no-home only set after a failed turn-on/sync, src/services/syncFlows.ts:516,696). (3) Needs attention shows only \"Needs attention\" on the control; the plain error is only in the tooltip/aria-label (src/domain/state/syncStatus.ts:62-64), while D-16 says the error is shown on the control. (4) Minor: pick-up card time is 12-hour (media/chat/pickup.js:37) while the control is 24-hour; toast says \"Could not reach your git host…\" but the control says \"Couldn't reach…\"; the sync invitation sits above \"Connect NEAR AI to start\" with no spacing, before any profile exists."
severity: major
source: automated (uat-b screenshots W-1, C-6, B-7)
re_verified: 2026-11-17, gaps G-27-4a, G-27-4b, G-27-4c and G-27-4d resolved by 27-22, 27-24 and 27-25 (see Gaps). On main at 0.4.29 the extension-host suite in a real VS Code 1.144.1 window passed 23 of 23, including "a project with no online home opens with \"No online home · Set up\" on the sync control, without a click (G-27-4b)" and "every panel fits narrow widths without scrolling sideways" (the probe fails on any clipped must-read control at 170 to 590 px in all five sync states); syncControl.test.js 35/35, syncFlows.test.js 57/57, pickup.test.js 26/26 and responsivePanels.test.js 13/13 pass.

### 5. Turn on sync and restore with the recovery code
expected: consent screen, then the 52-character code once; a second clone restores chats, runs, comparisons, model choices and the NEAR AI key after Enter Recovery Code
result: pass
source: automated (real GitHub private repo ALuhning/near-ai-sync-uat-20261113; 52-char code; restore on a second clone with empty secret storage restored chats, run, comparison, model choice and the NEAR AI key; wrong and one-char-changed codes refused with no folder created; B to A sync works; code never stored)

### 6. Online home on a scratch folder
expected: private repo created with only near-ai/state; code push declined then accepted, planted .env blocked
result: issue
reported: "Automated against real GitHub: private repo created via the gh fallback, sync branch pushed, decline leaves code off the remote, .env blocked by name and by history scan with no values shown. Two defects: (1) the first push into the empty repo is near-ai/state, so GitHub makes it the DEFAULT branch: a plain clone on another computer checks out manifest.json and .bin files and the repo page shows them (src/services/onlineHome.ts:335-341; pushProjectCode never sets the default branch). (2) after declining the code push once, it can never be offered again: a second Give-online-home run stops at \"already has an online home\" (src/domain/state/onlineHome.ts:74, src/services/onlineHome.ts:305) and no other command calls pushProjectCode. Also: the code-push list includes .planning/.near-ai/auth-profiles.json (organization name, endpoint, profile ids, no key), which a public repo would publish."
severity: major
source: automated (uat-a abc.js)
re_verified: 2026-11-17, gaps G-27-6a, G-27-6b and G-27-6c resolved by 27-20, 27-21 and 27-23 (see Gaps). On main at 0.4.29: onlineHome.test.js 39/39, codePushLater.test.js 9/9 and codePushCheck.test.js 25/25 pass, against a local bare remote and a fake GitHub API. Not repeated against real GitHub in this re-check (an outward action); the live re-check of the default-branch move (G-27-6a) is the owner's, listed under Owner Re-Checks.

### 7. What GitHub sees
expected: near-ai/state holds only manifest.json and random .bin names, commits by near-ai-state, message "Update encrypted project state"
result: pass
source: automated (near-ai/state holds only manifest.json and 32-hex .bin files; commits by near-ai-state <state@near-ai.invalid> with the constant message; master untouched by sync; mirror-clone scan found no seeded plaintext in any sync object)

### 8. Your own old chats open in both real editors
expected: after installing the fixed VSIX in code-server and desktop VS Code, "NEAR AI: Show Chat History" in each lists the code-server week and the desktop chats, and they open with every message (needs each editor's own transcript key, which only the real editors hold)
result: pass
source: owner, 2026-11-17, 0.4.29 in code-server and desktop VS Code
reported: "Show Chat History lists both editors' old chats in each editor, and they open in full."

## Summary

total: 8
passed: 5
issues: 3
resolved_issues: 3
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-27-2
  truth: "Every comparison saved by either editor follows the project, including runs saved by older builds"
  status: resolved
  resolved_by: 27-19-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated: a desktop comparison with mode \"run\" (older dev build) is skipped by parseSavedRun and never shown"
  severity: minor
  test: 2
  artifacts: [src/benchmark/results.ts]
  missing: []
  evidence: "src/benchmark/results.ts:79 LEGACY_RUN_MODES maps run to rerun; :614 parseSavedRun looks the mode up there before the enum check, so every reader (migration, store, Compare Models history) gets a current mode. benchmarkResults.test.js 21/21 (four G-27-2 tests, including the source check that every reader goes through parseSavedRun) and stateMigration.test.js 25/25 (the mode \"run\" comparison migrates, lists and a second migration changes nothing) pass."

- gap_id: G-27-6a
  truth: "Giving a project an online home leaves the person's own branch as the repository's default branch; the encrypted sync branch is never the default"
  status: resolved
  live_recheck: pending (fixed in code and tested on a fake GitHub API and a local bare remote; the live default-branch move is the owner's optional re-check)
  resolved_by: 27-23-PLAN.md
  also_resolved_by: 27-20-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated against real GitHub: near-ai/state became default_branch; a plain clone checks out the encrypted files"
  severity: major
  test: 6
  artifacts: [src/services/onlineHome.ts, src/services/codePushCheck.ts]
  missing: []
  evidence: "src/services/githubApi.ts:34 isSafeBranchName and :115-117 setDefaultBranch (one PATCH with default_branch); src/services/onlineHome.ts:298 moveDefaultBranch moves only a default of near-ai/state, :315 defaultBranchAfterPush runs only after a pushed code result (setup flow :369-373, push-later command src/services/codePushLater.ts:101-102), :278 remoteDefaultBranch and the settings sentence for a pasted address, :341 repairDefaultBranch asks first for a repository an earlier build left on near-ai/state (re-run at :475). onlineHome.test.js 39/39 and codePushLater.test.js 9/9 pass."
  live_recheck: "Fixed in code and tested; live re-check is the owner's. The tests use a fake GitHub API and a local bare remote; that GitHub itself moves the default on the PATCH was not repeated here, since it creates and pushes to a real repository."

- gap_id: G-27-6b
  truth: "A person who declined pushing their code can choose to push it later"
  status: resolved
  resolved_by: 27-23-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated: after one decline, onlineHomeFlow returns 'already has an online home' and no command reaches pushProjectCode"
  severity: major
  test: 6
  artifacts: [src/domain/state/onlineHome.ts, src/services/onlineHome.ts]
  missing: []
  evidence: "Command nearAi.sync.pushCode \"Put This Project's Code Online\" declared in package.json:106-107 and registered at src/services/onlineHomeVscode.ts:165-169 (called from src/extension.ts:219); it runs pushCodeLaterFlow (src/services/codePushLater.ts:58), which calls the same checked pushProjectCode (:98). A re-run of the setup on a project with a home now offers the code push when the branch is not online (src/services/onlineHome.ts:469-472), and declining names the command (CODE_LATER, :358). codePushLater.test.js 9/9 (tracer: after a decline the command blocks a planted .env, then pushes once it is gone) and onlineHome.test.js 39/39 pass."

- gap_id: G-27-6c
  truth: "The code push does not publish organization metadata without saying so, especially to a public repository"
  status: resolved
  resolved_by: 27-21-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated: .planning/.near-ai/auth-profiles.json (organization name, endpoint, profile ids; no key) is in the push list and was pushed"
  severity: minor
  test: 6
  artifacts: [src/services/codePushCheck.ts]
  missing: []
  evidence: "src/services/codePushCheck.ts:107 NEAR_AI_PROJECT_FOLDER and :113 SHARED_PROJECT_FILES (team.md, project.json, verifiers.json only); :172-174 planCodePush holds every other untracked file there back and lists tracked ones; :446-447 a public repository is blocked while such a file is tracked; :453-454 the summary names what stays on this computer. codePushCheck.test.js 25/25 pass (held back and named, allowlist in step with the source, unknown files fail closed, look-alike folders are ordinary code, public block)."

- gap_id: G-27-4a
  truth: "The sync control and the profile chip are readable at the default side bar width, in every state"
  status: resolved
  resolved_by: 27-22-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated: at 290 px the control reads 'Sync off · Turn…' and the profile chip 'S.'; 'Needs attenti…' and 'No online ho…' are cut"
  severity: major
  test: 4
  artifacts: [media/chat/chat.css, media/chat/sync.js]
  missing: []
  evidence: "media/chat/chat.css:330 the bar wraps at every width, :332-333 a full-row break up to 480 px, :393 #profile and #sync never shrink (max-width 100%, text wraps); src/services/panelView.ts:122-126 data-must-read on both chips and the detail line, then the row break. media/shared/layout-probe.js:34-38 reports clipped must-read text and src/test/e2e/suite.ts:197 fails on it. Extension-host suite in a real VS Code 1.144.1 window 23/23, including \"every panel fits narrow widths without scrolling sideways\" (170 to 590 px, 290 px included, five sync states); syncControl.test.js 35/35 (label budget and chat.css guard) and responsivePanels.test.js 13/13 pass."

- gap_id: G-27-4b
  truth: "In a project with no online home the control reads 'No online home · Set up' as soon as the panel opens"
  status: resolved
  resolved_by: 27-24-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated: a no-remote workspace opens with 'Sync off · Turn on'; no-home appears only after a failed turn-on or sync"
  severity: major
  test: 4
  artifacts: [src/services/chat.ts, src/services/syncCommands.ts, src/services/syncFlows.ts]
  missing: []
  evidence: "src/services/syncFlows.ts:246 localHomeState lists remotes locally (no fetch, no write); :801-808 setHomeKnown moves off and no-home only while sync is off; src/services/syncCommands.ts:59 refreshSyncHome, run after the online-home, turn-on and turn-off commands (:205, :223, :228) and at activation (:251); src/services/chat.ts:176-178 and :609, :1076 on panel set-up and chat-ready. Extension-host test \"a project with no online home opens with \\\"No online home · Set up\\\" on the sync control, without a click (G-27-4b)\" passes; syncFlows.test.js 57/57 (home check is local, off and no-home follow the remote, never overrides sync on, wiring check) pass."

- gap_id: G-27-4c
  truth: "A sync error is shown in plain words on the control itself, not only in a tooltip"
  status: resolved
  resolved_by: 27-22-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated: the control shows only 'Needs attention'; the sentence is in title/aria-label and a one-time toast"
  severity: minor
  test: 4
  artifacts: [src/domain/state/syncStatus.ts, media/chat/sync.js]
  missing: []
  evidence: "src/domain/state/syncStatus.ts:62 the attention model carries the sentence as detail; media/chat/syncControl.js:72-79 shows it as text in #sync-detail and links the button with aria-describedby, hidden and unlinked in every other state; src/services/panelView.ts:125 the detail line; media/chat/chat.css:404-405 full-row, wrapping, theme colour. syncControl.test.js 35/35 pass (attention shows the sentence and describes the button; the next state empties, hides and unlinks it; markup is set as text)."

- gap_id: G-27-4d
  truth: "Times and wording are consistent, and the first-run screen asks to connect NEAR AI before offering sync"
  status: resolved
  resolved_by: 27-25-PLAN.md
  also_resolved_by: 27-24-PLAN.md
  resolved_at: 2026-11-17
  reason: "Automated: 12-hour time on the card vs 24-hour on the control; 'Could not' vs 'Couldn't' for the same error; the sync invitation sits above 'Connect NEAR AI to start' with no spacing before a profile exists"
  severity: cosmetic
  test: 4
  artifacts: [media/chat/pickup.js, src/domain/state/syncStatus.ts, src/services/syncFlows.ts, media/chat/chat.css]
  missing: []
  evidence: "Times: media/chat/syncControl.js:20-28 shortTime is the one formatter, in the panel's locale; the host sends a {time} slot (src/domain/state/syncStatus.ts:41, :52-54) and media/chat/pickup.js:34-37 uses the same formatter. Wording: src/services/syncFlows.ts:716-721 statusSentence is the one sentence for the toast (src/services/syncCommands.ts:214) and the control (syncFlows.ts:1042), from the transport's table (src/services/stateTransport.ts:36). First run: media/chat/chat.js:1368-1370 renders the invitation into the ready area, shown only once a profile works. syncControl.test.js 35/35, pickup.test.js 26/26 and syncFlows.test.js 57/57 pass (same instant reads the same, no \"Couldn't\" in the sync sources, the invitation lives inside the ready area)."

## Owner Re-Checks

Optional, not open gaps. Both need a real GitHub account or the owner's eye, which this re-check does not use.

- G-27-6a on real GitHub: on a scratch folder, give it an online home, push your code when offered, and check on GitHub that your branch (not near-ai/state) is the default branch and a plain clone checks out your files. For the repository made during the 2026-11-13 run, a re-run of "Give This Project an Online Home" should ask once to make your branch the default.
- G-27-4a look: at the default side bar width the profile and sync chips sit on their own row with nothing cut. The probe already proves nothing is clipped; this is only whether it looks right in your theme (27-22 D5).

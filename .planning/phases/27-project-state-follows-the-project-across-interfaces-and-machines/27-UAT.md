---
status: diagnosed
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
source: [27-VERIFICATION.md, 27-16-PLAN.md Task 2]
started: 2026-11-13T18:04:20Z
updated: 2026-11-13T18:33:07Z
---

## Current Test

number: 8
name: Your own old chats open in both real editors
expected: |
  After the gap fixes, install the fixed VSIX in code-server and desktop VS Code; Show Chat History lists both editors' old chats and they open in full.
awaiting: gap fixes, then the owner

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

### 7. What GitHub sees
expected: near-ai/state holds only manifest.json and random .bin names, commits by near-ai-state, message "Update encrypted project state"
result: pass
source: automated (near-ai/state holds only manifest.json and 32-hex .bin files; commits by near-ai-state <state@near-ai.invalid> with the constant message; master untouched by sync; mirror-clone scan found no seeded plaintext in any sync object)

### 8. Your own old chats open in both real editors
expected: after installing the fixed VSIX in code-server and desktop VS Code, "NEAR AI: Show Chat History" in each lists the code-server week and the desktop chats, and they open with every message (needs each editor's own transcript key, which only the real editors hold)
result: [pending]

## Summary

total: 8
passed: 4
issues: 3
pending: 1
skipped: 0
blocked: 0

## Gaps

- gap_id: G-27-2
  truth: "Every comparison saved by either editor follows the project, including runs saved by older builds"
  status: failed
  reason: "Automated: a desktop comparison with mode \"run\" (older dev build) is skipped by parseSavedRun and never shown"
  severity: minor
  test: 2
  artifacts: [src/benchmark/results.ts]
  missing: []

- gap_id: G-27-6a
  truth: "Giving a project an online home leaves the person's own branch as the repository's default branch; the encrypted sync branch is never the default"
  status: failed
  reason: "Automated against real GitHub: near-ai/state became default_branch; a plain clone checks out the encrypted files"
  severity: major
  test: 6
  artifacts: [src/services/onlineHome.ts, src/services/codePushCheck.ts]
  missing: []

- gap_id: G-27-6b
  truth: "A person who declined pushing their code can choose to push it later"
  status: failed
  reason: "Automated: after one decline, onlineHomeFlow returns 'already has an online home' and no command reaches pushProjectCode"
  severity: major
  test: 6
  artifacts: [src/domain/state/onlineHome.ts, src/services/onlineHome.ts]
  missing: []

- gap_id: G-27-6c
  truth: "The code push does not publish organization metadata without saying so, especially to a public repository"
  status: failed
  reason: "Automated: .planning/.near-ai/auth-profiles.json (organization name, endpoint, profile ids; no key) is in the push list and was pushed"
  severity: minor
  test: 6
  artifacts: [src/services/codePushCheck.ts]
  missing: []

- gap_id: G-27-4a
  truth: "The sync control and the profile chip are readable at the default side bar width, in every state"
  status: failed
  reason: "Automated: at 290 px the control reads 'Sync off · Turn…' and the profile chip 'S.'; 'Needs attenti…' and 'No online ho…' are cut"
  severity: major
  test: 4
  artifacts: [media/chat/chat.css, media/chat/sync.js]
  missing: []

- gap_id: G-27-4b
  truth: "In a project with no online home the control reads 'No online home · Set up' as soon as the panel opens"
  status: failed
  reason: "Automated: a no-remote workspace opens with 'Sync off · Turn on'; no-home appears only after a failed turn-on or sync"
  severity: major
  test: 4
  artifacts: [src/services/chat.ts, src/services/syncCommands.ts, src/services/syncFlows.ts]
  missing: []

- gap_id: G-27-4c
  truth: "A sync error is shown in plain words on the control itself, not only in a tooltip"
  status: failed
  reason: "Automated: the control shows only 'Needs attention'; the sentence is in title/aria-label and a one-time toast"
  severity: minor
  test: 4
  artifacts: [src/domain/state/syncStatus.ts, media/chat/sync.js]
  missing: []

- gap_id: G-27-4d
  truth: "Times and wording are consistent, and the first-run screen asks to connect NEAR AI before offering sync"
  status: failed
  reason: "Automated: 12-hour time on the card vs 24-hour on the control; 'Could not' vs 'Couldn't' for the same error; the sync invitation sits above 'Connect NEAR AI to start' with no spacing before a profile exists"
  severity: cosmetic
  test: 4
  artifacts: [media/chat/pickup.js, src/domain/state/syncStatus.ts, src/services/syncFlows.ts, media/chat/chat.css]
  missing: []

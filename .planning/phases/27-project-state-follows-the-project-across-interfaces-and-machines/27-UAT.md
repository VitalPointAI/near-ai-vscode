---
status: testing
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
source: [27-VERIFICATION.md, 27-16-PLAN.md Task 2]
started: 2026-11-13T18:04:20Z
updated: 2026-11-13T18:21:02Z
---

## Current Test

number: 1
name: Same chats in code-server and desktop VS Code
expected: |
  With the 27-16 Task 1 VSIX installed in both, "NEAR AI: Show Chat History" lists the same chats (the code-server week and the desktop chats); a long chat shows every message from the top and tool steps open to their output.
awaiting: user response

## Tests

### 1. Same chats in code-server and desktop VS Code
expected: both history lists match, full messages, tool steps open
result: [pending]

### 2. Compare Models follows the project
expected: the 2026-11-12 comparison is listed in desktop without re-running; the import offer works either way
result: issue
reported: "Automated rehearsal on copies of the real storage: the 2026-11-12 comparison migrates and lists, but the desktop comparison 2026-11-08T00-28-34-953Z (mode \"run\", written by a pre-0.4.19 dev build) is silently skipped by parseSavedRun (src/benchmark/results.ts:605) and counted only as skipped."
severity: minor
source: automated (uat-a migrate.js)

### 3. Pick up where you left off, no spend
expected: after a message in code-server and a desktop reload, the card shows that chat, run state and GSD next step; Open chat makes no new request or spend
result: [pending]

### 4. Sync control visible and accessible; same-host key
expected: "Sync off · Turn on" next to the profile in both editors, reachable with Tab, readable in light/dark/high-contrast; desktop chats with sync off without re-entering the key
result: [pending]

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

## Summary

total: 7
passed: 2
issues: 2
pending: 3
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

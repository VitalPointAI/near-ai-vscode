---
status: testing
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
source: [27-VERIFICATION.md, 27-16-PLAN.md Task 2]
started: 2026-11-13T18:04:20Z
updated: 2026-11-13T18:04:20Z
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
result: [pending]

### 3. Pick up where you left off, no spend
expected: after a message in code-server and a desktop reload, the card shows that chat, run state and GSD next step; Open chat makes no new request or spend
result: [pending]

### 4. Sync control visible and accessible; same-host key
expected: "Sync off · Turn on" next to the profile in both editors, reachable with Tab, readable in light/dark/high-contrast; desktop chats with sync off without re-entering the key
result: [pending]

### 5. Turn on sync and restore with the recovery code
expected: consent screen, then the 52-character code once; a second clone restores chats, runs, comparisons, model choices and the NEAR AI key after Enter Recovery Code
result: [pending]

### 6. Online home on a scratch folder
expected: private repo created with only near-ai/state; code push declined then accepted, planted .env blocked
result: [pending]

### 7. What GitHub sees
expected: near-ai/state holds only manifest.json and random .bin names, commits by near-ai-state, message "Update encrypted project state"
result: [pending]

## Summary

total: 7
passed: 0
issues: 0
pending: 7
skipped: 0
blocked: 0

## Gaps

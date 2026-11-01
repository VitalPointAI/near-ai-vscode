---
status: testing
phase: 60-team-core-identity-signed-event-log-git-transport-roster
source: [60-VERIFICATION.md]
started: 2026-11-01T14:09:01Z
updated: 2026-11-01T15:05:55Z
---

## Current Test

number: 1
name: Two real VS Code windows on two clones share the team, and an unreachable or stalled remote shows Team sync paused
expected: |
  Setup: install /home/aaron/projects/near-ai-team-uat/near-ai-vscode-0.6.0-team-uat.vsix (Extensions: Install from VSIX; reinstall 0.4.9 from the Marketplace afterwards). Open /home/aaron/projects/near-ai-team-uat/clone-a in one window and /home/aaron/projects/near-ai-team-uat/clone-b in a second window. In window A run NEAR AI: Enable Team Mode, accept the defaults, then click Push when offered (that pushes the commit holding team.json). In window B run git pull, then NEAR AI: Verify Team Log. Expected: window B's status bar reads "Team: <name>" and Verify Team Log lists the owner in the roster with no rejected events. Then in clone-b run git remote set-url origin http://127.0.0.1:9/x.git (refused): within one poll the status bar reads "Team sync paused: remote unreachable". Then git remote set-url origin http://10.255.255.1/x.git (stalled, no answer): within about 60 s the status bar still ends at "Team sync paused: remote unreachable" rather than staying on the healthy text, and the window stays responsive. Then git remote set-url origin /home/aaron/projects/near-ai-team-uat/remote.git: within a poll or two it returns to "Team: <name>".
awaiting: user response

## Tests

### 1. Two real VS Code windows on two clones share the team, and an unreachable or stalled remote shows Team sync paused
expected: Setup: install /home/aaron/projects/near-ai-team-uat/near-ai-vscode-0.6.0-team-uat.vsix (Extensions: Install from VSIX; reinstall 0.4.9 from the Marketplace afterwards). Open /home/aaron/projects/near-ai-team-uat/clone-a in one window and /home/aaron/projects/near-ai-team-uat/clone-b in a second window. In window A run NEAR AI: Enable Team Mode, accept the defaults, then click Push when offered (that pushes the commit holding team.json). In window B run git pull, then NEAR AI: Verify Team Log. Expected: window B's status bar reads "Team: <name>" and Verify Team Log lists the owner in the roster with no rejected events. Then in clone-b run git remote set-url origin http://127.0.0.1:9/x.git (refused): within one poll the status bar reads "Team sync paused: remote unreachable". Then git remote set-url origin http://10.255.255.1/x.git (stalled, no answer): within about 60 s the status bar still ends at "Team sync paused: remote unreachable" rather than staying on the healthy text, and the window stays responsive. Then git remote set-url origin /home/aaron/projects/near-ai-team-uat/remote.git: within a poll or two it returns to "Team: <name>".
result: [pending]

### 2. Decide whether code review finding CR-01 is accepted for Phase 60 or fixed before closing
expected: Either an explicit accept with reason, or a fix (settle from the timer and kill the process group) with a regression test that a timed-out git whose helper holds the pipes still settles.
result: pass
reason: "Owner chose fix; fixed in 53b3fc6 (process-group kill, settle from timer) with regression test teamRunGit.test.ts; re-verified 2026-11-01"

## Summary

total: 2
passed: 1
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps

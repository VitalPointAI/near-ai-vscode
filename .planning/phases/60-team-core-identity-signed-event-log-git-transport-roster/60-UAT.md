---
status: testing
phase: 60-team-core-identity-signed-event-log-git-transport-roster
source: [60-VERIFICATION.md]
started: 2026-11-01T14:09:01Z
updated: 2026-11-01T14:09:01Z
---

## Current Test

number: 1
name: Two real VS Code windows on two clones share the team, and an unreachable or stalled remote shows Team sync paused
expected: |
  Window B materialises the team and the owner's roster; the status bar reads "Team: <name>" while syncing and
  "Team sync paused: remote unreachable" when the remote is unreachable, and recovers when the remote returns.
  A stalled (not refused) connection must also end in the paused state rather than leaving the last healthy text.
awaiting: user response

## Tests

### 1. Two real VS Code windows on two clones share the team, and an unreachable or stalled remote shows Team sync paused
expected: In window A run NEAR AI: Enable Team Mode; open window B on a second clone and let it sync; then block the remote (unreachable host, then a stalled connection). Window B shows the team and roster; the status bar reads "Team: <name>", then "Team sync paused: remote unreachable", and recovers when the remote returns. A stalled connection also ends in the paused state.
result: [pending]

### 2. Decide whether code review finding CR-01 is accepted for Phase 60 or fixed before closing
expected: Either an explicit accept with reason, or a fix (settle from the timer and kill the process group) with a regression test that a timed-out git whose helper holds the pipes still settles.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps

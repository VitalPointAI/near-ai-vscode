---
status: testing
phase: 30-replication-contract-and-co-editing-core
source: [30-VERIFICATION.md]
started: 2026-11-19T23:10:57Z
updated: 2026-11-19T23:10:57Z
---

## Current Test

number: 1
name: Client id registration race (owner risk decision)
expected: |
  Either an owner decision recorded (accept as an insider-only risk, with the registration-refused report shown in Phase 33), or a follow-up item to bind a client id to its writer so a later or concurrent registration cannot displace an earlier one.
awaiting: user response

## Tests

### 1. Client id registration race (owner risk decision)
expected: Either an owner decision recorded (accept as an insider-only risk for drop A), or a follow-up item in Phase 31 or 33 to bind a client id to its writer.
result: [pending]

### 2. Late-joiner chains after a checkpoint, and how compaction-only text is shown
expected: An owner decision recorded on how a late joiner obtains chain prefixes (decide before Phase 32 signs checkpoints, since it may add a per-head lamport to the checkpoint format), and whether Phase 33 shows text from an unverified compaction as "author not yet checked".
result: [pending]

### 3. Y.decodeUpdate eager allocation under the 4 MiB cap (R-1, WR-07)
expected: Owner decision: accept as a known limit for drop A, or schedule a pre-decode struct-count check or a lower doc.update byte cap before any transport or store feeds the fold (the security audit suggests a Phase 31 entry gate).
result: [pending]

### 4. Schedule the review warnings WR-01 to WR-09
expected: A phase or hardening list for each. Suggested: WR-01 and WR-02 with the Phase 31 roster, WR-03 and WR-09 with the next fold fix round, WR-04 to WR-08 as one hardening item.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps

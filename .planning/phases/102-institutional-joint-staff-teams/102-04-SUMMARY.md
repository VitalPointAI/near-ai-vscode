---
phase: 102-institutional-joint-staff-teams
plan: "04"
completed: "2026-11-26"
status: verified-local
---

# 102-04 Fictional G2 records and G6 service catalogues

Staff Setup registers separate Canadian brigade L3 roles for the fictional office records catalogue and internal business service catalogue. Each role offers an exact metadata read and a local draft. The G2 domain steward decides the meaning and visibility of catalogue fields. The G6 portfolio owner decides which entries to accept. The service support route is a local desk label and instruction. Missing ownership, missing or overdue review dates and possible duplicates remain open for human review.

Both roles return the same fixed result for hidden and nonexistent records. They omit unapproved metadata and source text from the read, write and review surfaces. The running child rechecks field grants and current source evidence for reads, writes and review. Withdrawing access can hold an already permitted write before the final link is created and can hold reopening an older draft.

## Verification

- G2 source `498cfa6b4` passed all 27 focused cases with zero skips. The registered setup and actual child covered the metadata boundaries, hidden and nonexistent records, and late access withdrawal. Independent review found and then verified the correction to the Staff Setup confirmation.
- G6 source `4e4b60450` passed the final capped compile and all 84 combined cases with zero skips. The registered setup and actual child covered the fictional service entry, separate missing-owner exception, and withdrawn support route. Independent review matched all five source hashes. Both source commits passed the range scan. Saved evidence is under `.scratch/102-04-task1/` and `.scratch/102-04-task2/`.

## Open conditions

- **G17** remains open for production role authority, separation of duties and approval evidence. Production use and additional echelons need their own acceptance. The institutional blueprint remains in [PR #228](https://github.com/VitalPointAI/near-ai-vscode/pull/228).
- **G62** remains open for production workspace confinement and access to authorized real sources. The two verified roles use only controlled fictional fixtures.

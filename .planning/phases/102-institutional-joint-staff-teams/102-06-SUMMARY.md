---
phase: 102-institutional-joint-staff-teams
plan: "06"
completed: "2026-11-26"
status: verified-local
---

# 102-06 Fictional G4 inventory and G8 budget evidence reconciliation

Staff Setup registers separate Canadian brigade L3 roles for fictional office inventory and budget evidence. G4 compares separately attested counts for the same item, unit and approved cutoff. Unknown condition and custody remain visible to the human property custodian. Incompatible units, missing or mismatched cutoffs, and unknown quantities stay unresolved.

G8 compares admitted budget evidence only within the same category, period and unit. Disputed, duplicate and unconfirmed evidence retains the source references a reporting officer needs to investigate. These rows omit amounts and calculated differences. Incompatible evidence stays reason-only. Validation and release remain separate human decisions.

Each role can save an exact local draft. The active child applies current evidence checks at read, at the last point before saving the draft and when reopening a prior review. Both fixtures exercised evidence withdrawal before the read and after permission to save.

## Verification

- G4 source `e475c38ef` passed 44 focused cases with zero skips. Exact independent review verified the scope and the narrow shared domain split.
- G8 source `5973ceb80` passed 88 combined cases with zero skips. The focused correction restored exact admitted references for in-scope unresolved evidence and was independently rechecked. Both source commits passed range scans. Saved evidence is under `.scratch/102-06-task1/` and `.scratch/102-06-task2/`.

## Open conditions

- **G17** remains open for production authority, separation of duties and human approval evidence. Additional echelons need their own acceptance. The institutional blueprint remains in [PR #228](https://github.com/VitalPointAI/near-ai-vscode/pull/228).
- **G62** remains open for production confinement and access to authorized real sources. These fixtures use controlled fictional evidence.

---
status: complete
---

# Staff section selection

Source commit: b9506ce45. Team Studio now presents one opt-in checklist for the selected project. Each available or repairable section goes through the existing individual editor confirmation. The host refreshes the exact project and rotates its one-use handoff token between sections. Verified links and sections without compatible templates appear in coverage below the actions.

The baseline reproduced three missing selection and handoff behaviors. Independent review found the existing missing-link repair path needed to remain available. Two focused checks reproduced that regression before the fix. The final capped run passed all 234 existing and changed Team Studio, Staff Setup and copy checks with no skips. The revised source and tests passed independent read-only review. Worktree evidence is in .scratch/staff-selection-final.aXGlyk/result.log.

## Open conditions

- G17 and G62 remain open for authorized deployment and the separate whole-staff Apply path. This change uses individual section confirmations. The shipped template registry covers J2, J3, J4 and J5. The repair is local and follows the existing PR order.

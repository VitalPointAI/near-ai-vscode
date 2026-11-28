---
phase: 102-institutional-joint-staff-teams
plan: "08"
completed: "2026-11-26"
status: verified-local
---

# 102-08 Institutional duty coverage

The [coverage record](102-DUTY-COVERAGE.md) indexes **12 locally verified duties and 11 registered role choices** in the Canadian NATO-aligned brigade L3 fixture profile. The canonical tables define **149 duties**, of which **137** have no verified local draft in this record. L4, L2, L1 and L0 remain uncovered, as do the US, NATO multinational and unproved Canadian profile combinations. The 34 core and seven echelon scenarios remain separate acceptance inputs.

## Verification

- Reviewed plan commit `e5857be7f` has SHA-256 `4644b54a8f08a4835820254764adde142f0c3ae96691f7fec0b351d1ee026db7`. The tracked Phase 102-07 closure is `2395e730b034d2c93c3365af4e5cb8a73502a527`. The G1 and Special Staff source revisions are `b7cb0c531300abe4dcea494412fd170b3a42b6ba` and `ac0208be156c268bc7c5efa72e46e3b92d67378d`.
- The plan's read-only command matched all three inventory files byte for byte to reviewed blueprint `360515a60b041d28d89123bb214d6388b2d41aab`. It checked 149 unique and disjoint IDs and all 12 exact source-to-summary mappings, including source commit ancestry, verified summary and the duty in committed tracer or contract source.
- A read-only source check during preparation confirmed the registered members and staged skills, the local tool effects and draft directories, and the corresponding fixture evidence. It confirmed that one registered G7 role carries two distinct draft duties. The predecessor summaries record independent review and zero skipped acceptance checks for the verified overlays. Independent readback of the coverage record is the merge checkpoint.

## Open conditions

- **G17** remains open for production authority, segregation of duties and independent human approval evidence. Uncovered echelons and profiles need their own acceptance. [PR #228](https://github.com/VitalPointAI/near-ai-vscode/pull/228) remains the blueprint publication dependency.
- **G62** remains open for proven production workspace confinement and authorized access to real sources.

---
phase: "29"
slug: recoverable-project-cleanup
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-26"
---

# Phase 29 validation strategy

Use the repository's Node test harness, existing gate fixtures and private synthetic workspaces.
Keep tests first, run the smallest affected checks after each change and use the shared heavy-job
cap for phase verification. No actual user workspace, operator container or protected key
store is part of acceptance.

| Requirement | Evidence required |
| --- | --- |
| CLEAN-01 | A dry run derives candidates from successful, verified artifact records or the small reviewed disposable list. Missing, stale, forged or ambiguous provenance cannot expand that set. |
| CLEAN-02 | The gate and operation enforce every published never-touch rule. A moved or replaced item and an unobservable or active process claim prevent mutation. Tests prove the actual path boundary and rechecks. |
| CLEAN-03 | Quarantine preserves bytes and a usable record. Recovery after interruption remains possible. Restore proves ownership, integrity and no replacement. The retention boundary is tested with a controlled clock. |
| CLEAN-04 | Preview is read-only. Confirmations bind the exact item, effect and current state. Every permanent purge remains separately human-authorized after retention. |
| CLEAN-05 | The registered cleanup member has exactly the scoped capability and the permitted read-only tools. Verify every refusal through an isolated end-to-end request, with outside and unrelated bytes unchanged. |

A test fixture can prove local rules and operation outcomes. It cannot establish coverage
of host activity or deployment support. Establish those conditions on the supported
runtime before enabling mutation there. Report inconclusive checks as unresolved.

## Verification by plan

| Plan | Focused verification | Acceptance evidence |
| --- | --- | --- |
| 29-01 | `cleanupPreview`, `gateManifests`, and the affected tool, checkpoint, and session tests | The registered preview derives candidates from trusted producer evidence. The trusted software cleanup member reaches it through normal dispatch. Other team members and custom definitions cannot invoke it. |
| 29-02 | `cleanupSafety`, `cleanupPreview`, and the affected floor, approval, and path tests | Each refusal prevents a file move. A current exact approval reaches private same-filesystem quarantine under an enforced activity boundary. Reopening after interruption finds the record and the artifact. |
| 29-03 | `cleanupRecovery` and the affected gate, command, and role tests | The registered operator commands reach the shared gate. Restore preserves access controls and never replaces a destination. Retention and fresh human approval both precede permanent purge. |
| 29-04 | Workbench container and browser harness using the immutable local Release-target image ID | The bundled plugin produces an enrolled report, previews it, quarantines it and restores it through normal controls. The runtime proves private mediated access to the artifact volume. An ordinary workspace stays preview-only. |

Record the actual built Workbench, managed producer and mount used for runtime acceptance.
Reopen the application and verify that the eligible artifact, quarantine record and restored
item stay associated with the same authorized project. Include the unsupported-mount path
and confirm that it remains preview-only. Moving within a filesystem preserves recoverability
and does not reclaim capacity. Record a reclaimed-space result only after an authorized purge.

## Sign-off

- [ ] Exact planned verification commands passed on the implementation.
- [ ] The deployed-runtime containment and in-use evidence are verified.
- [ ] All incomplete acceptance has a scoped record.

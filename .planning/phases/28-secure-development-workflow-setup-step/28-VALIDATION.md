---
phase: "28"
slug: secure-development-workflow-setup-step
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-26"
---

# Phase 28 validation strategy

Run the existing Node test harness and repository compile command in the phase worktree.
Use the handover's shared heavy-job lock, memory cap and unique scratch directory. Run the
smallest relevant test after each behavior change and one complete relevant run at the
phase boundary. The plans name the exact files and invocations.

| Requirement | Automated evidence required | Additional acceptance |
| --- | --- | --- |
| DEVF-01 | Exercise the registered Project Setup command and software selection with the actual DevOps member. Verify skip, reopen, keyboard recovery, project switch and accurate local and remote status. | Confirm from the supported Workbench shortcut and editor-native Setup entry. |
| DEVF-02 | Render the one supported kit in a temporary project. Verify locked build inputs, CI, exact-head reviewer and workflow identity, denial of changed approval scope, independent release approval, and byte-identical artifact publication in recording fixtures. | Observe a full bootstrap, reviewed PR, protected tag and approved release on a named disposable repository after owner authorization. |
| DEVF-03 | Verify only approved typed reads reach the GitHub adapter. Missing, inaccessible, stale, inherited and incompatible remote evidence must leave accurate outstanding work. Credentials remain with the owner. | Owner applies settings in the disposable repository and verifies the effective protections and independent identity. |
| DEVF-04 | Compare missing, exact and conflicting files. Recheck selected project and snapshots at apply time. Verify safe repeat after a partial write and preservation of custom files. | Confirm a custom workflow remains visible and unchanged through review and repeat. |

## Per-task checks

These are the focused runner arguments after the repository compile step. Each plan has the
capped command and preconditions. The test files are expected from their owning tasks.

| Task | Evidence file or focused runner scope | Status |
| --- | --- | --- |
| 28-01-01 | `dist/test/workflowSetup.test.js` and `dist/test/setupSteps.test.js` for the local preview and guarded-writer fixture | Pending |
| 28-01-02 | Built Workbench placement boundary, packaged helper identity and `dist/test/workflowSetup.test.js` for parent-change, post-hash placement and interrupted-write cases | Pending |
| 28-01-03 | Setup and architecture checks for exact preview, conflicts, partial results and retry | Pending |
| 28-02-01 | `dist/test/workflowSetupKit.test.js`, `scripts/test/workflow.test.mjs` and the setup fixture for review origin and head | Pending |
| 28-02-02 | Kit and workflow-file checks, setup fixture and `npm run verify:release` for the export boundary | Pending |
| 28-03-01 | `dist/test/workflowSetupEvidence.test.js` and existing workflow proof checks for typed readback | Pending |
| 28-03-02 | Setup, evidence, architecture and kit fixtures plus the generated roadmap check for completion state | Pending |
| 28-03-03 | Focused kit and evidence checks, then owner-authorized disposable repository verification | Pending |

Use fixture-only projects and recording adapters for the automated tasks. A successful fixture
run establishes local behavior. It leaves the live repository acceptance pending. The owner
chooses and approves the disposable target and administers any remote settings there.

## Sign-off

- [ ] All plan verification commands ran on the exact implementation.
- [ ] The supported project completes its local workflow and preserves user files on re-entry.
- [ ] The owner-approved disposable target proves the live checks and release boundary.

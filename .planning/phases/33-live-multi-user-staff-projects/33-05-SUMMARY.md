---
phase: 33-live-multi-user-staff-projects
plan: 05
status: complete
subsystem: shared version acts and the staff host's shared branch
tags: [staff, replica, versions, decisions, contested, d-24, d-41]
requires: []
provides: [VersionActs.propose, decisionStampAt, sharedProductOf, sharedHostAct, StaffHost.sharedReplica context]
affects: [33-13, 33-14, 33-21, 33-24, 33-26]
tech-stack:
  added: []
  patterns: [one-line delegation from a frozen host, checked append with a fresh fold per attempt, decision stamp]
key-files:
  created: []
  modified:
    - src/staff/replica/versionActs.ts
    - src/staff/replica/contested.ts
    - src/staff/staffHost.ts
    - src/test/staffSharedVersionActs.test.ts
    - src/test/staffReplicaHostMode.test.ts
    - src/test/staffContested.test.ts
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 21000
  tasks: 3
  commits: 3
completed: 2026-11-24
plan_head_before: 406cc5c523f3e657cbb5611a7b43833684ce43d2
---

# Phase 33 Plan 05: Shared version acts Summary

Proposals, verdicts, submissions and a person's decisions now work in a shared project through one write path: `VersionActs` over the signed record, reached from the frozen `StaffHost` by a one-line delegation per method. The host stays at its frozen 1688 lines.

## Reconciled from Codex

- The integration branch already held `versionActs.ts` (verdict, submit, decide, release, withdraw, supersede, with the stamp and settle checks), `contested.ts` and `StaffHost.sharedReplica()`. `git cherry` showed `feat/phase-33-05-host-access` fully merged.
- `367a45ec` (verified shared decision stamps, `decisionStampAt` and the stamp lookup on `sharedReplica()`) was the one missing commit. It was cherry-picked with its authorship as `be7f39ba`.

## What this plan added (f86ece68)

- **`VersionActs.propose`** rebuilds the product's text from the updates the fold accepted, never from the file on disk. It refuses with `text-incomplete` when this computer cannot rebuild the whole text, `unchanged` when the text equals the newest version, and `header-missing` when a first version has no kind, profile or level. The header and pins default to the newest version's, and the label to the cell's.
- **`sharedHostAct`** is the shared branch of `StaffHost.propose`, `verdict`, `submit`, `withdraw` and `decide`. Each method resolves the member (or the named person) first, then hands a shared project over in one line. A project that cannot be checked, or is shared but not open here, keeps its existing refusal, and nothing is written. Registers, wargame, CCIR and steps stay refused.
- **The mechanical gates stay in force in a shared project.** CLEARED runs guard-scan, and SIGN-OFF runs the tradecraft lint. Each counts only when the product file on this computer is exactly the version named, by its projected number and hash. Otherwise the step is refused with "the product file on this computer is not version N. Sync, then check it again."
- `decide` passes the decision stamp and settle flag through. An approval or release must name the version hash the person saw. `releaseOnApproval` releases after the approval, and a release supersedes older released versions, as on a single machine.
- `StaffHost.sharedReplica()` also returns the project's `context` (its deps), so a proposal never opens a second `ReplicaProject`.
- The contested card credits an agent as "An agent", where it said "A project agent" (D-69).

### Host methods that now delegate

propose, verdict, submit, withdraw, decide. `wc -l src/staff/staffHost.ts`: 1688 before and 1688 after. The header no longer says writes arrive in Phase 33.

## Deviations from Plan

1. **[Re-aim] The `staffCommands.ts` and `staffRoom.ts` parts of Task 3 were not done.** The re-aim moved the decision dialog to native Theia (33-26). Must-have truth 4 holds through `versionActs`, and through `host.decide`, which carries the stamp.
2. **[Rule 2, security] Gate checks in shared mode.** The plan did not say whether guard-scan and the tradecraft lint run for a shared verdict. Without them, a release guard could CLEAR a version that no scanner had read. They now run only on a file that is exactly the named version.
3. **[Rule 2] An agent cannot withdraw in a shared project.** `host.withdraw` is an agent verb on a single machine. In a shared project, withdrawing is person-only (must-have truth 2), so the host returns "Only a named person can take this step."
4. **No `staffDecideWhileChanged.test.ts` file.** The CHANGED_WHILE_DECIDING path through the host is covered in `staffSharedVersionActs.test.ts`, beside the existing stamp tests, so no new file was added.
5. **One existing test was changed, without weakening it.** The test in `staffReplicaHostMode.test.ts` that asserted every write refused still asserts that for all 16 methods that stay refused. For the five methods that now delegate, it asserts that none gives the shared-project refusal and none writes outside the shared store. The minimum count dropped from 20 to 16 for that reason.

## Verification

Run under the shared heavy lock, MemoryMax=6G and choom: `npm run compile`, then `run-tests` on staffSharedVersionActs, staffContested, staffReplicaHostMode, replicaVersionDecisions, replicaForbiddenActs, staffReplicaParity, staffRoom, staffToolSurface, copyLint and architecture. **154 tests passed and 0 failed.** The compile step's tsc is the same check as `npm run lint`.

- Tests added: 2, in `staffSharedVersionActs.test.ts`. One covers propose from the live text. The other is the host-delegation tracer: propose, the CLEARED refusal on an edited file, CLEARED, submit, an agent's withdrawal refused, the stale-stamp refusal, an approval with no hash refused, and approve and release.
- Tests changed: 2. One is the refusal-list test above. In the other, the contested-card name text became "An agent".
- `staffSharedVersionActs.test.ts` has 19 tests and `staffContested.test.ts` has 9. The copy-lint and architecture baselines are unchanged.

## Known Stubs

None.

## Threat Flags

None. No new network surface was added. The person-key signer for decisions remains 33-21 (D-60). Until then, decisions are signed by the device key, as before.

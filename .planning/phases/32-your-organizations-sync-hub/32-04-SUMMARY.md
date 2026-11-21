---
phase: 32-your-organizations-sync-hub
plan: 04
subsystem: staff-replica-membership
status: complete
tags: [membership, roster, split, lead-role, secrets, tests]
requires: []
provides:
  - "describeRosterBranches over a narrow read-only roster line reader (branchEntries)"
  - "tests pinning the lead role to handover or naming the deputy, on the fold and the host"
  - "field-exact secret search of the invitation and join request texts"
affects:
  - src/services/staffMultiUserCommands.ts (Choose Roster Branch calls describeRosterBranches; unchanged)
tech-stack:
  added: []
  patterns:
    - "read-only chunked line reader with lstat path checks, O_NOFOLLOW, overlong-line skip and early stop"
    - "node:test mock.method to prove a costly path is never taken"
key-files:
  created: []
  modified:
    - src/staff/replica/membership.ts
    - src/test/staffReplicaMembership.test.ts
decisions:
  - "The narrow reader uses the store's own line limit formula (HEADER_MAX_BYTES + base64url of INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD + 1024) so it skips exactly what the store would"
  - "updateMember needed no change: the host already refuses lead roles before writing; the tests pin it (D-66)"
  - "In 'removing a member' the copy of REKEY_KEEP_TEXT's words was replaced by endsWith(REKEY_KEEP_TEXT) plus the phrases '2 parts' and 'moved to a new key'"
metrics:
  duration: "about 35 minutes"
  completed: 2026-11-20
actuals:
  tokens: 6750
  tasks: 2
  commits: 2
plan_head_before: ffddff863527f3bdb581bc908442b161c3804871
plan_head_after: fcaaf3b8439c96f7f9f198611a29f5e714b7ff4e
---

# Phase 32 Plan 04: Membership lean branches and lead-role tests Summary

Choose Roster Branch now describes a split by reading only the base stream's roster line files (read only, links refused, damaged and overlong lines skipped, stop when both entries are found) instead of building a whole welcome file; the rule that only a handover or naming the deputy moves the lead role is pinned on the fold and the host from both roster writers; and the no-secret test now searches the invitation and join request texts field by field.

## Tasks

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Tracer: a roster split is described from the two branch entries alone | a543b893 | membership.ts, staffReplicaMembership.test.ts |
| 2 | Lead role cannot be moved by member.update; secret-carrying texts searched; key-phrase assertions | fcaaf3b8 | staffReplicaMembership.test.ts |

## What changed

- `membership.ts`: new private `eachLine` (64 KiB chunks, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, plain files only, a line over the store's limit skipped without being held whole, bytes after the last newline left) and `branchEntries(project, hashes)` (lstat each part from the project root to `streams/<project id>`, a link or non-folder gives nothing; names matching `^[0-9a-f]{64}\.jsonl$`, sorted; `parseSealed(JSON.parse(line))`, kept when the header's stream is the project id and `entryHash(header)` is wanted; stops when every wanted hash is found). `describeRosterBranches` uses it; `welcomeFor` is no longer called there (acceptance awk/grep count: 0). File header comment updated to name the one read-only exception to "Node I/O through ReplicaProject and keyring.ts".
- `staffReplicaMembership.test.ts`: helper `leadSplit`, 4 new tests, the no-secret test extended, 4 brittle sentence assertions converted.

## Tests (focused, under the memory cap)

- staffReplicaMembership: 43 pass, 0 fail (39 at HEAD, +4 new tests).
- replicaRoster: 24 pass, 0 fail. staffMultiUserCommands: 28 pass, 0 fail. `npm run lint` exit 0.
- Acceptance: `grep -cE "assert\.match\([^,]+, /A removal or clearance change left unfinished was finished first: "` is 0 (was 2).

### Failing first (Task 1)

On the unchanged code (welcomeFor as the only source):
- "describeRosterBranches describes both branches of a split from the roster lines, without a welcome file" failed: actual 'A roster change this computer cannot read', expected 'Changes the details of Nell Planner'.
- "describeRosterBranches skips damaged and overlong roster lines, and reads nothing through a symbolic link in place of the roster folder" failed: the overlong-padded branch was still described (the in-memory store ignored the files), expected 'A roster change this computer cannot read'.

### Mutation proofs (Task 2, D-66; each reverted, worktree verified clean)

1. Fold check removed (`rosterMembers.ts` applyUpdate lead-role line): "member.update cannot give the lead role..." failed with "lead: refused by the fold". Only that test failed.
2. Join secret put into the join request payload (`invite.ts` buildJoinRequest sets `payload.secret`, joinPayloadOf allows the key so the flow still works): "no message, file name or result field contains a join secret, a key or the MAC" failed with "the join request holds no join secret", the new assertion. Only that test failed.
3. Extra: `roster.ts` hasRoleAt reads staff_lead from the record's roles: "a member.update from the deputy that leaves staff_lead out of the lead's roles changes no leadership..." failed.
4. Extra: host check removed in `updateMember`: the lead-role test failed, actual 'change-not-applied', expected 'lead-role-by-handover-only'.

## Decisions

- Proceeded with all 32-CONTEXT.md defaults (D-08, D-12, D-66). No checkpoints in this plan.
- `updateMember` already refuses `staff_lead` and `deputy_lead` before writing; no code change, pinned by test and mutation 4.
- D-12 conversions: result `ok` asserted exactly; `rekeyed` lists asserted exactly where the result carries them (removing a member: [base, X]; MJ-04 remove B: [base, base], the base cell finished first and then moved again); the admission result carries no rekeyed list, so its `ok` and the phrases "left unfinished" and "finished first: 2 parts" are asserted, with the epoch checks that follow unchanged. The result type has no skipped list; the skipped case is matched by "Nobody else is on one part" and "no new key".

## Deviations from Plan

- The plan's Branch line names `feat/phase-32-04-membership-lean`; work was done on `feat/phase-32-04-membership-tests` as the orchestrator set up the worktree.
- Two extra mutation proofs (3 and 4) beyond the two the plan asks for. No other deviations.

## Files touched outside the plan's list

None committed. `rosterMembers.ts`, `invite.ts`, `roster.ts` and `membership.ts` were changed only temporarily for the mutation proofs and restored with `git checkout -- <file>`.

## Threat Flags

None. `branchEntries` is a new read of local files under the project folder, covered by T-32-12 (streamed, bounded, link-refusing, read only).

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: src/staff/replica/membership.ts, src/test/staffReplicaMembership.test.ts
- FOUND: a543b893, fcaaf3b8 (ancestors of HEAD)

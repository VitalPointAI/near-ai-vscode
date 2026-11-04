---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 28
subsystem: auth
tags: [team-mode, join-request, invite, ed25519, secret-storage, gap-closure, G-61-9]

requires:
  - phase: 61-26
    provides: "Team section and invite flows the Ask to join commands (61-29) will sit beside"
  - phase: 61-18
    provides: "catchUpCopy: bringing a behind copy up to date safely"
provides:
  - "src/team/joinRequest.ts: signed join request text (near-ai-join-request-v1.), check code, stored request in secure storage, accept by a lead, completion by the requester, accepted list (vscode-free)"
  - "invite.ts: issue() takes a preset member id and invitation key (acceptRequestInvite), makes no code and no invite text"
  - "catchUpCopy without a team id: any readable team.json at the online tip qualifies, same safety rules"
affects: [61-29, 61-30, 61-31]

actuals:
  tokens: 19323
  tasks: 3
  commits: 5
plan_head_before: 6a8383a79d28cbe41e521b23f2388be1190c2329
plan_head_after: ae9710c8c067d9161f98125a0dd1491a3988712c

tech-stack:
  added: []
  patterns:
    - "Invite in reverse: the requester's computer makes and keeps the code; only the derived public key travels, self-signed over purpose-prefixed canonical JSON"
    - "The request text is rebuilt from the stored code each time (Ed25519 signatures are deterministic), so text and code can never disagree"
    - "Key and signature fields are secret-checked as key material (publicKey/sig exemptions), typed fields as text"

key-files:
  created:
    - src/team/joinRequest.ts
    - src/test/teamJoinRequest.test.ts
  modified:
    - src/team/invite.ts
    - src/team/joinCatchUp.ts
    - src/test/teamJoinCatchUp.test.ts

key-decisions:
  - "The stored request in SecretStorage holds { v, memberId, code, name, email?, ref }; ref is kept so readPendingRequest can rebuild the text without team.json"
  - "parseJoinRequest refuses unknown fields (they would ride along unsigned) and any non-canonical spelling; the signature covers purpose 'near-ai.team.join-request' plus every field but sig"
  - "acceptJoinRequest re-checks the request object from its own encoding, so a field changed after parsing is refused like a changed paste"
  - "completeJoinRequest decides cancelled, used and key mismatch from the given state before any join; expiry comes from joinTeam's early check, which runs before any key is made; expired and cancelled keep the stored request so it can be cancelled or asked again"
  - "createJoinRequest refuses a computer that already holds a device or seal key for the team"

patterns-established:
  - "accepted-requests.json: { version: 1, accepted: [{ memberId, name, invitedEvent }] }, serialised writes, assertNoSecrets, capped at 500 entries"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "A person with a copy and no invite makes a signed request holding only the public key; the owner accepts it as a normal member.invited for that key; the requester's computer then joins by itself (observer until confirmed) and forgets the code"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#tracer: a person with a copy asks, the owner accepts, and the copy joins by itself with no code travelling"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every refusal: prefix, size, spelling, ids, name, email, secret shape, changed field, other key; another team or record, second accept, developer accept write nothing; expired and cancelled keep no key; cancel forgets the code; lead request sends the invitation to your organization"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamJoinRequest.test.ts#parseJoinRequest refuses another prefix, an oversized or damaged text and a non-canonical spelling, with fixed sentences"
        status: pass
      - kind: unit
        ref: "src/test/teamJoinRequest.test.ts#parseJoinRequest refuses bad ids, a bad name or email, a secret-shaped field, a changed field and another key's signature"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#accepting refuses a request for another team or team record, a second accept and a developer, and writes nothing"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#an accepted request whose invitation expired or was cancelled is reported plainly and leaves no team key on the requester's computer"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#a lead request in a linked team sends the invitation to your organization to the email given at accept, and the lead joins by itself"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#the accepting computer notes only member ids, names and event ids, and only it knows it accepted"
        status: pass
    human_judgment: false
  - id: D3
    description: "A behind copy (no team.json) is caught up with no team id under Join's rules, or told not-shared"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#without a team id, a behind clean copy whose online version has team.json is brought up to date with the same safe git calls"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#a copy that is behind (no team.json yet) is brought up to date with no team id and can then ask; with no team online it is told so"
        status: pass
    human_judgment: false
  - id: D4
    description: "No code, key or token anywhere written; event shapes identical to an invite's; format files unchanged since 195c30a"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#privacy: after a request, an accept and the join, the code is nowhere but the requester's secure storage, and then nowhere at all"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinRequest.test.ts#an accepted request writes member.invited and member.joined in exactly the shape an invite and its join write"
        status: pass
      - kind: other
        ref: "git diff --quiet 195c30a -- src/domain/team/validate.ts src/domain/team/canonical.ts src/domain/team/invite.ts src/team/eventLog.ts src/team/inviteBundle.ts src/team/inviteCode.ts src/team/identity.ts src/team/keySeal.ts"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-04
status: complete
---

# Phase 61 Plan 28: Ask to join core Summary

**Ask to join works as an invite in reverse. The requester's computer makes the single-use code and keeps it in secure storage. It hands over a self-signed `near-ai-join-request-v1.` text that holds only the derived public key. A lead's accept writes a normal member.invited bound to that key through the invite code path. The requester's computer then joins by itself with the existing code proof and forgets the code. No code travels, and the signed log format is unchanged.**

## Performance

- **Duration:** about 25 min
- **Started:** 2026-11-04T20:51:10Z
- **Completed:** 2026-11-04T21:16:00Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- `joinRequest.ts` contains the following, and none of it imports vscode:
  - `parseJoinRequest` reads the request as hostile input: exact prefix, 2048-byte cap, strict canonical base64url and canonical JSON, no unknown fields, pattern checks, a secret-shape check and an Ed25519 self-signature. Every failure is a fixed sentence that never repeats the input.
  - `requestCheckCode` gives XXXX-XXXX from a hash of the request.
  - `createJoinRequest`, `readPendingRequest` and `cancelJoinRequest` handle the stored request.
  - `acceptJoinRequest` checks the team, the team record and that the member id is not already on the list. It then calls `acceptRequestInvite`, so the permission check, the email hash, `invites.json` and a lead's invitation to your organization all work exactly as for an invite. It notes the accept in `accepted-requests.json`.
  - `wasAcceptedHere` tells the accepting computer whether it accepted a given member id.
  - `completeJoinRequest` returns one of none, not-yet, joined, expired, cancelled, used or failed.
- `invite.ts`: `issue()` takes an optional preset `{ memberId, invitePublicKey }`. With a preset it reads no remote address, makes no code and builds no bundle, and the result has no bundle field. It also re-checks inside the log builder that the member id is not already on the list. `inviteMember` and `reissueInvite` behave as before.
- `catchUpCopy` now takes `teamId` as optional. Without it, any readable team.json at the online tip qualifies. A missing team.json never does: it answers `not-shared`. All other rules and the git call audit are unchanged.

## Task Commits

1. **Task 1 (tracer) RED:** `ab16bf8` test(61-28): a person with a copy asks to join, the owner accepts, the copy joins by itself (RED)
2. **Task 1 GREEN:** `3a936ea` feat(61-28): ask to join, accept and join by itself with the code kept on the requester's computer (GREEN)
3. **Task 2 RED:** `67aee2f` test(61-28): every join-request refusal, and a behind copy caught up with no team id (RED)
4. **Task 2 GREEN:** `4aaf469` feat(61-28): a behind copy with no invite is caught up to any team online, under the same rules (GREEN)
5. **Task 3:** `ae9710c` test(61-28): asking to join leaks no code, key or token, and writes the invite's own event shapes

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 1 RED:** `node --test --test-reporter=tap --test-name-pattern=^tracer dist/test/teamJoinRequest.test.js` exited 1. The target "tracer: a person with a copy asks, the owner accepts, and the copy joins by itself with no code travelling" failed on its first assertion, "the request text has the join-request prefix" (expected true, actual false). Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: joinRequest.ts was declared only, with inert return values, so the module loaded and the failure was the planned behaviour assertion.
- **Task 1 tracer gate (auto mode):** the Task 1 verify (tsc, then teamJoinRequest, teamInvite and teamInviteFlow) was re-run end-to-end: 34 tests, 34 pass. Expansion continued.
- **Task 2 RED:** target "without a team id, a behind clean copy whose online version has team.json is brought up to date with the same safe git calls". Expected `{ ok: true, updated: true, branch: 'main' }`, actual `{ ok: false, reason: 'not-shared' }`. Classifier: RED_EVIDENCE_OK (target_test_failed). Only the type of `teamId` was made optional at RED, so it compiled. The other two new catch-up tests and the behind-copy request test also failed on their planned assertions. The not-shared test showed a real hazard: with `teamId` undefined, the old comparison `teamAt(tip) !== teamId` treated a missing team.json as a match and answered ok.
- **Task 2 refusal tests passed at RED.** Task 1's implementation already contained the checks: parse rules, team and ref match, second accept, write-side permission, expiry before any key is made, cancel, lead invitation, and the accepted list. They are kept as regression guards. The RED target was the catch-up behaviour, which was not built yet.
- **Task 3** has no RED. Its tests check guarantees that Tasks 1 and 2 already built (privacy canary, event shapes), so they passed on the first run. The privacy test includes a planted control file to show the scanner finds the code.

## Verification

- Task 1 verify: exit 0, 34 tests, 34 pass.
- Task 2 verify (`teamJoinRequest`), plus `teamJoinCatchUp` and `teamJoin`: exit 0, 42 tests, 42 pass.
- Task 3 verify (`tsc`, teamJoinRequest, teamInvitePrivacy, teamJoin, then `git diff --quiet 195c30a` over the eight format files): exit 0, 29 tests, 29 pass. No diff under `src/domain/team` since the plan start.
- `grep -c "^test(" src/test/teamJoinRequest.test.ts` gives 11. `grep -cE "from 'vscode'|require\('vscode'\)" src/team/joinRequest.ts` gives 0.
- Full `npm test` (MemoryMax=6G, choom, nothing else running, about 7 GB free): 2010 tests, 1998 pass, 1 fail, 11 skipped (the existing skips). The one failure is `turnEfficiency.test.ts`, "web fetches requested in one turn run at the same time..." ("two rounds of 150 ms, not four (457 ms)"). It is a wall-clock timing check, it passed 3 times out of 3 alone, and this plan does not touch it. It is logged in deferred-items.md.

## Decisions Made

See key-decisions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Unknown fields in a request are refused**
- **Found during:** Task 1
- **Issue:** The invite bundle ignores unknown keys. A signed request must not: an extra field would travel unsigned next to signed ones.
- **Fix:** parseJoinRequest allows only v, team, ref, member, name, email, key and sig, and also requires the canonical JSON spelling.
- **Committed in:** 3a936ea (tested in 67aee2f)

**2. [Rule 2 - Security] The request object is re-checked at accept**
- **Found during:** Task 1
- **Issue:** acceptJoinRequest takes a parsed `JoinRequest` object. A caller could change a field after parsing.
- **Fix:** It re-encodes the object and parses it again, so the signature is checked against what is actually accepted.
- **Committed in:** 3a936ea (tested in 67aee2f)

**3. [Rule 2 - Correctness] A computer that already holds a team key cannot make a request**
- **Found during:** Task 1
- **Fix:** createJoinRequest refuses with "This computer already has a key for this team, so it cannot ask to join it again." joinTeam would refuse that computer later anyway.
- **Committed in:** 3a936ea

**4. [Rule 1 - Bug] catchUpCopy with an undefined team id matched a missing team.json**
- **Found during:** Task 2 RED
- **Fix:** One `isWantedTeam` check is used at the tip, on the default branch and on disk. Undefined never matches.
- **Committed in:** 4aaf469

**5. [Rule 3 - Blocking] `failureOf` in invite.ts narrowed to its failure type** so the internal `Issued` result type compiles. There is no behaviour change.
- **Committed in:** 3a936ea

---

**Total deviations:** 5 auto-fixed (2 security, 1 correctness, 1 bug, 1 blocking)
**Impact on plan:** All are inside the plan's files and add no new surface.

## Issues Encountered

- A Python edit turned the `  ` escapes in a regex into literal line separators, which broke compilation. They were restored before the GREEN commit.

## Known Limitations

- After accept, the lead's `invites.json` holds the email the lead typed. This is the same as an invite (planned). `accepted-requests.json` holds no email.
- When the answer of an earlier completion was lost, the next completion sees this device already on the team and forgets the stored request. It returns `none`, not `joined`.

## User Setup Required

None.

## Next Phase Readiness

61-29 can build the commands on top of this:
- Ask to Join a Team: catchUpCopy without a team id, then createJoinRequest and readPendingRequest.
- Accept a request in Members: parseJoinRequest, then show name, email and requestCheckCode, then acceptJoinRequest.
- Automatic join: completeJoinRequest on each sync.
- Automatic confirm: wasAcceptedHere.

## Self-Check: PASSED

- FOUND: src/team/joinRequest.ts, src/test/teamJoinRequest.test.ts
- FOUND commits: ab16bf8, 3a936ea, 67aee2f, 4aaf469, ae9710c (all ancestors of HEAD)

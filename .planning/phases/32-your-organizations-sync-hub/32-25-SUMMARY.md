---
phase: 32-your-organizations-sync-hub
plan: 25
subsystem: hub and staff replica (joining through the hub, connecting a project)
status: complete
tags: [sync-hub, join-request, invitation, hkdf, hub-mac, enrolment, sse, rate-limit, MUS-07]
requires: [32-15, 32-18, 32-19, 32-20, 32-21, 32-22, 32-23, 32-24]
provides:
  - "hub/src/join.ts: JoinDesk (register, join, list, sweep, start, stop), JOIN_REFUSALS, JoinRefusal, JOIN_CHECKS, JoinChecks, JoinLog, JOIN_REQUEST_KEEP_MS, JOIN_SWEEP_INTERVAL_MS"
  - "hub/src/http/routes.ts: POST /v1/projects/:p/invites, POST /v1/join, GET /v1/projects/:p/join-requests; RouteDeps.join"
  - "hub/src/main.ts: composeHub builds and starts the JoinDesk (HubParts.joinChecks, HubParts.onJoinLog, ComposedHub.join); stop clears its timer"
  - "src/staff/replica/hubTransport.ts: registerInvite, postJoin, joinRequests, enrolmentRequest, EnrolSource, InviteRegistration, JoinPost, PendingJoinRequest, EnrolRequestBody"
  - "src/staff/replica/hubMembership.ts: inviteThroughHub, sendJoinRequestThroughHub, fetchJoinRequests, connectProjectToHub, HubEndpoint, OpenHub, HubCalls, openHubTransport, HUB_NOT_TOLD_TEXT, HubJoinRequest; new HUB_MEMBERSHIP_REFUSALS"
affects: [32-26 (malicious hub harness), 32-28 (operator docs: new log events), Phase 33 (commands and UI for joining through the hub and connecting a project)]
tech-stack:
  added: []
  patterns:
    - "per-address bucket and byte cap before any signature check; invitation standing before readHubJoin; the MAC last, failures counted in the store"
    - "one JoinDesk per composed hub, its 7 day removal on the injected scheduler (at start and hourly)"
    - "lead flows take an OpenHub factory so tests give transports a short connect limit or another address"
    - "the enrolment is gathered through a structural EnrolSource, so ReplicaProject (syncLocalOf) and the hub tests' memory replica share one builder"
key-files:
  created:
    - hub/src/join.ts
    - hub/test/join.test.ts
  modified:
    - hub/src/http/routes.ts
    - hub/src/main.ts
    - hub/test/helpers/hubHarness.ts
    - src/staff/replica/hubTransport.ts
    - src/staff/replica/hubMembership.ts
    - src/test/staffReplicaHubMembership.test.ts
decisions:
  - "A hub join post is answered 202 {project, invite, held}; refusals are {error, message} with no reason field and nothing from the request: malformed 400, unknown-invite 404, rate-limited 429 (Retry-After), too-large 413, every other refusal 403. Registration answers 201 stored or 200 held; another check key for a held invitation is 409 invite-exists and the first is kept."
  - "Order of the join checks: address bucket, 64 KiB cap (routes.ts), shape, invitation lookup by the envelope's unverified project and invite id (unknown project or invitation is unknown-invite), roster standing voided, then used (roster or store), locked, expired by the hub clock, then readHubJoin (both signatures, the envelope signed by the request's device, request hash and invite), this hub's writer id (wrong-hub), the request's genesis against the project's (wrong-project), and last checkHubJoinMac. Only a failed MAC is counted toward the lock."
  - "An accepted request is stored, then acceptJoinRequest marks it accepted at once, so the 7 days run from the hub's acceptance; a request held from before keeps its first acceptance and sends no second event. The list also filters by the 7 days, so a request is never shown between its expiry and the next hourly sweep."
  - "The join-request event goes to roster.isRosterWriter at send time (lead and deputy devices), read from the roster cache after the store's commit."
  - "Registration expiry must be after now and at most 366 days away (the invitation range of membership.ts); an expiry already past is refused invite-expired."
  - "The request's own signature is checked inside readHubJoin (32-15 made it check both); join.ts does not verify it a second time."
  - "inviteThroughHub returns the plain Phase 31 file (no hub field) when the hub could not be told, so the person never tries a hub that does not know the invitation; the result says registered false with HUB_NOT_TOLD_TEXT. When told, the file is rebuilt from the same payload and the kept secret with the hub field (one file, the same capability)."
  - "The hub's address comes from the caller (HubEndpoint): the roster keeps the hub's pin and writer id but not its address. Phase 33 supplies it."
  - "sendJoinRequestThroughHub first runs the whole Phase 31 check of the person's own request with the invitation's secret, so a request from another invitation or another device is refused before anything is sent."
  - "connectProjectToHub maps the hub's enrolment-used, enrolment-expired, enrolment-unknown and bad-mac to enrol-refused (new hub file), project-exists to success (the hub already holds the project, the resume of a lost answer), unreachable and rate-limited to enrol-unreachable (the hub stays admitted), anything else to enrol-not-taken."
  - "enrolmentRequest lives in hubTransport.ts, not hubMembership.ts, so the hub workspace can run it against the real hub without the fold or Yjs (hubMembership.ts reaches Yjs through membership.ts)."
metrics:
  duration: "about 80 minutes"
  completed: 2026-11-20
estimate:
  tokens: 85000
  tasks: 3
actuals:
  tokens: 28598
  tasks: 3
  commits: 3
plan_head_before: 55b3886cae26e90b852d2b58dc1c5719e5bde1d1
plan_head_after: e9fcc5a6dbdf70613be5e1a20ecac2e7dc37e7b9
---

# Phase 32 Plan 25: Join requests through the hub, and connecting a project Summary

A person can now send their join request through your organization's hub, which checks it with a key derived from the join secret without ever holding the secret, locks an invitation after 5 wrong tries, tells the lead's and deputy's computers at once and forgets the request after 7 days; the lead's computer still checks the Phase 31 MAC and the six words before anyone is admitted, and connects a project to the hub (admission and enrolment) in one call that a second call finishes when the hub was offline.

## What was built

- **Hub join desk (`hub/src/join.ts`).** `register` (lead or deputy devices at the hub's roster head; exact keys `invite`, `expiresAt`, `checkKey`; 32-byte check key; first check key kept), `join` (the checks in the order above; failures counted in the store; locked at 5; accepted requests stored and announced), `list` (lead or deputy devices, last 7 days), `sweep` (accepted requests older than 7 days, never an invitation), `start`/`stop` (sweep at start and hourly on the injected scheduler). Log lines `invite.registered`, `invite.refused`, `invite.locked`, `join.refused`, `join.accepted`, `join.removed`, `join.sweep_failed` carry the project id, the invite id and a reason word (or a count) only.
- **Routes.** `POST /v1/projects/:p/invites` and `GET /v1/projects/:p/join-requests` behind the session check; `POST /v1/join` with no session, taking the per-address join bucket before the body is read and reading at most 64 KiB.
- **Composition.** `composeHub` builds the desk with optional `joinChecks` and `onJoinLog`, starts its sweep on the scheduler and returns it; the binary logs through the logger and stops the timer on SIGTERM.
- **Client transport.** `registerInvite` and `joinRequests` over the session; `postJoin` on a connection of its own with no session (like `enrol`); `enrolmentRequest(source, file, roster)` gathers the base-stream entries of every writer, the blobs they cite, every grant and the `enrolmentMac`. The check key, hub MAC and envelope come only from invite.ts (no `hkdfSync` in hubTransport.ts).
- **Client flows.** `inviteThroughHub`, `sendJoinRequestThroughHub`, `fetchJoinRequests`, `connectProjectToHub` (see Decisions). Sixteen new refusals in `HUB_MEMBERSHIP_REFUSALS`, one plain sentence each; every join refusal ends with "Send your join request file to the staff lead any way you like."

## State coverage (D-58)

| Invitation on the hub | Test |
| --- | --- |
| registered (lead, deputy), refused for a member, wrong length, extra field | registration tests |
| registered again: held with the same key, 409 and first kept with another | registration: the same invitation again |
| expired at registration; expired by the hub clock | both expired tests |
| used (roster member.admit), voided (roster invite.void) | used, voided |
| wrong MAC counted; guessed check key counted; locked after 5, sixth refused | tracer, both locked tests |
| accepted, announced to lead and deputy, not to members; listed by lead and deputy only | tracer, who may read |
| accepted again: held, not a failure, no second event | the same accepted request posted twice |
| removed 7 days after acceptance, at the hourly sweep and at start; invitation kept | both 7 days tests |
| unknown invitation; unknown project; wrong hub; wrong project; bad envelope or request signature; other device's envelope; over 64 KiB; 429 | their own tests |

| Client flow | Outcomes tested |
| --- | --- |
| inviteThroughHub | registered with the hub field and check key only; unreachable (works by file, says so); no hub admitted |
| sendJoinRequestThroughHub | no-hub-in-invitation; reached the hub with the six words; unknown, expired, used, voided, locked, wrong-secret, rate-limited; unreachable; request from another invitation |
| fetchJoinRequests | listed, then review and admit as Phase 31 (and a forged MAC refused by the lead); member device refused; unreachable |
| connectProjectToHub | admit and enrol in one call; unreachable then resumed with no second hub.admit; enrolment used and expired refused; project already held; the real hub accepts the client's enrolment and refuses a second project with the same hub file; an expired hub file refused by the real hub |

## Tests

| Suite | Result |
| --- | --- |
| hub unit suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set, under the cap) | 333 tests, 333 pass, 0 fail, 0 skipped (308 before this plan) |
| join.test.js | 25 tests (names include locked, expired, used, voided, 429, 7 days, enrol) |
| staffReplicaHubMembership + staffReplicaMembership + staffHubTransport | 137 tests, 137 pass |
| staffReplicaHubMembership.test.js | 48 tests (33 before; names include no-hub-in-invitation, enrol, unreachable) |
| replicaBoundaries + replicaInvite + replicaHubFile | 59 pass |
| `npm run lint` and `cd hub && npm run lint` | both exit 0 |

Acceptance greps: `checkHubJoinMac` in hub/src/join.ts 4 (at least 1); `hkdfSync` in hubTransport.ts outside comments 0.

### Failing-first evidence

- **Task 1 (tracer):** the four tracer tests on the unchanged code: 4 tests, 4 fail (`transport.registerInvite is not a function`). With the desk, the routes and the client calls: 4 of 4 pass; the hub suite 312 of 312 and both lints clean before Task 2 was written (tracer gate).
- **Task 2:** join.ts was written whole in Task 1, so the 19 Task 2 tests passed on first run except one with a test bug (the signed payload's signature field is `sig`). Their teeth are shown by 20 stated mutations of hub/src/join.ts and routes.ts, each applied alone, the file restored byte for byte, 23 of 23 passing after: J1 no voided check, J2 no used check, J3 no locked check, J4 no expiry check, J5 no join bucket (the 429 test), J6 join body cap raised to 4 MiB (the 413 test), J7 failures not counted (3 tests), J8 any device registers, J9 any device lists, J10 join-request to every device (tracer), J11 no sweep at start, J12 kept 8 days (both 7 days tests), J13 no invite-exists check, J14 no wrong-hub check, J15 no genesis check, J16 never accepted (4 tests), J17 a duplicate announced again, J18 no MAC check (3 tests), J19 check key length not checked, J20 readHubJoin before the standing check (the unknown-project spy test). Each fails its named test. J17 first survived: the duplicate test waited for a second frame that could not be told apart; it now posts a marker for a second invitation and checks the frame order, and J17 fails it.
- **Task 3:** the new extension tests typechecked against the committed hubMembership.ts failed with 10 errors (TS2305 for `HUB_NOT_TOLD_TEXT`, `connectProjectToHub`, `fetchJoinRequests`, `inviteThroughHub`, `sendJoinRequestThroughHub`; TS7053 for the new refusal keys). With the flows, two tests failed for test reasons and were corrected: a case-sensitive pattern for "Your organization's hub", and `roster.positions[0]` being the origin rather than an entry. Then 11 stated mutations of the compiled client code, each restored: C1 never registers (4 tests), C2 registers the secret as the check key (3), C3 the hub-field file returned when not told, C4 no no-hub-in-invitation check, C5 the own request not checked, C6 hub refusals not mapped, C7 lead flows skip the writer check, C8 no resume after admission (3), C9 enrolment refusals not named, C10 no grants in the enrolment (2), C11 no blobs in the enrolment. Each fails its named test; 48 of 48 pass after.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] hub/src/main.ts and hub/test/helpers/hubHarness.ts (not in files_modified)**
- **Issue:** the desk must be built where the routes are composed, its hourly removal needs the composed scheduler and must stop on SIGTERM, and the 429 test needs to count the signature checks (as `readAnswer` does for sessions).
- **Fix:** `HubParts.joinChecks` and `onJoinLog`, `ComposedHub.join`, `joinDesk.stop()` in the binary's stop; the harness passes `joinChecks`, exposes `join` and `joinLogs`, and stops the desk on close. Additive; every other option's default is unchanged.
- **Commit:** 2dc2e467

**2. [Plan detail] hub/src/live/events.ts unchanged**
- `join-request` was already one of the event names (32-21), and `publish` with an audience read at send time is what the desk uses. No change was needed.

**3. [Rule 2 - Correctness] Additions beyond the plan's list, each tested**
- A registration with any field besides the three, the secret included, is refused 400. An expiry already past is refused invite-expired. A request whose genesis is another project's is refused wrong-project. A guessed check key counts toward the lock. A request from another invitation is refused on the person's own computer before anything is sent. `project-exists` on enrolment is success. The removal also filters the list, so an expired request is never shown before the next sweep.

**4. [Plan detail] Where connectProjectToHub meets the real hub**
- hubMembership.ts cannot be bundled into the hub's tests (it reaches Yjs through membership.ts, and the workspace test refuses that closure). The enrolment builder therefore lives in hubTransport.ts as `enrolmentRequest` over a structural `EnrolSource`; `connectProjectToHub` uses it with `syncLocalOf(project)`, and join.test.ts runs the same builder with the hub tests' memory replica against the real hub.

Files outside the plan's `files_modified`: hub/src/main.ts, hub/test/helpers/hubHarness.ts (above).

## Decisions

The owner accepted the 32-CONTEXT defaults; the plan had no checkpoint. The tracer gate re-ran the hub suite and both lints before Task 2. Decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- **Phase 33:** the commands need the hub's address for inviteThroughHub and fetchJoinRequests (`HubEndpoint`); the roster has only the pin and writer id. A `join-request` event on the live stream is the cue to call fetchJoinRequests; each text then goes through reviewJoinRequest and admitJoinRequest unchanged. An invitation made while the hub was offline has no hub field and works by file; there is no call to register it later.
- **32-26:** `HubParts.joinChecks` and the harness's `joinLogs` let the malicious-hub harness count or observe join checks.
- **32-28 (operator docs):** log events `invite.registered`, `invite.refused`, `invite.locked`, `join.refused`, `join.accepted`, `join.removed`, `join.sweep_failed` with project id, invite id and a reason word only.
- **Known limit:** a request stored but not marked accepted (a crash between the two store calls) stays until it is posted again, which marks it; the store's removal takes accepted requests only. Every route path marks it at once.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: T-32-101 (check key per invitation, lock after 5, expiry and roster standing; their tests), T-32-102 (bucket before any check with a spy, 64 KiB cap with a 413 test), T-32-103 (state directory byte search for the secret in four forms), T-32-104 (the hub admits nobody; the lead's review refuses a forged Phase 31 MAC), T-32-105 (event and list for lead and deputy devices only). No package was installed (T-32-SC).

## Self-Check: PASSED

- FOUND: hub/src/join.ts, hub/test/join.test.ts, hub/src/http/routes.ts, hub/src/main.ts, hub/test/helpers/hubHarness.ts, src/staff/replica/hubTransport.ts, src/staff/replica/hubMembership.ts, src/test/staffReplicaHubMembership.test.ts
- FOUND commits: 2dc2e467, 310a9f64, e9fcc5a6 (ancestors of HEAD on feat/phase-32-25-join-through-hub)

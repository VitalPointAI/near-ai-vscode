---
phase: 32-your-organizations-sync-hub
plan: 21
subsystem: hub
status: complete
tags: [hub, server-sent-events, presence, backpressure, checkpoints, live-push]
requires: [32-19, 32-20]
provides:
  - "hub/src/live/events.ts: EventHub (open, publish, end, closeAll, size, unsentBytes, peakUnsentBytes, stats, channel), LiveChannel (on/emit 'entries' and 'checkpoint'), Scheduler, realScheduler, EVENT_NAMES, EVENT_TIMING, EVENT_BUDGET_BYTES"
  - "hub/src/live/presence.ts: PresenceHub (heartbeat, leave, size, close), PRESENCE_TIMING"
  - "hub/src/http/routes.ts: GET /v1/projects/:p/events, POST /v1/projects/:p/presence, POST /v1/projects/:p/checkpoint, CHECKPOINTS_PER_ASK; RouteDeps.events and RouteDeps.presence; heads, roster and equivocation publishing after COMMIT"
  - "hub/src/main.ts: HubParts.scheduler; ComposedHub.events and ComposedHub.presence; stop ends open streams and clears presence"
  - "hub/test/helpers/sseReader.ts: EventClient, EventStream, callOn, ManualScheduler, HubEndpoint"
affects: [32-22, 32-23, 32-25, 32-27, 32-28]
tech-stack:
  added: []
  patterns: ["audience decided per device at send time from the roster cache", "unsent budget = Node's buffer for the response plus the hub's own queue, resync past it", "requests written straight on the session's socket so a stream and later calls share one TLS connection", "hand-moved scheduler for keep-alive, coalescing and expiry"]
key-files:
  created:
    - hub/src/live/events.ts
    - hub/src/live/presence.ts
    - hub/test/events.test.ts
    - hub/test/presence.test.ts
    - hub/test/helpers/sseReader.ts
  modified:
    - hub/src/http/routes.ts
    - hub/src/main.ts
    - hub/test/helpers/hubHarness.ts
decisions:
  - "Stream refusals: an unknown, expired or other-connection token and a revoked or quarantined device get 204 with no body; a request with no token at all stays 401 JSON (a client bug, not a state to stop on); a token for another project stays 403 JSON. 429 is {error: 'too-many-streams'} with Retry-After 30."
  - "The pushing device is left out of the heads events for its own batch (it knows its own heads). Roster goes to every admitted device, the lead included."
  - "After an append's COMMIT the hub ends the streams of devices the batch left revoked or quarantined before it publishes anything, so a revoked device hears nothing of its own revocation and an equivocating device nothing of its own equivocation."
  - "A stream also ends at the first keep-alive tick after its session token expires, or after its device is no longer admitted at the cached roster head, so a 15 minute token means the same on a stream as on a call. The client reopens a session on the same connection (the stream ended with res.end, the connection stays)."
  - "The 1 MiB budget counts Node's own buffer for the response (writableLength) plus the hub's queue. Past it the frame is dropped (its id is not used), resync goes at the end of the queue, and the stream ends once that drains; a reader that has not drained it 30 seconds later is cut off (res.destroy)."
  - "Presence frames are deltas: the devices whose value changed since the last frame (latest value each) and the devices that left, sent to the cell's access list at flush time, each recipient without its own entry; a recipient with nothing left after that gets no frame. A heartbeat is checked in this order: 2 KiB cap, shape, the writer token bucket, then the access list. Answer 200 {project, cell}."
  - "Checkpoint ask: body {known?: [signed]} (at most 16, else 413). Every one must verify with verifyCheckpoint against the roster view, name this hub's writer id as signer and the path's project; one that does not refuses the whole request 400 {error: 'checkpoint-refused'} and nothing is kept. Answer {project, kept, checkpoint?}. The checkpoint channel hears one ask per accepted request, with or without checkpoints handed back."
  - "A handed-back checkpoint is stored with a signing time placed by coverage (the sum of its stream counts): just below the earliest held checkpoint that covers at least as much, else after all of them. So a stale one is kept as evidence but never becomes the latest that heads, append and entries attach (D-46 would read that as a rollback). The stored body is the canonical JSON of the signed envelope; its hash is checkpointHash."
  - "main.ts stop now ends open streams and clears presence before closing the server (the plan gave closeAll's wiring to 32-22). Without it a SIGTERM with a stream open waited the 5 second grace and exited 1."
metrics:
  duration: "about 70 min"
  completed: 2026-11-20
estimate:
  tokens: 70000
  tasks: 3
actuals:
  tokens: 26900
  tasks: 3
  commits: 3
plan_head_before: a16c38900e1ef3e32f3f440649bb905643c9c044
plan_head_after: 9422bc8dc29dd98f5f92fca7f37eddd1b1ad54f2
---

# Phase 32 Plan 21: Server-sent events and presence Summary

A device holding a session now keeps one server-sent event stream per project open on its session's connection and hears at once when heads move in a stream it may read, when the roster changes, when a device equivocates and who is active in a cell it may read; a stuck reader can cost the hub at most 1 MiB plus one frame, and a client can hand back hub checkpoints a restore lost.

## What was built

- **Event streams (D-37).** `GET /v1/projects/:p/events` behind the session check. The stream opens with `text/event-stream`, `cache-control: no-store`, and a `retry:` line of 2000 ms plus a jitter below 2000 ms. Frames are `event`, `id` (a counter per connection from 1) and compact JSON `data`; `Last-Event-ID` is never read. A comment line every 15 s through an injectable scheduler. One stream per device per project (a second one ends the first), at most 4 per device across projects and 32 per address, 429 with `Retry-After` past that.
- **Ends (D-35, D-43, D-58).** 204 with no body for an unknown, expired or other-connection token and a revoked or quarantined device. An open stream ends when the client closes it, when an append's roster change revokes or quarantines its device, when its device equivocates, when its token expires (next keep-alive tick), when its budget runs out (after resync), and at shutdown (`closeAll`, now called by the binary's stop).
- **Audiences (D-37, D-38).** After COMMIT: `heads {project, stream, heads: [{writer, seq, hash}]}` per stream the batch added to, to that stream's access list (pusher left out); `roster {project, head}` to every admitted device; `equivocation {project, stream, writer, seq, proof: {a, b, publicKey}}` to the stream's access list plus the lead's and deputy's devices. Every audience is read from the roster cache at send time.
- **Budget (T-32-80, Pitfall 3).** Unsent bytes are Node's buffer for the response plus the hub's queue. While `write()` returns false frames wait in the queue for `'drain'`; past 1 MiB, resync and the end.
- **Channel.** `events.channel.on('entries' | 'checkpoint', fn)` for 32-22: entries accepted (any append that stored entries), checkpoint asked (every accepted checkpoint request).
- **Checkpoint ask (D-46, D-54, D-70).** `POST /v1/projects/:p/checkpoint` (see Decisions).
- **Presence (D-38).** `POST /v1/projects/:p/presence` `{cell, sealed}` or `{cell, leave: true}`; memory-only map, 30 s time to live (sweep every second while anyone is present), one frame per cell at most every 250 ms with `{project, cell, devices: [{writer, sealed}], left: [...]}`.

## Tests

| Suite | Result |
| --- | --- |
| hub unit suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set, under the cap) | 287 tests, 287 pass, 0 fail, 0 skipped (254 before this plan) |
| events.test.js | 25 tests (names include replaced, 204, resync, 429, keep-alive) |
| presence.test.js | 8 tests (one runs the hub binary and searches its state directory and logs) |
| hub `npm run lint` (tsc) | clean |

Acceptance greps: `text/event-stream` in events.ts 1; `'drain'` in events.ts 2; `writeFile|prepare\(` in presence.ts (comments filtered) 0. events.test.js has 25 tests, the tracer file state after Task 1 had 2.

### Failing-first evidence

- **Task 1 (tracer):** the two tracer tests and sseReader.ts on the unchanged phase-branch code: 2 tests, 2 fail (`404 !== 200` for GET events; `timed out waiting for frame 2; frames [], ended true`). After the implementation 2 of 2 pass; the hub suite 256 of 256. Tracer gate: `<verify>` re-run end to end before expanding.
- **Task 2:** the 23 new tests run on the Task 1 code (with only the new timing constants exported so the file builds): 25 tests, 5 pass, **20 fail**. The 3 new tests that passed (ids per connection, ended by the client, label-cell audience) cover behaviour the tracer already had; their teeth are shown by mutations E1, E2 and E3 below.
- **Task 3:** the 8 presence tests on the Task 2 code (with only `PRESENCE_TIMING` exported): 8 tests, **8 fail** (`404 !== 200`, `404 !== 403`, `404 !== 413`, two timeouts waiting for a frame).
- **Teeth (D-66, stated mutations, each applied alone with the test file, then restored and compared byte for byte):**
  - E1 ids continue from Last-Event-ID: the open test fails. E2 a closed stream stays registered: ended by the client, open and the stuck-reader test fail. E3 heads ignore the access list: the label-cell audience test fails. E4 no budget: both resync tests fail. E5 standing not enforced after an append: ended on revoke, ended on equivocation and the equivocation audience test fail. E6 refusals as 401 JSON: all five 204 tests and both ended-then-204 tests fail. E7 no replacement: replaced and the device 429 test fail. E8 no per-device limit and E9 no per-address limit: the matching 429 test fails. E10 no token expiry at the tick, E11 equivocation without the lead and deputy, E12 no stuck cut-off, E13 checkpoint project not compared, E14 handed-back checkpoints always latest, E15 no roster event, E16 no checkpoint signal, E17 no entries signal, E18 no keep-alive comment: each fails its named test.
  - P1 no coalescing window: the first, the ten-heartbeat and the binary tests fail. P2 presence audience ignores the access list, P3 the poster gets its own entry: the first test fails. P4 no access check on the post: the 403 test fails. P5 no expiry: the 30 second test fails. P6 no bucket: the 429 test fails. P7 a leave not announced: the leave and binary tests fail. P8 first value kept instead of the latest: the ten-heartbeat and binary tests fail. P9 body cap raised to 64 KiB: the 413 test fails. P10 the sealed value passed to the binary's failure log hook: the state directory and log search fails.
- Corrected on first run for test reasons: on loopback the kernel's socket buffers took the whole 2 MiB while the reader was paused, so a flood with pauses between frames never reached the budget. The 2 MiB resync test now publishes in one turn of the event loop (as a burst of appends would), which reaches the budget; the stuck-reader test fills the kernel first (publishing with pauses until the budget runs out, at most 256 MiB) so the queue stays with the hub. A paused reader also cannot see the server's close until it reads again, so that test resumes the reader after the cut-off. The presence marker note had to come from a device without the listening stream, because the pushing device hears nothing of its own append.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] hub/src/main.ts and hub/test/helpers/hubHarness.ts (not in files_modified)**
- **Issue:** the registry and presence must be built where the routes are composed, and the tests must inject a scheduler and see the registry.
- **Fix:** `HubParts.scheduler`, `ComposedHub.events` and `.presence`; the harness passes `scheduler`, exposes `events` and `presence`, and closes both. **Commits:** 87a63f4e, 37392121, 9422bc8d

**2. [Rule 2 - Correctness] Shutdown with a stream open**
- **Issue:** `server.close` waits for open connections, so a SIGTERM with a stream open waited the 5 second grace and exited 1.
- **Fix:** stop calls `events.closeAll()` and `presence.close()` first (the plan gave this wiring to 32-22). The presence binary test stops the hub with SIGTERM and expects exit 0. **Commits:** 87a63f4e, 9422bc8d

**3. [Rule 2 - Correctness] Stale checkpoints handed back**
- **Issue:** storing a handed-back checkpoint with the time it arrived would make an older one the latest that every answer attaches, which clients read as a rollback (D-46).
- **Fix:** signing time placed by coverage (see Decisions), with a test. **Commit:** 37392121

**4. [Rule 2 - Correctness] Token expiry and standing on an open stream; the stuck reader**
- Additions beyond the plan's list, each tested: a stream ends at the keep-alive tick after its token expires; a reader that never drains after its budget ran out is cut off 30 seconds later; 401 JSON for no token at all and 405 for POST on the events path.

**5. [Plan detail] 2 MiB on loopback**
- See the test corrections above: the 2 MiB test publishes in one event loop turn; the stuck-reader test publishes until the budget runs out.

Files outside the plan's `files_modified`: hub/src/main.ts, hub/test/helpers/hubHarness.ts.

## Decisions

The owner accepted the 32-CONTEXT defaults; the plan had no checkpoint. The decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- **32-22 (checkpoint signing):** listen with `composed.events.channel.on('entries', ...)` and `on('checkpoint', ...)`; publish `checkpoint` events with `events.publish(project, audience, 'checkpoint', data)`; `closeAll` is already wired in stop. Handed-back checkpoints are stored with a coverage-placed `signedAt`; a newly signed checkpoint covering more should use `max(now, latest.signedAt + 1)` so it stays the latest.
- **32-23 (client):** a stream occupies its session's connection; appends and catch-up need a second connection with its own session. Requests on the stream connection after the stream ends work (the hub ends with `res.end`, keep-alive). 204 means stop and open a new session; resync means run heads catch-up and reconnect; ids are for gap detection only. Presence frames are deltas; a heartbeat every 5 s keeps a device listed.
- **32-25 (join requests):** publish `join-request` with an audience of `roster.isRosterWriter(writer)` read at send time.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: the new surface is the three routes T-32-80 to T-32-84 cover, each mitigated as planned (budget, drain, resync and the per-device and per-address caps; audiences from the access list at send time with tests that a device off the cell receives nothing; the token's connection binding with a 204 test; memory-only presence with a state directory and log search; checkpoints verified against the hub's own writer id and the path's project).

## Self-Check: PASSED

- All 5 created files and the 3 modified files are present; commits 87a63f4e, 37392121 and 9422bc8d are on feat/phase-32-21-events-presence.

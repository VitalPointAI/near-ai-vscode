---
phase: 32-your-organizations-sync-hub
plan: 20
subsystem: hub
status: complete
tags: [hub, sessions, tls-binding, http-api, enrolment, blobs, hub-file, kill-drill]
requires: [32-14, 32-15, 32-17, 32-18, 32-19]
provides:
  - "hub/src/http/session.ts: SessionRegistry (challenge, answer, authenticate, authDeadline, revokeDevice, size, close), SESSION_REFUSALS, AUTH_REFUSALS, CHALLENGE_TTL_MS, TOKEN_TTL_MS, AUTH_DEADLINE_MS, TOKENS_PER_DEVICE, MAX_TOKENS"
  - "hub/src/http/routes.ts: createRoutes(deps) for session, enrol, heads, append, entries and blobs; ROUTE_ERRORS; hooks onAccepted, onEquivocation, onFailure"
  - "hub/src/main.ts: composeHub(parts), sweepBlobsOnce, hubFileDays, BLOB_SWEEP_INTERVAL_MS, the --hub-file <days> command"
  - "hub/src/store/hubStore.ts: blobStreams(project, hash); openHubStore(dir, { recoverBlobs })"
  - "hub/src/log/logger.ts: stdoutLine"
  - "hub/test/helpers/hubHarness.ts: startHub, withHub, enrolProject, openSession, connect, advance, answerChecks, sweep"
  - "hub/test/helpers/hubClient.ts: HubConnection (one pinned keep-alive TLS 1.3 connection per session, keying(), call/get/post/put, closesWithin)"
affects: [32-21, 32-22, 32-23, 32-25, 32-27, 32-28]
tech-stack:
  added: []
  patterns: ["session token bound to the TLS exporter of the connection it was issued on", "one composition function shared by the binary and the in-process test hub", "identical 404 for denied and missing reads", "byte cap and declared-length check before any parse"]
key-files:
  created:
    - hub/src/http/session.ts
    - hub/src/http/routes.ts
    - hub/test/session.test.ts
    - hub/test/api.test.ts
    - hub/test/helpers/hubHarness.ts
    - hub/test/helpers/hubClient.ts
  modified:
    - hub/src/main.ts
    - hub/src/store/hubStore.ts
    - hub/src/log/logger.ts
    - hub/test/tlsServer.test.ts
decisions:
  - "Session refusals are 403 {error: 'session-refused', reason, message}; a body that is neither {project} nor {answer}, or an answer readSessionAnswer finds malformed, is 400 {error: 'malformed'}. A device whose standing is revoked or not-admitted opening a session gets not-admitted."
  - "Token refusals are 401 {error: 'unauthenticated', reason, message} and 403 {error: 'forbidden', reason: 'wrong-project', message}. Check order: no-token, unknown-token, token-expired, other-connection, wrong-project, then standing at the head (revoked or quarantined). A revoked device's tokens are all dropped on the first refused call."
  - "Every answer consumes the socket's open challenge, whatever its outcome (single use). A socket with no open challenge refuses any answer wrong-challenge."
  - "Each POST /v1/session call takes one token of the per-address session bucket, so opening a session costs two (60 sessions a minute per address at the default 120)."
  - "The enrol route takes the per-address enrol bucket itself before reading the body, and calls enrolProject without limits. Enrol refusals keep 32-19's ids as the error: rate-limited 429, malformed 400, project-exists 409, every other refusal 403. Success is 201 {project, rosterHead, hub} with hub the hub id (hub- and 16 hex), while the session challenge names the hub's writer id, which is what the answer signs."
  - "entries: head is the last entry of the page; for an empty page it is the writer's head at the hub, or null when the hub holds nothing from that writer. A client that asked from beyond the hub's head can see the hub holds less than it does."
  - "Blob GET serves a grant by hash when the device is a grantee of the grant's cell at the head, and a blob when the device uploaded it or an entry in a stream it may read references it. Every other case, another project's token included, is the same 404 body with no x-near-ai-project header."
  - "Append answers 400 malformed-batch for a body that is not {entries, grants?, blobRefs?}; batch-level refusals map to 400, 404, 413 (batch-too-large), 429 with Retry-After and 409 (blob-missing). A non-empty grants.refused is returned as grantsRefused, an extra field beside the planned shape."
  - "--hub-file prints the file with printKeyFile (logger.ts stays the only stdout writer) and runs with a logger that drops info lines, so stdout holds exactly the hub file or one hub.start_refused line. It opens the store with recoverBlobs false, because a running hub may share the state directory and the open-time sweep could remove a blob file the hub has written but not yet given its row."
  - "A clean start logs no store line; store.recovered (warn) only when the open removed orphan or temporary blob files, and store.damaged (error) when rows name missing files, so the exact event lists the startup and state directory tests pin stay unchanged."
metrics:
  duration: "about 55 min"
  completed: 2026-11-20
estimate:
  tokens: 90047
  tasks: 3
actuals:
  tokens: 28900
  tasks: 3
  commits: 3
plan_head_before: b222750ddbac6bfd9e8b14f3cfece575bfbdf1ff
plan_head_after: 108a296f50168773c7753e7a1c60793656881b8f
---

# Phase 32 Plan 20: Sessions bound to TLS and the hub's HTTP API Summary

Devices now reach the hub only through a session that works on the one TLS 1.3 connection it was opened on (challenge, answer signed over that connection's exported keying material, token bound to it and re-checked against the roster head on every call), and through it can enrol a project, see heads, catch up per writer, append through 32-19's checks and move blobs; the hub binary wires it all, issues hub files with `--hub-file`, sweeps abandoned uploads hourly and loses no acknowledged append to a SIGKILL.

## What was built

- **Sessions (D-35, D-39).** `SessionRegistry` keeps one open challenge per socket in a WeakMap (32 random bytes, 60 s, single use), checks answers with `readSessionAnswer` against the hub's writer id, the challenge's project and `exportKeyingMaterial(32, 'near-ai-hub-session/v1')` of the socket the answer arrived on, then asks the roster: admitted, not quarantined, a person's device. Tokens are 32 random bytes, filed under their sha256 with the project, writer, keying material and expiry (15 min), at most 8 per device and 10,000 in all, oldest dropped. `authDeadline` closes a connection that has not opened a session within 10 s of the handshake (injectable for tests); `/healthz` and the session and enrol calls work inside it.
- **Routes (D-34, D-36, D-41, D-44, D-69).** A literal table of method and path with parameters checked against their patterns before any lookup; 404 for unknown paths, 405 with `allow` for wrong methods. Bodies are read with a byte cap (64 KiB session, 4 MiB append and enrol, 8 MiB blobs) and a declared length past the cap is refused 413 before any byte is read. Every JSON answer is no-store, every error is `{error, message}` (plus `reason` for session and token refusals) and none echoes the path, token, challenge or body.
  - `POST /v1/session` `{project}` then `{answer}`; per-address bucket first.
  - `POST /v1/enrol` through 32-19's `enrolProject`; per-address bucket before the body.
  - `GET /v1/projects/:p/heads`: the streams and grant hashes of the cells the device is a grantee of at the head, the roster head and the latest checkpoint when one exists.
  - `POST /v1/projects/:p/append` through `appendBatch`; answered only after COMMIT; hooks `onAccepted` and `onEquivocation` after COMMIT for 32-21.
  - `GET /v1/projects/:p/entries?stream&writer&from`: at most 1,000 entries or 4 MiB, `more`, and the head reached; 404 for a stream the device may not read, same as unknown.
  - `PUT /v1/blobs/:hash` (hash check, 8 MiB cap, 256 MiB pending quota per uploader, 201 stored or 200 held) and `GET /v1/blobs/:hash` (blob or grant bytes with `x-near-ai-project`, identical 404 otherwise).
- **Binary (D-26, D-41, D-44).** `composeHub` builds the roster cache, rate limits, sessions and routes on the TLS server and sets the health store probe (`ok` unless the store reports damage). `main` opens the store after the state directory, secrets, keys and TLS pair, builds the identity with `hubIdentityOf` (certificate pin from the certificate's key), runs `sweepBlobsOnce` hourly on an unref'd timer, and on SIGTERM closes sessions, then the server, then the store. `--hub-file [days]` (default 7) prints one signed hub file and nothing else; without `HUB_PUBLIC_ADDRESS` or with days outside 1 to 30 it exits 1 with `hub.start_refused`.

## Tests

| Suite | Result |
| --- | --- |
| hub unit suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set) | 254 tests, 254 pass, 0 fail, 0 skipped (209 before this plan) |
| session.test.js | 27 tests |
| api.test.js | 18 tests |
| hub `npm run lint` (tsc) | clean |
| hub container suite (`npm run test:container`, under the shared heavy lock) | 11 tests, 11 pass: the image runs the store on its volume and stays healthy through Compose up and a hard kill |

Acceptance greps: `exportKeyingMaterial` in session.ts 1; `'--hub-file'` in main.ts 1.

### Failing-first evidence

- **All three tasks, on unchanged code:** the tracer test, the session tests and the API tests with their two helpers were copied onto a checkout of the phase branch head (b222750d) and built: the build failed with `No matching export in "src/main.ts" for import "composeHub"` and `"sweepBlobsOnce"` (no session module, no routes, no composition existed), so no test could run.
- **Teeth (D-66, stated mutations, each applied alone with the session and API tests, then restored; the files were compared byte for byte afterwards):**
  - M1 token keying not compared: other-connection fails.
  - M2 challenge not consumed: the reused-answer wrong-challenge test fails.
  - M3 standing not re-checked in authenticate: the revoked and quarantined token tests fail.
  - M4 deadline never closes: the two deadline tests that wait for a close fail.
  - M5 no session bucket: the 429 test fails.
  - M6 heads not filtered by stream: the heads test fails.
  - M7 blob GET without the access check: the identical-404 blob test fails.
  - M8 entries without the access check: the identical-404 entries test fails.
  - M9 no person-device check: not-a-person-device fails.
  - M10 no challenge expiry: challenge-expired fails.
  - M11 no token expiry: token-expired fails.
  - M12 grants not filtered: the heads test and the grant-by-hash test fail.
  - M13 no declared-length check: the 413-before-the-body test fails (it waits for a body that never comes).
- Three tests failed on their first run for test reasons and were corrected: the duplicate-in-one-batch case (32-19 lists an entry repeated inside one batch once, so the test now sends it again in a second append, where it is held), the bucket arithmetic of the 429 case (the blob-missing batch takes a token before it is refused, by design), and the signature field name (`sig`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Two small store additions (hub/src/store/hubStore.ts, a 32-18 file)**
- **Issue:** the blob route must know which streams reference a blob, and the store had no read of `blob_refs`; and `--hub-file` opening the store would run the open-time orphan sweep in a second process beside a running hub.
- **Fix:** `blobStreams(project, hash)` (one SELECT) and `openHubStore(dir, { recoverBlobs })` (default true, unchanged behaviour). **Commit:** 0fb62dc4

**2. [Rule 3 - Blocking] `stdoutLine` exported from hub/src/log/logger.ts**
- **Issue:** the workspace test allows stdout writes only in logger.ts, and `--hub-file` needs a logger that drops info lines.
- **Fix:** the default sink is now the exported `stdoutLine`; main.ts filters through it. **Commit:** 0fb62dc4

**3. [Rule 1 - Expected change] hub/test/tlsServer.test.ts health expectation**
- The 32-14 tracer asserted `store: 'not-configured'`, which the plan's own wiring changes: a started hub now reports `store: 'ok'`. The assertion was updated to the stronger value, not removed. **Commit:** 0fb62dc4

**4. [Plan detail] 2 MiB bodies in the 4 MiB page test**
- An entry holds at most 16 KiB inline (larger data goes to a blob), so 2 MiB entry bodies cannot exist. The test uses 250 entries with bodies near the inline limit; the page stops under 4 MiB with `more: true` and the head it reached.

**5. [Rule 2 - Correctness] Extra checks beyond the plan's list**
- Not covered by a test: the 256 MiB pending-upload quota per uploader (413 pending-quota). It is a two-line check over `unreferencedBytesOf`; a test would have to upload 256 MiB.
- The enrol bucket over HTTP (eleventh enrolment 429 before the body is read), the 8-tokens-per-device bound, malformed session bodies, a writer with no entries (`head: null`), held re-appends, and the restarted hub's health probe.

Files outside the plan's `files_modified`: hub/src/store/hubStore.ts, hub/src/log/logger.ts, hub/test/tlsServer.test.ts (above).

## Decisions

The owner accepted the 32-CONTEXT defaults; the plan had no checkpoint. The tracer test passed on its own before the session and API tests were added. Decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- **32-23 (client transport):** the wire shapes are in the frontmatter decisions and in routes.ts. The server's keep-alive timeout is 5 s (32-14's server.ts), so a connection idle for 5 s closes and its session ends with it; the client opens a new session on its next connection (two session calls). Sessions are per connection, so an event stream (32-21) on its own connection needs its own session.
- **32-21:** `createRoutes` takes `onAccepted(project, accepted, rosterChanged)` and `onEquivocation(project, proofs)`; extend the route table in routes.ts. `SessionRegistry.revokeDevice(writer)` drops a device's tokens.
- **32-22:** heads, append and entries already attach the store's latest checkpoint (parsed from its stored JSON) when there is one.
- **32-25:** add join to the table; take `limits.takeAddress('join', ...)` before reading the body, as enrol does.
- **32-28:** `--hub-file` in the container is `node /app/bin.mjs --hub-file 7` with the same secrets and `HUB_PUBLIC_ADDRESS`; it can run beside the hub on the same volume.

## Known Stubs

None. The hooks onAccepted and onEquivocation are no-ops in the binary until 32-21, as planned.

## Threat Flags

None beyond the plan's register: the new surface is exactly the routes T-32-75 to T-32-79 cover, each mitigated as planned (per-socket challenges and keying-bound tokens; access-list filters and identical 404s; byte caps, buckets before verification, the deadline and the token and challenge bounds; standing at every call; explicit more and head).

## Self-Check: PASSED

- All 6 created files and the 4 modified files are present; commits 0fb62dc4, ff303752 and 108a296f are on feat/phase-32-20-sessions-api.

---
phase: 32-your-organizations-sync-hub
plan: 27
subsystem: hub (evidence: ciphertext only, no outbound calls)
status: complete
tags: [hub, byte-capture, canary, ciphertext-only, compartments, no-outbound, D-24, D-55, D-62, MUS-08]
requires: [32-22, 32-23, 32-25]
provides:
  - "hub/test/ciphertextOnly.test.ts: the byte capture over the state folder (running and after close), the application layer (every request and response of every connection, event frames included) and every log line, with canaries in five encodings and positive controls (10 tests)"
  - "hub/test/noOutbound.test.ts: a recording hook preloaded into a child, its control, the built hub under the hook through a whole session, the --healthcheck case and the source scan (5 tests)"
affects: [32-28 (the SECURITY.md sentence "the hub reads only the roster and the cells your staff lead grants it" rests on these tests)]
tech-stack:
  added: []
  patterns:
    - "a tee on the hub server's request listener: req.emit('data') and res.write/end/writeHead wrapped, each exchange kept with its socket; a connection is attributed to the device whose session answer the hub accepted on it"
    - "the hub composed in process with the binary's log wiring (onFailure, onRejected, onCheckpointLog, onJoinLog) onto a Logger whose sink records every line"
    - "canary forms: UTF-8, UTF-16LE, hex in both cases, base64 and base64url at three offsets, and each base64 form encoded once more"
    - "a memory replica client that, like ReplicaProject, names the blobs its entries cite when it pushes and the blobs it misses when it pulls"
    - "an outbound hook loaded with NODE_OPTIONS=--import: every wrapped call logs one line (kind and target) and fails; address-literal lookups pass unlogged"
key-files:
  created:
    - hub/test/ciphertextOnly.test.ts
    - hub/test/noOutbound.test.ts
  modified: []
decisions:
  - "No leak was found: the capture is clean on the unchanged hub and client, so no hub or client source file changed. The teeth are shown by planted canaries in every channel and encoding and by stated mutations (below)."
  - "The canary search goes beyond the plan's five encodings: each base64 or base64url form is also encoded once more, because document text is UTF-8 inside base64url update bytes, so a body stored or sent unsealed holds it doubly encoded. The first mutation run showed the text canary was missed without it."
  - "The state folder is read twice: while the hub runs (the write-ahead log and shared memory file exist) and after a clean close (SQLite folds the log into the database). Both are searched."
  - "The members are declared with the world's demo clearance (no compartments). Declared clearances are roster data the hub reads by design (D-13), so the label canaries live only in the sealed cell labels and the products."
  - "The hook passes a lookup of an address literal through without logging it: Node answers it at once without a query, and net.Server.listen asks for one when the hub binds HUB_HOST=127.0.0.1 (probed on Node 26.13.1). Any other lookup is logged and fails."
  - "The hook loads through NODE_OPTIONS=--import=<hook url> so the shared launchHub and startHubProcess helpers run the built hub exactly as other tests do; the control children load it the same way."
  - "The health check exception in the source scan is the body of runHealthcheck in main.ts only (one request, host from healthcheckHost); any match elsewhere in main.ts fails."
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan had no checkpoint. The tracer gate re-ran the tracer's automated verify before Task 2."
metrics:
  duration: "about 75 minutes"
  completed: 2026-11-20
estimate:
  tokens: 60000
  tasks: 3
actuals:
  tokens: 19500
  tasks: 3
  commits: 3
plan_head_before: 8c1f2eb74a4158e4bc6ef54c064b21852be98762
plan_head_after: a2d4e8c7a65a528705b087dea94bb440f2d1037f
---

# Phase 32 Plan 27: Ciphertext only, and no outbound calls Summary

A byte capture over a real session shows the hub receives, keeps and sends the cells it was not granted only as ciphertext, in its state folder, on the wire and in its logs. The hub's own context opens the cell it was granted. A compartment member never receives the other compartment's data through the hub. The built hub, run under a hook that records every client network call, makes none through a whole session.

## What was built

**hub/test/ciphertextOnly.test.ts** (10 tests)

- **The hub in process, captured.** The hub is composed as `main.ts` composes the binary, with the same log hooks, onto a `Logger` with a recording sink. A tee replaces the server's request listener and records:
  - every request: method, URL, raw headers and each body chunk as the hub's reader receives it;
  - every response: status, headers and each chunk given to `write` and `end`, event stream frames included.

  Each exchange keeps its socket. A socket is attributed to the device whose session answer the hub accepted on it.
- **The search.** Each canary is searched as UTF-8, UTF-16LE, hex (both cases), and base64 and base64url at all three byte offsets. Each base64 form is also searched encoded once more. Every hit is reported with its place and encoding.
- **The tracer.** Cell U1 is not granted to the hub. Member A writes a product with name, title and text canaries and syncs. Member B pulls it. The canaries are in no state folder byte (while running and after close), no wire byte and no log line. The capture saw the sealed bodies arrive and leave. B opens both entries and the sealed label with U1's key.
- **The scene** (built once, used by 8 tests):
  1. The project is enrolled from the lead's computer.
  2. Two people join through the hub. The lead registers each invitation, each person posts a join request, and the lead lists both and checks them with the join secret.
  3. The lead admits them. It makes cell G (hub.grant plus a grant to the hub's key) and compartments U1 and U2, each with a sealed label holding a canary token.
  4. Each member starts with only its base cell grant and gets its own cell key from the hub.
  5. All three devices keep event streams open.
  6. In each of U1, U2 and G, a product is written:
     - product.create with name and title canaries;
     - a doc.update with a text canary;
     - a doc.update over 16 KiB that travels as a blob with a blob canary;
     - a version.verdict HOLD with a reason canary.
  7. Each member posts sealed presence on its cell.
  8. The lead pulls both compartments with their blobs. The checkpoint asks sign checkpoints.
  9. The hub's own context opens what it can of each cell in memory.
  10. The hub stops cleanly.
- **Tests:**
  - "positive control: the scene carried every canary": the lead opens every canary of U1, U2 and G, the labels included, and holds both blobs.
  - "no U1 or U2 product name, title or text canary ...".
  - "... label canary ..." (the sealed labels are seen arriving).
  - "... decision reason canary ...".
  - "blob: ...": each compartment's blob is put, fetched by the lead and rests in the blob folder, only sealed.
  - "positive control: the hub's own context opens the stored G entries and G's blob ...": all four G entries verify and the G canaries are found. No U1 or U2 entry opens. The checkpoints cover G and never U1 or U2.
  - "G's canaries appear in no log line and in no answer or event frame sent to the U1-only or U2-only member's connections".
  - "the U1-only member's connections receive no frame, page or blob of U2 ...". It checks cell ids, grant hashes, entry hashes, sealed bodies, blob hashes and raw blob bytes. Controls: each member's connections carried its own cell, and the lead's carried everything of both compartments.
  - "positive control: a canary planted in each of the five encodings ...": the plant is found in a state folder file per encoding (a doubly encoded one too), in a captured request (not echoed) and in a log line.

**hub/test/noOutbound.test.ts** (5 tests)

- **The hook.** The test writes it to a temporary folder and loads it with `NODE_OPTIONS=--import=<url>`. It wraps `net.Socket.prototype.connect`, `tls.connect`, `dns.lookup`, `dns.promises.lookup`, `dgram.createSocket` and `globalThis.fetch`, then calls `syncBuiltinESMExports` so named imports see the wrappers. Each call appends `kind target` to `NEAR_AI_TEST_OUTBOUND_LOG` and fails.
- **control:** one fetch to 127.0.0.1 leaves exactly one line. One call of every wrapped API leaves the expected eight lines: https.get as tls, a named `connect` import as net, and an address-literal lookup passed through. Without the hook, nothing is logged.
- **The serving hub:** the hub file comes from `--hub-file` under the hook. Then the built hub runs under the hook. The test drives, in order: enrolment, an event stream, a session with append and catch-up (syncOnce both ways), a blob put on 409 and its get, presence, a checkpoint ask, invitation registration, a join post and the join list. Then SIGTERM. The hub exits 0 and logged `checkpoint.signed`, `join.accepted` and `hub.stopped`. Both outbound logs are empty.
- **healthcheck:** under the hook, the only lines are `tls 127.0.0.1:<port>`. Without the hook, the check passes (exit 0). `healthcheckHost` maps `0.0.0.0` and `::` to loopback.
- **source:** comment lines are filtered out. No file under `hub/src` names fetch, an http or https request or get, a net or tls connect or createConnection, a named client import, dgram, `node:dns`, http2, a browser client or undici. The one exception is the single request inside `runHealthcheck`, whose host is `healthcheckHost(config.host)`. A second source test shows the scanner's teeth on thirteen offending lines, their comment forms and server-only lines.

## Verification (every run under the memory cap and the shared focused lock)

| Run | Result |
| --- | --- |
| ciphertextOnly.test.js after Task 1 (tracer gate) | 2 tests, 2 pass |
| ciphertextOnly.test.js after Task 2 | 10 tests, 10 pass |
| noOutbound.test.js | 5 tests, 5 pass |
| hub unit suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set) | **348 tests, 348 pass, 0 fail, 0 skipped** (333 before this plan) |
| `cd hub && npm run lint` | exit 0 |

Acceptance: `grep -c utf16le hub/test/ciphertextOnly.test.ts` is 3. The test names contain "positive control", "label", "decision reason" and "blob" (ciphertextOnly), and "control", "healthcheck" and "source" (noOutbound). There are no em-dashes in either file.

### Failing first, planted controls and teeth (D-66)

These tests check behaviour that already exists. They passed on the unchanged hub the first time, so no leak was found. Their teeth are shown in two ways.

**Planted controls.** Each search ran first against a planted plain-text canary, and it reported the leak:
- one file per encoding in the state folder (utf8, utf16le, hex, base64 at offset 1, base64url at offset 2, doubly encoded): each found under its own encoding;
- a captured request body: found;
- a log line: found.

A canary never written is found nowhere in the same places.

**Stated mutations.** Each was applied alone to the built bundle, run, then restored and compared byte for byte. N4 changed a source file instead.

| Mutation | Result |
| --- | --- |
| MA: label-cell bodies sent unsealed by the client | the tracer and "product name, title or text", "decision reason" fail with hits in hub.db and hub.db-wal; the lead's positive control fails too |
| MA before the doubly encoded forms were added | the text canary was missed (name and title found): the reason the search was strengthened |
| MB: label-cell blobs sent unsealed | "blob" and "product text" fail with hits in the state folder |
| MC: cell labels sealed as plain base64url | the tracer and "label" fail |
| MD: the hub's checkpointer logs the data of each entry it opens | "G's canaries appear in no log line ..." fails |
| ME: heads answers ignore the access list | the cross-member test fails (U2's cell id reaches the U1 member) |
| MF: presence sent to everyone admitted | the cross-member test fails |
| N1: the built app fetches on every append | the serving hub test fails (`fetch https://telemetry.example.invalid/append`) |
| N2: the built app looks up a host name at start | the serving hub test fails (`dns updates.example.invalid`) |
| N3: the health check targets another host | the healthcheck test fails (`tls monitor.example.invalid:<port>`) |
| N4: hub/src/live/presence.ts gains a fetch line (restored) | the source test fails naming `live/presence.ts:12 fetch` |

The first N2 attempt broke the app's syntax and was redone. The healthcheck test was reordered so the hooked check runs before the plain control, which lets N3 fail on the target check rather than on the control.

## Deviations from Plan

1. **[Strengthening] Doubly encoded forms in the search.** See decisions. The planted controls include a doubly encoded file.
2. **[Plan detail] Address-literal lookups pass through the hook unlogged.** Without this the hub could not bind 127.0.0.1 under the hook. The control child shows a host-name lookup is caught and an address-literal one is not.
3. **[Plan detail] The hook is loaded with `NODE_OPTIONS=--import=<url>`** rather than an argv `--import`, so the shared hubProcess helpers run the child unchanged.
4. **[Plan detail] Presence values** are sealed under the cell key with `sealBlob`, as a client would seal them. HubTransport has no presence call yet, so the post goes through sseReader's `EventClient.call`.
5. **[Plan detail] Joining through the hub** follows join.test.ts. The lead admits with the world's `admitMember` after checking each listed request with the join secret, because `admitJoinRequest` lives in hubMembership.ts (Yjs, not bundled into hub tests).

No hub or client source file changed. Files touched outside the plan's list: none (plus this summary).

## Known limits

- The capture runs at the application layer of the hub's own server (after TLS). Bytes on the wire before TLS are ciphertext by construction and are not searched.
- The in-process hub's log lines come from the binary's wiring copied into the test. The noOutbound child runs the real binary, and its stdout is checked for events but not searched for canaries.
- Declared clearances are roster data (D-13). A member declared with a compartment token in its clearance would show that token to the hub by design.

## Known Stubs

None.

## Threat Flags

None beyond the register:
- T-32-110: the byte capture in five encodings (plus doubly encoded) with positive controls.
- T-32-111: the per-connection capture keyed by device.
- T-32-112: the runtime hook and the source scan.
- T-32-113: G canaries searched in log lines.
- T-32-SC: no package was installed (`npm ci --ignore-scripts` in hub/ only restored the pinned dev tooling, gitignored).

## Self-Check: PASSED

- FOUND: hub/test/ciphertextOnly.test.ts, hub/test/noOutbound.test.ts
- FOUND: 6f4c77e7, ce32375d, a2d4e8c7 (ancestors of HEAD on feat/phase-32-27-ciphertext-only)

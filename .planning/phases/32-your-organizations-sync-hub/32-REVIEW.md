---
phase: 32-your-organizations-sync-hub
reviewed: 2026-11-20T22:05:47Z
depth: deep
files_reviewed: 32
files_reviewed_list:
  - hub/src/http/server.ts
  - hub/src/http/session.ts
  - hub/src/http/routes.ts
  - hub/src/append/checks.ts
  - hub/src/append/rosterCache.ts
  - hub/src/enrol.ts
  - hub/src/join.ts
  - hub/src/limits.ts
  - hub/src/live/events.ts
  - hub/src/live/presence.ts
  - hub/src/checkpoints.ts
  - hub/src/store/hubStore.ts
  - hub/src/main.ts
  - hub/src/secrets.ts
  - hub/src/log/redact.ts
  - hub/src/log/logger.ts
  - hub/Dockerfile
  - .github/workflows/ci.yml
  - src/staff/replica/hubTransport.ts
  - src/staff/replica/hubSync.ts
  - src/domain/replica/hubWitness.ts
  - src/domain/replica/hubFile.ts
  - src/domain/replica/invite.ts
  - src/staff/replica/labelCells.ts
  - src/staff/replica/migrate.ts
  - src/staff/replica/singleCopy.ts
  - src/staff/replica/membership.ts
  - src/staff/replica/hubMembership.ts
  - src/staff/replica/store.ts
  - src/staff/replica/marks.ts
  - src/staff/staffHost.ts
  - src/staff/staffFiles.ts
findings:
  critical: 2
  warning: 9
  info: 7
  total: 18
  necessity: 0
status: issues_found
---

# Phase 32: Code Review Report

**Reviewed:** 2026-11-20T22:05:47Z
**Depth:** deep
**Files Reviewed:** 32 source files (plus the ledger and roster domain modules they call, read to confirm call chains)
**Status:** issues_found

## Summary

Scope: `git diff origin/main...HEAD` on branch `feat/phase-32-sync-hub`, limited to the hub service, the client transport and sync, the witness, label cells and migration, and the durability code named in the brief. No test suite was run; every finding below was traced by reading the code and the functions it calls.

Severity words used below: Critical maps to the `critical` count, Major to `warning`, Minor to `info`.

The hub's building blocks are careful (strict body caps, buckets before signatures, TLS 1.3 with exporter-bound tokens, canonical row checks in the store, redacting logger). The serious problems sit at the joins between parts:

1. The append checks drop honest entries that can never become acceptable later (a roster branch citing an older head, an entry of a device revoked after it wrote). Because each writer's log is a seq/prev chain, a dropped entry wedges that writer's log on the hub for good. For a racing lead and deputy this is an ordinary event, and it stops the lead's later roster entries (revocations included) from ever reaching the hub's enforcement.
2. Migration seals ledger lines into label cells byte for byte, and those lines name other products in `meta.dependsOn`. A product in a lower cell that depended on a product in a higher cell carries the higher product's name into the lower cell, which the leak test does not cover.
3. Several limits that are fine in a lab make the hub unusable for the deployments the design names: a 10 second whole-request timeout against 4 to 8 MiB bodies, a 5 second keep-alive that forces a new session per exchange against a per-address session bucket, and unbounded in-memory checkpoint history.

Known, already-documented limits were not reported again (honest-restore false fork and the unreceived-checkpoint gap from 32-26, clients not recomputing checkpoint order, hub address not in the roster, the 32-01 stuck state when the store folder is deleted with the mark remaining and nothing set aside).

Necessity was assessed with `necessity-review.md`; no necessity finding was made.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: The hub drops honest roster entries that cite an older roster head, which wedges that writer's whole base-stream log forever

**Severity:** critical
**File:** `hub/src/append/checks.ts:351-360` (refusal), `hub/src/append/checks.ts:333-342` (the seq and prev checks that then refuse everything after it)
**Issue:** For a roster kind in the base stream the hub refuses `roster-not-at-head` when `rosterPrev` (or the body's `roster`) is not the hub's current roster head, and `not-a-roster-writer` when the writer is not a lead or deputy device at the hub's head. A refused entry is not stored and the hub's head for that `(stream, writer)` does not move. Every later entry of that writer in the base stream then has `seq = n + 1` against a hub head of `n - 1` and is refused `seq-gap`, forever: the writer cannot rewrite seq `n` (that would be an equivocation and gets the device quarantined, D-43), and hubSync does not retry these reasons.

Failure scenario: the lead and the deputy each admit a person at about the same time. Both devices read roster head H and each writes a roster entry citing H. The deputy pushes first; the hub's head becomes the deputy's entry. The lead's entry cites H and is refused `roster-not-at-head`. From then on the hub refuses every base-stream entry the lead's device writes: later admissions, `device.revoke`, `hub.grant`, rekeys of the base cell. The roster fold on every client supports exactly this case (a pending split resolved by `roster.choose`, D-11), but the branch never reaches the hub, so the choice cannot be applied there and no other client ever receives the branch from the hub. A revocation the lead writes afterwards is never enforced by the hub's append checks or session checks, so a revoked device keeps reading and writing through the hub. The same wedge follows a lead handover race (`not-a-roster-writer` for a roster entry the old lead wrote offline) and a base cell rekey whose hub grant is late (`roster-unreadable`).

The file's own header says "A roster entry the fold refuses is still stored, because it is the writer's log; the roster head simply does not move", which is the right rule; the pre-checks above it break it.
**Fix:** Store every base-stream entry that passes the per-entry checks that do not depend on roster ordering (shape, size, signature by an admitted device on the access list, seq and prev), and let `foldRoster` decide whether it applies, splits or is refused. The fold already refuses roster kinds from non-roster writers and keeps branches as pending splits:

```ts
// checks.ts, in the base-stream branch
if (Object.prototype.hasOwnProperty.call(ROSTER_KIND_OWNER, kind)) {
  // Kept as the writer's log whatever the fold decides; only the fold moves the roster head.
  baseEntries.push({ header, body: raw.body as string });
  if (read.blob !== undefined) batchBlobs.set(read.blob.hash, read.blob);
  dirty = true;
}
```

Keep `roster-unreadable` as a per-batch "try again" (return the batch with a retryable status) rather than a dropped entry, and add a test with two roster writers racing on one head, asserting both entries are stored, the hub's roster shows a pending split, and a later `roster.choose` from the lead is accepted.

### CR-02: Migration leaks the names of higher-labelled products into lower label cells through `meta.dependsOn`

**Severity:** critical
**File:** `src/staff/replica/migrate.ts:575-578` (`cellFileOf`), `src/staff/replica/migrate.ts:615-620` (scoped import per cell)
**Issue:** Each label cell gets a `project.import` with scope `cell` holding every line of the legacy product ledger whose `payload.product` is one of the cell's products, byte for byte (the lines are signed envelopes, D-20). A product ledger entry carries `meta: { kind, label, profile, level, dependsOn: [{ product, version }] }` (`src/domain/staff/ledger.ts:41-47`, `validMeta`). When a product in a lower cell depends on a product in a higher cell, its lines name the higher product, and that name is sealed into the lower cell and delivered to every device cleared only for the lower label (and to the hub, if the lead grants the hub that cell).

Failure scenario: the existing migration test builds exactly this case (`src/test/staffReplicaMigration.test.ts:930-943`: an org/Public annex that depends on an org/Internal concept of operations). The reconstruct step correctly leaves the annex unversioned (`pin-above-cell`), but the import step has already sealed the annex's ledger lines, which contain `"dependsOn":[{"product":"<conops name>",...}]`, into the org/Public cell. A member cleared only for org/Public now holds the name of an org/Internal product, which D-23 and the D-24 canaries (product names) forbid. Single-machine copies made by that member carry the same lines (`singleCopy.ts` `importedDrafts`). The leak test (32-13) does not place a cross-label dependency, so it does not catch this.
**Fix:** Decide per line, before sealing, whether every product the line names (its own and each `meta.dependsOn[].product`) has a label the cell's label dominates. Lines that name a product above the cell cannot be edited (their signatures would break), so leave them out of the cell import and record the product as carried from the fold instead, or refuse the conversion with a sentence naming the dependency. For example:

```ts
function cellFileOf(bytes: Buffer, products: ReadonlySet<string>, visible: (product: string) => boolean): { file: Buffer; lines: number; withheld: number } {
  let withheld = 0;
  const kept = bytes.toString('utf8').split('\n').filter((line) => {
    if (line.trim() === '' || !products.has(productOfLine(line) ?? '')) return false;
    if (namedProducts(line).every(visible)) return true;
    withheld += 1;
    return false;
  });
  ...
}
```

Add a canary case to `staffReplicaLabelLeak.test.ts` with a lower product that depends on a higher one.

## Warnings

### WR-01: `proposeVersion` checks only scale and level of the version's label, so caveats, compartments and releasability are ignored

**Severity:** major
**File:** `src/staff/replica/labelCells.ts:369-371`
**Issue:** The label-change check compares `scaleLevel(headerLabel)` (the text before `//`) with the cell label's `scale/level`. Every compartment, releasability and handling caveat on the version's header is dropped from the comparison, although label cells are created per full label (`plainLabel` keeps compartments, releasability and handling, line 86). A version whose header says `org/Confidential//REL CAN` (or carries a compartment) is accepted into the plain `org/Confidential` cell and sealed under its key, so devices not cleared for that caveat receive the text. Migration passes matching labels today, so the hole is in the guard that Phase 33's product writes will rely on.
**Fix:** Compare the whole label, or require the cell's label to dominate the header's:

```ts
const header = labelFromText(headerLabel, gateOf(shared).scales);
if (cellLabel === undefined || header === undefined || !sameLabel(header, cellLabel)) return refuse('label-change');
```

### WR-02: After a hub restore, entries of a device revoked since are refused on re-push, so the hub never holds them and can stop signing checkpoints for good

**Severity:** major
**File:** `hub/src/append/checks.ts:306-310`, `hub/src/checkpoints.ts:251-256`, `src/staff/replica/hubSync.ts:418-428`
**Issue:** The standing check refuses any entry whose writer is not admitted at the hub's roster head, including entries that writer signed before it was revoked. After a restore from a backup older than those entries, clients re-push (D-54), but hubSync pushes the base stream first, so the `device.revoke` is re-applied before the revoked device's older entries arrive, and those entries are refused `revoked` permanently. Consequences: (a) any kept or handed-back checkpoint that names one of those entries as a head makes `missingHeads` non-zero, and `attempt` returns `waiting` on every try, so the hub never signs a checkpoint for that project again; (b) entries by others that cite them as deps are stored, so every client that pulls them waits on the missing deps and raises `withheld` after the grace period, forever.
**Fix:** Judge standing at the entry's place, not at the head: accept an entry of a revoked writer whose seq is below the place the revocation fixed (the roster records the revocation; for cells the hub can open, the body's `roster` citation gives the position), or at least accept entries that a checkpoint this hub signed names as covered. Add the case to the restore drill.

### WR-03: A 10 second whole-request timeout makes large uploads and enrolment impossible on slow links

**Severity:** major
**File:** `hub/src/http/server.ts:139-141`, `hub/src/http/session.ts:213-219`
**Issue:** `server.requestTimeout = 10000` bounds the time to receive the whole request, body included, for every route. A blob may be 8 MiB, an append and an enrolment 4 MiB. A link slower than about 6.7 Mbit/s can never upload a full blob, and one slower than about 3.4 Mbit/s can never send a full append or enrolment; the hub answers 408 or drops the socket, the client reports `unreachable` (offline), and the next exchange tries the same upload again. Enrolment and join run on a connection that never opens a session, so the 10 second authentication deadline also destroys that socket mid-upload. DESIGN 15.3 and the staff use case expect constrained links, so this is a normal deployment, not an edge case.
**Fix:** Keep the 10 second limit for headers and small bodies, and give body-carrying routes a limit derived from a minimum rate (for example 64 KiB/s with a floor), enforced in `readBody` with a per-request timer. Exempt a connection from the authentication deadline while a request on it is still being read.

### WR-04: One site behind one address runs out of sessions and event streams far below the design's figures

**Severity:** major
**File:** `hub/src/http/server.ts:141`, `hub/src/http/routes.ts:228`, `hub/src/limits.ts:34,41`, `hub/src/live/events.ts:189-191`, `src/staff/replica/hubTransport.ts:720-738`
**Issue:** D-39 sets the session bucket at 120 per minute per address because "a whole site may sit behind one address". But (a) both halves of a session (challenge and answer) take a token, so a site gets 60 sessions per minute; (b) the hub closes a connection idle for 5 seconds (`keepAliveTimeout = 5000`) and a token is bound to its connection, so the client needs a new session for nearly every exchange; (c) at most 32 event streams per address. A site of a few dozen devices behind one NAT exhausts the session bucket (every client is told to wait, outcome `offline`), and only 32 of its devices get live events, against DESIGN 10.9's 300 event streams.
**Fix:** Take the session bucket once per session (on the challenge only); keep authenticated connections open much longer (for example 120 seconds, with the token TTL still 15 minutes); make the per-address stream cap configurable and default it to the design figure, relying on the per-device cap for fairness.

### WR-05: The checkpoint signer keeps every checkpoint ever signed in memory and re-reads all of them on every ask

**Severity:** major
**File:** `hub/src/checkpoints.ts:169,284,405-426,429-441`, `hub/src/http/routes.ts:482-486`
**Issue:** `ProjectCheckpointer.chain` gains one item (signed checkpoint, parsed payload and frontier map) per signing and is never pruned; checkpoints are signed up to once a minute while entries arrive and every one is kept (D-45). Every ask sets `reloadWanted`, and hubSync asks at the end of every exchange, so `loadChain` runs `SELECT *` over all checkpoint rows (bodies included) of the project each time; `missingHeads` walks every head of every kept checkpoint on every attempt. In the route, each handed-back checkpoint re-reads and JSON-parses every stored checkpoint. Memory and per-ask work grow without bound over the life of a project, ending in an out-of-memory crash of the hub process.
**Fix:** Keep only the order state of the tip and the latest kept checkpoint per project in memory; read only rows newer than the last seen (`WHERE received_at > ?` or a rowid cursor); store each checkpoint's coverage in its own column so the route can place a handed-back checkpoint with one query.

### WR-06: `HubTransport.push` never uploads blobs, so the ReplicaTransport path loses them

**Severity:** major
**File:** `src/staff/replica/hubTransport.ts:482-492`
**Issue:** `push(entries, blobs)` calls `appendBatches(entries, [], [])` with no blob references and no `entryHashOf`, so no batch carries `blobRefs`. `append` uploads blobs only for declared references after a 409, so the `blobs` argument is never used. For entries in cells the hub cannot open, the entries are accepted and their blobs never reach the hub, so other devices wait on them forever. For a base-stream entry with a blob, the hub answers 409 `blob-missing`, nothing is put, the second try gets 409 again and `push` throws `hub-error`. Phase 32 does not call it, but this class implements `ReplicaTransport` and Phase 33's live replicator depends on it (D-61).
**Fix:** Pass the blob references through, for example by naming in `push` the blobs given (`blobRefs` built from each entry's cited blob) with `entryHashOf`, or make `push` throw until Phase 33 wires it, so the gap cannot ship silently.

### WR-07: One blob the pushing computer does not hold blocks the whole push and ends every exchange in attention

**Severity:** major
**File:** `hub/src/append/checks.ts:203-206`, `src/staff/replica/hubTransport.ts:570-578`, `src/staff/replica/hubSync.ts:436-440`
**Issue:** The hub refuses the entire batch with `blob-missing` if any declared reference names a blob it lacks. `blobsCitedBy` names the blobs of every entry this computer can open, including blobs it only waits for. When the hub lacks such a blob (after a restore, or before its author re-uploads) and this computer does not hold it either, `append` puts nothing, the retry gets 409 again, `answerJson` throws `hub-error`, and syncOnce ends `attention`. Every other entry of that batch and of every later batch is never pushed, and the checkpoint ask never runs, on every exchange, until the author's device returns.
**Fix:** Declare only references to blobs this computer holds (filter `refs` through `local.blob`), and have the hub answer `blob-missing` per entry (refused, retryable) rather than per batch.

### WR-08: The witness trusts a checkpoint signed by any hub in the roster, not only the hub it witnesses

**Severity:** major
**File:** `src/domain/replica/hubWitness.ts:185-194`, `src/staff/replica/hubSync.ts:200-216`
**Issue:** `witnessCheckpoint` checks that the checkpoint verifies for the roster (signer is some checkpoint signer, which is any admitted hub, `roster.ts:199-202`) and names this project, but never that `checkpoint.signer === state.hub`. With two hubs admitted, hub A can serve hub B's genuine checkpoints: the client keeps one as A's newest, later compares A's own checkpoints against it and records `rolled-back` or a `forked-view` proof whose two halves were signed by different hubs, and the "trusted" result is used as a join base attributed to the wrong hub. `heldHubCheckpoints` in hubSync does filter by signer, which shows the intent.
**Fix:**

```ts
if (checkpoint.signer !== state.hub) return { state: make(state), findings: [finding('injected', { reason: 'other-signer' })], trusted: false };
```

### WR-09: The checkpoint signer stops for good once the covered heads outgrow 64 KiB

**Severity:** major
**File:** `hub/src/checkpoints.ts:268-274`, `hub/src/checkpoints.ts:503-527`
**Issue:** When the full checkpoint passes `CHECKPOINT_MAX_BYTES`, `fit` drops granted streams, but `attempt` refuses any trimmed checkpoint that is not nested in the previous one (`!within(this.tip.frontier, cover.frontier)`), and the base stream is never dropped. Once a hub-granted cell (or the base stream alone) has more writer heads than fit in 64 KiB (about 250 heads with lamport and roster), every later attempt returns `too-large`, the hub never signs again for that project, and every client raises `delayed` indefinitely. Nothing tells the operator beyond one log line per attempt, and there is no way out.
**Fix:** Either size the checkpoint format for the design target (400 devices) or define an honest way to stop covering a granted stream (a signed field saying which streams are deliberately dropped, which clients accept as not a rollback). At minimum, surface the state through `/healthz` and document it with the D-63 limits.

## Info

### IN-01: Blob references may be attached to entries the hub already holds, by any device

**Severity:** minor
**File:** `hub/src/append/checks.ts:383-391`, `hub/src/http/routes.ts:586`
**Issue:** References for entries in `held` are accepted, so any admitted device can re-push any held entry with references to blobs it uploaded. That marks them referenced (bypassing the 256 MiB pending quota and the 24 hour sweep of D-44), and it adds the entry's stream to the blob's `blobStreams`, after which `GET /v1/blobs/:hash` serves that blob to every device on that stream's access list. Bytes stay ciphertext and the hash must be known, so the confidentiality impact is small, but the quota and sweep are not real limits.
**Fix:** Accept references only for entries stored by this batch, or for held entries only when the pushing device is the entry's writer.

### IN-02: Rebuilding the store during Start Again recovery is not crash-safe

**Severity:** minor
**File:** `src/staff/replica/store.ts:835-848`
**Issue:** In `rollForwardSteps`, when both the store and the temporary folder are gone, the store is rebuilt into the intent's temporary folder name. A crash during `buildFrom` leaves a partial temporary folder; the next open sees "store gone, temporary there" and moves the partial folder in as the store. If it lacks some of this device's own entries, the device's next entry reuses a seq, which the hub records as an equivocation and quarantines the device (D-43). This needs two faults (the folders removed, then a crash), hence minor.
**Fix:** Before moving a temporary folder in, check it against the counts the intent already records (`carried`, `grants`, `blobs`); on a mismatch rebuild it again from the source.

### IN-03: `HubTransport.subscribe` ends silently

**Severity:** minor
**File:** `src/staff/replica/hubTransport.ts:494-519`
**Issue:** When the event stream ends (resync, the hub closing it, a 204, a token expiry), the loop simply finishes; `gap` reports are dropped. The caller gets no signal to run heads catch-up, so a live subscriber stops receiving heads without knowing it, contrary to D-37 ("after any reconnect or resync the client runs heads-based catch-up").
**Fix:** Add an `onEnd(reason)` callback (or reconnect with the `retry:` delay and call `onHeads` with a full catch-up), and treat `gap` the same way.

### IN-04: Revoking a device in one project drops its sessions in every project

**Severity:** minor
**File:** `hub/src/http/session.ts:175-177`, `hub/src/http/session.ts:205-207`, `hub/src/http/session.ts:234-243`
**Issue:** Tokens are filed per writer id across projects. `authenticate` calls `revokeDevice(record.writer)` when the device is not admitted in the token's project, which drops that device's tokens for every other project it belongs to; the 8-token cap per device is also shared across projects.
**Fix:** Key the per-device cap and `revokeDevice` by `(project, writer)`.

### IN-05: Grants are pushed in the first pass only

**Severity:** minor
**File:** `src/staff/replica/hubSync.ts:453`
**Issue:** `appendBatches` puts every grant into the first batches. A grant for a cell whose `cell.create` lands in a later batch is refused `grant-not-placed`, and the later passes send no grants (`grants = []`), so that cell's entries are refused `not-on-access-list` for the rest of the exchange. The next exchange heals it, so this costs one exchange per new cell.
**Fix:** Keep the refused grants and resend them with the retried entries.

### IN-06: No bound on join requests per invitation

**Severity:** minor
**File:** `hub/src/join.ts:217-224`, `hub/src/store/hubStore.ts:1099-1120`
**Issue:** Anyone holding an invitation's secret can store any number of distinct join requests (each a new signed request from a new device key), each kept 7 days and each sending a `join-request` event to the lead and deputy; only the per-address bucket (10 per minute) limits it.
**Fix:** Cap pending requests per invitation (for example 8) and per project, refusing beyond it with a plain sentence.

### IN-07: An event stream's standing check passes when the roster cache is cold

**Severity:** minor
**File:** `hub/src/http/routes.ts:407`
**Issue:** `allowed` answers admitted when `cache.peek(project)` is undefined. The session check ran just before, so this only matters after a cache invalidation, but the fail-open default is the wrong way round for a security check.
**Fix:** Treat an absent roster as "check again": load it (`cache.get`) at the next keep-alive tick, or end the stream so the client reconnects through the session check.

---

_Reviewed: 2026-11-20T22:05:47Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_

## Resolution (2026-11-20)

Every critical and major finding is fixed with a regression test that failed on the code above. Fixes were made on four branches and merged into `feat/phase-32-sync-hub`.

| Finding | Outcome | Regression test |
|---|---|---|
| CR-01 | fixed: the hub judges a roster entry at the roster it cites, stores concurrent branches as the writer's log and lets the fold split; kept grants stay in the hub's key ring through a split | hub/test/append.test.ts "CR-01 roster race ...", "CR-01 no wedge", "CR-01 handover race" |
| CR-02 | fixed: a product whose signed ledger lines name a product above its cell is left out of that cell's import (listed in `MigrationResult.withheld`) and reaches members below only as live text | staffReplicaMigration "CR-02 ...", staffReplicaLabelLeak "dependsOn canary (CR-02) ..." |
| WR-01 | fixed: a version header must name its cell's full label (dominance both ways), so compartments and releasability are compared | staffReplicaLabelCells "label-change (WR-01) ..." |
| WR-02 | fixed for covered cells: a device revoked at the head may refill places one of this hub's kept checkpoints covers; for cells the hub cannot open the limit stays (no checkpoint names them) | hub/test/restoreDrill.test.ts "restore drill, revoked since (WR-02)", append.test.ts "WR-02 restore ..." |
| WR-03 | fixed: header 5 s, body 10 s then a minimum rate of 16 KiB/s; the authentication deadline covers getting a session, not an upload under way | tlsServer "a slow link ...", "slowloris ...", session "deadline: an enrolment still uploading ..." |
| WR-04 | fixed: two bucket calls per session (120 sessions a minute), 120 s keep-alive, 300 streams per address (DESIGN 10.9; D-37's 32 raised because D-39 expects a whole site behind one address) | limits "a site behind one address ...", session "keep-alive ...", events "40 devices each hold a stream" |
| WR-05 | fixed: the signer keeps only the latest checkpoint plus order state and reads kept checkpoints from a cursor | checkpoints "WR-05 bounded ..." |
| WR-06 | fixed: `HubTransport.push` names and uploads blobs from a `blobsCitedBy` source (Phase 33 must pass it) | staffHubTransport "WR-06 ..." |
| WR-07 | fixed on the client: entries whose blob neither side holds wait with their log (`heldBack`); the hub still refuses a whole batch on blob-missing, which honest clients no longer trigger | staffHubTransport "WR-07 ..." |
| WR-08 | fixed: the witness refuses a checkpoint not signed by the hub it watches (`injected`, `other-signer`) | replicaHubWitness "WR-08 ..." |
| WR-09 | fixed: trimming leaves out only streams no kept checkpoint covered, so trimmed checkpoints nest; `checkpoint.too_large` is logged when covered heads alone exceed the limit, documented in SECURITY.md (format unchanged per D-45) | checkpoints "WR-09 trimmed and still nested", "WR-09 stuck is reported" |
| IN-01 | fixed: blob references on an entry the hub already holds are kept only from its writer | append "IN-01 blob references ..." |
| IN-03 | fixed: `subscribe` reports the end of a stream through `onEnd` | staffHubTransport "IN-03 ..." |
| IN-04 | fixed: token caps and revocation drops are per project and device | session "revoked in one project ..." |
| IN-05 | fixed: grants the hub could not place yet are sent again with retries | staffHubTransport "IN-05 ..." |
| IN-07 | fixed: the stream standing check loads the stored roster when it is not in memory | events "keep-alive: a stream whose roster is not held in memory ..." |
| CR-01 follow-up (agent review, major: checks.ts refused a base-stream entry under an epoch the hub holds no key for, `roster-unreadable`) | fixed by one rule for the class: the hub refuses only a fault it can prove from what it holds (as verifyEntry rejects); an entry verifyEntry would hold for a missing epoch key is stored as the writer's log and the fold judges it once the key arrives. Chosen over a retryable batch refusal because the hub may never be granted an epoch (zero knowledge for parts it is not cleared for), and a retry would then wait forever while revocations stopped. Other paths checked: non-base cells are never opened (ciphertext stored), enrolment stores every entry, a missing blob refuses the batch for a retry, and a missing founding grant is `not-on-access-list`, which the client retries and resends the grant with. A body that does not open with a key the hub holds stays refused `roster-unreadable` | hub/test/append.test.ts "epoch key late ..." (3 tests), "founding grant late ...", "epoch key never granted (zero knowledge) ..." |
| IN-02, IN-06 | open (minor): Start Again rebuild crash safety during recovery; no bound on join requests per invitation | - |

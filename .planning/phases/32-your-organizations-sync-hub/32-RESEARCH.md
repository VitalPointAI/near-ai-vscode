# Phase 32: Your organization's sync hub - Research

**Researched:** 2026-11-20
**Domain:** a self-hosted relay for signed, per-writer, end-to-end sealed logs; TLS-bound device sessions; server-sent events; transparency-style checkpoints; label cells in the extension's replica layer
**Confidence:** high for the code findings (read on `origin/main` at 6af0718d), medium-high for prior art (pages read on 2026-11-20 unless marked "from knowledge")

## Summary

1. The closest models for the hub are three systems taken together: per-writer signed logs with fork evidence (Hypercore, Secure Scuttlebutt), hub-signed checkpoints held by clients as high-water marks and cross-checked by peers (Certificate Transparency, Go's checksum database, C2SP witnesses), and a relay that never reads content (Ink & Switch's Keyhive and Beelay). Yjs servers (y-websocket, Hocuspocus) and the Automerge Repo sync server give useful message shapes for catch-up, presence and debouncing, but all of them trust the server completely. Matrix is mostly a list of things not to copy.
2. The extension already has everything the hub needs to check appends without Yjs: the hub-side closure in `src/test/replicaBoundaries.test.ts` (entry, verify, chain, equivocation, order, checkpoint, roster, rosterMembers, rosterCells, cellKeys, invite, kindSchemas). The relay's `@ext/*` alias already lets a workspace bundle extension code. The hub copies none of it.
3. The design said "the hub always reads the roster stream". The roster stream is the base cell, and in Phase 31 the base cell also holds every product. So a hub that can check appends today could also read every product. Part B (label cells) fixes this by keeping only the roster in the base cell (CONTEXT D-15, D-16, D-40).
4. The Phase 31 legacy imports seal whole ledgers into the base cell. Once products live in label cells, a whole product ledger in the base cell would leak labelled product names, labels and decision reasons to every member and to the hub (D-20).
5. The hub cannot verify the Phase 31 join MAC, because the roster holds only the hash of the join secret. Giving the hub a derived check key per invitation keeps the secret away from the hub (D-48).
6. Checkpoint format version 2 needs no change. A client holding the newest checkpoint per hub detects rollback, and `checkpointConflict` already turns two conflicting checkpoints into a proof. Chained checkpoints (C2SP style) would add little while clients hold that mark (D-46).

## Prior art (draw on, avoid)

| Project | Licence, maturity | Draw on | Avoid |
|---|---|---|---|
| y-protocols, y-websocket-server ([github.com/yjs/y-protocols](https://github.com/yjs/y-protocols), [github.com/yjs/y-websocket-server](https://github.com/yjs/y-websocket-server)) | MIT; widely used; its README calls the server a dev server | Catch-up as "here is my state vector, send what I lack" (SyncStep1 and SyncStep2). Our per-writer `{writer: seq, hash}` map is that state vector. Awareness: one record per client with a clock, refreshed at least every 15 s, removed after 30 s, an explicit leave, never stored | The whole trust model (the server merges plaintext). Saving only when the last client leaves. Callbacks with no retry |
| Hocuspocus ([configuration](https://tiptap.dev/docs/hocuspocus/server/configuration), [Redis extension](https://tiptap.dev/docs/hocuspocus/server/extensions/redis)) | MIT; mature (Tiptap) | An authentication deadline from connect (`timeout`). `onAuthenticate` returning a context for later hooks. Debounce 2 s with a 10 s maximum wait for expensive work, which we use for checkpoint signing | Every instance processing every message for scale; we stay one instance and run a hub per site |
| Automerge sync protocol and Repo sync server ([sync docs](https://automerge.org/automerge/automerge/sync/index.html), [sync server](https://github.com/automerge/automerge-repo-sync-server)); Byzantine Eventual Consistency ([arXiv 2012.00472](https://arxiv.org/abs/2012.00472)) | MIT; the server is small and has no auth | The BEC analysis: hash-linked histories make injection and reordering detectable, and leave withholding as the only power a Byzantine relay keeps. That matches DESIGN 10.8 | Bloom filters and set reconciliation. Per-writer seqs make the difference one integer per writer |
| Keyhive and Beelay ([notebook](https://www.inkandswitch.com/keyhive/notebook/), [sync note 05](https://www.inkandswitch.com/keyhive/notebook/05/), [repo](https://github.com/inkandswitch/keyhive)) | Apache-2.0; pre-alpha, not audited | A relay that sees only ciphertext, with graph hashes deliberately left outside the envelope so it can route. Every request signed with an audience (the recipient) and freshness, so it cannot be forwarded elsewhere; on clock skew the server returns its time instead of failing hard. "Relay" as an explicit, minimal access level | Depending on the code; BeeKEM; RIBLT |
| Matrix (Synapse, Conduit) | Synapse AGPL-3.0, Conduit Apache-2.0 | A signed header that commits to a content hash, so a body can be dropped while the chain stays verifiable. Server keys with ids and validity. Explicit gaps (`limited`, `prev_batch`) rather than silent partial answers, which gives our `more: true` | Server-merged state resolution (state resets; the reason the roster is single-writer). Opaque server sync tokens clients cannot verify. Presence fanned out to everyone ([synapse#3971](https://github.com/matrix-org/synapse/issues/3971), [element-hq/synapse#16992](https://github.com/element-hq/synapse/pull/16992)) |
| Secure Scuttlebutt ([protocol guide](https://ssbc.github.io/scuttlebutt-protocol-guide/)), Hypercore ([README](https://github.com/holepunchto/hypercore), [hypercore-next#76](https://github.com/hypercore-protocol/hypercore-next/issues/76)) | MIT; mature | Per-writer `previous` hash and `sequence`, replication by a vector of feed to seq. Two signed entries at one position kept as a portable proof (Hypercore never did this cleanly; Phase 30 already does). SSB's lesson: restoring a device from backup and writing again forks its feed, which is our Start Again and quarantine story | A full Merkle tree per log |
| Certificate Transparency, C2SP witnesses ([tlog-witness](https://c2sp.org/tlog-witness), [tlog-checkpoint](https://c2sp.org/tlog-checkpoint), [transparency.dev](https://transparency.dev/articles/)) | Apache-2.0 family; deployed | A signed checkpoint that clients store and require to only grow; split views caught when clients compare checkpoints. A witness refuses an inconsistent checkpoint and keeps it as evidence. Gossip drafts were dropped in favour of witnesses; in our design the clients are the witnesses (they cite checkpoint hashes in deps and presence, DESIGN 10.8) | Chained checkpoints for now (deferred; see CONTEXT) |
| Server-sent events ([WHATWG spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)), Node streams ([backpressure guide](https://nodejs.org/learn/modules/backpressuring-in-streams)) | Standard | `id` and `Last-Event-ID`, `retry:`, a comment line about every 15 s for proxies, 204 to stop reconnects. In Node, `write()` returns false past the high-water mark but keeps buffering, so a stuck client grows memory unless we stop and wait for `drain` | Using `Last-Event-ID` for correctness. We use it only for gap detection and always run heads catch-up after a reconnect |
| Willow, Earthstar | Willow spec pages returned 404 on 2026-11-20; Earthstar LGPL-3.0 (from knowledge) | Capability-scoped sync, where only areas the requester proved access to are served (our access lists). Flow-control credits per channel (our SSE budget) | Not otherwise needed |

No code is copied from any of these. The hub has no runtime dependency (D-26), and every idea above is cited where a plan uses it.

## Code findings on `main` (6af0718d)

### Part A targets (PR #130 reviews)
- `src/staff/replica/store.ts` `startAgain` (around line 385). It builds the new store in `<dir>.new-<random>`, then calls `rename(dir, aside)` and then `rename(temporary, dir)`, then writes the mark. A crash between the two renames leaves no store folder, and the next open sees "no store". `startAgain` then calls `ReplicaStore.open`, which can create an empty store against a mark that refuses it, and a second Start Again carries nothing because the old folder is now `aside`. Same if the store folder is deleted by hand while the mark remains. No folder fsync after either rename.
- `src/staff/replica/marks.ts`: `MAX_MARK_LISTED = 100_000` (line 60) bounds held and waiting hashes, each with a reason. The lists file is written by temporary file, sync and rename (line 328 onward), but its folder is never synced.
- `src/staff/replica/singleCopy.ts` (around line 578): `writeStaged(target, files)` renames the staging folder into place, then `deps.secrets.store(ledgerHeadKey(target), …)` stores the head mark. A crash in between leaves a copy without a mark, which today's host reads as a ledger whose mark is missing.
- `src/services/staffMultiUserCommands.ts`: Remove builds items `{label: member.name, description: …}` (around line 497) and maps the pick back by label and description, so two members with one declared name collide. Join saves `result.file?.text ?? ''` (around line 300). saveSecretFile syncs the file but not its folder.
- `src/staff/replica/membership.ts`: `describeRosterBranches` (line 1316) builds a whole welcome file to show two branches; `updateMember` (line 1207).
- `src/staff/staffHost.ts`: `openShared` (line 394) caches the shared project across Start Again.
- `src/test/staffReplicaParity.test.ts` mutates `require.cache`; `src/test/teamSignedPayload.test.ts` line 512 tests random fields with no real token shape; `src/test/staffReplicaMembership.test.ts` line 454 ("no message, file name or result field contains a join secret, a key or the MAC") does not search the invitation text or the join request text.
- `31-CONTEXT.md` D-05 still says `node:worker_threads`; `src/staff/replica/decodeHost.ts` uses `fork()` (line 29).

### Part B targets
- `src/staff/replica/migrate.ts`: `BASE_CELL_LABEL = 'org/Public'` (line 127) and the `label-above-base` refusal (lines 135 and 296 to 299). Products are written into `stream = project.projectId` (line 525), the base cell. `project.import` seals each whole legacy file as a blob in the same cell.
- Cells already work in the pure core and the roster. `cell.create` founds epoch 1 of a new cell with a founding grant (`rosterCells.ts` line 113 onward); a cell's stream id is its cell id (`cellOfStream`, line 88); `labelSealed` keeps the label inside the grant, sealed under the epoch key (`cellKeys.ts`). Grants go to devices whose member's declared clearance dominates the cell label (`membership.ts` `clearedFor` line 238, `grantPlans` line 814). Admission and rekey already loop over every cell. No host flow creates a cell today, and nothing writes products anywhere but the base cell.
- The write-down rule for citing cells exists in membership (line 275 onward: "the citing cell's label dominates the cited one's"). The versions reducer does not yet refuse a pin across cells.
- The product ledger keeps hashes and metadata (names, labels, sections, roles, decisions), not product text (migrate.ts line 502, "Today's ledger keeps only the hash of each version").

### Part C targets
- `relay/`: `package.json` (engines `>=26.13.1 <27`, one runtime dependency `jose`), `tsconfig.json` with `paths: {"@ext/*": ["../src/*"]}`, `scripts/build.mjs` (esbuild, guard and app as two files, tests to `dist/test`), `scripts/check-node.mjs`, `src/` (bin, main, config, secrets, stateDir, log, health, http/server, store/schema, sqliteStore), `test/` (workspace boundary, secrets, logging, health, killDrill, noLeak, container). `Dockerfile` builds from the repository root with only `relay/` copied, and runs on distroless nodejs26 as 65532. `compose.yaml` holds the relay service and the `signal` profile. The CI job `relay` has a hotfix skip rule keyed on `relay/package.json`. `.dockerignore` is an allow-list; `verify-release-content.mjs` line 164 refuses `extension/relay`.
- The hub image must also copy the hub-side closure from `src/`, so the Dockerfile and `.dockerignore` name those folders (`src/domain/replica`, `src/domain/team`, plus anything the closure test lists, such as `src/domain/gate/dominance.ts` if reached).
- `src/domain/replica/transport.ts`: `ReplicaTransport` with `heads`, `pull`, `push` and `subscribe` (presence as opaque sealed bytes).
- `src/domain/replica/checkpoint.ts`: version 2, `CHECKPOINT_MAX_BYTES` 64 KiB (about 400 heads), purpose `staff-replica`, `verifyCheckpoint(signed, roster)` which needs a hub signer admitted in the roster (`hubSignerAt`), and `checkpointConflict`.
- `kindSchemas/roster.ts`: `hub.admit {hub, device, certPin, ceiling, rosterPrev}`, `hub.grant {hub, cell}`, `hub.revoke`. `project.genesis` may carry `hub {writer, certPin}`. `rosterMembers.ts` keeps hubs in one namespace with members.
- `invite.ts`: `InvitePayload` has no hub field. `joinMac(secret, fields)` is an HMAC keyed by the secret; the roster's `member.invite` has only `secretHash`.

## Architecture patterns

**Pattern 1: the hub as a checking relay.** The hub holds the base cell (roster) key only, folds the roster with the hub-side fold, and checks headers. Bodies of every other cell stay ciphertext. Access lists come from the grant records the roster fold places: writer ids are visible in grants, labels are sealed.

**Pattern 2: request binding.** Every authenticated call rides a token bound to TLS keying material. The session answer is signed over the hub id, the project, a challenge and the keying material, so it cannot be replayed to another hub, project or connection (Keyhive's audience rule).

**Pattern 3: catch-up by asserted heads.** The client says what it holds; the hub answers per writer in seq order with explicit `more`. SSE is only a wake-up and fast path.

**Pattern 4: the client as witness.** The client keeps the newest checkpoint per hub. It refuses lower heads, records conflicts as proofs, and flags withholding when a dep or checkpoint head names an entry it was never given. The findings are pure (`hubWitness.ts`) so the harness tests them directly as well as through the real hub.

**Pattern 5: resumable two-rename swaps.** Write an intent record, fsync, rename, fsync the folder, rename, fsync the folder, act, then remove the intent. On open, an intent present means finish or roll forward, never start empty. This is the pattern for Start Again and the single-machine copy.

## Pitfalls

1. **Re-sealing is a fork.** Sealing the same plaintext twice gives a new body hash and a second signed header at one seq (`entry.ts` line 10). Moving products (D-22) and re-running a conversion must look up existing entries first, as migrate.ts does for imports.
2. **The base cell's readers grow.** The hub becomes a reader of the base cell, so anything left there (Phase 31 product entries, whole legacy imports) is readable by the hub server. Connecting to a hub is refused until products have moved (D-22).
3. **SSE memory.** Unbounded `res.write` on a slow client. Use a byte budget and `resync`.
4. **The extension's Node version and `node:sqlite`.** Real-hub tests must run in the hub workspace on Node 26, not in the extension's test job (D-52).
5. **`exportKeyingMaterial` on both ends.** Node's `TLSSocket.exportKeyingMaterial(length, label)` works under TLS 1.3 on both client and server; the label must be identical. Test it against a real `https` server in the hub suite.
6. **SPKI pin, not certificate hash.** A certificate renewal with the same key must keep the pin (`X509Certificate.publicKey.export({type: 'spki', format: 'der'})`, sha256).
7. **Rate limits before signatures.** Verifying Ed25519 on flood traffic is the cost the limit must avoid, so the token bucket comes first.
8. **The mark lists under flood.** Without D-14 a hub (or a peer) could push 100,000 refused entries and freeze the mark.
9. **Clock skew in sessions.** The challenge is server-issued, so client clocks do not matter for sessions; entry `at` stays display-only (DESIGN 4.4).

## Validation Architecture

| Property | Test (plan) | Kind |
|---|---|---|
| Start Again finishes after a crash at each step and never builds an empty store | staffReplicaStartAgain (32-01) | crash-injecting child |
| A refused-entry flood cannot stop the mark advancing | staffReplicaMarks (32-07) | unit, property |
| A member without the clearance never receives the key or the plaintext | staffReplicaLabelLeak (32-13) | byte search with canaries |
| Conversion places each product in its label cell; legacy imports scoped | staffReplicaMigration (32-10) | fixtures |
| Hub refuses non-roster writers, wrong seq or prev, revoked or quarantined devices, roster entries not at head | hub append (32-19) | unit plus real store |
| Equivocation stored as a proof and the device refused | hub append (32-19) | unit |
| Session works only on its TLS connection | hub session (32-20) | real TLS |
| SSE heads and presence reach only the cell's access list; slow client gets resync | hub events, presence (32-21) | real server |
| Checkpoints verify with the roster and cover the heads | hub checkpoints (32-22) | real server |
| Join request accepted only with the hub check MAC; locked after 5 failures | hub join (32-25) | real server |
| Every malicious-hub fault detected and named, or harmless | maliciousHub (32-26) | fault proxy, seeded |
| Old backup restored: clients refuse, re-push, next checkpoint covers all | restoreDrill (32-26) | real server |
| Ciphertext only for ungranted cells; no outbound calls | ciphertextOnly, noOutbound (32-27) | byte capture |
| Image hardening, health, kill -9 | container, killDrill (32-17, 32-18) | container |

Sampling: each plan runs its own test files through `node scripts/run-tests.mjs` in the memory-cap wrapper (hub plans: `cd hub && npm test` under the same wrapper, which already uses `../scripts/run-tests.mjs`). Lint after each plan. Full extension suite, hub suite, e2e, `verify:release` and `smoke:staff` once at 32-28.

## Open questions (decided on the owner's behalf; see CONTEXT "For the owner to confirm")
1. The base cell carries only the roster (D-16, D-40).
2. Legacy imports are scoped by cell (D-20).
3. Projects reach a hub only by enrolment (D-41).
4. Phase 32 checkpoints carry no digests (D-45).
</content>
</invoke>

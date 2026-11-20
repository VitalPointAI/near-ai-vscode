---
phase: 30-replication-contract-and-co-editing-core
reviewed: 2026-11-19T18:30:00Z
depth: deep
files_reviewed: 36
files_reviewed_list:
  - src/domain/replica/attribution.ts
  - src/domain/replica/causal.ts
  - src/domain/replica/chain.ts
  - src/domain/replica/checkpoint.ts
  - src/domain/replica/decisions.ts
  - src/domain/replica/digest.ts
  - src/domain/replica/doc.ts
  - src/domain/replica/entry.ts
  - src/domain/replica/equivocation.ts
  - src/domain/replica/fold.ts
  - src/domain/replica/integrityFold.ts
  - src/domain/replica/kindSchemas/doc.ts
  - src/domain/replica/kindSchemas/integrity.ts
  - src/domain/replica/kindSchemas/obs.ts
  - src/domain/replica/kindSchemas/project.ts
  - src/domain/replica/kindSchemas/registers.ts
  - src/domain/replica/kindSchemas/roster.ts
  - src/domain/replica/kindSchemas/runs.ts
  - src/domain/replica/kindSchemas/shared.ts
  - src/domain/replica/kindSchemas/versions.ts
  - src/domain/replica/kindSchemas/watches.ts
  - src/domain/replica/kinds.ts
  - src/domain/replica/order.ts
  - src/domain/replica/projectFold.ts
  - src/domain/replica/reducers.ts
  - src/domain/replica/rosterView.ts
  - src/domain/replica/textFold.ts
  - src/domain/replica/transport.ts
  - src/domain/replica/verify.ts
  - src/domain/replica/versions.ts
  - src/domain/team/signedPayload.ts
  - scripts/vendor-libs.mjs
  - scripts/crdt-vendor.json
  - scripts/entries/yjs.mjs
  - scripts/verify-release-content.mjs
  - package.json
findings:
  critical: 3
  warning: 9
  info: 3
  total: 15
  necessity: 1
status: issues_found
---

# Phase 30: Code Review Report

**Reviewed:** 2026-11-19T18:30:00Z
**Depth:** deep
**Files Reviewed:** 36
**Status:** issues_found

## Summary

Reviewed the Phase 30 replica core (entry format, verification, chains and equivocation, causal order, checkpoints, the Yjs adapter and text reducer,
attribution, versions and decisions), the `staff-replica` signing purpose, and the Yjs vendoring scripts. Tests were read only to judge coverage.

The cryptographic layer is sound: header signatures bind the writer id to the key hash, the AAD binds the body to its place in a chain, hostile input is
consistently funnelled into reject/hold outcomes, no clock, locale or `Math.random` is read, and every sort key is a total order on hex strings.
The vendoring manifest and its three checks (compile, test, release) are coherent and fail closed.

The serious problems are in the fold layer, not the crypto layer. Three defects break the stated core invariant "same entries give the same state on
every machine", and one lets any admitted device forge authorship of text. Two of the three determinism defects, and the forgery, were reproduced
against the compiled output with scratch scripts (the scripts are in the session scratchpad, not in the repository; no source or test file was edited):

- a hostile `doc.compact` makes the incremental fold and a from-scratch fold of the same entries produce different digests (CR-02);
- a `doc.compact` held for a missing blob stays held forever in the incremental fold while a fresh fold applies it (CR-03);
- a future-dated entry is not released when the injected clock moves on, and `addEntries` silently keeps the old context (CR-03);
- a compaction written by device C puts text into the output document attributed to device A's writer id and member (CR-01).

Nothing in the review contradicts a documented, deliberate choice unless it is called out as unsafe below. Where a finding rests on a documented choice
(for example "gate agents on any device"), the finding says so and says why it is still unsafe.

## Critical Issues

### CR-01: A provisional `doc.compact` lets any admitted device write text that is attributed to another device and member

**File:** `src/domain/replica/textFold.ts:216-222, 227-233` (read by `finish` at `:249-262`)
**Issue:** The rule at the top of the file is "an update may only insert structs under a client id registered to the entry's own writer". The
provisional compaction branch does not apply it. It only requires that every struct's client id is registered by *some* device
(`known?.registrations.has(struct.client)`), then stores the blob and merges it into the output document in `outputDoc`. Because `attributeText` maps a
client id to the registering writer and member, the forged characters are shown as typed by that other device.

The branch is reachable by any admitted writer on demand, because it is chosen when `data.covers.every((cover) => view.graph.has(cover.hash))` is
false, and a writer controls `covers` (a valid-shaped hash of an entry the fold does not hold is enough). Reproduced: device C writes a `doc.compact`
whose blob holds `"FORGED under A"` under A's registered client id 11, with a cover hash that is not in the graph. Result of the fold:
`text = "FORGED under A"`, `compactions = [{ verified: false }]`, `attribution = [{ clientId: 11, writer: <A's writer id>, member: 'mbr-aaaa', actor: 'person' }]`.
The document lets the forger place text at any clock A has not used yet, and A's later real updates at the same clocks win silently ("the log wins"),
so the forgery can also vanish without trace. The existing test (`replicaDoc.test.ts` "a hostile compaction under a registered client is unverified")
asserts the text differs but not that the attribution stays truthful, so this is a known state that is not safe.

D-37 says a compaction is a verified cache that "stands in" for missing updates. It does not say the stand-in may speak for another person. The
`unverified` flag lives only in `compactions`; the spans, the per-version attribution summary (`versions.ts:392-393`) and the digest carry no marker.

**Fix:** Do not attribute provisional-only characters to a registered writer. Either (a) record, per product, the clock ranges that came from accepted
updates, and in `finish` give spans outside those ranges `writer: UNATTRIBUTED_WRITER` plus an `unverified: true` flag in `AuthorSpan`, so
`summariseAuthors` and `ProductVersions.attribution` show them apart; or (b) in the provisional branch refuse any struct whose client is registered to
a writer other than `entry.header.writer` and let an honest compactor mark such text only after the log can check it. Option (a) keeps the joiner use
case. Add a test that asserts the forged span has no writer.

```ts
// finish(): attribute only what the log holds; the rest is shown as unverified
const loggedClocks = clocksOf(product.accepted); // per client, from accepted updates
const spans = attributeText(attributionRuns(doc), product.registrations, loggedClocks); // unlogged runs -> UNATTRIBUTED_WRITER, unverified: true
```

### CR-02: The outcome of a compaction depends on whether its cover entries had arrived, so the incremental and the from-scratch fold diverge (attacker triggerable)

**File:** `src/domain/replica/textFold.ts:192-198, 200-211`; `src/domain/replica/fold.ts:416-419` (append path), `:254-275` (`viewOf`)
**Issue:** `applyCompaction` branches on `view.graph.has(cover.hash)`, and `view.graph`/`view.entry` describe *every* admitted entry, including entries
that sort after the compaction. A reducer decision therefore depends on entries the fold has not reached. In `addEntries`, when the new entry sorts
after everything applied (`extendsOrder`), only the new entry is applied and the compaction is not looked at again. So:

- Incremental: the compaction arrives before its cover entry Y. `graph.has(Y)` is false, so it is accepted provisionally.
- From scratch with Y present: `graph.has(Y)` is true, Y is not yet accepted when the compaction (earlier in the order) is applied, so the compaction is
  refused `compact-mismatch`.

Y can be any entry with a lamport above the compaction's. A compaction does not have to cite its covers as `deps`, so a hostile writer can choose Y to
be an entry that is published later. Reproduced with two folds of the same six entries: incremental gave `text = "FORGED under A"`,
`compactions = [{verified:false}]`, digest `1ddf5bad...`; fresh gave `text = ""`, `refused = ['compact-mismatch']`, digest `16f0972c...`. Two honest
machines now disagree on the state digest and will report each other as diverged, with no way for either to prove the other wrong.

**Fix:** Decide only from the compaction's own causal past, which is the same set in both folds. Refuse (or accept provisionally, but never branch on
later arrivals) when any cover is not in the compaction's past:

```ts
const past = view.graph.past(entry.hash);
if (!data.covers.every((cover) => past.has(cover.hash))) {
  // not citable from this entry's own past: provisional only, never "verified", and the same on every machine
  return provisionalLoad(...);
}
```

Apply the same rule to the `view.entry(cover.hash)` mismatch test at `:192-195` (it also sees later entries). Add a property test that folds hostile
compactions (covers that sort after, covers that never arrive, covers that arrive late) incrementally and from scratch and compares digests; the current
convergence test (`replicaConvergence.test.ts`) only generates honest compactions.

### CR-03: Holds that depend on the context (blob, key, clock) are never retried, so `addEntries` and `foldEntries` disagree on ordinary delivery

**File:** `src/domain/replica/fold.ts:163-172, 400-413`; consumers `src/domain/replica/textFold.ts:179-183`, `src/domain/replica/versions.ts:214-218, 250-251`,
`src/domain/replica/chain.ts:169-173, 214-234`
**Issue:** `fold.ts` promises (header, lines 4-5) that a held entry "becomes applied when the piece arrives". That is only true for verify-stage holds
(`retryHeld`). Three kinds of hold are evaluated against the context and then frozen:

1. Reducer holds `missing-blob` and `missing-key` (doc.compact stateBlob, version.propose textBlob) are recorded in `run.held` and nothing ever puts the
   entry back in front of the reducer. In the append path the entry's place in the order is already behind `state.prepared.ordered.length`.
2. Chain holds `future-dated` depend on `ctx.now`. `addEntries(state, [], laterCtx)` finds nothing changed (`if (!changed) return state`, line 410) and
   returns the old state, including the old `ctx`, so the new clock is ignored. The doc comment on `addEntries` ("ctx replaces the context ... held
   entries are looked at again") is not what the code does.
3. Anything else the context can gain between calls (a newly known roster, key) is not re-read for entries already applied.

Reproduced: a valid `doc.compact` whose blob is missing is held `missing-blob`; the blob then arrives; `addEntries(state, [], ctx)` still reports
`held: ['missing-blob']`, and with a later entry that sorts after it the compaction stays held, while `foldEntries` of the same entries applies it
(`compactions = [{verified:true}]`). A future-dated entry stays `future-dated` with `order.length = 0` after the clock is advanced 90 minutes, while a
fresh fold admits it. For `version.propose` the same path drops a whole version from the output, which changes the versions family and so the digest.

**Fix:** Treat the context as part of the fold's input. In `addEntries`, count a call as a change when `ctx` is not the same object as `state.ctx`
(or `ctx.now` moved forward past the earliest `future-dated` entry), and when `state.run.held` is non-empty and the context could have gained the
piece; then take the refold branch (from the checkpoint snapshot or the start). A cheap and safe form: always refold when `ctx !== state.ctx` or any
`run.held` entry has reason `missing-blob`/`missing-key`, and add the matching test (`addEntries` with a changed context equals `foldEntries`).

## Warnings

### WR-01: Gate verdicts are accepted from any admitted device that labels itself as the seat's agent

**File:** `src/domain/replica/versions.ts:83-90, 105-127`; `actorForTransition` at `:194-200`
**Issue:** `validVerdicts` hands `{ kind: 'agent', member: who.actor.member }` to `transition()`, where `isAgent(actor, roles.releaseGuard)` is the only
test. `actor.member` is a label the writer chose; the device's roster member is never compared with anyone entitled to run the guard or the tradecraft
reviewer. Any admitted device (a plain `member` of another section) can write `version.verdict` CLEARED labelled `release-guard`, then
`SIGN-OFF` labelled as the tradecraft reviewer, and push a version to `guard-checked`. The plan records this ("gate agents on any device", 30-08 threat
model) but the control it protects ("a gate never checks its own work", `rolesProblem` in `kindSchemas/versions.ts:267`) then rests on every writer being
honest. Decisions still need a person holding `decision_for`, so an agent still cannot approve; the gap is the two gates before that.
**Fix:** Require that the writing member is allowed to run that seat, in the roster view (for example `roster.canRunAgent(member, agentSlug, rosterHash)`
from the Phase 31 roster), and refuse `not-gate-member` otherwise. Until Phase 31 exists, add the check as an injectable predicate on `ReplicaContext`
that defaults to deny, so the unsafe default is not the shipped one.

### WR-02: The actor label is not checked for `project.genesis` and `project.import`, and the agent identity in attribution is unverified

**File:** `src/domain/replica/projectFold.ts:75-77`; `src/domain/replica/textFold.ts:117-128`; `src/domain/replica/entry.ts:234-242`
**Issue:** `versions.ts` refuses `product.create` and `product.owner` unless `actor.kind === 'person'`, but `projectReducer.apply` only asks whether the
device's member holds `staff_lead`. An entry labelled `agent` or `hub` from the lead's device sets the project name, the lead and the hub `certPin`
(`projectFold.ts:83-92`). In the same way a doc.client registration can carry any agent `member` and `run` slug; `isActorShape` checks only the
pattern, so one member's device can attribute text to another member's agent name (the `member` of the span stays truthful, the `agentMember` does not).
D-06 says the label is the signing device's claim, so this is by design for text; it is not by design for governance acts.
**Fix:** In `projectReducer.apply`, add `if (entry.body.actor.kind !== 'person') return refused('not-staff-lead')` (or a new `agent-cannot-decide`
reason) before the role check. For attribution, document that `agentMember` is a claim and, once Phase 31 has agent seats, require
`roster.canRunAgent(entry.member, actor.member)` at registration.

### WR-03: A fork with three or more branches cannot be resolved by the lead's `device.release` choice

**File:** `src/domain/replica/equivocation.ts:96-101, 107-110`
**Issue:** `findEquivocations` builds one proof from the two lowest entry hashes of a slot; `forkChosen` accepts a chosen branch only if it equals the
hash of `proof.a` or `proof.b`. If a writer signs three headers at one seq and the lead chooses the third, `forkChosen` returns `undefined`, the fork
stays unresolved, and `excludedEntries` excludes every entry of that writer from the fork seq on, including the branch the lead chose. The resolution
mechanism silently fails exactly when the writer has done the most damage.
**Fix:** Pass the full set of hashes in the slot to `forkChosen` (for example attach `branches: string[]` to the in-memory proof, not the wire form) and
accept any of them, or build one proof per pair and treat a choice of any member of the slot as resolving it. Add a test with three branches.

### WR-04: One refused or held `doc.update` in a product's history makes every later honest compaction `compact-mismatch`

**File:** `src/domain/replica/textFold.ts:198-207`
**Issue:** `included` is every `doc.update` of the product in the closure of the covers, whether or not the fold accepted it. Any one of them that the
fold refused (a foreign-client or forbidden-content update from a hostile device is enough, and refused entries stay admitted graph nodes) or held makes
`for (const hash of included) if (!acceptedHashes.has(hash)) return refused('compact-mismatch')` fire. Honest writers list the heads they have seen as
deps, so the hostile entry ends up in the past of every later compaction. The cache feature is then switched off for the product by one entry.
**Fix:** Build the scratch document from the accepted updates inside `included`, and ignore included entries the fold did not accept, as long as the
state vector and text hash still match the scratch document (a refused update contributes nothing to either). Keep the refusal only when an accepted
update is missing from the scratch set.

### WR-05: Small entries force whole-history rebuilds (compaction check and version proposal)

**File:** `src/domain/replica/textFold.ts:198-211`; `src/domain/replica/versions.ts:258-261`; `src/domain/replica/doc.ts:481-489`
**Issue:** Every `doc.compact` that passes the cover test runs `rebuilt(accepted.filter(...))`, which rebuilds a Yjs document from all included updates,
plus `closure()` over up to 64 covers. Every `version.propose` runs `snapshotMissing` and `textAtSnapshot`, which build two further scratch documents from
all accepted updates of the product (`inspectSnapshot` is called twice), and `deriveProduct` builds one more per version
(`attributionAtSnapshot`, `versions.ts:392`). A compaction entry is a few hundred bytes; the work is proportional to the whole history. An admitted
writer can repeat it indefinitely; in the incremental path it is repeated on every `addEntries` for entries after the first refold.
**Fix:** Memoise by `(product, accepted.length)` the scratch document and state vector of the accepted prefix, and let `snapshotMissing` and
`textAtSnapshot` share one `inspectSnapshot`. Cap compactions and proposals per product and writer per window in the schema or the reducer (refuse
`too-many`), as the doc and checkpoint caps already do for their own inputs.

### WR-06: The decision algebra is cubic in the number of acts, and the causal graph keeps a full ancestor set per queried entry

**File:** `src/domain/replica/decisions.ts:407-423, 368-376, 465-481`; `src/domain/replica/causal.ts:264-271`
**Issue:** `closureOf` is O(n^2) `before()` calls with `seen.includes` (up to 64) inside, followed by a fixpoint whose pass is O(n^3); `settleValidity`
runs `valid.filter(preceded)` and `settle` (itself O(n^2)) for every act; `approvedIn` calls `resolve` once per withdraw. Only valid acts reach it, so
the attacker is a holder of a decision role or an owner-side member, but such a person can write thousands of small `version.decide` or
`version.withdraw` entries for one version, and every peer's fold then stalls. Separately `graph.past` memoises one `Set` of all ancestors for every
entry queried by `isBefore` and `concurrent`, so n queried acts over N history entries hold up to n*N set members.
**Fix:** Cap the acts one writer may have on one version (the schema already caps `decisionsSeen` at 64; add a reducer-level cap and refuse
`too-many-acts`). Replace the repeated fixpoint with one topological pass over `before`, and let `past` answer `isBefore` from a per-entry ancestor
bitset or from lamport bounds (`a.lamport < b.lamport` is a necessary condition) before building a set.

### WR-07: A hostile update allocates every struct before the struct cap applies, and the snapshot delete check is quadratic

**File:** `src/domain/replica/doc.ts:533-535, 468-477`
**Issue:** `inspectDecoded` calls `decodeUpdate(bytes)` on up to 4 MiB and only then checks `decoded.structs.length > MAX_STRUCTS`. A GC struct is
two bytes on the wire, so one update can create about two million struct objects (hundreds of megabytes) before the check refuses it. In
`deletesCovered`, for every range in the (attacker supplied) snapshot, `held.some(...)` scans every held range of that client, so a 1 MiB snapshot with
about 250 thousand ranges against a document with tens of thousands of ranges is billions of comparisons.
**Fix:** Bound the work before decoding: read the struct count of each client group from the first bytes (lib0 varuints) and refuse above
`MAX_STRUCTS` before `decodeUpdate`, or lower `MAX_UPDATE_BYTES` for updates carried inline. In `deletesCovered`, sort the snapshot ranges per client
and merge-walk them against the held ranges (both are already sorted), which is linear.

### WR-08: The fold keeps every delivered object forever and creates a document per registration

**File:** `src/domain/replica/fold.ts:82-86, 136-139, 144-160, 353-357`; `src/domain/replica/textFold.ts:77-97, 117-128`
**Issue:** `Store.seen` is a `Set` of every delivered object, junk included, and `copyStore` copies it on each `addEntries`. Deduplication is by object
identity only, so the same valid entry sent as a thousand separate objects is verified a thousand times (signature, decryption, schema); the comment on
`hashOf` ("how exact duplicates are recognised before any real work") describes a step that `ingest` does not take. `retry` lists keep every held copy.
Each `doc.client` entry creates a `ProductText` with a Yjs document for an attacker-chosen product slug and stream, with no cap; `cloneRun` then clones
all of them on every incremental call.
**Fix:** Key `seen` by entry hash after a cheap `parseHeaderShape` plus `entryHash` and skip entries already chosen with the same hash before
`verifyEntry` runs; drop the unreadable inputs after counting them; cap registrations per writer per product and products per stream (refuse
`too-many-products`); create the Yjs document lazily on the first accepted update, not on registration.

### WR-09: An act that saw a held act is held with it, so one bogus `decisionsSeen` id can block later honest decisions

**File:** `src/domain/replica/decisions.ts:394-403`
**Issue:** An act whose `seen` contains an id nobody knows is held `unknown-decision-seen`, and any act that lists a held act in its own `seen` is held in
turn. A person who can reach the candidate list (an owner-side `version.withdraw` is enough) lists a hash that does not exist; every later honest
decision on that version that records the withdraw in its `decisionsSeen`, as the contract asks, is held too, and the version cannot be decided.
The claim rests on how clients fill `decisionsSeen` (Phase 33 is not written), so it is a design risk, not a proven break.
**Fix:** Hold only the act that names the unknown id, not the acts that merely saw it (an act seen by another is still a fact the other act observed), or
record the dependency as informational and keep precedence by `before`. Add a test in which an honest act cites a held act.

## Info

### IN-01: The `precedence-cycle` hold cannot occur

**File:** `src/domain/replica/decisions.ts:425-430`
**Issue:** An edge of the precedence relation is either causal ("x is in y's past") or "y saw x", and `seen` holds entry hashes. A hash can only be
written into an entry whose content already exists, and an entry's hash includes the hashes of its `deps` and `prev`, so every edge runs from a
later-created entry to an earlier-created one. A cycle would need two entries that contain each other's hash. **Category:** necessity. Evidence: the
hash-linked structure (`entry.ts` `entryHash` over a header that signs `body.hash`, which hashes the sealed body that holds `deps`); the tests for the
hold only build cycles by hand-crafting `DecisionAct` values, which the fold cannot produce.
**Fix:** Keep the cycle guard as a defensive assertion that throws in tests, or drop the code and its `DecisionHold` member `precedence-cycle`.

### IN-02: `updateClients` is exported and unused

**File:** `src/domain/replica/doc.ts:371-379`
**Issue:** No file under `src` calls it (`inspectUpdate` replaced it).
**Fix:** Delete it.

### IN-03: `rank()` orders outcomes by the spelling of their status words

**File:** `src/domain/replica/fold.ts:76-78, 154`
**Issue:** `rank` returns `'0'` for verified and `1:<status>:<reason>` otherwise, and the smaller string wins. `'held' < 'rejected'` is true only because
of the letters, so a corrupt copy of an entry whose good copy is permanently rejected turns the entry into `held`. This is deterministic and
probably wanted ("a good copy may still come"), but it is an accident of the alphabet.
**Fix:** Use an explicit numeric rank (`verified: 0, held: 1, rejected: 2`) and a comment that says a held copy beats a rejected one on purpose.

---

_Reviewed: 2026-11-19T18:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_

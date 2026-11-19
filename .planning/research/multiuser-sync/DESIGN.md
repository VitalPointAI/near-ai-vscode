# Design: multi-user staff workspaces, signed replication and your organization's sync hub

Date: 2026-11-19. Status: design and phase plan, no code changed. Read against `origin/main` at d3c2e00c (release 0.4.34).

Companion: `RESEARCH.md` in this folder (options, sources, comparison tables). Inputs: the staff teams design (`.planning/research/staff-teams/10-STAFF-TEAMS-DESIGN.md`, 4.1 to 4.5 and 9), note 11 (`11-operational-feeds-cop.md`, 4.5 to 4.7), the paused knowledge base design (`.planning/milestones/v0.5.0-paused/`), the roadmap (Phase 27, Phases 68 to 71, L2, L5) and the code cited below.

Words used here: a **person** is a human staff member; a **device** is one install of the extension on one machine for one person; a **stream** is everything about one staff project at one label cell; a **writer** is a device writing to a stream; an **entry** is one signed line in a writer's log; the **fold** is the pure function every machine runs to turn all entries into staff state; the **hub** is your organization's sync hub.

---

## 1. Key points first

1. **Today a staff project works on one machine only.** Its ledgers are single hash chains trusted only against this install's own keys, so a second person's entries read as unknown and break the ledger. Until this ships, the README says so (0.4.35).
2. **We build our own replication layer.** Every device writes its own signed, hash-chained log per stream. Entries cite the heads they had seen from others, which joins all logs into one causal graph. Every machine folds that graph in one deterministic order and compares a state digest. A device that signs two different entries at one position has proved its own misbehaviour and is quarantined.
3. **Everyone can co-edit products from the first release** (owner, 2026-11-19). Product text is a Yjs document whose updates travel inside our signed entries: we sign, order and encrypt; Yjs merges the text. Every character is attributed to a person, or to an agent on a named person's machine. Live cursors and presence show who is where.
4. **Approval still binds an exact frozen text.** A *version* is a snapshot with a content hash, proposed by whoever answers for the product. Verdicts, approvals and releases pin that hash. Editing after a proposal starts the next draft.
5. **Two people deciding one version at the same time with different outcomes makes it "contested"**, and a fresh decision is needed. Nothing picks automatically.
6. **The hub is in the first build phases.** It gives live updates, presence and finality checkpoints, keeps ciphertext for cells it is not cleared for, and runs standing watches in cells it is cleared for. To run a watch the hub must read the cell, so the hub is a member with its own key, roster entry and clearance, granted cell by cell. This supersedes "attended runs only" (note 11, Q5) with explicit guards.
7. **The hub is its own service in the relay's Docker Compose stack**, built like the relay, with its own state, port and threat model.
8. **Edge machines keep working offline.** Appends are local first. Git with one ref per writer, a LAN peer link and a sealed bundle file carry the same logs when the hub is out of reach.
9. **Team Mode (L2) moves onto this layer** when L2 starts: one multi-writer log in the product, not two.
10. **Delivery: Phases 30 to 35 in the 0.4.x line**, as two staff collaboration drops. Drop A (30 to 33) gives live multi-user staff projects through the hub. Drop B (34, 35) adds offline transports, shared agent work, observation sharing and hub watches. Verified identities and hub-to-hub federation follow with Phase 71 and L5.

---

## 2. Goals and non-goals

**Goals.**
- G1: several people, each on their own machine, work one staff project at once and see each other's work live when connected.
- G2: anyone can edit any product's text at the same time, people and agents, with attribution and live cursors.
- G3: every person decision is signed and verifiable on every machine; an approval binds an exact text.
- G4: no silent forks, rollbacks or withheld entries; divergence is reported.
- G5: need-to-know on the wire: no device receives a stream above its clearance; the hub holds only ciphertext for cells it is not cleared for.
- G6: edge machines work offline and sync later by hub, git, LAN or file.
- G7: agent teams on different machines see each other's lanes and claims and avoid duplicate work.
- G8: standing watches run continuously on the hub, under guards.
- G9: single-machine projects keep working unchanged; turning on multi-user migrates them without loss.
- G10: no runtime dependencies or native modules in the extension; the core stays free of `vscode` so it moves to Theia.

**Non-goals.** Sharing chats, transcripts, prompts, tool calls, NEAR AI keys, spend or model choices (per person, Phase 27 and L2). Cross-domain transfer between networks of different classification (labels are not accreditation). Verified identities before Phase 71. Co-editing code or arbitrary files. Running Matrix, Hypercore, Automerge Repo or any outside sync server. Hub-to-hub federation (L5), beyond keeping the format ready.

---

## 3. Where we are (audit of `origin/main`)

| Area | Today | With several people |
|---|---|---|
| Phase 27 sync | Moves one person's state between their machines: chats, run records, checkpoints, comparisons, choices, spend (`src/domain/state/records.ts`). Never carries `.planning/staff/**` | Staff state does not follow even one person through sync |
| Product ledger | `.planning/staff/ledger/products.jsonl` (`src/domain/staff/ledger.ts`): one global chain, `seq` and `prev` over the whole file, signed with purpose `staff-ledger` by this device | Two concurrent appends get the same `seq`; any merge breaks the chain |
| Other ledgers | `decisions.jsonl` (`personDecisions.ts`), `calculator.jsonl` (`logistics/calcLedger.ts`, `src/staff/logisticsHost.ts`), `.planning/staff/wargame/ledger.jsonl`; `events.jsonl` is unsigned (all listed in `src/staff/staffHost.ts`) | Same single-chain failure; events forgeable by anyone with file access |
| Trust | `src/services/staffCommands.ts` passes `keyStatus: () => localKeyStatus(...)` (`src/team/keyHistory.ts`): only this install's own keys are known | Another person's or device's entries verify as `unknown`; products read `draft (tampered)` (`src/domain/staff/staffRoom.ts`) |
| Forks | Fatal. Ways out: **Set Aside** (`nearAi.staff.setAsideLedger`) and **Use This Branch's Ledger** (`nearAi.staff.useBranchLedger`), both for one person switching branches | No reconciliation of concurrent work |
| Head mark | Signed ledger head in this install's SecretStorage (`staffHost.ts`, D-59) | Other machines and devices have their own or none |
| Locks | `withRegisterLock` (`src/staff/registerLock.ts`) and `writeIfUnchanged` (`src/staff/staffFiles.ts`) work inside one extension host | Nothing stops two machines writing one file |
| Ownership | `src/domain/staff/ownership.ts`: one writer per product within one run's roster (`writerIn`); others propose under `.planning/staff/proposals/` | Holds within one run on one machine only |
| Observations | `src/staff/observationStore.ts`, `src/domain/staff/obs/store.ts`: own `.gitignore`, never leave the machine | Nothing shared |
| Presence | `src/staff/watchAttendance.ts` tracks attendance in this extension host only | Nobody sees who else works |
| Watches | Run only while a staff run or open Staff Room attends (note 11, Q5, 2026-11-18) | Stop when the last window closes |
| Team Mode | `src/team/*`, `src/domain/team/*` (Phase 69, preview): a separate signed log on one git ref, appended by compare-and-swap (`gitTransport.ts`, `eventLog.ts`); not used by staff | Every append needs the remote; cut-off sites cannot both write |
| Planned | L2 Team Mode, Phase 71 identities, SHRD-01 to SHRD-03 | None of it for staff |

Kept: canonical JSON and the Ed25519 payload signer (`src/domain/team/canonical.ts`, `signedPayload.ts`), key status (`keyStatus.ts`), device identity and key history (`src/team/identity.ts`, `keyHistory.ts`), the hardened git runner and private mirror pattern (`runGit.ts`, `cleanRemote.ts`, `src/services/stateTransport.ts`), the release state machine (`src/domain/staff/release.ts`), Phase 27 merge laws (`src/domain/state/merge.ts`), and the relay's deploy stack (`relay/`).

The lesson: the hash chain is right; the single global chain breaks, because it needs one always-reachable sequencer, and the edge rules that out.

---

## 4. Architecture

```
 Person A's machine               Person B's machine            Your organization's hub
 staff host, Staff Room,          (same)                        hub service (Compose)
 product editors (Yjs bound)                                      append checks vs roster
 replica core (pure): codec,                                      ciphertext and blob store
   fold, digests, rules, docs                                     live push, presence
 replica store, blobs, keys                                       signed checkpoints
 replicator (one interface) --+-- hub ---------------------------  watch runner (granted cells)
                              +-- LAN peer (same room)
                              +-- git, one ref per writer
                              +-- bundle file (air gap)
```

| Component | Where (planned) | Job |
|---|---|---|
| Replica core | `src/domain/replica/` (pure) | Codec, signature and chain checks, causal order, fold, digest, equivocation proofs, version and decision rules |
| Product documents | `src/domain/replica/doc.ts`, vendored Yjs | Apply updates, check client ownership, text, attribution, snapshots |
| Roster, cell keys | `src/domain/replica/roster.ts`, `src/replica/keys.ts` | Members, seats, roles, clearances, devices, hub member; per-cell keys and wraps |
| Store, replicator | `src/replica/store.ts`, `replicator.ts` | Per-writer append-only files, blobs, high-water marks, quarantine, one lock per project; head exchange, push, pull, link ceilings |
| Transports, presence | `src/replica/transports/{hub,lan,git,bundle}.ts`, `presence.ts` | One interface; ephemeral heartbeats and cursors |
| Editor binding | `src/staff/productEditor.ts` | VS Code document to Yjs text and back |
| Hub | `hub/` beside `relay/` | Section 10 |

### 4.1 Streams and cells

A **cell** is a level plus a compartment set from the Phase 70 label map. Each project has one **roster stream** (base cell, readable by every member) and one stream per cell for its products, decisions, registers, watches, run summaries and observation segments. Stream and cell ids on the wire are random 128-bit values; the cell's level and compartments are only inside its encrypted grant (8.2).

### 4.2 Entry format (version 2)

```
Header (visible to the hub) {
  v: 2, stream: <opaque id>, writer: <sha256 of device Ed25519 key>,
  seq: n,                                   // per writer per stream
  prev: <hash of this writer's previous entry> | genesis,
  epoch: <cell key epoch>, body: { hash: sha256(ciphertext), size },
  sig: Ed25519 over canonical JSON of the above
}
Body (AES-256-GCM under the cell epoch key; header without sig as associated data) {
  deps: [ {writer, seq, hash} ... ],        // heads of others seen, at most 16
  roster: <hash of the roster entry seen>,
  lamport: max(lamport of prev and deps) + 1,
  at: wall time (display, leases, offline age; never ordering),
  actor: {kind: person} | {kind: agent, member, run} | {kind: hub, watch},
  kind: see 4.3, data: {...} | {blob: <sha256 of a sealed blob>}
}
```

The entry hash is sha256 of the canonical header with `sig`. Bodies over 16 KB go to content-addressed sealed **blobs**, fetched on demand. Signing uses the existing `signPayload` with a new purpose `staff-replica`, so the Phase 71 move to `eddsa-jcs-2022` changes the envelope, not the log. Agents never hold a key: an agent's write is signed by the device that ran it, with `actor: agent`.

### 4.3 Entry kinds

| Family | Kinds |
|---|---|
| Project | `project.genesis`, `project.import` |
| Roster (roster stream only) | `member.invite`, `member.admit`, `member.update`, `member.remove`, `device.add`, `device.rotate`, `device.revoke`, `device.quarantine`, `device.release`, `hub.admit`, `hub.grant`, `hub.revoke`, `cell.create`, `cell.rekey`, `lead.handover`, `roster.choose` |
| Product text | `doc.client`, `doc.update`, `doc.compact` |
| Versions and ownership | `product.create`, `product.owner`, `version.propose`, `version.verdict`, `version.submit`, `version.withdraw`, `version.decide`, `version.release`, `version.supersede` |
| Registers, person decisions | `register.row`, `pir.decide`, `watch.decide` |
| Watches | `watch.define`, `watch.assign`, `watch.match`, `watch.state`, `watch.killSwitch` |
| Shared agent work | `run.start`, `run.lane`, `run.claim`, `run.release`, `run.summary`, `run.end` |
| Observations | `obs.segment`, `obs.coalesced`, `obs.pruned` |
| Integrity | `equivocation.proof`, `digest.report` |

Each kind has a schema validated like `src/domain/team/validate.ts` (own-property checks, no spread of parsed input). Unknown kinds from a newer client are kept and relayed, shown as "made by a newer version", and never change state on an older client.

### 4.4 Ordering, fold and digest

1. Verify every entry: header signature, writer chain intact from seq 0, body decrypts and authenticates, schema, author authorised at the cited roster hash.
2. Order the causal graph from `prev` and `deps` topologically, ties broken by (`lamport`, `writer`, `seq`). Same entries, same order, on every machine.
3. Fold through pure reducers into products, texts, versions, decisions, registers, watches, claims and run summaries. An entry causally after everything folded is applied at the end; a late concurrent entry triggers a refold from the last checkpoint. Text needs no refold, since Yjs merges any order.
4. **State digest** per stream: sha256 of the canonical folded state (texts by state vector and text hash).

Wall time never orders. Entries more than 10 minutes in the future are held until the local clock reaches them.

Every head announcement (checkpoint, LAN hello, bundle manifest) carries heads and digests. Equal heads with different digests mean a fold bug or a corrupt store: the Staff Room says "Your copy and the hub disagree about this project. Nothing was lost. Report this.", and the button writes `digest.report` and a diagnostic file with heads and digests, no content.

### 4.5 Equivocation, tampering, withholding, rollback

| Situation | What happens |
|---|---|
| Two people append at once | Concurrency, not a fork: both kept, ordered by the fold |
| One writer, one stream, one `seq`, two different signed headers (cloned key, restored image, compromise) | **Equivocation**: the pair is a portable proof. Every machine writes `equivocation.proof`, folds nothing from that device after the fork, marks it **quarantined**, and shows it. The lead writes `device.revoke`, or `device.release` choosing a branch. The device can still read; its person can keep working from another device |
| An old entry changed | Tamper: that writer's chain breaks there and later entries from it are held; others unaffected |
| Entries hidden by a peer or the hub | Withholding: detected when `deps` or a checkpoint cite a head not delivered; shown as "missing N entries from the J5 lead since 14:02" |
| An older history presented | Rollback: each device keeps per-writer high-water marks, protected by a SecretStorage head mark (D-59 pattern), and refuses a shorter history |

### 4.6 Finality checkpoints

The hub signs a **checkpoint** at most every 60 seconds while entries arrive and on request: project, roster head, per stream the heads per writer, and digests for cells the hub holds. Order before a checkpoint is provisional only in that a late concurrent entry may slot in; order covered by a checkpoint is final, and later-arriving entries fold after its prefix. Two hub checkpoints that disagree about one prefix are a hub equivocation proof. Without a hub there is no finality, and the Staff Room marks decisions since the last checkpoint "not yet confirmed by the hub"; they still take effect. L5 later allows several hubs; the checkpoint names its signer.

---

## 5. Co-editing products with a CRDT inside signed entries

### 5.1 Choice

| | Yjs | Loro | Automerge |
|---|---|---|---|
| Version, licence (npm, 2026-11-19) | 13.6.33, MIT; `lib0` 0.2.120, MIT | 1.18.0, MIT | 3.5.0, MIT |
| Code | Pure JavaScript | Rust to WASM | Rust to WASM |
| Maturity | Deployed widely since 2019; CodeMirror, Monaco, ProseMirror bindings | Young, fast-moving | Mature; 3.0 cut memory more than tenfold |
| Signing, access control | None (we add it) | None | None (Keyhive alpha) |
| Bundle fit | esbuild bundles it; no WASM, no native module | WASM in the extension host and Theia | Same as Loro |

**Choice: Yjs**, vendored with `lib0` at pinned versions with licence files and a manifest entry, as MapLibre and milsymbol are vendored (`media/vendor/VENDORED.json`); not a `package.json` runtime dependency. The CRDT sits behind one interface (`applyUpdate`, `encodeDiff`, `text`, `snapshot`, `attribution`) so Loro remains a local swap if the spike shows a size or garbage collection problem.

### 5.2 How text travels

- Each product body is one `Y.Doc` with a `Y.Text` named `body`.
- Each Yjs client id is registered with `doc.client` `{product, clientId, actor}`: one per device per product for the person's editor, one per agent run. A collision with another writer's registered id makes the device pick again.
- Local edits are batched into one `doc.update` per product per writer at most every 500 ms; large updates go to a blob.
- **Ownership check**: every inserted struct must carry a client id registered to the entry's writer; otherwise the update is rejected as forged attribution. Deletions may touch anyone's text; the fold records which entry deleted which range.
- Yjs merges in any order, so text never needs our total order; only versions, decisions and claims do.
- **Compaction**: after a checkpoint, any member may write `doc.compact` with a full state as a blob. Joiners load the newest compaction plus later updates. Updates are never removed from the log.

### 5.3 Attribution and cursors

The fold maps each character's client id to its `doc.client` entry. **Show Who Wrote This** colours the gutter per author; hover says, for example, "J2 analyst agent, run 14, on the J2 chief's machine". Each version carries an attribution summary so a reviewer sees who shaped what they approve.

Cursors and selections are Yjs relative positions, sent in presence messages sealed under the cell key, at most 10 per second, never stored. Other people's cursors show with name and seat; a section an agent run has claimed shows "agent writing here".

### 5.4 Binding VS Code to Yjs

- The file on disk stays a projection: header from the fold, then the body from `Y.Text`. The header region is read-only; an edit to it is reverted with a one-line notice. Saving writes the projection.
- `onDidChangeTextDocument` changes become `Y.Text` operations tagged with a local origin; non-local Yjs changes become a `WorkspaceEdit`. Echo is suppressed by origin, as in the CodeMirror and Monaco Yjs bindings.
- Undo uses a Yjs `UndoManager` scoped to local origins, so undo removes only your own edits.
- Agents write through the `staff-products` tool: it applies a minimal diff from the current text as Yjs operations, so a person typing elsewhere is not overwritten. A whole-text replacement is refused if others edited since the agent read; the agent gets the current text.
- A disk change outside the binding (shell, git checkout) still reads as a file change (`FILE_CHANGE_ACTOR`). The Staff Room offers **Take This Change as My Edit** (signed by the person) or **Restore**.

### 5.5 Registers

Register rows (CCIR, RFI, PIR, synchronization matrix, assumptions, annex tracker) are records. Everyone may edit them. Concurrent edits to different fields merge; concurrent edits to one field keep both values and show "changed by two people at once: pick one" (the Phase 27 `fork` policy at field level). The register owner proposes its versions.

---

## 6. Product versions, approvals and contested decisions

### 6.1 Ownership is accountability

`ownership.ts` still names one owner per product and register part. The owner now means the member, and the person who answers for that section, who **proposes versions**, submits and withdraws them. It is no longer a write lock. Ownership changes by `product.owner` from the section lead or staff lead.

### 6.2 Working text and versions

A product has a **working text** (the live document, always editable unless withdrawn) and **versions**: frozen snapshots each with a number, content hash, a blob of the exact text and header, an attribution summary and a release state.

`version.propose` carries the hash, the blob and the Yjs state vector. The fold checks the blob hashes correctly and equals the text at that state vector, so nobody can propose text that was never in the document. Numbers follow fold order. Two proposals made at once are both kept, numbered consecutively and marked "proposed at the same time as v5"; the owner withdraws one or sends both to review.

Edits never touch a proposed version. The working text moves ahead and the Staff Room shows "v5 awaiting decision, 37 changes since". This replaces design 10's "guard-checked or awaiting-decision to draft on any edit", which existed only because the file was the version.

### 6.3 Who may do what

| Act | Who | Fold check |
|---|---|---|
| Edit working text | Any member device with access to the cell, persons and agents | Admitted, not revoked at the cited roster; client ownership |
| Propose a version | Owning member (agent), a person answering for that section, or the section lead | Roles at the cited roster |
| Guard and tradecraft verdicts | Release-guard and tradecraft members on any device | Verdict pins the hash |
| Submit | Owner side or section lead | Version guard-checked |
| Approve, reject, release, supersede | **Persons only**, with the `decision_for` role, through the UI | Actor is a person; never an agent |
| Withdraw | Owner side or a person with a decision role | Reason recorded |

`release.ts` is reused: its states and its refusal of agent decisions apply per version (15.4).

### 6.4 Decisions and the contested state

`version.decide` carries `{product, version hash, outcome, reasons, decisionsSeen}`. Per version the fold applies:
- **Decisions in causal order**: the latest is effective (a person changing their mind, a commander overruling a deputy).
- **Concurrent, same outcome**: effective, all names shown.
- **Concurrent, different outcomes** (owner decision 2): **contested**. Neither applies. Both show in the decision queue, with names and reasons, to everyone with the role. Nothing picks by fold order, rank or time.
- **Settling**: a fresh `version.decide` whose `decisionsSeen` includes every contested decision. Any role holder may write it, including one of the two.
- **Withdraw concurrent with a decision**, and **release concurrent with a reject**: also contested.
- **Release** needs an effective approval of the same hash causally before it.
- **Role removed concurrently**: the decision is kept as "made while the role was being withdrawn" and waits for a current holder to confirm.
- **While deciding**: the dialog acts on the hash and decision state on screen; if another decision on that version arrives while it is open, it refuses with "Someone else decided this version while you were deciding. Look again."

A late offline decision that conflicts with one a checkpoint made final still makes the version contested; finality changes only the wording ("decided at 14:02, then disputed by a decision made offline at 13:58").

Design 10's dependency rule carries over unchanged: dependants pin a version hash and get "source changed" when a newer version is released, now across people.

---

## 7. Membership, roles, clearances and keys

### 7.1 Genesis and the roster

**Make This Staff Project Multi-User** writes `project.genesis`, signed by the person who runs it, who becomes the **staff lead**. Genesis names the project id, profile, level, label map hash, the lead's device, first cell grants, and the hub's key and certificate pin if any. Every machine pins it on join (Team Mode's `GenesisAnchor` and the trust pin of `src/team/teamFile.ts` are the model).

The roster is single-writer and linear: only the devices of the staff lead and the deputy lead write it (owner decision 5), and every roster entry cites the previous one (`rosterPrev`), so authority never needs general state resolution (the Matrix lesson, `RESEARCH.md`).
- Online, the hub accepts a roster entry only if `rosterPrev` is the current head.
- Offline, two roster writers (two of the lead's devices, or the lead and the deputy) writing on one `rosterPrev` **split** the roster: both pending, the common prefix applies, and the lead (or, if the lead is unavailable, the deputy) writes `roster.choose`. The Staff Room says "The roster was changed in two places at once. The lead or the deputy must choose."
- `lead.handover` names a new lead; the deputy may sign it when the lead is lost, so losing one lead is not fatal (owner decision 5). `deputy.name` names or replaces the deputy and is written by the lead. Only if both are lost before Phase 71 is the project re-founded by export and import into a new genesis.

| Entry | Content |
|---|---|
| `member.invite` | Invite id, proposed name, seat (for example `j2-chief`), decision roles (`decision_for: commander`), clearance, expiry, hash of the one-time join secret |
| `member.admit` / `member.update` / `member.remove` | Person, seat, roles, clearance, first device; changes; removal (rekeys their cells) |
| `device.add` / `rotate` / `revoke` | Phase 69 event bodies and `keyStatus` rules on the new format |
| `device.quarantine` / `release` | Equivocation handling |
| `hub.admit` / `grant` / `revoke` | Hub key, certificate pin, clearance ceiling, granted cells (10.2) |
| `cell.create` / `rekey` | New cell or epoch; wraps delivered as grants (8.2) |

Roles: **staff lead** (writes the roster), **deputy lead** (also writes the roster, and may hand over the lead), **member** (reads and writes granted cells), **decision roles** (approve, reject, release for named products or sections), **observer** (reads, writes only presence), **hub** (service member). Agents act under the device of the person who ran them and are not roster members.

### 7.2 Self-declared until Phase 71, then credentials

Before Phase 71 the lead declares names, seats and clearances. Every multi-user screen shows `CLEARANCE_SELF_ASSERTED_TEXT` and `LABELS_NOT_ACCREDITATION_TEXT` (`src/domain/gate/labels.ts`) and "People and clearances in this project are declared by the staff lead, not verified." Decisions are device-key signed, as design 10 Q10 accepted.

After Phase 71: persons are `did:webvh`, devices `did:key` (the same Ed25519 key, so no log change), seats, roles and clearances are verifiable credentials from your organization, revoked through status lists with a maximum offline age per level. Roster entries then cite credentials instead of declarations.

### 7.3 Joining by signed file

1. **Invite.** The lead runs **Invite to Staff Project** and picks name, seat, roles and clearance. The extension writes `member.invite` and an invitation file (`.near-staff-invite`) signed by the lead's device: genesis hash, project name, invite id, hub address and pin, one-time join secret, expiry (default 7 days).
2. **Answer.** **Join Staff Project** checks the lead's signature against the genesis inside, creates or reuses the device identity, and makes a join request signed by the device: invite id, Ed25519 and X25519 public keys, the person's name, and a MAC with the join secret. With a hub it is posted to the hub, which accepts it only with a valid secret; otherwise it is a file to send back.
3. **Verify.** Both screens show a six-word **safety code** from the two device keys, compared by voice or in person. The lead clicks **Admit**, writing `member.admit` and the cell grants.
4. **Catch up** from the hub or a bundle file.

Invitations are single use, expire, and can be voided.

### 7.4 Device keys

Signing uses the Phase 69 Ed25519 device identity in SecretStorage (`src/team/identity.ts`). Encryption uses a new X25519 key per device, also in SecretStorage, bound by an Ed25519 signature in the roster; `node:crypto` provides both. One identity per person per install (Phase 69). On a shared code-server each person keeps their own copy and install storage; SHRD-02's recovery code later backs up both keys. A second machine of the same person joins through **Add My Other Machine**, a short invite from the lead (later, L2's "Replace my device").

---

## 8. Label cells and need-to-know on the wire

### 8.1 Rules

1. **Everything lives in its cell**: a product with its text, versions, decisions and claims; observations by their label.
2. **Senders filter**: a device or the hub offers a stream only to peers whose clearance at the current roster dominates the cell (declared before Phase 71, verified after).
3. **Ciphertext elsewhere**: bodies and blobs are sealed under the cell's epoch key. A git host, a lost USB stick, or the hub for ungranted cells holds only ciphertext.
4. **Write up, never down**: a higher cell may cite lower-cell objects; the reverse is dropped by the fold and logged.
5. **Downgrading is a person's act**: a new product in the lower cell by a person whose role allows it, with a sanitisation note.
6. **Views per reader**: each machine folds only the streams it holds, so a person below a cell cannot learn its products exist or that a decision is pending.

### 8.2 Keys, wraps, grants

An epoch key is 32 random bytes per cell per epoch. A wrap is X25519 agreement with a fresh ephemeral key, HKDF-SHA256 (info: cell id, epoch, device id), AES-256-GCM over the epoch key: about 100 bytes per device, the paused design's "lockbox", shaped like HPKE base mode so a later standard library is a format version. Wraps for one cell travel in a **cell grant** signed by the lead and delivered only to devices on that cell and the hub. Members never see grants for other cells.

The hub needs each stream's **access list** (device ids allowed) to filter and check appends. It sees opaque cell ids and who is on them, not level or compartment names unless granted. This is residual metadata (section 16).

### 8.3 Removal and link ceilings

Removing a member, revoking a device or lowering a clearance writes `cell.rekey` for affected cells. The removed device keeps what it had; the lead is told: "They keep what they already received. They will not receive anything new."

Every link has a ceiling: a LAN link the peer's clearance; a bundle file the ceiling its exporter chooses, never above the lowest clearance of its recipients; a git remote the project base cell by default. Streams above a ceiling are not sent, even as ciphertext, unless the lead set "ciphertext may travel" on that link.

---

## 9. Transports

```
interface ReplicaTransport {
  readonly kind: 'hub' | 'lan' | 'git' | 'bundle';
  readonly live: boolean; readonly enforcesAppend: boolean;
  heads(streams): Promise<HeadSet>;
  pull(want): AsyncIterable<SealedEntry | SealedBlob>;
  push(entries, blobs): Promise<PushResult>;
  subscribe?(onHeads, onPresence): Unsubscribe;
}
```

Clients verify everything whatever the transport. Logs only grow and merging is set union, so any mix of transports converges.

- **Hub (first).** HTTPS and server-sent events; section 10. Live.
- **LAN peer.** For a room without a hub. One extension listens on a configured port after the person agrees ("Let other staff machines in this room connect to this one"), with a firewall note; inside code-server the operator publishes the port. TLS with a self-signed certificate on the device's key, pinned through the roster (SPKI hash signed in `device.add`); then a signed challenge bound to the TLS session (`exportKeyingMaterial`) both ways. Manual address entry first; a small pure-JavaScript mDNS responder on `node:dgram` may follow. Live.
- **Git, one ref per writer.** Any on-premises git server or a LAN bare repository. Each device pushes only `refs/near-ai/staff/<project>/<stream>/<writer>`, so pushes never race; fetching the namespace is set union. Reuses the private mirror, hardened runner and hook isolation of Phases 27 and 69, with its own mirror folder and lock, tested not to lock the Phase 27 or Team Mode mirrors. Project branches are never touched. Polled with the `syncScheduler.ts` pattern. Research flag: ref count grows as writers times cells.
- **Sealed bundle file.** **Export for...** picks recipients, computes what they lack from their last known heads, applies the ceiling, and writes a signed manifest (heads, digests, checkpoint) with the sealed entries and blobs. **Import Staff Bundle** verifies, folds and reports ("37 new entries from 3 people; 1 decision now contested"). Optionally also a `git bundle` of the per-writer refs.

| Concern | Hub | LAN | Git | Bundle |
|---|---|---|---|---|
| In transit | TLS 1.3 ended at the hub | TLS 1.3, pinned device certs | Remote's SSH or HTTPS; content is ciphertext | Ciphertext content; file itself not encrypted |
| Server proof | Hub cert pinned from invitation and roster; system CAs not trusted unless your organization's CA is pinned | Pinned device cert | Remote's checks | Manifest signed by exporter |
| Client proof | Device-key challenge bound to TLS; roster check | Same, both ways | Remote's access control; every entry signed | Every entry signed |
| Append control | Hub checks (10.7) | Peer verifies | Junk on one's own refs is rejected by clients | Importer verifies |
| Metadata | Opaque ids, device ids, sizes, timing, who is online | Same, to the peer | Ref names, sizes, push times | File size, opaque ids |

Mitigations for metadata: size padding (Phase 27 pads objects), optional fixed-interval flushes for sensitive cells, presence opt-out.

---

## 10. Your organization's sync hub

### 10.1 Service design

- New workspace `hub/` beside `relay/`, built the same way: Node 26 with pinned `engines`, one compiled file, `node:sqlite`, no runtime dependencies, distroless image with no shell, secrets from files, a redacting logger as the only output, a health check, its own CI job as a required check.
- **Compose**: a `hub` service in the relay's stack (`relay/compose.yaml`) under its own profile, so either runs without the other. Same hardening as the relay service (non-root uid, read-only root, `cap_drop: [ALL]`, `no-new-privileges`, `pids_limit`, `mem_limit`, tmpfs `/tmp`), its own volume `hub-state` and secret files. Unlike the relay's loopback port, the hub publishes its TLS port on an interface the operator chooses, because edge machines connect directly. The hub ends TLS itself so the device challenge binds to the session; a reverse proxy, if any, passes TCP through.
- It never runs tools, never touches messaging channels, never sees persons' NEAR AI keys. It may hold one model credential for watch drafting (10.6), from a secret file.
- It can be built before the relay phases, because it shares only the build, image and Compose patterns. The relay README gains a hub operator section (certificates, pins, backups, restore drill, upgrades); Phase 84's runbook absorbs it.

### 10.2 The hub as a cleared member

A watch reads its cell and drafts, so the hub must read the cells whose watches it runs.
- The hub has its own Ed25519 and X25519 keys (secret files), a roster entry (`hub.admit`) with a **clearance ceiling** set by the lead, and **per-cell grants** (`hub.grant`) only where the lead wants hub watches or hub digests. Everything else is ciphertext plus access lists to the hub.
- The trade-off, shown to the lead at each grant: "The hub will be able to read everything in this cell. Anyone who takes over the hub server can read it too. Grant only cells whose watches must run when nobody is at a computer."
- The hub always reads the roster stream (to check appends and serve access lists), so the hub server holds the staff list with names, seats and declared clearances.
- `hub.revoke` rekeys every cell it held and stops its watches.

### 10.3 Storage

SQLite (WAL) tables: `projects` (genesis, roster head, latest checkpoint), `streams` (opaque id, access list, epoch), `entries` (stream, writer, seq, hash, header, sealed body or blob reference), `checkpoints` (every one signed, kept as evidence), `equivocations`, `invites` (secret hash, expiry, pending requests), `folds` (granted cells only). Blobs live in a content-addressed folder. Entries and blobs are kept for the project's life; observation segments follow note 11's retention classes, and pruning writes a signed `obs.pruned` marker so clients do not read it as withholding.

### 10.4 Live push protocol

HTTPS requests plus **server-sent events** for push (the paused design's choice): no library, proxy-friendly, small messages. WebSocket can be added if measured latency needs it.

| Call | Purpose |
|---|---|
| `POST /v1/session` | Challenge and signed answer bound to the TLS session; short-lived token |
| `GET /v1/projects/:p/heads` | Heads of streams this device may receive, latest checkpoint |
| `POST /v1/projects/:p/append` | Batch of sealed entries, each checked (10.7) |
| `GET /v1/projects/:p/entries` | Entries after a position, per stream and writer |
| `PUT`, `GET /v1/blobs/:hash` | Sealed blobs |
| `GET /v1/projects/:p/events` (SSE) | `heads`, `presence`, `checkpoint`, `roster`, `equivocation`, `join-request` (lead) |
| `POST /v1/projects/:p/presence` | Heartbeats and cursors |
| `POST /v1/join`, `GET /healthz` | Join request with invite secret; health |

On reconnect a client sends its heads and receives what it lacks. Target: a typing batch reaches other editors of the product in under one second on a LAN.

### 10.5 Presence

A heartbeat every 5 seconds, TTL 30 seconds: person, seat, runs in progress, and the product in view with cursor sealed under that product's cell key (the hub learns only "device D is active in cell C"). Fanned out only to devices on that cell's access list; never written to disk. Per person setting: "Show others what I am working on" (on by default).

### 10.6 Standing watches on the hub

**What changes.** Note 11, Q5 (2026-11-18) ran watches only in attended runs until Phase 74. Owner decision 3 (2026-11-19) supersedes it for multi-user projects with a hub: a watch may run on the hub continuously under the hub's grant. Single-machine projects and multi-user projects without a hub keep the attended rule (`watchAttendance.ts`).

**Assignment.** `watch.assign` names the runner, `hub` (granted cells only) or `attended`, and optionally `fallback: attended` so a cut-off site keeps watching on its own machines.

**Guards that replace "attended runs only":**
1. **Draft only**: a hub watch reads its cell and writes `watch.match` and draft proposals (an INTREP, a revised assessment) as `actor: hub`. It cannot verdict as a person, submit, approve, reject or release; the fold refuses that as for any agent.
2. **No tools**: no shell, web, MCP or file writes. A fixed program: evaluate, match, one model call with a fixed prompt, propose.
3. **Rate limits**: match id = hash(watch id, sorted observation ids, window), identical on hub and edge, de-duplicated in a window; at most 4 drafts per hour per watch and 60 per hub by default; alerts digested per person.
4. **Spend cap**: a daily cap set by the operator; at the cap watches match and alert without drafting, and say so.
5. **Route by label**: drafting only through a provider the cell's Phase 70 route allows; a `local-only` cell needs a local model reachable from the hub, else alert only.
6. **Kill switch**, each immediate: the lead's signed `watch.killSwitch` pauses every hub watch in the project; any decision-role holder can pause one watch; the operator's file switch pauses all watches on the hub. Paused watches queue "missed while paused: N", never drop.
7. **Visible**: each hub watch run writes a `run.summary` (matches, drafts, model, spend).
8. **Phase 74 later**: a hub watch then runs under a person-signed run contract, with these guards as its floor.

### 10.7 Append checks

Per entry: header signature; writer in the roster, not revoked or quarantined at the hub's roster head; writer on the access list; `seq` next and `prev` matching (a second entry at a used `seq` is stored as an equivocation proof and the device refused until the lead acts); size and rate limits; for the roster stream, a lead device and `rosterPrev` at head. The hub cannot check bodies of ungranted cells; clients do.

### 10.8 A malicious hub

Clients keep every checkpoint and put the newest checkpoint hash in heartbeats and in the deps of their next entry, so a hub showing two clients different views is caught when either sees the other's entry. A hub can **withhold** (caught by deps and by comparing checkpoints over LAN or bundle: "the hub has not delivered N entries"), **delay** ("last confirmed by the hub 12 minutes ago"), **roll back**, honestly after a restore or not (refused by high-water marks; clients re-push), **fork its view** (two conflicting checkpoints are a proof; clients stop trusting its checkpoints until the lead re-admits it). It cannot forge or alter entries, and reads only the roster and granted cells.

### 10.9 Scaling, backup, restore

Targets per hub: 10 projects, 150 persons, 400 devices, 300 concurrent event streams, 50 entries per second, observation segments at feed rate. SQLite in WAL mode suffices; presence and observation head fan-out is batched per 100 ms. Beyond that, a hub per site and L5 federation.

Back up the SQLite store and blob folder on a schedule; keep the hub's secret files apart. Restoring an old backup is a rollback: clients refuse the shorter history and re-push. The runbook drill: restore, start, let clients refill, check the next checkpoint covers every client's heads. Losing the hub's keys means revoking it and admitting a new hub; held cells are rekeyed.

---

## 11. Shared agent work

### 11.1 What is shared

Runs stay on the machine that runs them. Shared is a summary, signed by that device: `run.start` (run, team, section, the person who started it, target), `run.lane` (member, working, waiting, done or failed, target), `run.claim` and `run.release`, `run.summary` (proposals, verdicts, register rows, spend, duration), `run.end`. These are design 10's `staff.*` events, now signed and folded everywhere; `events.jsonl` becomes a local projection. Transcripts, prompts, tool calls and chats stay per person; a person may attach a labelled run record to a product.

### 11.2 Claims and leases

Owner decision 1 turns one-writer-per-product into per-run coordination, not a cross-person lock.
- A **claim** names a target (a product section by heading anchor, a register row, a step board task), holder (person, device, run, member), purpose and lease (20 minutes, renewed every 5 while working).
- A run's lead member reads the folded claims before assigning work and skips targets others hold. Member tools: `claims.list`, `claims.take`.
- **Concurrent claims** on one target show "double-claimed". The fold suggests a holder by fold order; the other run's lead is told and yields (`run.release`), or the person who started it decides. Editing is never blocked; the CRDT keeps both contributions.
- A lease lapses when renewal is overdue by the lease plus the 10-minute skew allowance. A device back online renews an old claim only if nobody claimed the target since.
- Inside one run, the single-writer rule stays as the run lead's assignment of parts.
- Claims show on the step board and in the editor gutter ("J2 analyst agent on the J2 chief's machine is writing 'Enemy courses of action', claimed 14:02").

Example: the J2 chief's run claims "Adversary COAs" and "Threat overview"; the deputy's run, starting later, reads the claims and takes "Key terrain" and "Weather effects". Both write into the same live text and each person watches the other's agents in their sections. Had both been offline and claimed one section, both see "double-claimed" on reconnect; one yields, and if both kept writing the owner tidies the attributed text before proposing a version.

---

## 12. Observations sharing

- Segments (NDJSON per feed, channel and hour, `src/domain/staff/obs/store.ts`) become sealed blobs in their label cell, announced by `obs.segment` with feed, channel, hour, row count and a coarse area summary inside the sealed body.
- **Slices**: subscribe by cell, feed, area (bounding box or H3 cells) and time window, after Willow's areas. The hub filters by area only in cells it holds; elsewhere by feed and hour, and the client discards rows outside the area.
- **Coalescing**: high-rate positions are coalesced per track per link (latest per 5 seconds by default, first and last always kept, note 11, 4.6) into `obs.coalesced`; full history stays on the hub and the ingesting machine.
- **Limits**: per-link budgets (hub 2 MB/s, LAN 10 MB/s, bundle by size cap) and a per-device window (72 hours by default). Over budget, the source shows `degraded` with the reason; never silent dropping.
- **Ingest owner**: one machine or the hub per feed, named in feed settings; ingest is idempotent by `obs_id` anyway.

---

## 13. What stays per person

Chats, transcripts, prompts and tool calls (Phase 27 state); NEAR AI key, spend ledger, daily limit and model choices (SHRD-01 on shared hosts); device keys, high-water marks and session tokens (SecretStorage); personal files outside `.planning/staff/**`. Presence history is kept nowhere. Phase 27 sync is unchanged and still does not carry `.planning/staff/**`.

---

## 14. Migration from today's ledgers

1. **Opt in per project.** A project that never turns on multi-user behaves exactly as now, with Set Aside and Use This Branch's Ledger.
2. **Verify first.** Conversion verifies `products.jsonl`, `decisions.jsonl`, `calculator.jsonl` and the wargame ledger as today; a broken ledger stops it with today's wording and Set Aside.
3. **Import.** The lead's device writes one `project.import` per legacy file: legacy head hash, entry count, the SecretStorage head mark, and the whole file as a sealed blob. Legacy chains stay verifiable forever.
4. **Reconstruct.** Each product becomes a live text (author "imported", by the lead's device); each existing version becomes a version pinned to its original hash; approvals and releases keep their original signed entries inside the blob, shown as "approved on this machine before the project became multi-user, verified at import by the staff lead".
5. **Observations** may be imported by feed, as the lead chooses.
6. **Files become projections**: `.planning/staff/**` is rewritten from the fold; the header tamper check compares against folded state.
7. **Idempotent**: a re-run after interruption makes the same entries (ids from file hashes); nothing is deleted; legacy files move to `.planning/staff/legacy/`.
8. **Way back**: **Make a Single-Machine Copy** ships in drop A (owner decision 6): it folds the shared state into today's single-machine files, signed by this device, and leaves the shared project untouched.

---

## 15. State machines

Every transition below gets a test (section 17).

### 15.1 Membership

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | invited | `member.invite` | Lead |
| invited | join-requested | Valid join request (hub or file) | Invitee device |
| invited | expired / cancelled | Expiry passes / invite voided | Fold / lead |
| join-requested | active / refused | `member.admit` after the safety code / declined | Lead |
| active | active | `member.update` | Lead |
| active | removed | `member.remove` (rekey) | Lead |
| roster head | split | Two roster entries on one `rosterPrev` | Fold |
| split | chosen branch | `roster.choose` | Lead |

### 15.2 Device

| From | To | Trigger |
|---|---|---|
| (none) | active | `member.admit` or `device.add` |
| active | rotated | `device.rotate` (old key valid before the rotation point) |
| active | revoked | `device.revoke` (rekey) |
| active | quarantined | Equivocation proof seen |
| quarantined | active / revoked | `device.release` naming a branch / `device.revoke` |

### 15.3 Sync connection (per project per device)

| State | Meaning | Leaves to (trigger) |
|---|---|---|
| `single-machine` | Not multi-user | `connecting` (Make Multi-User, Join) |
| `connecting` | Opening TLS to hub or peer | `authenticating` (TLS up, pin matches); `offline` (unreachable after 10 s); `attention` (pin mismatch) |
| `authenticating` | Signed challenge | `catching-up` (session); `refused` (not in roster, revoked, quarantined) |
| `catching-up` | Exchanging what each lacks | `live` (heads equal); `offline` (link lost) |
| `live` | Pushing and receiving | `offline` (link lost); `attention` (rollback, hub equivocation, digest mismatch) |
| `offline` | Working locally; retries with back-off to 5 minutes; git and bundle usable | `connecting` (retry, network change, Sync Now) |
| `refused` | Hub does not accept this device; reason and person to ask shown | `connecting` after the lead acts |
| `attention` | A person must act | `connecting` after accepting a new pin the lead published, or after the lead re-admits the hub |

`offline` can last forever without harm; no state waits silently.

### 15.4 Product version

The working text is `open` or `withdrawn`. Each version:

| From | To | Trigger | Who | Guard |
|---|---|---|---|---|
| (none) | proposed | `version.propose` | Owner side, section lead | Snapshot equals text at the state vector |
| proposed | held | Guard `HOLD`, tradecraft `NOT READY` | Guard, tradecraft member | Pins this hash |
| proposed | guard-checked | Guard `CLEARED` (J2: tradecraft `SIGN-OFF` first) | Guard member | Pins this hash |
| held | (next version) | Owner proposes again | Owner side | New hash |
| guard-checked | awaiting-decision | `version.submit` | Owner side, section lead | Names `decision_for` |
| awaiting-decision | approved / rejected | Effective approve / reject with reasons | Role holder | 6.4 |
| awaiting-decision, approved | contested | Concurrent conflicting decision, or decision concurrent with withdraw | Fold | 6.4 |
| contested | approved, rejected, withdrawn | Fresh decision or withdrawal that saw all contested entries | Role holder (withdraw: owner side) | Saw every contested entry |
| approved | released | `version.release` | Role holder | Approval causally before; same hash |
| released | superseded | Newer version released | Role holder | Old kept read-only |
| any non-terminal | withdrawn | `version.withdraw` | Owner side, role holder | Reason |

Forbidden, each tested: agent approve, reject, release or supersede; approve without guard; release without approval; approval of another hash; proposal of text never in the document; a removed role's decision taking effect unconfirmed.

### 15.5 Decision on one version

| State | Leaves to |
|---|---|
| `none` | `effective` (one decision); `contested` (concurrent conflicting) |
| `effective` | `effective` (later decision that saw it); `contested` (late concurrent conflicting decision) |
| `contested` | `effective` (fresh decision that saw all) |
| `pending-confirmation` (role being withdrawn) | `effective` (current holder confirms); `none` (declined) |

### 15.6 Hub watch

| From | To | Trigger |
|---|---|---|
| (none) | proposed | Agent, hub or person drafts a watch |
| proposed | armed / rejected | Person approves naming the runner / rejects |
| armed | matched | Runner matches (deterministic id) |
| armed | paused | Kill switch; spend cap when drafting is needed; hub unreachable without fallback; source `degraded`; `attended` runner with nobody attending |
| paused | armed | Cause cleared; "missed while paused: N" queued |
| matched | drafting / awaiting-review | Drafting allowed / not allowed by route or cap (alert only) |
| drafting | awaiting-review | Draft proposed |
| awaiting-review | armed | Named person acknowledges |
| armed | expired | Latest time of value passes |
| armed, paused | disarmed | Person disarms |

### 15.7 Claim

| From | To | Trigger |
|---|---|---|
| (none) | held | `run.claim` |
| held | held | Renewal |
| held | double-claimed | Concurrent claim folded |
| double-claimed | held | Other holder releases or lapses |
| held, double-claimed | released / lapsed | `run.release` or `run.end` / renewal overdue by lease plus skew |

---

## 16. Threat model

| Threat | Mitigation | Residual |
|---|---|---|
| Network attacker reads or alters traffic | TLS 1.3, pinned hub and device certificates, sealed bodies | Timing and sizes |
| Malicious or compromised hub | Clients verify all; checkpoints catch rollback and forked views; ciphertext for ungranted cells | Can withhold until compared; reads roster and granted cells |
| Compromised member device | Per-writer blast radius; revoke and rekey; hub refuses revoked devices | Entries before revocation stand; offline machines learn late |
| Cloned device key | Equivocation proof, quarantine | A person must resolve it |
| Insider below a cell | Sender filter, cell keys, opaque ids, per-reader views | Clearances declared, not verified, before Phase 71 |
| Agent approves or impersonates a person | No key for agents; fold refuses person events from agents; approve only in UI | A person approving without reading |
| Forged attribution in text | Client ids registered per writer; foreign ids rejected | None known |
| Rogue git host or lost USB stick | Ciphertext, signatures, link ceilings | Metadata, availability |
| Removed member | Rekey | Keeps what they had |
| Replay | Idempotent by hash; seq and prev | None |
| Clock manipulation | Causal order, future-entry hold, renewals | Within the skew allowance |
| Hub watch misuse (cost, flood, exfiltration) | Draft only, no tools, limits, spend cap, route by label, kill switches | The allowed provider sees drafting prompts for granted cells |
| Hub server theft | Grant only needed cells; keys outside the state volume; revoke and rekey | Granted cells and roster exposed |
| Metadata analysis | Opaque ids, padding, fixed-interval flushes, presence opt-out | Activity patterns visible to the hub |
| Accreditation confusion | `LABELS_NOT_ACCREDITATION_TEXT` on every multi-user screen | Classified use needs your organization's accreditation of the whole kit |

---

## 17. Test plan

**Pure core (property tests, `node --test`).** Convergence: random entries from 2 to 5 writers, random order, duplicates and partitions, always the same state and digest. CRDT convergence with attribution under random concurrent person and agent edits. Forged attribution rejected. Proposal of text not at its state vector refused. Every row of 15.4 and 15.5, both contested cases and settling; nothing auto-picks under any order. Equivocation proof and quarantine whatever the arrival order. Roster split and choose; decisions at a roster hash without the role; rekey epochs. Claim double-claim, lapse, late renewal. Legacy import gives the same state twice; a tampered legacy ledger refuses.

**Scenarios (real processes, temp folders, a real hub).**
- Two persons co-edit live; one proposes v1; the guard clears; the other approves; same digest on both.
- Three persons: chief and deputy co-edit with claiming agent runs; the commander approves; a late joiner loads from a compaction.
- Contested: approve offline, reject online; both see `contested`; a fresh decision settles it.
- Partition: two sites cut off for a simulated day, editing and deciding; reconnect by bundle, then hub; same state.
- Transports: the same scenario over hub, LAN, git per-writer refs, bundle, and mixes; Phase 27 and Team Mode mirrors untouched.
- **Malicious hub harness** (the paused design's relay list): withhold, delay, replay, reorder, roll back, fork the view, inject a forged entry, corrupt a blob, refuse appends selectively, serve another project's stream. Each detected and named, or harmless.
- **Label leak on the wire**: two compartments, two persons each cleared for one; capture every byte each device and the hub receive; no plaintext and no stream of the other compartment reaches a device; the hub holds only ciphertext for ungranted cells (the paused design's P-16 indistinguishability test, on the wire).
- Hub watches: identical match ids on hub and edge; rate limits; spend cap; all three kill switches; route refusal for `local-only` without a local model; nothing beyond drafts written.
- Hub restore drill: old backup restored; clients refill it; no client accepts the shorter history.

**Extension.** Binding: interleaved local and remote edits without echo; undo only own edits; read-only header; outside change offered as Take or Restore. Presence and cursors appear, expire, respect opt-out. Every 15.3 state has wording, an accessible name and a test. A focused browser check only for the decision dialog's contested and "changed while deciding" paths (authorization contract).

**Hub service.** The relay's families: workspace isolation from the VSIX, health, redacting logger, no-leak run, state directory permissions, kill -9 drill, container hardening, required CI job.

---

## 18. Work packages

Style of design 10, section 9. WP-R0 lands first because every package imports its formats; then parallel worktrees from the same base and one integration per drop.

| WP | Scope | Worktree | Depends on | Tests |
|---|---|---|---|---|
| WP-R0 Contract | Entry v2, ids, causal order, fold skeleton, digest, equivocation, checkpoint format, version and decision rules (pure); `ReplicaTransport`; Yjs and `lib0` vendored behind the doc interface; CRDT spike (size, GC, update sizes for a 30-page product) | `feat/replica-contract` | None | Convergence, equivocation, decisions, versions, forged attribution; canonical vectors |
| WP-R1 Roster and keys | Genesis, roster with `rosterPrev`, invite and join files, safety code, X25519 binding, cells, wraps, grants, rekey, self-declared notice | `feat/replica-roster` | WP-R0 | Split and choose; expired, reused and wrong-secret invites; wraps open only for granted devices |
| WP-R2 Store and staff folds | Replica store, cross-window lock, high-water marks, blobs; product, decision, calculator and wargame ledgers as folds; events as projection; legacy import | `feat/replica-store` | WP-R0 | Migration fixtures; projection equals today's files; rollback refused |
| WP-HUB Hub service | `hub/` workspace, store, session and append checks, SSE, presence, checkpoints, invites, Compose service and profile, image, CI job, operator section | `feat/sync-hub` | WP-R0; WP-R1 at integration | Hub service tests; append checks; malicious-hub harness on the real hub |
| WP-LIVE Live layer | Hub transport, replicator, sync status, presence, editor binding with cursors and attribution, Staff Room presence, contested cards, offline banner, multi-user commands | `feat/staff-live` | WP-R0, R1, R2 | Two- and three-person scenarios over the hub; extension tests |
| Integration A | Merge R1, R2, HUB, LIVE; README and SECURITY sections; label leak test over the hub | `feat/staff-collab-a` | All above | Full suite once; UAT for two persons and a hub |
| WP-OFF Offline transports | Git per-writer refs, bundle export and import, LAN peer with pinned certificates and consent | `feat/replica-offline` | Drop A | Partitions; mirror isolation; mixed transports |
| WP-AGT Shared agent work | Run summaries, claims and leases, `claims.list` and `claims.take`, step board and gutter | `feat/staff-shared-runs` | Drop A | Claim machine; two runs on one product avoid each other |
| WP-OBS Observations | Segment blobs, slices, coalescing, budgets, ingest owner, hub retention | `feat/staff-obs-sync` | Drop A | Budgets and `degraded`; first and last kept; label leak with observations |
| WP-WATCH Hub watches | Runner assignment, hub runner with guards 1 to 8, kill switches, fallback, shared match ids | `feat/hub-watches` | Drop A, WP-OBS | Every 15.6 transition; guards; route refusal |
| Integration B | Merge OFF, AGT, OBS, WATCH; runbook section for watches | `feat/staff-collab-b` | Drop B | Full suite once; UAT for a cut-off site and the hub |

Dependencies, one line each: WP-R0 is the shared contract, so nothing runs beside it; WP-R1, WP-R2 and WP-HUB then run in parallel, and WP-LIVE starts on a fake transport and meets the real hub at integration; WP-WATCH waits for WP-OBS because watches read shared observations.

| Phase | Work packages | Ships in |
|---|---|---|
| 30 Replication contract and co-editing core | WP-R0 | Drop A (0.4.x) |
| 31 Staff roster, cell keys and migration | WP-R1, WP-R2 | Drop A |
| 32 Your organization's sync hub | WP-HUB | Drop A |
| 33 Live multi-user staff projects | WP-LIVE, Integration A | Drop A release |
| 34 Offline transports | WP-OFF | Drop B (0.4.x) |
| 35 Shared agent work, observations and hub watches | WP-AGT, WP-OBS, WP-WATCH, Integration B | Drop B release |
| Later | Credentials in the roster (Phase 71); status lists and offline age; hub-to-hub federation and checkpoints into L4 roots (L5); Team Mode onto this layer (L2) | v0.5.0 and later |

Phases 30 to 35 need nothing from Phases 71 to 74; Phase 70's labels (on `main`) give the cells.

Requirement ids (added to REQUIREMENTS.md when Phase 30 is planned):

| Id | Requirement | Phase |
|---|---|---|
| MUS-01 | Per-writer signed hash-chained logs, deterministic fold and state digest; equivocation proven and quarantined | 30 |
| MUS-02 | Product text co-edited through Yjs inside signed entries, with unforgeable attribution | 30 |
| MUS-03 | Versions pin a content hash; contested decisions need a fresh decision; agents never decide | 30 |
| MUS-04 | Genesis, linear single-writer roster, join by signed file with a safety code | 31 |
| MUS-05 | Per-cell keys wrapped to cleared devices; rekey on removal | 31 |
| MUS-06 | Verified, idempotent migration of today's ledgers; unchanged behaviour for projects that stay single-machine | 31 |
| MUS-07 | The hub as its own Compose service: append checks, live push, presence, checkpoints, invitations | 32 |
| MUS-08 | Malicious-hub detection, rollback refusal, ciphertext only for ungranted cells, operator backup and restore | 32 |
| MUS-09 | Live multi-user staff projects in the extension: editor binding, presence, sync states, contested UI, docs | 33 |
| MUS-10 | Git per-writer refs, sealed bundle files and LAN peer links, converging with the hub | 34 |
| MUS-11 | Shared run summaries and claims; observation slices with coalescing and budgets | 35 |
| MUS-12 | Standing watches on the hub under draft-only, rate, spend, route and kill-switch guards | 35 |

### 18.1 Team Mode (L2) on this layer

When L2 starts, Team Mode's log moves to one replica stream per team at the project base cell, per-writer logs instead of one compare-and-swap branch.

| Files | Fate |
|---|---|
| `canonical.ts`, `signedPayload.ts`, `keyStatus.ts`, `keyRecords.ts`, `secrets.ts`, `recentMap.ts`, `src/team/identity.ts`, `keyHistory.ts`, `runGit.ts`, `cleanRemote.ts`, `syncScheduler.ts` | Reused as is |
| `types.ts`, `validate.ts`, `permissions.ts`, `policy.ts` | Reused as entry kinds and fold checks |
| `materialize.ts` | Becomes a fold over the replica graph (same reducers) |
| `teamFile.ts`, `enable.ts`, `auditMirror.ts` | Reused with section 7's genesis and roster |
| `eventLog.ts`, `gitTransport.ts`, `transport.ts` | Replaced by the replicator and the per-writer git transport; the branch is retired after an import like section 14 |

---

## 19. UX

Plain words, one sentence per state, as the Phase 27 sync control and Staff Room do.

- **Turning on.** **Make This Staff Project Multi-User** (also a Staff Room button): "Where will this project sync?" with **Your organization's sync hub** (address and pin, or open the operator's invitation) or **No hub yet: git, room network or files only**. Then "You will be the staff lead. You decide who joins and what they may see." with the self-declared and not-accreditation sentences. Then "Checking this project's records... Ready: 41 products, 6 decisions, 2 registers. Nothing will be deleted." Then "This project is now shared. Invite people from the Staff Room."
- **Inviting.** Name, seat, decision roles, clearance. "Send this file to them: J5-lead.near-staff-invite. It works once and expires on 26 November." Then in the Staff Room: "The J5 lead wants to join. Compare this code with them: river lantern seven copper north field." **Admit** or **Decline**.
- **Presence.** Staff Room header: people with seat and a dot, green live or grey "last seen 14:02"; hover "Working on the intelligence estimate. Running 2 agents." Cursors with names in the editor; claimed sections in the gutter; who is on each step of the step board.
- **Contested.** Decision queue card: "Contested: the commander approved v5 and the deputy commander rejected it at the same time. Neither applies. A new decision is needed." Both reasons; **Approve v5**, **Reject v5**.
- **Other conflicts.** "Changed by two people at once: 'Due 1800' (J3) or 'Due 2000' (J5). Pick one." "Your run and the J5 lead's run both claimed 'Key terrain'. **Let Theirs Continue** or **Keep Mine**." "One of the J4's machines signed two different histories. Its new work is held until the staff lead looks at it."
- **Sync status.** In the Staff Room bar and status bar, from 15.3: "Live", "Catching up (37 entries)", "Offline: working on this computer. Last synced 14:02.", "Not accepted by the hub: ask the staff lead.", "Needs attention: the hub showed an older copy of this project." Each with one action (Sync Now, Show Details, Export for...).
- **Offline banner.** "You are offline. Your changes are kept here and will sync when the hub is back. Decisions you make now may become contested if someone else decides the same thing." Decisions since the last checkpoint show "not yet confirmed by the hub".

---

## 20. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Fold bug makes machines disagree | High | Pure fold, random-order property tests, digest on every head exchange |
| Editor binding loses or doubles edits under fast typing | High | Proven binding pattern; fuzz tests with random interleavings; resync from Yjs on detected mismatch |
| Yjs growth over long exercises | Medium | Compaction after checkpoints; measured in the WP-R0 spike; Loro fallback behind the interface |
| Hub as single point of failure | Medium | Offline edge; git, LAN and bundle; backup and restore drill |
| Hub compromise exposes granted cells and roster | High | Minimal grants with the trade-off stated; keys outside the state volume; revoke and rekey |
| Contested decisions frustrate people | Medium | Clear card; the local "changed while deciding" check makes the race rare online |
| Declared clearances taken as verified | High | Sentences on every screen; Phase 71 |
| Metadata leakage | Medium | Opaque ids, padding, fixed-interval flushes, presence opt-out |
| Listening ports and certificates on air-gapped LANs | Medium | Hub first; LAN optional with consent; key-pinned certificates |
| Hub watch spend or alert flood | Medium | Rate limits, spend cap, digests, kill switches |
| Pressure to co-edit code and arbitrary files | Medium | Scope held to staff products and registers |
| Staff, Phase 27 and Team Mode git mirrors lock each other | Low | Separate folders and locks; isolation test |

---

## 21. Owner decisions (2026-11-19)

The owner accepted these on 2026-11-19. They are decided, and they override anything else in this design that differs.

1. **Vendoring Yjs.** Yes. Yjs 13.6.33 and `lib0` are vendored into the bundle, pinned and hash-checked like MapLibre and milsymbol, recorded in SECURITY.md as the first vendored code in the extension host itself.
2. **Hub model credential.** A dedicated NEAR AI key of your organization for the hub, with its own daily spend cap set in the signed policy. Local models for `local-only` cells once the data platform host exists.
3. **Default hub grants.** None. The staff lead grants the hub each cell, with the trade-off sentence shown.
4. **Edits during review.** Show "N changes since v5". After about 20 changes, prompt the product's owner to propose a new version. Never withdraw automatically.
5. **Lost staff lead before Phase 71.** The roster names a deputy lead who can also sign membership changes, so losing one lead is not fatal. Re-founding by export and import stays as the last resort.
6. **Way back to single-machine.** **Make a Single-Machine Copy** ships in drop A, so there is always a safe exit.
7. **Release vehicle.** Yes: two staff collaboration drops in 0.4.x (Phases 30 to 33, then 34 and 35).

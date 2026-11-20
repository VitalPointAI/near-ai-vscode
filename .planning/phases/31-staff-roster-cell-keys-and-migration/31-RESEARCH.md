# Phase 31: Staff roster, cell keys and migration - Research

**Researched:** 2026-11-19
**Domain:** pure replica core extension (roster fold, epoch keys and wraps, invite files), Phase 30 hardening, replica store on disk, ledger migration
**Confidence:** HIGH for what the code does today (read and run this session); MEDIUM for the proposed designs (marked `[ASSUMED]` where they are choices, not facts)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Phase 30 hardening (first plans of the phase)**
- **D-01:** The first plan(s) of Phase 31 fix these Phase 30 findings, each verified against the code on `main` before it is changed and each with a regression test that fails on the old code:
  - (a) One held or refused `doc.update` in a product's covered history makes every later honest compaction `compact-mismatch` (`src/domain/replica/textFold.ts` about lines 198 to 211; WR-04). Fix: build the scratch document from the accepted updates inside the covered set and ignore covered entries the fold did not accept, as long as the state vector and text hash still match; keep the refusal only when an accepted update is missing.
  - (b) A fork with three or more branches cannot be resolved unless the lead picks one of the two lowest hashes (`src/domain/replica/equivocation.ts` about lines 96 to 110; WR-03). Fix: carry every branch hash of the slot in the in-memory proof (not the wire form) and accept a `device.release` choice of any of them; test with three and four branches.
  - (c) The same entry re-delivered as a new object is fully re-verified (signature and AES-GCM open) and `seen` and `chosen` grow without bound (`src/domain/replica/fold.ts` about line 150, `ingest` and `addEntries`; WR-08). Fix: key duplicates by entry hash after a cheap header-shape parse and `entryHash`, skip an entry already chosen as verified with the same hash before `verifyEntry`, keep at most one held copy per hash and reason, and drop unreadable inputs after counting them.
  - (d) Reducer-stage holds (`missing-blob`, `missing-key`, `unregistered-client`, `updates-missing`) are retried only when a new context object is passed (`fold.ts` about line 415, the CR-03 fix). Fix: the fold records which reducer-stage holds are waiting and what they wait for, and `addEntries` re-tries them when the same context can now answer (a blob or key lookup that now succeeds, a registration or update that has now arrived) without requiring a new context object and without a full refold when nothing changed; incremental and from-scratch folds stay equal (the CR-02 and CR-03 property tests are extended, not weakened).
- **D-02:** The remaining review warnings are fixed in the same early wave: WR-01 (gate verdicts only from a member allowed to run that agent seat, via a roster predicate that defaults to deny), WR-02 (governance acts in `projectFold.ts` refuse a non-person actor; an agent's `member` in a `doc.client` registration must be a seat that member's roster entry allows), WR-05 (memoise the accepted-prefix scratch document per product, share one `inspectSnapshot`, cap compactions and proposals per product and writer, refuse `too-many`), WR-06 (cap acts per writer per version, refuse `too-many-acts`; one topological pass instead of the repeated fixpoint; lamport bound before building ancestor sets), WR-07 (see D-05), WR-08 (see D-01 (c); also cap registrations per writer per product and products per stream, refuse `too-many-products`, create the Yjs document lazily on the first accepted update), WR-09 (hold only the act that names an unknown id, not acts that merely saw a held act). The info items IN-01..IN-03 are taken where cheap: IN-02 delete `updateClients`, IN-03 explicit numeric rank, IN-01 keep the cycle guard as an assertion that throws in tests. (Owner decision 4 of 2026-11-19.)
- **D-03:** Client id bound to its writer through the signed roster (owner decision 1 of 2026-11-19). No admitted writer can take another writer's attribution by registering a client id first. The binding is derived, not chosen by the registrant: a Yjs client id a device may use is fixed by the roster (for example a deterministic function of the writer id, product and a per-device counter recorded in the roster or derived from it), so a `doc.client` registration naming a client id outside the writer's derived space is refused `foreign-client-id`, and a race between two writers for one id is impossible. Research picks the derivation (it must fit Yjs's 32-bit client id and keep collisions between writers impossible, not merely unlikely, within one product) and how a Phase 30 registration is read under the new rule.
- **D-04:** Late joiners (owner decision 2 of 2026-11-19): a writer's log may start from a signed checkpoint that records each writer's head. The checkpoint format gains, per writer head per stream, the head `seq`, the head entry hash and the head `lamport`, plus whatever research finds the fold needs to order a joiner's later entries after the checkpoint prefix without the prefix's entries (for example the per-stream `orderTip` and `count` already in D-36 of Phase 30). This is added now, before Phase 32 signs checkpoints. The chain check accepts a chain that starts at `seq = head.seq + 1` with `prev = head hash` when a verified checkpoint covers that head; text loaded only from a compaction without its covered updates is shown as "author not yet checked" (Phase 33 shows it; Phase 31 keeps the `unverified` flag from CR-01). A checkpoint signer is admitted only through the roster (`hub.admit` or a member the roster names as checkpoint signer).
- **D-05:** Update size before decode (owner decision 3 of 2026-11-19): an inline `doc.update` or `doc.compact` above a byte limit is refused before Yjs decodes it, and the struct count of each client group is read from the leading varuints and refused above `MAX_STRUCTS` before `decodeUpdate` (WR-07). Research sets the byte limit from the Phase 30 CRDT spike numbers (30-CRDT-SPIKE.md) with headroom for a 30-page product, lower than today's 4 MiB if the numbers allow. Decoding of updates arriving from outside the machine happens in a memory-capped worker (`node:worker_threads` with `resourceLimits`), which the replica store (D-27) runs before the entry reaches the fold; the pure fold keeps its synchronous checks (byte limit, pre-decode struct count) as a second line. `deletesCovered` becomes a linear merge walk. The 4 MiB hostile-update probe (about 1.16 GB) becomes a regression test that must stay under a stated heap ceiling.

**Roster and genesis (MUS-04)**
- **D-06:** All new pure code lives in `src/domain/replica/` (no `vscode`, no I/O beyond `node:crypto`), extending the Phase 30 import boundary test. Host code (SecretStorage, files, commands, locks, worker) lives in a new `src/staff/replica/` folder (implied; planner may name it), imported only from staff host code.
- **D-07:** `project.genesis` is written by **Make This Staff Project Multi-User** and signed by the person who runs it, who becomes the staff lead. It names the project id, profile, level, label map hash, the lead's member and device (Ed25519 and X25519 public keys), the first cells and their grants, and the hub's key and certificate pin if any (none in Phase 31; Phase 32 adds `hub.admit`). Every machine pins the genesis hash on join, as Team Mode's `GenesisAnchor` and `src/team/teamFile.ts` trust pin do.
- **D-08:** The roster is a single stream at the project base cell, written only by the devices of the staff lead and the deputy lead; every roster entry cites `rosterPrev`. The roster fold is a pure function that produces the real `RosterView` (the interface in `src/domain/replica/rosterView.ts`, extended where hardening needs it: `canRunAgent(member, seat, rosterHash)`, `clientIdOwner`, `deviceEncryptionKey`, `cellGrantees`, `isCheckpointSigner`). `staticRosterView` stays for tests.
- **D-09:** Two roster entries on one `rosterPrev` split the roster: both branches pending, the common prefix applies, nothing on either branch applies until `roster.choose` names one branch. Who may choose: the lead, or the deputy when the lead's devices are revoked or the lead has handed over (DESIGN 7.1). The Staff Room text is "The roster was changed in two places at once. The lead or the deputy must choose." (shown by Phase 33; Phase 31 exposes it as fold output and in the command that writes `roster.choose`).
- **D-10:** `lead.handover` names a new lead; the lead signs it, or the deputy signs it when the lead is lost. `deputy.name` is written by the lead. The deputy can write every roster entry the lead can, except `deputy.name` (owner decision 5). If both are lost, re-founding by export and import into a new genesis stays the last resort (not built here).
- **D-11:** Authority is evaluated at the roster hash an entry cites (the Matrix lesson); a later roster change never rejects an entry already authorised at its cited roster. An entry citing a roster hash on a branch of a split that was not chosen is held `roster-branch-not-chosen` and kept, never silently applied; this answers the open question in 30-REVIEW-FIX.md. (implied)
- **D-12:** Roles: staff lead, deputy lead, member, decision roles (`decision_for:<role>`), section roles already in `ROSTER_ROLE_PATTERNS`, observer (reads, writes only presence), hub (service member, defined here, used in Phase 32). Agent seats: a member's roster entry lists the agent seats that member's devices may run (for the release guard and tradecraft reviewer, WR-01); agents act under the device of the person who ran them and are never roster members.
- **D-13:** Clearances are self-declared by the lead before Phase 71. Every multi-user screen and command result shows `CLEARANCE_SELF_ASSERTED_TEXT` and `LABELS_NOT_ACCREDITATION_TEXT` (`src/domain/gate/labels.ts`) and "People and clearances in this project are declared by the staff lead, not verified."

**Joining by file (MUS-04)**
- **D-14:** Invite: the lead runs **Invite to Staff Project**, picks name, seat, roles and clearance; the extension writes `member.invite` (invite id, proposed name, seat, roles, clearance, expiry, sha256 of the one-time join secret) and a `.near-staff-invite` file signed by the lead's device carrying the genesis (or its hash and the lead key), project name, invite id, hub address and pin if any, the join secret, and the expiry (default 7 days).
- **D-15:** Join: **Join Staff Project** reads the file, checks the lead's signature against the genesis inside, pins the genesis, creates or reuses this install's device identity (`src/team/identity.ts`) and X25519 key, and writes a join request file signed by the device: invite id, Ed25519 and X25519 public keys, the person's name, and an HMAC-SHA256 under the join secret. Phase 31 is file only; posting to the hub is Phase 32.
- **D-16:** Safety code: six words derived from both device keys (lead's and joiner's) and the invite id, shown on both screens, compared by voice or in person; research picks the word list (a public-domain list with a licence fit for a public repo, committed and hash-checked) and the derivation. **Admit** writes `member.admit` (person, seat, roles, clearance, first device with both keys) and the first cell grants, and is refused unless the lead confirms the code matched.
- **D-17:** Invitations are single use, expire, and can be voided (`member.invite` voided by a roster entry). A join request with an expired, voided or already used invite, or a wrong secret MAC, is refused with a plain message; each has a named test.
- **D-18:** A person's second machine joins through **Add My Other Machine**: a short invite from the lead that admits a device for an existing member (`device.add`). (implied by DESIGN 7.4; Replace My Device is L2.)

**Device keys**
- **D-19:** Signing uses the Phase 69 Ed25519 device identity in SecretStorage. Encryption uses a new X25519 key per device, generated with `node:crypto`, kept in SecretStorage next to the signing key, and bound in the roster by the Ed25519 signature of the roster entry that admits or adds the device. One identity per person per install. Key handling is documented in SECURITY.md in the plan that adds it. Never write private keys to the project folder, logs or bundle files.
- **D-20:** `device.rotate` (old key valid before the rotation point), `device.revoke` (rekey), `device.quarantine` and `device.release` follow DESIGN 15.2; `device.release` names a branch (D-01 (b) applies).

**Cells and keys (MUS-05)**
- **D-21:** A cell is a label cell from Phase 70 (`src/domain/gate/labels.ts`). An epoch key is 32 random bytes per cell per epoch. A wrap is X25519 agreement with a fresh ephemeral key, HKDF-SHA256 with info binding cell id, epoch and device id, and AES-256-GCM over the epoch key (about 100 bytes per device), shaped like HPKE base mode so a standard library later is a format version.
- **D-22:** Wraps for one cell travel in a `cell.grant` (or the grant part of `cell.create` and `cell.rekey`) signed by the lead or deputy and delivered only to devices cleared for that cell. A device is cleared when its member's declared clearance at the current roster dominates the cell (Phase 70 dominance). Members never see grants for other cells; the roster fold exposes grantees per cell for the store and later the hub.
- **D-23:** Removing a member, revoking a device or lowering a clearance writes `cell.rekey` for each affected cell: a new epoch key wrapped to the remaining cleared devices. The removed device keeps what it had. The lead is told, in the command result and the confirmation: "They keep what they already received. They will not receive anything new."
- **D-24:** The key ring the fold uses (`KeyRing` in `rosterView.ts`) is built on each device by opening the wraps addressed to it with its X25519 private key; opened epoch keys live in SecretStorage, never on disk in clear.
- **D-25:** Write up, never down: an entry in a higher cell may cite lower-cell objects; the reverse is dropped by the fold and logged (DESIGN 8.1 rule 4). Views per reader: a machine folds only the streams it holds keys for.
- **D-26:** Link ceilings, ciphertext on git and bundle files are Phase 34; the hub's access list is Phase 32. Phase 31 provides what they will read (grantees per cell).

**Store and staff folds (MUS-06, WP-R2)**
- **D-27:** The replica store keeps entries and sealed blobs under the project in a folder the design names for the shared state (research confirms the path, for example `.planning/staff/replica/`), one append-only file per writer per stream plus content-addressed blobs, written atomically. A cross-window lock (the pattern of `src/staff/registerLock.ts`) serialises writers in one install. High-water marks (the highest seq seen per writer per stream, and the roster head) live in SecretStorage so a rolled-back folder is detected and refused (rollback refused).
- **D-28:** Today's product, decision, calculator and wargame ledgers become folds over the replica for a multi-user project: the same reducers and read models (`src/domain/staff/ledger.ts`, `products.ts`, `personDecisions.ts`, `wargame.ts`, `readModels.ts`), fed from the fold instead of the single-chain file. Events become a projection. Tests prove the projection of a migrated project equals today's files for the same history.

**Migration (MUS-06)**
- **D-29:** Opt in per project. A project that never turns on multi-user behaves exactly as now, including Set Aside and Use This Branch's Ledger; a regression test runs today's single-machine staff tests unchanged and asserts no replica folder, no new SecretStorage keys and no changed file is created for such a project.
- **D-30:** Verify first: conversion verifies `products.jsonl`, `decisions.jsonl`, `calculator.jsonl` and the wargame ledger as today; a broken ledger stops conversion with today's wording and offers Set Aside.
- **D-31:** Import: the lead's device writes one `project.import` per legacy file carrying the legacy head hash, the entry count, the SecretStorage head mark, and the whole file as a sealed blob. Legacy chains stay verifiable forever (a test re-verifies each imported blob with today's verifier).
- **D-32:** Reconstruct: each product becomes a live text (author "imported", by the lead's device); each existing version becomes a version pinned to its original hash; approvals and releases keep their original signed entries inside the blob and are shown as "approved on this machine before the project became multi-user, verified at import by the staff lead". Observations are not imported in Phase 31 (observation sync is Phase 35; the lead's choice by feed is offered then). (implied)
- **D-33:** Files become projections: `.planning/staff/**` is rewritten from the fold, and the header tamper check compares against folded state. Legacy files move to `.planning/staff/legacy/`; nothing is deleted.
- **D-34:** Idempotent: a re-run after interruption makes the same entries (ids derived from file hashes) and reaches the same state; a test interrupts conversion at every step and re-runs it.
- **D-35:** Make a Single-Machine Copy (owner decision 6): folds the shared state into today's single-machine files (`products.jsonl`, `decisions.jsonl`, `calculator.jsonl`, wargame ledger) in a new folder or project copy, signed by this device with today's single-chain signer, and leaves the shared project untouched. The copy's ledgers verify with today's verifier. Contested decisions are carried as "contested at copy time" rather than resolved (implied; nothing picks for a person).

**UX, gating and docs**
- **D-36:** Drop A releases after Phase 33. Phase 31's commands (Make This Staff Project Multi-User, Invite to Staff Project, Join Staff Project, Admit, Remove from Staff Project, Add My Other Machine, Choose Roster Branch, Make a Single-Machine Copy) are registered but shown only when a preview setting (for example `nearAi.staff.multiUserPreview`, default off) is on, so a 0.4.x patch released between Phase 31 and Phase 33 changes nothing for anyone who did not turn it on. Phase 33 removes the gate. (implied; owner may change at review)
- **D-37:** Plain words, no em-dashes, "your organization", no git knowledge required: invite and join are files the person sends however they like. Every refusal says what happened and what to do next.
- **D-38:** SECURITY.md gets sections for X25519 device keys, cell epoch keys and wraps, join secrets and invitations, the self-declared clearance notice, the decode worker and update size limits, and the replica store with rollback detection, in the plans that add each.

**Tests and process**
- **D-39:** Tests are `node:test` files under `src/test/` (`replica*.test.ts` for pure code, `staffReplica*.test.ts` or similar for host code). Every transition in DESIGN 15.1 and 15.2 has a named test; property tests use the Phase 30 seeded generator and bounded case counts. Phase 30 canonical vectors stay byte-identical unless a decision here changes a format (D-04 checkpoint heads), in which case the vectors file gets a new version and the old vectors still verify.
- **D-40:** Verification cadence: run the touched test files per task; the full suite once at the end of the phase. Every test command in plans and verify steps is wrapped as `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 <cmd>`; the full suite uses `MemoryMax=6G` and `timeout 1800` under `flock "${HEAVY_LOCK:-/home/aaron/.cache/claude-code-tmp/claude-1000/-home-aaron-projects-codequity-near-ai-vscode/3d22e8c9-071a-44b3-b6fc-358cc97299ea/scratchpad/heavy.lock}"`. Never delete, skip or weaken a test. Execution branches are named `feat/...`.

### Claude's Discretion
- Module split inside `src/domain/replica/` and the host folder name; type names.
- The client id derivation (D-03), the safety-code word list and derivation (D-16), the byte limit value (D-05), the store path and file layout (D-27), within the stated properties.
- Whether hardening is one plan or several parallel plans, as long as the files they change do not overlap within a wave.

### Deferred Ideas (OUT OF SCOPE)
- Hub service, hub invitations, checkpoint signing and serving: Phase 32. Live layer, sync status, contested cards, multi-user README: Phase 33. Git, bundle and LAN transports and link ceilings: Phase 34. Observation import by feed, shared runs and claims, hub watches: Phase 35.
- Replace My Device and Team Mode on this layer: L2. Credentials in the roster: Phase 71. Re-founding after losing both leads: last resort, not built.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MUS-04 | Genesis, linear single-writer roster, join by signed file with a safety code | Sections "Roster fold design", "Invite, join, safety code", "D-03 client ids", "D-04 checkpoint heads"; schema gaps listed in "Roster schema changes" |
| MUS-05 | Per-cell keys wrapped to cleared devices; rekey on removal | Section "Cell keys, wraps and grants" (node:crypto APIs run this session), key storage pattern, rekey rules |
| MUS-06 | Verified, idempotent migration of today's ledgers; unchanged behaviour for projects that stay single-machine | Sections "Replica store", "Migration", "Make a Single-Machine Copy", "Preview gate and commands", parity test pattern |
</phase_requirements>

## Summary

Phase 31 is two jobs that meet late. The first is a hardening wave on the Phase 30 core. I re-checked every finding the planner asked about against this checkout and ran four of them against the compiled code: (a) WR-04 is real (an honest compaction was refused `compact-mismatch` because a refused `foreign-client` update sat in its past), (c) is real (2001 re-delivered copies were all re-verified and `seen` grew by 2001), (d) is real for `missing-blob` and `missing-key` (the same context object that can now answer is ignored: `addEntries` returned the identical state while a from-scratch fold applied the compaction), and (b) is real by code reading. The line numbers in 30-REVIEW.md have drifted after the CR fixes; this document gives current ones. One correction matters for planning: the "4 MiB hostile update about 1.16 GB" figure did not reproduce here. A 4 MB update of 2,000,000 GC structs cost 211 MB of heap and 367 MB RSS through `inspectUpdate`, and a 4.18 MB update of 600,000 text items cost 146 MB. The regression test should be built from a measured probe, not from the 1.16 GB number.

The second job is the new work: a roster fold that turns the signed, linear roster stream into the real `RosterView`; epoch keys wrapped per device with X25519, HKDF and AES-GCM (all verified to work with `node:crypto` here, a wrap is 92 bytes); invite and join files with a six-word safety code from the BIP-39 English list (2048 words, MIT stated in the BIP header, committed and hash-checked); a replica store on disk with a cross-window lock and SecretStorage marks; and the migration and Single-Machine Copy. The hard design points are: (1) the roster stream is itself sealed under the base cell key, so grants cannot be roster entries (they would be circular, and members must never see other cells' grants); the recommended resolution is that a grant is a signed object outside the entry streams, committed to by hash from the roster entry; (2) `registerLock.ts` is an in-process promise chain, not a cross-window lock, so D-27 must use `withFileLock` from `src/services/stateMirrorLock.ts` for the cross-window part; (3) only the product ledger has a SecretStorage head mark today, and the wargame ledger is unsigned and unchained, so "legacy head hash" means different things per ledger; (4) a Single-Machine Copy cannot re-sign other people's approvals as those people.

**Primary recommendation:** Execute in this order: one tiny interface plan (extend `RosterView`, `staticRosterView`, the test world helper), then five parallel hardening plans with disjoint files, then the fold-and-checkpoint plans that need `fold.ts` and `chain.ts`, then WP-R1 (pure roster, keys, invite files: new files only) and WP-R2 (store, worker, migration adapters) in parallel, then one integration wave (commands, parity test, copy, SECURITY.md). Use `node:crypto` for everything cryptographic, reuse `signPayload`, `withFileLock`, `writeIfUnchanged` and the `identity.ts` SecretStorage pattern, and add no npm package.

## Project Constraints (from CLAUDE.md)

No `CLAUDE.md` exists in the worktree root or in `.claude/` (checked; `.claude/` holds only `commands/`). The global `~/.claude/CLAUDE.md` and memory index apply:
- Never touch `~/.near-credentials`; never run tests uncapped; one heavy run at a time (cap test memory memory: `systemd-run MemoryMax` + `choom -n 1000` + `timeout`).
- Say "your organization" in all user-facing text (organization naming memory: NEAR AI is only the model provider); no em-dashes in user-facing text (D-37).
- Verification cadence: smallest relevant tests per task, full suite once at the phase boundary; never delete, skip or weaken a failing test. Security, authorization, data integrity, migrations and architectural boundary checks are immediately blocking.
- Work in parallel by default; give parallel plans separate worktrees; ask before deleting anything. Migration moves legacy files to `.planning/staff/legacy/` and deletes nothing (D-33).
- Research before building something unfamiliar: sources drawn on are cited below (Yjs and lib0 source in `node_modules`, BIP-39, Node docs behaviour verified by running code).
- Drop A release process: protected `main`, squash PRs, agent-review gate (release-process and dev-workflow memories). Execution branches `feat/...` (D-40).

## Architectural Responsibility Map

This is an extension-host project (no browser, SSR or CDN tier). The tiers that exist are mapped instead:

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Roster fold, genesis, split/choose, membership and device state machines | Pure domain (`src/domain/replica/`) | Hub reads the same module in Phase 32 | Must be deterministic, no I/O, hub-compilable (so listed in `HUB_SIDE` of `replicaBoundaries.test.ts` if it imports only hub-side files) |
| Wrap, unwrap, grant objects, safety code, invite and join file formats | Pure domain | Host (key storage only) | `node:crypto` only; private keys are passed in, never read here |
| Client id slot binding | Pure domain (`RosterView.clientIdOwner`) | `textFold.ts` enforces | Authority is the roster; the fold only asks |
| Pre-decode struct skim and byte limits | Pure domain (`doc.ts`, new `updateGuard.ts`) | Decode worker (host) as second line | Fold must be safe alone (D-05) |
| Decode worker | Host (`src/staff/replica/`) | Pure skim | `node:worker_threads` is host-only |
| Store, lock, blobs, SecretStorage marks, rollback refusal | Host (`src/staff/replica/`) | `withFileLock`, `identity.ts` patterns | File and secret I/O |
| Key ring (opened epoch keys) | Host (SecretStorage plus memory) | Pure `KeyRing` closure | Private key never leaves host |
| Legacy ledger verify, import entries, projection adapters | Pure domain adapters (`src/domain/staff/` or `replica/`) | Host reads files | Same verifiers as today, no new trust rules |
| Commands, dialogs, preview gate | Extension (`src/services/`, `package.json`) | Host | `vscode` imports allowed only here |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | Node v24.22.3 here (extension host Node varies) | X25519 (`generateKeyPairSync('x25519')`, `diffieHellman`), `hkdfSync`, AES-256-GCM, Ed25519, HMAC, sha256 | Already used for every signature in the repo; zero new code to trust [VERIFIED: ran `wrap.cjs` this session: 92-byte wrap round-trips, wrong info and wrong device both fail authentication, an all-zero public key is rejected by `diffieHellman`] |
| `node:worker_threads` | built in | Memory-capped decode worker | `resourceLimits` turns an out-of-memory into `ERR_WORKER_OUT_OF_MEMORY` and the main thread survives [VERIFIED: ran `worker.cjs` and `worker2.cjs` this session] |
| `node:test` + `node:assert/strict` | built in | Tests | Repo standard; run via `scripts/run-tests.mjs` |
| Vendored Yjs 13.6.33 + lib0 0.2.119 | already vendored | Text CRDT | Existing; `vendor/yjs/yjs.cjs` is built by `node scripts/vendor-libs.mjs` and is git-ignored [VERIFIED: `.gitignore` line `vendor/`, `package.json` pins] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `signPayload` / `verifyPayload` (`src/domain/team/signedPayload.ts`) | in repo | Invite file, join request, grants, marks | One signer for every signed non-event item; new purposes are added to `PAYLOAD_PURPOSES` |
| `withFileLock` (`src/services/stateMirrorLock.ts:190`) | in repo | Cross-process lock | The store lock and the key-creation lock |
| `writeIfUnchanged`, `readWhole` (`src/staff/staffFiles.ts`) | in repo | Atomic write, whole-read | Projections written into `.planning/staff/**` |
| `loadOrCreateDeviceIdentity` (`src/team/identity.ts:176`) | in repo | Ed25519 identity under `identity-create.lock` | Same lock guards creation of the X25519 key |
| BIP-39 English word list | committed data, 2048 words | Safety code | See "Safety code" |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| BIP-39 English (2048 words, 66 bits in 6 words) | EFF short list 2.0 (1296 words, 62 bits, unique 3-letter prefix) | EFF list is CC BY 3.0 (attribution required) per training knowledge, and the EFF page fetched this session did not state a licence [ASSUMED]; BIP-39's BIP header states "License: MIT" [VERIFIED: raw.githubusercontent.com/bitcoin/bips/master/bip-0039.mediawiki header fetched this session] |
| Grants as signed objects outside the streams | Grants as roster entries | Entries are sealed under the base key, so other cells' grants would be visible to every member and the base key would be needed to read the grant that delivers the base key (circular) |
| One worker per call | One long-lived worker with restart on failure | Worker start was 35 to 56 ms here including loading Yjs; a single reused worker restarted after any error is cheaper and enough |

**Installation:** none. No package is added.

**Version verification:** no new package. `npm view` is not applicable; the Yjs pins are the existing exact devDependencies `yjs` 13.6.33 and `lib0` 0.2.119 [VERIFIED: `package.json` devDependencies; `scripts/crdt-vendor.json`].

## Package Legitimacy Audit

No external package is installed by this phase, so the legitimacy seam was not run and there is nothing to approve, flag or remove. The BIP-39 word list is committed data, not a package; it is pinned by a SHA-256 in a test (file fetched this session: 2048 lines, sha256 `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`, all first four letters distinct).

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
 Make Multi-User (lead)                         Invite file (.near-staff-invite, signed by lead)
        |                                                    |
        v                                                    v
 verify 4 legacy ledgers ---> project.genesis ----->  Join (joiner machine)
 (as today, D-30)             (roster stream =           pin genesis hash + lead key
        |                      project id)               make device keys (Ed25519 + X25519)
        v                          |                     join request file (HMAC with secret)
 project.import x4 (blob)          |                              |
        |                          v                              v
        |                 ROSTER FOLD (pure)  <---- roster entries (sealed under base epoch key)
        |                 verify with progressive          ^
        |                 view; rosterPrev line;           | lead compares six-word code,
        |                 split / choose                   | writes member.admit + grants
        |                          |
        |                          v
        |                 RosterView (real) -----------> ReplicaContext { roster, keys, blobs, now }
        |                          |                              |
        v                          v                              v
 REPLICA STORE (host) --> entries per writer per stream --> fold.ts (foldEntries / addEntries)
  lock, atomic append,     blobs, grants/                    reducers: text, project, versions,
  SecretStorage marks      decode worker (hostile bytes)     integrity (+ roster report)
  rollback refused                                                   |
                                                                     v
                                          families -> ledger projections (.planning/staff/**) + Staff host
                                          fold -> Make a Single-Machine Copy -> today's 4 ledger files
```

### Recommended Project Structure
```
src/domain/replica/
├── roster.ts            # pure roster fold: foldRoster(entries, anchor, keys) -> RosterState + view()   (hub-side candidate)
├── rosterOps.ts         # per-kind apply rules, authority, invariants (split out to keep files small)
├── cellKeys.ts          # epoch key, wrap, unwrap, grant object build and verify (node:crypto only)
├── invite.ts            # invite file, join request, MAC, admission checks (pure)
├── safetyCode.ts        # six words from keys + invite id; word list lives in safetyWords.ts
├── safetyWords.ts       # 2048 BIP-39 words as data (sha256 pinned in a test)
├── clientIds.ts         # slot and counter derivation helpers (pure)
├── updateGuard.ts       # pre-decode skim of a Yjs v1 update and snapshot, byte limits (pure, no Yjs)
├── holdWaits.ts         # what a reducer-stage hold waits for (blob, key, entry) (pure)
└── (existing files extended)
src/staff/replica/       # host code, imported only by staff host code and commands
├── store.ts             # append-only files, blobs, grants, atomic write, marks, rollback refusal
├── marks.ts             # SecretStorage high-water marks (signed, purpose staff-replica-mark)
├── keyring.ts           # x25519 key in SecretStorage, opened epoch keys, KeyRing closure
├── decodeWorker.ts      # the worker body (compiled to dist/staff/replica/decodeWorker.js)
├── decodeHost.ts        # starts the worker, resourceLimits, timeout, restart
├── migrate.ts           # verify, import, reconstruct, idempotent steps
├── projection.ts        # fold -> LedgerReplay / ProductState adapter, files written as projections
└── singleCopy.ts        # fold -> today's four ledger files
src/services/staffMultiUserCommands.ts   # registered behind the preview setting
```

### Pattern 1: Two-pass roster fold (avoids the circularity)
**What:** The roster stream is folded first, alone, by a pure function, from the roster-stream entries plus a bootstrap anchor (pinned genesis hash and the lead's keys) and the base cell's epoch keys. Its output is a `RosterView`. That view is then placed in `ReplicaContext.roster` for the main fold of every stream. The main fold keeps roster entries as `kept` or applies a thin report-only reducer, so there is no mutual dependency.
**When to use:** always for production; `staticRosterView` stays for tests.
**Why it works with the code as written:** `verifyEntry` only asks the view for `deviceKey`, `hasRoster`, `isAdmitted` [VERIFIED: `src/domain/replica/verify.ts:87,124,126`]. The roster fold calls `verifyEntry` with a progressive view (devices known so far), applies an entry only when its signer is a lead or deputy device at `rosterPrev`, and repeats until no entry can be added. A roster change makes a new `ReplicaContext` object; `addEntries` treats a new object as a full refold (CR-03 behaviour, `fold.ts:423-447`), which is acceptable because roster entries are rare. Callers must keep passing the same context object while the roster has not changed.
**Anchor and position 0:** an entry's `body.roster` must satisfy `hasRoster` or it is held `missing-roster` (`verify.ts:124`), and `projectFold.ts:77` requires `hasRole(entry.member, 'staff_lead', entry.body.roster)` for the genesis. So define roster position 0 as the origin roster whose hash is 64 zeros (`GENESIS_PREV`, `entry.ts:21`), containing only the lead named by the pinned anchor (member, writer, public key) with roles `staff_lead` and `member`. The genesis entry cites that origin hash; applying the genesis makes position 1 (hash = genesis entry hash); every later roster entry cites `rosterPrev` = the previous roster entry hash and that same hash as `body.roster`. [ASSUMED: this is a design choice; nothing in Phase 30 fixes it]

### Pattern 2: Grants are signed objects, not entries
**What:** A grant for cell C at epoch E is `signPayload(leadDevice, 'staff-cell-grant', { cell, epoch, labelSealed, wraps: [{ writer, wrap }] })`. The roster entries `cell.create` and `cell.rekey` carry only `cell`, `epoch`, `reason` and the sha256 of the grant, so every member's roster fold knows an epoch exists and can check the grant it holds is the committed one. The cell's label (level, compartments) is sealed under the epoch key inside the grant, so only cleared devices learn it (DESIGN 4.1, 8.2). The base cell's grant travels in the admission "welcome" file; later base epochs are delivered inside the roster stream as part of `cell.rekey` data (large lists spill into a sealed blob automatically, `entry.ts:187-192`).
**When to use:** all non-base cells; the base cell's first epoch.
**Why:** (1) The roster stream is sealed under the base epoch key (`entry.ts` AAD and `verify.ts:96`), so a joiner cannot read the roster entry that would deliver the base key. (2) D-22 says members never see grants for other cells; a grant inside the base-cell roster stream would show every member every other cell's grantees. [ASSUMED: design resolution; D-22 allows "the grant part of cell.create and cell.rekey" only if the reader already holds the key]
**Welcome file for admission:** the lead returns one file to the joiner holding the genesis entry, all roster entries, and the grants addressed to the new device (one wrap per epoch up to the current one for each granted cell, so history stays readable; see Open Question 3).

### Pattern 3: Hold retries declared by what the hold waits for
`holdWaits.ts` (new, pure) maps `(kind, reason, entry)` to a wait: `missing-blob` on `doc.compact` waits for `data.stateBlob`, on `version.propose` for `data.textBlob`; `missing-key` waits for `(header.stream, header.epoch)`; `updates-missing`, `unregistered-client` and `product-unknown` wait for an admitted entry. `addEntries` then checks cheaply (`ctx.blobs(hash) !== undefined`, `ctx.keys(stream, epoch) !== undefined`, graph membership) and refolds from the earliest ready hold only. A new file avoids touching `textFold.ts` and `versions.ts` from the fold plan.

### Anti-Patterns to Avoid
- **Putting wraps for other cells in the roster stream:** exposes grantees to every member and is circular for the base key.
- **Re-using `registerLock.ts` as a cross-window lock:** it is an in-process promise chain [VERIFIED: `src/staff/registerLock.ts:3-15`, a `Map<string, Promise>`]. Use `withFileLock` for cross-window and `withRegisterLock` only for in-process ordering.
- **Reading the clock in the roster fold:** invite expiry must compare `member.admit` `body.at` with the invite's `expiresAt` (signed by the lead, deterministic), never `Date.now()`; the host command may also refuse using the local clock.
- **Storing a private X25519 key or an opened epoch key anywhere in the project folder:** SecretStorage only (D-19, D-24).
- **Passing a fresh `ReplicaContext` on every call:** each new object triggers a full refold (`fold.ts:441-447`).
- **Treating a reducer `refused` entry as absent from the store:** refused entries are still admitted graph nodes and keep their writer's chain intact (`chain.ts` header comment lines 8-9); the store must keep them and feed them to the fold.

## Phase 30 finding verification (item 1)

Line numbers are current on this checkout (the review's numbers predate the CR fixes). "Run" means I executed a scratch script (kept in the session scratchpad, not in the repo) against `dist/`.

| ID | Status | Exact location now | Smallest correct fix | Test file to extend | Files the fix touches |
|----|--------|--------------------|----------------------|---------------------|-----------------------|
| (a) WR-04 | CONFIRMED (run: honest compaction refused `compact-mismatch` when a refused `foreign-client` update was in its past; `compactions` came back empty) | `textFold.ts:200-216`, the loop `for (const hash of included) if (!acceptedHashes.has(hash)) return refused('compact-mismatch')` at `:209`, scratch built at `:210` | Compute `usable = included` filtered to hashes in `acceptedHashes`; build `scratch` from those; keep `compact-mismatch` only when a covered entry that IS accepted is missing from the cover set, or the vector or hash no longer match | `replicaDoc.test.ts` (compaction group near line 225-345) | `textFold.ts` |
| (b) WR-03 | CONFIRMED by code (not run) | `equivocation.ts:392` `.slice(0, 2)` takes two lowest hashes; `forkChosen` at `:402-405` accepts only `proof.a` or `proof.b`; `chain.ts:98` and `:257` call it | Give `EquivocationProof` an optional in-memory `branches?: readonly string[]` (every hash at the slot), filled in `findEquivocations`, and enriched in `classifyChains` for carried proofs from the admitted set; `forkChosen` accepts any branch; `proofHash` and the wire form ignore `branches` | `replicaEquivocation.test.ts` (and `replicaChain.test.ts`) with three and four branches | `equivocation.ts`, `chain.ts` |
| (c) WR-08 dup | CONFIRMED (run: 2000 JSON-cloned copies took 361 ms, each fully verified; with one real new entry in the same call `store.seen` grew from 2 to 2003 while `chosen` stayed 3). Nuance: when a call changes nothing, `addEntries` returns the old state at `:434`, so the grown `seen` is thrown away but the verification cost was already paid | `fold.ts:144-157` (`ingest` calls `verifyEntry` first at `:145`), `:354-355` and `:429-430` (`seen` is a `Set<unknown>` of object identity), `:85`, `:133-139` | In `ingest`, parse the header with `parseHeaderShape`, compute `entryHash`, and return false at once when `store.chosen.get(hash)` is already verified or when a held copy with the same reason exists; replace `seen: Set<unknown>` by a bounded `Set<string>` of header hashes; count and drop unreadable inputs | `replicaReevaluation.test.ts` or `replicaConvergence.test.ts` (add a re-delivery test counting `verifyEntry` calls through a spy on the context lookups) | `fold.ts` |
| (d) | CONFIRMED for `missing-blob` and `missing-key` (run: blob placed into the Map behind the same `ctx` object; `addEntries(state, [], ctx)` returned the identical state, `held: ['missing-blob']`, while `foldEntries` with the same ctx applied all 3 entries). NOT a divergence for `unregistered-client` and `updates-missing`: an arrival that sorts earlier makes `extendsOrder` false and refolds, and one that sorts later is held in the from-scratch fold too; write the property test anyway | `fold.ts:434` `if (!changed && !replaced) return state;`; reducer holds are in `run.held` (`:55`, pushed at `:308` in `applyFrom`) | Add `holdWaits.ts`; before the early return, probe each `run.held` entry; if any wait is now answerable, refold from the earliest such position (reuse the `late` path, `fold.ts:445-456`); an unanswerable probe must still return the same state object (the existing assertions at `replicaReevaluation.test.ts:181-182` stay true) | `replicaReevaluation.test.ts` | `fold.ts`, new `holdWaits.ts` |
| WR-01 | CONFIRMED by code | `versions.ts:194-200` `actorForTransition` presents `act.actor.member` as the agent; `:410-421` `validVerdicts` calls `run(...)` with no roster check on who may run the seat | Add `canRunAgent` to `RosterView` (default deny in the static view), refuse `not-gate-member` in `validVerdicts` | `replicaVersions.test.ts`, `replicaForbiddenActs.test.ts` | `versions.ts`, `rosterView.ts`, `test/helpers/replicaWorld.ts`, and the five test files that write verdicts (`replicaVersions` 23 uses, `replicaForbiddenActs` 3, `replicaConvergence` 2, `replicaIntegration` 2, `replicaVersionDecisions` 1) so their members get the seat |
| WR-02 | CONFIRMED by code | `projectFold.ts:77` checks only `hasRole(... 'staff_lead' ...)`; `textFold.ts:119-130` `applyClient` checks `actor-mismatch` but not the agent's member against the roster | In `projectFold.ts` refuse `entry.body.actor.kind !== 'person'` with a new reason `agent-cannot-decide` before the role check (add to `PROJECT_REFUSALS`); in `applyClient`, for an `agent` actor call `roster.canRunAgent(entry.member, actor.member, entry.body.roster)` and refuse `agent-seat-not-allowed` | `replicaDoc.test.ts` (client), `replicaVersions.test.ts` or `replicaIntegration.test.ts` (genesis) | `projectFold.ts`, `textFold.ts` |
| WR-05 | CONFIRMED by code | `doc.ts:183-197` `inspectSnapshot` builds a scratch per call; `versions.ts:260-261` calls `snapshotMissing` then `textAtSnapshot` (two scratch builds); `versions.ts:721` a third in `deriveProduct`; `textFold.ts:210` rebuilds per compaction | Add one `doc.ts` export that returns `{ missing, text, runs }` from a single inspection; memoise the accepted-prefix scratch per product keyed by `accepted.length`; cap compactions and proposals per (product, writer) and refuse `too-many` | `replicaDoc.test.ts`, `replicaVersions.test.ts` | `doc.ts`, `textFold.ts`, `versions.ts` |
| WR-06 | CONFIRMED by code | `decisions.ts:112-127` `closureOf` is O(n^2) with a fixpoint, `:164-190` `settleValidity`; `causal.ts:47-55` `pasts` memo holds one full ancestor set per queried entry | Cap acts per writer per version in the reducer (`versions.ts` `acts.push`, refuse `too-many-acts`); replace the fixpoint by one pass in lamport order; use `a.body.lamport < b.body.lamport` as a necessary condition before building a past set | `replicaDecisions.test.ts`, `replicaVersionDecisions.test.ts` | `decisions.ts`, `causal.ts`, `versions.ts` (cap only) |
| WR-07 | CONFIRMED (see D-05 section; run) | `doc.ts:235-237` `decodeUpdate` before the `MAX_STRUCTS` check; `doc.ts:170-179` `deletesCovered` quadratic; `kindSchemas/doc.ts:7` `MAX_UPDATE_BYTES = 4 * 1024 * 1024` | Skim before decode; linear merge walk | new `replicaUpdateGuard.test.ts`, `replicaDoc.test.ts` | `doc.ts`, `kindSchemas/doc.ts`, new `updateGuard.ts` |
| WR-08 reg | CONFIRMED by code | `textFold.ts:79-99` `productText` calls `createFoldDoc()` on every first registration; no cap on registrations or products | Lazy doc (create on first accepted update), cap registrations per (writer, product) and products per stream | `replicaDoc.test.ts` | `textFold.ts` |
| WR-09 | CONFIRMED by code | `decisions.ts:99-110` held fixpoint `heldIds.has(id) \|\| !(ids.has(id) \|\| input.isKnownEntry(id))` | Hold only acts whose `seen` names an unknown id; do not propagate through `heldIds` | `replicaDecisions.test.ts` | `decisions.ts` |
| IN-01 | CONFIRMED | `decisions.ts:128-135` the `precedence-cycle` branch | Turn into a thrown assertion in tests, keep behaviour in production | `replicaDecisions.test.ts` | `decisions.ts` |
| IN-02 | CONFIRMED (no caller anywhere in `src`; grep) | `doc.ts:73-81` | Delete | none | `doc.ts` |
| IN-03 | CONFIRMED | `fold.ts:76-78` `rank` returns `'0'` or `1:<status>:<reason>` | Numeric rank `{ verified: 0, held: 1, rejected: 2 }` with a comment | `replicaReevaluation.test.ts` | `fold.ts` |

**New defects found while verifying (add to the plans):**
1. `applyCompaction` (`textFold.ts:183-185`) and `readBlobText` (`versions.ts:214-228`) open a blob with `openBlob` with no size check; only `verify.ts:112` checks `BLOB_MAX_BYTES` for body blobs. A hostile oversized `stateBlob` is allocated by `Buffer.from(blob.bytes, 'base64url')` inside `fromWire`/`openBlob` before any limit. Fix: gate on `blob.bytes.length` against a derived maximum before `openBlob`, and make the store refuse to hold a blob over `BLOB_MAX_BYTES` (`entry.ts:25`: `BLOB_MAX_BYTES = 8 * 1024 * 1024`).
2. `decodeSnapshot` (`doc.ts:143-154`) has the same eager-allocation shape for a snapshot's delete set; the skim should cover snapshots too.

### Plan grouping with no file overlap inside a wave (item 1 output)

| Wave | Plan | Owns (files) | Fixes |
|------|------|--------------|-------|
| A | P-iface | `rosterView.ts`, `test/helpers/replicaWorld.ts` | Add optional/default-deny members to `RosterView` and `staticRosterView` (`canRunAgent`, `clientIdOwner`, `deviceEncryptionKey`, `cellGrantees`, `rosterBranchPending`), world helper `agentSeats` option |
| B | P-fold | `fold.ts`, `holdWaits.ts` (new) | (c), (d), IN-03, WR-08 fold part |
| B | P-text | `textFold.ts`, `doc.ts`, `kindSchemas/doc.ts`, `updateGuard.ts` (new), `attribution.ts` if needed | (a), WR-02 client part, WR-04, WR-05 text part, WR-07, WR-08 registration part, IN-02, D-03 enforcement, D-05 limits, new defect 1 and 2 |
| B | P-decisions | `decisions.ts`, `causal.ts`, `projectFold.ts` | WR-06 algorithm, WR-09, IN-01, WR-02 project part |
| B | P-forks | `equivocation.ts`, `chain.ts` | (b) |
| C | P-versions | `versions.ts` plus the five test files and `kindSchemas/versions.ts` if the cap needs a schema field | WR-01, WR-05 versions part (needs the new `doc.ts` export from P-text), WR-06 cap |
| C | P-checkpoint | `checkpoint.ts`, `chain.ts` (after P-forks), `fold.ts` (after P-fold), `order.ts` if needed, vectors fixture and test | D-04 |
| D.. | WP-R1 and WP-R2 plans | new files (see structure) plus `kinds.ts`, `kindSchemas/roster.ts`, `kindSchemas/project.ts`, `signedPayload.ts` single owners | everything new |

`rosterView.ts` is needed by WR-01, WR-02 and D-03, so it gets its own first plan (A) instead of being edited by three parallel plans. P-checkpoint cannot share a wave with P-fold or P-forks because it edits `fold.ts` and `chain.ts`.

## D-03 Client id derivation

**Facts.** Yjs client ids are unsigned 32-bit integers; the fold document uses client id 0 and `doc.client` refuses it [VERIFIED: `doc.ts:39-44` `doc.clientID = 0`; `kindSchemas/doc.ts:42` `isSafeIntegerInRange(data.clientId, 1, MAX_CLIENT_ID)` with `MAX_CLIENT_ID = 4294967295` at `:8`]. Today the first claim in total order wins and a second writer gets `client-collision` (`textFold.ts:119-130`, `TEXT_REFUSALS['client-collision']`). Phase 30 is not used by the extension yet [VERIFIED: SECURITY.md line 1317 "not used by the extension yet" and 1322-1324], so no production registration exists to migrate; only test worlds and `vectors.json` use client ids like 101, 202 and 11.

**Recommended derivation [ASSUMED, within the D-03 properties]:**
- The roster fold gives every device a `slot`: the 1-based ordinal of the device in the order the linear roster admitted devices (genesis lead device = 1; `member.admit`, `device.add`, `device.rotate`, `hub.admit` each take the next). Slots are never reused after revoke.
- `clientId = (slot * 2^20 + counter) >>> 0`, with `slot` in 1..4095 and `counter` in 0..1048575. Arithmetic check: `4095 * 1048576 + 1048575 = 4294967295 = MAX_CLIENT_ID`; the smallest id is `1048576`, so 0 stays unreachable. Use `>>> 0` or multiplication, not `<<` (JavaScript `<<` yields signed values above 2^31).
- Two writers can never collide because slots differ (disjoint ranges), so the "race" disappears rather than being resolved. A device gets 1,048,576 client ids per product, enough for a fresh id per editor session, which Yjs expects.
- `RosterView.clientIdOwner(clientId, rosterHash): string | undefined` returns the writer whose slot equals `clientId >>> 20`. `applyClient` refuses `foreign-client-id` when the owner is not the entry's writer (or undefined). If the view does not implement it (the static test view), nothing is enforced, so every Phase 30 test, vector and fixture stays unchanged. Add the reason to `TEXT_REFUSALS` (closed map, `textFold.ts:59-70`).
- Limit: 4095 devices per project; the roster fold refuses a 4096th with `device-limit`.
- Hub: an `actor.kind === 'hub'` entry never reaches the text reducer (`fold.ts` keeps it `hub-actor`), so a hub device needs no slot, but giving it one keeps the rule simple.
- Effect on Phase 30 registrations: a `doc.client` in a world that has the real roster view must lie in the writer's range or it is refused `foreign-client-id`. The earlier-claim-wins rule stays as a second check for the same writer registering the same id twice with a different actor (`actor-mismatch`).
- Phase 33's editor must choose `counter` values per session (persist the next counter per project and product); a helper `nextClientId(slot, used)` belongs in `clientIds.ts`.

## D-04 Checkpoint format additions

**Facts.** `Checkpoint` has `type, v, project, signer, rosterHead, streams`; each `CheckpointStream` has `stream, heads, count, orderTip` and optional `digest`; each head is a `Dep` `{writer, seq, hash}` [VERIFIED: `checkpoint.ts:22,28-29,32-51`, `CHECKPOINT_VERSION = 1`, `STREAM_KEYS = ['stream', 'heads', 'count', 'orderTip']`]. `seq` and `hash` are already there; `lamport` is missing. `readCheckpoint` rejects any extra key (`checkpoint.ts:134,137` closed key list; `readDep` requires exactly 3 keys at `:104`). The committed vector is a v1 checkpoint [VERIFIED: `test/fixtures/replica/vectors.json` `checkpoint.unsigned.v == 1`; `replicaVectors.test.ts:92-102`].

**What the chain needs for a log that starts after a checkpoint.** In `chain.ts`: (1) `staticRefusal` at `:72-76` accepts `seq > 0` only when `prev` is in `nodes` or absent; (2) admission waits for every predecessor to be admitted (`:178-183`), so an entry whose `prev` is a head not held stays `missing-predecessor` forever; (3) `bad-lamport` demands `lamport == 1 + max(lamport of predecessors)` (`:191-195`), which needs the head's lamport; (4) `stale-roster-citation` (`:196-204`) compares positions with `newestRoster` of the predecessors, which needs the roster position cited by the head's past.

**Recommended v2 head [ASSUMED]:** `{ writer, seq, hash, lamport, roster }`, where `roster` is the highest-position roster hash cited by the head or anything in its causal past (what `newestRoster` holds at admission). Set `CHECKPOINT_VERSION = 2`; `readCheckpoint` accepts v1 (heads as `Dep`, never usable as a late-join base) and v2 (heads with the two extra keys); `signCheckpoint` writes v2. The old vector still verifies unchanged; add a `checkpointV2` section to `vectors.json` with its own signed bytes (D-39: "the vectors file gets a new version and the old vectors still verify"). The `Dep` type is shared with entry deps and must not change; add a `CheckpointHead` type.

**Chain and fold changes (P-checkpoint):** `classifyChains(verified, ctx, verifyRejected, bases?)` takes `bases: Map<hash, { stream, writer, seq, lamport, roster }>` derived from the verified v2 checkpoints the fold uses. A base counts as an admitted virtual predecessor; `prev` naming a base must satisfy `seq == base.seq + 1` and the same writer and stream, else `bad-prev`; its lamport and roster position feed the two checks above. A dep that names a covered entry that is not a head stays `missing-predecessor` (deterministic and conservative; see Open Question 1). `checkpointCoverage` and `planCheckpoints` ignore a checkpoint whose heads are not in the graph (`fold.ts:188` `if (covered.size > 0)`), which is correct for a prefix-less joiner; ordering of the entries after the checkpoint is `totalOrder(rest)`, identical to what a machine holding the prefix computes for those entries.

**Effect on tests.** `replicaCheckpoint.test.ts` and `replicaVectors.test.ts` keep passing unchanged; new tests: v2 round trip and signature, v1 still verifies, a joiner holding only the checkpoint plus post-checkpoint entries admits the chain and the order of those entries equals the suffix of the full fold's order, a wrong head hash or lamport is refused, a non-signer checkpoint is refused (`not-a-checkpoint-signer`). `CHECKPOINT_MAX_BYTES = 64 * 1024` (`checkpoint.ts:23`) limits heads: 64 KiB over about 150 bytes per v2 head is about 400 heads in total, enough for drop A (note it).

**Keep the name `checkpointSigner`.** D-08 lists `isCheckpointSigner`; the existing interface method is `checkpointSigner(writer, rosterHash)` [VERIFIED: `rosterView.ts:22`]. Renaming churns `checkpoint.ts` and tests for nothing; keep it and let the roster fold implement it (true for a `hub.admit` device or a member the roster names).

## D-05 Update size, pre-decode skim, memory-capped worker

**Numbers from the spike [VERIFIED: 30-CRDT-SPIKE.md]:** typing update max 108 to 109 bytes; paste max 2,909; paragraph rewrite max 3,961; full state of a 30-page product (garbage collection off) 436,595 to 520,879 bytes (4.73 to 5.66 bytes per character, about 92,000 characters). Entry bodies over `INLINE_BODY_MAX_BYTES = 16 * 1024` already move to a sealed blob capped at `BLOB_MAX_BYTES = 8 * 1024 * 1024` (`entry.ts:24-25`).

**Recommended limits [ASSUMED]:**
- `MAX_UPDATE_BYTES` (one `doc.update`): **256 KiB**. That is about 65 times the largest spike update and enough for a 100,000-character paste in one update; a larger paste must be split by the Phase 33 binding.
- New `MAX_STATE_BYTES` (a `doc.compact` state blob, snapshot, and scratch loads): **2 MiB**, about 3.8 times the largest 30-page full state (roughly 120 pages at the spike's 17 KB per page).
- `MAX_STRUCTS` stays 100,000 (`doc.ts:22`); measure the struct count of a spike full state before freezing it (I could not run that this session: the spike's `workload` loads its own Yjs copy and a second copy in the same process throws, so the count is unmeasured; with about 3,000 updates it is certainly far below 100,000 but this is `[ASSUMED]`).
- Put both byte constants in `kindSchemas/doc.ts` (hub-side, the schema checks `isBase64urlBytes(data.update, MAX_UPDATE_BYTES)` at `:49`) so Phase 32's hub uses the same numbers. Changing `MAX_UPDATE_BYTES` changes which `doc.update` entries are valid, so it is a format decision for the hub too; no committed vector has an update near the limit.
- `doc.ts` uses one constant for updates, snapshots and states (`:49,75,145,284`); split it: updates use `MAX_UPDATE_BYTES`, `buildFromCompaction`, `scratchDocWith` and `decodeSnapshot` use `MAX_STATE_BYTES`.

**Struct count before decode, how Yjs v1 lays out an update [VERIFIED: `node_modules/yjs/src/utils/encoding.js:112-163`, `UpdateDecoder.js`, `DeleteSet.js:248-263`, and a prototype run against the vendored bundle]:**
```
varuint  numClientGroups
 repeat: varuint numberOfStructs, varuint client, varuint startClock, then numberOfStructs structs
struct:  info byte; low 5 bits = ref
   ref 0  GC:      varuint len
   ref 10 Skip:    varuint len
   other  Item:    if info&0x80  origin  = varuint client, varuint clock
                   if info&0x40  rightOrigin = varuint client, varuint clock
                   if (info&0xC0)==0: varuint parentInfo; if 1: varString key else: varuint client, varuint clock
                                      if info&0x20: varString parentSub
                   content by ref: 1 Deleted -> varuint len; 4 String -> varString (varuint byteLength + utf8)
then the delete set: varuint numClients; each: varuint client, varuint numberOfDeletes, each: varuint clock, varuint len
```
Only the first group's count sits at a fixed offset; reading the later groups needs a walk. Because Phase 30 already refuses every content other than refs 0, 1 and 4 (`doc.ts:249-261` returns `forbidden-content`), a **strict skimmer** that walks the structure, refuses any other ref and counts structs and delete ranges, costs nothing in what is accepted and allocates nothing. My prototype (`skim.cjs`, scratchpad) returned the same struct counts as `Y.decodeUpdate` on honest updates (1, 1, 0 and 5 structs) and refused a 131,072-struct GC probe with `too-many-structs` before decoding. Put it in `updateGuard.ts` (pure, no Yjs, hub-side candidate), call it first inside `inspectUpdate` (`doc.ts:283`) and `applyUpdate`, add the same walk for snapshots, and return `too-large` (counted) or `malformed`. Use a varuint reader that stops after 8 bytes (a longer varuint is malformed) and checks every advance against the byte length.

**What a hostile update really cost here [VERIFIED: ran against `dist/domain/replica/doc.js`, Node v24.22.3, `--expose-gc`]:**

| Probe | Bytes | Result in old code | Heap used | RSS |
|-------|-------|--------------------|-----------|-----|
| 65,536 GC structs | 131,079 | ok (under `MAX_STRUCTS`) | +17 MB | 99 MB |
| 2,000,000 GC structs | 4,000,007 | `too-large`, but only after decoding all 2,000,000 | +211 MB | 367 MB |
| 600,000 text items | 4,183,497 | `too-large` from the struct cap, again only after the whole decode (the bytes are under the 4 MiB limit) | +146 MB | 318 MB |
| 100,000 text items (the cap) | 683,497 | ok | +40 MB (inspect), +33 MB (apply) | 116 MB |

(The byte limit alone is not the control: the struct cap at `doc.ts:237` runs only after the whole decode.) The ROADMAP and CONTEXT figure "about 1.16 GB" **did not reproduce** with either shape; the regression test must set its ceiling from a measured probe of the worst shape the planner can build, with headroom, and must fail on the old code. A good discriminator on this machine is the 2,000,000-GC-struct probe asserting heap growth under 64 MB, which the old code violates (+211 MB) and the new code meets (the skim refuses it in under a few milliseconds). Worst case after the fix is the 100,000-item update at about 40 MB, which is why the worker is defence in depth rather than the only control (D-05 still requires it).

**Worker [VERIFIED: ran `worker2.cjs`]:** `new Worker(file, { workerData, resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })` with Yjs loaded through `dist/domain/replica/doc.js`. Start including the Yjs load took 35 to 56 ms. A 3-struct update passed at a 32 MB limit; a 100,000-item update (the cap) failed at 32 MB (`ERR_WORKER_OUT_OF_MEMORY`) and passed at 64 and 128 MB; the 2,000,000-GC-struct probe failed at every limit up to 128 MB with `ERR_WORKER_OUT_OF_MEMORY` in 0.2 to 0.5 s while the main thread stayed alive (`worker.cjs` showed `heapUsed` 5 MB afterwards). Recommend `maxOldGenerationSizeMb: 128`, `maxYoungGenerationSizeMb: 32`, `stackSizeMb: 4`, a 5 second per-job timeout with `worker.terminate()`, one reused worker restarted after any error, and a host mapping of `ERR_WORKER_OUT_OF_MEMORY` or a timeout to the refusal `too-large` (counted, entry kept). Buffers and `ArrayBuffer`s are outside the V8 heap limit, so the byte limit remains a separate control.

**Where the worker sits.** The worker only inspects; it must not hold an entry back from the fold. A reducer `refused` entry is still a graph node and keeps the writer's chain intact (`chain.ts` lines 8-9), so the store persists every verified entry and passes it to the fold; the fold's own skim (the second line) refuses a hostile update in microseconds. The worker's value is isolating decoder bugs and keeping the host responsive on accepted but large updates; keep it thin: one function `inspect(bytes) -> InspectionResult | { error }`.

**Packaging [VERIFIED]:** there is no bundler for the extension code. `compile` is `node scripts/vendor-libs.mjs && tsc -p tsconfig.json` (`package.json` scripts) with `rootDir: src, outDir: dist` (`tsconfig.json`), `main` is `./dist/extension.js`, and `.vscodeignore` excludes only `dist/test/**` from `dist`. So `src/staff/replica/decodeWorker.ts` compiles to `dist/staff/replica/decodeWorker.js` and ships; start it with `new Worker(path.join(__dirname, 'decodeWorker.js'), ...)`. The worker may `require('../../domain/replica/doc')`, which loads `../../../vendor/yjs/yjs.cjs` from `dist/domain/replica` (worked in my run). Add `'extension/dist/staff/replica/decodeWorker.js'` to the `required` list of `scripts/verify-release-content.mjs` (the list starts at line 61; `extension/dist/extension.js` is at line 68) so a VSIX without it fails `npm run verify:release`.

**Testing a heap ceiling under the repo caps.** The repo wrapper (`MemoryMax=4G`, `--max-old-space-size=1536`) is far above the worker's 128 MB limit, so the worker limit and the test ceiling are the controls, not the cgroup. Tests: (1) pure: `inspectUpdate` on the 2,000,000-GC probe returns `too-large` and heap growth measured with a forced GC (`v8.setFlagsFromString('--expose-gc')` then `vm.runInNewContext('gc')`, the pattern at `scripts/crdt-spike.mjs:44`) stays under 64 MB; (2) host: the real worker with a tiny `maxOldGenerationSizeMb` (24) on a 100,000-item update yields the mapped refusal and the next job on a restarted worker succeeds; (3) boundary: `src/staff/replica/` imports `vscode` nowhere in the worker file. Build probe bytes in the test with a small varuint writer (as in the scratch scripts), never commit a multi-megabyte fixture.

## Roster fold design (item 5)

**Kinds and what is missing [VERIFIED: `kinds.ts:24` lists `'member.invite', 'member.admit', 'member.update', 'member.remove', 'device.add', 'device.rotate', 'device.revoke', 'device.quarantine', 'device.release', 'hub.admit', 'hub.grant', 'hub.revoke', 'cell.create', 'cell.rekey', 'lead.handover', 'roster.choose', 'deputy.name'`; schemas in `kindSchemas/roster.ts:96-114`; roster entries have no reducer today, so `applyFrom` keeps them `folded-in-later-phase` (`fold.ts` apply loop)].**

Schema changes needed before any store exists (all in `kindSchemas/roster.ts` and `project.ts`, each file one owner):
- `project.genesis`: `lead` is `{member, writer}` (`project.ts:222-224`, `exactKeys(lead, ['member','writer'])`). Add optional `lead.device` (the `deviceProblem` shape: `writer, publicKey, x25519, x25519Sig`), optional `level` (staff level slug) and optional `cells` (`[{cell, grant}]`) as additive optional keys so Phase 30 fixtures (`replicaKinds.test.ts:39`, `replicaConvergence.test.ts:75`) stay valid. Require `lead.device` in the roster fold, not in the wire schema.
- `member.invite`: add optional `forMember` (slug) for "Add My Other Machine" (D-18); when present the admission is a `device.add`.
- `member.admit`, `member.update`: add optional `agentSeats` (list of slugs, at most 16) for `canRunAgent` (D-12).
- `cell.create`: add `epoch` (first epoch, 1) and `grant` (sha256 of the grant object); `cell.rekey` add `grant`. `epochCheck` already requires `>= 1` for `cell.rekey` (`roster.ts:93,110`), and the test world uses epoch 0 by default (`replicaWorld.ts` `options.epoch ?? 0`), so real epochs start at 1 and 0 stays a test value.
- One new kind `invite.void` `{invite, rosterPrev}` (D-17 "voided by a roster entry"; no existing kind names an invite). This grows `REPLICA_KINDS` from 50 to 51 and updates pinned counts in `replicaTracer.test.ts:143-144` (50), `replicaContracts.test.ts:23` (47 non-doc kinds), `replicaKinds.test.ts:69,86` (19 and 17) and the roster kinds comment at `roster.ts:95`. Those are intentional updates of a closed list, not weakened assertions; call them out in the plan.
- `project.import`: `{ledger, legacyHead, count}` only (`project.ts:234`); body is `data` XOR `blob` (`kinds.ts:67-69`). Add the file as `file` (base64url of the whole legacy file, at most 2 MiB `MAX_STAFF_FILE_BYTES` per `staffFiles.ts:14`, so about 2.8 MB of base64 which `buildEntry` moves into a sealed blob automatically, under `BLOB_MAX_BYTES`), and optional `mark` (the signed head-mark text for the product ledger).

**Algorithm (`roster.ts`, pure):**
1. Inputs: sealed roster-stream entries, the anchor `{ genesisHash, lead: { member, writer, publicKey, x25519 } }`, a key ring for the base cell. The roster stream id is the genesis `project` id [ASSUMED]; entries of roster kinds in any other stream are `kept` and refused (`roster-kind-outside-roster-stream`).
2. Seed position 0 (the origin roster, hash `GENESIS_PREV`) from the anchor. Verify entries with `verifyEntry` against a progressive view.
3. Build the `rosterPrev` graph. The applied head starts at the origin. Repeatedly: find verified roster entries whose `rosterPrev` equals the head. One candidate: check authority and apply. Two or more candidates: split; none apply; record `pending: [{ at: head, branches: [...] }]`. A `roster.choose` whose `rosterPrev` equals the split point and whose `chosen` names a child of it, signed by an allowed chooser (lead device, or deputy when the lead has no active device or has handed over, D-09), resolves it; the applied line continues through the chosen child (the chosen child cites the split point as its `rosterPrev`, not the choose entry, so the fold treats a choose as occupying one position between the split point and the chosen branch) [ASSUMED: encoding of choose; the schema is `{chosen, rosterPrev}` and says nothing more].
4. Authority per kind: lead or deputy device at `rosterPrev`; `deputy.name` lead only; `lead.handover` signed by the lead, or by the deputy when `reason == 'lead-lost'` (`HANDOVER_REASONS = ['planned', 'lead-lost']`, `roster.ts:24`); all others by lead or deputy. Invariants: the lead cannot be removed except through a handover; the last active lead device cannot be revoked without a handover; slots capped at 4095.
5. Membership machine (DESIGN 15.1): invited, join-requested (a host and file state, not an entry), active, removed, expired, voided, split, chosen. `member.admit` is valid only when the invite entry is applied, not voided, unused and `admit.body.at <= invite.expiresAt` (deterministic, no clock). Device machine (15.2): active, rotated (old key valid at rosters before the rotation position), revoked, quarantined (from chain-level equivocation, `chain.ts` `quarantined` records, not from an entry), released through `device.release` naming a branch (feeds `chosenBranch`). `device.quarantine` has no state effect in this recommendation, only a lead acknowledgement record [ASSUMED; Open Question 5].
6. Output: `RosterState` with an ordered list of applied roster hashes (the positions), per-position snapshots kept as change events for logarithmic lookups, the pending splits, and `view(): RosterView`.

**Implementing `RosterView` [VERIFIED interface: `rosterView.ts:7-23`]:**
- `hasRoster(h)`, `rosterPosition(h)`: applied hashes, origin = 0. A hash on a pending branch is not `hasRoster`; to give D-11's `roster-branch-not-chosen` hold a name, add optional `rosterBranchPending(h)` and make `verify.ts:124` return that reason instead of `missing-roster` (add it to `VERIFY_HOLDS`, `verify.ts:27-33`). Both holds are retried when a context replaces the old one.
- `deviceKey(writer)`: any admitted device (used before the body is readable). `isAdmitted(writer, h)`: device admitted and not revoked at position(h). `memberName`, `hasRole`, `roleWithdrawnBy` (first later position where the member no longer holds the role, as `staticRosterView` computes at `rosterView.ts:87-94`).
- `chosenBranch(writer, stream, seq)`: from applied `device.release`. `checkpointSigner(writer, h)`: hub or named member.
- New: `canRunAgent(member, seat, h)`, `clientIdOwner`, `deviceEncryptionKey(writer, h)`, `cellGrantees(cell, h)` (from verified grants the machine holds), `rosterBranchPending`.
- Keep `staticRosterView` as is, with the new members optional and default-deny for `canRunAgent`.

**Boundary:** `roster.ts` imports only hub-side modules (`entry`, `verify`, `kinds`, `rosterView`, `kindSchemas/`) and `../gate/labels` types if needed, so add it, `cellKeys.ts`, `invite.ts` and `updateGuard.ts` to `HUB_SIDE` in `replicaBoundaries.test.ts` (a list at lines 22-35) in the plan that creates them; `safetyCode.ts` and `safetyWords.ts` need not be.

## Cell keys, wraps and grants (item 6)

**APIs verified by running them.**
```ts
import { createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');     // X25519 public key DER prefix
const importPublic = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const eph = generateKeyPairSync('x25519');
const ephRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x as string, 'base64url'); // 32 bytes
const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: importPublic(recipientRaw) });
const key = Buffer.from(hkdfSync('sha256', shared, ephRaw /* salt */, Buffer.from(info), 32));
const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(info));
const ct = Buffer.concat([c.update(epochKey), c.final()]);             // 32 bytes
const wrap = Buffer.concat([ephRaw, iv, c.getAuthTag(), ct]);          // 32 + 12 + 16 + 32 = 92 bytes
// unwrap: split the same offsets, diffieHellman({ privateKey, publicKey: importPublic(ephRaw) }), same hkdfSync, createDecipheriv + setAAD + setAuthTag
```
Run result [VERIFIED: `wrap.cjs`]: the wire form `ephemeralPublic(32) | iv(12) | tag(16) | ciphertext(32)` is **92 bytes** (123 base64url characters); unwrap with the right private key and info returns the key; a changed `info` string or another device's private key fails GCM authentication; an all-zero (low-order) public key is rejected by `diffieHellman` ("failed during derivation"). Private key DER prefix for PKCS8 is `302e020100300506032b656e04220420` (48 bytes total) for storing in SecretStorage the same way `identity.ts:58-62` stores the Ed25519 key (`privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')`).

**Format (HPKE-base-mode shaped, D-21):** `info = 'near-ai/cell-wrap/v1' \0 cell \0 epoch \0 deviceWriter`; the ephemeral public key is the HKDF salt; the same `info` is the GCM AAD. A new version tag means a new format version, so a standard HPKE library can replace it later. A wrap is bound to the cell, the epoch and the receiving device, so a wrap copied to another device or another cell fails.

**Device encryption key:** a second secret `nearAi.identity.encryptionKey` [ASSUMED name, following `DEVICE_KEY_SECRET = 'nearAi.identity.deviceKey'` at `identity.ts:22`], created inside the same `withFileLock(identityDir, 'identity-create.lock', ...)` step as the signing key with the same read-back check (`identity.ts:176-201`), because SecretStorage is last-write-wins and two windows could each make a key. Bind it with `x25519Sig`: an Ed25519 signature by the device over `'near-ai-vscode/device-x25519/v1\n' + rawX25519 + writerHex` (the schema field is exactly 64 bytes, `roster.ts:85`), checked in the roster fold; the roster entry signed by the lead then binds the pair (D-19). `device.rotate` and `device.revoke` are implemented in the pure fold and tested; Phase 31 has no rotate command (not in D-36's list), and rotation of the X25519 key would reuse the pending and previous secret pattern of `identity.ts:23-26`.

**Grant object:** `{ cell, epoch, labelSealed, wraps: [{ writer, wrap }] }` signed with new purpose `staff-cell-grant`. The lead or deputy computes grantees at write time (Phase 70 `dominates(clearance, label, context)` needs a clock and a scale table, `dominance.ts:8-14,63`, so the fold must not recompute it); the signed grant is the authority for who is on the cell, and the fold checks only that each wrap names a device admitted at the cited roster and that the signer was a lead or deputy device. Rekey reasons are the closed list `CELL_REKEY_REASONS = ['member-removed', 'device-revoked', 'clearance-lowered', 'hub-revoked', 'scheduled']` [VERIFIED: `roster.ts:23`]. After a removal the new epoch's grant omits the removed devices; the command result says "They keep what they already received. They will not receive anything new." (D-23).

**Key ring (D-24):** the host unwraps the grants addressed to the device with its X25519 private key at activation and write-through caches the opened keys in SecretStorage as D-24 says; because the grants stay on disk and are ciphertext, keys can always be re-opened, so the SecretStorage cache is an optimisation and can be lost without data loss. `KeyRing = (stream, epoch) => Buffer | undefined` is a closure over an in-memory `Map`. Random 96-bit GCM IVs under one epoch key are safe up to about 2^32 seals (NIST SP 800-38D guidance, training knowledge [ASSUMED]); `reason: 'scheduled'` exists for a long-lived cell.

## Invite, join and safety code (item 6)

**Files (new signed-payload purposes `staff-invite` and `staff-join-request`, added to `PAYLOAD_PURPOSES`).** `PAYLOAD_PURPOSES` is a closed list [VERIFIED: `signedPayload.ts:26` `['policy-bundle', 'grant', 'approval-answer', 'key-record', 'label-map', 'label-declassify', 'staff-ledger', 'staff-ledger-head', 'staff-decision', 'staff-replica']`]; adding purposes touches `signedPayload.ts` and `teamSignedPayload.test.ts`, one owner. A third new purpose `staff-replica-mark` is needed for the store marks and a fourth `staff-cell-grant` for grants.
- Invite payload: `{ genesisHash, project, name, lead: { member, writer, publicKey, x25519 }, invite, hub?: { address, certPin }, secret, expiresAt }`. The join secret is 32 random bytes, base64url; the roster entry carries only `secretHash = sha256(secret)` (`member.invite.secretHash`, `roster.ts:97`). The lead's host keeps the secret in SecretStorage keyed by invite id until the invite is used, voided or expired (it needs it to recompute the MAC).
- Join request payload (signed by the joining device): `{ invite, genesisHash, name, publicKey, x25519, x25519Sig, mac }` with `mac = HMAC-SHA256(secret, canonicalBytes({ invite, genesisHash, name, publicKey, x25519 }))`. Compare MACs with `timingSafeEqual`.
- Refusals each get a named test (D-17): `invite-expired` (host clock and the fold's `admit.body.at` rule), `invite-used` (a second `member.admit` for one invite id), `invite-voided` (`invite.void` applied), `wrong-secret` (MAC mismatch), `wrong-project`, `bad-signature`, `unknown-invite`. A stolen invite file lets an attacker build a valid MAC; the safety code is what catches a substituted key, so Admit must be impossible without the lead's explicit "the code matched" confirmation (D-16).

**Safety code.** Word list: **BIP-39 English** (2048 words, committed as `safetyWords.ts`, hash-pinned). Facts: 2048 lines, all first four letters distinct, lengths 3 to 8, file sha256 `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda` [VERIFIED: fetched and counted this session]; the BIP header states "License: MIT" (the list sits in the same repository folder; no separate licence line for the file was found, so its licence is the BIP's [ASSUMED]). MIT matches this repo's MIT licence (`LICENSE`, `package.json` `"license": "MIT"`). No word list is vendored today [VERIFIED: grep of `src`, `scripts`, `docs`, `resources`, `media` and `node_modules` found none]. Add an attribution line to the file header and a row to SECURITY.md's dependency notes.
Derivation: `h = sha256('near-ai/safety-code/v1' \0 inviteId \0 genesisHash \0 leadSignPub \0 leadX25519 \0 joinSignPub \0 joinX25519)` using length-prefixed fields; take the first 66 bits as six 11-bit indices. Do not include the join secret (anyone with the invite file knows it). Six words are 66 bits, so an attacker who must pick keys after seeing the fresh invite id needs about 2^66 work to match. Display words lower case separated by spaces on both screens.

## Replica store on disk (item 7)

**Path and layout [ASSUMED within D-27]:** `.planning/staff/replica/` containing `project.json` (the pinned anchor, not secret), `streams/<stream>/<writer>.jsonl` (one sealed entry per line: `{header, body}`), `blobs/<hash>` (sealed, written to a temp file and renamed), `grants/<cell>/<epoch>.json`, `checkpoints/`, and a `.gitignore` containing `*` and `!.gitignore`. Reason for the ignore file: `.planning/staff/**` is ordinary tracked project content in a user's repository, and Phase 31's own `Use This Branch's Ledger` exists because a branch switch can roll a tracked ledger back (`staffHost.ts:178-180`); a tracked append-only store would also conflict on merge. The store is transport-fed (Phases 32 to 34), not git-fed. The staff tools already declare `.planning/staff/**` (`STAFF_HOST_PATHS`, `staffHost.ts:77`, checked by `staffLedgerIntegrity.test.ts:150-168`), so the new folder is covered by the existing label manifest globs.
- Append: write the whole line then `fsync`; readers ignore one trailing partial line (a crash mid-append) and never count it. Persist before sending (`entry.ts:10-11` comment: "the store writes before it sends").
- Locks: in-process ordering with `withRegisterLock(absolute, work)` (`registerLock.ts:5`) and cross-window with `withFileLock(dir, 'replica.lock', work)` (`stateMirrorLock.ts:190`), the pattern used for `LEDGER_LOCK` at `staffHost.ts:332`. `registerLock.ts` alone does not serialise two VS Code windows.
- Tamper and rollback: the files hold signed entries, so editing is detected by the fold; deleting or truncating is detected by **marks**.
- Marks: one SecretStorage value per project, `nearAi.staff.replicaMarks.<sha256(path)[0:32]>`, modelled on `LEDGER_HEAD_SECRET_PREFIX = 'nearAi.staff.ledgerHead.'` and `headKey()` (`staffHost.ts:79,281-283`), signed with purpose `staff-replica-mark`, holding `{ v: 1, rosterHead, heads: [{ stream, writer, seq, hash }] }`. On open, a store whose head for any (stream, writer) is below the mark, or whose entry at the mark's seq has a different hash, is refused with a plain message and a person-run way forward (a `Use This Copy` style command is out of scope here; say so in the refusal). Update marks after each append batch, coalescing, and refuse when the mark does not verify (`LEDGER_PROBLEMS['head-unverified']` pattern, `ledger.ts`).
- Size limits: refuse to store a blob over `BLOB_MAX_BYTES`; limit entries per file read with `readWhole` limits where a whole read is used (`staffFiles.ts:22`, default 2 MB; the store reads line by line instead).

**Today's ledgers, how each is verified and what "head" means [VERIFIED by reading `staffHost.ts` and `ledger.ts`]:**

| Ledger | File | Verified how | Chain | Head mark in SecretStorage |
|--------|------|--------------|-------|----------------------------|
| Products | `.planning/staff/ledger/products.jsonl` (`LEDGER_DIR`, `LEDGER_FILE`, `staffHost.ts:68-69`) | `replayLedger(lines, verify, mark)` with `verifyPayload(..., { purpose: 'staff-ledger', status })` (`ledger.ts:274`, `staffHost.ts:312-324`) | `entryDigest` hash chain, `LEDGER_GENESIS = '0'.repeat(64)` | Yes: key `nearAi.staff.ledgerHead.<hash>` holding a signed `staff-ledger-head` `{v:1,count,head}` (`staffHost.ts:281-305`) |
| Decisions | `.planning/staff/ledger/decisions.jsonl` (`DECISION_LOG_FILE`, `personDecisions.ts`) | `replayPersonDecisions` with purpose `staff-decision` | chain, `DECISION_LOG_GENESIS` | No mark found |
| Calculator | `.planning/staff/ledger/calculator.jsonl` (`logisticsHost.ts:7`) | `replayCalcLedger` | chain | No mark found |
| Wargame | `.planning/staff/wargame/ledger.jsonl` (`WARGAME_DIR`, `WARGAME_FILE`, `staffHost.ts:81-82`) | `parseWargamePhase` per line; a damaged line is skipped (`staffHost.ts:1270-1283`) | **none: unsigned, unchained** | none |

So `project.import` for the wargame ledger has no signed head; use `legacyHead = sha256(file bytes)` and `count = number of readable lines`, and say so in the import record. For decisions and calculator the legacy head is the last `entryDigest`. Only the product ledger carries a mark to import (`mark` field above). "Legacy chains stay verifiable forever" is tested by re-running the legacy replay over each imported blob with today's verifier and today's key status.

**Set Aside and Use This Branch's Ledger (single-machine flows, unchanged).** `setAsideLedger()` renames `products.jsonl` to `products.set-aside-<time>.jsonl` and resets the mark (`staffHost.ts:372-386`); `adoptBranchLedger` (`:410-441`) verifies, logs a signed decision then moves the mark. D-29 requires these to stay byte-for-byte as is for a project that never turns on multi-user. For a multi-user project they must refuse with a plain sentence ("This project is shared; the shared history is the ledger. Make a Single-Machine Copy to work alone."). The multi-user marker is the presence of `.planning/staff/replica/project.json` plus the pin in extension storage; `StaffHost` checks it once per call.

## Migration (items 7, D-30 to D-35)

Steps, each idempotent and each a named interruption point for the D-34 test: (1) verify the four legacy ledgers with today's verifiers (stop and offer Set Aside with today's wording on a break, `ledgerWayOut`, `staffHost.ts:186-190`); (2) write the genesis (skipped if the same genesis exists); (3) write four `project.import` entries whose entry content is derived from file hashes so a re-run makes the same entry bodies (note: re-sealing the same plaintext gives a new ciphertext and so a second signed header at the same seq, which `entry.ts:10-11` and `equivocation.ts:303` define as a fork; so a re-run must look in the store for the existing import entry first and never build a second one: the idempotency key is `(ledger, legacyHead, count)` as `projectFold.ts:97` already de-duplicates); (4) reconstruct products as texts and versions; (5) move legacy files to `.planning/staff/legacy/` (rename, never delete); (6) write projections; (7) record completion. The interrupted-at-every-step test re-runs from each step and compares the final fold digest and projection bytes.

**Reconstruct (D-32).** Per product: a `product.create`, a `doc.client` plus one `doc.update` carrying the whole body as the "imported" author (actor person of the lead's device, client id inside the lead's slot range), a `version.propose` per ledger version with the original `hash` (`replicaVersionHash` has the same construction as `productHash`: sha256 of the LF text plus `\n--depends_on: ` plus pins, `versions.ts` comment and `ledger.ts productHash`, but pins use hashes instead of numbers, so dependency pins must be mapped from `product@version` to `product@hash`, a point the plan must test), and the legacy approvals stay only inside the import blob. The `versions` reducer will not show a legacy approval as a replica decision, so the Staff Room text "approved on this machine before the project became multi-user, verified at import by the staff lead" must be a flag on the imported version rather than a `version.decide` act (agents cannot decide, and a person's act cannot be backdated under another person's key).

**Projections (D-28, D-33).** `StaffHost.replay()` returns a `LedgerReplay` (`products: Map<string, ProductState>`, `entries`, `head`, `broken?`, `ledger.ts:221`) and everything reads that. In multi-user mode build the same `LedgerReplay` from the fold: `families.versions` (`ProductVersions[]`: `records: VersionRecord[]` with `release: ProductRecord`, `versions: VersionView[]` with header, decision summary, guard and tradecraft state) gives `record`, `meta` (from the proposal header blob), gate marks and `approvedVersions`; `older` lines are the earlier closed versions. `history` items carry `seq` and `at` from ledger entries, which the fold's `VersionAct` does not keep (`versions.ts` `actOf` has `position`, not `at`), so the adapter reads `at` from the admitted entries; equality is asserted on `projectHeader`, `record`, `meta`, gate marks and `approvedVersions`, not on `history.seq`. This adapter is the largest single risk in WP-R2; give it its own plan and a table-driven equality test over every product state in `staffRelease`, `staffProducts` and `staffLedgerIntegrity` fixtures. Header tamper checks (`headerDisagreement`, `ledger.ts`) then compare against the adapter's `ProductState`.

## Make a Single-Machine Copy (item 7)

Today's signer is the host's `options.signer()` (`loadOrCreateDeviceIdentity`, wired at `staffCommands.ts:44-46`), used by `append()` (`staffHost.ts:330-370`) to sign `staff-ledger` entries and chain them; `signPayload(signer, 'staff-ledger-head', mark, ...)` writes the mark. A copy replays the fold into new `LedgerEntry` drafts (`propose`, `verdict`, `submit`, `approve`, `release`) and appends them through an `StaffHost` rooted at the **new** folder, so the copy verifies with today's verifier by construction and the shared project is untouched. Two hard limits found in the code:
- `append()` refuses a person actor whose `deviceFingerprint` is not the signer's (`staffHost.ts:350`, `RELEASE_REFUSALS['unnamed-person']`) and `replayLedger` fails `person-key` the same way (`ledger.ts` `replayLedger`). A copy therefore cannot reproduce another person's approval as that person. Recommended [ASSUMED, Open Question 2]: the copy records each carried decision with the copier's key and a name field that says whose it was, for example `"<Name> (approved in the shared project, carried by <copier>)"` (the schema allows a one-line name up to 120 characters, `ledger.ts validActor`), and never invents an approval for a contested version (D-35: "contested at copy time").
- The wargame ledger copy is just the folded lines rewritten; there is nothing to sign.
Write the copy under a new folder chosen by the person (never inside the shared project's `.planning/staff/replica/`), refuse a destination that already holds staff files, and print the "leave" sentences plainly.

## Preview gate and commands (item 8)

**Pattern [VERIFIED: `package.json:973-977`, `982-991`; `teamManifest.test.ts:74-91`; `teamCommands.test.ts:62`; `teamSoloParity.test.ts:1-40,119,206`]:** a boolean setting, default false, `scope: application`, with a plain description; the commands are listed in `menus.commandPalette` with `when: "config.nearAi.staff.multiUserPreview"`; the handler also checks the setting at run time (the e2e suite has a `PREVIEW_OFF_SIGNAL` for the same idea, `e2e/suite.ts:476`); tests: a manifest test (setting exists, boolean, default false, application scope, the `when` for each command; copy `teamManifest.test.ts`), a command test with the vscode stub (`createVscodeStub`, `installVscodeStub`, `stub.setConfig`) that proves nothing runs with the setting off, and a parity test.
- Setting name per D-36: `nearAi.staff.multiUserPreview` [ASSUMED name]. Commands (ids in `src/domain/staff/commands.ts` `STAFF_COMMANDS`, titles in `package.json` `contributes.commands`, category `"NEAR AI"`, title style `Staff: ...`): Make This Staff Project Multi-User, Invite to Staff Project, Join Staff Project, Admit (Staff Project member), Remove from Staff Project, Add My Other Machine, Choose Roster Branch, Make a Single-Machine Copy. They must not appear in the Staff Room's person-decision list (`PERSON_DECISION_COMMANDS`, `commands.ts:23`).
- Registration lives in a new `src/services/staffMultiUserCommands.ts` called from `registerStaffCommands` only when the setting is on, or registered always and checked inside (preferred: register always so enabling the setting needs no reload, check inside every handler).
- **D-29 parity test** modelled on `teamSoloParity.test.ts`: with the setting off (and with it on but no project converted), run a staff workload from `staffLedgerIntegrity.test.ts`, then assert the project tree and the SecretStorage key set equal a baseline taken before (no `.planning/staff/replica/`, no new keys beyond `nearAi.staff.ledgerHead.*`, no file changed), and that `require.cache` holds no module from `src/staff/replica/` (the cache check at `teamSoloParity.test.ts:21-26`).
- Command tests live beside the feature: `src/test/staffMultiUserCommands.test.ts` and `src/test/staffMultiUserManifest.test.ts` [ASSUMED names]. Every dialog shows `CLEARANCE_SELF_ASSERTED_TEXT` and `LABELS_NOT_ACCREDITATION_TEXT` [VERIFIED constants at `labels.ts:233,237`, already imported by `staffCommands.ts:7`] and the extra sentence in D-13.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Key agreement and wrapping | A custom box or lockbox | `node:crypto` X25519 + `hkdfSync` + AES-256-GCM with the info as salt and AAD | Verified to work; bound to cell, epoch and device |
| Signing invites, requests, grants, marks | A second signature format | `signPayload` / `verifyPayload` with a new purpose | One signer, purpose is inside the signed bytes (`signedPayload.ts:9-16`) |
| Canonical JSON for hashes and MACs | `JSON.stringify` | `canonicalBytes` / `canonicalize` (`../team/canonical`) | Same bytes everywhere |
| Cross-window lock | A pid file | `withFileLock` | Stale takeover, refresh, tested (`stateMirrorLock.ts`) |
| Atomic project file writes | write then hope | `writeIfUnchanged` (`staffFiles.ts:64`) | Compare-and-swap against a member's own write |
| One device identity per install | A second creation path | `loadOrCreateDeviceIdentity` and its lock | Two windows, one key |
| Reading a Yjs update | A full Yjs parser | The strict skim (only refs 0, 1, 4 allowed) then the vendored decoder | The skim only counts; Yjs stays the only decoder |
| Word list | A hand-made list | BIP-39 English, hash-pinned | Reviewed list with distinct 4-letter prefixes |
| Equivocation, chain, order | New logic | existing `chain.ts`, `equivocation.ts`, `order.ts` with small extensions | Already property-tested |
| Time-based expiry | `Date.now()` in the fold | `body.at` of the admit vs `expiresAt` | Determinism |

**Key insight:** every hard property here (determinism, authority at the cited roster, no clock, no Yjs outside `doc.ts`) is already enforced by Phase 30's structure; the new code stays pure and the host code stays thin.

## Common Pitfalls

### Pitfall 1: A fresh `ReplicaContext` per call
**What goes wrong:** every `addEntries` call refolds from the start. **Why:** `next !== state.ctx` counts as a change (`fold.ts:424-427,434,443`). **Avoid:** the store owns one context object and replaces it only when the roster, key ring or clock source truly changed. **Warning sign:** `FoldState.refolds` rising on every delivery.

### Pitfall 2: Circular key delivery
**What goes wrong:** the base key is needed to read the roster entry that delivers it. **Avoid:** the welcome file carries the base grant outside the stream (Pattern 2).

### Pitfall 3: Epoch 0
**What goes wrong:** the test world uses epoch 0, the schema requires `>= 1` for `cell.rekey` (`roster.ts:93`). **Avoid:** real keys start at epoch 1; keep helper default 0 only in tests.

### Pitfall 4: Re-sealing an import
**What goes wrong:** a retried migration builds a new ciphertext for the same plaintext and so a second signed header at the same seq, which is equivocation (`entry.ts:10-11`). **Avoid:** look up the existing entry for `(ledger, legacyHead, count)` before building, and persist the built entry before any later step.

### Pitfall 5: Assuming every legacy ledger has a mark
**What goes wrong:** treating `decisions.jsonl`, `calculator.jsonl` and the wargame ledger like `products.jsonl`. **Avoid:** the table above; wargame has no signature at all.

### Pitfall 6: Signed shifts in client ids
**What goes wrong:** `slot << 20` is negative for slots above 2047. **Avoid:** multiply and `>>> 0`, and test slot 4095 with counter 1048575.

### Pitfall 7: Deleting a SecretStorage value as if it were a file
**What goes wrong:** forgetting the join secret on a void or use is fine, but forgetting a key that has no other copy loses the device. **Avoid:** keys are only added and rotated; the join secret is the only value the host deletes, and only after a roster entry records the outcome.

### Pitfall 8: Preview off but module loaded
**What goes wrong:** requiring `src/staff/replica/*` at activation breaks D-29's "nothing created" rule and the parity check. **Avoid:** load lazily inside handlers, as `teamCommands` does.

## Code Examples

### Strict pre-decode skim (verified prototype)
```ts
// Source: scratchpad skim.cjs, validated against Y.decodeUpdate on honest updates and refusing a 131072-struct probe
function varuint(b: Uint8Array, p: number): [number, number] | undefined { /* at most 8 bytes, bounds checked */ }
export function skimUpdate(bytes: Uint8Array, maxStructs: number): { ok: true; structs: number; ranges: number } | { ok: false; error: 'malformed' | 'too-large' | 'forbidden-content' } {
  // groups -> per group: count (refuse when total > maxStructs), client, clock; per struct: info byte,
  // ref 0 -> varuint len; ref 1 -> items with deleted content; ref 4 -> varString; any other ref -> forbidden-content
  // delete set -> count ranges, refuse above maxStructs
}
```

### Client id from slot (item 2)
```ts
export const CLIENT_COUNTER_BITS = 20;
export const MAX_SLOT = 4095;
export const clientIdOf = (slot: number, counter: number): number => slot * 2 ** CLIENT_COUNTER_BITS + counter; // not <<
export const slotOfClientId = (clientId: number): number => Math.floor(clientId / 2 ** CLIENT_COUNTER_BITS);
```

### Worker host with limits
```ts
// Source: verified by worker2.cjs
const worker = new Worker(path.join(__dirname, 'decodeWorker.js'), {
  workerData: { bytes },
  resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
});
worker.once('error', (error) => resolve({ error: (error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too-large' : 'malformed' }));
```

### Cross-window lock
```ts
// Source: src/services/stateMirrorLock.ts:190, pattern at staffHost.ts:332
await withFileLock(storeDir, 'replica.lock', async () => { /* append, then update marks */ });
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Client id chosen by the registrant, first claim wins | Id range derived from a roster slot | This phase | Race impossible by construction |
| Checkpoint heads as `{writer, seq, hash}` | v2 heads with lamport and roster | This phase | A joiner's log can start after a checkpoint |
| One 4 MiB limit everywhere | 256 KiB updates, 2 MiB states, pre-decode skim | This phase | Bounded allocation before decode |
| Single-machine ledgers, one chain | Replica fold with projections | This phase | Opt-in per project |

**Deprecated/outdated:** `updateClients` in `doc.ts` (unused). The review's line numbers (see the table above for current ones).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Roster stream id equals the genesis `project` id | Roster fold | Low: any fixed rule works, but hub and clients must agree |
| A2 | Grants are signed objects outside the entry streams, committed by hash from `cell.create` and `cell.rekey` | Pattern 2 | High if rejected: changes the roster schemas and the welcome file; D-22 wording allows both |
| A3 | First epoch is 1 | Roster schema | Low |
| A4 | Slot (12 bits) and counter (20 bits) client id derivation | D-03 | Medium: a different split changes device and per-device limits |
| A5 | BIP-39 English list licence is the BIP's MIT | Safety code | Medium: if the list needs separate attribution, add it; fallback is the EFF list with CC BY attribution |
| A6 | EFF lists are CC BY 3.0 | Alternatives | Low (not chosen) |
| A7 | Store at `.planning/staff/replica/` with a self-ignoring `.gitignore` | Store | Medium: CONTEXT D-27 suggests this path; the ignore file is my addition |
| A8 | New kind `invite.void` (51 kinds) | Roster schema | Low: test counts updated |
| A9 | Byte limits 256 KiB (update) and 2 MiB (state); `MAX_STRUCTS` stays 100,000 | D-05 | Medium: a larger real paste or product needs a higher limit |
| A10 | A 30-page full state has well under 100,000 structs | D-05 | Medium: measure before freezing |
| A11 | "1.16 GB" figure is unreproducible; use a measured probe | D-05 | Low |
| A12 | `roster.choose` encoding (chosen child cites the split point) | Roster fold | Low |
| A13 | `device.quarantine` has no state effect beyond a record | Roster fold | Medium: owner may want manual quarantine |
| A14 | A copy records others' approvals under the copier's key with a name note | Single copy | High: affects what "approved" means in the copy |
| A15 | Random 96-bit IV safe to about 2^32 seals per epoch key | Cell keys | Low |
| A16 | New devices get wraps for every earlier epoch of their cells | Pattern 2 | Medium (Open Question 3) |
| A17 | SecretStorage name `nearAi.identity.encryptionKey` and mark key prefix `nearAi.staff.replicaMarks.` | Keys, marks | Low |
| A18 | Deputy may choose when the lead has no active device (applied literally from D-09) | Roster fold | Medium |

## Open Questions

1. **Late joiners and non-text state.**
   - What we know: D-04 lets a chain start at `head.seq + 1`; v2 heads give lamport and roster; text can load from a compaction.
   - What's unclear: versions, decisions and registrations written before the checkpoint cannot be rebuilt without the prefix entries, and a dep that names a covered non-head entry stays held.
   - Recommendation: implement exactly the D-04 chain acceptance, keep the conservative hold, document it, and let Phase 32's hub serve the prefix on demand; test that the post-checkpoint order equals the full fold's suffix.
2. **What a copied approval means.**
   - What we know: the ledger forbids a person actor whose fingerprint is not the signer's.
   - What's unclear: whether the owner accepts "approved in the shared project, carried by <copier>" as honest wording.
   - Recommendation: take it unless the owner objects; never carry a contested decision as approved.
3. **Earlier-epoch wraps for new devices.** Recommend yes (history stays readable); the owner may prefer "only from now on" for tighter need-to-know.
4. **Store location vs git.** Recommend the ignored folder under `.planning/staff/replica/`; alternative is extension storage outside the project (safer vs git, loses "under the project" in D-27).
5. **`device.quarantine` semantics.** DESIGN 15.2 triggers quarantine by an equivocation proof, not by an entry; recommend record-only.
6. **Deputy choose rule.** D-09 says "when the lead's devices are revoked or the lead has handed over"; a deputy cannot act when the lead is merely unreachable. Confirm that is intended.
7. **Where the pin lives.** Team Mode keeps its trust pin in extension storage (`teamFile.ts:218-230` `projectTrustDir`); recommend the same for the genesis pin, outside the project, plus `project.json` as a convenience copy.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | yes | v24.22.3 | none needed |
| `node:worker_threads`, `node:crypto` X25519/HKDF | worker, keys | yes (ran) | built in | none |
| TypeScript (`node_modules/typescript/bin/tsc`) | tests | yes | repo pin | none |
| `systemd-run`, `choom`, `flock`, `timeout` | capped test runs | yes (used this session) | n/a | none |
| Vendored Yjs bundle | fold, worker | yes after compile (`vendor/yjs/yjs.cjs` produced here) | 13.6.33 | `node scripts/vendor-libs.mjs` |
| Network (BIP-39 file) | one-time word list fetch | yes | n/a | the list is committed, no runtime fetch |

**Missing dependencies with no fallback:** none. **Missing with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` with `node:assert/strict`, compiled by `tsc` to `dist/test/`, run by `scripts/run-tests.mjs` (spawns `node --test` with a per-run TMPDIR) [VERIFIED: ran this session, 15 tests pass] |
| Config file | `tsconfig.json` (`rootDir src`, `outDir dist`); no separate test config |
| Quick run command | `flock "${HEAVY_LOCK:-/home/aaron/.cache/claude-code-tmp/claude-1000/-home-aaron-projects-codequity-near-ai-vscode/3d22e8c9-071a-44b3-b6fc-358cc97299ea/scratchpad/heavy.lock}" systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'node scripts/vendor-libs.mjs && node node_modules/typescript/bin/tsc -p tsconfig.json && node scripts/run-tests.mjs dist/test/<file>.test.js'` (the tests are under **dist/test**, not out/test; a single file is compile then `run-tests.mjs` on the compiled file; run exactly this form for the replica boundary, vector and chain files) |
| Full suite command | the same wrapper with `MemoryMax=6G`, `timeout 1800`, around `sh -c 'npm test'` once at the end (Phase 30 plans used exactly this; `npm test` is `npm run compile && node scripts/run-tests.mjs dist/test/*.test.js scripts/test/*.test.mjs`) |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command (after the wrapper above) | File Exists? |
|--------|----------|-----------|---------------------------------------------|-------------|
| MUS-04 | Genesis, origin roster, anchor; every 15.1 transition by name (invite, join-requested, expired, voided, admit, update, remove, split, choose); device 15.2 transitions (add, rotate, revoke, quarantine, release) | unit and property | `dist/test/replicaRoster.test.js` | Wave 0 |
| MUS-04 | Lead handover, deputy named and deputy limits, deputy cannot `deputy.name`; split and choose by lead or deputy; entry citing an unchosen branch held `roster-branch-not-chosen` | unit | `dist/test/replicaRosterSplit.test.js` | Wave 0 |
| MUS-04 | Invite file, join request, MAC, expired, reused, voided, wrong-secret, wrong-project, tampered files; six words equal on both sides and different when any key changes | unit | `dist/test/replicaInvite.test.js`, `dist/test/replicaSafetyCode.test.js` | Wave 0 |
| MUS-04 | Tracer: genesis, invite, join, same code, admit, one grant opened by the new device, one `doc.update` accepted through the real roster view | integration | `dist/test/replicaRosterTracer.test.js` | Wave 0 |
| MUS-04 | D-03 slot ranges, `foreign-client-id`, slot 4095 edge, Phase 30 static roster unchanged | unit | `dist/test/replicaClientIds.test.js` | Wave 0 |
| MUS-04 | D-04 v2 checkpoint, v1 vector unchanged, joiner chain admitted, order suffix equal | unit | `dist/test/replicaCheckpointHeads.test.js`, `dist/test/replicaVectors.test.js` | Wave 0 and existing |
| MUS-05 | Wrap and unwrap, wrong device, wrong info, wrong epoch, low-order key, grant signature and hash commitment, grantees per cell, rekey on remove, revoke, lowering; sentence text | unit | `dist/test/replicaCellKeys.test.js` | Wave 0 |
| MUS-05 | Label leak: two cells, two devices; the other cell's grant and stream never reach a device | integration | `dist/test/replicaCellLeak.test.js` | Wave 0 |
| MUS-05 | Key ring from grants; SecretStorage never holds the private key in a project file | host | `dist/test/staffReplicaKeyring.test.js` | Wave 0 |
| Hardening (D-01, D-02) | (a) to (d), WR-01..WR-09, IN-01..IN-03, each with a test that fails on the old code | unit and property | the existing `replicaDoc`, `replicaEquivocation`, `replicaChain`, `replicaReevaluation`, `replicaVersions`, `replicaDecisions`, `replicaVersionDecisions`, `replicaForbiddenActs`, `replicaConvergence`, `replicaIntegration` files, extended | exist |
| D-05 | Skim, limits, worker OOM mapping, heap ceiling, `deletesCovered` linear | unit and host | `dist/test/replicaUpdateGuard.test.js`, `dist/test/staffReplicaWorker.test.js` | Wave 0 |
| MUS-06 | Store append, torn tail, lock across two processes, marks, rollback refused, oversize blob refused | host | `dist/test/staffReplicaStore.test.js` | Wave 0 |
| MUS-06 | Verify first (broken ledger stops with today's wording), import entries, legacy blobs re-verify with today's verifier, reconstruct, idempotent with interruption at every step, files moved not deleted | host | `dist/test/staffReplicaMigration.test.js` | Wave 0 |
| MUS-06 | Projection of a migrated project equals today's files for the same history | host | `dist/test/staffReplicaProjection.test.js` | Wave 0 |
| MUS-06 | Single-machine copy verifies with today's verifier, shared project untouched, contested carried | host | `dist/test/staffReplicaCopy.test.js` | Wave 0 |
| MUS-06 | Parity: preview off or project not converted creates nothing; today's staff tests unchanged | host | `dist/test/staffReplicaParity.test.js` plus `dist/test/staffLedgerIntegrity.test.js`, `staffBranchLedger.test.js`, `staffRelease.test.js`, `staffProducts.test.js` | Wave 0 and existing |
| MUS-06 | Commands and manifest gate; every refusal says what happened and what to do | unit | `dist/test/staffMultiUserCommands.test.js`, `dist/test/staffMultiUserManifest.test.js` | Wave 0 |
| Boundary | New pure files obey the import boundary; hub-side list extended; no `vscode` in `src/staff/replica/decodeWorker.ts` | unit | `dist/test/replicaBoundaries.test.js` (extend) | exists |

### Sampling Rate
- **Per task commit:** the task's own compiled test file under the 4G capped wrapper (about 30 to 60 s with the 16 s type check).
- **Per wave merge:** every `dist/test/replica*.test.js`, `teamSignedPayload.test.js`, `teamBoundaries.test.js`, `staffRelease.test.js`, `staffLedgerIntegrity.test.js`, `staffBranchLedger.test.js` (Phase 30's wave set plus the staff ledger set).
- **Phase gate:** full suite once under the 6G wrapper, then `npm run verify:release` once (checks the worker file is packaged). Security, authorization, data-integrity and migration tests are immediately blocking in the task that touches them.

### Wave 0 Gaps
- [ ] New test files listed above (none exist); a `replicaRosterWorld` helper (new helper file, not an edit of `replicaWorld.ts`, which says plans add their own helpers) that builds a real roster stream with a lead, a deputy and members from fixed-label keys
- [ ] `test/fixtures/replica/vectors.json`: add `checkpointV2` (old sections untouched) and, if kinds change, new roster kind vectors
- [ ] Updates to pinned counts in `replicaTracer.test.ts`, `replicaContracts.test.ts`, `replicaKinds.test.ts` for `invite.void`
- [ ] `agentSeats` option in `test/helpers/replicaWorld.ts` and the five verdict-writing test files (P-iface and P-versions)

## Security Domain

`security_enforcement` is not set to false in `.planning/config.json` (absent means enabled).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (device and invite authentication; no passwords) | Ed25519 device signatures, HMAC under a one-time secret with constant-time compare, safety code, roster admission |
| V3 Session Management | no | not applicable in this phase (hub sessions are Phase 32) |
| V4 Access Control | yes | Roster authority at the cited roster hash; lead and deputy only write the roster; cell grants only to cleared devices; `canRunAgent` default deny |
| V5 Input Validation | yes | Closed-key schemas (`kindSchemas/`), strict skim before decode, byte limits, hostile file parsers for invite, join, legacy ledgers; own-property reads, no spread of parsed input |
| V6 Cryptography | yes | `node:crypto` X25519, HKDF-SHA256, AES-256-GCM, Ed25519; never hand-rolled; random IVs; keys in SecretStorage |
| V8 Data protection | yes | No private key, join secret or opened epoch key in the project folder, logs or bundle files |
| V12 Files and resources | yes | Atomic writes, symbolic-link refusal when writing under the project (pattern `safeDir`, `logisticsHost.ts:47`), size limits on every read |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Invite replay (second join with a used invite) | Spoofing | `member.admit` applies once per invite id; `invite-used` refusal in the fold and the host; secret deleted from the lead's SecretStorage on use |
| Wrong or guessed join secret | Spoofing | HMAC over canonical fields with 256-bit secret, `timingSafeEqual`; refused `wrong-secret` with a plain message |
| Stolen invite file with the secret | Spoofing, Tampering | Safety code compared out of band; Admit refused without the lead's confirmation; short expiry (default 7 days) and void |
| Key substitution on the joining device | Tampering | Both keys inside the code; `x25519Sig` proves the device holds the signing key for that encryption key; roster entry signed by the lead |
| Wrap to an uncleared or revoked device | Information disclosure | Grants signed by the lead or deputy; fold checks each wrap names a device admitted at the cited roster; wraps bound to cell, epoch, device by HKDF info and AAD; rekey omits removed devices |
| Wrap copied to another device or cell | Information disclosure | A changed info or device fails GCM authentication (verified) |
| Low-order X25519 public key | Tampering | `diffieHellman` rejects it (verified); also validate the length is 32 |
| Store rollback or deletion (git checkout, restored image) | Tampering, Repudiation | Signed SecretStorage marks per (stream, writer) and roster head; refuse a shorter or different history; the store folder is self-ignored by git |
| Hostile update (decode bomb, deep nesting, huge delete set) | Denial of service | Byte limits, strict skim (refuses all but GC, deleted and string content), struct and range caps, worker with `resourceLimits`, timeout, blob size gate before decrypt |
| Oversized blob | Denial of service | Gate on `BLOB_MAX_BYTES` at the store and before `openBlob` in the reducers (new defect 1) |
| Roster split abuse (a lead or deputy device writes a competing entry) | Elevation of privilege | Both branches pending, nothing applies until the lead (or deputy when the lead has no active device) chooses; entries citing a pending branch held `roster-branch-not-chosen` and kept |
| Deputy abuse (deputy revokes the lead and takes over) | Elevation of privilege | Deputy named only by the lead, cannot `deputy.name`; a deputy-signed handover must carry `reason: 'lead-lost'`; invariants block revoking the last lead device without a handover; the act is visible in the roster and shown by Phase 33; residual: a malicious deputy can still win while the lead is offline (owner decision 5 accepts re-founding as the last resort) |
| Agent labels itself as a gate agent | Spoofing | WR-01 `canRunAgent`; WR-02 `agent-cannot-decide` on governance acts |
| Client id race | Spoofing | D-03 slot ranges make a foreign id refusable by roster alone |
| Declared clearances mistaken for verified | Repudiation | Self-declared and not-accreditation texts on every screen and result (D-13) |
| Secrets in logs or error text | Information disclosure | Refusal messages never include a secret, key or MAC; tests grep command output |

## Sources

### Primary (HIGH confidence)
- In-repo code read this session: `src/domain/replica/*` (`fold.ts`, `textFold.ts`, `doc.ts`, `equivocation.ts`, `chain.ts`, `checkpoint.ts`, `verify.ts`, `entry.ts`, `projectFold.ts`, `versions.ts`, `decisions.ts`, `causal.ts`, `kinds.ts`, `kindSchemas/*`, `rosterView.ts`), `src/staff/staffHost.ts`, `staffFiles.ts`, `registerLock.ts`, `logisticsHost.ts`, `src/team/identity.ts`, `src/services/stateMirrorLock.ts`, `src/domain/staff/ledger.ts`, `personDecisions.ts`, `wargame.ts`, `src/domain/team/signedPayload.ts`, `src/domain/gate/labels.ts`, `dominance.ts`, `package.json`, `tsconfig.json`, `.vscodeignore`, `scripts/run-tests.mjs`, `scripts/verify-release-content.mjs`, `SECURITY.md`.
- Yjs 13.6.33 and lib0 source in `node_modules` (`yjs/src/utils/encoding.js`, `UpdateDecoder.js`, `DeleteSet.js`, `structs/Item.js`): update layout.
- Scratch runs this session against `dist/` and the vendored bundle (probes, wraps, worker limits, findings a, c, d).
- `.planning/research/multiuser-sync/DESIGN.md` sections 4.6, 7, 8, 10.2, 13, 14, 15, 16, 17, 18, 19, 21; Phase 30 REVIEW, REVIEW-FIX, UAT, VERIFICATION, CRDT-SPIKE.

### Secondary (MEDIUM confidence)
- BIP-39 header (License: MIT) and `english.txt` (2048 words) from raw.githubusercontent.com/bitcoin/bips/master (fetched this session).
- EFF wordlist article (eff.org/deeplinks/2016/07/new-wordlists-random-passphrases): list sizes 1,296 words, unique 3-character prefix on the second short list; it did not state a licence.

### Tertiary (LOW confidence)
- NIST guidance on random GCM IV limits and the EFF list licence: training knowledge, marked `[ASSUMED]`.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, nothing new beyond Node built-ins; every API ran.
- Architecture: MEDIUM, the grant-as-object and origin-roster resolutions are design choices consistent with D-22 and the code.
- Pitfalls: HIGH for those found by running code; MEDIUM for the migration projection adapter (not prototyped).

**Research date:** 2026-11-19
**Valid until:** 2026-12-19 (stable internal code; re-check line numbers if Phase 32 work lands on `main` first)

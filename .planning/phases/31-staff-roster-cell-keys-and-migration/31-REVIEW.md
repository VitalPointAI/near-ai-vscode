---
phase: 31-staff-roster-cell-keys-and-migration
reviewed: 2026-11-20T07:09:32Z
depth: deep
files_reviewed: 22
files_reviewed_list:
  - src/staff/replica/keyring.ts
  - src/staff/replica/store.ts
  - src/staff/replica/marks.ts
  - src/staff/replica/replicaProject.ts
  - src/staff/replica/membership.ts
  - src/staff/replica/migrate.ts
  - src/staff/replica/projection.ts
  - src/staff/replica/singleCopy.ts
  - src/staff/replica/decodeHost.ts
  - src/staff/replica/decodeWorker.ts
  - src/domain/replica/cellKeys.ts
  - src/domain/replica/invite.ts
  - src/domain/replica/safetyCode.ts
  - src/domain/replica/roster.ts
  - src/domain/replica/rosterMembers.ts
  - src/domain/replica/rosterCells.ts
  - src/domain/replica/updateGuard.ts
  - src/domain/replica/clientIds.ts
  - src/domain/team/signedPayload.ts
  - src/domain/staff/multiUser.ts
  - src/staff/staffHost.ts
  - src/services/staffMultiUserCommands.ts
findings:
  critical: 2
  major: 9
  minor: 5
  info: 2
  warning: 14
  total: 18
status: issues_found
---

# Phase 31: Code Review Report

**Reviewed:** 2026-11-20T07:09:32Z
**Depth:** deep (cross-file: keyring -> replicaProject -> membership -> commands; store -> marks; migrate -> projection)
**Files Reviewed:** 22 (non-test source; the smaller diffs in staffHost.ts, logisticsHost.ts, watchHost.ts, staffCommands.ts, multiUser.ts, commands.ts, secrets.ts and signedPayload.ts were read as diffs; chain.ts and verify.ts diffs were skimmed)
**Status:** issues_found

Severity mapping for the frontmatter: CRITICAL = `critical`; MAJOR and MINOR are both `warning`-tier (counted separately as `major` and `minor`); INFO = `info`. Necessity (`necessity:`) was not assessed: the caller asked for the CRITICAL/MAJOR/MINOR/INFO scheme.

## Summary

The pure roster fold (roster.ts, rosterMembers.ts, rosterCells.ts) is careful: authority is checked at the head, splits hold, grants are placed only when a roster writer signed them and the recipients are admitted. The problems are where host code trusts what the fold would have refused, and in the state machines' failure edges:

1. The device key ring opens and permanently caches any self-signed cell grant, bypassing every roster check the fold makes, and keeps the first key it sees per (cell, epoch). A forged grant pre-plants an epoch key; this device then seals its own writes under a key the attacker chose. Proven with a script against `dist/` (CR-01).
2. The store takes an unsigned entry that claims to be this device's own and uses it as this device's chain head, so one injected line permanently blocks this device's writes in that stream (for the lead's roster stream: no removals, no rekeys). Proven (CR-02).
3. Several flows can leave stuck states that no command recovers: the welcome is lost after admission because the join secret is forgotten first; an interrupted removal leaves cells not rekeyed; only the founding device can ever invite; a rolled-back or damaged store, or a store with more than about 1,170 (stream, writer) files, can never be opened or written again.
4. The six-word safety code is symmetric in attacker-controlled inputs, so a two-sided file MITM needs about 2^33 hashes, not 2^66.

Proof scripts (run against the existing `dist/`, no recompile, memory-capped) are in the session scratchpad `p31review/cr01.js`, `cr02.js` and `mark.js`. Outputs:
- cr01: `readGrant ok (any signer): true`, `ring holds attacker key for epoch 2: true`, `legit grant later opened: 0`, `addOwn of a different key for same epoch keeps old: true`.
- cr02: after `ingestForeign` of an unsigned entry claiming this writer at seq 999, `store.head` is seq 999 and the honest next `appendOwn` (seq 1) is `refused: 'out-of-order'`.
- mark: 1000 heads written; 1300 heads `Nothing was signed: the payload is 283739 bytes, which is over the 262144 byte limit.`

## Critical Issues

### CR-01: The key ring opens any self-signed grant and keeps the first key per epoch, so a forged grant decides which key this device writes with

**File:** `src/staff/replica/keyring.ts:149-168` (openGrants), `:171-179` (addOwn); callers `src/staff/replica/replicaProject.ts:407`, `:494`, `:574`, `:688`; `src/domain/replica/invite.ts:347-351` (readWelcome); `src/domain/replica/cellKeys.ts:194-207` (readGrant)
**Issue:** `readGrant` only checks that a grant is signed by the key embedded in it ("who signed it ... is the roster fold's question"). `DeviceKeyRing.openGrants` never asks that question: it opens every wrap addressed to this device and adds the key if `(cell, epoch)` is not held yet (`if (this.keys.has(id)) continue`). The ring is persisted to SecretStorage and never replaced. Wraps use the recipient's public X25519 key from the roster, so anyone can make one.

Grants reach the ring from: every file in `.planning/staff/replica/grants/` on each `state()` (`loadGrants`, line 688), the welcome file before any roster fold (`joinFromWelcome` line 407, `receiveWelcome` line 574; the welcome is unsigned and readWelcome checks only the grant's self-signature), and `putGrants`.

Consequences:
- An attacker (a removed member who can still drop a file in a shared folder, anyone who can alter the welcome in transit, a planted file) pre-plants a grant for the *next* epoch of a cell (epochs are sequential and predictable). When the lead later rekeys (for example to cut that removed member off), this device ignores the real grant (`openGrants` returns 0) and `buildOwn` (`replicaProject.ts:746-748`) seals this device's new entries under the attacker's key. The rekey that D-23 promises ("They will not receive anything new") is defeated, and other members cannot read this device's writes.
- Two grant files for one (cell, epoch) are opened in file-name order, so different devices can end with different keys for the same epoch.
- `rosterCells.addGrant` correctly refuses these grants (`grant-signer`, `grant-mismatch`, `grant-epoch-unknown`), but the ring has already taken the key, so the refusal protects nothing.

There is no test for a grant from a non-roster signer (`src/test/staffReplicaKeyring.test.ts` only uses lead-signed grants).
**Fix:** Make the roster fold the only gate into the ring, and key ring slots by the committed grant, not by (cell, epoch):
```ts
// keyring.ts: open only grants the roster fold placed (or the founding grant whose hash the pinned genesis commits to)
public async openPlaced(roster: RosterState): Promise<number> {
  let added = 0;
  for (const record of roster.cells.cells.values()) for (const placed of record.grants) {
    const committed = record.epochs.find((e) => e.epoch === placed.epoch)?.grant;
    if (committed === undefined) continue;
    const mine = placed.grant.wraps.find((w) => w.writer === this.device.writer);
    if (!mine) continue;
    const key = unwrapEpochKey({ cell: placed.grant.cell, epoch: placed.epoch, writer: this.device.writer, privateKey: this.device.privateKey, wrap: mine.wrap });
    if (!key) continue;
    const held = this.keys.get(ringId(placed.grant.cell, placed.epoch));
    if (held && !held.equals(key)) { /* replace: the placed grant wins; record a warning */ }
    ...
  }
}
```
Bootstrap (the base cell key is needed to read the genesis that commits to its grant): open candidate base-cell keys into a scratch ring, fold the roster, and keep only the key whose founding grant hash equals the genesis commitment. Stop calling `openGrants` from `loadGrants`, `receiveWelcome`, `joinFromWelcome` and `putGrants` on unplaced grants. Never let `addOwn` silently keep a different key (see MJ-04). Add tests: a grant signed by a non-roster key is never opened; a pre-planted next-epoch grant does not stop the real rekey grant.

### CR-02: An unsigned entry that claims this device's writer id becomes this device's chain head, blocking its writes for good

**File:** `src/staff/replica/store.ts:328-332` (head), `:396-407` (appendOwn follows check), `:425-437` and `:713-725` (ingestForeign and take: shape and body hash only); `src/staff/replica/replicaProject.ts:749-759` (buildOwn uses `store.head` as seq and prev), `:728-738` (lamportOf)
**Issue:** `parseSealed` checks the header shape and the body hash, never the signature ("signatures are the fold's job"). `ingestForeign` and `catchUp` therefore index an entry whose `header.writer` is this device's writer id even though this device never signed it. `store.head(stream, ownWriter)` then returns that entry's seq and hash, and:
- `ReplicaStore.appendOwn` refuses the honest next entry `out-of-order` (proven: forged seq 999 -> honest seq 1 refused);
- `ReplicaProject.buildOwn` builds the next entry on top of the forged one (seq 1000, prev = forged hash) and signs it, so this device's genuine entry chains onto an entry the fold rejects and is held forever; if the forged body does not open, `lamportOf` throws and every write fails.
The store never deletes a line (P-31-17), so there is no recovery. For the lead's device in the roster stream this means no member.remove, device.revoke, cell.rekey or roster.choose can ever be written again. Phase 31 reaches it through the welcome file (`receiveWelcome` -> `ingestForeign`) and any file placed in `streams/<stream>/<ownWriter>.jsonl`; Phase 32 transports will reach it remotely.
**Fix:** The store knows this device's public key (`deps.signer()`); verify own-writer entries before they count:
```ts
// store.ts, in take() / ingestForeign(): an entry that names this device's writer must carry this device's valid signature
if (entry.header.writer === ownWriter && !verifyHeader(entry.header, ownPublicKey)) { this.damaged += 1; return; } // or hold it, never index it as a head
```
and compute `head()` for the own writer only from verified entries (or keep a separate verified own-head index). Add a test that a forged own-writer line neither moves `head()` nor blocks `appendOwn`.

## Major Issues

### MJ-01: The six-word safety code falls to a two-sided MITM in about 2^33 work, not 2^66

**File:** `src/domain/replica/safetyCode.ts:1-10` (claim), `:29-45` (derivation); `src/domain/replica/invite.ts:243-250`; `src/staff/replica/membership.ts:441`, `:503`
**Issue:** Both screens hash `(invite, genesisHash, leadKeys, joinerKeys)` into 66 bits. In the attack the code exists for (someone who controls the file channel both ways), the joiner's screen shows `H(inv, gh', leadA, joinerReal)` with `leadA` (and `gh'`) chosen by the attacker in a fake invite, and the lead's screen shows `H(inv, gh, leadReal, joinerA)` with `joinerA` chosen by the attacker in a forged join request (the attacker holds the real invite, so the MAC is valid). The two sides are independent functions of attacker-chosen inputs, so a birthday collision on 66 bits costs about 2^33 SHA-256 calls per side (the X25519 halves can be varied freely and signed once at the end). A device's keys are one identity per install (D-19), so `joinerReal` is usually known in advance. The comment's "about 2^66 tries" assumes only one side is attacker-chosen. Result: the attacker's device is admitted to the real project while the joiner is sent into an attacker-made project.
**Fix:** Make each half depend on one party's keys only, and show both halves, so matching needs a second preimage per half:
```ts
// six words from the lead's keys + genesis + invite, six from the joiner's keys + invite (each a 2^66 second preimage)
const leadWords = words(sha256(DOMAIN, 'lead', inv, gh, lead.publicKey, lead.x25519));
const joinerWords = words(sha256(DOMAIN, 'joiner', inv, joiner.publicKey, joiner.x25519));
```
or add a commitment (the invite commits to a hash of a lead nonce revealed only after the join request, as ZRTP's SAS does), or lengthen the code to at least 132 bits. Correct the comment.

### MJ-02: An admitted person's welcome file can be lost for good: the join secret is forgotten before the welcome exists

**File:** `src/staff/replica/membership.ts:636-645`; `src/staff/replica/membership.ts:489-492` (checkRequest); `src/services/staffMultiUserCommands.ts:427-428` (deliver), `:203-213`
**Issue:** `admitJoinRequest` writes member.admit and the grants, calls `forgetJoinSecret` (line 638), and only then builds the welcome (`welcomeFor`, line 642). If `welcomeFor` throws (size, or `buildWelcome` throwing on any grant file in the lead's store that does not read, which anyone can plant because `store.grants()` checks only that a file's content hashes to its name), or the command cannot save the file (`deliver` warns "Ask for help to bring them in another way"), or the window dies before saving, re-running Admit hits `standing.state === 'used' && secret === undefined` -> `invite-used`. There is no command to make the welcome again, so the person is in the roster and holds grants but can never open the project. The only way out (remove, rekey, invite again) is not offered.
**Fix:** Forget the secret only after the welcome file has been saved (have the command call a `confirmWelcomeDelivered(invite)` step after `saveFile` succeeds), or add a "Make the Welcome File Again" path keyed on `usedBy` that does not need the secret (the lead already wrote the admission). Make `buildWelcome` skip and report a grant that does not read instead of throwing.

### MJ-03: An interrupted removal or clearance change leaves cells not rekeyed, and nothing can finish it

**File:** `src/staff/replica/membership.ts:759-762` (removeFromProject), `:797-813` (updateMember), `:681-711` (writeRekeys, which throws at line 699 for a recipient without an X25519 key)
**Issue:** member.remove / device.revoke / member.update is written first, then one cell.rekey per cell. If any rekey fails (store refusal, the throw at line 699, `buildGrant` over the 256 KiB payload cap for about 1,300 or more recipients, a crash), the result is a refusal but the member is already removed. Running Remove again is refused `member-unknown` (the member is gone), so the remaining cells keep the old epoch key, which the removed member holds: they keep receiving everything new in those cells, the opposite of D-23 and of the sentence the lead was shown.
**Fix:** Compute pending rekeys from the fold rather than the command's memory: a cell whose current-epoch grantees include a device not admitted at the head (granteesAt already filters by admission, so compare the founding grant's writers with the admitted set) needs a rekey. Offer "Finish Removing" (or run it at the start of every roster flow), and add a test that interrupts after member.remove and finishes the rekeys.

### MJ-04: A failed rekey leaves its key in the ring, and the next rekey of that cell keeps the stale key

**File:** `src/staff/replica/membership.ts:695-708`; `src/staff/replica/keyring.ts:171-179`
**Issue:** `writeRekeys` stores the new key (`addOwn`) and its founding grant before appending cell.rekey. If the append fails, epoch N+1's key K1 stays in the ring and its grant G1 stays in `grants/`. The next rekey of that cell again picks epoch N+1 with a new K2; `addOwn` silently keeps K1 ("An epoch already held keeps its key"), the committed grant G2 wraps K2, and the lead then seals under K1, which no recipient holds (recipients may open G1 or G2 depending on file order). Proven: `addOwn of a different key for same epoch keeps old: true`.
**Fix:** Reuse the key already held for epoch N+1 when it exists (wrap the held key, not a fresh one), or make `addOwn` replace an uncommitted key and refuse when the existing key belongs to a committed grant. Together with CR-01, key the ring by committed grant hash.

### MJ-05: Only the founding device can ever invite, so after a handover or the loss of that device nobody can be invited or add a machine

**File:** `src/staff/replica/membership.ts:327-329`; `src/domain/replica/invite.ts:148-161`, `:254-256`; `src/domain/replica/roster.ts:241-248`
**Issue:** The invite names the signing device as `lead` and the joiner pins that as its anchor, and the roster fold requires the genesis lead to equal the anchor, so `writeInvite` refuses every device but the founding one (`not-founding-device`). That includes the lead's own second machine, the deputy, and any new lead after `lead.handover`. D-10's handover exists for a lost lead; once the founding device is lost or revoked, the project can never admit anyone or add any device again (Add My Other Machine goes through `writeInvite` too).
**Fix:** Separate the project anchor from the inviter: the invite carries the genesis anchor (founding lead keys, as today) and is signed by any roster writer; the joiner pins the anchor, keeps the inviter key, and accepts the welcome only if the roster folded from the anchor shows the inviter as a roster writer at the invitation's roster entry. The safety code then covers the inviter's keys.

### MJ-06: A signed replica mark holds at most about 1,170 files, so a larger project can no longer be written

**File:** `src/staff/replica/marks.ts:23`, `:113-118`; `src/staff/replica/store.ts:410-411`, `:472-473`
**Issue:** `MAX_MARK_HEADS` is 100,000, but the mark is a signed payload capped at `MAX_PAYLOAD_BYTES` (256 KiB) and each head is about 224 bytes, so `writeMark` throws past about 1,170 (stream, writer) files (proven: 1,300 heads -> PayloadError). The throw comes after `appendLines` has written and fsynced the lines, so the mark stops advancing and every later `appendOwn`, `ingestForeign` and `recordRosterHead` throws. 30 people with 2 devices across 20 cells is already over the limit.
**Fix:** Sign a compact mark instead: one Merkle root or sha256 over the sorted heads in the signed payload, with the heads themselves in a second SecretStorage value (or chunked), and verify the hash on read. Or pass a larger `maxBytes` to both `signPayload` and `verifyPayload` for this purpose and align `MAX_MARK_HEADS` with it. Write the mark first (as intent) or make the append and mark failure-atomic.

### MJ-07: The decode worker check is skipped for entries whose key or blob arrives later, and its held list can be deleted

**File:** `src/staff/replica/replicaProject.ts:601-628` (foreignCheck returns PASS when the key or blob is missing); `src/staff/replica/store.ts:797-811` (loadHeld: a missing held.json is an empty list), `:640-679` (catchUp folds any line in streams/)
**Issue:** D-05 requires updates from outside to be decoded in the memory-capped worker before they reach the fold. An entry whose epoch key or blob is not on this machine yet is stored as passed, and when the key arrives (a later grant, D-45 earlier-epoch grants, a rekey) the fold decodes it on the extension host thread with no worker check. `held.json` sits in the project folder, outside the signed mark: deleting it releases every refused entry into the fold. Lines that reach `streams/` by copying files never meet the check at all. Only the fold's synchronous guard (256 KiB and the pre-decode skim) remains.
**Fix:** Record "not checked yet" as a held reason (`awaiting-key` / `awaiting-blob`) instead of PASS, keep such entries out of `entries()`, and re-run the check when `keys.version` or the blob set changes. Cover held.json with the signed mark (its hash), and treat a missing or changed held.json as `unreadable`. Check lines found by `catchUp` that were not written through `appendOwn`/`ingestForeign` (or record a checked set in the mark).

### MJ-08: "Rolled back" and "mark does not verify" are permanent: no command can ever reopen the shared project

**File:** `src/staff/replica/store.ts:293-310` (open), `:713-725` (a damaged line is not counted); `src/staff/replica/marks.ts:124-131`; `src/staff/replica/store.ts:61-62` (the refusal texts)
**Issue:** `compareWithMark` refuses a file whose distinct-entry count is below the mark's. A single line damaged later (disk error, an editor touching the file, `git clean -X`, which deletes this git-ignored folder) lowers the count and the store refuses `rolled-back` forever. The messages tell the person to restore a newer copy or "ask your staff lead", but the mark lives in this device's SecretStorage and the lead cannot change it; no command re-baselines the mark or rebuilds the store from other members. The staff host then shows no products for that project indefinitely.
**Fix:** Add a person-confirmed recovery ("Start This Computer's Shared History Again": move the store aside to `.planning/staff/replica.rolled-back-<time>/`, never delete it, reset the mark, and refetch from a welcome or, in Phase 32, the hub), and say exactly that in the refusal. Count damaged lines separately from missing ones so a damaged line is reported as damage, not rollback.

### MJ-09: Re-running an interrupted conversion after a product file was edited corrupts that product and overwrites the edit

**File:** `src/staff/replica/migrate.ts:446-458` (reconstruct), `src/staff/replica/projection.ts:531` (writeProjected with replace = true), `:505-514`
**Issue:** Reconstruct rebuilds each product's doc from scratch with the same client id (`clientIdOf(slot, counter)`) and inserts the file body from clock 0. The idempotence check compares update bytes, so a body that changed between runs (the person edited the `.md` file while the conversion was half done; the staff host refuses tool writes then but not editor edits) produces a second doc.update with the same (client, clock) range and different content. Yjs keeps the first content for already-known clocks and integrates only the tail past them, so the fold text becomes the old text plus a fragment of the new (or the update is refused). The projections step then writes that fold text over the edited file (`replace: true`), losing the edit.
**Fix:** On re-run, when doc.update entries already exist for a product, compare the fold text with the file body: if they differ, stop with a `product-changed` refusal (like `ledger-changed`) naming the file, or write the difference as an update from the existing document state (load the fold's doc, then apply the diff with the same client continuing from its current clock). Never overwrite a product file whose body differs from both the old fold text and the file read at reconstruct time.

## Minor Issues

### MN-01: Opening any invite pins its project for good; a bogus invite blocks the real one with no way out

**File:** `src/staff/replica/membership.ts:437`; `src/staff/replica/replicaProject.ts:373-381`
**Issue:** `joinFromInvite` writes the genesis pin from a self-signed invite before any safety-code check. A fake invite for a known project id makes every later real invite refuse `pin-mismatch`, and nothing removes a pin.
**Fix:** Write the pin only when the welcome is opened (keep the invite's anchor in a pending record until then), or let a person replace a pin that has no project folder joined to it after confirming.

### MN-02: Expired invitations disappear from the Remove list and their join secrets are kept forever

**File:** `src/services/staffMultiUserCommands.ts:266-268`; `src/staff/replica/membership.ts:379-394`
**Issue:** `readRoster` lists only invitations still open at the host clock, so an expired one can never be voided, its roster record stays "open", and its join secret stays in SecretStorage (only `used` and `voided` forget it).
**Fix:** List expired invitations as "expired, cancel to clean up" and let `voidInvite` accept them (the fold already allows void of an open record), or forget secrets of invitations past expiry when any roster flow runs.

### MN-03: Choose Roster Branch shows only a hash prefix, so the lead chooses blind

**File:** `src/services/staffMultiUserCommands.ts:487-491`
**Issue:** Each branch is shown as "Change N of M, entry <12 hex>". The lead cannot see which change is the admission, the removal or the handover, which defeats D-09's "the lead or the deputy must choose".
**Fix:** Open each branch's body with this device's key and describe it (kind, who it names, who wrote it, when), as the Staff Room will in Phase 33.

### MN-04: A grant for many devices exceeds the signed payload limit

**File:** `src/domain/replica/cellKeys.ts:38`, `:148-153`
**Issue:** `MAX_GRANT_WRAPS` is 4,095, but each wrap is about 190 bytes in the canonical payload, so `buildGrant` throws past roughly 1,300 recipients (the 256 KiB `MAX_PAYLOAD_BYTES`). In writeRekeys this throws after member.remove (see MJ-03).
**Fix:** Split a founding grant into several grants per epoch (all committed by a list of hashes), or pass a larger `maxBytes` for `staff-cell-grant` on both sign and verify, and set `MAX_GRANT_WRAPS` from it.

### MN-05: A rekey of a cell whose label this device cannot read drops the label from the new epoch

**File:** `src/staff/replica/membership.ts:702`
**Issue:** `labelSealed` is `''` when `info.raw` is undefined, so devices that hold only the new epoch can never read the cell's label; `clearedFor` then clears nobody for that cell, and future admissions silently skip it.
**Fix:** Refuse the rekey with `no-grant-key` when the label cannot be read (as `rekeyPlans` does for clearance changes), or carry the previous epoch's sealed label re-sealed by a device that can read it.

## Info

### IN-01: The roster choice uses the chooser's own clock

**File:** `src/domain/replica/roster.ts:327-329`
**Issue:** `latestChoice` orders allowed choices by the signed `at`, which the chooser's device sets. All allowed choices come from one member, so this is that person's word, but a device with a wrong clock can make an older choice win.
**Fix:** Prefer the choice with the higher lamport, then `at`, then hash.

### IN-02: The X25519 key is created in the identity folder lock but read outside it later

**File:** `src/staff/replica/keyring.ts:202-219`
**Issue:** Correct as written; noted because `loadOrCreateEncryptionKey` re-derives the binding signature on every call (cheap) and never checks that the stored key still matches the X25519 key the roster has for this device. After a SecretStorage reset a new key is made silently and every grant wrapped to the old key stops opening, with no message.
**Fix:** When a shared project is open, compare `x25519At(roster, deviceWriter)` with the local public key and say plainly that this computer's encryption key changed and the lead must add the device again.

---

_Reviewed: 2026-11-20T07:09:32Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_

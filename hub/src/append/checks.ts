// The append checks (D-39, D-42, D-43, D-44, D-26; DESIGN 10.7). For every entry a device offers, whether it is a valid next step of an admitted
// writer's log in a part of the project that writer may write. The checks run without Yjs and without any key but the hub's own: bodies of cells
// the hub does not hold stay ciphertext and are checked by clients. Only base-stream bodies are opened, with the base cell key granted to the hub.
//
// Order. Per batch, before anything costly: its shape and size, then the pushing device's token bucket (before any signature, Pitfall 7), then the
// project and the features it requires (needs-update when this hub lacks one, D-07), and in restore mode whether every entry is held or covered
// (restoring, D-32). Per entry, in order: header shape and
// size; the body's size and ciphertext hash; the stream is the project's; the writer's signature with its roster key; the writer admitted and neither
// revoked nor quarantined at the head (a device revoked since may still fill a place a kept checkpoint of this hub covers, WR-02); the writer on the
// stream's access list; the place (same hash again: held; another hash at a used seq: an equivocation proof, D-43; beyond the next seq: seq-gap;
// wrong prev: prev-mismatch); a blob the entry uses that the hub does not hold (blob-missing for that entry only, and its writer's later entries in
// the batch then meet seq-gap, D-28); and for base-stream entries the hub can open, a body that opens and, for roster kinds, a lead or deputy device at the
// roster the entry cites (D-11). A roster kind citing an older roster than the hub's head is stored: it is a concurrent branch the fold turns into a
// split (D-09), and refusing it would cut the writer's log at a seq gap for good (CR-01).
//
// One rule for what the hub cannot judge yet (CR-01, and its follow-up for epoch keys): an entry is refused only for a fault the hub can prove from
// what it holds, as verifyEntry rejects it; an entry verifyEntry would hold (no key for its epoch yet) is stored as the writer's log and the fold
// judges it when the key arrives. So a base-stream entry under an epoch whose grant to the hub has not come yet is stored as ciphertext the hub
// cannot read, the writer's later entries (a revocation among them) follow it, and the grant, when it comes, folds them all. Refusing it instead
// would leave that writer's base-stream log at a seq gap for good, and a retry would wait forever on a hub that is never granted the epoch.
// Entries of other cells are never opened here, so they already follow the rule; a missing blob refuses only the entry that uses it, so the client
// uploads the blob and sends that entry again while the rest of the batch is stored.
//
// Session keys (Phase 33 D-60, D-62): a writer that is not a roster device is checked with the key of the session.certify the fold placed for it. It
// is taken only while its certifying device stands and the hub's clock is before the certificate's notAfter (session-expired otherwise); a kind
// only the person key may sign is refused person-key-required wherever the hub can open the body; a certificate in the base stream refolds the
// overlay, so the session's own entries after it in the same batch are judged with it; and a device may hold LIMITS.liveSessionKeysPerDevice live
// certificates at a time (too-many-sessions).
//
// Cited evidence (71-09, evidencePep.ts): a base-stream entry the hub opens whose data carries `evidence` is checked with the fold's checkEvidence
// and then checkFreshness against the hub's newest lists, at the hub's clock; it is refused 'stale-evidence' when it cites a list replaced longer
// ago than the grace, and 'evidence-refused' (with the checker's own reason) when the cited credentials do not hold. After COMMIT the hub keeps the
// status entries of the credentials each member cited, so a later revocation refuses that member's sessions (session.ts).
//
// A batch is checked in order against an in-memory overlay (heads, places and a roster folded again after each roster entry), then written by
// commitBatch in one store transaction. Only after COMMIT does the overlay replace the cached roster, so a failed write accepts nothing (D-26).
// A roster entry the fold refuses is still stored, because it is the writer's log; the roster head simply does not move.
import { readGrant } from '@ext/domain/replica/cellKeys';
import { GENESIS_PREV, entryHash, openBlob, openBody, parseHeaderShape, sha256Hex, verifyHeader } from '@ext/domain/replica/entry';
import type { Actor, EntryHeader, SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import { canonicalProof, proofHash } from '@ext/domain/replica/equivocation';
import type { EquivocationProof } from '@ext/domain/replica/equivocation';
import { DEVICE_KEM_REFUSALS, deviceKemContext, deviceKemProblem } from '@ext/domain/replica/deviceKem';
import type { DeviceKemData } from '@ext/domain/replica/deviceKem';
import { missingFeatures } from '@ext/domain/replica/features';
import { WRAP_FEATURE, WRAP_FORMAT_REFUSALS, wrapFormatProblem } from '@ext/domain/replica/wrapFormat';
import { hubReplicaFeatures } from '../features';
import { validateBody, validateData } from '@ext/domain/replica/kinds';
import { ORIGIN_ROSTER, ROSTER_KIND_OWNER, ROSTER_REFUSALS, isRosterWriterAt, positionWriteProblem } from '@ext/domain/replica/roster';
import { POSITION_REFUSALS } from '@ext/domain/replica/rosterPositions';
import { SESSION_REFUSALS, isPersonKeyKind } from '@ext/domain/replica/sessionKeys';
import { canonicalize } from '@ext/domain/team/canonical';
import { LIMITS } from '../limits';
import type { CitedStatus, TrustStore } from '../store/trustStore';
import { carriesEvidence, checkEntryEvidence } from './evidencePep';
import type { RateLimits } from '../limits';
import type { BlobRef, EntryRow, EquivocationRecord, GrantInput, HubStore, StoredEntry } from '../store/hubStore';
import type { RestoreMode } from '../restore';
import type { Place, ProjectRoster, RosterCache } from './rosterCache';

export const APPEND_REFUSALS = {
  'malformed-batch': 'The append is not in a shape this hub can read.',
  'unknown-project': 'This hub does not hold that project.',
  'batch-too-large': 'The append holds more entries or grants than one append may. Send it in smaller parts.',
  'rate-limited': 'This device is sending entries faster than the hub takes them. Wait the time the hub gives, then send again.',
  'blob-missing': 'This entry uses a large part the hub does not hold. Upload that part, then send this entry again.',
  'malformed-header': 'The entry header is not in a shape this hub can read.',
  'unknown-header-version': 'The entry was written in a newer format than this hub reads. Update the hub.',
  'header-too-large': 'The entry header is larger than the hub accepts.',
  'body-too-large': 'The entry body is larger than the hub accepts inline. Put the large part in a blob.',
  'body-mismatch': 'The entry body does not match the size or the hash its header names.',
  'unknown-stream': 'The entry is for a part of the project this hub does not know at its roster.',
  'not-admitted': 'The device that wrote this entry is not in the project roster.',
  'bad-signature': 'The entry signature does not match its header and the key of the device that wrote it.',
  revoked: 'The device that wrote this entry was revoked or removed from the project, so the hub takes nothing more from it.',
  quarantined: 'The device that wrote this entry signed two different entries at one place, so the hub takes nothing from it until the staff lead releases it or revokes it.',
  'not-on-access-list': 'The device that wrote this entry holds no grant for this part of the project.',
  'seq-gap': 'The entry skips a place in its writer\'s log. Send the entries before it first.',
  'prev-mismatch': 'The entry does not follow the entry before it in its writer\'s log.',
  equivocation: 'The writer already signed a different entry at this place. The hub keeps the first one and has recorded both as proof.',
  'not-a-roster-writer': 'Only a device of the staff lead or the deputy lead may change the roster, and the device that wrote this was not one at the roster it follows.',
  'roster-unreadable': 'This entry of the roster part of the project does not open with the key its part names, or what it holds is not an entry.',
  'grant-not-placed': 'This cell grant does not fit the roster, so the hub does not keep it.',
  'stale-evidence': 'This entry relies on a status list that has since been replaced. Check again with the newest list, then send it again.',
  'evidence-malformed': 'The credentials and status lists this entry cites are not listed in a shape the hub can read.',
  'evidence-refused': 'The credentials this entry cites do not hold at the hub.',
  'needs-update': 'This shared work needs a newer version of your organization\'s server. Ask its operator to update it.',
  restoring: 'Your organization\'s server is being restored. Send this change again in a moment.',
  // Phase 33 D-60, D-62: a person's session key.
  'session-expired': 'Your session key has ended. Sign in again.',
  'person-key-required': SESSION_REFUSALS['person-key-required'],
  'too-many-sessions': 'This device already has as many live session keys as your organization\'s server allows. Wait for one to end, then sign in again.',
  // 33.2 D-03: a device's post-quantum key binding, checked with the fold's own function.
  ...DEVICE_KEM_REFUSALS,
  // 33.2 D-06: the cutover rule, the fold's own function.
  ...WRAP_FORMAT_REFUSALS,
  // Phase 33.1: positions and postings, judged by the fold's own rule (positionWriteProblem) at the roster the entry cites.
  'person-only': ROSTER_REFUSALS['person-only'],
  'roster-kind-pending': ROSTER_REFUSALS['roster-kind-pending'],
  'not-an-active-member': ROSTER_REFUSALS['not-an-active-member'],
  ...POSITION_REFUSALS
} as const;
export type AppendRefusal = keyof typeof APPEND_REFUSALS;

/** One append as the route hands it over. device is the writer id of the pushing device (its session). */
export interface AppendInput {
  project: string;
  device: string;
  entries: readonly unknown[];
  grants?: readonly unknown[];
  /** The blobs each entry uses (D-69): the hub cannot read sealed bodies, so the client names them. */
  blobRefs?: ReadonlyArray<{ entry: string; blob: string }>;
}

export interface AppendContext {
  store: HubStore;
  cache: RosterCache;
  limits: RateLimits;
  /** Milliseconds; the time stored with the batch and given to the buckets. */
  now: number;
  /** Signature check of one header with the writer's roster key; injectable so a test can count calls. */
  verify?: (header: EntryHeader, publicKey: string) => boolean;
  /** Your organization's trust host (71-09): with it, entries that cite evidence are checked; without it they are stored as today. */
  trust?: TrustStore;
  /** Restore mode (restore.ts, D-32, D-45): while active, a batch is taken only when every entry in it is held or covered. */
  restore?: Pick<RestoreMode, 'active' | 'allows'>;
}

export interface Refused {
  index: number;
  hash?: string;
  reason: AppendRefusal;
  message: string;
  /** For evidence-refused: the checker's own reason id (evidence.ts EVIDENCE_REFUSALS). */
  evidence?: string;
}

export interface CheckedEntry {
  index: number;
  hash: string;
  stream: string;
  writer: string;
  seq: number;
  row: EntryRow;
}

export interface CheckedBatch {
  project: string;
  /** Entries to store, in batch order. */
  entries: CheckedEntry[];
  /** Every entry the hub has after this batch, in batch order: the new ones and the ones it already held. */
  accepted: string[];
  /** The entries the hub already held (the same entry again). */
  held: string[];
  refused: Refused[];
  grants: GrantInput[];
  grantsRefused: Refused[];
  equivocations: EquivocationRecord[];
  proofs: EquivocationProof[];
  blobRefs: BlobRef[];
  /** The roster the batch was checked against, and the overlay that replaces it after COMMIT. */
  base: ProjectRoster;
  roster: ProjectRoster;
  rosterChanged: boolean;
  /** The status entries each member's stored entries cited, kept after COMMIT. */
  cited: Array<{ member: string; cited: CitedStatus[] }>;
}

export type CheckOutcome = { ok: true; checked: CheckedBatch } | { ok: false; reason: AppendRefusal; message: string; retryAfterSeconds?: number };

export interface AppendResult {
  project: string;
  accepted: string[];
  held: string[];
  refused: Refused[];
  grants: { stored: string[]; refused: Refused[] };
  equivocations: EquivocationProof[];
  rosterChanged: boolean;
  rosterHead: string;
  stored: StoredEntry[];
}

const refuseBatch = (reason: AppendRefusal, extra: { retryAfterSeconds?: number } = {}): CheckOutcome => ({ ok: false, reason, message: APPEND_REFUSALS[reason], ...extra });
const HASH = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The sealed body as bytes when it is exactly what the header names, else undefined. */
function bodyBytes(body: unknown, header: EntryHeader): Buffer | undefined {
  if (typeof body !== 'string' || body.length > Math.ceil((header.body.size * 4) / 3) + 4 || !BASE64URL.test(body)) return undefined;
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body || bytes.length !== header.body.size || sha256Hex(bytes) !== header.body.hash) return undefined;
  return bytes;
}

/** The header's JSON size in bytes as received, or undefined when it cannot be written as JSON. */
function headerSize(header: unknown): number | undefined {
  try {
    const text = JSON.stringify(header);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

interface OpenedBase {
  kind: string;
  roster: string;
  data: unknown;
  actor: Actor;
  at: string;
}

/** Why a base-stream body was not read: no key for its epoch yet (held: stored, judged by the fold later), its blob not held (the batch is sent
 *  again), or a body that does not open or parse with the key the hub holds (a fault: refused). */
type BaseRead = { ok: true; opened: OpenedBase; blob?: SealedBlob } | { ok: false; why: 'missing-key' | 'missing-blob' | 'unreadable' };

/** Opens a base-stream body with the hub's ring, reading its blob from the overlay or the store. */
async function readBase(roster: ProjectRoster, store: HubStore, project: string, header: EntryHeader, wire: Buffer, batchBlobs: Map<string, SealedBlob>): Promise<BaseRead> {
  const key = roster.ring(header.stream, header.epoch);
  if (key === undefined) return { ok: false, why: 'missing-key' };
  const plaintext = openBody(key, header, wire);
  if (plaintext === undefined) return { ok: false, why: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    return { ok: false, why: 'unreadable' };
  }
  const checked = validateBody(parsed);
  if (!checked.ok) return { ok: false, why: 'unreadable' };
  const body = checked.body;
  if (body.blob === undefined) return { ok: true, opened: { kind: body.kind, roster: body.roster, data: body.data, actor: body.actor, at: body.at } };
  let blob = batchBlobs.get(body.blob) ?? roster.blob(body.blob);
  if (blob === undefined) {
    const bytes = await store.readBlob(project, body.blob);
    if (bytes === undefined) return { ok: false, why: 'missing-blob' };
    blob = { hash: body.blob, bytes: bytes.toString('base64url') };
  }
  const opened = openBlob(key, header.stream, header.epoch, blob);
  if (opened === undefined) return { ok: false, why: 'unreadable' };
  try {
    return { ok: true, opened: { kind: body.kind, roster: body.roster, data: JSON.parse(opened.toString('utf8')) as unknown, actor: body.actor, at: body.at }, blob };
  } catch {
    return { ok: false, why: 'unreadable' };
  }
}

/** The kind of an entry whose body the hub holds a key for (the base cell, or a cell granted to the hub), or undefined when it cannot read it. */
function kindOf(roster: ProjectRoster, header: EntryHeader, wire: Buffer): string | undefined {
  const key = roster.ring(header.stream, header.epoch);
  const plaintext = key === undefined ? undefined : openBody(key, header, wire);
  if (plaintext === undefined) return undefined;
  try {
    const checked = validateBody(JSON.parse(plaintext.toString('utf8')) as unknown);
    return checked.ok ? checked.body.kind : undefined;
  } catch {
    return undefined;
  }
}

/** True when a kept checkpoint of this hub names this writer log's head at or beyond the entry's place, and at that place names this very entry. */
function coveredBefore(store: HubStore, project: string, header: EntryHeader, hash: string): boolean {
  const covered = store.coveredHead(project, header.stream, header.writer);
  return covered !== undefined && (header.seq < covered.seq || (header.seq === covered.seq && hash === covered.hash));
}

/** Checks one batch. Nothing is stored here; commitBatch writes what this accepted. */
export async function checkBatch(input: AppendInput, ctx: AppendContext): Promise<CheckOutcome> {
  if (!isRecord(input) || typeof input.project !== 'string' || typeof input.device !== 'string' || !Array.isArray(input.entries)) return refuseBatch('malformed-batch');
  const grantsIn = input.grants ?? [];
  const refsIn = input.blobRefs ?? [];
  if (!Array.isArray(grantsIn) || !Array.isArray(refsIn)) return refuseBatch('malformed-batch');
  if (input.entries.length > LIMITS.appendEntries || grantsIn.length > LIMITS.appendGrants || refsIn.length > LIMITS.appendEntries * 4) return refuseBatch('batch-too-large');

  // The bucket first: nothing below runs for a device past its rate (Pitfall 7).
  const taken = ctx.limits.takeWriter(input.device, input.entries.length + grantsIn.length, ctx.now);
  if (!taken.ok) return refuseBatch('rate-limited', { retryAfterSeconds: taken.retryAfterSeconds });

  const { store, now } = ctx;
  const project = input.project;
  if (!/^[0-9a-f]{32}$/.test(project) || store.project(project) === undefined) return refuseBatch('unknown-project');
  // The entries whose named blob the hub does not hold (WR-07, D-28): each is refused on its own below, never the whole batch.
  const blobMissing = new Set<string>();
  for (const ref of refsIn) {
    if (!isRecord(ref) || typeof ref.entry !== 'string' || !HASH.test(ref.entry) || typeof ref.blob !== 'string' || !HASH.test(ref.blob)) return refuseBatch('malformed-batch');
    if (store.blobInfo(project, ref.blob) === undefined) blobMissing.add(ref.entry);
  }

  const verify = ctx.verify ?? verifyHeader;
  const base = await ctx.cache.get(project);
  // POST-01 (D-07): a project that requires a feature this hub does not fold takes no append, so an outdated hub never accepts writes it cannot
  // judge. The whole batch is refused; no entry is called bad. Reads still answer.
  if (missingFeatures(base.state.required, hubReplicaFeatures()).length > 0) return refuseBatch('needs-update');
  // A session key pushing after its certificate's notAfter (Phase 33 D-62): the whole batch, 403, never retried. Its token normally ends first.
  if (base.standingAt(input.device, now) === 'session-expired') return refuseBatch('session-expired');
  // Restore mode (D-32, D-45): every entry must be one the hub holds or one at a place a kept or handed-back checkpoint covers. Anything else waits
  // with a retryable answer until members have handed back what the hub lost. An entry that does not read is judged by the checks below.
  if (ctx.restore?.active() === true) {
    for (const raw of input.entries) {
      const shape = parseHeaderShape(isRecord(raw) ? raw.header : undefined);
      if (shape.ok && !ctx.restore.allows(project, shape.header, entryHash(shape.header))) return refuseBatch('restoring', { retryAfterSeconds: LIMITS.restoreRetrySeconds });
    }
  }
  // Grants offered with the batch are candidates in every overlay fold, so a cell created in this batch has its founding grant (and its access
  // list) for the entries after it. Only the grants the final fold places are kept.
  const offered: Array<{ index: number; value: unknown; hash: string; cell: string; epoch: number }> = [];
  const grantsRefused: Refused[] = [];
  // The cutover rule (33.2 D-06) per grant or page, at the roster as the hub holds it before this batch; the fold applies it again after.
  const switchedAt = base.state.requiredFrom.get(WRAP_FEATURE);
  grantsIn.forEach((value, index) => {
    const read = readGrant(value);
    if (!read.ok) {
      grantsRefused.push({ index, reason: 'grant-not-placed', message: APPEND_REFUSALS['grant-not-placed'] });
      return;
    }
    const founded = base.state.cells.cells.get(read.grant.cell)?.epochs.find((epoch) => epoch.epoch === read.grant.epoch)?.from;
    const format = founded === undefined ? undefined : wrapFormatProblem(read.grant, founded, switchedAt);
    if (format !== undefined) grantsRefused.push({ index, hash: read.hash, reason: format, message: APPEND_REFUSALS[format] });
    else offered.push({ index, value, hash: read.hash, cell: read.grant.cell, epoch: read.grant.epoch });
  });
  const offeredValues = offered.map((grant) => grant.value);

  const baseEntries: SealedEntry[] = [];
  const batchBlobs = new Map<string, SealedBlob>();
  const places: Place[] = [];
  let overlay = offered.length > 0 ? base.withBatch([], offeredValues) : base;
  let dirty = false;
  // Base entries the overlay was last folded with: the overlay that replaces the cached roster must hold every base entry this batch stores, so a
  // grant in a later batch folds the ones the hub could not open yet.
  let folded = 0;
  const current = (): ProjectRoster => {
    if (dirty) {
      overlay = base.withBatch(baseEntries, offeredValues, batchBlobs).withEquivocations(places);
      folded = baseEntries.length;
      dirty = false;
    }
    return overlay;
  };

  const heads = new Map<string, { seq: number; hash: string } | undefined>();
  const kept = new Map<string, { hash: string; header: EntryHeader }>();
  const headOf = (stream: string, writer: string): { seq: number; hash: string } | undefined => {
    const key = `${stream}/${writer}`;
    if (!heads.has(key)) heads.set(key, store.headOf(project, stream, writer));
    return heads.get(key);
  };
  const atPlace = (header: EntryHeader): { hash: string; header: EntryHeader } | undefined => {
    const batch = kept.get(`${header.stream}/${header.writer}/${header.seq}`);
    if (batch !== undefined) return batch;
    const stored = store.entryAt(project, header.stream, header.writer, header.seq);
    if (stored === undefined) return undefined;
    const shape = parseHeaderShape(JSON.parse(stored.header) as unknown);
    return shape.ok ? { hash: stored.hash, header: shape.header } : undefined;
  };

  const entries: CheckedEntry[] = [];
  const accepted: string[] = [];
  const held: string[] = [];
  const refused: Refused[] = [];
  const equivocations: EquivocationRecord[] = [];
  const proofs: EquivocationProof[] = [];
  const cited: Array<{ member: string; cited: CitedStatus[] }> = [];

  for (let index = 0; index < input.entries.length; index += 1) {
    const raw = input.entries[index];
    const refuse = (reason: AppendRefusal, hash?: string): void => {
      refused.push({ index, ...(hash === undefined ? {} : { hash }), reason, message: APPEND_REFUSALS[reason] });
    };
    if (!isRecord(raw)) {
      refuse('malformed-header');
      continue;
    }
    // The size first, on the header as received, so a huge object is never read field by field.
    const rawSize = headerSize(raw.header);
    if (rawSize === undefined) {
      refuse('malformed-header');
      continue;
    }
    if (rawSize > LIMITS.headerBytes) {
      refuse('header-too-large');
      continue;
    }
    const shape = parseHeaderShape(raw.header);
    if (!shape.ok) {
      refuse(shape.reason);
      continue;
    }
    const header = shape.header;
    const hash = entryHash(header);
    if (header.body.size > LIMITS.inlineBodyBytes) {
      refuse('body-too-large', hash);
      continue;
    }
    const wire = bodyBytes(raw.body, header);
    if (wire === undefined) {
      refuse('body-mismatch', hash);
      continue;
    }
    const roster = current();
    if (!roster.streamKnown(header.stream)) {
      refuse('unknown-stream', hash);
      continue;
    }
    // A roster device, or a session key the fold placed a certificate for (D-62), checked with its certified key.
    const session = roster.sessionOf(header.writer);
    const publicKey = roster.view.deviceKey(header.writer)?.publicKey ?? session?.sessionKey;
    if (publicKey === undefined) {
      refuse('not-admitted', hash);
      continue;
    }
    if (!verify(header, publicKey)) {
      refuse('bad-signature', hash);
      continue;
    }
    const standing = roster.standingAt(header.writer, now);
    // WR-02 (D-54): standing is judged at the entry's place, not only at the head. A place at or below the furthest head a kept checkpoint of this
    // hub names for that log is one the hub accepted before, so after a restore the entry there is taken back even from a device revoked since
    // (at the covered head itself only the very entry the checkpoint names). Without it the hub could never cover that checkpoint's heads again
    // and would stop signing for the project. Anything beyond the covered place stays refused revoked.
    const vouched = standing === 'revoked' && coveredBefore(store, project, header, hash);
    if (standing !== 'admitted' && !vouched) {
      refuse(standing, hash);
      continue;
    }
    if (!vouched && !(roster.accessList(header.stream) ?? []).includes(header.writer)) {
      refuse('not-on-access-list', hash);
      continue;
    }
    const existing = atPlace(header);
    if (existing !== undefined) {
      if (existing.hash === hash && blobMissing.has(hash)) {
        // Held already, but the reference it brings names a blob the hub does not hold: sent again once the blob is uploaded.
        refuse('blob-missing', hash);
        continue;
      }
      if (existing.hash === hash) {
        if (!accepted.includes(hash)) accepted.push(hash);
        held.push(hash);
        continue;
      }
      // D-43: a second validly signed header at a used place. The first stays the hub's entry; both headers are kept as proof, and the writer is
      // refused everywhere until the roster releases this place or revokes the device.
      const proof = canonicalProof(existing.header, header, publicKey);
      const place = { writer: header.writer, stream: header.stream, seq: header.seq };
      equivocations.push({ proofHash: proofHash(proof), ...place, proof: canonicalize(proof), recordedAt: now });
      proofs.push(proof);
      places.push(place);
      overlay = overlay.withEquivocations([place]);
      refuse('equivocation', hash);
      continue;
    }
    const head = headOf(header.stream, header.writer);
    const next = head === undefined ? 0 : head.seq + 1;
    // A blob the entry names is not here: this entry waits, and the head does not move, so the writer's later entries in the batch meet seq-gap.
    if (header.seq === next && header.prev === (head === undefined ? GENESIS_PREV : head.hash) && blobMissing.has(hash)) {
      refuse('blob-missing', hash);
      continue;
    }
    if (header.seq !== next) {
      refuse('seq-gap', hash);
      continue;
    }
    if (header.prev !== (head === undefined ? GENESIS_PREV : head.hash)) {
      refuse('prev-mismatch', hash);
      continue;
    }
    // A session key never signs a person-key kind (D-60). The hub refuses what it can read; a client's fold refuses the rest.
    if (session !== undefined) {
      const kind = kindOf(roster, header, wire);
      if (kind !== undefined && isPersonKeyKind(kind)) {
        refuse('person-key-required', hash);
        continue;
      }
    }
    if (header.stream === project) {
      const read = await readBase(roster, store, project, header, wire, batchBlobs);
      if (!read.ok && read.why === 'missing-blob') {
        refuse('blob-missing', hash);
        continue;
      }
      if (!read.ok && read.why === 'unreadable') {
        refuse('roster-unreadable', hash);
        continue;
      }
      if (read.ok && ctx.trust !== undefined && carriesEvidence(read.opened.data)) {
        // The member's credentials bind the roster device; a session key cites them through the device that certified it.
        const device = roster.deviceOf(header.writer);
        if (device === undefined) {
          refuse('not-admitted', hash);
          continue;
        }
        const key = roster.ring(header.stream, header.epoch) as Buffer;
        const opened: Buffer[] = [];
        for (const ref of refsIn) {
          if (ref.entry !== hash) continue;
          const bytes = await store.readBlob(project, ref.blob);
          const plain = bytes === undefined ? undefined : openBlob(key, header.stream, header.epoch, { hash: ref.blob, bytes: bytes.toString('base64url') });
          if (plain !== undefined) opened.push(plain);
        }
        const outcome = checkEntryEvidence({ data: read.opened.data, at: read.opened.at, devicePublicKey: device.publicKey, blobs: opened }, ctx.trust, now);
        if (!outcome.ok) {
          refused.push({ index, hash, reason: outcome.reason, message: outcome.message ?? APPEND_REFUSALS[outcome.reason], ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }) });
          continue;
        }
        if (outcome.checked && outcome.cited.length > 0) cited.push({ member: device.member, cited: outcome.cited });
      }
      if (!read.ok) {
        // No key for its epoch yet: the writer's log, stored as ciphertext and folded when the grant arrives. With grants offered in this batch the
        // next entry is judged at a fold that may now open it.
        baseEntries.push({ header, body: raw.body as string });
        if (offered.length > 0) dirty = true;
      } else if (Object.prototype.hasOwnProperty.call(ROSTER_KIND_OWNER, read.opened.kind)) {
        const { kind, data } = read.opened;
        // Authority at the roster the entry cites, never at the hub's head (D-11, CR-01). A roster entry citing an older head is an honest
        // concurrent branch (a lead and a deputy racing, a lead handover race): it is the writer's log, so it is stored and the fold makes it a
        // split for the lead to choose. Refusing it would leave a seq gap that cuts off every later entry of that device in the base stream.
        // A cited roster the hub's line does not hold is stored too: the fold applies nothing from it unless that roster is applied, and then
        // judges the writer there.
        const rosterPrev = kind === 'project.genesis' ? ORIGIN_ROSTER : isRecord(data) && typeof data.rosterPrev === 'string' ? data.rosterPrev : read.opened.roster;
        // A position or posting write (Phase 33.1) is judged by the fold's own rule, which also lets the posted member report for their posting.
        const cited = roster.state.positionOf.get(rosterPrev);
        const problem = ROSTER_KIND_OWNER[kind] !== 'positions' ? (roster.isRosterWriterAtRoster(header.writer, rosterPrev) === false ? 'not-a-roster-writer' : undefined)
          : cited === undefined ? undefined : positionWriteProblem(roster.state, { writer: header.writer, kind, data, actor: read.opened.actor, at: read.opened.at }, cited);
        if (problem !== undefined) {
          refuse(problem, hash);
          continue;
        }
        baseEntries.push({ header, body: raw.body as string });
        if (read.blob !== undefined) batchBlobs.set(read.blob.hash, read.blob);
        dirty = true;
      } else if (read.opened.kind === 'session.certify') {
        // A certificate takes no roster position, but the overlay folds it, so the session key's own entries later in this batch are judged with it.
        if (roster.liveSessionsOf(header.writer, now) >= LIMITS.liveSessionKeysPerDevice) {
          refuse('too-many-sessions', hash);
          continue;
        }
        baseEntries.push({ header, body: raw.body as string });
        dirty = true;
      } else if (read.opened.kind === 'device.kem') {
        // A device's post-quantum keys (33.2 D-03): judged at the roster the entry cites with the fold's deviceKemProblem. A cited roster the hub's
        // line does not hold is stored, like a roster entry: the fold judges it once that roster applies.
        const state = roster.state;
        const problem = !validateData('device.kem', read.opened.data).ok
          ? 'kem-binding-invalid'
          : state.positionOf.has(read.opened.roster)
            ? deviceKemProblem({ signer: header.writer, roster: read.opened.roster, data: read.opened.data as DeviceKemData }, deviceKemContext(state, (writer, position) => isRosterWriterAt(state, writer, position)))
            : undefined;
        if (problem !== undefined) {
          refuse(problem, hash);
          continue;
        }
        baseEntries.push({ header, body: raw.body as string });
        dirty = true;
      }
    }
    entries.push({ index, hash, stream: header.stream, writer: header.writer, seq: header.seq, row: { header: canonicalize(header), body: raw.body as string, receivedAt: now } });
    accepted.push(hash);
    heads.set(`${header.stream}/${header.writer}`, { seq: header.seq, hash });
    kept.set(`${header.stream}/${header.writer}/${header.seq}`, { hash, header });
  }

  if (folded !== baseEntries.length) dirty = true;
  const roster = current();
  const grants: GrantInput[] = [];
  for (const grant of offered) {
    if (!roster.placedGrants.has(grant.hash)) {
      // An epoch this batch founds is judged by the fold; its refusal names the cutover rule when that is the reason.
      const reason = roster.state.refused.some((item) => item.hash === grant.hash && item.reason === 'old-wrap-after-switch') ? 'old-wrap-after-switch' : 'grant-not-placed';
      grantsRefused.push({ index: grant.index, hash: grant.hash, reason, message: APPEND_REFUSALS[reason] });
    } else if (!base.placedGrants.has(grant.hash) && !grants.some((item) => item.hash === grant.hash)) {
      grants.push({ hash: grant.hash, cell: grant.cell, epoch: grant.epoch, body: canonicalize(grant.value), receivedAt: now });
    }
  }
  grantsRefused.sort((a, b) => a.index - b.index);

  // Blob references for entries this batch stores; a reference for a refused entry is dropped with it. For an entry the hub already held, only its
  // own writer's device may add a reference (IN-01): otherwise any device could mark its uploads referenced by naming someone else's entry,
  // escaping the pending quota and the 24 hour sweep (D-44), and widen who may read that blob to the entry's stream.
  const streamOf = new Map<string, string>();
  for (const entry of entries) streamOf.set(entry.hash, entry.stream);
  const blobRefs: BlobRef[] = [];
  for (const ref of refsIn) {
    let stream = streamOf.get(ref.entry);
    if (stream === undefined && held.includes(ref.entry)) {
      const stored = store.entryByHash(project, ref.entry);
      if (stored !== undefined && stored.writer === input.device) stream = stored.stream;
    }
    if (stream !== undefined) blobRefs.push({ entry: ref.entry, blob: ref.blob, stream });
  }

  return {
    ok: true,
    checked: { project, entries, accepted, held, refused, grants, grantsRefused, equivocations, proofs, blobRefs, base, roster, rosterChanged: roster.head !== base.head, cited }
  };
}

/**
 * Writes a checked batch in one transaction (entries, the grants the fold placed, equivocation proofs and blob references), then replaces the
 * cached roster with the overlay. A store failure throws before the cache is touched, so nothing is accepted. If another batch replaced the cached
 * roster in the meantime, the cache is dropped instead and folded again on next use.
 */
export function commitBatch(store: HubStore, cache: RosterCache, checked: CheckedBatch, now: number): AppendResult {
  const stored = store.commitAppend(checked.project, {
    entries: checked.entries.map((entry) => entry.row),
    grants: checked.grants,
    equivocations: checked.equivocations,
    blobRefs: checked.blobRefs,
    at: now
  });
  if (cache.peek(checked.project) === checked.base) cache.replace(checked.project, checked.roster.withKept(checked.grants.map((grant) => grant.hash)));
  else cache.invalidate(checked.project);
  return {
    project: checked.project,
    accepted: checked.accepted,
    held: checked.held,
    refused: checked.refused,
    grants: { stored: checked.grants.map((grant) => grant.hash), refused: checked.grantsRefused },
    equivocations: checked.proofs,
    rosterChanged: checked.rosterChanged,
    rosterHead: checked.roster.head,
    stored
  };
}

const projectLocks = new Map<string, Promise<unknown>>();

/** checkBatch then commitBatch with one batch at a time per project, so two batches never check against the same roster and both commit. */
export async function appendBatch(input: AppendInput, ctx: AppendContext): Promise<{ ok: true; result: AppendResult } | Extract<CheckOutcome, { ok: false }>> {
  const project = typeof input?.project === 'string' ? input.project : '';
  const before = projectLocks.get(project) ?? Promise.resolve();
  const run = before.then(async () => {
    const outcome = await checkBatch(input, ctx);
    if (!outcome.ok) return outcome;
    const result = commitBatch(ctx.store, ctx.cache, outcome.checked, ctx.now);
    for (const item of outcome.checked.cited) ctx.trust?.recordCited(outcome.checked.project, item.member, item.cited);
    return { ok: true as const, result };
  });
  const settled = run.catch(() => undefined);
  projectLocks.set(project, settled);
  void settled.then(() => {
    if (projectLocks.get(project) === settled) projectLocks.delete(project);
  });
  return run;
}

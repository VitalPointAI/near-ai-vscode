// The append checks (D-39, D-42, D-43, D-44, D-26; DESIGN 10.7). For every entry a device offers, whether it is a valid next step of an admitted
// writer's log in a part of the project that writer may write. The checks run without Yjs and without any key but the hub's own: bodies of cells
// the hub does not hold stay ciphertext and are checked by clients. Only base-stream bodies are opened, with the base cell key granted to the hub.
//
// Order. Per batch, before anything costly: its shape and size, then the pushing device's token bucket (before any signature, Pitfall 7), then the
// project and the blobs the batch says its entries use (a missing blob refuses the whole batch, blob-missing). Per entry, in order: header shape and
// size; the body's size and ciphertext hash; the stream is the project's; the writer's signature with its roster key; the writer admitted and neither
// revoked nor quarantined at the head (a device revoked since may still fill a place a kept checkpoint of this hub covers, WR-02); the writer on the
// stream's access list; the place (same hash again: held; another hash at a used seq: an equivocation proof, D-43; beyond the next seq: seq-gap;
// wrong prev: prev-mismatch); and for base-stream entries, a body the hub can open and, for
// roster kinds, a lead or deputy device at the roster the entry cites (D-11). A roster kind citing an older roster than the hub's head is stored:
// it is a concurrent branch the fold turns into a split (D-09), and refusing it would cut the writer's log at a seq gap for good (CR-01).
//
// A batch is checked in order against an in-memory overlay (heads, places and a roster folded again after each roster entry), then written by
// commitBatch in one store transaction. Only after COMMIT does the overlay replace the cached roster, so a failed write accepts nothing (D-26).
// A roster entry the fold refuses is still stored, because it is the writer's log; the roster head simply does not move.
import { readGrant } from '@ext/domain/replica/cellKeys';
import { GENESIS_PREV, entryHash, openBlob, openBody, parseHeaderShape, sha256Hex, verifyHeader } from '@ext/domain/replica/entry';
import type { EntryHeader, SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import { canonicalProof, proofHash } from '@ext/domain/replica/equivocation';
import type { EquivocationProof } from '@ext/domain/replica/equivocation';
import { validateBody } from '@ext/domain/replica/kinds';
import { ORIGIN_ROSTER, ROSTER_KIND_OWNER } from '@ext/domain/replica/roster';
import { canonicalize } from '@ext/domain/team/canonical';
import { LIMITS } from '../limits';
import type { RateLimits } from '../limits';
import type { BlobRef, EntryRow, EquivocationRecord, GrantInput, HubStore, StoredEntry } from '../store/hubStore';
import type { Place, ProjectRoster, RosterCache } from './rosterCache';

export const APPEND_REFUSALS = {
  'malformed-batch': 'The append is not in a shape this hub can read.',
  'unknown-project': 'This hub does not hold that project.',
  'batch-too-large': 'The append holds more entries or grants than one append may. Send it in smaller parts.',
  'rate-limited': 'This device is sending entries faster than the hub takes them. Wait the time the hub gives, then send again.',
  'blob-missing': 'An entry uses a large part the hub does not hold. Upload that part, then send the entries again.',
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
  'roster-unreadable': 'The hub cannot open this entry of the roster part of the project, so it cannot check it.',
  'grant-not-placed': 'This cell grant does not fit the roster, so the hub does not keep it.'
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
}

export interface Refused {
  index: number;
  hash?: string;
  reason: AppendRefusal;
  message: string;
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
}

type BaseRead = { ok: true; opened: OpenedBase; blob?: SealedBlob } | { ok: false; missingBlob: boolean };

/** Opens a base-stream body with the hub's ring, reading its blob from the overlay or the store. */
async function readBase(roster: ProjectRoster, store: HubStore, project: string, header: EntryHeader, wire: Buffer, batchBlobs: Map<string, SealedBlob>): Promise<BaseRead> {
  const key = roster.ring(header.stream, header.epoch);
  if (key === undefined) return { ok: false, missingBlob: false };
  const plaintext = openBody(key, header, wire);
  if (plaintext === undefined) return { ok: false, missingBlob: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    return { ok: false, missingBlob: false };
  }
  const checked = validateBody(parsed);
  if (!checked.ok) return { ok: false, missingBlob: false };
  const body = checked.body;
  if (body.blob === undefined) return { ok: true, opened: { kind: body.kind, roster: body.roster, data: body.data } };
  let blob = batchBlobs.get(body.blob) ?? roster.blob(body.blob);
  if (blob === undefined) {
    const bytes = await store.readBlob(project, body.blob);
    if (bytes === undefined) return { ok: false, missingBlob: true };
    blob = { hash: body.blob, bytes: bytes.toString('base64url') };
  }
  const opened = openBlob(key, header.stream, header.epoch, blob);
  if (opened === undefined) return { ok: false, missingBlob: false };
  try {
    return { ok: true, opened: { kind: body.kind, roster: body.roster, data: JSON.parse(opened.toString('utf8')) as unknown }, blob };
  } catch {
    return { ok: false, missingBlob: false };
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
  for (const ref of refsIn) {
    if (!isRecord(ref) || typeof ref.entry !== 'string' || !HASH.test(ref.entry) || typeof ref.blob !== 'string' || !HASH.test(ref.blob)) return refuseBatch('malformed-batch');
    if (store.blobInfo(project, ref.blob) === undefined) return refuseBatch('blob-missing');
  }

  const verify = ctx.verify ?? verifyHeader;
  const base = await ctx.cache.get(project);
  // Grants offered with the batch are candidates in every overlay fold, so a cell created in this batch has its founding grant (and its access
  // list) for the entries after it. Only the grants the final fold places are kept.
  const offered: Array<{ index: number; value: unknown; hash: string; cell: string; epoch: number }> = [];
  const grantsRefused: Refused[] = [];
  grantsIn.forEach((value, index) => {
    const read = readGrant(value);
    if (read.ok) offered.push({ index, value, hash: read.hash, cell: read.grant.cell, epoch: read.grant.epoch });
    else grantsRefused.push({ index, reason: 'grant-not-placed', message: APPEND_REFUSALS['grant-not-placed'] });
  });
  const offeredValues = offered.map((grant) => grant.value);

  const baseEntries: SealedEntry[] = [];
  const batchBlobs = new Map<string, SealedBlob>();
  const places: Place[] = [];
  let overlay = offered.length > 0 ? base.withBatch([], offeredValues) : base;
  let dirty = false;
  const current = (): ProjectRoster => {
    if (dirty) {
      overlay = base.withBatch(baseEntries, offeredValues, batchBlobs).withEquivocations(places);
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
    const device = roster.view.deviceKey(header.writer);
    if (device === undefined) {
      refuse('not-admitted', hash);
      continue;
    }
    if (!verify(header, device.publicKey)) {
      refuse('bad-signature', hash);
      continue;
    }
    const standing = roster.standing(header.writer);
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
      if (existing.hash === hash) {
        if (!accepted.includes(hash)) accepted.push(hash);
        held.push(hash);
        continue;
      }
      // D-43: a second validly signed header at a used place. The first stays the hub's entry; both headers are kept as proof, and the writer is
      // refused everywhere until the roster releases this place or revokes the device.
      const proof = canonicalProof(existing.header, header, device.publicKey);
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
    if (header.seq !== next) {
      refuse('seq-gap', hash);
      continue;
    }
    if (header.prev !== (head === undefined ? GENESIS_PREV : head.hash)) {
      refuse('prev-mismatch', hash);
      continue;
    }
    if (header.stream === project) {
      const read = await readBase(roster, store, project, header, wire, batchBlobs);
      if (!read.ok) {
        if (read.missingBlob) return refuseBatch('blob-missing');
        refuse('roster-unreadable', hash);
        continue;
      }
      const { kind, data } = read.opened;
      if (Object.prototype.hasOwnProperty.call(ROSTER_KIND_OWNER, kind)) {
        // Authority at the roster the entry cites, never at the hub's head (D-11, CR-01). A roster entry citing an older head is an honest
        // concurrent branch (a lead and a deputy racing, a lead handover race): it is the writer's log, so it is stored and the fold makes it a
        // split for the lead to choose. Refusing it would leave a seq gap that cuts off every later entry of that device in the base stream.
        // A cited roster the hub's line does not hold is stored too: the fold applies nothing from it unless that roster is applied, and then
        // judges the writer there.
        const rosterPrev = kind === 'project.genesis' ? ORIGIN_ROSTER : isRecord(data) && typeof data.rosterPrev === 'string' ? data.rosterPrev : read.opened.roster;
        if (roster.isRosterWriterAtRoster(header.writer, rosterPrev) === false) {
          refuse('not-a-roster-writer', hash);
          continue;
        }
        baseEntries.push({ header, body: raw.body as string });
        if (read.blob !== undefined) batchBlobs.set(read.blob.hash, read.blob);
        dirty = true;
      }
    }
    entries.push({ index, hash, stream: header.stream, writer: header.writer, seq: header.seq, row: { header: canonicalize(header), body: raw.body as string, receivedAt: now } });
    accepted.push(hash);
    heads.set(`${header.stream}/${header.writer}`, { seq: header.seq, hash });
    kept.set(`${header.stream}/${header.writer}/${header.seq}`, { hash, header });
  }

  const roster = current();
  const grants: GrantInput[] = [];
  for (const grant of offered) {
    if (!roster.placedGrants.has(grant.hash)) {
      grantsRefused.push({ index: grant.index, hash: grant.hash, reason: 'grant-not-placed', message: APPEND_REFUSALS['grant-not-placed'] });
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
    checked: { project, entries, accepted, held, refused, grants, grantsRefused, equivocations, proofs, blobRefs, base, roster, rosterChanged: roster.head !== base.head }
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
    return { ok: true as const, result: commitBatch(ctx.store, ctx.cache, outcome.checked, ctx.now) };
  });
  const settled = run.catch(() => undefined);
  projectLocks.set(project, settled);
  void settled.then(() => {
    if (projectLocks.get(project) === settled) projectLocks.delete(project);
  });
  return run;
}

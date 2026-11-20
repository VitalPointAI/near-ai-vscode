// Verification of one entry (DESIGN 4.4 step 1; D-07, D-09). Pure: it reads only its input and the injected ReplicaContext. Hub-side: no Yjs.
//
// Four different outputs, never mixed (Pitfall 11):
// - held: a piece this machine does not have yet (writer's key, body bytes, epoch key, blob, roster). It becomes verified when the piece arrives.
// - rejected: permanent and recorded (bad signature, unreadable body, bad schema).
// - verified with keep: the entry is genuine but changes no state ("unauthorised" or "observer-only" at the cited roster, or "made by a newer
//   version").
// - verified: the fold may use it.
import { BLOB_MAX_BYTES, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD, blobBytesHash, entryHash, openBlob, openBody, parseHeaderShape, sha256Hex, verifyHeader } from './entry';
import type { EntryBody, EntryHeader, SealedBlob } from './entry';
import { validateBody, validateData } from './kinds';
import type { ReplicaContext } from './rosterView';

// Closed reason maps: an id and one plain sentence each. No em-dashes.
export const VERIFY_REJECTIONS = {
  'malformed-header': 'The entry header is not in a shape this version can read.',
  'unknown-header-version': 'The entry was written in a newer format. Update the extension to read it.',
  'header-too-large': 'The entry header is larger than the allowed size.',
  'bad-signature': 'The signature does not match the header, so it was changed or was not made by this device.',
  'body-too-large': 'The entry body is larger than the allowed size.',
  'body-unreadable': 'The entry body cannot be opened with the key for its cell and its place in the log.',
  'bad-body': 'The entry body is not in a shape this version can read.',
  'blob-unreadable': 'The large part of the entry cannot be opened with the key for its cell.',
  'bad-data': 'The entry data does not match what its kind allows.'
} as const;
export type VerifyRejection = keyof typeof VERIFY_REJECTIONS;

export const VERIFY_HOLDS = {
  'unknown-writer': 'This device is not known yet, so its signature cannot be checked.',
  'body-missing-or-corrupt': 'The entry body is missing or does not match its header, so a good copy is needed.',
  'missing-key': 'This machine does not have the key for this cell and epoch yet.',
  'missing-blob': 'The large part of the entry has not arrived or does not match its hash.',
  'missing-roster': 'The roster entry this one cites has not arrived yet.',
  'roster-branch-not-chosen': 'This cites a roster change that was made in two places at once and not chosen, so it waits for the lead or the deputy to choose.'
} as const;
export type VerifyHold = keyof typeof VERIFY_HOLDS;

export const KEEP_REASONS = {
  unauthorised: 'The device was not admitted at the roster this entry cites, so it is kept and shown and changes nothing.',
  'newer-version': 'Made by a newer version of the extension. It is kept and passed on and changes nothing here.',
  'hub-actor': 'Written by a hub watch. Nothing in this version accepts hub writes yet, so it is kept and changes nothing.',
  'folded-in-later-phase': 'This kind of entry is kept and passed on, and is not applied by this version yet.',
  'observer-only': 'Written by an observer, who reads the project and writes only presence, so it is kept and changes nothing.'
} as const;
export type KeepReason = keyof typeof KEEP_REASONS;

export interface VerifiedEntry {
  hash: string;
  header: EntryHeader;
  body: EntryBody;
  // The kind's data: inline, or read from the blob.
  data: unknown;
  // The member the roster view names for the writing device.
  member: string;
  keep?: KeepReason;
}

export type VerifyOutcome =
  | { status: 'verified'; entry: VerifiedEntry }
  | { status: 'held'; reason: VerifyHold; hash?: string; header?: EntryHeader; detail?: string }
  | { status: 'rejected'; reason: VerifyRejection; hash?: string; header?: EntryHeader; detail?: string };

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

// Never throws. input is whatever a transport delivered: { header, body } with body as base64url of iv, tag and data.
export function verifyEntry(input: unknown, ctx: ReplicaContext): VerifyOutcome {
  try {
    return verify(input, ctx);
  } catch {
    // A failure nobody planned for on hostile input is a refusal of that input, not a crash of the fold.
    return { status: 'rejected', reason: 'malformed-header' };
  }
}

function verify(input: unknown, ctx: ReplicaContext): VerifyOutcome {
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (record === undefined) return { status: 'rejected', reason: 'malformed-header' };
  const shape = parseHeaderShape(record.header);
  if (!shape.ok) return { status: 'rejected', reason: shape.reason };
  const header = shape.header;
  const hash = entryHash(header);
  const where = { hash, header };

  const device = ctx.roster.deviceKey(header.writer);
  if (device === undefined) return { status: 'held', reason: 'unknown-writer', ...where };
  if (!verifyHeader(header, device.publicKey)) return { status: 'rejected', reason: 'bad-signature', ...where };
  if (header.body.size > INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD) return { status: 'rejected', reason: 'body-too-large', ...where };

  const wire = readWire(record.body, header.body.size);
  if (wire === undefined || wire.length !== header.body.size || sha256Hex(wire) !== header.body.hash) {
    return { status: 'held', reason: 'body-missing-or-corrupt', ...where };
  }
  const key = ctx.keys(header.stream, header.epoch);
  if (key === undefined) return { status: 'held', reason: 'missing-key', ...where };
  const plaintext = openBody(key, header, wire);
  if (plaintext === undefined) return { status: 'rejected', reason: 'body-unreadable', ...where };
  if (plaintext.length > INLINE_BODY_MAX_BYTES) return { status: 'rejected', reason: 'body-too-large', ...where };

  const parsed = parseJson(plaintext);
  if (!parsed.ok) return { status: 'rejected', reason: 'bad-body', detail: 'bad-body: body', ...where };
  const checked = validateBody(parsed.value);
  if (!checked.ok) return { status: 'rejected', reason: 'bad-body', detail: checked.reason, ...where };
  const body = checked.body;

  let data: unknown = body.data;
  if (body.blob !== undefined) {
    const blob: SealedBlob | undefined = ctx.blobs(body.blob);
    if (blob === undefined || blobBytesHash(blob) !== body.blob) return { status: 'held', reason: 'missing-blob', ...where };
    if (Buffer.from(blob.bytes, 'base64url').length > BLOB_MAX_BYTES) return { status: 'rejected', reason: 'body-too-large', ...where };
    const opened = openBlob(key, header.stream, header.epoch, blob);
    if (opened === undefined) return { status: 'rejected', reason: 'blob-unreadable', ...where };
    const blobJson = parseJson(opened);
    if (!blobJson.ok) return { status: 'rejected', reason: 'bad-data', detail: 'bad-data: blob', ...where };
    data = blobJson.value;
  }
  if (checked.known) {
    const dataCheck = validateData(body.kind, data);
    if (!dataCheck.ok) return { status: 'rejected', reason: 'bad-data', detail: dataCheck.reason, ...where };
  }

  // A roster hash on a split branch nobody chose is named as such (D-11): the entry is kept and waits, and applies only if that branch is chosen.
  if (ctx.roster.rosterBranchPending?.(body.roster) === true) return { status: 'held', reason: 'roster-branch-not-chosen', ...where };
  if (!ctx.roster.hasRoster(body.roster)) return { status: 'held', reason: 'missing-roster', ...where };
  const entry: VerifiedEntry = { hash, header, body, data, member: device.member };
  if (!ctx.roster.isAdmitted(header.writer, body.roster)) entry.keep = 'unauthorised';
  // An observer reads and writes only presence (D-12; presence arrives in Phase 33), so every entry of a member who holds observer and not member at
  // the cited roster changes nothing.
  else if (ctx.roster.hasRole(device.member, 'observer', body.roster) && !ctx.roster.hasRole(device.member, 'member', body.roster)) entry.keep = 'observer-only';
  else if (!checked.known) entry.keep = 'newer-version';
  return { status: 'verified', entry };
}

// The sealed body as bytes, or undefined when it is absent, not base64url, or longer than its header says it may be.
function readWire(value: unknown, size: number): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length > Math.ceil((size * 4) / 3) + 4 || !/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : undefined;
}

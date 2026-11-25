// Sealed presence (Phase 33, D-18, D-21, D-35; DESIGN 10.5, Pattern 4). Pure: node:crypto only, no clock, no I/O, no Yjs. Your organization's
// server relays presence bytes and never reads them: each message is sealed under the epoch key of the cell it is sent in, with a key of its own
// (HKDF-SHA-256, info near-ai/presence/v1 and the cell and epoch) and AES-256-GCM whose associated data binds the cell, the epoch and the sending
// device's writer id. So a message copied into another cell, another epoch or under another device does not open.
//
// The wire form is base64url of: the epoch as 4 bytes big-endian, the 12-byte IV, the 16-byte tag, then the ciphertext. The plaintext is a closed
// JSON shape of at most MAX_PRESENCE_PLAINTEXT bytes:
//   { v: 1, kind: 'here' | 'cursor' | 'leave', member, position?, product?, anchor?, head?, runs?, seq }
// Presence is advisory only, kept in memory and never written to disk, and never an input to a decision. The base cell's presence carries only
// online and the position (presenceAllowedFor): a product's name and its cursor travel only in that product's own cell, so a person below the cell
// never learns the product exists (Pitfall 10).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const PRESENCE_INFO = 'near-ai/presence/v1';
/** The most bytes the presence plaintext may hold. */
export const MAX_PRESENCE_PLAINTEXT = 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const EPOCH_BYTES = 4;
const KINDS = ['here', 'cursor', 'leave'] as const;
const KEYS = ['v', 'kind', 'member', 'position', 'product', 'anchor', 'head', 'runs', 'seq'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STREAM = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const POSITION_TEXT = /^[^\u0000-\u001f\u007f]{1,120}$/;
const RELATIVE = /^[A-Za-z0-9_-]{1,256}$/;

export interface PresenceMessage {
  v: 1;
  kind: (typeof KINDS)[number];
  /** The sender's member id; the receiver checks it against the roster's member of the device that sent the frame. */
  member: string;
  /** The sender's position or seat word, as the sender's roster has it. The receiver shows its own roster's word. */
  position?: string;
  /** The product worked on: only in that product's own cell. */
  product?: string;
  /** A Yjs relative position of the selection's anchor and head, base64url: only with product. */
  anchor?: string;
  head?: string;
  /** How many agents the sender runs on this shared work. */
  runs?: number;
  /** Rising per sender, so an older message never replaces a newer one. */
  seq: number;
}

/** Where a message is sent from: the cell, the epoch whose key seals it, and the sending device. */
export interface PresencePlace { cell: string; epoch: number; writer: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** The message read from untrusted JSON: closed keys, every field in its pattern. A fresh object, or undefined. */
export function readPresence(value: unknown): PresenceMessage | undefined {
  if (!isRecord(value) || !Object.keys(value).every((key) => (KEYS as readonly string[]).includes(key))) return undefined;
  const { v, kind, member, position, product, anchor, head, runs, seq } = value;
  if (v !== 1 || typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind) || typeof member !== 'string' || !SLUG.test(member) || !isCount(seq, Number.MAX_SAFE_INTEGER)) return undefined;
  if (position !== undefined && (typeof position !== 'string' || !POSITION_TEXT.test(position))) return undefined;
  if (product !== undefined && (typeof product !== 'string' || !SLUG.test(product))) return undefined;
  for (const relative of [anchor, head]) if (relative !== undefined && (typeof relative !== 'string' || !RELATIVE.test(relative))) return undefined;
  if ((anchor !== undefined || head !== undefined) && product === undefined) return undefined;
  if (runs !== undefined && !isCount(runs, 1000)) return undefined;
  const message: PresenceMessage = { v: 1, kind: kind as PresenceMessage['kind'], member, seq };
  if (position !== undefined) message.position = position;
  if (product !== undefined) message.product = product;
  if (typeof anchor === 'string') message.anchor = anchor;
  if (typeof head === 'string') message.head = head;
  if (runs !== undefined) message.runs = runs;
  return message;
}

/** May this message be sent in this cell? In the base cell only online and the position: never a product, its cursor or the agents count. */
export function presenceAllowedFor(message: PresenceMessage, cell: string, baseCell: string): boolean {
  if (cell !== baseCell) return true;
  return message.product === undefined && message.anchor === undefined && message.head === undefined && message.runs === undefined;
}

function presenceKey(epochKey: Buffer, cell: string, epoch: number): Buffer {
  return Buffer.from(hkdfSync('sha256', epochKey, Buffer.alloc(0), Buffer.from(`${PRESENCE_INFO}\u0000${cell}\u0000${epoch}`, 'utf8'), 32));
}

const aadOf = (place: PresencePlace): Buffer => Buffer.from(`${PRESENCE_INFO}\u0000${place.cell}\u0000${place.epoch}\u0000${place.writer}`, 'utf8');

function checkPlace(place: PresencePlace): void {
  if (!STREAM.test(place.cell) || !HASH.test(place.writer) || !Number.isSafeInteger(place.epoch) || place.epoch < 1 || place.epoch > 0xffffffff) throw new Error('A presence message is sealed for one cell, epoch and device.');
}

/** Seals a message for its cell, epoch and device. Throws for a message that is not in the closed shape or is longer than the limit. */
export function sealPresence(epochKey: Buffer, place: PresencePlace, message: PresenceMessage): string {
  checkPlace(place);
  const checked = readPresence(message);
  if (checked === undefined) throw new Error('This presence message is not in the shape this version sends.');
  const plain = Buffer.from(JSON.stringify(checked), 'utf8');
  if (plain.length > MAX_PRESENCE_PLAINTEXT) throw new Error('This presence message is longer than the limit.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', presenceKey(epochKey, place.cell, place.epoch), iv);
  cipher.setAAD(aadOf(place));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  const epoch = Buffer.alloc(EPOCH_BYTES);
  epoch.writeUInt32BE(place.epoch);
  return Buffer.concat([epoch, iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/**
 * Opens a message sent by `writer` in `cell`, with the epoch key keyFor gives for the epoch the bytes name. Undefined for anything that does not
 * open or read: no key for that epoch, another cell or device, a changed byte, a shape this version does not send. Never throws.
 */
export function openPresence(keyFor: (cell: string, epoch: number) => Buffer | undefined, place: { cell: string; writer: string }, sealed: string): PresenceMessage | undefined {
  try {
    if (typeof sealed !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sealed)) return undefined;
    const wire = Buffer.from(sealed, 'base64url');
    if (wire.length < EPOCH_BYTES + IV_BYTES + TAG_BYTES || wire.length > EPOCH_BYTES + IV_BYTES + TAG_BYTES + MAX_PRESENCE_PLAINTEXT || wire.toString('base64url') !== sealed) return undefined;
    const epoch = wire.readUInt32BE(0);
    const key = keyFor(place.cell, epoch);
    if (key === undefined || epoch < 1) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', presenceKey(key, place.cell, epoch), wire.subarray(EPOCH_BYTES, EPOCH_BYTES + IV_BYTES));
    decipher.setAAD(aadOf({ cell: place.cell, epoch, writer: place.writer }));
    decipher.setAuthTag(wire.subarray(EPOCH_BYTES + IV_BYTES, EPOCH_BYTES + IV_BYTES + TAG_BYTES));
    const opened = Buffer.concat([decipher.update(wire.subarray(EPOCH_BYTES + IV_BYTES + TAG_BYTES)), decipher.final()]);
    return readPresence(JSON.parse(opened.toString('utf8')) as unknown);
  } catch {
    return undefined;
  }
}

// The padded, sealed objects and the manifest that make up the synced state tree (D-09). The tree holds exactly `manifest.json` (plaintext: a
// new computer needs it to derive the key) and `<32 hex>.bin` objects. An object is
//   NAS1 | version 1 | object salt(16) | iv(12) | tag(16) | AES-256-GCM( u32 length | brotli(JSON) | random padding )
// under a key derived from the data key and the object's own salt. Sizes fall into Padme buckets (8 per octave, 64 KiB floor, at most 12.5% over)
// and no part exceeds 8 MiB. Names are random, never derived from any id. Pure: no vscode, no files, no git.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import {
  IV_BYTES, SALT_BYTES, TAG_BYTES, StateRefusedError, aadFor, assertKdfParams, open, openRaw, seal, sealRaw, subKey,
  type KdfRecord, type SealedBlob
} from './keys';

export type ObjectClass = 'hot' | 'cold' | 'index';

export const OBJECT_MAGIC = Buffer.from('NAS1', 'ascii');
const OBJECT_VERSION = 1;
export const OBJECT_HEADER_BYTES = OBJECT_MAGIC.length + 1 + SALT_BYTES + IV_BYTES + TAG_BYTES;
export const MIN_PADDED_BYTES = 64 * 1024;
export const MAX_PART_BYTES = 8 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_OBJECT_ENTRIES = 10_000;
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
export const OBJECT_NAME = /^[0-9a-f]{32}\.bin$/;
export const MANIFEST_NAME = 'manifest.json';
/** Every file name allowed in the synced tree. */
export const TREE_NAME = /^(manifest\.json|[0-9a-f]{32}\.bin)$/;
const STATE_ID = /^[a-z0-9]{16,40}$/;

/** What the sealed manifest says about one stored part of an object. */
export interface ObjectEntry { file: string; bytes: number; sha256: string; class: ObjectClass; part: number; of: number }
export interface SealedPart { entry: ObjectEntry; data: Buffer }
/** `data` is undefined when the manifest lists a file the store does not have. */
export interface OpenPart { entry: ObjectEntry; data: Buffer | undefined }

/** Rounds n up to a multiple of 2^(floor(log2 n) - 3), never below the 64 KiB floor. */
export function padmeLength(n: number): number {
  if (!Number.isFinite(n) || n <= MIN_PADDED_BYTES) return MIN_PADDED_BYTES;
  const exponent = Math.floor(Math.log2(n));
  const bucket = 2 ** (exponent - 3);
  return Math.max(MIN_PADDED_BYTES, Math.ceil(n / bucket) * bucket);
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sealPart(dataKey: Buffer, stateId: string, cls: ObjectClass, plaintext: Buffer, part: number, of: number): SealedPart {
  const salt = randomBytes(SALT_BYTES);
  const sealed = sealRaw(subKey(dataKey, 'object', salt), plaintext, aadFor(stateId, cls, part, of));
  const data = Buffer.concat([OBJECT_MAGIC, Buffer.from([OBJECT_VERSION]), salt, sealed.iv, sealed.tag, sealed.data]);
  const file = `${randomBytes(16).toString('hex')}.bin`;
  return { entry: { file, bytes: data.length, sha256: sha256Hex(data), class: cls, part, of }, data };
}

/** Serialises, compresses, pads and seals a payload; one part unless the compressed size passes 8 MiB. */
export function sealObject(dataKey: Buffer, stateId: string, cls: ObjectClass, payload: unknown): SealedPart[] {
  const json = JSON.stringify(payload);
  if (typeof json !== 'string') throw new Error('The payload cannot be written as JSON.');
  const compressed = brotliCompressSync(Buffer.from(json, 'utf8'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
  const framed = Buffer.alloc(4 + compressed.length);
  framed.writeUInt32BE(compressed.length, 0);
  compressed.copy(framed, 4);
  const of = Math.ceil(framed.length / MAX_PART_BYTES);
  const parts: SealedPart[] = [];
  for (let part = 0; part < of; part += 1) {
    const chunk = framed.subarray(part * MAX_PART_BYTES, (part + 1) * MAX_PART_BYTES);
    const padded = Buffer.concat([chunk, randomBytes(padmeLength(chunk.length) - chunk.length)]);
    parts.push(sealPart(dataKey, stateId, cls, padded, part, of));
  }
  return parts;
}

function openPart(dataKey: Buffer, stateId: string, cls: ObjectClass, part: OpenPart): Buffer {
  const data = part.data as Buffer;
  if (data.length < OBJECT_HEADER_BYTES || !data.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC) || data[OBJECT_MAGIC.length] !== OBJECT_VERSION) {
    throw new StateRefusedError('unsupported-format');
  }
  let offset = OBJECT_MAGIC.length + 1;
  const salt = data.subarray(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const iv = data.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = data.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  return openRaw(subKey(dataKey, 'object', Buffer.from(salt)), { iv, tag, data: data.subarray(offset) }, aadFor(stateId, cls, part.entry.part, part.entry.of));
}

const OBJECT_CLASSES: readonly ObjectClass[] = ['hot', 'cold', 'index'];
const MAX_PART_FILE_BYTES = MAX_PART_BYTES + OBJECT_HEADER_BYTES;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function sameDigest(entryHash: string, data: Buffer): boolean {
  if (!SHA256_HEX.test(entryHash)) throw new StateRefusedError('unsupported-format');
  return timingSafeEqual(Buffer.from(entryHash, 'hex'), createHash('sha256').update(data).digest());
}

/**
 * Opens every part of one object and returns its payload, or refuses with one StateRefusedError and returns nothing. Order of checks, all before
 * any plaintext leaves: the parts form one complete set of this class; each is present; its byte count and sha256 match what the sealed manifest
 * listed; each authenticates under its own key and position; the length prefix fits; the decompressed size stays under 256 MiB.
 */
export function openObject(dataKey: Buffer, stateId: string, cls: ObjectClass, parts: readonly OpenPart[]): unknown {
  if (parts.length === 0) throw new StateRefusedError('missing-object');
  const of = parts[0]?.entry.of ?? 0;
  if (!Number.isInteger(of) || of < 1 || of > MAX_OBJECT_ENTRIES) throw new StateRefusedError('unsupported-format');
  const ordered: Array<OpenPart | undefined> = new Array<OpenPart | undefined>(of).fill(undefined);
  for (const part of parts) {
    const { entry } = part;
    if (entry.class !== cls || entry.of !== of || !Number.isInteger(entry.part) || entry.part < 0 || entry.part >= of || ordered[entry.part] !== undefined) {
      throw new StateRefusedError('tampered');
    }
    ordered[entry.part] = part;
  }
  const checked = ordered.map((part): Buffer => {
    if (part === undefined || part.data === undefined) throw new StateRefusedError('missing-object');
    if (!Number.isInteger(part.entry.bytes) || part.entry.bytes < OBJECT_HEADER_BYTES || part.entry.bytes > MAX_PART_FILE_BYTES) throw new StateRefusedError('unsupported-format');
    if (part.data.length < part.entry.bytes) throw new StateRefusedError('truncated');
    if (part.data.length > part.entry.bytes || !sameDigest(part.entry.sha256, part.data)) throw new StateRefusedError('tampered');
    return openPart(dataKey, stateId, cls, part);
  });
  const framed = Buffer.concat(checked);
  if (framed.length < 4) throw new StateRefusedError('truncated');
  const length = framed.readUInt32BE(0);
  if (length > framed.length - 4) throw new StateRefusedError('truncated');
  let json: string;
  try {
    json = brotliDecompressSync(framed.subarray(4, 4 + length), { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8');
    return JSON.parse(json) as unknown;
  } catch {
    // Authenticated bytes that do not decompress or parse (or would expand past the limit) were not written by this program.
    throw new StateRefusedError('tampered');
  }
}

/** The plaintext half of manifest.json. */
export interface ManifestHeader { format: 1; stateId: string; kdf: KdfRecord; wrappedKey: SealedBlob; sealed: SealedBlob }

/** What `sealed` opens to. */
export interface SealedManifest { seq: number; objects: ObjectEntry[]; indexFile: string | null }

export interface ManifestInput {
  stateId: string;
  kdf: KdfRecord;
  wrappedKey: SealedBlob;
  dataKey: Buffer;
  seq: number;
  objects: readonly ObjectEntry[];
  indexFile: string | null;
}

/** The manifest.json text for a tree. Only `format`, `stateId`, `kdf`, `wrappedKey` and `sealed` are plaintext; the object list is inside `sealed`. */
export function buildManifest(input: ManifestInput): string {
  const body: SealedManifest = { seq: input.seq, objects: [...input.objects], indexFile: input.indexFile };
  const sealed = seal(subKey(input.dataKey, 'manifest'), Buffer.from(JSON.stringify(body), 'utf8'), aadFor(input.stateId, 'manifest'));
  const header: ManifestHeader = { format: 1, stateId: input.stateId, kdf: input.kdf, wrappedKey: input.wrappedKey, sealed };
  return `${JSON.stringify(header)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function readBlob(value: unknown): SealedBlob {
  if (!isRecord(value) || !hasOnlyKeys(value, ['iv', 'tag', 'data'])) throw new StateRefusedError('unsupported-format');
  const { iv, tag, data } = value;
  if (typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') throw new StateRefusedError('unsupported-format');
  return { iv, tag, data };
}

/** Parses the plaintext half strictly: five keys, format 1, a plain state id, sane scrypt cost, at most 1 MiB. Anything else is unsupported. */
export function readManifestHeader(text: string): ManifestHeader {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new StateRefusedError('unsupported-format');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StateRefusedError('unsupported-format');
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['format', 'stateId', 'kdf', 'wrappedKey', 'sealed'])) throw new StateRefusedError('unsupported-format');
  if (parsed.format !== 1 || typeof parsed.stateId !== 'string' || !STATE_ID.test(parsed.stateId)) throw new StateRefusedError('unsupported-format');
  const kdf = parsed.kdf;
  if (!isRecord(kdf) || !hasOnlyKeys(kdf, ['name', 'N', 'r', 'p', 'salt']) || typeof kdf.salt !== 'string') throw new StateRefusedError('unsupported-format');
  const params = assertKdfParams(kdf);
  const saltBytes = Buffer.from(kdf.salt, 'base64');
  if (saltBytes.length < 8 || saltBytes.length > 64 || saltBytes.toString('base64') !== kdf.salt) throw new StateRefusedError('unsupported-format');
  return { format: 1, stateId: parsed.stateId, kdf: { ...params, salt: kdf.salt }, wrappedKey: readBlob(parsed.wrappedKey), sealed: readBlob(parsed.sealed) };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readEntry(value: unknown): ObjectEntry {
  if (!isRecord(value) || !hasOnlyKeys(value, ['file', 'bytes', 'sha256', 'class', 'part', 'of'])) throw new StateRefusedError('unsupported-format');
  const { file, bytes, sha256, part, of } = value;
  const cls = value.class;
  if (typeof file !== 'string' || !OBJECT_NAME.test(file) || typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) throw new StateRefusedError('unsupported-format');
  if (typeof cls !== 'string' || !OBJECT_CLASSES.includes(cls as ObjectClass)) throw new StateRefusedError('unsupported-format');
  if (!nonNegativeInteger(bytes) || bytes < OBJECT_HEADER_BYTES || bytes > MAX_PART_FILE_BYTES) throw new StateRefusedError('unsupported-format');
  if (!nonNegativeInteger(part) || !nonNegativeInteger(of) || of < 1 || of > MAX_OBJECT_ENTRIES || part >= of) throw new StateRefusedError('unsupported-format');
  return { file, bytes, sha256, class: cls as ObjectClass, part, of };
}

/**
 * Opens the sealed half of a manifest. In order: header parse, sealed open (tampered), seq not below lastSeenSeq (rolled-back), then every entry
 * well formed (unsupported-format). It returns only after all succeed.
 */
export function openManifest(text: string, dataKey: Buffer, lastSeenSeq: number): SealedManifest & { header: ManifestHeader } {
  const header = readManifestHeader(text);
  const plain = open(subKey(dataKey, 'manifest'), header.sealed, aadFor(header.stateId, 'manifest'));
  let body: unknown;
  try {
    body = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new StateRefusedError('tampered');
  }
  if (!isRecord(body) || !hasOnlyKeys(body, ['seq', 'objects', 'indexFile']) || !nonNegativeInteger(body.seq) || !Array.isArray(body.objects)) {
    throw new StateRefusedError('unsupported-format');
  }
  if (body.seq < lastSeenSeq) throw new StateRefusedError('rolled-back');
  if (body.objects.length > MAX_OBJECT_ENTRIES) throw new StateRefusedError('unsupported-format');
  const objects = (body.objects as unknown[]).map(readEntry);
  const files = new Set(objects.map((entry) => entry.file));
  if (files.size !== objects.length) throw new StateRefusedError('unsupported-format');
  const indexFile = body.indexFile;
  if (indexFile !== null && (typeof indexFile !== 'string' || !OBJECT_NAME.test(indexFile) || !files.has(indexFile))) throw new StateRefusedError('unsupported-format');
  return { header, seq: body.seq, objects, indexFile };
}

// The padded, sealed objects and the manifest that make up the synced state tree (D-09). The tree holds exactly `manifest.json` (plaintext: a
// new computer needs it to derive the key) and `<32 hex>.bin` objects. An object is
//   NAS1 | version 1 | object salt(16) | iv(12) | tag(16) | AES-256-GCM( u32 length | brotli(JSON) | random padding )
// under a key derived from the data key and the object's own salt. Sizes fall into Padme buckets (8 per octave, 64 KiB floor, at most 12.5% over)
// and no part exceeds 8 MiB. Names are random, never derived from any id. Pure: no vscode, no files, no git.
import { createHash, randomBytes } from 'node:crypto';
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

/** Opens every part of one object and returns its payload. */
export function openObject(dataKey: Buffer, stateId: string, cls: ObjectClass, parts: readonly OpenPart[]): unknown {
  const ordered = [...parts].sort((a, b) => a.entry.part - b.entry.part);
  const framed = Buffer.concat(ordered.map((part) => openPart(dataKey, stateId, cls, part)));
  const length = framed.readUInt32BE(0);
  const json = brotliDecompressSync(framed.subarray(4, 4 + length)).toString('utf8');
  return JSON.parse(json) as unknown;
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

/** Opens the sealed half of a manifest. */
export function openManifest(text: string, dataKey: Buffer, lastSeenSeq: number): SealedManifest & { header: ManifestHeader } {
  void lastSeenSeq;
  const header = readManifestHeader(text);
  const plain = open(subKey(dataKey, 'manifest'), header.sealed, aadFor(header.stateId, 'manifest'));
  const body = JSON.parse(plain.toString('utf8')) as SealedManifest;
  return { header, seq: body.seq, objects: body.objects, indexFile: body.indexFile };
}

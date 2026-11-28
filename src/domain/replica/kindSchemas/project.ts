// Data schemas for the project family: project.genesis and project.import (DESIGN 7.1, 14; D-07). Hub-side: pure, no Yjs; it must not import kinds.ts.
// Owner: 30-04. It also exports the small checks the other family files of this plan share (closed keys with a named path, one-line text, own reads),
// and since 31-09 the device descriptor check, which the genesis lead and the roster kinds share. roster.ts imports it from here, so this file never
// imports roster.ts.
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { isSlot } from '../clientIds';
import { writerIdOf } from '../entry';
import { kemProblem } from './device';
import { exactKeys, invalidAt, isBase64urlBytes, isHash, isIsoTime, isSlug } from './shared';

export const STREAM_HEX = /^[0-9a-f]{32}$/;
// The largest legacy file a project.import carries whole (D-31): the staff file limit of today's single-machine host (MAX_STAFF_FILE_BYTES in
// src/staff/staffFiles.ts), kept here as a plain value so this hub-side file imports nothing from the host. Its base64url text is about 2.8 MB, which
// buildEntry moves into a sealed blob under BLOB_MAX_BYTES.
export const LEGACY_FILE_MAX_BYTES = 2 * 1024 * 1024;
// The product ledger's head mark as today's host keeps it: one line of JSON (a signed staff-ledger-head envelope).
const MARK_MAX_CHARS = 4096;
// What a project.import carries (D-20): the whole legacy ledger, or the lines of one cell's products. No scope reads as whole.
export const IMPORT_SCOPES = ['whole', 'cell'] as const;
export type ImportScope = typeof IMPORT_SCOPES[number];
// The cells a genesis may name with their first epoch and grant (D-44, D-49).
const MAX_GENESIS_CELLS = 64;
const ED25519_PUBLIC_BYTES = 32;
const X25519_PUBLIC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

// Own-property read: a key that is not an own property of the record reads as undefined, whatever the prototype holds.
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// The path of the first missing or unexpected key, or undefined when the keys are exactly the required ones plus any of the optional ones.
export function keyProblem(data: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): string | undefined {
  const present = Object.keys(data);
  for (const key of required) if (!present.includes(key)) return invalidAt(`${path}.${key}`, 'missing field');
  for (const key of present) if (!required.includes(key) && !optional.includes(key)) return invalidAt(`${path}.${key.slice(0, 40)}`, 'field not allowed');
  return undefined;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// One line of text: 1 to max characters, no control characters, no leading or trailing space. Names and reasons are shown to people, so they carry no markup tricks.
export function isLine(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !hasControlCharacter(value) && value.trim() === value;
}

export function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return isSafeIntegerInRange(value, 0, max);
}

export function isStreamHex(value: unknown): value is string {
  return typeof value === 'string' && STREAM_HEX.test(value);
}

function isExactBytes(value: unknown, bytes: number): value is string {
  return isBase64urlBytes(value, bytes) && Buffer.from(value, 'base64url').length === bytes;
}

// A device as the roster names it (DESIGN 7.4): the Ed25519 key it signs with, the X25519 key it opens wraps with, and the Ed25519 signature that binds
// them. slot is its roster slot (D-41), 1 to 4095, never reused, assigned in the entry that admits or adds the device; it is optional on the wire so
// every Phase 30 sample stays valid, and the roster fold requires it where D-41 needs it. kem is the device's optional post-quantum keys with their
// binding (33.2 D-03), written only in projects that require wrap@2; without it the descriptor is exactly as before.
export function deviceProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, ['writer', 'publicKey', 'x25519', 'x25519Sig'], ['slot', 'kem']);
  if (keys !== undefined) return keys;
  if (!isHash(value.writer)) return invalidAt(`${path}.writer`);
  if (!isExactBytes(value.publicKey, ED25519_PUBLIC_BYTES)) return invalidAt(`${path}.publicKey`);
  if (!isExactBytes(value.x25519, X25519_PUBLIC_BYTES)) return invalidAt(`${path}.x25519`);
  if (!isExactBytes(value.x25519Sig, ED25519_SIGNATURE_BYTES)) return invalidAt(`${path}.x25519Sig`);
  // The writer id of a device is the hash of its signing key, so a descriptor that names another writer is wrong on its face.
  if (value.writer !== writerIdOf(value.publicKey)) return invalidAt(`${path}.writer`, 'not the hash of the key');
  if (hasOwn(value, 'slot') && !isSlot(value.slot)) return invalidAt(`${path}.slot`);
  if (hasOwn(value, 'kem')) return kemProblem(value.kem, `${path}.kem`);
  return undefined;
}

// The first cells of a genesis: at most 64 of { cell, epoch, grant }, each cell named once. epoch starts at 1 (never 0); grant is the sha256 of the
// signed grant object (D-44).
function genesisCellsProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_GENESIS_CELLS) return invalidAt(path);
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    const at = `${path}[${index}]`;
    if (!isRecord(item)) return invalidAt(at);
    const keys = keyProblem(item, at, ['cell', 'epoch', 'grant']);
    if (keys !== undefined) return keys;
    if (!isStreamHex(item.cell) || seen.has(item.cell)) return invalidAt(`${at}.cell`);
    seen.add(item.cell);
    if (!isSafeIntegerInRange(item.epoch, 1, Number.MAX_SAFE_INTEGER)) return invalidAt(`${at}.epoch`);
    if (!isHash(item.grant)) return invalidAt(`${at}.grant`);
  }
  return undefined;
}

// The whole legacy file as strict base64url, at most LEGACY_FILE_MAX_BYTES decoded. The length is checked before any decoding, so an oversized text
// costs nothing. An empty file is a whole file too: its encoding is the empty text.
export function isLegacyFile(value: unknown): value is string {
  return value === '' || isBase64urlBytes(value, LEGACY_FILE_MAX_BYTES);
}

// ---- a small table-driven checker the family files of this plan share ----

export type Check = (value: unknown, path: string) => string | undefined;
// rule: a check across fields (this needs that, these never together), run after every field passed its own check.
export interface Shape { required: Record<string, Check>; optional?: Record<string, Check>; atLeastOneOf?: readonly string[]; rule?: (data: Record<string, unknown>, path: string) => string | undefined }

export const slugCheck: Check = (value, path) => (isSlug(value) ? undefined : invalidAt(path));
export const hashCheck: Check = (value, path) => (isHash(value) ? undefined : invalidAt(path));
export const streamCheck: Check = (value, path) => (isStreamHex(value) ? undefined : invalidAt(path));
export const countCheck: Check = (value, path) => (isCount(value) ? undefined : invalidAt(path));
export const timeCheck: Check = (value, path) => (isIsoTime(value) ? undefined : invalidAt(path));
export const lineCheck = (max: number): Check => (value, path) => (isLine(value, max) ? undefined : invalidAt(path));
export const oneOf = (words: readonly string[]): Check => (value, path) => (typeof value === 'string' && words.includes(value) ? undefined : invalidAt(path));
export const flagCheck: Check = (value, path) => (typeof value === 'boolean' ? undefined : invalidAt(path));
export const countBelow = (max: number): Check => (value, path) => (isCount(value, max) ? undefined : invalidAt(path));
export const listOf = (item: Check, max: number): Check => (value, path) => {
  if (!Array.isArray(value) || value.length > max) return invalidAt(path);
  for (let index = 0; index < value.length; index += 1) {
    const problem = item(value[index], `${path}[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

// Checks one record against the table of its kind: exact keys, then each field in table order, so the first wrong field is the one named. The kind is
// looked up by own name, because it is chosen by whoever wrote the entry.
export function validateShape(shapes: Readonly<Record<string, Shape>>, kind: string, data: unknown, path: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(shapes, kind)) return invalidAt(`${path}.kind`);
  if (!isRecord(data)) return invalidAt(path);
  const shape = shapes[kind];
  const required = Object.keys(shape.required);
  const optional = Object.keys(shape.optional ?? {});
  const keys = keyProblem(data, path, required, optional);
  if (keys !== undefined) return keys;
  for (const key of required) {
    const problem = shape.required[key](own(data, key), `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  for (const key of optional) {
    if (!hasOwn(data, key)) continue;
    const problem = (shape.optional as Record<string, Check>)[key](own(data, key), `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  if (shape.atLeastOneOf !== undefined && !shape.atLeastOneOf.some((key) => hasOwn(data, key))) return invalidAt(path, 'nothing to change');
  return shape.rule?.(data, path);
}

// Returns a reason, or undefined when the data is valid.
export function validateProjectData(kind: string, data: unknown, path: string): string | undefined {
  if (!isRecord(data)) return invalidAt(path);
  if (kind === 'project.genesis') {
    // lead.device, level and cells are optional so every Phase 30 genesis stays valid (D-07, D-49); the roster fold requires lead.device.
    const keys = keyProblem(data, path, ['project', 'name', 'profile', 'labelMapHash', 'lead'], ['hub', 'level', 'cells']);
    if (keys !== undefined) return keys;
    if (!isStreamHex(data.project)) return invalidAt(`${path}.project`);
    if (!isLine(data.name, 120)) return invalidAt(`${path}.name`);
    if (!isSlug(data.profile)) return invalidAt(`${path}.profile`);
    if (!isHash(data.labelMapHash)) return invalidAt(`${path}.labelMapHash`);
    const lead = data.lead;
    if (!isRecord(lead) || !exactKeys(lead, ['member', 'writer'], ['device'])) return invalidAt(`${path}.lead`);
    if (!isSlug(lead.member)) return invalidAt(`${path}.lead.member`);
    if (!isHash(lead.writer)) return invalidAt(`${path}.lead.writer`);
    if (hasOwn(lead, 'device')) {
      const device = deviceProblem(lead.device, `${path}.lead.device`);
      if (device !== undefined) return device;
      // The lead's device is the one the genesis names as the lead's writer, so the anchor a joiner pins names one device, not two.
      if ((lead.device as Record<string, unknown>).writer !== lead.writer) return invalidAt(`${path}.lead.device.writer`, 'not the lead writer');
    }
    if (hasOwn(data, 'level') && !isSlug(data.level)) return invalidAt(`${path}.level`);
    if (hasOwn(data, 'cells')) {
      const cells = genesisCellsProblem(data.cells, `${path}.cells`);
      if (cells !== undefined) return cells;
    }
    if (hasOwn(data, 'hub')) {
      const hub = data.hub;
      if (!isRecord(hub) || !exactKeys(hub, ['writer', 'certPin'])) return invalidAt(`${path}.hub`);
      if (!isHash(hub.writer)) return invalidAt(`${path}.hub.writer`);
      if (!isHash(hub.certPin)) return invalidAt(`${path}.hub.certPin`);
    }
    return undefined;
  }
  if (kind === 'project.import') {
    // file and mark are optional so every Phase 30 import stays valid (D-31, D-49); migration writes both where the ledger has them. scope and lines
    // (D-20) are optional too: an import with no scope is the whole ledger, as every Phase 31 import is.
    const keys = keyProblem(data, path, ['ledger', 'legacyHead', 'count'], ['file', 'mark', 'scope', 'lines']);
    if (keys !== undefined) return keys;
    if (!isSlug(data.ledger)) return invalidAt(`${path}.ledger`);
    if (!isHash(data.legacyHead)) return invalidAt(`${path}.legacyHead`);
    if (!isCount(data.count)) return invalidAt(`${path}.count`);
    if (hasOwn(data, 'file') && !isLegacyFile(data.file)) return invalidAt(`${path}.file`);
    if (hasOwn(data, 'mark') && !isLine(data.mark, MARK_MAX_CHARS)) return invalidAt(`${path}.mark`);
    if (hasOwn(data, 'scope') && !(IMPORT_SCOPES as readonly unknown[]).includes(data.scope)) return invalidAt(`${path}.scope`);
    if (hasOwn(data, 'lines') && !isCount(data.lines)) return invalidAt(`${path}.lines`);
    // A cell import carries only the lines for one cell's products (D-20): it names how many and carries them, and it has no head mark, because the
    // signed mark is for the whole ledger. lines means nothing on a whole import.
    if (data.scope === 'cell') {
      if (!hasOwn(data, 'file')) return invalidAt(`${path}.file`, 'a cell import carries its lines');
      if (!hasOwn(data, 'lines')) return invalidAt(`${path}.lines`, 'a cell import names how many lines it carries');
      if (hasOwn(data, 'mark')) return invalidAt(`${path}.mark`, 'only a whole import carries the head mark');
    } else if (hasOwn(data, 'lines')) {
      return invalidAt(`${path}.lines`, 'only a cell import names lines');
    }
    return undefined;
  }
  return invalidAt(`${path}.kind`);
}

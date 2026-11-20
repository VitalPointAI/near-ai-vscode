// Data schemas for the project family: project.genesis and project.import (DESIGN 7.1, 14; D-07). Hub-side: pure, no Yjs; it must not import kinds.ts.
// Owner: 30-04. It also exports the small checks the other family files of this plan share (closed keys with a named path, one-line text, own reads).
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { exactKeys, invalidAt, isBase64urlBytes, isHash, isIsoTime, isSlug } from './shared';

export const STREAM_HEX = /^[0-9a-f]{32}$/;
// The largest legacy file a project.import carries whole (D-31): the staff file limit of today's single-machine host (MAX_STAFF_FILE_BYTES in
// src/staff/staffFiles.ts), kept here as a plain value so this hub-side file imports nothing from the host. Its base64url text is about 2.8 MB, which
// buildEntry moves into a sealed blob under BLOB_MAX_BYTES.
export const LEGACY_FILE_MAX_BYTES = 2 * 1024 * 1024;
// The product ledger's head mark as today's host keeps it: one line of JSON (a signed staff-ledger-head envelope).
const MARK_MAX_CHARS = 4096;

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

// The whole legacy file as strict base64url, at most LEGACY_FILE_MAX_BYTES decoded. The length is checked before any decoding, so an oversized text
// costs nothing. An empty file is a whole file too: its encoding is the empty text.
export function isLegacyFile(value: unknown): value is string {
  return value === '' || isBase64urlBytes(value, LEGACY_FILE_MAX_BYTES);
}

// ---- a small table-driven checker the family files of this plan share ----

export type Check = (value: unknown, path: string) => string | undefined;
export interface Shape { required: Record<string, Check>; optional?: Record<string, Check>; atLeastOneOf?: readonly string[] }

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
  return undefined;
}

// Returns a reason, or undefined when the data is valid.
export function validateProjectData(kind: string, data: unknown, path: string): string | undefined {
  if (!isRecord(data)) return invalidAt(path);
  if (kind === 'project.genesis') {
    const keys = keyProblem(data, path, ['project', 'name', 'profile', 'labelMapHash', 'lead'], ['hub']);
    if (keys !== undefined) return keys;
    if (!isStreamHex(data.project)) return invalidAt(`${path}.project`);
    if (!isLine(data.name, 120)) return invalidAt(`${path}.name`);
    if (!isSlug(data.profile)) return invalidAt(`${path}.profile`);
    if (!isHash(data.labelMapHash)) return invalidAt(`${path}.labelMapHash`);
    const lead = data.lead;
    if (!isRecord(lead) || !exactKeys(lead, ['member', 'writer'])) return invalidAt(`${path}.lead`);
    if (!isSlug(lead.member)) return invalidAt(`${path}.lead.member`);
    if (!isHash(lead.writer)) return invalidAt(`${path}.lead.writer`);
    if (hasOwn(data, 'hub')) {
      const hub = data.hub;
      if (!isRecord(hub) || !exactKeys(hub, ['writer', 'certPin'])) return invalidAt(`${path}.hub`);
      if (!isHash(hub.writer)) return invalidAt(`${path}.hub.writer`);
      if (!isHash(hub.certPin)) return invalidAt(`${path}.hub.certPin`);
    }
    return undefined;
  }
  if (kind === 'project.import') {
    // file and mark are optional so every Phase 30 import stays valid (D-31, D-49); migration writes both where the ledger has them.
    const keys = keyProblem(data, path, ['ledger', 'legacyHead', 'count'], ['file', 'mark']);
    if (keys !== undefined) return keys;
    if (!isSlug(data.ledger)) return invalidAt(`${path}.ledger`);
    if (!isHash(data.legacyHead)) return invalidAt(`${path}.legacyHead`);
    if (!isCount(data.count)) return invalidAt(`${path}.count`);
    if (hasOwn(data, 'file') && !isLegacyFile(data.file)) return invalidAt(`${path}.file`);
    if (hasOwn(data, 'mark') && !isLine(data.mark, MARK_MAX_CHARS)) return invalidAt(`${path}.mark`);
    return undefined;
  }
  return invalidAt(`${path}.kind`);
}

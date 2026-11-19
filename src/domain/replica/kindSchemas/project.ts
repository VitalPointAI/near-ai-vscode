// Data schemas for the project family: project.genesis and project.import (DESIGN 7.1, 14; D-07). Hub-side: pure, no Yjs; it must not import kinds.ts.
// Owner: 30-04. It also exports the small checks the other family files of this plan share (closed keys with a named path, one-line text, own reads).
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { exactKeys, invalidAt, isHash, isSlug } from './shared';

export const STREAM_HEX = /^[0-9a-f]{32}$/;

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
    const keys = keyProblem(data, path, ['ledger', 'legacyHead', 'count']);
    if (keys !== undefined) return keys;
    if (!isSlug(data.ledger)) return invalidAt(`${path}.ledger`);
    if (!isHash(data.legacyHead)) return invalidAt(`${path}.legacyHead`);
    if (!isCount(data.count)) return invalidAt(`${path}.count`);
    return undefined;
  }
  return invalidAt(`${path}.kind`);
}

// Data schemas for the doc family: doc.client and doc.update (D-18, D-19). Hub-side: it checks update bytes as base64url and never loads Yjs.
// It must not import kinds.ts (no import cycle).
import { isStrictBase64url } from '../../team/canonical';
import { isRecord, isSafeIntegerInRange, matches } from '../../team/validate';
import { isActorShape } from '../entry';

// The most bytes one update may carry once decoded. doc.ts imports this, never the reverse.
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024;
const PRODUCT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_CLIENT_ID = 4294967295;

function bad(path: string): string {
  return `bad-data: ${path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, 120)}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

// Whole bytes a base64url text decodes to, or undefined when its length cannot be a whole number of bytes.
function decodedLength(text: string): number | undefined {
  if (text.length % 4 === 1) return undefined;
  return Math.floor((text.length * 3) / 4);
}

// Returns a reason, or undefined when the data is valid.
export function validateDocData(kind: string, data: unknown, path: string): string | undefined {
  if (!isRecord(data)) return bad(path);
  if (kind === 'doc.client') {
    if (!exactKeys(data, ['product', 'clientId', 'actor'])) return bad(path);
    if (!matches(data.product, PRODUCT_PATTERN)) return bad(`${path}.product`);
    if (!isSafeIntegerInRange(data.clientId, 1, MAX_CLIENT_ID)) return bad(`${path}.clientId`);
    if (!isActorShape(data.actor)) return bad(`${path}.actor`);
    return undefined;
  }
  if (kind === 'doc.update') {
    if (!exactKeys(data, ['product', 'update'])) return bad(path);
    if (!matches(data.product, PRODUCT_PATTERN)) return bad(`${path}.product`);
    const update = data.update;
    const length = typeof update === 'string' ? decodedLength(update) : undefined;
    if (typeof update !== 'string' || length === undefined || length < 1 || length > MAX_UPDATE_BYTES || !isStrictBase64url(update, length)) return bad(`${path}.update`);
    return undefined;
  }
  return bad(`${path}.kind`);
}

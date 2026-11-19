// Data schemas for the doc family: doc.client and doc.update (D-18, D-19), and doc.compact, which fails closed until 30-06 writes it.
// Hub-side: it checks update bytes as base64url and never loads Yjs. It must not import kinds.ts (no import cycle).
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { exactKeys, invalidAt, isActor, isBase64urlBytes, isSlug, schemaPending } from './shared';

// The most bytes one update may carry once decoded. doc.ts imports this, never the reverse.
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024;
export const MAX_CLIENT_ID = 4294967295;

// Returns a reason, or undefined when the data is valid.
export function validateDocData(kind: string, data: unknown, path: string): string | undefined {
  if (kind === 'doc.compact') return schemaPending('doc', kind);
  if (!isRecord(data)) return invalidAt(path);
  if (kind === 'doc.client') {
    if (!exactKeys(data, ['product', 'clientId', 'actor'])) return invalidAt(path);
    if (!isSlug(data.product)) return invalidAt(`${path}.product`);
    if (!isSafeIntegerInRange(data.clientId, 1, MAX_CLIENT_ID)) return invalidAt(`${path}.clientId`);
    if (!isActor(data.actor)) return invalidAt(`${path}.actor`);
    return undefined;
  }
  if (kind === 'doc.update') {
    if (!exactKeys(data, ['product', 'update'])) return invalidAt(path);
    if (!isSlug(data.product)) return invalidAt(`${path}.product`);
    if (!isBase64urlBytes(data.update, MAX_UPDATE_BYTES)) return invalidAt(`${path}.update`);
    return undefined;
  }
  return invalidAt(`${path}.kind`);
}

// Data schemas for the doc family: doc.client and doc.update (D-18, D-19) and doc.compact (D-21, D-37).
// Hub-side: it checks update bytes as base64url and never loads Yjs. It must not import kinds.ts (no import cycle).
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { exactKeys, invalidAt, isActor, isBase64urlBytes, isDep, isHash, isSlug } from './shared';

// The most bytes one update may carry once decoded. doc.ts imports this, never the reverse.
export const MAX_UPDATE_BYTES = 4 * 1024 * 1024;
export const MAX_CLIENT_ID = 4294967295;
// A compaction names the heads it covers (at most this many) and the state vector of its full state (at most this many clients).
export const MAX_COMPACT_COVERS = 64;
export const MAX_COMPACT_CLIENTS = 100_000;

// Sorted [client, clock] pairs with each client once, as the fold's state vector is written.
function isStateVector(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_COMPACT_CLIENTS) return false;
  let previous = 0;
  for (const pair of value as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [client, clock] = pair as unknown[];
    if (!isSafeIntegerInRange(client, 1, MAX_CLIENT_ID) || !isSafeIntegerInRange(clock, 0, Number.MAX_SAFE_INTEGER)) return false;
    if (client <= previous) return false;
    previous = client;
  }
  return true;
}

// Returns a reason, or undefined when the data is valid.
export function validateDocData(kind: string, data: unknown, path: string): string | undefined {
  if (!isRecord(data)) return invalidAt(path);
  if (kind === 'doc.compact') {
    if (!exactKeys(data, ['product', 'covers', 'stateVector', 'textHash', 'stateBlob'])) return invalidAt(path);
    if (!isSlug(data.product)) return invalidAt(`${path}.product`);
    if (!Array.isArray(data.covers) || data.covers.length > MAX_COMPACT_COVERS || !(data.covers as unknown[]).every(isDep)) return invalidAt(`${path}.covers`);
    if (!isStateVector(data.stateVector)) return invalidAt(`${path}.stateVector`);
    if (!isHash(data.textHash)) return invalidAt(`${path}.textHash`);
    if (!isHash(data.stateBlob)) return invalidAt(`${path}.stateBlob`);
    return undefined;
  }
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

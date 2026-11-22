// Pure: hashing only, no I/O.
import { createHash } from 'node:crypto';
import { canonicalize } from '../team/canonical';

export const GENESIS_PREV = '0'.repeat(64);
const HASH = /^[0-9a-f]{64}$/;
const LINE_KEYS = ['seq', 'prev', 'hash', 'event', 'at', 'body'] as const;

export interface ChainLine {
  readonly seq: number;
  readonly prev: string;
  readonly hash: string;
  readonly event: string;
  readonly at: string;
  readonly body: unknown;
}

export interface ChainHead { readonly seq: number; readonly hash: string; }
export type ChainVerdict = { ok: true; head?: ChainHead }
  | { ok: false; at: number; why: 'seq' | 'prev' | 'hash' | 'shape' | 'head-mismatch' | 'truncated' };

export function chainLine(prev: string, seq: number, event: string, at: string, body: unknown): ChainLine {
  const hash = createHash('sha256').update(prev + canonicalize({ seq, event, at, body })).digest('hex');
  return { seq, prev, hash, event, at, body };
}

function isChainLine(value: unknown): value is ChainLine {
  if (value === null || typeof value !== 'object' || Reflect.ownKeys(value).length !== LINE_KEYS.length
      || !LINE_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  const { seq, prev, hash, event, at } = value as ChainLine;
  return Number.isSafeInteger(seq) && seq > 0 && typeof prev === 'string' && HASH.test(prev)
    && typeof hash === 'string' && HASH.test(hash) && typeof event === 'string' && typeof at === 'string';
}

/** `at` is the expected sequence at the first failure, even for a rotated segment. */
export function verifyChain(lines: readonly unknown[], head?: ChainHead, start?: { seq: number; prev: string }): ChainVerdict {
  let seq = start?.seq ?? 0;
  let prev = start?.prev ?? GENESIS_PREV;
  for (const line of lines) {
    const at = seq + 1;
    try {
      if (!isChainLine(line)) return { ok: false, at, why: 'shape' };
      if (line.seq !== at) return { ok: false, at, why: 'seq' };
      if (line.prev !== prev) return { ok: false, at, why: 'prev' };
      if (chainLine(prev, at, line.event, line.at, line.body).hash !== line.hash) return { ok: false, at, why: 'hash' };
      seq = at;
      prev = line.hash;
    } catch {
      return { ok: false, at, why: 'shape' };
    }
  }
  if (head && head.seq > seq) return { ok: false, at: seq + 1, why: 'truncated' };
  if (head && (head.seq !== seq || head.hash !== prev)) return { ok: false, at: seq, why: 'head-mismatch' };
  return seq === 0 ? { ok: true } : { ok: true, head: { seq, hash: prev } };
}

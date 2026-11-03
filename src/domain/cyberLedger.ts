import { createHash } from 'node:crypto';
import { isoTimestamp } from './cyber';

// D-28: every ledger entry hashes its predecessor, so a report can prove nothing in the run was
// edited after the fact. The construction is one-way — changing it breaks verification of every
// report already exported under it.

export interface LedgerEntry {
  index: number;
  timestamp: string;
  tool: string;
  arguments: string;
  result: string;
  modelReasoning: string;
  /** SHA-256 of the evidence blob this step captured, or an empty string when it captured none. */
  evidenceHash: string;
  prevHash: string;
  hash: string;
}

/** The fields that are hashed, in this fixed order; the entry's own `hash` is not one of them. */
export type LedgerFields = Omit<LedgerEntry, 'hash' | 'prevHash'>;

export const GENESIS_PREV_HASH = createHash('sha256').update(Buffer.alloc(32)).digest('hex');

export function hashBlob(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Canonical JSON: fixed key order, so an entry hashes identically however it was built. */
function canonical(fields: LedgerFields & { prevHash: string }): string {
  return JSON.stringify({
    index: fields.index,
    timestamp: fields.timestamp,
    tool: fields.tool,
    arguments: fields.arguments,
    result: fields.result,
    modelReasoning: fields.modelReasoning,
    evidenceHash: fields.evidenceHash,
    prevHash: fields.prevHash
  });
}

const normalizeForHash = (fields: LedgerFields & { prevHash: string }) => ({
  index: fields.index,
  timestamp: isoTimestamp(fields.timestamp),
  tool: fields.tool,
  arguments: fields.arguments,
  result: fields.result,
  modelReasoning: fields.modelReasoning,
  evidenceHash: fields.evidenceHash,
  prevHash: fields.prevHash
});

export function entryHash(fields: LedgerFields & { prevHash: string }): string {
  return hashBlob(canonical(normalizeForHash(fields)));
}

export function createLedgerEntry(fields: LedgerFields & { prevHash: string }): LedgerEntry {
  if (!Number.isInteger(fields.index) || fields.index < 0) throw new Error('A ledger entry needs a non-negative integer index.');
  const normalized = normalizeForHash(fields);
  return { ...normalized, hash: entryHash(normalized) };
}

/** Appends the next entry; refuses an index that is not exactly one past the last. */
export function appendEntry(entries: LedgerEntry[], fields: LedgerFields): LedgerEntry {
  const expected = entries.length;
  if (fields.index !== expected) throw new Error(`Ledger entry ${fields.index} cannot follow a chain of ${expected} entries.`);
  const prevHash = expected === 0 ? GENESIS_PREV_HASH : entries[expected - 1].hash;
  return createLedgerEntry({ ...fields, prevHash });
}

/** True only when every hash recomputes and every entry links to its predecessor. */
export function verifyChain(entries: LedgerEntry[]): boolean {
  return chainBreak(entries) === undefined;
}

/** The first break in the chain, for a report that must say where verification stopped. */
export function chainBreak(entries: LedgerEntry[]): string | undefined {
  let prevHash = GENESIS_PREV_HASH;
  for (const [position, entry] of entries.entries()) {
    if (entry.index !== position) return `entry ${position} is numbered ${entry.index}`;
    if (entry.prevHash !== prevHash) return `entry ${position} does not follow entry ${position - 1}`;
    // A tampered timestamp can be unparseable, which is a break in its own right.
    let recomputed: string;
    try { recomputed = entryHash(entry); } catch { return `entry ${position} holds a field that is no longer valid`; }
    if (recomputed !== entry.hash) return `entry ${position} was modified after it was written`;
    prevHash = entry.hash;
  }
  return undefined;
}

// A thread is an append-only set of entries, one per message, and merging two copies of a thread is set union: nothing is ever dropped or overwritten,
// and no function here removes an entry (threads are archived, never deleted). Pure: no VS Code, no files.
//
// Each entry names the entry it follows (`parent`), so a thread is a tree. Two machines that continue the same thread from the same entry make two
// branches; both stay forever. For display, the main line is the path from the first entry to the newest leaf, and every other branch is shown in full
// after the entry it forked from.
import { createHash } from 'node:crypto';
import { canonicalJson } from './records';

export type ThreadRole = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'notice';

export interface ThreadEntry {
  /** A hash chain over (parent id, role, body): the same continuation has the same id on every machine. */
  id: string;
  thread: string;
  /** The id of the entry this one follows; null for the first entry of a thread. */
  parent: string | null;
  /** When the entry was written, in `new Date().toISOString()` form. Not part of the id. */
  at: string;
  writer: string;
  role: ThreadRole;
  body: unknown;
}

/** Crockford base32, lowercase (no i, l, o, u). */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LENGTH = 26;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The id of an entry: the first 26 characters of the Crockford base32 of sha256(parent or empty, newline, role, newline, canonical body). The body holds
 * no time, so the same message continued on two machines gets one id.
 */
export function entryId(parent: string | null, role: ThreadRole, body: unknown): string {
  const digest = createHash('sha256').update(`${parent ?? ''}\n${role}\n${canonicalJson(body)}`, 'utf8').digest();
  return base32(digest).slice(0, ID_LENGTH);
}

/** Order of entries: at, then writer, then id. Equal times therefore order the same on every machine. */
export function compareEntries(a: ThreadEntry, b: ThreadEntry): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

const NUL = '\u0000';

/**
 * Set union of two copies of a thread's entries, keyed by (thread, id). Copies with one id carry the same message by construction, but two machines may
 * have written it at different times; the earliest copy is kept, so the result does not depend on which side is "first". Sorted by (at, writer, id).
 */
export function unionEntries(a: readonly ThreadEntry[], b: readonly ThreadEntry[]): ThreadEntry[] {
  const entries = new Map<string, ThreadEntry>();
  for (const entry of [...a, ...b]) {
    const key = `${entry.thread}${NUL}${entry.id}`;
    const current = entries.get(key);
    if (!current || earlierCopy(entry, current)) entries.set(key, entry);
  }
  return [...entries.values()].sort(compareEntries);
}

function earlierCopy(candidate: ThreadEntry, current: ThreadEntry): boolean {
  if (candidate.at !== current.at) return candidate.at < current.at;
  if (candidate.writer !== current.writer) return candidate.writer < current.writer;
  return canonicalJson(candidate) < canonicalJson(current);
}

export interface ThreadBranch {
  /** The entry this branch continues from: the last entry it shares with an earlier line; null when it has its own first entry; the missing parent's id when that entry has not arrived yet. */
  forkAt: string | null;
  entries: ThreadEntry[];
}

export interface ThreadLines {
  main: ThreadEntry[];
  branches: ThreadBranch[];
}

/**
 * Arranges the entries of one thread for display. Every entry appears exactly once.
 * - main: from the first entry to the newest leaf, the maximum by (at, writer, id) among the leaves of trees that start at a real first entry (or among
 *   all leaves when none has arrived yet);
 * - branches: every other entry, grouped into chains that each run from the entry after a fork to a leaf, newest leaf first claiming its path; sorted by
 *   their first entry's (at, writer, id). An entry whose parent has not arrived yet starts a branch whose forkAt is that parent's id, so a partial
 *   delivery never hides anything.
 */
export function threadLines(entries: readonly ThreadEntry[]): ThreadLines {
  const byId = new Map<string, ThreadEntry>();
  for (const entry of unionEntries(entries, [])) byId.set(entry.id, entry);
  const parents = new Set<string>();
  for (const entry of byId.values()) if (entry.parent !== null) parents.add(entry.parent);
  const leaves = [...byId.values()].filter((entry) => !parents.has(entry.id)).sort(compareEntries);
  if (leaves.length === 0) return { main: [], branches: [] };

  const covered = new Set<string>();
  // Walks up from a leaf while the parent is present and not yet claimed; an entry is visited once, so a corrupt parent cycle cannot loop.
  const climb = (leaf: ThreadEntry): { chain: ThreadEntry[]; stoppedAt: string | null } => {
    const chain: ThreadEntry[] = [];
    const seen = new Set<string>();
    let current: ThreadEntry | undefined = leaf;
    while (current && !covered.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      const parent: ThreadEntry | undefined = current.parent === null ? undefined : byId.get(current.parent);
      if (!parent) return { chain: chain.reverse(), stoppedAt: current.parent };
      current = parent;
    }
    return { chain: chain.reverse(), stoppedAt: current ? current.id : null };
  };
  const startsAtRoot = (chain: ThreadEntry[], stoppedAt: string | null): boolean => stoppedAt === null && chain.length > 0 && chain[0].parent === null;

  let main: ThreadEntry[] = [];
  for (let index = leaves.length - 1; index >= 0; index--) {
    const { chain, stoppedAt } = climb(leaves[index]);
    if (startsAtRoot(chain, stoppedAt)) { main = chain; break; }
  }
  if (main.length === 0) main = climb(leaves[leaves.length - 1]).chain;
  for (const entry of main) covered.add(entry.id);

  const branches: ThreadBranch[] = [];
  for (let index = leaves.length - 1; index >= 0; index--) {
    if (covered.has(leaves[index].id)) continue;
    const { chain, stoppedAt } = climb(leaves[index]);
    for (const entry of chain) covered.add(entry.id);
    branches.push({ forkAt: stoppedAt, entries: chain });
  }
  // Entries only reachable through a parent cycle (corrupt data) are still shown, one branch each.
  for (const entry of [...byId.values()].sort(compareEntries)) {
    if (covered.has(entry.id)) continue;
    covered.add(entry.id);
    branches.push({ forkAt: entry.parent, entries: [entry] });
  }
  branches.sort((x, y) => compareEntries(x.entries[0], y.entries[0]));
  return { main, branches };
}

/** The id of the last entry of the main line, or undefined for an empty thread. */
export function threadTip(entries: readonly ThreadEntry[]): string | undefined {
  const { main } = threadLines(entries);
  return main.length === 0 ? undefined : main[main.length - 1].id;
}

/** The most one tool result is stored with. Nothing else is shortened. */
export const TOOL_RESULT_CAP_BYTES = 2 * 1024 * 1024;

export interface CappedResult { text: string; shortenedBytes?: number }

/**
 * Keeps a tool result whole up to 2 MiB of UTF-8. A larger one is cut at that many bytes, backing off to a character boundary, and records the original
 * byte length so the view can say how much was not stored.
 */
export function capToolResult(text: string): CappedResult {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= TOOL_RESULT_CAP_BYTES) return { text };
  const bytes = Buffer.from(text, 'utf8');
  let end = TOOL_RESULT_CAP_BYTES;
  // A byte of the form 10xxxxxx continues a character that began earlier: back off to just before that character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), shortenedBytes: size };
}

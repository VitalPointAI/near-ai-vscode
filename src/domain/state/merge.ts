// How two copies of one record combine, the same way on every machine whatever order they meet in. Pure: no VS Code, no files.
//
// The rule for one (kind, id) given a local copy L and a remote copy R:
//   1. the same revision: keep one (the later written, so the choice does not depend on which side is "local");
//   2. one was written from the other (basedOn): the descendant wins;
//   3. neither (both machines edited without seeing the other): keep the newer by (at, writer, rev), and for a kind whose policy is 'fork' keep the older too,
//      under a new id, so a person's saved work is never dropped;
//   4. a tombstone wins over a record only when it is strictly newer; an edit after a delete resurrects the record.
// The laws (commutative, associative, idempotent) hold for histories where an edit is stamped later than the record it edits (makeRecord's `base` does
// that) and where a record that two machines both extended is merged with the extensions, not with their common ancestor alone; src/test/stateMerge.test.ts
// states and checks them.
import { createHash } from 'node:crypto';
import { baseId, canonicalJson, MERGE_POLICY, type StateRecord } from './records';

/** The id a forked copy gets: the original id plus 12 hex characters of sha256(id + rev). The same copy gets the same id on every machine. */
export function forkId(id: string, rev: string): string {
  return `${id}~${createHash('sha256').update(id + rev, 'utf8').digest('hex').slice(0, 12)}`;
}

/** Total order on records: at, then writer, then rev, then the whole canonical text (so two different records never compare equal). */
export function compareRecords(a: StateRecord, b: StateRecord): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
  if (a.rev !== b.rev) return a.rev < b.rev ? -1 : 1;
  return compareText(canonicalJson(a), canonicalJson(b));
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

const newest = (a: StateRecord, b: StateRecord): StateRecord => (compareRecords(a, b) >= 0 ? a : b);

/** The kind a record occupies a slot of: a tombstone sits in the slot of the kind it deletes. */
export function slotKind(record: StateRecord): string {
  return record.kind === 'tombstone' ? (record.body as { target: string }).target : record.kind;
}

export interface MergeResult { keep: StateRecord; fork?: StateRecord }

/** Merges two copies of one (kind, id) slot. `local` may be absent. A fork is only returned for a divergent edit of a 'fork' kind. */
export function mergeRecord(local: StateRecord | undefined, remote: StateRecord): MergeResult {
  if (!local) return { keep: remote };
  if (slotKind(local) !== slotKind(remote) || local.id !== remote.id) throw new TypeError('mergeRecord: the two records are not copies of one record');
  const localStone = local.kind === 'tombstone';
  const remoteStone = remote.kind === 'tombstone';
  if (localStone && remoteStone) return { keep: newest(local, remote) };
  if (localStone || remoteStone) {
    const [stone, record] = localStone ? [local, remote] : [remote, local];
    // A tombstone wins only when strictly newer than the record; at the same instant the record stays.
    return { keep: stone.at > record.at ? stone : record };
  }
  if (local.rev === remote.rev) return { keep: newest(local, remote) };
  const remoteExtendsLocal = remote.basedOn === local.rev;
  const localExtendsRemote = local.basedOn === remote.rev;
  if (remoteExtendsLocal && !localExtendsRemote) return { keep: remote };
  if (localExtendsRemote && !remoteExtendsLocal) return { keep: local };
  const keep = newest(local, remote);
  const older = keep === local ? remote : local;
  if (MERGE_POLICY[local.kind as keyof typeof MERGE_POLICY] !== 'fork') return { keep };
  return { keep, fork: { ...older, id: forkId(older.id, older.rev) } };
}

const NUL = '\u0000';
const slotKey = (record: StateRecord): string => `${slotKind(record)}${NUL}${record.id}`;

/**
 * Merges two sets of records (either may already hold several copies of a slot). The result is normalised and sorted, so equal states give equal
 * arrays: live records by (kind, id), tombstones after them by (target, id).
 * - Records of one slot combine with mergeRecord; the forks that produces are records of their own.
 * - The newest tombstone per slot is always kept, even when a newer edit shadows it, because a copy of the record that meets the tombstone later must
 *   still be removed or forked the same way. A record is dropped when a strictly newer tombstone exists for its id or for the id it was forked from.
 * - Use `liveRecords` to read the records a person should see.
 */
export function mergeRecordSets(a: readonly StateRecord[], b: readonly StateRecord[]): StateRecord[] {
  const live = new Map<string, StateRecord>();
  const stones = new Map<string, StateRecord>();
  const absorb = (record: StateRecord): void => {
    const key = slotKey(record);
    if (record.kind === 'tombstone') {
      const current = stones.get(key);
      stones.set(key, current ? newest(current, record) : record);
      return;
    }
    const { keep, fork } = mergeRecord(live.get(key), record);
    live.set(key, keep);
    if (fork) absorb(fork);
  };
  for (const record of a) absorb(record);
  for (const record of b) absorb(record);
  const survivors = [...live.values()].filter((record) => {
    const own = stones.get(`${record.kind}${NUL}${record.id}`);
    const origin = stones.get(`${record.kind}${NUL}${baseId(record.id)}`);
    return !((own && own.at > record.at) || (origin && origin.at > record.at));
  });
  // Order: live records by kind then id, then tombstones by target then id.
  return [...survivors.sort(byKindThenId), ...[...stones.values()].sort(byKindThenId)];
}

function byKindThenId(a: StateRecord, b: StateRecord): number {
  return compareText(`${slotKind(a)}${NUL}${a.id}`, `${slotKind(b)}${NUL}${b.id}`);
}

/** The records a person should see: everything except tombstones. */
export function liveRecords(records: readonly StateRecord[]): StateRecord[] {
  return records.filter((record) => record.kind !== 'tombstone');
}

/** A line of an append-only log that carries its own identity: `id` plus a version `v` (spend entries), or `rid` (spend actuals), or neither. */
export interface LogLine { id?: unknown; v?: unknown; rid?: unknown; t?: unknown }

function lineKey(line: LogLine): string {
  if (line.t === 'a' && typeof line.rid === 'string') return `a${NUL}${line.rid}`;
  if (typeof line.id === 'string') return `e${NUL}${line.id}`;
  return `j${NUL}${canonicalJson(line)}`;
}

/**
 * Merges two append-only logs as a union keyed by each line's own identity, keeping the highest version `v` of a line that both have (a tie goes to the
 * greater canonical text). Nothing is ever removed. The result is sorted by key, so the order of the inputs does not matter.
 */
export function unionLog<T extends LogLine>(a: readonly T[], b: readonly T[]): T[] {
  const lines = new Map<string, T>();
  for (const line of [...a, ...b]) {
    const key = lineKey(line);
    const current = lines.get(key);
    if (!current) { lines.set(key, line); continue; }
    const currentV = typeof current.v === 'number' ? current.v : 0;
    const lineV = typeof line.v === 'number' ? line.v : 0;
    if (lineV > currentV || (lineV === currentV && compareText(canonicalJson(line), canonicalJson(current)) > 0)) lines.set(key, line);
  }
  return [...lines.entries()].sort(([x], [y]) => compareText(x, y)).map(([, line]) => line);
}

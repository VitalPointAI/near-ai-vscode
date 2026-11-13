// How two copies of one record combine, the same way on every machine whatever order they meet in. Pure: no VS Code, no files.
//
// The rule for one (kind, id) given a local copy L and a remote copy R:
//   1. the same revision: keep one (the later written, so the choice does not depend on which side is "local");
//   2. one was written from the other (basedOn): the descendant wins;
//   3. neither (both machines edited without seeing the other): keep the newer by (at, writer, rev), and for a kind whose policy is 'fork' keep the older too,
//      under a new id, so a person's saved work is never dropped;
//   4. a tombstone wins over a record only when it is strictly newer; an edit after a delete resurrects the record.
// mergeRecord is that rule for two copies; mergeRecordSets applies it to whole sets as a function of the records held, so the result cannot depend on
// order. The laws (commutative, associative, idempotent) hold for histories where an edit is stamped later than every copy of the record it edits
// (makeRecord's `base` does that for the copy it was given) and where a version is not merged in without the edit that superseded it two steps earlier
// (a fork kind edited twice in a row keeps no record of the middle step); src/test/stateMerge.test.ts states and checks them.
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
 * Merges two sets of records (either may already hold several copies of a record). The result depends only on which records the two sets hold, never on
 * their order or on which side held what, and is sorted, so equal states give equal arrays: live records by (kind, id), then tombstones by (target, id).
 * Per record family (an id, and for 'fork' kinds also the forks made from it):
 * - copies with one revision collapse to the later written one;
 * - a version that another version of the family was written from is dropped (the edit supersedes it, rule 2 applied across forks);
 * - a version a strictly newer tombstone covers is dropped (a tombstone for an id also covers the forks made from it);
 * - of what is left, the newest is kept under the family's own id and, for a 'fork' kind, every other version is kept under forkId(id, rev); for the
 *   other kinds only the newest is kept.
 * The newest tombstone of each id is always kept, even when a newer edit shadows it, so a copy of the record that meets the tombstone later is removed
 * the same way. Use `liveRecords` to read the records a person should see.
 */
export function mergeRecordSets(a: readonly StateRecord[], b: readonly StateRecord[]): StateRecord[] {
  const stones = new Map<string, StateRecord>();
  const families = new Map<string, StateRecord[]>();
  for (const record of [...a, ...b]) {
    if (record.kind === 'tombstone') {
      const key = slotKey(record);
      const current = stones.get(key);
      stones.set(key, current ? newest(current, record) : record);
      continue;
    }
    const forks = MERGE_POLICY[record.kind] === 'fork';
    const key = `${record.kind}${NUL}${forks ? baseId(record.id) : record.id}`;
    const members = families.get(key);
    if (members) members.push(record); else families.set(key, [record]);
  }
  const out: StateRecord[] = [];
  for (const members of families.values()) {
    const kind = members[0].kind;
    const forks = MERGE_POLICY[kind as keyof typeof MERGE_POLICY] === 'fork';
    const root = forks ? baseId(members[0].id) : members[0].id;
    const byRev = new Map<string, StateRecord>();
    const extended = new Set<string>();
    for (const member of members) {
      const current = byRev.get(member.rev);
      if (!current || compareRecords(member, current) > 0) byRev.set(member.rev, member);
      if (member.basedOn !== undefined && member.basedOn !== member.rev) extended.add(member.basedOn);
    }
    const covering = stones.get(`${kind}${NUL}${root}`);
    const survivors = [...byRev.values()].filter((member) => {
      if (extended.has(member.rev)) return false;
      const own = forks ? stones.get(`${kind}${NUL}${forkId(root, member.rev)}`) : undefined;
      return !((covering && covering.at > member.at) || (own && own.at > member.at));
    }).sort(compareRecords);
    const winner = survivors.pop();
    if (!winner) continue;
    out.push(winner.id === root ? winner : { ...winner, id: root });
    if (forks) for (const member of survivors) out.push({ ...member, id: forkId(root, member.rev) });
  }
  // Order: live records by kind then id, then tombstones by target then id.
  return [...out.sort(byKindThenId), ...[...stones.values()].sort(byKindThenId)];
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

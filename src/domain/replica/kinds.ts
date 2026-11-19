// The closed list of entry kinds (DESIGN 4.3, D-07) and the body and data validation that goes with it. Hub-side: no Yjs, no fold.
//
// An unknown kind from a newer client is kept and relayed ("made by a newer version") and never changes state. A known kind whose data schema is
// not written yet is refused with SCHEMA_PENDING, so it fails closed.
import { AT_PATTERN, MAX_LAMPORT, isRecord, isSafeIntegerInRange, matches } from '../team/validate';
import { HASH_PATTERN, MAX_DEPS, isActorShape } from './entry';
import type { Dep, EntryBody } from './entry';
import { validateDocData } from './kindSchemas/doc';

export const SCHEMA_PENDING = 'schema not yet defined';

const KINDS_BY_FAMILY = {
  project: ['project.genesis', 'project.import'],
  roster: ['member.invite', 'member.admit', 'member.update', 'member.remove', 'device.add', 'device.rotate', 'device.revoke', 'device.quarantine', 'device.release', 'hub.admit', 'hub.grant', 'hub.revoke', 'cell.create', 'cell.rekey', 'lead.handover', 'roster.choose', 'deputy.name'],
  doc: ['doc.client', 'doc.update', 'doc.compact'],
  versions: ['product.create', 'product.owner', 'version.propose', 'version.verdict', 'version.submit', 'version.withdraw', 'version.decide', 'version.release', 'version.supersede'],
  registers: ['register.row', 'pir.decide', 'watch.decide'],
  watches: ['watch.define', 'watch.assign', 'watch.match', 'watch.state', 'watch.killSwitch'],
  runs: ['run.start', 'run.lane', 'run.claim', 'run.release', 'run.summary', 'run.end'],
  obs: ['obs.segment', 'obs.coalesced', 'obs.pruned'],
  integrity: ['equivocation.proof', 'digest.report']
} as const;

export type KindFamily = keyof typeof KINDS_BY_FAMILY;
export type ReplicaKind = typeof KINDS_BY_FAMILY[KindFamily][number];

// The closed list: DESIGN 4.3 plus deputy.name (DESIGN 7.1), so a deputy lead can be honoured without a format change (D-27).
export const REPLICA_KINDS: readonly ReplicaKind[] = (Object.values(KINDS_BY_FAMILY) as ReadonlyArray<readonly ReplicaKind[]>).flat();

// A Map, because a kind is chosen by whoever wrote the entry.
export const KIND_FAMILIES: ReadonlyMap<string, KindFamily> = new Map(
  (Object.keys(KINDS_BY_FAMILY) as KindFamily[]).flatMap((family) => KINDS_BY_FAMILY[family].map((kind): [string, KindFamily] => [kind, family]))
);

export function kindFamily(kind: string): KindFamily | undefined {
  return KIND_FAMILIES.get(kind);
}

// Families whose reducers exist in Phase 30 (D-09 scope); the other families are kept and relayed until their phase.
export const FOLDED_FAMILIES_PHASE_30: readonly KindFamily[] = ['project', 'doc', 'versions', 'integrity'];

const KIND_PATTERN = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z][A-Za-z0-9]{0,31}){0,3}$/;
const BODY_KEYS = ['deps', 'roster', 'lamport', 'at', 'actor', 'kind'] as const;

function invalidAt(path: string): string {
  return `bad-body: ${path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, 120)}`;
}

function isDep(value: unknown): value is Dep {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 && keys.includes('writer') && keys.includes('seq') && keys.includes('hash')
    && matches(value.writer, HASH_PATTERN) && isSafeIntegerInRange(value.seq, 0, Number.MAX_SAFE_INTEGER) && matches(value.hash, HASH_PATTERN);
}

function isIsoAt(value: unknown): value is string {
  if (!matches(value, AT_PATTERN)) return false;
  const millis = Date.parse(value);
  return !Number.isNaN(millis) && new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19);
}

export type BodyCheck = { ok: true; body: EntryBody; known: boolean } | { ok: false; reason: string };

// Reads the parsed JSON once, into a fresh object. Never throws.
export function validateBody(raw: unknown): BodyCheck {
  try {
    if (!isRecord(raw)) return { ok: false, reason: invalidAt('body') };
    const keys = Object.keys(raw);
    const hasData = keys.includes('data');
    const hasBlob = keys.includes('blob');
    if (hasData === hasBlob) return { ok: false, reason: invalidAt('body.data') };
    const allowed: readonly string[] = [...BODY_KEYS, hasData ? 'data' : 'blob'];
    if (keys.length !== allowed.length || !allowed.every((key) => keys.includes(key))) return { ok: false, reason: invalidAt('body') };
    const { deps, roster, lamport, at, actor, kind } = raw;
    if (!Array.isArray(deps) || deps.length > MAX_DEPS) return { ok: false, reason: invalidAt('body.deps') };
    const cleanDeps: Dep[] = [];
    for (let index = 0; index < deps.length; index += 1) {
      const dep: unknown = deps[index];
      if (!isDep(dep)) return { ok: false, reason: invalidAt(`body.deps[${index}]`) };
      cleanDeps.push({ writer: dep.writer, seq: dep.seq, hash: dep.hash });
    }
    if (!matches(roster, HASH_PATTERN)) return { ok: false, reason: invalidAt('body.roster') };
    if (!isSafeIntegerInRange(lamport, 1, MAX_LAMPORT)) return { ok: false, reason: invalidAt('body.lamport') };
    if (!isIsoAt(at)) return { ok: false, reason: invalidAt('body.at') };
    if (!isActorShape(actor)) return { ok: false, reason: invalidAt('body.actor') };
    if (!matches(kind, KIND_PATTERN)) return { ok: false, reason: invalidAt('body.kind') };
    const base = { deps: cleanDeps, roster, lamport, at, actor: copyActor(actor), kind };
    if (hasData) return { ok: true, body: { ...base, data: raw.data }, known: KIND_FAMILIES.has(kind) };
    if (!matches(raw.blob, HASH_PATTERN)) return { ok: false, reason: invalidAt('body.blob') };
    return { ok: true, body: { ...base, blob: raw.blob }, known: KIND_FAMILIES.has(kind) };
  } catch {
    // Hostile input never throws out of the validator.
    return { ok: false, reason: invalidAt('body') };
  }
}

function copyActor(actor: EntryBody['actor']): EntryBody['actor'] {
  if (actor.kind === 'agent') return { kind: 'agent', member: actor.member, run: actor.run };
  if (actor.kind === 'hub') return { kind: 'hub', watch: actor.watch };
  return { kind: 'person' };
}

export type DataCheck = { ok: true } | { ok: false; reason: string };

// Validates the data of a known kind. Unknown kinds are not checked here (the caller keeps them).
export function validateData(kind: string, data: unknown): DataCheck {
  const family = kindFamily(kind);
  if (family === undefined) return { ok: false, reason: `bad-data: unknown kind` };
  const reason = family === 'doc' && kind !== 'doc.compact'
    ? validateDocData(kind, data, 'data')
    : `${SCHEMA_PENDING}: ${family} ${kind}`;
  return reason === undefined ? { ok: true } : { ok: false, reason };
}

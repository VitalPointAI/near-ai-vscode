// The closed list of entry kinds (DESIGN 4.3, D-07) and the body and data validation that goes with it. Hub-side: no Yjs, no fold.
//
// An unknown kind from a newer client is kept and relayed ("made by a newer version") and never changes state. A known kind whose data schema is
// not written yet is refused with SCHEMA_PENDING, so it fails closed.
import { MAX_LAMPORT, isRecord, isSafeIntegerInRange, matches } from '../team/validate';
import { HASH_PATTERN, MAX_DEPS } from './entry';
import type { Dep, EntryBody } from './entry';
import { validateDeviceData } from './kindSchemas/device';
import { validateDocData } from './kindSchemas/doc';
import { validateIntegrityData } from './kindSchemas/integrity';
import { validateObsData } from './kindSchemas/obs';
import { validatePersonnelData } from './kindSchemas/personnel';
import { validateProjectData } from './kindSchemas/project';
import { validateRegistersData } from './kindSchemas/registers';
import { validateRosterData } from './kindSchemas/roster';
import { validateRunsData } from './kindSchemas/runs';
import { validateSessionData } from './kindSchemas/session';
import { SCHEMA_PENDING, isActor, isDep, isIsoTime } from './kindSchemas/shared';
import { validateVersionsData } from './kindSchemas/versions';
import { validateWatchesData } from './kindSchemas/watches';

// Re-exported so existing imports keep working; the constant lives in kindSchemas/shared.ts.
export { SCHEMA_PENDING };

const KINDS_BY_FAMILY = {
  project: ['project.genesis', 'project.import'],
  roster: ['member.invite', 'member.admit', 'member.update', 'member.remove', 'device.add', 'device.rotate', 'device.revoke', 'device.quarantine', 'device.release', 'hub.admit', 'hub.grant', 'hub.revoke', 'cell.create', 'cell.rekey', 'lead.handover', 'roster.choose', 'deputy.name', 'invite.void', 'roster.require', 'hub.readmit',
    // Phase 33.1 (D-09 to D-15, D-43): positions, postings, delegated posting authority, the staged key change and the shared project's signed mode.
    'position.create', 'position.update', 'position.disestablish', 'authority.delegate', 'authority.revoke', 'posting.order', 'posting.enrol',
    'posting.report', 'posting.decide', 'posting.return', 'posting.end', 'posting.cancel', 'cell.rekey.staged', 'project.mode', 'cell.access.commit'],
  doc: ['doc.client', 'doc.update', 'doc.compact'],
  versions: ['product.create', 'product.owner', 'version.propose', 'version.verdict', 'version.submit', 'version.withdraw', 'version.decide', 'version.release', 'version.supersede'],
  registers: ['register.row', 'pir.decide', 'watch.decide'],
  watches: ['watch.define', 'watch.assign', 'watch.match', 'watch.state', 'watch.killSwitch'],
  runs: ['run.start', 'run.lane', 'run.claim', 'run.release', 'run.summary', 'run.end'],
  obs: ['obs.segment', 'obs.coalesced', 'obs.pruned'],
  integrity: ['equivocation.proof', 'digest.report'],
  // A person device's certificate for a session key (Phase 33 D-62): in the roster cell, folded beside the roster line and never on it.
  session: ['session.certify'],
  // A device's post-quantum key binding (33.2 D-03): in the roster cell, folded beside the roster line and never on it, like session.certify.
  device: ['device.kem'],
  // A posting's private record (Phase 33.1 D-19): only in the personnel key group, never in the base cell.
  personnel: ['posting.unable', 'posting.reference']
} as const;

export type KindFamily = keyof typeof KINDS_BY_FAMILY;
export type ReplicaKind = typeof KINDS_BY_FAMILY[KindFamily][number];

// The closed list: DESIGN 4.3 plus deputy.name (DESIGN 7.1), so a deputy lead can be honoured without a format change (D-27), plus the roster kind that
// voids an open invite (D-17, D-49), plus roster.require (the feature check, POST-01) and hub.readmit (trusting
// your organization's server again, Phase 33 D-42), plus session.certify (a person's session key, Phase 33 D-62), plus device.kem (a device's post-quantum keys, 33.2 D-03),
// plus Phase 33.1's 14 roster kinds and 2 personnel kinds: 71 kinds.
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
    if (!isIsoTime(at)) return { ok: false, reason: invalidAt('body.at') };
    if (!isActor(actor)) return { ok: false, reason: invalidAt('body.actor') };
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
  return actor.position === undefined ? { kind: 'person' } : { kind: 'person', position: actor.position };
}

export type DataCheck = { ok: true } | { ok: false; reason: string };

// One validator per family, each in its own file so each owning plan edits only its own (D-07). Each returns a reason or undefined.
const FAMILY_VALIDATORS: Readonly<Record<KindFamily, (kind: string, data: unknown, path: string) => string | undefined>> = {
  project: validateProjectData,
  roster: validateRosterData,
  doc: validateDocData,
  versions: validateVersionsData,
  registers: validateRegistersData,
  watches: validateWatchesData,
  runs: validateRunsData,
  obs: validateObsData,
  integrity: validateIntegrityData,
  session: validateSessionData,
  device: validateDeviceData,
  personnel: validatePersonnelData
};

// Validates the data of a known kind. Unknown kinds are not checked here (the caller keeps them).
export function validateData(kind: string, data: unknown): DataCheck {
  const family = kindFamily(kind);
  if (family === undefined) return { ok: false, reason: 'bad-data: unknown kind' };
  const reason = FAMILY_VALIDATORS[family](kind, data, 'data');
  return reason === undefined ? { ok: true } : { ok: false, reason };
}

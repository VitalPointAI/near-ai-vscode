import type { RoutingTable } from '../../domain/gate/routing';
import { newEpochKey, readGrant, sealLabel } from '../../domain/replica/cellKeys';
import { readGrantPages } from '../../domain/replica/grantPages';
import { writerIdOf } from '../../domain/replica/entry';
import { isRosterWriterAt } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { deviceAt, memberAt, x25519At } from '../../domain/replica/rosterMembers';
import { advanceGrantEvidence } from '../../domain/replica/rotationGrants';
import type { OpenedGrantEvidence } from '../../domain/replica/rotationGrants';
import { accessRevisionId } from '../../domain/replica/rotationProof';
import { appendManagedAccess } from './managedWithdrawal';
import type { AccessSnapshot, AuthoredRefusal } from './managedWithdrawal';
import type { RekeyReason } from '../../domain/replica/cellKeys';
import type { CellInfo, RekeyOutcome } from './membership';
import { isProjectRefused } from './replicaProject';
import type { ProjectRefused, ReplicaProject } from './replicaProject';
import { newEpochGrant } from './wrapPlan';

type RecoveryRefusal = AuthoredRefusal | ProjectRefused | { ok: false; reason: 'switch-first' | 'rekey-awaiting-keys' };

export function selectedManagedAccess(roster: RosterState, authority: string): (AccessSnapshot & { cells: OpenedGrantEvidence[] }) | undefined {
  const revision = roster.accessRevision;
  const position = roster.positions.length - 1;
  if (revision === undefined || roster.pending.length > 0 || !isRosterWriterAt(roster, authority, position)) return undefined;
  const cells: OpenedGrantEvidence[] = [];
  for (const cell of revision.cells) {
    const opening = roster.accessGrants.get(cell);
    if (opening?.entry !== revision.entry) return undefined;
    cells.push(opening);
  }
  return { priorEntry: revision.entry, priorRoot: revision.root, predecessor: roster.positions[position], cells };
}

export function pendingManagedCells(roster: RosterState, authority: string): string[] | undefined {
  return selectedManagedAccess(roster, authority)?.cells.filter(({ decision }) => decision === 'pending').map(({ evidence }) => evidence.cell);
}

export function managedRecipients(roster: RosterState, item: OpenedGrantEvidence): string[] {
  const excluded = new Set(item.evidence.excluded);
  return [...new Set(item.evidence.grants.flatMap((grant) => grant.recipients))].filter((writer) =>
    !excluded.has(writer) && deviceAt(roster.members, writer, roster.positions.length - 1) !== undefined).sort();
}

async function recoverCell(project: ReplicaProject, roster: RosterState, info: CellInfo, routing: RoutingTable | undefined, now: Date):
  Promise<RecoveryRefusal | undefined> {
  const signer = project.rosterSigner;
  const authority = writerIdOf(signer.publicKey);
  if (signer !== project.signer) return { ok: false, reason: 'action-required' };
  const snapshot = selectedManagedAccess(roster, authority);
  const prior = snapshot?.cells.find(({ evidence }) => evidence.cell === info.cell);
  if (snapshot === undefined || authority !== project.deviceWriter || prior?.decision !== 'pending' || !info.known || (!info.base && info.raw === undefined) ||
      !project.keys.holds(info.cell, prior.evidence.epoch)) return { ok: false, reason: 'no-grant-key' };
  const writers = managedRecipients(roster, prior);
  if (!writers.includes(authority)) return { ok: false, reason: 'no-grant-key' };
  const position = roster.positions.length - 1;
  if (writers.some((writer) => x25519At(roster.members, writer, position) === undefined)) return { ok: false, reason: 'rekey-awaiting-keys' };
  const epoch = prior.evidence.epoch + 1;
  const key = newEpochKey();
  const grant = newEpochGrant(roster, { info, routing, cell: info.cell, epoch, key, recipients: writers,
    labelSealed: info.base ? '' : sealLabel(key, info.cell, epoch, info.raw) });
  if (grant === 'switch-first') return { ok: false, reason: grant };
  if (grant === undefined || grant.wraps.length !== writers.length) return { ok: false, reason: 'rekey-awaiting-keys' };
  const pages = await project.signGrantPages(grant);
  const [founding, ...rest] = pages;
  const parsed = rest.length === 0 ? readGrant(founding) : readGrantPages(founding, rest);
  if (!parsed.ok || parsed.signer.writer !== authority || !project.keys.readingCandidates(info.cell, pages)
    .some((candidate) => !candidate.own && candidate.epoch === epoch && candidate.key.equals(key))) return { ok: false, reason: 'rekey-awaiting-keys' };
  const evidence = advanceGrantEvidence(prior.evidence, { epoch, grants: [{
    hash: parsed.hash, pages: parsed.grant.pages ?? [], recipients: parsed.grant.wraps.map(({ writer }) => writer).sort()
  }], excluded: [] });
  if (evidence === undefined) return { ok: false, reason: 'change-not-applied' };
  const excluded = new Set(prior.evidence.excluded);
  const retired = prior.evidence.grants.flatMap((grant) => grant.recipients)
    .filter((writer) => excluded.has(writer) && deviceAt(roster.members, writer, position) === undefined);
  const reason = retired.length === 0 ? 'clearance-lowered' : leftReason(roster, retired, position);
  const operation = { cell: info.cell, epoch, reason, grant: parsed.hash };
  const kind = 'cell.rekey';
  const revision = accessRevisionId(roster.anchor.project, roster.accessRevision?.id ?? null, snapshot.predecessor, kind, operation);
  const cells = snapshot.cells.map((item) => item === prior ? {
    evidence, decision: 'continues' as const, previousEpoch: prior.evidence.epoch, recipients: writers
  } : { evidence: item.evidence, decision: item.decision, recipients: managedRecipients(roster, item) });
  const result = await appendManagedAccess(project, roster, { ...snapshot, kind, operation, revision, cells, founding: { cell: info.cell, grants: pages } },
    now, (fresh) => selectedManagedAccess(fresh, authority));
  return isProjectRefused(result) || !result.ok ? result : undefined;
}

/** One checked commit per pending cell. A waiting cell does not block work for its siblings. */
export async function finishManagedRekeys(project: ReplicaProject, roster: RosterState, describe: (roster: RosterState, cell: string) => CellInfo | undefined,
  routing: RoutingTable | undefined, now: () => Date): Promise<RekeyOutcome | RecoveryRefusal> {
  const pending = pendingManagedCells(roster, project.deviceWriter);
  if (pending === undefined) return { ok: false, reason: 'no-grant-key' };
  const rekeyed: string[] = [];
  let refused: RecoveryRefusal | undefined;
  for (const cell of pending) {
    const fresh = (await project.state()).roster;
    const current = pendingManagedCells(fresh, project.deviceWriter);
    if (current === undefined) return { ok: false, reason: 'change-not-applied' };
    if (!current.includes(cell)) continue;
    const info = describe(fresh, cell);
    const problem = info === undefined ? { ok: false as const, reason: 'no-grant-key' as const } : await recoverCell(project, fresh, info, routing, now());
    if (problem === undefined) rekeyed.push(cell);
    else refused ??= problem;
  }
  return refused ?? { rekeyed, skipped: [] };
}

/** The kind of rekey a cell needs because of the devices that left it: a removed member, a revoked device, or a revoked hub device. */
export function leftReason(roster: RosterState, gone: readonly string[], position: number): RekeyReason {
  const reasons = gone.map((writer): RekeyReason => {
    const versions = roster.members.devices.get(writer);
    const last = versions?.[versions.length - 1];
    if (last?.kind === 'hub') return 'hub-revoked';
    return last !== undefined && memberAt(roster.members, last.member, position) !== undefined ? 'device-revoked' : 'member-removed';
  });
  return (['member-removed', 'device-revoked', 'hub-revoked'] as const).find((reason) => reasons.includes(reason)) ?? 'member-removed';
}

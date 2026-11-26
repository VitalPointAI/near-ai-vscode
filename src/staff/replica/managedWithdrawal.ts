import { randomBytes } from 'node:crypto';
import { readGrant } from '../../domain/replica/cellKeys';
import { writerIdOf } from '../../domain/replica/entry';
import type { BuiltEntry } from '../../domain/replica/entry';
import { accessPermitBytes, buildAccessCommitment, readAccessWriteProof } from '../../domain/replica/rotationProof';
import type { AccessPermit, SignedAccessPermit } from '../../domain/replica/rotationProof';
import { grantEvidenceHash, openGrantEvidence, readAuthoredAccessStage } from '../../domain/replica/rotationGrants';
import type { OpenedGrantEvidence } from '../../domain/replica/rotationGrants';
import { foldRoster, managedWriteAllowed, prepareManagedWithdrawal, rosterView } from '../../domain/replica/roster';
import type { RosterFoldInput, RosterState } from '../../domain/replica/roster';
import { certifiedWriter } from '../../domain/replica/sessionKeys';
import { deviceAt } from '../../domain/replica/rosterMembers';
import type { AppendOwnResult, ReplicaProject } from './replicaProject';

export type AuthoredRefusal = { ok: false; reason: 'no-grant-key' | 'action-required' | 'signer-refused' | 'change-not-applied' };
type Target = { member: string; writer?: string };
export interface AccessSnapshot { predecessor: string; priorEntry: string; priorRoot: string }
interface ManagedAccess extends AccessSnapshot {
  kind: 'member.remove' | 'device.revoke' | 'cell.rekey' | 'member.update';
  operation: object;
  revision: string;
  at?: string;
  cells: ReadonlyArray<Pick<OpenedGrantEvidence, 'evidence' | 'decision'> & { recipients: readonly string[]; previousEpoch?: number }>;
  founding?: { cell: string; grants: readonly unknown[] };
}

function permitDrafts(roster: RosterState, planned: ManagedAccess, authority: string, now: Date): AccessPermit[] {
  const position = roster.positions.length - 1;
  const view = rosterView(roster);
  return planned.cells.flatMap(({ evidence, decision, recipients }) => {
    if (decision !== 'continues') return [];
    const fields = { project: evidence.project, revision: planned.revision, predecessor: planned.predecessor,
      cell: evidence.cell, epoch: evidence.epoch, authority };
    const devices = recipients.filter((writer) => deviceAt(roster.members, writer, position)?.kind === 'person');
    const direct = devices.map((writer) => ({ ...fields, writer, device: writer, certificate: null }));
    const sessions = [...roster.sessions.values()].filter((certificate) => devices.includes(certificate.device) &&
      Date.parse(certificate.notAfter) > now.getTime() && certifiedWriter(view, certificate.writer, planned.predecessor) !== undefined)
      .map((certificate) => ({ ...fields, writer: certificate.writer, device: certificate.device, certificate: certificate.hash }));
    return [...direct, ...sessions];
  });
}

/** Author one scoped withdrawal. Stage the private manifests and continuity before its signed entry becomes visible. */
export async function appendManagedWithdrawal(project: ReplicaProject, roster: RosterState, input: Target, now: Date, action?: string):
  Promise<AppendOwnResult | AuthoredRefusal> {
  const authority = writerIdOf(project.rosterSigner.publicKey);
  const prepare = (fresh: RosterState): ManagedAccess | undefined => prepareManagedWithdrawal(fresh, authority, input);
  const plan = prepare(roster);
  if (plan === undefined) return { ok: false, reason: 'no-grant-key' };
  return appendManagedAccess(project, roster, plan, now, prepare, action);
}

export async function appendManagedAccess(project: ReplicaProject, roster: RosterState, plan: ManagedAccess, now: Date,
  prepare: (fresh: RosterState) => AccessSnapshot | undefined, action?: string): Promise<AppendOwnResult | AuthoredRefusal> {
  const signer = project.rosterSigner;
  const authority = writerIdOf(signer.publicKey);
  if (signer !== project.signer && action === undefined) return { ok: false, reason: 'action-required' };
  if (authority !== project.deviceWriter) return { ok: false, reason: 'no-grant-key' };
  const permits: SignedAccessPermit[] = [];
  for (const permit of permitDrafts(roster, plan, authority, now)) {
    const signature = await signer.sign(accessPermitBytes(permit), action === undefined ? undefined : { action });
    if (typeof signature !== 'string') return { ok: false, reason: 'signer-refused' };
    permits.push({ permit, signature });
  }
  const decisions = plan.cells.map(({ evidence, decision, previousEpoch }) => ({
    cell: evidence.cell, epoch: evidence.epoch, previousEpoch: previousEpoch ?? evidence.epoch, decision,
    salt: randomBytes(32).toString('hex'), evidence: grantEvidenceHash(evidence) ?? ''
  }));
  const commitment = buildAccessCommitment(plan.revision, decisions, permits);
  if (commitment === undefined) return { ok: false, reason: 'change-not-applied' };
  return project.appendChecked<AuthoredRefusal>(({ roster: fresh }) => {
    const prepared = prepare(fresh);
    if (prepared?.predecessor !== plan.predecessor || prepared.priorEntry !== plan.priorEntry || prepared.priorRoot !== plan.priorRoot) {
      return { ok: false, reason: 'change-not-applied' };
    }
    return {
      kind: plan.kind, data: { ...plan.operation, accessRevision: plan.revision, accessRoot: commitment.root },
      options: { signer, action, at: plan.at, roster: plan.predecessor, stageAccess: (entry) => ({
        entry,
        openings: plan.cells.map(({ evidence }) => ({ ...commitment.cellProof(evidence.cell), entry, evidence })),
        accessProofs: permits.map(({ permit }) => commitment.proof(permit.cell, permit.writer)),
        ...(plan.founding === undefined ? {} : { founding: plan.founding })
      }) },
      check: () => undefined
    };
  });
}


/** Validate every proposed output with the same fold that will select the write from disk. */
export function verifyManagedStage(built: BuiltEntry, raw: unknown, input: RosterFoldInput): boolean {
  const stage = readAuthoredAccessStage(raw);
  if (stage?.entry !== built.hash) return false;
  const preview = foldRoster({ ...input, entries: [...input.entries, built.entry],
    blobs: (hash) => built.blobs.find((blob) => blob.hash === hash) ?? input.blobs(hash),
    grantEvidence: [...(input.grantEvidence ?? []), raw] });
  const selection = preview.accessRevision;
  if (selection?.entry !== built.hash || stage.openings.length !== selection.cells.length) return false;
  const verifiedCells = new Set(stage.openings.flatMap((opening) => {
    const result = openGrantEvidence(input.anchor.project, preview.accessHistory, opening);
    return result === undefined ? [] : [result.evidence.cell];
  }));
  if (verifiedCells.size !== selection.cells.length || preview.accessGrants.size !== verifiedCells.size) return false;
  const position = preview.positions.length - 1;
  const founded = [...preview.cells.cells.values()].filter(({ epochs }) => epochs.at(-1)?.from === position);
  if (stage.founding === undefined ? founded.length > 0 : founded.length !== 1 || !foundingPlaced(stage.founding.grants, founded[0])) return false;
  return stage.accessProofs.every((value) => {
    const permit = readAccessWriteProof(value)?.signed.permit;
    return permit !== undefined && managedWriteAllowed(preview, permit.cell, permit.epoch, permit.writer, position, input.now, value) === true;
  });
}

function foundingPlaced(grants: readonly unknown[], cell: import('../../domain/replica/rosterCells').CellRecord): boolean {
  const founding = readGrant(grants[0]);
  return founding.ok && cell.cell === founding.grant.cell && cell.epochs.at(-1)?.grant === founding.hash &&
    cell.grants.some((grant) => grant.founding && grant.hash === founding.hash);
}

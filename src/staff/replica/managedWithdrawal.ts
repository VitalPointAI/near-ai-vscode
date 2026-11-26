import { randomBytes } from 'node:crypto';
import { readGrant } from '../../domain/replica/cellKeys';
import { writerIdOf } from '../../domain/replica/entry';
import { canonicalBytes } from '../../domain/team/canonical';
import type { AsyncPayloadSigner, PayloadSigner } from '../../domain/team/signedPayload';
import { isRecord } from '../../domain/team/validate';
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
export interface ManagedAccess extends AccessSnapshot {
  kind: 'member.remove' | 'device.revoke' | 'cell.rekey' | 'member.update' | 'cell.access.commit';
  operation: object;
  revision: string;
  at?: string;
  cells: ReadonlyArray<Pick<OpenedGrantEvidence, 'evidence' | 'decision'> & { recipients: readonly string[]; previousEpoch?: number }>;
  founding?: { cell: string; grants: readonly unknown[] };
  supplemental?: { cell: string; grants: readonly unknown[] };
}

/** Exact operation presented for step-up, bound to its selected roster and private access root. */
export function managedAccessActionBytes(roster: RosterState, authority: string, kind: string, data: unknown): Buffer | undefined {
  const revision = roster.accessRevision;
  if (revision === undefined || !isRecord(data)) return undefined;
  const { accessRevision: _revision, accessRoot: _root, rosterPrev: _roster, ...operation } = data;
  return canonicalBytes({ purpose: 'near-ai/cell-access/1/hosted-action', project: roster.anchor.project,
    roster: roster.positions.at(-1), entry: revision.entry, root: revision.root, authority, kind, operation });
}

/** The managed withdrawal a person can confirm from this roster. */
export function managedWithdrawalActionBytes(roster: RosterState, authority: string, input: Target): Buffer | undefined {
  const plan = prepareManagedWithdrawal(roster, authority, input);
  return plan === undefined ? undefined : managedAccessActionBytes(roster, authority, plan.kind, plan.operation);
}

export function managedActionCurrent(signer: PayloadSigner | AsyncPayloadSigner, action: string | undefined, payload: Uint8Array | undefined): boolean {
  return action !== undefined && payload !== undefined && 'canSignAction' in signer && signer.canSignAction?.(action, payload) === true;
}

/** Person devices and live certified sessions used by both confirmation and permit issuance. */
export function managedPermitSubjects(roster: RosterState, recipients: readonly string[], predecessor: string, now: Date) {
  const position = roster.positions.length - 1;
  const view = rosterView(roster);
  const devices = recipients.filter((writer) => deviceAt(roster.members, writer, position)?.kind === 'person').sort();
  const sessions = [...roster.sessions.values()].filter((certificate) => devices.includes(certificate.device) &&
    Date.parse(certificate.notAfter) > now.getTime() && certifiedWriter(view, certificate.writer, predecessor) !== undefined)
    .sort((a, b) => a.writer < b.writer ? -1 : a.writer === b.writer ? 0 : 1);
  return { devices, sessions };
}

function permitDrafts(roster: RosterState, planned: ManagedAccess, authority: string, now: Date): AccessPermit[] {
  return planned.cells.flatMap(({ evidence, decision, recipients }) => {
    if (decision !== 'continues') return [];
    const fields = { project: evidence.project, revision: planned.revision, predecessor: planned.predecessor,
      cell: evidence.cell, epoch: evidence.epoch, authority };
    const { devices, sessions } = managedPermitSubjects(roster, recipients, planned.predecessor, now);
    return [...devices.map((writer) => ({ ...fields, writer, device: writer, certificate: null })),
      ...sessions.map((certificate) => ({ ...fields, writer: certificate.writer, device: certificate.device, certificate: certificate.hash }))];
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
  if (signer !== project.signer && (plan.kind === 'cell.rekey' ||
      !managedActionCurrent(signer, action, managedAccessActionBytes(roster, authority, plan.kind, plan.operation)))) {
    return { ok: false, reason: 'action-required' };
  }
  if (authority !== project.deviceWriter) return { ok: false, reason: 'no-grant-key' };
  const permits: SignedAccessPermit[] = [];
  for (const permit of permitDrafts(roster, plan, authority, now)) {
    const signature = await signer.sign(accessPermitBytes(permit), action === undefined ? undefined : { action });
    if (typeof signature !== 'string') return { ok: false, reason: 'signer-refused' };
    permits.push({ permit, signature });
  }
  const staged = stageManagedAccess(plan, permits);
  if (staged === undefined) return { ok: false, reason: 'change-not-applied' };
  return project.appendChecked<AuthoredRefusal>(({ roster: fresh }) => {
    const prepared = prepare(fresh);
    if (prepared?.predecessor !== plan.predecessor || prepared.priorEntry !== plan.priorEntry || prepared.priorRoot !== plan.priorRoot) {
      return { ok: false, reason: 'change-not-applied' };
    }
    return { ...staged, options: { ...staged.options, signer, action }, check: () => undefined };
  });
}

/** Derive the exact roster data and private evidence from the checked cells and verified permits. */
export function stageManagedAccess(plan: ManagedAccess, permits: readonly SignedAccessPermit[]) {
  const decisions = plan.cells.map(({ evidence, decision, previousEpoch }) => ({
    cell: evidence.cell, epoch: evidence.epoch, previousEpoch: previousEpoch ?? evidence.epoch, decision,
    salt: randomBytes(32).toString('hex'), evidence: grantEvidenceHash(evidence) ?? ''
  }));
  const commitment = buildAccessCommitment(plan.revision, decisions, permits);
  if (commitment === undefined) return undefined;
  return {
    kind: plan.kind, data: { ...plan.operation, accessRevision: plan.revision, accessRoot: commitment.root },
    options: { at: plan.at, roster: plan.predecessor, stageAccess: (entry: string) => ({
      entry,
      openings: plan.cells.map(({ evidence }) => ({ ...commitment.cellProof(evidence.cell), entry, evidence })),
      accessProofs: permits.map(({ permit }) => commitment.proof(permit.cell, permit.writer)),
      ...(plan.founding === undefined ? {} : { founding: plan.founding }),
      ...(plan.supplemental === undefined ? {} : { supplemental: plan.supplemental })
    }) }
  };
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
  if (stage.supplemental !== undefined) {
    const grant = readGrant(stage.supplemental.grants[0]);
    if (!grant.ok || grant.grant.roster !== selection.predecessor ||
        !preview.cells.cells.get(grant.grant.cell)?.grants.some((record) => !record.founding && record.hash === grant.hash)) return false;
  }
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

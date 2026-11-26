import { createHash } from 'node:crypto';
import type { DominanceContext } from '../../domain/gate/dominance';
import { parseClearance } from '../../domain/gate/labels';
import { writerIdOf } from '../../domain/replica/entry';
import { advanceGrantEvidence } from '../../domain/replica/rotationGrants';
import { accessRevisionId } from '../../domain/replica/rotationProof';
import { deputyAt, leadAt } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { devicesOfMemberAt, memberAt } from '../../domain/replica/rosterMembers';
import { canonicalBytes } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { managedRecipients, selectedManagedAccess } from './managedRecovery';
import { appendManagedAccess } from './managedWithdrawal';
import type { AuthoredRefusal } from './managedWithdrawal';
import type { CellInfo } from './membership';
import type { AppendOwnResult, ReplicaProject } from './replicaProject';

type ClearanceRefusal = AuthoredRefusal | { ok: false; reason: 'clearance-grants-pending' };

function policyId({ scales, mappings }: DominanceContext): string {
  const ordered = [...new Set(mappings.map((mapping) => canonicalBytes(mapping).toString('utf8')))].sort().map((mapping) => JSON.parse(mapping) as unknown);
  return createHash('sha256').update('near-ai/cell-access/1/clearance-policy\n').update(canonicalBytes({ scales, mappings: ordered })).digest('hex');
}

function knownClearance(value: unknown, context: DominanceContext): boolean {
  if (!isRecord(value)) return false;
  const { handling: _handling, ...clearance } = value;
  return parseClearance(clearance, context.scales).ok;
}

interface ClearancePolicy {
  context: DominanceContext;
  cells: readonly CellInfo[];
  cleared(clearance: unknown, info: CellInfo, held: boolean, leadOrDeputy: boolean): boolean;
}

export async function appendManagedClearance(project: ReplicaProject, roster: RosterState, operation: Record<string, unknown>, policy: ClearancePolicy):
  Promise<AppendOwnResult | ClearanceRefusal> {
  const authority = writerIdOf(project.rosterSigner.publicKey);
  const snapshot = selectedManagedAccess(roster, authority);
  const position = roster.positions.length - 1;
  const member = typeof operation.member === 'string' ? memberAt(roster.members, operation.member, position) : undefined;
  if (snapshot === undefined || member === undefined || !knownClearance(operation.clearance, policy.context) ||
      (member.clearance !== undefined && !knownClearance(member.clearance, policy.context))) return { ok: false, reason: 'no-grant-key' };
  const id = policyId(policy.context);
  const privileged = member.member === leadAt(roster, position) || member.member === deputyAt(roster, position);
  const devices = new Set(devicesOfMemberAt(roster.members, member.member, position).filter(({ kind }) => kind === 'person').map(({ writer }) => writer));
  const cells = [];
  for (const selected of snapshot.cells) {
    const info = policy.cells.find(({ cell }) => cell === selected.evidence.cell);
    if (info?.known !== true) return { ok: false, reason: 'no-grant-key' };
    const recipients = managedRecipients(roster, selected);
    const held = recipients.some((writer) => devices.has(writer));
    const after = policy.cleared(operation.clearance, info, held, privileged);
    if (after && !policy.cleared(member.clearance, info, held, privileged)) return { ok: false, reason: 'clearance-grants-pending' };
    const excluded = after ? [] : recipients.filter((writer) => devices.has(writer));
    const evidence = advanceGrantEvidence(selected.evidence, { epoch: selected.evidence.epoch, policy: id, grants: [], excluded });
    if (evidence === undefined) return { ok: false, reason: 'change-not-applied' };
    const remaining = recipients.filter((writer) => !excluded.includes(writer));
    const decision = selected.decision === 'closed' || remaining.length === 0 ? 'closed' as const :
      selected.decision === 'pending' || excluded.length > 0 ? 'pending' as const : 'continues' as const;
    cells.push({ evidence, decision, recipients: remaining });
  }
  const kind = 'member.update';
  const revision = accessRevisionId(roster.anchor.project, roster.accessRevision?.id ?? null, snapshot.predecessor, kind, operation);
  return appendManagedAccess(project, roster, { ...snapshot, kind, operation, revision, cells, at: new Date(policy.context.now).toISOString() }, new Date(policy.context.now),
    (fresh) => selectedManagedAccess(fresh, authority));
}

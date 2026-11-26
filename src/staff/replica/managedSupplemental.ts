import type { RoutingTable } from '../../domain/gate/routing';
import { readGrant, sealLabel } from '../../domain/replica/cellKeys';
import { writerIdOf } from '../../domain/replica/entry';
import { readGrantPages, wrapsFor } from '../../domain/replica/grantPages';
import type { RosterState } from '../../domain/replica/roster';
import { deviceAt } from '../../domain/replica/rosterMembers';
import { advanceGrantEvidence } from '../../domain/replica/rotationGrants';
import { accessRevisionId } from '../../domain/replica/rotationProof';
import { managedRecipients, selectedManagedAccess } from './managedRecovery';
import { appendManagedAccess } from './managedWithdrawal';
import type { CellInfo } from './membership';
import { isProjectRefused } from './replicaProject';
import type { ReplicaProject } from './replicaProject';
import { formatFor, formatForDevice, wrapDeviceAt } from './wrapPlan';

/** Give keys for the current epoch under a selected access revision. Older epochs need separate evidence. */
export async function giveManagedSupplemental(project: ReplicaProject, roster: RosterState, info: CellInfo,
  writers: readonly string[], routing: RoutingTable | undefined, now: Date): Promise<{ granted: string[]; waiting: string[] }> {
  const waiting = { granted: [], waiting: [...writers] };
  const signer = project.rosterSigner;
  const authority = writerIdOf(signer.publicKey);
  if (signer !== project.signer || authority !== project.deviceWriter || writers.length === 0) return waiting;
  const snapshot = selectedManagedAccess(roster, authority);
  const selected = snapshot?.cells.find(({ evidence }) => evidence.cell === info.cell);
  if (snapshot === undefined || selected?.decision !== 'continues') return waiting;
  const { cell, epoch } = selected.evidence;
  const founded = roster.cells.cells.get(cell)?.epochs.at(-1);
  const key = project.keys.epochKey(cell, epoch);
  if (founded?.epoch !== epoch || key === undefined) return waiting;
  const position = roster.positions.length - 1;
  const holders = managedRecipients(roster, selected);
  const excluded = new Set(selected.evidence.excluded);
  const candidates = writers.filter((writer) => !holders.includes(writer) && !excluded.has(writer) && deviceAt(roster.members, writer, position)?.kind === 'person');
  const format = formatFor(roster, info, founded.from, routing);
  if (format === 'switch-first') return waiting;
  const wraps = candidates.flatMap((writer) => {
    const device = wrapDeviceAt(roster, writer, position);
    return wrapsFor({ format: formatForDevice(format, device), cell, epoch, epochKey: key, devices: [device] }).wraps;
  });
  if (wraps.length === 0) return waiting;
  const pages = await project.signGrantPages({ cell, epoch, roster: snapshot.predecessor, wraps,
    labelSealed: info.raw === undefined ? '' : sealLabel(key, cell, epoch, info.raw) });
  const [first, ...rest] = pages;
  const verified = rest.length === 0 ? readGrant(first) : readGrantPages(first, rest);
  if (!verified.ok || verified.signer.writer !== authority) return waiting;
  const recipients = verified.grant.wraps.map(({ writer }) => writer).sort();
  const verifiedRecipients = wraps.map(({ writer }) => writer).sort();
  if (recipients.length !== verifiedRecipients.length || recipients.some((writer, index) => writer !== verifiedRecipients[index])) return waiting;
  const evidence = advanceGrantEvidence(selected.evidence, { epoch, excluded: [], grants: [
    { hash: verified.hash, pages: verified.grant.pages ?? [], recipients }
  ] });
  if (evidence === undefined) return waiting;
  const cells = snapshot.cells.map((item) => item === selected ?
    { evidence, decision: item.decision, recipients: [...holders, ...recipients] } :
    { evidence: item.evidence, decision: item.decision, recipients: managedRecipients(roster, item) });
  const kind = 'cell.access.commit';
  const operation = {};
  const revision = accessRevisionId(roster.anchor.project, roster.accessRevision?.id ?? null, snapshot.predecessor, kind, operation);
  const result = await appendManagedAccess(project, roster, { ...snapshot, kind, operation, revision, cells, supplemental: { cell, grants: pages } },
    now, (fresh) => selectedManagedAccess(fresh, authority));
  if (isProjectRefused(result) || !result.ok) return waiting;
  return { granted: recipients, waiting: writers.filter((writer) => !recipients.includes(writer)) };
}

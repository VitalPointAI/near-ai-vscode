import type { RoutingTable } from '../../domain/gate/routing';
import { newEpochKey, readGrant, sealLabel } from '../../domain/replica/cellKeys';
import { readGrantPages } from '../../domain/replica/grantPages';
import { sha256Hex, writerIdOf } from '../../domain/replica/entry';
import { isRosterWriterAt } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { deviceAt, memberAt, x25519At } from '../../domain/replica/rosterMembers';
import { advanceGrantEvidence, grantEvidenceHash } from '../../domain/replica/rotationGrants';
import type { OpenedGrantEvidence } from '../../domain/replica/rotationGrants';
import { accessPermitBytes, accessRevisionId } from '../../domain/replica/rotationProof';
import { appendManagedAccess, managedActionCurrent, managedPermitSubjects, stageManagedAccess } from './managedWithdrawal';
import type { AccessSnapshot, AuthoredRefusal, ManagedAccess } from './managedWithdrawal';
import type { RekeyReason } from '../../domain/replica/cellKeys';
import type { CellInfo, RekeyOutcome } from './membership';
import type { ProjectRefused, ReplicaProject } from './replicaProject';
import { formatFor, formatForDevice, newEpochGrant, wrapDeviceAt } from './wrapPlan';
import type { AsyncPayloadSigner, SignedPayload } from '../../domain/team/signedPayload';
import type { CellGrant } from '../../domain/replica/cellKeys';
import { canonicalBytes } from '../../domain/team/canonical';
import { createFinishGrantScope, createFinishIntent } from './managedFinishSigning';

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

function recoveryInputs(project: ReplicaProject, roster: RosterState, info: CellInfo) {
  const authority = writerIdOf(project.rosterSigner.publicKey);
  const snapshot = selectedManagedAccess(roster, authority);
  const prior = snapshot?.cells.find(({ evidence }) => evidence.cell === info.cell);
  if (snapshot === undefined || authority !== project.deviceWriter || prior?.decision !== 'pending' || !info.known || info.base !== (info.cell === project.projectId) || (!info.base && info.raw === undefined) ||
      !project.keys.holds(info.cell, prior.evidence.epoch)) return { ok: false as const, reason: 'no-grant-key' as const };
  const writers = managedRecipients(roster, prior);
  if (!writers.includes(authority)) return { ok: false as const, reason: 'no-grant-key' as const };
  const position = roster.positions.length - 1;
  if (writers.some((writer) => x25519At(roster.members, writer, position) === undefined)) return { ok: false as const, reason: 'rekey-awaiting-keys' as const };
  const epoch = prior.evidence.epoch + 1;
  const excluded = new Set(prior.evidence.excluded);
  const retired = prior.evidence.grants.flatMap((grant) => grant.recipients)
    .filter((writer) => excluded.has(writer) && deviceAt(roster.members, writer, position) === undefined);
  const reason = retired.length === 0 ? 'clearance-lowered' : leftReason(roster, retired, position);
  return { ok: true, snapshot, prior, writers, position, epoch, reason } as const;
}

function recoverGrant(roster: RosterState, info: CellInfo, routing: RoutingTable | undefined, epoch: number, writers: readonly string[]) {
  const key = newEpochKey();
  const grant = newEpochGrant(roster, { info, routing, cell: info.cell, epoch, key, recipients: writers,
    labelSealed: info.base ? '' : sealLabel(key, info.cell, epoch, info.raw) });
  if (grant === 'switch-first') return { ok: false as const, reason: grant };
  if (grant === undefined || grant.wraps.length !== writers.length) return { ok: false as const, reason: 'rekey-awaiting-keys' as const };
  return { ok: true as const, grant, key };
}

function finishContext(project: ReplicaProject, roster: RosterState, info: CellInfo, routing: RoutingTable | undefined, now: Date) {
  const plan = recoveryInputs(project, roster, info);
  if (!plan.ok) return undefined;
  const { snapshot, prior, writers, position, reason } = plan;
  const choice = formatFor(roster, info, undefined, routing);
  const hash = grantEvidenceHash(prior.evidence);
  if (choice === 'switch-first' || hash === undefined || !Number.isFinite(now.getTime())) return undefined;
  const continuity = snapshot.cells.flatMap((item) => {
    if (item !== prior && item.decision !== 'continues') return [];
    const eligible = item === prior ? writers : managedRecipients(roster, item);
    return [{ cell: item.evidence.cell, epoch: item === prior ? plan.epoch : item.evidence.epoch, ...managedPermitSubjects(roster, eligible, snapshot.predecessor, now) }];
  });
  const recipients = writers.map((writer) => {
    const device = wrapDeviceAt(roster, writer, position);
    return { ...device, format: formatForDevice(choice, device) };
  });
  if (recipients.some(({ format, kem }) => format === 2 && kem === undefined)) return undefined;
  return { plan, context: { project: roster.anchor.project, writer: project.deviceWriter, predecessor: snapshot.predecessor,
    accessEntry: snapshot.priorEntry, accessRoot: snapshot.priorRoot, priorRevision: roster.accessRevision?.id ?? null, oldEpoch: prior.evidence.epoch, reason, evidence: hash, policy: prior.evidence.policy,
    ...(routing === undefined ? {} : { routing: sha256Hex(canonicalBytes(routing)) }),
    ...(info.base ? {} : { label: sha256Hex(canonicalBytes(info.raw)) }), recipients, continuity } };
}

const hostedDraftProjects = new WeakMap<object, ReplicaProject>();

/** Prepare one private hosted review without signing or changing the store. */
export function prepareHostedFinish(project: ReplicaProject, roster: RosterState, info: CellInfo, routing: RoutingTable | undefined, now: Date) {
  if (project.rosterSigner === project.signer) return undefined;
  const selected = finishContext(project, roster, info, routing, now);
  if (selected === undefined) return undefined;
  const signer = project.rosterSigner;
  const { plan: { epoch, writers }, context } = selected;
  const next = recoverGrant(roster, info, routing, epoch, writers);
  if (!next.ok) return undefined;
  const intent = createFinishIntent(context, next.grant);
  if (intent === undefined) return undefined;
  const binding = intent.actionBytes();
  const cell = info.cell;
  const currentActionBytes = (fresh: RosterState, part: CellInfo, rules: RoutingTable | undefined, time: Date): Buffer | undefined => {
    if (project.rosterSigner !== signer || part.cell !== cell) return undefined;
    const current = finishContext(project, fresh, part, rules, time);
    const bytes = current === undefined ? undefined : createFinishIntent(current.context, intent.unsignedGrant())?.actionBytes();
    return bytes?.equals(binding) === true ? bytes : undefined;
  };
  const draft = Object.freeze({
    intent,
    epochKey: () => Buffer.from(next.key),
    currentActionBytes,
    matches: (fresh: RosterState, part: CellInfo, rules: RoutingTable | undefined, time: Date) => currentActionBytes(fresh, part, rules, time) !== undefined
  });
  hostedDraftProjects.set(draft, project);
  return draft;
}

async function recoverCell(project: ReplicaProject, roster: RosterState, info: CellInfo, routing: RoutingTable | undefined, now: Date):
  Promise<RecoveryRefusal | undefined> {
  const signer = project.rosterSigner;
  const authority = writerIdOf(signer.publicKey);
  if (signer !== project.signer) return { ok: false, reason: 'action-required' };
  const selected = recoveryInputs(project, roster, info);
  if (!selected.ok) return selected;
  const next = recoverGrant(roster, info, routing, selected.epoch, selected.writers);
  if (!next.ok) return next;
  const pages = await project.signGrantPages(next.grant);
  const plan = recoveryWritePlan(project, roster, selected, pages, next.key);
  if ('ok' in plan) return plan;
  const result = await appendManagedAccess(project, roster, plan, now, (fresh) => selectedManagedAccess(fresh, authority));
  return 'refused' in result || !result.ok ? result : undefined;
}

type RecoveryInputs = Extract<ReturnType<typeof recoveryInputs>, { ok: true }>;
function recoveryWritePlan(project: ReplicaProject, roster: RosterState, selected: RecoveryInputs, pages: readonly SignedPayload<CellGrant>[], key: Buffer):
  ManagedAccess | Extract<RecoveryRefusal, { ok: false }> {
  const { snapshot, prior, writers, epoch, reason } = selected;
  const authority = project.deviceWriter;
  const cell = prior.evidence.cell;
  const [founding, ...rest] = pages;
  const parsed = rest.length === 0 ? readGrant(founding) : readGrantPages(founding, rest);
  if (!parsed.ok || parsed.signer.writer !== authority || !project.keys.readingCandidates(cell, pages)
    .some((candidate) => !candidate.own && candidate.epoch === epoch && candidate.key.equals(key))) return { ok: false, reason: 'rekey-awaiting-keys' };
  const evidence = advanceGrantEvidence(prior.evidence, { epoch, grants: [{
    hash: parsed.hash, pages: parsed.grant.pages ?? [], recipients: parsed.grant.wraps.map(({ writer }) => writer).sort()
  }], excluded: [] });
  if (evidence === undefined) return { ok: false, reason: 'change-not-applied' };
  const operation = { cell, epoch, reason, grant: parsed.hash };
  const kind = 'cell.rekey';
  const revision = accessRevisionId(roster.anchor.project, roster.accessRevision?.id ?? null, snapshot.predecessor, kind, operation);
  const cells = snapshot.cells.map((item) => item === prior ? {
    evidence, decision: 'continues' as const, previousEpoch: prior.evidence.epoch, recipients: writers
  } : { evidence: item.evidence, decision: item.decision, recipients: managedRecipients(roster, item) });
  return { ...snapshot, kind, operation, revision, cells, founding: { cell, grants: pages } };
}

export type HostedFinishDraft = NonNullable<ReturnType<typeof prepareHostedFinish>>;
export type DescribeFinishCell = (roster: RosterState, cell: string) => CellInfo | undefined;

/** A draft belongs to one engine and its exact pending approval, and is consumed when signing starts. */
export async function authorizeHostedFinish(project: ReplicaProject, draft: HostedFinishDraft, action: string,
  describe: DescribeFinishCell, routing: RoutingTable | undefined, now: () => Date,
  capture: () => Promise<{ roster: RosterState; snapshot: string }>) {
  if (hostedDraftProjects.get(draft) !== project || !managedActionCurrent(project.rosterSigner, action, draft.intent.actionBytes())) return undefined;
  const signer = project.rosterSigner as AsyncPayloadSigner;
  const cell = draft.intent.unsignedGrant().cell;
  const selected = await capture();
  const matches = (roster: RosterState): boolean => {
    const part = describe(roster, cell);
    return part !== undefined && draft.matches(roster, part, routing, now());
  };
  // Concurrent attempts can both refresh the store. Only the first current one may use this draft.
  if (hostedDraftProjects.get(draft) !== project || !matches(selected.roster)) return undefined;
  const scope = createFinishGrantScope(draft.intent, signer, action, async () => {
    const fresh = await capture();
    return fresh.snapshot === selected.snapshot && matches(fresh.roster);
  });
  if (!scope.approved()) return undefined;
  hostedDraftProjects.delete(draft);
  const pages = await scope.signGrants();
  if ('refused' in pages) return undefined;
  const permits = scope.permitDrafts();
  if (permits === undefined) return undefined;
  for (const [index, permit] of permits.entries()) {
    if (typeof await scope.signerFor('permit', index).sign(accessPermitBytes(permit)) !== 'string') return undefined;
  }
  const signed = scope.verifiedRekey();
  if (signed === undefined) return undefined;
  const checked = await capture();
  if (checked.snapshot !== selected.snapshot || !matches(checked.roster)) return undefined;
  const info = describe(checked.roster, cell);
  if (info === undefined) return undefined;
  const plan = recoveryInputs(project, checked.roster, info);
  if (!plan.ok) return undefined;
  const write = recoveryWritePlan(project, checked.roster, plan, pages, draft.epochKey());
  if ('ok' in write || signed.revision !== write.revision || !canonicalBytes(signed.operation).equals(canonicalBytes(write.operation))) return undefined;
  const staged = stageManagedAccess(write, signed.permits);
  if (staged === undefined) return undefined;
  return { ...staged, options: { ...staged.options, signer, action }, scope, matches, snapshot: selected.snapshot };
}

export type HostedFinishWrite = NonNullable<Awaited<ReturnType<typeof authorizeHostedFinish>>>;

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

// Who is in a multi-user staff project, and how they get in and out (D-09, D-10, D-13 to D-18, D-22, D-23, D-37, D-45). The host flows behind the
// roster commands; the commands (31-23) only show dialogs and call these. Node I/O through ReplicaProject and keyring.ts, apart from branchEntries, which
// reads the store's roster line files read-only to describe a split (D-08); never imports vscode.
//
// The flows, as the person sees them:
//   lead:    inviteToProject -> (sends the .near-staff-invite file any way they like)
//   joiner:  joinFromInvite  -> (sends the .near-staff-join file back, reads the six words aloud)
//   lead:    reviewJoinRequest (shows the six words) -> admitJoinRequest { codeMatched: true } -> (sends the .near-staff-welcome file)
//   joiner:  openWelcome     -> the project opens on the joiner's computer
// Add My Other Machine is the same flow with a short invitation for an existing member (addMyOtherMachine), admitted as device.add. An invitation that
// is no longer wanted is closed with voidInvite. A welcome file that was lost or never saved is made again from the same join request with
// remakeWelcome (MJ-02): the device is already in the roster, and the welcome is of use to that device only.
//
// Who may invite (MJ-05): any device of the lead or the deputy. The invitation names the project's anchor (the founding lead, which the joining
// device pins) and, apart from it, the inviter (the signing device). The joining device keeps both in a pending record outside the project until the
// welcome arrives (MN-01: opening an invitation pins nothing), and joins only when the roster folded from the anchor shows that the inviter, a roster
// writer there, wrote the invitation that admitted it. The safety code covers the anchor's, the inviter's and the joining device's keys.
//
// The invitation's state machine (the roster fold is the authority; these flows refuse before they write so a person is told plainly):
//   open --admit or device.add--> used        open --invite.void--> voided        open --signed time past expiresAt--> expired (refused at use)
// The join secret lives in this computer's secret storage from the invitation until a roster entry records its outcome (used or voided), and is then
// forgotten (P-31-28). Nothing else is ever deleted.
//
// Rekey uses the roster to find interrupted rotations (MJ-03) and checks clearance against the private labels (D-22).
//
// No status or error holds a join secret, MAC or key (P-31-23). Only the invitation contains the join secret and only the join request contains the MAC.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { eachRosterLine } from './rosterBranchFiles';
import { dominates } from '../../domain/gate/dominance';
import type { DominanceContext } from '../../domain/gate/dominance';
import { SCALE_PRESETS, parseClearance, parseLabel } from '../../domain/gate/labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from '../../domain/gate/labels';
import { REKEY_KEEP_TEXT, REKEY_PENDING_TEXT, REKEY_VERIFIED_TEXT, grantHash, newEpochKey, openLabel, planRekey, readGrant, sealLabel } from '../../domain/replica/cellKeys';
import type { RekeyPlan, RekeyReason } from '../../domain/replica/cellKeys';
import { entryHash, openBody, parseHeaderShape, writerIdOf } from '../../domain/replica/entry';
import type { SealedEntry } from '../../domain/replica/entry';
import {
  INVITE_FILE_EXTENSION, INVITE_REFUSALS, JOIN_REQUEST_FILE_EXTENSION, WELCOME_FILE_EXTENSION, WELCOME_MAX_BYTES, buildInviteAsync, buildJoinRequestAsync,
  checkAdmittedRequest, checkJoinRequest, inviteAnchor, inviteSafetyCode, joinSecretHash, newJoinSecret, readInvite, readWelcome
} from '../../domain/replica/invite';
import type { InviteLead, InvitePayload, InviteRefusal, JoinRequestPayload } from '../../domain/replica/invite';
import type { ProjectOutput } from '../../domain/replica/projectFold';
import { ROSTER_REFUSALS, ROSTER_SPLIT_TEXT, deputyAt, isRosterWriterAt, leadAt } from '../../domain/replica/roster';
import type { RosterAnchor, RosterState } from '../../domain/replica/roster';
import { CELL_ACCESS_FEATURE } from '../../domain/replica/features';
import { appendManagedClearance } from './managedClearance';
import { appendManagedWithdrawal } from './managedWithdrawal';
import { finishManagedRekeys, leftReason } from './managedRecovery';
import { readLegacyCellLabel } from '../../domain/replica/productCells';
import { CELL_REFUSALS, epochAt, epochsAt, granteesAt } from '../../domain/replica/rosterCells';
import { MEMBER_REFUSALS, deviceAt, devicesOfMemberAt, hubCellsAt, inviteAt, memberAt, x25519At } from '../../domain/replica/rosterMembers';
import { SWITCH_FIRST_TEXT, awaitsHybridRecipients, formatFor, grantsTo, newEpochGrant, type PlannedEpoch } from './wrapPlan';
import type { MemberRecord } from '../../domain/replica/rosterMembers';
import type { ReplicaContext } from '../../domain/replica/rosterView';
import { MAX_SLOT } from '../../domain/replica/clientIds';
import { canonicalBytes } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { MULTI_USER_DECLARED_TEXT, REPLICA_DIR, multiUserNoticeLines } from '../../domain/staff/multiUser';
import { readWhole, snapshotOf, writeIfUnchanged } from '../staffFiles';
import { forgetJoinSecret, joinSecret, storeJoinSecret } from './keyring';
import type { DeviceKeyRing } from './keyring';
import { PROJECT_REFUSALS_HOST, ReplicaProject, ReplicaProjectError, anchorOf, genesisPinFile, isProjectRefused, projectFile, sameAnchor, settled } from './replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from './replicaProject';
import { parseSealed } from './store';

/** Added to what naming a deputy or handing over the lead says when that gave the person the legacy cell (D-20). */
export const LEGACY_GIVEN_TEXT = 'They were also given the part of the project that holds its history from before it was shared.';
/** How long an invitation is open when the lead does not say (D-14). */
export const INVITE_DEFAULT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The seat an Add My Other Machine invitation names when the member has none (the lead). device.add ignores it; the schema requires one. */
const OTHER_MACHINE_SEAT = 'other-machine';
/** The lowest clearance an Add My Other Machine invitation names when the member has none. device.add ignores it; it never gives a clearance. */
const OTHER_MACHINE_CLEARANCE = { scale: 'org', level: 'Public', compartments: [], releasability: [] } as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LEAD_ROLES: readonly string[] = ['staff_lead', 'deputy_lead'];
/** Today's single-machine staff ledgers (DESIGN 14): a folder holding any of them is a staff project already. */
const TODAY_LEDGERS = ['.planning/staff/ledger/products.jsonl', '.planning/staff/ledger/decisions.jsonl', '.planning/staff/ledger/calculator.jsonl', '.planning/staff/wargame/ledger.jsonl'];

// Plain sentences: what happened and what to do next (D-37). None names a key, a secret, a MAC or a hash, and none uses a dash as punctuation.
export const MEMBERSHIP_REFUSALS = {
  'code-not-confirmed': 'Nobody was admitted, because the six words were not confirmed. Compare the words with the person out loud or in person, and admit them only if every word matches.',
  'invite-expired': 'This invitation has expired, so it cannot be used to join. Ask the staff lead for a new one.',
  'invite-used': 'This invitation was already used to join the project, and an invitation works only once. Ask the staff lead for a new one.',
  'invite-voided': 'The staff lead cancelled this invitation, so it cannot be used. Ask the staff lead for a new one if it is still needed.',
  'wrong-secret': 'This join request was not made from the invitation this computer sent, so nobody was admitted. Ask the person to make a new join request from your invitation.',
  'unknown-invite': 'This join request answers an invitation this project does not have, so nobody was admitted. Ask the person to use the invitation you sent.',
  'folder-has-staff-project': 'This folder already holds a staff project, so the shared project was not joined here and nothing was changed. Choose an empty folder for the shared project.',
  'not-a-roster-writer': 'Only the staff lead or the deputy lead can change who is in this project, and this computer is not one of their devices. Nothing was changed.',
  'member-unknown': 'That person is not a member of this project, so nothing was changed. Check the name and try again.',
  'no-grant-key': 'This computer does not hold every key this change needs, so nothing was changed. Make the change on the staff lead\'s computer that holds the project\'s keys.',
  'invite-not-remade': 'This computer did not make that invitation, or no longer holds its secret, so it cannot be saved again here. Cancel it with Staff: Remove from Staff Project and invite the person again.',
  'no-join-secret': 'This computer does not hold the secret of that invitation, so the join request cannot be checked here and nobody was admitted. Admit the person on the computer that made the invitation.',
  'not-admitted-yet': 'Nobody was admitted with this join request yet, so there is no welcome file to make again. Nothing was changed. Admit the person with Staff: Admit to Staff Project.',
  'no-invitation-opened': 'This computer has not opened an invitation for this project, so the welcome file was not used and nothing was changed. Open the staff lead\'s invitation with Staff: Join Staff Project first, then open the welcome file.',
  'welcome-not-for-invitation': 'This welcome file does not admit this computer through an invitation it opened, so the project was not joined and nothing was kept. Check that you chose the right file, or ask the staff lead for a new welcome file.',
  'rekey-awaiting-keys': 'Part of the project still needs a new key. A computer that still has access must publish compatible encryption keys before the change can finish.',
  'nothing-to-finish': 'No removal or clearance change was left unfinished, so no part of the project needed a new key. Nothing was changed.',
  'roster-split': `${ROSTER_SPLIT_TEXT} Nothing else can change the roster until a branch is chosen, so nothing was changed.`,
  'no-split': 'The roster is not split, so there is nothing to choose. Nothing was changed.',
  'not-a-branch': 'That is not one of the roster changes waiting for a choice, so nothing was chosen. Pick one of the changes shown.',
  'device-unknown': 'That device is not one of this member\'s devices in the project, so nothing was changed.',
  'device-limit': MEMBER_REFUSALS['device-limit'],
  'welcome-too-large': 'The person was admitted, but the welcome file would be larger than a welcome file can be, so it was not made. Ask for help to bring them in another way.',
  'change-not-applied': 'The change was written, but the roster on this computer did not take it, so it has no effect. Nothing else was changed.',
  'nothing-to-change': 'Nothing in that change differs from what the roster already says, so nothing was written.'
} as const;
export type MembershipRefusal = keyof typeof MEMBERSHIP_REFUSALS;

/**
 * What every flow returns. notices are the D-13 lines; file is a file for the person to send (name and JSON text); safetyWords are the six words to
 * compare; rekeyed lists the cells moved to a new key; granted the cells newly given; reason names the refusal.
 */
export interface MembershipResult {
  ok: boolean;
  reason?: string;
  message: string;
  notices: string[];
  file?: { name: string; text: string };
  safetyWords?: string[];
  rekeyed?: string[];
  granted?: string[];
  invite?: string;
  member?: string;
  writer?: string;
  /** reviewJoinRequest: the request's device was already admitted by its invitation, so only its welcome file can be made again (remakeWelcome). */
  alreadyAdmitted?: boolean;
}
/** openWelcome returns the joined project too; the caller closes it. */
export interface OpenWelcomeResult extends MembershipResult { project?: ReplicaProject }

/**
 * A shared project as the membership flows need it: the project, the deps it was opened with (secret storage for join secrets, the clock), and the
 * gate's scale table and mappings for clearance dominance (the shipped presets and no mapping when absent).
 */
export interface SharedProjectHost {
  project: ReplicaProject;
  deps: ReplicaProjectDeps;
  scales?: ScaleTable;
  mappings?: readonly ScaleMapping[];
  routing?: import('../../domain/gate/routing').RoutingTable; // which labels are Protected B and above for the wrap rule (33.2 D-07); the defaults when absent
}

const done = (message: string, extra: Partial<MembershipResult> = {}): MembershipResult => ({ ok: true, message, notices: multiUserNoticeLines(), ...extra });
const refused = (reason: string, message: string): MembershipResult => ({ ok: false, reason, message, notices: multiUserNoticeLines() });
const refuse = (reason: MembershipRefusal): MembershipResult => refused(reason, MEMBERSHIP_REFUSALS[reason]);
const fromProject = (value: ProjectRefused): MembershipResult => refused(value.refused, value.message);

function fromInvite(reason: InviteRefusal): MembershipResult {
  return Object.hasOwn(MEMBERSHIP_REFUSALS, reason) ? refuse(reason as MembershipRefusal) : refused(reason, INVITE_REFUSALS[reason]);
}

/** The plain sentence for a reason the roster fold gave, from the module that gave it. */
function foldMessage(reason: string): string {
  if (Object.hasOwn(MEMBER_REFUSALS, reason)) return MEMBER_REFUSALS[reason as keyof typeof MEMBER_REFUSALS];
  if (Object.hasOwn(ROSTER_REFUSALS, reason)) return ROSTER_REFUSALS[reason as keyof typeof ROSTER_REFUSALS];
  if (Object.hasOwn(CELL_REFUSALS, reason)) return CELL_REFUSALS[reason as keyof typeof CELL_REFUSALS];
  return MEMBERSHIP_REFUSALS['change-not-applied'];
}

const now = (deps: ReplicaProjectDeps): Date => deps.now?.() ?? new Date();
export const headOf = (roster: RosterState): { hash: string; position: number } => ({ hash: roster.positions[roster.positions.length - 1], position: roster.positions.length - 1 });

/** Runs a flow, turning a store refusal on refresh into a plain result instead of an exception. */
async function guarded<T>(work: () => Promise<T>): Promise<T | MembershipResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReplicaProjectError) return fromProject(error.refusal);
    throw error;
  }
}

// ---- clearance at write time (D-22) --------------------------------------------------------------------------------------------------------------

export interface CellInfo {
  cell: string;
  base: boolean;
  /** The label read from a grant this device can open; undefined for the base cell or when it cannot be read here. */
  label?: Label;
  /** The labels of the lead-only legacy cell (D-20), read from its sealed legacy form; such a cell has no single label. */
  legacy?: readonly Label[];
  /** The label as sealed, to seal again into new grants. */
  raw?: unknown;
  /** False for a labelled cell whose label this device cannot open: nobody is counted cleared for it here (fail closed). */
  known: boolean;
}

/**
 * The label of a cell, opened from any grant of it this device holds the epoch key for. The lead-only legacy cell (D-20) seals the legacy form, a set
 * of labels, read first: it gives legacy and no label. Undefined when none opens.
 */
function cellLabel(roster: RosterState, keys: DeviceKeyRing, cell: string, scales: ScaleTable): { label?: Label; legacy?: Label[]; raw: unknown } | undefined {
  const record = roster.cells.cells.get(cell);
  if (record === undefined) return undefined;
  const grants = [...record.grants].sort((a, b) => b.epoch - a.epoch);
  for (const grant of grants) {
    if (grant.grant.labelSealed === '') continue;
    const key = keys.epochKey(cell, grant.epoch);
    if (key === undefined) continue;
    const raw = openLabel(key, cell, grant.epoch, grant.grant.labelSealed);
    const legacy = raw === undefined ? undefined : readLegacyCellLabel(raw, scales);
    if (legacy !== undefined) return { legacy, raw };
    const parsed = raw === undefined ? undefined : parseLabel(raw, scales);
    if (parsed !== undefined && parsed.ok) return { label: parsed.value, raw };
  }
  return undefined;
}

/** Every cell the roster has at the position, with its label as this device can read it. */
export function cellsAt(roster: RosterState, keys: DeviceKeyRing, position: number, scales: ScaleTable): CellInfo[] {
  const project = roster.anchor.project;
  const cells: CellInfo[] = [];
  for (const cell of [...roster.cells.cells.keys()].sort()) {
    if (epochAt(roster.cells, cell, position) === undefined) continue;
    if (cell === project) {
      cells.push({ cell, base: true, known: true });
      continue;
    }
    const label = cellLabel(roster, keys, cell, scales);
    if (label?.legacy !== undefined) cells.push({ cell, base: false, legacy: label.legacy, raw: label.raw, known: true });
    else cells.push(label?.label === undefined ? { cell, base: false, known: false } : { cell, base: false, label: label.label, raw: label.raw, known: true });
  }
  return cells;
}

/** A declared clearance from the roster as the Phase 70 reader wants it (the roster's optional handling field is not part of a clearance). */
function clearanceOf(value: unknown, scales: ScaleTable): Clearance | undefined {
  if (!isRecord(value)) return undefined;
  const { handling: _handling, ...rest } = value;
  const parsed = parseClearance(rest, scales);
  return parsed.ok ? parsed.value : undefined;
}

export interface Gate { scales: ScaleTable; context: DominanceContext }

export function gateOf(shared: SharedProjectHost): Gate {
  const scales = shared.scales ?? SCALE_PRESETS;
  return { scales, context: { scales, mappings: shared.mappings ?? [], now: now(shared.deps).getTime() } };
}

/** Check a cell's clearance with the active policy. The base is shared; the legacy cell is restricted to lead and deputy. */
export function clearedFor(clearance: unknown, info: CellInfo, holds: boolean, gate: Gate, leadOrDeputy = false): boolean {
  if (info.base) return true;
  if (info.legacy !== undefined) {
    if (!info.known || !leadOrDeputy) return false;
    if (clearance === undefined) return holds;
    const declared = clearanceOf(clearance, gate.scales);
    return declared !== undefined && info.legacy.every((label) => dominates(declared, label, gate.context));
  }
  if (!info.known || info.label === undefined) return false;
  if (clearance === undefined) return holds;
  const parsed = clearanceOf(clearance, gate.scales);
  return parsed !== undefined && dominates(parsed, info.label, gate.context);
}

/** Does any device of the member hold the cell's current epoch at the position? */
function memberHolds(roster: RosterState, member: string, cell: string, position: number): boolean {
  const grantees = granteesAt(roster.cells, cell, position, (writer) => deviceAt(roster.members, writer, position) !== undefined) ?? [];
  return devicesOfMemberAt(roster.members, member, position).some((device) => grantees.includes(device.writer));
}

/** What a change does to the members, for computing who is cleared after it before it is written. */
export interface Change { without?: ReadonlySet<string>; clearance?: { member: string; value: unknown } }

/** The devices cleared for the cell at the position, after the change: person devices of cleared members, and hub devices granted the cell. */
export function clearedDevices(roster: RosterState, info: CellInfo, position: number, gate: Gate, change: Change = {}): string[] {
  const writers: string[] = [];
  for (const versions of roster.members.devices.values()) {
    const device = versions.find((record) => record.from <= position && (record.until === undefined || position < record.until));
    if (device === undefined || change.without?.has(device.writer)) continue;
    if (device.kind === 'hub') {
      // The hub is never on the legacy cell (D-64), whatever hub.grant says.
      if (info.legacy === undefined && hubCellsAt(roster.members, device.member, position)?.includes(info.cell) === true) writers.push(device.writer);
      continue;
    }
    const record = memberAt(roster.members, device.member, position);
    if (record === undefined) continue;
    const clearance = change.clearance?.member === record.member ? change.clearance.value : record.clearance;
    const leadOrDeputy = leadAt(roster, position) === record.member || deputyAt(roster, position) === record.member;
    if (clearedFor(clearance, info, memberHolds(roster, record.member, info.cell, position), gate, leadOrDeputy)) writers.push(device.writer);
  }
  return writers.sort();
}

/** Order citations upward by the active policy (D-25); an unreadable label cannot be used. */
export function cellOrderHook(options: { scales?: ScaleTable; mappings?: readonly ScaleMapping[]; now?: () => Date } = {}): (roster: RosterState, keys: DeviceKeyRing) => NonNullable<ReplicaContext['cellOrder']> {
  return (roster, keys) => {
    const scales = options.scales ?? SCALE_PRESETS;
    const context: DominanceContext = { scales, mappings: options.mappings ?? [], now: (options.now?.() ?? new Date()).getTime() };
    const labels = new Map<string, Label | undefined>();
    const labelOf = (cell: string): Label | undefined | null => {
      if (cell === roster.anchor.project) return null;
      if (!labels.has(cell)) labels.set(cell, cellLabel(roster, keys, cell, scales)?.label);
      return labels.get(cell);
    };
    return (citing, cited) => {
      const to = labelOf(cited);
      if (to === null) return true;
      const from = labelOf(citing);
      // A legacy cell has no single label, so it answers no either way; nothing cites it.
      if (from === null || from === undefined || to === undefined) return false;
      return dominates({ scale: from.scale, level: from.level, compartments: from.compartments, releasability: from.releasability }, to, context);
    };
  };
}

// ---- the writer's checks and the roster's answer -------------------------------------------------------------------------------------------------

/** The refusal for a roster change this device cannot make now, or undefined. */
export function writerProblem(shared: SharedProjectHost, roster: RosterState): MembershipResult | undefined {
  const head = headOf(roster);
  if (!isRosterWriterAt(roster, shared.project.deviceWriter, head.position)) return refuse('not-a-roster-writer');
  if (roster.pending.length > 0) return refuse('roster-split');
  return undefined;
}

/** The roster's answer to an entry this device just wrote: undefined when it applied, otherwise a refusal with the fold's own sentence. */
async function applied(shared: SharedProjectHost, hash: string): Promise<{ roster: RosterState } | MembershipResult> {
  const { roster } = await shared.project.state();
  if (roster.positionOf.has(hash)) return { roster };
  const found = roster.refused.find((item) => item.hash === hash);
  return found === undefined ? refuse('change-not-applied') : refused(found.reason, foldMessage(found.reason));
}

export async function append(
  shared: SharedProjectHost, kind: string, data: unknown, roster?: string, confirmation?: 'report-saved'
): Promise<{ hash: string; roster: RosterState } | MembershipResult> {
  const written = await shared.project.appendOwn(kind, data, roster === undefined ? {} : { roster });
  if (isProjectRefused(written)) return fromProject(written);
  try {
    const outcome = await applied(shared, written.hash);
    return 'roster' in outcome ? { hash: written.hash, roster: outcome.roster } : outcome;
  } catch (error) {
    if (confirmation !== 'report-saved' || !(error instanceof ReplicaProjectError)) throw error;
    const { refused: reason, message } = error.refusal;
    return refused(reason, `The signed change was saved. This computer could not confirm whether it applied to the roster. ${diagnosticAfterWrite(message)}`);
  }
}

const isResult = (value: unknown): value is MembershipResult => isRecord(value) && typeof value.ok === 'boolean' && typeof value.message === 'string';

/** This device as the roster has it at the position: its member and keys, as an invitation names its inviter. */
function selfAt(shared: SharedProjectHost, roster: RosterState, position: number): InviteLead | undefined {
  const device = deviceAt(roster.members, shared.project.deviceWriter, position);
  return device === undefined ? undefined : { member: device.member, writer: device.writer, publicKey: device.publicKey, x25519: device.x25519 };
}

// ---- invite (D-14, D-18) -------------------------------------------------------------------------------------------------------------------------

export interface InviteInput {
  /** The person's name as the lead declares it (D-13). */
  name: string;
  seat: string;
  roles?: string[];
  /** The clearance the lead declares for the person (Phase 70 shape). */
  clearance: unknown;
  /** Days the invitation stays open; INVITE_DEFAULT_DAYS when absent. */
  days?: number;
}

function projectName(fold: { families: Record<string, unknown> }, project: string): string {
  const output = (fold.families.project as ProjectOutput | undefined)?.find((item) => item.stream === project);
  return output?.name ?? 'Staff project';
}

async function writeInvite(shared: SharedProjectHost, input: InviteInput & { forMember?: string }): Promise<MembershipResult> {
  const { project, deps } = shared;
  const { roster, fold } = await project.state();
  const problem = writerProblem(shared, roster);
  if (problem !== undefined) return problem;
  // Any device of the lead or the deputy invites (MJ-05): the invitation names the project's anchor for the joining device to pin, and this device as
  // the inviter, which the joining device checks against the roster folded from that anchor.
  const inviter = selfAt(shared, roster, headOf(roster).position);
  if (inviter === undefined) return refuse('not-a-roster-writer');
  const at = now(deps);
  const days = input.days ?? INVITE_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > 366) throw new Error('An invitation stays open for 1 to 366 days.');
  const expiresAt = new Date(at.getTime() + days * DAY_MS).toISOString();
  const roles = input.roles ?? ['member'];
  if (roles.some((role) => LEAD_ROLES.includes(role))) return refused('lead-role-by-handover-only', MEMBER_REFUSALS['lead-role-by-handover-only']);
  let invite = '';
  do invite = `inv-${randomBytes(6).toString('hex')}`; while (roster.members.invites.has(invite));
  const secret = newJoinSecret();
  const data: Record<string, unknown> = { invite, name: input.name, seat: input.seat, roles, clearance: input.clearance, expiresAt, secretHash: joinSecretHash(secret) };
  if (input.forMember !== undefined) data.forMember = input.forMember;
  // The roster entry first, then the secret: a stored secret always belongs to an invitation the roster has, and a failure after the entry leaves an
  // invitation nobody can answer, which the lead voids.
  const written = await append(shared, 'member.invite', data);
  if (isResult(written)) return written;
  await storeJoinSecret(deps.secrets, invite, secret);
  const signed = await settled(buildInviteAsync(project.rosterSigner, {
    genesisHash: project.anchor.genesisHash, project: project.projectId, name: projectName(fold, project.projectId),
    lead: { member: project.anchor.lead.member, x25519: project.anchor.lead.x25519, publicKey: project.anchor.lead.publicKey },
    inviter: { member: inviter.member, x25519: inviter.x25519 }, invite, secret, expiresAt, now: at, requires: roster.required,
    ...(input.forMember === undefined ? {} : { forMember: input.forMember })
  }));
  const when = expiresAt.slice(0, 10);
  const what = input.forMember === undefined ? `The invitation for ${input.name} is ready.` : `The invitation for ${input.name}'s other computer is ready.`;
  return done(`${what} Send the file to them any way you like. It works once and expires on ${when}. When their join request comes back, compare the six words with them out loud or in person before you admit them.`, {
    file: { name: `${invite}${INVITE_FILE_EXTENSION}`, text: JSON.stringify(signed) }, invite
  });
}

/** An invitation this computer made that is still open: its file can be saved again from the roster entry and the stored secret. */
export interface ReissuableInvite { invite: string; name: string; expiresAt: string; forMember?: string }

/**
 * The open, unexpired invitations whose join secret this computer holds (it stores a secret only for an invitation it wrote). Their files can be
 * saved again with remakeInvite when the first save failed. Reads only.
 */
export async function reissuableInvites(shared: SharedProjectHost): Promise<ReissuableInvite[]> {
  const { roster } = await shared.project.state();
  const position = headOf(roster).position;
  const at = now(shared.deps).toISOString();
  const found: ReissuableInvite[] = [];
  for (const record of roster.members.invites.values()) {
    if (inviteAt(roster.members, record.invite, position, at)?.state !== 'open') continue;
    const secret = await joinSecret(shared.deps.secrets, record.invite);
    if (secret === undefined || joinSecretHash(secret) !== record.secretHash) continue;
    found.push(record.forMember === undefined ? { invite: record.invite, name: record.name, expiresAt: record.expiresAt } : { invite: record.invite, name: record.name, expiresAt: record.expiresAt, forMember: record.forMember });
  }
  return found.sort((a, b) => a.invite.localeCompare(b.invite));
}

/**
 * Saves an invitation again when its file was lost (the first save failed after the roster recorded it). Writes nothing: the file is rebuilt from
 * the roster's member.invite entry and the join secret this computer kept, signed by this device as the inviter, as at first. Only an open,
 * unexpired invitation whose secret this computer holds can be remade; the copy is the same capability the first file was, never a new one.
 */
export function remakeInvite(shared: SharedProjectHost, invite: string): Promise<MembershipResult> {
  return guarded(async () => {
    const { project, deps } = shared;
    const { roster, fold } = await project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const record = roster.members.invites.get(invite);
    const position = headOf(roster).position;
    const at = now(deps);
    const standing = inviteAt(roster.members, invite, position, at.toISOString());
    if (record === undefined || standing === undefined) return refuse('unknown-invite');
    if (standing.state === 'used') return refuse('invite-used');
    if (standing.state === 'voided') return refuse('invite-voided');
    if (standing.state === 'expired') return refuse('invite-expired');
    const secret = await joinSecret(deps.secrets, invite);
    if (secret === undefined || joinSecretHash(secret) !== record.secretHash) return refuse('invite-not-remade');
    // The inviter's keys as they stood when the invitation was written, which the joining device checks against the roster.
    const inviter = selfAt(shared, roster, record.from);
    if (inviter === undefined) return refuse('invite-not-remade');
    const signed = await settled(buildInviteAsync(project.rosterSigner, {
      genesisHash: project.anchor.genesisHash, project: project.projectId, name: projectName(fold, project.projectId),
      lead: { member: project.anchor.lead.member, x25519: project.anchor.lead.x25519, publicKey: project.anchor.lead.publicKey },
      inviter: { member: inviter.member, x25519: inviter.x25519 }, invite, secret, expiresAt: record.expiresAt, now: at, requires: roster.required,
      ...(record.forMember === undefined ? {} : { forMember: record.forMember })
    }));
    const who = record.forMember === undefined ? record.name : `${record.name}'s other computer`;
    return done(`The invitation for ${who} is ready again. Nothing was changed in the project. It still works once and expires on ${record.expiresAt.slice(0, 10)}.`, {
      file: { name: `${invite}${INVITE_FILE_EXTENSION}`, text: JSON.stringify(signed) }, invite
    });
  });
}

/**
 * Invites one person by file (D-14): writes member.invite with the sha256 of a fresh 32-byte join secret, keeps the secret in this computer's secret
 * storage, and returns the signed .near-staff-invite file (open INVITE_DEFAULT_DAYS days unless the lead says otherwise).
 */
export function inviteToProject(shared: SharedProjectHost, input: InviteInput): Promise<MembershipResult> {
  return guarded(() => writeInvite(shared, input));
}

/** Add My Other Machine (D-18): a short invitation that only another computer of this existing member can answer; its admission is a device.add. */
export function addMyOtherMachine(shared: SharedProjectHost, input: { member: string; days?: number }): Promise<MembershipResult> {
  return guarded(async () => {
    const { roster } = await shared.project.state();
    const record = memberAt(roster.members, input.member, headOf(roster).position);
    if (record === undefined) return refuse('member-unknown');
    return writeInvite(shared, {
      name: record.name, seat: record.seat ?? OTHER_MACHINE_SEAT, roles: record.roles.filter((role) => !LEAD_ROLES.includes(role)),
      clearance: record.clearance ?? OTHER_MACHINE_CLEARANCE, forMember: record.member, ...(input.days === undefined ? {} : { days: input.days })
    });
  });
}

/** Closes an open invitation (D-17): writes invite.void, then forgets its join secret once the roster has recorded it. */
export function voidInvite(shared: SharedProjectHost, invite: string): Promise<MembershipResult> {
  return guarded(async () => {
    const { roster } = await shared.project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const standing = SLUG.test(invite) ? inviteAt(roster.members, invite, headOf(roster).position) : undefined;
    if (standing === undefined) return refuse('unknown-invite');
    if (standing.state === 'voided') return refuse('invite-voided');
    if (standing.state === 'used') return refuse('invite-used');
    const written = await append(shared, 'invite.void', { invite });
    if (isResult(written)) return written;
    await forgetJoinSecret(shared.deps.secrets, invite);
    return done('The invitation was cancelled. Nobody can join with it now.', { invite });
  });
}

// ---- join (D-15, D-16) ---------------------------------------------------------------------------------------------------------------------------

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** Does the folder already hold today's staff ledgers, or a shared project other than `project`? A join never mixes two projects. */
async function folderHasOtherProject(root: string, project: string | undefined): Promise<boolean> {
  for (const ledger of TODAY_LEDGERS) if (await exists(path.join(path.resolve(root), ...ledger.split('/')))) return true;
  const file = projectFile(root);
  if (!(await exists(file))) return false;
  const read = await readWhole(file, 64 * 1024);
  if (read.kind !== 'text') return true;
  try {
    const value = JSON.parse(read.text) as unknown;
    const anchor = isRecord(value) ? anchorOf(value.anchor) : undefined;
    return anchor === undefined || anchor.project !== project;
  } catch {
    return true;
  }
}

export interface JoinInput {
  /** The person's own name, as they want the lead to see it. */
  name: string;
}

// ---- what a joining computer keeps from an invitation (MN-01, MJ-05) ---------------------------------------------------------------------------

/** The folder under a project's pin folder that holds the invitations this computer answered and has not joined by yet. */
export const PENDING_INVITATIONS_FOLDER = 'invitations';
const PENDING_FILE = /^[0-9a-f]{64}\.json$/;
const ANCHOR_FILE_MAX_BYTES = 64 * 1024;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

/** An invitation this computer answered: the anchor to pin and the inviter to check once the welcome arrives. Ids and public keys only. */
export interface PendingInvitation { invite: string; anchor: RosterAnchor; inviter: InviteLead; expiresAt: string }

export function pendingInvitationsDir(globalStorageDir: string, project: string): string {
  return path.join(path.dirname(genesisPinFile(globalStorageDir, project)), PENDING_INVITATIONS_FOLDER);
}

function inviteDeviceOf(value: unknown): InviteLead | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'member,publicKey,writer,x25519') return undefined;
  const { member, writer, publicKey, x25519 } = value;
  if (typeof member !== 'string' || !SLUG.test(member) || typeof publicKey !== 'string' || !BASE64URL_KEY.test(publicKey)) return undefined;
  if (typeof x25519 !== 'string' || !BASE64URL_KEY.test(x25519) || typeof writer !== 'string' || writer !== writerIdOf(publicKey)) return undefined;
  return { member, writer, publicKey, x25519 };
}

/**
 * Keeps the invitation this computer answered, in extension storage outside the project, under a name that is the hash of its content: a second
 * invitation, even one naming the same invitation id, never replaces it.
 */
async function keepPending(deps: ReplicaProjectDeps, invite: InvitePayload): Promise<void> {
  const record = { v: 1, invite: invite.invite, anchor: inviteAnchor(invite), inviter: { ...invite.inviter }, expiresAt: invite.expiresAt };
  const dir = pendingInvitationsDir(deps.globalStorageDir, invite.project);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${createHash('sha256').update(canonicalBytes(record)).digest('hex')}.json`);
  if (await exists(file)) return;
  if (!(await writeIfUnchanged(file, await snapshotOf(file), `${JSON.stringify(record, null, 2)}\n`))) throw new Error('The join request was not made: the invitation could not be kept on this computer.');
}

/** The invitations this computer answered for a project, read as untrusted files; one that does not read is left out. */
async function pendingFor(deps: ReplicaProjectDeps, project: string): Promise<PendingInvitation[]> {
  const dir = pendingInvitationsDir(deps.globalStorageDir, project);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => PENDING_FILE.test(name)).sort();
  } catch {
    return [];
  }
  const found: PendingInvitation[] = [];
  for (const name of names) {
    const read = await readWhole(path.join(dir, name), ANCHOR_FILE_MAX_BYTES);
    if (read.kind !== 'text') continue;
    try {
      const value = JSON.parse(read.text) as unknown;
      if (!isRecord(value) || value.v !== 1 || typeof value.invite !== 'string' || !SLUG.test(value.invite) || typeof value.expiresAt !== 'string') continue;
      const anchor = anchorOf(value.anchor);
      const inviter = inviteDeviceOf(value.inviter);
      if (anchor === undefined || inviter === undefined || anchor.project !== project) continue;
      found.push({ invite: value.invite, anchor, inviter, expiresAt: value.expiresAt });
    } catch {
      continue;
    }
  }
  return found;
}

type PinRead = { kind: 'missing' } | { kind: 'anchor'; anchor: RosterAnchor } | { kind: 'damaged' };

/** The project's pin on this computer, read the way replicaProject reads it (a link or a file that does not read is damaged). */
async function readPin(deps: ReplicaProjectDeps, project: string): Promise<PinRead> {
  const file = genesisPinFile(deps.globalStorageDir, project);
  try {
    if ((await lstat(file)).isSymbolicLink()) return { kind: 'damaged' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'damaged' };
  }
  const read = await readWhole(file, ANCHOR_FILE_MAX_BYTES);
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind !== 'text') return { kind: 'damaged' };
  try {
    const value = JSON.parse(read.text) as unknown;
    const anchor = isRecord(value) && value.v === 1 ? anchorOf(value.anchor) : undefined;
    return anchor === undefined ? { kind: 'damaged' } : { kind: 'anchor', anchor };
  } catch {
    return { kind: 'damaged' };
  }
}

const hostRefusal = (reason: keyof typeof PROJECT_REFUSALS_HOST): MembershipResult => refused(reason, PROJECT_REFUSALS_HOST[reason]);

/** The genesis a welcome file names, read only to find the invitations it may answer; readWelcome and the roster fold check everything. */
function welcomeGenesis(file: unknown): { project: string; hash: string; writer: string } | undefined {
  try {
    const value: unknown = typeof file === 'string' ? (Buffer.byteLength(file, 'utf8') <= WELCOME_MAX_BYTES ? JSON.parse(file) : undefined) : file;
    if (!isRecord(value) || !isRecord(value.genesis)) return undefined;
    const shape = parseHeaderShape(value.genesis.header);
    return shape.ok ? { project: shape.header.stream, hash: entryHash(shape.header), writer: shape.header.writer } : undefined;
  } catch {
    return undefined;
  }
}

/** Moves a file this join wrote out of the way after the join was refused. Never deletes: the file is renamed beside itself. */
async function setAside(file: string, existedBefore: boolean): Promise<void> {
  if (existedBefore || !(await exists(file))) return;
  await rename(file, `${file}.not-joined-${Date.now()}`);
}

/**
 * Did one of the invitations this computer answered admit it, written by its inviter while the inviter was a roster writer (MJ-05)? Read from the
 * roster folded from the pinned anchor: this device is admitted at the head, by that invitation, whose member.invite entry the inviter's device
 * wrote, and that device had the inviter's member and keys there.
 */
async function admittedThrough(joined: ReplicaProject, candidates: readonly PendingInvitation[], welcomeText: unknown): Promise<boolean> {
  const { roster } = await joined.state();
  const head = headOf(roster).position;
  const self = deviceAt(roster.members, joined.deviceWriter, head);
  const first = roster.members.devices.get(joined.deviceWriter)?.[0];
  if (self === undefined || first === undefined) return false;
  const read = readWelcome(welcomeText, { genesisHash: joined.anchor.genesisHash, writer: joined.deviceWriter });
  if (!read.ok) return false;
  for (const candidate of candidates) {
    const record = roster.members.invites.get(candidate.invite);
    if (record === undefined || record.usedBy !== self.member || record.usedAt !== first.from) continue;
    const cited = record.from - 1;
    const entry = read.entries.find((item) => entryHash(item.header) === roster.positions[record.from]);
    const device = deviceAt(roster.members, candidate.inviter.writer, cited);
    if (entry === undefined || entry.header.writer !== candidate.inviter.writer || device === undefined || !isRosterWriterAt(roster, device.writer, cited)) continue;
    if (device.member === candidate.inviter.member && device.publicKey === candidate.inviter.publicKey && device.x25519 === candidate.inviter.x25519) return true;
  }
  return false;
}

/**
 * The joining person's side (D-15, D-16): reads the invitation, refuses a folder that holds another staff project and a project this computer pinned
 * with another anchor, keeps the invitation's anchor and inviter outside the project until the welcome arrives (nothing is pinned yet, MN-01), makes
 * or reuses this install's keys, and returns the signed .near-staff-join file and the six words to read to the lead.
 */
export async function joinFromInvite(root: string, deps: ReplicaProjectDeps, inviteText: unknown, input: JoinInput): Promise<MembershipResult> {
  const read = readInvite(inviteText, now(deps));
  if (!read.ok) return fromInvite(read.reason);
  const invite = read.invite;
  if (await folderHasOtherProject(root, invite.project)) return refuse('folder-has-staff-project');
  const pin = await readPin(deps, invite.project);
  if (pin.kind === 'damaged') return hostRefusal('pin-damaged');
  if (pin.kind === 'anchor' && !sameAnchor(pin.anchor, inviteAnchor(invite))) return hostRefusal('pin-mismatch');
  await keepPending(deps, invite);
  const device = await ReplicaProject.localDevice(deps);
  const request = await settled(buildJoinRequestAsync(device.rosterSigner, invite, { name: input.name, x25519: device.x25519, now: now(deps), ...(device.kem === undefined ? {} : { kem: device.kem }) }));
  const safetyWords = inviteSafetyCode(invite, request.payload);
  const where = invite.forMember === undefined ? `to join ${invite.name}` : `to add this computer to ${invite.name}`;
  return done(`Your request ${where} is ready. Send the file back to the staff lead any way you like, then read these six words to them out loud or in person: ${safetyWords.join(' ')}. They admit you only if the words match.`, {
    file: { name: `join-${invite.invite}${JOIN_REQUEST_FILE_EXTENSION}`, text: JSON.stringify(request) }, safetyWords, invite: invite.invite, writer: device.writer
  });
}

/**
 * The joining person's last step: opens the .near-staff-welcome file the lead returned and joins the shared project in `root`. The welcome is tried
 * against the anchors of the invitations this computer answered for its project (or the pin, for a project this computer already joined), and kept
 * only when the roster folded from that anchor shows this computer admitted through one of them by its inviter (admittedThrough). A refused attempt
 * sets aside the pin and project.json it wrote, so a wrong file never blocks the right one. The result carries the opened project, which the caller
 * closes.
 */
export async function openWelcome(root: string, deps: ReplicaProjectDeps, welcomeText: unknown): Promise<OpenWelcomeResult> {
  for (const ledger of TODAY_LEDGERS) if (await exists(path.join(path.resolve(root), ...ledger.split('/')))) return refuse('folder-has-staff-project');
  const genesis = welcomeGenesis(welcomeText);
  const pin = genesis === undefined ? undefined : await readPin(deps, genesis.project);
  const pending = genesis === undefined ? [] : await pendingFor(deps, genesis.project);
  const matching = genesis === undefined || pin === undefined || pin.kind === 'damaged' ? [] : pending.filter((item) => item.anchor.genesisHash === genesis.hash
    && item.anchor.lead.writer === genesis.writer && (pin.kind !== 'anchor' || sameAnchor(pin.anchor, item.anchor)));
  if (matching.length === 0) {
    // A project this computer joined before any invitation was kept this way: the pin alone decides, as before. Anything else is refused plainly.
    if (genesis !== undefined && pin?.kind === 'missing') return refuse(pending.length === 0 ? 'no-invitation-opened' : 'welcome-not-for-invitation');
    const joined = await ReplicaProject.joinFromWelcome(root, deps, welcomeText);
    if (isProjectRefused(joined)) return joined.refused === 'pin-mismatch' && (await exists(projectFile(root))) ? refuse('folder-has-staff-project') : fromProject(joined);
    return { ...done(`You joined the shared staff project. ${MULTI_USER_DECLARED_TEXT}`), project: joined };
  }
  const anchors: RosterAnchor[] = [];
  for (const item of matching) if (!anchors.some((anchor) => sameAnchor(anchor, item.anchor))) anchors.push(item.anchor);
  let last: MembershipResult = refuse('welcome-not-for-invitation');
  for (const anchor of anchors) {
    const pinFile = genesisPinFile(deps.globalStorageDir, anchor.project);
    const pinBefore = await exists(pinFile);
    const localBefore = await exists(projectFile(root));
    const joined = await ReplicaProject.joinFromWelcome(root, deps, welcomeText, anchor);
    if (isProjectRefused(joined)) {
      await setAside(pinFile, pinBefore);
      last = joined.refused === 'pin-mismatch' && localBefore ? refuse('folder-has-staff-project') : fromProject(joined);
      continue;
    }
    if (await admittedThrough(joined, matching.filter((item) => sameAnchor(item.anchor, anchor)), welcomeText)) {
      return { ...done(`You joined the shared staff project. ${MULTI_USER_DECLARED_TEXT}`), project: joined };
    }
    await joined.close();
    await setAside(projectFile(root), localBefore);
    await setAside(pinFile, pinBefore);
    last = refuse('welcome-not-for-invitation');
  }
  return last;
}

// ---- admit (D-16, D-18, D-22, D-45) --------------------------------------------------------------------------------------------------------------

/** resume: the invitation admitted this device and its secret is still kept. remake: it admitted this device and the secret is forgotten (no MAC). */
interface CheckedRequest { request: JoinRequestPayload; writer: string; invite: InvitePayload; secret: string; safetyWords: string[]; resume: boolean; remake: boolean }

/** The invitation id a request names, read without trusting anything else in it (checkJoinRequest checks everything). */
function requestedInvite(text: unknown): string | undefined {
  try {
    const value: unknown = typeof text === 'string' ? (text.length <= 64 * 1024 ? JSON.parse(text) : undefined) : text;
    const payload = isRecord(value) && Object.hasOwn(value, 'payload') ? value.payload : undefined;
    const invite = isRecord(payload) && Object.hasOwn(payload, 'invite') ? payload.invite : undefined;
    return typeof invite === 'string' && SLUG.test(invite) ? invite : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every check of a join request before anything is written: the invitation's standing in the roster and by the host clock, the secret this computer
 * kept, the request's signature, binding and MAC (checkJoinRequest), and the six words. The inviter in the words is this device: only the device that
 * made an invitation holds its secret. A request whose admission this device already wrote but did not finish (the secret is still kept) is resumed
 * instead of refused invite-used. A request whose invitation already admitted that very device, with the same keys, after its secret was forgotten
 * is marked remake (MJ-02): its signature and binding are checked but no MAC, and it can only make that device's welcome file again.
 */
async function checkRequest(shared: SharedProjectHost, roster: RosterState, requestText: unknown): Promise<CheckedRequest | MembershipResult> {
  const { project, deps } = shared;
  const id = requestedInvite(requestText);
  if (id === undefined) return fromInvite('malformed');
  const head = headOf(roster);
  const record = roster.members.invites.get(id);
  const standing = inviteAt(roster.members, id, head.position);
  if (record === undefined || standing === undefined) return refuse('unknown-invite');
  if (standing.state === 'voided') return refuse('invite-voided');
  const secret = await joinSecret(deps.secrets, id);
  const usedBy = record.usedBy;
  const forMember = record.forMember === undefined ? {} : { forMember: record.forMember };
  const requires = roster.required.length === 0 ? {} : { requires: [...roster.required] };
  // The device a used invitation admitted, with the keys of the request: anything else is refused invite-used.
  const admittedHere = (writer: string, request: JoinRequestPayload): boolean => {
    const device = deviceAt(roster.members, writer, head.position);
    return usedBy !== undefined && device?.member === usedBy && device.publicKey === request.publicKey && device.x25519 === request.x25519;
  };
  if (standing.state === 'used' && secret === undefined) {
    const checked = checkAdmittedRequest(requestText, { invite: { genesisHash: project.anchor.genesisHash, invite: id, ...forMember, ...requires } });
    if (!checked.ok) return fromInvite(checked.reason);
    if (!admittedHere(checked.writer, checked.request)) return refuse('invite-used');
    const invite: InvitePayload = { genesisHash: project.anchor.genesisHash, project: project.projectId, name: 'Staff project', lead: { ...project.anchor.lead }, inviter: { ...project.anchor.lead }, invite: id, secret: '', expiresAt: record.expiresAt, ...forMember };
    return { request: checked.request, writer: checked.writer, invite, secret: '', safetyWords: [], resume: true, remake: true };
  }
  if (secret === undefined) return refuse('no-join-secret');
  const inviter = selfAt(shared, roster, head.position);
  if (inviter === undefined) return refuse('not-a-roster-writer');
  const at = now(deps);
  const invite: InvitePayload = {
    genesisHash: project.anchor.genesisHash, project: project.projectId, name: 'Staff project', lead: { ...project.anchor.lead }, inviter, invite: id, secret,
    expiresAt: record.expiresAt, ...forMember, ...requires
  };
  const checked = checkJoinRequest(requestText, { invite, secret, ...(standing.state === 'used' ? {} : { now: at, rosterInvite: { state: 'open' as const } }) });
  if (!checked.ok) return fromInvite(checked.reason);
  // A used invitation is resumed only when it was this very device that it admitted (a crash before the welcome); otherwise it is used.
  const resume = standing.state === 'used';
  if (resume && !admittedHere(checked.writer, checked.request)) return refuse('invite-used');
  const safetyWords = inviteSafetyCode(invite, checked.request);
  return { request: checked.request, writer: checked.writer, invite, secret, safetyWords, resume, remake: false };
}

/**
 * The lead's first look at a join request: every check, and the six words to compare with the person, with nothing written. The command shows the
 * words and asks the lead to confirm they matched before it calls admitJoinRequest. A request whose device its invitation already admitted, after the
 * join secret was forgotten, has no words: the result says alreadyAdmitted, and the command offers remakeWelcome instead (MJ-02).
 */
export function reviewJoinRequest(shared: SharedProjectHost, requestText: unknown): Promise<MembershipResult> {
  return guarded(async () => {
    const { roster } = await shared.project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const checked = await checkRequest(shared, roster, requestText);
    if (isResult(checked)) return checked;
    const who = checked.invite.forMember === undefined ? checked.request.name : `${checked.request.name}'s other computer`;
    if (checked.remake) {
      return done(`${who} was already admitted with this join request. Their welcome file can be made again; it is of use on their computer only.`, {
        invite: checked.invite.invite, writer: checked.writer, alreadyAdmitted: true
      });
    }
    return done(`Compare these six words with ${who} out loud or in person: ${checked.safetyWords.join(' ')}. Admit them only if every word matches.`, {
      safetyWords: checked.safetyWords, invite: checked.invite.invite, writer: checked.writer
    });
  });
}

/** The smallest device slot never given in this project (D-41: a slot is never reused), or undefined when all are given. */
function freeSlot(roster: RosterState): number | undefined {
  for (let slot = 1; slot <= MAX_SLOT; slot += 1) if (!roster.members.slots.has(slot)) return slot;
  return undefined;
}

interface GrantPlan { cell: string; epochs: PlannedEpoch[]; raw?: unknown }

/**
 * The grants a device needs for every cell its member is cleared for, with every epoch of each (D-45), and their keys from this device's ring. A
 * cleared cell with an epoch key this device does not hold is no-grant-key: refused before anything is written. leadOrDeputy says the member is the
 * lead or the deputy (the legacy cell rule, D-20); it is false at admission, so admission never grants the legacy cell.
 */
function grantPlans(shared: SharedProjectHost, roster: RosterState, member: { clearance: unknown; holdsMember?: string; leadOrDeputy?: boolean }, cells: readonly CellInfo[], gate: Gate, position: number, skip: (cell: string) => boolean = () => false): GrantPlan[] | MembershipResult {
  const plans: GrantPlan[] = [];
  for (const info of cells) {
    const holds = member.holdsMember !== undefined && memberHolds(roster, member.holdsMember, info.cell, position);
    if (!clearedFor(member.clearance, info, holds, gate, member.leadOrDeputy === true) || skip(info.cell)) continue;
    const epochs: GrantPlan['epochs'] = [];
    for (const item of epochsAt(roster.cells, info.cell, position)) {
      const key = shared.project.keys.epochKey(info.cell, item.epoch);
      if (key === undefined) return refuse('no-grant-key');
      const choice = formatFor(roster, info, item.from, shared.routing); // a Protected B epoch is never given the older way (33.2 D-07)
      if (choice !== 'switch-first') epochs.push({ epoch: item.epoch, key, choice });
    }
    if (epochs.length > 0) plans.push({ cell: info.cell, epochs, ...(info.base ? {} : { raw: info.raw }) });
  }
  return plans;
}

/** Signs and stores the per-epoch grants of the plans for one device at the roster given (a roster that admits the device), in each epoch's format. */
async function writeGrants(shared: SharedProjectHost, state: RosterState, plans: readonly GrantPlan[], device: { writer: string }, roster: string): Promise<MembershipResult | undefined> {
  const grants = grantsTo(shared.project.signer, state, roster, device.writer, plans);
  if (grants.length === 0) return undefined;
  const stored = await shared.project.putGrants(grants);
  return isProjectRefused(stored) ? fromProject(stored) : undefined;
}

export interface AdmitInput {
  /** True only when the lead confirmed the six words matched (D-16). Nothing else ever confirms it (P-31-27). */
  codeMatched: boolean;
  /** The agent seats the member's devices may run, given at admission (D-12); none when absent. */
  agentSeats?: string[];
  /** The new member's id; one is made when absent. */
  member?: string;
}

/**
 * Admits the device that answered an invitation (D-16, D-18, D-22, D-45). Refused unless the lead confirmed the six words matched. A removal or
 * clearance change left unfinished is finished first (MJ-03), so the new device is never given a key a removed device still holds. Then: member.admit
 * (or device.add for Add My Other Machine) with the next free slot, the invitation's seat, roles and clearance; a grant for every epoch of every cell
 * the member's declared clearance dominates; the join secret is forgotten once the roster has recorded the admission; and the .near-staff-welcome
 * file for that device alone is returned.
 */
export function admitJoinRequest(shared: SharedProjectHost, requestText: unknown, input: AdmitInput): Promise<MembershipResult> {
  return guarded(async () => {
    if (input.codeMatched !== true) return refuse('code-not-confirmed');
    const { project, deps } = shared;
    const before = await project.state();
    const problem = writerProblem(shared, before.roster);
    if (problem !== undefined) return problem;
    const checkedFirst = await checkRequest(shared, before.roster, requestText);
    if (isResult(checkedFirst)) return checkedFirst;
    if (checkedFirst.remake) return refuse('invite-used');
    // The admission gives the newest keys of the cells: a removal left unfinished is finished first, so no key a removed device holds is handed on.
    const finished = await finishPending(shared);
    if (isResult(finished)) return finished;
    let { roster } = await project.state();
    const checked = finished.rekeyed.length === 0 ? checkedFirst : await checkRequest(shared, roster, requestText);
    if (isResult(checked)) return checked;
    if (checked.remake) return refuse('invite-used');
    const gate = gateOf(shared);
    const id = checked.invite.invite;
    const record = roster.members.invites.get(id);
    if (record === undefined) return refuse('unknown-invite');
    const { kem } = checked.request, device = { writer: checked.writer, publicKey: checked.request.publicKey, x25519: checked.request.x25519, x25519Sig: checked.request.x25519Sig, ...(kem === undefined ? {} : { kem: { ...kem } }) }; // kem: 33.2 D-03
    const forMember = record.forMember;
    let head = headOf(roster);
    let member: string;
    let admitted: string;
    if (checked.resume) {
      member = record.usedBy as string;
      const at = devicesOfMemberAt(roster.members, member, head.position).find((item) => item.writer === device.writer);
      admitted = roster.positions[at?.from ?? head.position];
    } else {
      // Everything the admission needs is checked before the first write: the slot, the member id, and the keys of every cell to grant.
      const slot = freeSlot(roster);
      if (slot === undefined) return refuse('device-limit');
      const existing = forMember === undefined ? undefined : memberAt(roster.members, forMember, head.position);
      if (forMember !== undefined && existing === undefined) return refuse('member-unknown');
      member = forMember ?? input.member ?? '';
      if (forMember === undefined) {
        if (member === '') do member = `mbr-${randomBytes(4).toString('hex')}`; while (roster.members.members.has(member) || roster.members.hubs.has(member));
        if (!SLUG.test(member)) throw new Error('A member id is lowercase letters, digits and dashes.');
        if (roster.members.members.has(member) || roster.members.hubs.has(member)) return refused('member-exists', MEMBER_REFUSALS['member-exists']);
      }
      const cells = cellsAt(roster, project.keys, head.position, gate.scales);
      const check = grantPlans(shared, roster, forMember === undefined
        ? { clearance: record.clearance }
        : { clearance: existing?.clearance, holdsMember: forMember }, cells, gate, head.position);
      if (isResult(check)) return check;
      const data = forMember === undefined
        ? { member, invite: id, name: record.name, seat: record.seat, roles: [...record.roles], clearance: record.clearance, device: { ...device, slot }, agentSeats: [...(input.agentSeats ?? [])] }
        : { member, device: { ...device, slot }, invite: id };
      const written = await append(shared, forMember === undefined ? 'member.admit' : 'device.add', data);
      if (isResult(written)) return written;
      admitted = written.hash;
      roster = written.roster;
      head = headOf(roster);
    }
    // The grants for every cell the member is cleared for, at the roster that admitted the device. A resumed admission grants only what is missing.
    const position = roster.positionOf.get(admitted) as number;
    const clearance = memberAt(roster.members, member, position)?.clearance;
    const cells = cellsAt(roster, project.keys, position, gate.scales);
    const has = (cell: string): boolean => (granteesAt(roster.cells, cell, head.position, () => true) ?? []).includes(device.writer);
    const holder = forMember === undefined ? {} : { holdsMember: forMember };
    const all = grantPlans(shared, roster, { clearance, ...holder }, cells, gate, position);
    if (isResult(all)) return all;
    const plans = checked.resume ? all.filter((plan) => !has(plan.cell)) : all;
    const stored = await writeGrants(shared, roster, plans, device, admitted);
    if (stored !== undefined) return stored;
    // The roster has recorded the invitation's outcome: the join secret is no longer needed (P-31-28).
    await forgetJoinSecret(deps.secrets, id);
    const cleared = all.map((plan) => plan.cell);
    let welcome: string;
    let missing: number;
    try {
      const made = await project.welcomeFor(device.writer, cleared);
      missing = missingCells(made.grants, cleared);
      welcome = JSON.stringify(made);
    } catch {
      return { ...refuse('welcome-too-large'), member };
    }
    const who = forMember === undefined ? record.name : `${record.name}'s other computer`;
    return done(`${finishedNote(finished)}${who} was admitted. Send them the welcome file any way you like; when they open it, the project opens on their computer.${missingNote(missing)}`, {
      file: { name: `welcome-${id}${WELCOME_FILE_EXTENSION}`, text: welcome }, safetyWords: checked.safetyWords, granted: plans.map((plan) => plan.cell),
      invite: id, member, writer: device.writer
    });
  });
}

/** How many of the cleared cells have no grant in the welcome (a grant file that did not read was left out of it, MJ-02). */
function missingCells(grants: readonly unknown[], cleared: readonly string[]): number {
  const carried = new Set<string>();
  for (const grant of grants) {
    const read = readGrant(grant);
    if (read.ok) carried.add(read.grant.cell);
  }
  return cleared.filter((cell) => !carried.has(cell)).length;
}

function missingNote(missing: number): string {
  if (missing === 0) return '';
  return ` ${missing === 1 ? 'One part' : `${missing} parts`} of the project they are cleared for could not be put in the welcome file, because its key file on this computer does not read. They can open the project, and that part reaches them once it is given to them again.`;
}

/**
 * Makes the welcome file again for a device its invitation already admitted (MJ-02): the welcome of the first admission was lost, never saved, or
 * failed to build. Nothing is written: the device is in the roster and holds its grants, and the welcome carries only grants every wrap of which names
 * that device, so it is of use on that device only. Any device of the lead or the deputy may do it, and no join secret is needed. A request for an
 * invitation that admitted nobody yet is refused not-admitted-yet.
 */
export function remakeWelcome(shared: SharedProjectHost, requestText: unknown): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
    const head = headOf(roster);
    if (!isRosterWriterAt(roster, project.deviceWriter, head.position)) return refuse('not-a-roster-writer');
    const checked = await checkRequest(shared, roster, requestText);
    if (isResult(checked)) return checked;
    if (!checked.resume) return refuse('not-admitted-yet');
    const id = checked.invite.invite;
    const record = roster.members.invites.get(id);
    if (record?.usedBy === undefined) return refuse('not-admitted-yet');
    let welcome: string;
    try {
      welcome = JSON.stringify(await project.welcomeFor(checked.writer, [...roster.cells.cells.keys()].sort()));
    } catch {
      return refuse('welcome-too-large');
    }
    const who = record.forMember === undefined ? record.name : `${record.name}'s other computer`;
    return done(`The welcome file for ${who} was made again. Send it to them any way you like; when they open it, the project opens on their computer.`, {
      file: { name: `welcome-${id}${WELCOME_FILE_EXTENSION}`, text: welcome }, invite: id, member: record.usedBy, writer: checked.writer
    });
  });
}

// ---- remove, revoke and change: rekey (D-23) -----------------------------------------------------------------------------------------------------

export interface RekeyOutcome { rekeyed: string[]; skipped: string[] }

/**
 * The rekey plans for a change, computed before the change is written: the grantees of each cell at the current head, and who is cleared once the
 * change applies. A labelled cell whose label this device cannot read cannot be rekeyed here (MN-05): a change touching a device on such a cell is
 * refused no-grant-key before anything is written, and a cell the change does not touch keeps its grantees and needs no new key.
 */
export function rekeyPlans(shared: SharedProjectHost, roster: RosterState, change: { kind: RekeyReason; writers: readonly string[] }, after: Change, gate: Gate): { plans: RekeyPlan[]; cells: Map<string, CellInfo> } | MembershipResult {
  const head = headOf(roster);
  const infos = cellsAt(roster, shared.project.keys, head.position, gate.scales);
  const cells: Array<{ cell: string; grantees: readonly string[]; clearedNow: readonly string[] }> = [];
  for (const info of infos) {
    const grantees = granteesAt(roster.cells, info.cell, head.position, (writer) => deviceAt(roster.members, writer, head.position) !== undefined) ?? [];
    if (!info.known) {
      // A cell whose label this computer cannot read cannot be moved to a new key here: its new epoch would carry no label, so nobody admitted later
      // could be judged cleared for it (MN-05). A clearance change for a device on it cannot be judged, and a removal or revocation that would write
      // a new epoch for it is refused, both before anything is written; the computer that can read the cell's label makes the change.
      const touched = change.writers.some((writer) => grantees.includes(writer));
      if (touched && after.clearance !== undefined) return refuse('no-grant-key');
      const clearedNow = grantees.filter((writer) => after.without?.has(writer) !== true);
      // A cell nobody else is left on gets no new epoch at all, so no label is lost: only a rekey that would be written is refused.
      if (touched && clearedNow.length > 0) return refuse('no-grant-key');
      cells.push({ cell: info.cell, grantees, clearedNow });
      continue;
    }
    cells.push({ cell: info.cell, grantees, clearedNow: clearedDevices(roster, info, head.position, gate, after) });
  }
  return { plans: planRekey({ change, cells }), cells: new Map(infos.map((info) => [info.cell, info])) };
}

/** Writes one cell.rekey per plan with recipients, each with its founding grant wrapped only to them (D-23, D-44). A plan with nobody left is not written. */
export async function writeRekeys(shared: SharedProjectHost, plans: readonly RekeyPlan[], cells: ReadonlyMap<string, CellInfo>): Promise<RekeyOutcome | MembershipResult> {
  const { project } = shared;
  const rekeyed: string[] = [];
  const skipped: string[] = [];
  let awaitingKeys = false;
  for (const plan of plans) {
    if (plan.recipients.length === 0) {
      skipped.push(plan.cell);
      continue;
    }
    const { roster } = await project.state();
    const head = headOf(roster);
    const current = epochAt(roster.cells, plan.cell, head.position);
    if (current === undefined) return refused('cell-unknown', CELL_REFUSALS['cell-unknown']);
    const epoch = current + 1;
    const info = cells.get(plan.cell) as CellInfo;
    // Never a new epoch without its label (MN-05): a labelled cell whose label this computer cannot read is not rekeyed here.
    if (!info.base && info.raw === undefined) return refuse('no-grant-key');
    const key = newEpochKey();
    const grant = newEpochGrant(roster, { cell: plan.cell, info, epoch, key, recipients: plan.recipients, routing: shared.routing, labelSealed: info.base || info.raw === undefined ? '' : sealLabel(key, plan.cell, epoch, info.raw) });
    if (grant === 'switch-first') return refused('switch-first', SWITCH_FIRST_TEXT);
    if (grant === undefined) {
      awaitingKeys = true;
      continue;
    }
    const pages = await project.signGrantPages(grant), founding = pages[0]; // signed as the device the roster names (the person key when hosted)
    // The key and the founding grant are kept before the entry that commits to them, so a crash never leaves an epoch nobody can open. The key is
    // kept with its grant's hash: if the entry is not written, the next rekey of the cell makes another key for the same epoch, and the ring takes
    // the one whose grant the roster commits to (MJ-04).
    await project.keys.addOwn(plan.cell, epoch, key, grantHash(founding));
    const stored = await project.putGrants(pages);
    if (isProjectRefused(stored)) return fromProject(stored);
    const written = await append(shared, 'cell.rekey', { cell: plan.cell, epoch, reason: plan.reason, grant: grantHash(founding) }, head.hash);
    if (isResult(written)) return written;
    rekeyed.push(plan.cell);
  }
  return awaitingKeys ? refuse('rekey-awaiting-keys') : { rekeyed, skipped };
}

function rekeyMessage(first: string, outcome: RekeyOutcome): string {
  const moved = outcome.rekeyed.length === 0 ? '' : ` ${outcome.rekeyed.length === 1 ? 'One part of the project was' : `${outcome.rekeyed.length} parts of the project were`} moved to a new key. ${REKEY_VERIFIED_TEXT}`;
  const left = outcome.skipped.length === 0 ? '' : ` Nobody else is on ${outcome.skipped.length === 1 ? 'one part' : `${outcome.skipped.length} parts`} of the project, so no new key was made for ${outcome.skipped.length === 1 ? 'it' : 'them'}.`;
  return `${first}${moved}${left} ${REKEY_KEEP_TEXT}`;
}

/** A diagnostic for a later step cannot guarantee that an earlier write changed nothing. */
function diagnosticAfterWrite(message: string): string {
  return message.replace(/, so nothing was changed\.|\. Nothing was changed\./g, '.');
}

/** A key operation failed after the roster change was already recorded. Keep the underlying refusal scoped to that later step. */
export function withPendingRekeyMessage(result: MembershipResult, recorded: string): MembershipResult {
  const cause = result.message === MEMBERSHIP_REFUSALS['no-grant-key']
    ? 'This computer does not hold every key needed to finish. Finish on the staff lead\'s computer that holds the project\'s keys.'
    : diagnosticAfterWrite(result.message);
  return { ...result, message: `${recorded} This computer could not verify all the required new keys. ${REKEY_PENDING_TEXT} ${cause}` };
}

/**
 * The cells that still need a new key, computed from the roster at the head (MJ-03): a cell whose current key is held by a device that is no longer
 * admitted, or by a person device whose member is no longer cleared for it (by the host's clearance check, as at write time, D-22), and on which
 * someone cleared is left. The recipients are the admitted holders that are still cleared. A cell whose label this device cannot read is judged on
 * removals only. A cell nobody cleared is left on needs nothing: nobody receives anything new in it.
 */
function pendingRekeys(shared: SharedProjectHost, roster: RosterState, gate: Gate): { plans: RekeyPlan[]; cells: Map<string, CellInfo> } {
  const head = headOf(roster);
  const admitted = (writer: string): boolean => deviceAt(roster.members, writer, head.position) !== undefined;
  const infos = cellsAt(roster, shared.project.keys, head.position, gate.scales);
  const plans: RekeyPlan[] = [];
  for (const info of infos) {
    const holders = granteesAt(roster.cells, info.cell, head.position, () => true);
    if (holders === undefined) continue;
    const gone = holders.filter((writer) => !admitted(writer));
    const live = holders.filter(admitted);
    const cleared = info.known ? new Set(clearedDevices(roster, info, head.position, gate)) : undefined;
    const uncleared = cleared === undefined ? [] : live.filter((writer) => !cleared.has(writer) && deviceAt(roster.members, writer, head.position)?.kind === 'person');
    if (gone.length === 0 && uncleared.length === 0) continue;
    const recipients = live.filter((writer) => !uncleared.includes(writer));
    if (recipients.length === 0) continue;
    const reason = gone.length > 0 ? leftReason(roster, gone, head.position) : 'clearance-lowered';
    plans.push({ cell: info.cell, reason, recipients, dropped: [...gone, ...uncleared].sort(), text: REKEY_KEEP_TEXT });
  }
  return { plans, cells: new Map(infos.map((info) => [info.cell, info])) };
}

async function finishPending(shared: SharedProjectHost, initial?: RosterState): Promise<RekeyOutcome | MembershipResult> {
  const roster = initial ?? (await shared.project.state()).roster;
  const problem = writerProblem(shared, roster);
  if (problem !== undefined) return problem;
  const pending = pendingRekeys(shared, roster, gateOf(shared));
  if (pending.plans.length === 0) return { rekeyed: [], skipped: [] };
  return writeRekeys(shared, pending.plans, pending.cells);
}

function finishedNote(outcome: RekeyOutcome): string {
  const count = outcome.rekeyed.length;
  if (count === 0) return '';
  return `A removal or clearance change left unfinished was finished first: ${count === 1 ? 'one part of the project was' : `${count} parts of the project were`} moved to a new key. `;
}

export async function unfinishedRekeys(shared: SharedProjectHost): Promise<number> {
  try {
    const { roster } = await shared.project.state();
    if (writerProblem(shared, roster) !== undefined) return 0;
    return roster.requiredFrom.has(CELL_ACCESS_FEATURE) ? [...roster.accessGrants.values()].filter(({ decision }) => decision === 'pending').length :
      pendingRekeys(shared, roster, gateOf(shared)).plans.length;
  } catch (error) {
    if (error instanceof ReplicaProjectError) return 0;
    throw error;
  }
}

/** Finish an interrupted key change from its selected managed state or the legacy roster. */
export function finishRekeys(shared: SharedProjectHost): Promise<MembershipResult> {
  return guarded(async () => {
    const { roster } = await shared.project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const outcome = roster.requiredFrom.has(CELL_ACCESS_FEATURE) ?
      await finishManagedRekeys(shared.project, roster, (fresh, cell) => cellsAt(fresh, shared.project.keys, headOf(fresh).position, gateOf(shared).scales)
        .find((info) => info.cell === cell), shared.routing, () => now(shared.deps)) :
      await finishPending(shared, roster);
    if (isProjectRefused(outcome)) return fromProject(outcome);
    if ('ok' in outcome) {
      if ('message' in outcome) return outcome;
      if (outcome.reason === 'switch-first') return refused(outcome.reason, SWITCH_FIRST_TEXT);
      if (outcome.reason === 'change-not-applied') return refused(outcome.reason, 'The shared history changed while the key change was prepared. Try again.');
      return Object.hasOwn(PROJECT_REFUSALS_HOST, outcome.reason) ?
        refused(outcome.reason, PROJECT_REFUSALS_HOST[outcome.reason as keyof typeof PROJECT_REFUSALS_HOST]) : refuse(outcome.reason as MembershipRefusal);
    }
    if (outcome.rekeyed.length + outcome.skipped.length === 0) return refuse('nothing-to-finish');
    return done(rekeyMessage('The removal or clearance change left unfinished is now finished.', outcome), { rekeyed: outcome.rekeyed });
  });
}

export type RemoveInput = { member: string } | { member: string; writer: string };

export function removeFromProject(shared: SharedProjectHost, input: RemoveInput, action?: string): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const initial = (await project.state()).roster;
    if (initial.requiredFrom.has(CELL_ACCESS_FEATURE)) {
      const result = await appendManagedWithdrawal(project, initial, input, now(shared.deps), action);
      if (isProjectRefused(result)) return fromProject(result);
      if (!result.ok) return refused(result.reason, result.reason === 'no-grant-key' ? MEMBERSHIP_REFUSALS['no-grant-key'] :
        result.reason === 'change-not-applied' ? 'The shared history changed while this removal was prepared. Try again.' : PROJECT_REFUSALS_HOST[result.reason]);
      return done('Access was withdrawn. Parts awaiting a new key will stay read only.', { member: input.member, ...('writer' in input ? { writer: input.writer } : {}) });
    }
    const finished = await finishPending(shared, initial);
    if (isResult(finished)) return finished;
    const { roster } = await project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const head = headOf(roster);
    const record = memberAt(roster.members, input.member, head.position);
    // Earlier recovery may have been for a different member. Report the recovery separately.
    if (record === undefined && finished.rekeyed.length > 0) return done(
      'The requested member is already absent from the project. An earlier key change left unfinished is now finished.', { rekeyed: finished.rekeyed });
    if (record === undefined) return refuse('member-unknown');
    const lead = leadAt(roster, head.position);
    const gate = gateOf(shared);
    const devices = devicesOfMemberAt(roster.members, input.member, head.position);
    let writers: string[];
    let kind: RekeyReason;
    let entry: { kind: string; data: Record<string, unknown> };
    if ('writer' in input) {
      if (!devices.some((device) => device.writer === input.writer)) return refuse('device-unknown');
      if (input.member === lead && devices.filter((device) => device.kind === 'person').length <= 1) {
        const signer = deviceAt(roster.members, project.deviceWriter, head.position)?.member;
        if (signer === undefined || signer !== deputyAt(roster, head.position)) return refused('last-lead-device', MEMBER_REFUSALS['last-lead-device']);
      }
      writers = [input.writer];
      kind = 'device-revoked';
      entry = { kind: 'device.revoke', data: { member: input.member, writer: input.writer } };
    } else {
      if (input.member === lead) return refused('lead-not-removable', MEMBER_REFUSALS['lead-not-removable']);
      writers = devices.map((device) => device.writer);
      kind = 'member-removed';
      entry = { kind: 'member.remove', data: { member: input.member } };
    }
    const planned = rekeyPlans(shared, roster, { kind, writers }, { without: new Set(writers) }, gate);
    if (isResult(planned)) return planned;
    const written = await append(shared, entry.kind, entry.data, undefined, 'report-saved');
    if (isResult(written)) return written;
    const outcome = await guarded(() => writeRekeys(shared, planned.plans, planned.cells));
    if (isResult(outcome)) return withPendingRekeyMessage(outcome, 'The removal was recorded.');
    const first = 'writer' in input ? `That device of ${record.name} was removed from the project.` : `${record.name} was removed from the project.`;
    return done(`${finishedNote(finished)}${rekeyMessage(first, outcome)}`, { rekeyed: [...finished.rekeyed, ...outcome.rekeyed], member: input.member, ...('writer' in input ? { writer: input.writer } : {}) });
  });
}

export interface UpdateMemberInput { member: string; name?: string; seat?: string; roles?: string[]; clearance?: unknown; agentSeats?: string[] }

export function updateMember(shared: SharedProjectHost, input: UpdateMemberInput): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const initial = (await project.state()).roster;
    const managed = initial.requiredFrom.has(CELL_ACCESS_FEATURE);
    const finished = managed ? { rekeyed: [], skipped: [] } : await finishPending(shared, initial);
    if (isResult(finished)) return finished;
    const roster = managed ? initial : (await project.state()).roster;
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const head = headOf(roster);
    const record = memberAt(roster.members, input.member, head.position);
    if (record === undefined) return refuse('member-unknown');
    if (input.roles?.some((role) => LEAD_ROLES.includes(role)) === true) return refused('lead-role-by-handover-only', MEMBER_REFUSALS['lead-role-by-handover-only']);
    const data: Record<string, unknown> = { member: input.member };
    for (const field of ['name', 'seat', 'roles', 'clearance', 'agentSeats'] as const) if (input[field] !== undefined) data[field] = input[field];
    if (Object.keys(data).length === 1) return refuse('nothing-to-change');
    const gate = gateOf(shared);
    const devices = devicesOfMemberAt(roster.members, input.member, head.position).filter((device) => device.kind === 'person');
    const changesClearance = input.clearance !== undefined;
    if (managed && changesClearance) {
      const result = await appendManagedClearance(project, roster, data, { context: gate.context,
        cells: cellsAt(roster, project.keys, head.position, gate.scales),
        cleared: (value, info, held, privileged) => clearedFor(value, info, held, gate, privileged) });
      if (isProjectRefused(result)) return fromProject(result);
      if (!result.ok) {
        if (result.reason === 'clearance-grants-pending') return refused(result.reason, 'This clearance change would give access to more parts of the project. It needs managed key delivery before it can apply.');
        if (result.reason === 'change-not-applied') return refused(result.reason, 'The shared history changed while this change was prepared. Try again.');
        return refused(result.reason, result.reason === 'no-grant-key' ? MEMBERSHIP_REFUSALS['no-grant-key'] : PROJECT_REFUSALS_HOST[result.reason]);
      }
      return done('The clearance changed. Parts awaiting a new key will stay read only.', { member: input.member, rekeyed: [], granted: [] });
    }
    const planned = changesClearance
      ? rekeyPlans(shared, roster, { kind: 'clearance-lowered', writers: devices.map((device) => device.writer) }, { clearance: { member: input.member, value: input.clearance } }, gate)
      : { plans: [] as RekeyPlan[], cells: new Map<string, CellInfo>() };
    if (isResult(planned)) return planned;
    if (planned.plans.some((plan) => awaitsHybridRecipients(roster, planned.cells.get(plan.cell) as CellInfo, plan.recipients, shared.routing))) {
      return refused('rekey-awaiting-keys', 'The clearance was not changed. A computer that will keep access must publish compatible encryption keys first.');
    }
    // The cells the member is newly cleared for, and their keys, are checked before anything is written too.
    const raisedCheck = changesClearance ? grantPlans(shared, roster, { clearance: input.clearance }, cellsAt(roster, project.keys, head.position, gate.scales), gate, head.position) : [];
    if (isResult(raisedCheck)) return raisedCheck;
    const written = await append(shared, 'member.update', data, undefined, changesClearance && !managed ? 'report-saved' : undefined);
    if (isResult(written)) return written;
    const needsRotation = planned.plans.some((plan) => plan.recipients.length > 0);
    const granted = new Set<string>();
    const outcome = await guarded(async () => {
      if (changesClearance) {
        const updated = headOf(written.roster);
        const now2 = memberAt(written.roster.members, input.member, updated.position) as MemberRecord;
        const cells = cellsAt(written.roster, project.keys, updated.position, gate.scales);
        for (const device of devices) {
          const holding = (cell: string): boolean => (granteesAt(written.roster.cells, cell, updated.position, () => true) ?? []).includes(device.writer);
          const plans = grantPlans(shared, written.roster, { clearance: now2.clearance }, cells, gate, updated.position, holding);
          if (isResult(plans)) return plans;
          const stored = await writeGrants(shared, written.roster, plans, { writer: device.writer }, written.hash);
          if (stored !== undefined) return stored;
          for (const plan of plans) granted.add(plan.cell);
        }
      }
      return writeRekeys(shared, planned.plans, planned.cells);
    });
    if (isResult(outcome)) {
      if (!changesClearance) return outcome;
      const recorded = 'The clearance change was recorded.';
      if (needsRotation) return withPendingRekeyMessage(outcome, recorded);
      return { ...outcome, message: `${recorded} This computer could not finish giving keys for the newly cleared parts. ${diagnosticAfterWrite(outcome.message)}` };
    }
    const first = `${input.name ?? record.name} was changed.`;
    const gave = granted.size === 0 ? '' : ` ${granted.size === 1 ? 'One part of the project was' : `${granted.size} parts of the project were`} shared with them.`;
    const message = outcome.rekeyed.length > 0 || outcome.skipped.length > 0 ? rekeyMessage(`${first}${gave}`, outcome) : `${first}${gave}`;
    return done(`${finishedNote(finished)}${message}`, { rekeyed: [...finished.rekeyed, ...outcome.rekeyed], granted: [...granted].sort(), member: input.member });
  });
}

// ---- roster authority: choose, deputy, handover (D-09, D-10) -------------------------------------------------------------------------------------

/**
 * Chooses one branch of a roster split (D-09): the lead, or the deputy when the lead has no active device, writes roster.choose naming it. Anyone
 * else is refused not-a-roster-writer and nothing is written.
 */
export function chooseRosterBranch(shared: SharedProjectHost, branch: string): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
    const head = headOf(roster);
    if (!isRosterWriterAt(roster, project.deviceWriter, head.position)) return refuse('not-a-roster-writer');
    const split = roster.pending.find((item) => item.at === head.hash) ?? roster.pending[0];
    if (split === undefined) return refuse('no-split');
    if (!split.branches.includes(branch)) return refuse('not-a-branch');
    const at = roster.positionOf.get(split.at) as number;
    const signer = deviceAt(roster.members, project.deviceWriter, at)?.member;
    const lead = leadAt(roster, at);
    const leadless = lead === undefined || devicesOfMemberAt(roster.members, lead, at).length === 0;
    if (signer !== lead && !(signer === deputyAt(roster, at) && leadless)) return refused('choose-not-allowed', ROSTER_REFUSALS['choose-not-allowed']);
    const written = await project.appendOwn('roster.choose', { chosen: branch, rosterPrev: split.at }, { roster: split.at });
    if (isProjectRefused(written)) return fromProject(written);
    const after = await project.state();
    if (!after.roster.choices.some((choice) => choice.choose === written.hash)) {
      const found = after.roster.refused.find((item) => item.hash === written.hash);
      return found === undefined ? refuse('change-not-applied') : refused(found.reason, foldMessage(found.reason));
    }
    return done('The roster branch was chosen. The other change at the same point stays unapplied.');
  });
}

/** One branch of a roster split as the lead sees it (MN-03): what the change does, who wrote it and when, by the change's own signed fields. */
export interface RosterBranchView { branch: string; summary: string; by?: string; at?: string }

/** A plain sentence for what a roster change does, with the names the roster had at the split point. */
function branchSummary(kind: string, data: unknown, nameOf: (member: string) => string): string {
  const field = (key: string): string | undefined => (isRecord(data) && typeof data[key] === 'string' ? data[key] as string : undefined);
  const member = field('member');
  const who = member === undefined ? 'a member' : nameOf(member);
  switch (kind) {
    case 'member.invite': return field('forMember') === undefined ? `Invites ${field('name') ?? 'a person'}` : `Invites another computer of ${nameOf(field('forMember') as string)}`;
    case 'member.admit': return `Admits ${field('name') ?? 'a person'}`;
    case 'member.update': return `Changes the details of ${who}`;
    case 'member.remove': return `Removes ${who}`;
    case 'device.add': return `Adds a computer of ${who}`;
    case 'device.revoke': return `Removes a computer of ${who}`;
    case 'invite.void': return 'Cancels an invitation';
    case 'cell.create': return 'Adds a part of the project';
    case 'cell.rekey': return 'Moves a part of the project to a new key';
    case 'lead.handover': return `Hands the staff lead to ${field('to') === undefined ? 'a member' : nameOf(field('to') as string)}`;
    case 'deputy.name': return `Names ${who} deputy lead`;
    default: return 'Changes the roster';
  }
}

const WRITER_LINE_FILE = /^[0-9a-f]{64}\.jsonl$/;

/**
 * The roster entries with the given hashes, read straight from the store's line files of the base stream, streams/<project id>/<writer>.jsonl
 * (D-08). Read only: nothing is written, no lock is taken and no welcome file is built. A symbolic link or a non-folder on the way gives nothing;
 * a damaged line is skipped; reading stops once every hash is found. The hashes come from the roster fold, so a line whose header hashes to one of
 * them is that entry.
 */
async function branchEntries(project: ReplicaProject, hashes: readonly string[]): Promise<Map<string, SealedEntry>> {
  const found = new Map<string, SealedEntry>();
  const wanted = new Set(hashes);
  if (wanted.size === 0) return found;
  let folder = project.root;
  for (const part of [...REPLICA_DIR.split('/'), 'streams', project.projectId]) {
    folder = path.join(folder, part);
    try {
      const info = await lstat(folder);
      if (info.isSymbolicLink() || !info.isDirectory()) return found;
    } catch {
      return found;
    }
  }
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => WRITER_LINE_FILE.test(name)).sort();
  } catch {
    return found;
  }
  for (const name of names) {
    await eachRosterLine(path.join(folder, name), (line) => {
      let entry: SealedEntry | undefined;
      try {
        entry = parseSealed(JSON.parse(line) as unknown);
      } catch {
        entry = undefined;
      }
      if (entry === undefined || entry.header.stream !== project.projectId) return false;
      const hash = entryHash(entry.header);
      if (wanted.has(hash) && !found.has(hash)) found.set(hash, entry);
      return found.size === wanted.size;
    });
    if (found.size === wanted.size) break;
  }
  return found;
}

/**
 * The branches of the first roster split, each opened with this device's key and described (MN-03): the kind of change and whom it names, the member
 * whose device wrote it and when it was signed. A branch this device cannot open is described as such. Writes nothing. The two entries are read
 * from the roster's line files (branchEntries), never from a welcome file, so describing a split costs reading those lines (D-08).
 */
export async function describeRosterBranches(shared: SharedProjectHost): Promise<RosterBranchView[]> {
  const { project } = shared;
  const { roster } = await project.state();
  const split = roster.pending[0];
  if (split === undefined) return [];
  const position = roster.positionOf.get(split.at) ?? headOf(roster).position;
  const entries = await branchEntries(project, split.branches);
  const nameOf = (member: string): string => memberAt(roster.members, member, position)?.name ?? member;
  return split.branches.map((branch) => {
    const entry = entries.get(branch);
    const key = entry === undefined ? undefined : project.keys.epochKey(entry.header.stream, entry.header.epoch);
    const plain = entry === undefined || key === undefined ? undefined : openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    let body: unknown;
    try {
      body = plain === undefined ? undefined : JSON.parse(plain.toString('utf8')) as unknown;
    } catch {
      body = undefined;
    }
    if (entry === undefined || !isRecord(body) || typeof body.kind !== 'string') return { branch, summary: 'A roster change this computer cannot read' };
    const by = deviceAt(roster.members, entry.header.writer, position)?.member;
    return { branch, summary: branchSummary(body.kind, body.data, nameOf), ...(by === undefined ? {} : { by: nameOf(by) }), ...(typeof body.at === 'string' ? { at: body.at } : {}) };
  });
}

/**
 * After a deputy.name or lead.handover entry: gives each person device of the member that does not hold it every epoch of each legacy cell (D-20) the
 * member is now cleared for, when this device holds the keys. The grants name that entry's roster while this device is still a roster writer there
 * (naming a deputy), and otherwise the roster the entry cites (a handover: the fold places a grant only from a roster writer at the roster it names).
 * The cells given, sorted; none when this device cannot give them (the role change stands, and a device of the lead or the deputy that holds the keys
 * can give them later).
 */
async function giveLegacy(shared: SharedProjectHost, written: { hash: string; roster: RosterState }, cited: string, member: string): Promise<string[]> {
  const { roster } = written;
  const position = roster.positionOf.get(written.hash);
  if (position === undefined) return [];
  const at = isRosterWriterAt(roster, shared.project.deviceWriter, position) ? written.hash : cited;
  if (roster.positionOf.get(at) === undefined) return [];
  const gate = gateOf(shared);
  const legacy = cellsAt(roster, shared.project.keys, position, gate.scales).filter((info) => info.legacy !== undefined);
  if (legacy.length === 0) return [];
  const record = memberAt(roster.members, member, position);
  if (record === undefined) return [];
  const leadOrDeputy = leadAt(roster, position) === member || deputyAt(roster, position) === member;
  const given = new Set<string>();
  for (const device of devicesOfMemberAt(roster.members, member, position).filter((item) => item.kind === 'person')) {
    const holding = (cell: string): boolean => (granteesAt(roster.cells, cell, position, () => true) ?? []).includes(device.writer);
    const plans = grantPlans(shared, roster, { clearance: record.clearance, holdsMember: member, leadOrDeputy }, legacy, gate, position, holding);
    if (isResult(plans)) continue;
    const stored = await writeGrants(shared, roster, plans, { writer: device.writer }, at);
    if (stored !== undefined) continue;
    for (const plan of plans) given.add(plan.cell);
  }
  return [...given].sort();
}

/** Names the deputy lead (D-10): only the lead may; the deputy is refused with the roster's sentence. */
export function nameDeputy(shared: SharedProjectHost, member: string): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const head = headOf(roster);
    if (deviceAt(roster.members, project.deviceWriter, head.position)?.member !== leadAt(roster, head.position)) return refused('deputy-cannot-name-deputy', ROSTER_REFUSALS['deputy-cannot-name-deputy']);
    const record = memberAt(roster.members, member, head.position);
    if (record === undefined) return refuse('member-unknown');
    if (member === leadAt(roster, head.position)) return refused('names-the-lead', ROSTER_REFUSALS['names-the-lead']);
    const written = await append(shared, 'deputy.name', { member });
    if (isResult(written)) return written;
    const given = await giveLegacy(shared, written, head.hash, member);
    return done(`${record.name} is now the deputy lead.${given.length === 0 ? '' : ` ${LEGACY_GIVEN_TEXT}`}`, { member, ...(given.length === 0 ? {} : { granted: given }) });
  });
}

/**
 * Hands the lead to another member (D-10): the lead may for any reason; the deputy only with reason lead-lost, and a planned handover from the deputy
 * is refused with the roster's sentence.
 */
export function handOverLead(shared: SharedProjectHost, input: { to: string; reason: 'planned' | 'lead-lost' }): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const head = headOf(roster);
    const signer = deviceAt(roster.members, project.deviceWriter, head.position)?.member;
    const lead = leadAt(roster, head.position);
    if (signer !== lead && !(signer === deputyAt(roster, head.position) && input.reason === 'lead-lost')) return refused('handover-not-allowed', ROSTER_REFUSALS['handover-not-allowed']);
    const record = memberAt(roster.members, input.to, head.position);
    if (record === undefined) return refuse('member-unknown');
    if (input.to === lead) return refused('names-the-lead', ROSTER_REFUSALS['names-the-lead']);
    const written = await append(shared, 'lead.handover', { to: input.to, reason: input.reason });
    if (isResult(written)) return written;
    const given = await giveLegacy(shared, written, head.hash, input.to);
    return done(`${record.name} is now the staff lead.${given.length === 0 ? '' : ` ${LEGACY_GIVEN_TEXT}`}`, { member: input.to, ...(given.length === 0 ? {} : { granted: given }) });
  });
}

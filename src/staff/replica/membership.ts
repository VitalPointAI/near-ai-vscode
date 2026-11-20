// Who is in a multi-user staff project, and how they get in and out (D-09, D-10, D-13 to D-18, D-22, D-23, D-37, D-45). The host flows behind the
// roster commands; the commands (31-23) only show dialogs and call these. Node I/O through ReplicaProject and keyring.ts only; never imports vscode.
//
// The flows, as the person sees them:
//   lead:    inviteToProject -> (sends the .near-staff-invite file any way they like)
//   joiner:  joinFromInvite  -> (sends the .near-staff-join file back, reads the six words aloud)
//   lead:    reviewJoinRequest (shows the six words) -> admitJoinRequest { codeMatched: true } -> (sends the .near-staff-welcome file)
//   joiner:  openWelcome     -> the project opens on the joiner's computer
// Add My Other Machine is the same flow with a short invitation for an existing member (addMyOtherMachine), admitted as device.add. An invitation that
// is no longer wanted is closed with voidInvite.
//
// The invitation's state machine (the roster fold is the authority; these flows refuse before they write so a person is told plainly):
//   open --admit or device.add--> used        open --invite.void--> voided        open --signed time past expiresAt--> expired (refused at use)
// The join secret lives in this computer's secret storage from the invitation until a roster entry records its outcome (used or voided), and is then
// forgotten (P-31-28). Nothing else is ever deleted.
//
// Clearance is decided here, by the writing host at write time (D-22, 31-RESEARCH.md): a cell's label is opened from its grant with the epoch key this
// device holds and compared with the member's declared clearance by Phase 70 dominance, with the host clock and the project's scale table. The fold
// never recomputes it; the signed grant is the authority. Removing a member or a device, or lowering a clearance, moves every affected cell to a new
// key wrapped only to the devices still cleared (D-23), and the result says so in the agreed words.
//
// No result, message, file name or error holds a join secret, a MAC or a key (P-31-23). The invitation file holds the secret by design, inside its
// signed payload, and the join request file holds the MAC by design; nothing else does.
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { dominates } from '../../domain/gate/dominance';
import type { DominanceContext } from '../../domain/gate/dominance';
import { SCALE_PRESETS, parseClearance, parseLabel } from '../../domain/gate/labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from '../../domain/gate/labels';
import { REKEY_KEEP_TEXT, buildGrant, earlierEpochGrants, grantHash, newEpochKey, openLabel, planRekey, sealLabel, wrapEpochKey } from '../../domain/replica/cellKeys';
import type { RekeyPlan, RekeyReason } from '../../domain/replica/cellKeys';
import {
  INVITE_FILE_EXTENSION, INVITE_REFUSALS, JOIN_REQUEST_FILE_EXTENSION, WELCOME_FILE_EXTENSION, buildInvite, buildJoinRequest, checkJoinRequest,
  inviteAnchor, inviteSafetyCode, joinSecretHash, newJoinSecret, readInvite
} from '../../domain/replica/invite';
import type { InvitePayload, InviteRefusal, JoinRequestPayload } from '../../domain/replica/invite';
import type { ProjectOutput } from '../../domain/replica/projectFold';
import { ROSTER_REFUSALS, ROSTER_SPLIT_TEXT, deputyAt, isRosterWriterAt, leadAt } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { CELL_REFUSALS, epochAt, epochsAt, granteesAt } from '../../domain/replica/rosterCells';
import { MEMBER_REFUSALS, deviceAt, devicesOfMemberAt, hubCellsAt, inviteAt, memberAt, x25519At } from '../../domain/replica/rosterMembers';
import type { MemberRecord } from '../../domain/replica/rosterMembers';
import type { ReplicaContext } from '../../domain/replica/rosterView';
import { MAX_SLOT } from '../../domain/replica/clientIds';
import { isRecord } from '../../domain/team/validate';
import { MULTI_USER_DECLARED_TEXT, multiUserNoticeLines } from '../../domain/staff/multiUser';
import { readWhole } from '../staffFiles';
import { forgetJoinSecret, joinSecret, storeJoinSecret } from './keyring';
import type { DeviceKeyRing } from './keyring';
import { PROJECT_REFUSALS_HOST, ReplicaProject, ReplicaProjectError, anchorOf, isProjectRefused, projectFile } from './replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from './replicaProject';

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
  'no-join-secret': 'This computer does not hold the secret of that invitation, so the join request cannot be checked here and nobody was admitted. Admit the person on the computer that made the invitation.',
  'not-founding-device': 'Invitations are made on the computer that created this shared project, so no invitation was made. Make the invitation there.',
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
const headOf = (roster: RosterState): { hash: string; position: number } => ({ hash: roster.positions[roster.positions.length - 1], position: roster.positions.length - 1 });

/** Runs a flow, turning a store refusal on refresh into a plain result instead of an exception. */
async function guarded<T extends MembershipResult>(work: () => Promise<T>): Promise<T | MembershipResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReplicaProjectError) return fromProject(error.refusal);
    throw error;
  }
}

// ---- clearance at write time (D-22) --------------------------------------------------------------------------------------------------------------

interface CellInfo {
  cell: string;
  base: boolean;
  /** The label read from a grant this device can open; undefined for the base cell or when it cannot be read here. */
  label?: Label;
  /** The label as sealed, to seal again into new grants. */
  raw?: unknown;
  /** False for a labelled cell whose label this device cannot open: nobody is counted cleared for it here (fail closed). */
  known: boolean;
}

/** The label of a cell, opened from any grant of it this device holds the epoch key for. Undefined when none opens. */
function cellLabel(roster: RosterState, keys: DeviceKeyRing, cell: string, scales: ScaleTable): { label: Label; raw: unknown } | undefined {
  const record = roster.cells.cells.get(cell);
  if (record === undefined) return undefined;
  const grants = [...record.grants].sort((a, b) => b.epoch - a.epoch);
  for (const grant of grants) {
    if (grant.grant.labelSealed === '') continue;
    const key = keys.epochKey(cell, grant.epoch);
    if (key === undefined) continue;
    const raw = openLabel(key, cell, grant.epoch, grant.grant.labelSealed);
    const parsed = raw === undefined ? undefined : parseLabel(raw, scales);
    if (parsed !== undefined && parsed.ok) return { label: parsed.value, raw };
  }
  return undefined;
}

/** Every cell the roster has at the position, with its label as this device can read it. */
function cellsAt(roster: RosterState, keys: DeviceKeyRing, position: number, scales: ScaleTable): CellInfo[] {
  const project = roster.anchor.project;
  const cells: CellInfo[] = [];
  for (const cell of [...roster.cells.cells.keys()].sort()) {
    if (epochAt(roster.cells, cell, position) === undefined) continue;
    if (cell === project) {
      cells.push({ cell, base: true, known: true });
      continue;
    }
    const label = cellLabel(roster, keys, cell, scales);
    cells.push(label === undefined ? { cell, base: false, known: false } : { cell, base: false, label: label.label, raw: label.raw, known: true });
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

interface Gate { scales: ScaleTable; context: DominanceContext }

function gateOf(shared: SharedProjectHost): Gate {
  const scales = shared.scales ?? SCALE_PRESETS;
  return { scales, context: { scales, mappings: shared.mappings ?? [], now: now(shared.deps).getTime() } };
}

/**
 * Is the member cleared for the cell? Every member is on the base cell. A labelled cell this device cannot read clears nobody. A member with a
 * declared clearance is cleared when it dominates the label (Phase 70, all five conditions). A member with no declared clearance (only the founding
 * lead, whose genesis names none) is cleared for the cells one of its devices already holds, so the lead is never dropped from a cell it founded.
 */
function clearedFor(clearance: unknown, info: CellInfo, holds: boolean, gate: Gate): boolean {
  if (info.base) return true;
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
interface Change { without?: ReadonlySet<string>; clearance?: { member: string; value: unknown } }

/** The devices cleared for the cell at the position, after the change: person devices of cleared members, and hub devices granted the cell. */
function clearedDevices(roster: RosterState, info: CellInfo, position: number, gate: Gate, change: Change = {}): string[] {
  const writers: string[] = [];
  for (const versions of roster.members.devices.values()) {
    const device = versions.find((record) => record.from <= position && (record.until === undefined || position < record.until));
    if (device === undefined || change.without?.has(device.writer)) continue;
    if (device.kind === 'hub') {
      if (hubCellsAt(roster.members, device.member, position)?.includes(info.cell) === true) writers.push(device.writer);
      continue;
    }
    const record = memberAt(roster.members, device.member, position);
    if (record === undefined) continue;
    const clearance = change.clearance?.member === record.member ? change.clearance.value : record.clearance;
    if (clearedFor(clearance, info, memberHolds(roster, record.member, info.cell, position), gate)) writers.push(device.writer);
  }
  return writers.sort();
}

/**
 * The cell order the fold checks writes against (D-25), for ReplicaProjectDeps.cellOrder: an entry in one cell may cite an entry in another only when
 * the citing cell's label dominates the cited one's, by Phase 70 rules with the host clock and the given scales. The base cell is the lowest: every
 * cell may cite it and it may cite no labelled cell. A cell whose label this device cannot read answers no (fail closed).
 */
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
      if (from === null || from === undefined || to === undefined) return false;
      return dominates({ scale: from.scale, level: from.level, compartments: from.compartments, releasability: from.releasability }, to, context);
    };
  };
}

// ---- the writer's checks and the roster's answer -------------------------------------------------------------------------------------------------

/** The refusal for a roster change this device cannot make now, or undefined. */
function writerProblem(shared: SharedProjectHost, roster: RosterState): MembershipResult | undefined {
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

async function append(shared: SharedProjectHost, kind: string, data: unknown, roster?: string): Promise<{ hash: string; roster: RosterState } | MembershipResult> {
  const written = await shared.project.appendOwn(kind, data, roster === undefined ? {} : { roster });
  if (isProjectRefused(written)) return fromProject(written);
  const outcome = await applied(shared, written.hash);
  return 'roster' in outcome ? { hash: written.hash, roster: outcome.roster } : outcome;
}

const isResult = (value: unknown): value is MembershipResult => isRecord(value) && typeof value.ok === 'boolean' && typeof value.message === 'string';

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
  // The joining device pins the lead named in the invitation, and the invitation names the device that signs it, so only the device that founded
  // the project can make one a joiner can use (31-16 invite format).
  if (project.deviceWriter !== project.anchor.lead.writer) return refuse('not-founding-device');
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
  const signed = buildInvite(project.signer, {
    genesisHash: project.anchor.genesisHash, project: project.projectId, name: projectName(fold, project.projectId),
    lead: { member: project.anchor.lead.member, x25519: project.anchor.lead.x25519 }, invite, secret, expiresAt, now: at,
    ...(input.forMember === undefined ? {} : { forMember: input.forMember })
  });
  const when = expiresAt.slice(0, 10);
  const what = input.forMember === undefined ? `The invitation for ${input.name} is ready.` : `The invitation for ${input.name}'s other computer is ready.`;
  return done(`${what} Send the file to them any way you like. It works once and expires on ${when}. When their join request comes back, compare the six words with them out loud or in person before you admit them.`, {
    file: { name: `${invite}${INVITE_FILE_EXTENSION}`, text: JSON.stringify(signed) }, invite
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

/**
 * The joining person's side (D-15, D-16): reads the invitation, refuses a folder that holds another staff project, pins the project's genesis on this
 * computer, makes or reuses this install's keys, and returns the signed .near-staff-join file and the six words to read to the lead.
 */
export async function joinFromInvite(root: string, deps: ReplicaProjectDeps, inviteText: unknown, input: JoinInput): Promise<MembershipResult> {
  const read = readInvite(inviteText, now(deps));
  if (!read.ok) return fromInvite(read.reason);
  const invite = read.invite;
  if (await folderHasOtherProject(root, invite.project)) return refuse('folder-has-staff-project');
  const pinned = await ReplicaProject.pinAnchor(deps, inviteAnchor(invite));
  if (isProjectRefused(pinned)) return fromProject(pinned);
  const device = await ReplicaProject.localDevice(deps);
  const request = buildJoinRequest(device.signer, invite, { name: input.name, x25519: device.x25519, now: now(deps) });
  const safetyWords = inviteSafetyCode(invite, { publicKey: device.publicKey, x25519: device.x25519 });
  const where = invite.forMember === undefined ? `to join ${invite.name}` : `to add this computer to ${invite.name}`;
  return done(`Your request ${where} is ready. Send the file back to the staff lead any way you like, then read these six words to them out loud or in person: ${safetyWords.join(' ')}. They admit you only if the words match.`, {
    file: { name: `join-${invite.invite}${JOIN_REQUEST_FILE_EXTENSION}`, text: JSON.stringify(request) }, safetyWords, invite: invite.invite, writer: device.writer
  });
}

/**
 * The joining person's last step: opens the .near-staff-welcome file the lead returned, against the genesis this computer pinned from the
 * invitation, and joins the shared project in `root`. The result carries the opened project, which the caller closes.
 */
export async function openWelcome(root: string, deps: ReplicaProjectDeps, welcomeText: unknown): Promise<OpenWelcomeResult> {
  for (const ledger of TODAY_LEDGERS) if (await exists(path.join(path.resolve(root), ...ledger.split('/')))) return refuse('folder-has-staff-project');
  const joined = await ReplicaProject.joinFromWelcome(root, deps, welcomeText);
  if (isProjectRefused(joined)) return joined.refused === 'pin-mismatch' && (await exists(projectFile(root))) ? refuse('folder-has-staff-project') : fromProject(joined);
  return { ...done(`You joined the shared staff project. ${MULTI_USER_DECLARED_TEXT}`), project: joined };
}

// ---- admit (D-16, D-18, D-22, D-45) --------------------------------------------------------------------------------------------------------------

interface CheckedRequest { request: JoinRequestPayload; writer: string; invite: InvitePayload; secret: string; safetyWords: string[]; resume: boolean }

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
 * kept, the request's signature, binding and MAC (checkJoinRequest), and the six words. A request whose admission this device already wrote but did
 * not finish (the secret is still kept) is resumed instead of refused invite-used.
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
  if (standing.state === 'used' && secret === undefined) return refuse('invite-used');
  if (secret === undefined) return refuse('no-join-secret');
  const at = now(deps);
  const invite: InvitePayload = {
    genesisHash: project.anchor.genesisHash, project: project.projectId, name: 'Staff project', lead: { ...project.anchor.lead }, invite: id, secret,
    expiresAt: record.expiresAt, ...(record.forMember === undefined ? {} : { forMember: record.forMember })
  };
  const checked = checkJoinRequest(requestText, { invite, secret, ...(standing.state === 'used' ? {} : { now: at, rosterInvite: { state: 'open' as const } }) });
  if (!checked.ok) return fromInvite(checked.reason);
  // A used invitation is resumed only when it was this very device that it admitted (a crash before the welcome); otherwise it is used.
  const resume = standing.state === 'used';
  if (resume && (usedBy === undefined || deviceAt(roster.members, checked.writer, head.position)?.member !== usedBy)) return refuse('invite-used');
  const safetyWords = inviteSafetyCode(invite, { publicKey: checked.request.publicKey, x25519: checked.request.x25519 });
  return { request: checked.request, writer: checked.writer, invite, secret, safetyWords, resume };
}

/**
 * The lead's first look at a join request: every check, and the six words to compare with the person, with nothing written. The command shows the
 * words and asks the lead to confirm they matched before it calls admitJoinRequest.
 */
export function reviewJoinRequest(shared: SharedProjectHost, requestText: unknown): Promise<MembershipResult> {
  return guarded(async () => {
    const { roster } = await shared.project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const checked = await checkRequest(shared, roster, requestText);
    if (isResult(checked)) return checked;
    const who = checked.invite.forMember === undefined ? checked.request.name : `${checked.request.name}'s other computer`;
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

interface GrantPlan { cell: string; epochs: Array<{ epoch: number; key: Buffer }>; raw?: unknown }

/**
 * The grants a device needs for every cell its member is cleared for, with every epoch of each (D-45), and their keys from this device's ring. A
 * cleared cell with an epoch key this device does not hold is no-grant-key: refused before anything is written.
 */
function grantPlans(shared: SharedProjectHost, roster: RosterState, member: { clearance: unknown; holdsMember?: string }, cells: readonly CellInfo[], gate: Gate, position: number, skip: (cell: string) => boolean = () => false): GrantPlan[] | MembershipResult {
  const plans: GrantPlan[] = [];
  for (const info of cells) {
    const holds = member.holdsMember !== undefined && memberHolds(roster, member.holdsMember, info.cell, position);
    if (!clearedFor(member.clearance, info, holds, gate) || skip(info.cell)) continue;
    const epochs: Array<{ epoch: number; key: Buffer }> = [];
    for (const item of epochsAt(roster.cells, info.cell, position)) {
      const key = shared.project.keys.epochKey(info.cell, item.epoch);
      if (key === undefined) return refuse('no-grant-key');
      epochs.push({ epoch: item.epoch, key });
    }
    if (epochs.length > 0) plans.push({ cell: info.cell, epochs, ...(info.base ? {} : { raw: info.raw }) });
  }
  return plans;
}

/** Signs and stores the per-epoch grants of the plans for one device at the roster given (a roster that admits the device). */
async function writeGrants(shared: SharedProjectHost, plans: readonly GrantPlan[], device: { writer: string; x25519: string }, roster: string): Promise<MembershipResult | undefined> {
  const grants = plans.flatMap((plan) => earlierEpochGrants(shared.project.signer, {
    cell: plan.cell, epochs: plan.epochs, roster, writer: device.writer, recipient: device.x25519, ...(plan.raw === undefined ? {} : { label: plan.raw })
  }));
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
 * Admits the device that answered an invitation (D-16, D-18, D-22, D-45). Refused unless the lead confirmed the six words matched. Then: member.admit
 * (or device.add for Add My Other Machine) with the next free slot, the invitation's seat, roles and clearance; a grant for every epoch of every cell
 * the member's declared clearance dominates; the join secret is forgotten once the roster has recorded the admission; and the .near-staff-welcome
 * file for that device alone is returned.
 */
export function admitJoinRequest(shared: SharedProjectHost, requestText: unknown, input: AdmitInput): Promise<MembershipResult> {
  return guarded(async () => {
    if (input.codeMatched !== true) return refuse('code-not-confirmed');
    const { project, deps } = shared;
    let { roster } = await project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const checked = await checkRequest(shared, roster, requestText);
    if (isResult(checked)) return checked;
    const gate = gateOf(shared);
    const id = checked.invite.invite;
    const record = roster.members.invites.get(id);
    if (record === undefined) return refuse('unknown-invite');
    const device = { writer: checked.writer, publicKey: checked.request.publicKey, x25519: checked.request.x25519, x25519Sig: checked.request.x25519Sig };
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
    const stored = await writeGrants(shared, plans, device, admitted);
    if (stored !== undefined) return stored;
    // The roster has recorded the invitation's outcome: the join secret is no longer needed (P-31-28).
    await forgetJoinSecret(deps.secrets, id);
    const cleared = all.map((plan) => plan.cell);
    let welcome: string;
    try {
      welcome = JSON.stringify(await project.welcomeFor(device.writer, cleared));
    } catch {
      return { ...refuse('welcome-too-large'), member };
    }
    const who = forMember === undefined ? record.name : `${record.name}'s other computer`;
    return done(`${who} was admitted. Send them the welcome file any way you like; when they open it, the project opens on their computer.`, {
      file: { name: `welcome-${id}${WELCOME_FILE_EXTENSION}`, text: welcome }, safetyWords: checked.safetyWords, granted: plans.map((plan) => plan.cell),
      invite: id, member, writer: device.writer
    });
  });
}

// ---- remove, revoke and change: rekey (D-23) -----------------------------------------------------------------------------------------------------

interface RekeyOutcome { rekeyed: string[]; skipped: string[] }

/**
 * The rekey plans for a change, computed before the change is written: the grantees of each cell at the current head, and who is cleared once the
 * change applies. A labelled cell whose label this device cannot read keeps its current grantees, minus the devices the change removes: they were
 * cleared when they were granted, and the signed grant is the authority for who is on a cell. A clearance change for a member who holds such a cell
 * cannot be judged here, so it is refused no-grant-key before anything is written.
 */
function rekeyPlans(shared: SharedProjectHost, roster: RosterState, change: { kind: RekeyReason; writers: readonly string[] }, after: Change, gate: Gate): { plans: RekeyPlan[]; cells: Map<string, CellInfo> } | MembershipResult {
  const head = headOf(roster);
  const infos = cellsAt(roster, shared.project.keys, head.position, gate.scales);
  const cells: Array<{ cell: string; grantees: readonly string[]; clearedNow: readonly string[] }> = [];
  for (const info of infos) {
    const grantees = granteesAt(roster.cells, info.cell, head.position, (writer) => deviceAt(roster.members, writer, head.position) !== undefined) ?? [];
    if (!info.known) {
      if (after.clearance !== undefined && change.writers.some((writer) => grantees.includes(writer))) return refuse('no-grant-key');
      cells.push({ cell: info.cell, grantees, clearedNow: grantees.filter((writer) => after.without?.has(writer) !== true) });
      continue;
    }
    cells.push({ cell: info.cell, grantees, clearedNow: clearedDevices(roster, info, head.position, gate, after) });
  }
  return { plans: planRekey({ change, cells }), cells: new Map(infos.map((info) => [info.cell, info])) };
}

/** Writes one cell.rekey per plan with recipients, each with its founding grant wrapped only to them (D-23, D-44). A plan with nobody left is not written. */
async function writeRekeys(shared: SharedProjectHost, plans: readonly RekeyPlan[], cells: ReadonlyMap<string, CellInfo>): Promise<RekeyOutcome | MembershipResult> {
  const { project } = shared;
  const rekeyed: string[] = [];
  const skipped: string[] = [];
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
    const key = newEpochKey();
    const info = cells.get(plan.cell) as CellInfo;
    const wraps = plan.recipients.map((writer) => {
      const recipient = x25519At(roster.members, writer, head.position);
      if (recipient === undefined) throw new Error('The cell key was not moved: a device to receive it has no encryption key in the roster.');
      return { writer, wrap: wrapEpochKey({ cell: plan.cell, epoch, writer, recipient, epochKey: key }) };
    });
    const founding = buildGrant(project.signer, { cell: plan.cell, epoch, roster: head.hash, labelSealed: info.base || info.raw === undefined ? '' : sealLabel(key, plan.cell, epoch, info.raw), wraps });
    // The key and the founding grant are kept before the entry that commits to them, so a crash never leaves an epoch nobody can open.
    await project.keys.addOwn(plan.cell, epoch, key);
    const stored = await project.putGrants([founding]);
    if (isProjectRefused(stored)) return fromProject(stored);
    const written = await append(shared, 'cell.rekey', { cell: plan.cell, epoch, reason: plan.reason, grant: grantHash(founding) }, head.hash);
    if (isResult(written)) return written;
    rekeyed.push(plan.cell);
  }
  return { rekeyed, skipped };
}

function rekeyMessage(first: string, outcome: RekeyOutcome): string {
  const moved = outcome.rekeyed.length === 0 ? '' : ` ${outcome.rekeyed.length === 1 ? 'One part of the project was' : `${outcome.rekeyed.length} parts of the project were`} moved to a new key.`;
  const left = outcome.skipped.length === 0 ? '' : ` Nobody else is on ${outcome.skipped.length === 1 ? 'one part' : `${outcome.skipped.length} parts`} of the project, so no new key was made for ${outcome.skipped.length === 1 ? 'it' : 'them'}.`;
  return `${first}${moved}${left} ${REKEY_KEEP_TEXT}`;
}

export type RemoveInput = { member: string } | { member: string; writer: string };

/**
 * Removes a member (member.remove) or one of a member's devices (device.revoke), then moves every cell the removed devices held to a new key wrapped
 * only to the devices still cleared (D-23). The lead cannot be removed, and the lead's last device can be revoked only by the deputy (D-09, D-48);
 * both are refused with the roster's own sentence.
 */
export function removeFromProject(shared: SharedProjectHost, input: RemoveInput): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const head = headOf(roster);
    const record = memberAt(roster.members, input.member, head.position);
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
    const written = await append(shared, entry.kind, entry.data);
    if (isResult(written)) return written;
    const outcome = await writeRekeys(shared, planned.plans, planned.cells);
    if (isResult(outcome)) return outcome;
    const first = 'writer' in input ? `That device of ${record.name} was removed from the project.` : `${record.name} was removed from the project.`;
    return done(rekeyMessage(first, outcome), { rekeyed: outcome.rekeyed, member: input.member, ...('writer' in input ? { writer: input.writer } : {}) });
  });
}

export interface UpdateMemberInput { member: string; name?: string; seat?: string; roles?: string[]; clearance?: unknown; agentSeats?: string[] }

/**
 * Changes a member's name, seat, roles, clearance or agent seats (member.update). A lowered clearance moves every cell the member is no longer cleared
 * for to a new key without the member's devices (D-23); a raised one gives those devices every epoch of the cells they are newly cleared for (D-45).
 */
export function updateMember(shared: SharedProjectHost, input: UpdateMemberInput): Promise<MembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
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
    const planned = changesClearance
      ? rekeyPlans(shared, roster, { kind: 'clearance-lowered', writers: devices.map((device) => device.writer) }, { clearance: { member: input.member, value: input.clearance } }, gate)
      : { plans: [] as RekeyPlan[], cells: new Map<string, CellInfo>() };
    if (isResult(planned)) return planned;
    // The cells the member is newly cleared for, and their keys, are checked before anything is written too.
    const raisedCheck = changesClearance ? grantPlans(shared, roster, { clearance: input.clearance }, cellsAt(roster, project.keys, head.position, gate.scales), gate, head.position) : [];
    if (isResult(raisedCheck)) return raisedCheck;
    const written = await append(shared, 'member.update', data);
    if (isResult(written)) return written;
    const granted = new Set<string>();
    if (changesClearance) {
      const updated = headOf(written.roster);
      const now2 = memberAt(written.roster.members, input.member, updated.position) as MemberRecord;
      const cells = cellsAt(written.roster, project.keys, updated.position, gate.scales);
      for (const device of devices) {
        const holding = (cell: string): boolean => (granteesAt(written.roster.cells, cell, updated.position, () => true) ?? []).includes(device.writer);
        const plans = grantPlans(shared, written.roster, { clearance: now2.clearance }, cells, gate, updated.position, holding);
        if (isResult(plans)) return plans;
        const stored = await writeGrants(shared, plans, { writer: device.writer, x25519: device.x25519 }, written.hash);
        if (stored !== undefined) return stored;
        for (const plan of plans) granted.add(plan.cell);
      }
    }
    const outcome = await writeRekeys(shared, planned.plans, planned.cells);
    if (isResult(outcome)) return outcome;
    const first = `${input.name ?? record.name} was changed.`;
    const gave = granted.size === 0 ? '' : ` ${granted.size === 1 ? 'One part of the project was' : `${granted.size} parts of the project were`} shared with them.`;
    const message = outcome.rekeyed.length > 0 || outcome.skipped.length > 0 ? rekeyMessage(`${first}${gave}`, outcome) : `${first}${gave}`;
    return done(message, { rekeyed: outcome.rekeyed, granted: [...granted].sort(), member: input.member });
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
    return done(`${record.name} is now the deputy lead.`, { member });
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
    return done(`${record.name} is now the staff lead.`, { member: input.to });
  });
}

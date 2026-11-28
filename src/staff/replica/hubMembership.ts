// Your organization's hub as a member of the roster (D-22, D-40, D-41, D-64; DESIGN 10.2), and the flows that talk to it (D-41, D-47, D-48; 32-25):
// connecting a project to the hub (admission and enrolment in one step), invitations the hub knows, join requests sent and fetched through it. The
// commands (Phase 33) only show dialogs and call these. Node I/O through ReplicaProject, the membership flows and the hub transport only; never
// imports vscode.
//
// The hub's standing, as the roster has it (the fold is the authority; these flows refuse before they write so the lead is told plainly):
//   (absent) --admitHub: hub.admit, hub.grant for the base cell, base cell grants--> admitted, holding the base cell
//   admitted --grantCellToHub (trade-off confirmed): hub.grant, the cell's grants--> admitted, holding one more cell
//   admitted --revokeHub: hub.revoke, then every cell it held moved to a new key without it--> revoked
// A step interrupted part way is finished by running it again: admitHub and grantCellToHub write only what the roster shows is missing, and the
// rekeys an interrupted revokeHub left are finished by revokeHub again or by the next roster flow (finishRekeys).
//
// The hub reads the base cell (the roster) always, so it can check appends (D-40), and a cell more only when the lead gives it one after reading the
// trade-off. It is never given the lead-only legacy cell (D-20, D-64). No result or message holds a key, a binding signature or the hub file's
// enrolment secret, and this module stores neither the hub file nor its secret.
//
// Connecting a project (D-41): admitHub, then POST /v1/enrol with the genesis, every roster entry, their blobs, every grant this device holds and the
// enrolment MAC. The hub file is read again on each call, so an enrolment the hub could not take (unreachable) is finished by calling again: the hub
// is already admitted, so admitHub's hub-already-admitted is the resume case and no second hub.admit is written.
//   not admitted --connect--> admitted --enrol--> on the hub        admitted --enrol, hub unreachable--> admitted (call again)
//   admitted --enrol refused used, expired or unknown--> admitted (the operator issues a new hub file; connect again with it)
// Invitations and join requests through the hub (D-47, D-48): the hub never holds a join secret. inviteThroughHub writes member.invite exactly as
// inviteToProject does, then gives the file the hub field and registers the invitation with the hub check key only. The joining person's request
// travels with a second MAC under that key; the hub's acceptance admits nobody, and the lead's device still checks the Phase 31 MAC with the real
// secret (reviewJoinRequest, admitJoinRequest) and the six words before anyone is admitted. When the hub cannot be told or reached, everything still
// works by file, and the sentence says so.
import { parseClearance } from '../../domain/gate/labels';
import { REKEY_KEEP_TEXT, REKEY_VERIFIED_TEXT } from '../../domain/replica/cellKeys';
import { CELL_ACCESS_FEATURE } from '../../domain/replica/features';
import { earlierEpochGrants } from '../../domain/replica/grantPages';
import { SWITCH_FIRST_TEXT, formatFor, formatForDevice, wrapDeviceAt } from './wrapPlan';
import type { WrapCell } from './wrapPlan';
import { HUB_FILE_REFUSALS, isHubAddress, readHubFile } from '../../domain/replica/hubFile';
import { INVITE_REFUSALS, buildHubJoinAsync, buildInviteAsync, checkJoinRequest, hubJoinCheckKey, hubJoinMac, inviteSafetyCode, joinRequestHash, readInvite } from '../../domain/replica/invite';
import type { InviteRefusal, JoinRequestPayload } from '../../domain/replica/invite';
import type { SignedPayload } from '../../domain/team/signedPayload';
import type { HubFilePayload } from '../../domain/replica/hubFile';
import type { RosterState } from '../../domain/replica/roster';
import type { FoldResult } from '../../domain/replica/fold';
import { clearanceProblem } from '../../domain/replica/kindSchemas/roster';
import { baseCellHeldProducts, readLegacyCellLabel } from '../../domain/replica/productCells';
import { epochsAt, granteesAt } from '../../domain/replica/rosterCells';
import { MEMBER_REFUSALS, devicesOfMemberAt, hubAt } from '../../domain/replica/rosterMembers';
import { MAX_SLOT } from '../../domain/replica/clientIds';
import { term } from '../../domain/org/terms';
import { isRecord } from '../../domain/team/validate';
import { multiUserNoticeLines } from '../../domain/staff/multiUser';
import { MEMBERSHIP_REFUSALS, append, cellsAt, clearedFor, finishRekeys, gateOf, headOf, inviteToProject, unfinishedRekeys, withPendingRekeyMessage, writerProblem } from './membership';
import type { Gate, InviteInput, MembershipResult, SharedProjectHost } from './membership';
import { HubTransport, HubTransportError, enrolmentRequest } from './hubTransport';
import type { HubTransportOptions } from './hubTransport';
import { joinSecret } from './keyring';
import { ReplicaProject, ReplicaProjectError, isProjectRefused, settled, syncLocalOf } from './replicaProject';
import type { ReplicaProjectDeps } from './replicaProject';

/** Shown to the lead at each grant of a cell to the hub (DESIGN 10.2), word for word; the lead confirms it before anything is written. */
export const HUB_GRANT_TRADE_OFF = 'The hub will be able to read everything in this cell. Anyone who takes over the hub server can read it too. Grant only cells whose watches must run when nobody is at a computer.';

/** The ending of every sentence that tells a joining person their request did not go through the hub. */
const SEND_FILE_TEXT = 'Send your join request file to the staff lead any way you like.';
/** inviteThroughHub, when the hub could not be told: the invitation is made and works by file only. */
export const HUB_NOT_TOLD_TEXT = 'Your organization\'s hub could not be told about it, so it works by file only: the person sends their join request file back to you any way they like.';

/** The hub flows' own refusals, one plain sentence each (D-37). None names a key, a secret or a hash, and none uses a dash as punctuation. */
export const HUB_MEMBERSHIP_REFUSALS = {
  'device-exists': MEMBER_REFUSALS['device-exists'],
  'member-exists': MEMBER_REFUSALS['member-exists'],
  'trade-off-not-confirmed': `Nothing was given to the hub, because the trade-off was not confirmed. Give the hub this part of the project only after reading and confirming this: ${HUB_GRANT_TRADE_OFF}`,
  'legacy-cell': 'This part of the project holds its history from before it was shared. It stays with the staff lead and the deputy lead only, so it is never given to the hub. Nothing was changed.',
  'above-hub-ceiling': 'This part of the project is labelled above the highest clearance you set for the hub, so it was not given to the hub. Nothing was changed.',
  'hub-needs-post-quantum-keys': 'Your organization\'s server needs post-quantum keys to read this part of the project. Ask your administrator to publish them and try again.',
  'hub-holds-cell': 'The hub already holds this part of the project, so nothing was changed.',
  'cell-unknown': 'That part of the project is not in the roster, so nothing was given to the hub. Nothing was changed.',
  'no-hub': 'This project has no hub admitted, so nothing was changed. Admit your organization\'s hub first.',
  'hub-not-named': 'This project has more than one hub admitted, so say which hub the change is for. Nothing was changed.',
  'hub-unknown': 'That hub is not in this project\'s roster, so nothing was changed. Check the hub and try again.',
  'hub-revoked': 'That hub was removed from the project and cannot be admitted again. Nothing was changed.',
  'hub-already-admitted': 'This hub is already admitted to the project and holds the roster, so nothing was changed.',
  'hub-file-differs': 'This hub is already in the project with another key or certificate than this hub file names, so nothing was changed. Ask the hub operator which hub file is current.',
  'ceiling-invalid': 'The highest clearance chosen for the hub is not one this project\'s scales know, so the hub was not admitted. Choose a clearance from the project\'s scales.',
  // D-22, word for word: a project the 0.4.35 preview made shared keeps its products where the hub must read.
  'base-cell-held-products': 'This project was made shared by an earlier preview, and its products sit in the part of the project the hub must read. Make a single-machine copy and make that copy multi-user again; the new shared project keeps each product in its own part.',
  // 32-25: connecting a project, and invitations and join requests through the hub.
  'hub-address-invalid': 'That is not an address this computer can reach a hub at, so nothing was changed. Give the name and port the hub operator published, such as hub.example.org:8443.',
  'hub-unreachable': 'Your organization\'s hub could not be reached, so nothing was asked of it. Try again when this computer is online.',
  'hub-session-refused': 'Your organization\'s hub did not accept this computer for the project yet. Sync the project with the hub, then try again.',
  'hub-refused': 'Your organization\'s hub refused the call, so nothing was asked of it. Try again later, or ask the hub operator to check the hub.',
  'enrol-refused': 'The hub did not take the project with this hub file, because it was already used, has expired or was not made for this hub. Ask the hub operator for a new hub file, then connect the project again with it.',
  'enrol-unreachable': 'Your organization\'s hub was admitted to the project, but it could not be reached to take the project. Connect the project to the hub again when this computer is online; the hub is not admitted a second time.',
  'enrol-not-taken': 'The hub did not take the project. Connect the project to the hub again from this computer, and if it is refused again ask the hub operator to check the hub.',
  'no-hub-in-invitation': `This invitation does not name your organization's hub, so nothing was sent. ${SEND_FILE_TEXT}`,
  'hub-unknown-invite': `Your organization's hub does not know this invitation, so the join request did not reach the staff lead. ${SEND_FILE_TEXT}`,
  'hub-invite-expired': `The hub says this invitation has expired, so it did not take the join request. Ask the staff lead for a new invitation, or ask whether they still take this one by file. ${SEND_FILE_TEXT}`,
  'hub-invite-used': `The hub says this invitation was already used to join the project, so it did not take the join request. Ask the staff lead whether a new invitation is needed. ${SEND_FILE_TEXT}`,
  'hub-invite-voided': `The hub says the staff lead cancelled this invitation, so it did not take the join request. Ask the staff lead for a new invitation if you still need one. ${SEND_FILE_TEXT}`,
  'hub-invite-locked': `The hub takes no more join requests for this invitation, because too many did not match it. Ask the staff lead for a new invitation. ${SEND_FILE_TEXT}`,
  // D-30: the hub keeps at most 8 waiting requests per invitation and 64 per project; the lead word comes from term() (D-27).
  'hub-invite-full': `This invitation has too many people waiting. Ask the ${term('lead').toLowerCase()} for a new one. ${SEND_FILE_TEXT}`,
  'hub-busy': `Your organization's hub asked this computer to wait before another join request, so this one was not sent. ${SEND_FILE_TEXT}`,
  'hub-join-refused': `Your organization's hub did not take this join request. ${SEND_FILE_TEXT}`,
  'hub-join-unreachable': `Your organization's hub could not be reached, so the join request was not sent. ${SEND_FILE_TEXT}`
} as const;
export type HubMembershipRefusal = keyof typeof HUB_MEMBERSHIP_REFUSALS;

/** A join request your organization's hub kept: the invitation it answers and its text, for reviewJoinRequest and admitJoinRequest. */
export interface HubJoinRequest { invite: string; text: string; receivedAt: string }

/**
 * What every hub flow returns: a membership result, with the hub's id (hub- and 16 hex) and its device's writer id when one is named; registered
 * (inviteThroughHub) when the hub was told of the invitation; requests (fetchJoinRequests) the join requests the hub kept.
 */
export interface HubMembershipResult extends MembershipResult { hub?: string; registered?: boolean; requests?: HubJoinRequest[] }

const done = (message: string, extra: Partial<HubMembershipResult> = {}): HubMembershipResult => ({ ok: true, message, notices: multiUserNoticeLines(), ...extra });
const refused = (reason: string, message: string): HubMembershipResult => ({ ok: false, reason, message, notices: multiUserNoticeLines() });
const refuse = (reason: HubMembershipRefusal): HubMembershipResult => refused(reason, HUB_MEMBERSHIP_REFUSALS[reason]);
const refuseMembership = (reason: keyof typeof MEMBERSHIP_REFUSALS): HubMembershipResult => refused(reason, MEMBERSHIP_REFUSALS[reason]);
const isResult = (value: unknown): value is MembershipResult => isRecord(value) && typeof value.ok === 'boolean' && typeof value.message === 'string';
const now = (shared: SharedProjectHost): Date => shared.deps.now?.() ?? new Date();

/** Runs a flow, turning a store refusal on refresh into a plain result instead of an exception. */
async function guarded(work: () => Promise<HubMembershipResult>): Promise<HubMembershipResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReplicaProjectError) return refused(error.refusal.refused, error.refusal.message);
    throw error;
  }
}

/** The smallest device slot never given in this project (D-41: a slot is never reused), or undefined when all are given. As membership's freeSlot. */
function freeSlot(roster: RosterState): number | undefined {
  for (let slot = 1; slot <= MAX_SLOT; slot += 1) if (!roster.members.slots.has(slot)) return slot;
  return undefined;
}

/** The epochs of the cell at the position that the device holds no placed grant for, oldest first. */
function missingEpochs(roster: RosterState, cell: string, writer: string, position: number): Array<{ epoch: number; from: number }> {
  const record = roster.cells.cells.get(cell);
  return epochsAt(roster.cells, cell, position)
    .filter((item) => !(record?.grants ?? []).some((grant) => grant.epoch === item.epoch && grant.from <= position && grant.writers.includes(writer)))
    .map((item) => ({ epoch: item.epoch, from: item.from }));
}

/** Checks every missing epoch before a roster item promises the hub access to the cell. */
function hubWrapProblem(shared: SharedProjectHost, roster: RosterState, cell: WrapCell, epochs: ReadonlyArray<{ from: number }>, hasKem: boolean): HubMembershipResult | undefined {
  for (const { from } of epochs) {
    const format = formatFor(roster, cell, from, shared.routing);
    if (format === 'switch-first') return refused('switch-first', SWITCH_FIRST_TEXT);
    if (format === 2 && !hasKem) return refuse('hub-needs-post-quantum-keys');
  }
  return undefined;
}

/**
 * Signs and stores one grant per epoch of the cell to the hub, each at the roster that gave the hub the cell (or the epoch's own founding entry when
 * that came later, since a grant may not name a roster before its epoch), in the format wrapPlan.formatFor gives the epoch with the hub's keys as the
 * roster names them (33.2 D-05): a hub without post-quantum keys gets no wrap of an epoch that needs them. The keys are checked by the caller before
 * anything is written.
 */
async function grantEpochs(shared: SharedProjectHost, input: { cell: string; info: WrapCell; epochs: ReadonlyArray<{ epoch: number; from: number; key: Buffer }>; roster: RosterState; grantedAt: number; hub: { writer: string }; label?: unknown }): Promise<HubMembershipResult | undefined> {
  const device = wrapDeviceAt(input.roster, input.hub.writer, input.roster.positions.length - 1);
  const byRoster = new Map<number, Array<{ epoch: number; key: Buffer; format: 1 | 2 }>>();
  for (const item of input.epochs) {
    const choice = formatFor(input.roster, input.info, item.from, shared.routing);
    if (choice === 'switch-first') return refused('switch-first', SWITCH_FIRST_TEXT);
    if (choice === 2 && device.kem === undefined) return refuse('hub-needs-post-quantum-keys');
    const at = Math.max(input.grantedAt, item.from);
    byRoster.set(at, [...(byRoster.get(at) ?? []), { epoch: item.epoch, key: item.key, format: formatForDevice(choice, device) }]);
  }
  const grants = [...byRoster.entries()].flatMap(([at, epochs]) => earlierEpochGrants(shared.project.signer, {
    cell: input.cell, epochs, roster: input.roster.positions[at], writer: input.hub.writer, ...(device.x25519 === undefined ? {} : { recipient: device.x25519 }),
    ...(device.kem === undefined ? {} : { kem: device.kem }), ...(input.label === undefined ? {} : { label: input.label })
  }));
  if (grants.length !== input.epochs.length) return refuseMembership('no-grant-key');
  if (grants.length === 0) return undefined;
  const stored = await shared.project.putGrants(grants);
  return isProjectRefused(stored) ? refused(stored.refused, stored.message) : undefined;
}

/** Every epoch key of the cell at the position from this device's ring, or undefined when one is missing (nothing can be granted from here). */
function epochKeys(shared: SharedProjectHost, cell: string, epochs: ReadonlyArray<{ epoch: number; from: number }>): Array<{ epoch: number; from: number; key: Buffer }> | undefined {
  const found: Array<{ epoch: number; from: number; key: Buffer }> = [];
  for (const item of epochs) {
    const key = shared.project.keys.epochKey(cell, item.epoch);
    if (key === undefined) return undefined;
    found.push({ ...item, key });
  }
  return found;
}

/**
 * Did the base stream ever hold product text or a legacy ledger (D-22)? A product-family entry there (baseCellHeldProducts, 32-08), or a project.import
 * there: the 0.4.35 preview imported whole ledgers into the base cell, and Phase 32 imports into label cells and the legacy cell only. Read from the
 * fold, which lists the entries it applied or held with their stream; an entry it refused or kept is not seen here (32-08, Known limits).
 */
function baseHeldProducts(fold: FoldResult, base: string): boolean {
  if (baseCellHeldProducts(fold, base)) return true;
  const streams = fold.families.project;
  return Array.isArray(streams) && streams.some((item: unknown) => isRecord(item) && item.stream === base && Array.isArray(item.imports) && item.imports.length > 0);
}

/** The ceiling as hub.admit carries it: a roster clearance the project's scales read (Phase 70), copied fresh; undefined when it is not one. */
function ceilingOf(value: unknown, gate: Gate): unknown {
  if (clearanceProblem(value, 'ceiling') !== undefined || !isRecord(value)) return undefined;
  const { handling: _handling, ...rest } = value;
  if (!parseClearance(rest, gate.scales).ok) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

const hubName = (file: Pick<HubFilePayload, 'hub' | 'address'>): string => `Your organization's hub at ${file.address} (${file.hub})`;

export interface AdmitHubInput {
  /** The highest clearance the hub may ever be given a cell at (Phase 70 shape), chosen by the lead. */
  ceiling: unknown;
}

/**
 * Admits your organization's hub from the operator's hub file (D-40, D-41, D-64): the file is read and checked (signature by the hub's own key, the
 * binding of its two keys, the expiry, with the host clock), then hub.admit names the hub, its device with the next free slot, the certificate pin
 * and the ceiling; hub.grant gives it the base cell; and one grant per base cell epoch wraps that epoch's key to the hub's X25519 key at the hub.grant
 * roster. The hub then reads the roster and nothing else. The hub file is not kept: enrolment (32-25) reads it again.
 */
export function admitHub(shared: SharedProjectHost, hubFileText: unknown, input: AdmitHubInput): Promise<HubMembershipResult> {
  return guarded(async () => {
    const read = readHubFile(hubFileText, now(shared));
    if (!read.ok) return refused(read.reason, HUB_FILE_REFUSALS[read.reason]);
    const file = read.hubFile;
    const { project } = shared;
    const { roster: before, fold } = await project.state();
    const problem = writerProblem(shared, before);
    if (problem !== undefined) return problem;
    const base = project.projectId;
    if (baseHeldProducts(fold, base)) return refuse('base-cell-held-products');
    if (before.members.members.has(file.hub)) return refuse('member-exists');
    const at = headOf(before);
    const gate = gateOf(shared);
    // Everything is decided before the first write. A hub the roster has already is an admission stopped part way (resumed: only what is missing is
    // written, and its ceiling stays as the roster has it), one fully admitted, or one revoked.
    const existing = before.members.hubs.has(file.hub) ? hubOf(before, at.position, file.hub) : undefined;
    let device: { writer: string; publicKey: string; x25519: string; x25519Sig: string; slot: number; kem?: { p256: string; mlkem768: string; sig: string } } | undefined;
    let ceiling: unknown;
    if (existing !== undefined) {
      if (isResult(existing)) return existing;
      if (existing.writer !== file.writer || hubAt(before.members, file.hub, at.position)?.certPin !== file.certPin) return refuse('hub-file-differs');
      if (existing.cells.includes(base) && missingEpochs(before, base, file.writer, at.position).length === 0) return refuse('hub-already-admitted');
    } else {
      if (before.members.devices.has(file.writer)) return refuse('device-exists');
      ceiling = ceilingOf(input.ceiling, gate);
      if (ceiling === undefined) return refuse('ceiling-invalid');
      const slot = freeSlot(before);
      if (slot === undefined) return refused('device-limit', MEMBER_REFUSALS['device-limit']);
      // The hub's post-quantum keys and their binding come from its hub file when it has a kem key (33.2 D-03).
      device = { writer: file.writer, publicKey: file.publicKey, x25519: file.x25519, x25519Sig: file.x25519Sig, slot, ...(file.kem === undefined ? {} : { kem: { ...file.kem } }) };
    }
    // Every base cell key is checked before the first write, so a device that cannot give the hub the roster writes nothing.
    const missingBase = missingEpochs(before, base, file.writer, at.position);
    const hasKem = device === undefined ? wrapDeviceAt(before, file.writer, at.position).kem !== undefined : device.kem !== undefined;
    const wrapProblem = hubWrapProblem(shared, before, { base: true }, missingBase, hasKem);
    if (wrapProblem !== undefined) return wrapProblem;
    if (epochKeys(shared, base, missingBase) === undefined) return refuseMembership('no-grant-key');
    let roster = before;
    if (device !== undefined) {
      const admitted = await append(shared, 'hub.admit', { hub: file.hub, device, certPin: file.certPin, ceiling });
      if (isResult(admitted)) return admitted;
      roster = admitted.roster;
    }
    let grantedAt = grantedAtOf(roster, file.hub, base);
    if (grantedAt === undefined) {
      const granted = await append(shared, 'hub.grant', { hub: file.hub, cell: base });
      if (isResult(granted)) return granted;
      roster = granted.roster;
      grantedAt = roster.positionOf.get(granted.hash) as number;
    }
    const missing = epochKeys(shared, base, missingEpochs(roster, base, file.writer, headOf(roster).position));
    if (missing === undefined) return refuseMembership('no-grant-key');
    const stored = await grantEpochs(shared, { cell: base, info: { base: true }, epochs: missing, roster, grantedAt, hub: file });
    if (stored !== undefined) return stored;
    const first = existing === undefined ? '' : 'The admission of the hub left unfinished is now finished. ';
    return done(`${first}${hubName(file)} was admitted. It can read the roster, so it can check every change sent to it, and nothing else until you give it a part of the project.`, { hub: file.hub, writer: file.writer });
  });
}

/** The hub a flow is for: the one named, or the only hub in force at the position. Its device's writer and X25519 key, its cells and its ceiling. */
interface HubInForce { hub: string; writer: string; x25519: string; cells: readonly string[]; ceiling: unknown }

function hubOf(roster: RosterState, position: number, named: string | undefined): HubInForce | HubMembershipResult {
  const ids = named !== undefined ? [named] : [...roster.members.hubs.keys()].filter((hub) => hubAt(roster.members, hub, position) !== undefined);
  if (ids.length === 0) return refuse('no-hub');
  if (ids.length > 1) return refuse('hub-not-named');
  const hub = ids[0] as string;
  if (!roster.members.hubs.has(hub)) return refuse('hub-unknown');
  const record = hubAt(roster.members, hub, position);
  const device = devicesOfMemberAt(roster.members, hub, position).find((item) => item.kind === 'hub');
  if (record === undefined || device === undefined) return refuse('hub-revoked');
  return { hub, writer: device.writer, x25519: device.x25519, cells: record.cells, ceiling: record.ceiling };
}

/** The position of the hub.grant that first gave the hub the cell (the start of the first hub version listing it), or undefined. */
function grantedAtOf(roster: RosterState, hub: string, cell: string): number | undefined {
  return roster.members.hubs.get(hub)?.find((record) => record.cells.includes(cell))?.from;
}

export interface GrantCellToHubInput {
  /** The cell to give the hub. */
  cell: string;
  /** True only when the lead read HUB_GRANT_TRADE_OFF and confirmed it. Nothing else ever confirms it. */
  confirmed: boolean;
  /** The hub's id; the only hub in force when absent. */
  hub?: string;
}

/**
 * Gives the hub one more cell (D-40, DESIGN 10.2), so its watches on that cell can run when nobody is at a computer. Refused, before anything is
 * written: the lead-only legacy cell, always and first (D-20, D-64); unless the lead confirmed the trade-off; as every roster change; a cell the hub
 * already holds; a cell whose label this device cannot read; and a cell whose label the hub's ceiling does not dominate (Phase 70 dominance with the
 * host clock). Then hub.grant, and one grant per epoch of the cell with its label sealed, so every later rekey of the cell keeps wrapping to the hub.
 * Run again after a stop between the two, it writes only the grants that are missing.
 */
export function grantCellToHub(shared: SharedProjectHost, input: GrantCellToHubInput): Promise<HubMembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
    const at = headOf(roster);
    const gate = gateOf(shared);
    const info = cellsAt(roster, project.keys, at.position, gate.scales).find((item) => item.cell === input.cell);
    if (info === undefined) return refuse('cell-unknown');
    if (info.legacy !== undefined || (info.raw !== undefined && readLegacyCellLabel(info.raw, gate.scales) !== undefined)) return refuse('legacy-cell');
    if (input.confirmed !== true) return refuse('trade-off-not-confirmed');
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const hub = hubOf(roster, at.position, input.hub);
    if (isResult(hub)) return hub;
    const holds = hub.cells.includes(info.cell);
    const missingBefore = missingEpochs(roster, info.cell, hub.writer, at.position);
    if (holds && missingBefore.length === 0) return refuse('hub-holds-cell');
    if (!info.known) return refuseMembership('no-grant-key');
    if (!clearedFor(hub.ceiling, info, false, gate)) return refuse('above-hub-ceiling');
    const wrapProblem = hubWrapProblem(shared, roster, info, missingBefore, wrapDeviceAt(roster, hub.writer, at.position).kem !== undefined);
    if (wrapProblem !== undefined) return wrapProblem;
    if (epochKeys(shared, info.cell, missingBefore) === undefined) return refuseMembership('no-grant-key');
    let current = roster;
    let grantedAt = grantedAtOf(roster, hub.hub, info.cell);
    if (!holds) {
      const granted = await append(shared, 'hub.grant', { hub: hub.hub, cell: info.cell });
      if (isResult(granted)) return granted;
      current = granted.roster;
      grantedAt = current.positionOf.get(granted.hash);
    }
    const missing = epochKeys(shared, info.cell, missingEpochs(current, info.cell, hub.writer, headOf(current).position));
    if (missing === undefined || grantedAt === undefined) return refuseMembership('no-grant-key');
    const stored = await grantEpochs(shared, { cell: info.cell, info, epochs: missing, roster: current, grantedAt, hub, ...(info.base ? {} : { label: info.raw }) });
    if (stored !== undefined) return stored;
    return done(`The hub (${hub.hub}) can now read this part of the project, and every new key it gets.`, {
      notices: [...multiUserNoticeLines(), HUB_GRANT_TRADE_OFF], granted: [info.cell], hub: hub.hub, writer: hub.writer
    });
  });
}

/** What a revoke says: who was removed, how many cells moved to a new key, and the agreed words on what the hub keeps. */
function revokeMessage(first: string, rekeyed: readonly string[]): string {
  const moved = rekeyed.length === 0 ? '' : ` ${rekeyed.length === 1 ? 'One part of the project was' : `${rekeyed.length} parts of the project were`} moved to a new key. ${REKEY_VERIFIED_TEXT}`;
  return `${first}${moved} ${REKEY_KEEP_TEXT}`;
}

/** A broad recovery can finish unrelated changes. Only count cells whose current epoch the named hub held before recovery. */
function cellsHeldByHub(roster: RosterState, writer: string | undefined): Set<string> {
  const position = headOf(roster).position;
  return new Set(writer === undefined ? [] : [...roster.cells.cells.keys()].filter((cell) =>
    granteesAt(roster.cells, cell, position, () => true)?.includes(writer) === true));
}

/**
 * Revokes the hub (DESIGN 10.2): hub.revoke ends the hub and its device, so it signs no checkpoint from there on, and then every cell it held (the
 * base cell and each granted cell) moves to a new key without it, through membership's finishRekeys (reason hub-revoked). Refused before anything is
 * written as every roster change, and when the hub holds a cell whose label this device cannot read (that cell could not be moved here). A removal
 * left unfinished is finished first. A revoke whose rekeys were interrupted is finished by revokeHub again or by the next roster flow; with nothing
 * left it is refused hub-revoked.
 */
export function revokeHub(shared: SharedProjectHost, input: { hub?: string } = {}): Promise<HubMembershipResult> {
  return guarded(async () => {
    const { project } = shared;
    const { roster } = await project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const at = headOf(roster);
    const hub = hubOf(roster, at.position, input.hub);
    if (isResult(hub)) {
      // The hub named was revoked already: finish what its revoke left, if anything.
      if (hub.reason !== 'hub-revoked' || input.hub === undefined || await unfinishedRekeys(shared) === 0) return hub;
      const revokedAt = roster.members.hubs.get(input.hub)?.at(-1)?.until;
      const writer = revokedAt === undefined ? undefined : devicesOfMemberAt(roster.members, input.hub, revokedAt - 1).find((device) => device.kind === 'hub')?.writer;
      const held = cellsHeldByHub(roster, writer);
      const finished = await finishRekeys(shared);
      if (!finished.ok) return held.size > 0 && !roster.requiredFrom.has(CELL_ACCESS_FEATURE)
        ? withPendingRekeyMessage(finished, `The hub (${input.hub}) was already removed.`) : finished;
      const rekeyed = finished.rekeyed ?? [];
      const hubRekeys = rekeyed.filter((cell) => held.has(cell));
      const first = hubRekeys.length > 0 ? `The removal of the hub (${input.hub}) left unfinished is now finished.` : `The hub (${input.hub}) was already removed.`;
      return done(revokeMessage(first, hubRekeys), { rekeyed, hub: input.hub });
    }
    const gate = gateOf(shared);
    const infos = cellsAt(roster, project.keys, at.position, gate.scales);
    for (const cell of hub.cells) {
      const info = infos.find((item) => item.cell === cell);
      if (info !== undefined && !info.known) return refuseMembership('no-grant-key');
    }
    // As every roster flow: a removal left unfinished is finished first.
    let earlier: string[] = [];
    if (await unfinishedRekeys(shared) > 0) {
      const finished = await finishRekeys(shared);
      if (!finished.ok) return finished;
      earlier = finished.rekeyed ?? [];
    }
    const written = await append(shared, 'hub.revoke', { hub: hub.hub }, undefined,
      roster.requiredFrom.has(CELL_ACCESS_FEATURE) ? undefined : 'report-saved');
    if (isResult(written)) return written;
    const held = cellsHeldByHub(written.roster, hub.writer);
    const finished = await finishRekeys(shared);
    if (!finished.ok && finished.reason !== 'nothing-to-finish') return held.size > 0 && !written.roster.requiredFrom.has(CELL_ACCESS_FEATURE)
      ? withPendingRekeyMessage(finished, `The hub (${hub.hub}) was removed.`) : finished;
    const rekeyed = finished.ok ? finished.rekeyed ?? [] : [];
    const hubRekeys = rekeyed.filter((cell) => held.has(cell));
    const note = earlier.length === 0 ? '' : `A removal or clearance change left unfinished was finished first: ${earlier.length === 1 ? 'one part of the project was' : `${earlier.length} parts of the project were`} moved to a new key. `;
    return done(`${note}${revokeMessage(`Your organization's hub (${hub.hub}) was removed from the project, and it signs nothing for the project from now on.`, hubRekeys)}`, {
      rekeyed: [...earlier, ...rekeyed], hub: hub.hub, writer: hub.writer
    });
  });
}

/** One hub as the roster has it: its id, its device's writer id, its certificate pin, its ceiling, the cells it holds (or held when revoked). */
export interface HubStanding { hub: string; writer?: string; certPin: string; ceiling: unknown; cells: string[]; standing: 'admitted' | 'revoked' }

/** Every hub the roster has, with its standing at the head (admitted or revoked), sorted by id. Reads only: writes no entry and no grant. */
export async function hubStanding(shared: SharedProjectHost): Promise<HubStanding[]> {
  const { roster } = await shared.project.state();
  const at = headOf(roster);
  const found: HubStanding[] = [];
  for (const [hub, versions] of [...roster.members.hubs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const current = hubAt(roster.members, hub, at.position);
    const record = current ?? versions[versions.length - 1];
    if (record === undefined) continue;
    let writer: string | undefined;
    for (const device of roster.members.devices.values()) {
      const last = device[device.length - 1];
      if (last?.member === hub && last.kind === 'hub') writer = last.writer;
    }
    found.push({ hub, ...(writer === undefined ? {} : { writer }), certPin: record.certPin, ceiling: JSON.parse(JSON.stringify(record.ceiling)) as unknown, cells: [...record.cells], standing: current === undefined ? 'revoked' : 'admitted' });
  }
  return found;
}

// ---- 32-25: talking to the hub (D-41, D-47, D-48) -------------------------------------------------------------------------------------------------

/** Where the lead's device reaches the hub: the address the operator published (the roster keeps the pin and the writer id, not the address), and
 *  which hub when the project has more than one in force. */
export interface HubEndpoint { address: string; hub?: string }

/** The calls these flows make; a test may hand in transports with a short connect limit or another address. */
export type HubCalls = Pick<HubTransport, 'registerInvite' | 'postJoin' | 'joinRequests' | 'enrol' | 'close'>;
export type OpenHub = (options: HubTransportOptions) => HubCalls;
export const openHubTransport: OpenHub = (options) => new HubTransport(options);

/** A refusal with the hub named, as connectProjectToHub returns it. */
const refuseWith = (reason: HubMembershipRefusal, extra: Partial<HubMembershipResult>): HubMembershipResult => ({ ...refuse(reason), ...extra });

/** The hub in force for a lead flow, with its pin from the roster, checked before anything is written or sent. */
async function hubForLead(shared: SharedProjectHost, endpoint: HubEndpoint): Promise<{ hub: HubInForce; certPin: string } | HubMembershipResult> {
  const { roster } = await shared.project.state();
  const problem = writerProblem(shared, roster);
  if (problem !== undefined) return problem;
  const at = headOf(roster);
  const hub = hubOf(roster, at.position, endpoint.hub);
  if (isResult(hub)) return hub;
  const certPin = hubAt(roster.members, hub.hub, at.position)?.certPin;
  if (certPin === undefined) return refuse('hub-revoked');
  if (!isHubAddress(endpoint.address)) return refuse('hub-address-invalid');
  return { hub, certPin };
}

/** A transport failure of a lead flow as its plain refusal. */
function leadFailure(error: unknown): HubMembershipResult {
  if (!(error instanceof HubTransportError)) throw error;
  if (error.failure === 'unreachable' || error.failure === 'rate-limited') return refuse('hub-unreachable');
  if (error.failure === 'session-refused') return refuse('hub-session-refused');
  return refuse('hub-refused');
}

/**
 * Invites one person to a project on your organization's hub (D-47, D-48): writes member.invite exactly as inviteToProject does, then gives the file
 * the hub field (address, certificate pin and writer id) from the same roster record and kept secret, the same capability in one file, and registers
 * the invitation with the hub: its id, its expiry and the hub check key derived from the secret, never the secret. When the hub cannot be told, the
 * invitation is still made and returned without the hub field, so it works by file exactly as in Phase 31, and the result says so (registered false).
 * Refused before anything is written as every roster change, and with no hub in force.
 */
export function inviteThroughHub(shared: SharedProjectHost, input: InviteInput, endpoint: HubEndpoint, open: OpenHub = openHubTransport): Promise<HubMembershipResult> {
  return guarded(async () => {
    const { project, deps } = shared;
    const found = await hubForLead(shared, endpoint);
    if (isResult(found)) return found;
    const invited = await inviteToProject(shared, input);
    if (!invited.ok || invited.file === undefined || invited.invite === undefined) return invited;
    const read = readInvite(invited.file.text, now(shared));
    const secret = await joinSecret(deps.secrets, invited.invite);
    if (!read.ok || secret === undefined || secret !== read.invite.secret) return refuseMembership('invite-not-remade');
    const payload = read.invite;
    const when = payload.expiresAt.slice(0, 10);
    const what = payload.forMember === undefined ? `The invitation for ${input.name} is ready.` : `The invitation for ${input.name}'s other computer is ready.`;
    const rest = `Send the file to them any way you like. It works once and expires on ${when}. When their join request comes back, compare the six words with them out loud or in person before you admit them.`;
    let registered = false;
    let transport: HubCalls | undefined;
    try {
      transport = open({ address: endpoint.address, project: project.projectId, hub: found.hub.writer, trust: { pin: found.certPin }, signer: project.signer, now: () => now(shared) });
      await transport.registerInvite({ invite: payload.invite, expiresAt: payload.expiresAt, checkKey: hubJoinCheckKey(secret, payload.invite) });
      registered = true;
    } catch {
      // The invitation is in the roster and its file is made: a hub that cannot be told leaves it working by file.
    } finally {
      transport?.close();
    }
    if (!registered) return done(`${what} ${HUB_NOT_TOLD_TEXT} ${rest}`, { file: invited.file, invite: payload.invite, registered: false, hub: found.hub.hub });
    const signed = await settled(buildInviteAsync(project.rosterSigner, {
      genesisHash: payload.genesisHash, project: payload.project, name: payload.name,
      lead: { member: payload.lead.member, x25519: payload.lead.x25519, publicKey: payload.lead.publicKey },
      inviter: { member: payload.inviter.member, x25519: payload.inviter.x25519 }, invite: payload.invite, secret, expiresAt: payload.expiresAt, now: now(shared),
      ...(payload.forMember === undefined ? {} : { forMember: payload.forMember }), ...(payload.requires === undefined ? {} : { requires: payload.requires }),
      hub: { address: endpoint.address, certPin: found.certPin, writer: found.hub.writer }
    }));
    return done(`${what} Your organization's hub knows it, so their join request can come back through the hub. ${rest}`, {
      file: { name: invited.file.name, text: JSON.stringify(signed) }, invite: payload.invite, registered: true, hub: found.hub.hub
    });
  });
}

const HUB_JOIN_REFUSAL: Readonly<Record<string, HubMembershipRefusal>> = {
  'unknown-invite': 'hub-unknown-invite',
  'invite-expired': 'hub-invite-expired',
  'invite-used': 'hub-invite-used',
  'invite-voided': 'hub-invite-voided',
  'invite-locked': 'hub-invite-locked',
  'invite-full': 'hub-invite-full'
};

const inviteRefused = (reason: InviteRefusal): HubMembershipResult => refused(reason, Object.hasOwn(MEMBERSHIP_REFUSALS, reason) ? MEMBERSHIP_REFUSALS[reason as keyof typeof MEMBERSHIP_REFUSALS] : INVITE_REFUSALS[reason]);

/**
 * The joining person's side through the hub (D-48): reads the invitation, refuses one without a hub field (no-hub-in-invitation, nothing sent), checks
 * that the join request is this computer's own answer to this invitation (the person holds the secret, so the whole Phase 31 check runs here first),
 * makes the hub MAC under the check key derived from the invitation's secret and the envelope signed by this device (invite.ts), and posts both to the
 * hub the invitation names, trusted by its pin. The result tells the person to read the six words to the staff lead; every refusal ends with sending
 * the join request file to the staff lead any way they like.
 */
export async function sendJoinRequestThroughHub(inviteText: unknown, requestText: unknown, deps: ReplicaProjectDeps, open: OpenHub = openHubTransport): Promise<HubMembershipResult> {
  const at = deps.now?.() ?? new Date();
  const read = readInvite(inviteText, at);
  if (!read.ok) return inviteRefused(read.reason);
  const invite = read.invite;
  const hub = invite.hub;
  if (hub === undefined) return refuse('no-hub-in-invitation');
  const checked = checkJoinRequest(requestText, { invite, secret: invite.secret, now: at });
  if (!checked.ok) return inviteRefused(checked.reason);
  const device = await ReplicaProject.localDevice(deps);
  if (device.publicKey !== checked.request.publicKey) return inviteRefused('wrong-device');
  let request: SignedPayload<JoinRequestPayload>;
  try {
    request = (typeof requestText === 'string' ? JSON.parse(requestText) : requestText) as SignedPayload<JoinRequestPayload>;
  } catch {
    return inviteRefused('malformed');
  }
  const fields = { hub: hub.writer, project: invite.project, invite: invite.invite, request: joinRequestHash(request) };
  const join = await settled(buildHubJoinAsync(device.rosterSigner, { hub: hub.writer, project: invite.project, request, hubMac: hubJoinMac(hubJoinCheckKey(invite.secret, invite.invite), fields), now: at }));
  let transport: HubCalls | undefined;
  try {
    transport = open({ address: hub.address, project: invite.project, hub: hub.writer, trust: { pin: hub.certPin }, signer: device.signer, now: () => deps.now?.() ?? new Date() });
    await transport.postJoin({ join, request });
  } catch (error) {
    if (!(error instanceof HubTransportError)) throw error;
    if (error.failure === 'unreachable') return refuse('hub-join-unreachable');
    if (error.failure === 'rate-limited') return refuse('hub-busy');
    const mapped = error.failure === 'hub-error' && error.reason !== undefined ? HUB_JOIN_REFUSAL[error.reason] : undefined;
    return refuse(mapped ?? 'hub-join-refused');
  } finally {
    transport?.close();
  }
  const safetyWords = inviteSafetyCode(invite, checked.request);
  return done(`Your join request reached your organization's hub, and the staff lead's computer hears of it at once. Read these six words to the staff lead out loud or in person: ${safetyWords.join(' ')}. They admit you only if the words match.`, {
    safetyWords, invite: invite.invite, writer: device.writer
  });
}

/**
 * The join requests your organization's hub kept for this project in the last 7 days, for a device of the lead or the deputy (D-48). Each text is
 * untrusted until reviewJoinRequest and admitJoinRequest check it with the real secret and the six words; fetching admits nobody and writes nothing.
 */
export function fetchJoinRequests(shared: SharedProjectHost, endpoint: HubEndpoint, open: OpenHub = openHubTransport): Promise<HubMembershipResult> {
  return guarded(async () => {
    const found = await hubForLead(shared, endpoint);
    if (isResult(found)) return found;
    let transport: HubCalls | undefined;
    let requests: HubJoinRequest[];
    try {
      transport = open({ address: endpoint.address, project: shared.project.projectId, hub: found.hub.writer, trust: { pin: found.certPin }, signer: shared.project.signer, now: () => now(shared) });
      requests = (await transport.joinRequests()).map((item) => ({ invite: item.invite, text: item.request, receivedAt: item.receivedAt }));
    } catch (error) {
      return leadFailure(error);
    } finally {
      transport?.close();
    }
    const count = requests.length;
    const message = count === 0
      ? 'No join request is waiting at your organization\'s hub.'
      : `${count === 1 ? 'One join request is' : `${count} join requests are`} waiting at your organization's hub. Check each one and compare the six words with the person before you admit them.`;
    return done(message, { requests, hub: found.hub.hub });
  });
}

/**
 * Connects the project to your organization's hub in one step (D-41): admits the hub from the operator's hub file (admitHub; a hub already admitted
 * with the same key and pin is the resume case), then enrols the project: the genesis and every roster entry, the blobs they cite, every signed grant
 * this device holds and the enrolment MAC under the hub file's secret (enrolmentRequest). An unreachable hub leaves the hub admitted and a second call
 * finishes the enrolment; a used, expired or unknown enrolment is refused with the sentence asking the operator for a new hub file.
 */
export function connectProjectToHub(shared: SharedProjectHost, hubFileText: unknown, input: AdmitHubInput, open: OpenHub = openHubTransport): Promise<HubMembershipResult> {
  return guarded(async () => {
    const read = readHubFile(hubFileText, now(shared));
    if (!read.ok) return refused(read.reason, HUB_FILE_REFUSALS[read.reason]);
    const file = read.hubFile;
    const admitted = await admitHub(shared, hubFileText, input);
    if (!admitted.ok && admitted.reason !== 'hub-already-admitted') return admitted;
    const { project } = shared;
    const { roster } = await project.state();
    const body = await enrolmentRequest(syncLocalOf(project), { enrolment: file.enrolment, enrolmentSecret: file.enrolmentSecret, hub: file.hub }, {
      genesisHash: project.anchor.genesisHash, rosterHead: headOf(roster).hash
    });
    const named = { hub: file.hub, writer: file.writer };
    let transport: HubCalls | undefined;
    try {
      transport = open({ address: file.address, project: project.projectId, hub: file.writer, trust: { pin: file.certPin }, signer: project.signer, now: () => now(shared) });
      await transport.enrol(body);
    } catch (error) {
      if (!(error instanceof HubTransportError)) throw error;
      if (error.failure === 'unreachable' || error.failure === 'rate-limited') return refuseWith('enrol-unreachable', named);
      const reason = error.failure === 'hub-error' ? error.reason : undefined;
      if (reason === 'project-exists') return done(`${hubName(file)} already holds this project, so it is connected. Nothing more was sent.`, named);
      if (reason === 'enrolment-used' || reason === 'enrolment-expired' || reason === 'enrolment-unknown' || reason === 'bad-mac') return refuseWith('enrol-refused', named);
      return refuseWith('enrol-not-taken', named);
    } finally {
      transport?.close();
    }
    return done(`${hubName(file)} now holds the project. Every computer of the project can sync with it, and it reads the roster and nothing else until you give it a part of the project.`, named);
  });
}

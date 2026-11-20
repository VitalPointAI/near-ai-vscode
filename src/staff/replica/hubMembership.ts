// Your organization's hub as a member of the roster (D-22, D-40, D-41, D-64; DESIGN 10.2). The host flows behind the hub roster steps; the commands
// (Phase 33) only show dialogs and call these, and enrolment with the hub over the network is 32-25, which reads the hub file again. Node I/O through
// ReplicaProject and the membership flows only; never imports vscode.
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
import { REKEY_KEEP_TEXT, earlierEpochGrants } from '../../domain/replica/cellKeys';
import { HUB_FILE_REFUSALS, readHubFile } from '../../domain/replica/hubFile';
import type { HubFilePayload } from '../../domain/replica/hubFile';
import type { RosterState } from '../../domain/replica/roster';
import { readLegacyCellLabel } from '../../domain/replica/productCells';
import { epochsAt } from '../../domain/replica/rosterCells';
import { MEMBER_REFUSALS, devicesOfMemberAt, hubAt } from '../../domain/replica/rosterMembers';
import { MAX_SLOT } from '../../domain/replica/clientIds';
import { isRecord } from '../../domain/team/validate';
import { multiUserNoticeLines } from '../../domain/staff/multiUser';
import { MEMBERSHIP_REFUSALS, append, cellsAt, clearedFor, finishRekeys, gateOf, headOf, unfinishedRekeys, writerProblem } from './membership';
import type { MembershipResult, SharedProjectHost } from './membership';
import { ReplicaProjectError, isProjectRefused } from './replicaProject';

/** Shown to the lead at each grant of a cell to the hub (DESIGN 10.2), word for word; the lead confirms it before anything is written. */
export const HUB_GRANT_TRADE_OFF = 'The hub will be able to read everything in this cell. Anyone who takes over the hub server can read it too. Grant only cells whose watches must run when nobody is at a computer.';

/** The hub flows' own refusals, one plain sentence each (D-37). None names a key, a secret or a hash, and none uses a dash as punctuation. */
export const HUB_MEMBERSHIP_REFUSALS = {
  'device-exists': MEMBER_REFUSALS['device-exists'],
  'member-exists': MEMBER_REFUSALS['member-exists'],
  'trade-off-not-confirmed': `Nothing was given to the hub, because the trade-off was not confirmed. Give the hub this part of the project only after reading and confirming this: ${HUB_GRANT_TRADE_OFF}`,
  'legacy-cell': 'This part of the project holds its history from before it was shared. It stays with the staff lead and the deputy lead only, so it is never given to the hub. Nothing was changed.',
  'above-hub-ceiling': 'This part of the project is labelled above the highest clearance you set for the hub, so it was not given to the hub. Nothing was changed.',
  'hub-holds-cell': 'The hub already holds this part of the project, so nothing was changed.',
  'cell-unknown': 'That part of the project is not in the roster, so nothing was given to the hub. Nothing was changed.',
  'no-hub': 'This project has no hub admitted, so nothing was changed. Admit your organization\'s hub first.',
  'hub-not-named': 'This project has more than one hub admitted, so say which hub the change is for. Nothing was changed.',
  'hub-unknown': 'That hub is not in this project\'s roster, so nothing was changed. Check the hub and try again.',
  'hub-revoked': 'That hub was removed from the project, so it is given nothing more and is never admitted again. Nothing was changed.'
} as const;
export type HubMembershipRefusal = keyof typeof HUB_MEMBERSHIP_REFUSALS;

/** What every hub flow returns: a membership result, with the hub's id (hub- and 16 hex) and its device's writer id when one is named. */
export interface HubMembershipResult extends MembershipResult { hub?: string }

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

/**
 * Signs and stores one grant per epoch of the cell to the hub's X25519 key, each at the roster that gave the hub the cell (or the epoch's own founding
 * entry when that came later, since a grant may not name a roster before its epoch). The keys are checked by the caller before anything is written.
 */
async function grantEpochs(shared: SharedProjectHost, input: { cell: string; epochs: ReadonlyArray<{ epoch: number; from: number; key: Buffer }>; roster: RosterState; grantedAt: number; hub: { writer: string; x25519: string }; label?: unknown }): Promise<HubMembershipResult | undefined> {
  const byRoster = new Map<number, Array<{ epoch: number; key: Buffer }>>();
  for (const item of input.epochs) {
    const at = Math.max(input.grantedAt, item.from);
    byRoster.set(at, [...(byRoster.get(at) ?? []), { epoch: item.epoch, key: item.key }]);
  }
  const grants = [...byRoster.entries()].flatMap(([at, epochs]) => earlierEpochGrants(shared.project.signer, {
    cell: input.cell, epochs, roster: input.roster.positions[at], writer: input.hub.writer, recipient: input.hub.x25519, ...(input.label === undefined ? {} : { label: input.label })
  }));
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
    const before = (await project.state()).roster;
    const problem = writerProblem(shared, before);
    if (problem !== undefined) return problem;
    const base = project.projectId;
    if (before.members.members.has(file.hub) || before.members.hubs.has(file.hub)) return refuse('member-exists');
    if (before.members.devices.has(file.writer)) return refuse('device-exists');
    const slot = freeSlot(before);
    if (slot === undefined) return refused('device-limit', MEMBER_REFUSALS['device-limit']);
    // Every base cell key is checked before the first write, so a device that cannot give the hub the roster writes nothing.
    if (epochKeys(shared, base, epochsAt(before.cells, base, headOf(before).position)) === undefined) return refuseMembership('no-grant-key');
    const device = { writer: file.writer, publicKey: file.publicKey, x25519: file.x25519, x25519Sig: file.x25519Sig, slot };
    const admitted = await append(shared, 'hub.admit', { hub: file.hub, device, certPin: file.certPin, ceiling: input.ceiling });
    if (isResult(admitted)) return admitted;
    const granted = await append(shared, 'hub.grant', { hub: file.hub, cell: base });
    if (isResult(granted)) return granted;
    const roster = granted.roster;
    const grantedAt = roster.positionOf.get(granted.hash) as number;
    const missing = epochKeys(shared, base, missingEpochs(roster, base, file.writer, headOf(roster).position));
    if (missing === undefined) return refuseMembership('no-grant-key');
    const stored = await grantEpochs(shared, { cell: base, epochs: missing, roster, grantedAt, hub: file });
    if (stored !== undefined) return stored;
    return done(`${hubName(file)} was admitted. It can read the roster, so it can check every change sent to it, and nothing else until you give it a part of the project.`, { hub: file.hub, writer: file.writer });
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
    if (holds && missingEpochs(roster, info.cell, hub.writer, at.position).length === 0) return refuse('hub-holds-cell');
    if (!info.known) return refuseMembership('no-grant-key');
    if (!clearedFor(hub.ceiling, info, false, gate)) return refuse('above-hub-ceiling');
    if (epochKeys(shared, info.cell, missingEpochs(roster, info.cell, hub.writer, at.position)) === undefined) return refuseMembership('no-grant-key');
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
    const stored = await grantEpochs(shared, { cell: info.cell, epochs: missing, roster: current, grantedAt, hub, ...(info.base ? {} : { label: info.raw }) });
    if (stored !== undefined) return stored;
    return done(`The hub (${hub.hub}) can now read this part of the project, and every new key it gets.`, {
      notices: [...multiUserNoticeLines(), HUB_GRANT_TRADE_OFF], granted: [info.cell], hub: hub.hub, writer: hub.writer
    });
  });
}

/** What a revoke says: who was removed, how many cells moved to a new key, and the agreed words on what the hub keeps. */
function revokeMessage(first: string, rekeyed: readonly string[]): string {
  const moved = rekeyed.length === 0 ? '' : ` ${rekeyed.length === 1 ? 'One part of the project was' : `${rekeyed.length} parts of the project were`} moved to a new key.`;
  return `${first}${moved} ${REKEY_KEEP_TEXT}`;
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
      const finished = await finishRekeys(shared);
      if (!finished.ok) return finished;
      return done(revokeMessage(`The removal of the hub (${input.hub}) left unfinished is now finished.`, finished.rekeyed ?? []), { rekeyed: finished.rekeyed ?? [], hub: input.hub });
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
    const written = await append(shared, 'hub.revoke', { hub: hub.hub });
    if (isResult(written)) return written;
    const finished = await finishRekeys(shared);
    if (!finished.ok && finished.reason !== 'nothing-to-finish') return finished;
    const rekeyed = finished.ok ? finished.rekeyed ?? [] : [];
    const note = earlier.length === 0 ? '' : `A removal or clearance change left unfinished was finished first: ${earlier.length === 1 ? 'one part of the project was' : `${earlier.length} parts of the project were`} moved to a new key. `;
    return done(`${note}${revokeMessage(`Your organization's hub (${hub.hub}) was removed from the project, and it signs nothing for the project from now on.`, rekeyed)}`, {
      rekeyed: [...earlier, ...rekeyed], hub: hub.hub, writer: hub.writer
    });
  });
}

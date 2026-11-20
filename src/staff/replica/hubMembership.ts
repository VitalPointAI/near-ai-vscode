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
import { earlierEpochGrants } from '../../domain/replica/cellKeys';
import { HUB_FILE_REFUSALS, readHubFile } from '../../domain/replica/hubFile';
import type { HubFilePayload } from '../../domain/replica/hubFile';
import type { RosterState } from '../../domain/replica/roster';
import { epochsAt } from '../../domain/replica/rosterCells';
import { MEMBER_REFUSALS } from '../../domain/replica/rosterMembers';
import { MAX_SLOT } from '../../domain/replica/clientIds';
import { isRecord } from '../../domain/team/validate';
import { multiUserNoticeLines } from '../../domain/staff/multiUser';
import { MEMBERSHIP_REFUSALS, append, headOf, writerProblem } from './membership';
import type { MembershipResult, SharedProjectHost } from './membership';
import { ReplicaProjectError, isProjectRefused } from './replicaProject';

/** The hub flows' own refusals, one plain sentence each (D-37). None names a key, a secret or a hash, and none uses a dash as punctuation. */
export const HUB_MEMBERSHIP_REFUSALS = {
  'device-exists': MEMBER_REFUSALS['device-exists'],
  'member-exists': MEMBER_REFUSALS['member-exists']
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

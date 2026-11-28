// Which wrap format each cell key gets, and to whom (33.2 D-05, D-06, D-07, D-09). Node only, never imports vscode. Every host path that hands out a
// cell epoch key (a new cell, a rekey, a later grant at admission, the hub's grant, the genesis) asks formatFor here and wraps through
// grantPages.wrapsFor / earlierEpochGrants, which call wrapForDevice: one place decides, so a path added later cannot pick the older format.
//
//   the project requires wrap@2 and the epoch is new or founded after the switch   -> v2 (wrapFormat.ts, the same rule the fold and the hub check)
//   a cell whose label routes local-only or nowhere (Protected B and above)          -> v2 when switched; refused 'switch-first' when not (D-07)
//   an epoch from before the switch, in a switched project                           -> 'best': v2 to a device with v2 keys, else v1
//   an unswitched project                                                            -> v1, as before
// A device without keys of the chosen format gets no wrap and is listed as waiting for keys; it is never given the older format instead.
import { tierForLabel, tierForMark, DEFAULT_ROUTING } from '../../domain/gate/routing';
import type { RoutingTable } from '../../domain/gate/routing';
import type { Label } from '../../domain/gate/labels';
import type { CellGrant } from '../../domain/replica/cellKeys';
import { kemKeysAt } from '../../domain/replica/deviceKem';
import { buildGrantPages, earlierEpochGrants, wrapsFor } from '../../domain/replica/grantPages';
import type { WrapDevice } from '../../domain/replica/grantPages';
import type { PayloadSigner, SignedPayload } from '../../domain/team/signedPayload';
import type { RosterState } from '../../domain/replica/roster';
import { epochAt, epochsAt, granteesAt } from '../../domain/replica/rosterCells';
import { deviceAt, x25519At } from '../../domain/replica/rosterMembers';
import { WRAP_FEATURE, wrapFormatFor } from '../../domain/replica/wrapFormat';

/** The D-07 sentence, word for word. */
export const SWITCH_FIRST_TEXT = 'Switch this shared work to post-quantum keys before sharing Protected B work.';

/** A cell as formatFor needs it: the base cell, a labelled cell, or the legacy cell with its set of labels. */
export interface WrapCell { base: boolean; label?: Label; legacy?: readonly Label[] }

/** True for a cell whose label routes local-only or nowhere under the routing table (by default Protected B, Protected C and every classified level). */
export function isProtectedCell(cell: WrapCell, routing: RoutingTable = DEFAULT_ROUTING): boolean {
  if (cell.base) return false;
  const tier = cell.legacy !== undefined ? tierForMark(cell.legacy, routing) : cell.label === undefined ? 'deny' : tierForLabel(cell.label, routing);
  return tier === 'local-only' || tier === 'deny';
}

/**
 * The format for a wrap of one epoch of a cell: foundedAt is the roster position the epoch was founded at, undefined for an epoch about to be
 * founded. 'switch-first' means the cell may not be shared in this project until the lead switches it to post-quantum keys (D-07).
 */
export type WrapChoice = 1 | 2 | 'best' | 'switch-first';

export function formatFor(roster: Pick<RosterState, 'requiredFrom'>, cell: WrapCell, foundedAt: number | undefined, routing?: RoutingTable): WrapChoice {
  const switchedAt = roster.requiredFrom.get(WRAP_FEATURE);
  if (wrapFormatFor(switchedAt, foundedAt) === 'v2') return 2;
  if (isProtectedCell(cell, routing)) return switchedAt === undefined ? 'switch-first' : 2;
  return switchedAt === undefined ? 1 : 'best';
}

/** The format one device's wrap gets under a choice: 'best' is v2 for a device with v2 keys, else v1. Never called with 'switch-first'. */
export function formatForDevice(choice: Exclude<WrapChoice, 'switch-first'>, device: WrapDevice): 1 | 2 {
  if (choice === 'best') return device.kem === undefined ? 1 : 2;
  return choice;
}

/** A device's keys as the roster names them at a position: its X25519 key and its post-quantum keys (device.kem or its descriptor). */
export function wrapDeviceAt(roster: RosterState, writer: string, position: number): WrapDevice {
  const x25519 = x25519At(roster.members, writer, position);
  const kem = kemKeysAt(roster, writer);
  return { writer, ...(x25519 === undefined ? {} : { x25519 }), ...(kem === undefined ? {} : { kem }) };
}

/** A later recipient may lack the founding grant. Its key can still be used if no device was removed during that epoch. */
export function canWriteCurrentEpoch(roster: RosterState, cell: string, epoch: number): boolean {
  const head = roster.positions.length - 1;
  if (epochAt(roster.cells, cell, head) !== epoch) return false;
  const holders = granteesAt(roster.cells, cell, head, () => true);
  if (holders !== undefined) return holders.every((writer) => deviceAt(roster.members, writer, head) !== undefined);
  const founded = epochsAt(roster.cells, cell, head).at(-1)?.from;
  if (founded === undefined) return false;
  for (const devices of roster.members.devices.values()) {
    if (devices.some((device) => device.until !== undefined && device.until > founded && device.until <= head)) return false;
  }
  return true;
}

/** True when a required hybrid rotation has recipients but none can receive its new key. */
export function awaitsHybridRecipients(roster: RosterState, info: WrapCell, recipients: readonly string[], routing?: RoutingTable): boolean {
  return recipients.length > 0 && formatFor(roster, info, undefined, routing) === 2 &&
    recipients.every((writer) => kemKeysAt(roster, writer) === undefined);
}

/** One epoch of a cell planned for a grant: its key and the format choice formatFor gave it (never switch-first: such an epoch is not planned). */
export interface PlannedEpoch { epoch: number; key: Buffer; choice: Exclude<WrapChoice, 'switch-first'> }

/**
 * The grants of planned epochs to one device at the roster `at` (a roster that admits it), each wrap in its epoch's format with the device's keys as
 * `roster` names them (33.2 D-05). An epoch the device has no keys for is left out: the device waits for its keys.
 */
export function grantsTo(signer: PayloadSigner, roster: RosterState, at: string, writer: string, plans: ReadonlyArray<{ cell: string; epochs: readonly PlannedEpoch[]; raw?: unknown }>): Array<SignedPayload<CellGrant>> {
  const device = wrapDeviceAt(roster, writer, roster.positionOf.get(at) ?? roster.positions.length - 1);
  return plans.flatMap((plan) => earlierEpochGrants(signer, {
    cell: plan.cell, roster: at, writer, ...(device.x25519 === undefined ? {} : { recipient: device.x25519 }), ...(device.kem === undefined ? {} : { kem: device.kem }),
    epochs: plan.epochs.map((item) => ({ epoch: item.epoch, key: item.key, format: formatForDevice(item.choice, device) })),
    ...(plan.raw === undefined ? {} : { label: plan.raw })
  }));
}

/**
 * The signed pages of a new epoch's founding grant, wrapped to each recipient in the format formatFor gives a new epoch of the cell (33.2 D-05 to
 * D-07): 'switch-first' when the cell may not get a new key the older way, and no pages when no recipient has keys of that format.
 */
export function newEpochPages(signer: PayloadSigner, roster: RosterState, input: NewEpochInput): Array<SignedPayload<CellGrant>> | 'switch-first' {
  const grant = newEpochGrant(roster, input);
  return grant === 'switch-first' || grant === undefined ? (grant ?? []) : buildGrantPages(signer, grant);
}

export interface NewEpochInput { cell: string; info: WrapCell; epoch: number; key: Buffer; recipients: readonly string[]; labelSealed: string; routing?: RoutingTable }

/**
 * The unsigned grant newEpochPages signs, for a signer that answers later (ReplicaProject.signGrantPages, the person key in a hosted session):
 * 'switch-first' as there, and undefined when no recipient has keys of the new epoch's format.
 */
export function newEpochGrant(roster: RosterState, input: NewEpochInput): CellGrant | 'switch-first' | undefined {
  const choice = formatFor(roster, input.info, undefined, input.routing);
  if (choice === 'switch-first') return choice;
  const head = roster.positions.length - 1;
  const wraps = input.recipients.flatMap((writer) => {
    const device = wrapDeviceAt(roster, writer, head);
    if (device.x25519 === undefined) throw new Error('The cell key was not moved: a device to receive it has no encryption key in the roster.');
    return wrapsFor({ format: formatForDevice(choice, device), cell: input.cell, epoch: input.epoch, epochKey: input.key, devices: [device] }).wraps;
  });
  return wraps.length === 0 ? undefined : { cell: input.cell, epoch: input.epoch, roster: roster.positions[head] as string, labelSealed: input.labelSealed, wraps };
}

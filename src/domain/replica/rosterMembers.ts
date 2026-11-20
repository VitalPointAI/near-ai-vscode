// Members, devices, invites and hubs of the roster (DESIGN 7.1, 7.3, 7.4, 15.1, 15.2; D-10, D-12, D-14 to D-20, D-41). Hub-side and pure: no clock,
// no I/O. The roster driver (roster.ts) routes the member, device, hub and invite kinds here through ROSTER_KIND_OWNER after it has checked the
// signature, the citation and the writer's authority; this module decides what each kind does to the member state.
//
// Every record carries the position it starts at (from) and, once ended, the position it ends at (until), so every query takes a position and the
// roster view answers at the roster an entry cites (D-11). A record is in force at position p when from <= p and (until is absent or p < until).
//
// Owner of the apply rules for each kind: 31-12 (this file's first version) applies the genesis lead device, member.invite and member.admit; every
// other kind routed here is refused roster-kind-pending until 31-14 adds its rule. A pending kind is refused, never applied.
import { verifySignature } from '../team/canonical';
import { x25519BindingBytes } from './cellKeys';
import { isSlot } from './clientIds';
import type { VerifiedEntry } from './verify';

export const MEMBER_REFUSALS = {
  'invite-unknown': 'This names an invitation the roster does not have at the roster it follows.',
  'invite-exists': 'An invitation with this id is already in the roster, so this one is refused.',
  'invite-expired': 'The invitation had expired when this admission was written.',
  'invite-voided': 'The invitation was cancelled, so it cannot admit anyone.',
  'invite-used': 'The invitation was already used, and an invitation admits only once.',
  'invite-for-device': 'This invitation adds a device for an existing member, so it cannot admit a new member.',
  'member-exists': 'A member with this id is already in the roster.',
  'member-unknown': 'This names a member the roster does not have at the roster it follows.',
  'lead-role-by-handover-only': 'The staff lead and deputy lead roles are given only by the genesis, a handover or naming the deputy.',
  'slot-in-use': 'This device slot was already given to another device, and a slot is never reused.',
  'slot-out-of-range': 'The device needs a roster slot from 1 to 4095.',
  'device-exists': 'This device is already in the roster.',
  'bad-binding': 'The device did not sign its encryption key with its signing key, so the keys do not belong together.'
} as const;
export type MemberRefusal = keyof typeof MEMBER_REFUSALS;
export type MemberApplyOutcome = { status: 'applied' } | { status: 'refused'; reason: MemberRefusal | 'roster-kind-pending' };

// The lead the pinned anchor names: the origin roster (position 0) holds exactly this member and device.
export interface MembersAnchor { lead: { member: string; writer: string; publicKey: string; x25519: string } }

export interface MemberRecord {
  member: string;
  name: string;
  seat?: string;
  roles: readonly string[];
  clearance?: unknown;
  agentSeats: readonly string[];
  // The invitation that admitted the member; absent for the lead named by the anchor.
  invite?: string;
  from: number;
  until?: number;
}
export interface DeviceRecord {
  writer: string;
  member: string;
  publicKey: string;
  x25519: string;
  slot?: number;
  kind: 'person' | 'hub';
  from: number;
  until?: number;
}
export interface InviteRecord {
  invite: string;
  name: string;
  seat: string;
  roles: readonly string[];
  clearance: unknown;
  expiresAt: string;
  secretHash: string;
  forMember?: string;
  from: number;
  usedAt?: number;
  usedBy?: string;
  voidedAt?: number;
}
export interface MembersState {
  // Versions of each member, oldest first; at most one is in force at a position.
  members: Map<string, MemberRecord[]>;
  // Versions of each device by writer id, oldest first.
  devices: Map<string, DeviceRecord[]>;
  // Every slot ever given, to the writer it was given to. Never shrinks, so a slot is never reused (D-41).
  slots: Map<number, string>;
  invites: Map<string, InviteRecord>;
  // device.release choices by writer, stream and seq (31-14).
  releases: Map<string, string>;
}

// What the driver tells this module about the entry it routes here. position is the position the entry takes when it applies; the roster it cites
// is position - 1. lead and deputy are the members holding those roles at the cited roster.
export interface MemberApplyContext { position: number; lead: string; deputy?: string }

interface DeviceDescriptor { writer: string; publicKey: string; x25519: string; x25519Sig: string; slot?: number }

const inForce = (record: { from: number; until?: number }, position: number): boolean => record.from <= position && (record.until === undefined || position < record.until);
const LEAD_ROLES: readonly string[] = ['staff_lead', 'deputy_lead'];

export function createMembersState(anchor: MembersAnchor): MembersState {
  const { member, writer, publicKey, x25519 } = anchor.lead;
  return {
    members: new Map([[member, [{ member, name: member, roles: ['member'], agentSeats: [], from: 0 }]]]),
    devices: new Map([[writer, [{ writer, member, publicKey, x25519, kind: 'person', from: 0 }]]]),
    slots: new Map(),
    invites: new Map(),
    releases: new Map()
  };
}

// ---- queries: every answer is at a position ----

export function memberAt(state: MembersState, member: string, position: number): MemberRecord | undefined {
  return state.members.get(member)?.find((record) => inForce(record, position));
}

// The device's record in force at the position, or undefined when it is not admitted there.
export function deviceAt(state: MembersState, writer: string, position: number): DeviceRecord | undefined {
  return state.devices.get(writer)?.find((record) => inForce(record, position));
}

// The device's signing key at any position, so a signature can be checked before the sealed body (and the roster it cites) is read.
export function deviceKeyOf(state: MembersState, writer: string): { publicKey: string; member: string } | undefined {
  const first = state.devices.get(writer)?.[0];
  return first === undefined ? undefined : { publicKey: first.publicKey, member: first.member };
}

export function devicesOfMemberAt(state: MembersState, member: string, position: number): DeviceRecord[] {
  const found: DeviceRecord[] = [];
  for (const versions of state.devices.values()) {
    const record = versions.find((candidate) => inForce(candidate, position));
    if (record !== undefined && record.member === member) found.push(record);
  }
  return found.sort((a, b) => (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
}

export function seatsAt(state: MembersState, member: string, position: number): readonly string[] {
  return memberAt(state, member, position)?.agentSeats ?? [];
}

// The writer whose device holds the slot at the position.
export function slotOwnerAt(state: MembersState, slot: number, position: number): string | undefined {
  const writer = state.slots.get(slot);
  if (writer === undefined) return undefined;
  return deviceAt(state, writer, position)?.slot === slot ? writer : undefined;
}

export function x25519At(state: MembersState, writer: string, position: number): string | undefined {
  return deviceAt(state, writer, position)?.x25519;
}

export type InviteStanding = { state: 'open' | 'used' | 'voided'; expiresAt: string; forMember?: string };

// The invitation's standing at the position: open, used or voided. Expiry is decided by the signed time of the entry that uses it, never a clock.
export function inviteAt(state: MembersState, invite: string, position: number): InviteStanding | undefined {
  const record = state.invites.get(invite);
  if (record === undefined || record.from > position) return undefined;
  const standing = record.voidedAt !== undefined && record.voidedAt <= position ? 'voided' : record.usedAt !== undefined && record.usedAt <= position ? 'used' : 'open';
  return record.forMember === undefined ? { state: standing, expiresAt: record.expiresAt } : { state: standing, expiresAt: record.expiresAt, forMember: record.forMember };
}

// The branch a device.release chose at a fork slot (31-14 records them).
export function chosenBranchOf(state: MembersState, writer: string, stream: string, seq: number): string | undefined {
  return state.releases.get(`${writer}/${stream}/${seq}`);
}

// True when the writer is an admitted hub device at the position (31-14 admits hubs).
export function hubSignerAt(state: MembersState, writer: string, position: number): boolean {
  return deviceAt(state, writer, position)?.kind === 'hub';
}

// ---- apply rules ----

const refused = (reason: MemberRefusal | 'roster-kind-pending'): MemberApplyOutcome => ({ status: 'refused', reason });

// Why a new device cannot be added at this point, or undefined. The X25519 key must be bound by the device's own Ed25519 signature (D-19) and the slot
// must be in range and never given before (D-41).
function newDeviceProblem(state: MembersState, device: DeviceDescriptor): MemberRefusal | undefined {
  if (!isSlot(device.slot)) return 'slot-out-of-range';
  if (state.slots.has(device.slot)) return 'slot-in-use';
  if (!verifySignature(x25519BindingBytes(device.x25519, device.writer), device.x25519Sig, device.publicKey)) return 'bad-binding';
  return undefined;
}

// The genesis names the anchor's lead device with its slot and binding (D-07, D-41). The driver has already checked that the device is the anchor's;
// this closes the origin version of the device and opens one with the slot from the genesis position on, so the device is admitted throughout.
export function applyGenesisLead(state: MembersState, device: DeviceDescriptor, position: number): MemberApplyOutcome {
  const versions = state.devices.get(device.writer);
  const origin = versions?.[versions.length - 1];
  if (versions === undefined || origin === undefined || origin.until !== undefined) return refused('member-unknown');
  const problem = newDeviceProblem(state, device);
  if (problem !== undefined) return refused(problem);
  const opened: DeviceRecord = { writer: origin.writer, member: origin.member, publicKey: origin.publicKey, x25519: origin.x25519, slot: device.slot as number, kind: origin.kind, from: position };
  origin.until = position;
  versions.push(opened);
  state.slots.set(device.slot as number, device.writer);
  return { status: 'applied' };
}

interface InviteData { invite: string; name: string; seat: string; roles: string[]; clearance: unknown; expiresAt: string; secretHash: string; forMember?: string }
interface AdmitData { member: string; invite: string; name: string; seat: string; roles: string[]; clearance: unknown; device: DeviceDescriptor; agentSeats?: string[] }

function applyInvite(state: MembersState, data: InviteData, ctx: MemberApplyContext): MemberApplyOutcome {
  if (state.invites.has(data.invite)) return refused('invite-exists');
  if (data.roles.some((role) => LEAD_ROLES.includes(role))) return refused('lead-role-by-handover-only');
  if (data.forMember !== undefined && memberAt(state, data.forMember, ctx.position - 1) === undefined) return refused('member-unknown');
  const record: InviteRecord = { invite: data.invite, name: data.name, seat: data.seat, roles: [...data.roles], clearance: data.clearance, expiresAt: data.expiresAt, secretHash: data.secretHash, from: ctx.position };
  if (data.forMember !== undefined) record.forMember = data.forMember;
  state.invites.set(data.invite, record);
  return { status: 'applied' };
}

function applyAdmit(state: MembersState, entry: VerifiedEntry, data: AdmitData, ctx: MemberApplyContext): MemberApplyOutcome {
  const cited = ctx.position - 1;
  const invite = state.invites.get(data.invite);
  const standing = inviteAt(state, data.invite, cited);
  if (invite === undefined || standing === undefined) return refused('invite-unknown');
  if (standing.state === 'voided') return refused('invite-voided');
  if (standing.state === 'used') return refused('invite-used');
  if (invite.forMember !== undefined) return refused('invite-for-device');
  // Expiry from signed times only: the admission's own time against the invitation's expiry (D-17).
  if (Date.parse(entry.body.at) > Date.parse(invite.expiresAt)) return refused('invite-expired');
  if (state.members.has(data.member)) return refused('member-exists');
  if (data.roles.some((role) => LEAD_ROLES.includes(role))) return refused('lead-role-by-handover-only');
  if (state.devices.has(data.device.writer)) return refused('device-exists');
  const problem = newDeviceProblem(state, data.device);
  if (problem !== undefined) return refused(problem);
  state.members.set(data.member, [{ member: data.member, name: data.name, seat: data.seat, roles: [...data.roles], clearance: data.clearance, agentSeats: [...(data.agentSeats ?? [])], invite: data.invite, from: ctx.position }]);
  state.devices.set(data.device.writer, [{ writer: data.device.writer, member: data.member, publicKey: data.device.publicKey, x25519: data.device.x25519, slot: data.device.slot, kind: 'person', from: ctx.position }]);
  state.slots.set(data.device.slot as number, data.device.writer);
  invite.usedAt = ctx.position;
  invite.usedBy = data.member;
  return { status: 'applied' };
}

// Applies one member, device, hub or invite kind. The data was checked against its closed schema at verification. Validates first and changes the
// state only when the outcome is applied.
export function applyMemberEntry(state: MembersState, entry: VerifiedEntry, ctx: MemberApplyContext): MemberApplyOutcome {
  switch (entry.body.kind) {
    case 'member.invite':
      return applyInvite(state, entry.data as InviteData, ctx);
    case 'member.admit':
      return applyAdmit(state, entry, entry.data as AdmitData, ctx);
    default:
      // member.update, member.remove, device.*, hub.* and invite.void: 31-14 adds their rules.
      return refused('roster-kind-pending');
  }
}

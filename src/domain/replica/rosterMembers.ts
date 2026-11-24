// Members, devices, invites and hubs of the roster (DESIGN 7.1, 7.3, 7.4, 15.1, 15.2; D-10, D-12, D-14 to D-20, D-41). Hub-side and pure: no clock,
// no I/O. The roster driver (roster.ts) routes the member, device, hub and invite kinds here through ROSTER_KIND_OWNER after it has checked the
// signature, the citation and the writer's authority; this module decides what each kind does to the member state.
//
// Every record carries the position it starts at (from) and, once ended, the position it ends at (until), so every query takes a position and the
// roster view answers at the roster an entry cites (D-11). A record is in force at position p when from <= p and (until is absent or p < until).
//
// Owner of the apply rules: 31-12 wrote the genesis lead device, member.invite and member.admit; 31-14 completes every member, device, hub and invite
// kind. A kind with no rule yet is refused roster-kind-pending, never applied.
import { verifySignature } from '../team/canonical';
import { x25519BindingBytes } from './cellKeys';
import { MAX_SLOT, isSlot } from './clientIds';
import type { VerifiedEntry } from './verify';

export const MEMBER_REFUSALS = {
  'invite-unknown': 'This names an invitation the roster does not have at the roster it follows.',
  'invite-exists': 'An invitation with this id is already in the roster, so this one is refused.',
  'invite-expired': 'The invitation had expired when this entry was written.',
  'invite-voided': 'The invitation was cancelled, so it cannot admit anyone.',
  'invite-used': 'The invitation was already used, and an invitation admits only once.',
  'invite-for-device': 'This invitation adds a device for an existing member, so it cannot admit a new member.',
  'invite-wrong-member': 'This invitation was not made to add a device for this member.',
  'member-exists': 'A member or hub with this id is already in the roster, and an id is never given twice.',
  'member-unknown': 'This names a member the roster does not have at the roster it follows.',
  'lead-role-by-handover-only': 'The staff lead and deputy lead roles are given only by the genesis, a handover or naming the deputy.',
  'lead-not-removable': 'The staff lead cannot be removed. Hand the lead over first.',
  'last-lead-device': 'This is the last device of the staff lead, and revoking it would leave no device able to change the roster. Add another device or hand the lead over first.',
  'slot-in-use': 'This device slot was already given to another device, and a slot is never reused.',
  'slot-out-of-range': 'The device needs a roster slot from 1 to 4095.',
  'device-limit': 'All 4095 device slots of this project have been given, so no more devices can be added.',
  'device-exists': 'This device is already in the roster.',
  'bad-binding': 'The device did not sign its encryption key with its signing key, so the keys do not belong together.',
  'device-unknown': 'This names a device the roster does not have for that member at the roster it follows.',
  'quarantine-stream-unknown': 'This quarantine names a stream that is neither this project nor a part of it the roster has at the roster it follows, so it records nothing.',
  'quarantine-recorded': 'A quarantine for this device at this stream and position is already recorded, so this one records nothing new.',
  'hub-exists': 'A hub or member with this id is already in the roster, and an id is never given twice.',
  'hub-unknown': 'This names a hub the roster does not have at the roster it follows.',
  'hub-revoked': 'Your organization\'s server was removed from this shared work, so it cannot be trusted again. Admit it again as a new server instead.'
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
// A hub: a service member whose device may sign checkpoints (D-04, D-12). Its id shares one namespace with member ids.
export interface HubRecord {
  hub: string;
  certPin: string;
  ceiling: unknown;
  // The cells granted to the hub (hub.grant), in the order granted.
  cells: readonly string[];
  // True on a version a hub.readmit opened (Phase 33 D-42): the lead trusted this hub again from `from` on, with this certPin.
  readmit?: boolean;
  from: number;
  until?: number;
}
export interface MembersState {
  // Versions of each member, oldest first; at most one is in force at a position.
  members: Map<string, MemberRecord[]>;
  // Versions of each device by writer id, oldest first.
  devices: Map<string, DeviceRecord[]>;
  // Every slot ever given, to the writer it was given to. Never shrinks, so a slot is never reused (D-41).
  slots: Map<number, string>;
  invites: Map<string, InviteRecord>;
  // device.release choices by writer, stream and seq: the branch kept at a fork slot (D-20).
  releases: Map<string, string>;
  // Versions of each hub member, oldest first (D-04, D-12).
  hubs: Map<string, HubRecord[]>;
  // device.quarantine records by writer, stream and seq (D-48): record only, kept so the same fork position is never recorded twice.
  quarantines: Set<string>;
}

// What the driver tells this module about the entry it routes here. position is the position the entry takes when it applies; the roster it cites
// is position - 1. lead and deputy are the members holding those roles at the cited roster.
export interface MemberApplyContext {
  position: number;
  lead: string;
  deputy?: string;
  /** Whether a stream exists at the cited roster: this project's own stream or a cell the roster has there. Given by the driver. */
  streamKnown?: (stream: string) => boolean;
}

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
    releases: new Map(),
    quarantines: new Set(),
    hubs: new Map()
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

export type InviteStanding = { state: 'open' | 'used' | 'voided' | 'expired'; expiresAt: string; forMember?: string };

// The invitation's standing at the position: used or voided by an entry applied at or before it, otherwise open, or expired when `at` (the signed time
// of the entry that would use it) is after its expiry. Expiry is decided by signed times only, never a clock (D-17).
export function inviteAt(state: MembersState, invite: string, position: number, at?: string): InviteStanding | undefined {
  const record = state.invites.get(invite);
  if (record === undefined || record.from > position) return undefined;
  const standing = record.voidedAt !== undefined && record.voidedAt <= position ? 'voided'
    : record.usedAt !== undefined && record.usedAt <= position ? 'used'
      : at !== undefined && Date.parse(at) > Date.parse(record.expiresAt) ? 'expired' : 'open';
  return record.forMember === undefined ? { state: standing, expiresAt: record.expiresAt } : { state: standing, expiresAt: record.expiresAt, forMember: record.forMember };
}

// The branch a device.release chose at a fork slot (D-20), keyed by writer, stream and seq. It feeds RosterView.chosenBranch, which forkChosen and
// forkStanding (equivocation.ts) check against the branches of the slot.
export function chosenBranchOf(state: MembersState, writer: string, stream: string, seq: number): string | undefined {
  return state.releases.get(`${writer}/${stream}/${seq}`);
}

export function hubAt(state: MembersState, hub: string, position: number): HubRecord | undefined {
  return state.hubs.get(hub)?.find((record) => inForce(record, position));
}

// The cells granted to the hub at the position, or undefined when the hub is not in the roster there.
export function hubCellsAt(state: MembersState, hub: string, position: number): readonly string[] | undefined {
  return hubAt(state, hub, position)?.cells;
}

// True when the writer is a hub device admitted at the position and its hub is in force there: only such a device signs checkpoints (D-04, D-12).
export function hubSignerAt(state: MembersState, writer: string, position: number): boolean {
  const device = deviceAt(state, writer, position);
  return device !== undefined && device.kind === 'hub' && hubAt(state, device.member, position) !== undefined;
}

// ---- apply rules ----

const refused = (reason: MemberRefusal | 'roster-kind-pending'): MemberApplyOutcome => ({ status: 'refused', reason });

// Why a new device cannot be added at this point, or undefined. A slot must be left, the slot must be in range and never given before (D-41), and the
// X25519 key must be bound by the device's own Ed25519 signature over x25519BindingBytes (D-19).
function newDeviceProblem(state: MembersState, device: DeviceDescriptor): MemberRefusal | undefined {
  // Every slot ever given counts, revoked or not, so the project has at most 4095 devices in its whole life.
  if (state.slots.size >= MAX_SLOT) return 'device-limit';
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

// The refusal for an invitation that cannot be used by an entry signed at `at`, citing the roster at `cited`, or undefined.
function inviteProblem(state: MembersState, invite: string, cited: number, at: string): MemberRefusal | undefined {
  const standing = inviteAt(state, invite, cited, at);
  if (standing === undefined) return 'invite-unknown';
  if (standing.state === 'voided') return 'invite-voided';
  if (standing.state === 'used') return 'invite-used';
  if (standing.state === 'expired') return 'invite-expired';
  return undefined;
}

function markUsed(state: MembersState, invite: string, member: string, position: number): void {
  const record = state.invites.get(invite) as InviteRecord;
  record.usedAt = position;
  record.usedBy = member;
}

function addDevice(state: MembersState, member: string, device: DeviceDescriptor, kind: DeviceRecord['kind'], position: number): void {
  state.devices.set(device.writer, [{ writer: device.writer, member, publicKey: device.publicKey, x25519: device.x25519, slot: device.slot, kind, from: position }]);
  state.slots.set(device.slot as number, device.writer);
}

// member.admit (DESIGN 15.1 join-requested -> active): valid only for an applied invitation that is not voided, not used, not for another member's
// device, and not expired at the admission's own signed time (D-17).
function applyAdmit(state: MembersState, entry: VerifiedEntry, data: AdmitData, ctx: MemberApplyContext): MemberApplyOutcome {
  const cited = ctx.position - 1;
  const standing = inviteAt(state, data.invite, cited);
  const invite = inviteProblem(state, data.invite, cited, entry.body.at);
  // Voided and used are told before expiry and before a device invitation, so a reused invitation is always invite-used.
  if (invite !== undefined && invite !== 'invite-expired') return refused(invite);
  if (standing?.forMember !== undefined) return refused('invite-for-device');
  if (invite !== undefined) return refused(invite);
  if (state.members.has(data.member) || state.hubs.has(data.member)) return refused('member-exists');
  if (data.roles.some((role) => LEAD_ROLES.includes(role))) return refused('lead-role-by-handover-only');
  if (state.devices.has(data.device.writer)) return refused('device-exists');
  const problem = newDeviceProblem(state, data.device);
  if (problem !== undefined) return refused(problem);
  state.members.set(data.member, [{ member: data.member, name: data.name, seat: data.seat, roles: [...data.roles], clearance: data.clearance, agentSeats: [...(data.agentSeats ?? [])], invite: data.invite, from: ctx.position }]);
  addDevice(state, data.member, data.device, 'person', ctx.position);
  markUsed(state, data.invite, data.member, ctx.position);
  return { status: 'applied' };
}

interface VoidData { invite: string }
interface DeviceAddData { member: string; device: DeviceDescriptor; invite?: string }

// invite.void (DESIGN 15.1 invited -> cancelled): closes an open invitation. A used one stays used; the admission it made stands.
function applyVoid(state: MembersState, data: VoidData, ctx: MemberApplyContext): MemberApplyOutcome {
  const standing = inviteAt(state, data.invite, ctx.position - 1);
  if (standing === undefined) return refused('invite-unknown');
  if (standing.state === 'voided') return refused('invite-voided');
  if (standing.state === 'used') return refused('invite-used');
  (state.invites.get(data.invite) as InviteRecord).voidedAt = ctx.position;
  return { status: 'applied' };
}

// device.add (DESIGN 15.2 (none) -> active): another device for an existing member, written by the lead directly or through Add My Other Machine,
// whose invitation must be one made for this member's device (D-18) and is then used.
function applyDeviceAdd(state: MembersState, entry: VerifiedEntry, data: DeviceAddData, ctx: MemberApplyContext): MemberApplyOutcome {
  const cited = ctx.position - 1;
  if (memberAt(state, data.member, cited) === undefined) return refused('member-unknown');
  if (data.invite !== undefined) {
    const problem = inviteProblem(state, data.invite, cited, entry.body.at);
    if (problem !== undefined && problem !== 'invite-expired') return refused(problem);
    if (inviteAt(state, data.invite, cited)?.forMember !== data.member) return refused('invite-wrong-member');
    if (problem !== undefined) return refused(problem);
  }
  if (state.devices.has(data.device.writer)) return refused('device-exists');
  const problem = newDeviceProblem(state, data.device);
  if (problem !== undefined) return refused(problem);
  addDevice(state, data.member, data.device, 'person', ctx.position);
  if (data.invite !== undefined) markUsed(state, data.invite, data.member, ctx.position);
  return { status: 'applied' };
}

interface UpdateData { member: string; name?: string; seat?: string; roles?: string[]; clearance?: unknown; agentSeats?: string[] }
interface RemoveData { member: string }

// Ends the version in force at the cited roster and opens the next one at the entry's position, so earlier rosters keep their answers (D-11).
function nextVersion<T extends { from: number; until?: number }>(versions: T[], current: T, next: T): void {
  current.until = next.from;
  versions.push(next);
}

// Ends every device of the member that is in force at the cited roster. Their slots stay given (D-41).
function endDevicesOf(state: MembersState, member: string, cited: number, position: number): void {
  for (const versions of state.devices.values()) {
    const record = versions.find((candidate) => inForce(candidate, cited));
    if (record !== undefined && record.member === member) record.until = position;
  }
}

// member.update (DESIGN 15.1 active -> active): changes the named fields only. Lead and deputy roles come from the genesis, a handover or naming the
// deputy, never from an update (D-10, D-12); agent seats come only from admit and update (D-12).
function applyUpdate(state: MembersState, data: UpdateData, ctx: MemberApplyContext): MemberApplyOutcome {
  const versions = state.members.get(data.member);
  const current = memberAt(state, data.member, ctx.position - 1);
  if (versions === undefined || current === undefined) return refused('member-unknown');
  if (data.roles !== undefined && data.roles.some((role) => LEAD_ROLES.includes(role))) return refused('lead-role-by-handover-only');
  const next: MemberRecord = {
    member: current.member,
    name: data.name ?? current.name,
    roles: [...(data.roles ?? current.roles)],
    agentSeats: [...(data.agentSeats ?? current.agentSeats)],
    from: ctx.position
  };
  const seat = data.seat ?? current.seat;
  if (seat !== undefined) next.seat = seat;
  const clearance = data.clearance ?? current.clearance;
  if (clearance !== undefined) next.clearance = clearance;
  if (current.invite !== undefined) next.invite = current.invite;
  nextVersion(versions, current, next);
  return { status: 'applied' };
}

// member.remove (DESIGN 15.1 active -> removed): the member and every device of it end at this position. The lead leaves only through a handover.
function applyRemove(state: MembersState, data: RemoveData, ctx: MemberApplyContext): MemberApplyOutcome {
  const cited = ctx.position - 1;
  const current = memberAt(state, data.member, cited);
  if (current === undefined) return refused('member-unknown');
  if (data.member === ctx.lead) return refused('lead-not-removable');
  current.until = ctx.position;
  endDevicesOf(state, data.member, cited, ctx.position);
  return { status: 'applied' };
}

interface RotateData { member: string; from: string; device: DeviceDescriptor }
interface RevokeData { member: string; writer: string }

// The member's device in force at the cited roster, or undefined when the roster does not have it for that member.
function deviceOf(state: MembersState, member: string, writer: string, cited: number): DeviceRecord | undefined {
  const record = deviceAt(state, writer, cited);
  return record !== undefined && record.member === member ? record : undefined;
}

// device.rotate (DESIGN 15.2 active -> rotated): the old writer is admitted at rosters before this position and not from it; the new device, with its
// own slot and binding, from it on (D-20). The old slot stays given.
function applyRotate(state: MembersState, data: RotateData, ctx: MemberApplyContext): MemberApplyOutcome {
  const old = deviceOf(state, data.member, data.from, ctx.position - 1);
  if (old === undefined) return refused('device-unknown');
  if (state.devices.has(data.device.writer)) return refused('device-exists');
  const problem = newDeviceProblem(state, data.device);
  if (problem !== undefined) return refused(problem);
  old.until = ctx.position;
  addDevice(state, data.member, data.device, old.kind, ctx.position);
  return { status: 'applied' };
}

// device.revoke (DESIGN 15.2 active -> revoked, quarantined -> revoked). Revoking the lead's last device would leave no device able to write the
// roster, so the lead's own devices may not do it; the deputy may, so a lost or compromised lead device can be cut off (D-09, D-48).
function applyRevoke(state: MembersState, entry: VerifiedEntry, data: RevokeData, ctx: MemberApplyContext): MemberApplyOutcome {
  const cited = ctx.position - 1;
  const target = deviceOf(state, data.member, data.writer, cited);
  if (target === undefined) return refused('device-unknown');
  if (target.member === ctx.lead) {
    const leadDevices = devicesOfMemberAt(state, ctx.lead, cited).filter((device) => device.kind === 'person');
    const signer = deviceAt(state, entry.header.writer, cited);
    const byDeputy = ctx.deputy !== undefined && signer !== undefined && signer.member === ctx.deputy;
    if (leadDevices.length <= 1 && !byDeputy) return refused('last-lead-device');
  }
  target.until = ctx.position;
  return { status: 'applied' };
}

interface SlotData { writer: string; stream: string; seq: number }
interface ReleaseData extends SlotData { branch: string }
interface HubAdmitData { hub: string; device: DeviceDescriptor; certPin: string; ceiling: unknown }
interface HubGrantData { hub: string; cell: string }
interface HubRevokeData { hub: string }
interface HubReadmitData { hub: string; certPin: string }

// device.quarantine is record only (D-48): the quarantine itself comes from an equivocation proof in the main fold, so the entry changes no other
// state. What the roster can check, it does, so a quarantine naming the wrong place is refused with its reason instead of accepted as a no-op: the
// device must be one the roster has had, the stream must exist at the cited roster (this project or one of its cells), and the same writer, stream
// and seq is recorded once.
function applyQuarantine(state: MembersState, data: SlotData, ctx: MemberApplyContext): MemberApplyOutcome {
  if (deviceKeyOf(state, data.writer) === undefined) return refused('device-unknown');
  if (ctx.streamKnown !== undefined && !ctx.streamKnown(data.stream)) return refused('quarantine-stream-unknown');
  const key = `${data.writer}/${data.stream}/${data.seq}`;
  if (state.quarantines.has(key)) return refused('quarantine-recorded');
  state.quarantines.add(key);
  return { status: 'applied' };
}

// device.release (DESIGN 15.2 quarantined -> active): records the branch kept at the fork slot. Which hashes are branches of the slot is the main
// fold's knowledge, so forkChosen accepts the choice only for a branch of that slot. A later release of the same slot replaces the choice: the roster
// at its head is the lead's current word.
function applyRelease(state: MembersState, data: ReleaseData): MemberApplyOutcome {
  if (deviceKeyOf(state, data.writer) === undefined) return refused('device-unknown');
  state.releases.set(`${data.writer}/${data.stream}/${data.seq}`, data.branch);
  return { status: 'applied' };
}

// hub.admit: the hub is a service member (D-12) whose id shares the member namespace and is never given twice; its device takes a slot and is bound
// like any device.
function applyHubAdmit(state: MembersState, data: HubAdmitData, ctx: MemberApplyContext): MemberApplyOutcome {
  if (state.members.has(data.hub)) return refused('member-exists');
  if (state.hubs.has(data.hub)) return refused('hub-exists');
  if (state.devices.has(data.device.writer)) return refused('device-exists');
  const problem = newDeviceProblem(state, data.device);
  if (problem !== undefined) return refused(problem);
  state.hubs.set(data.hub, [{ hub: data.hub, certPin: data.certPin, ceiling: data.ceiling, cells: [], from: ctx.position }]);
  addDevice(state, data.hub, data.device, 'hub', ctx.position);
  return { status: 'applied' };
}

// hub.grant: the hub holds the cell from this position on (DESIGN 10.2). Whether the cell exists is the cells module's business.
function applyHubGrant(state: MembersState, data: HubGrantData, ctx: MemberApplyContext): MemberApplyOutcome {
  const versions = state.hubs.get(data.hub);
  const current = hubAt(state, data.hub, ctx.position - 1);
  if (versions === undefined || current === undefined) return refused('hub-unknown');
  if (!current.cells.includes(data.cell)) nextVersion(versions, current, { hub: current.hub, certPin: current.certPin, ceiling: current.ceiling, cells: [...current.cells, data.cell], from: ctx.position });
  return { status: 'applied' };
}

// hub.revoke: the hub and its devices end at this position, so it signs no checkpoint from here on.
function applyHubRevoke(state: MembersState, data: HubRevokeData, ctx: MemberApplyContext): MemberApplyOutcome {
  const cited = ctx.position - 1;
  const current = hubAt(state, data.hub, cited);
  if (current === undefined) return refused('hub-unknown');
  current.until = ctx.position;
  endDevicesOf(state, data.hub, cited, ctx.position);
  return { status: 'applied' };
}

// hub.readmit (Phase 33 D-42): the lead trusts an admitted hub again after a fork or rollback finding, with the pin the lead compared. A new version
// of the hub's record opens at this position with that pin; its devices, ceiling and cells are unchanged. A revoked hub stays revoked.
function applyHubReadmit(state: MembersState, data: HubReadmitData, ctx: MemberApplyContext): MemberApplyOutcome {
  const versions = state.hubs.get(data.hub);
  if (versions === undefined) return refused('hub-unknown');
  const current = hubAt(state, data.hub, ctx.position - 1);
  if (current === undefined) return refused('hub-revoked');
  nextVersion(versions, current, { hub: current.hub, certPin: data.certPin, ceiling: current.ceiling, cells: current.cells, readmit: true, from: ctx.position });
  return { status: 'applied' };
}

// The positions at which the hub was trusted again (hub.readmit), oldest first.
export function hubReadmitPositions(state: MembersState, hub: string): number[] {
  return (state.hubs.get(hub) ?? []).filter((record) => record.readmit === true).map((record) => record.from);
}

// Applies one member, device, hub or invite kind. The data was checked against its closed schema at verification. Validates first and changes the
// state only when the outcome is applied.
export function applyMemberEntry(state: MembersState, entry: VerifiedEntry, ctx: MemberApplyContext): MemberApplyOutcome {
  switch (entry.body.kind) {
    case 'member.invite':
      return applyInvite(state, entry.data as InviteData, ctx);
    case 'member.admit':
      return applyAdmit(state, entry, entry.data as AdmitData, ctx);
    case 'member.update':
      return applyUpdate(state, entry.data as UpdateData, ctx);
    case 'member.remove':
      return applyRemove(state, entry.data as RemoveData, ctx);
    case 'invite.void':
      return applyVoid(state, entry.data as VoidData, ctx);
    case 'device.add':
      return applyDeviceAdd(state, entry, entry.data as DeviceAddData, ctx);
    case 'device.rotate':
      return applyRotate(state, entry.data as RotateData, ctx);
    case 'device.revoke':
      return applyRevoke(state, entry, entry.data as RevokeData, ctx);
    case 'device.quarantine':
      return applyQuarantine(state, entry.data as SlotData, ctx);
    case 'device.release':
      return applyRelease(state, entry.data as ReleaseData);
    case 'hub.admit':
      return applyHubAdmit(state, entry.data as HubAdmitData, ctx);
    case 'hub.grant':
      return applyHubGrant(state, entry.data as HubGrantData, ctx);
    case 'hub.revoke':
      return applyHubRevoke(state, entry.data as HubRevokeData, ctx);
    case 'hub.readmit':
      return applyHubReadmit(state, entry.data as HubReadmitData, ctx);
    default:
      // A kind the driver routes here with no rule in this version: refused, never applied.
      return refused('roster-kind-pending');
  }
}

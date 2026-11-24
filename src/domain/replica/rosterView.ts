// The authority the replica fold asks about, injected (D-09, D-27). Pure. Phase 31 replaces staticRosterView with the real roster fold; the interface
// stays the same, so no entry format changes with it.
//
// The roster is linear: each roster hash has a position, and "at roster hash R" means the members and roles as of position(R).
import { slotOfClientId } from './clientIds';
import type { SealedBlob } from './entry';
import type { SessionCertificate } from './sessionKeys';

export interface RosterView {
  hasRoster(rosterHash: string): boolean;
  // Position of a roster in the linear roster, from 0. Used for stale-citation checks.
  rosterPosition(rosterHash: string): number | undefined;
  // The device's key if the device is admitted at any roster position. This lets a signature be checked without opening the sealed body, because
  // the roster hash an entry cites is inside that body.
  deviceKey(writer: string): { publicKey: string; member: string } | undefined;
  // Is this device admitted, and not removed or revoked, at that roster?
  isAdmitted(writer: string, rosterHash: string): boolean;
  memberName(member: string, rosterHash: string): string | undefined;
  hasRole(member: string, role: string, rosterHash: string): boolean;
  // Hash of the first roster after R in which the member no longer holds the role; undefined when never withdrawn.
  roleWithdrawnBy(member: string, role: string, rosterHash: string): string | undefined;
  // A device.release choice: the hash of the branch the lead chose at that (writer, stream, seq).
  chosenBranch(writer: string, stream: string, seq: number): string | undefined;
  checkpointSigner(writer: string, rosterHash: string): boolean;
  // The members below are optional (D-08), so a view that lacks one keeps the Phase 30 behaviour. Each is asked at the roster hash an entry cites.
  // May this member's devices run that agent seat? Gate verdicts and agent doc.client registrations ask it (WR-01, WR-02, D-12); absent means deny.
  canRunAgent?(member: string, seat: string, rosterHash: string): boolean;
  // The writer whose device slot holds this Yjs client id, or undefined (D-41). Absent means no client id is bound to a writer (static test views).
  clientIdOwner?(clientId: number, rosterHash: string): string | undefined;
  // The device's encryption public key, which cell grants are wrapped to (D-22); undefined when the device has none at that roster.
  deviceEncryptionKey?(writer: string, rosterHash: string): string | undefined;
  // The devices holding a wrap for the cell's current epoch (D-22), or undefined when this view does not know the cell.
  cellGrantees?(cell: string, rosterHash: string): readonly string[] | undefined;
  // True when the roster hash is on a branch of a roster split that the lead or deputy has not chosen yet (D-11).
  rosterBranchPending?(rosterHash: string): boolean;
  // The certificate pin of the hub in force at that roster (its hub.admit, then each hub.readmit), or undefined when the hub is not in force there.
  hubPin?(hub: string, rosterHash: string): string | undefined;
  // The roster entry hashes of the hub's re-admissions (hub.readmit), oldest first; each is handed to readmitWitness once (Phase 33 D-42).
  hubReadmits?(hub: string): readonly string[];
  // The session.certify the roster fold placed for this session writer, at any position, like deviceKey (Phase 33 D-62). Absent: no session keys.
  sessionCertificate?(writer: string): SessionCertificate | undefined;
  // The roster positions of the device's device.quarantine entries, each with the positions of the releases of the same place (Phase 33 D-62).
  deviceQuarantines?(writer: string): ReadonlyArray<{ from: number; released: readonly number[] }>;
}

// The role words the roster uses. A member holds any number of them at one roster position.
export const ROSTER_ROLE_PATTERNS: ReadonlyArray<{ role: string; pattern: RegExp; meaning: string }> = [
  { role: 'staff_lead', pattern: /^staff_lead$/, meaning: 'The lead of the project.' },
  { role: 'deputy_lead', pattern: /^deputy_lead$/, meaning: 'The deputy who may act when the lead is lost.' },
  { role: 'member', pattern: /^member$/, meaning: 'A member of the project.' },
  { role: 'section_lead:<section>', pattern: /^section_lead:[a-z0-9][a-z0-9-]{0,39}$/, meaning: 'Leads one staff section.' },
  { role: 'answers_for:<section>', pattern: /^answers_for:[a-z0-9][a-z0-9-]{0,39}$/, meaning: 'Answers questions for one staff section.' },
  { role: 'decision_for:<role>', pattern: /^decision_for:[a-z0-9][a-z0-9-]{0,39}$/, meaning: 'Makes the person decisions for one role.' },
  { role: 'observer', pattern: /^observer$/, meaning: 'Reads the project and writes only presence.' }
];

// The 32-byte epoch key for a cell, or undefined when this machine does not hold it.
export type KeyRing = (stream: string, epoch: number) => Buffer | undefined;
export type BlobLookup = (hash: string) => SealedBlob | undefined;

// Everything the fold may know about the outside world. It reads no clock and does no I/O; now is a value.
export interface ReplicaContext {
  roster: RosterView;
  keys: KeyRing;
  blobs: BlobLookup;
  now: Date;
  // May an entry in the citing stream cite an entry in the cited stream? True when the citing cell dominates the cited one (write up, never down,
  // D-25). Absent: every citation is allowed, as in Phase 30.
  cellOrder?(citingStream: string, citedStream: string): boolean;
}

export interface StaticRosterMember {
  member: string;
  name: string;
  roles: readonly string[];
  // The device's slot (D-41) when the spec binds client ids to writers; a spec where no device has a slot binds none.
  devices: ReadonlyArray<{ writer: string; publicKey: string; slot?: number }>;
  // The agent seats this member's devices may run (D-12); none when absent.
  agentSeats?: readonly string[];
}
// The array index of a roster in the spec is its position.
export interface StaticRosterSpec {
  rosters: ReadonlyArray<{ hash: string; members: readonly StaticRosterMember[]; checkpointSigners?: readonly string[] }>;
  chosenBranches?: ReadonlyArray<{ writer: string; stream: string; seq: number; hash: string }>;
}

// The test roster D-09 asks for.
export function staticRosterView(spec: StaticRosterSpec): RosterView {
  const positions = new Map<string, number>();
  spec.rosters.forEach((roster, index) => { if (!positions.has(roster.hash)) positions.set(roster.hash, index); });
  const memberAt = (member: string, position: number): StaticRosterMember | undefined => spec.rosters[position]?.members.find((candidate) => candidate.member === member);
  const holds = (member: string, role: string, position: number): boolean => memberAt(member, position)?.roles.includes(role) === true;
  const branches = new Map<string, string>();
  for (const choice of spec.chosenBranches ?? []) branches.set(`${choice.writer}/${choice.stream}/${choice.seq}`, choice.hash);
  // Per position, the writer of each slot. Built only when some device has a slot, so a spec without slots enforces nothing (D-41).
  const slotted = spec.rosters.some((roster) => roster.members.some((member) => member.devices.some((device) => device.slot !== undefined)));
  const slotWriters = spec.rosters.map((roster) => {
    const writers = new Map<number, string>();
    for (const member of roster.members) for (const device of member.devices) if (device.slot !== undefined) writers.set(device.slot, device.writer);
    return writers;
  });
  const clientIdOwner = (clientId: number, hash: string): string | undefined => {
    const position = positions.get(hash);
    return position === undefined ? undefined : slotWriters[position].get(slotOfClientId(clientId));
  };
  return {
    hasRoster: (hash) => positions.has(hash),
    rosterPosition: (hash) => positions.get(hash),
    deviceKey(writer) {
      for (const roster of spec.rosters) {
        for (const member of roster.members) {
          const device = member.devices.find((candidate) => candidate.writer === writer);
          if (device !== undefined) return { publicKey: device.publicKey, member: member.member };
        }
      }
      return undefined;
    },
    isAdmitted(writer, hash) {
      const position = positions.get(hash);
      if (position === undefined) return false;
      return spec.rosters[position].members.some((member) => member.devices.some((device) => device.writer === writer));
    },
    memberName(member, hash) {
      const position = positions.get(hash);
      return position === undefined ? undefined : memberAt(member, position)?.name;
    },
    hasRole(member, role, hash) {
      const position = positions.get(hash);
      return position !== undefined && holds(member, role, position);
    },
    // Default deny: an unknown roster, an unknown member or a seat the member's entry does not list.
    canRunAgent(member, seat, hash) {
      const position = positions.get(hash);
      return position !== undefined && memberAt(member, position)?.agentSeats?.includes(seat) === true;
    },
    roleWithdrawnBy(member, role, hash) {
      const position = positions.get(hash);
      if (position === undefined) return undefined;
      for (let later = position + 1; later < spec.rosters.length; later += 1) {
        if (!holds(member, role, later)) return spec.rosters[later].hash;
      }
      return undefined;
    },
    chosenBranch: (writer, stream, seq) => branches.get(`${writer}/${stream}/${seq}`),
    checkpointSigner(writer, hash) {
      const position = positions.get(hash);
      return position !== undefined && spec.rosters[position].checkpointSigners?.includes(writer) === true;
    },
    ...(slotted ? { clientIdOwner } : {})
  };
}

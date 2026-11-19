// The authority the replica fold asks about, injected (D-09, D-27). Pure. Phase 31 replaces staticRosterView with the real roster fold; the interface
// stays the same, so no entry format changes with it.
//
// The roster is linear: each roster hash has a position, and "at roster hash R" means the members and roles as of position(R).
import type { SealedBlob } from './entry';

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
}

// The role words the roster uses. A member holds any number of them at one roster position.
export const ROSTER_ROLE_PATTERNS: ReadonlyArray<{ role: string; pattern: RegExp; meaning: string }> = [
  { role: 'staff_lead', pattern: /^staff_lead$/, meaning: 'The lead of the project.' },
  { role: 'deputy_lead', pattern: /^deputy_lead$/, meaning: 'The deputy who may act when the lead is lost.' },
  { role: 'member', pattern: /^member$/, meaning: 'A member of the project.' },
  { role: 'section_lead:<section>', pattern: /^section_lead:[a-z0-9][a-z0-9-]{0,39}$/, meaning: 'Leads one staff section.' },
  { role: 'answers_for:<section>', pattern: /^answers_for:[a-z0-9][a-z0-9-]{0,39}$/, meaning: 'Answers questions for one staff section.' },
  { role: 'decision_for:<role>', pattern: /^decision_for:[a-z0-9][a-z0-9-]{0,39}$/, meaning: 'Makes the person decisions for one role.' }
];

// The 32-byte epoch key for a cell, or undefined when this machine does not hold it.
export type KeyRing = (stream: string, epoch: number) => Buffer | undefined;
export type BlobLookup = (hash: string) => SealedBlob | undefined;

// Everything the fold may know about the outside world. It reads no clock and does no I/O; now is a value.
export interface ReplicaContext { roster: RosterView; keys: KeyRing; blobs: BlobLookup; now: Date }

export interface StaticRosterMember {
  member: string;
  name: string;
  roles: readonly string[];
  devices: ReadonlyArray<{ writer: string; publicKey: string }>;
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
    }
  };
}

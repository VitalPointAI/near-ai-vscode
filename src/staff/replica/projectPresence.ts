// Live presence over one open shared project (Phase 33, 33-29; D-18, D-21, D-56). The executed LivePresence (33-12) needs, synchronously, the cells
// this computer holds with their epochs, the epoch keys and the roster's answers about devices and people. This reads them from the project after
// each fold (refresh) and keeps the last answer, so a presence frame never waits on the store. The native live engine runs one per open project.
//
// Who a frame is from: a roster device admitted at the head, or a session key whose certificate a device of that member signed and that still stands
// there (D-62: certifiedWriter), so a person working through a session key shows as that person. Names and position words come from this computer's
// roster at its head, never from the message. Nothing here is written anywhere.
import { certifiedWriter } from '../../domain/replica/sessionKeys';
import { deviceAt, memberAt } from '../../domain/replica/rosterMembers';
import { LivePresence } from './livePresence';
import type { LivePresenceOptions, PresenceRoster } from './livePresence';
import type { ReplicaProject } from './replicaProject';

export type ProjectPresenceOptions = Pick<LivePresenceOptions, 'send' | 'writer' | 'showWork' | 'runningAgents' | 'setPeople' | 'now' | 'timers'>;

export interface ProjectPresence {
  readonly presence: LivePresence;
  /** Reads the held cells and the roster again (after an exchange, a grant or a roster change). */
  refresh(): Promise<void>;
  /** Whether the last read found this computer holding the cell. */
  holds(cell: string): boolean;
}

interface Snapshot {
  cells: Array<{ cell: string; epoch: number }>;
  roster: PresenceRoster;
  member: string;
  position: string | undefined;
}

const NOBODY: PresenceRoster = { memberOf: () => undefined, person: () => undefined };

async function snapshotOf(project: ReplicaProject, writer: string): Promise<Snapshot> {
  const { roster } = await project.state();
  const held = await project.heldCells();
  const view = project.context().roster;
  const position = roster.positions.length - 1;
  const head = roster.positions[position] ?? '';
  const answers: PresenceRoster = {
    memberOf: (device) => deviceAt(roster.members, device, position)?.member ?? certifiedWriter(view, device, head)?.member,
    person: (member) => {
      const record = memberAt(roster.members, member, position);
      return record === undefined ? undefined : { name: record.name, ...(record.seat === undefined ? {} : { position: record.seat }) };
    },
  };
  const member = answers.memberOf(project.deviceWriter) ?? answers.memberOf(writer) ?? '';
  return {
    cells: held.map((item) => ({ cell: item.cell, epoch: Math.max(...item.epochs) })),
    roster: answers,
    member,
    position: answers.person(member)?.position,
  };
}

/** Presence for one open project; started by the caller once the replicator runs. */
export async function openProjectPresence(project: ReplicaProject, options: ProjectPresenceOptions): Promise<ProjectPresence> {
  let snapshot: Snapshot = await snapshotOf(project, options.writer);
  const keyFor = (cell: string, epoch: number): Buffer | undefined => {
    try {
      return project.context().keys(cell, epoch);
    } catch {
      return undefined;
    }
  };
  const presence = new LivePresence({
    ...options,
    member: snapshot.member,
    baseCell: project.projectId,
    position: () => snapshot.position,
    cells: () => snapshot.cells,
    keyFor,
    roster: () => snapshot.roster ?? NOBODY,
  });
  return {
    presence,
    refresh: async () => {
      snapshot = await snapshotOf(project, options.writer);
    },
    holds: (cell) => snapshot.cells.some((item) => item.cell === cell),
  };
}

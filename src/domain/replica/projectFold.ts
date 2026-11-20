// The reducer for the project family (D-07, D-09, DESIGN 7.1, 14). Hub-side in spirit (it never touches Yjs) but not on the hub list: it uses the
// reducer contract. State is kept per stream, so an unrelated stream never changes another stream's output.
//
// Both kinds are governance acts: they come only from a person (WR-02, D-12). An agent or hub label is refused agent-cannot-decide before the role check,
// so an agent running on the lead's own device cannot set the project's name, lead or hub pin.
// project.genesis is accepted only from a member who holds staff_lead at the roster the entry cites. The first accepted genesis of a stream wins in fold
// order; a later, different one is refused second-genesis whatever order the entries arrived in, because the fold order is the same everywhere.
// project.import records one legacy ledger the lead brought in, and is listed once however often it is repeated.
import { canonicalize } from '../team/canonical';
import type { FamilyReducer, ReduceOutcome } from './reducers';
import type { VerifiedEntry } from './verify';

export const PROJECT_REFUSALS = {
  'agent-cannot-decide': 'Only a person can set up the project or import its history; an agent or the hub cannot.',
  'not-staff-lead': 'Only the staff lead of the project may write this, and the member who wrote it was not the staff lead at the roster it cites.',
  'second-genesis': 'This stream already has a different project genesis, so this one is refused.',
  'unsupported-kind': 'This kind of project entry is not applied by this version.'
} as const;
export type ProjectRefusal = keyof typeof PROJECT_REFUSALS;

interface GenesisData {
  project: string;
  name: string;
  profile: string;
  labelMapHash: string;
  lead: { member: string; writer: string };
  hub?: { writer: string; certPin: string };
}
interface ImportData { ledger: string; legacyHead: string; count: number }

export interface ProjectGenesis {
  entry: string;
  project: string;
  name: string;
  profile: string;
  labelMapHash: string;
  lead: { member: string; writer: string };
  hub: { writer: string; certPin: string } | null;
  // The canonical text of the genesis data, so a repeat of the same genesis is told apart from a different one.
  content: string;
}
export interface ProjectImport { ledger: string; legacyHead: string; count: number; entry: string; member: string; writer: string }
export interface ProjectStreamState { genesis: ProjectGenesis | undefined; imports: ProjectImport[] }
export interface ProjectState { streams: Map<string, ProjectStreamState> }

// What the fold shows for one stream. Fields are null until a genesis is accepted in that stream.
export interface ProjectStreamOutput {
  stream: string;
  genesis: string | null;
  project: string | null;
  name: string | null;
  profile: string | null;
  labelMapHash: string | null;
  lead: { member: string; writer: string } | null;
  hub: { writer: string; certPin: string } | null;
  imports: ProjectImport[];
}
export type ProjectOutput = ProjectStreamOutput[];

const copyImport = (item: ProjectImport): ProjectImport => ({ ledger: item.ledger, legacyHead: item.legacyHead, count: item.count, entry: item.entry, member: item.member, writer: item.writer });

function streamState(state: ProjectState, stream: string): ProjectStreamState {
  let found = state.streams.get(stream);
  if (found === undefined) {
    found = { genesis: undefined, imports: [] };
    state.streams.set(stream, found);
  }
  return found;
}

function refused(reason: ProjectRefusal): ReduceOutcome {
  return { status: 'refused', reason };
}

export const projectReducer: FamilyReducer<ProjectState, ProjectOutput> = {
  family: 'project',
  init: () => ({ streams: new Map() }),
  apply(state, entry: VerifiedEntry, view): ReduceOutcome {
    if (entry.body.kind !== 'project.genesis' && entry.body.kind !== 'project.import') return refused('unsupported-kind');
    if (entry.body.actor.kind !== 'person') return refused('agent-cannot-decide');
    if (!view.ctx.roster.hasRole(entry.member, 'staff_lead', entry.body.roster)) return refused('not-staff-lead');
    if (entry.body.kind === 'project.genesis') {
      const data = entry.data as GenesisData;
      const content = canonicalize(data);
      const known = state.streams.get(entry.header.stream);
      if (known?.genesis !== undefined) return known.genesis.content === content ? { status: 'applied' } : refused('second-genesis');
      streamState(state, entry.header.stream).genesis = {
        entry: entry.hash,
        project: data.project,
        name: data.name,
        profile: data.profile,
        labelMapHash: data.labelMapHash,
        lead: { member: data.lead.member, writer: data.lead.writer },
        hub: data.hub === undefined ? null : { writer: data.hub.writer, certPin: data.hub.certPin },
        content
      };
      return { status: 'applied' };
    }
    const data = entry.data as ImportData;
    const current = streamState(state, entry.header.stream);
    const repeat = current.imports.some((item) => item.ledger === data.ledger && item.legacyHead === data.legacyHead && item.count === data.count);
    if (!repeat) current.imports.push({ ledger: data.ledger, legacyHead: data.legacyHead, count: data.count, entry: entry.hash, member: entry.member, writer: entry.header.writer });
    return { status: 'applied' };
  },
  finish(state) {
    return [...state.streams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([stream, item]): ProjectStreamOutput => ({
        stream,
        genesis: item.genesis?.entry ?? null,
        project: item.genesis?.project ?? null,
        name: item.genesis?.name ?? null,
        profile: item.genesis?.profile ?? null,
        labelMapHash: item.genesis?.labelMapHash ?? null,
        lead: item.genesis === undefined ? null : { member: item.genesis.lead.member, writer: item.genesis.lead.writer },
        hub: item.genesis === undefined || item.genesis.hub === null ? null : { writer: item.genesis.hub.writer, certPin: item.genesis.hub.certPin },
        imports: item.imports.map(copyImport).sort((a, b) => (a.ledger === b.ledger ? (a.legacyHead < b.legacyHead ? -1 : a.legacyHead > b.legacyHead ? 1 : a.count - b.count) : a.ledger < b.ledger ? -1 : 1))
      }));
  },
  canonical(output, stream) {
    const found = output.find((item) => item.stream === stream);
    if (found === undefined) return null;
    return {
      genesis: found.genesis,
      project: found.project,
      name: found.name,
      profile: found.profile,
      labelMapHash: found.labelMapHash,
      lead: found.lead,
      hub: found.hub,
      imports: found.imports.map((item): [string, string, number, string] => [item.ledger, item.legacyHead, item.count, item.entry])
    };
  },
  clone(state) {
    const copy: ProjectState = { streams: new Map() };
    for (const [stream, item] of state.streams) {
      copy.streams.set(stream, {
        genesis: item.genesis === undefined ? undefined : { ...item.genesis, lead: { ...item.genesis.lead }, hub: item.genesis.hub === null ? null : { ...item.genesis.hub } },
        imports: item.imports.map(copyImport)
      });
    }
    return copy;
  }
};

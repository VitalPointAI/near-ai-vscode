// The reducer for the project family (D-07, D-09, DESIGN 7.1, 14). Hub-side in spirit (it never touches Yjs) but not on the hub list: it uses the
// reducer contract. State is kept per stream, so an unrelated stream never changes another stream's output.
//
// Both kinds are governance acts: they come only from a person (WR-02, D-12). An agent or hub label is refused agent-cannot-decide before the role check,
// so an agent running on the lead's own device cannot set the project's name, lead or hub pin.
// project.genesis is accepted only from a member who holds staff_lead at the roster the entry cites. The first accepted genesis of a stream wins in fold
// order; a later, different one is refused second-genesis whatever order the entries arrived in, because the fold order is the same everywhere.
// project.import records one legacy ledger the lead brought in, and is listed once however often it is repeated (the key is ledger, legacy head and count;
// the first in fold order is the one listed). Since D-31 and D-49 it may carry the whole legacy file and the product ledger's signed head mark; the
// output lists the sha256 of the file and whether a mark came with it, so migration can find each imported file and re-verify it.
// Since D-20 (plan 32-08) an import is the whole ledger or one cell's part of it (scope, with lines for a part); an import with no scope is whole. The
// repeat key adds the scope, so a whole import and a cell import of one ledger in one stream are both listed.
import { createHash } from 'node:crypto';
import { canonicalize } from '../team/canonical';
import type { ImportScope } from './kindSchemas/project';
import { importScopeOf } from './productCells';
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
// file is strict base64url and mark one line of text, both checked by the project.import schema before the reducer sees them.
// scope and lines are checked by the schema too: scope is whole or cell, and lines (a count) comes only with a cell import.
interface ImportData { ledger: string; legacyHead: string; count: number; file?: string; mark?: string; scope?: ImportScope; lines?: number }

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
// fileHash: the sha256 hex of the decoded legacy file, absent when the import carried no file. marked: the import carried the signed head mark.
// scope: whole when the entry named none (D-20). lines: how many ledger lines a cell import carries, absent on a whole import.
export interface ProjectImport { ledger: string; legacyHead: string; count: number; entry: string; member: string; writer: string; fileHash?: string; marked: boolean; scope: ImportScope; lines?: number }
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

const copyImport = (item: ProjectImport): ProjectImport => ({
  ledger: item.ledger,
  legacyHead: item.legacyHead,
  count: item.count,
  entry: item.entry,
  member: item.member,
  writer: item.writer,
  ...(item.fileHash === undefined ? {} : { fileHash: item.fileHash }),
  marked: item.marked,
  scope: item.scope,
  ...(item.lines === undefined ? {} : { lines: item.lines })
});

const fileHashOf = (file: string): string => createHash('sha256').update(Buffer.from(file, 'base64url')).digest('hex');

function streamState(state: ProjectState, stream: string): ProjectStreamState {
  let found = state.streams.get(stream);
  if (found === undefined) {
    found = { genesis: undefined, imports: [] };
    state.streams.set(stream, found);
  }
  return found;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
// Ledger, legacy head, count, then scope (whole before cell), so a whole and a cell import of one ledger always list in the same order.
const compareImports = (a: ProjectImport, b: ProjectImport): number =>
  compareText(a.ledger, b.ledger) || compareText(a.legacyHead, b.legacyHead) || a.count - b.count || (a.scope === b.scope ? 0 : a.scope === 'whole' ? -1 : 1);

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
    const scope = importScopeOf(data);
    const repeat = current.imports.some((item) => item.ledger === data.ledger && item.legacyHead === data.legacyHead && item.count === data.count && item.scope === scope);
    if (!repeat) {
      current.imports.push({
        ledger: data.ledger,
        legacyHead: data.legacyHead,
        count: data.count,
        entry: entry.hash,
        member: entry.member,
        writer: entry.header.writer,
        ...(data.file === undefined ? {} : { fileHash: fileHashOf(data.file) }),
        marked: data.mark !== undefined,
        scope,
        ...(scope === 'cell' && data.lines !== undefined ? { lines: data.lines } : {})
      });
    }
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
        imports: item.imports.map(copyImport).sort(compareImports)
      }));
  },
  // The digest form keeps its Phase 30 tuple (ledger, legacy head, count, entry): the entry hash already commits to the file, the mark, the scope and
  // the lines, so no Phase 31 digest moves (plan 32-08).
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

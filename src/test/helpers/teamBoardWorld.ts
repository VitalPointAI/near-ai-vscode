// A small in-memory team for the Team Board model tests: an owner who really signs, plus a lead, a developer, a reviewer and an observer placed
// straight into the roster (Phase 60 logs cannot carry joins; see addFixtureMember). Every item event goes through the real materialiser, so a
// board built from this world is a board built from a replayed log. No file or network access; keys exist only in memory.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { applyEntry, reduce } from '../../domain/team/materialize';
import type { CommittedEvent, GenesisAnchor, ImplementedEventBodies, ImplementedEventType, ItemImportedBody, Role, TeamState } from '../../domain/team/types';
import { newTeamId } from '../../team/identity';
import { addFixtureMember, entryOf, genesisEntries, makeActor, signed } from './teamEvents';
import type { TestActor } from './teamEvents';

export interface BoardWorld {
  teamId: string;
  anchor: GenesisAnchor;
  state: TeamState;
  entries: CommittedEvent[];
  owner: TestActor;
  lead: TestActor;
  dev: TestActor;
  reviewer: TestActor;
  observer: TestActor;
  // Signs the event as `actor`, applies it to the live state and returns the committed entry with its verdict.
  send<T extends ImplementedEventType>(actor: TestActor, type: T, body: ImplementedEventBodies[T], at?: string): CommittedEvent;
  // Same, but fails the test when the log would reject the event.
  accept<T extends ImplementedEventType>(actor: TestActor, type: T, body: ImplementedEventBodies[T], at?: string): CommittedEvent;
}

export const WORLD_START = '2026-03-01T10:00:00.000Z';
export const NAMES = { lead: 'Lee', dev: 'Dana', reviewer: 'Rae', observer: 'Obi' } as const;

export async function boardWorld(): Promise<BoardWorld> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries: genesis, anchor } = genesisEntries(owner, teamId);
  const state = reduce(genesis, anchor);
  const entries: CommittedEvent[] = [...genesis.map((entry) => ({ ...entry, verdict: { accepted: true as const } }))];
  const people: Array<[TestActor, Role, string]> = [];
  const actors = {} as Record<'lead' | 'dev' | 'reviewer' | 'observer', TestActor>;
  for (const [key, role] of [['lead', 'lead'], ['dev', 'developer'], ['reviewer', 'reviewer'], ['observer', 'observer']] as const) {
    const actor = await makeActor(teamId);
    actors[key] = actor;
    people.push([actor, role, NAMES[key]]);
  }
  for (const [actor, role, name] of people) addFixtureMember(state, actor, role, name);
  let tick = 0;
  const base = Date.parse(WORLD_START);
  const send = <T extends ImplementedEventType>(actor: TestActor, type: T, body: ImplementedEventBodies[T], at?: string): CommittedEvent => {
    tick += 1;
    const event = signed(actor, { teamId, type, body, lamport: state.highLamport + 1, prev: state.head.eventId, at: at ?? new Date(base + tick * 1000).toISOString() });
    const entry = entryOf(event);
    entry.verdict = applyEntry(state, entry);
    entries.push(entry);
    return entry;
  };
  const accept = <T extends ImplementedEventType>(actor: TestActor, type: T, body: ImplementedEventBodies[T], at?: string): CommittedEvent => {
    const entry = send(actor, type, body, at);
    if (entry.verdict?.accepted !== true) throw new Error(`the log rejected ${type}: ${entry.verdict?.accepted === false ? entry.verdict.rejection.reason : 'no verdict'}`);
    return entry;
  };
  return { teamId, anchor, state, entries, owner, send, accept, ...actors };
}

export function importedBody(fields: Partial<ItemImportedBody> & Pick<ItemImportedBody, 'id' | 'kind'>): ItemImportedBody {
  return { title: fields.id, state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], ...fields };
}

export const CHORE_ID = `item:${'0'.repeat(22)}7F3K`;

// milestone:v0.9.0 (active) with phase:90 "Alpha work" and phase:91 "Beta work"; plan:90-01 "Alpha slice" is ready-shaped (files, 48000 tokens, two tasks),
// plan:90-02 waits for it; the developer adds one chore with no estimate and no files.
export function seedStandardBoard(world: BoardWorld): void {
  const { owner, dev } = world;
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v0.9.0', kind: 'milestone', title: 'Version 0.9.0', active: true }));
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:90', kind: 'phase', title: 'Alpha work', parentId: 'milestone:v0.9.0' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:91', kind: 'phase', title: 'Beta work', parentId: 'milestone:v0.9.0' }));
  world.accept(owner, 'item.imported', importedBody({
    id: 'plan:90-01', kind: 'plan', title: 'Alpha slice', parentId: 'phase:90', scope: ['src/a/**', 'docs/alpha.md'], estimate: { tokens: 48000 }, requirements: ['BOARD-01'],
    mustHaves: ['The slice works end to end'], gsd: { phase: '90', plan: '01', wave: 1 }
  }));
  world.accept(owner, 'item.imported', importedBody({
    id: 'plan:90-02', kind: 'plan', title: 'Beta slice', parentId: 'phase:90', scope: ['src/b/**'], estimate: { tokens: 12000 }, dependsOn: ['plan:90-01'], requirements: ['BOARD-02']
  }));
  world.accept(owner, 'item.imported', importedBody({ id: 'task:90-01-1', kind: 'task', title: 'Write the test', parentId: 'plan:90-01' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'task:90-01-2', kind: 'task', title: 'Write the code', parentId: 'plan:90-01' }));
  world.accept(dev, 'item.created', { id: CHORE_ID, kind: 'chore', title: 'Tidy settings page', scope: [], requirements: [], mustHaves: [] });
}

// The owner's 0.6.3 re-test board (debug session board-codeserver-cards-and-drag): the scratch project carries this repository's v0.6.0 roadmap, so a
// finished phase holds only done plans and the next phase has no plans yet. Backlog then holds only the phase card, Done (folded) holds every plan,
// and nobody is assigned: milestone:v0.6.0 (active), phase:60 with `donePlans` done plans plan:60-01..., and the planless phase:63.
// assignedPlans (owner decision 2026-11-04, 62-27; off by default, so the board above is unchanged): phase:64 "Board work" with two Ready plans, plan:64-01
// that the lead assigned to the developer and plan:64-02 that the lead assigned to themselves.
// readyShaped (62-28, owner decision 2026-11-05; off by default, so every existing seed is unchanged): each finished plan gets files, an estimate and a
// dependency on the plan before it, so it would be ready to start the moment it is open again, as the scratch project's imported plans are.
export function seedRetestBoard(world: BoardWorld, donePlans = 3, options: { assignedPlans?: boolean; readyShaped?: boolean } = {}): void {
  const { owner, lead, dev } = world;
  world.accept(owner, 'item.imported', importedBody({ id: 'milestone:v0.6.0', kind: 'milestone', title: 'Team Mode', active: true }));
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:60', kind: 'phase', title: 'Team core', parentId: 'milestone:v0.6.0' }));
  for (let i = 1; i <= donePlans; i += 1) {
    const n = String(i).padStart(2, '0');
    const shaped = options.readyShaped === true
      ? { scope: [`src/core/${n}/**`], estimate: { tokens: 20000 }, ...(i > 1 ? { dependsOn: [`plan:60-${String(i - 1).padStart(2, '0')}`] } : {}) }
      : {};
    world.accept(owner, 'item.imported', importedBody({ id: `plan:60-${n}`, kind: 'plan', title: `Core slice ${n}`, parentId: 'phase:60', state: 'done', summary: true, gsd: { phase: '60', plan: n, wave: 1 }, ...shaped }));
  }
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:63', kind: 'phase', title: 'Claims', parentId: 'milestone:v0.6.0' }));
  if (options.assignedPlans !== true) return;
  world.accept(owner, 'item.imported', importedBody({ id: 'phase:64', kind: 'phase', title: 'Board work', parentId: 'milestone:v0.6.0' }));
  world.accept(owner, 'item.imported', importedBody({ id: 'plan:64-01', kind: 'plan', title: 'Developer slice', parentId: 'phase:64', scope: ['src/d/**'], estimate: { tokens: 4000 }, gsd: { phase: '64', plan: '01', wave: 1 } }));
  world.accept(owner, 'item.imported', importedBody({ id: 'plan:64-02', kind: 'plan', title: 'Lead slice', parentId: 'phase:64', scope: ['src/l/**'], estimate: { tokens: 4000 }, gsd: { phase: '64', plan: '02', wave: 1 } }));
  world.accept(lead, 'item.assigned', { id: 'plan:64-01', memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:64-02', memberId: lead.memberId });
}

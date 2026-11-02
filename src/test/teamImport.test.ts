// Importing the GSD files of the integration branch as signed work items (D-01 to D-09, success criterion 1). The tracer pushes the fixture roadmap to
// a bare remote, imports it from the private ref in one commit, has a second clone materialise the same items and shows that a second import writes nothing.
// The rest of the file covers updates, cancellations, cleaning, list caps and the size fit, chunking, milestones, the stale guard, the two-lead race,
// permissions and the live import of this repository's own .planning at HEAD.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { MAX_EVENT_BYTES, canonicalBytes, canonicalize } from '../domain/team/canonical';
import { parsePlanTasks } from '../domain/team/gsdImport';
import type { GsdGraph, GsdPlan } from '../domain/team/gsdImport';
import { serialiseState, teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import type { GenesisAnchor, ItemImportedBody, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import {
  IMPORT_STATE_FILE, NOT_IN_ROADMAP, WITHHELD_TEXT, diffImport, fitItemBody, graphToItems, importPlans, importResultText, listImportableMilestones
} from '../team/importPlans';
import type { ImportResult } from '../team/importPlans';
import { emailHash, newTeamId } from '../team/identity';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { canonicalTeamFile } from '../team/teamFile';
import { closeRig, confirm, createRig, enable, invite, join, openLog, publishProject, rootOf, storageOf } from './helpers/teamFlowRig';
import type { Rig } from './helpers/teamFlowRig';
import { createOwner, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';

const FIXTURE_PLANNING = path.join(__dirname, '..', '..', 'test', 'fixtures', 'gsd-import', 'planning');

const FIXTURE_IDS = [
  'milestone:v0.9.0', 'phase:90', 'phase:91', 'phase:91.1', 'phase:92', 'plan:90-01', 'plan:90-02', 'plan:91.1-01',
  'task:90-01-1', 'task:90-01-2', 'task:90-02-1', 'task:90-02-2', 'task:91.1-01-1'
];

interface Client { transport: GitTransport<TeamState>; log: TeamLog }

function clientFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor, signer?: TeamSigner): Client {
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'), projectRoot: fixture.clones[name] as string, remote: 'origin',
    ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(anchor), baseDelayMs: 1
  });
  return { transport, log: new TeamLog({ anchor, transport, ...(signer === undefined ? {} : { signer }) }) };
}

async function withFixture(names: string[], run: (fixture: TeamFixture) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: names });
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function seedTeam(fixture: TeamFixture): Promise<{ owner: TestOwner; signer: TeamSigner; anchor: GenesisAnchor; a: Client }> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Import team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy()
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Import team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, signer);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { owner, signer, anchor: genesis.anchor, a };
}

function put(dir: string, relative: string, text: string): void {
  const target = path.join(dir, ...relative.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
}

function commitAndPush(dir: string, message: string): string {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  gitIn(dir, ['push', '-q', 'origin', 'main']);
  return gitIn(dir, ['rev-parse', 'HEAD']);
}

/** Copies the committed fixture tree into the clone as .planning, commits it on main and pushes. */
function pushFixturePlanning(dir: string): string {
  cpSync(FIXTURE_PLANNING, path.join(dir, '.planning'), { recursive: true });
  return commitAndPush(dir, 'planning files');
}

const coordinationCommits = (fixture: TeamFixture): number => Number(gitIn(fixture.remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF]));

function okResult(result: ImportResult): Extract<ImportResult, { ok: true }> {
  if (!result.ok) assert.fail(result.message);
  return result;
}

test('the fixture roadmap on the integration branch becomes 13 signed items in one commit, a second clone sees the same items and a re-import writes nothing', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const a = fixture.clones.a as string;
    const pushed = pushFixturePlanning(a);
    const before = coordinationCommits(fixture);
    const source = { projectRoot: a, remote: 'origin', branch: 'main' };
    const storageDir = path.join(fixture.storageDir('a'), 'import');

    const first = okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' }));
    assert.equal(first.written, 13);
    assert.equal(first.upToDate, false);
    assert.equal(first.milestone, 'v0.9.0');
    assert.equal(first.withheld, 1, 'the bearer token must-have of 90-02 is withheld');
    assert.equal(coordinationCommits(fixture), before + 1, 'the whole import is one commit');

    const items = seed.a.log.state().items;
    assert.deepEqual([...items.keys()].sort(), [...FIXTURE_IDS].sort());
    const milestone = items.get('milestone:v0.9.0');
    assert.equal(milestone?.active, true);
    assert.equal(milestone?.source, pushed);
    assert.equal(milestone?.state, 'backlog');
    assert.equal(items.get('phase:91.1')?.parentId, 'milestone:v0.9.0');

    const one = items.get('plan:90-01');
    assert.equal(one?.state, 'done');
    assert.equal(one?.summary, true);
    assert.equal(one?.parentId, 'phase:90');
    for (const id of ['task:90-01-1', 'task:90-01-2']) assert.equal(items.get(id)?.state, 'done', id);
    assert.deepEqual(items.get('task:90-01-1')?.tags, ['tracer']);
    assert.equal(items.get('task:90-01-1')?.parentId, 'plan:90-01');

    const two = items.get('plan:90-02');
    assert.equal(two?.state, 'backlog');
    assert.equal(two?.summary, undefined);
    assert.deepEqual(two?.dependsOn, ['plan:90-01']);
    assert.deepEqual(two?.scope, ['src/fixture/beta.ts']);
    assert.deepEqual(two?.estimate, { tokens: 52000, confidence: 'medium' });
    assert.deepEqual(two?.requirements, ['FIX-02']);
    assert.deepEqual(two?.tags, ['gap-closure']);
    assert.equal(two?.mustHaves[1], WITHHELD_TEXT, 'the bearer token truth is stored as the placeholder');
    assert.deepEqual(two?.gsd, { phase: '90', plan: '02', wave: 2, file: '.planning/phases/90-alpha/90-02-PLAN.md' });
    assert.equal(items.get('task:90-02-2')?.state, 'backlog');

    const b = clientFor(fixture, 'b', seed.anchor);
    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.equal(serialiseState(b.log.state()), serialiseState(seed.a.log.state()), 'clone b materialises exactly the same items');

    const second = okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' }));
    assert.equal(second.upToDate, true);
    assert.equal(second.written, 0);
    assert.equal(coordinationCommits(fixture), before + 1, 'a re-import makes no commit');
  });
});

// ---- reading the coordination branch back -----------------------------------------------------------------------------------------------------

interface StoredEvent { type: string; lamport: number; body: Record<string, unknown> & { id?: string; changes?: Record<string, unknown>; reason?: string }; path: string; bytes: number }

function eventsAt(remote: string, names: string[]): StoredEvent[] {
  return names.filter((name) => name.startsWith('events/')).sort().map((name) => {
    const parsed = JSON.parse(gitIn(remote, ['show', `${DEFAULT_COORDINATION_REF}:${name}`])) as Omit<StoredEvent, 'path' | 'bytes'>;
    return { ...parsed, path: name, bytes: Number(gitIn(remote, ['cat-file', '-s', `${DEFAULT_COORDINATION_REF}:${name}`])) };
  });
}

/** Every event file on the coordination branch of the remote, in log order. */
function allEvents(remote: string): StoredEvent[] {
  return eventsAt(remote, gitIn(remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n'));
}

/** The events the newest coordination commit added. */
function newestEvents(remote: string): StoredEvent[] {
  return eventsAt(remote, gitIn(remote, ['diff-tree', '--no-commit-id', '--name-only', '-r', DEFAULT_COORDINATION_REF]).split('\n'));
}

const summary = (events: StoredEvent[]): string[] => events.map((event) => `${event.type} ${event.body.id ?? ''}`);

function edit(dir: string, relative: string, change: (text: string) => string): void {
  const target = path.join(dir, ...relative.split('/'));
  writeFileSync(target, change(readFileSync(target, 'utf8')), 'utf8');
}

function replaceOnce(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `the text holds ${JSON.stringify(from.slice(0, 40))}`);
  return text.replace(from, to);
}

interface Seeded { fixture: TeamFixture; seed: Awaited<ReturnType<typeof seedTeam>>; a: string; source: { projectRoot: string; remote: string; branch: string }; storageDir: string }

async function withImportedFixture(run: (seeded: Seeded) => Promise<void>): Promise<void> {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const a = fixture.clones.a as string;
    pushFixturePlanning(a);
    const seeded: Seeded = { fixture, seed, a, source: { projectRoot: a, remote: 'origin', branch: 'main' }, storageDir: path.join(fixture.storageDir('a'), 'import') };
    okResult(await importPlans({ log: seed.a.log, source: seeded.source, storageDir: seeded.storageDir, mode: 'command' }));
    await run(seeded);
  });
}

const importAgain = (s: Seeded, extra: { mode?: 'auto' | 'command'; milestone?: string; git?: GitRunner } = {}): Promise<ImportResult> => importPlans({
  log: s.seed.a.log, source: s.source, storageDir: s.storageDir, mode: extra.mode ?? 'command',
  ...(extra.milestone === undefined ? {} : { milestone: extra.milestone }), ...(extra.git === undefined ? {} : { git: extra.git })
});

// ---- updates, cancellations and the never-move rule ---------------------------------------------------------------------------------------------

test('a pushed roadmap change updates what changed, never moves a card, cancels what left the roadmap and keeps finished work, all as no-op on repeat', async () => {
  await withImportedFixture(async (s) => {
    const remote = s.fixture.remote;
    // Step 1: rename 90-02, give it a file and a SUMMARY, and take phase 91.1 out of the roadmap (its plan file stays behind).
    edit(s.a, '.planning/ROADMAP.md', (text) => {
      let next = replaceOnce(text, 'Second slice (FIX-02)', 'Second slice renamed (FIX-02)');
      next = replaceOnce(next, '- [ ] **Phase 91.1: Beta fix (INSERTED)** - An inserted decimal phase\n', '');
      return next.replace(/#### Phase 91\.1:[\s\S]*?(?=### Phase 92)/, '');
    });
    edit(s.a, '.planning/phases/90-alpha/90-02-PLAN.md', (text) => replaceOnce(text, '  - src/fixture/beta.ts\n', '  - src/fixture/beta.ts\n  - src/fixture/gamma.ts\n'));
    put(s.a, '.planning/phases/90-alpha/90-02-SUMMARY.md', 'Done.\n');
    const second = commitAndPush(s.a, 'roadmap change');
    const before = Number(gitIn(remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF]));

    const result = okResult(await importAgain(s));
    assert.equal(Number(gitIn(remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF])), before + 1, 'one commit');
    const events = newestEvents(remote);
    assert.deepEqual(summary(events), [
      'item.updated plan:90-02', 'item.cancelled phase:91.1', 'item.cancelled plan:91.1-01', 'item.cancelled task:91.1-01-1', 'item.updated milestone:v0.9.0'
    ]);
    assert.deepEqual(Object.keys(events[0]?.body.changes ?? {}).sort(), ['scope', 'summary', 'title']);
    assert.deepEqual(events[1]?.body.reason, NOT_IN_ROADMAP);
    assert.deepEqual(events[4]?.body.changes, { source: second });
    assert.equal(result.written, 5);

    const items = s.seed.a.log.state().items;
    const plan = items.get('plan:90-02');
    assert.equal(plan?.title, 'Second slice renamed');
    assert.deepEqual(plan?.scope, ['src/fixture/beta.ts', 'src/fixture/gamma.ts']);
    assert.equal(plan?.summary, true);
    assert.equal(plan?.state, 'backlog', 'a SUMMARY never moves a card');
    for (const id of ['phase:91.1', 'plan:91.1-01', 'task:91.1-01-1']) assert.equal(items.get(id)?.state, 'cancelled', id);
    assert.equal(items.get('plan:90-01')?.state, 'done');
    assert.equal(items.get('milestone:v0.9.0')?.source, second);
    assert.equal(okResult(await importAgain(s)).written, 0, 'a further re-import writes nothing');

    // Step 2: 90-01 leaves the roadmap but is done, so it and its tasks stay done; 90-02 loses the dependency that no longer exists.
    edit(s.a, '.planning/ROADMAP.md', (text) => text.replace(/- \[x\] 90-01-PLAN\.md[^\n]*\n/, ''));
    rmSync(path.join(s.a, '.planning/phases/90-alpha/90-01-PLAN.md'));
    rmSync(path.join(s.a, '.planning/phases/90-alpha/90-01-SUMMARY.md'));
    commitAndPush(s.a, 'drop the finished plan');
    okResult(await importAgain(s));
    const after = s.seed.a.log.state().items;
    for (const id of ['plan:90-01', 'task:90-01-1', 'task:90-01-2']) assert.equal(after.get(id)?.state, 'done', `${id} stays done`);
    assert.deepEqual(after.get('plan:90-02')?.dependsOn, []);
    assert.equal(okResult(await importAgain(s)).written, 0);
  });
});

// ---- CR-02: an incomplete read is additive only ---------------------------------------------------------------------------------------------------

const plainItem = (state: TeamState, id: string): string => canonicalize(state.items.get(id) ?? null);

test('CR-02: a read cut at the path cap cancels nothing and changes nothing, adds only new plans, and a complete read afterwards applies the changes', async () => {
  await withImportedFixture(async (s) => {
    const before = new Map(FIXTURE_IDS.map((id) => [id, plainItem(s.seed.a.log.state(), id)]));
    // Phase 91.1 leaves the roadmap and 90-02 is renamed: a complete read would cancel three items and update one.
    edit(s.a, '.planning/ROADMAP.md', (text) => {
      let next = replaceOnce(text, 'Second slice (FIX-02)', 'Second slice renamed (FIX-02)');
      next = replaceOnce(next, '- [ ] **Phase 91.1: Beta fix (INSERTED)** - An inserted decimal phase\n', '');
      return next.replace(/#### Phase 91\.1:[\s\S]*?(?=### Phase 92)/, '');
    });
    put(s.a, '.planning/phases/90-alpha/90-00-PLAN.md', '---\nphase: 90\nplan: 00\nfiles_modified:\n  - src/fixture/early.ts\n---\n\n# Plan 90-00: Early slice\n');
    commitAndPush(s.a, 'roadmap change');
    const commitsBefore = coordinationCommits(s.fixture);

    // Listed in order: ROADMAP, STATE, the archived 01-01 plan, 90-00, 90-01, its SUMMARY; 90-02 and 91.1-01 fall past a cap of 6.
    const cut = okResult(await importPlans({ log: s.seed.a.log, source: s.source, storageDir: s.storageDir, mode: 'command', limits: { maxPaths: 6 } }));
    assert.ok(cut.warnings.some((warning) => /too many files to read completely, so only new items were added/.test(warning)), cut.warnings.join(' | '));
    const written = newestEvents(s.fixture.remote).map((event) => `${event.type} ${String(event.body.id)}`);
    assert.equal(coordinationCommits(s.fixture), commitsBefore + 1);
    assert.deepEqual(written, ['item.imported plan:90-00', 'item.updated milestone:v0.9.0'], 'only the new plan (and the source it came from) is written');
    const after = s.seed.a.log.state();
    for (const id of FIXTURE_IDS.filter((entry) => !entry.startsWith('milestone:'))) assert.equal(plainItem(after, id) === before.get(id), true, `${id} is exactly as it was`);
    assert.equal(after.items.get('plan:90-00')?.scope[0], 'src/fixture/early.ts');

    const full = okResult(await importAgain(s));
    assert.ok(full.written > 0);
    const items = s.seed.a.log.state().items;
    for (const id of ['phase:91.1', 'plan:91.1-01', 'task:91.1-01-1']) assert.equal(items.get(id)?.state, 'cancelled', `${id} is cancelled once the whole folder is read`);
    assert.equal(items.get('plan:90-02')?.title, 'Second slice renamed');
  });
});

test('CR-02: a plan too large to read keeps its scope, must-haves and tasks while the rest of the import still updates', async () => {
  await withImportedFixture(async (s) => {
    const kept = ['plan:90-02', 'task:90-02-1', 'task:90-02-2'].map((id) => [id, plainItem(s.seed.a.log.state(), id)] as const);
    edit(s.a, '.planning/phases/90-alpha/90-02-PLAN.md', (text) => `${text}\n${'padding line that makes the plan too large to read\n'.repeat(6000)}`);
    edit(s.a, '.planning/ROADMAP.md', (text) => replaceOnce(text, 'Repair the beta slice', 'Repair the beta slice again'));
    commitAndPush(s.a, 'huge plan and a rename');

    const result = okResult(await importAgain(s));
    assert.ok(result.warnings.some((warning) => warning.includes('90-02-PLAN.md is too large to read')), result.warnings.join(' | '));
    const events = newestEvents(s.fixture.remote).map((event) => `${event.type} ${String(event.body.id)}`);
    assert.deepEqual(events, ['item.updated plan:91.1-01', 'item.updated milestone:v0.9.0'], 'only the readable change is written');
    const state = s.seed.a.log.state();
    for (const [id, text] of kept) assert.equal(plainItem(state, id) === text, true, `${id} is exactly as it was`);
    assert.equal(state.items.get('plan:91.1-01')?.title, 'Repair the beta slice again');
    assert.equal(okResult(await importAgain(s)).written, 0, 'a repeat writes nothing');
  });
});

test('CR-02 / T-62-47: a .planning listing over the byte cap is refused before anything is read or written, and git is stopped at the cap', async () => {
  await withImportedFixture(async (s) => {
    for (let index = 0; index < 80; index += 1) put(s.a, `.planning/phases/90-alpha/notes-${String(index).padStart(3, '0')}-${'n'.repeat(60)}.md`, `note ${index}\n`);
    commitAndPush(s.a, 'many notes');
    const commitsBefore = coordinationCommits(s.fixture);
    const listings: Array<number | undefined> = [];
    const watching: GitRunner = (args, options) => { if (args[0] === 'ls-tree') listings.push(options?.maxStdoutBytes); return runGit(args, options); };
    const result = await importPlans({ log: s.seed.a.log, source: s.source, storageDir: s.storageDir, mode: 'command', git: watching, limits: { maxListingBytes: 2048 } });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /planning folder is too large to read/);
      assert.equal(result.written, 0);
      assert.equal(importResultText(result), 'The import did not finish: The planning folder is too large to read. Nothing was changed.');
    }
    assert.deepEqual(listings, [2048], 'the listing was read with the byte cap');
    assert.equal(coordinationCommits(s.fixture), commitsBefore, 'nothing was written');
  });
});

test('a plan a person cancelled stays cancelled when it is still in the roadmap, and the result counts it so a lead can reopen it', async () => {
  await withImportedFixture(async (s) => {
    const cancelled = await s.seed.a.log.append(() => [{ type: 'item.cancelled', body: { id: 'plan:90-02', reason: 'not needed any more' } }]);
    assert.equal(cancelled.ok, true);
    const result = okResult(await importAgain(s));
    assert.equal(result.reopenNeeded, 1);
    assert.equal(result.written, 0);
    assert.equal(s.seed.a.log.state().items.get('plan:90-02')?.state, 'cancelled');
    assert.match(importResultText(result), /1 plan is back in the roadmap but cancelled on the board; reopen it if it should continue\.$/);
  });
});

test('an owner-held, moved or blocked card keeps its state through a re-import that changes its text', async () => {
  await withImportedFixture(async (s) => {
    const held = await s.seed.a.log.append(() => [
      { type: 'item.updated', body: { id: 'plan:90-02', changes: { hold: true } } },
      { type: 'item.blocked', body: { id: 'plan:91.1-01', reason: 'waiting for a review' } }
    ]);
    assert.equal(held.ok, true);
    edit(s.a, '.planning/ROADMAP.md', (text) => replaceOnce(text, 'Repair the beta slice', 'Repair the beta slice again'));
    commitAndPush(s.a, 'rename');
    okResult(await importAgain(s));
    const items = s.seed.a.log.state().items;
    assert.equal(items.get('plan:90-02')?.hold, true);
    assert.equal(items.get('plan:91.1-01')?.title, 'Repair the beta slice again');
    assert.equal(items.get('plan:91.1-01')?.blocked?.reason, 'waiting for a review');
    assert.equal(items.get('plan:91.1-01')?.state, 'backlog');
  });
});

// ---- cleaning, caps and the size fit --------------------------------------------------------------------------------------------------------------

function syntheticPlan(overrides: Partial<GsdPlan> = {}): GsdPlan {
  return {
    phase: '1', plan: '01', path: '.planning/phases/01-p/01-01-PLAN.md', title: 'A plan', dependsOn: [], filesModified: [], requirements: [], truths: [], gapClosure: false,
    hasSummary: false, tasks: [], ...overrides
  };
}

function syntheticGraph(plans: GsdPlan[]): GsdGraph {
  return {
    milestone: { key: 'v1.0.0', title: 'Version one', current: true }, phases: [{ number: '1', title: 'Phase one', dependsOn: [], requirements: [] }], plans,
    milestones: [{ key: 'v1.0.0', title: 'Version one', current: true }], warnings: []
  };
}

const COMMIT = 'a'.repeat(40);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const planBody = (bodies: ItemImportedBody[], id = 'plan:1-01'): ItemImportedBody => {
  const body = bodies.find((item) => item.id === id);
  assert.ok(body !== undefined, `${id} was built`);
  return body as ItemImportedBody;
};

test('every text is cleaned per field: control characters and whitespace, code-point cuts, lone surrogates and secret-like strings', () => {
  const astral = `${'x'.repeat(199)}${'\u{1F600}'.repeat(50)}`;
  const built = graphToItems(syntheticGraph([syntheticPlan({
    title: '  tab\there\nnewline \u0007bell\u0000  ',
    truths: ['No log ever holds a bearer token', 'A fine truth', `broken \uD83D half`, astral, '   '],
    filesModified: ['src/ok.ts', '../escape.ts', '/absolute.ts', 'src/ok.ts'],
    requirements: ['FIX-01', 'not a requirement'],
    tasks: [
      { index: 1, title: `Use the key sk-${'q'.repeat(24)} here`, type: 'auto', files: ['src/a.ts'] },
      { index: 2, title: astral, type: 'sk-abcdefghij1', files: [] }
    ]
  })]), { sourceCommit: COMMIT });
  const plan = planBody(built.bodies);
  assert.equal(plan.title, 'tab here newline bell');
  assert.equal(plan.mustHaves[0], WITHHELD_TEXT);
  assert.equal(plan.mustHaves[1], 'A fine truth');
  assert.equal(plan.mustHaves[2], 'broken � half');
  assert.ok((plan.mustHaves[3] as string).length <= 600 && !LONE_SURROGATE.test(plan.mustHaves[3] as string));
  assert.equal(plan.mustHaves.length, 4, 'a blank truth is dropped');
  assert.deepEqual(plan.scope, ['src/ok.ts'], 'unsafe paths are dropped and repeats are folded');
  assert.deepEqual(plan.requirements, ['FIX-01']);
  const task = planBody(built.bodies, 'task:1-01-1');
  assert.equal(task.title, WITHHELD_TEXT);
  const second = planBody(built.bodies, 'task:1-01-2');
  assert.ok(second.title.length <= 200 && second.title.length >= 199, 'cut at a code point, never inside a pair');
  assert.equal(LONE_SURROGATE.test(second.title), false);
  assert.deepEqual(second.tags, [], 'a task type that looks like a secret is not used as a tag');
  assert.equal(built.withheld, 3, 'the bearer truth, the sk- title and the sk- tag');
  assert.ok(built.warnings.length >= 3);
  for (const body of built.bodies) assert.doesNotThrow(() => canonicalize(body));
});

test('WR-01: a lone surrogate in any field never stops the import: a broken file path is dropped with a warning and the rest is kept', () => {
  const built = graphToItems(syntheticGraph([syntheticPlan({
    title: 'Title \uD800 half', truths: ['Truth \uDC00 half', 'A fine truth'], filesModified: ['src/\uD800.ts', 'src/ok.ts'], path: '.planning/phases/01-p/\uDBFF-PLAN.md',
    tasks: [{ index: 1, title: 'Task \uDFFF', type: 'auto', files: ['\uDC01', 'src/task.ts'] }]
  })]), { sourceCommit: COMMIT });
  const plan = planBody(built.bodies);
  assert.deepEqual(plan.scope, ['src/ok.ts']);
  assert.deepEqual(plan.mustHaves, ['Truth \uFFFD half', 'A fine truth']);
  assert.equal(plan.title, 'Title \uFFFD half');
  assert.equal(plan.gsd?.file, undefined, 'a broken plan path is not kept as the file reference');
  assert.deepEqual(planBody(built.bodies, 'task:1-01-1').scope, ['src/task.ts']);
  assert.ok(built.warnings.filter((warning) => /broken character/.test(warning)).length >= 3, built.warnings.join(' | '));
  for (const body of built.bodies) assert.doesNotThrow(() => canonicalBytes(body));
});

test('WR-01: a plan file whose frontmatter escapes half a surrogate pair is imported through git, with that entry dropped and every other item written', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const a = fixture.clones.a as string;
    cpSync(FIXTURE_PLANNING, path.join(a, '.planning'), { recursive: true });
    edit(a, '.planning/phases/90-alpha/90-02-PLAN.md', (text) => replaceOnce(text, '  - src/fixture/beta.ts\n', '  - src/fixture/beta.ts\n  - "src/\\ud800.ts"\n')
      .replace('    - "The beta slice builds on the alpha slice"\n', '    - "The beta slice builds on the alpha slice \\udc00"\n'));
    commitAndPush(a, 'a broken escape');
    const result = okResult(await importPlans({ log: seed.a.log, source: { projectRoot: a, remote: 'origin', branch: 'main' }, storageDir: path.join(fixture.storageDir('a'), 'import'), mode: 'command' }));
    assert.equal(result.written, 13, 'every item of the fixture is on the board');
    assert.ok(result.warnings.some((warning) => /plan:90-02: a file path was left out because it has a broken character/.test(warning)), result.warnings.join(' | '));
    const plan = seed.a.log.state().items.get('plan:90-02');
    assert.deepEqual(plan?.scope, ['src/fixture/beta.ts']);
    assert.equal(plan?.mustHaves[0], 'The beta slice builds on the alpha slice \uFFFD');
  });
});

test('every list is cut to its validator cap with a warning that names the item, and the same input cuts the same way', () => {
  const truths = Array.from({ length: 17 }, (_, index) => `Truth number ${index + 1}`);
  const input = syntheticGraph([syntheticPlan({ truths, filesModified: Array.from({ length: 70 }, (_, index) => `src/file${index}.ts`) })]);
  const first = graphToItems(input, { sourceCommit: COMMIT });
  const plan = planBody(first.bodies);
  assert.equal(plan.mustHaves.length, 16);
  assert.equal(plan.mustHaves[15], 'Truth number 16');
  assert.equal(plan.scope.length, 64);
  assert.ok(first.warnings.some((warning) => warning.includes('plan:1-01') && warning.includes('16 must-haves')), first.warnings.join(' | '));
  assert.deepEqual(graphToItems(input, { sourceCommit: COMMIT }), first);
});

function worstCaseBytes(body: ItemImportedBody): number {
  const envelope = {
    v: 1, id: `evt-${'0'.repeat(26)}`, teamId: `team-${'0'.repeat(32)}`, type: 'item.imported', lamport: 999_999_999_999, at: '2026-01-01T00:00:00.000Z',
    author: `mbr-${'0'.repeat(16)}`, device: `dev-${'0'.repeat(32)}`, prev: `evt-${'0'.repeat(26)}`, sig: 'A'.repeat(86), body
  };
  return canonicalBytes(envelope).length;
}

test('a body whose signed event would pass MAX_EVENT_BYTES is shrunk in a fixed order until it fits, and the item is still imported', () => {
  const long = (seed: string): string => `${seed} ${'word '.repeat(120)}`.slice(0, 599).trim();
  const body: ItemImportedBody = {
    id: 'plan:1-01', kind: 'plan', title: 'Big plan', state: 'backlog', dependsOn: [], requirements: ['FIX-01'], tags: [], parentId: 'phase:1',
    mustHaves: Array.from({ length: 16 }, (_, index) => long(`Truth ${index}`)), scope: Array.from({ length: 64 }, (_, index) => `${'d'.repeat(190)}${String(index).padStart(2, '0')}.ts`)
  };
  assert.ok(worstCaseBytes(body) > MAX_EVENT_BYTES, 'the input really is too big');
  const fitted = fitItemBody(body);
  assert.ok(worstCaseBytes(fitted.body) <= MAX_EVENT_BYTES);
  assert.ok(fitted.warning?.includes('plan:1-01'), fitted.warning);
  assert.ok(fitted.body.mustHaves.length >= 1, 'the first must-have stays');
  assert.deepEqual(fitted.body.mustHaves[0], body.mustHaves[0]?.slice(0, fitted.body.mustHaves[0]?.length), 'what is kept is a prefix of the original');
  assert.deepEqual(fitItemBody(body), fitted, 'pure and deterministic');
  assert.deepEqual(fitItemBody(fitted.body), { body: fitted.body }, 'a body that fits is returned unchanged with no warning');
  const built = graphToItems(syntheticGraph([syntheticPlan({ truths: body.mustHaves, filesModified: body.scope })]), { sourceCommit: COMMIT });
  assert.ok(built.bodies.some((item) => item.id === 'plan:1-01'), 'the plan is still imported');
});

test('over-cap and oversize plans pushed to the branch are imported trimmed with warnings, nothing else is lost, and a re-import writes nothing', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const a = fixture.clones.a as string;
    cpSync(FIXTURE_PLANNING, path.join(a, '.planning'), { recursive: true });
    const truths = (count: number, text: (index: number) => string): string => Array.from({ length: count }, (_, index) => `    - "${text(index)}"`).join('\n');
    edit(a, '.planning/phases/90-alpha/90-02-PLAN.md', (text) => text.replace(/  truths:\n(?:    - .*\n)+/, `  truths:\n${truths(17, (index) => `Truth number ${index + 1}`)}\n`));
    edit(a, '.planning/phases/91.1-beta-fix/91.1-01-PLAN.md', (text) => {
      const files = Array.from({ length: 64 }, (_, index) => `  - ${'d'.repeat(190)}${String(index).padStart(2, '0')}.ts`).join('\n');
      return text.replace(/files_modified:\n(?:  - .*\n)+/, `files_modified:\n${files}\n`).replace(/  truths:\n(?:    - .*\n)+/, `  truths:\n${truths(16, (index) => `${'word '.repeat(119)}${index}`)}\n`);
    });
    commitAndPush(a, 'big plans');
    const source = { projectRoot: a, remote: 'origin', branch: 'main' };
    const storageDir = path.join(fixture.storageDir('a'), 'import');
    const result = okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' }));
    assert.equal(result.written, 13, 'every item of the fixture is on the board');
    assert.ok(result.warnings.some((warning) => warning.includes('plan:90-02')), result.warnings.join(' | '));
    assert.ok(result.warnings.some((warning) => warning.includes('plan:91.1-01')), result.warnings.join(' | '));
    const items = seed.a.log.state().items;
    assert.equal(items.get('plan:90-02')?.mustHaves.length, 16);
    const trimmed = items.get('plan:91.1-01')?.mustHaves.length ?? 99;
    assert.ok(trimmed >= 1 && trimmed < 16, `the trailing must-haves were dropped first (${trimmed} kept)`);
    assert.equal(items.get('plan:91.1-01')?.scope.length, 64, 'the file paths fit once the trailing must-haves were gone');
    for (const event of allEvents(fixture.remote)) assert.ok(event.bytes <= MAX_EVENT_BYTES, `${event.path} is ${event.bytes} bytes`);
    assert.equal(okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' })).written, 0);
  });
});

// ---- chunking -------------------------------------------------------------------------------------------------------------------------------------

function writeBigRoadmap(dir: string, plans: number, tasksPerPlan: number): void {
  const names = Array.from({ length: plans }, (_, index) => String(index + 1).padStart(2, '0'));
  put(dir, '.planning/ROADMAP.md', [
    '# Roadmap: Big', '', '## Milestones', '', '- \u{1F6A7} **v1.0.0 Big**: Phases 1-1 (current milestone)', '', '## v1.0.0 Big', '', '### Phase 1: Big phase', '',
    '**Goal**: Many tasks.', '**Depends on**: Nothing', '**Requirements**: BIG-01', `**Plans**: ${plans} plans`, '', ...names.map((name) => `- [ ] 1-${name}-PLAN.md — Plan ${name}`), ''
  ].join('\n'));
  put(dir, '.planning/STATE.md', '---\nmilestone: v1.0.0\n---\n\nState.\n');
  for (const name of names) {
    const tasks = Array.from({ length: tasksPerPlan }, (_, index) => `<task type="auto">\n  <name>Task ${index + 1}: Step ${index + 1}</name>\n  <files>src/big/p${name}t${index + 1}.ts</files>\n  <action>Do it.</action>\n</task>`).join('\n');
    put(dir, `.planning/phases/01-big/01-${name}-PLAN.md`, `---\nphase: 01-big\nplan: ${name}\nwave: 1\ndepends_on: []\nfiles_modified:\n  - src/big/p${name}.ts\nrequirements: [BIG-01]\nestimate:\n  tokens: 1000\n  confidence: high\nmust_haves:\n  truths:\n    - "Plan ${name} works"\n---\n\n<tasks>\n\n${tasks}\n\n</tasks>\n`);
  }
}

test('600 task items are written in three appends of at most 250 intents, parents before children, and a re-import writes nothing', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const a = fixture.clones.a as string;
    writeBigRoadmap(a, 12, 50);
    commitAndPush(a, 'big roadmap');
    const source = { projectRoot: a, remote: 'origin', branch: 'main' };
    const storageDir = path.join(fixture.storageDir('a'), 'import');
    const before = Number(gitIn(fixture.remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF]));
    const result = okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' }));
    assert.equal(result.written, 1 + 1 + 12 + 600);
    // The log also writes a snapshot every 500 events, so the item events are counted per commit and snapshot commits are left out.
    const commits = gitIn(fixture.remote, ['rev-list', '--reverse', DEFAULT_COORDINATION_REF]).split('\n').slice(before);
    const sizes = commits.map((commit) => {
      const names = gitIn(fixture.remote, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n');
      return eventsAt(fixture.remote, names).filter((event) => event.type.startsWith('item.')).length;
    }).filter((count) => count > 0);
    assert.deepEqual(sizes, [250, 250, 114], 'three appends of at most 250 intents');
    const b = clientFor(fixture, 'b', seed.anchor);
    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, [], 'parents were written before their children');
    assert.equal(b.log.state().items.size, 614);
    assert.equal(okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' })).written, 0);
  });
});

// ---- milestones -----------------------------------------------------------------------------------------------------------------------------------

test('an archived milestone imports without becoming active or touching the current one, and a new current milestone switches active', async () => {
  await withImportedFixture(async (s) => {
    const current = (): string => canonicalize([...s.seed.a.log.state().items.values()].filter((item) => item.id.includes('0.9.0') || /^(phase|plan|task):9/.test(item.id)));
    const snapshot = current();
    const archived = okResult(await importAgain(s, { milestone: 'v0.1.0' }));
    assert.equal(archived.milestone, 'v0.1.0');
    assert.ok(archived.written >= 3);
    const items = s.seed.a.log.state().items;
    assert.equal(items.get('milestone:v0.1.0')?.active, undefined);
    assert.equal(items.get('milestone:v0.9.0')?.active, true);
    assert.equal(current(), snapshot, 'no v0.9.0 item was touched');
    assert.equal(okResult(await importAgain(s, { milestone: 'v0.1.0' })).written, 0);

    edit(s.a, '.planning/STATE.md', (text) => replaceOnce(text, 'milestone: v0.9.0', 'milestone: v0.1.0'));
    commitAndPush(s.a, 'the current milestone moves');
    const switched = okResult(await importAgain(s));
    assert.equal(switched.milestone, 'v0.1.0');
    const after = s.seed.a.log.state().items;
    assert.equal(after.get('milestone:v0.1.0')?.active, true);
    assert.equal(after.get('milestone:v0.9.0')?.active, undefined);
    assert.equal(after.get('plan:90-02')?.state, 'backlog', 'the old milestone keeps its cards');
  });
});

test('listImportableMilestones names every milestone of the roadmap with the current one first', async () => {
  await withImportedFixture(async (s) => {
    const list = await listImportableMilestones(s.source);
    assert.deepEqual(list.map((item) => [item.key, item.current]), [['v0.9.0', true], ['v0.1.0', false]]);
  });
});

// ---- the stale-leader guard and change detection ----------------------------------------------------------------------------------------------------

test('an import that read an older commit than the one recorded on the board is skipped as stale and writes nothing', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const a = fixture.clones.a as string;
    const first = pushFixturePlanning(a);
    const source = { projectRoot: a, remote: 'origin', branch: 'main' };
    const storageDir = path.join(fixture.storageDir('a'), 'import');
    okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' }));
    edit(a, '.planning/ROADMAP.md', (text) => replaceOnce(text, 'Repair the beta slice', 'Repair the beta slice better'));
    const second = commitAndPush(a, 'newer roadmap');
    okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' }));
    assert.equal(seed.a.log.state().items.get('milestone:v0.9.0')?.source, second);
    const commits = Number(gitIn(fixture.remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF]));

    const stale = okResult(await importPlans({ log: seed.a.log, source: { projectRoot: a, ref: first }, storageDir, mode: 'command' }));
    assert.equal(stale.skipped, 'stale-source');
    assert.equal(stale.written, 0);
    assert.equal(Number(gitIn(fixture.remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF])), commits);
    assert.equal(seed.a.log.state().items.get('plan:91.1-01')?.title, 'Repair the beta slice better');
  });
});

test('a recorded source this repository does not have is skipped with a warning in auto mode and read anyway in command mode', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const a = fixture.clones.a as string;
    const b = fixture.clones.b as string;
    pushFixturePlanning(a);
    gitIn(b, ['pull', '-q', '--ff-only', 'origin', 'main']);
    const storageDir = path.join(fixture.storageDir('a'), 'import');
    okResult(await importPlans({ log: seed.a.log, source: { projectRoot: a, remote: 'origin', branch: 'main' }, storageDir, mode: 'command' }));
    edit(a, '.planning/ROADMAP.md', (text) => replaceOnce(text, 'Repair the beta slice', 'Repair the beta slice newer'));
    commitAndPush(a, 'newer roadmap');
    okResult(await importPlans({ log: seed.a.log, source: { projectRoot: a, remote: 'origin', branch: 'main' }, storageDir, mode: 'command' }));

    const other = clientFor(fixture, 'b', seed.anchor, seed.signer);
    await other.log.sync();
    const otherStorage = path.join(fixture.storageDir('b'), 'import');
    const auto = okResult(await importPlans({ log: other.log, source: { projectRoot: b, ref: 'HEAD' }, storageDir: otherStorage, mode: 'auto' }));
    assert.equal(auto.skipped, 'stale-source');
    assert.equal(auto.written, 0);
    assert.ok(auto.warnings.some((warning) => warning.includes('does not have')), auto.warnings.join(' | '));
    const command = okResult(await importPlans({ log: other.log, source: { projectRoot: b, ref: 'HEAD' }, storageDir: otherStorage, mode: 'command' }));
    assert.equal(command.skipped, undefined);
    assert.ok(command.written > 0, 'command mode proceeds');
  });
});

test('auto mode skips an unchanged .planning tree without reading a plan file, a head move outside .planning writes nothing, and command mode always compares', async () => {
  await withImportedFixture(async (s) => {
    const calls: string[][] = [];
    const watching: GitRunner = (args, options) => { calls.push(args); return runGit(args, options); };
    const commits = (): number => Number(gitIn(s.fixture.remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF]));
    const stateText = readFileSync(path.join(s.storageDir, IMPORT_STATE_FILE), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(stateText) as object).sort(), ['milestone', 'sourceCommit', 'treeHash']);

    put(s.a, 'README.md', '# moved the head\n');
    commitAndPush(s.a, 'readme only');
    const before = commits();
    const skipped = okResult(await importAgain(s, { mode: 'auto', git: watching }));
    assert.equal(skipped.skipped, 'unchanged-tree');
    assert.equal(skipped.written, 0);
    assert.equal(calls.some((args) => args[0] === 'cat-file'), false, 'no plan file was read');

    const compared = okResult(await importAgain(s, { mode: 'command', git: watching }));
    assert.equal(compared.skipped, undefined);
    assert.equal(compared.written, 0);
    assert.equal(commits(), before, 'the head moved but nothing under .planning did, so nothing was written');
    assert.equal(calls.some((args) => args[0] === 'cat-file'), true, 'command mode read the files');

    // A change under .planning that touches no imported field parses and diffs to nothing.
    edit(s.a, '.planning/STATE.md', (text) => `${text}\nA note that no item carries.\n`);
    commitAndPush(s.a, 'state note');
    const changed = okResult(await importAgain(s, { mode: 'auto' }));
    assert.equal(changed.skipped, undefined);
    assert.equal(changed.written, 0);
    assert.equal(commits(), before);
    assert.equal(okResult(await importAgain(s, { mode: 'auto' })).skipped, 'unchanged-tree', 'the new tree is remembered');
  });
});

// ---- two leads, a developer ---------------------------------------------------------------------------------------------------------------------

async function withTeamRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await createRig({ linked: false });
  try {
    await enable(rig);
    await publishProject(rig);
    await invite(rig, rig.dev);
    await invite(rig, rig.lead);
    await join(rig, rig.dev);
    await join(rig, rig.lead);
    await confirm(rig, rig.lead);
    await confirm(rig, rig.dev);
    pushFixturePlanning(rootOf(rig, 'a'));
    await run(rig);
  } finally {
    await closeRig(rig);
  }
}

test('when the owner and a lead import at once the coordination CAS turns the loser into a no-op: one item.imported per item', async () => {
  await withTeamRig(async (rig) => {
    const owner = await openLog(rig, 'owner');
    const lead = await openLog(rig, rig.lead);
    const results = await Promise.all([
      importPlans({ log: owner.log, source: { projectRoot: rootOf(rig, 'a'), remote: 'origin', branch: 'main' }, storageDir: path.join(storageOf(rig, 'owner'), 'import'), mode: 'command' }),
      importPlans({ log: lead.log, source: { projectRoot: rootOf(rig, 'c'), remote: 'origin', branch: 'main' }, storageDir: path.join(storageOf(rig, rig.lead), 'import'), mode: 'command' })
    ]);
    const done = results.map(okResult);
    assert.deepEqual(done.map((result) => result.written).sort((x, y) => x - y), [0, 13], done.map((result) => result.written).join(','));
    const imported = allEvents(rig.fixture.remote).filter((event) => event.type === 'item.imported');
    assert.equal(imported.length, 13);
    assert.deepEqual(imported.map((event) => event.body.id).sort(), [...FIXTURE_IDS].sort());
    assert.equal(new Set(imported.map((event) => event.body.id)).size, 13, 'no id twice');
    await owner.log.sync();
    await lead.log.sync();
    assert.equal(serialiseState(lead.log.state()), serialiseState(owner.log.state()));
  });
});

test('a developer cannot import: the result carries the permission reason and nothing is written', async () => {
  await withTeamRig(async (rig) => {
    const dev = await openLog(rig, rig.dev);
    const before = gitIn(rig.fixture.remote, ['rev-list', '--all', '--count']);
    const result = await importPlans({
      log: dev.log, source: { projectRoot: rootOf(rig, 'b'), remote: 'origin', branch: 'main' }, storageDir: path.join(storageOf(rig, rig.dev), 'import'), mode: 'command'
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.message.startsWith('not permitted'), result.message);
    assert.equal(result.written, 0);
    assert.equal(gitIn(rig.fixture.remote, ['rev-list', '--all', '--count']), before, 'the remote gained no commit');
    assert.equal(importResultText(result), `The import did not finish: ${result.message}. Nothing was changed.`);
  });
});

// ---- words for the person -----------------------------------------------------------------------------------------------------------------------

test('importResultText says what happened in plain words', () => {
  const base = { ok: true as const, milestone: 'v1.0.0', withheld: 0, reopenNeeded: 0, warnings: [], upToDate: false };
  assert.equal(importResultText({ ...base, written: 13 }), 'Imported 13 items to the Team Board.');
  assert.equal(importResultText({ ...base, written: 1 }), 'Imported 1 item to the Team Board.');
  assert.equal(importResultText({ ...base, written: 0, upToDate: true }), 'The Team Board is already up to date.');
  assert.equal(importResultText({ ...base, written: 3, reopenNeeded: 2 }), 'Imported 3 items to the Team Board. 2 plans are back in the roadmap but cancelled on the board; reopen them if they should continue.');
  assert.equal(importResultText({ ok: false, message: 'The team remote could not be reached.', written: 0 }), 'The import did not finish: The team remote could not be reached. Nothing was changed.');
  assert.equal(importResultText({ ok: false, message: 'Disk full', written: 250 }), 'The import did not finish: Disk full. 250 items were written; run the import again to finish.');
  assert.equal(importResultText({ ok: false, message: 'Disk full', written: 1 }), 'The import did not finish: Disk full. 1 item was written; run the import again to finish.');
  const leaked = importResultText({ ok: false, message: 'fetch of https://user:hunter2@example.invalid/x.git failed', written: 0 });
  assert.equal(leaked.includes('hunter2'), false);
});

test('diffImport on an empty board returns every body, parents before children', () => {
  const built = graphToItems(syntheticGraph([syntheticPlan({ tasks: [{ index: 1, title: 'Step', type: 'auto', files: [] }] })]), { sourceCommit: COMMIT });
  const options = { milestoneId: 'milestone:v1.0.0', current: true, sourceCommit: COMMIT };
  const intents = diffImport({ items: new Map() }, built.bodies, options);
  assert.deepEqual(intents.map((intent) => intent.type === 'item.imported' ? intent.body.id : intent.type), ['milestone:v1.0.0', 'phase:1', 'plan:1-01', 'task:1-01-1']);
});

// ---- this repository's own .planning at HEAD (success criterion 1) ---------------------------------------------------------------------------------

// The repository root is two levels above dist/test. The ref is HEAD, never main: main does not hold the Phase 60 to 67 roadmap (RESEARCH Pitfall 4).
const REPO_ROOT = path.join(__dirname, '..', '..');

test('this repository\'s own .planning at HEAD imports into a correct graph, and importing it again writes nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const source = { projectRoot: REPO_ROOT, ref: 'HEAD' };
    const storageDir = path.join(fixture.storageDir('a'), 'import');
    const result = okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' }));
    const items = seed.a.log.state().items;
    assert.equal(result.milestone, 'v0.6.0');
    assert.equal(result.written, items.size, 'every item written is on the board');
    assert.ok(items.size > 100, `milestone, phases, plans and tasks, not just ${items.size}`);
    assert.deepEqual(result.warnings.filter((warning) => /was left out|appears twice/.test(warning)), [], 'no item of this repository is skipped');

    assert.equal(items.get('milestone:v0.6.0')?.active, true);
    for (const phase of ['60', '61', '62', '63', '64', '65', '66', '67']) assert.equal(items.get(`phase:${phase}`)?.kind, 'phase', `phase:${phase}`);
    const finished = [...items.values()].filter((item) => item.kind === 'plan' && /^plan:6[01]-/.test(item.id));
    assert.ok(finished.length >= 26, `the 12 plans of Phase 60 and the 14 of Phase 61 (${finished.length})`);
    for (const plan of finished) {
      assert.equal(plan.state, 'done', plan.id);
      assert.equal(plan.summary, true, plan.id);
    }

    const planFile = gitIn(REPO_ROOT, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.planning/phases']).split('\n').find((name) => name.endsWith('/61-05-PLAN.md'));
    assert.ok(planFile !== undefined, '61-05-PLAN.md is committed');
    const taskBlocks = parsePlanTasks(gitIn(REPO_ROOT, ['show', `HEAD:${planFile}`])).length;
    const tasks = [...items.values()].filter((item) => item.parentId === 'plan:61-05');
    assert.ok(taskBlocks > 0);
    assert.equal(tasks.length, taskBlocks, 'one task item per task block of 61-05');
    for (const task of tasks) assert.equal(task.state, 'done', task.id);

    assert.ok(items.get('plan:61-02')?.mustHaves.includes(WITHHELD_TEXT), 'the bearer token must-have of 61-02 is withheld');
    assert.ok((result.withheld ?? 0) >= 1);
    assert.equal(okResult(await importPlans({ log: seed.a.log, source, storageDir, mode: 'command' })).written, 0, 'a re-import writes 0 events');
  });
});

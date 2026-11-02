// Importing the GSD files of the integration branch as signed work items (D-01 to D-09, success criterion 1). The tracer pushes the fixture roadmap to
// a bare remote, imports it from the private ref in one commit, has a second clone materialise the same items and shows that a second import writes nothing.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { serialiseState, teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import type { GenesisAnchor, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { IMPORT_NOOP, importPlans } from '../team/importPlans';
import type { ImportResult } from '../team/importPlans';
import { emailHash, newTeamId } from '../team/identity';
import { canonicalTeamFile } from '../team/teamFile';
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
    assert.equal(IMPORT_NOOP, 'import: nothing to change');
  });
});

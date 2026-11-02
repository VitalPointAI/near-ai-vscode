// The importer reads GSD files from the integration branch as committed on the remote, never from a member's own work (D-01, D-03).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { fetchIntegrationBranch, integrationRef, readPlanningSnapshot } from '../team/integrationSource';

const PLAN_ONE = '.planning/phases/90-alpha/90-01-PLAN.md';
const SUMMARY_ONE = '.planning/phases/90-alpha/90-01-SUMMARY.md';
const PLAN_TWO = '.planning/phases/90-alpha/90-02-PLAN.md';
const PUSHED = ['.planning/ROADMAP.md', '.planning/STATE.md', PLAN_ONE, SUMMARY_ONE];

function put(dir: string, relative: string, text: string): void {
  const target = path.join(dir, ...relative.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
}

function commitAll(dir: string, message: string): string {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  return gitIn(dir, ['rev-parse', 'HEAD']);
}

const wantedPlanning = (file: string): boolean => /(ROADMAP|STATE)\.md$|-PLAN\.md$/.test(file);

interface Pushed { fixture: TeamFixture; a: string; b: string; pushedCommit: string }

async function pushedPlans(): Promise<Pushed> {
  const fixture = await createTeamFixture({ clones: ['a', 'b'] });
  const a = fixture.clones.a ?? '';
  const b = fixture.clones.b ?? '';
  put(a, '.planning/ROADMAP.md', '# Roadmap\n');
  put(a, '.planning/STATE.md', '---\nstatus: executing\n---\n');
  put(a, PLAN_ONE, '---\nphase: 90\nplan: 01\n---\n');
  put(a, SUMMARY_ONE, 'summary text\n');
  const pushedCommit = commitAll(a, 'planning files');
  gitIn(a, ['push', '-q', 'origin', 'main']);
  return { fixture, a, b, pushedCommit };
}

test('the integration branch is read from a private ref and an unpushed local draft stays invisible', async () => {
  const { fixture, a, b, pushedCommit } = await pushedPlans();
  try {
    // B has not fetched A's work yet; it only holds an unpushed local draft plan.
    put(b, PLAN_TWO, 'draft plan that was never pushed\n');
    commitAll(b, 'unpushed draft');
    const headBefore = gitIn(b, ['rev-parse', 'HEAD']);
    const branchesBefore = gitIn(b, ['branch', '--list']);
    const statusBefore = gitIn(b, ['status', '--porcelain']);
    const fetchHeadBefore = existsSync(path.join(b, '.git', 'FETCH_HEAD'));

    const fetched = await fetchIntegrationBranch(b, 'origin', 'main');
    assert.equal(fetched.ok, true);
    if (!fetched.ok) return;
    assert.equal(fetched.ref, 'refs/near-ai/integration/main');
    assert.equal(fetched.commit, pushedCommit);

    const snapshot = await readPlanningSnapshot(b, fetched.ref, wantedPlanning);
    assert.equal(snapshot.commit, pushedCommit);
    assert.deepEqual([...snapshot.paths].sort(), [...PUSHED].sort());
    assert.equal(snapshot.paths.includes(PLAN_TWO), false);
    assert.equal(snapshot.files.get('.planning/ROADMAP.md'), '# Roadmap\n');
    assert.equal(snapshot.files.get('.planning/STATE.md'), '---\nstatus: executing\n---\n');
    assert.equal(snapshot.files.get(PLAN_ONE), '---\nphase: 90\nplan: 01\n---\n');
    assert.equal(snapshot.files.has(PLAN_TWO), false);
    assert.equal(snapshot.truncated, false);

    assert.equal(gitIn(b, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(gitIn(b, ['branch', '--list']), branchesBefore);
    assert.equal(gitIn(b, ['status', '--porcelain']), statusBefore);
    assert.equal(existsSync(path.join(b, '.git', 'FETCH_HEAD')), fetchHeadBefore);

    const onA = await readPlanningSnapshot(a, 'HEAD', wantedPlanning);
    assert.ok(snapshot.treeHash !== undefined && /^[0-9a-f]{40,64}$/.test(snapshot.treeHash));
    assert.equal(onA.treeHash, snapshot.treeHash);
  } finally {
    await fixture.cleanup();
  }
});

test('the private ref name is built from the integration branch name', () => {
  assert.equal(integrationRef('main'), 'refs/near-ai/integration/main');
  assert.equal(integrationRef('release/1.0'), 'refs/near-ai/integration/release/1.0');
});

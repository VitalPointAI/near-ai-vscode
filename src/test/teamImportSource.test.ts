// The importer reads GSD files from the integration branch as committed on the remote, never from a member's own work (D-01, D-03).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { MAX_PLANNING_FILE_BYTES, PlanningTooLargeError, fetchIntegrationBranch, integrationRef, isAncestor, readPlanningSnapshot, remoteBranchHead } from '../team/integrationSource';
import { runGit } from '../team/runGit';

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

async function readPrivate(clone: string, wanted: (file: string) => boolean = wantedPlanning) {
  const fetched = await fetchIntegrationBranch(clone, 'origin', 'main');
  assert.equal(fetched.ok, true);
  if (!fetched.ok) throw new Error('fetch failed');
  return readPlanningSnapshot(clone, fetched.ref, wanted);
}

test('the remote head moves with every push but the .planning tree hash moves only when .planning changes', async () => {
  const { fixture, a, b, pushedCommit } = await pushedPlans();
  try {
    assert.equal(await remoteBranchHead(b, 'origin', 'main'), pushedCommit);
    const first = await readPrivate(b);

    put(a, 'README.md', '# Changed outside .planning\n');
    const readmeCommit = commitAll(a, 'readme only');
    gitIn(a, ['push', '-q', 'origin', 'main']);
    assert.equal(await remoteBranchHead(b, 'origin', 'main'), readmeCommit);
    const second = await readPrivate(b);
    assert.equal(second.commit, readmeCommit);
    assert.equal(second.treeHash, first.treeHash);

    put(a, PLAN_TWO, 'a new pushed plan\n');
    commitAll(a, 'new plan');
    gitIn(a, ['push', '-q', 'origin', 'main']);
    const third = await readPrivate(b);
    assert.notEqual(third.treeHash, first.treeHash);
    assert.ok(third.paths.includes(PLAN_TWO));
  } finally {
    await fixture.cleanup();
  }
});

test('remoteBranchHead is undefined for a branch the remote does not have and explains a failure without the credentials', async () => {
  const { fixture, b } = await pushedPlans();
  try {
    assert.equal(await remoteBranchHead(b, 'origin', 'no-such-branch'), undefined);
    gitIn(b, ['remote', 'set-url', 'origin', 'https://user:canary-secret-62@127.0.0.1:9/repo.git']);
    await assert.rejects(remoteBranchHead(b, 'origin', 'main'), (error: Error) => error.message.length > 0 && !error.message.includes('canary-secret-62'));
  } finally {
    await fixture.cleanup();
  }
});

test('isAncestor answers yes, no, and unknown for a commit that does not exist locally', async () => {
  const { fixture, a, pushedCommit } = await pushedPlans();
  try {
    put(a, 'README.md', 'second\n');
    const second = commitAll(a, 'second');
    assert.equal(await isAncestor(a, pushedCommit, second), true);
    assert.equal(await isAncestor(a, second, pushedCommit), false);
    assert.equal(await isAncestor(a, '0123456789abcdef0123456789abcdef01234567', second), 'unknown');
  } finally {
    await fixture.cleanup();
  }
});

test('a plan file over the size cap is listed as oversize and never read, and files the caller does not want are listed but not read', async () => {
  const { fixture, a, b } = await pushedPlans();
  try {
    put(a, '.planning/phases/90-alpha/90-03-PLAN.md', 'x'.repeat(300 * 1024));
    commitAll(a, 'big plan');
    gitIn(a, ['push', '-q', 'origin', 'main']);
    assert.ok(300 * 1024 > MAX_PLANNING_FILE_BYTES);
    const snapshot = await readPrivate(b, (file) => file.endsWith('-PLAN.md'));
    assert.deepEqual(snapshot.oversize, ['.planning/phases/90-alpha/90-03-PLAN.md']);
    assert.equal(snapshot.files.has('.planning/phases/90-alpha/90-03-PLAN.md'), false);
    assert.ok(snapshot.files.has(PLAN_ONE));
    assert.ok(snapshot.paths.includes(SUMMARY_ONE));
    assert.equal(snapshot.files.has(SUMMARY_ONE), false);
    assert.equal(snapshot.truncated, false);
  } finally {
    await fixture.cleanup();
  }
});

test('CR-02: only the roadmap, the state file and plan and summary files count against the path cap, so other planning files never push plans out', async () => {
  const { fixture, a, b } = await pushedPlans();
  try {
    for (let index = 0; index < 40; index += 1) {
      put(a, `.planning/codebase/map-${index}.md`, 'map\n');
      put(a, `.planning/phases/90-alpha/90-${String(index).padStart(2, '0')}-CONTEXT.md`, 'context\n');
    }
    commitAll(a, 'many other planning files');
    gitIn(a, ['push', '-q', 'origin', 'main']);
    const fetched = await fetchIntegrationBranch(b, 'origin', 'main');
    assert.equal(fetched.ok, true);
    if (!fetched.ok) return;
    const snapshot = await readPlanningSnapshot(b, fetched.ref, wantedPlanning, runGit, { maxPaths: PUSHED.length });
    assert.deepEqual([...snapshot.paths].sort(), [...PUSHED].sort(), 'only the source files are listed');
    assert.equal(snapshot.listingComplete, true);
    assert.equal(snapshot.truncated, false);
    const capped = await readPlanningSnapshot(b, fetched.ref, wantedPlanning, runGit, { maxPaths: PUSHED.length - 1 });
    assert.equal(capped.listingComplete, false, 'one source file over the cap is an incomplete listing');
    assert.equal(capped.truncated, true);
    await assert.rejects(readPlanningSnapshot(b, fetched.ref, wantedPlanning, runGit, { maxListingBytes: 512 }), PlanningTooLargeError);
  } finally {
    await fixture.cleanup();
  }
});

test('T-62-47: runGit stops git once it writes more than maxStdoutBytes and keeps only that many bytes', async () => {
  const { fixture, a } = await pushedPlans();
  try {
    put(a, 'big.txt', 'y'.repeat(2 * 1024 * 1024));
    const blob = gitIn(a, ['hash-object', '-w', 'big.txt']);
    const capped = await runGit(['cat-file', 'blob', blob], { cwd: a, maxStdoutBytes: 64 * 1024 });
    assert.equal(capped.overflowed, true);
    assert.equal(capped.stdout.length <= 64 * 1024, true, `kept ${capped.stdout.length} bytes`);
    assert.notEqual(capped.code, 0);
    const whole = await runGit(['cat-file', 'blob', blob], { cwd: a });
    assert.equal(whole.overflowed, undefined);
    assert.equal(whole.stdout.length, 2 * 1024 * 1024);
  } finally {
    await fixture.cleanup();
  }
});

test('a missing integration branch is reported as missing and an unreachable remote as offline without leaking credentials', async () => {
  const { fixture, b } = await pushedPlans();
  try {
    const missing = await fetchIntegrationBranch(b, 'origin', 'no-such-branch');
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.kind, 'missing');
      assert.match(missing.reason, /no-such-branch was not found on the team remote/);
    }
    gitIn(b, ['remote', 'set-url', 'origin', 'https://user:canary-secret-62@127.0.0.1:9/repo.git']);
    const offline = await fetchIntegrationBranch(b, 'origin', 'main');
    assert.equal(offline.ok, false);
    if (!offline.ok) {
      assert.equal(offline.kind, 'offline');
      assert.ok(offline.reason.length > 0);
      assert.equal(offline.reason.includes('canary-secret-62'), false);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('a branch name git would refuse never reaches git', async () => {
  assert.throws(() => integrationRef('../evil'));
  assert.throws(() => integrationRef('has space'));
  assert.throws(() => integrationRef('-dash'));
  await assert.rejects(fetchIntegrationBranch('/nonexistent-project', 'origin', '../evil'));
});

test('a .planning path with a space or a newline is listed exactly and nothing is created on disk for it', async () => {
  const { fixture, a, b } = await pushedPlans();
  try {
    const odd = '.planning/phases/90-alpha/odd name\nsecond-PLAN.md';
    put(a, odd, 'odd plan\n');
    commitAll(a, 'odd path');
    gitIn(a, ['push', '-q', 'origin', 'main']);
    const snapshot = await readPrivate(b);
    assert.ok(snapshot.paths.includes(odd));
    assert.equal(snapshot.files.get(odd), 'odd plan\n');
    assert.equal(existsSync(path.join(b, '.planning')), false);
  } finally {
    await fixture.cleanup();
  }
});

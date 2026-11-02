// The log carries metadata only (ROADMAP ground rules, SEC-01): after an import of plans whose objective, context and action text and whose secret-like
// strings are canaries made at run time, none of them is on the coordination branch, in a mirror, in the import state file or in team.json. The
// canaries are necessarily in the project's own branch (the plans live there), so the coordination ref is scanned on its own and a control shows the
// scanner does see them where they belong.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { IMPORT_STATE_FILE, WITHHELD_TEXT, importPlans } from '../team/importPlans';
import { runGit } from '../team/runGit';
import { teamFilePath } from '../team/teamFile';
import { closeRig, createRig, enable, openLog, rootOf, storageOf } from './helpers/teamFlowRig';
import { scanFiles, scanGitObjects } from './helpers/teamCanary';
import type { Needle } from './helpers/teamCanary';
import { gitIn } from './helpers/teamHarness';

const FIXTURE_PLANNING = path.join(__dirname, '..', '..', 'test', 'fixtures', 'gsd-import', 'planning');

function editFile(dir: string, relative: string, change: (text: string) => string): void {
  const target = path.join(dir, ...relative.split('/'));
  writeFileSync(target, change(readFileSync(target, 'utf8')), 'utf8');
}

function replaceOnce(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `the plan holds ${JSON.stringify(from.slice(0, 40))}`);
  return text.replace(from, to);
}

// Every object reachable from one ref of a repository, as raw bytes, so a scan can look at the coordination branch without the project's own branch.
async function objectsOfRef(gitDir: string, ref: string): Promise<Buffer> {
  const listed = await runGit(['--git-dir', gitDir, 'rev-list', '--objects', ref], { timeoutMs: 60_000 });
  assert.equal(listed.code, 0, listed.stderr);
  const names = listed.stdout.toString('utf8').split('\n').map((line) => line.split(' ')[0] ?? '').filter((name) => name !== '');
  const read = await runGit(['--git-dir', gitDir, 'cat-file', '--batch'], { input: `${names.join('\n')}\n`, timeoutMs: 60_000 });
  assert.equal(read.code, 0, read.stderr);
  return read.stdout;
}

const foundIn = (haystack: Buffer, needles: Needle[]): string[] => needles.filter((needle) => haystack.includes(Buffer.from(needle.value, 'utf8'))).map((needle) => needle.label);

test('an import writes only metadata: no objective, context or action text and no secret-like string reaches the coordination branch, a mirror, the import state or team.json', async () => {
  const rig = await createRig({ linked: false });
  try {
    await enable(rig);
    const a = rootOf(rig, 'a');
    // Canaries are built at run time; nothing secret-shaped is committed to this repository.
    const secretLike = `sk-${randomBytes(11).toString('hex').slice(0, 21)}`;
    assert.equal(secretLike.length, 24);
    const needles: Needle[] = [
      { label: 'objective', value: 'CANARY-OBJECTIVE-62' }, { label: 'context', value: 'CANARY-CONTEXT-62' },
      { label: 'action', value: 'CANARY-ACTION-62' }, { label: 'secret-like string', value: secretLike }
    ];
    cpSync(FIXTURE_PLANNING, path.join(a, '.planning'), { recursive: true });
    editFile(a, '.planning/phases/90-alpha/90-01-PLAN.md', (text) => {
      let next = replaceOnce(text, 'Build the first slice of the fixture project.', 'Build the first slice of the fixture project. CANARY-OBJECTIVE-62');
      next = replaceOnce(next, '</objective>', '</objective>\n\n<context>\nCANARY-CONTEXT-62 is background the board must never hold.\n</context>');
      next = replaceOnce(next, 'Return a list instead of one value.', 'Return a list instead of one value. CANARY-ACTION-62');
      next = replaceOnce(next, 'The alpha slice returns the value the roadmap promises', `The alpha slice returns the value ${secretLike} promises`);
      return replaceOnce(next, 'Task 1: Tracer: alpha value end to end', `Task 1: Tracer: alpha value ${secretLike}`);
    });
    gitIn(a, ['add', '-A']);
    gitIn(a, ['commit', '-q', '-m', 'canary plans']);
    gitIn(a, ['push', '-q', 'origin', 'main']);

    const teamFile = teamFilePath(a);
    const teamJsonBefore = readFileSync(teamFile);
    const owner = await openLog(rig, 'owner');
    const storageDir = path.join(storageOf(rig, 'owner'), 'import');
    const result = await importPlans({ log: owner.log, source: { projectRoot: a, remote: 'origin', branch: 'main' }, storageDir, mode: 'command' });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.written, 13);
    assert.equal(result.withheld, 3, 'the must-have, the task title and the bearer token truth of 90-02');

    const items = owner.log.state().items;
    assert.equal(items.get('plan:90-01')?.mustHaves[0], WITHHELD_TEXT, 'the stored must-have is the placeholder');
    assert.equal(items.get('task:90-01-1')?.title, WITHHELD_TEXT, 'the stored task title is the placeholder');

    // Control: the project's own branch does hold the canaries, so the scanner is capable of seeing them.
    assert.deepEqual((await scanGitObjects(rig.fixture.remote, needles)).sort(), ['action', 'context', 'objective', 'secret-like string'], 'the bare remote holds them on the code branch');

    // The coordination branch on the remote, on its own.
    assert.deepEqual(foundIn(await objectsOfRef(rig.fixture.remote, DEFAULT_COORDINATION_REF), needles), [], 'every coordination blob on the remote');
    const events = gitIn(rig.fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((name) => name.startsWith('events/'));
    assert.ok(events.length >= 13, 'the import is on the branch the scan looked at');

    // The owner's coordination mirror holds only that branch.
    assert.deepEqual(await scanGitObjects(path.join(storageOf(rig, 'owner'), 'coordination.git'), needles), [], 'the coordination mirror');

    // The import state and team.json.
    assert.deepEqual(await scanFiles([storageDir], needles), [], 'the import state folder');
    const state = JSON.parse(readFileSync(path.join(storageDir, IMPORT_STATE_FILE), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(state).sort(), ['milestone', 'sourceCommit', 'treeHash']);
    assert.deepEqual(readFileSync(teamFile), teamJsonBefore, 'team.json is byte-identical to before the import');
  } finally {
    await closeRig(rig);
  }
});

// Plan 27-26 (REVIEW blocker 1, the git boundary): nothing inside the project folder may decide what git runs. A hook planted where sync used to keep its
// hooks folder, and a git config planted where it used to keep its mirror, must run nothing and be read by nothing while sync is turned on, run twice and
// pulled against a real local bare remote. Sentinel scripts are written at test time into folders outside the project; if one runs, its file appears.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitHooksFolderError, privateHooksDir, runStateGit } from '../services/stateGit';
import { StateTransport } from '../services/stateTransport';
import { buildStateSync, defaultMirrorRoot, mirrorFolderName, removeOldInProjectSyncFolders, turnOnFlow } from '../services/syncFlows';
import { stateHomeFor } from '../services/stateHome';
import { bareRemote, computer, fakeUi, fixtureGit, setUpProfile } from './helpers/flowFixtures';
import { hermeticRunner } from './helpers/gitFixtures';

const PLAIN_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A shell script that writes a sentinel file when it is run, whoever runs it. */
function sentinelScript(file: string, sentinel: string): void {
  writeFileSync(file, `#!/bin/sh\necho ran >> '${sentinel}'\nexit 0\n`);
  chmodSync(file, 0o755);
}

/** A hash of every file and folder name under a folder, so "the same before and after" is one comparison. */
function fingerprint(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const info = lstatSync(full);
      hash.update(`${path.relative(dir, full)}\n`);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

test('tracer: turning sync on, syncing twice and pulling run no planted hook and read no planted mirror config', async () => {
  const bare = bareRemote({ withMain: false });
  const trap = bareRemote({ withMain: false });
  const outside = scratch('near-ai-hostile-outside-');
  const sentinel = path.join(outside, 'RAN');
  const a = computer(bare, 'alpha');
  await setUpProfile(a);

  // What an attacker (a pulled repository, an agent with edit rights) puts where sync used to keep its hooks folder and mirror.
  const planted = path.join(a.root, '.near-ai', 'state', 'sync');
  const hooks = path.join(planted, 'hooks');
  const mirror = path.join(planted, 'mirror.git');
  mkdirSync(hooks, { recursive: true });
  for (const name of ['pre-push', 'reference-transaction', 'post-update', 'pre-commit', 'update']) sentinelScript(path.join(hooks, name), sentinel);
  fixtureGit(planted, ['init', '--bare', '-q', mirror]);
  const helper = path.join(outside, 'helper.sh');
  sentinelScript(helper, sentinel);
  const included = path.join(outside, 'included.config');
  writeFileSync(included, `[core]\n\tsshCommand = ${helper}\n`);
  writeFileSync(path.join(mirror, 'config'), [
    '[core]', '\trepositoryformatversion = 0', '\tbare = true', `\tsshCommand = ${helper}`, `\tfsmonitor = ${helper}`, `\thooksPath = ${hooks}`,
    '[credential]', `\thelper = !${helper}`,
    '[include]', `\tpath = ${included}`,
    '[remote "state"]', `\turl = ${trap}`, '\tfetch = +refs/heads/*:refs/remotes/state/*', ''
  ].join('\n'));
  sentinelScript(path.join(mirror, 'hooks-planted.sh'), sentinel);
  const before = [fingerprint(hooks), fingerprint(mirror)];

  const turnedOn = await turnOnFlow({ env: a.env, ui: fakeUi().ui });
  assert.equal(turnedOn.status, 'on', turnedOn.message);
  assert.equal((await a.env.makeSync({ remote: 'origin' }).sync()).kind, 'synced');
  assert.equal((await a.env.makeSync({ remote: 'origin' }).sync()).kind, 'synced');
  const pulled = await a.env.makeSync({ remote: 'origin' }).pullOnly();
  assert.ok(pulled.kind === 'synced' || pulled.kind === 'nothing-yet', `pull finished (${pulled.kind})`);

  assert.equal(existsSync(sentinel), false, 'no planted hook, helper or config script ran');
  assert.equal(fixtureGit(trap, ['for-each-ref']).trim(), '', 'the planted remote received nothing');
  assert.match(fixtureGit(bare, ['for-each-ref', 'refs/heads/near-ai/state']), /refs\/heads\/near-ai\/state/, 'the real remote got the state branch');
  assert.deepEqual([fingerprint(hooks), fingerprint(mirror)], before, 'the planted folders were neither read into nor written to');
  const realMirror = path.join(defaultMirrorRoot(), mirrorFolderName(a.root), 'mirror.git');
  assert.equal(existsSync(path.join(realMirror, 'HEAD')), true, 'the real mirror is in the private folder');
});

test('mirrorFolderName is 16 lower-case hex characters, stable for a root, and the mirror goes under mirrorRoot or a private temporary folder', async () => {
  const root = scratch('near-ai-hostile-root-');
  assert.match(mirrorFolderName(root), /^[0-9a-f]{16}$/);
  assert.equal(mirrorFolderName(root), mirrorFolderName(path.join(root, '.', 'x', '..')));
  assert.notEqual(mirrorFolderName(root), mirrorFolderName(scratch('near-ai-hostile-root-')));

  const bare = bareRemote({ withMain: false });
  const a = computer(bare, 'alpha');
  const rootFolder = scratch('near-ai-hostile-mirrors-');
  const parts = { ...a.parts, mirrorRoot: rootFolder };
  const sync = buildStateSync(parts, { remote: 'origin' });
  await sync.remoteState();
  assert.equal(existsSync(path.join(rootFolder, mirrorFolderName(a.root), 'mirror.git', 'HEAD')), true, 'the mirror is at <mirrorRoot>/<name>/mirror.git');
  assert.equal(existsSync(path.join(a.root, '.near-ai', 'state', 'sync', 'mirror.git')), false, 'nothing is made inside the project');

  const other = computer(bareRemote({ withMain: false }), 'bravo');
  await buildStateSync(other.parts, { remote: 'origin' }).remoteState();
  const privateRoot = defaultMirrorRoot();
  assert.equal(path.relative(other.root, privateRoot).startsWith('..'), true, 'the default mirror root is outside the project');
  assert.equal(existsSync(path.join(privateRoot, mirrorFolderName(other.root), 'mirror.git', 'HEAD')), true);
  assert.equal(statSync(privateRoot).mode & 0o077, 0, 'the private mirror root is owner-only');
});

test('a transport refuses a mirror or hooks folder inside the project, including through a symbolic link', () => {
  const root = scratch('near-ai-hostile-root-');
  const outside = scratch('near-ai-hostile-outside-');
  const sentence = /Sync's private folders must be outside the project folder\. Nothing was changed\./;
  const make = (mirrorDir: string, hooksDir: string): StateTransport => new StateTransport({ root, mirrorDir, hooksDir, git: hermeticRunner() });
  assert.throws(() => make(path.join(root, '.near-ai', 'state', 'sync', 'mirror.git'), path.join(outside, 'hooks')), sentence);
  assert.throws(() => make(path.join(outside, 'mirror.git'), path.join(root, 'hooks')), sentence);
  assert.throws(() => make(root, path.join(outside, 'hooks')), sentence);
  // A folder that looks outside but is a link into the project.
  const link = path.join(outside, 'link');
  symlinkSync(root, link);
  assert.throws(() => make(path.join(link, 'mirror.git'), path.join(outside, 'hooks')), sentence);
  assert.throws(() => make(path.join(outside, 'mirror.git'), path.join(link, 'hooks')), sentence);
  // The same project reached through a link still counts as the project.
  const rootLink = path.join(outside, 'root-link');
  symlinkSync(root, rootLink);
  assert.throws(() => new StateTransport({ root: rootLink, mirrorDir: path.join(root, 'm.git'), hooksDir: path.join(outside, 'hooks'), git: hermeticRunner() }), sentence);
  assert.doesNotThrow(() => make(path.join(outside, 'mirror.git'), path.join(outside, 'hooks')));
  // A folder named like a parent reference is not mistaken for escaping the project.
  assert.throws(() => make(path.join(root, '..hidden', 'mirror.git'), path.join(outside, 'hooks')), sentence);
});

test('runStateGit refuses a hooks folder that is not an empty real directory and never runs the hook in it', async () => {
  const outside = scratch('near-ai-hostile-outside-');
  const sentinel = path.join(outside, 'RAN');
  const repo = path.join(outside, 'repo');
  mkdirSync(repo);
  fixtureGit(repo, ['init', '-q']);
  writeFileSync(path.join(repo, 'file.txt'), 'x\n');
  fixtureGit(repo, ['add', 'file.txt']);

  const full = path.join(outside, 'full-hooks');
  mkdirSync(full);
  sentinelScript(path.join(full, 'pre-commit'), sentinel);
  await assert.rejects(() => runStateGit(['commit', '-q', '-m', 'x'], { cwd: repo, hooksDir: full, env: { ...PLAIN_ENV, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' } }), (error: unknown) => {
    assert.ok(error instanceof GitHooksFolderError);
    assert.equal((error as Error).message, "Sync's private hooks folder is not empty, so git was not started.");
    return true;
  });
  assert.equal(existsSync(sentinel), false, 'the hook never ran');
  assert.throws(() => fixtureGit(repo, ['rev-parse', '--verify', 'HEAD']), 'no commit was made: git was never started');

  // A symbolic link to an empty folder is not a real directory either.
  const empty = path.join(outside, 'empty');
  mkdirSync(empty);
  const link = path.join(outside, 'link-hooks');
  symlinkSync(empty, link);
  await assert.rejects(() => runStateGit(['--version'], { hooksDir: link, env: PLAIN_ENV }), GitHooksFolderError);

  // An empty real folder runs as before, and a folder that does not exist yet is made empty.
  const ok = await runStateGit(['--version'], { hooksDir: empty, env: PLAIN_ENV });
  assert.equal(ok.code, 0);
  const later = path.join(outside, 'made', 'hooks');
  assert.equal((await runStateGit(['--version'], { hooksDir: later, env: PLAIN_ENV })).code, 0);
  assert.equal(readdirSync(later).length, 0);
});

test('privateHooksDir is one empty owner-only folder per process', () => {
  const first = privateHooksDir();
  assert.equal(privateHooksDir(), first);
  assert.equal(lstatSync(first).isDirectory(), true);
  assert.equal(statSync(first).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(first), []);
  assert.equal(path.relative(tmpdir(), first).startsWith('near-ai-no-hooks-'), true);
});

// ---- the one-time removal of what earlier dev builds left inside the project ------------------------------------------------------------

async function homeWithOldFolders(): Promise<{ home: ReturnType<typeof stateHomeFor>; sync: string }> {
  const root = scratch('near-ai-hostile-old-');
  const home = stateHomeFor(root);
  await home.ensure();
  const sync = home.paths.sync;
  await mkdir(path.join(sync, 'mirror.git', 'objects'), { recursive: true });
  writeFileSync(path.join(sync, 'mirror.git', 'config'), '[core]\n');
  writeFileSync(path.join(sync, 'mirror.git', 'objects', 'one'), randomBytes(8));
  await mkdir(path.join(sync, 'hooks'), { recursive: true });
  writeFileSync(path.join(sync, 'hooks', 'pre-push'), '#!/bin/sh\n');
  return { home, sync };
}

test('removeOldInProjectSyncFolders removes the old mirror and hooks folders and leaves every other file alone', async () => {
  const { home, sync } = await homeWithOldFolders();
  const state = randomBytes(16);
  const records = randomBytes(24);
  writeFileSync(path.join(sync, 'state.json'), state);
  writeFileSync(path.join(sync, 'records.enc'), records);
  writeFileSync(path.join(sync, 'online-home.json'), '{"x":1}\n');
  await removeOldInProjectSyncFolders(home);
  assert.equal(existsSync(path.join(sync, 'mirror.git')), false);
  assert.equal(existsSync(path.join(sync, 'hooks')), false);
  assert.deepEqual(readFileSync(path.join(sync, 'state.json')), state);
  assert.deepEqual(readFileSync(path.join(sync, 'records.enc')), records);
  assert.equal(readFileSync(path.join(sync, 'online-home.json'), 'utf8'), '{"x":1}\n');
  const after = fingerprint(sync);
  await removeOldInProjectSyncFolders(home);
  assert.equal(fingerprint(sync), after, 'a second call changes nothing');
});

test('removeOldInProjectSyncFolders unlinks a symbolic link and never follows it', async () => {
  const { home, sync } = await homeWithOldFolders();
  const outside = scratch('near-ai-hostile-canary-');
  const canary = path.join(outside, 'canary.txt');
  writeFileSync(canary, 'keep me\n');
  const otherOutside = scratch('near-ai-hostile-canary-');
  const otherCanary = path.join(otherOutside, 'canary.txt');
  writeFileSync(otherCanary, 'keep me too\n');
  rmSync(path.join(sync, 'mirror.git'), { recursive: true, force: true });
  rmSync(path.join(sync, 'hooks'), { recursive: true, force: true });
  symlinkSync(outside, path.join(sync, 'mirror.git'));
  symlinkSync(otherOutside, path.join(sync, 'hooks'));
  await removeOldInProjectSyncFolders(home);
  assert.equal(existsSync(path.join(sync, 'mirror.git')), false, 'the link is gone');
  assert.equal(lstatSync(sync).isDirectory(), true);
  assert.equal(readdirSync(sync).includes('hooks'), false);
  assert.equal(readFileSync(canary, 'utf8'), 'keep me\n', 'the folder the link pointed at still holds its file');
  assert.equal(readFileSync(otherCanary, 'utf8'), 'keep me too\n');
});

test('removeOldInProjectSyncFolders creates nothing for a project with no state home', async () => {
  const root = scratch('near-ai-hostile-none-');
  await removeOldInProjectSyncFolders(stateHomeFor(root));
  assert.deepEqual(readdirSync(root), [], 'no .near-ai folder appeared');
  // A sync folder without a state home (no meta.json) is not this function's business either.
  const stray = path.join(root, '.near-ai', 'state', 'sync', 'mirror.git');
  mkdirSync(stray, { recursive: true });
  await removeOldInProjectSyncFolders(stateHomeFor(root));
  assert.equal(existsSync(stray), true);
});

test('the editor keeps its sync mirrors in its own storage and removes the old folders only once the state home exists', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'syncCommands.ts'), 'utf8');
  assert.match(source, /mirrorRoot:\s*path\.join\(context\.globalStorageUri\.fsPath,\s*'sync-mirrors'\)/);
  assert.match(source, /removeOldInProjectSyncFolders\(runtime\.env\.home\)/);
  const flows = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'syncFlows.ts'), 'utf8');
  assert.match(flows, /export async function removeOldInProjectSyncFolders[\s\S]*?home\.exists\(\)/);
  assert.equal(flows.includes("paths.sync, 'mirror.git'"), false, 'the mirror is no longer built inside the state home');
});

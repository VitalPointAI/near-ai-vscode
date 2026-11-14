// Plan 27-13's security carry-forward: the sync mirror's config holds the remote's address, so an address with a password or token in it must never be
// written there. Credentials reach git only through the environment of each call, as a rewrite of the plain address. Local bare repositories and a fake
// runner only: the runner stands in for the host by pointing the plain address at a local bare repository.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { addGitConfigEnv, splitAddress, type GitRunner } from '../services/stateGit';
import { defaultMirrorRoot, enterCodeFlow, mirrorFolderName, turnOnFlow } from '../services/syncFlows';
import { bareRemote, computer, fakeUi, fixtureGit, setUpProfile } from './helpers/flowFixtures';
import { hermeticRunner } from './helpers/gitFixtures';
import { SIX_TURNS, chain } from './helpers/syncFixtures';

/** Where a computer's sync mirror is: outside the project, under the per-process mirror folder. */
const mirrorOf = (c: { root: string }): string => path.join(defaultMirrorRoot(), mirrorFolderName(c.root), 'mirror.git');

const PASSWORD = 's3cr3t-pass-7f31';
const CLEAN = 'https://git.example.test/team/project.git';
const CREDENTIALED = `https://alice:${PASSWORD}@git.example.test/team/project.git`;

interface Watch { runner: GitRunner; mapped: number; unmappedNetwork: string[]; argumentLeaks: string[] }

/** A runner that stands in for the host: it checks where the credential travels and points the plain address at the local bare repository. */
function hostRunner(bare: string): Watch {
  const base = hermeticRunner();
  const watch: Watch = { runner: base, mapped: 0, unmappedNetwork: [], argumentLeaks: [] };
  watch.runner = async (args, options = {}) => {
    for (const argument of args) if (argument.includes(PASSWORD) || argument.includes('alice:')) watch.argumentLeaks.push(args.join(' '));
    const env: Record<string, string> = { ...options.env };
    const count = Number(env.GIT_CONFIG_COUNT ?? '0');
    let mapping = false;
    for (let index = 0; index < count; index += 1) {
      const key = env[`GIT_CONFIG_KEY_${index}`] ?? '';
      if (key.startsWith('url.') && key.endsWith('.insteadOf') && key.includes(PASSWORD)) {
        assert.equal(env[`GIT_CONFIG_VALUE_${index}`], CLEAN, 'the credentialed address replaces the plain one, nothing else');
        env[`GIT_CONFIG_KEY_${index}`] = `url.${bare}.insteadOf`;
        mapping = true;
      }
    }
    const network = args.some((argument) => ['fetch', 'push', 'ls-remote'].includes(argument)) && !args.includes('--get-url');
    if (mapping) watch.mapped += 1;
    else if (network && args.includes('--git-dir')) watch.unmappedNetwork.push(args.join(' '));
    return base(args, { ...options, env });
  };
  return watch;
}

async function everyFile(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await everyFile(full)); else out.push(full);
  }
  return out;
}

async function assertNoUserinfo(dir: string): Promise<number> {
  const files = await everyFile(dir);
  for (const file of files) {
    const text = (await readFile(file)).toString('latin1');
    assert.ok(!text.includes(PASSWORD), `${file} holds the password`);
    assert.ok(!text.includes('alice:') && !text.includes('alice@'), `${file} holds the user name`);
  }
  return files.length;
}

test('splitAddress removes the userinfo from web addresses and only a password from ssh ones', () => {
  assert.deepEqual(splitAddress(CREDENTIALED), { clean: CLEAN, credentialed: CREDENTIALED });
  assert.deepEqual(splitAddress('https://token@github.com/a/b.git'), { clean: 'https://github.com/a/b.git', credentialed: 'https://token@github.com/a/b.git' });
  assert.deepEqual(splitAddress('ssh://git:pw@host.example/a/b.git'), { clean: 'ssh://git@host.example/a/b.git', credentialed: 'ssh://git:pw@host.example/a/b.git' });
  assert.deepEqual(splitAddress('ssh://git@host.example/a/b.git'), { clean: 'ssh://git@host.example/a/b.git' });
  assert.deepEqual(splitAddress('git@github.com:a/b.git'), { clean: 'git@github.com:a/b.git' });
  assert.deepEqual(splitAddress('/tmp/remote.git'), { clean: '/tmp/remote.git' });
  const env = addGitConfigEnv(addGitConfigEnv(undefined, 'a.b', '1'), 'c.d', '2');
  assert.deepEqual(env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2' });
});

test('after turn-on, sync and unlock with a credentialed remote, no mirror, state folder or project file holds the userinfo, and git got it only in its environment', async () => {
  const bare = bareRemote({ withMain: false });
  const watched = hostRunner(bare);
  const a = computer(bare, 'alpha', { git: watched.runner });
  fixtureGit(a.root, ['remote', 'set-url', 'origin', CREDENTIALED]);
  await setUpProfile(a);
  await a.threads.create({ id: 'conv-cred-1', title: 'Credentialed', model: 'near/model-a', origin: 'panel' });
  await a.threads.appendEntries('conv-cred-1', chain('conv-cred-1', a.parts.writer, SIX_TURNS));

  const turnOn = fakeUi();
  assert.equal((await turnOnFlow({ env: a.env, ui: turnOn.ui })).status, 'on');
  const again = await a.env.makeSync({ remote: 'origin' }).sync();
  assert.equal(again.kind, 'synced');

  const b = computer(bare, 'bravo', { git: watched.runner });
  fixtureGit(b.root, ['remote', 'set-url', 'origin', CREDENTIALED]);
  assert.equal((await enterCodeFlow({ env: b.env, ui: fakeUi({ code: turnOn.shown[0] }).ui })).status, 'restored');
  assert.equal((await b.threads.entries('conv-cred-1')).length, 6, 'the sync worked through the rewritten address');

  // Positive controls: git did get the credential, in its environment, on every network call of the mirror.
  assert.ok(watched.mapped >= 6, `the credentialed address reached git through the environment (${watched.mapped} calls)`);
  assert.deepEqual(watched.unmappedNetwork, [], 'every network call of a mirror carried the rewrite');
  assert.deepEqual(watched.argumentLeaks, [], 'no git argument carried the userinfo');

  // The mirror's config holds the plain address.
  const config = await readFile(path.join(mirrorOf(a), 'config'), 'utf8');
  assert.ok(config.includes(`url = ${CLEAN}`), 'the mirror points at the plain address');
  // The mirrors now live outside the project, so they are scanned where they are, as well as the state folders.
  const scanned = await assertNoUserinfo(a.home.dir) + await assertNoUserinfo(b.home.dir) + await assertNoUserinfo(path.dirname(mirrorOf(a))) + await assertNoUserinfo(path.dirname(mirrorOf(b)));
  assert.ok(scanned > 20, `the scan covered the state folders (${scanned} files)`);
});

test('a mirror configured by an earlier version with the userinfo in it is cleaned by the next sync', async () => {
  const bare = bareRemote({ withMain: false });
  const watched = hostRunner(bare);
  const a = computer(bare, 'alpha', { git: watched.runner });
  fixtureGit(a.root, ['remote', 'set-url', 'origin', CREDENTIALED]);
  await setUpProfile(a);
  assert.equal((await turnOnFlow({ env: a.env, ui: fakeUi().ui })).status, 'on');
  const mirror = mirrorOf(a);
  fixtureGit(mirror, ['config', 'remote.state.url', CREDENTIALED]);
  assert.ok((await readFile(path.join(mirror, 'config'), 'utf8')).includes(PASSWORD), 'the old config held it');
  // A fresh process (a new transport) writes the plain address again.
  assert.equal((await a.env.makeSync({ remote: 'origin' }).sync()).kind, 'synced');
  assert.ok(!(await readFile(path.join(mirror, 'config'), 'utf8')).includes(PASSWORD), 'the next sync removed it');
});

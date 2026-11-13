import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { STATE_REF, StateTransport, validateRemote } from '../services/stateTransport';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths, sealedFiles, tempDirectory, userRepo } from './helpers/gitFixtures';

const ROOT = path.join(__dirname, '..', '..');
const NO_HOME = 'This project has no online home yet';

async function transport(root: string, remote?: string): Promise<StateTransport> {
  const paths = await mirrorPaths();
  return new StateTransport({ root, remote, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: hermeticRunner() });
}

function refsOf(bare: string): string[] {
  return fixtureGit(bare, ['for-each-ref', '--format=%(refname)']).split('\n').filter((line) => line !== '');
}

test('a transport built for the remote "backup" pushes there, and origin stays without the state branch', async () => {
  const origin = bareRemote();
  const backup = bareRemote();
  const person = userRepo(origin, { remotes: { backup } });
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  const t = await transport(person.dir, 'backup');
  const commit = await t.writeCommit(files);
  assert.deepEqual(await t.push(commit), { ok: true, value: commit });
  assert.ok(refsOf(backup).includes(STATE_REF));
  assert.equal(refsOf(origin).includes(STATE_REF), false);
  // An address works the same way as a name.
  const other = bareRemote({ withMain: false });
  const byPath = await transport(person.dir, other);
  assert.equal((await byPath.push(await byPath.writeCommit(files))).ok, true);
  assert.deepEqual(refsOf(other), [STATE_REF]);
});

test('validateRemote accepts a configured name and the plain address forms, and refuses helper transports, unknown names and empty values', () => {
  const names = ['origin', 'backup'];
  assert.deepEqual(validateRemote('backup', names), { kind: 'name' });
  for (const url of ['https://github.com/me/repo.git', 'https://user@example.com/me/repo.git', 'ssh://git@example.com/me/repo.git', 'git@github.com:me/repo.git', '/srv/git/repo.git', 'file:///srv/git/repo.git', 'C:\\repos\\project.git']) {
    assert.deepEqual(validateRemote(url, names), { kind: 'url' }, url);
  }
  for (const bad of ['ext::sh -c x', 'fd::3', 'foo::bar', 'https::x', 'origin::', '', ' origin', '-oProxyCommand=x', '--upload-pack=x', 'nope', 'http://example.com/x.git', 'git@host:x\n::y', 'ext::sh']) {
    const result = validateRemote(bad, names);
    assert.equal('message' in result && result.kind, 'invalid-remote', JSON.stringify(bad));
  }
  const none = validateRemote('origin', []);
  assert.ok('message' in none && none.kind === 'no-remote' && none.message.startsWith(NO_HOME));
});

test('the private-remote setting stays deferred, and the word origin appears in the sync services only as a default value', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { configuration: { properties?: Record<string, unknown> } | Array<{ properties?: Record<string, unknown> }> } };
  const configuration = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
  const names = configuration.flatMap((section) => Object.keys(section.properties ?? {}));
  assert.equal(names.some((name) => /^nearAi\.sync\.remote$/.test(name)), false);
  const folder = path.join(ROOT, 'src', 'services');
  const sources = readdirSync(folder).filter((name) => /^state.*\.ts$/.test(name));
  assert.ok(sources.includes('stateTransport.ts') && sources.includes('stateGit.ts'));
  let quoted = 0;
  for (const name of sources) {
    const text = readFileSync(path.join(folder, name), 'utf8');
    assert.equal(/sync\.remote/.test(text), false, `${name} names no remote setting`);
    quoted += (text.match(/['"]origin['"]/g) ?? []).length;
  }
  assert.ok(quoted <= 1, `quoted origin appears ${quoted} times`);
  assert.equal(readFileSync(path.join(folder, 'stateTransport.ts'), 'utf8').includes('remote add'), false);
});

test('a project with no remote at all has no online home, and nothing is ever added to its repository', async () => {
  const plain = await tempDirectory('near-ai-noremote-');
  fixtureGit(plain, ['init', '-q', '-b', 'main']);
  const configBefore = readFileSync(path.join(plain, '.git', 'config'), 'utf8');
  const t = await transport(plain);
  const resolved = await t.resolveRemoteUrl();
  assert.ok(!resolved.ok && resolved.failure.kind === 'no-remote' && resolved.failure.message.startsWith(NO_HOME));
  const fetched = await t.fetch();
  assert.ok(!fetched.ok && fetched.failure.kind === 'no-remote');
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  const pushed = await t.push(await t.writeCommit(files));
  assert.ok(!pushed.ok && pushed.failure.kind === 'no-remote');
  assert.equal(fixtureGit(plain, ['remote']).trim(), '');
  assert.equal(readFileSync(path.join(plain, '.git', 'config'), 'utf8'), configBefore);
  // A folder that is not a repository at all is the same answer.
  const folder = await tempDirectory('near-ai-notrepo-');
  const none = await (await transport(folder)).resolveRemoteUrl();
  assert.ok(!none.ok && none.failure.kind === 'no-remote');
});

test('a repository cannot send the state through a helper transport, even through its own remote settings', async () => {
  const marker = path.join(await tempDirectory('near-ai-marker-'), 'ran');
  const person = userRepo(bareRemote());
  fixtureGit(person.dir, ['remote', 'add', 'evil', `ext::sh -c 'touch ${marker}'`]);
  fixtureGit(person.dir, ['remote', 'add', 'fd', 'fd::3']);
  for (const remote of ['evil', 'fd', `ext::sh -c 'touch ${marker}'`]) {
    const t = await transport(person.dir, remote);
    const resolved = await t.resolveRemoteUrl();
    assert.ok(!resolved.ok && resolved.failure.kind === 'invalid-remote', remote);
    const fetched = await t.fetch();
    assert.ok(!fetched.ok && fetched.failure.kind === 'invalid-remote', remote);
    const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
    const pushed = await t.push(await t.writeCommit(files));
    assert.ok(!pushed.ok && pushed.failure.kind === 'invalid-remote', remote);
  }
  assert.equal(existsSync(marker), false, 'no helper program ran');
});

test('a rewrite such as insteadOf in the person\'s own git configuration is honoured when resolving the address', async () => {
  const bare = bareRemote({ withMain: false });
  const person = userRepo(bareRemote());
  fixtureGit(person.dir, ['remote', 'add', 'hosted', 'https://git.example.invalid/me/project.git']);
  fixtureGit(person.dir, ['config', `url.${bare}.insteadOf`, 'https://git.example.invalid/me/project.git']);
  const t = await transport(person.dir, 'hosted');
  const resolved = await t.resolveRemoteUrl();
  assert.deepEqual(resolved, { ok: true, value: bare });
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  assert.equal((await t.push(await t.writeCommit(files))).ok, true);
  assert.deepEqual(refsOf(bare), [STATE_REF]);
});

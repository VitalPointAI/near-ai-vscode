// The separate "push your code" offer (D-14): the file list, the secret check by file name and by content, the person's click for every step, and
// no force. Real git, local bare repositories only; nothing contacts GitHub.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { isSecretFileName, planCodePush, pushProjectCode } from '../services/codePushCheck';
import type { CodePushSummary, CodePushUi } from '../services/codePushCheck';
import { bareRemote, fixtureGit, hermeticRunner, tempDirectory } from './helpers/gitFixtures';

const ROOT = path.join(__dirname, '..', '..');
// Built at run time so this file holds no key-shaped text of its own.
const FAKE_SK_KEY = `${'s'}k-${'a1B2c3D4'.repeat(3)}`;
const FAKE_PEM = `-----BEGIN ${'RSA PRIVATE'} KEY-----`;
const FAKE_GITLAB = `${'glpat'}-${'x9Y8z7W6'.repeat(3)}`;

class FakeUi implements CodePushUi {
  public readonly messages: string[] = [];
  public readonly summaries: CodePushSummary[] = [];
  public ignoreAsked: string[][] = [];
  public identityAsked = 0;
  public constructor(private readonly answers: { push?: boolean; ignore?: boolean; identity?: { name: string; email: string } } = {}) {}
  public message(text: string): void { this.messages.push(text); }
  public confirmPush(summary: CodePushSummary): Promise<boolean> { this.summaries.push(summary); return Promise.resolve(this.answers.push ?? true); }
  public confirmIgnore(files: string[]): Promise<boolean> { this.ignoreAsked.push(files); return Promise.resolve(this.answers.ignore ?? false); }
  public askIdentity(): Promise<{ name: string; email: string } | undefined> { this.identityAsked += 1; return Promise.resolve(this.answers.identity); }
}

/** A project folder that is a git repository with the given files, optionally committed, and an empty bare repository as `origin`. */
async function project(files: Record<string, string>, options: { commit?: string[]; identity?: boolean } = {}): Promise<{ dir: string; bare: string }> {
  const dir = await tempDirectory('near-ai-code-');
  const bare = bareRemote({ withMain: false });
  fixtureGit(dir, ['init', '-q', '-b', 'main']);
  if (options.identity !== false) {
    fixtureGit(dir, ['config', 'user.name', 'Pat Person']);
    fixtureGit(dir, ['config', 'user.email', 'pat@example.test']);
  }
  fixtureGit(dir, ['remote', 'add', 'origin', bare]);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  if (options.commit && options.commit.length > 0) {
    fixtureGit(dir, ['add', '--', ...options.commit]);
    fixtureGit(dir, ['-c', 'user.name=Pat Person', '-c', 'user.email=pat@example.test', 'commit', '-q', '-m', 'first']);
  }
  return { dir, bare };
}

test('isSecretFileName follows the repository\'s own rules, and stays in step with scripts/lib/workflow.mjs', () => {
  for (const file of ['.env', 'app/.env.production', 'id_rsa', 'home/.near-credentials/mainnet/a.json', 'cert.p12']) assert.ok(isSecretFileName(file), file);
  for (const file of ['.env.example', 'src/env.ts', 'docs/id_rsa.md']) assert.ok(!isSecretFileName(file), file);
  // The repository's own list is the source: every pattern and exception in it appears here in the same words.
  const own = readFileSync(path.join(ROOT, 'scripts', 'lib', 'workflow.mjs'), 'utf8');
  const mine = readFileSync(path.join(ROOT, 'src', 'services', 'codePushCheck.ts'), 'utf8');
  const block = /SECRET_FILE_PATTERNS = Object\.freeze\(\[([\s\S]*?)\]\);\s*const SECRET_FILE_EXCEPTIONS = \[([\s\S]*?)\];/.exec(own);
  assert.ok(block, 'the rules were found in workflow.mjs');
  for (const regex of (`${block[1]}\n${block[2]}`).match(/\/.+\/(?=,|\s*$|\s*\n)/gm) ?? []) assert.ok(mine.includes(regex.trim()), `codePushCheck.ts lacks ${regex}`);
});

test('planCodePush lists exactly the files git would add and blocks likely secrets by name and by content, without showing a value', async () => {
  const { dir } = await project({
    'tracked.txt': 'one\n',
    'src/new.ts': 'export const a = 1;\n',
    'ignored.log': 'noise\n',
    '.gitignore': 'ignored.log\n',
    '.env': 'API=1\n',
    '.env.example': 'API=\n',
    id_rsa: 'not really a key\n',
    'src/leaky.ts': `export const key = '${FAKE_SK_KEY}';\n`,
    'notes.txt': `${FAKE_PEM}\nabc\n`,
    'deploy/gitlab.txt': `token ${FAKE_GITLAB}\n`,
    '.near-ai/state/sync/mirror.bin': 'state\n',
    '.near-ai/state/keys/local.key': 'key bytes\n'
  }, { commit: ['tracked.txt'] });
  const plan = await planCodePush(dir, hermeticRunner());
  const wanted = fixtureGit(dir, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter((line) => line !== '' && !line.startsWith('.near-ai/state/'));
  assert.deepEqual([...plan.files].sort(), wanted.sort());
  assert.ok(plan.files.includes('src/new.ts') && plan.files.includes('tracked.txt') && plan.files.includes('.env.example'));
  assert.equal(plan.files.some((file) => file === 'ignored.log' || file.startsWith('.near-ai/state')), false, 'ignored files and the state home are never listed');
  assert.deepEqual(plan.blocked.map((block) => block.file).sort(), ['.env', 'deploy/gitlab.txt', 'id_rsa', 'notes.txt', 'src/leaky.ts']);
  for (const block of plan.blocked) {
    assert.ok(block.reason.length > 10, block.file);
    for (const value of [FAKE_SK_KEY, FAKE_GITLAB, FAKE_PEM]) assert.equal(block.reason.includes(value.slice(4)), false, 'a reason never carries the secret value');
  }
});

test('pushProjectCode refuses while files are blocked, and only an ignore click changes anything', async () => {
  const { dir, bare } = await project({ 'a.txt': 'a\n', '.env': 'API=1\n', 'src/leaky.ts': `export const key = '${FAKE_SK_KEY}';\n` });
  const ui = new FakeUi({ ignore: false });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'public' });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(ui.ignoreAsked, [['.env', 'src/leaky.ts']]);
  assert.equal(ui.summaries.length, 0, 'nothing is offered while a likely secret is in the list');
  assert.equal(fixtureGit(dir, ['rev-list', '--all', '--count']).trim(), '0', 'no commit was made');
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '', 'nothing reached the online repository');
  assert.equal(readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').includes('.env'), false);
  assert.equal(readFileSync(path.join(dir, '.env'), 'utf8'), 'API=1\n');
});

test('after the person ignores the blocked files, the rest is committed with their identity and pushed to the current branch, never forced', async () => {
  const { dir, bare } = await project({ 'a.txt': 'a\n', 'src/b.ts': 'export {};\n', '.env': 'API=1\n', id_rsa: 'x\n' });
  const ui = new FakeUi({ ignore: true, push: true });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'private' });
  assert.equal(result.status, 'pushed', result.message);
  assert.deepEqual(ui.ignoreAsked, [['.env', 'id_rsa']]);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '/.env\n/id_rsa\n');
  assert.deepEqual(ui.summaries.map((summary) => summary.files), [['.gitignore', 'a.txt', 'src/b.ts']]);
  assert.equal(ui.summaries[0]?.branch, 'main');
  assert.equal(ui.summaries[0]?.notes.includes('Everyone will be able to see these files.'), false);
  assert.equal(fixtureGit(bare, ['for-each-ref', '--format=%(refname)']).trim(), 'refs/heads/main');
  assert.equal(fixtureGit(bare, ['log', 'main', '--format=%an <%ae>']).trim(), 'Pat Person <pat@example.test>');
  assert.deepEqual(fixtureGit(bare, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n'), ['.gitignore', 'a.txt', 'src/b.ts']);
  assert.equal(fixtureGit(dir, ['config', '--get', 'branch.main.remote']).trim(), 'origin');
  assert.equal(fixtureGit(dir, ['status', '--porcelain']).trim(), '');
});

test('a public repository gets the extra line in the summary, and declining the summary leaves the sync branch and the repository untouched', async () => {
  const { dir, bare } = await project({ 'a.txt': 'a\n' });
  // The sync branch is already there; a declined offer must not move it.
  const seed = await tempDirectory('near-ai-seed-');
  fixtureGit(seed, ['init', '-q', '-b', 'near-ai/state']);
  writeFileSync(path.join(seed, 'manifest.json'), '{}');
  fixtureGit(seed, ['add', '.']);
  fixtureGit(seed, ['-c', 'user.name=n', '-c', 'user.email=n@example.test', 'commit', '-q', '-m', 'state']);
  fixtureGit(seed, ['push', '-q', bare, 'near-ai/state']);
  const before = fixtureGit(bare, ['for-each-ref']);
  const ui = new FakeUi({ push: false });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'public' });
  assert.equal(result.status, 'declined');
  assert.ok(ui.summaries[0]?.notes.includes('Everyone will be able to see these files.'));
  assert.equal(ui.summaries[0]?.visibility, 'public');
  assert.equal(fixtureGit(bare, ['for-each-ref']), before);
  assert.equal(fixtureGit(dir, ['rev-list', '--all', '--count']).trim(), '0');
  assert.equal(fixtureGit(dir, ['status', '--porcelain']).includes('?? a.txt'), true, 'nothing was staged');
});

test('a person with no git identity is asked once; accepting sets it for this project only, declining stops before any commit', async () => {
  const declined = await project({ 'a.txt': 'a\n' }, { identity: false });
  const noUi = new FakeUi({ push: true, identity: undefined });
  const stopped = await pushProjectCode(declined.dir, 'origin', hermeticRunner(), { ui: noUi, visibility: 'private' });
  assert.equal(stopped.status, 'declined');
  assert.equal(noUi.identityAsked, 1);
  assert.equal(fixtureGit(declined.dir, ['rev-list', '--all', '--count']).trim(), '0');

  const accepted = await project({ 'a.txt': 'a\n' }, { identity: false });
  const yesUi = new FakeUi({ push: true, identity: { name: 'Sam Maker', email: 'sam@example.test' } });
  const pushed = await pushProjectCode(accepted.dir, 'origin', hermeticRunner(), { ui: yesUi, visibility: 'private' });
  assert.equal(pushed.status, 'pushed', pushed.message);
  assert.equal(fixtureGit(accepted.dir, ['config', '--local', 'user.name']).trim(), 'Sam Maker');
  assert.equal(fixtureGit(accepted.bare, ['log', 'main', '--format=%an <%ae>']).trim(), 'Sam Maker <sam@example.test>');
});

test('a blocked file that is already tracked is not offered for ignoring, and the push stays blocked with a plain sentence', async () => {
  const { dir, bare } = await project({ 'a.txt': 'a\n', '.env': 'API=1\n' }, { commit: ['a.txt', '.env'] });
  const ui = new FakeUi({ ignore: true });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'private' });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(ui.ignoreAsked, [], 'ignoring cannot remove a file git already tracks');
  assert.ok(ui.messages.some((message) => message.includes('.env') && /already (?:in|tracked)/i.test(message)), ui.messages.join('|'));
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '');
});

test('a push the online repository refuses is reported in one plain sentence and is never forced', async () => {
  const { dir, bare } = await project({ 'a.txt': 'a\n' });
  const other = await tempDirectory('near-ai-other-');
  fixtureGit(other, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
  fixtureGit(other, ['add', '.']);
  fixtureGit(other, ['-c', 'user.name=n', '-c', 'user.email=n@example.test', 'commit', '-q', '-m', 'theirs']);
  fixtureGit(other, ['push', '-q', bare, 'main']);
  const tip = fixtureGit(bare, ['rev-parse', 'main']);
  const ui = new FakeUi({ push: true });
  const calls: string[][] = [];
  const inner = hermeticRunner();
  const result = await pushProjectCode(dir, 'origin', (args, options) => { calls.push(args); return inner(args, options); }, { ui, visibility: 'private' });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /^[A-Z][^\n]*\.$/);
  assert.equal(fixtureGit(bare, ['rev-parse', 'main']), tip);
  assert.equal(calls.some((args) => args.some((arg) => /^--force|^-f$|--force-with-lease/.test(arg) || (arg.startsWith('+') && arg.length > 1))), false);
});

test('the source has no force option anywhere', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'services', 'codePushCheck.ts'), 'utf8');
  assert.equal(/'--force'|--force-with-lease|'-f'/.test(source), false);
  void mkdir;
});

// The separate "push your code" offer (D-14): the file list, the secret check by file name and by content, the person's click for every step, and
// no force. Real git, local bare repositories only; nothing contacts GitHub.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { isSecretFileName, planCodePush, pushProjectCode, scanHistory, SHARED_PROJECT_FILES } from '../services/codePushCheck';
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
  public readonly historyNotices: string[] = [];
  public readonly unscannedAsked: string[] = [];
  public constructor(private readonly answers: { push?: boolean; ignore?: boolean; identity?: { name: string; email: string }; unscanned?: boolean } = {}) {}
  public message(text: string): void { this.messages.push(text); }
  public historyBlocked(text: string): Promise<void> { this.historyNotices.push(text); return Promise.resolve(); }
  public confirmUnscannedHistory(text: string): Promise<boolean> { this.unscannedAsked.push(text); return Promise.resolve(this.answers.unscanned ?? false); }
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
  // Tracked by git (in the index) but not saved in a commit yet: a file that was committed is also a history hit, which has its own tests below.
  const { dir, bare } = await project({ 'a.txt': 'a\n', '.env': 'API=1\n' }, { commit: ['a.txt'] });
  fixtureGit(dir, ['add', '--', '.env']);
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

const NEAR_AI = '.planning/.near-ai';

test('NEAR AI per-person records stay on this computer: left off the list, named in the summary, never staged, .gitignore untouched', async () => {
  const { dir, bare } = await project({
    'a.txt': 'a\n',
    [`${NEAR_AI}/auth-profiles.json`]: '{"profiles":[{"organization":"Acme","endpoint":"https://x.example.test"}]}\n',
    [`${NEAR_AI}/activity.json`]: '[]\n',
    [`${NEAR_AI}/team.md`]: '# Team\n',
    [`${NEAR_AI}/project.json`]: '{"type":"app"}\n'
  });
  const plan = await planCodePush(dir, hermeticRunner());
  assert.deepEqual(plan.heldBack, [`${NEAR_AI}/activity.json`, `${NEAR_AI}/auth-profiles.json`]);
  assert.ok(plan.files.includes(`${NEAR_AI}/team.md`) && plan.files.includes(`${NEAR_AI}/project.json`));
  assert.equal(plan.files.some((file) => file.endsWith('auth-profiles.json') || file.endsWith('activity.json')), false);

  const ui = new FakeUi({ push: true });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'public' });
  assert.equal(result.status, 'pushed', result.message);
  const note = ui.summaries[0]?.notes.find((text) => text.includes('stay on this computer'));
  assert.ok(note, 'the summary names what stays behind');
  assert.ok(note.includes('auth-profiles.json') && note.includes('activity.json'), note);
  assert.equal(ui.summaries[0]?.files.some((file) => file.endsWith('auth-profiles.json')), false);
  assert.deepEqual(fixtureGit(bare, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n'), ['.planning/.near-ai/project.json', '.planning/.near-ai/team.md', 'a.txt']);
  const status = fixtureGit(dir, ['status', '--porcelain']);
  assert.ok(status.includes(`?? ${NEAR_AI}/auth-profiles.json`) && status.includes(`?? ${NEAR_AI}/activity.json`), status);
  assert.equal(existsSync(path.join(dir, '.gitignore')), false, 'nothing was written to .gitignore for them');
});

/** Every .ts file under src/ except the tests. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** The first name after .planning/.near-ai/ in each place the extension's source names a file there, in both forms. */
function namesTheExtensionWrites(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/'\.planning',\s*'\.near-ai',\s*'([^']+)'/g)) names.add(match[1]!);
    for (const match of text.matchAll(/\.planning\/\.near-ai\/([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(match[1]!);
  }
  return names;
}

test('the allowlist is in step with the source: no stale entry, and every other file the extension writes there is held back', async () => {
  const written = namesTheExtensionWrites();
  assert.ok(written.size >= 10, `found the names in the source: ${[...written].join(', ')}`);
  for (const shared of SHARED_PROJECT_FILES) assert.ok(written.has(shared), `${shared} is on the allowlist but the extension no longer writes it`);
  const others = [...written].filter((name) => !SHARED_PROJECT_FILES.includes(name));
  assert.ok(others.includes('auth-profiles.json') && others.includes('activity.json'));
  const files: Record<string, string> = { 'a.txt': 'a\n' };
  for (const name of others) files[`${NEAR_AI}/${name.includes('.') ? name : `${name}/x.bin`}`] = 'record\n';
  const { dir } = await project(files);
  const plan = await planCodePush(dir, hermeticRunner());
  for (const name of others) {
    const held = plan.heldBack.some((file) => file === `${NEAR_AI}/${name}` || file.startsWith(`${NEAR_AI}/${name}/`));
    assert.ok(held, `${name} is not held back`);
  }
  assert.deepEqual(plan.files, ['a.txt']);
});

test('a file NEAR AI does not know yet, and a nested one, are held back (the allowlist fails closed)', async () => {
  const { dir } = await project({
    [`${NEAR_AI}/new-ledger.json`]: '{}\n',
    [`${NEAR_AI}/multimodal/x.bin`]: 'bytes\n',
    [`${NEAR_AI}/sub/team.md`]: '# not the shared one\n',
    [`${NEAR_AI}/team.md`]: '# Team\n'
  });
  const plan = await planCodePush(dir, hermeticRunner());
  assert.deepEqual(plan.heldBack, [`${NEAR_AI}/multimodal/x.bin`, `${NEAR_AI}/new-ledger.json`, `${NEAR_AI}/sub/team.md`]);
  assert.deepEqual(plan.files, [`${NEAR_AI}/team.md`]);
});

test('a file named like a shared one elsewhere, or beside a look-alike folder, is ordinary code', async () => {
  const { dir } = await project({
    'docs/team.md': '# docs\n',
    '.planning/team.md': '# planning\n',
    '.planning/auth-profiles.json': '{}\n',
    '.planning/.near-ai-old/x.json': '{}\n'
  });
  const plan = await planCodePush(dir, hermeticRunner());
  assert.deepEqual(plan.heldBack, []);
  assert.deepEqual(plan.files, ['.planning/.near-ai-old/x.json', '.planning/auth-profiles.json', '.planning/team.md', 'docs/team.md']);
});

test('a NEAR AI record git already tracks: a public repository is blocked with advice to remove it from git, nothing is committed or pushed', async () => {
  const { dir, bare } = await project({ 'a.txt': 'a\n', [`${NEAR_AI}/auth-profiles.json`]: '{"organization":"Acme"}\n' }, { commit: [`${NEAR_AI}/auth-profiles.json`] });
  const ui = new FakeUi({ push: true });
  const before = fixtureGit(dir, ['rev-list', '--all', '--count']).trim();
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'public' });
  assert.equal(result.status, 'blocked');
  assert.ok(result.message.includes(`${NEAR_AI}/auth-profiles.json`), result.message);
  assert.match(result.message, /git rm --cached/);
  assert.match(result.message, /^[A-Z][^\n]*\.$/, 'one plain sentence');
  assert.equal(ui.summaries.length, 0);
  assert.equal(fixtureGit(dir, ['rev-list', '--all', '--count']).trim(), before, 'nothing was committed');
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '');
});

test('a NEAR AI record git already tracks on a private or unknown repository is named in the summary as going up; declining pushes nothing, accepting pushes', async () => {
  for (const visibility of ['private', 'unknown'] as const) {
    const declined = await project({ 'a.txt': 'a\n', [`${NEAR_AI}/auth-profiles.json`]: '{"organization":"Acme"}\n' }, { commit: [`${NEAR_AI}/auth-profiles.json`] });
    const noUi = new FakeUi({ push: false });
    const stopped = await pushProjectCode(declined.dir, 'origin', hermeticRunner(), { ui: noUi, visibility });
    assert.equal(stopped.status, 'declined');
    const note = noUi.summaries[0]?.notes.find((text) => text.includes('already saved in git'));
    assert.ok(note && note.includes('auth-profiles.json'), noUi.summaries[0]?.notes.join('|'));
    assert.ok(noUi.summaries[0]?.files.includes(`${NEAR_AI}/auth-profiles.json`), 'it is on the list because it goes up');
    assert.equal(fixtureGit(declined.bare, ['for-each-ref']).trim(), '');

    const accepted = await project({ 'a.txt': 'a\n', [`${NEAR_AI}/auth-profiles.json`]: '{"organization":"Acme"}\n' }, { commit: [`${NEAR_AI}/auth-profiles.json`] });
    const yesUi = new FakeUi({ push: true });
    const pushed = await pushProjectCode(accepted.dir, 'origin', hermeticRunner(), { ui: yesUi, visibility });
    assert.equal(pushed.status, 'pushed', pushed.message);
    assert.ok(fixtureGit(accepted.bare, ['ls-tree', '-r', '--name-only', 'main']).includes('auth-profiles.json'));
  }
});

const IDENTITY = ['-c', 'user.name=Pat Person', '-c', 'user.email=pat@example.test'];

/** Saves the files as one commit in `dir` and returns its short id (the first seven characters, as the plan names it). */
function commitFiles(dir: string, files: Record<string, string>, message: string, remove: string[] = []): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  for (const name of remove) rmSync(path.join(dir, name));
  fixtureGit(dir, ['add', '-A', '--', '.']);
  fixtureGit(dir, [...IDENTITY, 'commit', '-q', '-m', message]);
  return fixtureGit(dir, ['rev-parse', 'HEAD']).trim().slice(0, 7);
}

function assertHistoryBlock(ui: FakeUi, expected: { file?: string; commit: string }, secretValues: string[]): void {
  assert.equal(ui.historyNotices.length, 1, ui.historyNotices.join('|'));
  const notice = ui.historyNotices[0]!;
  if (expected.file) assert.ok(notice.includes(expected.file), notice);
  assert.ok(notice.includes(expected.commit), notice);
  assert.match(notice, /\.gitignore/, 'it says plainly that .gitignore cannot fix a history hit');
  for (const value of secretValues) assert.equal(notice.includes(value.slice(4)), false, 'the notice never carries the secret value');
  assert.equal(ui.summaries.length, 0, 'nothing is offered while a secret is in the history');
  assert.deepEqual(ui.ignoreAsked, [], 'ignoring cannot remove a commit');
}

test('a secret added in one commit and deleted in the next still blocks the push, naming the file and the commit', async () => {
  const { dir, bare } = await project({});
  const first = commitFiles(dir, { 'src/config.ts': `export const key = '${FAKE_SK_KEY}';\n`, 'a.txt': 'a\n' }, 'add config');
  commitFiles(dir, { 'b.txt': 'b\n' }, 'tidy', ['src/config.ts']);
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  const ui = new FakeUi({ push: true });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'public' });
  assert.equal(result.status, 'blocked');
  assertHistoryBlock(ui, { file: 'src/config.ts', commit: first }, [FAKE_SK_KEY]);
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '', 'nothing reached the online repository');
  assert.equal(fixtureGit(dir, ['rev-list', '--all', '--count']).trim(), '2', 'no commit was added and the history was not touched');
});

test('a secret file name that existed only in an earlier commit blocks the push', async () => {
  const { dir, bare } = await project({});
  const first = commitFiles(dir, { '.env': 'API=1\n', 'a.txt': 'a\n' }, 'add env');
  commitFiles(dir, {}, 'remove env', ['.env']);
  const ui = new FakeUi({ push: true });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'private' });
  assert.equal(result.status, 'blocked');
  assertHistoryBlock(ui, { file: '.env', commit: first }, []);
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '');
});

test('a secret that appears only in a commit message blocks the push, naming the commit', async () => {
  const { dir, bare } = await project({});
  const first = commitFiles(dir, { 'a.txt': 'a\n' }, `use ${FAKE_GITLAB} for deploys`);
  commitFiles(dir, { 'b.txt': 'b\n' }, 'second');
  const ui = new FakeUi({ push: true });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'private' });
  assert.equal(result.status, 'blocked');
  assertHistoryBlock(ui, { commit: first }, [FAKE_GITLAB]);
  assert.match(ui.historyNotices[0]!, /message/);
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '');
});

test('a clean history passes, is counted, and the push goes ahead', async () => {
  const { dir, bare } = await project({});
  commitFiles(dir, { 'a.txt': 'a\n', '.env.example': 'API=\n' }, 'first');
  commitFiles(dir, { 'src/b.ts': 'export {};\n' }, 'second');
  const scan = await scanHistory(dir, 'refs/heads/main', 'origin', hermeticRunner());
  assert.deepEqual({ commits: scan.commits, hits: scan.hits, complete: scan.complete, unchecked: scan.unchecked }, { commits: 2, hits: [], complete: true, unchecked: [] });
  const ui = new FakeUi({ push: true });
  const result = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui, visibility: 'public' });
  assert.equal(result.status, 'pushed', result.message);
  assert.deepEqual(ui.historyNotices, []);
  assert.equal(fixtureGit(bare, ['rev-list', '--count', 'main']).trim(), '2');
});

test('commits already on the online repository are not scanned again, only the new ones', async () => {
  const { dir } = await project({});
  commitFiles(dir, { 'old.ts': `export const key = '${FAKE_SK_KEY}';\n` }, 'old');
  fixtureGit(dir, ['push', '-q', 'origin', 'main']);
  const added = commitFiles(dir, { 'new.txt': 'new\n' }, 'new');
  const scan = await scanHistory(dir, 'refs/heads/main', 'origin', hermeticRunner());
  assert.equal(scan.commits, 1, 'only the commit the push would add');
  assert.deepEqual(scan.hits, []);
  commitFiles(dir, { 'newer.ts': `export const key = '${FAKE_SK_KEY}';\n` }, 'newer');
  const again = await scanHistory(dir, 'refs/heads/main', 'origin', hermeticRunner());
  assert.equal(again.commits, 2);
  assert.equal(again.hits.length, 1);
  assert.equal(again.hits[0]?.file, 'newer.ts');
  assert.notEqual(again.hits[0]?.commit, added);
});

test('a secret inside a merge commit\'s own changes is found', async () => {
  const { dir } = await project({});
  commitFiles(dir, { 'a.txt': 'a\n' }, 'base');
  fixtureGit(dir, ['checkout', '-q', '-b', 'side']);
  commitFiles(dir, { 'side.txt': 's\n' }, 'side');
  fixtureGit(dir, ['checkout', '-q', 'main']);
  commitFiles(dir, { 'main.txt': 'm\n' }, 'main work');
  fixtureGit(dir, [...IDENTITY, 'merge', '-q', '--no-ff', '--no-commit', 'side']);
  writeFileSync(path.join(dir, 'merged.ts'), `export const key = '${FAKE_SK_KEY}';\n`);
  fixtureGit(dir, ['add', 'merged.ts']);
  fixtureGit(dir, [...IDENTITY, 'commit', '-q', '-m', 'merge']);
  const scan = await scanHistory(dir, 'refs/heads/main', 'origin', hermeticRunner());
  assert.deepEqual(scan.hits.map((hit) => hit.file), ['merged.ts']);
});

test('a history over the limit reports that it was not fully checked: private needs a click that names it, public is refused', async () => {
  const { dir, bare } = await project({});
  for (let index = 0; index < 4; index += 1) commitFiles(dir, { [`f${index}.txt`]: `${index}\n` }, `commit ${index}`);
  const limits = { maxCommits: 2 };
  const scan = await scanHistory(dir, 'refs/heads/main', 'origin', hermeticRunner(), limits);
  assert.equal(scan.complete, false);
  assert.equal(scan.commits, 2);

  const publicUi = new FakeUi({ push: true, unscanned: true });
  const refused = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui: publicUi, visibility: 'public', historyLimits: limits });
  assert.equal(refused.status, 'blocked');
  assert.match(refused.message, /not fully checked/i);
  assert.equal(publicUi.unscannedAsked.length, 0, 'a public repository is never offered the choice');
  assert.equal(publicUi.summaries.length, 0);
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '');

  const declinedUi = new FakeUi({ push: true, unscanned: false });
  const declined = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui: declinedUi, visibility: 'private', historyLimits: limits });
  assert.equal(declined.status, 'declined');
  assert.equal(declinedUi.unscannedAsked.length, 1);
  assert.match(declinedUi.unscannedAsked[0]!, /not fully checked/i);
  assert.equal(declinedUi.summaries.length, 0, 'the file list is not shown as if all were well');
  assert.equal(fixtureGit(bare, ['for-each-ref']).trim(), '');

  const acceptedUi = new FakeUi({ push: true, unscanned: true });
  const accepted = await pushProjectCode(dir, 'origin', hermeticRunner(), { ui: acceptedUi, visibility: 'private', historyLimits: limits });
  assert.equal(accepted.status, 'pushed', accepted.message);
  assert.ok(acceptedUi.summaries[0]?.notes.some((note) => /not fully checked/i.test(note)));
});

test('the size limit on blob text also makes the history not fully checked', async () => {
  const { dir } = await project({});
  commitFiles(dir, { 'a.txt': 'x'.repeat(5_000) }, 'one');
  commitFiles(dir, { 'b.txt': 'y'.repeat(5_000) }, 'two');
  const scan = await scanHistory(dir, 'refs/heads/main', 'origin', hermeticRunner(), { maxBytes: 6_000 });
  assert.equal(scan.complete, false);
});

test('binary and over-1-MiB files in earlier commits are listed as not checked, not treated as clean text', async () => {
  const { dir } = await project({});
  commitFiles(dir, { 'big.txt': `${'a'.repeat(80)}\n`.repeat(14_000), 'blob.bin': `a\0b${FAKE_SK_KEY}` }, 'big');
  const scan = await scanHistory(dir, 'refs/heads/main', 'origin', hermeticRunner());
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.hits, []);
  assert.deepEqual([...scan.unchecked].sort(), ['big.txt', 'blob.bin']);
});

test('the history scan goes through the person\'s own git runner and never forces or reaches the network', async () => {
  const { dir } = await project({});
  commitFiles(dir, { 'a.txt': 'a\n' }, 'one');
  const calls: string[][] = [];
  const inner = hermeticRunner();
  await scanHistory(dir, 'refs/heads/main', 'origin', (args, options) => { calls.push(args); return inner(args, options); });
  assert.ok(calls.some((args) => args.includes('rev-list')));
  assert.equal(calls.some((args) => args.some((arg) => ['push', 'fetch', 'pull', 'clone', 'ls-remote'].includes(arg))), false);
});

test('the source has no force option anywhere', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'services', 'codePushCheck.ts'), 'utf8');
  assert.equal(/'--force'|--force-with-lease|'-f'/.test(source), false);
  void mkdir;
});

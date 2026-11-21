// Runs scripts/secret-scan.mjs against a throwaway git repository, so the range scan is tested on
// real git output: renames, merge commits, paths with spaces, and lines that look like headers.
// Fake keys are assembled at runtime so this file never matches the scanner itself.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCANNER = fileURLToPath(new URL('../secret-scan.mjs', import.meta.url));
const TOKEN = ['ghp', '_', 'Q'.repeat(36)].join('');
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'secret-scan-test-'));
  roots.push(dir);
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args
  ], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const append = (file, text) => write(file, readFileSync(path.join(dir, file), 'utf8') + text);
  const commit = (message) => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  return { dir, git, write, append, commit };
}

function scan(dir, ...args) {
  const result = spawnSync(process.execPath, [SCANNER, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('the range scan finds keys added and removed again in renames, merges and paths with spaces', () => {
  const { dir, git, write, append, commit } = fixture();
  const notes = Array.from({ length: 40 }, (_, i) => `note ${i}\n`).join('');
  write('notes.txt', notes);
  write('README.md', 'hello\n');
  write('.github/secret-scan-allow.txt', 'fixture.txt github-token # fake keys for a test\n');
  write('fixture.txt', 'fixture\n');
  const base = commit('base');

  // A rename that also adds a key: rename detection used to drop it from the scan.
  git('mv', 'notes.txt', 'renamed.txt');
  append('renamed.txt', `token = "${TOKEN}"\n`);
  commit('rename notes');
  write('renamed.txt', notes);
  commit('remove the key from renamed.txt');

  // Paths with spaces: git adds a tab after such names in patch headers.
  write('dir with space/my notes.txt', `key ${TOKEN}\n`);
  write('config dir/.env', 'NAME=value\n');
  commit('files with spaces');
  git('rm', '-q', 'dir with space/my notes.txt', 'config dir/.env');
  commit('remove them');

  // A line whose content starts with "++ " used to be read as a "+++" file header and could
  // switch the scan to an allowlisted file.
  write('evil.txt', `++ b/fixture.txt\nsecret ${TOKEN}\n`);
  commit('header lookalike');
  write('evil.txt', 'clean\n');
  commit('clean evil.txt');

  // A key added only in a merge commit (not in either parent).
  git('checkout', '-q', '-b', 'side', base);
  write('side.txt', 'side\n');
  commit('side work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '--no-commit', 'side');
  write('merged.txt', `merged ${TOKEN}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'merge side');
  const merge = git('rev-parse', 'HEAD');
  git('rm', '-q', 'merged.txt');
  commit('remove merged.txt');

  assert.equal(scan(dir).status, 0, 'the files at HEAD are clean');
  const { status, output } = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(status, 1, output);
  assert.match(output, /renamed\.txt\s+\[github-token\]/);
  assert.match(output, /dir with space\/my notes\.txt\s+\[github-token\]/);
  assert.match(output, /config dir\/\.env\s+\[secret-file-name\]/);
  assert.match(output, /evil\.txt\s+\[github-token\]/);
  assert.match(output, new RegExp(`${merge.slice(0, 7)} merged\\.txt\\s+\\[github-token\\]`));
  assert.ok(!output.includes(TOKEN), 'findings are masked');
});

test('a range scan of a clean history passes', () => {
  const { dir, write, commit } = fixture();
  write('README.md', 'hello\n');
  const base = commit('base');
  write('docs/a b.md', 'nothing secret\n');
  commit('docs');
  const { status, output } = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(status, 0, output);
  assert.match(output, /1 commit\(s\)/);
});

test('lines marked "secret-scan: allow" are listed, and one added then removed in the range fails', () => {
  const { dir, write, commit } = fixture();
  const marker = ['secret-scan', 'allow'].join(': ');
  write('README.md', 'hello\n');
  const base = commit('base');
  write('kept.txt', `fake = "${TOKEN}" // ${marker}\n`);
  commit('a fake key that stays, marked');
  const kept = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(kept.status, 0, kept.output);
  assert.match(kept.output, /marked "secret-scan: allow".*\n.*kept\.txt.*\[github-token\]/);
  assert.ok(!kept.output.includes(TOKEN), 'marked lines are masked too');

  write('gone.txt', `real = "${TOKEN}" // ${marker}\n`);
  commit('a key hidden by the marker');
  write('gone.txt', 'nothing here\n');
  commit('and removed again');
  const gone = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(gone.status, 1, gone.output);
  assert.match(gone.output, /gone\.txt\s+\[allowed-line-removed\]/);
  assert.doesNotMatch(gone.output, /kept\.txt\s+\[allowed-line-removed\]/);
});

test('an allowlisted fixture is skipped only for the rules listed for it', () => {
  const { dir, write, commit } = fixture();
  const aws = ['AKIA', 'Z'.repeat(16)].join('');
  write('.github/secret-scan-allow.txt', 'fixture.ts github-token # fake GitHub token for a masking test\n');
  write('fixture.ts', `const fake = "${TOKEN}";\n`);
  const base = commit('fixture with a fake GitHub token');
  assert.equal(scan(dir).status, 0, 'the listed rule is allowed');
  write('fixture.ts', `const fake = "${TOKEN}";\nconst key = "${aws}";\n`);
  commit('a different kind of key pasted into the fixture');
  const head = scan(dir);
  assert.equal(head.status, 1, head.output);
  assert.match(head.output, /fixture\.ts:2\s+\[aws-access-key\]/);
  assert.doesNotMatch(head.output, /\[github-token\]/);
  assert.match(scan(dir, '--range', `${base}..HEAD`).output, /fixture\.ts\s+\[aws-access-key\]/);
});

test('lines added to files git treats as binary are still scanned in the range', () => {
  const { dir, write, commit } = fixture();
  write('README.md', 'hello\n');
  const base = commit('base');
  // A .gitattributes entry (which the PR itself can add) turns the diff into "Binary files differ".
  write('.gitattributes', '*.dat -diff\n*.bin binary\n');
  write('data.dat', `token ${TOKEN}\n`);
  write('blob.bin', `\0header\ntoken ${TOKEN}\n`);
  commit('keys in files git will not diff');
  write('data.dat', 'clean\n');
  write('blob.bin', 'clean\n');
  commit('remove them');
  const { status, output } = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(status, 1, output);
  assert.match(output, /data\.dat\s+\[github-token\]/);
  assert.match(output, /blob\.bin\s+\[github-token\]/);
});

test('a marked line kept in a CRLF file is not reported as removed', () => {
  const { dir, write, commit } = fixture();
  const marker = ['secret-scan', 'allow'].join(': ');
  write('README.md', 'hello\n');
  const base = commit('base');
  write('windows.txt', `first\r\nfake = "${TOKEN}" // ${marker}\r\nlast\r\n`);
  commit('a marked fake key in a CRLF file');
  const { status, output } = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /allowed-line-removed/);
});

test('a key in an allowlisted file that is added and removed again in the range fails', () => {
  const { dir, write, commit } = fixture();
  write('.github/secret-scan-allow.txt', 'fixture.ts github-token # fake GitHub token for a masking test\n');
  write('fixture.ts', `const fake = "${TOKEN}";\n`);
  const base = commit('fixture with a fake GitHub token');
  const other = ['ghp', '_', 'R'.repeat(36)].join('');
  write('fixture.ts', `const fake = "${TOKEN}";\nconst real = "${other}";\n`);
  commit('a real key pasted into the allowlisted fixture');
  write('fixture.ts', `const fake = "${TOKEN}";\n`);
  commit('and removed again');
  assert.equal(scan(dir).status, 0, 'the file at HEAD only holds the listed fake key');
  const { status, output } = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(status, 1, output);
  assert.match(output, /fixture\.ts\s+\[allowed-line-removed\]/);
  assert.ok(!output.includes(other), 'masked');
  // The fake key that stays in the fixture is fine.
  write('fixture.ts', `const fake = "${TOKEN}";\nconst more = 1;\n`);
  const next = commit('unrelated edit');
  assert.equal(scan(dir, '--range', `${base}..${next}`).output.match(/allowed-line-removed/g)?.length, 1);
});

test('commit messages in the range are scanned too', () => {
  const { dir, write, git, commit } = fixture();
  write('README.md', 'hello\n');
  const base = commit('base');
  write('README.md', 'hello again\n');
  git('add', '-A');
  git('commit', '-q', '-m', `use token ${TOKEN} for the deploy`);
  const { status, output } = scan(dir, '--range', `${base}..HEAD`);
  assert.equal(status, 1, output);
  assert.match(output, /\(commit message\)\s+\[github-token\]/);
  assert.ok(!output.includes(TOKEN));
});

test('a tracked symlink to a directory does not crash the scan, and only A..B ranges are accepted', () => {
  const { dir, write, commit } = fixture();
  write('real/a.txt', 'hello\n');
  symlinkSync('real', path.join(dir, 'link'));
  const base = commit('a symlink to a directory');
  const head = scan(dir);
  assert.equal(head.status, 0, head.output);
  const dots = scan(dir, '--range', `${base}...HEAD`);
  assert.notEqual(dots.status, 0);
  assert.match(dots.output, /--range must be <from>\.\.<to>/);
});

// Phase 44 (D-24): --dir scans a folder that is not tracked (the evidence bundle, before it is uploaded) with the same rules, and --json prints one
// line of counts only, so a workflow can read the result without parsing the human text.

/** A plain folder (no git) holding the given files. */
function folder(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'secret-scan-dir-'));
  roots.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
/** A scan with stdout and stderr kept apart, run from `cwd`. */
function scanApart(cwd, ...args) {
  const result = spawnSync(process.execPath, [SCANNER, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const JSON_FIELDS = ['allowlisted', 'clean', 'commits', 'files', 'findings', 'marked', 'mode', 'rules'];
/** The one JSON line --json prints on stdout. */
function jsonLine(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `one line on stdout, got: ${stdout}`);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(summary).sort(), JSON_FIELDS);
  return summary;
}

test('--dir finds a key in a folder that is not tracked, and --json reports it as counts with no part of the value', () => {
  const cwd = folder({ 'outside.txt': 'not scanned\n' });
  const bundle = folder({ 'evidence/rows.json': `{"note":"${TOKEN}"}\n`, 'manifest.json': '{"files":1}\n' });
  const human = scanApart(cwd, '--dir', bundle);
  assert.equal(human.status, 1, human.stdout + human.stderr);
  assert.match(human.stderr, /evidence\/rows\.json:1\s+\[github-token\]/);
  assert.ok(!`${human.stdout}${human.stderr}`.includes(TOKEN), 'masked');
  const json = scanApart(cwd, '--dir', bundle, '--json');
  assert.equal(json.status, 1);
  const summary = jsonLine(json.stdout);
  assert.deepEqual(summary, { mode: 'dir', files: 2, commits: 0, findings: 1, rules: { 'github-token': 1 }, allowlisted: 0, marked: 0, clean: false });
  const body = TOKEN.slice(4);
  assert.ok(!json.stdout.includes(body) && !json.stderr.includes(body), 'no part of the fake value is printed');
});

test('--dir over a clean folder exits 0 and --json reports clean with the file count', () => {
  const bundle = folder({ 'a.json': '{}\n', 'deep/er/b.ndjson': '{"status":"passed"}\n', 'c.txt': 'hello\n' });
  const human = scanApart(bundle, '--dir', '.');
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Secret scan clean: 3 files in \./);
  const json = scanApart(bundle, '--dir', '.', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stderr, '');
  assert.deepEqual(jsonLine(json.stdout), { mode: 'dir', files: 3, commits: 0, findings: 0, rules: {}, allowlisted: 0, marked: 0, clean: true });
});

test('--dir: a symlink is a finding and is never followed', () => {
  const outside = folder({ 'secret.txt': `token ${TOKEN}\n` });
  const bundle = folder({ 'ok.txt': 'fine\n', 'sub/also.txt': 'fine\n' });
  symlinkSync(path.join(outside, 'secret.txt'), path.join(bundle, 'link-to-file.txt'));
  symlinkSync(outside, path.join(bundle, 'sub', 'link-to-folder'));
  const json = scanApart(bundle, '--dir', '.', '--json');
  assert.equal(json.status, 1, json.stdout + json.stderr);
  const summary = jsonLine(json.stdout);
  assert.deepEqual(summary.rules, { symlink: 2 }, 'the linked file is not read, so its key is not seen');
  assert.equal(summary.files, 2);
  const human = scanApart(bundle, '--dir', '.');
  assert.match(human.stderr, /link-to-file\.txt\s+\[symlink\]/);
  assert.match(human.stderr, /sub\/link-to-folder\s+\[symlink\]/);
  // The folder given must itself be a real folder, not a link to one.
  const linked = path.join(folder({}), 'linked-bundle');
  symlinkSync(bundle, linked);
  const refused = scanApart(bundle, '--dir', linked);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--dir/);
});

test('--dir: a file above 16 MiB is a finding, binary files are skipped, and a secret file name is reported', () => {
  const bundle = folder({ 'blob.bin': `\0binary\ntoken ${TOKEN}\n`, 'config/.env': 'NAME=value\n', 'small.txt': 'fine\n' });
  writeFileSync(path.join(bundle, 'huge.json'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
  const json = scanApart(bundle, '--dir', '.', '--json');
  assert.equal(json.status, 1, json.stdout + json.stderr);
  const summary = jsonLine(json.stdout);
  assert.deepEqual(summary.rules, { 'secret-file-name': 1, 'too-large': 1 });
  assert.equal(summary.files, 4);
  const human = scanApart(bundle, '--dir', '.');
  assert.match(human.stderr, /huge\.json\s+\[too-large\]/);
  assert.match(human.stderr, /config\/\.env\s+\[secret-file-name\]/);
});

test('--dir ignores the tracked-file allowlist and the tracked files, and cannot be combined with --range', () => {
  const { dir, write, commit } = fixture();
  write('.github/secret-scan-allow.txt', 'fixture.ts github-token # fake GitHub token for a masking test\n');
  write('fixture.ts', `const fake = "${TOKEN}";\n`);
  const base = commit('an allowlisted fixture');
  assert.equal(scan(dir).status, 0, 'allowlisted in the tracked scan');
  const bundle = folder({ 'fixture.ts': `const fake = "${TOKEN}";\n` });
  const json = scanApart(dir, '--dir', bundle, '--json');
  assert.equal(json.status, 1, 'the allowlist names tracked paths and does not apply to a folder');
  assert.deepEqual(jsonLine(json.stdout).rules, { 'github-token': 1 });
  write('tracked-key.txt', `key ${TOKEN}\n`);
  commit('a key in a tracked file');
  const clean = scanApart(dir, '--dir', folder({ 'a.txt': 'fine\n' }), '--json');
  assert.equal(clean.status, 0, 'the tracked files are not part of a folder scan');
  assert.equal(jsonLine(clean.stdout).files, 1);
  const both = scanApart(dir, '--dir', bundle, '--range', `${base}..HEAD`);
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /--dir.*--range|--range.*--dir/);
  assert.equal(both.stdout, '');
});

test('--json for the tracked and range scans: the same shape, with mode tracked or range, and the human output is unchanged without it', () => {
  const { dir, write, commit } = fixture();
  const marker = ['secret-scan', 'allow'].join(': ');
  write('.github/secret-scan-allow.txt', 'fixture.ts github-token # fake GitHub token for a masking test\n');
  write('fixture.ts', `const fake = "${TOKEN}";\n`);
  write('README.md', 'hello\n');
  const base = commit('base');
  write('kept.txt', `fake = "${TOKEN}" // ${marker}\n`);
  commit('a marked fake key');
  const human = scanApart(dir);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^Lines marked "secret-scan: allow" that match a rule/);
  assert.match(human.stdout, /Secret scan clean: 4 tracked files\. Allowlisted fixtures: 1\.\n$/);
  const tracked = scanApart(dir, '--json');
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.deepEqual(jsonLine(tracked.stdout), { mode: 'tracked', files: 4, commits: 0, findings: 0, rules: {}, allowlisted: 1, marked: 1, clean: true });
  write('leak.txt', `key ${TOKEN}\n`);
  commit('a leak');
  const range = scanApart(dir, '--range', `${base}..HEAD`, '--json');
  assert.equal(range.status, 1);
  assert.deepEqual(jsonLine(range.stdout), { mode: 'range', files: 5, commits: 2, findings: 2, rules: { 'github-token': 2 }, allowlisted: 1, marked: 1, clean: false });
  assert.ok(!range.stdout.includes(TOKEN.slice(4)) && !range.stderr.includes(TOKEN.slice(4)));
});

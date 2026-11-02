// Runs scripts/secret-scan.mjs against a throwaway git repository, so the range scan is tested on
// real git output: renames, merge commits, paths with spaces, and lines that look like headers.
// Fake keys are assembled at runtime so this file never matches the scanner itself.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  write('.github/secret-scan-allow.txt', 'fixture.txt # fake keys for a test\n');
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

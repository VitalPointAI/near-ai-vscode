// The messaging relay (relay/) is a separate service with its own Node version, manifest and
// lockfile. The extension must stay blind to it: nothing from relay/ may ship in the .vsix, the
// root manifest keeps no workspaces and no dependencies, the root lockfile has no relay entry, the
// root compile covers only src/, and the relay's state and secret files can never be committed.
// These checks run on the extension's own toolchain (Node 24), not the relay's.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function nonCommentLines(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, file), 'utf8')) as Record<string, unknown>;
}

test('the VSIX ignores relay/ and the root .dockerignore', async () => {
  const lines = await nonCommentLines(path.join(REPO_ROOT, '.vscodeignore'));
  assert.ok(lines.includes('relay/**'), 'without relay/** in .vscodeignore the relay source, state database and secrets would ship in the .vsix');
  assert.ok(lines.includes('.dockerignore'), 'without .dockerignore in .vscodeignore the relay Docker build allow-list would ship in the .vsix');
});

test('the extension has no workspaces, dependencies or relay lock entries', async () => {
  const manifest = await readJson('package.json');
  assert.equal(manifest.workspaces, undefined, 'a root workspaces key would let the relay share the extension lockfile and bundle');
  assert.equal(manifest.dependencies, undefined, 'the extension ships a zero-dependency bundle; a root dependencies key breaks that');

  const lock = await readJson('package-lock.json');
  const packages = (lock.packages ?? {}) as Record<string, unknown>;
  const relayKeys = Object.keys(packages).filter((key) => key === 'relay' || key.startsWith('relay/'));
  assert.deepEqual(relayKeys, [], 'the root lockfile must not hold any relay package; the relay has its own lockfile');
});

test('the extension compiles only src/', async () => {
  const raw = await readFile(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8');
  const tsconfig = JSON.parse(raw) as { include?: unknown; compilerOptions?: { rootDir?: unknown } };
  assert.deepEqual(tsconfig.include, ['src/**/*.ts'], 'a wider root tsconfig include would compile relay code into the extension build');
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src', 'the root rootDir must stay src so relay files cannot be compiled into dist');
});

test('relay state and secrets are git-ignored', async () => {
  const lines = await nonCommentLines(path.join(REPO_ROOT, '.gitignore'));
  assert.ok(lines.includes('relay/state/'), 'without relay/state/ in .gitignore the relay database could be committed');
  assert.ok(lines.includes('relay/secrets/'), 'without relay/secrets/ in .gitignore relay secret files could be committed');
  for (const probe of ['relay/state/relay.db', 'relay/state/relay.db-wal', 'relay/state/relay.db-shm', 'relay/secrets/teams_app_secret', 'relay/other/x.db']) {
    // git check-ignore exits 0 when the path is ignored and 1 when it is not.
    assert.doesNotThrow(
      () => execFileSync('git', ['check-ignore', '-q', probe], { cwd: REPO_ROOT, stdio: 'ignore' }),
      `${probe} would be committable; git must ignore it`,
    );
  }
});

test('the relay has its own lockfile and package', async () => {
  await access(path.join(REPO_ROOT, 'relay', 'package-lock.json'));
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'relay', 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.name, 'near-ai-relay');
  assert.equal(manifest.private, true, 'the relay must stay private so it can never be published by accident');
});

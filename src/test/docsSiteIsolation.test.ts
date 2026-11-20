// The documentation site (docs-site/) is a separate workspace with its own manifest and lockfile.
// The extension must stay blind to it: nothing from docs-site/ may ship in the .vsix, the root
// lockfile holds none of its packages, the root compile covers only src/, its generated copies of
// the repository's documents are never committed, and its local server binds to loopback only.

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

test('the VSIX ignores docs-site/ and the release check refuses it', async () => {
  const lines = await nonCommentLines(path.join(REPO_ROOT, '.vscodeignore'));
  assert.ok(lines.includes('docs-site/**'), 'without docs-site/** in .vscodeignore the docs site, its node_modules and its build would ship in the .vsix');
  const verify = await readFile(path.join(REPO_ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  assert.ok(verify.includes(String.raw`/^extension\/docs-site(?:\/|$)/`), 'verify-release-content.mjs must refuse a package that holds docs-site/');
});

test('the root manifest and lockfile hold none of the docs site packages', async () => {
  const manifest = await readJson('package.json');
  assert.equal(manifest.workspaces, undefined, 'a root workspaces key would let the docs site share the extension lockfile');
  const devDependencies = Object.keys((manifest.devDependencies ?? {}) as Record<string, unknown>);
  assert.deepEqual(devDependencies.filter((name) => name.startsWith('@docusaurus/') || name === 'sirv'), [], 'the docs site dependencies belong in docs-site/package.json');
  const lock = await readJson('package-lock.json');
  const packages = (lock.packages ?? {}) as Record<string, unknown>;
  const keys = Object.keys(packages).filter((key) => key === 'docs-site' || key.startsWith('docs-site/') || key.startsWith('node_modules/@docusaurus/'));
  assert.deepEqual(keys, [], 'the root lockfile must not hold any docs site package; the site has its own lockfile');
  const scripts = (manifest.scripts ?? {}) as Record<string, string>;
  assert.match(scripts['docs:install'] ?? '', /^npm --prefix docs-site ci --ignore-scripts$/, 'installing the docs site runs no dependency scripts');
});

test('the extension compile does not reach docs-site/', async () => {
  const tsconfig = JSON.parse(await readFile(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8')) as { include?: unknown; compilerOptions?: { rootDir?: unknown } };
  assert.deepEqual(tsconfig.include, ['src/**/*.ts']);
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src');
});

test('the docs site has its own private package, lockfile and no install scripts', async () => {
  await access(path.join(REPO_ROOT, 'docs-site', 'package-lock.json'));
  const manifest = await readJson('docs-site/package.json');
  assert.equal(manifest.private, true, 'the docs site must stay private so it can never be published by accident');
  assert.equal(manifest.dependencies, undefined, 'the docs site uses devDependencies only');
  for (const [name, version] of Object.entries((manifest.devDependencies ?? {}) as Record<string, string>)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version`);
  }
  const npmrc = await nonCommentLines(path.join(REPO_ROOT, 'docs-site', '.npmrc'));
  assert.ok(npmrc.includes('ignore-scripts=true'), 'docs-site/.npmrc must turn off dependency install scripts');
});

test('generated copies and build output of the docs site are git-ignored', () => {
  for (const probe of [
    'docs-site/node_modules/x/index.js',
    'docs-site/build/index.html',
    'docs-site/.docusaurus/registry.js',
    'docs-site/content/using/features.synced.md',
    'docs-site/content/architecture/design/x/DESIGN.synced.md',
    'docs-site/content/architecture/design/x/_category_.json',
    'docs-site/static/synced/docs/marketplace/near-ai-chat.png'
  ]) {
    assert.doesNotThrow(
      () => execFileSync('git', ['check-ignore', '-q', probe], { cwd: REPO_ROOT, stdio: 'ignore' }),
      `${probe} would be committable; git must ignore it`,
    );
  }
  // A version snapshot is meant to be committed.
  assert.throws(
    () => execFileSync('git', ['check-ignore', '-q', 'docs-site/versioned_docs/version-1.0.0/using/features.synced.md'], { cwd: REPO_ROOT, stdio: 'ignore' }),
    'a release snapshot of the docs must stay committable',
  );
});

test('the local docs server and its unit bind to loopback only and the unit holds no local paths', async () => {
  const serve = await readFile(path.join(REPO_ROOT, 'docs-site', 'scripts', 'serve.mjs'), 'utf8');
  assert.match(serve, /const LOOPBACK = new Set\(\['127\.0\.0\.1', '::1', 'localhost'\]\);/);
  assert.match(serve, /if \(!LOOPBACK\.has\(host\)\)/, 'serve.mjs must refuse a non-loopback host');
  assert.doesNotMatch(serve, /0\.0\.0\.0/);
  const unit = await readFile(path.join(REPO_ROOT, 'docs-site', 'scripts', 'near-ai-docs.service.in'), 'utf8');
  assert.match(unit, /--host 127\.0\.0\.1 /);
  assert.doesNotMatch(unit, /0\.0\.0\.0/);
  assert.doesNotMatch(unit, /\/home\/|\/Users\/|[A-Z]:\\/, 'the unit template must not hold a local path; the install script fills them in');
  for (const placeholder of ['@SITE_DIR@', '@NODE@', '@PORT@']) assert.ok(unit.includes(placeholder), `the unit template uses ${placeholder}`);
});

/** The text of one job of ci.yml: from its two-space key line to the next two-space key. */
function ciJob(workflow: string, job: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  assert.ok(start >= 0, `ci.yml has no ${job} job`);
  const body: string[] = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

test('CI builds the docs site with its own lockfile, an audit and no install scripts', async () => {
  const workflow = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const docs = ciJob(workflow, 'docs');
  for (const needle of [
    'name: docs',
    'working-directory: docs-site',
    'cache-dependency-path: docs-site/package-lock.json',
    'persist-credentials: false',
    'npm ci --ignore-scripts',
    'npm audit --audit-level=high',
    'npm run build'
  ]) {
    assert.ok(docs.includes(needle), `the docs job must contain ${needle}`);
  }
  for (const uses of docs.matchAll(/uses: (\S+)/g)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/, `${uses[1]} must be pinned to a full commit SHA`);
  }
});

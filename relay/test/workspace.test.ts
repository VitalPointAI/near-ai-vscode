import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkNodeVersion, MIN_NODE_VERSION } from '../src/nodeVersion';

// Phase 68, plan 01 (RELAY-01): the relay workspace keeps one runtime dependency, refuses an older Node at install and at start, holds the
// Node version rule in one place, and keeps the agent core reachable only through src/runner (Phase 71).
//
// The old-Node cases need a real older node binary. They run when NEAR_AI_RELAY_OLD_NODE names one (for example
// ~/.nvm/versions/node/v24.22.2/bin/node) and are skipped with a printed reason otherwise.

const RELAY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OLD_NODE = process.env.NEAR_AI_RELAY_OLD_NODE;
const SKIP_OLD_NODE = OLD_NODE ? false : 'NEAR_AI_RELAY_OLD_NODE is not set, so the real older-Node refusal was not exercised';

interface Manifest {
  name: string;
  private: boolean;
  type: string;
  engines: { node: string };
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  allowScripts: Record<string, boolean>;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(path.join(RELAY_ROOT, 'package.json'), 'utf8')) as Manifest;
}

function oldNodeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const binDir = path.dirname(OLD_NODE ?? '');
  return { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, HOME: process.env.HOME, ...extra };
}

test('checkNodeVersion refuses 24.22.2, 26.13.0 and 27.0.0 and names 26.13.1 and the version it was given', () => {
  assert.equal(MIN_NODE_VERSION, '26.13.1');
  for (const version of ['24.22.2', '26.13.0', '26.12.9', '27.0.0']) {
    const message = checkNodeVersion(version);
    assert.ok(message, `${version} should be refused`);
    assert.ok(message.includes('26.13.1'), `the refusal for ${version} names 26.13.1`);
    assert.ok(message.includes(version), `the refusal for ${version} names that version`);
  }
});

test('checkNodeVersion accepts 26.13.1 and later 26.x releases', () => {
  for (const version of ['26.13.1', '26.13.2', '26.14.0', '26.20.5']) assert.equal(checkNodeVersion(version), undefined, version);
});

test('an older Node running dist/bin.mjs prints one plain sentence naming Node 26.13.1 and exits 1 without a SyntaxError', { skip: SKIP_OLD_NODE }, () => {
  const run = spawnSync(OLD_NODE as string, [path.join(RELAY_ROOT, 'dist', 'bin.mjs')], { env: oldNodeEnv(), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('26.13.1'), run.stderr);
  assert.ok(!run.stderr.includes('SyntaxError'), run.stderr);
  assert.equal(run.stderr.trim().split('\n').length, 1, 'one plain sentence');
  assert.equal(run.stdout, '');
});

test('an older Node running scripts/check-node.mjs exits 1 with the same sentence and no SyntaxError', { skip: SKIP_OLD_NODE }, () => {
  const run = spawnSync(OLD_NODE as string, [path.join(RELAY_ROOT, 'scripts', 'check-node.mjs')], { env: oldNodeEnv(), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('26.13.1'), run.stderr);
  assert.ok(!run.stderr.includes('SyntaxError'), run.stderr);
});

test('scripts/check-node.mjs passes on the Node running the tests', () => {
  const run = spawnSync(process.execPath, [path.join(RELAY_ROOT, 'scripts', 'check-node.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});

test('npm ci under an older Node stops with EBADENGINE because .npmrc sets engine-strict', { skip: SKIP_OLD_NODE }, () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'near-ai-relay-ebadengine-'));
  try {
    for (const file of ['package.json', 'package-lock.json', '.npmrc']) copyFileSync(path.join(RELAY_ROOT, file), path.join(scratch, file));
    const npm = path.join(path.dirname(OLD_NODE as string), 'npm');
    const run = spawnSync(npm, ['ci', '--ignore-scripts', '--offline'], {
      cwd: scratch,
      env: oldNodeEnv({ npm_config_cache: path.join(scratch, 'cache'), npm_config_update_notifier: 'false' }),
      encoding: 'utf8',
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.ok(`${run.stdout}${run.stderr}`.includes('EBADENGINE'), `${run.stdout}${run.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('package.json keeps one exact runtime dependency, exact dev pins and the engine range', () => {
  const pkg = manifest();
  assert.equal(pkg.name, 'near-ai-relay');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=26.13.1 <27');
  assert.deepEqual(Object.keys(pkg.dependencies), ['jose']);
  assert.match(pkg.dependencies.jose ?? '', /^\d+\.\d+\.\d+$/);
  for (const field of ['optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'] as const) {
    assert.equal(pkg[field], undefined, `${field} must not exist`);
  }
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'esbuild', 'typescript']);
  for (const [name, version] of Object.entries(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  assert.equal(pkg.allowScripts.esbuild, false);
});

test('build, lint and test start with the Node version check, and .npmrc and .nvmrc carry the rules', () => {
  const pkg = manifest();
  for (const script of ['build', 'lint', 'test']) {
    assert.ok((pkg.scripts[script] ?? '').startsWith('node scripts/check-node.mjs'), `${script} starts with the Node check`);
  }
  const npmrc = readFileSync(path.join(RELAY_ROOT, '.npmrc'), 'utf8').split(/\r?\n/);
  assert.ok(npmrc.includes('engine-strict=true'));
  assert.ok(npmrc.includes('save-exact=true'));
  assert.equal(readFileSync(path.join(RELAY_ROOT, '.nvmrc'), 'utf8').trim(), '26.13.1');
});

test('package-lock.json is lockfile version 3 and its runtime packages are exactly the workspace and jose', () => {
  const lock = JSON.parse(readFileSync(path.join(RELAY_ROOT, 'package-lock.json'), 'utf8')) as {
    lockfileVersion: number;
    packages: Record<string, { dev?: boolean }>;
  };
  assert.equal(lock.lockfileVersion, 3);
  const runtime = Object.entries(lock.packages).filter(([, entry]) => !entry.dev).map(([name]) => name).sort();
  assert.deepEqual(runtime, ['', 'node_modules/jose']);
});

// Phase 71 handoff: only src/runner may reach the extension's agent core (through the @ext/* alias); nothing else in the relay imports
// from outside relay/.
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/;

function findBoundaryViolations(file: string, text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const specifier = IMPORT_SPECIFIER.exec(line)?.[1];
    if (specifier === undefined) return;
    const outside = specifier.startsWith('.') && !`${path.resolve(path.dirname(file), specifier)}${path.sep}`.startsWith(`${path.resolve(RELAY_ROOT)}${path.sep}`);
    if (specifier.startsWith('@ext/') || outside) found.push(`${path.relative(RELAY_ROOT, file)}:${index + 1} imports ${specifier}`);
  });
  return found;
}

test('the import boundary check reports both an @ext alias and a relative path that leaves relay/', () => {
  const file = path.join(RELAY_ROOT, 'src', 'main.ts');
  assert.equal(findBoundaryViolations(file, "import { a } from '@ext/agent/loop';").length, 1);
  assert.equal(findBoundaryViolations(file, "import { b } from '../../src/agent/loop';").length, 1);
  assert.equal(findBoundaryViolations(file, "export * from '../../../x';").length, 1);
  assert.equal(findBoundaryViolations(file, "const m = await import('@ext/agent/loop');").length, 1);
  assert.deepEqual(findBoundaryViolations(file, "import { c } from './config';\nimport http from 'node:http';\nimport { d } from '../src/health';"), []);
});

test('no file under relay/src outside src/runner imports from @ext/* or from outside relay/', () => {
  const runnerDir = `${path.join(RELAY_ROOT, 'src', 'runner')}${path.sep}`;
  const violations: string[] = [];
  for (const relative of globSync('src/**/*.ts', { cwd: RELAY_ROOT })) {
    const file = path.join(RELAY_ROOT, relative);
    if (file.startsWith(runnerDir)) continue;
    violations.push(...findBoundaryViolations(file, readFileSync(file, 'utf8')));
  }
  assert.deepEqual(violations, []);
});

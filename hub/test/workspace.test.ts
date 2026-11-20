import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkNodeVersion, MIN_NODE_VERSION } from '../src/nodeVersion';
import {
  BOUNDARY_TEST,
  CALL_FORM,
  closureOf,
  extFileOf,
  hubImportViolations,
  hubSideClosure,
  importsOf,
  parseHubSide,
  readHubSide,
  SIDE_EFFECT_FORM,
  STATIC_FORM,
  VENDOR_FORM,
  type HubImportRules,
} from './helpers/closure';
import { hubRoot } from './helpers/hubProcess';

// Phase 32, plan 14 (D-26, D-27, D-28, D-33): the hub workspace has no runtime dependency at all, refuses an older Node at install and at start
// with one plain sentence, and can import nothing but node: builtins, its own files and the extension's pure hub-side replica code. The built app
// bundle is checked too, from the esbuild metafile (dist/meta.json), so what the hub really runs holds the same boundary.
//
// The old-Node cases need a real older node binary. They run when NEAR_AI_HUB_OLD_NODE names one (a Node 24 binary) and are skipped with a printed
// reason otherwise. CI sets it, and a run in GitHub Actions without it fails.

const HUB_ROOT = hubRoot();
const REPO_ROOT = path.dirname(HUB_ROOT);
const OLD_NODE = process.env.NEAR_AI_HUB_OLD_NODE;
const SKIP_OLD_NODE = OLD_NODE ? false : 'NEAR_AI_HUB_OLD_NODE is not set, so the real older-Node refusal was not exercised';

interface Manifest {
  name: string;
  private: boolean;
  type: string;
  engines: { node: string };
  scripts: Record<string, string>;
  dependencies?: unknown;
  devDependencies: Record<string, string>;
  allowScripts: Record<string, boolean>;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(path.join(HUB_ROOT, 'package.json'), 'utf8')) as Manifest;
}

function oldNodeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const binDir = path.dirname(OLD_NODE ?? '');
  return { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, HOME: process.env.HOME, ...extra };
}

const closure = hubSideClosure(REPO_ROOT);
const RULES: HubImportRules = { hubRoot: HUB_ROOT, repoRoot: REPO_ROOT, allowedExt: new Set(closure) };

// The Node guard.

test('checkNodeVersion refuses 24.22.2, 26.13.0 and 27.0.0, names 26.13.1 and the version it was given, and names near-ai-hub', () => {
  assert.equal(MIN_NODE_VERSION, '26.13.1');
  for (const version of ['24.22.2', '26.13.0', '26.12.9', '27.0.0']) {
    const message = checkNodeVersion(version);
    assert.ok(message, `${version} should be refused`);
    assert.ok(message.includes('26.13.1'), `the refusal for ${version} names 26.13.1`);
    assert.ok(message.includes(version), `the refusal for ${version} names that version`);
    assert.ok(message.startsWith('near-ai-hub '), 'the refusal names the hub');
    assert.ok(!message.includes('\n'), 'one sentence on one line');
  }
});

test('checkNodeVersion accepts 26.13.1 and later 26.x releases', () => {
  for (const version of ['26.13.1', '26.13.2', '26.14.0', '26.20.5']) assert.equal(checkNodeVersion(version), undefined, version);
});

test('in GitHub Actions the older-Node refusal tests run and are not skipped', () => {
  if (process.env.GITHUB_ACTIONS === 'true') assert.ok(OLD_NODE, 'NEAR_AI_HUB_OLD_NODE must be set in CI');
});

test('an older Node running dist/bin.mjs prints one plain sentence naming Node 26.13.1 and exits 1 without a SyntaxError', { skip: SKIP_OLD_NODE }, () => {
  const run = spawnSync(OLD_NODE as string, [path.join(HUB_ROOT, 'dist', 'bin.mjs')], { env: oldNodeEnv(), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('26.13.1'), run.stderr);
  assert.ok(run.stderr.startsWith('near-ai-hub '), run.stderr);
  assert.ok(!run.stderr.includes('SyntaxError'), run.stderr);
  assert.equal(run.stderr.trim().split('\n').length, 1, 'one plain sentence');
  assert.equal(run.stdout, '');
});

test('an older Node running scripts/check-node.mjs exits 1 with the same sentence and no SyntaxError', { skip: SKIP_OLD_NODE }, () => {
  const run = spawnSync(OLD_NODE as string, [path.join(HUB_ROOT, 'scripts', 'check-node.mjs')], { env: oldNodeEnv(), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('26.13.1'), run.stderr);
  assert.ok(!run.stderr.includes('SyntaxError'), run.stderr);
});

test('scripts/check-node.mjs passes on the Node running the tests', () => {
  const run = spawnSync(process.execPath, [path.join(HUB_ROOT, 'scripts', 'check-node.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});

test('npm ci under an older Node stops with EBADENGINE because .npmrc sets engine-strict', { skip: SKIP_OLD_NODE }, () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-ebadengine-'));
  try {
    for (const file of ['package.json', 'package-lock.json', '.npmrc']) copyFileSync(path.join(HUB_ROOT, file), path.join(scratch, file));
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

// The manifest and the lockfile.

test('package.json has no dependencies of any kind, exactly the three exact dev pins, the engine range and esbuild scripts off', () => {
  const pkg = manifest();
  assert.equal(pkg.name, 'near-ai-hub');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=26.13.1 <27');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'] as const) {
    assert.equal(pkg[field], undefined, `${field} must not exist`);
  }
  assert.deepEqual(pkg.devDependencies, { '@types/node': '26.6.6', esbuild: '0.28.2', typescript: '5.9.3' });
  assert.deepEqual(pkg.allowScripts, { esbuild: false });
});

test('the dev pins are the versions relay/package-lock.json already pins, so the hub adds no new package', () => {
  const relayLock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'relay', 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
  for (const [name, version] of Object.entries(manifest().devDependencies)) {
    assert.equal(relayLock.packages[`node_modules/${name}`]?.version, version, `${name} differs from the relay's pin`);
  }
});

test('build, lint, test and test:container start with the Node version check, and .npmrc and .nvmrc carry the rules', () => {
  const pkg = manifest();
  for (const script of ['build', 'lint', 'test', 'test:container']) {
    assert.ok((pkg.scripts[script] ?? '').startsWith('node scripts/check-node.mjs'), `${script} starts with the Node check`);
  }
  const npmrc = readFileSync(path.join(HUB_ROOT, '.npmrc'), 'utf8').split(/\r?\n/);
  assert.ok(npmrc.includes('engine-strict=true'));
  assert.ok(npmrc.includes('save-exact=true'));
  assert.equal(readFileSync(path.join(HUB_ROOT, '.nvmrc'), 'utf8').trim(), '26.13.1');
});

test('package-lock.json is lockfile version 3 and its only non-dev package is the workspace itself', () => {
  const lock = JSON.parse(readFileSync(path.join(HUB_ROOT, 'package-lock.json'), 'utf8')) as {
    lockfileVersion: number;
    packages: Record<string, { dev?: boolean; name?: string; dependencies?: unknown }>;
  };
  assert.equal(lock.lockfileVersion, 3);
  const runtime = Object.entries(lock.packages).filter(([, entry]) => !entry.dev).map(([name]) => name);
  assert.deepEqual(runtime, ['']);
  assert.equal(lock.packages['']?.name, 'near-ai-hub');
  assert.equal(lock.packages['']?.dependencies, undefined);
});

// The hub-side closure, read from the extension's list.

test('readHubSide reads the HUB_SIDE list from the extension boundary test, and a list too short to be it is refused', () => {
  const hubSide = readHubSide(REPO_ROOT);
  assert.ok(hubSide.length >= 20, `found ${hubSide.length} entries`);
  for (const entry of ['domain/replica/entry', 'domain/replica/kindSchemas/', 'domain/replica/cellKeys', 'domain/replica/roster']) {
    assert.ok(hubSide.includes(entry), `${entry} is in HUB_SIDE`);
  }
  assert.ok(hubSide.every((entry) => entry.startsWith('domain/replica/')), 'every entry is a replica module');
  assert.throws(() => parseHubSide("export const HUB_SIDE: readonly string[] = [\n  'domain/replica/entry', // 'domain/replica/doc'\n];"), /fewer than 20/);
  assert.throws(() => parseHubSide('const OTHER = [];'), /no longer declares HUB_SIDE/);
  // A comment inside the list is not an entry.
  const twenty = Array.from({ length: 20 }, (_, n) => `'domain/replica/m${n}'`).join(',\n');
  assert.deepEqual(parseHubSide(`export const HUB_SIDE = [\n// 'domain/replica/doc'\n${twenty}\n];`).length, 20);
});

test(`the scanner uses the same line rules as importsOf in ${BOUNDARY_TEST}`, () => {
  const text = readFileSync(path.join(REPO_ROOT, BOUNDARY_TEST), 'utf8');
  for (const [name, ours] of [['STATIC_FORM', STATIC_FORM], ['SIDE_EFFECT_FORM', SIDE_EFFECT_FORM], ['CALL_FORM', CALL_FORM], ['VENDOR_FORM', VENDOR_FORM]] as const) {
    const line = text.split('\n').find((candidate) => candidate.startsWith(`const ${name} = /`));
    assert.ok(line, `${name} is no longer declared in ${BOUNDARY_TEST}`);
    const literal = line.slice(line.indexOf('/'), line.lastIndexOf(';'));
    const flags = literal.slice(literal.lastIndexOf('/') + 1);
    const source = literal.slice(1, literal.lastIndexOf('/'));
    assert.equal(new RegExp(source, flags).source, ours.source, `${name} differs from the extension's`);
    assert.equal(flags, ours.flags, `${name} flags differ from the extension's`);
  }
});

test('the hub-side closure is pure domain code: all under src/domain, holds canonical.ts and no doc.ts, and reaches no editor API, Yjs, package or vendor path', () => {
  assert.ok(closure.length >= 30, `the closure has ${closure.length} files`);
  assert.deepEqual(closure.filter((file) => !file.startsWith('domain/')), []);
  assert.ok(closure.includes('domain/team/canonical.ts'));
  assert.ok(closure.includes('domain/replica/cellKeys.ts'));
  assert.ok(!closure.includes('domain/replica/doc.ts'));
  assert.deepEqual(closureOf(REPO_ROOT, closure).problems, []);
});

// The hub's own imports.

function hubFiles(folder: 'src' | 'test'): string[] {
  return globSync(`${folder}/**/*.ts`, { cwd: HUB_ROOT }).map((relative) => path.join(HUB_ROOT, relative)).sort();
}

test('every import under hub/src is a node: builtin, a path inside hub/, or an @ext import of a hub-side closure file', () => {
  const files = hubFiles('src');
  assert.ok(files.length >= 12, `found ${files.length} source files`);
  assert.deepEqual(files.flatMap((file) => hubImportViolations(RULES, file, readFileSync(file, 'utf8'))), []);
  // The scan sees the @ext imports it allows, so an empty result is not an empty scan.
  assert.ok(importsOf(readFileSync(path.join(HUB_ROOT, 'src', 'keys.ts'), 'utf8')).some((ref) => ref.specifier === '@ext/domain/replica/cellKeys'));
});

test('every @ext import under hub/test names a file whose own closure has no editor API, no Yjs, no package and no vendor path', () => {
  const problems: string[] = [];
  let seen = 0;
  for (const file of hubFiles('test')) {
    const text = readFileSync(file, 'utf8');
    for (const ref of importsOf(text)) {
      const where = `${path.relative(REPO_ROOT, file)}:${ref.line} ${ref.specifier}`;
      if (ref.specifier.startsWith('@ext/')) {
        seen += 1;
        const target = extFileOf(REPO_ROOT, ref.specifier);
        if (target === undefined) problems.push(`${where}  names no file under src`);
        else problems.push(...closureOf(REPO_ROOT, [target]).problems.map((problem) => `${where} -> ${problem}`));
      } else if (!ref.specifier.startsWith('node:') && !ref.specifier.startsWith('.')) {
        problems.push(`${where}  a hub test imports only node: builtins, its own files and @ext modules`);
      } else if (ref.specifier.startsWith('.') && !path.resolve(path.dirname(file), ref.specifier).startsWith(`${HUB_ROOT}${path.sep}`)) {
        problems.push(`${where}  leaves hub/`);
      }
    }
  }
  assert.ok(seen > 0, 'no @ext import under hub/test was seen, so the scan proved nothing');
  assert.deepEqual(problems, []);
});

const DYNAMIC = 'import';
const REQUIRE = 'require';

test('the scanner has teeth: vscode, yjs, a package, a bare builtin, a path leaving hub/, an @ext file outside the closure and the vendor path are all reported', () => {
  const file = path.join(HUB_ROOT, 'src', 'planted.ts');
  const found = (lines: string[]): string[] => hubImportViolations(RULES, file, lines.join('\n')).map((entry) => entry.split('  ')[0] as string);
  assert.deepEqual(
    found([
      "import { createHash } from 'node:crypto';",
      "import { loadConfig } from './config';",
      "import { x25519BindingBytes } from '@ext/domain/replica/cellKeys';",
      "import type { PayloadSigner } from '@ext/domain/team/signedPayload';",
      "import * as vscode from 'vscode';",
      "import type * as Y from 'yjs';",
      "import { jwtVerify } from 'jose';",
      "import { createHash as h } from 'crypto';",
      "import { main } from '../../relay/src/main';",
      "import { applyUpdate } from '@ext/domain/replica/doc';",
      "import type { Tool } from '@ext/agent/tools';",
      "export { x } from '@ext/domain/replica/fold';",
      // Built from parts so the call forms in this file's own text are not read as imports of this test.
      `const lazy = await ${DYNAMIC}('vscode');`,
      `const req = ${REQUIRE}('left-pad');`,
      "import 'yjs';",
      "const bundle = path.join(root, 'vendor', 'yjs', 'yjs.cjs');",
    ]),
    [
      'hub/src/planted.ts:5 vscode',
      'hub/src/planted.ts:6 yjs',
      'hub/src/planted.ts:7 jose',
      'hub/src/planted.ts:8 crypto',
      'hub/src/planted.ts:9 ../../relay/src/main',
      'hub/src/planted.ts:10 @ext/domain/replica/doc',
      'hub/src/planted.ts:11 @ext/agent/tools',
      'hub/src/planted.ts:12 @ext/domain/replica/fold',
      'hub/src/planted.ts:13 vscode',
      'hub/src/planted.ts:14 left-pad',
      'hub/src/planted.ts:15 yjs',
      'hub/src/planted.ts:16 vendor/yjs',
    ],
  );
  // A comment that mentions an import in prose is not an import.
  assert.deepEqual(found(["// see import { x } from 'vscode' in the extension", " * import * as Y from 'yjs';"]), []);
  // The test-file rule: an @ext module whose closure loads Yjs is reported, a pure one is not.
  assert.ok(closureOf(REPO_ROOT, ['domain/replica/doc.ts']).problems.some((problem) => /Yjs|vendor\/yjs/.test(problem)));
  assert.deepEqual(closureOf(REPO_ROOT, ['domain/replica/cellKeys.ts']).problems, []);
});

// The built app bundle.

interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[]; entryPoint?: string }>;
}

function bundleProblems(meta: Metafile): string[] {
  const problems: string[] = [];
  for (const input of Object.keys(meta.inputs)) {
    const absolute = path.resolve(HUB_ROOT, input);
    if (absolute.startsWith(`${HUB_ROOT}${path.sep}`)) continue;
    const underSrc = path.relative(path.join(REPO_ROOT, 'src'), absolute).split(path.sep).join('/');
    if (underSrc.startsWith('../') || !closure.includes(underSrc)) problems.push(`input ${input} is outside hub/ and not a hub-side closure file`);
  }
  for (const [output, entry] of Object.entries(meta.outputs)) {
    for (const ref of entry.imports) {
      if (ref.external && !ref.path.startsWith('node:')) problems.push(`${output} imports ${ref.path}, which is not a node: builtin`);
    }
  }
  return problems;
}

test('the app bundle (dist/meta.json) takes inputs only from hub/ and the hub-side closure, and its only externals are node: builtins', () => {
  const meta = JSON.parse(readFileSync(path.join(HUB_ROOT, 'dist', 'meta.json'), 'utf8')) as Metafile;
  const inputs = Object.keys(meta.inputs);
  assert.ok(inputs.includes('src/main.ts'), 'the metafile is the app bundle');
  assert.ok(inputs.some((input) => input.startsWith('../src/domain/')), 'the bundle inlines hub-side code, so the input check is exercised');
  const app = Object.entries(meta.outputs).find(([output]) => output.endsWith('dist/app.mjs'));
  assert.ok(app, 'dist/app.mjs is an output');
  assert.ok(app[1].imports.some((ref) => ref.external && ref.path === 'node:https'), 'the externals are listed');
  assert.deepEqual(bundleProblems(meta), []);
  // Teeth: a bundle that took in a Yjs file, an editor file or a package is reported.
  const planted: Metafile = {
    inputs: { 'src/main.ts': {}, '../src/domain/replica/doc.ts': {}, '../src/agent/loop.ts': {}, '../node_modules/yjs/dist/yjs.mjs': {} },
    outputs: { 'dist/app.mjs': { imports: [{ path: 'node:fs', kind: 'import-statement', external: true }, { path: 'vscode', kind: 'import-statement', external: true }] } },
  };
  assert.equal(bundleProblems(planted).length, 4);
});

// Copied relay modules (D-28).

const COPIED = ['scripts/build.mjs', 'scripts/check-node.mjs', 'src/bin.ts', 'src/main.ts', 'src/nodeVersion.ts', 'src/config.ts', 'src/secrets.ts', 'src/stateDir.ts', 'src/startup.ts', 'src/log/logger.ts', 'src/log/redact.ts', 'src/health.ts', 'src/http/server.ts'];

test('each copied relay module says on its first line which relay file it came from, and that file exists', () => {
  for (const file of COPIED) {
    const first = readFileSync(path.join(HUB_ROOT, file), 'utf8').split('\n').find((line) => !line.startsWith('#!')) ?? '';
    const match = /^\/\/ Copied from (relay\/\S+?) and adapted for the hub/.exec(first);
    assert.ok(match, `${file} does not name the relay file it came from: ${first}`);
    assert.ok(spawnSync('test', ['-f', path.join(REPO_ROOT, match[1] as string)]).status === 0, `${file} names ${match[1]}, which does not exist`);
  }
});

test('nothing under hub/ imports from relay/, so the two services never couple', () => {
  const problems: string[] = [];
  for (const file of [...hubFiles('src'), ...hubFiles('test'), ...globSync('scripts/*.mjs', { cwd: HUB_ROOT }).map((relative) => path.join(HUB_ROOT, relative))]) {
    for (const ref of importsOf(readFileSync(file, 'utf8'))) {
      const resolved = ref.specifier.startsWith('.') ? path.resolve(path.dirname(file), ref.specifier) : '';
      if (resolved.startsWith(`${path.join(REPO_ROOT, 'relay')}${path.sep}`) || ref.specifier.includes('relay/')) problems.push(`${path.relative(REPO_ROOT, file)}:${ref.line} ${ref.specifier}`);
    }
  }
  assert.deepEqual(problems, []);
});

// Git keeps hub state and secrets out of commits (D-26).

test('git ignores the hub database and its WAL, hub secret files, and hub secrets kept beside the relay', (t) => {
  const paths = ['hub/state/hub.db', 'hub/state/hub.db-wal', 'hub/state/hub.db-shm', 'hub/secrets/hub_tls_key', 'hub/secrets/hub_signing_key', 'hub/other.db', 'relay/secrets/hub/hub_signing_key'];
  const run = spawnSync('git', ['check-ignore', '--no-index', ...paths], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (run.error !== undefined || /not a git repository/.test(run.stderr)) {
    // A container build context has no .git; the repository checkout always does, and CI runs there.
    t.skip('not inside a git checkout, so .gitignore cannot be asked');
    return;
  }
  assert.deepEqual(run.stdout.trim().split('\n').sort(), [...paths].sort(), run.stderr);
});

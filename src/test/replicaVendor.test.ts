// The vendored Yjs build the replica core will use (D-16, D-33): the bundle works, and (added with the hash manifest) it is exactly the
// reviewed copy. This file loads vendor/yjs/yjs.cjs directly to test the vendored artifact itself; the rule that nothing outside
// src/domain/replica/doc.ts imports Yjs (D-17) governs the replica core and is checked by its boundary test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface YText { insert(index: number, text: string): void; toString(): string }
interface YDoc { clientID: number; getText(name: string): YText }
interface YjsModule {
  Doc: new () => YDoc;
  encodeStateAsUpdate(doc: YDoc): Uint8Array;
  applyUpdate(doc: YDoc, update: Uint8Array): void;
}

function loadYjs(): YjsModule {
  return require(path.join(REPO_ROOT, 'vendor', 'yjs', 'yjs.cjs')) as YjsModule;
}

interface CrdtManifest {
  esbuild: string;
  packages: Array<{ name: string; version: string; license: string; integrity: string }>;
  inputs: Record<string, string>;
  licenses: Record<string, string>;
  output: { file: string; sha256: string };
}

const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(path.join(REPO_ROOT, ...parts), 'utf8')) as T;
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(path.join(REPO_ROOT, file))).digest('hex');

/** Every way the files on disk differ from the manifest, each naming the file; an empty list means the vendored copy is the reviewed one. */
function manifestMismatches(manifest: CrdtManifest, root: string): string[] {
  const problems: string[] = [];
  const check = (label: string, file: string, expected: string): void => {
    let actual: string;
    try { actual = createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'); } catch { actual = '(cannot be read)'; }
    if (actual !== expected) problems.push(`${label} ${file}: expected ${expected}, got ${actual}`);
  };
  for (const [file, hash] of Object.entries(manifest.inputs)) check('source file', file, hash);
  for (const [file, hash] of Object.entries(manifest.licenses)) check('licence file', file, hash);
  check('built file', manifest.output.file, manifest.output.sha256);
  const esbuild = (JSON.parse(readFileSync(path.join(root, 'node_modules', 'esbuild', 'package.json'), 'utf8')) as { version: string }).version;
  if (esbuild !== manifest.esbuild) problems.push(`esbuild version: expected ${manifest.esbuild}, got ${esbuild}`);
  return problems;
}

interface ManifestRow { name: string; version: string; license: string; bundledIn?: string }

test('the bundled Yjs merges two concurrent edits in both orders', () => {
  const Y = loadYjs();
  const edit = (clientID: number, text: string): Uint8Array => {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    doc.getText('body').insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  };
  const fromA = edit(101, 'alpha ');
  const fromB = edit(202, 'beta ');
  const inOrderAB = new Y.Doc();
  Y.applyUpdate(inOrderAB, fromA);
  Y.applyUpdate(inOrderAB, fromB);
  const inOrderBA = new Y.Doc();
  Y.applyUpdate(inOrderBA, fromB);
  Y.applyUpdate(inOrderBA, fromA);
  const text = inOrderAB.getText('body').toString();
  assert.equal(inOrderBA.getText('body').toString(), text);
  assert.ok(text.includes('alpha ') && text.includes('beta '), `both edits survive, got ${JSON.stringify(text)}`);
});

test('vendor/manifest.json lists yjs 13.6.33 and lib0 0.2.119 bundled in yjs', () => {
  const rows = JSON.parse(readFileSync(path.join(REPO_ROOT, 'vendor', 'manifest.json'), 'utf8')) as ManifestRow[];
  const row = (name: string): ManifestRow | undefined => rows.find((entry) => entry.name === name);
  assert.equal(row('yjs')?.version, '13.6.33');
  assert.equal(row('yjs')?.license, 'MIT');
  assert.equal(row('yjs')?.bundledIn, undefined);
  assert.equal(row('lib0')?.version, '0.2.119');
  assert.equal(row('lib0')?.license, 'MIT');
  assert.equal(row('lib0')?.bundledIn, 'yjs');
  // If esbuild ever bundled isomorphic.js, SECURITY.md and the manifest would have to name it; stop and review instead.
  assert.equal(row('isomorphic.js'), undefined, 'isomorphic.js is not bundled into vendor/yjs/yjs.cjs');
});

test('package.json pins yjs and lib0 exactly as devDependencies and declares no runtime dependencies', () => {
  const pkg = readJson<{ dependencies?: unknown; devDependencies: Record<string, string> }>('package.json');
  assert.equal(pkg.devDependencies['yjs'], '13.6.33');
  assert.equal(pkg.devDependencies['lib0'], '0.2.119');
  assert.equal(pkg.dependencies, undefined, 'the extension has no runtime dependencies; vendored code is bundled');
});

test('package-lock.json records the version and npm integrity that scripts/crdt-vendor.json names', () => {
  const manifest = readJson<CrdtManifest>('scripts', 'crdt-vendor.json');
  const lock = readJson<{ packages: Record<string, { version: string; integrity: string }> }>('package-lock.json').packages;
  assert.deepEqual(manifest.packages.map((entry) => entry.name), ['yjs', 'lib0', 'isomorphic.js']);
  for (const entry of manifest.packages) {
    const locked = lock[`node_modules/${entry.name}`];
    assert.equal(locked?.version, entry.version, `${entry.name} version in package-lock.json`);
    assert.equal(locked?.integrity, entry.integrity, `${entry.name} integrity in package-lock.json`);
  }
  assert.deepEqual(manifest.packages.map((entry) => `${entry.name}@${entry.version}`), ['yjs@13.6.33', 'lib0@0.2.119', 'isomorphic.js@0.2.5']);
});

test('every bundled source file, licence file, the built file and the esbuild version match scripts/crdt-vendor.json', () => {
  const manifest = readJson<CrdtManifest>('scripts', 'crdt-vendor.json');
  assert.ok(Object.keys(manifest.inputs).length >= 20, 'the manifest lists every bundled source file');
  assert.match(manifest.output.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.output.file, 'vendor/yjs/yjs.cjs');
  assert.deepEqual(manifestMismatches(manifest, REPO_ROOT), []);
  assert.equal(sha256('vendor/yjs/yjs.cjs'), manifest.output.sha256);
});

test('a changed source file or built file is reported by name', () => {
  const manifest = readJson<CrdtManifest>('scripts', 'crdt-vendor.json');
  const [file] = Object.keys(manifest.inputs) as [string];
  const changedInput: CrdtManifest = { ...manifest, inputs: { ...manifest.inputs, [file]: '0'.repeat(64) } };
  const reported = manifestMismatches(changedInput, REPO_ROOT);
  assert.equal(reported.length, 1);
  assert.ok(reported[0]?.includes(file), reported[0]);
  const changedOutput: CrdtManifest = { ...manifest, output: { ...manifest.output, sha256: 'f'.repeat(64) } };
  const reportedOutput = manifestMismatches(changedOutput, REPO_ROOT);
  assert.equal(reportedOutput.length, 1);
  assert.ok(reportedOutput[0]?.includes('vendor/yjs/yjs.cjs'), reportedOutput[0]);
  const otherEsbuild = manifestMismatches({ ...manifest, esbuild: '0.0.1' }, REPO_ROOT);
  assert.equal(otherEsbuild.length, 1);
  assert.ok(otherEsbuild[0]?.startsWith('esbuild version'), otherEsbuild[0]);
});

test('vendor/yjs/LICENSES.txt has an MIT section for yjs and for lib0', () => {
  const text = readFileSync(path.join(REPO_ROOT, 'vendor', 'yjs', 'LICENSES.txt'), 'utf8');
  for (const heading of ['== yjs 13.6.33 ==', '== lib0 0.2.119 ==']) {
    const at = text.indexOf(heading);
    assert.ok(at >= 0, `${heading} is present`);
    const next = text.indexOf('\n== ', at + heading.length);
    assert.ok(text.slice(at, next < 0 ? undefined : next).includes('MIT'), `${heading} section names the MIT licence`);
  }
});

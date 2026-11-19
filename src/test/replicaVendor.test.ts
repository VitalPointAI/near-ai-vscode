// The vendored Yjs build the replica core will use (D-16, D-33): the bundle works, and (added with the hash manifest) it is exactly the
// reviewed copy. This file loads vendor/yjs/yjs.cjs directly to test the vendored artifact itself; the rule that nothing outside
// src/domain/replica/doc.ts imports Yjs (D-17) governs the replica core and is checked by its boundary test.
import assert from 'node:assert/strict';
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

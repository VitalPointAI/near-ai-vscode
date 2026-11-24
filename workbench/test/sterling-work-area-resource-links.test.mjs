import assert from 'node:assert/strict';
import test from 'node:test';
import { BinaryBuffer } from '@theia/core/lib/common/buffer.js';
import { URI } from '@theia/core/lib/common/uri.js';
import { FileType, etag } from '@theia/filesystem/lib/common/files.js';
import { linkWorkAreaResource } from '../extension/src/browser/sterling-work-area-resource-links.ts';
import { parseWorkArea } from '../extension/src/common/sterling-work-areas.ts';

const scope = new URI('file:///workspace');
const child = scope.resolve('work-area-0123456789abcdef');
const first = { sourceId: 'stock-a', resourceId: 'record-1' };
const second = { sourceId: 'stock-b', resourceId: 'record-1' };
const metadata = { version: 1, kind: 'projects', title: 'Example project', preferences: { pinned: true } };

function fixture(target, initial = JSON.stringify(metadata)) {
  const fileUri = target.resolve('.planning/.near-ai/work-area.json');
  const writes = [];
  const file = {
    text: initial,
    reads: 0,
    beforeRead: undefined,
    linkedFolder: undefined
  };
  const stat = (type, size = 0) => ({ type, size, mtime: 100, ctime: 100 });
  const provider = {
    async stat(uri) {
      if (file.linkedFolder?.isEqual(uri)) return stat(FileType.Directory | FileType.SymbolicLink);
      return uri.isEqual(fileUri) ? stat(FileType.File, Buffer.byteLength(file.text)) : stat(FileType.Directory);
    }
  };
  const files = {
    async activateProvider(scheme) {
      assert.equal(scheme, 'file');
      return provider;
    },
    async readFile(uri, options) {
      assert.ok(uri.isEqual(fileUri));
      assert.equal(options.limits.size, 32 * 1024);
      assert.equal(options.length, 32 * 1024 + 1);
      file.beforeRead?.(++file.reads);
      const info = await provider.stat(uri);
      return { ...info, etag: etag(info), value: BinaryBuffer.fromString(file.text) };
    },
    async writeFile(uri, data, guards) {
      assert.ok(uri.isEqual(fileUri));
      const info = await provider.stat(uri);
      assert.deepEqual(guards, { mtime: info.mtime, etag: etag(info) });
      file.text = data.toString();
      writes.push(JSON.parse(file.text));
    }
  };
  return { files, writes, file };
}

test('links to the open area or its immediate opaque child and preserves unrelated metadata', async () => {
  for (const target of [scope, child]) {
    const { files, writes } = fixture(target);
    await linkWorkAreaResource(files, scope, target, first);
    await linkWorkAreaResource(files, scope, target, first);
    assert.deepEqual(writes, [{ ...metadata, resourceRefs: [first] }]);
  }
});

test('two concurrent selections keep both source-scoped links', async () => {
  const { files, writes } = fixture(child);
  await Promise.all([
    linkWorkAreaResource(files, scope, child, first),
    linkWorkAreaResource(files, scope, child, second)
  ]);
  assert.deepEqual(writes.at(-1), { ...metadata, resourceRefs: [first, second] });
});

test('refuses unscoped, remote and malformed resource references before touching files', async () => {
  const files = { activateProvider: () => assert.fail('path guard must precede filesystem access') };
  for (const target of [child.resolve('work-area-1111111111111111'), scope.resolve('ordinary'), new URI('file://remote/workspace'), new URI('file:///workspace%3Fname?other'), new URI('file:///workspace/work-area-0123456789abcdef/..')]) {
    await assert.rejects(linkWorkAreaResource(files, scope, target, first), /outside the open workspace/);
  }
  await assert.rejects(linkWorkAreaResource(files, scope, child, { ...first, name: 'Private item' }), /reference is invalid/);
});

test('refuses linked components, malformed metadata and a same-length rewrite after the read', async () => {
  const linked = fixture(child);
  linked.file.linkedFolder = scope;
  await assert.rejects(linkWorkAreaResource(linked.files, scope, child, first), /regular local directories/);
  assert.deepEqual(linked.writes, []);
  for (const text of ['null', JSON.stringify({ ...metadata, resourceRefs: [{ ...first, status: 'held' }] }), JSON.stringify({ ...metadata, resourceRefs: [first, first] }), 'x'.repeat(32 * 1024 + 1)]) {
    const malformed = fixture(child, text);
    await assert.rejects(linkWorkAreaResource(malformed.files, scope, child, second));
    assert.deepEqual(malformed.writes, []);
  }
  const raced = fixture(child);
  raced.file.beforeRead = (read) => {
    if (read === 2) raced.file.text = raced.file.text.replace('Example project', 'Changed project');
  };
  await assert.rejects(linkWorkAreaResource(raced.files, scope, child, second), /details changed/);
  assert.deepEqual(raced.writes, []);
});

test('a capability record keeps its components, as labels and titles, for Get Started to list', () => {
  const capability = { version: 1, kind: 'capability-development', title: 'Example capability' };
  const parsed = parseWorkArea(JSON.stringify({ ...capability, components: [
    { kind: 'program', title: 'Example program' }, { kind: 'minor-capital', title: 'Example upgrade', status: 'ignored' }
  ] }));
  assert.equal(parsed?.detail, '2 components');
  assert.deepEqual(parsed?.components, [
    { label: 'Program', title: 'Example program' }, { label: 'Minor capital project', title: 'Example upgrade' }
  ]);
  assert.equal(parseWorkArea(JSON.stringify({ version: 1, kind: 'training', title: 'Example exercise' }))?.components, undefined);
  for (const bad of [{ kind: 'unknown', title: 'Example' }, { kind: 'program', title: ' padded ' }, { kind: 'program', title: 'line\nbreak' }]) {
    assert.equal(parseWorkArea(JSON.stringify({ ...capability, components: [bad] })), undefined);
  }
});

// The in-process ZIP reader (scripts/lib/zip.mjs) that the release content gate
// (scripts/verify-release-content.mjs) reads the packaged VSIX with, so the gate needs no `unzip`
// tool. The archives are built here byte by byte, so every damaged case is exact.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { openZip } from '../lib/zip.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** A ZIP file of `files` ([{ name, data, method }]); `tweak` may change each record before it is written. */
function makeZip(files, { tweak = () => {}, comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.data);
    const method = file.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(file.name);
    const record = { crc: crc32(data) >>> 0, size: data.length, compressedSize: body.length, method, flags: 0, localName: name };
    tweak(file.name, record);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(record.flags, 6);
    local.writeUInt16LE(record.method, 8);
    local.writeUInt32LE(record.crc, 14);
    local.writeUInt32LE(record.compressedSize, 18);
    local.writeUInt32LE(record.size, 22);
    local.writeUInt16LE(record.localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(record.flags, 8);
    central.writeUInt16LE(record.method, 10);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.compressedSize, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, record.localName, body);
    centrals.push(central, name);
    offset += 30 + record.localName.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)]);
}

test('a stored and a deflated entry are listed and read back exactly', () => {
  const text = 'tile '.repeat(10_000);
  const zip = openZip(makeZip([
    { name: 'extension/package.json', data: '{"name":"x"}', method: 0 },
    { name: 'extension/media/map/globe/index.json', data: text },
    { name: 'extension/empty.txt', data: '' }
  ], { comment: 'a comment after the directory' }));
  assert.deepEqual(zip.entries, ['extension/package.json', 'extension/media/map/globe/index.json', 'extension/empty.txt']);
  assert.equal(zip.read('extension/package.json').toString(), '{"name":"x"}');
  assert.equal(zip.read('extension/media/map/globe/index.json').toString(), text);
  assert.equal(zip.read('extension/empty.txt').length, 0);
  assert.throws(() => zip.read('extension/absent.txt'), /no entry named extension\/absent\.txt/);
});

test('a damaged or unsupported archive is refused, never read past', () => {
  const files = [{ name: 'a.txt', data: 'hello world' }];
  const cases = [
    ['a wrong CRC-32', { tweak: (_, r) => { r.crc = (r.crc + 1) >>> 0; } }, /does not match its recorded CRC-32/],
    ['a wrong size', { tweak: (_, r) => { r.size += 1; } }, /bytes, but the ZIP records|maxOutputLength|buffer/i],
    ['encryption', { tweak: (_, r) => { r.flags = 1; } }, /encrypted/],
    ['an unknown method', { tweak: (_, r) => { r.method = 12; } }, /compression method 12/],
    ['a local header naming another file', { tweak: (_, r) => { r.localName = Buffer.from('b.txt'); } }, /names b\.txt/]
  ];
  for (const [label, options, expected] of cases) {
    const zip = openZip(makeZip(files, options));
    assert.throws(() => zip.read('a.txt'), expected, label);
  }
  assert.throws(() => openZip(makeZip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }])), /two entries named a\.txt/);
  assert.throws(() => openZip(Buffer.from('not a zip file at all, just some text here')), /end-of-central-directory/);
  assert.throws(() => openZip(Buffer.alloc(4)), /too short/);
  const big = makeZip([{ name: 'big.bin', data: Buffer.alloc(2048) }]);
  assert.throws(() => openZip(big, { maxEntryBytes: 1024 }).read('big.bin'), /over the 1024-byte limit/);
  const truncated = makeZip(files);
  assert.throws(() => openZip(truncated.subarray(0, truncated.length - 1)), /end-of-central-directory/);
});

test('the release content gate reads the package in process and runs no unzip tool', () => {
  const source = readFileSync(path.join(ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  assert.doesNotMatch(source, /node:child_process/, 'no external tool is started');
  assert.doesNotMatch(source, /['"]unzip['"]/);
  assert.match(source, /import \{ openZip \} from '\.\/lib\/zip\.mjs'/);
});

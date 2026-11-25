// The one archive reader (45.2-14, CONTEXT D-31): ZIP containers from outside your organization (TDF objects, Office files, OPC packages) are read by
// src/domain/archive/zip.ts, which refuses as data, before unpacking more than it must. Every archive here is built in the test by our own writer or by
// patching its bytes; no partner file is committed.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';
import test from 'node:test';
import {
  ARCHIVE_REFUSALS,
  EXCHANGE_ARCHIVE_LIMITS,
  OFFICE_ARCHIVE_LIMITS,
  openArchive,
  writeZip,
  type ArchiveRefusal,
  type OpenedArchive
} from '../domain/archive/zip';
import { MAX_UNPACKED_BYTES, readZip, writeZip as agentWriteZip } from '../agent/zip';

const MIB = 1024 * 1024;

/** Every entry of an opened archive read, or the first refusal. */
function readAll(bytes: Buffer): { ok: true; entries: Array<[string, Buffer]> } | { ok: false; reason: ArchiveRefusal } {
  const opened = openArchive(bytes, EXCHANGE_ARCHIVE_LIMITS);
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const entries: Array<[string, Buffer]> = [];
  for (const entry of opened.entries) {
    const read = opened.read(entry.name);
    if (!read.ok) return { ok: false, reason: read.reason };
    entries.push([entry.name, read.bytes]);
  }
  return { ok: true, entries };
}

function refusalOf(bytes: Buffer): ArchiveRefusal | undefined {
  const result = readAll(bytes);
  return result.ok ? undefined : result.reason;
}

/** Offsets of the parts of an archive written by writeZip with one entry. */
function parts(archive: Buffer): { central: number; end: number } {
  const end = archive.length - 22;
  return { central: archive.readUInt32LE(end + 16), end };
}

/** One entry with the given compressed bytes and declared sizes, as a hostile sender would write it. */
function rawArchive(entries: Array<{ name: string; data: Buffer; size: number; crc?: number; method?: number; flags?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(entry.method ?? 8, 8);
    local.writeUInt32LE(entry.crc ?? 0, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(entry.method ?? 8, 10);
    central.writeUInt32LE(entry.crc ?? 0, 16); central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A raw deflate stream of `total` zero bytes, made in 1 MiB chunks so the test never holds the unpacked bytes. */
async function deflatedZeros(total: number): Promise<Buffer> {
  const chunk = Buffer.alloc(MIB);
  const chunks: Buffer[] = [];
  const deflater = createDeflateRaw({ level: 9 });
  deflater.on('data', (data: Buffer) => chunks.push(data));
  const done = new Promise<void>((resolve, reject) => { deflater.on('end', resolve); deflater.on('error', reject); });
  Readable.from((function* () { for (let left = total; left > 0; left -= MIB) yield left >= MIB ? chunk : chunk.subarray(0, left); })()).pipe(deflater);
  await done;
  return Buffer.concat(chunks);
}

test('D-31 tracer: a partner archive written by writeZip lists its entries in directory order and reads each against its size and CRC-32', () => {
  const manifest = Buffer.from('{"payload":{"url":"0.payload"}}');
  const payload = Buffer.from('fictional EXAMPLE-ORG payload bytes');
  const archive = writeZip([['manifest.json', manifest], ['0.payload', payload]]);
  const opened = openArchive(archive, EXCHANGE_ARCHIVE_LIMITS);
  assert.equal(opened.ok, true);
  const archiveView = opened as OpenedArchive;
  assert.deepEqual(archiveView.entries.map((entry) => entry.name), ['manifest.json', '0.payload']);
  assert.deepEqual(archiveView.entries.map((entry) => entry.size), [manifest.length, payload.length]);
  const first = archiveView.read('manifest.json');
  assert.ok(first.ok);
  assert.deepEqual(first.bytes, manifest);
  const second = archiveView.read('0.payload');
  assert.ok(second.ok);
  assert.deepEqual(second.bytes, payload);
  const missing = archiveView.read('1.payload');
  assert.deepEqual(missing.ok ? undefined : missing.reason, 'no-such-entry');
});

test('D-31: the exchange limits are the values CONTEXT names, and the Office limits keep the Office tools as they were', () => {
  assert.deepEqual({ ...EXCHANGE_ARCHIVE_LIMITS }, { maxEntries: 4096, maxEntryBytes: 256 * MIB, maxUnpackedBytes: 512 * MIB, maxRatio: 200, checkCrc: true });
  assert.equal(OFFICE_ARCHIVE_LIMITS.maxRatio, undefined, 'the Office tools have no ratio limit');
  assert.ok(Object.isFrozen(EXCHANGE_ARCHIVE_LIMITS) && Object.isFrozen(OFFICE_ARCHIVE_LIMITS) && Object.isFrozen(ARCHIVE_REFUSALS));
  assert.equal(MAX_UNPACKED_BYTES, 50 * MIB, 'the Office read budget is unchanged');
  for (const sentence of Object.values(ARCHIVE_REFUSALS)) assert.match(sentence, /^[A-Z].*\.$/);
});

test('D-31: an archive with more than 4,096 entries is refused from its directory, before anything is unpacked', () => {
  const entries: Array<[string, Buffer]> = [];
  for (let index = 0; index < 4097; index += 1) entries.push([`e${index}`, Buffer.alloc(0)]);
  assert.equal(refusalOf(writeZip(entries)), 'too-many-entries');
  assert.equal(refusalOf(writeZip(entries.slice(0, 4096))), undefined, '4,096 entries are allowed');
});

test('D-31 zip bomb: an entry that inflates past its declared size stops at that size, in under a second and well under the memory cap', async () => {
  const stream = await deflatedZeros(300 * MIB);
  assert.ok(stream.length < 400 * 1024, `the bomb itself is small (${stream.length} bytes)`);
  // Declared small: the ratio and size checks pass on the directory, so only the output cap passed to the inflater stops it.
  const bomb = rawArchive([{ name: '0.payload', data: stream, size: stream.length * 100 }]);
  const before = process.memoryUsage().rss;
  const started = Date.now();
  assert.equal(refusalOf(bomb), 'size-mismatch');
  assert.ok(Date.now() - started < 1000, `refused in ${Date.now() - started} ms`);
  assert.ok(process.memoryUsage().rss - before < 128 * MIB, 'the unpacked bytes were never held');
  // Declared honestly, the same entry is refused from the directory alone.
  const honest = rawArchive([{ name: '0.payload', data: stream, size: 300 * MIB }]);
  assert.equal(refusalOf(honest), 'entry-too-large');
});

test('D-31: a ratio over 200 for one entry is refused from the directory', () => {
  const data = deflateRawSync(Buffer.alloc(10 * MIB));
  assert.ok(10 * MIB / data.length > 200);
  assert.equal(refusalOf(rawArchive([{ name: 'manifest.json', data, size: 10 * MIB, crc: crc32(Buffer.alloc(10 * MIB)) }])), 'ratio-too-high');
  const office = openArchive(rawArchive([{ name: 'manifest.json', data, size: 10 * MIB }]), OFFICE_ARCHIVE_LIMITS);
  assert.equal(office.ok, true, 'the Office limits have no ratio limit');
});

test('D-31: more than 512 MiB unpacked in total is refused from the directory, before any entry is read', () => {
  // Each entry declares 200 MiB at a ratio of 100; the bytes are never inflated, because the declared total already exceeds the limit.
  const filler = Buffer.alloc(2 * MIB + 1);
  const archive = rawArchive([0, 1, 2].map((index) => ({ name: `part${index}`, data: filler, size: 200 * MIB })));
  assert.equal(refusalOf(archive), 'total-too-large');
});

test('D-31: a CRC-32 or a size that does not match the directory is refused', () => {
  const archive = writeZip([['manifest.json', Buffer.from('{"fictional":true}')]]);
  const { central } = parts(archive);
  const wrongCrc = Buffer.from(archive);
  wrongCrc.writeUInt32LE((wrongCrc.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
  assert.equal(refusalOf(wrongCrc), 'crc-mismatch');
  for (const delta of [-1, 1]) {
    const wrongSize = Buffer.from(archive);
    wrongSize.writeUInt32LE(wrongSize.readUInt32LE(central + 24) + delta, central + 24);
    assert.equal(refusalOf(wrongSize), 'size-mismatch', `size ${delta}`);
  }
  const stored = rawArchive([{ name: 'a', data: Buffer.from('abc'), size: 4, method: 0, crc: crc32(Buffer.from('abc')) }]);
  assert.equal(refusalOf(stored), 'size-mismatch', 'a stored entry whose size differs from its bytes');
});

test('D-31: the same name twice is refused', () => {
  assert.equal(refusalOf(writeZip([['manifest.json', Buffer.from('a')], ['manifest.json', Buffer.from('b')]])), 'duplicate-name');
});

test('D-31: absolute, parent-relative and backslashed names are refused', () => {
  for (const name of ['/etc/x', '../x', 'a/../../x', 'a\\b', 'C:x', '', 'a\u0000b']) {
    assert.equal(refusalOf(writeZip([[name, Buffer.from('x')]])), 'unsafe-name', JSON.stringify(name));
  }
  assert.equal(refusalOf(writeZip([['folder/', Buffer.alloc(0)], ['folder/a..b.xml', Buffer.from('x')]])), undefined, 'folders and dots inside a name are fine');
});

test('D-31: an encrypted entry is refused', () => {
  const archive = writeZip([['0.payload', Buffer.from('x')]]);
  const { central } = parts(archive);
  const encrypted = Buffer.from(archive);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  assert.equal(refusalOf(encrypted), 'encrypted');
});

test('D-31: a ZIP64 end record or ZIP64 sizes are refused', () => {
  const archive = writeZip([['0.payload', Buffer.from('x')]]);
  const { end } = parts(archive);
  // A ZIP64 end-of-central-directory locator just before the end record.
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  const withLocator = Buffer.concat([archive.subarray(0, end), locator, archive.subarray(end)]);
  assert.equal(refusalOf(withLocator), 'zip64');
  const counted = Buffer.from(archive);
  counted.writeUInt16LE(0xffff, end + 8); counted.writeUInt16LE(0xffff, end + 10);
  assert.equal(refusalOf(counted), 'zip64');
  const sized = Buffer.from(archive);
  sized.writeUInt32LE(0xffffffff, parts(archive).central + 24);
  assert.equal(refusalOf(sized), 'zip64');
});

test('D-31: a compression method other than stored and deflate is refused', () => {
  const archive = writeZip([['0.payload', Buffer.from('x')]]);
  const patched = Buffer.from(archive);
  patched.writeUInt16LE(12, parts(archive).central + 10);
  assert.equal(refusalOf(patched), 'unsupported-method');
});

test('D-31: a truncated or damaged directory, or no end record, is refused', () => {
  const archive = writeZip([['manifest.json', Buffer.from('{}')], ['0.payload', Buffer.from('x')]]);
  const { central, end } = parts(archive);
  const truncated = Buffer.concat([archive.subarray(0, end - 10), archive.subarray(end)]);
  assert.equal(refusalOf(truncated), 'directory-damaged');
  assert.equal(refusalOf(archive.subarray(0, central + 20)), 'not-an-archive');
  assert.equal(refusalOf(Buffer.from('not a zip at all')), 'not-an-archive');
  const badLocal = Buffer.from(archive);
  badLocal.writeUInt32LE(0, 0);
  assert.equal(refusalOf(badLocal), 'entry-damaged');
});

/** A small deterministic generator (mulberry32), so a failing case can be replayed from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test('D-31 fuzz: 2,000 mutated archives (byte flips, truncations, duplicated directory records) never throw', () => {
  const base = writeZip([['manifest.json', Buffer.from('{"payload":"0.payload","fictional":true}')], ['0.payload', Buffer.alloc(300, 7)], ['notes/a.txt', Buffer.from('EXAMPLE-ORG')]]);
  const { central, end } = parts(base);
  const random = generator(0x45214);
  let cases = 0;
  let refusals = 0;
  for (let index = 0; index < 2000; index += 1) {
    const kind = index % 3;
    let mutated: Buffer;
    if (kind === 0) {
      mutated = Buffer.from(base);
      const flips = 1 + Math.floor(random() * 8);
      for (let flip = 0; flip < flips; flip += 1) mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
    } else if (kind === 1) {
      mutated = base.subarray(0, Math.floor(random() * base.length));
    } else {
      // One directory record copied again, with the end record's count and size raised to match (and sometimes not).
      const record = base.subarray(central, central + 46 + base.readUInt16LE(central + 28));
      const end2 = Buffer.from(base.subarray(end));
      if (random() < 0.7) {
        end2.writeUInt16LE(end2.readUInt16LE(8) + 1, 8); end2.writeUInt16LE(end2.readUInt16LE(10) + 1, 10);
        end2.writeUInt32LE(end2.readUInt32LE(12) + record.length, 12);
      }
      mutated = Buffer.concat([base.subarray(0, end), record, end2]);
      if (random() < 0.5) mutated[central + Math.floor(random() * (mutated.length - central))] ^= 0xff;
    }
    cases += 1;
    let outcome: ReturnType<typeof readAll>;
    assert.doesNotThrow(() => { outcome = readAll(mutated); }, `case ${index}`);
    const result = outcome!;
    if (!result.ok) {
      refusals += 1;
      assert.ok(Object.prototype.hasOwnProperty.call(ARCHIVE_REFUSALS, result.reason), `case ${index}: ${result.reason}`);
    }
  }
  assert.equal(cases, 2000);
  assert.ok(refusals > 1000, `most mutations are refused (${refusals})`);
});

test('D-31: the Office tools keep readZip and writeZip, their 50 MiB budget and their messages, through the one domain reader', () => {
  const docx = agentWriteZip([['word/document.xml', Buffer.from('<w:document/>')], ['word/media/', Buffer.alloc(0)]]);
  assert.deepEqual(docx, writeZip([['word/document.xml', Buffer.from('<w:document/>')], ['word/media/', Buffer.alloc(0)]]), 'one writer');
  const zip = readZip(docx, 'report.docx');
  assert.deepEqual([...zip.keys()], ['word/document.xml', 'word/media/']);
  assert.equal(zip.get('word/document.xml')!().toString('utf8'), '<w:document/>');
  assert.throws(() => readZip(Buffer.from('not a zip at all'), 'broken.xlsx'), /^ToolError: broken\.xlsx is not a valid Office file\.$|broken\.xlsx is not a valid Office file\./);
  const big = readZip(agentWriteZip([['word/document.xml', Buffer.alloc(60 * MIB, 0x20)]]), 'bomb.docx');
  assert.throws(() => big.get('word/document.xml')!(), /bomb\.docx is too large when unpacked \(over 50 MB\)/);
  assert.equal(readZip(agentWriteZip([['ppt/media/v.bin', Buffer.alloc(60 * MIB, 1)]]), 'deck', 200 * MIB).get('ppt/media/v.bin')!().length, 60 * MIB, 'a caller budget still applies');
});

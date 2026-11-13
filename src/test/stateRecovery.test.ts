import assert from 'node:assert/strict';
import test from 'node:test';
import { RECOVERY_CODE_BYTES, RECOVERY_CODE_CHARACTERS, formatRecoveryCode, generateRecoveryCode, parseRecoveryCode } from '../domain/state/recoveryCode';
import {
  KDF_PARAMS, StateRefusalReason, StateRefusedError, aadFor, deriveKek, newDataKey, newSalt, newStateId, sealRaw, subKey, unwrapDataKey, wrapDataKey,
  type KdfRecord, type SealedBlob
} from '../domain/state/keys';
import {
  MAX_OBJECT_ENTRIES, OBJECT_MAGIC, buildManifest, openManifest, openObject, readManifestHeader, sealObject, type ObjectEntry, type OpenPart, type SealedPart
} from '../domain/state/objects';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { fixtureGit } from './helpers/gitFixtures';
import { SIX_TURNS, chain, entryIds, machine, remoteFiles, replaceRemoteTree, syncedPair, treeHash, type Machine } from './helpers/syncFixtures';

function kdfRecord(salt: Buffer): KdfRecord {
  return { name: KDF_PARAMS.name, N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, salt: salt.toString('base64') };
}

test('a recovery code is 256 generated bits shown as 52 characters in 13 groups of 4', () => {
  const { code, bytes } = generateRecoveryCode();
  assert.equal(bytes.length, RECOVERY_CODE_BYTES);
  assert.equal(RECOVERY_CODE_BYTES, 32);
  assert.equal(RECOVERY_CODE_CHARACTERS, 52);
  assert.match(code, /^[01][0-9A-HJKMNP-TV-Z]{3}(-[0-9A-HJKMNP-TV-Z]{4}){12}$/);
  assert.equal(code.split('-').length, 13);
  assert.ok(parseRecoveryCode(code)?.equals(bytes));
  assert.equal(generateRecoveryCode().code === code, false, 'two codes are never the same');
});

test('known vectors: all zero bytes and all one bits', () => {
  assert.equal(formatRecoveryCode(Buffer.alloc(32, 0)), Array(13).fill('0000').join('-'));
  // 256 one-bits sit under 4 zero padding bits: one data bit in the first character, then 51 characters of 31.
  assert.equal(formatRecoveryCode(Buffer.alloc(32, 0xff)), `1ZZZ-${Array(12).fill('ZZZZ').join('-')}`);
});

test('parseRecoveryCode reads the shown form, lowercase, no hyphens, spaces, and I/L/O typed for 1/1/0 as the same 32 bytes', () => {
  const zero = Buffer.alloc(32, 0);
  const ones = Buffer.alloc(32, 0xff);
  for (const bytes of [zero, ones, generateRecoveryCode().bytes]) {
    const shown = formatRecoveryCode(bytes);
    const spellings = [
      shown,
      shown.toLowerCase(),
      shown.replace(/-/g, ''),
      shown.replace(/-/g, ' '),
      `  ${shown}  `,
      shown.replace(/1/g, 'I').replace(/0/g, 'O'),
      shown.replace(/1/g, 'l').replace(/0/g, 'o')
    ];
    for (const spelling of spellings) assert.ok(parseRecoveryCode(spelling)?.equals(bytes), `spelling ${spelling}`);
  }
});

test('tracer: code to key-encryption key to wrapped data key to sealed object to manifest and back', async () => {
  // Machine A: turn sync on.
  const { code, bytes } = generateRecoveryCode();
  const stateId = newStateId();
  const salt = newSalt();
  const kdf = kdfRecord(salt);
  const kek = await deriveKek(bytes, salt, kdf);
  const dataKey = newDataKey();
  const wrappedKey = wrapDataKey(kek, dataKey, stateId);
  const payload = { threads: [{ id: 'conv-abc123', title: 'Plan the release', turns: [{ role: 'user', text: 'hello' }] }] };
  const parts = sealObject(dataKey, stateId, 'hot', payload);
  const manifestText = buildManifest({ stateId, kdf, wrappedKey, dataKey, seq: 1, objects: parts.map((part) => part.entry), indexFile: null });

  // Nothing readable is in the plaintext manifest or in the object names.
  assert.doesNotMatch(manifestText, /conv-abc123|Plan the release|hello|threads/);
  for (const part of parts) assert.match(part.entry.file, /^[0-9a-f]{32}\.bin$/);

  // Machine B: only the typed code and the files.
  const typed = parseRecoveryCode(code.toLowerCase().replace(/-/g, ' '));
  assert.ok(typed);
  const header = readManifestHeader(manifestText);
  const kekB = await deriveKek(typed, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
  const dataKeyB = unwrapDataKey(kekB, header.wrappedKey, header.stateId);
  assert.ok(dataKeyB.equals(dataKey));
  const opened = openManifest(manifestText, dataKeyB, 0);
  assert.equal(opened.seq, 1);
  assert.equal(opened.objects.length, 1);
  const stored = new Map(parts.map((part) => [part.entry.file, part.data]));
  const openParts: OpenPart[] = opened.objects.map((entry) => ({ entry, data: stored.get(entry.file) }));
  assert.deepEqual(openObject(dataKeyB, header.stateId, 'hot', openParts), payload);
});

test('a different valid code fails to unwrap with one plain refusal', async () => {
  const stateId = newStateId();
  const salt = newSalt();
  const kdf = kdfRecord(salt);
  const dataKey = newDataKey();
  const wrappedKey = wrapDataKey(await deriveKek(generateRecoveryCode().bytes, salt, kdf), dataKey, stateId);
  const wrongKek = await deriveKek(generateRecoveryCode().bytes, salt, kdf);
  assert.throws(() => unwrapDataKey(wrongKek, wrappedKey, stateId), (error: unknown) => error instanceof StateRefusedError && error.reason === 'wrong-code-or-damaged');
});

// ---- Every refusal (Task 3). One key derivation is shared by the tests below so the file stays light on memory. ----

interface Fixture {
  bytes: Buffer;
  stateId: string;
  kdf: KdfRecord;
  kek: Buffer;
  dataKey: Buffer;
  wrappedKey: SealedBlob;
  parts: SealedPart[];
  manifest: string;
}

let shared: Promise<Fixture> | undefined;
function fixture(): Promise<Fixture> {
  shared ??= (async (): Promise<Fixture> => {
    const bytes = generateRecoveryCode().bytes;
    const stateId = newStateId();
    const salt = newSalt();
    const kdf = kdfRecord(salt);
    const kek = await deriveKek(bytes, salt, kdf);
    const dataKey = newDataKey();
    const wrappedKey = wrapDataKey(kek, dataKey, stateId);
    const parts = sealObject(dataKey, stateId, 'hot', { threads: ['one', 'two'] });
    const manifest = buildManifest({ stateId, kdf, wrappedKey, dataKey, seq: 4, objects: parts.map((part) => part.entry), indexFile: null });
    return { bytes, stateId, kdf, kek, dataKey, wrappedKey, parts, manifest };
  })();
  return shared;
}

function refusedWith(reason: StateRefusalReason): (error: unknown) => boolean {
  return (error: unknown) => error instanceof StateRefusedError && error.reason === reason;
}

function flipByte(bytes: Buffer, index = Math.floor(bytes.length / 2)): Buffer {
  const copy = Buffer.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

function flipBase64(text: string): string { return flipByte(Buffer.from(text, 'base64')).toString('base64'); }

function editManifest(text: string, edit: (header: Record<string, unknown>) => void): string {
  const header = JSON.parse(text) as Record<string, unknown>;
  edit(header);
  return `${JSON.stringify(header)}\n`;
}

function openAll(f: Fixture, parts: readonly OpenPart[]): unknown {
  return openObject(f.dataKey, f.stateId, 'hot', parts);
}

function asOpen(parts: readonly SealedPart[]): OpenPart[] { return parts.map((part) => ({ entry: part.entry, data: part.data })); }

test('an empty, whitespace-only, short, long or foreign-character code parses to undefined', () => {
  const shown = formatRecoveryCode(Buffer.alloc(32, 7));
  for (const bad of ['', '   ', '\n\t', shown.replace(/-/g, '').slice(1), shown.replace(/-/g, '').slice(2), shown + '0', shown.replace(/-/g, '').slice(0, 32), `U${shown.slice(1)}`, `${shown.slice(0, 5)}#${shown.slice(6)}`]) {
    assert.equal(parseRecoveryCode(bad), undefined, JSON.stringify(bad));
  }
});

test('a code whose 4 leading padding bits are not zero is refused like a wrong code', () => {
  const shown = formatRecoveryCode(Buffer.alloc(32, 7)).replace(/-/g, '');
  assert.equal(shown.charAt(0), '0');
  for (const first of ['2', '8', 'G', 'Z']) assert.equal(parseRecoveryCode(first + shown.slice(1)), undefined, first);
  assert.ok(parseRecoveryCode('1' + shown.slice(1)), 'a 1 in front is a data bit, not padding');
  assert.equal(new StateRefusedError('wrong-code-or-damaged').message, 'That recovery code is not right, or the saved state is damaged. Nothing was changed.');
});

test('a flipped byte in the wrapped key is wrong-code-or-damaged, and the right code unwraps', async () => {
  const f = await fixture();
  assert.ok(unwrapDataKey(f.kek, f.wrappedKey, f.stateId).equals(f.dataKey));
  assert.throws(() => unwrapDataKey(f.kek, { ...f.wrappedKey, data: flipBase64(f.wrappedKey.data) }, f.stateId), refusedWith('wrong-code-or-damaged'));
  assert.throws(() => unwrapDataKey(f.kek, f.wrappedKey, newStateId()), refusedWith('wrong-code-or-damaged'));
});

test('a flipped byte in the sealed manifest is tampered', async () => {
  const f = await fixture();
  const text = editManifest(f.manifest, (header) => { const sealed = header.sealed as SealedBlob; sealed.data = flipBase64(sealed.data); });
  assert.throws(() => openManifest(text, f.dataKey, 0), refusedWith('tampered'));
  const wrongKey = newDataKey();
  assert.throws(() => openManifest(f.manifest, wrongKey, 0), refusedWith('tampered'));
});

test('a flipped object byte is tampered, with or without the listed hash being rewritten', async () => {
  const f = await fixture();
  const [part] = f.parts as [SealedPart];
  const bad = flipByte(part.data, part.data.length - 5);
  assert.throws(() => openAll(f, [{ entry: part.entry, data: bad }]), refusedWith('tampered'));
  // An attacker who also rewrote the listed hash still meets the authentication tag.
  const rewritten: ObjectEntry = { ...part.entry, sha256: createHash('sha256').update(bad).digest('hex') };
  assert.throws(() => openAll(f, [{ entry: rewritten, data: bad }]), refusedWith('tampered'));
});

test('an object cut short is truncated, detected before decryption', async () => {
  const f = await fixture();
  const [part] = f.parts as [SealedPart];
  assert.throws(() => openAll(f, [{ entry: part.entry, data: part.data.subarray(0, part.data.length - 100) }]), refusedWith('truncated'));
  assert.throws(() => openAll(f, [{ entry: part.entry, data: part.data.subarray(0, 10) }]), refusedWith('truncated'));
});

test('an object whose length prefix claims more than it holds is truncated', async () => {
  const f = await fixture();
  const framed = Buffer.alloc(70_000, 1);
  framed.writeUInt32BE(5_000_000, 0);
  const salt = newSalt();
  const sealed = sealRaw(subKey(f.dataKey, 'object', salt), framed, aadFor(f.stateId, 'hot', 0, 1));
  const data = Buffer.concat([OBJECT_MAGIC, Buffer.from([1]), salt, sealed.iv, sealed.tag, sealed.data]);
  const entry: ObjectEntry = { file: `${'a'.repeat(32)}.bin`, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), class: 'hot', part: 0, of: 1 };
  assert.throws(() => openAll(f, [{ entry, data }]), refusedWith('truncated'));
});

test('an object listed in the manifest but absent is missing-object', async () => {
  const f = await fixture();
  const [part] = f.parts as [SealedPart];
  assert.throws(() => openAll(f, [{ entry: part.entry, data: undefined }]), refusedWith('missing-object'));
  assert.throws(() => openAll(f, []), refusedWith('missing-object'));
});

test('a manifest older than the last one seen is rolled-back; the same or newer is fine', async () => {
  const f = await fixture();
  assert.throws(() => openManifest(f.manifest, f.dataKey, 5), refusedWith('rolled-back'));
  assert.equal(openManifest(f.manifest, f.dataKey, 4).seq, 4);
  assert.equal(openManifest(f.manifest, f.dataKey, 0).seq, 4);
});

test('a format 2 manifest, an extra plaintext key, a bad state id, junk and oversize text are unsupported-format', async () => {
  const f = await fixture();
  const cases = [
    editManifest(f.manifest, (header) => { header.format = 2; }),
    editManifest(f.manifest, (header) => { header.title = 'My private chat'; }),
    editManifest(f.manifest, (header) => { header.stateId = 'Has Spaces And Capitals'; }),
    editManifest(f.manifest, (header) => { delete header.wrappedKey; }),
    editManifest(f.manifest, (header) => { (header.kdf as Record<string, unknown>).extra = 1; }),
    editManifest(f.manifest, (header) => { (header.sealed as Record<string, unknown>).extra = 'x'; }),
    'not json',
    '[]',
    `${f.manifest}${' '.repeat(1024 * 1024)}`
  ];
  for (const text of cases) assert.throws(() => openManifest(text, f.dataKey, 0), refusedWith('unsupported-format'));
});

test('a kdf record that asks for a huge or tiny cost is refused before any scrypt call', async () => {
  const f = await fixture();
  const hostile = (patch: Record<string, unknown>): string => editManifest(f.manifest, (header) => { Object.assign(header.kdf as Record<string, unknown>, patch); });
  for (const patch of [{ N: 2 ** 30 }, { N: 2 ** 21 }, { N: 2 ** 13 }, { N: 3 * 2 ** 14 }, { r: 64 }, { p: 99 }, { name: 'argon2id' }, { N: 'big' }]) {
    assert.throws(() => readManifestHeader(hostile(patch)), refusedWith('unsupported-format'), JSON.stringify(patch));
  }
  // If the bound were missing, this record would run a 256 MiB scrypt for seconds and resolve instead of refusing.
  await assert.rejects(deriveKek(f.bytes, newSalt(), { name: 'scrypt', N: 2 ** 21, r: 1, p: 1 }), refusedWith('unsupported-format'));
  await assert.rejects(deriveKek(f.bytes, newSalt(), { name: 'scrypt', N: 2 ** 30, r: 8, p: 1 }), refusedWith('unsupported-format'));
});

test('an empty object list builds and opens as a valid manifest with zero objects', async () => {
  const f = await fixture();
  const text = buildManifest({ stateId: f.stateId, kdf: f.kdf, wrappedKey: f.wrappedKey, dataKey: f.dataKey, seq: 1, objects: [], indexFile: null });
  const opened = openManifest(text, f.dataKey, 0);
  assert.deepEqual(opened.objects, []);
  assert.equal(opened.indexFile, null);
});

test('manifest entries are checked: bad names, classes, positions, sizes and counts are refused', async () => {
  const f = await fixture();
  const [part] = f.parts as [SealedPart];
  const build = (objects: unknown[], indexFile: string | null = null): string =>
    buildManifest({ stateId: f.stateId, kdf: f.kdf, wrappedKey: f.wrappedKey, dataKey: f.dataKey, seq: 1, objects: objects as ObjectEntry[], indexFile });
  const good = part.entry;
  assert.equal(openManifest(build([good], good.file), f.dataKey, 0).objects.length, 1);
  const bad: unknown[][] = [
    [{ ...good, file: '../escape.bin' }],
    [{ ...good, file: 'My Chat.bin' }],
    [{ ...good, class: 'secret' }],
    [{ ...good, part: 1, of: 1 }],
    [{ ...good, bytes: 9 * 1024 * 1024 }],
    [{ ...good, sha256: 'xyz' }],
    [{ ...good, extra: 'title' }],
    [good, good],
    Array.from({ length: MAX_OBJECT_ENTRIES + 1 }, (_, index) => ({ ...good, file: `${index.toString(16).padStart(32, '0')}.bin` }))
  ];
  for (const objects of bad) assert.throws(() => openManifest(build(objects), f.dataKey, 0), refusedWith('unsupported-format'));
  assert.throws(() => openManifest(build([good], `${'b'.repeat(32)}.bin`), f.dataKey, 0), refusedWith('unsupported-format'));
});

test('no thread title, record id, model name or prompt appears in the plaintext manifest or an object name', async () => {
  const stateId = newStateId();
  const dataKey = newDataKey();
  const salt = newSalt();
  const kdf = kdfRecord(salt);
  const secretText = 'Quarterly layoff plan for conv-9f8e7d with model near-ai/deepseek and the prompt "ignore all previous"';
  const parts = sealObject(dataKey, stateId, 'cold', { title: secretText, id: 'conv-9f8e7d' });
  const text = buildManifest({ stateId, kdf, wrappedKey: wrapDataKey(newDataKey(), dataKey, stateId), dataKey, seq: 1, objects: parts.map((part) => part.entry), indexFile: parts[0]?.entry.file ?? null });
  assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), ['format', 'kdf', 'sealed', 'stateId', 'wrappedKey']);
  for (const word of ['layoff', 'conv-9f8e7d', 'deepseek', 'ignore all', 'cold', 'hot']) assert.equal(text.includes(word), false, word);
  for (const part of parts) {
    assert.match(part.entry.file, /^[0-9a-f]{32}\.bin$/);
    assert.equal(part.data.includes(Buffer.from('layoff')), false);
  }
});

// ---- Phase 27, plan 12 (SYNC-04, D-09): a remote that fails verification changes nothing here -------------------------------------------------

const FIRST = 'conv-recovery01';
const SECOND = 'conv-recovery02';
const STATE_REF_NAME = 'refs/heads/near-ai/state';
const tip = (remote: string): string => fixtureGit(remote, ['rev-parse', STATE_REF_NAME]).trim();

/** A and B in step, then A pushes a second thread that B has not pulled yet. The tip before that push is returned for the rollback case. */
async function arranged(): Promise<{ remote: string; a: Machine; b: Machine; earlier: string }> {
  const pair = await syncedPair(FIRST);
  const earlier = tip(pair.remote);
  await pair.a.threads.create({ id: SECOND, title: 'Second', model: 'm', origin: 'panel' });
  await pair.a.threads.appendEntries(SECOND, chain(SECOND, pair.a.writer, SIX_TURNS));
  const pushed = await pair.a.sync.sync();
  assert.equal(pushed.pushed, true, pushed.message);
  return { remote: pair.remote, a: pair.a, b: pair.b, earlier };
}

async function assertRefusedUntouched(b: Machine, expected: RegExp): Promise<void> {
  const before = treeHash(b.home.dir);
  const outcome = await b.sync.sync();
  assert.equal(outcome.kind, 'refused', outcome.message);
  assert.match(outcome.message, expected);
  assert.match(outcome.message, /Nothing was changed\./);
  assert.equal(treeHash(b.home.dir), before, 'every file path and byte of the state home is as it was');
}

async function manifestOf(remote: string, a: Machine) {
  const dataKey = await a.keys.dataKey();
  assert.ok(dataKey);
  const files = remoteFiles(remote);
  const text = (files.get('manifest.json') ?? Buffer.alloc(0)).toString('utf8');
  return { dataKey, files, text, manifest: openManifest(text, dataKey, 0) };
}

test('a manifest with one flipped byte is refused and the state home is byte-identical', async () => {
  const { remote, b } = await arranged();
  const files = remoteFiles(remote);
  const header = JSON.parse((files.get('manifest.json') ?? Buffer.alloc(0)).toString('utf8')) as { sealed: { data: string } };
  header.sealed.data = `${header.sealed.data.startsWith('A') ? 'B' : 'A'}${header.sealed.data.slice(1)}`;
  files.set('manifest.json', Buffer.from(`${JSON.stringify(header)}\n`));
  replaceRemoteTree(remote, files);
  await assertRefusedUntouched(b, /changed or is damaged/);
});

test('an object cut short is refused and the state home is byte-identical', async () => {
  const { remote, a, b } = await arranged();
  const { files, manifest } = await manifestOf(remote, a);
  const hot = manifest.objects.filter((entry) => entry.class === 'hot').at(-1);
  assert.ok(hot);
  const bytes = files.get(hot.file) ?? Buffer.alloc(0);
  files.set(hot.file, bytes.subarray(0, Math.floor(bytes.length / 2)));
  replaceRemoteTree(remote, files);
  await assertRefusedUntouched(b, /cut short/);
});

test('a listed object missing from the tree is refused and the state home is byte-identical', async () => {
  const { remote, a, b } = await arranged();
  const { files, manifest } = await manifestOf(remote, a);
  const hot = manifest.objects.filter((entry) => entry.class === 'hot').at(-1);
  assert.ok(hot);
  files.delete(hot.file);
  replaceRemoteTree(remote, files);
  await assertRefusedUntouched(b, /missing/);
});

test('an older valid tree (a lower sequence number than one already seen) is refused and the state home is byte-identical', async () => {
  const { remote, b, earlier } = await arranged();
  assert.equal((await b.sync.sync()).kind, 'synced', 'B sees the newer state first');
  fixtureGit(remote, ['update-ref', STATE_REF_NAME, earlier]);
  await assertRefusedUntouched(b, /older than one this computer has already seen/);
});

test('a bundle sealed for another project (another state id), with or without objects, is refused and the state home is byte-identical', async () => {
  const { remote, a, b } = await arranged();
  const { dataKey, text } = await manifestOf(remote, a);
  const header = readManifestHeader(text);
  const foreignId = newStateId();
  const empty = new Map<string, Buffer>([['manifest.json', Buffer.from(buildManifest({ stateId: foreignId, kdf: header.kdf, wrappedKey: header.wrappedKey, dataKey, seq: 9, objects: [], indexFile: null }))]]);
  replaceRemoteTree(remote, empty);
  await assertRefusedUntouched(b, /changed or is damaged/);
  const parts = sealObject(dataKey, foreignId, 'hot', { v: 1, entries: {}, records: [] });
  const withObjects = new Map<string, Buffer>([['manifest.json', Buffer.from(buildManifest({ stateId: foreignId, kdf: header.kdf, wrappedKey: header.wrappedKey, dataKey, seq: 10, objects: parts.map((part) => part.entry), indexFile: null }))]]);
  for (const part of parts) withObjects.set(part.entry.file, part.data);
  replaceRemoteTree(remote, withObjects);
  await assertRefusedUntouched(b, /changed or is damaged/);
});

test('a manifest that leaves out the object an authentic index says is there is refused and the state home is byte-identical', async () => {
  const { remote, a, b } = await arranged();
  const { dataKey, files, text, manifest } = await manifestOf(remote, a);
  const header = readManifestHeader(text);
  const hot = manifest.objects.filter((entry) => entry.class === 'hot').at(-1);
  assert.ok(hot);
  files.set('manifest.json', Buffer.from(buildManifest({
    stateId: header.stateId, kdf: header.kdf, wrappedKey: header.wrappedKey, dataKey, seq: manifest.seq + 1,
    objects: manifest.objects.filter((entry) => entry.file !== hot.file), indexFile: manifest.indexFile
  })));
  replaceRemoteTree(remote, files);
  await assertRefusedUntouched(b, /missing/);
});

test('the wrong recovery code on a fresh computer creates no state home, and a sync before opening the project creates none either', async () => {
  const { remote } = await arranged();
  const fresh = await machine(remote, 'charlie');
  const wrong = generateRecoveryCode().bytes;
  const refused = await fresh.sync.unlockFromRemote(wrong);
  assert.equal(refused.kind, 'refused');
  assert.match(refused.message, /recovery code is not right/);
  assert.equal(await stat(fresh.home.dir).then(() => true, () => false), false, 'no state home folder was made');
  const early = await fresh.sync.sync();
  assert.equal(early.kind, 'refused');
  assert.match(early.message, /locked/);
  assert.equal(await stat(fresh.home.dir).then(() => true, () => false), false);
});

test('after a refusal a later valid push is accepted and the earlier refusal changed nothing', async () => {
  const { remote, a, b } = await arranged();
  const good = tip(remote);
  const { files } = await manifestOf(remote, a);
  files.set('manifest.json', Buffer.from('{"format":1}\n'));
  replaceRemoteTree(remote, files);
  const before = treeHash(b.home.dir);
  assert.equal((await b.sync.sync()).kind, 'refused');
  assert.equal(treeHash(b.home.dir), before);
  // The owner undoes the damage on the remote; A saves something new; B takes it.
  fixtureGit(remote, ['update-ref', STATE_REF_NAME, good]);
  await a.threads.create({ id: 'conv-recovery03', title: 'Third', model: 'm', origin: 'panel' });
  await a.threads.appendEntries('conv-recovery03', chain('conv-recovery03', a.writer, SIX_TURNS));
  assert.equal((await a.sync.sync()).pushed, true);
  const accepted = await b.sync.sync();
  assert.equal(accepted.kind, 'synced', accepted.message);
  assert.equal((await entryIds(b, 'conv-recovery03')).length, 6);
  assert.equal((await entryIds(b, SECOND)).length, 6);
});

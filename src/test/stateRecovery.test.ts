import assert from 'node:assert/strict';
import test from 'node:test';
import { RECOVERY_CODE_BYTES, RECOVERY_CODE_CHARACTERS, formatRecoveryCode, generateRecoveryCode, parseRecoveryCode } from '../domain/state/recoveryCode';
import {
  KDF_PARAMS, StateRefusedError, deriveKek, newDataKey, newSalt, newStateId, unwrapDataKey, wrapDataKey, type KdfRecord
} from '../domain/state/keys';
import { buildManifest, openManifest, openObject, readManifestHeader, sealObject, type OpenPart } from '../domain/state/objects';

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

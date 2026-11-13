import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { StateRefusedError, newDataKey, newStateId } from '../domain/state/keys';
import {
  MAX_PART_BYTES, MIN_PADDED_BYTES, OBJECT_HEADER_BYTES, openObject, padmeLength, sealObject, type ObjectEntry, type OpenPart, type SealedPart
} from '../domain/state/objects';

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function asOpen(parts: readonly SealedPart[]): OpenPart[] { return parts.map((part) => ({ entry: part.entry, data: part.data })); }

function refusedAs(reason: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof StateRefusedError && error.reason === reason;
}

function compressedLength(payload: unknown): number {
  return brotliCompressSync(Buffer.from(JSON.stringify(payload), 'utf8'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }).length;
}

// Deterministic, hard-to-compress text of a chosen size (a seeded generator, so the compressed length is the same on every run).
function noise(characters: number, seed: number): string {
  const next = seeded(seed);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let text = '';
  for (let index = 0; index < characters; index += 1) text += alphabet.charAt(Math.floor(next() * alphabet.length));
  return text;
}

test('padmeLength never shrinks, stays within 12.5% above the 64 KiB floor, and lands on 8 buckets per octave', () => {
  const next = seeded(27);
  assert.equal(padmeLength(0), MIN_PADDED_BYTES);
  assert.equal(padmeLength(1), MIN_PADDED_BYTES);
  assert.equal(padmeLength(MIN_PADDED_BYTES), MIN_PADDED_BYTES);
  for (let index = 0; index < 200; index += 1) {
    const length = Math.floor(1024 + next() * (20 * 1024 * 1024 - 1024));
    const padded = padmeLength(length);
    assert.ok(padded >= length, `${length} padded to ${padded}`);
    assert.ok(padded <= Math.max(length * 1.125, MIN_PADDED_BYTES), `${length} padded to ${padded}`);
    if (length > MIN_PADDED_BYTES) assert.equal(padded % 2 ** (Math.floor(Math.log2(length)) - 3), 0);
  }
  assert.equal(padmeLength(MAX_PART_BYTES), MAX_PART_BYTES);
});

test('two payloads whose compressed lengths fall in one bucket produce objects of identical byte length', () => {
  const dataKey = newDataKey();
  const stateId = newStateId();
  // Small payloads share the 64 KiB floor; two larger ones share one 16 KiB bucket (checked, so a bad fixture fails loudly).
  const small = [{ a: 'x' }, { a: noise(2_000, 1) }];
  const larger = [{ a: noise(150_000, 2) }, { a: noise(150_400, 3) }];
  for (const pair of [small, larger]) {
    const buckets = pair.map((payload) => padmeLength(4 + compressedLength(payload)));
    assert.equal(buckets[0], buckets[1], 'fixture must fall in one bucket');
    const lengths = pair.map((payload) => sealObject(dataKey, stateId, 'hot', payload).map((part) => part.data.length));
    assert.deepEqual(lengths[0], lengths[1]);
    assert.deepEqual(lengths[0], [OBJECT_HEADER_BYTES + (buckets[0] as number)]);
  }
});

test('a payload over 8 MiB compressed is split into parts, none above 8 MiB plus the envelope, and opens whole', () => {
  const dataKey = newDataKey();
  const stateId = newStateId();
  // Random bytes as base64 stay about as large after brotli: about 19 MiB compressed, so 3 parts of at most 8 MiB.
  const payload = { blob: randomBytes(19 * 1024 * 1024).toString('base64') };
  const parts = sealObject(dataKey, stateId, 'cold', payload);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((part) => part.entry.part), [0, 1, 2]);
  assert.ok(parts.every((part) => part.entry.of === 3 && part.entry.class === 'cold'));
  for (const part of parts) {
    assert.ok(part.data.length <= MAX_PART_BYTES + OBJECT_HEADER_BYTES, `part of ${part.data.length} bytes`);
    assert.equal(part.entry.bytes, part.data.length);
  }
  assert.deepEqual(openObject(dataKey, stateId, 'cold', asOpen(parts).reverse()), payload);
  // Moving a part to another position breaks its authenticated position.
  const swapped: OpenPart[] = asOpen(parts).map((part, index, all) => ({ ...part, entry: { ...part.entry, part: ((all[(index + 1) % 3] as OpenPart).entry.part) } }));
  assert.throws(() => openObject(dataKey, stateId, 'cold', swapped), refusedAs('tampered'));
});

test('an object sealed for one project does not open for another, and a hot object does not open as cold', () => {
  const dataKey = newDataKey();
  const stateA = newStateId();
  const stateB = newStateId();
  const payload = { note: 'only for A' };
  const parts = sealObject(dataKey, stateA, 'hot', payload);
  assert.deepEqual(openObject(dataKey, stateA, 'hot', asOpen(parts)), payload);
  assert.throws(() => openObject(dataKey, stateB, 'hot', asOpen(parts)), refusedAs('tampered'));
  // Listing it as cold in the entry does not help: the class is part of what was authenticated.
  const relabelled: OpenPart[] = parts.map((part) => ({ entry: { ...part.entry, class: 'cold' as ObjectEntry['class'] }, data: part.data }));
  assert.throws(() => openObject(dataKey, stateA, 'cold', relabelled), refusedAs('tampered'));
  assert.throws(() => openObject(dataKey, stateA, 'cold', asOpen(parts)), refusedAs('tampered'));
  assert.throws(() => openObject(newDataKey(), stateA, 'hot', asOpen(parts)), refusedAs('tampered'));
});

test('two seals of one payload use different object salts, IVs and file names', () => {
  const dataKey = newDataKey();
  const stateId = newStateId();
  const payload = { same: 'payload' };
  const [first] = sealObject(dataKey, stateId, 'hot', payload) as [SealedPart];
  const [second] = sealObject(dataKey, stateId, 'hot', payload) as [SealedPart];
  const salt = (part: SealedPart): string => part.data.subarray(5, 21).toString('hex');
  const iv = (part: SealedPart): string => part.data.subarray(21, 33).toString('hex');
  assert.notEqual(salt(first), salt(second));
  assert.notEqual(iv(first), iv(second));
  assert.notEqual(first.entry.file, second.entry.file);
  assert.notEqual(first.entry.sha256, second.entry.sha256);
  assert.equal(first.data.subarray(0, 5).toString('latin1'), 'NAS1\u0001');
});

test('an empty payload and an empty list seal and open', () => {
  const dataKey = newDataKey();
  const stateId = newStateId();
  assert.deepEqual(openObject(dataKey, stateId, 'index', asOpen(sealObject(dataKey, stateId, 'index', []))), []);
  assert.deepEqual(openObject(dataKey, stateId, 'index', asOpen(sealObject(dataKey, stateId, 'index', {}))), {});
});

test('padding and part limits are measured in bytes of the compressed UTF-8 JSON, not in characters', () => {
  const dataKey = newDataKey();
  const stateId = newStateId();
  // 30 000 three-byte characters are 90 000 UTF-8 bytes before compression; the object size follows the compressed bytes only.
  const payload = { text: noise(1, 1) + '€'.repeat(30_000) };
  const [part] = sealObject(dataKey, stateId, 'hot', payload) as [SealedPart];
  assert.equal(part.data.length, OBJECT_HEADER_BYTES + padmeLength(4 + compressedLength(payload)));
  assert.deepEqual(openObject(dataKey, stateId, 'hot', asOpen([part])), payload);
});

// Frozen vectors for the canonical JSON form (D-06). Changing any expectation here invalidates every stored event.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import test from 'node:test';
import {
  CanonicalJsonError, MAX_DEPTH, MAX_EVENT_BYTES, canonicalBytes, canonicalize, eventPath, fingerprintOf, isStrictBase64url,
  signingInput, snapshotPath, verifyEventSignature, verifySignature
} from '../domain/team/canonical';
import type { TeamEvent } from '../domain/team/types';

function nested(levels: number): unknown {
  let value: unknown = [];
  for (let level = 1; level < levels; level += 1) value = [value];
  return value;
}

test('canonical JSON sorts keys by UTF-16 code unit and emits no whitespace', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  const sorted = canonicalize({ 'ﬁ': 1, '😀': 2, 'é': 3, b: 4, a: 5, Z: 6 });
  assert.equal(sorted, '{"Z":6,"a":5,"b":4,"é":3,"😀":2,"ﬁ":1}', 'U+D83D (surrogate pair) sorts before U+FB01');
  assert.equal(canonicalize({}), '{}');
  assert.equal(canonicalize([]), '[]');
  assert.equal(canonicalize({ z: { b: [], a: {} }, y: -7, x: 0 }), '{"x":0,"y":-7,"z":{"a":{},"b":[]}}');
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(false), 'false');
  assert.equal(canonicalBytes({ a: 'é' }).toString('hex'), Buffer.from('{"a":"é"}', 'utf8').toString('hex'));
});

test('strings use standard JSON escaping and keep non-ASCII text as is', () => {
  assert.equal(canonicalize('quote " slash \\ tab \t newline \n bell \u0007'), '"quote \\" slash \\\\ tab \\t newline \\n bell \\u0007"');
  assert.equal(canonicalize('  '), '"  "');
  assert.equal(canonicalize('日本語 😀'), '"日本語 😀"');
  assert.equal(canonicalize(Number.MAX_SAFE_INTEGER), '9007199254740991');
  assert.equal(canonicalize(Number.MIN_SAFE_INTEGER), '-9007199254740991');
});

test('values that could change meaning between platforms are rejected', () => {
  class Custom { public readonly value = 1; }
  const sparse = [1, , 3];
  const rejected: Array<[string, unknown]> = [
    ['float', 1.5], ['negative zero', -0], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['unsafe integer', 2 ** 53],
    ['undefined value', { a: undefined }], ['top-level undefined', undefined], ['function', (): number => 1], ['bigint', BigInt(1)], ['symbol', Symbol('s')],
    ['Date', new Date(0)], ['Map', new Map([['a', 1]])], ['Set', new Set([1])], ['class instance', new Custom()], ['sparse array', sparse],
    ['lone high surrogate in a value', { a: '\uD800' }], ['lone low surrogate in a value', ['\uDC00']], ['lone surrogate in a key', { '\uD800': 1 }],
    ['nesting depth 17', nested(MAX_DEPTH + 1)]
  ];
  for (const [label, value] of rejected) {
    assert.throws(() => canonicalize(value), CanonicalJsonError, label);
  }
  assert.throws(() => canonicalize({ a: { b: 1.25 } }), /\$\.a\.b: numbers must be safe integers/);
});

test('nesting up to the depth limit is accepted and the limit is 16', () => {
  assert.equal(MAX_DEPTH, 16);
  assert.equal(canonicalize(nested(16)), `${'['.repeat(16)}${']'.repeat(16)}`);
  assert.equal(canonicalize(JSON.parse(canonicalize(nested(16)))), canonicalize(nested(16)));
  assert.doesNotThrow(() => canonicalize({ a: nested(15) }));
  assert.throws(() => canonicalize({ a: nested(16) }), CanonicalJsonError);
});

test('canonical text is stable across a parse and re-canonicalise round trip', () => {
  const fixture = {
    text: 'ünïcødé 😀 \u0000 \u001f " \\ /', list: [[], {}, [{}], [[]], 0, -1, 9007199254740991], empty: '', nothing: null,
    deep: { c: { b: { a: ['z', 'y', { k: true, j: false }] } } }, keys: { 'with space': 1, '': 2, 'ключ': 3, '😀': 4 }
  };
  const once = canonicalize(fixture);
  assert.equal(canonicalize(JSON.parse(once)), once);
  assert.equal(JSON.parse(once).text, fixture.text);
});

test('a duplicate key in file text cannot be canonical because parsing keeps only the last value', () => {
  const text = '{"a":1,"a":2}';
  assert.notEqual(canonicalize(JSON.parse(text)), text);
  const proto = JSON.parse('{"__proto__":{"x":1}}');
  assert.equal(canonicalize(proto), '{"__proto__":{"x":1}}');
});

test('event and snapshot file names zero-pad the lamport to twelve digits', () => {
  assert.equal(eventPath({ lamport: 7, id: 'evt-01ARZ3NDEKTSV4RRFFQ69G5FAV' }), 'events/000000000007-evt-01ARZ3NDEKTSV4RRFFQ69G5FAV.json');
  assert.equal(eventPath({ lamport: 999999999999, id: 'evt-x' }), 'events/999999999999-evt-x.json');
  assert.equal(snapshotPath(500), 'snapshots/000000000500.json');
  for (const bad of [-1, 1.5, 1_000_000_000_000, Number.NaN]) {
    assert.throws(() => eventPath({ lamport: bad, id: 'evt-x' }), RangeError);
    assert.throws(() => snapshotPath(bad), RangeError);
  }
});

test('strict base64url checks length, alphabet, padding and trailing bits', () => {
  const raw = Buffer.alloc(32, 7);
  const encoded = raw.toString('base64url');
  assert.equal(encoded.length, 43);
  assert.equal(isStrictBase64url(encoded, 32), true);
  assert.equal(isStrictBase64url(`${encoded}=`, 32), false, 'padding');
  assert.equal(isStrictBase64url(encoded.slice(0, 42), 32), false, 'short');
  assert.equal(isStrictBase64url(`${encoded}A`, 32), false, 'long');
  assert.equal(isStrictBase64url(`${encoded.slice(0, 42)}+`, 32), false, 'standard alphabet');
  assert.equal(isStrictBase64url(`${encoded.slice(0, 42)}/`, 32), false, 'standard alphabet');
  assert.equal(isStrictBase64url(`${encoded.slice(0, 42)} `, 32), false, 'whitespace');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const spare = encoded.slice(0, 42) + (alphabet[alphabet.indexOf(encoded.slice(42)) | 1] as string);
  assert.deepEqual(Buffer.from(spare, 'base64url'), raw, 'the lenient decoder reads the same bytes');
  assert.equal(isStrictBase64url(spare, 32), false, 'non-canonical trailing bits');
  assert.equal(isStrictBase64url('', 0), true);
  assert.equal(isStrictBase64url(encoded, -1), false);
});

test('a fingerprint is dev- plus the first 32 hex characters of the SHA-256 of the raw public key', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  assert.equal(raw.length, 32);
  const fingerprint = fingerprintOf(raw);
  assert.match(fingerprint, /^dev-[0-9a-f]{32}$/);
  assert.equal(fingerprint, `dev-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`);
  assert.equal(fingerprintOf(Buffer.alloc(32, 0)), 'dev-66687aadf862bd776c8fc18b8e9f8e20');
});

test('signing input is the canonical envelope without the signature, and verification never throws', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');
  const unsigned = {
    v: 1 as const, id: 'evt-01ARZ3NDEKTSV4RRFFQ69G5FAV', teamId: 'team-0', type: 'comment.added' as const, lamport: 3, at: '2026-01-01T00:00:00.000Z',
    author: 'mbr-0', device: 'dev-0', prev: '', body: { text: 'hello' }
  };
  const sig = edSign(null, canonicalBytes(unsigned), privateKey).toString('base64url');
  const event: TeamEvent = { ...unsigned, sig };
  assert.equal(signingInput(event).toString('utf8'), '{"at":"2026-01-01T00:00:00.000Z","author":"mbr-0","body":{"text":"hello"},"device":"dev-0","id":"evt-01ARZ3NDEKTSV4RRFFQ69G5FAV","lamport":3,"prev":"","teamId":"team-0","type":"comment.added","v":1}');
  assert.equal(verifyEventSignature(event, publicRaw), true);
  assert.equal(verifyEventSignature({ ...event, lamport: 4 }, publicRaw), false);
  assert.equal(verifyEventSignature({ ...event, body: { text: 'changed' } }, publicRaw), false);
  assert.equal(verifyEventSignature({ ...event, body: { value: 1.5 } }, publicRaw), false, 'a body the canonical form refuses');
  assert.equal(verifySignature(Buffer.from('x'), 'not a signature', publicRaw), false);
  assert.equal(verifySignature(Buffer.from('x'), sig, 'not a key'), false);
  assert.equal(verifySignature(Buffer.from('x'), '', ''), false);
  assert.equal(verifySignature(Buffer.from('x'), sig, Buffer.alloc(32, 0).toString('base64url')), false);
  assert.equal(MAX_EVENT_BYTES, 16384);
});

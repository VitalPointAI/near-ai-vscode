// Phase 46, plan 07, task 1 (D-17, D-19; T-46-25): every secret path is users/<entity id>/<u+base64url service>/<u+base64url account>, the
// encoding is reversible and injective, no encoded segment is empty, "." or ".." or holds a "/", and no service or account string can leave
// the person's prefix. A non-UUID entity id and a string with an unpaired surrogate are refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSegment, encodeSegment, secretPath } from '../extension/src/node/kv-path.ts';

const ENTITY = '0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a';

/** A small seeded generator, so a failure names a string that can be found again. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function awkwardStrings(): string[] {
  const fixed = ['', '/', '//', '.', '..', '../..', 'a/../b', '/etc/passwd', 'x:y:tokens', '%2e%2e', '\\..\\', ' ', 'u', 'uAA', '\u0000',
    'é', 'Ünïcödé', '日本語', '🔑', 'a​b', '127.0.0.1-sterling-test.secret-probe', 'x'.repeat(4096), '/'.repeat(4096)];
  const random = generator(46_07);
  const alphabet = ['a', 'Z', '0', '/', '.', ':', '-', '_', '%', ' ', '\\', '?', '#', 'é', '日', '🔑', '\n', '\u0000'];
  const generated: string[] = [];
  while (fixed.length + generated.length < 500) {
    const length = Math.floor(random() * 40);
    let value = '';
    for (let index = 0; index < length; index += 1) value += alphabet[Math.floor(random() * alphabet.length)];
    generated.push(value);
  }
  return [...fixed, ...generated];
}

test('for 500 awkward strings the encoding round-trips, never repeats, and every segment is a safe single path part', () => {
  const strings = [...new Set(awkwardStrings())];
  assert.ok(strings.length >= 450, `enough distinct strings (${strings.length})`);
  const seen = new Map<string, string>();
  for (const value of strings) {
    const segment = encodeSegment(value);
    assert.equal(decodeSegment(segment), value, `round trip of ${JSON.stringify(value.slice(0, 40))}`);
    assert.match(segment, /^u[A-Za-z0-9_-]*$/);
    assert.ok(segment !== '' && segment !== '.' && segment !== '..');
    assert.ok(!seen.has(segment), `${JSON.stringify(value.slice(0, 40))} and ${JSON.stringify(seen.get(segment)?.slice(0, 40))} encode alike`);
    seen.set(segment, value);
  }
});

test('secretPath has exactly four parts under users/<entity id>/ for any service and account', () => {
  const strings = awkwardStrings();
  for (let index = 0; index < strings.length; index += 1) {
    const service = strings[index];
    const account = strings[(index * 7 + 3) % strings.length];
    const path = secretPath(ENTITY, service, account);
    const parts = path.split('/');
    assert.equal(parts.length, 4, `four parts for ${JSON.stringify(service.slice(0, 20))}`);
    assert.deepEqual(parts.slice(0, 2), ['users', ENTITY]);
    assert.equal(decodeSegment(parts[2]), service);
    assert.equal(decodeSegment(parts[3]), account);
    assert.ok(!parts.includes('..') && !parts.includes('.') && !parts.includes(''));
  }
});

test('secretPath refuses an entity id that is not a UUID', () => {
  for (const entity of ['', '..', 'users', `${ENTITY}/x`, ENTITY.toUpperCase().replace(/-/g, ''), '../0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a']) {
    assert.throws(() => secretPath(entity, 'service', 'account'), /entity id/);
  }
});

test('a string with an unpaired surrogate is refused, so two such strings can never share a path', () => {
  assert.throws(() => encodeSegment('\uD800'), /valid text/);
  assert.throws(() => encodeSegment('a\uDFFFb'), /valid text/);
  assert.equal(decodeSegment(encodeSegment('🔑')), '🔑');
});

test('decodeSegment refuses a name the encoding could not have made', () => {
  for (const name of ['', 'abc', 'u/', 'u..', 'u+/', 'uYQ=', 'v' + encodeSegment('x').slice(1), '.', '..']) {
    assert.throws(() => decodeSegment(name), /Not an encoded secret name/, `refuses ${JSON.stringify(name)}`);
  }
});

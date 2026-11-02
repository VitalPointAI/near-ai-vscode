// Write-side secret detector (D-23, SEC-01). Every secret-shaped value is built at run time from random bytes,
// so the source holds no secret-shaped literal beyond the bare prefixes under test.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';
import { defaultTeamPolicy } from '../domain/team/policy';
import { SECRET_PATTERNS, SecretLeakError, assertNoSecrets, findSecrets } from '../domain/team/secrets';

function hex(bytes = 12): string { return randomBytes(bytes).toString('hex'); }

function pkcs8(encoding: 'base64' | 'base64url'): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'der' }).toString(encoding);
}

function rawKeyPair(): { publicKey: string; sig: string } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: spki.subarray(spki.length - 32).toString('base64url'), sig: randomBytes(64).toString('base64url') };
}

const PEM_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

const positives: Array<[string, () => string]> = [
  ['sk- key', () => `sk-${hex()}`],
  ['sk_live key', () => `sk_live_${hex()}`],
  ['sk_test key', () => `sk_test_${hex()}`],
  ['reporting token', () => `rpt-${hex()}`],
  ['refresh token', () => `rt_${hex()}`],
  ['admin token', () => `adm_${hex()}`],
  ['oc token', () => `oc_${hex()}`],
  ['bearer header', () => `Bearer ${hex(16)}`],
  ['lower case bearer header', () => `bearer ${hex(16)}`],
  ['jwt', () => `eyJ${randomBytes(9).toString('base64url')}.eyJ${randomBytes(12).toString('base64url')}.${randomBytes(24).toString('base64url')}`],
  ['pem header', () => `${PEM_HEADER}\n${hex(8)}`],
  ['pkcs8 base64', () => pkcs8('base64')],
  ['pkcs8 base64url', () => pkcs8('base64url')],
  ['api key assignment', () => `apiKey=${hex(6)}`],
  ['access token with colon', () => `access_token: ${hex(6)}`],
  ['secret inside a sentence', () => `please use sk-${hex()} for this`]
];

for (const [name, make] of positives) {
  test(`detects ${name} as a string, inside an array and nested`, () => {
    const secret = make();
    assert.deepEqual(findSecrets(secret), ['$']);
    assert.deepEqual(findSecrets({ body: { name: secret } }), ['$.body.name']);
    assert.deepEqual(findSecrets({ policy: { verifyCommands: ['npm test', secret] } }), ['$.policy.verifyCommands[1]']);
    assert.deepEqual(findSecrets([[secret]]), ['$[0][0]']);
  });
}

test('pkcs8 private keys really start with the documented Ed25519 prefix in both encodings', () => {
  assert.ok(pkcs8('base64').startsWith('MC4CAQAwBQYDK2VwBCIEI'));
  assert.ok(pkcs8('base64url').startsWith('MC4CAQAwBQYDK2VwBCIEI'));
});

test('an object key that looks like a secret is reported by its parent path and the key text is not repeated', () => {
  const secretKey = `sk-${hex()}`;
  const found = findSecrets({ notes: { [secretKey]: 'x' }, other: { [secretKey]: `rpt-${hex()}` } });
  assert.deepEqual(found, ['$.notes key name', '$.other key name', '$.other[key]']);
  for (const path of found) { assert.ok(!path.includes(secretKey), path); }
});

test('findSecrets lists paths in document order and returns no matched text', () => {
  const a = `sk-${hex()}`;
  const b = `rt_${hex()}`;
  const found = findSecrets({ body: { name: a }, policy: { verifyCommands: ['ok', b] }, last: 'fine' });
  assert.deepEqual(found, ['$.body.name', '$.policy.verifyCommands[1]']);
  for (const path of found) { assert.ok(!path.includes(a) && !path.includes(b)); }
});

test('keys that are not identifiers use a quoted path segment', () => {
  assert.deepEqual(findSecrets({ 'a b': { c: `sk-${hex()}` } }), ['$["a b"].c']);
});

test('ordinary team data produces no findings', () => {
  const clean = {
    ids: ['evt-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'mbr-0123456789abcdef', 'team-0123456789abcdef0123456789abcdef', 'dev-0123456789abcdef0123456789abcdef'],
    emailHash: hex(32),
    at: '2026-10-31T12:22:40.000Z',
    names: ['Ada Lovelace', 'Grace Hopper', 'task risk-assessment notes', 'disk-usage report'],
    policy: defaultTeamPolicy(),
    numbers: [1, 2.5, -3]
  };
  assert.deepEqual(findSecrets(clean), []);
  assert.deepEqual(findSecrets(null), []);
  assert.deepEqual(findSecrets(undefined), []);
  assert.deepEqual(findSecrets(42), []);
  assert.deepEqual(findSecrets(''), []);
});

test('2000 generated public keys and signatures under publicKey and sig never trip the detector', () => {
  for (let index = 0; index < 2000; index += 1) {
    const pair = rawKeyPair();
    assert.equal(pair.publicKey.length, 43);
    assert.equal(pair.sig.length, 86);
    assert.deepEqual(findSecrets({ device: { publicKey: pair.publicKey }, sig: pair.sig }), [], `key ${index}`);
  }
});

test('a token shaped value that is not strict key material is still scanned under publicKey and sig', () => {
  const lookalike = `sk-${'A'.repeat(39)}=`;
  assert.equal(lookalike.length, 43);
  assert.deepEqual(findSecrets({ publicKey: lookalike }), ['$.publicKey']);
  assert.deepEqual(findSecrets({ sig: `rpt-${'B'.repeat(81)} ` }), ['$.sig']);
  assert.deepEqual(findSecrets({ publicKey: `sk-${'A'.repeat(41)}` }), ['$.publicKey']);
});

test('the exemption applies only to the exact key names and lengths', () => {
  const exactShape = `sk-${'A'.repeat(40)}`;
  assert.equal(exactShape.length, 43);
  assert.deepEqual(findSecrets({ publicKey: exactShape }), [], 'documented exemption: strict public key shape under publicKey');
  assert.deepEqual(findSecrets({ name: exactShape }), ['$.name']);
  assert.deepEqual(findSecrets({ publicKeys: [exactShape] }), ['$.publicKeys[0]']);
});

test('private key material under publicKey or sig is always reported', () => {
  assert.deepEqual(findSecrets({ publicKey: pkcs8('base64url').slice(0, 43) }), ['$.publicKey']);
  assert.deepEqual(findSecrets({ sig: pkcs8('base64url') }), ['$.sig']);
  assert.deepEqual(findSecrets({ publicKey: PEM_HEADER }), ['$.publicKey']);
  assert.deepEqual(findSecrets({ other: { publicKey: pkcs8('base64') } }), ['$.other.publicKey']);
});

test('assertNoSecrets passes clean data and throws SecretLeakError without the value', () => {
  assert.doesNotThrow(() => assertNoSecrets({ name: 'Ada', policy: defaultTeamPolicy() }, 'team.json'));
  const canary = `sk-${hex(16)}`;
  assert.throws(
    () => assertNoSecrets({ name: canary }, 'team.json'),
    (error: unknown) => {
      assert.ok(error instanceof SecretLeakError);
      assert.equal(error.name, 'SecretLeakError');
      assert.equal(error.message, 'team.json contains a secret-like value at $.name; nothing was written.');
      assert.ok(!error.message.includes(canary));
      assert.ok(!JSON.stringify(error.paths).includes(canary));
      assert.ok(!String(error.stack).includes(canary));
      return true;
    }
  );
});

test('assertNoSecrets never echoes a secret found in an object key', () => {
  const canary = `rpt-${hex(16)}`;
  assert.throws(
    () => assertNoSecrets({ body: { [canary]: 1 } }, 'event body'),
    (error: unknown) => {
      assert.ok(error instanceof SecretLeakError);
      assert.equal(error.message, 'event body contains a secret-like value at $.body key name; nothing was written.');
      return true;
    }
  );
});

test('a 10000 entry array and a 16 level object are walked in full', () => {
  const big = Array.from({ length: 10000 }, (_, index) => `item ${index}`);
  big[9999] = `adm_${hex()}`;
  assert.deepEqual(findSecrets({ big }), ['$.big[9999]']);
  let deep: unknown = `oc_${hex()}`;
  for (let level = 0; level < 16; level += 1) { deep = { next: deep }; }
  const path = `$${'.next'.repeat(16)}`;
  assert.deepEqual(findSecrets(deep), [path]);
});

test('nesting deeper than 64 levels is reported where the walk stops, including a cycle', () => {
  let deep: unknown = 'leaf';
  for (let level = 0; level < 70; level += 1) { deep = [deep]; }
  const found = findSecrets(deep);
  assert.equal(found.length, 1);
  assert.equal(found[0], `$${'[0]'.repeat(64)}`);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.equal(findSecrets(loop).length, 1);
  let fine: unknown = 'leaf';
  for (let level = 0; level < 64; level += 1) { fine = [fine]; }
  assert.deepEqual(findSecrets(fine), []);
});

test('the detector patterns carry no global or sticky flag so repeated tests are stateless', () => {
  for (const pattern of SECRET_PATTERNS) {
    assert.ok(!pattern.global && !pattern.sticky, String(pattern));
  }
  const secret = `sk-${hex()}`;
  assert.deepEqual(findSecrets([secret, secret, secret]), ['$[0]', '$[1]', '$[2]']);
});

function x25519Pkcs8(encoding: 'base64' | 'base64url'): string {
  const { privateKey } = generateKeyPairSync('x25519');
  return privateKey.export({ type: 'pkcs8', format: 'der' }).toString(encoding);
}

function sealedShape(): { device: string; ephemeral: { publicKey: string }; nonce: string; tag: string; ciphertext: string } {
  return {
    device: hex(8),
    ephemeral: { publicKey: randomBytes(32).toString('base64url') },
    nonce: randomBytes(12).toString('base64url'),
    tag: randomBytes(16).toString('base64url'),
    ciphertext: randomBytes(51).toString('base64url')
  };
}

test('x25519 private keys start with the documented prefix in both encodings and are detected anywhere', () => {
  assert.ok(x25519Pkcs8('base64').startsWith('MC4CAQAwBQYDK2VuBCIEI'));
  assert.ok(x25519Pkcs8('base64url').startsWith('MC4CAQAwBQYDK2VuBCIEI'));
  for (const encoding of ['base64', 'base64url'] as const) {
    const key = x25519Pkcs8(encoding);
    assert.deepEqual(findSecrets(key), ['$']);
    assert.deepEqual(findSecrets({ body: { note: key } }), ['$.body.note']);
    assert.deepEqual(findSecrets({ publicKey: key.slice(0, 43) }), ['$.publicKey']);
    assert.deepEqual(findSecrets({ sealed: [{ ciphertext: key }] }), ['$.sealed[0].ciphertext']);
    // The 21 character prefix does not fit in a 16 character nonce, so only the 22 character tag can carry it.
    assert.deepEqual(findSecrets({ sealed: [{ nonce: key.slice(0, 16), tag: key.slice(0, 22) }] }), ['$.sealed[0].tag']);
    assert.deepEqual(findSecrets({ sealed: [{ ephemeral: { publicKey: key } }] }), ['$.sealed[0].ephemeral.publicKey']);
  }
});

test('strict sealed shapes under nonce, tag, ciphertext and the ephemeral public key are exempt from the token patterns', () => {
  // 16, 22 and 43 character values that happen to start like tokens, which random key material can do by chance.
  const entry = { device: hex(8), ephemeral: { publicKey: `sk-${'A'.repeat(40)}` }, nonce: `rt_${'B'.repeat(13)}`, tag: `sk-${'C'.repeat(19)}`, ciphertext: `AAAA_sk-${'D'.repeat(60)}` };
  assert.equal(entry.nonce.length, 16);
  assert.equal(entry.tag.length, 22);
  assert.deepEqual(findSecrets({ sealed: [entry] }), []);
  for (let index = 0; index < 200; index += 1) assert.deepEqual(findSecrets({ sealed: [sealedShape()] }), [], `entry ${index}`);
});

test('a sealed field with the wrong length or under another key name is scanned like any other string', () => {
  assert.deepEqual(findSecrets({ nonce: `rt_${'B'.repeat(14)}` }), ['$.nonce'], 'nonce of 17 characters');
  assert.deepEqual(findSecrets({ nonce: `rt_${'B'.repeat(12)}` }), ['$.nonce'], 'nonce of 15 characters');
  assert.deepEqual(findSecrets({ tag: `sk-${'C'.repeat(20)}` }), ['$.tag'], 'tag of 23 characters');
  assert.deepEqual(findSecrets({ tag: `sk-${'C'.repeat(18)}` }), ['$.tag'], 'tag of 21 characters');
  assert.deepEqual(findSecrets({ ciphertext: `sk-${'D'.repeat(18)}` }), ['$.ciphertext'], 'ciphertext of 21 characters');
  assert.deepEqual(findSecrets({ ciphertext: `AAAA_sk-${'D'.repeat(700)}` }), ['$.ciphertext'], 'ciphertext over 700 characters');
  assert.deepEqual(findSecrets({ nonces: `rt_${'B'.repeat(13)}` }), ['$.nonces']);
  assert.deepEqual(findSecrets({ secretTag: `sk-${'C'.repeat(19)}` }), ['$.secretTag']);
});

test('a clear key or token placed under ciphertext is reported, whatever its length', () => {
  assert.deepEqual(findSecrets({ sealed: [{ ciphertext: `sk-${hex(24)}` }] }), ['$.sealed[0].ciphertext']);
  assert.deepEqual(findSecrets({ sealed: [{ ciphertext: `rt_${hex(24)}` }] }), ['$.sealed[0].ciphertext']);
  assert.deepEqual(findSecrets({ sealed: [{ ciphertext: `rpt-${hex(24)}` }] }), ['$.sealed[0].ciphertext']);
  assert.deepEqual(findSecrets({ sealed: [{ ciphertext: `adm_${hex(24)}` }] }), ['$.sealed[0].ciphertext']);
  assert.deepEqual(findSecrets({ sealed: [{ ciphertext: `oc_${hex(24)}` }] }), ['$.sealed[0].ciphertext']);
  assert.deepEqual(findSecrets({ sealed: [{ ciphertext: `sk_live_${hex(24)}` }] }), ['$.sealed[0].ciphertext']);
  const jwt = `eyJ${randomBytes(9).toString('base64url')}.eyJ${randomBytes(12).toString('base64url')}.${randomBytes(24).toString('base64url')}`;
  assert.deepEqual(findSecrets({ sealed: [{ ciphertext: jwt }] }), ['$.sealed[0].ciphertext']);
  assert.throws(() => assertNoSecrets({ sealed: [{ ...sealedShape(), ciphertext: `sk-${hex(24)}` }] }, 'event'), SecretLeakError);
});

test('the existing Ed25519 private key cases still throw next to sealed entries', () => {
  assert.deepEqual(findSecrets({ sealed: [sealedShape()], publicKey: pkcs8('base64url').slice(0, 43) }), ['$.publicKey']);
  assert.deepEqual(findSecrets({ sealed: [{ ...sealedShape(), ciphertext: pkcs8('base64url') }] }), ['$.sealed[0].ciphertext']);
});

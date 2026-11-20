// The safety code (D-16, D-49): six words from the BIP-39 English list, pinned by its sha256, derived from the invite id, the genesis hash, the
// anchor's, the inviter's and the joining device's signing and X25519 keys, and the joining device's fresh nonce (MJ-01). Two people comparing six words
// aloud are comparing a value bound to every device key of this invite, which an attacker in the middle can match only with a second preimage.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SAFETY_CODE_DOMAIN, SAFETY_CODE_WORDS, safetyCode, safetyCodeText } from '../domain/replica/safetyCode';
import type { SafetyCodeInput } from '../domain/replica/safetyCode';
import { SAFETY_WORDS, SAFETY_WORDS_SHA256 } from '../domain/replica/safetyWords';
import { rng } from './helpers/replicaWorld';
import type { Rng } from './helpers/replicaWorld';

const BIP39_ENGLISH_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';
const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

const FIXED: SafetyCodeInput = {
  invite: 'inv-fixed',
  genesisHash: sha256('genesis/fixed').toString('hex'),
  lead: { publicKey: sha256('lead/sign').toString('base64url'), x25519: sha256('lead/x25519').toString('base64url') },
  inviter: { publicKey: sha256('inviter/sign').toString('base64url'), x25519: sha256('inviter/x25519').toString('base64url') },
  joiner: { publicKey: sha256('joiner/sign').toString('base64url'), x25519: sha256('joiner/x25519').toString('base64url') },
  nonce: sha256('joiner/nonce').subarray(0, 16).toString('base64url')
};
// Computed once from the derivation in safetyCode.ts and frozen: a change of the derivation (domain, field order, length prefix, bit order or word
// list) changes these words and fails this test, so two versions of the extension can never show different words for one invite. Changed for MJ-01
// (v2: the inviter and the joining nonce are inputs, under a new domain); the v1 words were tiny help cabin half boat exchange.
const FIXED_WORDS = ['orange', 'example', 'normal', 'journey', 'gain', 'dress'];

function randomBytes(random: Rng, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = random.int(256);
  return bytes;
}

function randomInput(random: Rng): SafetyCodeInput {
  return {
    invite: `inv-${randomBytes(random, 6).toString('hex')}`,
    genesisHash: randomBytes(random, 32).toString('hex'),
    lead: { publicKey: randomBytes(random, 32).toString('base64url'), x25519: randomBytes(random, 32).toString('base64url') },
    inviter: { publicKey: randomBytes(random, 32).toString('base64url'), x25519: randomBytes(random, 32).toString('base64url') },
    joiner: { publicKey: randomBytes(random, 32).toString('base64url'), x25519: randomBytes(random, 32).toString('base64url') },
    nonce: randomBytes(random, 16).toString('base64url')
  };
}

test('SAFETY_WORDS is the BIP-39 English list: 2048 distinct lower-case words with distinct four-letter prefixes, pinned by the file sha256', () => {
  assert.equal(SAFETY_WORDS.length, 2048);
  assert.equal(new Set(SAFETY_WORDS).size, 2048);
  for (const word of SAFETY_WORDS) assert.match(word, /^[a-z]{3,8}$/, word);
  // The header's claim: the first four letters (the whole word for a three-letter word) tell every word apart, so a word reads back from them.
  const prefixes = SAFETY_WORDS.map((word) => word.slice(0, 4));
  assert.equal(new Set(prefixes).size, 2048);
  const byPrefix = new Map(prefixes.map((prefix, index) => [prefix, SAFETY_WORDS[index]]));
  for (const word of SAFETY_WORDS) assert.equal(byPrefix.get(word.slice(0, 4)), word, word);
  assert.ok(SAFETY_WORDS.some((word) => word.length === 3), 'three-letter words are covered');
  assert.equal(prefixes.length, SAFETY_WORDS.length);
  assert.equal(SAFETY_WORDS_SHA256, BIP39_ENGLISH_SHA256);
  assert.equal(createHash('sha256').update(`${SAFETY_WORDS.join('\n')}\n`, 'utf8').digest('hex'), SAFETY_WORDS_SHA256);
  assert.equal(SAFETY_WORDS[0], 'abandon');
  assert.equal(SAFETY_WORDS[2047], 'zoo');
  assert.ok(Object.isFrozen(SAFETY_WORDS));
});

test('safetyCode gives six words of the list for a fixed input, the same on every call, equal to the frozen value', () => {
  assert.equal(SAFETY_CODE_WORDS, 6);
  const first = safetyCode(FIXED);
  assert.deepEqual(first, FIXED_WORDS);
  assert.equal(SAFETY_CODE_DOMAIN, 'near-ai/safety-code/v2');
  assert.deepEqual(safetyCode({ ...FIXED, lead: { ...FIXED.lead }, inviter: { ...FIXED.inviter }, joiner: { ...FIXED.joiner } }), first);
  for (const word of first) assert.ok(SAFETY_WORDS.includes(word), word);
});

test('the words are the first 66 bits of the length-prefixed sha256 read as six 11-bit indices (an independent reading of the derivation)', () => {
  const random = rng(31012);
  for (let round = 0; round < 50; round += 1) {
    const input = randomInput(random);
    const hash = createHash('sha256').update(`${SAFETY_CODE_DOMAIN}\0`, 'utf8');
    for (const value of [input.invite, input.genesisHash, input.lead.publicKey, input.lead.x25519, input.inviter.publicKey, input.inviter.x25519, input.joiner.publicKey, input.joiner.x25519, input.nonce]) {
      const bytes = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      hash.update(length).update(bytes);
    }
    const bits = [...hash.digest().subarray(0, 9)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
    const expected = [0, 1, 2, 3, 4, 5].map((word) => SAFETY_WORDS[parseInt(bits.slice(word * 11, word * 11 + 11), 2)]);
    assert.deepEqual(safetyCode(input), expected, `round ${round}`);
  }
});

test('for 200 seeded inputs, changing any single field (the inviter and the joining nonce included) changes the code, and swapping the lead and the joiner changes it too', () => {
  const random = rng(4242);
  for (let round = 0; round < 200; round += 1) {
    const input = randomInput(random);
    const base = safetyCodeText(safetyCode(input));
    const other = randomInput(random);
    const variants: Array<[string, SafetyCodeInput]> = [
      ['invite', { ...input, invite: other.invite }],
      ['genesisHash', { ...input, genesisHash: other.genesisHash }],
      ['lead.publicKey', { ...input, lead: { ...input.lead, publicKey: other.lead.publicKey } }],
      ['lead.x25519', { ...input, lead: { ...input.lead, x25519: other.lead.x25519 } }],
      ['inviter.publicKey', { ...input, inviter: { ...input.inviter, publicKey: other.inviter.publicKey } }],
      ['inviter.x25519', { ...input, inviter: { ...input.inviter, x25519: other.inviter.x25519 } }],
      ['nonce', { ...input, nonce: other.nonce }],
      ['inviter is the lead', { ...input, inviter: input.lead }],
      ['joiner.publicKey', { ...input, joiner: { ...input.joiner, publicKey: other.joiner.publicKey } }],
      ['joiner.x25519', { ...input, joiner: { ...input.joiner, x25519: other.joiner.x25519 } }],
      ['swapped', { ...input, lead: input.joiner, joiner: input.lead }],
      // Moving one character between two neighbouring fields keeps the joined text the same; the length prefixes still tell them apart.
      ['boundary', { ...input, invite: `${input.invite}${input.genesisHash[0]}`, genesisHash: input.genesisHash.slice(1) }]
    ];
    for (const [field, variant] of variants) assert.notEqual(safetyCodeText(safetyCode(variant)), base, `round ${round}: ${field}`);
  }
});

test('safetyCodeText joins the words with single spaces in lower case, and non-text input is refused', () => {
  assert.equal(safetyCodeText(FIXED_WORDS), FIXED_WORDS.join(' '));
  assert.equal(safetyCodeText(['Tiny', 'HELP']), 'tiny help');
  assert.equal(safetyCodeText(safetyCode(FIXED)).split(' ').length, 6);
  assert.throws(() => safetyCode({ ...FIXED, invite: 7 as unknown as string }), /text/);
  assert.throws(() => safetyCode({ ...FIXED, nonce: undefined as unknown as string }), /text/);
  assert.throws(() => safetyCode({ ...FIXED, inviter: undefined as unknown as SafetyCodeInput['inviter'] }), /text/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { issuerWords } from '../domain/gate/enrolment';
import { safetyCode } from '../domain/replica/safetyCode';
import { SAFETY_WORDS } from '../domain/replica/safetyWords';
import { SERVER_WORD_COUNT, SERVER_WORDS_DOMAIN, serverPinWords } from '../domain/replica/serverWords';

const PIN = '0123456789abcdef'.repeat(4);
// The SHA-256 vector was calculated independently from the framed pin and the shared word list.
const EXPECTED_WORDS = ['ignore', 'impact', 'gas', 'disorder', 'soccer', 'honey', 'crater', 'accident', 'code', 'sponsor', 'seven', 'hair'];

test('a fixed certificate pin gives the same twelve lowercase safety words on every call', () => {
  assert.equal(SERVER_WORDS_DOMAIN, 'near-ai/server-pin/v1');
  assert.equal(SERVER_WORD_COUNT, 12);
  assert.deepEqual(serverPinWords(PIN), EXPECTED_WORDS);
  assert.deepEqual(serverPinWords(PIN.toUpperCase()), EXPECTED_WORDS);
  assert.ok(EXPECTED_WORDS.every((word) => SAFETY_WORDS.includes(word) && /^[a-z]+$/.test(word)));
});

test('changing a hex digit changes the words', () => {
  assert.notDeepEqual(serverPinWords(`1${PIN.slice(1)}`), EXPECTED_WORDS);
});

test('an invalid pin raises a plain error without displaying the supplied value', () => {
  for (const invalid of [PIN.slice(1), `${PIN}\n`, `g${PIN.slice(1)}`]) {
    assert.throws(() => serverPinWords(invalid), { name: 'TypeError', message: 'The server certificate pin must be 64 hexadecimal characters.' });
  }
});

test('server pin words are distinct from the issuer words and join safety code', () => {
  const key = Buffer.from(PIN, 'hex').toString('base64url');
  const device = { publicKey: key, x25519: key };
  const joinWords = safetyCode({ invite: PIN, genesisHash: PIN, lead: device, inviter: device, joiner: device, nonce: key });
  assert.notDeepEqual(serverPinWords(PIN), issuerWords(key));
  assert.notDeepEqual(serverPinWords(PIN).slice(0, joinWords.length), joinWords);
});

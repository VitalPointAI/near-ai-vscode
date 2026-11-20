// Your organization's enrolment file, the twelve issuer words and the check of every later rules file (Phase 41, FND-01, D-11 to D-15). The files are
// hostile input: each test builds them with the real builders or signs a broken one by hand, at a fixed clock, with keys made at test time.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ENROLMENT_FILE_EXTENSION, ISSUER_WORDS_DOMAIN, ISSUER_WORD_COUNT, MAX_ENROLMENT_FILE_BYTES, ORGANIZATION_RULES_FILE_EXTENSION, buildEnrolment,
  buildOrganizationLayer, issuerFingerprintHex, issuerWords, issuerWordsText, readEnrolmentFile, verifyOrganizationLayer
} from '../domain/gate/enrolment';
import { SAFETY_CODE_DOMAIN } from '../domain/replica/safetyCode';
import { SAFETY_WORDS } from '../domain/replica/safetyWords';
import { FIXED_NOW, deviceKey, enrolmentFileFor, issuerKey } from './helpers/policyFixtures';
import { EXAMPLE_ORGANIZATION, organizationSections } from './helpers/enrolmentFixtures';

/** The twelve words computed here without the module: sha256 of the domain, NUL, a 4-byte length and the raw key; the top 132 bits, 11 at a time. */
function independentWords(raw: Buffer): string[] {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(raw.length, 0);
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from('near-ai/org-issuer/v1\0', 'utf8'), length, raw])).digest();
  let bits = 0n;
  for (let index = 0; index < 17; index += 1) bits = (bits << 8n) | BigInt(digest[index]);
  const words: string[] = [];
  for (let word = 0; word < 12; word += 1) words.push(SAFETY_WORDS[Number((bits >> BigInt(136 - 11 * (word + 1))) & 2047n)]);
  return words;
}

test('D-11: an enrolment file reads back with its organization, its twelve words and its first rules', () => {
  assert.equal(ENROLMENT_FILE_EXTENSION, '.near-org-enrolment');
  assert.equal(ORGANIZATION_RULES_FILE_EXTENSION, '.near-org-rules');
  assert.equal(MAX_ENROLMENT_FILE_BYTES, 64 * 1024);
  const issuer = issuerKey();
  const layer = buildOrganizationLayer(issuer, organizationSections(), { now: FIXED_NOW, days: 90 });
  const envelope = buildEnrolment(issuer, { organization: EXAMPLE_ORGANIZATION, layer, now: FIXED_NOW, days: 30, serial: 1 });
  const read = readEnrolmentFile(JSON.stringify(envelope), { now: FIXED_NOW });
  assert.equal(read.ok, true, read.ok ? '' : read.message);
  if (!read.ok) return;
  assert.equal(read.enrolment.organization.name, 'Example Organization');
  assert.deepEqual(read.enrolment.organization.contacts, [{ topic: 'security', name: 'Security desk', how: 'security@example.org' }]);
  assert.equal(read.enrolment.issuer.publicKey, issuer.publicKey);
  assert.equal(read.enrolment.serial, 1);
  assert.deepEqual(read.words, issuerWords(issuer.publicKey));
  assert.equal(read.fingerprintHex, issuerFingerprintHex(issuer.publicKey));
  assert.equal(read.layer.document.layer, 'organization');
  assert.equal(read.layer.document.labels.routing.levels['org/Internal'], 'local-only');
  assert.equal(read.layer.issuedAt, new Date(FIXED_NOW).toISOString());

  // 41-01's fixture writes the same fields, so the fixture and the reader agree.
  const fixture = readEnrolmentFile(enrolmentFileFor({ issuer }), { now: FIXED_NOW });
  assert.equal(fixture.ok, true, fixture.ok ? '' : fixture.message);
});

test('D-12: twelve words over their own domain', () => {
  assert.equal(ISSUER_WORDS_DOMAIN, 'near-ai/org-issuer/v1');
  assert.notEqual(ISSUER_WORDS_DOMAIN, SAFETY_CODE_DOMAIN);
  assert.equal(ISSUER_WORD_COUNT, 12);
  const issuer = issuerKey();
  const words = issuerWords(issuer.publicKey);
  assert.equal(words.length, 12);
  for (const word of words) assert.ok(SAFETY_WORDS.includes(word), word);
  assert.deepEqual(words, independentWords(Buffer.from(issuer.publicKey, 'base64url')));

  const ones = Buffer.alloc(32, 0x01);
  const pinned = ['replace', 'pulp', 'oyster', 'toilet', 'will', 'split', 'sword', 'grief', 'diary', 'lounge', 'bunker', 'logic'];
  assert.deepEqual(issuerWords(ones.toString('base64url')), independentWords(ones));
  assert.deepEqual(issuerWords(ones.toString('base64url')), pinned);
  assert.equal(issuerWordsText(pinned), pinned.join(' '));
  assert.equal(issuerWordsText(['Replace', 'PULP']), 'replace pulp');

  const flipped = Buffer.from(ones);
  flipped[31] ^= 0x01;
  assert.notDeepEqual(issuerWords(flipped.toString('base64url')), pinned);

  const hex = issuerFingerprintHex(ones.toString('base64url'));
  assert.match(hex, /^[0-9a-f]{4}( [0-9a-f]{4}){15}$/);
  assert.equal(hex.replace(/ /g, ''), createHash('sha256').update(ones).digest('hex'));

  for (const bad of ['', 'AQEB', `${ones.toString('base64url')}A`, ones.toString('base64')]) assert.throws(() => issuerWords(bad), TypeError);
});

test('D-15: an organization layer signed by another key, this computer\'s included, is refused unknown-key', () => {
  const first = issuerKey();
  const second = issuerKey('another-organization');
  const own = deviceKey();
  for (const signer of [second, own]) {
    const layer = buildOrganizationLayer(signer, organizationSections(), { now: FIXED_NOW, days: 90 });
    const verdict = verifyOrganizationLayer(JSON.stringify(layer), { issuerPublicKey: first.publicKey, now: FIXED_NOW });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.reason, 'unknown-key');
    assert.equal(verdict.failure, 'unknown-key');
  }
  const accepted = verifyOrganizationLayer(buildOrganizationLayer(first, organizationSections(), { now: FIXED_NOW, days: 90 }), { issuerPublicKey: first.publicKey, now: FIXED_NOW });
  assert.equal(accepted.ok, true);
});

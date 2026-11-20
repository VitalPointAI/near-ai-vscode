// Your organization's enrolment file, the twelve issuer words and the check of every later rules file (Phase 41, FND-01, D-11 to D-15). The files are
// hostile input: each test builds them with the real builders or signs a broken one by hand, at a fixed clock, with keys made at test time.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ENROLMENT_FILE_EXTENSION, ENROLMENT_REFUSALS, ISSUER_WORDS_DOMAIN, ISSUER_WORDS_MATCH, ISSUER_WORD_COUNT, MAX_ENROLMENT_FILE_BYTES,
  ORGANIZATION_LAYER_REFUSALS, ORGANIZATION_RULES_FILE_EXTENSION, ROTATION_DOMAIN, ROTATION_WORDS_LEAD, buildEnrolment, buildOrganizationLayer,
  classifyEnrolment, contactShown, issuerDetailsLine, issuerFingerprintHex, issuerWords, issuerWordsPrompt, issuerWordsQuestion, issuerWordsText,
  organizationEndedText, organizationEndingText, readEnrolmentFile, rotationSigningInput, verifyOrganizationLayer
} from '../domain/gate/enrolment';
import type { EnrolmentRead } from '../domain/gate/enrolment';
import { MAX_ORGANIZATION_LAYER_BYTES } from '../domain/gate/policyDocument';
import { PAYLOAD_DOMAIN, signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { SAFETY_CODE_DOMAIN } from '../domain/replica/safetyCode';
import { SAFETY_WORDS } from '../domain/replica/safetyWords';
import { DAY_MS, FIXED_NOW, deviceKey, enrolmentFileFor, issuerKey, signOrganizationLayer } from './helpers/policyFixtures';
import { EXAMPLE_ORGANIZATION, enrolmentTextFor, organizationSections, rotationTextFor, rulesTextFor } from './helpers/enrolmentFixtures';

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

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 2: every refusal, hostile input, rollback, expiry and the key handover

const ISSUED_AT = new Date(FIXED_NOW).toISOString();

/** The payload of a good enrolment file, as plain JSON to change by hand. */
function goodPayload(issuer: PayloadSigner = issuerKey()): Record<string, any> {
  return JSON.parse(enrolmentTextFor(issuer)).payload as Record<string, any>;
}

/** Signs an enrolment payload by hand (no read-back), at `signedAt` (its own issuedAt by default). */
function signedEnrolmentText(signer: PayloadSigner, payload: Record<string, unknown>, signedAt?: string): string {
  const at = signedAt ?? String(payload['issuedAt']);
  return JSON.stringify(signPayload(signer, 'org-enrolment', payload, { now: () => new Date(at), maxBytes: MAX_ORGANIZATION_LAYER_BYTES * 2 }));
}

/** The first layer's document as plain JSON, to change by hand and sign again. */
function layerDocument(issuer: PayloadSigner = issuerKey()): Record<string, any> {
  return JSON.parse(rulesTextFor(issuer)).payload as Record<string, any>;
}

function refusedReason(read: EnrolmentRead): string {
  return read.ok ? 'ok' : read.reason;
}

test('D-11: each broken enrolment file is refused with its own reason and changes nothing', () => {
  const issuer = issuerKey();
  const good = enrolmentTextFor(issuer);
  const goodParsed = JSON.parse(good) as Record<string, any>;
  const withChanged = (change: (payload: Record<string, any>) => void, signer: PayloadSigner = issuer): string => {
    const payload = goodPayload(issuer);
    change(payload);
    return signedEnrolmentText(signer, payload);
  };
  const futureLayer = layerDocument(issuer);
  futureLayer['requires'] = [...futureLayer['requires'], 'zz-future@1'];
  const personalLayer = { ...layerDocument(issuer), layer: 'personal' };
  const nameChanged = JSON.parse(good) as Record<string, any>;
  nameChanged['payload'].organization.name = 'Other Organization';
  const protoText = good.replace('"payload":{', '"payload":{"__proto__":{"serial":9},');
  assert.notEqual(protoText, good);

  const cases: Array<[string, unknown, string, { now?: number; deviceKey?: string }?]> = [
    ['one byte over 64 KiB of non-JSON text', 'x'.repeat(MAX_ENROLMENT_FILE_BYTES + 1), 'too-large'],
    ['a good file padded one byte over 64 KiB', good + ' '.repeat(MAX_ENROLMENT_FILE_BYTES + 1 - Buffer.byteLength(good)), 'too-large'],
    ['not JSON', '{"v":1,', 'malformed'],
    ['JSON that is not an object', '[1,2]', 'malformed'],
    ['an extra key', withChanged((payload) => { payload['extra'] = 1; }), 'malformed'],
    ['a missing layer', withChanged((payload) => { delete payload['layer']; }), 'malformed'],
    ['a __proto__ key', protoText, 'malformed'],
    ['an issuer key that is not 32 bytes', withChanged((payload) => { payload['issuer'] = { publicKey: 'AQEB' }; }), 'malformed'],
    ['an organization name on two lines', withChanged((payload) => { payload['organization'].name = 'Example\nOrganization'; }), 'malformed'],
    ['a serial of 0', withChanged((payload) => { payload['serial'] = 0; }), 'malformed'],
    ['expiry before issue', withChanged((payload) => { payload['expiresAt'] = new Date(FIXED_NOW - DAY_MS).toISOString(); }), 'malformed'],
    ['a newer enrolment format', withChanged((payload) => { payload['v'] = 2; }), 'needs-update'],
    ['a changed organization name', JSON.stringify(nameChanged), 'bad-signature'],
    ['signed by a key other than the issuer it names', withChanged(() => undefined, issuerKey('someone-else')), 'bad-signature'],
    ['signedAt not equal to issuedAt', signedEnrolmentText(issuer, goodPayload(issuer), new Date(FIXED_NOW + 1000).toISOString()), 'malformed'],
    ['expired', good, 'enrolment-expired', { now: Date.parse(goodParsed['payload'].expiresAt) }],
    ['issued more than five minutes after now', good, 'clock-behind', { now: FIXED_NOW - 5 * 60 * 1000 - 1 }],
    ['signed by this computer\'s key', enrolmentTextFor(deviceKey()), 'own-key', { deviceKey: deviceKey().publicKey }],
    ['a first layer needing an unknown feature', withChanged((payload) => { payload['layer'] = signOrganizationLayer(futureLayer, issuer); }), 'needs-update'],
    ['a first layer that is a personal layer', withChanged((payload) => { payload['layer'] = signOrganizationLayer(personalLayer, issuer); }), 'layer-refused'],
    ['a first layer signed by another key', withChanged((payload) => { payload['layer'] = JSON.parse(rulesTextFor(issuerKey('someone-else'))); }), 'layer-refused']
  ];
  for (const [name, file, reason, options] of cases) {
    const before = typeof file === 'string' ? file : JSON.stringify(file);
    const read = readEnrolmentFile(file, { now: options?.now ?? FIXED_NOW, ...(options?.deviceKey === undefined ? {} : { deviceKey: options.deviceKey }) });
    assert.equal(refusedReason(read), reason, name);
    if (!read.ok) assert.equal(read.message, ENROLMENT_REFUSALS[read.reason as keyof typeof ENROLMENT_REFUSALS], name);
    assert.equal(typeof file === 'string' ? file : JSON.stringify(file), before, `${name}: the input is unchanged`);
  }

  // The allowed side of each boundary: the good file, the same file exactly at the cap, a clock up to five minutes behind, the last moment before expiry,
  // the device key given and different, and the parsed envelope instead of its text.
  const atCap = good + ' '.repeat(MAX_ENROLMENT_FILE_BYTES - Buffer.byteLength(good));
  const allowed: Array<[string, unknown, number, string?]> = [
    ['the good file', good, FIXED_NOW],
    ['the good file at exactly 64 KiB', atCap, FIXED_NOW],
    ['a clock five minutes behind', good, FIXED_NOW - 5 * 60 * 1000],
    ['the last moment before expiry', good, Date.parse(goodParsed['payload'].expiresAt) - 1],
    ['another device key', good, FIXED_NOW, deviceKey().publicKey],
    ['the parsed envelope', goodParsed, FIXED_NOW]
  ];
  for (const [name, file, now, device] of allowed) {
    const read = readEnrolmentFile(file, device === undefined ? { now } : { now, deviceKey: { publicKey: device } });
    assert.equal(refusedReason(read), 'ok', name);
  }
});

test('D-14: each broken organization layer is refused', () => {
  const issuer = issuerKey();
  const good = rulesTextFor(issuer);
  const goodParsed = JSON.parse(good) as Record<string, any>;
  const verify = (file: unknown, extra: { now?: number; lastIssuedAt?: string | number; issuerPublicKey?: string } = {}) =>
    verifyOrganizationLayer(file, { issuerPublicKey: extra.issuerPublicKey ?? issuer.publicKey, now: extra.now ?? FIXED_NOW, ...(extra.lastIssuedAt === undefined ? {} : { lastIssuedAt: extra.lastIssuedAt }) });

  const personal = signOrganizationLayer({ ...layerDocument(issuer), layer: 'personal' }, issuer);
  const lateSigned = signPayload(issuer, 'org-policy-layer', layerDocument(issuer), { now: () => new Date(FIXED_NOW + 1000), maxBytes: MAX_ORGANIZATION_LAYER_BYTES });
  const tampered = JSON.parse(good) as Record<string, any>;
  tampered['payload'].labels.routing.levels['org/Internal'] = 'any-cloud';
  const future = layerDocument(issuer);
  future['requires'] = [...future['requires'], 'zz-future@1'];
  const unknownInSection = layerDocument(issuer);
  unknownInSection['labels'] = { ...unknownInSection['labels'], colour: 'blue' };
  const expiresAt = Date.parse(goodParsed['payload'].expiresAt);

  const cases: Array<[string, unknown, string, Parameters<typeof verify>[1]?]> = [
    ['a personal layer signed under org-policy-layer', personal, 'malformed'],
    ['not JSON', '{"v":', 'malformed'],
    ['signed one second after its issuedAt', lateSigned, 'signer-mismatch'],
    ['changed after signing', tampered, 'bad-signature'],
    ['expired', good, 'expired', { now: expiresAt }],
    ['issued more than five minutes after now', good, 'clock-behind', { now: FIXED_NOW - 5 * 60 * 1000 - 1 }],
    ['requires zz-future@1', signOrganizationLayer(future, issuer), 'needs-update'],
    ['an unknown key inside a known section', signOrganizationLayer(unknownInSection, issuer), 'needs-update'],
    ['older than the last accepted', good, 'older', { lastIssuedAt: new Date(FIXED_NOW + 1).toISOString() }],
    ['older than the last accepted (epoch milliseconds)', good, 'older', { lastIssuedAt: FIXED_NOW + 1 }],
    ['a last accepted time that cannot be read', good, 'older', { lastIssuedAt: 'yesterday' }],
    ['signed by this computer\'s key', rulesTextFor(deviceKey()), 'unknown-key'],
    ['a pinned key that is not a key', good, 'unknown-key', { issuerPublicKey: 'AQEB' }],
    ['one byte over 1 MiB', good + ' '.repeat(MAX_ORGANIZATION_LAYER_BYTES + 1 - Buffer.byteLength(good)), 'too-large']
  ];
  for (const [name, file, reason, extra] of cases) {
    const verdict = verify(file, extra);
    assert.equal(verdict.ok ? 'ok' : verdict.reason, reason, name);
    if (!verdict.ok) assert.equal(verdict.message, ORGANIZATION_LAYER_REFUSALS[verdict.reason], name);
  }
  const older = verify(good, { lastIssuedAt: FIXED_NOW + 1 });
  assert.equal(older.ok ? 'ok' : older.failure, 'replaced');
  const needsUpdate = verify(signOrganizationLayer(future, issuer));
  assert.equal(needsUpdate.ok ? 'ok' : needsUpdate.failure, 'needs-update');

  // Allowed: equal issuedAt (the caller compares hashes), an earlier last time, exactly 1 MiB of text, the last moment before expiry, the parsed envelope.
  const allowed: Array<[string, unknown, Parameters<typeof verify>[1]?]> = [
    ['equal issuedAt', good, { lastIssuedAt: ISSUED_AT }],
    ['an earlier last time', good, { lastIssuedAt: FIXED_NOW - DAY_MS }],
    ['exactly 1 MiB of text', good + ' '.repeat(MAX_ORGANIZATION_LAYER_BYTES - Buffer.byteLength(good))],
    ['the last moment before expiry', good, { now: expiresAt - 1 }],
    ['the parsed envelope', goodParsed]
  ];
  for (const [name, file, extra] of allowed) {
    const verdict = verify(file, extra);
    assert.equal(verdict.ok ? 'ok' : verdict.reason, 'ok', name);
    if (verdict.ok) assert.equal(verdict.issuedAt, ISSUED_AT, name);
  }
});

test('D-14: a handover is accepted only from the pinned key, with a higher serial', () => {
  const a = issuerKey('handover-a');
  const b = issuerKey('handover-b');
  const c = issuerKey('handover-c');
  const pin = { publicKey: a.publicKey, serial: 1 };
  const read = (text: string) => {
    const result = readEnrolmentFile(text, { now: FIXED_NOW });
    if (!result.ok) throw new Error(`The file did not read back: ${result.message}`);
    return result;
  };

  const handover = read(rotationTextFor(a, b, { serial: 2 }));
  assert.equal(handover.enrolment.rotation?.previous.publicKey, a.publicKey);
  assert.equal(handover.enrolment.issuer.publicKey, b.publicKey);
  assert.equal(classifyEnrolment(handover, pin), 'rotate');
  assert.equal(classifyEnrolment(read(rotationTextFor(a, b, { serial: 1 })), pin), 'older-file');
  assert.equal(classifyEnrolment(read(enrolmentTextFor(b, { serial: 5 })), pin), 'other-organization');
  assert.equal(classifyEnrolment(read(rotationTextFor(c, b, { serial: 5 })), pin), 'other-organization');
  assert.equal(classifyEnrolment(read(enrolmentTextFor(a)), pin), 'same-key');
  assert.equal(classifyEnrolment(handover), 'enrol');
  assert.equal(classifyEnrolment(handover, undefined), 'enrol');

  // A handover signed by C but naming A as the previous key, re-signed by B: the handover signature is not A's.
  const forged = JSON.parse(rotationTextFor(c, b, { serial: 2 })).payload as Record<string, any>;
  forged['rotation'].previous.publicKey = a.publicKey;
  assert.equal(refusedReason(readEnrolmentFile(signedEnrolmentText(b, forged), { now: FIXED_NOW })), 'rotation-invalid');
  // A's real handover signature over serial 2, put into a file with serial 3: the serial is inside the signed bytes.
  const replayed = JSON.parse(rotationTextFor(a, b, { serial: 2 })).payload as Record<string, any>;
  replayed['serial'] = 3;
  assert.equal(refusedReason(readEnrolmentFile(signedEnrolmentText(b, replayed), { now: FIXED_NOW })), 'rotation-invalid');
  // The same handover moved to another time.
  const moved = JSON.parse(rotationTextFor(a, b, { serial: 2 })).payload as Record<string, any>;
  moved['issuedAt'] = new Date(FIXED_NOW - 1000).toISOString();
  assert.equal(refusedReason(readEnrolmentFile(signedEnrolmentText(b, moved), { now: FIXED_NOW })), 'rotation-invalid');
  // A handover from a key to itself.
  const toItself = JSON.parse(rotationTextFor(a, b, { serial: 2 })).payload as Record<string, any>;
  toItself['rotation'].previous.publicKey = b.publicKey;
  assert.equal(refusedReason(readEnrolmentFile(signedEnrolmentText(b, toItself), { now: FIXED_NOW })), 'rotation-invalid');
  // This computer's key as the previous key.
  assert.equal(refusedReason(readEnrolmentFile(rotationTextFor(deviceKey(), b), { now: FIXED_NOW, deviceKey: deviceKey().publicKey })), 'own-key');

  // The handover bytes start with their own domain, never like a payload signature or canonical JSON.
  assert.equal(ROTATION_DOMAIN, 'near-ai/org-issuer-rotation/v1');
  const input = rotationSigningInput({ newPublicKey: b.publicKey, previousPublicKey: a.publicKey, serial: 2, issuedAt: ISSUED_AT });
  assert.ok(input.subarray(0, ROTATION_DOMAIN.length + 1).equals(Buffer.from(`${ROTATION_DOMAIN}\0`, 'utf8')));
  assert.notEqual(input.subarray(0, PAYLOAD_DOMAIN.length).toString('utf8'), PAYLOAD_DOMAIN);
  assert.notEqual(input[0], '{'.charCodeAt(0));
  const length = input.readUInt32BE(ROTATION_DOMAIN.length + 1);
  assert.equal(input.subarray(ROTATION_DOMAIN.length + 5, ROTATION_DOMAIN.length + 5 + length).toString('utf8'), b.publicKey);
  assert.notDeepEqual(input, rotationSigningInput({ newPublicKey: b.publicKey, previousPublicKey: a.publicKey, serial: 3, issuedAt: ISSUED_AT }));
});

test('every refusal sentence is plain', () => {
  const longToken = /[A-Za-z0-9_+/=-]{32,}/;
  const sentences: Array<[string, string]> = [
    ...Object.entries(ENROLMENT_REFUSALS).map(([reason, sentence]): [string, string] => [`enrolment ${reason}`, sentence]),
    ...Object.entries(ORGANIZATION_LAYER_REFUSALS).map(([reason, sentence]): [string, string] => [`layer ${reason}`, sentence])
  ];
  assert.deepEqual(Object.keys(ENROLMENT_REFUSALS).sort(), [
    'bad-signature', 'clock-behind', 'enrolment-expired', 'layer-refused', 'malformed', 'needs-update', 'older-file', 'other-organization', 'own-key',
    'rotation-invalid', 'too-large'
  ]);
  assert.deepEqual(Object.keys(ORGANIZATION_LAYER_REFUSALS).sort(), [
    'bad-signature', 'clock-behind', 'expired', 'malformed', 'needs-update', 'older', 'signer-mismatch', 'too-large', 'unknown-key'
  ]);
  for (const [name, sentence] of sentences) {
    assert.ok(!sentence.includes('\u2014'), `${name}: no em-dash`);
    assert.ok(!/reset/i.test(sentence), `${name}: never offers Reset`);
    assert.ok(!longToken.test(sentence), `${name}: no key or signature text`);
    assert.ok(!/\{[a-z]+\}/i.test(sentence), `${name}: no placeholder`);
    assert.ok(!sentence.includes(['NEAR', 'organization'].join(' ')), `${name}: says your organization`);
    assert.match(sentence, /\.$/, `${name}: a whole sentence`);
  }
  assert.match(ENROLMENT_REFUSALS['needs-update'], /Update the NEAR AI extension/);
  assert.match(ORGANIZATION_LAYER_REFUSALS['needs-update'], /Update the NEAR AI extension/);
});

test('D-12, D-14: the modal and expiry words', () => {
  const words = issuerWords(issuerKey().publicKey);
  assert.equal(issuerWordsPrompt(words), `Ask your organization's security contact to read their twelve words. Compare them with these: ${issuerWordsText(words)}`);
  assert.equal(ISSUER_WORDS_MATCH, 'The twelve words match');
  assert.equal(issuerWordsQuestion('Example Organization'), 'Use the rules from Example Organization on this computer?');
  assert.equal(ROTATION_WORDS_LEAD, 'Your organization replaced the key that signs its rules.');
  const hex = issuerFingerprintHex(issuerKey().publicKey);
  assert.equal(issuerDetailsLine(hex), `Details: key fingerprint ${hex}`);
  assert.equal(organizationEndedText('2027-03-04', 'Security desk (security@example.org)'),
    'Your organization\'s rules ended on 2027-03-04. Ask Security desk (security@example.org) for the current rules.');
  assert.equal(organizationEndingText('2027-03-04', 'Security desk (security@example.org)'),
    'Your organization\'s rules end on 2027-03-04. Ask Security desk (security@example.org) for the current rules.');

  assert.equal(contactShown(EXAMPLE_ORGANIZATION.contacts), 'Security desk (security@example.org)');
  assert.equal(contactShown([
    { topic: 'export-control', name: 'Export control desk', how: 'exports@example.org' },
    { topic: 'privacy', name: 'Privacy office', how: 'privacy@example.org' },
    { topic: 'security', name: 'Security desk', how: 'security@example.org' }
  ]), 'Security desk (security@example.org)');
  assert.equal(contactShown([{ topic: 'it', name: 'Help desk', how: 'help@example.org' }]), 'Help desk (help@example.org)');
  assert.equal(contactShown([]), 'your organization\'s security contact');
  assert.equal(contactShown(undefined), 'your organization\'s security contact');
});

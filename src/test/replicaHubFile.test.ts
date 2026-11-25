// The hub's signed shapes (D-29, D-35, D-41, D-51, D-60): the operator's hub file, read the way it arrives, as JSON text from any channel, and the
// certificate pin it carries. One named test per refusal. Keys are generated at run time or derived from labels; no key material is written here.
// The certificates are built here from DER parts and signed with a generated key, so no certificate file and no openssl run is needed.
import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign as dsaSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import test from 'node:test';
import { x25519BindingBytes } from '../domain/replica/cellKeys';
import { kemPublicFromSeeds } from '../domain/replica/cellWrapV2';
import { deviceKemProblem, signKemBinding } from '../domain/replica/deviceKem';
import {
  CHALLENGE_BYTES, HUB_FILE_EXTENSION, HUB_FILE_MAX_BYTES, HUB_FILE_REFUSALS, SESSION_KEYING_BYTES, SESSION_KEYING_LABEL, SESSION_REFUSALS, SESSION_VERSION, buildHubFile, buildSessionAnswer, certPinOf,
  checkEnrolmentMac, enrolmentMac, hubDeviceKemData, hubIdOf, isHubAddress, readHubFile, readSessionAnswer, spkiPin
} from '../domain/replica/hubFile';
import type { BuildHubFileInput, EnrolmentMacFields, HubFilePayload, SessionAnswerPayload, SessionExpectation } from '../domain/replica/hubFile';
import { KNOWN_REPLICA_FEATURES, MAX_FEATURES } from '../domain/replica/features';
import { canonicalBytes } from '../domain/team/canonical';
import { writerIdOf } from '../domain/replica/entry';
import { signPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { rosterDevice } from './helpers/replicaRosterWorld';
import type { RosterDevice } from './helpers/replicaRosterWorld';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const EXPIRES = '2026-11-27T12:00:00.000Z';
const ADDRESS = 'hub.example.org:8443';

const asFile = (value: unknown): string => JSON.stringify(value);
const reasonOf = (result: { ok: boolean; reason?: string }): string => (result.ok ? 'ok' : (result.reason as string));

// ---- A minimal X.509 certificate from DER parts (version 3, no extensions), self-signed with ECDSA P-256 and SHA-256. ----
function derOf(tag: number, body: Buffer): Buffer {
  let length: Buffer;
  if (body.length < 0x80) {
    length = Buffer.from([body.length]);
  } else {
    const hex = body.length.toString(16);
    const bytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
    length = Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts: Buffer[]): Buffer => derOf(0x30, Buffer.concat(parts));
function oidOf(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out: number[] = [first * 40 + second];
  for (const arc of rest) {
    const digits: number[] = [arc & 0x7f];
    let value = Math.floor(arc / 128);
    while (value > 0) {
      digits.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(...digits);
  }
  return derOf(0x06, Buffer.from(out));
}
const integerOf = (value: number): Buffer => derOf(0x02, Buffer.from([value]));
const nameOf = (common: string): Buffer => sequence(derOf(0x31, sequence(oidOf('2.5.4.3'), derOf(0x0c, Buffer.from(common, 'utf8')))));
const ECDSA_SHA256 = sequence(oidOf('1.2.840.10045.4.3.2'));

/** A self-signed certificate for the key pair, as DER. serial, subject and validity let two certificates for one key differ. */
function certificateDer(keys: { privateKey: KeyObject; publicKey: KeyObject }, options: { serial: number; subject: string; from: string; until: string }): Buffer {
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = sequence(
    derOf(0xa0, integerOf(2)),
    integerOf(options.serial),
    ECDSA_SHA256,
    nameOf(options.subject),
    sequence(derOf(0x17, Buffer.from(options.from, 'ascii')), derOf(0x17, Buffer.from(options.until, 'ascii'))),
    nameOf(options.subject),
    spki
  );
  const signature = dsaSign('sha256', tbs, keys.privateKey);
  return sequence(tbs, ECDSA_SHA256, derOf(0x03, Buffer.concat([Buffer.from([0]), signature])));
}
const pemOf = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
const ecKeys = (): { privateKey: KeyObject; publicKey: KeyObject } => generateKeyPairSync('ec', { namedCurve: 'P-256' });

// ---- The hub's identity and its file. ----
interface HubWorld { hub: RosterDevice; certPin: string; enrolment: string; enrolmentSecret: string; input: BuildHubFileInput }

function hubWorld(label = 'HUB'): HubWorld {
  const hub = rosterDevice(label, 'hub');
  const certPin = spkiPin(ecKeys().publicKey);
  // Fixed per label, so every run signs the same bytes (random text could match a token pattern by chance under a purpose with no exempt paths).
  const enrolment = `enr-${createHash('sha256').update(`enrolment/${label}`).digest('hex').slice(0, 16)}`;
  const enrolmentSecret = createHash('sha256').update(`enrolment-secret/${label}`).digest().toString('base64url');
  const input: BuildHubFileInput = { address: ADDRESS, certPin, x25519: hub.x25519, x25519Sig: hub.x25519Sig, enrolment, enrolmentSecret, expiresAt: EXPIRES, now: NOW };
  return { hub, certPin, enrolment, enrolmentSecret, input };
}

const fileOf = (world: HubWorld): SignedPayload<HubFilePayload> => buildHubFile(world.hub.signer, world.input);
const copyOf = (signed: SignedPayload<HubFilePayload>): SignedPayload<HubFilePayload> => JSON.parse(JSON.stringify(signed)) as SignedPayload<HubFilePayload>;
// A payload the hub signs as it is, valid or not, so a reader's check (not the builder's) is what refuses it.
const signedAs = (signer: RosterDevice, payload: unknown): string => asFile(signPayload(signer.signer, 'staff-hub-file', payload, { now: () => NOW }));

test('tracer: the hub signs a hub file and a lead\'s device reads it back from JSON text with the hub id, address, pin, keys and enrolment', () => {
  const world = hubWorld();
  const signed = fileOf(world);
  assert.equal(signed.purpose, 'staff-hub-file');
  assert.equal(HUB_FILE_EXTENSION, '.near-staff-hub');
  const read = readHubFile(asFile(signed), NOW);
  assert.equal(reasonOf(read), 'ok');
  const file = (read as { ok: true; hubFile: HubFilePayload }).hubFile;
  assert.deepEqual(file, {
    v: 1, hub: `hub-${world.hub.writer.slice(0, 16)}`, address: ADDRESS, certPin: world.certPin, publicKey: world.hub.publicKey, writer: world.hub.writer,
    x25519: world.hub.x25519, x25519Sig: world.hub.x25519Sig, enrolment: world.enrolment, enrolmentSecret: world.enrolmentSecret, expiresAt: EXPIRES
  });
  assert.equal(hubIdOf(world.hub.writer), file.hub);
  assert.equal(file.writer, writerIdOf(file.publicKey));
  // The parsed result is a fresh object: a parsed value given to the reader gives the same answer.
  assert.equal(reasonOf(readHubFile(JSON.parse(asFile(signed)) as unknown, NOW)), 'ok');
});

test('bad-signature: any changed field of a hub file is refused, and so is a file signed by a key other than the one it names', () => {
  const world = hubWorld();
  const other = hubWorld('OTHER-HUB');
  const signed = fileOf(world);
  const changes: Array<[string, (payload: HubFilePayload) => void]> = [
    ['address', (p) => { p.address = 'hub2.example.org:8443'; }],
    ['certPin', (p) => { p.certPin = other.certPin; }],
    ['x25519', (p) => { p.x25519 = other.hub.x25519; }],
    ['x25519Sig', (p) => { p.x25519Sig = other.hub.signer.sign(x25519BindingBytes(world.hub.x25519, world.hub.writer)); }],
    ['enrolment', (p) => { p.enrolment = other.enrolment; }],
    ['enrolmentSecret', (p) => { p.enrolmentSecret = other.enrolmentSecret; }],
    ['expiresAt', (p) => { p.expiresAt = '2026-12-27T12:00:00.000Z'; }],
    ['publicKey, writer and hub together', (p) => { p.publicKey = other.hub.publicKey; p.writer = other.hub.writer; p.hub = hubIdOf(other.hub.writer); }]
  ];
  for (const [field, change] of changes) {
    const copy = copyOf(signed);
    change(copy.payload);
    assert.equal(reasonOf(readHubFile(asFile(copy), NOW)), 'bad-signature', field);
  }
  // Another hub signs a file naming the first hub's keys: its signature is good, but it is not the named key's.
  const forged = signedAs(other.hub, signed.payload);
  assert.equal(reasonOf(readHubFile(forged, NOW)), 'bad-signature');
  // The envelope's signer edited to the named key no longer verifies either.
  const relabelled = JSON.parse(forged) as SignedPayload<HubFilePayload>;
  relabelled.signer = { ...signed.signer };
  assert.equal(reasonOf(readHubFile(asFile(relabelled), NOW)), 'bad-signature');
});

test('expired: a hub file read after its expiry is refused, and one read at the expiry instant is not', () => {
  const world = hubWorld();
  const text = asFile(fileOf(world));
  assert.equal(reasonOf(readHubFile(text, new Date(EXPIRES))), 'ok');
  assert.equal(reasonOf(readHubFile(text, new Date(Date.parse(EXPIRES) + 1))), 'expired');
});

test('bad-binding: an X25519 key not bound to the hub\'s signing key is refused, even when the hub signed the file', () => {
  const world = hubWorld();
  const other = hubWorld('OTHER-HUB');
  const base = fileOf(world).payload;
  // The binding signature over the X25519 key by another key, and the hub's own binding signature over another X25519 key.
  const byOtherKey = { ...base, x25519Sig: other.hub.signer.sign(x25519BindingBytes(base.x25519, base.writer)) };
  const otherX25519 = { ...base, x25519: other.hub.x25519 };
  const boundToOtherWriter = { ...base, x25519Sig: world.hub.signer.sign(x25519BindingBytes(base.x25519, other.hub.writer)) };
  for (const payload of [byOtherKey, otherX25519, boundToOtherWriter]) assert.equal(reasonOf(readHubFile(signedAs(world.hub, payload), NOW)), 'bad-binding');
});

test('malformed: wrong keys, a bad address, a bad pin, a hub id or writer that does not match the key, another version and text that is not JSON', () => {
  const world = hubWorld();
  const base = fileOf(world).payload as unknown as Record<string, unknown>;
  const { enrolmentSecret: _dropped, ...missing } = base;
  const cases: Array<[string, unknown]> = [
    ['an extra key', { ...base, note: 'x' }],
    ['a missing key', missing],
    ['an address with no port', { ...base, address: 'hub.example.org' }],
    ['an address that is a URL', { ...base, address: 'https://hub.example.org:8443' }],
    ['a pin that is not 64 hex', { ...base, certPin: 'AB'.repeat(32) }],
    ['a short pin', { ...base, certPin: 'ab'.repeat(31) }],
    ['a hub id of another writer', { ...base, hub: 'hub-0000000000000000' }],
    ['a writer not of the key', { ...base, writer: '0'.repeat(64) }],
    ['an enrolment id that is not enr- and 16 hex', { ...base, enrolment: 'enr-1' }],
    ['a secret that is not 32 bytes', { ...base, enrolmentSecret: randomBytes(16).toString('base64url') }],
    ['another version', { ...base, v: 2 }],
    ['an expiry that is not canonical ISO time', { ...base, expiresAt: '2026-11-27' }]
  ];
  for (const [what, payload] of cases) assert.equal(reasonOf(readHubFile(signedAs(world.hub, payload), NOW)), 'malformed', what);
  // A parsed __proto__ key is an extra key, never a prototype.
  const text = asFile(fileOf(world));
  assert.equal(reasonOf(readHubFile(text.replace('"address":', '"__proto__":{"x":1},"address":'), NOW)), 'malformed');
  for (const input of ['not json', '[]', 'null', '42', '{}']) assert.equal(reasonOf(readHubFile(input, NOW)), 'malformed', input);
  // An invitation, or any other purpose, offered as a hub file is malformed: it is not a hub file.
  const otherPurpose = asFile(signPayload(world.hub.signer, 'staff-invite', base, { now: () => NOW }));
  assert.equal(reasonOf(readHubFile(otherPurpose, NOW)), 'malformed');
});

test('too-large: a hub file over 16 KiB is refused before it is parsed, as text or as a parsed value', () => {
  assert.equal(HUB_FILE_MAX_BYTES, 16 * 1024);
  // Not JSON at all, so only a size check before parsing can give too-large rather than malformed.
  assert.equal(reasonOf(readHubFile('x'.repeat(HUB_FILE_MAX_BYTES + 1), NOW)), 'too-large');
  const world = hubWorld();
  const padded = { ...fileOf(world), padding: 'x'.repeat(HUB_FILE_MAX_BYTES) };
  assert.equal(reasonOf(readHubFile(padded, NOW)), 'too-large');
  assert.equal(reasonOf(readHubFile(asFile(padded), NOW)), 'too-large');
});

test('every hub file refusal is a plain sentence that says what to do, with no em-dash, and no refusal carries the enrolment secret', () => {
  const world = hubWorld();
  const signed = fileOf(world);
  assert.deepEqual(Object.keys(HUB_FILE_REFUSALS).sort(), ['bad-binding', 'bad-signature', 'expired', 'malformed', 'too-large']);
  for (const [reason, message] of Object.entries(HUB_FILE_REFUSALS)) {
    assert.match(message, /^[A-Z][^\u2014]*\.$/, reason);
    assert.match(message, /hub file/, reason);
  }
  const changed = copyOf(signed);
  changed.payload.address = 'hub2.example.org:8443';
  const results = [
    readHubFile(asFile(changed), NOW),
    readHubFile(asFile(signed), new Date(Date.parse(EXPIRES) + 1)),
    readHubFile(signedAs(world.hub, { ...signed.payload, x25519: hubWorld('X').hub.x25519 }), NOW),
    readHubFile(signedAs(world.hub, { ...signed.payload, extra: 1 }), NOW)
  ];
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(world.enrolmentSecret), false);
    assert.equal(JSON.stringify(result).includes(world.hub.x25519Sig), false);
  }
});

test('the hub address is a DNS name, IPv4 or bracketed IPv6 with a port 1 to 65535, at most 253 characters', () => {
  for (const good of ['hub.example.org:8443', 'localhost:1', 'HUB.Example.org:65535', '192.0.2.10:443', '[2001:db8::1]:8443', '[::1]:9000', 'a-b.example.org:80']) {
    assert.equal(isHubAddress(good), true, good);
  }
  const long = `${'a'.repeat(63)}.`.repeat(4).slice(0, 250);
  for (const bad of [
    'hub.example.org', 'hub.example.org:0', 'hub.example.org:65536', 'hub.example.org:0443', 'hub.example.org:', ':8443', '2001:db8::1:8443', '[2001:db8::1]',
    '[hub.example.org]:8443', '999.0.2.10:443', '192.0.2:443', 'hub_1.example.org:443', '-hub.example.org:443', 'hub-.example.org:443', 'hub..example.org:443',
    'hub.example.org.:443', ' hub.example.org:443', 'hub.example.org:443 ', 'https://hub.example.org:443', `${long}.org:443`, `${'a'.repeat(64)}.org:443`, ''
  ]) {
    assert.equal(isHubAddress(bad), false, bad);
  }
  assert.equal(isHubAddress(42), false);
});

test('buildHubFile refuses a bad address, pin, enrolment id or secret, an expiry not after now and a mis-bound X25519 key, in plain words', () => {
  const world = hubWorld();
  const other = hubWorld('OTHER-HUB');
  const cases: Array<[string, Partial<BuildHubFileInput>]> = [
    ['address', { address: 'hub.example.org' }],
    ['pin', { certPin: 'x'.repeat(64) }],
    ['enrolment', { enrolment: 'enrolment-1' }],
    ['secret', { enrolmentSecret: 'short' }],
    ['expiry', { expiresAt: NOW.toISOString() }],
    ['binding', { x25519: other.hub.x25519 }]
  ];
  for (const [what, change] of cases) {
    assert.throws(() => buildHubFile(world.hub.signer, { ...world.input, ...change }), (error: unknown) => {
      assert.ok(error instanceof Error, what);
      assert.match(error.message, /^The hub file was not made: /, what);
      assert.equal(error.message.includes('\u2014'), false);
      assert.equal(error.message.includes(world.enrolmentSecret), false);
      return true;
    }, what);
  }
});

test('D-29: the certificate pin is sha256 hex of the SubjectPublicKeyInfo DER, so two certificates for one key share a pin and a new key changes it', () => {
  const keys = ecKeys();
  const expected = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  assert.equal(spkiPin(keys.publicKey), expected);
  // The pin of the private key is the pin of its public key.
  assert.equal(spkiPin(keys.privateKey), expected);
  assert.equal(spkiPin(createPublicKey(keys.privateKey)), expected);
  const first = certificateDer(keys, { serial: 1, subject: 'hub.example.org', from: '261101000000Z', until: '270101000000Z' });
  const renewed = certificateDer(keys, { serial: 2, subject: 'hub.example.org', from: '261201000000Z', until: '270301000000Z' });
  assert.notDeepEqual(first, renewed);
  assert.notEqual(createHash('sha256').update(first).digest('hex'), createHash('sha256').update(renewed).digest('hex'));
  assert.equal(certPinOf(first), expected);
  assert.equal(certPinOf(pemOf(first)), expected);
  assert.equal(certPinOf(renewed), expected);
  assert.equal(certPinOf(pemOf(renewed)), expected);
  // A certificate with a new key has a new pin.
  const rekeyed = certificateDer(ecKeys(), { serial: 3, subject: 'hub.example.org', from: '261101000000Z', until: '270101000000Z' });
  assert.notEqual(certPinOf(rekeyed), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test('certPinOf refuses text or bytes that are not a certificate with a plain error', () => {
  for (const input of ['not a certificate', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', Buffer.from('nope'), '']) {
    assert.throws(() => certPinOf(input), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^This is not a certificate/);
      assert.equal(error.message.includes('\u2014'), false);
      return true;
    });
  }
});

// ---- The session answer (D-35): a device's signed answer to the hub's challenge, bound to the hub, the project and the TLS connection. ----
interface SessionWorld { hub: RosterDevice; device: RosterDevice; project: string; challenge: Buffer; keying: Buffer; expected: SessionExpectation }

function sessionWorld(): SessionWorld {
  const hub = rosterDevice('HUB', 'hub');
  const device = rosterDevice('LEAD', 'mbr-lead');
  const project = createHash('sha256').update('project/session').digest('hex').slice(0, 32);
  // What the hub draws and what both ends of one TLS connection export (exportKeyingMaterial(SESSION_KEYING_BYTES, SESSION_KEYING_LABEL)).
  const challenge = randomBytes(CHALLENGE_BYTES);
  const keying = randomBytes(SESSION_KEYING_BYTES);
  return { hub, device, project, challenge, keying, expected: { hub: hub.writer, project, challenge, keying } };
}

const answerOf = (world: SessionWorld, overrides: Partial<{ hub: string; project: string; challenge: Buffer | string; keying: Buffer | string }> = {}): SignedPayload<SessionAnswerPayload> =>
  buildSessionAnswer(world.device.signer, { hub: world.hub.writer, project: world.project, challenge: world.challenge, keying: world.keying, now: NOW, ...overrides });

test('tracer: a device answers the hub\'s challenge for one project on one TLS connection, and the hub reads the answer with the device\'s key and writer id', () => {
  assert.equal(SESSION_KEYING_LABEL, 'near-ai-hub-session/v1');
  assert.equal(SESSION_KEYING_BYTES, 32);
  assert.equal(CHALLENGE_BYTES, 32);
  const world = sessionWorld();
  const signed = answerOf(world);
  assert.equal(signed.purpose, 'staff-hub-session');
  assert.deepEqual(signed.payload, { v: 2, hub: world.hub.writer, project: world.project, challenge: world.challenge.toString('base64url'), keying: world.keying.toString('base64url'), features: [] });
  const read = readSessionAnswer(asFile(signed), world.expected);
  assert.deepEqual(read, { ok: true, publicKey: world.device.publicKey, writer: world.device.writer, features: [] });
  // The expected values may be given as bytes or as base64url text, and the answer as text or as a parsed value.
  const asText: SessionExpectation = { ...world.expected, challenge: world.challenge.toString('base64url'), keying: world.keying.toString('base64url') };
  assert.equal(reasonOf(readSessionAnswer(signed, asText)), 'ok');
  assert.equal(reasonOf(readSessionAnswer(answerOf(world, { challenge: world.challenge.toString('base64url') }), world.expected)), 'ok');
});

test('wrong-hub, wrong-project and wrong-challenge: an answer made for another hub, project or challenge is refused, each with its own reason', () => {
  const world = sessionWorld();
  const text = asFile(answerOf(world));
  const other = sessionWorld();
  assert.equal(reasonOf(readSessionAnswer(text, { ...world.expected, hub: rosterDevice('OTHER-HUB', 'hub').writer })), 'wrong-hub');
  assert.equal(reasonOf(readSessionAnswer(text, { ...world.expected, project: '0'.repeat(32) })), 'wrong-project');
  assert.equal(reasonOf(readSessionAnswer(text, { ...world.expected, challenge: other.challenge })), 'wrong-challenge');
});

test('wrong-connection: an answer replayed on another TLS connection, whose keying material differs, is refused even with the same hub, project and challenge', () => {
  const world = sessionWorld();
  const signed = answerOf(world);
  const otherConnection = randomBytes(SESSION_KEYING_BYTES);
  assert.equal(reasonOf(readSessionAnswer(asFile(signed), { ...world.expected, keying: otherConnection })), 'wrong-connection');
  // One bit different is enough.
  const flipped = Buffer.from(world.keying);
  flipped[31] ^= 1;
  assert.equal(reasonOf(readSessionAnswer(asFile(signed), { ...world.expected, keying: flipped })), 'wrong-connection');
  // An expected value of another length is refused the same way, never thrown.
  assert.equal(reasonOf(readSessionAnswer(asFile(signed), { ...world.expected, keying: world.keying.subarray(0, 16) })), 'wrong-connection');
  assert.equal(reasonOf(readSessionAnswer(asFile(signed), { ...world.expected, challenge: world.challenge.subarray(0, 16) })), 'wrong-challenge');
});

test('bad-signature: an answer with any changed field, or re-labelled with another device\'s key, is refused', () => {
  const world = sessionWorld();
  const signed = answerOf(world);
  for (const field of ['hub', 'project', 'challenge', 'keying'] as const) {
    const copy = JSON.parse(asFile(signed)) as SignedPayload<SessionAnswerPayload>;
    // Edited to the value the hub expects from someone else's answer, so only the signature can catch it.
    copy.payload[field] = field === 'hub' ? rosterDevice('OTHER-HUB', 'hub').writer : field === 'project' ? '0'.repeat(32) : randomBytes(32).toString('base64url');
    assert.equal(reasonOf(readSessionAnswer(asFile(copy), { ...world.expected, [field]: field === 'hub' || field === 'project' ? copy.payload[field] : Buffer.from(copy.payload[field], 'base64url') })), 'bad-signature', field);
  }
  const relabelled = JSON.parse(asFile(signed)) as SignedPayload<SessionAnswerPayload>;
  relabelled.signer = { ...answerOf({ ...world, device: rosterDevice('MALLORY', 'mbr-mallory') }).signer };
  assert.equal(reasonOf(readSessionAnswer(asFile(relabelled), world.expected)), 'bad-signature');
});

test('malformed: an answer of the wrong shape, another purpose, text that is not JSON, or an oversized answer is refused malformed', () => {
  const world = sessionWorld();
  const base = answerOf(world).payload as unknown as Record<string, unknown>;
  const sign = (payload: unknown): string => asFile(signPayload(world.device.signer, 'staff-hub-session', payload, { now: () => NOW }));
  const cases: Array<[string, unknown]> = [
    ['an extra key', { ...base, note: 'x' }],
    ['a short challenge', { ...base, challenge: randomBytes(16).toString('base64url') }],
    ['a long keying value', { ...base, keying: randomBytes(48).toString('base64url') }],
    ['a hub that is not a writer id', { ...base, hub: hubIdOf(world.hub.writer) }],
    ['a project that is not a stream id', { ...base, project: 'project-1' }],
    ['the version before features', { ...base, v: 1 }],
    ['a later version', { ...base, v: 3 }]
  ];
  for (const [what, payload] of cases) assert.equal(reasonOf(readSessionAnswer(sign(payload), world.expected)), 'malformed', what);
  const hubFileSigned = asFile(signPayload(world.device.signer, 'staff-hub-file', base, { now: () => NOW }));
  assert.equal(reasonOf(readSessionAnswer(hubFileSigned, world.expected)), 'malformed');
  for (const input of ['not json', 'null', '[]', '{}', 'x'.repeat(64 * 1024)]) assert.equal(reasonOf(readSessionAnswer(input, world.expected)), 'malformed', input.slice(0, 10));
  // buildSessionAnswer refuses what readSessionAnswer would refuse, in plain words.
  for (const overrides of [{ challenge: randomBytes(16) }, { keying: 'short' }, { hub: 'hub-1' }, { project: 'x' }]) {
    assert.throws(() => answerOf(world, overrides), /^Error: The session answer was not made: /);
  }
});

// ---- The features a device announces in its session answer (D-07, D-49, POST-01): signed, sorted, unique, at most MAX_FEATURES name@N ids. ----
const featuresAnswerOf = (world: SessionWorld, features: readonly string[]): SignedPayload<SessionAnswerPayload> =>
  buildSessionAnswer(world.device.signer, { hub: world.hub.writer, project: world.project, challenge: world.challenge, keying: world.keying, features, now: NOW });
// A hand-signed payload, so the reader sees exactly what a hostile device could send.
const signedSession = (world: SessionWorld, payload: unknown): string => asFile(signPayload(world.device.signer, 'staff-hub-session', payload, { now: () => NOW }));
const sessionBase = (world: SessionWorld): Record<string, unknown> => ({ ...(answerOf(world).payload as unknown as Record<string, unknown>) });
const featuresOf = (result: ReturnType<typeof readSessionAnswer>): readonly string[] | undefined => (result.ok ? result.features : undefined);

test('features tracer: a device signs the features it folds, sorted, and the hub reads them back from the answer', () => {
  const world = sessionWorld();
  const signed = featuresAnswerOf(world, ['require@1', 'replica@2']);
  assert.equal(signed.payload.v, 2);
  assert.deepEqual(signed.payload.features, ['replica@2', 'require@1']);
  const read = readSessionAnswer(asFile(signed), world.expected);
  assert.deepEqual(read, { ok: true, publicKey: world.device.publicKey, writer: world.device.writer, features: ['replica@2', 'require@1'] });
  // The whole registry this build folds, as the client will announce it.
  assert.deepEqual(featuresOf(readSessionAnswer(asFile(featuresAnswerOf(world, KNOWN_REPLICA_FEATURES)), world.expected)), [...KNOWN_REPLICA_FEATURES]);
});

test('features: an answer built without features signs an empty list, and a version 2 answer with no features field reads as an empty announcement', () => {
  const world = sessionWorld();
  const built = answerOf(world);
  assert.deepEqual(built.payload.features, []);
  assert.deepEqual(featuresOf(readSessionAnswer(asFile(built), world.expected)), []);
  const base = sessionBase(world);
  delete base.features;
  assert.deepEqual(Object.keys(base).sort(), ['challenge', 'hub', 'keying', 'project', 'v']);
  assert.deepEqual(featuresOf(readSessionAnswer(signedSession(world, base), world.expected)), []);
});

test('features: at most MAX_FEATURES ids; sixteen are read and seventeen are refused malformed, by the reader and the builder', () => {
  assert.equal(MAX_FEATURES, 16);
  const world = sessionWorld();
  const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `f${String(index).padStart(2, '0')}@1`);
  assert.deepEqual(featuresOf(readSessionAnswer(signedSession(world, { ...sessionBase(world), features: ids(16) }), world.expected)), ids(16));
  assert.equal(reasonOf(readSessionAnswer(signedSession(world, { ...sessionBase(world), features: ids(17) }), world.expected)), 'malformed');
  assert.throws(() => featuresAnswerOf(world, ids(17)), /^Error: The session answer was not made: /);
});

test('features: an unsorted list or a duplicate id is refused malformed by the reader, and the builder refuses a duplicate', () => {
  const world = sessionWorld();
  for (const features of [['require@1', 'replica@2'], ['cells@1', 'require@1', 'hub@1'], ['hub@1', 'hub@1'], ['cells@1', 'hub@1', 'hub@1']]) {
    assert.equal(reasonOf(readSessionAnswer(signedSession(world, { ...sessionBase(world), features }), world.expected)), 'malformed', features.join(','));
  }
  assert.throws(() => featuresAnswerOf(world, ['hub@1', 'cells@1', 'hub@1']), /^Error: The session answer was not made: /);
});

test('features: an id that is not name@N, or a features field that is not a list of text, is refused malformed by the reader and the builder', () => {
  const world = sessionWorld();
  const badIds: unknown[] = ['Require@1', 'require', 'require@0', 'require@01', 'require@1000', '1require@1', 'require@1 ', '', 7, null, ['require@1']];
  for (const id of badIds) {
    assert.equal(reasonOf(readSessionAnswer(signedSession(world, { ...sessionBase(world), features: [id] }), world.expected)), 'malformed', String(id));
    if (typeof id === 'string') assert.throws(() => featuresAnswerOf(world, [id]), /^Error: The session answer was not made: /, id);
  }
  for (const features of [null, 'require@1', { 0: 'require@1' }, 1]) {
    assert.equal(reasonOf(readSessionAnswer(signedSession(world, { ...sessionBase(world), features }), world.expected)), 'malformed', JSON.stringify(features));
    assert.throws(() => featuresAnswerOf(world, features as never), /^Error: The session answer was not made: /);
  }
});

test('features: SESSION_VERSION is 2, and a version 1 answer is refused malformed with or without a features field', () => {
  assert.equal(SESSION_VERSION, 2);
  const world = sessionWorld();
  const old = sessionBase(world);
  delete old.features;
  assert.equal(reasonOf(readSessionAnswer(signedSession(world, { ...old, v: 1 }), world.expected)), 'malformed');
  assert.equal(reasonOf(readSessionAnswer(signedSession(world, { ...old, v: 1, features: ['require@1'] }), world.expected)), 'malformed');
  assert.equal(reasonOf(readSessionAnswer(signedSession(world, { ...old, v: '2', features: [] }), world.expected)), 'malformed');
});

test('features: a features list changed after signing, added to or emptied, is caught by the signature', () => {
  const world = sessionWorld();
  const signed = featuresAnswerOf(world, ['replica@2']);
  for (const features of [['replica@2', 'require@1'], [], ['cells@1']]) {
    const copy = JSON.parse(asFile(signed)) as SignedPayload<SessionAnswerPayload>;
    copy.payload.features = features;
    assert.equal(reasonOf(readSessionAnswer(asFile(copy), world.expected)), 'bad-signature', features.join(','));
  }
  // Dropping the field after signing is caught the same way.
  const dropped = JSON.parse(asFile(signed)) as { payload: Record<string, unknown> };
  delete dropped.payload.features;
  assert.equal(reasonOf(readSessionAnswer(asFile(dropped), world.expected)), 'bad-signature');
});

test('features: the builder signs a copy, so a caller changing its list later never changes the answer, and the read features are a fresh list', () => {
  const world = sessionWorld();
  const mine = ['require@1', 'cells@1'];
  const signed = featuresAnswerOf(world, mine);
  mine.push('hub@1');
  mine.sort();
  assert.deepEqual(signed.payload.features, ['cells@1', 'require@1']);
  const parsed = JSON.parse(asFile(signed)) as unknown;
  const read = readSessionAnswer(parsed, world.expected);
  assert.equal(read.ok, true);
  const features = featuresOf(read) as string[];
  assert.notEqual(features, (parsed as { payload: { features: string[] } }).payload.features);
  assert.deepEqual(features, ['cells@1', 'require@1']);
});

test('every session refusal is one plain sentence that says what to do, with no em-dash, and no refusal carries the challenge or the keying material', () => {
  assert.deepEqual(Object.keys(SESSION_REFUSALS).sort(), ['bad-signature', 'malformed', 'wrong-challenge', 'wrong-connection', 'wrong-hub', 'wrong-project']);
  for (const [reason, message] of Object.entries(SESSION_REFUSALS)) {
    assert.match(message, /^[A-Z][^\u2014]*\.$/, reason);
    assert.match(message, /new session/, reason);
  }
  const world = sessionWorld();
  const text = asFile(answerOf(world));
  for (const result of [readSessionAnswer(text, { ...world.expected, keying: randomBytes(32) }), readSessionAnswer(text, { ...world.expected, challenge: randomBytes(32) })]) {
    assert.equal(result.ok, false);
    const shown = JSON.stringify(result);
    assert.equal(shown.includes(world.challenge.toString('base64url')), false);
    assert.equal(shown.includes(world.keying.toString('base64url')), false);
  }
});

// ---- The enrolment MAC (D-41): both sides use the one function. ----
const ENROLMENT_FIELDS: EnrolmentMacFields = {
  enrolment: 'enr-0123456789abcdef',
  hub: 'hub-0123456789abcdef',
  project: createHash('sha256').update('project/enrol').digest('hex').slice(0, 32),
  genesisHash: createHash('sha256').update('genesis/enrol').digest('hex'),
  rosterHead: createHash('sha256').update('roster-head/enrol').digest('hex')
};

test('enrolmentMac is base64url HMAC-SHA256 under the enrolment secret over the canonical bytes of the enrolment id, hub, project, genesis hash and roster head', () => {
  const secret = randomBytes(32).toString('base64url');
  const mac = enrolmentMac(secret, ENROLMENT_FIELDS);
  const expected = createHmac('sha256', Buffer.from(secret, 'base64url')).update(canonicalBytes({ ...ENROLMENT_FIELDS })).digest('base64url');
  assert.equal(mac, expected);
  assert.equal(Buffer.from(mac, 'base64url').length, 32);
  assert.equal(checkEnrolmentMac(secret, ENROLMENT_FIELDS, mac), true);
  // The same fields give the same MAC; an extra property on the input is not covered and changes nothing.
  assert.equal(enrolmentMac(secret, { ...ENROLMENT_FIELDS, extra: 'ignored' } as EnrolmentMacFields), mac);
  assert.throws(() => enrolmentMac('short', ENROLMENT_FIELDS), /^Error: The enrolment check was not made: /);
});

test('checkEnrolmentMac is false for any one field changed, another secret, a MAC of the wrong length or text that is not a MAC, and never throws', () => {
  const secret = randomBytes(32).toString('base64url');
  const mac = enrolmentMac(secret, ENROLMENT_FIELDS);
  const changed: Array<[keyof EnrolmentMacFields, string]> = [
    ['enrolment', 'enr-fedcba9876543210'], ['hub', 'hub-fedcba9876543210'], ['project', '0'.repeat(32)], ['genesisHash', '0'.repeat(64)], ['rosterHead', '1'.repeat(64)]
  ];
  for (const [field, value] of changed) assert.equal(checkEnrolmentMac(secret, { ...ENROLMENT_FIELDS, [field]: value }, mac), false, field);
  assert.equal(checkEnrolmentMac(randomBytes(32).toString('base64url'), ENROLMENT_FIELDS, mac), false);
  const bytes = Buffer.from(mac, 'base64url');
  assert.equal(checkEnrolmentMac(secret, ENROLMENT_FIELDS, bytes.subarray(0, 31).toString('base64url')), false);
  assert.equal(checkEnrolmentMac(secret, ENROLMENT_FIELDS, Buffer.concat([bytes, Buffer.from([0])]).toString('base64url')), false);
  for (const junk of ['', 'not a mac!', 42, null, undefined, { mac }]) assert.equal(checkEnrolmentMac(secret, ENROLMENT_FIELDS, junk as string), false);
  assert.equal(checkEnrolmentMac('short', ENROLMENT_FIELDS, mac), false);
  assert.equal(checkEnrolmentMac(secret, null as unknown as EnrolmentMacFields, mac), false);
});

// ---- 33.2-04 Task 3 (D-03): a hub file may carry the hub's post-quantum keys ----

test('a hub file with kem reads back with it; a lead builds the hub\'s device.kem from it and deviceKemProblem accepts it; a forged kem is bad-binding', () => {
  const world = hubWorld('HUB-KEM');
  const keys = kemPublicFromSeeds({ p256: createHash('sha256').update('hub kem p256').digest(), mlkem768: createHash('sha512').update('hub kem mlkem').digest() });
  const kem = signKemBinding(keys, world.hub.writer, (bytes) => world.hub.signer.sign(bytes));
  const signed = buildHubFile(world.hub.signer, { ...world.input, kem });
  const read = readHubFile(asFile(signed), NOW);
  assert.equal(reasonOf(read), 'ok');
  const file = (read as { ok: true; hubFile: HubFilePayload }).hubFile;
  assert.deepEqual(file.kem, kem);
  const data = hubDeviceKemData(file);
  assert.deepEqual(data, { device: world.hub.writer, ...kem });
  const lead = rosterDevice('LEAD', 'mbr-lead');
  const ctx = { deviceAt: (writer: string) => (writer === world.hub.writer ? { publicKey: world.hub.publicKey } : undefined), isLeadDevice: (writer: string) => writer === lead.writer };
  assert.equal(deviceKemProblem({ signer: lead.writer, roster: 'd'.repeat(64), data: data as NonNullable<typeof data> }, ctx), undefined);
  assert.equal(hubDeviceKemData(fileOf(world).payload), undefined, 'a hub file without kem gives no device.kem');
  const forged = { ...kem, sig: rosterDevice('NOT-HUB', 'hub').signer.sign(Buffer.from('other')) };
  assert.equal(reasonOf(readHubFile(signedAs(world.hub, { ...signed.payload, kem: forged }), NOW)), 'bad-binding');
  assert.throws(() => buildHubFile(world.hub.signer, { ...world.input, kem: forged }), /post-quantum/);
});

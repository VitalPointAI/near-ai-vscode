// The hub's signed shapes (D-29, D-35, D-41, D-51, D-60): the operator's hub file, read the way it arrives, as JSON text from any channel, and the
// certificate pin it carries. One named test per refusal. Keys are generated at run time or derived from labels; no key material is written here.
// The certificates are built here from DER parts and signed with a generated key, so no certificate file and no openssl run is needed.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as dsaSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import test from 'node:test';
import { x25519BindingBytes } from '../domain/replica/cellKeys';
import {
  HUB_FILE_EXTENSION, HUB_FILE_MAX_BYTES, HUB_FILE_REFUSALS, buildHubFile, certPinOf, hubIdOf, isHubAddress, readHubFile, spkiPin
} from '../domain/replica/hubFile';
import type { BuildHubFileInput, HubFilePayload } from '../domain/replica/hubFile';
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
    assert.match(message, /^[A-Z][^—]*\.$/, reason);
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
      assert.equal(error.message.includes('—'), false);
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
      assert.equal(error.message.includes('—'), false);
      return true;
    });
  }
});

// Policy bundle v1 tests (OFFL-02, OFFL-03, CLAS-02, CLAS-05, D-11 to D-15, D-39, D-47): the payload, the shipped default, the routing table, the verifier's
// fail-closed states and the clock rule. Keys are generated at run time; no key material or token literal is written here.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import test from 'node:test';
import { canonicalBytes, fingerprintOf } from '../domain/team/canonical';
import { NO_KNOWN_KEYS } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { signPayload } from '../domain/team/signedPayload';
import type { PayloadPurpose, PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import {
  BUNDLE_FAILURES, FAILED_CLOSED_VERBS, RENEW_WINDOW_DAYS, SELF_SIGNED_LIFETIME_DAYS, bundleHash, defaultBundlePayload, effectiveNow, failedClosed,
  KNOWN_BUNDLE_FEATURES, UPDATE_REASONS, isDefaultBundle, needsRenewal, parseBundle, verifyBundleEnvelope
} from '../domain/gate/bundle';
import type { BundleFailureReason, BundleState, PolicyBundle } from '../domain/gate/bundle';
import { dominates, whyNotDominated } from '../domain/gate/dominance';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { DEFAULT_ROUTING, ROUTING_HANDLING_FLAGS, ROUTING_TIERS, TIER_ORDER, parseRouting } from '../domain/gate/routing';
import { CAPABILITY_VERBS } from '../domain/gate/vocabulary';
import { FEATURE_IDS } from '../domain/gate/features';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function makeSigner(): PayloadSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return {
    fingerprint: fingerprintOf(raw),
    publicKey: raw.toString('base64url'),
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

const activeFor = (signer: PayloadSigner): KeyStatusLookup => (key) => (key.fingerprint === signer.fingerprint ? { state: 'active' } : { state: 'unknown' });

function defaultFor(signer: PayloadSigner, now = NOW): PolicyBundle {
  return defaultBundlePayload({ issuer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey }, now });
}

// Always the one signer, never a second one: signPayload with the purpose policy-bundle and the same time as issuedAt.
function signBundle(signer: PayloadSigner, payload: unknown, now = NOW, purpose: PayloadPurpose = 'policy-bundle'): SignedPayload {
  return signPayload(signer, purpose, payload, { now: () => new Date(now) });
}

test('tracer: the default bundle is signed with the one signer and verifies back to a valid state with its hash', () => {
  const signer = makeSigner();
  const payload = defaultFor(signer);
  const envelope = signBundle(signer, payload);
  assert.equal(envelope.purpose, 'policy-bundle');
  const state = verifyBundleEnvelope(envelope, { status: activeFor(signer), now: NOW });
  assert.equal(state.state, 'valid');
  if (state.state !== 'valid') return;
  assert.equal(state.hash, bundleHash(payload));
  assert.match(state.hash, /^[0-9a-f]{64}$/);
  assert.equal(state.signer.fingerprint, signer.fingerprint);
  assert.equal(state.expiresAt, payload.expiresAt);
  assert.deepEqual(Object.keys(state.bundle.scales).sort(), Object.keys(SCALE_PRESETS).sort());
  assert.deepEqual(state.bundle.clearances, [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [] }]);
  assert.deepEqual(state.bundle.mappings, []);
  assert.equal(DEFAULT_ROUTING.levels['org/Public'], 'any-cloud');
  assert.equal(state.bundle.routing.levels['org/Public'], 'any-cloud');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Helpers for the rest of the file

type Loose = any; // a payload under edit: tests change one value at a time and the shape under test is exactly what is being broken

const DAY = 24 * 60 * 60 * 1000;
const EM_DASH = String.fromCharCode(0x2014);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The default payload for a signer with one edit applied. */
function edited(signer: PayloadSigner, edit: (payload: Loose) => void, now = NOW): Loose {
  const payload: Loose = clone(defaultFor(signer, now));
  edit(payload);
  return payload;
}

function check(envelope: unknown, signer: PayloadSigner, now = NOW, lastValidAt?: number): BundleState {
  return verifyBundleEnvelope(envelope, lastValidAt === undefined ? { status: activeFor(signer), now } : { status: activeFor(signer), now, lastValidAt });
}

function failedWith(state: BundleState): BundleFailureReason {
  assert.equal(state.state, 'failed-closed', 'expected a failed-closed state');
  if (state.state !== 'failed-closed') throw new Error('unreachable');
  assert.equal(state.sentence, BUNDLE_FAILURES[state.reason]);
  return state.reason;
}

function signedDefault(signer: PayloadSigner, now = NOW): SignedPayload {
  return signBundle(signer, defaultFor(signer, now), now);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The default bundle and the routing defaults (D-11, D-24, D-27, D-30, CLAS-02, CLAS-05)

test('the default bundle allows what today allows, ships the four presets, no mapping, org Restricted and an org Public default label', () => {
  const signer = makeSigner();
  const bundle = defaultFor(signer);
  assert.deepEqual(Object.keys(bundle).sort(), [
    'anchorRoots', 'bundleVersion', 'ceiling', 'clearances', 'defaultLabel', 'expiresAt', 'issuedAt', 'issuer', 'mappings', 'maxOfflineAge', 'routing',
    'scales', 'statusLists', 'vocabulary'
  ]);
  assert.equal(bundle.bundleVersion, 1);
  assert.equal(bundle.vocabulary, 1);
  assert.deepEqual(bundle.ceiling.maxMode, { interactive: 'fully-autonomous', unattended: 'fully-autonomous', relay: 'approve-risky', routine: 'approve-risky' });
  assert.deepEqual(bundle.ceiling.unattendedMcp, []);
  const verbs = Object.keys(bundle.ceiling.contexts).sort();
  assert.deepEqual(verbs, [...CAPABILITY_VERBS].filter((verb) => verb !== 'gpu').sort());
  for (const verb of verbs) assert.deepEqual(bundle.ceiling.contexts[verb as keyof typeof bundle.ceiling.contexts], ['interactive', 'unattended'], verb);
  assert.equal(Object.prototype.hasOwnProperty.call(bundle.ceiling.contexts, 'gpu'), false);
  assert.deepEqual(bundle.scales, JSON.parse(JSON.stringify(SCALE_PRESETS)));
  assert.deepEqual(bundle.mappings, []);
  assert.deepEqual(bundle.clearances, [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [] }]);
  assert.deepEqual(bundle.defaultLabel, { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] });
  assert.deepEqual(bundle.routing, JSON.parse(JSON.stringify(DEFAULT_ROUTING)));
  assert.deepEqual(bundle.anchorRoots, []);
  assert.deepEqual(bundle.statusLists, []);
  assert.deepEqual(bundle.maxOfflineAge, {});
  assert.equal(Date.parse(bundle.expiresAt) - Date.parse(bundle.issuedAt), SELF_SIGNED_LIFETIME_DAYS * DAY);
  assert.equal(SELF_SIGNED_LIFETIME_DAYS, 365);
  assert.equal(RENEW_WINDOW_DAYS, 30);
  assert.notEqual(defaultFor(signer), defaultFor(signer), 'a fresh object each call, so a caller cannot change the next one');
  const did = defaultBundlePayload({ issuer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey, did: 'did:key:z6Mkexample' }, now: NOW });
  assert.equal(did.issuer.did, 'did:key:z6Mkexample');
});

test('the default routing table is exactly the CLAS-05 list, with no compartment entries and no local hosts', () => {
  assert.deepEqual({ ...DEFAULT_ROUTING.levels }, {
    'org/Public': 'any-cloud',
    'org/Internal': 'attested-cloud',
    'org/Confidential': 'attested-cloud',
    'org/Restricted': 'local-only',
    'ca-protected/Protected A': 'attested-cloud',
    'ca-protected/Protected B': 'local-only',
    'ca-protected/Protected C': 'local-only',
    'ca-classified/Confidential': 'local-only',
    'ca-classified/Secret': 'local-only',
    'ca-classified/Top Secret': 'local-only',
    'nato/NATO Unclassified': 'attested-cloud',
    'nato/NATO Restricted': 'local-only',
    'nato/NATO Confidential': 'local-only',
    'nato/NATO Secret': 'local-only',
    'nato/Cosmic Top Secret': 'local-only'
  });
  assert.deepEqual({ ...DEFAULT_ROUTING.handling }, { 'local-only': 'local-only' });
  assert.deepEqual({ ...DEFAULT_ROUTING.compartments }, {});
  assert.deepEqual([...DEFAULT_ROUTING.localHosts], []);
  assert.deepEqual([...ROUTING_TIERS], ['any-cloud', 'attested-cloud', 'local-only', 'deny']);
  assert.deepEqual([...ROUTING_HANDLING_FLAGS], ['local-only']);
  const ranks = ROUTING_TIERS.map((tier) => TIER_ORDER[tier]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(TIER_ORDER.deny > TIER_ORDER['local-only'] && TIER_ORDER['local-only'] > TIER_ORDER['attested-cloud'] && TIER_ORDER['attested-cloud'] > TIER_ORDER['any-cloud']);
  // Every level of every preset has an entry, so no level falls through to an unknown tier.
  const keys = Object.keys(SCALE_PRESETS).flatMap((id) => (SCALE_PRESETS[id] as { levels: readonly string[] }).levels.map((level) => `${id}/${level}`));
  assert.deepEqual(Object.keys(DEFAULT_ROUTING.levels).sort(), keys.sort());
});

test('parseRouting refuses unknown tiers, unknown keys, a missing level and any handling key but local-only (D-47, CLAS-05 empty)', () => {
  const ok = parseRouting(clone(DEFAULT_ROUTING), SCALE_PRESETS);
  assert.equal(ok.ok, true);
  const reasonOfRouting = (edit: (table: Loose) => void): string => {
    const table: Loose = clone(DEFAULT_ROUTING);
    edit(table);
    const parsed = parseRouting(table, SCALE_PRESETS);
    return parsed.ok ? 'ok' : parsed.reason;
  };
  assert.equal(reasonOfRouting((t) => { t.levels['org/Public'] = 'anywhere'; }), 'not-allowed-here');
  assert.equal(reasonOfRouting((t) => { t.levels['org/Public'] = 3; }), 'wrong-type');
  assert.equal(reasonOfRouting((t) => { delete t.levels['nato/Cosmic Top Secret']; }), 'missing-field');
  assert.equal(reasonOfRouting((t) => { t.levels['org/Secret'] = 'deny'; }), 'unknown-field');
  assert.equal(reasonOfRouting((t) => { t.surprise = {}; }), 'unknown-field');
  assert.equal(reasonOfRouting((t) => { delete t.localHosts; }), 'missing-field');
  assert.equal(reasonOfRouting((t) => { t.handling = {}; }), 'ok');
  assert.equal(reasonOfRouting((t) => { t.handling['no-agent-tools'] = 'deny'; }), 'unknown-field');
  assert.equal(reasonOfRouting((t) => { t.handling['attested-cloud-ok'] = 'attested-cloud'; }), 'unknown-field');
  assert.equal(reasonOfRouting((t) => { t.handling.other = 'deny'; }), 'unknown-field');
  assert.equal(reasonOfRouting((t) => { t.handling['local-only'] = 'sideways'; }), 'not-allowed-here');
  assert.equal(reasonOfRouting((t) => { t.compartments = { ABC: 'deny' }; }), 'ok');
  assert.equal(reasonOfRouting((t) => { t.compartments = { abc: 'deny' }; }), 'wrong-type');
  assert.equal(reasonOfRouting((t) => { t.compartments = { ABC: 'nope' }; }), 'not-allowed-here');
  assert.equal(reasonOfRouting((t) => { t.localHosts = ['models.example.com', '*.lan.example.com']; }), 'ok');
  assert.equal(reasonOfRouting((t) => { t.localHosts = ['*']; }), 'not-allowed-here');
  assert.equal(reasonOfRouting((t) => { t.localHosts = ['a.example.com', 'a.example.com']; }), 'duplicate');
  assert.equal(reasonOfRouting((t) => { t.localHosts = ['https://a.example.com']; }), 'wrong-type');
  assert.equal(parseRouting('nope', SCALE_PRESETS).ok, false);
  assert.equal(parseRouting(JSON.parse('{"levels":{},"handling":{},"compartments":{},"localHosts":[],"__proto__":{"x":1}}'), SCALE_PRESETS).ok, false);
  const hostile = parseRouting(JSON.parse('{"levels":{"__proto__":"deny"},"handling":{},"compartments":{},"localHosts":[]}'), SCALE_PRESETS);
  assert.equal(hostile.ok, false);
  assert.equal(({} as Loose).polluted, undefined);
});

test('with no mapping a clearance never covers another scale, and an empty compartment map changes no tier (CLAS-02, CLAS-05 empty)', () => {
  const signer = makeSigner();
  const state = check(signedDefault(signer), signer);
  assert.equal(state.state, 'valid');
  if (state.state !== 'valid') return;
  const { bundle } = state;
  const context = { scales: bundle.scales, mappings: bundle.mappings, now: NOW };
  const clearance = bundle.clearances[0];
  const protectedA = { scale: 'ca-protected', level: 'Protected A', compartments: [], releasability: [], handling: [] };
  const restricted = { scale: 'org', level: 'Restricted', compartments: [], releasability: [], handling: [] };
  assert.equal(dominates(clearance, restricted, context), true);
  assert.equal(whyNotDominated(clearance, protectedA, context), 'scale');
  assert.deepEqual({ ...bundle.routing.compartments }, {});
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Shape: closed keys, reserved fields, numbers (OFFL-03, D-12)

test('a bundle with any key outside the fourteen, at any level, is refused', () => {
  const signer = makeSigner();
  const cases: Array<[string, (payload: Loose) => void, BundleFailureReason]> = [
    ['top level', (p) => { p.extra = 1; }, 'unknown-field'],
    ['issuer', (p) => { p.issuer.extra = 'x'; }, 'unknown-field'],
    ['ceiling', (p) => { p.ceiling.extra = []; }, 'unknown-field'],
    ['maxMode', (p) => { p.ceiling.maxMode.extra = 'auto'; }, 'unknown-field'],
    ['a scale', (p) => { p.scales.org.extra = 'x'; }, 'unknown-field'],
    ['a clearance', (p) => { p.clearances[0].extra = 'x'; }, 'unknown-field'],
    ['the default label', (p) => { p.defaultLabel.extra = 'x'; }, 'unknown-field'],
    ['routing', (p) => { p.routing.extra = {}; }, 'unknown-field'],
    ['a verb that is not in the vocabulary', (p) => { p.ceiling.contexts.teleport = ['interactive']; }, 'unknown-field'],
    ['a context that is not known', (p) => { p.ceiling.contexts.read = ['interactive', 'weekend']; }, 'wrong-type']
  ];
  for (const [name, edit, reason] of cases) {
    assert.equal(failedWith(check(signBundle(signer, edited(signer, edit)), signer)), reason, name);
  }
});

test('reserved fields present and empty are valid, and a bundle missing any of the fourteen fields is refused (absent is not empty)', () => {
  const signer = makeSigner();
  const state = check(signedDefault(signer), signer);
  assert.equal(state.state, 'valid');
  for (const field of ['bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'ceiling', 'scales', 'mappings', 'clearances', 'routing', 'defaultLabel', 'anchorRoots', 'statusLists', 'maxOfflineAge']) {
    const payload = edited(signer, (p) => { delete p[field]; });
    const parsed = parseBundle(payload);
    assert.equal(parsed.ok, false, field);
    if (!parsed.ok) assert.equal(parsed.reason, 'missing-field', field);
    assert.equal(failedWith(check(signBundle(signer, payload), signer)), 'wrong-type', field);
  }
});

test('reserved fields are shape-checked: anchor roots, status lists and maximum offline age', () => {
  const signer = makeSigner();
  const hex = 'ab'.repeat(32);
  const reasonOf = (edit: (payload: Loose) => void): string => {
    const parsed = parseBundle(edited(signer, edit));
    return parsed.ok ? 'ok' : parsed.reason;
  };
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex, proof: [] }]; }), 'ok');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex, proof: [hex, hex] }]; }), 'ok');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex, proof: Array.from({ length: 64 }, () => hex) }]; }), 'ok');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex, proof: Array.from({ length: 65 }, () => hex) }]; }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex.toUpperCase(), proof: [] }]; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex.slice(1), proof: [] }]; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex, proof: ['zz'] }]; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex }]; }), 'missing-field');
  assert.equal(reasonOf((p) => { p.anchorRoots = [{ root: hex, proof: [], extra: 1 }]; }), 'unknown-field');
  assert.equal(reasonOf((p) => { p.anchorRoots = 'none'; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.statusLists = [{ uri: 'https://status.example.com/list/1', purpose: 'revocation' }]; }), 'ok');
  assert.equal(reasonOf((p) => { p.statusLists = [{ uri: 'http://status.example.com/list/1', purpose: 'revocation' }]; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.statusLists = [{ uri: 'https://status.example.com/a b', purpose: 'revocation' }]; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.statusLists = [{ uri: 'https://status.example.com/x', purpose: 'Revocation!' }]; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.statusLists = [{ uri: 'https://status.example.com/x' }]; }), 'missing-field');
  assert.equal(reasonOf((p) => { p.maxOfflineAge = { 'org/Restricted': 3600, 'nato/NATO Secret': 0 }; }), 'ok');
  assert.equal(reasonOf((p) => { p.maxOfflineAge = { 'org/Nothing': 3600 }; }), 'unknown-field');
  assert.equal(reasonOf((p) => { p.maxOfflineAge = { org: 3600 }; }), 'unknown-field');
  assert.equal(reasonOf((p) => { p.maxOfflineAge = { 'org/Restricted': '3600' }; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.maxOfflineAge = []; }), 'wrong-type');
});

test('every number is a safe whole number: a fraction, a negative, negative zero and a number past the safe limit are refused (OFFL-03 precision)', () => {
  const signer = makeSigner();
  const attempts: unknown[] = [1.5, -1, -0, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY, 0.1];
  for (const value of attempts) {
    const payload = edited(signer, (p) => { p.maxOfflineAge = { 'org/Restricted': value }; });
    const parsed = parseBundle(payload);
    assert.equal(parsed.ok, false, String(value));
    if (!parsed.ok) assert.equal(parsed.reason, 'wrong-type', String(value));
  }
  // A number where the shape takes none is refused by the same check, and a fraction in a version field too.
  assert.equal(parseBundle(edited(signer, (p) => { p.bundleVersion = 1.5; })).ok, false);
  assert.equal(parseBundle(edited(signer, (p) => { p.vocabulary = -1; })).ok, false);
  assert.equal(parseBundle(edited(signer, (p) => { p.defaultLabel.level = 7; })).ok, false);
  // Signing refuses a fraction before any signature is made, with a plain message from the one signer.
  assert.throws(() => signBundle(signer, edited(signer, (p) => { p.maxOfflineAge = { 'org/Restricted': 1.5 }; })), /whole numbers/);
  assert.equal(parseBundle(edited(signer, (p) => { p.maxOfflineAge = { 'org/Restricted': Number.MAX_SAFE_INTEGER }; })).ok, true);
});

test('timestamps, the DID slot, scales and lists follow their limits', () => {
  const signer = makeSigner();
  const reasonOf = (edit: (payload: Loose) => void): string => {
    const parsed = parseBundle(edited(signer, edit));
    return parsed.ok ? 'ok' : parsed.reason;
  };
  assert.equal(reasonOf(() => undefined), 'ok');
  assert.equal(reasonOf((p) => { p.issuedAt = '2026-11-16T12:00:00Z'; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.issuedAt = '2026-02-30T12:00:00.000Z'; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.expiresAt = p.issuedAt; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.expiresAt = '2020-01-01T00:00:00.000Z'; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.issuer.did = 'did:key:z6Mkexample'; }), 'ok');
  assert.equal(reasonOf((p) => { p.issuer.did = 'not a did'; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.issuer.publicKey = 'short'; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.issuer.fingerprint = ''; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.bundleVersion = 2; }), 'unknown-version');
  assert.equal(reasonOf((p) => { p.vocabulary = 2; }), 'unknown-version');
  assert.equal(reasonOf((p) => { p.scales = {}; }), 'empty-list');
  assert.equal(reasonOf((p) => { p.scales.org.levels = []; }), 'empty-list');
  assert.equal(reasonOf((p) => { p.scales.org.levels = ['Public', 'Public', 'Internal', 'Confidential', 'Restricted']; }), 'duplicate');
  assert.equal(reasonOf((p) => { p.scales.Bad_Id = p.scales.org; }), 'wrong-type');
  assert.equal(reasonOf((p) => { p.scales.org.levels = Array.from({ length: 17 }, (_, index) => `L${String(index)}`); }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { for (let index = 0; index < 13; index += 1) p.scales[`extra-${String(index)}`] = { name: 'x', levels: ['a'] }; }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { p.ceiling.unattendedMcp = ['filesystem', 'git']; }), 'ok');
  assert.equal(reasonOf((p) => { p.ceiling.unattendedMcp = ['*']; }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { p.ceiling.unattendedMcp = ['git', 'git']; }), 'duplicate');
  assert.equal(reasonOf((p) => { p.ceiling.maxMode.interactive = 'yolo'; }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { delete p.ceiling.maxMode.relay; }), 'missing-field');
  assert.equal(reasonOf((p) => { p.ceiling.contexts.read = ['interactive', 'interactive']; }), 'duplicate');
  assert.equal(reasonOf((p) => { p.ceiling.contexts.read = []; }), 'ok');
  assert.equal(reasonOf((p) => { p.clearances = [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [] }, ...Array.from({ length: 64 }, () => ({ scale: 'org', level: 'Public', compartments: [], releasability: [] }))]; }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { p.mappings = [{ from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'ca-protected', level: 'Protected A' } }]; }), 'ok');
  assert.equal(reasonOf((p) => { p.mappings = [{ from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'org', level: 'Public' } }]; }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { p.defaultLabel.level = 'Secret'; }), 'not-allowed-here');
  assert.equal(reasonOf((p) => { p.routing.levels['org/Public'] = 'moon'; }), 'not-allowed-here');
  assert.equal(parseBundle('nope').ok, false);
  assert.equal(parseBundle(null).ok, false);
  assert.equal(parseBundle([]).ok, false);
  const proto = parseBundle(JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(clone(defaultFor(signer))).slice(1)}`));
  assert.equal(proto.ok, false);
  assert.equal(({} as Loose).x, undefined);
});

test('bundle times use the one form clearance expiries use: exactly three fraction digits, a capital Z and a real date', () => {
  const signer = makeSigner();
  const reasonOf = (edit: (payload: Loose) => void): string => {
    const parsed = parseBundle(edited(signer, edit));
    return parsed.ok ? 'ok' : parsed.reason;
  };
  const expiryReason = (text: string): string => reasonOf((p) => { p.clearances = [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [], expiresAt: text }]; });
  const accepted = ['2030-01-31T23:59:59.000Z', '2030-01-31T23:59:59.250Z', '2028-02-29T12:00:00.001Z'];
  const refusedForms = [
    '2030-01-31T23:59:59Z', '2030-01-31T23:59:59.5Z', '2030-01-31T23:59:59.25Z', '2030-01-31T23:59:59.2500Z', '2030-01-31T23:59:59.250z',
    '2030-01-31T23:59:59.250+00:00', '2030-01-31T23:59:59.250+02:00', '2030-01-31T23:59:59.250', '2030-02-29T00:00:00.000Z'
  ];
  for (const text of accepted) {
    assert.equal(expiryReason(text), 'ok', text);
    assert.equal(reasonOf((p) => { p.issuedAt = text; p.expiresAt = '2099-01-01T00:00:00.000Z'; }), 'ok', text);
    assert.equal(reasonOf((p) => { p.expiresAt = text; p.issuedAt = '2000-01-01T00:00:00.000Z'; }), 'ok', text);
  }
  for (const text of refusedForms) {
    assert.equal(expiryReason(text), 'wrong-type', `clearance ${text}`);
    assert.equal(reasonOf((p) => { p.issuedAt = text; }), 'wrong-type', `issuedAt ${text}`);
    assert.equal(reasonOf((p) => { p.expiresAt = text; }), 'wrong-type', `expiresAt ${text}`);
  }
});

test('a clearance or a mapping listed twice is refused as a duplicate, and an out of order list is refused, so one meaning has one hash', () => {
  const signer = makeSigner();
  const reasonOf = (edit: (payload: Loose) => void): string => {
    const parsed = parseBundle(edited(signer, edit));
    return parsed.ok ? 'ok' : parsed.reason;
  };
  const restricted = { scale: 'org', level: 'Restricted', compartments: [], releasability: [] };
  const internal = { scale: 'org', level: 'Internal', compartments: [], releasability: [] };
  assert.equal(reasonOf((p) => { p.clearances = [restricted, { ...restricted }]; }), 'duplicate');
  assert.equal(reasonOf((p) => { p.clearances = [internal, restricted, { ...internal }]; }), 'duplicate', 'a repeat that is not next to its first is still a duplicate');
  assert.equal(reasonOf((p) => { p.clearances = [{ ...restricted, expiresAt: '2030-01-01T00:00:00.000Z' }, { ...restricted, expiresAt: '2030-01-01T00:00:00.000Z' }]; }), 'duplicate');
  const mapA = { from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'ca-protected', level: 'Protected A' } };
  const mapB = { from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'ca-protected', level: 'Protected B' } };
  assert.equal(reasonOf((p) => { p.mappings = [mapA, { from: { ...mapA.from }, covers: { ...mapA.covers } }]; }), 'duplicate');
  assert.equal(reasonOf((p) => { p.mappings = [mapA, mapB, { ...mapA }]; }), 'duplicate');
  // Entries that differ in any content are not duplicates: a different expiry, a different level, a different mapping end.
  assert.equal(reasonOf((p) => { p.clearances = [restricted, { ...restricted, expiresAt: '2030-01-01T00:00:00.000Z' }]; }), 'ok');
  assert.equal(reasonOf((p) => { p.clearances = [internal, restricted]; }), 'ok');
  assert.equal(reasonOf((p) => { p.mappings = [mapA, mapB]; }), 'ok');
  // Order is not meaning (the dominance property test shows it), so one order is the only valid one: the reverse is refused, never a second hash.
  assert.equal(reasonOf((p) => { p.clearances = [restricted, internal]; }), 'not-sorted');
  assert.equal(reasonOf((p) => { p.mappings = [mapB, mapA]; }), 'not-sorted');
});

test('two bundles that mean the same thing have the same hash: key order never changes it, and the one reordering that could (a list) is refused', () => {
  const signer = makeSigner();
  const restricted = { scale: 'org', level: 'Restricted', compartments: [], releasability: [] };
  const internal = { scale: 'org', level: 'Internal', compartments: [], releasability: [] };
  const mapA = { from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'ca-protected', level: 'Protected A' } };
  const mapB = { from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'ca-protected', level: 'Protected B' } };
  const forward = edited(signer, (p) => { p.clearances = [internal, restricted]; p.mappings = [mapA, mapB]; });
  const backward = edited(signer, (p) => { p.clearances = [restricted, internal]; p.mappings = [mapB, mapA]; });
  const first = parseBundle(forward);
  assert.equal(first.ok, true);
  assert.equal(parseBundle(backward).ok, false, 'the reordered twin cannot exist as a valid bundle');
  // Same content with every object's keys written in the opposite order: valid, and the same hash.
  const flipKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(flipKeys);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, inner]) => [key, flipKeys(inner)]));
    }
    return value;
  };
  const flipped = flipKeys(forward);
  const second = parseBundle(flipped);
  assert.equal(second.ok, true);
  assert.equal(bundleHash(first.ok ? first.value : undefined), bundleHash(second.ok ? second.value : undefined));
  assert.equal(bundleHash(forward), bundleHash(flipped));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The hash (OFFL-03 ordering)

test('bundleHash is the SHA-256 of the canonical bytes: key order does not change it and one changed value does', () => {
  const signer = makeSigner();
  const payload = defaultFor(signer);
  const expected = createHash('sha256').update(canonicalBytes(payload)).digest('hex');
  assert.equal(bundleHash(payload), expected);
  const reversed = JSON.parse(JSON.stringify(payload, null, 2), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>).reverse();
      return Object.fromEntries(entries);
    }
    return value;
  }) as unknown;
  assert.notEqual(JSON.stringify(reversed), JSON.stringify(payload));
  assert.equal(bundleHash(reversed), expected);
  const changed = clone(payload) as Loose;
  changed.defaultLabel.level = 'Internal';
  assert.notEqual(bundleHash(changed), expected);
  const dated = clone(payload) as Loose;
  dated.expiresAt = new Date(Date.parse(payload.expiresAt) + 1).toISOString();
  assert.notEqual(bundleHash(dated), expected);
  const state = check(signedDefault(signer), signer);
  assert.equal(state.state === 'valid' ? state.hash : '', expected);
  assert.equal(state.state === 'valid' ? bundleHash(state.bundle) : '', expected, 'the parsed bundle hashes the same as the signed payload');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The signer, the verifier and the failure states (OFFL-02, D-13)

test('changing one byte after signing fails closed with the bad-signature sentence', () => {
  const signer = makeSigner();
  const envelope = clone(signedDefault(signer)) as Loose;
  envelope.payload.defaultLabel.level = 'Internal';
  const state = check(envelope, signer);
  assert.equal(failedWith(state), 'bad-signature');
  assert.equal(state.state === 'failed-closed' ? state.sentence : '', 'Your policy file was changed outside NEAR AI. Run NEAR AI: Reset Policy to Defaults to sign a fresh one.');
});

test('the same envelope offered for another purpose is refused, and a revoked or rotated key fails closed', () => {
  const signer = makeSigner();
  const asGrant = signBundle(signer, defaultFor(signer), NOW, 'grant');
  assert.equal(failedWith(check(asGrant, signer)), 'wrong-purpose');
  const revoked: KeyStatusLookup = () => ({ state: 'revoked' });
  assert.equal(failedWith(verifyBundleEnvelope(signedDefault(signer), { status: revoked, now: NOW })), 'key-revoked');
  const rotatedBefore: KeyStatusLookup = () => ({ state: 'rotated', since: new Date(NOW - DAY).toISOString() });
  assert.equal(failedWith(verifyBundleEnvelope(signedDefault(signer), { status: rotatedBefore, now: NOW })), 'key-rotated');
  // A bundle signed before the rotation still verifies; the rotation only refuses what was signed at or after it.
  const rotatedAfter: KeyStatusLookup = () => ({ state: 'rotated', since: new Date(NOW + DAY).toISOString() });
  assert.equal(verifyBundleEnvelope(signedDefault(signer), { status: rotatedAfter, now: NOW + 2 * DAY }).state, 'valid');
  assert.equal(failedWith(verifyBundleEnvelope(signedDefault(signer), { status: () => ({ state: 'unknown' }), now: NOW })), 'unknown-key');
});

test('garbage never throws and always fails closed', () => {
  const signer = makeSigner();
  for (const value of [null, 5, 'text', [], {}, { v: 1 }, true, JSON.parse('{"__proto__":{"v":1}}')]) {
    assert.equal(check(value, signer).state, 'failed-closed');
  }
  const cyclic: Loose = {};
  cyclic.self = cyclic;
  assert.equal(check(cyclic, signer).state, 'failed-closed');
  assert.equal(check(undefined, signer).state, 'failed-closed');
  assert.equal(isDefaultBundle(cyclic), false);
});

// One test per reason: every key of BUNDLE_FAILURES is produced the way it happens in life, and the table below must name them all.
const REASON_PRODUCERS: Record<BundleFailureReason, (signer: PayloadSigner) => BundleState> = {
  missing: (signer) => check(undefined, signer),
  unparseable: () => failedClosed('unparseable'),
  malformed: (signer) => check({}, signer),
  'unsupported-version': (signer) => check({ ...signedDefault(signer), v: 2 }, signer),
  'unknown-purpose': (signer) => check({ ...signedDefault(signer), purpose: 'nonsense' }, signer),
  'wrong-purpose': (signer) => check(signBundle(signer, defaultFor(signer), NOW, 'grant'), signer),
  'too-large': (signer) => {
    const payload = edited(signer, (p) => { p.pad = 'x'.repeat(300_000); });
    return check(signPayload(signer, 'policy-bundle', payload, { now: () => new Date(NOW), maxBytes: 1024 * 1024 }), signer);
  },
  'key-mismatch': (signer) => check({ ...signedDefault(signer), signer: { fingerprint: `${signer.fingerprint}x`, publicKey: signer.publicKey } }, signer),
  'bad-signature': (signer) => {
    const envelope = clone(signedDefault(signer)) as Loose;
    envelope.payload.expiresAt = new Date(NOW + 10 * 365 * DAY).toISOString();
    return check(envelope, signer);
  },
  // Produced by the store, which knows the last-valid hash; src/test/gateBundleTrust.test.ts reaches it through a replaced file on disk.
  replaced: () => failedClosed('replaced'),
  'unknown-key': (signer) => verifyBundleEnvelope(signedDefault(signer), { status: NO_KNOWN_KEYS, now: NOW }),
  'key-revoked': (signer) => verifyBundleEnvelope(signedDefault(signer), { status: () => ({ state: 'revoked' }), now: NOW }),
  'key-rotated': (signer) => verifyBundleEnvelope(signedDefault(signer), { status: () => ({ state: 'rotated', since: new Date(NOW - 1000).toISOString() }), now: NOW }),
  expired: (signer) => check(signedDefault(signer), signer, NOW + 366 * DAY),
  'vocabulary-unknown': (signer) => check(signBundle(signer, edited(signer, (p) => { p.vocabulary = 2; })), signer),
  'unknown-field': (signer) => check(signBundle(signer, edited(signer, (p) => { p.extra = true; })), signer),
  'needs-update': (signer) => check(signBundle(signer, edited(signer, (p) => { p.requires = ['org-layer']; })), signer),
  'wrong-type': (signer) => check(signBundle(signer, edited(signer, (p) => { p.issuedAt = 'yesterday'; })), signer),
  'signer-mismatch': (signer) => {
    const other = makeSigner();
    const payload = defaultBundlePayload({ issuer: { fingerprint: other.fingerprint, publicKey: other.publicKey }, now: NOW });
    return check(signBundle(signer, payload), signer);
  },
  'clock-behind': (signer) => check(signedDefault(signer, NOW + DAY), signer),
  'no-identity': () => failedClosed('no-identity'),
  'identity-unavailable': () => failedClosed('identity-unavailable'),
  'not-loaded': () => failedClosed('not-loaded'),
  unavailable: () => failedClosed('unavailable')
};

test('every failure reason has a producer in this file, so none is untested', () => {
  assert.deepEqual(Object.keys(REASON_PRODUCERS).sort(), Object.keys(BUNDLE_FAILURES).sort());
  assert.equal(Object.keys(BUNDLE_FAILURES).length, 24);
});

for (const reason of Object.keys(BUNDLE_FAILURES) as BundleFailureReason[]) {
  test(`failure reason ${reason}: failed-closed with one plain sentence naming the fix`, () => {
    const signer = makeSigner();
    const state = (REASON_PRODUCERS[reason] as (signer: PayloadSigner) => BundleState)(signer);
    assert.equal(state.state, 'failed-closed');
    if (state.state !== 'failed-closed') return;
    assert.equal(state.reason, reason);
    assert.equal(state.sentence, BUNDLE_FAILURES[reason]);
    assert.ok(state.sentence.endsWith('.'), 'one sentence-like line');
    assert.ok(!state.sentence.includes('\n'));
    if (reason === 'identity-unavailable') {
      assert.equal(state.sentence, 'NEAR AI could not save its signing key on this computer, so only reading and planning are allowed until it can.');
    } else if (reason === 'not-loaded') {
      assert.match(state.sentence, /Start the run again in a moment, or reload the window\.$/);
    } else if (reason === 'unavailable') {
      assert.match(state.sentence, /Reload the window to try again\.$/);
    } else if (reason === 'clock-behind') {
      assert.match(state.sentence, /Set the clock to the right time, then reload the window\.$/);
    } else if (reason === 'unknown-field') {
      // PR #143 review: a newer version's setting and a hand edit look alike here, so the sentence names both ways on and points at Show Policy, which
      // offers Reset only for the person's own policy.
      assert.match(state.sentence, /If a newer version of NEAR AI wrote it, update the extension\. If you changed your own policy by hand, NEAR AI: Show Policy says how to go back\.$/);
      assert.ok(!/Reset/.test(state.sentence), state.sentence);
    } else if (UPDATE_REASONS.has(reason)) {
      // Coherence review S6: a policy written for a newer version is fixed by updating; Reset would discard an organization's rules, so it is never offered.
      assert.match(state.sentence, /Update the NEAR AI extension to use it\. Until then only reading and planning run, and your policy file is left as it is\.$/);
      assert.ok(!/Reset/.test(state.sentence), state.sentence);
    } else {
      assert.match(state.sentence, /Run NEAR AI: Reset Policy to Defaults to sign a fresh one\.$/);
    }
  });
}

test('no sentence has an em-dash or the words NEAR organization, and the closed list names what a failed gate still allows', () => {
  for (const sentence of Object.values(BUNDLE_FAILURES)) {
    assert.ok(!sentence.includes(EM_DASH), sentence);
    assert.ok(!sentence.includes('NEAR organization'), sentence);
  }
  assert.deepEqual([...FAILED_CLOSED_VERBS], ['read', 'plan']);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The signer must be the signer, and the clock rule (D-12, D-15, OFFL-03 boundary and adjacency)

test('the payload issuer must equal the envelope signer and issuedAt must equal signedAt, character for character', () => {
  const signer = makeSigner();
  const flipLast = (text: string): string => text.slice(0, -1) + (text.endsWith('A') ? 'B' : 'A');
  // A public key is 32 bytes in 43 characters, so the last character carries two bits that decoding ignores: flipping it can change nothing the decoder sees,
  // and the key then reads as malformed instead of as another signer's (about 6 keys in 100). Changing a decoded byte and encoding it again always gives a
  // well-formed key that is a different key.
  const otherKey = (key: string): string => {
    const bytes = Buffer.from(key, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    return bytes.toString('base64url');
  };
  const cases: Array<[string, (payload: Loose) => void]> = [
    ['fingerprint', (p) => { p.issuer.fingerprint = flipLast(p.issuer.fingerprint); }],
    ['public key', (p) => { p.issuer.publicKey = otherKey(p.issuer.publicKey); }],
    ['issuedAt, one millisecond', (p) => { p.issuedAt = new Date(Date.parse(p.issuedAt) + 1).toISOString(); }]
  ];
  for (const [name, edit] of cases) {
    const state = check(signBundle(signer, edited(signer, edit)), signer);
    assert.equal(failedWith(state), 'signer-mismatch', name);
  }
  assert.equal(check(signedDefault(signer), signer).state, 'valid');
});

test('expiry boundary: valid one millisecond before expiresAt, expired at exactly expiresAt', () => {
  const signer = makeSigner();
  const envelope = signedDefault(signer);
  const expiresAt = Date.parse(defaultFor(signer).expiresAt);
  assert.equal(check(envelope, signer, expiresAt - 1).state, 'valid');
  assert.equal(failedWith(check(envelope, signer, expiresAt)), 'expired');
  assert.equal(failedWith(check(envelope, signer, expiresAt + 1)), 'expired');
});

test('turning the clock back never revives an expired bundle (D-15)', () => {
  const signer = makeSigner();
  const envelope = signedDefault(signer);
  const expiresAt = Date.parse(defaultFor(signer).expiresAt);
  // This install last saw a valid bundle after expiry was reached; the wall clock now says it is much earlier.
  assert.equal(failedWith(check(envelope, signer, NOW + DAY, expiresAt + DAY)), 'expired');
  assert.equal(effectiveNow(NOW, expiresAt + DAY), expiresAt + DAY);
  assert.equal(effectiveNow(NOW, NOW - DAY), NOW, 'an earlier last-valid time changes nothing');
  assert.equal(effectiveNow(NOW, undefined), NOW);
  assert.equal(effectiveNow(NOW, Number.NaN), NOW);
  assert.ok(Number.isNaN(effectiveNow(Number.NaN, NOW)));
  assert.equal(failedWith(verifyBundleEnvelope(envelope, { status: activeFor(signer), now: Number.NaN })), 'clock-behind');
});

test('an issuedAt more than five minutes after the effective time is refused as clock-behind', () => {
  const signer = makeSigner();
  const fiveMinutes = 5 * 60 * 1000;
  assert.equal(check(signedDefault(signer, NOW + fiveMinutes), signer).state, 'valid');
  assert.equal(failedWith(check(signedDefault(signer, NOW + fiveMinutes + 1), signer)), 'clock-behind');
  // A recorded later time counts as the effective time, so a bundle issued before it is not "from the future".
  assert.equal(check(signedDefault(signer, NOW + DAY), signer, NOW, NOW + DAY).state, 'valid');
});

test('renewal starts at exactly expiresAt minus 30 days and stops at expiry (D-14)', () => {
  const signer = makeSigner();
  const bundle = defaultFor(signer);
  const expiresAt = Date.parse(bundle.expiresAt);
  const start = expiresAt - RENEW_WINDOW_DAYS * DAY;
  assert.equal(needsRenewal(bundle, start - 1), false);
  assert.equal(needsRenewal(bundle, start), true);
  assert.equal(needsRenewal(bundle, expiresAt - 1), true);
  assert.equal(needsRenewal(bundle, expiresAt), false);
  assert.equal(needsRenewal(bundle, NOW), false);
  assert.equal(needsRenewal(bundle, start - DAY, start), true, 'the recorded time counts');
  assert.equal(needsRenewal(bundle, Number.NaN), false);
  const envelope = signedDefault(signer);
  const early = check(envelope, signer, start - 1);
  const late = check(envelope, signer, start);
  assert.equal(early.state === 'valid' ? early.renewDue : undefined, false);
  assert.equal(late.state === 'valid' ? late.renewDue : undefined, true);
  assert.equal(check(envelope, signer, expiresAt).state, 'failed-closed', 'an expired bundle is not valid, so it is never renew-due');
});

test('isDefaultBundle is true only for a bundle equal to the default apart from issuer, issuedAt and expiresAt (D-39)', () => {
  const signer = makeSigner();
  const other = makeSigner();
  const base = defaultFor(signer);
  assert.equal(isDefaultBundle(base), true);
  const elsewhere = defaultBundlePayload({ issuer: { fingerprint: other.fingerprint, publicKey: other.publicKey }, now: NOW + 5 * DAY });
  assert.equal(isDefaultBundle(elsewhere), true);
  const customised: Array<[string, (payload: Loose) => void]> = [
    ['a changed clearance', (p) => { p.clearances = [{ scale: 'org', level: 'Confidential', compartments: [], releasability: [] }]; }],
    ['an added mapping', (p) => { p.mappings = [{ from: { scale: 'org', level: 'Restricted' }, covers: { scale: 'ca-protected', level: 'Protected A' } }]; }],
    ['a narrower ceiling', (p) => { p.ceiling.maxMode.unattended = 'approve-risky'; }],
    ['a named MCP server', (p) => { p.ceiling.unattendedMcp = ['git']; }],
    ['a removed verb', (p) => { delete p.ceiling.contexts.publish; }],
    ['a changed route', (p) => { p.routing.levels['org/Restricted'] = 'attested-cloud'; }],
    ['a compartment route', (p) => { p.routing.compartments = { ABC: 'deny' }; }],
    ['a different default label', (p) => { p.defaultLabel.level = 'Internal'; }],
    ['a reserved field in use', (p) => { p.maxOfflineAge = { 'org/Restricted': 60 }; }],
    ['a renamed level', (p) => { p.scales.org.levels = ['Public', 'Internal', 'Confidential', 'Restricted ']; }]
  ];
  for (const [name, edit] of customised) {
    assert.equal(isDefaultBundle(edited(signer, edit)), false, name);
  }
  assert.equal(isDefaultBundle(edited(signer, (p) => { p.extra = 1; })), false, 'an invalid bundle is not a default one');
  assert.equal(isDefaultBundle('nope'), false);
  assert.equal(isDefaultBundle(undefined), false);
  assert.equal(isDefaultBundle(null), false);
});

test('a default bundle signed by a different key than the one it names is not accepted, even when that key is known', () => {
  const real = makeSigner();
  const impostor = makeSigner();
  const payload = defaultFor(real);
  const status: KeyStatusLookup = (key) => ({ state: key.fingerprint === impostor.fingerprint || key.fingerprint === real.fingerprint ? 'active' : 'unknown' });
  assert.equal(failedWith(verifyBundleEnvelope(signBundle(impostor, payload), { status, now: NOW })), 'signer-mismatch');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Coherence review S6: a policy written for a newer version says "update the extension", never Reset, and still fails closed

test('S6: an optional requires list naming no unknown feature is accepted, and the default bundle carries none', () => {
  const signer = makeSigner();
  // Phase 41 (D-06): the known features are exactly the registry's, so a v1 bundle may name any of them.
  assert.deepEqual([...KNOWN_BUNDLE_FEATURES], [...FEATURE_IDS]);
  assert.equal(Object.prototype.hasOwnProperty.call(defaultFor(signer), 'requires'), false);
  const plain = check(signedDefault(signer), signer);
  assert.equal(plain.state, 'valid');
  if (plain.state === 'valid') assert.equal(plain.bundle.requires, undefined);
  const empty = check(signBundle(signer, edited(signer, (p) => { p.requires = []; })), signer);
  assert.equal(empty.state, 'valid');
  if (empty.state === 'valid') assert.deepEqual(empty.bundle.requires, []);
});

test('S6: an unknown required feature fails closed as needs-update, before an unknown key would, and no sentence offers Reset', () => {
  const signer = makeSigner();
  const needs = check(signBundle(signer, edited(signer, (p) => { p.requires = ['org-layer']; })), signer);
  assert.equal(failedWith(needs), 'needs-update');
  // A newer policy usually has both: the feature is named first, so the person reads "update".
  const both = check(signBundle(signer, edited(signer, (p) => { p.requires = ['org-layer']; p.organization = { id: 'x' }; })), signer);
  assert.equal(failedWith(both), 'needs-update');
  // An unknown key alone is still refused (fail closed: it is never ignored or applied), with the update sentence.
  const unknown = check(signBundle(signer, edited(signer, (p) => { p.organization = { id: 'x' }; })), signer);
  assert.equal(failedWith(unknown), 'unknown-field');
  assert.match(unknown.state === 'failed-closed' ? unknown.sentence : '', /update the extension/);
  for (const reason of UPDATE_REASONS) {
    assert.match(BUNDLE_FAILURES[reason], /Update the NEAR AI extension/);
    assert.ok(!/Reset/.test(BUNDLE_FAILURES[reason]), reason);
  }
  // Every other reason keeps its own fix.
  assert.match(BUNDLE_FAILURES['bad-signature'], /Reset Policy to Defaults/);
});

test('S6: a requires list that is not a list of feature ids is wrong-type, never accepted', () => {
  const signer = makeSigner();
  for (const value of ['org-layer', [1], ['Has Capitals'], [''], {}, Array.from({ length: 33 }, (_, index) => `f${String(index)}`)]) {
    assert.equal(failedWith(check(signBundle(signer, edited(signer, (p) => { p.requires = value; })), signer)), 'wrong-type', JSON.stringify(value));
  }
  assert.equal(parseBundle({ ...defaultFor(signer), requires: ['org-layer'] }).ok, false);
});

test('S6 (PR #143 review): a policy whose content cannot be read is marked as the person\'s own only when verified against this install\'s own keys', () => {
  const signer = makeSigner();
  const envelope = signBundle(signer, edited(signer, (p) => { p.typo = true; }));
  const status = activeFor(signer);
  const own = verifyBundleEnvelope(envelope, { status, now: NOW, ownKeysOnly: true });
  assert.equal(own.state === 'failed-closed' && own.reason, 'unknown-field');
  assert.equal(own.state === 'failed-closed' && own.ownPolicy, true);
  // Without the store's word that the keys are this install's own (an organization's key later), it is never marked as the person's own.
  const other = verifyBundleEnvelope(envelope, { status, now: NOW });
  assert.equal(other.state === 'failed-closed' && other.ownPolicy, undefined);
  // A signature that does not verify is never the person's own, whatever the store says.
  const tampered = clone(envelope) as Loose;
  tampered.payload.typo = false;
  const bad = verifyBundleEnvelope(tampered, { status, now: NOW, ownKeysOnly: true });
  assert.equal(bad.state === 'failed-closed' && bad.reason, 'bad-signature');
  assert.equal(bad.state === 'failed-closed' && bad.ownPolicy, undefined);
});

test('S6 (Phase 41 schema): a feature id may carry an @N version; an unknown one such as x@1 is needs-update and says update, never Reset; a malformed version is wrong-type', () => {
  const signer = makeSigner();
  // labels@1 became known in Phase 41 (D-06), so labels@2 is the newer version here.
  for (const feature of ['x@1', 'labels@2', 'endpoints@12', 'models', 'org-layer']) {
    const state = check(signBundle(signer, edited(signer, (p) => { p.requires = [feature]; })), signer);
    assert.equal(failedWith(state), 'needs-update', feature);
    const sentence = state.state === 'failed-closed' ? state.sentence : '';
    assert.match(sentence, /Update the NEAR AI extension/);
    assert.ok(!/Reset/.test(sentence), feature);
  }
  for (const feature of ['x@0', 'x@', 'x@01', 'x@12345', 'X@1', 'x@1@2', '@1', 'labels@01', 'Labels@1', 'Has Capitals']) {
    assert.equal(failedWith(check(signBundle(signer, edited(signer, (p) => { p.requires = [feature]; })), signer)), 'wrong-type', feature);
  }
});

test('Phase 41 (D-06, D-50): a v1 bundle may require labels@1 or export-control@1, which this version knows, and still reads with its requires', () => {
  const signer = makeSigner();
  for (const features of [['labels@1'], ['export-control@1'], ['export-control@1', 'labels@1'], [...FEATURE_IDS]]) {
    const state = check(signBundle(signer, edited(signer, (p) => { p.requires = features; })), signer);
    assert.equal(state.state, 'valid', features.join(','));
    if (state.state === 'valid') assert.deepEqual(state.bundle.requires, features);
  }
});

// The credentials@1 and agreements@1 sections of a signed policy (Phase 71 plan 06 Tasks 1 and 3; D-12, D-14, DCAC-01, 48.1 D-25). Fictional
// Example Organization only; the status-list keys are the published did:key example keys, never used to sign anything here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { shapeReason } from '../domain/gate/bundle';
import { CREDENTIALS_LOOSENED_TEXT, DEFAULT_OFFLINE_AGE_EXAMPLES, parseCredentialsSection, requirementsOnlyTighten } from '../domain/gate/credentialsSection';
import type { CredentialsSection } from '../domain/gate/credentialsSection';
import { FEATURE_IDS, featureForSection } from '../domain/gate/features';
import { buildOrganizationLayer, verifyOrganizationLayer } from '../domain/gate/enrolment';
import { composeLayers, directionOf, narrowingOf, wideningOf } from '../domain/gate/layers';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { DAY_MS, FIXED_NOW, deviceKey, issuerKey, policyDocumentFor } from './helpers/policyFixtures';

type Loose = Record<string, any>;

const ROOT_SCID = 'QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ';
const ROOT = `did:webvh:${ROOT_SCID}:hq.example.org:org`;
const STATUS_KEY = 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const OFFICER_KEY = 'did:key:zDnaepBuvsQ8cpsWrVKw8fbpGpvPeNSjVPTWoq6cRqaYzBKVP';

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function credentials(): Loose {
  return {
    v: 1,
    root: { did: ROOT, scid: ROOT_SCID },
    issuance: {
      ClearanceCredential: { role: 'IssuerRoleCredential', ceiling: { scale: 'ca-classified', upTo: 'Secret' } },
      NationalityCredential: { role: 'SecurityContactCredential' }
    },
    suites: ['ecdsa-jcs-2019', 'eddsa-jcs-2022'],
    didMethods: ['did:key', 'did:webvh'],
    statusLists: [
      { uri: 'https://hq.example.org/v1/trust/status/revocation-1', purpose: 'revocation', key: STATUS_KEY },
      { uri: 'https://hq.example.org/v1/trust/status/suspension-1', purpose: 'suspension', key: STATUS_KEY }
    ],
    statusTtl: 900,
    maxOfflineAge: { 'ca-protected/Protected A': 604800, 'ca-protected/Protected B': 259200, 'ca-classified/Secret': 86400 },
    requiredBySensitivity: { 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential'] }
  };
}

function agreements(): Loose {
  return {
    v: 1,
    items: [{ id: 'agreement-gbr-1', partner: 'Example Partner Organization', tokens: ['GBR'], levelCeiling: 'ca-classified/Secret', compartments: [], until: '2027-11-24T00:00:00.000Z' }]
  };
}

function documentWith(edit: (doc: Loose) => void = () => undefined): Loose {
  const doc = plain(policyDocumentFor({ key: deviceKey() })) as unknown as Loose;
  doc.credentials = credentials();
  doc.agreements = agreements();
  doc.requires = [...doc.requires, 'agreements@1', 'credentials@1'].sort();
  edit(doc);
  return doc;
}

function refusal(value: unknown): { reason: string; path: string } {
  const parsed = parsePolicyDocument(value);
  assert.equal(parsed.ok, false, 'should be refused');
  return parsed.ok ? { reason: 'ok', path: '' } : { reason: parsed.reason, path: parsed.path };
}

function parsed(value: unknown): PolicyDocument {
  const result = parsePolicyDocument(value);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

test('tracer: a v2 document with credentials@1 and agreements@1 parses through the existing reader, frozen, with both features required', () => {
  const doc = parsed(documentWith());
  assert.ok(doc.credentials && doc.agreements);
  assert.equal(doc.credentials.root.did, ROOT);
  assert.equal(doc.credentials.statusLists[0]?.key, STATUS_KEY);
  assert.deepEqual([...(doc.credentials.requiredBySensitivity['ca-classified/Secret'] ?? [])], ['ClearanceCredential', 'NationalityCredential']);
  assert.equal(doc.agreements.items[0]?.id, 'agreement-gbr-1');
  assert.ok(Object.isFrozen(doc.credentials) && Object.isFrozen(doc.credentials.issuance) && Object.isFrozen(doc.agreements.items));
  assert.ok(doc.requires.includes('credentials@1') && doc.requires.includes('agreements@1'));
  assert.equal(featureForSection('credentials'), 'credentials@1');
  assert.equal(featureForSection('agreements'), 'agreements@1');
  // Appended after the Phase 41 list, never inserted; later phases (70.1's classification@1, then 45.1's label-interop@1) append after them.
  const after = FEATURE_IDS.indexOf('export-control@1') + 1;
  assert.deepEqual(FEATURE_IDS.slice(after, after + 2), ['credentials@1', 'agreements@1'], 'appended, never inserted');
  assert.deepEqual(parsed(plain(doc)), doc, 'a parsed document is its own wire form');
});

test('requires must name credentials@1 and agreements@1 when the sections are there, or the document is malformed', () => {
  for (const feature of ['credentials@1', 'agreements@1']) {
    const result = parsePolicyDocument(documentWith((doc) => { doc.requires = doc.requires.filter((entry: string) => entry !== feature); }));
    assert.equal(result.ok, false, feature);
    if (!result.ok) assert.equal(shapeReason(result), 'malformed', feature);
  }
});

test('a client that does not know a newer credentials feature says "update", as for every unknown feature', () => {
  const result = parsePolicyDocument(documentWith((doc) => { doc.requires = [...doc.requires, 'credentials@2'].sort(); }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(shapeReason(result), 'needs-update');
});

test('issuance names only person-attribute types, each with a role type and a ceiling on a known scale', () => {
  const cases: Array<[string, (doc: Loose) => void, string]> = [
    ['unknown type', (doc) => { doc.credentials.issuance.AlumniCredential = { role: 'IssuerRoleCredential' }; }, 'not-allowed-here'],
    ['a role type is issued by the root only', (doc) => { doc.credentials.issuance.IssuerRoleCredential = { role: 'IssuerRoleCredential' }; }, 'not-allowed-here'],
    ['device binding is issued by its person', (doc) => { doc.credentials.issuance.DeviceBindingCredential = { role: 'RoleCredential' }; }, 'not-allowed-here'],
    ['role not a role type', (doc) => { doc.credentials.issuance.ClearanceCredential.role = 'ClearanceCredential'; }, 'not-allowed-here'],
    ['ceiling not on its scale', (doc) => { doc.credentials.issuance.ClearanceCredential.ceiling = { scale: 'ca-classified', upTo: 'Protected B' }; }, 'not-allowed-here'],
    ['unknown rule key', (doc) => { doc.credentials.issuance.ClearanceCredential.anyone = true; }, 'unknown-field'],
    ['missing role', (doc) => { delete doc.credentials.issuance.NationalityCredential.role; }, 'missing-field']
  ];
  for (const [name, edit, reason] of cases) assert.equal(refusal(documentWith(edit)).reason, reason, name);
});

test('the root is a did:webvh pinned by its SCID; a root without the SCID, or a SCID that is not the root\'s, is refused', () => {
  assert.equal(refusal(documentWith((doc) => { delete doc.credentials.root.scid; })).reason, 'missing-field');
  assert.equal(refusal(documentWith((doc) => { doc.credentials.root.scid = 'QmXhVjFG6EBTosDastaaHMRypm2qSv4SMGctADsx878Yux'; })).reason, 'not-allowed-here');
  assert.equal(refusal(documentWith((doc) => { doc.credentials.root = { did: OFFICER_KEY, scid: ROOT_SCID }; })).reason, 'not-allowed-here');
});

test('status lists each name their uri, purpose and the status-list key that must sign them; one without the key is refused', () => {
  const cases: Array<[string, (doc: Loose) => void, string]> = [
    ['no key', (doc) => { delete doc.credentials.statusLists[0].key; }, 'missing-field'],
    ['not a Multikey', (doc) => { doc.credentials.statusLists[0].key = 'status-list-hq'; }, 'wrong-type'],
    ['another purpose', (doc) => { doc.credentials.statusLists[0].purpose = 'refresh'; }, 'not-allowed-here'],
    ['not https', (doc) => { doc.credentials.statusLists[0].uri = 'http://hq.example.org/status'; }, 'wrong-type'],
    ['the same list twice', (doc) => { doc.credentials.statusLists[1].uri = doc.credentials.statusLists[0].uri; }, 'duplicate']
  ];
  for (const [name, edit, reason] of cases) assert.equal(refusal(documentWith(edit)).reason, reason, name);
});

test('offline ages are whole seconds per scale/level of the document\'s scales; the O6 examples are exported for the template, never applied', () => {
  assert.equal(refusal(documentWith((doc) => { doc.credentials.maxOfflineAge = { 'ca-classified/Ultra': 60 }; })).reason, 'unknown-field');
  assert.equal(refusal(documentWith((doc) => { doc.credentials.maxOfflineAge['ca-classified/Secret'] = 86400.5; })).reason, 'wrong-type');
  const none = parsed(documentWith((doc) => { doc.credentials.maxOfflineAge = {}; }));
  assert.deepEqual({ ...none.credentials?.maxOfflineAge }, {}, 'a level the policy leaves out has no offline allowance');
  assert.equal(DEFAULT_OFFLINE_AGE_EXAMPLES['ca-protected/Protected A'], 7 * 24 * 3600);
  assert.equal(DEFAULT_OFFLINE_AGE_EXAMPLES['ca-protected/Protected B'], 72 * 3600);
  assert.equal(DEFAULT_OFFLINE_AGE_EXAMPLES['ca-classified/Top Secret'], 24 * 3600);
  assert.equal(refusal(documentWith((doc) => { doc.credentials.statusTtl = 0; })).reason, 'wrong-type');
});

test('with credentials@1, the reserved statusLists and maxOfflineAge must be empty; without it they read as before', () => {
  const listed = refusal(documentWith((doc) => { doc.reserved.statusLists = [{ uri: 'https://status.example.org/list', purpose: 'revocation' }]; }));
  assert.deepEqual(listed, { reason: 'not-allowed-here', path: 'reserved.statusLists' });
  const aged = refusal(documentWith((doc) => { doc.reserved.maxOfflineAge = { 'org/Restricted': 86400 }; }));
  assert.deepEqual(aged, { reason: 'not-allowed-here', path: 'reserved.maxOfflineAge' });
  const before = plain(policyDocumentFor({ key: deviceKey() })) as unknown as Loose;
  before.reserved.maxOfflineAge = { 'org/Restricted': 86400 };
  assert.equal(parsePolicyDocument(before).ok, true);
});

test('suites, DID methods and sensitivity requirements are closed, sorted lists', () => {
  const cases: Array<[string, (doc: Loose) => void, string]> = [
    ['unknown suite', (doc) => { doc.credentials.suites = ['eddsa-rdfc-2022']; }, 'not-allowed-here'],
    ['unsorted suites', (doc) => { doc.credentials.suites = ['eddsa-jcs-2022', 'ecdsa-jcs-2019']; }, 'not-sorted'],
    ['no suite', (doc) => { doc.credentials.suites = []; }, 'empty-list'],
    ['unknown DID method', (doc) => { doc.credentials.didMethods = ['did:web']; }, 'not-allowed-here'],
    ['unknown required type', (doc) => { doc.credentials.requiredBySensitivity['ca-classified/Secret'] = ['RoleCredential']; }, 'not-allowed-here'],
    ['unsorted requirement', (doc) => { doc.credentials.requiredBySensitivity['ca-classified/Secret'] = ['NationalityCredential', 'ClearanceCredential']; }, 'not-sorted'],
    ['unknown level', (doc) => { doc.credentials.requiredBySensitivity = { 'ca-classified/Ultra': ['ClearanceCredential'] }; }, 'unknown-field']
  ];
  for (const [name, edit, reason] of cases) assert.equal(refusal(documentWith(edit)).reason, reason, name);
});

test('under the fallback (no did:webvh) the root and the officers\' person keys are did:keys the policy names; with did:webvh no person key may be named', () => {
  const fallback = parsed(documentWith((doc) => {
    doc.credentials.didMethods = ['did:key'];
    doc.credentials.root = { did: OFFICER_KEY };
    doc.credentials.fallbackPersonKeys = [OFFICER_KEY];
  }));
  assert.deepEqual([...(fallback.credentials?.fallbackPersonKeys ?? [])], [OFFICER_KEY]);
  assert.equal(refusal(documentWith((doc) => { doc.credentials.fallbackPersonKeys = [OFFICER_KEY]; })).reason, 'not-allowed-here');
  assert.equal(refusal(documentWith((doc) => { doc.credentials.didMethods = ['did:key']; })).reason, 'not-allowed-here', 'a did:webvh root needs did:webvh allowed');
});

test('agreements: tokens are label tokens, the ceiling is a known level, until is a timestamp, and items are sorted by a unique id', () => {
  const second = { ...agreements().items[0], id: 'agreement-aus-1', tokens: ['AUS'] };
  const cases: Array<[string, (doc: Loose) => void, string]> = [
    ['lower-case token', (doc) => { doc.agreements.items[0].tokens = ['gbr']; }, 'wrong-type'],
    ['releasable to no one', (doc) => { doc.agreements.items[0].tokens = ['RELEASABLE-TO-NONE']; }, 'wrong-type'],
    ['no token', (doc) => { doc.agreements.items[0].tokens = []; }, 'empty-list'],
    ['unknown level', (doc) => { doc.agreements.items[0].levelCeiling = 'ca-classified/Ultra'; }, 'not-allowed-here'],
    ['until not a timestamp', (doc) => { doc.agreements.items[0].until = '2027-11-24'; }, 'wrong-type'],
    ['out of order', (doc) => { doc.agreements.items = [doc.agreements.items[0], second]; }, 'not-sorted'],
    ['id twice', (doc) => { doc.agreements.items = [doc.agreements.items[0], { ...doc.agreements.items[0] }]; }, 'duplicate'],
    ['a free-text reference', (doc) => { doc.agreements.items[0].agreementRef = 'MOU 2026'; }, 'unknown-field']
  ];
  for (const [name, edit, reason] of cases) assert.equal(refusal(documentWith(edit)).reason, reason, name);
  assert.equal(parsePolicyDocument(documentWith((doc) => { doc.agreements.items = [second, doc.agreements.items[0]]; })).ok, true);
});

// ---- 45.1-03 Task 3 (D-12): your organization's record that it vetted a partner's clearance process ----

const VETTING = { by: 'Example Security Officer', on: '2026-10-01T00:00:00.000Z', basis: 'Example review of the partner\'s clearance process.' };

test('agreements: clearanceProcessVetted { by, on, basis } parses frozen; absent means no vetting; a missing or extra key, empty text or a bad time is refused', () => {
  const vetted = parsed(documentWith((doc) => { doc.agreements.items[0].clearanceProcessVetted = { ...VETTING }; })).agreements?.items[0];
  assert.deepEqual(plain(vetted?.clearanceProcessVetted), VETTING);
  assert.ok(Object.isFrozen(vetted?.clearanceProcessVetted));
  assert.equal(Object.prototype.hasOwnProperty.call(parsed(documentWith()).agreements?.items[0], 'clearanceProcessVetted'), false, 'absent: not vetted');
  const vet = (edit: (vetting: Loose) => void) => (doc: Loose): void => { const vetting: Loose = { ...VETTING }; edit(vetting); doc.agreements.items[0].clearanceProcessVetted = vetting; };
  const cases: Array<[string, (doc: Loose) => void, string]> = [
    ['not an object', (doc) => { doc.agreements.items[0].clearanceProcessVetted = 'yes'; }, 'wrong-type'],
    ['no by', vet((v) => { delete v.by; }), 'missing-field'],
    ['no on', vet((v) => { delete v.on; }), 'missing-field'],
    ['no basis', vet((v) => { delete v.basis; }), 'missing-field'],
    ['an extra key', vet((v) => { v.level = 'Secret'; }), 'unknown-field'],
    ['empty by', vet((v) => { v.by = ''; }), 'wrong-type'],
    ['empty basis', vet((v) => { v.basis = ''; }), 'wrong-type'],
    ['by too long', vet((v) => { v.by = 'x'.repeat(201); }), 'wrong-type'],
    ['basis too long', vet((v) => { v.basis = 'x'.repeat(501); }), 'wrong-type'],
    ['on not a timestamp', vet((v) => { v.on = '2026-10-01'; }), 'wrong-type'],
    ['on a number', vet((v) => { v.on = Date.UTC(2026, 9, 1); }), 'wrong-type']
  ];
  for (const [name, edit, reason] of cases) assert.equal(refusal(documentWith(edit)).reason, reason, name);
  assert.equal(parsePolicyDocument(documentWith(vet((v) => { v.by = 'x'.repeat(200); v.basis = 'x'.repeat(500); }))).ok, true, 'at the limits');
});

test('layers: only your organization\'s signed layer can mark a partner vetted; a personal layer\'s vetting is ignored', () => {
  for (const key of ['agreements.items[].clearanceProcessVetted', 'agreements.items[].clearanceProcessVetted.on', 'agreements.items[].clearanceProcessVetted.by',
    'agreements.items[].clearanceProcessVetted.basis']) {
    assert.equal(directionOf(key)?.direction, 'organization-only', key);
  }
  const organization = parsed(documentWith((doc) => { doc.layer = 'organization'; doc.issuer = { fingerprint: issuerKey().fingerprint, publicKey: issuerKey().publicKey }; }));
  const personal = parsed(documentWith((doc) => {
    doc.parent = { hash: 'c'.repeat(64), issuer: issuerKey().fingerprint };
    doc.agreements.items[0].clearanceProcessVetted = { ...VETTING };
  }));
  const composed = composeLayers({ organization, personal });
  assert.equal(composed.effective.agreements?.items[0]?.clearanceProcessVetted, undefined, 'your organization never vetted this partner');
  assert.ok(composed.ignored.some((setting) => setting.key.startsWith('agreements.items')), 'the personal vetting is named as ignored');
});

test('your organization\'s signed layer carries both sections: built, signed by its key and verified, with the features named for it', () => {
  const key = issuerKey();
  const sections = { labels: plain(policyDocumentFor({ key })).labels, agents: plain(policyDocumentFor({ key })).agents, credentials: credentials(), agreements: agreements() };
  const layer = buildOrganizationLayer(key, sections, { now: FIXED_NOW, days: 90 });
  const read = verifyOrganizationLayer(layer, { issuerPublicKey: key.publicKey, now: FIXED_NOW + DAY_MS });
  assert.equal(read.ok, true, read.ok ? '' : read.message);
  if (!read.ok) return;
  assert.equal(read.document.credentials?.root.scid, ROOT_SCID);
  assert.equal(read.document.agreements?.items.length, 1);
  assert.ok(read.document.requires.includes('credentials@1') && read.document.requires.includes('agreements@1'));
  const forged = { ...layer, payload: { ...layer.payload, credentials: { ...credentials(), root: { did: `did:webvh:${ROOT_SCID}:attacker.example.org:org`, scid: ROOT_SCID } } } };
  assert.equal(verifyOrganizationLayer(forged, { issuerPublicKey: key.publicKey, now: FIXED_NOW + DAY_MS }).ok, false, 'the section is covered by the signature');
});

// ---- Task 3: requirements only tighten ----

function section(required: Record<string, string[]>): CredentialsSection {
  const doc = parsed(documentWith((d) => { d.credentials.requiredBySensitivity = required; }));
  return doc.credentials as CredentialsSection;
}

test('requirementsOnlyTighten: true when every requirement stays, false when one is dropped or moved to another level only', () => {
  const active = section({ 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential'] });
  assert.equal(requirementsOnlyTighten(active, section({ 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential', 'ServiceCredential'] })), true);
  assert.equal(requirementsOnlyTighten(active, section({ 'ca-classified/Confidential': ['ClearanceCredential'], 'ca-classified/Secret': ['ClearanceCredential', 'NationalityCredential'] })), true);
  assert.equal(requirementsOnlyTighten(active, section({ 'ca-classified/Secret': ['ClearanceCredential'] })), false, 'one dropped');
  assert.equal(requirementsOnlyTighten(active, section({ 'ca-classified/Top Secret': ['ClearanceCredential', 'NationalityCredential'] })), false, 'moved up a level only');
  assert.equal(requirementsOnlyTighten(active, undefined), false, 'the whole section dropped');
  assert.equal(requirementsOnlyTighten(undefined, active), true, 'nothing in force yet');
  assert.match(CREDENTIALS_LOOSENED_TEXT, /security officer/);
});

test('layers: a personal or project layer may add a sensitivity requirement and never drop one; every other credentials key is your organization\'s', () => {
  const path = 'credentials.requiredBySensitivity.ca-classified/Secret';
  assert.equal(directionOf(path)?.direction, 'superset');
  assert.equal(narrowingOf(path, ['ClearanceCredential'], ['ClearanceCredential', 'NationalityCredential']), 'narrows');
  assert.equal(narrowingOf(path, ['ClearanceCredential', 'NationalityCredential'], ['ClearanceCredential']), 'widens');
  for (const key of ['credentials.root.did', 'credentials.issuance.ClearanceCredential.role', 'credentials.suites', 'credentials.didMethods', 'credentials.statusLists[].key',
    'credentials.statusTtl', 'credentials.maxOfflineAge.ca-classified/Secret', 'credentials.fallbackPersonKeys', 'agreements.items[].tokens']) {
    assert.equal(directionOf(key)?.direction, 'organization-only', key);
  }
});

test('composition: your organization\'s requirements stay when a personal layer leaves one out, and a personal addition counts', () => {
  const organization = parsed(documentWith((doc) => { doc.layer = 'organization'; doc.issuer = { fingerprint: issuerKey().fingerprint, publicKey: issuerKey().publicKey }; }));
  const personal = parsed(documentWith((doc) => {
    doc.parent = { hash: 'c'.repeat(64), issuer: issuerKey().fingerprint };
    doc.credentials.requiredBySensitivity = { 'ca-classified/Secret': ['ClearanceCredential', 'ServiceCredential'] };
  }));
  const composed = composeLayers({ organization, personal });
  assert.deepEqual([...(composed.effective.credentials?.requiredBySensitivity['ca-classified/Secret'] ?? [])], ['ClearanceCredential', 'NationalityCredential', 'ServiceCredential']);
  assert.equal(composed.effective.credentials?.root.did, ROOT);
});

test('an edit that drops a requirement your organization sets is named as widening before it is signed; one that adds is not', () => {
  const organization = parsed(documentWith((doc) => { doc.layer = 'organization'; doc.issuer = { fingerprint: issuerKey().fingerprint, publicKey: issuerKey().publicKey }; }));
  const personal = (required: string[]): PolicyDocument => parsed(documentWith((doc) => {
    doc.parent = { hash: 'c'.repeat(64), issuer: issuerKey().fingerprint };
    doc.credentials.requiredBySensitivity = { 'ca-classified/Secret': required };
  }));
  const base = personal(['ClearanceCredential', 'NationalityCredential']);
  const dropped = wideningOf(organization, base, personal(['ClearanceCredential']));
  assert.equal(dropped?.key, 'credentials.requiredBySensitivity.ca-classified/Secret');
  assert.equal(wideningOf(organization, base, personal(['ClearanceCredential', 'NationalityCredential', 'ServiceCredential'])), undefined);
  const kept = composeLayers({ organization, personal: personal(['ClearanceCredential']) });
  assert.deepEqual([...(kept.effective.credentials?.requiredBySensitivity['ca-classified/Secret'] ?? [])], ['ClearanceCredential', 'NationalityCredential'], 'your organization\'s requirement stays');
});

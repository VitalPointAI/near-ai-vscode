// Policy bundle v2 (FND-02, Phase 41 D-04 to D-10, D-28, D-33, D-34, D-40, D-42, D-49, D-50, D-60 to D-63): one document read from two wire forms, strict
// sections, features in `requires`, and "update the extension" (never Reset) for a policy written for a newer version. Keys are made at test time.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUNDLE_FAILURES, KNOWN_BUNDLE_FEATURES, bundleHash, defaultBundlePayload, needsUpdateSentence, parseBundle, shapeReason, verifyBundleEnvelope
} from '../domain/gate/bundle';
import type { BundleFailureReason } from '../domain/gate/bundle';
import { FEATURE_IDS, POLICY_SECTIONS, featureForSection } from '../domain/gate/features';
import { parseModelsSection } from '../domain/gate/models';
import { bundleViewOf, documentFromBundle, minClientOf, parsePolicyDocument, verifyPolicyLayer } from '../domain/gate/policyDocument';
import type { PolicyDocument, PolicyLayerState } from '../domain/gate/policyDocument';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parsePeopleSection } from '../domain/org/peopleSection';
import {
  CONTACT_TOPICS, EXPORT_REGIMES, KINDS_OF_WORK, LOCKABLE_ANSWERS, RESIDENCY_REGIONS, parseContacts, parseExportControlSection, parseLimitsSection,
  parseOnboardingSection, parseRegimes, parseResidencySection
} from '../domain/gate/sections';
import { signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { FIXED_NOW, activeKeys, deviceKey, exportControlExample, fullDocumentFor, issuerKey, policyDocumentFor, signPersonalLayer } from './helpers/policyFixtures';

type Loose = any; // a document under edit: each test breaks one value on purpose

const EM_DASH = String.fromCharCode(0x2014);

function plain<T>(value: T): Loose {
  return JSON.parse(JSON.stringify(value)) as Loose;
}

function defaultPayload(key: PayloadSigner = deviceKey()): Loose {
  return plain(defaultBundlePayload({ issuer: { fingerprint: key.fingerprint, publicKey: key.publicKey }, now: FIXED_NOW }));
}

/** The starting rules as a plain v2 personal layer of this device, with one edit applied. */
function v2(edit: (doc: Loose) => void = () => undefined, key: PayloadSigner = deviceKey()): Loose {
  const doc = plain(policyDocumentFor({ key }));
  edit(doc);
  return doc;
}

function reasonOf(value: unknown): string {
  const parsed = parsePolicyDocument(value);
  return parsed.ok ? 'ok' : parsed.reason;
}

function failureOf(value: unknown): BundleFailureReason | 'ok' {
  const parsed = parsePolicyDocument(value);
  return parsed.ok ? 'ok' : shapeReason(parsed);
}

function verifyPersonal(doc: unknown, key: PayloadSigner = deviceKey()): PolicyLayerState {
  return verifyPolicyLayer(signPersonalLayer(doc as PolicyDocument, key), { purpose: 'policy-bundle', status: activeKeys(key), now: FIXED_NOW });
}

function failedSentence(state: PolicyLayerState): string {
  assert.equal(state.state, 'failed-closed');
  return state.state === 'failed-closed' ? state.sentence : '';
}

test('tracer (D-04): the default v1 payload reads as a personal v2 document whose view is parseBundle\'s, and the signed default keeps its hash', () => {
  const key = deviceKey();
  const payload = defaultPayload(key);
  const parsed = parsePolicyDocument(payload);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.bundleVersion, 2);
  assert.equal(parsed.value.layer, 'personal');
  assert.equal(parsed.value.parent, undefined);
  assert.deepEqual([...parsed.value.requires], ['agents@1', 'labels@1', 'layers@1', 'people@1']);
  assert.equal(parsed.value.agents.requireAccreditedDevice, false);
  const v1 = parseBundle(payload);
  assert.equal(v1.ok, true);
  if (!v1.ok) return;
  assert.deepEqual(bundleViewOf(parsed.value), v1.value);
  const envelope = signPayload(key, 'policy-bundle', payload, { now: () => new Date(payload.issuedAt) });
  const before = verifyBundleEnvelope(envelope, { status: activeKeys(key), now: FIXED_NOW });
  const after = verifyPolicyLayer(envelope, { purpose: 'policy-bundle', status: activeKeys(key), now: FIXED_NOW });
  assert.equal(before.state, 'valid');
  assert.equal(after.state, 'valid');
  if (before.state !== 'valid' || after.state !== 'valid') return;
  assert.equal(after.wireVersion, 1);
  assert.equal(after.hash, before.hash);
  assert.equal(after.hash, bundleHash(payload));
  assert.deepEqual(bundleViewOf(after.document), before.bundle);
});

test('D-05: the starting rules signed as a v2 personal layer verify, read as wire version 2 and project to the default view', () => {
  const key = deviceKey();
  const doc = policyDocumentFor({ key });
  const state = verifyPersonal(doc, key);
  assert.equal(state.state, 'valid');
  if (state.state !== 'valid') return;
  assert.equal(state.wireVersion, 2);
  assert.equal(state.hash, bundleHash(doc));
  assert.deepEqual(state.document, doc);
  const v1 = parseBundle(defaultPayload(key));
  assert.ok(v1.ok);
  if (v1.ok) assert.deepEqual(bundleViewOf(state.document), v1.value);
});

test('D-06, D-07: a feature this version lacks is needs-update, before an unknown key, and its sentence never offers Reset', () => {
  for (const feature of ['labels@2', 'data@1', 'directives@1']) {
    const doc = v2((d) => { d.requires = [...d.requires, feature].sort(); d.data = { v: 1 }; });
    assert.equal(failureOf(doc), 'needs-update', feature);
    const sentence = failedSentence(verifyPersonal(doc));
    assert.equal(sentence, BUNDLE_FAILURES['needs-update']);
    assert.ok(!/Reset/.test(sentence), feature);
  }
  // minClient only words the sentence; still no Reset.
  const named = v2((d) => { d.requires = ['agents@1', 'data@1', 'labels@1', 'layers@1', 'people@1']; d.minClient = '0.4.40'; });
  assert.equal(minClientOf(named), '0.4.40');
  const sentence = failedSentence(verifyPersonal(named));
  assert.equal(sentence, needsUpdateSentence('0.4.40'));
  assert.match(sentence, /0\.4\.40 or later/);
  assert.match(sentence, /Update SovAI/);
  assert.ok(!/Reset/.test(sentence));
  assert.equal(needsUpdateSentence(), BUNDLE_FAILURES['needs-update']);
});

test('D-06: a v2 document that uses a section without naming its feature, or omits requires, is malformed', () => {
  assert.equal(failureOf(v2((d) => { d.requires = ['labels@1', 'layers@1', 'people@1']; })), 'malformed');
  assert.equal(failureOf(v2((d) => { d.requires = ['agents@1', 'labels@1', 'people@1']; })), 'malformed', 'layers@1 is always needed');
  assert.equal(failureOf(v2((d) => { d.requires = ['agents@1', 'labels@1', 'layers@1']; })), 'malformed', 'people is present');
  assert.equal(failureOf(v2((d) => { delete d.requires; })), 'malformed');
  assert.equal(failedSentence(verifyPersonal(v2((d) => { d.requires = ['labels@1', 'layers@1', 'people@1']; }))), BUNDLE_FAILURES.malformed);
  // A known feature with no section is fine; the list must be sorted and unique.
  assert.equal(reasonOf(v2((d) => { d.requires = ['agents@1', 'endpoints@1', 'labels@1', 'layers@1', 'people@1']; })), 'ok');
  assert.equal(reasonOf(v2((d) => { d.requires = ['labels@1', 'agents@1', 'layers@1', 'people@1']; })), 'not-sorted');
  assert.equal(reasonOf(v2((d) => { d.requires = ['agents@1', 'agents@1', 'labels@1', 'layers@1', 'people@1']; })), 'duplicate');
});

test('D-07: an unknown key in a known section, or a section this version does not have, is unknown-field', () => {
  assert.equal(failureOf(v2((d) => { d.labels.extra = 1; })), 'unknown-field');
  assert.equal(failureOf(v2((d) => { d.agents.mcp.extra = []; })), 'unknown-field');
  assert.equal(failureOf(v2((d) => { d.labels.routing.localHosts = []; })), 'unknown-field', 'local hosts are endpoints in v2');
  assert.equal(failureOf(v2((d) => { d.data = { v: 1 }; })), 'unknown-field');
  assert.equal(failureOf(v2((d) => { d.ceiling = d.agents; })), 'unknown-field', 'a v1 key in a v2 document');
  assert.match(failedSentence(verifyPersonal(v2((d) => { d.labels.extra = 1; }))), /update the extension/);
});

test('D-07: a newer section version is needs-update, a newer bundle version unsupported-version, a newer vocabulary vocabulary-unknown', () => {
  assert.equal(failureOf(v2((d) => { d.labels.v = 2; })), 'needs-update');
  assert.equal(failureOf(v2((d) => { d.labels.v = 2; d.labels.newer = true; })), 'needs-update', 'the version is read before the keys');
  assert.equal(failureOf(v2((d) => { d.agents.v = 2; })), 'needs-update');
  assert.equal(failureOf(v2((d) => { d.reserved.v = 3; })), 'needs-update');
  assert.equal(failureOf(v2((d) => { d.bundleVersion = 3; })), 'unsupported-version');
  assert.equal(failureOf(v2((d) => { d.vocabulary = 2; })), 'vocabulary-unknown');
  assert.equal(reasonOf(v2((d) => { d.labels.v = '1'; })), 'wrong-type');
  assert.equal(reasonOf(v2((d) => { delete d.labels.v; })), 'missing-field');
  for (const reason of ['needs-update', 'unsupported-version', 'vocabulary-unknown'] as const) assert.ok(!/Reset/.test(BUNDLE_FAILURES[reason]));
});

test('D-05: the envelope is exact: layer from the closed list, a parent only below your organization, minClient a release number', () => {
  assert.equal(reasonOf(v2((d) => { d.layer = 'team'; })), 'not-allowed-here');
  assert.equal(reasonOf(v2((d) => { delete d.layer; })), 'missing-field');
  assert.equal(reasonOf(v2((d) => { delete d.agents; })), 'missing-field');
  const parent = { hash: 'a'.repeat(64), issuer: issuerKey().fingerprint };
  assert.equal(reasonOf(v2((d) => { d.parent = parent; })), 'ok');
  assert.equal(reasonOf(v2((d) => { d.layer = 'project'; d.parent = parent; })), 'ok');
  const onOrganization = parsePolicyDocument(v2((d) => { d.layer = 'organization'; d.parent = parent; }));
  assert.equal(onOrganization.ok ? 'ok' : `${onOrganization.reason} ${onOrganization.path}`, 'not-allowed-here parent');
  assert.equal(reasonOf(v2((d) => { d.parent = { hash: 'A'.repeat(64), issuer: parent.issuer }; })), 'wrong-type');
  assert.equal(reasonOf(v2((d) => { d.parent = { ...parent, extra: 1 }; })), 'unknown-field');
  for (const good of ['0.4.40', '1.0.0', '9999.0.12']) assert.equal(reasonOf(v2((d) => { d.minClient = good; })), 'ok', good);
  for (const bad of ['0.4', '01.4.40', '0.4.40-beta', '10000.0.0', 'v1.0.0']) assert.equal(reasonOf(v2((d) => { d.minClient = bad; })), 'wrong-type', bad);
  assert.equal(minClientOf(v2((d) => { d.minClient = 'v1'; })), undefined);
  assert.equal(minClientOf('garbage'), undefined);
});

test('D-08: a fraction anywhere in a v2 document is wrong-type, before anything else', () => {
  assert.equal(failureOf(v2((d) => { d.reserved.maxOfflineAge = { 'org/Restricted': 12.5 }; })), 'wrong-type');
  assert.equal(reasonOf(v2((d) => { d.labels.v = 12.5; })), 'wrong-type');
  assert.equal(reasonOf(v2((d) => { d.data = { v: 12.5 }; })), 'wrong-type', 'numbers are checked before unknown keys');
  assert.equal(reasonOf(v2((d) => { d.bundleVersion = 2.5; })), 'wrong-type');
  assert.equal(reasonOf(v2((d) => { d.reserved.maxOfflineAge = { 'org/Restricted': -1 }; })), 'wrong-type');
});

test('features: KNOWN_BUNDLE_FEATURES is FEATURE_IDS, every section but reserved has its feature, and the list is the D-06 list plus export-control@1, credentials@1, agreements@1 and classification@1', () => {
  assert.deepEqual([...KNOWN_BUNDLE_FEATURES], [...FEATURE_IDS]);
  assert.deepEqual([...FEATURE_IDS], [
    'labels@1', 'endpoints@1', 'authorizations@1', 'residency@1', 'models@1', 'agents@1', 'people@1', 'onboarding@1', 'limits@1', 'layers@1', 'export-control@1',
    'credentials@1', 'agreements@1', 'classification@1', 'label-interop@1'
  ]);
  assert.deepEqual([...POLICY_SECTIONS], [
    'labels', 'endpoints', 'authorizations', 'models', 'agents', 'residency', 'people', 'onboarding', 'limits', 'reserved', 'exportControl', 'credentials', 'agreements',
    'classification', 'labelInterop'
  ]);
  assert.equal(featureForSection('reserved'), undefined);
  assert.equal(featureForSection('exportControl'), 'export-control@1');
  for (const section of POLICY_SECTIONS) {
    if (section !== 'reserved') assert.ok((FEATURE_IDS as readonly string[]).includes(featureForSection(section) as string), section);
  }
  assert.ok(Object.isFrozen(KNOWN_BUNDLE_FEATURES) && Object.isFrozen(FEATURE_IDS));
});

test('a document is its own v2 wire form: the JSON copy of the default document and of the full document parses to an equal document', () => {
  const key = issuerKey();
  const doc = policyDocumentFor({ key });
  const again = parsePolicyDocument(plain(doc));
  assert.ok(again.ok, again.ok ? '' : again.message);
  if (again.ok) assert.deepEqual(again.value, doc);
  const full = parsePolicyDocument(fullDocumentFor(key));
  assert.ok(full.ok, full.ok ? '' : full.message);
  if (!full.ok) return;
  const twice = parsePolicyDocument(plain(full.value));
  assert.ok(twice.ok, twice.ok ? '' : twice.message);
  if (twice.ok) assert.deepEqual(twice.value, full.value);
  assert.deepEqual(full.value, plain(fullDocumentFor(key)), 'the full document already has every default filled');
  assert.ok(Object.isFrozen(full.value) && Object.isFrozen(full.value.labels) && Object.isFrozen(full.value.agents.mcp));
  // The personal form of the full document carries a parent.
  const personal = parsePolicyDocument(fullDocumentFor(key, { layer: 'personal' }));
  assert.ok(personal.ok && personal.value.parent !== undefined);
});

test('a hostile prototype key is never read: __proto__ in a section is an unknown field, and parsed input is never shared with the result', () => {
  const hostile = JSON.parse(JSON.stringify(v2()).replace('"labels":{', '"labels":{"__proto__":{"v":2},'));
  assert.equal(reasonOf(hostile), 'unknown-field');
  const doc = v2();
  const parsed = parsePolicyDocument(doc);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  doc.labels.defaultLabel.level = 'Internal';
  assert.equal(parsed.value.labels.defaultLabel.level, 'Public');
});

test('stubs (D-40, D-42): models and people parse as { v: 1 }; not an object, v 2 and an unknown key are refused', () => {
  const scales = SCALE_PRESETS;
  assert.deepEqual(parseModelsSection({ v: 1 }, scales), { ok: true, value: { v: 1 } });
  assert.deepEqual(parseModelsSection({ v: 1 }, scales, 'models').ok, true);
  assert.equal(parsePeopleSection({ v: 1 }, scales).ok, true);
  for (const [name, parse] of [['models', parseModelsSection], ['people', parsePeopleSection]] as const) {
    for (const value of [null, [], 'v1', 1]) assert.equal(parse(value, scales).ok, false, `${name} ${JSON.stringify(value)}`);
    const newer = parse({ v: 2 }, scales);
    assert.equal(newer.ok ? 'ok' : `${newer.reason} ${newer.path}`, `unknown-version ${name}.v`);
    const invented = parse({ v: 1, invented: true }, scales);
    assert.equal(invented.ok ? 'ok' : `${invented.reason} ${invented.path}`, `unknown-field ${name}.invented`);
    assert.equal(parse({}, scales).ok, false, `${name} without v`);
  }
  // Through the document: the sections are optional and need their features.
  assert.equal(reasonOf(v2((d) => { d.models = { v: 1 }; d.requires = ['agents@1', 'labels@1', 'layers@1', 'models@1', 'people@1']; })), 'ok');
  assert.equal(failureOf(v2((d) => { d.models = { v: 1 }; })), 'malformed');
  assert.equal(reasonOf(v2((d) => { delete d.people; d.requires = ['agents@1', 'labels@1', 'layers@1']; })), 'ok');
});

test('a document read from a v1 bundle keeps the bundle\'s own requires in the union, and the view drops requires', () => {
  const key = deviceKey();
  const bundle = defaultBundlePayload({ issuer: { fingerprint: key.fingerprint, publicKey: key.publicKey }, now: FIXED_NOW });
  const doc = documentFromBundle({ ...bundle, requires: ['limits@1'] });
  assert.deepEqual([...doc.requires], ['agents@1', 'labels@1', 'layers@1', 'limits@1', 'people@1']);
  assert.equal(Object.prototype.hasOwnProperty.call(bundleViewOf(doc), 'requires'), false);
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.requires));
});

test('no failure sentence used for v2 has an em-dash or names a NEAR organization', () => {
  for (const sentence of [...Object.values(BUNDLE_FAILURES), needsUpdateSentence('1.2.3')]) {
    assert.ok(!sentence.includes(EM_DASH), sentence);
    assert.ok(!/NEAR organization/.test(sentence), sentence);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Residency, onboarding and limits (D-08, D-28, D-33, D-63)

function sectionReason(parsed: { ok: boolean; reason?: string; path?: string }): string {
  return parsed.ok ? 'ok' : `${String(parsed.reason)} ${String(parsed.path)}`;
}

test('D-33: residency names CA, EU or US, sorted and unique, for every request and per level; unstated never satisfies, so it is refused', () => {
  const r = (value: unknown): string => sectionReason(parseResidencySection(value, SCALE_PRESETS));
  assert.deepEqual([...RESIDENCY_REGIONS], ['CA', 'EU', 'US']);
  assert.equal(r({ v: 1 }), 'ok');
  assert.equal(r({ v: 1, required: ['CA'] }), 'ok');
  assert.equal(r({ v: 1, required: ['CA', 'EU', 'US'], byLevel: { 'ca-protected/Protected A': ['CA', 'EU'], 'org/Internal': ['CA'] } }), 'ok');
  assert.equal(r({ v: 1, required: ['unstated'] }), 'not-allowed-here residency.required[0]');
  assert.equal(r({ v: 1, required: ['ca'] }), 'not-allowed-here residency.required[0]');
  assert.equal(r({ v: 1, required: 'CA' }), 'wrong-type residency.required');
  assert.equal(r({ v: 1, required: [] }), 'empty-list residency.required');
  assert.equal(r({ v: 1, required: ['EU', 'CA'] }), 'not-sorted residency.required[1]');
  assert.equal(r({ v: 1, required: ['CA', 'CA'] }), 'duplicate residency.required[1]');
  assert.equal(r({ v: 1, byLevel: { 'org/Secret': ['CA'] } }), 'unknown-field residency.byLevel.org?Secret', 'paths show a slash as ?');
  assert.equal(r({ v: 1, byLevel: { 'org/Internal': ['unstated'] } }), 'not-allowed-here residency.byLevel.org?Internal[0]');
  assert.equal(r({ v: 1, everywhere: true }), 'unknown-field residency.everywhere');
  assert.equal(r({ v: 2 }), 'unknown-version residency.v');
  const parsed = parseResidencySection({ v: 1, byLevel: { 'org/Internal': ['CA'], 'ca-protected/Protected A': ['EU'] } }, SCALE_PRESETS);
  assert.ok(parsed.ok && Object.isFrozen(parsed.value.byLevel));
  if (parsed.ok) assert.deepEqual(Object.keys(parsed.value.byLevel ?? {}), ['ca-protected/Protected A', 'org/Internal'], 'stored in key order');
});

test('D-28, D-63: onboarding fills contacts [], locked {} and all five kinds of work; discovery, when present, fills announce true and personalApprovals false', () => {
  const o = (value: unknown): string => sectionReason(parseOnboardingSection(value, SCALE_PRESETS));
  const filled = parseOnboardingSection({ v: 1 }, SCALE_PRESETS);
  assert.ok(filled.ok);
  if (filled.ok) {
    assert.deepEqual(filled.value, { v: 1, contacts: [], locked: {}, kindsOfWork: [...KINDS_OF_WORK] });
    assert.equal(filled.value.discovery, undefined);
  }
  const discovery = parseOnboardingSection({ v: 1, discovery: {} }, SCALE_PRESETS);
  assert.ok(discovery.ok);
  if (discovery.ok) assert.deepEqual(discovery.value.discovery, { networks: [], announce: true, scanRanges: [], personalApprovals: false });
  assert.deepEqual([...CONTACT_TOPICS], ['security', 'privacy', 'contract-security', 'it', 'export-control']);
  assert.deepEqual([...LOCKABLE_ANSWERS], ['canada']);
  assert.equal(o({ v: 1, locked: { canada: true } }), 'ok');
  assert.equal(o({ v: 1, locked: { canada: 'yes' } }), 'wrong-type onboarding.locked.canada');
  assert.equal(o({ v: 1, locked: { europe: true } }), 'unknown-field onboarding.locked.europe');
  assert.equal(o({ v: 1, kindsOfWork: ['writing', 'software'] }), 'ok', 'the order is the order offered');
  assert.equal(o({ v: 1, kindsOfWork: [] }), 'empty-list onboarding.kindsOfWork');
  assert.equal(o({ v: 1, kindsOfWork: ['software', 'software'] }), 'duplicate onboarding.kindsOfWork[1]');
  assert.equal(o({ v: 1, kindsOfWork: ['gaming'] }), 'not-allowed-here onboarding.kindsOfWork[0]');
  assert.equal(o({ v: 1, defaultScale: 'ca-protected' }), 'ok');
  assert.equal(o({ v: 1, defaultScale: 'planet' }), 'not-allowed-here onboarding.defaultScale');
  assert.equal(o({ v: 1, roles: ['software'] }), 'unknown-field onboarding.roles');
});

test('D-63: contacts hold at most eight { topic, name, how }, sorted by topic then name; export-control is a topic, an unknown one is refused', () => {
  const c = (value: unknown): string => sectionReason(parseContacts(value));
  const contact = (topic: string, name = 'Desk', how = 'desk@example.org'): Record<string, string> => ({ topic, name, how });
  assert.equal(c([contact('export-control', 'Export control desk'), contact('security')]), 'ok');
  assert.equal(c([contact('security'), contact('export-control')]), 'not-sorted contacts[1]');
  assert.equal(c([contact('security'), contact('security')]), 'duplicate contacts[1]');
  assert.equal(c([contact('legal')]), 'not-allowed-here contacts[0].topic');
  assert.equal(c([contact('security', '')]), 'wrong-type contacts[0].name');
  assert.equal(c([contact('security', 'Desk', 'x'.repeat(201))]), 'wrong-type contacts[0].how');
  assert.equal(c([{ ...contact('security'), email: 'x' }]), 'unknown-field contacts[0].email');
  const eight = Array.from({ length: 8 }, (_, index) => contact('security', `Desk ${String(index)}`));
  assert.equal(c(eight), 'ok');
  assert.equal(c([...eight, contact('security', 'Desk 8')]), 'not-allowed-here contacts');
});

test('D-28: discovery networks are named by a gateway or a DNS suffix, scan ranges are IPv4 /16 to /32 on a listed network', () => {
  const d = (discovery: unknown): string => sectionReason(parseOnboardingSection({ v: 1, discovery }, SCALE_PRESETS));
  const office = { id: 'head-office', gateway: '10.20.0.1' };
  assert.equal(d({ networks: [office], scanRanges: [{ cidr: '10.20.0.0/24', network: 'head-office' }] }), 'ok');
  assert.equal(d({ networks: [{ id: 'branch', dnsSuffix: 'branch.example.org' }] }), 'ok');
  assert.equal(d({ networks: [{ id: 'nowhere' }] }), 'missing-field onboarding.discovery.networks[0].gateway');
  assert.equal(d({ networks: [{ id: 'x', gateway: '10.20.0.256' }] }), 'wrong-type onboarding.discovery.networks[0].gateway');
  assert.equal(d({ networks: [{ id: 'x', dnsSuffix: 'Upper.example.org' }] }), 'wrong-type onboarding.discovery.networks[0].dnsSuffix');
  assert.equal(d({ networks: [{ id: 'b', gateway: '10.0.0.1' }, { id: 'a', gateway: '10.0.0.2' }] }), 'not-sorted onboarding.discovery.networks[1]');
  assert.equal(d({ networks: Array.from({ length: 17 }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, gateway: '10.0.0.1' })) }), 'not-allowed-here onboarding.discovery.networks');
  assert.equal(d({ scanRanges: [{ cidr: '10.0.0.0/8' }] }), 'not-allowed-here onboarding.discovery.scanRanges[0].cidr');
  assert.equal(d({ scanRanges: [{ cidr: '10.0.0.0/16' }, { cidr: '10.0.1.7/32' }] }), 'ok');
  assert.equal(d({ scanRanges: [{ cidr: 'example.org/24' }] }), 'wrong-type onboarding.discovery.scanRanges[0].cidr');
  assert.equal(d({ scanRanges: [{ cidr: '10.0.0.0/24', network: 'unlisted' }] }), 'not-allowed-here onboarding.discovery.scanRanges[0].network');
  assert.equal(d({ scanRanges: Array.from({ length: 33 }, (_, i) => ({ cidr: `10.0.${String(i)}.0/24` })) }), 'not-allowed-here onboarding.discovery.scanRanges');
  assert.equal(d({ announce: 'yes' }), 'wrong-type onboarding.discovery.announce');
  assert.equal(d({ personalApprovals: 1 }), 'wrong-type onboarding.discovery.personalApprovals');
  assert.equal(d({ hosts: [] }), 'unknown-field onboarding.discovery.hosts');
});

test('D-08: limits are whole numbers with the unit in the key; vaultHoursPerDay is 0 to 24; a fraction or trainingTargets is refused', () => {
  const l = (value: unknown): string => sectionReason(parseLimitsSection(value));
  assert.equal(l({ v: 1 }), 'ok');
  assert.equal(l({ v: 1, spend: { dailyNanoUsd: 5_000_000_000, vaultHoursPerDay: 24, hubDailyNanoUsd: 0 } }), 'ok');
  assert.equal(l({ v: 1, spend: { vaultHoursPerDay: 25 } }), 'not-allowed-here limits.spend.vaultHoursPerDay');
  assert.equal(l({ v: 1, spend: { dailyNanoUsd: 12.5 } }), 'wrong-type limits.spend.dailyNanoUsd');
  assert.equal(l({ v: 1, spend: { dailyUsd: 5 } }), 'unknown-field limits.spend.dailyUsd');
  assert.equal(l({ v: 1, trainingTargets: [] }), 'unknown-field limits.trainingTargets');
  assert.equal(l({ v: 1, spend: [] }), 'wrong-type limits.spend');
  // Through the document, a fraction anywhere is refused before the section is read.
  const doc = v2((d) => { d.limits = { v: 1, spend: { dailyNanoUsd: 12.5 } }; d.requires = ['agents@1', 'labels@1', 'layers@1', 'limits@1', 'people@1']; });
  assert.equal(reasonOf(doc), 'wrong-type');
});

test('every section: the full document round-trips, and each section without its feature in requires is malformed', () => {
  const key = issuerKey();
  const full = fullDocumentFor(key) as Loose;
  // Phase 71 (D-12): the credentials and agreements sections too. With credentials@1, the reserved status lists and offline ages are set there instead.
  full.reserved = { ...full.reserved, statusLists: [], maxOfflineAge: {} };
  full.credentials = {
    v: 1, root: { did: 'did:webvh:QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ:hq.example.org:org', scid: 'QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ' },
    issuance: { ClearanceCredential: { role: 'IssuerRoleCredential', ceiling: { scale: 'ca-classified', upTo: 'Secret' } } }, suites: ['eddsa-jcs-2022'],
    didMethods: ['did:webvh'], statusLists: [{ uri: 'https://status.example.org/list', purpose: 'revocation', key: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' }],
    statusTtl: 900, maxOfflineAge: { 'org/Restricted': 86400 }, requiredBySensitivity: { 'ca-classified/Secret': ['ClearanceCredential'] }
  };
  full.agreements = { v: 1, items: [{ id: 'agreement-1', partner: 'Example Partner Organization', tokens: ['GBR'], levelCeiling: 'org/Restricted', compartments: [], until: '2027-11-24T00:00:00.000Z' }] };
  full.requires = [...full.requires, 'agreements@1', 'credentials@1'].sort();
  // Phase 70.1 (D-16): the classification section.
  full.classification = {
    v: 1, thresholds: { 'org/Restricted': { costRatio: 9, recallTarget: 9500, secondFamily: false } },
    markings: [{ id: 'banner-restricted', pattern: 'RESTRICTED', label: { scale: 'org', level: 'Restricted', compartments: [], releasability: [], handling: [] } }]
  };
  full.requires = [...full.requires, 'classification@1'].sort();
  // Phase 45.1 (D-02): the label table for allies, with fictional values only.
  full.labelInterop = {
    v: 1, version: 1,
    scales: { org: { policy: 'EXAMPLE-POLICY', levels: { Internal: 'EXAMPLE-INTERNAL' }, compartments: {}, releasableTo: { category: 'EXAMPLE-RELEASABLE-TO', values: { GBR: 'EXAMPLE-GBR' } } } }
  };
  full.requires = [...full.requires, 'label-interop@1'].sort();
  const parsed = parsePolicyDocument(full);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) return;
  for (const section of POLICY_SECTIONS) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed.value, section), `the full document has ${section}`);
  }
  for (const section of POLICY_SECTIONS) {
    const feature = featureForSection(section);
    if (feature === undefined) continue;
    const without = plain(full);
    without.requires = without.requires.filter((id: string) => id !== feature);
    assert.equal(failureOf(without), 'malformed', section);
  }
  const again = parsePolicyDocument(plain(parsed.value));
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.value, parsed.value);
});

test('residency, onboarding and limits are read in the document at their own paths', () => {
  const with3 = (edit: (d: Loose) => void): Loose => v2((d) => {
    d.requires = ['agents@1', 'labels@1', 'layers@1', 'limits@1', 'onboarding@1', 'people@1', 'residency@1'];
    d.residency = { v: 1, required: ['CA'] };
    d.onboarding = { v: 1 };
    d.limits = { v: 1 };
    edit(d);
  });
  const ok = parsePolicyDocument(with3(() => undefined));
  assert.ok(ok.ok, ok.ok ? '' : ok.message);
  if (ok.ok) assert.deepEqual(ok.value.onboarding?.kindsOfWork, [...KINDS_OF_WORK]);
  const at = (edit: (d: Loose) => void): string => { const parsed = parsePolicyDocument(with3(edit)); return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`; };
  assert.equal(at((d) => { d.residency.required = ['unstated']; }), 'not-allowed-here residency.required[0]');
  assert.equal(at((d) => { d.onboarding.contacts = Array.from({ length: 9 }, (_, i) => ({ topic: 'it', name: `Desk ${String(i)}`, how: 'it@example.org' })); }), 'not-allowed-here onboarding.contacts');
  assert.equal(at((d) => { d.limits.spend = { vaultHoursPerDay: 25 }; }), 'not-allowed-here limits.spend.vaultHoursPerDay');
  assert.equal(at((d) => { d.onboarding.v = 2; }), 'unknown-version onboarding.v');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// exportControl (export-control@1), shapes only (D-60, D-63)

function exportReason(edit: (section: Loose) => void): string {
  const section = plain(exportControlExample());
  edit(section);
  return sectionReason(parseExportControlSection(section, SCALE_PRESETS));
}

test('D-60: the exportControl example of CGP-ITAR 6.4 parses, and a minimal section has its defaults filled', () => {
  const parsed = parseExportControlSection(exportControlExample(), SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (parsed.ok) assert.deepEqual(parsed.value, exportControlExample());
  assert.deepEqual([...EXPORT_REGIMES], ['CGP', 'EAR', 'ITAR']);
  const minimal = parseExportControlSection({ v: 1, regimes: ['ITAR'], officials: [{ regime: 'ITAR', position: 'empowered-official' }] }, SCALE_PRESETS);
  assert.ok(minimal.ok);
  if (minimal.ok) {
    assert.deepEqual(minimal.value, {
      v: 1, regimes: ['ITAR'], officials: [{ regime: 'ITAR', position: 'empowered-official' }], suggestRules: 'standard', agentNetwork: 'refuse',
      retention: { neverAutoPrune: true }, incidents: { contacts: ['export-control'] }
    });
    assert.ok(Object.isFrozen(minimal.value) && Object.isFrozen(minimal.value.officials) && Object.isFrozen(minimal.value.incidents.contacts));
  }
  assert.equal(exportReason((s) => { s.suggestRules = 'automatic'; }), 'ok');
  assert.equal(exportReason((s) => { s.suggestRules = 'off'; }), 'ok');
  assert.equal(exportReason((s) => { s.registration = { CGP: { registered: false, reference: 'CGP-REG-0001', endsOn: '2026-10-01T00:00:00.000Z' } }; }), 'ok');
});

test('D-60: exportControl refuses an unknown regime, unsorted or repeated regimes, and anything but one official per listed regime', () => {
  assert.equal(exportReason((s) => { s.regimes = ['CGP', 'EAR', 'OTHER']; }), 'not-allowed-here exportControl.regimes[2]');
  assert.equal(exportReason((s) => { s.regimes = ['ITAR', 'CGP', 'EAR']; }), 'not-sorted exportControl.regimes[1]');
  assert.equal(exportReason((s) => { s.regimes = ['CGP', 'CGP', 'EAR', 'ITAR']; }), 'duplicate exportControl.regimes[1]');
  assert.equal(exportReason((s) => { s.regimes = []; }), 'empty-list exportControl.regimes');
  assert.equal(exportReason((s) => { s.officials = s.officials.slice(0, 2); }), 'missing-field exportControl.officials', 'no official for ITAR');
  assert.equal(exportReason((s) => { s.officials.splice(1, 0, { regime: 'CGP', position: 'deputy' }); }), 'duplicate exportControl.officials[1]', 'two for CGP');
  assert.equal(exportReason((s) => { s.regimes = ['CGP']; }), 'not-allowed-here exportControl.officials[1].regime', 'an official for an unlisted regime');
  assert.equal(exportReason((s) => { s.officials[0].position = 'Designated Official'; }), 'wrong-type exportControl.officials[0].position');
  assert.equal(exportReason((s) => { s.officials.reverse(); }), 'not-sorted exportControl.officials[1]');
  assert.equal(exportReason((s) => { delete s.officials; }), 'missing-field exportControl.officials');
});

test('D-60: registration only for listed regimes; agentNetwork only refuse; retention only never pruned; incidents only contact topics; keys exact', () => {
  assert.equal(exportReason((s) => { s.regimes = ['CGP']; s.officials = [s.officials[0]]; s.registration.ITAR = { registered: true, reference: 'M-0001', endsOn: null }; }), 'not-allowed-here exportControl.registration.ITAR');
  assert.equal(exportReason((s) => { s.registration.OTHER = { registered: true, reference: 'x', endsOn: null }; }), 'unknown-field exportControl.registration.OTHER');
  assert.equal(exportReason((s) => { s.registration.CGP.endsOn = 'soon'; }), 'wrong-type exportControl.registration.CGP.endsOn');
  assert.equal(exportReason((s) => { delete s.registration.CGP.endsOn; }), 'missing-field exportControl.registration.CGP.endsOn');
  assert.equal(exportReason((s) => { s.agentNetwork = 'allow'; }), 'not-allowed-here exportControl.agentNetwork');
  assert.equal(exportReason((s) => { s.retention.neverAutoPrune = false; }), 'not-allowed-here exportControl.retention.neverAutoPrune');
  assert.equal(exportReason((s) => { s.retention.days = 30; }), 'unknown-field exportControl.retention.days');
  assert.equal(exportReason((s) => { s.incidents.contacts = ['legal']; }), 'not-allowed-here exportControl.incidents.contacts[0]');
  assert.equal(exportReason((s) => { s.incidents.contacts = ['security', 'export-control']; }), 'not-sorted exportControl.incidents.contacts[1]');
  assert.equal(exportReason((s) => { s.incidents.contacts = ['export-control', 'security']; }), 'ok');
  assert.equal(exportReason((s) => { s.suggestRules = 'always'; }), 'not-allowed-here exportControl.suggestRules');
  assert.equal(exportReason((s) => { s.exportEligible = true; }), 'unknown-field exportControl.exportEligible');
  assert.equal(exportReason((s) => { s.v = 2; }), 'unknown-version exportControl.v');
  assert.equal(sectionReason(parseRegimes(['CGP', 'ITAR'], 'regimes')), 'ok');
});

test('D-60, D-63: the section needs export-control@1 in requires, and export-control is a contact topic', () => {
  const withSection = (requires: string[]): Loose => v2((d) => { d.exportControl = exportControlExample(); d.requires = requires; });
  assert.equal(failureOf(withSection(['agents@1', 'labels@1', 'layers@1', 'people@1'])), 'malformed');
  assert.equal(reasonOf(withSection(['agents@1', 'export-control@1', 'labels@1', 'layers@1', 'people@1'])), 'ok');
  assert.ok((CONTACT_TOPICS as readonly string[]).includes('export-control'));
  assert.equal(sectionReason(parseContacts([{ topic: 'export-control', name: 'Export control desk', how: 'exports@example.org' }])), 'ok');
});

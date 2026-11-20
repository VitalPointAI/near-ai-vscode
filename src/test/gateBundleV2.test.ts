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
import { signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { FIXED_NOW, activeKeys, deviceKey, fullDocumentFor, issuerKey, policyDocumentFor, signPersonalLayer } from './helpers/policyFixtures';

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
  assert.match(sentence, /Update the NEAR AI extension/);
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

test('features: KNOWN_BUNDLE_FEATURES is FEATURE_IDS, every section but reserved has its feature, and the list is the D-06 list plus export-control@1', () => {
  assert.deepEqual([...KNOWN_BUNDLE_FEATURES], [...FEATURE_IDS]);
  assert.deepEqual([...FEATURE_IDS], ['labels@1', 'endpoints@1', 'authorizations@1', 'residency@1', 'models@1', 'agents@1', 'people@1', 'onboarding@1', 'limits@1', 'layers@1', 'export-control@1']);
  assert.deepEqual([...POLICY_SECTIONS], ['labels', 'endpoints', 'authorizations', 'models', 'agents', 'residency', 'people', 'onboarding', 'limits', 'reserved', 'exportControl']);
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

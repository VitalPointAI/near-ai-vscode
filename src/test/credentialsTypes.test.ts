// Credential types and their exact claims (Phase 71 plan 03 Task 2; D-06, VCRD-01, VCRD-05). Fictional subjects only (Example Organization).
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import {
  CREDENTIAL_TYPES, DEVICE_BINDING_TYPE, PERSON_ATTRIBUTE_TYPES, RESERVED_TYPES, ROLE_TYPES, SERVES_VALUES, STATUS_LIST_TYPE, credentialTimeMs, parseClaims,
  thresholdsFor
} from '../domain/credentials/types';
import type { CredentialType } from '../domain/credentials/types';

const ALEX = 'did:webvh:QmExampleScidOnlyForTests:example.org:people:alex';
const LAPTOP = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

const VALID: Readonly<Record<CredentialType, { subject: string; claims: Record<string, unknown> }>> = {
  MembershipCredential: { subject: ALEX, claims: { organization: 'Example Organization' } },
  ClearanceCredential: { subject: ALEX, claims: { scale: 'ca-classified', atLeast: 'Secret' } },
  CompartmentCredential: { subject: ALEX, claims: { compartment: 'ALPHA' } },
  ServiceCredential: { subject: ALEX, claims: { serves: 'public-servant' } },
  NationalityCredential: { subject: ALEX, claims: { nationality: 'CAN' } },
  AffiliationCredential: { subject: ALEX, claims: { organization: 'Example Partner Organization' } },
  ExportEligibilityCredential: { subject: ALEX, claims: { regime: 'CGP', basis: 'Registered under the example programme, file EX-1' } },
  AccessAgreementCredential: { subject: ALEX, claims: { agreement: 'agreement-example-1', scope: 'project:example-project' } },
  VisitClearanceCredential: { subject: ALEX, claims: { request: 'visit-1', site: 'hq.example.org', from: '2026-12-01T00:00:00Z', until: '2026-12-05T00:00:00Z' } },
  ObserverAccessCredential: { subject: ALEX, claims: { project: 'example-project', position: 'observer-1', cells: ['cell-a', 'cell-b'], until: '2027-01-01T00:00:00Z' } },
  IssuerRoleCredential: { subject: ALEX, claims: { credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' } },
  SecurityContactCredential: { subject: ALEX, claims: { scope: 'organization' } },
  ReleaseAuthorityCredential: { subject: ALEX, claims: { scope: 'section:j5' } },
  ClassificationAuthorityCredential: { subject: ALEX, claims: { scale: 'ca-classified', upTo: 'Secret', scope: 'own-items' } },
  RoleCredential: { subject: ALEX, claims: { role: 'enrolment-officer', scope: 'organization' } },
  DeviceBindingCredential: { subject: LAPTOP, claims: { device: `dev-${'a1'.repeat(16)}`, class: 'managed' } },
  BitstringStatusListCredential: {
    subject: 'https://hq.example.org/status/1#list',
    claims: { type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList: 'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA', version: 1, ttl: 900000 }
  }
};

function subjectOf(type: CredentialType, change: Record<string, unknown> = {}, drop?: string): Record<string, unknown> {
  const sample = VALID[type];
  const subject: Record<string, unknown> = { id: sample.subject, ...sample.claims, ...change };
  if (drop !== undefined) delete subject[drop];
  return subject;
}

function refusal(type: string, subject: unknown): { reason: string; path: string } {
  const result = parseClaims(type, subject, SCALE_PRESETS);
  assert.equal(result.ok, false, `${type} should be refused: ${JSON.stringify(subject)}`);
  if (result.ok) throw new Error('unreachable');
  return { reason: result.reason, path: result.path };
}

test('the type lists: ten person attributes, five authority types, the device binding and the W3C status list, with DelegationCredential reserved', () => {
  assert.equal(PERSON_ATTRIBUTE_TYPES.length, 10);
  assert.deepEqual([...ROLE_TYPES], ['IssuerRoleCredential', 'SecurityContactCredential', 'ReleaseAuthorityCredential', 'ClassificationAuthorityCredential', 'RoleCredential']);
  assert.equal(CREDENTIAL_TYPES.length, 17);
  assert.ok(CREDENTIAL_TYPES.includes(DEVICE_BINDING_TYPE) && CREDENTIAL_TYPES.includes(STATUS_LIST_TYPE));
  assert.deepEqual(Object.keys(VALID).sort(), [...CREDENTIAL_TYPES].sort(), 'every type has a sample in this test');
  assert.ok(Object.isFrozen(CREDENTIAL_TYPES) && Object.isFrozen(ROLE_TYPES) && Object.isFrozen(PERSON_ATTRIBUTE_TYPES));
  assert.deepEqual([...RESERVED_TYPES], ['DelegationCredential']);
});

for (const type of Object.keys(VALID) as CredentialType[]) {
  test(`${type}: the exact claims parse frozen; a missing claim, an extra claim and a claim of the wrong kind are each refused`, () => {
    const parsed = parseClaims(type, subjectOf(type), SCALE_PRESETS);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.message);
    if (!parsed.ok) return;
    assert.ok(Object.isFrozen(parsed.value));
    assert.equal(parsed.value.id, VALID[type].subject);
    for (const key of Object.keys(VALID[type].claims)) {
      if (key === 'ttl') continue;
      assert.equal(refusal(type, subjectOf(type, {}, key)).reason, 'missing-field', `${type} without ${key}`);
      assert.notEqual(parseClaims(type, subjectOf(type, { [key]: 42.5 }), SCALE_PRESETS).ok, true, `${type} with ${key} as a number`);
    }
    assert.equal(refusal(type, subjectOf(type, { level: 'Secret' })).reason, 'unknown-field');
    assert.equal(refusal(type, subjectOf(type, {}, 'id')).reason, 'missing-field');
  });
}

test('ClearanceCredential needs a scale in the table it is read against and a level on that scale', () => {
  assert.equal(refusal('ClearanceCredential', subjectOf('ClearanceCredential', { scale: 'ca-gc-classified' })).reason, 'not-allowed-here');
  assert.equal(refusal('ClearanceCredential', subjectOf('ClearanceCredential', { atLeast: 'Protected B' })).reason, 'not-allowed-here');
  assert.equal(refusal('ClearanceCredential', subjectOf('ClearanceCredential', { atLeast: 'secret' })).reason, 'not-allowed-here', 'level names compare exactly');
  const ownScales = { 'ca-gc-classified': { name: 'Example', levels: ['Confidential', 'Secret'] } };
  assert.equal(parseClaims('ClearanceCredential', subjectOf('ClearanceCredential', { scale: 'ca-gc-classified' }), ownScales).ok, true, 'a policy scale is read too');
  assert.equal(parseClaims('ClearanceCredential', subjectOf('ClearanceCredential', { scale: '__proto__' }), SCALE_PRESETS).ok, false);
});

test('thresholdsFor: someone cleared to Secret holds Confidential and Secret, one credential each; an unknown scale or level gives none', () => {
  assert.deepEqual([...thresholdsFor(SCALE_PRESETS, 'ca-classified', 'Secret')], ['Confidential', 'Secret']);
  assert.deepEqual([...thresholdsFor(SCALE_PRESETS, 'ca-classified', 'Confidential')], ['Confidential']);
  assert.deepEqual([...thresholdsFor(SCALE_PRESETS, 'ca-protected', 'Protected C')], ['Protected A', 'Protected B', 'Protected C']);
  assert.deepEqual([...thresholdsFor(SCALE_PRESETS, 'ca-classified', 'Cosmic Top Secret')], []);
  assert.deepEqual([...thresholdsFor(SCALE_PRESETS, 'unknown', 'Secret')], []);
  assert.ok(Object.isFrozen(thresholdsFor(SCALE_PRESETS, 'ca-classified', 'Secret')));
});

test('ClassificationAuthorityCredential: scope own-items, organization, a project or a section; upTo must be on the scale', () => {
  for (const scope of ['own-items', 'organization', 'project:example-project', 'section:j2']) {
    assert.equal(parseClaims('ClassificationAuthorityCredential', subjectOf('ClassificationAuthorityCredential', { scope }), SCALE_PRESETS).ok, true, scope);
  }
  for (const scope of ['everything', 'project:', 'team:x', 'own-items ']) {
    assert.equal(refusal('ClassificationAuthorityCredential', subjectOf('ClassificationAuthorityCredential', { scope })).reason, 'not-allowed-here', scope);
  }
  assert.equal(refusal('ClassificationAuthorityCredential', subjectOf('ClassificationAuthorityCredential', { upTo: 'Protected B' })).reason, 'not-allowed-here');
  assert.equal(refusal('SecurityContactCredential', subjectOf('SecurityContactCredential', { scope: 'own-items' })).reason, 'not-allowed-here', 'own-items is only an originator\'s authority');
});

test('ServiceCredential accepts only the six 33.1 ways of serving', () => {
  assert.deepEqual([...SERVES_VALUES], ['regular-force', 'reserve-force', 'public-servant', 'contractor', 'allied-military', 'industry']);
  for (const serves of SERVES_VALUES) assert.equal(parseClaims('ServiceCredential', subjectOf('ServiceCredential', { serves }), SCALE_PRESETS).ok, true, serves);
  for (const serves of ['Regular-Force', 'volunteer', '']) assert.equal(refusal('ServiceCredential', subjectOf('ServiceCredential', { serves })).reason, 'not-allowed-here', serves);
});

test('NationalityCredential accepts an ISO 3166-1 alpha-3 code or a group token, never lower case and never "releasable to no one"', () => {
  for (const nationality of ['CAN', 'GBR', 'FVEY', 'NATO']) assert.equal(parseClaims('NationalityCredential', subjectOf('NationalityCredential', { nationality }), SCALE_PRESETS).ok, true, nationality);
  assert.equal(refusal('NationalityCredential', subjectOf('NationalityCredential', { nationality: 'can' })).reason, 'wrong-type');
  assert.equal(refusal('NationalityCredential', subjectOf('NationalityCredential', { nationality: 'RELEASABLE-TO-NONE' })).reason, 'not-allowed-here');
});

test('ExportEligibilityCredential accepts only CGP, ITAR or EAR as its regime', () => {
  for (const regime of ['CGP', 'ITAR', 'EAR']) assert.equal(parseClaims('ExportEligibilityCredential', subjectOf('ExportEligibilityCredential', { regime }), SCALE_PRESETS).ok, true);
  assert.equal(refusal('ExportEligibilityCredential', subjectOf('ExportEligibilityCredential', { regime: 'ALPHA' })).reason, 'not-allowed-here');
});

test('IssuerRoleCredential: a ceiling is a scale and a level together; it may name only a person-attribute type, compartments and regimes sorted', () => {
  assert.equal(parseClaims('IssuerRoleCredential', { id: ALEX, credentialType: 'MembershipCredential' }, SCALE_PRESETS).ok, true, 'no ceiling is allowed');
  assert.equal(refusal('IssuerRoleCredential', { id: ALEX, credentialType: 'ClearanceCredential', scale: 'ca-classified' }).reason, 'missing-field');
  assert.equal(refusal('IssuerRoleCredential', { id: ALEX, credentialType: 'ClearanceCredential', upTo: 'Secret' }).reason, 'missing-field');
  assert.equal(refusal('IssuerRoleCredential', subjectOf('IssuerRoleCredential', { credentialType: 'IssuerRoleCredential' })).reason, 'not-allowed-here', 'a role is only issued by the root');
  assert.equal(refusal('IssuerRoleCredential', subjectOf('IssuerRoleCredential', { credentialType: 'DelegationCredential' })).reason, 'not-allowed-here');
  assert.equal(parseClaims('IssuerRoleCredential', subjectOf('IssuerRoleCredential', { compartments: ['ALPHA', 'BRAVO'], regimes: ['CGP', 'ITAR'] }), SCALE_PRESETS).ok, true);
  assert.equal(refusal('IssuerRoleCredential', subjectOf('IssuerRoleCredential', { compartments: ['BRAVO', 'ALPHA'] })).reason, 'not-sorted');
  assert.equal(refusal('IssuerRoleCredential', subjectOf('IssuerRoleCredential', { regimes: ['CGP', 'CGP'] })).reason, 'duplicate');
  assert.equal(refusal('IssuerRoleCredential', subjectOf('IssuerRoleCredential', { regimes: ['XYZ'] })).reason, 'wrong-type');
  assert.equal(refusal('IssuerRoleCredential', subjectOf('IssuerRoleCredential', { compartments: [] })).reason, 'empty-list');
});

test('DeviceBindingCredential: the subject must be a device did:key, the device a Phase 69 fingerprint and the class one of three', () => {
  assert.equal(refusal('DeviceBindingCredential', subjectOf('DeviceBindingCredential', { id: ALEX })).reason, 'not-allowed-here');
  assert.equal(refusal('DeviceBindingCredential', subjectOf('DeviceBindingCredential', { device: 'laptop-1' })).reason, 'wrong-type');
  assert.equal(refusal('DeviceBindingCredential', subjectOf('DeviceBindingCredential', { class: 'phone' })).reason, 'not-allowed-here');
});

test('VisitClearanceCredential must end after it starts; ObserverAccessCredential cells are sorted, distinct and not empty', () => {
  assert.equal(refusal('VisitClearanceCredential', subjectOf('VisitClearanceCredential', { until: '2026-12-01T00:00:00Z' })).reason, 'not-allowed-here');
  assert.equal(refusal('VisitClearanceCredential', subjectOf('VisitClearanceCredential', { from: '2026-02-30T00:00:00Z' })).reason, 'wrong-type', 'no date that rolls over');
  assert.equal(refusal('ObserverAccessCredential', subjectOf('ObserverAccessCredential', { cells: [] })).reason, 'empty-list');
  assert.equal(refusal('ObserverAccessCredential', subjectOf('ObserverAccessCredential', { cells: ['b', 'a'] })).reason, 'not-sorted');
});

test('an unknown type, the reserved DelegationCredential and a subject that is not a plain object are refused; subject ids must be DIDs', () => {
  assert.equal(refusal('DelegationCredential', { id: ALEX }).reason, 'not-available-yet');
  assert.equal(refusal('AlumniCredential', { id: ALEX }).reason, 'not-available-yet');
  assert.equal(refusal('toString', { id: ALEX }).reason, 'not-available-yet');
  assert.equal(refusal('MembershipCredential', [subjectOf('MembershipCredential')]).reason, 'wrong-type');
  assert.equal(refusal('MembershipCredential', subjectOf('MembershipCredential', { id: 'https://example.org/alex' })).reason, 'wrong-type');
  assert.equal(refusal('MembershipCredential', subjectOf('MembershipCredential', { id: 'did:webvh:' })).reason, 'wrong-type');
});

test('a claim inherited from a prototype or named __proto__ is never read', () => {
  const inherited = Object.create({ organization: 'Example Organization' }) as Record<string, unknown>;
  inherited.id = ALEX;
  assert.equal(parseClaims('MembershipCredential', inherited, SCALE_PRESETS).ok, false);
  const hostile = JSON.parse(`{"id":"${ALEX}","organization":"Example Organization","__proto__":{"x":1}}`) as unknown;
  assert.equal(refusal('MembershipCredential', hostile).reason, 'unknown-field');
});

test('credentialTimeMs reads UTC times with seconds or exactly three fraction digits, and nothing else', () => {
  assert.equal(credentialTimeMs('2026-11-24T00:00:00Z'), Date.UTC(2026, 10, 24));
  assert.equal(credentialTimeMs('2026-11-24T00:00:00.500Z'), Date.UTC(2026, 10, 24) + 500);
  for (const bad of ['2026-11-24T00:00:00+01:00', '2026-11-24T00:00:00z', '2026-11-24', '2026-02-30T00:00:00Z', '2026-11-24T00:00:00.5Z', 20261124]) {
    assert.ok(Number.isNaN(credentialTimeMs(bad)), String(bad));
  }
});

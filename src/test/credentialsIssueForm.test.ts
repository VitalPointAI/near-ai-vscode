// The Issue credential form (Phase 71 plan 12 Task 3; D-15, D-21): what an officer may issue now, the claims each type needs in plain words, the
// checks before the review step and the sentence they read before they sign. Fictional Example Organization only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import {
  ISSUE_FORM_TEXT, formFor, issuableTypes, revokeSentence, reviewSentence, suspendSentence, validUntilFor, validateForm,
} from '../domain/credentials/issueForm';
import type { FormPolicy, FormValues, HeldRole } from '../domain/credentials/issueForm';

const NOW = Date.parse('2027-01-10T12:00:00Z');
const policy: FormPolicy = {
  issuance: {
    ClearanceCredential: { role: 'IssuerRoleCredential', ceiling: { scale: 'ca-classified', upTo: 'Secret' } },
    NationalityCredential: { role: 'IssuerRoleCredential' },
    VisitClearanceCredential: { role: 'SecurityContactCredential' },
  },
  scales: SCALE_PRESETS,
};
const role = (claims: Record<string, unknown>, validUntil = '2027-06-01T00:00:00Z', type = 'IssuerRoleCredential'): HeldRole => ({ type, validFrom: '2026-03-01T00:00:00Z', validUntil, claims });
const clearanceRole = role({ credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Top Secret' });
const ALEX = 'did:webvh:QmExample:hq.example.org:people:alex';
const values = (overrides: Partial<FormValues> = {}): FormValues => ({ personName: 'Alex', subject: ALEX, until: '2027-03-31', claims: { scale: 'ca-classified', atLeast: 'Secret' }, ...overrides });

test('issuableTypes lists only what the officer\'s current roles and the policy allow, with the lower ceiling', () => {
  const types = issuableTypes([clearanceRole, role({ credentialType: 'NationalityCredential' }, '2026-12-01T00:00:00Z'), role({ scope: 'organization' }, '2027-06-01T00:00:00Z', 'SecurityContactCredential')], policy, NOW);
  // The nationality role has ended; the visit clearance has its own flow; the policy's Secret ceiling is lower than the role's Top Secret.
  assert.deepEqual(types.map((entry) => [entry.type, entry.ceiling]), [['ClearanceCredential', 'Secret on the Canadian classified scale']]);
  assert.equal(types[0]?.roleValidUntil, '2027-06-01T00:00:00Z');
  assert.deepEqual(issuableTypes([], policy, NOW), []);
  assert.deepEqual(issuableTypes([role({ credentialType: 'NationalityCredential' })], { ...policy, issuance: {} }, NOW), [], 'no rule, nothing offered');
});

test('formFor(ClearanceCredential) asks for the person, the scale, a level up to the ceiling and the last day, in plain words', () => {
  const [clearance] = issuableTypes([clearanceRole], policy, NOW);
  assert.ok(clearance);
  assert.deepEqual(clearance.fields.map((field) => [field.name, field.label, field.kind]), [
    ['subject', 'The person', 'person'], ['personName', 'Their name', 'text'], ['scale', 'Scale', 'choice'], ['atLeast', 'Level', 'choice'], ['until', 'Last day', 'date'],
  ]);
  assert.deepEqual(clearance.fields.find((field) => field.name === 'atLeast')?.options?.map((option) => option.value), ['Confidential', 'Secret']);
  assert.deepEqual(clearance.fields.find((field) => field.name === 'scale')?.options, [{ value: 'ca-classified', label: 'Canada, Classified' }]);
  assert.deepEqual(formFor('NationalityCredential', { type: 'NationalityCredential', label: 'nationality', roleValidUntil: '2027-06-01T00:00:00Z' }, SCALE_PRESETS)
    .map((field) => field.name), ['subject', 'personName', 'nationality', 'until']);
});

test('validateForm refuses a level above the ceiling and a last day past the role\'s own end', () => {
  const [clearance] = issuableTypes([clearanceRole], policy, NOW);
  assert.ok(clearance);
  assert.deepEqual(validateForm(clearance, values({ claims: { scale: 'ca-classified', atLeast: 'Top Secret' } }), SCALE_PRESETS, NOW), { ok: false, field: 'atLeast', message: ISSUE_FORM_TEXT.aboveCeiling });
  assert.deepEqual(validateForm(clearance, values({ until: '2027-06-01' }), SCALE_PRESETS, NOW), { ok: false, field: 'until', message: ISSUE_FORM_TEXT.pastRole });
  assert.deepEqual(validateForm(clearance, values({ until: '2027-05-31' }), SCALE_PRESETS, NOW), { ok: true, validUntil: '2027-06-01T00:00:00Z' }, 'the last day the role allows');
});

test('validateForm refuses a missing field, a computer\'s identity, an impossible date and a day already past', () => {
  const [clearance] = issuableTypes([clearanceRole], policy, NOW);
  assert.ok(clearance);
  const check = (overrides: Partial<FormValues>) => validateForm(clearance, values(overrides), SCALE_PRESETS, NOW);
  assert.deepEqual(check({ subject: '' }), { ok: false, field: 'subject', message: ISSUE_FORM_TEXT.missing });
  assert.deepEqual(check({ subject: 'did:key:z6MkExample' }), { ok: false, field: 'subject', message: ISSUE_FORM_TEXT.notAPerson });
  assert.deepEqual(check({ personName: ' ' }), { ok: false, field: 'personName', message: ISSUE_FORM_TEXT.missing });
  assert.deepEqual(check({ claims: { scale: 'ca-classified' } }), { ok: false, field: 'atLeast', message: ISSUE_FORM_TEXT.missing });
  assert.deepEqual(check({ until: '2027-02-30' }), { ok: false, field: 'until', message: ISSUE_FORM_TEXT.badDate });
  assert.deepEqual(check({ until: '2027-01-09' }), { ok: false, field: 'until', message: ISSUE_FORM_TEXT.notFuture });
});

test('the review sentence says exactly what will be signed, with the year only when it is not this year', () => {
  assert.equal(reviewSentence('ClearanceCredential', values(), SCALE_PRESETS, NOW), 'You are about to issue: Secret clearance on the Canadian classified scale to Alex, until 31 March.');
  assert.equal(reviewSentence('ClearanceCredential', values({ until: '2028-03-31' }), SCALE_PRESETS, NOW), 'You are about to issue: Secret clearance on the Canadian classified scale to Alex, until 31 March 2028.');
  assert.equal(reviewSentence('NationalityCredential', values({ claims: { nationality: 'CAN' } }), SCALE_PRESETS, NOW), 'You are about to issue: nationality CAN to Alex, until 31 March.');
});

test('revoking and suspending each have their own review sentence, and the last day holds through that day', () => {
  assert.equal(revokeSentence('ClearanceCredential', 'Alex'), 'You are about to revoke Alex\'s clearance. A revocation can never be undone.');
  assert.match(suspendSentence('ClearanceCredential', 'Alex'), /^You are about to suspend Alex's clearance\. .*lift a suspension later\.$/);
  assert.equal(validUntilFor('2027-03-31'), '2027-04-01T00:00:00Z');
  assert.equal(validUntilFor('2027-12-31'), '2028-01-01T00:00:00Z');
  assert.equal(validUntilFor('not a day'), '');
});

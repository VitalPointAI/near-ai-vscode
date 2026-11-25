// The exception draft (74.1-11 Task 1, D-20, design 5.3, O3): chat you review only, at most 90 days, named projects and labels, a named person and a
// mission benefit; the legal flags read first; and the inner signature covers the scope, so a scope edited after signing does not verify.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAuthorizationBody, verifyAuthorization } from '../domain/gate/authorizations';
import { EXCEPTION_TEXT, draftRiskAcceptance, endsOnBounds, exceptionRow, legalFlagsLine, researchOnlyRow } from '../domain/gate/riskAcceptance';
import type { ExceptionDraftInput } from '../domain/gate/riskAcceptance';
import { SHIPPED_PASSPORTS } from '../domain/gate/shippedPassports';
import { signPayload } from '../domain/team/signedPayload';
import { deviceKey } from './helpers/policyFixtures';

const ISSUED = '2026-11-25T15:00:00.000Z';
const NOW = Date.parse(ISSUED);
const passport = (id: string) => SHIPPED_PASSPORTS.find((entry) => entry.id === id);

function input(extra: Partial<ExceptionDraftInput> = {}): ExceptionDraftInput {
  return {
    id: 'ra-20261125-abc123', model: 'z-ai/glm', projects: ['project-p'], labels: ['org/Internal'], conditions: [...EXCEPTION_TEXT.conditionDefaults],
    benefit: 'Reads Chinese technical papers for the J2 cell.', person: { name: 'Avery Chen', position: 'Director, Intelligence' },
    endsOn: '2026-12-25', issuedAt: ISSUED, ...extra
  };
}

test('D-20: a draft for z-ai/glm, project P, label org/Internal and 30 days parses as a t1-risk body covering chat you review only', () => {
  const draft = draftRiskAcceptance(input());
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  const parsed = parseAuthorizationBody(draft.body);
  assert.equal(parsed.ok, true);
  assert.equal(draft.body.kind, 't1-risk');
  assert.deepEqual(draft.body.scope, { projects: ['project-p'], labels: ['org/Internal'], uses: ['t1'] });
  assert.deepEqual(draft.body.subject, { model: 'z-ai/glm' });
  assert.deepEqual(draft.body.namedPerson, { name: 'Avery Chen', role: 'Director, Intelligence' });
  assert.equal(draft.body.expiresAt, '2026-12-25T00:00:00.000Z');
  assert.equal(draft.body.evidence, 'Reads Chinese technical papers for the J2 cell.');
});

test('O3: a use other than chat you review is refused in words', () => {
  const draft = draftRiskAcceptance(input({ uses: ['t2'] }));
  assert.deepEqual(draft.ok ? {} : draft.errors, { use: 'An exception covers chat you review only.' });
});

test('O3: more than 90 days is refused with the last allowed date; the last allowed day itself passes', () => {
  const bounds = endsOnBounds(ISSUED);
  assert.deepEqual(bounds, { min: '2026-11-26', max: '2027-02-23', fallback: '2026-12-25' });
  const long = draftRiskAcceptance(input({ endsOn: '2027-02-24' }));
  assert.deepEqual(long.ok ? {} : long.errors, { ends: 'An exception can last at most 90 days. Choose 23 Feb 2027 or earlier.' });
  assert.equal(draftRiskAcceptance(input({ endsOn: bounds.max })).ok, true);
});

test('an end day of today or earlier is refused', () => {
  for (const endsOn of ['2026-11-25', '2026-11-01', 'tomorrow']) {
    const draft = draftRiskAcceptance(input({ endsOn }));
    assert.deepEqual(draft.ok ? {} : draft.errors, { ends: 'Choose a date after today.' }, endsOn);
  }
});

test('no project, no label, no named person and an empty benefit are each refused with their own sentence', () => {
  const draft = draftRiskAcceptance(input({ projects: [], labels: [' '], person: { name: 'Avery Chen', position: '' }, benefit: '   ' }));
  assert.deepEqual(draft.ok ? {} : draft.errors, {
    projects: 'Choose at least one project.', labels: 'Choose at least one label.', person: 'Give the named person\'s name and position.', benefit: 'Say what this model does for the mission.'
  });
});

test('design 5.3: the legal flags line leads with the Entity List for GLM, names the US law and the removal order for DeepSeek, and is empty with none', () => {
  assert.match(legalFlagsLine(passport('z-ai/glm')), /^On the US Entity List\./);
  const deepseek = legalFlagsLine(passport('deepseek-ai/deepseek'));
  assert.match(deepseek, /Covered AI under a US law \(FY2026 NDAA Sec\. 1532\)\./);
  assert.match(deepseek, /Removal ordered: DHS notice ordering removal of DeepSeek from DHS systems\./);
  assert.equal(legalFlagsLine(passport('openai/gpt-oss')), '');
  assert.equal(EXCEPTION_TEXT.legalNone, 'No legal flags are recorded for this model.');
});

test('T-74.1-37: the inner signature covers the scope: signed at the draft\'s time it verifies, and a scope edited after signing does not', () => {
  const key = deviceKey();
  const draft = draftRiskAcceptance(input());
  assert.ok(draft.ok);
  if (!draft.ok) return;
  const envelope = signPayload(key, 'policy-authorization', draft.body, { now: () => new Date(ISSUED) });
  const signers = [{ name: 'Avery Chen', role: 'Director, Intelligence', publicKey: key.publicKey, fingerprint: key.fingerprint }];
  assert.equal(verifyAuthorization(envelope, { signers, now: NOW + 1000 }).ok, true);
  const widened = { ...envelope, payload: { ...envelope.payload, scope: { ...envelope.payload.scope, labels: ['org/Internal', 'org/Protected B'] } } };
  assert.equal(verifyAuthorization(widened, { signers, now: NOW + 1000 }).ok, false);
});

test('rows: a research-only model in country words, and an exception\'s state with the person and the end date', () => {
  assert.equal(researchOnlyRow({ id: 'z-ai/glm', origin: 'CN' }), 'z-ai/glm · China · Research only');
  const draft = draftRiskAcceptance(input());
  assert.ok(draft.ok);
  if (!draft.ok) return;
  assert.deepEqual(exceptionRow(draft.body, NOW, { projectName: () => 'Harrow Ridge' }), {
    state: 'active', text: 'z-ai/glm: Allowed for chat you review by Avery Chen until 25 Dec 2026', scope: 'Projects: Harrow Ridge. Labels: org/Internal.'
  });
  assert.equal(exceptionRow(draft.body, Date.parse('2027-01-01T00:00:00Z')).text, 'z-ai/glm: Ended on 25 Dec 2026');
  assert.equal(exceptionRow({ ...draft.body, revokedBy: '2026-12-01T00:00:00Z' }, NOW).text, 'z-ai/glm: Withdrawn by your organization on 1 Dec 2026');
  assert.equal(exceptionRow(draft.body, NOW, { triggered: { change: 'its licence changed', at: '2026-12-02T00:00:00Z' } }).text, 'z-ai/glm: Ended on 2 Dec 2026, because the model changed (its licence changed)');
});

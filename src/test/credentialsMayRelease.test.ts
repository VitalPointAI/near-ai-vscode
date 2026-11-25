// mayRelease and eligibleForPosition (Phase 71 plan 07 Task 2; D-10, O5, DCAC-03): one decision for every holder, staff and observers alike, built on
// whyNotDominated. Fictional Example Organization people. The credentials here are checked-credential records built directly: proofs, issuer authority
// and status are evidence.ts's (credentialsEvidence.test.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { whyNotDominated } from '../domain/gate/dominance';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label, ScaleMapping } from '../domain/gate/labels';
import type { CredentialsSection } from '../domain/gate/credentialsSection';
import { RELEASE_REFUSALS, clearancesOf, eligibleForPosition, factsFrom, isCheckedFacts, mayRelease } from '../domain/credentials/mayRelease';
import type { CheckedCredential, CredentialFacts, ReleaseContext } from '../domain/credentials/mayRelease';
import type { VerifiedCredential } from '../domain/credentials/profile';
import { mulberry32 } from './helpers/teamEvents';

const ALEX = 'did:webvh:QmExampleScidOnlyForTestsQmExampleScidOnlyForT:example.org:people:alex';
const NOW = Date.UTC(2026, 10, 24);

function held(type: string, claims: Record<string, unknown>, validUntil = '2027-06-01T00:00:00Z'): CheckedCredential {
  const credential = Object.freeze({
    type, issuer: 'did:webvh:QmIssuer:example.org:people:officer', validFrom: '2026-01-01T00:00:00Z', validUntil, claims: Object.freeze({ id: ALEX, ...claims }),
    status: Object.freeze([]), suite: 'eddsa-jcs-2022', verificationMethod: 'did:webvh:QmIssuer:example.org:people:officer#issuing', credential: Object.freeze({})
  }) as unknown as VerifiedCredential;
  return { credential, status: 'clear' };
}

const SECRET = held('ClearanceCredential', { scale: 'ca-classified', atLeast: 'Secret' });
const CONFIDENTIAL = held('ClearanceCredential', { scale: 'ca-classified', atLeast: 'Confidential' });
const C1 = held('CompartmentCredential', { compartment: 'C1' });
const CAN = held('NationalityCredential', { nationality: 'CAN' });
const USA = held('NationalityCredential', { nationality: 'USA' });

function label(level: string, compartments: string[] = [], releasability: string[] = [], scale = 'ca-classified'): Label {
  return { scale, level, compartments, releasability, handling: [] };
}

const CONTEXT: ReleaseContext = { scales: SCALE_PRESETS, mappings: [], now: NOW };

function why(facts: CredentialFacts, target: Label, context: ReleaseContext = CONTEXT): string {
  const result = mayRelease(facts, target, context);
  return result.ok ? 'ok' : result.reason;
}

const MARKED = label('Secret', ['C1'], ['CAN', 'GBR']);

test('a Secret, C1, CAN/GBR label is released to a holder with Secret, C1 and CAN', () => {
  assert.equal(why(factsFrom([SECRET, C1, CAN]), MARKED), 'ok');
});

test('each missing condition is refused with its own reason: Confidential, no C1, USA, no nationality at all (O5, staff included)', () => {
  assert.equal(why(factsFrom([CONFIDENTIAL, C1, CAN]), MARKED), 'level');
  assert.equal(why(factsFrom([SECRET, CAN]), MARKED), 'compartment');
  assert.equal(why(factsFrom([SECRET, C1, USA]), MARKED), 'releasability');
  assert.equal(why(factsFrom([SECRET, C1]), MARKED), 'releasability');
  assert.equal(why(factsFrom([C1, CAN]), MARKED), 'no-clearance');
  for (const reason of Object.keys(RELEASE_REFUSALS)) assert.match(RELEASE_REFUSALS[reason as keyof typeof RELEASE_REFUSALS], /\.$/);
});

test('RELEASABLE-TO-NONE never matches, and an empty releasability is unrestricted', () => {
  assert.equal(why(factsFrom([SECRET, C1, CAN]), label('Secret', ['C1'], ['RELEASABLE-TO-NONE'])), 'releasable-to-none');
  assert.equal(why(factsFrom([SECRET, C1]), label('Secret', ['C1'], [])), 'ok');
});

test('a CGP, ITAR or EAR compartment needs an ExportEligibilityCredential for that regime; a compartment credential of the same name is not enough', () => {
  const cgpLabel = label('Confidential', ['CGP']);
  assert.equal(why(factsFrom([SECRET, held('ExportEligibilityCredential', { regime: 'CGP', basis: 'Registered, file EX-1' })]), cgpLabel), 'ok');
  assert.equal(why(factsFrom([SECRET, held('CompartmentCredential', { compartment: 'CGP' })]), cgpLabel), 'export-eligibility');
  assert.equal(why(factsFrom([SECRET, held('ExportEligibilityCredential', { regime: 'ITAR', basis: 'Licence DSP-5 0001' })]), cgpLabel), 'compartment');
});

test('an observer\'s facts are checked exactly like staff: full dominance, no shortcut by position', () => {
  const observer = factsFrom([CONFIDENTIAL, CAN, held('ObserverAccessCredential', { project: 'example', position: 'observer-1', cells: ['cell-a'], until: '2027-01-01T00:00:00Z' })]);
  assert.equal(why(observer, label('Secret', [], ['CAN'])), 'level');
  assert.equal(why(observer, label('Confidential', ['C1'], ['CAN'])), 'compartment');
  assert.equal(why(observer, label('Confidential', [], ['CAN'])), 'ok');
});

test('a sensitivity whose policy requires an AccessAgreementCredential refuses a holder without one', () => {
  const policy = { requiredBySensitivity: { 'ca-classified/Secret': ['AccessAgreementCredential'] } } as unknown as CredentialsSection;
  const context = { ...CONTEXT, policy };
  assert.equal(why(factsFrom([SECRET, C1, CAN]), MARKED, context), 'required-credential');
  assert.equal(why(factsFrom([SECRET, C1, CAN, held('AccessAgreementCredential', { agreement: 'agreement-gbr-1', scope: 'organization' })]), MARKED, context), 'ok');
  assert.equal(why(factsFrom([SECRET, C1, CAN]), label('Confidential', ['C1'], ['CAN']), context), 'ok', 'other levels are unaffected');
});

test('a label on another scale passes only through a mapping your organization approves', () => {
  const natoLabel = label('NATO Secret', [], [], 'nato');
  assert.equal(why(factsFrom([SECRET]), natoLabel), 'scale');
  const mapping: ScaleMapping = { from: { scale: 'ca-classified', level: 'Secret' }, covers: { scale: 'nato', level: 'NATO Secret' } };
  assert.equal(why(factsFrom([SECRET]), natoLabel, { ...CONTEXT, mappings: [mapping] }), 'ok');
  assert.equal(why(factsFrom([CONFIDENTIAL]), natoLabel, { ...CONTEXT, mappings: [mapping] }), 'level');
});

test('a credential that has ended by now is not relied on', () => {
  const ended = held('ClearanceCredential', { scale: 'ca-classified', atLeast: 'Secret' }, '2026-11-01T00:00:00Z');
  assert.equal(why(factsFrom([ended]), label('Secret')), 'expired');
});

test('facts are made only from checked credentials: an unchecked item is ignored, and hand-built facts give nothing', () => {
  const unchecked = { credential: SECRET.credential, status: 'unknown' } as unknown as CheckedCredential;
  assert.equal(why(factsFrom([unchecked]), label('Confidential')), 'no-clearance');
  const forged = { subject: ALEX, thresholds: [{ scale: 'ca-classified', level: 'Top Secret' }], compartments: [], tokens: [], regimes: [], agreements: [], serves: [], types: [], until: Infinity } as CredentialFacts;
  assert.equal(isCheckedFacts(forged), false);
  assert.equal(why(forged, label('Confidential')), 'no-clearance');
  assert.deepEqual(clearancesOf(forged, SCALE_PRESETS), []);
});

test('a credential about another subject does not add to the facts', () => {
  const kim = held('CompartmentCredential', { compartment: 'C1' });
  const kims = { credential: { ...kim.credential, claims: { id: 'did:webvh:QmOther:example.org:people:kim', compartment: 'C1' } } as unknown as VerifiedCredential, status: 'clear' as const };
  assert.equal(why(factsFrom([SECRET, kims, CAN]), MARKED), 'compartment');
});

test('eligibleForPosition: required clearance and eligibleServes from credentials only', () => {
  const position = { requiredClearance: 'ca-classified/Secret', eligibleServes: ['regular-force', 'public-servant'] };
  const servant = held('ServiceCredential', { serves: 'public-servant' });
  assert.deepEqual(eligibleForPosition(factsFrom([SECRET, servant]), position, SCALE_PRESETS), { ok: true });
  const low = eligibleForPosition(factsFrom([CONFIDENTIAL, servant]), position, SCALE_PRESETS);
  assert.equal(low.ok ? 'ok' : low.reason, 'below-required-clearance');
  const contractor = eligibleForPosition(factsFrom([SECRET, held('ServiceCredential', { serves: 'contractor' })]), position, SCALE_PRESETS);
  assert.equal(contractor.ok ? 'ok' : contractor.reason, 'serves-not-eligible');
  const noService = eligibleForPosition(factsFrom([SECRET]), position, SCALE_PRESETS);
  assert.equal(noService.ok ? 'ok' : noService.reason, 'serves-not-eligible');
  assert.deepEqual(eligibleForPosition(factsFrom([servant]), { eligibleServes: ['public-servant'] }, SCALE_PRESETS), { ok: true });
});

test('clearancesOf gives the highest threshold per scale with the compartments and tokens held', () => {
  const facts = factsFrom([CONFIDENTIAL, SECRET, C1, CAN, held('ClearanceCredential', { scale: 'ca-protected', atLeast: 'Protected B' })]);
  const clearances = clearancesOf(facts, SCALE_PRESETS);
  assert.deepEqual(clearances.map((clearance) => `${clearance.scale}/${clearance.level}`), ['ca-classified/Secret', 'ca-protected/Protected B']);
  assert.deepEqual([...(clearances[0]?.compartments ?? [])], ['C1']);
  assert.deepEqual([...(clearances[0]?.releasability ?? [])], ['CAN']);
});

test('an affiliation counts for releasability only when its organization is written as a label token', () => {
  assert.equal(why(factsFrom([SECRET, held('AffiliationCredential', { organization: 'NATO' })]), label('Secret', [], ['NATO'])), 'ok');
  assert.equal(why(factsFrom([SECRET, held('AffiliationCredential', { organization: 'Example Partner Organization' })]), label('Secret', [], ['NATO'])), 'releasability');
});

test('property: across 2,000 random holders and labels, mayRelease never releases without dominance', () => {
  const random = mulberry32(71_072);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const levels = ['Confidential', 'Secret', 'Top Secret'];
  const tokens = ['CAN', 'GBR', 'USA', 'AUS', 'RELEASABLE-TO-NONE'];
  const compartments = ['C1', 'C2', 'CGP', 'ITAR'];
  let released = 0;
  for (let index = 0; index < 2000; index += 1) {
    const items: CheckedCredential[] = [];
    if (random() < 0.85) items.push(held('ClearanceCredential', { scale: 'ca-classified', atLeast: pick(levels) }, random() < 0.1 ? '2026-11-01T00:00:00Z' : '2027-06-01T00:00:00Z'));
    for (const token of ['CAN', 'GBR', 'USA']) if (random() < 0.4) items.push(held('NationalityCredential', { nationality: token }));
    for (const compartment of ['C1', 'C2']) if (random() < 0.5) items.push(held('CompartmentCredential', { compartment }));
    for (const regime of ['CGP', 'ITAR']) if (random() < 0.3) items.push(held('ExportEligibilityCredential', { regime, basis: 'test' }));
    const facts = factsFrom(items);
    const target = label(pick(levels), compartments.filter(() => random() < 0.3).sort(), tokens.filter(() => random() < 0.3).sort());
    const result = mayRelease(facts, target, CONTEXT);
    if (!result.ok) continue;
    released += 1;
    const dominating = clearancesOf(facts, SCALE_PRESETS).some((clearance) => whyNotDominated(clearance, target, CONTEXT) === undefined);
    assert.ok(dominating, `case ${String(index)}: released without dominance`);
  }
  assert.ok(released > 100, `the property is not vacuous: ${String(released)} releases`);
});

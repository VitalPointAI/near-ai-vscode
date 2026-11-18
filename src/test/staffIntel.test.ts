// The J2 intelligence workbench rules (design 10, 3.2, 4.4, 6.2 and 7; WP-INT). One test or more per rule: grades separate, independence by origin,
// PIR to decision point, person-only PIR decisions, recommendations-only collection, INTSUM and INTREP skeletons, compilation risk, the template label
// ceiling, DTG helpers and strict register files.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCollectionEntry, buildPirEntry, buildSourceEntry, categoriesOf, changePir, collectionFindings, compilationItems, compilationRisk,
  COMPILATION_ACCUMULATION_ITEMS, corroboration, decidePir, draftIntrep, draftIntsum, dtgSlug, formatDtg, independentlyConfirmed, INTEL_REPORTS,
  isTemplateLabel, MEMBER_PIR_MOVES, nextId, originKey, parseDtg, parseProductFile, parseRegisterText, PERSON_ONLY_PIR_STATUSES, pirFindings, readGrades,
  readTime, registerFindings, renderCollectionPlan, renderPirRegister, renderRegister, sourceFindings, STAFF_TEMPLATE_LABELS, taskingLanguage
} from '../domain/staff';
import type { CollectionEntry, IntelResult, PersonActor, PirEntry, SourceDraft, SourceEntry } from '../domain/staff';

const T0 = Date.UTC(2026, 10, 18, 12, 0);
const HOUR = 3_600_000;
const PERSON: PersonActor = { kind: 'person', name: 'Exercise Commander', role: 'commander', deviceFingerprint: 'ab12cd34' };

function value<T>(result: IntelResult<T>): T {
  if (!result.ok) assert.fail(`expected ok, got ${result.rule}: ${result.message}`);
  return result.value;
}
function rule<T>(result: IntelResult<T>): string {
  assert.equal(result.ok, false, 'expected a refusal');
  return (result as { rule: string }).rule;
}

function draft(overrides: Partial<Record<keyof SourceDraft, unknown>> = {}): SourceDraft {
  return {
    title: 'Bridge at Ashby Ford reported closed', source: 'Fictional Gazette', origin: 'Ashby district office', discipline: 'OSINT',
    reportedAt: '2026-11-18T09:00Z', accessedAt: '2026-11-18T10:00Z', reliability: 'B', credibility: 2, claims: ['bridge-closed-ashby'],
    deceptionNote: 'none seen', ...overrides
  } as SourceDraft;
}

function addSource(register: SourceEntry[], overrides: Partial<Record<keyof SourceDraft, unknown>> = {}): SourceEntry[] {
  return [...register, value(buildSourceEntry(draft(overrides), register, 'osint-analyst'))];
}

function pirs(): PirEntry[] {
  const first = value(buildPirEntry({ requirement: 'Will the adversary cross at Ashby Ford?', decisionPoint: 'DP 2: commit the reserve', ltiov: '2026-11-19T06:00Z', indicators: ['Bridging assets forward', 'Recon at the ford'] }, [], 'requirements-manager'));
  return [first];
}

// ---- Grades separate --------------------------------------------------------------------------------------------------------------------------

test('reliability and credibility are two fields from their own scales, stored apart', () => {
  const entry = value(buildSourceEntry(draft({ reliability: 'c', credibility: '4' }), [], 'osint-analyst'));
  assert.equal(entry.reliability, 'C');
  assert.equal(entry.credibility, 4);
  assert.equal(entry.id, 'SRC-1');
});

test('a combined grade is refused under grades-separate, in either field or as its own field', () => {
  assert.equal(rule(readGrades('B2', 2)), 'grades-separate');
  assert.equal(rule(readGrades('B', 'B2')), 'grades-separate');
  assert.equal(rule(readGrades('B', 2, 'B2')), 'grades-separate');
  assert.equal(rule(buildSourceEntry(draft({ grade: 'B2' }), [], 'x')), 'grades-separate');
  assert.equal(rule(buildSourceEntry(draft({ reliability: 'B 2' }), [], 'x')), 'grades-separate');
});

test('a grade off its scale, or a missing one, is refused under grades-separate', () => {
  for (const [reliability, credibility] of [['G', 2], ['B', 7], ['B', 0], [undefined, 2], ['B', undefined], ['B', 2.5], [2, 'B']] as const) {
    assert.equal(rule(readGrades(reliability, credibility)), 'grades-separate', `${String(reliability)} ${String(credibility)}`);
  }
});

test('one source graded two different reliabilities is a finding: reliability grades the source, not the item', () => {
  let register = addSource([], { source: 'Fictional Gazette', reliability: 'B' });
  register = addSource(register, { source: 'fictional gazette ', reliability: 'D', claims: ['other-claim'] });
  const finding = sourceFindings(register).find((entry) => entry.rule === 'reliability-differs');
  assert.ok(finding);
  assert.match(finding.message, /B and D/);
  // Different credibility on different items from one source is how it should be: no finding.
  const fine = addSource(addSource([], { credibility: 2 }), { credibility: 5, claims: ['other-claim'] });
  assert.equal(sourceFindings(fine).some((entry) => entry.rule === 'reliability-differs'), false);
});

test('credibility 1 needs another item from a different origin on the same claim', () => {
  const alone = addSource([], { credibility: 1 });
  assert.equal(independentlyConfirmed(alone, alone[0]), false);
  assert.ok(sourceFindings(alone).some((entry) => entry.rule === 'credibility-1-unconfirmed'));
  // A second report from the SAME origin does not confirm it.
  const echoed = addSource(alone, { source: 'Another Outlet', origin: 'Ashby District Office.' });
  assert.ok(sourceFindings(echoed).some((entry) => entry.rule === 'credibility-1-unconfirmed' && entry.subject === 'SRC-1'));
  // A report from a different origin does.
  const confirmed = addSource(alone, { source: 'Imagery series', origin: 'Exercise imagery cell', discipline: 'GEOINT' });
  assert.equal(sourceFindings(confirmed).some((entry) => entry.rule === 'credibility-1-unconfirmed'), false);
});

// ---- Independence by origin -------------------------------------------------------------------------------------------------------------------

test('two reports from one origin are one piece of evidence and never corroboration', () => {
  let register = addSource([], { source: 'Fictional Gazette', origin: 'Ashby district office' });
  register = addSource(register, { source: 'Fictional Wire', origin: '  ASHBY   District office ' });
  const found = corroboration(register, 'bridge-closed-ashby');
  assert.equal(found.reports.length, 2);
  assert.equal(found.independent, 1);
  assert.equal(found.repeated, true);
  assert.equal(found.corroborated, false);
  assert.ok(sourceFindings(register).some((entry) => entry.rule === 'repeated-origin' && entry.subject === 'bridge-closed-ashby'));
});

test('two reports from two origins corroborate, whatever their sources', () => {
  let register = addSource([], { source: 'Fictional Gazette', origin: 'Ashby district office' });
  register = addSource(register, { source: 'Fictional Gazette', origin: 'Exercise patrol report' });
  const found = corroboration(register, 'bridge-closed-ashby');
  assert.equal(found.independent, 2);
  assert.equal(found.corroborated, true);
  assert.equal(found.repeated, false);
});

test('origins are compared without case, spacing or a trailing full stop', () => {
  assert.equal(originKey(' Ashby  District Office. '), originKey('ashby district office'));
  assert.notEqual(originKey('Ashby district office'), originKey('Ashby district council'));
});

// ---- Source entries ---------------------------------------------------------------------------------------------------------------------------

test('a source entry needs an origin, a discipline, times in UTC and a deception note', () => {
  assert.equal(rule(buildSourceEntry(draft({ origin: '' }), [], 'x')), 'bad-input');
  assert.equal(rule(buildSourceEntry(draft({ discipline: 'RUMINT' }), [], 'x')), 'bad-input');
  assert.equal(rule(buildSourceEntry(draft({ reportedAt: '2026-11-18 09:00' }), [], 'x')), 'bad-input', 'a local time without a zone is refused');
  assert.equal(rule(buildSourceEntry(draft({ accessedAt: '2026-11-17T10:00Z' }), [], 'x')), 'bad-input', 'taken in before it was reported');
  assert.equal(rule(buildSourceEntry(draft({ deceptionNote: ' ' }), [], 'x')), 'bad-input');
  assert.equal(rule(buildSourceEntry(draft({ claims: ['Not A Slug'] }), [], 'x')), 'bad-input');
  assert.equal(rule(buildSourceEntry(draft({ url: 'ftp://example.test/x' }), [], 'x')), 'bad-input');
});

test('ids are never reused, even after a hand edit removed the highest', () => {
  assert.equal(nextId('SRC', ['SRC-1', 'SRC-7', 'PIR-9']), 'SRC-8');
  assert.equal(nextId('PIR', []), 'PIR-1');
});

// ---- Template label ceiling -------------------------------------------------------------------------------------------------------------------

test('entries carry a label inside the template ceiling, and anything higher is refused', () => {
  assert.deepEqual(STAFF_TEMPLATE_LABELS, ['org/Public', 'org/Internal', 'nato/NATO Unclassified', 'ca-protected/Protected A']);
  assert.equal(value(buildSourceEntry(draft(), [], 'x')).label, 'org/Internal', 'the default');
  for (const label of ['org/Confidential', 'nato/NATO Restricted', 'ca-protected/Protected B', 'ca-classified/Secret', 'org/internal']) {
    assert.equal(isTemplateLabel(label), false, label);
    assert.equal(rule(buildSourceEntry(draft({ label }), [], 'x')), 'label-ceiling', label);
    assert.equal(rule(buildPirEntry({ requirement: 'q', decisionPoint: 'DP 1', ltiov: '2026-11-19', label }, [], 'x')), 'label-ceiling', label);
  }
});

// ---- PIR to decision point --------------------------------------------------------------------------------------------------------------------

test('every PIR names a decision point and a latest time of value, or it is refused', () => {
  assert.equal(rule(buildPirEntry({ requirement: 'q', decisionPoint: '', ltiov: '2026-11-19' }, [], 'x')), 'pir-decision-point');
  assert.equal(rule(buildPirEntry({ requirement: 'q', decisionPoint: undefined, ltiov: '2026-11-19' }, [], 'x')), 'pir-decision-point');
  assert.equal(rule(buildPirEntry({ requirement: 'q', decisionPoint: 'DP 1', ltiov: undefined }, [], 'x')), 'pir-decision-point');
  assert.equal(rule(buildPirEntry({ requirement: 'q', decisionPoint: 'DP 1', ltiov: 'tomorrow' }, [], 'x')), 'pir-decision-point');
  const entry = value(buildPirEntry({ requirement: 'q', decisionPoint: 'DP 1', ltiov: '190600Z NOV 26', indicators: ['a', 'b'] }, [], 'x'));
  assert.equal(entry.ltiov, '2026-11-19T06:00:00.000Z', 'a DTG is read as UTC');
  assert.deepEqual(entry.indicators.map((indicator) => indicator.id), ['IND-1', 'IND-2']);
  assert.equal(entry.status, 'candidate');
});

test('a reworded PIR still needs its decision point: removing it is refused', () => {
  const register = pirs();
  assert.equal(rule(changePir(register, { id: 'PIR-1', decisionPoint: '' }, [])), 'pir-decision-point');
  assert.equal(rule(changePir(register, { id: 'PIR-1', ltiov: 'soon' }, [])), 'pir-decision-point');
});

test('a register file with a PIR missing its decision point does not load', () => {
  const entry = { ...pirs()[0], decisionPoint: '' };
  assert.equal(rule(parseRegisterText('pir-register', renderRegister('pir-register', [entry]))), 'register-damaged');
  const noLtiov: Record<string, unknown> = { ...pirs()[0] };
  delete noLtiov.ltiov;
  assert.equal(rule(parseRegisterText('pir-register', renderRegister('pir-register', [noLtiov]))), 'register-damaged');
});

test('a PIR past its latest time of value, or without indicators, is a finding', () => {
  const register = [...pirs(), value(buildPirEntry({ requirement: 'r', decisionPoint: 'DP 3', ltiov: '2026-11-25' }, pirs(), 'x'))];
  const late = pirFindings(register, [], Date.UTC(2026, 10, 19, 7, 0));
  assert.ok(late.some((finding) => finding.rule === 'ltiov-passed' && finding.subject === 'PIR-1'));
  assert.ok(late.some((finding) => finding.rule === 'pir-no-indicators' && finding.subject === 'PIR-2'));
  assert.equal(pirFindings(register, [], T0).some((finding) => finding.rule === 'ltiov-passed'), false);
});

// ---- Members never decide ---------------------------------------------------------------------------------------------------------------------

test('no member move approves or rejects a PIR, and asking for either is refused under person-only', () => {
  assert.deepEqual(PERSON_ONLY_PIR_STATUSES, ['approved', 'rejected']);
  assert.equal(MEMBER_PIR_MOVES.some((move) => PERSON_ONLY_PIR_STATUSES.includes(move.to)), false);
  let register = pirs();
  register = value(changePir(register, { id: 'PIR-1', status: 'awaiting-decision' }, []));
  assert.equal(rule(changePir(register, { id: 'PIR-1', status: 'approved' }, [])), 'person-only');
  assert.equal(rule(changePir(register, { id: 'PIR-1', status: 'rejected' }, [])), 'person-only');
  assert.equal(rule(buildPirEntry({ requirement: 'q', decisionPoint: 'DP 1', ltiov: '2026-11-19', status: 'approved' }, [], 'x')), 'person-only');
});

test('only a named person with a device fingerprint decides, and a rejection needs reasons', () => {
  let register = value(changePir(pirs(), { id: 'PIR-1', status: 'awaiting-decision' }, []));
  const agent = { kind: 'agent', member: 'j2-chief' } as unknown as PersonActor;
  assert.equal(rule(decidePir(register, 'PIR-1', 'approved', agent, T0)), 'person-only');
  assert.equal(rule(decidePir(register, 'PIR-1', 'approved', { ...PERSON, deviceFingerprint: '' }, T0)), 'person-only');
  assert.equal(rule(decidePir(register, 'PIR-1', 'rejected', PERSON, T0, [' '])), 'bad-input');
  register = value(decidePir(register, 'PIR-1', 'approved', PERSON, T0));
  assert.equal(register[0].status, 'approved');
  assert.equal(register[0].decision?.by.name, 'Exercise Commander');
  assert.equal(rule(decidePir(register, 'PIR-1', 'approved', PERSON, T0)), 'pir-transition', 'a decided PIR is not decided again');
});

test('a hand-edited approved PIR with no person on record does not load', () => {
  const forged = { ...pirs()[0], status: 'approved' };
  assert.equal(rule(parseRegisterText('pir-register', renderRegister('pir-register', [forged]))), 'register-damaged');
  const agentDecided = { ...forged, decision: { decision: 'approved', by: { kind: 'agent', member: 'j2-chief' }, at: '2026-11-18T12:00:00.000Z' } };
  assert.equal(rule(parseRegisterText('pir-register', renderRegister('pir-register', [agentDecided]))), 'register-damaged');
  const answeredUndecided = { ...pirs()[0], status: 'answered' };
  assert.equal(rule(parseRegisterText('pir-register', renderRegister('pir-register', [answeredUndecided]))), 'register-damaged');
});

test('the wording of a decided PIR is locked; indicators may still be added; an awaiting PIR reworded goes back to candidate', () => {
  let register = value(changePir(pirs(), { id: 'PIR-1', status: 'awaiting-decision' }, []));
  const reworded = value(changePir(register, { id: 'PIR-1', requirement: 'Will the adversary cross the river before H+12?' }, []));
  assert.equal(reworded[0].status, 'candidate', 'the person must see the new wording');
  register = value(decidePir(register, 'PIR-1', 'approved', PERSON, T0));
  assert.equal(rule(changePir(register, { id: 'PIR-1', requirement: 'Something else?' }, [])), 'pir-locked');
  assert.equal(rule(changePir(register, { id: 'PIR-1', decisionPoint: 'DP 9' }, [])), 'pir-locked');
  const more = value(changePir(register, { id: 'PIR-1', addIndicators: ['Engineer vehicles at the bank'] }, []));
  assert.deepEqual(more[0].indicators.map((indicator) => indicator.id), ['IND-1', 'IND-2', 'IND-3']);
});

test('member status moves follow the table: answered needs the items that answered it, closed only after answered', () => {
  const sources = addSource([]);
  let register = value(changePir(pirs(), { id: 'PIR-1', status: 'awaiting-decision' }, []));
  assert.equal(rule(changePir(register, { id: 'PIR-1', status: 'answered', answeredBy: ['SRC-1'] }, sources)), 'pir-transition', 'not approved yet');
  register = value(decidePir(register, 'PIR-1', 'approved', PERSON, T0));
  assert.equal(rule(changePir(register, { id: 'PIR-1', status: 'closed' }, sources)), 'pir-transition');
  assert.equal(rule(changePir(register, { id: 'PIR-1', status: 'answered' }, sources)), 'bad-input');
  assert.equal(rule(changePir(register, { id: 'PIR-1', status: 'answered', answeredBy: ['SRC-9'] }, sources)), 'unknown-entry');
  register = value(changePir(register, { id: 'PIR-1', status: 'answered', answeredBy: ['SRC-1'] }, sources));
  register = value(changePir(register, { id: 'PIR-1', status: 'closed' }, sources));
  assert.equal(register[0].status, 'closed');
  assert.equal(register[0].decision?.decision, 'approved', 'the person\'s decision stays on record');
  assert.equal(value(parseRegisterText('pir-register', renderRegister('pir-register', register)))[0].status, 'closed');
});

test('a rejected PIR returned to candidate drops the old decision, and needs indicators to go for decision again', () => {
  let register = value(changePir(pirs(), { id: 'PIR-1', status: 'awaiting-decision' }, []));
  register = value(decidePir(register, 'PIR-1', 'rejected', PERSON, T0, ['Not tied to a real decision']));
  register = value(changePir(register, { id: 'PIR-1', status: 'candidate' }, []));
  assert.equal(register[0].decision, undefined);
  const bare = value(buildPirEntry({ requirement: 'q', decisionPoint: 'DP 1', ltiov: '2026-11-19' }, [], 'x'));
  assert.equal(rule(changePir([bare], { id: 'PIR-1', status: 'awaiting-decision' }, [])), 'pir-transition');
});

// ---- Collection plan: recommendations only ----------------------------------------------------------------------------------------------------

const recommendation = { pir: 'PIR-1', indicator: 'IND-1', nai: 'NAI 3', capability: 'UAS imagery sweep of the ford', discipline: 'GEOINT', from: '2026-11-18T18:00Z', to: '2026-11-19T04:00Z' };

test('a recommendation names one of its PIR\'s indicators, needs J3 approval by default, and is always just recommended', () => {
  const entry = value(buildCollectionEntry(recommendation, [], pirs(), 'collection-manager'));
  assert.equal(entry.status, 'recommended');
  assert.equal(entry.needs, 'j3-approval');
  assert.equal(entry.id, 'CR-1');
  assert.equal(rule(buildCollectionEntry({ ...recommendation, indicator: 'IND-9' }, [], pirs(), 'x')), 'collection-indicator');
  assert.equal(rule(buildCollectionEntry({ ...recommendation, pir: 'PIR-4' }, [], pirs(), 'x')), 'unknown-entry');
  assert.equal(rule(buildCollectionEntry({ ...recommendation, status: 'tasked' }, [], pirs(), 'x')), 'collection-recommend-only');
});

test('tasking language is refused: the J2 recommends and never tasks an asset', () => {
  for (const capability of ['Task the UAS troop to sweep NAI 3', 'UAS troop has been tasked to sweep NAI 3', 'Assign the patrol to the ford', 'Allocate two sorties', 'tasking the recce squadron to observe']) {
    assert.equal(taskingLanguage(capability), true, capability);
    assert.equal(rule(buildCollectionEntry({ ...recommendation, capability }, [], pirs(), 'x')), 'collection-recommend-only', capability);
  }
  for (const capability of ['UAS imagery sweep of NAI 3', 'Recommend a ground patrol observe the ford at first light', 'Imagery tasking request to J3 for approval']) {
    assert.equal(taskingLanguage(capability), false, capability);
  }
  assert.equal(rule(buildCollectionEntry({ ...recommendation, note: 'Asset was tasked yesterday' }, [], pirs(), 'x')), 'collection-recommend-only');
});

test('HUMINT, SIGINT, MASINT and CI always need a partner', () => {
  for (const discipline of ['HUMINT', 'SIGINT', 'MASINT', 'CI']) {
    assert.equal(value(buildCollectionEntry({ ...recommendation, discipline }, [], pirs(), 'x')).needs, 'partner', discipline);
    assert.equal(rule(buildCollectionEntry({ ...recommendation, discipline, needs: 'j3-approval' }, [], pirs(), 'x')), 'partner-only', discipline);
  }
});

test('collection that ends after the latest time of value is refused, and one that a moved LTIOV overtook is a finding', () => {
  assert.equal(rule(buildCollectionEntry({ ...recommendation, to: '2026-11-19T07:00Z' }, [], pirs(), 'x')), 'collection-after-ltiov');
  const plan = [value(buildCollectionEntry(recommendation, [], pirs(), 'x'))];
  const moved = value(changePir(pirs(), { id: 'PIR-1', ltiov: '2026-11-19T02:00Z' }, []));
  assert.ok(collectionFindings(plan, moved).some((finding) => finding.rule === 'collection-after-ltiov' && finding.subject === 'CR-1'));
});

test('collection against a closed, answered or rejected PIR is refused', () => {
  let register = value(changePir(pirs(), { id: 'PIR-1', status: 'awaiting-decision' }, []));
  register = value(decidePir(register, 'PIR-1', 'rejected', PERSON, T0, ['No decision depends on it']));
  assert.equal(rule(buildCollectionEntry(recommendation, [], register, 'x')), 'pir-transition');
});

test('single-discipline reliance, unapproved PIRs and approved PIRs with no collection are findings', () => {
  const plan: CollectionEntry[] = [value(buildCollectionEntry(recommendation, [], pirs(), 'x'))];
  const findings = collectionFindings(plan, pirs());
  assert.ok(findings.some((finding) => finding.rule === 'single-discipline'));
  assert.ok(findings.some((finding) => finding.rule === 'pir-not-approved'));
  const mixed = [...plan, value(buildCollectionEntry({ ...recommendation, discipline: 'OSINT', capability: 'Local media watch' }, plan, pirs(), 'x'))];
  assert.equal(collectionFindings(mixed, pirs()).some((finding) => finding.rule === 'single-discipline'), false);
  let approved = value(changePir(pirs(), { id: 'PIR-1', status: 'awaiting-decision' }, []));
  approved = value(decidePir(approved, 'PIR-1', 'approved', PERSON, T0));
  assert.ok(pirFindings(approved, [], T0).some((finding) => finding.rule === 'pir-uncovered'));
  assert.equal(pirFindings(approved, plan, T0).some((finding) => finding.rule === 'pir-uncovered'), false);
});

test('a hand-edited collection line that claims a tasking, or a partner-only discipline without a partner, does not load', () => {
  const entry = value(buildCollectionEntry(recommendation, [], pirs(), 'x'));
  assert.equal(rule(parseRegisterText('collection-plan', renderRegister('collection-plan', [{ ...entry, status: 'tasked' }]))), 'register-damaged');
  assert.equal(rule(parseRegisterText('collection-plan', renderRegister('collection-plan', [{ ...entry, capability: 'UAS troop has been tasked' }]))), 'register-damaged');
  assert.equal(rule(parseRegisterText('collection-plan', renderRegister('collection-plan', [{ ...entry, discipline: 'SIGINT', needs: 'j3-approval' }]))), 'register-damaged');
});

test('the collection plan renders with the rule line and the doctrine headings', () => {
  const plan = [value(buildCollectionEntry(recommendation, [], pirs(), 'x'))];
  const text = renderCollectionPlan(plan, pirs());
  assert.match(text, /^The J2 recommends; the J3 approves the allocation of collection assets\./);
  assert.match(text, /\| Requirement \| Indicator \| NAI \| Recommended capability \| Timing \| Needs J3 approval or partner \|/);
  assert.match(text, /Recommend: UAS imagery sweep of the ford \(GEOINT\)/);
  assert.match(text, /181800Z NOV 26 to 190400Z NOV 26 \| J3 approval \|/);
  assert.match(renderPirRegister(pirs()), /\| PIR-1: Will the adversary cross at Ashby Ford\? \| DP 2: commit the reserve \|/);
});

// ---- Register files ---------------------------------------------------------------------------------------------------------------------------

test('registers round-trip one entry per line, an absent file is empty, and damage is named', () => {
  const sources = addSource(addSource([]), { origin: 'Exercise patrol report', claims: ['bridge-closed-ashby', 'engineers-forward'] });
  const text = renderRegister('source-register', sources);
  assert.equal(text.split('\n').filter((line) => line.trim().startsWith('{"id"')).length, 2, 'one entry per line merges line by line');
  assert.deepEqual(value(parseRegisterText('source-register', text)), sources);
  assert.deepEqual(value(parseRegisterText('pir-register', undefined)), []);
  assert.equal(rule(parseRegisterText('source-register', '{')), 'register-damaged');
  assert.equal(rule(parseRegisterText('source-register', renderRegister('pir-register', []))), 'register-damaged', 'the wrong register');
  assert.equal(rule(parseRegisterText('source-register', renderRegister('source-register', [sources[0], sources[0]]))), 'register-damaged', 'an id twice');
  assert.equal(rule(parseRegisterText('source-register', renderRegister('source-register', [{ ...sources[0], extra: 1 }]))), 'register-damaged');
  assert.equal(rule(parseRegisterText('source-register', renderRegister('source-register', [{ ...sources[0], credibility: '2' }]))), 'register-damaged', 'a grade stored as text is not the format');
  assert.equal(rule(parseRegisterText('source-register', renderRegister('source-register', [{ ...sources[0], reliability: 'B2' }]))), 'register-damaged', 'a combined grade does not load');
  assert.equal(rule(parseRegisterText('source-register', renderRegister('source-register', [{ ...sources[0], label: 'ca-classified/Secret' }]))), 'register-damaged', 'a label over the ceiling does not load');
});

test('a hostile prototype key in a register file does not survive into the entries', () => {
  const sources = addSource([]);
  const text = renderRegister('source-register', sources).replace('{"id"', '{"__proto__":{"polluted":true},"id"');
  const parsed = parseRegisterText('source-register', text);
  if (parsed.ok) assert.equal((parsed.value[0] as unknown as { polluted?: boolean }).polluted, undefined);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('registerFindings puts warnings before advice and reports an answer that is not in the source register', () => {
  let register = value(changePir(pirs(), { id: 'PIR-1', status: 'awaiting-decision' }, []));
  register = value(decidePir(register, 'PIR-1', 'approved', PERSON, T0));
  register = value(changePir(register, { id: 'PIR-1', status: 'answered', answeredBy: ['SRC-1'] }, addSource([])));
  const plan = [value(buildCollectionEntry(recommendation, [], pirs(), 'x'))];
  const findings = registerFindings({ sources: [], pirs: register, plan }, T0);
  assert.ok(findings.some((finding) => finding.rule === 'answer-missing'));
  const severities = findings.map((finding) => finding.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => ['block', 'warning', 'advice'].indexOf(a) - ['block', 'warning', 'advice'].indexOf(b)));
});

// ---- DTG --------------------------------------------------------------------------------------------------------------------------------------

test('DTGs format and parse in UTC, and impossible ones are refused', () => {
  assert.equal(formatDtg(Date.UTC(2026, 10, 18, 14, 2)), '181402Z NOV 26');
  assert.equal(parseDtg('181402Z NOV 26'), Date.UTC(2026, 10, 18, 14, 2));
  assert.equal(parseDtg('181402z nov 26'), Date.UTC(2026, 10, 18, 14, 2));
  assert.equal(dtgSlug(Date.UTC(2026, 0, 5, 9, 30)), '050930z-jan-26');
  for (const bad of ['311200Z NOV 26', '182400Z NOV 26', '181260Z NOV 26', '181200Z XYZ 26', '1812Z NOV 26']) assert.ok(Number.isNaN(parseDtg(bad)), bad);
  assert.equal(readTime('2026-11-18T14:02Z'), Date.UTC(2026, 10, 18, 14, 2));
  assert.equal(readTime('2026-11-18'), Date.UTC(2026, 10, 18));
  assert.equal(readTime('2026-11-18T14:02:00.000Z'), Date.UTC(2026, 10, 18, 14, 2));
  assert.ok(Number.isNaN(readTime('2026-02-30')));
  assert.ok(Number.isNaN(readTime('2026-11-18T14:02')));
});

// ---- INTSUM and INTREP ------------------------------------------------------------------------------------------------------------------------

const settings = { profile: 'us-joint', level: 'operational' } as const;

test('the INTSUM skeleton has a draft product header, the five headings in order, graded activity and gaps, and leaves judgement to the analyst', () => {
  let sources = addSource([], { reportedAt: '2026-11-18T08:00Z', accessedAt: '2026-11-18T09:00Z' });
  sources = addSource(sources, { source: 'Fictional Wire', reportedAt: '2026-11-18T09:00Z' });
  sources = addSource(sources, { title: 'Old item', reportedAt: '2026-11-10T09:00Z', accessedAt: '2026-11-10T10:00Z', claims: ['old'] });
  const text = value(draftIntsum({ registers: { sources, pirs: pirs(), plan: [] }, settings, label: 'org/Internal', owner: 'watch-officer' }, { from: T0 - 12 * HOUR, to: T0 }, T0));
  const product = parseProductFile(text);
  assert.ok(product.ok, 'the header is a valid product header');
  if (!product.ok) return;
  assert.equal(product.value.header.product, 'intsum-181200z-nov-26');
  assert.equal(product.value.header.state, 'draft', 'a draft: approval is a person\'s');
  assert.equal(product.value.header.owner, 'watch-officer');
  assert.equal(product.value.header.kind, 'report');
  const headings = [...product.value.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [...INTEL_REPORTS.intsum.headings]);
  assert.match(product.value.body, /SRC-1 \(B2: usually reliable source, information probably true; OSINT; origin: Ashby district office; one origin only \(other reports repeat it\)\)/);
  assert.doesNotMatch(product.value.body, /Old item/, 'items outside the period are left out');
  assert.match(product.value.body, /PIR-1 \(candidate; supports DP 2: commit the reserve\).*18 hours left/);
  assert.match(product.value.body, /<!-- Analyst: your judgement of intent/);
  assert.doesNotMatch(text, /\b(approved|selected|released)\b/i, 'the draft never claims a decision');
});

test('an INTSUM with nothing in it says so, and a backwards period or a label over the ceiling is refused', () => {
  const empty = value(draftIntsum({ registers: { sources: [], pirs: [], plan: [] }, settings, label: 'org/Public', owner: 'watch-officer' }, { from: T0 - HOUR, to: T0 }, T0));
  assert.match(empty, /No items in the source register were reported in this period\./);
  assert.match(empty, /No open PIRs\./);
  assert.equal(rule(draftIntsum({ registers: { sources: [], pirs: [], plan: [] }, settings, label: 'org/Public', owner: 'watch-officer' }, { from: T0, to: T0 - HOUR }, T0)), 'bad-input');
  assert.equal(rule(draftIntsum({ registers: { sources: [], pirs: [], plan: [] }, settings, label: 'nato/NATO Secret', owner: 'watch-officer' }, { from: T0 - HOUR, to: T0 }, T0)), 'label-ceiling');
});

test('the INTREP skeleton names the indicators fired with their PIR and decision point, the items and their independent origins, and leaves the deduction', () => {
  let sources = addSource([]);
  sources = addSource(sources, { source: 'Fictional Wire', origin: 'Ashby district office' });
  const text = value(draftIntrep({ registers: { sources, pirs: pirs(), plan: [] }, settings, label: 'org/Internal', owner: 'watch-officer' }, { text: 'Bridging vehicles seen moving to the ford', at: T0, sources: ['SRC-1', 'SRC-2'], indicators: ['IND-1'] }));
  const product = parseProductFile(text);
  assert.ok(product.ok);
  if (!product.ok) return;
  assert.equal(product.value.header.product, 'intrep-181200z-nov-26');
  assert.deepEqual([...product.value.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]), [...INTEL_REPORTS.intrep.headings]);
  assert.match(product.value.body, /Indicator IND-1 \(Bridging assets forward\) of PIR-1, which supports DP 2: commit the reserve/);
  assert.match(product.value.body, /2 items from 1 independent origin\. Items that share an origin count once\./);
  assert.match(product.value.body, /<!-- Analyst: your deduction/);
  assert.equal(rule(draftIntrep({ registers: { sources, pirs: pirs(), plan: [] }, settings, label: 'org/Internal', owner: 'watch-officer' }, { text: 'x', at: T0, sources: [] })), 'bad-input');
  assert.equal(rule(draftIntrep({ registers: { sources, pirs: pirs(), plan: [] }, settings, label: 'org/Internal', owner: 'watch-officer' }, { text: 'x', at: T0, sources: ['SRC-9'] })), 'unknown-entry');
  assert.equal(rule(draftIntrep({ registers: { sources, pirs: pirs(), plan: [] }, settings, label: 'org/Internal', owner: 'watch-officer' }, { text: 'x', at: T0, sources: ['SRC-1'], indicators: ['IND-9'] })), 'unknown-entry');
});

// ---- Compilation risk -------------------------------------------------------------------------------------------------------------------------

test('detail categories: units, locations (decimal, MGRS), capabilities and timing', () => {
  assert.deepEqual(categoriesOf('3rd Armoured Brigade'), ['unit']);
  assert.deepEqual(categoriesOf('Battalion 4 reported'), ['unit']);
  assert.deepEqual(categoriesOf('at 45.4215, -75.6972'), ['location']);
  assert.deepEqual(categoriesOf('grid 18T VR 12345 67890'), ['location']);
  assert.deepEqual(categoriesOf('12 tanks'), ['capability']);
  assert.deepEqual(categoriesOf('181402Z NOV 26'), ['timing']);
  assert.deepEqual(categoriesOf('The weather was clear.'), []);
});

test('an item that ties a unit to a location or a capability is a review with the question for a person, never a clearance', () => {
  const result = compilationRisk([{ id: 'line 4', text: '3rd Armoured Brigade with 40 tanks at 45.4215, -75.6972' }]);
  assert.equal(result.risk, 'review');
  assert.deepEqual(result.associations, [{ item: 'line 4', categories: ['unit', 'location', 'capability'] }]);
  assert.match(result.question ?? '', /person with the authority to decide/);
  assert.match(result.question ?? '', /HOLD/);
  assert.doesNotMatch(JSON.stringify(result), /CLEARED|cleared/);
});

test('unit, location and capability detail spread over enough items is an accumulation, even with no single association', () => {
  const items = [
    { id: 'a', text: '3rd Armoured Brigade reported in the north' },
    { id: 'b', text: 'Movement seen at 45.4215, -75.6972' },
    { id: 'c', text: '40 tanks counted' },
    { id: 'd', text: 'A second column at 45.5000, -75.7000' },
    { id: 'e', text: '12 launchers observed' }
  ];
  assert.equal(items.length, COMPILATION_ACCUMULATION_ITEMS);
  const result = compilationRisk(items);
  assert.equal(result.associations.length, 0);
  assert.equal(result.risk, 'review');
  assert.match(result.reasons.join(' '), /accumulates across 5 items/);
  assert.equal(compilationRisk(items.slice(0, 4)).risk, 'none', 'below the threshold');
});

test('nothing found is "none", which says plainly it does not clear the product', () => {
  const result = compilationRisk([{ id: 'a', text: 'The weather was clear and roads were dry.' }]);
  assert.equal(result.risk, 'none');
  assert.equal(result.question, undefined);
});

test('compilation items skip the product header and number lines from the top of the file, and add the source register', () => {
  const header = '---\nproduct: intsum-x\nkind: report\n---\n';
  const items = compilationItems(`${header}\n3rd Armoured Brigade at 45.4215, -75.6972\n`, addSource([]));
  assert.equal(items[0].id, 'line 6');
  assert.equal(items.some((item) => /product:/.test(item.text)), false);
  assert.equal(items[items.length - 1].id, 'SRC-1');
});

// Acceptance fixtures and demo scripts for the staff demo (design 10, 9.1 WP-DEMO; 00 s5): the fixtures pass on sample products written on the
// starter scenario under each profile, catch what a product is missing, and the J2 and J5 demo scripts resolve for every profile and level.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ACCEPTANCE_PRODUCTS, acceptanceFixture, acceptanceFixtures, checkProduct, DECISION_AS_MADE, fixtureChecklist, publicationShortName
} from '../domain/staff/acceptance';
import type { AcceptanceFixture, AcceptanceProductId, AcceptanceProblemKind } from '../domain/staff/acceptance';
import { DEMO_SCRIPTS, DEMO_SECTIONS, demoScript, demoScriptPath, renderDemoScript, resolveDemoText } from '../domain/staff/demoScripts';
import type { StaffLevel, StaffProfileId } from '../domain/staff/doctrine';
import { defaultStaffSettings, offeredCombinations } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { parseScenarioText } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';

const ROOT = path.join(__dirname, '..', '..');
const SAMPLES = path.join(ROOT, 'test', 'fixtures', 'staff-demo');
const SCENARIO: Scenario = (() => {
  const parsed = parseScenarioText(readFileSync(path.join(ROOT, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
})();

const SAMPLE_SETS: ReadonlyArray<{ dir: string; profile: StaffProfileId; level: StaffLevel }> = [
  { dir: 'us-joint-operational', profile: 'us-joint', level: 'operational' },
  { dir: 'us-army-tactical', profile: 'us-army', level: 'tactical' },
  { dir: 'nato-ca-operational', profile: 'nato-ca', level: 'operational' }
];

function settingsFor(profile: StaffProfileId, level: StaffLevel): StaffSettings {
  return { ...defaultStaffSettings(), profile, level, ...(profile === 'nato-ca' ? { nation: 'ca' as const } : {}) };
}

function sample(dir: string, product: string): string {
  return readFileSync(path.join(SAMPLES, dir, `${product}.md`), 'utf8');
}

function kinds(text: string, fixture: AcceptanceFixture): AcceptanceProblemKind[] {
  return checkProduct(text, fixture, SCENARIO).problems.map((problem) => problem.kind);
}

const US_JOINT = (id: AcceptanceProductId): AcceptanceFixture => acceptanceFixture(id, 'us-joint', 'operational');

test('every sample product passes its fixture under each profile (US Joint, US Army, NATO/Canadian)', () => {
  for (const set of SAMPLE_SETS) {
    const files = readdirSync(path.join(SAMPLES, set.dir)).filter((name) => name.endsWith('.md')).sort();
    assert.equal(files.length, ACCEPTANCE_PRODUCTS.length, set.dir);
    for (const fixture of acceptanceFixtures(set.profile, set.level)) {
      const result = checkProduct(sample(set.dir, fixture.products[0]), fixture, SCENARIO);
      assert.deepEqual(result.problems, [], `${set.dir}/${fixture.products[0]}`);
      assert.equal(result.pass, true);
    }
  }
});

test('a sample written under one profile fails the fixture of another', () => {
  const joint = sample('us-joint-operational', 'intelligence-estimate');
  const nato = acceptanceFixture('intelligence-estimate', 'nato-ca', 'operational');
  const result = checkProduct(joint, nato, SCENARIO);
  assert.equal(result.pass, false);
  const details = result.problems.map((problem) => problem.detail).join('\n');
  assert.match(details, /written under us-joint at operational/);
  assert.match(details, /Annex D/, 'NATO/Canadian files intelligence as Annex D');
  assert.match(details, /J2/, 'NATO/Canadian writes J2, not J-2');
  const army = checkProduct(joint, acceptanceFixture('intelligence-estimate', 'us-army', 'tactical'), SCENARIO);
  assert.ok(army.problems.some((problem) => problem.kind === 'forbidden' && /JIPOE/.test(problem.detail)), 'JIPOE is not the tactical intelligence preparation');
  assert.ok(army.problems.some((problem) => problem.kind === 'term' && /IPB/.test(problem.detail)));
});

test('fixtures follow the profile: staff codes, intelligence preparation, annex letters, COA tests and step names', () => {
  const term = (fixture: AcceptanceFixture, label: string): readonly string[] => fixture.terms.find((entry) => entry.label === label)?.anyOf ?? [];
  assert.deepEqual(term(acceptanceFixture('intelligence-estimate', 'us-joint', 'operational'), 'staff code'), ['J-2']);
  assert.deepEqual(term(acceptanceFixture('intelligence-estimate', 'nato-ca', 'operational'), 'staff code'), ['J2']);
  assert.deepEqual(term(acceptanceFixture('intelligence-estimate', 'us-army', 'tactical'), 'staff code'), ['G-2', 'S-2']);
  assert.deepEqual(term(acceptanceFixture('intelligence-estimate', 'us-joint', 'operational'), 'intelligence preparation'), ['JIPOE']);
  assert.deepEqual(term(acceptanceFixture('intelligence-estimate', 'nato-ca', 'tactical'), 'intelligence preparation'), ['IPB']);
  assert.deepEqual(term(acceptanceFixture('intelligence-estimate', 'us-joint', 'strategic'), 'intelligence annex letter'), ['Annex B']);
  assert.deepEqual(term(acceptanceFixture('intelligence-estimate', 'nato-ca', 'strategic'), 'intelligence annex letter'), ['Annex D']);
  const jointCoa = acceptanceFixture('coa-statement', 'us-joint', 'operational');
  assert.equal(jointCoa.terms.find((entry) => entry.label.startsWith('COA test'))?.anyOf[0], 'Suitable');
  assert.ok(!jointCoa.terms.some((entry) => entry.anyOf.includes('Adequate')));
  assert.ok(acceptanceFixture('coa-statement', 'nato-ca', 'operational').terms.some((entry) => entry.anyOf.includes('Exclusivity')));
  assert.deepEqual(term(acceptanceFixture('coa-comparison', 'nato-ca', 'operational'), 'step 5 name'), ['COA validation and comparison']);
  assert.deepEqual(acceptanceFixture('coa-statement', 'us-joint', 'operational').citations.publication, ['JP 5-0']);
  assert.deepEqual(acceptanceFixture('coa-statement', 'nato-ca', 'operational').citations.publication, ['AJP-5']);
  assert.deepEqual(acceptanceFixture('mission-analysis-brief', 'us-army', 'tactical').citations.publication, ['FM 5-0']);
  assert.equal(publicationShortName('APP-28, Tactical Planning for Land Forces'), 'APP-28');
});

test('there is a fixture for every product under every offered profile and level, and none for a refused pair', () => {
  for (const { profile, level } of offeredCombinations()) {
    const fixtures = acceptanceFixtures(profile, level);
    assert.equal(fixtures.length, ACCEPTANCE_PRODUCTS.length);
    for (const fixture of fixtures) {
      assert.ok(fixture.headings.length + fixture.columns.length >= 4, `${profile} ${level} ${fixture.products[0]} headings`);
      assert.ok(fixture.terms.length >= 2, `${profile} ${level} ${fixture.products[0]} terms`);
      assert.ok(fixture.terms.every((entry) => entry.anyOf.length > 0 && entry.anyOf.every((form) => form.trim() !== '')));
      assert.ok(fixtureChecklist(fixture).length >= 4);
    }
  }
  assert.throws(() => acceptanceFixture('intsum', 'us-army', 'operational'), /joint fight uses JPP/);
  assert.throws(() => acceptanceFixture('intsum', 'us-joint', 'tactical'), /US Army profile/);
});

test('a missing heading, table column, term or header field is named', () => {
  const estimate = sample('us-joint-operational', 'intelligence-estimate');
  const noGaps = checkProduct(estimate.replace('## Intelligence gaps', '## Things we do not know'), US_JOINT('intelligence-estimate'), SCENARIO);
  assert.deepEqual(noGaps.problems.map((problem) => problem.detail), ['Missing heading: Intelligence gaps']);
  assert.deepEqual(kinds(estimate.replace(/MDCOA/g, 'worst case'), US_JOINT('intelligence-estimate')), ['term']);
  assert.deepEqual(kinds(estimate.replace(/DECISION FOR: commander\./, 'The commander should look at these.'), US_JOINT('intelligence-estimate')), ['term']);
  const register = sample('us-joint-operational', 'pir-register');
  assert.deepEqual(kinds(register.replace('| Latest time of value |', '| Deadline |'), US_JOINT('pir-register')), ['column']);
  assert.deepEqual(kinds(estimate.replace('section: j2', 'section: j5'), US_JOINT('intelligence-estimate')), ['header']);
  assert.deepEqual(kinds(estimate.replace('product: intelligence-estimate', 'product: threat-assessment'), US_JOINT('intelligence-estimate')), ['header']);
  assert.deepEqual(kinds(estimate.replace(/^---[\s\S]*?---\n/, ''), US_JOINT('intelligence-estimate')), ['header']);
  const coa = sample('us-joint-operational', 'coa-a');
  assert.deepEqual(checkProduct(coa.replace('- Distinguishable:', '- Different:'), US_JOINT('coa-statement'), SCENARIO).problems.map((problem) => problem.detail), ['Missing COA test: Distinguishable: Distinguishable']);
  const coaB = coa.replace('product: coa-a', 'product: coa-b').replace('owner: coa-cell-a', 'owner: coa-cell-b');
  assert.ok(checkProduct(coaB, US_JOINT('coa-statement'), SCENARIO).pass, 'the COA fixture covers coa-b too');
});

test('report citations must carry the grade the scenario gives, and one origin never confirms itself', () => {
  const intsum = sample('us-joint-operational', 'intsum');
  const wrong = checkProduct(intsum.replace('PR-11 (B2)', 'PR-11 (A1)'), US_JOINT('intsum'), SCENARIO);
  assert.deepEqual(wrong.problems.map((problem) => problem.kind), ['grade']);
  assert.match(wrong.problems[0].detail, /grades it B2/);
  const bare = checkProduct(intsum.replace('PR-11 (B2)', 'PR-11'), US_JOINT('intsum'), SCENARIO);
  assert.deepEqual(bare.problems.map((problem) => problem.kind), ['citation']);
  const ungraded = checkProduct(intsum.replace('FR-01 (ungraded)', 'FR-01 (C3)'), US_JOINT('intsum'), SCENARIO);
  assert.deepEqual(ungraded.problems.map((problem) => problem.kind), ['grade']);
  const confirmed = `${intsum}\n- Armour on the ridge is confirmed by OS-02 (C3) and OS-03 (C3).\n`;
  assert.deepEqual(kinds(confirmed, US_JOINT('intsum')), ['independence']);
  const independent = `${intsum}\n- The ridge station is corroborated by EW-07 (B2) and IM-04 (B3).\n`;
  assert.deepEqual(kinds(independent, US_JOINT('intsum')), []);
  const denied = `${intsum}\n- OS-03 (C3) does not confirm OS-02 (C3): it repeats it.\n`;
  assert.deepEqual(kinds(denied, US_JOINT('intsum')), []);
  const thin = intsum.split('\n').filter((line) => !/\((B2|B3|C3|ungraded)\)/.test(line)).join('\n');
  assert.deepEqual(kinds(thin, US_JOINT('intsum')), ['citation']);
});

test('J5 products must name the higher order, carry every assumption and cite the publication', () => {
  const brief = sample('us-joint-operational', 'mission-analysis-brief');
  const noA5 = checkProduct(brief.replace(/\| A-5 \|.*\n/, ''), US_JOINT('mission-analysis-brief'), SCENARIO);
  assert.deepEqual(noA5.problems.map((problem) => problem.detail), ['Does not carry assumption A-5.']);
  assert.deepEqual(kinds(brief.replace(/CJFC NORTHGATE OPORD 03 \(IRON LANTERN\)/g, 'the higher order'), US_JOINT('mission-analysis-brief')), ['citation']);
  assert.deepEqual(kinds(brief.replace(/JP 5-0/g, 'doctrine'), US_JOINT('mission-analysis-brief')), ['citation']);
  const coa = sample('us-joint-operational', 'coa-a');
  assert.deepEqual(kinds(coa.replace(/OBJ FALCON|OBJ KITE/g, 'the town'), US_JOINT('coa-statement')), ['citation']);
});

test('a decision written as made, a marking, the wrong intelligence preparation or a retired space term fails', () => {
  const comparison = sample('us-joint-operational', 'coa-comparison');
  assert.deepEqual(kinds(`${comparison}\nCOA A is selected.\n`, US_JOINT('coa-comparison')), ['forbidden']);
  assert.deepEqual(kinds(`${comparison}\nWe approve COA A.\n`, US_JOINT('coa-comparison')), ['forbidden']);
  assert.deepEqual(kinds(`${comparison}\nSECRET\n`, US_JOINT('coa-comparison')), ['forbidden']);
  assert.deepEqual(kinds(`${comparison}\nSpace control is assumed.\n`, US_JOINT('coa-comparison')), ['forbidden']);
  const estimate = sample('us-joint-operational', 'intelligence-estimate');
  assert.deepEqual(kinds(`${estimate}\nSee the IPB overlay.\n`, US_JOINT('intelligence-estimate')), ['forbidden']);
  assert.ok(!DECISION_AS_MADE.test('DECISION FOR: commander. Approve the PIRs, or amend them.'));
  assert.ok(DECISION_AS_MADE.test('The plan has been approved.'));
});

test('the J2 and J5 demo scripts resolve every token for every profile and level, J2 first', () => {
  assert.deepEqual([...DEMO_SECTIONS], ['j2', 'j5']);
  for (const { profile, level } of offeredCombinations()) {
    const settings = settingsFor(profile, level);
    for (const section of DEMO_SECTIONS) {
      const script = demoScript(section, settings, SCENARIO);
      const text = renderDemoScript(section, settings, SCENARIO);
      assert.ok(!/\{[A-Za-z0-9]+(:[A-Za-z0-9-]+)?\}/.test(text), `${profile} ${level} ${section} has an unresolved token`);
      assert.ok(!text.includes(String.fromCharCode(0x2014)), 'no em-dash');
      assert.ok(!/provisional|preview/i.test(text));
      assert.ok(text.includes(SCENARIO.marking));
      assert.ok(script.beats.length >= 5);
      assert.ok(script.authorityChecks.length >= 3);
      for (const beat of script.beats) for (const product of beat.products) assert.ok(text.includes(`products/${acceptanceFixture(product, profile, level).section}/`));
    }
  }
  assert.equal(demoScriptPath('j2'), '.planning/staff/demo/j2-demo-script.md');
});

test('demo prompts speak the profile: J-2 and JIPOE under US Joint, G-2 and IPB under US Army, J2 and Annex D under NATO/Canadian', () => {
  const joint = renderDemoScript('j2', settingsFor('us-joint', 'operational'), SCENARIO);
  assert.match(joint, /You are the J-2 section of JTF BEACON/);
  assert.match(joint, /Run JIPOE for Mission analysis/);
  assert.match(joint, /Annex B/);
  assert.match(joint, /OS-02 \(C3\) and OS-03 \(C3\)/);
  const army = renderDemoScript('j2', settingsFor('us-army', 'tactical'), SCENARIO);
  assert.match(army, /You are the G-2 section/);
  assert.match(army, /Run IPB for Mission analysis/);
  const nato = renderDemoScript('j5', settingsFor('nato-ca', 'operational'), SCENARIO);
  assert.match(nato, /You are the J5 section/);
  assert.match(nato, /Feasibility, Acceptability, Completeness and compliance, Exclusivity, Suitability/);
  assert.match(renderDemoScript('j2', settingsFor('nato-ca', 'operational'), SCENARIO), /Annex D/);
});

test('every demo beat that a person does is marked, and every agent prompt asks for recommendations, never decisions', () => {
  const j5 = DEMO_SCRIPTS.j5;
  const decide = j5.beats.filter((beat) => beat.step === 6);
  assert.equal(decide.length, 1);
  assert.equal(decide[0].human, true);
  assert.equal(decide[0].products.length, 0);
  for (const section of DEMO_SECTIONS) {
    for (const beat of DEMO_SCRIPTS[section].beats) assert.ok(!DECISION_AS_MADE.test(beat.prompt), `${section}: ${beat.title}`);
    for (const check of DEMO_SCRIPTS[section].authorityChecks) assert.match(check.expect, /^(Declines|Refuses)/);
  }
});

test('a token the resolver does not know, or a report the scenario lacks, is an error, never left in the text', () => {
  const settings = settingsFor('us-joint', 'operational');
  assert.throws(() => resolveDemoText('Use {mystery}.', 'j2', settings, SCENARIO), /Unknown demo token/);
  assert.throws(() => resolveDemoText('Cite {cite:XX-01}.', 'j2', settings, SCENARIO), /no report XX-01/);
  assert.throws(() => resolveDemoText('Use {annex:fires}.', 'j2', settings, SCENARIO), /Unknown annex token/);
  assert.throws(() => resolveDemoText('{step:8}', 'j5', settingsFor('nato-ca', 'tactical'), SCENARIO), /names no step 8/);
  assert.equal(resolveDemoText('{code:j3} and {decision} {decider}', 'j2', settings, SCENARIO), 'J-3 and DECISION FOR: commander');
});

// The staff doctrine profiles (design 10, 2.1 to 2.3 and 2.8; WP-0): data integrity (every step mapped, annex letters unique per profile), every profile
// and level combination valid or refused as in 2.1, the annex letters the design names, the COA tests, the planning type, the space vocabulary lint, the
// project.json settings parser, and the PROFILE.md text. All doctrine terms come from src/domain/staff/doctrine.ts.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  ANNEX_LETTER_PATTERN, ANNEX_SUBJECTS, CROSSWALK, CROSSWALK_STEPS, DOCTRINE_PROFILES, FUNCTION_SETS, PLANNING_TYPES, RETIRED_SPACE_TERMS, SPACE_MISSION_AREAS,
  STAFF_LEVELS, STAFF_PROCESSES, STAFF_PROFILE_IDS, STAFF_SECTION_IDS
} from '../domain/staff/doctrine';
import type { StaffLevel, StaffProfileId } from '../domain/staff/doctrine';
import {
  annexLetter, annexSubjectFor, defaultStaffSettings, doctrineProblems, levelOffer, offeredCombinations, parseStaffSettings, renderProfileMarkdown,
  resolveProfile, retiredSpaceTerms, sectionCode, staffOrganizationDesignation, staffSettingsJson, stepName
} from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';

const STAFF_SRC = path.resolve(__dirname, '..', '..', 'src', 'domain', 'staff');

test('the doctrine tables are sound: every level answered, every step mapped, letters well formed and unique per profile', () => {
  assert.deepEqual(doctrineProblems(), []);
  for (const process of Object.values(STAFF_PROCESSES)) {
    for (const step of CROSSWALK_STEPS) assert.ok(process.steps[step], `${process.id} maps step ${step}`);
  }
  for (const id of STAFF_PROFILE_IDS) {
    const letters = ANNEX_SUBJECTS.map((subject) => annexLetter(id, subject)).filter((letter): letter is string => letter !== undefined);
    assert.equal(new Set(letters).size, letters.length, `${id}: annex letters are unique`);
    for (const letter of letters) assert.match(letter, ANNEX_LETTER_PATTERN);
    for (const subject of ANNEX_SUBJECTS) assert.ok(DOCTRINE_PROFILES[id].annexes[subject], `${id} places ${subject}`);
  }
});

test('organizational designations follow reviewed profiles independently of planning levels', () => {
  assert.equal(staffOrganizationDesignation('canada', 'l4', 'j4'), 'S4');
  assert.equal(staffOrganizationDesignation('canada', 'l3', 'j4'), 'G4');
  assert.equal(staffOrganizationDesignation('us-army', 'l3', 'j4'), 'S-4');
  assert.equal(staffOrganizationDesignation('us-army', 'l2', 'j4'), 'G-4');
  assert.equal(staffOrganizationDesignation('us-joint', 'l1', 'j4'), 'J-4');
  assert.equal(staffOrganizationDesignation('us-joint', 'l0', 'j4'), 'J-4');
  assert.equal(staffOrganizationDesignation('us-joint', 'l1', 'j8'), undefined, 'optional office needs its actual structure');
  assert.equal(staffOrganizationDesignation('canada', 'l0', 'j4'), undefined, 'named strategic offices retain functional labels');
  assert.equal(staffOrganizationDesignation('nato', 'l2', 'j4'), undefined, 'multinational terminology depends on the organization');
  assert.equal(staffOrganizationDesignation('canada', 'l3', 'command'), undefined);
});

test('the integrity check has teeth: a duplicate letter, an unmapped step and a dangling appendix are each reported', () => {
  const profile = DOCTRINE_PROFILES['us-joint'] as { annexes: Record<string, unknown> };
  const process = STAFF_PROCESSES.mdmp as { steps: Record<number, unknown> };
  const savedAnnex = profile.annexes.engineer;
  const savedFires = profile.annexes.fires;
  const savedStep = process.steps[4];
  try {
    profile.annexes.engineer = { kind: 'annex', letter: 'D', title: 'Engineer' };
    profile.annexes.fires = { kind: 'appendix', toAnnex: 'ZZ' };
    delete process.steps[4];
    const problems = doctrineProblems();
    assert.ok(problems.some((problem) => problem.includes('letter D to both')), problems.join('\n'));
    assert.ok(problems.some((problem) => problem.includes('does not map step 4')), problems.join('\n'));
    assert.ok(problems.some((problem) => problem.includes('under annex ZZ')), problems.join('\n'));
  } finally {
    profile.annexes.engineer = savedAnnex;
    profile.annexes.fires = savedFires;
    process.steps[4] = savedStep;
  }
  assert.deepEqual(doctrineProblems(), []);
});

test('every profile and level combination is valid or refused as in design 2.1, and a refusal points to an offered one', () => {
  const table: Record<StaffProfileId, Record<StaffLevel, string | null>> = {
    'us-joint': { strategic: 'jpp', operational: 'jpp', tactical: null },
    'us-army': { strategic: null, operational: null, tactical: 'mdmp' },
    'nato-ca': { strategic: 'ajp-5', operational: 'ajp-5', tactical: 'app-28' }
  };
  for (const profile of STAFF_PROFILE_IDS) {
    for (const level of STAFF_LEVELS) {
      const offer = levelOffer(profile, level);
      assert.equal(offer.offered ? offer.process : null, table[profile][level], `${profile} at ${level}`);
      const parsed = parseStaffSettings({ profile, level });
      assert.equal(parsed.ok, table[profile][level] !== null, `${profile} at ${level} parses only when offered`);
      if (!parsed.ok) assert.equal(parsed.reason, 'not-offered');
      if (!offer.offered) {
        assert.ok(offer.instead && levelOffer(offer.instead.profile, offer.instead.level).offered);
        assert.ok(offer.reason.length > 0);
      }
    }
  }
  assert.deepEqual(levelOffer('us-joint', 'tactical'), { offered: false, reason: 'JPP is a joint process. At tactical level use the US Army profile (MDMP).', instead: { profile: 'us-army', level: 'tactical' } });
  assert.equal(offeredCombinations().length, 6);
});

test('the annex letters the design names, per profile', () => {
  assert.equal(annexLetter('us-joint', 'logistics'), 'D');
  assert.equal(annexLetter('us-joint', 'assessment'), 'N');
  assert.equal(annexLetter('us-joint', 'personnel'), 'E');
  assert.equal(annexLetter('us-joint', 'public-affairs'), 'F');
  assert.equal(annexLetter('us-joint', 'knowledge-management'), 'I');
  assert.equal(annexLetter('us-joint', 'communications'), 'K');
  assert.equal(annexLetter('us-joint', 'health-services'), 'Q');
  assert.equal(annexLetter('us-joint', 'interagency'), 'V');
  assert.equal(annexLetter('us-joint', 'contracting-finance'), 'W');
  // The joint list has no annex O: P is host-nation support and foreign disclosure has no letter, so the orders tool asks a person (JP 5-0, 2017, app. A).
  assert.equal(annexLetter('us-joint', 'foreign-disclosure'), undefined);
  assert.equal(DOCTRINE_PROFILES['us-joint'].annexes['foreign-disclosure'].kind, 'not-lettered');
  assert.equal(annexSubjectFor('us-joint', 'O'), undefined);
  assert.equal(annexLetter('us-joint', 'host-nation-support'), 'P');
  assert.deepEqual(DOCTRINE_PROFILES['us-joint'].annexes['communication-strategy'], { kind: 'annex', letter: 'Y', title: 'Communication Synchronization' });
  assert.deepEqual(DOCTRINE_PROFILES['us-joint'].annexes.fires, { kind: 'appendix', toAnnex: 'C' });
  assert.equal(annexLetter('us-army', 'fires'), 'D');
  assert.equal(annexLetter('us-army', 'logistics'), 'F');
  assert.equal(annexLetter('nato-ca', 'intelligence'), 'D');
  assert.equal(annexLetter('nato-ca', 'logistics'), 'R');
  assert.equal(annexLetter('nato-ca', 'movements'), 'S');
  assert.equal(annexLetter('nato-ca', 'operations'), 'A');
  // NATO/Canadian follows the COPD letters (owner decision): V2.0 with the V3.0 StratCom changes, not the CFJP 5.0 (2008) letters.
  const nato = (subject: Parameters<typeof annexLetter>[1]) => annexLetter('nato-ca', subject);
  assert.deepEqual(
    { ops: nato('operations'), task: nato('task-organization'), health: nato('health-services'), info: nato('information'), stratcom: nato('communication-strategy'), pa: nato('public-affairs'), engineer: nato('engineer'), fires: nato('fires'), assessment: nato('assessment') },
    { ops: 'A', task: 'B', health: 'QQ', info: 'SS2', stratcom: 'SS', pa: 'TT', engineer: 'EE', fires: 'II', assessment: 'OO' });
  assert.equal(DOCTRINE_PROFILES['nato-ca'].annexes.operations.kind === 'annex' && DOCTRINE_PROFILES['nato-ca'].annexes.operations.title, 'Concept of Operations');
  for (const retired of ['K', 'O', 'X']) assert.equal(annexSubjectFor('nato-ca', retired), undefined, `the CFJP 5.0 letter ${retired} is gone`);
  assert.match('SS2', ANNEX_LETTER_PATTERN, 'a COPD V3.0 sub-annex is a well-formed letter');
  assert.doesNotMatch('S22', ANNEX_LETTER_PATTERN);
  // The trap the design names: Annex D is a different subject under each profile.
  assert.deepEqual(STAFF_PROFILE_IDS.map((id) => annexSubjectFor(id, 'D')), ['logistics', 'fires', 'intelligence']);
  assert.equal(annexSubjectFor('us-army', 'ZZ'), undefined);
});

test('COA tests per profile; US Joint starts with "suitable", never "adequate"', () => {
  assert.deepEqual(DOCTRINE_PROFILES['us-joint'].coaTests, ['Suitable', 'Feasible', 'Acceptable', 'Distinguishable', 'Complete']);
  for (const id of STAFF_PROFILE_IDS) assert.ok(!DOCTRINE_PROFILES[id].coaTests.some((name) => /adequate/i.test(name)), id);
  assert.deepEqual(DOCTRINE_PROFILES['us-army'].coaTests, ['Feasible', 'Acceptable', 'Suitable', 'Distinguishable', 'Complete']);
  assert.deepEqual(DOCTRINE_PROFILES['nato-ca'].coaTests, ['Feasibility', 'Acceptability', 'Completeness and compliance', 'Exclusivity', 'Suitability']);
});

test('step names: JP 5-0 (2025) steps, plan evaluation as the fourth planning function, and APP-28 with no review step', () => {
  assert.equal(stepName('us-joint', 'operational', 1), 'Planning initiation');
  assert.equal(stepName('us-joint', 'operational', 4), 'COA analysis and wargaming');
  assert.equal(stepName('us-joint', 'operational', 8), 'Plan evaluation');
  assert.equal(stepName('us-army', 'tactical', 1), 'Receipt of mission');
  assert.equal(stepName('nato-ca', 'operational', 6), 'Commander\'s COA decision');
  assert.equal(stepName('nato-ca', 'tactical', 8), null);
  assert.equal(stepName('us-joint', 'tactical', 1), null);
  assert.match(STAFF_PROCESSES.jpp.publication, /July 2025/);
  assert.equal(CROSSWALK.filter((row) => row.human).map((row) => row.step).join(), '6');
});

test('intelligence preparation: JIPOE at joint levels, IPOE (US Army) or IPB (NATO/Canadian) at tactical level, never JIPB outside the CFJP 5.0 reference column', () => {
  assert.equal(resolveProfile(settings('nato-ca', 'operational')).process.intelligencePreparation, 'JIPOE');
  assert.equal(resolveProfile(settings('nato-ca', 'tactical')).process.intelligencePreparation, 'IPB');
  assert.equal(resolveProfile(settings('us-joint', 'strategic')).process.intelligencePreparation, 'JIPOE');
  assert.equal(resolveProfile(settings('us-army', 'tactical')).process.intelligencePreparation, 'IPOE');
  for (const process of Object.values(STAFF_PROCESSES)) assert.ok(!JSON.stringify(process).includes('JIPB'), process.id);
});

test('staff codes per profile and level', () => {
  assert.equal(sectionCode('us-joint', 'operational', 'j2'), 'J-2');
  assert.equal(sectionCode('nato-ca', 'strategic', 'j5'), 'J5');
  assert.equal(sectionCode('us-army', 'tactical', 'j3'), 'G-3');
  assert.equal(sectionCode('us-army', 'tactical', 'j3', 'lower'), 'S-3');
  assert.equal(sectionCode('nato-ca', 'tactical', 'j4', 'lower'), 'S4');
  assert.equal(sectionCode('us-joint', 'operational', 'command'), undefined);
  assert.equal(sectionCode('us-joint', 'tactical', 'j2'), undefined);
  assert.equal(STAFF_SECTION_IDS.length, 11);
});

test('planning type: contingency by default; crisis names the J3 director as the planning lead and keeps the J3 future-operations transition', () => {
  assert.deepEqual([...PLANNING_TYPES], ['campaign', 'contingency', 'crisis']);
  assert.equal(defaultStaffSettings().planningType, 'contingency');
  const contingency = resolveProfile(settings('us-joint', 'operational'));
  assert.equal(contingency.planning.leadSection, 'j5');
  assert.equal(contingency.planning.leadRole, 'J5 director');
  assert.equal(contingency.planning.concurrentSteps, false);
  const crisis = resolveProfile({ ...settings('us-joint', 'operational'), planningType: 'crisis' });
  assert.equal(crisis.planning.leadSection, 'j3');
  assert.equal(crisis.planning.leadRole, 'J3 director');
  assert.equal(crisis.planning.concurrentSteps, true);
  assert.deepEqual({ section: crisis.planning.transition.toSection, member: crisis.planning.transition.toMember }, { section: 'j3', member: 'future-ops-planner' });
  assert.equal(resolveProfile({ ...settings('us-joint', 'operational'), planningType: 'campaign' }).planning.leadRole, 'J5 director');
  const parsed = parseStaffSettings({ planningType: 'crisis' });
  assert.ok(parsed.ok && parsed.value.planningType === 'crisis');
  const bad = parseStaffSettings({ planningType: 'Crisis' });
  assert.equal(bad.ok ? 'ok' : bad.reason, 'unknown-value');
  assert.match(renderProfileMarkdown(crisis), /led by the J3 director/);
});

test('running estimate headings: seven joint functions, and the five Canadian operational functions with the Canadian nation setting', () => {
  assert.equal(FUNCTION_SETS['joint-functions'].length, 7);
  assert.deepEqual(resolveProfile(settings('nato-ca', 'operational', 'ca')).functions.names, ['Command', 'Sense', 'Act', 'Shield', 'Sustain']);
  assert.equal(resolveProfile(settings('nato-ca', 'operational', 'nato')).functions.set, 'joint-functions');
  assert.equal(resolveProfile(settings('us-joint', 'operational')).functions.set, 'joint-functions');
});

test('Canadian land terms apply only under NATO/Canadian at tactical level with the Canadian nation setting', () => {
  const canadian = resolveProfile(settings('nato-ca', 'tactical', 'ca'));
  assert.equal(canadian.informationTerm, 'Influence activities');
  assert.ok(canadian.landTerms);
  assert.match(renderProfileMarkdown(canadian), /Combat service support \(CSS\)/);
  const nato = resolveProfile(settings('nato-ca', 'tactical', 'nato'));
  assert.equal(nato.informationTerm, 'Information operations');
  assert.equal(nato.landTerms, undefined);
  assert.equal(resolveProfile(settings('nato-ca', 'operational', 'ca')).landTerms, undefined);
});

test('the space vocabulary lint rejects every retired JP 3-14 term and passes the mission areas', () => {
  for (const term of RETIRED_SPACE_TERMS) assert.deepEqual(retiredSpaceTerms(`Request ${term.toUpperCase()} support.`), [term], term);
  assert.deepEqual(retiredSpaceTerms('Counter-space effects and space-control windows.'), ['space control', 'counterspace']);
  assert.deepEqual(retiredSpaceTerms(SPACE_MISSION_AREAS.join('. ')), []);
  assert.deepEqual(retiredSpaceTerms('Outer space controls the tides.'), []);
});

function settings(profile: StaffProfileId, level: StaffLevel, nation?: 'ca' | 'nato'): StaffSettings {
  const parsed = parseStaffSettings({ profile, level, ...(nation ? { nation } : {}) });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

test('project.json staff settings: defaults, round trip, and strict refusals', () => {
  const empty = parseStaffSettings({});
  assert.ok(empty.ok);
  if (empty.ok) assert.deepEqual(empty.value, defaultStaffSettings());
  assert.deepEqual(defaultStaffSettings(), { profile: 'us-joint', level: 'operational', planningType: 'contingency', horizons: { currentOpsHours: 24, futureOpsHours: 96 }, phases: [] });
  const nato = parseStaffSettings({ profile: 'nato-ca', level: 'tactical' });
  assert.ok(nato.ok && nato.value.nation === 'ca', 'the nation defaults to ca under NATO/Canadian');

  const full = { profile: 'nato-ca', level: 'strategic', nation: 'nato', planningType: 'campaign', horizons: { currentOpsHours: 72, futureOpsHours: 720 }, phases: ['Shape', 'Deter'] };
  const parsed = parseStaffSettings(full);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(staffSettingsJson(parsed.value), full);
    const again = parseStaffSettings(JSON.parse(JSON.stringify(staffSettingsJson(parsed.value))));
    assert.ok(again.ok);
    if (again.ok) assert.deepEqual(again.value, parsed.value);
  }

  const refusals: Array<[unknown, string, string]> = [
    [null, 'not-an-object', 'staff'],
    [[], 'not-an-object', 'staff'],
    [{ profile: 'caf-opp' }, 'unknown-value', 'staff.profile'],
    [{ level: 'Operational' }, 'unknown-value', 'staff.level'],
    [{ profile: 'us-army' }, 'not-offered', 'staff.level'],
    [{ nation: 'ca' }, 'not-allowed-here', 'staff.nation'],
    [{ profile: 'nato-ca', nation: 'uk' }, 'unknown-value', 'staff.nation'],
    [{ colour: 'red' }, 'unknown-field', 'staff.colour'],
    [JSON.parse('{"__proto__": {"profile": "us-army"}}'), 'unknown-field', 'staff.__proto__'],
    [{ horizons: { currentOpsHours: 96, futureOpsHours: 24 } }, 'out-of-range', 'staff.horizons.futureOpsHours'],
    [{ horizons: { currentOpsHours: 0, futureOpsHours: 24 } }, 'out-of-range', 'staff.horizons.currentOpsHours'],
    [{ horizons: { currentOpsHours: 1.5, futureOpsHours: 24 } }, 'wrong-type', 'staff.horizons.currentOpsHours'],
    [{ horizons: { currentOpsHours: 24 } }, 'missing-field', 'staff.horizons.futureOpsHours'],
    [{ phases: 'Shape' }, 'wrong-type', 'staff.phases'],
    [{ phases: ['Shape', 'Shape'] }, 'duplicate-entry', 'staff.phases[1]'],
    [{ phases: ['Line\nbreak'] }, 'wrong-type', 'staff.phases[0]'],
    [{ phases: [' Padded'] }, 'wrong-type', 'staff.phases[0]']
  ];
  for (const [input, reason, where] of refusals) {
    const result = parseStaffSettings(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) {
      assert.equal(result.reason, reason, JSON.stringify(input));
      assert.equal(result.path, where.replace(/[^A-Za-z0-9_.[\]-]/g, '?'), JSON.stringify(input));
    }
  }
});

test('PROFILE.md names the profile, the process, every step, the COA tests and every annex placement', () => {
  for (const { profile, level } of offeredCombinations()) {
    const resolved = resolveProfile(settings(profile, level));
    const text = renderProfileMarkdown(resolved);
    assert.ok(text.includes(resolved.process.name), `${profile} ${level}`);
    for (const step of resolved.steps) if (step.name) assert.ok(text.includes(step.name), `${profile} ${level} step ${step.step}`);
    assert.ok(text.includes(resolved.coaTests.join(', ')));
    for (const subject of ANNEX_SUBJECTS) assert.ok(text.includes(`| ${subject} |`), subject);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), 'no em-dash');
  }
  assert.throws(() => resolveProfile({ ...defaultStaffSettings(), profile: 'us-army', level: 'strategic' }), /MDMP is a tactical process/);
});

test('every doctrine term lives in doctrine.ts: no other staff source spells a step name, a COA test or an annex title', () => {
  const terms = new Set<string>();
  for (const process of Object.values(STAFF_PROCESSES)) for (const step of CROSSWALK_STEPS) { const entry = process.steps[step]; if (entry.kind === 'step') terms.add(entry.name); }
  for (const id of STAFF_PROFILE_IDS) {
    for (const name of DOCTRINE_PROFILES[id].coaTests) terms.add(name);
    for (const subject of ANNEX_SUBJECTS) { const placement = DOCTRINE_PROFILES[id].annexes[subject]; if (placement.kind === 'annex') terms.add(placement.title); }
  }
  const multiWord = [...terms].filter((term) => term.includes(' '));
  assert.ok(multiWord.length > 20);
  for (const file of readdirSync(STAFF_SRC).filter((name) => name.endsWith('.ts') && name !== 'doctrine.ts')) {
    const text = readFileSync(path.join(STAFF_SRC, file), 'utf8');
    for (const term of multiWord) assert.ok(!text.includes(`'${term}'`), `${file} spells "${term}"; it belongs in doctrine.ts`);
  }
});

test('the staff sources carry no em-dash and no provisional or preview marker', () => {
  for (const file of readdirSync(STAFF_SRC).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(path.join(STAFF_SRC, file), 'utf8');
    assert.ok(!text.includes(String.fromCharCode(0x2014)), `${file} has an em-dash`);
    assert.ok(!/provisional|preview/i.test(text), `${file} has a provisional or preview marker`);
  }
});

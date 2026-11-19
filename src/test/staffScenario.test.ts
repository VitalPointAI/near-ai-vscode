// The staff exercise scenario format (design 10, section 8; WP-DEMO): the starter scenario parses and is rich enough for J2 and J5 products, and the
// reader refuses bad input (wrong format, unknown fields, markings, real entities, stray coordinates, dangling references, ungraded grades out of range).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  citationText, reportGradeText, parseScenario, parseScenarioText, SCENARIO_DIR, SCENARIO_FAILURES, SCENARIO_MAX_FILE, scenarioFiles, scenarioJson
} from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';

const STARTER_TEXT = readFileSync(path.join(__dirname, '..', '..', 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8');

function starter(): Scenario {
  const parsed = parseScenarioText(STARTER_TEXT);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}

/** The starter as a plain object, changed by `edit`, for refusal tests. */
function edited(edit: (value: Record<string, any>) => void): Record<string, any> {
  const value = JSON.parse(STARTER_TEXT) as Record<string, any>;
  edit(value);
  return value;
}

function refusedWith(value: unknown, reason: keyof typeof SCENARIO_FAILURES, at?: string, options?: Parameters<typeof parseScenario>[1]): void {
  const parsed = parseScenario(value, options);
  assert.equal(parsed.ok, false, 'expected a refusal');
  if (parsed.ok) return;
  assert.equal(parsed.reason, reason, parsed.message);
  if (at !== undefined) assert.equal(parsed.path, at);
  assert.ok(parsed.message.startsWith(SCENARIO_FAILURES[reason]));
}

test('the starter scenario parses and has a region with terrain, a coast and a strait', () => {
  const scenario = starter();
  assert.equal(scenario.id, 'iron-lantern');
  assert.match(scenario.marking, /UNCLASSIFIED/);
  assert.match(scenario.marking, /EXERCISE/);
  assert.equal(scenario.region.grid.kind, 'fictional');
  const kinds = new Set(scenario.region.features.map((feature) => feature.kind));
  for (const kind of ['strait', 'coast', 'sea', 'high-ground', 'river', 'crossing', 'route', 'port', 'beach']) assert.ok(kinds.has(kind as never), `a ${kind}`);
  assert.ok(scenario.region.weather.effects.length >= 3);
  assert.ok(scenario.region.civil.length >= 5, 'civil considerations');
});

test('the starter scenario has friendly and adversary orders of battle, a mission with higher intent, and graded and ungraded reports', () => {
  const scenario = starter();
  const sideOf = (party: string): string | undefined => scenario.parties.find((entry) => entry.id === party)?.side;
  const friendly = scenario.forces.filter((force) => sideOf(force.party) === 'friendly');
  const adversary = scenario.forces.filter((force) => sideOf(force.party) === 'adversary');
  assert.ok(friendly.length >= 8, 'friendly order of battle');
  assert.ok(adversary.length >= 6, 'adversary order of battle');
  assert.ok(adversary.every((force) => force.reportedBy.length > 0), 'every adversary entry rests on a report');
  assert.ok(friendly.some((force) => force.parent !== undefined), 'friendly forces have a hierarchy');
  assert.ok(scenario.mission.higher.intent.keyTasks.length >= 3);
  assert.ok(scenario.mission.higher.intent.endState.length > 20);
  assert.ok(scenario.mission.own.assumptions.length >= 4);
  assert.ok(scenario.mission.own.constraints.length && scenario.mission.own.restraints.length);
  assert.ok(scenario.reports.length >= 10);
  assert.ok(scenario.reports.some((report) => report.grade === undefined), 'at least one ungraded report');
  assert.ok(scenario.reports.filter((report) => report.grade).length >= 8);
  // A tradecraft point for the demo: two reports from one origin.
  const origins = scenario.reports.map((report) => report.origin);
  const shared = scenario.reports.filter((report) => origins.filter((origin) => origin === report.origin).length > 1).map((report) => report.id);
  assert.deepEqual(shared, ['OS-02', 'OS-03'], 'exactly two reports share an origin');
  assert.ok(scenario.controlMeasures.some((measure) => measure.kind === 'nai'));
  assert.ok(scenario.controlMeasures.some((measure) => measure.kind === 'objective'));
});

test('the starter scenario is clearly fictional: no real coordinates, no em-dash, an in-house source register entry', () => {
  const scenario = starter();
  assert.ok(!STARTER_TEXT.includes(String.fromCharCode(0x2014)), 'no em-dash');
  assert.ok(!/provisional|preview/i.test(STARTER_TEXT));
  assert.ok(scenario.sourceRegister.some((entry) => entry.origin === 'in-house'));
  assert.match(scenario.summary, /invented/);
  assert.match(scenario.summary, /notional/);
});

test('scenario files open with the marking and cite reports by id and grade; the JSON round trips', () => {
  const scenario = starter();
  const files = scenarioFiles(scenario);
  assert.deepEqual(files.map((file) => path.basename(file.path)), ['README.md', 'region.md', 'forces.md', 'mission.md', 'reports.md', 'sources.md', 'scenario.json']);
  for (const file of files) {
    assert.ok(file.path.startsWith(`${SCENARIO_DIR}/`));
    if (file.path.endsWith('.md')) assert.ok(file.content.includes(scenario.marking), file.path);
    assert.ok(!file.content.includes(String.fromCharCode(0x2014)), `${file.path} has no em-dash`);
  }
  const reports = files.find((file) => file.path.endsWith('reports.md'))!.content;
  for (const report of scenario.reports) assert.ok(reports.includes(`## ${citationText(report)}`), report.id);
  assert.ok(reports.includes('FR-01 (ungraded)'));
  const mission = files.find((file) => file.path.endsWith('mission.md'))!.content;
  assert.ok(mission.includes(scenario.mission.higher.order));
  for (const assumption of scenario.mission.own.assumptions) assert.ok(mission.includes(assumption.id));
  const json = files.find((file) => file.path.endsWith('scenario.json'))!.content;
  const again = parseScenarioText(json);
  assert.ok(again.ok, again.ok ? '' : again.message);
  if (again.ok) assert.deepEqual(again.value, scenario);
  assert.deepEqual(scenarioJson(scenario).format, 'near-ai-staff-scenario');
});

test('grades read as products cite them', () => {
  assert.equal(reportGradeText({ grade: { reliability: 'B', credibility: '2' } }), 'B2');
  assert.equal(reportGradeText({}), 'ungraded');
  assert.equal(citationText({ id: 'PR-11', grade: { reliability: 'B', credibility: '2' } }), 'PR-11 (B2)');
});

test('import refuses text that is not a scenario: not JSON, too large, wrong format or version, not an object', () => {
  const notJson = parseScenarioText('{ nope');
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.equal(notJson.reason, 'not-json');
  const large = parseScenarioText(' '.repeat(SCENARIO_MAX_FILE + 1));
  assert.equal(large.ok, false);
  if (!large.ok) assert.equal(large.reason, 'too-large');
  refusedWith([], 'not-an-object');
  refusedWith(edited((value) => { value.format = 'something-else'; }), 'wrong-format');
  refusedWith(edited((value) => { value.version = 2; }), 'wrong-format');
});

test('import refuses a scenario not marked fictional and unclassified', () => {
  refusedWith(edited((value) => { delete value.fictional; }), 'not-fictional', 'fictional');
  refusedWith(edited((value) => { value.fictional = 'yes'; }), 'not-fictional', 'fictional');
  refusedWith(edited((value) => { value.marking = 'EXERCISE ONLY'; }), 'not-fictional', 'marking');
});

test('import refuses classification and caveat markings anywhere, but not ordinary prose', () => {
  for (const marking of ['SECRET', 'TOP SECRET', 'CONFIDENTIAL', 'NATO RESTRICTED', 'PROTECTED B', 'CUI', 'NOFORN', 'EYES ONLY', 'REL TO ABC']) {
    refusedWith(edited((value) => { value.reports[0].text = `Patrol report. ${marking} handling.`; }), 'marking', 'reports[0].text');
  }
  refusedWith(edited((value) => { value.marking = 'SECRET // EXERCISE'; }), 'marking', 'marking');
  refusedWith(edited((value) => { value.forces[0].id = 'SECRET-1'; }), 'marking', 'forces[0].id');
  const prose = parseScenario(edited((value) => { value.reports[0].text = 'The skipper kept the secret; the area is restricted to people on foot.'; }));
  assert.ok(prose.ok, prose.ok ? '' : prose.message);
});

test('import refuses names on your organization\'s real-entity list, as whole words in any case', () => {
  const entities = ['Fort Example', 'Example Battalion'];
  refusedWith(edited((value) => { value.forces[1].notes = 'Moved from fort example last week.'; }), 'real-entity', 'forces[1].notes', { realEntities: entities });
  const partWord = parseScenario(edited((value) => { value.forces[1].notes = 'Moved from Fort Examples last week.'; }), { realEntities: entities });
  assert.ok(partWord.ok, 'a longer word is not the entity');
  assert.ok(parseScenario(JSON.parse(STARTER_TEXT), { realEntities: entities }).ok);
});

test('import refuses coordinates on a fictional grid, and coordinates outside a geographic exercise box', () => {
  refusedWith(edited((value) => { value.forces[0].location = 'At 45.4215, -75.6972'; }), 'coordinates', 'forces[0].location');
  refusedWith(edited((value) => { value.forces[0].location = '45° 25\' N'; }), 'coordinates', 'forces[0].location');
  const temperature = parseScenario(edited((value) => { value.region.weather.summary = 'Cold, about 4° in the morning.'; }));
  assert.ok(temperature.ok, 'a temperature is not a coordinate');
  const boxed = (location: string) => edited((value) => {
    value.region.grid = { kind: 'geographic', south: 10, west: 20, north: 12, east: 24 };
    value.forces[0].location = location;
  });
  assert.ok(parseScenario(boxed('At 11.50, 21.75')).ok, 'inside the box');
  refusedWith(boxed('At 45.42, -75.69'), 'coordinates', 'forces[0].location');
  refusedWith(edited((value) => { value.region.grid = { kind: 'geographic', south: 12, west: 20, north: 10, east: 24 }; }), 'out-of-range', 'region.grid.north');
  refusedWith(edited((value) => { value.region.grid = { kind: 'fictional', name: 'KQ', south: 1 }; }), 'not-allowed-here', 'region.grid.south');
});

test('import refuses unknown fields, missing fields, wrong kinds and bad grades', () => {
  refusedWith(edited((value) => { value.extra = 1; }), 'unknown-field', 'extra');
  refusedWith(edited((value) => { delete value.mission; }), 'missing-field', 'mission');
  refusedWith(edited((value) => { value.reports[0].colour = 'red'; }), 'unknown-field', 'reports[0].colour');
  refusedWith(edited((value) => { value.reports[0].kind = 'rumour'; }), 'unknown-value', 'reports[0].kind');
  refusedWith(edited((value) => { value.reports[0].grade = { reliability: 'G', credibility: '2' }; }), 'unknown-value', 'reports[0].grade.reliability');
  refusedWith(edited((value) => { value.reports[0].grade = { reliability: 'B', credibility: '7' }; }), 'unknown-value', 'reports[0].grade.credibility');
  refusedWith(edited((value) => { value.reports[0].grade = { reliability: 'B', credibility: 2 }; }), 'unknown-value', 'reports[0].grade.credibility');
  refusedWith(edited((value) => { value.forces[0].designation = 'Line one\nline two'; }), 'wrong-type', 'forces[0].designation');
  refusedWith(edited((value) => { value.parties = value.parties.filter((party: { side: string }) => party.side !== 'adversary'); }), 'missing-field', 'parties.adversary');
  refusedWith(edited((value) => { value.reports = []; }), 'missing-field', 'reports');
  refusedWith(edited((value) => { value.mission.own.tasks = []; }), 'missing-field', 'mission.own.tasks');
  refusedWith(edited((value) => { value.region.features = Array.from({ length: 201 }, () => value.region.features[0]); }), 'too-many', 'region.features');
});

test('import refuses duplicate ids and references to ids the scenario does not define', () => {
  refusedWith(edited((value) => { value.reports[1].id = value.reports[0].id; }), 'duplicate-entry', 'reports[1].id');
  refusedWith(edited((value) => { value.forces[1].id = value.reports[0].id; }), 'duplicate-entry');
  refusedWith(edited((value) => { value.forces[0].party = 'nobody'; }), 'dangling-reference', 'forces[0].party');
  refusedWith(edited((value) => { value.forces[1].parent = 'nobody'; }), 'dangling-reference', 'forces[1].parent');
  refusedWith(edited((value) => { value.forces[1].reportedBy = ['XX-99']; }), 'dangling-reference', 'forces[1].reportedBy[0]');
  refusedWith(edited((value) => { value.reports[0].about = ['nothing-here']; }), 'dangling-reference', 'reports[0].about[0]');
  refusedWith(edited((value) => { value.forces[0].parent = value.forces[1].id; }), 'not-allowed-here', 'forces[0].parent');
});

test('a downloaded source records its address, access date and distribution wording (design 10, 8 item 4)', () => {
  const downloaded = { id: 'SRC-2', title: 'An exercise volume', origin: 'downloaded', distribution: 'Approved for public release; distribution unlimited.' };
  refusedWith(edited((value) => { value.sourceRegister.push({ ...downloaded, accessed: '2026-11-18' }); }), 'missing-field', 'sourceRegister[1].address');
  refusedWith(edited((value) => { value.sourceRegister.push({ ...downloaded, address: 'https://example.org/v1' }); }), 'missing-field', 'sourceRegister[1].accessed');
  refusedWith(edited((value) => { value.sourceRegister.push({ ...downloaded, address: 'http://example.org/v1', accessed: '2026-11-18' }); }), 'wrong-type', 'sourceRegister[1].address');
  refusedWith(edited((value) => { value.sourceRegister.push({ ...downloaded, address: 'https://example.org/v1', accessed: '18 Nov' }); }), 'wrong-type', 'sourceRegister[1].accessed');
  assert.ok(parseScenario(edited((value) => { value.sourceRegister.push({ ...downloaded, address: 'https://example.org/v1', accessed: '2026-11-18' }); })).ok);
});

test('a hostile prototype key is refused, never copied', () => {
  const text = STARTER_TEXT.replace('"format": "near-ai-staff-scenario",', '"format": "near-ai-staff-scenario", "__proto__": { "polluted": true },');
  const parsed = parseScenarioText(text);
  assert.equal(parsed.ok, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

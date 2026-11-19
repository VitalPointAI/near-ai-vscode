// guard-scan fixtures, one or more per rule (design 10, 4.2 and 6.2; WP-SHARED): markings for every shipped scale, the label ceiling, the geofence in
// and out, the real-entity list, restricted titles, decision wording, personal data, J4 numbers without a calculator record, and review marks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { coordinatesIn, guardScan, guardScanText, insidePolygon, TEMPLATE_CEILING, unmarkedPairsIn } from '../domain/staff/guardScan';
import type { GuardConfig, GuardInput, GuardRule } from '../domain/staff/guardScan';
import type { ProductHeader } from '../domain/staff/products';
import { REAL_ENTITIES_FILE } from '../staff/staffHost';
import { callTool, J5_TEAM, staffWorld, writeBody } from './helpers/staffFixtures';

const NONE: GuardConfig = { realEntities: [] };
const BOX: GuardConfig = { realEntities: [], exerciseBox: [[10, 50], [12, 50], [12, 52], [10, 52]] };

function scan(body: string, extra: Partial<GuardInput> = {}): { rules: GuardRule[]; hold: boolean } {
  const result = guardScan({ body, section: 'j5', owner: 'lead-planner', config: NONE, ...extra });
  return { rules: result.findings.map((finding) => finding.rule), hold: result.hold };
}

const HEADER: ProductHeader = { product: 'p', kind: 'plan', section: 'j5', owner: 'lead-planner', profile: 'us-joint', level: 'operational', version: 1, state: 'draft', label: 'org/Internal', dependsOn: [] };

test('clean exercise text has no finding', () => {
  assert.deepEqual(scan('# Plan\n\nThe notional brigade moves at H+2.\n\nDECISION FOR: commander. Approve COA 1 or COA 2.\n', { header: HEADER }), { rules: [], hold: false });
});

test('every level above the template ceiling on every shipped scale is a marking, and the levels at or below it are not', () => {
  for (const [id, scale] of Object.entries(SCALE_PRESETS)) {
    const ceiling = Object.prototype.hasOwnProperty.call(TEMPLATE_CEILING, id) ? scale.levels.indexOf(TEMPLATE_CEILING[id]) : -1;
    scale.levels.forEach((level, index) => {
      const written = /NATO|Cosmic|Protected/i.test(level) ? level : level.toUpperCase();
      const result = scan(`Banner: ${written}\n`);
      assert.equal(result.rules.includes('marking'), index > ceiling, `${id}: ${level}`);
    });
  }
});

test('caveats, portion marks and banners are markings; list labels, plain words and control measures are not', () => {
  for (const text of ['NOFORN', 'REL TO USA, CAN', 'CAN EYES ONLY', 'CUI', 'Para (TS) text', '(S//REL) text', 'SECRET//NOFORN', 'FOUO']) assert.ok(scan(text).rules.includes('marking'), text);
  for (const text of ['(a) (b) (C) options', 'a secret plan in plain words', 'keep this confidential', 'RESTRICTED FIRE LINE along the river', 'NATO Unclassified', 'Protected A']) assert.ok(!scan(text).rules.includes('marking'), text);
});

test('the label: org/Internal, NATO Unclassified and Protected A pass; anything higher or on the classified scale is held', () => {
  for (const label of ['org/Internal', 'org/Public', 'nato/NATO Unclassified', 'ca-protected/Protected A']) assert.deepEqual(scan('x', { header: { ...HEADER, label } }).rules, [], label);
  for (const label of ['org/Confidential', 'nato/NATO Restricted', 'ca-protected/Protected B', 'ca-classified/Confidential', 'other/Internal']) assert.ok(scan('x', { header: { ...HEADER, label } }).rules.includes('label-ceiling'), label);
});

test('the geofence: inside the box passes, outside is held, and with no box every coordinate is held', () => {
  assert.ok(insidePolygon([11, 51], BOX.exerciseBox!));
  assert.ok(!insidePolygon([13, 51], BOX.exerciseBox!));
  assert.deepEqual(scan('Objective at 51.1234, 11.5678', { config: BOX }).rules, []);
  assert.deepEqual(scan('Feature [11.2500, 51.0010] in GeoJSON', { config: BOX }).rules, []);
  assert.deepEqual(scan('Objective at 45.1234, 11.5678', { config: BOX }).rules, ['outside-exercise-box']);
  assert.deepEqual(scan('Objective at 51°10\'00"N 11°30\'00"E', { config: BOX }).rules, []);
  assert.deepEqual(scan('Objective at 51°10\'00"N 15°30\'00"E', { config: BOX }).rules, ['outside-exercise-box']);
  assert.deepEqual(scan('Objective at 51.1234, 11.5678').rules, ['coordinates-without-box']);
  assert.deepEqual(scan('Costs 1.25, 3.50 and 12.5').rules, [], 'short decimals are not coordinates');
  assert.equal(coordinatesIn('at 51.1234 N, 11.5678 W')[0].point[0], -11.5678);
  const grid = scan('Checkpoint at 33UXP0450099500');
  assert.deepEqual(grid, { rules: ['grid-reference'], hold: false }, 'a grid reference is for the guard to check by hand');
});

test('two-decimal coordinates are held and geofenced too; money, versions, percentages and short measures are not coordinates', () => {
  // Review round 5 of drop 1: "45.42, -75.69" (about a kilometre) was never held.
  assert.deepEqual(scan('Rally point 45.42, -75.69').rules, ['coordinates-without-box']);
  assert.deepEqual(scan('Rally point 45.42, -75.69', { config: BOX }).rules, ['outside-exercise-box']);
  assert.deepEqual(scan('Rally point 51.10 N, 11.10 E', { config: BOX }).rules, [], 'inside the box');
  assert.deepEqual(scan('Rally point 51.10 N, 13.10 E', { config: BOX }).rules, ['outside-exercise-box']);
  assert.deepEqual(scan('Rally point 51.10°, 13.10°', { config: BOX }).rules, ['outside-exercise-box'], 'a degree sign reads as a position');
  assert.deepEqual(scan('Rally point 51.10°N, 13.10°E').rules, ['coordinates-without-box']);
  assert.deepEqual(coordinatesIn('at 51.10°, 11.10°')[0].point, [11.1, 51.1]);
  assert.deepEqual(coordinatesIn('at 45.42 N, 75.69 W')[0].point, [-75.69, 45.42]);
  assert.deepEqual(coordinatesIn('at -5.25, 39.10')[0].point, [39.1, -5.25], 'a minus sign reads as a position');
  for (const text of [
    'Costs 1.25, 3.50 and 12.5', 'Prices $12.50, $13.75 and €10.20, 11.40', 'Upgrade from v10.12, v11.04', 'Shares 45.42%, 54.58%', 'Version 1.2.3, 4.5.6',
    'Ratios 1.25, 2.50', 'Totals 1,245.42, 2,075.69', 'Rates 0.25, 0.50', 'Release 10.12.04, 11.04.01',
    // Drop 2 review: plain two-digit decimals are not positions without a hemisphere letter, a minus sign or a degree sign.
    '12.50, 3.50', 'Unit prices 12.50, 3.50', 'Scores 45.42, 54.58', 'Rally point 51.10, 11.10'
  ]) {
    assert.deepEqual(scan(text).rules, [], text);
    // With a box, an unmarked pair that could be a position outside it goes to the guard to check by hand; it is never a hold.
    const boxed = scan(text, { config: BOX });
    assert.equal(boxed.hold, false, `${text} (with a box)`);
    assert.ok(boxed.rules.every((rule) => rule === 'unmarked-pair-outside-box'), `${text} (with a box): ${boxed.rules.join(', ')}`);
  }
  assert.equal(coordinatesIn('Not a pair: 45.42 then 75.69').length, 0, 'a pair is separated by a comma');
  assert.equal(coordinatesIn('Out of range 95.42, 75.69').length, 0, 'a latitude past 90 is no position');
});

test('with an exercise box, an unmarked two-decimal pair outside it is for the guard to check; inside it passes; with no box it is not a coordinate', () => {
  // Outside the box: a plausible latitude and longitude, held for the guard's review (CHECK), never a block (HOLD).
  for (const text of ['12.50, 3.50', 'Rally point 45.42, 75.69', 'Scores 45.42, 54.58']) {
    assert.deepEqual(scan(text, { config: BOX }), { rules: ['unmarked-pair-outside-box'], hold: false }, text);
    assert.deepEqual(scan(text), { rules: [], hold: false }, `${text}: with no box an unmarked pair is not a coordinate`);
  }
  // Inside the box: it passes.
  for (const text of ['Rally point 51.10, 11.10', 'Grid 50.50, 10.25']) assert.deepEqual(scan(text, { config: BOX }), { rules: [], hold: false }, text);
  // Not a plausible position, or not a pair at all: nothing, box or not.
  for (const text of ['Out of range 95.42, 75.69', 'Prices $12.50, $13.75', 'Shares 45.42%, 54.58%', 'Totals 1,245.42, 2,075.69', 'Upgrade from v10.12, v11.04']) {
    assert.deepEqual(scan(text, { config: BOX }).rules, [], text);
  }
  // A marked pair is still a coordinate, held outside the box as before; it is not also reported as unmarked.
  assert.deepEqual(scan('Rally point 45.42 N, 75.69 E', { config: BOX }).rules, ['outside-exercise-box']);
  assert.deepEqual(unmarkedPairsIn('at 12.50, 3.50'), [{ point: [3.5, 12.5], index: 3, text: '12.50, 3.50' }]);
  assert.match(guardScanText(guardScan({ body: '12.50, 3.50', section: 'j5', owner: 'lead-planner', config: BOX }), 'h'), /\[CHECK\] unmarked-pair-outside-box[\s\S]*No finding is a HOLD/);
});

test('names on the real-entity list are held, as whole words in any case', () => {
  const config: GuardConfig = { realEntities: ['Fort Example', 'Northfield Base'] };
  assert.deepEqual(scan('Moves to fort example by night', { config }).rules, ['real-entity']);
  assert.deepEqual(scan('Moves to Fort Examples', { config }).rules, []);
});

test('a publication with no public copy is for the guard to check; one cited by its public title is not', () => {
  const found = scan('Method follows JP 2-0 (2022).');
  assert.deepEqual(found, { rules: ['restricted-title'], hold: false });
  assert.deepEqual(scan('Method follows JP 5-0 (2025).').rules, []);
  assert.deepEqual(scan('Method follows JP 2-01.3.').rules, [], 'a longer number is another publication');
});

test('decision wording: a decision written as made is held; DECISION FOR, recommendations and conditions are not', () => {
  for (const text of ['COA 2 has been approved.', 'The commander approved COA 2.', 'We selected COA 1.', 'The plan was released to J3.']) assert.deepEqual(scan(text).rules, ['decision-as-made'], text);
  for (const text of ['DECISION FOR: commander. COA 2 is approved if the river is fordable.', 'Once approved, the annex goes to J3.', 'COA 2 is not yet approved.', 'Recommend COA 2 for approval.', 'Awaiting the decision of the commander.']) assert.deepEqual(scan(text).rules, [], text);
});

test('personal data and secrets are held and their excerpt is masked', () => {
  const result = guardScan({ body: 'Call 613-555-0142 or write a.person@example.org\nSSN 123-45-6789\nDOB: 1990-01-01', section: 'j1', owner: 'personnel', config: NONE });
  assert.deepEqual(result.findings.map((finding) => finding.rule), ['personal-data', 'personal-data', 'personal-data', 'personal-data']);
  assert.ok(result.findings.every((finding) => !/555-0142|example\.org|45-6789/.test(finding.excerpt)));
  assert.ok(scan('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH').rules.includes('secret'));
});

test('J4 numbers need a calculator record on the same line, and the record must exist when the project has any', () => {
  const j4 = (body: string, config: GuardConfig = NONE) => guardScan({ body, section: 'j4', owner: 'jloc-chief', config }).findings.map((finding) => finding.rule);
  assert.deepEqual(j4('Fuel: 12,000 litres per day'), ['number-without-calculation']);
  assert.deepEqual(j4('Fuel: 12,000 litres per day (calc:fuel-day-1)'), []);
  assert.deepEqual(j4('Fuel: 12,000 litres per day (calc:fuel-day-9)', { realEntities: [], calculatorRecords: new Set(['fuel-day-1']) }), ['number-without-calculation']);
  assert.deepEqual(scan('Fuel: 12,000 litres per day').rules, [], 'only J4 products');
});

test('legal and health support products carry their review mark', () => {
  assert.deepEqual(guardScan({ body: 'ROE notes', section: 'special-staff', owner: 'legal-support', config: NONE }).findings.map((finding) => finding.rule), ['review-mark-missing']);
  assert.deepEqual(guardScan({ body: 'ROE notes. LEGAL REVIEW REQUIRED', section: 'special-staff', owner: 'legal-support', config: NONE }).findings, []);
  assert.deepEqual(guardScan({ body: 'Casualty estimate', section: 'j4', owner: 'health-services-planner', config: NONE }).findings.map((finding) => finding.rule), ['review-mark-missing']);
});

test('through the tool: guard-scan reads the exercise box and both real-entity lists of the project, and gives the version hash', async () => {
  const world = await staffWorld();
  await mkdir(path.join(world.root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(world.root, '.planning', '.near-ai', 'staff-guard.json'), JSON.stringify({ exerciseBox: [[10, 50], [12, 50], [12, 52], [10, 52]], realEntities: ['Fort Example'] }));
  await mkdir(path.join(world.root, path.dirname(REAL_ENTITIES_FILE)), { recursive: true });
  await writeFile(path.join(world.root, REAL_ENTITIES_FILE), '# real places\nNorthfield Base\n');
  await writeBody(world.root, 'j5', 'concept-of-operations', 'Assembly at 51.1000, 11.1000, then Fort Example, then Northfield Base, then 45.0000, 11.0000.\n');
  const result = await callTool(world, J5_TEAM, 'mcp__guard-scan__scan', { product: 'concept-of-operations' }, 'release-guard');
  assert.ok(result.ok, result.text);
  assert.match(result.text, /version hash [0-9a-f]{64}/);
  assert.equal((result.text.match(/\[HOLD\] real-entity/g) ?? []).length, 2);
  assert.equal((result.text.match(/outside-exercise-box/g) ?? []).length, 1);
});

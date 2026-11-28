import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gapStates, loadGaps, loadPoam } from '../src/gaps.ts';
import type { Gap, Poam } from '../src/gaps.ts';
import { reviewedAt } from '../src/collectors/documents.ts';
import { loadEvidenceRules } from '../src/evidenceRuleFiles.ts';
import { selectedIds } from '../src/profiles.ts';
import { validateOurs } from '../src/validate.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gaps = loadGaps(path.join(root, 'gaps.json'));
const poam = loadPoam(path.join(root, 'poam'));
const now = new Date('2026-11-21T12:00:00.000Z');
const stateFor = (id: string, rows: readonly { level: string; control: string; state: 'met' | 'not-met' | 'not-applicable' }[] = [], acceptances: readonly any[] = [], at = now) => gapStates({ gaps, poam, rows, acceptances, now: at }).find((gap) => gap.id === id)!;

test('the real gap register and every POA&M item validate', () => {
  // Ratchet floor prevents accidental mass deletion without forcing exact-count merge conflicts on parallel branches.
  assert.ok(gaps.length >= 487, `expected at least 487 gaps, found ${gaps.length}`);
  assert.ok(poam.length >= 396, `expected at least 396 POA&M items, found ${poam.length}`);
  const gapIds = new Set(gaps.map((gap) => gap.id));
  const poamIds = new Set(poam.map((item) => item.id));
  assert.equal(gapIds.size, gaps.length, 'gap ids must be unique');
  assert.equal(poamIds.size, poam.length, 'POA&M ids must be unique');
  for (const gap of gaps) {
    assert.ok(gap.controls.length > 0 && gap.remediation !== '' && gap.ownerRole !== '' && (gap.closesInPhase === undefined) !== (gap.poam === undefined), gap.id);
    if (gap.poam !== undefined) assert.ok(poamIds.has(gap.poam), `${gap.id} references missing POA&M ${gap.poam}`);
  }
  for (const item of poam) {
    assert.ok(gapIds.has(item.gap), `POA&M ${item.id} references missing gap ${item.gap}`);
  }
});
// Every gap names the lowest level where it matters and whether it blocks production (the road to production page groups by both).
test('a gap without its level or production flag, or with a level outside the fixed list, is refused', () => {
  const register = JSON.parse(readFileSync(path.join(root, 'gaps.json'), 'utf8')) as { gaps: Record<string, unknown>[] };
  assert.equal(validateOurs(register, 'gaps').ok, true);
  const withFirst = (change: (gap: Record<string, unknown>) => void) => {
    const copy = structuredClone(register); change(copy.gaps[0]!); return validateOurs(copy, 'gaps').ok;
  };
  assert.equal(withFirst((gap) => { delete gap.appliesAt; }), false);
  assert.equal(withFirst((gap) => { delete gap.blocksProduction; }), false);
  assert.equal(withFirst((gap) => { gap.appliesAt = 'restricted'; }), false);
  assert.equal(withFirst((gap) => { gap.blocksProduction = 'yes'; }), false);
  for (const level of ['now', 'protected-a', 'protected-b', 'protected-c', 'confidential', 'secret', 'top-secret', 'coalition-exchange']) assert.equal(withFirst((gap) => { gap.appliesAt = level; }), true, level);
});
test('release assessment gaps have named open paths', () => {
  for (const [control, id, phase] of [
    ['ac-02', 'G14', '33'], ['au-02', 'G11', '44.1'], ['si-03', 'G15', '44.1'],
    ['ac-16.05', 'G16', '41'], ['ac-06.09', 'G17', '33.1'], ['au-05.01', 'G18', '44.1'], ['ia-05', 'G19', '44.1'],
    ['ia-01', 'G20', '44.1'], ['ia-04', 'G21', '44.1'], ['ia-04.04', 'G21', '44.1'],
    ['ia-12', 'G22', '44.1'], ['ia-12.02', 'G22', '44.1'], ['ia-12.03', 'G22', '44.1'],
    ['ia-12.04', 'G22', '44.1'], ['ia-12.05', 'G22', '44.1'],
    ['ia-03', 'G23', '44.1'], ['ia-05.01', 'G24', '44.1'], ['ia-06', 'G24', '44.1'],
    ['ia-05.07', 'G25', '44.1'], ['ia-07', 'G26', '44.1'],
    ['ia-02', 'G27', '44.1'], ['ia-02.01', 'G27', '44.1'], ['ia-02.02', 'G27', '44.1'],
    ['ia-02.08', 'G27', '44.1'], ['ia-02.10', 'G27', '44.1'], ['ia-11', 'G27', '44.1'],
    ['ia-05.08', 'G28', '44.1'],
    ['ia-05.09', 'G29', '44.1'], ['ia-08', 'G29', '44.1'], ['ia-08.01', 'G29', '44.1'],
    ['ia-08.02', 'G29', '44.1'], ['ia-08.04', 'G29', '44.1'], ['ia-05.14', 'G30', '44.1'],
    ['cp-02.02', 'G31', '44.1'], ['cp-04.01', 'G32', '44.1'], ['cp-07.06', 'G33', '44.1'],
    ['cp-08.05', 'G34', '44.1'], ['cp-09', 'G35', '44.1'], ['cp-09.07', 'G35', '44.1'],
    ['cp-10', 'G36', '44.1'], ['cp-10.04', 'G36', '44.1'],
    ['au-01', 'G44', '44.1'], ['au-03.01', 'G45', '44.1'], ['au-04.01', 'G46', '44.1'],
    ['au-12.01', 'G47', '44.1'], ['au-07.01', 'G48', '44.1'], ['au-09.06', 'G49', '44.1'],
    ['ac-07', 'G37', '44.1'], ['ac-08', 'G38', '44.1'], ['ac-14', 'G38', '44.1'],
    ['ac-11', 'G39', '44.1'], ['ac-11.01', 'G39', '44.1'], ['ac-02.05', 'G40', '44.1'],
    ['ac-12', 'G40', '44.1'], ['ac-17', 'G41', '44.1'], ['ac-17.01', 'G41', '44.1'],
    ['ac-17.02', 'G41', '44.1'], ['ac-17.03', 'G41', '44.1'], ['ac-17.04', 'G41', '44.1'],
    ['ac-17.400', 'G41', '44.1'], ['ac-20', 'G42', '44.1'], ['ac-20.01', 'G42', '44.1'],
    ['ac-20.02', 'G42', '44.1'], ['ac-20.04', 'G42', '44.1'], ['ac-21', 'G43', '44.1'],
    ['ac-21.400', 'G43', '44.1'], ['ac-21.401', 'G43', '44.1'],
    ['ac-01', 'G58', '44.1'], ['ac-02.01', 'G59', '44.1'], ['ac-02.02', 'G59', '44.1'],
    ['ac-02.03', 'G59', '44.1'], ['ac-02.04', 'G59', '44.1'], ['ac-02.10', 'G59', '44.1'],
    ['ac-02.13', 'G59', '44.1'], ['ac-02.07', 'G60', '44.1'], ['ac-03.02', 'G61', '44.1'],
    ['ac-03.04', 'G62', '44.1'], ['ac-03.09', 'G63', '44.1'], ['ac-18', 'G64', '44.1'],
    ['ac-18.01', 'G64', '44.1'], ['ac-18.03', 'G64', '44.1'], ['ac-18.04', 'G64', '44.1'],
    ['ac-19', 'G65', '44.1'], ['ac-19.05', 'G65', '44.1'], ['ac-22', 'G66', '44.1'],
    ['cm-09', 'G50', '44.1'], ['cm-02.03', 'G51', '44.1'], ['cm-02.07', 'G52', '44.1'],
    ['cm-04.02', 'G53', '44.1'], ['cm-07.05', 'G54', '44.1'], ['cm-08.03', 'G55', '44.1'],
    ['cm-11.02', 'G56', '44.1'], ['cm-12.01', 'G57', '44.1'],
    ['si-01', 'G67', '44.1'], ['si-02.02', 'G68', '44.1'], ['si-03.04', 'G69', '44.1'],
    ['si-04.15', 'G70', '44.1'], ['si-07.07', 'G71', '44.1'], ['si-08.02', 'G72', '44.1'],
    ['si-11', 'G73', '44.1'], ['si-400', 'G74', '44.1'],
    ['ra-07', 'G75', '44.1'], ['ra-09', 'G76', '44.1'], ['ra-03.01', 'G77', '44.1'],
    ['ra-05.05', 'G78', '44.1'], ['ra-05.11', 'G79', '44.1'], ['pl-02', 'G80', '44.1'],
    ['pl-04.01', 'G81', '44.1'], ['pl-11', 'G82', '44.1'],
    ['ir-03.02', 'G83', '44.1'], ['ir-04.09', 'G84', '44.1'], ['ir-04.08', 'G85', '44.1'],
    ['ir-06.03', 'G86', '44.1'], ['ir-07.01', 'G87', '44.1'], ['ir-08', 'G88', '44.1'],
    ['ca-02.01', 'G97', '44.1'], ['ca-09.01', 'G98', '44.1'], ['ca-05', 'G99', '44.1'],
    ['ca-06', 'G100', '44.1'], ['ca-07.04', 'G101', '44.1'],
    ['sr-01', 'G89', '44.1'], ['sr-02', 'G89', '44.1'], ['sr-02.01', 'G89', '44.1'],
    ['sr-05', 'G90', '44.1'], ['sr-06', 'G91', '44.1'], ['sr-08', 'G92', '44.1'],
    ['sr-10', 'G93', '44.1'], ['sr-11.01', 'G94', '44.1'], ['sr-11.02', 'G95', '44.1'],
    ['sr-12', 'G96', '44.1'],
    ['sa-01', 'G102', '44.1'], ['sa-02', 'G103', '44.1'], ['sa-03', 'G104', '44.1'],
    ['sa-04', 'G105', '44.1'], ['sa-04.01', 'G105', '44.1'], ['sa-04.09', 'G105', '44.1'],
    ['sa-04.10', 'G106', '44.1'], ['sa-04.12', 'G107', '44.1'], ['sa-05', 'G108', '44.1'],
    ['sa-16', 'G108', '44.1'], ['sa-08', 'G109', '44.1'], ['sa-17', 'G109', '44.1'],
    ['sa-09', 'G110', '44.1'], ['sa-09.01', 'G110', '44.1'], ['sa-09.02', 'G110', '44.1'],
    ['sa-09.08', 'G111', '44.1'], ['sa-10', 'G112', '44.1'], ['sa-10.07', 'G112', '44.1'],
    ['sa-10.01', 'G113', '44.1'], ['sa-11', 'G114', '44.1'], ['sa-15', 'G115', '44.1'],
    ['sa-15.03', 'G115', '44.1'], ['sa-22', 'G116', '44.1'], ['sa-400', 'G117', '44.1'],
    ['pm-03', 'G180', '44.1'], ['pm-31', 'G181', '44.1'], ['pm-05.01', 'G182', '44.1'],
    ['pm-32', 'G183', '44.1'], ['pm-08', 'G184', '44.1'], ['pm-29', 'G185', '44.1'],
    ['pm-13', 'G186', '44.1'], ['pm-16.01', 'G187', '44.1'], ['pm-17', 'G188', '44.1'],
    ['pm-27', 'G189', '44.1'], ['pm-26', 'G190', '44.1'], ['pm-22', 'G191', '44.1'],
    ['pm-25', 'G192', '44.1'], ['pm-30.01', 'G193', '44.1'],
    ['sc-01', 'G118', '44.1'], ['sc-04', 'G119', '44.1'], ['sc-05.02', 'G120', '44.1'],
    ['sc-07.04', 'G121', '44.1'], ['sc-07.11', 'G122', '44.1'], ['sc-07.08', 'G123', '44.1'],
    ['sc-07.09', 'G124', '44.1'], ['sc-07.13', 'G125', '44.1'], ['sc-08.01', 'G126', '44.1'],
    ['sc-10', 'G127', '44.1'], ['sc-12.01', 'G128', '44.1'], ['sc-13', 'G129', '44.1'],
    ['sc-15.03', 'G130', '44.1'], ['sc-17', 'G131', '44.1'], ['sc-18.05', 'G132', '44.1'],
    ['sc-20', 'G133', '44.1'], ['sc-22', 'G134', '44.1'], ['sc-23.03', 'G135', '44.1'],
    ['sc-28.01', 'G136', '44.1'], ['sc-29', 'G137', '44.1'], ['sc-39', 'G138', '44.1'],
    ['sc-45', 'G139', '44.1'],
    ['at-01', 'G140', '44.1'], ['at-02', 'G141', '44.1'], ['at-02.02', 'G141', '44.1'],
    ['at-02.03', 'G141', '44.1'], ['at-03', 'G142', '44.1'], ['at-04', 'G143', '44.1'],
    ['ma-01', 'G144', '44.1'], ['ma-02', 'G145', '44.1'], ['ma-03', 'G146', '44.1'],
    ['ma-03.01', 'G146', '44.1'], ['ma-03.02', 'G146', '44.1'], ['ma-03.03', 'G147', '44.1'],
    ['ma-04', 'G148', '44.1'], ['ma-04.01', 'G148', '44.1'], ['ma-04.03', 'G149', '44.1'],
    ['ma-04.04', 'G150', '44.1'], ['ma-04.06', 'G150', '44.1'], ['ma-05', 'G151', '44.1'],
    ['ma-05.01', 'G151', '44.1'], ['ma-06', 'G152', '44.1'], ['mp-01', 'G153', '44.1'],
    ['mp-02', 'G154', '44.1'], ['mp-07', 'G154', '44.1'], ['mp-03', 'G155', '44.1'],
    ['mp-04', 'G155', '44.1'], ['mp-05', 'G156', '44.1'], ['mp-06', 'G157', '44.1'],
    ['mp-06.03', 'G157', '44.1'], ['mp-06.08', 'G158', '44.1'], ['mp-08', 'G159', '44.1'],
    ['mp-08.03', 'G159', '44.1'],
    ['pe-01', 'G160', '44.1'], ['pe-02', 'G161', '44.1'], ['pe-02.400', 'G161', '44.1'],
    ['pe-03', 'G162', '44.1'], ['pe-03.400', 'G162', '44.1'], ['pe-04', 'G163', '44.1'],
    ['pe-05', 'G163', '44.1'], ['pe-06', 'G164', '44.1'], ['pe-06.01', 'G164', '44.1'],
    ['pe-08', 'G165', '44.1'], ['pe-09', 'G166', '44.1'], ['pe-10', 'G166', '44.1'],
    ['pe-11', 'G167', '44.1'], ['pe-12', 'G167', '44.1'], ['pe-13', 'G168', '44.1'],
    ['pe-13.01', 'G168', '44.1'], ['pe-13.04', 'G168', '44.1'], ['pe-13.400', 'G168', '44.1'],
    ['pe-14', 'G169', '44.1'], ['pe-15', 'G169', '44.1'], ['pe-16', 'G170', '44.1'],
    ['pe-17', 'G171', '44.1'], ['pe-400', 'G171', '44.1'], ['pe-400.01', 'G171', '44.1'],
    ['pe-400.02', 'G172', '44.1'], ['pe-401', 'G173', '44.1'], ['ps-01', 'G174', '44.1'],
    ['ps-02', 'G175', '44.1'], ['ps-03', 'G175', '44.1'], ['ps-09', 'G175', '44.1'],
    ['ps-04', 'G176', '44.1'], ['ps-06', 'G177', '44.1'], ['ps-07', 'G178', '44.1'],
    ['ps-08', 'G179', '44.1'],
    ['itsp171-03.01.01', 'G210', '44.1'], ['itsp171-03.01.02', 'G211', '44.1'], ['itsp171-03.01.20', 'G212', '44.1'],
    ['itsp171-03.01.22', 'G213', '44.1'], ['itsp171-03.05.01', 'G214', '44.1'], ['itsp171-03.05.02', 'G215', '44.1'],
    ['itsp171-03.05.03', 'G216', '44.1'], ['itsp171-03.08.03', 'G217', '44.1'], ['itsp171-03.10.01', 'G218', '44.1'],
    ['itsp171-03.10.07', 'G219', '44.1'], ['itsp171-03.13.01', 'G220', '44.1'], ['itsp171-03.14.01', 'G221', '44.1'],
    ['itsp171-03.14.02', 'G222', '44.1'],
    ['itsp171-03.01.01', 'G225', '44.1'], ['itsp171-03.01.02', 'G226', '44.1'], ['itsp171-03.01.03', 'G227', '44.1'],
    ['itsp171-03.01.04', 'G228', '44.1'], ['itsp171-03.01.05', 'G229', '44.1'], ['itsp171-03.01.06', 'G229', '44.1'],
    ['itsp171-03.01.07', 'G229', '44.1'], ['itsp171-03.01.08', 'G230', '44.1'], ['itsp171-03.01.09', 'G231', '44.1'],
    ['itsp171-03.01.10', 'G232', '44.1'], ['itsp171-03.01.11', 'G232', '44.1'], ['itsp171-03.01.12', 'G233', '44.1'],
    ['itsp171-03.01.16', 'G234', '44.1'], ['itsp171-03.01.18', 'G234', '44.1'], ['itsp171-03.01.20', 'G235', '44.1'],
    ['itsp171-03.01.22', 'G236', '44.1'], ['itsp171-03.02.01', 'G237', '44.1'], ['itsp171-03.02.02', 'G237', '44.1'],
    ['itsp171-03.03.01', 'G238', '44.1'], ['itsp171-03.03.02', 'G238', '44.1'], ['itsp171-03.03.03', 'G238', '44.1'],
    ['itsp171-03.03.04', 'G239', '44.1'], ['itsp171-03.03.05', 'G240', '44.1'], ['itsp171-03.03.06', 'G241', '44.1'],
    ['itsp171-03.03.07', 'G242', '44.1'], ['itsp171-03.03.08', 'G243', '44.1'], ['itsp171-03.01.13', 'G244', '44.1'],
    ['itsp171-03.01.14', 'G244', '44.1'], ['itsp171-03.01.15', 'G244', '44.1'], ['itsp171-03.01.17', 'G244', '44.1'],
    ['itsp171-03.01.19', 'G244', '44.1'], ['itsp171-03.01.21', 'G244', '44.1'], ['itsp171-03.02.03', 'G244', '44.1'],
    ['itsp171-03.03.09', 'G244', '44.1'],
    ['cgp-9', 'G194', '44.1'], ['cgp-10-b', 'G195', '44.1'], ['cgp-10-c', 'G195', '44.1'],
    ['cgp-10-f', 'G196', '44.1'], ['cgp-10-g', 'G196', '44.1'], ['cgp-10-i', 'G197', '44.1'],
    ['cgp-10-j', 'G198', '44.1'], ['cgp-11', 'G199', '44.1'], ['cgp-12', 'G199', '44.1'],
    ['cgp-13', 'G200', '44.1'], ['cgp-14', 'G200', '44.1'], ['cgp-15', 'G200', '44.1'],
    ['cgp-16', 'G201', '44.1'], ['cgp-17', 'G202', '44.1'], ['cgp-18', 'G202', '44.1'],
    ['cgp-19', 'G202', '44.1'], ['cgp-23', 'G202', '44.1'], ['cgp-37-1', 'G203', '44.1'],
    ['cgp-37-2', 'G203', '44.1'], ['itar-120.50', 'G204', '44.1'], ['itar-120.55', 'G205', '44.1'],
    ['itar-120.56-a', 'G205', '44.1'], ['itar-120.56-b', 'G205', '44.1'], ['itar-122.1', 'G206', '44.1'],
    ['itar-126.1', 'G207', '44.1'], ['itar-126.18', 'G208', '44.1'], ['ear-734.13', 'G209', '44.1'],
    ['ear-734.15', 'G209', '44.1'], ['ear-734.18-a5', 'G209', '44.1'],
    ['itsp171-03.14.01', 'G305', '44.1'], ['itsp171-03.14.02', 'G306', '44.1'], ['itsp171-03.14.03', 'G307', '44.1'],
    ['itsp171-03.14.06', 'G308', '44.1'], ['itsp171-03.14.08', 'G309', '44.1'], ['itsp171-03.14.09', 'G310', '44.1'],
    ['itsp171-03.14.04', 'G311', '44.1'], ['itsp171-03.14.05', 'G311', '44.1'], ['itsp171-03.14.07', 'G311', '44.1'],
    ['itsp171-03.15.01', 'G312', '44.1'], ['itsp171-03.15.02', 'G313', '44.1'], ['itsp171-03.15.03', 'G314', '44.1'],
    ['itsp171-03.16.01', 'G315', '44.1'], ['itsp171-03.16.02', 'G316', '44.1'], ['itsp171-03.16.03', 'G317', '44.1'],
    ['itsp171-03.17.01', 'G318', '44.1'], ['itsp171-03.17.02', 'G319', '44.1'], ['itsp171-03.17.03', 'G320', '44.1'],
    ['itsp171-03.04.01', 'G245', '44.1'], ['itsp171-03.04.03', 'G246', '44.1'], ['itsp171-03.04.06', 'G247', '44.1'],
    ['itsp171-03.04.08', 'G248', '44.1'], ['itsp171-03.04.10', 'G249', '44.1'], ['itsp171-03.04.12', 'G250', '44.1'],
    ['itsp171-03.05.01', 'G251', '44.1'], ['itsp171-03.05.02', 'G252', '44.1'], ['itsp171-03.05.03', 'G253', '44.1'],
    ['itsp171-03.05.05', 'G254', '44.1'], ['itsp171-03.05.07', 'G255', '44.1'], ['itsp171-03.05.12', 'G256', '44.1'],
    ['itsp171-03.06.01', 'G257', '44.1'], ['itsp171-03.06.02', 'G258', '44.1'], ['itsp171-03.06.04', 'G259', '44.1'],
    ['itsp171-03.06.05', 'G260', '44.1'], ['itsp171-03.07.04', 'G261', '44.1'], ['itsp171-03.07.05', 'G262', '44.1'],
    ['itsp171-03.07.06', 'G263', '44.1'], ['itsp171-03.08.01', 'G264', '44.1'], ['itsp171-03.08.03', 'G265', '44.1'],
    ['itsp171-03.08.04', 'G266', '44.1'], ['itsp171-03.08.07', 'G267', '44.1'], ['itsp171-03.08.09', 'G268', '44.1'],
    ['itsp171-03.04.07', 'G269', '44.1'],
    ['itsp171-03.09.01', 'G275', '44.1'], ['itsp171-03.09.02', 'G276', '44.1'], ['itsp171-03.10.02', 'G277', '44.1'],
    ['itsp171-03.10.03', 'G278', '44.1'], ['itsp171-03.10.04', 'G278', '44.1'], ['itsp171-03.10.05', 'G278', '44.1'],
    ['itsp171-03.10.06', 'G279', '44.1'], ['itsp171-03.10.08', 'G280', '44.1'], ['itsp171-03.11.01', 'G281', '44.1'],
    ['itsp171-03.11.02', 'G282', '44.1'], ['itsp171-03.11.03', 'G283', '44.1'], ['itsp171-03.11.04', 'G284', '44.1'],
    ['itsp171-03.12.01', 'G285', '44.1'], ['itsp171-03.12.02', 'G286', '44.1'], ['itsp171-03.12.03', 'G287', '44.1'],
    ['itsp171-03.12.04', 'G288', '44.1'], ['itsp171-03.12.05', 'G289', '44.1'], ['itsp171-03.13.04', 'G290', '44.1'],
    ['itsp171-03.13.02', 'G291', '44.1'], ['itsp171-03.13.03', 'G291', '44.1'], ['itsp171-03.13.05', 'G291', '44.1'],
    ['itsp171-03.13.07', 'G291', '44.1'], ['itsp171-03.13.14', 'G291', '44.1'], ['itsp171-03.13.16', 'G291', '44.1'],
    ['itsp171-03.13.06', 'G292', '44.1'], ['itsp171-03.13.08', 'G293', '44.1'], ['itsp171-03.13.09', 'G294', '44.1'],
    ['itsp171-03.13.10', 'G295', '44.1'], ['itsp171-03.13.11', 'G296', '44.1'], ['itsp171-03.13.12', 'G297', '44.1'],
    ['itsp171-03.13.13', 'G298', '44.1'], ['itsp171-03.13.15', 'G299', '44.1'], ['itsp171-03.10.01', 'G300', '44.1'],
    ['itsp171-03.10.07', 'G301', '44.1'], ['itsp171-03.13.01', 'G302', '44.1']
  ]) {
    const gap = gaps.find((item) => item.id === id);
    const item = poam.find((candidate) => candidate.id === gap?.poam);
    assert.ok(gap?.controls.includes(control), control);
    assert.ok(item?.controls.includes(control), control);
    assert.equal(item?.milestones[0]?.phase, phase, control);
    assert.equal(stateFor(id).state, 'planned', control);
  }
});
test('the 48.1 hosted SA&A areas are planned gaps on the hosted levels, and the owner items are POA&M items that point back', () => {
  // 48.1-01 (D-01, D-07): fifteen areas (G389 to G403) close in Phase 48.1; three items (G404 to G406) wait on the owner or the authorizing official.
  const hosted = ['hosted-protected-a', 'hosted-protected-b', 'hosted-itsp-10-171'];
  for (let number = 389; number <= 403; number += 1) {
    const gap = gaps.find((item) => item.id === `G${number}`);
    assert.equal(gap?.closesInPhase, '48.1', `G${number}`);
    assert.deepEqual(gap?.profiles, hosted, `G${number}`);
    assert.equal(stateFor(`G${number}`).state, 'planned', `G${number}`);
  }
  for (const id of ['G404', 'G405', 'G406']) {
    const gap = gaps.find((item) => item.id === id);
    const item = poam.find((candidate) => candidate.id === gap?.poam);
    assert.equal(item?.gap, id);
    assert.equal(gap?.ownerRole, 'owner');
    assert.deepEqual(item?.controls, gap?.controls);
    assert.ok(item?.milestones.length, id);
  }
});
test('a gap closes only when every control has met or reviewed-not-applicable evidence', () => assert.equal(stateFor('G13', [{ level: 'protected-b', control: 'sc-08', state: 'met' }, { level: 'protected-b', control: 'sr-11', state: 'not-applicable' }]).state, 'closed'));
test('a gap reports progress when any affected control has evidence, regardless of order', () => {
  for (const control of ['sc-08', 'sr-11']) {
    const covered = { level: 'protected-b', control, state: 'met' } as const;
    assert.equal(stateFor('G13', [covered]).state, 'in-progress');
  }
  assert.equal(stateFor('G13', [
    { level: 'protected-b', control: 'sc-08', state: 'not-met' },
    { level: 'protected-b', control: 'sr-11', state: 'met' },
  ]).state, 'in-progress');
});
test('a POA&M milestone makes an untouched gap planned', () => assert.equal(stateFor('G13').state, 'planned'));
test('the product incident exercise and advisory evidence are planned for Phase 44.1', () => assert.equal(stateFor('G1').phase, '44.1'));
test('a past target date is an overdue flag', () => assert.equal(stateFor('G13', [], [], new Date('2028-01-01T00:00:00.000Z')).overdue, true));
test('a current verified acceptance makes its gap risk accepted until its expiry', () => {
  const accepted = stateFor('G13', [], [{ id: 'ra', gap: 'G13', controls: ['sc-08', 'sr-11'], reason: 'Accepted.', namedPerson: { name: 'Owner', role: 'Owner' }, issuedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z' }]);
  assert.deepEqual({ state: accepted.state, acceptedUntil: accepted.acceptedUntil }, { state: 'risk-accepted', acceptedUntil: '2026-12-01T00:00:00.000Z' });
});
test('an expired acceptance does not change the planned state', () => assert.equal(stateFor('G13', [], [{ id: 'ra', gap: 'G13', controls: ['sc-08', 'sr-11'], reason: 'Accepted.', namedPerson: { name: 'Owner', role: 'Owner' }, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-11-20T00:00:00.000Z' }]).state, 'planned'));
test('CPCSC evidence cannot close the same-identifier ITSP.10.171 remediation path, and neither ITSP.10.171 scope closes the other\'s action', () => {
  const control = 'itsp171-03.14.01';
  const cpcsc = { level: 'cpcsc-level-1', control, state: 'met' } as const;
  const row = (level: string, state: 'met' | 'not-met') => ({ level, control, state }) as const;
  assert.equal(stateFor('G305', [cpcsc, row('itsp-10-171', 'not-met'), row('hosted-itsp-10-171', 'not-met')]).state, 'planned');
  // The product and hosted overlays share one path per objective (44.1-03): with both overlays' rows present, as the dashboard has them, it
  // closes only when both deployments' rows are met.
  assert.equal(stateFor('G305', [cpcsc, row('itsp-10-171', 'met'), row('hosted-itsp-10-171', 'not-met')]).state, 'in-progress');
  assert.equal(stateFor('G305', [cpcsc, row('itsp-10-171', 'not-met'), row('hosted-itsp-10-171', 'met')]).state, 'in-progress');
  assert.equal(stateFor('G305', [cpcsc, row('itsp-10-171', 'met'), row('hosted-itsp-10-171', 'met')]).state, 'closed');
});

test('every ITSP.10.171 objective path is scoped either to CPCSC Level 1 alone or to the product and hosted ITSP.10.171 overlays together', () => {
  const objective = gaps.filter((gap) => gap.controls.some((control) => control.startsWith('itsp171-')));
  const scopes = new Map<string, string[]>();
  for (const gap of objective) scopes.set(JSON.stringify(gap.profiles), [...(scopes.get(JSON.stringify(gap.profiles)) ?? []), gap.id]);
  assert.deepEqual([...scopes.keys()].sort(), [JSON.stringify(['cpcsc-level-1']), JSON.stringify(['itsp-10-171', 'hosted-itsp-10-171'])].sort());
  assert.equal(scopes.get(JSON.stringify(['itsp-10-171', 'hosted-itsp-10-171']))?.length, 89);
});

// Hosted verification records (48-05, VER-08, VER-09, D-24): every register row and section 10 row names a reference that
// resolves. A record is a `## ` heading with a Source address and a Checked date; an open item is a gap with an owner role and a
// POA&M target date; a decided item names a gap that closes in Phase 48 until its evidence rule exists.
const RECORDS_FILE = path.resolve(root, '..', 'docs', 'security', 'hosted-verification-records.md');
const ruleIds = new Set(loadEvidenceRules(path.join(root, 'evidence-rules')).map((rule) => rule.id));
const ruleComponents = new Map(loadEvidenceRules(path.join(root, 'evidence-rules')).map((rule) => [rule.id, rule.component]));
interface RecordsContext { readonly gaps: readonly Gap[]; readonly poam: readonly Poam[]; readonly ruleIds: ReadonlySet<string> }
const realContext: RecordsContext = { gaps, poam, ruleIds };

/** The body rows of the first Markdown table under a `## ` heading. */
function tableUnder(text: string, heading: string): string[][] {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) { if (rows.length > 0) break; continue; }
    rows.push(line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
  }
  return rows.slice(2);
}

function sectionOf(text: string, heading: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

interface References { records: string[]; gaps: string[]; rules: string[]; none: boolean; unknown: string[] }
function referencesIn(cell: string): References {
  const parsed: References = { records: [], gaps: [], rules: [], none: false, unknown: [] };
  for (const part of cell.split(';').map((item) => item.trim()).filter((item) => item !== '')) {
    const record = /^Record: (.+)$/.exec(part); const gap = /^gap ([GX][0-9]+)$/.exec(part); const rule = /^rule ([a-z0-9][a-z0-9.-]*)$/.exec(part);
    if (record) parsed.records.push(record[1]);
    else if (gap) parsed.gaps.push(gap[1]);
    else if (rule) parsed.rules.push(rule[1]);
    else if (part === 'none') parsed.none = true;
    else parsed.unknown.push(part);
  }
  return parsed;
}

function recordProblems(text: string, heading: string): string[] {
  const section = sectionOf(text, heading);
  if (section === undefined) return [`record "${heading}" has no heading`];
  const problems: string[] = [];
  if (!/^Source: https:\/\/\S+$/m.test(section)) problems.push(`record "${heading}" has no Source line`);
  const checked = /^Checked: ([0-9]{4}-[0-9]{2}-[0-9]{2})$/m.exec(section);
  if (!checked || reviewedAt(checked[1]) === undefined) problems.push(`record "${heading}" has no valid Checked date`);
  return problems;
}

function datedGapProblems(id: string, context: RecordsContext): string[] {
  const gap = context.gaps.find((item) => item.id === id);
  if (!gap) return [`gap ${id} does not exist`];
  if (gap.ownerRole === '') return [`gap ${id} has no owner role`];
  const item = context.poam.find((candidate) => candidate.id === gap.poam);
  return item?.milestones.some((milestone) => milestone.targetDate !== undefined) ? [] : [`gap ${id} has no POA&M target date`];
}

interface RegisterRow { readonly number: number; readonly item: string; readonly state: string; readonly references: References }
function registerRows(text: string): RegisterRow[] {
  return tableUnder(text, 'Verification register').map(([number, item, state, reference]) => ({ number: Number(number), item, state, references: referencesIn(reference ?? '') }));
}

function registerProblems(text: string, context: RecordsContext): string[] {
  const problems: string[] = [];
  for (const row of registerRows(text)) {
    const { records, gaps: gapIds, rules, unknown } = row.references;
    const at = `register row ${row.number}`;
    for (const part of unknown) problems.push(`${at}: unknown reference "${part}"`);
    for (const rule of rules) if (!context.ruleIds.has(rule)) problems.push(`${at}: rule ${rule} does not exist`);
    for (const heading of records) problems.push(...recordProblems(text, heading).map((problem) => `${at}: ${problem}`));
    if (row.state === 'closed' || row.state === 'open') {
      if (row.state === 'closed' && records.length === 0) problems.push(`${at}: closed without a record`);
      if (row.state === 'open' && gapIds.length === 0) problems.push(`${at}: open without a gap`);
      for (const id of gapIds) problems.push(...datedGapProblems(id, context).map((problem) => `${at}: ${problem}`));
    } else if (row.state === 'decided') {
      if (gapIds.length + rules.length === 0) problems.push(`${at}: decided without a gap or rule`);
      for (const id of gapIds) {
        const gap = context.gaps.find((item) => item.id === id);
        if (!gap) problems.push(`${at}: gap ${id} does not exist`);
        else if (gap.ownerRole === '' || gap.closesInPhase !== '48') problems.push(`${at}: gap ${id} does not close in Phase 48 with an owner role`);
      }
    } else problems.push(`${at}: unknown state "${row.state}"`);
  }
  return problems;
}

const recordsText = (): string => readFileSync(RECORDS_FILE, 'utf8');

test('every hosted verification register row resolves to a dated record, a dated gap or a decided gap', () => {
  const text = recordsText();
  assert.ok(registerRows(text).length > 0);
  assert.deepEqual(registerProblems(text, realContext), []);
});
const DESIGN_FILE = path.resolve(root, '..', '.planning', 'research', 'multiuser-hosting', 'DESIGN.md');
// D-24 adds three desk items after DESIGN section 12's rows: the UBI 9 OpenSSL FIPS provider, BC-FIPS, and Harbor and Zot FIPS builds.
const D24_EXTRA_ROWS = 3;
const HOSTED_LEVELS = ['hosted-protected-a', 'hosted-protected-b', 'hosted-itsp-10-171'];
test('the register has one row per DESIGN section 12 item, in order, then the three D-24 desk items', () => {
  const designRows = tableUnder(readFileSync(DESIGN_FILE, 'utf8'), '12. Open risks and what must be verified');
  assert.ok(designRows.length > 0);
  const rows = registerRows(recordsText());
  assert.deepEqual(rows.map((row) => row.number), Array.from({ length: designRows.length + D24_EXTRA_ROWS }, (_, index) => index + 1));
  // The design already decided sign-in strength, the cross-device caveat and the shared relying-party ID (D-26).
  assert.deepEqual(rows.filter((row) => row.state === 'decided').map((row) => row.number), [11, 12, 13]);
});
// The thirteen hosted components (48-01, D-17) plus the two existing components DESIGN section 10 re-assesses.
const HOSTED_COMPONENTS = ['workbench', 'rke2', 'image-registry', 'ingress', 'cert-manager', 'keycloak', 'theia-cloud', 'oauth2-proxy', 'openbao', 'hsm', 'site-storage', 'site-logging', 'offline-bundle'];
const SECTION_10_COMPONENTS = new Set([...HOSTED_COMPONENTS, 'release-pipeline', 'hub']);
// DESIGN section 10 has 18 component rows; split into their separate conditions they are 49 (counted 2026-11-23).
const SECTION_10_CONDITIONS = 49;
const NO_CONDITION = 'no section 10 condition';
const mediumControls = new Set(selectedIds(path.join(root, 'profiles', 'itsp-10-033-01-medium.json')));
interface SectionTenRow { readonly number: number; readonly component: string; readonly condition: string; readonly controls: string[]; readonly references: References }
function sectionTenRows(text: string): SectionTenRow[] {
  return tableUnder(text, 'Section 10 conditions').map(([number, component, condition, , controls, reference]) => ({
    number: Number(number), component, condition, controls: (controls ?? '').split(',').map((item) => item.trim()).filter((item) => item !== ''), references: referencesIn(reference ?? '')
  }));
}
function sectionTenProblems(text: string, context: RecordsContext): string[] {
  const problems: string[] = [];
  for (const row of sectionTenRows(text)) {
    const at = `section 10 row ${row.number}`;
    const { records, gaps: gapIds, rules, none, unknown } = row.references;
    if (!SECTION_10_COMPONENTS.has(row.component)) problems.push(`${at}: unknown component ${row.component}`);
    for (const part of unknown) problems.push(`${at}: unknown reference "${part}"`);
    if (row.condition === NO_CONDITION) {
      if (!none || records.length + gapIds.length + rules.length > 0) problems.push(`${at}: a component with no condition has the reference none`);
      continue;
    }
    if (none || records.length + gapIds.length + rules.length !== 1 || records.length !== 0) problems.push(`${at}: needs exactly one gap or rule`);
    for (const control of row.controls) if (!mediumControls.has(control)) problems.push(`${at}: control ${control} is not in the Medium profile`);
    if (row.controls.length === 0) problems.push(`${at}: names no control`);
    for (const rule of rules) if (!context.ruleIds.has(rule)) problems.push(`${at}: rule ${rule} does not exist`);
    else if (ruleComponents.get(rule) !== row.component) problems.push(`${at}: rule ${rule} belongs to ${ruleComponents.get(rule)}, not ${row.component}`);
    for (const id of gapIds) {
      const gap = context.gaps.find((item) => item.id === id);
      const item = context.poam.find((candidate) => candidate.id === gap?.poam);
      if (!gap) problems.push(`${at}: gap ${id} does not exist`);
      else if (gap.ownerRole === '' || (gap.closesInPhase === undefined && !item?.milestones.length)) problems.push(`${at}: gap ${id} has no owner role and phase or milestone`);
    }
  }
  return problems;
}
test('every DESIGN section 10 condition maps to a hosted component and exactly one gap or rule', () => {
  const rows = sectionTenRows(recordsText());
  assert.equal(rows.filter((row) => row.condition !== NO_CONDITION).length, SECTION_10_CONDITIONS);
  assert.deepEqual(rows.map((row) => row.number), rows.map((_, index) => index + 1));
  assert.deepEqual(sectionTenProblems(recordsText(), realContext), []);
});
test('every hosted component appears in the section 10 table, marked when DESIGN sets no condition', () => {
  const rows = sectionTenRows(recordsText());
  for (const component of HOSTED_COMPONENTS) assert.ok(rows.some((row) => row.component === component), component);
  assert.deepEqual(rows.filter((row) => row.condition === NO_CONDITION).map((row) => row.component), ['offline-bundle']);
});
test('a section 10 row with two references or none fails', () => {
  const header = ['## Section 10 conditions', '', '| # | Component | Condition | Evidence kind | Controls | Reference |', '|---|---|---|---|---|---|'];
  const twice = [...header, '| 1 | keycloak | Events shipped | deployment observation | au-12 | gap G2; gap G321 |', ''].join('\n');
  const missing = [...header, '| 1 | keycloak | Events shipped | deployment observation | au-12 | none |', ''].join('\n');
  assert.deepEqual(sectionTenProblems(twice, realContext), ['section 10 row 1: needs exactly one gap or rule']);
  assert.deepEqual(sectionTenProblems(missing, realContext), ['section 10 row 1: needs exactly one gap or rule']);
  const otherComponent = [...header, '| 1 | keycloak | Events shipped | deployment observation | au-12 | rule rke2.cm-07.no-k3s |', ''].join('\n');
  assert.deepEqual(sectionTenProblems(otherComponent, realContext), ['section 10 row 1: rule rke2.cm-07.no-k3s belongs to rke2, not keycloak']);
});
test('every gap the hosted records add is scoped to the hosted levels', () => {
  const text = recordsText();
  const referenced = new Set([...registerRows(text), ...sectionTenRows(text)].flatMap((row) => row.references.gaps));
  const added = gaps.filter((gap) => referenced.has(gap.id) && Number(gap.id.slice(1)) > 320);
  assert.ok(added.length > 0);
  for (const gap of added) assert.deepEqual(gap.profiles, HOSTED_LEVELS, gap.id);
});
test('a closed register row whose record has no Source line fails', () => {
  const text = recordsText();
  const [closed] = registerRows(text).filter((row) => row.state === 'closed');
  const heading = closed.references.records[0];
  const section = sectionOf(text, heading)!;
  const withoutSource = text.replace(section, section.replace(/^Source: .*$/gm, ''));
  assert.ok(registerProblems(withoutSource, realContext).includes(`register row ${closed.number}: record "${heading}" has no Source line`));
});
test('an open register row whose gap has no POA&M target date fails', () => {
  const text = ['## Verification register', '', '| # | Item | State | Reference |', '|---|---|---|---|', '| 1 | Rig item | open | gap G9001 |', ''].join('\n');
  const gap: Gap = { id: 'G9001', title: 'Rig item', controls: ['sc-05'], remediation: 'Run it.', ownerRole: 'owner', poam: 'g9001' };
  const undated: Poam = { id: 'g9001', gap: 'G9001', controls: ['sc-05'], milestones: [{ phase: '48', title: 'Run it' }] };
  assert.deepEqual(registerProblems(text, { gaps: [gap], poam: [undated], ruleIds }), ['register row 1: gap G9001 has no POA&M target date']);
  const dated: Poam = { ...undated, milestones: [{ phase: '48', targetDate: '2027-03-31', title: 'Run it' }] };
  assert.deepEqual(registerProblems(text, { gaps: [gap], poam: [dated], ruleIds }), []);
});

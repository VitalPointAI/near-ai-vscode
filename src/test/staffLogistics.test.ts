// The logistics server (design 10, 6.2; research note 03, B5, B8 and B12; WP-LOG): the tool names the J4 template grants, safe under the gate, no
// planning factor table shipped, the formula on every result, the calculator ledger that lets guard-scan tell a record the calculator wrote from a file a
// member wrote by hand, the LOGSTAT plausibility rules, notional movement with local routing, and readiness import.
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { LOGISTICS_SERVER, LOGISTICS_TOOL_NAMES, logisticsTools } from '../agent/logisticsTools';
import { HUMAN_ONLY_WORDS } from '../agent/staffTools';
import {
  LOGISTICS_CALCULATOR, LOGISTICS_LOGSTAT, LOGISTICS_LOGSTAT_READ, LOGISTICS_LOGSTAT_VALIDATE, LOGISTICS_MOVEMENT, LOGISTICS_MOVEMENT_READ, LOGISTICS_READINESS
} from '../agent/staff/grants';
import { J4_ROSTERS } from '../agent/staff/j4Members';
import { logstatDefinitionsSkill } from '../agent/staff/j4Skills';
import { j4Vocabulary } from '../agent/staff/j4Vocabulary';
import { parseToolManifest, shorthandFor } from '../domain/gate/manifest';
import { guardScan } from '../domain/staff/guardScan';
import { defaultStaffSettings } from '../domain/staff/profiles';
import {
  bandOf, CALC_LEDGER_FILE, CALCULATOR_RECORD_DIR, checkMovementTable, computeConsumption, consolidateLogstat, FACTORS_EXAMPLE, FACTORS_FILE, formatNumber,
  importReadiness, LOGSTAT_REPORTS_DIR, parseBandSettings, parseFactors, parseLogstatReport, parseRoadGraph, shortestRoute, validateLogstat
} from '../domain/staff/logistics';
import type { CalcRecord, LogstatReport, PlanningFactor } from '../domain/staff/logistics';
import { grantsMcpTool } from '../mcp/tools';
import { STAFF_LEDGER_DIR } from '../staff/logisticsHost';
import { callLogistics, callTool, hashIn, staffWorld, testSigner, writeBody, writeFactors } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';
import type { StaffTeamInfo } from '../staff/staffHost';

const TEAM: StaffTeamInfo = {
  slug: 'j4-logistics', section: 'j4', sectionLead: 'j4-director',
  members: ['j4-director', 'log-plans-officer', 'jloc-chief', 'supply-planner', 'maintenance-planner', 'mobility-planner', 'logstat-analyst', 'release-guard']
};
const STAMP = { computedBy: 'log-plans-officer', run: 'run-1', at: '2026-11-18T12:00:00.000Z' };
const FUEL: PlanningFactor = { id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 250, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' };
const GENERATOR: PlanningFactor = { id: 'fuel-generator', what: 'Fuel for one generator', rate: 50, unit: 'litres', per: 'generator per day', enteredBy: 'A. Demo' };
const RATIONS: PlanningFactor = { id: 'rations-person', what: 'Rations for one person', rate: 3, unit: 'rations', per: 'person per day', enteredBy: 'B. Demo' };
const tool = (name: string) => `mcp__logistics__${name}`;

async function world(): Promise<StaffWorld> {
  const w = await staffWorld();
  await writeFactors(w.root, [FUEL, GENERATOR, RATIONS]);
  return w;
}

const FUEL_CALC = { id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 40, item: 'cargo trucks' }, { factor: 'fuel-generator', count: 10, item: 'generators' }], days: 3, onHand: 21000 };

// ---- The names J4 grants, and the gate -----------------------------------------------------------------------------------------------------------

test('the tools carry exactly the names the J4 template grants, by family, and each J4 member reaches only its own', () => {
  assert.deepEqual([...LOGISTICS_TOOL_NAMES], ['calc_run', 'calc_read', 'calc_list', 'calc_factors', 'logstat_submit', 'logstat_read', 'logstat_validate', 'logstat_consolidate', 'movement_table', 'movement_read', 'movement_route', 'readiness_import', 'readiness_read'].map(tool));
  const reached = (grant: string) => LOGISTICS_TOOL_NAMES.filter((name) => grantsMcpTool([grant], name)).map((name) => name.replace('mcp__logistics__', ''));
  assert.deepEqual(reached(LOGISTICS_CALCULATOR), ['calc_run', 'calc_read', 'calc_list', 'calc_factors']);
  assert.deepEqual(reached(LOGISTICS_LOGSTAT), ['logstat_submit', 'logstat_read', 'logstat_validate', 'logstat_consolidate']);
  assert.deepEqual(reached(LOGISTICS_LOGSTAT_READ), ['logstat_read']);
  assert.deepEqual(reached(LOGISTICS_LOGSTAT_VALIDATE), ['logstat_validate']);
  assert.deepEqual(reached(LOGISTICS_MOVEMENT), ['movement_table', 'movement_read', 'movement_route']);
  assert.deepEqual(reached(LOGISTICS_MOVEMENT_READ), ['movement_read']);
  assert.deepEqual(reached(LOGISTICS_READINESS), ['readiness_import', 'readiness_read']);
  assert.deepEqual(reached(`mcp:${LOGISTICS_SERVER}`).length, LOGISTICS_TOOL_NAMES.length);
  const analyst = J4_ROSTERS.operational.find((member) => member.name === 'logstat-analyst')!;
  assert.deepEqual(LOGISTICS_TOOL_NAMES.filter((name) => grantsMcpTool([...analyst.tools], name)), [tool('logstat_read'), tool('logstat_validate')], 'the analyst validates and reads; it never enters or changes a report');
  // Every logistics tool is reached by some J4 member, so none is dead.
  const all = J4_ROSTERS.operational.flatMap((member) => [...member.tools]);
  for (const name of LOGISTICS_TOOL_NAMES) assert.ok(grantsMcpTool(all, name), name);
});

test('every tool declares a manifest the format accepts, runs on this machine, reaches no host, reads and writes only project files, and decides nothing', () => {
  for (const t of logisticsTools({ host: () => undefined, team: TEAM, run: 'r' })) {
    assert.equal(parseToolManifest(JSON.parse(JSON.stringify(t.manifest))).ok, true, t.name);
    assert.equal(t.manifest.tool, t.name);
    assert.equal(t.manifest.runsOn, 'this-machine');
    assert.deepEqual(t.manifest.hosts, [], `${t.name} reaches no host`);
    for (const effect of t.manifest.effects) assert.ok(['read', 'workspaceWrite'].includes((effect as { verb: string }).verb), `${t.name}: ${(effect as { verb: string }).verb}`);
    assert.equal(shorthandFor(t.manifest), t.capability, t.name);
    for (const word of HUMAN_ONLY_WORDS) assert.ok(!new RegExp(`(^|_)${word}$`, 'i').test(t.name), `${t.name} is a decision verb`);
  }
});

// ---- No factor table shipped ----------------------------------------------------------------------------------------------------------------------

test('no planning factor table is shipped: no factor file in the package, the example has a rate of 0, and with no factor file the calculator refuses', async () => {
  const repo = path.resolve(__dirname, '..', '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? files(full) : [full]; });
  for (const file of files(path.join(repo, 'resources'))) {
    assert.doesNotMatch(path.basename(file), /factor/i, file);
    if (file.endsWith('.json')) assert.doesNotMatch(readFileSync(file, 'utf8'), /"factors"\s*:/, `${file} holds no factor list`);
  }
  const example = parseFactors(FACTORS_EXAMPLE);
  assert.ok(example.ok);
  assert.ok(example.value.every((factor) => factor.rate === 0), 'the example the refusal shows carries no rate');
  // The calculator's own sources carry no rate table: the only factor is the person's.
  for (const name of readdirSync(path.join(repo, 'src', 'domain', 'staff', 'logistics'))) {
    assert.doesNotMatch(readFileSync(path.join(repo, 'src', 'domain', 'staff', 'logistics', name), 'utf8'), /rate:\s*[1-9]/, `${name} ships no rate`);
  }
  const w = await staffWorld();
  const refused = await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer');
  assert.equal(refused.ok, false);
  assert.match(refused.text, /ships none/);
  assert.match(refused.text, new RegExp(FACTORS_FILE.replace(/\./g, '\\.')));
  assert.match((await callLogistics(w, TEAM, 'calc_factors', {})).text, /ships none/);
  assert.equal(computeConsumption(FUEL_CALC, [], STAMP).ok, false, 'no factors, no calculation');
});

test('a rate the agent gives is refused: a line names a factor and a count, and nothing else', () => {
  const result = computeConsumption({ ...FUEL_CALC, lines: [{ factor: 'fuel-cargo-truck', count: 40, rate: 9999 } as never] }, [FUEL], STAMP);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /rates come only from the planning factors a person entered/);
  const unknown = computeConsumption({ ...FUEL_CALC, lines: [{ factor: 'fuel-tank', count: 4 }] }, [FUEL], STAMP);
  assert.ok(!unknown.ok && /no planning factor "fuel-tank".*never use a rate of your own/s.test(unknown.message));
  const mixed = computeConsumption({ ...FUEL_CALC, lines: [{ factor: 'fuel-cargo-truck', count: 1 }, { factor: 'rations-person', count: 1 }] }, [FUEL, RATIONS], STAMP);
  assert.ok(!mixed.ok && /record of its own/.test(mixed.message), 'litres and rations are never added together');
});

// ---- Formulas shown -------------------------------------------------------------------------------------------------------------------------------

test('the formula is shown on every result: rate x count per line, the daily sum, x days, and days of supply, with who entered each factor', async () => {
  const record = computeConsumption(FUEL_CALC, [FUEL, GENERATOR], STAMP);
  assert.ok(record.ok);
  assert.equal(record.value.daily, 10500);
  assert.equal(record.value.total, 31500);
  assert.equal(record.value.daysOfSupply, 2);
  assert.deepEqual(record.value.formula.slice(1), [
    'fuel-cargo-truck: 250 litres per vehicle per day (entered by A. Demo) x 40 cargo trucks = 10,000 litres per day',
    'fuel-generator: 50 litres per generator per day (entered by A. Demo) x 10 generators = 500 litres per day',
    'daily requirement = 10,000 + 500 = 10,500 litres per day',
    'requirement = 10,500 litres per day x 3 days = 31,500 litres',
    'days of supply = 21,000 litres on hand / 10,500 litres per day = 2 days'
  ]);
  assert.equal(formatNumber(1234567.891), '1,234,567.89');

  const w = await world();
  const run = await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer');
  assert.ok(run.ok, run.text);
  for (const line of record.value.formula) assert.ok(run.text.includes(line), `calc_run shows: ${line}`);
  assert.match(run.text, /Recorded calc:fuel-phase-1/);
  const read = await callLogistics(w, TEAM, 'calc_read', { id: 'fuel-phase-1' }, 'supply-planner');
  for (const line of record.value.formula) assert.ok(read.text.includes(line), `calc_read shows: ${line}`);
  assert.match((await callLogistics(w, TEAM, 'calc_list', {})).text, /calc:fuel-phase-1 \(consumption\) Class III \(bulk\) for phase 1; by log-plans-officer/);
  assert.match((await callLogistics(w, TEAM, 'calc_factors', {})).text, /fuel-cargo-truck: Fuel for one cargo truck: 250 litres per vehicle per day \(entered by A\. Demo\)/);

  // The movement check and the readiness import show their working too.
  const table = await callLogistics(w, TEAM, 'movement_table', { id: 'move-1', title: 'Notional reception, phase 1', serials: [SERIAL] }, 'mobility-planner');
  assert.ok(table.ok, table.text);
  assert.match(table.text, /serial 1: lift = 4 HETs x 20 each = 80 against a load of 60 \(in short tons\): enough lift/);
  assert.match(table.text, /serial 1: arrival = 2026-11-19T06:00:00\.000Z \+ 2 h handling \+ 120 km \/ 40 km\/h \(3 h\) = 2026-11-19T11:00:00\.000Z/);
  await writeFile(path.join(w.root, 'readiness.csv'), 'unit,equipment,on_hand,ready,as_of\n1 Bn,cargo truck,40,34,2026-11-18T06:00:00Z\n');
  const imported = await callLogistics(w, TEAM, 'readiness_import', { id: 'ready-1', title: 'Readiness, 18 Nov', path: 'readiness.csv' }, 'maintenance-planner');
  assert.ok(imported.ok, imported.text);
  assert.match(imported.text, /cargo truck: 34 ready \/ 40 on hand = 85 percent/);
});

test('the lead and anyone outside the team cannot record; an id is used once', async () => {
  const w = await world();
  assert.match((await callLogistics(w, TEAM, 'calc_run', FUEL_CALC)).text, /Only a member of this staff team/);
  assert.match((await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'outsider')).text, /Only a member of this staff team/);
  assert.ok((await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer')).ok);
  const again = await callLogistics(w, TEAM, 'calc_run', { ...FUEL_CALC, days: 4 }, 'supply-planner');
  assert.equal(again.ok, false);
  assert.match(again.text, /already exists\. A record never changes; use a new id/);
});

// ---- The calculator ledger and guard-scan ------------------------------------------------------------------------------------------------------

const J4_BODY = (cite: string) => `# Logistics estimate\n\nClass III (bulk) for phase 1: 31,500 litres${cite}.\n\nDECISION FOR: commander. Option A or B, with their risk.\n`;

async function scan(w: StaffWorld, cite: string): Promise<{ ok: boolean; text: string }> {
  await writeBody(w.root, 'j4', 'logistics-estimate', J4_BODY(cite));
  const proposed = await callTool(w, TEAM, 'mcp__staff-products__propose', { product: 'logistics-estimate', kind: 'estimate' }, 'log-plans-officer');
  assert.ok(proposed.ok, proposed.text);
  return callTool(w, TEAM, 'mcp__staff-products__verdict', { product: 'logistics-estimate', gate: 'guard', verdict: 'CLEARED', hash: hashIn(proposed.text) }, 'release-guard');
}

test('guard-scan refuses a calculator record with no ledger entry, and clears one the calculator wrote', async () => {
  const w = await world();
  // A member with Write puts a record file in the folder by hand: it has no ledger entry, so it cannot stand behind a number.
  await mkdir(path.join(w.root, CALCULATOR_RECORD_DIR), { recursive: true });
  const forged = computeConsumption({ ...FUEL_CALC, id: 'fuel-forged' }, [FUEL, GENERATOR], STAMP);
  assert.ok(forged.ok);
  await writeFile(path.join(w.root, CALCULATOR_RECORD_DIR, 'fuel-forged.json'), `${JSON.stringify(forged.value, null, 2)}\n`);
  const held = await scan(w, ' (calc:fuel-forged)');
  assert.equal(held.ok, false);
  assert.match(held.text, /calc:fuel-forged has a file in the calculator folder but no entry in the calculator ledger, so the calculator did not write it/);
  assert.match((await callLogistics(w, TEAM, 'calc_read', { id: 'fuel-forged' })).text, /no entry in the calculator ledger/);
  assert.match((await callLogistics(w, TEAM, 'calc_list', {})).text, /Files the calculator ledger does not vouch for/);

  assert.ok((await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer')).ok);
  const cleared = await scan(w, ' (calc:fuel-phase-1)');
  assert.ok(cleared.ok, cleared.text);
});

test('guard-scan refuses a record changed after the calculator wrote it', async () => {
  const w = await world();
  assert.ok((await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer')).ok);
  const file = path.join(w.root, CALCULATOR_RECORD_DIR, 'fuel-phase-1.json');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"total": 31500', '"total": 61500'));
  const held = await scan(w, ' (calc:fuel-phase-1)');
  assert.equal(held.ok, false);
  assert.match(held.text, /calc:fuel-phase-1 changed after the calculator wrote it/);
});

test('a ledger entry not signed by a trusted key breaks the chain: no record after it is trusted, and nothing more is recorded', async () => {
  const w = await world();
  assert.ok((await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer')).ok);
  // Another key (an agent cannot reach the device key) signs an entry for a hand-made record.
  const { signPayload } = await import('../domain/team/signedPayload');
  const { recordHash, renderRecord } = await import('../domain/staff/logistics');
  const forged = computeConsumption({ ...FUEL_CALC, id: 'fuel-forged' }, [FUEL, GENERATOR], STAMP);
  assert.ok(forged.ok);
  const text = renderRecord(forged.value);
  await writeFile(path.join(w.root, CALCULATOR_RECORD_DIR, 'fuel-forged.json'), text);
  const lines = (await readFile(path.join(w.root, STAFF_LEDGER_DIR, CALC_LEDGER_FILE), 'utf8')).trim().split('\n');
  const { entryDigest } = await import('../domain/staff/ledger');
  const entry = { v: 1, type: 'calculator-record', seq: 1, prev: entryDigest(JSON.parse(lines[0])), at: STAMP.at, run: 'run-1', member: 'log-plans-officer', record: 'fuel-forged', kind: 'consumption', hash: recordHash(text) };
  await appendFile(path.join(w.root, STAFF_LEDGER_DIR, CALC_LEDGER_FILE), `${JSON.stringify(signPayload(testSigner(), 'staff-ledger', entry))}\n`);
  const held = await scan(w, ' (calc:fuel-forged)');
  assert.equal(held.ok, false);
  assert.match(held.text, /calc:fuel-forged has a file in the calculator folder but no entry/);
  assert.match(held.text, /not signed by a key this computer trusts/);
  assert.ok((await scan(w, ' (calc:fuel-phase-1)')).ok, 'the record before the break is still trusted');
  const more = await callLogistics(w, TEAM, 'calc_run', { ...FUEL_CALC, id: 'fuel-phase-2' }, 'log-plans-officer');
  assert.equal(more.ok, false);
  assert.match(more.text, /calculator ledger cannot be trusted from entry 2/);
});

test('guard-scan itself: a record named with a problem is held with that reason; without one, an unknown id names no record', () => {
  const body = 'Class III: 31,500 litres (calc:fuel-x).\nRations: 900 rations (calc:rations-y).\n';
  const result = guardScan({ body, section: 'j4', owner: 'log-plans-officer', config: { realEntities: [], calculatorRecords: new Set(), calculatorProblems: new Map([['fuel-x', 'calc:fuel-x changed after the calculator wrote it.']]) } });
  assert.deepEqual(result.findings.map((finding) => finding.message), ['calc:fuel-x changed after the calculator wrote it.', 'calc:rations-y names no calculator record in this project.']);
  assert.ok(result.hold);
});

// ---- LOGSTAT plausibility rules -----------------------------------------------------------------------------------------------------------------

const FUEL_RECORD = (() => { const r = computeConsumption(FUEL_CALC, [FUEL, GENERATOR], STAMP); assert.ok(r.ok); return r.value; })();
const RECORDS = new Map<string, CalcRecord>([[FUEL_RECORD.id, FUEL_RECORD]]);
const report = (id: string, reportedAt: string, line: Record<string, unknown>, extra: Array<Record<string, unknown>> = []): LogstatReport => {
  const parsed = parseLogstatReport({ id, unit: '1 Bn', reportedAt, lines: [{ commodity: 'Class III (bulk)', uom: 'litres', onHand: 21000, received: 0, consumed: 0, capacity: 30000, forecast: 31500, ...line }, ...extra] });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
};
const rules = (r: LogstatReport, all: LogstatReport[] = [r]) => validateLogstat(r, all, RECORDS).findings.map((finding) => finding.rule);

test('a plausible LOGSTAT passes every rule', () => {
  const first = report('r1', '2026-11-18T00:00:00Z', {});
  const second = report('r2', '2026-11-19T00:00:00Z', { onHand: 15000, received: 4500, consumed: 10500, required: 31500, daysOfSupply: 15000 / 10500, calc: 'fuel-phase-1' });
  assert.deepEqual(rules(first), []);
  const check = validateLogstat(second, [first, second], RECORDS);
  assert.equal(check.passed, true, JSON.stringify(check.findings));
  assert.equal(check.against, 'r1');
});

test('rule 1: on hand below zero or above capacity (no fuel above tank capacity)', () => {
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', { onHand: 31000 })), [1]);
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', { onHand: -5 })), [1]);
  assert.match(validateLogstat(report('r', '2026-11-18T00:00:00Z', { onHand: 31000 }), [], RECORDS).findings[0].message, /above the capacity of 30,000 \(both in litres\)/);
});

test('rule 2: on hand that does not agree with the last report plus received minus consumed is a finding, not a correction', () => {
  const first = report('r1', '2026-11-18T00:00:00Z', {});
  const second = report('r2', '2026-11-19T00:00:00Z', { onHand: 18000, received: 4500, consumed: 10500 });
  const check = validateLogstat(second, [first, second], RECORDS);
  assert.deepEqual(check.findings.map((finding) => finding.rule), [2]);
  assert.match(check.findings[0].message, /which is 15,000\. The difference is 3,000/);
  assert.equal(second.lines[0].onHand, 18000, 'the reported number is left as the unit sent it');
  // A report that failed went back to its unit and is never the baseline: the next one balances against the last that passed.
  const third = report('r3', '2026-11-20T00:00:00Z', { onHand: 15000, received: 4500, consumed: 10500 });
  const after = validateLogstat(third, [first, second, third], RECORDS);
  assert.equal(after.against, 'r1');
  assert.ok(after.passed, JSON.stringify(after.findings));
});

test('rule 3: every commodity has a forecast to 72 hours', () => {
  const r = report('r', '2026-11-18T00:00:00Z', { forecast: undefined });
  assert.deepEqual(rules(r), [3]);
  assert.match(validateLogstat(r, [r], RECORDS).findings[0].message, /forecast to 72 hours/);
});

test('rule 4: a forward unit\'s own needs apart from the bulk it carries for others', () => {
  const carried = { commodity: 'Class III (bulk)', uom: 'litres', onHand: 5000, received: 0, consumed: 0, capacity: 10000, forecast: 0, carriedFor: '2 Bn' };
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', {}, [carried])), [], 'carried stock on its own line is right');
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', {}, [{ ...carried, carriedFor: '1 Bn' }])), [4]);
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', {}, [{ ...carried, carriedFor: undefined }])), [4], 'the same commodity twice for one holder');
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', {}, [{ ...carried, required: 100, calc: 'fuel-phase-1' }])).includes(4), true);
});

test('rule 5: days of supply and required come from a calculator record the ledger vouches for, never the report\'s own arithmetic', () => {
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', { required: 31500 })), [5], 'no record');
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', { required: 31500, calc: 'fuel-unknown' })), [5], 'a record the ledger does not vouch for');
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', { required: 40000, calc: 'fuel-phase-1' })), [5], 'required that disagrees with the record');
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', { daysOfSupply: 5, calc: 'fuel-phase-1' })), [5], 'days of supply of the report\'s own');
  assert.deepEqual(rules(report('r', '2026-11-18T00:00:00Z', { required: 31500, daysOfSupply: 2, calc: 'fuel-phase-1' })), []);
});

test('rule 6 and the bands: a failing report stays out of the consolidation; bands are the person\'s settings and show the numbers behind them', () => {
  const skill = logstatDefinitionsSkill(j4Vocabulary(defaultStaffSettings()));
  assert.deepEqual(parseBandSettings(skill).filter((setting) => setting.amberBelow !== undefined), [], 'the shipped skill sets no band');
  const filled = skill.replace(/^\| Class III: ([^|]*)\|  \|  \|  \|  \|$/m, '| Class III: $1| litres | tank capacity | 80 | 60 |');
  const bands = parseBandSettings(filled);
  const line = report('x', '2026-11-18T00:00:00Z', {}).lines[0];
  assert.equal(bandOf(line, bands), 'AMBER: 70 percent of capacity (on hand 21,000 / capacity 30,000); amber below 80, red below 60 (the project\'s settings)');
  assert.match(bandOf({ ...line, commodity: 'Class II' }, bands), /^no band set; /, 'Class II is not Class III');
  const good = report('good', '2026-11-18T00:00:00Z', {});
  const bad = parseLogstatReport({ ...report('bad', '2026-11-18T00:00:00Z', { onHand: 99999 }), unit: '2 Bn' });
  assert.ok(bad.ok);
  const result = consolidateLogstat([good, bad.value], RECORDS, bands);
  assert.deepEqual(result.rows.map((row) => row.unit), ['1 Bn']);
  assert.deepEqual(result.heldOut, [{ unit: '2 Bn', report: 'bad', rules: [1] }]);
});

test('the LOGSTAT tools: entered as sent, validated by the analyst into the log and its product, consolidated once passing; the report is never changed', async () => {
  const w = await world();
  assert.ok((await callLogistics(w, TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer')).ok);
  const sent = { id: 'bn1-181200z', unit: '1 Bn', reportedAt: '2026-11-18T12:00:00Z', lines: [{ commodity: 'Class III (bulk)', uom: 'litres', onHand: 31000, received: 0, consumed: 0, capacity: 30000, forecast: 31500 }] };
  assert.equal((await callLogistics(w, TEAM, 'logstat_submit', { report: sent }, 'logstat-analyst')).ok, true, 'the grant, not the tool, keeps the analyst from entering reports');
  const file = path.join(w.root, LOGSTAT_REPORTS_DIR, 'bn1-181200z.json');
  const before = await readFile(file, 'utf8');
  assert.match((await callLogistics(w, TEAM, 'logstat_submit', { report: sent }, 'jloc-chief')).text, /already in\. A report is never changed/);
  const validated = await callLogistics(w, TEAM, 'logstat_validate', {}, 'logstat-analyst');
  assert.ok(validated.ok, validated.text);
  assert.match(validated.text, /sent back to 1 Bn/);
  assert.match(validated.text, /rule 1 \(Class III \(bulk\)\): On hand is 31,000, above the capacity of 30,000/);
  assert.equal(await readFile(file, 'utf8'), before, 'validation never touches the report');
  const product = await readFile(path.join(w.root, '.planning/staff/products/j4/logstat-validation-log.md'), 'utf8');
  assert.match(product, /\| Report \| Rule \| Finding \| Sent back to \| Status \|/);
  assert.match(product, /\| bn1-181200z \| 1 \| .* \| 1 Bn \| open/);
  assert.equal(guardScan({ body: product, section: 'j4', owner: 'logstat-analyst', config: { realEntities: [] } }).hold, false, 'the log quotes report figures; it raises no number finding');
  assert.match((await callLogistics(w, TEAM, 'logstat_read', {}, 'supply-planner')).text, /bn1-181200z: 1 Bn, reported .*: findings open \(rules 1\)/);
  assert.match((await callLogistics(w, TEAM, 'logstat_consolidate', {}, 'jloc-chief')).text, /Held out until the unit sends a report that passes \(rule 6\):\n- 1 Bn \(bn1-181200z\): rules 1/);
  // The unit's corrected report, a later one under a new id, passes and is consolidated with its record.
  const corrected = { ...sent, id: 'bn1-181300z', reportedAt: '2026-11-18T13:00:00Z', lines: [{ ...sent.lines[0], onHand: 21000, required: 31500, daysOfSupply: 2, calc: 'fuel-phase-1' }] };
  assert.ok((await callLogistics(w, TEAM, 'logstat_submit', { report: corrected }, 'jloc-chief')).ok);
  const second = await callLogistics(w, TEAM, 'logstat_validate', {}, 'logstat-analyst');
  assert.match(second.text, /bn1-181300z \(1 Bn\): passes every rule/);
  const consolidated = await callLogistics(w, TEAM, 'logstat_consolidate', {}, 'jloc-chief');
  assert.match(consolidated.text, /\| 1 Bn \| Class III \(bulk\) \| litres \| 21,000 \|.*\| passed \(bn1-181300z\) \| calc:fuel-phase-1 \|/);
});

// ---- Movement and routing --------------------------------------------------------------------------------------------------------------------

const SERIAL = { serial: '1', what: 'Bridging stock', mode: 'road', from: 'port-a', to: 'depot-b', load: 60, loadUnit: 'short tons', lift: { asset: 'HETs', count: 4, capacityEach: 20 }, distanceKm: 120, speedKmh: 40, handlingHours: 2, ready: '2026-11-19T06:00:00Z', required: '2026-11-19T12:00:00Z' };

test('the movement check: lift against the load and arrival against the required delivery date; notional only; a revision supersedes', async () => {
  const ok = checkMovementTable({ id: 't1', title: 'Notional table', serials: [SERIAL, { ...SERIAL, serial: '2', load: 100 }, { ...SERIAL, serial: '3', required: '2026-11-19T10:00:00Z' }] }, STAMP);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.serials.map((s) => [s.liftFeasible, s.timeFeasible]), [[true, true], [false, true], [true, false]]);
  assert.equal(ok.value.notional, true);
  const tpfdd = checkMovementTable({ id: 't2', title: 'Imported TPFDD extract', serials: [SERIAL] }, STAMP);
  assert.ok(!tpfdd.ok && /notional movement tables only/.test(tpfdd.message));

  const w = await world();
  assert.ok((await callLogistics(w, TEAM, 'movement_table', { id: 'move-1', title: 'Phase 1', serials: [{ ...SERIAL, load: 100 }] }, 'mobility-planner')).ok);
  assert.match((await callLogistics(w, TEAM, 'movement_read', {}, 'log-plans-officer')).text, /\| 1 \| Bridging stock \|.*\| no: lift short \| calc:move-1 \|/);
  assert.ok((await callLogistics(w, TEAM, 'movement_table', { id: 'move-2', title: 'Phase 1, revised', supersedes: 'move-1', serials: [SERIAL] }, 'mobility-planner')).ok);
  const board = (await callLogistics(w, TEAM, 'movement_read', {}, 'log-plans-officer')).text;
  assert.match(board, /\| yes \| calc:move-2 \|/);
  assert.doesNotMatch(board, /calc:move-1 \|/);
  assert.match(board, /Superseded tables, not shown: move-1\./);
});

test('routing runs on the project\'s road graph only: the shortest open route, around closed roads and avoided nodes', async () => {
  const graph = parseRoadGraph(JSON.stringify({
    nodes: [{ id: 'port-a' }, { id: 'junction-c' }, { id: 'junction-d' }, { id: 'depot-b' }],
    edges: [{ from: 'port-a', to: 'junction-c', km: 30 }, { from: 'junction-c', to: 'depot-b', km: 40, name: 'Coast road' }, { from: 'port-a', to: 'junction-d', km: 20 }, { from: 'junction-d', to: 'depot-b', km: 70 }, { from: 'port-a', to: 'depot-b', km: 10, closed: true }]
  }));
  assert.ok(graph.ok);
  const route = shortestRoute(graph.value, 'port-a', 'depot-b');
  assert.ok(route.ok);
  assert.deepEqual([route.value.nodes, route.value.km], [['port-a', 'junction-c', 'depot-b'], 70]);
  const around = shortestRoute(graph.value, 'port-a', 'depot-b', ['junction-c']);
  assert.ok(around.ok && around.value.km === 90);
  assert.equal(shortestRoute(graph.value, 'port-a', 'depot-b', ['junction-c', 'junction-d']).ok, false);

  const w = await world();
  assert.match((await callLogistics(w, TEAM, 'movement_route', { from: 'port-a', to: 'depot-b' }, 'mobility-planner')).text, /There is no road graph/);
  await mkdir(path.join(w.root, '.planning/staff/logistics'), { recursive: true });
  await writeFile(path.join(w.root, '.planning/staff/logistics/roads.json'), JSON.stringify({ nodes: graph.value.nodes, edges: graph.value.edges }));
  assert.match((await callLogistics(w, TEAM, 'movement_route', { from: 'port-a', to: 'depot-b' }, 'mobility-planner')).text, /distance = 30 \+ 40 = 70 km/);
  const route2 = logisticsTools({ host: () => undefined, team: TEAM, run: 'r' }).find((t) => t.name === tool('movement_route'))!;
  assert.deepEqual(route2.manifest.hosts, []);
});

// ---- Readiness -----------------------------------------------------------------------------------------------------------------------------------

test('readiness: imported from a CSV a person put in the project, refused whole when a row does not add up, stale figures marked', async () => {
  const csv = 'unit,equipment,on_hand,ready,as_of\n1 Bn,cargo truck,40,34,2026-11-18T06:00:00Z\n2 Bn,cargo truck,20,20,2026-11-16T06:00:00Z\n"2 Bn, rear",generator,10,7,2026-11-18T06:00:00Z\n';
  const record = importReadiness({ id: 'r1', title: 'Readiness' }, csv, { file: 'r.csv', sha256: 'x' }, STAMP);
  assert.ok(record.ok);
  assert.deepEqual(record.value.byEquipment.map((entry) => [entry.equipment, entry.ready, entry.onHand]), [['cargo truck', 54, 60], ['generator', 7, 10]]);
  assert.equal(record.value.lines[2].unit, '2 Bn, rear');
  const bad = importReadiness({ id: 'r2', title: 'Readiness' }, csv.replace('40,34', '30,34'), { file: 'r.csv', sha256: 'x' }, STAMP);
  assert.ok(!bad.ok && /Row 2 of r\.csv \(1 Bn, cargo truck\): ready is 34 but on hand is 30/.test(bad.message));

  const w = await world();
  await writeFile(path.join(w.root, 'readiness.csv'), csv);
  const imported = await callLogistics(w, TEAM, 'readiness_import', { id: 'ready-18nov', title: 'Readiness, 18 Nov', path: 'readiness.csv' }, 'maintenance-planner');
  assert.ok(imported.ok, imported.text);
  const board = (await callLogistics(w, TEAM, 'readiness_read', {}, 'maintenance-planner')).text;
  assert.match(board, /\| 2 Bn \| cargo truck \| 20 \| 20 \| 100 percent \| 2026-11-16T06:00:00\.000Z \(stale\) \| calc:ready-18nov \|/);
  assert.match(board, /\| 1 Bn \| cargo truck \| 40 \| 34 \| 85 percent \| 2026-11-18T06:00:00\.000Z \| calc:ready-18nov \|/);
  assert.match((await callLogistics(w, TEAM, 'readiness_import', { id: 'ready-x', title: 'Outside', path: '../outside.csv' }, 'maintenance-planner')).text, /outside|workspace/i);
});

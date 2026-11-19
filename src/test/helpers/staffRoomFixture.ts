// The Staff Room fixture project (WP-ROOM): the IRON LANTERN scenario, the J2 registers, standing watches and adversary COA set from
// test/fixtures/staff-room, a run under way, a J5 plan awaiting the commander's decision and a second plan a person approved. No file of this folder is
// a test suite.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { registerPath } from '../../domain/staff/intel';
import { parseWatch } from '../../domain/staff/obs/watches';
import { watchWording } from '../../domain/staff/obs/watchRun';
import { buildStaffRoomModel } from '../../domain/staff/staffRoom';
import type { StaffRoomModel } from '../../domain/staff/staffRoom';
import { loadStaffRoomInput, SCENARIO_FILE, STANDING_WATCHES_FILE } from '../../staff/staffRoomData';
import { checkMovementTable, computeConsumption, importReadiness } from '../../domain/staff/logistics';
import { registerSchema, renderRegisterBody } from '../../domain/staff/registers';
import type { RegisterRow } from '../../domain/staff/registers';
import { WARGAME_DIR, WARGAME_FILE } from '../../staff/staffHost';
import { callTool, CLEAN_BODY, hashIn, J2_TEAM, J3_TEAM, J4_TEAM, J5_TEAM, staffWorld, writeBody, writeFactors } from './staffFixtures';
import type { StaffWorld } from './staffFixtures';

export const REPO = path.join(__dirname, '..', '..', '..');
export const FIXTURES = path.join(REPO, 'test', 'fixtures', 'staff-room');
export const SCENARIO = path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json');
export const NOW = Date.parse('2026-11-19T12:00:00.000Z');

async function place(root: string, from: string, to: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, to)), { recursive: true });
  await copyFile(from, path.join(root, to));
}

/** A staff project with the IRON LANTERN scenario, the J2 registers and adversary COA set from the fixtures, a run under way and two products. */
export async function project(): Promise<{ world: StaffWorld; awaitingHash: string }> {
  const world = await staffWorld();
  await place(world.root, SCENARIO, SCENARIO_FILE);
  for (const name of ['source-register', 'pir-register', 'collection-plan'] as const) await place(world.root, path.join(FIXTURES, `${name}.json`), registerPath(name));
  await place(world.root, path.join(FIXTURES, 'standing-watches.json'), STANDING_WATCHES_FILE);
  // The named person armed the fixture's watch (a signed decision), so the room shows it as the file says: paused, with its matches kept.
  const register = JSON.parse(await readFile(path.join(FIXTURES, 'standing-watches.json'), 'utf8')) as { entries: unknown[] };
  for (const entry of register.entries) {
    const watch = parseWatch(entry);
    assert.ok(watch.ok, watch.ok ? '' : watch.message);
    const signed = await world.host.signWatchDecision(world.person('K. Sample', 'J2'), { watch: watch.value.id, decision: 'approved', wording: watchWording(watch.value), reasons: [] });
    assert.ok(signed.ok, signed.ok ? '' : signed.message);
  }
  await place(world.root, path.join(FIXTURES, 'adversary-coa-set.md'), '.planning/staff/products/j2/adversary-coa-set.md');
  // The run: the J2 and J5 enter step 3, two members start work, one waits on a person.
  assert.ok((await callTool(world, J2_TEAM, 'mcp__staff-products__step', { step: 3 }, 'j2-chief')).ok);
  assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__step', { step: 3 }, 'lead-planner')).ok);
  await world.host.record({ type: 'staff.lane.started', run: 'run-1', at: '2026-11-19T11:00:00.000Z', section: 'j2', member: 'threat-analyst', product: 'adversary-coa-set' });
  await world.host.record({ type: 'staff.lane.started', run: 'run-1', at: '2026-11-19T11:01:00.000Z', section: 'j5', member: 'lead-planner', product: 'concept-of-operations' });
  await world.host.record({ type: 'staff.lane.finished', run: 'run-1', at: '2026-11-19T11:02:00.000Z', section: 'j2', member: 'watch-officer', product: 'intsum', outcome: 'done' });
  // A J5 plan through the gates to a person's decision, and a second one a person approved.
  await writeBody(world.root, 'j5', 'concept-of-operations', CLEAN_BODY);
  const proposed = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
  const awaitingHash = hashIn(proposed.text);
  assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash: awaitingHash }, 'release-guard')).ok);
  assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: 'concept-of-operations', decisionFor: 'commander', options: [{ label: 'COA 1', risk: 'Moderate risk to the flank' }], dissent: ['The red team holds COA 2 is safer.'], deadline: '2026-11-19T18:00:00.000Z' }, 'lead-planner')).ok);
  await writeBody(world.root, 'j5', 'facts-assumptions', '# Facts and assumptions\n\nThe ford holds a laden vehicle.\n');
  const second = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'facts-assumptions', kind: 'plan' }, 'lead-planner');
  const secondHash = hashIn(second.text);
  assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: 'facts-assumptions', gate: 'guard', verdict: 'CLEARED', hash: secondHash }, 'release-guard')).ok);
  assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: 'facts-assumptions', decisionFor: 'J5 director' }, 'lead-planner')).ok);
  const approved = await world.host.decide(world.person('R. Example', 'J5 director'), { product: 'facts-assumptions', action: 'approve', hash: secondHash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  return { world, awaitingHash };
}

export async function modelOf(world: StaffWorld): Promise<StaffRoomModel> {
  return buildStaffRoomModel(await loadStaffRoomInput(world.host, world.root, NOW));
}

export const SECTIONS = path.join(FIXTURES, 'sections');

/** Proposes a product, clears it through the guard and, with `decisionFor`, submits it for a person's decision. Returns the version hash. */
async function through(world: StaffWorld, team: typeof J5_TEAM, member: string, product: string, kind: string, body: string, decisionFor?: string): Promise<string> {
  await writeBody(world.root, team.section, product, body);
  const proposed = await callTool(world, team, 'mcp__staff-products__propose', { product, kind }, member);
  assert.ok(proposed.ok, proposed.text);
  const hash = hashIn(proposed.text);
  assert.ok((await callTool(world, team, 'mcp__staff-products__verdict', { product, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard')).ok);
  if (decisionFor) assert.ok((await callTool(world, team, 'mcp__staff-products__submit', { product, decisionFor, dissent: product === 'coa-decision-brief' ? ['The red team holds COA B is safer: the beach defences are unknown.'] : [] }, member)).ok);
  return hash;
}

/**
 * The fixture project with the J5, J3 and J4 at work as well (owner direction 2026-11-19): COA themes, validity and comparison, the decision brief
 * waiting for the commander, the wargame ledger, the registers (DSM, sync matrix, annex tracker, event log, CCIR, RFIs, battle rhythm), a FRAGO draft
 * waiting for the J3, and the J4's calculator records, movement, readiness and LOGSTAT reports, all from the files in test/fixtures/staff-room/sections.
 */
export async function sectionsProject(): Promise<{ world: StaffWorld; awaitingHash: string; fragoHash: string; briefHash: string }> {
  const base = await project();
  const world = base.world;
  const read = (name: string) => readFile(path.join(SECTIONS, name), 'utf8');
  for (const name of ['coa-themes', 'coa-validity', 'comparison-matrix'] as const) await writeBody(world.root, 'j5', name, await read(`${name}.md`));
  await writeBody(world.root, 'j4', 'coa-supportability', await read('coa-supportability.md'));
  const registers = JSON.parse(await read('registers.json')) as Record<string, RegisterRow[]>;
  const where: Record<string, 'j3' | 'j5'> = { 'dst-dsm': 'j5', 'sync-matrix': 'j5', 'annex-tracker': 'j5', 'event-log': 'j3', 'ccir-register': 'j3', 'rfi-tracker': 'j3', 'battle-rhythm-calendar': 'j3' };
  for (const [register, rows] of Object.entries(registers)) await writeBody(world.root, where[register], register, renderRegisterBody(registerSchema(register)!, rows));
  await mkdir(path.join(world.root, WARGAME_DIR), { recursive: true });
  await copyFile(path.join(SECTIONS, 'wargame-ledger.jsonl'), path.join(world.root, WARGAME_DIR, WARGAME_FILE));
  // The J5's products in the ledger: the criteria a person approved, the comparison, a COA cell's draft, and the brief waiting for the commander.
  const criteria = await through(world, J5_TEAM, 'design-planner', 'coa-evaluation-criteria', 'register', '# COA evaluation criteria\n\nTempo, sustainability, risk to force.\n', 'commander');
  const approved = await world.host.decide(world.person('C. Example', 'commander'), { product: 'coa-evaluation-criteria', action: 'approve', hash: criteria });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  await through(world, J5_TEAM, 'lead-planner', 'comparison-matrix', 'matrix', await read('comparison-matrix.md'));
  const briefHash = await through(world, J5_TEAM, 'lead-planner', 'coa-decision-brief', 'brief', await read('coa-decision-brief.md'), 'commander');
  await world.host.record({ type: 'staff.lane.started', run: 'run-1', at: '2026-11-19T11:03:00.000Z', section: 'j5', member: 'coa-cell-a', product: 'coa-a' });
  // The J3: a FRAGO draft waiting for a person, and the watch's lane.
  const fragoHash = await through(world, J3_TEAM, 'j3-director', 'frago-1', 'order', '# FRAGO 1\n\n## 1. Situation\n\nNo change.\n', 'J3 director');
  await world.host.record({ type: 'staff.lane.started', run: 'run-1', at: '2026-11-19T11:04:00.000Z', section: 'j3', member: 'joc-chief', product: 'event-log' });
  const triggered = await callTool(world, J3_TEAM, 'mcp__staff-products__register', { action: 'trigger', ccir: 'PIR-1', report: 'Two armoured vehicles moving off Harrow Ridge' }, 'joc-chief');
  assert.ok(triggered.ok, triggered.text);
  // The J4: calculator records through the calculator, LOGSTAT reports as received, the band settings a person filled in.
  await writeFactors(world.root, [{ id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 250, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' }]);
  const logistics = world.host.logistics();
  const factors = await logistics.factors();
  assert.ok(factors.ok);
  assert.ok((await logistics.writeRecord('log-plans-officer', 'run-1', (stamp) => computeConsumption({ id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 14, item: 'cargo trucks' }], days: 3, onHand: 6000 }, factors.ok ? factors.factors : [], stamp))).ok);
  assert.ok((await logistics.writeRecord('mobility-planner', 'run-1', (stamp) => checkMovementTable({ id: 'move-1', title: 'Notional reception, phase 1', serials: [
    { serial: '1', what: 'Bridging stock', mode: 'road', from: 'port-a', to: 'depot-b', load: 60, loadUnit: 'short tons', lift: { asset: 'HETs', count: 4, capacityEach: 20 }, distanceKm: 120, speedKmh: 40, handlingHours: 2, ready: '2026-11-19T06:00:00Z', required: '2026-11-19T12:00:00Z' },
    { serial: '2', what: 'Fuel', mode: 'road', from: 'port-a', to: 'depot-b', load: 100, loadUnit: 'short tons', lift: { asset: 'HETs', count: 4, capacityEach: 20 }, distanceKm: 120, speedKmh: 40, handlingHours: 2, ready: '2026-11-19T06:00:00Z', required: '2026-11-19T10:00:00Z' }
  ] }, stamp))).ok);
  const csv = 'unit,equipment,on_hand,ready,as_of\n1 Bn,cargo truck,40,34,2026-11-19T06:00:00Z\n2 Bn,generator,10,7,2026-11-17T06:00:00Z\n';
  assert.ok((await logistics.writeRecord('maintenance-planner', 'run-1', (stamp) => importReadiness({ id: 'ready-18nov', title: 'Readiness, 19 Nov' }, csv, { file: 'readiness.csv', sha256: '0'.repeat(64) }, stamp))).ok);
  for (const name of ['logstat-bn1.json', 'logstat-bn2.json']) assert.ok((await logistics.submitReport('jloc-chief', JSON.parse(await read(name)))).ok);
  await mkdir(path.join(world.root, '.planning/staff/skills'), { recursive: true });
  await writeFile(path.join(world.root, '.planning/staff/skills/logstat-definitions.md'), await read('logstat-definitions.md'));
  await through(world, J4_TEAM, 'j4-director', 'logistics-annex', 'annex', '# Logistics annex\n\nConcept of support.\n');
  return { world, awaitingHash: base.awaitingHash, fragoHash, briefHash };
}

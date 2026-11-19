// The shared registers and the wargame ledger, through the staff-products tools (design 10, 4.3, 4.5 and 4.6; UX concept 5.7; WP-SHARED): single
// writers and their parts, proposals from everyone else, row checks, RFI and CCIR events, the wargame's phase order, and the sync matrix and DSM derived
// from it. Also the read models built from the events.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { checkRow, parseRegisterBody, REGISTER_SCHEMAS, renderRegisterBody, writeRows } from '../domain/staff/registers';
import { copModel, stepBoard } from '../domain/staff/readModels';
import { deriveFromWargame } from '../domain/staff/wargame';
import type { StaffEvent } from '../domain/staff/events';
import { callTool, J2_TEAM, J3_TEAM, J5_TEAM, readProductFile, staffWorld, unfenced } from './helpers/staffFixtures';

const REGISTER = 'mcp__staff-products__register';
const REGISTER_READ = 'mcp__staff-products__register_read';
const WARGAME = 'mcp__staff-products__wargame';

test('rows are checked against their register: unknown columns, missing ones, values, times and the register\'s own rules', () => {
  // The PIR register has no schema here (its one source is the intel workbench's JSON); the CCIR register's PIR part carries the same checks.
  assert.equal(REGISTER_SCHEMAS['pir-register'], undefined);
  const pir = REGISTER_SCHEMAS['ccir-register'];
  assert.equal(checkRow(pir, { id: 'PIR1', type: 'pir', requirement: 'Where will the reserve go?', status: 'active' }).ok, false, 'a PIR without a decision point and LTIOV');
  assert.equal(checkRow(pir, { id: 'PIR1', type: 'pir', requirement: 'r', decisionPoint: 'DP1', status: 'active' }).ok, false, 'a PIR without an LTIOV');
  assert.ok(checkRow(pir, { id: 'PIR1', type: 'pir', requirement: 'r', decisionPoint: 'DP1', ltiov: '2026-11-19T06:00Z', status: 'active' }).ok);
  assert.equal(checkRow(pir, { id: 'PIR1', type: 'pir', requirement: 'r', decisionPoint: 'DP1', ltiov: 'tomorrow', status: 'active' }).ok, false);
  assert.equal(checkRow(pir, { id: 'PIR1', colour: 'red' }).ok, false);
  const facts = REGISTER_SCHEMAS['facts-assumptions-ledger'];
  assert.equal(checkRow(facts, { id: 'A1', kind: 'assumption', statement: 's', status: 'valid' }).ok, false, 'an assumption needs an invalidation trigger');
  const targets = REGISTER_SCHEMAS['targeting-workbook'];
  assert.equal(checkRow(targets, { id: 'T1', system: 'Notional air defence', function: 'Protects the crossing', legalReview: 'LEGAL REVIEW REQUIRED' }).ok, false, 'both review marks');
  const body = renderRegisterBody(pir, [{ id: 'F1', type: 'ffir', requirement: 'a | b', decisionPoint: 'DP1', status: 'active' }]);
  assert.deepEqual(parseRegisterBody(pir, body), [{ id: 'F1', type: 'ffir', requirement: 'a | b', decisionPoint: 'DP1', status: 'active' }]);
});

test('a part writer may change only its part', () => {
  const ccir = REGISTER_SCHEMAS['ccir-register'];
  const rows = [{ id: 'F1', type: 'ffir', requirement: 'r', decisionPoint: 'DP1', status: 'active' }];
  assert.equal(writeRows(ccir, rows, [], ['F1'], 'pir').ok, false);
  assert.equal(writeRows(ccir, rows, [{ id: 'F2', type: 'ffir', requirement: 'r', decisionPoint: 'DP1', status: 'active' }], [], 'pir').ok, false);
  assert.ok(writeRows(ccir, rows, [{ id: 'P1', type: 'pir', requirement: 'r', decisionPoint: 'DP1', ltiov: '2026-11-19T06:00Z', status: 'active' }], [], 'pir').ok);
});

test('the CCIR register: the J3 director writes it, the J2 requirements manager writes its PIR part, others propose; a trigger is an event', async () => {
  const world = await staffWorld();
  const heard: StaffEvent[] = [];
  world.host.onEvent((event) => heard.push(event));
  const ffir = { id: 'F1', type: 'ffir', requirement: 'Loss of the bridge', decisionPoint: 'DP2', status: 'active', reportTo: 'commander' };
  const created = await callTool(world, J3_TEAM, REGISTER, { action: 'write', register: 'ccir-register', rows: [ffir] }, 'j3-director');
  assert.ok(created.ok, created.text);
  const pir = { id: 'P1', type: 'pir', requirement: 'Will the reserve cross?', decisionPoint: 'DP1', ltiov: '2026-11-19T06:00Z', status: 'proposed' };
  const part = await callTool(world, J2_TEAM, REGISTER, { action: 'write', register: 'ccir-register', part: 'pir', rows: [pir] }, 'requirements-manager');
  assert.ok(part.ok, part.text);
  const state = (await world.host.replay()).products.get('ccir-register')!;
  assert.equal(state.record.version, 2);
  const lastActor = state.history[state.history.length - 1].actor;
  assert.equal(lastActor.kind === 'agent' ? lastActor.member : lastActor.name, 'requirements-manager', 'the part writer is recorded');
  const wrongPart = await callTool(world, J2_TEAM, REGISTER, { action: 'write', register: 'ccir-register', part: 'ffir', rows: [] }, 'requirements-manager');
  assert.equal(wrongPart.ok, false);
  const notWriter = await callTool(world, J3_TEAM, REGISTER, { action: 'write', register: 'ccir-register', rows: [ffir] }, 'joc-chief');
  assert.equal(notWriter.ok, false);
  const proposal = await callTool(world, J3_TEAM, REGISTER, { action: 'propose', register: 'ccir-register', rows: [{ ...ffir, id: 'F9' }], note: 'From the JOC' }, 'joc-chief');
  assert.ok(proposal.ok, proposal.text);
  assert.equal((await readdir(path.join(world.root, '.planning/staff/proposals/ccir-register'))).length, 1);
  const read = await callTool(world, J3_TEAM, REGISTER_READ, { register: 'ccir-register' }, 'joc-chief');
  assert.equal((JSON.parse(unfenced(read.text, REGISTER_READ)) as { rows: unknown[] }).rows.length, 2);
  const trigger = await callTool(world, J3_TEAM, REGISTER, { action: 'trigger', ccir: 'F1', report: 'Bridge reported down at 0400' }, 'joc-chief');
  assert.ok(trigger.ok, trigger.text);
  assert.equal(heard.filter((event) => event.type === 'staff.ccir.triggered').length, 1);
  assert.match(await readProductFile(world.root, 'j3', 'ccir-register'), /\| P1 \| pir \|/);
});

test('the RFI tracker: a new RFI is opened, an answer answers it, and one past its suspense is overdue once', async () => {
  const world = await staffWorld();
  const heard: StaffEvent[] = [];
  world.host.onEvent((event) => heard.push(event));
  const rfi = { id: 'RFI-1', from: 'j5', to: 'j2', question: 'Bridge class?', suspense: '2026-11-18T12:00:10Z', status: 'open' };
  assert.ok((await callTool(world, J3_TEAM, REGISTER, { action: 'write', register: 'rfi-tracker', rows: [rfi] }, 'liaison-coordinator')).ok);
  assert.deepEqual(heard.filter((event) => event.type.startsWith('staff.rfi')).map((event) => event.type), ['staff.rfi.opened']);
  world.clock.now += 60_000;
  await callTool(world, J3_TEAM, REGISTER_READ, { register: 'rfi-tracker' }, 'liaison-coordinator');
  await callTool(world, J3_TEAM, REGISTER_READ, { register: 'rfi-tracker' }, 'liaison-coordinator');
  assert.equal(heard.filter((event) => event.type === 'staff.rfi.overdue').length, 1, 'overdue is sent once');
  assert.ok((await callTool(world, J3_TEAM, REGISTER, { action: 'write', register: 'rfi-tracker', rows: [{ ...rfi, status: 'answered', answer: 'Class 60' }] }, 'liaison-coordinator')).ok);
  assert.equal(heard.filter((event) => event.type === 'staff.rfi.answered').length, 1);
});

test('the wargame: phases in order, each side moving only in its phase, each phase one event; derive writes the sync matrix and the DSM', async () => {
  const world = await staffWorld();
  const heard: StaffEvent[] = [];
  world.host.onEvent((event) => heard.push(event));
  const phase = (turn: number, name: string, extra: Record<string, unknown> = {}) => ({ coa: 'coa-1', enemyCoa: 'enemy-mlcoa', turn, phase: name, hHourOffsetMinutes: turn * 60, ...extra });
  const outOfOrder = await callTool(world, J5_TEAM, WARGAME, { action: 'record', phase: phase(1, 'reaction') }, 'plans-writer');
  assert.equal(outOfOrder.ok, false);
  assert.match(outOfOrder.text, /turn 1 ACTION/);
  assert.ok((await callTool(world, J5_TEAM, WARGAME, { action: 'record', phase: phase(1, 'action', { moves: [{ unit: '1st notional brigade', path: [[0, 0], [1, 1]] }] }) }, 'plans-writer')).ok);
  const wrongSide = await callTool(world, J5_TEAM, WARGAME, { action: 'record', phase: phase(1, 'reaction', { moves: [{ unit: 'x', side: 'friendly' }] }) }, 'plans-writer');
  assert.equal(wrongSide.ok, false);
  assert.ok((await callTool(world, J5_TEAM, WARGAME, { action: 'record', phase: phase(1, 'reaction', { moves: [{ unit: 'Adversary reserve', path: [[2, 2]] }], decisionPoints: [{ id: 'DP1', description: 'Commit the reserve', decisionMaker: 'commander', indicator: 'Reserve crosses', nai: 'NAI 3', pir: 'P1' }], branches: ['Reserve crosses early'] }) }, 'plans-writer')).ok);
  assert.ok((await callTool(world, J5_TEAM, WARGAME, { action: 'record', phase: phase(1, 'counteraction', { sync: [{ row: 'fires', entry: 'Fires on NAI 3' }] }) }, 'plans-writer')).ok);
  assert.equal(heard.filter((event) => event.type === 'staff.wargame.turn').length, 3);
  const notWriter = await callTool(world, J5_TEAM, WARGAME, { action: 'derive' }, 'plans-writer');
  assert.match(notWriter.text, /rows for its writer, lead-planner/);
  const derived = await callTool(world, J5_TEAM, WARGAME, { action: 'derive' }, 'lead-planner');
  assert.ok(derived.ok, derived.text);
  assert.match(derived.text, /sync-matrix: 4 rows written/);
  assert.match(derived.text, /Reserve crosses early/);
  const dsm = await readProductFile(world.root, 'j5', 'dst-dsm');
  assert.match(dsm, /\| DP1 \| Commit the reserve \| Reserves? crosses \| NAI 3 \| P1 \|/);
  const products = deriveFromWargame(await world.host.wargameEntries());
  assert.deepEqual(products.sync.map((row) => row.row), ['manoeuvre', 'enemy', 'decision-points', 'fires']);
});

test('read models: the step board follows steps, lanes, waiting and merges, and the COP keeps each layer\'s last update', async () => {
  const world = await staffWorld();
  assert.ok((await callTool(world, J2_TEAM, 'mcp__staff-products__step', { step: 2 })).ok, 'the lead may mark a step');
  await world.host.record({ type: 'staff.lane.started', run: 'run-1', at: '2026-11-18T12:00:00.000Z', section: 'j2', member: 'threat-analyst' });
  await world.host.record({ type: 'staff.lane.started', run: 'run-1', at: '2026-11-18T12:00:01.000Z', section: 'j2', member: 'watch-officer' });
  await world.host.record({ type: 'staff.lane.finished', run: 'run-1', at: '2026-11-18T12:00:02.000Z', section: 'j2', member: 'watch-officer', outcome: 'done' });
  await world.host.record({ type: 'staff.merge.started', run: 'run-1', at: '2026-11-18T12:00:03.000Z', section: 'j2', branches: ['a'], files: ['x'] });
  await world.host.record({ type: 'staff.cop.updated', run: 'run-1', at: '2026-11-18T12:00:04.000Z', layer: 'cop-threat-layer', owner: { section: 'j2', member: 'threat-analyst' }, featureCount: 3, summary: 's' });
  await world.host.emit([{ type: 'staff.waiting', run: 'run-1', at: '2026-11-18T12:00:05.000Z', section: 'j2', member: 'threat-analyst', waitingOn: 'j5', what: 'friendly COAs' }]);
  await assert.rejects(world.host.record({ type: 'staff.product.state' } as unknown as StaffEvent), /written by the staff-products host itself/);
  const events = await world.host.events();
  const board = stepBoard(events, 'run-1', []);
  assert.equal(board.sections[0].step, 2);
  assert.deepEqual(board.sections[0].lanes.map((lane) => `${lane.member}:${lane.status}`), ['threat-analyst:waiting', 'watch-officer:done']);
  assert.equal(board.sections[0].merge, 'merging');
  assert.equal(copModel(events).layers[0].featureCount, 3);
  const snapshot = await world.host.snapshot('run-1');
  assert.deepEqual(snapshot.steps, { j2: 2 });
});

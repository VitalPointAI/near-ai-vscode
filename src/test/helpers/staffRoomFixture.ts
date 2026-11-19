// The Staff Room fixture project (WP-ROOM): the IRON LANTERN scenario, the J2 registers, standing watches and adversary COA set from
// test/fixtures/staff-room, a run under way, a J5 plan awaiting the commander's decision and a second plan a person approved. No file of this folder is
// a test suite.
import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { registerPath } from '../../domain/staff/intel';
import { buildStaffRoomModel } from '../../domain/staff/staffRoom';
import type { StaffRoomModel } from '../../domain/staff/staffRoom';
import { loadStaffRoomInput, SCENARIO_FILE, STANDING_WATCHES_FILE } from '../../staff/staffRoomData';
import { callTool, CLEAN_BODY, hashIn, J2_TEAM, J5_TEAM, staffWorld, writeBody } from './staffFixtures';
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

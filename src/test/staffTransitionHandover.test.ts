// The J5 to J3 handover at transition (design 10, 3.4 step 7; drop 2): the J5 makes the DST and DSM and the synchronization matrix in planning, and once
// a named person approves the transition brief the J3's future operations planner writes them, in place, in the J5 folder the ledger recorded. The J5
// then proposes, like any other contributor. The phase is read from the signed ledger, so it holds after a reload.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { j3Template } from '../agent/staff/j3Operations';
import { handsOverAtTransition } from '../domain/staff/ownership';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { staffProductPath } from '../domain/staff/writeLimits';
import type { StaffTeamInfo } from '../staff/staffHost';
import { callTool, CLEAN_BODY, hashIn, J5_TEAM, staffWorld, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const PROPOSE = 'mcp__staff-products__propose';
const VERDICT = 'mcp__staff-products__verdict';
const SUBMIT = 'mcp__staff-products__submit';
const STATUS = 'mcp__staff-products__status';
const REGISTER = 'mcp__staff-products__register';

const roster = j3Template({ settings: defaultStaffSettings() }).members.map((member) => member.name);
const J3: StaffTeamInfo = { slug: 'j3-operations', section: 'j3', sectionLead: 'j3-director', members: roster };

const DSM = [{ id: 'DP1', description: 'Commit the reserve', indicator: 'Bridge 4 down', nai: 'NAI 3', recommendedAction: 'Branch B1', decisionMaker: 'commander' }];
const SYNC = [{ id: 'S1', row: 'manoeuvre', hHourOffsetMinutes: 60, entry: 'TF ANVIL crosses PL BLUE', section: 'j3' }];

async function hashOf(world: StaffWorld, product: string): Promise<string> {
  return (await world.host.replay()).products.get(product)!.record.hash;
}

/** A person approves the J3's transition brief: the one act that moves the project into execution. */
async function approveTransition(world: StaffWorld): Promise<void> {
  await writeBody(world.root, 'j3', 'transition-brief', CLEAN_BODY);
  const proposed = await callTool(world, J3, PROPOSE, { product: 'transition-brief', kind: 'brief' }, 'future-ops-planner');
  assert.ok(proposed.ok, proposed.text);
  const hash = hashIn(proposed.text);
  assert.ok((await callTool(world, J3, VERDICT, { product: 'transition-brief', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard')).ok);
  assert.ok((await callTool(world, J3, SUBMIT, { product: 'transition-brief', decisionFor: 'J-3 director', options: [{ label: 'Accept', risk: 'Low' }] }, 'j3-director')).ok);
  const accepted = await world.host.decide(world.person('A. Demo', 'J-3 director'), { product: 'transition-brief', action: 'approve', hash });
  assert.ok(accepted.ok, accepted.ok ? '' : accepted.message);
}

test('the DST and DSM, the sync matrix and the assessment plan hand over at transition; the other shared products keep one writer', () => {
  assert.ok(handsOverAtTransition('dst-dsm'));
  assert.ok(handsOverAtTransition('sync-matrix'));
  assert.ok(handsOverAtTransition('assessment-plan'));
  for (const product of ['ccir-register', 'facts-assumptions-ledger', 'event-log', 'battle-rhythm-calendar', 'cop', 'not-shared']) assert.equal(handsOverAtTransition(product), false, product);
});

test('planning: the J5 writes the DSM and the sync matrix and the J3 is refused; after a person approves the transition brief the J3 writes them in place and the J5 is refused, also after a reload', async () => {
  const world = await staffWorld();
  // Planning: the J5 lead-planner makes both, in the J5 folder.
  const dsm = await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'dst-dsm', rows: DSM }, 'lead-planner');
  assert.ok(dsm.ok, dsm.text);
  const sync = await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'sync-matrix', rows: SYNC }, 'lead-planner');
  assert.ok(sync.ok, sync.text);
  const j5File = path.join(world.root, staffProductPath('j5', 'dst-dsm'));
  assert.ok(existsSync(j5File));
  const early = await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: DSM }, 'future-ops-planner');
  assert.equal(early.ok, false);
  assert.match(early.text, /dst-dsm is written by lead-planner\. Propose your rows with the propose action instead\. It passes to the J3 when a person approves the transition brief\./);
  assert.match((await callTool(world, J3, PROPOSE, { product: 'dst-dsm', kind: 'matrix' }, 'future-ops-planner')).text, /shared product with one writer \(lead-planner in j5\)/);

  // The J5's DSM is approved by a person in planning; the sync matrix is still a draft when the brief is approved.
  const dsmHash = await hashOf(world, 'dst-dsm');
  assert.ok((await callTool(world, J5_TEAM, VERDICT, { product: 'dst-dsm', gate: 'guard', verdict: 'CLEARED', hash: dsmHash }, 'release-guard')).ok);
  assert.ok((await callTool(world, J5_TEAM, SUBMIT, { product: 'dst-dsm', decisionFor: 'commander' }, 'j5-chief')).ok);
  const approved = await world.host.decide(world.person(), { product: 'dst-dsm', action: 'approve', hash: dsmHash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);

  await approveTransition(world);

  // Execution: the J3's future operations planner writes the DSM, in the J5 folder the ledger recorded, as a new version it owns.
  const written = await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: [{ ...DSM[0], recommendedAction: 'Branch B2' }] }, 'future-ops-planner');
  assert.ok(written.ok && /version 2 recorded/.test(written.text), written.text);
  const state = (await world.host.replay()).products.get('dst-dsm')!;
  assert.equal(state.record.section, 'j5', 'the file stays where the ledger recorded it');
  assert.equal(state.record.roles.owner, 'future-ops-planner');
  assert.equal(state.record.roles.sectionLead, 'j3-director', 'the J3 integrator submits the new version');
  assert.equal(existsSync(path.join(world.root, staffProductPath('j3', 'dst-dsm'))), false, 'no second copy in the J3 folder');
  assert.match(await (await import('node:fs/promises')).readFile(j5File, 'utf8'), /Branch B2/);
  // The J3's own release guard checks the J3's version.
  const cleared = await callTool(world, J3, VERDICT, { product: 'dst-dsm', gate: 'guard', verdict: 'CLEARED', hash: state.record.hash }, 'release-guard');
  assert.ok(cleared.ok && /guard-checked/.test(cleared.text), cleared.text);

  // The J5 is refused and proposes instead.
  const j5Write = await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'dst-dsm', rows: DSM }, 'lead-planner');
  assert.match(j5Write.text, /dst-dsm is written by future-ops-planner\. Propose your rows with the propose action instead\. The J3 writes it since a person approved the transition brief\./);
  assert.match((await callTool(world, J5_TEAM, PROPOSE, { product: 'dst-dsm', kind: 'matrix' }, 'lead-planner')).text, /shared product with one writer \(future-ops-planner in j3\)/);
  const proposal = await callTool(world, J5_TEAM, REGISTER, { action: 'propose', register: 'dst-dsm', rows: DSM, note: 'From the plan' }, 'lead-planner');
  assert.ok(proposal.ok && /proposals\/dst-dsm\//.test(proposal.text), proposal.text);

  // The sync matrix was still open under the J5: the J3 is told how to take it over, and after a person withdraws that version the J3 writes it.
  const open = await callTool(world, J3, REGISTER, { action: 'write', register: 'sync-matrix', rows: SYNC }, 'future-ops-planner');
  assert.match(open.text, /sync-matrix version 1 is still open \(draft\) under lead-planner, who wrote it before the transition\. A person withdraws that version/);
  assert.match(open.text, /The register file is back as it was/);
  const withdrawn = await world.host.decide(world.person(), { product: 'sync-matrix', action: 'withdraw', reasons: ['Handed to the J3 at transition'] });
  assert.ok(withdrawn.ok, withdrawn.ok ? '' : withdrawn.message);
  const taken = await callTool(world, J3, REGISTER, { action: 'write', register: 'sync-matrix', rows: SYNC }, 'future-ops-planner');
  assert.ok(taken.ok && /version 2 recorded/.test(taken.text), taken.text);

  // What a member and a person read: who writes it now, since whose approval, and where the file is.
  const status = await callTool(world, J3, STATUS, { product: 'dst-dsm' }, 'future-ops-planner');
  assert.match(status.text, /Writer now: future-ops-planner \(j3\), since A\. Demo \(J-3 director\) approved the transition brief/);
  assert.match(status.text, /In planning it was lead-planner \(j5\); the file stays at \.planning\/staff\/products\/j5\/dst-dsm\.md/);
  const registers = (await world.host.snapshot()).registers;
  assert.deepEqual(registers.find((entry) => entry.product === 'dst-dsm')?.writer, { section: 'j3', member: 'future-ops-planner' });

  // After a reload the phase is read again from the signed ledger.
  world.reload();
  const again = await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: [{ ...DSM[0], recommendedAction: 'Branch B3' }] }, 'future-ops-planner');
  assert.ok(again.ok, again.text);
  assert.match((await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'sync-matrix', rows: SYNC }, 'lead-planner')).text, /sync-matrix is written by future-ops-planner/);
});

test('an agent cannot move the project into execution: until a person approves the transition brief, the J5 keeps writing and the J3 is refused', async () => {
  const world = await staffWorld();
  assert.ok((await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'dst-dsm', rows: DSM }, 'lead-planner')).ok);
  await writeBody(world.root, 'j3', 'transition-brief', CLEAN_BODY);
  const proposed = await callTool(world, J3, PROPOSE, { product: 'transition-brief', kind: 'brief' }, 'future-ops-planner');
  const hash = hashIn(proposed.text);
  assert.ok((await callTool(world, J3, VERDICT, { product: 'transition-brief', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard')).ok);
  assert.ok((await callTool(world, J3, SUBMIT, { product: 'transition-brief', decisionFor: 'J-3 director' }, 'j3-director')).ok);
  // Awaiting a person: still planning.
  assert.match((await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: DSM }, 'future-ops-planner')).text, /written by lead-planner/);
  const j5 = await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'dst-dsm', rows: [{ ...DSM[0], recommendedAction: 'Branch B2' }] }, 'lead-planner');
  assert.ok(j5.ok && /recorded/.test(j5.text), j5.text);
  // A rejected brief keeps it in planning too.
  const rejected = await world.host.decide(world.person('A. Demo', 'J-3 director'), { product: 'transition-brief', action: 'reject', reasons: ['Not yet'] });
  assert.ok(rejected.ok);
  assert.match((await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: DSM }, 'future-ops-planner')).text, /written by lead-planner/);
});

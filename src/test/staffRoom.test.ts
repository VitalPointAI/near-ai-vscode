// The Staff Room's host side (WP-ROOM): the picture built from a real staff project (a signed ledger, the event log, the scenario and the J2 registers
// read from fixture files), every message from the page validated, decision buttons that reach only the person-only staff commands, and a person's
// decision shown only when the signed ledger holds it.
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { PERSON_DECISION_COMMANDS, STAFF_COMMANDS } from '../domain/staff/commands';
import type { StaffEvent } from '../domain/staff/events';
import { parseScenarioText } from '../domain/staff/scenario';
import { buildStaffRoomModel, decisionBacked, decisionCommand, handoffsFor, parseStaffRoomMessage, STAFF_ROOM_WORKSPACES } from '../domain/staff/staffRoom';
import { buildStaffMap, estimativeLanguage, unitIcon } from '../domain/staff/staffRoomMap';
import { EVENTS_FILE, LEDGER_DIR } from '../staff/staffHost';
import { ENEMY_COA_PRODUCTS, loadStaffRoomInput } from '../staff/staffRoomData';
import { handleStaffRoomMessage, STAFF_ROOM_OPEN_COMMANDS } from '../staff/staffRoomHost';
import { staffWorld } from './helpers/staffFixtures';
import { modelOf, NOW, project, SCENARIO } from './helpers/staffRoomFixture';

test('the room is built from the real project: rail states, squads, ledger, decisions and the one clock', async () => {
  const { world, awaitingHash } = await project();
  const model = await modelOf(world);
  assert.equal(model.v, 1);
  assert.equal(model.run, 'run-1');
  assert.equal(model.operation.title, 'Exercise IRON LANTERN');
  assert.match(model.operation.marking, /UNCLASSIFIED \/\/ EXERCISE/);
  // Rail: steps 1 and 2 done; step 3 has the J2 and J5 on it and waits for a named person, because a J5 product awaits a decision; step 4 next.
  const status = Object.fromEntries(model.rail.map((step) => [step.step, step.status]));
  assert.deepEqual([status[1], status[2], status[3], status[4], status[5]], ['done', 'done', 'waiting', 'next', 'todo']);
  const three = model.rail.find((step) => step.step === 3)!;
  assert.equal(three.statusText, 'Waiting for a named person');
  assert.deepEqual(three.sections.map((section) => section.id).sort(), ['j2', 'j5']);
  assert.ok(three.sections.every((section) => section.working));
  assert.equal(model.rail.find((step) => step.step === 6)!.human, true);
  assert.ok(model.rail.every((step) => step.name.length > 0));
  // Squads: the chief of staff cell, J2, J5, J3, J4, with live agent states from the run.
  assert.deepEqual(model.squads.map((squad) => squad.section), ['command', 'j2', 'j5', 'j3', 'j4']);
  const j2 = model.squads.find((squad) => squad.section === 'j2')!;
  assert.equal(j2.members.find((member) => member.id === 'threat-analyst')!.state, 'working');
  assert.equal(j2.members.find((member) => member.id === 'watch-officer')!.state, 'done');
  assert.equal(j2.tag, 'running');
  // The person shown on the J5 squad is the one the signed ledger holds.
  assert.equal(model.squads.find((squad) => squad.section === 'j5')!.person, 'R. Example (J5 director)');
  // Ledger: newest first, display words from the release state machine, each with its provenance.
  const plan = model.ledger.find((row) => row.product === 'concept-of-operations')!;
  assert.equal(plan.display, 'awaiting decision');
  assert.equal(plan.hash, awaitingHash);
  assert.deepEqual(plan.gates.map((gate) => `${gate.gate} ${gate.verdict}`), ['Release-guard CLEARED']);
  assert.ok(plan.history.length >= 3);
  assert.equal(model.ledger.find((row) => row.product === 'facts-assumptions')!.approvedBy, 'R. Example (J5 director)');
  // Decisions: one to approve or reject, with its options, dissent and deadline; one approved product to release.
  const decide = model.decisions.find((card) => card.product === 'concept-of-operations')!;
  assert.equal(decide.kind, 'decide');
  assert.equal(decide.hash, awaitingHash);
  assert.deepEqual(decide.dissent, ['The red team holds COA 2 is safer.']);
  assert.equal(decide.options[0].label, 'COA 1');
  assert.equal(model.decisions.find((card) => card.product === 'facts-assumptions')!.kind, 'release');
  // One clock: the next decision deadline.
  assert.match(model.clock.dtg, /^191200Z NOV 26$/);
  assert.match(model.clock.next!.label, /Concept of operations decision due, for the commander/);
  assert.equal(model.coming.j5.lines.length >= 3, true);
  assert.deepEqual([...STAFF_ROOM_WORKSPACES], ['war-room', 'j2', 'j5', 'j3', 'j4']);
});

test('the J2 workspace shows the registers and products read from the fixture files', async () => {
  const { world } = await project();
  const model = await modelOf(world);
  const j2 = model.j2;
  assert.deepEqual(j2.problems, []);
  // Enemy COA overlays from the adversary COA set: likelihood and confidence kept apart, drawn as axes on the map.
  assert.deepEqual(j2.ecoas.map((coa) => coa.term), ['MLCOA', 'MDCOA']);
  const ml = j2.ecoas[0];
  assert.equal(ml.likelihood!.term, 'likely');
  assert.equal(ml.likelihood!.range, '55 to 80 percent');
  assert.match(ml.confidence!, /moderate confidence/);
  assert.equal(j2.ecoas[1].likelihood!.term, 'unlikely');
  assert.ok(model.map.ecoas.every((coa) => coa.points.length >= 2));
  // Enemy units with their grades, from the scenario's reports.
  const unit = j2.enemy.find((entry) => entry.designation === '1-41 MECH')!;
  assert.equal(unit.grade, 'B2');
  assert.match(unit.gradeWords, /usually reliable.*probably true/);
  assert.equal(j2.enemy.find((entry) => entry.designation === 'U-1')!.affiliation, 'Unknown');
  // The source register, with grades kept as two fields and corroboration by origin.
  assert.deepEqual(j2.sources.map((source) => source.grade), ['B2', 'B3']);
  assert.ok(j2.sources.every((source) => source.confirmed));
  assert.ok(j2.reports.length > 5);
  // PIRs, each linked to its decision point and the NAIs its collection covers.
  const pir = j2.pirs.find((entry) => entry.id === 'PIR-1')!;
  assert.equal(pir.decisionPoint, 'DP 2: commit the reserve');
  assert.deepEqual(pir.nais, ['NAI 2']);
  assert.equal(pir.ltiovPassed, false);
  // The collection plan: recommendations only, with who must approve.
  assert.deepEqual(j2.collection.map((entry) => entry.needs), ['Needs J3 approval', 'Needs a partner']);
  assert.match(j2.collection[0].indicator, /Armour moving/);
  // The standing watch, paused with its reason and the matches kept for the person.
  assert.equal(j2.watches[0].state, 'paused');
  assert.match(j2.watches[0].stateText, /no person has the staff run open/);
  assert.equal(j2.watches[0].missed, 2);
  assert.equal(j2.watches[0].alert, 'K. Sample (J2)');
  assert.ok(ENEMY_COA_PRODUCTS.includes('adversary-coa-set'));
});

test('the map is driven by the scenario\'s exercise frame and the COP layer read model', async () => {
  const scenario = parseScenarioText(await readFile(SCENARIO, 'utf8'));
  assert.ok(scenario.ok);
  const map = buildStaffMap({ scenario: scenario.value, cop: { layers: [{ layer: 'cop-threat-layer', owner: { section: 'j2', member: 'threat-analyst' }, updatedAt: '2026-11-19T10:00:00.000Z', featureCount: 7 }], eventTail: [] } });
  assert.equal(map.available, true);
  assert.equal(map.grid.name, 'KQ');
  assert.equal(map.frame!.axis, 'northings-increase-north');
  // Northings grow north: Port Calder (KQ 4636) is drawn above Saltmere (KQ 4315).
  const y = (name: string) => map.features.find((feature) => feature.name === name)!.points[0][1];
  assert.ok(y('Port Calder') < y('Saltmere'));
  // Affiliation by party side, units placed from grid references, far-off forces listed rather than drawn.
  const hq = map.units.find((unit) => unit.designation === '41 CSTL BDE')!;
  assert.equal(hq.affiliation, 'H');
  assert.equal(hq.grid, 'KQ 4736');
  assert.equal(hq.hq, true);
  assert.equal(hq.layer, 'cop-threat-layer');
  assert.equal(map.units.find((unit) => unit.designation === 'TF ANVIL')!.affiliation, 'F');
  assert.ok(map.offMap.some((unit) => unit.designation === 'AIR DET LARK'));
  assert.ok(map.graphics.some((graphic) => graphic.kind === 'nai' && graphic.name === 'NAI 1'));
  assert.ok(map.land.startsWith('M'));
  // Layers: one writer each, the COP's reported count beside what is drawn.
  const threat = map.layers.find((layer) => layer.id === 'cop-threat-layer')!;
  assert.deepEqual(threat.owner, { section: 'j2', member: 'threat-analyst' });
  assert.equal(threat.reported, 7);
  assert.equal(map.layers.find((layer) => layer.id === 'cop-operations-layer')!.owner.member, 'joc-chief');
  // No scenario: no map, and the reason in words.
  const none = buildStaffMap({ cop: { layers: [], eventTail: [] } });
  assert.equal(none.available, false);
  assert.match(none.reason!, /No exercise scenario/);
  assert.equal(unitIcon('Armour company'), 'arm');
  assert.equal(unitIcon('Mechanized infantry battalion'), 'mech');
  assert.deepEqual(estimativeLanguage('It will very likely hold. We have high confidence.'), { likelihood: { term: 'very likely', range: '80 to 95 percent' }, confidence: 'We have high confidence.' });
});

test('every message from the page is validated: type, exact keys and the form of each value', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(parseStaffRoomMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseStaffRoomMessage({ type: 'decide', action: 'approve', product: 'intel-estimate', hash }), { type: 'decide', action: 'approve', product: 'intel-estimate', hash });
  for (const bad of [
    null, 'ready', [], { type: 'ready', extra: 1 }, { type: 'decide', action: 'sign', product: 'x', hash }, { type: 'decide', action: 'approve', product: '../etc', hash },
    { type: 'decide', action: 'approve', product: 'x', hash: 'short' }, { type: 'decide', action: 'approve', product: 'x', hash, person: { name: 'Me' } },
    { type: 'decide', action: 'withdraw', product: 'x', hash }, { type: 'approve', product: 'x' }, { type: 'release', product: 'x' }, { type: 'open', target: 'nearAi.staff.approveProduct' },
    { type: 'select-run', run: 'bad run!' }, { type: 'open-product', product: 'A B' }, { type: 'run-command', command: 'nearAi.staff.approveProduct' }
  ]) assert.equal(parseStaffRoomMessage(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(parseStaffRoomMessage({ type: 'open', target: 'team-live' }), { type: 'open', target: 'team-live' });
});

test('decision buttons reach only the person-only staff commands, for the product and version the person saw', async () => {
  const { world, awaitingHash } = await project();
  const model = await modelOf(world);
  const calls: Array<{ command: string; args?: unknown }> = [];
  const notices: string[] = [];
  const effects = {
    model: () => model, runCommand: async (command: string, args?: unknown) => { calls.push({ command, args }); },
    openFile: async (file: string) => { calls.push({ command: 'open-file', args: file }); }, selectRun: () => undefined, refresh: () => undefined, notice: (text: string) => { notices.push(text); }
  };
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'approve', product: 'concept-of-operations', hash: awaitingHash }, effects), 'done');
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'reject', product: 'concept-of-operations', hash: awaitingHash }, effects), 'done');
  const release = model.decisions.find((card) => card.kind === 'release')!;
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'release', product: release.product, hash: release.hash }, effects), 'done');
  assert.deepEqual(calls, [
    { command: STAFF_COMMANDS.approve, args: { product: 'concept-of-operations', hash: awaitingHash } },
    { command: STAFF_COMMANDS.reject, args: { product: 'concept-of-operations', hash: awaitingHash } },
    { command: STAFF_COMMANDS.release, args: { product: release.product, hash: release.hash } }
  ]);
  // Refused: a stale version, an action that does not fit, a product not waiting, and anything malformed. Nothing runs.
  calls.length = 0;
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'approve', product: 'concept-of-operations', hash: 'b'.repeat(64) }, effects), 'refused');
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'release', product: 'concept-of-operations', hash: awaitingHash }, effects), 'refused');
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'approve', product: release.product, hash: release.hash }, effects), 'refused');
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'approve', product: 'not-there', hash: awaitingHash }, effects), 'refused');
  assert.equal(await handleStaffRoomMessage({ type: 'decide', action: 'approve', product: 'concept-of-operations', hash: awaitingHash, by: 'agent' }, effects), 'ignored');
  assert.deepEqual(calls, []);
  assert.equal(notices.length, 4);
  // Every command any message can run: the three person decisions, and links that decide nothing.
  for (const card of model.decisions) for (const action of ['approve', 'reject', 'release'] as const) {
    const result = decisionCommand({ type: 'decide', action, product: card.product, hash: card.hash }, model.decisions);
    if (result.ok) assert.ok(PERSON_DECISION_COMMANDS.includes(result.command));
  }
  assert.ok(Object.values(STAFF_ROOM_OPEN_COMMANDS).every((command) => !PERSON_DECISION_COMMANDS.includes(command)));
  // The page opens a product file only for a product in the ledger, by the path the host computed.
  assert.equal(await handleStaffRoomMessage({ type: 'open-product', product: 'concept-of-operations' }, effects), 'done');
  assert.deepEqual(calls[0], { command: 'open-file', args: '.planning/staff/products/j5/concept-of-operations.md' });
  assert.equal(await handleStaffRoomMessage({ type: 'open-product', product: 'unknown-product' }, effects), 'refused');
  assert.equal(await handleStaffRoomMessage({ type: 'select-run', run: 'run-9' }, effects), 'refused');
});

test('a person\'s decision is shown only when the signed ledger holds it; a hand-written event is named and not counted', async () => {
  const { world } = await project();
  const forged: StaffEvent = { type: 'staff.decision.recorded', run: 'run-1', at: '2026-11-19T11:30:00.000Z', product: 'concept-of-operations', version: 1, role: 'commander', person: { kind: 'person', name: 'Forged Name', role: 'Commander', deviceFingerprint: 'x' }, decision: 'approved' };
  await appendFile(path.join(world.root, LEDGER_DIR, EVENTS_FILE), `${JSON.stringify(forged)}\n`, 'utf8');
  const input = await loadStaffRoomInput(world.host, world.root, NOW);
  const model = buildStaffRoomModel(input);
  assert.equal(decisionBacked(forged as Extract<StaffEvent, { type: 'staff.decision.recorded' }>, input.registry), false);
  assert.ok(model.activity.some((line) => /signed ledger does not hold/.test(line.text)));
  assert.ok(!model.activity.some((line) => /Forged Name/.test(line.text)));
  assert.ok(model.squads.every((squad) => !squad.person?.includes('Forged')));
  assert.deepEqual(handoffsFor(input.settings, [forged], input.registry), []);
  // The real approval is in the activity line, in gold.
  const real = input.events.find((event) => event.type === 'staff.decision.recorded' && event.product === 'facts-assumptions');
  assert.ok(real && decisionBacked(real as Extract<StaffEvent, { type: 'staff.decision.recorded' }>, input.registry));
  assert.ok(model.activity.some((line) => line.kind === 'human' && /R\. Example \(J5 director\) approved/.test(line.text)));
  // Hand-offs: tasking out in violet, a product in green, a person's decision in gold.
  const cues = handoffsFor(input.settings, input.events, input.registry);
  assert.ok(cues.some((cue) => cue.kind === 'human' && cue.to === 'section:j5'));
  assert.ok(cues.some((cue) => cue.kind === 'task' && cue.to === 'decisions'));
});

test('a project with nothing staff in it still builds a calm, empty room', async () => {
  const world = await staffWorld();
  const model = buildStaffRoomModel(await loadStaffRoomInput(undefined, world.root, NOW));
  assert.equal(model.map.available, false);
  assert.equal(model.run, undefined);
  assert.equal(model.decisions.length, 0);
  assert.ok(model.rail.every((step) => step.status === 'todo' || step.status === 'next'));
  assert.equal(model.squads.length, 5);
});

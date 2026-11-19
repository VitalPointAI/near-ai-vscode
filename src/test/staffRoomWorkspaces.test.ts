// The J5, J3 and J4 workspaces of the Staff Room (owner direction 2026-11-19): each section's read model, built from the fixture files in
// test/fixtures/staff-room/sections through the real staff host (ledger, registers, wargame ledger, calculator ledger, LOGSTAT reports), and the parts
// that must hold whatever the project says: tables read as data, totals recomputed, owners from the signed transition, nothing unreadable drawn as empty.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildStaffRoomModel, staffRoomWorkspaceOf } from '../domain/staff/staffRoom';
import { markdownTables, nextOccurrence } from '../domain/staff/staffRoomWorkspaces';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { WARGAME_DIR, WARGAME_FILE } from '../staff/staffHost';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { NOW, sectionsProject } from './helpers/staffRoomFixture';
import type { RegisterRow } from '../domain/staff/registers';
import { callTool, hashIn, J5_TEAM, writeBody } from './helpers/staffFixtures';

async function sectionsModel() {
  const project = await sectionsProject();
  const input = await loadStaffRoomInput(project.world.host, project.world.root, NOW);
  return { ...project, input, model: buildStaffRoomModel(input) };
}

test('J5: COA cells with their themes and validity tests, the comparison with weights a person approved, the wargame ledger, the brief and the annex tracker', async () => {
  const { model } = await sectionsModel();
  const j5 = model.j5;
  // Cells: one per theme, each with the profile's tests read from the validity record.
  assert.deepEqual(j5.cells.map((cell) => cell.coa), ['COA A', 'COA B']);
  assert.match(j5.cells[0].theme, /Seize Port Calder from the sea/);
  assert.equal(j5.cells[0].owner, 'coa-cell-a');
  assert.deepEqual(j5.tests, ['suitable', 'feasible', 'acceptable', 'distinguishable', 'complete'].map((test) => j5.tests.find((name) => name.toLowerCase() === test)!));
  const feasible = j5.cells[0].validity.find((test) => /feasib/i.test(test.test))!;
  assert.equal(feasible.result, 'risk');
  assert.match(feasible.reason, /lift for the second wave/);
  assert.equal(j5.cells[1].validity.find((test) => /complete/i.test(test.test))!.result, 'fail');
  // Comparison: the weights, each COA's score, and totals recomputed from them (the product's own "Total" row is not a criterion).
  assert.deepEqual(j5.comparison.coas, ['COA A', 'COA B']);
  assert.deepEqual(j5.comparison.criteria.map((row) => [row.criterion, row.weight, row.scores.map((score) => score.score)]), [['Tempo', 3, [4, 2]], ['Sustainability', 2, [2, 4]], ['Risk to force', 1, [3, 3]]]);
  assert.deepEqual(j5.comparison.totals, [{ coa: 'COA A', total: 19, best: true }, { coa: 'COA B', total: 17, best: false }]);
  assert.equal(j5.comparison.approval!.by, 'C. Example (commander)', 'the weights carry the signed approval of the person who approved them');
  assert.equal(j5.comparison.approval!.product, 'coa-evaluation-criteria');
  // Wargame: one game, turn 1 action then reaction, the decision point named with its decision maker, and what comes next.
  assert.equal(j5.wargame.total, 2);
  const game = j5.wargame.games[0];
  assert.deepEqual([game.coa, game.enemyCoa, game.next], ['coa-a', 'mlcoa', 'turn 1 COUNTERACTION']);
  assert.deepEqual(game.turns[0].phases.map((phase) => [phase.phase, phase.side]), [['action', 'friendly'], ['reaction', 'adversary']]);
  assert.match(game.turns[0].phases[1].decisionPoints[0], /DP2: Commit the reserve \(decides: commander\)/);
  // The brief: the recommendation the agents drafted, the dissent unedited, who decides.
  assert.equal(j5.brief.recommendation, 'The staff recommends COA A: it takes the port on day one. Main risk: lift for the second wave; mitigation: hold a reserve of landing craft.', 'the whole first paragraph, not only its first line');
  assert.deepEqual(j5.brief.dissent, ['The red team holds COA B is safer: the beach defences are unknown.']);
  assert.equal(j5.brief.decisionFor, 'commander');
  assert.equal(j5.brief.product!.pill, 'awaiting');
  // The annex tracker through the orders check: the wrong letter and the unreleased product are named, and they block assembly.
  const logistics = j5.annexes.rows.find((row) => row.subject === 'logistics')!;
  assert.match(logistics.state, /^guard-checked v1$/);
  assert.ok(logistics.findings.some((finding) => /not released/.test(finding)));
  assert.equal(logistics.blocked, true);
  const intelligence = j5.annexes.rows.find((row) => row.subject === 'intelligence')!;
  assert.ok(intelligence.findings.some((finding) => /not Annex D|Annex B/.test(finding)), 'the letter comes from the profile, not from memory');
  assert.ok(j5.annexes.blocking >= 2);
  // Products of the section with their owner, version and state; agent work in the section, newest first.
  assert.ok(j5.products.some((row) => row.product === 'coa-decision-brief' && row.owner === 'lead-planner' && row.version === 1));
  assert.ok(j5.activity.some((line) => line.member === 'coa-cell-a' && /started on COA A/.test(line.text)));
  assert.ok(j5.activity.every((line) => !/C\. Example/.test(line.text)), 'a person\'s decision is never shown as agent work');
});

test('J3: the event log with escalations and CCIR matches, the DSM and sync matrix with their owner, FRAGO drafts, the battle rhythm and suspenses', async () => {
  const { model } = await sectionsModel();
  const j3 = model.j3;
  assert.equal(j3.eventLog.total, 2);
  assert.equal(j3.eventLog.escalated, 1);
  assert.deepEqual(j3.eventLog.rows.map((row) => row.id), ['E2', 'E1'], 'newest first');
  assert.equal(j3.eventLog.rows[1].ccir, 'PIR-1');
  assert.equal(j3.triggers[0].ccir, 'PIR-1');
  assert.equal(j3.ccir[0].id, 'PIR-1');
  // The DSM: the decision point, its decision maker, and that the watch reported its trigger.
  assert.deepEqual(j3.dsm.rows.map((row) => [row.id, row.maker, row.matched]), [['DP-2', 'commander', true]]);
  // Owners: the J5 while planning; the note says only a person's approval of the transition brief moves them.
  assert.equal(j3.dsm.owner.phase, 'planning');
  assert.match(j3.sync.owner.note, /J-?5 lead-planner while planning\. It passes to the J-?3 future-ops-planner only when a person approves the transition brief/);
  // Sync matrix: rows in doctrinal order, cells by H-hour offset.
  assert.deepEqual(j3.sync.rows.map((row) => row.row), ['enemy', 'manoeuvre', 'sustainment', 'decision-points']);
  assert.deepEqual([j3.sync.from, j3.sync.to, j3.sync.total], [0, 360, 4]);
  // FRAGOs: the draft waiting for a person, and its card on the shared decision list (the same signed path).
  assert.deepEqual(j3.fragos.map((row) => [row.product, row.pill]), [['frago-1', 'awaiting']]);
  assert.ok(model.decisions.some((card) => card.product === 'frago-1' && card.section === 'j3' && card.kind === 'decide'));
  // Battle rhythm: the daily brief's next occurrence after now, then the weekly working group.
  assert.deepEqual(j3.rhythm.events.map((event) => [event.id, event.next]), [['BR1', '2026-11-19T13:00:00.000Z'], ['BR2', '2026-11-25T09:00:00.000Z']]);
  // Suspenses: open RFIs by suspense, the passed one flagged.
  assert.deepEqual(j3.suspenses.map((row) => [row.id, row.overdue]), [['RFI-7', true], ['RFI-8', false]]);
  assert.ok(j3.activity.some((line) => line.member === 'joc-chief'));
});

test('J4: LOGSTAT by unit with bands from the settings, held-out reports, calculator results with their formulas, movement, readiness, annex and supportability', async () => {
  const { model } = await sectionsModel();
  const j4 = model.j4;
  assert.equal(j4.logstat.reports, 2);
  assert.deepEqual(j4.logstat.units.map((unit) => [unit.unit, unit.band]), [['1 Bn', 'red']]);
  assert.match(j4.logstat.units[0].lines[0].words, /^RED: 20 percent of capacity/);
  assert.deepEqual(j4.logstat.heldOut.map((entry) => [entry.unit, entry.rules]), [['2 Bn', ['1']]], 'a report that fails a rule stays out, its unit named');
  const fuel = j4.calcs.find((calc) => calc.id === 'fuel-phase-1')!;
  assert.match(fuel.result, /3,500 per day/);
  assert.ok(fuel.formula.length > 0 && fuel.formula.some((line) => /250/.test(line)), 'the formula is shown with the factor a person entered');
  assert.deepEqual(j4.movement.map((row) => [row.serial, row.feasible]), [['1', true], ['2', false]]);
  assert.match(j4.movement[1].why, /lift short/);
  const generator = j4.readiness.find((row) => row.equipment === 'generator')!;
  assert.equal(generator.stale, true, 'readiness data older than a day is flagged');
  assert.equal(j4.readiness.find((row) => row.equipment === 'cargo truck')!.stale, false);
  assert.deepEqual(j4.annexes.map((row) => [row.product, row.pill]), [['logistics-annex', 'checked']]);
  assert.match(j4.annexes[0].tracker, /Annex D, drafting/);
  assert.deepEqual(j4.supportability.map((row) => [row.coa, row.level, row.verified]), [['COA A', 'risk', true], ['COA A', 'ok', true], ['COA B', 'bad', false]], 'a cited record the calculator ledger does not vouch for is flagged');
});

test('an unreadable wargame ledger or register is named, never drawn as empty', async () => {
  const { world } = await sectionsProject();
  await writeFile(path.join(world.root, WARGAME_DIR, WARGAME_FILE), Buffer.alloc(3 * 1024 * 1024, 'x'));
  await writeBody(world.root, 'j3', 'event-log', '# Event log\n\n```json staff-register\n{"register":"event-log","rows":[{"id":"bad id with spaces"}]}\n```\n');
  const model = buildStaffRoomModel(await loadStaffRoomInput(world.host, world.root, NOW));
  assert.match(model.j5.wargame.problem ?? '', /cannot be read whole/);
  assert.equal(model.j5.wargame.games.length, 0);
  assert.ok(model.j3.problems.some((problem) => /event log \(operations centre\) could not be read/.test(problem)));
  assert.equal(model.j3.eventLog.total, 0);
});

test('a project with nothing for a section yet builds empty workspaces, and large registers are capped before the page', async () => {
  const empty = buildStaffRoomModel({ now: NOW, settings: defaultStaffSettings(), registry: [], decisions: [], cop: { layers: [], eventTail: [] }, events: [], j2: { sources: [], pirs: [], plan: [] } });
  assert.equal(empty.j5.cells.length + empty.j5.comparison.criteria.length + empty.j5.wargame.games.length + empty.j5.annexes.rows.length, 0);
  assert.equal(empty.j3.eventLog.total + empty.j3.sync.total + empty.j3.fragos.length, 0);
  assert.equal(empty.j4.logstat.units.length + empty.j4.calcs.length + empty.j4.movement.length, 0);
  const rows = Array.from({ length: 450 }, (_, n) => ({ id: `E${n}`, time: `2026-11-19T${String(n % 24).padStart(2, '0')}:00:00Z`, source: 'watch', report: 'x'.repeat(2000), status: 'logged' }));
  const big = buildStaffRoomModel({ now: NOW, settings: defaultStaffSettings(), registry: [], decisions: [], cop: { layers: [], eventTail: [] }, events: [], j2: { sources: [], pirs: [], plan: [] }, workspaces: { registers: { eventLog: rows } } });
  assert.equal(big.j3.eventLog.total, 450);
  assert.equal(big.j3.eventLog.rows.length, 200);
  assert.ok(big.j3.eventLog.rows.every((row) => row.report.length <= 400));
});

test('Markdown tables are read as data: pipes escaped, fenced blocks skipped, and the next battle rhythm occurrence', () => {
  const tables = markdownTables('| A | B |\n|---|---|\n| 1 \\| one | 2 |\n\n```\n| C | D |\n|---|---|\n```\n\n| E |\n| :-- |\n| 5 |\n');
  assert.deepEqual(tables.map((table) => [table.headers, table.rows]), [[['A', 'B'], [['1 | one', '2']]], [['E'], [['5']]]]);
  assert.equal(nextOccurrence('2026-11-19T13:00:00Z', 'once', NOW), Date.parse('2026-11-19T13:00:00Z'));
  assert.equal(nextOccurrence('2026-11-19T09:00:00Z', 'once', NOW), undefined);
  assert.equal(nextOccurrence('2026-11-12T09:00:00Z', 'weekly', NOW), Date.parse('2026-11-26T09:00:00Z'));
  assert.equal(nextOccurrence('not a time', 'daily', NOW), undefined);
});

test('the open command\'s workspace argument names a workspace or nothing', () => {
  assert.equal(staffRoomWorkspaceOf('j4'), 'j4');
  for (const value of ['J4', 'j6', '', undefined, 4, { workspace: 'j4' }, ['j4']]) assert.equal(staffRoomWorkspaceOf(value), undefined);
});

test('after a person approves the transition brief, the DSM and the sync matrix are the J3\'s, with the signed act named', async () => {
  const { world } = await sectionsProject();
  // The sync matrix and DSM are in the ledger, and the transition brief is approved by a person: the writer moves.
  for (const product of ['sync-matrix', 'transition-brief']) {
    if (product === 'transition-brief') await writeBody(world.root, 'j5', product, '# Transition brief\n\nThe plan passes to current operations.\n');
    const proposed = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product, kind: product === 'sync-matrix' ? 'matrix' : 'brief' }, 'lead-planner');
    assert.ok(proposed.ok, proposed.text);
    if (product === 'transition-brief') {
      const hash = hashIn(proposed.text);
      assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard')).ok);
      assert.ok((await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product, decisionFor: 'J3' }, 'lead-planner')).ok);
      const decided = await world.host.decide(world.person('D. Example', 'J3'), { product, action: 'approve', hash });
      assert.ok(decided.ok, decided.ok ? '' : decided.message);
    }
  }
  const model = buildStaffRoomModel(await loadStaffRoomInput(world.host, world.root, NOW));
  assert.equal(model.j3.sync.owner.phase, 'execution');
  assert.match(model.j3.sync.owner.note, /future-ops-planner since D\. Example \(J3\) approved the transition brief/);
  assert.ok(model.j3.sync.owner.handover?.at);
});

test('product titles keep staff abbreviations and section codes in capitals on every screen', async () => {
  const { productTitle } = await import('../domain/staff/productTitle');
  assert.equal(productTitle('coa-decision-brief'), 'COA decision brief');
  assert.equal(productTitle('frago-1'), 'FRAGO 1');
  assert.equal(productTitle('dsm'), 'DSM');
  assert.equal(productTitle('ccir-register'), 'CCIR register');
  assert.equal(productTitle('enemy-coas'), 'Enemy COAs');
  assert.equal(productTitle('j4-logstat-summary'), 'J4 LOGSTAT summary');
  assert.equal(productTitle('concept-of-operations'), 'Concept of operations');
  assert.equal(productTitle('facts-assumptions'), 'Facts assumptions');
  assert.equal(productTitle('coa-a'), 'COA A');
  assert.equal(productTitle('a-plan'), 'A plan');
  // With the profile, the fragmentary order reads as that profile writes it; the file name stays frago-N.
  assert.equal(productTitle('frago-1', 'us-joint'), 'FRAGORD 1');
  assert.equal(productTitle('frago-1', 'us-army'), 'FRAGORD 1');
  assert.equal(productTitle('frago-2', 'nato-ca'), 'Frag O 2');
  assert.equal(productTitle('fragos-log', 'nato-ca'), 'Frag Os log');
  assert.equal(productTitle('coa-decision-brief', 'nato-ca'), 'COA decision brief');
});

test('the workspaces use the profile\'s doctrine terms: the fragmentary order, the logistics annex letters, the concept of support and the annex order', async () => {
  const { input } = await sectionsModel();
  const under = (profile: 'us-joint' | 'us-army' | 'nato-ca', level: 'operational' | 'tactical' = 'operational', workspaces = input.workspaces) =>
    buildStaffRoomModel({ ...input, settings: { ...input.settings, profile, level }, ...(workspaces ? { workspaces } : {}) });
  // The FRAGO: FRAGORD under the US profiles, Frag O under NATO/Canadian, on the J3 list, the shared decision card and the activity line alike.
  const nato = under('nato-ca');
  assert.equal(nato.j3.frago, 'Frag O');
  assert.deepEqual(nato.j3.fragos.map((row) => [row.product, row.title]), [['frago-1', 'Frag O 1']]);
  assert.equal(nato.decisions.find((card) => card.product === 'frago-1')!.title, 'Frag O 1');
  assert.ok(nato.j3.activity.some((line) => /^Frag O 1 v1/.test(line.text)));
  assert.equal(under('us-joint').j3.frago, 'FRAGORD');
  assert.equal(under('us-army', 'tactical').j3.fragos[0].title, 'FRAGORD 1');
  // The logistics annex with the profile's letter and title, and the concept of support in the profile's words (COLS under US Joint).
  const support = { ...input.workspaces, registers: { ...input.workspaces?.registers, annexTracker: [
    ...(input.workspaces?.registers?.annexTracker ?? []), { id: 'A3', subject: 'movements', owner: 'j4-director', status: 'drafting', product: 'movements-annex' },
    { id: 'A4', subject: 'logistics', owner: 'j4-director', status: 'not-started', product: 'concept-of-support' }
  ] } };
  const titles = (model: ReturnType<typeof under>) => Object.fromEntries(model.j4.annexes.map((row) => [row.product, row.title]));
  assert.deepEqual(titles(under('us-joint', 'operational', support)), {
    'logistics-annex': 'Annex D (Logistics)', 'movements-annex': 'Movements annex: No separate movements annex; movements are part of Annex D (Logistics).', 'concept-of-support': 'Concept of logistics support (COLS)'
  });
  assert.deepEqual(titles(under('nato-ca', 'operational', support)), { 'logistics-annex': 'Annex R (Logistics)', 'movements-annex': 'Annex S (Movements)', 'concept-of-support': 'Concept of logistic support' });
  assert.equal(under('us-army', 'tactical', support).j4.annexes.find((row) => row.product === 'logistics-annex')!.title, 'Annex F (Sustainment)');
  assert.equal(under('us-army', 'tactical').j4.annexName, 'Sustainment annex');
  assert.equal(under('nato-ca').j4.annexName, 'Logistics annex');
  // The annex tracker in the profile's letter order: a numbered COPD sub-annex (SS2, Info Ops) after its annex, two-letter annexes after the single ones,
  // and a row with no letter last.
  const tracker: RegisterRow[] = [
    { id: 'T1', subject: 'public-affairs', letter: 'TT', status: 'drafting' }, { id: 'T2', subject: 'information', letter: 'SS2', status: 'drafting' },
    { id: 'T3', subject: 'reports', status: 'not-started' }, { id: 'T4', subject: 'communication-strategy', letter: 'SS', status: 'drafting' },
    { id: 'T5', subject: 'task-organization', letter: 'B', status: 'done' }
  ];
  const ordered = under('nato-ca', 'operational', { ...input.workspaces, registers: { ...input.workspaces?.registers, annexTracker: tracker } }).j5.annexes.rows;
  assert.deepEqual(ordered.map((row) => row.letter), ['B', 'SS', 'SS2', 'TT', '']);
  assert.ok(!ordered.find((row) => row.subject === 'information')!.findings.some((finding) => /not Annex/.test(finding)), 'SS2 is the NATO/Canadian Info Ops letter');
});

test('the room built for the workspaces shows each standing watch in its trusted state', async () => {
  const { world, model } = await sectionsModel();
  // The fixture's watch was armed by a signed decision, so it shows as the file says.
  assert.deepEqual(model.j2.watches.map((watch) => [watch.id, watch.state, watch.unsigned]), [['WATCH-1', 'paused', undefined]]);
  // With no staff host nothing can prove the arm: the same watch reads as proposed and is flagged, and the live board cannot make it look armed.
  const bare = await loadStaffRoomInput(undefined, world.root, NOW);
  assert.deepEqual(bare.j2.distrustedWatches, ['WATCH-1']);
  const shown = buildStaffRoomModel({ ...bare, feedEvents: [] }).j2.watches;
  assert.deepEqual(shown.map((watch) => [watch.id, watch.state, watch.unsigned]), [['WATCH-1', 'proposed', true]]);
});

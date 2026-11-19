// The Staff Room's host side (WP-ROOM): the picture built from a real staff project (a signed ledger, the event log, the scenario and the J2 registers
// read from fixture files), every message from the page validated, decision buttons that reach only the person-only staff commands, and a person's
// decision shown only when the signed ledger holds it.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { labelRecordFilter } from '../agent/gateLabels';
import { gridCentre, gridToWgs84, observationId, parseGridReference, segmentId } from '../domain/staff';
import type { ExerciseFrame } from '../domain/staff';
import { PERSON_DECISION_COMMANDS, STAFF_COMMANDS } from '../domain/staff/commands';
import type { StaffEvent } from '../domain/staff/events';
import { parseScenarioText } from '../domain/staff/scenario';
import { buildStaffRoomModel, decisionBacked, decisionCommand, handoffsFor, parseStaffRoomMessage, STAFF_ROOM_WORKSPACES } from '../domain/staff/staffRoom';
import { buildStaffMap, estimativeLanguage, unitIcon } from '../domain/staff/staffRoomMap';
import { EVENTS_FILE, LEDGER_DIR } from '../staff/staffHost';
import { ENEMY_COA_PRODUCTS, loadStaffRoomInput } from '../staff/staffRoomData';
import { handleStaffRoomMessage, STAFF_ROOM_OPEN_COMMANDS } from '../staff/staffRoomHost';
import { ObservationStore } from '../staff/observationStore';
import { labelVisible, staffRoomPicture } from '../staff/staffRoomPicture';
import { testGateRuntime } from './helpers/gatedRuns';
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

// ---- The COP picture beside the room, and the page's policy ------------------------------------------------------------------------------

test('the room\'s COP picture carries only the observations the person\'s clearance covers, and none without a reader', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-room-cop-'));
  mkdirSync(path.join(root, '.planning', 'staff', 'scenario'), { recursive: true });
  copyFileSync(SCENARIO, path.join(root, '.planning', 'staff', 'scenario', 'scenario.json'));
  const frame: ExerciseFrame = JSON.parse(await readFile(SCENARIO, 'utf8')).region.frame;
  const at = (reference: string): [number, number] => { const point = gridToWgs84(frame, gridCentre(parseGridReference(reference, frame.grid, frame.squareMetres)!)); return [point.longitude, point.latitude]; };
  const T0 = Date.parse('2026-11-18T12:00:00.000Z');
  const store = new ObservationStore({ root, now: () => T0 + 60_000 });
  const feed = {
    id: 'ais-sim', title: 'Simulated AIS', category: 'intelligence', feedClass: 'positions', format: 'ais-nmea', transport: 'loopback', licenceClass: 'simulated', trainingRights: 'no', simulated: true,
    channels: [{ id: 'receiver-north', title: 'North receiver', discipline: null, reliability: 'C', credibility: 3 }, { id: 'receiver-nato', title: 'Coalition receiver', discipline: null, label: 'nato/NATO Unclassified' }]
  };
  const person = { kind: 'person', name: 'A. Demo', role: 'J2 watch officer', deviceFingerprint: 'dev-0123456789abcdef' } as const;
  assert.ok((await store.registerFeed(feed)).ok);
  assert.ok((await store.transitionFeed('ais-sim', 'approve', person)).ok);
  assert.ok((await store.transitionFeed('ais-sim', 'start-live', { kind: 'system' })).ok);
  const row = (channel: string, messageId: string, track: string, label: string, reference: string) => {
    const knownAt = new Date(T0).toISOString();
    return {
      schema: 1, obsId: observationId('ais-sim', channel, messageId), messageId, segment: segmentId('ais-sim', channel, knownAt), feed: 'ais-sim', channel, discipline: null,
      validAt: knownAt, knownAt, geometry: { type: 'Point', coordinates: at(reference) }, error: { circularMetres: 50, verticalMetres: null }, how: 'gps', subjectRef: track,
      source: 'AIS receiver', origin: `Transponder ${track}`, reliability: 'C', credibility: 3, deceptionNote: 'none seen', label, handling: [], extractor: { codec: 'ais', version: '1.0.0' },
      simulated: true, trackId: `mmsi:${track}`
    };
  };
  const appended = await store.append({ rows: [row('receiver-north', 'n1', '316000001', 'org/Internal', 'KQ 4636'), row('receiver-nato', 'x1', '316000002', 'nato/NATO Unclassified', 'KQ 4736')] });
  assert.equal(appended.appended, 2, JSON.stringify(appended));
  const tracksIn = (picture: Awaited<ReturnType<typeof staffRoomPicture>>['picture']) => (picture?.features ?? []).map((feature) => feature.properties.track).filter(Boolean).sort();

  // The default policy's clearance: no NATO clearance, so the coalition track is never in the picture.
  const reader = labelRecordFilter(testGateRuntime());
  const cleared = await staffRoomPicture(root, { store, reader });
  assert.equal(cleared.problem, undefined);
  assert.deepEqual(tracksIn(cleared.picture), ['mmsi:316000001']);
  assert.ok(!JSON.stringify(cleared.picture).includes('316000002'), 'nothing of the hidden row reaches the page');
  assert.equal(cleared.now, T0 + 60_000, 'the store\'s clock');
  assert.ok(cleared.picture!.frame, 'the scenario\'s frame');
  // With a reader that covers everything both are there, so the clamp is the reader's doing; with no reader nothing labelled is read.
  assert.deepEqual(tracksIn((await staffRoomPicture(root, { store, reader: () => true })).picture), ['mmsi:316000001', 'mmsi:316000002']);
  const unread = await staffRoomPicture(root, { store });
  assert.deepEqual(tracksIn(unread.picture), []);
  assert.ok(unread.picture!.layers.filter((layer) => layer.kind === 'feed').every((layer) => layer.count === 0));
  // The picture's label check is the same reader, and a label it cannot parse is not visible.
  assert.equal(labelVisible(reader)('org/Internal'), true);
  assert.equal(labelVisible(reader)('nato/NATO Unclassified'), false);
  assert.equal(labelVisible(() => true)('no-scale'), false);
  assert.equal(labelVisible(() => { throw new Error('no gate'); })('org/Internal'), false);
  // No scenario: a picture without a frame (the room keeps its SVG map), never a throw.
  const bare = await staffRoomPicture(mkdtempSync(path.join(tmpdir(), 'near-ai-room-cop-')), { now: () => 5 });
  assert.equal(bare.now, 5);
  assert.equal(bare.picture!.frame, undefined);
});

test('the Staff Room page loads only the vendored map files, under a policy with no eval, no inline code and no remote source', () => {
  const uri = (value: string) => ({ path: value, toString: () => value });
  const vscode = {
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => uri(path.posix.normalize([base.path, ...parts].join('/'))), file: (value: string) => uri(value) },
    ViewColumn: { Active: -1 }, window: {}, workspace: {}, commands: { registerCommand: () => ({ dispose: () => undefined }) }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => (request === 'vscode' ? vscode : originalLoad(request, parent, isMain));
  let panel: typeof import('../services/staffRoomPanel');
  try { panel = require('../services/staffRoomPanel') as typeof import('../services/staffRoomPanel'); } finally { nodeModule._load = originalLoad; }
  const source = 'https://file+.vscode-resource.vscode-cdn.net';
  const webview = { cspSource: source, asWebviewUri: (value: { path: string }) => uri(`${source}${value.path}`) };
  const html = panel.staffRoomHtml(webview as never, uri('/ext/media/staffRoom') as never);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|\*|http:|data: [^;]*script/);
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)![1];
  assert.match(csp, /^default-src 'none'; /);
  assert.match(csp, new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, '\\$&')}'(;|$)`), 'scripts only by nonce');
  assert.match(csp, /worker-src blob:(;|$)/, 'the map worker starts from a blob');
  assert.match(csp, new RegExp(`connect-src ${source.replace(/[.+]/g, '\\$&')}(;|$)`), 'fetches only from the extension');
  // Every script carries the nonce and is one of the page's own or the COP map's; the vendored libraries are named for the page to load lazily.
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 3);
  for (const attributes of scripts) {
    assert.match(attributes, new RegExp(`nonce="${nonce.replace(/[+/=]/g, '\\$&')}"`));
    assert.match(attributes, /src="https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\/ext\/media\/(staffRoom\/staffMap\.js|staffRoom\/staffRoom\.js|staff\/copMap\.js|shared\/layout-probe\.js)"/);
  }
  assert.ok(html.indexOf('staff/copMap.js') < html.indexOf('staffRoom/staffMap.js'), 'the COP map is loaded before the room\'s map');
  const resources = JSON.parse(/data-cop-resources="([^"]+)"/.exec(html)![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(Object.keys(resources).sort(), ['maplibre', 'milsymbol', 'worker']);
  for (const value of Object.values(resources) as string[]) assert.match(value, /^https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\/ext\/media\/vendor\//);
  assert.match(html, /vendor\/maplibre-gl\/maplibre-gl\.css/);
  assert.doesNotMatch(html, /\son[a-z]+=|style="/, 'no inline handler or style');
  // The panel may read its own folder, the shared stylesheet, the COP map and the vendored libraries, and nothing else.
  assert.deepEqual(panel.staffRoomResourceRoots(uri('/ext') as never).map((root) => root.path), ['/ext/media/staffRoom', '/ext/media/shared', '/ext/media/staff', '/ext/media/vendor']);
});

test('the room\'s fixed layers are sized to the viewport without its scrollbar, so a page that scrolls never reaches past its right edge', async () => {
  // e2e found the hand-off effects layer, sized 100vw, ending past the page's edge once the room scrolled: viewport units include the scrollbar.
  const css = await readFile(path.join(__dirname, '..', '..', 'media', 'staffRoom', 'staffRoom.css'), 'utf8');
  const fixed = [...css.matchAll(/^([^{}\n]+)\{([^}]*position:\s*fixed[^}]*)\}/gm)];
  assert.ok(fixed.some((rule) => rule[1].trim() === '.fx'), 'the effects layer is a fixed layer');
  for (const [, selector, body] of fixed) assert.doesNotMatch(body, /(?:^|;)\s*width:\s*100vw/, `${selector.trim()} must not be 100vw wide`);
});

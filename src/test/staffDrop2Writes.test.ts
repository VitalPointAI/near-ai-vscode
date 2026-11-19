// Drop 2 keeps drop 1's review round 4 rule (src/staff/staffFiles.ts): the host never writes over bytes it did not read. Every write drop 2 adds to a
// file a member can also write is a compare-and-swap: the cop-map layer, its proposals and merges, the calculator records, the LOGSTAT validation
// product and the observation store's index files. A member's write is injected at each point of the host's write, and it always stands.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { copMapTools, SCENARIO_FILE } from '../agent/copMap';
import type { AgentTool, ToolContext } from '../agent/tools';
import { layerPath } from '../domain/staff/cop';
import { CALCULATOR_RECORD_DIR } from '../domain/staff/logistics/calculator';
import { CALC_LEDGER_FILE } from '../domain/staff/logistics/calcLedger';
import { LOGSTAT_VALIDATION_PRODUCT } from '../domain/staff/logistics/logstat';
import { OBS_MANIFEST_FILE, OBS_REGISTRY_FILE, OBS_STORE_DIR } from '../domain/staff/obs/store';
import { staffProductPath } from '../domain/staff/writeLimits';
import { ObservationStore } from '../staff/observationStore';
import { setCasProbe } from '../staff/staffFiles';
import type { CasProbe } from '../staff/staffFiles';
import type { StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, J2_TEAM, staffWorld, writeFactors } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const REPO = path.resolve(__dirname, '..', '..');
const STARTER = path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json');
const POINTS = ['before-temp', 'before-check', 'before-rename'] as const;
const MEMBER = 'A member wrote this while the host was writing.\n';

/** A member's Write landing at one point of the host's next compare-and-swap on `file`. */
function memberWriteAt(point: (typeof POINTS)[number], file: string, text = MEMBER): () => void {
  let done = false;
  const probe: CasProbe = async (at, target) => { if (!done && at === point && target === file) { done = true; await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); } };
  setCasProbe(probe);
  return () => setCasProbe(undefined);
}

async function copWorld(): Promise<StaffWorld> {
  const made = await staffWorld();
  await mkdir(path.join(made.root, path.dirname(SCENARIO_FILE)), { recursive: true });
  await writeFile(path.join(made.root, SCENARIO_FILE), await readFile(STARTER, 'utf8'));
  return made;
}

async function cop(made: StaffWorld, tool: string, args: Record<string, unknown>, member: string): Promise<{ ok: boolean; text: string }> {
  const tools: AgentTool<any>[] = copMapTools({ host: () => made.host, team: J2_TEAM, run: 'run-1', now: () => Date.parse('2026-11-18T12:00:00.000Z') });
  const found = tools.find((candidate) => candidate.name === `mcp__cop-map__${tool}`)!;
  const context = { root: made.root, signal: new AbortController().signal, agentLabel: member } as unknown as ToolContext;
  try { return { ok: true, text: await found.run(found.parse(args), context) }; } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
}

const THREAT = { layer: 'cop-threat-layer', summary: 'Initial threat picture', features: [{ id: 'e-1-41', kind: 'symbol', name: '1-41 MECH', sidc: '10061000161211020000', at: 'KQ 4532' }] };

test('cop-map: a member write to the layer file at any point of the writer\'s update stands, and nothing is recorded over it', async () => {
  for (const point of POINTS) {
    const made = await copWorld();
    const file = path.join(made.root, layerPath('cop-threat-layer'));
    const stop = memberWriteAt(point, file);
    let written;
    try { written = await cop(made, 'propose', THREAT, 'threat-analyst'); } finally { stop(); }
    assert.equal(written.ok, false, `${point}: ${written.text}`);
    assert.match(written.text, /changed while this change was being made/);
    assert.equal(await readFile(file, 'utf8'), MEMBER, `${point}: the member's bytes stand`);
    assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
  }
});

test('cop-map: a proposal never replaces a file already at its name, and a merge moves only the proposal bytes it merged', async () => {
  const made = await copWorld();
  const proposed = await cop(made, 'propose', { ...THREAT, summary: 'Seen near Gull Island', features: [{ id: 'u-1', kind: 'symbol', name: 'U-1', sidc: '10013000000000000000', at: 'KQ 4142' }] }, 'watch-officer');
  assert.ok(proposed.ok, proposed.text);
  const folder = path.join(made.root, '.planning/staff/proposals/cop-threat-layer');
  const [name] = (await readdir(folder)).filter((entry) => entry.endsWith('.json'));
  const proposal = path.join(folder, name!);
  // A member edits the proposal after the writer's merge read it: the merge keeps the edited file where it is, to be looked at again.
  const original = await readFile(proposal, 'utf8');
  const edited = original.replace('Seen near Gull Island', 'Seen near Gull Island, edited');
  const stop = memberWriteAt('before-check', proposal, edited);
  let merged;
  try { merged = await cop(made, 'merge', { layer: 'cop-threat-layer', proposal: name!.replace(/\.json$/, '') }, 'threat-analyst'); } finally { stop(); }
  assert.ok(merged.ok, merged.text);
  assert.match(merged.text, /changed after it was read, so it stays in the proposals/);
  assert.equal(await readFile(proposal, 'utf8'), edited, 'the edited proposal stands');
  assert.equal(await readFile(path.join(folder, 'merged', name!), 'utf8'), original, 'merged/ holds the bytes that were merged');
});

const J4: StaffTeamInfo = { slug: 'j4-logistics', section: 'j4', sectionLead: 'j4-director', members: ['j4-director', 'log-plans-officer', 'jloc-chief', 'logstat-analyst', 'release-guard'] };
const FUEL_CALC = { id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 40, item: 'cargo trucks' }], days: 3 };

test('logistics: a file a member puts at a calculator record\'s name first is never replaced, and no ledger entry is made for it', async () => {
  const w = await staffWorld();
  await writeFactors(w.root, [{ id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 250, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' }]);
  const record = path.join(w.root, CALCULATOR_RECORD_DIR, 'fuel-phase-1.json');
  const stop = memberWriteAt('before-check', record, '{"forged":true}\n');
  let run;
  try { run = await callLogistics(w, J4, 'calc_run', FUEL_CALC, 'log-plans-officer'); } finally { stop(); }
  assert.equal(run.ok, false, run.text);
  assert.match(run.text, /calc:fuel-phase-1 already exists/);
  assert.equal(await readFile(record, 'utf8'), '{"forged":true}\n');
  const ledger = await readFile(path.join(w.root, '.planning/staff/ledger', CALC_LEDGER_FILE), 'utf8').catch(() => '');
  assert.equal(ledger, '', 'nothing was entered in the calculator ledger');
  assert.ok((await callLogistics(w, J4, 'calc_run', { ...FUEL_CALC, id: 'fuel-phase-1-v2' }, 'log-plans-officer')).ok, 'a new id still works');
});

test('logistics: a member write to the validation log product during logstat_validate stands', async () => {
  for (const point of POINTS) {
    const w = await staffWorld();
    const sent = { id: 'bn1-181200z', unit: '1 Bn', reportedAt: '2026-11-18T12:00:00Z', lines: [{ commodity: 'Class III (bulk)', uom: 'litres', onHand: 31000, received: 0, consumed: 0, capacity: 30000, forecast: 31500 }] };
    assert.ok((await callLogistics(w, J4, 'logstat_submit', { report: sent }, 'jloc-chief')).ok);
    const file = path.join(w.root, staffProductPath('j4', LOGSTAT_VALIDATION_PRODUCT));
    const stop = memberWriteAt(point, file);
    let validated;
    try { validated = await callLogistics(w, J4, 'logstat_validate', {}, 'logstat-analyst'); } finally { stop(); }
    assert.equal(validated.ok, false, `${point}: ${validated.text}`);
    assert.match(validated.text, /changed while the validation log was being written/);
    assert.equal(await readFile(file, 'utf8'), MEMBER, `${point}: the member's bytes stand`);
  }
});

const AIS = {
  id: 'ais-sim', title: 'Simulated AIS', category: 'intelligence', feedClass: 'positions', format: 'ais-nmea', transport: 'loopback', licenceClass: 'simulated',
  trainingRights: 'no', simulated: true, channels: [{ id: 'receiver-north', title: 'North receiver', discipline: null, reliability: 'C', credibility: 3 }]
};
const PERSON = { kind: 'person', name: 'A. Demo', role: 'J2 watch officer', deviceFingerprint: 'dev-0123456789abcdef' } as const;

test('observation store: an index file a member changes between the store\'s read and its write is never written over, and the write is refused', async () => {
  // The manifest and the feed registry are written by the same compare-and-swap (writeIndex); the registry is the one every transition writes.
  for (const point of POINTS) {
    const w = await staffWorld();
    const store = new ObservationStore({ root: w.root, now: () => Date.parse('2026-11-18T12:00:00.000Z') });
    assert.ok((await store.registerFeed(AIS)).ok);
    const file = path.join(w.root, OBS_STORE_DIR, OBS_REGISTRY_FILE);
    const stop = memberWriteAt(point, file, '{"member":true}\n');
    let moved;
    try { moved = await store.transitionFeed('ais-sim', 'approve', PERSON); } finally { stop(); }
    assert.equal(moved.ok, false, `${point}: ${JSON.stringify(moved)}`);
    assert.match((moved as { message: string }).message, /changed outside the store after it was read/);
    assert.equal(await readFile(file, 'utf8'), '{"member":true}\n', `${point}: the member's bytes stand`);
    assert.equal((await store.load()).ok, false, 'the next read reports the changed file, never an empty store');
  }
  assert.ok(OBS_MANIFEST_FILE);
});

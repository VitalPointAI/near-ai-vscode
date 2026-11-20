// D-29 parity (plan 31-21; Pitfall 8, P-31-29): a staff project that never turns multi-user is untouched by the shared-project code. A full
// single-machine workload (propose, gate verdicts, submit, approve, release, a PIR decision, a watch decision, a wargame turn, a calculator record,
// Use This Branch's Ledger and Set Aside) runs on a host given the replica storage the extension will give every host (31-23), and leaves no replica or
// legacy folder, no SecretStorage key today's code does not write, nothing in the extension's global storage, and no module from src/staff/replica in
// the module cache. Every path under .planning/staff is one of the layouts today's host writes, and every ledger verifies with today's verifier.
//
// This file imports nothing from src/staff/replica (or a module that does): the module check at the end proves its own detector, last.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { StaffSectionId } from '../domain/staff/doctrine';
import { registerPath, renderRegister } from '../domain/staff/intel';
import type { PirEntry } from '../domain/staff/intel';
import { replayLedger } from '../domain/staff/ledger';
import type { PlanningFactor } from '../domain/staff/logistics';
import { LEGACY_DIR, REPLICA_DIR, REPLICA_PROJECT_FILE } from '../domain/staff/multiUser';
import { DECISION_LOG_FILE, replayPersonDecisions } from '../domain/staff/personDecisions';
import { verifyPayload } from '../domain/team/signedPayload';
import { replayCalculatorLedger } from '../staff/logisticsHost';
import { LEDGER_DIR, LEDGER_FILE, LEDGER_HEAD_SECRET_PREFIX, StaffHost, WARGAME_DIR, WARGAME_FILE } from '../staff/staffHost';
import type { StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, testSigner, trusting, writeBody, writeFactors } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const CONOPS = 'concept-of-operations';
const DECISION_ROLE = 'commander';
const J4_TEAM: StaffTeamInfo = { slug: 'j4-logistics', section: 'j4', sectionLead: 'j4-director', members: ['j4-director', 'log-plans-officer', 'jloc-chief', 'release-guard'] };
const FUEL: PlanningFactor = { id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 250, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' };
const FUEL_CALC = { id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 40, item: 'cargo trucks' }], days: 3, onHand: 21000 };
const TURN = { coa: 'coa-a', enemyCoa: 'mlcoa', turn: 1, phase: 'action', hHourOffsetMinutes: 0, moves: [], results: [], decisionPoints: [] };
const PIR: PirEntry = {
  id: 'PIR-1', requirement: 'Will the adversary cross?', decisionPoint: 'DP 2', ltiov: '2026-11-19T06:00:00.000Z', indicators: [{ id: 'IND-1', text: 'Bridging seen' }],
  status: 'awaiting-decision', requestedBy: 'j3', answeredBy: [], label: 'org/Internal', addedBy: 'requirements-manager'
} as unknown as PirEntry;

const sep = path.sep;
const REPLICA_MODULE = `${sep}staff${sep}replica${sep}`;

/** Every module in the cache whose path is under src/staff/replica (compiled: dist/staff/replica). */
function replicaModules(): string[] {
  return Object.keys(require.cache).filter((file) => file.includes(REPLICA_MODULE));
}

function must(result: { ok: boolean; text: string }, what: string): string {
  assert.ok(result.ok, `${what}: ${result.text}`);
  return result.text;
}

interface Workload {
  readonly world: StaffWorld;
  readonly global: string;
  readonly secrets: ReturnType<typeof memorySecrets>;
  readonly keysBefore: string[];
  readonly setAside: string;
}

/**
 * The whole single-machine workload, once per file. The host is made as the extension will make it once 31-23 configures the replica storage: its
 * SecretStorage as the head store, and a global storage folder for shared projects.
 */
let workload: Promise<Workload> | undefined;
function runWorkload(): Promise<Workload> {
  workload ??= (async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'near-ai-parity-'));
    const root = path.join(base, 'project');
    const global = path.join(base, 'global');
    await mkdir(root, { recursive: true });
    const secrets = memorySecrets();
    const signer = testSigner();
    const clock = { now: Date.parse('2026-11-18T12:00:00.000Z') };
    const make = (): StaffHost => new StaffHost({
      root, signer: async () => signer, keyStatus: async () => trusting(signer), headStore: secrets, now: () => { clock.now += 1000; return clock.now; },
      replica: { globalStorageDir: global }
    });
    const world: StaffWorld = {
      root, signer, clock, host: make(), headStore: secrets,
      reload: () => { world.host = make(); return world.host; },
      person: (name = 'A. Demo', role = DECISION_ROLE) => ({ kind: 'person', name, role, deviceFingerprint: signer.fingerprint })
    };
    const keysBefore = [...secrets.values.keys()];
    assert.equal(await world.host.isSharedProject(), false);

    // A product through every step: propose, the guard's verdict, submit, a person's approval and release.
    await writeBody(root, 'j5', CONOPS, CLEAN_BODY);
    const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan' }, 'lead-planner'), 'propose'));
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE, options: [{ label: 'COA 1', risk: 'Moderate' }], dissent: [] }, 'lead-planner'), 'submit');
    for (const action of ['approve', 'release'] as const) {
      const decided = await world.host.decide(world.person(), { product: CONOPS, action, hash });
      assert.ok(decided.ok, decided.ok ? '' : decided.message);
    }
    // A PIR decision and a watch decision, signed into the decision log.
    await mkdir(path.dirname(path.join(root, registerPath('pir-register'))), { recursive: true });
    await writeFile(path.join(root, registerPath('pir-register')), renderRegister('pir-register', [PIR]));
    const pir = await world.host.decidePir(world.person('Exercise Commander', DECISION_ROLE), { pir: 'PIR-1', decision: 'approved' });
    assert.ok(pir.ok, pir.ok ? '' : pir.message);
    const watch = await world.host.signWatchDecision(world.person(), { watch: 'watch-bridge', decision: 'approved', wording: createHash('sha256').update('watch the bridge').digest('hex'), reasons: [] });
    assert.ok(watch.ok, watch.ok ? '' : watch.message);
    // A wargame turn and a calculator record.
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__wargame', { action: 'record', phase: TURN }, 'plans-writer'), 'wargame');
    await writeFactors(root, [FUEL]);
    must(await callLogistics(world, J4_TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer'), 'calc_run');

    // Use This Branch's Ledger: the ledger goes back to an older branch's copy, the check offers it, and a person uses it.
    const ledgerFile = path.join(root, LEDGER_DIR, LEDGER_FILE);
    const older = await readFile(ledgerFile, 'utf8');
    await writeBody(root, 'j5', 'annex-e', CLEAN_BODY);
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'annex-e', kind: 'annex' }, 'lead-planner'), 'propose annex-e');
    await writeFile(ledgerFile, older);
    const check = await world.host.branchLedgerCheck();
    assert.equal(check.kind, 'other-copy');
    if (check.kind !== 'other-copy') throw new Error('unreachable');
    const used = await world.host.adoptBranchLedger(world.person(), { head: check.head, entries: check.entries });
    assert.ok(used.ok, used.ok ? '' : used.message);

    // Set Aside: the ledger is kept beside itself and a new one starts with the next product.
    const setAside = await world.host.setAsideLedger();
    assert.ok(setAside, 'the ledger was set aside and kept');
    await writeBody(root, 'j5', 'annex-f', CLEAN_BODY);
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'annex-f', kind: 'annex' }, 'lead-planner'), 'propose annex-f');

    // The reads a Staff Room makes, after a reload as after a window reload.
    world.reload();
    await world.host.snapshot();
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__status', { product: 'annex-f' }, 'lead-planner'), 'status');
    assert.equal(await world.host.isSharedProject(), false);
    return { world, global, secrets, keysBefore, setAside };
  })();
  return workload;
}

/** Every file under .planning/staff, by path from the project root. */
function staffFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.push(path.relative(root, file).split(sep).join('/'));
    }
  };
  walk(path.join(root, '.planning', 'staff'));
  return out.sort();
}

const SECTION = '(?:command|j1|j2|j3|j4|j5|j6|j7|j8|j9|special-staff)';
const SLUG = '[a-z0-9][a-z0-9-]*';
const TIME = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
/**
 * The layouts today's host writes, from the staff host's header comment (src/staff/staffHost.ts) and the logistics host's (src/staff/logisticsHost.ts),
 * plus the lock files the file locks leave behind. Nothing else may appear.
 */
const TODAY_LAYOUTS: ReadonlyArray<[string, RegExp]> = [
  ['products', new RegExp(`^\\.planning/staff/products/${SECTION}/${SLUG}\\.md$`)],
  ['gate reports', new RegExp(`^\\.planning/staff/products/${SECTION}/(?:guard|tradecraft)/${SLUG}-v\\d+\\.md$`)],
  ['J2 registers', /^\.planning\/staff\/products\/j2\/(?:source-register|pir-register|collection-plan)\.json$/],
  ['proposals', new RegExp(`^\\.planning/staff/proposals/${SLUG}/[^/]+$`)],
  ['the product ledger', /^\.planning\/staff\/ledger\/products\.jsonl$/],
  ['set-aside copies', new RegExp(`^\\.planning/staff/ledger/products\\.set-aside-${TIME}\\.jsonl$`)],
  ['the decision log', /^\.planning\/staff\/ledger\/decisions\.jsonl$/],
  ['the calculator ledger', /^\.planning\/staff\/ledger\/calculator\.jsonl$/],
  ['the event log', /^\.planning\/staff\/ledger\/events\.jsonl$/],
  ['the wargame ledger', /^\.planning\/staff\/wargame\/ledger\.jsonl$/],
  ['calculator records', new RegExp(`^\\.planning/staff/calculator/${SLUG}\\.json$`)],
  ['LOGSTAT', new RegExp(`^\\.planning/staff/logistics/logstat/(?:reports/${SLUG}\\.json|validation\\.jsonl)$`)],
  ['the road graph', /^\.planning\/staff\/logistics\/roads\.json$/],
  ['real entities', /^\.planning\/staff\/real-entities\.txt$/],
  ['file locks', /^\.planning\/staff\/(?:ledger|wargame|products\/[a-z0-9]+)\/[a-z.-]+\.lock$/]
];

test('a full single-machine workload leaves no replica or legacy folder, no new kind of secret, nothing in global storage and no replica module loaded', async () => {
  const { world, global, secrets, keysBefore } = await runWorkload();
  assert.equal(existsSync(path.join(world.root, REPLICA_DIR)), false, 'no .planning/staff/replica folder');
  assert.equal(existsSync(path.join(world.root, REPLICA_PROJECT_FILE)), false);
  assert.equal(existsSync(path.join(world.root, LEGACY_DIR)), false, 'no .planning/staff/legacy folder');
  assert.equal(existsSync(global), false, 'nothing is written in the extension\'s global storage for a project that is not shared');
  // Today's code writes only the product ledger's signed head (the device identity lives elsewhere; this host's signer is not in SecretStorage).
  assert.deepEqual(keysBefore, []);
  const keys = [...secrets.values.keys()];
  assert.ok(keys.length >= 1, 'the head mark is kept');
  for (const key of keys) assert.match(key, new RegExp(`^${LEDGER_HEAD_SECRET_PREFIX.replace(/\./g, '\\.')}[0-9a-f]{32}$`), key);
  assert.deepEqual(replicaModules(), [], 'no module from src/staff/replica was loaded');
});

test('every path under .planning/staff is one of today\'s layouts, and every ledger verifies with today\'s verifier', async () => {
  const { world, setAside } = await runWorkload();
  const files = staffFiles(world.root);
  for (const file of files) assert.ok(TODAY_LAYOUTS.some(([, pattern]) => pattern.test(file)), `${file} is one of today's layouts`);
  for (const expected of [`${LEDGER_DIR}/${LEDGER_FILE}`, `${LEDGER_DIR}/${DECISION_LOG_FILE}`, `${LEDGER_DIR}/calculator.jsonl`, `${LEDGER_DIR}/events.jsonl`, `${WARGAME_DIR}/${WARGAME_FILE}`, setAside]) {
    assert.ok(files.includes(expected), `${expected} was written`);
  }
  // The product ledger with its recorded head, as today's host reads it.
  const replay = await world.host.replay();
  assert.equal(replay.broken, undefined);
  assert.deepEqual([...replay.products.keys()], ['annex-f']);
  const status = trusting(world.signer);
  const lines = (text: string): unknown[] => text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as unknown);
  // The set-aside copy on its own: the adopted older branch's ledger, every signature and the whole chain.
  const kept = replayLedger(lines(readFileSync(path.join(world.root, setAside), 'utf8')), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status }));
  assert.equal(kept.broken, undefined);
  assert.ok(kept.products.has(CONOPS));
  assert.equal(kept.products.get(CONOPS)?.record.state, 'released');
  const decisions = replayPersonDecisions(lines(readFileSync(path.join(world.root, LEDGER_DIR, DECISION_LOG_FILE), 'utf8')), (envelope) => verifyPayload(envelope, { purpose: 'staff-decision', status }));
  assert.equal(decisions.broken, undefined);
  assert.deepEqual([...decisions.decisions.values()].map((entry) => entry.subject.kind).sort(), ['ledger-head', 'pir', 'watch']);
  const calculator = await replayCalculatorLedger(world.root, status);
  assert.equal(calculator.broken, undefined);
  assert.equal(calculator.entries, 1);
  assert.equal((await world.host.wargameEntries()).length, 1);
});

test('a host of a project that is not shared answers as today with or without the replica storage, and closing it is a no-op', async () => {
  const { world } = await runWorkload();
  const plain = new StaffHost({ root: world.root, signer: async () => world.signer, keyStatus: async () => trusting(world.signer), headStore: world.headStore });
  const withStorage = world.host;
  assert.deepEqual(await withStorage.replay(), await plain.replay());
  const strip = (snapshot: Awaited<ReturnType<StaffHost['snapshot']>>) => ({ registry: snapshot.registry, decisions: snapshot.decisions, ledgerProblem: snapshot.ledgerProblem });
  assert.deepEqual(strip(await withStorage.snapshot()), strip(await plain.snapshot()));
  assert.deepEqual(await withStorage.branchLedgerCheck(), await plain.branchLedgerCheck());
  await withStorage.close();
  assert.deepEqual(replicaModules(), [], 'still no replica module loaded');
});

// The sections the layout list allows are the staff host's own section ids: a new section would need a new pattern, not a silent pass.
test('the layout list names every staff section id', async () => {
  const { STAFF_SECTION_IDS } = await import('../domain/staff/doctrine');
  for (const section of STAFF_SECTION_IDS as readonly StaffSectionId[]) assert.match(`.planning/staff/products/${section}/x.md`, TODAY_LAYOUTS[0][1], section);
});

test('the module check finds a replica module once one is loaded (run last: it proves the detector the first test relies on)', () => {
  assert.deepEqual(replicaModules(), []);
  require('../staff/replica/projection');
  assert.ok(replicaModules().some((file) => file.endsWith(`${sep}staff${sep}replica${sep}projection.js`)), replicaModules().join(', '));
});

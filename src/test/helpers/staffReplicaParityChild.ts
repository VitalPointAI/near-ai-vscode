// The single-machine workload of the D-29 parity test (src/test/staffReplicaParity.test.ts), and a fork target that runs the test's module checks in
// a process of its own (Phase 32, D-10). A module check made in the test process itself depends on what ran before it in that process: the detector
// proof had to load a replica module there, so the check passed only while that proof ran last. Each check now starts a fresh process, which reports
// the modules from src/staff/replica it loaded, and the test process never loads one at all.
//
// This file imports nothing from src/staff/replica (or a module that does), as the test did. It has no .test suffix on purpose so the test glob does
// not run it as a suite, and the fork entry only starts when it is the entry point of a forked process.
//
// Arguments: <mode>, one of 'workload' (run the whole workload, close the host, report) or 'detector' (load projection, report).
// Message: { type: 'modules', modules } with every loaded module under staff/replica, or { type: 'error', message }.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { registerPath, renderRegister } from '../../domain/staff/intel';
import type { PirEntry } from '../../domain/staff/intel';
import type { PlanningFactor } from '../../domain/staff/logistics';
import { LEDGER_DIR, LEDGER_FILE, StaffHost } from '../../staff/staffHost';
import type { StaffTeamInfo } from '../../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, testSigner, trusting, writeBody, writeFactors } from './staffFixtures';
import type { StaffWorld } from './staffFixtures';

export const CONOPS = 'concept-of-operations';
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

/** Every module in this process's cache whose path is under src/staff/replica (compiled: dist/staff/replica). */
export function replicaModules(): string[] {
  return Object.keys(require.cache).filter((file) => file.includes(REPLICA_MODULE));
}

function must(result: { ok: boolean; text: string }, what: string): string {
  assert.ok(result.ok, `${what}: ${result.text}`);
  return result.text;
}

export interface Workload {
  readonly world: StaffWorld;
  readonly global: string;
  readonly secrets: ReturnType<typeof memorySecrets>;
  readonly keysBefore: string[];
  readonly setAside: string;
}

/**
 * The whole single-machine workload, once per process. The host is made as the extension will make it once 31-23 configures the replica storage: its
 * SecretStorage as the head store, and a global storage folder for shared projects.
 */
let workload: Promise<Workload> | undefined;
export function runWorkload(): Promise<Workload> {
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
export function staffFiles(root: string): string[] {
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
export const TODAY_LAYOUTS: ReadonlyArray<[string, RegExp]> = [
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

export type ParityChildMode = 'workload' | 'detector';
export type ParityChildMessage = { type: 'modules'; modules: string[] } | { type: 'error'; message: string };

function send(message: ParityChildMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.send === undefined) { resolve(); return; }
    process.send(message, () => { resolve(); });
  });
}

async function main(mode: string): Promise<void> {
  if (mode === 'workload') {
    // The workload as the first parity test runs it, then the host is closed as the extension closes it, and only then are the modules read.
    const { world } = await runWorkload();
    await world.host.close();
  } else if (mode === 'detector') {
    // The detector's proof: a replica module, once loaded, is found by the same read.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../staff/replica/projection');
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  await send({ type: 'modules', modules: replicaModules() });
  process.exit(0);
}

if (require.main === module) {
  main(process.argv[2] ?? '').catch(async (error: unknown) => {
    await send({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    process.exit(1);
  });
}

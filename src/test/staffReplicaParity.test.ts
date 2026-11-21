// D-29 parity (plan 31-21; Pitfall 8, P-31-29): a staff project that never turns multi-user is untouched by the shared-project code. A full
// single-machine workload (propose, gate verdicts, submit, approve, release, a PIR decision, a watch decision, a wargame turn, a calculator record,
// Use This Branch's Ledger and Set Aside) runs on a host given the replica storage the extension will give every host (31-23), and leaves no replica or
// legacy folder, no SecretStorage key today's code does not write, nothing in the extension's global storage, and no module from src/staff/replica in
// the module cache. Every path under .planning/staff is one of the layouts today's host writes, and every ledger verifies with today's verifier.
//
// This file imports nothing from src/staff/replica (or a module that does). Every module check runs in a forked child process (D-10, the decode
// host's pattern): one runs the whole workload and reports the replica modules it loaded, one proves the detector by loading projection, and the last
// test checks that this process itself loaded none. So no check depends on the order the tests run in or on sharing one process.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import type { StaffSectionId } from '../domain/staff/doctrine';
import { replayLedger } from '../domain/staff/ledger';
import { LEGACY_DIR, REPLICA_DIR, REPLICA_PROJECT_FILE } from '../domain/staff/multiUser';
import { DECISION_LOG_FILE, replayPersonDecisions } from '../domain/staff/personDecisions';
import { verifyPayload } from '../domain/team/signedPayload';
import { replayCalculatorLedger } from '../staff/logisticsHost';
import { LEDGER_DIR, LEDGER_FILE, LEDGER_HEAD_SECRET_PREFIX, StaffHost, WARGAME_DIR, WARGAME_FILE } from '../staff/staffHost';
import { trusting } from './helpers/staffFixtures';
import { CONOPS, replicaModules, runWorkload, staffFiles, TODAY_LAYOUTS } from './helpers/staffReplicaParityChild';
import type { ParityChildMessage, ParityChildMode } from './helpers/staffReplicaParityChild';

const sep = path.sep;
/** How long one child may take to run its check and reply. The whole workload takes well under a second; this bounds a child that hangs. */
const CHILD_TIME_LIMIT_MS = 60_000;

/**
 * Forks the parity child in the given mode and resolves with the replica modules it reports. A child that exits without replying, replies with an
 * error, or runs past the time limit rejects with its stderr, so the test fails instead of hanging.
 */
function childModules(mode: ParityChildMode): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = fork(path.join(__dirname, 'helpers', 'staffReplicaParityChild.js'), [mode], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    let settled = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const finish = (error: Error | undefined, modules?: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(modules ?? []);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`the ${mode} child did not reply within ${CHILD_TIME_LIMIT_MS} ms; stderr: ${stderr}`));
    }, CHILD_TIME_LIMIT_MS);
    child.on('message', (message: ParityChildMessage) => {
      if (message.type === 'modules') finish(undefined, message.modules);
      else finish(new Error(`the ${mode} child failed: ${message.message}; stderr: ${stderr}`));
    });
    child.on('error', (error) => finish(new Error(`the ${mode} child could not run: ${error.message}; stderr: ${stderr}`)));
    child.on('close', (code, signal) => finish(new Error(`the ${mode} child exited (${code ?? signal}) without replying; stderr: ${stderr}`)));
  });
}

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
  // The same workload in a fresh process, with the host closed at the end, loads no module from src/staff/replica.
  assert.deepEqual(await childModules('workload'), [], 'no module from src/staff/replica was loaded');
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

test('a host of a project that is not shared answers as today with or without the replica storage, and invalidating or closing it is a no-op', async () => {
  const { world } = await runWorkload();
  const plain = new StaffHost({ root: world.root, signer: async () => world.signer, keyStatus: async () => trusting(world.signer), headStore: world.headStore });
  const withStorage = world.host;
  assert.deepEqual(await withStorage.replay(), await plain.replay());
  const strip = (snapshot: Awaited<ReturnType<StaffHost['snapshot']>>) => ({ registry: snapshot.registry, decisions: snapshot.decisions, ledgerProblem: snapshot.ledgerProblem });
  assert.deepEqual(strip(await withStorage.snapshot()), strip(await plain.snapshot()));
  assert.deepEqual(await withStorage.branchLedgerCheck(), await plain.branchLedgerCheck());
  // Forgetting a shared project it never opened is harmless and loads nothing (32-05, D-09); close() goes through it.
  await withStorage.invalidateShared();
  await withStorage.close();
});

// The sections the layout list allows are the staff host's own section ids: a new section would need a new pattern, not a silent pass.
test('the layout list names every staff section id', async () => {
  const { STAFF_SECTION_IDS } = await import('../domain/staff/doctrine');
  for (const section of STAFF_SECTION_IDS as readonly StaffSectionId[]) assert.match(`.planning/staff/products/${section}/x.md`, TODAY_LAYOUTS[0][1], section);
});

// The detector the module checks rely on, proved in a child of its own: a replica module once loaded is found by the same read.
test('the module check finds a replica module once one is loaded', async () => {
  const modules = await childModules('detector');
  assert.ok(modules.some((file) => file.endsWith(`${sep}staff${sep}replica${sep}projection.js`)), modules.join(', '));
});

test('the test process itself loaded no module from src/staff/replica', () => {
  assert.deepEqual(replicaModules(), [], 'the test process loaded a replica module');
});

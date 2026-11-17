// The gate at activation (GATE-04, GATE-07, OFFL-02, D-13, D-14): registerGate never throws out of activation, a start that goes wrong leaves the gate
// failed-closed (reading and planning only) with a plain message and a record, a fresh install's first start is on the record, and the gate starts before
// Team Mode.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DecisionRecord } from '../domain/gate/record';
import { DECISIONS_DIR, projectLogKey } from '../gate/decisionLog';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
test.after(() => { uninstall(); });

async function linesOf(storage: string, root: string): Promise<DecisionRecord[]> {
  const file = path.join(storage, 'gate', DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
}

async function settle(host: { flush(): Promise<void> }): Promise<void> {
  await host.flush();
}

test('a fresh install\'s first start signs its bundle, shows nothing, and records policy.created in the open project\'s log', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-act-'));
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-act-project-'));
  stub.setWorkspaceFolders([root]);
  const messages: string[] = [];
  const host = gateCommands.registerGate(createFakeContext(storage, new MemorySecrets()) as never, { notify: (message) => messages.push(message) });
  const state = await host.state();
  await settle(host);
  assert.equal(state.state, 'valid');
  assert.deepEqual(messages, []);
  const records = await linesOf(storage, root);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.api.operation, 'policy.created');
  assert.equal(records[0]?.action_id, 1);
});

test('a start that throws does not stop activation: the gate fails closed with a plain message and a record', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-act-'));
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-act-project-'));
  stub.setWorkspaceFolders([root]);
  const messages: string[] = [];
  // The first reading of the clock is inside ensurePolicyBundle: it throws there, as a file or lock error would, and works afterwards.
  let reads = 0;
  const now = (): Date => { reads += 1; if (reads === 1) throw new Error('simulated disk failure'); return new Date(); };
  let host: ReturnType<typeof gateCommands.registerGate> | undefined;
  assert.doesNotThrow(() => { host = gateCommands.registerGate(createFakeContext(storage, new MemorySecrets()) as never, { notify: (message) => messages.push(message), now }); });
  const state = await (host as NonNullable<typeof host>).state();
  await settle(host as NonNullable<typeof host>);
  assert.equal(state.state, 'failed-closed');
  assert.equal(state.state === 'failed-closed' ? state.reason : '', 'identity-unavailable');
  assert.deepEqual(messages, [state.state === 'failed-closed' ? state.sentence : '']);
  const records = await linesOf(storage, root);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.api.operation, 'policy.load');
  assert.equal(records[0]?.action_id, 2);
  assert.equal(records[0]?.authorizations[0]?.policy.name, 'bundle.failed-closed');
  assert.equal(records[0]?.status_detail, state.state === 'failed-closed' ? state.sentence : '');
});

test('a storage folder that cannot be used (a file where the folder should be) still leaves activation finished and the gate failed-closed', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-act-'));
  const storage = path.join(base, 'not-a-folder');
  await writeFile(storage, 'in the way', 'utf8');
  stub.setWorkspaceFolders([]);
  const messages: string[] = [];
  let host: ReturnType<typeof gateCommands.registerGate> | undefined;
  assert.doesNotThrow(() => { host = gateCommands.registerGate(createFakeContext(storage, new MemorySecrets()) as never, { notify: (message) => messages.push(message) }); });
  const state = await (host as NonNullable<typeof host>).state();
  assert.equal(state.state, 'failed-closed');
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0] ?? '', /ENOTDIR|\//, 'the message is plain words, not an error code or a path');
  const runtime = await (host as NonNullable<typeof host>).runtimeFor({ root: base, actor: { kind: 'agent', sessionId: 's' }, presence: 'person', context: 'interactive' });
  assert.equal(runtime.bundleState().state, 'failed-closed');
});

test('activation starts the gate once, before Team Mode', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
  const gateAt = source.indexOf('registerGate(context)');
  const teamAt = source.indexOf('registerTeamMode(context)');
  assert.equal(source.split('registerGate(').length - 1, 1);
  assert.ok(gateAt > 0 && teamAt > gateAt, 'registerGate comes before registerTeamMode');
});

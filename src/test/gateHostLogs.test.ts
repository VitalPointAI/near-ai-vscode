// The host keeps a bounded set of decision logs (PR #70 review carry-over): it used to keep one per project root it ever saw, for the whole session. A closed
// folder's log is let go when the window's folders change, and past MAX_PROJECT_LOGS the one used longest ago is let go too. No record is lost either way:
// flush() waits for a log let go with records queued, and a later record (a run still going there, or a new one) opens the log again.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GateRuntime } from '../domain/gate/decide';
import { buildDecisionRecord } from '../domain/gate/record';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY, projectLogKey } from '../gate/decisionLog';
import { GateHost, MAX_PROJECT_LOGS } from '../gate/host';
import { MemorySecrets } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
test.after(() => { uninstall(); });

function record(runtime: GateRuntime, callId: string): void {
  runtime.sink.record(buildDecisionRecord({
    recordId: callId, sequence: 0, time: 1_700_000_000_000, productVersion: '0.0.0-test', actor: runtime.actor, callId,
    capability: { verb: 'read', paths: ['a.md'] }, resource: { name: 'a.md', type: 'file' }, outcome: 'allowed', rule: 'settings.read-plan', bundleHash: ''
  }));
}

function runtimeIn(host: GateHost, root: string): Promise<GateRuntime> {
  return host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 's' }, presence: 'person', context: 'interactive' });
}

async function linesOf(storage: string, root: string): Promise<number> {
  const file = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.trim() === '' ? 0 : text.trim().split('\n').length;
}

async function newHost(extra: Partial<ConstructorParameters<typeof GateHost>[0]> = {}): Promise<{ host: GateHost; storage: string }> {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-host-logs-'));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.0.0-test', ...extra });
  await host.start();
  return { host, storage };
}

test('the host holds at most MAX_PROJECT_LOGS project logs, lets go of the one used longest ago, and loses no record', async () => {
  const { host, storage } = await newHost();
  const roots = Array.from({ length: MAX_PROJECT_LOGS + 4 }, (_, index) => path.join(storage, `project-${index}`));
  for (const root of roots) record(await runtimeIn(host, root), `c-${path.basename(root)}`);
  const projects = host.openLogKeys().filter((key) => key !== INSTALL_LOG_KEY);
  assert.equal(projects.length, MAX_PROJECT_LOGS);
  assert.deepEqual(projects, roots.slice(-MAX_PROJECT_LOGS).map((root) => projectLogKey(root)), 'the most recently used are kept');
  assert.ok(host.openLogKeys().includes(INSTALL_LOG_KEY), 'the install log is never let go');
  await host.flush();
  for (const root of roots) assert.equal(await linesOf(storage, root), 1, `${path.basename(root)}'s record was written`);
  // A folder used again moves to the end and opens its log again.
  record(await runtimeIn(host, roots[0] as string), 'again');
  await host.flush();
  assert.equal(host.openLogKeys().at(-1), projectLogKey(roots[0] as string));
  assert.equal(await linesOf(storage, roots[0] as string), 2, 'the reopened log goes on from the same file');
});

test('retainProjectLogs lets go of a closed folder\'s log; a run still going there opens it again with its next record, and flush waits for both', async () => {
  const { host, storage } = await newHost();
  const open = path.join(storage, 'open');
  const closed = path.join(storage, 'closed');
  const inOpen = await runtimeIn(host, open);
  const inClosed = await runtimeIn(host, closed);
  record(inClosed, 'before');
  host.retainProjectLogs([open]);
  assert.ok(!host.openLogKeys().includes(projectLogKey(closed)), 'the closed folder\'s log is let go');
  assert.ok(host.openLogKeys().includes(projectLogKey(open)));
  record(inClosed, 'after');
  record(inOpen, 'open');
  await host.flush();
  assert.equal(await linesOf(storage, closed), 2, 'the queued record and the running run\'s next record are both on disk');
  assert.equal(await linesOf(storage, open), 1);
});

test('retainProjectLogs keeps the open project\'s log even when the list given leaves it out', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-host-logs-open-'));
  const open = path.join(storage, 'open');
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.0.0-test', projectRoot: () => open });
  await host.start();
  record(await runtimeIn(host, open), 'c');
  host.retainProjectLogs([]);
  assert.ok(host.openLogKeys().includes(projectLogKey(open)));
});

test('activation lets go of a folder\'s log when the window\'s folders change and it is no longer open', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-host-logs-act-'));
  const first = path.join(storage, 'first');
  const second = path.join(storage, 'second');
  stub.setWorkspaceFolders([first, second]);
  try {
    const host = gateCommands.registerGate(createFakeContext(storage, new MemorySecrets()) as never, { notify: () => undefined });
    await host.state();
    record(await runtimeIn(host, first), 'a');
    record(await runtimeIn(host, second), 'b');
    assert.ok(host.openLogKeys().includes(projectLogKey(second)));
    stub.setWorkspaceFolders([first]);
    assert.ok(!host.openLogKeys().includes(projectLogKey(second)), 'the removed folder\'s log is let go');
    assert.ok(host.openLogKeys().includes(projectLogKey(first)), 'the folder still open keeps its log');
    await host.flush();
    assert.equal(await linesOf(storage, second), 1, 'its record was written first');
    assert.ok((await readdir(path.join(storage, GATE_DIR_NAME, DECISIONS_DIR))).includes(`${INSTALL_LOG_KEY}.jsonl`));
  } finally {
    stub.setWorkspaceFolders([]);
  }
});

// PR #74 review round 2: every runtime the host hands out keeps its records, whatever kind of run it is for. A window with no folder used to record nothing
// (its sink wrote only when the request named a folder), though its log is the install log. Each kind is listed here, and each record is found on disk in
// the log the runtime's key names.
test('every kind of runtime the host hands out writes its records to disk: folder, no folder, sub-agent, nobody present, with and without a folder', async () => {
  const { host, storage } = await newHost();
  const project = path.join(storage, 'project-kinds');
  const { unattendedRuntimeFor } = await import('../gate/host');
  const kinds: Array<[string, Promise<GateRuntime>, string]> = [
    ['folder', host.runtimeFor({ root: project, actor: { kind: 'agent', sessionId: 'lead' }, presence: 'person', context: 'interactive' }), projectLogKey(project)],
    ['no folder', host.runtimeFor({ actor: { kind: 'agent', sessionId: 'lead' }, presence: 'person', context: 'interactive' }), INSTALL_LOG_KEY],
    ['sub-agent', host.runtimeFor({ root: project, actor: { kind: 'sub-agent', sessionId: 'lead', agentId: 'helper-1' }, presence: 'person', context: 'interactive' }), projectLogKey(project)],
    ['sub-agent, no folder', host.runtimeFor({ actor: { kind: 'sub-agent', sessionId: 'lead', agentId: 'helper-2' }, presence: 'person', context: 'interactive' }), INSTALL_LOG_KEY],
    ['nobody present', unattendedRuntimeFor(host, project, 'compare', 'comparison'), projectLogKey(project)],
    ['nobody present, no folder', unattendedRuntimeFor(host, undefined, 'compare', 'comparison'), INSTALL_LOG_KEY],
    ['nobody present, empty folder', unattendedRuntimeFor(host, '', 'compare', 'comparison'), INSTALL_LOG_KEY]
  ];
  for (const [name, runtime] of kinds) record(await runtime, `kind-${name}`);
  await host.flush();
  for (const [name, , key] of kinds) {
    const file = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR, `${key}.jsonl`);
    const text = await readFile(file, 'utf8').catch(() => '');
    assert.ok(text.includes(`"kind-${name}"`), `${name}: its record is in ${key === INSTALL_LOG_KEY ? 'the install log' : 'the project log'}`);
  }
  // A no-folder runtime whose install log was never opened before still opens it by its key at its first record (nothing is held from setup time).
  const fresh = await newHost();
  record(await fresh.host.runtimeFor({ actor: { kind: 'agent', sessionId: 'x' }, presence: 'person', context: 'interactive' }), 'first-no-folder');
  await fresh.host.flush();
  const installText = await readFile(path.join(fresh.storage, GATE_DIR_NAME, DECISIONS_DIR, `${INSTALL_LOG_KEY}.jsonl`), 'utf8');
  assert.ok(installText.includes('"first-no-folder"'));
});

// PR #74 review round 4: one log per key. A log let go with records still queued used to be replaced at once by a new log for the same key, so two writers
// queued records for one file and the order on disk could differ from the order the records were made in. Now a reopen takes back the log being let go,
// and it is let go for good only after its queue is written.
test('a log let go and reopened at once keeps one writer: records land in the order they were made, numbered without a gap', async () => {
  const { host, storage } = await newHost();
  const root = path.join(storage, 'project-reopen');
  const runtime = await runtimeIn(host, root);
  const made: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    for (let index = 0; index < 25; index += 1) { const id = `r${round}-${index}`; made.push(id); record(runtime, id); }
    host.retainProjectLogs([]); // the folder is closed with records still queued
    for (let index = 0; index < 25; index += 1) { const id = `r${round}-again-${index}`; made.push(id); record(runtime, id); }
  }
  await host.flush();
  const file = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { api: { request: { uid: string } }; metadata: { sequence: number } });
  assert.deepEqual(lines.map((line) => line.api.request.uid), made, 'one writer: the order on disk is the order the records were made');
  assert.deepEqual(lines.map((line) => line.metadata.sequence), made.map((_id, index) => index + 1), 'numbered 1, 2, 3, ... with no gap or repeat');
  assert.ok(host.openLogKeys().includes(projectLogKey(root)), 'the reopened log is held');
});

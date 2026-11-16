// A window with no folder open (GATE-04, GATE-07, OFFL-02): the policy is per install and lives in global storage, so a run is decided by the real one there
// too. Only the project's decision log is missing. A path with no host at all is failed closed instead (gateEnumeration.test.ts).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decide } from '../domain/gate/decide';
import { GateHost, unattendedRuntimeFor } from '../gate/host';
import { DECISIONS_DIR, INSTALL_LOG_KEY } from '../gate/decisionLog';
import { gateDir } from '../gate/bundleStore';
import { MemorySecrets } from './helpers/teamHarness';

const REPO = path.resolve(__dirname, '..', '..');

async function started(): Promise<{ host: GateHost; storage: string }> {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-nofolder-'));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.0.0-test' });
  await host.start();
  return { host, storage };
}

test('a run nobody watches in a window with no folder is decided by the install\'s real policy, not refused and not guessed', async () => {
  const { host, storage } = await started();
  const real = host.bundleState();
  assert.equal(real.state, 'valid');
  for (const root of [undefined, '']) {
    const runtime = await unattendedRuntimeFor(host, root, 'compare-1', 'compare m t');
    assert.equal(runtime.presence, 'none');
    assert.equal(runtime.context, 'unattended');
    const seen = runtime.bundleState();
    assert.equal(seen.state, 'valid');
    assert.equal(seen.state === 'valid' ? seen.hash : '', real.state === 'valid' ? real.hash : 'none', 'the same bundle the host read from disk');
    const decided = await decide({
      actor: runtime.actor, tool: 'Write', callId: 'c1', effects: [{ verb: 'workspaceWrite', paths: ['out.md'] }], context: runtime.context, presence: runtime.presence,
      policy: { mode: 'fully-autonomous', emergencyStop: false }
    }, runtime.bundleState(), async () => ({ decision: 'allow', rule: 'settings.mode.fully-autonomous' }), { floorMode: runtime.floorMode });
    assert.equal(decided.outcome, 'allow');
  }
  await host.flush();
  // Changed on purpose (PR #70 second review, item 4): the policy's own events are per install, so the install-level log exists even with no folder open;
  // what must not exist is a project log, and the decisions of these runs are not written anywhere.
  const logs = existsSync(path.join(gateDir(storage), DECISIONS_DIR)) ? readdirSync(path.join(gateDir(storage), DECISIONS_DIR)) : [];
  assert.deepEqual(logs, [`${INSTALL_LOG_KEY}.jsonl`], 'no project, so no project log was made; only the install log holds the policy\'s own events');
});

test('a bundle that failed to load fails a window with no folder closed too, with its own sentence', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-nofolder-'));
  const secrets = new MemorySecrets();
  secrets.store = async () => { throw new Error('keyring refused'); };
  const host = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test' });
  const runtime = await unattendedRuntimeFor(host, undefined, 'roles-1', 'reviewer on m');
  const state = runtime.bundleState();
  assert.equal(state.state, 'failed-closed');
});

test('the comparison panel and the team studio make a host runtime with or without a folder, not only when a folder is open', () => {
  for (const file of ['src/services/modelComparisonPanel.ts', 'src/services/teamStudioPanel.ts']) {
    const text = readFileSync(path.join(REPO, file), 'utf8');
    assert.ok(text.includes('unattendedRuntimeFor('), `${file} builds its runs' runtime through the host helper`);
    assert.doesNotMatch(text, /gateHost && root/, `${file} does not skip the gate in a window with no folder`);
    assert.doesNotMatch(text, /return root \? .*runtimeFor/, `${file} does not return nothing for a window with no folder`);
  }
});

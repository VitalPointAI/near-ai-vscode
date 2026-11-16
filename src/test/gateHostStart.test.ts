// A run that starts while the gate is still checking its policy (GATE-07, OFFL-02): the host waits a short, named time for the check, so a healthy install
// is never refused for starting a run during activation, and a check that fails or never ends is a plain failed-closed state, never a guess.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { GateRequest, GateRuntime } from '../domain/gate/decide';
import { GateHost, RUNTIME_START_WAIT_MS } from '../gate/host';
import type { GateHostOptions, RuntimeRequest } from '../gate/host';
import { MemorySecrets } from './helpers/teamHarness';

const REQUEST: RuntimeRequest = { root: path.join(tmpdir(), 'near-ai-gate-start-project'), actor: { kind: 'agent', sessionId: 's' }, presence: 'person', context: 'interactive', floorMode: 'shadow' };
const POLICY = { mode: 'fully-autonomous', emergencyStop: false } as const;

/** Secrets whose reads finish a little late, so the host's start is still running when a run asks for its runtime. */
class SlowSecrets extends MemorySecrets {
  public override async get(key: string): Promise<string | undefined> {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return super.get(key);
  }
}

async function options(secrets: MemorySecrets, extra: Partial<GateHostOptions> = {}): Promise<GateHostOptions> {
  return { globalStorageDir: await mkdtemp(path.join(tmpdir(), 'near-ai-gate-start-')), secrets, productVersion: '0.0.0-test', ...extra };
}

async function writeDecision(runtime: GateRuntime): Promise<ReturnType<typeof decide>> {
  const request: GateRequest = {
    actor: runtime.actor, tool: 'Write', callId: 'c1', effects: [{ verb: 'workspaceWrite', paths: ['out.md'] }], context: runtime.context, presence: runtime.presence, policy: POLICY
  };
  return decide(request, runtime.bundleState(), async () => ({ decision: 'allow', rule: 'settings.mode.fully-autonomous' }), { floorMode: runtime.floorMode });
}

function sentenceOf(state: BundleState): string {
  assert.equal(state.state, 'failed-closed');
  return state.state === 'failed-closed' ? state.sentence : '';
}

test('the wait for the policy check is a named few seconds', () => {
  assert.equal(RUNTIME_START_WAIT_MS, 5000);
});

test('a run that asks for its runtime while the gate is still starting is decided with the real bundle, not refused', async () => {
  const host = new GateHost(await options(new SlowSecrets()));
  const pending = host.runtimeFor(REQUEST);
  const runtime = await pending;
  assert.equal(runtime.bundleState().state, 'valid', 'the start finished first');
  const decided = await writeDecision(runtime);
  assert.equal(decided.outcome, 'allow');
  assert.notEqual(decided.rule, 'bundle.failed-closed');
});

test('a start that ends failed closed gives the run that failure with the bundle\'s own sentence', async () => {
  const secrets = new MemorySecrets();
  secrets.store = async () => { throw new Error('keyring refused'); };
  const host = new GateHost(await options(secrets));
  const runtime = await host.runtimeFor(REQUEST);
  const state = runtime.bundleState();
  assert.equal(state.state, 'failed-closed');
  assert.equal(sentenceOf(state), BUNDLE_FAILURES['identity-unavailable']);
  const decided = await writeDecision(runtime);
  assert.equal(decided.outcome, 'deny');
  assert.equal(decided.rule, 'bundle.failed-closed');
});

class RejectingStart extends GateHost {
  public override start(): Promise<BundleState> { return Promise.reject(new Error('the check fell over')); }
}

class NeverStarts extends GateHost {
  public override start(): Promise<BundleState> { return new Promise<BundleState>(() => undefined); }
}

test('a start that rejects fails the run closed with a plain sentence, never with the error text', async () => {
  const host = new RejectingStart(await options(new MemorySecrets()));
  const runtime = await host.runtimeFor(REQUEST);
  assert.equal(sentenceOf(runtime.bundleState()), BUNDLE_FAILURES['not-loaded']);
  assert.doesNotMatch(sentenceOf(runtime.bundleState()), /fell over/);
  const decided = await writeDecision(runtime);
  assert.equal(decided.outcome, 'deny');
  assert.equal(decided.reason, BUNDLE_FAILURES['not-loaded']);
});

test('a start that never ends fails the run closed once the bound has passed, and not before', async () => {
  const host = new NeverStarts(await options(new MemorySecrets(), { startWaitMs: 60 }));
  const began = Date.now();
  const runtime = await host.runtimeFor(REQUEST);
  const waited = Date.now() - began;
  assert.ok(waited >= 50, `it waited for the bound (${waited} ms)`);
  assert.ok(waited < 2000, `and no longer (${waited} ms)`);
  assert.equal(sentenceOf(runtime.bundleState()), BUNDLE_FAILURES['not-loaded']);
  const reading = await decide({
    actor: runtime.actor, tool: 'Read', callId: 'c2', effects: [{ verb: 'read', paths: ['a.ts'] }], context: runtime.context, presence: runtime.presence, policy: POLICY
  }, runtime.bundleState(), async () => ({ decision: 'allow', rule: 'settings.read-plan' }), { floorMode: runtime.floorMode });
  assert.equal(reading.outcome, 'allow', 'reading and planning still run');
  assert.equal((await writeDecision(runtime)).outcome, 'deny');
});

test('a runtime handed out after a late finish reads the real bundle from then on', async () => {
  const host = new GateHost(await options(new SlowSecrets(), { startWaitMs: 5 }));
  const runtime = await host.runtimeFor(REQUEST);
  assert.equal(sentenceOf(runtime.bundleState()), BUNDLE_FAILURES['not-loaded'], 'refused while the check had not finished');
  await host.start();
  assert.equal(runtime.bundleState().state, 'valid', 'the same runtime sees the real bundle once it is loaded');
});

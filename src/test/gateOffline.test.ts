// OFFL-01: every gate decision is made from local data. fetch, net, dns, http and https are replaced by functions that throw and count their calls, and the
// pure decision functions run over the floor matrix, a bundle check, a route decision and a record. Nothing here opens a socket or reads a key.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
// `import x = require()` hands back the real module object, which the stubs below can replace; an `import * as` namespace is a read-only copy.
import dns = require('node:dns');
import http = require('node:http');
import https = require('node:https');
import net = require('node:net');
import test, { after, before } from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { defaultGateRuntime } from '../agent/gateAdapter';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import type { CompletionEvent, ToolCall } from '../services/nearAiClient';
import { fingerprintOf } from '../domain/team/canonical';
import { NO_KNOWN_KEYS } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import type { ActionPolicy, ActionPolicyMode } from '../domain/policy';
import { bundleHash, defaultBundlePayload, verifyBundleEnvelope } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { GateRequest, SettingsLayer } from '../domain/gate/decide';
import { FLOOR_RULE_ORDER, floorFor } from '../domain/gate/floor';
import { buildDecisionRecord, outcomeOf, validateDecisionRecord } from '../domain/gate/record';
import { DEFAULT_ROUTING, decideRoute } from '../domain/gate/routing';
import type { Capability } from '../domain/gate/vocabulary';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const calls: string[] = [];
const saved: Array<() => void> = [];

// Replace one property with a function that records its name and throws, and remember how to put the original back.
function stub<T extends object>(owner: T, key: string, name: string): void {
  const original = (owner as Record<string, unknown>)[key];
  (owner as Record<string, unknown>)[key] = (): never => {
    calls.push(name);
    throw new Error(`${name} was called by a gate decision`);
  };
  saved.push(() => { (owner as Record<string, unknown>)[key] = original; });
}

before(() => {
  stub(globalThis, 'fetch', 'fetch');
  stub(net, 'connect', 'net.connect');
  stub(net, 'createConnection', 'net.createConnection');
  stub(dns, 'lookup', 'dns.lookup');
  stub(dns.promises, 'lookup', 'dns.promises.lookup');
  stub(http, 'request', 'http.request');
  stub(https, 'request', 'https.request');
});

after(() => {
  for (const restore of saved.reverse()) restore();
});

function makeSigner(): PayloadSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

const allows: SettingsLayer = async () => ({ decision: 'allow', rule: 'settings.mode.fully-autonomous' });
const MODES: readonly ActionPolicyMode[] = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'];

test('the stubs are in place and throw, so a call to any of them would be caught', () => {
  assert.throws(() => (globalThis.fetch as unknown as () => void)(), /fetch was called/);
  assert.throws(() => net.connect(1), /net.connect was called/);
  assert.throws(() => dns.lookup('example.invalid', () => undefined), /dns.lookup was called/);
  assert.throws(() => http.request('http://example.invalid'), /http.request was called/);
  assert.equal(calls.length, 4);
  calls.length = 0;
});

test('decide over the floor matrix, a bundle check, a route decision, floorFor and a record make no network call', async () => {
  const signer = makeSigner();
  const payload = defaultBundlePayload({ issuer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey }, now: NOW });
  const envelope = signPayload(signer, 'policy-bundle', payload, { now: () => new Date(NOW) });
  const active: KeyStatusLookup = (key) => (key.fingerprint === signer.fingerprint ? { state: 'active' } : { state: 'unknown' });
  const state: BundleState = verifyBundleEnvelope(envelope, { status: active, now: NOW });
  assert.equal(state.state, 'valid');
  assert.equal(verifyBundleEnvelope(envelope, { status: NO_KNOWN_KEYS, now: NOW }).state, 'failed-closed');
  assert.equal(createHash('sha256').update(bundleHash(payload)).digest('hex').length, 64);

  const shapes: Capability[][] = [
    [{ verb: 'read', paths: ['.near-ai/state/keys/local.key'] }], [{ verb: 'shell', cwd: 'anywhere' }], [{ verb: 'workspaceWrite', paths: ['.git/hooks/pre-commit'] }],
    [{ verb: 'publish', target: 'registry' }], [{ verb: 'destroy', paths: ['build/**'] }], [{ verb: 'skill.write', scope: 'team' }]
  ];
  let decided = 0;
  for (const effects of shapes) {
    for (const mode of MODES) {
      for (const presence of ['person', 'none'] as const) {
        const policy: ActionPolicy = { mode, emergencyStop: false };
        const request: GateRequest = {
          actor: { kind: 'agent', deviceFingerprint: signer.fingerprint, sessionId: 'session-1' }, tool: 'Tool', callId: 'call-1', effects, command: 'cat ~/.ssh/id_rsa',
          context: presence === 'person' ? 'interactive' : 'unattended', presence, policy
        };
        const decision = await decide(request, state, allows);
        assert.ok(decision.rule.length > 0);
        assert.ok(floorFor(request) !== undefined);
        decided += 1;
      }
    }
  }
  assert.equal(decided, 6 * 4 * 2);
  assert.ok(FLOOR_RULE_ORDER.length > 0);

  // OFFL-01 empty edge: no cached catalog entry for the model. The route is decided from local data alone and the model counts as not private.
  const route = decideRoute(
    [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [], handling: [] }], DEFAULT_ROUTING,
    { clientRoute: 'near', host: 'https://cloud.example', nearEndpoint: true, model: undefined, attestationFailed: false }
  );
  assert.equal(route.allowed, false);
  assert.notEqual(route.tier, 'any-cloud');
  const open = decideRoute([{ scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] }], DEFAULT_ROUTING, {
    clientRoute: 'near', host: 'https://cloud.example', nearEndpoint: true, model: undefined, attestationFailed: false
  });
  assert.equal(open.allowed, true, 'public content may go to any route, even when the model is unknown');

  const record = buildDecisionRecord({
    recordId: 'rec-1', sequence: 0, time: NOW, productVersion: '0.4.25', actor: { kind: 'person', deviceFingerprint: signer.fingerprint, sessionId: 'session-1' },
    callId: 'call-1', capability: { verb: 'plan' }, resource: { name: 'plan', type: 'plan' }, outcome: outcomeOf({ outcome: 'allow', floor: false }), rule: 'settings.read-plan',
    bundleHash: state.state === 'valid' ? state.hash : ''
  });
  assert.equal(validateDecisionRecord(record).ok, true);
});

test('a whole scripted run with Read, Write and Bash calls makes every decision without calling a network function, and each decision comes before its call runs (OFFL-01)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-offline-'));
  await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const turns = [
    { calls: [call('r1', 'Read', { file_path: 'a.ts' }), call('w1', 'Write', { file_path: 'out.md', content: 'x' }), call('b1', 'Bash', { command: 'pwd' })] },
    { text: 'done' }
  ];
  let seen = 0;
  const client = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      const turn = (turns[seen] ?? { text: 'done' }) as { text?: string; calls?: ToolCall[] };
      seen += 1;
      yield { type: 'done', message: { role: 'assistant', content: turn.text ?? null, ...(turn.calls ? { tool_calls: turn.calls } : {}) }, finishReason: turn.calls ? 'tool_calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1, verificationStatus: 'unknown' as const, latencyMs: 1 } };
    }
  };
  const base = defaultGateRuntime({ presence: 'none', context: 'unattended' });
  const order: string[] = [];
  const gate = { ...base, sink: { record: (record: Parameters<typeof base.sink.record>[0]) => { order.push(`decision:${record.api.request.uid}`); base.records.push(record); } } };
  const spied = CORE_TOOLS.map((tool) => ({ ...tool, run: async (input: never, context: never) => { order.push(`run:${tool.name}`); return tool.run(input, context); } }));
  const shell = new ShellSession(root);
  try {
    const result = await new AgentRun({
      client: client as never, model: 'm', tools: spied, context: { root, checkpoints: new RunCheckpoints('offline'), shell, readFiles: new Set() },
      policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gate,
      requestApproval: async () => ({ decision: 'deny' }), emit: () => undefined
    }).run([{ role: 'user', content: 'go' }], new AbortController().signal);
    assert.equal(result.outcome, 'completed');
  } finally {
    shell.dispose();
  }
  assert.equal(base.records.length, 3, 'one decision per call');
  for (const [id, name] of [['r1', 'Read'], ['w1', 'Write'], ['b1', 'Bash']]) {
    assert.ok(order.indexOf(`decision:${id}`) >= 0 && order.indexOf(`decision:${id}`) < order.indexOf(`run:${name}`), `${name}: decision before run in ${order.join(', ')}`);
  }
  assert.deepEqual(calls, [], 'no network function was called by the run or by any of its decisions');
});

test('each of the seven stubs was called 0 times by the decisions', () => {
  for (const name of ['fetch', 'net.connect', 'net.createConnection', 'dns.lookup', 'dns.promises.lookup', 'http.request', 'https.request']) {
    assert.equal(calls.filter((call) => call === name).length, 0, name);
  }
  assert.deepEqual(calls, []);
});

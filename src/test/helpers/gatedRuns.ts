// Runs for tests that are about something other than the gate (Phase 70, review of PR 2). The shipped default for a run with no gate host is failed closed
// (rule `bundle.unavailable`), so a test that builds a run by hand says plainly which policy it runs under: the shipped default bundle, as a fresh install
// signs it, with the floor enforced as it always is. That is an explicit test runtime, never the shipped fallback.
import { AgentRun } from '../../agent/loop';
import type { AgentRunOptions } from '../../agent/loop';
import type { MemoryGateRuntime } from '../../agent/gateAdapter';
import { bundleHash, defaultBundlePayload } from '../../domain/gate/bundle';
import type { BundleState } from '../../domain/gate/bundle';
import type { ActorRef, GateRuntime } from '../../domain/gate/decide';
import type { DecisionRecord } from '../../domain/gate/record';
import { unknownRuleListeners } from '../../domain/gate/record';
import type { GateHost } from '../../gate/host';
import { AgentConversation } from '../../services/agentSession';

// PR #74 review round 11: in the product a record with a rule nobody knows is kept under record.unknown-rule; in any test that runs the gate through this
// helper it fails the test, loudly, so a writer with a new id is caught before it ships.
unknownRuleListeners.add((id) => {
  throw new Error(`A decision record was given a rule nobody knows: "${id}". Add it to GATE_RULE_IDS (src/domain/gate/decide.ts) or name it in gateRecordIds.test.ts.`);
});

const TEST_DEVICE = 'device-test';

/** A valid bundle for tests: the default payload a fresh install signs, never read from or written to disk. */
export function testBundleState(): BundleState {
  const issuer = { fingerprint: TEST_DEVICE, publicKey: 'A'.repeat(43) };
  const payload = defaultBundlePayload({ issuer, now: Date.now() });
  return { state: 'valid', bundle: payload, hash: bundleHash(payload), signer: issuer, expiresAt: payload.expiresAt, renewDue: false };
}

/** An explicit test runtime: the default policy, the floor (always enforced) and an in-memory sink. */
export function testGateRuntime(options: { presence?: GateRuntime['presence']; context?: GateRuntime['context']; actor?: ActorRef } = {}): MemoryGateRuntime {
  const records: DecisionRecord[] = [];
  const state = testBundleState();
  return {
    bundleState: () => state,
    sink: { record: (record) => { records.push(record); } },
    actor: options.actor ?? { kind: 'agent', deviceFingerprint: TEST_DEVICE, sessionId: 'test-session' },
    presence: options.presence ?? 'person',
    context: options.context ?? 'interactive',
    records
  };
}

/** A stand-in for the gate host: every runtime it gives is a test runtime for the request's own presence and context. */
export function testGateHost(): Pick<GateHost, 'runtimeFor'> {
  return {
    runtimeFor: async (request) => testGateRuntime({ presence: request.presence, context: request.context, actor: { ...request.actor, deviceFingerprint: TEST_DEVICE } })
  };
}

/** An AgentRun that runs under the test runtime unless the test gives its own gate. */
export function newTestRun(options: AgentRunOptions): AgentRun {
  return new AgentRun({ gate: testGateRuntime(), ...options });
}

/** An AgentConversation whose runs are decided through the test host. */
export function newTestConversation(...args: ConstructorParameters<typeof AgentConversation>): AgentConversation {
  const conversation = new AgentConversation(...args);
  conversation.gateHost = testGateHost();
  return conversation;
}

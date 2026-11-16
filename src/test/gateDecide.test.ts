// decide() tests (GATE-04, GATE-05, GATE-06, D-08, D-10, D-19, D-43): the layers, in order, over a stubbed settings layer. No key, token or real path is written here.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionPolicy } from '../domain/policy';
import { bundleHash, defaultBundlePayload, failedClosed } from '../domain/gate/bundle';
import type { BundleState, PolicyBundle } from '../domain/gate/bundle';
import { GATE_RULE_IDS, decide, effectiveMode } from '../domain/gate/decide';
import { FLOOR_RULE_ORDER } from '../domain/gate/floor';
import { ROUTE_RULES } from '../domain/gate/routing';
import type { ActorRef, GateRequest, SettingsAnswer, SettingsLayer } from '../domain/gate/decide';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import type { Capability } from '../domain/gate/vocabulary';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const PERSON: ActorRef = { kind: 'person', deviceFingerprint: 'dev-00000000000000000000000000000000', sessionId: 'session-1' };

function validBundleState(): BundleState {
  const payload = defaultBundlePayload({ issuer: { fingerprint: PERSON.deviceFingerprint, publicKey: 'A'.repeat(43) }, now: NOW });
  return {
    state: 'valid', bundle: payload, hash: bundleHash(payload), signer: { fingerprint: PERSON.deviceFingerprint, publicKey: 'A'.repeat(43) },
    expiresAt: payload.expiresAt, renewDue: false
  };
}

const policyOf = (mode: ActionPolicy['mode']): ActionPolicy => ({ mode, emergencyStop: false });

const write = (paths: string[]): Capability => ({ verb: 'workspaceWrite', paths });

function requestFor(effects: Capability[], overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    actor: PERSON, tool: 'Write', callId: 'call-1', effects, context: 'interactive', presence: 'person', policy: policyOf('fully-autonomous'), ...overrides
  };
}

const allows: SettingsLayer = async (): Promise<SettingsAnswer> => ({ decision: 'allow', rule: 'settings.mode.fully-autonomous' });

test('tracer: a protected write in fully-autonomous goes through decide() to an ask with no grant, and comes out as a valid decision record', async () => {
  const state = validBundleState();
  const request = requestFor([write(['.git/hooks/pre-commit'])]);
  const decided = await decide(request, state, allows);
  assert.equal(decided.outcome, 'ask');
  assert.equal(decided.rule, 'floor.protected-write');
  assert.equal(decided.floor, true);
  assert.equal(decided.offerAlwaysAllow, false);
  assert.equal(decided.allowGrant, false);
  const record = buildDecisionRecord({
    recordId: 'rec-1', sequence: 0, time: NOW, productVersion: '0.0.0', actor: PERSON, callId: request.callId, capability: write(['.git/hooks/pre-commit']),
    resource: { name: '.git/hooks/pre-commit', type: 'file' }, outcome: 'asked', rule: decided.rule, bundleHash: state.state === 'valid' ? state.hash : ''
  });
  const checked = validateDecisionRecord(record);
  assert.equal(checked.ok, true);
  assert.equal(record.class_uid, 6003);
  assert.equal(record.status_detail, 'waiting for a person');
  assert.equal(record.authorizations[0]?.policy.name, 'floor.protected-write');
});

test('tracer: the same protected write with nobody present is denied, and the floor decided it', async () => {
  const decided = await decide(requestFor([write(['.git/hooks/pre-commit'])], { presence: 'none' }), validBundleState(), allows);
  assert.equal(decided.outcome, 'deny');
  assert.equal(decided.rule, 'floor.protected-write');
  assert.equal(decided.floor, true);
  assert.match(decided.reason ?? '', /^Nobody is here to approve this, and it always needs a person: /);
  assert.equal(decided.offerAlwaysAllow, false);
  assert.equal(decided.allowGrant, false);
});

test('a plain edit with no floor fact is decided by the settings layer alone', async () => {
  const decided = await decide(requestFor([write(['src/app.ts'])]), validBundleState(), allows);
  assert.equal(decided.outcome, 'allow');
  assert.equal(decided.rule, 'settings.mode.fully-autonomous');
  assert.equal(decided.floor, false);
});

// ---- Task 2: failed-closed bundles, the ceiling, presence, shadow mode and the rule list ----

const SHELL: Capability = { verb: 'shell', cwd: 'anywhere' };

function stateWith(change: (bundle: PolicyBundle) => void): BundleState {
  const payload = defaultBundlePayload({ issuer: { fingerprint: PERSON.deviceFingerprint, publicKey: 'A'.repeat(43) }, now: NOW });
  change(payload);
  return { state: 'valid', bundle: payload, hash: bundleHash(payload), signer: { fingerprint: PERSON.deviceFingerprint, publicKey: 'A'.repeat(43) }, expiresAt: payload.expiresAt, renewDue: false };
}

// A settings layer that behaves like the mode rules of today: fully-autonomous allows, any other mode asks, read and plan always allow.
const byMode: SettingsLayer = async (request, policy): Promise<SettingsAnswer> => {
  if (request.effects.every((effect) => effect.verb === 'read' || effect.verb === 'plan')) return { decision: 'allow', rule: 'settings.read-plan' };
  return policy.mode === 'fully-autonomous' ? { decision: 'allow', rule: 'settings.mode.fully-autonomous' } : { decision: 'ask', rule: 'settings.mode.other' };
};

test('a failed-closed bundle leaves read and plan to the settings layer and denies everything else with its own sentence', async () => {
  const closed = failedClosed('bad-signature');
  const read = await decide(requestFor([{ verb: 'read', paths: ['src/**'] }, { verb: 'plan' }]), closed, allows);
  assert.equal(read.outcome, 'allow');
  assert.equal(read.rule, 'settings.mode.fully-autonomous');
  for (const effects of [[write(['src/app.ts'])], [SHELL], [{ verb: 'read', paths: ['a'] } as Capability, write(['a'])], []]) {
    const denied = await decide(requestFor(effects), closed, allows);
    assert.equal(denied.outcome, 'deny');
    assert.equal(denied.rule, 'bundle.failed-closed');
    assert.equal(denied.reason, closed.sentence);
    assert.equal(denied.floor, false);
  }
});

test('a failed-closed bundle keeps the floor: a read of the key folder is still refused with no card', async () => {
  const decided = await decide(requestFor([{ verb: 'read', paths: ['.near-ai/state/keys/local.key'] }]), failedClosed('expired'), allows);
  assert.equal(decided.outcome, 'deny');
  assert.equal(decided.rule, 'floor.state-keys');
  assert.equal(decided.floor, true);
});

test('effectiveMode is the lower of the setting and the ceiling, in the fixed order', () => {
  const order = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const;
  for (let setting = 0; setting < order.length; setting += 1) {
    for (let ceiling = 0; ceiling < order.length; ceiling += 1) {
      assert.equal(effectiveMode(order[setting] as ActionPolicy['mode'], order[ceiling] as ActionPolicy['mode']), order[Math.min(setting, ceiling)]);
    }
  }
  assert.equal(effectiveMode('fully-autonomous', 'nonsense' as ActionPolicy['mode']), 'approve-risky', 'a mode that is not known counts as the lowest');
});

test('a ceiling of approve-risky for the interactive context makes a fully-autonomous setting behave as approve-risky, and settings never widen it', async () => {
  const state = stateWith((bundle) => { (bundle.ceiling.maxMode as Record<string, string>).interactive = 'approve-risky'; });
  const capped = await decide(requestFor([write(['src/app.ts'])]), state, byMode);
  assert.equal(capped.effectiveMode, 'approve-risky');
  assert.equal(capped.outcome, 'ask');
  assert.equal(capped.rule, 'bundle.ceiling.mode');
  assert.equal(capped.offerAlwaysAllow, true);
  const lower = await decide(requestFor([write(['src/app.ts'])], { policy: policyOf('approve-risky') }), stateWith((bundle) => { (bundle.ceiling.maxMode as Record<string, string>).interactive = 'auto'; }), byMode);
  assert.equal(lower.effectiveMode, 'approve-risky', 'a setting below the ceiling stays where the person put it');
  assert.equal(lower.rule, 'settings.mode.other');
  const free = await decide(requestFor([write(['src/app.ts'])]), validBundleState(), byMode);
  assert.equal(free.effectiveMode, 'fully-autonomous');
  assert.equal(free.outcome, 'allow');
});

test('the ceiling refuses a verb in a context it does not list, and a verb it does not list at all', async () => {
  const onlyInteractive = stateWith((bundle) => { (bundle.ceiling.contexts as Record<string, string[]>).shell = ['interactive']; });
  const here = await decide(requestFor([SHELL], { command: 'npm test', tool: 'Bash' }), onlyInteractive, allows);
  assert.equal(here.outcome, 'allow');
  const away = await decide(requestFor([SHELL], { command: 'npm test', tool: 'Bash', context: 'unattended', presence: 'none' }), onlyInteractive, allows);
  assert.equal(away.outcome, 'deny');
  assert.equal(away.rule, 'bundle.ceiling.context');
  assert.match(away.reason ?? '', /shell/);
  const missing = stateWith((bundle) => { delete (bundle.ceiling.contexts as Record<string, unknown>).shell; });
  const none = await decide(requestFor([SHELL], { command: 'npm test', tool: 'Bash' }), missing, allows);
  assert.equal(none.rule, 'bundle.ceiling.context', 'a verb absent from ceiling.contexts is allowed in no context');
  const reserved = await decide(requestFor([{ verb: 'read', paths: ['a'] }], { context: 'routine', presence: 'none' }), validBundleState(), allows);
  assert.equal(reserved.rule, 'bundle.ceiling.context', 'the default bundle lists no verb for the reserved routine context');
});

test('a tool whose manifest does not list the context is refused, and a listed one is not', async () => {
  const state = validBundleState();
  const refused = await decide(requestFor([write(['a'])], { context: 'unattended', presence: 'none', manifestContexts: ['interactive'] }), state, allows);
  assert.equal(refused.rule, 'manifest.context');
  assert.equal(refused.outcome, 'deny');
  const fine = await decide(requestFor([write(['a'])], { context: 'unattended', presence: 'none', manifestContexts: ['interactive', 'unattended'] }), state, allows);
  assert.equal(fine.outcome, 'allow');
});

test('an MCP tool outside the interactive context needs its server on the ceiling list', async () => {
  const mcp: Capability = { verb: 'mcp', server: 'docs', tools: ['search'] };
  const none = await decide(requestFor([mcp], { context: 'unattended', presence: 'none', mcpServer: 'docs', tool: 'mcp__docs__search' }), validBundleState(), allows);
  assert.equal(none.outcome, 'deny');
  assert.equal(none.rule, 'bundle.ceiling.unattended-mcp');
  const listed = stateWith((bundle) => { (bundle.ceiling as unknown as { unattendedMcp: string[] }).unattendedMcp = ['docs']; });
  const ok = await decide(requestFor([mcp], { context: 'unattended', presence: 'none', mcpServer: 'docs', tool: 'mcp__docs__search' }), listed, allows);
  assert.equal(ok.outcome, 'allow');
  const interactive = await decide(requestFor([mcp], { mcpServer: 'docs', tool: 'mcp__docs__search' }), validBundleState(), allows);
  assert.equal(interactive.outcome, 'allow', 'in the person\'s own chat the list is not needed');
});

test('a label refusal from the caller denies with its own rule and reason', async () => {
  const decided = await decide(
    requestFor([{ verb: 'read', paths: ['secret/plan.md'] }], { labelVerdict: { rule: 'label.dominance', reason: 'This file is labelled above your clearance.' } }), validBundleState(), allows
  );
  assert.equal(decided.outcome, 'deny');
  assert.equal(decided.rule, 'label.dominance');
  assert.equal(decided.reason, 'This file is labelled above your clearance.');
});

test('shadow mode returns the decision of today\'s loop and reports the enforced floor verdict beside it', async () => {
  const shadow = { floorMode: 'shadow' } as const;
  // A protected write that is also "sensitive" today: asks outside fully-autonomous, allowed inside it.
  const sensitive = 'That writes into .git.';
  const write1 = requestFor([write(['.git/hooks/pre-commit'])], { sensitive, policy: policyOf('approve-risky') });
  const asks = await decide(write1, validBundleState(), async () => ({ decision: 'allow', rule: 'settings.mode.other' }), shadow);
  assert.equal(asks.outcome, 'ask');
  assert.equal(asks.rule, 'settings.sensitive-read');
  assert.equal(asks.floor, false);
  assert.equal(asks.shadowFloor?.rule, 'floor.protected-write');
  const quiet = await decide(requestFor([write(['.git/hooks/pre-commit'])], { sensitive }), validBundleState(), allows, shadow);
  assert.equal(quiet.outcome, 'allow', 'today, fully-autonomous writes into .git without asking');
  assert.equal(quiet.shadowFloor?.rule, 'floor.protected-write');
  assert.equal(quiet.floor, false);
  // A held action asks in every mode, with no run-wide grant.
  const held = await decide(requestFor([SHELL], { command: 'curl x', tool: 'Bash', risky: 'This run read outside content.' }), validBundleState(), allows, shadow);
  assert.equal(held.outcome, 'ask');
  assert.equal(held.rule, 'taint.held');
  assert.equal(held.allowGrant, false);
  // The key folder is still refused with no card, exactly as tool.forbidden does today.
  const keys = await decide(requestFor([SHELL], { command: 'cat .near-ai/state/keys/local.key', tool: 'Bash', forbidden: 'That names the key folder.' }), validBundleState(), allows, shadow);
  assert.equal(keys.outcome, 'deny');
  assert.equal(keys.rule, 'floor.state-keys');
  assert.equal(keys.shadowFloor?.rule, 'floor.state-keys');
  // The credential store, publish and destroy are only reported.
  for (const [rule, shape] of [
    ['floor.credential-store', { effects: [SHELL], command: 'cat ~/.ssh/id_rsa', tool: 'Bash' }],
    ['floor.publish', { effects: [{ verb: 'publish', target: 'registry' } as Capability] }],
    ['floor.destroy', { effects: [{ verb: 'destroy', paths: ['build/**'] } as Capability] }]
  ] as const) {
    const reported = await decide(requestFor([...shape.effects], shape), validBundleState(), allows, shadow);
    assert.equal(reported.outcome, 'allow', rule);
    assert.equal(reported.shadowFloor?.rule, rule);
  }
  const none = await decide(requestFor([write(['src/a.ts'])]), validBundleState(), allows, shadow);
  assert.equal(none.shadowFloor, undefined);
});

test('enforce is the default and reports no shadowFloor', async () => {
  const decided = await decide(requestFor([write(['.git/hooks/pre-commit'])]), validBundleState(), allows);
  assert.equal(decided.outcome, 'ask');
  assert.equal(decided.shadowFloor, undefined);
});

test('GATE_RULE_IDS lists every rule id once, including the floor, bundle, manifest, label, route, taint and settings ids', () => {
  assert.equal(new Set(GATE_RULE_IDS).size, GATE_RULE_IDS.length);
  for (const rule of [
    ...FLOOR_RULE_ORDER, 'bundle.failed-closed', 'bundle.ceiling.context', 'bundle.ceiling.mode', 'bundle.ceiling.unattended-mcp', 'manifest.context',
    'label.dominance', 'label.no-agent-tools', 'label.network-at-mark', 'route.deny', 'route.any-cloud', 'taint.held', 'settings.emergency-stop', 'settings.read-plan',
    'settings.auto-safe-tool', 'settings.mode.edits', 'settings.run-grant.edits', 'settings.deny-list', 'settings.engagement-grant', 'settings.run-grant.command',
    'settings.allow-rule', 'settings.mode.fully-autonomous', 'settings.mode.other', 'settings.auto.classifier', 'settings.unattended-verification',
    'settings.risk.outside-workspace', 'settings.risk.installs', 'settings.safety-model', 'settings.sensitive-read', 'settings.mcp-approval'
  ]) assert.ok(GATE_RULE_IDS.includes(rule), rule);
  assert.equal(GATE_RULE_IDS.length, FLOOR_RULE_ORDER.length + 5 + 3 + ROUTE_RULES.length + 1 + 18);
});

// decide() tests (GATE-04, GATE-05, GATE-06, D-08, D-10, D-19, D-43): the layers, in order, over a stubbed settings layer. No key, token or real path is written here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import type { ActionPolicy } from '../domain/policy';
import { bundleHash, defaultBundlePayload, failedClosed } from '../domain/gate/bundle';
import type { BundleState, PolicyBundle } from '../domain/gate/bundle';
import { GATE_RULE_IDS, PRE_GATE_RULES, decide, effectiveMode } from '../domain/gate/decide';
import { FLOOR_RULE_ORDER } from '../domain/gate/floor';
import { ROUTE_RULES } from '../domain/gate/routing';
import type { ActorRef, GateRequest, SettingsAnswer, SettingsLayer } from '../domain/gate/decide';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import type { Capability } from '../domain/gate/vocabulary';

// The name of the floor option PR 2 had, built so that `grep -rn` for it over src finds only product code that brings it back.
const OLD_FLOOR_OPTION = ['floor', 'Mode'].join('');

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

// ---- Task 2: failed-closed bundles, the ceiling, presence, the always-enforced floor and the rule list ----

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

test('a run with no gate host (the unavailable state) is refused everything but read and plan under its own rule id, with its own sentence', async () => {
  const none = failedClosed('unavailable');
  const read = await decide(requestFor([{ verb: 'read', paths: ['src/**'] }, { verb: 'plan' }]), none, allows);
  assert.equal(read.outcome, 'allow');
  for (const effects of [[write(['src/app.ts'])], [SHELL], [{ verb: 'read', paths: ['a'] } as Capability, write(['a'])], []]) {
    const denied = await decide(requestFor(effects), none, allows);
    assert.equal(denied.outcome, 'deny');
    assert.equal(denied.rule, 'bundle.unavailable');
    assert.equal(denied.reason, none.sentence);
  }
  assert.equal((await decide(requestFor([write(['a'])]), failedClosed('expired'), allows)).rule, 'bundle.failed-closed', 'a policy that failed to verify keeps its own rule id');
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

// The shadow-mode cases of PR 2, kept with the same inputs: the option that made them only report is gone (D-19), so each now asserts the enforced outcome.
test('the floor is always enforced: the inputs that shadow mode only reported now ask or refuse in every mode, and everything else decides as before', async () => {
  // A protected write that is also "sensitive" today: the floor asks in approve-risky, with no grant and no always-allow.
  const sensitive = 'That writes into .git.';
  const write1 = requestFor([write(['.git/hooks/pre-commit'])], { sensitive, policy: policyOf('approve-risky') });
  const asks = await decide(write1, validBundleState(), async () => ({ decision: 'allow', rule: 'settings.mode.other' }));
  assert.equal(asks.outcome, 'ask');
  assert.equal(asks.rule, 'floor.protected-write');
  assert.equal(asks.floor, true);
  assert.equal(asks.offerAlwaysAllow, false);
  assert.equal(asks.allowGrant, false);
  // Fully-autonomous no longer writes into .git without asking.
  const quiet = await decide(requestFor([write(['.git/hooks/pre-commit'])], { sensitive }), validBundleState(), allows);
  assert.equal(quiet.outcome, 'ask', 'fully-autonomous asks before writing into .git');
  assert.equal(quiet.rule, 'floor.protected-write');
  assert.equal(quiet.floor, true);
  assert.equal(quiet.allowGrant, false);
  // A held action asks in every mode, with no run-wide grant, as before.
  const held = await decide(requestFor([SHELL], { command: 'curl x', tool: 'Bash', risky: 'This run read outside content.' }), validBundleState(), allows);
  assert.equal(held.outcome, 'ask');
  assert.equal(held.rule, 'taint.held');
  assert.equal(held.allowGrant, false);
  // The key folder is refused with no card, as before.
  const keys = await decide(requestFor([SHELL], { command: 'cat .near-ai/state/keys/local.key', tool: 'Bash', forbidden: 'That names the key folder.' }), validBundleState(), allows);
  assert.equal(keys.outcome, 'deny');
  assert.equal(keys.rule, 'floor.state-keys');
  assert.equal(keys.floor, true);
  // The credential store is refused; publish and destroy ask, in fully-autonomous too.
  for (const [rule, outcome, shape] of [
    ['floor.credential-store', 'deny', { effects: [SHELL], command: 'cat ~/.ssh/id_rsa', tool: 'Bash' }],
    ['floor.publish', 'ask', { effects: [{ verb: 'publish', target: 'registry' } as Capability] }],
    ['floor.destroy', 'ask', { effects: [{ verb: 'destroy', paths: ['build/**'] } as Capability] }]
  ] as const) {
    const enforced = await decide(requestFor([...shape.effects], shape), validBundleState(), allows);
    assert.equal(enforced.outcome, outcome, rule);
    assert.equal(enforced.rule, rule);
    assert.equal(enforced.floor, true, rule);
    assert.equal(enforced.offerAlwaysAllow, false, rule);
    assert.equal(enforced.allowGrant, false, rule);
  }
  const none = await decide(requestFor([write(['src/a.ts'])]), validBundleState(), allows);
  assert.equal(none.outcome, 'allow', 'a write the floor does not cover runs in fully-autonomous as before');
  assert.equal(none.floor, false);
});

test('no option turns the floor off: decide() ignores the old shadow option if it is handed one', async () => {
  const sneaky = { [OLD_FLOOR_OPTION]: 'shadow' } as unknown as Parameters<typeof decide>[3];
  const decided = await decide(requestFor([write(['.git/hooks/pre-commit'])]), validBundleState(), allows, sneaky);
  assert.equal(decided.outcome, 'ask');
  assert.equal(decided.rule, 'floor.protected-write');
  assert.equal('shadowFloor' in decided, false);
});

test('source scan: no production file under src names a floor mode, so nothing can put the floor in shadow again (GATE-05, D-19)', () => {
  const src = path.resolve(__dirname, '..', '..', 'src');
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      // The tests name the old option on purpose, to prove it is ignored or absent; every other file is the product.
      if (entry.isDirectory()) { if (full !== path.join(src, 'test')) walk(full); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
      scanned += 1;
      const text = readFileSync(full, 'utf8');
      for (const needle of [OLD_FLOOR_OPTION, 'F' + OLD_FLOOR_OPTION.slice(1), "'shadow' | 'enforce'", `${OLD_FLOOR_OPTION}: 'shadow'`]) {
        if (text.includes(needle)) offenders.push(`${path.relative(src, full)}: ${needle}`);
      }
    }
  };
  walk(src);
  assert.ok(scanned > 100, `the scan read the product's files (${scanned})`);
  assert.deepEqual(offenders, []);
});

test('GATE_RULE_IDS lists every rule id once, including the floor, bundle, manifest, label, route, taint and settings ids', () => {
  assert.equal(new Set(GATE_RULE_IDS).size, GATE_RULE_IDS.length);
  for (const rule of [
    ...FLOOR_RULE_ORDER, 'bundle.failed-closed', 'bundle.unavailable', 'bundle.ceiling.context', 'bundle.ceiling.mode', 'bundle.ceiling.unattended-mcp', 'manifest.context',
    'manifest.effects-unknown', 'label.dominance', 'label.no-agent-tools', 'label.network-at-mark', 'route.deny', 'route.any-cloud', 'taint.held', 'settings.emergency-stop', 'settings.read-plan',
    'settings.auto-safe-tool', 'settings.mode.edits', 'settings.run-grant.edits', 'settings.deny-list', 'settings.engagement-grant', 'settings.run-grant.command',
    'settings.allow-rule', 'settings.mode.fully-autonomous', 'settings.mode.other', 'settings.auto.classifier', 'settings.unattended-verification',
    'settings.risk.outside-workspace', 'settings.risk.installs', 'settings.safety-model', 'settings.sensitive-read', 'settings.mcp-approval', 'settings.tool-forbidden'
  ]) assert.ok(GATE_RULE_IDS.includes(rule), rule);
  for (const rule of PRE_GATE_RULES) assert.ok(GATE_RULE_IDS.includes(rule), rule);
  // Owner decisions after PR #74: a file tool's path outside the project is refused up front, and a call that can send data after a credential read is
  // held, each under a rule of its own.
  assert.ok(GATE_RULE_IDS.includes('call.outside-workspace'));
  assert.ok(GATE_RULE_IDS.includes('taint.credential-read'));
  assert.equal(GATE_RULE_IDS.length, FLOOR_RULE_ORDER.length + 7 + 3 + ROUTE_RULES.length + 2 + 19 + PRE_GATE_RULES.length + 1);
});

// ---- Effects unknown: an empty effect list fails closed (PR 1 review fold-in) ----

function countingSettings(): { layer: SettingsLayer; calls: () => number } {
  let calls = 0;
  return { layer: async (): Promise<SettingsAnswer> => { calls += 1; return { decision: 'allow', rule: 'settings.mode.fully-autonomous' }; }, calls: () => calls };
}

test('an empty effect list with a valid bundle and a person present asks with its own rule, no always-allow, no run-wide grant, and never reaches the settings layer', async () => {
  const settings = countingSettings();
  const decided = await decide(requestFor([]), validBundleState(), settings.layer);
  assert.equal(decided.outcome, 'ask');
  assert.equal(decided.rule, 'manifest.effects-unknown');
  assert.equal(decided.offerAlwaysAllow, false);
  assert.equal(decided.allowGrant, false);
  assert.equal(decided.floor, false);
  assert.equal(settings.calls(), 0);
  assert.ok(GATE_RULE_IDS.includes(decided.rule));
});

test('an empty effect list with nobody present, or in an unattended context, is denied with a plain reason and never reaches the settings layer', async () => {
  for (const overrides of [{ presence: 'none' as const }, { context: 'unattended' as const }, { context: 'routine' as const, presence: 'none' as const }]) {
    const settings = countingSettings();
    const decided = await decide(requestFor([], overrides), validBundleState(), settings.layer);
    assert.equal(decided.outcome, 'deny', JSON.stringify(overrides));
    assert.equal(decided.rule, 'manifest.effects-unknown');
    assert.match(decided.reason ?? '', /cannot tell what Write would do/);
    assert.equal(decided.offerAlwaysAllow, false);
    assert.equal(decided.allowGrant, false);
    assert.equal(settings.calls(), 0);
  }
});

test('an empty effect list is never asked past a failed-closed bundle, keeps its own rule over a valid bundle, and the emergency stop still comes first', async () => {
  const settings = countingSettings();
  const closed = await decide(requestFor([]), failedClosed('missing'), settings.layer);
  assert.equal(closed.rule, 'bundle.failed-closed');
  assert.equal(closed.outcome, 'deny');
  const enforced = await decide(requestFor([]), validBundleState(), settings.layer);
  assert.equal(enforced.rule, 'manifest.effects-unknown');
  const stopped = await decide(requestFor([], { policy: { mode: 'fully-autonomous', emergencyStop: true } }), validBundleState(), settings.layer);
  assert.equal(stopped.rule, 'settings.emergency-stop');
  assert.equal(stopped.outcome, 'deny');
  assert.equal(settings.calls(), 0);
});

test('a call whose effects are unknown is still refused with no card when what it names reaches a credential store or the identity folders', async () => {
  for (const presence of ['person', 'none'] as const) {
    const store = await decide(requestFor([], { presence, floorFacts: { credentialStore: 'That names ~/.ssh.' } }), validBundleState(), allows);
    assert.equal(store.outcome, 'deny', presence);
    assert.equal(store.rule, 'floor.credential-store');
    assert.equal(store.floor, true);
    const identity = await decide(requestFor([], { presence, floorFacts: { identityFiles: 'That names the identity folder.' } }), validBundleState(), allows);
    assert.equal(identity.rule, 'floor.identity-files', presence);
  }
  // The loop's own `forbidden` refusal is the loop's: with unknown effects the gate still asks, and the loop refuses the call itself.
  const forbidden = await decide(requestFor([], { forbidden: 'Planted.' }), validBundleState(), allows);
  assert.equal(forbidden.rule, 'manifest.effects-unknown');
});

// PR #74 review round 1 (D-10): a refusal the settings layer has already made (the deny list, an engagement's scope), handed in on the request, decides
// before every step that could only ask: unknown effects, a floor ask, a taint hold, a sensitive read and the settings layer's own ask. A person is never
// shown a card for a call the deny list refuses. The emergency stop still comes first of all.
test('a settings refusal on the request beats every ask, and the emergency stop beats it', async () => {
  const refusal = { rule: 'settings.deny-list', reason: '"git push --force" is on your deny list (nearAi.agent.denyCommands).' };
  const asks: SettingsLayer = async (): Promise<SettingsAnswer> => ({ decision: 'ask', rule: 'settings.mode.other' });
  const cases: Array<[string, GateRequest, SettingsLayer]> = [
    ['unknown effects', requestFor([], { tool: 'Bash', command: 'git push --force' }), allows],
    ['a floor ask', requestFor([write(['.git/hooks/pre-commit'])]), allows],
    ['a taint hold', requestFor([write(['src/app.ts'])], { risky: 'This run read outside content.' }), allows],
    ['a sensitive read', requestFor([write(['src/app.ts'])], { sensitive: 'It reads .env.', policy: policyOf('auto') }), allows],
    ['the settings layer asking', requestFor([write(['src/app.ts'])]), asks]
  ];
  for (const [name, request, layer] of cases) {
    const before = await decide(request, validBundleState(), layer);
    assert.equal(before.outcome, 'ask', `${name} asks without the refusal`);
    const refused = await decide({ ...request, settingsRefusal: refusal }, validBundleState(), layer);
    assert.equal(refused.outcome, 'deny', `${name}: refused`);
    assert.equal(refused.rule, 'settings.deny-list', name);
    assert.equal(refused.reason, refusal.reason, name);
    const stopped = await decide({ ...request, settingsRefusal: refusal, policy: { ...request.policy, emergencyStop: true } }, validBundleState(), layer);
    assert.equal(stopped.rule, 'settings.emergency-stop', `${name}: the emergency stop first`);
  }
});

// PR #74 review round 7: with a failed-closed policy, a call the person's own deny list refuses is refused by the deny list's rule (both refuse; the
// person's own rule is the one named, as it is everywhere else).
test('a failed-closed policy and a deny-list refusal: the deny list is named', async () => {
  const refusal = { rule: 'settings.deny-list', reason: '"rm -rf /" is on your deny list (nearAi.agent.denyCommands).' };
  const decided = await decide(requestFor([], { tool: 'Bash', command: 'rm -rf /', settingsRefusal: refusal }), failedClosed('unavailable'), allows);
  assert.equal(decided.outcome, 'deny');
  assert.equal(decided.rule, 'settings.deny-list');
  const plain = await decide(requestFor([], { tool: 'Bash', command: 'ls' }), failedClosed('unavailable'), allows);
  assert.equal(plain.rule, 'bundle.unavailable', 'without a deny-list refusal the policy\'s own rule is named');
});

// D-53: a call whose effects are unknown still has its label verdict read, right after the floor's refusals of what it names: a command nobody can read
// that names a file above your clearance is refused, never put on a card.
test('unknown effects with a label verdict: denied with the verdict, after a floor refusal by name, before a settings refusal, the outside-workspace refusal and the ask', async () => {
  const verdict = { rule: 'label.dominance' as const, reason: 'This file is labelled ca-protected/Protected B, and your policy gives you no clearance on that scale.' };
  for (const presence of ['person', 'none'] as const) {
    const refused = await decide(requestFor([], { presence, tool: 'Bash', command: 'python3 -c "$X" secret/plan.md', labelVerdict: verdict }), validBundleState(), allows);
    assert.equal(refused.outcome, 'deny', presence);
    assert.equal(refused.rule, 'label.dominance', presence);
    assert.equal(refused.reason, verdict.reason);
    assert.equal(refused.floor, false);
  }
  // The floor's refusal of what the call names still comes first.
  const floor = await decide(requestFor([], { floorFacts: { credentialStore: 'That names ~/.ssh.' }, labelVerdict: verdict }), validBundleState(), allows);
  assert.equal(floor.rule, 'floor.credential-store');
  // The verdict comes before a settings refusal and the outside-workspace refusal.
  const both = await decide(requestFor([], { labelVerdict: verdict, settingsRefusal: { rule: 'settings.deny-list', reason: 'Denied.' }, outsideWorkspace: 'Outside.' }), validBundleState(), allows);
  assert.equal(both.rule, 'label.dominance');
  // Without the verdict the same request still asks, as before.
  const asked = await decide(requestFor([], { tool: 'Bash', command: 'python3 -c "$X" secret/plan.md' }), validBundleState(), allows);
  assert.equal(asked.outcome, 'ask');
  assert.equal(asked.rule, 'manifest.effects-unknown');
});

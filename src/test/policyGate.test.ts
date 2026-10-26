import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultActionPolicy } from '../domain/policy';
import { PrivacyPreflight } from '../services/privacyPreflight';
import { PolicyGate } from '../services/policyGate';

test('preserves automatic read/plan and approval-controlled risky capabilities', () => {
  const gate = new PolicyGate(defaultActionPolicy(), new PrivacyPreflight());
  assert.equal(gate.decideAction('read').allowed, true);
  assert.equal(gate.decideAction('plan').allowed, true);
  for (const capability of ['workspaceWrite', 'shell', 'network', 'gitMutation'] as const) {
    const result = gate.decideAction(capability);
    assert.equal(result.action, 'approval-required');
    assert.equal(result.allowed, false);
  }
});

test('does not let local-only or emergency stop be bypassed by cloud fallback', () => {
  const request = { provider: 'cloud', providerBoundary: 'cloud' as const, capability: 'network' as const, paths: ['src/app.ts'] };
  const localOnly = new PolicyGate(defaultActionPolicy(), new PrivacyPreflight({ mode: 'local-only' }));
  assert.equal(localOnly.preflightOutbound(request).allowed, false);
  const stopped = new PolicyGate({ ...defaultActionPolicy(), emergencyStop: true }, new PrivacyPreflight({ mode: 'local-only' }));
  assert.equal(stopped.preflightOutbound({ ...request, provider: 'local', providerBoundary: 'local' }).allowed, false);
  assert.match(stopped.preflightOutbound(request).reason, /emergency stop/);
});

test('explicit override is auditable and cannot bypass the action approval seam', () => {
  const privacy = new PrivacyPreflight({ mode: 'local-only' });
  const gate = new PolicyGate(defaultActionPolicy(), privacy);
  const request = { provider: 'cloud', providerBoundary: 'cloud' as const, capability: 'network' as const, paths: ['src/app.ts'] };
  const override = privacy.issueOverride(request);
  const result = gate.preflightOutbound(request, override.token);
  assert.equal(result.action, 'approval-required');
  assert.equal(result.allowed, false);
  assert.equal(result.preflight?.decision.overrideUsed, true);
  assert.equal(privacy.getAuditRecords().at(-1)?.overrideUsed, true);
  assert.equal(JSON.stringify(privacy.getAuditRecords()).includes('apiKey'), false);
});


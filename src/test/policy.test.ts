import assert from 'node:assert/strict';
import test from 'node:test';
import { decideAction, defaultActionPolicy } from '../domain/policy';
import { redactSecrets } from '../domain/redaction';

test('default policy allows reads and plans', () => {
  const policy = defaultActionPolicy();
  assert.equal(decideAction(policy, 'read'), 'allow');
  assert.equal(decideAction(policy, 'plan'), 'allow');
});

test('default policy requires approval for risky actions', () => {
  const policy = defaultActionPolicy();
  assert.equal(decideAction(policy, 'workspaceWrite'), 'approval-required');
  assert.equal(decideAction(policy, 'shell'), 'approval-required');
  assert.equal(decideAction(policy, 'network'), 'approval-required');
  assert.equal(decideAction(policy, 'gitMutation'), 'approval-required');
});

test('emergency stop denies every action', () => {
  const policy = { ...defaultActionPolicy(), emergencyStop: true };
  assert.equal(decideAction(policy, 'read'), 'deny');
  assert.equal(decideAction(policy, 'shell'), 'deny');
});

test('secret redaction removes bearer and named credentials', () => {
  const value = 'Bearer secret-token apiKey=abc123 refresh_token: xyz';
  const redacted = redactSecrets(value);
  assert.equal(redacted.includes('secret-token'), false);
  assert.equal(redacted.includes('abc123'), false);
  assert.equal(redacted.includes('xyz'), false);
  assert.equal((redacted.match(/\[REDACTED\]/g) ?? []).length, 3);
});

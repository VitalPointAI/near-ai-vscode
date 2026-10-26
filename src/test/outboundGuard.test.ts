import assert from 'node:assert/strict';
import test from 'node:test';
import { OutboundGuard, spentTodayUsd } from '../services/outboundGuard';
import type { ActivitySessionSummary } from '../domain/activity';

const standard = { privacyMode: 'standard' as const, dailySpendLimitUsd: 0, actionPolicy: { mode: 'approve-risky' as const, emergencyStop: false } };
const tee = { privacyBoundary: 'tee' as const, id: 'z-ai/glm-5.3' };
const forwarded = { privacyBoundary: 'cloud' as const, forwardedTo: 'openrouter.ai', id: 'deepseek/deepseek-v4.1-flash' };

test('ordinary code questions pass on any model in standard mode', () => {
  const guard = new OutboundGuard(standard);
  assert.equal(guard.check({ model: tee.id, modelInfo: tee, text: 'Refactor this loop into a map call.' }, 0).outcome, 'allow');
  assert.equal(guard.check({ model: forwarded.id, modelInfo: forwarded, text: 'Explain this stack trace.' }, 0).outcome, 'allow');
});

test('a credential in the message is blocked, and a one-time override sends that exact message once', () => {
  const guard = new OutboundGuard(standard);
  const text = 'Why does this fail? api_key=sk-live-123456';
  const first = guard.check({ model: tee.id, modelInfo: tee, text }, 0);
  assert.equal(first.outcome, 'block');
  assert.match(first.outcome === 'block' ? first.reason : '', /credential/);
  const token = first.outcome === 'block' ? first.overrideToken : undefined;
  assert.ok(token);
  assert.equal(guard.check({ model: tee.id, modelInfo: tee, text, overrideToken: token }, 0).outcome, 'allow');
  assert.equal(guard.check({ model: tee.id, modelInfo: tee, text, overrideToken: token }, 0).outcome, 'block', 'override is single-use');
  assert.equal(guard.check({ model: tee.id, modelInfo: tee, text: `${text} changed`, overrideToken: token }, 0).outcome, 'block', 'override is bound to the exact message');
});

test('personal data asks for confirmation rather than blocking', () => {
  const verdict = new OutboundGuard(standard).check({ model: tee.id, modelInfo: tee, text: 'Email jane@example.com about the release.' }, 0);
  assert.equal(verdict.outcome, 'confirm');
});

test('TEE-only mode blocks forwarded and unknown models without an override', () => {
  const guard = new OutboundGuard({ ...standard, privacyMode: 'tee-only' });
  assert.equal(guard.check({ model: tee.id, modelInfo: tee, text: 'hello' }, 0).outcome, 'allow');
  const blocked = guard.check({ model: forwarded.id, modelInfo: forwarded, text: 'hello' }, 0);
  assert.equal(blocked.outcome, 'block');
  assert.match(blocked.outcome === 'block' ? blocked.reason : '', /openrouter\.ai/);
  assert.equal(blocked.outcome === 'block' ? blocked.overrideToken : 'none', undefined);
  assert.equal(guard.check({ model: 'mystery', text: 'hello' }, 0).outcome, 'block');
});

test('emergency stop and the daily spend limit block before anything else', () => {
  assert.equal(new OutboundGuard({ ...standard, actionPolicy: { mode: 'approve-risky', emergencyStop: true } }).check({ model: tee.id, modelInfo: tee, text: 'hi' }, 0).outcome, 'block');
  const limited = new OutboundGuard({ ...standard, dailySpendLimitUsd: 1 });
  assert.equal(limited.check({ model: tee.id, modelInfo: tee, text: 'hi' }, 0.99).outcome, 'allow');
  const over = limited.check({ model: tee.id, modelInfo: tee, text: 'hi' }, 1);
  assert.equal(over.outcome, 'block');
  assert.match(over.outcome === 'block' ? over.reason : '', /daily limit of \$1\.00/);
});

test("today's spend sums today's sessions, preferring actual cost", () => {
  const session = (updatedAt: string, estimatedCostUsd?: number, actualCostUsd?: number) => ({ updatedAt, estimatedCostUsd, actualCostUsd }) as ActivitySessionSummary;
  const now = new Date('2026-10-26T18:00:00Z');
  assert.equal(spentTodayUsd([session('2026-10-26T09:00:00Z', 0.5, 0.4), session('2026-10-26T10:00:00Z', 0.25), session('2026-10-25T23:00:00Z', 9)], now), 0.65);
});

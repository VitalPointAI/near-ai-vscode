// The protocol driver (D-19, CYBER-04): a tool-less model is asked through an injected completion
// function, so these tests need no network. What they pin is the repair loop — a fenced/broken reply is
// accepted, a corrective user turn is appended between attempts, and after the bound the role yields a
// typed `incompatible` result rather than throwing or letting free text through.

import assert from 'node:assert/strict';
import test from 'node:test';
import { CyberProtocolDriver, stepsFromText } from '../agent/cyberProtocolDriver';
import { MAX_STEP_REPAIRS } from '../domain/cyberProtocol';

const step = {
  id: 'step-1',
  role: 'operator' as const,
  action: 'probe' as const,
  target: 'https://example.com/',
  tool: 'cyber_http_probe',
  args: [],
  sandbox: 'none' as const,
  expectedResult: 'headers recorded',
  safetyFlags: { maxDurationMs: 5000, rateLimit: 0, denyList: [] }
};

/** A completion client that answers from a script and records every conversation it saw. */
function scripted(replies: string[]): { complete: (model: string, messages: { role: string; content: string }[]) => Promise<string>; seen: string[][] } {
  const seen: string[][] = [];
  let index = 0;
  return {
    seen,
    complete: async (_model, messages) => {
      seen.push(messages.map((message) => `${message.role}:${message.content}`));
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return reply;
    }
  };
}

test('a fenced first reply succeeds with zero repairs', async () => {
  const { complete, seen } = scripted([`\`\`\`json\n${JSON.stringify(step)}\n\`\`\``]);
  const driver = new CyberProtocolDriver({ model: 'sample-model', complete });
  const result = await driver.askRole('operator', [{ role: 'user', content: 'probe it' }]);
  assert.equal(result.kind, 'steps');
  assert.equal(result.kind === 'steps' ? result.steps[0].tool : '', 'cyber_http_probe');
  assert.equal(result.kind === 'steps' ? result.repairs : -1, 0);
  assert.equal(seen.length, 1);
});

test('a broken first reply is corrected, and the retry carries a corrective user turn', async () => {
  const { complete, seen } = scripted(['I will probe the target now.', JSON.stringify(step)]);
  const driver = new CyberProtocolDriver({ model: 'sample-model', complete });
  const result = await driver.askRole('operator', [{ role: 'user', content: 'probe it' }]);
  assert.equal(result.kind, 'steps');
  assert.equal(result.kind === 'steps' ? result.repairs : -1, 1);
  assert.equal(seen.length, 2);
  assert.match(seen[1].at(-1) ?? '', /^user:.*not a single valid Step JSON/s);
});

test('after the repair bound the role reports a typed incompatibility instead of throwing', async () => {
  const { complete } = scripted(['no json here', 'still prose']);
  const driver = new CyberProtocolDriver({ model: 'sample-model', complete });
  const result = await driver.askRole('critic', [{ role: 'user', content: 'judge it' }]);
  assert.equal(result.kind, 'incompatible');
  assert.equal(result.kind === 'incompatible' ? result.role : '', 'critic');
  assert.equal(result.kind === 'incompatible' ? result.attempts : -1, MAX_STEP_REPAIRS + 1);
  assert.match(result.kind === 'incompatible' ? result.reason : '', /no-json/);
  assert.equal(driver.consecutiveFailures('critic'), 1);
});

test('an out-of-scope step is rejected before it is returned, and replay parses what the panel shows', async () => {
  const { complete } = scripted([JSON.stringify({ ...step, target: 'https://attacker.invalid/' })]);
  const driver = new CyberProtocolDriver({ model: 'sample-model', complete, inScope: (target) => new URL(target).hostname === 'example.com' });
  const result = await driver.askRole('planner', [{ role: 'user', content: 'plan' }]);
  assert.equal(result.kind, 'incompatible');
  assert.match(result.kind === 'incompatible' ? result.reason : '', /out-of-scope/);
  assert.deepEqual(driver.stepsFromText(JSON.stringify(step)).map((entry) => entry.id), ['step-1']);
  assert.deepEqual(stepsFromText(`before\n\`\`\`json\n${JSON.stringify(step)}\n\`\`\`\nafter`).map((entry) => entry.id), ['step-1']);
});

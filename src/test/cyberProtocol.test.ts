// The JSON-in-text step protocol (D-19, CYBER-04): a raw-completion model that never saw a tool
// schema must still drive the harness. These tests pin the three ways a reply arrives (prose with one
// object, a fenced block, broken JSON needing repair), the two ways it fails (no JSON, valid JSON with
// the wrong shape), compaction that keeps every evidence hash, the bounded retry/compatibility rule,
// and the scope check that stops an out-of-scope step before any tool sees it.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactSteps,
  isModelIncompatible,
  MAX_STEP_REPAIRS,
  parseStep,
  ProtocolParseError,
  ProtocolStepRecord,
  ROLE_PROMPTS,
  validateStep
} from '../domain/cyberProtocol';

const sample = {
  id: 'step-1',
  role: 'operator',
  action: 'probe',
  target: 'https://example.com/',
  tool: 'cyber_http_probe',
  args: ['--max-redirects', '0'],
  sandbox: 'none',
  expectedResult: 'HTTP 200 with security headers recorded',
  safetyFlags: { maxDurationMs: 5000, rateLimit: 60, denyList: ['169.254.169.254'] }
};

test('a step JSON object inside prose is parsed into a validated step', () => {
  const text = `I will probe the target first.\n\n${JSON.stringify(sample)}\n\nThen I will review the headers.`;
  const step = parseStep(text);
  assert.equal(step.id, 'step-1');
  assert.equal(step.role, 'operator');
  assert.equal(step.action, 'probe');
  assert.equal(step.target, 'https://example.com/');
  assert.deepEqual(step.args, ['--max-redirects', '0']);
  assert.equal(step.safetyFlags.maxDurationMs, 5000);
});

test('a fenced json block is parsed, and trailing commas with single quotes are repaired', () => {
  const broken = `Here is the step:\n\`\`\`json\n{
  'id': 'step-2',
  'role': 'planner',
  'action': 'recon',
  'target': 'https://example.com/',
  'tool': 'cyber_dns_lookup',
  'args': [],
  'sandbox': 'none',
  'expectedResult': 'addresses recorded',
  'safetyFlags': { 'maxDurationMs': 3000, 'rateLimit': 0, 'denyList': [], },
}\n\`\`\`\nThat is all.`;
  const step = parseStep(broken);
  assert.equal(step.id, 'step-2');
  assert.equal(step.role, 'planner');
  assert.equal(step.safetyFlags.maxDurationMs, 3000);
});

test('text with no JSON object fails with a typed parse error', () => {
  assert.throws(
    () => parseStep('I would probe the target but I have not decided how.'),
    (error: unknown) => error instanceof ProtocolParseError && error.code === 'no-json' && error.reason.length > 0
  );
});

test('valid JSON with a missing required field fails with a typed parse error', () => {
  const { target: _omitted, ...missingTarget } = sample;
  assert.throws(
    () => parseStep(JSON.stringify(missingTarget)),
    (error: unknown) => error instanceof ProtocolParseError && error.code === 'invalid-step' && /target/i.test(error.reason)
  );
});

test('compacting steps keeps the last N in full and preserves every evidence hash', () => {
  const records: ProtocolStepRecord[] = Array.from({ length: 8 }, (_value, index) => ({
    id: `step-${index + 1}`,
    action: 'probe',
    target: `https://example.com/${index + 1}`,
    result: `result ${index + 1} `.repeat(40).trim(),
    reasoning: `reasoning ${index + 1}`,
    evidenceHashes: [`hash-${index + 1}`],
    compacted: false
  }));
  const compacted = compactSteps(records, 2);
  assert.equal(compacted.length, 8);
  assert.equal(compacted.filter((entry) => entry.compacted).length, 6);
  assert.equal(compacted.at(-1)?.compacted, false);
  assert.equal(compacted.at(-2)?.compacted, false);
  assert.deepEqual(compacted.flatMap((entry) => entry.evidenceHashes), records.flatMap((entry) => entry.evidenceHashes));
  assert.ok(compacted[0].result.length < records[0].result.length);
});

test('three consecutive role failures mark the model incompatible, two do not', () => {
  assert.equal(isModelIncompatible(MAX_STEP_REPAIRS - 1), false);
  assert.equal(isModelIncompatible(MAX_STEP_REPAIRS), true);
  assert.equal(isModelIncompatible(2), false);
  assert.equal(isModelIncompatible(3), true);
});

test('a step aimed outside the engagement scope is invalid before any tool sees it', () => {
  const inScope = (target: string): boolean => new URL(target).hostname === 'example.com';
  const outside = { ...sample, target: 'https://attacker.invalid/' };
  assert.deepEqual(validateStep(sample, { inScope }).ok, true);
  const rejected = validateStep(outside, { inScope });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false && rejected.code, 'out-of-scope');
});

test('the four role prompts are distinct and each demands a single JSON object', () => {
  const prompts = Object.values(ROLE_PROMPTS);
  assert.equal(prompts.length, 4);
  assert.equal(new Set(prompts).size, 4);
  for (const prompt of prompts) {
    assert.match(prompt, /JSON object/);
    assert.match(prompt, /"(?:id|role|action|target|tool|args|sandbox|expectedResult|safetyFlags)"/);
  }
  assert.match(ROLE_PROMPTS.critic, /reproduction/i);
});

test('every role prompt carries the allowed values and an example that parses', () => {
  for (const [role, prompt] of Object.entries(ROLE_PROMPTS)) {
    // The model reported: "role" must be one of planner, operator, critic, reporter. The prompt named
    // the field but never its allowed values, so the model guessed. Every enum is now spelled out.
    for (const value of ['planner', 'operator', 'critic', 'reporter']) assert.ok(prompt.includes(value), `${role} prompt lists the role value ${value}`);
    for (const value of ['recon', 'probe', 'exploit', 'verify', 'report']) assert.ok(prompt.includes(value), `${role} prompt lists the action value ${value}`);
    for (const value of ['auto', 'container', 'tempFolder', 'none']) assert.ok(prompt.includes(value), `${role} prompt lists the sandbox value ${value}`);
    assert.match(prompt, /"maxDurationMs"/);
    assert.match(prompt, /"safetyFlags"/);
    // The worked example must itself be a valid step, or it teaches the model a shape that fails.
    const example = /\{"id":[\s\S]*?"denyList":\[\]\}\}/.exec(prompt)?.[0];
    assert.ok(example, `${role} prompt contains a complete example object`);
    assert.doesNotThrow(() => parseStep(example!), `${role} example parses as a Step`);
  }
});

test('the prompt names the role the model is acting as', () => {
  for (const [role, prompt] of Object.entries(ROLE_PROMPTS)) {
    assert.match(prompt, new RegExp(`Your "role" is "${role}"`), `${role} prompt states its own role`);
  }
});

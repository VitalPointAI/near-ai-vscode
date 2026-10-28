import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { isTestFile, testStrength, weakened } from '../agent/testIntegrity';
import { CORE_TOOLS } from '../agent/tools';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// In the model eval, a cheaper model "fixed" a refactor by deleting the assertion that failed. The
// loop now notices when an agent weakens a test it was given, says so, and asks once before finishing.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// The test from that eval run, and the assertion the model removed.
const GIVEN = 'const test = require("node:test");\nconst assert = require("node:assert");\ntest("renamed", () => {\n  const api = require("./api");\n  assert.equal(typeof api.getUser, "function");\n  assert.equal(api.fetchUser, undefined);\n  assert.equal(require("./a")(1), "n1");\n});\n';
const REMOVED = '  assert.equal(api.fetchUser, undefined);\n';

async function runScripted(turns: Array<ToolCall[] | string>): Promise<{ root: string; transcript: AgentMessage[]; outcome: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-integrity-'));
  await writeFile(path.join(root, 'rename.test.js'), GIVEN);
  const shell = new ShellSession(root);
  let turn = 0;
  const client = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { const next = turns[Math.min(turn++, turns.length - 1)]; yield { type: 'done', message: typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', content: null, tool_calls: next }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  try {
    const result = await new AgentRun({ client, model: 'm', tools: CORE_TOOLS, context: { root, checkpoints: new RunCheckpoints('integrity'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined })
      .run([{ role: 'user', content: 'rename fetchUser to getUser' }], new AbortController().signal);
    return { root, transcript: result.messages, outcome: result.outcome };
  } finally {
    shell.dispose();
  }
}

const text = (transcript: AgentMessage[]) => transcript.map((message) => String(message.content ?? '')).join('\n');

test('deleting an assertion from a given test is pointed out at once and again before the agent may finish', async () => {
  const { root, transcript, outcome } = await runScripted([
    [call('r', 'Read', { file_path: 'rename.test.js' })],
    [call('e', 'Edit', { file_path: 'rename.test.js', old_string: REMOVED, new_string: '' })],
    'Done.',
    [call('w', 'Edit', { file_path: 'rename.test.js', old_string: '  assert.equal(require', new_string: `${REMOVED}  assert.equal(require` })],
    'Restored the assertion and fixed the code instead.'
  ]);
  const all = text(transcript);
  assert.match(all, /this test existed before the task and is weaker now \(rename\.test\.js \(assertions 5 → 4\)\)/);
  assert.equal((all.match(/<test-integrity>/g) ?? []).length, 1, 'one reminder before finishing');
  assert.equal(outcome, 'completed');
  assert.equal(await readFile(path.join(root, 'rename.test.js'), 'utf8'), GIVEN);
  assert.equal(transcript.at(-1)?.content, 'Restored the assertion and fixed the code instead.');
});

test('the reminder comes once: an agent with a reason to change the test can still finish', async () => {
  const { transcript, outcome } = await runScripted([
    [call('r', 'Read', { file_path: 'rename.test.js' })],
    [call('e', 'Edit', { file_path: 'rename.test.js', old_string: REMOVED, new_string: '' })],
    'Done.',
    'The user asked to drop that check.'
  ]);
  assert.equal(outcome, 'completed');
  assert.equal((text(transcript).match(/<test-integrity>/g) ?? []).length, 1);
});

test('adding tests or assertions, or creating a new test file, raises nothing', async () => {
  const { transcript } = await runScripted([
    [call('r', 'Read', { file_path: 'rename.test.js' })],
    [call('e', 'Edit', { file_path: 'rename.test.js', old_string: '});\n', new_string: '  assert.ok(true);\n});\ntest("more", () => assert.ok(1));\n' })],
    [call('n', 'Write', { file_path: 'test/new.test.js', content: 'require("node:test")("x", () => {});\n' })],
    'Done.'
  ]);
  assert.doesNotMatch(text(transcript), /weaker now|test-integrity/);
});

test('test files are recognised across languages, and skipping a case counts as weakening', () => {
  for (const file of ['src/a.test.ts', 'lib/b.spec.js', 'test/c.js', 'pkg/__tests__/d.tsx', 'tests/test_e.py', 'f_test.go', 'GTest.java']) assert.ok(isTestFile(file), file);
  for (const file of ['src/contest.js', 'src/latest.ts', 'docs/testing.md']) assert.ok(!isTestFile(file), file);
  const before = testStrength('test("a", () => { assert.ok(1); });\nit("b", () => expect(2).toBe(2));\n');
  assert.deepEqual(before, { tests: 2, assertions: 2, skipped: 0 });
  assert.ok(weakened(before, testStrength('test.skip("a", () => { assert.ok(1); });\nit("b", () => expect(2).toBe(2));\n')));
  assert.ok(weakened(before, testStrength('it("b", () => expect(2).toBe(2));\n')));
  assert.deepEqual(testStrength('def test_one():\n    assert x == 1\n\n@pytest.mark.skip\ndef test_two():\n    self.assertEqual(1, 1)\n'), { tests: 2, assertions: 2, skipped: 1 });
});

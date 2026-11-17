// A decision record never carries the project's or the home folder's machine path (PR #76 review round 4). The refusal of a path outside the project put
// the tool's own error text, with the absolute project root, into the record; a reason that names the shell's folder did the same. Every refusal path here
// is driven by inputs that name no absolute path (relative paths, `~`, links), and every record written is searched for the test run's temporary folder,
// which holds the project and the stand-in home. The agent is still told the tool's own message.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { bashTool, globTool, readTool, writeTool } from '../agent/tools';
import type { ToolContext } from '../agent/tools';
import type { DecisionRecord } from '../domain/gate/record';
import { fakeHome } from './helpers/gateFixtures';
import { newTestRun, testGateRuntime } from './helpers/gatedRuns';

const TEMP = [path.resolve(tmpdir()), realpathSync(tmpdir())];
const ruleOf = (record: DecisionRecord): string => record.authorizations[0]?.policy.name ?? '';

test('no refusal writes the project root, the home folder or the temporary folder into a decision record; the agent still gets the tool\'s own message', async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-record-paths-')));
  const root = path.join(base, 'project');
  mkdirSync(path.join(root, '.near-ai', 'state', 'keys'), { recursive: true });
  writeFileSync(path.join(root, '.near-ai', 'state', 'keys', 'local.key'), 'k');
  mkdirSync(path.join(base, 'elsewhere'));
  writeFileSync(path.join(base, 'elsewhere', 'notes.md'), 'n');
  const home = fakeHome();
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'stand-in');
  symlinkSync(path.join(home, '.ssh'), path.join(root, 'link-ssh'));
  const shell = new ShellSession(root, undefined, { HOME: home });
  const gate = { ...testGateRuntime(), locations: { home } };
  const calls: Array<{ name: string; args: string }> = [
    { name: 'Read', args: JSON.stringify({ file_path: '../elsewhere/notes.md' }) },
    { name: 'Write', args: JSON.stringify({ file_path: '../elsewhere/new.md', content: 'x' }) },
    { name: 'Glob', args: JSON.stringify({ pattern: '*.md', path: '../elsewhere' }) },
    { name: 'Read', args: JSON.stringify({ file_path: 'link-ssh/id_ed25519' }) },
    { name: 'Read', args: JSON.stringify({ file_path: '.near-ai/state/keys/local.key' }) },
    { name: 'Bash', args: JSON.stringify({ command: 'cat link-ssh/id_ed25519' }) },
    { name: 'Bash', args: JSON.stringify({ command: 'cd ~ && cat .ssh/id_ed25519' }) },
    { name: 'Bash', args: JSON.stringify({ command: 'cd .near-ai/state/keys' }) },
    { name: 'Bash', args: JSON.stringify({ command: 'ls' }) },
    { name: 'Nope', args: '{}' },
    { name: 'Write', args: '{not json' }
  ];
  try {
    const context: ToolContext = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('record-paths'), shell, readFiles: new Set() };
    let turn = 0;
    const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
    const client = {
      async *streamCompletion() {
        const next = calls[turn];
        turn += 1;
        yield next ? { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: `c${turn}`, type: 'function', function: { name: next.name, arguments: next.args } }] }, finishReason: 'tool_calls', usage }
          : { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage };
      }
    };
    const run = newTestRun({
      client: client as never, model: 'm', tools: [readTool, writeTool, globTool, bashTool], context, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gate,
      requestApproval: async () => ({ decision: 'deny' }), emit: () => undefined
    });
    const result = await run.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], new AbortController().signal);
    const outputs = result.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
    const rules = gate.records.map(ruleOf);
    for (const expected of ['call.outside-workspace', 'floor.credential-store', 'floor.state-keys', 'call.unknown-tool', 'call.bad-arguments']) assert.ok(rules.includes(expected), `${expected} in ${rules.join(', ')}`);
    const leaked = gate.records.map((record) => JSON.stringify(record)).filter((text) => TEMP.some((folder) => text.includes(folder)) || text.includes(root) || text.includes(home));
    assert.deepEqual(leaked, []);
    // The agent is told the tool's own words for a path outside the project.
    assert.match(outputs[0] ?? '', /^Not allowed: \.\.\/elsewhere\/notes\.md is outside the workspace\. Tools can only use files under /);
  } finally {
    shell.dispose();
  }
});

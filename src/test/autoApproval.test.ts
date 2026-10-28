import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun, ApprovalRequest } from '../agent/loop';
import { AutoApprovalContext, decidePermission, decidePermissionAsync, DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { CommandSafetyCheck, parseSafetyVerdict, SafetyModelCheck, SafetyModelClient } from '../agent/safetyModel';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import type { ActionPolicy } from '../domain/policy';
import { privateSafetyModel } from '../services/chatBridge';
import { AgentMessage, CompletionEvent, ModelInfo, NearAiClient, ToolCall } from '../services/nearAiClient';

const auto: ActionPolicy = { mode: 'auto', emergencyStop: false };
const where = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };

/** A safety check that records what it was asked and answers from a fixed verdict. */
function fakeSafety(allow: boolean, reason = allow ? 'Safety model: fine.' : 'Safety model: not sure.') {
  const asked: string[] = [];
  const check: CommandSafetyCheck = { async check(command) { asked.push(command); return { allow, reason }; } };
  return { asked, check };
}

const decide = (command: string, options: { grants?: RunGrants; safety?: CommandSafetyCheck; policy?: ActionPolicy; rules?: typeof DEFAULT_RULES; capability?: Parameters<typeof decidePermission>[0] } = {}) =>
  decidePermissionAsync(options.capability ?? 'shell', command, options.policy ?? auto, options.rules ?? DEFAULT_RULES, options.grants ?? new RunGrants(), { ...where, safety: options.safety } satisfies AutoApprovalContext);

test('auto: emergency stop, deny list, grants, and the allow list come before the classifier', async () => {
  const safety = fakeSafety(true);
  assert.deepEqual(await decide('npm test', { policy: { mode: 'auto', emergencyStop: true } }), { decision: 'deny', reason: 'Emergency stop is on.' });
  assert.equal((await decide('git push --force origin main', { safety: safety.check })).decision, 'deny');
  assert.equal((await decide('rm -rf ~', { safety: safety.check })).decision, 'deny');
  const grants = new RunGrants();
  grants.commands.add('git push origin main');
  assert.equal((await decide('git push origin main', { grants })).decision, 'allow', 'an approved-for-this-run command runs even though it is risky');
  assert.equal((await decide('git log --oneline -3', { rules: { allowCommands: ['git log'], denyCommands: [] } })).decision, 'allow');
  const custom = { allowCommands: [], denyCommands: ['npm test'] };
  assert.equal((await decide('npm test', { rules: custom })).decision, 'deny', 'the deny list beats a safe classification');
  assert.deepEqual(safety.asked, []);
});

test('auto: safe commands run, risky ones ask with the reason, and neither reaches the model', async () => {
  const safety = fakeSafety(true);
  assert.deepEqual(await decide('npm test', { safety: safety.check }), { decision: 'allow' });
  assert.deepEqual(await decide('npm run build && git add -A && git commit -m "build"', { safety: safety.check }), { decision: 'allow' });
  const push = await decide('git push origin main', { safety: safety.check });
  assert.equal(push.decision, 'ask');
  assert.match(push.decision === 'ask' ? push.reason ?? '' : '', /^Auto approve held this: git push changes a remote repository/);
  const publish = await decide('npx vsce publish', { safety: safety.check });
  assert.equal(publish.decision, 'ask');
  assert.deepEqual(safety.asked, [], 'only unknown commands go to the model');
});

test('auto: unknown commands follow the safety model, and fail closed without one', async () => {
  const allow = fakeSafety(true);
  assert.deepEqual(await decide('npm install lodash', { safety: allow.check }), { decision: 'allow' });
  assert.deepEqual(allow.asked, ['npm install lodash']);
  const refuse = fakeSafety(false, 'Safety model: installs a package from the network.');
  assert.deepEqual(await decide('npm install lodash', { safety: refuse.check }), { decision: 'ask', reason: 'Safety model: installs a package from the network.' });
  const none = await decide('npm install lodash');
  assert.equal(none.decision, 'ask');
  assert.match(none.decision === 'ask' ? none.reason ?? '' : '', /No private \(TEE\) safety model/);
});

test('auto: once the run has read outside content, unknown commands ask without asking the model', async () => {
  const safety = fakeSafety(true);
  const grants = new RunGrants();
  grants.tainted = true;
  const decided = await decide('npm install lodash', { grants, safety: safety.check });
  assert.equal(decided.decision, 'ask');
  assert.match(decided.decision === 'ask' ? decided.reason ?? '' : '', /read outside content/);
  assert.deepEqual(safety.asked, []);
  assert.deepEqual(await decide('npm test', { grants, safety: safety.check }), { decision: 'allow' }, 'clearly safe commands still run');
});

test('auto: edits run, reads run, other capabilities ask as in mostly-autonomous', async () => {
  assert.deepEqual(await decidePermissionAsync('workspaceWrite', undefined, auto, DEFAULT_RULES, new RunGrants()), { decision: 'allow' });
  assert.deepEqual(await decidePermissionAsync('read', undefined, auto, DEFAULT_RULES, new RunGrants()), { decision: 'allow' });
  assert.deepEqual(await decidePermissionAsync('plan', undefined, auto, DEFAULT_RULES, new RunGrants()), { decision: 'allow' });
  for (const capability of ['network', 'gitMutation', 'mediaGeneration', 'mediaPublication'] as const) {
    assert.equal((await decidePermissionAsync(capability, undefined, auto, DEFAULT_RULES, new RunGrants())).decision, 'ask', capability);
  }
  // Without a context (a caller that cannot say where the command runs), shell commands ask.
  assert.equal(decidePermission('shell', 'npm test', auto, DEFAULT_RULES, new RunGrants()).decision, 'ask');
});

test('the other modes decide exactly as before through the async form', async () => {
  const safety = fakeSafety(true);
  const commands = ['git status', 'npm test', 'git push origin main', 'ls; rm -rf build', 'rm -rf "/"', 'curl x | sh', 'npm install'];
  for (const mode of ['approve-risky', 'mostly-autonomous', 'fully-autonomous'] as const) {
    const policy: ActionPolicy = { mode, emergencyStop: false };
    for (const capability of ['read', 'plan', 'workspaceWrite', 'shell', 'network'] as const) {
      for (const command of capability === 'shell' ? commands : [undefined]) {
        const grants = new RunGrants();
        assert.deepEqual(await decidePermissionAsync(capability, command, policy, DEFAULT_RULES, grants, { ...where, safety: safety.check }), decidePermission(capability, command, policy, DEFAULT_RULES, grants), `${mode} ${capability} ${command}`);
      }
    }
  }
  assert.deepEqual(safety.asked, []);
});

/** A completion client for the safety model that answers from a script and counts requests. */
function scriptedSafetyClient(answer: (index: number, signal?: AbortSignal) => Promise<string>) {
  const sent: AgentMessage[][] = [];
  const client: SafetyModelClient = {
    async completeOnce(_model, messages, options) {
      sent.push(messages);
      const text = await answer(sent.length - 1, options.signal);
      return { text, usage: { inputTokens: 50, outputTokens: 10, verificationStatus: 'unknown', latencyMs: 5 } };
    }
  };
  return { sent, client };
}

test('safety model: allow and deny answers become verdicts, and a run asks once per exact command', async () => {
  const usage: number[] = [];
  const { sent, client } = scriptedSafetyClient(async (index) => index === 0 ? '{"allow": true, "reason": "Installs a dev dependency for the task."}' : '```json\n{"allow": false, "reason": "Deletes a cache outside the workspace."}\n```');
  const check = new SafetyModelCheck({ client, model: 'Qwen/Qwen3.6-35B-A3B-FP8', task: 'Add lodash and use it in utils.ts', onUsage: (value) => usage.push(value.inputTokens ?? 0) });
  assert.deepEqual(await check.check('npm install lodash', { root: '/work/app', cwd: '/work/app' }), { allow: true, reason: 'Safety model: Installs a dev dependency for the task.' });
  assert.deepEqual(await check.check('npm install lodash', { root: '/work/app', cwd: '/work/app' }), { allow: true, reason: 'Safety model: Installs a dev dependency for the task.' }, 'cached');
  assert.deepEqual(await check.check('rm -rf /tmp/x', { root: '/work/app', cwd: '/work/app' }), { allow: false, reason: 'Safety model: Deletes a cache outside the workspace.' });
  assert.equal(sent.length, 2);
  assert.deepEqual(usage, [50, 50], 'usage is reported so the run\'s spend includes the checks');
  // The prompt carries the command, the workspace, and the task, and nothing else.
  const question = JSON.parse(String(sent[0][1].content)) as Record<string, string>;
  assert.deepEqual(Object.keys(question).sort(), ['command', 'task', 'working_directory', 'workspace']);
  assert.equal(question.command, 'npm install lodash');
  assert.equal(question.task, 'Add lodash and use it in utils.ts');
  assert.match(String(sent[0][0].content), /Answer with only a JSON object/);
});

test('safety model: malformed answers, errors, and timeouts fail closed', async () => {
  for (const text of ['Sure, that looks fine!', '{"allow": "yes"}', '{allow: true}', '', '<think>{"allow": true}</think>']) {
    const { client } = scriptedSafetyClient(async () => text);
    const verdict = await new SafetyModelCheck({ client, model: 'm', task: 't' }).check('npm install', { root: '/r', cwd: '/r' });
    assert.equal(verdict.allow, false, JSON.stringify(text));
  }
  const failing: SafetyModelClient = { async completeOnce() { throw new Error('socket hang up'); } };
  assert.equal((await new SafetyModelCheck({ client: failing, model: 'm', task: 't' }).check('npm install', { root: '/r', cwd: '/r' })).allow, false);
  const { sent, client: slow } = scriptedSafetyClient((_index, signal) => new Promise((resolve) => { const timer = setTimeout(() => resolve('{"allow": true, "reason": "late"}'), 5_000); signal?.addEventListener('abort', () => clearTimeout(timer)); }));
  const started = Date.now();
  const late = await new SafetyModelCheck({ client: slow, model: 'm', task: 't', timeoutMs: 30 }).check('npm install', { root: '/r', cwd: '/r' });
  assert.equal(late.allow, false);
  assert.match(late.reason, /did not answer within/);
  assert.ok(Date.now() - started < 2_000, 'the timeout is honoured');
  assert.equal(sent.length, 1);
  assert.equal(parseSafetyVerdict('{"allow": false, "reason": "x"}')?.allow, false);
});

test('safety model: a 429 asks after exactly one request, and pauses further checks', async () => {
  let fetches = 0;
  const fetchFn = (async () => { fetches += 1; return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  // The client would normally retry a 429 twice; the safety check must not.
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', fetchFn, maxRetries: 2, retryBaseDelayMs: 0 });
  let now = 1_000;
  const check = new SafetyModelCheck({ client, model: 'Qwen/Qwen3.6-35B-A3B-FP8', task: 'Update deps', now: () => now });
  const first = await check.check('npm install', { root: '/r', cwd: '/r' });
  assert.equal(first.allow, false);
  assert.match(first.reason, /rate limited/);
  assert.equal(fetches, 1, 'exactly one request');
  const second = await check.check('npm ci', { root: '/r', cwd: '/r' });
  assert.equal(second.allow, false);
  assert.equal(fetches, 1, 'no request while paused after a rate limit');
  now += 120_000;
  await check.check('npm ci', { root: '/r', cwd: '/r' });
  assert.equal(fetches, 2, 'checks resume after the pause');
});

test('safety model: only a private model on the chat\'s route is used', () => {
  const models: ModelInfo[] = [
    { id: 'Qwen/Qwen3.6-35B-A3B-FP8', privacyBoundary: 'tee' },
    { id: 'openai/gpt-x', privacyBoundary: 'cloud', forwardedTo: 'openai' },
    { id: 'local-small', privacyBoundary: 'local' }
  ];
  assert.equal(privateSafetyModel(models, models[0], 'Qwen/Qwen3.6-35B-A3B-FP8'), 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(privateSafetyModel(models, models[1], 'Qwen/Qwen3.6-35B-A3B-FP8'), 'Qwen/Qwen3.6-35B-A3B-FP8', 'a private checker is fine even when the chat model is forwarded');
  assert.equal(privateSafetyModel(models, models[0], 'openai/gpt-x'), undefined, 'never a forwarded model');
  assert.equal(privateSafetyModel(models, models[1], 'openai/gpt-x'), undefined, 'never a forwarded model, even for a forwarded chat');
  assert.equal(privateSafetyModel(models, models[0], 'missing/model'), undefined);
  assert.equal(privateSafetyModel(models, models[2], 'local-small'), 'local-small');
  assert.equal(privateSafetyModel(models, models[2], 'Qwen/Qwen3.6-35B-A3B-FP8'), undefined, 'a local run stays local');
});

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function scriptedModel(turns: Array<{ text?: string; calls?: ToolCall[] }>) {
  const seen: AgentMessage[][] = [];
  return {
    seen,
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      seen.push(structuredClone(messages));
      const turn = turns[seen.length - 1] ?? { text: 'done' };
      yield { type: 'done', message: { role: 'assistant', content: turn.text ?? null, ...(turn.calls ? { tool_calls: turn.calls } : {}) }, finishReason: turn.calls ? 'tool_calls' : 'stop', usage: { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown', latencyMs: 1 } };
    }
  };
}

test('agent loop in auto: npm test runs without asking, git push asks with the reason, and an unknown command goes to the safety model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-auto-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node -e "console.log(\'fixture tests passed\')"' } }));
  const model = scriptedModel([
    { calls: [call('c1', 'Bash', { command: 'npm test' })] },
    { calls: [call('c2', 'Bash', { command: 'git push origin main' })] },
    { calls: [call('c3', 'Bash', { command: 'npm install left-pad' })] },
    { calls: [call('c4', 'Write', { file_path: 'notes.md', content: 'done\n' })] },
    { text: 'Tests pass; I did not push.' }
  ]);
  const approvals: ApprovalRequest[] = [];
  const safety = fakeSafety(false, 'Safety model: installs a package the task did not ask for.');
  const shell = new ShellSession(root);
  const run = new AgentRun({
    client: model, model: 'z-ai/glm-5.3', tools: CORE_TOOLS,
    context: { root, checkpoints: new RunCheckpoints('auto'), shell, readFiles: new Set() },
    policy: auto, rules: DEFAULT_RULES, safety: safety.check,
    requestApproval: async (request) => { approvals.push(request); return { decision: 'deny' }; },
    emit: () => undefined
  });
  try {
    const result = await run.run([{ role: 'user', content: 'Run the tests, then push' }], new AbortController().signal);
    assert.equal(result.outcome, 'completed');
    const testResult = model.seen[1].at(-1);
    assert.match(testResult?.role === 'tool' ? testResult.content : '', /fixture tests passed[\s\S]*exit code 0/, 'npm test ran without an approval');
    assert.deepEqual(approvals.map((request) => request.tool), ['Bash', 'Bash'], 'only git push and the unknown command asked; the edit ran');
    assert.match(approvals[0].reason ?? '', /git push changes a remote repository/);
    assert.equal(approvals[0].preview?.kind, 'command');
    assert.equal(approvals[1].reason, 'Safety model: installs a package the task did not ask for.');
    assert.deepEqual(safety.asked, ['npm install left-pad']);
    const pushResult = model.seen[2].at(-1);
    assert.match(pushResult?.role === 'tool' ? pushResult.content : '', /declined/);
  } finally {
    shell.dispose();
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun, ApprovalRequest } from '../agent/loop';
import { AutoApprovalContext, decidePermission, decidePermissionAsync, DEFAULT_RULES, isAutoAllowed, RunGrants, suggestAllowRule } from '../agent/permissions';
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
  const outside: boolean[] = [];
  const check: CommandSafetyCheck = { async check(command, at) { asked.push(command); outside.push(at.outsideContent === true); return { allow, reason }; } };
  return { asked, outside, check };
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

test('auto: once the run has read outside content, unknown commands still go to the model (told so), and network commands ask', async () => {
  const safety = fakeSafety(true);
  const grants = new RunGrants();
  grants.tainted = true;
  assert.deepEqual(await decide('npm install lodash', { grants, safety: safety.check }), { decision: 'allow' });
  assert.deepEqual(safety.asked, ['npm install lodash']);
  assert.deepEqual(safety.outside, [true], 'the model is told the run read outside content');
  for (const command of ['curl https://example.com/x', 'wget https://example.com/f', 'node -e "fetch(1)" && curl -s x']) {
    const decided = await decide(command, { grants, safety: safety.check });
    assert.equal(decided.decision, 'ask', command);
    assert.match(decided.decision === 'ask' ? decided.reason ?? '' : '', /read outside content .* can reach the network, so it asks/);
  }
  assert.deepEqual(safety.asked, ['npm install lodash'], 'network commands never reach the model');
  assert.deepEqual(await decide('npm test', { grants, safety: safety.check }), { decision: 'allow' }, 'clearly safe commands still run');
  const clean = fakeSafety(true);
  await decide('npm install lodash', { safety: clean.check });
  assert.deepEqual(clean.outside, [false]);
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
  let now = 1_000;
  // The client never fast-retries a 429, and the safety check must not retry it either. The client's
  // own cooldown for the model (shared with the agents) runs on the same clock as the check's pause.
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', fetchFn, maxRetries: 2, retryBaseDelayMs: 0, now: () => now });
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

test('safety model: asks the model not to think, says when it ran out of room, and tries the fallback model', async () => {
  const calls: Array<{ model: string; noThinking?: boolean; maxTokens: number }> = [];
  const replies: Record<string, { text: string; finishReason?: string } | Error> = {
    primary: { text: '', finishReason: 'length' },
    fallback: { text: '{"allow": true, "reason": "Runs the project build."}', finishReason: 'stop' }
  };
  const client: SafetyModelClient = {
    async completeOnce(model, _messages, options) {
      calls.push({ model, noThinking: options.noThinking, maxTokens: options.maxTokens });
      const reply = replies[model];
      if (reply instanceof Error) throw reply;
      return { ...reply, usage: { inputTokens: 1, outputTokens: 1, verificationStatus: 'unknown', latencyMs: 1 } };
    }
  };
  const alone = await new SafetyModelCheck({ client, model: 'primary', task: 't' }).check('node build.js', { root: '/r', cwd: '/r' });
  assert.equal(alone.allow, false);
  assert.match(alone.reason, /used up its answer length before giving a verdict/);
  assert.ok(calls.every((sent) => sent.noThinking === true && sent.maxTokens >= 1_000), 'thinking is turned off, with room left for a model that thinks anyway');
  calls.length = 0;
  const helped = await new SafetyModelCheck({ client, model: 'primary', fallbackModel: 'fallback', task: 't' }).check('node build.js', { root: '/r', cwd: '/r' });
  assert.deepEqual(helped, { allow: true, reason: 'Safety model: Runs the project build.' });
  assert.deepEqual(calls.map((sent) => sent.model), ['primary', 'fallback']);
  // A rate-limited primary is skipped while paused; the fallback answers.
  replies.primary = Object.assign(new Error('busy'), { status: 429 });
  calls.length = 0;
  const check = new SafetyModelCheck({ client, model: 'primary', fallbackModel: 'fallback', task: 't' });
  assert.equal((await check.check('node a.js', { root: '/r', cwd: '/r' })).allow, true);
  assert.equal((await check.check('node b.js', { root: '/r', cwd: '/r' })).allow, true);
  assert.deepEqual(calls.map((sent) => sent.model), ['primary', 'fallback', 'fallback']);
  // Outside content adds a stricter note to the prompt, and is cached separately.
  const { sent, client: noting } = scriptedSafetyClient(async () => '{"allow": false, "reason": "no"}');
  const strict = new SafetyModelCheck({ client: noting, model: 'm', task: 't' });
  await strict.check('node x.js', { root: '/r', cwd: '/r' });
  await strict.check('node x.js', { root: '/r', cwd: '/r', outsideContent: true });
  assert.equal(sent.length, 2);
  assert.doesNotMatch(String(sent[0][0].content), /outside content/);
  assert.match(String(sent[1][0].content), /read outside content .* Be stricter/);
});

test('NearAiClient.completeOnce: asks not to think, retries without the option on a 400, and reports the finish reason', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let reject = true;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.chat_template_kwargs && reject) return new Response(JSON.stringify({ error: 'unknown field' }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"allow": true}', reasoning_content: 'hm' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'test-key', fetchFn, maxRetries: 0, retryBaseDelayMs: 0 });
  const first = await client.completeOnce('m', [{ role: 'user', content: 'x' }], { maxTokens: 50, noThinking: true });
  assert.equal(first.text, '{"allow": true}');
  assert.equal(first.finishReason, 'stop');
  assert.deepEqual(bodies.map((body) => 'chat_template_kwargs' in body), [true, false], 'rejected once, then sent without it');
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false, thinking: false });
  reject = false;
  bodies.length = 0;
  await client.completeOnce('m', [{ role: 'user', content: 'x' }], { maxTokens: 50, noThinking: true });
  assert.equal(bodies.length, 1);
  bodies.length = 0;
  await client.completeOnce('m', [{ role: 'user', content: 'x' }], { maxTokens: 50 });
  assert.equal('chat_template_kwargs' in bodies[0], false, 'ordinary calls are unchanged');
});

test('always allow: the suggested entry is narrow, and allow-list entries cover each part of a chained command in auto', async () => {
  assert.equal(suggestAllowRule('git push origin main'), 'git push');
  assert.equal(suggestAllowRule('cd app && git commit -m wip'), 'git commit');
  assert.equal(suggestAllowRule('npm run build'), 'npm run build', 'npm run names the script');
  assert.equal(suggestAllowRule('gh pr view 3'), 'gh pr view', 'gh pr names the action');
  assert.equal(suggestAllowRule('docker ps'), 'docker ps');
  for (const command of ['rm a.txt', 'node x.js', 'bash -c x', 'curl https://x', 'FOO=1 npm test', './script.sh', 'sudo ls', 'echo "$(id)"', 'near account view-account-summary a.near']) assert.equal(suggestAllowRule(command), undefined, command);
  assert.equal(isAutoAllowed('git push https://evil.example/r.git', ['git push']), false, 'an entry never covers a URL typed on the command line');
  assert.equal(isAutoAllowed('git push git@evil.example:r.git', ['git push']), false);
  assert.equal(isAutoAllowed('git push --force', ['git push']), false);
  const rules = { allowCommands: ['git push'], denyCommands: ['git push --force'] };
  assert.deepEqual(await decide('cd sub && git push origin main', { rules }), { decision: 'allow' }, 'each part is matched on its own');
  assert.equal((await decide('git push --force origin main', { rules })).decision, 'deny', 'the deny list still wins');
  assert.equal((await decide('cd sub && git push origin main', {})).decision, 'ask', 'without the entry it is risky');
  const grants = new RunGrants();
  grants.allowRules.add('git push');
  assert.deepEqual(await decide('git add -A && git commit -m x && git push', { grants }), { decision: 'allow' }, 'an always-allow from this run counts at once');
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

test('auto: when the safety model cannot answer, the card says so and why the rules could not decide', async () => {
  const busy: CommandSafetyCheck = { async check() { return { allow: false, reason: 'The safety check model is busy (rate limited by NEAR), so NEAR AI is asking you instead.' }; } };
  const decided = await decide('npm install left-pad', { safety: busy });
  assert.equal(decided.decision, 'ask');
  const reason = decided.decision === 'ask' ? decided.reason ?? '' : '';
  assert.match(reason, /^The safety check model is busy \(rate limited by NEAR\)/);
  assert.match(reason, /the rules couldn't place this command \(npm install can install or run code the rules cannot check\)/);
  const grants = new RunGrants();
  grants.tainted = true;
  const tainted = await decide('curl https://example.com', { grants, safety: busy });
  assert.match(tainted.decision === 'ask' ? tainted.reason ?? '' : '', /read outside content .* can reach the network, so it asks; the rules couldn't place this command/);
});

test('agent loop in auto: the managed Open-GSD runtime\'s gsd-tools runs without an approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-auto-gsd-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-auto-gsd-home-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(home, 'gsd-core', 'bin'), { recursive: true });
  const tools = path.join(home, 'gsd-core', 'bin', 'gsd-tools.cjs');
  await writeFile(tools, 'console.log(JSON.stringify({ phase: process.argv.slice(2).join(" ") }));\n');
  const model = scriptedModel([
    { calls: [call('g1', 'Bash', { command: `INIT=$(node "${tools}" query init.plan-phase 3)` })] },
    { calls: [call('g2', 'Bash', { command: `node "${tools}" query init.plan-phase 3` })] },
    { calls: [call('g3', 'Bash', { command: `node "${path.join(path.dirname(home), 'gsd-evil', 'gsd-core', 'bin', 'gsd-tools.cjs')}" query x` })] },
    { text: 'Planned.' }
  ]);
  const approvals: ApprovalRequest[] = [];
  const safety = fakeSafety(false);
  const shell = new ShellSession(root);
  const run = new AgentRun({
    client: model, model: 'z-ai/glm-5.3', tools: CORE_TOOLS,
    context: { root, checkpoints: new RunCheckpoints('auto-gsd'), shell, readFiles: new Set(), readOnlyRoots: [home], trustedToolRoots: [home] },
    policy: auto, rules: DEFAULT_RULES, safety: safety.check,
    requestApproval: async (request) => { approvals.push(request); return { decision: 'deny' }; },
    emit: () => undefined
  });
  try {
    const result = await run.run([{ role: 'user', content: 'Plan phase 3' }], new AbortController().signal);
    assert.equal(result.outcome, 'completed');
    const ran = model.seen[2].at(-1);
    assert.match(ran?.role === 'tool' ? ran.content : '', /"phase":"query init\.plan-phase 3"[\s\S]*exit code 0/, 'gsd-tools ran without an approval');
    assert.equal(approvals.length, 1, 'only the look-alike path asked');
    assert.match(approvals[0].title, /gsd-evil/);
    assert.deepEqual(safety.asked.length, 1, 'only the look-alike went to the safety model');
  } finally {
    shell.dispose();
  }
});

test('agent loop: "always allow" offers a narrow entry, saves it, and covers later commands in the same run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-always-'));
  const model = scriptedModel([
    { calls: [call('a1', 'Bash', { command: 'docker version' })] },
    { calls: [call('a2', 'Bash', { command: 'docker info' })] },
    { calls: [call('a3', 'Bash', { command: 'docker version' })] },
    { text: 'Done.' }
  ]);
  const approvals: ApprovalRequest[] = [];
  const saved: string[] = [];
  const shell = new ShellSession(root);
  const run = new AgentRun({
    client: model, model: 'z-ai/glm-5.3', tools: CORE_TOOLS,
    context: { root, checkpoints: new RunCheckpoints('always'), shell, readFiles: new Set() },
    policy: auto, rules: DEFAULT_RULES, safety: fakeSafety(false).check,
    requestApproval: async (request) => { approvals.push(request); return { decision: 'allow-always' }; },
    rememberAllowRule: (rule) => { saved.push(rule); },
    emit: () => undefined
  });
  try {
    assert.equal((await run.run([{ role: 'user', content: 'Check docker' }], new AbortController().signal)).outcome, 'completed');
    assert.equal(approvals.length, 2, 'docker info is a different entry and asks once; the repeat of docker version does not ask');
    assert.equal(approvals[0].allowRule, 'docker version');
    assert.equal(approvals[1].allowRule, 'docker info');
    assert.deepEqual(saved, ['docker version', 'docker info']);
  } finally {
    shell.dispose();
  }
});

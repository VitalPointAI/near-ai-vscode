import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { loadAgents, loadSkills } from '../gsd/library';
import { gsdShellEnv } from '../gsd/runtime';
import { AgentConversation, findSkill } from '../services/agentSession';
import { NearAiClient, type ModelInfo, type UsageMetadata } from '../services/nearAiClient';

// Live tests against NEAR AI Cloud. They spend real money (cents), so they are opt-in:
//   NEAR_AI_API_KEY=...                      tool round trip, signature verification, billing
//   NEAR_LIVE_EVAL=1                         also compare default-model candidates on fixed coding tasks
//   NEAR_LIVE_GSD=1 NEAR_GSD_HOME=<runtime>  also run /gsd-map-codebase end to end on a sample repo
const key = process.env.NEAR_AI_API_KEY;
const baseUrl = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
const skip = key ? false : 'set NEAR_AI_API_KEY to run live NEAR AI tests';
const run = promisify(execFile);

async function client(): Promise<{ client: NearAiClient; models: ModelInfo[] }> {
  const near = new NearAiClient({ baseUrl, apiKey: key! });
  const models = await near.listModels();
  await near.listModelPrivacy().catch(() => undefined);
  return { client: near, models };
}

function pick(models: ModelInfo[], pattern: RegExp): string | undefined {
  return models.map((model) => model.id).find((id) => pattern.test(id));
}

/** Runs the harness non-interactively in `root` and returns the outcome and usage. */
async function agent(near: NearAiClient, model: string, root: string, prompt: string, maxTurns = 30): Promise<{ outcome: string; answer: string; usage: UsageMetadata[]; ms: number }> {
  const shell = new ShellSession(root);
  const started = Date.now();
  try {
    const result = await new AgentRun({
      client: near, model, tools: CORE_TOOLS, maxTurns,
      context: { root, checkpoints: new RunCheckpoints(`live-${Date.now()}`), shell, readFiles: new Set() },
      policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
      requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined
    }).run([{ role: 'system', content: 'You are a coding agent working in the current directory. Use the tools to inspect and change files and run commands. Finish with a one-paragraph summary.' }, { role: 'user', content: prompt }], new AbortController().signal);
    const answer = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content ?? '';
    return { outcome: result.outcome, answer: String(answer), usage: result.usage, ms: Date.now() - started };
  } finally {
    shell.dispose();
  }
}

test('live: GLM 5.3 reads a file through a tool round trip, the response verifies, and billing reports the cost', { skip, timeout: 180_000 }, async () => {
  const { client: near, models } = await client();
  const model = pick(models, /^z-ai\/glm-5\.3$/i) ?? pick(models, /glm-5\.3/i)!;
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-live-'));
  await writeFile(path.join(root, 'secret-word.txt'), 'The word is pelican-4127.\n');
  const result = await agent(near, model, root, 'What is the word in secret-word.txt? Answer with just the word.', 6);
  assert.equal(result.outcome, 'completed');
  assert.match(result.answer, /pelican-4127/);
  assert.ok(result.usage.length >= 2, 'at least one tool turn and one answer turn');
  const last = result.usage.at(-1)!;
  assert.ok(last.evidence, 'the completion kept verification evidence');
  const verification = await near.verifyResponse(model, last.evidence!);
  console.log(`verification: ${verification.outcome} — ${verification.summary}`);
  assert.equal(verification.outcome, 'signed', verification.summary);
  const cost = await near.actualCostsUsd(result.usage.map((usage) => usage.requestId!).filter(Boolean));
  console.log(`actual cost: $${cost}`);
  assert.ok(cost !== undefined && cost > 0);
});

const TASKS: Array<{ name: string; files: Record<string, string>; prompt: string }> = [
  {
    name: 'implement',
    files: { 'slug.js': 'module.exports = function slugify(text) {\n  throw new Error("not implemented");\n};\n', 'slug.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\nconst slugify = require("./slug");\ntest("slugify", () => {\n  assert.equal(slugify("Hello, World!"), "hello-world");\n  assert.equal(slugify("  Many   spaces  "), "many-spaces");\n  assert.equal(slugify("Ünïcödé café"), "unicode-cafe");\n  assert.equal(slugify("---"), "");\n});\n' },
    prompt: 'Implement slugify in slug.js so `node --test` passes. Do not change the test.'
  },
  {
    name: 'fix-bug',
    files: { 'cart.js': 'function total(items, discount) {\n  let sum = 0;\n  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;\n  return discount ? sum - sum * discount : sum;\n}\nmodule.exports = { total };\n', 'cart.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { total } = require("./cart");\ntest("total", () => {\n  assert.equal(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }]), 7);\n  assert.equal(total([{ price: 10, qty: 1 }], 0.1), 9);\n  assert.equal(total([]), 0);\n});\n' },
    prompt: 'The tests in cart.test.js fail. Find and fix the bug in cart.js; run `node --test` to confirm.'
  },
  {
    name: 'refactor',
    files: { 'a.js': 'const { fetchUser } = require("./api");\nmodule.exports = (id) => fetchUser(id).name;\n', 'b.js': 'const { fetchUser } = require("./api");\nmodule.exports = (id) => fetchUser(id).email;\n', 'api.js': 'exports.fetchUser = (id) => ({ id, name: "n" + id, email: id + "@x" });\n', 'rename.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\ntest("renamed", () => {\n  const api = require("./api");\n  assert.equal(typeof api.getUser, "function");\n  assert.equal(api.fetchUser, undefined);\n  assert.equal(require("./a")(1), "n1");\n  assert.equal(require("./b")(2), "2@x");\n});\n' },
    prompt: 'Rename fetchUser to getUser everywhere (api.js and every caller) so `node --test` passes.'
  }
];

test('live eval: default-model candidates on fixed coding tasks', { skip: skip || (process.env.NEAR_LIVE_EVAL ? false : 'set NEAR_LIVE_EVAL=1'), timeout: 1_800_000 }, async () => {
  const { client: near, models } = await client();
  const candidates = [pick(models, /^z-ai\/glm-5\.3$/i), pick(models, /kimi-k3/i), pick(models, /deepseek-v4\.1-flash/i)].filter((id): id is string => Boolean(id));
  const rows: Array<Record<string, unknown>> = [];
  for (const model of candidates) {
    for (const task of TASKS) {
      const root = await mkdtemp(path.join(tmpdir(), `near-ai-eval-${task.name}-`));
      for (const [name, content] of Object.entries(task.files)) await writeFile(path.join(root, name), content);
      let outcome = 'error';
      let usage: UsageMetadata[] = [];
      let ms = 0;
      try { ({ outcome, usage, ms } = await agent(near, model, root, task.prompt)); } catch (error) { outcome = `error: ${(error as Error).message.slice(0, 80)}`; }
      const passed = await run(process.execPath, ['--test'], { cwd: root }).then(() => true, () => false);
      const cost = await near.actualCostsUsd(usage.map((turn) => turn.requestId!).filter(Boolean)).catch(() => undefined);
      rows.push({ model, task: task.name, passed, outcome, turns: usage.length, seconds: Math.round(ms / 1000), costUsd: cost });
      // Each run takes from seconds to minutes; report as they finish so a long run doesn't look hung.
      console.log(`eval ${rows.length}/${candidates.length * TASKS.length}: ${model} ${task.name} ${passed ? 'passed' : 'FAILED'} (${outcome}, ${usage.length} turns, ${Math.round(ms / 1000)}s${cost !== undefined ? `, $${cost.toFixed(4)}` : ''})`);
    }
  }
  console.table(rows);
  const out = process.env.NEAR_LIVE_EVAL_OUT;
  if (out) await writeFile(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  assert.ok(rows.length > 0);
});

test('live GSD: /gsd-map-codebase runs end to end on a sample repository', { skip: skip || (process.env.NEAR_LIVE_GSD && process.env.NEAR_GSD_HOME ? false : 'set NEAR_LIVE_GSD=1 and NEAR_GSD_HOME'), timeout: 3_600_000 }, async () => {
  const home = process.env.NEAR_GSD_HOME!;
  const { client: near, models } = await client();
  const model = pick(models, /^z-ai\/glm-5\.3$/i)!;
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-live-'));
  for (const task of TASKS) for (const [name, content] of Object.entries(task.files)) await writeFile(path.join(root, name), content);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
  await run('git', ['init', '-q'], { cwd: root });
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-storage-'));
  const gsd = { home, skills: await loadSkills(home), agents: await loadAgents(home), shellEnv: await gsdShellEnv(home, storage, true) };
  const skill = findSkill(gsd.skills, 'gsd-map-codebase');
  assert.ok(skill, 'the runtime has gsd-map-codebase');
  const posted: Array<{ type: string; [key: string]: unknown }> = [];
  // A timeline of tool calls, so a slow run shows where the time went.
  const started = Date.now();
  const open = new Map<string, { title: string; at: number }>();
  const spans: Array<{ title: string; startS: number; seconds: number }> = [];
  // Answer any question with its first option, as a user accepting the recommendation would.
  const conversation: AgentConversation = new AgentConversation(root, (message) => {
    const value = message as { type: string; id?: string; callId?: string; title?: string; questions?: Array<{ question: string; options: Array<{ label: string }> }> };
    posted.push(value);
    if (value.type === 'tool-start' && value.callId) open.set(value.callId, { title: String(value.title), at: Date.now() });
    if (value.type === 'tool-end' && value.callId && open.has(value.callId)) {
      const span = open.get(value.callId)!;
      spans.push({ title: span.title, startS: Math.round((span.at - started) / 1000), seconds: Math.round((Date.now() - span.at) / 1000) });
    }
    if (value.type === 'questions-request' && value.id && value.questions) conversation.answerQuestions(value.id, value.questions.map((question) => question.options[0]?.label ?? 'yes'));
  }, path.join(storage, 'checkpoints'));
  try {
    await conversation.send({ text: '/gsd-map-codebase', skill: { name: skill!.name, args: '' }, gsd, client: near, model, privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, tiers: { deep: model, standard: model, fast: pick(models, /glm-5\.3-flash/i) ?? model }, availableModels: models.map((candidate) => candidate.id), maxParallelAgents: 4, maxTurns: 80 });
  } finally {
    // The conversation keeps a shell open between turns; close it so the test process can exit.
    conversation.dispose();
  }
  const turns = posted.filter((message) => message.type === 'assistant-done').length;
  console.log(`gsd run: ${Math.round((Date.now() - started) / 1000)} s, ${spans.length} tool calls, ${turns} run(s); slowest tool calls:`);
  for (const span of [...spans].sort((a, b) => b.seconds - a.seconds).slice(0, 10)) console.log(`  ${span.seconds} s at +${span.startS} s  ${span.title.slice(0, 120)}`);
  if (process.env.NEAR_LIVE_TRACE) await writeFile(process.env.NEAR_LIVE_TRACE, JSON.stringify(spans, null, 2));
  const docs = existsSync(path.join(root, '.planning', 'codebase')) ? await readdir(path.join(root, '.planning', 'codebase')) : [];
  console.log(`codebase docs: ${docs.join(', ')}`);
  assert.ok(posted.some((message) => message.type === 'assistant-done'), 'the run finished');
  assert.ok(docs.length >= 4, `expected the mapper documents, got: ${docs.join(', ') || 'none'}`);
});

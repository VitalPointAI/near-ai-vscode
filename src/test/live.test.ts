import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { prepareAttachments, stageAttachment } from '../agent/attachments';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt } from '../agent/systemPrompt';
import { CORE_TOOLS } from '../agent/tools';
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import { DEFAULT_ROLE_MODELS, loadAgents, loadSkills } from '../gsd/library';
import { gsdShellEnv } from '../gsd/runtime';
import { ActivityFeed, timeBreakdown } from '../services/agentActivity';
import { AgentConversation, findSkill } from '../services/agentSession';
import { gradeExecution, loadExecutionTasks, setUpExecutionTask, type ExecutionTask } from './evalExecution';
import { fixPrompt, parseCandidate, REVIEW_FILE, reviewPrompt, reviewVerdict } from './evalReview';
import { gradePlan, gradeResearch, PLAN_PROMPT, PLAN_SPEC, RESEARCH_PROMPT, RESEARCH_SOURCES } from './evalGraders';
import { NearAiClient, type ModelInfo, type UsageMetadata } from '../services/nearAiClient';

// Live tests against NEAR AI Cloud. They spend real money (cents), so they are opt-in:
//   NEAR_AI_API_KEY=...                      tool round trip, signature verification, billing
//   NEAR_LIVE_EVAL=1                         also compare models on coding, research, and planning tasks
//                                            (NEAR_LIVE_EVAL_MODELS=a,b; NEAR_LIVE_EVAL_RUNS=2; NEAR_LIVE_EVAL_OUT=file.json;
//                                            a+b: model a builds, model b reviews, a fixes the gaps)
//   (with the key alone, also: image and voice-note attachments and image generation)
//   NEAR_LIVE_GSD=1 NEAR_GSD_HOME=<runtime>  also run /gsd-map-codebase on a sample repo and a full
//                                            GSD cycle (new-project, plan, execute in worktrees)
const key = process.env.NEAR_AI_API_KEY;
const baseUrl = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
const skip = key ? false : 'set NEAR_AI_API_KEY to run live NEAR AI tests';
const run = promisify(execFile);

/**
 * Whether the task's tests pass. This file runs under `node --test`, whose NODE_TEST_CONTEXT makes
 * a child `node --test` exit 0 even when tests fail, so the child gets an environment without it.
 */
async function testsPass(root: string): Promise<boolean> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return run(process.execPath, ['--test'], { cwd: root, env }).then(() => true, () => false);
}

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
async function agent(near: NearAiClient, model: string, root: string, prompt: string, maxTurns = 30): Promise<{ outcome: string; answer: string; usage: UsageMetadata[]; ms: number; changed: string[] }> {
  const shell = new ShellSession(root);
  const started = Date.now();
  const checkpoints = new RunCheckpoints(`live-${Date.now()}`);
  try {
    const result = await new AgentRun({
      client: near, model, tools: CORE_TOOLS, maxTurns,
      context: { root, checkpoints, shell, readFiles: new Set() },
      policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
      requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined
    // The production system prompt, so the eval measures models as the extension runs them.
    }).run([{ role: 'system', content: agentSystemPrompt({ root, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString().slice(0, 10), isGitRepo: false, model }) }, { role: 'user', content: prompt }], new AbortController().signal);
    const answer = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content ?? '';
    return { outcome: result.outcome, answer: String(answer), usage: result.usage, ms: Date.now() - started, changed: checkpoints.changedFiles };
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

// No overall timeout: the eval's length grows with models x runs (a slow model took ~4h alone), each run is
// bounded by its turn limit, and progress prints per run.
test('live eval: models compared on coding, research, and planning tasks', { skip: skip || (process.env.NEAR_LIVE_EVAL ? false : 'set NEAR_LIVE_EVAL=1'), timeout: Infinity }, async () => {
  const { client: near, models } = await client();
  const wanted = (process.env.NEAR_LIVE_EVAL_MODELS ?? 'z-ai/glm-5.3,z-ai/glm-5.3-flash').split(',').map((id) => id.trim()).filter(Boolean);
  const offered = (id: string | undefined) => !id || models.some((model) => model.id === id);
  const candidates = wanted.filter((spec) => { const { builder, reviewer } = parseCandidate(spec); return offered(builder) && offered(reviewer); });
  assert.ok(candidates.length, `none of ${wanted.join(', ')} is offered`);
  const runs = Math.max(1, Number(process.env.NEAR_LIVE_EVAL_RUNS ?? 2));
  const tasks: Array<{ name: string; kind: 'coding' | 'research' | 'planning' | 'execution'; files: Record<string, string>; prompt: string; execution?: ExecutionTask }> = [
    ...TASKS.map((task) => ({ name: task.name, kind: 'coding' as const, files: task.files, prompt: task.prompt })),
    { name: 'research-brief', kind: 'research' as const, files: RESEARCH_SOURCES, prompt: RESEARCH_PROMPT },
    { name: 'phase-plan', kind: 'planning' as const, files: { 'spec.md': PLAN_SPEC }, prompt: PLAN_PROMPT },
    // Building from a plan, an issue, or a spec in a multi-file project, scored by acceptance tests the model never sees.
    ...(await loadExecutionTasks()).map((task) => ({ name: task.name, kind: 'execution' as const, files: {}, prompt: task.prompt, execution: task }))
  ];
  const total = candidates.length * tasks.length * runs;
  const rows: Array<{ model: string; task: string; kind: string; run: number; score: number; outOf: number; outcome: string; review?: string; turns: number; seconds: number; tokPerSec?: number; costUsd?: number; reviewCostUsd?: number; cachePct: number; misses: string }> = [];
  const costOf = async (usage: UsageMetadata[]) => {
    const actual = await near.actualCostsUsd(usage.map((turn) => turn.requestId!).filter(Boolean)).catch(() => undefined);
    const estimated = usage.reduce((sum, turn) => sum + (turn.estimatedCostUsd ?? 0), 0);
    return { usd: actual ?? (estimated > 0 ? estimated : undefined), estimated: actual === undefined };
  };
  for (const model of candidates) {
    const { builder, reviewer } = parseCandidate(model);
    for (const task of tasks) {
      for (let attempt = 1; attempt <= runs; attempt += 1) {
        const root = await mkdtemp(path.join(tmpdir(), `near-ai-eval-${task.name}-`));
        for (const [name, content] of Object.entries(task.files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
        if (task.execution) await setUpExecutionTask(task.execution, root);
        let outcome = 'error';
        let usage: UsageMetadata[] = [];
        let ms = 0;
        const turnLimit = task.kind === 'execution' ? 50 : 30;
        try { ({ outcome, usage, ms } = await agent(near, builder, root, task.prompt, turnLimit)); } catch (error) { outcome = `error: ${(error as Error).message.slice(0, 80)}`; }
        // With a reviewer: it lists gaps in REVIEW.md, and the builder gets one pass to fix them.
        let review: string | undefined;
        let reviewUsage: UsageMetadata[] = [];
        if (reviewer && !outcome.startsWith('error')) {
          try {
            const checked = await agent(near, reviewer, root, reviewPrompt(task.prompt), 25);
            reviewUsage = checked.usage;
            ms += checked.ms;
            const verdict = reviewVerdict(await readFile(path.join(root, REVIEW_FILE), 'utf8').catch(() => undefined));
            const edited = checked.changed.filter((file) => path.basename(file) !== REVIEW_FILE);
            review = verdict.approved ? 'approved' : verdict.gaps ? 'gaps' : 'none';
            if (edited.length) review += ` (reviewer edited ${edited.map((file) => path.relative(root, file)).join(', ')})`;
            if (!verdict.approved && verdict.gaps) {
              const fixed = await agent(near, builder, root, fixPrompt(task.prompt, verdict.gaps), turnLimit);
              usage = [...usage, ...fixed.usage];
              ms += fixed.ms;
              outcome = fixed.outcome;
              review += ', fixed';
            }
          } catch (error) { review = `error: ${(error as Error).message.slice(0, 80)}`; }
        }
        let score = 0;
        let outOf = 10;
        let misses: string[] = [];
        if (task.execution) ({ score, misses } = await gradeExecution(task.execution, root));
        else if (task.kind === 'coding') {
          // Passing only counts if the tests are the ones it was given.
          const changed = [];
          for (const [name, content] of Object.entries(task.files)) if (/\.test\.js$/.test(name) && await readFile(path.join(root, name), 'utf8').catch(() => '') !== content) changed.push(name);
          if (changed.length) misses = [`changed the test: ${changed.join(', ')}`];
          else if (!await testsPass(root)) misses = ['tests fail'];
          score = misses.length ? 0 : 10;
        }
        else {
          const file = path.join(root, task.kind === 'research' ? 'brief.md' : 'PLAN.md');
          const text = await readFile(file, 'utf8').catch(() => '');
          ({ score, misses } = text ? (task.kind === 'research' ? gradeResearch(text) : gradePlan(text)) : { score: 0, misses: [`no ${path.basename(file)} written`] });
          outOf = 10;
        }
        const built = await costOf(usage);
        const reviewed = reviewUsage.length ? await costOf(reviewUsage) : undefined;
        const costUsd = built.usd === undefined && reviewed?.usd === undefined ? undefined : (built.usd ?? 0) + (reviewed?.usd ?? 0);
        const estimatedCost = built.estimated || reviewed?.estimated === true;
        const all = [...usage, ...reviewUsage];
        const input = all.reduce((sum, turn) => sum + (turn.inputTokens ?? 0), 0);
        const cachePct = input ? Math.round((100 * all.reduce((sum, turn) => sum + (turn.cachedInputTokens ?? 0), 0)) / input) : 0;
        // Generation speed, not counting the wait for each reply's first token.
        const generatingMs = all.reduce((sum, turn) => sum + Math.max(0, turn.latencyMs - (turn.firstTokenMs ?? 0)), 0);
        const output = all.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0);
        const tokPerSec = generatingMs > 0 && output ? Math.round(output / (generatingMs / 1000)) : undefined;
        rows.push({ model, task: task.name, kind: task.kind, run: attempt, score, outOf, outcome, ...(review ? { review } : {}), turns: all.length, seconds: Math.round(ms / 1000), ...(tokPerSec !== undefined ? { tokPerSec } : {}), ...(costUsd !== undefined ? { costUsd } : {}), ...(reviewed?.usd !== undefined ? { reviewCostUsd: reviewed.usd } : {}), cachePct, misses: misses.join('; ') });
        // Report each run as it finishes, so a long eval never looks hung.
        console.log(`eval ${rows.length}/${total}: ${model} ${task.name} #${attempt}: ${score}/${outOf} (${outcome}${review ? `, review: ${review}` : ''}, ${all.length} turns, ${Math.round(ms / 1000)}s${tokPerSec !== undefined ? ` at ${tokPerSec} tok/s` : ''}${costUsd !== undefined ? `, $${costUsd.toFixed(4)}${estimatedCost ? ' est.' : ''}${reviewed?.usd !== undefined ? ` incl. $${reviewed.usd.toFixed(4)} review` : ''}` : ''}, ${cachePct}% cached)${misses.length ? ` missed: ${misses.join('; ')}` : ''}`);
      }
    }
  }
  console.table(rows.map(({ misses, ...row }) => row));
  const summary = candidates.map((model) => {
    const mine = rows.filter((row) => row.model === model);
    const avg = (kind: string) => { const list = mine.filter((row) => row.kind === kind); return list.length ? Math.round((10 * list.reduce((sum, row) => sum + row.score, 0)) / list.length) / 10 : undefined; };
    const costs = mine.map((row) => row.costUsd).filter((value): value is number => value !== undefined);
    const speeds = mine.map((row) => row.tokPerSec).filter((value): value is number => value !== undefined);
    // A pair is only as private as its less private model.
    const forwarded = Object.values(parseCandidate(model)).map((id) => models.find((candidate) => candidate.id === id)).find((info) => info?.privacyBoundary !== 'tee');
    const reviews = mine.map((row) => row.reviewCostUsd).filter((value): value is number => value !== undefined);
    return { model, privacy: forwarded ? `forwarded${forwarded.forwardedTo ? ` (${forwarded.forwardedTo})` : ''}` : 'TEE', coding: `${mine.filter((row) => row.kind === 'coding' && row.score === 10).length}/${mine.filter((row) => row.kind === 'coding').length} passed`, research: avg('research'), planning: avg('planning'), execution: avg('execution'), totalCostUsd: costs.length ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(4)) : undefined, ...(reviews.length ? { reviewCostUsd: Number(reviews.reduce((sum, value) => sum + value, 0).toFixed(4)), approved: `${mine.filter((row) => row.review?.startsWith('approved')).length}/${mine.length}` } : {}), avgSeconds: Math.round(mine.reduce((sum, row) => sum + row.seconds, 0) / mine.length), avgTokPerSec: speeds.length ? Math.round(speeds.reduce((sum, value) => sum + value, 0) / speeds.length) : undefined, avgCachePct: Math.round(mine.reduce((sum, row) => sum + row.cachePct, 0) / mine.length) };
  });
  console.log('summary (research, planning, and execution are average scores out of 10; execution is the share of hidden acceptance tests passed):');
  console.table(summary);
  const out = process.env.NEAR_LIVE_EVAL_OUT;
  if (out) await writeFile(out, JSON.stringify({ at: new Date().toISOString(), runs, rows, summary }, null, 2));
  assert.ok(rows.length > 0);
});

type Posted = { type: string; [key: string]: unknown };
type GsdContextFor = Awaited<ReturnType<typeof gsdFor>>;

async function gsdFor(home: string) {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-storage-'));
  return { storage, gsd: { home, skills: await loadSkills(home), agents: await loadAgents(home), shellEnv: await gsdShellEnv(home, storage, true) } };
}

/**
 * Runs one GSD command in a fresh conversation, answering every question with its first
 * (recommended) option, and prints the slowest tool calls so a slow run shows where time went.
 */
async function runGsdCommand(near: NearAiClient, models: ModelInfo[], root: string, context: GsdContextFor, command: string, args = ''): Promise<{ posted: Posted[]; seconds: number }> {
  const model = pick(models, /^z-ai\/glm-5\.3$/i)!;
  const skill = findSkill(context.gsd.skills, command);
  assert.ok(skill, `the runtime has ${command}`);
  const posted: Posted[] = [];
  const started = Date.now();
  const open = new Map<string, { title: string; at: number }>();
  const spans: Array<{ title: string; startS: number; seconds: number }> = [];
  // The same feed Agent Activity shows, so the run prints where each agent's time went.
  const feed = new ActivityFeed({ maxAgeMs: 24 * 3_600_000, maxBytes: 64 * 1_048_576 });
  const conversation: AgentConversation = new AgentConversation(root, (message) => {
    const value = message as { type: string; id?: string; callId?: string; title?: string; text?: string; preview?: unknown; questions?: Array<{ question: string; options: Array<{ label: string }> }> };
    posted.push(value);
    if (value.type === 'tool-start' && value.callId) open.set(value.callId, { title: String(value.title), at: Date.now() });
    if (value.type === 'tool-end' && value.callId && open.has(value.callId)) {
      const span = open.get(value.callId)!;
      spans.push({ title: span.title, startS: Math.round((span.at - started) / 1000), seconds: Math.round((Date.now() - span.at) / 1000) });
    }
    if (value.type === 'notice' || value.type === 'progress' || value.type === 'assistant-retry') console.log(`  notice: ${String(value.text).slice(0, 200)}`);
    if (value.type === 'questions-request' && value.id && value.questions) conversation.answerQuestions(value.id, value.questions.map((question) => question.options[0]?.label ?? 'yes'));
    // Unattended, as in production: an action held for approval (even in fully-autonomous mode, e.g.
    // a network command after reading web pages) ends declined once nobody answers. Decline it at
    // once instead of waiting out the timeout, and print it, so the run must cope as it would for a user.
    if (value.type === 'approval-request' && value.callId) {
      const preview = value.preview as { kind?: string; text?: string } | undefined;
      console.log(`  held for approval, declined (unattended): ${String(value.title)} — ${String(preview?.text ?? '').split('\n')[0].slice(0, 200)}`);
      conversation.answerApproval(String(value.callId), { decision: 'deny', feedback: 'Nobody answered (the user may be away). Continue without this action if you can, and report what still needs their approval.' });
    }
  }, path.join(context.storage, 'checkpoints'), undefined, undefined, feed);
  // Production defaults (domain/agentDefaults.ts), the same the extension uses; fully-autonomous
  // is the mode a user picks for an unattended run, which is what this simulates.
  const budget = { maxCostUsd: process.env.NEAR_LIVE_BUDGET_USD ? Number(process.env.NEAR_LIVE_BUDGET_USD) : AGENT_DEFAULTS.maxRunCostUsd, maxTokens: AGENT_DEFAULTS.maxRunTokens };
  if (process.env.NEAR_LIVE_BUDGET_USD) console.log(`  WARNING: NEAR_LIVE_BUDGET_USD=${budget.maxCostUsd} overrides the production default of $${AGENT_DEFAULTS.maxRunCostUsd}; this result does not reflect what users get.`);
  try {
    await conversation.send({ text: `/${skill!.name}${args ? ` ${args}` : ''}`, skill: { name: skill!.name, args }, gsd: context.gsd, client: near, model, privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, tiers: { ...AGENT_DEFAULTS.tiers }, roleModels: DEFAULT_ROLE_MODELS, availableModels: models.map((candidate) => candidate.id), contextWindows: Object.fromEntries(models.filter((candidate) => candidate.contextLength).map((candidate) => [candidate.id, candidate.contextLength!])), maxParallelAgents: AGENT_DEFAULTS.maxParallelAgents, maxTurns: AGENT_DEFAULTS.maxTurns, maxOutputTokens: AGENT_DEFAULTS.maxOutputTokens, budget });
  } finally {
    // The conversation keeps a shell open between turns; close it so the test process can exit.
    conversation.dispose();
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const agents = spans.filter((span) => /^gsd-[\w-]+: /.test(span.title)).length;
  const spend = conversation.runSpend;
  console.log(`/${skill!.name} ${args}: ${seconds} s, ${spans.length} tool calls, ${agents} sub-agent(s), estimated $${spend.costUsd.toFixed(2)} for ${spend.totalTokens.toLocaleString('en-US')} tokens (${spend.totalTokens ? Math.round((100 * spend.cachedTokens) / spend.totalTokens) : 0}% cached); slowest tool calls:`);
  for (const span of [...spans].sort((a, b) => b.seconds - a.seconds).slice(0, 10)) console.log(`  ${span.seconds} s at +${span.startS} s  ${span.title.slice(0, 120)}`);
  console.log('  where the time went, per agent (wait = before each reply starts; generate = streaming it; tools = everything else):');
  for (const stat of feed.agentStats()) {
    const time = timeBreakdown(stat);
    const s = (ms: number) => `${Math.round(ms / 1000)} s`;
    console.log(`  ${stat.agent.padEnd(34).slice(0, 34)} ${stat.model.replace(/^.*\//, '').padEnd(14)} ${s(time.elapsedMs).padStart(7)} total: wait ${s(time.waitMs)}, generate ${s(time.generateMs)}, tools ${s(time.otherMs)} · ${stat.turns} turns · ${stat.outputTokens.toLocaleString('en-US')} out (${time.reasoningShare === undefined ? '?' : Math.round(100 * time.reasoningShare)}% reasoning${stat.reasoningEstimated ? ', est.' : ''}) at ${time.tokensPerSecond?.toFixed(0) ?? '?'} tok/s · $${stat.costUsd.toFixed(3)}`);
  }
  if (process.env.NEAR_LIVE_TRACE) await writeFile(`${process.env.NEAR_LIVE_TRACE}.${skill!.name}.json`, JSON.stringify({ spans, agents: feed.agentStats() }, null, 2));
  assert.ok(posted.some((message) => message.type === 'assistant-done'), `/${skill!.name} finished`);
  return { posted, seconds };
}

const gsdSkip = skip || (process.env.NEAR_LIVE_GSD && process.env.NEAR_GSD_HOME ? false : 'set NEAR_LIVE_GSD=1 and NEAR_GSD_HOME');

test('live GSD: /gsd-map-codebase runs end to end on a sample repository', { skip: gsdSkip, timeout: 3_600_000 }, async () => {
  const { client: near, models } = await client();
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-live-'));
  for (const task of TASKS) for (const [name, content] of Object.entries(task.files)) await writeFile(path.join(root, name), content);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
  await run('git', ['init', '-q'], { cwd: root });
  await runGsdCommand(near, models, root, await gsdFor(process.env.NEAR_GSD_HOME!), 'gsd-map-codebase');
  const docs = existsSync(path.join(root, '.planning', 'codebase')) ? await readdir(path.join(root, '.planning', 'codebase')) : [];
  console.log(`codebase docs: ${docs.join(', ')}`);
  assert.ok(docs.length >= 4, `expected the mapper documents, got: ${docs.join(', ') || 'none'}`);
});

const IDEA = `# tempconv

A tiny Node.js library with no dependencies.

- \`tempconv.js\` exports \`cToF(c)\` and \`fToC(f)\`. Results are rounded to one decimal place.
  Non-number input throws a TypeError.
- \`tempconv.test.js\` tests both functions with \`node:test\`; \`npm test\` runs it.

Scope: a single phase. No CLI, UI, network access, or packaging.
`;

async function filesUnder(dir: string, pattern: RegExp): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile() && pattern.test(entry.name)) found.push(path.join(entry.parentPath, entry.name));
  return found;
}

test('live GSD: idea to working code — new-project, plan-phase, and execute-phase in worktrees', { skip: gsdSkip, timeout: 4 * 3_600_000 }, async () => {
  const { client: near, models } = await client();
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-cycle-'));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'live-test@example.invalid'], { cwd: root });
  await run('git', ['config', 'user.name', 'Live test'], { cwd: root });
  await writeFile(path.join(root, 'idea.md'), IDEA);
  await run('git', ['add', 'idea.md'], { cwd: root });
  await run('git', ['commit', '-qm', 'idea'], { cwd: root });
  const context = await gsdFor(process.env.NEAR_GSD_HOME!);
  const phases = path.join(root, '.planning', 'phases');
  const steps: string[] = [];
  // --auto chains new-project into discuss, plan, and execute by itself; each later command runs
  // only if the chain stopped before reaching it, as a user would type it next.
  steps.push(`new-project ${(await runGsdCommand(near, models, root, context, 'gsd-new-project', '--auto @idea.md')).seconds} s`);
  assert.ok(existsSync(path.join(root, '.planning', 'PROJECT.md')), 'PROJECT.md was written');
  assert.ok(existsSync(path.join(root, '.planning', 'ROADMAP.md')), 'ROADMAP.md was written');
  if (!(await filesUnder(phases, /PLAN\.md$/)).length) steps.push(`plan-phase ${(await runGsdCommand(near, models, root, context, 'gsd-plan-phase', '1 --auto')).seconds} s`);
  const plans = await filesUnder(phases, /PLAN\.md$/);
  assert.ok(plans.length, 'a phase plan was written');
  if (!(await filesUnder(phases, /SUMMARY\.md$/)).length) steps.push(`execute-phase ${(await runGsdCommand(near, models, root, context, 'gsd-execute-phase', '1')).seconds} s`);
  console.log(`gsd cycle: ${steps.join(', ')}; plans: ${plans.map((file) => path.relative(root, file)).join(', ')}`);
  assert.ok((await filesUnder(phases, /SUMMARY\.md$/)).length, 'execution wrote a summary');
  // The work was merged back into the main checkout and works there.
  assert.ok(existsSync(path.join(root, 'tempconv.js')), 'tempconv.js is in the main checkout');
  const tests = await run('npm', ['test', '--silent'], { cwd: root }).catch((error: { stdout?: string; stderr?: string }) => { throw new Error(`npm test failed in the main checkout:\n${error.stdout ?? ''}${error.stderr ?? ''}`); });
  console.log(tests.stdout.split('\n').filter((line) => /^ℹ (pass|fail)/.test(line)).join('; '));
  const worktrees = (await run('git', ['worktree', 'list', '--porcelain'], { cwd: root })).stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
  const branches = (await run('git', ['branch', '--list', 'worktree-agent-*', '--format=%(refname:short)'], { cwd: root })).stdout.split('\n').filter(Boolean);
  for (const branch of branches) await run('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: root }).catch(() => { throw new Error(`${branch} has work that was never merged`); });
  console.log(`worktrees left: ${worktrees - 1}; agent branches left (all merged): ${branches.length}`);
  assert.equal(worktrees, 1, 'every executor worktree was merged and removed');
  console.log((await run('git', ['log', '--oneline'], { cwd: root })).stdout.split('\n').slice(0, 15).join('\n'));
});

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'media');

test('live media: an image, a voice note, a PDF, and a spreadsheet are read, and an image is generated', { skip, timeout: 600_000 }, async () => {
  const { client: near, models } = await client();
  const model = pick(models, /^z-ai\/glm-5\.3$/i)!;
  const documents = path.join(FIXTURES, '..', 'documents');
  const staged = [await stageAttachment(path.join(FIXTURES, 'build-code.png')), await stageAttachment(path.join(FIXTURES, 'secret-word.wav')), await stageAttachment(path.join(documents, 'report.pdf')), await stageAttachment(path.join(documents, 'sales.xlsx'))];
  const question = 'What is the build code in the image, the secret word in the voice note, the project codename in the PDF report, and the audit code in the spreadsheet?';
  const prepared = await prepareAttachments(staged, { client: near, model, models, visionModel: 'z-ai/glm-5.3-flash', transcriptionModel: 'openai/whisper-large-v3', question });
  console.log(`attachments: ${prepared.notes.join(' ')}\n${prepared.text}`);
  assert.match(prepared.text, /OTTER-5813/i, 'the image text was read');
  assert.match(prepared.text, /pelican/i, 'the voice note was transcribed');
  const imageModel = models.find((candidate) => candidate.id === 'black-forest-labs/FLUX.2-klein-4B' && (candidate.outputModalities ?? []).includes('image'));
  assert.ok(imageModel, 'the default image model is listed with image output');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-media-live-'));
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-media-storage-'));
  const posted: Posted[] = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message as Posted), path.join(storage, 'checkpoints'));
  try {
    await conversation.send({ text: `${question} Then generate a simple flat icon of an otter and save it to icon.png.`, attachments: prepared, imageModel, client: near, model, privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, maxTurns: 12 });
  } finally {
    conversation.dispose();
  }
  const answer = posted.filter((message) => message.type === 'assistant-delta').map((message) => String(message.text)).join('');
  console.log(`answer: ${answer.slice(-400)}`);
  assert.match(answer, /OTTER-5813/i);
  assert.match(answer, /pelican/i);
  assert.match(answer, /HERON-2291/i, 'the PDF was read');
  assert.match(answer, /KESTREL-7740/i, 'the spreadsheet was read');
  const icon = path.join(root, 'icon.png');
  assert.ok(existsSync(icon), 'the agent generated icon.png');
  assert.deepEqual([...(await readFile(icon)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'icon.png is a PNG');
});

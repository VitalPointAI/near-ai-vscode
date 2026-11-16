import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { buildWindowSummary } from '../services/activityOverview';
import { ActivityStore } from '../services/activityStore';
import { ActivityFeed, AgentStats, TASK_LABEL_MAX, taskLabel } from '../services/agentActivity';
import { AgentConversation, AgentTurnRequest, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// 0.4.28 (Team Live): what the activity feed now knows about each agent, which the live team view (and Agent Activity) draw from: who really started it,
// its task label, whether it is a team member or runs in the background, when it waits for a slot, what it waits for from the person, and how many
// reports its starter has read.

const LIMITS = { maxAgeMs: 60 * 60_000, maxBytes: 8 * 1024 * 1024 };
// Built from parts so no scanner takes the test for a real key.
const KEY = ['sk', 'proj', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('-');

function feedAt(start = 1_000_000) {
  let now = start;
  return { feed: new ActivityFeed(LIMITS, () => now), advance: (ms: number) => { now += ms; } };
}

test('a queued agent becomes the same record when it starts, keeping when it was asked for', () => {
  const { feed, advance } = feedAt();
  const before = feed.lifecycleRevision;
  feed.agentQueued({ agentId: 'planner-abc123', agent: 'planner', runId: 'run-1', model: 'm', parentId: 'main-run-1', task: 'Draft the plan', member: true, background: true });
  const queued = feed.agentStat('planner-abc123')!;
  assert.deepEqual([queued.status, queued.phase, queued.queuedAt, queued.neverStarted, queued.task, queued.member, queued.background], ['running', 'queued', 1_000_000, true, 'Draft the plan', true, true]);
  assert.ok(feed.lifecycleRevision > before, 'being queued is news');
  advance(4_000);
  feed.agentStarted({ agentId: 'planner-abc123', agent: 'planner', runId: 'run-1', model: 'm', parentId: 'main-run-1', task: 'Draft the plan', member: true, background: true }, 'the prompt', 'the system prompt');
  const stats = feed.agentStats().filter((stat) => stat.agentId === 'planner-abc123');
  assert.equal(stats.length, 1, 'one record, not two');
  assert.deepEqual([stats[0].phase, stats[0].startedAt, stats[0].queuedAt, stats[0].neverStarted, stats[0].parentId], ['starting', 1_004_000, 1_000_000, undefined, 'main-run-1']);
});

test('an agent stopped while it waited for a slot ends as stopped and is not counted as an agent that worked', () => {
  const { feed } = feedAt();
  feed.agentQueued({ agentId: 'tester-abc123', agent: 'tester', runId: 'run-1', model: 'm', parentId: 'main-run-1' });
  feed.agentEnded('tester-abc123', 'cancelled');
  const stat = feed.agentStat('tester-abc123')!;
  assert.deepEqual([stat.status, stat.neverStarted, stat.phase], ['cancelled', true, 'queued']);
  const summary = buildWindowSummary({ sessions: [], live: feed.agentStats(), window: 'today', now: 1_000_000, boundary: 'local' });
  assert.deepEqual([summary.runs, summary.agents, summary.problems.stopped], [0, 0, 0], 'the overview does not count it');
});

test('a task label is redacted, has no tags or line breaks, and is cut to 80 characters on a word boundary', () => {
  assert.equal(taskLabel(undefined), undefined);
  assert.equal(taskLabel('  \n '), undefined);
  const label = taskLabel(`Use ${KEY} to\ncall <b>the</b> API and ${'then write the long report '.repeat(5)}`)!;
  assert.doesNotMatch(label, new RegExp(KEY));
  assert.doesNotMatch(label, /[\r\n<>]/);
  assert.ok(label.length <= TASK_LABEL_MAX, `${label.length} characters`);
  assert.match(label, /…$/);
  assert.match(label, /^Use \S*REDACTED\S* to call the API and then write/);
  const key = taskLabel('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- here')!;
  assert.doesNotMatch(key, /abc|BEGIN PRIVATE/);
  // On the feed, too: what the lead wrote is never stored unredacted.
  const { feed } = feedAt();
  feed.agentStarted({ agentId: 'writer-abc123', agent: 'writer', runId: 'run-1', model: 'm', task: `Mail ${KEY}` });
  assert.doesNotMatch(JSON.stringify(feed.agentStats()), new RegExp(KEY));
});

test('the waiting kind follows an approval, a question and an image review, and clears when the wait ends', () => {
  const { feed } = feedAt();
  feed.agentStarted({ agentId: 'main-run-1', agent: 'agent', runId: 'run-1', model: 'm' });
  const kind = () => [feed.agentStat('main-run-1')!.phase, feed.agentStat('main-run-1')!.waitingKind];
  feed.approvalAsked('main-run-1');
  assert.deepEqual(kind(), ['waiting-you', 'approval']);
  feed.approvalSettled('main-run-1', 'allowed');
  assert.deepEqual(kind(), ['tool', undefined]);
  feed.waitingForUser('main-run-1', true, 'question');
  assert.deepEqual(kind(), ['waiting-you', 'question']);
  feed.waitingForUser('main-run-1', false, 'question');
  assert.deepEqual(kind(), ['tool', undefined]);
  feed.waitingForUser('main-run-1', true);
  assert.deepEqual(kind(), ['waiting-you', 'image'], 'an image review stays the default, as in 0.4.23');
  feed.agentEnded('main-run-1', 'cancelled');
  assert.deepEqual(kind(), ['thinking', undefined], 'ending while waiting clears it');
  // The 0.4.19 rule still holds: an expiry then an answer counts the prompt once.
  feed.agentStarted({ agentId: 'main-run-2', agent: 'agent', runId: 'run-2', model: 'm' });
  feed.approvalAsked('main-run-2');
  feed.approvalExpired('main-run-2');
  feed.approvalSettled('main-run-2', 'declined');
  assert.deepEqual(feed.agentStat('main-run-2')!.approvals, { autoAllowed: 0, asked: 1, declined: 1, expired: 0 });
});

test('reports read are counted, and only news moves the lifecycle revision', () => {
  const { feed } = feedAt();
  feed.agentStarted({ agentId: 'main-run-1', agent: 'team:web', runId: 'run-1', model: 'm', team: 'web' });
  assert.equal(feed.agentStat('main-run-1')!.team, 'web');
  feed.reportsDelivered('main-run-1', 0);
  assert.equal(feed.agentStat('main-run-1')!.reportsDelivered, undefined);
  feed.reportsDelivered('main-run-1', 2);
  feed.reportsDelivered('main-run-1', 1);
  assert.equal(feed.agentStat('main-run-1')!.reportsDelivered, 3);
  const revision = feed.lifecycleRevision;
  feed.stream('main-run-1', 'text', 'Working on it');
  feed.toolStarted('main-run-1', 'c1', 'Read a.ts');
  feed.toolEnded('main-run-1', 'c1', true, 'ok');
  assert.equal(feed.lifecycleRevision, revision, 'writing and running tools is not news');
  feed.setPaused('main-run-1', true);
  assert.equal(feed.lifecycleRevision, revision + 1, 'pausing is');
});

test('the reply tail is the end of the newest reply, with secrets removed, and never a prompt or a tool payload', () => {
  const { feed } = feedAt();
  feed.agentStarted({ agentId: 'writer-abc123', agent: 'writer', runId: 'run-1', model: 'm' }, `PROMPT with ${KEY}`, 'SYSTEM PROMPT');
  assert.equal(feed.replyTail('writer-abc123'), undefined);
  feed.toolStarted('writer-abc123', 'c1', 'Bash curl', '{"command":"TOOL-INPUT"}');
  feed.toolEnded('writer-abc123', 'c1', true, 'TOOL-OUTPUT');
  feed.stream('writer-abc123', 'reasoning', 'REASONING');
  assert.equal(feed.replyTail('writer-abc123'), undefined, 'only reply text counts');
  feed.stream('writer-abc123', 'text', `${'a'.repeat(400)} and the key ${KEY} is done.`);
  const tail = feed.replyTail('writer-abc123')!;
  assert.ok(tail.length <= 280);
  assert.match(tail, /^…a+ and the key \S*REDACTED\S* is done\.$/);
  assert.doesNotMatch(tail, /PROMPT|TOOL-|REASONING/);
});

test('the run team is kept for the newest runs only', () => {
  const { feed } = feedAt();
  const team = (slug: string) => ({ slug, name: slug, description: '', members: [], file: `${slug}.md` });
  for (let index = 0; index < 25; index += 1) feed.setRunTeam(`run-${index}`, team(`t${index}`));
  assert.equal(feed.runTeam('run-0'), undefined);
  assert.equal(feed.runTeam('run-24')?.slug, 't24');
});

// ---- The conversation fills these in ----

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });

async function nestedProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-live-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-live-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], shellEnv: {}, agents: [
    { name: 'gsd-lead', description: 'Leads', tools: ['Read', 'Agent', 'AskUserQuestion'], body: 'You are the lead.', file: path.join(home, 'agents', 'gsd-lead.md') },
    { name: 'gsd-planner', description: 'Plans', tools: ['Read'], body: 'You are the planner.', file: path.join(home, 'agents', 'gsd-planner.md') }
  ] };
  const posted: Array<Record<string, unknown>> = [];
  const feed = new ActivityFeed(LIMITS);
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'), undefined, undefined, feed);
  const request = (client: unknown, extra: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({ text: 'go', client: client as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd, ...extra });
  return { root, gsd, posted, feed, conversation, request };
}

const who = (messages: AgentMessage[]) => { const system = String(messages[0]?.content); return system.startsWith('You are the lead.') ? 'lead' : system.startsWith('You are the planner.') ? 'planner' : 'parent'; };

test('a nested agent\'s parent is the sub-agent that started it, and the history keeps that link', { timeout: 20_000 }, async () => {
  const { root, feed, conversation, request } = await nestedProject();
  const store = new ActivityStore(root);
  const session = await store.start({ project: 'demo', model: 'z-ai/glm-5.3' });
  const counters = { parent: 0, lead: 0, planner: 0 };
  // With one slot, the planner waits for one while the lead holds it, so it is queued before it starts.
  const phases: string[] = [];
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const role = who(messages);
      const turn = counters[role]++;
      if (role === 'parent') yield turn === 0 ? reply(null, [call('p1', 'Agent', { subagent_type: 'gsd-lead', description: 'Lead the work', prompt: 'lead it' })]) : reply('all done');
      else if (role === 'lead') yield turn === 0 ? reply(null, [call('l1', 'Agent', { subagent_type: 'gsd-planner', description: `Plan it with ${KEY}`, prompt: 'plan it' })]) : reply('lead report');
      else yield reply('planner report');
    },
    async actualCostsUsd() { return undefined; }
  };
  const subscription = feed.subscribe(() => { for (const stat of feed.agentStats()) if (stat.agent === 'gsd-planner' && phases.at(-1) !== stat.phase) phases.push(stat.phase); });
  try {
    await conversation.send(request(client, { maxParallelAgents: 1, activity: { store, sessionId: session.sessionId } }));
  } finally {
    subscription.dispose();
    conversation.dispose();
  }
  const stats = feed.agentStats();
  const main = stats.find((stat) => stat.agentId.startsWith('main-'))!;
  const lead = stats.find((stat) => stat.agent === 'gsd-lead')!;
  const planner = stats.find((stat) => stat.agent === 'gsd-planner')!;
  assert.equal(lead.parentId, main.agentId);
  assert.equal(planner.parentId, lead.agentId, 'the planner hangs under the lead that started it, not under the run');
  assert.deepEqual([lead.task, lead.member, lead.background], ['Lead the work', undefined, undefined], 'an Open-GSD agent is not a team member');
  assert.doesNotMatch(planner.task!, new RegExp(KEY));
  assert.equal(phases[0], 'queued', `the planner was queued first (${phases.join(' > ')})`);
  assert.equal(planner.queuedAt !== undefined && planner.queuedAt <= planner.startedAt, true);
  await store.flush();
  const saved = (await new ActivityStore(root).get(session.sessionId))!;
  const plannerEvents = saved.events.filter((event) => event.agentId === planner.agentId);
  assert.ok(plannerEvents.length >= 2);
  assert.ok(plannerEvents.every((event) => event.parentAgentId === lead.agentId), 'every history event names the agent that started it');
});

test('a sub-agent\'s question shows as waiting for you, for a question, until it is answered', { timeout: 20_000 }, async () => {
  const { feed, conversation, request } = await nestedProject();
  const seen: Array<string | undefined> = [];
  let asked: string | undefined;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const role = who(messages);
      const answered = messages.some((message) => message.role === 'tool');
      if (role === 'parent') yield answered ? reply('all done') : reply(null, [call('p1', 'Agent', { subagent_type: 'gsd-lead', description: 'Ask first', prompt: 'ask' })]);
      else yield answered ? reply('lead report') : reply(null, [call('q1', 'AskUserQuestion', { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] })]);
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const watch = feed.subscribe(() => {
    const lead = feed.agentStats().find((stat) => stat.agent === 'gsd-lead');
    if (lead && lead.status === 'running') { const value = lead.phase === 'waiting-you' ? `waiting-you:${lead.waitingKind}` : 'busy'; if (seen.at(-1) !== value) seen.push(value); }
  });
  const timer = setInterval(() => {
    const message = (conversation as unknown as { waiting: Map<string, Record<string, unknown>> }).waiting;
    for (const [id, value] of message) if (value.type === 'questions-request' && !asked) { asked = id; posted.push(value); conversation.answerQuestions(id, ['Blue']); }
  }, 5);
  try {
    await conversation.send(request(client));
  } finally {
    clearInterval(timer);
    watch.dispose();
    conversation.dispose();
  }
  assert.ok(asked, 'the question was asked');
  assert.ok(seen.includes('waiting-you:question'), `the lead showed as waiting for an answer (${seen.join(' > ')})`);
  assert.equal(seen.at(-1), 'busy', 'and went back to work once answered');
});

test('the lead\'s count of reports read goes up when a background report reaches its next turn', { timeout: 20_000 }, async () => {
  const { feed, conversation, request } = await nestedProject();
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const role = who(messages);
      if (role === 'planner') { yield reply('planner report'); return; }
      const heard = messages.some((message) => String(message.content ?? '').startsWith('<agent-notification'));
      yield heard ? reply('got it') : messages.some((message) => message.role === 'tool') ? reply('waiting') : reply(null, [call('p1', 'Agent', { subagent_type: 'gsd-planner', description: 'Plan it', prompt: 'plan', run_in_background: true })]);
    },
    async actualCostsUsd() { return undefined; }
  };
  try {
    await conversation.send(request(client));
  } finally {
    conversation.dispose();
  }
  const stats: AgentStats[] = feed.agentStats();
  const main = stats.find((stat) => stat.agentId.startsWith('main-'))!;
  const planner = stats.find((stat) => stat.agent === 'gsd-planner')!;
  assert.equal(main.reportsDelivered, 1);
  assert.equal(planner.background, true);
  assert.equal(planner.parentId, main.agentId);
});

test('an agent waiting for a slot can be stopped: it ends as stopped, never started, and the run goes on', { timeout: 20_000 }, async () => {
  const { feed, conversation, request } = await nestedProject();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let plannerTurns = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const role = who(messages);
      if (role === 'planner') { plannerTurns += 1; await held; yield reply('planner report'); return; }
      const results = messages.filter((message) => message.role === 'tool').length;
      yield results ? reply('done') : reply(null, [call('p1', 'Agent', { subagent_type: 'gsd-planner', description: 'First', prompt: 'one' }), call('p2', 'Agent', { subagent_type: 'gsd-planner', description: 'Second', prompt: 'two' })]);
    },
    async actualCostsUsd() { return undefined; }
  };
  const running = conversation.send(request(client, { maxParallelAgents: 1 }));
  let queued: AgentStats | undefined;
  for (let attempt = 0; attempt < 400 && !queued; attempt += 1) { queued = feed.agentStats().find((stat) => stat.phase === 'queued' && stat.status === 'running'); if (!queued) await new Promise((resolve) => setTimeout(resolve, 5)); }
  try {
    assert.ok(queued, 'one planner waits for the only slot');
    assert.equal(conversation.controlAgent(queued.agentId, 'stop'), true, 'Stop reaches an agent that is still queued');
  } finally {
    release?.();
    await running.catch(() => undefined);
    conversation.dispose();
  }
  const stopped = feed.agentStat(queued!.agentId)!;
  assert.deepEqual([stopped.status, stopped.neverStarted], ['cancelled', true]);
  assert.equal(plannerTurns, 1, 'the stopped one never ran');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { tidyTree } from '../agent/teamLiveLayout';
import { agentState, buildTeamLive, combinedState, edgeState, LiveAgentStat, LiveState, STATE_WORD, teamLiveEvents, toolIcon } from '../agent/teamLiveState';
import { parseTeam } from '../agent/teams';

// 0.4.28 (Team Live): the layout and the state machine behind the live team view. The page draws what these return; animations are decoration on top and
// never a source of state.

// ---------- layout ----------

const overlaps = (places: Array<{ x: number; depth: number }>) => places.some((a, i) => places.some((b, j) => i < j && a.depth === b.depth && Math.abs(a.x - b.x) < 1));

test('tidy tree: every item placed once, no two cards overlap, parents centred over their children, the same input gives the same layout', () => {
  const items = [{ id: 'lead' }, { id: 'a', parent: 'lead' }, { id: 'b', parent: 'lead' }, { id: 'c', parent: 'a' }, { id: 'd', parent: 'a' }, { id: 'e', parent: 'a' }, { id: 'f', parent: 'b' }, { id: 'g', parent: 'f' }];
  const layout = tidyTree(items);
  assert.deepEqual(layout.places.map((place) => place.id), items.map((item) => item.id));
  assert.equal(overlaps(layout.places), false);
  const at = (id: string) => layout.places.find((place) => place.id === id)!;
  assert.equal(at('a').x, (at('c').x + at('e').x) / 2, 'a parent sits over the middle of its children');
  assert.equal(at('lead').x, (at('a').x + at('b').x) / 2);
  assert.deepEqual([at('lead').depth, at('a').depth, at('c').depth, at('g').depth], [0, 1, 2, 3]);
  assert.deepEqual([layout.width, layout.rows], [4, 4]);
  assert.deepEqual(layout.order.map((entry) => `${entry.id}${entry.depth}`), ['lead0', 'a1', 'c2', 'd2', 'e2', 'b1', 'f2', 'g3'], 'the narrow order is a depth-first walk');
  assert.deepEqual(tidyTree(items), layout, 'deterministic');
});

test('tidy tree: an unknown parent, a self-parent, a loop and a duplicate never drop or repeat an item and never hang', () => {
  const layout = tidyTree([{ id: 'lead' }, { id: 'x', parent: 'nobody' }, { id: 'y', parent: 'y' }, { id: 'p', parent: 'q' }, { id: 'q', parent: 'p' }, { id: 'lead', parent: 'x' }]);
  assert.deepEqual(layout.places.map((place) => place.id).sort(), ['lead', 'p', 'q', 'x', 'y']);
  assert.equal(new Set(layout.order.map((entry) => entry.id)).size, layout.order.length);
  assert.equal(layout.order.length, 5);
  assert.equal(overlaps(layout.places), false);
  assert.deepEqual(tidyTree([]), { places: [], width: 0, rows: 0, order: [] });
});

// ---------- states ----------

const TEAM = parseTeam(`---
name: Research
description: Finds and writes
---

## researcher
role: researcher
tools: Read, WebSearch

Search the web. Report each finding with its URL.

## writer
role: writer
reports-to: researcher
tools: Read, Write

Write the brief. Report where it is.

## reviewer
role: reviewer

Check the brief. Report problems.
`, 'research.md');

let clock = 1_000;
function stat(agentId: string, agent: string, extra: Partial<LiveAgentStat> = {}): LiveAgentStat {
  clock += 10;
  return { agentId, agent, runId: 'run-1', model: 'z-ai/glm-5.3', status: 'running', phase: 'thinking', startedAt: clock, turns: 1, toolCalls: 2, costUsd: 0.001, boundary: 'tee', parentId: agentId.startsWith('main-') ? undefined : 'main-run-1', ...extra };
}
const lead = (extra: Partial<LiveAgentStat> = {}) => stat('main-run-1', 'team:research', { team: 'research', ...extra });

test('agent states: each status and phase has one state, and a stopped run leaves nothing working', () => {
  const cases: Array<[Partial<LiveAgentStat>, LiveState]> = [
    [{ phase: 'queued' }, 'queued'], [{ phase: 'starting' }, 'working'], [{ phase: 'tool', tool: 'Bash' }, 'working'], [{ phase: 'generating' }, 'working'],
    [{ phase: 'waiting-you' }, 'needs-you'], [{ phase: 'waiting-agents' }, 'waiting-agents'], [{ phase: 'paused' }, 'paused'], [{ phase: 'cooling-down' }, 'retrying'],
    [{ status: 'completed' }, 'done'], [{ status: 'failed' }, 'failed'], [{ status: 'cancelled' }, 'stopped'], [{ status: 'stuck' }, 'stopped'], [{ status: 'max-turns' }, 'stopped'],
    [{ interrupted: true }, 'interrupted']
  ];
  for (const [extra, state] of cases) assert.equal(agentState(stat('a-abc123', 'a', extra)), state, JSON.stringify(extra));
  // The run ended: queued and running agents show as stopped; finished ones keep their state; an interrupted one is never working.
  assert.equal(agentState(stat('a-abc123', 'a', { phase: 'queued' }), true), 'stopped');
  assert.equal(agentState(stat('a-abc123', 'a', { phase: 'tool' }), true), 'stopped');
  assert.equal(agentState(stat('a-abc123', 'a', { status: 'completed' }), true), 'done');
  assert.equal(agentState(stat('a-abc123', 'a', { interrupted: true, phase: 'tool' })), 'interrupted');
  for (const state of Object.keys(STATE_WORD)) assert.ok(STATE_WORD[state as LiveState], `${state} has a word`);
});

test('a card for several agents: needs you wins, then failed, then working; none at all is on the bench', () => {
  assert.equal(combinedState(['done', 'working', 'needs-you', 'failed']), 'needs-you');
  assert.equal(combinedState(['done', 'working', 'failed']), 'failed');
  assert.equal(combinedState(['done', 'queued', 'working']), 'working');
  assert.equal(combinedState(['done', 'queued']), 'queued');
  assert.equal(combinedState(['done', 'stopped']), 'stopped');
  assert.equal(combinedState([]), 'bench');
});

test('edges: faint on the bench, armed while queued, lit while working, drawn once finished', () => {
  assert.deepEqual((['bench', 'queued', 'working', 'needs-you', 'paused', 'done', 'failed', 'stopped', 'interrupted'] as LiveState[]).map(edgeState), ['faint', 'armed', 'lit', 'lit', 'lit', 'drawn', 'drawn', 'drawn', 'drawn']);
});

test('the view: lead on top, members by reports-to, members not asked dimmed, helpers under the card that started them, repeats as one card', () => {
  const stats = [
    lead({ phase: 'waiting-agents' }),
    stat('researcher-aaa111', 'researcher', { phase: 'tool', tool: 'WebSearch', task: 'Find sources', member: true }),
    stat('researcher-aaa222', 'researcher', { status: 'completed', task: 'Find more', member: true, endedAt: 5_000 }),
    stat('researcher-aaa333', 'researcher', { phase: 'waiting-you', waitingKind: 'approval', member: true }),
    // The lead asked the writer itself, although the writer reports to the researcher.
    stat('writer-bbb111', 'writer', { phase: 'queued', task: 'Draft the brief', member: true }),
    stat('general-purpose-ccc111', 'general-purpose', { parentId: 'researcher-aaa111', task: 'Check a quote', phase: 'generating' }),
    stat('gsd-verifier-ddd111', 'gsd-verifier', { parentId: 'researcher-aaa111', status: 'completed' }),
    stat('gsd-verifier-ddd222', 'gsd-verifier', { parentId: 'researcher-aaa111', phase: 'tool', tool: 'Read' }),
    stat('main-run-2', 'agent', { runId: 'run-2' })
  ];
  const view = buildTeamLive({ runId: 'run-1', stats, team: TEAM });
  const node = (id: string) => view.nodes.find((candidate) => candidate.id === id)!;
  assert.deepEqual(view.nodes.map((candidate) => candidate.id), ['lead', 'm:researcher', 'm:writer', 'm:reviewer', 'g:general-purpose-ccc111', 'g:m:researcher>gsd-verifier']);
  assert.equal(node('lead').name, 'Research');
  assert.equal(node('lead').activity, 'Waiting for 3 helpers', 'the agents it started itself and that still run');
  // The researcher ran three times: one card, the person first.
  assert.deepEqual([node('m:researcher').state, node('m:researcher').word, node('m:researcher').count, node('m:researcher').tally], ['needs-you', 'Needs you: an approval', 3, '3 tasks: 1 working, 1 done, 1 needs you']);
  assert.equal(node('m:researcher').agentId, 'researcher-aaa333', 'the controls act on the one that needs you');
  assert.equal(node('m:researcher').activity, 'Answer in chat');
  assert.deepEqual([node('m:writer').parent, node('m:writer').via, node('m:writer').state, node('m:writer').task], ['m:researcher', 'lead', 'queued', 'Draft the brief']);
  assert.deepEqual([node('m:reviewer').state, node('m:reviewer').word, node('m:reviewer').count], ['bench', 'Not asked yet', 0]);
  assert.deepEqual([node('g:general-purpose-ccc111').name, node('g:general-purpose-ccc111').parent], ['Check a quote', 'm:researcher'], 'a general-purpose helper is named by its task');
  assert.deepEqual([node('g:m:researcher>gsd-verifier').count, node('g:m:researcher>gsd-verifier').state, node('g:m:researcher>gsd-verifier').icon], [2, 'working', 'read']);
  assert.deepEqual(view.guests, ['g:general-purpose-ccc111', 'g:m:researcher>gsd-verifier']);
  // The tree holds the lead and members only; helpers follow their starter in the reading order.
  assert.deepEqual(view.tree.places.map((place) => place.id), ['lead', 'm:researcher', 'm:writer', 'm:reviewer']);
  assert.deepEqual(view.order.map((entry) => `${entry.id}@${entry.depth}`), ['lead@0', 'm:researcher@1', 'm:writer@2', 'g:general-purpose-ccc111@2', 'g:m:researcher>gsd-verifier@2', 'm:reviewer@1'], 'helpers come after the members under the same card');
  assert.deepEqual(view.edges.map((edge) => `${edge.from}>${edge.to}:${edge.kind}:${edge.state}`), [
    'lead>m:researcher:org:lit', 'm:researcher>m:writer:org:armed', 'lead>m:writer:live:armed', 'lead>m:reviewer:org:faint',
    'm:researcher>g:general-purpose-ccc111:live:lit', 'm:researcher>g:m:researcher>gsd-verifier:live:lit'
  ]);
  assert.deepEqual([node('m:researcher').privacy, node('m:researcher').model], ['TEE', 'z-ai/glm-5.3']);
  assert.match(view.summary, /^Team Research: 1 needs you, 3 working, 1 queued, 2 done\.$/);
});

test('a run with no team draws the lead and every agent as a helper, labelled by what it is', () => {
  const view = buildTeamLive({ runId: 'run-1', title: '/gsd-execute-phase', stats: [lead({ agent: '/gsd-execute-phase', team: undefined }), stat('gsd-executor-aaa111', 'gsd-executor')] });
  assert.deepEqual(view.nodes.map((node) => [node.id, node.kind, node.name]), [['lead', 'lead', '/gsd-execute-phase'], ['g:lead>gsd-executor', 'guest', 'gsd-executor']]);
  assert.equal(view.team, undefined);
});

test('a stopped run: queued and running agents end as stopped, and the run says it stopped', () => {
  const view = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead({ status: 'cancelled' }), stat('writer-bbb111', 'writer', { phase: 'queued' }), stat('researcher-aaa111', 'researcher', { phase: 'tool' })] });
  assert.deepEqual(view.nodes.filter((node) => node.kind === 'member').map((node) => node.state), ['stopped', 'stopped', 'bench']);
  assert.equal(view.state, 'stopped');
  assert.match(view.summary, /The run is stopped\.$/);
});

test('the lead counts reports read and reports finished but not read yet', () => {
  const view = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead({ reportsDelivered: 1 }), stat('researcher-aaa111', 'researcher', { status: 'completed', background: true }), stat('researcher-aaa222', 'researcher', { status: 'failed', background: true }), stat('researcher-aaa333', 'researcher', { status: 'cancelled', background: true })] });
  const head = view.nodes[0];
  assert.deepEqual([head.reportsIn, head.reportsWaiting], [1, 1], 'a cancelled agent hands back nothing');
});

// ---------- events ----------

test('events: a hand-off when an agent starts, a report when it ends, nothing on first sight, nothing for a cancelled agent', () => {
  const base = [lead()];
  const v0 = buildTeamLive({ runId: 'run-1', team: TEAM, stats: base });
  const queued = stat('writer-bbb111', 'writer', { phase: 'queued', task: 'Draft it' });
  const v1 = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [...base, queued] });
  assert.deepEqual(teamLiveEvents(undefined, v1), [], 'a page that just opened gets no catch-up animation');
  assert.deepEqual(teamLiveEvents(v0, v1), [{ kind: 'announce', text: 'writer is waiting for a free slot to Draft it.' }], 'queued: the line is armed, nothing travels yet');
  const v2 = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [...base, { ...queued, phase: 'starting' }] });
  assert.deepEqual(teamLiveEvents(v1, v2), [{ kind: 'delegate', from: 'lead', to: 'm:writer', agentId: 'writer-bbb111', task: 'Draft it' }, { kind: 'announce', text: 'Research handed writer a task: Draft it.' }]);
  assert.deepEqual(teamLiveEvents(v2, v2), [], 'nothing changed, nothing happens');
  const v3 = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [...base, { ...queued, phase: 'waiting-you', waitingKind: 'question' }] });
  assert.deepEqual(teamLiveEvents(v2, v3), [{ kind: 'announce', text: 'writer needs you: answer in chat.' }]);
  const v4 = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [...base, { ...queued, status: 'completed' }] });
  assert.deepEqual(teamLiveEvents(v3, v4), [{ kind: 'report', from: 'm:writer', to: 'lead', agentId: 'writer-bbb111', ok: true }, { kind: 'announce', text: 'writer is done.' }]);
  // Started and finished between two looks: both hand-offs.
  assert.deepEqual(teamLiveEvents(v0, v4).map((event) => event.kind), ['delegate', 'report', 'announce']);
  // Cancelled: no report travels back.
  const cancelled = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [...base, { ...queued, status: 'cancelled' }] });
  assert.deepEqual(teamLiveEvents(v2, cancelled), [{ kind: 'announce', text: 'writer stopped.' }]);
  // A failure reports back as not done.
  const failed = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [...base, { ...queued, status: 'failed' }] });
  assert.deepEqual(teamLiveEvents(v2, failed)[0], { kind: 'report', from: 'm:writer', to: 'lead', agentId: 'writer-bbb111', ok: false });
  // A member reused gets a new instance and a new hand-off.
  const again = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [...base, { ...queued, status: 'completed' }, stat('writer-bbb222', 'writer', { task: 'Shorten it' })] });
  assert.deepEqual(teamLiveEvents(v4, again).filter((event) => event.kind === 'delegate'), [{ kind: 'delegate', from: 'lead', to: 'm:writer', agentId: 'writer-bbb222', task: 'Shorten it' }]);
  assert.equal(again.nodes.find((node) => node.id === 'm:writer')!.count, 2);
});

test('events: the run ending stops everything once, and a nested hand-off goes from the agent that started it', () => {
  const researcher = stat('researcher-aaa111', 'researcher');
  const v1 = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead(), researcher] });
  const v2 = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead(), researcher, stat('writer-bbb111', 'writer', { parentId: 'researcher-aaa111' })] });
  assert.deepEqual(teamLiveEvents(v1, v2)[0], { kind: 'delegate', from: 'm:researcher', to: 'm:writer', agentId: 'writer-bbb111' });
  const ended = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead({ status: 'cancelled' }), researcher, stat('writer-bbb111', 'writer', { parentId: 'researcher-aaa111' })] });
  const events = teamLiveEvents(v2, ended);
  assert.equal(events.filter((event) => event.kind === 'run-ended').length, 1);
  assert.equal(events.filter((event) => event.kind === 'report').length, 0, 'agents stopped with the run report nothing');
  assert.deepEqual(teamLiveEvents(ended, ended), []);
  // A different run is a fresh picture, not a stream of changes.
  assert.deepEqual(teamLiveEvents(v1, buildTeamLive({ runId: 'run-2', stats: [stat('main-run-2', 'agent', { runId: 'run-2' })] })), []);
});

test('tool icons come from what the tool lets the agent do', () => {
  assert.deepEqual(['Read', 'Edit', 'Bash', 'WebFetch', 'Agent', 'Recall', 'GenerateImage', 'CreatePdf', 'mcp__github__issue', 'Mystery', undefined].map(toolIcon), ['read', 'change', 'run', 'web', 'plan', 'memory', 'media', 'documents', 'connected', 'other', undefined]);
});

test('privacy: a view carries no prompt, system prompt, reply text or tool input or output', () => {
  const view = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead(), stat('writer-bbb111', 'writer', { phase: 'tool', tool: 'Bash', task: 'Draft it' })] });
  const keys = new Set<string>();
  const walk = (value: unknown) => { if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { keys.add(key); walk(inner); } };
  walk(view);
  for (const banned of ['prompt', 'system', 'text', 'input', 'output', 'instructions']) assert.equal(keys.has(banned), false, banned);
});

test('a workflow that works with a team is led by the workflow, with the team\'s members on hand', () => {
  const view = buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead({ agent: '/gsd-execute-phase' }), stat('writer-bbb111', 'writer')] });
  assert.deepEqual([view.nodes[0].name, view.nodes[0].role], ['/gsd-execute-phase', undefined]);
  assert.equal(view.nodes.find((node) => node.id === 'm:writer')!.state, 'working');
  assert.equal(buildTeamLive({ runId: 'run-1', team: TEAM, stats: [lead()] }).nodes[0].name, 'Research');
});

test('the chat\'s team dots are one per running agent, with no made-up dot for the lead (review of PR 72)', () => {
  const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8') as string;
  const pulse = page.slice(page.indexOf('function teamPulse('), page.indexOf('function panelToggle('));
  assert.ok(pulse.length > 0);
  assert.doesNotMatch(pulse, /'lead'/);
  assert.match(pulse, /dots\.append\(\.\.\.agents\.map\(/);
});

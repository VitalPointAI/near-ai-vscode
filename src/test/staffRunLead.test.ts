// 0.4.35 (owner's D-48): the J2 team's run showed "J2 intelligence working" but tasked nobody. Its lead was offered the COP map's tools, which only the
// members granted mcp:cop-map may call, called one, was refused, and went on reading the scenario itself. Tools offered now equal tools allowed (each
// agent is offered exactly what its grants let it call; the call-time gate stays), and a staff lead is told to mark the step and start the members.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { OBSERVATIONS_WATCH } from '../agent/staff/grants';
import { renderJ2Team } from '../agent/staff/j2Template';
import { staffLeadNote } from '../agent/staffLead';
import { GATED_STAFF_SERVER_IDS, staffServerToolsForRun } from '../agent/staffServers';
import { staffTeamInfo, staffTools } from '../agent/staffTools';
import { parseTeam, teamLeadPrompt } from '../agent/teams';
import type { TeamDefinition } from '../agent/teams';
import { offeredTools } from '../agent/tools';
import type { AgentTool, ToolContext } from '../agent/tools';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { STAFF_PRIVATE_MODELS_TEXT } from '../domain/staff/products';
import { ActivityStore } from '../services/activityStore';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { TranscriptStore } from '../services/transcripts';
import { newTestConversation, newTestRun } from './helpers/gatedRuns';
import { callTool, J2_TEAM, staffWorld } from './helpers/staffFixtures';

const GATE_REFUSAL = /is for the team members whose tools line grants it/;

/** What the call-time gate says to a caller: true when it refuses it for who it is (a refusal for the input, or a throw, is not that). */
async function gateRefuses(tool: AgentTool<any>, agentLabel: string | undefined): Promise<boolean> {
  try {
    return GATE_REFUSAL.test(String(await tool.forbidden?.({} as never, { root: '/nowhere', agentLabel } as unknown as ToolContext) ?? ''));
  } catch {
    return false;
  }
}

test('every grant-gated staff server offers a tool exactly to the callers its call-time gate lets through', async () => {
  for (const server of GATED_STAFF_SERVER_IDS) {
    const team = { members: [{ name: 'granted', tools: [`mcp:${server}`, OBSERVATIONS_WATCH] }, { name: 'ungranted', tools: ['Read', 'Write'] }] };
    const info = { slug: 't', section: 'j2' as const, members: ['granted', 'ungranted'], sectionLead: 'granted' };
    const tools = staffServerToolsForRun(team, { host: () => undefined, store: () => undefined, team: info, run: 'run-1' });
    assert.ok(tools.length > 0, `${server} gives the granted member its tools`);
    for (const tool of tools) {
      for (const label of [undefined, 'granted', 'ungranted', 'not-a-member']) {
        const offered = tool.offeredTo?.(label);
        assert.equal(typeof offered, 'boolean', `${tool.name} says whom it is offered to`);
        assert.equal(offered, !(await gateRefuses(tool, label)), `${tool.name} for ${label ?? 'the lead'}: offered must equal allowed`);
      }
      assert.equal(tool.offeredTo!(undefined), false, `${tool.name} is never offered to the run's lead`);
    }
    assert.deepEqual(offeredTools(tools, undefined), [], `the lead is offered none of ${server}`);
    assert.deepEqual(offeredTools(tools, 'ungranted'), [], `a member without the grant is offered none of ${server}`);
  }
});

test('a whole-server observations grant does not offer the watch tools; only their own grant does', () => {
  const team = { members: [{ name: 'reader', tools: ['mcp:observations'] }, { name: 'watcher', tools: ['mcp:observations', OBSERVATIONS_WATCH] }] };
  const info = { slug: 't', section: 'j2' as const, members: ['reader', 'watcher'], sectionLead: 'reader' };
  const tools = staffServerToolsForRun(team, { host: () => undefined, store: () => undefined, team: info, run: 'run-1' });
  const watch = OBSERVATIONS_WATCH.slice(0, -1);
  const reader = offeredTools(tools, 'reader').map((tool) => tool.name);
  const watcher = offeredTools(tools, 'watcher').map((tool) => tool.name);
  assert.ok(reader.some((name) => name.startsWith('mcp__observations__obs_')), reader.join(', '));
  assert.equal(reader.some((name) => name.startsWith(watch)), false, 'the reader is not offered the watch tools it may not call');
  assert.ok(watcher.some((name) => name.startsWith(watch)), watcher.join(', '));
});

test('staff-products: the lead is offered only the tools the host lets it call; the member-only verbs refuse it at call time too', async () => {
  const world = await staffWorld();
  const tools = staffTools({ host: () => world.host, team: J2_TEAM, run: 'run-1' });
  const lead = offeredTools(tools, undefined).map((tool) => tool.name.replace(/^mcp__[a-z-]+__/, ''));
  assert.deepEqual(lead.sort(), ['lint', 'list', 'register_read', 'scan', 'status', 'step', 'wargame_read']);
  assert.equal(offeredTools(tools, 'threat-analyst').length, tools.length, 'a member is offered every staff tool (its tools line narrows it in the run)');
  assert.equal(offeredTools(tools, 'not-a-member').length, lead.length, 'someone off the team gets no more than the lead');
  const memberOnly: Record<string, Record<string, unknown>> = {
    propose: { product: 'threat-assessment', kind: 'estimate' },
    verdict: { product: 'threat-assessment', gate: 'guard', verdict: 'CLEARED', hash: 'a'.repeat(64) },
    submit: { product: 'threat-assessment', decisionFor: 'commander', options: [{ label: 'A', risk: 'Low' }] },
    withdraw: { product: 'threat-assessment', reason: 'superseded' },
    register: { action: 'write', register: 'pir-register', rows: [] },
    // Recording and deriving the wargame are a member's; the lead reads the record with wargame_read (0.4.35 follow-up).
    wargame: { action: 'derive' }
  };
  for (const [verb, args] of Object.entries(memberOnly)) {
    assert.ok(!lead.includes(verb), `${verb} is not offered to the lead`);
    const refused = await callTool(world, J2_TEAM, `mcp__staff-products__${verb}`, args);
    assert.equal(refused.ok, false, verb);
    assert.match(refused.text, /Only a member of this staff team can do that/, verb);
  }
  const leadCalls: Record<string, Record<string, unknown>> = { list: {}, step: { step: 2 }, wargame_read: {}, status: { product: 'threat-assessment' } };
  for (const [verb, args] of Object.entries(leadCalls)) {
    const result = await callTool(world, J2_TEAM, `mcp__staff-products__${verb}`, args);
    assert.doesNotMatch(result.text, /Only a member/, `${verb} works for the lead`);
  }
});

test('a staff lead is told to coordinate, name the integrator, mark the step and start the lanes in one turn; another team is not', () => {
  const team = j2Team('/p');
  const note = staffLeadNote(team);
  assert.ok(note);
  const chief = staffTeamInfo(team)!.sectionLead;
  assert.equal(chief, 'j2-chief');
  assert.match(note, /you are not one of its members\. j2-chief is the section's integrator/);
  assert.match(note, /mcp__staff-products__step/);
  assert.match(note, /in the same turn, start every lane/);
  assert.match(note, /a named person decides/);
  const prompt = teamLeadPrompt(team, 'Produce the estimate', note);
  assert.ok(prompt.indexOf('# Leading a staff section') < prompt.indexOf('Task: Produce the estimate'), 'the note comes before the task');
  assert.equal(staffLeadNote({ ...team, staff: undefined }), undefined);
  assert.equal(teamLeadPrompt({ ...team, staff: undefined }, 'x'), teamLeadPrompt({ ...team, staff: undefined }, 'x', undefined));
});

test('a tool refused at call time returns an error to the model and the run continues', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-refused-'));
  // The real COP map tool as a run gets it, granted to one member: the lead calling it is refused by the call-time gate.
  const team = { members: [{ name: 'watch-officer', tools: ['mcp:cop-map'] }] };
  const info = { slug: 't', section: 'j2' as const, members: ['watch-officer'], sectionLead: 'watch-officer' };
  const gated = staffServerToolsForRun(team, { host: () => undefined, store: () => undefined, team: info, run: 'run-1' }).find((tool) => tool.name === 'mcp__cop-map__layers')!;
  const seen: string[] = [];
  let turn = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      turn += 1;
      if (turn === 1) { yield reply(null, [call('c1', 'mcp__cop-map__layers', {})]); return; }
      seen.push(String(messages.at(-1)?.content));
      yield reply('carried on');
    }
  };
  const run = newTestRun({ client: client as never, model: 'm', tools: [gated], context: { root, readFiles: new Set() } as never, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'deny' }), emit: () => undefined });
  const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
  assert.equal(turn, 2, 'the model got a second turn after the refusal');
  assert.match(seen[0] ?? '', /^Not allowed: .*the run's lead is not one of them/);
  assert.equal(result.outcome, 'completed');
});

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });

/** The J2 team (operational roster) as a run gets it, with privacy lifted only because this test has no private model catalog. */
function j2Team(root: string): TeamDefinition {
  const team = parseTeam(renderJ2Team(defaultStaffSettings()), path.join(root, '.planning', '.near-ai', 'team.md'));
  return { ...team, private: false, members: team.members.map(({ privacy: _privacy, ...member }) => member) };
}

test('a J2 run: the lead is offered only what it may call, an unoffered call is an error it recovers from, and it tasks members', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-j2-lead-'));
  const store = new ActivityStore(root);
  const session = await store.start({ sessionId: 'session-j2-lead-test-01', project: 'demo', runId: 'run-j2-lead-abcdef', conversationId: 'conv-j2-lead', title: 'J2' });
  const conversation = newTestConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const team = j2Team(root);
  const leadOffered: string[] = [];
  const memberOffered = new Map<string, string[]>();
  const leadResults: string[] = [];
  let leadPrompt = '';
  let leadTurn = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[], tools: Array<{ function?: { name?: string } }>): AsyncGenerator<CompletionEvent> {
      const names = tools.map((tool) => tool.function?.name ?? '');
      const member = /^You are ([a-z0-9-]+),/.exec(String(messages[0]?.content))?.[1];
      if (member) { memberOffered.set(member, names); yield reply(`${member} report`); return; }
      const turn = leadTurn++;
      if (turn === 0) {
        leadOffered.push(...names);
        leadPrompt = String(messages.find((message) => message.role === 'user')?.content);
        // The weak lead of the D-48 run: it reaches for the picture itself.
        yield reply(null, [call('l1', 'mcp__cop-map__layers', {})]);
        return;
      }
      if (turn === 1) {
        leadResults.push(String(messages.at(-1)?.content));
        yield reply(null, [
          call('a1', 'Agent', { subagent_type: 'watch-officer', description: 'Baseline', prompt: 'Current situation baseline.', run_in_background: false }),
          call('a2', 'Agent', { subagent_type: 'osint-analyst', description: 'Sweep', prompt: 'First OSINT sweep.', run_in_background: false })
        ]);
        return;
      }
      yield reply('Both lanes reported.');
    },
    async actualCostsUsd() { return undefined; }
  };
  try {
    await conversation.send({ text: '/team:j2 Produce the intelligence estimate for IRON LANTERN', client: client as never, model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', privacy: 'x', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, team, activity: { store, sessionId: session.sessionId }, runId: 'run-j2-lead-abcdef' });
  } finally {
    conversation.dispose();
  }
  // Offered equals allowed for the lead: no grant-gated server tool, no member-only product verb; it keeps Agent and what it may call.
  for (const server of GATED_STAFF_SERVER_IDS) assert.equal(leadOffered.some((name) => name.startsWith(`mcp__${server}__`)), false, `the lead is not offered ${server}`);
  for (const verb of ['propose', 'verdict', 'submit', 'withdraw', 'register']) assert.ok(!leadOffered.includes(`mcp__staff-products__${verb}`), verb);
  for (const name of ['Agent', 'mcp__staff-products__step', 'mcp__staff-products__status']) assert.ok(leadOffered.includes(name), name);
  assert.match(leadPrompt, /# Leading a staff section/);
  // The call it made anyway came back as an error, and the lead went on to task members.
  assert.match(leadResults[0] ?? '', /unknown tool "mcp__cop-map__layers"/);
  assert.deepEqual([...memberOffered.keys()].sort(), ['osint-analyst', 'watch-officer']);
  // Each member is offered exactly the gated tools its own tools line grants.
  const watch = memberOffered.get('watch-officer')!;
  const osint = memberOffered.get('osint-analyst')!;
  assert.ok(watch.includes('mcp__cop-map__layers'), 'the watch officer is granted the COP map');
  assert.ok(!osint.some((name) => name.startsWith('mcp__cop-map__')), 'the OSINT analyst is not');
  assert.ok(watch.some((name) => name.startsWith(OBSERVATIONS_WATCH.slice(0, -1))) && !osint.some((name) => name.startsWith(OBSERVATIONS_WATCH.slice(0, -1))), 'the watch tools only by their own grant');
  const saved = (await store.get(session.sessionId))!;
  assert.equal(saved.agents.deployed, 2, 'two members were tasked');
});

// Coherence review S5: a staff team is marked private, and every private model NEAR AI offers today is from PRC developers. A chat that runs a staff team
// says so once; a chat that runs another team never does. Nothing about where the work is sent changes.
test('S5: a staff team run says once per chat that its private models come from PRC developers and to use fictional or exercise material only', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-j2-notice-'));
  const posts: Array<{ type?: string; text?: string }> = [];
  const conversation = newTestConversation(root, (post: unknown) => { posts.push(post as { type?: string; text?: string }); }, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const client = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> { yield reply('Noted.'); },
    async actualCostsUsd() { return undefined; }
  };
  const send = (team?: TeamDefinition) => conversation.send({ text: 'Status', client: client as never, model: 'm', privacy: 'x', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, ...(team ? { team } : {}) });
  try {
    await send();
    assert.equal(posts.filter((post) => post.type === 'notice' && post.text === STAFF_PRIVATE_MODELS_TEXT).length, 0, 'no staff team, no notice');
    await send(j2Team(root));
    await send(j2Team(root));
  } finally {
    conversation.dispose();
  }
  assert.equal(posts.filter((post) => post.type === 'notice' && post.text === STAFF_PRIVATE_MODELS_TEXT).length, 1, 'said once per chat');
  assert.match(STAFF_PRIVATE_MODELS_TEXT, /People's Republic of China/);
  assert.match(STAFF_PRIVATE_MODELS_TEXT, /only on fictional or exercise material until your organization approves a model for operational work/);
});

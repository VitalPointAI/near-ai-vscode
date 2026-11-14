import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { TeamDefinition, teamLeadPrompt, teamMembersNote } from '../agent/teams';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolDefinition } from '../services/nearAiClient';

// 0.4.21 (owner, 2026-11-14): GSD keeps the project on track, like a project manager, contractor and quality control, and subcontracts the specialist work
// to the team when there is one. Before, a team existed only for the one /team message: a later "make the pictures" in the same conversation, or a GSD
// workflow, never saw the team's designer and sent the work to general-purpose.

const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };

function studioTeam(root: string): TeamDefinition {
  return {
    slug: 'studio', name: 'Studio', description: 'Makes the product', file: path.join(root, 'studio.md'),
    members: [
      { name: 'designer', role: 'designer', tools: ['Read'], instructions: 'Make images, icons and layouts.' },
      { name: 'researcher', role: 'researcher', tools: ['Read'], instructions: 'Research the topic and cite sources.' }
    ]
  };
}

async function gsdHome(): Promise<GsdContext> {
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-team-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const agent = (name: string) => ({ name, description: name, tools: ['Read'], body: `You are ${name} from Open-GSD.`, file: path.join(home, 'agents', `${name}.md`) });
  return { home, skills: [], shellEnv: {}, agents: [agent('gsd-executor'), agent('researcher')] };
}

/** A model that, as the lead, asks for `member` once, and records what each request saw. */
function modelSpawning(member: string) {
  const leads: Array<{ messages: AgentMessage[]; tools: ToolDefinition[] }> = [];
  const spawned: string[] = [];
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[], tools: ToolDefinition[]): AsyncGenerator<CompletionEvent> {
      const system = String(messages[0]?.content ?? '');
      const identity = /You are \S+, the \S+, on the "[^"]+" team\.|You are \S+ from Open-GSD\./.exec(system);
      if (identity) {
        spawned.push(identity[0]);
        yield { type: 'done', message: { role: 'assistant', content: 'made it' }, finishReason: 'stop', usage };
        return;
      }
      leads.push({ messages, tools });
      const last = messages.at(-1);
      if (last?.role === 'user') {
        yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: `a${leads.length}`, type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: member, prompt: 'make a logo' }) } }] }, finishReason: 'tool_calls', usage };
        return;
      }
      yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  return { client, leads, spawned };
}

const subagentHelp = (tools: ToolDefinition[]) => {
  const agent = tools.find((tool) => tool.function.name === 'Agent');
  return String((agent?.function.parameters as { properties: { subagent_type: { description: string } } }).properties.subagent_type.description);
};

test('the team note says GSD runs the project and subcontracts specialist work to the members; the lead is told the same', () => {
  const team = studioTeam('/tmp');
  const note = teamMembersNote(team);
  assert.match(note, /^<team name="Studio">/);
  assert.match(note, /- designer \(designer\): Make images, icons and layouts\./);
  assert.match(note, /Open-GSD runs the project[\s\S]*subcontracts the specialist work to this team/);
  assert.match(note, /instead of an Open-GSD agent or general-purpose/);
  assert.match(note, /Use general-purpose only when neither fits/);
  assert.match(teamLeadPrompt(team, 'x'), /never to general-purpose or an Open-GSD agent while a member fits/);
});

test('a run that works with a team offers its members first, with their roles, and spawns the member, inside a GSD context too', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const gsd = await gsdHome();
  const model = modelSpawning('designer');
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'now make the pictures', client: model.client as never, model: 'm', privacy: 'x', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd, memberTeam: studioTeam(root) });
  } finally { conversation.dispose(); }
  const first = model.leads[0];
  assert.match(String(first.messages.filter((message) => message.role === 'user').at(-1)?.content), /<team name="Studio">[\s\S]*<\/team>\n\nnow make the pictures$/);
  const help = subagentHelp(first.tools);
  assert.match(help, /^Team members \(the specialists[^)]*\): designer \(designer\), researcher \(researcher\)\. Other agents: gsd-executor\. Or general-purpose, only when no team member fits\.$/);
  assert.deepEqual(model.spawned, ['You are designer, the designer, on the "Studio" team.'], 'the designer ran, not general-purpose');
});

test('a team member wins over an Open-GSD agent of the same name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const model = modelSpawning('researcher');
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'find sources', client: model.client as never, model: 'm', privacy: 'x', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd: await gsdHome(), memberTeam: studioTeam(root) });
  } finally { conversation.dispose(); }
  assert.deepEqual(model.spawned, ['You are researcher, the researcher, on the "Studio" team.']);
});

test('a conversation remembers the newest /team it was started with, and a run with no team offers no members', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const model = modelSpawning('designer');
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  const base = { client: model.client as never, model: 'm', privacy: 'x', policy: { mode: 'fully-autonomous' as const, emergencyStop: false }, rules: DEFAULT_RULES };
  try {
    assert.equal(conversation.conversationTeam, undefined);
    await conversation.send({ ...base, text: 'hello', gsd: await gsdHome() });
    assert.equal(conversation.conversationTeam, undefined);
    assert.doesNotMatch(subagentHelp(model.leads[0].tools), /Team members/, 'no team: the list is as before');
    await conversation.send({ ...base, text: '/team:studio make a logo', team: studioTeam(root) });
    assert.equal(conversation.conversationTeam, 'studio');
    await conversation.send({ ...base, text: 'and a banner' });
    assert.equal(conversation.conversationTeam, 'studio', 'a plain message keeps it');
    await conversation.send({ ...base, text: '/team:research-team look into it', team: { ...studioTeam(root), slug: 'research-team', name: 'Research' } });
    assert.equal(conversation.conversationTeam, 'research-team', 'a later /team switches it');
  } finally { conversation.dispose(); }
});

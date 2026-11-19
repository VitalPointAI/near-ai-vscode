// A scripted run of the J5 team (WP-J5): the lead starts both COA cells in one turn and they run at the same time, each writing only its own COA; then
// the red team tries to change a plan file and is refused by the extension, whatever the model asks, and writes its critique. The models are scripts,
// so the test proves the runtime, not a model's good behaviour.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WRITE_LIMITED_STAFF_TOOLS } from '../agent/staffTools';
import { DEFAULT_RULES } from '../agent/permissions';
import { renderJ5Team } from '../agent/staff/j5Plans';
import { parseTeam } from '../agent/teams';
import type { TeamDefinition } from '../agent/teams';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { RED_TEAM_PRODUCT, staffProductPath } from '../domain/staff/writeLimits';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { TranscriptStore } from '../services/transcripts';
import { newTestConversation } from './helpers/gatedRuns';

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });

/** The J5 team as a run gets it, with privacy lifted only because this test has no private model catalog; the write limits do not depend on privacy. */
function j5Team(root: string): TeamDefinition {
  const team = parseTeam(renderJ5Team({ settings: defaultStaffSettings() }), path.join(root, '.planning', '.near-ai', 'team.md'));
  return { ...team, private: false, members: team.members.map(({ privacy: _privacy, ...member }) => member) };
}

test('the lead runs both COA cells at once, each writes only its COA, and the red team cannot write a plan file but can write its critique', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-j5-run-'));
  const posted: Array<Record<string, unknown>> = [];
  const conversation = newTestConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const coaA = staffProductPath('j5', 'coa-a');
  const coaB = staffProductPath('j5', 'coa-b');
  const conops = staffProductPath('j5', 'conops');
  const critique = staffProductPath('j5', RED_TEAM_PRODUCT);
  const counters: Record<string, number> = {};
  let running = 0; let peak = 0;
  const redTeamSaw: string[] = [];
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const system = String(messages[0]?.content);
      const who = /^You are (coa-cell-a|coa-cell-b|red-team),/.exec(system)?.[1] ?? 'lead';
      const turn = counters[who] = (counters[who] ?? -1) + 1;
      if (who === 'lead') {
        if (turn === 0) yield reply(null, [call('a', 'Agent', { subagent_type: 'coa-cell-a', description: 'COA A', prompt: 'Build COA A.' }), call('b', 'Agent', { subagent_type: 'coa-cell-b', description: 'COA B', prompt: 'Build COA B.' })]);
        else if (turn === 1) yield reply(null, [call('r', 'Agent', { subagent_type: 'red-team', description: 'Red team', prompt: 'Critique the COAs.' })]);
        else yield reply('merged');
        return;
      }
      if (who === 'red-team') {
        if (turn > 0) redTeamSaw.push(String(messages.at(-1)?.content));
        if (turn === 0) yield reply(null, [call('r1', 'Write', { file_path: conops, content: 'The red team rewrote the plan.' })]);
        else if (turn === 1) yield reply(null, [call('r2', 'Write', { file_path: `${critique}/../coa-a.md`, content: 'Weakened COA A.' })]);
        else if (turn === 2) yield reply(null, [call('r3', 'Write', { file_path: critique, content: '1. high: the assumption on port access has no invalidation trigger.' })]);
        else yield reply('findings written');
        return;
      }
      // A COA cell: write its own COA while the other one runs.
      if (turn === 0) {
        running += 1; peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 60));
        running -= 1;
        yield reply(null, [call(`${who}-w`, 'Write', { file_path: who === 'coa-cell-a' ? coaA : coaB, content: `${who} COA\n` })]);
      } else yield reply(`${who} done`);
    },
    async actualCostsUsd() { return undefined; }
  };
  await conversation.send({
    text: '/team:j5 plan it', client: client as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    team: j5Team(root)
  });
  assert.equal(peak, 2, 'both COA cells ran at the same time');
  assert.equal(await readFile(path.join(root, coaA), 'utf8'), 'coa-cell-a COA\n');
  assert.equal(await readFile(path.join(root, coaB), 'utf8'), 'coa-cell-b COA\n');
  assert.equal(existsSync(path.join(root, conops)), false, 'the red team could not create a plan file');
  assert.equal(await readFile(path.join(root, coaA), 'utf8'), 'coa-cell-a COA\n', 'nor change one through a path that steps out of its file');
  assert.match(redTeamSaw[0] ?? '', /outside what this agent may write.*plan files included/s, 'the refusal says why');
  assert.match(redTeamSaw[1] ?? '', /outside what this agent may write/);
  assert.equal(await readFile(path.join(root, critique), 'utf8'), '1. high: the assumption on port access has no invalidation trigger.');
  assert.ok(counters['red-team'] >= 3, 'the red team ran to the end');
});

test('a red team given a shell, Edit and document tools by a hand edit still gets only tools that respect its write limit', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-j5-run-'));
  const conversation = newTestConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const team = j5Team(root);
  const widened = { ...team, members: team.members.map((member) => (member.name === 'red-team' ? { ...member, tools: [...member.tools, 'Bash', 'Edit', 'CreateDocument', 'RenderSvg', 'Agent'] } : member)) };
  const offered: string[] = [];
  let lead = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[], tools: Array<{ function?: { name?: string }; name?: string }>): AsyncGenerator<CompletionEvent> {
      if (String(messages[0]?.content).startsWith('You are red-team,')) {
        offered.push(...tools.map((tool) => tool.function?.name ?? tool.name ?? ''));
        yield reply('no change made');
        return;
      }
      yield lead++ === 0 ? reply(null, [call('r', 'Agent', { subagent_type: 'red-team', description: 'Red team', prompt: 'Critique.' })]) : reply('done');
    },
    async actualCostsUsd() { return undefined; }
  };
  await conversation.send({ text: 'go', client: client as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, team: widened });
  assert.ok(offered.includes('Write') && offered.includes('Edit') && offered.includes('Read'), offered.join(', '));
  for (const name of ['Bash', 'CreateDocument', 'RenderSvg', 'Agent', 'Task']) assert.ok(!offered.includes(name), `${name} is withheld`);
  // The staff tools it is granted stay: they write only the ledger and headers through the host, which refuses any product outside its limit.
  assert.ok(offered.includes('mcp__staff-products__propose') && offered.includes('mcp__staff-products__status'), offered.join(', '));
  for (const name of offered.filter((tool) => tool.startsWith('mcp__'))) assert.ok(WRITE_LIMITED_STAFF_TOOLS.has(name), `${name} is one the write limit allows`);
  assert.ok(!offered.includes('mcp__staff-products__submit') && !offered.includes('mcp__intel-workbench__source_add'));
});

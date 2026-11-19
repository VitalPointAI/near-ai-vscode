// A scripted run of the J4 team (WP-J4): in mission analysis the lead starts all seven functional planners in one turn and they run at the same time,
// each writing only its own product; and the LOGSTAT analyst is offered no tool that writes a file, so it can never fix a report. The models are
// scripts, so the test proves the runtime and the template's grants, not a model's good behaviour. (staffJ4.test.ts proves the release guard cannot clear
// an untraced number.)
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { j4ProductsOwnedBy } from '../agent/staff/j4Products';
import { renderJ4Team } from '../agent/staff/j4Template';
import { j4Vocabulary } from '../agent/staff/j4Vocabulary';
import { parseTeam } from '../agent/teams';
import type { TeamDefinition } from '../agent/teams';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { staffProductPath } from '../domain/staff/writeLimits';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { TranscriptStore } from '../services/transcripts';
import { newTestConversation } from './helpers/gatedRuns';

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });
const PLANNERS = ['mobility-planner', 'supply-planner', 'maintenance-planner', 'services-mortuary-planner', 'ocs-planner', 'health-services-planner', 'engineer-planner'];

/** The J4 team as a run gets it, with privacy lifted only because this test has no private model catalog. */
function j4Team(root: string): TeamDefinition {
  const team = parseTeam(renderJ4Team(defaultStaffSettings()), path.join(root, '.planning', '.near-ai', 'team.md'));
  return { ...team, private: false, members: team.members.map(({ privacy: _privacy, ...member }) => member) };
}

test('the lead starts the seven functional planners in one turn; they run at once, each writing its own product; the LOGSTAT analyst has no file tool', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-j4-run-'));
  const conversation = newTestConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const v = j4Vocabulary(defaultStaffSettings());
  const fileOf = (member: string) => staffProductPath('j4', j4ProductsOwnedBy(member, v)[0].id);
  const counters: Record<string, number> = {};
  let running = 0; let peak = 0;
  const analystTools: string[] = [];
  const who = new RegExp(`^You are (${[...PLANNERS, 'logstat-analyst'].join('|')}),`);
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[], tools: Array<{ function?: { name?: string }; name?: string }>): AsyncGenerator<CompletionEvent> {
      const member = who.exec(String(messages[0]?.content))?.[1] ?? 'lead';
      const turn = counters[member] = (counters[member] ?? -1) + 1;
      if (member === 'lead') {
        if (turn === 0) yield reply(null, PLANNERS.map((name, index) => call(`p${index}`, 'Agent', { subagent_type: name, description: name, prompt: 'Assess your function for mission analysis.' })));
        else if (turn === 1) yield reply(null, [call('l', 'Agent', { subagent_type: 'logstat-analyst', description: 'Validate', prompt: 'Validate the LOGSTATs.' })]);
        else yield reply('merged');
        return;
      }
      if (member === 'logstat-analyst') {
        analystTools.push(...tools.map((tool) => tool.function?.name ?? tool.name ?? ''));
        yield reply('validated');
        return;
      }
      if (turn === 0) {
        running += 1; peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 60));
        running -= 1;
        yield reply(null, [call(`${member}-w`, 'Write', { file_path: fileOf(member), content: `${member} assessment\n` })]);
      } else yield reply(`${member} done`);
    },
    async actualCostsUsd() { return undefined; }
  };
  await conversation.send({ text: '/team:j4 mission analysis', client: client as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, team: j4Team(root) });
  assert.equal(peak, PLANNERS.length, 'all seven functional planners ran at the same time');
  for (const member of PLANNERS) assert.equal(await readFile(path.join(root, fileOf(member)), 'utf8'), `${member} assessment\n`, `${member} wrote its own product`);
  assert.equal(new Set(PLANNERS.map(fileOf)).size, PLANNERS.length, 'no two planners share a file');
  assert.ok(analystTools.length > 0, 'the analyst ran');
  for (const name of ['Write', 'Edit', 'Bash']) assert.ok(!analystTools.includes(name), `the analyst is offered no ${name}`);
  assert.ok(analystTools.includes('Read'));
});

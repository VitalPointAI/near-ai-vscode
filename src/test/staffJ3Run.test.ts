// The J3 team against the real staff host and team runtime (WP-J3): the watch officer logs only through the register tool and the extension refuses
// every file write it tries, even with Write added by hand; every FRAGO goes draft, guard-checked, awaiting a person, then released by that person and
// never by an agent; and the transition brief a person accepts moves the project into execution, where the J3 keeps the DST and DSM and the sync matrix.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OBSERVATIONS_TOOL_NAMES } from '../agent/observationsTools';
import { DEFAULT_RULES } from '../agent/permissions';
import { renderJ3Team, j3Template } from '../agent/staff/j3Operations';
import { staffTools, WRITE_LIMITED_STAFF_TOOLS } from '../agent/staffTools';
import { parseTeam } from '../agent/teams';
import type { TeamDefinition } from '../agent/teams';
import { HUMAN_ONLY_EVENTS } from '../domain/staff/release';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { staffProductPath } from '../domain/staff/writeLimits';
import type { StaffTeamInfo } from '../staff/staffHost';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { TranscriptStore } from '../services/transcripts';
import { newTestConversation } from './helpers/gatedRuns';
import { callTool, CLEAN_BODY, hashIn, J5_TEAM, staffWorld, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const PROPOSE = 'mcp__staff-products__propose';
const VERDICT = 'mcp__staff-products__verdict';
const SUBMIT = 'mcp__staff-products__submit';
const REGISTER = 'mcp__staff-products__register';

const roster = j3Template({ settings: defaultStaffSettings() }).members.map((member) => member.name);
const J3: StaffTeamInfo = { slug: 'j3-operations', section: 'j3', sectionLead: 'j3-director', members: roster };

/** A J3 product taken to awaiting a person's decision by its owner, the release guard and the integrator. Returns its hash. */
async function toDecision(world: StaffWorld, product: string, kind: string, owner: string, body = CLEAN_BODY): Promise<string> {
  await writeBody(world.root, 'j3', product, body);
  const proposed = await callTool(world, J3, PROPOSE, { product, kind }, owner);
  assert.ok(proposed.ok, proposed.text);
  const hash = hashIn(proposed.text);
  const early = await callTool(world, J3, SUBMIT, { product, decisionFor: 'J-3 director', options: [{ label: 'Issue', risk: 'Low' }] }, 'j3-director');
  assert.match(early.text, /not possible from the product's current state/, 'nothing reaches a person before the guard');
  const cleared = await callTool(world, J3, VERDICT, { product, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard');
  assert.ok(cleared.ok, cleared.text);
  const submitted = await callTool(world, J3, SUBMIT, { product, decisionFor: 'J-3 director', options: [{ label: 'Issue it', risk: 'Moderate' }] }, 'j3-director');
  assert.ok(submitted.ok, submitted.text);
  return hash;
}

async function stateOf(world: StaffWorld, product: string): Promise<string> {
  return (await world.host.snapshot()).registry.find((view) => view.product === product)?.display ?? 'none';
}

test('the watch officer proposes event-log rows and reports a CCIR trigger, but writes no register and registers no product', async () => {
  const world = await staffWorld();
  const ccir = await callTool(world, J3, REGISTER, { action: 'write', register: 'ccir-register', rows: [{ id: 'CCIR-1', type: 'ffir', requirement: 'Bridge 4 is down', decisionPoint: 'DP1', reportTo: 'commander', status: 'active' }] }, 'j3-director');
  assert.ok(ccir.ok, ccir.text);
  const entry = { id: 'E1', time: '2026-11-18T12:05Z', source: 'TF ANVIL', report: 'Bridge 4 reported down', ccir: 'CCIR-1', status: 'escalated' };
  const proposed = await callTool(world, J3, REGISTER, { action: 'propose', register: 'event-log', rows: [entry] }, 'watch-officer');
  assert.ok(proposed.ok, proposed.text);
  assert.match(proposed.text, /proposals\/event-log\//);
  const trigger = await callTool(world, J3, REGISTER, { action: 'trigger', ccir: 'CCIR-1', report: 'Bridge 4 reported down' }, 'watch-officer');
  assert.ok(trigger.ok, trigger.text);
  assert.match(trigger.text, /decision is a person's/);
  const written = await callTool(world, J3, REGISTER, { action: 'write', register: 'event-log', rows: [entry] }, 'watch-officer');
  assert.match(written.text, /watch-officer does not write registers/);
  await writeBody(world.root, 'j3', 'shift-brief', CLEAN_BODY);
  const product = await callTool(world, J3, PROPOSE, { product: 'shift-brief', kind: 'brief' }, 'watch-officer');
  assert.match(product.text, /watch-officer may register only/);
  // The current operations chief owns the event log and merges the row; an escalated row must name what it matched.
  const merged = await callTool(world, J3, REGISTER, { action: 'write', register: 'event-log', rows: [entry] }, 'joc-chief');
  assert.ok(merged.ok, merged.text);
  const bare = await callTool(world, J3, REGISTER, { action: 'write', register: 'event-log', rows: [{ ...entry, id: 'E2', ccir: undefined }] }, 'joc-chief');
  assert.match(bare.text, /names the CCIR or decision point/);
});

test('a FRAGO goes draft, guard-checked, awaiting a person, and only a person approves and releases it', async () => {
  const world = await staffWorld();
  const body = '# FRAGORD 3\n\n1 Situation: no change.\n2 Mission: no change.\n3 Execution: TF ANVIL takes branch B1 at DP1.\n4 Sustainment: no change.\n5 Command and signal: no change.\n\nDECISION FOR: J-3 director. Issue now, or hold for the next update brief.\n';
  const hash = await toDecision(world, 'frago', 'order', 'future-ops-planner', body);
  assert.match(await stateOf(world, 'frago'), /awaiting/i);
  // No staff tool is a decision: the tools a run gets have no approve, reject, release or supersede.
  const names = staffTools({ host: () => world.host, team: J3, run: 'run-1' }).map((tool) => tool.name);
  for (const verb of HUMAN_ONLY_EVENTS) assert.ok(!names.some((name) => name.endsWith(`__${verb}`)), verb);
  const approved = await world.host.decide(world.person('A. Demo', 'J-3 director'), { product: 'frago', action: 'approve', hash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  const released = await world.host.decide(world.person('A. Demo', 'J-3 director'), { product: 'frago', action: 'release', hash });
  assert.ok(released.ok, released.ok ? '' : released.message);
  assert.match(await stateOf(world, 'frago'), /released/i);
  // The next FRAGO starts a new line from the same owner; the released one is kept.
  await writeBody(world.root, 'j3', 'frago', body.replace('FRAGORD 3', 'FRAGORD 4'));
  const next = await callTool(world, J3, PROPOSE, { product: 'frago', kind: 'order' }, 'future-ops-planner');
  assert.ok(next.ok, next.text);
  assert.match(next.text, /version 2/);
  // Nobody else may register a FRAGO the future operations planner owns.
  await writeBody(world.root, 'j3', 'frago', body.replace('FRAGORD 3', 'FRAGORD 5'));
  assert.match((await callTool(world, J3, PROPOSE, { product: 'frago', kind: 'order' }, 'joc-chief')).text, /owned by future-ops-planner/);
});

test('the transition brief a person accepts moves the project into execution: the J3 then keeps the DST and DSM and the sync matrix', async () => {
  const world = await staffWorld();
  const dsm = [{ id: 'DP1', description: 'Commit the reserve', indicator: 'Bridge 4 down', nai: 'NAI 3', recommendedAction: 'Branch B1', decisionMaker: 'commander' }];
  const sync = [{ id: 'S1', row: 'manoeuvre', hHourOffsetMinutes: 60, entry: 'TF ANVIL crosses PL BLUE', section: 'j3' }];
  // In planning the J5 lead-planner writes them; the J3's future operations planner proposes.
  const early = await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: dsm }, 'future-ops-planner');
  assert.match(early.text, /written by lead-planner|Propose your rows/);
  const proposedRows = await callTool(world, J3, REGISTER, { action: 'propose', register: 'dst-dsm', rows: dsm }, 'future-ops-planner');
  assert.ok(proposedRows.ok, proposedRows.text);
  // A person accepts the transition brief: the recorded act that starts execution. An agent cannot.
  const hash = await toDecision(world, 'transition-brief', 'brief', 'future-ops-planner');
  assert.match((await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: dsm }, 'future-ops-planner')).text, /written by lead-planner|Propose your rows/, 'still planning while the brief waits on a person');
  const accepted = await world.host.decide(world.person('A. Demo', 'J-3 director'), { product: 'transition-brief', action: 'approve', hash });
  assert.ok(accepted.ok, accepted.ok ? '' : accepted.message);
  const dst = await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: dsm }, 'future-ops-planner');
  assert.ok(dst.ok, dst.text);
  const matrix = await callTool(world, J3, REGISTER, { action: 'write', register: 'sync-matrix', rows: sync }, 'future-ops-planner');
  assert.ok(matrix.ok, matrix.text);
  assert.ok(existsSync(path.join(world.root, staffProductPath('j3', 'dst-dsm'))), 'the DSM is the J3\'s file');
  // In execution the planners propose instead.
  const j5 = await callTool(world, J5_TEAM, REGISTER, { action: 'write', register: 'sync-matrix', rows: sync }, 'lead-planner');
  assert.match(j5.text, /sync-matrix is written by future-ops-planner\. Propose your rows/);
  // The phase is read from the signed log, so it survives a reload.
  world.reload();
  const again = await callTool(world, J3, REGISTER, { action: 'write', register: 'dst-dsm', rows: [{ ...dsm[0], recommendedAction: 'Branch B2' }] }, 'future-ops-planner');
  assert.ok(again.ok, again.text);
});

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });

/** The J3 team as a run gets it, with privacy lifted only because this test has no private model catalog; the write limits do not depend on privacy. */
function j3Team(root: string): TeamDefinition {
  const team = parseTeam(renderJ3Team({ settings: defaultStaffSettings() }), path.join(root, '.planning', '.near-ai', 'team.md'));
  return { ...team, private: false, members: team.members.map(({ privacy: _privacy, ...member }) => member) };
}

test('a watch officer given Write, Edit and a shell by a hand edit still writes no file, and keeps the register tool', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-j3-run-'));
  const conversation = newTestConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const team = j3Team(root);
  const widened = { ...team, members: team.members.map((member) => (member.name === 'watch-officer' ? { ...member, tools: [...member.tools, 'Write', 'Edit', 'Bash', 'mcp__orders__*'] } : member)) };
  const log = staffProductPath('j3', 'event-log');
  const offered: string[] = [];
  const saw: string[] = [];
  let watchTurn = 0;
  let lead = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[], tools: Array<{ function?: { name?: string }; name?: string }>): AsyncGenerator<CompletionEvent> {
      if (String(messages[0]?.content).startsWith('You are watch-officer,')) {
        if (watchTurn === 0) offered.push(...tools.map((tool) => tool.function?.name ?? tool.name ?? ''));
        if (watchTurn > 0) saw.push(String(messages.at(-1)?.content));
        const turn = watchTurn++;
        if (turn === 0) yield reply(null, [call('w1', 'Write', { file_path: log, content: 'E1 Bridge 4 down, which means the enemy is attacking.' })]);
        else if (turn === 1) yield reply(null, [call('w2', 'Write', { file_path: 'notes.md', content: 'my own notes' })]);
        else yield reply('logged through the register tool instead');
        return;
      }
      yield lead++ === 0 ? reply(null, [call('a', 'Agent', { subagent_type: 'watch-officer', description: 'Watch', prompt: 'Log the report.' })]) : reply('done');
    },
    async actualCostsUsd() { return undefined; }
  };
  await conversation.send({ text: 'go', client: client as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, team: widened });
  assert.equal(existsSync(path.join(root, log)), false, 'the event log is not written by the watch');
  assert.equal(existsSync(path.join(root, 'notes.md')), false, 'nor any other file');
  assert.match(saw[0] ?? '', /outside what this agent may write/);
  assert.match(saw[1] ?? '', /outside what this agent may write/);
  for (const name of ['Bash', 'mcp__orders__*']) assert.ok(!offered.includes(name), `${name} is withheld`);
  assert.ok(offered.includes('mcp__staff-products__register'), offered.join(', '));
  // Besides the staff tools the write limit allows, it keeps the observations server, which only reads: it watches the feeds with it.
  assert.ok(offered.includes('mcp__observations__obs_changes'), offered.join(', '));
  for (const name of offered.filter((tool) => tool.startsWith('mcp__'))) assert.ok(WRITE_LIMITED_STAFF_TOOLS.has(name) || OBSERVATIONS_TOOL_NAMES.includes(name), `${name} is one the write limit allows`);
});

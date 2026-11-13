import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GRAPHICS_TOOLS } from '../agent/graphicsTools';
import { applyProjectType, PROJECT_TYPES, projectType, projectTypeTeam, RED_TEAM_POLICY, RED_TEAM_WORKFLOW_STEP, redTeamEnabled, withProjectGuidance } from '../agent/projectTypes';
import { teamAgents } from '../agent/teams';
import { DEFAULT_RULES } from '../agent/permissions';
import { AgentConversation } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { projectInstructions } from '../agent/systemPrompt';
import { parseTeam } from '../agent/teams';
import { CORE_TOOLS } from '../agent/tools';
import { checkCitationsTool, checkOriginalityTool, webFetchTool, webSearchTool } from '../agent/webTools';

// Project types tailor the team and the guidance every agent reads, on the same GSD cycle.

const KNOWN_TOOLS = new Set([...CORE_TOOLS, ...GRAPHICS_TOOLS, webFetchTool, webSearchTool(undefined), checkCitationsTool, checkOriginalityTool].map((tool) => tool.name).concat('Remember', 'Recall', 'SecurityScan'));

test('every project type gives a valid team whose members only use tools that exist', () => {
  for (const type of PROJECT_TYPES) {
    const team = parseTeam(projectTypeTeam(type, 'Ship the thing', 'cloud'), '/p/.planning/.near-ai/team.md');
    assert.equal(team.members.length, type.members.length, type.id);
    for (const member of team.members) {
      for (const tool of member.tools) assert.ok(KNOWN_TOOLS.has(tool), `${type.id}/${member.name} uses unknown tool ${tool}`);
      assert.match(member.instructions, /Project goal: Ship the thing$/);
    }
    for (const stage of ['Plan', 'Execute', 'Verify', 'Audit', 'Release']) assert.match(type.guidance, new RegExp(stage), `${type.id} guidance covers ${stage}`);
  }
  const research = parseTeam(projectTypeTeam(projectType('research')!, 'g', 'cloud'), '/t.md');
  assert.ok(research.members.find((member) => member.name === 'source-verifier')!.tools.includes('CheckCitations'));
  assert.match(projectType('research')!.guidance, /NATO Admiralty/);
  assert.match(projectType('presales')!.guidance, /Never invent a part number, price, or availability/);
  const local = parseTeam(projectTypeTeam(projectType('research')!, 'g', 'local'), '/t.md');
  assert.ok(local.members.every((member) => !member.tools.some((tool) => ['WebSearch', 'WebFetch', 'CheckCitations'].includes(tool))), 'a local-only project keeps members off the web');
});

test('the type\'s guidance goes between markers in AGENTS.md, keeps the user\'s own text, and replaces itself when re-applied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-type-'));
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), '# Our rules\n\nUse tabs.\n');
  await applyProjectType(root, projectType('software')!, 'Build the API');
  await applyProjectType(root, projectType('research')!, 'Assess the market');
  const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Our rules\n\nUse tabs\.\n\n<!-- near-ai:project-type:start -->\n## Project type: Research and analysis\n\nGoal: Assess the market/);
  assert.equal(agents.match(/near-ai:project-type:start/g)?.length, 1, 'one block, replaced rather than appended');
  assert.doesNotMatch(agents, /software project/);
  assert.equal(JSON.parse(await readFile(path.join(root, '.planning', '.near-ai', 'project.json'), 'utf8')).type, 'research');
  assert.match(projectInstructions(root), /## From AGENTS\.md[\s\S]*Project type: Research and analysis/, 'every agent receives it');
  assert.match(withProjectGuidance('', projectType('general')!, 'x'), /^# Agent instructions\n\n<!-- near-ai:project-type:start -->/);
});

test('every type has a red-team stage before verification, and its findings must all get a disposition', async () => {
  for (const type of PROJECT_TYPES) {
    const member = type.members.find((entry) => entry.name === 'red-team');
    assert.ok(member, `${type.id} has a red-team member`);
    assert.match(member!.instructions, /RED-TEAM\.md in the phase folder[\s\S]*Do not fix anything yourself/);
    assert.ok(type.guidance.indexOf('**Red team:**') < type.guidance.indexOf('**Verify:**'), `${type.id}: red team comes before verify`);
  }
  assert.match(RED_TEAM_POLICY, /fixed[\s\S]*accepted risk[\s\S]*deferred[\s\S]*disregarded[\s\S]*"Red team items not fixed"/);
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-redteam-'));
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  assert.equal(await redTeamEnabled(root), false);
  await applyProjectType(root, projectType('data')!, 'Explain churn');
  assert.equal(await redTeamEnabled(root), true);
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /## Red team\nBefore a phase is verified/);
});

test('a GSD workflow in a red-team project gets the stage and can spawn the red-team member by name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-redteam-run-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-redteam-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const team = parseTeam(projectTypeTeam(projectType('software')!, 'Build it', 'cloud'), path.join(root, 'team.md'));
  const redTeam = teamAgents(team).filter((agent) => agent.name === 'red-team');
  const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  let parentPrompt = '';
  let childSystem = '';
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      if (String(messages[0].content).startsWith('You are red-team')) { childSystem = String(messages[0].content); yield { type: 'done', message: { role: 'assistant', content: '3 findings; RED-TEAM.md written' }, finishReason: 'stop', usage }; return; }
      parentPrompt = String(messages.find((message) => message.role === 'user')?.content);
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('r1', 'Agent', { subagent_type: 'red-team', prompt: 'Attack phase 1.' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'verified' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: '/gsd-execute-phase 1', skill: { name: 'gsd-execute-phase', args: '1' }, gsd: { home, skills: [{ name: 'gsd-execute-phase', description: 'Execute', allowedTools: [], body: 'Execute the phase, then verify it.', file: path.join(home, 'SKILL.md'), includes: [] }], agents: [], shellEnv: {} }, skillAddendum: RED_TEAM_WORKFLOW_STEP, projectAgents: redTeam, client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });
  } finally {
    conversation.dispose();
  }
  assert.match(parentPrompt, /Execute the phase, then verify it\.\n\n## Project policy: red team before verification/);
  assert.equal(posted.find((message) => message.type === 'tool-end' && message.callId === 'r1')?.output, '3 findings; RED-TEAM.md written');
  assert.match(childSystem, /Attack the change like an adversary/);
});

test('the software team has a devops member who sets up the protected workflow and never handles secrets or bypasses a gate', () => {
  const software = projectType('software')!;
  const devops = software.members.find((member) => member.name === 'devops');
  assert.ok(devops, 'software has a devops member');
  for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'SecurityScan']) assert.ok(devops!.tools!.includes(tool), `devops can use ${tool}`);
  // What it sets up: CI on every pull request, a protected default branch with required checks, and gated releases.
  assert.match(devops!.instructions, /CI workflow[\s\S]*secret scan[\s\S]*dependency audit/);
  assert.match(devops!.instructions, /required checks/);
  assert.match(devops!.instructions, /publishing behind a manual approval/);
  // The safety rules: no tokens, no bypass, and settings outside the repository are left for a person to run.
  assert.match(devops!.instructions, /Never ask for, print or store a token or key/);
  assert.match(devops!.instructions, /Never weaken, disable or bypass/);
  assert.match(devops!.instructions, /leave them for a person to approve and run/);
  // Every other agent follows the same flow.
  assert.match(software.guidance, /\*\*Workflow:\*\*[^\n]*pull requests[^\n]*protected[^\n]*approval/);
});

// ---- 0.4.18: a research project's team augments Open-GSD's research instead of replacing it (owner, 2026-11-06) -------------------------
// The owner saw research reports take a very long time and suspected the same research was done more than once. It is: /gsd-new-project runs four
// project researchers and /gsd-plan-phase runs one per phase, and the team's own investigator then wrote into the same folder with no named file.
test('the research team writes its own files, so it can never overwrite what Open-GSD owns', () => {
  const members = projectType('research')!.members;
  const investigator = members.find((member) => member.name === 'investigator')!;
  const analyst = members.find((member) => member.name === 'analyst')!;
  assert.match(investigator.instructions, /\.planning\/research\/TEAM-FINDINGS\.md/, 'its own file, not the folder');
  assert.match(analyst.instructions, /\.planning\/research\/TEAM-ANALYSIS\.md/);
  // The files Open-GSD writes are named as never-write, so a member cannot replace one by accident.
  for (const owned of ['STACK.md', 'FEATURES.md', 'ARCHITECTURE.md', 'PITFALLS.md', 'SUMMARY.md']) {
    assert.ok(investigator.instructions.includes(owned), `investigator: ${owned} is named as Open-GSD's`);
  }
  assert.match(investigator.instructions, /never write to a file Open-GSD owns/);
  assert.match(analyst.instructions, /never overwrite a file Open-GSD owns/);
});

test('the research team reads what is already researched and adds only what is missing', () => {
  const investigator = projectType('research')!.members.find((member) => member.name === 'investigator')!;
  // It reads first, does not repeat what is covered, and says what it added.
  assert.match(investigator.instructions, /Read \.planning\/research\/ before you search/);
  assert.match(investigator.instructions, /Do not repeat what those files already establish/);
  assert.match(investigator.instructions, /Add only what is missing, newer, or contradicted/);
  assert.match(investigator.instructions, /say in one line what was already covered and what you are adding/);
});

test('the research project guidance says research comes first and accumulates, and that GSD extends it', () => {
  const guidance = projectType('research')!.guidance;
  assert.match(guidance, /Research comes first/);
  assert.match(guidance, /one accumulating body of work/);
  assert.match(guidance, /TEAM-FINDINGS\.md/);
  assert.match(guidance, /extended, never replaced/);
  assert.match(guidance, /never research the same question twice without saying why/i);
});

test('the research guidance says a cost estimate is computed from the configured prices, never quoted from a file', () => {
  // Owner, 2026-11-06: the deep/balanced/quick estimates shown at research setup were ridiculous, because the team file carried fixed dollars
  // ($15-40, $90-250) that had nothing to do with the models in use. Every research project now inherits this rule.
  const guidance = projectType('research')!.guidance;
  assert.match(guidance, /Cost estimates are computed, never quoted/);
  assert.match(guidance, /prices of the models actually configured/);
  assert.match(guidance, /present a range with the assumptions printed/);
  assert.match(guidance, /Never give a dollar figure that is not derived from the configured prices/);
  assert.match(guidance, /Token counts are estimates/);
});

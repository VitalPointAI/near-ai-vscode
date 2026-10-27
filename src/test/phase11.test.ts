import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAttachments, stageAttachment } from '../agent/attachments';
import { RunCheckpoints } from '../agent/checkpoints';
import { imageTool, memoryPreamble, memoryTools } from '../agent/extraTools';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { newTeamTemplate, parseTeam, recommendedProjectTeam, TeamLibrary } from '../agent/teams';
import { AGENT_MEMORY_ACTOR, AgentConversation } from '../services/agentSession';
import { ContextGraphMemory } from '../services/contextGraphMemory';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { ReputationStore } from '../services/reputation';

const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('team files parse members, roles, models, and tools, and reject unusable files with a fix-it message', () => {
  const team = parseTeam(newTeamTemplate('Release crew'), '/teams/release-crew.md');
  assert.equal(team.name, 'Release crew');
  assert.deepEqual(team.members.map((member) => [member.name, member.role, member.model]), [['planner', 'planner', 'standard'], ['implementer', 'implementer', 'deep'], ['reviewer', 'reviewer', 'standard']]);
  assert.deepEqual(team.members[0].tools, ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall']);
  assert.ok(team.members[1].tools.includes('Edit'), 'members without a tools line get the default set');
  assert.throws(() => parseTeam('---\nname: x\n---\nno members', 'f.md'), /at least one member/);
  assert.throws(() => parseTeam('---\ndescription: d\n---\n## a\nhi', 'f.md'), /needs a name/);
  assert.throws(() => parseTeam('---\nname: x\n---\n## a\nrole: planner\n', 'f.md'), /needs instructions/);
});

test('the team library versions on save, duplicates, archives, restores, imports, and deletes', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-teams-')));
  const file = await library.create('Release crew');
  await writeFile(file, (await readFile(file, 'utf8')).replace('What this team is for', 'Ship releases'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await library.snapshot(file);
  assert.equal((await library.versions(file)).length, 2);
  const copy = await library.duplicate(file, 'Release crew copy');
  assert.equal(parseTeam(await readFile(copy, 'utf8'), copy).description, 'Ship releases');
  await library.archive(copy);
  assert.deepEqual((await library.list()).map((entry) => entry.team?.name), ['Release crew']);
  await library.restore((await library.archived())[0]);
  assert.equal((await library.list()).length, 2);
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'near-ai-import-')), 'shared.md');
  await writeFile(outside, newTeamTemplate('Shared team'));
  const imported = await library.import(outside);
  assert.equal(path.basename(imported), 'shared-team.md');
  await library.delete(imported);
  assert.equal((await library.list()).some((entry) => entry.team?.name === 'Shared team'), false);
});

test('the project-team questionnaire produces a usable team sized to the risk', () => {
  const high = parseTeam(recommendedProjectTeam({ goal: 'Add billing', riskLevel: 'high', preferredProvider: 'near-ai', locality: 'cloud', workShape: 'feature' }), '/p/team.md');
  assert.deepEqual(high.members.map((member) => member.name), ['planner', 'implementer', 'security', 'tester', 'reviewer']);
  assert.ok(high.members.find((member) => member.name === 'security')!.tools.every((tool) => tool !== 'Edit' && tool !== 'Write'), 'review roles cannot edit');
  const research = parseTeam(recommendedProjectTeam({ goal: 'Pick a queue', riskLevel: 'low', preferredProvider: 'near-ai', locality: 'cloud', workShape: 'research' }), '/p/team.md');
  assert.deepEqual(research.members.map((member) => member.name), ['researcher', 'planner', 'reviewer']);
});

test('running a team gives the lead its members as sub-agents with their own tools, and records reputation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-run-'));
  const team = parseTeam(newTeamTemplate('Crew'), path.join(root, 'crew.md'));
  const requests: Array<{ system: string; tools: string[] }> = [];
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[], tools: Array<{ function: { name: string } }>): AsyncGenerator<CompletionEvent> {
      requests.push({ system: messages[0].content ?? '', tools: tools.map((tool) => tool.function.name) });
      const child = String(messages[0].content).startsWith('You are planner');
      const answered = messages.some((message) => message.role === 'tool');
      const message = child ? { role: 'assistant' as const, content: 'Plan: one step.' } : answered ? { role: 'assistant' as const, content: 'The planner proposed one step.' } : { role: 'assistant' as const, content: null, tool_calls: [call('t1', 'Agent', { subagent_type: 'planner', description: 'Plan', prompt: 'Plan the change.' })] };
      yield { type: 'done', message, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const reputation = new ReputationStore(root);
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  await conversation.send({ text: '/team:crew add a flag', team, client: client as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, reputation });
  assert.match(requests[0].system, /You are NEAR AI/);
  assert.ok(requests[0].tools.includes('Agent') && !requests[0].tools.includes('Skill'), 'teams get Agent but not GSD skills');
  const child = requests.find((request) => request.system.startsWith('You are planner'))!;
  assert.deepEqual([...child.tools].sort(), ['Glob', 'Grep', 'Read', 'TodoWrite'], 'planner tools come from its team definition (Recall needs memory, which this run has none of)');
  const evidence = await reputation.list();
  assert.equal(evidence.length, 1);
  assert.deepEqual([evidence[0].role, evidence[0].kind, evidence[0].outcome], ['planner', 'reliability', 'success']);
});

test('attachments: text inlines, images are read by a vision model when the chosen one cannot, audio is transcribed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-attach-'));
  await writeFile(path.join(dir, 'notes.md'), '# Notes\nship friday');
  await writeFile(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(dir, 'memo.wav'), Buffer.from('RIFF'));
  await writeFile(path.join(dir, 'clip.mp4'), Buffer.from('ftyp'));
  await assert.rejects(() => stageAttachment(path.join(dir, 'clip.mp4')), /\.mp4 files are not supported/);
  // PDFs are read now (see documents.test.ts); a damaged one fails clearly instead of passing on nothing.
  await writeFile(path.join(dir, 'spec.pdf'), Buffer.from('%PDF'));
  await assert.rejects(() => stageAttachment(path.join(dir, 'spec.pdf')), /spec\.pdf could not be read as a PDF/);
  const staged = await Promise.all(['notes.md', 'shot.png', 'memo.wav'].map((name) => stageAttachment(path.join(dir, name))));
  const calls: string[] = [];
  const client = {
    async describeImage(model: string, dataUrl: string) { calls.push(`vision:${model}:${dataUrl.slice(0, 22)}`); return { text: 'A login form with a red error.', usage }; },
    async transcribeAudio(model: string, _bytes: Uint8Array, name: string) { calls.push(`audio:${model}:${name}`); return { text: 'Remember to update the changelog.', usage }; }
  };
  const prepared = await prepareAttachments(staged, { client: client as never, model: 'z-ai/glm-5.3', models: [{ id: 'z-ai/glm-5.3', inputModalities: ['text'] }, { id: 'z-ai/glm-5.3-flash', inputModalities: ['text', 'image'] }, { id: 'openai/whisper-large-v3', inputModalities: ['audio'] }] as never, visionModel: 'z-ai/glm-5.3-flash', transcriptionModel: 'openai/whisper-large-v3', question: 'what is wrong?' });
  assert.deepEqual(calls, ['vision:z-ai/glm-5.3-flash:data:image/png;base64,', 'audio:openai/whisper-large-v3:memo.wav']);
  // Each attachment is fenced as outside content, naming the model that read it.
  assert.match(prepared.text, /source="attachment notes\.md \(text file\)">\n# Notes\nship friday/);
  assert.match(prepared.text, /source="attachment shot\.png \(image, described by z-ai\/glm-5\.3-flash\)">\nA login form/);
  assert.match(prepared.text, /source="attachment memo\.wav \(audio, transcribed by openai\/whisper-large-v3\)">\nRemember to update/);
  assert.deepEqual(prepared.notes, ['shot.png was read by z-ai/glm-5.3-flash, because z-ai/glm-5.3 does not read images.', 'memo.wav was transcribed by openai/whisper-large-v3.']);
});

test('GenerateImage saves the PNG in the workspace through a checkpoint, and asks first with the price', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-'));
  const client = { async generateImage(model: string, prompt: string) { return { bytes: new Uint8Array([1, 2, 3]), remoteUrlPresent: false, requestId: `${model}:${prompt}` }; } };
  const tool = imageTool(client as never, { id: 'black-forest-labs/FLUX.2-klein-4B', imagePricePerUnit: 0.012 } as never);
  assert.equal(tool.capability, 'mediaGeneration');
  const input = tool.parse({ prompt: 'a lighthouse icon', path: 'assets/icon.png' });
  const preview = await tool.preview!(input, {} as never);
  assert.match(preview.kind === 'note' ? preview.text : '', /about \$0\.012.*assets\/icon\.png/s);
  const checkpoints = new RunCheckpoints('img');
  const shell = new ShellSession(root);
  try {
    await tool.run(input, { root, signal: new AbortController().signal, checkpoints, shell, readFiles: new Set() });
    assert.deepEqual([...await readFile(path.join(root, 'assets', 'icon.png'))], [1, 2, 3]);
    await checkpoints.revert();
    assert.deepEqual(await readdir(path.join(root, 'assets')), []);
  } finally {
    shell.dispose();
  }
  assert.throws(() => tool.parse({ prompt: 'x', path: 'icon.jpg' }), /must end in \.png/);
});

test('Remember and Recall keep project facts across runs, start later runs with relevant facts, and refuse secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-memory-'));
  const memory = new ContextGraphMemory(root, { trustedActorIds: [AGENT_MEMORY_ACTOR] });
  const project = { kind: 'project' as const, id: 'project-0123456789abcdef0123456789abcdef' };
  const [remember, recall] = memoryTools(memory, { project }, AGENT_MEMORY_ACTOR, 'run-1');
  const signal = new AbortController().signal;
  assert.match(await remember.run(remember.parse({ label: 'Release day', fact: 'Releases ship on Fridays after the changelog is updated.' }), { signal } as never), /Remembered "Release day" in project memory/);
  await remember.run(remember.parse({ label: 'Font', fact: 'The UI uses the editor font.' }), { signal } as never);
  const recalled = await recall.run(recall.parse({ query: 'release' }), { signal } as never);
  assert.match(recalled, /\[project\] Release day: Releases ship on Fridays/);
  assert.doesNotMatch(recalled, /editor font/, 'only matching facts come back');
  assert.match(String(await memoryPreamble(memory, project, 'When do releases ship?')), /Release day: Releases ship on Fridays/);
  assert.doesNotMatch(String(await memoryPreamble(memory, project, 'When do releases ship?')), /editor font/);
  assert.equal(await memoryPreamble(memory, project, 'unrelated question about colours'), undefined);
  await assert.rejects(() => remember.run(remember.parse({ label: 'key', fact: 'api_key=sk-live-123456' }), { signal } as never));
  await assert.rejects(() => memoryTools(new ContextGraphMemory(root), { project }, AGENT_MEMORY_ACTOR, 'run-2')[0].run({ label: 'x', fact: 'y', scope: 'project' }, { signal } as never), /not host-authorized/, 'an unregistered actor cannot write');
});

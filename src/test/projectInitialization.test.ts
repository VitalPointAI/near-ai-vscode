import { mkdtemp, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendAgentTeam } from '../services/agentTeams';
import { initializeProjectTeam, PROJECT_DISCOVERY_QUESTIONS, ProjectInitialization } from '../services/projectInitialization';
const answers = { goal: 'Build a privacy-safe feature', riskLevel: 'high' as const, preferredProvider: 'local-runtime', locality: 'local' as const, workShape: 'feature' as const };
test('initialization requires acceptance and rehydrates accepted team without discovery answers', async () => { const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-team-')); const first = new ProjectInitialization(workspace); const result = await first.initialize(answers); await assert.rejects(() => first.requireAccepted(), /Accept or customize/); const accepted = await first.accept(result.recommendation, answers); const second = new ProjectInitialization(workspace); assert.equal((await second.requireAccepted()).revision, accepted.revision); const serialized = await readFile(path.join(workspace, '.planning', '.near-ai', 'agent-team.json'), 'utf8'); assert.doesNotMatch(serialized, /Build a privacy-safe feature|local-runtime|api-key-value|private prompt/); });
test('customized team is versioned and private answers never enter the artifact', async () => { const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-team-custom-')); const init = new ProjectInitialization(workspace); const recommendation = (await init.initialize(answers)).recommendation; const accepted = await init.customizeAndAccept(recommendation, { remove: ['security'], add: ['researcher'] }, answers); assert.equal(accepted.accepted, true); assert.equal(accepted.roles.some((row) => row.role === 'researcher'), true); const history = await init.history(); assert.equal(history.length, 1); const serialized = await readFile(path.join(workspace, '.planning', '.near-ai', 'agent-team.json'), 'utf8'); assert.doesNotMatch(serialized, /Build a privacy-safe feature|local-runtime/); });

const { locality: _locality, ...guidedAnswers } = answers;

test('D-25: project discovery returns only the four questions about the work', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const expected = ['goal', 'riskLevel', 'preferredProvider', 'workShape'];
  assert.deepEqual(PROJECT_DISCOVERY_QUESTIONS.map(({ id }) => id), expected);
  assert.deepEqual((await initializeProjectTeam(workspace, answers)).questions.map(({ id }) => id), expected);
});

test('D-38: initialization without locality gives the same recommendation as hybrid', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const hybrid = await initializeProjectTeam(workspace, { ...guidedAnswers, locality: 'hybrid' });
  const omitted = await initializeProjectTeam(workspace, guidedAnswers);
  assert.deepEqual(omitted, hybrid);
});

test('D-38: acceptance works with discovery answers that omit locality', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const init = new ProjectInitialization(workspace);
  const { recommendation } = await init.initialize(answers);
  const accepted = await init.accept(recommendation, guidedAnswers);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(await init.requireAccepted(), accepted);
});

test('explicit locality keeps the existing recommendation and invalid values are refused', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const init = new ProjectInitialization(workspace);
  const { recommendation } = await init.initialize(answers);
  assert.deepEqual(recommendation, recommendAgentTeam(answers));
  for (const locality of ['elsewhere', null]) {
    const invalid = { ...answers, locality } as unknown as typeof answers;
    await assert.rejects(init.initialize(invalid), /incomplete or invalid/);
    await assert.rejects(init.accept(recommendation, invalid), /incomplete or invalid/);
  }
});

test('risk level still changes the recommendation with locality omitted', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  for (const riskLevel of ['low', 'medium', 'high'] as const) {
    const input = { ...guidedAnswers, riskLevel };
    const result = await initializeProjectTeam(workspace, input);
    assert.deepEqual(result.recommendation, recommendAgentTeam({ ...input, locality: 'hybrid' }));
    assert.equal(result.recommendation.roles.some(({ role }) => role === 'security'), riskLevel === 'high');
  }
});

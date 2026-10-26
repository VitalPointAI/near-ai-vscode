import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { defaultActionPolicy } from '../domain/policy';
import { AgentProfileStore } from '../services/agentProfiles';
import { AgentOrchestrator } from '../services/agentOrchestrator';
import { PrivacyPreflight } from '../services/privacyPreflight';
import { PolicyGate } from '../services/policyGate';
import { ProjectInitialization } from '../services/projectInitialization';
import { ReputationStore } from '../services/reputation';

const root = () => mkdtemp(path.join(tmpdir(), 'near-ai-orchestrator-'));

test('routes an accepted role to a resurrected profile with an explanation and policy-gated dispatch', async () => {
  const workspace = await root();
  const profiles = new AgentProfileStore(workspace);
  const profile = await profiles.create({ profileId: 'agent-abcdef123456', role: 'implementer', capabilities: ['read', 'plan', 'write'], preferredProvider: 'local-runtime', locality: 'local', preferredModel: 'local-coder' });
  const init = new ProjectInitialization(workspace);
  const recommendation = (await init.initialize({ goal: 'safe change', riskLevel: 'medium', preferredProvider: 'local-runtime', locality: 'local', workShape: 'feature' })).recommendation;
  recommendation.roles = recommendation.roles.filter((role) => role.role === 'implementer').map((role) => ({ ...role, profileId: profile.identity.profileId }));
  await init.accept(recommendation);
  const orchestrator = new AgentOrchestrator(workspace, { profiles, team: init, reputation: new ReputationStore(), policyGate: new PolicyGate(defaultActionPolicy(), new PrivacyPreflight()) });
  const agent = await orchestrator.deploy({ role: 'implementer', task: 'Implement the accepted change', requiredCapabilities: ['write'], providerBoundary: 'local', actionCapability: 'plan', now: '2026-01-01T00:00:00.000Z' });
  assert.equal(agent.profileId, profile.identity.profileId);
  assert.equal(agent.status, 'running');
  assert.equal(agent.explanation.selectedProfileId, profile.identity.profileId);
  assert.match(agent.explanation.reason, /selected|eligible/i);
  assert.equal(JSON.stringify(orchestrator.getEvents()).includes('private prompt'), false);
});

test('lifecycle transitions reject invalid state, enforce limits, and create idempotent evidence', async () => {
  const workspace = await root();
  const profiles = new AgentProfileStore(workspace);
  await profiles.create({ profileId: 'agent-abcdef123456', role: 'tester', capabilities: ['read', 'test'], preferredProvider: 'local', locality: 'local' });
  const reputation = new ReputationStore();
  const orchestrator = new AgentOrchestrator(workspace, { profiles, reputation, limits: { maxConcurrent: 1, maxSpendUsd: 1 } });
  const first = await orchestrator.deploy({ role: 'tester', task: 'Run focused tests', requiredCapabilities: ['test'], estimatedCostUsd: 0.25 });
  await assert.rejects(() => orchestrator.deploy({ role: 'tester', task: 'Second concurrent run', requiredCapabilities: ['test'] }), /concurrency/);
  await orchestrator.transition(first.id, 'paused');
  await assert.rejects(() => orchestrator.transition(first.id, 'completed'), /Invalid agent transition/);
  await orchestrator.resume(first.id);
  await orchestrator.transition(first.id, 'completed', { outcome: 'success', durationMs: 100 });
  await orchestrator.recordOutcome(first, 'success');
  const evidence = await reputation.list();
  assert.equal(evidence.filter((row) => row.kind === 'verifiedOutcome').length, 1);
  assert.equal(orchestrator.snapshot().counts.completed, 1);
});

test('pause/resume/cancel expose safe operational lifecycle and reject forged route bypasses', async () => {
  const workspace = await root();
  const profiles = new AgentProfileStore(workspace);
  await profiles.create({ profileId: 'agent-abcdef123456', role: 'reviewer', capabilities: ['read', 'review'], preferredProvider: 'local', locality: 'local' });
  const orchestrator = new AgentOrchestrator(workspace, { profiles });
  const agent = await orchestrator.deploy({ role: 'reviewer', task: 'Review a diff', requiredCapabilities: ['review'] });
  assert.equal((await orchestrator.pause(agent.id)).status, 'paused');
  assert.equal((await orchestrator.resume(agent.id)).status, 'running');
  assert.equal((await orchestrator.cancel(agent.id)).status, 'cancelled');
  await assert.rejects(() => orchestrator.resume(agent.id), /paused or waiting/);
  await assert.rejects(() => orchestrator.deploy({ role: 'reviewer', task: 'route bypass', requiredCapabilities: ['review'], profileId: 'agent-000000000000' }), /No eligible|selected eligible/);
  assert.equal(JSON.stringify(orchestrator.getEvents()).match(/api[_ -]?key|token|secret|private prompt|command\s*:/i), null);
});

test('restart rehydrates running state as paused and requires a fresh resume transition', async () => {
  const workspace = await root();
  const profiles = new AgentProfileStore(workspace);
  await profiles.create({ profileId: 'agent-abcdef123456', role: 'planner', capabilities: ['read', 'plan'], preferredProvider: 'local', locality: 'local' });
  const first = new AgentOrchestrator(workspace, { profiles });
  const deployed = await first.deploy({ role: 'planner', task: 'Prepare a plan', requiredCapabilities: ['plan'] });
  const second = new AgentOrchestrator(workspace, { profiles });
  await second.rehydrate();
  assert.equal(second.inspect(deployed.id)?.status, 'paused');
  assert.equal((await second.resume(deployed.id)).status, 'running');
});

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AgentProfileStore } from '../services/agentProfiles';
import { ReputationStore } from '../services/reputation';
import { CapabilityRouter } from '../services/capabilityRouter';
import type { ModelInfo } from '../services/nearAiClient';
import { AgentOrchestrator } from '../services/agentOrchestrator';

const root = () => mkdtemp(path.join(tmpdir(), 'near-ai-reputation-'));

test('role-specific evidence is bounded, decays, deduplicates, and survives a fresh store', async () => {
  const workspace = await root();
  const first = new ReputationStore(workspace, { clock: () => '2026-02-01T00:00:00.000Z', config: { halfLifeDays: 10 } });
  const input = { evidenceId: 'outcome-1', profileId: 'agent-abcdef123456', role: 'implementer' as const, kind: 'verifiedOutcome' as const, value: 1, recordedAt: '2026-01-01T00:00:00.000Z', source: 'runtime' as const, outcome: 'success' as const };
  await first.record(input);
  await first.record(input);
  await first.record({ ...input, evidenceId: 'reviewer-1', role: 'reviewer' });
  const score = await first.score(input.profileId, input.role);
  assert.equal(score.evidenceCount, 1);
  assert.ok(score.components.verifiedOutcome < 0.2);
  const second = new ReputationStore(workspace);
  assert.equal((await second.list()).length, 2);
});

test('reputation reset and opt-out are reversible controls', async () => {
  const store = new ReputationStore();
  await store.record({ evidenceId: 'feedback-1', profileId: 'agent-abcdef123456', role: 'reviewer', kind: 'userFeedback', value: -1, recordedAt: '2026-01-01T00:00:00.000Z', source: 'user' });
  await store.setOptOut('agent-abcdef123456', true);
  assert.equal((await store.score('agent-abcdef123456', 'reviewer')).optedOut, true);
  await store.reset('agent-abcdef123456');
  assert.equal((await store.list()).length, 0);
  assert.equal((await store.score('agent-abcdef123456', 'reviewer')).optedOut, false);
});

test('profile routing inputs remain non-sensitive and reputation stays role-specific', async () => {
  const profiles = new AgentProfileStore(await root());
  const profile = await profiles.create({ profileId: 'agent-abcdef123456', role: 'implementer', capabilities: ['read', 'write'], preferredProvider: 'local-runtime', locality: 'local' });
  const store = new ReputationStore();
  await store.record({ evidenceId: 'security-1', profileId: profile.identity.profileId, role: 'security', kind: 'verifiedOutcome', value: 1, recordedAt: '2026-01-01T00:00:00.000Z', source: 'runtime' });
  const implementer = await store.score(profile.identity.profileId, 'implementer');
  assert.equal(implementer.evidenceCount, 0);
  assert.doesNotMatch(JSON.stringify(await store.list()), /secret|token|password|prompt|command|\//i);
});

const capabilityModel = (id: string, features: ModelInfo['supportedFeatures'] = ['analyze'], input: ModelInfo['inputModalities'] = ['image'], output: ModelInfo['outputModalities'] = ['text']): ModelInfo => ({ id, provider: 'near-ai', inputModalities: input, outputModalities: output, supportedFeatures: features, providerOperations: ['image-analysis'], readiness: 'ready', privacyBoundary: 'cloud', locality: 'cloud', inputPricePerMillion: 1, outputPricePerMillion: 2, fetchedAt: '2026-10-26T00:00:00.000Z', capabilitySource: '/models', capabilityMetadataStatus: 'current' });

test('capability compatibility excludes member, modality, locality, privacy, cancellation, publication, and pricing mismatches', async () => {
  const router = new CapabilityRouter({ catalog: [{ ...capabilityModel('image-model'), cancellationSupported: true, publicationSupported: false }], clock: () => '2026-10-26T00:00:00.000Z' });
  const result = await router.evaluate({ provider: 'near-ai', model: 'image-model', locality: 'cloud', privacyBoundary: 'cloud', memberSkills: ['read'] }, { requirementId: 'req-constraints', modality: 'image', skill: 'generate_image', generationOperation: 'image', locality: 'local', privacyBoundary: 'local', requiresCancellation: true, requiresPublication: true });
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.includes('missing-member-skill'));
  assert.ok(result.reasons.includes('unsupported-generation'));
  assert.ok(result.reasons.includes('locality-mismatch'));
  assert.ok(result.reasons.includes('privacy-mismatch'));
  assert.ok(result.reasons.includes('publication-unsupported'));
});

test('an incompatible high-reputation profile is never selected over a compatible lower-scoring profile', async () => {
  const workspace = await root();
  const profiles = new AgentProfileStore(workspace);
  const incompatible = await profiles.create({ profileId: 'agent-aaaaaaaaaaaa', role: 'researcher', capabilities: ['read'], preferredProvider: 'near-ai', locality: 'cloud', preferredModel: 'text-only' });
  const compatible = await profiles.create({ profileId: 'agent-bbbbbbbbbbbb', role: 'researcher', capabilities: ['read'], preferredProvider: 'near-ai', locality: 'cloud', preferredModel: 'image-model' });
  const reputation = new ReputationStore();
  await reputation.record({ evidenceId: 'high-compatible-score', profileId: incompatible.identity.profileId, role: 'researcher', kind: 'verifiedOutcome', value: 1, recordedAt: '2026-10-25T23:00:00.000Z', source: 'runtime' });
  const orchestrator = new AgentOrchestrator(workspace, { profiles, reputation, capabilityRouter: new CapabilityRouter({ catalog: [capabilityModel('text-only', [], ['text'], ['text']), capabilityModel('image-model')], clock: () => '2026-10-26T00:00:00.000Z' }) });
  const route = await orchestrator.route({ role: 'researcher', task: 'Analyze an image', requiredCapabilities: ['read'], capabilityRequirement: { requirementId: 'req-compatible-only', modality: 'image', skill: 'analyze', providerOperation: 'image-analysis', privacyBoundary: 'cloud' }, privacyBoundary: 'cloud', now: '2026-10-26T00:00:00.000Z' });
  assert.equal(route.candidate.profile.identity.profileId, compatible.identity.profileId);
  assert.equal(route.explanation.candidatesConsidered.find((candidate) => candidate.profileId === incompatible.identity.profileId)?.eligible, false);
});

test('compatible lower-scoring profiles remain eligible for deterministic exploration', async () => {
  const workspace = await root();
  const profiles = new AgentProfileStore(workspace);
  await profiles.create({ profileId: 'agent-aaaaaaaaaaaa', role: 'researcher', capabilities: ['read'], preferredProvider: 'near-ai', locality: 'cloud', preferredModel: 'image-a' });
  await profiles.create({ profileId: 'agent-bbbbbbbbbbbb', role: 'researcher', capabilities: ['read'], preferredProvider: 'near-ai', locality: 'cloud', preferredModel: 'image-b' });
  const reputation = new ReputationStore(undefined, { config: { explorationRate: 1 } });
  await reputation.record({ evidenceId: 'higher-score', profileId: 'agent-aaaaaaaaaaaa', role: 'researcher', kind: 'verifiedOutcome', value: 1, recordedAt: '2026-10-26T02:00:00.000Z', source: 'runtime' });
  const router = new CapabilityRouter({ catalog: [capabilityModel('image-a'), capabilityModel('image-b')].map((candidate) => ({ ...candidate, fetchedAt: '2026-10-26T02:00:00.000Z' })), clock: () => '2026-10-26T02:00:00.000Z' });
  const orchestrator = new AgentOrchestrator(workspace, { profiles, reputation, capabilityRouter: router });
  const route = await orchestrator.route({ role: 'researcher', task: 'Explore an image route', requiredCapabilities: ['read'], capabilityRequirement: { requirementId: 'req-exploration', modality: 'image', skill: 'analyze', providerOperation: 'image-analysis', privacyBoundary: 'cloud' }, privacyBoundary: 'cloud', now: '2026-10-26T02:00:00.000Z' });
  assert.equal(route.explanation.exploration.applied, true);
  assert.equal(route.explanation.candidatesConsidered.filter((candidate) => candidate.eligible).length, 2);
});

test('route explanations hold immutable capability snapshots until a fresh route is requested', async () => {
  let rows: ModelInfo[] = [capabilityModel('image-model')];
  const router = new CapabilityRouter({ catalog: () => rows, clock: () => '2026-10-26T00:00:00.000Z' });
  const first = await router.evaluate({ provider: 'near-ai', model: 'image-model', locality: 'cloud' }, { requirementId: 'req-snapshot', modality: 'image', skill: 'analyze', providerOperation: 'image-analysis', privacyBoundary: 'cloud' });
  const firstSnapshotId = first.snapshot?.snapshotId;
  rows = [{ ...capabilityModel('image-model'), outputPricePerMillion: 8 }];
  const second = await router.evaluate({ provider: 'near-ai', model: 'image-model', locality: 'cloud' }, { requirementId: 'req-snapshot', modality: 'image', skill: 'analyze', providerOperation: 'image-analysis', privacyBoundary: 'cloud' });
  assert.notEqual(second.snapshot?.snapshotId, firstSnapshotId);
  assert.equal(first.snapshot?.pricing.outputPricePerMillion, 2);
});

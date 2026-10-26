import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CapabilityRouter } from '../services/capabilityRouter';
import { NearAiClient } from '../services/nearAiClient';
import { AgentProfileStore } from '../services/agentProfiles';
import { AgentOrchestrator } from '../services/agentOrchestrator';
import { ReputationStore } from '../services/reputation';
import { capabilityAwareTeamPreview, parseChatWebviewMessage, teamPreviewMessage } from '../services/chatBridge';
import type { TeamPreview } from '../domain/teamStudio';

const NOW = '2026-10-26T00:00:00.000Z';
const root = () => mkdtemp(path.join(tmpdir(), 'near-ai-capability-'));

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vision-model',
    provider: 'near-ai',
    input_modalities: ['image', 'text'],
    output_modalities: ['text'],
    supported_features: ['analyze'],
    provider_operations: ['image-analysis'],
    readiness: 'ready',
    privacy_boundary: 'cloud',
    verification_status: 'verified',
    pricing: { input_per_million: 1, output_per_million: 2 },
    ...overrides
  };
}

async function router(rows: Record<string, unknown>[]) {
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'redacted', clock: () => NOW, fetchFn: async () => new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  return new CapabilityRouter({ catalog: await client.listModels(), clock: () => NOW });
}

test('model capability metadata and image-analysis route preserve source, freshness, privacy, and pricing facts', async () => {
  const capabilities = await router([model()]);
  const result = await capabilities.evaluate({ provider: 'near-ai', model: 'vision-model', locality: 'cloud', privacyBoundary: 'cloud' }, { requirementId: 'req-image-analysis', modality: 'image', skill: 'analyze', providerOperation: 'image-analysis', privacyBoundary: 'cloud' });
  assert.equal(result.compatible, true);
  assert.equal(result.snapshot?.freshness, 'current');
  assert.equal(result.snapshot?.source, '/models');
  assert.equal(result.snapshot?.privacyBoundary, 'cloud');
  assert.deepEqual(result.snapshot?.inputModalities, ['image', 'text']);
  assert.equal(result.costAvailable, true);
});

test('unknown capability metadata fails closed even when the model name resembles a generator', async () => {
  const capabilities = await router([{ id: 'image-generation-pro', readiness: 'ready', pricing: { input_per_million: 1, output_per_million: 1 } }]);
  const result = await capabilities.evaluate({ provider: 'near-ai', model: 'image-generation-pro', locality: 'cloud' }, { requirementId: 'req-image-generation', modality: 'text', outputModality: 'image', skill: 'generate_image', generationOperation: 'image' });
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.includes('metadata-unknown'));
  assert.ok(result.reasons.includes('unsupported-output-modality'));
  assert.ok(result.reasons.includes('unsupported-generation'));
});

test('malformed forged modality metadata is unavailable rather than coerced into support', async () => {
  const capabilities = await router([model({ input_modalities: 'image', supported_features: ['analyze'], output_modalities: ['text'] })]);
  const result = await capabilities.evaluate({ provider: 'near-ai', model: 'vision-model', locality: 'cloud' }, { requirementId: 'req-forged-image', modality: 'image', skill: 'analyze' });
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.includes('metadata-unknown'));
});

test('unsupported image, video, and audio requirements never fall back to generic chat', async () => {
  const capabilities = await router([model()]);
  for (const requirement of [
    { requirementId: 'req-video', modality: 'video' as const, skill: 'analyze' as const },
    { requirementId: 'req-audio', modality: 'audio' as const, skill: 'transcribe' as const },
    { requirementId: 'req-image-generation', modality: 'text' as const, outputModality: 'image' as const, skill: 'generate_image' as const, generationOperation: 'image' as const }
  ]) {
    const result = await capabilities.evaluate({ provider: 'near-ai', model: 'vision-model', locality: 'cloud' }, requirement);
    assert.equal(result.compatible, false, requirement.requirementId);
    assert.ok(result.reasons.length > 0, requirement.requirementId);
  }
});

test('stale metadata and unavailable pricing produce explicit no-route results', async () => {
  const stale = new CapabilityRouter({ catalog: [{ id: 'vision-model', ...model({ pricing: {} }), fetchedAt: '2025-01-01T00:00:00.000Z', capabilitySource: '/models', capabilityMetadataStatus: 'current', inputModalities: ['image', 'text'], outputModalities: ['text'], supportedFeatures: ['analyze'], providerOperations: ['image-analysis'], readiness: 'ready', provider: 'near-ai', privacyBoundary: 'cloud', locality: 'cloud' }], clock: () => NOW });
  const result = await stale.evaluate({ provider: 'near-ai', model: 'vision-model', locality: 'cloud' }, { requirementId: 'req-stale', modality: 'image', skill: 'analyze' });
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.includes('stale-metadata'));
  assert.ok(result.reasons.includes('unavailable-pricing'));
  const routed = await stale.route([{ provider: 'near-ai', model: 'vision-model', locality: 'cloud' }], { requirementId: 'req-stale-route', modality: 'image', skill: 'analyze' });
  assert.equal(routed.compatibleCandidates.length, 0);
  assert.match(routed.reason, /No candidate/);
});

test('orchestration exposes a capability route explanation and blocks unverified routes before reputation', async () => {
  const workspace = await root();
  const profiles = new AgentProfileStore(workspace);
  const profile = await profiles.create({ profileId: 'agent-aaaaaaaaaaaa', role: 'researcher', capabilities: ['read'], preferredProvider: 'near-ai', locality: 'cloud', preferredModel: 'vision-model' });
  const orchestrator = new AgentOrchestrator(workspace, { profiles, reputation: new ReputationStore(), capabilityRouter: await router([model()]) });
  const route = await orchestrator.route({ role: 'researcher', task: 'Analyze the approved image', requiredCapabilities: ['read'], capabilityRequirement: { requirementId: 'req-route', modality: 'image', skill: 'analyze', providerOperation: 'image-analysis', privacyBoundary: 'cloud' }, privacyBoundary: 'cloud' });
  assert.equal(route.candidate.profile.identity.profileId, profile.identity.profileId);
  assert.equal(route.explanation.capabilityRequirementId, 'req-route');
  assert.equal(route.explanation.capabilityFreshness, 'current');
  assert.equal(route.explanation.candidatesConsidered[0].capability?.status, 'compatible');
});

test('team capability preview shows current model metadata and explicit unavailable states without catalog payloads', async () => {
  const preview: TeamPreview = {
    teamId: 'team-aaaaaaaaaaaa', version: 1, versionId: 'team-aaaaaaaaaaaa-v1', displayName: 'Multimodal Team', members: [{ memberId: 'member-aaaaaaaaaaaa', role: 'researcher', responsibilities: ['Analyze approved inputs.'], skills: ['read'], tools: ['read'], route: { provider: 'near-ai', model: 'vision-model', locality: 'cloud', privacyBoundary: 'cloud' }, personality: { personality: 'professional', tone: 'quiet', style: 'structured' }, autonomy: 'bounded', approval: 'risky', budget: { requestUsd: 1, sessionUsd: 2, projectUsd: 4 } }], privacyBoundary: 'cloud', coordinationTradeoff: 'bounded', estimatedRequestUsd: 1, estimatedProjectUsd: 4, bindingRequired: true
  };
  const current = await capabilityAwareTeamPreview(preview, await router([model()]));
  assert.equal(current.capabilityRoutes[0].status, 'compatible');
  assert.equal(current.capabilityRoutes[0].freshness, 'current');
  assert.equal(JSON.stringify(current).includes('input_modalities'), false);
  const unavailable = await capabilityAwareTeamPreview(preview);
  assert.equal(unavailable.capabilityRoutes[0].status, 'refresh-required');
  assert.deepEqual(unavailable.capabilityRoutes[0].reasons, ['unknown-model']);
  const message = teamPreviewMessage(unavailable);
  assert.equal(message.type, 'team-preview');
  assert.equal(message.preview.capabilityRoutes[0].status, 'refresh-required');
  assert.equal(parseChatWebviewMessage({ type: 'team-preview', teamId: preview.teamId, version: 1, capability: 'cloud' }), undefined);
});

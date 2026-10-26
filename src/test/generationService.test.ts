import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hostAttribution } from '../domain/activity';
import type { ModelInfo } from '../services/nearAiClient';
import { defaultActionPolicy } from '../domain/policy';
import { ApprovalService } from '../services/approvalService';
import { CapabilityRouter } from '../services/capabilityRouter';
import type { GenerationProviderAdapter, GenerationProviderInput, ProviderGenerationResult, ProviderVideoStatus } from '../domain/generation';
import { GenerationError } from '../services/generationService';
import { GenerationService } from '../services/generationService';
import { PolicyGate } from '../services/policyGate';
import { PrivacyPreflight } from '../services/privacyPreflight';

const NOW = '2026-10-26T00:00:00.000Z';
const attribution = hostAttribution('project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Studio', 'profile-company', 'Company');

function imageModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'image-model', provider: 'near-ai', inputModalities: ['text'], outputModalities: ['image'], supportedFeatures: ['generate_image'], providerOperations: ['image-generation'], readiness: 'ready', privacyBoundary: 'cloud', locality: 'cloud', verificationStatus: 'verified', cancellationSupported: true, publicationSupported: true, capabilityMetadataStatus: 'current', fetchedAt: NOW, capabilitySource: '/models', imagePricePerUnit: 0.5, supportsReasoning: false, ...overrides
  };
}

function videoModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'video-model', provider: 'video-provider', inputModalities: ['text'], outputModalities: ['video'], supportedFeatures: ['generate_video'], providerOperations: ['video-generation', 'video-status', 'video-content', 'video-cancel'], readiness: 'ready', privacyBoundary: 'cloud', locality: 'cloud', verificationStatus: 'verified', cancellationSupported: true, publicationSupported: true, capabilityMetadataStatus: 'current', fetchedAt: NOW, capabilitySource: 'official-video-catalog', videoPricePerUnit: 2, supportsReasoning: false, ...overrides
  };
}

function approval(options: { requestLimitUsd?: number } = {}): ApprovalService {
  const privacy = new PrivacyPreflight();
  return new ApprovalService(new PolicyGate(defaultActionPolicy(), privacy), { ...options, requestLimitUsd: options.requestLimitUsd ?? 10, sessionLimitUsd: 10, projectLimitUsd: 10 });
}

function service(models: ModelInfo[], adapters: GenerationProviderAdapter[], options: { requestLimitUsd?: number; privacy?: PrivacyPreflight } = {}): GenerationService {
  return new GenerationService('/tmp/near-ai-generation-test', { router: new CapabilityRouter({ catalog: models, clock: () => NOW }), adapters, approval: approval({ requestLimitUsd: options.requestLimitUsd }), privacy: options.privacy });
}

function imageAdapter(calls: { create: number; edit: number }): GenerationProviderAdapter {
  return {
    provider: 'near-ai', operations: ['image-generation', 'image-edit'], providerOperations: ['image-generation', 'image-edit'],
    createImage: async (_input: GenerationProviderInput): Promise<ProviderGenerationResult> => { calls.create += 1; return { status: 'completed', requestId: 'image-request-1', bytes: new Uint8Array([1, 2, 3]), usage: { requestId: 'image-request-1', units: 1, actualCostUsd: 0.6, verificationStatus: 'verified' } }; },
    editImage: async (_input: GenerationProviderInput): Promise<ProviderGenerationResult> => { calls.edit += 1; return { status: 'completed', requestId: 'edit-request-1', bytes: new Uint8Array([4, 5]), usage: { requestId: 'edit-request-1', units: 1, actualCostUsd: 0.7 } }; }
  };
}

test('approved image generation uses only the advertised adapter and stores redacted attributed output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-generation-'));
  const calls = { create: 0, edit: 0 };
  const generation = new GenerationService(root, { router: new CapabilityRouter({ catalog: [imageModel()], clock: () => NOW }), adapters: [imageAdapter(calls)], approval: approval(), clock: () => Date.parse(NOW) });
  const prepared = await generation.prepare({ operation: 'image-generation', skill: 'generate_image', provider: 'near-ai', model: 'image-model', prompt: 'a secure studio illustration', sessionId: 'session-generation-001', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud', parameters: { size: '1024x1024', count: 1 } });
  assert.equal(prepared.status, 'awaiting-approval');
  assert.equal('prompt' in prepared, false);
  const approved = await generation.approve(prepared.operationId, prepared.approval?.approvalFingerprint ?? '');
  const completed = await generation.run(approved.operationId, approved.approval?.approvalFingerprint);
  assert.equal(completed.status, 'completed');
  assert.equal(calls.create, 1);
  assert.equal(completed.usage?.actualCostUsd, 0.6);
  assert.equal(completed.attribution.projectId, attribution.projectId);
  const artifact = generation.getArtifact(completed.artifactId ?? '');
  assert.equal(artifact?.managedReference.startsWith('generated://'), true);
  assert.equal(artifact?.publication, 'unpublished');
  const ledger = await readFile(path.join(root, '.planning', '.near-ai', 'generation.json'), 'utf8');
  assert.doesNotMatch(ledger, /secure studio illustration|data:|raw media/);
  await stat(path.join(root, '.planning', '.near-ai', 'generated', `${artifact?.artifactId}.bin`));
});

test('forged or unsupported capability metadata fails closed without silent generation fallback', async () => {
  const calls = { create: 0, edit: 0 };
  const adapter = imageAdapter(calls);
  const forged = service([imageModel({ providerOperations: [], capabilityMetadataStatus: 'current' })], [adapter]);
  await assert.rejects(() => forged.prepare({ operation: 'image-generation', skill: 'generate_image', provider: 'near-ai', model: 'image-model', prompt: 'never dispatch', sessionId: 'session-generation-002', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' }), (error: unknown) => error instanceof GenerationError && ['unsupported-provider-operation', 'unsupported-operation'].includes(error.code));
  assert.equal(calls.create, 0);
  const unknown = service([imageModel()], [adapter]);
  await assert.rejects(() => unknown.prepare({ operation: 'image-generation', skill: 'generate_image', provider: 'near-ai', model: 'unknown-model', prompt: 'never dispatch', sessionId: 'session-generation-003', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' }), (error: unknown) => error instanceof GenerationError && error.code === 'unknown-model');
  const noVideo = service([videoModel()], [adapter]);
  await assert.rejects(() => noVideo.prepare({ operation: 'video-generation', skill: 'generate_video', provider: 'video-provider', model: 'video-model', prompt: 'never dispatch', sessionId: 'session-generation-004', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' }), (error: unknown) => error instanceof GenerationError && error.code === 'unsupported-provider-endpoint');
});

test('approval, budget, emergency stop, and cancellation prevent provider work', async () => {
  const calls = { create: 0, edit: 0 };
  const limitedApproval = approval({ requestLimitUsd: 0.1 });
  const budgetRoot = await mkdtemp(path.join(tmpdir(), 'near-ai-generation-budget-'));
  const limited = new GenerationService(budgetRoot, { router: new CapabilityRouter({ catalog: [imageModel()], clock: () => NOW }), adapters: [imageAdapter(calls)], approval: limitedApproval });
  const prepared = await limited.prepare({ operation: 'image-generation', skill: 'generate_image', provider: 'near-ai', model: 'image-model', prompt: 'budgeted', sessionId: 'session-generation-005', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' });
  await limited.approve(prepared.operationId, prepared.approval?.approvalFingerprint ?? '');
  assert.equal((await limited.run(prepared.operationId, prepared.approval?.approvalFingerprint)).status, 'budget-blocked');
  assert.equal(calls.create, 0);

  const stopped = new GenerationService(await mkdtemp(path.join(tmpdir(), 'near-ai-generation-stop-')), { router: new CapabilityRouter({ catalog: [imageModel()], clock: () => NOW }), adapters: [imageAdapter(calls)], approval: approval() });
  const stoppedPrepared = await stopped.prepare({ operation: 'image-generation', skill: 'generate_image', provider: 'near-ai', model: 'image-model', prompt: 'stopped', sessionId: 'session-generation-006', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' });
  await stopped.approve(stoppedPrepared.operationId, stoppedPrepared.approval?.approvalFingerprint ?? '');
  stopped.emergencyStop(attribution.projectId);
  assert.equal((await stopped.run(stoppedPrepared.operationId, stoppedPrepared.approval?.approvalFingerprint)).status, 'failed');
  assert.equal(calls.create, 0);

  const cancelled = new GenerationService(await mkdtemp(path.join(tmpdir(), 'near-ai-generation-cancel-')), { router: new CapabilityRouter({ catalog: [imageModel()], clock: () => NOW }), adapters: [imageAdapter(calls)], approval: approval() });
  const cancelledPrepared = await cancelled.prepare({ operation: 'image-generation', skill: 'generate_image', provider: 'near-ai', model: 'image-model', prompt: 'cancelled', sessionId: 'session-generation-007', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' });
  const controller = new AbortController(); controller.abort();
  assert.equal((await cancelled.run(cancelledPrepared.operationId, cancelledPrepared.approval?.approvalFingerprint, controller.signal)).status, 'cancelled');
  assert.equal(calls.create, 0);
});

test('video requires the complete declared async lifecycle and preserves unknown state safely', async () => {
  let polls = 0; let cancelled = 0;
  const adapter: GenerationProviderAdapter = {
    provider: 'video-provider', operations: ['video-generation'], providerOperations: ['video-generation', 'video-status', 'video-content', 'video-cancel'],
    createImage: async () => ({ status: 'failed' }), editImage: async () => ({ status: 'failed' }),
    createVideo: async () => ({ status: 'queued', providerJobId: 'job-video-1', requestId: 'video-request-1' }),
    pollVideo: async (_job, _signal): Promise<ProviderVideoStatus> => { polls += 1; return polls < 2 ? { status: 'in-progress', providerJobId: 'job-video-1' } : { status: 'completed', providerJobId: 'job-video-1', bytes: new Uint8Array([9]), usage: { providerJobId: 'job-video-1', actualCostUsd: 2.4, units: 2 } }; },
    cancelVideo: async () => { cancelled += 1; }
  };
  const generation = new GenerationService(await mkdtemp(path.join(tmpdir(), 'near-ai-video-')), { router: new CapabilityRouter({ catalog: [videoModel()], clock: () => NOW }), adapters: [adapter], approval: approval(), pollDelayMs: 0 });
  const prepared = await generation.prepare({ operation: 'video-generation', skill: 'generate_video', provider: 'video-provider', model: 'video-model', prompt: 'bounded video', sessionId: 'session-generation-008', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud', parameters: { durationSeconds: 2 } });
  await generation.approve(prepared.operationId, prepared.approval?.approvalFingerprint ?? '');
  const completed = await generation.run(prepared.operationId, prepared.approval?.approvalFingerprint);
  assert.equal(completed.status, 'completed'); assert.equal(polls, 2); assert.equal(completed.usage?.actualCostUsd, 2.4); assert.equal(cancelled, 0);

  const unknownAdapter: GenerationProviderAdapter = { ...adapter, pollVideo: async () => ({ status: 'unknown', providerJobId: 'job-unknown' }) };
  const unknown = new GenerationService(await mkdtemp(path.join(tmpdir(), 'near-ai-video-unknown-')), { router: new CapabilityRouter({ catalog: [videoModel()], clock: () => NOW }), adapters: [unknownAdapter], approval: approval(), pollDelayMs: 0 });
  const unknownPrepared = await unknown.prepare({ operation: 'video-generation', skill: 'generate_video', provider: 'video-provider', model: 'video-model', prompt: 'unknown state', sessionId: 'session-generation-009', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' });
  await unknown.approve(unknownPrepared.operationId, unknownPrepared.approval?.approvalFingerprint ?? '');
  const unknownResult = await unknown.run(unknownPrepared.operationId, unknownPrepared.approval?.approvalFingerprint);
  assert.equal(unknownResult.status, 'failed'); assert.equal(unknownResult.reason, 'unknown-provider-state');
});

test('publication is separate from generation approval and remains contained', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-publication-'));
  const generation = new GenerationService(root, { router: new CapabilityRouter({ catalog: [imageModel()], clock: () => NOW }), adapters: [imageAdapter({ create: 0, edit: 0 })], approval: approval(), clock: () => Date.parse(NOW) });
  const prepared = await generation.prepare({ operation: 'image-generation', skill: 'generate_image', provider: 'near-ai', model: 'image-model', prompt: 'publishable', sessionId: 'session-generation-010', projectId: attribution.projectId, attribution, providerBoundary: 'cloud', privacyBoundary: 'cloud' });
  await generation.approve(prepared.operationId, prepared.approval?.approvalFingerprint ?? '');
  const completed = await generation.run(prepared.operationId, prepared.approval?.approvalFingerprint);
  const preview = await generation.preparePublication({ operationId: completed.operationId, destination: 'published.bin', attribution });
  await assert.rejects(() => generation.publish(preview, '0'.repeat(64)), (error: unknown) => error instanceof GenerationError && error.code === 'approval-mismatch');
  const published = await generation.publish(preview, preview.approval.approvalFingerprint);
  assert.equal(published.publication, 'published');
  await stat(path.join(root, 'published.bin'));
  await assert.rejects(() => generation.preparePublication({ operationId: completed.operationId, destination: '../escape.bin', attribution }), (error: unknown) => error instanceof GenerationError && error.code === 'publication-destination-invalid');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatWebviewMessage, multimodalStatusMessage } from '../services/chatBridge';
import { CapabilityRouter } from '../services/capabilityRouter';
import { selectMultimodalRoute } from '../services/multimodalOrchestrator';
import type { ModelInfo } from '../services/nearAiClient';
import type { MultimodalOperationRecord } from '../domain/multimodal';

const attachmentId = 'attachment-aaaaaaaaaaaaaaaaaaaa';

function currentImageModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'vision-local',
    provider: 'local-runtime',
    inputModalities: ['image'],
    outputModalities: ['text'],
    supportedFeatures: ['analyze'],
    readiness: 'ready',
    privacyBoundary: 'local',
    locality: 'local',
    verificationStatus: 'verified',
    capabilityMetadataStatus: 'current',
    fetchedAt: new Date().toISOString(),
    inputPricePerMillion: 1,
    outputPricePerMillion: 1,
    cancellationSupported: true,
    ...overrides
  };
}

test('multimodal chat protocol accepts only bounded operation and opaque staged IDs', () => {
  const prepare = parseChatWebviewMessage({ type: 'multimodal-prepare', operation: 'inspect', sourceArtifactIds: [attachmentId] });
  assert.deepEqual(prepare, { type: 'multimodal-prepare', operation: 'inspect', sourceArtifactIds: [attachmentId] });
  assert.equal(parseChatWebviewMessage({ type: 'multimodal-prepare', operation: 'inspect', sourceArtifactIds: [attachmentId], provider: 'forged-provider' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'multimodal-prepare', operation: 'inspect', sourceArtifactIds: ['/workspace/private.png'] }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'multimodal-prepare', operation: 'inspect', sourceArtifactIds: [attachmentId, attachmentId] }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'multimodal-status', operationId: 'multimodal-op-bbbbbbbbbbbbbbbbbbbb' }), { type: 'multimodal-status', operationId: 'multimodal-op-bbbbbbbbbbbbbbbbbbbb' });
  assert.equal(parseChatWebviewMessage({ type: 'multimodal-approve', operationId: 'multimodal-op-bbbbbbbbbbbbbbbbbbbb', approvalFingerprint: 'a'.repeat(64), explicit: true, providerPayload: 'raw' }), undefined);
});

test('host route selection uses current declared capability metadata and never trusts a webview route', async () => {
  const router = new CapabilityRouter({ catalog: [currentImageModel()] });
  const route = await selectMultimodalRoute(router, 'local-runtime', 'vision-local', 'inspect', ['image']);
  assert.equal(route.provider, 'local-runtime');
  assert.equal(route.model, 'vision-local');
  assert.equal(route.capabilitySnapshotId.startsWith('cap-'), true);
  assert.equal(route.providerBoundary, 'local');
  assert.deepEqual(route.supportedOperations, ['inspect']);
  await assert.rejects(selectMultimodalRoute(router, 'local-runtime', 'unknown-model', 'inspect', ['image']), /current declared capability/);
  await assert.rejects(selectMultimodalRoute(new CapabilityRouter({ catalog: [currentImageModel({ inputPricePerMillion: undefined, outputPricePerMillion: undefined })] }), 'local-runtime', 'vision-local', 'inspect', ['image']), (error: unknown) => (error as { code?: string }).code === 'unavailable-pricing');
});

test('status DTO preserves bounded lineage and route facts without raw media or paths', () => {
  const operation = {
    version: 1,
    operationId: 'multimodal-op-bbbbbbbbbbbbbbbbbbbb',
    operation: 'inspect',
    status: 'completed',
    sourceArtifactIds: [attachmentId],
    derivedArtifactIds: ['derived-cccccccccccccccccccc'],
    route: { provider: 'local-runtime', model: 'vision-local', providerBoundary: 'local', privacyBoundary: 'local', capabilitySnapshotId: 'cap-current', freshness: 'current', supportedOperations: ['inspect'], cancellationSupported: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as MultimodalOperationRecord;
  const dto = multimodalStatusMessage(operation);
  if (dto.type !== 'multimodal-status') throw new Error('Expected a multimodal status message.');
  const serialized = JSON.stringify(dto);
  assert.deepEqual(dto.operation.sourceArtifactIds, [attachmentId]);
  assert.match(serialized, /derived-cccccccccccccccccccc/);
  assert.doesNotMatch(serialized, /workspace|private\.png|data:|providerPayload|rawHandles/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRouter } from '../services/capabilityRouter';
import { selectMultimodalRoute } from '../services/multimodalOrchestrator';
import type { ModelInfo } from '../services/nearAiClient';


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

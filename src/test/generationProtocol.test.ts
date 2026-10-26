import assert from 'node:assert/strict';
import test from 'node:test';
import { generationPreviewMessage, generationPublicationMessage, generationStatusMessage, parseChatWebviewMessage } from '../services/chatBridge';
import type { GenerationOperationRecord, PublicationPreview } from '../domain/generation';

const operationId = 'generation-op-12345678901234567890';
const fingerprint = 'a'.repeat(64);

test('generation webview protocol accepts bounded review, approval, cancellation, and publication messages', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'generation-preview', operation: 'image-generation', model: 'image-model', prompt: 'safe prompt' }), {
    type: 'generation-preview', operation: 'image-generation', model: 'image-model', prompt: 'safe prompt'
  });
  assert.deepEqual(parseChatWebviewMessage({ type: 'generation-start', operationId, approvalFingerprint: fingerprint, explicit: true }), {
    type: 'generation-start', operationId, approvalFingerprint: fingerprint, explicit: true
  });
  assert.deepEqual(parseChatWebviewMessage({ type: 'generation-cancel', operationId }), { type: 'generation-cancel', operationId });
  assert.deepEqual(parseChatWebviewMessage({ type: 'generation-publication-preview', operationId, destination: 'exports/image.bin' }), {
    type: 'generation-publication-preview', operationId, destination: 'exports/image.bin'
  });
  assert.deepEqual(parseChatWebviewMessage({ type: 'generation-publish', operationId, publicationFingerprint: fingerprint, explicit: true }), {
    type: 'generation-publish', operationId, publicationFingerprint: fingerprint, explicit: true
  });
});

test('generation protocol fails closed for forged capabilities, provider endpoints, raw media, and publication paths', () => {
  assert.equal(parseChatWebviewMessage({ type: 'generation-preview', operation: 'image-generation', model: 'image-model', prompt: 'safe', provider: 'https://evil.test', capabilities: ['generate_video'] }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'generation-preview', operation: 'image-generation', model: 'unknown model', prompt: 'safe' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'generation-preview', operation: 'video-generation', model: 'image-model', prompt: 'safe', media: 'data:image/png;base64,raw' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'generation-start', operationId, approvalFingerprint: fingerprint, explicit: false }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'generation-start', operationId, approvalFingerprint: 'forged', explicit: true }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'generation-publication-preview', operationId, destination: '../outside.bin' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'generation-publication-preview', operationId, destination: '/outside.bin' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'generation-publish', operationId, publicationFingerprint: fingerprint, explicit: true, approval: true }), undefined);
});

test('generation host DTOs expose operational metadata but never prompt or media payloads', () => {
  const operation = {
    version: 1, operationId, skill: 'generate_image', operation: 'image-generation', provider: 'near-ai', model: 'image-model',
    promptFingerprint: fingerprint, sourceArtifactIds: ['attachment-12345678901234567890'], parameters: {},
    route: { provider: 'near-ai', model: 'image-model', operation: 'image-generation', capabilitySnapshotId: 'capability-1', capabilityMetadata: { version: 1, snapshotId: 'capability-1', provider: 'near-ai', modelId: 'image-model', inputModalities: ['text'], outputModalities: ['image'], supportedFeatures: ['generate_image'], providerOperations: ['image-generation'], readiness: 'ready', pricing: { imagePricePerUnit: 1 }, privacyBoundary: 'cloud', locality: 'cloud', verificationStatus: 'verified', metadataStatus: 'current', freshness: 'current', source: '/models/pricing' }, providerBoundary: 'cloud', privacyBoundary: 'cloud', capturedAt: '2026-10-26T00:00:00.000Z' },
    status: 'completed', estimatedCost: { amountUsd: 1, currency: 'USD', basis: 'image-unit', quantity: 1 }, usage: { actualCostUsd: 1, units: 1 }, artifactId: 'generated-12345678901234567890', publication: 'unpublished', attribution: { version: 1, status: 'attributed', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectLabel: 'Studio', organizationProfileId: 'profile-company', organizationDisplayName: 'Company' }, sessionId: 'session-generation-001', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z'
  } as GenerationOperationRecord;
  const status = generationStatusMessage(operation);
  assert.equal(JSON.stringify(status).includes('private prompt'), false);
  assert.equal(JSON.stringify(status).includes('data:image'), false);
  assert.equal(status.type, 'generation-status');
  const previewMessage = generationPreviewMessage({ operationId, skill: 'generate_image', operation: 'image-generation', provider: 'near-ai', model: 'image-model', capabilitySnapshotId: 'capability-1', capabilityFreshness: 'current', providerBoundary: 'cloud', privacyBoundary: 'cloud', estimatedCost: { amountUsd: 1, currency: 'USD', basis: 'image-unit', quantity: 1 }, approval: { previewId: 'preview-1', approvalFingerprint: fingerprint, expiresAt: '2026-10-26T01:00:00.000Z', action: 'generation' }, attribution: operation.attribution, sourceArtifactIds: [], publication: 'unpublished' });
  assert.equal(previewMessage.type, 'generation-preview');
  assert.equal(previewMessage.preview.estimatedCost?.amountUsd, 1);
  const publication: PublicationPreview = { operationId, artifactId: 'generated-12345678901234567890', destination: 'exports/image.bin', approval: { previewId: 'preview-2', approvalFingerprint: fingerprint, expiresAt: '2026-10-26T01:00:00.000Z', action: 'publication' }, attribution: operation.attribution, provenance: 'provider-generated' };
  assert.equal(JSON.stringify(generationPublicationMessage(publication)).includes('private prompt'), false);
});

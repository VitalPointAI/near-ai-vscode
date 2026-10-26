import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultActionPolicy } from '../domain/policy';
import { ActivityStore } from '../services/activityStore';
import { AnalyticsStore } from '../services/analyticsStore';
import { MultimodalIntake } from '../services/multimodalIntake';
import { MultimodalOperationError, MultimodalOrchestrator } from '../services/multimodalOrchestrator';
import { PolicyGate } from '../services/policyGate';
import { PrivacyPreflight } from '../services/privacyPreflight';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('multimodal fixture')]);
const localRoute = { provider: 'local-runtime', model: 'vision-local', providerBoundary: 'local' as const, privacyBoundary: 'local' as const, capabilitySnapshotId: 'cap-current', freshness: 'current' as const, supportedOperations: ['inspect', 'summarize', 'transform'] as const, cancellationSupported: true };
const cloudRoute = { provider: 'cloud-runtime', model: 'vision-cloud', providerBoundary: 'cloud' as const, privacyBoundary: 'cloud' as const, capabilitySnapshotId: 'cap-current-cloud', freshness: 'current' as const, supportedOperations: ['inspect', 'summarize'] as const, cancellationSupported: true };

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-orchestration-'));
  await writeFile(path.join(root, 'photo.png'), png);
  return root;
}

async function stage(root: string, privacy = new PrivacyPreflight()): Promise<{ intake: MultimodalIntake; artifactId: string }> {
  const intake = new MultimodalIntake(root, { privacy });
  const result = await intake.stage({ sourcePath: 'photo.png', consent: true });
  return { intake, artifactId: result.record.artifactId };
}

test('approved local operation creates a derived artifact with immutable source lineage and no raw bytes', async () => {
  const root = await fixtureRoot();
  const { intake, artifactId } = await stage(root);
  const orchestrator = new MultimodalOrchestrator(root, { intake, policyGate: new PolicyGate(defaultActionPolicy(), new PrivacyPreflight()) });
  const prepared = await orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: localRoute });
  const completed = await orchestrator.run(prepared.operationId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.derivedArtifactIds.length, 1);
  const derived = orchestrator.getDerived(completed.derivedArtifactIds[0]);
  assert.deepEqual(derived?.sourceArtifactIds, [artifactId]);
  assert.equal(orchestrator.getLineage()[0]?.sourceArtifactId, artifactId);
  assert.equal(JSON.stringify(derived).includes(png.toString('utf8')), false);
  assert.equal(JSON.stringify(completed).includes('multimodal fixture'), false);
});

test('cloud transfer requires exact approval and cannot silently fall back or accept forged fingerprints', async () => {
  const root = await fixtureRoot();
  const privacy = new PrivacyPreflight({ mode: 'local-only' });
  const { intake, artifactId } = await stage(root, privacy);
  const orchestrator = new MultimodalOrchestrator(root, { intake, privacy, policyGate: new PolicyGate(defaultActionPolicy(), privacy) });
  const prepared = await orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: cloudRoute });
  assert.equal(prepared.status, 'awaiting-approval');
  await assert.rejects(orchestrator.approve(prepared.operationId, 'a'.repeat(64)), (error: unknown) => error instanceof MultimodalOperationError && error.code === 'approval-fingerprint-mismatch');
  const approved = await orchestrator.approve(prepared.operationId, prepared.approval?.approvalFingerprint ?? '');
  const rejected = await orchestrator.run(approved.operationId, approved.approvalFingerprint);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.reason, 'operation-not-supported');
  assert.equal(rejected.route.provider, 'cloud-runtime');
});

test('unknown, stale, unsupported, and scope-expanded routes fail closed', async () => {
  const root = await fixtureRoot();
  const { intake, artifactId } = await stage(root);
  const orchestrator = new MultimodalOrchestrator(root, { intake });
  await assert.rejects(orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: { ...localRoute, freshness: 'stale' } }), (error: unknown) => error instanceof MultimodalOperationError && error.code === 'stale-capability');
  await assert.rejects(orchestrator.prepare({ operation: 'publish', sourceArtifactIds: [artifactId], route: localRoute }), (error: unknown) => error instanceof MultimodalOperationError && error.code === 'operation-not-supported');
  await assert.rejects(orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: ['attachment-aaaaaaaaaaaaaaaaaaaa'], route: localRoute }), (error: unknown) => error instanceof MultimodalOperationError && error.code === 'invalid-reference');
});

test('raw handles are released only after explicit raw-content approval and remain absent from derived metadata', async () => {
  const root = await fixtureRoot();
  const { intake, artifactId } = await stage(root);
  let handleCount = 0;
  const orchestrator = new MultimodalOrchestrator(root, { intake, execute: async ({ rawHandles }) => { handleCount = rawHandles.length; return { kind: 'transformed', label: 'safe derived output', safePreview: 'metadata-only output', managedReference: `multimodal://${artifactId}` }; } });
  const prepared = await orchestrator.prepare({ operation: 'transform', sourceArtifactIds: [artifactId], route: localRoute, rawContentRequested: true });
  const approved = await orchestrator.approve(prepared.operationId, prepared.approval?.approvalFingerprint ?? '');
  const completed = await orchestrator.run(approved.operationId, approved.approvalFingerprint);
  assert.equal(handleCount, 1);
  assert.equal(completed.status, 'completed');
  assert.doesNotMatch(JSON.stringify(orchestrator.getDerived(completed.derivedArtifactIds[0])), /multimodal fixture|data:/);
});

test('cancellation, budget stop, restart pause, and recovery require safe terminal or fresh approval states', async () => {
  const root = await fixtureRoot();
  const { intake, artifactId } = await stage(root);
  const orchestrator = new MultimodalOrchestrator(root, { intake, budgetLimitUsd: 0.01 });
  const cancelled = await orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: localRoute, estimatedCostUsd: 1 });
  const budget = await orchestrator.run(cancelled.operationId);
  assert.equal(budget.status, 'budget-blocked');
  const stopped = await orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: localRoute });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await orchestrator.run(stopped.operationId, undefined, aborted.signal)).status, 'cancelled');
  const resumable = await orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: localRoute });
  const rehydrated = new MultimodalOrchestrator(root, { intake });
  await rehydrated.rehydrate();
  assert.equal(rehydrated.list().find((row) => row.operationId === resumable.operationId)?.status, 'paused');
  const recovered = await rehydrated.recover(resumable.operationId);
  assert.equal(recovered.status, 'awaiting-approval');
  const blocked = await rehydrated.run(recovered.operationId);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.reason, 'approval-fingerprint-mismatch');
});

test('activity and analytics contain bounded operation metadata and never raw media', async () => {
  const root = await fixtureRoot();
  const { intake, artifactId } = await stage(root);
  const activity = new ActivityStore(root);
  const session = await activity.start({ sessionId: 'session-multimodal-001', project: 'fixture' });
  const orchestrator = new MultimodalOrchestrator(root, { intake, activity });
  const prepared = await orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: localRoute, sessionId: session.sessionId });
  await orchestrator.run(prepared.operationId);
  const stored = await readFile(path.join(root, '.planning', '.near-ai', 'activity.json'), 'utf8');
  assert.doesNotMatch(stored, /multimodal fixture|raw media|data:/);
  const result = await new AnalyticsStore({ sessions: await activity.list() }).query();
  assert.equal(result.timeline.some((event) => event.requestId === prepared.operationId), true);
  assert.doesNotMatch(JSON.stringify(result), /multimodal fixture|raw media|data:/);
});

test('emergency stop blocks new multimodal preparation and never falls back to an unapproved route', async () => {
  const root = await fixtureRoot();
  const { intake, artifactId } = await stage(root);
  const orchestrator = new MultimodalOrchestrator(root, { intake, emergencyStop: () => true });
  await assert.rejects(orchestrator.prepare({ operation: 'inspect', sourceArtifactIds: [artifactId], route: localRoute }), (error: unknown) => error instanceof MultimodalOperationError && error.code === 'emergency-stop');
});

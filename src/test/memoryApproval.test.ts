import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { MemoryApprovalDescriptor, MemoryProvenance, MemoryScope } from '../domain/contextGraph';
import { ContextGraphError, ContextGraphMemory } from '../services/contextGraphMemory';
import { MemoryApprovalError, MemoryApprovalRegistry } from '../services/memoryApproval';

const scope: MemoryScope = { kind: 'project', id: 'project-memory-test' };
const provenance: MemoryProvenance = { kind: 'user', sourceId: 'user-note-1', sourceHash: 'a'.repeat(64), capturedAt: '2026-01-01T00:00:00.000Z', evidenceClass: 'user-assertion', actorId: 'user' };

function descriptor(overrides: Partial<MemoryApprovalDescriptor> = {}): MemoryApprovalDescriptor {
  return { operation: 'correct', scope, expectedGraphVersion: 1, nodeIds: ['fact-aaaaaaaaaaaaaaaa'], sourceNodeIds: [], summary: 'Use the bounded local route', localOnly: true, providerBoundary: 'local', sessionId: 'session-memory-test', projectId: 'project-host-test', ...overrides };
}

test('host-created exact correction approval authorizes one matching mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-memory-approval-'));
  const memory = new ContextGraphMemory(root);
  const node = await memory.addFact({ scope, label: 'Route', summary: 'Use the local route', provenance, authoringActorId: 'user' });
  const registry = new MemoryApprovalRegistry({ clock: () => Date.parse('2026-01-02T00:00:00.000Z') });
  const summary = 'Use the bounded local route';
  const created = registry.create(descriptor({ expectedGraphVersion: 1, nodeIds: [node.nodeId], summary }));
  assert.equal(created.operation, 'correct');
  assert.equal(created.scope.id, scope.id);
  assert.equal(created.expectedGraphVersion, 1);
  assert.equal(created.summaryLength, summary.length);
  assert.equal('summary' in created, false);
  const authorization = registry.consume(created.approvalFingerprint);
  const corrected = await memory.correct({ scope, nodeId: node.nodeId, expectedGraphVersion: 1, summary, provenance, authoringActorId: 'user' }, authorization);
  assert.equal(corrected.correctedFromNodeId, node.nodeId);
  await assert.rejects(async () => registry.consume(created.approvalFingerprint), (error: unknown) => error instanceof MemoryApprovalError && error.code === 'replayed');
  assert.equal((await memory.inspect(scope)).graphVersion, 2);
});

test('shape-valid fingerprints and descriptor mismatches fail before a memory mutation', async () => {
  const registry = new MemoryApprovalRegistry({ clock: () => Date.parse('2026-01-02T00:00:00.000Z') });
  const preview = registry.create(descriptor());
  const mismatches: MemoryApprovalDescriptor[] = [
    descriptor({ operation: 'merge', nodeIds: ['fact-aaaaaaaaaaaaaaaa'], sourceNodeIds: ['fact-bbbbbbbbbbbbbbbb'], summary: undefined }),
    descriptor({ scope: { kind: 'team-collective', id: 'team-other-scope' } }),
    descriptor({ expectedGraphVersion: 2 }),
    descriptor({ nodeIds: ['fact-bbbbbbbbbbbbbbbb'] }),
    descriptor({ summary: 'Use the bounded cloud route' }),
    descriptor({ localOnly: false }),
    descriptor({ providerBoundary: 'cloud' }),
    descriptor({ sessionId: 'session-other' }),
    descriptor({ projectId: 'project-other' })
  ];
  for (const mismatch of mismatches) await assert.rejects(async () => registry.consume(preview.approvalFingerprint, mismatch), (error: unknown) => error instanceof MemoryApprovalError && error.code === 'mismatch');
  await assert.rejects(async () => registry.consume('a'.repeat(64)), (error: unknown) => error instanceof MemoryApprovalError && error.code === 'invalid');
  assert.equal(registry.pendingCount(), 1);
});

test('expired approvals, stale versions, operation reuse, and export bypasses fail closed', async () => {
  let now = Date.parse('2026-01-02T00:00:00.000Z');
  const registry = new MemoryApprovalRegistry({ clock: () => now, ttlMs: 100 });
  const expired = registry.create(descriptor());
  now += 101;
  await assert.rejects(async () => registry.consume(expired.approvalFingerprint), (error: unknown) => error instanceof MemoryApprovalError && error.code === 'expired');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-memory-approval-expiry-'));
  const memory = new ContextGraphMemory(root);
  const node = await memory.addFact({ scope, label: 'Route', summary: 'Use the local route', provenance, authoringActorId: 'user' });
  const exportPreview = registry.create(descriptor({ operation: 'export', expectedGraphVersion: 1, nodeIds: [], summary: undefined }));
  const exportApproval = registry.consume(exportPreview.approvalFingerprint);
  await assert.rejects(async () => memory.correct({ scope, nodeId: node.nodeId, expectedGraphVersion: 1, summary: 'Not the export operation', provenance, authoringActorId: 'user' }, exportApproval), (error: unknown) => error instanceof ContextGraphError && error.code === 'approval-mismatch');
  await assert.rejects(() => memory.export(scope, { expectedGraphVersion: 1, approval: undefined as never }), (error: unknown) => error instanceof ContextGraphError && error.code === 'approval-required');
  const audit = registry.getAudit();
  assert.equal(audit.some((record) => record.outcome === 'expired'), true);
  assert.doesNotMatch(JSON.stringify(audit), /bounded local route|approvalFingerprint|secret|raw context/i);
});

test('all memory operations bind distinct descriptors and audit only bounded metadata', async () => {
  const registry = new MemoryApprovalRegistry({ clock: () => Date.parse('2026-01-02T00:00:00.000Z') });
  const operations: MemoryApprovalDescriptor['operation'][] = ['correct', 'merge', 'retract', 'reset', 'export'];
  const fingerprints = operations.map((operation) => registry.create(descriptor({ operation, nodeIds: operation === 'correct' || operation === 'retract' || operation === 'merge' ? ['fact-aaaaaaaaaaaaaaaa'] : [], sourceNodeIds: operation === 'merge' ? ['fact-bbbbbbbbbbbbbbbb'] : [], summary: operation === 'correct' ? 'Correction summary' : undefined })).approvalFingerprint);
  assert.equal(new Set(fingerprints).size, operations.length);
  for (const fingerprint of fingerprints) registry.consume(fingerprint);
  assert.equal(registry.getAudit().filter((record) => record.outcome === 'consumed').length, operations.length);
  assert.doesNotMatch(JSON.stringify(registry.getAudit()), /Correction summary|session-memory-test|project-host-test|[a-f0-9]{64}/i);
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { MemoryApprovalDescriptor, MemoryProvenance, MemoryScope } from '../domain/contextGraph';
import { ContextGraphMemory, ContextGraphError } from '../services/contextGraphMemory';
import { ContextGraphStore } from '../services/contextGraphStore';
import { MemoryApprovalRegistry } from '../services/memoryApproval';
import { AgentProfileStore } from '../services/agentProfiles';
import { AgentOrchestrator } from '../services/agentOrchestrator';
import { AnalyticsStore } from '../services/analyticsStore';

const hash = 'a'.repeat(64);
const privateScope: MemoryScope = { kind: 'private-agent', id: 'agent-aaaaaaaa' };
const teamScope: MemoryScope = { kind: 'team-collective', id: 'team-bbbbbbbb' };
const projectScope: MemoryScope = { kind: 'project', id: 'project-cccccccc' };
const provenance: MemoryProvenance = { kind: 'user', sourceId: 'user-note-1', sourceHash: hash, capturedAt: '2026-01-01T00:00:00.000Z', evidenceClass: 'user-assertion', actorId: 'user' };

function memory(root: string, now = '2026-01-02T00:00:00.000Z'): ContextGraphMemory { return new ContextGraphMemory(root, { clock: () => now, trustedActorIds: ['agent-aaaaaaaa'] }); }
function fact(scope: MemoryScope, summary: string, extra: Partial<Parameters<ContextGraphMemory['addFact']>[0]> = {}): Parameters<ContextGraphMemory['addFact']>[0] { return { scope, label: summary.split(' ')[0], summary, provenance, authoringActorId: 'user', ...extra }; }
function approval(input: Omit<MemoryApprovalDescriptor, 'localOnly' | 'providerBoundary' | 'sessionId' | 'projectId'>) {
  const registry = new MemoryApprovalRegistry({ clock: () => Date.parse('2026-01-02T00:00:00.000Z') });
  return registry.consume(registry.create({ ...input, localOnly: true, providerBoundary: 'local', sessionId: 'session-test-001', projectId: 'project-test-001' }).approvalFingerprint);
}

test('private and collective team facts remain isolated and produce bounded task slices', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-graph-'));
  const service = memory(root);
  const privateFact = await service.addFact(fact(privateScope, 'Build uses local inference'));
  const teamFact = await service.addFact(fact(teamScope, 'Team reviews changes before merge'));
  const privateSlice = await service.slice({ task: 'build local inference', agentId: privateScope.id, scopes: [privateScope], localOnly: true, providerBoundary: 'local' });
  assert.deepEqual(privateSlice.factIds, [privateFact.nodeId]);
  assert.equal(privateSlice.nodes.some((node) => node.nodeId === teamFact.nodeId), false);
  await assert.rejects(() => service.slice({ task: 'team memory', agentId: privateScope.id, scopes: [teamScope], localOnly: true, providerBoundary: 'local' }), (error: unknown) => error instanceof ContextGraphError && error.code === 'scope-denied');
  const collectiveSlice = await service.slice({ task: 'reviews merge', teamId: teamScope.id, scopes: [teamScope], localOnly: true, providerBoundary: 'local' });
  assert.deepEqual(collectiveSlice.factIds, [teamFact.nodeId]);
  assert.equal(JSON.stringify(privateSlice).includes('private prompt'), false);
});

test('typed edges retain positive, negative, and neutral tension with conflict state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-edge-'));
  const service = memory(root);
  const one = await service.addFact(fact(projectScope, 'Provider is local'));
  const two = await service.addFact(fact(projectScope, 'Provider is cloud', { label: 'Provider' }));
  const positive = await service.addEdge({ scope: projectScope, type: 'supports', fromNodeId: one.nodeId, toNodeId: two.nodeId, polarity: 'positive', weight: 0.7, explanation: 'Both records describe the selected route.', provenance, authoringActorId: 'user', expectedGraphVersion: 2 });
  const negative = await service.addEdge({ scope: projectScope, type: 'contradicts', fromNodeId: one.nodeId, toNodeId: two.nodeId, polarity: 'negative', weight: -0.9, explanation: 'The provider boundary conflicts.', provenance, authoringActorId: 'user', expectedGraphVersion: 3 });
  const neutral = await service.addEdge({ scope: projectScope, type: 'relates-to', fromNodeId: one.nodeId, toNodeId: two.nodeId, polarity: 'neutral', weight: 0, explanation: 'Records share a topic.', provenance, authoringActorId: 'user', expectedGraphVersion: 4 });
  const preview = await service.inspect(projectScope);
  assert.deepEqual(preview.edges.map((edge) => edge.polarity), ['positive', 'negative', 'neutral']);
  assert.equal(negative.conflict.status, 'conflicted');
  assert.equal(preview.counts.conflicts >= 2, true);
  await assert.rejects(() => service.addEdge({ scope: projectScope, type: 'supports', fromNodeId: one.nodeId, toNodeId: two.nodeId, polarity: 'positive', weight: 2, explanation: 'bad', provenance, authoringActorId: 'user' }), /between -1 and 1/);
  assert.equal(positive.weight, 0.7);
  assert.equal(neutral.weight, 0);
});

test('provenance, capability claims, raw content, paths, and executable instructions fail closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-negative-'));
  const service = memory(root);
  await assert.rejects(() => service.addFact(fact(privateScope, 'apiKey: secret')), (error: unknown) => error instanceof ContextGraphError && error.code === 'unsafe-content');
  await assert.rejects(() => service.addFact(fact(privateScope, 'raw private prompt content')), (error: unknown) => error instanceof ContextGraphError && error.code === 'unsafe-content');
  await assert.rejects(() => service.addFact(fact(privateScope, 'Run shell command to modify workspace')), (error: unknown) => error instanceof ContextGraphError && error.code === 'unsafe-content');
  await assert.rejects(() => service.addFact(fact(privateScope, '/home/user/private')), (error: unknown) => error instanceof ContextGraphError && error.code === 'unsafe-content');
  await assert.rejects(() => service.addNode({ ...fact(privateScope, 'Provider capability'), type: 'capability', provenance: { ...provenance, kind: 'agent', evidenceClass: 'observation' }, authoringActorId: 'agent-forged' }), (error: unknown) => error instanceof ContextGraphError && (error.code === 'invalid-provenance' || error.code === 'invalid-capability'));
  await assert.rejects(() => service.addFact(fact({ kind: 'project', id: '../secret' }, 'not allowed')), (error: unknown) => error instanceof ContextGraphError && error.code === 'invalid-scope');
  await assert.rejects(() => service.addFact({ ...fact(privateScope, 'forged source'), provenance: { ...provenance, sourceHash: 'not-a-hash' } }), (error: unknown) => error instanceof ContextGraphError && error.code === 'invalid-provenance');
});

test('freshness and decay remain visible rather than deleting old evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-decay-'));
  const service = memory(root, '2026-04-01T00:00:00.000Z');
  const node = await service.addFact(fact(projectScope, 'Old deployment preference', { freshness: { observedAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', halfLifeDays: 30 } }));
  const preview = await service.inspect(projectScope);
  assert.equal(preview.nodes[0].nodeId, node.nodeId);
  assert.equal(preview.nodes[0].freshness.decayed, true);
  const slice = await service.slice({ task: 'deployment preference', projectId: projectScope.id, scopes: [projectScope], localOnly: true, providerBoundary: 'local' });
  assert.equal(slice.factIds.includes(node.nodeId), true);
});

test('correction, merge, retraction, reset, stale edits, and export preserve safe history boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-mutations-'));
  const service = memory(root);
  const first = await service.addFact(fact(projectScope, 'Review uses checklist'));
  const second = await service.addFact(fact(projectScope, 'Review uses checklist and tests', { label: 'Review' }));
  const correctedSummary = 'Review uses a checklist and tests';
  const corrected = await service.correct({ scope: projectScope, nodeId: first.nodeId, expectedGraphVersion: 2, summary: correctedSummary, provenance, authoringActorId: 'user' }, approval({ operation: 'correct', scope: projectScope, expectedGraphVersion: 2, nodeIds: [first.nodeId], sourceNodeIds: [], summary: correctedSummary }));
  assert.equal(corrected.correctedFromNodeId, first.nodeId);
  const mergedSummary = 'Review uses a bounded checklist and tests';
  const merged = await service.merge({ scope: projectScope, targetNodeId: corrected.nodeId, sourceNodeIds: [second.nodeId], expectedGraphVersion: 3, summary: mergedSummary, provenance, authoringActorId: 'user' }, approval({ operation: 'merge', scope: projectScope, expectedGraphVersion: 3, nodeIds: [corrected.nodeId], sourceNodeIds: [second.nodeId], summary: mergedSummary }));
  assert.deepEqual(merged.mergedFromNodeIds?.sort(), [corrected.nodeId, second.nodeId].sort());
  const current = await service.inspect(projectScope);
  await assert.rejects(() => service.retract(projectScope, merged.nodeId, current.graphVersion - 1, approval({ operation: 'retract', scope: projectScope, expectedGraphVersion: current.graphVersion - 1, nodeIds: [merged.nodeId], sourceNodeIds: [] })), (error: unknown) => error instanceof ContextGraphError && error.code === 'stale-version');
  const retracted = await service.retract(projectScope, merged.nodeId, current.graphVersion, approval({ operation: 'retract', scope: projectScope, expectedGraphVersion: current.graphVersion, nodeIds: [merged.nodeId], sourceNodeIds: [] }));
  assert.equal(retracted.nodes.find((node) => node.nodeId === merged.nodeId)?.state, 'retracted');
  const afterRetract = await service.slice({ task: 'review checklist', projectId: projectScope.id, scopes: [projectScope], localOnly: true, providerBoundary: 'local' });
  assert.equal(afterRetract.factIds.includes(merged.nodeId), false);
  const exportValue = await service.export(projectScope, { expectedGraphVersion: retracted.graphVersion, approval: approval({ operation: 'export', scope: projectScope, expectedGraphVersion: retracted.graphVersion, nodeIds: [], sourceNodeIds: [] }) });
  assert.equal(exportValue.includes('raw context'), false);
  const reset = await service.reset(projectScope, retracted.graphVersion, approval({ operation: 'reset', scope: projectScope, expectedGraphVersion: retracted.graphVersion, nodeIds: [], sourceNodeIds: [] }));
  assert.equal(reset.nodes.length, 0);
  const rehydrated = new ContextGraphMemory(root);
  assert.equal((await rehydrated.inspect(projectScope)).nodes.length, 0);
  await assert.rejects(() => rehydrated.export(projectScope, { expectedGraphVersion: reset.graphVersion, approval: undefined as never }), /approval/);
  const stored = await readFile(path.join(root, '.planning', '.near-ai', 'context-graphs.json'), 'utf8');
  assert.equal(/private prompt|apiKey|raw media|signing material/i.test(stored), false);
});

test('local-only, cancellation, provider crossing, and bounded slice behavior are explicit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-policy-'));
  const service = memory(root);
  await service.addFact(fact(projectScope, 'Local policy fact'));
  await assert.rejects(() => service.slice({ task: 'local policy', projectId: projectScope.id, scopes: [projectScope], localOnly: true, providerBoundary: 'cloud' }), (error: unknown) => error instanceof ContextGraphError && error.code === 'local-only');
  await assert.rejects(() => service.slice({ task: 'local policy', projectId: projectScope.id, scopes: [projectScope], providerBoundary: 'cloud' }), /exact outbound approval/);
  const approved = await service.slice({ task: 'local policy', projectId: projectScope.id, scopes: [projectScope], providerBoundary: 'cloud', outboundApproved: true, approvalFingerprint: 'b'.repeat(64) });
  assert.equal(approved.privacy.outboundApproved, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => service.slice({ task: 'local policy', projectId: projectScope.id, scopes: [projectScope], localOnly: true, providerBoundary: 'local', signal: controller.signal }), (error: unknown) => error instanceof ContextGraphError && error.code === 'cancelled');
  const stopped = new ContextGraphMemory(root, { emergencyStop: () => true });
  await assert.rejects(() => stopped.addFact(fact(projectScope, 'Stopped operation')), (error: unknown) => error instanceof ContextGraphError && error.code === 'cancelled');
});

test('orchestrator traces an approved private fact into route metadata without exposing graph content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-tracer-'));
  const profiles = new AgentProfileStore(root);
  await profiles.create({ profileId: privateScope.id, role: 'planner', capabilities: ['read', 'plan'], preferredProvider: 'local-runtime', locality: 'local', preferredModel: 'local-model' });
  const service = memory(root);
  const factNode = await service.addFact(fact(privateScope, 'Planner prefers bounded local context'));
  const orchestrator = new AgentOrchestrator(root, { profiles, contextMemory: service });
  const route = await orchestrator.route({ role: 'planner', task: 'plan bounded local context', requiredCapabilities: ['read'], locality: 'local', memory: { agentId: privateScope.id, scopes: [privateScope], localOnly: true } });
  assert.equal(route.explanation.memory?.factIds.includes(factNode.nodeId), true);
  assert.equal(route.explanation.memory?.scopes[0].kind, 'private-agent');
  assert.equal(JSON.stringify(route.explanation).includes('Planner prefers'), false);
  const deployed = await orchestrator.deploy({ role: 'planner', task: 'plan bounded local context', requiredCapabilities: ['read'], locality: 'local', memory: { agentId: privateScope.id, scopes: [privateScope], localOnly: true }, providerBoundary: 'local' });
  assert.equal(deployed.memorySlice?.factIds.includes(factNode.nodeId), true);
  assert.equal(JSON.stringify(deployed).includes('Planner prefers'), false);
});

test('memory audit analytics expose only bounded scope and IDs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-context-analytics-'));
  const service = memory(root);
  const node = await service.addFact(fact(projectScope, 'Safe local fact'));
  const result = await new AnalyticsStore({ sessions: [] }, undefined, undefined, undefined, service).query();
  const event = result.timeline.find((entry) => entry.source === 'memory' && entry.kind === 'memory-write');
  assert.equal(event?.scope, 'project:project-cccccccc');
  assert.deepEqual(event?.nodeIds, [node.nodeId]);
  assert.doesNotMatch(event?.summary ?? '', /Safe local fact|apiKey|raw context|prompt/i);
});

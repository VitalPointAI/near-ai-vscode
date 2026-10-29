import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryInspectMessage, sanitizeContextGraphNode } from '../services/chatBridge';
import { toolsPageHtml } from '../services/toolsDirectory';
import type { ContextGraphPreviewDto } from '../domain/contextGraph';

// The memory explorer that lived on the old Tools tab (graph canvas, filters, approval-gated
// corrections) was hidden in 0.4.x and is now removed with that page; project memory is reached
// through the agent's Remember/Recall tools and NEAR AI: Manage Memory. What stays is the host's
// graph message sanitizing, which every memory message still goes through.

function fixture(): ContextGraphPreviewDto {
  const scope = { kind: 'project' as const, id: 'project-bounded-001' };
  const freshness = { observedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', decayed: false };
  const provenance = { kind: 'user' as const, sourceId: 'source-bounded-001', evidenceClass: 'user-assertion' as const };
  const node = (nodeId: string, type: 'fact' | 'actor', label: string, state: 'active' | 'corrected' = 'active') => ({ nodeId, type, label, summary: 'bounded summary', scope, confidence: .82, freshness, provenance, state, conflict: { status: 'none' as const, conflictIds: [] }, version: 1 });
  return { version: 1, scope, graphVersion: 7, nodes: [node('node-bounded-001', 'fact', 'Safe fact'), node('node-bounded-002', 'actor', 'Safe actor', 'corrected')], edges: [{ edgeId: 'edge-bounded-001', type: 'contradicts', fromNodeId: 'node-bounded-001', toNodeId: 'node-bounded-002', polarity: 'negative', weight: -.7, explanation: 'bounded tension', scope, state: 'active', conflict: { status: 'conflicted', conflictIds: ['conflict-001'] }, version: 1 }], counts: { nodes: 2, edges: 1, facts: 1, conflicts: 1, retracted: 0 }, accessibleOutline: ['Safe fact · supports bounded review', 'contradicts · negative tension · weight -0.70 · conflicted'], localOnly: true };
}

test('the Tools tab no longer carries the retired memory explorer', () => {
  const html = toolsPageHtml({ cspSource: 'vscode-webview://test', nonce: 'nonce-test-0001', script: 'tools.js', style: 'tools.css' });
  for (const id of ['memory-graph', 'memory-filters', 'memory-actions', 'memory-table', 'memory-scope-kind', 'team-studio', 'attachments', 'generation-heading']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
});

test('memory inspect messages keep only bounded, redacted, local-only graph metadata', () => {
  const unsafe = fixture();
  unsafe.nodes[0] = { ...unsafe.nodes[0], label: 'raw context dump', summary: 'Bearer abc' };
  const message = memoryInspectMessage(unsafe);
  assert.equal(message.type, 'memory-inspect');
  const preview = (message as { preview: ContextGraphPreviewDto }).preview;
  assert.equal(preview.graphVersion, 7);
  assert.equal(preview.localOnly, true);
  assert.equal(preview.nodes.length, 2);
  assert.equal(preview.edges.length, 1);
  const text = JSON.stringify(preview);
  assert.equal(text.includes('raw context'), false);
  assert.equal(/bearer/i.test(text), false);
  assert.match(text, /Safe actor/);
});

test('host graph messages remain allowlisted and redact unsafe text', () => {
  const node = sanitizeContextGraphNode({ nodeId: 'fact-safe0000000000000001', type: 'fact', label: '<script>secret</script>', summary: 'apiKey: secret', scope: { kind: 'project', id: 'project-safe0000000000000001' }, confidence: 2, freshness: { observedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', decayed: false }, provenance: { kind: 'user', sourceId: '/tmp/private', evidenceClass: 'user-assertion' }, state: 'active', conflict: { status: 'none', conflictIds: [] }, version: 1 });
  assert.equal(node.label.includes('secret'), false);
  assert.equal(node.summary.includes('secret'), false);
  assert.equal(node.confidence, 1);
});

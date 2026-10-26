import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseChatWebviewMessage } from '../services/chatBridge';

const scope = { kind: 'team-collective', id: 'team-bbbbbbbb' };
const nodeId = 'fact-aaaaaaaaaaaaaaaaaaaa';
const fingerprint = 'a'.repeat(64);

test('memory inspection and slice messages are strict, scoped, and host-derived', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-inspect', scope, localOnly: true }), { type: 'memory-inspect', scope, localOnly: true });
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-search', scope, query: 'review' }), { type: 'memory-search', scope, query: 'review', nodeType: undefined });
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-slice-preview', task: 'review the bounded team facts', teamId: scope.id, scopes: [scope], localOnly: true }), { type: 'memory-slice-preview', task: 'review the bounded team facts', teamId: scope.id, scopes: [scope], localOnly: true });
  assert.equal(parseChatWebviewMessage({ type: 'memory-inspect', scope: { kind: 'team-collective', id: '../private' } }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-slice-preview', task: 'raw private prompt', teamId: scope.id, scopes: [scope] }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-slice-preview', task: 'review', scopes: [scope], provider: 'cloud-provider' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-search', scope, query: 'x'.repeat(161) }), undefined);
});

test('memory mutation messages require opaque IDs, expected versions, and explicit approval', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-correct', scope, nodeId, expectedGraphVersion: 2, summary: 'Corrected bounded fact', approvalFingerprint: fingerprint, explicit: true }), { type: 'memory-correct', scope, nodeId, expectedGraphVersion: 2, summary: 'Corrected bounded fact', approvalFingerprint: fingerprint, explicit: true });
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-merge', scope, targetNodeId: nodeId, sourceNodeIds: ['fact-bbbbbbbbbbbbbbbbbbbb'], expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true }), { type: 'memory-merge', scope, targetNodeId: nodeId, sourceNodeIds: ['fact-bbbbbbbbbbbbbbbbbbbb'], expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true });
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-retract', scope, nodeId, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true }), { type: 'memory-retract', scope, nodeId, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true });
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-reset', scope, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true }), { type: 'memory-reset', scope, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true });
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-export', scope, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true }), { type: 'memory-export', scope, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true });
  assert.equal(parseChatWebviewMessage({ type: 'memory-retract', scope, nodeId, expectedGraphVersion: 2, approvalFingerprint: 'forged', explicit: true }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-export', scope, expectedGraphVersion: 2, nodeId, approvalFingerprint: fingerprint, explicit: true }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-merge', scope, targetNodeId: nodeId, sourceNodeIds: [nodeId, nodeId], expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-retract', scope, nodeId, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: false }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-correct', scope, nodeId: '/tmp/private', expectedGraphVersion: 2, summary: 'bad', approvalFingerprint: fingerprint, explicit: true }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-reset', scope, expectedGraphVersion: 2, approvalFingerprint: fingerprint, explicit: true, scopeOverride: 'project-other' }), undefined);
});

test('memory controls use accessible table/outline language and do not accept raw content fields', () => {
  const message = parseChatWebviewMessage({ type: 'memory-correct', scope, nodeId, expectedGraphVersion: 1, summary: 'apiKey: secret', approvalFingerprint: fingerprint, explicit: true });
  assert.equal(message, undefined, 'credential-shaped correction must be rejected at the boundary');
  assert.equal(parseChatWebviewMessage({ type: 'memory-export', scope, expectedGraphVersion: 1, approvalFingerprint: fingerprint, explicit: true, rawContext: 'secret' }), undefined);
});

test('memory approval preview and one-shot confirmation messages are strict and bounded', () => {
  const correct = parseChatWebviewMessage({ type: 'memory-preview', operation: 'correct', scope, nodeId, expectedGraphVersion: 2, summary: 'Use the bounded local route', localOnly: true });
  assert.deepEqual(correct, { type: 'memory-preview', operation: 'correct', scope, nodeId, expectedGraphVersion: 2, summary: 'Use the bounded local route', localOnly: true });
  const merge = parseChatWebviewMessage({ type: 'memory-preview', operation: 'merge', scope, targetNodeId: nodeId, sourceNodeIds: ['fact-bbbbbbbbbbbbbbbbbbbb'], expectedGraphVersion: 2, localOnly: true });
  assert.equal(merge?.type, 'memory-preview');
  assert.deepEqual(parseChatWebviewMessage({ type: 'memory-approve', approvalFingerprint: fingerprint, explicit: true }), { type: 'memory-approve', approvalFingerprint: fingerprint, explicit: true });
  assert.equal(parseChatWebviewMessage({ type: 'memory-preview', operation: 'correct', scope, nodeId, expectedGraphVersion: 2, summary: 'private prompt: secret' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-preview', operation: 'export', scope, expectedGraphVersion: 2, localOnly: true, providerBoundary: 'cloud' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-preview', operation: 'reset', scope, expectedGraphVersion: 2, rawContext: 'secret' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'memory-approve', approvalFingerprint: 'a'.repeat(63), explicit: true }), undefined);
});

test('memory explorer exposes interactive graph, table, outline fallback, and safe labels', async () => {
  const source = await readFile('src/services/chat.ts', 'utf8');
  for (const control of ['memory-preview', 'memory-approve', 'Interactive memory graph', 'Memory nodes with provenance confidence freshness tension and conflict', 'Accessible outline fallback', 'Preview correction', 'Preview merge of selected nodes', 'Preview retraction', 'Preview reset graph', 'Preview local export']) assert.match(source, new RegExp(control.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
  assert.match(source, /role','button/);
  assert.match(source, /textContent/);
  assert.match(source, /local-only/);
});

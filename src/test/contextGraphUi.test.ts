import assert from 'node:assert/strict';
import test from 'node:test';
import { toolsPageHtml } from '../services/toolsDirectory';

// The memory explorer that lived on the old Tools tab (graph canvas, filters, approval-gated
// corrections) was hidden in 0.4.x and is now removed with that page; project memory is reached
// through the agent's Remember/Recall tools and NEAR AI: Manage Memory. The chat host no longer
// accepts memory explorer messages at all (see chatBridge.test.ts).

test('the Tools tab no longer carries the retired memory explorer', () => {
  const html = toolsPageHtml({ cspSource: 'vscode-webview://test', nonce: 'nonce-test-0001', script: 'tools.js', style: 'tools.css' });
  for (const id of ['memory-graph', 'memory-filters', 'memory-actions', 'memory-table', 'memory-scope-kind', 'team-studio', 'attachments', 'generation-heading']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
});

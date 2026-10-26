import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { redactSecrets } from '../domain/redaction';
import { saveHandoff } from '../services/handoff';

test('saveHandoff writes a versioned checkpoint under .planning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-handoff-'));
  const file = await saveHandoff(root, { reason: 'manual', currentAction: 'Planning', nextAction: 'Resume', activeAgents: 2, pendingApprovals: 1 });
  assert.equal(file, path.join(root, '.planning', 'HANDOFF.json'));
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.version, 1);
  assert.equal(saved.projectRoot, root);
  assert.equal(saved.activeAgents, 2);
  assert.ok(!Number.isNaN(Date.parse(String(saved.createdAt))));
});

test('redactSecrets removes bearer tokens and key assignments', () => {
  assert.equal(redactSecrets('Authorization: Bearer sk-abc123, retry'), 'Authorization: [REDACTED] [REDACTED], retry');
  assert.equal(redactSecrets('sent Bearer sk-abc123 upstream'), 'sent Bearer [REDACTED] upstream');
  assert.equal(redactSecrets('api_key=sk-live-1; refresh-token: r1 access token=t'), 'api_key=[REDACTED]; refresh-token: [REDACTED] access token=[REDACTED]');
  assert.equal(redactSecrets('HTTP 500 from provider'), 'HTTP 500 from provider');
});

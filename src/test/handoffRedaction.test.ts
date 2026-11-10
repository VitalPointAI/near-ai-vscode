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

test('redactSecrets redacts JSON keys, passwords and secrets, and bare well-known tokens, but leaves prose alone', () => {
  // 0.4.19 review: the key pattern needed the colon right after the name, so JSON was never redacted. secret-scan: allow (fake values)
  assert.equal(redactSecrets('{"apiKey":"abc123"}'), '{"apiKey":"[REDACTED]"}');
  assert.equal(redactSecrets('{"api_key": "sk-test-value", "model": "glm"}'), '{"api_key": "[REDACTED]", "model": "glm"}');
  assert.equal(redactSecrets("password='hunter2' user=bob"), "password='[REDACTED]' user=bob");
  assert.equal(redactSecrets('client_secret=xyz; secret: s3cr3t'), 'client_secret=[REDACTED]; secret: [REDACTED]');
  assert.equal(redactSecrets('{"refresh_token":"r1","access_token":"a1"}'), '{"refresh_token":"[REDACTED]","access_token":"[REDACTED]"}');
  assert.equal(redactSecrets('the key is sk-abcdefghijklmnopqrstuvwxyz0123 now'), 'the key is [REDACTED] now'); // secret-scan: allow
  // Prose that only mentions a secret is not redacted.
  assert.equal(redactSecrets('The password was changed and the secret handshake works.'), 'The password was changed and the secret handshake works.');
  assert.equal(redactSecrets('{"secretary": "Ann", "passwords_checked": 3}'), '{"secretary": "Ann", "passwords_checked": 3}');
  // A prefixed or suffixed name is still the secret: db_password, user-secret, aws_secret_access_key.
  assert.equal(redactSecrets('db_password=hunter2 user-secret: x1 AWS_SECRET_ACCESS_KEY=abc123'), 'db_password=[REDACTED] user-secret: [REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED]'); // secret-scan: allow
  assert.equal(redactSecrets('task-12 and risk-assessment are fine'), 'task-12 and risk-assessment are fine');
});

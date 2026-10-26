import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrivacyPreflight, isWorkspacePath } from '../services/privacyPreflight';

test('blocks secrets and keeps raw values out of previews and audit records', () => {
  const secret = 'Bearer live-secret apiKey=abc123 refresh_token=refresh456';
  const preflight = new PrivacyPreflight();
  const result = preflight.preflight({ provider: 'cloud-model', providerBoundary: 'cloud', context: secret, paths: ['src/app.ts'] });
  assert.equal(result.decision.outcome, 'block');
  assert.equal(JSON.stringify(result.audit).includes(secret), false);
  assert.equal(result.preview.context.includes('live-secret'), false);
  assert.deepEqual(result.decision.classifications, ['secret']);
});

test('classifies private paths and scope expansion', () => {
  const result = new PrivacyPreflight().preflight({ provider: 'cloud-model', providerBoundary: 'cloud', paths: ['.env', '../outside.ts', '/tmp/file.ts', '.near-credentials/mainnet/account.json'] });
  assert.equal(result.decision.outcome, 'block');
  assert.equal(result.decision.classifications.includes('privateFile'), true);
  assert.equal(result.decision.classifications.includes('scopeExpansion'), true);
  assert.equal(result.preview.paths.includes('[NEAR CREDENTIAL PATH REDACTED]'), true);
});

test('allows a safe local request and labels the provider boundary', () => {
  const result = new PrivacyPreflight({ mode: 'local-only' }).preflight({ provider: 'ollama', providerBoundary: 'local', paths: ['src/app.ts'], context: 'summarize this function' });
  assert.equal(result.decision.outcome, 'allow');
  assert.ok(result.decision.dispatchToken);
  assert.equal(result.preview.provider, 'ollama');
  assert.equal(result.preview.providerBoundary, 'local');
});

test('local-only blocks cloud inference and network tool actions without a matching override', () => {
  const preflight = new PrivacyPreflight({ mode: 'local-only' });
  const result = preflight.preflight({ provider: 'cloud-model', providerBoundary: 'cloud', capability: 'network', paths: ['src/app.ts'] });
  assert.equal(result.decision.outcome, 'block');
  assert.equal(result.decision.dispatchToken, undefined);
  assert.match(result.decision.reason, /local-only/);
});

test('one-time override is bound to the exact request and consumed once', () => {
  const preflight = new PrivacyPreflight({ mode: 'local-only' });
  const request = { provider: 'cloud-model', providerBoundary: 'cloud' as const, paths: ['src/app.ts'], context: 'safe' };
  const override = preflight.issueOverride(request);
  const first = preflight.preflight(request, override.token);
  const second = preflight.preflight(request, override.token);
  assert.equal(first.decision.outcome, 'allow');
  assert.equal(first.decision.overrideUsed, true);
  assert.equal(second.decision.outcome, 'block');
  assert.equal(second.decision.overrideUsed, false);
  assert.equal(preflight.preflight({ ...request, provider: 'other-cloud' }, override.token).decision.outcome, 'block');
});

test('workspace path helper rejects traversal, absolute paths, missing files, and symlink escapes', () => {
  assert.equal(isWorkspacePath(process.cwd(), '../outside.ts'), false);
  assert.equal(isWorkspacePath(process.cwd(), '/tmp/outside.ts'), false);
  assert.equal(isWorkspacePath(process.cwd(), 'does-not-exist'), false);
  const root = mkdtempSync(join(tmpdir(), 'near-ai-privacy-'));
  const outside = mkdtempSync(join(tmpdir(), 'near-ai-outside-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(outside, 'secret.txt'), 'not a credential');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'linked.txt'));
    assert.equal(isWorkspacePath(root, 'src/linked.txt'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('unknown classifications deny by default and warnings require confirmation', () => {
  const unknown = new PrivacyPreflight().preflight({ provider: 'cloud', providerBoundary: 'cloud' });
  assert.equal(unknown.decision.outcome, 'block');
  const warning = new PrivacyPreflight({ rules: [{ dataClass: 'personalData', mode: 'warn-and-confirm' }] }).preflight({ provider: 'cloud', providerBoundary: 'cloud', context: 'email alice@example.com' });
  assert.equal(warning.decision.outcome, 'warn-and-confirm');
  const malformed = new PrivacyPreflight({ rules: [{ dataClass: 'not-a-real-class' as never, mode: 'allow' }] }).preflight({ provider: 'cloud', providerBoundary: 'cloud' });
  assert.equal(malformed.decision.outcome, 'block');
});


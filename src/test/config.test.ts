import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSettings, isSecureEndpoint, normalizePolicyMode } from '../domain/config';
import { compareVersions } from '../domain/version';

test('default settings use the NEAR AI Cloud endpoint and safe policy', () => {
  const settings = createDefaultSettings();
  assert.equal(settings.baseUrl, 'https://cloud-api.near.ai/v1');
  assert.equal(settings.authMode, 'apiKey');
  assert.equal(settings.actionPolicy.mode, 'approve-risky');
  assert.equal(settings.actionPolicy.emergencyStop, false);
});

test('unknown policy modes fall back to approval-required defaults', () => {
  assert.equal(normalizePolicyMode('unknown'), 'approve-risky');
  assert.equal(normalizePolicyMode('mostly-autonomous'), 'mostly-autonomous');
});

test('auto is a policy mode in the parser and in the actionPolicy setting, and the default is unchanged', async () => {
  assert.equal(normalizePolicyMode('auto'), 'auto');
  assert.equal(normalizePolicyMode('AUTO'), 'approve-risky');
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../../package.json', `file://${__filename}`), 'utf8')) as { contributes: { configuration: Array<{ properties: Record<string, { enum?: string[]; enumDescriptions?: string[]; default?: unknown }> }> | { properties: Record<string, { enum?: string[]; enumDescriptions?: string[]; default?: unknown }> } } };
  const sections = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
  const setting = sections.map((section) => section.properties['nearAi.actionPolicy']).find(Boolean)!;
  assert.deepEqual(setting.enum, ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous']);
  assert.equal(setting.enumDescriptions?.length, setting.enum?.length);
  assert.equal(setting.default, 'approve-risky');
});

test('GSD version comparison handles stable semantic versions', () => {
  assert.equal(compareVersions('1.17.0', '1.18.0'), -1);
  assert.equal(compareVersions('v1.18.0', '1.18.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('secure endpoint check rejects remote plain HTTP', () => {
  assert.equal(isSecureEndpoint('https://cloud-api.near.ai/v1'), true);
  assert.equal(isSecureEndpoint('http://localhost:11434/v1'), true);
  assert.equal(isSecureEndpoint('http://[::1]:8080'), true);
  assert.equal(isSecureEndpoint('http://cloud-api.near.ai/v1'), false);
  assert.equal(isSecureEndpoint('http://localhost.evil.test/v1'), false);
  assert.equal(isSecureEndpoint('not a url'), false);
});

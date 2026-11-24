// Phase 46, plan 03, task 1 (D-06, D-26, D-42; T-46-11, T-46-13): the only addresses a frontend-originated backend request may reach are the
// ones your organization configured, STERLING_OPEN_VSX_URL and the hosts of STERLING_MODEL_SERVERS, as exact scheme://host[:port] patterns;
// with neither set the allow list is empty. A malformed address is refused with one sentence naming the setting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUrlAllowed } from '@theia/core/lib/node/request/backend-request-facade.js';
import { allowedUrlPatterns, readOutboundSettings } from '../extension/src/node/egress.ts';
import { SterlingRequestAllowList } from '../extension/src/node/egress-contribution.ts';

function refusesNaming(call: () => unknown, setting: string): void {
  assert.throws(call, (error: Error) => {
    assert.ok(error.message.startsWith(`${setting} `), `expected a sentence naming ${setting}, got: ${error.message}`);
    return true;
  });
}

test('unset or empty settings give no model servers, no Open VSX address and an empty allow list', () => {
  for (const env of [{}, { STERLING_MODEL_SERVERS: '', STERLING_OPEN_VSX_URL: '' }, { STERLING_MODEL_SERVERS: '  ', STERLING_OPEN_VSX_URL: ' ' }]) {
    const settings = readOutboundSettings(env);
    assert.deepEqual(settings.modelServers, []);
    assert.equal(settings.openVsxUrl, undefined);
    assert.deepEqual(allowedUrlPatterns(settings), []);
  }
});

test('a comma-separated list of model servers gives one exact pattern per host and port', () => {
  const settings = readOutboundSettings({ STERLING_MODEL_SERVERS: 'https://models.example.test/v1, https://other.example.test:8443/v1' });
  assert.deepEqual(settings.modelServers.map(String), ['https://models.example.test/v1', 'https://other.example.test:8443/v1']);
  assert.deepEqual(allowedUrlPatterns(settings), ['https://models.example.test', 'https://other.example.test:8443']);
});

test('http is accepted only to a loopback model server', () => {
  refusesNaming(() => readOutboundSettings({ STERLING_MODEL_SERVERS: 'http://models.example.test' }), 'STERLING_MODEL_SERVERS');
  assert.deepEqual(allowedUrlPatterns(readOutboundSettings({ STERLING_MODEL_SERVERS: 'http://127.0.0.1:11434/v1' })), ['http://127.0.0.1:11434']);
});

test('a model server address with credentials, a query, a fragment, or a relative path is refused', () => {
  for (const value of ['https://user:pass@models.example.test', 'https://models.example.test/?q=1', 'https://models.example.test/#x', '/v1/models', 'models.example.test']) {
    refusesNaming(() => readOutboundSettings({ STERLING_MODEL_SERVERS: value }), 'STERLING_MODEL_SERVERS');
  }
});

test('more than 32 model servers are refused; 32 are accepted', () => {
  const list = (count: number): string => Array.from({ length: count }, (_, index) => `https://m${index}.example.test`).join(',');
  assert.equal(readOutboundSettings({ STERLING_MODEL_SERVERS: list(32) }).modelServers.length, 32);
  refusesNaming(() => readOutboundSettings({ STERLING_MODEL_SERVERS: list(33) }), 'STERLING_MODEL_SERVERS');
});

test('STERLING_OPEN_VSX_URL adds its address; an invalid one is refused naming it', () => {
  const settings = readOutboundSettings({ STERLING_OPEN_VSX_URL: 'https://vsx.example.test', STERLING_MODEL_SERVERS: 'https://models.example.test/v1' });
  assert.equal(settings.openVsxUrl?.href, 'https://vsx.example.test/');
  assert.deepEqual(allowedUrlPatterns(settings), ['https://vsx.example.test', 'https://models.example.test']);
  refusesNaming(() => readOutboundSettings({ STERLING_OPEN_VSX_URL: 'http://vsx.example.test' }), 'STERLING_OPEN_VSX_URL');
  refusesNaming(() => readOutboundSettings({ STERLING_OPEN_VSX_URL: 'https://vsx.example.test,https://other.example.test' }), 'STERLING_OPEN_VSX_URL');
});

test('the same host listed twice gives one pattern, and no pattern ever holds a wildcard', () => {
  const settings = readOutboundSettings({ STERLING_MODEL_SERVERS: 'https://models.example.test/v1,https://models.example.test/v2', STERLING_OPEN_VSX_URL: 'https://models.example.test' });
  assert.deepEqual(allowedUrlPatterns(settings), ['https://models.example.test']);
  refusesNaming(() => readOutboundSettings({ STERLING_MODEL_SERVERS: 'https://*.example.test' }), 'STERLING_MODEL_SERVERS');
});

test('the contribution returns exactly the patterns of the settings it was given, and Theia allows only those', async () => {
  const empty = new SterlingRequestAllowList(readOutboundSettings({}));
  assert.deepEqual(await empty.getAllowedUrlPatterns(), []);
  assert.equal(isUrlAllowed('https://open-vsx.org/api', await empty.getAllowedUrlPatterns()), false);

  const configured = new SterlingRequestAllowList(readOutboundSettings({ STERLING_MODEL_SERVERS: 'https://models.example.test/v1' }));
  const patterns = await configured.getAllowedUrlPatterns();
  assert.deepEqual(patterns, ['https://models.example.test']);
  assert.ok(patterns.every((pattern) => !pattern.includes('*')));
  assert.equal(isUrlAllowed('https://models.example.test/v1/chat', patterns), true);
  assert.equal(isUrlAllowed('https://evil.models.example.test/v1', patterns), false);
  assert.equal(isUrlAllowed('https://models.example.test:8443/v1', patterns), false);
  assert.equal(isUrlAllowed('http://models.example.test/v1', patterns), false);
});

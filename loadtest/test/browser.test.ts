import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliDeps } from '../src/cli.ts';
import { routeFixtureRequest, runJourney } from '../src/browser-journey.mjs';
import { assertFixtureIsolation, claimSample, permitsFixtureRequest, type FixtureIsolation } from '../src/browser.ts';

test('the one-shot sample command requires its exact flags and the fixture marker excludes both ordinary run kinds', async () => {
  let launches = 0;
  const out: string[] = [];
  const timings = { getStartedMs: 21, stepMs: [1, 2, 3, 4], signInMs: 5, profile: 'test', inputs: { activeSample: 1, stageTotal: 1 } } as const;
  const env = { SOVAI_SAMPLE_FIXTURE: '/fixture/fixture.json' };
  const deps: Partial<CliDeps> = {
    write: text => { out.push(text); }, error: text => { out.push(text); }, env,
    kubectl: async () => { assert.fail('should not reach the ordinary load adapter'); },
    sample: async descriptor => {
      assert.equal(descriptor, env.SOVAI_SAMPLE_FIXTURE);
      launches++;
      return timings;
    },
  };
  for (const flags of [[], ['--no-auth'], ['--no-auth', '--once', '--url', 'http://example.invalid']]) {
    assert.equal(await main(['sample', ...flags], deps), 2);
  }
  assert.equal(await main(['sample', '--no-auth', '--once'], { ...deps, env: {} }), 2);
  for (const kind of ['load', 'dry-run'] as const) assert.equal(await main(['run', '--kind', kind], deps), 2);
  assert.equal(launches, 0);
  assert.equal(await main(['sample', '--no-auth', '--once'], deps), 0);
  assert.equal(launches, 1);
  assert.deepEqual(JSON.parse(out.at(-1)!), timings);
});

test('fixture proof refuses changed peer, network, image and ports, and its claim cannot be replayed', () => {
  const facts: FixtureIsolation = {
    rootless: true, host: 'net:[1]', service: 'net:[2]', self: 'net:[2]',
    interfaces: ['lo'], routes: [], listeners: ['127.0.0.1:3000'], published: '',
    networkMode: 'none', platform: 'linux/amd64',
    digest: 'sha256:b36a590c61bd979e6aaa1ce16d6ce34adc2f862a1444d1af9fd8e9cf211a6bb9',
    config: 'd40f068134d3d2047977a5fdc7f864cbbac79151b8d6886a913625b953a19867',
  };
  assert.doesNotThrow(() => assertFixtureIsolation(facts));
  for (const changed of [
    { rootless: false }, { host: facts.self }, { self: facts.host }, { routes: ['default via 192.0.2.1'] },
    { interfaces: ['lo', 'eth0'] }, { published: '3000/tcp -> 0.0.0.0:3000' }, { networkMode: 'host' },
    { listeners: ['0.0.0.0:3000'] }, { digest: 'incorrect' }, { config: 'incorrect' },
  ]) assert.throws(() => assertFixtureIsolation({ ...facts, ...changed }));
  const dir = mkdtempSync(join(tmpdir(), 'loadtest-claim-'));
  claimSample(dir);
  assert.throws(() => claimSample(dir), /already been claimed/);
});

test('browser request scope admits only the exact origins and expected Workbench socket', () => {
  assert.equal(permitsFixtureRequest('http://127.0.0.1:3000/file', 'workbench'), true);
  assert.equal(permitsFixtureRequest('ws://127.0.0.1:3000/services', 'workbench'), true);
  assert.equal(permitsFixtureRequest('http://localhost:3001/', 'passkey'), true);
  for (const address of ['https://127.0.0.1:3000/', 'http://localhost:3000/', 'http://user@127.0.0.1:3000/', 'http://2130706433:3000/', 'http://127.0.0.1:18878/', 'http://example.invalid/']) {
    assert.equal(permitsFixtureRequest(address, 'workbench'), false);
  }
  assert.equal(permitsFixtureRequest('http://127.0.0.1:3000/', 'workbench', true), false);
  assert.equal(permitsFixtureRequest('ws://localhost:3001/', 'passkey'), false);
});


test('the browser identity check happens before any browser connection or navigation', async () => {
  const calls: string[] = [];
  await assert.rejects(runJourney({
    chromium: {
      launchServer: async () => ({
        process: () => ({ pid: 12 }),
        close: async () => { calls.push('closed'); },
      }),
      connect: () => { assert.fail('reached browser control socket without verified identity'); },
    },
    executablePath: '/fixture/approved-chromium',
    verifyBrowser: (pid: number) => {
      assert.equal(pid, 12);
      calls.push('verified');
      throw new Error('wrong Chromium namespace');
    },
  }), /wrong Chromium namespace/);
  assert.deepEqual(calls, ['verified', 'closed']);
});


test('an allowed request can receive a local response but never a redirect', async () => {
  const calls: string[] = [];
  for (const status of [302, 200]) {
    const response = { status: () => status, dispose: async () => { calls.push('disposed'); } };
    await routeFixtureRequest({
      request: () => ({ url: () => 'http://127.0.0.1:3000/', redirectedFrom: () => null }),
      abort: async () => { calls.push('aborted'); },
      fetch: async ({ maxRedirects }: { maxRedirects: number }) => {
        assert.equal(maxRedirects, 0);
        return response;
      },
      fulfill: async ({ response: delivered }: { response: typeof response }) => {
        assert.equal(delivered, response);
        calls.push('delivered');
      },
    }, 'workbench', permitsFixtureRequest);
  }
  assert.deepEqual(calls, ['aborted', 'disposed', 'delivered', 'disposed']);
});

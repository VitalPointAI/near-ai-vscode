import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { main, type CliDeps } from '../src/cli.ts';
import { openWorkbench, routeFixtureRequest, runJourney, saveFixtureEdit, writeFixtureTerminalMarker } from '../src/browser-journey.mjs';
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
  const child = Object.assign(new EventEmitter(), { pid: 12, exitCode: null, signalCode: null });
  await assert.rejects(runJourney({
    chromium: {
      launchServer: async () => ({
        process: () => child,
        close: async () => { calls.push('closed'); child.emit('exit', 0); },
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


test('Get Started elapsed time stops when the welcome view becomes visible', async () => {
  let now = 0;
  const elapsed = await openWorkbench({
    goto: async () => { now += 20; return { status: () => 200 }; },
    locator: (name: string) => {
      assert.equal(name, '.sterling-welcome');
      return { first: () => ({ waitFor: async () => { now += 30; } }) };
    },
    getByRole: () => ({
      waitFor: async () => { now += 200; },
      click: async () => { now += 300; },
    }),
  }, 'http://127.0.0.1:3000', () => now);
  assert.equal(elapsed, 50);
  assert.equal(now, 550);
});

test('the browser save check preserves the fixture newline before the appended activity', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'loadtest-save-'));
  const file = join(folder, 'notes.md');
  const original = '# Fixture notes\n';
  const edit = { file: 'notes.md', text: 'Local synthetic activity' };
  writeFileSync(file, original);
  const element = { click: async () => {}, waitFor: async () => {} };
  const page = {
    locator: () => ({ first: () => element, getByText: () => ({ first: () => element }) }),
    keyboard: {
      press: async () => {},
      insertText: async (text: string) => { writeFileSync(file, original + text); },
    },
  };
  await saveFixtureEdit(page, file, edit);
  assert.equal(readFileSync(file, 'utf8'), '# Fixture notes\n\nLocal synthetic activity');
});

function recordedTerminal(options: {
  newWidgets?: string[];
  selected?: string[];
  initialFocusLost?: boolean;
  focusLostAfterType?: boolean;
  marker?: string;
} = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'loadtest-terminal-'));
  const marker = join(workspace, '.sovai-fixture-terminal-final.ok');
  let widgetIds = ['terminal-1'];
  let focus = 'terminal-1';
  let opened = false;
  const clicked: string[] = [];
  const typed: Array<[string, string]> = [];
  const submitted: Array<[string, string]> = [];
  const evaluate = (fn: (...args: never[]) => unknown, arg: unknown) => runInNewContext(`(${fn.toString()})(arg)`, {
    arg,
    document: {
      activeElement: { owner: focus, matches: (selector: string) => selector === 'textarea.xterm-helper-textarea' },
      querySelectorAll(selector: string) {
        assert.equal(selector, '.terminal-container[id]');
        return widgetIds.map(id => ({ id, contains: (input: { owner: string }) => input.owner === id }));
      },
      getElementById(tabId: string) {
        const id = widgetIds.find(widget => `shell-tab-${widget}` === tabId);
        const selected = opened ? (options.selected ?? ['terminal-2']) : ['terminal-1'];
        return id ? { matches: (selector: string) => selector === '.lm-TabBar-tab.lm-mod-current' && selected.includes(id) } : null;
      },
    },
  });
  const page = {
    evaluate,
    async waitForFunction(fn: (...args: never[]) => unknown, arg: unknown) {
      const result = evaluate(fn, arg);
      if (!result) throw new Error('raw fixture DOM diagnostics');
      return { jsonValue: async () => result, dispose: async () => {} };
    },
    locator(selector: string) {
      const click = async () => {
        if (selector === '.lm-MenuBar-itemLabel') return;
        if (selector === '.lm-Menu-itemLabel') {
          opened = true;
          widgetIds = [...widgetIds, ...(options.newWidgets ?? ['terminal-2'])];
          return;
        }
        const id = selector === '.xterm:visible' ? widgetIds[0] : /^\.terminal-container\[id="(terminal-\d+)"\] \.xterm$/.exec(selector)?.[1];
        assert(id && widgetIds.includes(id));
        clicked.push(id);
        focus = options.initialFocusLost ? 'terminal-1' : id;
      };
      return { click, first: () => ({ click }), getByText: () => ({ first: () => ({ click }) }) };
    },
    keyboard: {
      async type(text: string) {
        typed.push([focus, text]);
        if (options.focusLostAfterType) focus = 'terminal-1';
      },
      async press(key: string) {
        submitted.push([focus, key]);
        writeFileSync(marker, options.marker ?? 'SOVAI_FIXTURE_TERMINAL_OK\n');
      },
    },
  };
  return { page, workspace, marker, clicked, typed, submitted };
}

const terminalSelectionFailure = 'The new synthetic terminal could not be selected';
const terminalFocusFailure = 'The new synthetic terminal did not retain keyboard focus';
const terminalAction = 'echo SOVAI_FIXTURE_TERMINAL_OK > /home/sterling/workspace/.sovai-fixture-terminal-final.ok';

test('the fixed terminal action uses the newly selected and focused terminal once, with a visible older terminal', async () => {
  const f = recordedTerminal();
  await writeFixtureTerminalMarker(f.page, f.workspace);
  assert.deepEqual(f.clicked, ['terminal-2']);
  assert.deepEqual(f.typed, [['terminal-2', terminalAction]]);
  assert.deepEqual(f.submitted, [['terminal-2', 'Enter']]);
  assert.equal(readFileSync(f.marker, 'utf8'), 'SOVAI_FIXTURE_TERMINAL_OK\n');
});

test('terminal selection refuses an older, missing or ambiguous target without keyboard input or raw metadata', async () => {
  for (const state of [
    { selected: ['terminal-1'] }, { newWidgets: [] }, { selected: ['terminal-1', 'terminal-2'] },
    { newWidgets: ['terminal-2', 'terminal-3'] },
  ]) {
    const f = recordedTerminal(state);
    await assert.rejects(writeFixtureTerminalMarker(f.page, f.workspace), { message: terminalSelectionFailure });
    assert.deepEqual([f.clicked, f.typed, f.submitted], [[], [], []]);
  }
});

test('the terminal action refuses sibling focus before typing and refuses submission after focus loss', async () => {
  const beforeTyping = recordedTerminal({ initialFocusLost: true });
  await assert.rejects(writeFixtureTerminalMarker(beforeTyping.page, beforeTyping.workspace), { message: terminalFocusFailure });
  assert.deepEqual([beforeTyping.typed, beforeTyping.submitted], [[], []]);

  const beforeSubmit = recordedTerminal({ focusLostAfterType: true });
  await assert.rejects(writeFixtureTerminalMarker(beforeSubmit.page, beforeSubmit.workspace), { message: terminalFocusFailure });
  assert.deepEqual(beforeSubmit.typed, [['terminal-2', terminalAction]]);
  assert.deepEqual(beforeSubmit.submitted, []);
});

test('the terminal marker remains the success condition and a wrong marker yields one fixed reason', async () => {
  const f = recordedTerminal({ marker: 'raw fixture marker detail' });
  await assert.rejects(writeFixtureTerminalMarker(f.page, f.workspace), { message: 'The fixed synthetic terminal action did not write its marker' });
  assert.deepEqual(f.submitted, [['terminal-2', 'Enter']]);
});

test('a stalled browser command rejects at its deadline, then kills and reaps after the grace period', { timeout: 3000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child, 'spawn');
  const calls: string[] = [];
  const never = new Promise<never>(() => {});
  await assert.rejects(runJourney({
    chromium: {
      launchServer: async () => ({
        process: () => child,
        wsEndpoint: () => 'ws://127.0.0.1:3002/fixture',
        close: () => { calls.push('close'); return never; },
        kill: () => { calls.push('kill'); assert(child.kill('SIGKILL')); return never; },
      }),
      connect: () => { calls.push('connect'); return never; },
    },
    executablePath: '/fixture/approved-chromium',
    verifyBrowser: (pid: number) => assert.equal(pid, child.pid),
  }, 30, 30), /exceeded the fixture deadline/);
  assert.deepEqual(calls, ['connect', 'close', 'kill']);
  assert.equal(child.signalCode, 'SIGKILL');
});

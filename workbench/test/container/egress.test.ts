// Phase 46, plan 03, task 3 (D-02, D-26, D-28; T-46-12): the running image makes no outbound connection outside its allow list. The
// recording hook (test/helpers/outbound-hook.mjs, mounted read-only and loaded with NODE_OPTIONS=--import, which forked children inherit)
// logs every connection attempt. On a docker network with no route out the workbench starts, serves a page, restarts and starts again with
// only loopback attempts logged; in the browser smoke on a bridge network the same holds, and the page makes only same-origin requests. A
// control run shows the hook catches each API, and a planted call shows the check names what it finds. Hygiene as in test/helpers/docker.ts;
// the suite also removes the one network it makes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { containerName, freePort, mustRun, removeOwn, run, runContainer, runPlaywright, suffix, testImage, waitHealthy, workbenchRoot } from '../helpers/docker';

const HOOK = path.join(workbenchRoot, 'test', 'helpers', 'outbound-hook.mjs');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const NETWORK = `sterling-egress-${suffix}`;
let image = '';
let networkMade = false;
const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-egress-'));

/** The docker run arguments that load the hook with a loopback-only allow list and log to /tmp/outbound.log in the container. */
const hooked = (extraImports = ''): string[] => ['-v', `${HOOK}:/test-hook/outbound-hook.mjs:ro`,
  '-e', `NODE_OPTIONS=--import=/test-hook/outbound-hook.mjs${extraImports}`, '-e', 'NEAR_AI_TEST_OUTBOUND_LOG=/tmp/outbound.log',
  '-e', 'NEAR_AI_TEST_OUTBOUND_ALLOW=127.0.0.1,::1,localhost'];

/** The host a logged target names: a path (IPC) is undefined. */
function hostOf(kind: string, target: string): string | undefined {
  if (target.startsWith('path:')) return undefined;
  if (kind === 'fetch') {
    try {
      const url = new URL(target);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/g, '') : undefined;
    } catch {
      return target;
    }
  }
  if (kind === 'dns' || kind === 'udp') return target;
  const bracketed = /^\[([^\]]+)\]:/.exec(target);
  return bracketed ? bracketed[1] : target.replace(/:[^:]*$/, '');
}

/** Every log line that is refused, or allowed to something other than loopback or a path. */
function outsideAllowList(lines: string[]): string[] {
  return lines.filter((line) => {
    const [verdict, kind, ...rest] = line.split(' ');
    if (verdict === 'refused') return true;
    const host = hostOf(kind, rest.join(' '));
    return host !== undefined && !LOOPBACK.has(host);
  });
}

function assertNoOutbound(lines: string[], when: string): void {
  const found = outsideAllowList(lines);
  assert.deepEqual(found, [], `outbound attempts outside the allow list ${when}:\n${found.join('\n')}`);
}

async function copiedLog(name: string): Promise<string[]> {
  const file = path.join(scratch, `${name}.log`);
  const copied = await run('docker', ['cp', `${containerName(name)}:/tmp/outbound.log`, file]);
  if (copied.code !== 0) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

async function healthyInside(name: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while ((await run('docker', ['exec', containerName(name), 'node', '/app/bin/healthcheck.mjs'])).code !== 0) {
    if (Date.now() > deadline) {
      const logs = await run('docker', ['logs', containerName(name)]);
      assert.fail(`the workbench did not become healthy within ${ms / 1000} s\n${logs.stdout.slice(-3000)}\n${logs.stderr.slice(-3000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  image = await testImage();
});

after(async () => {
  await removeOwn();
  if (networkMade) await run('docker', ['network', 'rm', NETWORK]);
  rmSync(scratch, { recursive: true, force: true });
});

test('control: the hook refuses dns, fetch, net, tls and udp outside the allow list and lets an allowed local server through', async () => {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const script = path.join(scratch, 'control.mjs');
  const log = path.join(scratch, 'control.log');
  writeFileSync(script, `import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
process.on('uncaughtException', () => undefined);
const tries = [
  () => fetch('http://127.0.0.1:${port}/').then((r) => r.text()),
  () => new Promise((resolve) => dns.lookup('example.invalid', () => resolve())),
  () => fetch('https://example.invalid/'),
  () => net.connect(443, '203.0.113.1'),
  () => tls.connect(443, 'example.invalid'),
  () => dgram.createSocket('udp4'),
];
for (const attempt of tries) {
  try { await attempt(); } catch {}
}
`);
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--import=${pathToFileURL(HOOK).href}`, NEAR_AI_TEST_OUTBOUND_LOG: log, NEAR_AI_TEST_OUTBOUND_ALLOW: '127.0.0.1' },
    stdio: 'ignore',
  });
  await new Promise((resolve) => child.on('close', resolve));
  server.close();
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  for (const expected of ['refused dns example.invalid', 'refused fetch https://example.invalid/', 'refused net 203.0.113.1:443',
    'refused tls example.invalid:443', 'refused udp udp4', `allowed net 127.0.0.1:${port}`]) {
    assert.ok(lines.includes(expected), `the control logged "${expected}":\n${lines.join('\n')}`);
  }
});

test('a planted outbound call at start is caught and named by the check', async () => {
  // Run the image's node with the hook and one extra start-up import that calls out; the planted code lives only in this test run.
  const result = await runContainer('planted', ['--entrypoint', 'sh', ...hooked(" --import=data:text/javascript,fetch('https://example.invalid/').catch(()=>{})"),
    image, '-c', 'node -e "setTimeout(() => {}, 500)"']);
  assert.equal(result.code, 0, result.stderr);
  const lines = await copiedLog('planted');
  assert.ok(lines.includes('refused fetch https://example.invalid/'), `the planted call was logged:\n${lines.join('\n')}`);
  assert.throws(() => assertNoOutbound(lines, 'in the planted run'), /example\.invalid/);
});

test('on a network with no route out the workbench starts, serves a page, restarts and starts again with only loopback attempts', async () => {
  await mustRun('docker', ['network', 'create', '--internal', NETWORK]);
  networkMade = true;
  const name = 'internal';
  const started = await runContainer(name, ['-d', '--network', NETWORK, ...hooked(),
    '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept', image]);
  assert.equal(started.code, 0, started.stderr);
  await healthyInside(name);
  const page = await mustRun('docker', ['exec', containerName(name), 'node', '-e',
    "require('http').get('http://127.0.0.1:3000/', (r) => { r.resume(); r.on('end', () => console.log(r.statusCode)); })"]);
  assert.equal(page.stdout.trim(), '200');
  await pause(20_000);
  await mustRun('docker', ['restart', '-t', '10', containerName(name)]);
  await healthyInside(name);
  await pause(20_000);
  const lines = await copiedLog(name);
  assert.ok(lines.some((line) => line.startsWith('allowed ')), 'the hook was loaded and logged the loopback calls');
  assertNoOutbound(lines, 'at start and restart on an internal network');
});

test('in the browser smoke the backend calls out to nothing and the page makes only same-origin requests', async () => {
  const name = 'browser';
  const port = await freePort();
  const started = await runContainer(name, ['-d', '-p', `127.0.0.1:${port}:3000`, ...hooked(),
    '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept', image]);
  assert.equal(started.code, 0, started.stderr);
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy(name, url);
  const result = await runPlaywright('egress.spec.ts', { WORKBENCH_URL: url });
  assert.equal(result.code, 0, `Playwright failed:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  assert.match(result.stdout, /\b1 passed\b/);
  assertNoOutbound(await copiedLog(name), 'during the browser smoke');
});

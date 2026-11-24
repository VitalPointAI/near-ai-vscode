// Phase 46, plan 01 (D-12, D-13, D-30, D-34): the D-34 evidence on the real image. The workbench image, on UBI 9 minimal with the upstream
// Node 26 binary, loads its native addons (drivelist, and node-pty running a shell), carries no build tools, refuses an unguarded local bind,
// and serves Get Started to a real browser. Run it with `npm run test:container`; it is not part of `npm test`. Hygiene: test/helpers/docker.ts.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { freePort, mustRun, removeOwn, runContainer, runPlaywright, testImage, waitHealthy } from '../helpers/docker';

const MARKER = 'STERLING-PTY-OK';
// Run inside the image with node from /app: the natives as the backend's own node_modules have them, and the Node it runs on.
const NATIVE_CHECK = `
const drivelist = require('drivelist');
if (typeof drivelist.list !== 'function') throw new Error('drivelist has no list()');
const pty = require('node-pty');
const shell = pty.spawn('/bin/sh', ['-c', 'echo ${MARKER}-$((40 + 2))'], {});
let output = '';
shell.onData((data) => { output += data; });
shell.onExit(() => { console.log(output.trim()); console.log('node=' + process.version); });
`;

let image = '';

before(async () => {
  image = await testImage();
});

after(async () => {
  await removeOwn();
});

test('the image loads drivelist and runs a shell through node-pty on Node 26 (D-34)', async () => {
  const result = await runContainer('natives', ['--rm', '--entrypoint', 'node', '-w', '/app', image, '-e', NATIVE_CHECK]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`${MARKER}-42`));
  assert.match(result.stdout, /node=v26\.\d+\.\d+/);
});

test('the image runs as 10001:0 and its runtime tree carries no build or browser tooling (D-12, D-30)', async () => {
  const user = await mustRun('docker', ['image', 'inspect', '--format', '{{.Config.User}}', image]);
  assert.equal(user.stdout.trim(), '10001:0');
  const listing = await runContainer('tree', ['--rm', '--entrypoint', 'sh', image, '-c',
    'for p in @theia/cli esbuild puppeteer playwright playwright-core @playwright/test; do test -e "/app/node_modules/$p" && echo "present:$p"; done; ' +
    'test -w /app && echo "writable:/app"; test -w /home/sterling/workspace || echo "not-writable:workspace"; ' +
    'command -v npm npx 2>/dev/null; true']);
  assert.equal(listing.code, 0, listing.stderr);
  assert.equal(listing.stdout.trim(), '', `unexpected in the runtime image:\n${listing.stdout}`);
});

test('in local mode a non-loopback bind refuses to start without STERLING_PREVIEW_NO_SIGN_IN=accept (D-12)', async () => {
  const result = await runContainer('guard', ['--rm', '-e', 'STERLING_LISTEN_HOST=0.0.0.0', image]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no sign-in and includes a terminal/);
  assert.match(result.stderr, /Publish it on 127\.0\.0\.1 only/);
});

test('a real browser opens Get Started and sees the parser\'s own refusal through the Team preview (D-16, D-34, FND-T-07)', async () => {
  const port = await freePort();
  const started = await runContainer('browser', ['-d', '-p', `127.0.0.1:${port}:3000`,
    '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept', image]);
  assert.equal(started.code, 0, started.stderr);
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy('browser', url);
  const result = await runPlaywright('smoke.spec.ts', { WORKBENCH_URL: url });
  assert.equal(result.code, 0, `Playwright failed:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  assert.match(result.stdout, /\b2 passed\b/);
});

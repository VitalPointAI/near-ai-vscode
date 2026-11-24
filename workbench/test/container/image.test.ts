// Phase 46, plan 03, task 2 (D-12, D-13, D-26, D-30, D-34, D-35, D-39, D-42; T-46-12, T-46-14): the runtime image the Phase 47 contract
// describes. It runs as 10001:0 and can write only its home, its workspace and /tmp; it keeps no package-manager cache; it carries no build or
// browser tooling, no extension gallery and no model provider package; it binds 127.0.0.1 by default and refuses a bad address setting; it
// reports healthy; it runs Node 26, the hub's major; and every FROM line of its Dockerfile is literal and pinned by digest. Hygiene as in
// test/helpers/docker.ts. Run it with `npm run test:container`; it is not part of `npm test`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { containerName, freePort, mustRun, removeOwn, repoRoot, run, runContainer, testImage, workbenchRoot } from '../helpers/docker';

const MODEL_PROVIDERS = ['ai-openai', 'ai-anthropic', 'ai-ollama', 'ai-google', 'ai-hugging-face', 'ai-llamafile', 'ai-vercel-ai', 'ai-copilot'];
const NOT_IN_RUNTIME = ['@theia/cli', 'esbuild', 'puppeteer', '@playwright/test', 'playwright', 'playwright-core', '@types/node', '@theia/vsx-registry',
  ...MODEL_PROVIDERS.map((name) => `@theia/${name}`)];

let image = '';
let inspected: { Config: { User: string; ExposedPorts?: Record<string, unknown>; Healthcheck?: { Test?: string[] }; Env?: string[] } };

before(async () => {
  image = await testImage();
  inspected = JSON.parse((await mustRun('docker', ['image', 'inspect', image])).stdout)[0];
});

after(async () => {
  await removeOwn();
});

/** Runs a shell script in a throwaway container of the image, as the image's user unless `user` is given. */
async function inImage(name: string, script: string, user?: string): Promise<string> {
  const result = await runContainer(name, ['--rm', ...(user ? ['--user', user] : []), '--entrypoint', 'sh', image, '-c', script]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

test('the image runs as 10001:0, exposes 3000, checks its health with bin/healthcheck.mjs and names no default plugin source', () => {
  assert.equal(inspected.Config.User, '10001:0');
  assert.ok(inspected.Config.ExposedPorts && '3000/tcp' in inspected.Config.ExposedPorts, 'EXPOSE 3000');
  assert.ok(inspected.Config.Healthcheck?.Test?.some((part) => part.endsWith('bin/healthcheck.mjs')), 'HEALTHCHECK runs bin/healthcheck.mjs');
  const env = (inspected.Config.Env ?? []).map((line) => line.split('=')[0]);
  assert.ok(!env.includes('THEIA_DEFAULT_PLUGINS') && !env.includes('THEIA_PLUGINS'), 'the development image names no plugin source');
  // The release target (not built here) bundles only the verified VSIX from a local folder.
  const dockerfile = readFileSync(path.join(workbenchRoot, 'Dockerfile'), 'utf8');
  const pluginLines = dockerfile.split('\n').filter((line) => /THEIA_(DEFAULT_)?PLUGINS/.test(line) && /^\s*ENV\b/.test(line));
  assert.deepEqual(pluginLines, ['ENV THEIA_DEFAULT_PLUGINS=local-dir:///plugins']);
});

test('inside the container the user is 10001 and can write the workspace, its home and /tmp, but not /app', async () => {
  const out = await inImage('writable', [
    'id -u',
    'for d in /home/sterling/workspace /home/sterling /tmp; do touch "$d/probe" && echo "wrote:$d"; done',
    'touch /app/probe 2>/dev/null && echo "wrote:/app"; touch /app/node_modules/probe 2>/dev/null && echo "wrote:/app/node_modules"; true',
  ].join('; '));
  assert.deepEqual(out.trim().split('\n'), ['10001', 'wrote:/home/sterling/workspace', 'wrote:/home/sterling', 'wrote:/tmp']);
});

test('no package-manager cache or npm cache is left in the image', async () => {
  const out = await inImage('caches', [
    'for d in /var/cache/dnf /var/cache/yum /var/cache/libdnf5; do test -d "$d" && test -n "$(ls -A "$d")" && echo "not-empty:$d"; done',
    'for d in /root/.npm /home/sterling/.npm; do test -e "$d" && echo "present:$d"; done',
    'true',
  ].join('; '), '0:0');
  assert.equal(out.trim(), '', `left in the image:\n${out}`);
});

test('the runtime tree has no build or browser tooling, no extension gallery and no model provider; telemetry defaults to off', async () => {
  const out = await inImage('contents', [
    `for p in ${NOT_IN_RUNTIME.join(' ')}; do test -e "/app/node_modules/$p" && echo "present:$p"; done`,
    'for p in /app/node_modules/@theia/ai-*; do test -e "$p" && echo "ai:${p#/app/node_modules/}"; done',
    'test -e /app/node_modules/typescript && echo "typescript:$(node -p "Object.keys(require(\'/app/node_modules/opfs-worker/package.json\').peerDependencies ?? {}).join(\',\')")"',
    'grep -Eq \'"telemetry.telemetryLevel": *"off"\' /app/src-gen/frontend/index.js && echo telemetry:off',
    'true',
  ].join('; '));
  const lines = out.trim().split('\n');
  assert.deepEqual(lines.filter((line) => line.startsWith('present:')), [], 'none of these is in the runtime tree');
  const ai = lines.filter((line) => line.startsWith('ai:')).map((line) => line.slice(3));
  for (const name of ai) assert.ok(!MODEL_PROVIDERS.some((provider) => name === `@theia/${provider}`), `${name} is a model provider`);
  console.info(`@theia/ai-* folders in the runtime tree: ${ai.join(', ') || 'none'}`);
  const typescript = lines.find((line) => line.startsWith('typescript:'));
  if (typescript) assert.ok(typescript.split(':')[1].split(',').includes('typescript'), 'typescript is in the runtime tree only as a peer of opfs-worker');
  console.info(`typescript in the runtime tree: ${typescript ? 'yes, a peer of opfs-worker' : 'no'}`);
  assert.ok(lines.includes('telemetry:off'), 'the frontend configuration sets telemetry.telemetryLevel to off');
});

test('by default the workbench is healthy and answers on its own 127.0.0.1:3000, while the published port does not reach it', async () => {
  const port = await freePort();
  const started = await runContainer('loopback', ['-d', '--health-interval=2s', '-p', `127.0.0.1:${port}:3000`, image]);
  assert.equal(started.code, 0, started.stderr);
  const name = containerName('loopback');
  await waitFor(async () => (await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', name])).stdout.trim() === 'healthy', 'healthy');
  const inside = await mustRun('docker', ['exec', name, 'node', '-e',
    "require('http').get('http://127.0.0.1:3000/healthz', (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => console.log(r.statusCode + ' ' + b)); })"]);
  assert.equal(inside.stdout.trim(), '200 ok');
  const outside = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => `answered ${r.status}`, () => 'no answer');
  assert.equal(outside, 'no answer', 'the published port must not reach a loopback-bound workbench');
});

test('with STERLING_LISTEN_HOST=0.0.0.0 and STERLING_PREVIEW_NO_SIGN_IN=accept it serves on the published port', async () => {
  const port = await freePort();
  const started = await runContainer('published', ['-d', '-p', `127.0.0.1:${port}:3000`, '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept', image]);
  assert.equal(started.code, 0, started.stderr);
  await waitFor(async () => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status === 200, () => false), '/healthz on the published port');
});

test('an invalid STERLING_MODEL_SERVERS stops the workbench with one line naming the setting', async () => {
  const result = await runContainer('bad-models', ['--rm', '-e', 'STERLING_MODEL_SERVERS=["http://models.example.test"]', image]);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /STERLING_MODEL_SERVERS/);
});

test('the image runs Node 26, the major in workbench/package.json and hub/package.json engines', async () => {
  const version = await runContainer('node', ['--rm', '--entrypoint', 'node', image, '-p', 'process.versions.node']);
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout.trim(), /^26\./);
  for (const file of [path.join(workbenchRoot, 'package.json'), path.join(repoRoot, 'hub', 'package.json')]) {
    const engines = (JSON.parse(readFileSync(file, 'utf8')) as { engines: { node: string } }).engines.node;
    assert.match(engines, /^>=26\.\d+\.\d+ <27$/, `${path.relative(repoRoot, file)} engines`);
  }
});

test('every FROM line is a declared stage or a literal image pinned by digest, and the runtime stage is UBI 9 minimal', () => {
  const lines = readFileSync(path.join(workbenchRoot, 'Dockerfile'), 'utf8').split('\n').filter((line) => /^FROM\s/i.test(line));
  assert.ok(lines.length > 0);
  const stages = new Set<string>();
  for (const line of lines) {
    const match = /^FROM (\S+)(?: AS (\S+))?$/.exec(line);
    assert.ok(match, `FROM line in the expected form: ${line}`);
    assert.ok(!line.includes('${'), `no build argument in FROM: ${line}`);
    const [, from, stage] = match;
    if (!stages.has(from)) assert.match(from, /^[a-z0-9.-]+(?:\/[a-z0-9._-]+)+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/, `pinned by digest: ${line}`);
    if (stage) stages.add(stage);
  }
  const runtime = lines.find((line) => / AS runtime$/.test(line));
  assert.match(runtime ?? '', /^FROM registry\.access\.redhat\.com\/ubi9\/ubi-minimal:[^@]+@sha256:[0-9a-f]{64} AS runtime$/);
});

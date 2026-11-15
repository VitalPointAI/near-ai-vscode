import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkNodeVersion } from '../../src/nodeVersion';

// Phase 68, plan 07 (RELAY-04, RELAY-02, RELAY-03): builds the relay image from the repository root and proves, on the real image and a
// running Compose project, that it has no shell or package manager, holds no secret, runs hardened (D-13, D-14), answers /healthz on loopback
// (D-12, D-15) and keeps its state through a hard kill (D-07). Run it with `npm run test:container`; it is not part of `npm test`.
//
// Hygiene: the suite makes one image tag, one Compose project and one temporary secrets folder, all named with a random suffix, and removes
// exactly those. It never touches the operator's own near-ai-relay project, its volumes or its relay/secrets files. It never skips: with no
// Docker the suite fails with a plain message.

const SUFFIX = randomBytes(4).toString('hex');
const PROJECT = `near-ai-relay-test-${SUFFIX}`;
const IMAGE = `near-ai-relay:test-${SUFFIX}`;
// Obviously fake; long enough (at least 8 characters) for the redactor to register it, unique per run so a leftover can never match by accident.
const FAKE_SECRET = `fake-teams-secret-${randomBytes(16).toString('hex')}`;
const FAKE_NEEDLE = Buffer.from(FAKE_SECRET);
const FORBIDDEN_TOOLS = new Set(['sh', 'bash', 'dash', 'busybox', 'npm', 'npx', 'apt', 'apt-get', 'dpkg', 'curl', 'wget']);
const SHA256 = /@sha256:[0-9a-f]{64}/;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'relay', 'Dockerfile'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('could not find the repository root (a folder holding relay/Dockerfile) above the test file');
}

const REPO_ROOT = findRepoRoot();
const DOCKERFILE = path.join(REPO_ROOT, 'relay', 'Dockerfile');
const COMPOSE_FILE = path.join(REPO_ROOT, 'relay', 'compose.yaml');
const PLANTED_DIR = path.join(REPO_ROOT, 'relay', 'secrets');
const PLANTED_FILE = path.join(PLANTED_DIR, 'teams_app_secret');

let secretsDir = '';
let hostPort = 0;
let plantedDirCreated = false;
let plantedFileCreated = false;
let imageBuilt = false;
let projectStarted = false;
const createdContainers: string[] = [];

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? REPO_ROOT, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

async function mustRun(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Result> {
  const result = await run(command, args, options);
  assert.equal(result.code, 0, `${command} ${args.join(' ')} exited ${result.code}\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  return result;
}

function composeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('NEAR_AI_RELAY_') && !name.startsWith('RELAY_') && !name.startsWith('COMPOSE_')) env[name] = value;
  }
  return { ...env, NEAR_AI_RELAY_IMAGE: IMAGE, NEAR_AI_RELAY_PUBLISH_PORT: String(hostPort), NEAR_AI_RELAY_SECRETS_DIR: secretsDir, ...extra };
}

function compose(args: string[], extra: Record<string, string> = {}): Promise<Result> {
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], { env: composeEnv(extra) });
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Finds a byte string in a stream of chunks, including when it straddles two of them.
class NeedleScanner {
  found = false;
  private tail: Buffer = Buffer.alloc(0);
  constructor(private readonly needle: Buffer) {}
  push(chunk: Buffer): void {
    const window = Buffer.concat([this.tail, chunk]);
    if (window.includes(this.needle)) this.found = true;
    this.tail = Buffer.from(window.subarray(Math.max(0, window.length - (this.needle.length - 1))));
  }
}

// `docker export` of a created, never started container, listed through `tar -t`; the same bytes are searched for the fake secret.
async function exportContainer(id: string): Promise<{ names: string[]; secretFound: boolean }> {
  const exporter = spawn('docker', ['export', id], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lister = spawn('tar', ['-t'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const scanner = new NeedleScanner(FAKE_NEEDLE);
  let listing = '';
  let exportError = '';
  lister.stdout.on('data', (chunk: Buffer) => { listing += chunk.toString(); });
  exporter.stderr.on('data', (chunk: Buffer) => { exportError += chunk.toString(); });
  exporter.stdout.on('data', (chunk: Buffer) => scanner.push(chunk));
  exporter.stdout.pipe(lister.stdin);
  const [exportCode, tarCode] = await Promise.all([
    new Promise<number | null>((resolve) => exporter.on('close', resolve)),
    new Promise<number | null>((resolve) => lister.on('close', resolve)),
  ]);
  assert.equal(exportCode, 0, `docker export failed: ${exportError}`);
  assert.equal(tarCode, 0, 'tar could not list the exported filesystem');
  return { names: listing.split('\n').filter((line) => line.length > 0), secretFound: scanner.found };
}

function parseLogLines(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // not a relay line
    }
  }
  return events;
}

async function relayLogs(): Promise<{ raw: string; events: Array<Record<string, unknown>> }> {
  const result = await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'logs', '--no-color', '--no-log-prefix', 'relay'], { env: composeEnv() });
  const raw = `${result.stdout}\n${result.stderr}`;
  return { raw, events: parseLogLines(result.stdout) };
}

async function healthz(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${hostPort}/healthz`, { signal: AbortSignal.timeout(3000) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function buildImageRef(): string {
  const first = /^FROM\s+(\S+)/m.exec(readFileSync(DOCKERFILE, 'utf8'));
  assert.ok(first?.[1], 'relay/Dockerfile has no FROM line');
  return first[1];
}

describe('relay container image and Compose project', { timeout: 1_500_000 }, () => {
  before(async () => {
    const dockerVersion = await run('docker', ['version', '--format', '{{.Server.Version}}']).catch(() => undefined);
    assert.ok(dockerVersion && dockerVersion.code === 0, 'Docker is required for the container suite and was not found or is not running (install Docker, then run it again)');
    const composeVersion = await run('docker', ['compose', 'version', '--short']).catch(() => undefined);
    assert.ok(composeVersion && composeVersion.code === 0, 'Docker Compose is required for the container suite and `docker compose` was not found');
    assert.ok(PROJECT.startsWith('near-ai-relay-test-'), 'the test project name must stay clear of the operator project');

    // Plant a fake secret where an operator keeps a real one, so the build proves .dockerignore keeps relay/secrets out of the image.
    // A file that is already there is never touched: the suite stops instead.
    assert.ok(!existsSync(PLANTED_FILE), `${PLANTED_FILE} already exists; the suite will not overwrite it. Move it away and run again`);
    if (!existsSync(PLANTED_DIR)) {
      await mkdir(PLANTED_DIR, { mode: 0o700 });
      plantedDirCreated = true;
    }
    await writeFile(PLANTED_FILE, FAKE_SECRET, { mode: 0o600, flag: 'wx' });
    plantedFileCreated = true;

    // The run-time secret: a temporary folder, the same fake value, mode 0400, owned by the relay's uid through the pinned build image.
    secretsDir = await mkdtemp(path.join(tmpdir(), 'relay-container-secrets-'));
    const secretFile = path.join(secretsDir, 'teams_app_secret');
    await writeFile(secretFile, FAKE_SECRET, { mode: 0o400 });
    await mustRun('docker', [
      'run', '--rm', '--network', 'none', '--memory', '128m', '--user', '0:0', '--entrypoint', 'chown',
      '-v', `${secretsDir}:/secrets`, buildImageRef(), '65532:65532', '/secrets/teams_app_secret',
    ]);

    hostPort = await freePort();
    // BuildKit (docker build) takes no --memory flag; the build's own steps are one npm ci and one tsc.
    const built = await mustRun('docker', ['build', '-f', 'relay/Dockerfile', '-t', IMAGE, REPO_ROOT]);
    imageBuilt = true;
    assert.ok(built.code === 0);
  }, { timeout: 900_000 });

  after(async () => {
    // Only the objects this run made, each by its exact name.
    if (projectStarted || imageBuilt) {
      await run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'down', '-v', '--remove-orphans', '--timeout', '5'], { env: composeEnv() });
    }
    for (const id of createdContainers) await run('docker', ['rm', '-f', id]);
    if (imageBuilt) await run('docker', ['rmi', IMAGE]);
    if (plantedFileCreated) await rm(PLANTED_FILE, { force: true });
    if (plantedDirCreated && (await readdir(PLANTED_DIR).catch(() => ['x'])).length === 0) await rm(PLANTED_DIR, { recursive: true, force: true });
    if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
  }, { timeout: 180_000 });

  test('every Dockerfile FROM is pinned by digest and the final image is distroless Node 26 nonroot', () => {
    const froms = readFileSync(DOCKERFILE, 'utf8').split('\n').filter((line) => /^FROM\s/.test(line));
    assert.equal(froms.length, 2, 'the Dockerfile has exactly two stages');
    for (const line of froms) assert.match(line, /^FROM\s+\S+@sha256:[0-9a-f]{64}(\s+AS\s+\w+)?\s*$/, `unpinned FROM line: ${line}`);
    assert.match(froms[0] as string, /^FROM docker\.io\/library\/node:26\.13\.1-slim@sha256:/);
    assert.match(froms[1] as string, /^FROM gcr\.io\/distroless\/nodejs26-debian13:nonroot@sha256:[0-9a-f]{64}\s*$/);
  });

  test('the .dockerignore is an allow-list that keeps state, secrets, git and planning files out of the build context', () => {
    const lines = readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    assert.equal(lines[0], '*');
    assert.deepEqual(lines.slice(1), ['!relay/package.json', '!relay/package-lock.json', '!relay/.npmrc', '!relay/tsconfig.json', '!relay/scripts', '!relay/src']);
  });

  test('Compose config: read-only root, all capabilities dropped, no-new-privileges, uid 65532, loopback publish, /tmp tmpfs, Teams secret', async () => {
    const config = JSON.parse((await mustRun('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'], { env: composeEnv() })).stdout) as {
      services: Record<string, Record<string, unknown>>;
      secrets: Record<string, { file: string }>;
    };
    const relay = config.services.relay as {
      read_only: boolean;
      cap_drop: string[];
      security_opt: string[];
      user: string;
      ports: Array<{ host_ip: string; target: number; published: string }>;
      tmpfs: string[];
      secrets: Array<Record<string, unknown>>;
      restart: string;
    };
    assert.equal(relay.read_only, true);
    assert.deepEqual(relay.cap_drop, ['ALL']);
    assert.ok(relay.security_opt.includes('no-new-privileges:true'));
    assert.equal(relay.user, '65532:65532');
    assert.equal(relay.ports.length, 1);
    assert.equal(relay.ports[0]?.host_ip, '127.0.0.1');
    assert.equal(relay.ports[0]?.target, 8080);
    assert.ok(relay.tmpfs.some((entry) => entry.startsWith('/tmp')), 'a /tmp tmpfs');
    // Compose ignores uid, gid and mode on file secrets, so the file must not pretend to set them.
    assert.deepEqual(relay.secrets, [{ source: 'teams_app_secret', target: '/run/secrets/teams_app_secret' }]);
    assert.equal(config.secrets.teams_app_secret?.file, path.join(secretsDir, 'teams_app_secret'));
  });

  test('the Signal sidecar is only in profile signal, pinned by tag and digest, and publishes no port', async () => {
    const defaults = (await mustRun('docker', ['compose', '-f', COMPOSE_FILE, 'config', '--services'], { env: composeEnv() })).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(defaults, ['relay']);
    const withSignal = (await mustRun('docker', ['compose', '--profile', 'signal', '-f', COMPOSE_FILE, 'config', '--services'], { env: composeEnv() })).stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(withSignal, ['relay', 'signal']);
    const config = JSON.parse((await mustRun('docker', ['compose', '--profile', 'signal', '-f', COMPOSE_FILE, 'config', '--format', 'json'], { env: composeEnv() })).stdout) as {
      services: Record<string, { image: string; ports?: unknown[]; profiles?: string[] }>;
    };
    const signal = config.services.signal;
    assert.ok(signal);
    assert.match(signal.image, /^docker\.io\/bbernhard\/signal-cli-rest-api:\d+\.\d+@sha256:[0-9a-f]{64}$/);
    assert.ok(!signal.ports || signal.ports.length === 0, 'the sidecar publishes no port');
    assert.deepEqual(signal.profiles, ['signal']);
    assert.match(readFileSync(COMPOSE_FILE, 'utf8'), /2026-12-10/, 'the file records the Phase 75 re-check date');
  });

  test('image: user 65532:65532, no secret-like environment variable, no fake secret in history or settings, Node 26.13.1 or later', async () => {
    const inspected = JSON.parse((await mustRun('docker', ['image', 'inspect', IMAGE])).stdout) as Array<{
      Config: { User: string; Env: string[]; Entrypoint: string[]; Cmd: string[] };
    }>;
    const config = inspected[0]?.Config;
    assert.ok(config);
    assert.equal(config.User, '65532:65532');
    for (const entry of config.Env) {
      const name = entry.slice(0, entry.indexOf('='));
      assert.doesNotMatch(name, /(_SECRET|_TOKEN|_KEY)$/, `image environment variable ${name} looks like a secret`);
      assert.ok(!entry.includes(FAKE_SECRET), 'the fake secret is in the image environment');
    }
    assert.ok(config.Env.includes('RELAY_HOST=0.0.0.0'));
    assert.ok(config.Env.includes('RELAY_PORT=8080'));
    assert.ok(config.Env.includes('RELAY_STATE_DIR=/var/lib/near-ai-relay'));
    assert.deepEqual(config.Entrypoint, ['/nodejs/bin/node']);
    assert.deepEqual(config.Cmd, ['/app/bin.mjs']);
    assert.ok(!JSON.stringify(inspected).includes(FAKE_SECRET), 'the fake secret is somewhere in the image settings');

    const history = (await mustRun('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', IMAGE])).stdout;
    assert.ok(!history.includes(FAKE_SECRET), 'the fake secret is in the image history');

    const version = (await mustRun('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', IMAGE, '-p', 'process.versions.node'])).stdout.trim();
    assert.equal(checkNodeVersion(version), undefined, `the image runs Node ${version}, which the relay refuses; re-pin the distroless digest`);
  });

  test('no shell: running sh in the image fails with "executable file not found"', async () => {
    const result = await run('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', '--entrypoint', 'sh', IMAGE, '-c', 'echo hi']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /executable file not found/);
    assert.ok(!result.stdout.includes('hi'));
  });

  test('exported filesystem: no shell or package manager, only bin.mjs and app.mjs in /app, and no fake secret in any byte', async () => {
    const created = await mustRun('docker', ['create', '--memory', '128m', IMAGE]);
    const id = created.stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/);
    createdContainers.push(id);
    const { names, secretFound } = await exportContainer(id);
    await mustRun('docker', ['rm', '-f', id]);
    createdContainers.splice(createdContainers.indexOf(id), 1);

    assert.ok(names.length > 100, 'the export lists the image files');
    // Files and links only: the base image keeps empty data folders named etc/dpkg and var/lib/dpkg, which are not a package manager.
    const forbidden = names.filter((name) => !name.endsWith('/') && FORBIDDEN_TOOLS.has(path.posix.basename(name)));
    assert.deepEqual(forbidden, [], `shells, package managers or download tools in the image: ${forbidden.join(', ')}`);
    const appEntries = names.filter((name) => name.startsWith('app/') && name !== 'app/').sort();
    assert.deepEqual(appEntries, ['app/app.mjs', 'app/bin.mjs']);
    assert.ok(!names.some((name) => name.includes('teams_app_secret') && !name.startsWith('run/secrets')), 'no secret file name in the image');
    assert.ok(!names.some((name) => name.startsWith('build/') || name.startsWith('state-skel')), 'no build leftovers in the final image');
    assert.equal(secretFound, false, 'the fake secret appears in the exported image bytes');
  });

  test('Compose up: healthy, /healthz on loopback has the five fields, the logs name the secret but never show it', { timeout: 240_000 }, async () => {
    projectStarted = true;
    const up = await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
    assert.equal(up.code, 0, `compose up failed:\n${up.stdout}\n${up.stderr}\n${(await relayLogs().catch(() => ({ raw: 'no logs' }))).raw}`);

    const state = await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'ps', '--format', 'json', 'relay'], { env: composeEnv() });
    const row = JSON.parse(state.stdout.trim().split('\n')[0] as string) as { Health: string; State: string; Service: string };
    assert.equal(row.State, 'running');
    assert.equal(row.Health, 'healthy');
    const services = (await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'ps', '--services'], { env: composeEnv() })).stdout.split('\n').filter(Boolean);
    assert.deepEqual(services, ['relay'], 'the Signal sidecar is not running by default');

    const { status, body } = await healthz();
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['inFlightRuns', 'signal', 'teams', 'uptimeSeconds', 'version']);
    assert.equal(body.teams, 'not-configured');
    assert.equal(body.signal, 'not-configured');
    assert.equal(body.inFlightRuns, 0);
    assert.equal(typeof body.version, 'string');

    const { raw, events } = await relayLogs();
    const listening = events.find((event) => event.event === 'relay.listening');
    assert.ok(listening, 'relay.listening was logged');
    assert.equal(typeof listening.instanceId, 'string');
    const loaded = events.find((event) => event.event === 'secrets.loaded');
    assert.ok(loaded, 'secrets.loaded was logged');
    assert.match(String(loaded.names), /TEAMS_APP_SECRET/);
    assert.ok(!raw.includes(FAKE_SECRET), 'the fake secret appears in the relay log');
  });

  test('running container: read-only root, writable /tmp, no capabilities, no-new-privileges, uid 65532, private state', async () => {
    const script = [
      "const fs = require('node:fs');",
      'const out = {};',
      "try { fs.writeFileSync('/app/probe', 'x'); out.appWrite = 'ok'; } catch (error) { out.appWrite = error.code; }",
      "try { fs.writeFileSync('/tmp/probe', 'x'); fs.unlinkSync('/tmp/probe'); out.tmpWrite = 'ok'; } catch (error) { out.tmpWrite = error.code; }",
      "const status = fs.readFileSync('/proc/self/status', 'utf8');",
      'out.capEff = /^CapEff:\\s*(\\S+)/m.exec(status)[1];',
      'out.noNewPrivs = /^NoNewPrivs:\\s*(\\S+)/m.exec(status)[1];',
      'out.uid = process.getuid();',
      "const dir = '/var/lib/near-ai-relay';",
      'const stat = fs.statSync(dir);',
      'out.dir = { mode: (stat.mode & 0o777).toString(8), uid: stat.uid };',
      "out.files = fs.readdirSync(dir).map((name) => { const s = fs.statSync(dir + '/' + name); return { name, mode: (s.mode & 0o777).toString(8), uid: s.uid }; });",
      'console.log(JSON.stringify(out));',
    ].join('\n');
    const result = await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'exec', '-T', 'relay', '/nodejs/bin/node', '-e', script], { env: composeEnv() });
    const probe = JSON.parse(result.stdout.trim()) as {
      appWrite: string;
      tmpWrite: string;
      capEff: string;
      noNewPrivs: string;
      uid: number;
      dir: { mode: string; uid: number };
      files: Array<{ name: string; mode: string; uid: number }>;
    };
    assert.equal(probe.appWrite, 'EROFS');
    assert.equal(probe.tmpWrite, 'ok');
    assert.match(probe.capEff, /^0+$/);
    assert.equal(probe.noNewPrivs, '1');
    assert.equal(probe.uid, 65532);
    assert.deepEqual(probe.dir, { mode: '700', uid: 65532 });
    const names = probe.files.map((file) => file.name);
    assert.ok(names.includes('relay.db'), 'the database is in the state volume');
    assert.ok(names.includes('log-pseudonym.key'), 'the phone-label key is in the state volume');
    for (const file of probe.files) {
      assert.equal(file.mode, '600', `${file.name} must be mode 0600`);
      assert.equal(file.uid, 65532, `${file.name} must be owned by the relay's user`);
    }
  });

  test('a hard kill of the container keeps the instance id and the relay serves /healthz again', { timeout: 300_000 }, async () => {
    const before = await relayLogs();
    const firstListening = before.events.filter((event) => event.event === 'relay.listening');
    assert.equal(firstListening.length, 1);
    const instanceId = firstListening[0]?.instanceId;
    assert.equal(typeof instanceId, 'string');

    await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'kill', '-s', 'KILL', 'relay'], { env: composeEnv() });
    // The restart policy may bring it back by itself; `up` covers the case where it has not yet.
    const up = await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
    assert.equal(up.code, 0, `compose up after the kill failed:\n${up.stdout}\n${up.stderr}`);

    let listening: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      listening = (await relayLogs()).events.filter((event) => event.event === 'relay.listening');
      if (listening.length >= 2) break;
      await sleep(500);
    }
    assert.ok(listening.length >= 2, 'the relay started again after the kill');
    assert.equal(listening[listening.length - 1]?.instanceId, instanceId, 'the instance id survived the kill');

    let answered = 0;
    for (let attempt = 0; attempt < 40 && answered !== 200; attempt += 1) {
      answered = await healthz().then((reply) => reply.status).catch(() => 0);
      if (answered !== 200) await sleep(500);
    }
    assert.equal(answered, 200);
  });
});

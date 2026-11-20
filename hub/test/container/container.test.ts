import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { generateKeyFile, KEY_PREFIXES } from '../../src/keys';
import { checkNodeVersion } from '../../src/nodeVersion';
import { hubRoot } from '../helpers/hubProcess';
import { makeTlsFixture, tlsGet, type TlsResponse } from '../helpers/tlsFixture';

// Phase 32, plan 17 (D-25, D-26, D-31, MUS-07): builds the hub image from the repository root and proves, on the real image, that it is pinned
// like the relay's, holds only its two files of code and no secret, has no shell or package manager, prints a key line for the operator and
// answers /healthz over TLS 1.3 when given its four secret files. Then, through relay/compose.yaml, that the hub service sits only in profile
// hub, is hardened like the relay, publishes on 127.0.0.1 unless the operator chooses, starts alone with no relay secret, and comes back
// healthy after a hard kill. Run it with `npm run test:container`; it is not part of `npm test`.
//
// Hygiene: the suite makes one image tag, one Compose project, its own containers and temporary folders, all named with one random suffix,
// and removes exactly those. It never touches an operator's own near-ai-relay project, its volumes or its secret files: a planted file that is already there stops
// the suite instead of being overwritten. It never skips: with no Docker the suite fails with a plain message.

const SUFFIX = randomBytes(4).toString('hex');
const IMAGE = `near-ai-hub:test-${SUFFIX}`;
const RUN_CONTAINER = `near-ai-hub-test-${SUFFIX}-run`;
const PROJECT = `near-ai-hub-test-${SUFFIX}`;
// Test-only key lines, made fresh for each run so a leftover can never match by accident. The signing line is also planted where an operator
// keeps the real one (relay/secrets/hub/), so the build proves .dockerignore keeps it out of the image.
const SIGNING_LINE = generateKeyFile('signing');
const ENCRYPTION_LINE = generateKeyFile('encryption');
const seedOf = (line: string): string => line.slice(line.lastIndexOf(':') + 1);
const SIGNING_SEED = seedOf(SIGNING_LINE);
const ENCRYPTION_SEED = seedOf(ENCRYPTION_LINE);
const PLANTED_NEEDLE = Buffer.from(SIGNING_SEED);
const FORBIDDEN_TOOLS = new Set(['sh', 'bash', 'dash', 'busybox', 'npm', 'npx', 'apt', 'apt-get', 'dpkg', 'curl', 'wget']);
const SECRET_FILES = ['hub_tls_cert', 'hub_tls_key', 'hub_signing_key', 'hub_encryption_key'] as const;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

const HUB_ROOT = hubRoot();
const REPO_ROOT = path.dirname(HUB_ROOT);
const DOCKERFILE = path.join(HUB_ROOT, 'Dockerfile');
const RELAY_DOCKERFILE = path.join(REPO_ROOT, 'relay', 'Dockerfile');
const PLANTED_PARENT = path.join(REPO_ROOT, 'relay', 'secrets');
const PLANTED_DIR = path.join(PLANTED_PARENT, 'hub');
const PLANTED_FILE = path.join(PLANTED_DIR, 'hub_signing_key');
const COMPOSE_FILE = path.join(REPO_ROOT, 'relay', 'compose.yaml');

let secretsDir = '';
// An empty folder given as the relay's secrets folder, so a hub started from Compose proves it needs no relay secret (D-25).
let emptyRelaySecretsDir = '';
let hostPort = 0;
let projectStarted = false;
let tlsKeyBody: string[] = [];
let imageBuilt = false;
let plantedFileCreated = false;
const createdDirs: string[] = [];
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

const PORT_TAKEN = /port is already allocated|address already in use/i;

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

// `docker export` of a created, never started container, listed through `tar -t`; the same bytes are searched for the planted key.
async function exportContainer(id: string): Promise<{ names: string[]; secretFound: boolean }> {
  const exporter = spawn('docker', ['export', id], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lister = spawn('tar', ['-t'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const scanner = new NeedleScanner(PLANTED_NEEDLE);
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

/** Every key value the hub was given: the two seeds and each line of the TLS key's body. None may ever appear in a log. */
function secretValues(): string[] {
  return [SIGNING_SEED, ENCRYPTION_SEED, ...tlsKeyBody];
}

function assertNoSecretIn(text: string, where: string): void {
  for (const value of secretValues()) assert.ok(!text.includes(value), `a secret value appears in ${where}`);
}

function fromLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => /^FROM\s/.test(line));
}

const imageRef = (line: string): string => (/^FROM\s+(\S+)/.exec(line) as RegExpExecArray)[1] as string;

function buildImageRef(): string {
  const first = fromLines(DOCKERFILE)[0];
  assert.ok(first, 'hub/Dockerfile has no FROM line');
  return imageRef(first);
}

/** GET /healthz on the loopback port, retried until it answers 200 or the time is up. */
async function healthzWithin(port: number, ms: number): Promise<TlsResponse> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const reply = await tlsGet(port, '/healthz', { signal: AbortSignal.timeout(3000) });
      if (reply.status === 200) return reply;
      last = `status ${reply.status}`;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) assert.fail(`no 200 from /healthz on 127.0.0.1:${port} within ${ms} ms (last: ${String(last)})`);
    await sleep(500);
  }
}

/** The volume flags that mount each secret file read-only at /run/secrets/<name>, where the hub's secret loader looks. */
function secretMounts(): string[] {
  return SECRET_FILES.flatMap((name) => ['-v', `${path.join(secretsDir, name)}:/run/secrets/${name}:ro`]);
}

/**
 * The environment for every Compose call: the operator's own NEAR_AI_RELAY_, NEAR_AI_HUB_, RELAY_, HUB_ and COMPOSE_ settings are dropped, then
 * this run's image, port and secret folders are set. `omit` leaves a variable out after that, to see Compose's own default.
 */
function composeEnv(extra: Record<string, string> = {}, omit: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(NEAR_AI_RELAY_|NEAR_AI_HUB_|RELAY_|HUB_|COMPOSE_)/.test(name)) env[name] = value;
  }
  const result: NodeJS.ProcessEnv = {
    ...env,
    NEAR_AI_HUB_IMAGE: IMAGE,
    NEAR_AI_HUB_PUBLISH_PORT: String(hostPort),
    NEAR_AI_HUB_SECRETS_DIR: secretsDir,
    NEAR_AI_RELAY_SECRETS_DIR: emptyRelaySecretsDir,
    ...extra,
  };
  for (const name of omit) delete result[name];
  return result;
}

function compose(args: string[], extra: Record<string, string> = {}): Promise<Result> {
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', ...args], { env: composeEnv(extra) });
}

async function services(profiles: readonly string[]): Promise<string[]> {
  const flags = profiles.flatMap((profile) => ['--profile', profile]);
  const result = await mustRun('docker', ['compose', '-f', COMPOSE_FILE, ...flags, 'config', '--services'], { env: composeEnv() });
  return result.stdout.split('\n').filter(Boolean).sort();
}

interface ComposeService {
  profiles?: string[];
  image?: string;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  pids_limit?: number;
  mem_limit?: string | number;
  tmpfs?: string[];
  ports?: Array<{ host_ip?: string; target: number; published: string; protocol?: string }>;
  volumes?: Array<{ type: string; source: string; target: string }>;
  secrets?: Array<Record<string, unknown>>;
  environment?: Record<string, string | null>;
  healthcheck?: { test?: string[] };
  depends_on?: unknown;
  restart?: string;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  secrets: Record<string, { file?: string }>;
  volumes: Record<string, unknown>;
}

async function hubConfig(extra: Record<string, string> = {}, omit: readonly string[] = []): Promise<ComposeConfig> {
  const result = await mustRun('docker', ['compose', '-f', COMPOSE_FILE, '--profile', 'hub', 'config', '--format', 'json'], { env: composeEnv(extra, omit) });
  return JSON.parse(result.stdout) as ComposeConfig;
}

/**
 * compose up of the hub alone, retried once on a new port when the published port was taken between freePort() closing its probe and Compose
 * binding it. Any other failure is returned as it is.
 */
async function composeUpHub(): Promise<Result> {
  const args = ['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'hub'];
  const first = await compose(args);
  if (first.code === 0 || !PORT_TAKEN.test(`${first.stdout}\n${first.stderr}`)) return first;
  await compose(['down', '--remove-orphans', '--timeout', '5']); // the project's containers only; the state volume is kept
  hostPort = await freePort();
  return compose(args);
}

async function hubLogs(): Promise<string> {
  const result = await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', 'logs', '--no-color', '--no-log-prefix', 'hub'], { env: composeEnv() });
  return `${result.stdout}\n${result.stderr}`;
}

function logEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // not a hub line
    }
  }
  return events;
}

async function hubHealth(): Promise<string> {
  const state = await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', 'ps', '--format', 'json', 'hub'], { env: composeEnv() });
  const line = state.stdout.trim().split('\n')[0];
  if (!line) return 'absent';
  const row = JSON.parse(line) as { Health: string; State: string };
  return row.State === 'running' ? row.Health : row.State;
}

// 20 minutes, below the hub CI job's 25: a hang is then reported as this suite's timeout, not as a cancelled job.
describe('hub container image and Compose service', { timeout: 1_200_000 }, () => {
  before(async () => {
    const dockerVersion = await run('docker', ['version', '--format', '{{.Server.Version}}']).catch(() => undefined);
    assert.ok(dockerVersion && dockerVersion.code === 0, 'Docker is required for the container suite and was not found or is not running (install Docker, then run it again)');
    const composeVersion = await run('docker', ['compose', 'version', '--short']).catch(() => undefined);
    assert.ok(composeVersion && composeVersion.code === 0, 'Docker Compose is required for the container suite and `docker compose` was not found');
    assert.ok(existsSync(DOCKERFILE), 'hub/Dockerfile is missing');

    // Plant a test key where an operator keeps the real one. A file that is already there is never touched: the suite stops instead.
    assert.ok(!existsSync(PLANTED_FILE), `${PLANTED_FILE} already exists; the suite will not overwrite it. Move it away and run again`);
    for (const dir of [PLANTED_PARENT, PLANTED_DIR]) {
      if (!existsSync(dir)) {
        await mkdir(dir, { mode: 0o700 });
        createdDirs.push(dir);
      }
    }
    await writeFile(PLANTED_FILE, `${SIGNING_LINE}\n`, { mode: 0o600, flag: 'wx' });
    plantedFileCreated = true;

    // The run-time secrets: a temporary folder, a fresh test certificate and the two key lines, mode 0400, owned by the hub's uid through
    // the pinned build image (each file is mounted on its own, so the folder's own mode does not matter).
    secretsDir = await mkdtemp(path.join(tmpdir(), 'hub-container-secrets-'));
    const tls = makeTlsFixture();
    try {
      tlsKeyBody = tls.keyPem.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----'));
      const contents: Record<(typeof SECRET_FILES)[number], string> = {
        hub_tls_cert: tls.certPem,
        hub_tls_key: tls.keyPem,
        hub_signing_key: `${SIGNING_LINE}\n`,
        hub_encryption_key: `${ENCRYPTION_LINE}\n`,
      };
      for (const name of SECRET_FILES) await writeFile(path.join(secretsDir, name), contents[name], { mode: 0o400 });
    } finally {
      tls.cleanup();
    }
    assert.ok(tlsKeyBody.length > 0, 'the test TLS key has body lines to look for');
    await mustRun('docker', [
      'run', '--rm', '--network', 'none', '--memory', '128m', '--user', '0:0', '--entrypoint', 'chown',
      '-v', `${secretsDir}:/secrets`, buildImageRef(), '65532:65532', ...SECRET_FILES.map((name) => `/secrets/${name}`),
    ]);

    emptyRelaySecretsDir = await mkdtemp(path.join(tmpdir(), 'hub-container-no-relay-secrets-'));
    hostPort = await freePort();

    // BuildKit (docker build) takes no --memory flag; the build's own steps are one npm ci, one tsc and one esbuild run.
    await mustRun('docker', ['build', '-f', 'hub/Dockerfile', '-t', IMAGE, REPO_ROOT]);
    imageBuilt = true;
  }, { timeout: 900_000 });

  after(async () => {
    // Only the objects this run made, each by its exact name.
    if (projectStarted) {
      await run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', 'down', '-v', '--remove-orphans', '--timeout', '5'], { env: composeEnv() });
    }
    for (const id of createdContainers) await run('docker', ['rm', '-f', id]);
    if (imageBuilt) await run('docker', ['rmi', IMAGE]);
    if (plantedFileCreated) await rm(PLANTED_FILE, { force: true });
    for (const dir of [...createdDirs].reverse()) {
      if ((await readdir(dir).catch(() => ['x'])).length === 0) await rm(dir, { recursive: true, force: true });
    }
    if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
    if (emptyRelaySecretsDir) await rm(emptyRelaySecretsDir, { recursive: true, force: true });
  }, { timeout: 180_000 });

  test('every Dockerfile FROM is pinned by digest, two stages, the same two images as the relay', () => {
    const froms = fromLines(DOCKERFILE);
    assert.equal(froms.length, 2, 'the Dockerfile has exactly two stages');
    for (const line of froms) assert.match(line, /^FROM\s+\S+@sha256:[0-9a-f]{64}(\s+AS\s+\w+)?\s*$/, `unpinned FROM line: ${line}`);
    assert.match(froms[0] as string, /^FROM docker\.io\/library\/node:26\.13\.1-slim@sha256:[0-9a-f]{64}\s+AS\s+build\s*$/);
    assert.match(froms[1] as string, /^FROM gcr\.io\/distroless\/nodejs26-debian13:nonroot@sha256:[0-9a-f]{64}\s*$/);
    assert.deepEqual(froms.map(imageRef), fromLines(RELAY_DOCKERFILE).map(imageRef), 'the hub uses exactly the relay\'s two pinned images, so one re-pin covers both');
  });

  test('image: user 65532:65532, the hub settings, no secret-like environment variable, Node 26.13.1 or later', async () => {
    const inspected = JSON.parse((await mustRun('docker', ['image', 'inspect', IMAGE])).stdout) as Array<{
      Config: { User: string; Env: string[]; Entrypoint: string[]; Cmd: string[]; ExposedPorts?: Record<string, unknown> };
    }>;
    const config = inspected[0]?.Config;
    assert.ok(config);
    assert.equal(config.User, '65532:65532');
    for (const entry of config.Env) {
      const name = entry.slice(0, entry.indexOf('='));
      assert.doesNotMatch(name, /(_SECRET|_TOKEN|_KEY|_CERT)$/, `image environment variable ${name} looks like a secret`);
    }
    assert.ok(config.Env.includes('HUB_HOST=0.0.0.0'));
    assert.ok(config.Env.includes('HUB_PORT=8443'));
    assert.ok(config.Env.includes('HUB_STATE_DIR=/var/lib/near-ai-hub'));
    assert.deepEqual(Object.keys(config.ExposedPorts ?? {}), ['8443/tcp']);
    assert.deepEqual(config.Entrypoint, ['/nodejs/bin/node']);
    assert.deepEqual(config.Cmd, ['/app/bin.mjs']);
    assertNoSecretIn(JSON.stringify(inspected), 'the image settings');
    assertNoSecretIn((await mustRun('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', IMAGE])).stdout, 'the image history');

    const version = (await mustRun('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', IMAGE, '-p', 'process.versions.node'])).stdout.trim();
    assert.equal(checkNodeVersion(version), undefined, `the image runs Node ${version}, which the hub refuses; re-pin the distroless digest`);
  });

  test('--generate-key signing in the image prints exactly one signing key line and nothing else', async () => {
    const result = await mustRun('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', IMAGE, '/app/bin.mjs', '--generate-key', 'signing']);
    const lines = result.stdout.split('\n');
    assert.equal(lines.length, 2, `one line and its newline, got: ${JSON.stringify(result.stdout)}`);
    assert.equal(lines[1], '');
    assert.ok((lines[0] as string).startsWith(KEY_PREFIXES.signing), 'the line is a hub signing key line');
    assert.match(seedOf(lines[0] as string), /^[A-Za-z0-9_-]{43}$/, 'a 32-byte seed in base64url');
    assert.equal(result.stderr, '');
  });

  test('with its four secret files mounted read-only and the port on 127.0.0.1, the hub answers /healthz over TLS 1.3 with a version', { timeout: 180_000 }, async () => {
    let port = await freePort();
    const start = (): Promise<Result> =>
      run('docker', ['run', '-d', '--name', RUN_CONTAINER, '--memory', '256m', '--pids-limit', '128', '-p', `127.0.0.1:${port}:8443`, ...secretMounts(), IMAGE]);
    createdContainers.push(RUN_CONTAINER);
    let started = await start();
    if (started.code !== 0 && PORT_TAKEN.test(`${started.stdout}\n${started.stderr}`)) {
      // The published port was taken between freePort() closing its probe and Docker binding it: once more on a new port.
      await run('docker', ['rm', '-f', RUN_CONTAINER]);
      port = await freePort();
      started = await start();
    }
    assert.equal(started.code, 0, `docker run failed:\n${started.stdout}\n${started.stderr}`);

    let reply: TlsResponse;
    try {
      reply = await healthzWithin(port, 60_000);
    } catch (error) {
      const logs = await run('docker', ['logs', RUN_CONTAINER]);
      throw new Error(`${(error as Error).message}\nhub logs:\n${logs.stdout}\n${logs.stderr}`);
    }
    assert.equal(reply.protocol, 'TLSv1.3');
    const body = JSON.parse(reply.body) as Record<string, unknown>;
    assert.equal(typeof body.version, 'string');
    assert.ok((body.version as string).length > 0, 'the health answer names the hub version');

    const logs = await mustRun('docker', ['logs', RUN_CONTAINER]);
    const text = `${logs.stdout}\n${logs.stderr}`;
    assert.match(text, /"event":"hub\.listening"/, 'the hub logged hub.listening');
    assertNoSecretIn(text, 'the hub log');
    await mustRun('docker', ['rm', '-f', RUN_CONTAINER]);
    createdContainers.splice(createdContainers.indexOf(RUN_CONTAINER), 1);
  });

  test('no shell: running sh in the image fails with "executable file not found"', async () => {
    const result = await run('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', '--entrypoint', 'sh', IMAGE, '-c', 'echo hi']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /executable file not found/);
    assert.ok(!result.stdout.includes('hi'));
  });

  test('exported filesystem: no shell or package manager, only bin.mjs and app.mjs in /app, and no byte of the planted key', async () => {
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
    assert.ok(!names.some((name) => /hub_(tls|signing|encryption)/.test(name) && !name.startsWith('run/secrets')), 'no secret file name in the image');
    assert.ok(!names.some((name) => name.startsWith('build/') || name.startsWith('state-skel') || name.startsWith('app-skel')), 'no build leftovers in the final image');
    assert.ok(names.includes('var/lib/near-ai-hub/'), 'the empty state directory is in the image');
    assert.equal(secretFound, false, 'the planted key appears in the exported image bytes');
  });

  test('Compose: the hub is only in profile hub; the default and the signal profile leave it out', async () => {
    assert.deepEqual(await services([]), ['relay']);
    assert.deepEqual(await services(['hub']), ['hub', 'relay']);
    assert.ok(!(await services(['signal'])).includes('hub'), 'the signal profile does not start the hub');
  });

  test('Compose config: the hub is hardened like the relay, has its own volume and its four secrets, and publishes 8443 on 127.0.0.1 by default', async () => {
    const config = await hubConfig();
    const hub = config.services.hub;
    assert.ok(hub, 'a hub service');
    assert.deepEqual(hub.profiles, ['hub']);
    assert.equal(hub.image, IMAGE);
    assert.equal(hub.read_only, true);
    assert.deepEqual(hub.cap_drop, ['ALL']);
    assert.ok(hub.security_opt?.includes('no-new-privileges:true'));
    assert.equal(hub.user, '65532:65532');
    assert.ok(typeof hub.pids_limit === 'number' && hub.pids_limit > 0 && hub.pids_limit <= 512, 'a process limit');
    assert.ok(Number(hub.mem_limit) > 0 && Number(hub.mem_limit) <= 2 * 1024 ** 3, 'a memory limit of at most 2 GiB');
    assert.deepEqual(hub.tmpfs?.map((entry) => entry.split(':')[0]), ['/tmp'], 'only /tmp is writable besides the volume');
    assert.deepEqual(
      hub.volumes?.map(({ type, source, target }) => ({ type, source, target })),
      [{ type: 'volume', source: 'hub-state', target: '/var/lib/near-ai-hub' }],
    );
    assert.ok(Object.hasOwn(config.volumes, 'hub-state'), 'the hub-state volume is declared');
    // Compose ignores uid, gid and mode on file secrets, so the file must not pretend to set them.
    assert.deepEqual(hub.secrets, SECRET_FILES.map((name) => ({ source: name, target: `/run/secrets/${name}` })));
    for (const name of SECRET_FILES) assert.equal(config.secrets[name]?.file, path.join(secretsDir, name));
    assert.equal(hub.environment?.HUB_TLS_CERT_FILE, '/run/secrets/hub_tls_cert');
    assert.equal(hub.environment?.HUB_TLS_KEY_FILE, '/run/secrets/hub_tls_key');
    assert.equal(hub.environment?.HUB_SIGNING_KEY_FILE, '/run/secrets/hub_signing_key');
    assert.equal(hub.environment?.HUB_ENCRYPTION_KEY_FILE, '/run/secrets/hub_encryption_key');
    assert.equal(hub.environment?.HUB_STATE_DIR, '/var/lib/near-ai-hub');
    assert.equal(hub.environment?.HUB_PUBLIC_ADDRESS ?? '', '', 'no public address unless the operator sets one');
    assert.deepEqual(hub.healthcheck?.test, ['CMD', '/nodejs/bin/node', '/app/bin.mjs', '--healthcheck']);
    assert.equal(hub.depends_on, undefined, 'the hub does not need the relay');
    assert.equal(hub.ports?.length, 1);
    assert.equal(hub.ports?.[0]?.target, 8443);
    assert.equal(hub.ports?.[0]?.host_ip, '127.0.0.1');
    assert.equal(hub.ports?.[0]?.published, String(hostPort));

    // Neither service holds the other's secrets.
    assert.deepEqual(config.services.relay?.secrets, [{ source: 'teams_app_secret', target: '/run/secrets/teams_app_secret' }]);
    assert.ok(!Object.keys(config.services.relay?.environment ?? {}).some((name) => name.startsWith('HUB_')), 'the relay gets no hub setting');
    assert.equal(config.services.relay?.depends_on, undefined, 'the relay does not need the hub');

    // Compose's own defaults: port 8443 on 127.0.0.1, secrets from relay/secrets/hub.
    const defaults = await hubConfig({}, ['NEAR_AI_HUB_PUBLISH_PORT', 'NEAR_AI_HUB_SECRETS_DIR', 'NEAR_AI_HUB_IMAGE']);
    assert.equal(defaults.services.hub?.ports?.[0]?.published, '8443');
    assert.equal(defaults.services.hub?.ports?.[0]?.host_ip, '127.0.0.1');
    assert.equal(defaults.services.hub?.image, 'near-ai-hub:local');
    assert.equal(defaults.secrets.hub_signing_key?.file, path.join(REPO_ROOT, 'relay', 'secrets', 'hub', 'hub_signing_key'));

    // The operator chooses the interface and the public address.
    const open = await hubConfig({ NEAR_AI_HUB_PUBLISH_ADDRESS: '0.0.0.0', NEAR_AI_HUB_PUBLIC_ADDRESS: 'hub.example.invalid:8443' });
    assert.equal(open.services.hub?.ports?.[0]?.host_ip, '0.0.0.0');
    assert.equal(open.services.hub?.environment?.HUB_PUBLIC_ADDRESS, 'hub.example.invalid:8443');
  });

  test('Compose up of the hub alone, with no relay secret: healthy, /healthz on loopback over TLS 1.3, and no key value in the logs', { timeout: 240_000 }, async () => {
    assert.deepEqual(await readdir(emptyRelaySecretsDir), [], 'the relay secrets folder is empty');
    projectStarted = true;
    const up = await composeUpHub();
    assert.equal(up.code, 0, `compose up failed:\n${up.stdout}\n${up.stderr}\n${await hubLogs().catch(() => 'no logs')}`);

    assert.equal(await hubHealth(), 'healthy');
    const running = (await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', 'ps', '--services'], { env: composeEnv() })).stdout.split('\n').filter(Boolean);
    assert.deepEqual(running, ['hub'], 'only the hub is running; the relay was not started');

    const reply = await healthzWithin(hostPort, 30_000);
    assert.equal(reply.protocol, 'TLSv1.3');
    assert.equal(typeof (JSON.parse(reply.body) as { version?: unknown }).version, 'string');

    const raw = await hubLogs();
    const events = logEvents(raw);
    assert.ok(events.some((event) => event.event === 'hub.listening'), 'hub.listening was logged');
    const loaded = events.find((event) => event.event === 'secrets.loaded');
    assert.ok(loaded, 'secrets.loaded was logged');
    for (const name of ['HUB_TLS_CERT', 'HUB_TLS_KEY', 'HUB_SIGNING_KEY', 'HUB_ENCRYPTION_KEY']) assert.match(String(loaded.names), new RegExp(`\\b${name}\\b`));
    assertNoSecretIn(raw, 'the hub log');
  });

  test('running hub container: read-only root, writable /tmp, no capabilities, no-new-privileges, uid 65532, private state directory', async () => {
    const script = [
      "const fs = require('node:fs');",
      'const out = {};',
      "try { fs.writeFileSync('/app/probe', 'x'); out.appWrite = 'ok'; } catch (error) { out.appWrite = error.code; }",
      "try { fs.writeFileSync('/probe', 'x'); out.rootWrite = 'ok'; } catch (error) { out.rootWrite = error.code; }",
      "try { fs.writeFileSync('/tmp/probe', 'x'); fs.unlinkSync('/tmp/probe'); out.tmpWrite = 'ok'; } catch (error) { out.tmpWrite = error.code; }",
      "const status = fs.readFileSync('/proc/self/status', 'utf8');",
      'out.capEff = /^CapEff:\\s*(\\S+)/m.exec(status)[1];',
      'out.noNewPrivs = /^NoNewPrivs:\\s*(\\S+)/m.exec(status)[1];',
      'out.uid = process.getuid();',
      "const stat = fs.statSync('/var/lib/near-ai-hub');",
      'out.dir = { mode: (stat.mode & 0o777).toString(8), uid: stat.uid };',
      'console.log(JSON.stringify(out));',
    ].join('\n');
    const result = await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', 'exec', '-T', 'hub', '/nodejs/bin/node', '-e', script], { env: composeEnv() });
    const probe = JSON.parse(result.stdout.trim()) as {
      appWrite: string;
      rootWrite: string;
      tmpWrite: string;
      capEff: string;
      noNewPrivs: string;
      uid: number;
      dir: { mode: string; uid: number };
    };
    assert.equal(probe.appWrite, 'EROFS');
    assert.equal(probe.rootWrite, 'EROFS');
    assert.equal(probe.tmpWrite, 'ok');
    assert.match(probe.capEff, /^0+$/);
    assert.equal(probe.noNewPrivs, '1');
    assert.equal(probe.uid, 65532);
    assert.deepEqual(probe.dir, { mode: '700', uid: 65532 });
  });

  test('after a hard kill and compose start the hub is healthy again and answers /healthz', { timeout: 300_000 }, async () => {
    await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', 'kill', '-s', 'KILL', 'hub'], { env: composeEnv() });
    // The restart policy may bring it back by itself; compose start covers the case where it has not.
    await mustRun('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'hub', 'start', 'hub'], { env: composeEnv() });
    let health = '';
    for (let attempt = 0; attempt < 120 && health !== 'healthy'; attempt += 1) {
      health = await hubHealth();
      if (health !== 'healthy') await sleep(500);
    }
    assert.equal(health, 'healthy', `the hub is ${health} after the kill`);
    const listening = logEvents(await hubLogs()).filter((event) => event.event === 'hub.listening');
    assert.ok(listening.length >= 2, 'the hub started again after the kill');
    assert.equal((await healthzWithin(hostPort, 30_000)).status, 200);
    assertNoSecretIn(await hubLogs(), 'the hub log after the restart');
  });
});

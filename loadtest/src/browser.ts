import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { runJourney } from './browser-journey.mjs';
import { loadProfile } from './profile.ts';

const IMAGE_DIGEST = 'sha256:b36a590c61bd979e6aaa1ce16d6ce34adc2f862a1444d1af9fd8e9cf211a6bb9';
const IMAGE_CONFIG = 'd40f068134d3d2047977a5fdc7f864cbbac79151b8d6886a913625b953a19867';
const IMAGE_SOURCE = 'f755813f7cf1d3f62908a165715e65d304fb16fb';
const CHROMIUM_SHA = '41ff61e6e65b8d16b40631f4f094b46ec02f1a0f5375ae477c1d478f1fc2d89d';
const PROFILE_SHA = 'sha256:345ea21f7d79350b414e09b4c797e0827dd3e6a022b01f0e72e940d1d69aee57';
const WORKSPACE_MOUNT = '/home/sterling/workspace';
const NAMESPACE = /^net:\[\d+\]$/;

type Site = 'workbench' | 'passkey';
export const WORKBENCH_ORIGIN = 'http://127.0.0.1:3000';
export const PASSKEY_ORIGIN = 'http://localhost:3001';

export interface LocalSampleTimings {
  readonly getStartedMs: number;
  readonly stepMs: readonly number[];
  readonly signInMs: number;
  readonly profile: string;
  readonly inputs: { readonly activeSample: 1; readonly stageTotal: 1 };
}

export interface FixtureIsolation {
  readonly rootless: boolean;
  readonly host: string;
  readonly service: string;
  readonly self: string;
  readonly interfaces: readonly string[];
  readonly routes: readonly string[];
  readonly listeners: readonly string[];
  readonly published: string;
  readonly networkMode: string;
  readonly platform: string;
  readonly digest: string;
  readonly config: string;
}

export function assertFixtureIsolation(facts: FixtureIsolation): void {
  assert(facts.rootless, 'Requires a rootless user namespace');
  assert(NAMESPACE.test(facts.host) && NAMESPACE.test(facts.service) && facts.service === facts.self
    && facts.host !== facts.self, 'Requires the private network namespace of the fixture service');
  assert.deepEqual(facts.interfaces, ['lo'], 'Only loopback is allowed');
  assert.deepEqual(facts.routes, [], 'Unexpected route in the fixture namespace');
  assert.deepEqual(facts.listeners, ['127.0.0.1:3000'], 'Expected the literal Workbench fixture listener');
  assert(facts.networkMode === 'none' && facts.published === '', 'The fixture must have no network attachment or published port');
  assert(facts.platform === 'linux/amd64' && facts.digest === IMAGE_DIGEST && facts.config === IMAGE_CONFIG,
    'The fixture image does not match the approved release');
}

export function claimSample(dir: string): void {
  try {
    closeSync(openSync(join(dir, 'sample.claim'), 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The fixture sample has already been claimed');
    throw error;
  }
}

export function permitsFixtureRequest(address: string, site: Site, redirected = false): boolean {
  const url = URL.parse(address);
  if (!url || redirected || url.username || url.password) return false;
  const origin = site === 'passkey' ? PASSKEY_ORIGIN : WORKBENCH_ORIGIN;
  const socket = 'ws://127.0.0.1:3000';
  const allowed = url.origin === origin || (site === 'workbench' && url.origin === socket);
  return allowed && (address === url.origin || address.startsWith(`${url.origin}/`));
}

interface Descriptor {
  readonly containerId: string;
  readonly hostNamespace: string;
  readonly chromiumExecutable: string;
}

function readDescriptor(file: string): { readonly dir: string; readonly descriptor: Descriptor } {
  const dir = dirname(file);
  const uid = process.getuid?.();
  const parent = lstatSync(dir);
  const source = lstatSync(file);
  assert(file === realpathSync(file) && basename(file) === 'fixture.json'
    && /^codex-phase4804-local-trial\.[a-z0-9]+$/i.test(basename(dir))
    && parent.isDirectory() && parent.uid === uid && (parent.mode & 0o777) === 0o700
    && source.isFile() && source.uid === uid && (source.mode & 0o777) === 0o600 && source.size <= 1024,
  'Expected a private local fixture descriptor');
  const descriptor = JSON.parse(readFileSync(file, 'utf8')) as Descriptor;
  assert(descriptor && Object.keys(descriptor).length === 3
    && typeof descriptor.containerId === 'string' && /^[0-9a-f]{64}$/.test(descriptor.containerId)
    && typeof descriptor.hostNamespace === 'string' && NAMESPACE.test(descriptor.hostNamespace)
    && typeof descriptor.chromiumExecutable === 'string' && descriptor.chromiumExecutable.startsWith('/'),
  'Invalid local fixture descriptor');
  return { dir, descriptor };
}

const lines = (value: string): string[] => value === '' ? [] : value.split('\n');
const networkOf = (pid: number | 'self'): string => readlinkSync(`/proc/${pid}/ns/net`);
const groupOf = (pid: number | 'self'): string => readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();

function verifyMemoryCap(pid: number | 'self', limit: number): void {
  const group = groupOf(pid);
  assert(/^0::\//.test(group), 'Expected a cgroup v2 fixture scope');
  const path = join('/sys/fs/cgroup', group.slice(3));
  const memory = Number(readFileSync(join(path, 'memory.max'), 'utf8').trim());
  assert(Number.isSafeInteger(memory) && memory > 0 && memory <= limit
    && readFileSync(join(path, 'memory.swap.max'), 'utf8').trim() === '0', 'Expected a capped, zero-swap fixture scope');
}

// Read current kernel and dedicated rootless-store state before loading the browser.
function verifyWorkbench(dir: string, descriptor: Descriptor): { readonly pid: number; readonly workspace: string; readonly facts: FixtureIsolation } {
  const { containerId, hostNamespace } = descriptor;
  const self = networkOf('self');
  const rootless = /^(\s+)?0\s+[1-9]\d*\s+\d+/.test(readFileSync('/proc/self/uid_map', 'utf8'));
  assert(rootless && self !== hostNamespace, 'Expected the private rootless fixture namespace');
  for (const subdir of ['store', 'run', 'tmp', 'workspace']) {
    const path = join(dir, subdir);
    assert(lstatSync(path).isDirectory() && realpathSync(path) === path, 'Expected dedicated fixture storage');
  }
  const command = (file: string, args: string[]): string => execFileSync(file, args, {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const podman = (...args: string[]): string => command('/usr/bin/podman', [
    '--remote=false', '--root', join(dir, 'store'), '--runroot', join(dir, 'run'), '--tmpdir', join(dir, 'tmp'),
    '--storage-driver', 'vfs', '--cgroup-manager', 'systemd', ...args,
  ]);
  const container = JSON.parse(podman('container', 'inspect', '--format', '{{json .}}', containerId)) as {
    Id: string; Name: string; Image: string; State: { Running: boolean; Pid: number };
    HostConfig: { NetworkMode: string };
    Mounts: Array<{ Source: string; Destination: string; RW: boolean; Type: string }>;
  };
  const suffix = basename(dir).split('.').at(-1);
  assert(container.Id === containerId && container.Name === `codex-phase4804-v041-${suffix}`
    && container.State.Running && Number.isSafeInteger(container.State.Pid) && container.State.Pid > 1
    && container.Image === IMAGE_CONFIG, 'Unexpected Workbench fixture container');
  const workspace = join(dir, 'workspace');
  assert(container.Mounts.length === 1 && container.Mounts[0].Source === workspace
    && container.Mounts[0].Destination === WORKSPACE_MOUNT && container.Mounts[0].RW === true
    && container.Mounts[0].Type === 'bind', 'Expected only the private synthetic workspace mount');

  const pid = container.State.Pid;
  const ip = (...args: string[]): string[] => lines(command('/usr/sbin/ip', args));
  const sockets = lines(command('/usr/bin/ss', ['-Hlnpt', 'sport = :3000']));
  const image = podman('image', 'inspect', '--format', [
    '{{.Digest}}', '{{.Id}}', '{{.Os}}/{{.Architecture}}', '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    '{{.Config.User}}', '{{json .Config.Entrypoint}}',
  ].join(' '), IMAGE_CONFIG);
  const [digest, config, platform, source, user, entrypoint] = image.split(' ');
  assert(source === IMAGE_SOURCE && user === '10001:0' && entrypoint === '["node","/app/bin/start.mjs"]',
    'Unexpected approved Workbench image metadata');
  const facts = {
    rootless, host: hostNamespace, self, service: networkOf(pid), digest, config, platform,
    networkMode: container.HostConfig.NetworkMode, published: podman('port', containerId),
    interfaces: ip('-o', 'link', 'show').map(line => line.split(': ')[1]),
    routes: [
      ...ip('-4', 'route', 'show'),
      ...ip('-6', 'route', 'show').filter(route => !/^::1 dev lo(?: |$)/.test(route)),
    ],
    listeners: sockets.map(line => line.includes(`pid=${pid},`) ? line.split(/\s+/)[3] : ''),
  };
  assertFixtureIsolation(facts);
  verifyMemoryCap(pid, 2 * 1024 ** 3);
  verifyMemoryCap('self', 4 * 1024 ** 3);
  return { pid, workspace, facts };
}

export async function runLocalSample(repoRoot: string, path: string): Promise<LocalSampleTimings> {
  const { dir, descriptor } = readDescriptor(path);
  const { facts, pid, workspace } = verifyWorkbench(dir, descriptor);
  const localhost = await lookup('localhost', { all: true });
  assert(localhost.some(({ address }) => address === '127.0.0.1')
    && localhost.every(({ address }) => address === '127.0.0.1' || address === '::1'),
  'Expected the standalone passkey hostname to resolve only to loopback');
  const executablePath = descriptor.chromiumExecutable;
  assert(realpathSync(executablePath) === executablePath
    && createHash('sha256').update(readFileSync(executablePath)).digest('hex') === CHROMIUM_SHA,
  'Expected the approved Chromium 1254 executable');
  const profile = loadProfile(join(repoRoot, 'loadtest/profiles/activity-v1.json'));
  assert.equal(profile.sha256, PROFILE_SHA);
  for (const file of profile.steps[0].files) {
    const target = join(workspace, file);
    assert(lstatSync(target).isFile() && readFileSync(target, 'utf8') === `# Fixture ${file.slice(0, -3)}\n`,
      'Expected unused synthetic workspace documents');
  }
  const requireTool = createRequire(join(repoRoot, 'workbench/package.json'));
  assert.equal(requireTool('playwright/package.json').version, '1.65.0');
  assert.equal(requireTool('playwright-core/package.json').version, '1.65.0');
  claimSample(dir);
  const { chromium } = requireTool('playwright');
  const timings = await runJourney({
    chromium, executablePath, workspace, profile, permitsFixtureRequest,
    workbenchOrigin: WORKBENCH_ORIGIN, passkeyOrigin: PASSKEY_ORIGIN,
    verifyBrowser: (browserPid: number) => {
      assert.equal(networkOf(browserPid), facts.service, 'Chromium must share the Workbench network namespace');
      assert.equal(networkOf(pid), facts.service, 'Workbench network namespace changed');
      assert.equal(groupOf(browserPid), groupOf('self'), 'Chromium must inherit the fixture resource cap');
      assert.equal(realpathSync(`/proc/${browserPid}/exe`), executablePath, 'Unexpected Chromium executable');
    },
  });
  return { ...timings, profile: profile.sha256, inputs: { activeSample: 1, stageTotal: 1 } };
}

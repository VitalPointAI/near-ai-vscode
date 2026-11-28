#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { stat, statfs } from 'node:fs/promises';
import { get } from 'node:http';
import { basename, isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';

const socket = '/var/run/docker.sock';
const dockerHost = `unix://${socket}`;
const imagePattern = /^ghcr\.io\/vitalpointai\/near-ai-vscode@sha256:[a-f0-9]{64}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const containerIdPattern = /^[a-f0-9]{64}$/;
const containerName = 'sterling-local-workbench';
const volumeName = 'sterling-local-workspace';
const owner = 'com.vitalpointai.sterling.launcher';
const ownerValue = 'local-workbench-v1';
const release = 'com.vitalpointai.sterling.release';
const workspace = '/home/sterling/workspace';
const publishedPort = '3000/tcp';
const previewEnv = ['STERLING_LISTEN_HOST=0.0.0.0', 'STERLING_PREVIEW_NO_SIGN_IN=accept'];
// Explicit values prevent Docker CLI configuration from injecting proxy credentials into the preview.
const runtimeEnv = [...previewEnv, ...['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'FTP_PROXY']
  .flatMap((name) => [`${name}=`, `${name.toLowerCase()}=`])];
const releaseSettings = {
  User: '10001:0',
  Entrypoint: ['node', '/app/bin/start.mjs'],
  Cmd: ['--session-preference', 'nearAi.autoInstallGsd=false'],
};
const usage = 'Usage: node scripts/launch-local-workbench.mjs --image ghcr.io/vitalpointai/near-ai-vscode@sha256:<digest> [--repair]\n'
  + '       node scripts/launch-local-workbench.mjs --check\n'
  + 'Requires Linux x86-64 or ARM64, Node 26.13.1 or later within Node 26, and a local Docker Engine 28.0.0 or later.\n'
  + 'If your shell reports that node was not found, install a supported Node version first.';

function version(value) {
  const parts = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!parts) return undefined;
  const numbers = parts.slice(1).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : undefined;
}

function usableReleaseConfig(config) {
  return Object.entries(releaseSettings).every(([key, value]) => isDeepStrictEqual(config?.[key], value));
}

function portOf(ports, isConfiguration = false) {
  const entries = ports?.[publishedPort];
  if (Object.keys(ports ?? {}).length !== 1 || !Array.isArray(entries) || entries.length !== 1) return undefined;
  if (entries[0]?.HostIp !== '127.0.0.1') return undefined;
  const port = entries[0].HostPort;
  if (isConfiguration && (port === '' || port === '0')) return port;
  return typeof port === 'string' && /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535 ? port : undefined;
}

function validateVolume(volume) {
  if (volume.Name !== volumeName || volume.Labels?.[owner] !== ownerValue ||
      volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length > 0) {
    throw new Error('The workspace volume name is in use by an unrelated or incompatible volume.');
  }
}

function hasDefaultHostAuthority(config) {
  if (config?.Privileged !== false) return false;
  const empty = (value) => value == null || (Array.isArray(value) && value.length === 0);
  const defaultMode = (value) => value == null || value === '';
  const lists = ['Binds', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'CapAdd', 'SecurityOpt', 'GroupAdd', 'VolumesFrom'];
  const modes = ['PidMode', 'UTSMode', 'UsernsMode'];
  const configuredMounts = config.Mounts;
  const mount = configuredMounts?.[0];
  const expectedMount = empty(configuredMounts) ||
    (Array.isArray(configuredMounts) && configuredMounts.length === 1 && mount?.Type === 'volume' &&
      mount.Source === volumeName && mount.Target === workspace && mount.ReadOnly !== true);
  return lists.every((key) => empty(config[key])) && modes.every((key) => defaultMode(config[key])) &&
    (defaultMode(config.IpcMode) || config.IpcMode === 'private') && expectedMount;
}

function validateContainer(container, image, installed) {
  const { Id, Name, Image, Config, Mounts, State, HostConfig, NetworkSettings } = container;
  const mount = Mounts?.[0];
  const running = State?.Running === true && State.Status === 'running';
  const stopped = State?.Running === false && ['created', 'exited'].includes(State.Status);
  const networks = Object.keys(NetworkSettings?.Networks ?? {});
  const mode = HostConfig?.NetworkMode;
  const env = Config?.Env;
  const hasPreviewSettings = Array.isArray(env) && runtimeEnv.every((entry) =>
    env.filter((item) => item.startsWith(entry.split('=')[0] + '=')).length === 1 && env.includes(entry)
  ) && !env.some((item) => item.startsWith('STERLING_OPENBAO_ADDR=') && item !== 'STERLING_OPENBAO_ADDR=');
  if (!containerIdPattern.test(Id ?? '') || !imageIdPattern.test(Image ?? '') ||
      Name !== `/${containerName}` || Config?.Labels?.[owner] !== ownerValue ||
      Config.Labels[release] !== image || Config.Image !== image || !usableReleaseConfig(Config) ||
      !hasPreviewSettings || !hasDefaultHostAuthority(HostConfig) || mode !== 'bridge' ||
      networks.some((network) => network !== 'bridge') || (running && networks.length !== 1) ||
      Mounts?.length !== 1 || mount.Type !== 'volume' ||
      mount.Name !== volumeName || mount.Destination !== workspace || mount.RW !== true ||
      portOf(HostConfig.PortBindings, true) === undefined ||
      !(running || stopped) || (running && portOf(NetworkSettings.Ports) === undefined)) {
    throw new Error('The launcher container name is in use by an unrelated or misconfigured container.');
  }
  if (installed) {
    const expectedEnv = new Map(installed.Config.Env.map((entry) => [entry.split('=')[0], entry]));
    for (const entry of runtimeEnv) expectedEnv.set(entry.split('=')[0], entry);
    if (Image !== installed.Id || !isDeepStrictEqual([...env].sort(), [...expectedEnv.values()].sort())) {
      throw new Error('The launcher container image ID or environment does not match the inspected release.');
    }
  }
}

const runFile = promisify(execFile);

const host = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.versions.node,
  env: process.env,
  statSocket: async (path) => (await stat(path)).isSocket(),
  statfs,
  async docker(args, env, timeout) {
    try {
      const { stdout, stderr } = await runFile('docker', args, { env, encoding: 'utf8', timeout });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  },
  probe(url, timeout) {
    return new Promise((done, fail) => {
      const request = get(url, { agent: false, signal: AbortSignal.timeout(timeout) }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 16) {
            response.destroy();
            done({ status: response.statusCode, body });
          }
        });
        response.on('end', () => done({ status: response.statusCode, body }));
        response.on('error', fail);
      });
      request.on('error', fail);
    });
  },
  now: () => performance.now(),
  sleep,
};

async function checkPrerequisites(deps) {
  if (deps.platform !== 'linux' || (deps.arch !== 'x64' && deps.arch !== 'arm64')) {
    throw new Error(`Detected host ${deps.platform}/${deps.arch}. The Workbench launcher requires Linux x86-64 or ARM64.`);
  }
  const architecture = deps.arch === 'x64' ? 'amd64' : 'arm64';
  const node = version(deps.nodeVersion);
  if (!node || node[0] !== 26 || node[1] < 13 || (node[1] === 13 && node[2] < 1)) throw new Error(usage);

  const env = { ...deps.env };
  if ((env.DOCKER_HOST && env.DOCKER_HOST !== dockerHost) ||
      (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== 'default')) {
    throw new Error('This launcher requires the local Docker engine. Clear the remote host or context selection.');
  }
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'DOCKER_DEFAULT_PLATFORM']) {
    delete env[key];
  }
  const docker = (args, timeout = 30_000) => deps.docker(['--host', dockerHost, ...args], env, timeout);
  const client = await docker(['--version']);
  if (client.code === 'ENOENT') throw new Error('Docker CLI is missing. Install Docker for this workstation first.');
  if (client.code !== 0) throw new Error('The Docker CLI could not run. Check the local Docker installation.');
  try {
    if (!await deps.statSocket(socket)) throw new Error('not a socket');
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('Access to the local Docker socket is denied.');
    throw new Error('The local Docker socket is missing or unavailable. Install or start Docker Engine on this workstation.');
  }
  const server = await docker(['version', '--format', '{{json .Server}}']);
  if (server.code !== 0) {
    if (/permission denied/i.test(server.stderr)) throw new Error('Access to the local Docker socket is denied.');
    throw new Error('The local Docker daemon is unavailable.');
  }
  let engine;
  try { engine = JSON.parse(server.stdout); } catch { throw new Error('A readable Docker server version of 28.0.0 or later is required.'); }
  if (engine?.Os !== 'linux' || engine.Arch !== architecture) {
    throw new Error(`This workstation requires a Linux ${architecture} Docker server.`);
  }
  if ((version(engine.Version)?.[0] ?? 0) < 28) throw new Error('Docker server 28.0.0 or later is required for localhost port publication.');

  return { docker, architecture };
}

async function describeDockerStorage(encodedRoot, readStatfs) {
  const unavailable = 'Docker data-root filesystem space is unavailable.';
  if (!encodedRoot || typeof readStatfs !== 'function') return unavailable;

  let stats;
  try {
    const dataRoot = JSON.parse(encodedRoot);
    if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot) || /[\x00-\x1f\x7f]/.test(dataRoot)) return unavailable;
    stats = await readStatfs(dataRoot, { bigint: true });
  } catch {
    return unavailable;
  }

  const { frsize, bsize, bavail } = stats ?? {};
  const allocationUnit = frsize === undefined || frsize === 0n ? bsize : frsize;
  if (typeof allocationUnit !== 'bigint' || allocationUnit <= 0n || typeof bavail !== 'bigint' || bavail < 0n) {
    return unavailable;
  }
  const bytes = allocationUnit * bavail;
  const gibibyte = 2n ** 30n;
  const hundredths = (bytes * 100n + gibibyte / 2n) / gibibyte;
  const decimal = String(hundredths % 100n).padStart(2, '0').replace(/0+$/, '');
  const gib = decimal ? `${hundredths / 100n}.${decimal}` : String(hundredths / 100n);
  return `Docker data-root filesystem visible to the launcher has ${gib} GiB available (${bytes} bytes). Other mounts may differ.`;
}

export async function launchLocalWorkbench({ image, repair = false, check = false }, deps = host) {
  if (check && (image !== undefined || repair)) throw new Error('Use --check on its own, without --image or --repair.');
  if (!check && (typeof image !== 'string' || !imagePattern.test(image))) {
    throw new Error('Supply the exact approved Sterling release image digest for this workstation.');
  }
  const { docker, architecture } = await checkPrerequisites(deps);
  const platform = `linux/${architecture}`;
  if (check) {
    const prerequisites = `Workbench prerequisites are ready for ${platform}. A matching approved image is required to start.`;
    const result = await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}\n{{json .DockerRootDir}}'], 3000);
    const [capacityLine = '', ...rootLines] = result.code === 0 ? result.stdout.trimEnd().split('\n') : [];
    const fields = /^([1-9]\d{0,15}) ([1-9]\d{0,15})$/.exec(capacityLine);
    const cpuCount = Number(fields?.[1]);
    const memoryBytes = Number(fields?.[2]);
    let capacity = 'Docker CPU and memory readings are unavailable.';
    if (Number.isSafeInteger(cpuCount) && Number.isSafeInteger(memoryBytes)) {
      const memory = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 }).format(memoryBytes / 2 ** 30);
      const cpus = cpuCount === 1 ? 'CPU' : 'CPUs';
      capacity = `Docker reports ${cpuCount} logical ${cpus} and ${memory} GiB total memory.`;
    }
    const storage = await describeDockerStorage(rootLines.length === 1 ? rootLines[0] : undefined, deps.statfs);
    const secretStorage = 'The released standalone Workbench has no local keyring or organization secret store. '
      + 'Saved credentials and active Standing Orders are unavailable. '
      + 'You can still use Workbench features that do not need saved credentials. '
      + 'Ask your administrator about a Workbench with a configured secret store.';
    return [prerequisites, capacity, storage, secretStorage].join('\n');
  }

  async function checked(step, ...args) {
    const result = await docker(args, args[0] === 'pull' ? 300_000 : 30_000);
    if (result.code !== 0) {
      const capacity = /no space left|disk quota exceeded|out of memory/i.exec(result.stderr)?.[0];
      throw new Error(capacity ? `${step}: ${capacity}.` : `${step} failed. Check local Docker and retry.`);
    }
    return result.stdout.trim();
  }
  async function inspect(kind, name, optional = false, timeout) {
    const result = await docker([kind, 'inspect', name], timeout);
    if (result.code !== 0) {
      const absent = [`Error: No such ${kind}: ${name}`, `Error response from daemon: No such ${kind}: ${name}`];
      if (kind === 'container') absent.push(`Error: No such object: ${name}`);
      if (kind === 'volume') absent.push(`Error response from daemon: get ${name}: no such volume`);
      if (optional && result.code === 1 && ['', '[]'].includes(result.stdout.trim()) &&
          absent.includes(result.stderr.trim())) return undefined;
      throw new Error(`Could not inspect the ${kind} in local Docker.`);
    }
    let values;
    try { values = JSON.parse(result.stdout); } catch {
      throw new Error(`Local Docker returned an unreadable ${kind} inspection.`);
    }
    if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object') {
      throw new Error(`Local Docker returned an ambiguous ${kind} inspection.`);
    }
    return values[0];
  }

  async function preflight() {
    const existingContainer = await inspect('container', containerName, true);
    const existingVolume = await inspect('volume', volumeName, true);
    if (existingVolume) validateVolume(existingVolume);
    if (existingContainer) {
      validateContainer(existingContainer, image);
      if (!existingVolume) throw new Error('The launcher container is missing its owned workspace volume.');
    }
    return { volume: existingVolume, container: existingContainer };
  }

  let { volume, container } = await preflight();
  let installed = await inspect('image', image, true);
  if (!installed && repair) {
    await checked('Pulling the approved release image', 'pull', '--platform', platform, image);
    installed = await inspect('image', image, true);
    ({ volume, container } = await preflight());
  }
  if (!installed) throw new Error('The exact release image is missing. Load it locally or use --repair to pull that digest.');
  if (!imageIdPattern.test(installed.Id ?? '') || !Array.isArray(installed.RepoDigests) || !installed.RepoDigests.includes(image) ||
      installed.Os !== 'linux' || installed.Architecture !== architecture ||
      !usableReleaseConfig(installed.Config) || !Array.isArray(installed.Config.Env)) {
    throw new Error(`The local image does not match the exact release digest, ${platform} platform or release configuration.`);
  }
  if (container) validateContainer(container, image, installed);
  if (!volume) {
    await checked('Creating the workspace volume', 'volume', 'create', '--driver', 'local', '--label', `${owner}=${ownerValue}`, volumeName);
    validateVolume(await inspect('volume', volumeName));
  }
  if (!container) {
    const id = await checked('Creating the Workbench container', 'create', '--pull=never', '--platform', platform, '--name', containerName,
      '--label', `${owner}=${ownerValue}`, '--label', `${release}=${image}`, '--network', 'bridge',
      '--mount', `type=volume,source=${volumeName},target=${workspace}`,
      ...runtimeEnv.flatMap((entry) => ['--env', entry]), '--publish', '127.0.0.1::3000', image);
    if (!containerIdPattern.test(id)) throw new Error('Docker did not return the new Workbench container ID.');
    container = await inspect('container', id);
    validateContainer(container, image, installed);
    if (container.Id !== id || container.State.Running) throw new Error('The created Workbench container changed before start.');
  }
  const id = container.Id;
  if (!container.State.Running) await checked('Starting the Workbench', 'start', id);

  const deadline = deps.now() + 120_000;
  const timedOut = () => new Error('Workbench health did not become ready in time. Retry to check the existing container and workspace.');
  async function livePort() {
    const remaining = Math.floor(deadline - deps.now());
    if (remaining < 1) throw timedOut();
    const current = await inspect('container', id, false, Math.min(remaining, 30_000));
    validateContainer(current, image, installed);
    if (current.Id !== id || !current.State.Running) throw new Error('The inspected Workbench container is no longer running.');
    return portOf(current.NetworkSettings.Ports);
  }
  const port = await livePort();
  while (deps.now() < deadline) {
    const remaining = Math.floor(deadline - deps.now());
    if (remaining < 1) break;
    const reply = await deps.probe(`http://127.0.0.1:${port}/healthz`, Math.min(remaining, 3_000)).catch(() => undefined);
    if (reply?.status === 200 && reply.body === 'ok') {
      if (await livePort() !== port) throw new Error('The Workbench loopback publication changed during the health check.');
      if (deps.now() <= deadline) return `http://localhost:${port}/`;
      break;
    }
    const pause = Math.min(1_000, deadline - deps.now());
    if (pause > 0) await deps.sleep(pause);
  }
  throw timedOut();
}

async function main() {
  const { values } = parseArgs({ options: {
    image: { type: 'string' }, repair: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  const result = await launchLocalWorkbench(values);
  console.log(values.check ? result : `Workbench ready. Open ${result}`);
}

const invoked = process.argv[1];
if (invoked && basename(invoked) === 'launch-local-workbench.mjs' &&
    pathToFileURL(resolve(invoked)).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

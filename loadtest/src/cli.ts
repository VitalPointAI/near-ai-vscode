// The load-test command line (Phase 48 D-03, D-06, D-09, D-19):
//   node loadtest/src/cli.ts run --config <file> [--stages 50,100] [--kind load|dry-run]
//   node loadtest/src/cli.ts sample --no-auth --once
//   node loadtest/src/cli.ts users --count <n> --out <path outside the repository>
//   node loadtest/src/cli.ts capacity [--check]
//   node loadtest/src/cli.ts verify <file> | --all
// A load run is refused unless it measures the assessed build in the owner's configuration: sessionsPerUser 1, the workbench image by digest,
// and the Theia Cloud operator digest Phase 47 locked. Otherwise only a dry-run is possible, and a dry-run is never a capacity source.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalSample, type LocalSampleTimings } from './browser.ts';
import { checkCapacityBlock, renderCapacityPage } from './capacity.ts';
import { assertTestRealm, parseUsersFile, TEST_CLIENT_ID, TokenStore } from './keycloak.ts';
import { createMeasure, execKubectl, httpPrometheus, type Kubectl } from './measure.ts';
import { loadRunFiles, verifyRunFile, writeRunFile, type RunKind, type RunNode, type RunVersions, type UnhashedRun } from './runfile.ts';
import { createServiceClient, createSessionDriver, type Fetch } from './service.ts';
import { runStages, type Clock } from './stages.ts';

export interface CliDeps {
  readonly repoRoot: string;
  readonly write: (text: string) => void;
  readonly error: (text: string) => void;
  readonly kubectl: Kubectl;
  readonly fetch: Fetch;
  readonly clock: Clock;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sample: (descriptor: string) => Promise<LocalSampleTimings>;
  readonly signal?: AbortSignal;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RUNS_DIR = 'loadtest/runs';
export const CAPACITY_PAGE = 'docs/hosting/capacity.md';
export const IMAGE_LOCK = 'deploy/bundle/images.lock.json';
export const CHART_LOCK = 'deploy/charts/charts.lock.json';
/** How the test realm differs from production, recorded in every run (research Pitfall 15). */
export const TEST_REALM_DIFFERENCES = Object.freeze([
  `password grant (direct access grants) on for ${TEST_CLIENT_ID}`,
  'WebAuthn attestation not required (conveyance none) and no AAGUID allowlist',
  'synthetic users only; never in production or the offline bundle'
]);
const DIGEST = /@(sha256:[0-9a-f]{64})$/;

function defaultDeps(): CliDeps {
  return {
    repoRoot: REPO_ROOT,
    write: (text) => { process.stdout.write(text); },
    error: (text) => { process.stderr.write(text); },
    kubectl: execKubectl(),
    fetch,
    clock: { now: Date.now, sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } },
    sample: (descriptor) => runLocalSample(REPO_ROOT, descriptor),
    env: process.env
  };
}

/** The value after `--name`, or undefined. */
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** True when `target` resolves inside `root` (through symlinks of the nearest existing folder). */
export function insideRepository(root: string, target: string): boolean {
  let folder = path.dirname(path.resolve(target));
  while (!existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
  const real = path.join(realpathSync(folder), path.relative(folder, path.resolve(target)));
  const relative = path.relative(realpathSync(root), real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The digest of the Theia Cloud operator image Phase 47 locked: our rebuilt image if built, else the pinned upstream image. */
export function lockedOperatorDigest(lock: unknown): string | null {
  const record = (lock ?? {}) as { built?: Array<{ name?: string; digest?: string | null }>; images?: Array<{ ref?: string }> };
  const built = record.built?.find((entry) => typeof entry.name === 'string' && entry.name.endsWith('/theia-cloud-operator'));
  if (built) return typeof built.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(built.digest) ? built.digest : null;
  const upstream = record.images?.find((entry) => typeof entry.ref === 'string' && /\/theia-cloud-operator[:@]/.test(entry.ref));
  return upstream?.ref?.match(DIGEST)?.[1] ?? null;
}

export interface LoadFacts {
  readonly sessionsPerUser: number | null;
  readonly appImage: string;
  readonly operatorImage: string;
  readonly lockedOperatorDigest: string | null;
}

/** Why a `load` run may not start on this rig; empty when it may (D-03, D-06). */
export function loadRefusals(facts: LoadFacts): string[] {
  const problems: string[] = [];
  if (facts.sessionsPerUser !== 1) problems.push(`sessionsPerUser is ${facts.sessionsPerUser ?? 'not set'} on the operator; a load run measures the owner's configuration of 1 (D-03)`);
  if (!DIGEST.test(facts.appImage)) problems.push(`the AppDefinition image ${facts.appImage || '(none)'} is not referenced by digest (name@sha256:...)`);
  const running = facts.operatorImage.match(DIGEST)?.[1];
  if (facts.lockedOperatorDigest === null) problems.push(`${IMAGE_LOCK} has no digest for the Theia Cloud operator, so the run cannot show it measures the assessed build (D-06)`);
  else if (running !== facts.lockedOperatorDigest) problems.push(`the operator image ${running ?? facts.operatorImage} is not the one in ${IMAGE_LOCK} (${facts.lockedOperatorDigest}) (D-06)`);
  return problems;
}

/** Kubernetes quantities: CPU as millicores, memory as bytes. */
export function cpuMillicores(quantity: string): number {
  return quantity.endsWith('m') ? Math.round(Number(quantity.slice(0, -1))) : Math.round(Number(quantity) * 1000);
}
const UNITS: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9, T: 1e12, '': 1 };
export function quantityBytes(quantity: string): number {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(quantity);
  return match ? Math.round(Number(match[1]) * UNITS[match[2] ?? '']) : 0;
}

type Json = Record<string, unknown>;
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((item, key) => (item !== null && typeof item === 'object' ? (item as Json)[key] : undefined), value);
const readJson = (file: string): unknown => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

function nodesOf(list: unknown): RunNode[] {
  return ((at(list, 'items') as Json[] | undefined) ?? []).map((node) => {
    const labels = (at(node, 'metadata', 'labels') as Record<string, string> | undefined) ?? {};
    const roles = Object.keys(labels).filter((key) => key.startsWith('node-role.kubernetes.io/')).map((key) => key.slice('node-role.kubernetes.io/'.length)).sort();
    const capacity = (at(node, 'status', 'capacity') as Record<string, string> | undefined) ?? {};
    return { name: String(at(node, 'metadata', 'name') ?? ''), role: roles.join(',') || 'worker', cpuMillicores: cpuMillicores(capacity.cpu ?? '0'), memoryBytes: quantityBytes(capacity.memory ?? '0'), maxPods: Number.parseInt(capacity.pods ?? '0', 10) || 0 };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The operator container's image and its `--sessionsPerUser` value (null when the argument is absent). */
function operatorOf(deployment: unknown): { image: string; sessionsPerUser: number | null } {
  const container = ((at(deployment, 'spec', 'template', 'spec', 'containers') as Json[] | undefined) ?? [])[0] ?? {};
  const args = ((container.args as string[] | undefined) ?? []).flatMap((arg) => arg.split('='));
  const index = args.indexOf('--sessionsPerUser');
  const value = index >= 0 ? Number.parseInt(args[index + 1] ?? '', 10) : Number.NaN;
  return { image: String(container.image ?? ''), sessionsPerUser: Number.isSafeInteger(value) ? value : null };
}

/** Versions from the images running in the cluster and Phase 47's lock files; "unknown" when one is not found, never a guess. */
function versionsOf(pods: unknown, nodes: unknown, appImage: string, operatorImage: string, repoRoot: string): RunVersions {
  const images = ((at(pods, 'items') as Json[] | undefined) ?? []).flatMap((pod) => ((at(pod, 'spec', 'containers') as Json[] | undefined) ?? []).map((container) => String(container.image ?? '')));
  const find = (pattern: RegExp): string => images.find((image) => pattern.test(image)) ?? 'unknown';
  const ingress = find(/(haproxy|traefik)[^/]*[:@]/);
  const chart = ((at(readJson(path.join(repoRoot, CHART_LOCK)), 'charts') as Json[] | undefined) ?? []).find((entry) => entry.name === 'theia-cloud');
  const built = readJson(path.join(repoRoot, 'deploy/images/theia-cloud-operator/image.json'));
  const digest = (ref: string): string => ref.match(DIGEST)?.[1] ?? ref;
  return {
    workbenchImage: digest(appImage),
    theiaCloud: { chart: String(chart?.version ?? 'unknown'), commit: String(at(built, 'commit') ?? at(built, 'source', 'commit') ?? 'unknown'), operatorImage: digest(operatorImage) },
    keycloak: find(/\/keycloak[:@]/),
    openbao: find(/\/openbao[a-z-]*[:@]/),
    ingress: { kind: /traefik/.test(ingress) ? 'traefik' : /haproxy/.test(ingress) ? 'haproxy' : 'unknown', version: ingress },
    rke2: String(at(((at(nodes, 'items') as Json[] | undefined) ?? [])[0], 'status', 'nodeInfo', 'kubeletVersion') ?? 'unknown'),
    hub: digest(find(/near-ai-hub[:@]/))
  };
}

interface RunConfig {
  readonly rig: string;
  readonly namespace: string;
  readonly serviceUrl: string;
  readonly prometheusUrl: string;
  readonly keycloak: { readonly url: string; readonly realm: string; readonly clientId?: string };
  readonly usersFile: string;
  readonly appDefinition: string;
  readonly appDefinitionResource: string;
  readonly sessionResource: string;
  readonly operatorDeployment: string;
  readonly stages: number[];
  readonly burst: number;
  readonly holdMs: number;
  readonly activityIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly rampConcurrency: number;
  readonly startTimeoutMs: number;
  readonly pendingLimitMs: number;
  readonly maxFailedPercent: number;
  readonly idleTimeoutMinutes: number;
  readonly activeSample: number;
  readonly profile: { readonly id: string; readonly version: string; readonly file: string } | null;
  readonly hardware: { readonly storageClass: string; readonly imagesPreloaded: boolean; readonly network: string };
}

/** `yyyymmddThhmmssZ` of a UTC time. */
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

async function run(args: readonly string[], deps: CliDeps): Promise<number> {
  const configFile = option(args, '--config');
  const kind = (option(args, '--kind') ?? 'load') as RunKind;
  if (!configFile || (kind !== 'load' && kind !== 'dry-run')) { deps.error('usage: run --config <file> [--stages 50,100] [--kind load|dry-run]\n'); return 2; }
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as RunConfig;
  const stagesArg = option(args, '--stages');
  const stages = stagesArg ? stagesArg.split(',').map((value) => Number.parseInt(value, 10)) : config.stages;
  if (stages.length === 0 || stages.some((value) => !Number.isSafeInteger(value) || value <= 0)) { deps.error('stages must be positive whole numbers\n'); return 2; }
  assertTestRealm(config.keycloak.realm);
  if (insideRepository(deps.repoRoot, config.usersFile)) { deps.error('the users file must be outside the repository\n'); return 2; }
  const appId = deps.env.THEIA_CLOUD_APP_ID;
  if (!appId) { deps.error('set THEIA_CLOUD_APP_ID to the Theia Cloud service app id (it is not read from a file)\n'); return 2; }

  const kubectlJson = async (kubeArgs: string[]): Promise<unknown> => JSON.parse(await deps.kubectl(kubeArgs));
  const [nodes, appDefinition, operatorDeployment, pods] = await Promise.all([
    kubectlJson(['get', 'nodes', '-o', 'json']),
    kubectlJson(['get', config.appDefinitionResource, config.appDefinition, '-n', config.namespace, '-o', 'json']),
    kubectlJson(['get', 'deployment', config.operatorDeployment, '-n', config.namespace, '-o', 'json']),
    kubectlJson(['get', 'pods', '-A', '-o', 'json'])
  ]);
  const appImage = String(at(appDefinition, 'spec', 'image') ?? '');
  const operator = operatorOf(operatorDeployment);
  const facts: LoadFacts = { sessionsPerUser: operator.sessionsPerUser, appImage, operatorImage: operator.image, lockedOperatorDigest: lockedOperatorDigest(readJson(path.join(deps.repoRoot, IMAGE_LOCK))) };
  const refusals = loadRefusals(facts);
  if (kind === 'load' && refusals.length > 0) {
    deps.error(`Refusing a load run (a dry-run is still possible):\n${refusals.map((line) => `- ${line}\n`).join('')}`);
    return 2;
  }
  if (refusals.length > 0) deps.write(`Dry-run on a rig that is not the assessed configuration:\n${refusals.map((line) => `- ${line}\n`).join('')}`);

  const users = parseUsersFile(readFileSync(config.usersFile, 'utf8'));
  const tokens = new TokenStore({ baseUrl: config.keycloak.url, realm: config.keycloak.realm, clientId: config.keycloak.clientId, fetch: deps.fetch }, users, deps.clock.now);
  const people = users.map((user) => user.email);
  await tokens.mintAll(people.slice(0, Math.max(...stages) + config.burst));
  const client = createServiceClient({ baseUrl: config.serviceUrl, appId, appDefinition: config.appDefinition, tokens, fetch: deps.fetch, startTimeoutMinutes: Math.max(1, Math.ceil(config.startTimeoutMs / 60_000)) });
  const measure = createMeasure({
    kubectl: deps.kubectl, prometheus: httpPrometheus(config.prometheusUrl, deps.fetch), clock: deps.clock, namespace: config.namespace,
    sessionResource: config.sessionResource, ingressName: String(at(appDefinition, 'spec', 'ingressname') ?? ''), pollIntervalMs: config.pollIntervalMs
  });

  const controller = new AbortController();
  const stop = (): void => controller.abort(new Error('interrupted'));
  if (!deps.signal) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  deps.signal?.addEventListener('abort', stop, { once: true });
  const startedAt = deps.clock.now();
  const plan = { stages, burst: config.burst, holdMs: config.holdMs, activityIntervalMs: config.activityIntervalMs, pollIntervalMs: config.pollIntervalMs, rampConcurrency: config.rampConcurrency, startTimeoutMs: config.startTimeoutMs, pendingLimitMs: config.pendingLimitMs, maxFailedPercent: config.maxFailedPercent };
  let outcome;
  try {
    outcome = await runStages({ plan, people, service: createSessionDriver(client, tokens, deps.fetch), measure, clock: deps.clock, signal: controller.signal });
  } finally {
    if (!deps.signal) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
  const profile = config.profile
    ? { id: config.profile.id, version: config.profile.version, sha256: `sha256:${createHash('sha256').update(readFileSync(path.resolve(deps.repoRoot, config.profile.file))).digest('hex')}` }
    : { id: 'none', version: '0', sha256: '' };
  const record: UnhashedRun = {
    schema: 1,
    kind,
    id: `${stamp(startedAt)}-${config.rig}`,
    rig: config.rig,
    startedAt,
    endedAt: deps.clock.now(),
    inputs: { ...plan, stages: [...stages].sort((a, b) => a - b), idleTimeoutMinutes: config.idleTimeoutMinutes, activeSample: config.activeSample, profile, appDefinition: { name: config.appDefinition, image: appImage }, sessionsPerUser: operator.sessionsPerUser ?? 0, testRealm: { name: config.keycloak.realm, differences: [...TEST_REALM_DIFFERENCES] } },
    hardware: { nodes: nodesOf(nodes), storageClass: config.hardware.storageClass, imagesPreloaded: config.hardware.imagesPreloaded, network: config.hardware.network },
    versions: versionsOf(pods, nodes, appImage, operator.image, deps.repoRoot),
    peakConcurrency: outcome.peakConcurrency,
    stages: outcome.stages
  };
  const dir = path.join(deps.repoRoot, RUNS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = writeRunFile(dir, record);
  deps.write(`Wrote ${path.relative(deps.repoRoot, file)}: ${outcome.stages.map((stage) => `${stage.target} ${stage.reached ? 'reached' : `not reached (${stage.reason})`}`).join('; ')}\n`);
  return 0;
}

function users(args: readonly string[], deps: CliDeps): number {
  const count = Number.parseInt(option(args, '--count') ?? '', 10);
  const out = option(args, '--out');
  if (!out || !Number.isSafeInteger(count) || count <= 0 || count > 9_999) { deps.error('usage: users --count <1-9999> --out <path outside the repository>\n'); return 2; }
  if (insideRepository(deps.repoRoot, out)) { deps.error('refusing to write the users file inside the repository: it holds passwords; keep it in the rig\'s secret store\n'); return 2; }
  const entries = Array.from({ length: count }, (_, index) => {
    const username = `loadtest-user-${String(index + 1).padStart(4, '0')}`;
    return { username, email: `${username}@loadtest.invalid`, enabled: true, emailVerified: true, credentials: [{ type: 'password', value: randomBytes(24).toString('base64url'), temporary: false }] };
  });
  let fd: number;
  try { fd = openSync(out, 'wx', 0o600); } catch (error) { deps.error(`cannot create ${out}: ${(error as NodeJS.ErrnoException).code ?? 'error'} (an existing users file is never overwritten)\n`); return 2; }
  try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify({ users: entries }, null, 2)}\n`); } finally { closeSync(fd); }
  deps.write(`Wrote ${count} synthetic users to ${out} (mode 0600). Import them into the test realm on the rig only.\n`);
  return 0;
}

function capacity(args: readonly string[], deps: CliDeps): number {
  const page = path.join(deps.repoRoot, CAPACITY_PAGE);
  const runs = loadRunFiles(path.join(deps.repoRoot, RUNS_DIR));
  const rendered = renderCapacityPage(runs);
  if (args.includes('--check')) {
    const current = existsSync(page) ? readFileSync(page, 'utf8') : '';
    const problems = current === rendered ? [] : ['the page is not what the committed run files render', ...checkCapacityBlock(current, runs)];
    if (problems.length > 0) { deps.error(`${CAPACITY_PAGE}:\n${problems.map((line) => `- ${line}\n`).join('')}Run node loadtest/src/cli.ts capacity and commit the page.\n`); return 1; }
    deps.write(`${CAPACITY_PAGE} matches ${runs.length} run files.\n`);
    return 0;
  }
  mkdirSync(path.dirname(page), { recursive: true });
  writeFileSync(page, rendered);
  deps.write(`Wrote ${CAPACITY_PAGE} from ${runs.length} run files.\n`);
  return 0;
}

function verify(args: readonly string[], deps: CliDeps): number {
  if (args.includes('--all')) {
    const runs = loadRunFiles(path.join(deps.repoRoot, RUNS_DIR));
    deps.write(`${runs.length} run files verify.\n`);
    return 0;
  }
  const file = args[0];
  if (!file) { deps.error('usage: verify <file> | --all\n'); return 2; }
  const runFile = verifyRunFile(readFileSync(file, 'utf8'));
  deps.write(`${runFile.id} (${runFile.kind}) verifies: ${runFile.hash}\n`);
  return 0;
}

export async function main(argv: readonly string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const [name, ...rest] = argv;
  try {
    const fixture = deps.env.SOVAI_SAMPLE_FIXTURE;
    if (name === 'sample') {
      if (!fixture || rest.length !== 2 || rest[0] !== '--no-auth' || rest[1] !== '--once') {
        deps.error('sample requires --no-auth --once and a private SOVAI_SAMPLE_FIXTURE descriptor\n');
        return 2;
      }
      deps.write(`${JSON.stringify(await deps.sample(fixture))}\n`);
      return 0;
    }
    if (name === 'run') {
      if (fixture !== undefined) {
        deps.error('The ordinary run command is unavailable in the local sample fixture.\n');
        return 2;
      }
      return await run(rest, deps);
    }
    if (name === 'users') return users(rest, deps);
    if (name === 'capacity') return capacity(rest, deps);
    if (name === 'verify') return verify(rest, deps);
    deps.error(`Unknown command ${name ?? '<none>'}. Commands: run, sample, users, capacity, verify\n`);
    return 2;
  } catch (error) {
    deps.error(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

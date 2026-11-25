// Your organization's server as a real child process for extension tests (Phase 33, D-34, D-46): the built hub (hub/dist/bin.mjs) started on the
// Node binary NEAR_AI_HUB_NODE names, the way an operator runs it. The launch copies hub/test/helpers/hubProcess.ts, because extension tests cannot
// import the hub workspace: five secret files with mode 0600, each named through its NAME_FILE setting, a temporary state directory, HUB_PORT=0 on
// the first start so parallel runs never collide, and nothing else in the environment but PATH and HOME. The certificate is made at run time with
// openssl and the hub's three key lines by the hub's own --generate-key, so no key text lives in any file. The hub file comes from the operator
// command --hub-file, run against the same state directory while the hub runs.
//
// The rule for when the real-hub tests run (D-46): with NEAR_AI_HUB_NODE set they run; without it they are skipped with a printed reason, except in
// GitHub Actions, where a missing binary fails the test with the same sentence. This file has no .test suffix, so the test glob does not run it.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { certPinOf } from '../../domain/replica/hubFile';

/** The one sentence of the skip and fail rule (D-46). */
export const HUB_NODE_REASON = 'Set NEAR_AI_HUB_NODE to a Node 26.13.1 binary to run the real-hub test';

export type HubNodeRule = { run: string } | { skip: string } | { fail: string };

/** What the environment says about the real-hub tests: run with this binary, skip with the reason, or fail with it (GitHub Actions). */
export function hubNodeRule(env: Readonly<Record<string, string | undefined>>): HubNodeRule {
  const node = env.NEAR_AI_HUB_NODE;
  if (node !== undefined && node !== '') return { run: node };
  return env.GITHUB_ACTIONS === 'true' ? { fail: HUB_NODE_REASON } : { skip: HUB_NODE_REASON };
}

/**
 * The Node binary for the real hub, or undefined after skipping the test with the printed reason. Throws the reason in GitHub Actions, so CI can
 * never pass a real-hub test it did not run.
 */
export function hubNodeOrSkip(t: { skip(message?: string): void }, env: Readonly<Record<string, string | undefined>> = process.env, print: (line: string) => void = (line) => console.log(line)): string | undefined {
  const rule = hubNodeRule(env);
  if ('run' in rule) return rule.run;
  if ('fail' in rule) throw new Error(rule.fail);
  print(rule.skip);
  t.skip(rule.skip);
  return undefined;
}

/** The repository folder: the nearest folder above this code holding hub/package.json of the hub workspace. Works from the sources and from dist. */
export function repoRoot(): string {
  let dir = __dirname;
  for (;;) {
    const manifest = path.join(dir, 'hub', 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'near-ai-hub') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('The hub workspace was not found above the test code.');
    dir = parent;
  }
}

const SECRET_NAMES = ['HUB_TLS_CERT', 'HUB_TLS_KEY', 'HUB_SIGNING_KEY', 'HUB_ENCRYPTION_KEY', 'HUB_KEM_KEY'] as const;
type SecretName = (typeof SECRET_NAMES)[number];
/** A hub left running by a failed test is stopped at the latest after this long. */
const KILL_AFTER_MS = 60_000;

export interface HubChild {
  /** 127.0.0.1:port, as the hub file names it. */
  readonly address: string;
  readonly port: number;
  /** The SPKI pin of the hub's certificate. */
  readonly pin: string;
  readonly stateDir: string;
  /** A fresh hub file from the operator command, naming this address. */
  hubFileText(days?: number): Promise<string>;
  /** Stops the hub: SIGTERM, then SIGKILL if it has not exited after 60 seconds. The state directory stays. */
  stop(): Promise<void>;
  /** Starts the hub again on the same state directory, secrets and port (offline and back, 33-01 Task 2). */
  restart(): Promise<void>;
  /** Stops the hub and removes its temporary folder. */
  dispose(): Promise<void>;
  /** Every line the current run printed, for a failure message. */
  output(): string;
}

function writeSecret(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o600);
}

/** A self-signed P-256 certificate and key for 127.0.0.1, made with openssl in a folder of its own (never committed). */
function makeCertificate(dir: string): { certPem: string; keyPem: string } {
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  const run = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) throw new Error('openssl could not make the test certificate; the real-hub test needs openssl.');
  const certPem = readFileSync(certFile, 'utf8');
  const keyPem = readFileSync(keyFile, 'utf8');
  rmSync(certFile, { force: true });
  rmSync(keyFile, { force: true });
  return { certPem, keyPem };
}

/** One key line from the hub's own --generate-key command. */
function generateKey(node: string, bin: string, kind: 'signing' | 'encryption' | 'kem', env: NodeJS.ProcessEnv): string {
  const run = spawnSync(node, [bin, '--generate-key', kind], { encoding: 'utf8', env, timeout: 30_000 });
  if (run.status !== 0 || run.stdout.trim() === '') throw new Error(`The hub could not make its ${kind} key (exit ${String(run.status)}).`);
  return `${run.stdout.trim()}\n`;
}

interface Running { child: ChildProcess; out: () => string; exited: Promise<void> }

function launch(node: string, bin: string, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[] = []): Running {
  const child = spawn(node, [bin, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
  const guard = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
  guard.unref();
  void exited.then(() => clearTimeout(guard));
  return { child, out: () => out, exited };
}

/** The port of the hub.listening line, waiting up to `ms`. */
async function listeningPort(run: Running, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const line of run.out().split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line) as { event?: unknown; port?: unknown };
        if (parsed.event === 'hub.listening' && typeof parsed.port === 'number' && parsed.port > 0) return parsed.port;
      } catch {
        // a line still being written
      }
    }
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`The hub exited before it listened: ${run.out()}`);
    if (Date.now() > deadline) throw new Error(`The hub did not listen within ${ms} ms: ${run.out()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopRun(run: Running): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
  await run.exited;
}

/** Starts the built hub on a temporary state directory with loopback TLS, and waits until it listens. */
export async function startHubChild(node: string): Promise<HubChild> {
  const bin = path.join(repoRoot(), 'hub', 'dist', 'bin.mjs');
  if (!existsSync(bin)) throw new Error('The hub is not built: run npm run build in hub/ first.');
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-child-'));
  const secretsDir = path.join(root, 'secrets');
  mkdirSync(secretsDir, { mode: 0o700 });
  const cwd = path.join(root, 'cwd');
  mkdirSync(cwd, { mode: 0o700 });
  const stateDir = path.join(root, 'state');
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  const certificate = makeCertificate(secretsDir);
  const contents: Record<SecretName, string> = {
    HUB_TLS_CERT: certificate.certPem,
    HUB_TLS_KEY: certificate.keyPem,
    HUB_SIGNING_KEY: generateKey(node, bin, 'signing', base),
    HUB_ENCRYPTION_KEY: generateKey(node, bin, 'encryption', base),
    HUB_KEM_KEY: generateKey(node, bin, 'kem', base)
  };
  const env: NodeJS.ProcessEnv = { ...base, HUB_HOST: '127.0.0.1', HUB_PORT: '0', HUB_STATE_DIR: stateDir };
  for (const name of SECRET_NAMES) {
    const file = path.join(secretsDir, name.toLowerCase());
    writeSecret(file, contents[name]);
    env[`${name}_FILE`] = file;
  }
  const pin = certPinOf(certificate.certPem);
  let run: Running;
  let port: number;
  try {
    run = launch(node, bin, cwd, env);
    port = await listeningPort(run, 20_000);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const address = `127.0.0.1:${port}`;
  return {
    address,
    port,
    pin,
    stateDir,
    async hubFileText(days = 7) {
      const issue = launch(node, bin, cwd, { ...env, HUB_PUBLIC_ADDRESS: address }, ['--hub-file', String(days)]);
      await issue.exited;
      const text = issue.out().trim();
      if (issue.child.exitCode !== 0 || !text.startsWith('{')) throw new Error(`The hub file could not be made: ${text}`);
      return text;
    },
    async stop() {
      await stopRun(run);
    },
    async restart() {
      await stopRun(run);
      run = launch(node, bin, cwd, { ...env, HUB_PORT: String(port) });
      const again = await listeningPort(run, 20_000);
      if (again !== port) throw new Error(`The hub came back on port ${again}, not ${port}.`);
    },
    async dispose() {
      await stopRun(run);
      rmSync(root, { recursive: true, force: true });
    },
    output: () => run.out()
  };
}

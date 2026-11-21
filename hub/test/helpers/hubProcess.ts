import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyFile } from '../../src/keys';
import { makeTlsFixture, type TlsFixture } from './tlsFixture';

// Runs the built hub (dist/bin.mjs) as a child process the way an operator does: four secret files with mode 0600, each named through its
// NAME_FILE setting, a temporary state directory, HUB_PORT=0 so parallel runs never collide, and nothing else in the environment but PATH and HOME.
// startHubProcess waits for the hub.listening line and returns the bound port; launchHub returns at once, for the refusal tests.

export const SECRET_NAMES = ['HUB_TLS_CERT', 'HUB_TLS_KEY', 'HUB_SIGNING_KEY', 'HUB_ENCRYPTION_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** The hub workspace folder: the nearest folder above this code whose package.json is near-ai-hub. Works from the sources and from dist/test. */
export function hubRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'near-ai-hub') return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, 'the hub workspace folder was not found above the test code');
    dir = parent;
  }
}

export const BIN = (): string => path.join(hubRoot(), 'dist', 'bin.mjs');

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type LogLine = Record<string, unknown> & { time: string; level: string; event: string };

export interface LaunchOptions {
  /** Content for a secret file, or null to leave that secret out. Unnamed secrets get a fresh valid value. */
  secrets?: Partial<Record<SecretName, string | null>>;
  /** Extra environment, applied last (it can override the defaults, HUB_PORT included). */
  env?: Record<string, string>;
  args?: string[];
  /** Use this state directory instead of a fresh one. */
  stateDir?: string;
  /** The working folder of the child; a fresh empty folder by default. */
  cwd?: string;
}

export interface HubRun {
  child: ChildProcess;
  root: string;
  cwd: string;
  stateDir: string;
  tls: TlsFixture;
  secretFiles: Partial<Record<SecretName, string>>;
  stdout(): string;
  stderr(): string;
  /** Every complete stdout line, parsed; a line that is not a log line fails the test. */
  logs(): LogLine[];
  events(): string[];
  exited: Promise<Exit>;
  waitForEvent(event: string, ms?: number): Promise<LogLine>;
  kill(signal?: NodeJS.Signals): Promise<Exit>;
  cleanup(): void;
}

export interface StartedHub extends HubRun {
  port: number;
}

export function parseLogLines(stdout: string): LogLine[] {
  const lines = stdout.split('\n');
  lines.pop(); // the text after the last newline is a line still being written, or empty
  return lines.map((line) => {
    const parsed = JSON.parse(line) as LogLine;
    assert.equal(typeof parsed.time, 'string', `no time in ${line}`);
    assert.ok(['info', 'warn', 'error'].includes(parsed.level), `bad level in ${line}`);
    assert.equal(typeof parsed.event, 'string', `no event in ${line}`);
    return parsed;
  });
}

function writeSecret(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o600);
}

export function launchHub(options: LaunchOptions = {}): HubRun {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-run-'));
  const secretsDir = path.join(root, 'secrets');
  mkdirSync(secretsDir, { mode: 0o700 });
  const cwd = options.cwd ?? path.join(root, 'cwd');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const stateDir = options.stateDir ?? path.join(root, 'state');
  const tls = makeTlsFixture();
  const defaults: Record<SecretName, string> = {
    HUB_TLS_CERT: tls.certPem,
    HUB_TLS_KEY: tls.keyPem,
    HUB_SIGNING_KEY: `${generateKeyFile('signing')}\n`,
    HUB_ENCRYPTION_KEY: `${generateKeyFile('encryption')}\n`,
  };
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, HUB_HOST: '127.0.0.1', HUB_PORT: '0', HUB_STATE_DIR: stateDir };
  const secretFiles: Partial<Record<SecretName, string>> = {};
  for (const name of SECRET_NAMES) {
    const content = options.secrets && Object.hasOwn(options.secrets, name) ? options.secrets[name] : defaults[name];
    if (content === null || content === undefined) continue;
    const file = path.join(secretsDir, name.toLowerCase());
    writeSecret(file, content);
    secretFiles[name] = file;
    env[`${name}_FILE`] = file;
  }
  Object.assign(env, options.env ?? {});

  const child = spawn(process.execPath, [BIN(), ...(options.args ?? [])], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const exited = new Promise<Exit>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  // A hub left running by a failed test is stopped at the latest after 60 s, so it cannot hold the run open.
  const guard = setTimeout(() => child.kill('SIGKILL'), 60_000);
  guard.unref();
  void exited.then(() => clearTimeout(guard));

  const run: HubRun = {
    child,
    root,
    cwd,
    stateDir,
    tls,
    secretFiles,
    stdout: () => out,
    stderr: () => err,
    logs: () => parseLogLines(out),
    events: () => parseLogLines(out).map((line) => line.event),
    exited,
    async waitForEvent(event: string, ms = 10_000): Promise<LogLine> {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = parseLogLines(out).find((line) => line.event === event);
        if (found) return found;
        if (Date.now() > deadline) assert.fail(`no ${event} line within ${ms} ms; stdout was: ${out}; stderr was: ${err}`);
        if (child.exitCode !== null || child.signalCode !== null) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const late = parseLogLines(out).find((line) => line.event === event);
          if (late) return late;
          assert.fail(`the hub exited before ${event}; stdout was: ${out}; stderr was: ${err}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<Exit> {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    },
    cleanup(): void {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      tls.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return run;
}

export async function startHubProcess(options: LaunchOptions = {}): Promise<StartedHub> {
  const run = launchHub(options);
  try {
    const listening = await run.waitForEvent('hub.listening');
    assert.equal(typeof listening.port, 'number');
    assert.ok((listening.port as number) > 0, 'hub.listening must carry the bound port, not 0');
    return { ...run, port: listening.port as number };
  } catch (error) {
    run.cleanup();
    throw error;
  }
}

export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

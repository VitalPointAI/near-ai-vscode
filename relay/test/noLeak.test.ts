import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Phase 68, plan 06 (RELAY-04, D-08, D-09): a real relay run, started with fake secrets in files, serves requests and stops, and the fake values
// appear nowhere: not in stdout or stderr, not in the bytes of any state file, not in any name in the state directory. A secret given as a plain
// environment value stops the relay before it touches disk. Every secret here is an obviously fake value in a temporary directory.

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));

const FAKE_TEAMS = 'relay-noleak-teams-0f3c9a7e';
const FAKE_PSEUDONYM = 'relay-noleak-pseudonym-5b21d4c8';
const FAKE_TENANT = 'relay-noleak-tenant-9e6a1f30';

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Launched {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<Exit>;
}

type LogLine = Record<string, unknown> & { time: string; level: string; event: string };

function launch(settings: Record<string, string>): Launched {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...settings };
  const child = spawn(process.execPath, [BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const exited = new Promise<Exit>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => out, stderr: () => err, exited };
}

function logLines(launched: Launched): LogLine[] {
  const lines = launched.stdout().split('\n');
  lines.pop();
  return lines.map((line) => JSON.parse(line) as LogLine);
}

async function waitForEvent(launched: Launched, event: string, ms: number): Promise<LogLine> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = logLines(launched).find((line) => line.event === event);
    if (found) return found;
    if (Date.now() > deadline) assert.fail(`no ${event} line within ${ms} ms; stdout was: ${launched.stdout()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Scratch {
  /** Holds the secret files. */
  secretsDir: string;
  /** The relay's state directory. It does not exist yet: the relay must create it. */
  stateDir: string;
}

async function withScratch<T>(body: (scratch: Scratch) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-noleak-'));
  try {
    return await body({ secretsDir: path.join(root, 'secrets'), stateDir: path.join(root, 'state') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function secretFile(scratch: Scratch, name: string, value: string, mode = 0o600): Promise<string> {
  const file = path.join(scratch.secretsDir, name);
  await mkdir(scratch.secretsDir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${value}\n`, { mode });
  await chmod(file, mode);
  return file;
}

/** Every file and folder under dir: its relative name and, for files, its bytes. */
async function walk(dir: string, prefix = ''): Promise<{ name: string; bytes?: Buffer }[]> {
  const found: { name: string; bytes?: Buffer }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push({ name: relative });
      found.push(...(await walk(path.join(dir, entry.name), relative)));
    } else {
      found.push({ name: relative, bytes: await readFile(path.join(dir, entry.name)) });
    }
  }
  return found;
}

async function assertNoLeak(stateDir: string, values: string[], run: Launched): Promise<void> {
  for (const value of values) {
    assert.ok(!run.stdout().includes(value), 'a secret value reached stdout');
    assert.ok(!run.stderr().includes(value), 'a secret value reached stderr');
    for (const entry of await walk(stateDir)) {
      assert.ok(!entry.name.includes(value), `a secret value is in the state directory entry name ${entry.name}`);
      if (entry.bytes) assert.ok(!entry.bytes.includes(Buffer.from(value)), `a secret value is in the bytes of ${entry.name}`);
    }
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function runAndStop(settings: Record<string, string>, stateDir: string): Promise<Launched> {
  const run = launch({ RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: stateDir, ...settings });
  try {
    const listening = await waitForEvent(run, 'relay.listening', 5000);
    const base = `http://127.0.0.1:${listening.port as number}`;
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    await health.arrayBuffer();
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
    const post = await fetch(`${base}/healthz`, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
    await post.arrayBuffer();
  } finally {
    run.child.kill('SIGTERM');
  }
  const exit = await within(run.exited, 5000, 'the relay shutting down on SIGTERM');
  assert.deepEqual(exit, { code: 0, signal: null });
  return run;
}

test('tracer: a secret supplied through a file is loaded, named in secrets.loaded, and its value appears in no output, state file or state entry name', async () => {
  await withScratch(async (scratch) => {
    const teamsFile = await secretFile(scratch, 'teams_app_secret', FAKE_TEAMS);
    const run = await runAndStop({ TEAMS_APP_SECRET_FILE: teamsFile }, scratch.stateDir);

    const loaded = logLines(run).find((line) => line.event === 'secrets.loaded');
    assert.ok(loaded, 'no secrets.loaded line');
    assert.equal(loaded.names, 'TEAMS_APP_SECRET');
    assert.equal(loaded.count, 1);
    assert.equal(run.stderr(), '');
    await assertNoLeak(scratch.stateDir, [FAKE_TEAMS], run);
  });
});

test('a secret given as a plain environment value stops the relay with exit 1 before the state directory exists, naming the variable and not the value', async () => {
  await withScratch(async (scratch) => {
    const run = launch({ RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: scratch.stateDir, TEAMS_APP_SECRET: FAKE_TEAMS });
    const exit = await within(run.exited, 5000, 'the relay refusing a plain secret');
    assert.equal(exit.code, 1);
    const lines = logLines(run);
    assert.deepEqual(lines.map((line) => line.event), ['relay.start_refused']);
    assert.equal(lines[0]?.reason, 'secrets');
    assert.match(String(lines[0]?.detail), /TEAMS_APP_SECRET/);
    assert.ok(!run.stdout().includes(FAKE_TEAMS), 'the secret value was echoed into the log');
    assert.ok(!run.stderr().includes(FAKE_TEAMS), 'the secret value was echoed to stderr');
    assert.equal(await exists(scratch.stateDir), false, 'the state directory was created before the plain secret was refused');
  });
});

test('LOG_PSEUDONYM_KEY and a tenant NEAR_AI_KEY_ name given as plain values are refused too, naming the variable only', async () => {
  for (const [name, value] of [['NEAR_AI_KEY_ACME', FAKE_TENANT], ['LOG_PSEUDONYM_KEY', FAKE_PSEUDONYM]] as const) {
    await withScratch(async (scratch) => {
      const run = launch({ RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: scratch.stateDir, [name]: value });
      const exit = await within(run.exited, 5000, `the relay refusing plain ${name}`);
      assert.equal(exit.code, 1);
      const lines = logLines(run);
      assert.deepEqual(lines.map((line) => line.event), ['relay.start_refused']);
      assert.equal(lines[0]?.reason, 'secrets');
      assert.match(String(lines[0]?.detail), new RegExp(name));
      assert.ok(!run.stdout().includes(value), 'the secret value was echoed into the log');
      assert.equal(await exists(scratch.stateDir), false);
    });
  }
});

test('a tenant key supplied as NEAR_AI_KEY_ACME_FILE is not a plain secret and the relay starts', async () => {
  await withScratch(async (scratch) => {
    const file = await secretFile(scratch, 'near_ai_key_acme', FAKE_TENANT);
    const run = await runAndStop({ NEAR_AI_KEY_ACME_FILE: file }, scratch.stateDir);
    await assertNoLeak(scratch.stateDir, [FAKE_TENANT], run);
  });
});

test('a secret file open to group or others stops the relay with relay.start_refused reason secrets, naming the secret and not the value', async () => {
  await withScratch(async (scratch) => {
    const teamsFile = await secretFile(scratch, 'teams_app_secret', FAKE_TEAMS, 0o644);
    const run = launch({ RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: scratch.stateDir, TEAMS_APP_SECRET_FILE: teamsFile });
    const exit = await within(run.exited, 5000, 'the relay refusing a 0644 secret file');
    assert.equal(exit.code, 1);
    const refused = logLines(run).find((line) => line.event === 'relay.start_refused');
    assert.ok(refused, 'no relay.start_refused line');
    assert.equal(refused.reason, 'secrets');
    assert.match(String(refused.detail), /TEAMS_APP_SECRET/);
    assert.match(String(refused.detail), /chmod 600/);
    assert.ok(!run.stdout().includes(FAKE_TEAMS), 'the secret value was echoed into the log');
    assert.ok(!run.stderr().includes(FAKE_TEAMS));
  });
});

test('with LOG_PSEUDONYM_KEY_FILE the relay writes no log-pseudonym.key, logs source secret, and the fake key value appears nowhere', async () => {
  await withScratch(async (scratch) => {
    const keyFile = await secretFile(scratch, 'log_pseudonym_key', FAKE_PSEUDONYM);
    const teamsFile = await secretFile(scratch, 'teams_app_secret', FAKE_TEAMS);
    const run = await runAndStop({ LOG_PSEUDONYM_KEY_FILE: keyFile, TEAMS_APP_SECRET_FILE: teamsFile }, scratch.stateDir);

    assert.equal(await exists(path.join(scratch.stateDir, 'log-pseudonym.key')), false, 'a key file was written although the operator supplied the key');
    const loaded = logLines(run).find((line) => line.event === 'secrets.loaded');
    assert.equal(loaded?.names, 'TEAMS_APP_SECRET,LOG_PSEUDONYM_KEY');
    assert.equal(loaded?.count, 2);
    assert.equal(logLines(run).find((line) => line.event === 'log.pseudonym_key')?.source, 'secret');
    assert.equal(run.stderr(), '');
    await assertNoLeak(scratch.stateDir, [FAKE_PSEUDONYM, FAKE_TEAMS], run);
  });
});

test('without a supplied key the relay creates log-pseudonym.key at mode 0600 once and reuses it on the next start', async () => {
  await withScratch(async (scratch) => {
    const first = await runAndStop({}, scratch.stateDir);
    const keyPath = path.join(scratch.stateDir, 'log-pseudonym.key');
    const info = await stat(keyPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.size, 32);
    assert.equal(logLines(first).find((line) => line.event === 'log.pseudonym_key')?.source, 'created');
    const bytes = await readFile(keyPath);
    assert.ok(!first.stdout().includes(bytes.toString('hex')) && !first.stdout().includes(bytes.toString('base64')), 'the key value reached stdout');

    const second = await runAndStop({}, scratch.stateDir);
    assert.equal(logLines(second).find((line) => line.event === 'log.pseudonym_key')?.source, 'state-file');
    assert.deepEqual(await readFile(keyPath), bytes);
    assert.ok(!second.stdout().includes(bytes.toString('hex')) && !second.stdout().includes(bytes.toString('base64')));
  });
});

test('a damaged log-pseudonym.key stops the relay with relay.start_refused reason state-dir naming the file', async () => {
  await withScratch(async (scratch) => {
    await mkdir(scratch.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(scratch.stateDir, 'log-pseudonym.key'), Buffer.alloc(31, 3), { mode: 0o600 });
    const run = launch({ RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: scratch.stateDir });
    const exit = await within(run.exited, 5000, 'the relay refusing a damaged key file');
    assert.equal(exit.code, 1);
    const refused = logLines(run).find((line) => line.event === 'relay.start_refused');
    assert.equal(refused?.reason, 'state-dir');
    assert.match(String(refused?.detail), /log-pseudonym\.key/);
  });
});

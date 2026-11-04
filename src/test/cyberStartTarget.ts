import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

// Starts a fixture target as a real child process: plain `node server.js`, no container, no
// dependency install, and 127.0.0.1 on ports the OS chooses. The fixtures live at
// test/fixtures/cyber (source tree), which is not compiled, so the path is resolved from this
// module's compiled location (dist/test) up to the repository root.

export type FixtureKind = 'vulnerable' | 'patched';

export interface FixtureTarget {
  kind: FixtureKind;
  /** The fixture directory itself: what the workspace, IaC, secrets, and dependency probes scan. */
  fixtureDir: string;
  httpUrl: string;
  tlsUrl: string;
  pid: number;
  close(): Promise<void>;
}

const READY_TIMEOUT_MS = 10_000;
const TERM_GRACE_MS = 2_000;

export function fixtureDirFor(kind: FixtureKind): string {
  return path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'cyber', kind);
}

/** Reads `READY <httpPort> <tlsPort>` from the child's stdout. */
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<{ httpPort: number; tlsPort: number }> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => finish(new Error(`The fixture target did not print a READY line within ${timeoutMs} ms.`)), timeoutMs);
    const finish = (error?: Error, ports?: { httpPort: number; tlsPort: number }) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve(ports!);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const match = /READY (\d+) (\d+)/.exec(buffered);
      if (match) finish(undefined, { httpPort: Number(match[1]), tlsPort: Number(match[2]) });
    };
    const onExit = (code: number | null) => finish(new Error(`The fixture target exited with code ${code} before printing READY.`));
    const onError = (error: Error) => finish(error);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/** Terminates the child and, when it was detached, its whole process group. */
function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const send = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* already gone */ }
    };
    const force = setTimeout(() => send('SIGKILL'), TERM_GRACE_MS);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    send('SIGTERM');
  });
}

/** Starts one fixture target offline and resolves once it is answering. */
export async function startTarget(kind: FixtureKind): Promise<FixtureTarget> {
  const fixtureDir = fixtureDirFor(kind);
  const child = spawn(process.execPath, ['server.js'], { cwd: fixtureDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  let ports: { httpPort: number; tlsPort: number };
  try {
    ports = await waitForReady(child, READY_TIMEOUT_MS);
  } catch (error) {
    await stop(child);
    const detail = stderr.trim();
    throw new Error(`${(error as Error).message}${detail ? `\n${detail}` : ''}`);
  }
  return {
    kind,
    fixtureDir,
    httpUrl: `http://127.0.0.1:${ports.httpPort}/`,
    tlsUrl: `https://127.0.0.1:${ports.tlsPort}/`,
    pid: child.pid!,
    close: () => stop(child)
  };
}

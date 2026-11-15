import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type RelayConfig } from './config';
import { HealthRegistry } from './health';
import { createRelayServer, listen } from './http/server';

declare const __RELAY_VERSION__: string;

// Composition root, built to dist/app.mjs. Plans 04 and 06 insert the state directory, secrets and store steps between settings and listen.
// No output path exists before the redacting logger (D-11): refusals and crashes exit 1 without printing anything.

const SHUTDOWN_GRACE_MS = 5000;

export async function runHealthcheck(config: RelayConfig): Promise<number> {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const authority = host.includes(':') ? `[${host}]` : host;
  try {
    const response = await fetch(`http://${authority}:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (response.status !== 200) return 1;
    const body: unknown = await response.json();
    const version = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined;
    return typeof version === 'string' ? 0 : 1;
  } catch {
    return 1;
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  process.umask(0o077);
  process.on('uncaughtException', () => process.exit(1));
  process.on('unhandledRejection', () => process.exit(1));

  const healthcheck = argv.length === 1 && argv[0] === '--healthcheck';
  if (argv.length > 0 && !healthcheck) {
    process.exitCode = 1;
    return;
  }

  let config: RelayConfig;
  try {
    config = loadConfig(process.env, { stateDir: path.resolve(fileURLToPath(new URL('../state/', import.meta.url))) });
  } catch {
    process.exitCode = 1;
    return;
  }

  if (healthcheck) {
    process.exitCode = await runHealthcheck(config);
    return;
  }

  const health = new HealthRegistry({ version: __RELAY_VERSION__, startedAt: Date.now() });
  const server = createRelayServer({ health });
  try {
    await listen(server, config.host, config.port);
  } catch {
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

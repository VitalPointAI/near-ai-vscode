import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type RelayConfig } from './config';
import { HealthRegistry } from './health';
import { createRelayServer, listen } from './http/server';
import { Logger } from './log/logger';
import { Redactor } from './log/redact';

declare const __RELAY_VERSION__: string;

// Composition root, built to dist/app.mjs. Plans 04 and 06 insert the state directory, secrets and store steps between settings and listen.
// The Redactor and the Logger are created first (D-11): every line the relay prints goes through them, and a failed start prints one
// relay.start_refused line that names the setting and never its value.

const SHUTDOWN_GRACE_MS = 5000;

export async function runHealthcheck(config: RelayConfig, logger: Logger): Promise<number> {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  const authority = host.includes(':') ? `[${host}]` : host;
  try {
    const response = await fetch(`http://${authority}:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (response.status !== 200) {
      logger.error('relay.healthcheck_failed', { status: response.status });
      return 1;
    }
    const body: unknown = await response.json();
    const version = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined;
    if (typeof version !== 'string') {
      logger.error('relay.healthcheck_failed', { status: response.status, reason: 'no-version' });
      return 1;
    }
    return 0;
  } catch (error) {
    logger.error('relay.healthcheck_failed', { error: error instanceof Error ? error.name : 'unknown' });
    return 1;
  }
}

/** Fields for relay.crashed: the error name, its code and its message as detail. The Logger's Redactor still sees the message. */
export function crashFields(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    return { name: reason.name, code: typeof code === 'string' || typeof code === 'number' ? code : null, detail: reason.message };
  }
  return { name: 'NonError', code: null, detail: typeof reason === 'string' ? reason : typeof reason };
}

export async function main(argv: readonly string[]): Promise<void> {
  process.umask(0o077);

  // Until plan 06 installs the D-18 key, phone labels use a key that lives only as long as this process.
  const redactor = new Redactor();
  redactor.setPseudonymKey(randomBytes(32));
  const logger = new Logger(redactor);

  process.on('uncaughtException', (error) => {
    logger.error('relay.crashed', crashFields(error));
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('relay.crashed', crashFields(reason));
    process.exit(1);
  });

  const healthcheck = argv.length === 1 && argv[0] === '--healthcheck';
  if (argv.length > 0 && !healthcheck) {
    logger.error('relay.start_refused', { reason: 'config', detail: 'unknown argument; the relay accepts only --healthcheck' });
    process.exitCode = 1;
    return;
  }

  let config: RelayConfig;
  try {
    config = loadConfig(process.env, { stateDir: path.resolve(fileURLToPath(new URL('../state/', import.meta.url))) });
  } catch (error) {
    logger.error('relay.start_refused', { reason: 'config', detail: error instanceof Error ? error.message : 'invalid settings' });
    process.exitCode = 1;
    return;
  }

  if (healthcheck) {
    process.exitCode = await runHealthcheck(config, logger);
    return;
  }

  const health = new HealthRegistry({ version: __RELAY_VERSION__, startedAt: Date.now() });
  const server = createRelayServer({
    health,
    onRejected: (route, method, status) => {
      const fields = { route, method, status };
      if (status >= 500) logger.error('http.rejected', fields);
      else logger.warn('http.rejected', fields);
    },
  });
  let port: number;
  try {
    port = await listen(server, config.host, config.port);
  } catch (error) {
    logger.error('relay.start_refused', { reason: 'listen', detail: error instanceof Error ? error.message : 'listen failed' });
    process.exitCode = 1;
    return;
  }
  logger.info('relay.listening', { host: config.host, port, version: __RELAY_VERSION__ });

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('relay.stopping', { signal });
    setTimeout(() => {
      logger.error('relay.stop_timeout', { graceMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    server.close(() => {
      logger.info('relay.stopped');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

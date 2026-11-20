// Copied from relay/src/main.ts and adapted for the hub (D-28).
import { createPrivateKey, X509Certificate } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type HubConfig } from './config';
import { HealthRegistry } from './health';
import { createHubServer, listen, TLS_VERSION, type HubTls } from './http/server';
import { KeyFileError, readEncryptionKey, readSigningKey, type HubEncryptionKey, type HubSigningKey } from './keys';
import { Logger } from './log/logger';
import { Redactor } from './log/redact';
import { HUB_SECRETS, loadSecrets, refusePlainSecretEnv, SecretError } from './secrets';
import { finishStartup } from './startup';
import { prepareStateDir, StateDirError } from './stateDir';

declare const __HUB_VERSION__: string;

// Composition root, built to dist/app.mjs. Startup order: settings, plain-secret refusal, state directory, secrets, keys, TLS pair, server.
// The Redactor and the Logger are created first (D-26): every line the hub prints goes through them, and a failed start prints one
// hub.start_refused line that names the setting and never its value.
//
// The hub opens no outbound connection (D-62). The one connection it makes is --healthcheck, which runs as its own short process and connects to
// the hub itself on its own host and port.

const SHUTDOWN_GRACE_MS = 5000;
const HEALTHCHECK_TIMEOUT_MS = 2000;

class TlsPairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsPairError';
  }
}

/** Checks the certificate and key parse and belong together, so a wrong pair stops startup with a plain sentence instead of an OpenSSL error. */
export function checkTlsPair(tls: HubTls): void {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(tls.cert);
  } catch {
    throw new TlsPairError('HUB_TLS_CERT is not a readable PEM certificate.');
  }
  let key;
  try {
    key = createPrivateKey(tls.key);
  } catch {
    throw new TlsPairError('HUB_TLS_KEY is not a readable PEM private key without a passphrase.');
  }
  if (!certificate.checkPrivateKey(key)) throw new TlsPairError('HUB_TLS_CERT and HUB_TLS_KEY do not belong together: the key is not the key of that certificate.');
}

/** The address --healthcheck connects to: the hub's own host, with a wildcard bind mapped to loopback. */
export function healthcheckHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
}

export async function runHealthcheck(config: HubConfig, logger: Logger): Promise<number> {
  const host = healthcheckHost(config.host);
  const result = await new Promise<{ status: number; body: string } | { error: string }>((resolve) => {
    const request = https.request(
      {
        host,
        port: config.port,
        path: '/healthz',
        method: 'GET',
        agent: false,
        // The check proves the hub answers; it is not a trust decision, and the hub's certificate may be self-signed.
        rejectUnauthorized: false,
        minVersion: TLS_VERSION,
        timeout: HEALTHCHECK_TIMEOUT_MS,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (text.length < 4096) text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
        response.on('error', (error) => resolve({ error: error.name }));
      },
    );
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    request.on('error', (error) => resolve({ error: error.name }));
    request.end();
  });
  if ('error' in result) {
    logger.error('hub.healthcheck_failed', { error: result.error });
    return 1;
  }
  if (result.status !== 200) {
    logger.error('hub.healthcheck_failed', { status: result.status });
    return 1;
  }
  let version: unknown;
  try {
    const parsed: unknown = JSON.parse(result.body);
    version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
  } catch {
    version = undefined;
  }
  if (typeof version !== 'string') {
    logger.error('hub.healthcheck_failed', { status: result.status, reason: 'no-version' });
    return 1;
  }
  return 0;
}

/** Fields for hub.crashed: the error name, its code and its message as detail. The Logger's Redactor still sees the message. */
export function crashFields(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    return { name: reason.name, code: typeof code === 'string' || typeof code === 'number' ? code : null, detail: reason.message };
  }
  return { name: 'NonError', code: null, detail: typeof reason === 'string' ? reason : typeof reason };
}

export async function main(argv: readonly string[]): Promise<void> {
  process.umask(0o077);

  const redactor = new Redactor();
  const logger = new Logger(redactor);

  process.on('uncaughtException', (error) => {
    logger.error('hub.crashed', crashFields(error));
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('hub.crashed', crashFields(reason));
    process.exit(1);
  });

  const healthcheck = argv.length === 1 && argv[0] === '--healthcheck';
  if (argv.length > 0 && !healthcheck) {
    logger.error('hub.start_refused', { reason: 'config', detail: 'unknown argument; the hub accepts only --healthcheck' });
    process.exitCode = 1;
    return;
  }

  let config: HubConfig;
  try {
    config = loadConfig(process.env, { stateDir: path.resolve(fileURLToPath(new URL('../state/', import.meta.url))) });
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'config', detail: error instanceof Error ? error.message : 'invalid settings' });
    process.exitCode = 1;
    return;
  }

  if (healthcheck) {
    process.exitCode = await runHealthcheck(config, logger);
    return;
  }

  // A secret given as a plain environment value stops startup before the state directory is touched.
  try {
    refusePlainSecretEnv(process.env);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'secrets', detail: error instanceof SecretError ? error.message : 'a secret setting is not acceptable' });
    process.exitCode = 1;
    return;
  }

  try {
    await prepareStateDir(config.stateDir, logger);
  } catch (error) {
    logger.error('hub.start_refused', {
      reason: 'state-dir',
      detail: error instanceof StateDirError ? error.message : 'the state directory could not be prepared',
    });
    process.exitCode = 1;
    return;
  }

  let secrets: ReadonlyMap<string, string>;
  try {
    secrets = await loadSecrets(HUB_SECRETS, { env: process.env }, redactor);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'secrets', detail: error instanceof SecretError ? error.message : 'the secrets could not be loaded' });
    process.exitCode = 1;
    return;
  }
  logger.info('secrets.loaded', { names: [...secrets.keys()].join(','), count: secrets.size });

  let signing: HubSigningKey;
  let encryption: HubEncryptionKey;
  try {
    signing = readSigningKey(secrets.get('HUB_SIGNING_KEY') ?? '');
    encryption = readEncryptionKey(secrets.get('HUB_ENCRYPTION_KEY') ?? '', signing);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'keys', detail: error instanceof KeyFileError ? error.message : 'the hub keys could not be read' });
    process.exitCode = 1;
    return;
  }
  void encryption; // held for the base cell grants (32-20); never logged

  const tls: HubTls = { cert: secrets.get('HUB_TLS_CERT') ?? '', key: secrets.get('HUB_TLS_KEY') ?? '' };
  try {
    checkTlsPair(tls);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'tls', detail: error instanceof TlsPairError ? error.message : 'the TLS certificate and key could not be used' });
    process.exitCode = 1;
    return;
  }

  const health = new HealthRegistry({ version: __HUB_VERSION__, startedAt: Date.now() });
  let server;
  try {
    server = createHubServer({
      tls,
      health,
      onRejected: (route, method, status) => {
        const fields = { route, method, status };
        if (status >= 500) logger.error('http.rejected', fields);
        else logger.warn('http.rejected', fields);
      },
    });
  } catch {
    logger.error('hub.start_refused', { reason: 'tls', detail: 'the TLS certificate and key could not be used' });
    process.exitCode = 1;
    return;
  }
  const openServer = server;
  let port: number;
  try {
    port = await listen(openServer, config.host, config.port);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'listen', detail: error instanceof Error ? error.message : 'listen failed' });
    process.exitCode = 1;
    return;
  }
  // Everything hub.listening needs is read before the signal handlers go in, and the handlers go in before hub.listening is logged: a
  // supervisor or test that reacts to that line by sending SIGTERM must always get a clean stop. finishStartup keeps that order.
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('hub.stopping', { signal });
    setTimeout(() => {
      logger.error('hub.stop_timeout', { graceMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    openServer.close(() => {
      logger.info('hub.stopped');
      process.exit(0);
    });
    openServer.closeIdleConnections();
  };
  await finishStartup({
    read: async () => signing.writer,
    signals: process,
    stop,
    announce: (writer) =>
      logger.info('hub.listening', { host: config.host, port, version: __HUB_VERSION__, writer, publicAddress: config.publicAddress ?? null }),
  });
}

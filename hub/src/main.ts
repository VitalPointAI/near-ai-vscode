// Copied from relay/src/main.ts and adapted for the hub (D-28).
import { createPrivateKey, X509Certificate } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TLSSocket } from 'node:tls';
import type { SessionExpectation, SessionRead } from '@ext/domain/replica/hubFile';
import { RosterCache } from './append/rosterCache';
import { Checkpointer, type CheckpointLog } from './checkpoints';
import { loadConfig, type HubConfig } from './config';
import { HUB_FILE_DAYS, hubIdentityOf, issueHubFile, type HubIdentity } from './enrol';
import { HealthRegistry } from './health';
import { createRoutes, type RouteDeps } from './http/routes';
import { createHubServer, listen, TLS_VERSION, type HubTls, type RejectedRoute } from './http/server';
import { SessionRegistry } from './http/session';
import { EventHub, realScheduler, type Scheduler } from './live/events';
import { PresenceHub } from './live/presence';
import { RateLimits, type RateLimitOptions } from './limits';
import { openHubStore, StoreError, type HubStore } from './store/hubStore';
import { generateKeyFile, KEY_KINDS, KeyFileError, readEncryptionKey, readSigningKey, type HubEncryptionKey, type HubSigningKey } from './keys';
import { Logger, printKeyFile, stdoutLine } from './log/logger';
import { Redactor } from './log/redact';
import { HUB_SECRETS, loadSecrets, refusePlainSecretEnv, SecretError } from './secrets';
import { finishStartup } from './startup';
import { prepareStateDir, StateDirError } from './stateDir';

declare const __HUB_VERSION__: string;

// Composition root, built to dist/app.mjs. Startup order: settings, plain-secret refusal, state directory, secrets, keys, TLS pair, store, the
// hub's identity (keys and certificate pin), roster cache, sessions, routes, the checkpoint signer (32-22, listening on the event channel), server.
// composeHub is the one place the parts are wired, and the tests' in-process hub (test/helpers/hubHarness.ts) calls it too, so what the tests run
// is what the binary runs.
//
// --hub-file <days> (D-41, default 7) prints one signed hub file for the operator to give the staff lead, and nothing else on stdout: no info line
// before or after it, only a hub.start_refused line when it cannot.
// The Redactor and the Logger are created first (D-26): every line the hub prints goes through them, and a failed start prints one
// hub.start_refused line that names the setting and never its value.
//
// The hub opens no outbound connection (D-62). The one connection it makes is --healthcheck, which runs as its own short process and connects to
// the hub itself on its own host and port.

const SHUTDOWN_GRACE_MS = 5000;
/** How often blobs no entry referenced within 24 hours of upload are removed (D-44). */
export const BLOB_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
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

export interface HubParts {
  store: HubStore;
  identity: HubIdentity;
  tls: HubTls;
  health: HealthRegistry;
  /** Milliseconds; Date.now unless a test drives the clock. */
  now?: () => number;
  /** The authentication deadline (10 seconds unless a test shortens it). */
  deadlineMs?: number;
  rateLimits?: RateLimitOptions;
  readAnswer?: (answer: unknown, expected: SessionExpectation) => SessionRead;
  /** The timers of the event streams; real timers unless a test moves time by hand. */
  scheduler?: Scheduler;
  onAccepted?: RouteDeps['onAccepted'];
  onEquivocation?: RouteDeps['onEquivocation'];
  onFailure?: RouteDeps['onFailure'];
  onRejected?: (route: RejectedRoute, method: string, status: number) => void;
  /** Signed checkpoints (32-22): on unless a test turns them off. */
  signCheckpoints?: boolean;
  /** The checkpointer's log lines (project id, counts and a reason word). */
  onCheckpointLog?: CheckpointLog;
}

export interface ComposedHub {
  server: https.Server;
  sessions: SessionRegistry;
  cache: RosterCache;
  limits: RateLimits;
  events: EventHub;
  presence: PresenceHub;
  /** The checkpoint signer, listening on the events channel; undefined when turned off. */
  checkpoints: Checkpointer | undefined;
}

/** Wires the roster cache, sessions, rate limits and routes onto one TLS server, and gives the health check its store probe. */
export function composeHub(parts: HubParts): ComposedHub {
  const now = parts.now ?? Date.now;
  const { store, identity } = parts;
  const cache = new RosterCache(store, identity, { now: () => new Date(now()) });
  const limits = new RateLimits(parts.rateLimits);
  const sessions = new SessionRegistry({
    hub: identity.writer,
    store,
    cache,
    now,
    ...(parts.deadlineMs === undefined ? {} : { deadlineMs: parts.deadlineMs }),
    ...(parts.readAnswer === undefined ? {} : { readAnswer: parts.readAnswer }),
  });
  const scheduler = parts.scheduler === undefined ? {} : { scheduler: parts.scheduler };
  const events = new EventHub({ now, ...scheduler });
  const presence = new PresenceHub(events, { now, ...scheduler, accessList: async (project, cell) => (await cache.get(project)).accessList(cell) });
  const routes = createRoutes({
    store,
    cache,
    sessions,
    limits,
    identity,
    now,
    events,
    presence,
    ...(parts.onAccepted === undefined ? {} : { onAccepted: parts.onAccepted }),
    ...(parts.onEquivocation === undefined ? {} : { onEquivocation: parts.onEquivocation }),
    ...(parts.onFailure === undefined ? {} : { onFailure: parts.onFailure }),
  });
  const checkpoints =
    parts.signCheckpoints === false
      ? undefined
      : new Checkpointer({
          store,
          cache,
          identity,
          events,
          scheduler: parts.scheduler ?? realScheduler,
          now,
          ...(parts.onCheckpointLog === undefined ? {} : { log: parts.onCheckpointLog }),
        }).listen(events.channel);
  parts.health.setStoreProbe(async () => {
    if (store.damaged() !== undefined) return 'down';
    store.schemaVersion();
    return 'ok';
  });
  const server = createHubServer({
    tls: parts.tls,
    health: parts.health,
    handler: routes,
    onSecureConnection: (socket: TLSSocket) => sessions.authDeadline(socket),
    ...(parts.onRejected === undefined ? {} : { onRejected: parts.onRejected }),
  });
  return { server, sessions, cache, limits, events, presence, checkpoints };
}

/** One sweep of blobs no entry referenced within 24 hours of upload; the hub runs it every hour. Returns how many were removed. */
export function sweepBlobsOnce(store: HubStore, now: number): Promise<number> {
  return store.sweepBlobs(now);
}

/** The days of --hub-file: the default 7 when none is given, a whole number otherwise (issueHubFile checks the range). */
export function hubFileDays(argv: readonly string[]): number | undefined {
  if (argv.length === 1) return HUB_FILE_DAYS.default;
  if (argv.length !== 2 || !/^\d{1,3}$/.test(argv[1] as string)) return undefined;
  return Number(argv[1]);
}

export async function main(argv: readonly string[]): Promise<void> {
  process.umask(0o077);

  const redactor = new Redactor();
  // --hub-file prints the hub file alone: its logger passes warnings and errors only, so stdout holds one hub file or one refusal.
  const hubFileMode = argv[0] === '--hub-file';
  const logger = hubFileMode
    ? new Logger(redactor, (line) => {
        if (!line.includes('"level":"info"')) stdoutLine(line);
      })
    : new Logger(redactor);

  process.on('uncaughtException', (error) => {
    logger.error('hub.crashed', crashFields(error));
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('hub.crashed', crashFields(reason));
    process.exit(1);
  });

  // --generate-key signing|encryption (D-30) prints one key line and nothing else: no logger line before or after it, no settings read, no
  // secrets read, nothing written to disk. Any other word after it is refused without being repeated.
  if (argv[0] === '--generate-key') {
    const kind = KEY_KINDS.find((candidate) => candidate === argv[1]);
    if (argv.length !== 2 || kind === undefined) {
      logger.error('hub.start_refused', { reason: 'config', detail: 'usage: --generate-key signing, or --generate-key encryption' });
      process.exitCode = 1;
      return;
    }
    await printKeyFile(generateKeyFile(kind));
    return;
  }

  const healthcheck = argv.length === 1 && argv[0] === '--healthcheck';
  const days = hubFileMode ? hubFileDays(argv) : undefined;
  if (hubFileMode && days === undefined) {
    logger.error('hub.start_refused', { reason: 'config', detail: 'usage: --hub-file, or --hub-file followed by a whole number of days from 1 to 30' });
    process.exitCode = 1;
    return;
  }
  if (argv.length > 0 && !healthcheck && !hubFileMode) {
    logger.error('hub.start_refused', { reason: 'config', detail: 'unknown argument; the hub accepts only --healthcheck, --hub-file or --generate-key' });
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

  const tls: HubTls = { cert: secrets.get('HUB_TLS_CERT') ?? '', key: secrets.get('HUB_TLS_KEY') ?? '' };
  try {
    checkTlsPair(tls);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'tls', detail: error instanceof TlsPairError ? error.message : 'the TLS certificate and key could not be used' });
    process.exitCode = 1;
    return;
  }
  // The identity a hub file and hub.admit name: both keys, and the pin of the certificate's key, so a renewal with the same key keeps it.
  const identity = hubIdentityOf(signing, encryption, tls.cert, config.publicAddress);

  // --hub-file opens the store without the blob folder sweep: a running hub may share the folder, and this process writes one enrolment row only.
  let store: HubStore;
  try {
    store = await openHubStore(config.stateDir, { recoverBlobs: !hubFileMode });
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'store', detail: error instanceof StoreError ? error.message : 'the hub store could not be opened' });
    process.exitCode = 1;
    return;
  }

  if (hubFileMode) {
    try {
      const issued = issueHubFile(store, identity, { days: days as number, now: new Date() });
      if (!issued.ok) {
        logger.error('hub.start_refused', { reason: 'config', detail: issued.message });
        process.exitCode = 1;
        return;
      }
      await printKeyFile(JSON.stringify(issued.file));
    } finally {
      store.close();
    }
    return;
  }
  // Counts only, and only when the open found something: a clean start logs no line for the store.
  if (store.openReport.damaged !== undefined) logger.error('store.damaged', { missingBlobFiles: store.openReport.missingBlobFiles });
  if (store.openReport.orphanBlobsRemoved + store.openReport.temporaryFilesRemoved > 0) {
    logger.warn('store.recovered', { orphanBlobsRemoved: store.openReport.orphanBlobsRemoved, temporaryFilesRemoved: store.openReport.temporaryFilesRemoved });
  }
  const openStore = store;

  const health = new HealthRegistry({ version: __HUB_VERSION__, startedAt: Date.now() });
  let composed: ComposedHub;
  try {
    composed = composeHub({
      store: openStore,
      identity,
      tls,
      health,
      onFailure: (route, error) => logger.error('http.failed', { route, name: error instanceof Error ? error.name : 'NonError' }),
      onCheckpointLog: (level, event, fields) => logger[level](event, fields),
      onRejected: (route, method, status) => {
        const fields = { route, method, status };
        if (status >= 500) logger.error('http.rejected', fields);
        else logger.warn('http.rejected', fields);
      },
    });
  } catch {
    openStore.close();
    logger.error('hub.start_refused', { reason: 'tls', detail: 'the TLS certificate and key could not be used' });
    process.exitCode = 1;
    return;
  }
  const openServer = composed.server;
  const sessions = composed.sessions;
  const liveEvents = composed.events;
  const livePresence = composed.presence;
  let port: number;
  try {
    port = await listen(openServer, config.host, config.port);
  } catch (error) {
    openStore.close();
    logger.error('hub.start_refused', { reason: 'listen', detail: error instanceof Error ? error.message : 'listen failed' });
    process.exitCode = 1;
    return;
  }
  // The hourly sweep of abandoned uploads (D-44). unref: it never keeps the process alive on its own.
  let sweeping = false;
  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweepBlobsOnce(openStore, Date.now()).then(
      (removed) => {
        sweeping = false;
        if (removed > 0) logger.info('blobs.swept', { removed });
      },
      (error: unknown) => {
        sweeping = false;
        logger.error('blobs.sweep_failed', { name: error instanceof Error ? error.name : 'NonError' });
      },
    );
  }, BLOB_SWEEP_INTERVAL_MS);
  sweep.unref();
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
    // The relay's order: no new sessions, then the server, then the store once the last request has finished.
    clearInterval(sweep);
    // Open event streams would hold the server open: they end first, then the server stops taking requests.
    liveEvents.closeAll();
    livePresence.close();
    sessions.close();
    openServer.close(() => {
      openStore.close();
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

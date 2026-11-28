// Copied from relay/src/main.ts and adapted for the hub (D-28).
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TLSSocket } from 'node:tls';
import { certPinOf, type SessionExpectation, type SessionRead } from '@ext/domain/replica/hubFile';
import { serverPinWords } from '@ext/domain/replica/serverWords';
import { RosterCache } from './append/rosterCache';
import { Checkpointer, type CheckpointLog } from './checkpoints';
import { loadConfig, type HubConfig } from './config';
import { HUB_FILE_DAYS, hubIdentityOf, issueHubFile, type HubIdentity } from './enrol';
import { HealthRegistry } from './health';
import { createRoutes, type RouteDeps } from './http/routes';
import { createHubServer, endUploads, listen, TLS_VERSION, type HubTls, type RejectedRoute } from './http/server';
import { SessionRegistry } from './http/session';
import { createTrustRoutes } from './http/trustRoutes';
import { JoinDesk, type JoinChecks, type JoinLog } from './join';
import { EventHub, realScheduler, type Scheduler } from './live/events';
import { PresenceHub } from './live/presence';
import { RateLimits, type RateLimitOptions } from './limits';
import { openHubStore, StoreError, type HubStore } from './store/hubStore';
import { TrustStore, type OrganizationSource } from './store/trustStore';
import { exportTrust, importTrust } from './trustTransfer';
import { generateKeyFile, KEY_KINDS, KeyFileError, readEncryptionKey, readKemKey, readSigningKey, type HubEncryptionKey, type HubKemKey, type HubSigningKey } from './keys';
import { Logger, printKeyFile, stdoutLine } from './log/logger';
import { Redactor } from './log/redact';
import { HUB_SECRETS, loadSecrets, refusePlainSecretEnv, SecretError } from './secrets';
import { finishStartup } from './startup';
import { prepareStateDir, StateDirError } from './stateDir';
import { RestoreMode, type RestoreLog } from './restore';

declare const __HUB_VERSION__: string;

// Composition root, built to dist/app.mjs. Startup order: settings, plain-secret refusal, state directory, secrets, keys, TLS pair, store, the
// hub's identity (keys and certificate pin), roster cache, sessions, routes, the checkpoint signer (32-22, listening on the event channel), server.
// composeHub is the one place the parts are wired, and the tests' in-process hub (test/helpers/hubHarness.ts) calls it too, so what the tests run
// is what the binary runs. A stop clears the signer's timers first, then ends event streams, then closes the server and the store.
//
// --pin-words (G541) prints the twelve words of the certificate pin on one line: the words a lead compares with the operator before re-admitting
// the hub, worked out with serverPinWords, the function members' computers use. It reads only the TLS pair, no settings and no state.
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
  /** Event streams one address may hold; LIMITS.eventStreamsPerAddress unless a test lowers it. */
  eventStreamsPerAddress?: number;
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
  /** The signature and MAC checks of a join post (32-25); the real ones unless a test counts them. */
  joinChecks?: JoinChecks;
  /** The join desk's log lines (project id, invite id and a reason word). */
  onJoinLog?: JoinLog;
  /** Your organization's signed rules and key (71-09); without them the trust routes answer 503 and the hub judges no evidence. */
  organization?: OrganizationSource;
  /** The state directory: restore mode is read from its marker at start (Phase 33 D-32). No restore mode when absent. */
  stateDir?: string;
  /** Restore mode's two log lines (an event and a reason word). */
  onRestoreLog?: RestoreLog;
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
  /** Invitations and join requests (32-25); its 7 day removal runs at start and every hour. */
  join: JoinDesk;
  /** The DID logs, status lists and cited status entries the hub hosts (71-09). */
  trust: TrustStore;
  /** Restore mode (Phase 33 D-32); undefined when no state directory was given. */
  restore: RestoreMode | undefined;
}

/** Wires the roster cache, sessions, rate limits and routes onto one TLS server, and gives the health check its store probe. */
export function composeHub(parts: HubParts): ComposedHub {
  const now = parts.now ?? Date.now;
  const { store, identity } = parts;
  const cache = new RosterCache(store, identity, { now: () => new Date(now()) });
  const limits = new RateLimits(parts.rateLimits);
  const trust = new TrustStore(store, parts.organization ?? { text: undefined, key: undefined });
  const sessions = new SessionRegistry({
    hub: identity.writer,
    store,
    cache,
    now,
    underReview: (project, member) => trust.underReview(project, member, now()),
    ...(parts.deadlineMs === undefined ? {} : { deadlineMs: parts.deadlineMs }),
    ...(parts.readAnswer === undefined ? {} : { readAnswer: parts.readAnswer }),
  });
  const scheduler = parts.scheduler === undefined ? {} : { scheduler: parts.scheduler };
  const events = new EventHub({ now, ...scheduler, ...(parts.eventStreamsPerAddress === undefined ? {} : { streamsPerAddress: parts.eventStreamsPerAddress }) });
  const presence = new PresenceHub(events, { now, ...scheduler, accessList: async (project, cell) => (await cache.get(project)).accessList(cell) });
  const join = new JoinDesk({
    store,
    cache,
    identity,
    events,
    now,
    ...(parts.joinChecks === undefined ? {} : { checks: parts.joinChecks }),
    ...(parts.onJoinLog === undefined ? {} : { log: parts.onJoinLog }),
  });
  join.start(parts.scheduler ?? realScheduler);
  // A newer list that sets a bit a member's entries cited ends that member's event streams at once; their next call is refused by the session.
  const endRefused = (): void => {
    events.end((owner) => {
      const member = cache.peek(owner.project)?.deviceOf(owner.writer)?.member;
      return member !== undefined && trust.underReview(owner.project, member, now());
    });
  };
  const restore = parts.stateDir === undefined ? undefined : RestoreMode.fromStateDir(parts.stateDir, { store, cache, now, ...(parts.onRestoreLog === undefined ? {} : { log: parts.onRestoreLog }) });
  const routes = createRoutes({
    trust: createTrustRoutes({ trust, cache, sessions, now, onListStored: endRefused }),
    evidence: trust,
    store,
    cache,
    sessions,
    limits,
    identity,
    now,
    events,
    presence,
    join,
    ...(parts.onAccepted === undefined ? {} : { onAccepted: parts.onAccepted }),
    ...(parts.onEquivocation === undefined ? {} : { onEquivocation: parts.onEquivocation }),
    ...(parts.onFailure === undefined ? {} : { onFailure: parts.onFailure }),
    ...(restore === undefined ? {} : { restore }),
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
  return { server, sessions, cache, limits, events, presence, checkpoints, join, trust, restore };
}

/** One sweep of blobs no entry referenced within 24 hours of upload; the hub runs it every hour. Returns how many were removed. */
export function sweepBlobsOnce(store: HubStore, now: number): Promise<number> {
  return store.sweepBlobs(now);
}

/** Reads your organization's rules file from the configuration; undefined when unset or unreadable. */
async function organizationOf(config: HubConfig): Promise<OrganizationSource> {
  let text: string | undefined;
  if (config.organizationPolicy !== undefined) {
    try {
      text = await readFile(config.organizationPolicy, 'utf8');
    } catch {
      text = undefined;
    }
  }
  return { text, key: config.organizationKey };
}

/** --trust-export or --trust-import against the store; returns the exit code. Every line is a plain sentence; nothing secret is printed. */
async function transfer(flag: string, file: string, store: HubStore, config: HubConfig): Promise<number> {
  const organization = await organizationOf(config);
  const trust = new TrustStore(store, organization);
  const name = path.basename(file);
  if (flag === '--trust-export') {
    const made = exportTrust(trust, organization, Date.now());
    if (!made.ok) {
      stdoutLine(made.message);
      return 1;
    }
    try {
      await writeFile(file, made.text, { flag: 'wx', mode: 0o600 });
    } catch {
      stdoutLine(`${name} could not be written, or already exists. Nothing was written: choose another name.`);
      return 1;
    }
    stdoutLine(`Wrote ${name}: ${String(made.logs)} identity logs and ${String(made.lists)} status lists. Carry it to the edge with the user export.`);
    return 0;
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    stdoutLine(`${name} could not be read. Nothing was imported.`);
    return 1;
  }
  const imported = importTrust(trust, organization, text, Date.now());
  if (!imported.ok) {
    stdoutLine(imported.message);
    return 1;
  }
  for (const line of imported.report.lines) stdoutLine(line);
  const { logs, lists } = imported.report.taken;
  stdoutLine(`Imported ${String(logs)} identity logs and ${String(lists)} status lists from ${name}.`);
  return logs + lists > 0 ? 0 : 1;
}

/** The TLS pair alone, read with the same rules as a start: all that --pin-words needs. */
const TLS_SECRETS = HUB_SECRETS.filter((spec) => spec.name === 'HUB_TLS_CERT' || spec.name === 'HUB_TLS_KEY');

/** --pin-words (G541): one line of the twelve words of the certificate's pin, or one hub.start_refused line. Returns the exit code. */
export async function printPinWords(argv: readonly string[], logger: Logger, redactor: Redactor): Promise<number> {
  if (argv.length !== 1) {
    logger.error('hub.start_refused', { reason: 'config', detail: 'usage: --pin-words, with nothing after it' });
    return 1;
  }
  try {
    refusePlainSecretEnv(process.env);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'secrets', detail: error instanceof SecretError ? error.message : 'a secret setting is not acceptable' });
    return 1;
  }
  let secrets: ReadonlyMap<string, string>;
  try {
    secrets = await loadSecrets(TLS_SECRETS, { env: process.env }, redactor);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'secrets', detail: error instanceof SecretError ? error.message : 'the secrets could not be loaded' });
    return 1;
  }
  const tls: HubTls = { cert: secrets.get('HUB_TLS_CERT') ?? '', key: secrets.get('HUB_TLS_KEY') ?? '' };
  try {
    checkTlsPair(tls);
  } catch (error) {
    logger.error('hub.start_refused', { reason: 'tls', detail: error instanceof TlsPairError ? error.message : 'the TLS certificate and key could not be used' });
    return 1;
  }
  // The pin the hub's identity carries (hubIdentityOf), so the words are those of the certificate the hub serves.
  await printKeyFile(serverPinWords(certPinOf(tls.cert)).join(' '));
  return 0;
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
  const pinWordsMode = argv[0] === '--pin-words';
  // --trust-export <file> at HQ and --trust-import <file> at an edge (71-11): one run against this hub's store, then exit; plain lines only.
  const transferMode = argv[0] === '--trust-export' || argv[0] === '--trust-import';
  const logger = hubFileMode || pinWordsMode || transferMode
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
      logger.error('hub.start_refused', { reason: 'config', detail: 'usage: --generate-key signing, --generate-key encryption, or --generate-key kem' });
      process.exitCode = 1;
      return;
    }
    await printKeyFile(generateKeyFile(kind));
    return;
  }

  if (pinWordsMode) {
    process.exitCode = await printPinWords(argv, logger, redactor);
    return;
  }

  const healthcheck = argv.length === 1 && argv[0] === '--healthcheck';
  const days = hubFileMode ? hubFileDays(argv) : undefined;
  if (hubFileMode && days === undefined) {
    logger.error('hub.start_refused', { reason: 'config', detail: 'usage: --hub-file, or --hub-file followed by a whole number of days from 1 to 30' });
    process.exitCode = 1;
    return;
  }
  if (transferMode && (argv.length !== 2 || (argv[1] as string).startsWith('--'))) {
    logger.error('hub.start_refused', { reason: 'config', detail: 'usage: --trust-export <file>, or --trust-import <file>' });
    process.exitCode = 1;
    return;
  }
  if (argv.length > 0 && !healthcheck && !hubFileMode && !transferMode) {
    logger.error('hub.start_refused', { reason: 'config', detail: 'unknown argument; the hub accepts only --healthcheck, --hub-file, --pin-words, --trust-export, --trust-import or --generate-key' });
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
  let kem: HubKemKey | undefined;
  try {
    signing = readSigningKey(secrets.get('HUB_SIGNING_KEY') ?? '');
    encryption = readEncryptionKey(secrets.get('HUB_ENCRYPTION_KEY') ?? '', signing);
    // The post-quantum keys are optional (33.2 D-03): without HUB_KEM_KEY the hub works as before and receives v1 wraps only.
    const kemLine = secrets.get('HUB_KEM_KEY');
    kem = kemLine === undefined ? undefined : readKemKey(kemLine, signing);
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
  const identity = hubIdentityOf(signing, encryption, tls.cert, config.publicAddress, kem);

  // --hub-file opens the store without the blob folder sweep: a running hub may share the folder, and this process writes one enrolment row only.
  let store: HubStore;
  try {
    store = await openHubStore(config.stateDir, { recoverBlobs: !hubFileMode && !transferMode });
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
  if (transferMode) {
    try {
      process.exitCode = await transfer(argv[0] as string, argv[1] as string, store, config);
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

  // Your organization's rules for the trust routes (71-09). A file that cannot be read leaves the routes answering 503; the projects keep syncing.
  const organization = await organizationOf(config);
  if (config.organizationPolicy !== undefined && organization.text === undefined) logger.warn('trust.policy_unreadable', { setting: 'HUB_ORGANIZATION_POLICY' });

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
      onJoinLog: (level, event, fields) => logger[level](event, fields),
      organization,
      stateDir: config.stateDir,
      onRestoreLog: (level, event, fields) => logger[level](event, fields),
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
  const checkpointer = composed.checkpoints;
  const joinDesk = composed.join;
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
    joinDesk.stop();
    // No checkpoint is signed once stopping starts: pending debounce timers are cleared and a running job stores nothing. A line (a count only)
    // only when a timer was pending, so an idle stop logs exactly what it did before.
    const timersCleared = checkpointer?.stop() ?? 0;
    if (timersCleared > 0) logger.info('checkpoints.stopped', { timersCleared });
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
    // A body still arriving (a slow upload may take minutes under the minimum-rate rule) would hold the server past the grace: it is ended.
    endUploads(openServer);
  };
  await finishStartup({
    read: async () => signing.writer,
    signals: process,
    stop,
    announce: (writer) =>
      logger.info('hub.listening', { host: config.host, port, version: __HUB_VERSION__, writer, publicAddress: config.publicAddress ?? null }),
  });
}

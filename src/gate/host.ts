// The gate's host (GATE-04, GATE-07, OFFL-02): started once at activation, it checks or creates the policy bundle, keeps the state every run's gate reads,
// and gives each run its runtime with a sink that writes to the project's decision log in global storage. No vscode import: the activation adapter
// (src/services/gateCommands.ts) hands it the storage folder and the secret store.
//
// start() never throws and never rejects. Any error (a secret store that refuses, a full disk, a lock) leaves the gate in a failed-closed state with its plain
// sentence, so only reading and planning run until the person fixes it, and the rest of the extension carries on. A bundle that expires while the window is
// open is noticed at the next decision, with no file read.
import { randomUUID } from 'node:crypto';
import { failedClosed } from '../domain/gate/bundle';
import type { BundleState, GateContextName } from '../domain/gate/bundle';
import type { ActorRef, GateRuntime, Presence } from '../domain/gate/decide';
import { buildDecisionRecord } from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord } from '../domain/gate/record';
import type { SecretStorageLike } from '../services/auth';
import { ensurePolicyBundle, resetPolicyToDefaults } from './bundleStore';
import type { BundleEvent, BundleResult } from './bundleStore';
import { readLastValid } from './clockMarker';
import { DecisionLog, INSTALL_LOG_KEY, projectLogKey } from './decisionLog';
import type { SessionRoute } from './sessionMark';

const DEVICE_UNKNOWN = 'device-unknown';
const POLICY_SESSION = 'policy';
/** The session id of a model request made outside every session route. */
export const NO_SESSION_ID = 'no-session';
const START_FAILED_DETAIL = 'The policy check threw before it could finish.';

/**
 * The most project logs the host keeps open at once. A log is a small object with a write queue, but a long session that opens folder after folder would
 * otherwise keep one per folder for good: past this many, the one used longest ago is let go (after its queued records are written), and a later record
 * for that folder opens it again. Folder changes let go of closed folders' logs sooner (retainProjectLogs).
 */
export const MAX_PROJECT_LOGS = 8;

/** How long a run waits for the policy check at activation before it is refused as "not loaded": long enough for a healthy start, short enough that a stuck one does not hang the run. */
export const RUNTIME_START_WAIT_MS = 5000;

export interface GateHostOptions {
  readonly globalStorageDir: string;
  readonly secrets: SecretStorageLike;
  readonly productVersion: string;
  /**
   * The open project, whose log also receives the bundle's own events (policy.load and the rest). A function is asked at the time of each record, so a folder
   * opened or changed after activation is followed. None when no folder is open; the install's own log gets them either way.
   */
  readonly projectRoot?: string | (() => string | undefined);
  /** Called once per log, with a plain message, when a record could not be written. */
  readonly onProblem?: (message: string) => void;
  /** The clock for the bundle store and for records. Tests pass a fixed one. */
  readonly now?: () => Date;
  /** How long `runtimeFor` waits for the start to finish. Defaults to RUNTIME_START_WAIT_MS; tests pass a short one. */
  readonly startWaitMs?: number;
  /** The person's home folder, for the floor's credential-store checks of shell commands (D-16). The activation adapter passes it; a test leaves it out or gives a stand-in. */
  readonly home?: string;
}

export interface RuntimeRequest {
  /** The open project, whose log receives the run's records. None (or empty) for a window with no folder: the bundle is per install, so the run is still decided by it, and its records go to the install log. */
  readonly root?: string;
  readonly actor: Omit<ActorRef, 'deviceFingerprint'>;
  readonly presence: Presence;
  readonly context: GateContextName;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : START_FAILED_DETAIL;
}

export class GateHost {
  private current: BundleState = failedClosed('identity-unavailable', 'The gate has not finished starting.');
  private starting: Promise<BundleState> | undefined;
  /** True once the start has finished and `current` is what it found. */
  private settled = false;
  /** The latest time this host has seen (the clock marker's time, then every clock reading). It never decreases, so a clock set back cannot revive an expired policy. */
  private highWater = 0;
  /** Open logs by key, in the order they were last used (the install log included; it is never let go). */
  private readonly logs = new Map<string, DecisionLog>();
  /**
   * Logs let go while records were still queued, by key, until their queue is written: flush() waits for them, and a reopen of the same key takes the log
   * back instead of making a second writer for the file (PR #74 review round 4).
   */
  private readonly retiring = new Map<string, { readonly log: DecisionLog; readonly pending: Promise<void> }>();
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly options: GateHostOptions) {}

  /** Checks or creates the bundle, records what happened, and returns the state. Never throws. Calling it again returns the first answer. */
  public start(): Promise<BundleState> {
    this.starting ??= this.begin();
    return this.starting;
  }

  /** Resolves with the state once the host has started (and starts it if nobody has). */
  public state(): Promise<BundleState> {
    return this.start();
  }

  /** What every decision reads now. A bundle that has expired since it was checked reads as expired, so a long session never runs on an old policy, and one that has expired stays expired when the clock is set back. */
  public bundleState(): BundleState {
    const state = this.current;
    if (state.state === 'valid' && Date.parse(state.expiresAt) <= this.now()) return failedClosed('expired');
    return state;
  }

  /**
   * The time every expiry and renewal check reads: the later of the clock and the latest time this host has seen, which starts from the clock marker's time
   * (the bundle store never moves that backwards). The status bar and the policy view read it through here too, so no surface shows a policy as valid that a
   * decision would refuse. A clock that gives no number, or throws, leaves the latest time seen.
   */
  public now(): number {
    try {
      const wall = (this.options.now?.() ?? new Date()).getTime();
      if (Number.isFinite(wall) && wall > this.highWater) this.highWater = wall;
    } catch { /* a clock that throws leaves the latest time seen, which is never later than the real time */ }
    return this.highWater;
  }

  /**
   * The runtime of one run: who is acting, whether a person is there and the context, over this host's state and the project's log. It waits
   * (for at most `startWaitMs`) for the start to finish, so a run begun during activation is decided with the real bundle. A start that fails or does not
   * finish in time gives a runtime that is failed closed with a plain sentence, until the start does finish.
   */
  public async runtimeFor(request: RuntimeRequest): Promise<GateRuntime> {
    const notLoaded = await this.waitForStart();
    // Every runtime has a log (PR #74 review round 2): the project's for a run in a folder, the install log for a window with no folder. The key is resolved
    // once, here, and the log is found again by it at each record rather than held, so a log the host has let go (its folder was closed, or too many were
    // open) is opened again by the run's next record, and flush() always waits for it.
    const root = request.root === undefined || request.root === '' ? undefined : request.root;
    const key = root === undefined ? INSTALL_LOG_KEY : projectLogKey(root);
    let usable = true;
    try {
      this.logWithKey(key, root);
    } catch (error) {
      // A log that cannot be set up (its folder lies inside the project) is reported once; decisions carry on unrecorded rather than fail.
      usable = false;
      try { this.options.onProblem?.(error instanceof Error ? error.message : 'NEAR AI could not set up its record of what was allowed or refused.'); } catch { /* ignored */ }
    }
    return {
      bundleState: () => (notLoaded !== undefined && !this.settled ? notLoaded : this.bundleState()),
      sink: { record: (record) => { if (usable) { try { void this.logWithKey(key, root).append(record); } catch { /* reported once above */ } } } },
      actor: { ...request.actor, deviceFingerprint: this.deviceFingerprint() },
      presence: request.presence,
      context: request.context,
      locations: { globalStorage: this.options.globalStorageDir, ...(this.options.home === undefined ? {} : { home: this.options.home }) },
      productVersion: this.options.productVersion,
      clock: () => this.now(),
      newRecordId: () => randomUUID()
    };
  }

  /**
   * The route a model request made outside every session route is decided with (CLAS-06, D-31): this host's policy now, a person with no session, the empty
   * mark (the policy's default label), and records written to the project open at the time of each record, or to the install log with no folder open. It is
   * synchronous, so a request never waits for it; before the start has finished the policy reads as failed closed, which routes the default label as today.
   */
  public sessionRouteWithoutContext(): SessionRoute {
    // The device is read at each record, so a request after the start names the signer the start found.
    const fingerprint = (): string => this.deviceFingerprint();
    return {
      markOf: () => [],
      bundleState: () => this.bundleState(),
      get actor() { return { kind: 'person' as const, deviceFingerprint: fingerprint(), sessionId: NO_SESSION_ID }; },
      sink: {
        record: (record) => {
          try {
            const root = this.projectRootNow();
            void (root === undefined ? this.installLog() : this.logFor(root)).append(record);
          } catch { /* a record that cannot be kept never changes a request (D-21) */ }
        }
      },
      clock: () => this.now(),
      newRecordId: () => randomUUID(),
      productVersion: this.options.productVersion,
      attestation: { failed: false }
    };
  }

  /** NEAR AI: Reset Policy to Defaults. Signs a fresh default policy (the old file is kept beside it) and records policy.reset. Throws a plain BundleStoreError when nothing could be changed. */
  public async reset(): Promise<BundleResult> {
    await this.start();
    const result = await resetPolicyToDefaults(this.options.globalStorageDir, this.options.secrets, this.storeOptions());
    await this.seedFromMarker();
    this.current = result.state;
    this.announce(result.event ?? 'policy.reset', result.state);
    this.changed();
    return result;
  }

  public onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Resolves when every record queued so far has been written or has failed, including those of logs already let go. */
  public async flush(): Promise<void> {
    await Promise.all([...[...this.logs.values()].map((log) => log.flush()), ...[...this.retiring.values()].map((retired) => retired.pending)]);
  }

  /**
   * Lets go of the log of every project that is not among `openRoots` (the folders open now) and is not the open project, called when the window's folders
   * change. A run still going in a closed folder opens its log again with its next record, so none of its records is lost.
   */
  public retainProjectLogs(openRoots: readonly string[]): void {
    const keep = new Set([INSTALL_LOG_KEY, ...openRoots.filter((root) => root !== '').map((root) => projectLogKey(root))]);
    const open = this.projectRootNow();
    if (open !== undefined) keep.add(projectLogKey(open));
    for (const key of [...this.logs.keys()]) if (!keep.has(key)) this.retire(key);
  }

  /** The keys of the logs held open now, install log included, least recently used first. For tests and diagnostics. */
  public openLogKeys(): string[] {
    return [...this.logs.keys()];
  }

  /** Waits for the start, up to the bound. Undefined when it finished; otherwise the failed-closed state for a run that began before the policy was loaded. */
  private async waitForStart(): Promise<Extract<BundleState, { state: 'failed-closed' }> | undefined> {
    const bound = this.options.startWaitMs ?? RUNTIME_START_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), bound);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([this.start().then(() => 'done' as const), late]);
      return outcome === 'done' ? undefined : failedClosed('not-loaded', 'The policy check had not finished in time.');
    } catch (error) {
      return failedClosed('not-loaded', detailOf(error));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // Seeds the high-water mark from the marker in secret storage, which only ever holds the latest time this install saw. A marker that cannot be read leaves
  // the mark where the clock put it: the bundle store already failed closed in that case.
  private async seedFromMarker(): Promise<void> {
    try {
      const marker = await readLastValid(this.options.secrets);
      if (marker.present && marker.at !== undefined && marker.at > this.highWater) this.highWater = marker.at;
    } catch { /* see above */ }
  }

  private storeOptions(): { now?: () => Date } {
    return this.options.now === undefined ? {} : { now: this.options.now };
  }

  // The open project at the time of the record. A getter that throws is no folder: the install-level log still gets the record.
  private projectRootNow(): string | undefined {
    const option = this.options.projectRoot;
    if (typeof option !== 'function') return option === '' ? undefined : option;
    try {
      const root = option();
      return root === undefined || root === '' ? undefined : root;
    } catch {
      return undefined;
    }
  }

  private deviceFingerprint(): string {
    return this.current.state === 'valid' ? this.current.signer.fingerprint : DEVICE_UNKNOWN;
  }

  private logFor(root: string): DecisionLog {
    return this.logWithKey(projectLogKey(root), root);
  }

  // The policy's own events always go here: they belong to this install, and a window with no folder has no project log (SECURITY.md).
  private installLog(): DecisionLog {
    return this.logWithKey(INSTALL_LOG_KEY);
  }

  private logWithKey(key: string, projectRoot?: string): DecisionLog {
    // One log per key: a log being let go is taken back, so its queue and the new records stay in one writer's order.
    let log = this.logs.get(key) ?? this.retiring.get(key)?.log;
    this.retiring.delete(key);
    if (log === undefined) {
      log = new DecisionLog({
        globalStorageDir: this.options.globalStorageDir,
        projectKey: key,
        ...(projectRoot === undefined ? {} : { projectRoot }),
        onWriteFailure: (message) => { try { this.options.onProblem?.(message); } catch { /* the report never fails a decision */ } }
      });
    }
    // Most recently used goes last, so the first project key in the map is the one to let go when there are too many.
    this.logs.delete(key);
    this.logs.set(key, log);
    const projects = [...this.logs.keys()].filter((each) => each !== INSTALL_LOG_KEY);
    for (const oldest of projects.slice(0, Math.max(0, projects.length - MAX_PROJECT_LOGS))) this.retire(oldest);
    return log;
  }

  // Drops a log from the map; its queued records are still written, and flush() waits for them.
  private retire(key: string): void {
    if (key === INSTALL_LOG_KEY) return;
    const log = this.logs.get(key);
    if (log === undefined) return;
    this.logs.delete(key);
    // Let go for good only once its queue is written, and only if nothing has taken it back meanwhile.
    const pending: Promise<void> = log.flush().catch(() => undefined).finally(() => { if (this.retiring.get(key)?.pending === pending) this.retiring.delete(key); });
    this.retiring.set(key, { log, pending });
  }

  private async begin(): Promise<BundleState> {
    let result: BundleResult;
    try {
      result = await ensurePolicyBundle(this.options.globalStorageDir, this.options.secrets, this.storeOptions());
    } catch (error) {
      result = { state: failedClosed('identity-unavailable', detailOf(error)) };
    }
    await this.seedFromMarker();
    this.current = result.state;
    this.settled = true;
    this.announce(result.event, result.state);
    this.changed();
    return result.state;
  }

  // The bundle's own events are per install: they go to the install-level log in global storage whether or not a folder is open, and also to the open
  // project's log when there is one, as `policy.*` records, so a failed-closed start is on the record with its reason.
  private announce(event: BundleEvent | undefined, state: BundleState): void {
    try {
      const failed = state.state === 'failed-closed';
      const name = event ?? 'policy.load';
      const outcome: DecisionOutcome = failed ? 'denied' : 'allowed';
      const rule = failed ? 'bundle.failed-closed' : name;
      const reason = failed ? state.sentence : undefined;
      const record: DecisionRecord = buildDecisionRecord({
        recordId: randomUUID(),
        sequence: 0,
        time: this.now(),
        productVersion: this.options.productVersion,
        actor: { kind: 'person', deviceFingerprint: this.deviceFingerprint(), sessionId: POLICY_SESSION },
        callId: `${name}-${this.now()}`,
        capability: { verb: 'plan' },
        resource: { name: 'policy bundle', type: 'policy' },
        outcome,
        rule,
        ...(reason === undefined ? {} : { reason }),
        bundleHash: state.state === 'valid' ? state.hash : ''
      });
      const named = { ...record, api: { ...record.api, operation: name } };
      const root = this.projectRootNow();
      // Each destination is tried on its own, so a project log that cannot be set up never costs the install its record.
      const targets: Array<() => DecisionLog> = [() => this.installLog(), ...(root === undefined ? [] : [() => this.logFor(root)])];
      for (const target of targets) {
        try { void target().append(named); } catch { /* a record that cannot be kept never changes the state */ }
      }
    } catch {
      // A record that cannot be kept never changes the state.
    }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a listener never breaks the host */ }
    }
  }
}

/**
 * The runtime of a run nobody watches (a comparison task, a role test): presence none and an unattended context, so a floor ask is refused. `root` is the open project,
 * or none (undefined or empty) for a window with no folder: the per-install policy is still the real one, only the project log is missing.
 */
export function unattendedRuntimeFor(host: Pick<GateHost, 'runtimeFor'>, root: string | undefined, sessionId: string, agentLabel: string): Promise<GateRuntime> {
  return host.runtimeFor({ ...(root ? { root } : {}), actor: { kind: 'agent', sessionId, agentLabel }, presence: 'none', context: 'unattended' });
}

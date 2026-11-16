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
import type { ActorRef, FloorMode, GateRuntime, Presence } from '../domain/gate/decide';
import { buildDecisionRecord } from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord } from '../domain/gate/record';
import type { SecretStorageLike } from '../services/auth';
import { ensurePolicyBundle, resetPolicyToDefaults } from './bundleStore';
import type { BundleEvent, BundleResult } from './bundleStore';
import { DecisionLog, projectLogKey } from './decisionLog';

const DEVICE_UNKNOWN = 'device-unknown';
const POLICY_SESSION = 'policy';
const START_FAILED_DETAIL = 'The policy check threw before it could finish.';

/** How long a run waits for the policy check at activation before it is refused as "not loaded": long enough for a healthy start, short enough that a stuck one does not hang the run. */
export const RUNTIME_START_WAIT_MS = 5000;

export interface GateHostOptions {
  readonly globalStorageDir: string;
  readonly secrets: SecretStorageLike;
  readonly productVersion: string;
  /** The open project, whose log receives the bundle's own events (policy.load and the rest). None when no folder is open. */
  readonly projectRoot?: string;
  /** Called once per log, with a plain message, when a record could not be written. */
  readonly onProblem?: (message: string) => void;
  /** The clock for the bundle store and for records. Tests pass a fixed one. */
  readonly now?: () => Date;
  /** How long `runtimeFor` waits for the start to finish. Defaults to RUNTIME_START_WAIT_MS; tests pass a short one. */
  readonly startWaitMs?: number;
}

export interface RuntimeRequest {
  readonly root: string;
  readonly actor: Omit<ActorRef, 'deviceFingerprint'>;
  readonly presence: Presence;
  readonly context: GateContextName;
  readonly floorMode: FloorMode;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : START_FAILED_DETAIL;
}

export class GateHost {
  private current: BundleState = failedClosed('identity-unavailable', 'The gate has not finished starting.');
  private starting: Promise<BundleState> | undefined;
  /** True once the start has finished and `current` is what it found. */
  private settled = false;
  private readonly logs = new Map<string, DecisionLog>();
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

  /** What every decision reads now. A bundle that has expired since it was checked reads as expired, so a long session never runs on an old policy. */
  public bundleState(): BundleState {
    const state = this.current;
    if (state.state === 'valid' && Date.parse(state.expiresAt) <= this.clock()) return failedClosed('expired');
    return state;
  }

  /**
   * The runtime of one run: who is acting, whether a person is there, the context and the floor mode, over this host's state and the project's log. It waits
   * (for at most `startWaitMs`) for the start to finish, so a run begun during activation is decided with the real bundle. A start that fails or does not
   * finish in time gives a runtime that is failed closed with a plain sentence, until the start does finish.
   */
  public async runtimeFor(request: RuntimeRequest): Promise<GateRuntime> {
    const notLoaded = await this.waitForStart();
    let log: DecisionLog | undefined;
    try {
      log = this.logFor(request.root);
    } catch (error) {
      // A log that cannot be set up (its folder lies inside the project) is reported once; decisions carry on unrecorded rather than fail.
      try { this.options.onProblem?.(error instanceof Error ? error.message : 'NEAR AI could not set up its record of what was allowed or refused.'); } catch { /* ignored */ }
    }
    return {
      bundleState: () => (notLoaded !== undefined && !this.settled ? notLoaded : this.bundleState()),
      sink: { record: (record) => { void log?.append(record); } },
      actor: { ...request.actor, deviceFingerprint: this.deviceFingerprint() },
      presence: request.presence,
      context: request.context,
      floorMode: request.floorMode,
      productVersion: this.options.productVersion,
      clock: () => this.clock(),
      newRecordId: () => randomUUID()
    };
  }

  /** NEAR AI: Reset Policy to Defaults. Signs a fresh default policy (the old file is kept beside it) and records policy.reset. Throws a plain BundleStoreError when nothing could be changed. */
  public async reset(): Promise<BundleResult> {
    await this.start();
    const result = await resetPolicyToDefaults(this.options.globalStorageDir, this.options.secrets, this.storeOptions());
    this.current = result.state;
    this.announce(result.event ?? 'policy.reset', result.state);
    this.changed();
    return result;
  }

  public onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Resolves when every record queued so far has been written or has failed. */
  public async flush(): Promise<void> {
    await Promise.all([...this.logs.values()].map((log) => log.flush()));
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

  private clock(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  private storeOptions(): { now?: () => Date } {
    return this.options.now === undefined ? {} : { now: this.options.now };
  }

  private deviceFingerprint(): string {
    return this.current.state === 'valid' ? this.current.signer.fingerprint : DEVICE_UNKNOWN;
  }

  private logFor(root: string): DecisionLog {
    const key = projectLogKey(root);
    let log = this.logs.get(key);
    if (log === undefined) {
      log = new DecisionLog({
        globalStorageDir: this.options.globalStorageDir,
        projectKey: key,
        projectRoot: root,
        onWriteFailure: (message) => { try { this.options.onProblem?.(message); } catch { /* the report never fails a decision */ } }
      });
      this.logs.set(key, log);
    }
    return log;
  }

  private async begin(): Promise<BundleState> {
    let result: BundleResult;
    try {
      result = await ensurePolicyBundle(this.options.globalStorageDir, this.options.secrets, this.storeOptions());
    } catch (error) {
      result = { state: failedClosed('identity-unavailable', detailOf(error)) };
    }
    this.current = result.state;
    this.settled = true;
    this.announce(result.event, result.state);
    this.changed();
    return result.state;
  }

  // The bundle's own events go to the open project's log as `policy.*` records, so a failed-closed start is on the record with its reason.
  private announce(event: BundleEvent | undefined, state: BundleState): void {
    const root = this.options.projectRoot;
    if (root === undefined) return;
    try {
      const failed = state.state === 'failed-closed';
      const name = event ?? 'policy.load';
      const outcome: DecisionOutcome = failed ? 'denied' : 'allowed';
      const rule = failed ? 'bundle.failed-closed' : name;
      const reason = failed ? state.sentence : undefined;
      const record: DecisionRecord = buildDecisionRecord({
        recordId: randomUUID(),
        sequence: 0,
        time: this.clock(),
        productVersion: this.options.productVersion,
        actor: { kind: 'person', deviceFingerprint: this.deviceFingerprint(), sessionId: POLICY_SESSION },
        callId: `${name}-${this.clock()}`,
        capability: { verb: 'plan' },
        resource: { name: 'policy bundle', type: 'policy' },
        outcome,
        rule,
        ...(reason === undefined ? {} : { reason }),
        bundleHash: state.state === 'valid' ? state.hash : ''
      });
      void this.logFor(root).append({ ...record, api: { ...record.api, operation: name } });
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

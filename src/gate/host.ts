// The gate's host (GATE-04, GATE-07, OFFL-02): started once at activation, it checks or creates the policy bundle, keeps the state every run's gate reads,
// and gives each run its runtime with a sink that writes to the project's decision log in global storage. No vscode import: the activation adapter
// (src/services/gateCommands.ts) hands it the storage folder and the secret store.
//
// start() never throws and never rejects. Any error (a secret store that refuses, a full disk, a lock) leaves the gate in a failed-closed state with its plain
// sentence, so only reading and planning run until the person fixes it, and the rest of the extension carries on. A bundle that expires while the window is
// open is noticed at the next decision, with no file read.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { projectScopeId } from '../domain/contextGraph';
import { failedClosed } from '../domain/gate/bundle';
import type { BundleState, GateContextName } from '../domain/gate/bundle';
import type { ActorRef, GateProjectFacts, GateRuntime, Presence } from '../domain/gate/decide';
import { buildDecisionRecord } from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord, PolicyRecordVersion } from '../domain/gate/record';
import type { SecretStorageLike } from '../services/auth';
import { BundleStoreError, applyPolicyDraft, loadPersonalLayer, resetPolicyToDefaults } from './bundleStore';
import type { BundleEvent, BundleResult, PolicyEditResult } from './bundleStore';
import { OrganizationStore, OrganizationStoreError, loadLayeredPolicy, recompose } from './organizationStore';
import type { LayeredPolicy, OrganizationConfirmation, OrganizationEvent, PolicyLayersView } from './organizationStore';
import { readLastValid } from './clockMarker';
import { isModelRequestRecord } from '../domain/gate/record';
import { DecisionLog, INSTALL_LOG_KEY, projectLogKey } from './decisionLog';
import type { LogKind } from './decisionLog';
import { routePolicyFor } from './sessionMark';
import type { RoutePolicyNow, SessionRoute } from './sessionMark';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { labelMapKey, moveLabelEntry, resolveLabel, setLabelEntry } from '../domain/gate/labelMap';
import { joinLabels, raiseMark, sameMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { DEFAULT_ROUTING, TIER_ORDER, strictestLabelOf, tierForLabel } from '../domain/gate/routing';
import type { RoutingTable } from '../domain/gate/routing';
import type { LabelMapPayload } from '../domain/gate/labelMap';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Clearance, Label, LabelEventId, ScaleMapping, ScaleTable } from '../domain/gate/labels';
import { LabelMapError, LabelReader, lastVerifiedLabelMap, updateLabelMap } from './labelMapStore';
import type { LabelLowering, LabelMapQuestion, LabelMapWrite } from './labelMapStore';
import type { LabelMapState } from '../domain/gate/labelMap';
import { NO_KNOWN_KEYS } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { PayloadError } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { identityDir, loadDeviceIdentity } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { registerLabelLoweringJudge, registerLoweringOutcomes } from '../domain/gate/lowerings';
import { chatLoweringKeys, judgeChatLowering, loweringRejectedText, signChatLowering } from './chatLabel';
import type { ChatLowering } from './chatLabel';
import { clearancesInForce } from './clearances';
import type { ClearanceWalletView, ClearancesInForce } from './clearances';
import { walletStateAt } from './wallet';
import type { WalletView } from './wallet';

const DEVICE_UNKNOWN = 'device-unknown';
const POLICY_SESSION = 'policy';
const LABEL_SESSION = 'labels';
/** The session id of a model request made outside every session route. */
export const NO_SESSION_ID = 'no-session';
const START_FAILED_DETAIL = 'The policy check threw before it could finish.';

/**
 * The most project logs the host keeps open at once. A log is a small object with a write queue, but a long session that opens folder after folder would
 * otherwise keep one per folder for good: past this many, the one used longest ago is let go (after its queued records are written), and a later record
 * for that folder opens it again. Folder changes let go of closed folders' logs sooner (retainProjectLogs).
 */
export const MAX_PROJECT_LOGS = 8;

/** Where a model-request log sits in the host's map of open logs: its key with this prefix, so it never shares a slot with the decision log of the same key. */
const MODEL_REQUEST_SLOT = 'model-requests:';

function slotOf(kind: LogKind, key: string): string {
  return kind === 'decisions' ? key : `${MODEL_REQUEST_SLOT}${key}`;
}

function kindOfSlot(slot: string): LogKind {
  return slot.startsWith(MODEL_REQUEST_SLOT) ? 'model-requests' : 'decisions';
}

function keyOfSlot(slot: string): string {
  return slot.startsWith(MODEL_REQUEST_SLOT) ? slot.slice(MODEL_REQUEST_SLOT.length) : slot;
}

/** The log a record belongs in: a model request's (an infer record or a route event) or the decision log for everything else. */
function kindOfRecord(record: DecisionRecord): LogKind {
  return isModelRequestRecord(record) ? 'model-requests' : 'decisions';
}

/** How long a run waits for the policy check at activation before it is refused as "not loaded": long enough for a healthy start, short enough that a stuck one does not hang the run. */
export const RUNTIME_START_WAIT_MS = 5000;

export interface GateHostOptions {
  readonly globalStorageDir: string;
  /** Phase 71: the person's wallet, whose verified view gives the clearances under your organization's credentials@1. */
  readonly wallet?: { verifiedView(): WalletView };
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
  /**
   * Where a label file's state that needs the person goes (unverified, unreadable, rolled back, another branch's), once per window, with the project, so the
   * activation adapter can offer the one-click accept of D-61. Without it the message goes to onProblem.
   */
  readonly onLabelNotice?: (root: string, state: LabelMapState, message: string) => void;
  /**
   * Where the refusal of an automatic label raise goes (the label file does not verify, or is held), once per window per project, so the activation adapter
   * can offer Sign Again (D-53). Without it the message goes to onProblem.
   */
  readonly onLabelRaiseRefused?: (root: string, message: string) => void;
  /** How long a written file's label raise waits to be written with others (RAISE_WRITE_DELAY_MS); tests pass a short one. */
  readonly raiseDelayMs?: number;
  /** Told, once per signature per window, when a merge did not apply a lowering made on another copy of a chat, with the sentence for that chat (D-58). */
  readonly onLoweringRejected?: (chatId: string, sentence: string) => void;
}

/** Thrown inside the writer when, under its lock, nothing would rise: nothing is written. */
const NOTHING_TO_RAISE = 'Nothing was written: no label would rise.';
/** The most signed lowerings a window remembers having recorded (the oldest forgotten first; one forgotten is at worst recorded again). */
export const JUDGED_LOWERINGS_KEPT = 1_000;
/** The most projects, and paths per project, whose refused raises are kept for Sign Again. */
export const REFUSED_RAISE_PROJECTS = 32;
export const REFUSED_RAISE_PATHS = 2_000;

/** Said once when a raise a labelled chat's write needs cannot be written automatically. */
export const LABEL_RAISE_REFUSED_TEXT =
  "A file a labelled chat wrote could not take the chat's label, because the label file is not one this computer can sign automatically. The chat itself keeps its label. Choose Sign Again to sign the label file with this computer's key and add the label.";

export interface RuntimeRequest {
  /** The open project, whose log receives the run's records. None (or empty) for a window with no folder: the bundle is per install, so the run is still decided by it, and its records go to the install log. */
  readonly root?: string;
  readonly actor: Omit<ActorRef, 'deviceFingerprint'>;
  readonly presence: Presence;
  readonly context: GateContextName;
}

/**
 * What the gate knows of the project at `root` (74.1 D-13): its id, and `staff` when its project file has a staff section. The signed exercise attribute
 * comes with the project layer's source (Phase 32.1); until then no project is an exercise. A file that cannot be read is no kind, never an error.
 */
export async function projectFactsOf(root: string): Promise<GateProjectFacts> {
  const id = projectScopeId(root);
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(root, '.planning', '.near-ai', 'project.json'), 'utf8'));
    const staff = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['staff'] : undefined;
    if (typeof staff === 'object' && staff !== null && !Array.isArray(staff)) return Object.freeze({ id, kind: 'staff' });
  } catch { /* no project file, or not JSON: no kind */ }
  return Object.freeze({ id });
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
  /**
   * Open logs by slot (a decision log by its key, a model-request log by its key with MODEL_REQUEST_SLOT before it), in the order they were last used (the
   * install logs included; they are never let go).
   */
  private readonly logs = new Map<string, DecisionLog>();
  /**
   * Logs let go while records were still queued, by key, until their queue is written: flush() waits for them, and a reopen of the same key takes the log
   * back instead of making a second writer for the file (PR #74 review round 4).
   */
  private readonly retiring = new Map<string, { readonly log: DecisionLog; readonly pending: Promise<void> }>();
  private readonly listeners = new Set<() => void>();
  /** Label readers by project key, kept and let go with the project's logs (CLAS-01). */
  private readonly labelReaders = new Map<string, LabelReader>();
  /** Problems with automatic label writes already told this window, so each is said once. */
  private readonly toldLabelProblems = new Set<string>();
  /** The key sources signed chat lowerings are checked against (D-58): this install's key history, loaded by refreshLoweringKeys. */
  private loweringKeys: KeyStatusLookup = NO_KNOWN_KEYS;
  /** Signed lowerings already recorded this window, by signature, so each is recorded and said once: the newest JUDGED_LOWERINGS_KEPT (PR #87 review). */
  private readonly judgedLowerings = new Set<string>();
  /**
   * Raises an automatic write could not make (an unverified label file), by project, kept for Sign Again. Each path's labels are joined, never appended.
   * It holds at most REFUSED_RAISE_PROJECTS projects of at most REFUSED_RAISE_PATHS paths each (PR #87 review): past either bound the oldest is dropped,
   * and each raise dropped is recorded in that project's decision log as a label.set that was denied, so Sign Again not writing it is never silent.
   */
  private readonly refusedRaises = new Map<string, { readonly root: string; readonly raises: Map<string, Label[]> }>();
  /** Both policy layers as the last load composed them (41-09): your organization's, the personal one, the effective policy and the notices. */
  private layers: PolicyLayersView = { organization: { state: 'none' }, ignored: [], migration: [] };

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
    // When your organization's rules end first, their own sentence and contact are shown, never the personal expiry sentence (D-14).
    if (state.state === 'valid' && Date.parse(state.expiresAt) <= this.now()) return this.layers.expiry ?? failedClosed('expired');
    return state;
  }

  /** Both layers, the effective policy, the ignored personal settings and the migration changes, as the last load composed them (41-13, 41-14). */
  public policyLayers(): PolicyLayersView {
    return this.layers;
  }

  /** Records a policy event (a proposal applied or exported, the migration notice shown) with the current state, in the install log and the open project's. */
  public recordPolicyEvent(event: BundleEvent, detail?: string): void {
    this.announce(event, this.bundleState(), detail);
  }

  /**
   * SovAI: Add Your Organization's Rules (FND-01, D-11 to D-14). Takes an enrolment file or a rules file from your organization; a first enrolment and a
   * key handover need `wordsConfirmed` (the twelve words were compared aloud). Every decision reads the composed policy from the next one on. A file that
   * is refused is recorded as policy.organization-refused, and the plain OrganizationStoreError is thrown with nothing changed.
   */
  public async acceptOrganizationFile(text: string, confirmation: OrganizationConfirmation): Promise<BundleState> {
    await this.start();
    let accepted;
    try {
      accepted = await new OrganizationStore(this.options.globalStorageDir, this.options.secrets, this.storeOptions()).accept(text, confirmation, this.now());
    } catch (error) {
      if (error instanceof OrganizationStoreError && error.refused) this.announce('policy.organization-refused', this.bundleState(), error.reason);
      throw error;
    }
    const layered = await recompose(this.options.globalStorageDir, this.options.secrets, await loadPersonalLayer(this.options.globalStorageDir, this.options.secrets, this.storeOptions()), this.storeOptions());
    this.settle(layered, accepted.event === undefined ? [] : [accepted.event]);
    return this.current;
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
    const project = root === undefined ? undefined : await projectFactsOf(root);
    let usable = true;
    try {
      this.logWithKey(key, root);
    } catch (error) {
      // A log that cannot be set up (its folder lies inside the project) is reported once; decisions carry on unrecorded rather than fail.
      usable = false;
      try { this.options.onProblem?.(error instanceof Error ? error.message : 'SovAI could not set up its record of what was allowed or refused.'); } catch { /* ignored */ }
    }
    return {
      bundleState: () => (notLoaded !== undefined && !this.settled ? notLoaded : this.bundleState()),
      // Each record goes to the log of its own kind (owner decision after PR 4a): model requests to the model-request log, everything else here.
      sink: { record: (record) => { if (usable) { try { void this.logWithKey(key, root, kindOfRecord(record)).append(this.withPolicyVersion(record, policyVersionOf(this.policyLayers()))); } catch { /* reported once above */ } } } },
      actor: { ...request.actor, deviceFingerprint: this.deviceFingerprint() },
      presence: request.presence,
      context: request.context,
      locations: { globalStorage: this.options.globalStorageDir, ...(this.options.home === undefined ? {} : { home: this.options.home }) },
      productVersion: this.options.productVersion,
      clock: () => this.now(),
      newRecordId: () => randomUUID(),
      routePolicy: (now) => this.routePolicyNow(now, project?.id),
      ...(project === undefined ? {} : { project }),
      // Each folder the run works in has its own reader (a sub-agent's worktree included), kept by the host and read again only when the file changes.
      labels: (folder: string) => this.labelsFor(folder)
    };
  }

  /**
   * The label reader of a project (CLAS-01, D-25): one per root, kept like the project's logs (let go by retainProjectLogs), read again only when the file
   * or its marker changes. Its notices (a map that does not verify, cannot be read or was rolled back, labelled paths that are gone) are said once.
   */
  public labelsFor(root: string): LabelReader {
    const key = projectLogKey(root);
    let reader = this.labelReaders.get(key);
    if (reader === undefined) {
      reader = new LabelReader(root, {
        globalStorageDir: this.options.globalStorageDir,
        secrets: this.options.secrets,
        onNotice: (message, state) => {
          try {
            if (state !== undefined && this.options.onLabelNotice !== undefined) this.options.onLabelNotice(root, state, message);
            else this.options.onProblem?.(message);
          } catch { /* a notice never changes a decision */ }
        },
        move: (from, to) => this.followRename(root, from, to),
        writeRaises: (raises) => this.writeRaises(root, raises).then(() => undefined),
        ...(this.options.raiseDelayMs === undefined ? {} : { raiseDelayMs: this.options.raiseDelayMs })
      });
    }
    this.labelReaders.delete(key);
    this.labelReaders.set(key, reader);
    for (const old of [...this.labelReaders.keys()].slice(0, Math.max(0, this.labelReaders.size - MAX_PROJECT_LOGS))) this.labelReaders.delete(old);
    return reader;
  }

  /** What labels are judged by now: the valid policy's scales, mappings, clearances and default label, or a failed-closed policy's (no clearances). */
  public labelPolicy(): { readonly valid: boolean; readonly scales: ScaleTable; readonly mappings: readonly ScaleMapping[]; readonly clearances: readonly Clearance[]; readonly defaultLabel: Label } {
    const state = this.bundleState();
    if (state.state === 'valid') return { valid: true, scales: state.bundle.scales, mappings: state.bundle.mappings, clearances: this.clearancesNow().clearances, defaultLabel: state.bundle.defaultLabel };
    return { valid: false, scales: SCALE_PRESETS, mappings: [], clearances: [], defaultLabel: SHIPPED_DEFAULT_LABEL };
  }

  /**
   * Changes a project's labels through the one writer (updateLabelMap), with this policy's scales, and has the project's reader read the file again.
   * `confirm` is the person's answer before an unverified map is signed again or the last verified labels are restored; with none, such a write is refused.
   */
  public async changeLabels(root: string, change: (map: LabelMapPayload) => LabelMapPayload, confirm?: (question: LabelMapQuestion) => Promise<boolean>, options: { readonly lowering?: LabelLowering } = {}): Promise<LabelMapWrite> {
    await this.start();
    const policy = this.labelPolicy();
    try {
      return await updateLabelMap(root, change, {
        globalStorageDir: this.options.globalStorageDir,
        secrets: this.options.secrets,
        scales: policy.scales,
        defaultLabel: policy.defaultLabel,
        ...(confirm === undefined ? {} : { confirm }),
        ...(options.lowering === undefined ? {} : { lowering: options.lowering }),
        ...(this.options.now === undefined ? {} : { now: this.options.now })
      });
    } finally {
      this.labelReaders.get(projectLogKey(root))?.invalidate();
    }
  }

  /** The labels this computer last verified for a project, or undefined (PR #85 review: Set Label judges a lowering against them over a held file). */
  public async lastVerifiedLabels(root: string): Promise<LabelMapPayload | undefined> {
    try {
      return await lastVerifiedLabelMap(this.options.globalStorageDir, this.options.secrets, root, this.labelPolicy().scales);
    } catch {
      return undefined;
    }
  }

  /**
   * D-61: the person accepts the signed label file in the project now (another branch's, say) as current. Only a file in the `other-revision` state is
   * accepted: it is signed again at a revision above the marker, the marker moves, and `label.branch-accepted` is recorded. Returns false, writing nothing,
   * when the file is in any other state.
   */
  public async acceptBranchLabels(root: string): Promise<boolean> {
    const policy = this.labelPolicy();
    const view = await this.labelsFor(root).view(policy.scales);
    if (view.state !== 'other-revision') return false;
    // The check above is outside the writer's lock, so the file can change before the write (PR #85 review). The writer reads it again under its lock and
    // asks `accept` only when it is still another revision; the change writes only after that question, so nothing is signed, and no accept recorded,
    // for a file that is no longer the one the person accepted.
    let asked = false;
    let written: LabelMapWrite;
    try {
      written = await this.changeLabels(root, (map) => {
        if (!asked) throw new LabelMapError('Nothing was written: the label file changed before it could be accepted.');
        return map;
      }, async (question) => {
        if (question !== 'accept') return false;
        asked = true;
        return true;
      });
    } catch (error) {
      if (!asked && error instanceof LabelMapError) return false;
      throw error;
    }
    this.recordLabelEvent(root, { event: 'label.branch-accepted', path: '', reason: `A person accepted the project's signed label file (for example another branch's) as current. It is now revision ${String(written.revision)}.` });
    return true;
  }

  /**
   * Records a label event (GATE-07) in the project's log, the way the policy's events are written: the event as the operation, the project-relative path as
   * the resource (`project` for the project itself, never a machine path), the new label, and the reason a person gave.
   */
  public recordLabelEvent(root: string, event: { readonly event: LabelEventId; readonly path: string; readonly label?: Label; readonly reason?: string; readonly mark?: Mark; readonly from?: Mark; readonly outcome?: 'allowed' | 'denied' }): void {
    try {
      const record = buildDecisionRecord({
        recordId: randomUUID(),
        sequence: 0,
        time: this.now(),
        productVersion: this.options.productVersion,
        actor: { kind: 'person', deviceFingerprint: this.deviceFingerprint(), sessionId: LABEL_SESSION },
        callId: `${event.event}-${this.now()}`,
        capability: { verb: 'plan' },
        resource: { name: event.path === '' ? 'project' : event.path.slice(0, 300), type: 'label' },
        outcome: event.outcome ?? 'allowed',
        rule: event.event,
        ...(event.reason === undefined || event.reason === '' ? {} : { reason: event.reason.slice(0, 500) }),
        bundleHash: this.current.state === 'valid' ? this.current.hash : '',
        policyVersion: policyVersionOf(this.policyLayers()),
        // One shape for every label event (PR #87 review round 3): `label` the target, `mark` the chat's mark after the event, `from` the mark before it. With a
        // mark, the target is always the mark's strictest label, whoever records it (PR #87 review), as label.mark-raised records it.
        ...((): { label?: Label } => {
          const target = event.mark !== undefined && event.mark.length > 0 ? strictestLabelOf(event.mark, this.routingNow()) : event.label;
          return target === undefined ? {} : { label: target };
        })(),
        ...(event.mark === undefined || event.mark.length === 0 ? {} : { mark: event.mark }),
        ...(event.from === undefined || event.from.length === 0 ? {} : { from: event.from })
      });
      void this.logFor(root).append({ ...record, api: { ...record.api, operation: event.event } });
    } catch {
      // A record that cannot be kept never changes the label.
    }
  }

  /**
   * Writes the label raises a labelled chat's writes queued (D-26, D-29): each written file's entry takes the chat's mark where the mark is above the file's
   * label now, never lower, in one signed write. Nothing is written when nothing rises, so with the default mark the label file is never touched. A file
   * that does not verify (or holds reads) is never signed automatically (D-53): nothing is written, the raises are kept for Sign Again, and the person is
   * told once. Returns whether a write was made.
   */
  public async writeRaises(root: string, raises: ReadonlyMap<string, readonly Label[]>): Promise<boolean> {
    const policy = this.labelPolicy();
    const routing = this.routingNow();
    const proposed = new Map<string, readonly Label[]>();
    for (const [relative, mark] of raises) {
      const key = labelMapKey(relative, false);
      if (key.ok) proposed.set(key.value, [...(proposed.get(key.value) ?? []), ...mark]);
    }
    // Worked out inside the writer's lock, against the map it reads there (PR #87 review): a label another writer raised meanwhile is the one joined with,
    // so this write can only keep or raise it. Nothing rises: nothing is written at all.
    const raised = new Map<string, { readonly label: Label; readonly from: Mark }>();
    const rise = (map: LabelMapPayload): Map<string, { readonly label: Label; readonly from: Mark }> => {
      const out = new Map<string, { readonly label: Label; readonly from: Mark }>();
      for (const [key, mark] of proposed) {
        const current = resolveLabel(key, { verified: map, bundleDefault: policy.defaultLabel, scales: policy.scales });
        const from = current.origin === 'default' ? [] : current.mark;
        const label = raisedEntryLabel(from, mark, policy.scales, routing);
        if (label !== undefined) out.set(key, { label, from });
      }
      return out;
    };
    // Whether anything rises is decided only under the writer's lock, against the map it reads there (PR #87 review): a view read before the lock may be
    // stale, so it never decides that nothing rises. When nothing rises there, nothing is written. (A chat at the default mark queues no raises at all.)
    if (proposed.size === 0) return false;
    try {
      await this.changeLabels(root, (map) => {
        let out = map;
        for (const [key, entry] of rise(map)) { out = setLabelEntry(out, key, entry.label); raised.set(key, entry); }
        if (raised.size === 0) throw new LabelMapError(NOTHING_TO_RAISE);
        return out;
      });
    } catch (error) {
      if (error instanceof LabelMapError && error.message === NOTHING_TO_RAISE) return false;
      this.keepRefusedRaises(root, raises);
      // The person is told only when the labels as last read say something would rise; the raises are kept for Sign Again either way, which works them out
      // under the lock again.
      let worthTelling = true;
      try {
        const view = await this.labelsFor(root).view(policy.scales);
        worthTelling = [...proposed].some(([key, mark]) => {
          const current = view.resolve(key, policy.defaultLabel);
          return raisedEntryLabel(current.origin === 'default' ? [] : current.mark, mark, policy.scales, routing) !== undefined;
        });
      } catch { /* a view that cannot be read: tell */ }
      const told = `raise-refused:${projectLogKey(root)}`;
      if (worthTelling && !this.toldLabelProblems.has(told)) {
        this.toldLabelProblems.add(told);
        const message = error instanceof LabelMapError ? `${LABEL_RAISE_REFUSED_TEXT} ${error.message}` : LABEL_RAISE_REFUSED_TEXT;
        try {
          if (this.options.onLabelRaiseRefused !== undefined) this.options.onLabelRaiseRefused(root, message);
          else this.options.onProblem?.(message);
        } catch { /* a notice never changes a decision */ }
      }
      return false;
    }
    for (const [key, entry] of raised) this.recordLabelEvent(root, { event: 'label.set', path: key, label: entry.label, ...(entry.from.length === 0 ? {} : { from: entry.from }), reason: 'A file a labelled chat wrote took the chat\'s label.' });
    return true;
  }

  /** Keeps refused raises for Sign Again, bounded: each path's labels joined (never appended), the oldest project and path dropped first. */
  private keepRefusedRaises(root: string, raises: ReadonlyMap<string, readonly Label[]>): void {
    const project = projectLogKey(root);
    const kept = this.refusedRaises.get(project)?.raises ?? new Map<string, Label[]>();
    this.refusedRaises.delete(project);
    const scales = this.labelPolicy().scales;
    for (const [relative, mark] of raises) {
      let joined: Mark = kept.get(relative) ?? [];
      for (const label of mark) joined = raiseMark(joined, label, scales);
      kept.delete(relative);
      kept.set(relative, [...joined]);
      while (kept.size > REFUSED_RAISE_PATHS) {
        const oldest = kept.keys().next().value as string;
        this.recordDroppedRaise(root, oldest, kept.get(oldest) ?? []);
        kept.delete(oldest);
      }
    }
    this.refusedRaises.set(project, { root, raises: kept });
    while (this.refusedRaises.size > REFUSED_RAISE_PROJECTS) {
      const oldest = this.refusedRaises.keys().next().value as string;
      const dropped = this.refusedRaises.get(oldest);
      for (const [relative, labels] of dropped?.raises ?? []) this.recordDroppedRaise(dropped!.root, relative, labels);
      this.refusedRaises.delete(oldest);
    }
  }

  /** Records a refused raise that the bound dropped: Sign Again will not write it, so the log says so, with the label it would have given. */
  private recordDroppedRaise(root: string, relative: string, labels: readonly Label[]): void {
    this.recordLabelEvent(root, {
      event: 'label.set',
      outcome: 'denied',
      path: relative,
      ...(labels.length === 0 ? {} : { mark: labels }),
      reason: 'A raise this file needed could not be written (the label file did not verify) and was kept for Sign Again, but too many were kept, so it was dropped. Sign Again will not write it: set the label with SovAI: Set Label if it is still needed.'
    });
  }

  /**
   * Sign Again after a refused raise (D-53): the person confirmed, so the label file is signed again keeping only what raises (or the labels this computer
   * last verified are restored), then the raises kept for it are written. Returns whether they were.
   */
  public async signAgainForRaises(root: string): Promise<boolean> {
    await this.changeLabels(root, (map) => map, async (question) => question === 'resign' || question === 'restore');
    const kept = this.refusedRaises.get(projectLogKey(root))?.raises;
    this.refusedRaises.delete(projectLogKey(root));
    this.toldLabelProblems.delete(`raise-refused:${projectLogKey(root)}`);
    return kept === undefined ? false : this.writeRaises(root, kept);
  }

  private routingNow(): RoutingTable {
    const state = this.bundleState();
    return state.state === 'valid' ? state.bundle.routing : DEFAULT_ROUTING;
  }

  /**
   * Makes every thread merge in this window judge signed lowerings with this host's key sources (D-58), and records each one it judged: an applied one as
   * label.declassify, a rejected one as label.declassify-rejected with its cause, once per signature per window, in the open project's log. Returns a
   * function that undoes the registration (the activation disposes it).
   */
  public registerLabelLowerings(): () => void {
    void this.refreshLoweringKeys();
    const stopJudge = registerLabelLoweringJudge((lowering, context) => judgeChatLowering(lowering, context, this.loweringKeys));
    const stopOutcomes = registerLoweringOutcomes((outcome) => {
      const sig = (outcome.lowering as { sig?: unknown } | null)?.sig;
      const key = `${outcome.chatId}:${typeof sig === 'string' ? sig : JSON.stringify(outcome.lowering ?? null).slice(0, 200)}`;
      if (this.judgedLowerings.has(key)) return;
      this.judgedLowerings.add(key);
      while (this.judgedLowerings.size > JUDGED_LOWERINGS_KEPT) this.judgedLowerings.delete(this.judgedLowerings.values().next().value as string);
      const root = this.projectRootNow() ?? '';
      const payload = (outcome.lowering as { payload?: Partial<ChatLowering> } | null)?.payload;
      if (outcome.applied) {
        // The record names the label the merge put the chat at (the same result, so record and state agree), not a value read from either copy.
        if (outcome.result === undefined || outcome.result.length === 0) return;
        this.recordLabelEvent(root, { event: 'label.declassify', path: `chat ${outcome.chatId}`, mark: outcome.result, ...(outcome.from === undefined ? {} : { from: outcome.from }), reason: `Lowered on another copy of this chat: ${typeof payload?.reason === 'string' ? payload.reason : 'no reason given'}` });
        return;
      }
      const sentence = loweringRejectedText(outcome.cause ?? 'does-not-verify');
      this.recordLabelEvent(root, { event: 'label.declassify-rejected', path: `chat ${outcome.chatId}`, reason: sentence });
      try { this.options.onLoweringRejected?.(outcome.chatId, sentence); } catch { /* a notice never changes a merge */ }
    });
    return () => { stopJudge(); stopOutcomes(); };
  }

  /** Reads this install's key history again for the lowering judge (at registration, and after this install signs a lowering). */
  public async refreshLoweringKeys(): Promise<void> {
    try {
      this.loweringKeys = chatLoweringKeys(await localKeyStatus(identityDir(this.options.globalStorageDir), this.options.secrets));
    } catch {
      this.loweringKeys = NO_KNOWN_KEYS;
    }
  }

  /** Signs a person's lowering with this install's device key (D-58), or undefined when this install cannot sign (the chat is still lowered here). */
  public async signChatLowering(lowering: ChatLowering): Promise<SignedPayload<ChatLowering> | undefined> {
    try {
      const identity = await loadDeviceIdentity(this.options.secrets);
      if (identity === undefined) return undefined;
      const signed = signChatLowering(identity, lowering);
      await this.refreshLoweringKeys();
      return signed;
    } catch (error) {
      if (error instanceof PayloadError) return undefined;
      return undefined;
    }
  }

  /** An agent's rename moves the entry (D-26), when an entry is there; an automatic write never signs a map that does not verify, and says so once. */
  public async followRename(root: string, from: string, to: string): Promise<void> {
    let moved = false;
    try {
      await this.changeLabels(root, (map) => {
        const folder = from.endsWith('/');
        const affected = Object.keys(map.entries).some((key) => (folder ? key.startsWith(from) : key === from));
        if (!affected) return map;
        moved = true;
        return moveLabelEntry(map, from, to);
      }, undefined, { lowering: { kind: 'move' } });
    } catch (error) {
      const message = error instanceof LabelMapError ? `A label was not moved with a renamed file. ${error.message}` : 'A label was not moved with a renamed file.';
      if (!this.toldLabelProblems.has(message)) {
        this.toldLabelProblems.add(message);
        try { this.options.onProblem?.(message); } catch { /* ignored */ }
      }
      return;
    }
    if (moved) this.recordLabelEvent(root, { event: 'label.set', path: to, reason: `The label moved with the file, renamed from ${from}.` });
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
            void this.logWithKey(root === undefined ? INSTALL_LOG_KEY : projectLogKey(root), root, kindOfRecord(record)).append(this.withPolicyVersion(record, policyVersionOf(this.policyLayers())));
          } catch { /* a record that cannot be kept never changes a request (D-21) */ }
        }
      },
      clock: () => this.now(),
      newRecordId: () => randomUUID(),
      productVersion: this.options.productVersion,
      routePolicy: (now) => this.routePolicyNow(now),
      attestation: { failed: false }
    };
  }

  /** SovAI: Reset Policy to Defaults. Signs a fresh default policy (the old file is kept beside it) and records policy.reset. Throws a plain BundleStoreError when nothing could be changed. */
  public async reset(): Promise<BundleResult> {
    await this.start();
    const result = await resetPolicyToDefaults(this.options.globalStorageDir, this.options.secrets, this.storeOptions());
    await this.seedFromMarker();
    const layered = await recompose(this.options.globalStorageDir, this.options.secrets, result, this.storeOptions());
    // Under your organization's layer only the personal layer was re-signed, and the record says so (D-21); the organization files are never touched.
    const underOrganization = layered.layers.organization.state !== 'none';
    const event: BundleEvent = (result.event ?? 'policy.reset') === 'policy.reset' && underOrganization ? 'policy.reset-personal' : result.event ?? 'policy.reset';
    this.settle(layered, [], { event });
    return { ...result, state: layered.state, ...(result.event === undefined ? {} : { event }) };
  }

  /**
   * SovAI: Apply Policy Draft (D-41, D-53). Applies a draft made from the policy whose hash is `baseHash`, the way reset() replaces the policy: every runtime
   * and the status bar read the new policy from the next decision on, the listeners are told, and policy.edit is recorded with the old and new hashes. A
   * refused draft throws a plain BundleStoreError and changes nothing.
   */
  public async applyPolicyDraft(draftText: string, baseHash: string): Promise<PolicyEditResult> {
    await this.start();
    // The draft is checked against your organization's layer in force (D-20); while that layer fails, nothing can be edited (D-21). A draft made from the
    // composed policy names the composed hash, which stands for the personal layer it was composed from.
    const organization = this.layers.organization;
    if (organization.state === 'failed') throw new BundleStoreError(`Nothing was changed: your policy cannot be trusted right now, so it cannot be edited. ${organization.sentence}`);
    const personal = this.layers.personal;
    const base = organization.state === 'valid' && personal !== undefined && this.current.state === 'valid' && baseHash === this.current.hash ? personal.hash : baseHash;
    const input = organization.state === 'valid'
      ? { baseHash: base, organization: { document: organization.document, hash: organization.hash, issuerFingerprint: organization.document.issuer.fingerprint } }
      : { baseHash: base };
    const result = await applyPolicyDraft(this.options.globalStorageDir, this.options.secrets, draftText, input, this.storeOptions());
    await this.seedFromMarker();
    const layered = await recompose(this.options.globalStorageDir, this.options.secrets, result, this.storeOptions());
    this.settle(layered, [], { event: result.event ?? 'policy.edit', detail: `The policy changed from ${result.oldHash} to ${result.newHash}.` });
    return { ...result, state: layered.state };
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
    // Both kinds of log follow the same rule: a project's model-request log is let go with its decision log.
    for (const slot of [...this.logs.keys()]) if (!keep.has(keyOfSlot(slot))) this.retire(slot);
    for (const key of [...this.labelReaders.keys()]) if (!keep.has(key)) this.labelReaders.delete(key);
  }

  /** The keys of the decision logs held open now, install log included, least recently used first. For tests and diagnostics. */
  public openLogKeys(): string[] {
    return [...this.logs.keys()].filter((slot) => kindOfSlot(slot) === 'decisions');
  }

  /** The keys of the model-request logs held open now, least recently used first. For tests and diagnostics. */
  public openModelRequestLogKeys(): string[] {
    return [...this.logs.keys()].filter((slot) => kindOfSlot(slot) === 'model-requests').map(keyOfSlot);
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

  /**
   * The route policy of a request decided now (D-36): from this host's own layers, or none when no effective policy is in force (a failed-closed state
   * already routes with the failed-closed table). A policy that cannot be worked out throws, so the client refuses the request as a failed route check
   * (route.deny); it is never decided as if no policy existed (WR-02).
   */
  private routePolicyNow(now: number, project?: string): RoutePolicyNow | undefined {
    const layers = this.policyLayers();
    const policy = routePolicyFor(layers, now, this.deviceFingerprint(), policyVersionOf(layers), this.walletAt(now));
    // 74.1 D-13: the run's project, so an authorization scoped to a project covers that project's requests only (lifts 41 D-54 for this purpose).
    return policy === undefined || project === undefined ? policy : Object.freeze({ ...policy, project });
  }

  /**
   * Phase 71 (D-08, D-19): where the clearances decisions use come from now, with the sentence to show: the verified wallet under your organization's
   * policy with credentials@1, else the person's own declared clearances. The wallet's view is read from memory, so no decision waits on I/O.
   */
  public clearancesNow(): ClearancesInForce {
    const layers = this.policyLayers();
    const organization = layers.organization.state === 'valid' ? layers.organization.document : undefined;
    return clearancesInForce(layers.effective, organization, this.walletAt(this.now()));
  }

  private walletAt(now: number): ClearanceWalletView | undefined {
    const view = this.options.wallet?.verifiedView();
    return view === undefined ? undefined : { state: walletStateAt(view, now), clearances: view.clearances };
  }

  /**
   * A record as this host's sinks append it (D-10): a copy whose authorizations[0].policy.version is `version`, every other field as it was, so every record
   * a runtime writes (tool calls, mark raises, refusals before the gate, model requests) names the policy version without agent/gateAdapter.ts knowing it.
   */
  private withPolicyVersion(record: DecisionRecord, version: PolicyRecordVersion): DecisionRecord {
    const [first, ...rest] = record.authorizations;
    return first === undefined ? record : { ...record, authorizations: [{ ...first, policy: { ...first.policy, version } }, ...rest] };
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

  private logWithKey(key: string, projectRoot?: string, kind: LogKind = 'decisions'): DecisionLog {
    // One log per key and kind: a log being let go is taken back, so its queue and the new records stay in one writer's order.
    const slot = slotOf(kind, key);
    let log = this.logs.get(slot) ?? this.retiring.get(slot)?.log;
    this.retiring.delete(slot);
    if (log === undefined) {
      log = new DecisionLog({
        globalStorageDir: this.options.globalStorageDir,
        projectKey: key,
        kind,
        ...(projectRoot === undefined ? {} : { projectRoot }),
        onWriteFailure: (message) => { try { this.options.onProblem?.(message); } catch { /* the report never fails a decision */ } }
      });
    }
    // Most recently used goes last, so the first project key in the map is the one to let go when there are too many. Each kind keeps up to
    // MAX_PROJECT_LOGS project logs, so model requests never push a project's decision log out early.
    this.logs.delete(slot);
    this.logs.set(slot, log);
    const projects = [...this.logs.keys()].filter((each) => kindOfSlot(each) === kind && keyOfSlot(each) !== INSTALL_LOG_KEY);
    for (const oldest of projects.slice(0, Math.max(0, projects.length - MAX_PROJECT_LOGS))) this.retire(oldest);
    return log;
  }

  // Drops a log from the map; its queued records are still written, and flush() waits for them.
  private retire(slot: string): void {
    if (keyOfSlot(slot) === INSTALL_LOG_KEY) return;
    const log = this.logs.get(slot);
    if (log === undefined) return;
    this.logs.delete(slot);
    // Let go for good only once its queue is written, and only if nothing has taken it back meanwhile.
    const pending: Promise<void> = log.flush().catch(() => undefined).finally(() => { if (this.retiring.get(slot)?.pending === pending) this.retiring.delete(slot); });
    this.retiring.set(slot, { log, pending });
  }

  private async begin(): Promise<BundleState> {
    let result: LayeredPolicy & { readonly event?: BundleEvent };
    try {
      result = await loadLayeredPolicy(this.options.globalStorageDir, this.options.secrets, this.storeOptions());
    } catch (error) {
      const state = failedClosed('identity-unavailable', detailOf(error));
      result = { state, layers: { organization: { state: 'none' }, ignored: [], migration: [] }, events: [] };
    }
    await this.seedFromMarker();
    this.current = result.state;
    this.layers = result.layers;
    this.settled = true;
    this.announce(result.event, result.state);
    // Your organization's events the load found (a layer rolled forward or refused) are recorded once, at start.
    for (const found of result.events) this.announce(found.event, result.state, found.detail);
    this.changed();
    return result.state;
  }

  // Takes a layered result as the policy in force: seeds the clock, records the events, tells the listeners.
  private settle(layered: LayeredPolicy, before: readonly OrganizationEvent[], personal?: { readonly event: BundleEvent; readonly detail?: string }): void {
    this.current = layered.state;
    this.layers = layered.layers;
    if (personal !== undefined) this.announce(personal.event, layered.state, personal.detail);
    for (const found of [...before, ...layered.events]) this.announce(found.event, layered.state, found.detail);
    this.changed();
  }

  // The bundle's own events are per install: they go to the install-level log in global storage whether or not a folder is open, and also to the open
  // project's log when there is one, as `policy.*` records, so a failed-closed start is on the record with its reason.
  private announce(event: BundleEvent | undefined, state: BundleState, detail?: string): void {
    try {
      const failed = state.state === 'failed-closed';
      const name = event ?? 'policy.load';
      const outcome: DecisionOutcome = failed ? 'denied' : 'allowed';
      const rule = failed ? 'bundle.failed-closed' : name;
      const reason = failed ? state.sentence : detail;
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
        bundleHash: state.state === 'valid' ? state.hash : '',
        policyVersion: policyVersionOf(this.policyLayers())
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
 * The version of the policy every record names (D-10): bundle-2 while an effective policy is in force and either your organization's layer is valid or the
 * stored personal layer is a version 2 one; bundle-1 otherwise, a failed-closed state included. The one function that decides it. Pure.
 */
export function policyVersionOf(layers: PolicyLayersView): PolicyRecordVersion {
  if (layers.effective === undefined || layers.failedLayer !== undefined || layers.organization.state === 'failed') return 'bundle-1';
  if (layers.organization.state === 'valid') return 'bundle-2';
  const stored = layers.personal?.stored;
  return typeof stored === 'object' && stored !== null && (stored as { readonly bundleVersion?: unknown }).bundleVersion === 2 ? 'bundle-2' : 'bundle-1';
}

/**
 * The runtime of a run nobody watches (a comparison task, a role test): presence none and an unattended context, so a floor ask is refused. `root` is the open project,
 * or none (undefined or empty) for a window with no folder: the per-install policy is still the real one, only the project log is missing.
 */
export function unattendedRuntimeFor(host: Pick<GateHost, 'runtimeFor'>, root: string | undefined, sessionId: string, agentLabel: string): Promise<GateRuntime> {
  return host.runtimeFor({ ...(root ? { root } : {}), actor: { kind: 'agent', sessionId, agentLabel }, presence: 'none', context: 'unattended' });
}

/**
 * A runtime per folder, asked of the host once and reused for every later call in that folder (PR #81 review): a panel that makes many model calls (Team
 * Studio) waits for the host's start at most once, never before each call. The runtime reads the host's policy at each decision, so a reused one is never
 * stale. With no host it gives none, and the caller decides with the default route. A request that fails is not kept, so the next call asks again.
 */
export function runtimePerRoot(host: Pick<GateHost, 'runtimeFor'> | undefined, request: (root: string) => RuntimeRequest): (root: string) => Promise<GateRuntime | undefined> {
  const kept = new Map<string, Promise<GateRuntime>>();
  return async (root) => {
    if (host === undefined) return undefined;
    let found = kept.get(root);
    if (found === undefined) {
      found = host.runtimeFor(request(root));
      kept.set(root, found);
      found.catch(() => { if (kept.get(root) === found) kept.delete(root); });
    }
    return found;
  };
}

/**
 * The one label a written file's entry takes from the chat's mark (D-26, D-29, PR #87 review): undefined when nothing rises. It is always a join, never a
 * replacement: with a label on the path now (its own entry, or a folder's or the project's), the mark's labels on that label's scale are joined onto it, and
 * a mark with nothing on that scale changes nothing (a map entry holds one label, and another scale in its place would lower it on its own; the chat's own
 * mark still keeps what it holds on this computer). With no label on the path, the mark's label whose routing tier is strictest is written.
 */
export function raisedEntryLabel(current: Mark, mark: readonly Label[], scales: ScaleTable, routing: RoutingTable): Label | undefined {
  const tier = (label: Label): number => {
    try { return TIER_ORDER[tierForLabel(label, routing)]; } catch { return TIER_ORDER.deny; }
  };
  const fold = (start: Label, labels: readonly Label[]): Label => labels.reduce((held, label) => (label.scale === held.scale ? joinLabels(held, label, scales) ?? held : held), start);
  if (current.length > 0) {
    // Each scale the path's label holds that the mark also holds is joined; a map entry holds one label, so of those that rise, the one whose routing tier
    // is strictest is written (PR #87 review round 2: a label on several scales no longer means nothing is written).
    let best: Label | undefined;
    for (const held of current) {
      if (!mark.some((each) => each.scale === held.scale)) continue;
      const joined = fold(held, mark);
      if (sameMark([joined], [held])) continue;
      if (best === undefined || tier(joined) > tier(best)) best = joined;
    }
    return best;
  }
  let best: Label | undefined;
  for (const label of mark) {
    const joined = fold(label, mark);
    if (best === undefined || tier(joined) > tier(best)) best = joined;
  }
  return best;
}

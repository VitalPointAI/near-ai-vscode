// TeamSession: the composition root of a running team (D-16, D-19, D-25, D-26). It checks the trust pin, builds the git transport and
// TeamLog, polls through SyncScheduler, shows the status bar, mirrors accepted roster events into the project audit log, and writes
// everything a user may need to see (rejected events, failures, the Check Team Record report) to the NEAR AI Team output channel.
// Nothing here swallows a failure: errors are redacted and written to the channel, and a failed sync also shows in the status bar.
// Only src/services/team may import vscode; the logic lives in src/team and src/domain/team.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { AuditEvent, AuditFilter } from '../../domain/approval';
import { DEFAULT_BASE_URL } from '../../domain/config';
import { ItemHistory } from '../../domain/team/itemHistory';
import type { HistoryEntry } from '../../domain/team/itemHistory';
import { memberAttention } from '../../domain/team/invite';
import type { MemberAttention } from '../../domain/team/invite';
import { teamMaterializer } from '../../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../../domain/team/types';
import { countReady, isCard } from '../../domain/team/work';
import type { CommittedEvent, GenesisAnchor, Role, TeamEvent, TeamFile, TeamState } from '../../domain/team/types';
import { AuditStore } from '../auditStore';
import { AuthService } from '../auth';
import type { SecretStorageLike } from '../auth';
import { ProfileStore } from '../profileStore';
import type { FetchLike } from '../reportingSignIn';
import { ROSTER_AUDIT_TYPES, fileMirrorMark, mirrorRosterEvents, projectMarkScope } from '../../team/auditMirror';
import type { AuditSink } from '../../team/auditMirror';
import { SNAPSHOT_ALREADY_WRITTEN, TeamLog } from '../../team/eventLog';
import type { TeamSigner, VerifyReport } from '../../team/eventLog';
import { GitTransport } from '../../team/gitTransport';
import { loadDeviceIdentity } from '../../team/identity';
import { installDeliveredKey } from '../../team/keyDelivery';
import type { DeviceIdentity } from '../../team/identity';
import { importPlans as runImportPlans, importResultText, readImportState } from '../../team/importPlans';
import type { ImportResult } from '../../team/importPlans';
import { remoteBranchHead } from '../../team/integrationSource';
import { handleOwnRemoval, readRemovedMarker, removedText } from '../../team/removedClient';
import type { GitRunner } from '../../team/runGit';
import { DEFAULT_POLL_SECONDS, SyncScheduler } from '../../team/syncScheduler';
import type { SchedulerTimers } from '../../team/syncScheduler';
import { NearSession } from '../../team/nearSession';
import { readInstalledKey, teamProfileId } from '../../team/teamKeyProfile';
import { checkNearPin, checkTrustPin, runSerialised, teamStorageDir, writeFileAtomic } from '../../team/teamFile';
import type { TransportStatus } from '../../team/transport';
import { PAUSED_REFUSED_TEXT, createTeamStatusBar, displayText, safeReason, statusText } from './teamStatusBar';
import type { TeamStatusBar, TeamStatusExtras } from './teamStatusBar';

export const TEAM_OUTPUT_CHANNEL = 'NEAR AI Team';
export const SHOW_DETAILS_ACTION = 'Show details';
export const UPDATE_EXTENSION_TEXT = 'Some events need a newer version of NEAR AI. Update the extension to read them.';
export const READ_ONLY_TEXT = 'This computer is not yet approved to make changes for this team. You can look at the board. Ask your lead to approve this computer.';
export const JOIN_COMMAND = 'nearAi.team.join';
export const MANAGE_MEMBERS_COMMAND = 'nearAi.team.manageMembers';
export const NOTIFIED_FILE = 'notified.json';
export const JOIN_ACTION = 'Join Team';
export const PERSONAL_KEY_WARNING = 'This team project is using your personal AI key, so the spend cap your lead set does not apply. Runs are marked as personal-key runs.';
export const USE_TEAM_KEY_ACTION = 'Use team key';
// The WR-02 notice's button. The command id is copied, like JOIN_COMMAND, so this module never loads the command module; teamManifest.test.ts pins it.
export const IMPORT_NOW_ACTION = 'Import now';
export const IMPORT_PLANS_COMMAND = 'nearAi.team.importPlans';
// After a key install failed, the same key is not tried again for this long, so a wrong organization does not hold up every poll.
const INSTALL_RETRY_MS = 5 * 60_000;
const VERIFY_PROGRESS_TITLE = 'Checking the team record';
const AUDIT_FILE_PARTS = ['.planning', '.near-ai', 'audit.json'];
// The integration branch is asked about at most this often (monotonic milliseconds), and only in an owner's or lead's window (D-03).
const AUTO_IMPORT_INTERVAL_MS = 60_000;
const ROADMAP_PARTS = ['.planning', 'ROADMAP.md'];

export interface TeamOutput { appendLine(line: string): void; show(preserveFocus?: boolean): void }
export interface TeamNotifier {
  info(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  warn(message: string, ...actions: string[]): PromiseLike<string | undefined>;
}

export interface TeamSessionDeps {
  projectRoot: string;
  globalStorageDir: string;
  teamFile: TeamFile;
  secrets: SecretStorageLike;
  output: TeamOutput;
  statusBar: TeamStatusBar;
  audit: AuditSink;
  notify: TeamNotifier;
  pollSeconds: () => number;
  focused: () => boolean;
  timers?: SchedulerTimers;
  git?: GitRunner;
  withProgress?: <T>(title: string, task: () => Promise<T>) => Promise<T>;
  /** NEAR AI Cloud's address (ending in /v1) for key checks and ending a NEAR session; the default is the public one. */
  nearBaseUrl?: string;
  fetch?: FetchLike;
  runCommand?: (id: string, args?: unknown) => PromiseLike<unknown>;
  /** False turns the automatic re-import of the integration branch off. The default is on, for owners and leads only. */
  autoImport?: boolean;
  /** Monotonic milliseconds for the automatic import throttle. The default is the scheduler's clock, performance.now(). */
  monotonicNow?: () => number;
}

function describeError(error: unknown): string {
  return safeReason(error instanceof Error ? error.message : String(error));
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// Text that came from the remote (a member name, an event id or file path) is flattened to one bounded line before it is printed.
function statusLabel(status: TransportStatus): string {
  if (status.state === 'ok') return 'ok';
  return status.reason === undefined ? status.state : `${status.state} (${safeReason(status.reason)})`;
}

// The Check Team Record report (D-25) as output lines. Nothing in it is a secret: ids, names, roles and public fingerprints only.
export function formatVerifyReport(report: VerifyReport, teamFile: TeamFile): string[] {
  const lines: string[] = [
    `Check Team Record: ${safeReason(teamFile.name)} (${teamFile.teamId})`,
    `Status: ${statusLabel(report.status)}`
  ];
  if (report.refused !== undefined) lines.push(`Log refused: ${safeReason(report.refused)}`);
  lines.push(
    `Events: ${report.events} (${report.accepted} accepted, ${report.rejected.length} rejected)`,
    `Head: lamport ${report.head.lamport}, event ${report.head.eventId === '' ? 'none' : safeReason(report.head.eventId)}`,
    `Members: ${report.members.length}`
  );
  for (const member of report.members) {
    const devices = member.devices.length === 0
      ? 'no devices'
      : member.devices.map((device) => `device ${safeReason(device.fingerprint)}${device.revoked ? ' (revoked)' : ''}`).join(', ');
    lines.push(`  ${safeReason(member.name)}, ${member.role}${member.removed ? ' (removed)' : ''}: ${devices}`);
  }
  lines.push(`Snapshots: ${report.snapshots}`, `Rejected events: ${report.rejected.length}`);
  for (const rejection of report.rejected) lines.push(`  Rejected event ${safeReason(rejection.eventId)}: ${safeReason(rejection.reason)}`);
  if (report.secretWarnings.length > 0) {
    lines.push('Secret-like values found (warning only):');
    for (const warning of report.secretWarnings) lines.push(`  ${safeReason(warning)}`);
  }
  if (report.unsupported > 0) lines.push(UPDATE_EXTENSION_TEXT);
  return lines;
}

async function auditFileHasEvent(projectRoot: string, eventId: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(path.join(projectRoot, ...AUDIT_FILE_PARTS), 'utf8');
  } catch (error) {
    // ENOTDIR: a file sits where the .planning folder should be, so nothing could have been written.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
  const parsed = JSON.parse(text) as { events?: Array<{ id?: unknown }> };
  return Array.isArray(parsed.events) && parsed.events.some((event) => event.id === eventId);
}

// AuditStore.persist swallows write failures (best-effort by design), so the mirror could otherwise advance its mark past entries that
// never reached disk. This sink uses a fresh store per mirror attempt (it reads the file again, so it cannot overwrite entries other
// writers added meanwhile, and a failed attempt leaves no phantom in-memory copy) and confirms every append by reading the file back.
// A failure throws, which keeps the mark where it was; the session retries on its next sync.
export function projectAuditSink(projectRoot: string, makeStore: (root: string) => AuditSink = (root) => new AuditStore(root)): AuditSink {
  let store: AuditSink | undefined;
  return {
    async list(filter: AuditFilter): Promise<AuditEvent[]> {
      store = makeStore(projectRoot);
      return store.list(filter);
    },
    async append(event: AuditEvent): Promise<void> {
      const target = store ?? makeStore(projectRoot);
      store = target;
      await target.append(event);
      if (!(await auditFileHasEvent(projectRoot, event.id))) {
        throw new Error('The team roster entry could not be saved to the project audit log.');
      }
    }
  };
}

// git's words for a failed connection carry how long it took or how much arrived ("Failed to connect to 127.0.0.1 port 1 after 0 ms",
// "Operation timed out after 30001 milliseconds with 0 out of 0 bytes received"). Those figures move with the machine's load, so they are left out
// when deciding whether a failure is new: otherwise a remote that stays down would be written again on every poll whose timing differs.
export function sameFailureKey(reason: string): string {
  return reason.replace(/\bwith \d+ out of \d+ bytes\b/gi, 'with # out of # bytes').replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|bytes?)\b/gi, '#');
}

export class TeamSession {
  public readonly teamFile: TeamFile;
  private readonly deps: TeamSessionDeps;
  private readonly storage: string;
  private readonly anchor: GenesisAnchor;
  private readonly transport: GitTransport<TeamState>;
  private readonly identity: DeviceIdentity | undefined;
  private readonly scheduler: SyncScheduler;
  private readonly diagnosticSubscription: { dispose(): void };
  private readonly updateSubscription: { dispose(): void };
  private readonly history = new ItemHistory();
  private readonly changeListeners = new Set<(entries: readonly CommittedEvent[]) => void>();
  // Whether a Team Board is open. It only changes how often this window polls; it is never written anywhere (Phase 60 D-19, T-62-26).
  private boardVisible = false;
  private log: TeamLog;
  private signing = false;
  private disposed = false;
  private syncing: Promise<void> = Promise.resolve();
  private firstRun: Promise<boolean> | undefined;
  private lastStatusKey: string | undefined;
  private readonly reportedRejections = new Set<string>();
  private readonly reportedIssues = new Map<string, string>();
  private refusalAnnounced = false;
  private pendingRoster: TeamEvent[] = [];
  // The author's role at each queued event's log position (WR-05), so a later promotion or demotion does not rewrite history.
  private readonly rosterRoles = new Map<string, Role>();
  // What this storage folder has already told the user (ids only), loaded on first use and written back after each addition.
  private notified: Set<string> | undefined;
  private removed = false;
  private personalKeyWarned = false;
  private installFailed: { event: string; retryAt: number } | undefined;
  // Imports from the command and from the automatic check run one after another through this chain.
  private importChain: Promise<unknown> = Promise.resolve();
  private lastAutoCheckAt: number | undefined;
  private lastCheckedHead: string | undefined;
  private importAnnounced = false;
  private lastStatus: TransportStatus | undefined;
  private lastGoodAt: string | undefined;

  private constructor(deps: TeamSessionDeps, storage: string, identity: DeviceIdentity | undefined) {
    this.deps = deps;
    this.teamFile = deps.teamFile;
    this.storage = storage;
    this.identity = identity;
    this.anchor = { teamId: deps.teamFile.teamId, eventId: deps.teamFile.genesis.eventId, ownerDevice: { ...deps.teamFile.genesis.ownerDevice } };
    this.transport = new GitTransport<TeamState>({
      mirrorDir: path.join(storage, 'coordination.git'), projectRoot: deps.projectRoot,
      remote: deps.teamFile.coordination.remote, ref: deps.teamFile.coordination.ref,
      materializer: teamMaterializer(this.anchor), ...(deps.git === undefined ? {} : { git: deps.git })
    });
    this.log = new TeamLog({ anchor: this.anchor, transport: this.transport });
    this.diagnosticSubscription = this.transport.onDiagnostic((message) => { this.line(`Team sync note: ${message}`); });
    // Subscribed before the first sync, so card history covers the whole window and own appends are heard like remote events (D-18).
    this.updateSubscription = this.transport.onUpdate((entries) => { this.entriesApplied(entries); });
    this.scheduler = new SyncScheduler({
      run: () => this.scheduledRun(),
      pollSeconds: deps.pollSeconds,
      focused: () => this.boardVisible || deps.focused(),
      onError: (error) => { this.reportIssue('scheduler', `Team sync stopped unexpectedly: ${describeError(error)}`); },
      ...(deps.timers === undefined ? {} : { timers: deps.timers })
    });
  }

  // D-16: the pin is checked before anything else exists, so a changed team.json stops the session with no timer and no transport work.
  public static async start(deps: TeamSessionDeps): Promise<TeamSession> {
    const storage = teamStorageDir(deps.globalStorageDir, deps.teamFile.teamId);
    // D-20: a computer that already saw its own removal stays removed: no pin check, no timer, no git call.
    const marker = await readRemovedMarker(deps.globalStorageDir, deps.teamFile.teamId);
    if (marker !== undefined) {
      const stopped = new TeamSession(deps, storage, undefined);
      stopped.removed = true;
      stopped.line(removedText(deps.teamFile.name));
      stopped.showRemoved();
      return stopped;
    }
    await checkTrustPin(storage, deps.teamFile);
    // CR-01: the first linked team.json this computer reads is pinned for NEAR key steps. A different link does not stop the session (the log
    // and the Link command still work); every key step refuses it and says why, and the reason is written here once.
    let nearPinProblem: string | undefined;
    try {
      await checkNearPin(storage, deps.teamFile);
    } catch (error) {
      nearPinProblem = describeError(error);
    }
    let identity: DeviceIdentity | undefined;
    let identityProblem: string | undefined;
    try {
      identity = await loadDeviceIdentity(deps.secrets, deps.teamFile.teamId);
    } catch (error) {
      identityProblem = `The device key for this team could not be read, so this computer runs read-only: ${describeError(error)}`;
    }
    const session = new TeamSession(deps, storage, identity);
    if (nearPinProblem !== undefined) session.line(nearPinProblem);
    if (identityProblem !== undefined) session.line(identityProblem);
    else if (identity === undefined) session.line(READ_ONLY_TEXT);
    // The scheduler runs the first sync as soon as it starts, so start waits for that run instead of syncing twice.
    session.scheduler.start();
    await session.firstRun;
    if (identity === undefined && identityProblem === undefined) await session.offerJoin();
    return session;
  }

  // Runs one sync now. It never rejects: a failure is written to the output channel and shown in the status bar.
  public sync(): Promise<boolean> {
    // A throw anywhere in a sync must not poison the chain: later syncs would otherwise skip syncOnce and replay the old rejection.
    const run = this.syncing.then(() => this.syncOnce()).catch((error: unknown) => {
      try {
        this.reportIssue('sync-internal', `Team sync failed unexpectedly: ${describeError(error)}`);
      } catch {
        // The output channel itself failed (for example during shutdown); the next sync reports again.
      }
      return false;
    });
    this.syncing = run.then(() => undefined);
    return run;
  }

  public currentLog(): TeamLog {
    return this.log;
  }

  public memberId(): string | undefined {
    return this.identity === undefined ? undefined : this.transport.state().deviceIndex.get(this.identity.fingerprint);
  }

  public isRemoved(): boolean {
    return this.removed;
  }

  public storageDir(): string {
    return this.storage;
  }

  public state(): TeamState {
    return this.transport.state();
  }

  public nudge(): void {
    this.scheduler.nudge();
  }

  // Only a real focus change does anything: a gain syncs at once, a loss moves the next poll to the unfocused delay. Repeating the current focus is ignored.
  public focusChanged(focused: boolean): void {
    this.scheduler.focusChanged(focused || this.boardVisible);
  }

  // A visible board polls at the focused interval even when the window is not focused (Phase 60 D-19). The scheduler already owns the timer, so this
  // only changes what it reads next; nothing about who looked is recorded anywhere.
  public setBoardVisible(visible: boolean): void {
    if (this.boardVisible === visible) return;
    this.boardVisible = visible;
    this.scheduler.focusChanged(this.deps.focused() || visible);
  }

  // Told once per transport update (a poll that brought events, or this session's own append) with the entries it carried.
  public onStateChange(listener: (entries: readonly CommittedEvent[]) => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => { this.changeListeners.delete(listener); } };
  }

  public itemHistory(itemId: string): HistoryEntry[] {
    return this.history.forItem(itemId);
  }

  // Whether this window can write to the team log: it needs a device key that belongs to a member who has not been removed.
  public canWrite(): boolean {
    return this.signing && !this.removed && !this.disposed;
  }

  // The chip the board shows: the word, and for offline and paused the reason. lastUpdated is when a sync last read the log (display only, orders nothing).
  public boardStatus(): { kind: 'live' | 'syncing' | 'offline' | 'paused' | 'removed'; text: string; lastUpdated?: string } {
    const lastUpdated = this.lastGoodAt === undefined ? {} : { lastUpdated: this.lastGoodAt };
    if (this.removed) return { kind: 'removed', text: 'Removed' };
    const status = this.lastStatus;
    if (status === undefined) return { kind: 'syncing', text: 'Syncing...', ...lastUpdated };
    const reason = status.reason === undefined ? '' : `: ${safeReason(status.reason)}`;
    if (status.state === 'ok') return { kind: 'live', text: 'Live', ...lastUpdated };
    if (status.state === 'paused') return { kind: 'paused', text: `Paused${reason}`, ...lastUpdated };
    return { kind: 'offline', text: `Offline${reason}`, ...lastUpdated };
  }

  // The one way to import the integration branch's plans (the command and the automatic check both come here). Runs are queued, so two never overlap:
  // the later one starts after the earlier one finished and then finds nothing left to write.
  public importPlans(options: { milestone?: string; mode: 'auto' | 'command' }): Promise<ImportResult> {
    const run = this.importChain.then(() => this.runImport(options), () => this.runImport(options));
    this.importChain = run.then(() => undefined, () => undefined);
    return run;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.stop();
    this.diagnosticSubscription.dispose();
    this.updateSubscription.dispose();
    this.changeListeners.clear();
    this.deps.statusBar.dispose();
  }

  // D-25: replay the whole log from genesis, print the report, and summarise it in a notification.
  public async verifyLog(): Promise<VerifyReport | undefined> {
    let report: VerifyReport;
    try {
      const task = (): Promise<VerifyReport> => this.log.verifyAll();
      report = this.deps.withProgress === undefined ? await task() : await this.deps.withProgress(VERIFY_PROGRESS_TITLE, task);
    } catch (error) {
      this.line(`Check Team Record failed: ${describeError(error)}`);
      this.deps.output.show(true);
      this.announce('warn', 'The team check could not finish. Choose Show details to see why.');
      return undefined;
    }
    for (const reportLine of formatVerifyReport(report, this.teamFile)) this.deps.output.appendLine(reportLine);
    this.deps.output.show(true);
    const counts = `${plural(report.events, 'event')}, ${plural(report.members.length, 'member')}, ${report.rejected.length} rejected`;
    const problems = report.refused !== undefined || report.rejected.length > 0 || report.unsupported > 0;
    if (!problems) {
      this.announce('info', `The team record passed its check: ${counts}`);
    } else {
      const extras = [
        report.refused === undefined ? '' : ' The record failed its safety check. Choose Show details to see why.',
        report.unsupported > 0 ? ` ${UPDATE_EXTENSION_TEXT}` : ''
      ].join('');
      this.announce('warn', `The team record was checked and has problems: ${counts}.${extras}`);
    }
    return report;
  }

  private async runImport(options: { milestone?: string; mode: 'auto' | 'command' }): Promise<ImportResult> {
    if (!this.signing) return { ok: false, message: READ_ONLY_TEXT, written: 0 };
    if (this.removed || this.disposed) return { ok: false, message: removedText(displayText(this.teamFile.name)), written: 0 };
    return runImportPlans({
      log: this.log,
      source: { projectRoot: this.deps.projectRoot, remote: this.teamFile.coordination.remote, branch: this.transport.state().team.policy.integrationBranch },
      storageDir: this.storage, mode: options.mode, ...(options.milestone === undefined ? {} : { milestone: options.milestone }),
      ...(this.deps.git === undefined ? {} : { git: this.deps.git })
    });
  }

  private monotonicNow(): number {
    if (this.deps.monotonicNow !== undefined) return this.deps.monotonicNow();
    return this.deps.timers?.now() ?? performance.now();
  }

  private async hasRoadmapFile(): Promise<boolean> {
    try {
      return (await fs.stat(path.join(this.deps.projectRoot, ...ROADMAP_PARTS))).isFile();
    } catch {
      return false;
    }
  }

  // D-03: an owner's or lead's window keeps the board in step with the integration branch. The role is checked before any git call, the roadmap file only
  // says the project uses GSD, and the remote is asked at most once a minute. Returns true when the import wrote something. It never throws; a failure is
  // written once to the output channel and shows no popup, and the notice that something was imported comes once per window.
  private async checkIntegration(): Promise<boolean> {
    if (this.deps.autoImport === false || !this.signing || this.disposed || this.removed) return false;
    try {
      const state = this.transport.state();
      const id = this.memberId();
      const me = id === undefined ? undefined : state.members.get(id);
      if (me === undefined || me.removedEvent !== undefined || (me.role !== 'owner' && me.role !== 'lead')) return false;
      if (!(await this.hasRoadmapFile())) return false;
      const now = this.monotonicNow();
      if (this.lastAutoCheckAt !== undefined && now >= this.lastAutoCheckAt && now - this.lastAutoCheckAt < AUTO_IMPORT_INTERVAL_MS) return false;
      this.lastAutoCheckAt = now;
      const head = await remoteBranchHead(this.deps.projectRoot, this.teamFile.coordination.remote, state.team.policy.integrationBranch, this.deps.git);
      if (head === undefined) {
        this.clearIssue('auto-import');
        return false;
      }
      if (head === this.lastCheckedHead || head === (await readImportState(this.storage))?.sourceCommit) {
        this.clearIssue('auto-import');
        return false;
      }
      const result = await this.importPlans({ mode: 'auto' });
      if (!result.ok) {
        this.reportIssue('auto-import', `The roadmap on the integration branch was not imported: ${result.message}${result.detail === undefined ? '' : ` (${result.detail})`}`);
        return result.written > 0;
      }
      this.clearIssue('auto-import');
      this.lastCheckedHead = head;
      if (result.skipped === 'needs-command') {
        // Told once per head that moved: the lead decides, with Import now on the notice or the Import command (WR-02).
        const run = this.deps.runCommand;
        if (run === undefined) this.say('info', importResultText(result));
        else this.offer('info', importResultText(result), [{ label: IMPORT_NOW_ACTION, run: () => run(IMPORT_PLANS_COMMAND) }]);
        return false;
      }
      if (result.written > 0 && !this.importAnnounced) {
        this.importAnnounced = true;
        this.say('info', importResultText(result));
      }
      return result.written > 0;
    } catch (error) {
      this.reportIssue('auto-import', `The roadmap on the integration branch could not be checked: ${describeError(error)}`);
      return false;
    }
  }

  private entriesApplied(entries: readonly CommittedEvent[]): void {
    if (entries.length === 0) return;
    this.history.record(entries);
    for (const listener of [...this.changeListeners]) {
      try {
        listener(entries);
      } catch (error) {
        // A failing listener must not break the sync or the other listeners; it is reported once per message.
        this.reportIssue('state-listener', `A Team Board update could not be shown: ${describeError(error)}`);
      }
    }
  }

  private scheduledRun(): Promise<boolean> {
    const run = this.sync();
    if (this.firstRun === undefined) this.firstRun = run;
    return run;
  }

  private line(text: string): void {
    this.deps.output.appendLine(safeReason(text));
  }

  // The same failure is written once until it changes or clears, so a remote that stays down does not fill the channel every poll. Two reasons that
  // differ only in a time or byte figure are the same failure (see sameFailureKey).
  private reportIssue(category: string, text: string): void {
    const key = sameFailureKey(text);
    if (this.reportedIssues.get(category) === key) return;
    this.reportedIssues.set(category, key);
    this.line(text);
  }

  private clearIssue(category: string): void {
    this.reportedIssues.delete(category);
  }

  private announce(level: 'info' | 'warn', message: string): void {
    const shown = level === 'info' ? this.deps.notify.info(message, SHOW_DETAILS_ACTION) : this.deps.notify.warn(message, SHOW_DETAILS_ACTION);
    Promise.resolve(shown)
      .then((choice) => { if (choice === SHOW_DETAILS_ACTION) this.deps.output.show(); })
      .catch((error: unknown) => { this.line(`A Team Mode message could not be shown: ${describeError(error)}`); });
  }

  private async syncOnce(): Promise<boolean> {
    if (this.disposed || this.removed) return false;
    let status: TransportStatus;
    let synced = false;
    try {
      const result = await this.log.sync();
      status = result.status;
      this.noteRejections(result.rejected);
      this.queueRoster(result.accepted, result.authorRoles);
      this.noteSnapshot(result.snapshot);
      this.adoptSigner();
      this.clearIssue('sync');
      synced = status.state === 'ok';
    } catch (error) {
      const reason = describeError(error);
      this.reportIssue('sync', `Team sync failed: ${reason}`);
      status = { state: 'offline', reason };
    }
    // A log that does not match the team's genesis anchor reads fine over the transport, so the transport status stays ok. It is still
    // the central trust failure, so it gets its own paused state, one warning and a backoff instead of "sync working" (WR-06).
    const refused = status.state === 'ok' ? this.log.state().refused : undefined;
    if (refused !== undefined) {
      status = { state: 'paused', reason: TEAM_REJECTION_REASONS.logRefused };
      if (!this.refusalAnnounced) {
        this.refusalAnnounced = true;
        this.line(`${PAUSED_REFUSED_TEXT}: ${TEAM_REJECTION_REASONS.logRefused}. Team events from this remote are ignored.`);
        this.announce('warn', `${PAUSED_REFUSED_TEXT}: it does not belong to this project's team, so new team activity is ignored. Click the team status to check the team, or ask your lead.`);
      }
    }
    // The reactions run after the sync steps above and only on a log that was read and is trusted; they never throw out of here.
    const trusted = synced && refused === undefined;
    const extras = await this.reactToMembers(trusted);
    if (trusted) this.countCards(extras);
    this.showStatus(status, extras);
    if (trusted && (await this.checkIntegration())) {
      // The import changed the board, so the count in the status bar follows it at once.
      this.countCards(extras);
      this.showStatus(status, extras);
    }
    await this.mirror();
    return status.state === 'ok';
  }

  // Once the log has cards the status bar shows how many are ready; before that it shows no count (D-17). The count is derived on every sync from the
  // materialised items, so it follows the same poll that brought the change.
  private countCards(extras: TeamStatusExtras): void {
    if (extras.removed === true) return;
    const items = this.transport.state().items;
    for (const item of items.values()) {
      if (isCard(item)) {
        extras.ready = countReady(items);
        return;
      }
    }
  }

  private showRemoved(): void {
    if (!this.disposed) this.deps.statusBar.update({ state: 'ok' }, this.teamFile.name, { removed: true });
  }

  private showStatus(status: TransportStatus, extras: TeamStatusExtras = {}): void {
    if (this.disposed) return;
    if (this.removed) {
      this.showRemoved();
      return;
    }
    this.lastStatus = status;
    if (status.state === 'ok') this.lastGoodAt = new Date().toISOString();
    this.deps.statusBar.update(status, this.teamFile.name, extras);
    const key = `${status.state}:${sameFailureKey(status.reason ?? '')}`;
    if (key === this.lastStatusKey) return;
    const recovered = this.lastStatusKey !== undefined && status.state === 'ok';
    this.lastStatusKey = key;
    if (status.state === 'ok') {
      this.line(recovered ? 'Team sync is working again.' : `Team sync is running for ${this.teamFile.name}.`);
      return;
    }
    const shown = statusText(status, this.teamFile.name);
    this.line(status.reason === undefined ? shown.plain : `${shown.plain}. ${status.reason}`);
  }

  // Rejected events go to the channel once per event and reason in a session. They never reach the audit log (D-26).
  private noteRejections(rejected: Array<{ eventId: string; reason: string }>): void {
    for (const rejection of rejected) {
      const key = `${rejection.eventId}\n${rejection.reason}`;
      if (this.reportedRejections.has(key)) continue;
      this.reportedRejections.add(key);
      this.line(`Rejected event ${rejection.eventId}: ${rejection.reason}`);
    }
  }

  private noteSnapshot(snapshot: { ok: boolean; reason?: string } | undefined): void {
    if (snapshot === undefined) return;
    if (snapshot.ok) {
      this.clearIssue('snapshot');
      return;
    }
    if (snapshot.reason !== undefined && snapshot.reason !== SNAPSHOT_ALREADY_WRITTEN) this.reportIssue('snapshot', `Team snapshot not written: ${snapshot.reason}`);
  }

  // Accepted roster events wait here until the audit mirror has really stored them, so a failed write is retried and never lost.
  private queueRoster(accepted: TeamEvent[], authorRoles: Map<string, Role>): void {
    for (const event of accepted) {
      if (!(ROSTER_AUDIT_TYPES as readonly string[]).includes(event.type)) continue;
      this.pendingRoster.push(event);
      const role = authorRoles.get(event.id);
      if (role !== undefined) this.rosterRoles.set(event.id, role);
    }
  }

  private async mirror(): Promise<void> {
    if (this.pendingRoster.length === 0) return;
    const batch = [...this.pendingRoster];
    try {
      const roleOf = (_memberId: string, event: TeamEvent): Role | undefined => this.rosterRoles.get(event.id);
      await mirrorRosterEvents(this.deps.audit, fileMirrorMark(this.storage, projectMarkScope(this.deps.projectRoot)), batch, roleOf);
      for (const event of batch) this.rosterRoles.delete(event.id);
      this.pendingRoster = this.pendingRoster.filter((event) => !batch.includes(event));
      this.clearIssue('audit');
    } catch (error) {
      this.reportIssue('audit', `Team audit mirror failed, it will try again: ${describeError(error)}`);
    }
  }

  // ---- member lifecycle reactions (D-16, D-24, D-25) ---------------------------------------------------------------------------------

  private notifiedFile(): string {
    return path.join(this.storage, NOTIFIED_FILE);
  }

  private async loadNotified(): Promise<Set<string>> {
    if (this.notified !== undefined) return this.notified;
    const keys = new Set<string>();
    let text: string | undefined;
    try {
      text = await fs.readFile(this.notifiedFile(), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text) as { keys?: unknown };
        if (Array.isArray(parsed.keys)) for (const key of parsed.keys) if (typeof key === 'string') keys.add(key);
      } catch {
        // A damaged file reads as nothing told yet; the next addition writes it again.
        keys.clear();
      }
    }
    this.notified = keys;
    return keys;
  }

  // True the first time a key is seen in this storage folder. The key is remembered on disk (ids only) so a reload does not repeat the message.
  private async firstTime(key: string): Promise<boolean> {
    const keys = await this.loadNotified();
    if (keys.has(key)) return false;
    keys.add(key);
    const file = this.notifiedFile();
    try {
      await runSerialised(file, () => writeFileAtomic(file, `${JSON.stringify({ v: 1, keys: [...keys].sort() }, null, 2)}\n`));
      this.clearIssue('notified');
    } catch (error) {
      this.reportIssue('notified', `Team Mode could not remember which messages it showed: ${describeError(error)}`);
    }
    return true;
  }

  // Shows a message with buttons without waiting for the user, and runs the command a button maps to.
  private offer(level: 'info' | 'warn', message: string, choices: Array<{ label: string; run: () => PromiseLike<unknown> | void }>): void {
    const labels = choices.map((choice) => choice.label);
    const shown = level === 'info' ? this.deps.notify.info(message, ...labels) : this.deps.notify.warn(message, ...labels);
    Promise.resolve(shown)
      .then((picked) => {
        const choice = choices.find((candidate) => candidate.label === picked);
        return choice === undefined ? undefined : choice.run();
      })
      .catch((error: unknown) => { this.line(`A Team Mode action could not run: ${describeError(error)}`); });
  }

  private runManage(memberId: string, action: MemberAttention['kind'] | 'remove'): PromiseLike<unknown> | void {
    if (this.deps.runCommand === undefined) {
      this.line('This action needs the editor, so it was not run.');
      return undefined;
    }
    return this.deps.runCommand(MANAGE_MEMBERS_COMMAND, { memberId, action });
  }

  // The NEAR account this team's session is signed in as on this computer, if any. Reading it touches SecretStorage only, never the network.
  private async nearLabel(): Promise<string | undefined> {
    try {
      const session = new NearSession({ teamId: this.teamFile.teamId, secrets: this.deps.secrets, baseUrl: this.deps.nearBaseUrl ?? DEFAULT_BASE_URL });
      return (await session.signedIn())?.label;
    } catch (error) {
      this.reportIssue('near-label', `The NEAR AI sign-in for this team could not be read: ${describeError(error)}`);
      return undefined;
    }
  }

  private async reactToMembers(trusted: boolean): Promise<TeamStatusExtras> {
    const extras: TeamStatusExtras = { nearLinked: this.teamFile.near !== undefined };
    const label = await this.nearLabel();
    if (label !== undefined) extras.nearLabel = label;
    if (!trusted) return extras;
    try {
      const state = this.transport.state();
      const id = this.memberId();
      const me = id === undefined ? undefined : state.members.get(id);
      if (id !== undefined && me?.removedEvent !== undefined) {
        await this.handleRemoval(id, me.removedEvent);
        extras.removed = true;
        return extras;
      }
      if (me !== undefined) {
        await this.installKey(me);
        await this.warnPersonalKey();
      }
      if (me !== undefined && me.removedEvent === undefined && this.signing && (me.role === 'owner' || me.role === 'lead')) {
        const items = memberAttention(state, this.teamFile.near !== undefined);
        extras.pending = items.filter((item) => item.kind === 'confirm').length;
        await this.announceAttention(state, items);
      }
      this.clearIssue('members');
    } catch (error) {
      this.reportIssue('members', `Team Mode could not check the members after the sync: ${describeError(error)}`);
    }
    return extras;
  }

  // D-20: this computer's own member was removed. The scheduler is stopped first, the flag is set before any await so nothing re-enters,
  // and the clean-up (this team's secrets only) runs once; removed.json makes a reload start in the same state.
  private async handleRemoval(memberId: string, removedEvent: string): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    this.scheduler.stop();
    const team = displayText(this.teamFile.name);
    try {
      const result = await handleOwnRemoval({
        projectRoot: this.deps.projectRoot, globalStorageDir: this.deps.globalStorageDir, teamFile: this.teamFile, memberId, removedEvent,
        secrets: this.deps.secrets, nearBaseUrl: this.deps.nearBaseUrl ?? DEFAULT_BASE_URL, ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch })
      });
      if (result.failed !== undefined) this.line(`After your removal, these clean-up steps did not finish: ${result.failed.join(', ')}.`);
    } catch (error) {
      this.line(`The clean-up after your removal could not finish: ${describeError(error)}`);
    }
    this.line(removedText(this.teamFile.name));
    this.announce('warn', removedText(team));
  }

  // The member's side of key delivery (D-14, D-23): open the sealed key meant for this device and make it the project's team key.
  private async installKey(member: { nearKeyEvent?: string }): Promise<void> {
    const identity = this.identity;
    if (identity === undefined || member.nearKeyEvent === undefined) return;
    const now = this.deps.timers?.now() ?? Date.now();
    if (this.installFailed !== undefined && this.installFailed.event === member.nearKeyEvent && now < this.installFailed.retryAt) return;
    const team = displayText(this.teamFile.name);
    const result = await installDeliveredKey({
      projectRoot: this.deps.projectRoot, globalStorageDir: this.deps.globalStorageDir, teamFile: this.teamFile, log: this.log,
      deviceFingerprint: identity.fingerprint, secrets: this.deps.secrets, baseUrl: this.deps.nearBaseUrl ?? DEFAULT_BASE_URL,
      ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch })
    });
    if (result.status === 'installed') {
      this.installFailed = undefined;
      this.clearIssue('key-install');
      this.line(`The team key for ${this.teamFile.name} was installed for this project.`);
      this.say('info', `Your team key for ${team} is ready. NEAR AI uses it for this project now.`);
    } else if (result.status === 'failed') {
      this.installFailed = { event: member.nearKeyEvent, retryAt: now + INSTALL_RETRY_MS };
      const text = `The team key for ${this.teamFile.name} could not be installed: ${safeReason(result.message)}`;
      const before = this.reportedIssues.get('key-install');
      this.reportIssue('key-install', text);
      if (before !== sameFailureKey(text)) this.say('warn', `The team key for ${team} could not be installed: ${displayText(result.message, 300)}`);
    } else {
      this.installFailed = undefined;
    }
  }

  // D-14: a member whose team key is installed but who has another profile selected is spending outside the lead's cap. Said once per session,
  // with the way back. Nothing is said when no team key was ever installed here (the owner, or a member still waiting for theirs).
  private async warnPersonalKey(): Promise<void> {
    if (this.personalKeyWarned || this.identity === undefined) return;
    if ((await readInstalledKey(this.deps.globalStorageDir, this.teamFile.teamId))?.keyId === undefined) return;
    const store = new ProfileStore(this.deps.projectRoot, new AuthService(this.deps.secrets));
    const selected = (await store.getActiveSelection())?.profileId;
    const teamProfile = teamProfileId(this.teamFile.teamId);
    if (selected === undefined || selected === teamProfile) return;
    this.personalKeyWarned = true;
    this.line('This project is using a personal AI key, not the team key.');
    this.offer('warn', PERSONAL_KEY_WARNING, [{ label: USE_TEAM_KEY_ACTION, run: async () => { await store.select(teamProfile); } }]);
  }

  // A message with no buttons, shown without waiting.
  private say(level: 'info' | 'warn', message: string): void {
    const shown = level === 'info' ? this.deps.notify.info(message) : this.deps.notify.warn(message);
    Promise.resolve(shown).catch((error: unknown) => { this.line(`A Team Mode message could not be shown: ${describeError(error)}`); });
  }

  // D-07 and Phase 60 D-22: the project has a team this computer is not in. Offered once per storage folder, only where a command can run.
  private async offerJoin(): Promise<void> {
    if (this.deps.runCommand === undefined || this.removed || this.disposed) return;
    try {
      if (!(await this.firstTime('join-offer'))) return;
    } catch (error) {
      this.reportIssue('join-offer', `Team Mode could not check whether Join was offered: ${describeError(error)}`);
      return;
    }
    const run = this.deps.runCommand;
    this.offer('info', `${displayText(this.teamFile.name)} has a team and this computer has not joined it. Join it to work with the team.`, [
      { label: JOIN_ACTION, run: () => run(JOIN_COMMAND) }
    ]);
  }

  // One message per item, remembered by the event that created the need so it is shown once even across reloads.
  private async announceAttention(state: TeamState, items: MemberAttention[]): Promise<void> {
    const team = displayText(this.teamFile.name);
    for (const item of items) {
      const member = state.members.get(item.memberId);
      if (member === undefined) continue;
      const name = displayText(member.name);
      const keyEvent = member.nearKeyEvent ?? member.joinedEvent;
      if (item.kind === 'confirm') {
        if (!(await this.firstTime(`confirm:${member.joinedEvent}`))) continue;
        this.offer('info', `${name} joined ${team} and is waiting for confirmation`, [
          { label: 'Confirm', run: () => this.runManage(member.id, 'confirm') },
          { label: 'Remove', run: () => this.runManage(member.id, 'remove') }
        ]);
      } else if (item.kind === 'deliver-key') {
        if (!(await this.firstTime(`deliver-key:${member.id}:${keyEvent}`))) continue;
        this.offer('info', `${name} is confirmed and still needs an AI key`, [{ label: 'Send key', run: () => this.runManage(member.id, 'deliver-key') }]);
      } else {
        if (!(await this.firstTime(`rotate-key:${member.id}:${keyEvent}`))) continue;
        this.offer('info', `${name}'s AI key has to be replaced because their devices changed`, [{ label: 'Rotate key', run: () => this.runManage(member.id, 'rotate-key') }]);
      }
    }
  }

  // The signer needs the member id this computer's key belongs to, which is only known once the roster has been read.
  private adoptSigner(): void {
    if (this.signing || this.identity === undefined) return;
    const state = this.transport.state();
    const memberId = state.deviceIndex.get(this.identity.fingerprint);
    const member = memberId === undefined ? undefined : state.members.get(memberId);
    if (memberId === undefined || member === undefined || member.removedEvent !== undefined) return;
    const signer: TeamSigner = { identity: this.identity, memberId };
    this.log = new TeamLog({ anchor: this.anchor, transport: this.transport, signer });
    this.signing = true;
  }
}

// Turns window-state events into focus transitions (G-60-1). VS Code also fires onDidChangeWindowState when only the window's
// activity changes, so the returned listener remembers the last focus value and forwards a value only when it differs from it.
export function focusTransitions(initialFocused: boolean, forward: (focused: boolean) => void): (state: { focused: boolean }) => void {
  let last = initialFocused;
  return (state) => {
    if (state.focused === last) return;
    last = state.focused;
    forward(state.focused);
  };
}

// The real editor services (D-16, D-19, D-25). Every disposable lands on context.subscriptions.
// Tests pass their own timers and git runner through overrides. The extension passes nothing.
export async function createVscodeTeamSession(
  context: vscode.ExtensionContext, projectRoot: string, teamFile: TeamFile, output: TeamOutput,
  overrides: Pick<TeamSessionDeps, 'timers' | 'git'> = {}
): Promise<TeamSession> {
  const statusBar = createTeamStatusBar();
  let session: TeamSession;
  try {
    session = await TeamSession.start({
      projectRoot, globalStorageDir: context.globalStorageUri.fsPath, teamFile, secrets: context.secrets, output, statusBar,
      audit: projectAuditSink(projectRoot),
      notify: {
        info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
        warn: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions)
      },
      pollSeconds: () => vscode.workspace.getConfiguration('nearAi.team').get<number>('pollSeconds', DEFAULT_POLL_SECONDS),
      focused: () => vscode.window.state.focused,
      runCommand: (id, args) => vscode.commands.executeCommand(id, args),
      withProgress: <T>(title: string, task: () => Promise<T>): Promise<T> =>
        Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => task())),
      ...overrides
    });
  } catch (error) {
    statusBar.dispose();
    throw error;
  }
  context.subscriptions.push(
    session,
    vscode.window.onDidChangeWindowState(focusTransitions(vscode.window.state.focused, (focused) => { session.focusChanged(focused); })),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi.team.pollSeconds')) session.nudge(); })
  );
  return session;
}

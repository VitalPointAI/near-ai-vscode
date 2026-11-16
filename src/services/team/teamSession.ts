// TeamSession: the composition root of a running team (D-16, D-19, D-25, D-26). It checks the trust pin, builds the git transport and
// TeamLog, polls through SyncScheduler, shows the status bar, mirrors accepted roster events into the project audit log, and writes
// everything a user may need to see (rejected events, failures, the Verify Team Log report) to the NEAR AI Team output channel.
// Nothing here swallows a failure: errors are redacted and written to the channel, and a failed sync also shows in the status bar.
// Only src/services/team may import vscode; the logic lives in src/team and src/domain/team.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AuditEvent, AuditFilter } from '../../domain/approval';
import { teamMaterializer } from '../../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../../domain/team/types';
import type { GenesisAnchor, Role, TeamEvent, TeamFile, TeamState } from '../../domain/team/types';
import { AuditStore } from '../auditStore';
import type { SecretStorageLike } from '../auth';
import { ROSTER_AUDIT_TYPES, fileMirrorMark, mirrorRosterEvents, projectMarkScope } from '../../team/auditMirror';
import type { AuditSink } from '../../team/auditMirror';
import { SNAPSHOT_ALREADY_WRITTEN, TeamLog } from '../../team/eventLog';
import type { TeamSigner, VerifyReport } from '../../team/eventLog';
import { GitTransport } from '../../team/gitTransport';
import { loadDeviceIdentity } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import type { GitRunner } from '../../team/runGit';
import { DEFAULT_POLL_SECONDS, SyncScheduler } from '../../team/syncScheduler';
import type { SchedulerTimers } from '../../team/syncScheduler';
import { checkTrustPin, projectTrustDir, teamStorageDir } from '../../team/teamFile';
import type { TransportStatus } from '../../team/transport';
import { PAUSED_REFUSED_TEXT, createTeamStatusBar, safeReason, statusText } from './teamStatusBar';
import type { TeamStatusBar } from './teamStatusBar';

export const TEAM_OUTPUT_CHANNEL = 'NEAR AI Team';
// The context key the manifest's palette when clause reads (D-24): true while a team session runs, so Verify Team Log is never hidden from a team project.
export const TEAM_ACTIVE_CONTEXT = 'nearAi.team.active';
export const SHOW_DETAILS_ACTION = 'Show details';
export const UPDATE_EXTENSION_TEXT = 'Some events need a newer version of NEAR AI. Update the extension to read them.';
export const READ_ONLY_TEXT = 'This computer is not a device of this team yet, so it can read the team record but not write to it.';
const VERIFY_PROGRESS_TITLE = 'Checking the team record';
const AUDIT_FILE_PARTS = ['.planning', '.near-ai', 'audit.json'];

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
  // Called with true once the session has started and with false when it is disposed (the nearAi.team.active context key).
  activeChanged?: (active: boolean) => void;
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

// An active key carries no label. Any other state is named, so a rotated or revoked key is never read as a working one.
function deviceStateLabel(device: { state: string; replacedBy?: string }): string {
  if (device.state === 'active') return '';
  if (device.state === 'rotated' && device.replacedBy !== undefined) return ` (rotated, replaced by ${safeReason(device.replacedBy)})`;
  return ` (${device.state})`;
}

// The Verify Team Log report (D-25) as output lines. Nothing in it is a secret: ids, names, roles and public fingerprints only.
export function formatVerifyReport(report: VerifyReport, teamFile: TeamFile): string[] {
  const lines: string[] = [
    `Verify Team Log: ${safeReason(teamFile.name)} (${teamFile.teamId})`,
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
      : member.devices.map((device) => `device ${safeReason(device.fingerprint)}${deviceStateLabel(device)}`).join(', ');
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
  private log: TeamLog;
  private signing = false;
  private readOnlyNoted = false;
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
    this.scheduler = new SyncScheduler({
      run: () => this.scheduledRun(),
      pollSeconds: deps.pollSeconds,
      focused: deps.focused,
      onError: (error) => { this.reportIssue('scheduler', `Team sync stopped unexpectedly: ${describeError(error)}`); },
      ...(deps.timers === undefined ? {} : { timers: deps.timers })
    });
  }

  // D-16: the pin is checked before anything else exists, so a changed team.json stops the session with no timer and no transport work.
  // The pin is kept per project, so a team.json that swaps the team id is compared with the team this project had, never trusted afresh.
  public static async start(deps: TeamSessionDeps): Promise<TeamSession> {
    await checkTrustPin(projectTrustDir(deps.globalStorageDir, deps.projectRoot), deps.teamFile);
    const storage = teamStorageDir(deps.globalStorageDir, deps.teamFile.teamId);
    let identity: DeviceIdentity | undefined;
    let identityProblem: string | undefined;
    try {
      identity = await loadDeviceIdentity(deps.secrets);
    } catch (error) {
      identityProblem = `The identity key on this computer could not be read, so it can read the team record but not write to it: ${describeError(error)}`;
    }
    const session = new TeamSession(deps, storage, identity);
    if (identityProblem !== undefined) session.line(identityProblem);
    else if (identity === undefined) session.noteReadOnly();
    // The scheduler runs the first sync as soon as it starts, so start waits for that run instead of syncing twice.
    session.scheduler.start();
    await session.firstRun;
    deps.activeChanged?.(true);
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

  public nudge(): void {
    this.scheduler.nudge();
  }

  // Only a real focus change does anything: a gain syncs at once, a loss moves the next poll to the unfocused delay. Repeating the current focus is ignored.
  public focusChanged(focused: boolean): void {
    this.scheduler.focusChanged(focused);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.stop();
    this.diagnosticSubscription.dispose();
    this.deps.statusBar.dispose();
    this.deps.activeChanged?.(false);
  }

  // D-25: replay the whole log from genesis, print the report, and summarise it in a notification.
  public async verifyLog(): Promise<VerifyReport | undefined> {
    let report: VerifyReport;
    try {
      const task = (): Promise<VerifyReport> => this.log.verifyAll();
      report = this.deps.withProgress === undefined ? await task() : await this.deps.withProgress(VERIFY_PROGRESS_TITLE, task);
    } catch (error) {
      this.line(`Verify Team Log failed: ${describeError(error)}`);
      this.deps.output.show(true);
      this.announce('warn', `Verify Team Log could not finish: ${describeError(error)}`);
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
    if (this.disposed) return false;
    let status: TransportStatus;
    try {
      const result = await this.log.sync();
      status = result.status;
      this.noteRejections(result.rejected);
      this.queueRoster(result.accepted, result.authorRoles);
      this.noteSnapshot(result.snapshot);
      this.adoptSigner();
      this.clearIssue('sync');
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
        this.announce('warn', `${PAUSED_REFUSED_TEXT}: ${TEAM_REJECTION_REASONS.logRefused}. Team events from this remote are ignored.`);
      }
    }
    this.showStatus(status);
    await this.mirror();
    return status.state === 'ok';
  }

  private showStatus(status: TransportStatus): void {
    if (this.disposed) return;
    this.deps.statusBar.update(status, this.teamFile.name);
    const key = `${status.state}:${sameFailureKey(status.reason ?? '')}`;
    if (key === this.lastStatusKey) return;
    const recovered = this.lastStatusKey !== undefined && status.state === 'ok';
    this.lastStatusKey = key;
    if (status.state === 'ok') {
      this.line(recovered ? 'Team sync is working again.' : `Team sync is running for ${this.teamFile.name}.`);
      return;
    }
    const shown = statusText(status, this.teamFile.name);
    this.line(status.reason === undefined ? shown.text : `${shown.text}. ${status.reason}`);
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

  private noteReadOnly(): void {
    if (this.readOnlyNoted) return;
    this.readOnlyNoted = true;
    this.line(READ_ONLY_TEXT);
  }

  // The signer needs the member id this computer's key belongs to, which is only known once the roster has been read.
  private adoptSigner(): void {
    if (this.signing || this.identity === undefined) return;
    const state = this.transport.state();
    const memberId = state.deviceIndex.get(this.identity.fingerprint);
    const member = memberId === undefined ? undefined : state.members.get(memberId);
    if (memberId === undefined || member === undefined || member.removedEvent !== undefined) {
      // A roster has been read and this computer's identity is not in it: say so once, in the same words as a computer with no identity.
      if (state.deviceIndex.size > 0) this.noteReadOnly();
      return;
    }
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
      activeChanged: (active) => {
        // A context key that cannot be set must not stop the session: the failure is written to the channel.
        Promise.resolve(vscode.commands.executeCommand('setContext', TEAM_ACTIVE_CONTEXT, active)).catch((error: unknown) => {
          output.appendLine(`Team Mode could not update its menu state: ${describeError(error)}`);
        });
      },
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

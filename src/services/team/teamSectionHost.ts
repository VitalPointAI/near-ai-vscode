// The sidebar Team section host (G-61-5): feeds the Team section model (src/domain/team/teamSection.ts) to the NEAR AI chat sidebar and runs the
// Team Mode command mapped to a clicked button, so every team step is a button. The page is untrusted: only {type:'team-action', action} with an
// action from the fixed list runs anything, and it runs only the command TEAM_ACTION_COMMANDS maps that action to. The one action without a command,
// 'solo' (Just me for now, G-61-8), only keeps the choice through the Team Mode handle in VS Code's workspace state for this project.
// Solo activation stays cheap: this module statically imports only vscode types, Node built-ins and types. In a project without team.json a refresh
// costs one fs.stat and loads only the model modules; no timer, storage, output channel or git call. No user text lives here: every label and
// sentence comes from teamSectionText.ts through the model.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { SharedView, TeamActionId, TeamBoardSummary, TeamSectionInput } from '../../domain/team/teamSection';
import type { TeamFile } from '../../domain/team/types';
import type { SharedState } from '../../team/projectHome';
import type { TeamModeHandle } from './teamCommands';
import type { TeamSession } from './teamSession';

export interface TeamSectionHostDeps {
  team: TeamModeHandle;
  firstFolder(): string | undefined;
  executeCommand(command: string): Thenable<unknown>;
  /** Phase 62 supplies the board summary; absent, the section has no board line. */
  boardSummary?: () => TeamBoardSummary | undefined;
  /** Tests replace the online check; the default asks teamSetupShared (src/team/projectHome.ts). */
  checkShared?: (input: { projectRoot: string; teamFile: TeamFile; branch: string }) => Promise<SharedView>;
  /** Monotonic milliseconds for the shared check throttle; the default is performance.now. */
  now?: () => number;
  /** 61-33: how long a step may take before one line says it is taking longer (default 5 s). Tests make it small. */
  slowRefreshMs?: number;
  /** 61-33: how long one refresh may hold the chain before the next one runs without it (default 15 s). Never blocks a later refresh. */
  refreshLimitMs?: number;
  /** The e2e probe; the default is on only when NEAR_AI_E2E is exactly '1'. */
  testSeams?: boolean;
}

type SectionWebview = Pick<vscode.Webview, 'postMessage' | 'onDidReceiveMessage'>;

export interface TeamSectionHost extends vscode.Disposable {
  attach(webview: SectionWebview, onDidChangeVisibility?: vscode.Event<void>, visible?: () => boolean): vscode.Disposable;
  refresh(options?: { recheckShared?: boolean }): Promise<void>;
}

export type TeamSectionMessage = { type: 'team-action'; action: TeamActionId } | { type: 'team-e2e-facts'; id: number; facts: Record<string, unknown> };

const TEAM_FILE_PARTS = ['.planning', '.near-ai', 'team.json'];
// The online check (a network call) runs at most once a minute, on a monotonic clock, unless an action that changes what is online just finished.
const SHARED_RECHECK_MS = 60_000;
// 61-33: a step that is slow is worth one line, and a refresh that drags on must never hold the next one behind it (the 0.6.4 re-test could not
// tell a step that failed from one that never finished, because every failure was dropped and the chain waited forever).
const SLOW_REFRESH_MS = 5_000;
const REFRESH_LIMIT_MS = 15_000;
// The step names a channel line carries, written only through note() below: the details view may say "Team Mode", a screen a person reads may not.
const STEPS = {
  starting: 'starting Team Mode',
  reading: 'reading the team',
  request: 'checking for a request to join',
  shared: 'checking what is shared online',
  posting: 'sending the section to the sidebar'
} as const;
type Step = keyof typeof STEPS;
const STEP_STARTING: Step = 'starting';
const STEP_READING: Step = 'reading';
const STEP_REQUEST: Step = 'request';
const STEP_SHARED: Step = 'shared';
const STEP_POSTING: Step = 'posting';
const RECHECK_AFTER: ReadonlySet<TeamActionId> = new Set<TeamActionId>(['share', 'invite', 'link', 'join']);

// The action ids the page may post. A Record keyed by TeamActionId, so the compiler fails when the model's list and this one differ; the model module
// itself is loaded only by dynamic import (solo rule). Every id but 'solo' runs the command TEAM_ACTION_COMMANDS maps it to.
type CommandActionId = Exclude<TeamActionId, 'solo'>;
const KNOWN_ACTIONS: Readonly<Record<TeamActionId, true>> = Object.freeze({
  invite: true, join: true, ask: true, solo: true, share: true, members: true, board: true, link: true, check: true
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isKnownAction(value: unknown): value is TeamActionId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_ACTIONS, value);
}

/** The only page messages the host acts on. Anything else (unknown action, a command id, extra keys, a non-object) is undefined. */
export function parseTeamSectionMessage(value: unknown): TeamSectionMessage | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.type === 'team-action') {
    if (!hasExactKeys(value, ['type', 'action']) || !isKnownAction(value.action)) return undefined;
    return { type: 'team-action', action: value.action };
  }
  // The page's answer to the e2e probe (media/chat/team.js): what it drew. The host acts on it only under the extension-host tests.
  if (value.type === 'team-e2e-facts') {
    if (typeof value.id !== 'number' || !Number.isFinite(value.id)) return undefined;
    const facts: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) if (key !== 'type' && key !== 'id') facts[key] = entry;
    return { type: 'team-e2e-facts', id: value.id, facts };
  }
  return undefined;
}

/**
 * Extension-host tests only (NEAR_AI_E2E exactly '1', the board's IN-05 rule): `probe` asks the real page what the Team section shows, and may ask it
 * to click one of its own drawn buttons (which then posts team-action through the normal path). The page's answers land in `facts`. In production
 * `probe` is never set and the page's answers are dropped.
 */
export const teamSectionTap: { probe?: (request: { id: number; click?: string }) => Promise<void>; facts: Array<Record<string, unknown>> } = { facts: [] };

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// The only filesystem work in a project without a team: one stat. A file that is there but cannot be checked counts as there, so the section
// follows Team Mode's own start, which reports why.
async function teamFileExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.stat(path.join(projectRoot, ...TEAM_FILE_PARTS));
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

// teamSetupShared's answer as the section shows it: anything but shared means invites cannot work yet.
function sharedView(state: SharedState): SharedView {
  switch (state.kind) {
    case 'shared': return 'yes';
    case 'not-shared':
    case 'record-missing': return 'no';
    case 'not-reachable-by-teammates': return 'not-reachable-by-teammates';
    case 'unknown': return 'unknown';
  }
}

async function defaultCheckShared(input: { projectRoot: string; teamFile: TeamFile; branch: string }): Promise<SharedView> {
  const { teamSetupShared } = await import('../../team/projectHome');
  return sharedView(await teamSetupShared(input));
}

interface RefreshRun { recheck: boolean }

export function createTeamSectionHost(deps: TeamSectionHostDeps): TeamSectionHost {
  const now = deps.now ?? ((): number => performance.now());
  const checkShared = deps.checkShared ?? defaultCheckShared;
  const testSeams = deps.testSeams ?? process.env.NEAR_AI_E2E === '1';
  let webview: SectionWebview | undefined;
  let isVisible: () => boolean = () => true;
  let disposed = false;
  let busy = false;
  // The session followed for state changes; replaced when Team Mode restarts with a new one.
  let followed: TeamSession | undefined;
  let followedSubscriptions: Array<{ dispose(): void }> = [];
  // The last online check, per team: what it said and when (monotonic).
  let shared: { teamId: string; view: SharedView; at: number } | undefined;
  // Refreshes run one after another; a refresh asked for while one waits to start joins it (and a recheck asked by either is kept).
  let chain: Promise<void> = Promise.resolve();
  let queued: { run: RefreshRun; done: Promise<void> } | undefined;
  // 61-33: every run has a sequence number, and only a run newer than the last drawn model may post, so a step that settles late cannot draw an
  // older model over a newer one. The lines are written once per reason, so a refresh on every session change cannot flood the channel.
  let runSeq = 0;
  let drawnSeq = 0;
  const writtenReasons = new Set<string>();

  /** One line for the details view: the step it was on, and a reason with no secret and no address with credentials in it. */
  function note(reason: string): void {
    const flat = reason.replace(/\s+/g, ' ').trim();
    if (flat === '' || writtenReasons.has(flat)) return;
    writtenReasons.add(flat);
    try { deps.team.log(flat); } catch { /* a channel that could not be created must never fail a refresh */ }
  }

  /** One line for the details view, naming the step a refresh was on. */
  function stepNote(step: Step, rest: string): void {
    note(`The Team section was ${STEPS[step]}: ${rest}`);
  }

  function follow(session: TeamSession | undefined): void {
    if (session === followed) return;
    for (const subscription of followedSubscriptions) subscription.dispose();
    followedSubscriptions = [];
    followed = session;
    if (session === undefined) return;
    followedSubscriptions = [session.onStateChange(() => { void refresh(); }), session.onProfileChanged(() => { if (session === followed) void profileChanged(); })];
  }

  // 61-30, 61-32: Team Mode changed this project's profile (a team key a lead delivered, the own key pasted at Join, ...), so it is now the project's
  // profile. The page is asked once for a fresh profile status (chat.js posts refresh-status back and chat.ts answers with profile-status), so the
  // Connect screen gives way to the chat and the Team section without a reload; then the section's own model follows.
  async function profileChanged(): Promise<void> {
    const target = webview;
    if (disposed || target === undefined) return;
    try {
      await target.postMessage({ type: 'host-request', payload: { type: 'refresh-status' } });
    } catch {
      // A page that is gone gets the status when it is shown again.
    }
    await refresh();
  }

  const handleSubscription = deps.team.onDidChange(() => { void refresh(); });
  const profileSubscription = deps.team.onProfileChanged(() => { void profileChanged(); });

  // What is known of this person and this team, from the running session. Names pass through displayText; counts come from the log.
  async function teamInput(session: TeamSession, projectRoot: string, run: RefreshRun, step: (name: Step) => void): Promise<NonNullable<TeamSectionInput['team']>> {
    const [{ displayText }, { decideTeamAction }, { invitationStatus, memberAttention }] = await Promise.all([
      import('./teamStatusBar'), import('../../domain/team/permissions'), import('../../domain/team/invite')
    ]);
    const state = session.state();
    const myId = session.memberId();
    const me = myId === undefined ? undefined : state.members.get(myId);
    const status = session.boardStatus();
    const removed = session.isRemoved() || status.kind === 'removed' || me?.removedEvent !== undefined;
    const onTeam = me !== undefined && me.status !== 'invited';
    const canManage = !removed && myId !== undefined && onTeam && decideTeamAction(state, myId, { kind: 'member.invite' }).allowed;
    const linked = session.teamFile.near !== undefined;
    const awaitingKey = linked && onTeam && !removed && myId !== state.team.ownerId ? await keyStillComing(session, me) : false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    let pendingInvites = 0;
    let otherMembers = 0;
    for (const member of state.members.values()) {
      if (invitationStatus(member, nowSeconds) === 'pending') pendingInvites += 1;
      if (member.status !== 'invited' && member.removedEvent === undefined && member.id !== myId) otherMembers += 1;
    }
    const connection = status.kind === 'removed' ? 'live' : status.kind;
    const team: NonNullable<TeamSectionInput['team']> = {
      name: displayText(state.team.name || session.teamFile.name),
      ...(onTeam ? { myRole: me.role } : {}),
      ...(onTeam && me.pendingRole !== undefined ? { pendingRole: me.pendingRole } : {}),
      removed, canManage,
      waiting: canManage ? memberAttention(state, linked).length : 0,
      pendingInvites, otherMembers, linked, connection,
      ...(connection === 'offline' || connection === 'paused' ? { connectionText: displayText(status.text) } : {}),
      ...(awaitingKey ? { awaitingKey: true } : {})
    };
    if (canManage) {
      step(STEP_SHARED);
      const view = await sharedFor(session, projectRoot, run);
      if (view !== undefined) team.shared = view;
    }
    return team;
  }

  // A member of a team that pays through its organization waits for the team key a lead makes for them (D-21) until the key delivered to them is
  // the one installed here. A record that cannot be read counts as not installed, so the person can look again.
  async function keyStillComing(session: TeamSession, me: { nearApiKeyId?: string; nearKeyEvent?: string }): Promise<boolean> {
    if (me.nearApiKeyId === undefined || me.nearKeyEvent === undefined) return true;
    const { installedKeyId } = await import('../../team/teamKeyProfile');
    return (await installedKeyId(session.storageDir()).catch(() => undefined)) !== me.nearApiKeyId;
  }

  // The online check for an owner or a lead: the cached answer, refreshed when asked, after a share-related action, or when the sidebar is shown
  // and a minute has passed. Never while the sidebar is hidden unless asked.
  async function sharedFor(session: TeamSession, projectRoot: string, run: RefreshRun): Promise<SharedView | undefined> {
    const teamId = session.teamFile.teamId;
    const cached = shared !== undefined && shared.teamId === teamId ? shared : undefined;
    const due = run.recheck || (isVisible() && (cached === undefined || now() - cached.at >= SHARED_RECHECK_MS));
    if (!due) return cached?.view;
    const { readTeamFile } = await import('../../team/teamFile');
    // This computer's team.json is what teammates must get; the running session may be a moment behind it.
    const teamFile = (await readTeamFile(projectRoot).catch(() => undefined)) ?? session.teamFile;
    let view: SharedView;
    try {
      view = await checkShared({ projectRoot, teamFile, branch: session.state().team.policy.integrationBranch });
    } catch {
      // The check could not answer (offline, or git failed): shown as not known, and asked again after the next minute.
      view = 'unknown';
    }
    shared = { teamId, view, at: now() };
    return view;
  }

  async function input(run: RefreshRun, step: (name: Step) => void): Promise<TeamSectionInput | undefined> {
    const root = deps.firstFolder();
    if (root === undefined) return undefined;
    let session = deps.team.session();
    if (session === undefined) {
      // The only work in a project without a team: one stat.
      if (!(await teamFileExists(root))) {
        follow(undefined);
        // Just me for now is read from VS Code's workspace state only here, when the sidebar asks for a project without a team.
        return deps.team.justMe() ? { folderOpen: true, justMe: true } : { folderOpen: true };
      }
      // A team project whose session is still starting: wait for it, so the section does not show a passing state.
      await deps.team.ready;
      session = deps.team.session();
    }
    follow(session);
    if (session === undefined) return await withRequest(await teamFileOnly(root), step);
    const board = deps.boardSummary?.();
    return await withRequest({ folderOpen: true, team: await teamInput(session, root, run, step), ...(board === undefined ? {} : { board }) }, step);
  }

  // A person not on the project's team may have asked to join it (61-29): only then is the handle asked, which reads VS Code's secure storage.
  async function withRequest(built: TeamSectionInput, step: (name: Step) => void): Promise<TeamSectionInput> {
    const team = built.team;
    if (team === undefined || team.removed || team.myRole !== undefined || team.pendingRole !== undefined) return built;
    step(STEP_REQUEST);
    // A storage read that fails still means "no request waiting" for the section, but it used to vanish without a trace, and this is the step the
    // 0.6.4 re-test could not account for: one line says so, once per reason, and the section is still drawn (61-33).
    let pending = false;
    try {
      pending = await Promise.resolve(deps.team.joinRequestPending());
    } catch (error) {
      stepNote(STEP_REQUEST, await reasonOf(error));
    }
    return pending ? { ...built, joinRequestPending: true } : built;
  }

  // team.json is here but Team Mode did not start (the start failed): the team by name, unreachable, with Check the team first.
  async function teamFileOnly(root: string): Promise<TeamSectionInput> {
    const [{ readTeamFile }, { displayText }] = await Promise.all([import('../../team/teamFile'), import('./teamStatusBar')]);
    const file = await readTeamFile(root).catch(() => undefined);
    if (file === undefined) return { folderOpen: true };
    return {
      folderOpen: true,
      team: { name: displayText(file.name), removed: false, canManage: false, waiting: 0, pendingInvites: 0, otherMembers: 0, linked: file.near !== undefined, connection: 'offline' }
    };
  }

  async function run(options: RefreshRun, seq: number): Promise<void> {
    const target = webview;
    if (disposed || target === undefined) return;
    // Each step names itself before it is awaited, so a line written later says where the refresh was rather than only that it failed.
    const slowMs = deps.slowRefreshMs ?? SLOW_REFRESH_MS;
    let step: Step = STEP_STARTING;
    const slow = setTimeout(() => stepNote(step, `it is taking longer than ${Math.round(slowMs / 1000)} seconds to update.`), slowMs);
    try {
      step = STEP_READING;
      const built = await input(options, (next) => { step = next; });
      step = STEP_POSTING;
      const { teamSectionModel } = await import('../../domain/team/teamSection');
      const model = built === undefined ? undefined : teamSectionModel(built);
      if (disposed || webview !== target) return;
      if (seq <= drawnSeq) return;
      drawnSeq = seq;
      await target.postMessage({ type: 'team-state', model: model ?? null });
    } catch (error) {
      stepNote(step, await reasonOf(error));
    } finally {
      clearTimeout(slow);
    }
  }

  /**
   * A failure's own words for the details view, with no key and no address carrying one: the team redaction removes credentials from a URL and
   * every secret the team detects (an API key, a sign-in token, a private key), then safeReason flattens it to one bounded line (T-61-130).
   */
  async function reasonOf(error: unknown): Promise<string> {
    const message = error instanceof Error ? error.message : String(error);
    const [{ safeReason }, { SECRET_PATTERNS }] = await Promise.all([import('./teamStatusBar'), import('../../domain/team/secrets')]);
    let scrubbed = message;
    for (const pattern of SECRET_PATTERNS) scrubbed = scrubbed.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[removed]');
    const flat = safeReason(scrubbed);
    return flat === '' ? 'it stopped without saying why' : flat;
  }

  function refresh(options: { recheckShared?: boolean } = {}): Promise<void> {
    const recheck = options.recheckShared === true;
    if (queued !== undefined) {
      queued.run.recheck ||= recheck;
      return queued.done;
    }
    runSeq += 1;
    const seq = runSeq;
    const entry: { run: RefreshRun; done: Promise<void> } = { run: { recheck }, done: Promise.resolve() };
    // A refresh that fails (a module that cannot load, a record that cannot be read) writes its line and leaves the last model shown; the next
    // trigger tries again. A refresh that drags on stops holding the chain after refreshLimitMs, so a later refresh runs and draws without it; the
    // slow one still finishes and cleans up, and its own model is not drawn because a newer run already was (61-33).
    entry.done = chain.then(() => {
      if (queued === entry) queued = undefined;
      const limitMs = deps.refreshLimitMs ?? REFRESH_LIMIT_MS;
      let limit: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolve) => { limit = setTimeout(resolve, limitMs); });
      return Promise.race([run(entry.run, seq), bounded]).finally(() => { if (limit !== undefined) clearTimeout(limit); });
    }).catch(() => undefined);
    queued = entry;
    chain = entry.done;
    return entry.done;
  }

  async function act(action: TeamActionId): Promise<void> {
    if (action === 'solo') {
      await justMe();
      return;
    }
    await runCommand(action);
  }

  // Just me for now: the choice is kept through the handle (which tells the listeners, so the section refreshes). No command, file or event.
  async function justMe(): Promise<void> {
    try {
      // A choice that could not be kept leaves the section as it was; the next refresh shows what is true.
      await Promise.resolve(deps.team.setJustMe(true)).catch(() => undefined);
    } finally {
      busy = false;
    }
    await refresh();
  }

  async function runCommand(action: CommandActionId): Promise<void> {
    try {
      const { TEAM_ACTION_COMMANDS } = await import('../../domain/team/teamSection');
      // Every Team Mode command reports its own failure to the person (teamCommands' guarded); the section shows the state either way.
      await Promise.resolve(deps.executeCommand(TEAM_ACTION_COMMANDS[action])).catch(() => undefined);
    } finally {
      busy = false;
    }
    await refresh({ recheckShared: RECHECK_AFTER.has(action) });
  }

  // The probe posts to the attached page and never runs anything itself.
  async function probe(request: { id: number; click?: string }): Promise<void> {
    const target = webview;
    if (target === undefined || typeof request.id !== 'number' || !Number.isFinite(request.id)) return;
    // Any drawn action may be clicked, Just me for now included; the page clicks only what it drew.
    if (request.click !== undefined && !isKnownAction(request.click)) return;
    await target.postMessage({ type: 'team-e2e', id: request.id, ...(request.click === undefined ? {} : { click: request.click }) });
  }
  if (testSeams) teamSectionTap.probe = probe;

  async function receive(value: unknown): Promise<void> {
    const message = parseTeamSectionMessage(value);
    if (message === undefined) return;
    if (message.type === 'team-e2e-facts') {
      if (testSeams) teamSectionTap.facts.push({ id: message.id, ...message.facts });
      return;
    }
    // One team action at a time: a second click while a command still runs is ignored.
    if (busy) return;
    busy = true;
    await act(message.action);
  }

  return {
    attach(next: SectionWebview, onDidChangeVisibility?: vscode.Event<void>, visible?: () => boolean): vscode.Disposable {
      webview = next;
      isVisible = visible ?? ((): boolean => true);
      const subscriptions: Array<{ dispose(): void }> = [next.onDidReceiveMessage((value: unknown) => receive(value))];
      if (onDidChangeVisibility !== undefined) subscriptions.push(onDidChangeVisibility(() => { if (isVisible()) void refresh(); }));
      void refresh();
      return {
        dispose: (): void => {
          for (const subscription of subscriptions) subscription.dispose();
          if (webview === next) {
            webview = undefined;
            isVisible = () => true;
          }
        }
      };
    },
    refresh,
    dispose(): void {
      disposed = true;
      webview = undefined;
      handleSubscription.dispose();
      profileSubscription.dispose();
      follow(undefined);
      if (teamSectionTap.probe === probe) delete teamSectionTap.probe;
    }
  };
}

// The sidebar Team section host (G-61-5): feeds the Team section model (src/domain/team/teamSection.ts) to the NEAR AI chat sidebar and runs the
// Team Mode command mapped to a clicked button, so every team step is a button. The page is untrusted: only {type:'team-action', action} with an
// action from the fixed list runs anything, and it runs only the command TEAM_ACTION_COMMANDS maps that action to.
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
const RECHECK_AFTER: ReadonlySet<TeamActionId> = new Set<TeamActionId>(['share', 'invite', 'link', 'turn-on', 'join']);

// The action ids the page may post. A Record keyed by TeamActionId, so the compiler fails when the model's list and this one differ; the model module
// itself is loaded only by dynamic import (solo rule).
const KNOWN_ACTIONS: Readonly<Record<TeamActionId, true>> = Object.freeze({
  'turn-on': true, join: true, share: true, invite: true, members: true, board: true, link: true, check: true
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
  return undefined;
}

export const teamSectionTap: { probe?: (request: { id: number; click?: TeamActionId }) => Promise<void>; facts: Array<Record<string, unknown>> } = { facts: [] };

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
  let webview: SectionWebview | undefined;
  let isVisible: () => boolean = () => true;
  let disposed = false;
  let busy = false;
  // The session followed for state changes; replaced when Team Mode restarts with a new one.
  let followed: TeamSession | undefined;
  let followedSubscription: { dispose(): void } | undefined;
  // The last online check, per team: what it said and when (monotonic).
  let shared: { teamId: string; view: SharedView; at: number } | undefined;
  // Refreshes run one after another; a refresh asked for while one waits to start joins it (and a recheck asked by either is kept).
  let chain: Promise<void> = Promise.resolve();
  let queued: { run: RefreshRun; done: Promise<void> } | undefined;

  function follow(session: TeamSession | undefined): void {
    if (session === followed) return;
    followedSubscription?.dispose();
    followedSubscription = undefined;
    followed = session;
    if (session !== undefined) followedSubscription = session.onStateChange(() => { void refresh(); });
  }

  const handleSubscription = deps.team.onDidChange(() => { void refresh(); });

  // What is known of this person and this team, from the running session. Names pass through displayText; counts come from the log.
  async function teamInput(session: TeamSession, projectRoot: string, run: RefreshRun): Promise<NonNullable<TeamSectionInput['team']>> {
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
      ...(connection === 'offline' || connection === 'paused' ? { connectionText: displayText(status.text) } : {})
    };
    if (canManage) {
      const view = await sharedFor(session, projectRoot, run);
      if (view !== undefined) team.shared = view;
    }
    return team;
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

  async function input(run: RefreshRun): Promise<TeamSectionInput | undefined> {
    const root = deps.firstFolder();
    if (root === undefined) return undefined;
    let session = deps.team.session();
    if (session === undefined) {
      // The only work in a project without a team: one stat.
      if (!(await teamFileExists(root))) {
        follow(undefined);
        return { folderOpen: true };
      }
      // A team project whose session is still starting: wait for it, so the section does not show a passing state.
      await deps.team.ready;
      session = deps.team.session();
    }
    follow(session);
    if (session === undefined) return await teamFileOnly(root);
    const board = deps.boardSummary?.();
    return { folderOpen: true, team: await teamInput(session, root, run), ...(board === undefined ? {} : { board }) };
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

  async function run(options: RefreshRun): Promise<void> {
    const target = webview;
    if (disposed || target === undefined) return;
    const built = await input(options);
    const { teamSectionModel } = await import('../../domain/team/teamSection');
    const model = built === undefined ? undefined : teamSectionModel(built);
    if (disposed || webview !== target) return;
    await target.postMessage({ type: 'team-state', model: model ?? null });
  }

  function refresh(options: { recheckShared?: boolean } = {}): Promise<void> {
    const recheck = options.recheckShared === true;
    if (queued !== undefined) {
      queued.run.recheck ||= recheck;
      return queued.done;
    }
    const entry: { run: RefreshRun; done: Promise<void> } = { run: { recheck }, done: Promise.resolve() };
    // A refresh that fails (a module that cannot load, a record that cannot be read) leaves the last model shown; the next trigger tries again.
    entry.done = chain.then(() => {
      if (queued === entry) queued = undefined;
      return run(entry.run);
    }).catch(() => undefined);
    queued = entry;
    chain = entry.done;
    return entry.done;
  }

  async function act(action: TeamActionId): Promise<void> {
    try {
      const { TEAM_ACTION_COMMANDS } = await import('../../domain/team/teamSection');
      // Every Team Mode command reports its own failure to the person (teamCommands' guarded); the section shows the state either way.
      await Promise.resolve(deps.executeCommand(TEAM_ACTION_COMMANDS[action])).catch(() => undefined);
    } finally {
      busy = false;
    }
    await refresh({ recheckShared: RECHECK_AFTER.has(action) });
  }

  async function receive(value: unknown): Promise<void> {
    const message = parseTeamSectionMessage(value);
    if (message === undefined || message.type !== 'team-action') return;
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
      follow(undefined);
    }
  };
}

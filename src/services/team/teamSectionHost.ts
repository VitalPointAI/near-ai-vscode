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
import type { TeamModeHandle } from './teamCommands';

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

// The only filesystem work in a project without a team: one stat. A file it cannot check counts as no team; the Team Mode commands report why.
async function teamFileExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.stat(path.join(projectRoot, ...TEAM_FILE_PARTS));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    return false;
  }
}

export function createTeamSectionHost(deps: TeamSectionHostDeps): TeamSectionHost {
  let webview: SectionWebview | undefined;
  let disposed = false;
  let busy = false;
  // Refreshes run one after another; a refresh asked for while one waits to start joins it.
  let chain: Promise<void> = Promise.resolve();
  let queued: Promise<void> | undefined;

  async function input(): Promise<TeamSectionInput | undefined> {
    const root = deps.firstFolder();
    if (root === undefined) return undefined;
    await teamFileExists(root);
    return { folderOpen: true };
  }

  async function run(): Promise<void> {
    const target = webview;
    if (disposed || target === undefined) return;
    const built = await input();
    const { teamSectionModel } = await import('../../domain/team/teamSection');
    const model = built === undefined ? undefined : teamSectionModel(built);
    if (disposed || webview !== target) return;
    await target.postMessage({ type: 'team-state', model: model ?? null });
  }

  function refresh(): Promise<void> {
    if (queued !== undefined) return queued;
    const next = chain.then(() => { queued = undefined; return run(); }).catch(() => undefined);
    queued = next;
    chain = next;
    return next;
  }

  async function act(action: TeamActionId): Promise<void> {
    const { TEAM_ACTION_COMMANDS } = await import('../../domain/team/teamSection');
    try {
      await deps.executeCommand(TEAM_ACTION_COMMANDS[action]);
    } finally {
      busy = false;
    }
    await refresh();
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
    attach(next: SectionWebview): vscode.Disposable {
      webview = next;
      const listener = next.onDidReceiveMessage((value: unknown) => receive(value));
      void refresh();
      return {
        dispose: (): void => {
          listener.dispose();
          if (webview === next) webview = undefined;
        }
      };
    },
    refresh,
    dispose(): void {
      disposed = true;
      webview = undefined;
    }
  };
}

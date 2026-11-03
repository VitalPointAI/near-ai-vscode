// The sidebar Team section host (G-61-5). Declared only; the behaviour follows.
import type * as vscode from 'vscode';
import type { SharedView, TeamActionId, TeamBoardSummary } from '../../domain/team/teamSection';
import type { TeamFile } from '../../domain/team/types';
import type { TeamModeHandle } from './teamCommands';

export interface TeamSectionHostDeps {
  team: TeamModeHandle;
  firstFolder(): string | undefined;
  executeCommand(command: string): Thenable<unknown>;
  boardSummary?: () => TeamBoardSummary | undefined;
  checkShared?: (input: { projectRoot: string; teamFile: TeamFile; branch: string }) => Promise<SharedView>;
  now?: () => number;
  testSeams?: boolean;
}

type SectionWebview = Pick<vscode.Webview, 'postMessage' | 'onDidReceiveMessage'>;

export interface TeamSectionHost extends vscode.Disposable {
  attach(webview: SectionWebview, onDidChangeVisibility?: vscode.Event<void>, visible?: () => boolean): vscode.Disposable;
  refresh(options?: { recheckShared?: boolean }): Promise<void>;
}

export type TeamSectionMessage = { type: 'team-action'; action: TeamActionId } | { type: 'team-e2e-facts'; id: number; facts: Record<string, unknown> };

export function parseTeamSectionMessage(_value: unknown): TeamSectionMessage | undefined {
  return undefined;
}

export const teamSectionTap: { probe?: (request: { id: number; click?: TeamActionId }) => Promise<void>; facts: Array<Record<string, unknown>> } = { facts: [] };

export function createTeamSectionHost(_deps: TeamSectionHostDeps): TeamSectionHost {
  return {
    attach: () => ({ dispose: () => undefined }),
    refresh: async () => undefined,
    dispose: () => undefined
  };
}

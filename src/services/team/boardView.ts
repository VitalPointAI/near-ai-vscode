// Team Board host (skeleton for the tracer's RED step; the real host replaces every body below).
import type * as vscode from 'vscode';
import type { MoveKey } from '../../domain/team/board';
import type { TeamOutput, TeamSession } from './teamSession';

export const BOARD_VIEW_ID = 'nearAiTeamBoardView';
export const BOARD_PANEL_TYPE = 'nearAiTeamBoard';
export const BOARD_SCRIPTS = ['board.js', 'menu.js', 'drag.js', 'detail.js', 'form.js'] as const;
export const BOARD_STYLES = ['board.css'] as const;

export const boardTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void; request?: (payload: unknown) => Promise<void> } = {};

export type BoardMessage =
  | { type: 'ready' } | { type: 'visible'; value: boolean } | { type: 'move'; itemId: string; target: MoveKey } | { type: 'detail'; itemId: string }
  | { type: 'import-plans' } | { type: 'open-board' } | { type: 'retry' } | { type: 'show-details' }
  | { type: 'new-item'; draft: { kind: 'bug' | 'chore' | 'spike'; title: string; description?: string; scope: string[]; estimate?: number } }
  | { type: 'edit-item'; itemId: string; changes: { title?: string; description?: string; scope?: string[]; estimate?: number } };

export function parseBoardMessage(_value: unknown): BoardMessage | undefined {
  return undefined;
}

export function boardHtml(_webview: { cspSource: string; asWebviewUri(uri: vscode.Uri): vscode.Uri }, _media: vscode.Uri, _nonce: string, _surface: 'view' | 'panel'): string {
  return '';
}

export interface BoardSurface {
  kind: 'view' | 'panel';
  webview: { postMessage(message: unknown): Thenable<boolean>; onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void } };
  isVisible(): boolean;
  onDidChangeVisibility(listener: (visible: boolean) => void): { dispose(): void };
  onDidDispose(listener: () => void): { dispose(): void };
}

export interface BoardTimers { now(): number; set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface BoardDeps { session: () => TeamSession | undefined; output: TeamOutput; timers?: BoardTimers; throttleMs?: number; nowMs?: () => number }

export class BoardController {
  public constructor(_deps: BoardDeps) {}
  public attach(_surface: BoardSurface): { dispose(): void } {
    return { dispose: (): void => undefined };
  }
  public sessionChanged(): void {
    // Nothing yet.
  }
  public dispose(): void {
    // Nothing yet.
  }
}

export function registerTeamBoard(_context: vscode.ExtensionContext, deps: BoardDeps): { openPanel(): void; controller: BoardController } {
  return { openPanel: (): void => undefined, controller: new BoardController(deps) };
}

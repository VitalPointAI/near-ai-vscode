// The Team Board in VS Code (D-15, D-16, AD-22): a sidebar view and one editor panel serve the same page from media/board under a nonce CSP, and one
// controller turns log changes into model posts and page messages into permission-checked moves. It lives here, not in chat.ts. The page is
// untrusted (Pitfall 9): every message passes parseBoardMessage, a move is planned again on the freshest state inside the append, and the role,
// the permission and the state always come from the log, never from the page.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { MOVE_KEYS, availableMoves, buildBoardModel, buildCardDetail, planMove } from '../../domain/team/board';
import type { BoardModel, MoveKey } from '../../domain/team/board';
import { REFUSALS, SOMEONE, flattenName, staleRefusal } from '../../domain/team/boardText';
import { SecretLeakError } from '../../domain/team/secrets';
import { REASON_MAX } from '../../domain/team/validate';
import { BOARD_ITEM_ID_PATTERN, GSD_ITEM_ID_PATTERN } from '../../domain/team/work';
import { NoDeviceKeyError } from '../../team/eventLog';
import type { AppendResult } from '../../team/transport';
import { IMPORT_PLANS_COMMAND, OPEN_BOARD_COMMAND } from './teamCommands';
import type { TeamOutput, TeamSession } from './teamSession';
import { safeReason } from './teamStatusBar';

export const BOARD_VIEW_ID = 'nearAiTeamBoardView';
export const BOARD_PANEL_TYPE = 'nearAiTeamBoard';
// Load order of the client; plans 62-09 to 62-13 create the files.
export const BOARD_SCRIPTS = ['board.js', 'menu.js', 'drag.js', 'detail.js', 'form.js'] as const;
export const BOARD_STYLES = ['board.css'] as const;

const PANEL_TITLE = 'Team Board';
const THROTTLE_MS = 250;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const SCOPE_LINES_MAX = 64;
const SCOPE_LINE_MAX = 200;
const ESTIMATE_MAX = 1_000_000_000_000;
const PAUSED_TEXT = 'The board shows the last update and cannot be changed until team sync resumes.';
const NOT_READY_TEXT = 'The Team Board is not ready yet. Nothing was moved.';
const NOT_SAVED_TEXT = 'The change could not be saved. Nothing was moved.';
const LOG_DECLINED_TEXT = 'The team log did not accept this change. Nothing was moved.';
// Stands in for a reason while a move is planned only to learn whether it is allowed and which prompt follows (the real reason is asked afterwards).
const PROBE_REASON = 'placeholder';
const DONE_DETAIL = 'Use this when the work is finished and merged. The whole team will see it as done, and plans that wait for it can become ready. You can reopen it later.';
const MARK_DONE = 'Mark done';
const NOT_YET = 'Not yet';
const CANCEL_ITEM = 'Cancel this item';
const KEEP_ITEM = 'Keep item';
const REASON_PROMPTS = Object.freeze({
  block: { prompt: 'Why is this blocked? The team will see your answer.', placeHolder: 'For example: waiting for the API key' },
  cancel: { prompt: 'Why is this being cancelled? The team will see your answer.', placeHolder: 'For example: replaced by another plan' }
});
// Refusals that describe the card's state. When the page was offered the move and the log now says no, someone changed the card first.
const CARD_STATE_REFUSALS: ReadonlySet<string> = new Set([
  REFUSALS.alreadySettled, REFUSALS.doneBlocked, REFUSALS.doneNotNow, REFUSALS.alreadyHeld, REFUSALS.notHeld, REFUSALS.holdNotReady, REFUSALS.holdNotNow,
  REFUSALS.notTerminal, REFUSALS.alreadyBlocked, REFUSALS.notBlocked, REFUSALS.blockNotNow, REFUSALS.notNow
]);

/**
 * Set by the extension-host tests to observe both directions of the page protocol. `request` is set by the controller: it posts
 * { type: 'host-request', payload } to every visible surface, which the real board.js re-posts to the host (the chat sidebar's precedent).
 */
export const boardTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void; request?: (payload: unknown) => Promise<void> } = {};

// ---- what the page may say -------------------------------------------------------------------------------------------------------------------

export type BoardMessage =
  | { type: 'ready' } | { type: 'visible'; value: boolean } | { type: 'move'; itemId: string; target: MoveKey } | { type: 'detail'; itemId: string }
  | { type: 'import-plans' } | { type: 'open-board' } | { type: 'retry' } | { type: 'show-details' }
  | { type: 'new-item'; draft: { kind: 'bug' | 'chore' | 'spike'; title: string; description?: string; scope: string[]; estimate?: number } }
  | { type: 'edit-item'; itemId: string; changes: { title?: string; description?: string; scope?: string[]; estimate?: number } };

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Own enumerable keys only: a page cannot smuggle a field in through the prototype, and an own "__proto__" key is simply an unexpected key.
function onlyKeys(value: Plain, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isItemId(value: unknown): value is string {
  return typeof value === 'string' && (GSD_ITEM_ID_PATTERN.test(value) || BOARD_ITEM_ID_PATTERN.test(value));
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isScope(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= SCOPE_LINES_MAX && value.every((line) => isText(line, 1, SCOPE_LINE_MAX));
}

function isEstimate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= ESTIMATE_MAX;
}

const DRAFT_KINDS = ['bug', 'chore', 'spike'] as const;

function parseDraft(value: unknown): Extract<BoardMessage, { type: 'new-item' }>['draft'] | undefined {
  if (!isPlain(value) || !onlyKeys(value, ['kind', 'title', 'scope'], ['description', 'estimate'])) return undefined;
  const { kind, title, scope, description, estimate } = value;
  if (!DRAFT_KINDS.includes(kind as typeof DRAFT_KINDS[number]) || !isText(title, 1, TITLE_MAX) || !isScope(scope)) return undefined;
  if (description !== undefined && !isText(description, 0, DESCRIPTION_MAX)) return undefined;
  if (estimate !== undefined && !isEstimate(estimate)) return undefined;
  return {
    kind: kind as typeof DRAFT_KINDS[number], title, scope: [...scope],
    ...(description === undefined ? {} : { description: description as string }), ...(estimate === undefined ? {} : { estimate: estimate as number })
  };
}

function parseChanges(value: unknown): Extract<BoardMessage, { type: 'edit-item' }>['changes'] | undefined {
  if (!isPlain(value) || Object.keys(value).length === 0 || !onlyKeys(value, [], ['title', 'description', 'scope', 'estimate'])) return undefined;
  const { title, description, scope, estimate } = value;
  if (title !== undefined && !isText(title, 1, TITLE_MAX)) return undefined;
  if (description !== undefined && !isText(description, 0, DESCRIPTION_MAX)) return undefined;
  if (scope !== undefined && !isScope(scope)) return undefined;
  if (estimate !== undefined && !isEstimate(estimate)) return undefined;
  return {
    ...(title === undefined ? {} : { title: title as string }), ...(description === undefined ? {} : { description: description as string }),
    ...(scope === undefined ? {} : { scope: [...(scope as string[])] }), ...(estimate === undefined ? {} : { estimate: estimate as number })
  };
}

const BARE_TYPES = ['ready', 'import-plans', 'open-board', 'retry', 'show-details'] as const;

/** The one reader of page messages: exact keys, id patterns, move keys and length caps. Anything else is undefined and the host ignores it. */
export function parseBoardMessage(value: unknown): BoardMessage | undefined {
  if (!isPlain(value) || typeof value.type !== 'string') return undefined;
  const type = value.type;
  if ((BARE_TYPES as readonly string[]).includes(type)) return onlyKeys(value, ['type']) ? { type } as BoardMessage : undefined;
  switch (type) {
    case 'visible':
      return onlyKeys(value, ['type', 'value']) && typeof value.value === 'boolean' ? { type, value: value.value } : undefined;
    case 'move':
      return onlyKeys(value, ['type', 'itemId', 'target']) && isItemId(value.itemId) && (MOVE_KEYS as readonly unknown[]).includes(value.target)
        ? { type, itemId: value.itemId, target: value.target as MoveKey } : undefined;
    case 'detail':
      return onlyKeys(value, ['type', 'itemId']) && isItemId(value.itemId) ? { type, itemId: value.itemId } : undefined;
    case 'new-item': {
      const draft = onlyKeys(value, ['type', 'draft']) ? parseDraft(value.draft) : undefined;
      return draft === undefined ? undefined : { type, draft };
    }
    case 'edit-item': {
      const changes = onlyKeys(value, ['type', 'itemId', 'changes']) && isItemId(value.itemId) ? parseChanges(value.changes) : undefined;
      return changes === undefined ? undefined : { type, itemId: value.itemId as string, changes };
    }
    default:
      return undefined;
  }
}

// ---- the page --------------------------------------------------------------------------------------------------------------------------------

/**
 * The page: a nonce CSP with no inline script or style, no remote address and no font source (icons are inline SVG), one script tag per client
 * file in load order, and the root and live region the client draws into. `surface` tells the client whether it is the sidebar or the tab.
 */
export function boardHtml(webview: { cspSource: string; asWebviewUri(uri: vscode.Uri): vscode.Uri }, media: vscode.Uri, nonce: string, surface: 'view' | 'panel'): string {
  const asset = (file: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  const styles = BOARD_STYLES.map((file) => `<link rel="stylesheet" href="${asset(file)}">`).join('\n');
  const scripts = BOARD_SCRIPTS.map((file) => `<script nonce="${nonce}" src="${asset(file)}"></script>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
${styles}
<title>${PANEL_TITLE}</title></head><body data-surface="${surface}">
<div id="root"></div>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
${scripts}
</body></html>`;
}

// ---- surfaces and the controller -------------------------------------------------------------------------------------------------------------

export interface BoardSurface {
  kind: 'view' | 'panel';
  webview: { postMessage(message: unknown): Thenable<boolean>; onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void } };
  isVisible(): boolean;
  onDidChangeVisibility(listener: (visible: boolean) => void): { dispose(): void };
  onDidDispose(listener: () => void): { dispose(): void };
}

/** Test seam: the clock and timer of the post throttle. The extension passes nothing. */
export interface BoardTimers { now(): number; set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface BoardDeps { session: () => TeamSession | undefined; output: TeamOutput; timers?: BoardTimers; throttleMs?: number; nowMs?: () => number }

interface SurfaceState {
  surface: BoardSurface;
  visible: boolean;
  // The serialised state this surface was last sent, so an unchanged model is not sent again.
  lastJson: string | undefined;
  disposables: Array<{ dispose(): void }>;
}

const REAL_TIMERS: BoardTimers = {
  now: () => Date.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); }
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BoardController {
  private readonly deps: BoardDeps;
  private readonly timers: BoardTimers;
  private readonly throttleMs: number;
  private readonly surfaces = new Set<SurfaceState>();
  private subscribedTo: TeamSession | undefined;
  private subscription: { dispose(): void } | undefined;
  private timer: unknown;
  private lastPostAt: number | undefined;
  private combinedVisible: boolean | undefined;
  private disposed = false;

  public constructor(deps: BoardDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.throttleMs = deps.throttleMs ?? THROTTLE_MS;
    boardTap.request = (payload) => this.request(payload);
  }

  /** Starts serving a surface. It is sent nothing until its page says ready. */
  public attach(surface: BoardSurface): { dispose(): void } {
    const state: SurfaceState = { surface, visible: surface.isVisible(), lastJson: undefined, disposables: [] };
    this.surfaces.add(state);
    state.disposables.push(
      surface.webview.onDidReceiveMessage((raw) => this.received(state, raw)),
      surface.onDidChangeVisibility((visible) => { this.setVisible(state, visible); }),
      surface.onDidDispose(() => { this.detach(state); })
    );
    this.ensureSubscribed();
    this.applyVisibility();
    return { dispose: () => { this.detach(state); } };
  }

  /** The window's session was replaced: follow the new one and bring every visible page up to date. */
  public sessionChanged(): void {
    this.combinedVisible = undefined;
    this.ensureSubscribed();
    this.applyVisibility();
    for (const state of this.surfaces) state.lastJson = undefined;
    this.flush();
  }

  public dispose(): void {
    this.disposed = true;
    for (const state of [...this.surfaces]) this.detach(state);
    this.subscription?.dispose();
    this.subscription = undefined;
    this.subscribedTo = undefined;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    boardTap.request = undefined;
  }

  // ---- visibility ---------------------------------------------------------------------------------------------------------------------------

  private setVisible(state: SurfaceState, visible: boolean): void {
    state.visible = visible;
    this.applyVisibility();
    if (visible) this.flush(state);
  }

  // One combined value reaches the session: the board polls at the focused interval while any surface can be seen (Phase 60 D-19).
  private applyVisibility(): void {
    const any = [...this.surfaces].some((state) => state.visible);
    if (any === this.combinedVisible) return;
    this.combinedVisible = any;
    this.deps.session()?.setBoardVisible(any);
  }

  private detach(state: SurfaceState): void {
    if (!this.surfaces.delete(state)) return;
    for (const disposable of state.disposables.splice(0)) disposable.dispose();
    this.applyVisibility();
  }

  // ---- posting ------------------------------------------------------------------------------------------------------------------------------

  private ensureSubscribed(): void {
    const session = this.deps.session();
    if (session === this.subscribedTo) return;
    this.subscription?.dispose();
    this.subscribedTo = session;
    this.subscription = session?.onStateChange(() => { this.changed(); });
  }

  private changed(): void {
    if (this.disposed || this.timer !== undefined || ![...this.surfaces].some((state) => state.visible)) return;
    const wait = this.lastPostAt === undefined ? 0 : Math.max(0, this.throttleMs - (this.timers.now() - this.lastPostAt));
    if (wait === 0) {
      this.flush();
      return;
    }
    this.timer = this.timers.set(() => { this.timer = undefined; this.flush(); }, wait);
  }

  private model(session: TeamSession): BoardModel {
    const status = session.boardStatus();
    const open = status.kind === 'live' || status.kind === 'syncing';
    const readOnlyReason = status.kind === 'offline' ? REFUSALS.offline : status.kind === 'paused' ? PAUSED_TEXT : undefined;
    const viewerId = session.memberId();
    return buildBoardModel(session.state(), {
      nowMs: (this.deps.nowMs ?? Date.now)(), status, canWrite: session.canWrite() && open,
      ...(viewerId === undefined ? {} : { viewerId }), ...(readOnlyReason === undefined ? {} : { readOnlyReason })
    });
  }

  // Sends the current model to every visible surface whose last send differs (or to `only`, when it is visible and differs).
  private flush(only?: SurfaceState): void {
    const session = this.deps.session();
    if (session === undefined || this.disposed) return;
    const targets = [...this.surfaces].filter((state) => state.visible && (only === undefined || state === only));
    if (targets.length === 0) return;
    try {
      const message = { type: 'state', model: this.model(session) };
      const json = JSON.stringify(message);
      let posted = false;
      for (const state of targets) {
        if (state.lastJson === json) continue;
        state.lastJson = json;
        this.post(state, message);
        posted = true;
      }
      if (posted) this.lastPostAt = this.timers.now();
    } catch (error) {
      this.deps.output.appendLine(`Team Board: the board could not be updated: ${describe(error)}`);
    }
  }

  private post(state: SurfaceState, message: unknown): void {
    boardTap.toView?.(message);
    Promise.resolve(state.surface.webview.postMessage(message)).catch((error: unknown) => {
      this.deps.output.appendLine(`Team Board: a message could not be sent to the board: ${describe(error)}`);
    });
  }

  private async request(payload: unknown): Promise<void> {
    for (const state of this.surfaces) if (state.visible) this.post(state, { type: 'host-request', payload });
  }

  // ---- what the page says -------------------------------------------------------------------------------------------------------------------

  private async received(state: SurfaceState, raw: unknown): Promise<void> {
    boardTap.fromView?.(raw);
    const message = parseBoardMessage(raw);
    if (message === undefined) return;
    try {
      await this.handle(state, message);
    } catch (error) {
      this.deps.output.appendLine(`Team Board: a request from the board failed: ${describe(error)}`);
    }
  }

  private async handle(state: SurfaceState, message: BoardMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // A page that just loaded knows nothing: send the model whatever was sent before.
        state.visible = state.surface.isVisible();
        state.lastJson = undefined;
        this.ensureSubscribed();
        this.applyVisibility();
        this.flush(state);
        return;
      case 'visible':
        this.setVisible(state, message.value);
        return;
      case 'move':
        await this.move(state, message.itemId, message.target);
        return;
      case 'detail':
        this.detail(state, message.itemId);
        return;
      case 'import-plans':
        // From the page the import always takes the current milestone, so no pick is shown (D-09).
        await vscode.commands.executeCommand(IMPORT_PLANS_COMMAND, { milestone: 'current' });
        return;
      case 'open-board':
        await vscode.commands.executeCommand(OPEN_BOARD_COMMAND);
        return;
      case 'retry':
        this.deps.session()?.nudge();
        return;
      case 'show-details':
        this.deps.output.show(true);
        return;
      default:
        // new-item and edit-item are parsed here and handled by the form plan.
        return;
    }
  }

  // ---- moves --------------------------------------------------------------------------------------------------------------------------

  private refuse(state: SurfaceState, itemId: string, reason: string, target?: MoveKey): void {
    this.post(state, { type: 'refused', itemId, reason });
    // A dismissed prompt is not a failure. The channel gets the move and the sentence, never the card's text.
    if (reason !== '') this.deps.output.appendLine(`Team Board: ${target === undefined ? 'the request' : `the ${target} move`} was not done. ${reason}`);
  }

  private async askReason(target: 'block' | 'cancel', label: string): Promise<string | undefined> {
    const answer = await vscode.window.showInputBox({
      title: `${target === 'block' ? 'Block' : 'Cancel'} ${label}`, ...REASON_PROMPTS[target], ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 || value.trim().length > REASON_MAX ? REFUSALS.reasonInvalid : undefined)
    });
    return answer === undefined ? undefined : answer.trim();
  }

  private async confirmDone(label: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(`Mark ${label} as done?`, { modal: true, detail: DONE_DETAIL }, { title: MARK_DONE }, { title: NOT_YET, isCloseAffordance: true });
    return choice?.title === MARK_DONE;
  }

  private async confirmCancel(label: string, waiting: number): Promise<boolean> {
    const who = waiting === 1 ? '1 plan waits' : `${waiting} plans wait`;
    const stays = waiting === 1 ? 'It stays' : 'They stay';
    const dependency = waiting === 1 ? 'it depends' : 'they depend';
    const detail = `${who} for this card. ${stays} waiting until someone changes what ${dependency} on. You can reopen this card later.`;
    const choice = await vscode.window.showWarningMessage(`Cancel ${label}?`, { modal: true, detail }, { title: CANCEL_ITEM }, { title: KEEP_ITEM, isCloseAffordance: true });
    return choice?.title === CANCEL_ITEM;
  }

  // The words for a refusal the log gave on fresh state. A card-state refusal after the page was offered the move means someone got there first.
  private staleOrPlain(session: TeamSession, itemId: string, reason: string, offered: boolean): string {
    if (!offered || !CARD_STATE_REFUSALS.has(reason)) return reason;
    const author = session.itemHistory(itemId)[0]?.author;
    const name = author === undefined ? '' : session.state().members.get(author)?.name ?? '';
    return staleRefusal(flattenName(name) === '' ? SOMEONE : name);
  }

  // The words for an append that did not land (the log refused it, the remote could not be reached, or the write threw).
  private failureText(target: MoveKey, result: Extract<AppendResult, { ok: false }>): string {
    this.deps.output.appendLine(`Team Board: the ${target} move was not saved (${result.kind}): ${safeReason(result.reason)}`);
    switch (result.kind) {
      case 'offline':
      case 'paused':
        return REFUSALS.offline;
      case 'busy':
        return `${result.reason} Nothing was moved.`;
      case 'refused':
      case 'conflict':
        return LOG_DECLINED_TEXT;
      default:
        return NOT_SAVED_TEXT;
    }
  }

  private async move(state: SurfaceState, itemId: string, target: MoveKey): Promise<void> {
    const session = this.deps.session();
    if (session === undefined) {
      this.refuse(state, itemId, NOT_READY_TEXT, target);
      return;
    }
    const viewerId = session.memberId();
    // Plan once on what this window knows, to decide which prompt follows. A refusal is answered at once and nothing is asked.
    const known = session.state();
    const probe = planMove(known, viewerId, itemId, target, { reason: PROBE_REASON });
    if (!probe.ok) {
      this.refuse(state, itemId, probe.reason, target);
      return;
    }
    const offered = availableMoves(known, viewerId, itemId).find((move) => move.key === target);
    const label = buildCardDetail(known, itemId, { ...(viewerId === undefined ? {} : { viewerId }), nowMs: (this.deps.nowMs ?? Date.now)(), history: [] })?.displayId ?? itemId;

    let reason: string | undefined;
    if (target === 'block' || target === 'cancel') {
      reason = await this.askReason(target, label);
      if (reason === undefined) {
        this.refuse(state, itemId, '');
        return;
      }
    }
    if (offered?.prompt === 'confirm' && !(await this.confirmDone(label))) {
      this.refuse(state, itemId, '');
      return;
    }
    if (target === 'cancel' && (offered?.dependents ?? 0) > 0 && !(await this.confirmCancel(label, offered?.dependents ?? 0))) {
      this.refuse(state, itemId, '');
      return;
    }

    // The prompts took time, so plan again on what the log says now with the real reason: a bad reason is explained, a changed card is named.
    const input = reason === undefined ? {} : { reason };
    const again = planMove(session.state(), viewerId, itemId, target, input);
    if (!again.ok) {
      this.refuse(state, itemId, this.staleOrPlain(session, itemId, again.reason, true), target);
      if (CARD_STATE_REFUSALS.has(again.reason)) this.catchUp(state);
      return;
    }

    // The write plans a third time inside the append, on the state fetched just before it, so a page that was behind gets a fresh refusal.
    let builderRefusal: string | undefined;
    try {
      const result = await session.currentLog().append((fresh) => {
        const planned = planMove(fresh, viewerId, itemId, target, input);
        if (planned.ok) return [planned.intent];
        builderRefusal = planned.reason;
        return { conflict: planned.reason };
      });
      if (result.ok) return;
      if (builderRefusal !== undefined && result.reason === builderRefusal) {
        this.refuse(state, itemId, this.staleOrPlain(session, itemId, builderRefusal, true), target);
        this.catchUp(state);
        return;
      }
      this.refuse(state, itemId, this.failureText(target, result), target);
    } catch (error) {
      if (error instanceof SecretLeakError) this.refuse(state, itemId, REFUSALS.secret, target);
      else if (error instanceof NoDeviceKeyError) this.refuse(state, itemId, REFUSALS.noDeviceKey, target);
      else {
        this.deps.output.appendLine(`Team Board: the ${target} move failed: ${describe(error)}`);
        this.refuse(state, itemId, NOT_SAVED_TEXT, target);
      }
    }
  }

  // After a stale answer the page must show the latest, not wait for the throttle.
  private catchUp(state: SurfaceState): void {
    state.lastJson = undefined;
    this.flush(state);
  }

  private detail(state: SurfaceState, itemId: string): void {
    const session = this.deps.session();
    if (session === undefined) {
      this.refuse(state, itemId, NOT_READY_TEXT);
      return;
    }
    const viewerId = session.memberId();
    const detail = buildCardDetail(session.state(), itemId, { ...(viewerId === undefined ? {} : { viewerId }), nowMs: (this.deps.nowMs ?? Date.now)(), history: session.itemHistory(itemId) });
    if (detail === undefined) this.refuse(state, itemId, REFUSALS.missing);
    else this.post(state, { type: 'detail', ...detail });
  }
}

// ---- registration ----------------------------------------------------------------------------------------------------------------------------

function viewSurface(view: vscode.WebviewView): BoardSurface {
  return {
    kind: 'view', webview: view.webview, isVisible: () => view.visible,
    onDidChangeVisibility: (listener) => view.onDidChangeVisibility(() => { listener(view.visible); }),
    onDidDispose: (listener) => view.onDidDispose(listener)
  };
}

function panelSurface(panel: vscode.WebviewPanel): BoardSurface {
  return {
    kind: 'panel', webview: panel.webview, isVisible: () => panel.visible,
    onDidChangeVisibility: (listener) => panel.onDidChangeViewState((event) => { listener(event.webviewPanel.visible); }),
    onDidDispose: (listener) => panel.onDidDispose(listener)
  };
}

const nonceOf = (): string => randomBytes(16).toString('base64');

/**
 * Registers the sidebar view provider and returns the controller and the way to open the one editor panel. Called once per extension lifetime,
 * and only in a project that has a team (a solo project never loads this module).
 */
export function registerTeamBoard(context: vscode.ExtensionContext, deps: BoardDeps): { openPanel(): void; controller: BoardController } {
  const controller = new BoardController(deps);
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'board');
  let panel: vscode.WebviewPanel | undefined;

  // No retainContextWhenHidden: the page keeps its own state with getState and setState and asks for the model again when it is shown.
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view: vscode.WebviewView): void {
      view.webview.options = { enableScripts: true, localResourceRoots: [media] };
      view.webview.html = boardHtml(view.webview, media, nonceOf(), 'view');
      controller.attach(viewSurface(view));
    }
  };

  function openPanel(): void {
    if (panel !== undefined) {
      panel.reveal();
      return;
    }
    const created = vscode.window.createWebviewPanel(BOARD_PANEL_TYPE, PANEL_TITLE, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
    panel = created;
    created.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
    created.webview.html = boardHtml(created.webview, media, nonceOf(), 'panel');
    controller.attach(panelSurface(created));
    created.onDidDispose(() => { if (panel === created) panel = undefined; });
  }

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(BOARD_VIEW_ID, provider), controller);
  return { openPanel, controller };
}

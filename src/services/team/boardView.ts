// The Team Board in VS Code (D-15, D-16, AD-22): a sidebar view and one editor panel serve the same page from media/board under a nonce CSP, and one
// controller turns log changes into model posts and page messages into permission-checked moves. It lives here, not in chat.ts. The page is
// untrusted (Pitfall 9): every message passes parseBoardMessage, a move is planned again on the freshest state inside the append, and the role,
// the permission and the state always come from the log, never from the page.
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MOVE_KEYS, availableMoves, buildBoardModel, buildCardDetail, planMove } from '../../domain/team/board';
import type { BoardModel, MoveKey } from '../../domain/team/board';
import { REFUSALS, SOMEONE, flattenName, staleRefusal, stripFormatControls } from '../../domain/team/boardText';
import { decideTeamAction } from '../../domain/team/permissions';
import { SecretLeakError, findSecrets } from '../../domain/team/secrets';
import type { ItemChanges, ItemCreatedBody, TeamState } from '../../domain/team/types';
import { DESCRIPTION_MAX, MAX_ESTIMATE_TOKENS, MAX_SCOPE_ENTRIES, REASON_MAX, TITLE_MAX } from '../../domain/team/validate';
import { BOARD_ITEM_ID_PATTERN, GSD_ITEM_ID_PATTERN, isOwnDraft, isScopePattern } from '../../domain/team/work';
import { NoDeviceKeyError } from '../../team/eventLog';
import type { EventIntent } from '../../team/eventLog';
import { ulid } from '../../team/identity';
import type { AppendResult } from '../../team/transport';
import { IMPORT_PLANS_COMMAND, OPEN_BOARD_COMMAND, VERIFY_LOG_COMMAND } from './teamCommands';
import type { TeamOutput, TeamSession } from './teamSession';
import { safeReason } from './teamStatusBar';

export const BOARD_VIEW_ID = 'nearAiTeamBoardView';
export const BOARD_PANEL_TYPE = 'nearAiTeamBoard';
// Load order of the client; plans 62-09 to 62-13 create the files.
export const BOARD_SCRIPTS = ['board.js', 'menu.js', 'drag.js', 'detail.js', 'form.js'] as const;
export const BOARD_STYLES = ['board.css'] as const;

const PANEL_TITLE = 'Team Board';
const THROTTLE_MS = 250;
// The signed limits come from the validator, so the page parser can never drop what the log would accept (IN-03).
const SCOPE_LINES_MAX = MAX_SCOPE_ENTRIES;
const SCOPE_LINE_MAX = 200;
const ESTIMATE_MAX = MAX_ESTIMATE_TOKENS;
const PAUSED_TEXT = 'The board shows the last update and cannot be changed until team sync resumes.';
const NOT_READY_TEXT = 'The Team Board is not ready yet. Nothing was moved.';
const NOT_SAVED_TEXT = 'The change could not be saved. Nothing was moved.';
const LOG_DECLINED_TEXT = 'The shared team record did not accept this change. Nothing was moved.';
// A write that lost too many races with teammates; the raw reason goes to the output channel only (UI review warning 6).
const BUSY_SAVE_TEXT = 'The team was busy saving other changes. Try again in a moment.';
// The board form (D-14). Every sentence says what happened to the item and ends "Nothing was saved." The page validates with the same words first.
const NOTHING_SAVED = 'Nothing was saved.';
const FORM_TEXT = Object.freeze({
  notSaved: `The item could not be saved. ${NOTHING_SAVED}`,
  declined: `The shared team record did not accept this item. ${NOTHING_SAVED}`,
  titleRequired: `Enter a title. ${NOTHING_SAVED}`,
  titleLong: `The title must be 200 characters or fewer. ${NOTHING_SAVED}`,
  descriptionLong: `The description must be 2000 characters or fewer. ${NOTHING_SAVED}`,
  scope: `One of these lines is not a folder or file name in this project. Remove it and try again. ${NOTHING_SAVED}`,
  scopeMany: `List 64 parts of the project or fewer. ${NOTHING_SAVED}`,
  estimate: `Enter a whole number of tokens, 1 or more. ${NOTHING_SAVED}`,
  addDenied: `Only the owner, leads and developers can add items. ${NOTHING_SAVED}`,
  editDenied: `Only the owner, leads and developers can edit items. ${NOTHING_SAVED}`,
  editOwn: `You can edit only the items you added. ${NOTHING_SAVED}`,
  imported: `Items from the project plans change only when the plans change. ${NOTHING_SAVED}`,
  missing: `This item is no longer on the board. ${NOTHING_SAVED}`,
  settled: `A finished or cancelled item cannot get a new estimate. ${NOTHING_SAVED}`
});
// T-62-49: what the page may ask the host to do, and how often. One import, one retry and one item write at a time; an import or retry is not started
// again within the cool-down, and item writes draw on a small bucket that refills one every WRITE_REFILL_MS. Extras are refused in plain words.
const BUSY_WRITE_TEXT = `The board is still saving your last change. Try again in a moment. ${NOTHING_SAVED}`;
const BUSY_IMPORT_TEXT = 'An import of the plans is already running or just ran. Try again in a moment.';
const BUSY_RETRY_TEXT = 'The board is already checking for changes. Try again in a moment.';
const BUSY_CHECK_TEXT = 'The team is already being checked. Try again in a moment.';
// J-01: the folder picker of the New item form.
const FOLDER_PICK_TITLE = 'Choose the parts of the project this item covers';
const FOLDER_PICK_LABEL = 'Add to the item';
export interface BoardRequestLimits { coolDownMs: number; writeBurst: number; writeRefillMs: number }
const REQUEST_LIMITS: BoardRequestLimits = { coolDownMs: 2_000, writeBurst: 10, writeRefillMs: 500 };
// The refused reply for a new item has no card to name, so it carries this empty id.
const NO_ITEM_ID = '';
// Stands in for a reason while a move is planned only to learn whether it is allowed and which prompt follows (the real reason is asked afterwards).
const PROBE_REASON = 'placeholder';
const DONE_DETAIL = 'Use this when the work is finished and added to the project. The whole team will see it as done, and plans that wait for it can become ready. You can reopen it later.';
const MARK_DONE = 'Mark done';
const NOT_YET = 'Not yet';
const CANCEL_ITEM = 'Cancel this item';
const KEEP_ITEM = 'Keep item';
const REASON_PROMPTS = Object.freeze({
  block: { prompt: 'Why is this blocked? The team will see your answer.', placeHolder: 'For example: waiting for a teammate\'s answer, or for the API key' },
  cancel: { prompt: 'Why is this being cancelled? The team will see your answer.', placeHolder: 'For example: replaced by another plan' }
});
// Refusals that describe the card's state. When the page was offered the move and the log now says no, someone changed the card first.
const CARD_STATE_REFUSALS: ReadonlySet<string> = new Set([
  REFUSALS.alreadySettled, REFUSALS.doneBlocked, REFUSALS.doneNotNow, REFUSALS.alreadyHeld, REFUSALS.notHeld, REFUSALS.holdNotReady, REFUSALS.holdNotNow,
  REFUSALS.notTerminal, REFUSALS.alreadyBlocked, REFUSALS.notBlocked, REFUSALS.blockNotNow, REFUSALS.notNow
]);

/**
 * Set by the extension-host tests to observe both directions of the page protocol. `request` and `probe` are set by the controller only under
 * those tests (NEAR_AI_E2E=1, IN-05): `request` posts { type: 'host-request', payload } to every visible surface, which the real board.js re-posts to
 * the host (the chat sidebar's precedent) only on a page the host marked with data-e2e.
 */
export const boardTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void; request?: (payload: unknown) => Promise<void>; probe?: (probe: BoardProbe) => Promise<void> } = {};

/**
 * Extension-host tests only (NEAR_AI_E2E=1): asks the real page to report what it drew. The page acts (focus a card, press a key on the focused element)
 * and answers with an 'e2e-facts' message (card count and ids, focus, whether the Move menu is open, page errors caught). The host never reads that
 * answer; the tests see it through `fromView`. The page honours this only when the host marked it with data-e2e, which happens only in the tests.
 */
export interface BoardProbe { id: number; action: 'facts' | 'focus' | 'key'; itemId?: string; key?: string }

// ---- what the page may say -------------------------------------------------------------------------------------------------------------------

export type BoardMessage =
  | { type: 'ready' } | { type: 'visible'; value: boolean } | { type: 'move'; itemId: string; target: MoveKey } | { type: 'detail'; itemId: string }
  | { type: 'import-plans' } | { type: 'open-board' } | { type: 'retry' } | { type: 'show-details' } | { type: 'check-team' } | { type: 'choose-folders' }
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


// ---- what the host makes of a draft ----------------------------------------------------------------------------------------------------------

interface CleanFields { title?: string; description?: string; scope?: string[]; estimate?: number }

// The text of one field the way it is stored: line breaks of any kind become line feeds and other control characters become spaces.
function descriptionOf(raw: string): string {
  return stripFormatControls(raw).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/g, ' ').trim();
}

/**
 * The host re-validates what the page already checked (Pitfall 9): trims, drops blank file lines, applies the length caps, the file pattern rule and the
 * whole-number estimate, and refuses anything the secret detector flags before an intent exists. Fields the caller did not send stay out of the result.
 */
function cleanFields(input: CleanFields): { ok: true; fields: CleanFields } | { ok: false; reason: string } {
  if (findSecrets([input.title ?? '', input.description ?? '', ...(input.scope ?? [])]).length > 0) return { ok: false, reason: REFUSALS.secret };
  const fields: CleanFields = {};
  if (input.title !== undefined) {
    const title = flattenName(input.title, Number.MAX_SAFE_INTEGER);
    if (title === '') return { ok: false, reason: FORM_TEXT.titleRequired };
    if (title.length > TITLE_MAX) return { ok: false, reason: FORM_TEXT.titleLong };
    fields.title = title;
  }
  if (input.description !== undefined) {
    const description = descriptionOf(input.description);
    if (description.length > DESCRIPTION_MAX) return { ok: false, reason: FORM_TEXT.descriptionLong };
    fields.description = description;
  }
  if (input.scope !== undefined) {
    const scope = input.scope.map((line) => stripFormatControls(line).trim()).filter((line) => line !== '');
    if (scope.length > SCOPE_LINES_MAX) return { ok: false, reason: FORM_TEXT.scopeMany };
    if (!scope.every(isScopePattern)) return { ok: false, reason: FORM_TEXT.scope };
    fields.scope = scope;
  }
  if (input.estimate !== undefined) {
    if (!isEstimate(input.estimate)) return { ok: false, reason: FORM_TEXT.estimate };
    fields.estimate = input.estimate;
  }
  if (findSecrets([fields.title ?? '', fields.description ?? '', ...(fields.scope ?? [])]).length > 0) return { ok: false, reason: REFUSALS.secret };
  return { ok: true, fields };
}

function isBadEstimate(value: unknown): boolean {
  return typeof value === 'number' && !isEstimate(value);
}

function without(value: Plain, key: string): Plain {
  const rest: Plain = {};
  for (const own of Object.keys(value)) if (own !== key) rest[own] = value[own];
  return rest;
}

/**
 * A draft or an edit that the parser dropped only because its estimate is not a whole number of tokens from 1 up. The page validates this itself, so it
 * is a form that was not filled in properly rather than a hostile message, and the person gets the form's own sentence. Everything else the parser
 * drops stays unanswered. Returns the id the refusal is about ('' for a new item).
 */
function estimateRefusalTarget(raw: unknown): string | undefined {
  if (!isPlain(raw)) return undefined;
  if (raw.type === 'new-item') {
    const draft = onlyKeys(raw, ['type', 'draft']) && isPlain(raw.draft) ? raw.draft : undefined;
    return draft !== undefined && isBadEstimate(draft.estimate) && parseDraft(without(draft, 'estimate')) !== undefined ? NO_ITEM_ID : undefined;
  }
  if (raw.type === 'edit-item') {
    const changes = onlyKeys(raw, ['type', 'itemId', 'changes']) && isItemId(raw.itemId) && isPlain(raw.changes) ? raw.changes : undefined;
    if (changes === undefined || !isBadEstimate(changes.estimate)) return undefined;
    const rest = without(changes, 'estimate');
    return Object.keys(rest).length === 0 || parseChanges(rest) !== undefined ? raw.itemId as string : undefined;
  }
  return undefined;
}

const BARE_TYPES = ['ready', 'import-plans', 'open-board', 'retry', 'show-details', 'check-team', 'choose-folders'] as const;

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
export function boardHtml(webview: { cspSource: string; asWebviewUri(uri: vscode.Uri): vscode.Uri }, media: vscode.Uri, nonce: string, surface: 'view' | 'panel', testSeams = false): string {
  const asset = (file: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  const styles = BOARD_STYLES.map((file) => `<link rel="stylesheet" href="${asset(file)}">`).join('\n');
  const scripts = BOARD_SCRIPTS.map((file) => `<script nonce="${nonce}" src="${asset(file)}"></script>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
${styles}
<title>${PANEL_TITLE}</title></head><body data-surface="${surface}"${testSeams ? ' data-e2e="1"' : ''}>
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
export interface BoardDeps {
  session: () => TeamSession | undefined; output: TeamOutput; timers?: BoardTimers; throttleMs?: number; nowMs?: () => number;
  /** True only under the extension-host tests (NEAR_AI_E2E=1): the page probe is offered. registerTeamBoard reads the variable. */
  testSeams?: boolean;
  /** Test seam: the limits on page requests (T-62-49). The extension passes nothing. */
  requestLimits?: BoardRequestLimits;
}

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

// Every error text the board writes goes through the same redaction as the rest of Team Mode: no remote address with credentials, no control
// characters, bounded length (WR-03, T-62-48).
function describe(error: unknown): string {
  return safeReason(error instanceof Error ? error.message : String(error));
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
  // T-62-49: requests from the page that are running now, when an import or retry last started, and the item write bucket.
  private readonly running = new Set<'import' | 'retry' | 'check' | 'folders' | 'write'>();
  private readonly lastStarted = new Map<'import' | 'retry' | 'check', number>();
  private writeTokens: number | undefined;
  private writeTokensAt = 0;

  public constructor(deps: BoardDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.throttleMs = deps.throttleMs ?? THROTTLE_MS;
    if (deps.testSeams === true) {
      boardTap.request = (payload) => this.request(payload);
      boardTap.probe = (probe) => this.probe(probe);
    }
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
    boardTap.probe = undefined;
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

  private async probe(probe: BoardProbe): Promise<void> {
    for (const state of this.surfaces) if (state.visible) this.post(state, { type: 'e2e-probe', ...probe });
  }

  // ---- what the page says -------------------------------------------------------------------------------------------------------------------

  private async received(state: SurfaceState, raw: unknown): Promise<void> {
    boardTap.fromView?.(raw);
    const message = parseBoardMessage(raw);
    if (message === undefined) {
      const target = estimateRefusalTarget(raw);
      if (target !== undefined) this.refuse(state, target, FORM_TEXT.estimate);
      return;
    }
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
        await this.limited(state, 'import', BUSY_IMPORT_TEXT, () => vscode.commands.executeCommand(IMPORT_PLANS_COMMAND, { milestone: 'current' }));
        return;
      case 'open-board':
        await vscode.commands.executeCommand(OPEN_BOARD_COMMAND);
        return;
      case 'retry':
        await this.limited(state, 'retry', BUSY_RETRY_TEXT, () => { this.deps.session()?.nudge(); });
        return;
      case 'show-details':
        this.deps.output.show(true);
        return;
      case 'check-team':
        // The paused banner's "Check the team" (UI review warning 2): the same check the status bar click and the command run.
        await this.limited(state, 'check', BUSY_CHECK_TEXT, () => vscode.commands.executeCommand(VERIFY_LOG_COMMAND));
        return;
      case 'choose-folders':
        if (this.running.has('folders')) return;
        this.running.add('folders');
        try {
          await this.chooseFolders(state);
        } finally {
          this.running.delete('folders');
        }
        return;
      case 'new-item':
      case 'edit-item': {
        const askedAbout = message.type === 'new-item' ? NO_ITEM_ID : message.itemId;
        if (this.running.has('write')) {
          this.refuse(state, askedAbout, BUSY_WRITE_TEXT);
          return;
        }
        this.running.add('write');
        try {
          if (message.type === 'new-item') await this.newItem(state, message.draft);
          else await this.editItem(state, message.itemId, message.changes);
        } finally {
          this.running.delete('write');
        }
        return;
      }
    }
  }

  // ---- how often the page may ask (T-62-49) ---------------------------------------------------------------------------------------------------

  private limits(): BoardRequestLimits {
    return this.deps.requestLimits ?? REQUEST_LIMITS;
  }

  private nowMs(): number {
    return (this.deps.nowMs ?? Date.now)();
  }

  // Runs an import or a retry unless one is running or one started within the cool-down; otherwise the page gets a plain notice.
  private async limited(state: SurfaceState, kind: 'import' | 'retry' | 'check', busyText: string, run: () => unknown): Promise<void> {
    const now = this.nowMs();
    const last = this.lastStarted.get(kind);
    if (this.running.has(kind) || (last !== undefined && now >= last && now - last < this.limits().coolDownMs)) {
      this.post(state, { type: 'notice', text: busyText });
      return;
    }
    this.running.add(kind);
    this.lastStarted.set(kind, now);
    try {
      await run();
    } finally {
      this.running.delete(kind);
    }
  }

  // Takes one item write from the bucket, or says there is none left right now.
  private takeWriteToken(): boolean {
    const { writeBurst, writeRefillMs } = this.limits();
    const now = this.nowMs();
    if (this.writeTokens === undefined) {
      this.writeTokens = writeBurst;
      this.writeTokensAt = now;
    }
    const refilled = now > this.writeTokensAt ? Math.floor((now - this.writeTokensAt) / writeRefillMs) : 0;
    if (refilled > 0) {
      this.writeTokens = Math.min(writeBurst, this.writeTokens + refilled);
      this.writeTokensAt += refilled * writeRefillMs;
    }
    if (this.writeTokens < 1) return false;
    this.writeTokens -= 1;
    return true;
  }

  // ---- moves --------------------------------------------------------------------------------------------------------------------------

  private refuse(state: SurfaceState, itemId: string, reason: string, target?: MoveKey): void {
    this.post(state, { type: 'refused', itemId, reason });
    // A dismissed prompt is not a failure. The channel gets the move and the sentence, never the card's text.
    if (reason !== '') this.deps.output.appendLine(`Team Board: ${target === undefined ? 'the request' : `the ${target} move`} was not done. ${safeReason(reason)}`);
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
  // The card's newest change is named only when it arrived after the move was asked for (`seenEventId` was the newest then) and someone other
  // than the viewer made it; otherwise the sentence says Someone, which is never wrong (IN-07).
  private staleOrPlain(session: TeamSession, itemId: string, reason: string, offered: boolean, seenEventId: string | undefined, viewerId: string | undefined): string {
    if (!offered || !CARD_STATE_REFUSALS.has(reason)) return reason;
    const newest = session.itemHistory(itemId)[0];
    const author = newest === undefined || newest.eventId === seenEventId || newest.author === viewerId ? undefined : newest.author;
    const name = author === undefined ? '' : session.state().members.get(author)?.name ?? '';
    return staleRefusal(flattenName(name) === '' ? SOMEONE : name);
  }

  // The words for an append that did not land (the log refused it, the remote could not be reached, or the write threw).
  private failureText(what: string, result: Extract<AppendResult, { ok: false }>, words: { nothing: string; declined: string; notSaved: string } = { nothing: 'Nothing was moved.', declined: LOG_DECLINED_TEXT, notSaved: NOT_SAVED_TEXT }): string {
    this.deps.output.appendLine(`Team Board: ${what} was not saved (${result.kind}): ${safeReason(result.reason)}`);
    switch (result.kind) {
      case 'offline':
      case 'paused':
        return REFUSALS.offline;
      case 'busy':
        return `${BUSY_SAVE_TEXT} ${words.nothing}`;
      case 'refused':
      case 'conflict':
        return words.declined;
      default:
        return words.notSaved;
    }
  }

  private async move(state: SurfaceState, itemId: string, target: MoveKey): Promise<void> {
    const session = this.deps.session();
    if (session === undefined) {
      this.refuse(state, itemId, NOT_READY_TEXT, target);
      return;
    }
    const viewerId = session.memberId();
    // The card's newest change this window knew of when the page asked: a later one is what a stale refusal names (IN-07).
    const seenEventId = session.itemHistory(itemId)[0]?.eventId;
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
      this.refuse(state, itemId, this.staleOrPlain(session, itemId, again.reason, true, seenEventId, viewerId), target);
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
        this.refuse(state, itemId, this.staleOrPlain(session, itemId, builderRefusal, true, seenEventId, viewerId), target);
        this.catchUp(state);
        return;
      }
      this.refuse(state, itemId, this.failureText(`the ${target} move`, result), target);
    } catch (error) {
      if (error instanceof SecretLeakError) this.refuse(state, itemId, REFUSALS.secret, target);
      else if (error instanceof NoDeviceKeyError) this.refuse(state, itemId, REFUSALS.noDeviceKey, target);
      else {
        this.deps.output.appendLine(`Team Board: the ${target} move failed: ${describe(error)}`);
        this.refuse(state, itemId, NOT_SAVED_TEXT, target);
      }
    }
  }

  // ---- items made and edited on the board (D-14) --------------------------------------------------------------------------------------------

  // Why this window cannot write at all, in the board's own words, or undefined when it can.
  private writeBlock(session: TeamSession): string | undefined {
    if (session.canWrite()) return undefined;
    return this.model(session).viewer.readOnlyReason ?? FORM_TEXT.notSaved;
  }

  private static readonly FORM_WORDS = { nothing: NOTHING_SAVED, declined: FORM_TEXT.declined, notSaved: FORM_TEXT.notSaved };

  // The write of an item event batch. `plan` runs on the freshest state inside the append: a string is a plain refusal, an array is the batch to write.
  // The refusal is addressed to `askedAbout` (the item being edited, or '' for an item that does not exist yet) and success to `savedId`.
  private async writeItem(
    state: SurfaceState, session: TeamSession, ids: { savedId: string; askedAbout: string }, what: string, plan: (fresh: TeamState) => string | EventIntent[]
  ): Promise<void> {
    if (!this.takeWriteToken()) {
      this.refuse(state, ids.askedAbout, BUSY_WRITE_TEXT);
      return;
    }
    let builderRefusal: string | undefined;
    try {
      const result = await session.currentLog().append((fresh) => {
        const planned = plan(fresh);
        if (typeof planned !== 'string') return planned;
        builderRefusal = planned;
        return { conflict: planned };
      });
      if (result.ok) {
        this.post(state, { type: 'saved', itemId: ids.savedId });
        this.catchUp(state);
        return;
      }
      if (builderRefusal !== undefined && result.reason === builderRefusal) {
        this.refuse(state, ids.askedAbout, builderRefusal);
        this.catchUp(state);
        return;
      }
      this.refuse(state, ids.askedAbout, this.failureText(what, result, BoardController.FORM_WORDS));
    } catch (error) {
      if (error instanceof SecretLeakError) this.refuse(state, ids.askedAbout, REFUSALS.secret);
      else if (error instanceof NoDeviceKeyError) this.refuse(state, ids.askedAbout, REFUSALS.noDeviceKey);
      else {
        this.deps.output.appendLine(`Team Board: ${what} failed: ${describe(error)}`);
        this.refuse(state, ids.askedAbout, FORM_TEXT.notSaved);
      }
    }
  }

  private async newItem(state: SurfaceState, draft: Extract<BoardMessage, { type: 'new-item' }>['draft']): Promise<void> {
    const session = this.deps.session();
    if (session === undefined) {
      this.refuse(state, NO_ITEM_ID, NOT_READY_TEXT);
      return;
    }
    const blocked = this.writeBlock(session);
    if (blocked !== undefined) {
      this.refuse(state, NO_ITEM_ID, blocked);
      return;
    }
    const cleaned = cleanFields({ title: draft.title, scope: draft.scope, ...(draft.description === undefined ? {} : { description: draft.description }), ...(draft.estimate === undefined ? {} : { estimate: draft.estimate }) });
    if (!cleaned.ok) {
      this.refuse(state, NO_ITEM_ID, cleaned.reason);
      return;
    }
    const { fields } = cleaned;
    const viewerId = session.memberId();
    if (viewerId === undefined) {
      this.refuse(state, NO_ITEM_ID, REFUSALS.noDeviceKey);
      return;
    }
    // One item.created carries everything, the estimate included: a same-batch create then estimate by a developer would be judged on the state before the batch.
    const id = `item:${ulid()}`;
    const body: ItemCreatedBody = {
      id, kind: draft.kind, title: fields.title as string, scope: fields.scope ?? [], requirements: [], mustHaves: [],
      ...(fields.description === undefined || fields.description === '' ? {} : { description: fields.description }),
      ...(fields.estimate === undefined ? {} : { estimate: { tokens: fields.estimate } })
    };
    await this.writeItem(state, session, { savedId: id, askedAbout: NO_ITEM_ID }, 'a new item', (fresh) => (
      decideTeamAction(fresh, viewerId, { kind: 'item.create', ownDraft: true }).allowed ? [{ type: 'item.created', body }] : FORM_TEXT.addDenied
    ));
  }

  // Why this person may not edit this item, or undefined when they may. Imported items change only with the plan files (D-06).
  private editProblem(fresh: TeamState, viewerId: string, itemId: string, estimating: boolean): string | undefined {
    const item = fresh.items.get(itemId);
    if (item === undefined) return FORM_TEXT.missing;
    if (item.origin !== 'board') return FORM_TEXT.imported;
    const ownDraft = isOwnDraft(fresh, itemId, viewerId);
    const allowed = decideTeamAction(fresh, viewerId, { kind: 'item.edit', ownDraft }).allowed
      && (!estimating || decideTeamAction(fresh, viewerId, { kind: 'item.estimate', ownDraft }).allowed);
    if (!allowed) return fresh.members.get(viewerId)?.role === 'developer' ? FORM_TEXT.editOwn : FORM_TEXT.editDenied;
    return estimating && (item.state === 'done' || item.state === 'cancelled') ? FORM_TEXT.settled : undefined;
  }

  private async editItem(state: SurfaceState, itemId: string, changes: Extract<BoardMessage, { type: 'edit-item' }>['changes']): Promise<void> {
    const session = this.deps.session();
    if (session === undefined) {
      this.refuse(state, itemId, NOT_READY_TEXT);
      return;
    }
    const blocked = this.writeBlock(session);
    if (blocked !== undefined) {
      this.refuse(state, itemId, blocked);
      return;
    }
    const cleaned = cleanFields(changes);
    if (!cleaned.ok) {
      this.refuse(state, itemId, cleaned.reason);
      return;
    }
    const { fields } = cleaned;
    const viewerId = session.memberId();
    if (viewerId === undefined) {
      this.refuse(state, itemId, REFUSALS.noDeviceKey);
      return;
    }
    const content: ItemChanges = {
      ...(fields.title === undefined ? {} : { title: fields.title }), ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.scope === undefined ? {} : { scope: fields.scope })
    };
    await this.writeItem(state, session, { savedId: itemId, askedAbout: itemId }, 'an item change', (fresh) => {
      const problem = this.editProblem(fresh, viewerId, itemId, fields.estimate !== undefined);
      if (problem !== undefined) return problem;
      const intents: EventIntent[] = [];
      if (Object.keys(content).length > 0) intents.push({ type: 'item.updated', body: { id: itemId, changes: content } });
      if (fields.estimate !== undefined) intents.push({ type: 'item.estimated', body: { id: itemId, estimate: { tokens: fields.estimate } } });
      return intents;
    });
  }

  // J-01: the native folder picker, opened in the project. Only folders and files inside the project come back, as relative paths with forward slashes
  // that pass the same scope rule the host applies on save; the project folder itself and anything outside it are left out. Nothing is written here.
  private async chooseFolders(state: SurfaceState): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root === undefined) {
      this.post(state, { type: 'folders-chosen', paths: [] });
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: true, canSelectMany: true, defaultUri: root, title: FOLDER_PICK_TITLE, openLabel: FOLDER_PICK_LABEL
    });
    if (picked === undefined) return;
    const paths: string[] = [];
    for (const uri of picked) {
      const relative = path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
      if (relative === '' || path.isAbsolute(relative) || !isScopePattern(relative) || paths.includes(relative)) continue;
      paths.push(relative);
      if (paths.length >= SCOPE_LINES_MAX) break;
    }
    this.post(state, { type: 'folders-chosen', paths });
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
  const testSeams = deps.testSeams ?? process.env.NEAR_AI_E2E === '1';
  const controller = new BoardController({ ...deps, testSeams });
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'board');
  let panel: vscode.WebviewPanel | undefined;

  // No retainContextWhenHidden: the page keeps its own state with getState and setState and asks for the model again when it is shown.
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view: vscode.WebviewView): void {
      view.webview.options = { enableScripts: true, localResourceRoots: [media] };
      view.webview.html = boardHtml(view.webview, media, nonceOf(), 'view', testSeams);
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
    created.webview.html = boardHtml(created.webview, media, nonceOf(), 'panel', testSeams);
    controller.attach(panelSurface(created));
    created.onDidDispose(() => { if (panel === created) panel = undefined; });
  }

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(BOARD_VIEW_ID, provider), controller);
  return { openPanel, controller };
}

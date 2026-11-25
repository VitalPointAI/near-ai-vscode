/**
 * The two pages of one person action's step-up (33.1-17, 33.1 D-09), as pure functions the backend routes call:
 *
 * - the summary page, GET ACTION_STEP_UP_PATH/<nonce>: what the person is about to confirm, rendered by the backend from the summary the calling
 *   backend service stored. One fixed action line for the kind (no payload text in it), then every payload value as a labelled, quoted field.
 *   Nothing on the page comes from the request but the nonce, which only looks the action up. Its Continue link is 46-02's stepUpUrl with the
 *   return path ACTION_STEP_UP_PATH/<nonce>/return.
 * - the return page, GET ACTION_STEP_UP_PATH/<nonce>/return: the only place a token is bound. The forwarded token on this very request must be the
 *   one the person check (SessionIdentity.observe, run by the early middleware on every request) has just accepted; its acr, auth_time and sub
 *   then go to bindStepUp with this nonce. Any other request binds nothing.
 *
 * Everything is escaped. Nothing is logged.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { ACTION_STEP_UP_PATH, isActionNonce, stepUpUrl } from '../../common/session-identity.js';
import type { ActiveSession } from '../session-identity.js';
import { ACTION_LINES, ACTION_STEP_UP_TEXT, type ActionField, type PendingActions } from './person-signer.js';

export interface PageAnswer {
  readonly status: number;
  readonly html: string;
}

/** Headers for both pages: never cached, never framed, no script, no referrer. */
export const STEP_UP_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A date written by the backend ("1 December 2026", UTC); a value that is not a date is shown as it is. */
export function formatDate(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  const date = new Date(time);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(title)}</title></head><body><main>${body}</main></body></html>`;
}

const message = (status: number, text: string): PageAnswer => ({
  status,
  html: page(ACTION_STEP_UP_TEXT.title, `<p>${escapeHtml(text)}</p><p><a href="/">${escapeHtml(ACTION_STEP_UP_TEXT.back)}</a></p>`),
});

const field = (item: ActionField): string =>
  `<dt>${escapeHtml(item.label)}</dt><dd>&ldquo;${escapeHtml(item.date === true ? formatDate(item.value) : item.value)}&rdquo;</dd>`;

/** The summary page of a pending action, or a plain refusal when there is none or no step-up is set up. */
export function actionSummaryPage(actions: Pick<PendingActions, 'summaryOf'>, nonce: unknown, acr: string | undefined): PageAnswer {
  const summary = isActionNonce(nonce) ? actions.summaryOf(nonce) : undefined;
  if (summary === undefined) return message(404, ACTION_STEP_UP_TEXT.notFound);
  if (acr === undefined) return message(503, ACTION_STEP_UP_TEXT.notSetUp);
  const line = Object.prototype.hasOwnProperty.call(ACTION_LINES, summary.kind) ? ACTION_LINES[summary.kind] : ACTION_STEP_UP_TEXT.defaultLine;
  const next = stepUpUrl(`${ACTION_STEP_UP_PATH}/${nonce as string}/return`, acr);
  const body = `<h1>${escapeHtml(ACTION_STEP_UP_TEXT.title)}</h1><p>${escapeHtml(ACTION_STEP_UP_TEXT.intro)}</p>`
    + `<p id="action">${escapeHtml(line as string)}</p><dl>${summary.fields.map(field).join('')}</dl>`
    + `<p><a id="continue" href="${escapeHtml(next)}">${escapeHtml(ACTION_STEP_UP_TEXT.continue)}</a></p>`;
  return { status: 200, html: page(ACTION_STEP_UP_TEXT.title, body) };
}

function forwardedToken(headers: IncomingHttpHeaders): string | undefined {
  const value = headers['x-forwarded-access-token'];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}

/**
 * The return of one step-up. Binds only the token on this request, and only when the session's person check accepted that very token; the
 * registry then checks the nonce, acr, auth_time and sub.
 */
export function actionReturnPage(
  actions: Pick<PendingActions, 'bindStepUp'>, session: () => ActiveSession | undefined, headers: IncomingHttpHeaders, nonce: unknown,
): PageAnswer {
  if (!isActionNonce(nonce)) return message(404, ACTION_STEP_UP_TEXT.notFound);
  const token = forwardedToken(headers);
  const current = session();
  if (token === undefined || current === undefined || current.forwardedToken !== token) return message(403, ACTION_STEP_UP_TEXT.notBound);
  const bound = actions.bindStepUp(nonce, { acr: current.acr, authTime: current.authTime, sub: current.sub, activeSub: current.activeSub });
  return bound ? message(200, ACTION_STEP_UP_TEXT.confirmed) : message(403, ACTION_STEP_UP_TEXT.notBound);
}

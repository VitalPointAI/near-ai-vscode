// Show full attestation on a trust badge (CLAS-08): the details of one answer's check as one JSON object, shown in a read-only editor tab served from memory
// on the near-ai-attestation scheme. Nothing is written to the workspace, to disk or to a decision record, and the tab is never dirty, so closing it never
// asks to save.
import type { ConnectionBindingFact } from '../domain/gate/routing';
import { TRUST_BADGE_TEXT, type TrustBadge } from '../domain/gate/trustBadge';
import type { AnswerCheckResult } from '../gate/sessionMark';

/** Said when the answer's details are no longer kept: the same 20 answers whose badge facts the chat keeps. */
export const TRUST_DETAILS_NOT_KEPT_TEXT = 'The full attestation is kept only for the last 20 answers of this window, and this answer is no longer one of them.';

/** What one answer's details are built from: what the session kept for its badge. */
export interface TrustDetailsInput {
  readonly runId: string;
  readonly model: string;
  /** When the answer finished (ms since the epoch), which the tab's title shows. */
  readonly answeredAt?: number;
  readonly badge: TrustBadge | undefined;
  readonly result: AnswerCheckResult | undefined;
  readonly connection: ConnectionBindingFact | undefined;
  /** The request went over a connection held to that fact's key. */
  readonly connectionPinned: boolean;
}

const SIGNERS: Readonly<Record<'model' | 'gateway', string>> = Object.freeze({
  model: 'the model\'s own enclave',
  gateway: 'NEAR AI Cloud\'s gateway enclave'
});

/** The details as one plain object: the badge, the signature and who holds its key, every check, what is not checked, the connection, the report. */
export function trustDetailsOf(input: TrustDetailsInput): Record<string, unknown> {
  const result = input.result;
  const connection = input.connection;
  return {
    answer: { runId: input.runId, model: input.model, answeredAt: typeof input.answeredAt === 'number' && Number.isFinite(input.answeredAt) ? new Date(input.answeredAt).toISOString() : null },
    badge: input.badge === undefined ? null : { state: input.badge.state, title: input.badge.title, explanation: input.badge.explanation, reasons: [...input.badge.reasons] },
    check: result === undefined ? { outcome: 'not checked' } : {
      outcome: result.outcome,
      summary: result.summary,
      signedText: result.signed?.text ?? null,
      signature: result.signed?.signature ?? null,
      signingAddress: result.signingAddress ?? null,
      keyHeldBy: result.signer === undefined ? null : SIGNERS[result.signer],
      checks: { ...result.checks }
    },
    notCheckedInEditor: [...(result?.notChecked ?? [])],
    connection: connection === undefined ? null : {
      state: connection.state,
      host: connection.host,
      fingerprint: connection.fingerprint ?? null,
      checkedAt: typeof connection.checkedAt === 'number' && Number.isFinite(connection.checkedAt) ? new Date(connection.checkedAt).toISOString() : null,
      requestHeldToThisKey: input.connectionPinned
    },
    attestationReport: result?.report ?? null
  };
}

/** The scheme the read-only attestation tabs are served on: from memory only, never a file. */
export const ATTESTATION_SCHEME = 'near-ai-attestation';
/** How many answers' details the tabs keep: the same 20 answers whose badge facts the chat keeps. */
const ATTESTATION_DOCUMENTS_KEPT = 20;

interface UriLike { toString(): string }
interface DisposableLike { dispose(): unknown }

/** The editor calls Show full attestation needs, so a test can give its own. */
export interface TrustDetailsEditor {
  readonly Uri: { from(components: { scheme: string; path: string; query?: string }): UriLike };
  readonly EventEmitter: new () => { readonly event: unknown; fire(value: UriLike): void; dispose(): void };
  readonly workspace: {
    registerTextDocumentContentProvider(scheme: string, provider: { onDidChange?: never; provideTextDocumentContent(uri: never): string }): DisposableLike;
    openTextDocument(uri: never): PromiseLike<unknown>;
  };
  readonly languages: { setTextDocumentLanguage(document: never, languageId: string): PromiseLike<unknown> };
  readonly window: { showTextDocument(document: never, options?: { preview?: boolean; preserveFocus?: boolean; viewColumn?: number }): PromiseLike<unknown> };
  readonly ViewColumn: { readonly Active: number };
}

/** HH:MM in the person's own time zone, or undefined when the time is missing. */
function clockTime(iso: unknown): string | undefined {
  if (typeof iso !== 'string') return undefined;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return undefined;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * The tab's title: "Attestation: answer at 14:32, <model>". A model id such as "org/model" is shown by its last part, because a slash would cut the title
 * (the full id is in the document). Control characters are dropped and the title is kept short.
 */
export function attestationTitle(details: Record<string, unknown>): string {
  const answer = (details.answer ?? {}) as { runId?: unknown; model?: unknown; answeredAt?: unknown };
  const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const model = clean(typeof answer.model === 'string' ? answer.model.split(/[\\/]/).filter(Boolean).at(-1) ?? '' : '').slice(0, 80);
  const time = clockTime(answer.answeredAt);
  const when = time === undefined ? 'Attestation: answer' : `Attestation: answer at ${time}`;
  return model ? `${when}, ${model}` : when;
}

/** The read-only attestation tabs: the newest ATTESTATION_DOCUMENTS_KEPT answers' JSON, kept in memory and served on ATTESTATION_SCHEME. */
export interface AttestationView extends DisposableLike {
  /** Opens one answer's details as a read-only JSON tab, in a preview tab of the editor area beside the chat. */
  open(details: Record<string, unknown>): Promise<void>;
}

const views = new WeakMap<TrustDetailsEditor, AttestationView>();

/**
 * The attestation view for this editor, registered once: the provider is in place before any tab asks for it, so a tab VS Code restores after a reload
 * reads the "no longer kept" note rather than an error. `keep` is given the registration so the extension disposes of it.
 */
export function attestationView(editor: TrustDetailsEditor, keep: (disposable: DisposableLike) => void = () => undefined): AttestationView {
  const known = views.get(editor);
  if (known !== undefined) return known;
  const texts = new Map<string, string>();
  const changed = new editor.EventEmitter();
  const notKept = `${JSON.stringify({ note: TRUST_DETAILS_NOT_KEPT_TEXT }, null, 2)}\n`;
  const registration = editor.workspace.registerTextDocumentContentProvider(ATTESTATION_SCHEME, {
    onDidChange: changed.event as never,
    provideTextDocumentContent: (uri: UriLike) => texts.get(uri.toString()) ?? notKept
  });
  const view: AttestationView = {
    open: async (details) => {
      const answer = (details.answer ?? {}) as { runId?: unknown };
      const runId = typeof answer.runId === 'string' ? answer.runId : '';
      const uri = editor.Uri.from({ scheme: ATTESTATION_SCHEME, path: `/${attestationTitle(details)}`, query: `run=${encodeURIComponent(runId)}` });
      const key = uri.toString();
      const text = `${JSON.stringify(details, null, 2)}\n`;
      const before = texts.get(key);
      texts.delete(key);
      texts.set(key, text);
      for (const old of [...texts.keys()].slice(0, -ATTESTATION_DOCUMENTS_KEPT)) texts.delete(old);
      // An open tab of this answer shows the newest details (after Check again) rather than what it showed first.
      if (before !== undefined && before !== text) changed.fire(uri);
      const opened = await editor.workspace.openTextDocument(uri as never);
      const document = await editor.languages.setTextDocumentLanguage(opened as never, 'json');
      // The chat is a side-bar view, so the editor area is already beside it: the active group, as a preview tab, rather than splitting the person's file.
      await editor.window.showTextDocument(document as never, { preview: true, preserveFocus: false, viewColumn: editor.ViewColumn.Active });
    },
    dispose: () => {
      views.delete(editor);
      texts.clear();
      changed.dispose();
      registration.dispose();
    }
  };
  views.set(editor, view);
  keep(view);
  return view;
}

/** Opens the details as a read-only JSON tab (see attestationView). Nothing is saved anywhere and the tab has no unsaved state. */
export async function openTrustDetails(editor: TrustDetailsEditor, details: Record<string, unknown>, keep?: (disposable: DisposableLike) => void): Promise<void> {
  await attestationView(editor, keep).open(details);
}

/** What Check again needs of a chat: a fresh check that gives the run's badge, and the badge with one more reason when the check could not run. */
export interface BadgeChecker {
  checkAgain(runId: string): Promise<TrustBadge | undefined>;
  badgeWithNotice(runId: string, reason: string): TrustBadge | undefined;
}

/**
 * The trust badge's Check again (CLAS-08): a fresh check, then the run's badge again under that run's own answer. When the check throws, the badge is posted
 * again with the reason it could not be checked (PR #95 review), so the page never stays on "Checking again"; a plain notice only when the run has no badge.
 */
export async function checkBadgeAgain(tab: { agent?: BadgeChecker; post(message: Record<string, unknown>): void }, runId: string, describe: (error: unknown) => string): Promise<void> {
  let badge: TrustBadge | undefined;
  let failure: string | undefined;
  try { badge = tab.agent ? await tab.agent.checkAgain(runId) : undefined; } catch (error) {
    failure = `${TRUST_BADGE_TEXT.unavailable} ${describe(error)}`;
    try { badge = tab.agent?.badgeWithNotice(runId, failure); } catch { badge = undefined; }
  }
  if (badge) tab.post({ type: 'trust-badge', runId, badge });
  else tab.post({ type: 'notice', text: failure ?? TRUST_BADGE_TEXT.notKept });
}

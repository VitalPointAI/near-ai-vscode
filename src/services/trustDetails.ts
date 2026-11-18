// Show full attestation on a trust badge (CLAS-08): the details of one answer's check as one JSON object, opened in an untitled editor tab. Nothing is
// written to the workspace, to disk or to a decision record; the document lives only in the editor until the person closes or saves it themselves.
import type { ConnectionBindingFact } from '../domain/gate/routing';
import type { TrustBadge } from '../domain/gate/trustBadge';
import type { AnswerCheckResult } from '../gate/sessionMark';

/** Said when the answer's details are no longer kept: the same 20 answers whose badge facts the chat keeps. */
export const TRUST_DETAILS_NOT_KEPT_TEXT = 'The full attestation is kept only for the last 20 answers of this window, and this answer is no longer one of them.';

/** What one answer's details are built from: what the session kept for its badge. */
export interface TrustDetailsInput {
  readonly runId: string;
  readonly model: string;
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
    answer: { runId: input.runId, model: input.model },
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

/** The editor calls Show full attestation needs, so a test can give its own. */
export interface TrustDetailsEditor {
  readonly workspace: { openTextDocument(options: { language: string; content: string }): PromiseLike<unknown> };
  readonly window: { showTextDocument(document: never, options?: { preview?: boolean }): PromiseLike<unknown> };
  readonly commands: { executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown> };
}

/**
 * Opens the details as an untitled JSON document in a preview tab and marks that tab read-only for the session where the editor supports it. Nothing is
 * saved: the document has no file until the person chooses to save it.
 */
export async function openTrustDetails(editor: TrustDetailsEditor, details: Record<string, unknown>): Promise<void> {
  const document = await editor.workspace.openTextDocument({ language: 'json', content: `${JSON.stringify(details, null, 2)}\n` });
  await editor.window.showTextDocument(document as never, { preview: true });
  try { await editor.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession'); } catch { /* an editor without it shows the tab as editable; nothing is saved either way */ }
}

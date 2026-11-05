// In a web UI (code-server and other browser-based VS Code), saved keys live in the browser's storage, and each tab of the editor loads
// the whole set once and writes its own copy back whenever it saves or removes one. Two tabs in the same browser profile can therefore
// overwrite each other's saved keys (NEAR AI keys, team keys, the team device key). This cannot be fixed from the extension, so a web UI
// is told once, with Got it. The notice is remembered as soon as it is shown, whether or not the person answers; one that could not be
// shown is not remembered, so it is tried again at the next start. Shown in any web UI, solo projects included; never on the desktop.

export const WEB_TAB_NOTICE_KEY = 'nearAi.webTabNotice';
export const GOT_IT = 'Got it';
export const WEB_TAB_NOTICE_TEXT = "NEAR AI: keep one tab of this editor per browser profile. Two tabs in the same browser profile can overwrite each other's saved keys. If a key is lost, set the profile up again, or for a team ask your lead to invite you again.";

export interface WebTabNoticeHost {
  /** VS Code runs in a browser (vscode.env.uiKind is Web). */
  web: boolean;
  state: { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> };
  tell(text: string, ...items: string[]): PromiseLike<string | undefined>;
}

export type WebTabNoticeResult = 'not-web' | 'already-shown' | 'shown';

/** Shows the notice once in a web UI. Resolves when the person answers or closes it; rejects, unremembered, when it could not be shown. */
export async function offerWebTabNotice(host: WebTabNoticeHost): Promise<WebTabNoticeResult> {
  if (!host.web) return 'not-web';
  if (host.state.get(WEB_TAB_NOTICE_KEY)) return 'already-shown';
  // A failure is caught at once (so it is never reported as unhandled while the shown flag is written), then acted on below.
  const failure = Promise.resolve(host.tell(WEB_TAB_NOTICE_TEXT, GOT_IT)).then(() => undefined, (error: unknown) => ({ error }));
  await host.state.update(WEB_TAB_NOTICE_KEY, true);
  const failed = await failure;
  if (failed) {
    await host.state.update(WEB_TAB_NOTICE_KEY, undefined);
    throw failed.error;
  }
  return 'shown';
}

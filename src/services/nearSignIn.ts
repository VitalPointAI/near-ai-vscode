import * as vscode from 'vscode';
import { firstSession, loginUrl, parseCallback, PASTE_CALLBACK, SessionTokens, SignInError, SignInProvider, startLoopbackSignIn } from './reportingSignIn';

// NEAR AI Cloud's browser sign-in as VS Code shows it, shared by the usage reporting token and Team
// Mode: the session comes back to a one-time local listener, or, in a browser-based VS Code
// (code-server) where the forwarded callback isn't this machine's localhost, the address the
// browser ends on is pasted. Only the wording differs between the two uses, because what happens to
// the session afterwards differs: the reporting flow signs it out at once, Team Mode keeps it.

export interface SignInCopy {
  /** The title of the paste box. */
  title: string;
  /** Shown in the paste box while the local listener is also waiting (browser-based VS Code). */
  loopbackPastePrompt: string;
  /** Shown when the only way back is to paste the address. */
  pastePrompt: string;
  /** The last sentence of the paste box: what becomes of the sign-in. */
  keptNote: string;
}

const TITLE = 'Finish signing in to NEAR AI Cloud';
const LOOPBACK_PASTE_PROMPT = 'If the browser then shows a page that can\'t be reached, copy that page\'s whole address and paste it here.';
const PASTE_PROMPT = 'After signing in, the browser shows a page that can\'t be reached. Copy that page\'s whole address and paste it here.';

/** The usage reporting token flow: the sign-in is signed out as soon as the token is made. */
export const REPORTING_SIGN_IN_COPY: SignInCopy = {
  title: TITLE,
  loopbackPastePrompt: LOOPBACK_PASTE_PROMPT,
  pastePrompt: PASTE_PROMPT,
  keptNote: 'It holds a one-time sign-in that is signed out as soon as the token is made.'
};

/** Team Mode: the sign-in is kept for this team until the lead signs out of it. */
export const TEAM_SIGN_IN_COPY: SignInCopy = {
  title: TITLE,
  loopbackPastePrompt: LOOPBACK_PASTE_PROMPT,
  pastePrompt: PASTE_PROMPT,
  keptNote: 'NEAR AI keeps this sign-in for this team\'s invitations and member keys until you run "NEAR AI: Sign Out of NEAR (Team)".'
};

/** The session from NEAR's sign-in in the browser: sent back to a one-time local listener, or pasted. */
export async function browserSignIn(baseUrl: string, provider: SignInProvider, signal: AbortSignal, copy: SignInCopy): Promise<SessionTokens | undefined> {
  try {
    const loopback = await startLoopbackSignIn({ signal, external: async (local) => (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString(true) });
    if (!await vscode.env.openExternal(vscode.Uri.parse(loginUrl(baseUrl, provider, loopback.callback)))) { loopback.close(); return undefined; }
    // A browser-based VS Code (code-server) may be open on another machine, where the forwarded
    // localhost callback isn't this one, so the address can be pasted while the listener waits.
    if (vscode.env.uiKind !== vscode.UIKind.Web) return await loopback.tokens;
    return await firstSession(loopback, pasteSignInAddress(loopback.callback, copy.loopbackPastePrompt, copy));
  } catch (error) {
    if (!(error instanceof SignInError) || error.code !== 'remote') throw error;
  }
  // The forwarded callback isn't on loopback, which NEAR refuses: NEAR sends the session to a page
  // that won't load, and its address (whose fragment holds the session) is pasted here.
  if (!await vscode.env.openExternal(vscode.Uri.parse(loginUrl(baseUrl, provider, PASTE_CALLBACK)))) return undefined;
  const paste = pasteSignInAddress(PASTE_CALLBACK, copy.pastePrompt, copy);
  try {
    const pasted = await paste.value;
    return pasted ? parseCallback(pasted) : undefined;
  } finally {
    paste.dismiss();
  }
}

/** A box for the address the browser ends on after signing in; `value` is undefined if it is dismissed. */
function pasteSignInAddress(callback: string, prompt: string, copy: SignInCopy): { value: Promise<string | undefined>; dismiss(): void } {
  const box = vscode.window.createInputBox();
  box.title = copy.title;
  box.prompt = `${prompt} ${copy.keptNote}`;
  box.password = true;
  box.ignoreFocusOut = true;
  box.placeholder = `${callback}#token=…`;
  const value = new Promise<string | undefined>((resolve) => {
    box.onDidChangeValue((text) => { box.validationMessage = text.trim() ? checkPasted(text) : undefined; });
    box.onDidAccept(() => { if (!checkPasted(box.value)) resolve(box.value); else box.validationMessage = checkPasted(box.value); });
    box.onDidHide(() => resolve(undefined));
  });
  box.show();
  return { value, dismiss: () => box.dispose() };
}

function checkPasted(value: string): string | undefined {
  try { parseCallback(value); return undefined; } catch (error) { return (error as Error).message; }
}

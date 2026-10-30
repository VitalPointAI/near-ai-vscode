import * as vscode from 'vscode';
import { AuthService } from './auth';
import { NearAiClient } from './nearAiClient';
import { ProfileStore } from './profileStore';
import { CLEAR_REPORTING_TOKEN_COMMAND, movePastedReportingTokens, REPORTING_TOKEN_HOW_TO, ReportingTokenHint, reportingTokenHint, ReportingTokenState, SET_REPORTING_TOKEN_COMMAND, USE_NEAR_TOTAL_SETTING } from './reportingToken';
import { configureSpend, resetNearUsage, SpendAccount, spendAccountFor } from './spendAccount';
import { CONSOLE_URL, tokenTestMessage } from './spendInsight';
import { loginUrl, parseCallback, PASTE_CALLBACK, reportingTokenName, SessionTokens, setUpReportingToken, SignInError, SignInProvider, startLoopbackSignIn } from './reportingSignIn';
import type { DayBoundary } from './spendLedger';
import { readSettings } from './settings';

// The host side of spend tracking: where ledgers live, the settings they follow, and the usage
// reporting token (kept in VS Code's encrypted SecretStorage, never logged or shown).

export const REPORTING_TOKEN_KEY = 'nearAi.usageReportingToken';
/** The ID (not a secret) and organization of the token the last sign-in created, so the next one revokes it. */
export const REPORTING_TOKEN_ID_KEY = 'nearAi.usageReportingTokenId';
/** NEAR's reporting tokens look like rpt-0123456789abcdef0123456789abcdef. */
export const REPORTING_TOKEN_SHAPE = /^rpt-[A-Za-z0-9_-]{16,256}$/;

export function readDayBoundary(): DayBoundary {
  return vscode.workspace.getConfiguration('nearAi').get<string>('spend.dayBoundary', 'local') === 'utc' ? 'utc' : 'local';
}

/** nearAi.spend.useNearUsageTotal: whether a stored token replaces this computer's figures with NEAR's (on by default). */
export function readUseNearUsageTotal(): boolean {
  return vscode.workspace.getConfiguration('nearAi').get<boolean>('spend.useNearUsageTotal', true) !== false;
}

/** The extension's secret storage, once spend tracking is configured (only presence of the token is ever read from it here). */
let tokenSecrets: Pick<vscode.SecretStorage, 'get'> | undefined;
const tokenListeners = new Set<() => void>();

/** Called when the token is set, cleared, moved out of settings, or switched on or off. */
export function onReportingTokenChange(listener: () => void): { dispose(): void } {
  tokenListeners.add(listener);
  return { dispose: () => { tokenListeners.delete(listener); } };
}

function reportingTokenChanged(): void {
  resetNearUsage();
  for (const listener of [...tokenListeners]) { try { listener(); } catch { /* a view's refresh never breaks the change */ } }
}

/** Whether a usage reporting token is stored and used; undefined before spend tracking is configured. */
export async function reportingTokenState(): Promise<ReportingTokenState | undefined> {
  if (!tokenSecrets) return undefined;
  const stored = Boolean(await Promise.resolve(tokenSecrets.get(REPORTING_TOKEN_KEY)).catch(() => undefined));
  return !stored ? 'missing' : readUseNearUsageTotal() ? 'set' : 'off';
}

/** The link every spend display shows: set a token, NEAR's total in use, or turn it back on. */
export async function currentReportingTokenHint(): Promise<ReportingTokenHint | undefined> {
  const state = await reportingTokenState();
  return state ? reportingTokenHint(state) : undefined;
}

/** What a page's token link does, decided here from the current state (a page only asks). */
export async function runReportingTokenHint(): Promise<void> {
  const hint = await currentReportingTokenHint() ?? reportingTokenHint('missing');
  await vscode.commands.executeCommand(hint.command, ...hint.args);
}

/** Points spend tracking at this extension's storage; safe to call again (the sidebar does). */
export function configureSpendTracking(context: Pick<vscode.ExtensionContext, 'globalStorageUri'> & { secrets?: vscode.SecretStorage }): void {
  if (context.secrets) tokenSecrets = context.secrets;
  configureSpend({
    dir: context.globalStorageUri.fsPath,
    dayBoundary: readDayBoundary,
    dailyLimitUsd: () => readSettings().dailySpendLimitUsd,
    reportingToken: async () => (context.secrets && readUseNearUsageTotal() ? await context.secrets.get(REPORTING_TOKEN_KEY) : undefined)
  });
}

/** The input box's prompt: what the token does and how to get one. */
export const REPORTING_TOKEN_PROMPT = `Match the NEAR AI console exactly: with this read-only token, spend figures show NEAR AI Cloud's own total for your API key. ${REPORTING_TOKEN_HOW_TO} Stored in VS Code's encrypted secret storage, never in settings; it is sent only to NEAR's usage summary endpoint.`;

/** A token pasted into any NEAR AI setting goes to SecretStorage instead, and out of settings. */
export async function guardPastedReportingTokens(secrets: Pick<vscode.SecretStorage, 'store'>): Promise<string[]> {
  const moved = await movePastedReportingTokens({
    configuration: vscode.workspace.getConfiguration('nearAi'),
    targets: { Global: vscode.ConfigurationTarget.Global, Workspace: vscode.ConfigurationTarget.Workspace, WorkspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder },
    storeToken: (token) => Promise.resolve(secrets.store(REPORTING_TOKEN_KEY, token)),
    notify: (message) => { void vscode.window.showWarningMessage(message); }
  });
  if (moved.length) reportingTokenChanged();
  return moved;
}

/** The choices the command opens with: sign in (one is created for you), or paste a token you have. */
export const SIGN_IN_CHOICES: Array<vscode.QuickPickItem & { choice: SignInProvider | 'paste' }> = [
  { choice: 'github', label: '$(github) Sign in with GitHub', detail: 'Opens NEAR AI Cloud\'s sign-in in your browser. VS Code uses it once to create a read-only usage token that does not expire, then signs that session out. Needs an owner or admin of the API key\'s organization.' },
  { choice: 'google', label: '$(account) Sign in with Google', detail: 'The same, for a NEAR AI Cloud account that signs in with Google.' },
  { choice: 'paste', label: '$(key) Paste a token', detail: 'A usage reporting token you already have (it starts with rpt-).' }
];

async function pasteReportingToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: 'NEAR AI usage reporting token',
    prompt: REPORTING_TOKEN_PROMPT,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'rpt-…',
    validateInput: (value) => (REPORTING_TOKEN_SHAPE.test(value.trim()) ? undefined : 'A usage reporting token starts with "rpt-" followed by letters and digits. It is not in the console UI: an organization owner or admin creates one with POST /v1/organizations/{org_id}/reporting-tokens.')
  });
  if (!token) return;
  await context.secrets.store(REPORTING_TOKEN_KEY, token.trim());
  reportingTokenChanged();
  void vscode.window.showInformationMessage(readUseNearUsageTotal()
    ? 'Usage reporting token saved. Spend figures now show NEAR AI Cloud\'s own total for this API key, marked (NEAR).'
    : 'Usage reporting token saved. Turn on nearAi.spend.useNearUsageTotal to show NEAR AI Cloud\'s own total.');
}

/** The session from NEAR's sign-in in the browser: sent back to a one-time local listener, or pasted. */
async function browserSignIn(baseUrl: string, provider: SignInProvider, signal: AbortSignal): Promise<SessionTokens | undefined> {
  try {
    const loopback = await startLoopbackSignIn({ signal, external: async (local) => (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString(true) });
    if (!await vscode.env.openExternal(vscode.Uri.parse(loginUrl(baseUrl, provider, loopback.callback)))) { loopback.close(); return undefined; }
    return await loopback.tokens;
  } catch (error) {
    if (!(error instanceof SignInError) || error.code !== 'remote') throw error;
  }
  // A browser-based VS Code can't be reached from the browser on 127.0.0.1: NEAR sends the session
  // to a page that won't load, and its address (whose fragment holds the session) is pasted here.
  if (!await vscode.env.openExternal(vscode.Uri.parse(loginUrl(baseUrl, provider, PASTE_CALLBACK)))) return undefined;
  const pasted = await vscode.window.showInputBox({
    title: 'Finish signing in to NEAR AI Cloud',
    prompt: 'After signing in, the browser shows a page that can\'t be reached. Copy that page\'s whole address and paste it here. It holds a one-time sign-in that is signed out as soon as the token is made.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'http://127.0.0.1:9/near-ai/signed-in#token=…',
    validateInput: (value) => { try { parseCallback(value); return undefined; } catch (error) { return (error as Error).message; } }
  });
  return pasted ? parseCallback(pasted) : undefined;
}

/**
 * Signs in to NEAR AI Cloud in the browser and creates a usage reporting token for the
 * organization of the project's API key (no expiry, so it stays current until revoked), revokes
 * the one the last sign-in made, signs the session out, saves the token, and tests it.
 */
export async function signInForReportingToken(context: vscode.ExtensionContext, auth: AuthService, provider: SignInProvider): Promise<boolean> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const key = await cloudKeyForRoot(root, auth);
  if (!key) {
    void vscode.window.showWarningMessage('Set up a NEAR AI Cloud API key for this project first (NEAR AI: Set Up). The token is made for the organization that key belongs to.');
    return false;
  }
  try {
    const created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NEAR AI usage reporting', cancellable: true }, async (progress, cancel) => {
      const abort = new AbortController();
      cancel.onCancellationRequested(() => abort.abort());
      progress.report({ message: 'Checking which organization this API key belongs to…' });
      const { organizationId } = await new NearAiClient({ baseUrl: key.baseUrl, apiKey: key.apiKey }).checkApiKey(abort.signal);
      progress.report({ message: 'Sign in to NEAR AI Cloud in your browser…' });
      const session = await browserSignIn(key.baseUrl, provider, abort.signal);
      if (!session) return undefined;
      progress.report({ message: 'Creating a read-only usage token…' });
      const previous = context.globalState.get<{ id: string; organizationId: string }>(REPORTING_TOKEN_ID_KEY);
      return setUpReportingToken({ baseUrl: key.baseUrl, session, organizationId, name: reportingTokenName(), ...(previous?.organizationId === organizationId ? { previousTokenId: previous.id } : {}) });
    });
    if (!created) return false;
    await context.secrets.store(REPORTING_TOKEN_KEY, created.token);
    await context.globalState.update(REPORTING_TOKEN_ID_KEY, { id: created.id, organizationId: created.organizationId });
    reportingTokenChanged();
    if (created.previousRevoked === false) void vscode.window.showWarningMessage('The usage token the last sign-in made could not be revoked. Revoke it in NEAR AI Cloud if it is no longer needed.');
    await testReportingToken(await spendAccountForRoot(root, auth));
    return true;
  } catch (error) {
    if (error instanceof SignInError && error.code === 'cancelled') return false;
    const text = error instanceof SignInError ? error.message : `Could not set up usage reporting: ${(error as Error).message}`;
    void vscode.window.showErrorMessage(text, 'Try again', 'Paste a token').then((choice) => {
      if (choice === 'Try again') void signInForReportingToken(context, auth, provider);
      else if (choice === 'Paste a token') void pasteReportingToken(context);
    });
    return false;
  }
}

export function registerSpendTracking(context: vscode.ExtensionContext, auth?: AuthService): void {
  configureSpendTracking(context);
  const guard = () => { void guardPastedReportingTokens(context.secrets).catch(() => undefined); };
  guard();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('nearAi')) return;
      guard();
      if (event.affectsConfiguration('nearAi.spend.useNearUsageTotal')) reportingTokenChanged();
    }),
    vscode.commands.registerCommand(SET_REPORTING_TOKEN_COMMAND, async () => {
      const picked = auth ? await vscode.window.showQuickPick(SIGN_IN_CHOICES, { title: 'Set up NEAR AI usage reporting', placeHolder: 'Spend figures then match the NEAR AI console exactly. Sign in once, or paste a token.', ignoreFocusOut: true }) : SIGN_IN_CHOICES.at(-1);
      if (!picked) return;
      if (picked.choice === 'paste' || !auth) await pasteReportingToken(context);
      else await signInForReportingToken(context, auth, picked.choice);
    }),
    vscode.commands.registerCommand(CLEAR_REPORTING_TOKEN_COMMAND, async () => {
      await context.secrets.delete(REPORTING_TOKEN_KEY);
      reportingTokenChanged();
      void vscode.window.showInformationMessage('Usage reporting token removed. Spend figures show this computer\'s ledger (confirmed and pending).');
    })
  );
}

/** The spend account of the project's active NEAR AI Cloud profile, without any network call. */
/** The base URL and API key of the project's active NEAR AI Cloud profile, if it has one. */
async function cloudKeyForRoot(root: string | undefined, auth: AuthService): Promise<{ baseUrl: string; apiKey: string } | undefined> {
  if (!root) return undefined;
  try {
    const profiles = new ProfileStore(root, auth);
    const profile = await profiles.getActiveProfile();
    const selection = await profiles.getActiveSelection();
    if (!profile || !selection || profile.provider === 'local') return undefined;
    const apiKey = await auth.getScopedApiKeyFor(profiles.getScope(selection.profileId), profile.baseUrl);
    return apiKey ? { baseUrl: profile.baseUrl, apiKey } : undefined;
  } catch {
    return undefined;
  }
}

export async function spendAccountForRoot(root: string | undefined, auth: AuthService): Promise<SpendAccount | undefined> {
  try {
    const key = await cloudKeyForRoot(root, auth);
    if (!key) return undefined;
    const { baseUrl: base, apiKey } = key;
    const account = spendAccountFor(base, apiKey);
    if (!account) return undefined;
    // NEAR's usage summary (and billing reconciliation) are asked through the key's client. Until
    // a chat or run made one in this window, none was attached, so a stored reporting token was
    // not used and pages showed only this computer's ledger. A client is cheap and makes no call
    // until the next poll.
    if (!account.usage.attached) new NearAiClient({ baseUrl: base, apiKey, spend: account });
    await account.ledger.refresh();
    return account;
  } catch {
    return undefined;
  }
}

/** Opens the setting whose description links to Set and Clear usage reporting token. */
export async function openReportingTokenSetting(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', USE_NEAR_TOTAL_SETTING);
}

/** Opens the NEAR AI Cloud console, where credits are bought (signing in may be needed). */
export async function openConsoleBilling(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(CONSOLE_URL));
}

/**
 * "Test token now": asks NEAR's usage summary with the stored token and says what happened,
 * with "Fix token" when it failed. Returns the one-line result for a page to show too.
 */
export async function testReportingToken(account: SpendAccount | undefined): Promise<{ ok: boolean; text: string }> {
  const state = await reportingTokenState() ?? 'missing';
  if (state === 'missing') {
    const text = 'No usage reporting token is set, so there is nothing to test.';
    void vscode.window.showInformationMessage(text, 'Set token').then((choice) => { if (choice) void vscode.commands.executeCommand(SET_REPORTING_TOKEN_COMMAND); });
    return { ok: false, text };
  }
  if (state === 'off') {
    const text = `A usage reporting token is set, but ${USE_NEAR_TOTAL_SETTING} is off, so it is not used. Turn the setting on to test it.`;
    void vscode.window.showInformationMessage(text, 'Open setting').then((choice) => { if (choice) void openReportingTokenSetting(); });
    return { ok: false, text };
  }
  if (!account) {
    const text = 'This project has no NEAR AI Cloud API key set up, so the token cannot be checked against one.';
    void vscode.window.showWarningMessage(text);
    return { ok: false, text };
  }
  const result = await account.testReportingToken();
  const text = tokenTestMessage(result);
  if (result.ok) void vscode.window.showInformationMessage(text);
  else void vscode.window.showErrorMessage(text, 'Fix token').then((choice) => { if (choice) void vscode.commands.executeCommand(SET_REPORTING_TOKEN_COMMAND); });
  return { ok: result.ok, text };
}

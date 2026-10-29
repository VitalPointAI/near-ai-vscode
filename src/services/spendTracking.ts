import * as vscode from 'vscode';
import { AuthService } from './auth';
import { ProfileStore } from './profileStore';
import { CLEAR_REPORTING_TOKEN_COMMAND, movePastedReportingTokens, REPORTING_TOKEN_HOW_TO, ReportingTokenHint, reportingTokenHint, ReportingTokenState, SET_REPORTING_TOKEN_COMMAND } from './reportingToken';
import { configureSpend, resetNearUsage, SpendAccount, spendAccountFor } from './spendAccount';
import type { DayBoundary } from './spendLedger';
import { readSettings } from './settings';

// The host side of spend tracking: where ledgers live, the settings they follow, and the usage
// reporting token (kept in VS Code's encrypted SecretStorage, never logged or shown).

export const REPORTING_TOKEN_KEY = 'nearAi.usageReportingToken';
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

export function registerSpendTracking(context: vscode.ExtensionContext): void {
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
    }),
    vscode.commands.registerCommand(CLEAR_REPORTING_TOKEN_COMMAND, async () => {
      await context.secrets.delete(REPORTING_TOKEN_KEY);
      reportingTokenChanged();
      void vscode.window.showInformationMessage('Usage reporting token removed. Spend figures show this computer\'s ledger (confirmed and pending).');
    })
  );
}

/** The spend account of the project's active NEAR AI Cloud profile, without any network call. */
export async function spendAccountForRoot(root: string | undefined, auth: AuthService): Promise<SpendAccount | undefined> {
  if (!root) return undefined;
  try {
    const profiles = new ProfileStore(root, auth);
    const profile = await profiles.getActiveProfile();
    const selection = await profiles.getActiveSelection();
    if (!profile || !selection || profile.provider === 'local') return undefined;
    const apiKey = await auth.getScopedApiKeyFor(profiles.getScope(selection.profileId), profile.baseUrl);
    const account = apiKey ? spendAccountFor(profile.baseUrl, apiKey) : undefined;
    await account?.ledger.refresh();
    return account;
  } catch {
    return undefined;
  }
}

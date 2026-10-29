import * as vscode from 'vscode';
import { AuthService } from './auth';
import { ProfileStore } from './profileStore';
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

/** Points spend tracking at this extension's storage; safe to call again (the sidebar does). */
export function configureSpendTracking(context: Pick<vscode.ExtensionContext, 'globalStorageUri'> & { secrets?: vscode.SecretStorage }): void {
  configureSpend({
    dir: context.globalStorageUri.fsPath,
    dayBoundary: readDayBoundary,
    dailyLimitUsd: () => readSettings().dailySpendLimitUsd,
    reportingToken: async () => (context.secrets ? await context.secrets.get(REPORTING_TOKEN_KEY) : undefined)
  });
}

export function registerSpendTracking(context: vscode.ExtensionContext): void {
  configureSpendTracking(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('nearAi.setUsageReportingToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'NEAR AI usage reporting token',
        prompt: 'A read-only token (rpt-…) an organization owner or admin creates for usage reports. With it, spend figures show NEAR AI Cloud\'s own total for your API key. Stored in VS Code\'s encrypted secret storage; it is sent only to NEAR\'s usage summary endpoint.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'rpt-…',
        validateInput: (value) => (REPORTING_TOKEN_SHAPE.test(value.trim()) ? undefined : 'A usage reporting token starts with "rpt-" followed by letters and digits.')
      });
      if (!token) return;
      await context.secrets.store(REPORTING_TOKEN_KEY, token.trim());
      resetNearUsage();
      void vscode.window.showInformationMessage('Usage reporting token saved. Spend figures now show NEAR AI Cloud\'s own total for this API key, marked (NEAR).');
    }),
    vscode.commands.registerCommand('nearAi.clearUsageReportingToken', async () => {
      await context.secrets.delete(REPORTING_TOKEN_KEY);
      resetNearUsage();
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

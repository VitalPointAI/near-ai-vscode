import * as vscode from 'vscode';
import { AuthService } from './auth';
import { CLEAR_REPORTING_TOKEN_COMMAND, REPORTING_TOKEN_HOW_TO, ReportingTokenState, SET_REPORTING_TOKEN_COMMAND, USE_NEAR_TOTAL_SETTING } from './reportingToken';
import { reportingTokenState, spendAccountForRoot } from './spendTracking';
import { readRunBudget, readSettings } from './settings';

// NEAR AI: Spending Limits. Shows today's spend and the limits that stop requests and runs, and
// changes them for the user or just this workspace. The values are ordinary settings. It also
// sets or clears the usage reporting token, which makes every figure NEAR's own total.

interface Limit { key: string; label: string; unit: 'usd' | 'tokens'; describe(value: number): string; min: number; max: number }

const LIMITS: Limit[] = [
  { key: 'dailySpendLimitUsd', label: 'Daily spend limit', unit: 'usd', min: 0, max: 100_000, describe: (value) => (value > 0 ? `$${value.toFixed(2)} a day` : 'no daily limit') },
  { key: 'agent.maxRunCostUsd', label: 'Cost limit per run', unit: 'usd', min: 0.1, max: 1_000, describe: (value) => `$${value.toFixed(2)} for one run, sub-agents included` },
  { key: 'agent.maxRunTokens', label: 'Token limit per run', unit: 'tokens', min: 10_000, max: 100_000_000, describe: (value) => `${Math.round(value).toLocaleString('en-US')} tokens for one run` }
];

type TokenItem = vscode.QuickPickItem & { token: 'set' | 'clear' };

/** The token items under the limits: set one (always), and clear it (when one is stored). */
export function reportingTokenItems(state: ReportingTokenState): TokenItem[] {
  const description = state === 'set' ? 'set: spend figures are NEAR\'s own total' : state === 'off' ? `set, but ${USE_NEAR_TOTAL_SETTING} is off` : 'Match the NEAR console exactly';
  const items: TokenItem[] = [{ label: 'Set usage reporting token…', description, detail: state === 'missing' ? REPORTING_TOKEN_HOW_TO : undefined, token: 'set' }];
  if (state !== 'missing') items.push({ label: 'Clear usage reporting token', description: 'spend figures go back to this computer\'s ledger', token: 'clear' });
  return items;
}

export function registerSpendingLimits(context: vscode.ExtensionContext, auth: AuthService): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.spendingLimits', async () => {
    for (;;) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      // The same figure as the chat's status line: NEAR's total with a reporting token, else this computer's ledger.
      const account = await spendAccountForRoot(root, auth);
      await account?.ledger.refresh();
      const today = account?.today();
      const spent = account?.spentTodayUsd().usd ?? 0;
      const settings = readSettings();
      const run = readRunBudget();
      const values: Record<string, number> = { dailySpendLimitUsd: settings.dailySpendLimitUsd, 'agent.maxRunCostUsd': run.maxCostUsd, 'agent.maxRunTokens': run.maxTokens };
      const remaining = settings.dailySpendLimitUsd > 0 ? Math.max(0, settings.dailySpendLimitUsd - spent) : undefined;
      const effective = remaining === undefined ? run.maxCostUsd : Math.min(run.maxCostUsd, remaining);
      const tokenState = await reportingTokenState() ?? 'missing';
      const separator = vscode.QuickPickItemKind ? [{ label: 'NEAR\'s own total', kind: vscode.QuickPickItemKind.Separator }] : [];
      const items: Array<vscode.QuickPickItem & { limit?: Limit; token?: 'set' | 'clear' }> = [
        ...LIMITS.map((limit) => ({ label: limit.label, description: limit.describe(values[limit.key]), limit })),
        ...separator,
        ...reportingTokenItems(tokenState)
      ];
      const choice = await vscode.window.showQuickPick(items, {
        title: `Spending limits · ${today ? today.text : '$0.00 today'}${remaining !== undefined ? ` · $${remaining.toFixed(2)} left` : ''}`,
        placeHolder: `The next run may spend up to $${effective.toFixed(2)} (whichever limit is lower). Pick a limit to change it.`
      });
      if (!choice) return;
      if (choice.token) { await vscode.commands.executeCommand(choice.token === 'set' ? SET_REPORTING_TOKEN_COMMAND : CLEAR_REPORTING_TOKEN_COMMAND); continue; }
      const limit = choice.limit;
      if (!limit) continue;
      const input = await vscode.window.showInputBox({
        title: `${limit.label} (now ${limit.describe(values[limit.key])})`,
        prompt: limit.unit === 'usd' ? `US dollars${limit.min === 0 ? '; 0 for no limit' : ''}.` : 'Tokens (input and output together).',
        value: String(values[limit.key]),
        validateInput: (value) => { const number = Number(value.replace(/[$,\s]/g, '')); return Number.isFinite(number) && number >= limit.min && number <= limit.max ? undefined : `Enter a number from ${limit.min} to ${limit.max.toLocaleString('en-US')}.`; }
      });
      if (input === undefined) continue;
      const scope = root ? await vscode.window.showQuickPick([{ label: 'For me, in every project', target: vscode.ConfigurationTarget.Global }, { label: 'For this workspace only', target: vscode.ConfigurationTarget.Workspace }], { title: `Where should the new ${limit.label.toLowerCase()} apply?` }) : { target: vscode.ConfigurationTarget.Global };
      if (!scope) continue;
      await vscode.workspace.getConfiguration('nearAi').update(limit.key, Number(input.replace(/[$,\s]/g, '')), scope.target);
    }
  }));
}

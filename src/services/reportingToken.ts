// Where the user finds NEAR's usage reporting token: the same words and the same action in the
// chat's spend line, Spending Limits, Agent Activity, the Tools tab, and Settings. No VS Code
// imports, so every entry point's wording is tested directly. The token itself never passes
// through here: only whether one is set.

export const SET_REPORTING_TOKEN_COMMAND = 'nearAi.setUsageReportingToken';
export const CLEAR_REPORTING_TOKEN_COMMAND = 'nearAi.clearUsageReportingToken';
/** The switch (on by default) that lets a stored token replace this computer's figures with NEAR's. */
export const USE_NEAR_TOTAL_SETTING = 'nearAi.spend.useNearUsageTotal';

/** How a token is made: it is not in the NEAR AI Cloud console's UI. */
export const REPORTING_TOKEN_HOW_TO = 'Sign in to NEAR AI Cloud from VS Code as an organization owner or admin and one is created for you. Or paste one: an organization owner or admin creates one with POST /v1/organizations/{org_id}/reporting-tokens, authenticated with a NEAR AI Cloud console session token (it is not in the console UI). It starts with rpt-.';

/** `missing`: no token stored. `set`: stored and used. `off`: stored, but nearAi.spend.useNearUsageTotal is off. */
export type ReportingTokenState = 'missing' | 'set' | 'off';

export interface ReportingTokenHint {
  state: ReportingTokenState;
  /** The link's text. */
  text: string;
  /** What it means, for a tooltip. */
  title: string;
  /** What the link runs (the host runs it; a page only asks). */
  command: string;
  args: string[];
}

export const TOKEN_MISSING_TEXT = 'Match the NEAR console exactly: sign in to set up usage reporting';
export const TOKEN_SET_TEXT = 'Using NEAR\'s total';
export const TOKEN_OFF_TEXT = 'Match the NEAR console exactly: turn on NEAR\'s total';

export function reportingTokenHint(state: ReportingTokenState): ReportingTokenHint {
  if (state === 'set') return { state, text: TOKEN_SET_TEXT, title: 'Spend figures show NEAR AI Cloud\'s own total for this API key, the figure the console shows (a usage reporting token is set). Click to replace the token; NEAR AI: Clear Usage Reporting Token removes it.', command: SET_REPORTING_TOKEN_COMMAND, args: [] };
  if (state === 'off') return { state, text: TOKEN_OFF_TEXT, title: `A usage reporting token is set, but ${USE_NEAR_TOTAL_SETTING} is off, so spend figures are this computer's ledger. Click to open the setting.`, command: 'workbench.action.openSettings', args: [USE_NEAR_TOTAL_SETTING] };
  return { state, text: TOKEN_MISSING_TEXT, title: `Spend figures are this computer's ledger, which can differ from the NEAR AI console. With a usage reporting token they show NEAR's own total for this API key. ${REPORTING_TOKEN_HOW_TO}`, command: SET_REPORTING_TOKEN_COMMAND, args: [] };
}

/** What a webview gets: the words, never a command it could change. */
export function hintForView(hint: ReportingTokenHint): { state: ReportingTokenState; text: string; title: string } {
  return { state: hint.state, text: hint.text, title: hint.title };
}

/** A setting value that is a usage reporting token (pasted into the wrong place). */
export function looksLikeReportingToken(value: unknown): value is string {
  return typeof value === 'string' && /^rpt-/.test(value.trim());
}

/**
 * Every string under the `nearAi` settings that is a usage reporting token, with its dotted path
 * below `nearAi` (e.g. "baseUrl", or "agent.roleModels.planner" inside an object setting).
 */
export function findPastedReportingTokens(section: unknown, prefix: string[] = []): Array<{ path: string[]; token: string }> {
  if (looksLikeReportingToken(section)) return [{ path: prefix, token: section.trim() }];
  if (Array.isArray(section)) return section.flatMap((item, index) => findPastedReportingTokens(item, [...prefix, String(index)]));
  if (section && typeof section === 'object') {
    return Object.entries(section as Record<string, unknown>).flatMap(([key, value]) => (typeof value === 'function' ? [] : findPastedReportingTokens(value, [...prefix, key])));
  }
  return [];
}

/** `value` without the token at `path` (an object key deleted, an array item removed); undefined when the value is the token. */
export function withoutTokenAt(value: unknown, path: string[]): unknown {
  if (!path.length) return undefined;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return value;
    if (!rest.length) return value.filter((_item, at) => at !== index);
    return value.map((item, at) => (at === index ? withoutTokenAt(item, rest) : item));
  }
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    if (!(head in copy)) return value;
    if (!rest.length) delete copy[head];
    else copy[head] = withoutTokenAt(copy[head], rest);
    return copy;
  }
  return value;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export interface SettingsScopes<T> { Global: T; Workspace: T; WorkspaceFolder: T }
export interface PastedTokenDeps<T> {
  /** getConfiguration('nearAi'): its values (a merged object) plus inspect and update. */
  configuration: { inspect(key: string): { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined; update(key: string, value: unknown, target: T): Thenable<void> | Promise<void> };
  targets: SettingsScopes<T>;
  storeToken(token: string): Promise<void>;
  notify(message: string): void;
}

/**
 * Settings are plain text (and often synced or committed): a reporting token found in any
 * `nearAi` setting is moved to SecretStorage and removed from every scope that holds it.
 * Returns the settings it cleared, as `nearAi.<key>`.
 */
export async function movePastedReportingTokens<T>(deps: PastedTokenDeps<T>): Promise<string[]> {
  const found = findPastedReportingTokens(deps.configuration);
  if (!found.length) return [];
  const cleared = new Set<string>();
  for (const { path } of found) {
    // The setting is the longest prefix of the path that has a value of its own in some scope.
    for (let length = path.length; length > 0; length -= 1) {
      const key = path.slice(0, length).join('.');
      const info = deps.configuration.inspect(key);
      const scopes: Array<[unknown, T]> = [[info?.globalValue, deps.targets.Global], [info?.workspaceValue, deps.targets.Workspace], [info?.workspaceFolderValue, deps.targets.WorkspaceFolder]];
      const holding = scopes.filter(([value]) => looksLikeReportingToken(valueAt(value, path.slice(length))));
      if (!holding.length) continue;
      for (const [value, target] of holding) await deps.configuration.update(key, withoutTokenAt(value, path.slice(length)), target);
      cleared.add(`nearAi.${key}`);
      break;
    }
  }
  await deps.storeToken(found[0].token);
  const names = [...cleared];
  deps.notify(`A usage reporting token was in the setting ${names.length ? names.join(', ') : 'for NEAR AI'}. Settings are stored as plain text, so it was moved to VS Code's encrypted secret storage and removed from settings. Spend figures now use NEAR's own total.`);
  return names;
}

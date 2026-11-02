// In code-server (VS Code in a browser tab) and remote windows, VS Code's proxy support
// (http.proxySupport, "override" by default) asks the window which proxy each new network
// connection should use. A browser tab in the background can be paused by the browser, and then
// nothing answers: every new connection the extension host makes waits, so agent runs stall until
// the tab is shown again. With no proxy in use, turning proxy support off avoids that. The
// extension only suggests it, once, and changes the setting only when the user clicks.

export const PROXY_ADVICE_KEY = 'nearAi.proxyAdvice';
/** "Not now" asks again after this long. */
export const PROXY_ADVICE_SNOOZE_MS = 14 * 24 * 60 * 60_000;

export const TURN_OFF_PROXY_SUPPORT = 'Turn off proxy support';
export const NOT_NOW = 'Not now';
export const DONT_ASK_AGAIN = "Don't ask again";
export const RELOAD_WINDOW = 'Reload Window';

/** The advice, worded for a browser tab (code-server) or a remote window. */
export function proxyAdviceText(web: boolean): string {
  const where = web ? 'this browser tab' : 'this window';
  return `NEAR AI: agent runs can pause while ${where} is in the background. VS Code asks ${where} which proxy to use for each new connection, and in the background it may not answer until you come back. You have no proxy set, so turning off VS Code's proxy support (http.proxySupport: off) avoids this.`;
}
export const PROXY_SUPPORT_OFF_TEXT = 'Proxy support is off (http.proxySupport: off in your user settings). Reload the window for it to take effect, when no agent run is going.';

export interface ProxyEnvironment {
  /** VS Code runs in a browser (code-server, vscode.dev). */
  web: boolean;
  /** The extension host runs on a remote machine (SSH, container, WSL, tunnel). */
  remoteName?: string;
  /** http.proxySupport; undefined means the default ("override"). */
  proxySupport?: string;
  /** http.proxy. */
  proxy?: string;
  env: Record<string, string | undefined>;
}

/** Whether the advice applies: a browser or remote host, proxy support on, and no proxy configured anywhere. */
export function proxyAdviceApplies(input: ProxyEnvironment): boolean {
  if (!input.web && !input.remoteName) return false;
  if ((input.proxySupport ?? 'override') === 'off') return false;
  if (input.proxy?.trim()) return false;
  return !['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'].some((name) => input.env[name]?.trim());
}

type Remembered = { never?: boolean; snoozedUntil?: number };

export interface ProxyAdviceHost extends ProxyEnvironment {
  state: { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> };
  ask(text: string, ...items: string[]): PromiseLike<string | undefined>;
  /** Writes http.proxySupport: "off" to the user (global) settings. */
  turnOff(): PromiseLike<void>;
  tell(text: string, ...items: string[]): PromiseLike<string | undefined>;
  reload(): PromiseLike<unknown> | void;
  now?: () => number;
}

export type ProxyAdviceResult = 'not-needed' | 'not-asked' | 'turned-off' | 'snoozed' | 'never' | 'failed';

/** Shows the advice when it applies and has not been dismissed; acts only on the user's click. */
export async function offerProxyAdvice(host: ProxyAdviceHost): Promise<ProxyAdviceResult> {
  if (!proxyAdviceApplies(host)) return 'not-needed';
  const now = (host.now ?? Date.now)();
  const raw = host.state.get(PROXY_ADVICE_KEY);
  const remembered: Remembered = raw && typeof raw === 'object' ? raw as Remembered : {};
  if (remembered.never || (typeof remembered.snoozedUntil === 'number' && remembered.snoozedUntil > now)) return 'not-asked';
  const choice = await host.ask(proxyAdviceText(host.web), TURN_OFF_PROXY_SUPPORT, NOT_NOW, DONT_ASK_AGAIN);
  if (choice === DONT_ASK_AGAIN) { await host.state.update(PROXY_ADVICE_KEY, { never: true }); return 'never'; }
  if (choice !== TURN_OFF_PROXY_SUPPORT) { await host.state.update(PROXY_ADVICE_KEY, { snoozedUntil: now + PROXY_ADVICE_SNOOZE_MS }); return 'snoozed'; }
  try {
    await host.turnOff();
  } catch (error) {
    await host.tell(`Proxy support could not be turned off: ${error instanceof Error ? error.message : String(error)}. Set http.proxySupport to "off" in your user settings instead.`);
    return 'failed';
  }
  if (await host.tell(PROXY_SUPPORT_OFF_TEXT, RELOAD_WINDOW) === RELOAD_WINDOW) await host.reload();
  return 'turned-off';
}

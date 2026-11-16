// The policy status bar item (OFFL-02, D-13, D-33): "Policy" while the signed policy file is good, "Policy: renewing" in its last days, and a visible
// "Policy: reading only" with the bundle's own one-sentence cause and fix when the gate has failed closed. The words come from one pure function so a test
// can check every state; the item itself is a thin wrapper, like the Team status bar.
import * as vscode from 'vscode';
import { RENEW_WINDOW_DAYS, failedClosed, needsRenewal } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';

export const SHOW_POLICY_COMMAND = 'nearAi.policy.show';
export const POLICY_STATUS_TEXT = 'Policy';
export const POLICY_RENEWING_TEXT = 'Policy: renewing';
export const POLICY_READING_ONLY_TEXT = 'Policy: reading only';
export const POLICY_CHECKING_TEXT = 'Policy: checking';

const CHECKING_TOOLTIP = 'NEAR AI is checking your policy file.';
const READING_ONLY_NOTE = 'Click to see your policy.';

export interface GateStatusShown {
  readonly text: string;
  readonly tooltip: string;
  /** True when the item shows the warning background. */
  readonly warning: boolean;
}

/** The date part of an ISO time, so the tooltip reads the same in every locale and time zone. */
export function expiryDate(expiresAt: string): string {
  return expiresAt.slice(0, 10);
}

/** The bundle's one sentence (cause and fix) when the policy is not usable at `now`, or undefined when it is. A valid state past its end reads as expired. */
export function policyProblem(state: BundleState | undefined, now: number): string | undefined {
  if (state === undefined) return undefined;
  if (state.state === 'valid') return Date.parse(state.expiresAt) <= now ? failedClosed('expired').sentence : undefined;
  return state.sentence;
}

/**
 * What the item shows for a policy state. `undefined` means the check has not finished yet. A state that says valid but whose end has passed at `now` reads
 * as expired, the same as the gate's own decisions do, so the item never claims a policy the gate would refuse.
 */
export function gateStatusText(state: BundleState | undefined, now: number): GateStatusShown {
  if (state === undefined) return { text: POLICY_CHECKING_TEXT, tooltip: CHECKING_TOOLTIP, warning: false };
  const problem = policyProblem(state, now);
  if (problem !== undefined || state.state !== 'valid') {
    return { text: POLICY_READING_ONLY_TEXT, tooltip: `${problem ?? ''} ${READING_ONLY_NOTE}`.trim(), warning: true };
  }
  const until = `Your policy is signed and valid until ${expiryDate(state.expiresAt)}.`;
  // `renewDue` is what the check found when it ran; a window that opened since then counts too, so a long-open editor shows it with no new check.
  if (state.renewDue || needsRenewal({ expiresAt: state.expiresAt }, now)) {
    return { text: POLICY_RENEWING_TEXT, tooltip: `${until} It is close to its end and is renewed the next time NEAR AI starts.`, warning: false };
  }
  return { text: POLICY_STATUS_TEXT, tooltip: `${until} Click to see your policy.`, warning: false };
}

/** The most a timer can be asked to wait (a 32-bit count of milliseconds, about 24.8 days); a longer wait is cut to this and armed again when it ends. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** How long the bar waits to read the host again after a read that failed. */
export const READ_RETRY_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The timers the bar uses; a test passes its own so no test waits. */
export interface GateStatusTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface GateStatusBarOptions {
  /** The host's state and the time now, read again each time the bar's words are due to change. Without it the bar changes only when `update` is called. */
  read?: () => { state: BundleState | undefined; now: number };
  timers?: GateStatusTimers;
}

/**
 * The next moment (milliseconds since 1970) the item's words change on their own for this state: the start of the renewal window (the last RENEW_WINDOW_DAYS
 * days), then the policy's end. Undefined when nothing ahead changes them: the end has passed, the policy is not valid, or its end cannot be read.
 */
export function nextStatusChange(state: BundleState | undefined, now: number): number | undefined {
  if (state === undefined || state.state !== 'valid') return undefined;
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires) || !Number.isFinite(now)) return undefined;
  const windowStart = expires - RENEW_WINDOW_DAYS * DAY_MS;
  if (now < windowStart) return windowStart;
  return now < expires ? expires : undefined;
}

const defaultTimers: GateStatusTimers = {
  set: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    // A pending refresh never keeps a process alive on its own.
    handle.unref?.();
    return handle;
  },
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); }
};

export interface GateStatusBar {
  update(state: BundleState | undefined, now: number): void;
  dispose(): void;
}

export function createGateStatusBar(options: GateStatusBarOptions = {}): GateStatusBar {
  const timers = options.timers ?? defaultTimers;
  const item = vscode.window.createStatusBarItem('nearAi.gate', vscode.StatusBarAlignment.Left, 49);
  item.name = 'NEAR AI Policy';
  item.command = SHOW_POLICY_COMMAND;
  const apply = (shown: GateStatusShown): void => {
    item.text = shown.text;
    item.tooltip = shown.tooltip;
    item.backgroundColor = shown.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  };
  let handle: unknown;
  let armed = false;
  let disposed = false;
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    timers.clear(handle);
  };
  const arm = (delayMs: number): void => {
    // A timer waits at most MAX_TIMER_DELAY_MS and at least a moment; a cut wait ends with nothing to show and arms the rest.
    armed = true;
    handle = timers.set(refresh, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, Math.ceil(delayMs))));
  };
  const show = (state: BundleState | undefined, now: number): void => {
    apply(gateStatusText(state, now));
    disarm();
    const next = nextStatusChange(state, now);
    if (next !== undefined && !disposed) arm(next - now);
  };
  function refresh(): void {
    armed = false;
    if (disposed || options.read === undefined) return;
    let read: { state: BundleState | undefined; now: number };
    try {
      read = options.read();
    } catch {
      // The host could not be read: the item keeps what it shows, and tries again shortly.
      arm(READ_RETRY_MS);
      return;
    }
    show(read.state, read.now);
  }
  apply(gateStatusText(undefined, 0));
  item.show();
  return {
    update(state, now): void {
      if (disposed) return;
      show(state, now);
    },
    dispose(): void {
      disposed = true;
      disarm();
      item.dispose();
    }
  };
}

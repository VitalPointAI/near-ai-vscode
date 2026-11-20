// The policy status bar item (OFFL-02, D-13, D-33): "Policy" while the signed policy file is good, "Policy: renewing" in its last days, and a visible
// "Policy: reading only" with the bundle's own one-sentence cause and fix when the gate has failed closed. The words come from one pure function so a test
// can check every state; the item itself is a thin wrapper, like the Team status bar. Under your organization's rules it says so, with your organization's
// name, and "Policy: ends soon" with the contact in their last 30 days (D-14, D-23); with no organization every word is as before.
import * as vscode from 'vscode';
import { RENEW_WINDOW_DAYS, failedClosed, needsRenewal } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { contactShown, organizationEndingText } from '../domain/gate/enrolment';
import type { PolicyLayersView } from '../gate/organizationStore';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import { isDefaultMark } from '../gate/sessionMark';
import { labelKeyShown } from '../domain/gate/labelAlgebra';

export const SHOW_POLICY_COMMAND = 'nearAi.policy.show';
export const POLICY_STATUS_TEXT = 'Policy';
export const POLICY_RENEWING_TEXT = 'Policy: renewing';
export const POLICY_READING_ONLY_TEXT = 'Policy: reading only';
export const POLICY_CHECKING_TEXT = 'Policy: checking';
export const POLICY_ENDS_SOON_TEXT = 'Policy: ends soon';

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

/**
 * The bundle's one sentence (cause and fix) when the policy is not usable at `now`, or undefined when it is. A valid state past its end reads as expired:
 * your organization's own ending sentence when the layers say its rules end first.
 */
export function policyProblem(state: BundleState | undefined, now: number, layers?: PolicyLayersView): string | undefined {
  if (state === undefined) return undefined;
  if (state.state === 'valid') return Date.parse(state.expiresAt) <= now ? (layers?.expiry ?? failedClosed('expired')).sentence : undefined;
  return state.sentence;
}

/**
 * What the item shows for a policy state. `undefined` means the check has not finished yet. A state that says valid but whose end has passed at `now` reads
 * as expired, the same as the gate's own decisions do, so the item never claims a policy the gate would refuse.
 */
export function gateStatusText(state: BundleState | undefined, now: number, chatMark?: ChatMarkShown, layers?: PolicyLayersView): GateStatusShown {
  const shown = policyStatusText(state, now, layers);
  // D-33: the label of the chat in view, beside the policy state, while it is above the default label; nothing for it at the default or with no chat.
  if (chatMark === undefined || chatMark.mark.length === 0 || isDefaultMark(chatMark.mark, chatMark.defaultLabel)) return shown;
  // Coherence review S8: the scale's name with the level, never the raw id.
  const label = chatMark.mark.map((each) => labelKeyShown(each)).join(', ');
  return { ...shown, text: `${shown.text} · ${label}`, tooltip: `${shown.tooltip} The chat in view is labelled ${label}: its label decides where its content may be sent.` };
}

/** The chat in view's mark and the default label it is compared with, for the status bar (D-33). */
export interface ChatMarkShown {
  readonly mark: Mark;
  readonly defaultLabel: Label;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function policyStatusText(state: BundleState | undefined, now: number, layers?: PolicyLayersView): GateStatusShown {
  if (state === undefined) return { text: POLICY_CHECKING_TEXT, tooltip: CHECKING_TOOLTIP, warning: false };
  const problem = policyProblem(state, now, layers);
  if (problem !== undefined || state.state !== 'valid') {
    return { text: POLICY_READING_ONLY_TEXT, tooltip: `${problem ?? ''} ${READING_ONLY_NOTE}`.trim(), warning: true };
  }
  const organization = layers?.organization.state === 'valid' ? layers.organization : undefined;
  // D-14: your organization's rules in their last days are renewed only by your organization, so the person is told whom to ask.
  if (organization !== undefined && (organization.endsSoon || Date.parse(organization.expiresAt) - now <= RENEW_WINDOW_DAYS * DAY_MS)) {
    return { text: POLICY_ENDS_SOON_TEXT, tooltip: `${organizationEndingText(expiryDate(organization.expiresAt), contactShown(organization.contacts))} ${READING_ONLY_NOTE}`, warning: false };
  }
  const until = organization === undefined
    ? `Your policy is signed and valid until ${expiryDate(state.expiresAt)}.`
    : `Your organization's rules${organization.name === undefined ? '' : ` (${organization.name})`} are signed and valid until ${expiryDate(state.expiresAt)}. Your settings on this computer can only narrow them.`;
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

/** The timers the bar uses; a test passes its own so no test waits. */
export interface GateStatusTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface GateStatusBarOptions {
  /** The host's state and the time now, read again each time the bar's words are due to change. Without it the bar changes only when `update` is called. */
  read?: () => { state: BundleState | undefined; now: number; layers?: PolicyLayersView };
  /** The chat in view's mark, read each time the item is shown (D-33). */
  chatMark?: () => ChatMarkShown | undefined;
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
  update(state: BundleState | undefined, now: number, layers?: PolicyLayersView): void;
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
  const chatMarkNow = (): ChatMarkShown | undefined => {
    try { return options.chatMark?.(); } catch { return undefined; }
  };
  const show = (state: BundleState | undefined, now: number, layers?: PolicyLayersView): void => {
    apply(gateStatusText(state, now, chatMarkNow(), layers));
    disarm();
    const next = nextStatusChange(state, now);
    if (next !== undefined && !disposed) arm(next - now);
  };
  function refresh(): void {
    armed = false;
    if (disposed || options.read === undefined) return;
    let read: { state: BundleState | undefined; now: number; layers?: PolicyLayersView };
    try {
      read = options.read();
    } catch {
      // The host could not be read: the item keeps what it shows, and tries again shortly.
      arm(READ_RETRY_MS);
      return;
    }
    show(read.state, read.now, read.layers);
  }
  apply(gateStatusText(undefined, 0));
  item.show();
  return {
    update(state, now, layers): void {
      if (disposed) return;
      show(state, now, layers);
    },
    dispose(): void {
      disposed = true;
      disarm();
      item.dispose();
    }
  };
}

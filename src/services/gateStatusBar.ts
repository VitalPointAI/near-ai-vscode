// The policy status bar item (OFFL-02, D-13, D-33): "Policy" while the signed policy file is good, "Policy: renewing" in its last days, and a visible
// "Policy: reading only" with the bundle's own one-sentence cause and fix when the gate has failed closed. The words come from one pure function so a test
// can check every state; the item itself is a thin wrapper, like the Team status bar.
import * as vscode from 'vscode';
import { failedClosed } from '../domain/gate/bundle';
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
  if (state.renewDue) {
    return { text: POLICY_RENEWING_TEXT, tooltip: `${until} It is close to its end and is renewed the next time NEAR AI starts.`, warning: false };
  }
  return { text: POLICY_STATUS_TEXT, tooltip: `${until} Click to see your policy.`, warning: false };
}

export interface GateStatusBar {
  update(state: BundleState | undefined, now: number): void;
  dispose(): void;
}

export function createGateStatusBar(): GateStatusBar {
  const item = vscode.window.createStatusBarItem('nearAi.gate', vscode.StatusBarAlignment.Left, 49);
  item.name = 'NEAR AI Policy';
  item.command = SHOW_POLICY_COMMAND;
  const apply = (shown: GateStatusShown): void => {
    item.text = shown.text;
    item.tooltip = shown.tooltip;
    item.backgroundColor = shown.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  };
  apply(gateStatusText(undefined, 0));
  item.show();
  return {
    update(state, now): void {
      apply(gateStatusText(state, now));
    },
    dispose(): void {
      item.dispose();
    }
  };
}

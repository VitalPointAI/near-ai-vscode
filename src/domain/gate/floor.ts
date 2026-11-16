// The floor (GATE-05, D-16, D-17, D-44): what the gate refuses, or asks a person about, in every mode and every context. Pure: no I/O, no clock, no vscode,
// no package, and nothing from src/agent. Nothing a person sets, no bundle value and no approval mode turns a floor rule into an allowance: a refusal rule
// refuses with no card, an ask rule asks with no "always allow" and no run-wide grant (the gate, in decide.ts, enforces that; this file only names the rule).
import { PROTECTED_WRITE, normalizeRelative, protectedWriteReason } from '../protectedPaths';
import type { Capability } from './vocabulary';

/** What each rule does. `refuse` means no card and no way through; `ask` means a person is asked, with no shortcut offered. */
export const FLOOR_RULES = Object.freeze({
  'floor.state-keys': 'refuse',
  'floor.credential-store': 'refuse',
  'floor.identity-files': 'refuse',
  'floor.protected-write': 'ask',
  'floor.publish': 'ask',
  'floor.destroy': 'ask',
  'floor.shared-write': 'ask'
} as const);
export type FloorRule = keyof typeof FLOOR_RULES;
export type FloorKind = (typeof FLOOR_RULES)[FloorRule];

/**
 * The order rules are tried in, so one call always records the same rule. Refusals come first, so a refusal wins over an ask when both match, and inside
 * each group the order is the order they are listed here.
 */
export const FLOOR_RULE_ORDER: readonly FloorRule[] = Object.freeze([
  'floor.state-keys', 'floor.credential-store', 'floor.identity-files', 'floor.protected-write', 'floor.publish', 'floor.destroy', 'floor.shared-write'
] as const);

const TEAM_SETTINGS_FILE = '.planning/.near-ai/team.md';

/**
 * Whether a write to this project-relative path always asks: everything PROTECTED_WRITE covers, except the one file the team builder and Team Studio write
 * on purpose, `.planning/.near-ai/team.md` (D-44). The exemption is the exact file, so `team.md.bak` and `labels.json` beside it are covered, and a
 * `.github/` folder is not a `.git` folder.
 */
export function isFloorProtectedWrite(relative: string): boolean {
  const normalized = normalizeRelative(relative);
  if (normalized === TEAM_SETTINGS_FILE || normalized.endsWith(`/${TEAM_SETTINGS_FILE}`)) return false;
  return PROTECTED_WRITE.test(normalized);
}

export interface FloorVerdict {
  readonly rule: FloorRule;
  readonly kind: FloorKind;
  /** One plain sentence for the person. */
  readonly reason: string;
}

/** What `floorFor` reads from a request. The gate's own request type has all of these. */
export interface FloorInput {
  readonly effects: readonly Capability[];
}

function pathsOf(capability: Capability): readonly string[] {
  return capability.verb === 'workspaceWrite' || capability.verb === 'destroy' ? capability.paths : [];
}

function protectedWriteMatch(input: FloorInput): string | undefined {
  for (const effect of input.effects) {
    for (const shown of pathsOf(effect)) {
      if (isFloorProtectedWrite(shown)) return protectedWriteReason(shown) ?? `${shown} is a protected place. Approve this write only if you expect it.`;
    }
  }
  return undefined;
}

/**
 * The first floor rule, in FLOOR_RULE_ORDER, that this call matches, or undefined. A pure function of the request: no I/O, so every decision is the same
 * with or without a network.
 */
export function floorFor(input: FloorInput): FloorVerdict | undefined {
  const matched = new Map<FloorRule, string>();
  const protectedWrite = protectedWriteMatch(input);
  if (protectedWrite !== undefined) matched.set('floor.protected-write', protectedWrite);
  for (const rule of FLOOR_RULE_ORDER) {
    const reason = matched.get(rule);
    if (reason !== undefined) return Object.freeze({ rule, kind: FLOOR_RULES[rule], reason });
  }
  return undefined;
}

// The second half of "the project should learn" (owner, 2026-11-05 for 0.4.17): besides remembering one exact command, a person can allow a whole
// kind of risk for this project, so a research project stops asking about web reads and ordinary outside reads, while destruction and publishing keep
// asking. A switch is a plain boolean setting, visible and removable in Settings, which is what makes the learning inspectable rather than hidden.
// Pure: no vscode, no I/O; the caller reads the settings.
import { RISK_KINDS } from './approvalRisk';
import type { RiskKind } from './approvalRisk';

/** The switch that allows each kind of risk for a project, or undefined for a kind that always asks. */
export const RISK_SWITCH: Readonly<Record<RiskKind, string | undefined>> = Object.freeze({
  // Reading outside the project is what research does; the project opts in once.
  'outside-workspace': 'agent.autoAllowOutsideWorkspace',
  // These three can lose work, send data out, or change the machine, so they always ask. A person can still allow one exact command.
  destructive: undefined,
  'leaves-machine': undefined,
  credentials: undefined,
  // Installing is a deliberate act; the switch exists because a data-science project may want it.
  installs: 'agent.autoAllowInstalls',
  // "Not sure" is by definition the case the project has not decided, so it always asks.
  unsure: undefined
});

/** The classes a person can turn on, in the order the settings page lists them. */
export const SWITCHABLE_KINDS: readonly RiskKind[] = RISK_KINDS.filter((kind) => RISK_SWITCH[kind] !== undefined);

export interface RiskSwitches {
  outsideWorkspace: boolean;
  installs: boolean;
}

/**
 * Whether this project has already allowed this kind of risk. Only a kind with a switch can be allowed, and a kind the reader does not switch on
 * always asks.
 */
export function riskAllowed(kind: RiskKind, switches: RiskSwitches): boolean {
  switch (kind) {
    case 'outside-workspace': return switches.outsideWorkspace;
    case 'installs': return switches.installs;
    default: return false;
  }
}

/** The setting that turns this kind of risk off for a project, or undefined when the kind always asks. */
export function switchOf(kind: RiskKind): string | undefined {
  return RISK_SWITCH[kind];
}

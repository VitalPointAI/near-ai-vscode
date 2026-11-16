// The one decision function (GATE-04, D-08, D-10, D-19, D-43). Pure and asynchronous only because the settings layer is: it is today's
// decidePermissionAsync, handed in as a function, so this file imports nothing from src/agent. The layers run in a fixed order and an earlier layer is never
// undone by a later one: emergency stop, bundle state, floor, bundle ceiling, labels, then the settings layer. A floor refusal has no card and no way
// through; a floor ask is a card with no "always allow" and no run-wide grant; a deny from the settings layer (the deny list) still beats a floor ask.
import type { ActionPolicy } from '../policy';
import type { BundleState, GateContextName } from './bundle';
import { floorFor } from './floor';
import type { FloorInput, FloorVerdict } from './floor';
import type { DecisionRecord } from './record';

/** Whether a person can answer a card right now. A sub-agent of a chat run still has a person, so this is not the same idea as `unattended` (Pitfall 3). */
export type Presence = 'person' | 'none';

export type ActorKind = 'person' | 'agent' | 'sub-agent';

export interface ActorRef {
  readonly kind: ActorKind;
  /** The device fingerprint (D-20). */
  readonly deviceFingerprint: string;
  /** The conversation or run id. */
  readonly sessionId: string;
  readonly agentId?: string;
  readonly agentLabel?: string;
}

export interface GateRequest extends FloorInput {
  readonly actor: ActorRef;
  readonly tool: string;
  readonly callId: string;
  /** The shell command, when the tool runs one. */
  readonly command?: string;
  readonly context: GateContextName;
  readonly presence: Presence;
  /** The person's own setting; the bundle's ceiling can only lower the mode it names. */
  readonly policy: ActionPolicy;
}

export interface SettingsAnswer {
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly reason?: string;
  /** The `settings.*` rule id that decided, from the migration table. */
  readonly rule: string;
}

/** Today's decidePermissionAsync (modes, allow and deny lists, run grants, classifier, safety model, taint holds), handed in so this file stays pure. */
export type SettingsLayer = (request: GateRequest, effectivePolicy: ActionPolicy) => Promise<SettingsAnswer>;

/** `shadow` decides as today's loop does and only reports what the floor would have done; `enforce` is the default. */
export type FloorMode = 'shadow' | 'enforce';

export interface GateOptions {
  readonly floorMode?: FloorMode;
}

export interface GateDecision {
  readonly outcome: 'allow' | 'ask' | 'deny';
  readonly rule: string;
  readonly reason?: string;
  /** True when a floor rule decided this call. */
  readonly floor: boolean;
  readonly offerAlwaysAllow: boolean;
  readonly allowGrant: boolean;
  readonly effectiveMode: ActionPolicy['mode'];
  /** What the floor would have done, set only in shadow mode. */
  readonly shadowFloor?: FloorVerdict;
}

/** Where a record goes. `record` must never throw: a record that cannot be kept must not change a decision. */
export interface DecisionSink {
  record(record: DecisionRecord): void;
}

export interface GateRuntime {
  readonly bundleState: () => BundleState;
  readonly sink: DecisionSink;
  readonly actor: ActorRef;
  readonly presence: Presence;
  readonly context: GateContextName;
  readonly floorMode: FloorMode;
}

const NOBODY_HERE = 'Nobody is here to approve this, and it always needs a person: ';

function decision(outcome: GateDecision['outcome'], rule: string, mode: ActionPolicy['mode'], extra: Partial<GateDecision> = {}): GateDecision {
  return { outcome, rule, floor: false, offerAlwaysAllow: false, allowGrant: false, effectiveMode: mode, ...extra };
}

function floorDecision(verdict: FloorVerdict, outcome: 'ask' | 'deny', reason: string, mode: ActionPolicy['mode']): GateDecision {
  return decision(outcome, verdict.rule, mode, { reason, floor: true });
}

export async function decide(request: GateRequest, _bundleState: BundleState, settings: SettingsLayer, _options: GateOptions = {}): Promise<GateDecision> {
  const policy = request.policy;
  const mode = policy.mode;
  if (policy.emergencyStop) return decision('deny', 'settings.emergency-stop', mode, { reason: 'Emergency stop is on.' });
  const verdict = floorFor(request);
  if (verdict !== undefined && verdict.kind === 'refuse') return floorDecision(verdict, 'deny', verdict.reason, mode);
  const answer = await settings(request, policy);
  if (answer.decision === 'deny') return decision('deny', answer.rule, mode, { ...(answer.reason === undefined ? {} : { reason: answer.reason }) });
  if (verdict !== undefined) {
    return request.presence === 'none'
      ? floorDecision(verdict, 'deny', `${NOBODY_HERE}${verdict.reason}`, mode)
      : floorDecision(verdict, 'ask', verdict.reason, mode);
  }
  return decision(answer.decision, answer.rule, mode, {
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    ...(answer.decision === 'ask' ? { offerAlwaysAllow: true, allowGrant: true } : {})
  });
}

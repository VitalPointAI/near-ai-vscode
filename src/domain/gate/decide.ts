// The one decision function (GATE-04, D-08, D-10, D-19, D-43). Pure and asynchronous only because the settings layer is: it is today's
// decidePermissionAsync, handed in as a function, so this file imports nothing from src/agent. The layers run in a fixed order and an earlier layer is never
// undone by a later one: emergency stop, bundle state, floor, bundle ceiling, labels, then the settings layer. A floor refusal has no card and no way
// through; a floor ask is a card with no "always allow" and no run-wide grant; a deny from the settings layer (the deny list) still beats a floor ask.
import type { ActionPolicy, ActionPolicyMode } from '../policy';
import { FAILED_CLOSED_VERBS, POLICY_EVENT_IDS } from './bundle';
import type { BundleState, GateContextName } from './bundle';
import { FLOOR_RULE_ORDER, floorFor } from './floor';
import type { FloorInput, FloorLocations } from './floor';
import type { DecisionRecord, PolicyRecordVersion } from './record';
import { LABEL_EVENT_IDS } from './labels';
import type { Label } from './labels';
import type { LabelSource } from './labelMap';
import { ROUTE_EVENT_IDS, ROUTE_RULES, ROUTE_RULES_NAMED_AHEAD } from './routing';
import type { RoutePolicy } from './routing';

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

/**
 * The label layer's answer, worked out by the caller from the session mark and the clearances (plans 20 and 22): a refusal with its plain reason.
 * `label.mcp-ceiling` is a call to an MCP server whose label ceiling in the policy is below the chat's mark (WP-GATE).
 */
export interface LabelVerdict {
  readonly rule: 'label.dominance' | 'label.no-agent-tools' | 'label.network-at-mark' | 'label.outbound-match' | 'label.mcp-ceiling';
  readonly reason: string;
  /** The label that decided it, for the record; absent when no single label did (a label file that cannot be read). */
  readonly label?: Label;
  /** For label.outbound-match: which of its refusals this is, so the record tells a real match from a check that could not be made (PR #87 review). */
  readonly outboundCause?: OutboundCause;
}

/**
 * Why label.outbound-match refused (D-60, D-72): text it carries was read as labelled (`match`) or is an earlier result of a reopened chat (`earlier`); the
 * run has no fingerprint set (`unchecked`); a labelled read is still open (`pending`); the set is full (`full`); the payload cannot be read (`unreadable`);
 * or the call reads labelled content and may send in the same step (`reads-and-sends`).
 */
export const OUTBOUND_CAUSES = Object.freeze(['match', 'earlier', 'unchecked', 'pending', 'full', 'unreadable', 'reads-and-sends'] as const);
export type OutboundCause = (typeof OUTBOUND_CAUSES)[number];

export interface GateRequest extends FloorInput {
  readonly actor: ActorRef;
  readonly tool: string;
  readonly callId: string;
  readonly context: GateContextName;
  readonly presence: Presence;
  /** The person's own setting; the bundle's ceiling can only lower the mode it names. */
  readonly policy: ActionPolicy;
  /** Today's `tool.sensitive` hook: a reason, set for a protected write or a workspace credential-file read. */
  readonly sensitive?: string;
  /** Today's `tool.risky` hook: a reason, set for a hold after outside content. It asks in every mode and offers no run-wide grant. */
  readonly risky?: string;
  /** The contexts the tool's manifest lists. Absent means the caller did not check a manifest. */
  readonly manifestContexts?: readonly GateContextName[];
  /** The MCP server id, when the tool is an MCP tool. */
  readonly mcpServer?: string;
  readonly labelVerdict?: LabelVerdict;
  /**
   * A refusal the settings layer makes whatever else is true, worked out by the caller before the gate runs: the deny list for a shell command, or a
   * settings answer that is already a deny (an engagement's scope). It is decided before every step that could only ask (unknown effects, the floor's
   * asks, holds, the settings layer's own ask), so a person is never shown a card for a call it refuses (D-10, PR #74 review). The emergency stop, the
   * bundle state and the floor's own refusals still come first.
   */
  readonly settingsRefusal?: { readonly rule: string; readonly reason: string };
  /**
   * The tool's own message when a file tool's path is outside the project and every folder it may use for that call (owner decision after PR #74): the
   * tool would refuse the call, so the gate refuses it as `call.outside-workspace` instead of asking, after the emergency stop, the bundle state, the
   * floor's refusals and a settings refusal.
   */
  readonly outsideWorkspace?: string;
  /**
   * Set, with the plain reason, when the run (or this call) has read a file that may hold credentials and this call can send data off this computer (owner
   * decision after PR #74, D-18): it asks in every mode, fully-autonomous included, with no "always allow" and no grant, and is refused with nobody here.
   */
  readonly credentialHold?: string;
}

export interface SettingsAnswer {
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly reason?: string;
  /** The `settings.*` rule id that decided, from the migration table. */
  readonly rule: string;
}

/** Today's decidePermissionAsync (modes, allow and deny lists, run grants, classifier, safety model, taint holds), handed in so this file stays pure. */
export type SettingsLayer = (request: GateRequest, effectivePolicy: ActionPolicy) => Promise<SettingsAnswer>;

/**
 * What decide() is told besides the request. There is no option that turns the floor off or makes it only report (D-19, GATE-05): the floor applies to every
 * call, in every mode and context, and nothing a caller, a setting or a bundle passes here changes that.
 */
export interface GateOptions {
  /** The home folder and global storage the floor's text checks may name; both optional. */
  readonly locations?: FloorLocations;
}

export interface GateDecision {
  readonly outcome: 'allow' | 'ask' | 'deny';
  readonly rule: string;
  readonly reason?: string;
  /** True when a floor rule decided this call. */
  readonly floor: boolean;
  /** Whether the card may offer "always allow". Never true for a floor rule. */
  readonly offerAlwaysAllow: boolean;
  /** Whether the card may carry a run-wide grant. Never true for a floor rule. */
  readonly allowGrant: boolean;
  readonly effectiveMode: ActionPolicyMode;
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
  /** The person's home folder and this extension's global storage, for the floor's checks of shell commands. The host sets them; a test runtime gives a stand-in or none. */
  readonly locations?: FloorLocations;
  /** What a record needs and the pure domain cannot know. The host sets them; a runtime built for a test may leave them out. */
  readonly productVersion?: string;
  readonly clock?: () => number;
  readonly newRecordId?: () => string;
  /**
   * The labels of a folder the run works in (CLAS-01, CLAS-03): the host gives every runtime the reader it keeps for each root, so a sub-agent in its own
   * worktree reads that worktree's file. Only unavailableGateRuntime and a test runtime that gives none leave it out; a caller then reads the folder's label
   * file trusting no key, so a label it holds only raises (fail closed).
   */
  readonly labels?: (root: string) => LabelSource;
  /**
   * The effective policy's inputs to each model request's route decision (FND-03 to FND-06, D-36), read at the decision from the host that made this
   * runtime, never from a global, with the policy version every record of the request names (D-10). Absent or undefined: decided as the safety patch did.
   */
  readonly routePolicy?: (now: number) => (RoutePolicy & { readonly policyVersion?: PolicyRecordVersion }) | undefined;
  /**
   * The project the run works in (74.1 D-13): its id, which the route policy names, and the facts that raise a request's use (a staff project is
   * operational work, and agent work with the signed exercise attribute). The host sets it for a run in a folder; absent for a window with no folder.
   */
  readonly project?: GateProjectFacts;
}

/** What the gate knows of a run's project (74.1 D-13). */
export interface GateProjectFacts {
  readonly id: string;
  /** `staff` for a staff project; absent for any other. */
  readonly kind?: string;
  /** The project's signed exercise attribute (a staff project at agent work instead of operational work). */
  readonly exercise?: boolean;
}

/**
 * The rules of a call refused before the gate could be asked, which the loop still records so no refused call is missing from the log: a tool name the run
 * does not have, a tool's own check (its forbidden, sensitive, risky or preview hook) that threw, so the call could not be judged and did not run, and
 * arguments that could not be read (not JSON, not an object, or refused by the tool), so nothing could be judged either.
 */
export const PRE_GATE_RULES = Object.freeze(['call.unknown-tool', 'call.check-failed', 'call.bad-arguments'] as const);
export type PreGateRule = (typeof PRE_GATE_RULES)[number];

/** A call that can send data off this computer after the run read a file that may hold credentials (GateRequest.credentialHold). */
export const CREDENTIAL_HOLD_RULE = 'taint.credential-read';

/** A file tool's path outside the project and every folder the tool may use: the tool would refuse it, so the gate does, with no card. */
export const OUTSIDE_WORKSPACE_RULE = 'call.outside-workspace';

/** Every rule id the gate can record: the floor, the bundle and manifest checks, labels, routing, taint, the settings rules of the migration table, and the calls refused before the gate. */
export const GATE_RULE_IDS: readonly string[] = Object.freeze([
  ...FLOOR_RULE_ORDER,
  'bundle.failed-closed', 'bundle.unavailable', 'bundle.ceiling.context', 'bundle.ceiling.mode', 'bundle.ceiling.unattended-mcp', 'manifest.context', 'manifest.effects-unknown',
  'label.dominance', 'label.no-agent-tools', 'label.network-at-mark', 'label.outbound-match', 'label.mcp-ceiling',
  ...ROUTE_RULES,
  'taint.held', CREDENTIAL_HOLD_RULE,
  'settings.emergency-stop', 'settings.read-plan', 'settings.auto-safe-tool', 'settings.mode.edits', 'settings.run-grant.edits', 'settings.deny-list',
  'settings.engagement-grant', 'settings.run-grant.command', 'settings.allow-rule', 'settings.mode.fully-autonomous', 'settings.mode.other',
  'settings.auto.classifier', 'settings.unattended-verification', 'settings.risk.outside-workspace', 'settings.risk.installs', 'settings.safety-model',
  'settings.sensitive-read', 'settings.mcp-approval', 'settings.tool-forbidden',
  ...PRE_GATE_RULES, OUTSIDE_WORKSPACE_RULE
]);

/**
 * The rule a record carries when the one it was given is not known (PR #74 review round 11): the record is kept, with the id it was given beside it in
 * `unmapped.nearAi.unknownRule`, so no decision is ever missing from the log. In a test run the gate's test helper makes it fail the test instead.
 */
export const RECORD_UNKNOWN_RULE = 'record.unknown-rule';

/**
 * Every id a decision record may carry as its rule (`authorizations[].policy.name`): the gate's rules, the policy's own events, the label events, the route
 * events, and RECORD_UNKNOWN_RULE. validateDecisionRecord refuses any other, and the builder and the decision log put an unknown one under
 * RECORD_UNKNOWN_RULE, so none is ever dropped. Every event part 4 writes is on a list from 0.4.30 on (D-49), so a later PR rolled back never leaves a record
 * this version cannot name.
 */
export const RECORD_RULE_IDS: readonly string[] = Object.freeze([
  // Phase 41 (D-51): the route rules named ahead join here, not GATE_RULE_IDS, so a record may carry them before decideRoute returns them.
  ...GATE_RULE_IDS, ...POLICY_EVENT_IDS, ...LABEL_EVENT_IDS, ...ROUTE_EVENT_IDS, ...ROUTE_RULES_NAMED_AHEAD, RECORD_UNKNOWN_RULE
]);

const MODE_ORDER: readonly ActionPolicyMode[] = Object.freeze(['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const);
const NOBODY_HERE = 'Nobody is here to approve this, and it always needs a person: ';
const MAX_SHOWN = 80;

/** The lower of the person's setting and the bundle's ceiling for the context, in the order approve-risky, mostly-autonomous, auto, fully-autonomous. A mode this list does not know counts as the lowest. */
export function effectiveMode(settingMode: ActionPolicyMode, ceilingMode: ActionPolicyMode): ActionPolicyMode {
  const setting = MODE_ORDER.indexOf(settingMode);
  const ceiling = MODE_ORDER.indexOf(ceilingMode);
  if (setting < 0 || ceiling < 0) return 'approve-risky';
  return setting <= ceiling ? settingMode : ceilingMode;
}

function shown(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, MAX_SHOWN);
}

function ownList<T>(table: Readonly<Partial<Record<string, readonly T[]>>>, key: string): readonly T[] | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

type Extra = Partial<Pick<GateDecision, 'reason' | 'floor' | 'offerAlwaysAllow' | 'allowGrant'>>;

function make(outcome: GateDecision['outcome'], rule: string, mode: ActionPolicyMode, extra: Extra = {}): GateDecision {
  return { outcome, rule, floor: false, offerAlwaysAllow: false, allowGrant: false, effectiveMode: mode, ...extra };
}

/** The ceiling checks of a valid bundle: the verb in this context, the manifest's contexts, and an MCP server outside the person's own chat. */
function ceilingRefusal(request: GateRequest, bundleState: Extract<BundleState, { state: 'valid' }>): { rule: string; reason: string } | undefined {
  const ceiling = bundleState.bundle.ceiling;
  for (const effect of request.effects) {
    const allowedIn = ownList<GateContextName>(ceiling.contexts, effect.verb);
    if (allowedIn === undefined || !allowedIn.includes(request.context)) {
      return { rule: 'bundle.ceiling.context', reason: `Your policy does not allow this kind of action (${effect.verb}) in this kind of run (${request.context}).` };
    }
  }
  if (request.manifestContexts !== undefined && !request.manifestContexts.includes(request.context)) {
    return { rule: 'manifest.context', reason: `${shown(request.tool)} is not set up to run in this kind of run (${request.context}).` };
  }
  if (request.context !== 'interactive') {
    const servers = [...(request.mcpServer === undefined ? [] : [request.mcpServer]), ...request.effects.flatMap((effect) => (effect.verb === 'mcp' ? [effect.server] : []))];
    const outside = servers.find((server) => !ceiling.unattendedMcp.includes(server));
    if (outside !== undefined) {
      return { rule: 'bundle.ceiling.unattended-mcp', reason: `The server "${shown(outside)}" is not on your policy's list of servers that may run when you are not there.` };
    }
  }
  return undefined;
}

/**
 * The one decision (GATE-04). `bundleState` is what the caller last verified; `settings` is today's permission logic. The floor is always enforced (D-19):
 * a floor refusal has no card, and a floor ask has no "always allow" and no run-wide grant, in every mode, fully-autonomous included.
 * Order: emergency stop, bundle state, unknown effects (after the floor's refusals of what such a call names, a label verdict and a settings refusal on the request), the
 * floor's refusals, bundle ceiling, labels, a settings refusal on the request, settings layer, the floor's asks. A refusal from an earlier layer is never undone by a later one, and
 * a deny from the settings layer (the deny list) still beats a floor ask.
 */
export async function decide(request: GateRequest, bundleState: BundleState, settings: SettingsLayer, options: GateOptions = {}): Promise<GateDecision> {
  const policy = request.policy;
  if (policy.emergencyStop) return make('deny', 'settings.emergency-stop', policy.mode, { reason: 'Emergency stop is on.' });
  if (bundleState.state === 'failed-closed') {
    const onlyReadOrPlan = request.effects.length > 0 && request.effects.every((effect) => (FAILED_CLOSED_VERBS as readonly string[]).includes(effect.verb));
    // A run built with no host at all (no policy was ever read for it) has its own rule id, so a record tells it apart from a policy that failed to verify.
    if (!onlyReadOrPlan) {
      // Both refuse; a refusal the person's own settings already made (the deny list) is the one named, as it is everywhere else (D-10).
      if (request.settingsRefusal !== undefined) return make('deny', request.settingsRefusal.rule, 'approve-risky', { reason: request.settingsRefusal.reason });
      return make('deny', bundleState.reason === 'unavailable' ? 'bundle.unavailable' : 'bundle.failed-closed', 'approve-risky', { reason: bundleState.sentence });
    }
  }
  // A request that names no effect is a request whose effects are unknown. Nothing later can judge what it does, so it never reaches the floor's asks, the
  // ceiling or the settings layer (which would read "no effects" as "nothing to worry about"): with a person here it asks, without one it is refused. A
  // failed-closed bundle has already refused it above with its own sentence, so no answer can get past that.
  if (request.effects.length === 0) {
    // What the call itself names is still read: a path or command that reaches a credential store or the identity folders is refused with no card, not
    // asked about. (The loop's own `forbidden` refusal is the loop's, and it refuses that call itself.)
    const named = floorFor({ effects: [], ...(request.command === undefined ? {} : { command: request.command }), ...(request.floorFacts === undefined ? {} : { floorFacts: request.floorFacts }), ...(request.workspace === undefined ? {} : { workspace: request.workspace }) }, options.locations);
    if (named !== undefined && named.kind === 'refuse') return make('deny', named.rule, 'approve-risky', { reason: named.reason, floor: true });
    // The deny list decides before a person is asked about effects nobody can read (D-10): a denied command is never put in front of a person.
    // A label the caller found on what the call names refuses it here, before anyone is asked (D-53): a command nobody can read that names a file above
    // your clearance is refused, not put on a card.
    if (request.labelVerdict !== undefined) return make('deny', request.labelVerdict.rule, 'approve-risky', { reason: request.labelVerdict.reason });
    if (request.settingsRefusal !== undefined) return make('deny', request.settingsRefusal.rule, 'approve-risky', { reason: request.settingsRefusal.reason });
    // A path the tool itself would refuse is refused here, with the tool's own words, rather than shown on a card that could only end in that refusal.
    if (request.outsideWorkspace !== undefined) return make('deny', OUTSIDE_WORKSPACE_RULE, 'approve-risky', { reason: request.outsideWorkspace });
    const person = request.presence === 'person' && request.context === 'interactive';
    return person
      ? make('ask', 'manifest.effects-unknown', 'approve-risky', { reason: `SovAI cannot tell what ${shown(request.tool)} would do with this call, so it needs your answer.` })
      : make('deny', 'manifest.effects-unknown', 'approve-risky', { reason: `SovAI cannot tell what ${shown(request.tool)} would do with this call, and nobody is here to answer, so it is refused.` });
  }
  const mode: ActionPolicyMode = bundleState.state === 'valid' ? effectiveMode(policy.mode, bundleState.bundle.ceiling.maxMode[request.context]) : 'approve-risky';
  const verdict = floorFor(request, options.locations);
  if (verdict !== undefined && verdict.kind === 'refuse') return make('deny', verdict.rule, mode, { reason: verdict.reason, floor: true });
  if (bundleState.state === 'valid') {
    const refusal = ceilingRefusal(request, bundleState);
    if (refusal !== undefined) return make('deny', refusal.rule, mode, { reason: refusal.reason });
  }
  if (request.labelVerdict !== undefined) return make('deny', request.labelVerdict.rule, mode, { reason: request.labelVerdict.reason });
  // A refusal the settings layer has already made decides here, before every ask below, whatever the layer would answer now (D-10).
  if (request.settingsRefusal !== undefined) return make('deny', request.settingsRefusal.rule, mode, { reason: request.settingsRefusal.reason });
  if (request.outsideWorkspace !== undefined) return make('deny', OUTSIDE_WORKSPACE_RULE, mode, { reason: request.outsideWorkspace });
  const answer = await settings(request, { ...policy, mode });
  if (answer.decision === 'deny') return make('deny', answer.rule, mode, answer.reason === undefined ? {} : { reason: answer.reason });
  if (verdict !== undefined && verdict.kind === 'ask') {
    // No person to answer means no way through: a floor ask is refused, never approved by default (D-43).
    return request.presence === 'none'
      ? make('deny', verdict.rule, mode, { reason: `${NOBODY_HERE}${verdict.reason}`, floor: true })
      : make('ask', verdict.rule, mode, { reason: verdict.reason, floor: true });
  }
  // After a credential read, a call that can send data out asks in every mode with no shortcut, and with nobody here it is refused (D-18, after PR #74).
  if (request.credentialHold !== undefined && request.credentialHold !== '') {
    return request.presence === 'none'
      ? make('deny', CREDENTIAL_HOLD_RULE, mode, { reason: `${NOBODY_HERE}${request.credentialHold}` })
      : make('ask', CREDENTIAL_HOLD_RULE, mode, { reason: request.credentialHold });
  }
  // Today's loop, line 631: a held action asks in every mode and offers no run-wide grant; a sensitive call that would be allowed asks unless the mode is
  // fully-autonomous. A protected write never gets here (the floor asked above), so in fully-autonomous only a workspace credential-file read, such as
  // `.env`, runs without asking (D-18, D-19).
  if (request.risky !== undefined && request.risky !== '') {
    return make('ask', 'taint.held', mode, { reason: request.risky, offerAlwaysAllow: true });
  }
  if (request.sensitive !== undefined && request.sensitive !== '' && answer.decision === 'allow' && mode !== 'fully-autonomous') {
    return make('ask', 'settings.sensitive-read', mode, { reason: request.sensitive, offerAlwaysAllow: true, allowGrant: true });
  }
  const capped = mode !== policy.mode && answer.decision === 'ask' && answer.rule.startsWith('settings.mode.');
  return make(answer.decision, capped ? 'bundle.ceiling.mode' : answer.rule, mode, {
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    ...(answer.decision === 'ask' ? { offerAlwaysAllow: true, allowGrant: true } : {})
  });
}

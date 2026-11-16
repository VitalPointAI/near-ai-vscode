// The loop's side of the one gate (GATE-04, D-08, D-09, D-10, D-43). It builds a GateRequest from a tool call (the manifest's effects and today's forbidden,
// sensitive and risky hooks), hands today's decidePermissionAsync to decide() as its settings layer, and records the decision. It decides nothing itself, so
// with a valid bundle and the shadow floor every outcome equals what the loop decided before. No vscode import here.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ActionCapability, ActionPolicy } from '../domain/policy';
import { bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { ActorRef, GateDecision, GateRequest, GateRuntime, SettingsAnswer, SettingsLayer } from '../domain/gate/decide';
import { effectsFor } from '../domain/gate/manifest';
import type { InputFieldSource } from '../domain/gate/manifest';
import { buildDecisionRecord, outcomeOf } from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord, DecisionResource } from '../domain/gate/record';
import { fromActionCapability } from '../domain/gate/vocabulary';
import type { Capability } from '../domain/gate/vocabulary';
import { classifyCommand, downloadSegments } from './commandSafety';
import { decidePermissionAsync, isAutoAllowed } from './permissions';
import type { AutoApprovalContext, PermissionDecision, PermissionRules, RunGrants } from './permissions';
import type { AgentTool } from './tools';

const DEFAULT_PRODUCT_VERSION = '0.0.0';
const MAX_RESOURCE_NAME = 200;
const DEVICE_UNKNOWN = 'device-unknown';

export interface GateCallInput {
  readonly tool: AgentTool<any>;
  /** The model's own arguments, before the tool parsed them: the manifest names these fields, not the parsed ones. */
  readonly raw: Record<string, unknown>;
  /** The folder this call works in (a sub-agent in its own worktree has its own). */
  readonly root: string;
  readonly callId: string;
  readonly command?: string;
  /** Today's three hooks, already evaluated by the loop. */
  readonly forbidden?: string;
  readonly sensitive?: string;
  readonly risky?: string;
  /** The live policy object: a later check sees an emergency stop switched on after the card was shown. */
  readonly policy: ActionPolicy;
  readonly rules: PermissionRules;
  readonly grants: RunGrants;
  /** Builds the context auto approve needs for the mode the settings layer is asked with, or none when that mode needs none. */
  readonly buildAuto: (policy: ActionPolicy) => Promise<AutoApprovalContext | undefined>;
}

/** One decided call: the decision, what today's settings layer said (when it was asked), and what is needed to record the person's answer. */
export interface GatedCall {
  readonly decision: GateDecision;
  /** Today's decidePermissionAsync answer, set when the settings layer ran. The card keeps showing its reason, as it always has. */
  readonly settings: PermissionDecision | undefined;
  readonly request: GateRequest;
  readonly effects: readonly Capability[];
}

function productVersionOf(runtime: GateRuntime): string {
  return runtime.productVersion ?? DEFAULT_PRODUCT_VERSION;
}

function bundleHashOf(state: BundleState): string {
  return state.state === 'valid' ? state.hash : '';
}

const WIDEST_SHORTHAND = (capability: ActionCapability): readonly Capability[] => fromActionCapability(capability).capabilities;

/** The names of the arguments a manifest reads as project paths. */
function pathFields(tool: AgentTool<any>): string[] {
  const names = new Set<string>();
  const take = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const source = value as Partial<InputFieldSource>;
    if (source.from === 'input' && source.as === 'path' && typeof source.field === 'string') names.add(source.field);
  };
  for (const entry of tool.manifest.effects) {
    if ('from' in entry) continue;
    for (const key of Object.keys(entry)) {
      const value: unknown = entry[key];
      if (Array.isArray(value)) value.forEach(take);
      else take(value);
    }
  }
  return [...names];
}

/**
 * The model's arguments as the manifest reads them: the tool's own defaults written out, and an absolute path that lies inside the folder this call works
 * in written relative to it (a manifest names project paths, and models often send the full path). A path outside the folder stays as it is and is refused
 * by the vocabulary, which is what "effects unknown" means.
 */
export function manifestArguments(tool: AgentTool<any>, raw: Record<string, unknown>, root: string): Record<string, unknown> {
  const given = tool.manifestInput?.(raw) ?? raw;
  let out: Record<string, unknown> | undefined;
  for (const field of pathFields(tool)) {
    const value = given[field];
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const relative = path.relative(root, value);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
    out ??= { ...given };
    out[field] = relative === '' ? '**' : relative.split(path.sep).join('/');
  }
  return out ?? given;
}

/**
 * The call's effects. A call the manifest cannot fill (a path outside the project, a missing field) has unknown effects. While the floor only reports (shadow),
 * the widest form of the tool's own shorthand stands in, so today's decision is kept; once the floor is enforced the list is empty and decide() refuses or asks
 * with `manifest.effects-unknown`.
 */
export function effectsOfCall(runtime: Pick<GateRuntime, 'floorMode'>, tool: AgentTool<any>, raw: Record<string, unknown>, root: string): readonly Capability[] {
  const filled = effectsFor(tool.manifest, manifestArguments(tool, raw, root));
  if (filled.ok) return filled.value;
  return runtime.floorMode === 'enforce' ? [] : WIDEST_SHORTHAND(tool.capability);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The settings layer: today's decidePermissionAsync, with a stable rule id for what it answered.
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface RuleFacts {
  readonly tool: AgentTool<any>;
  readonly command: string | undefined;
  readonly policy: ActionPolicy;
  readonly rules: PermissionRules;
  readonly grants: RunGrants;
  readonly auto: AutoApprovalContext | undefined;
  readonly decided: PermissionDecision;
}

function allowList(facts: RuleFacts): string[] {
  return [...facts.rules.allowCommands, ...facts.grants.allowRules];
}

function shellRule(facts: RuleFacts): string {
  const { command, policy, grants, auto, decided } = facts;
  if (decided.decision === 'deny') return 'settings.deny-list';
  if (decided.decision === 'ask' && grants.tainted && downloadSegments(command ?? '').length > 0) return 'taint.held';
  if (grants.commands.has((command ?? '').trim())) return 'settings.run-grant.command';
  if (isAutoAllowed(command ?? '', allowList(facts))) return 'settings.allow-rule';
  if (policy.mode === 'fully-autonomous') return 'settings.mode.fully-autonomous';
  if (policy.mode === 'auto' || (policy.mode === 'mostly-autonomous' && auto?.unattended !== undefined)) {
    if (decided.decision === 'ask') return policy.mode === 'auto' ? 'settings.auto.classifier' : 'settings.mode.other';
    if (policy.mode === 'auto' && auto !== undefined) {
      const safe = classifyCommand(command ?? '', { ...auto, isAllowListed: (part: string) => isAutoAllowed(part, allowList(facts)) }).verdict === 'safe';
      if (safe) return 'settings.auto.classifier';
    }
    return auto?.unattended !== undefined ? 'settings.unattended-verification' : 'settings.safety-model';
  }
  return 'settings.mode.other';
}

/** The stable rule id for what decidePermissionAsync answered, found by asking the same questions again about the inputs, never by reading its reason text. */
export function settingsRuleFor(facts: RuleFacts): string {
  const { tool, policy, grants, auto, decided } = facts;
  const capability = tool.capability;
  if (policy.emergencyStop) return 'settings.emergency-stop';
  if (capability === 'read' || capability === 'plan') return 'settings.read-plan';
  if (capability === 'network' && policy.mode === 'auto' && auto?.autoSafeTool === true) return 'settings.auto-safe-tool';
  if (capability === 'workspaceWrite') return grants.edits ? 'settings.run-grant.edits' : 'settings.mode.edits';
  if (capability === 'shell') return shellRule(facts);
  if (decided.decision === 'allow') return 'settings.mode.fully-autonomous';
  const isMcp = tool.manifest.effects.some((entry) => !('from' in entry) && entry.verb === 'mcp');
  return isMcp ? 'settings.mcp-approval' : 'settings.mode.other';
}

/**
 * Today's loop line 631 on top of decidePermissionAsync, as the gate's settings layer. The held (risky) and sensitive asks are decided by decide() itself, so
 * this returns only what decidePermissionAsync said. `captured` is set to that answer so the card keeps its reason.
 */
export function settingsLayerFor(input: Pick<GateCallInput, 'tool' | 'command' | 'rules' | 'grants' | 'buildAuto'>, captured: { value?: PermissionDecision }): SettingsLayer {
  return async (request: GateRequest, effectivePolicy: ActionPolicy): Promise<SettingsAnswer> => {
    const auto = await input.buildAuto(effectivePolicy);
    const decided = await decidePermissionAsync(input.tool.capability, input.command, effectivePolicy, input.rules, input.grants, auto);
    captured.value = decided;
    const rule = settingsRuleFor({ tool: input.tool, command: input.command, policy: effectivePolicy, rules: input.rules, grants: input.grants, auto, decided });
    return { decision: decided.decision, ...(decided.reason === undefined ? {} : { reason: decided.reason }), rule };
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------------------------------------------

function shownName(text: string): string {
  const flat = text.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return flat.length > MAX_RESOURCE_NAME ? flat.slice(0, MAX_RESOURCE_NAME) : flat;
}

/** What the call touched, for the record: a path, a host, a server, or the command's first line. Names only, never contents. */
function resourceOf(tool: string, effects: readonly Capability[], command: string | undefined): DecisionResource {
  if (command !== undefined && command !== '') return { name: shownName(command.split('\n')[0] ?? command), type: 'command' };
  const effect = effects[0];
  if (effect === undefined) return { name: shownName(tool), type: 'tool' };
  switch (effect.verb) {
    case 'read':
    case 'workspaceWrite':
    case 'destroy':
      return { name: shownName(effect.paths[0] ?? tool), type: 'file' };
    case 'network':
      return { name: shownName(effect.hosts[0] ?? tool), type: 'host' };
    case 'mcp':
      return { name: shownName(effect.server), type: 'mcp-server' };
    case 'spawn':
      return { name: shownName(effect.agent), type: 'agent' };
    default:
      return { name: shownName(tool), type: 'tool' };
  }
}

function recordFor(runtime: GateRuntime, gated: GatedCall, outcome: DecisionOutcome, rule: string, reason: string | undefined, model: { name: string; provider: string } | undefined): DecisionRecord {
  const capability = gated.effects[0] ?? WIDEST_SHORTHAND('plan')[0] as Capability;
  const decision = gated.decision;
  return buildDecisionRecord({
    recordId: (runtime.newRecordId ?? randomUUID)(),
    // The log numbers each line as it writes it; this is replaced there.
    sequence: 0,
    time: (runtime.clock ?? Date.now)(),
    productVersion: productVersionOf(runtime),
    actor: runtime.actor,
    ...(model === undefined ? {} : { model }),
    callId: gated.request.callId,
    capability,
    resource: resourceOf(gated.request.tool, gated.effects, gated.request.command),
    outcome,
    rule,
    ...(reason === undefined || reason === '' ? {} : { reason }),
    bundleHash: bundleHashOf(runtime.bundleState()),
    ...(decision.shadowFloor === undefined ? {} : { shadowFloor: decision.shadowFloor.rule })
  });
}

function keep(runtime: GateRuntime, record: DecisionRecord): void {
  try {
    runtime.sink.record(record);
  } catch {
    // A record that cannot be kept never changes a decision (D-21).
  }
}

/** Models named in records: the name the run uses, and NEAR AI as the provider. */
const MODEL_PROVIDER = 'NEAR AI';

export interface GateCallOptions { readonly model?: string }

/**
 * Decides one tool call (GATE-04). Builds the request, runs decide() with today's settings layer, records the decision (one line, in the order calls are
 * decided) and returns it. The record is queued before this returns, so it is always ahead of the call's own run.
 */
export async function gateToolCall(runtime: GateRuntime, input: GateCallInput, options: GateCallOptions = {}): Promise<GatedCall> {
  const effects = effectsOfCall(runtime, input.tool, input.raw, input.root);
  const request: GateRequest = {
    actor: runtime.actor,
    tool: input.tool.name,
    callId: input.callId,
    effects,
    context: runtime.context,
    presence: runtime.presence,
    policy: input.policy,
    manifestContexts: input.tool.manifest.contexts,
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.forbidden === undefined || input.forbidden === '' ? {} : { forbidden: input.forbidden }),
    ...(input.sensitive === undefined || input.sensitive === '' ? {} : { sensitive: input.sensitive }),
    ...(input.risky === undefined || input.risky === '' ? {} : { risky: input.risky }),
    ...(input.tool.capability === 'sharedWrite' ? { floorFacts: { sharedWrite: true } } : {})
  };
  const captured: { value?: PermissionDecision } = {};
  const decision = await decide(request, runtime.bundleState(), settingsLayerFor(input, captured), { floorMode: runtime.floorMode });
  const gated: GatedCall = { decision, settings: captured.value, request, effects };
  keep(runtime, recordFor(runtime, gated, outcomeOf(decision), decision.rule, decision.reason, options.model === undefined ? undefined : { name: options.model, provider: MODEL_PROVIDER }));
  return gated;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The default runtime
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The records a default runtime kept, so a test can read them. */
export interface MemoryGateRuntime extends GateRuntime {
  readonly records: DecisionRecord[];
}

const DEFAULT_ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: DEVICE_UNKNOWN, sessionId: 'default-session' };

let defaultState: BundleState | undefined;

function shippedDefaultState(): BundleState {
  if (defaultState === undefined) {
    const issuer = { fingerprint: DEVICE_UNKNOWN, publicKey: 'A'.repeat(43) };
    const payload = defaultBundlePayload({ issuer, now: Date.now() });
    defaultState = { state: 'valid', bundle: payload, hash: bundleHash(payload), signer: issuer, expiresAt: payload.expiresAt, renewDue: false };
  }
  return defaultState;
}

/**
 * The runtime a run gets when its creator gave none (Pitfall 1): the shipped default bundle, the floor in shadow, and an in-memory sink. It is the same
 * policy as a fresh install's own bundle, so a run built without a gate decides exactly as it did before the gate existed.
 */
export function defaultGateRuntime(options: { presence?: GateRuntime['presence']; context?: GateRuntime['context']; actor?: ActorRef } = {}): MemoryGateRuntime {
  const records: DecisionRecord[] = [];
  return {
    bundleState: shippedDefaultState,
    sink: { record: (record) => { records.push(record); } },
    actor: options.actor ?? DEFAULT_ACTOR,
    presence: options.presence ?? 'person',
    context: options.context ?? 'interactive',
    floorMode: 'shadow',
    records
  };
}

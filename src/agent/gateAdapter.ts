// The loop's side of the one gate (GATE-04, D-08, D-09, D-10, D-43). It builds a GateRequest from a tool call (the manifest's effects and today's forbidden,
// sensitive and risky hooks), hands today's decidePermissionAsync to decide() as its settings layer, and records the decision. It decides nothing itself, so
// with a valid bundle and the shadow floor every outcome equals what the loop decided before. No vscode import here.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ActionCapability, ActionPolicy } from '../domain/policy';
import { failedClosed } from '../domain/gate/bundle';
import type { BundleState, GateContextName } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { ActorRef, GateDecision, GateRequest, GateRuntime, SettingsAnswer, SettingsLayer } from '../domain/gate/decide';
import { effectsFor } from '../domain/gate/manifest';
import type { InputFieldSource } from '../domain/gate/manifest';
import { buildDecisionRecord, outcomeOf } from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord, DecisionResource } from '../domain/gate/record';
import { fromActionCapability } from '../domain/gate/vocabulary';
import type { Capability } from '../domain/gate/vocabulary';
import { classifyCommand, downloadSegments } from './commandSafety';
import type { CommandEffect } from './commandSafety';
import { decidePermissionAsync, isAutoAllowed } from './permissions';
import type { AutoApprovalContext, PermissionDecision, PermissionRules, RunGrants } from './permissions';
import type { AgentTool } from './tools';

const DEFAULT_PRODUCT_VERSION = '0.0.0';
const MAX_RESOURCE_NAME = 200;
const DEVICE_UNKNOWN = 'device-unknown';

/** What a card's reply can be, as the loop's own ApprovalReply names it (kept here so this file imports nothing from the loop). */
export interface GateReply { readonly decision: 'allow' | 'allow-run' | 'allow-always' | 'deny' | 'pending' }

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
  /**
   * Where a shell command runs, for the floor's own look at it (Pitfall 5). The loop builds it for every shell call in every mode, fully-autonomous
   * included, with the package scripts read once per run. Absent, the command is read as running at `root` with no scripts.
   */
  readonly shell?: FloorShellContext;
}

/** The cheap part of the classifier's context the floor needs: no safety model, no Open-GSD runtime check, nothing that asks a person. */
export interface FloorShellContext {
  /** The shell's folder when the command runs (absolute). */
  readonly cwd: string;
  /** The project's package.json scripts, so `npm run x` is read as what x runs. */
  readonly packageScripts?: Readonly<Record<string, string>>;
  /** The managed Open-GSD runtime's folders, whose gsd-tools verbs the classifier reads. */
  readonly trustedRoots?: readonly string[];
  /** The Open-GSD preambles the runtime ships, so what follows one is read as a command. */
  readonly gsdPreambles?: readonly string[];
}

export interface FloorFactsInput extends Partial<FloorShellContext> {
  readonly command: string;
  /** The folder this call works in. */
  readonly root: string;
  /** The person's home folder, for `~`. */
  readonly home?: string;
}

/** What the floor learns from a shell command's text: the effects the classifier tagged. */
export interface FloorCommandFacts {
  readonly effects: readonly CommandEffect[];
}

/**
 * The floor's own reading of a shell command (GATE-05, Pitfall 5): the classifier run with a cheap context of its own, so the floor sees what a command
 * publishes, destroys or writes in every mode, including the ones that never build auto approve's context. It only reads the command's text; it runs nothing.
 */
export async function floorFactsFor(input: FloorFactsInput): Promise<FloorCommandFacts> {
  if (input.command.trim() === '') return { effects: [] };
  let classified: ReturnType<typeof classifyCommand>;
  try {
    classified = classifyCommand(input.command, {
      root: input.root,
      cwd: input.cwd ?? input.root,
      ...(input.home === undefined ? {} : { home: input.home }),
      ...(input.packageScripts === undefined ? {} : { packageScripts: { ...input.packageScripts } }),
      ...(input.trustedRoots === undefined ? {} : { trustedToolRoots: [...input.trustedRoots] }),
      ...(input.gsdPreambles === undefined ? {} : { gsdPreambles: [...input.gsdPreambles] })
    });
  } catch {
    return { effects: [] }; // the classifier is pure and should never throw; if it does, the call is decided on its manifest alone
  }
  return { effects: classified.effects ?? [] };
}

/** The manifest's effects with the command's own after them, each once. Unknown effects (an empty list) stay unknown: the command cannot make them known. */
function withCommandEffects(effects: readonly Capability[], extra: readonly Capability[]): readonly Capability[] {
  if (effects.length === 0 || extra.length === 0) return effects;
  const seen = new Set(effects.map((effect) => JSON.stringify(effect)));
  const out = [...effects];
  for (const effect of extra) {
    const key = JSON.stringify(effect);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(effect);
  }
  return out;
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

function bundleHashOf(runtime: GateRuntime): string {
  try {
    const state: BundleState = runtime.bundleState();
    return state.state === 'valid' ? state.hash : '';
  } catch {
    return ''; // a state that cannot be read never keeps a record from being written
  }
}

const WIDEST_SHORTHAND = (capability: ActionCapability): readonly Capability[] => fromActionCapability(capability).capabilities;

/** The names of the arguments a manifest reads as project paths. */
function pathFields(tool: AgentTool<any>): string[] {
  const names = new Set<string>();
  const take = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const source = value as Partial<InputFieldSource>;
    if (source.from === 'input' && (source.as === 'path' || source.as === 'folder') && typeof source.field === 'string') names.add(source.field);
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
    bundleHash: bundleHashOf(runtime),
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

/** The rule id of a call the loop refuses because the tool's own `forbidden` hook named it (the key folder today). */
export const TOOL_FORBIDDEN_RULE = 'settings.tool-forbidden';

/** A refusal the caller makes itself, whatever the gate would have said: its rule id (one of GATE_RULE_IDS) and the plain reason it gives the person. */
export interface Refusal { readonly rule: string; readonly reason: string }

export interface GateCallOptions {
  readonly model?: string;
  /**
   * Set when the caller refuses the call itself (the loop's `forbidden` hook, an engagement's scope). The gate is still asked, so a layer that outranks the
   * caller (emergency stop, bundle state, the floor) records its own, more specific rule, but the record is always `denied`, never `allowed` or `asked`: a
   * call that did not run is never on record as one that could (PR #70 third review).
   */
  readonly refusal?: Refusal;
}

/** The settings layer of a call the caller refuses: today's permission logic is not asked (it could run a classifier or a model about a call that will not run). */
function refusalLayer(refusal: Refusal): SettingsLayer {
  return async (): Promise<SettingsAnswer> => ({ decision: 'deny', reason: refusal.reason, rule: refusal.rule });
}

/** The gate's decision for a call the caller refuses: its own deny when it made one, otherwise the caller's refusal. Never an allow or an ask. */
function refusedDecision(decision: GateDecision | undefined, refusal: Refusal, mode: ActionPolicy['mode']): GateDecision {
  if (decision !== undefined && decision.outcome === 'deny') return decision;
  return { outcome: 'deny', rule: refusal.rule, reason: refusal.reason, floor: false, offerAlwaysAllow: false, allowGrant: false, effectiveMode: decision?.effectiveMode ?? mode, ...(decision?.shadowFloor === undefined ? {} : { shadowFloor: decision.shadowFloor }) };
}

async function decideOrRefuse(refusal: Refusal | undefined, mode: ActionPolicy['mode'], run: () => Promise<GateDecision>): Promise<GateDecision> {
  if (refusal === undefined) return run();
  let decided: GateDecision | undefined;
  try {
    decided = await run();
  } catch {
    decided = undefined; // the gate could not be asked, and the refusal stands on its own
  }
  return refusedDecision(decided, refusal, mode);
}

/**
 * Decides one tool call (GATE-04). Builds the request, runs decide() with today's settings layer, records the decision (one line, in the order calls are
 * decided) and returns it. The record is queued before this returns, so it is always ahead of the call's own run.
 */
export async function gateToolCall(runtime: GateRuntime, input: GateCallInput, options: GateCallOptions = {}): Promise<GatedCall> {
  const declared = effectsOfCall(runtime, input.tool, input.raw, input.root);
  // A shell call's command is read by the floor in every mode (Pitfall 5); what it tags joins the manifest's own effects.
  const floorFacts = input.command === undefined ? undefined : await floorFactsFor({ command: input.command, root: input.root, ...(input.shell ?? {}) });
  const effects = withCommandEffects(declared, floorFacts?.effects ?? []);
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
  const layer = options.refusal === undefined ? settingsLayerFor(input, captured) : refusalLayer(options.refusal);
  const decision = await decideOrRefuse(options.refusal, input.policy.mode, () => decide(request, runtime.bundleState(), layer, { floorMode: runtime.floorMode }));
  const gated: GatedCall = { decision, settings: captured.value, request, effects };
  keep(runtime, recordFor(runtime, gated, outcomeOf(decision), decision.rule, decision.reason, options.model === undefined ? undefined : { name: options.model, provider: MODEL_PROVIDER }));
  return gated;
}

/**
 * A step decided by a caller that has already worked out what today's settings layer says (the cyber panel's step engine, whose permission path is
 * decidePermission with the engagement grant). The settings answer is handed in whole, so the gate decides on top of it exactly as it does for a chat call.
 */
export interface GateStepInput {
  readonly tool: string;
  readonly callId: string;
  /** What the step does. An empty list means unknown, which decide() asks about or refuses. */
  readonly effects: readonly Capability[];
  readonly command?: string;
  readonly manifestContexts?: readonly GateContextName[];
  readonly policy: ActionPolicy;
  /** Today's answer for this step, with the stable rule id that gave it. */
  readonly settings: SettingsAnswer;
}

/** The effects of a step that runs a tool: its manifest's, filled from the arguments, or `standIn` while the floor only reports. Empty once it is enforced. */
export function effectsOfStep(runtime: Pick<GateRuntime, 'floorMode'>, tool: AgentTool<any>, raw: Record<string, unknown>, root: string, standIn: readonly Capability[]): readonly Capability[] {
  const filled = effectsFor(tool.manifest, manifestArguments(tool, raw, root));
  if (filled.ok) return filled.value;
  return runtime.floorMode === 'enforce' ? [] : standIn;
}

/**
 * Decides one step with a settings answer the caller already has (GATE-04, D-08) and records the decision, ahead of the step's own run. It is gateToolCall
 * for a path that does not build its answer from an AgentTool.
 */
export async function gateStep(runtime: GateRuntime, input: GateStepInput, options: GateCallOptions = {}): Promise<GatedCall> {
  const request: GateRequest = {
    actor: runtime.actor,
    tool: input.tool,
    callId: input.callId,
    effects: input.effects,
    context: runtime.context,
    presence: runtime.presence,
    policy: input.policy,
    ...(input.manifestContexts === undefined ? {} : { manifestContexts: input.manifestContexts }),
    ...(input.command === undefined ? {} : { command: input.command })
  };
  const answered: SettingsAnswer = options.refusal === undefined ? input.settings : { decision: 'deny', reason: options.refusal.reason, rule: options.refusal.rule };
  const decision = await decideOrRefuse(options.refusal, input.policy.mode, () => decide(request, runtime.bundleState(), async () => answered, { floorMode: runtime.floorMode }));
  const gated: GatedCall = { decision, settings: undefined, request, effects: input.effects };
  keep(runtime, recordFor(runtime, gated, outcomeOf(decision), decision.rule, decision.reason, options.model === undefined ? undefined : { name: options.model, provider: MODEL_PROVIDER }));
  return gated;
}

export type ReplyResult = { readonly proceed: true } | { readonly proceed: false; readonly rule: string; readonly reason: string };

// Asks the person has not answered yet, by run: a late answer is recorded when it arrives.
const WAITING = new WeakMap<GateRuntime, Map<string, GatedCall>>();

// A settings layer that has already been answered by the person: it only lets the earlier layers be asked again.
const ANSWERED: SettingsLayer = async (): Promise<SettingsAnswer> => ({ decision: 'allow', rule: 'settings.approved' });

/**
 * The person's answer to a card (D-09). A card is only a transport: the answer comes back here, is recorded against the same call id (`approved` or
 * `denied`), and for an allow the layers that outrank the person (emergency stop, bundle state, the floor's refusals, the ceiling) are asked again, so an
 * answer given after the world changed cannot run the call. A `pending` answer records nothing now and is remembered for `recordLateApproval`.
 */
export async function recordApprovalReply(runtime: GateRuntime, gated: GatedCall, reply: GateReply, options: GateCallOptions = {}): Promise<ReplyResult> {
  const model = options.model === undefined ? undefined : { name: options.model, provider: MODEL_PROVIDER };
  if (reply.decision === 'pending') {
    let waiting = WAITING.get(runtime);
    if (waiting === undefined) { waiting = new Map(); WAITING.set(runtime, waiting); }
    waiting.set(gated.request.callId, gated);
    return { proceed: false, rule: gated.decision.rule, reason: 'Nobody has answered yet.' };
  }
  if (reply.decision === 'deny') {
    keep(runtime, recordFor(runtime, gated, 'denied', gated.decision.rule, 'The person declined this action.', model));
    return { proceed: false, rule: gated.decision.rule, reason: 'The person declined this action.' };
  }
  let again: GateDecision;
  try {
    again = await decide(gated.request, runtime.bundleState(), ANSWERED, { floorMode: runtime.floorMode });
  } catch {
    again = { outcome: 'deny', rule: 'bundle.failed-closed', reason: 'NEAR AI could not check this call again, so it was not run.', floor: false, offerAlwaysAllow: false, allowGrant: false, effectiveMode: 'approve-risky' };
  }
  if (again.outcome === 'deny') {
    const refused: GatedCall = { ...gated, decision: again };
    keep(runtime, recordFor(runtime, refused, outcomeOf(again), again.rule, again.reason, model));
    return { proceed: false, rule: again.rule, reason: again.reason ?? 'This is no longer allowed.' };
  }
  keep(runtime, recordFor(runtime, gated, 'approved', gated.decision.rule, undefined, model));
  return { proceed: true };
}

/** An answer that arrived after the run had gone on (a sub-agent's card the person answered later): recorded against the call it was asked for. Nothing runs from it. */
export function recordLateApproval(runtime: GateRuntime, callId: string, reply: GateReply, options: GateCallOptions = {}): void {
  const waiting = WAITING.get(runtime);
  const gated = waiting?.get(callId);
  if (waiting === undefined || gated === undefined || reply.decision === 'pending') return;
  waiting.delete(callId);
  const model = options.model === undefined ? undefined : { name: options.model, provider: MODEL_PROVIDER };
  if (reply.decision === 'deny') keep(runtime, recordFor(runtime, gated, 'denied', gated.decision.rule, 'The person declined this action.', model));
  else keep(runtime, recordFor(runtime, gated, 'approved', gated.decision.rule, undefined, model));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The runtime of a run with no gate host
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The records an unavailable runtime kept, so a test can read them. */
export interface MemoryGateRuntime extends GateRuntime {
  readonly records: DecisionRecord[];
}

/** A run with no host keeps at most this many records in memory (the newest); it has nowhere on disk to put them. */
const MAX_MEMORY_RECORDS = 200;

const UNAVAILABLE_ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: DEVICE_UNKNOWN, sessionId: 'no-gate-host' };

/**
 * The runtime a run gets when its creator gave it no gate host (Pitfall 1). It never decides against a policy it has not read: its bundle is failed closed with
 * the rule `bundle.unavailable`, so only the floor and reading and planning are allowed, with a plain reason. Every production path that has a host passes
 * the host's own runtime (the per-install bundle lives in global storage, so it exists with no project folder open); this is only for a path that has none.
 */
export function unavailableGateRuntime(options: { presence?: GateRuntime['presence']; context?: GateRuntime['context']; actor?: ActorRef } = {}): MemoryGateRuntime {
  const records: DecisionRecord[] = [];
  const state = failedClosed('unavailable');
  return {
    bundleState: () => state,
    sink: { record: (record) => { records.push(record); if (records.length > MAX_MEMORY_RECORDS) records.shift(); } },
    actor: options.actor ?? UNAVAILABLE_ACTOR,
    presence: options.presence ?? 'person',
    context: options.context ?? 'interactive',
    floorMode: 'shadow',
    records
  };
}

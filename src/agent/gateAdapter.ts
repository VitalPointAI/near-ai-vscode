// The loop's side of the one gate (GATE-04, D-08, D-09, D-10, D-43). It builds a GateRequest from a tool call (the manifest's effects and today's forbidden,
// sensitive and risky hooks), hands today's decidePermissionAsync to decide() as its settings layer, and records the decision. It decides nothing itself:
// outside the floor every outcome equals what the loop decided before, and the floor is always enforced (D-19). No vscode import here.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ActionCapability, ActionPolicy } from '../domain/policy';
import { failedClosed } from '../domain/gate/bundle';
import type { BundleState, GateContextName } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { ActorRef, GateDecision, GateOptions, GateRequest, GateRuntime, PreGateRule, SettingsAnswer, SettingsLayer } from '../domain/gate/decide';
import { namesCredentialStore, namesIdentityFiles } from '../domain/gate/floor';
import type { FloorFacts, FloorLocations } from '../domain/gate/floor';
import { effectsFor } from '../domain/gate/manifest';
import type { InputFieldSource } from '../domain/gate/manifest';
import { buildDecisionRecord, outcomeOf } from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord, DecisionResource } from '../domain/gate/record';
import { fromActionCapability } from '../domain/gate/vocabulary';
import type { Capability } from '../domain/gate/vocabulary';
import { classifyCommand, downloadSegments } from './commandSafety';
import type { CommandEffect, PackageScriptsAt } from './commandSafety';
import { decidePermissionAsync, denyListReason, isAutoAllowed } from './permissions';
import type { AutoApprovalContext, PermissionDecision, PermissionRules, RunGrants } from './permissions';
import { shellReachesCredentialStore } from './tools';
import type { AgentTool } from './tools';
import { resolveInWorkspace } from './workspace';

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
  /**
   * The folders outside the project that the file tools may read (`ToolContext.readOnlyRoots`: the managed Open-GSD runtime). A read the tools' own resolver
   * places inside one of them is a known read, not an unknown effect; nothing here widens what may be written.
   */
  readonly readOnlyRoots?: readonly string[];
}

/** The cheap part of the classifier's context the floor needs: no safety model, no Open-GSD runtime check, nothing that asks a person. */
export interface FloorShellContext {
  /** The shell's folder when the command runs (absolute). */
  readonly cwd: string;
  /** The project's package.json scripts, so `npm run x` is read as what x runs. Used only when `packageScriptsAt` is not given (tests). */
  readonly packageScripts?: Readonly<Record<string, string>>;
  /** The scripts of the package.json a package manager would use in a folder, so `cd sub && npm run x` is read as sub's x (PackageScriptsReader). */
  readonly packageScriptsAt?: (folder: string) => PackageScriptsAt;
  /** The managed Open-GSD runtime's folders, whose gsd-tools verbs the classifier reads. */
  readonly trustedRoots?: readonly string[];
  /** The Open-GSD preambles the runtime ships, so what follows one is read as a command. */
  readonly gsdPreambles?: readonly string[];
}

export interface FloorFactsInput extends Partial<FloorShellContext> {
  readonly command: string;
  /** The system's temporary folders; absent, the process's own, worked out once (temporaryRootsCache). A delete inside one is scratch work, not destruction. */
  readonly temporaryRoots?: readonly string[];
  /** The folder this call works in. */
  readonly root: string;
  /** The person's home folder, for `~`, `$HOME` and the credential stores in it. */
  readonly home?: string;
  /** This extension's global storage, whose identity and gate folders the floor refuses. */
  readonly globalStorage?: string;
}

/**
 * What the floor learns from a shell command's text: the effects the classifier tagged (publish, destroy, a protected write, which the floor turns into
 * `floor.publish`, `floor.destroy` and `floor.protected-write`), and whether it reaches a credential store or the identity files (D-16).
 */
export interface FloorCommandFacts {
  readonly effects: readonly CommandEffect[];
  readonly facts: Pick<FloorFacts, 'credentialStore' | 'identityFiles'>;
  /**
   * Set, with the reason, when the floor could not read the whole command: the classifier stopped (nested too deep, too long) or threw, or the
   * credential-store check threw. The call's effects are then unknown, so decide() asks with a person there and refuses with nobody (PR #74 review).
   */
  readonly effectsUnknown?: string;
}

/** Where the system's temporary folders are, for systemTemporaryRoots; a test gives a stand-in. */
export interface TemporarySource {
  readonly tmpdir: () => string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolves a folder through links; realpathSync by default. Throws when it does not resolve. */
  readonly realpath?: (folder: string) => string;
}

/**
 * The system's temporary folders, absolute, each once: the temporary folder (os.tmpdir(): /var/folders/…/T on macOS), TMPDIR when set, `/tmp` and
 * `/var/tmp` (where Open-GSD keeps its helpers), each as written and as it resolves (`/private/var/folders/…`, `/private/tmp`). The classifier is handed
 * these rather than reading the environment itself (PR #74 review). Reads no file: realpath only.
 */
export function systemTemporaryRoots(source: TemporarySource = { tmpdir, env: process.env }): string[] {
  const resolve = source.realpath ?? ((folder: string) => realpathSync(folder));
  const written = [source.tmpdir(), source.env.TMPDIR, '/tmp', '/var/tmp'].filter((entry): entry is string => typeof entry === 'string' && entry !== '' && path.isAbsolute(entry)).map((entry) => path.resolve(entry));
  const out: string[] = [];
  for (const entry of written) {
    let real: string | undefined;
    try { real = resolve(entry); } catch { real = undefined; }
    for (const folder of real === undefined ? [entry] : [entry, real]) if (!out.includes(folder)) out.push(folder);
  }
  return out;
}

/**
 * systemTemporaryRoots worked out once and kept (PR #74 review round 4: it resolves four folders, and the floor reads every shell call), worked out again
 * only when the temporary folder or TMPDIR it came from changes.
 */
export function temporaryRootsCache(source: TemporarySource = { tmpdir, env: process.env }): () => readonly string[] {
  let key: string | undefined;
  let roots: readonly string[] = [];
  return () => {
    const now = `${source.tmpdir()}\u0000${source.env.TMPDIR ?? ''}`;
    if (now !== key) { roots = Object.freeze(systemTemporaryRoots(source)); key = now; }
    return roots;
  };
}

/** The process's own temporary folders, kept by temporaryRootsCache: what the floor uses when its caller names none. */
const processTemporaryRoots = temporaryRootsCache();

/** The two readers the floor uses on a command. Given only by tests (a reader that throws) and by nothing else; each defaults to the real one. */
export interface FloorReaders {
  readonly classify?: typeof classifyCommand;
  readonly reach?: typeof shellReachesCredentialStore;
}

/**
 * The floor's own reading of a shell command (GATE-05, Pitfall 5): the classifier run with a cheap context of its own, so the floor sees what a command
 * publishes, destroys or writes in every mode, including the ones that never build auto approve's context, and the credential-store check with the
 * command's words resolved from the shell's folder. It only reads the command's text and resolves paths; it runs nothing and opens no file.
 */
export async function floorFactsFor(input: FloorFactsInput, readers: FloorReaders = {}): Promise<FloorCommandFacts> {
  if (input.command.trim() === '') return { effects: [], facts: {} };
  const classify = readers.classify ?? classifyCommand;
  const reachOf = readers.reach ?? shellReachesCredentialStore;
  // Either reader failing leaves the floor not knowing what the command does or reaches, so the call's effects are unknown: never "nothing found" (fail
  // closed). The text checks decide() runs on the command itself still refuse a credential store it names.
  let lost: string | undefined;
  let reach: Awaited<ReturnType<typeof shellReachesCredentialStore>>;
  try {
    reach = await reachOf(input.command, { root: input.root, shell: { workingDirectory: input.cwd ?? input.root } }, {
      ...(input.home === undefined ? {} : { home: input.home }),
      ...(input.globalStorage === undefined ? {} : { globalStorage: input.globalStorage })
    });
  } catch {
    reach = {};
    lost = 'the check for credential stores could not read this command';
  }
  const facts = {
    ...(reach.credentialStore === undefined ? {} : { credentialStore: reach.credentialStore }),
    ...(reach.identityFiles === undefined ? {} : { identityFiles: reach.identityFiles })
  };
  let classified: ReturnType<typeof classifyCommand>;
  try {
    classified = classify(input.command, {
      root: input.root,
      cwd: input.cwd ?? input.root,
      ...(input.home === undefined ? {} : { home: input.home }),
      ...(input.packageScripts === undefined ? {} : { packageScripts: { ...input.packageScripts } }),
      ...(input.packageScriptsAt === undefined ? {} : { packageScriptsAt: input.packageScriptsAt }),
      ...(input.trustedRoots === undefined ? {} : { trustedToolRoots: [...input.trustedRoots] }),
      ...(input.gsdPreambles === undefined ? {} : { gsdPreambles: [...input.gsdPreambles] }),
      temporaryRoots: input.temporaryRoots === undefined ? processTemporaryRoots() : input.temporaryRoots
    });
  } catch {
    // The classifier is pure and should never throw; if it does, nothing is known about what the command does.
    return { effects: [], facts, effectsUnknown: 'the command could not be read' };
  }
  const unknownWhy = lost ?? classified.effectsUnknown;
  return { effects: classified.effects ?? [], facts, ...(unknownWhy === undefined ? {} : { effectsUnknown: unknownWhy }) };
}

/** What decide() is told by the runtime: when the host knows them, the home folder and global storage the floor's text checks may name. Nothing turns the floor off. */
function gateOptionsOf(runtime: GateRuntime): GateOptions {
  return runtime.locations === undefined ? {} : { locations: runtime.locations };
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
  /** What the record names when the effects alone would not say it (a read in a trusted folder outside the project). */
  readonly resource?: DecisionResource;
  /** The exact call, as `floorApprovalsOnce` keys it. Set on a floor ask, so a card for it can be approved once, late (D-43, Pitfall 4). */
  readonly callKey?: string;
  /** True when a person had already approved this exact floor call once, after the run moved on: it runs this time, and the next identical call asks again. */
  readonly approvedOnce?: boolean;
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

/** The names of the arguments a manifest reads as project paths, with the verbs of the effects that read each one. */
function pathFieldVerbs(tool: AgentTool<any>): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  for (const entry of tool.manifest.effects) {
    if ('from' in entry) continue;
    const take = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      const source = value as Partial<InputFieldSource>;
      if (source.from !== 'input' || (source.as !== 'path' && source.as !== 'folder') || typeof source.field !== 'string') return;
      const verbs = names.get(source.field) ?? new Set<string>();
      verbs.add(entry.verb);
      names.set(source.field, verbs);
    };
    for (const key of Object.keys(entry)) {
      const value: unknown = entry[key];
      if (Array.isArray(value)) value.forEach(take);
      else take(value);
    }
  }
  return names;
}

/** The names of the arguments a manifest reads as project paths. */
function pathFields(tool: AgentTool<any>): string[] {
  return [...pathFieldVerbs(tool).keys()];
}

/**
 * The model's arguments as the manifest reads them: the tool's own defaults written out, and an absolute path that lies inside the folder this call works
 * in written relative to it (a manifest names project paths, and models often send the full path). A path outside the folder stays as it is and is refused
 * by the vocabulary, which is what "effects unknown" means.
 */
export function manifestArguments(tool: AgentTool<any>, raw: Record<string, unknown>, root: string): Record<string, unknown> {
  return projectRelative(tool, tool.manifestInput?.(raw) ?? raw, root);
}

/** Arguments already in the manifest's shape (manifestInput has run), with each absolute path inside the folder written relative to it. */
function projectRelative(tool: AgentTool<any>, given: Record<string, unknown>, root: string): Record<string, unknown> {
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
 * The call's effects. A call the manifest cannot fill (a path outside the project and every trusted folder, a missing field) has unknown effects: the list is
 * empty, and decide() asks a person about it or, with nobody here, refuses it with `manifest.effects-unknown`. No stand-in is invented.
 */
export function effectsOfCall(tool: AgentTool<any>, raw: Record<string, unknown>, root: string): readonly Capability[] {
  return effectsOfArguments(tool, tool.manifestInput?.(raw) ?? raw, root);
}

/** The effects of arguments already in the manifest's shape (what readCallPaths built): manifestInput is not run again. */
function effectsOfArguments(tool: AgentTool<any>, args: Record<string, unknown>, root: string): readonly Capability[] {
  const filled = effectsFor(tool.manifest, projectRelative(tool, args, root));
  return filled.ok ? filled.value : [];
}

/** What reading the call's paths showed: the arguments with each trusted-folder read written as a project read, and what the floor must know about them. */
export interface CallPaths {
  /**
   * The call's arguments in the manifest's shape, built once (the tool's manifestInput has run, PR #74 review round 2), with each trusted-folder read written
   * as `**`. The effects are filled from these, never from the model's own arguments again, so a tool whose manifestInput renames a field keeps the rewrite.
   */
  readonly input: Record<string, unknown>;
  /** The trusted-folder files read, named by the folder's own name and the path inside it (never the full machine path). */
  readonly trustedReads: readonly string[];
  readonly facts: Pick<FloorFacts, 'credentialStore' | 'identityFiles'>;
}

function insideFolder(folder: string, target: string): boolean {
  const relative = path.relative(folder, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * The paths a file tool's call names, read before the manifest is filled (the carried-forward PR #70 review item). Two things come out of it:
 *
 * - The floor's refusals come first: a path naming a credential store or this extension's identity and gate folders (D-16), as written or as it resolves,
 *   becomes a floor fact, so the call is refused with no card in every mode, wherever the tool would have looked.
 * - A read in a trusted folder outside the project (`readOnlyRoots`, the managed Open-GSD runtime the tools may read) keeps running as it always has: an
 *   argument read only by `read` effects whose real path (links followed, exactly as the tool resolves it) lies inside such a folder is written as `**`,
 *   a read of the widest project path, so every later layer judges it at least as strictly as a read of the project, and the record names the file. An
 *   argument any write or destroy effect reads is never rewritten, and a path outside the project and every trusted folder stays unknown.
 */
export async function readCallPaths(tool: AgentTool<any>, raw: Record<string, unknown>, root: string, readOnlyRoots: readonly string[] = [], locations: FloorLocations = {}): Promise<CallPaths> {
  const given = tool.manifestInput?.(raw) ?? raw;
  const fields = pathFieldVerbs(tool);
  let out: Record<string, unknown> | undefined;
  const trustedReads: string[] = [];
  let credentialStore: string | undefined;
  let identityFiles: string | undefined;
  for (const [field, verbs] of fields) {
    const value = given[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    let resolved: string | undefined;
    try {
      resolved = await resolveInWorkspace(root, value, [...readOnlyRoots]);
    } catch {
      resolved = undefined; // outside the project and every trusted folder, or the key folder: the tool refuses it, and its effects stay unknown
    }
    for (const shown of resolved === undefined || resolved === value ? [value] : [value, resolved]) {
      credentialStore ??= namesCredentialStore(shown, locations);
      identityFiles ??= namesIdentityFiles(shown, locations);
    }
    if (resolved === undefined || ![...verbs].every((verb) => verb === 'read')) continue;
    const realRoot = await realFolder(root);
    if (insideFolder(realRoot, resolved)) continue;
    for (const folder of readOnlyRoots) {
      if (!path.isAbsolute(folder)) continue;
      const real = await realFolder(folder);
      if (!insideFolder(real, resolved)) continue;
      // The arguments in the manifest's shape with this one field rewritten: the effects are filled from these, so manifestInput runs once per call.
      out ??= { ...given };
      out[field] = '**';
      const inside = path.relative(real, resolved).split(path.sep).join('/');
      trustedReads.push(inside === '' ? path.basename(real) : `${path.basename(real)}/${inside}`);
      break;
    }
  }
  return {
    input: out ?? given,
    trustedReads,
    facts: { ...(credentialStore === undefined ? {} : { credentialStore }), ...(identityFiles === undefined ? {} : { identityFiles }) }
  };
}

async function realFolder(folder: string): Promise<string> {
  return realpath(folder).catch(() => path.resolve(folder));
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

/**
 * The trusted-folder files a call reads, for its record's resource name (PR #74 review round 4): every one, as many as fit in MAX_RESOURCE_NAME, then how
 * many more. One file is its own name.
 */
export function trustedReadsName(reads: readonly string[]): string {
  const names = reads.map(shownName);
  const listed: string[] = [];
  for (const [index, name] of names.entries()) {
    const left = names.length - index - 1;
    const candidate = [...listed, name].join(', ');
    const tail = left > 0 ? ` and ${left} more` : '';
    if (candidate.length + tail.length > MAX_RESOURCE_NAME) break;
    listed.push(name);
  }
  if (listed.length === names.length) return listed.join(', ');
  const more = ` and ${names.length - Math.max(listed.length, 1)} more`;
  // Even the first name does not fit beside the count: it is cut to make room.
  return listed.length > 0 ? `${listed.join(', ')}${more}` : `${(names[0] ?? '').slice(0, MAX_RESOURCE_NAME - more.length)}${more}`;
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
    resource: gated.resource ?? resourceOf(gated.request.tool, gated.effects, gated.request.command),
    outcome,
    rule,
    ...(reason === undefined || reason === '' ? {} : { reason }),
    bundleHash: bundleHashOf(runtime)
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

/** A call refused before the gate could be asked (PRE_GATE_RULES): the name the model gave, its call id, why, and what the tool says it does when it is known. */
export interface RefusedBeforeGate {
  readonly tool: string;
  readonly callId: string;
  readonly rule: PreGateRule;
  readonly reason: string;
  /** The tool's own shorthand, when the tool exists; an unknown tool is recorded as a plan, which names nothing it could reach. */
  readonly capability?: ActionCapability;
}

/**
 * Records a call the loop refused before the gate could be asked, so every refused call is in the log (PR #70 review carry-over): a tool name the run does
 * not have, or a tool's own check that threw. The record is `denied` and names the tool, never the arguments. Never throws.
 */
export function recordRefusedBeforeGate(runtime: GateRuntime, call: RefusedBeforeGate, options: Pick<GateCallOptions, 'model'> = {}): void {
  try {
    const capability = (call.capability === undefined ? undefined : WIDEST_SHORTHAND(call.capability)[0]) ?? { verb: 'plan' } as Capability;
    keep(runtime, buildDecisionRecord({
      recordId: (runtime.newRecordId ?? randomUUID)(),
      sequence: 0,
      time: (runtime.clock ?? Date.now)(),
      productVersion: productVersionOf(runtime),
      actor: runtime.actor,
      ...(options.model === undefined ? {} : { model: { name: options.model, provider: MODEL_PROVIDER } }),
      callId: call.callId,
      capability,
      resource: { name: shownName(call.tool), type: 'tool' },
      outcome: 'denied',
      rule: call.rule,
      reason: call.reason,
      bundleHash: bundleHashOf(runtime)
    }));
  } catch {
    // A record that cannot be kept never changes what the loop does (D-21).
  }
}

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
  /** The floor's readers of a shell command; only tests pass them (a reader that throws must leave the call's effects unknown). */
  readonly floorReaders?: FloorReaders;
}

/** The settings layer of a call the caller refuses: today's permission logic is not asked (it could run a classifier or a model about a call that will not run). */
function refusalLayer(refusal: Refusal): SettingsLayer {
  return async (): Promise<SettingsAnswer> => ({ decision: 'deny', reason: refusal.reason, rule: refusal.rule });
}

/** The gate's decision for a call the caller refuses: its own deny when it made one, otherwise the caller's refusal. Never an allow or an ask. */
function refusedDecision(decision: GateDecision | undefined, refusal: Refusal, mode: ActionPolicy['mode']): GateDecision {
  if (decision !== undefined && decision.outcome === 'deny') return decision;
  return { outcome: 'deny', rule: refusal.rule, reason: refusal.reason, floor: false, offerAlwaysAllow: false, allowGrant: false, effectiveMode: decision?.effectiveMode ?? mode };
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
  // The paths a file tool names are read first: a credential store or the identity folders is a floor fact, and a read in a trusted folder is a known read.
  const paths = await readCallPaths(input.tool, input.raw, input.root, input.readOnlyRoots ?? [], runtime.locations ?? {});
  const declared = effectsOfArguments(input.tool, paths.input, input.root);
  // A shell call's command is read by the floor in every mode (Pitfall 5); what it tags joins the manifest's own effects.
  const read = input.command === undefined ? undefined : await floorFactsFor({ command: input.command, root: input.root, ...(input.shell ?? {}), ...(runtime.locations ?? {}) }, options.floorReaders);
  // A command the floor could not read whole has unknown effects, whatever the manifest says: decide() asks about it with a person and refuses it with nobody.
  const effects = read?.effectsUnknown !== undefined ? [] : withCommandEffects(declared, read?.effects ?? []);
  const floorFacts: FloorFacts = { ...(input.tool.capability === 'sharedWrite' ? { sharedWrite: true } : {}), ...paths.facts, ...(read?.facts ?? {}) };
  // The deny list is read here, before the gate, so it refuses a shell command before any step that could only ask, unknown effects included (D-10). It
  // reads the whole text, so a command too long or too deep for the classifier is still matched.
  const denied = input.tool.capability === 'shell' && input.command !== undefined ? denyListReason(input.command, input.rules) : undefined;
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
    ...(Object.keys(floorFacts).length === 0 ? {} : { floorFacts }),
    ...(denied === undefined ? {} : { settingsRefusal: { rule: 'settings.deny-list', reason: denied } })
  };
  const captured: { value?: PermissionDecision } = {};
  const layer = options.refusal === undefined ? settingsLayerFor(input, captured) : refusalLayer(options.refusal);
  const decision = await decideOrRefuse(options.refusal, input.policy.mode, () => decide(request, runtime.bundleState(), layer, gateOptionsOf(runtime)));
  const resource: DecisionResource | undefined = input.command === undefined && paths.trustedReads.length > 0 ? { name: trustedReadsName(paths.trustedReads), type: 'file' } : undefined;
  const floorAsk = decision.outcome === 'ask' && decision.floor;
  // A late approval of this exact call is used up by this decision, whatever it is (PR #74 review round 5): a refusal in between never leaves it waiting.
  const exactCall = floorCallKey(input);
  const approvedLate = takeFloorApproval(input.grants, exactCall, (runtime.clock ?? Date.now)());
  const callKey = floorAsk ? exactCall : undefined;
  const gated: GatedCall = { decision, settings: captured.value, request, effects, ...(resource === undefined ? {} : { resource }), ...(callKey === undefined ? {} : { callKey }) };
  const model = options.model === undefined ? undefined : { name: options.model, provider: MODEL_PROVIDER };
  // A floor ask a person already approved once, late (a sub-agent's parked card): this exact call runs this time only. decide() has just been asked again,
  // so the emergency stop, the policy, the floor's refusals and the deny list all still came first (D-43, Pitfall 4).
  if (callKey !== undefined && approvedLate) {
    keep(runtime, recordFor(runtime, gated, 'approved', decision.rule, APPROVED_ONCE_REASON, model));
    return { ...gated, approvedOnce: true };
  }
  keep(runtime, recordFor(runtime, gated, outcomeOf(decision), decision.rule, decision.reason, model));
  return gated;
}

const APPROVED_ONCE_REASON = 'A person approved this exact call once, after the run had moved on.';

/** How long a late floor approval waits for its call (PR #74 review round 5): long enough for the lead to retry it, short enough not to linger. */
export const FLOOR_APPROVAL_TTL_MS = 5 * 60_000;

/**
 * Floor calls a person approved late, once each, for one run's turn (D-43, Pitfall 4). Each is used up by the next decision of that exact call, whatever its
 * outcome, expires after FLOOR_APPROVAL_TTL_MS, and all end with the turn (endFloorApprovals); an approval given after the end is not kept.
 */
export class FloorApprovalsOnce {
  private readonly expiries = new Map<string, number>();
  private ended = false;

  /** A person approved this exact call once, late, at `now`. */
  public add(key: string, now: number = Date.now()): void {
    if (this.ended) return;
    this.expiries.set(key, now + FLOOR_APPROVAL_TTL_MS);
  }

  /** Whether an approval of this exact call is waiting and has not expired. */
  public has(key: string, now: number = Date.now()): boolean {
    const expires = this.expiries.get(key);
    return !this.ended && expires !== undefined && now < expires;
  }

  public get size(): number {
    return this.expiries.size;
  }

  /** Uses up the approval of this exact call, if any, and drops every expired one. True when it was waiting and still good. */
  public take(key: string, now: number): boolean {
    const good = this.has(key, now);
    this.expiries.delete(key);
    for (const [other, expires] of [...this.expiries]) if (now >= expires) this.expiries.delete(other);
    return good;
  }

  /** The run's turn is over: nothing waiting is kept, and nothing given later is. */
  public end(): void {
    this.ended = true;
    this.expiries.clear();
  }
}

// Kept beside RunGrants rather than in it, so no grant, allow rule or saved setting can ever carry a floor approval: an entry is only added by a late allow
// of a floor card.
const FLOOR_APPROVALS_ONCE = new WeakMap<RunGrants, FloorApprovalsOnce>();

/** The exact floor calls of this run a person approved once, late. A call key is added when a parked floor card is allowed. */
export function floorApprovalsOnce(grants: RunGrants): FloorApprovalsOnce {
  let once = FLOOR_APPROVALS_ONCE.get(grants);
  if (once === undefined) { once = new FloorApprovalsOnce(); FLOOR_APPROVALS_ONCE.set(grants, once); }
  return once;
}

/** The run's turn has ended: its late floor approvals end with it. */
export function endFloorApprovals(grants: RunGrants): void {
  floorApprovalsOnce(grants).end();
}

function takeFloorApproval(grants: RunGrants, key: string, now: number): boolean {
  const once = FLOOR_APPROVALS_ONCE.get(grants);
  return once !== undefined && once.take(key, now);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

/** One exact call: the tool, the folder it works in (a sub-agent's worktree is its own), the shell's folder for a command, and the arguments in a fixed order. */
export function floorCallKey(input: Pick<GateCallInput, 'tool' | 'root' | 'raw' | 'shell'>): string {
  return JSON.stringify([input.tool.name, input.root, input.shell?.cwd ?? '', canonical(input.raw)]);
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
  /** What the floor must know about the paths the step names (a credential store, the identity folders). */
  readonly floorFacts?: Pick<FloorFacts, 'credentialStore' | 'identityFiles'>;
  /** What the record names when the effects alone would not say it. */
  readonly resource?: DecisionResource;
}

/** What the gate knows about a step that runs a tool: its effects and the floor's facts about the paths it names. */
export interface StepEffects {
  readonly effects: readonly Capability[];
  readonly floorFacts: Pick<FloorFacts, 'credentialStore' | 'identityFiles'>;
  readonly resource?: DecisionResource;
}

/**
 * The effects of a step that runs a tool: its manifest's, filled from the arguments, read the way a chat call is (`readCallPaths`). `readOnlyRoots` are the
 * folders outside the project the step may read (an engagement's resolved scope paths, which its file probes are confined to). A step the manifest cannot
 * fill has unknown effects (an empty list).
 */
export async function effectsOfStep(tool: AgentTool<any>, raw: Record<string, unknown>, root: string, readOnlyRoots: readonly string[] = [], locations: FloorLocations = {}): Promise<StepEffects> {
  const paths = await readCallPaths(tool, raw, root, readOnlyRoots, locations);
  return { effects: effectsOfArguments(tool, paths.input, root), floorFacts: paths.facts, ...(paths.trustedReads.length === 0 ? {} : { resource: { name: trustedReadsName(paths.trustedReads), type: 'file' } }) };
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
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.floorFacts === undefined || Object.keys(input.floorFacts).length === 0 ? {} : { floorFacts: input.floorFacts }),
    // A step the caller's settings already refuse (its deny list, an engagement's scope) is refused before any ask, unknown effects included (D-10).
    ...(input.settings.decision === 'deny' ? { settingsRefusal: { rule: input.settings.rule, reason: input.settings.reason ?? 'Your settings refuse this step.' } } : {})
  };
  const answered: SettingsAnswer = options.refusal === undefined ? input.settings : { decision: 'deny', reason: options.refusal.reason, rule: options.refusal.rule };
  const decision = await decideOrRefuse(options.refusal, input.policy.mode, () => decide(request, runtime.bundleState(), async () => answered, gateOptionsOf(runtime)));
  const gated: GatedCall = { decision, settings: undefined, request, effects: input.effects, ...(input.resource === undefined ? {} : { resource: input.resource }) };
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
    again = await decide(gated.request, runtime.bundleState(), ANSWERED, gateOptionsOf(runtime));
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
    records
  };
}

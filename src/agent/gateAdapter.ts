// The loop's side of the one gate (GATE-04, D-08, D-09, D-10, D-43). It builds a GateRequest from a tool call (the manifest's effects and today's forbidden,
// sensitive and risky hooks), hands today's decidePermissionAsync to decide() as its settings layer, and records the decision. It decides nothing itself:
// outside the floor every outcome equals what the loop decided before, and the floor is always enforced (D-19). No vscode import here.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ActionCapability, ActionPolicy } from '../domain/policy';
import { SHIPPED_DEFAULT_LABEL, failedClosed } from '../domain/gate/bundle';
import type { BundleState, GateContextName } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { ActorRef, GateDecision, GateOptions, GateRequest, GateRuntime, PreGateRule, SettingsAnswer, SettingsLayer } from '../domain/gate/decide';
import { credentialReason, identityFilesReason, namesCredentialStore, namesIdentityFiles, printerReason } from '../domain/gate/floor';
import type { FloorFacts, FloorLocations } from '../domain/gate/floor';
import { effectsFor } from '../domain/gate/manifest';
import type { InputFieldSource } from '../domain/gate/manifest';
import { buildDecisionRecord, outcomeOf } from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord, DecisionResource } from '../domain/gate/record';
import { fromActionCapability } from '../domain/gate/vocabulary';
import type { Capability } from '../domain/gate/vocabulary';
import { classifyCommand, commandMaySend, downloadSegments, namesCredentialFile } from './commandSafety';
import { commandWords, labelCheckFor, linkResolver, pathLike, readEffectPaths, scalesOf } from './gateLabels';
import { OUTBOUND_EARLIER_TEXT, OUTBOUND_FULL_TEXT, OUTBOUND_READS_AND_SENDS_TEXT, OUTBOUND_UNCHECKED_TEXT, OUTBOUND_MATCH_TEXT, OUTBOUND_UNREADABLE_TEXT, outboundPayload } from './outboundCheck';
import type { OutboundFingerprints } from './outboundCheck';
import type { LabelVerdict } from '../domain/gate/decide';
import { SessionMark, whyNotDominated } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { labelKeyShown } from '../domain/gate/labelAlgebra';
import type { Clearance, Label } from '../domain/gate/labels';
import { routingWhileFailedClosed, strictestLabelOf, tierForLabel, tierForMark } from '../domain/gate/routing';
import type { RoutingTable, RoutingTier } from '../domain/gate/routing';
import { isDefaultMark } from '../gate/sessionMark';
import type { CommandContext, CommandEffect, PackageScriptsAt } from './commandSafety';
import { decidePermissionAsync, denyListReason, isAutoAllowed } from './permissions';
import type { AutoApprovalContext, PermissionDecision, PermissionRules, RunGrants } from './permissions';
import { isSensitivePath, shellReachesCredentialStore } from './tools';
import type { AgentTool, bindFixtureGate } from './tools';
import { OutsideWorkspaceError, resolveInWorkspace } from './workspace';

const DEFAULT_PRODUCT_VERSION = '0.0.0';
const MAX_RESOURCE_NAME = 200;
const DEVICE_UNKNOWN = 'device-unknown';

/** What a card's reply can be, as the loop's own ApprovalReply names it (kept here so this file imports nothing from the loop). */
export interface GateReply { readonly decision: 'allow' | 'allow-run' | 'allow-always' | 'deny' | 'pending' }

export interface GateCallInput {
  readonly tool: AgentTool<any>;
  readonly fixtureGate?: ReturnType<typeof bindFixtureGate>;
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
  /**
   * Set, with the file as the agent named it, when this call itself reads a file that may hold credentials (a Read of `.env`, `cat .env`): a call that
   * reads one and can send data in the same line is held as one that runs after such a read (owner decision after PR #74, D-18).
   */
  readonly readsCredential?: string;
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
  readonly facts: Pick<FloorFacts, 'credentialStore' | 'identityFiles' | 'credentialChange'>;
  /**
   * Set, with the reason, when the floor could not read the whole command: the classifier stopped (nested too deep, too long) or threw, or the
   * credential-store check threw. The call's effects are then unknown, so decide() asks with a person there and refuses with nobody (PR #74 review).
   */
  readonly effectsUnknown?: string;
  /** A file that may hold credentials the command reads, as the classifier read it: its own words, a script it runs, a `bash -c` (D-18, PR #76 review round 3). */
  readonly credentialFile?: string;
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
  // Past the bounds the classifier reads, the check did not resolve the command's words: what it reaches is unknown (PR #74 review round 11).
  lost ??= reach.unreadable;
  const facts = {
    ...(reach.credentialStore === undefined ? {} : { credentialStore: reach.credentialStore }),
    ...(reach.identityFiles === undefined ? {} : { identityFiles: reach.identityFiles })
  };
  let classified: ReturnType<typeof classifyCommand>;
  try {
    classified = classify(input.command, floorClassifierContext(input));
  } catch {
    // The classifier is pure and should never throw; if it does, nothing is known about what the command does.
    return { effects: [], facts, effectsUnknown: 'the command could not be read' };
  }
  const unknownWhy = lost ?? classified.effectsUnknown;
  // A command that prints a stored token is refused like a credential store (A5); the text check above may already have named it.
  const printer = facts.credentialStore === undefined && classified.printsCredential !== undefined ? { credentialStore: printerReason(classified.printsCredential) } : {};
  const read = { ...facts, ...printer, ...(classified.credentialChange === undefined ? {} : { credentialChange: classified.credentialChange }) };
  return {
    effects: classified.effects ?? [], facts: read, ...(unknownWhy === undefined ? {} : { effectsUnknown: unknownWhy }),
    ...(classified.credentialFile === undefined ? {} : { credentialFile: classified.credentialFile })
  };
}

/** The classifier's context for the floor's own reading of a command: cheap, with no safety model, no allow list and no scratch record. */
function floorClassifierContext(input: FloorFactsInput): CommandContext {
  return {
    root: input.root,
    cwd: input.cwd ?? input.root,
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.packageScripts === undefined ? {} : { packageScripts: { ...input.packageScripts } }),
    ...(input.packageScriptsAt === undefined ? {} : { packageScriptsAt: input.packageScriptsAt }),
    ...(input.trustedRoots === undefined ? {} : { trustedToolRoots: [...input.trustedRoots] }),
    ...(input.gsdPreambles === undefined ? {} : { gsdPreambles: [...input.gsdPreambles] }),
    temporaryRoots: input.temporaryRoots === undefined ? processTemporaryRoots() : input.temporaryRoots
  };
}

/**
 * The file that may hold credentials a shell command reads, as written, or undefined (owner decision after PR #74, D-18): one its text names (`.env`, a key
 * file, `.ssh/`), a word that is one by its name, or a path-like word that resolves to one from the shell's folder, links followed (each resolved once per
 * call). Text and paths only: nothing is opened. Only the part of a command within the classifier's bounds is read word by word; its length alone is not a
 * read (the command already asks, its effects being unknown). A read the text does not show (a recursive search, a glob, a path built while the command
 * runs, a bare name that is a link) is not seen.
 */
export async function shellReadsCredentialFile(command: string, context: { root: string; shell?: { workingDirectory: string } }, options: { realpath?: (target: string) => Promise<string> } = {}): Promise<string | undefined> {
  if (command.trim() === '') return undefined;
  const named = namesCredentialFile(command);
  if (named !== undefined) return named;
  // The same words and the same link bound as the label check (gateLabels.ts), so the two never disagree about what a command names.
  const cwd = context.shell?.workingDirectory ?? context.root;
  const resolve = linkResolver(options.realpath === undefined ? {} : { realpath: options.realpath });
  for (const word of commandWords(command)) {
    const absolute = path.resolve(cwd, word);
    if (isSensitivePath(word) || isSensitivePath(absolute)) return word.slice(0, 120);
    if (!pathLike(word) || /[*?[]/.test(word)) continue;
    const real = await resolve(absolute);
    if (real !== undefined && real !== absolute && isSensitivePath(real)) return word.slice(0, 120);
  }
  return undefined;
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

/**
 * A call's declared effects joined with the floor's reading of its command (floorFactsFor), for chat calls and cyber steps alike (PR #74 review round 7):
 * the command's tags follow the declared effects, and a command the floor could not read whole has unknown effects, whatever was declared, so decide()
 * asks about it with a person and refuses it with nobody.
 */
function effectsWithReading(declared: readonly Capability[], read: FloorCommandFacts | undefined): readonly Capability[] {
  return read?.effectsUnknown !== undefined ? [] : withCommandEffects(declared, read?.effects ?? []);
}

/** One decided call: the decision, what today's settings layer said (when it was asked), and what is needed to record the person's answer. */
export interface GatedCall {
  readonly fixtureGate?: GateCallInput['fixtureGate'];
  readonly bundleHash: string;
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
  /** The file that may hold credentials this call reads, when it reads one: the run is marked with it once the call runs (D-18). */
  readonly readsCredential?: string;
  /** The tool's own words for a path outside the project, which the agent is told when the call is refused for it; never put on record. */
  readonly toolMessage?: string;
  /** Labels resolved for the named paths raise the session mark before the call, even if the read later fails (CLAS-03, D-54). */
  readonly readLabels: readonly Label[];
  /** Whether the call can send data off this computer, by the one predicate the credential-read hold and the mark share (D-54). */
  readonly maySend: boolean;
  /** The session's mark when the call was decided, kept only while it is above the policy's default label, for the record. */
  readonly mark?: Mark;
}

function productVersionOf(runtime: GateRuntime): string {
  return runtime.productVersion ?? DEFAULT_PRODUCT_VERSION;
}

function bundleHashOf(runtime: GateRuntime): string {
  try { return evaluatedBundleHash(runtime.bundleState()); }
  catch { return ''; }
}

function evaluatedBundleHash(state: BundleState | undefined): string {
  return state?.state === 'valid' ? state.hash : '';
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
  /**
   * The project-relative real paths (links followed, as the tools resolve them) of the paths read-only fields name inside the project, for the label check
   * (D-63): a path whose real place is in the project keeps the project's labels however it was named, so a link from the Open-GSD runtime into the project
   * cannot launder a label.
   */
  readonly projectReads: readonly string[];
  readonly facts: Pick<FloorFacts, 'credentialStore' | 'identityFiles'>;
  /**
   * When a path is outside the project and every folder the tool may use for it (a trusted folder only for a read): the tool would refuse the call, so the
   * gate refuses it up front (`call.outside-workspace`, owner decision after PR #74) instead of showing a card. `reason` is what the record says, in fixed
   * words with the path as the agent gave it (only its name, when that was a machine path); `toolMessage` is the tool's own words, for the agent only.
   */
  readonly outside?: { readonly reason: string; readonly toolMessage: string };
}

/** The reason on record for a path outside the project: fixed words, and never a machine path (PR #76 review round 4). */
function outsideReason(given: string): string {
  const shown = path.isAbsolute(given) || /^[A-Za-z]:[\\/]/.test(given) || given.startsWith('~') ? `A file named ${shownName(path.basename(given))}` : shownName(given);
  return `${shown} is outside the project and every folder this tool may use, so the tool would refuse it.`;
}

function insideFolder(folder: string, target: string): boolean {
  const relative = path.relative(folder, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Check supplied and derived paths before filling the manifest. Refuse protected
 * paths as written and resolved (D-16). Only read-only paths resolved inside
 * trusted folders can be represented by the widest project read, `**`. */
export async function readCallPaths(tool: AgentTool<any>, raw: Record<string, unknown>, root: string, readOnlyRoots: readonly string[] = [], locations: FloorLocations = {}, options: { realpath?: (folder: string) => Promise<string>; derivedDraftPath?: string } = {}): Promise<CallPaths> {
  const ordinary = tool.manifestInput?.(raw) ?? raw;
  const given = options.derivedDraftPath === undefined ? ordinary : { ...ordinary, draftPath: options.derivedDraftPath };
  // The project's folder and the trusted folders, resolved through links once for the whole call (PR #74 review round 6), and only when a path needs them.
  const resolveFolder = (folder: string): Promise<string> => (options.realpath ?? realpath)(folder).catch(() => path.resolve(folder));
  let folders: Promise<{ readonly root: string; readonly trusted: ReadonlyArray<{ readonly real: string }> }> | undefined;
  const resolvedFolders = () => (folders ??= (async () => ({
    root: await resolveFolder(root),
    trusted: await Promise.all(readOnlyRoots.filter((folder) => path.isAbsolute(folder)).map(async (folder) => ({ real: await resolveFolder(folder) })))
  }))());
  const fields = pathFieldVerbs(tool);
  const checks = [...fields].map(([field, verbs]) => ({ field, verbs, value: given[field] }));
  const draftVerbs = fields.get('draftPath');
  if (options.derivedDraftPath !== undefined && draftVerbs) {
    for (const value of new Set([raw.draftPath, ordinary.draftPath])) {
      if (value !== given.draftPath) checks.push({ field: 'draftPath', verbs: draftVerbs, value });
    }
  }
  let out: Record<string, unknown> | undefined;
  const trustedReads: string[] = [];
  const projectReads: string[] = [];
  let credentialStore: string | undefined;
  let identityFiles: string | undefined;
  let outside: { reason: string; toolMessage: string } | undefined;
  for (const { field, verbs, value } of checks) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    // A trusted folder is for reading: a field any other effect uses is resolved as the tools resolve a write, against the project alone.
    const readOnly = [...verbs].every((verb) => verb === 'read');
    let resolved: string | undefined;
    try {
      resolved = await resolveInWorkspace(root, value, readOnly ? [...readOnlyRoots] : []);
    } catch (error) {
      resolved = undefined; // outside the project and every trusted folder, or the key folder: the tool refuses it, and its effects stay unknown
      if (error instanceof OutsideWorkspaceError) outside ??= { reason: outsideReason(value), toolMessage: error.message };
    }
    // The path as the agent gave it names the store in the reason; one reached only through a link is named by what the agent gave, never the machine path.
    credentialStore ??= namesCredentialStore(value, locations, { root });
    identityFiles ??= namesIdentityFiles(value, locations);
    if (resolved !== undefined && resolved !== value) {
      if (credentialStore === undefined && namesCredentialStore(resolved, locations, { root }) !== undefined) credentialStore = credentialReason(shownName(value).slice(0, 120));
      if (identityFiles === undefined && namesIdentityFiles(resolved, locations) !== undefined) identityFiles = identityFilesReason(shownName(value).slice(0, 120));
    }
    if (resolved === undefined) continue;
    const known = await resolvedFolders();
    // Every field a read effect reads, whatever else the call does with it (PR #85 review): its real place in the project is checked against the labels.
    if (insideFolder(known.root, resolved)) {
      if (verbs.has('read')) projectReads.push(path.relative(known.root, resolved).split(path.sep).join('/'));
      continue;
    }
    if (![...verbs].every((verb) => verb === 'read')) continue;
    for (const { real } of known.trusted) {
      if (!insideFolder(real, resolved)) continue;
      // The arguments in the manifest's shape with this one field rewritten: the effects are filled from these, so manifestInput runs once per call.
      if (value === given[field]) (out ??= { ...given })[field] = '**';
      const inside = path.relative(real, resolved).split(path.sep).join('/');
      trustedReads.push(inside === '' ? path.basename(real) : `${path.basename(real)}/${inside}`);
      break;
    }
  }
  return {
    input: out ?? given,
    trustedReads,
    projectReads,
    facts: { ...(credentialStore === undefined ? {} : { credentialStore }), ...(identityFiles === undefined ? {} : { identityFiles }) },
    ...(outside === undefined ? {} : { outside })
  };
}


// The settings layer: today's decidePermissionAsync, with a stable rule id for what it answered.
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

// Records
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

/**
 * A record's words with the project's folder and the home folder written as `<project>` and `~` (PR #76 review round 4): a reason that names the shell's
 * folder, or a command typed with a machine path, never puts that path on record. The longer folder is replaced first, and only as a whole path (round 5).
 */
export function withoutMachinePaths(text: string, folders: { readonly project?: string; readonly home?: string }): string {
  const pairs: Array<[string, string]> = [];
  if (folders.project !== undefined && folders.project.length > 1) pairs.push([folders.project, '<project>']);
  if (folders.home !== undefined && folders.home.length > 1) pairs.push([folders.home, '~']);
  let out = text;
  // Only a whole path: where a path starts (the text's start, a space, a quote, `(`, `:` or `=`) and ends (a separator, a path list's `:`, a quote, a space, `)` or the end).
  for (const [folder, label] of pairs.sort((a, b) => b[0].length - a[0].length)) {
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Sentence punctuation ends a path too when a space or the end follows it (`in /work/app.` or `/work/app, then`), never `/work/app.bak`.
    out = out.replace(new RegExp(`(^|[\\s'"(\\[{:=])${escaped}(?=$|[/\\\\\\s'"):\\]}]|[.,;](?:\\s|$))`, 'g'), (_match, before: string) => `${before}${label}`);
  }
  return out;
}

function recordFor(runtime: GateRuntime, gated: GatedCall, outcome: DecisionOutcome, rule: string, givenReason: string | undefined, model: { name: string; provider: string } | undefined): DecisionRecord {
  const capability = gated.effects[0] ?? WIDEST_SHORTHAND('plan')[0] as Capability;
  const folders = { ...(gated.request.workspace === undefined ? {} : { project: gated.request.workspace.root }), ...(runtime.locations?.home === undefined ? {} : { home: runtime.locations.home }) };
  const reason = givenReason === undefined ? undefined : withoutMachinePaths(givenReason, folders);
  // A refusal at a mark (labelled text in the payload, a call that may send at a local-only mark, or a call to an MCP server above its ceiling) names the tool
  // only, never the command or address that could carry labelled words (D-60, PR #87 review).
  const given = rule === 'label.outbound-match' || rule === 'label.network-at-mark' || rule === 'label.mcp-ceiling' ? { name: shownName(gated.request.tool), type: 'tool' } : gated.resource ?? resourceOf(gated.request.tool, gated.effects, gated.request.command);
  const resource = { ...given, name: withoutMachinePaths(given.name, folders) };
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
    resource,
    outcome,
    rule,
    ...(reason === undefined || reason === '' ? {} : { reason }),
    bundleHash: gated.bundleHash,
    // A refusal for a label names the label that decided it; a failed clearance check is recorded as such (GATE-07).
    ...(rule.startsWith('label.') && gated.request.labelVerdict?.label !== undefined ? { label: gated.request.labelVerdict.label } : {}),
    ...(rule === 'label.dominance' ? { clearanceFailure: true } : {}),
    ...(rule === 'label.outbound-match' && gated.request.labelVerdict?.outboundCause !== undefined ? { outboundCause: gated.request.labelVerdict.outboundCause } : {}),
    // The session's whole mark while it is above the default label (GATE-07, D-52); at the default label the record says nothing of it.
    ...(gated.mark === undefined ? {} : { mark: gated.mark })
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
const FIXTURE_REFUSAL = { rule: TOOL_FORBIDDEN_RULE, reason: 'The fixture policy or declared effect no longer covers this call.' };

/** A refusal the caller makes itself, whatever the gate would have said: its rule id (one of GATE_RULE_IDS) and the plain reason it gives the person. */
export interface Refusal { readonly rule: string; readonly reason: string }

export interface GateCallOptions {
  readonly model?: string;
  /** Refuse regardless of the gate outcome. Higher layers can still record their more specific denial (PR #70). */
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

/** Decide one tool call and queue its audit record before dispatch (GATE-04). */
export async function gateToolCall(runtime: GateRuntime, input: GateCallInput, options: GateCallOptions = {}): Promise<GatedCall> {
  const fixture = input.fixtureGate;
  const pathOptions = fixture?.effect.verb === 'workspaceWrite' ? { derivedDraftPath: fixture.effect.path } : {};
  const paths = await readCallPaths(input.tool, input.raw, input.root, input.readOnlyRoots ?? [], runtime.locations ?? {}, pathOptions);
  const declared = effectsOfArguments(input.tool, paths.input, input.root);
  // A shell call's command is read by the floor in every mode (Pitfall 5); what it tags joins the manifest's own effects.
  const read = input.command === undefined ? undefined : await floorFactsFor({ command: input.command, root: input.root, ...(input.shell ?? {}), ...(runtime.locations ?? {}) }, options.floorReaders);
  const effects = effectsWithReading(declared, read);
  const floorFacts: FloorFacts = { ...(input.tool.capability === 'sharedWrite' ? { sharedWrite: true } : {}), ...paths.facts, ...(read?.facts ?? {}) };
  // The deny list reads the whole command and can refuse even when effects are unknown (D-10).
  const denied = input.tool.capability === 'shell' && input.command !== undefined ? denyListReason(input.command, input.rules) : undefined;
  // After a credential read by the run or this call, an off-machine call is held in every mode (D-18).
  const readsCredential = input.readsCredential ?? read?.credentialFile;
  const credentialRead = input.grants.credentialRead ?? readsCredential;
  // One fail-closed predicate for "can this call send data off this computer" (D-54): the credential-read hold and the mark's network verdict both read it.
  const maySend = maySendOffMachine({ runsRemote: input.tool.manifest.runsOn === 'remote', effects, ...(input.command === undefined ? {} : { command: input.command }), effectsUnknown: read?.effectsUnknown !== undefined, context: { root: input.root, ...(input.shell ?? {}), ...(runtime.locations ?? {}) } });
  const credentialHold = credentialRead !== undefined && maySend ? credentialHoldReason(credentialRead, input.command !== undefined) : undefined;
  // Check every read against clearances and hold unknown effects when the label file is held (D-28, D-53, D-59).
  // Trusted Open-GSD paths use the default label; project paths use their resolved labels (D-63).
  const trusted = paths.trustedReads.length > 0;
  const labelCheck = await labelCheckFor(runtime, {
    root: input.root,
    reads: [...new Set([...(trusted ? [] : readEffectPaths(effects.length > 0 ? effects : declared)), ...paths.projectReads])],
    ...(trusted ? { defaultReads: true } : {}),
    ...(input.command === undefined ? {} : { command: input.command, cwd: input.shell?.cwd ?? input.root }),
    mayReadAnything: input.command !== undefined || effects.length === 0
  });
  const markNow = input.grants.mark?.current();
  // Check dominance, the MCP ceiling, then the mark's network and outbound rules (D-29, D-60).
  const labelVerdict = labelCheck.verdict ?? mcpCeilingVerdictFor(runtime, input.tool.mcpServer, markNow, labelCheck.read)
    ?? markVerdictFor(runtime, markNow, maySend, () => outboundPayload(input.raw, input.command), input.grants.outbound, labelCheck.read);
  const request: GateRequest = {
    actor: runtime.actor,
    tool: input.tool.name,
    callId: input.callId,
    effects,
    context: runtime.context,
    presence: runtime.presence,
    policy: fixture?.policy ?? input.policy,
    manifestContexts: input.tool.manifest.contexts,
    ...(labelVerdict === undefined ? {} : { labelVerdict }),
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.forbidden === undefined || input.forbidden === '' ? {} : { forbidden: input.forbidden }),
    ...(input.sensitive === undefined || input.sensitive === '' ? {} : { sensitive: input.sensitive }),
    ...(input.risky === undefined || input.risky === '' ? {} : { risky: input.risky }),
    ...(Object.keys(floorFacts).length === 0 ? {} : { floorFacts }),
    // The project and the shell's folder, for the floor's text check of the command (a project's own globalStorage/ folder is the project's).
    workspace: { root: input.root, cwd: input.shell?.cwd ?? input.root },
    // A path the tool would refuse as outside the project: refused up front, after the floor's own refusals, the emergency stop and the deny list.
    ...(paths.outside === undefined ? {} : { outsideWorkspace: paths.outside.reason }),
    ...(credentialHold === undefined ? {} : { credentialHold }),
    ...(denied === undefined ? {} : { settingsRefusal: { rule: 'settings.deny-list', reason: denied } })
  };
  const captured: { value?: PermissionDecision } = {};
  const sampled = fixture?.sample(runtime);
  const refusal = options.refusal ?? (fixture && (!sampled || !fixture.current(sampled) || !fixture.permits(effects)) ? FIXTURE_REFUSAL : undefined);
  const layer = refusal === undefined ? settingsLayerFor(input, captured) : refusalLayer(refusal);
  let bundleHash = '';
  let decision = await decideOrRefuse(refusal, input.policy.mode, () => {
    const state = sampled ?? runtime.bundleState();
    bundleHash = evaluatedBundleHash(state);
    return decide(request, state, layer, gateOptionsOf(runtime));
  });
  const fixtureCurrent = fixture && !refusal && fixture.current();
  if (fixture && !fixtureCurrent) decision = refusedDecision(decision, FIXTURE_REFUSAL, input.policy.mode);
  const resource: DecisionResource | undefined = input.command === undefined && paths.trustedReads.length > 0 ? { name: trustedReadsName(paths.trustedReads), type: 'file' } : undefined;
  const floorAsk = decision.outcome === 'ask' && decision.floor;
  // A late approval is consumed even when the new decision refuses (PR #74).
  const exactCall = floorCallKey(input);
  const approvedLate = takeFloorApproval(input.grants, exactCall, (runtime.clock ?? Date.now)());
  const callKey = floorAsk ? exactCall : undefined;
  const recordedMark = markOnRecord(runtime, markNow);
  const gated: GatedCall = {
    decision, bundleHash, settings: captured.value, request, effects, ...(fixtureCurrent ? { fixtureGate: fixture } : {}), ...(resource === undefined ? {} : { resource }), ...(callKey === undefined ? {} : { callKey }),
    readLabels: labelCheck.read, maySend, ...(recordedMark === undefined ? {} : { mark: recordedMark }),
    ...(readsCredential === undefined ? {} : { readsCredential }),
    ...(paths.outside === undefined ? {} : { toolMessage: paths.outside.toolMessage })
  };
  const model = options.model === undefined ? undefined : { name: options.model, provider: MODEL_PROVIDER };
  // A fresh floor ask can spend a late approval for this exact call once (D-43).
  if (callKey !== undefined && approvedLate) {
    keep(runtime, recordFor(runtime, gated, 'approved', decision.rule, APPROVED_ONCE_REASON, model));
    return { ...gated, approvedOnce: true };
  }
  keep(runtime, recordFor(runtime, gated, outcomeOf(decision), decision.rule, decision.reason, model));
  return gated;
}

/**
 * Labels follow an agent's rename (D-26, D-42): after a shell command ran, the classifier's own parse says which `mv` or `git mv` it made (after global
 * options, wrappers and `--`). Exactly one rename, with one source and one target inside the project, is followed, and only when the source is gone and the
 * target exists; a move into an existing folder lands under it. Anything else is not followed, and the missing-path report covers it. Never throws.
 */
export async function followCommandMoves(runtime: GateRuntime, input: FloorFactsInput): Promise<void> {
  try {
    const source = runtime.labels?.(input.root);
    if (source?.followMove === undefined) return;
    const read = classifyCommand(input.command, floorClassifierContext(input));
    if (read.movesUnfollowable === true || read.moves === undefined || read.moves.length !== 1) return;
    const move = read.moves[0]!;
    const kind = async (relative: string): Promise<'file' | 'folder' | undefined> => {
      try {
        return (await lstat(path.join(input.root, ...relative.split('/')))).isDirectory() ? 'folder' : 'file';
      } catch {
        return undefined;
      }
    };
    if (await kind(move.from) !== undefined) return;
    let target = move.to;
    const into = `${move.to}/${path.posix.basename(move.from)}`;
    if (await kind(move.to) === 'folder' && await kind(into) !== undefined) target = into;
    const landed = await kind(target);
    if (landed === undefined) return;
    await source.followMove(landed === 'folder' ? `${move.from}/` : move.from, landed === 'folder' ? `${target}/` : target);
  } catch {
    // A rename that cannot be followed leaves the old entry, which the missing-path report names.
  }
}

const APPROVED_ONCE_REASON = 'A person approved this exact call once, after the run had moved on.';

/** Whether a call that is not a shell command can send data off this computer: its tool runs elsewhere, or it reaches the network, sends or publishes. */
function callSendsOffMachine(runsRemote: boolean, effects: readonly Capability[]): boolean {
  if (runsRemote) return true;
  return effects.some((effect) => effect.verb === 'network' || effect.verb === 'send' || effect.verb === 'publish');
}

/** What maySendOffMachine reads about a call. */
export interface MaySendInput {
  /** The tool's manifest says it runs elsewhere (a remote add-on server). */
  readonly runsRemote: boolean;
  readonly effects: readonly Capability[];
  /** A shell command's text; absent for every other tool. */
  readonly command?: string;
  /** True when the classifier could not read the command's effects. */
  readonly effectsUnknown: boolean;
  /** Where the command runs, for the classifier. */
  readonly context: Omit<FloorFactsInput, 'command'>;
}

/**
 * "Can this call send data off this computer", the one fail-closed predicate of D-54 that the credential-read hold (taint.credential-read) and the mark's
 * network verdict (label.network-at-mark) both use: callSendsOffMachine for other tools, and for a shell command, unknown effects or commandMaySend (a reader
 * that throws counts as "may send").
 */
export function maySendOffMachine(input: MaySendInput): boolean {
  if (input.command === undefined) return callSendsOffMachine(input.runsRemote, input.effects);
  return input.effectsUnknown || shellMaySend(input.command, { ...input.context, command: input.command });
}

/** The sentence of label.network-at-mark (D-29): the chat holds content that must stay here, and this call may send data off this computer. */
export const NETWORK_AT_MARK_TEXT = "This chat has read content that must stay on this computer, and this call may send data off it, so it is refused. If what this chat read allows it, use SovAI: Lower This Chat's Label.";

/** The routing a runtime decides by now: the valid policy's, or while it is failed closed the shipped default label and every tier above any-cloud kept here. */
function routingOfRuntime(runtime: GateRuntime): { readonly routing: RoutingTable; readonly defaultLabel: Label } {
  try {
    const state = runtime.bundleState();
    if (state.state === 'valid') return { routing: state.bundle.routing, defaultLabel: state.bundle.defaultLabel };
  } catch { /* failed closed below */ }
  return { routing: routingWhileFailedClosed(), defaultLabel: SHIPPED_DEFAULT_LABEL };
}

/** The tier a mark needs under the runtime's routing; a mark or table that cannot be read needs `deny` (fail closed). */
export function markTierOf(runtime: GateRuntime, mark: Mark): RoutingTier {
  try {
    const { routing, defaultLabel } = routingOfRuntime(runtime);
    return tierForMark(mark, routing, defaultLabel);
  } catch {
    return 'deny';
  }
}

/** The mark a record carries: the mark itself while it is above the policy's default label, otherwise none (D-52). */
function markOnRecord(runtime: GateRuntime, mark: Mark | undefined): Mark | undefined {
  if (mark === undefined) return undefined;
  try {
    return isDefaultMark(mark, routingOfRuntime(runtime).defaultLabel) ? undefined : mark;
  } catch {
    return mark;
  }
}

/** True when a mark is above the runtime's default label: only then does what a session writes take it (D-26). */
export function markAboveDefault(runtime: GateRuntime, mark: Mark): boolean {
  return markOnRecord(runtime, mark) !== undefined;
}

/** The label of the mark that needs the strictest tier: the one a refusal for the mark names. */
function strictestLabel(runtime: GateRuntime, mark: Mark): Label | undefined {
  return strictestLabelOf(mark, routingOfRuntime(runtime).routing);
}

/**
 * The verdict the session's mark gives a call, worked out here so decide() stays pure (D-53): at a local-only or deny mark, a call that may send data off
 * this computer is refused (label.network-at-mark, D-29); at any other mark that is not any-cloud, a call that may send is refused when what it would send
 * carries labelled text the chat read (label.outbound-match, D-60), and when that cannot be checked. Undefined otherwise.
 */
export function markVerdictFor(runtime: GateRuntime, before: Mark | undefined, maySend: boolean, payload: () => readonly string[], outbound: OutboundFingerprints | undefined, reads: readonly Label[] = []): LabelVerdict | undefined {
  if (!maySend) return undefined;
  // The call is judged with everything it shows (PR #87 review round 6): what it reads itself joins the mark before the verdict, since the mark is raised
  // only once it runs, and a command that reads a labelled file and sends it in one step must not leave at the mark it had before.
  const mark = withReads(runtime, before, reads);
  if (mark === undefined) return undefined;
  const tier = markTierOf(runtime, mark);
  if (tier === 'any-cloud') return undefined;
  const label = strictestLabel(runtime, mark);
  if (tier === 'local-only' || tier === 'deny') return { rule: 'label.network-at-mark', reason: NETWORK_AT_MARK_TEXT, ...(label === undefined ? {} : { label }) };
  // A call that itself reads content above any-cloud and may send in the same step: what it reads is not fingerprinted yet, so it is refused (fail closed).
  if (reads.length > 0 && markTierOf(runtime, reads) !== 'any-cloud') {
    const own = strictestLabel(runtime, reads);
    return { rule: 'label.outbound-match', reason: OUTBOUND_READS_AND_SENDS_TEXT, outboundCause: 'reads-and-sends', ...(own === undefined ? {} : { label: own }) };
  }
  // A run with no fingerprint set cannot check what it would send, so at this mark the call is refused (fail closed, PR #87 review).
  if (outbound === undefined) return { rule: 'label.outbound-match', reason: OUTBOUND_UNCHECKED_TEXT, outboundCause: 'unchecked', ...(label === undefined ? {} : { label }) };
  // A labelled read is open (begun by the shared hook, not yet fingerprinted): what it read cannot be checked yet, so the call is refused (fail closed).
  if (outbound.pending > 0) return { rule: 'label.outbound-match', reason: OUTBOUND_UNCHECKED_TEXT, outboundCause: 'pending', ...(label === undefined ? {} : { label }) };
  // Past its bound the set cannot vouch for anything: refused, saying why and what to do (fail closed, owner answer after D-60).
  if (outbound.full) return { rule: 'label.outbound-match', reason: OUTBOUND_FULL_TEXT, outboundCause: 'full', ...(label === undefined ? {} : { label }) };
  let texts: readonly string[];
  try {
    texts = payload();
  } catch {
    return { rule: 'label.outbound-match', reason: OUTBOUND_UNREADABLE_TEXT, outboundCause: 'unreadable', ...(label === undefined ? {} : { label }) };
  }
  const found = outbound.match(texts);
  if (found === undefined) return undefined;
  if (found === 'unreadable') return { rule: 'label.outbound-match', reason: OUTBOUND_UNREADABLE_TEXT, outboundCause: 'unreadable', ...(label === undefined ? {} : { label }) };
  return { rule: 'label.outbound-match', reason: found === 'earlier' ? OUTBOUND_EARLIER_TEXT : OUTBOUND_MATCH_TEXT, outboundCause: found === 'earlier' ? 'earlier' : 'match', ...(label === undefined ? {} : { label }) };
}

/**
 * The sentence of label.mcp-ceiling (WP-GATE): the chat's label is above the highest label the policy lets this MCP server receive, so nothing was sent to
 * it. It names the server, the label that is too high and the ceiling, and the two ways on: a chat that has not read that content, or a policy change. It
 * names Lower This Chat's Label too, so the chat offers that button under the refusal.
 */
export function mcpCeilingText(server: string, above: Label, ceiling: Clearance): string {
  return `This chat holds content at ${labelKeyShown(above)}, above the highest label your policy lets the MCP server "${server}" receive (${labelKeyShown(ceiling)}${ceiling.expiresAt === undefined ? '' : `, until ${ceiling.expiresAt}`}), so nothing was sent to it. Use this server from a chat that has not read that content, or change its ceiling in SovAI: Policy with Edit my rules. If what this chat read allows it, use SovAI: Lower This Chat's Label.`;
}

/** The sentence of label.mcp-ceiling when the ceiling could not be checked (review round 1): the call is refused, fail closed, and no label is blamed. */
export function mcpCeilingUnjudgedText(server: string): string {
  return `SovAI could not check this chat's label against the highest label your policy lets the MCP server "${server}" receive, so the call was refused and nothing was sent to it. Try again; if it keeps happening, reload the window or check the server's ceiling in SovAI: Policy.`;
}

/**
 * The verdict an MCP server's label ceiling gives a call to it (WP-GATE, research note 01 section 4), worked out here so decide() stays pure. Every call to a
 * server the valid policy names in `ceiling.mcpLabelCeilings` is judged, whatever the routing tier and whether or not the call is thought to send off this
 * computer, because the server receives the arguments wherever it runs. The chat's mark, joined with what the call reads itself, must be dominated by the
 * ceiling, label by label; an empty mark is the policy's default label. A server with no ceiling, or a policy that is not valid (which refuses every MCP
 * call on its own), gives no verdict. A ceiling that cannot be judged (a lookup that throws) refuses: fail closed.
 */
export function mcpCeilingVerdictFor(runtime: GateRuntime, server: string | undefined, before: Mark | undefined, reads: readonly Label[] = []): LabelVerdict | undefined {
  if (server === undefined) return undefined;
  let state: BundleState;
  try {
    state = runtime.bundleState();
  } catch {
    return undefined; // decide() asks the same runtime and fails closed on its own
  }
  if (state.state !== 'valid') return undefined;
  const ceilings = state.bundle.ceiling.mcpLabelCeilings;
  if (ceilings === undefined || !Object.prototype.hasOwnProperty.call(ceilings, server)) return undefined;
  const ceiling = ceilings[server] as Clearance;
  try {
    const joined = withReads(runtime, before, reads);
    const mark: Mark = joined === undefined || joined.length === 0 ? [state.bundle.defaultLabel] : joined;
    const context = { scales: state.bundle.scales, mappings: state.bundle.mappings, now: (runtime.clock ?? Date.now)() };
    const above = mark.find((label) => whyNotDominated(ceiling, label, context) !== undefined);
    return above === undefined ? undefined : { rule: 'label.mcp-ceiling', reason: mcpCeilingText(server, above, ceiling), label: above };
  } catch {
    // Nothing was judged, so no label is named as the one above the ceiling (review round 1): the refusal and its record say the check could not be made.
    return { rule: 'label.mcp-ceiling', reason: mcpCeilingUnjudgedText(server) };
  }
}

/** The mark joined with the labels a call reads itself, without changing the run's mark; undefined when there is neither. */
function withReads(runtime: GateRuntime, mark: Mark | undefined, reads: readonly Label[]): Mark | undefined {
  if (reads.length === 0) return mark;
  const joined = new SessionMark(mark ?? []);
  joined.raise(reads, scalesOf(runtime));
  return joined.current();
}

/** What carries a run's mark and fingerprints: a run's grants, shared with every sub-agent (D-54). */
export interface MarkCarrier {
  readonly mark?: SessionMark | undefined;
  readonly outbound?: OutboundFingerprints | undefined;
}

/** One read of content, from the shared hook: more labels may join it (a search's results), and it is settled once with what was read. */
export interface LabelledRead {
  /** Adds the labels of more of what the call read (Glob and Grep results), raising the mark by them now. */
  add(labels: readonly Label[]): void;
  /** The call finished: what it returned is fingerprinted when what it read needs a tier above any-cloud and the call cannot send; undefined when it failed. */
  settle(output: string | undefined): void;
}

/**
 * The one shared hook (D-54, PR #87 review round 3) for content a call or step reads: it raises the run's mark by the labels of what is read (recording the
 * rise once), and it feeds that content's fingerprints when it is settled (D-60), so the mark and the fingerprints never diverge. While a labelled read is
 * open, the fingerprint set reports it pending and a call that could send is refused. The chat loop, its sub-agents and the cyber step engine all read
 * through it; no other place raises a mark from content or adds a fingerprint.
 */
export function beginLabelledRead(runtime: GateRuntime, carrier: MarkCarrier, labels: readonly Label[], maySend: boolean, source: string, options: Pick<GateCallOptions, 'model'> = {}): LabelledRead {
  const read: Label[] = [];
  let opened = false;
  let settled = false;
  const take = (more: readonly Label[]): void => {
    if (more.length === 0) return;
    read.push(...more);
    raiseRunMark(runtime, carrier.mark, more, source, options);
    if (!opened && !maySend && carrier.outbound !== undefined && markTierOf(runtime, read) !== 'any-cloud') {
      opened = true;
      carrier.outbound.open();
    }
  };
  take(labels);
  return {
    add: take,
    settle: (output) => {
      if (settled) return;
      settled = true;
      if (opened) carrier.outbound?.settle(output);
    }
  };
}

/** Raises a run's mark and records the rise once when it really rose. Only the shared hook above calls it. */
function raiseRunMark(runtime: GateRuntime, mark: SessionMark | undefined, labels: readonly Label[], source: string, options: Pick<GateCallOptions, 'model'> = {}): boolean {
  if (mark === undefined || labels.length === 0) return false;
  const before = mark.current();
  if (!mark.raise(labels, scalesOf(runtime))) return false;
  recordMarkRaised(runtime, mark.current(), source, options, before);
  return true;
}

/**
 * Records a rise of the session's mark (GATE-07, D-54): one label.mark-raised record with the whole mark, written only when the mark actually rose. `source`
 * names what raised it (the tool), never a path's contents. Never throws.
 */
export function recordMarkRaised(runtime: GateRuntime, mark: Mark, source: string, options: Pick<GateCallOptions, 'model'> = {}, from?: Mark): void {
  try {
    const record = buildDecisionRecord({
      recordId: (runtime.newRecordId ?? randomUUID)(),
      sequence: 0,
      time: (runtime.clock ?? Date.now)(),
      productVersion: productVersionOf(runtime),
      actor: runtime.actor,
      ...(options.model === undefined ? {} : { model: { name: options.model, provider: MODEL_PROVIDER } }),
      callId: `label.mark-raised-${(runtime.newRecordId ?? randomUUID)()}`,
      capability: { verb: 'plan' },
      resource: { name: shownName(source).slice(0, 120), type: 'label' },
      outcome: 'allowed',
      rule: 'label.mark-raised',
      reason: 'What an agent of this chat read raised the chat\'s label.',
      bundleHash: bundleHashOf(runtime),
      // Every label event: `mark` is the chat's mark after it, `label` its target (the strictest label of the new mark), `from` the mark before.
      ...(strictestLabel(runtime, mark) === undefined ? {} : { label: strictestLabel(runtime, mark)! }),
      mark,
      ...(from === undefined ? {} : { from })
    });
    keep(runtime, { ...record, api: { ...record.api, operation: 'label.mark-raised' } });
  } catch {
    // A record that cannot be kept never changes the mark (D-21).
  }
}

/** commandMaySend with the floor's own context; a reader that throws counts as "may send" (fail closed). */
function shellMaySend(command: string, input: FloorFactsInput): boolean {
  try {
    return commandMaySend(command, floorClassifierContext(input));
  } catch {
    return true;
  }
}

function credentialHoldReason(file: string, command: boolean): string {
  return `This run has read ${shownName(file).slice(0, 120)}, which may hold credentials, and this ${command ? 'command' : 'call'} may send data off this computer. It asks in every mode after such a read; approve it only if you expect it.`;
}

/** How long a late floor approval waits for its call (PR #74 review round 5): long enough for the lead to retry it, short enough not to linger. */
export const FLOOR_APPROVAL_TTL_MS = 5 * 60_000;

/**
 * Floor calls a person approved late, once each, for one run's turn (D-43, Pitfall 4). Each is used up by the next decision of that exact call, whatever its
 * outcome, expires after FLOOR_APPROVAL_TTL_MS, and all end with the turn (endFloorApprovals); an approval given after the end is not kept.
 */
export class FloorApprovalsOnce {
  private readonly expiries = new Map<string, number>();
  private ended = false;

  /** A person approved this exact call once, late, at `now` by the runtime's clock (the one the gate checks it with). */
  public add(key: string, now: number): void {
    if (this.ended) return;
    this.prune(now);
    this.expiries.set(key, now + FLOOR_APPROVAL_TTL_MS);
  }

  /** Whether an approval of this exact call is waiting and has not expired. */
  public has(key: string, now: number): boolean {
    this.prune(now);
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
    return good;
  }

  /** Drops every approval that has expired by `now`, so ones never retried do not wait for the end of the turn. */
  private prune(now: number): void {
    for (const [other, expires] of [...this.expiries]) if (now >= expires) this.expiries.delete(other);
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

/** A person approved a floor card late: that exact call may run once, stamped with `clock`, the clock of the runtime whose gate will check it. */
export function approveFloorCallLate(grants: RunGrants, callKey: string, clock: () => number): void {
  floorApprovalsOnce(grants).add(callKey, clock());
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
  /** The command the step runs, which the floor reads as it reads a chat's shell call (PR #74 review round 7). */
  readonly command?: string;
  /** The folder the step's command runs in. A command with no folder to read it in has unknown effects. */
  readonly root?: string;
  readonly manifestContexts?: readonly GateContextName[];
  readonly policy: ActionPolicy;
  /** Today's answer for this step, with the stable rule id that gave it. */
  readonly settings: SettingsAnswer;
  /** What the floor must know about the paths the step names (a credential store, the identity folders). */
  readonly floorFacts?: Pick<FloorFacts, 'credentialStore' | 'identityFiles'>;
  /** What the record names when the effects alone would not say it. */
  readonly resource?: DecisionResource;
  /** The run's mark (D-54): a cyber run carries one of its own at the project's label. */
  readonly mark?: SessionMark;
  /**
   * Everything the step would send (PR #87 review round 3): its tool's arguments, its args and its target. The outbound check reads all of it, with the
   * command, never the command alone.
   */
  readonly raw?: Record<string, unknown>;
  /** The step's tool runs elsewhere (a remote add-on server, PR #87 review round 6): it can send data off this computer whatever effects it declares. */
  readonly runsRemote?: boolean;
  /** The run's fingerprints of labelled text it read (D-60). */
  readonly outbound?: OutboundFingerprints;
  /** The MCP server the step's tool calls, when it is an MCP tool: its label ceiling is judged as a chat call's is (WP-GATE). */
  readonly mcpServer?: string;
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
  // A step's command is read by the floor exactly as a chat's shell call is: one code path, floorFactsFor.
  const read = input.command === undefined ? undefined
    : input.root === undefined ? { effects: [], facts: {}, effectsUnknown: 'the step names no folder to read its command in' }
    : await floorFactsFor({ command: input.command, root: input.root, ...(runtime.locations ?? {}) }, options.floorReaders);
  const effects = effectsWithReading(input.effects, read);
  const floorFacts = { ...(input.floorFacts ?? {}), ...(read?.facts ?? {}) };
  // A cyber step's reads are checked against the labels exactly as a chat call's are (CLAS-03).
  const labelCheck = input.root === undefined ? { read: [] } : await labelCheckFor(runtime, {
    root: input.root,
    reads: readEffectPaths(effects.length > 0 ? effects : input.effects),
    ...(input.command === undefined ? {} : { command: input.command }),
    mayReadAnything: input.command !== undefined || effects.length === 0
  });
  // The run's own mark (a cyber run has one at the project's label, D-54) holds a step that may send at a strict mark, by the same predicate as a chat call.
  const maySend = maySendOffMachine({ runsRemote: input.runsRemote === true, effects, ...(input.command === undefined ? {} : { command: input.command }), effectsUnknown: read?.effectsUnknown !== undefined || (input.command === undefined && effects.length === 0), context: { root: input.root ?? '', ...(runtime.locations ?? {}) } });
  const markNow = input.mark?.current();
  const labelVerdict = labelCheck.verdict ?? mcpCeilingVerdictFor(runtime, input.mcpServer, markNow, labelCheck.read)
    ?? markVerdictFor(runtime, markNow, maySend, () => outboundPayload(input.raw ?? {}, input.command), input.outbound, labelCheck.read);
  const request: GateRequest = {
    actor: runtime.actor,
    tool: input.tool,
    callId: input.callId,
    effects,
    ...(labelVerdict === undefined ? {} : { labelVerdict }),
    context: runtime.context,
    presence: runtime.presence,
    policy: input.policy,
    ...(input.manifestContexts === undefined ? {} : { manifestContexts: input.manifestContexts }),
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(Object.keys(floorFacts).length === 0 ? {} : { floorFacts }),
    ...(input.root === undefined ? {} : { workspace: { root: input.root } }),
    // A step the caller's settings already refuse (its deny list, an engagement's scope) is refused before any ask, unknown effects included (D-10).
    ...(input.settings.decision === 'deny' ? { settingsRefusal: { rule: input.settings.rule, reason: input.settings.reason ?? 'Your settings refuse this step.' } } : {})
  };
  const answered: SettingsAnswer = options.refusal === undefined ? input.settings : { decision: 'deny', reason: options.refusal.reason, rule: options.refusal.rule };
  let bundleHash = '';
  const decision = await decideOrRefuse(options.refusal, input.policy.mode, () => {
    const state = runtime.bundleState();
    bundleHash = evaluatedBundleHash(state);
    return decide(request, state, async () => answered, gateOptionsOf(runtime));
  });
  const recordedMark = markOnRecord(runtime, markNow);
  const gated: GatedCall = { decision, bundleHash, settings: undefined, request, effects, ...(input.resource === undefined ? {} : { resource: input.resource }), readLabels: labelCheck.read, maySend, ...(recordedMark === undefined ? {} : { mark: recordedMark }) };
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
  let bundleHash = '';
  try {
    const fixture = gated.fixtureGate;
    const sampled = fixture ? fixture.sample(runtime) : runtime.bundleState();
    bundleHash = evaluatedBundleHash(sampled);
    if (sampled && (!fixture || fixture.current(sampled))) again = await decide(gated.request, sampled, ANSWERED, gateOptionsOf(runtime));
    else again = refusedDecision(undefined, FIXTURE_REFUSAL, gated.request.policy.mode);
    if (fixture && !fixture.current()) again = refusedDecision(again, FIXTURE_REFUSAL, gated.request.policy.mode);
  } catch {
    again = { outcome: 'deny', rule: 'bundle.failed-closed', reason: 'SovAI could not check this call again, so it was not run.', floor: false, offerAlwaysAllow: false, allowGrant: false, effectiveMode: 'approve-risky' };
  }
  if (again.outcome === 'deny') {
    const refused: GatedCall = { ...gated, decision: again, bundleHash };
    keep(runtime, recordFor(runtime, refused, outcomeOf(again), again.rule, again.reason, model));
    return { proceed: false, rule: again.rule, reason: again.reason ?? 'This is no longer allowed.' };
  }
  keep(runtime, recordFor(runtime, { ...gated, bundleHash }, 'approved', gated.decision.rule, undefined, model));
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

// The runtime of a run with no gate host
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

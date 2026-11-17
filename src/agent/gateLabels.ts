// The label side of the gate's caller (CLAS-03, D-28, D-53, D-59): works out the label verdict for a call from the paths it names, the project's label map
// and the policy's clearances, and hands it to decide() as GateRequest.labelVerdict. decide() stays pure; everything that reads a file is here. No vscode.
//
// What a call names: the paths its read effects name (a pattern by the folder it starts in), and for a shell command every word, resolved from the shell's
// folder, with path-like words also followed through links within a fixed bound (the same words the credential-read check reads, so the two never
// disagree). A read the text does not show (a path built in a variable, a recursive search) is not seen: that is a documented limit, as it is for the
// credential-read check, and the label words in LABELS_NOT_ACCREDITATION_TEXT say a shell command cannot be fully seen.
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import type { GateRuntime, LabelVerdict } from '../domain/gate/decide';
import { whyNotDominated } from '../domain/gate/dominance';
import type { DominanceContext, DominanceReason, Mark } from '../domain/gate/dominance';
import { holdsReads } from '../domain/gate/labelMap';
import type { LabelSource, LabelView } from '../domain/gate/labelMap';
import { SCALE_PRESETS, labelKey } from '../domain/gate/labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from '../domain/gate/labels';
import type { Capability } from '../domain/gate/vocabulary';
import { hostlessLabelReader } from '../gate/labelMapStore';
import { MAX_COMMAND_LENGTH, MAX_COMMAND_WORDS } from './commandSafety';

/** A broken policy holds no clearances (D-53): anything above the shipped default label is refused with this sentence. */
export const FAILED_CLOSED_LABEL_TEXT =
  'Your policy file cannot be trusted right now, so NEAR AI cannot check your clearance, and labelled files cannot be read. Run NEAR AI: Reset Policy to Defaults.';

/** Added to every refusal for a clearance, so the person knows the one way to declare one. */
export const ADD_CLEARANCE_HINT = 'If you hold a clearance for it, add it with NEAR AI: Edit Policy.';

/** How many words of a command are followed through links when looking for what it reads (the credential-read check uses the same bound). */
export const COMMAND_LINK_CHECKS = 64;

/** A word that looks like a path, so it is worth resolving through links: it has a `/`, or starts with `~` or `.` (PR #76 review round 2). */
export function pathLike(word: string): boolean {
  return word.includes('/') || word.startsWith('~') || word.startsWith('.');
}

/**
 * The words of a command that could name a file, in order: the text within the classifier's bounds split at spaces, quotes and shell punctuation, without
 * options and without words that hold a variable. The one split the credential-read check and the label check both use.
 */
export function commandWords(command: string): string[] {
  const readable = command.slice(0, MAX_COMMAND_LENGTH);
  return readable.split(/[\s'"`;&|()<>=]+/).filter((word) => word !== '' && !word.startsWith('-') && !word.includes('$')).slice(0, MAX_COMMAND_WORDS);
}

/** Resolves a path through links once per call, within the bound; a path past the bound or that cannot be resolved gives undefined. */
export function linkResolver(options: { realpath?: (target: string) => Promise<string> } = {}): (absolute: string) => Promise<string | undefined> {
  const resolved = new Map<string, Promise<string | undefined>>();
  return (absolute) => {
    let found = resolved.get(absolute);
    if (found === undefined) {
      if (resolved.size >= COMMAND_LINK_CHECKS) return Promise.resolve(undefined);
      found = (options.realpath ?? realpath)(absolute).then((real) => real, () => undefined);
      resolved.set(absolute, found);
    }
    return found;
  };
}

/** The folders a command line changes into with `cd` or `pushd`, as written (a folder named by a variable is not seen). */
function changedFolders(command: string): string[] {
  const out: string[] = [];
  for (const match of command.slice(0, MAX_COMMAND_LENGTH).matchAll(/(?:^|[\s;&|(])(?:cd|pushd)\s+(?:--\s+)?(['"]?)([^\s'";&|()$`]+)\1/g)) out.push(match[2]!);
  return out;
}

/** The project-relative form of an absolute path inside `root` ('' for the root itself), or undefined outside it. */
function insideRelative(root: string, absolute: string): string | undefined {
  const relative = path.relative(path.resolve(root), absolute);
  if (relative === '') return '';
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
  return relative.split(path.sep).join('/');
}

/** The fixed part of a pattern before its first glob character, as a folder key when it ends at a `/` (`src/**` names `src/`). */
function patternBase(pattern: string): string {
  const at = pattern.search(/[*?[{]/);
  if (at < 0) return pattern;
  const fixed = pattern.slice(0, at);
  const slash = fixed.lastIndexOf('/');
  return slash < 0 ? '' : fixed.slice(0, slash + 1);
}

/** The project-relative paths the read effects of a call name. A pattern names the folder it starts in; `**` names the project. */
export function readEffectPaths(effects: readonly Capability[]): string[] {
  const out: string[] = [];
  for (const effect of effects) {
    if (effect.verb !== 'read') continue;
    for (const pattern of effect.paths) out.push(patternBase(String(pattern)));
  }
  return out;
}

export interface NamedPathsInput {
  readonly root: string;
  /** The read effects' paths, project-relative (readEffectPaths). */
  readonly reads: readonly string[];
  /** A shell command, read word by word from `cwd`. */
  readonly command?: string;
  readonly cwd?: string;
  readonly realpath?: (target: string) => Promise<string>;
}

/**
 * Every project-relative path a call names (D-28): each read path and its real path through links, and for a command every word resolved from its folder
 * (a path-like one also through links). A word may be a folder, so it is checked both as a file and as a folder by the caller.
 */
export async function namedPaths(input: NamedPathsInput): Promise<string[]> {
  return [...(await namedReads(input)).paths];
}

/** What a call names: plain paths, glob patterns (project-relative, checked against every entry they could match), and whether a glob is unbounded. */
export interface NamedReads {
  readonly paths: readonly string[];
  readonly patterns: readonly string[];
  /** True when a word holds both a variable and a glob, so what it matches cannot be bounded: the strictest label in the project decides. */
  readonly unbounded: boolean;
}

const GLOB_CHARS = /[*?[{]/;

export async function namedReads(input: NamedPathsInput): Promise<NamedReads> {
  const out = new Set<string>();
  const patterns = new Set<string>();
  let unbounded = false;
  const follow = linkResolver(input.realpath === undefined ? {} : { realpath: input.realpath });
  const add = (relative: string | undefined): void => { if (relative !== undefined) out.add(relative); };
  for (const read of input.reads) {
    add(read === '**' ? '' : read);
    if (read !== '' && read !== '**' && !read.endsWith('/')) {
      const real = await follow(path.resolve(input.root, read));
      if (real !== undefined) add(insideRelative(input.root, real));
    }
  }
  if (input.command !== undefined && input.command.trim() !== '') {
    // Every word is read from the shell's folder and from each folder the command itself changes into (`cd secret && cat plan.md`), so a read written
    // relative to a folder the line moves to is still seen.
    const cwd = input.cwd ?? input.root;
    const folders = [cwd, ...changedFolders(input.command).map((folder) => path.resolve(cwd, folder))].slice(0, 8);
    // A glob next to a variable (`"$DIR"/*.md`) matches what the variable holds at run time: it cannot be bounded (PR #85 review).
    unbounded = input.command.slice(0, MAX_COMMAND_LENGTH).split(/\s+/).some((token) => /[$`]/.test(token) && GLOB_CHARS.test(token.replace(/\$\{[^}]*\}/g, '')));
    for (const word of commandWords(input.command)) {
      const glob = GLOB_CHARS.test(word);
      const literal = glob ? patternBase(word) : word;
      for (const folder of folders) {
        const absolute = path.resolve(folder, literal === '' ? '.' : literal);
        add(insideRelative(input.root, absolute));
        // The glob itself, as a project-relative pattern, so every labelled entry it could match is checked (PR #85 review: `cat secret/*.md`).
        if (glob) {
          const pattern = insideRelative(input.root, path.resolve(folder, word));
          if (pattern !== undefined) patterns.add(pattern);
        }
        if (pathLike(word) && literal === word) {
          const real = await follow(absolute);
          if (real !== undefined && real !== absolute) add(insideRelative(input.root, real));
        }
      }
    }
  }
  return { paths: [...out], patterns: [...patterns], unbounded };
}

/** A shell glob as an anchored expression over project-relative paths: `**` any folders, `*` and `?` within one name, `[...]` and `{a,b}` as the shell reads them. */
function globExpression(pattern: string): RegExp | undefined {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') { out += '.*'; index += 1; if (pattern[index + 1] === '/') index += 1; } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 2);
      if (end < 0) return undefined;
      const body = pattern.slice(index + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      out += `[${body}]`;
      index = end;
    } else if (char === '{') {
      const end = pattern.indexOf('}', index);
      if (end < 0) return undefined;
      out += `(?:${pattern.slice(index + 1, end).split(',').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('|')})`;
      index = end;
    } else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return undefined;
  }
}

/**
 * The labelled entries a glob could match (PR #85 review): a file entry the expression matches, and every folder entry inside the glob's fixed folder
 * (what a folder holds is not known here, so it counts, fail closed). A glob the expression cannot read counts every entry inside its fixed folder.
 */
export function entriesMatching(pattern: string, keys: readonly string[]): string[] {
  const base = patternBase(pattern);
  const expression = globExpression(pattern);
  return keys.filter((key) => {
    if (!key.startsWith(base) && !base.startsWith(key)) return false;
    if (key.endsWith('/') || expression === undefined) return true;
    return expression.test(key);
  });
}

/** What the clearance check reads from the policy now: a valid policy's own, or a failed-closed one's (no clearances, the shipped default label). */
interface ClearanceFacts {
  readonly valid: boolean;
  readonly clearances: readonly Clearance[];
  readonly mappings: readonly ScaleMapping[];
  readonly scales: ScaleTable;
  readonly defaultLabel: Label;
  readonly now: number;
}

function clearanceFactsOf(state: BundleState, now: number): ClearanceFacts {
  if (state.state === 'valid') {
    try {
      const bundle = state.bundle;
      return { valid: true, clearances: bundle.clearances, mappings: bundle.mappings, scales: bundle.scales, defaultLabel: bundle.defaultLabel, now };
    } catch { /* a state that cannot be read is treated as failed closed below */ }
  }
  return { valid: false, clearances: [], mappings: [], scales: SCALE_PRESETS, defaultLabel: SHIPPED_DEFAULT_LABEL, now };
}

function stateOf(runtime: GateRuntime): BundleState | undefined {
  try {
    return runtime.bundleState();
  } catch {
    return undefined;
  }
}

function nowOf(runtime: GateRuntime): number {
  try {
    const now = runtime.clock?.();
    if (typeof now === 'number' && Number.isFinite(now)) return now;
  } catch { /* the system clock below */ }
  return Date.now();
}

/** The label source of a runtime, or one that reads the project's file trusting no key (a run with no gate host): a label it finds only raises. */
function sourceOf(runtime: GateRuntime, root: string): LabelSource {
  return runtime.labels?.(root) ?? hostlessLabelReader(root);
}

function shownLabel(label: Label): string {
  const compartments = label.compartments.length === 0 ? '' : ` (compartments ${label.compartments.join(', ')})`;
  return `${labelKey(label)}${compartments}`;
}

function isShippedDefault(label: Label): boolean {
  return labelKey(label) === labelKey(SHIPPED_DEFAULT_LABEL) && label.compartments.length === 0 && label.releasability.length === 0 && label.handling.length === 0;
}

/** The plain reason a label is not covered: from the clearance on the label's own scale when there is one, otherwise "no clearance on that scale". */
function notCoveredReason(label: Label, facts: ClearanceFacts): { readonly reason: DominanceReason; readonly clearance?: Clearance } | undefined {
  const context: DominanceContext = { scales: facts.scales, mappings: facts.mappings, now: facts.now };
  const verdicts = facts.clearances.map((clearance) => ({ clearance, reason: whyNotDominated(clearance, label, context) }));
  if (verdicts.some((each) => each.reason === undefined)) return undefined;
  const sameScale = verdicts.find((each) => each.clearance.scale === label.scale);
  if (sameScale !== undefined && sameScale.reason !== undefined) return { reason: sameScale.reason, clearance: sameScale.clearance };
  return { reason: 'no-clearance' };
}

/** One plain sentence per reason (D-27, DOMINANCE_REASONS). Never calls a clearance verified. */
export function notCoveredSentence(label: Label, reason: DominanceReason, clearance?: Clearance): string {
  const shown = shownLabel(label);
  switch (reason) {
    case 'no-clearance':
    case 'scale':
      return `This file is labelled ${shown}, and your policy gives you no clearance on that scale. ${ADD_CLEARANCE_HINT}`;
    case 'level':
      return `This file is labelled ${shown}, and your clearance on that scale is lower. ${ADD_CLEARANCE_HINT}`;
    case 'compartment':
      return `This file is labelled ${shown}, and your clearance does not hold every compartment it names. ${ADD_CLEARANCE_HINT}`;
    case 'releasability':
      return `This file is labelled ${shown}, and your clearance does not meet who it may be released to. ${ADD_CLEARANCE_HINT}`;
    case 'expired':
      return `This file is labelled ${shown}, and your clearance for it ended${clearance?.expiresAt === undefined ? '' : ` on ${clearance.expiresAt.slice(0, 10)}`}. ${ADD_CLEARANCE_HINT}`;
  }
}

/** The verdict for one resolved mark, or undefined when the clearances cover it. */
function markVerdict(mark: Mark, facts: ClearanceFacts): LabelVerdict | undefined {
  for (const label of mark) {
    if (label.handling.includes('no-agent-tools')) {
      return { rule: 'label.no-agent-tools', reason: `This file is labelled ${shownLabel(label)} and marked to stay away from agent tools, so no agent may read it.`, label };
    }
  }
  for (const label of mark) {
    // A broken policy holds no clearances: only the shipped default label may be read (D-53).
    if (!facts.valid) {
      if (!isShippedDefault(label)) return { rule: 'label.dominance', reason: FAILED_CLOSED_LABEL_TEXT, label };
      continue;
    }
    const why = notCoveredReason(label, facts);
    if (why !== undefined) return { rule: 'label.dominance', reason: notCoveredSentence(label, why.reason, why.clearance), label };
  }
  return undefined;
}

/** The mark of a path read both as a file and as a folder: a word may name either, so the stricter of the two applies. */
function markOf(view: LabelView, relative: string, defaultLabel: Label): Mark {
  const asFile = view.resolve(relative, defaultLabel).mark;
  if (relative === '' || relative.endsWith('/')) return asFile;
  const asFolder = view.resolve(`${relative}/`, defaultLabel).mark;
  return JSON.stringify(asFolder) === JSON.stringify(asFile) ? asFile : [...asFile, ...asFolder];
}

export interface LabelCheckInput extends NamedPathsInput {
  /** True when the call's effects are unknown or it runs a command: it may read anything in the project, so a held map holds it too. */
  readonly mayReadAnything?: boolean;
  /** True when the call reads the extension's own installed files (the Open-GSD runtime): judged at the policy's default label (D-63). */
  readonly defaultReads?: boolean;
}

/** The label verdict of a call, and the labels of what it reads (CLAS-04): the labels the session's mark is raised by once the call runs. */
export interface LabelCheck {
  readonly verdict?: LabelVerdict;
  /** One entry per distinct label resolved for the paths the call names (a word read as a file and as a folder gives both). Empty when the call is refused. */
  readonly read: readonly Label[];
}

function addLabels(out: Label[], mark: Mark): void {
  for (const label of mark) if (!out.some((held) => labelKey(held) === labelKey(label) && JSON.stringify(held) === JSON.stringify(label))) out.push(label);
}

/**
 * The label verdict of a call (CLAS-03, D-28, D-53, D-59), worked out before decide() runs. Undefined when nothing the call names is above the clearances.
 * A project whose label file cannot be read, or was deleted or rolled back, holds every read in it. Never throws: a check that fails refuses.
 */
export async function labelVerdictFor(runtime: GateRuntime, input: LabelCheckInput): Promise<LabelVerdict | undefined> {
  return (await labelCheckFor(runtime, input)).verdict;
}

/**
 * The label check of a call (CLAS-03, CLAS-04): the verdict labelVerdictFor gives, and the labels of every path it names, globs and an unbounded glob
 * included, which raise the session's mark when the call runs (D-54). A read the text does not show is not in it (the documented shell limit).
 */
export async function labelCheckFor(runtime: GateRuntime, input: LabelCheckInput): Promise<LabelCheck> {
  try {
    const named = await namedReads(input);
    const paths = named.paths;
    const projectNamed = paths.length > 0 || named.patterns.length > 0 || named.unbounded;
    if (!projectNamed && input.mayReadAnything !== true && input.defaultReads !== true) return { read: [] };
    const state = stateOf(runtime);
    const facts = state === undefined ? clearanceFactsOf({ state: 'failed-closed' } as BundleState, nowOf(runtime)) : clearanceFactsOf(state, nowOf(runtime));
    const view = await sourceOf(runtime, input.root).view(facts.scales);
    // A held label file holds every project read, path by path (D-67): a call that names a project path, or may read anything (a command, effects nobody
    // can read), is held; a read of the extension's own Open-GSD runtime alone goes on, judged at the default label below.
    if (holdsReads(view.state) && (projectNamed || input.mayReadAnything === true)) return { verdict: { rule: 'label.dominance', reason: view.problem ?? FAILED_CLOSED_LABEL_TEXT }, read: [] };
    const read: Label[] = [];
    for (const relative of paths) {
      const mark = markOf(view, relative, facts.defaultLabel);
      const verdict = markVerdict(mark, facts);
      if (verdict !== undefined) return { verdict, read: [] };
      addLabels(read, mark);
    }
    // Globs: every entry a glob could match; an unbounded glob: every entry and the project's own label, so the strictest label in scope decides.
    const keys = view.keys();
    const reached = named.unbounded ? ['', ...keys] : named.patterns.flatMap((pattern) => entriesMatching(pattern, keys));
    for (const key of [...new Set(reached)]) {
      const mark = view.resolve(key, facts.defaultLabel).mark;
      const verdict = markVerdict(mark, facts);
      if (verdict !== undefined) return { verdict, read: [] };
      addLabels(read, mark);
    }
    if (input.defaultReads === true) {
      const verdict = markVerdict([facts.defaultLabel], facts);
      if (verdict !== undefined) return { verdict, read: [] };
      addLabels(read, [facts.defaultLabel]);
    }
    return { read };
  } catch {
    return { verdict: { rule: 'label.dominance', reason: 'NEAR AI could not check the labels of what this call reads, so it was refused rather than guessed. Try again.' }, read: [] };
  }
}

/**
 * The labels of project-relative paths a search returned (Glob, Grep), so they raise the session's mark before the results reach the model (CLAS-04,
 * D-54). A path outside the project (the Open-GSD runtime) is at the default label. Throws when the labels cannot be read, which the caller treats as a
 * refusal of the results.
 */
export async function labelsOfPaths(runtime: GateRuntime, root: string, relativePaths: readonly string[]): Promise<Label[]> {
  const state = stateOf(runtime);
  const facts = state === undefined ? clearanceFactsOf({ state: 'failed-closed' } as BundleState, nowOf(runtime)) : clearanceFactsOf(state, nowOf(runtime));
  const view = await sourceOf(runtime, root).view(facts.scales);
  const out: Label[] = [];
  for (const relative of new Set(relativePaths)) {
    const inside = insideRelative(root, path.resolve(root, relative));
    addLabels(out, inside === undefined ? [facts.defaultLabel] : view.resolve(inside, facts.defaultLabel).mark);
  }
  return out;
}

/** The project's resolved label (its own entry, or the policy's default label), where a new chat's mark and a run with no chat start (CLAS-04). */
export async function projectLabelOf(runtime: GateRuntime, root: string): Promise<Mark> {
  const state = stateOf(runtime);
  const facts = state === undefined ? clearanceFactsOf({ state: 'failed-closed' } as BundleState, nowOf(runtime)) : clearanceFactsOf(state, nowOf(runtime));
  try {
    const view = await sourceOf(runtime, root).view(facts.scales);
    return view.resolve('', facts.defaultLabel).mark;
  } catch {
    return [facts.defaultLabel];
  }
}

/** The scales labels are joined on now: the valid policy's, or the shipped presets while it is failed closed. */
export function scalesOf(runtime: GateRuntime): ScaleTable {
  const state = stateOf(runtime);
  return (state === undefined ? clearanceFactsOf({ state: 'failed-closed' } as BundleState, nowOf(runtime)) : clearanceFactsOf(state, nowOf(runtime))).scales;
}

/**
 * Whether an agent may see a project-relative path in a search's results (Glob, Grep): built once per call from the runtime's labels and clearances. A
 * path the clearances do not cover is left out, the way Grep leaves out credential files. A project whose label file is held hides every project path; a
 * result outside the project (the Open-GSD runtime) is judged at the default label (D-63, D-67).
 */
export async function labelReadFilter(runtime: GateRuntime, root: string): Promise<(relativePath: string) => boolean> {
  try {
    const state = stateOf(runtime);
    const facts = state === undefined ? clearanceFactsOf({ state: 'failed-closed' } as BundleState, nowOf(runtime)) : clearanceFactsOf(state, nowOf(runtime));
    const view = await sourceOf(runtime, root).view(facts.scales);
    // While the label file holds reads, every project result is hidden and a result outside the project is still judged at the default label (D-67).
    const held = holdsReads(view.state);
    let realRoot: string;
    try { realRoot = realpathSync(root); } catch { realRoot = path.resolve(root); }
    return (relativePath) => {
      try {
        // A result outside the project (a search of the Open-GSD runtime) is judged at the default label (D-63), unless its real place, links followed, is
        // in the project: then it keeps the project's label for that place, so a link cannot launder one.
        const absolute = path.resolve(root, relativePath);
        let inside = insideRelative(root, absolute);
        if (inside === undefined) {
          let real: string | undefined;
          try { real = realpathSync(absolute); } catch { real = undefined; }
          inside = real === undefined ? undefined : insideRelative(realRoot, real);
          if (inside === undefined) return markVerdict([facts.defaultLabel], facts) === undefined;
        }
        if (held) return false;
        return markVerdict(view.resolve(inside, facts.defaultLabel).mark, facts) === undefined;
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

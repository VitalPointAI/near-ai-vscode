// Turns the GSD files on the team's integration branch into signed work items on the team log, idempotently (D-01 to D-09).
// The branch is read through the private ref (integrationSource.ts), parsed by the pure graph builder (gsdImport.ts), cleaned and fitted into
// item.imported bodies, and diffed against the items already on the log, so the same input writes nothing a second time. Every string that reaches
// a body is untrusted text from a branch anyone with push access controls, so each one is cleaned, secret-checked and size-fitted first (T-62-14
// to T-62-17). Only titles, ids, file globs, requirement ids, estimates, waves, tags and must-have truth strings are ever written: no objective,
// context, action or any other plan prose. This module never imports vscode.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CanonicalJsonError, MAX_EVENT_BYTES, canonicalBytes, canonicalize } from '../domain/team/canonical';
import { buildGsdGraph } from '../domain/team/gsdImport';
import type { GsdGraph, GsdMilestone, GsdPlan } from '../domain/team/gsdImport';
import { stripFormatControls } from '../domain/team/boardText';
import { decideTeamAction } from '../domain/team/permissions';
import { SecretLeakError, findSecrets } from '../domain/team/secrets';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { ItemChanges, ItemGsdRef, ItemImportedBody, TeamState, WorkItem } from '../domain/team/types';
import {
  GSD_PHASE_PATTERN, GSD_PLAN_PATTERN, ITEM_TAG_PATTERN, MAX_DEPENDENCIES, MAX_ESTIMATE_TOKENS, MAX_MUST_HAVES, MAX_REQUIREMENTS, MAX_SCOPE_ENTRIES,
  MAX_TAGS, MAX_WAVE, MUST_HAVE_MAX, REQUIREMENT_PATTERN, TITLE_MAX, validateBody
} from '../domain/team/validate';
import { GSD_ITEM_ID_PATTERN, isScopePattern } from '../domain/team/work';
import { NO_DEVICE_KEY_MESSAGE, NoDeviceKeyError } from './eventLog';
import type { EventIntent, TeamLog } from './eventLog';
import { PlanningTooLargeError, fetchIntegrationBranch, isAncestor, planningTreeHash, readPlanningSnapshot } from './integrationSource';
import type { PlanningLimits } from './integrationSource';
import { redactGitMessage, runGit } from './runGit';
import type { GitRunner } from './runGit';
import { runSerialised, writeFileAtomic } from './teamFile';

export const IMPORT_NOOP = 'import: nothing to change';
export const NOT_IN_ROADMAP = 'no longer in the roadmap';
export const WITHHELD_TEXT = '(withheld: text that looks like a secret)';
export const IMPORT_STATE_FILE = 'import.json';

// Internal: the source commit another lead recorded while this import was building, so the stale guard must be asked again.
const RECHECK = 'import: source commit changed';
const MAX_INTENTS_PER_APPEND = 250;
// WR-02: one import never holds more than this many items (milestone, phases, plans, then tasks, so tasks are the ones left out), and an automatic
// import in a lead's window writes at most AUTO_IMPORT_MAX_CHANGES events. A bigger change waits for the lead to run the Import command.
export const MAX_IMPORT_ITEMS = 2000;
export const AUTO_IMPORT_MAX_CHANGES = 300;
const MAX_ROUNDS = 20;
const MAX_WARNINGS = 100;
const MAX_WARNING_CHARS = 200;
const MIN_SHORTENED_MUST_HAVE = 40;
const MAX_MESSAGE_CHARS = 400;
const R = TEAM_REJECTION_REASONS;

export interface ImportSource {
  projectRoot: string;
  // When a ref is given it is read as it is and nothing is fetched (tests and the live check read HEAD). Otherwise remote and branch are fetched into the private ref.
  ref?: string;
  remote?: string;
  branch?: string;
}

export type ImportResult =
  | {
    ok: true; written: number; upToDate: boolean; milestone: string; withheld: number; reopenNeeded: number; warnings: string[];
    skipped?: 'unchanged-tree' | 'stale-source' | 'needs-command';
    /** With skipped 'needs-command': how many changes the automatic import left for the Import command. */
    pending?: number;
  }
  | { ok: false; message: string; written: number };

// ---- Cleaning ---------------------------------------------------------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// The same pattern without the g flag, for a stateless test.
const HAS_LONE_SURROGATE = new RegExp(LONE_SURROGATE.source);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/g;

interface Context { withheld: number; warnings: string[] }

function newContext(): Context {
  return { withheld: 0, warnings: [] };
}

// Collapses every run of whitespace to one space, removes the remaining control characters, replaces lone surrogate halves and trims.
// Invisible bidi and zero-width format characters are removed too (IN-01).
function collapse(raw: string): string {
  return stripFormatControls(raw.replace(LONE_SURROGATE, '�')).replace(/\s+/g, ' ').replace(CONTROL_CHARACTERS, '').trim();
}

// Cuts to at most `cap` UTF-16 units without ever splitting a surrogate pair (the validators count units, the canonical form refuses a lone half).
function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let out = '';
  for (const character of text) {
    if (out.length + character.length > cap) break;
    out += character;
  }
  return out.trimEnd();
}

function warn(context: Context, message: string): void {
  if (context.warnings.length < MAX_WARNINGS - 1) context.warnings.push(truncate(collapse(message), MAX_WARNING_CHARS));
  else if (context.warnings.length === MAX_WARNINGS - 1) context.warnings.push('More warnings were left out.');
}

// A string that looks like a secret is replaced by a fixed placeholder, never dropped silently and never allowed to stop the import (Pitfall 1).
// The whole cleaned string is checked, so a secret past the cut is withheld too; a prefix of a clean string can never match a pattern the whole did not.
function safeText(context: Context, raw: string, cap: number): string {
  const whole = collapse(raw);
  if (whole === '') return '';
  if (findSecrets(whole).length > 0) {
    context.withheld += 1;
    return WITHHELD_TEXT;
  }
  return truncate(whole, cap);
}

function uniquePush(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function safeScope(context: Context, owner: string, values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = stripFormatControls(raw).trim();
    if (HAS_LONE_SURROGATE.test(value) || value.includes('\uFFFD')) {
      // A path with a broken character names no real file, so it is dropped rather than repaired (WR-01).
      warn(context, `${owner}: a file path was left out because it has a broken character.`);
    } else if (!isScopePattern(value)) {
      warn(context, `${owner}: a file path was left out because it is not a plain relative path.`);
    } else if (findSecrets(value).length > 0) {
      context.withheld += 1;
      warn(context, `${owner}: a file path was left out because it looks like a secret.`);
    } else {
      uniquePush(out, value);
    }
  }
  return out;
}

function safeRequirements(context: Context, owner: string, values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (REQUIREMENT_PATTERN.test(value)) uniquePush(out, value);
    else warn(context, `${owner}: a requirement id was left out because it is not in the usual form.`);
  }
  return out;
}

function safeMustHaves(context: Context, values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const text = safeText(context, raw, MUST_HAVE_MAX);
    if (text !== '') out.push(text);
  }
  return out;
}

function safeTag(context: Context, owner: string, value: string): string | undefined {
  if (!ITEM_TAG_PATTERN.test(value)) return undefined;
  if (findSecrets(value).length > 0) {
    context.withheld += 1;
    warn(context, `${owner}: a tag was left out because it looks like a secret.`);
    return undefined;
  }
  return value;
}

function gsdRef(context: Context, owner: string, phase: string, plan?: string, wave?: number, file?: string): ItemGsdRef | undefined {
  if (!GSD_PHASE_PATTERN.test(phase)) return undefined;
  const ref: ItemGsdRef = { phase };
  if (plan !== undefined) {
    if (!GSD_PLAN_PATTERN.test(plan)) return undefined;
    ref.plan = plan;
  }
  if (wave !== undefined && Number.isSafeInteger(wave) && wave >= 1 && wave <= MAX_WAVE) ref.wave = wave;
  if (file !== undefined) {
    const kept = safeScope(context, owner, [file]);
    if (kept[0] !== undefined) ref.file = kept[0];
  }
  return ref;
}

// ---- Fitting ----------------------------------------------------------------------------------------------------------------------------

// The largest event an item body can travel in: every variable-length envelope field at its longest, so the answer holds for any author, device,
// team and moment. prepareEvents measures the real event the same way with a full-length signature in place.
const WORST_CASE_ENVELOPE = {
  v: 1, id: `evt-${'0'.repeat(26)}`, teamId: `team-${'0'.repeat(32)}`, type: 'item.imported', lamport: 999_999_999_999, at: '2026-01-01T00:00:00.000Z',
  author: `mbr-${'0'.repeat(16)}`, device: `dev-${'0'.repeat(32)}`, prev: `evt-${'0'.repeat(26)}`, sig: 'A'.repeat(86)
};

function eventBytes(body: ItemImportedBody): number {
  return canonicalBytes({ ...WORST_CASE_ENVELOPE, body }).length;
}

function copyBody(body: ItemImportedBody): ItemImportedBody {
  const copy: ItemImportedBody = {
    ...body, dependsOn: [...body.dependsOn], scope: [...body.scope], requirements: [...body.requirements], mustHaves: [...body.mustHaves], tags: [...body.tags]
  };
  if (body.gsd !== undefined) copy.gsd = { ...body.gsd };
  if (body.estimate !== undefined) copy.estimate = { ...body.estimate };
  return copy;
}

// Every list is cut to its validator cap, then a body whose signed event would be over MAX_EVENT_BYTES is shrunk in a fixed order: trailing
// must-haves go first (the first one stays), then trailing scope entries, then the remaining must-haves are halved down to 40 characters.
// If that is still not enough, which a legal title and the capped lists cannot cause, the rest is dropped. Pure and deterministic, so the same
// input always fits the same way and a re-import compares equal.
export function fitItemBody(body: ItemImportedBody): { body: ItemImportedBody; warning?: string } {
  const out = copyBody(body);
  const notes: string[] = [];
  const caps: Array<['mustHaves' | 'scope' | 'requirements' | 'dependsOn' | 'tags', number, string]> = [
    ['mustHaves', MAX_MUST_HAVES, 'must-haves'], ['scope', MAX_SCOPE_ENTRIES, 'file paths'], ['requirements', MAX_REQUIREMENTS, 'requirements'],
    ['dependsOn', MAX_DEPENDENCIES, 'dependencies'], ['tags', MAX_TAGS, 'tags']
  ];
  for (const [key, max, label] of caps) {
    if (out[key].length > max) {
      notes.push(`only the first ${max} ${label} were kept`);
      out[key] = out[key].slice(0, max);
    }
  }
  const fits = (): boolean => eventBytes(out) <= MAX_EVENT_BYTES;
  if (!fits()) {
    const before = { mustHaves: out.mustHaves.length, scope: out.scope.length };
    while (!fits() && out.mustHaves.length > 1) out.mustHaves.pop();
    while (!fits() && out.scope.length > 0) out.scope.pop();
    let shortened = false;
    while (!fits() && out.mustHaves.some((text) => text.length > MIN_SHORTENED_MUST_HAVE)) {
      out.mustHaves = out.mustHaves.map((text) => (text.length > MIN_SHORTENED_MUST_HAVE ? truncate(text, Math.max(MIN_SHORTENED_MUST_HAVE, Math.floor(text.length / 2))) : text));
      shortened = true;
    }
    while (!fits() && out.mustHaves.length > 0) out.mustHaves.pop();
    while (!fits() && out.dependsOn.length > 0) out.dependsOn.pop();
    while (!fits() && out.requirements.length > 0) out.requirements.pop();
    if (out.mustHaves.length < before.mustHaves) notes.push(`${out.mustHaves.length} of ${before.mustHaves} must-haves were kept to fit the size limit`);
    if (out.scope.length < before.scope) notes.push(`${out.scope.length} of ${before.scope} file paths were kept to fit the size limit`);
    if (shortened) notes.push('the remaining must-haves were shortened');
  }
  if (notes.length === 0) return { body: out };
  return { body: out, warning: `${body.id} was imported in a trimmed form: ${notes.join('; ')}.` };
}

// ---- Graph to bodies --------------------------------------------------------------------------------------------------------------------

function pad2(plan: string): string {
  return plan.length < 2 ? plan.padStart(2, '0') : plan;
}

const planId = (phase: string, plan: string): string => `plan:${phase}-${pad2(plan)}`;

interface Draft {
  id: string; kind: ItemImportedBody['kind']; title: string; fallbackTitle: string; state: 'backlog' | 'done'; dependsOn: string[]; scope: string[]; requirements: string[];
  mustHaves: string[]; tags: string[]; parentId?: string; gsd?: ItemGsdRef; estimate?: { tokens: number; confidence?: 'low' | 'medium' | 'high' }; summary?: true; active?: true; source?: string;
}

function toBody(draft: Draft): ItemImportedBody {
  const body: ItemImportedBody = {
    id: draft.id, kind: draft.kind, title: draft.title, state: draft.state, dependsOn: draft.dependsOn, scope: draft.scope, requirements: draft.requirements,
    mustHaves: draft.mustHaves, tags: draft.tags
  };
  if (draft.parentId !== undefined) body.parentId = draft.parentId;
  if (draft.gsd !== undefined) body.gsd = draft.gsd;
  if (draft.estimate !== undefined) body.estimate = draft.estimate;
  if (draft.summary === true) body.summary = true;
  if (draft.active === true) body.active = true;
  if (draft.source !== undefined) body.source = draft.source;
  return body;
}

function dependencyIds(context: Context, owner: string, values: readonly string[], prefix: 'plan' | 'phase', known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const id = `${prefix}:${value}`;
    if (!GSD_ITEM_ID_PATTERN.test(id)) warn(context, `${owner}: a dependency was left out because it is not a valid reference.`);
    else if (!known.has(id)) warn(context, `${owner} depends on ${id.slice(prefix.length + 1)}, which is not in this milestone, so that dependency was left out.`);
    else uniquePush(out, id);
  }
  return out;
}

function planEstimate(plan: GsdPlan): { tokens: number; confidence?: 'low' | 'medium' | 'high' } | undefined {
  const tokens = plan.estimateTokens;
  if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > MAX_ESTIMATE_TOKENS) return undefined;
  return plan.confidence === undefined ? { tokens } : { tokens, confidence: plan.confidence };
}

// The graph as item.imported bodies in the one deterministic order that puts a parent before its children: the milestone, the phases by number,
// the plans by (phase, plan) and the tasks by (plan, index). Each body is cleaned, fitted and checked with the read side's own validator; one
// that still fails (a malformed id, which only a hostile file name can cause) is a warning and is skipped together with its children.
export function graphToItems(graph: GsdGraph, options: { sourceCommit: string }): { bodies: ItemImportedBody[]; withheld: number; warnings: string[]; unread: Set<string> } {
  const context = newContext();
  // Plans whose text was not read (their bodies are skeletons) and items left out by the item cap: diffImport must not change or cancel what the log
  // already holds for them or for their children (CR-02, WR-02).
  const unread = new Set<string>();
  for (const warning of graph.warnings) warn(context, warning);
  const bodies: ItemImportedBody[] = [];
  const taken = new Set<string>();
  const skipped = new Set<string>();

  let capped = false;
  const accept = (draft: Draft): boolean => {
    if (bodies.length >= MAX_IMPORT_ITEMS) {
      // Left out because of the cap, not because it left the roadmap: diffImport must not cancel it (it joins `unread`).
      if (!capped) warn(context, `Only the first ${MAX_IMPORT_ITEMS} items were imported. The rest were left out.`);
      capped = true;
      unread.add(draft.id);
      skipped.add(draft.id);
      return false;
    }
    if (taken.has(draft.id)) {
      warn(context, `${draft.id} appears twice, so the second one was left out.`);
      return false;
    }
    if (draft.parentId !== undefined && skipped.has(draft.parentId)) {
      warn(context, `${draft.id} was left out because the item above it was.`);
      skipped.add(draft.id);
      return false;
    }
    if (draft.title === '') draft.title = draft.fallbackTitle;
    // One item that cannot be signed (a value the canonical form refuses) is left out with a warning; it never stops the whole import (WR-01).
    let fitted: ReturnType<typeof fitItemBody>;
    let problem: string | undefined;
    try {
      fitted = fitItemBody(toBody(draft));
      problem = validateBody('item.imported', fitted.body);
      if (problem === undefined) canonicalBytes(fitted.body);
    } catch (error) {
      if (!(error instanceof CanonicalJsonError)) throw error;
      warn(context, `${truncate(collapse(draft.id), 80)} was left out because one of its fields cannot be saved.`);
      skipped.add(draft.id);
      return false;
    }
    if (problem !== undefined) {
      warn(context, `${truncate(collapse(draft.id), 80)} was left out: ${problem}.`);
      skipped.add(draft.id);
      return false;
    }
    if (findSecrets(fitted.body).length > 0) {
      context.withheld += 1;
      warn(context, `${truncate(collapse(draft.id), 80)} was left out because a field looks like a secret.`);
      skipped.add(draft.id);
      return false;
    }
    if (fitted.warning !== undefined) warn(context, fitted.warning);
    taken.add(draft.id);
    bodies.push(fitted.body);
    return true;
  };

  const milestoneId = `milestone:${graph.milestone.key}`;
  const known = new Set<string>(graph.phases.map((phase) => `phase:${phase.number}`));
  for (const plan of graph.plans) known.add(planId(plan.phase, plan.plan));

  const milestoneDraft: Draft = {
    id: milestoneId, kind: 'milestone', title: safeText(context, graph.milestone.title, TITLE_MAX), fallbackTitle: safeText(context, graph.milestone.key, TITLE_MAX) || 'Milestone',
    state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], source: options.sourceCommit
  };
  if (graph.milestone.current) milestoneDraft.active = true;
  if (!accept(milestoneDraft)) return { bodies, withheld: context.withheld, warnings: context.warnings, unread };

  for (const phase of graph.phases) {
    const id = `phase:${phase.number}`;
    const draft: Draft = {
      id, kind: 'phase', title: safeText(context, phase.title, TITLE_MAX), fallbackTitle: `Phase ${phase.number}`, state: 'backlog',
      dependsOn: dependencyIds(context, id, phase.dependsOn, 'phase', known), scope: [], requirements: safeRequirements(context, id, phase.requirements), mustHaves: [], tags: [], parentId: milestoneId
    };
    const ref = gsdRef(context, id, phase.number);
    if (ref !== undefined) draft.gsd = ref;
    accept(draft);
  }

  for (const plan of graph.plans) {
    const id = planId(plan.phase, plan.plan);
    const tags: string[] = [];
    if (plan.gapClosure) uniquePush(tags, 'gap-closure');
    const draft: Draft = {
      id, kind: 'plan', title: safeText(context, plan.title, TITLE_MAX), fallbackTitle: `Plan ${plan.phase}-${pad2(plan.plan)}`, state: plan.hasSummary ? 'done' : 'backlog',
      dependsOn: dependencyIds(context, id, plan.dependsOn, 'plan', known), scope: safeScope(context, id, plan.filesModified), requirements: safeRequirements(context, id, plan.requirements),
      mustHaves: safeMustHaves(context, plan.truths), tags, parentId: `phase:${plan.phase}`
    };
    const ref = gsdRef(context, id, plan.phase, pad2(plan.plan), plan.wave, plan.path);
    if (ref !== undefined) draft.gsd = ref;
    const estimate = planEstimate(plan);
    if (estimate !== undefined) draft.estimate = estimate;
    if (plan.hasSummary) draft.summary = true;
    if (plan.unread === true) unread.add(id);
    accept(draft);
  }

  for (const plan of graph.plans) {
    const parent = planId(plan.phase, plan.plan);
    for (const task of plan.tasks) {
      const id = `task:${plan.phase}-${pad2(plan.plan)}-${task.index}`;
      const tags: string[] = [];
      const tag = safeTag(context, id, task.type);
      if (tag !== undefined) tags.push(tag);
      const draft: Draft = {
        id, kind: 'task', title: safeText(context, task.title, TITLE_MAX), fallbackTitle: `Task ${task.index}`, state: plan.hasSummary ? 'done' : 'backlog', dependsOn: [],
        scope: safeScope(context, id, task.files), requirements: [], mustHaves: [], tags, parentId: parent
      };
      const ref = gsdRef(context, id, plan.phase, pad2(plan.plan));
      if (ref !== undefined) draft.gsd = ref;
      accept(draft);
    }
  }
  return { bodies, withheld: context.withheld, warnings: context.warnings, unread };
}

// ---- Diff against the log ---------------------------------------------------------------------------------------------------------------

const KIND_RANK: Readonly<Record<string, number>> = { milestone: 0, phase: 1, plan: 2, task: 3 };

function naturalCompare(a: string, b: string): number {
  const left = a.split(/(\d+)/);
  const right = b.split(/(\d+)/);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const x = left[index] ?? '';
    const y = right[index] ?? '';
    if (index % 2 === 1) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return left.length - right.length;
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function estimateOf(item: { estimate?: { tokens: number; confidence?: 'low' | 'medium' | 'high' } }): { tokens: number; confidence?: string } | undefined {
  if (item.estimate === undefined) return undefined;
  return item.estimate.confidence === undefined ? { tokens: item.estimate.tokens } : { tokens: item.estimate.tokens, confidence: item.estimate.confidence };
}

// The keys of one imported item that differ from the stored item. State is never among them (D-06): a card is only ever moved by a person.
// An estimate or gsd reference that the files no longer carry is left as it is, since there is no event that removes one.
function changesFor(stored: WorkItem, body: ItemImportedBody): ItemChanges {
  const changes: ItemChanges = {};
  if (stored.title !== body.title) changes.title = body.title;
  if (!sameValue(stored.dependsOn, body.dependsOn)) changes.dependsOn = body.dependsOn;
  if (!sameValue(stored.scope, body.scope)) changes.scope = body.scope;
  if (!sameValue(stored.requirements, body.requirements)) changes.requirements = body.requirements;
  if (!sameValue(stored.mustHaves, body.mustHaves)) changes.mustHaves = body.mustHaves;
  if (!sameValue(stored.tags, body.tags)) changes.tags = body.tags;
  if (body.estimate !== undefined && !sameValue(estimateOf(stored), estimateOf(body))) changes.estimate = body.estimate;
  if (body.gsd !== undefined && !sameValue(stored.gsd, body.gsd)) changes.gsd = body.gsd;
  if (body.kind === 'plan' && (stored.summary === true) !== (body.summary === true)) changes.summary = body.summary === true;
  if (body.kind === 'milestone' && (stored.active === true) !== (body.active === true)) changes.active = body.active === true;
  return changes;
}

function belongsTo(items: ReadonlyMap<string, WorkItem>, item: WorkItem, milestoneId: string): boolean {
  let cursor: WorkItem | undefined = item;
  for (let depth = 0; cursor !== undefined && depth < 6; depth += 1) {
    if (cursor.id === milestoneId) return true;
    cursor = cursor.parentId === undefined ? undefined : items.get(cursor.parentId);
  }
  return false;
}

// The intents that bring the log in line with the bodies, or an empty list when it already is. Order: new and changed items parents first, the
// previous active milestone switched off, vanished items cancelled (D-05: only items of this milestone, only unfinished ones, nothing deleted),
// and last the milestone's source commit, recorded only when something else changes so a head move that changes nothing under .planning writes nothing.
// A read that was not complete is additive only (CR-02): with `additiveOnly` (the file listing was cut) only new items are written, nothing is changed
// or cancelled; the items in `unread` (plans whose text was not read) and their tasks are never changed or cancelled.
export function diffImport(
  state: Pick<TeamState, 'items'>, bodies: readonly ItemImportedBody[],
  options: { milestoneId: string; current: boolean; sourceCommit: string; additiveOnly?: boolean; unread?: ReadonlySet<string> }
): EventIntent[] {
  const intents: EventIntent[] = [];
  const ids = new Set<string>();
  const additiveOnly = options.additiveOnly === true;
  const unread = options.unread ?? new Set<string>();
  for (const body of bodies) {
    ids.add(body.id);
    const stored = state.items.get(body.id);
    if (stored === undefined) {
      intents.push({ type: 'item.imported', body });
      continue;
    }
    if (additiveOnly || unread.has(body.id) || (body.parentId !== undefined && unread.has(body.parentId))) continue;
    const changes = changesFor(stored, body);
    if (Object.keys(changes).length > 0) intents.push({ type: 'item.updated', body: { id: body.id, changes } });
  }
  if (options.current && !additiveOnly) {
    const others = [...state.items.values()].filter((item) => item.kind === 'milestone' && item.origin === 'import' && item.active === true && item.id !== options.milestoneId);
    others.sort((a, b) => naturalCompare(a.id, b.id));
    for (const item of others) intents.push({ type: 'item.updated', body: { id: item.id, changes: { active: false } } });
  }
  const vanished = additiveOnly ? [] : [...state.items.values()].filter((item) => (
    item.origin === 'import' && item.kind !== 'milestone' && !ids.has(item.id) && item.state !== 'done' && item.state !== 'cancelled'
    && !unread.has(item.id) && !(item.parentId !== undefined && unread.has(item.parentId)) && belongsTo(state.items, item, options.milestoneId)
  ));
  vanished.sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || naturalCompare(a.id, b.id));
  for (const item of vanished) intents.push({ type: 'item.cancelled', body: { id: item.id, reason: NOT_IN_ROADMAP } });
  const milestone = state.items.get(options.milestoneId);
  if (intents.length > 0 && milestone !== undefined && milestone.source !== options.sourceCommit) {
    intents.push({ type: 'item.updated', body: { id: options.milestoneId, changes: { source: options.sourceCommit } } });
  }
  return intents;
}

// ---- Import state -----------------------------------------------------------------------------------------------------------------------

interface ImportState { treeHash: string; sourceCommit: string; milestone: string }
const HASH_PATTERN = /^[0-9a-f]{40,64}$/;

export async function readImportState(storageDir: string): Promise<ImportState | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(storageDir, IMPORT_STATE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const { treeHash, sourceCommit, milestone } = record;
    if (typeof treeHash !== 'string' || !HASH_PATTERN.test(treeHash) || typeof sourceCommit !== 'string' || !HASH_PATTERN.test(sourceCommit)) return undefined;
    if (typeof milestone !== 'string' || milestone.length > 64) return undefined;
    return { treeHash, sourceCommit, milestone };
  } catch {
    return undefined;
  }
}

// treeHash, sourceCommit and the milestone asked for (empty means the current one) are all it holds: no plan text, no remote address.
async function writeImportState(storageDir: string, state: ImportState): Promise<void> {
  const target = path.join(storageDir, IMPORT_STATE_FILE);
  await runSerialised(path.resolve(target), () => writeFileAtomic(target, `${JSON.stringify({ treeHash: state.treeHash, sourceCommit: state.sourceCommit, milestone: state.milestone })}\n`));
}

// ---- The import -------------------------------------------------------------------------------------------------------------------------

const wantedPlanning = (file: string): boolean => /^\.planning\/(ROADMAP|STATE)\.md$/.test(file) || file.endsWith('-PLAN.md');

function safeMessage(message: string): string {
  return truncate(collapse(redactGitMessage(message)), MAX_MESSAGE_CHARS);
}

async function resolveRef(source: ImportSource, git: GitRunner): Promise<{ ok: true; ref: string } | { ok: false; message: string }> {
  if (source.ref !== undefined) return { ok: true, ref: source.ref };
  if (source.remote === undefined || source.branch === undefined) return { ok: false, message: 'There is no integration branch to import from.' };
  const fetched = await fetchIntegrationBranch(source.projectRoot, source.remote, source.branch, git);
  if (!fetched.ok) {
    return { ok: false, message: fetched.kind === 'offline' ? `The team remote could not be reached (${safeMessage(fetched.reason)})` : 'The integration branch was not found on the team remote' };
  }
  return { ok: true, ref: fetched.ref };
}

// Reads the integration branch, builds the graph for the current milestone (or the one named) and writes whatever differs from the log. The
// coordination CAS re-runs the builder on fresh state after a lost race, so two leads importing at once write each item once. In mode auto an
// unchanged .planning tree is skipped without reading any plan file; mode command always compares.
export async function importPlans(input: {
  log: TeamLog; source: ImportSource; storageDir: string; milestone?: string; mode: 'auto' | 'command'; git?: GitRunner;
  /** Test seam for the read caps. */
  limits?: PlanningLimits;
}): Promise<ImportResult> {
  const { log, source, storageDir, mode } = input;
  const git = input.git ?? runGit;
  let written = 0;
  const fail = (message: string): ImportResult => ({ ok: false, message: safeMessage(message), written });
  try {
    const memberId = log.signerMemberId();
    if (memberId === undefined) return fail(NO_DEVICE_KEY_MESSAGE);
    const synced = await log.sync();
    if (synced.status.state !== 'ok') return fail(synced.status.reason ?? 'The team log could not be read.');
    if (!decideTeamAction(log.state(), memberId, { kind: 'item.create', ownDraft: false }).allowed) {
      return fail(`${R.notPermitted}: only the team owner and leads can import plans`);
    }

    const resolved = await resolveRef(source, git);
    if (!resolved.ok) return fail(resolved.message);
    const requested = input.milestone ?? '';
    const probe = await planningTreeHash(source.projectRoot, resolved.ref, git);
    if (mode === 'auto') {
      const saved = await readImportState(storageDir);
      if (saved !== undefined && probe.treeHash !== undefined && saved.treeHash === probe.treeHash && saved.milestone === requested) {
        return { ok: true, written: 0, upToDate: true, milestone: requested, withheld: 0, reopenNeeded: 0, warnings: [], skipped: 'unchanged-tree' };
      }
    }

    const snapshot = await readPlanningSnapshot(source.projectRoot, resolved.ref, wantedPlanning, git, input.limits);
    if (snapshot.treeHash === undefined) return fail('The integration branch has no .planning folder.');
    const graph = buildGsdGraph({ paths: snapshot.paths, files: snapshot.files }, input.milestone === undefined ? {} : { milestone: input.milestone });
    if ('error' in graph) return fail(graph.error);
    const built = graphToItems(graph, { sourceCommit: snapshot.commit });
    const warnings = [...built.warnings];
    const additiveOnly = !snapshot.listingComplete;
    if (additiveOnly) warnings.push('The planning folder has too many files to read completely, so only new items were added. Nothing was changed or cancelled.');
    else if (snapshot.truncated) warnings.push('The planning folder was too large to read completely. Plans that were not read were left as they are.');
    for (const name of snapshot.oversize) warnings.push(`${truncate(collapse(name), 120)} is too large to read and was skipped.`);
    const milestoneId = `milestone:${graph.milestone.key}`;
    if (built.bodies[0]?.id !== milestoneId) return fail('The milestone name cannot be used as an item id.');
    const options = { milestoneId, current: graph.milestone.current, sourceCommit: snapshot.commit, additiveOnly, unread: built.unread };
    const base = { milestone: graph.milestone.key, withheld: built.withheld, reopenNeeded: 0, warnings };

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const state = log.state();
      const recorded = state.items.get(milestoneId)?.source;
      if (recorded !== undefined && recorded !== snapshot.commit) {
        const ancestor = await isAncestor(source.projectRoot, snapshot.commit, recorded, git);
        if (ancestor === true || (ancestor === 'unknown' && mode === 'auto')) {
          if (ancestor === 'unknown') warnings.push('The last import came from a commit this computer does not have, so this import was skipped.');
          return { ok: true, written, upToDate: written === 0, ...base, reopenNeeded: reopenCount(state, built.bodies), skipped: 'stale-source' };
        }
      }
      const pending = diffImport(state, built.bodies, options);
      if (pending.length === 0) break;
      if (round === 0 && mode === 'auto' && pending.length > AUTO_IMPORT_MAX_CHANGES) {
        // A lead's window does not sign a flood of events on its own: the lead brings them in with the Import command (WR-02).
        return { ok: true, written: 0, upToDate: false, ...base, reopenNeeded: reopenCount(state, built.bodies), skipped: 'needs-command', pending: pending.length };
      }
      const appended = await log.append((fresh) => {
        const freshSource = fresh.items.get(milestoneId)?.source;
        if (freshSource !== recorded && freshSource !== undefined && freshSource !== snapshot.commit) return { conflict: RECHECK };
        const chunk = diffImport(fresh, built.bodies, options).slice(0, MAX_INTENTS_PER_APPEND);
        return chunk.length === 0 ? { conflict: IMPORT_NOOP } : chunk;
      });
      if (appended.ok) {
        written += appended.events.length;
        continue;
      }
      if (appended.reason === IMPORT_NOOP) break;
      if (appended.reason === RECHECK) continue;
      return fail(appended.reason);
    }
    const finalState = log.state();
    if (diffImport(finalState, built.bodies, options).length > 0) return fail('The roadmap has more changes than one import can write; run the import again to finish');
    await writeImportState(storageDir, { treeHash: snapshot.treeHash, sourceCommit: snapshot.commit, milestone: requested });
    return { ok: true, written, upToDate: written === 0, ...base, reopenNeeded: reopenCount(finalState, built.bodies) };
  } catch (error) {
    if (error instanceof NoDeviceKeyError) return fail(NO_DEVICE_KEY_MESSAGE);
    if (error instanceof SecretLeakError) return fail('A plan field looks like a secret, so nothing more was written');
    if (error instanceof PlanningTooLargeError) return fail(error.message);
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Plans that are cancelled on the board although the roadmap lists them again: re-import never moves a card (D-06), so a lead is told to reopen them.
function reopenCount(state: Pick<TeamState, 'items'>, bodies: readonly ItemImportedBody[]): number {
  let count = 0;
  for (const body of bodies) if (body.kind === 'plan' && state.items.get(body.id)?.state === 'cancelled') count += 1;
  return count;
}

// ---- Words for the person ---------------------------------------------------------------------------------------------------------------

export function importResultText(result: ImportResult): string {
  if (!result.ok) {
    const reason = safeMessage(result.message).replace(/[.\s]+$/, '');
    if (result.written === 0) return `The import did not finish: ${reason}. Nothing was changed.`;
    const noun = result.written === 1 ? '1 item was' : `${result.written} items were`;
    return `The import did not finish: ${reason}. ${noun} written; run the import again to finish.`;
  }
  if (result.skipped === 'needs-command') {
    return `The roadmap has ${result.pending ?? 0} changes for the Team Board. An automatic import makes at most ${AUTO_IMPORT_MAX_CHANGES}, so nothing was changed. Run "NEAR AI: Import Plans to Team Board" to bring them in.`;
  }
  let text = result.written === 0 ? 'The Team Board is already up to date.' : `Imported ${result.written === 1 ? '1 item' : `${result.written} items`} to the Team Board.`;
  if (result.reopenNeeded > 0) {
    const plans = result.reopenNeeded === 1 ? '1 plan is' : `${result.reopenNeeded} plans are`;
    const them = result.reopenNeeded === 1 ? 'it' : 'them';
    const they = result.reopenNeeded === 1 ? 'it' : 'they';
    text += ` ${plans} back in the roadmap but cancelled on the board; reopen ${them} if ${they} should continue.`;
  }
  return text;
}

// The roadmap's milestones, the current one first, so a lead can pick an archived one to import (D-09).
export async function listImportableMilestones(source: ImportSource, git: GitRunner = runGit): Promise<GsdMilestone[]> {
  const resolved = await resolveRef(source, git);
  if (!resolved.ok) return [];
  let snapshot;
  try {
    snapshot = await readPlanningSnapshot(source.projectRoot, resolved.ref, (file) => /^\.planning\/(ROADMAP|STATE)\.md$/.test(file), git);
  } catch (error) {
    // Too large to list: offer no pick, and the import itself says why.
    if (error instanceof PlanningTooLargeError) return [];
    throw error;
  }
  const files = { paths: snapshot.paths, files: snapshot.files };
  const graph = buildGsdGraph(files);
  if ('error' in graph) return [];
  return [...graph.milestones].sort((a, b) => Number(b.current) - Number(a.current));
}

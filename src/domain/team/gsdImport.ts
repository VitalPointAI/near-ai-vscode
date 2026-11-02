// Pure GSD parser (D-06 to D-09): turns the texts of ROADMAP.md, STATE.md and the *-PLAN.md files into a graph of one milestone, its phases, plans and tasks.
// No I/O, no clock, no vscode: the caller passes texts and paths in. Every byte is attacker-influenced (anyone who can push to the integration branch
// controls it), so the readers are single linear passes with line, list, task, plan and warning caps, parsed values go into locals, Sets and Maps and are
// never spread, and only known keys are ever read (T-62-09, T-62-10).
export interface GsdTask { index: number; title: string; type: string; files: string[] }
export interface GsdPlan {
  phase: string; plan: string; path: string; title: string; wave?: number; dependsOn: string[]; filesModified: string[]; requirements: string[];
  truths: string[]; estimateTokens?: number; confidence?: 'low' | 'medium' | 'high'; gapClosure: boolean; hasSummary: boolean; tasks: GsdTask[];
}
export interface GsdPhase { number: string; title: string; dependsOn: string[]; requirements: string[] }
export interface GsdMilestone { key: string; title: string; current: boolean }
export interface GsdGraph { milestone: GsdMilestone; phases: GsdPhase[]; plans: GsdPlan[]; milestones: GsdMilestone[]; warnings: string[] }
export interface GsdSource { paths: readonly string[]; files: ReadonlyMap<string, string> }
export interface PlanFrontmatter {
  phase?: string; plan?: string; wave?: number; dependsOn: string[]; filesModified: string[]; requirements: string[]; truths: string[];
  autonomous?: boolean; gapClosure: boolean; estimateTokens?: number; estimateTasks?: number; confidence?: 'low' | 'medium' | 'high';
}
export interface RoadmapMilestone { key: string; title: string; shipped: boolean; paused: boolean; current: boolean; marked: boolean; first?: string; last?: string }
export interface RoadmapPlanEntry { phase: string; plan: string; title: string; checked: boolean; wave?: number; requirements: string[] }
export interface RoadmapPhase { number: string; title: string; dependsOn: string[]; requirements: string[]; plans: RoadmapPlanEntry[] }
export interface RoadmapSection { key: string; title: string; phases: RoadmapPhase[] }
export interface Roadmap { milestones: RoadmapMilestone[]; sections: RoadmapSection[]; problems: string[] }

export const MAX_FRONTMATTER_LINES = 400;
export const MAX_LINE_CHARS = 4000;
export const MAX_LIST_ENTRIES = 64;
export const MAX_TASKS_PER_PLAN = 50;
export const MAX_PLANS = 2000;
export const MAX_WARNINGS = 100;
export const MAX_WARNING_CHARS = 200;
const MAX_ROADMAP_LINES = 20_000;
const MAX_PATHS = 20_000;
const MAX_PROBLEMS = 10;
const MAX_TITLE_CHARS = 300;
const MAX_FILE_CHARS = 200;
const MAX_TASK_START_TAG = 400;
const MAX_KEY_CHARS = 40;
const MAX_REQUIREMENT_SPAN = 64;
const MAX_MILESTONES = 200;
const MAX_SECTIONS = 500;
const MAX_ROADMAP_PHASES = 2000;

const ROADMAP_PATH = '.planning/ROADMAP.md';
const STATE_PATH = '.planning/STATE.md';
const PHASES_PREFIX = '.planning/phases/';
const MILESTONES_PREFIX = '.planning/milestones/';
const CONFIDENCES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const PLAN_FILE = /^(\d+(?:\.\d+)*)-(\d+)-(PLAN|SUMMARY)\.md$/;
const REQUIREMENT_ID = /^[A-Z][A-Z0-9]{0,15}-\d{1,3}$/;
const DASH_ESCAPES = '\\u2014\\u2013-';
const CONSTRUCTION_SIGN = '\u{1F6A7}';

// ---------------------------------------------------------------------------------------------------------------------------------------
// Small text helpers

function addLimited(list: string[], text: string, limit: number): void {
  if (list.length < limit) list.push(text);
}

// Cuts at a character count without leaving half of a surrogate pair at the end.
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// Collapses every run of whitespace and control characters to one space. The importer does the code-point-safe truncation and the secret checks.
function tidy(text: string, max: number): string {
  return cap(text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(), max);
}

function splitLines(text: string, maxLines: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (lines.length < maxLines) {
    if (start > text.length) return { lines, truncated: false };
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(start, Math.min(end, start + MAX_LINE_CHARS + 1));
    if (line.endsWith('\r')) line = line.slice(0, -1);
    lines.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line);
    if (newline === -1) return { lines, truncated: false };
    start = newline + 1;
  }
  return { lines, truncated: start < text.length };
}

function compareNumberParts(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = Number(a[i] ?? '-1');
    const y = Number(b[i] ?? '-1');
    if (x !== y) return x - y;
  }
  return 0;
}

export function normalisePhase(raw: string): string {
  const parts = raw.trim().split('.');
  const first = (parts[0] ?? '').replace(/^0+(?=\d)/, '');
  return [first, ...parts.slice(1)].join('.');
}

function padPlan(raw: string): string {
  const digits = raw.replace(/^0+(?=\d)/, '');
  return digits.length < 2 ? digits.padStart(2, '0') : digits;
}

// '90-02' or '061-2' -> '90-02' / '61-02'; anything else is not a plan reference.
function normalisePlanRef(raw: string): string | undefined {
  const match = /^(\d+(?:\.\d+)*)-(\d+)(?:-PLAN(?:\.md)?)?$/.exec(raw.trim());
  return match === null ? undefined : `${normalisePhase(match[1] ?? '')}-${padPlan(match[2] ?? '')}`;
}

export function planIdentity(path: string): { phase: string; plan: string; kind: 'plan' | 'summary' } | undefined {
  if (path.length > 400 || !path.startsWith('.planning/') || path.includes('\\') || path.includes('\0')) return undefined;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return undefined;
  const match = PLAN_FILE.exec(segments[segments.length - 1] ?? '');
  if (match === null) return undefined;
  return { phase: normalisePhase(match[1] ?? ''), plan: padPlan(match[2] ?? ''), kind: match[3] === 'PLAN' ? 'plan' : 'summary' };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Scalars and lists (a targeted reader for the shapes found in this repository, not a YAML parser)

// Returns the index after the closing quote of a quoted span that starts at `from`, or -1 when it never closes.
function scanQuoted(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"' && c === '\\') { i += 1; continue; }
    if (c === quote) {
      if (quote === "'" && text[i + 1] === "'") { i += 1; continue; }
      return i + 1;
    }
  }
  return -1;
}

function unquote(span: string): string {
  const inner = span.slice(1, -1);
  if (span.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(span);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return inner;
    }
    return inner;
  }
  return inner.replace(/''/g, "'");
}

// The text of a scalar: a quoted span without its quotes, or the bare text up to a comment. Undefined for empty, null and tilde.
function scalarText(raw: string): string | undefined {
  const s = raw.trim();
  if (s.length === 0) return undefined;
  if (s.startsWith('"') || s.startsWith("'")) {
    const end = scanQuoted(s, 0);
    return end === -1 ? s.slice(1) : unquote(s.slice(0, end));
  }
  const hash = s.indexOf(' #');
  const bare = (hash === -1 ? s : s.slice(0, hash)).trim();
  return bare === '' || bare === '~' || bare === 'null' ? undefined : bare;
}

function scalarInt(raw: string): number | undefined {
  const text = scalarText(raw);
  return text !== undefined && /^\d{1,15}$/.test(text) ? Number(text) : undefined;
}

function scalarBool(raw: string): boolean | undefined {
  const text = scalarText(raw);
  return text === 'true' ? true : text === 'false' ? false : undefined;
}

// Items of an inline list "[a, 'b, c', \"d\"]". One pass, quote-aware. Returns whether the closing bracket was found.
function inlineItems(rest: string, out: string[]): boolean {
  const open = rest.indexOf('[');
  let i = open + 1;
  let itemStart = i;
  const flush = (end: number): void => {
    const item = scalarText(rest.slice(itemStart, end));
    if (item !== undefined) out.push(item);
  };
  while (i < rest.length) {
    const c = rest[i];
    if (c === '"' || c === "'") {
      const end = scanQuoted(rest, i);
      if (end === -1) { i = rest.length; break; }
      i = end;
      continue;
    }
    if (c === ',') { flush(i); itemStart = i + 1; } else if (c === ']') { flush(i); return true; }
    i += 1;
  }
  flush(rest.length);
  return false;
}

interface Line { indent: number; text: string }

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  return i;
}

// Reads a list given the text after the key and the lines that follow it (deeper-indented or same-indent "- " lines).
function readList(key: string, rest: string, following: readonly Line[], problems: string[]): string[] {
  const items: string[] = [];
  const trimmed = rest.trim();
  if (trimmed.startsWith('[')) {
    if (!inlineItems(trimmed, items)) addLimited(problems, `${key}: the list is not closed`, MAX_PROBLEMS);
  } else if (trimmed !== '' && !trimmed.startsWith('|') && !trimmed.startsWith('>')) {
    const single = scalarText(trimmed);
    if (single !== undefined) items.push(single);
  } else if (following.length > 0) {
    const base = following[0]?.indent ?? 0;
    for (const line of following) {
      if (line.indent !== base || !(line.text.startsWith('- ') || line.text === '-')) continue;
      const item = scalarText(line.text.slice(2));
      if (item !== undefined) items.push(item);
      if (items.length > MAX_LIST_ENTRIES) break;
    }
  }
  if (items.length > MAX_LIST_ENTRIES) {
    addLimited(problems, `${key}: the list has more than ${MAX_LIST_ENTRIES} entries and the rest was ignored`, MAX_PROBLEMS);
    items.length = MAX_LIST_ENTRIES;
  }
  return items.map((item) => cap(item, MAX_LINE_CHARS));
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Frontmatter

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]{0,63}):(?:[ \t]+(.*))?$/;
const KNOWN_KEYS: ReadonlySet<string> = new Set(['phase', 'plan', 'wave', 'depends_on', 'files_modified', 'requirements', 'autonomous', 'gap_closure', 'estimate', 'must_haves']);

type Block = { kind: 'none' } | { kind: 'bad'; problem: string } | { kind: 'ok'; lines: string[] };

function frontmatterBlock(text: string): Block {
  const { lines, truncated } = splitLines(text, MAX_FRONTMATTER_LINES + 2);
  if ((lines[0] ?? '').trimEnd() !== '---') return { kind: 'none' };
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trimEnd() === '---') return { kind: 'ok', lines: lines.slice(1, i) };
  }
  return { kind: 'bad', problem: truncated ? `the frontmatter is longer than ${MAX_FRONTMATTER_LINES} lines` : 'the frontmatter block is not closed' };
}

interface Entry { key: string; rest: string; children: Line[] }

function topLevelEntries(lines: readonly string[], problems: string[]): Entry[] {
  const entries: Entry[] = [];
  let current: Entry | undefined;
  lines.forEach((raw, number) => {
    const text = raw.trimEnd();
    const body = text.trimStart();
    if (body === '' || body.startsWith('#')) return;
    const indent = indentOf(text);
    if (indent > 0 || body.startsWith('- ') || body === '-') {
      current?.children.push({ indent, text: body });
      return;
    }
    const match = KEY_LINE.exec(text);
    if (match === null) {
      addLimited(problems, `frontmatter line ${number + 2} is not a key`, MAX_PROBLEMS);
      current = undefined;
      return;
    }
    current = { key: match[1] ?? '', rest: match[2] ?? '', children: [] };
    entries.push(current);
  });
  return entries;
}

// Child entries of a nested map at its first indent: each child key with the lines that belong to it.
function childEntries(children: readonly Line[]): Entry[] {
  const out: Entry[] = [];
  const base = children[0]?.indent ?? 0;
  let current: Entry | undefined;
  for (const line of children) {
    const match = line.indent === base && !line.text.startsWith('- ') ? KEY_LINE.exec(line.text) : null;
    if (match !== null) {
      current = { key: match[1] ?? '', rest: match[2] ?? '', children: [] };
      out.push(current);
    } else current?.children.push(line);
  }
  return out;
}

export function parseFrontmatter(text: string): { fields: PlanFrontmatter | undefined; problems: string[] } {
  const problems: string[] = [];
  const block = frontmatterBlock(text);
  if (block.kind === 'none') return { fields: undefined, problems };
  if (block.kind === 'bad') return { fields: undefined, problems: [block.problem] };
  const fields: PlanFrontmatter = { dependsOn: [], filesModified: [], requirements: [], truths: [], gapClosure: false };
  for (const entry of topLevelEntries(block.lines, problems)) {
    if (!KNOWN_KEYS.has(entry.key)) continue;
    switch (entry.key) {
      case 'phase': fields.phase = scalarText(entry.rest); break;
      case 'plan': fields.plan = scalarText(entry.rest); break;
      case 'wave': fields.wave = scalarInt(entry.rest); break;
      case 'autonomous': fields.autonomous = scalarBool(entry.rest); break;
      case 'gap_closure': fields.gapClosure = scalarBool(entry.rest) === true; break;
      case 'depends_on': fields.dependsOn = readList(entry.key, entry.rest, entry.children, problems); break;
      case 'files_modified': fields.filesModified = readList(entry.key, entry.rest, entry.children, problems); break;
      case 'requirements': fields.requirements = readList(entry.key, entry.rest, entry.children, problems); break;
      case 'estimate':
        for (const child of childEntries(entry.children)) {
          if (child.key === 'tokens') fields.estimateTokens = scalarInt(child.rest);
          else if (child.key === 'tasks') fields.estimateTasks = scalarInt(child.rest);
          else if (child.key === 'confidence') {
            const value = scalarText(child.rest);
            if (value !== undefined && CONFIDENCES.has(value)) fields.confidence = value as 'low' | 'medium' | 'high';
          }
        }
        break;
      case 'must_haves':
        for (const child of childEntries(entry.children)) {
          if (child.key === 'truths') fields.truths = readList('must_haves.truths', child.rest, child.children, problems);
        }
        break;
      default: break;
    }
  }
  if (fields.estimateTokens !== undefined && fields.estimateTokens < 1) fields.estimateTokens = undefined;
  for (const key of ['phase', 'plan', 'wave', 'autonomous', 'estimateTokens', 'estimateTasks', 'confidence'] as const) {
    if (fields[key] === undefined) delete fields[key];
  }
  return { fields, problems };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Tasks

function readTag(block: string, tag: string): string | undefined {
  const open = block.indexOf(`<${tag}>`);
  if (open === -1) return undefined;
  const close = block.indexOf(`</${tag}>`, open);
  return close === -1 ? undefined : block.slice(open + tag.length + 2, close);
}

function startsLine(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

function taskFiles(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const files: string[] = [];
  for (const part of raw.split(',')) {
    const file = part.trim();
    if (file !== '' && !/[\u0000-\u001f]/.test(file)) files.push(cap(file, MAX_FILE_CHARS));
    if (files.length >= MAX_LIST_ENTRIES) break;
  }
  return files;
}

function fallbackTasks(text: string): GsdTask[] {
  const { lines } = splitLines(text, MAX_ROADMAP_LINES);
  const start = lines.findIndex((line) => /^##\s+Tasks\s*$/i.test(line));
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    section.push(line);
  }
  const headings = section.filter((line) => /^###\s+/.test(line)).map((line) => line.replace(/^###\s+(?:\d+[.)]\s*)?/, ''));
  const bullets = section.filter((line) => /^(?:[-*]|\d+[.)])\s+\S/.test(line)).map((line) => line.replace(/^(?:[-*]|\d+[.)])\s+/, ''));
  const titles = headings.length > 0 ? headings : bullets;
  const tasks: GsdTask[] = [];
  for (const title of titles) {
    const clean = tidy(title, MAX_TITLE_CHARS);
    if (clean === '') continue;
    tasks.push({ index: tasks.length + 1, title: clean, type: 'auto', files: [] });
    if (tasks.length >= MAX_TASKS_PER_PLAN) break;
  }
  return tasks;
}

export function parsePlanTasks(text: string): GsdTask[] {
  const tasks: GsdTask[] = [];
  let from = 0;
  while (tasks.length < MAX_TASKS_PER_PLAN) {
    const start = text.indexOf('<task', from);
    if (start === -1) break;
    from = start + 5;
    const after = text[start + 5];
    if ((after !== ' ' && after !== '>' && after !== '\n' && after !== '\t') || !startsLine(text, start)) continue;
    // The start tag is looked for inside a short window, and one missing closing tag ends the scan: no later task can close either.
    const headEnd = text.slice(start, start + MAX_TASK_START_TAG).indexOf('>');
    if (headEnd === -1) continue;
    const tagEnd = start + headEnd;
    const close = text.indexOf('</task>', tagEnd);
    if (close === -1) break;
    const startTag = text.slice(start, tagEnd + 1);
    const block = text.slice(tagEnd + 1, close);
    from = close + 7;
    const typeMatch = /\btype="([a-z][a-z:-]{0,39})"/.exec(startTag);
    const name = readTag(block, 'name') ?? '';
    const title = tidy(name.replace(/^\s*Task\s+\d+\s*[:.-]\s*/, ''), MAX_TITLE_CHARS);
    tasks.push({ index: tasks.length + 1, title: title === '' ? `Task ${tasks.length + 1}` : title, type: typeMatch?.[1] ?? 'auto', files: taskFiles(readTag(block, 'files')) });
  }
  return tasks.length > 0 ? tasks : fallbackTasks(text);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Roadmap

function milestoneKeyOf(title: string): string {
  const version = /^v?\d+\.\d+(?:\.(?:\d+|x))?(?![A-Za-z0-9])/i.exec(title);
  if (version !== null) return version[0].toLowerCase();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_KEY_CHARS).replace(/-+$/, '');
  return slug === '' ? 'milestone' : slug;
}

function cleanHeading(text: string): string {
  return tidy(text.replace(/^[^A-Za-z0-9]+/, ''), MAX_TITLE_CHARS);
}

function parseMilestoneBullet(text: string): RoadmapMilestone | undefined {
  const bold = /\*\*([^*]{1,200})\*\*/.exec(text);
  const title = cleanHeading(bold !== null ? (bold[1] ?? '') : (text.split(':')[0] ?? ''));
  if (title === '') return undefined;
  const range = new RegExp(`Phases?\\s+(\\d+(?:\\.\\d+)*)\\s*[${DASH_ESCAPES}]\\s*(\\d+(?:\\.\\d+)*)`).exec(text);
  const marked = text.includes(CONSTRUCTION_SIGN);
  const milestone: RoadmapMilestone = {
    key: milestoneKeyOf(title), title, shipped: /\bSHIPPED\b/i.test(text), paused: /\bPAUSED\b/i.test(text), current: marked || /\bcurrent\b/i.test(text), marked,
  };
  if (range !== null) { milestone.first = normalisePhase(range[1] ?? ''); milestone.last = normalisePhase(range[2] ?? ''); }
  return milestone;
}

const NUMBER_STICKY = /\d+(?:\.\d+)*/y;
const SEPARATOR_STICKY = /\s*(?:,|and|&)\s*/y;

// Phase numbers named after "Phase" or "Phases" ("Phase 90", "Phases 64, 65 and 66"), one linear scan.
function phaseRefs(text: string): string[] {
  const out: string[] = [];
  const head = /\bPhases?\s+/gi;
  for (let found = head.exec(text); found !== null && out.length < MAX_LIST_ENTRIES; found = head.exec(text)) {
    let pos = found.index + found[0].length;
    while (out.length < MAX_LIST_ENTRIES) {
      NUMBER_STICKY.lastIndex = pos;
      const number = NUMBER_STICKY.exec(text);
      if (number === null) break;
      const phase = normalisePhase(number[0]);
      if (!out.includes(phase)) out.push(phase);
      pos += number[0].length;
      SEPARATOR_STICKY.lastIndex = pos;
      const separator = SEPARATOR_STICKY.exec(text);
      if (separator === null) break;
      pos += separator[0].length;
    }
  }
  return out;
}

const REQUIREMENT_SCAN = /([A-Z][A-Z0-9]{0,15})-(\d{1,3})(?:\s*(?:\u2026|\.{3}|\u2013|\u2014|\bto\b)\s*(?:\1-)?(\d{1,3}))?/g;

// Requirement ids in a comma list, expanding the range form "CYBER-01 ... CYBER-12".
function requirementIds(text: string): string[] {
  const out: string[] = [];
  REQUIREMENT_SCAN.lastIndex = 0;
  for (let found = REQUIREMENT_SCAN.exec(text); found !== null && out.length < MAX_LIST_ENTRIES; found = REQUIREMENT_SCAN.exec(text)) {
    const prefix = found[1] ?? '';
    const width = (found[2] ?? '').length;
    const from = Number(found[2]);
    const to = found[3] === undefined ? from : Number(found[3]);
    const last = to >= from && to - from <= MAX_REQUIREMENT_SPAN ? to : from;
    for (let n = from; n <= last && out.length < MAX_LIST_ENTRIES; n += 1) {
      const id = `${prefix}-${String(n).padStart(width, '0')}`;
      if (REQUIREMENT_ID.test(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

// A trailing parenthesised group of requirement ids on a checklist title: "Tracer: slice (FIX-01, FIX-02)".
function splitTitleRequirements(title: string): { title: string; requirements: string[] } {
  const open = title.lastIndexOf('(');
  if (open > 0 && title.endsWith(')')) {
    const inner = title.slice(open + 1, -1);
    const parts = inner.split(',').map((part) => part.trim());
    if (parts.length > 0 && parts.every((part) => REQUIREMENT_ID.test(part))) return { title: title.slice(0, open).trim(), requirements: parts };
  }
  return { title, requirements: [] };
}

const PHASE_HEADING = /^#{3,4}\s+Phase\s+(\d+(?:\.\d+)*):\s*(.+)$/;
const FIELD_LINE = /^\*\*([^*:]{1,40}?):?\*\*:?\s*(.*)$/;
const CHECKLIST = new RegExp(`^-\\s+\\[([ xX])\\]\\s+(\\d+(?:\\.\\d+)*)-(\\d+)(?:-PLAN\\.md)?\\s*[:${DASH_ESCAPES}]+\\s*(.+)$`);

export function parseRoadmap(text: string): Roadmap {
  const roadmap: Roadmap = { milestones: [], sections: [], problems: [] };
  const { lines, truncated } = splitLines(text, MAX_ROADMAP_LINES);
  if (truncated) roadmap.problems.push(`the roadmap is longer than ${MAX_ROADMAP_LINES} lines and the rest was ignored`);
  let mode: 'none' | 'milestones' | 'section' = 'none';
  let section: RoadmapSection | undefined;
  let phase: RoadmapPhase | undefined;
  let wave: number | undefined;
  let fenced = false;
  let phaseCount = 0;
  for (const line of lines) {
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced) continue;
    const sectionMatch = /^##\s+(.+)$/.exec(line);
    if (sectionMatch !== null) {
      const title = cleanHeading(sectionMatch[1] ?? '');
      phase = undefined;
      wave = undefined;
      if (title.toLowerCase() === 'milestones') { mode = 'milestones'; section = undefined; continue; }
      if (roadmap.sections.length >= MAX_SECTIONS) {
        addLimited(roadmap.problems, `the roadmap has more than ${MAX_SECTIONS} sections and the rest was ignored`, MAX_PROBLEMS);
        mode = 'none';
        section = undefined;
        continue;
      }
      mode = 'section';
      section = { key: milestoneKeyOf(title), title, phases: [] };
      roadmap.sections.push(section);
      continue;
    }
    if (mode === 'milestones') {
      const bullet = /^[-*]\s+(.+)$/.exec(line);
      const milestone = bullet === null ? undefined : parseMilestoneBullet(bullet[1] ?? '');
      if (milestone !== undefined && roadmap.milestones.length < MAX_MILESTONES) roadmap.milestones.push(milestone);
      else if (milestone !== undefined) addLimited(roadmap.problems, `the roadmap lists more than ${MAX_MILESTONES} milestones and the rest was ignored`, MAX_PROBLEMS);
      continue;
    }
    if (mode !== 'section' || section === undefined) continue;
    const heading = PHASE_HEADING.exec(line);
    if (heading !== null) {
      const title = tidy((heading[2] ?? '').replace(/\s*\(INSERTED\)\s*/gi, ' '), MAX_TITLE_CHARS);
      phase = { number: normalisePhase(heading[1] ?? ''), title, dependsOn: [], requirements: [], plans: [] };
      if (phaseCount < MAX_ROADMAP_PHASES) { section.phases.push(phase); phaseCount += 1; } else addLimited(roadmap.problems, `the roadmap has more than ${MAX_ROADMAP_PHASES} phases and the rest was ignored`, MAX_PROBLEMS);
      wave = undefined;
      continue;
    }
    const field = FIELD_LINE.exec(line);
    if (field !== null) {
      const name = (field[1] ?? '').trim().toLowerCase();
      const rest = field[2] ?? '';
      const waveLabel = /^wave\s+(\d{1,3})$/.exec(name);
      if (waveLabel !== null) wave = Number(waveLabel[1]);
      else if (phase !== undefined && name === 'depends on') phase.dependsOn = /^\s*(?:nothing|none)\b/i.test(rest) ? [] : phaseRefs(rest);
      else if (phase !== undefined && name === 'requirements') phase.requirements = requirementIds(rest);
      continue;
    }
    const item = CHECKLIST.exec(line);
    if (item !== null && phase !== undefined) {
      const split = splitTitleRequirements(tidy(item[4] ?? '', MAX_TITLE_CHARS));
      const entry: RoadmapPlanEntry = {
        phase: normalisePhase(item[2] ?? ''), plan: padPlan(item[3] ?? ''), title: split.title, checked: (item[1] ?? ' ') !== ' ', requirements: split.requirements,
      };
      if (wave !== undefined) entry.wave = wave;
      if (phase.plans.length < MAX_PLANS) phase.plans.push(entry);
    }
  }
  return roadmap;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Current milestone

interface KnownMilestone { key: string; title: string; first?: string; last?: string; bullet?: RoadmapMilestone; section?: RoadmapSection }

function knownMilestones(roadmap: Roadmap): KnownMilestone[] {
  const out: KnownMilestone[] = [];
  const byKey = new Map<string, KnownMilestone>();
  for (const bullet of roadmap.milestones) {
    if (byKey.has(bullet.key)) continue;
    const known: KnownMilestone = { key: bullet.key, title: bullet.title, bullet };
    if (bullet.first !== undefined) known.first = bullet.first;
    if (bullet.last !== undefined) known.last = bullet.last;
    byKey.set(bullet.key, known);
    out.push(known);
  }
  for (const section of roadmap.sections) {
    const known = byKey.get(section.key);
    if (known !== undefined) {
      if (known.section === undefined) { known.section = section; known.title = section.title; }
    } else if (section.phases.length > 0) {
      const added: KnownMilestone = { key: section.key, title: section.title, section };
      byKey.set(section.key, added);
      out.push(added);
    }
  }
  return out;
}

const sameKey = (left: string, right: string): boolean => left.toLowerCase().replace(/^v/, '') === right.toLowerCase().replace(/^v/, '');

function stateMilestone(stateText: string): string | undefined {
  const block = frontmatterBlock(stateText);
  if (block.kind !== 'ok') return undefined;
  for (const line of block.lines) {
    const match = /^milestone:[ \t]+(.*)$/.exec(line.trimEnd());
    if (match !== null) return scalarText(match[1] ?? '');
  }
  return undefined;
}

function currentKeyOf(known: readonly KnownMilestone[], stateText: string | undefined): string | undefined {
  const named = stateText === undefined ? undefined : stateMilestone(stateText);
  if (named !== undefined) {
    const hit = known.find((item) => sameKey(item.key, named));
    if (hit !== undefined) return hit.key;
  }
  return (known.find((item) => item.bullet?.marked === true) ?? known.find((item) => item.bullet?.current === true))?.key;
}

export function currentMilestoneKey(roadmap: Roadmap, stateText: string | undefined): string | undefined {
  return currentKeyOf(knownMilestones(roadmap), stateText);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Graph

interface Located { phase: string; plan: string; path: string; archived: boolean }

function slugTitle(directory: string): string {
  const words = directory.replace(/^(?:phases-)?\d+(?:\.\d+)*-/, '').replace(/-+/g, ' ').trim();
  return words === '' ? directory : words.charAt(0).toUpperCase() + words.slice(1);
}

function headingTitle(text: string): string | undefined {
  const { lines } = splitLines(text, 20);
  for (const line of lines) {
    const match = /^#\s+(?:Plan\s+\d+(?:\.\d+)*-\d+\s*[:-]\s*)?(.+)$/.exec(line);
    if (match !== null) {
      const title = tidy(match[1] ?? '', MAX_TITLE_CHARS);
      if (title !== '') return title;
    }
  }
  return undefined;
}

function inRange(phase: string, known: KnownMilestone): boolean {
  return known.first !== undefined && known.last !== undefined && compareNumberParts(phase, known.first) >= 0 && compareNumberParts(phase, known.last) <= 0;
}

export function buildGsdGraph(source: GsdSource, options: { milestone?: string } = {}): GsdGraph | { error: string } {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (warnings.length < MAX_WARNINGS - 1) warnings.push(tidy(message, MAX_WARNING_CHARS));
    else if (warnings.length === MAX_WARNINGS - 1) warnings.push('More warnings were left out.');
  };
  const roadmapText = source.files.get(ROADMAP_PATH);
  if (roadmapText === undefined) return { error: 'The roadmap (.planning/ROADMAP.md) was not found.' };
  const roadmap = parseRoadmap(roadmapText);
  for (const problem of roadmap.problems) warn(problem);
  const known = knownMilestones(roadmap);
  const currentKey = currentKeyOf(known, source.files.get(STATE_PATH));
  const chosen = options.milestone === undefined
    ? known.find((item) => item.key === currentKey)
    : known.find((item) => sameKey(item.key, options.milestone ?? ''));
  if (chosen === undefined) {
    return { error: options.milestone === undefined ? 'The roadmap does not say which milestone is current.' : `The roadmap has no milestone ${tidy(options.milestone, 60)}.` };
  }
  const milestones: GsdMilestone[] = known.map((item) => ({ key: item.key, title: item.title, current: item.key === currentKey }));

  const sectionPhases = chosen.section !== undefined && chosen.section.phases.length > 0 ? chosen.section.phases : undefined;
  const sectionSet = new Set((sectionPhases ?? []).map((item) => item.number));
  const roadmapPhases = new Set<string>();
  for (const item of known) for (const entry of item.section?.phases ?? []) roadmapPhases.add(entry.number);
  const knownAnywhere = (phase: string): boolean => roadmapPhases.has(phase) || known.some((item) => inRange(phase, item));

  // Locate every plan and summary by its file name, anywhere under .planning.
  const groups = new Map<string, Located[]>();
  const summaries = new Set<string>();
  for (const path of source.paths.slice(0, MAX_PATHS)) {
    const id = planIdentity(path);
    if (id === undefined) continue;
    const key = `${id.phase}-${id.plan}`;
    if (id.kind === 'summary') { summaries.add(key); continue; }
    const located: Located = { phase: id.phase, plan: id.plan, path, archived: path.startsWith(MILESTONES_PREFIX) };
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [located]); else group.push(located);
  }

  const chosenPlans: Located[] = [];
  const orderedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, group] of orderedGroups) {
    const phase = group[0]?.phase ?? '';
    const preferred = [...group].sort((a, b) => Number(a.archived) - Number(b.archived) || a.path.localeCompare(b.path));
    const inMilestone = sectionPhases !== undefined ? sectionSet.has(phase) : inRange(phase, chosen);
    if (inMilestone) {
      const candidates = sectionPhases !== undefined ? preferred : preferred.filter((item) => item.archived);
      const pick = candidates[0];
      if (pick === undefined) continue;
      if (candidates.length > 1) warn(`Plan ${key} is in ${candidates.length} places; using ${pick.path}.`);
      chosenPlans.push(pick);
    } else if (preferred.some((item) => item.path.startsWith(PHASES_PREFIX)) && !preferred.some((item) => item.archived) && !knownAnywhere(phase)) {
      warn(`Skipped plan ${key}: phase ${phase} is not in the roadmap.`);
    }
  }
  chosenPlans.sort((a, b) => compareNumberParts(a.phase, b.phase) || compareNumberParts(a.plan, b.plan));
  if (chosenPlans.length > MAX_PLANS) { warn(`Only the first ${MAX_PLANS} plans were read.`); chosenPlans.length = MAX_PLANS; }

  // Roadmap checklist lines supply plan titles, waves and the requirement group.
  const entries = new Map<string, RoadmapPlanEntry>();
  for (const section of roadmap.sections) for (const phase of section.phases) for (const entry of phase.plans) entries.set(`${entry.phase}-${entry.plan}`, entry);

  const plans: GsdPlan[] = [];
  for (const located of chosenPlans) {
    const key = `${located.phase}-${located.plan}`;
    const text = source.files.get(located.path);
    const entry = entries.get(key);
    if (text === undefined) warn(`Plan ${key} was listed but its text was not read.`);
    const { fields, problems } = text === undefined ? { fields: undefined, problems: [] as string[] } : parseFrontmatter(text);
    for (const problem of problems) warn(`Plan ${key}: ${problem}.`);
    const named = fields?.phase === undefined ? undefined : /^\d+(?:\.\d+)*/.exec(fields.phase)?.[0];
    if (named !== undefined && normalisePhase(named) !== located.phase) warn(`Plan ${key}: the frontmatter phase ${tidy(fields?.phase ?? '', 40)} does not match the file name.`);
    const dependsOn: string[] = [];
    for (const raw of fields?.dependsOn ?? []) {
      const ref = normalisePlanRef(raw);
      if (ref === undefined) warn(`Plan ${key}: dependency ${tidy(raw, 40)} is not a plan reference.`);
      else if (!dependsOn.includes(ref)) dependsOn.push(ref);
    }
    const requirements = (fields?.requirements ?? entry?.requirements ?? []).filter((id) => REQUIREMENT_ID.test(id));
    const plan: GsdPlan = {
      phase: located.phase,
      plan: located.plan,
      path: located.path,
      title: entry?.title ?? (text === undefined ? undefined : headingTitle(text.slice(fields === undefined ? 0 : text.indexOf('\n---', 3) + 4))) ?? `Plan ${key}`,
      dependsOn,
      filesModified: fields?.filesModified ?? [],
      requirements,
      truths: (fields?.truths ?? []).map((truth) => tidy(truth, MAX_LINE_CHARS)).filter((truth) => truth !== ''),
      gapClosure: fields?.gapClosure === true,
      hasSummary: summaries.has(key),
      tasks: text === undefined ? [] : parsePlanTasks(text),
    };
    const wave = fields?.wave ?? entry?.wave;
    if (wave !== undefined) plan.wave = wave;
    if (fields?.estimateTokens !== undefined) plan.estimateTokens = fields.estimateTokens;
    if (fields?.confidence !== undefined) plan.confidence = fields.confidence;
    plans.push(plan);
  }

  let phases: GsdPhase[];
  if (sectionPhases !== undefined) {
    const seen = new Set<string>();
    phases = [];
    for (const item of sectionPhases) {
      if (seen.has(item.number)) continue;
      seen.add(item.number);
      phases.push({ number: item.number, title: item.title, dependsOn: item.dependsOn, requirements: item.requirements });
    }
    phases.sort((a, b) => compareNumberParts(a.number, b.number));
  } else {
    const titles = new Map<string, string>();
    for (const located of chosenPlans) {
      const segments = located.path.split('/');
      if (!titles.has(located.phase)) titles.set(located.phase, slugTitle(segments[segments.length - 2] ?? located.phase));
    }
    phases = [...titles.entries()].sort((a, b) => compareNumberParts(a[0], b[0])).map(([number, title]) => ({ number, title, dependsOn: [], requirements: [] }));
  }

  return { milestone: { key: chosen.key, title: chosen.title, current: chosen.key === currentKey }, phases, plans, milestones, warnings };
}

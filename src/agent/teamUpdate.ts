import { parseFrontmatter } from '../gsd/library';
import { PROJECT_TYPES, projectGuidanceBlock, readProjectGuidance, replaceProjectGuidance, templateVersion, type ProjectType } from './projectTypes';
import { guidanceFingerprint, memberFingerprint, splitGoal } from './teamFingerprints';
import { lineDiff, splitTeam, type DiffLine, type Section } from './teamMarkdown';
import { TEMPLATE_HISTORY } from './teamTemplateHistory';

// Update Team: bring a team file made from a built-in project type up to the current definition
// without losing the user's own work. Each member is merged three ways: the base is the definition
// the member was generated from (recorded in the file's frontmatter, or, for a file made before
// stamps existed, any released version of that member); the user's copy is the file; the new
// version is today's built-in. A member still equal to its base is replaced; a member the user
// changed is never overwritten without their choice; members the user added are left alone. A permanent built-in member (the research
// team's plagiarism checker) is added without asking when the file lacks it, even when the user removed it, and the plan says which.

const WEB = ['WebSearch', 'WebFetch', 'CheckCitations', 'CheckOriginality'];
const STAMP_KEYS = ['template', 'templateVersion', 'templateBase'];

export interface TemplateRef {
  id: string;
  label: string;
  /** Whether the file records its template (frontmatter), or it was inferred from member names. */
  stamped: boolean;
  fromVersion?: number;
  toVersion: number;
  /** Each member's fingerprint when it was generated, from the stamp. */
  base?: Record<string, string>;
}

/**
 * auto: unchanged since generated, replaced. same: already current. choice: the user changed it; they choose. kept: the user chose their own
 * version against this same built-in definition before, so they are not asked again until the built-in changes.
 * new: a built-in member the file lacks, offered; or, when `permanent`, added without asking (the plan's reason says whether it was missing
 * or removed by the user). removed: no longer built in, flagged and kept. custom: the user's own member, kept.
 */
export type MemberAction = 'auto' | 'same' | 'choice' | 'kept' | 'new' | 'removed' | 'custom';
export interface MemberPlan { name: string; action: MemberAction; reason: string; current?: string; proposed?: string; merged?: string; diff?: DiffLine[]; permanent?: boolean }
export interface TeamUpdatePlan { template: TemplateRef; upToDate: boolean; local: boolean; goal?: string; members: MemberPlan[] }
export type MemberDecision = 'take' | 'keep' | 'merge';
export interface UpdateDecisions { members?: Record<string, MemberDecision>; add?: string[] }

/** The stamp written into a team made from a project type: the template, its version, and each member's base fingerprint. */
export function templateStamp(type: ProjectType, local = false): string[] {
  return [`template: ${type.id}`, `templateVersion: ${templateVersion(type.id)}`, 'templateBase:', ...type.members.map((member) => `  - ${member.name}=${builtInFingerprint(type, member.name, local)}`)];
}

/** A team file with its template stamp set (replacing any earlier stamp); a team without the type's web tools is stamped as the local variant. */
export function stampTeam(text: string, type: ProjectType, local = isLocalVariant(splitTeam(text).sections, type)): string {
  return withFrontmatter(text, templateStamp(type, local));
}

/** A local-only project's team is generated without web tools. */
function isLocalVariant(sections: Section[], type: ProjectType): boolean {
  const webMembers = type.members.filter((member) => member.tools?.some((tool) => WEB.includes(tool))).map((member) => member.name);
  const present = sections.filter((section) => webMembers.includes(section.name));
  return present.length > 0 && present.every((section) => section.tools && !section.tools.some((tool) => WEB.includes(tool)));
}

function withFrontmatter(text: string, lines: string[]): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return `---\n${lines.join('\n')}\n---\n\n${text}`;
  const kept: string[] = [];
  let skipping = false;
  for (const line of match[1].split(/\r?\n/)) {
    if (skipping && /^\s+-\s/.test(line)) continue;
    skipping = false;
    const key = /^([A-Za-z0-9_-]+):/.exec(line)?.[1];
    if (key && STAMP_KEYS.includes(key)) { skipping = true; continue; }
    kept.push(line);
  }
  return `---\n${[...kept, ...lines].join('\n')}\n---\n${text.slice(match[0].length)}`;
}

function builtInSection(type: ProjectType, name: string, local: boolean, goal?: string): Omit<Section, 'raw'> | undefined {
  const member = type.members.find((entry) => entry.name === name);
  if (!member) return undefined;
  const tools = member.tools ? (local ? member.tools.filter((tool) => !WEB.includes(tool)) : [...member.tools]) : undefined;
  return { name, ...(member.role ? { role: member.role } : {}), ...(member.model ? { model: member.model } : {}), ...(member.privacy ? { privacy: member.privacy } : {}), ...(tools ? { tools } : {}), instructions: goal ? `${member.instructions}\n\nProject goal: ${goal}` : member.instructions };
}

function builtInFingerprint(type: ProjectType, name: string, local: boolean): string {
  const section = builtInSection(type, name, local)!;
  return memberFingerprint({ ...section, tools: section.tools ?? null });
}

const fingerprintOf = (section: Omit<Section, 'raw'>) => memberFingerprint({ ...section, tools: section.tools ?? null });

function renderSection(section: Omit<Section, 'raw'>): string {
  const lines = [`## ${section.name}`];
  if (section.role) lines.push(`role: ${section.role}`);
  if (section.model) lines.push(`model: ${section.model}`);
  if (section.reportsTo) lines.push(`reports-to: ${section.reportsTo}`);
  if (section.tools?.length) lines.push(`tools: ${section.tools.join(', ')}`);
  // privacy is always the last metadata line: a build from before it existed reads role, model, and tools correctly and takes this line as
  // the first line of the instructions, rather than stopping before tools and giving the member the default tools.
  if (section.privacy) lines.push(`privacy: ${section.privacy}`);
  return `${lines.join('\n')}\n\n${section.instructions.trim()}\n`;
}

/** The project type a team file comes from: its stamp, or else the type whose member names it shares most (at least three, and half the type). */
export function detectTemplate(text: string): TemplateRef | undefined {
  const { data } = parseFrontmatter(text);
  const stampedType = typeof data.template === 'string' ? PROJECT_TYPES.find((type) => type.id === data.template) : undefined;
  if (stampedType) {
    const base: Record<string, string> = {};
    for (const entry of Array.isArray(data.templateBase) ? data.templateBase : []) { const [name, print] = String(entry).split('='); if (name && print) base[name.trim()] = print.trim(); }
    const from = Number(data.templateVersion);
    return { id: stampedType.id, label: stampedType.label, stamped: true, ...(Number.isFinite(from) && from > 0 ? { fromVersion: from } : {}), toVersion: templateVersion(stampedType.id), base };
  }
  let names: string[];
  try { names = splitTeam(text).sections.map((section) => section.name); } catch { return undefined; }
  let best: { type: ProjectType; score: number } | undefined;
  for (const type of PROJECT_TYPES) {
    const versions = TEMPLATE_HISTORY[type.id] ?? [];
    const known = new Set(versions.length ? versions.flatMap((version) => Object.keys(version.members)) : type.members.map((member) => member.name));
    const shared = names.filter((name) => known.has(name)).length;
    // Measured against the smallest released team, so adding a member to the built-in team does not stop an older file being recognised.
    const size = Math.min(type.members.length, ...versions.map((version) => Object.keys(version.members).length));
    const score = shared / Math.max(1, size);
    if (shared >= 3 && score >= 0.5 && (!best || score > best.score)) best = { type, score };
  }
  return best ? { id: best.type.id, label: best.type.label, stamped: false, toVersion: templateVersion(best.type.id) } : undefined;
}

/** A user's member with the new definition's additions only: a privacy line, new tools, and new Output and Done-when paragraphs. */
function mergeNewLines(mine: Omit<Section, 'raw'>, theirs: Omit<Section, 'raw'>): Omit<Section, 'raw'> {
  const { body, goal } = splitGoal(mine.instructions);
  // A section the user already has (by its "Output:" or "Done when:" prefix, whatever its wording) is theirs; only missing ones are added.
  const prefix = (paragraph: string) => /^(Output|Done when):/i.exec(paragraph.trim())?.[1].toLowerCase();
  const own = new Set(body.split(/\n\n+/).map(prefix).filter(Boolean));
  const additions = splitGoal(theirs.instructions).body.split(/\n\n+/).filter((paragraph) => { const kind = prefix(paragraph); return kind !== undefined && !own.has(kind); });
  const instructions = [body, ...additions].join('\n\n') + (goal ? `\n\nProject goal: ${goal}` : '');
  const tools = mine.tools ? [...mine.tools, ...(theirs.tools ?? []).filter((tool) => !mine.tools!.includes(tool))] : undefined;
  return { ...mine, ...(mine.privacy || theirs.privacy ? { privacy: mine.privacy ?? theirs.privacy } : {}), ...(tools ? { tools } : {}), instructions };
}

/** What Update Team would do to each member, without writing anything. Undefined when the file is not from a built-in type. */
export function planTeamUpdate(text: string): TeamUpdatePlan | undefined {
  const template = detectTemplate(text);
  if (!template) return undefined;
  const type = PROJECT_TYPES.find((entry) => entry.id === template.id)!;
  const sections = splitTeam(text).sections;
  const history = TEMPLATE_HISTORY[type.id] ?? [];
  const goal = sections.map((section) => splitGoal(section.instructions).goal).find(Boolean);
  const local = isLocalVariant(sections, type);
  const members: MemberPlan[] = [];
  for (const section of sections) {
    const proposedSection = builtInSection(type, section.name, local, goal);
    const current = renderSection(section);
    if (!proposedSection) {
      const historical = history.some((version) => section.name in version.members);
      members.push({ name: section.name, action: historical ? 'removed' : 'custom', reason: historical ? 'No longer part of the built-in team; kept as it is.' : 'Your own member; left as it is.', current });
      continue;
    }
    const withPlace = { ...proposedSection, ...(section.reportsTo ? { reportsTo: section.reportsTo } : {}) };
    const proposed = renderSection(withPlace);
    const mine = fingerprintOf(section);
    if (mine === fingerprintOf(withPlace)) { members.push({ name: section.name, action: 'same', reason: 'Already the current definition.', current, proposed }); continue; }
    const recorded = template.base?.[section.name];
    // "kept:<their fingerprint>:<built-in fingerprint>" records an earlier keep or merge against that built-in definition.
    const kept = /^kept:([0-9a-f]+):([0-9a-f]+)$/.exec(recorded ?? '');
    if (kept) {
      if (kept[2] === builtInFingerprint(type, section.name, local)) { members.push({ name: section.name, action: 'kept', reason: 'You chose to keep your version; not asked again until the built-in definition changes.', current, proposed }); continue; }
      const merged = renderSection(mergeNewLines(section, withPlace));
      members.push({ name: section.name, action: 'choice', reason: 'You kept your own version before, and the built-in definition has changed since; choose what to keep.', current, proposed, merged, diff: lineDiff(current, proposed) });
      continue;
    }
    const base = recorded;
    const unchanged = base ? mine === base : history.some((version) => version.members[section.name]?.includes(mine));
    if (unchanged) {
      members.push({ name: section.name, action: 'auto', reason: base ? 'Unchanged since it was generated; replaced with the current definition.' : 'Matches an earlier built-in version exactly; replaced with the current definition.', current, proposed });
    } else {
      const merged = renderSection(mergeNewLines(section, withPlace));
      members.push({ name: section.name, action: 'choice', reason: base || template.stamped ? 'You changed this member; choose what to keep.' : 'This member does not match any built-in version, so it is treated as changed by you; choose what to keep.', current, proposed, merged, diff: lineDiff(current, proposed) });
    }
  }
  for (const member of type.members) {
    if (sections.some((section) => section.name === member.name)) continue;
    // A member the stamp recorded but the file no longer has was removed on purpose; do not offer it back, unless the team cannot work without it.
    const removed = Boolean(template.base && member.name in template.base);
    const proposed = renderSection(builtInSection(type, member.name, local, goal)!);
    if (member.permanent) {
      members.push({ name: member.name, action: 'new', permanent: true, proposed, reason: removed
        ? `REMOVED from this file, but ${member.name} is a permanent member of the ${type.label.toLowerCase()} team that its workflow depends on; added back automatically.`
        : `MISSING from this file: ${member.name} is a permanent member of the ${type.label.toLowerCase()} team; added automatically.` });
      continue;
    }
    if (removed) continue;
    members.push({ name: member.name, action: 'new', reason: 'A new member of the built-in team; add it?', proposed });
  }
  const upToDate = members.every((member) => member.action === 'same' || member.action === 'kept' || member.action === 'custom' || member.action === 'removed') && template.stamped && template.fromVersion === template.toVersion;
  return { template, upToDate, local, ...(goal ? { goal } : {}), members };
}

/** The team file after the update, stamped with the current version. Members without a decision keep the user's copy. */
export function applyTeamUpdate(text: string, plan: TeamUpdatePlan, decisions: UpdateDecisions = {}): string {
  const type = PROJECT_TYPES.find((entry) => entry.id === plan.template.id)!;
  const parts = splitTeam(text);
  const byName = new Map(plan.members.map((member) => [member.name, member]));
  const out: string[] = [];
  for (const section of parts.sections) {
    const member = byName.get(section.name);
    const decision = decisions.members?.[section.name] ?? 'keep';
    if (member && (member.action === 'auto' || member.action === 'same')) out.push(member.proposed!);
    else if (member?.action === 'choice' && decision === 'take') out.push(member.proposed!);
    else if (member?.action === 'choice' && decision === 'merge') out.push(member.merged!);
    else out.push(`${section.raw.replace(/\s+$/, '')}\n`);
  }
  // New members go where the built-in team has them, after the member that precedes them there. Permanent members are added whatever was chosen.
  const adding = [...new Set([...(decisions.add ?? []), ...plan.members.filter((member) => member.action === 'new' && member.permanent).map((member) => member.name)])];
  for (const name of adding) {
    const member = byName.get(name);
    if (member?.action !== 'new') continue;
    const order = type.members.map((entry) => entry.name);
    const after = order.slice(0, order.indexOf(name)).reverse().find((previous) => out.some((block) => block.startsWith(`## ${previous}\n`)));
    const at = after ? out.findIndex((block) => block.startsWith(`## ${after}\n`)) + 1 : out.length;
    out.splice(at, 0, member.proposed!);
  }
  const head = (/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)?.[0] ?? '').replace(/\r?\n?$/, '\n');
  const preamble = parts.preamble.trim() ? parts.preamble.replace(/\s*$/, '\n\n') : '\n';
  const body = `${head}${preamble}${out.join('\n')}`;
  // A member now matching the built-in records the built-in fingerprint, so a later update replaces it if the user leaves it alone. A
  // member the user kept or merged records their own fingerprint and the built-in it was kept against, so it is not asked about again
  // until the built-in definition changes.
  const present = new Map(splitTeam(body).sections.map((section) => [section.name, section]));
  const entry = (name: string) => {
    const builtIn = builtInFingerprint(type, name, plan.local);
    const mine = fingerprintOf(present.get(name)!);
    const action = byName.get(name)?.action;
    const decision = decisions.members?.[name] ?? 'keep';
    const keptMine = mine !== builtIn && (action === 'kept' || (action === 'choice' && decision !== 'take'));
    return keptMine ? `kept:${mine}:${builtIn}` : builtIn;
  };
  const stamp = [`template: ${type.id}`, `templateVersion: ${templateVersion(type.id)}`, 'templateBase:', ...type.members.filter((member) => present.has(member.name)).map((member) => `  - ${member.name}=${entry(member.name)}`)];
  return withFrontmatter(body, stamp);
}

/** One line per member, for a preview or a dry run. */
export function describePlan(plan: TeamUpdatePlan): string {
  const from = plan.template.fromVersion ? `v${plan.template.fromVersion}` : plan.template.stamped ? 'an unknown version' : 'no recorded version (inferred from member names)';
  const label: Record<MemberAction, string> = { auto: 'updates automatically', same: 'already current', choice: 'needs your choice', kept: 'your version, kept as you chose', new: 'new built-in member, can be added', removed: 'no longer built in, kept', custom: 'your own member, kept' };
  return [`${plan.template.label} template: ${from} → v${plan.template.toVersion}`, ...plan.members.map((member) => `- ${member.name}: ${member.permanent && member.action === 'new' ? 'permanent built-in member, added automatically' : label[member.action]}. ${member.reason}`)].join('\n');
}

// ---- AGENTS.md guidance -------------------------------------------------------------------------

export interface GuidancePlan { action: 'none' | 'same' | 'auto' | 'choice'; current?: string; proposed?: string; diff?: DiffLine[] }

/** What Update Team would do to the project-type guidance in AGENTS.md. `base` is the fingerprint recorded in project.json, if any. */
export function planGuidanceUpdate(agents: string, typeId: string, base?: string): GuidancePlan {
  const block = readProjectGuidance(agents);
  const type = PROJECT_TYPES.find((entry) => entry.id === typeId);
  if (!block || !type) return { action: 'none' };
  const proposed = projectGuidanceBlock(type, block.goal ?? '');
  const mine = guidanceFingerprint(block.inner);
  if (mine === guidanceFingerprint(proposed)) return { action: 'same', current: block.inner, proposed };
  const unchanged = base ? mine === base : (TEMPLATE_HISTORY[typeId] ?? []).some((version) => version.guidance.includes(mine));
  return { action: unchanged ? 'auto' : 'choice', current: block.inner, proposed, ...(unchanged ? {} : { diff: lineDiff(block.inner, proposed) }) };
}

/**
 * AGENTS.md with the project-type block replaced by the proposed one, only between its markers: the same text elsewhere in the file (a quoted
 * copy, notes the user keeps above it) is never touched. Throws when the block is no longer what the plan was made from.
 */
export function applyGuidanceUpdate(agents: string, plan: GuidancePlan): string {
  if (!plan.proposed || plan.current === undefined) return agents;
  if (readProjectGuidance(agents)?.inner !== plan.current) throw new Error('The project-type guidance in AGENTS.md changed since the update was planned.');
  return replaceProjectGuidance(agents, plan.proposed) ?? agents;
}

import { findSecrets } from '../domain/team/secrets';
import type { DraftIssue, TeamDraft } from './teamMarkdown';
import { DEFAULT_TOOLS, resolveMemberTools } from './teams';

// The free, local team check (0.4.27): no model call. It looks at a team draft the way a careful reviewer would and reports what is likely to go wrong
// in a run: instructions that ask for something the member's tools cannot do, a member with no clear deliverable or a generic role, two members doing
// the same work, a large team with no one coordinating, a reports-to line that names nobody or goes round in a circle, something that looks like a key,
// and instructions too long to follow. It runs on every edit (as warnings beside the studio's own), and first in Improve with AI. It is quiet on the
// studio's built-in roles, which the tests hold it to.

export type CheckId = 'tool-missing' | 'tool-unneeded-write' | 'no-deliverable' | 'generic-role' | 'no-role' | 'overlap' | 'no-lead' | 'reports-to-missing' | 'reports-to-cycle' | 'secret' | 'too-long';

/** `block`: Improve with AI will not send the team while it is there. `warning`: shown while editing. `advice`: shown only in the Improve panel. */
export type CheckSeverity = 'block' | 'warning' | 'advice';

export interface TeamFinding {
  id: CheckId;
  severity: CheckSeverity;
  /** The member's index in the draft, when the finding is about one member. */
  member?: number;
  field?: DraftIssue['field'];
  message: string;
  /** For tool-missing: the tools that would give the member what its instructions ask for. */
  tools?: string[];
}

/**
 * What instructions ask for, and the tools that provide it. One table, so the capability manifests of Phase 70 replace only its right-hand side. A need
 * is met when the member has ANY of its tools. Phrases are matched only in sentences that are not negated ("Do not edit files" asks for nothing).
 */
export const CAPABILITY_NEEDS: ReadonlyArray<{ need: string; label: string; tools: readonly string[]; phrases: RegExp }> = [
  { need: 'web', label: 'search or read the web', tools: ['WebSearch', 'WebFetch'], phrases: /\b(?:search (?:the web|online|the internet)|web ?search|search widely|browse|look (?:it |them )?up online|primary sources|fetch (?:the |a |each )?(?:pages?|urls?|web ?pages?|sites?)|webfetch|read (?:the |each )?(?:web ?pages?|urls?|websites?))\b/i },
  { need: 'shell', label: 'run commands', tools: ['Bash'], phrases: /\b(?:run (?:the |every |all |each )?(?:relevant )?(?:tests?|test suite|suite|commands?|scripts?|build|linter|lint|checks?|benchmarks?)|execute (?:the |a )?(?:commands?|scripts?|tests?)|in the (?:shell|terminal))\b/i },
  { need: 'edit', label: 'change files', tools: ['Write', 'Edit'], phrases: /\b(?:make the changes|implement(?:s|ing)? (?:the|it|this|that|a|an)\b|fix (?:what|the bugs?|bugs|the issues?|it)\b|(?:edit|change|modify|update|create|write) (?:the |new |those |these |any |each )?(?:files?|code|codebase|source|tests?)\b|add (?:the )?(?:missing )?tests\b|write (?:it|them|the [a-z ]{1,40}?|your [a-z ]{1,40}?) to (?:the |a |disk|file)|save (?:it|them|the [a-z ]{1,40}?) to (?:the |a |disk|file))/i },
  { need: 'documents', label: 'make slides, PDFs or Word files', tools: ['CreatePresentation', 'CreatePdf', 'CreateDocument'], phrases: /\b(?:make|create|produce|build|export|render|write|turn [^.\n]{1,40}? into)\s+(?:it as\s+|them as\s+)?(?:a |an |the )?(?:[a-z-]+ ){0,3}?(?:slides?|slide deck|presentation|powerpoint|pptx|pdf|word (?:file|document)|docx)\b/i }
];

/** The tools that change files: a member told not to edit should not hold them. */
const WRITE_TOOLS = ['Write', 'Edit'];
const NO_EDIT = /\b(?:do not|don't|never|must not|does not)\s+(?:edit|change|modify|write to|touch)\s+(?:any\s+|the\s+)?(?:files?|code|codebase|source)\b/i;
const NEGATED = /\b(?:do not|don't|never|must not|does not|without|no need to|instead of)\b/i;
const DELIVERABLE = /\b(?:report|reports|return|returns|write|writes|produce|produces|record|records|deliver|delivers|hand (?:back|over)|output|summari[sz]e|save|draft|list|answer|say (?:whether|which|what|where|how)|ends? (?:in|with)|finish with|design|build|break (?:it|them|the [a-z ]{1,30}?|[a-z]+) into|prepare|compile|propose|create|into (?:one|a|an) (?:[a-z-]+ ){0,2}(?:summary|report|plan|list|table|brief|document|memo))\b/i;
const GENERIC_ROLES = new Set(['helper', 'agent', 'assistant', 'member', 'worker', 'general', 'generalist', 'custom', 'ai', 'bot', 'misc', 'other', 'team member', 'everything']);
const LEAD_ROLES = /\b(?:lead|leader|planner|coordinator|manager|orchestrator|director|chief|head|captain|editor-in-chief|gsd-planner)\b/i;
/** More words than this and a member is unlikely to follow all of its instructions (Copilot Studio: keep them short and simple). */
export const MAX_INSTRUCTION_WORDS = 1200;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2);

/** Word-pair overlap of two texts (0 to 1): high when two members' instructions say mostly the same thing. */
export function similarity(one: string, two: string): number {
  const pairs = (text: string) => { const list = words(text); return new Set(list.slice(1).map((word, index) => `${list[index]} ${word}`)); };
  const a = pairs(one); const b = pairs(two);
  if (a.size < 6 || b.size < 6) return 0;
  let shared = 0;
  for (const pair of a) if (b.has(pair)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** The capabilities a member's instructions ask for, from sentences that are not negated. */
export function neededCapabilities(instructions: string): string[] {
  const asked = sentences(instructions).filter((sentence) => !NEGATED.test(sentence));
  return CAPABILITY_NEEDS.filter((entry) => asked.some((sentence) => entry.phrases.test(sentence))).map((entry) => entry.need);
}

/** The members that report to one another in a circle (each name once), or an empty list. */
export function reportsToCycles(members: ReadonlyArray<{ name: string; reportsTo?: string }>): string[] {
  const boss = new Map(members.filter((member) => member.reportsTo?.trim()).map((member) => [member.name, member.reportsTo!.trim()]));
  const inCycle = new Set<string>();
  for (const start of boss.keys()) {
    const seen: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !seen.includes(current)) { seen.push(current); current = boss.get(current); }
    if (current !== undefined) for (const name of seen.slice(seen.indexOf(current))) inCycle.add(name);
  }
  return members.map((member) => member.name).filter((name) => inCycle.has(name));
}

export interface CheckOptions {
  /** The tools a member without a tools line gets. */
  defaultTools?: readonly string[];
}

/** Runs every local check on a draft. Pure and fast: it runs on every keystroke's review. */
export function checkTeam(draft: TeamDraft, options: CheckOptions = {}): TeamFinding[] {
  const findings: TeamFinding[] = [];
  const defaults = options.defaultTools ?? DEFAULT_TOOLS;
  const names = new Set(draft.members.map((member) => member.name));
  if (findSecrets(draft.name).length || findSecrets(draft.description).length) findings.push({ id: 'secret', severity: 'block', field: 'description', message: 'The team\'s name or description holds something that looks like a key, token or password. Remove it: Improve with AI will not send this team while it is there.' });
  draft.members.forEach((member, index) => {
    const label = member.name || `Member ${index + 1}`;
    const tools = member.tools ? resolveMemberTools(member.tools) : [...defaults];
    if (findSecrets(member.instructions).length || findSecrets(member.role).length) {
      findings.push({ id: 'secret', severity: 'block', member: index, field: 'instructions', message: `${label}: its instructions hold something that looks like a key, token or password. Remove it: a team file is shared and sent to models, and Improve with AI will not send this team while it is there.` });
    }
    // MCP tools are not guessed at: what they do is up to their server, so a member with any is never told it lacks something.
    const hasMcp = tools.some((tool) => tool.startsWith('mcp__'));
    for (const need of neededCapabilities(member.instructions)) {
      const entry = CAPABILITY_NEEDS.find((candidate) => candidate.need === need)!;
      if (hasMcp || entry.tools.some((tool) => tools.includes(tool))) continue;
      findings.push({ id: 'tool-missing', severity: 'warning', member: index, field: 'tools', tools: [...entry.tools], message: `${label}: its instructions ask it to ${entry.label}, but its tools cannot (it needs ${entry.tools.join(' or ')}). Reword the instructions, or give it the tool.` });
    }
    if (NO_EDIT.test(member.instructions)) {
      const writers = WRITE_TOOLS.filter((tool) => tools.includes(tool));
      if (writers.length) findings.push({ id: 'tool-unneeded-write', severity: 'warning', member: index, field: 'tools', tools: writers, message: `${label}: its instructions say not to edit files, but it has ${writers.join(' and ')}${member.tools ? '' : ' (from the default tools)'}. Taking ${writers.length === 1 ? 'it' : 'them'} away makes the rule hold.` });
    }
    // A member made from an Open-GSD role works as that library agent, whose own definition says what it returns, so it is not asked for one here.
    if (member.instructions.trim() && !/^gsd-/.test(member.role.trim()) && !DELIVERABLE.test(member.instructions)) findings.push({ id: 'no-deliverable', severity: 'warning', member: index, field: 'instructions', message: `${label}: its instructions do not say what it hands back. End them with what to report or produce, and in what form (for example "Report the findings with file:line, most severe first").` });
    const role = member.role.trim().toLowerCase();
    if (!role) findings.push({ id: 'no-role', severity: 'advice', member: index, field: 'role', message: `${label}: it has no role. A role tells the lead what to give it.` });
    else if (GENERIC_ROLES.has(role)) findings.push({ id: 'generic-role', severity: 'warning', member: index, field: 'role', message: `${label}: "${member.role.trim()}" is too general for the lead to know what to give it. Name the job (researcher, reviewer, writer).` });
    const reportsTo = member.reportsTo?.trim();
    if (reportsTo && !names.has(reportsTo)) findings.push({ id: 'reports-to-missing', severity: 'warning', member: index, field: 'name', message: `${label}: it reports to ${reportsTo}, who is not on the team.` });
    const count = words(member.instructions).length;
    if (count > MAX_INSTRUCTION_WORDS) findings.push({ id: 'too-long', severity: 'warning', member: index, field: 'instructions', message: `${label}: its instructions are about ${count} words. Long instructions are followed less reliably: keep what this member must do, and split the rest into another member.` });
  });
  const cycle = reportsToCycles(draft.members);
  if (cycle.length) findings.push({ id: 'reports-to-cycle', severity: 'warning', member: draft.members.findIndex((member) => member.name === cycle[0]), field: 'name', message: `${cycle.join(', ')} report to each other in a circle, so none of them leads. Make one of them report to no one.` });
  for (let one = 0; one < draft.members.length; one += 1) {
    for (let two = one + 1; two < draft.members.length; two += 1) {
      const a = draft.members[one]; const b = draft.members[two];
      // The same role alone is often deliberate (a code reviewer and a security reviewer), so it counts only when the instructions overlap too.
      const close = similarity(a.instructions, b.instructions);
      const sameRole = Boolean(a.role.trim()) && a.role.trim().toLowerCase() === b.role.trim().toLowerCase() && close >= 0.3;
      if (sameRole || close >= 0.6) {
        findings.push({ id: 'overlap', severity: 'warning', member: two, field: 'instructions', message: `${a.name || `Member ${one + 1}`} and ${b.name || `Member ${two + 1}`} ${sameRole ? `have the same role (${a.role.trim()})` : 'have mostly the same instructions'}, so they may do the same work. If that is deliberate (two independent reviewers), say in each one's instructions how their work differs.` });
      }
    }
  }
  const hierarchy = draft.members.some((member) => member.reportsTo?.trim());
  if (draft.members.length > 3 && !hierarchy && !draft.members.some((member) => LEAD_ROLES.test(member.role) || LEAD_ROLES.test(member.name))) {
    findings.push({ id: 'no-lead', severity: 'advice', field: 'members', message: `This team has ${draft.members.length} members and no one who plans or coordinates. The run's lead agent does that by default; if the work needs a dedicated planner or a reports-to line, add one.` });
  }
  return findings;
}

/** The findings that show while editing, as the studio's warnings (advice stays in the Improve panel). */
export function checkWarnings(findings: readonly TeamFinding[]): DraftIssue[] {
  return findings.filter((finding) => finding.severity !== 'advice').map((finding) => ({ message: finding.message, ...(finding.member !== undefined && finding.member >= 0 ? { member: finding.member } : {}), ...(finding.field ? { field: finding.field } : {}) }));
}

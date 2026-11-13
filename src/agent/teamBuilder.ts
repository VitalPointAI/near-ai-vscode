// The AI team builder (owner, 2026-11-08): the person says what the team is for in their own words, and the AI drafts the team: a name, a mission and
// description, the members with a name each and a role, what each produces, and the final outputs and their formats.
//
// The prompt and the parsing are here, pure, so the shape is testable without a model and a bad answer is repaired rather than crashed on. The drafting
// itself is one model call from the studio; the test-and-set-models step that follows it is the same role suite a saved team goes through.
import { CUSTOM_PLAGIARISM_CHECKER, hasIntegrityMember, PLAGIARISM_CHECKER, teamDoesResearch } from './researchIntegrity';
import type { TeamDraft } from './teamMarkdown';

/** The proposal the AI drafts, before it becomes a team file. */
export interface TeamProposal {
  name: string;
  mission: string;
  description: string;
  /** `tools`: set only for a member the builder adds itself (the plagiarism checker); the AI's own members get the default tools. */
  members: Array<{ name: string; role: string; model: string; produces: string; instructions: string; tools?: string[] }>;
  /** What the team delivers, and in what form. */
  outputs: Array<{ name: string; format: string; from: string }>;
  /** What the builder added on its own, and why, so the person sees it before accepting. */
  notes?: string[];
}

/** What the person told us, which is all the AI starts from. */
export interface TeamBrief {
  idea: string;
  /** Optional answers to the follow-ups, when the person gave them. */
  outputFormat?: string;
  depth?: 'quick' | 'thorough';
  deadline?: string;
}

export const TEAM_BUILDER_PROMPT = `You design teams of AI agents. Given what a person wants a team to be able to produce, you propose the team, and you reply with ONE JSON object and nothing else.

Shape of the reply:
{
  "name": "A short name, 2 to 4 words, in title case",
  "mission": "One sentence: what this team exists to produce.",
  "description": "Two or three sentences: what the team does, for whom, and how it works.",
  "members": [
    { "name": "short-lowercase-name", "role": "the role, e.g. researcher, analyst, writer, planner, reviewer", "model": "standard", "produces": "What this member hands back, in one phrase.", "instructions": "What this member does, in two or three sentences, written to that member." }
  ],
  "outputs": [ { "name": "The deliverable", "format": "Its form, e.g. Markdown brief with citations, spreadsheet, slide deck", "from": "which member or members produce it" } ]
}

Rules:
- Give every member its OWN short name (research-lead, market-analyst, fact-checker), not just its role repeated. Names are lowercase letters, digits and dashes, up to 40 characters, and no two are the same.
- Choose the roles the work actually needs, between 3 and 6 members. Do not pad the team, and do not leave out a step the output needs.
- For each member's model, write one of: "deep" for the hardest reasoning, "standard" for most work, "fast" for quick, well-defined tasks. These are tiers; the studio replaces them with a measured model when it can.
- "produces" must be concrete: what the next member or the person receives.
- Every member must be able to work INDEPENDENTLY of the others wherever the work allows it: the lead starts all the parts that do not depend on each other at the same time. Design the team so that most members can run concurrently, and where a member must wait for another, say so in its instructions.
- "outputs" is what the PERSON gets at the end, with its format. Be specific: "Markdown brief with a citation per claim", not "a report".
- Write in plain English. No em dashes and no en dashes. British or American spelling is fine, but be consistent.`;

/** The user turn: the person's idea, and whatever they added when asked. */
export function builderPrompt(brief: TeamBrief): string {
  const parts = [`What the team should be able to produce:\n${brief.idea.trim()}`];
  if (brief.outputFormat?.trim()) parts.push(`The output format they want:\n${brief.outputFormat.trim()}`);
  if (brief.deadline?.trim()) parts.push(`How much time they have:\n${brief.deadline.trim()}`);
  parts.push(`How deep the work should go: ${brief.depth === 'quick' ? 'quick, a first useful answer' : 'thorough, with sources checked'}.`);
  return parts.join('\n\n');
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TIERS = new Set(['deep', 'standard', 'fast']);

/**
 * Reads the model's reply. A reply that is JSON inside a code fence, or with text around it, is still read, because a model that adds a sentence of
 * preamble should not cost the person their proposal. Anything missing is filled sensibly rather than rejected: a proposal with a nameless member is worth
 * showing and fixing, which is the point of a draft.
 */
export function parseProposal(text: string, brief: TeamBrief): { proposal: TeamProposal; problems: string[] } {
  const problems: string[] = [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let raw: Record<string, unknown> = {};
  if (start >= 0 && end > start) {
    try { raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { problems.push('The reply was not valid JSON, so the proposal was rebuilt from what could be read.'); }
  } else problems.push('The reply held no JSON, so the proposal was rebuilt from the brief.');

  const text_ = (value: unknown, fallback: string, limit = 600): string => (typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback);
  const name = text_(raw.name, 'New team', 80).replace(/[\r\n]+/g, ' ');
  const mission = text_(raw.mission, brief.idea.trim().split(/[.!?]/)[0] || 'Produce what the person asked for.');
  const description = text_(raw.description, `A team that produces: ${brief.idea.trim()}`.slice(0, 400), 400).replace(/[\r\n]+/g, ' ');

  const seen = new Set<string>();
  const members: TeamProposal['members'] = [];
  const list = Array.isArray(raw.members) ? raw.members : [];
  for (const [index, entry] of list.slice(0, 12).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const member = entry as Record<string, unknown>;
    const role = text_(member.role, 'specialist', 60).replace(/[\r\n,]+/g, ' ');
    // A name that cannot be used is replaced, not dropped: the member is more valuable than its name. The replacement is UNIQUE, because a fallback that
    // collides with a member already named `member-2` produces a team the studio's own checks then reject (0.4.19 review).
    let memberName = text_(member.name, '', 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!SLUG.test(memberName) || seen.has(memberName)) {
      const stem = SLUG.test(memberName) ? memberName.replace(/-\d+$/, '') : 'member';
      // The suffix is where the uniqueness lives, so the STEM is truncated to make room for it. `(stem + suffix).slice(0, 40)` produced the same 40
      // characters for every suffix, so the loop below could never terminate and would hang the extension host (0.4.19 review).
      const withSuffix = (n: number): string => {
        const suffix = `-${n}`;
        return `${stem.slice(0, Math.max(1, 40 - suffix.length))}${suffix}`;
      };
      let candidate = withSuffix(index + 1);
      // Bounded as well as correct: a colliding team cannot spin forever even if the suffix space ran out.
      for (let n = index + 2; seen.has(candidate) && n <= index + 400; n += 1) candidate = withSuffix(n);
      memberName = candidate;
      problems.push(`Member ${index + 1} needed a usable name; it is now "${memberName}".`);
    }
    seen.add(memberName);
    const model = text_(member.model, 'standard', 20).toLowerCase();
    if (!TIERS.has(model)) problems.push(`Member "${memberName}" asked for model "${model}", which is not a tier; it uses standard.`);
    members.push({
      name: memberName, role, model: TIERS.has(model) ? model : 'standard',
      produces: text_(member.produces, 'its part of the work', 200),
      instructions: text_(member.instructions, `${role} on this team. Produce: ${text_(member.produces, 'your part of the work', 200)}`, 1200)
    });
  }
  if (!members.length) {
    problems.push('The reply named no members, so a starting team was drafted from the brief.');
    members.push(
      { name: 'lead', role: 'lead', model: 'deep', produces: 'the finished work, checked', instructions: 'Break the work into the parts the output needs, hand them to the team, check what comes back, and assemble the final deliverable.' },
      { name: 'researcher', role: 'researcher', model: 'standard', produces: 'verifiable findings with sources', instructions: 'Find and read primary sources. Record every finding with its source and what exactly supports it.' },
      { name: 'writer', role: 'writer', model: 'standard', produces: 'the draft in the requested format', instructions: 'Write the deliverable from the findings, in the format the person asked for, adding no fact that is not in the research.' }
    );
  }

  const outputs: TeamProposal['outputs'] = (Array.isArray(raw.outputs) ? raw.outputs : []).slice(0, 8).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const output = entry as Record<string, unknown>;
    const label = text_(output.name, '', 120);
    if (!label) return [];
    return [{ name: label, format: text_(output.format, brief.outputFormat || 'Markdown', 120), from: text_(output.from, members[members.length - 1]?.name ?? 'the team', 120) }];
  });
  if (!outputs.length) outputs.push({ name: 'The deliverable', format: brief.outputFormat || 'Markdown', from: members[members.length - 1]?.name ?? 'the team' });

  return { proposal: withPermanentMembers({ name, mission, description, members, outputs }), problems };
}

/**
 * Every team that does research gets the plagiarism checker (owner decision, 2026-11-13), placed after the last writer so it checks the draft
 * before review, unless a member already does that job. Nothing else is added, so a software or data team is left as the AI drafted it.
 */
export function withPermanentMembers(proposal: TeamProposal): TeamProposal {
  if (!teamDoesResearch(proposal.members) || hasIntegrityMember(proposal.members) || proposal.members.some((member) => member.name === PLAGIARISM_CHECKER)) return proposal;
  const members = [...proposal.members];
  const writers = members.map((member, index) => (/writ|author|draft/i.test(`${member.name} ${member.role}`) ? index : -1)).filter((index) => index >= 0);
  members.splice(writers.length ? writers[writers.length - 1] + 1 : members.length, 0, { ...CUSTOM_PLAGIARISM_CHECKER, tools: [...CUSTOM_PLAGIARISM_CHECKER.tools] });
  return { ...proposal, members, notes: [...(proposal.notes ?? []), `Added ${PLAGIARISM_CHECKER}: every team that does research has one, to check that nothing is plagiarized and every source is cited in Chicago 18 style.`] };
}

/** The proposal as the studio's draft, so the existing editor, checks and save work on it unchanged. */
export function proposalDraft(proposal: TeamProposal): TeamDraft {
  return {
    name: proposal.name,
    description: `${proposal.mission} ${proposal.description}`.trim().slice(0, 400),
    members: proposal.members.map((member) => ({
      name: member.name, role: member.role, model: member.model, tools: member.tools ? [...member.tools] : null,
      instructions: `${member.instructions}\n\nProduces: ${member.produces}`
    }))
  };
}

/** The proposal as the person reads it, before they accept it. */
export function proposalText(proposal: TeamProposal): string {
  const lines = [`${proposal.name}`, proposal.mission, '', proposal.description, '', 'Members:'];
  for (const member of proposal.members) lines.push(`- ${member.name} (${member.role}, ${member.model}): ${member.produces}`);
  for (const note of proposal.notes ?? []) lines.push(`(${note})`);
  lines.push('', 'You get:');
  for (const output of proposal.outputs) lines.push(`- ${output.name}: ${output.format} (from ${output.from})`);
  return lines.join('\n');
}

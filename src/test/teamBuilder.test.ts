// The AI team builder's shape (owner, 2026-11-08): what the person types, what the AI drafts, and what survives a bad reply. The parsing is tested
// against real mess: JSON in a code fence, a missing name, a duplicate name, a model that is not a tier, and a reply with no members at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import { builderPrompt, TEAM_BUILDER_PROMPT, parseProposal, proposalDraft, proposalText, withPermanentMembers, type TeamBrief, type TeamProposal } from '../agent/teamBuilder';
import { teamDoesResearch } from '../agent/researchIntegrity';
import { kindForRoleName } from '../benchmark/roleTasks';
import { checkDraft } from '../agent/teamMarkdown';

const brief: TeamBrief = { idea: 'I need a team that researches a market and writes a short brief with sources.', outputFormat: 'Markdown brief with citations', depth: 'thorough' };

const good = {
  name: 'Market Scouts',
  mission: 'Produce a sourced market brief the person can act on.',
  description: 'Researches a named market from primary sources, checks the numbers against each other, and writes a brief with a citation for every claim.',
  members: [
    { name: 'research-lead', role: 'researcher', model: 'deep', produces: 'verifiable findings with sources', instructions: 'Find and read primary sources.' },
    { name: 'analyst', role: 'analyst', model: 'standard', produces: 'a ranked picture of the market', instructions: 'Weigh the findings and state confidence.' },
    { name: 'facts', role: 'editor', model: 'fast', produces: 'a brief with every claim checked', instructions: 'Check each claim against its source.' }
  ],
  outputs: [{ name: 'Market brief', format: 'Markdown with a citation per claim', from: 'facts' }]
};

test('a good reply becomes a proposal with its names, roles, models, what each produces, and the final outputs', () => {
  const { proposal, problems } = parseProposal(JSON.stringify(good), brief);
  assert.deepEqual(problems, []);
  assert.equal(proposal.name, 'Market Scouts');
  // A research team always gains the plagiarism checker (owner decision, 2026-11-13); with no writer, it goes last.
  assert.equal(proposal.members.length, 4);
  assert.deepEqual(proposal.members.map((member) => member.name), ['research-lead', 'analyst', 'facts', 'plagiarism-checker']);
  assert.deepEqual(proposal.members.map((member) => member.model), ['deep', 'standard', 'fast', 'deep']);
  assert.equal(proposal.members[0]?.produces, 'verifiable findings with sources');
  assert.equal(proposal.outputs[0]?.format, 'Markdown with a citation per claim');
  // What the person reads names the members and the deliverable, so the proposal can be judged before accepting it.
  const text = proposalText(proposal);
  assert.match(text, /research-lead \(researcher, deep\): verifiable findings with sources/);
  assert.match(text, /You get:[\s\S]*Market brief: Markdown with a citation per claim/);
});

test('JSON inside a code fence, with a sentence around it, is still read', () => {
  const fenced = `Here is the team you asked for:\n\`\`\`json\n${JSON.stringify(good, null, 2)}\n\`\`\`\nAsk me to change anything.`;
  const { proposal, problems } = parseProposal(fenced, brief);
  assert.deepEqual(problems, []);
  assert.equal(proposal.members.length, 4);
});

test('a name that cannot be used is replaced and said, and a duplicate name is made unique, rather than losing the member', () => {
  const messy = structuredClone(good);
  (messy.members[0] as { name: string }).name = 'Research Lead!';
  (messy.members[1] as { name: string }).name = 'Research Lead!';
  const { proposal, problems } = parseProposal(JSON.stringify(messy), brief);
  assert.equal(proposal.members.length, 4, 'no member is dropped over its name (and the research team gains its plagiarism checker)');
  const names = proposal.members.map((member) => member.name);
  assert.equal(new Set(names).size, 4, 'every member has its own name');
  for (const name of names) assert.match(name, /^[a-z0-9][a-z0-9-]{0,39}$/);
  assert.ok(problems.some((problem) => /needed a usable name/.test(problem)));
});

test('a model that is not a tier falls back to standard and is reported, rather than becoming a broken team', () => {
  const wrong = structuredClone(good);
  (wrong.members[1] as { model: string }).model = 'gpt-9-turbo';
  const { proposal, problems } = parseProposal(JSON.stringify(wrong), brief);
  assert.equal(proposal.members[1]?.model, 'standard');
  assert.ok(problems.some((problem) => /gpt-9-turbo/.test(problem)));
});

test('a reply with no members at all is a starting team rather than an empty one, and it says so', () => {
  const { proposal, problems } = parseProposal('I could not decide.', brief);
  assert.ok(proposal.members.length >= 3);
  assert.ok(problems.length >= 1);
  assert.equal(proposal.outputs.length, 1, 'there is always something the person receives');
});

test('the proposal becomes a draft the existing editor accepts, with the outputs in the instructions', () => {
  const { proposal } = parseProposal(JSON.stringify(good), brief);
  const draft = proposalDraft(proposal);
  assert.equal(draft.name, 'Market Scouts');
  assert.match(draft.description, /Researches a named market/, 'the mission and description both reach the editor');
  // The studio's own checks accept it, which is the real test of the shape.
  const checked = checkDraft(draft);
  assert.deepEqual(checked.errors, []);
  assert.match(draft.members[0]?.instructions ?? '', /Find and read primary sources\.[\s\S]*Produces: verifiable findings with sources/);
});

test('the prompt tells the model to name every member, to choose real roles, and to keep to plain text', () => {
  const prompt = builderPrompt(brief);
  assert.match(prompt, /output format they want:\nMarkdown brief with citations/i);
  assert.match(prompt, /thorough, with sources checked/);
  // The rules about names and roles are in the system prompt; the user turn carries what the person said.
  assert.match(TEAM_BUILDER_PROMPT, /Give every member its OWN short name/);
  assert.match(TEAM_BUILDER_PROMPT, /between 3 and 6 members/);
  assert.match(TEAM_BUILDER_PROMPT, /ONE JSON object and nothing else/);
  assert.doesNotMatch(TEAM_BUILDER_PROMPT, /[\u2013\u2014]/, 'no em or en dashes in what we send');
  assert.doesNotMatch(prompt, /[\u2013\u2014]/);
});

test('a 40-character name still gets unique suffixed names, so the fallback cannot loop forever', () => {
  // The review's blocker: `(stem + suffix).slice(0, 40)` is the stem for every suffix, so the loop never terminated and hung the extension host.
  const long = 'a'.repeat(40);
  const { proposal } = parseProposal(JSON.stringify({ name: 'T', members: [{ name: long }, { name: long }, { name: long }] }), brief);
  const names = proposal.members.map((member) => member.name);
  assert.equal(names.length, 3, 'every member is kept');
  assert.equal(new Set(names).size, 3, 'and each has its own name');
  for (const name of names) assert.ok(name.length <= 40, `${name.length} characters is too long`);
  // The suffix survives, which is what makes them unique.
  assert.match(names[1] as string, /-2$/);
  assert.match(names[2] as string, /-3$/);
});

test('a team that does research always gets the plagiarism checker, after its writer, with its tools; a software team does not', () => {
  const researchTeam = { ...good, members: [
    { name: 'scout', role: 'investigator', model: 'deep', produces: 'findings', instructions: 'Find sources.' },
    { name: 'drafter', role: 'writer', model: 'standard', produces: 'the draft', instructions: 'Write it.' },
    { name: 'final-check', role: 'editor', model: 'deep', produces: 'the signed-off brief', instructions: 'Edit it.' }
  ] };
  const { proposal, problems } = parseProposal(JSON.stringify(researchTeam), brief);
  assert.deepEqual(problems, [], 'adding it is not a repair');
  assert.deepEqual(proposal.members.map((member) => member.name), ['scout', 'drafter', 'plagiarism-checker', 'final-check'], 'it checks the draft before the editor');
  const checker = proposal.members[2]!;
  assert.equal(checker.role, 'reviewer');
  assert.equal(checker.model, 'deep');
  assert.match(checker.instructions, /Chicago Manual of Style, 18th edition, notes and bibliography[\s\S]*CheckOriginality[\s\S]*WebSearch distinctive sentences[\s\S]*Close paraphrase counts as plagiarism even when cited[\s\S]*Never edit the draft[\s\S]*exactly CLEAN or NOT CLEAN/);
  assert.match(proposalText(proposal), /plagiarism-checker \(reviewer, deep\)[\s\S]*\(Added plagiarism-checker: every team that does research has one/);
  const draft = proposalDraft(proposal);
  assert.deepEqual(draft.members[2]?.tools, ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember', 'WebSearch', 'WebFetch', 'CheckCitations', 'CheckOriginality', 'Write']);
  assert.equal(draft.members[0]?.tools, null, 'the AI\'s own members keep the default tools');
  assert.deepEqual(checkDraft(draft).errors, []);

  const software = { ...good, name: 'Ship It', members: [
    { name: 'architect', role: 'planner', model: 'deep', produces: 'a plan', instructions: 'Plan it.' },
    { name: 'builder', role: 'implementer', model: 'deep', produces: 'the change', instructions: 'Build it.' },
    { name: 'checker', role: 'reviewer', model: 'standard', produces: 'findings', instructions: 'Review it.' }
  ] };
  const plain = parseProposal(JSON.stringify(software), brief).proposal;
  assert.deepEqual(plain.members.map((member) => member.name), ['architect', 'builder', 'checker']);
  assert.equal(plain.notes, undefined);
  // A team that already has a member doing the job is not given a second one, and adding twice changes nothing.
  const own = parseProposal(JSON.stringify({ ...researchTeam, members: [...researchTeam.members, { name: 'originality', role: 'reviewer', model: 'deep', produces: 'x', instructions: 'Check originality.' }] }), brief).proposal;
  assert.ok(!own.members.some((member) => member.name === 'plagiarism-checker'));
  assert.deepEqual(withPermanentMembers(proposal), proposal);
});

test('one heuristic decides what counts as research, for Team Builder and the role benchmark alike', () => {
  assert.equal(teamDoesResearch([{ name: 'a', role: 'researcher' }]), true);
  assert.equal(teamDoesResearch([{ name: 'source-verifier' }]), true);
  assert.equal(teamDoesResearch([{ name: 'fact-checker', role: 'reviewer' }]), true);
  assert.equal(teamDoesResearch([{ name: 'writer', role: 'writer' }, { name: 'editor', role: 'editor' }]), false, 'writing alone is not research');
  assert.equal(teamDoesResearch([{ name: 'dev', role: 'implementer' }]), false);
  for (const role of ['researcher', 'investigator', 'source-checker', 'plagiarism-checker']) assert.equal(kindForRoleName(role), 'research', role);
  const empty: TeamProposal = { name: 'T', mission: 'm', description: 'd', members: [], outputs: [] };
  assert.deepEqual(withPermanentMembers(empty), empty);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { projectType, projectTypeTeam, RESEARCH_WORKFLOW } from '../agent/projectTypes';
import { parseTeam, teamAgents } from '../agent/teams';

// The research team's roles: each has an input, a job, an output file, and a definition of done;
// the editor is the release gate; and the team runs on private models by default.

const research = projectType('research')!;
const member = (name: string) => research.members.find((entry) => entry.name === name)!;

const OUTPUTS: Record<string, RegExp> = {
  investigator: /Output: \.planning\/research\/TEAM-FINDINGS\.md/,
  'source-verifier': /Output: \.planning\/research\/SOURCE-CHECK\.md/,
  analyst: /Output: \.planning\/research\/TEAM-ANALYSIS\.md/,
  writer: /Output: the report in Markdown[\s\S]*REPORT\.md[\s\S]*CreateDocument[\s\S]*CreatePdf/,
  'red-team': /Output: RED-TEAM\.md in the phase folder/,
  editor: /Output: \.planning\/EDITORIAL-REVIEW\.md/
};

test('every research member has an input, a job, its output file, and a definition of done, and reads STYLE.md and the owner decisions first', () => {
  assert.deepEqual(research.members.map((entry) => entry.name), RESEARCH_WORKFLOW.split(' → '), 'members are listed in workflow order');
  assert.equal(RESEARCH_WORKFLOW, 'investigator → source-verifier → analyst → writer → red-team → editor');
  for (const entry of research.members) {
    assert.match(entry.instructions, /^First read \.planning\/STYLE\.md[\s\S]*Owner decisions are binding/, `${entry.name} reads the style and decisions first`);
    assert.match(entry.instructions, /\n\nInput: /, `${entry.name} has an input`);
    assert.match(entry.instructions, /\n\nJob: /, `${entry.name} has a job`);
    assert.match(entry.instructions, OUTPUTS[entry.name], `${entry.name} names its output file`);
    assert.match(entry.instructions, /\n\nDone when: \S/, `${entry.name} has a definition of done`);
  }
});

test('the research roles encode the lessons: sources, derived values, independence, ways forward, and the deliverable', () => {
  assert.match(member('investigator').instructions, /open-questions list[\s\S]*new, confirms, or contradicts[\s\S]*analogous cases[\s\S]*earliest date it can be met/);
  assert.match(member('source-verifier').instructions, /independent method[\s\S]*Two reads by the same tool are not independent[\s\S]*actually contains the claim[\s\S]*client or vendor statement[\s\S]*Never call a claim corroborated[\s\S]*access date[\s\S]*currency window/);
  assert.match(member('analyst').instructions, /Compute every derived figure[\s\S]*sort key[\s\S]*dependencies of each derived value[\s\S]*update every value built on it/);
  assert.match(member('writer').instructions, /Never put internal file paths, plan or task IDs, workstream labels, or working codes in reader-facing text[\s\S]*audit annex[\s\S]*illustrative[\s\S]*earliest date it can be met/);
  assert.match(member('red-team').instructions, /attack the deliverable as its reader would[\s\S]*do not recompute[\s\S]*superseded[\s\S]*mutations[\s\S]*Do not fix anything yourself/);
});

test('the editor is the release gate: audience, coherence (blocking), quality, verified notes, real notes in the file, and a SIGN-OFF or NOT READY line', () => {
  const editor = member('editor');
  assert.equal(editor.model, 'deep');
  assert.equal(editor.privacy, 'private');
  for (const tool of ['Write', 'Edit', 'CheckCitations', 'CreateDocument', 'CreatePdf']) assert.ok(editor.tools!.includes(tool), `the editor has ${tool}`);
  const text = editor.instructions;
  assert.match(text, /final quality gate; nothing is released until you sign it off/);
  assert.match(text, /1\. Audience and purpose\.[\s\S]*If neither states them, stop and ask for them; do not guess\./);
  assert.match(text, /2\. Coherence and comprehension \(blocking: a failure here alone means NOT READY\)\. The document reads as one argument[\s\S]*opening states the answer[\s\S]*conclusion follows from the evidence with no new claims[\s\S]*defined at first use[\s\S]*no section, table, figure, or summary contradicts another[\s\S]*without the authors' context: no unexplained jargon, internal codes, file paths, or workstream labels[\s\S]*headings say what each section concludes[\s\S]*cold read as the stated audience would/);
  assert.match(text, /3\. Professional quality[\s\S]*answer comes first[\s\S]*hedging or as marketing/);
  assert.match(text, /4\. Sources\.[\s\S]*actually contains the claim[\s\S]*No note may point to a source the source-verifier did not check\. Rerun CheckCitations yourself/);
  assert.match(text, /5\. Notes in the delivered file\.[\s\S]*real endnotes or footnotes[\s\S]*A bare URL dropped into the body text does not count as a note/);
  assert.match(text, /Authority: you make copy edits directly[\s\S]*You never add, remove, or alter a factual claim or a source\. A factual problem goes back as a numbered required change/);
  assert.match(text, /a final line that is exactly SIGN-OFF or NOT READY/);
  assert.match(research.guidance, /\*\*Audit:\*\*[^\n]*coherence and comprehension \(blocking\)[^\n]*EDITORIAL-REVIEW\.md/);
  assert.match(research.guidance, /\*\*Release:\*\* only after the editor's SIGN-OFF/);
  assert.match(research.guidance, /\*\*Workflow:\*\* investigator → source-verifier → analyst → writer → red-team → editor\.[^\n]*NOT READY goes back to the writer/);
  assert.match(research.guidance, /\*\*Plan:\*\* create \.planning\/STYLE\.md first[^\n]*ask rather than guess/);
  for (const [type, name] of [['presales', 'reviewer'], ['writing', 'editor']] as const) {
    const gate = projectType(type)!.members.find((entry) => entry.name === name)!;
    assert.match(gate.instructions, /final quality gate[\s\S]*[Cc]oherence and comprehension[\s\S]*cold read[\s\S]*EDITORIAL-REVIEW\.md[\s\S]*exactly SIGN-OFF or NOT READY/, `${type} ${name}`);
    assert.match(projectType(type)!.guidance, /SIGN-OFF/);
  }
});

test('the research team runs on private, capable models, and the team file says so', () => {
  for (const name of ['source-verifier', 'analyst', 'red-team', 'editor']) assert.equal(member(name).model, 'deep', `${name} uses the deep tier`);
  assert.ok(research.members.every((entry) => entry.privacy === 'private'), 'every research member is private by default');
  const team = parseTeam(projectTypeTeam(research, 'Assess the market', 'cloud'), '/p/.planning/.near-ai/team.md');
  assert.ok(team.members.every((entry) => entry.privacy === 'private'));
  assert.ok(teamAgents(team).every((agent) => agent.privacy === 'private'), 'the privacy reaches each sub-agent');
  assert.match(projectTypeTeam(research, 'g', 'cloud'), /## editor\nrole: reviewer\nmodel: deep\ntools: [^\n]+\nprivacy: private\n\n/);
  assert.match(research.guidance, /privacy: any/, 'the guidance says how to opt out');
});

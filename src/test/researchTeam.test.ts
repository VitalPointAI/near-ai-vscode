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
  'plagiarism-checker': /Output: \.planning\/research\/INTEGRITY-CHECK\.md/,
  'red-team': /Output: RED-TEAM\.md in the phase folder/,
  editor: /Output: \.planning\/EDITORIAL-REVIEW\.md/
};

test('every research member has an input, a job, its output file, and a definition of done, and reads STYLE.md and the owner decisions first', () => {
  assert.deepEqual(research.members.map((entry) => entry.name), RESEARCH_WORKFLOW.split(' → '), 'members are listed in workflow order');
  assert.equal(RESEARCH_WORKFLOW, 'investigator → source-verifier → analyst → writer → plagiarism-checker → red-team → editor');
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
  assert.match(text, /5\. Notes in the delivered file\.[\s\S]*real footnotes or endnotes[\s\S]*A bare URL dropped into the body text does not count as a note/);
  assert.match(text, /Authority: you make copy edits directly[\s\S]*You never add, remove, or alter a factual claim or a source\. A factual problem goes back as a numbered required change/);
  assert.match(text, /a final line that is exactly SIGN-OFF or NOT READY/);
  assert.match(research.guidance, /\*\*Audit:\*\*[^\n]*coherence and comprehension \(blocking\)[^\n]*EDITORIAL-REVIEW\.md/);
  assert.match(research.guidance, /\*\*Release:\*\* only after the editor's SIGN-OFF/);
  assert.match(research.guidance, /\*\*Workflow:\*\* investigator → source-verifier → analyst → writer → plagiarism-checker → red-team → editor\.[^\n]*plagiarism checker is blocking[^\n]*INTEGRITY-CHECK\.md ending in CLEAN or NOT CLEAN[^\n]*NOT READY goes back to the writer/);
  assert.match(research.guidance, /\*\*Plan:\*\* create \.planning\/STYLE\.md first[^\n]*ask rather than guess/);
  assert.match(text, /4\. Sources\.[\s\S]*Chicago Manual of Style, 18th edition, notes and bibliography[\s\S]*INTEGRITY-CHECK\.md must end in CLEAN/);
  assert.match(text, /5\. Notes in the delivered file\.[\s\S]*Chicago 18 form with a bibliography/);
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

test('the plagiarism checker is a permanent, private, deep reviewer between the writer and the red team, with the tools to check originality', () => {
  const checker = member('plagiarism-checker');
  assert.deepEqual([checker.role, checker.model, checker.privacy, checker.permanent], ['reviewer', 'deep', 'private', true]);
  for (const tool of ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'CheckCitations', 'CheckOriginality', 'Write']) assert.ok(checker.tools!.includes(tool), `it has ${tool}`);
  assert.ok(!checker.tools!.includes('Edit'), 'it never edits the report');
  const names = research.members.map((entry) => entry.name);
  assert.equal(names.indexOf('plagiarism-checker'), names.indexOf('writer') + 1);
  assert.ok(names.indexOf('plagiarism-checker') < names.indexOf('red-team') && names.indexOf('red-team') < names.indexOf('editor'));
  assert.deepEqual(research.members.filter((entry) => entry.permanent).map((entry) => entry.name), ['plagiarism-checker'], 'the only permanent member');
  // Not part of the writing team (owner decision).
  assert.ok(!projectType('writing')!.members.some((entry) => entry.name === 'plagiarism-checker'));
  // A local-only project has no fetched pages to compare against, so the web tools and CheckOriginality are left out.
  assert.doesNotMatch(projectTypeTeam(research, 'g', 'local'), /\ntools: [^\n]*CheckOriginality/);
});

test('the mandate of the plagiarism checker: originality, Chicago 18 notes, every note verified, and a CLEAN or NOT CLEAN verdict without editing the report', () => {
  const text = member('plagiarism-checker').instructions;
  assert.match(text, /Input: [^\n]*draft[^\n]*SOURCE-CHECK\.md[^\n]*STYLE\.md, which is the Chicago Manual of Style, 18th edition, notes and bibliography unless a recorded owner decision/);
  assert.match(text, /Check every note and every section; never a sample\./);
  assert.match(text, /fetch with WebFetch every source in SOURCE-CHECK\.md that the draft relies on, then run CheckOriginality[\s\S]*WebSearch a sample of distinctive sentences from every section/);
  assert.match(text, /quoted with a note \(in quotation marks, or as a block quotation[^)]*\) or rewritten in the writer's own words and cited/);
  assert.match(text, /Close paraphrase and patchwriting[^.]*are plagiarism even when cited/);
  assert.match(text, /Ideas, data, figures, tables, and images taken from a source need a note even when reworded/);
  assert.match(text, /earlier deliverables is disclosed/);
  assert.match(text, /full note; later ones are shortened notes[\s\S]*prefers shortened notes to "ibid\."[\s\S]*bibliography lists every source the notes cite/);
  assert.match(text, /journal article[^)]*DOI written as https:\/\/doi\.org\/… in preference to a URL/);
  assert.match(text, /access date is given only for a source with no date of publication or revision/);
  assert.match(text, /real notes, not bare URLs[\s\S]*grades and finding ids belong in the audit annex/);
  assert.match(text, /you never edit the report, and you never add or change a claim or a source\. A note you cannot verify is a required change, never a pass\./);
  assert.match(text, /to the writer for quoting[\s\S]*to the investigator when a source is missing, wrong/);
  assert.match(text, /a table of originality findings \(passage, source, kind: verbatim, close paraphrase, misquote, uncited idea, or unattributed source found by search, and the required fix\); a table of note findings \(note id, problem, the Chicago 18 rule, and the fix\)[\s\S]*final line that is exactly CLEAN or NOT CLEAN/);
});

test('the editor cannot sign off past a NOT CLEAN, missing, or stale integrity check, and the writer and red team work with it', () => {
  const editor = member('editor').instructions;
  assert.match(editor, /Input: [^\n]*\.planning\/research\/INTEGRITY-CHECK\.md/);
  assert.match(editor, /You cannot SIGN-OFF while it ends in NOT CLEAN, is missing, or checked an earlier draft than this one \(it is stale\)/);
  assert.match(editor, /Done when: EDITORIAL-REVIEW\.md ends in SIGN-OFF \([^)]*INTEGRITY-CHECK\.md ends in CLEAN for this draft/);
  assert.match(member('red-team').instructions, /Input: [^\n]*INTEGRITY-CHECK\.md/);
  const writer = member('writer').instructions;
  assert.match(writer, /Input: [^\n]*plagiarism checker \(\.planning\/research\/INTEGRITY-CHECK\.md\)/);
  assert.match(writer, /Chicago Manual of Style, 18th edition, notes and bibliography form[\s\S]*full note the first time[\s\S]*shortened note[\s\S]*bibliography of every source/);
  assert.match(writer, /audit annex at the end[^.]*reliability and credibility grades|reliability and credibility grades\) goes in an audit annex/);
  assert.doesNotMatch(writer, /page date, access date, and grades/, 'grades are no longer in reader-facing notes');
  assert.match(writer, /gone to the plagiarism checker, then the red team, then the editor/);
  assert.match(research.guidance, /\*\*Plan:\*\* [^\n]*citation format \(by default the Chicago Manual of Style, 18th edition, notes and bibliography; another style only as a recorded owner decision\), the note style \(footnotes or endnotes as appropriate: footnotes for short reports and briefs read on the page, endnotes for long reports; STYLE\.md fixes the choice\)/);
  assert.match(research.guidance, /\*\*Verify:\*\* [^\n]*not in reader-facing notes[^\n]*CheckOriginality[^\n]*INTEGRITY-CHECK\.md/);
  assert.match(research.guidance, /\*\*Audit:\*\* [^\n]*INTEGRITY-CHECK\.md ends in CLEAN for the current draft \(blocking\)/);
  assert.match(research.guidance, /\*\*Release:\*\* only after the editor's SIGN-OFF[^\n]*plagiarism checker's CLEAN[^\n]*Chicago 18 notes-bibliography form with a bibliography/);
});

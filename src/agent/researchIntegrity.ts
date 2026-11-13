// What makes a team a research team, and the plagiarism checker every research team carries (owner decision, 2026-11-13: "a new permanent
// member of every research team ... ensure nothing is plagiarized and everything is properly cited in Chicago Manual of Style 18th edition").
// One home for the heuristic, so the role benchmark, Team Builder, and anything later agree on what counts as research.

/** The citation standard every research team uses unless a recorded owner decision in STYLE.md (or the person's brief) names another. */
export const RESEARCH_CITATION_STYLE = 'the Chicago Manual of Style, 18th edition, notes and bibliography';

/** A member whose name or role says it gathers or checks sources: a team with one does research. */
export const RESEARCH_MEMBER = /research|investigat|sourc|fact-?check/i;

/** A member that already does the plagiarism checker's job, whatever it is called. */
const INTEGRITY_MEMBER = /plagiar|originality|integrity/i;

export const PLAGIARISM_CHECKER = 'plagiarism-checker';

/** Whether a team does research: one of its members gathers or checks sources. */
export function teamDoesResearch(members: Array<{ name: string; role?: string }>): boolean {
  return members.some((member) => RESEARCH_MEMBER.test(member.name) || RESEARCH_MEMBER.test(member.role ?? ''));
}

/** Whether a team already has a member doing the plagiarism checker's job. */
export function hasIntegrityMember(members: Array<{ name: string; role?: string }>): boolean {
  return members.some((member) => INTEGRITY_MEMBER.test(member.name) || INTEGRITY_MEMBER.test(member.role ?? ''));
}

/** The plagiarism checker as a custom team gets it: the research project type's mandate, without that project's file layout. */
export const CUSTOM_PLAGIARISM_CHECKER = {
  name: PLAGIARISM_CHECKER,
  role: 'reviewer',
  model: 'deep',
  tools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember', 'WebSearch', 'WebFetch', 'CheckCitations', 'CheckOriginality', 'Write'],
  produces: 'INTEGRITY-CHECK.md: originality and note findings, required changes, and a final CLEAN or NOT CLEAN',
  instructions: [
    `Make sure nothing the team delivers is plagiarized and every borrowing is properly cited in ${RESEARCH_CITATION_STYLE} (unless the person asked for another style), with footnotes or endnotes as appropriate. Check the writer's draft before it is reviewed or delivered, and check every note and every section, never a sample.`,
    'Originality: fetch every source the draft relies on with WebFetch and run CheckOriginality on the draft, then WebSearch distinctive sentences from every section to catch copying from sources not in the list. Every copied or near-copied passage must be quoted with a note or rewritten in the writer\'s own words and cited. Close paraphrase counts as plagiarism even when cited, and ideas, data, figures, and images taken from a source need a note even when reworded.',
    'Citations: every note resolves to a source that says what the sentence says (CheckCitations for quoted words, reading the page for a paraphrase); the first citation of a source is a full note and later ones shortened notes; the bibliography matches the notes; and the delivered file carries real notes, not bare URLs. A note you cannot verify is a required change, never a pass.',
    'Never edit the draft or change a claim or a source. Write INTEGRITY-CHECK.md with a table of originality findings, a table of note findings, the numbered required changes for the writer, and a final line that is exactly CLEAN or NOT CLEAN. Nothing is delivered while it ends in NOT CLEAN.'
  ].join('\n\n')
};

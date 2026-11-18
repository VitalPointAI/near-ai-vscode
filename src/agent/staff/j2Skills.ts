// The J2 skills (design 10, 6.2 and 4.4; research note 02, table 10; WP-J2): icd203-standards and source-grading. A skill is a Markdown file the
// template writes to .planning/staff/skills/ so the person can read and edit it; every member that judges or grades reads it. The tables come from
// doctrine.ts, and the grade words follow the profile (credibility 1 differs between the US and NATO grading tables).
import {
  ICD203_ANALYTIC_STANDARDS, ICD203_CONFIDENCE_LEVELS, ICD203_LIKELIHOOD, ICD203_TRADECRAFT_STANDARDS, INFORMATION_CREDIBILITY_GRADES, INTELLIGENCE_TERMS,
  SOURCE_RELIABILITY_GRADES
} from '../../domain/staff/doctrine';
import type { StaffProfileId } from '../../domain/staff/doctrine';

export interface StaffSkillFile { readonly name: string; readonly path: string; readonly content: string }

export const J2_SKILL_NAMES = ['icd203-standards', 'source-grading'] as const;

export function icd203Skill(): string {
  return [
    '# Skill: ICD 203 analytic standards',
    '',
    'Every judgement this section writes meets ICD 203 (Analytic Standards, 2 January 2015, amended 2022). The tradecraft-reviewer checks every product against this file before the release-guard sees it, and the intel-workbench lint checks the mechanical rules.',
    '',
    '## Likelihood: use these terms only',
    '',
    'Say how likely a judgement is with one of these terms or its alternative, and never with another word (no "may", "could", "possibly", "probably" on their own, and no bare percentages without the term).',
    '',
    '| Term | Alternative | Range |',
    '|---|---|---|',
    ...ICD203_LIKELIHOOD.map((entry) => `| ${entry.term} | ${entry.alternative} | ${entry.low} to ${entry.high} percent |`),
    '',
    '## Confidence: a sentence of its own',
    '',
    `Confidence says how good the basis for a judgement is (the sources, their grades, the assumptions and how much is missing): ${ICD203_CONFIDENCE_LEVELS.join(', ')}. Say it in a separate sentence and give the reason. Never put a likelihood term and a confidence level in the same sentence.`,
    '',
    '- Right: "The brigade will likely attack across the ford within 48 hours. We have moderate confidence in this judgement, because two independent sources report the bridging equipment but neither has seen the reserve."',
    '- Wrong: "We assess with moderate confidence that the brigade will likely attack."',
    '',
    '## How to write a judgement',
    '',
    '- Put the bottom line first, then the reasons.',
    '- Mark every key judgement as a judgement ("Key judgement:"), and keep facts (each with its source and grades) apart from judgements and from assumptions.',
    '- State every assumption that fills a gap, and what would show it to be wrong, so the reader knows which conclusions rest on it.',
    '- Consider the alternatives: name the other explanations or courses of action and why they rank lower (analysis of competing hypotheses where it matters).',
    '- When a judgement changes from an earlier product, say what changed and why; when it holds, say so.',
    '- Write for the decision it serves: say what the judgement means for the commander\'s decision, without making the decision.',
    '',
    '## The five analytic standards',
    '',
    ...ICD203_ANALYTIC_STANDARDS.map((standard, index) => `${index + 1}. ${standard}.`),
    '',
    '## The nine analytic tradecraft standards',
    '',
    ...ICD203_TRADECRAFT_STANDARDS.map((standard, index) => `${index + 1}. ${standard}.`),
    '',
    '## What the gate checks mechanically',
    '',
    '- Likelihood terms come from the table above only.',
    '- No sentence holds both a likelihood term and a confidence level.',
    '- Every key judgement is marked, and every fact has a source.',
    '- Every source has a reliability grade and a credibility grade recorded separately (see source-grading.md), an origin and dates.',
    '- Every PIR has a decision point and a latest time of value; every high-value target appears in a course of action; the most likely and the most dangerous courses of action are both named.',
    '',
    'The reviewer then judges what rules cannot: the standards above, a key assumptions check, and devil\'s advocacy on each key judgement. Its verdict is SIGN-OFF or NOT READY with numbered fixes.',
    ''
  ].join('\n');
}

export function sourceGradingSkill(profile: StaffProfileId): string {
  const one = INTELLIGENCE_TERMS[profile].credibilityOne;
  return [
    '# Skill: source grading',
    '',
    'Grade every source and every item of information on two separate scales: how reliable the source is (a letter) and how credible this item is (a number). Judge them independently: a reliable source can pass on a doubtful report, and an unknown source can report something other evidence confirms. Write the two together only when recording them, as "B2".',
    '',
    '## Reliability of the source',
    '',
    '| Grade | Meaning |',
    '|---|---|',
    ...SOURCE_RELIABILITY_GRADES.map((entry) => `| ${entry.grade} | ${entry.meaning} |`),
    '',
    '## Credibility of the information',
    '',
    '| Grade | Meaning |',
    '|---|---|',
    `| 1 | ${one} |`,
    ...INFORMATION_CREDIBILITY_GRADES.map((entry) => `| ${entry.grade} | ${entry.meaning} |`),
    '',
    profile === 'nato-ca'
      ? 'Grade 1 follows AJP-2.1. Older Canadian doctrine reads it as "confirmed by other sources"; under either reading, give grade 1 only when an independent source confirms the item.'
      : 'Grade 1 means an independent source confirms the item; give it only then.',
    '',
    '## Rules',
    '',
    '- Record every item with its reference (a URL or citation), the date it was published, the date you accessed it, its origin (who first reported it) and both grades, each with a one-line reason.',
    '- Reports that share an origin are one report. Two outlets repeating the same wire story, or a post and the article quoting it, never count as independent confirmation. Record the origin so this can be checked.',
    '- F and 6 are honest grades, not failures: use them when you cannot judge, and say why.',
    '- Open sources can be planted. For each item, say what an adversary would gain if it were false, and lower the credibility where the item is convenient for someone.',
    '- A grade belongs to an item at a time: regrade when a new report confirms or contradicts it, and say what changed.',
    '- Never collect on or profile a person in your own country, or any real person. Staff exercises use fictional data only.',
    '',
    '## Register columns',
    '',
    'Source; Reference; Published; Accessed; Origin; Reliability; Credibility; Deception note.',
    ''
  ].join('\n');
}

/** The skill files the J2 template writes, at .planning/staff/skills/<name>.md. */
export function j2SkillFiles(profile: StaffProfileId): StaffSkillFile[] {
  return [
    { name: 'icd203-standards', path: '.planning/staff/skills/icd203-standards.md', content: icd203Skill() },
    { name: 'source-grading', path: '.planning/staff/skills/source-grading.md', content: sourceGradingSkill(profile) }
  ];
}

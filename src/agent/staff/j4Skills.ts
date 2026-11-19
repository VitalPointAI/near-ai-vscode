// The J4 skill (design 10, 6.2; research note 03, B5, B8 and B12; WP-J4): `logstat-definitions`, the file every J4 member reads before it writes or
// checks a number. It defines the LOGSTAT words per commodity, the plausibility rules the logstat-analyst applies, the colour bands as settings a person
// fills in, the classes of supply of the profile, and the calculator record convention every number follows. It lives in the project's
// .planning/staff/skills/ so the person can read it and fill in the table. Pure: no I/O, no clock, no vscode.
import { STAFF_FOLDER } from '../../domain/staff/writeLimits';
import { CALC_RECORDS_HEADING, CALCULATOR_FOLDER } from './j4Products';
import type { J4Vocabulary } from './j4Vocabulary';

export const J4_SKILLS = ['logstat-definitions'] as const;
export type J4Skill = (typeof J4_SKILLS)[number];
export const j4SkillPath = (skill: J4Skill): string => `${STAFF_FOLDER}/skills/${skill}.md`;

/** What each LOGSTAT word means; "capacity" is set per commodity in the table below, so 100 percent always means the same thing. */
const MEANINGS: Readonly<Record<string, string>> = {
  'On hand': 'What the unit holds now and can issue, counted at the report time. Stock carried for another unit is reported apart, under that unit.',
  Received: 'What arrived since the last report.',
  Consumed: 'What was used or issued to the unit\'s own users since the last report.',
  Capacity: 'The most the unit can hold of the commodity: tank, vehicle and storage capacity as the table below defines it. 100 percent means full to this capacity.',
  Required: 'What the unit needs over the forecast period for its tasks, from the calculator.',
  'Days of supply': 'On hand divided by the forecast daily requirement, from the calculator.'
};


/** The logstat-definitions skill for the vocabulary. */
export function logstatDefinitionsSkill(v: J4Vocabulary): string {
  const report = v.logstat.report;
  const fields = v.logstat.fields;
  return [
    '# LOGSTAT definitions',
    '',
    `Every member of the ${v.code} section reads this before writing or checking a number. A ${report} is data that needs analysis before anyone acts on it: unclear definitions are the most common reason reports mislead. This file is the project's one set of definitions; change it here, never in a product.`,
    '',
    '## The words',
    '',
    '| Word | Meaning |',
    '|---|---|',
    ...fields.map((field) => `| ${field} | ${MEANINGS[field] ?? ''} |`),
    '',
    `A ${report} shows, for each commodity, ${fields.map((field) => field.toLowerCase()).join(', ')}, and a forecast to ${v.logstat.forecastHours} hours.`,
    '',
    '## Commodities and their settings',
    '',
    'A person fills in this table for the exercise; an empty cell means the setting is not set, and members say so rather than guess. The amber and red bands are settings, never fixed numbers: fixed bands trigger emergency resupply too early. Every product that shows a band shows the numbers behind it.',
    '',
    '| Commodity | Unit of measure | What capacity means | Amber below | Red below |',
    '|---|---|---|---|---|',
    ...v.supplyClasses.map((entry) => `| Class ${entry.class}: ${entry.holds.charAt(0).toLowerCase()}${entry.holds.slice(1)} |  |  |  |  |`),
    '',
    `These are the classes of supply under the ${v.resolved.profile.name} profile.`,
    '',
    '## Plausibility rules (the logstat-analyst applies them; nobody fixes a number silently)',
    '',
    '1. On hand is never below zero and never above capacity (no fuel above tank capacity).',
    '2. On hand agrees with the last report plus received minus consumed; a difference is a finding, not a correction.',
    `3. Every commodity has a forecast to ${v.logstat.forecastHours} hours.`,
    '4. A forward unit\'s own needs are reported apart from the bulk stocks it carries for others.',
    '5. Days of supply and required come from a calculator record, never from the report\'s own arithmetic.',
    '6. A report that fails a rule goes back to its unit with the rule named, and stays out of the consolidation until it passes.',
    '',
    '## How reports flow',
    '',
    `Units report to their formation, which validates and consolidates before passing the report on; the ${v.currentOps} consolidates the validated reports, forecasts, and keeps the ${v.logstat.picture}.`,
    ...(v.linesOfSupport.length ? ['', `With the Canadian nation setting, this level provides: ${v.linesOfSupport.map((line) => `${line.line} (${line.meaning.charAt(0).toLowerCase()}${line.meaning.slice(1)})`).join('; ')}.`] : []),
    ...(v.canadianReports ? ['', `A deployed Canadian operation also sends ${v.reports.to} the ${v.reports.weekly.toLowerCase()} and the ${v.reports.others.map((name) => name.toLowerCase()).join(', ')}, ${v.reports.cadence}. The ${report} is the daily input to them.`] : []),
    '',
    '## Every number traces to a calculator record',
    '',
    `1. Numbers come from the consumption calculator on the logistics server: factors a person entered (a rate per unit per day) times the force list times the days. The calculator ships no planning factor tables, and members never use one from a government source.`,
    `2. Each calculation is kept as a record at ${CALCULATOR_FOLDER}<id>.json with its formula and its inputs.`,
    `3. A product cites the record on the same line as the number: \`calc:<id>\` (the id is lower-case letters, digits and hyphens, at most 64 characters, as guard-scan reads it). Example: "Class III (bulk) for phase 2: 120,000 litres (calc:fuel-phase-2)".`,
    `4. Every product with numbers lists its records under "${CALC_RECORDS_HEADING}" with what each computed.`,
    '5. guard-scan holds a J4 product with a number and no record on its line, or with a calc:<id> that names no record. The release guard cannot clear it.',
    '6. A number in a fenced code block (a formula shown as working) is not checked; the result line outside it is.',
    ''
  ].join('\n');
}

export interface J4SkillFile { readonly name: J4Skill; readonly path: string; readonly content: string }

export function j4SkillFiles(v: J4Vocabulary): J4SkillFile[] {
  return [{ name: 'logstat-definitions', path: j4SkillPath('logstat-definitions'), content: logstatDefinitionsSkill(v) }];
}

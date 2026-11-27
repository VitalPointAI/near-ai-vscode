import { createHash } from 'node:crypto';
import { renderTeam } from '../teams';

export const INSTITUTIONAL_COMMAND_GROUP_TEAM = 'institutional-command-group-v1';
export const INSTITUTIONAL_COMMAND_GROUP_NAME = 'Institutional Command Group';
export const INSTITUTIONAL_COMMAND_GROUP_PROFILE = 'Canadian brigade (L3)';
export const INSTITUTIONAL_COMMAND_GROUP_LEAD = 'Command Group lead';
export const INSTITUTIONAL_COMMAND_GROUP_MEMBER = 'command-brief-drafter';

const description = 'Prepare a local institutional decision brief for human review.';
const instructions = 'Prepare a CG-07 decision brief using only evidence admitted for this project. Separate sourced facts, assumptions and alternatives. Preserve attributed disagreement. Leave the decision with the Command Group lead.';

export const institutionalCommandGroupDefinition = renderTeam(INSTITUTIONAL_COMMAND_GROUP_NAME, description, [{
  name: INSTITUTIONAL_COMMAND_GROUP_MEMBER,
  role: 'Decision brief drafter',
  instructions,
}], { private: true });

export const institutionalCommandGroupSkill = [
  '# Decision brief (CG-07)',
  '',
  instructions,
  '',
  'State the decision requested, options, dependencies, uncertainties and dissent. Cite each factual claim to its exact source version and text span.',
  '',
  'Present the completed draft for human review. The brief does not approve a decision, change an official record or authorize release.',
  '',
].join('\n');

export function institutionalDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface InstitutionalCommandGroupBinding {
  readonly version: 1;
  readonly echelon: 'L3';
  readonly rootDigest: string;
  readonly directoryDigest: string;
  readonly team: typeof INSTITUTIONAL_COMMAND_GROUP_TEAM;
  readonly teamDigest: string;
  readonly skillDigest: string;
}

export function institutionalCommandGroupBinding(canonicalRoot: string, directoryDigest: string): InstitutionalCommandGroupBinding {
  return {
    version: 1,
    echelon: 'L3',
    rootDigest: institutionalDigest(canonicalRoot),
    directoryDigest,
    team: INSTITUTIONAL_COMMAND_GROUP_TEAM,
    teamDigest: institutionalDigest(institutionalCommandGroupDefinition),
    skillDigest: institutionalDigest(institutionalCommandGroupSkill),
  };
}

/** Checks the exact setup-owned binding. Matching metadata is not run authority. */
export function readInstitutionalCommandGroupBinding(value: unknown, expected: InstitutionalCommandGroupBinding): InstitutionalCommandGroupBinding | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(expected) as Array<keyof InstitutionalCommandGroupBinding>;
  if (Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field) || record[field] !== expected[field])) return undefined;
  return expected;
}

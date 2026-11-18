// The staff section templates the extension ships, for the template history (scripts/template-history.mjs) and Update Team. Each entry renders every
// variant it offers, so the history records a fingerprint for every member as it can be generated, and a change to any variant's text, guidance or
// skills needs a new template version (the unit test holds this, as it does for the project types). Pure: no I/O, no clock, no vscode.
import type { StaffSectionId } from '../../domain/staff/doctrine';
import { j5Guidance, j5OptionSets, J5_SKILLS, renderJ5Team } from './j5Plans';
import { j5SkillText } from './j5Skills';

export interface StaffTemplateEntry {
  /** The template's key in TEMPLATE_HISTORY. */
  readonly id: string;
  readonly label: string;
  readonly section: StaffSectionId;
  /** Every team file the template can generate (each variant, cloud and local). */
  teams(): string[];
  /** Every project guidance block it can generate. */
  guidance(): string[];
  /** Everything that defines it, hashed for the history: a change here is a new version. */
  definition(): unknown;
}

const j5Teams = (): string[] => ['cloud', 'local'].flatMap((locality) => j5OptionSets().map((options) => renderJ5Team({ ...options, locality: locality as 'cloud' | 'local' })));

export const STAFF_TEMPLATES: readonly StaffTemplateEntry[] = [
  {
    id: 'staff-j5-plans',
    label: 'J5 plans (military staff)',
    section: 'j5',
    teams: j5Teams,
    guidance: () => j5OptionSets().map((options) => j5Guidance(options)),
    definition: () => ({
      teams: j5Teams(),
      guidance: j5OptionSets().map((options) => j5Guidance(options)),
      skills: j5OptionSets().map((options) => J5_SKILLS.map((skill) => j5SkillText(skill, options)))
    })
  }
];

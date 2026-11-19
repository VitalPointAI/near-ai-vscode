// The military staff section templates the extension ships (design 10, section 3): the one registry the Staff Team setup, Team Studio, Update Team and
// the template history (scripts/template-history.mjs) read. Each template renders from the project's staff settings, so the history records a
// fingerprint for every rendering: Update Team can then tell a member the person never changed from one they edited, whichever profile, level and
// echelon the team was made for, and a change to any rendering's team, guidance or skills needs a new template version (the unit tests hold this, as
// they do for the project types). Pure: no I/O, no clock, no vscode.
import type { StaffSectionId } from '../../domain/staff/doctrine';
import { renderProfileMarkdown, resolveProfile } from '../../domain/staff/profiles';
import type { StaffSettings } from '../../domain/staff/profiles';
import { definitionHash, guidanceFingerprint, memberFingerprint } from '../teamFingerprints';
import { splitTeam } from '../teamMarkdown';
import type { TemplateSnapshot } from '../teamTemplateHistory';
import { J2_TEMPLATE_ID, j2Renderings, j2Template } from './j2Template';
import { J4_TEMPLATE_ID, j4Renderings, j4Template } from './j4Template';
import { j5Guidance, j5OptionSets, J5_SKILLS, renderJ5Team, skillPath } from './j5Plans';
import type { J5TemplateOptions, J5Variant } from './j5Plans';
import { j5SkillText } from './j5Skills';
import type { TacticalEchelon } from './j2Vocabulary';

export const J5_TEMPLATE_ID = 'j5-plans';

/** What a person picks when setting up a staff team: the project's staff settings, plus the options only some templates offer. */
export interface StaffTemplateOptions {
  readonly settings: StaffSettings;
  /** J2 at tactical level: the brigade or battalion roster (brigade when not given). */
  readonly echelon?: TacticalEchelon;
  /** J5: `mdo` replaces COA cell B with a convergence planner, under US Army only. */
  readonly variant?: J5Variant;
  /** J5: the red team, on unless the profile lets it be switched off (NATO/Canadian) and the person did. */
  readonly redTeam?: boolean;
  /** A local-only project's team carries no web tools. */
  readonly locality?: 'cloud' | 'local';
}

/** A file a template writes, relative to the project folder. */
export interface StaffTemplateFile { readonly path: string; readonly content: string }

/** Everything a template writes for one set of options: the team file, the guidance block's inner text (between its own AGENTS.md markers), and files. */
export interface StaffTemplateOutput {
  readonly team: string;
  readonly guidance: string;
  /** PROFILE.md and the skills, each at its project path. */
  readonly files: readonly StaffTemplateFile[];
}

export interface StaffTemplateRendering extends StaffTemplateOutput {
  /** profile/level[/nation]/planningType[/option...]/locality, unique per rendering. */
  readonly key: string;
}

export interface StaffTemplate {
  /** The template's key in TEMPLATE_HISTORY and in its AGENTS.md markers. */
  readonly id: string;
  readonly section: StaffSectionId;
  readonly label: string;
  readonly description: string;
  /** The glyph its team's `staff:` block names. */
  readonly glyph: string;
  /** The team file's name when the setup writes it (`<file>.md` in the project's teams folder). */
  readonly file: string;
  render(options: StaffTemplateOptions): StaffTemplateOutput;
  /** Every rendering the template can produce, for cloud and local-only projects. */
  renderings(): StaffTemplateRendering[];
  /** Every team file it can generate. */
  teams(): string[];
  /** Every guidance block it can generate. */
  guidance(): string[];
  /** Everything that defines it, hashed for the history: a change here is a new version. */
  definition(): unknown;
}

const LOCALITIES = ['cloud', 'local'] as const;

function fromRenderings(base: Omit<StaffTemplate, 'teams' | 'guidance' | 'definition'>): StaffTemplate {
  return {
    ...base,
    teams: () => base.renderings().map((rendering) => rendering.team),
    guidance: () => [...new Set(base.renderings().map((rendering) => rendering.guidance))],
    definition: () => base.renderings()
  };
}

export const J2_STAFF_TEMPLATE: StaffTemplate = fromRenderings({
  id: J2_TEMPLATE_ID,
  section: 'j2',
  label: 'J2 intelligence',
  description: 'Intelligence staff section: estimates and the intelligence annex, requirements and collection, preparation of the operational environment, warning, a red cell, and two blocking gates before a person decides.',
  glyph: 'eye',
  file: 'j2-intelligence',
  render: (options) => {
    const output = j2Template(options.settings, { ...(options.echelon ? { echelon: options.echelon } : {}), ...(options.locality ? { locality: options.locality } : {}) });
    return { team: output.team, guidance: output.guidance, files: output.files.map((file) => ({ path: file.path, content: file.content })) };
  },
  renderings: () => j2Renderings().flatMap((rendering) => LOCALITIES.map((locality) => {
    const output = J2_STAFF_TEMPLATE.render({ settings: rendering.settings, ...(rendering.echelon ? { echelon: rendering.echelon } : {}), locality });
    return { key: `${rendering.key}/${locality}`, ...output };
  }))
});

const j5Options = (options: StaffTemplateOptions): J5TemplateOptions => ({
  settings: options.settings,
  ...(options.variant ? { variant: options.variant } : {}),
  ...(options.redTeam !== undefined ? { redTeam: options.redTeam } : {}),
  ...(options.locality ? { locality: options.locality } : {})
});

const j5Key = (options: J5TemplateOptions): string => [
  options.settings.profile, options.settings.level, options.settings.nation, options.settings.planningType, options.variant ?? 'standard', options.redTeam === false ? 'no-red-team' : undefined, options.locality
].filter(Boolean).join('/');

export const J5_STAFF_TEMPLATE: StaffTemplate = fromRenderings({
  id: J5_TEMPLATE_ID,
  section: 'j5',
  label: 'J5 plans',
  description: 'Plans section: a lead planner who runs the planning steps and the wargame, design before the steps, two COA cells working at once, a red cell seat, an independent red team, and a release guard before a person decides.',
  glyph: 'compass',
  file: 'j5-plans',
  render: (options) => {
    const j5 = j5Options(options);
    return {
      team: renderJ5Team(j5),
      guidance: j5Guidance(j5),
      files: [
        { path: '.planning/staff/PROFILE.md', content: renderProfileMarkdown(resolveProfile(options.settings)) },
        ...J5_SKILLS.map((skill) => ({ path: skillPath(skill), content: j5SkillText(skill, j5) }))
      ]
    };
  },
  renderings: () => j5OptionSets().flatMap((options) => LOCALITIES.map((locality) => {
    const j5 = { ...options, locality };
    return { key: j5Key(j5), ...J5_STAFF_TEMPLATE.render({ settings: j5.settings, ...(j5.variant ? { variant: j5.variant } : {}), ...(j5.redTeam !== undefined ? { redTeam: j5.redTeam } : {}), locality }) };
  }))
});

export const J4_STAFF_TEMPLATE: StaffTemplate = fromRenderings({
  id: J4_TEMPLATE_ID,
  section: 'j4',
  label: 'J4 logistics',
  description: 'Logistics staff section: support planning from the first step, one planner per logistics function working at once, the logistics current-operations watch and LOGSTAT validation, every number traced to a calculator record, and a release guard before a person decides.',
  glyph: 'package',
  file: 'j4-logistics',
  render: (options) => {
    const output = j4Template(options.settings, options.locality ? { locality: options.locality } : {});
    return { team: output.team, guidance: output.guidance, files: output.files.map((file) => ({ path: file.path, content: file.content })) };
  },
  renderings: () => j4Renderings().flatMap((rendering) => LOCALITIES.map((locality) => ({ key: `${rendering.key}/${locality}`, ...J4_STAFF_TEMPLATE.render({ settings: rendering.settings, locality }) })))
});

/** The staff templates, in the order the setup offers them: the drop 1 sections (J2, J5), then J4. */
export const STAFF_TEMPLATES: readonly StaffTemplate[] = [J2_STAFF_TEMPLATE, J5_STAFF_TEMPLATE, J4_STAFF_TEMPLATE];

export function staffTemplate(id: string): StaffTemplate | undefined {
  return STAFF_TEMPLATES.find((template) => template.id === id);
}

export function staffTemplateForSection(section: StaffSectionId): StaffTemplate | undefined {
  return STAFF_TEMPLATES.find((template) => template.section === section);
}

/**
 * A staff template's current snapshot, in the form teamTemplateHistory.ts records: a hash of everything it renders, the guidance fingerprints, and each
 * member's fingerprints across all renderings (scripts/template-history.mjs appends it as a new version when the hash changes).
 */
export function staffTemplateSnapshot(template: StaffTemplate): Omit<TemplateSnapshot, 'version'> {
  const renderings = template.renderings();
  const members: Record<string, string[]> = {};
  const guidance = new Set<string>();
  for (const rendering of renderings) {
    guidance.add(guidanceFingerprint(rendering.guidance));
    for (const section of splitTeam(rendering.team).sections) {
      const fingerprint = memberFingerprint({ ...section, tools: section.tools ?? null });
      members[section.name] = [...new Set([...(members[section.name] ?? []), fingerprint])];
    }
  }
  return { definition: definitionHash(renderings), guidance: [...guidance], members };
}

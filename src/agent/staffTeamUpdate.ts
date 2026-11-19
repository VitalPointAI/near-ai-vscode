// Update Team for a military staff section team (a team file with a `staff:` block, made by Set Up a Staff Team). A staff template renders from the
// project's staff settings, so the built-in members to compare against are today's rendering for those settings, picked to match the file's own shape:
// the J2 brigade or battalion roster, the J5 multidomain variant, a NATO/Canadian J5 without its red team, and a local-only team without web tools.
// The released fingerprints are in TEMPLATE_HISTORY under the template's id, like a project type's. Pure: no I/O, no clock, no vscode.
import { MDO_TERMS, RED_TEAM_NOTES, STAFF_PROFILE_IDS } from '../domain/staff/doctrine';
import { defaultStaffSettings, levelOffer } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { readStaffTeamBlock } from '../domain/staff/teamBlock';
import type { StaffTeamBlock } from '../domain/staff/teamBlock';
import { staffTemplate, staffTemplateForSection, type StaffTemplate, type StaffTemplateOptions } from './staff/templates';
import { TACTICAL_ECHELONS } from './staff/j2Vocabulary';
import { memberFingerprint } from './teamFingerprints';
import { splitTeam, type Section } from './teamMarkdown';

/** The staff block of a team file, or undefined for a plain team (or a block that does not parse: Update Team then leaves it alone). */
export function staffBlockOf(text: string): StaffTeamBlock | undefined {
  try {
    const read = readStaffTeamBlock(text);
    return read.ok ? read.value : undefined;
  } catch {
    return undefined;
  }
}

/** The staff template a team file comes from: its stamp (`template: <id>`), else the template for its block's section. */
export function staffTemplateOf(text: string, stamped?: string): StaffTemplate | undefined {
  const block = staffBlockOf(text);
  if (!block) return undefined;
  return (stamped ? staffTemplate(stamped) : undefined) ?? staffTemplateForSection(block.section);
}

/**
 * The settings to render with: the project's staff settings when given, else the block's profile and level on the defaults. A profile or level the
 * template does not offer falls back to the defaults, so the plan is always made from a valid rendering.
 */
export function staffSettingsFor(block: StaffTeamBlock, project?: StaffSettings): StaffSettings {
  if (project) return project;
  const base = defaultStaffSettings();
  const profile = block.profile && (STAFF_PROFILE_IDS as readonly string[]).includes(block.profile) ? block.profile : base.profile;
  const level = block.level && levelOffer(profile, block.level).offered ? block.level : base.level;
  return { ...base, profile, level, ...(profile === 'nato-ca' ? { nation: 'nato' as const } : {}) };
}

/** Every option set the template could have made this team with, for the settings. */
function candidates(template: StaffTemplate, settings: StaffSettings): StaffTemplateOptions[] {
  const out: StaffTemplateOptions[] = [];
  for (const locality of ['cloud', 'local'] as const) {
    if (template.section === 'j2') {
      for (const echelon of settings.level === 'tactical' ? TACTICAL_ECHELONS : [undefined]) out.push({ settings, locality, ...(echelon ? { echelon } : {}) });
    } else if (template.section === 'j5') {
      const variants = (MDO_TERMS.profiles as readonly string[]).includes(settings.profile) ? (['standard', 'mdo'] as const) : (['standard'] as const);
      const redTeams = RED_TEAM_NOTES[settings.profile].optional ? [true, false] : [true];
      for (const variant of variants) for (const redTeam of redTeams) out.push({ settings, locality, variant, ...(redTeam ? {} : { redTeam: false }) });
    } else out.push({ settings, locality });
  }
  return out;
}

export interface StaffRendering { readonly options: StaffTemplateOptions; readonly sections: ReadonlyArray<Omit<Section, 'raw'>>; readonly block?: StaffTeamBlock; readonly local: boolean }

function rendering(template: StaffTemplate, options: StaffTemplateOptions): StaffRendering | undefined {
  try {
    const team = template.render(options).team;
    const sections = splitTeam(team).sections.map(({ raw: _raw, ...section }) => section);
    return { options, sections, ...(staffBlockOf(team) ? { block: staffBlockOf(team)! } : {}), local: options.locality === 'local' };
  } catch {
    return undefined;
  }
}

/** Today's rendering for the options a plan recorded. */
export function staffRenderingFor(template: StaffTemplate, options: StaffTemplateOptions): StaffRendering | undefined {
  return rendering(template, options);
}

/**
 * Today's rendering that best fits the file: the most members by name, then the most whose tools match exactly (which tells a local-only team from a
 * cloud one), then the most members unchanged. Undefined when no rendering can be made for the settings.
 */
export function bestStaffRendering(template: StaffTemplate, settings: StaffSettings, sections: ReadonlyArray<Pick<Section, 'name' | 'tools'> & Partial<Section>>): StaffRendering | undefined {
  let best: { rendering: StaffRendering; score: number } | undefined;
  for (const options of candidates(template, settings)) {
    const made = rendering(template, options);
    if (!made) continue;
    let score = 0;
    for (const section of sections) {
      const built = made.sections.find((candidate) => candidate.name === section.name);
      if (!built) continue;
      score += 100;
      const tools = (list?: readonly string[]) => [...(list ?? [])].sort().join(',');
      if (tools(built.tools) === tools(section.tools)) score += 10;
      if (section.instructions !== undefined && memberFingerprint({ ...built, tools: built.tools ?? null }) === memberFingerprint({ ...(section as Section), tools: section.tools ?? null })) score += 1;
    }
    score -= made.sections.filter((built) => !sections.some((section) => section.name === built.name)).length * 50;
    if (!best || score > best.score) best = { rendering: made, score };
  }
  return best?.rendering;
}

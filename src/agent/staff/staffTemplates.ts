// The built-in military staff section templates (design 10, section 3; WP-J2 adds the first, J2 intelligence). A staff template is rendered from the
// project's staff settings, so its released versions are recorded in teamTemplateHistory.ts with a fingerprint for every rendering: Update Team can
// then tell a member the person never changed from one they edited, whichever profile, level and echelon the team was made for.
import type { StaffSectionId } from '../../domain/staff/doctrine';
import { definitionHash, guidanceFingerprint, memberFingerprint } from '../teamFingerprints';
import { splitTeam } from '../teamMarkdown';
import type { TemplateSnapshot } from '../teamTemplateHistory';
import { J2_TEMPLATE_ID, j2Renderings, j2Template } from './j2Template';

export interface StaffTemplateRendering {
  /** profile/level[/nation]/planningType[/echelon], with the locality appended. */
  readonly key: string;
  readonly team: string;
  readonly guidance: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}

export interface StaffTemplate {
  readonly id: string;
  readonly section: StaffSectionId;
  readonly label: string;
  readonly description: string;
  /** Every rendering the template can produce, for cloud and local-only projects. */
  readonly renderings: () => StaffTemplateRendering[];
}

export const J2_STAFF_TEMPLATE: StaffTemplate = {
  id: J2_TEMPLATE_ID,
  section: 'j2',
  label: 'J2 intelligence',
  description: 'Joint intelligence staff section: estimates and annex, requirements and collection, preparation of the operational environment, warning, a red cell, and two blocking gates. Unclassified, fictional data, private models.',
  renderings: () => j2Renderings().flatMap((rendering) => (['cloud', 'local'] as const).map((locality) => {
    const output = j2Template(rendering.settings, { ...(rendering.echelon ? { echelon: rendering.echelon } : {}), locality });
    return { key: `${rendering.key}/${locality}`, team: output.team, guidance: output.guidance, files: output.files.map((file) => ({ path: file.path, content: file.content })) };
  }))
};

export const STAFF_TEMPLATES: readonly StaffTemplate[] = [J2_STAFF_TEMPLATE];

export function staffTemplate(id: string): StaffTemplate | undefined {
  return STAFF_TEMPLATES.find((template) => template.id === id);
}

/**
 * A staff template's current snapshot, in the form teamTemplateHistory.ts records: a hash of every rendering, the guidance fingerprints, and each
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

// The optional `staff:` block in a team file's frontmatter (UX concept 11, item 1, and 12.5; WP-0). Pure: no I/O, no clock, no vscode.
//
//   staff:
//     section: j2
//     profile: us-joint          # optional: the profile this roster variant is written for
//     level: operational         # optional: the level this roster variant is written for
//     glyph: eye                 # optional: from the Staff Room's shared glyph set
//     human-lead: J2 director    # optional: the role of the person who leads the section
//     steps: { 2: primary, 3: supporting, 7: primary }
//     products: [intelligence-estimate, intelligence-annex]
//     layers: [cop-threat-layer]
//
// A team file without the block is read exactly as before. The block is read strictly: an unknown key, a repeated key, a bad value or a block list is
// refused with the field named, so a staff team never runs on a half-read block. Builds from before the block existed skip its indented lines (their
// frontmatter reader takes only unindented `key: value` lines), so the team's name, description and privacy read the same in every build.
import { CROSSWALK_STEPS, STAFF_LEVELS, STAFF_PROFILE_IDS, STAFF_SECTION_IDS } from './doctrine';
import type { CrosswalkStep, StaffLevel, StaffProfileId, StaffSectionId } from './doctrine';
import type { StepRole } from './events';
import { isOneLine, isOneOf, ok, parseFlowList, parseFlowMap, parseKeyLine, STAFF_SLUG, staffRefused, stripNote } from './parse';
import type { StaffParsed } from './parse';
import { levelOffer } from './profiles';

export interface StaffTeamBlock {
  readonly section: StaffSectionId;
  readonly profile?: StaffProfileId;
  readonly level?: StaffLevel;
  readonly glyph?: string;
  readonly humanLead?: string;
  /** The crosswalk steps where the section leads (`primary`) or supports; steps it does not take part in are absent. */
  readonly steps: Readonly<Partial<Record<CrosswalkStep, StepRole>>>;
  readonly products: readonly string[];
  readonly layers: readonly string[];
}

export const STAFF_BLOCK_KEYS = ['section', 'profile', 'level', 'glyph', 'human-lead', 'steps', 'products', 'layers'] as const;
const STEP_ROLES: readonly StepRole[] = ['primary', 'supporting'];
const GLYPH = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_BLOCK_PRODUCTS = 50;
export const MAX_BLOCK_LAYERS = 20;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * The `staff:` block of a team file: ok(undefined) when the file has no frontmatter or no `staff:` line, ok(block) when it has a valid one, and a refusal
 * naming the field otherwise.
 */
export function readStaffTeamBlock(teamFile: string): StaffParsed<StaffTeamBlock | undefined> {
  const match = FRONTMATTER.exec(teamFile);
  if (!match) return ok(undefined);
  const lines = match[1].split(/\r?\n/);
  const starts = lines.map((line, index) => (/^staff:/.test(line) ? index : -1)).filter((index) => index >= 0);
  if (starts.length === 0) return ok(undefined);
  if (starts.length > 1) return staffRefused('duplicate-field', 'staff');
  const start = starts[0];
  if (stripNote(lines[start].slice('staff:'.length)) !== '') return staffRefused('wrong-type', 'staff');
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s+#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  return parseStaffBlockLines(body);
}

/** The block's indented lines (without the `staff:` line), read strictly. Every line has the same indent of spaces; tabs are refused. */
export function parseStaffBlockLines(lines: readonly string[]): StaffParsed<StaffTeamBlock> {
  if (lines.length === 0) return staffRefused('missing-field', 'staff.section');
  const indent = /^( +)/.exec(lines[0])?.[1] ?? '';
  const raw = new Map<string, string>();
  for (const line of lines) {
    if (indent === '' || !line.startsWith(indent) || /^\s/.test(line.slice(indent.length)) || line.includes('\t')) return staffRefused('bad-syntax', 'staff');
    const pair = parseKeyLine(line.slice(indent.length));
    if (!pair) return staffRefused('bad-syntax', 'staff');
    if (!(STAFF_BLOCK_KEYS as readonly string[]).includes(pair.key)) return staffRefused('unknown-field', `staff.${pair.key}`);
    if (raw.has(pair.key)) return staffRefused('duplicate-field', `staff.${pair.key}`);
    if (pair.value === '') return staffRefused('wrong-type', `staff.${pair.key}`);
    raw.set(pair.key, pair.value);
  }
  const section = raw.get('section');
  if (section === undefined) return staffRefused('missing-field', 'staff.section');
  if (!isOneOf(STAFF_SECTION_IDS, section)) return staffRefused('unknown-value', 'staff.section');

  const profile = raw.get('profile');
  if (profile !== undefined && !isOneOf(STAFF_PROFILE_IDS, profile)) return staffRefused('unknown-value', 'staff.profile');
  const level = raw.get('level');
  if (level !== undefined && !isOneOf(STAFF_LEVELS, level)) return staffRefused('unknown-value', 'staff.level');
  if (profile !== undefined && level !== undefined && !levelOffer(profile as StaffProfileId, level as StaffLevel).offered) return staffRefused('not-offered', 'staff.level');

  const glyph = raw.get('glyph');
  if (glyph !== undefined && !GLYPH.test(glyph)) return staffRefused('wrong-type', 'staff.glyph');
  const humanLead = raw.get('human-lead');
  if (humanLead !== undefined && !isOneLine(humanLead, 80)) return staffRefused('wrong-type', 'staff.human-lead');

  const steps: Partial<Record<CrosswalkStep, StepRole>> = {};
  if (raw.has('steps')) {
    const pairs = parseFlowMap(raw.get('steps') as string);
    if (!pairs) return staffRefused('wrong-type', 'staff.steps');
    for (const [key, value] of pairs) {
      const step = /^[1-9]$/.test(key) ? Number(key) : Number.NaN;
      if (!(CROSSWALK_STEPS as readonly number[]).includes(step)) return staffRefused('unknown-value', `staff.steps.${key}`);
      if (Object.prototype.hasOwnProperty.call(steps, step)) return staffRefused('duplicate-entry', `staff.steps.${key}`);
      if (!STEP_ROLES.includes(value as StepRole)) return staffRefused('unknown-value', `staff.steps.${key}`);
      steps[step as CrosswalkStep] = value as StepRole;
    }
  }
  const products = slugList(raw.get('products'), 'staff.products', MAX_BLOCK_PRODUCTS);
  if (!products.ok) return products;
  const layers = slugList(raw.get('layers'), 'staff.layers', MAX_BLOCK_LAYERS);
  if (!layers.ok) return layers;

  return ok({
    section,
    ...(profile !== undefined ? { profile: profile as StaffProfileId } : {}),
    ...(level !== undefined ? { level: level as StaffLevel } : {}),
    ...(glyph !== undefined ? { glyph } : {}),
    ...(humanLead !== undefined ? { humanLead } : {}),
    steps,
    products: products.value,
    layers: layers.value
  });
}

function slugList(text: string | undefined, path: string, max: number): StaffParsed<readonly string[]> {
  if (text === undefined) return ok([]);
  const items = parseFlowList(text);
  if (!items) return staffRefused('wrong-type', path);
  if (items.length > max) return staffRefused('out-of-range', path);
  for (let index = 0; index < items.length; index += 1) {
    if (!STAFF_SLUG.test(items[index])) return staffRefused('wrong-type', `${path}[${index}]`);
    if (items.indexOf(items[index]) !== index) return staffRefused('duplicate-entry', `${path}[${index}]`);
  }
  return ok(items);
}

/** The block as frontmatter lines, `staff:` first, in a fixed key order. `readStaffTeamBlock` reads them back to the same block. */
export function renderStaffTeamBlock(block: StaffTeamBlock): string[] {
  const steps = CROSSWALK_STEPS.filter((step) => block.steps[step] !== undefined).map((step) => `${step}: ${block.steps[step]}`);
  return [
    'staff:',
    `  section: ${block.section}`,
    ...(block.profile ? [`  profile: ${block.profile}`] : []),
    ...(block.level ? [`  level: ${block.level}`] : []),
    ...(block.glyph ? [`  glyph: ${block.glyph}`] : []),
    ...(block.humanLead ? [`  human-lead: ${block.humanLead}`] : []),
    ...(steps.length ? [`  steps: { ${steps.join(', ')} }`] : []),
    ...(block.products.length ? [`  products: [${block.products.join(', ')}]`] : []),
    ...(block.layers.length ? [`  layers: [${block.layers.join(', ')}]`] : [])
  ];
}

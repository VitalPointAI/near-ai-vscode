// guard-scan: the release-guard's deterministic checks (design 10, 4.2, 6.2 and 7; WP-SHARED). Pure: no I/O, no clock, no vscode.
//
// The release-guard runs this first, so the last automated check before a person is not a single point of model judgement. Each rule either finds
// something the guard must hold for (`hold`: a classification or caveat marking of any shipped scale, a label above the template ceiling, a coordinate
// outside the exercise box, a name on the real-entity list, a decision written as made, personal data, a secret, a J4 number with no calculator record, a
// support product without its review mark) or something only a person can judge (`check`: a restricted publication named, a grid reference the scan
// cannot place). The staff-products tool refuses a CLEARED verdict while a `hold` finding stands on the exact version, so a guard cannot clear past it.
// What the scan cannot see (implicit decisions, compilation) is the guard model's review, and its HOLD is the answer to a doubt.
import { SCALE_PRESETS } from '../gate/labels';
import { findSecrets } from '../team/secrets';
import { RESTRICTED_PUBLICATION_TITLES } from './doctrine';
import type { StaffSectionId } from './doctrine';
import type { ProductHeader } from './products';
import { STAFF_MARKERS } from './products';

export const GUARD_RULES = [
  'marking', 'label-ceiling', 'outside-exercise-box', 'coordinates-without-box', 'unmarked-pair-outside-box', 'grid-reference', 'real-entity', 'restricted-title', 'decision-as-made',
  'personal-data', 'secret', 'number-without-calculation', 'review-mark-missing'
] as const;
export type GuardRule = (typeof GUARD_RULES)[number];
export type GuardSeverity = 'hold' | 'check';

export interface GuardFinding {
  readonly rule: GuardRule;
  readonly severity: GuardSeverity;
  /** 1-based line in the product body; 0 for the header. */
  readonly line: number;
  /** A short piece of the line, masked for personal data and secrets. */
  readonly excerpt: string;
  readonly message: string;
}

/** A polygon of [longitude, latitude] points, in order; the last point need not repeat the first. */
export type ExerciseBox = ReadonlyArray<readonly [number, number]>;

/** The project's guard settings, set by a person (`.planning/.near-ai/staff-guard.json`): the exercise box and the real-entity list. */
export interface GuardConfig {
  readonly exerciseBox?: ExerciseBox;
  /** Real units, people and bases the products must never name. */
  readonly realEntities: readonly string[];
  /**
   * The calculator record ids a product may cite: the host gives only those whose file matches a trusted entry in the calculator ledger (WP-LOG). When
   * given, a `calc:` reference to any other id is a finding.
   */
  readonly calculatorRecords?: ReadonlySet<string>;
  /** Record ids with a file the calculator ledger does not vouch for (no entry, or changed since), with the reason guard-scan shows. */
  readonly calculatorProblems?: ReadonlyMap<string, string>;
}

export interface GuardInput {
  readonly header?: ProductHeader;
  readonly body: string;
  readonly section: StaffSectionId;
  readonly owner: string;
  readonly config: GuardConfig;
}

export interface GuardScanResult {
  readonly findings: readonly GuardFinding[];
  /** Whether any finding is one the guard must hold for. */
  readonly hold: boolean;
}

/**
 * The template ceiling (design 10, 6 and 7): exercise and fictional data at org/Internal, NATO Unclassified or Protected A at most, whatever the device
 * allows. A scale not named here (the Canadian classified scale) has no level a staff template may carry.
 */
export const TEMPLATE_CEILING: Readonly<Record<string, string>> = { org: 'Internal', nato: 'NATO Unclassified', 'ca-protected': 'Protected A' };

/** How a member cites a calculator record next to a J4 number (design 10, 4.2: "numbers in J4 products with no calculator record"). */
export const CALC_REFERENCE = /\bcalc:([a-z0-9][a-z0-9-]{0,63})\b/g;

const EXCERPT = 80;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Level names that are also ordinary words match only in capitals, as a marking is written; the others match in any case. */
function levelPattern(level: string): RegExp {
  const words = level.split(/\s+/).map(escape).join('\\s+');
  return /NATO|Cosmic|Protected/i.test(level) ? new RegExp(`\\b${words}\\b`, 'i') : new RegExp(`\\b${words.toUpperCase()}\\b`);
}

/** Every level above the template ceiling on every shipped scale, as the marking it would be written as. */
function scaleMarkings(): Array<{ pattern: RegExp; name: string }> {
  const out: Array<{ pattern: RegExp; name: string }> = [];
  for (const [id, scale] of Object.entries(SCALE_PRESETS)) {
    const ceiling = Object.prototype.hasOwnProperty.call(TEMPLATE_CEILING, id) ? scale.levels.indexOf(TEMPLATE_CEILING[id]) : -1;
    scale.levels.forEach((level, index) => {
      if (index > ceiling) out.push({ pattern: levelPattern(level), name: `${scale.name}: ${level}` });
    });
  }
  return out;
}

// Control measures whose names start with a marking word and are not markings (JP 3-09 fire support coordination measures, JP 3-52 airspace).
const NOT_A_MARKING = /\bRESTRICTED\s+(?:FIRE|OPERATIONS|TARGETS?|AREA)\b/g;

/** Caveats and handling markings, and portion marks that cannot be a list label (a bare "(C)" or "(S)" is not matched). */
const CAVEATS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\bTOP\s+SECRET\b/, name: 'TOP SECRET' },
  { pattern: /\b(?:NOFORN|ORCON|RELIDO|LIMDIS|PROPIN|IMCON|FOUO|FVEY)\b/, name: 'handling caveat' },
  { pattern: /\bCUI\b/, name: 'CUI' },
  { pattern: /\b[A-Z]{2,5}\s+EYES\s+ONLY\b|\bEYES\s+ONLY\b/i, name: 'EYES ONLY' },
  { pattern: /\bREL\s+TO\b/, name: 'REL TO' },
  { pattern: /\((?:TS|CTS|NS|NC|NR|CUI|U\/\/FOUO)(?:\/\/[A-Z0-9 ,/-]+)?\)|\((?:S|C|R)\/\/[A-Z0-9 ,/-]+\)/, name: 'portion marking' },
  { pattern: /^\s*(?:TOP SECRET|SECRET|CONFIDENTIAL)(?:\/\/[A-Z0-9 ,/-]*)?\s*$/m, name: 'banner marking' }
];

const DECISION_STATED = [
  /\b(?:is|are|was|were|has been|have been|had been|been)\s+(?:now\s+|formally\s+|hereby\s+)?(approved|selected|released|decided|chosen)\b/i,
  /\b(?:commander|comd|chief of staff|cos|director|we|i)\s+(?:has\s+|have\s+|had\s+)?(?:now\s+)?(approved|selected|decided|released|chose|approves|selects|decides)\b/i
];
const DECISION_HEDGE = /\b(?:not|if|once|until|unless|when|whether|before|after|pending|awaiting|should|would|may|must|needs?|to be)\b/i;

const PERSONAL: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, name: 'an email address' },
  { pattern: /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, name: 'a phone number' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, name: 'a US social security number' },
  { pattern: /\b\d{3}[ -]\d{3}[ -]\d{3}\b(?![ -]\d)/, name: 'a Canadian social insurance number' },
  { pattern: /\b(?:date of birth|DOB)\s*[:=]/i, name: 'a date of birth' }
];

const QUANTITY = /\b\d[\d,]*(?:\.\d+)?\s*(?:litres?|liters?|L|gallons?|gal|short tons?|STON|tonnes?|tons?|t|kg|lbs?|rations?|meals?|MREs?|rounds?|rds|pallets?|vehicles?|trucks?|sorties|DOS|days? of supply|m3|cubic metres?|cubic meters?|beds?|units of blood)\b/i;

const DECIMAL_PAIR = /(?<![\d.[])(-?\d{1,2}\.\d{3,})\s*°?\s*([NS])?\s*[,;/ ]\s*(-?\d{1,3}\.\d{3,})\s*°?\s*([EW])?(?!\d|\.\d)/g;
/**
 * A latitude and longitude written to two decimals ("45.42, -75.69", about a kilometre). Short decimals are also money, versions, scores and measures, so
 * a pair counts only when it is separated by a comma, is not part of a longer number or a word (v1.25, $12.50, 12.50%), and is marked as a position: a
 * hemisphere letter, a minus sign or a degree sign: "51.10 N, 11.10 E", "51.10°, 11.10°" and "45.42, -75.69" are positions. An unmarked pair
 * ("12.50, 3.50") is not a position on its own; only when a person has set an exercise box does one that reads as a plausible latitude and longitude
 * outside the box go to the guard to check by hand (unmarkedPairsIn), and one inside the box passes.
 */
const TWO_DECIMAL_PAIR = /(?<![\w.[$€£¥]|\d,)(-?\d{1,2}\.\d{2})\s*(°)?\s*([NS])?\s*,\s*(-?\d{1,3}\.\d{2})\s*(°)?\s*([EW])?(?![\d%]|\.\d|\s*%)/g;
const GEOJSON_PAIR = /\[\s*(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,2}\.\d{3,})\s*\]/g;
const DMS_PAIR = /(\d{1,2})°\s*(\d{1,2})['′]\s*(?:(\d{1,2}(?:\.\d+)?)["″]\s*)?([NS])[,\s]+(\d{1,3})°\s*(\d{1,2})['′]\s*(?:(\d{1,2}(?:\.\d+)?)["″]\s*)?([EW])/g;
const MGRS = /\b\d{1,2}[C-HJ-NP-X]\s?[A-HJ-NP-Z]{2}\s?(?:\d{2}\s?\d{2}|\d{3}\s?\d{3}|\d{4}\s?\d{4}|\d{5}\s?\d{5})\b/;

function excerptOf(line: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const text = line.slice(start, Math.max(start + EXCERPT, index + length)).trim();
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT - 3)}...` : text;
}

function masked(value: string): string {
  return value.length <= 2 ? '**' : `${value.slice(0, 2)}${'*'.repeat(Math.min(12, value.length - 2))}`;
}

/** Whether a point is inside a polygon (ray casting; a point on an edge may fall either way, which a box drawn with a margin never meets). */
export function insidePolygon(point: readonly [number, number], polygon: ExerciseBox): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The [longitude, latitude] points written in one line: decimal pairs (latitude first), GeoJSON pairs (longitude first) and degrees-minutes-seconds. */
export function coordinatesIn(line: string): Array<{ point: [number, number]; index: number; text: string }> {
  const out: Array<{ point: [number, number]; index: number; text: string }> = [];
  const taken: Array<[number, number]> = [];
  const push = (lon: number, lat: number, index: number, text: string): void => {
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    if (taken.some(([from, to]) => index >= from && index < to)) return;
    taken.push([index, index + text.length]);
    out.push({ point: [lon, lat], index, text });
  };
  for (const match of line.matchAll(GEOJSON_PAIR)) push(Number(match[1]), Number(match[2]), match.index ?? 0, match[0]);
  for (const match of line.matchAll(DMS_PAIR)) {
    const deg = (d: string, m: string, s: string | undefined): number => Number(d) + Number(m) / 60 + Number(s ?? 0) / 3600;
    const lat = deg(match[1], match[2], match[3]) * (match[4] === 'S' ? -1 : 1);
    const lon = deg(match[5], match[6], match[7]) * (match[8] === 'W' ? -1 : 1);
    push(lon, lat, match.index ?? 0, match[0]);
  }
  for (const match of line.matchAll(DECIMAL_PAIR)) {
    const lat = Number(match[1]) * (match[2] === 'S' ? -1 : 1);
    const lon = Number(match[3]) * (match[4] === 'W' ? -1 : 1);
    push(lon, lat, match.index ?? 0, match[0]);
  }
  for (const match of twoDecimalPairs(line)) if (match.marked) push(match.point[0], match.point[1], match.index, match.text);
  return out;
}

/** Every two-decimal pair in a line, read latitude first, with whether it carries a position mark (hemisphere letter, minus sign or degree sign). */
function twoDecimalPairs(line: string): Array<{ point: [number, number]; index: number; text: string; marked: boolean }> {
  const out: Array<{ point: [number, number]; index: number; text: string; marked: boolean }> = [];
  for (const match of line.matchAll(TWO_DECIMAL_PAIR)) {
    const [, latText, latDegree, ns, lonText, lonDegree, ew] = match;
    const marked = ns !== undefined || ew !== undefined || latDegree !== undefined || lonDegree !== undefined || latText.startsWith('-') || lonText.startsWith('-');
    const lat = Number(latText) * (ns === 'S' ? -1 : 1);
    const lon = Number(lonText) * (ew === 'W' ? -1 : 1);
    out.push({ point: [lon, lat], index: match.index ?? 0, text: match[0], marked });
  }
  return out;
}

/** Words that present the numbers after them as a position (read in the few words before an unmarked pair). */
const POSITION_CUE = /\b(?:lat|lats|latitude|lon|long|lng|longitude|lat\/lon|lat\/long|grid|position|posn|pos|located|location|loc|at|near|coordinates?|coords?|waypoint|wpt|rally point|check ?point|objective|obj|rendezvous|rv|landing zone|lz|drop zone|dz|fix|plotted)\b[^.;:!?]{0,12}$/i;
/** Words that present the numbers next to them as money, scores or measures instead (read before the pair). */
const NOT_A_POSITION_BEFORE = /\b(?:prices?|priced|costs?|costing|fees?|budget|paid|pay|sold|bought|spent|totals?|subtotal|sum|amounts?|balance|rates?|ratios?|shares?|scores?|scored|results?|odds|averages?|avg|mean|marks?|grades?|ratings?|durations?|weights?|heights?|lengths?|distances?|speeds?|sizes?|measures?|measured|versions?)\b[^.;:!?]{0,24}$/i;
/** A unit or score word right after the pair that makes it a measure, not a position. */
const NOT_A_POSITION_AFTER = /^\s*(?:points?|pts|goals?|runs?|km|kms|m|mi|nm|nmi|ft|kg|kgs|g|lb|lbs|t|tonnes?|tons?|l|litres?|liters?|gal|hours?|hrs?|h|mins?|minutes?|secs?|seconds?|days?|weeks?|dollars?|cents?|cad|usd|eur|gbp|percent|per ?cent|each|apiece|ea|kph|km\/h|kts?|knots?|mph)\b/i;

/**
 * The unmarked two-decimal pairs in a line that read as a plausible latitude and longitude ([longitude, latitude] points): "Rally point 45.42, 75.69".
 * Money, scores and measures look the same ("12.50, 3.50"), so a pair counts only when it is presented as a position: a coordinate cue in the few words
 * before it (lat, lon, grid, position, located, at, rally point and the like), with no money, score or measure word before it and no unit or score word
 * after it. Guard-scan looks at them only against an exercise box a person set.
 */
export function unmarkedPairsIn(line: string): Array<{ point: [number, number]; index: number; text: string }> {
  return twoDecimalPairs(line)
    .filter((pair) => !pair.marked && Math.abs(pair.point[1]) <= 90 && Math.abs(pair.point[0]) <= 180)
    .filter((pair) => {
      const before = line.slice(Math.max(0, pair.index - 48), pair.index);
      const after = line.slice(pair.index + pair.text.length);
      if (NOT_A_POSITION_AFTER.test(after) || NOT_A_POSITION_BEFORE.test(before)) return false;
      return POSITION_CUE.test(before);
    })
    .map(({ point, index, text }) => ({ point, index, text }));
}

/** Runs every rule on a product. The findings are in line order, header first; `hold` is true when any of them is one the guard must hold for. */
export function guardScan(input: GuardInput): GuardScanResult {
  const findings: GuardFinding[] = [];
  const add = (rule: GuardRule, severity: GuardSeverity, line: number, excerpt: string, message: string): void => {
    findings.push({ rule, severity, line, excerpt, message });
  };

  if (input.header) {
    const [scale, level] = input.header.label.split('/');
    const ceiling = Object.prototype.hasOwnProperty.call(TEMPLATE_CEILING, scale) ? TEMPLATE_CEILING[scale] : undefined;
    const levels = Object.prototype.hasOwnProperty.call(SCALE_PRESETS, scale) ? SCALE_PRESETS[scale].levels : undefined;
    const allowed = ceiling !== undefined && levels !== undefined && levels.includes(level) && levels.indexOf(level) <= levels.indexOf(ceiling);
    if (!allowed) add('label-ceiling', 'hold', 0, input.header.label, `The product is labelled ${input.header.label}, above what a staff template may carry (org/Internal, NATO Unclassified or Protected A at most). Staff templates are for exercise and fictional data only.`);
  }

  const markings = scaleMarkings();
  const entities = input.config.realEntities.map((name) => name.trim()).filter((name) => name.length >= 2)
    .map((name) => ({ name, pattern: new RegExp(`(?<![\\w])${escape(name).replace(/\s+/g, '\\s+')}(?![\\w])`, 'i') }));
  const titles = RESTRICTED_PUBLICATION_TITLES.map((title) => ({ title, pattern: new RegExp(`(?<![\\w.-])${escape(title).replace(/\s+/g, '\\s+')}(?![\\w-]|\\.\\d)`, 'i') }));
  const j4 = input.section === 'j4';
  const lines = input.body.split(/\r?\n/);
  let inFence = false;

  lines.forEach((raw, index) => {
    const number = index + 1;
    if (/^\s*```/.test(raw)) inFence = !inFence;
    // A marking word inside a named control measure is not a marking.
    const line = raw.replace(NOT_A_MARKING, (text) => text.toLowerCase());

    for (const marking of [...markings, ...CAVEATS]) {
      const match = marking.pattern.exec(line);
      if (match) { add('marking', 'hold', number, excerptOf(raw, match.index, match[0].length), `The text carries a classification or caveat marking (${marking.name}). Staff products hold exercise and fictional data only.`); break; }
    }

    for (const found of coordinatesIn(raw)) {
      const box = input.config.exerciseBox;
      if (!box || box.length < 3) add('coordinates-without-box', 'hold', number, found.text, 'The text has a coordinate, and no exercise box is set for this project, so every coordinate counts as outside it. A person sets the box in .planning/.near-ai/staff-guard.json.');
      else if (!insidePolygon(found.point, box)) add('outside-exercise-box', 'hold', number, found.text, 'The coordinate is outside the project\'s exercise box.');
    }
    // With an exercise box set, an unmarked pair that could be a latitude and longitude outside it goes to the guard to check by hand (a review, not a
    // block); inside the box it passes, and with no box an unmarked pair is not a coordinate at all.
    const box = input.config.exerciseBox;
    if (box && box.length >= 3) {
      for (const pair of unmarkedPairsIn(raw)) {
        if (!insidePolygon(pair.point, box)) add('unmarked-pair-outside-box', 'check', number, pair.text, 'Two numbers that read as a latitude and longitude outside the exercise box. If they are a position, the product is outside the exercise; if they are money, scores or measures, say so and clear it.');
      }
    }
    const grid = MGRS.exec(raw);
    if (grid) add('grid-reference', 'check', number, grid[0], 'The text has a military grid reference, which guard-scan cannot place. Check by hand that it is inside the exercise box.');

    for (const entity of entities) {
      const match = entity.pattern.exec(raw);
      if (match) add('real-entity', 'hold', number, excerptOf(raw, match.index, match[0].length), `The text names "${entity.name}", which is on this project's list of real units, people and places.`);
    }
    for (const title of titles) {
      const match = title.pattern.exec(raw);
      if (match) add('restricted-title', 'check', number, excerptOf(raw, match.index, match[0].length), `The text names ${title.title}, which has no public copy. Check that the product cites it by title and edition only and quotes nothing from it.`);
    }

    if (!raw.includes(STAFF_MARKERS.decisionFor)) {
      for (const pattern of DECISION_STATED) {
        const match = pattern.exec(raw);
        if (!match) continue;
        const sentenceStart = Math.max(raw.lastIndexOf('. ', match.index) + 1, 0);
        if (DECISION_HEDGE.test(raw.slice(sentenceStart, match.index + match[0].length).replace(match[0], ' '))) continue;
        add('decision-as-made', 'hold', number, excerptOf(raw, match.index, match[0].length), `A decision is written as made ("${match[0]}"). Members recommend; write it as "${STAFF_MARKERS.decisionFor} <role>" with the options and their risk.`);
        break;
      }
    }

    for (const personal of PERSONAL) {
      const match = personal.pattern.exec(raw);
      if (match) add('personal-data', 'hold', number, masked(match[0]), `The text has what looks like ${personal.name}. Staff products hold no personal data.`);
    }
    if (findSecrets(raw).length) add('secret', 'hold', number, masked(raw.trim()), 'The text holds something that looks like a key, token or password.');

    if (j4 && !inFence) {
      const quantity = QUANTITY.exec(raw);
      const references = [...raw.matchAll(CALC_REFERENCE)].map((match) => match[1]);
      if (quantity && references.length === 0) {
        add('number-without-calculation', 'hold', number, excerptOf(raw, quantity.index, quantity[0].length), 'A J4 number has no calculator record. Put the calc:<id> of the record that produced it on the same line, so the formula can be shown.');
      }
      const known = input.config.calculatorRecords;
      const problems = input.config.calculatorProblems;
      for (const id of references) {
        const problem = problems?.get(id);
        if (problem !== undefined && !known?.has(id)) add('number-without-calculation', 'hold', number, `calc:${id}`, problem);
        else if (known && !known.has(id)) add('number-without-calculation', 'hold', number, `calc:${id}`, `calc:${id} names no calculator record in this project.`);
      }
    }
  });

  if (/legal/.test(input.owner) && !input.body.includes(STAFF_MARKERS.legalReview)) {
    add('review-mark-missing', 'hold', 0, input.owner, `A legal support product carries "${STAFF_MARKERS.legalReview}": a qualified person reviews it, and it is never legal advice.`);
  }
  if (/health|surgeon|medical/.test(input.owner) && !input.body.includes(STAFF_MARKERS.surgeonReview)) {
    add('review-mark-missing', 'hold', 0, input.owner, `A health services product carries "${STAFF_MARKERS.surgeonReview}": a qualified person reviews it, and it is never medical advice.`);
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings, hold: findings.some((finding) => finding.severity === 'hold') };
}

/** The scan as the plain text a member reads. */
export function guardScanText(result: GuardScanResult, hash: string): string {
  if (!result.findings.length) return `guard-scan found nothing on version hash ${hash}. Now review what rules cannot judge: implicit decisions and compilation.`;
  const lines = result.findings.map((finding, index) => `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.rule}${finding.line ? ` (line ${finding.line})` : ' (header)'}: ${finding.message} Text: "${finding.excerpt}"`);
  const verdict = result.hold
    ? 'At least one finding is a HOLD: give the verdict HOLD with these reasons. CLEARED is refused while a HOLD finding stands on this version.'
    : 'No finding is a HOLD; the CHECK items need your judgement before you give a verdict.';
  return [`guard-scan on version hash ${hash}:`, ...lines, verdict].join('\n');
}

// The J2 tradecraft gate's mechanical lint (design 10, 4.4 part 1; 02 T10; WP-SHARED). Pure: no I/O, no clock, no vscode.
//
// It checks what a rule can check of the ICD 203 analytic standards, so the tradecraft reviewer's judgement goes to what rules cannot (objectivity,
// alternatives, the key assumptions check). The staff-products tool refuses a SIGN-OFF while this lint has a finding on the exact version, so the
// mechanical part is blocking, as the design requires.
//
// Conventions the lint reads (the J2 members' instructions and the intel-workbench skeletons use them):
// - A key judgement is a bullet or numbered line under a heading that contains "judgement" or "judgment", or any sentence that starts "We assess" or
//   "We judge" (or "<section> assesses"). Each one says how likely, with an ICD 203 term, or how confident, and never both in one sentence.
// - A fact is a bullet under a heading that contains "situation", "significant activity", "facts" or "changes since", and cites at least one source as
//   `[src:<id>]`, an id in the source register.
// - The source register gives each source a reliability grade (A to F) and a credibility grade (1 to 6) in separate fields, an origin and its dates.
import {
  ICD203_CONFIDENCE_LEVELS, ICD203_LIKELIHOOD, NON_STANDARD_ESTIMATIVE_WORDS
} from './doctrine';
import type { RegisterRow } from './registers';

export const TRADECRAFT_RULES = [
  'judgement-unmarked', 'non-standard-likelihood', 'likelihood-and-confidence', 'fact-unsourced', 'unknown-source', 'source-grades', 'source-origin',
  'source-dates', 'same-origin-confirmation', 'pir-decision-point', 'pir-ltiov', 'hvt-not-in-coa', 'mlcoa-mdcoa'
] as const;
export type TradecraftRule = (typeof TRADECRAFT_RULES)[number];

export interface TradecraftFinding {
  readonly rule: TradecraftRule;
  /** 1-based line in the product body; 0 for a finding in a register. */
  readonly line: number;
  readonly message: string;
}

/**
 * One source as the lint reads it: an entry of the J2 source register (intel.ts SourceEntry, which the intel-workbench keeps), or of the `json
 * staff-sources` block a product carries.
 */
export interface LintSource {
  readonly id: string;
  readonly reliability?: string;
  readonly credibility?: string | number;
  readonly origin?: string;
  readonly published?: string;
  readonly accessed?: string;
}

export interface TradecraftInput {
  readonly body: string;
  /** The product's kind: an adversary COA set or an estimate must name both the MLCOA and the MDCOA. */
  readonly kind?: string;
  readonly sources?: readonly LintSource[];
  /** Rows of the PIR register (or the PIR part of the CCIR register). */
  readonly pirs?: readonly RegisterRow[];
  /** High-value targets and the adversary COAs they must appear in. */
  readonly hvts?: readonly string[];
  readonly adversaryCoas?: readonly string[];
}

const RELIABILITY = /^[A-F]$/;
const CREDIBILITY = /^[1-6]$/;
const SOURCE_REF = /\[src:([A-Za-z0-9][A-Za-z0-9._-]{0,39})\]/g;
const JUDGEMENT_HEADING = /judge?ment/i;
const FACT_HEADING = /situation|significant activity|facts|changes since/i;
const JUDGEMENT_SENTENCE = /^(?:\s*(?:[-*]|\d+[.)])\s*)?(?:we|the j-?2|j-?2|[a-z0-9-]+ section)\s+(?:assess(?:es)?|judge?s?)\b/i;
const CONFIRMATION = /\b(?:confirm(?:s|ed|ing)?|corroborat(?:e|es|ed|ing)|independent(?:ly)?)\b/i;
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+\S/;

/** Every ICD 203 term, longest first, so "very likely" is read before "likely" and "unlikely" never counts as "likely". */
const LIKELIHOOD_TERMS: readonly string[] = ICD203_LIKELIHOOD.flatMap((row) => [row.term, row.alternative, ...row.forms]).sort((a, b) => b.length - a.length);

function wordPattern(term: string): RegExp {
  return new RegExp(`(?<![\\w-])${term.replace(/\s+/g, '\\s+')}(?![\\w-])`, 'i');
}

/** The ICD 203 likelihood terms a sentence uses, each counted once, longer terms taking their words from shorter ones. */
export function likelihoodTermsIn(sentence: string): string[] {
  let rest = sentence;
  const found: string[] = [];
  for (const term of LIKELIHOOD_TERMS) {
    const pattern = wordPattern(term);
    if (pattern.test(rest)) {
      found.push(term);
      rest = rest.replace(new RegExp(pattern.source, 'gi'), ' ');
    }
  }
  return found;
}

function confidenceIn(sentence: string): string[] {
  return ICD203_CONFIDENCE_LEVELS.map((level) => `${level} confidence`).filter((level) => wordPattern(level).test(sentence));
}

function nonStandardIn(sentence: string): string[] {
  return NON_STANDARD_ESTIMATIVE_WORDS.filter((word) => wordPattern(word).test(sentence));
}

function sentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((part) => part.trim() !== '');
}

/** Runs every rule. Findings come in line order, then register findings. */
export function lintTradecraft(input: TradecraftInput): TradecraftFinding[] {
  const findings: TradecraftFinding[] = [];
  const add = (rule: TradecraftRule, line: number, message: string): void => { findings.push({ rule, line, message }); };
  const sources = new Map((input.sources ?? []).map((source) => [source.id, source]));
  const lines = input.body.split(/\r?\n/);
  let heading = '';
  let inFence = false;

  lines.forEach((line, index) => {
    const number = index + 1;
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const head = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (head) { heading = head[1]; return; }

    // Likelihood and confidence never share a sentence (ICD 203; 02 T10), anywhere in the product.
    for (const sentence of sentences(line)) {
      if (likelihoodTermsIn(sentence).length && confidenceIn(sentence).length) {
        add('likelihood-and-confidence', number, 'A sentence gives both a likelihood and a confidence level. Say how likely in one sentence and how confident in another.');
      }
    }

    const judgement = (JUDGEMENT_HEADING.test(heading) && LIST_ITEM.test(line)) || JUDGEMENT_SENTENCE.test(line);
    if (judgement) {
      const terms = likelihoodTermsIn(line);
      const confidence = confidenceIn(line);
      const loose = nonStandardIn(line);
      if (loose.length) add('non-standard-likelihood', number, `A key judgement uses "${loose.join('", "')}", which is not an ICD 203 term. Use one of: ${ICD203_LIKELIHOOD.map((row) => row.term).join(', ')}.`);
      else if (!terms.length && !confidence.length) add('judgement-unmarked', number, 'A key judgement says neither how likely (an ICD 203 term) nor how confident. Mark it as a judgement.');
    }

    const refs = [...line.matchAll(SOURCE_REF)].map((match) => match[1]);
    if (FACT_HEADING.test(heading) && LIST_ITEM.test(line) && !judgement && refs.length === 0) {
      add('fact-unsourced', number, 'A fact has no source. Cite it as [src:<id>] from the source register, or mark it as a judgement.');
    }
    for (const id of refs) if (input.sources && !sources.has(id)) add('unknown-source', number, `[src:${id}] is not in the source register.`);

    // Two reports from one origin are one report (02 T10): a line that counts them as confirming each other is wrong.
    if (CONFIRMATION.test(line) && refs.length >= 2) {
      const origins = refs.map((id) => sources.get(id)?.origin?.trim().toLowerCase()).filter((origin): origin is string => Boolean(origin));
      const seen = new Set<string>();
      for (const origin of origins) {
        if (seen.has(origin)) { add('same-origin-confirmation', number, `Sources cited as confirming each other share the origin "${origin}", so they are one report, not independent confirmation.`); break; }
        seen.add(origin);
      }
    }
  });

  for (const source of input.sources ?? []) {
    const reliability = String(source.reliability ?? '').trim();
    const credibility = String(source.credibility ?? '').trim();
    if (!RELIABILITY.test(reliability) || !CREDIBILITY.test(credibility)) {
      add('source-grades', 0, `Source ${source.id} needs a reliability grade (A to F) and a credibility grade (1 to 6), each in its own field.`);
    }
    if (!source.origin?.trim()) add('source-origin', 0, `Source ${source.id} has no origin, so its independence from other sources cannot be judged.`);
    if (!source.published?.trim() && !source.accessed?.trim()) add('source-dates', 0, `Source ${source.id} has no date (published or accessed).`);
  }

  for (const row of input.pirs ?? []) {
    if (row.type !== undefined && row.type !== 'pir') continue;
    if (row.decisionPoint === undefined || String(row.decisionPoint).trim() === '') add('pir-decision-point', 0, `PIR ${String(row.id)} is not tied to a decision point.`);
    if (row.ltiov === undefined || String(row.ltiov).trim() === '') add('pir-ltiov', 0, `PIR ${String(row.id)} has no latest time of value.`);
  }

  if (input.hvts?.length) {
    const coaText = (input.adversaryCoas ?? []).join('\n').toLowerCase();
    for (const hvt of input.hvts) if (!coaText.includes(hvt.trim().toLowerCase())) add('hvt-not-in-coa', 0, `HVT "${hvt}" appears in no adversary COA.`);
  }

  if (input.kind === 'adversary-coa-set' || input.kind === 'estimate') {
    const text = input.body.toLowerCase();
    const mlcoa = /\bmlcoa\b|most likely (?:adversary |enemy )?course of action/.test(text);
    const mdcoa = /\bmdcoa\b|most dangerous (?:adversary |enemy )?course of action/.test(text);
    if (!mlcoa || !mdcoa) add('mlcoa-mdcoa', 0, `The ${input.kind === 'estimate' ? 'estimate' : 'adversary COA set'} must name both the most likely (MLCOA) and the most dangerous (MDCOA) adversary course of action.`);
  }

  return findings.sort((a, b) => (a.line === 0 ? 1 : 0) - (b.line === 0 ? 1 : 0) || a.line - b.line);
}

/** The lint as the plain text a member reads. */
export function tradecraftLintText(findings: readonly TradecraftFinding[], hash: string): string {
  if (!findings.length) return `The tradecraft lint found nothing on version hash ${hash}. Now give your judgement on the analytic standards the lint cannot check.`;
  return [
    `The tradecraft lint on version hash ${hash}:`,
    ...findings.map((finding, index) => `${index + 1}. ${finding.rule}${finding.line ? ` (line ${finding.line})` : ''}: ${finding.message}`),
    'SIGN-OFF is refused while any of these stands on this version: give NOT READY with them as numbered fixes.'
  ].join('\n');
}

/**
 * Reads source entries from a JSON value (a list of objects); entries that are not objects with an id are left out. The source register's own field
 * names, reportedAt and accessedAt, are read as published and accessed.
 */
export function sourcesFrom(value: unknown): LintSource[] {
  if (!Array.isArray(value)) return [];
  const out: LintSource[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.trim() === '') continue;
    const text = (key: string): Record<string, string> => (typeof record[key] === 'string' || typeof record[key] === 'number' ? { [key]: String(record[key]) } : {});
    const date = (key: string, alias: string): Record<string, string> => { const value = text(key)[key] ?? text(alias)[alias]; return value === undefined ? {} : { [key]: value }; };
    out.push({ id: record.id.trim(), ...text('reliability'), ...text('credibility'), ...text('origin'), ...date('published', 'reportedAt'), ...date('accessed', 'accessedAt') });
  }
  return out;
}

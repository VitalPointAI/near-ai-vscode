// The orders rules (design 10, 2.3 and 6.2 `orders`; WP-ORD): the annex list of the profile, the consistency check over an order's annexes, the assembly
// of an order or plan from released staff products, and the FRAGO draft. Pure: no I/O, no clock, no vscode.
//
// A member never writes an annex letter from memory: the letter comes from the profile (doctrine.ts), and the check names any entry whose letter is not
// the profile's. An order is assembled only from products a person released, at the version released; a product with no owner, not released, or built
// on a source that has a newer approved version is named in the check and blocks assembly. The assembled order and every FRAGO are drafts: they go
// through the release state machine like any other product, and only a person releases them.
import { ANNEX_SUBJECTS, DOCTRINE_PROFILES, FRAGMENTARY_ORDER, ORDER_KINDS, ORDER_PARAGRAPHS } from './doctrine';
import type { AnnexPlacement, AnnexSubject, OrderKind, StaffProfileId } from './doctrine';
import type { LedgerReplay, ProductState } from './ledger';
import type { ReleaseState } from './release';

/** One annex as the caller (or the annex tracker) names it: the subject, and what it claims about letter, product and owner. */
export interface AnnexEntry {
  readonly subject: string;
  readonly letter?: string;
  readonly product?: string;
  readonly owner?: string;
}

/** What the check needs to know about a product, from the ledger: its state, version, owner, dependencies and whether the file matches. */
export interface OrderProductFacts {
  readonly state: ReleaseState;
  readonly version: number;
  readonly owner: string;
  readonly section: string;
  readonly dependsOn: ReadonlyArray<{ readonly product: string; readonly version: number }>;
  /** The newest version of this product a person approved, if any. */
  readonly latestApproved?: number;
  /** Why the ledger cannot vouch for it, when it cannot. */
  readonly tampered?: string;
}

export const ORDER_FINDINGS = [
  'unknown-subject', 'duplicate-subject', 'wrong-letter', 'not-lettered', 'missing-owner', 'owner-mismatch', 'unknown-product', 'not-released',
  'stale-dependency', 'tampered', 'parent-missing'
] as const;
export type OrderFindingKind = (typeof ORDER_FINDINGS)[number];

/** Findings that stop assembly. `parent-missing` (an appendix whose annex is not in the order) is reported but does not. */
export const BLOCKING_FINDINGS: readonly OrderFindingKind[] = ORDER_FINDINGS.filter((kind) => kind !== 'parent-missing');

export interface OrderFinding { readonly kind: OrderFindingKind; readonly subject: string; readonly message: string }

/** One annex as the profile files it. */
export interface ProfileAnnex { readonly subject: AnnexSubject; readonly placement: AnnexPlacement }

export function isAnnexSubject(value: string): value is AnnexSubject {
  return (ANNEX_SUBJECTS as readonly string[]).includes(value);
}

/** The profile's annex list, in the profile's subject order. */
export function profileAnnexes(profile: StaffProfileId): ProfileAnnex[] {
  return ANNEX_SUBJECTS.map((subject) => ({ subject, placement: DOCTRINE_PROFILES[profile].annexes[subject] }));
}

/** The letter under which a subject is filed: its own annex, or the annex it is an appendix to or part of. Undefined when the profile gives no letter. */
export function filedUnder(placement: AnnexPlacement): string | undefined {
  if (placement.kind === 'annex') return placement.letter;
  if (placement.kind === 'appendix') return placement.toAnnex;
  if (placement.kind === 'within') return placement.annex;
  return undefined;
}

export function orderKind(profile: StaffProfileId, id: string): OrderKind | undefined {
  return ORDER_KINDS[profile].find((kind) => kind.id === id);
}

/** Annex letters sort A to Z, then AA, BB and so on (the two-letter annexes follow the single ones). */
export function compareLetters(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

const describe = (placement: AnnexPlacement): string => {
  if (placement.kind === 'annex') return `Annex ${placement.letter} (${placement.title})`;
  if (placement.kind === 'appendix') return `an appendix to Annex ${placement.toAnnex}`;
  if (placement.kind === 'within') return `part of Annex ${placement.annex}`;
  return 'no letter in this profile';
};

/**
 * The consistency check over an order's annexes, against the profile and the ledger:
 *  - a subject the profile does not know, or named twice;
 *  - a letter that is not the one the profile files the subject under (the classic error: "Annex D" is logistics under US Joint, fires under US Army
 *    and intelligence under NATO/Canadian);
 *  - a subject the profile gives no letter (a person chooses it);
 *  - no owner (neither named nor recorded in the ledger), or a named owner the ledger disagrees with;
 *  - a product the ledger does not know, one not released, or one the ledger cannot vouch for;
 *  - a product built on a source that a person has since approved a newer version of (a stale dependency);
 *  - an appendix whose annex is not in the order (reported, not blocking).
 */
export function checkAnnexes(profile: StaffProfileId, entries: readonly AnnexEntry[], products: ReadonlyMap<string, OrderProductFacts>): OrderFinding[] {
  const findings: OrderFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: OrderFindingKind, subject: string, message: string) => findings.push({ kind, subject, message });
  const filed = new Set<string>();
  for (const entry of entries) {
    if (!isAnnexSubject(entry.subject)) {
      add('unknown-subject', entry.subject, `"${entry.subject.slice(0, 60)}" is not an annex subject. The subjects are ${ANNEX_SUBJECTS.join(', ')}.`);
      continue;
    }
    if (seen.has(entry.subject)) { add('duplicate-subject', entry.subject, `${entry.subject} is listed more than once; an order carries each subject once.`); continue; }
    seen.add(entry.subject);
    const placement = DOCTRINE_PROFILES[profile].annexes[entry.subject];
    const letter = filedUnder(placement);
    if (placement.kind === 'annex') filed.add(placement.letter);
    if (letter === undefined) {
      add('not-lettered', entry.subject, `${DOCTRINE_PROFILES[profile].name} gives ${entry.subject} no letter (${placement.kind === 'not-lettered' ? placement.note : ''}). A person decides where it goes; the letter is set in the profile, never written from memory.`);
    } else if (entry.letter !== undefined && entry.letter.trim().toUpperCase() !== letter) {
      add('wrong-letter', entry.subject, `${entry.subject} is ${describe(placement)} under ${DOCTRINE_PROFILES[profile].name}, not Annex ${entry.letter.trim().slice(0, 4)}. Take the letter from the profile.`);
    }
    const facts = entry.product === undefined ? undefined : products.get(entry.product);
    const owner = facts?.owner;
    if (entry.product !== undefined && facts === undefined) add('unknown-product', entry.subject, `${entry.product} is not a staff product in the ledger, so no person has released it.`);
    if (owner === undefined && (entry.owner === undefined || entry.owner.trim() === '')) {
      add('missing-owner', entry.subject, `${entry.subject} has no owner: name the member that writes it, and the product it is written in.`);
    } else if (owner !== undefined && entry.owner !== undefined && entry.owner.trim() !== owner) {
      add('owner-mismatch', entry.subject, `${entry.subject} names ${entry.owner.trim().slice(0, 64)} as owner, but ${entry.product} is owned by ${owner} in the ledger.`);
    }
    if (facts === undefined) continue;
    if (facts.tampered) { add('tampered', entry.subject, `${entry.product} cannot be used: ${facts.tampered}`); continue; }
    if (facts.state !== 'released') add('not-released', entry.subject, `${entry.product} version ${facts.version} is ${facts.state}, not released. An order is assembled only from products a person released.`);
    for (const dependency of facts.dependsOn) {
      const source = products.get(dependency.product);
      if (source?.latestApproved !== undefined && source.latestApproved > dependency.version) {
        add('stale-dependency', entry.subject, `${entry.product} is built on ${dependency.product}@${dependency.version}, but a person has approved ${dependency.product} version ${source.latestApproved} since. Its owner takes the change and it is released again first.`);
      }
    }
  }
  for (const entry of entries) {
    if (!isAnnexSubject(entry.subject)) continue;
    const placement = DOCTRINE_PROFILES[profile].annexes[entry.subject];
    const parent = placement.kind === 'appendix' ? placement.toAnnex : placement.kind === 'within' ? placement.annex : undefined;
    if (parent !== undefined && !filed.has(parent)) add('parent-missing', entry.subject, `${entry.subject} is ${describe(placement)}, and Annex ${parent} is not in this order; it is placed under an Annex ${parent} heading of its own.`);
  }
  return findings;
}

/** The newest version of a product a person approved, across its lines. */
function latestApproved(state: ProductState): number | undefined {
  const versions = [state, ...state.older].flatMap((line) => line.approvedVersions);
  return versions.length ? Math.max(...versions) : undefined;
}

/** What the check knows about every product in the ledger. */
export function productFacts(replay: LedgerReplay): Map<string, OrderProductFacts> {
  const facts = new Map<string, OrderProductFacts>();
  for (const [name, state] of replay.products) {
    const approved = latestApproved(state);
    facts.set(name, {
      state: state.record.state, version: state.record.version, owner: state.record.roles.owner, section: state.record.section, dependsOn: state.meta.dependsOn,
      ...(approved !== undefined ? { latestApproved: approved } : {}), ...(state.tampered ? { tampered: state.tampered } : {})
    });
  }
  return facts;
}

export function blocking(findings: readonly OrderFinding[]): OrderFinding[] {
  return findings.filter((finding) => BLOCKING_FINDINGS.includes(finding.kind));
}

/** One annex ready to assemble: its released text and where it came from. */
export interface AssemblyAnnex {
  readonly subject: AnnexSubject;
  readonly product: string;
  readonly version: number;
  readonly owner: string;
  readonly body: string;
}

export interface AssemblyInput {
  readonly profile: StaffProfileId;
  readonly kind: OrderKind;
  readonly title: string;
  /** The released base text (the CONOPS or the base plan), which holds the five paragraphs. */
  readonly base?: { readonly product: string; readonly version: number; readonly body: string };
  readonly annexes: readonly AssemblyAnnex[];
  readonly findings: readonly OrderFinding[];
}

/** A product body may hold its own staff header markers; the assembled order shifts its headings down so they sit under the annex heading. */
function nest(body: string, levels: number): string {
  const lines = body.replace(/\r\n/g, '\n').trim().split('\n');
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    const match = /^(#{1,6})(\s.*)$/.exec(line);
    return match ? `${'#'.repeat(Math.min(6, match[1].length + levels))}${match[2]}` : line;
  }).join('\n');
}

/** The paragraph headings of the profile's format that the base text does not have, in order. */
export function missingParagraphs(profile: StaffProfileId, body: string): string[] {
  return ORDER_PARAGRAPHS[profile].filter((paragraph) => !new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\d\\.\\s*)?(?:\\(U\\)\\s*)?${paragraph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'im').test(body));
}

/**
 * The assembled order or plan: a title, the base text (or the five paragraph headings, each an open item), the annex list with each annex's letter
 * from the profile, its source product and version and its owner, each annex's released text under its heading (appendices and parts under the annex
 * that holds them), and the open items. It is a draft for the release state machine.
 */
export function assembleOrder(input: AssemblyInput): string {
  const profile = DOCTRINE_PROFILES[input.profile];
  const paragraphs = ORDER_PARAGRAPHS[input.profile];
  const open: string[] = input.findings.map((finding) => finding.message);
  const out: string[] = [`# ${input.kind.abbreviation}: ${input.title}`, ''];
  out.push(`${input.kind.name}, ${profile.name} format. Assembled by the orders tool from released staff products; annex letters from the profile (${profile.annexSource}). This is a draft: it goes through the release guard, and only a person releases it.`, '');
  if (input.base) {
    out.push(`Base text: ${input.base.product}@${input.base.version}.`, '', nest(input.base.body, 1), '');
    for (const paragraph of missingParagraphs(input.profile, input.base.body)) open.push(`The base text has no paragraph "${paragraph}".`);
  } else {
    paragraphs.forEach((paragraph, index) => out.push(`## ${index + 1}. ${paragraph}`, '', 'Not yet written.', ''));
    open.push(`No base text: the five paragraphs (${paragraphs.join(', ')}) are not yet written.`);
  }
  // Group by the letter the profile files each subject under; the annex itself first, then its appendices and parts.
  const groups = new Map<string, Array<{ annex: AssemblyAnnex; placement: AnnexPlacement }>>();
  for (const annex of input.annexes) {
    const placement = profile.annexes[annex.subject];
    const letter = filedUnder(placement);
    if (letter === undefined) continue;
    groups.set(letter, [...(groups.get(letter) ?? []), { annex, placement }]);
  }
  const letters = [...groups.keys()].sort(compareLetters);
  const titleOf = (letter: string): string => {
    const own = Object.values(profile.annexes).find((placement) => placement.kind === 'annex' && placement.letter === letter);
    return own && own.kind === 'annex' ? own.title : '';
  };
  out.push('## Annexes', '');
  if (!letters.length) out.push('No annexes yet.', '');
  for (const letter of letters) {
    for (const { annex, placement } of groups.get(letter)!) {
      const where = placement.kind === 'annex' ? `Annex ${letter} (${placement.title})` : `${placement.kind === 'appendix' ? 'Appendix to' : 'Part of'} Annex ${letter}: ${annex.subject}`;
      out.push(`- ${where}: ${annex.product}@${annex.version}, owner ${annex.owner}.`);
    }
  }
  if (letters.length) out.push('');
  for (const letter of letters) {
    const members = [...groups.get(letter)!].sort((a, b) => (a.placement.kind === 'annex' ? 0 : 1) - (b.placement.kind === 'annex' ? 0 : 1));
    const title = titleOf(letter);
    out.push(`## Annex ${letter}${title ? `: ${title}` : ''}`, '');
    for (const { annex, placement } of members) {
      if (placement.kind !== 'annex') out.push(`### ${placement.kind === 'appendix' ? 'Appendix' : 'Part'}: ${annex.subject}`, '');
      out.push(`Source: ${annex.product}@${annex.version}, owner ${annex.owner}, released.`, '', nest(annex.body, placement.kind === 'annex' ? 2 : 3), '');
    }
  }
  out.push('## Open items', '', ...(open.length ? open.map((item) => `- ${item}`) : ['None.']), '');
  return out.join('\n');
}

/** The five paragraphs a FRAGO changes; any left out reads "No change." */
export interface FragoChanges { readonly [paragraph: string]: string | undefined }

export interface FragoInput {
  readonly profile: StaffProfileId;
  readonly number: number;
  readonly title: string;
  /** The released order it changes. */
  readonly base: { readonly product: string; readonly version: number; readonly kind: string };
  /** Changes per paragraph, by the paragraph's position (1 to 5) in the profile's format. */
  readonly changes: ReadonlyArray<string | undefined>;
}

/** The FRAGO draft: it names the order it changes and gives the changes only, in the five-paragraph format; the rest reads "No change." */
export function fragoBody(input: FragoInput): string {
  const abbreviation = FRAGMENTARY_ORDER.abbreviation[input.profile];
  const paragraphs = ORDER_PARAGRAPHS[input.profile];
  const out = [`# ${abbreviation} ${input.number} to ${input.base.kind} ${input.base.product}@${input.base.version}: ${input.title}`, ''];
  out.push(`${FRAGMENTARY_ORDER.definition} This is a draft: it goes through the release guard, and only a person releases it. Nothing is sent, issued or executed by the tool.`, '');
  paragraphs.forEach((paragraph, index) => {
    const change = input.changes[index]?.trim();
    out.push(`## ${index + 1}. ${paragraph}`, '', change ? change : 'No change.', '');
  });
  return out.join('\n');
}

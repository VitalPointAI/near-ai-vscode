// A team's own knowledge graph: what it has learned, kept apart per team, so a team becomes more useful the more it works (owner, 2026-11-08: "each team
// needs to learn over time and have its own shared context graph of knowledge ... extracting nodes (actors), edges (relationships or links), functions, and
// tensions (relative strength of the edges or relationships both positive and negative)").
//
// The model is deliberately small and plain, because it is written by agents and read by people:
//   node      an actor: an organisation, a person, a system, a document, a fact, a place, a product.
//   function  what an actor does or provides, in its own words ("issues certification", "signs contracts").
//   edge      how two actors relate, with a KIND (supplies, certifies, regulates, contradicts, depends-on...) and a TENSION.
//   tension   the strength of a relation on a signed scale: -1 hostile or contradictory, 0 neutral, +1 strongly supportive. A relation with no measured
//             strength is null, not 0, so "unknown" and "neutral" stay distinguishable.
//   grading   the Admiralty scale for the evidence behind a node or an edge: source reliability A-F and information credibility 1-6. Agents are told to
//             grade what they add, and ungraded knowledge is marked as such rather than trusted.
//
// Pure: no I/O, no clock unless passed in.
import { createHash } from 'node:crypto';

/** Which side of the graph an entry came from, so a person can see whether it was researched or told to the team. */
export type KnowledgeOrigin = 'research' | 'interaction' | 'document' | 'seed';

export type NodeKind = 'actor' | 'person' | 'organisation' | 'system' | 'document' | 'fact' | 'place' | 'product' | 'event';

/**
 * The Admiralty grading of a piece of evidence: how reliable the source is, and how credible the information is. A is a completely reliable source and 1
 * is confirmed by other sources; F is unreliable and 6 is impossible. Kept as two fields rather than one score because they answer different questions.
 */
export interface Grading { reliability: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'; credibility: 1 | 2 | 3 | 4 | 5 | 6 }

/**
 * One belief about an actor. `status` is why it is in `facts` or in `history`: a current belief, one that later evidence refuted, or one that simply became
 * out of date (a price changed, a name was updated).
 */
export interface KnowledgeFact {
  text: string;
  origin: KnowledgeOrigin;
  grading?: Grading;
  source?: string;
  /** When it became known, ISO. History entries keep this, so the timeline survives a refutation. */
  since?: string;
  /** Why it left `facts`. Only history entries carry it. */
  refutedBy?: string;
  /** When it left `facts`, ISO. Only history entries carry it. */
  refutedAt?: string;
}

export interface KnowledgeNode {
  /** A stable key, derived from the label so the same actor mentioned twice is one node. */
  id: string;
  label: string;
  kind: NodeKind;
  /** What this actor does or provides, each a short phrase. */
  functions: string[];
  /**
   * What is CURRENTLY believed about it, one sentence each, with where it came from. A knowledge graph accumulates, but it also learns: a fact that later
   * evidence refutes moves to `history` rather than staying here as if it were still true (owner, 2026-11-08). Nothing is ever deleted outright, because a
   * decision was made on it and may need to be revisited.
   */
  facts: KnowledgeFact[];
  /**
   * Facts that were believed once and are not any more, with why and when. Kept so a person can see what a decision rested on at the time, and so the team
   * does not re-learn a refuted claim as new.
   */
  history?: KnowledgeFact[];
  origin: KnowledgeOrigin;
  grading?: Grading;
  /** When it was first and last written, ISO. */
  firstSeen: string;
  lastSeen: string;
  /** How many separate additions mentioned it, which is a rough measure of how central it is. */
  mentions: number;
}

export type EdgeKind = 'supplies' | 'certifies' | 'regulates' | 'funds' | 'employs' | 'partners' | 'competes' | 'depends-on' | 'contradicts' | 'supports' | 'owns' | 'reports-to' | 'related';

export interface KnowledgeEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** -1 to 1, or null when the strength has not been measured. Null is not zero. */
  tension: number | null;
  /** Why the relation is believed, one sentence. */
  basis?: string;
  origin: KnowledgeOrigin;
  grading?: Grading;
  lastSeen: string;
  mentions: number;
}

/** Words that say nothing about WHAT is claimed, so they do not count when judging whether two sentences are about the same thing. */
const STOP_WORDS = new Set(['the', 'and', 'was', 'were', 'has', 'had', 'have', 'been', 'being', 'for', 'from', 'with', 'that', 'this', 'its', 'their', 'they', 'it', 'are', 'but', 'about', 'into', 'over', 'than', 'then', 'also']);

/**
 * Whether a new statement REFUTES an old one about the same actor. A contradiction is hard to detect in general, so this recognises the two shapes an agent
 * actually writes when it corrects something: a negation (`does not`, `no longer`, `isn't`) whose remainder is otherwise the same claim, and the same claim with
 * a different figure in it (`4.2 million` against `3.1 million`). Everything else accumulates, because a false refutation would destroy real knowledge.
 */
function isContradicted(oldText: string, newText: string): boolean {
  const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s.%]/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  const oldWords = new Set(words(oldText));
  const newWords = new Set(words(newText));
  const negation = /\b(?:not|no longer|never|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|cannot|can't|ceased|stopped|ended)\b/i;
  const newNegates = negation.test(newText) && !negation.test(oldText);
  const oldNegates = negation.test(oldText) && !negation.test(newText);
  // The same claim, with one of them negated: the shared vocabulary must dominate, or two unrelated sentences about one actor would "contradict".
  const shared = [...newWords].filter((word) => oldWords.has(word)).length;
  const overlap = shared / Math.max(1, Math.min(oldWords.size, newWords.size));
  if ((newNegates || oldNegates) && overlap >= 0.6) return true;
  // The same claim with a different figure: `4.2 million TEU` becomes `3.1 million TEU`. Both must carry a number and share the rest.
  const numbers = (text: string): string[] => text.match(/\d+(?:\.\d+)?/g) ?? [];
  const oldNumbers = numbers(oldText);
  const newNumbers = numbers(newText);
  // Both must share real WORDS too, not just a shape: `function-0-0` and `function-1-0` differ by a number but are not a correction of each other, and
  // treating them as one retired real entries (found by the accumulation test).
  if (oldNumbers.length && newNumbers.length && shared >= 2 && overlap >= 0.6) {
    const differ = oldNumbers.some((value) => !newNumbers.includes(value)) || newNumbers.some((value) => !oldNumbers.includes(value));
    if (differ) return true;
  }
  return false;
}

/**
 * Moves a fact from what is believed to the record of what was believed. Nothing is deleted: a decision may have been made on it, and a person revisiting that
 * decision needs to see what the team knew at the time (owner, 2026-11-08).
 */
function retire(node: KnowledgeNode, fact: KnowledgeFact, refutedBy: string, at: string): void {
  node.facts = node.facts.filter((entry) => entry !== fact);
  node.history = [...(node.history ?? []), { ...fact, refutedBy, refutedAt: at }];
}

export interface TeamKnowledge {
  version: 1;
  /** The team slug this belongs to; a team's graph never mixes with another's. */
  team: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  updatedAt: string;
  /**
   * Why the file this came from could not be read, when it could not. A damaged graph is rebuilt from empty and the problem travels with it, so the person is
   * told instead of the corruption disappearing (0.4.19 review). Never written to disk.
   */
  problem?: string;
}

/** What an agent proposes to add: the raw shape, before it is merged, which is what makes adding idempotent. */
export interface KnowledgeAddition {
  nodes: Array<{ label: string; kind?: NodeKind; functions?: string[]; facts?: Array<{ text: string; source?: string; grading?: Grading; since?: string }>; grading?: Grading }>;
  edges: Array<{ from: string; to: string; kind?: EdgeKind; tension?: number | null; basis?: string; grading?: Grading }>;
  origin: KnowledgeOrigin;
  /** When it was learned, ISO; passed in so the merge is deterministic. */
  at: string;
}

/** A stable id for a label, so "Halden Ports" and "halden ports" are one node. */
export function nodeId(label: string): string {
  const cleaned = label.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(cleaned).digest('hex').slice(0, 12);
}

const edgeId = (from: string, to: string, kind: EdgeKind): string => `${from}~${kind}~${to}`;

/**
 * Whether a source is an address on the web rather than a named document. The scheme is optional, because `evil.test/about` and `https://evil.test/about`
 * are the same thing to a reader. Lives here rather than in the tool because the merge must apply the same test: a grade must not become uncapped just
 * because it arrived through `addKnowledge` instead of `Learn` (0.4.19 review).
 */
export function looksLikeAddress(source: string): boolean {
  // 0.4.19 review: a homoglyph or an invisible character in the host was enough to keep an A1, because the test only knew ASCII dots.
  const text = source.normalize('NFKC')
    .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, '')
    .replace(/[\u3002\uFF0E\uFF61]/g, '.')
    // An obfuscator can write the dot in words or brackets, or hang the host off an address (`contact@evil.test`, which browsers do resolve); all are pages.
    .replace(/\[(?:[.·]|dot)\]|\((?:[.]|dot)\)|\{[.]\}/gi, '.')
    .trim();
  if (/https?:\/\//i.test(text)) return true;
  // Fifth 0.4.19 review suggested requiring a scheme, a path or a known TLD here, so a dotted DOCUMENT name (`annual-report.pdf`) is not treated as a page.
  // The suggestion is declined deliberately: any dotted bare host counts as a page, which is the conservative direction — it can only CAP a grade or REFUSE
  // a revival, never raise one — and the repo's own tests lock in bare `evil.test` as a page. A named document wrongly capped keeps its history entry and a
  // wrongly-refused revival can return with a differently-worded source; the reverse error would let a page claim A1. Over-catching is the cheap mistake.
  //
  // The one carve-out is SHAPE, stated once and locked by tests (eighth, ninth and eleventh 0.4.19 reviews): among two-label dotted tokens, one that ends in
  // a NUMBER is a figure or version — `4.2`, `v2.1` — the independent evidence a revival may cite, never a page. A two-label token ending in letters stays a
  // page (`evil.test`, `annual-report.pdf`). A three-or-more-label all-numeric token is an IPv4-style address and stays a page (`192.0.2.1`, `10.0.0/report`).
  // EVERY dotted token in the text is judged (eleventh 0.4.19 review, BLOCKER): matching only the first let `1.0 evil.test/about` read as the figure `1.0`
  // and keep a hostile page at A1 — a page is a page wherever in the sentence it hides, so any page-shaped token decides true. The left boundary is a
  // LOOKBEHIND, not a consumed character: a consumed boundary ate the space between `1.0` and the page that followed, and the second token never matched.
  // QUOTES are boundaries on both sides (fourteenth 0.4.19 review, BLOCKER): `see "evil.test/about"` hid behind an unconsumed quotation mark and kept A1,
  // and a quoted page even counted as independent evidence and revived a refuted claim. A sentence-final DOT is a boundary too (fifteenth 0.4.19 review,
  // MAJOR): at the end of a sentence `evil.test.` hides behind the period and keeps A1, so the trailing lookahead reads it as a boundary, not a label.
  let sawFigure = false;
  for (const match of `${text} `.matchAll(/(?<=^|[\s([<,;:@'"])([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?=[/?#]|$|[\s)\],;:'".])/gi)) {
    const labels = match[1]!.split('.');
    if (labels.length === 2 && /^\d+$/.test(labels[1]!)) { sawFigure = true; continue; } // a figure or version, judged on its own
    return true; // a two-label host, an address-shaped token, or anything longer: a page
  }
  return false; // every dotted token was a figure — or there was none
}

/** The grade a claim about something an agent READ is worth: C3 at most, whichever shape it arrives in. */
export function capForWebSource(grading: Grading): Grading {
  const rank = ['A', 'B', 'C', 'D', 'E', 'F'];
  const reliability = rank.indexOf(grading.reliability) < rank.indexOf('C') ? 'C' : grading.reliability;
  return { reliability, credibility: (grading.credibility < 3 ? 3 : grading.credibility) as Grading['credibility'] };
}

/**
 * The weaker of two grades, axis by axis. A grade may only ever go DOWN as the graph is merged: a later addition that arrives without the web cap must not
 * launder an earlier capped grade back up to A1 (0.4.19 review).
 */
function weakerGrade(a: Grading, b: Grading): Grading {
  const rank = ['A', 'B', 'C', 'D', 'E', 'F'];
  return {
    reliability: rank.indexOf(a.reliability) >= rank.indexOf(b.reliability) ? a.reliability : b.reliability,
    credibility: (a.credibility >= b.credibility ? a.credibility : b.credibility) as Grading['credibility']
  };
}

/** The full Admiralty rank, shared by every comparison of two grades. */
const ADMIRALTY = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Whether a claim stands at least as strong as the belief it contradicts, on BOTH axes, over the FULL rank (fourth 0.4.19 review): comparing against a
  * truncated A-C rank made indexOf return -1 for a D, E or F — which compares below everything and let a D1 claim retire an A1 fact, the exact opposite
  * of what the gate exists for. */
const atLeastAsStrong = (incoming: Grading, outgoing: Grading): boolean =>
  ADMIRALTY.indexOf(incoming.reliability) <= ADMIRALTY.indexOf(outgoing.reliability) && incoming.credibility <= outgoing.credibility;

/** A tension outside -1 to 1 is clamped rather than rejected: an agent that says 2 means "very strong". */
export function clampTension(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(-1, Math.min(1, value));
}

/**
 * The same fact stated twice in one addition, kept once, and with its source: the first mention may have none and the second one may, so a plain
 * "first wins" or "last wins" both lose a source. An agent's own duplicate should never cost it the citation.
 */
function dedupeFacts(facts: ReadonlyArray<{ text: string; source?: string; grading?: Grading; since?: string }>): Array<{ text: string; source?: string; grading?: Grading; since?: string }> {
  const byText = new Map<string, { text: string; source?: string; grading?: Grading; since?: string }>();
  for (const fact of facts) {
    const key = fact.text.trim().toLowerCase();
    const known = byText.get(key);
    if (!known) { byText.set(key, { text: fact.text, ...(fact.grading ? { grading: fact.grading } : {}), ...(fact.since ? { since: fact.since } : {}), ...(fact.source ? { source: fact.source } : {}) }); continue; }
    if (!known.source && fact.source) known.source = fact.source;
    if (!known.grading && fact.grading) known.grading = fact.grading;
  }
  return [...byText.values()];
}

export const emptyKnowledge = (team: string, at: string): TeamKnowledge => ({ version: 1, team, nodes: [], edges: [], updatedAt: at });

/**
 * A fact's source as text. A source that is not a string (an object `{url: ...}`, a number) used to be dropped by the tool, which left the fact looking
 * unsourced and therefore uncapped: a bag of JSON carried an address and kept an A1 (0.4.19 review). The text is also what the address test reads.
 */
export function sourceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') { try { return JSON.stringify(value) ?? ''; } catch { return ''; } }
  return String(value);
}

/** Whether anything an agent gave as a source or basis is an address on the web, whatever its shape. */
export function webSourced(value: unknown): boolean {
  return looksLikeAddress(sourceText(value));
}

/** The grade a claim is stored with: the one claimed, capped when the evidence behind it is something the agent read on the web. */
function gradeFor(claimed: Grading | undefined, fromWeb: boolean): Grading | undefined {
  if (!claimed) return undefined;
  return fromWeb ? capForWebSource(claimed) : claimed;
}

/**
 * Merges what an agent learned into the team's graph. Adding the same thing twice does not duplicate it: a node is keyed by its label, so a second
 * mention adds its facts (without repeating one already there), a mention count, and a later `lastSeen`. An edge is keyed by its two ends and its kind,
 * and a measured tension replaces an unmeasured one but never the other way round, so a later vague mention cannot erase a measured strength.
 */
export function mergeKnowledge(base: TeamKnowledge, addition: KnowledgeAddition): TeamKnowledge {
  const nodes = new Map(base.nodes.map((node) => [node.id, { ...node, functions: [...node.functions], facts: node.facts.map((fact) => ({ ...fact })) }]));
  const labelToId = new Map(base.nodes.map((node) => [node.label.trim().toLowerCase(), node.id]));
  for (const incoming of addition.nodes) {
    const label = incoming.label.trim();
    if (!label) continue;
    const id = labelToId.get(label.toLowerCase()) ?? nodeId(label);
    labelToId.set(label.toLowerCase(), id);
    // The cap is applied HERE, not only in the tool, so no path into the merge (a direct addKnowledge call, a replayed addition) can store a web-sourced
    // claim above C3. The node's own label counts as a source too: `https://evil.test` as an actor's NAME is as much a page the agent read as a fact
    // source is, and there are no facts to look at in that case (0.4.19 review). An UNSOURCED fact is judged like an unsourced relation (tenth 0.4.19
    // review, MAJOR): omitting `source` was a way to keep an A1 on a page's claim — an unsourced fact arrives capped, UNLESS the origin is an interaction,
    // the one path where a person, not a page, is the witness. Facts may also carry their OWN grade (a raced migration's legacy graph), which the
    // node-level cap below must not raise.
    const fromWeb = looksLikeAddress(label) || (incoming.facts ?? []).some((fact) => webSourced(fact.source));
    // The NODE's grade is judged on the actor itself — its label and whether the addition cites pages — not on whichever fact happens to be examined first
    // (eleventh 0.4.19 review, MAJOR): a research node citing a named register keeps its own grade while its unsourced facts individually arrive capped.
    const grading = gradeFor(incoming.grading, fromWeb || looksLikeAddress(label));
    const factGrading = (fact: { grading?: Grading; source?: string }): Grading | undefined => {
      if (fact.grading) return gradeFor(fact.grading, fact.source !== undefined && webSourced(fact.source));
      return gradeFor(incoming.grading, looksLikeAddress(label) || (fact.source !== undefined && webSourced(fact.source)) || (addition.origin !== 'interaction' && fact.source === undefined));
    };
    const existing = nodes.get(id);
    if (!existing) {
      nodes.set(id, {
        id, label, kind: incoming.kind ?? 'actor', functions: [...new Set(incoming.functions ?? [])],
        // A new actor's facts are deduplicated too: an agent that states the same fact twice in one addition should not store it twice.
        facts: dedupeFacts(incoming.facts ?? []).map((fact) => ({ text: fact.text, origin: addition.origin, ...(fact.since ? { since: fact.since } : { since: addition.at }), ...(fact.source ? { source: fact.source } : {}), ...(factGrading(fact) ? { grading: factGrading(fact) } : {}) })),
        origin: addition.origin, ...(grading ? { grading } : {}), firstSeen: addition.at, lastSeen: addition.at, mentions: 1
      });
      continue;
    }
    // Functions accumulate, but a function that REPLACES an older one supersedes it rather than piling up beside it. There is no ceiling: the graph is meant
    // to accumulate, and a silent truncation would make a team forget what it learned (owner, 2026-11-08).
    for (const fn of incoming.functions ?? []) if (!existing.functions.includes(fn)) existing.functions.push(fn);
    for (const incomingFact of incoming.facts ?? []) {
      const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
      const text = normalise(incomingFact.text);
      // Already believed: fill in what is missing, and strengthen nothing.
      const known = existing.facts.find((old) => normalise(old.text) === text);
      if (known) {
        if (!known.source && incomingFact.source) known.source = incomingFact.source;
        // The known fact's OWN grade falls too (fourth 0.4.19 review, MINOR; widened eighth 0.4.19 review, MAJOR): the node-level fall below did not touch
        // it, so a mention from a capped page left the stored fact at its original A1 even as the actor's grade dropped — and an addition that declares NO
        // grade but cites the page left the fact at A1 outright. A web-sourced mention of an already-believed fact lowers that fact's grade to the cap
        // whenever the cap is the weaker, whatever the addition declared.
        if (incomingFact.source && webSourced(incomingFact.source) && known.grading) known.grading = weakerGrade(known.grading, capForWebSource(known.grading));
        else if (grading && known.grading) known.grading = weakerGrade(known.grading, grading);
        else if (grading && !known.grading && incomingFact.source && webSourced(incomingFact.source)) known.grading = gradeFor(grading, true);
        else if (!known.grading && addition.origin !== 'interaction' && !incomingFact.source) known.grading = grading ?? capForWebSource({ reliability: 'A', credibility: 1 });
        continue;
      }
      // Already refuted: an echo — the same claim again, with no source of its own — is not re-learned, because a team that read a retraction should not
      // forget that it did. A re-assertion that carries independent evidence (a source that is not a page the agent read) is new information though, and
      // it moves the entry back out of history: believed again, dated from the re-assertion, with its grading as the revival's strength (0.4.19 review).
      const refuted = (existing.history ?? []).find((old) => normalise(old.text) === text);
      if (refuted) {
        const revived = Boolean(incomingFact.source) && !webSourced(incomingFact.source);
        if (!revived) continue;
        // The revival is independent evidence, so what the claim contradicts NOW may be the out-of-date side. The same evidence gate applies: a revival
        // retires a current belief only when it stands at least as strong (0.4.19 review).
        for (const current of [...existing.facts]) {
          if (!isContradicted(current.text, incomingFact.text)) continue;
          const incoming = grading ?? (existing.grading ? undefined : { reliability: 'C' as const, credibility: 3 as const });
          if (!current.grading || (incoming !== undefined && atLeastAsStrong(incoming, current.grading))) retire(existing, current, incomingFact.source ? `${incomingFact.text} (${incomingFact.source})` : incomingFact.text, addition.at);
        }
        existing.history = (existing.history ?? []).filter((old) => old !== refuted);
        existing.facts.push({ text: incomingFact.text, origin: addition.origin, ...(incomingFact.since ? { since: incomingFact.since } : { since: addition.at }), ...(incomingFact.source ? { source: incomingFact.source } : {}), ...(factGrading(incomingFact) ? { grading: factGrading(incomingFact) } : {}) });
        continue;
      }
      // A contradiction: the incoming fact names the same actor and says the opposite. The clear case is a `not` or `no longer`, which is how an agent
      // states a refutation in one sentence; the general case is left to `supersedes` below. Retirement is gated on EVIDENCE STRENGTH (second 0.4.19
      // review, MAJOR): a graded contradiction retires a current fact only when it is at least as credible as what stands — a hostile page capped to C3
      // must not push an A1 the team verified out of current belief — and an ungraded contradiction never retires a graded one. Web-sourced claims arrive
      // here already capped, so the gate is what stops a page refuting alone.
      // Every contradicting belief is retired, not just the first match (seventh 0.4.19 review, MINOR): two current beliefs that both contradict the claim
      // would otherwise leave the second standing beside it as still-true.
      const contradicted = existing.facts.filter((old) => isContradicted(old.text, incomingFact.text));
      for (const contradicts of contradicted) {
        const outgoing = contradicts.grading;
        // The claim's EFFECTIVE grade decides (twelfth 0.4.19 review, MINOR): a fact carrying its own stronger grade — a migrated legacy fact — must not be
        // judged at the node's weaker one, or the gate retires knowledge it should not. An UNGRADED current belief is not free to take either (thirteenth
        // 0.4.19 review, MINOR): it still needs the contradiction to stand at C3 — the standard an unsourced claim arrives at — so a page claim cannot
        // retire what a person vouched for just because nobody graded it yet.
        const incoming = factGrading(incomingFact) ?? (existing.grading ? undefined : { reliability: 'C' as const, credibility: 3 as const });
        if (incoming !== undefined && (!outgoing || atLeastAsStrong(incoming, outgoing))) {
          const why = incomingFact.source ? `${incomingFact.text} (${incomingFact.source})` : incomingFact.text;
          retire(existing, contradicts, why, addition.at);
        }
      }
      existing.facts.push({ text: incomingFact.text, origin: addition.origin, ...(incomingFact.since ? { since: incomingFact.since } : { since: addition.at }), ...(incomingFact.source ? { source: incomingFact.source } : {}), ...(factGrading(incomingFact) ? { grading: factGrading(incomingFact) } : {}) });
    }
    // A later grade can only LOWER the stored one. Replacing it outright let a second addition that named no source ("a document", or nothing at all)
    // restore an A1 over a grade the first addition had already capped to C3 (0.4.19 review).
    if (grading) existing.grading = existing.grading ? weakerGrade(existing.grading, grading) : grading;
    existing.lastSeen = addition.at;
    existing.mentions += 1;
  }
  const edges = new Map(base.edges.map((edge) => [edge.id, { ...edge }]));
  // Whether an actor's side of a relation was researched from a page. Declared once for the whole merge (second 0.4.19 review, MINOR): an end can GAIN a web
  // source in this same addition, and an edge touched by such an actor must be re-capped below even if the edge itself was not mentioned again.
  const webEnd = (node: KnowledgeNode | undefined): boolean => Boolean(node && (looksLikeAddress(node.label) || node.facts.some((fact) => webSourced(fact.source))));
  for (const incoming of addition.edges) {
    const from = labelToId.get(incoming.from.trim().toLowerCase());
    const to = labelToId.get(incoming.to.trim().toLowerCase());
    // An edge whose ends are not in the graph (neither before nor in this addition) is dropped rather than kept dangling.
    if (!from || !to || from === to) continue;
    const kind = incoming.kind ?? 'related';
    const id = edgeId(from, to, kind);
    const tension = clampTension(incoming.tension);
    // Same cap, same reason: a named basis is not evidence that the relation was not read off a page, so an address anywhere in the basis caps it, and a
    // relation with no basis at all is capped too. An end that was itself researched from a page caps it as well, whichever end, in either direction
    // (0.4.19 review).
    const grading = gradeFor(incoming.grading, incoming.basis === undefined || webSourced(incoming.basis) || webEnd(nodes.get(from)) || webEnd(nodes.get(to)));
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, { id, from, to, kind, tension, ...(incoming.basis ? { basis: incoming.basis } : {}), origin: addition.origin, ...(grading ? { grading } : {}), lastSeen: addition.at, mentions: 1 });
      continue;
    }
    if (existing.tension === null && tension !== null) existing.tension = tension;
    if (!existing.basis && incoming.basis) existing.basis = incoming.basis;
    if (grading) existing.grading = existing.grading ? weakerGrade(existing.grading, grading) : grading;
    existing.lastSeen = addition.at;
    existing.mentions += 1;
  }
  // An actor that gained a web-sourced fact in THIS addition re-caps the grades of every relation it touches (second 0.4.19 review, MINOR): the edge loop
  // re-grades an edge only when the same edge is mentioned again, so without this pass an edge could stay A1 while its end had just been revealed as a page.
  // weakerGrade keeps the stronger side, so the pass only ever lowers. The ACTORS are re-capped too (seventh 0.4.19 review, MAJOR): an addition that declares
  // no grading of its own used to leave an A1 node untouched while page-sourced facts piled onto it — an actor whose knowledge includes what it merely read
  // cannot claim the top grade overall, whichever addition carried the page in. The pass runs every merge, so it also heals graph states an earlier version
  // wrote before these caps existed.
  for (const node of nodes.values()) {
    if (node.grading && webEnd(node)) node.grading = weakerGrade(node.grading, capForWebSource(node.grading));
  }
  for (const edge of edges.values()) {
    if (!edge.grading) continue;
    if (webEnd(nodes.get(edge.from)) || webEnd(nodes.get(edge.to))) edge.grading = weakerGrade(edge.grading, capForWebSource(edge.grading));
  }
  // DELIBERATE: there is NO ceiling on nodes or relations. A knowledge graph is meant to accumulate, and a silent truncation makes a team forget what it
  // learned. Something no longer being true is recorded by supersession (see retire), not by deletion, so the record grows as the team's knowledge does
  // (owner, 2026-11-08). The dangling-relation filter is the ONE deliberate exception, and it is about integrity, not memory: an edge whose endpoint is gone
  // names nothing, renders nowhere, and would lie about who relates to whom — the file keeps the record honest rather than keeping a pointer to nothing.
  // (Fourteenth 0.4.19 review, MINOR.)
  const allNodes = [...nodes.values()];
  const keptIds = new Set(allNodes.map((node) => node.id));
  return { version: 1, team: base.team, nodes: allNodes, edges: [...edges.values()].filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to)), updatedAt: addition.at };
}

/** The relations of one node, in both directions, for the detail card and for the animation that highlights them. */
export function neighbours(graph: TeamKnowledge, id: string): Array<{ edge: KnowledgeEdge; other: KnowledgeNode; direction: 'out' | 'in' }> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const found: Array<{ edge: KnowledgeEdge; other: KnowledgeNode; direction: 'out' | 'in' }> = [];
  for (const edge of graph.edges) {
    if (edge.from === id) { const other = byId.get(edge.to); if (other) found.push({ edge, other, direction: 'out' }); continue; }
    if (edge.to === id) { const other = byId.get(edge.from); if (other) found.push({ edge, other, direction: 'in' }); }
  }
  return found;
}

/** How much of the graph is graded, so a person can see whether to trust it as a whole. */
export function gradingCoverage(graph: TeamKnowledge): { nodes: number; edges: number; gradedNodes: number; gradedEdges: number } {
  return {
    nodes: graph.nodes.length, edges: graph.edges.length,
    gradedNodes: graph.nodes.filter((node) => node.grading !== undefined).length,
    gradedEdges: graph.edges.filter((edge) => edge.grading !== undefined).length
  };
}

/** The strongest relations first, which is what a person usually wants to see before reading anything else. */
export function strongestEdges(graph: TeamKnowledge, limit = 10): Array<{ edge: KnowledgeEdge; from: KnowledgeNode; to: KnowledgeNode }> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges
    .filter((edge) => edge.tension !== null)
    .map((edge) => ({ edge, from: byId.get(edge.from), to: byId.get(edge.to) }))
    .filter((entry): entry is { edge: KnowledgeEdge; from: KnowledgeNode; to: KnowledgeNode } => Boolean(entry.from && entry.to))
    .sort((a, b) => Math.abs(b.edge.tension ?? 0) - Math.abs(a.edge.tension ?? 0))
    .slice(0, limit);
}

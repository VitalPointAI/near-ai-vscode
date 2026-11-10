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

// A known trade in the number rule above: `handled 4.2 million TEU in 2025` then `handled 5.1 million TEU in 2026` reads as a correction and retires the
// first, although both may be true. It is kept because the reverse error leaves two figures standing as current with nothing saying which one holds; the
// retired fact stays in history and a sourced re-assertion brings it back. Pinned by a test.

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
   * Why the file this came from could not be read, when it could not. A damaged graph is set aside and rebuilt from empty, and the problem travels with it so
   * the person is told. Never written to disk.
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

/** The full Admiralty reliability rank, best first. */
const ADMIRALTY = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * The most an agent's own say-so is worth: C3, "fairly reliable, possibly true".
 *
 * An agent writes the graph, and an agent that has read a hostile page can be steered into writing whatever that page wants, including the grade and a
 * source that does not look like a page at all ("the official registry"). No test of the source text can tell those apart, so the grade an agent can store is
 * capped whatever it cites. Only a person (`interaction`) can record a grade above it. An agent can still grade BELOW the ceiling (D5, F6), which is
 * information worth keeping.
 */
export const AGENT_CEILING: Grading = { reliability: 'C', credibility: 3 };

/** The weaker of two grades, axis by axis. */
function weakerGrade(a: Grading, b: Grading): Grading {
  return {
    reliability: ADMIRALTY.indexOf(a.reliability) >= ADMIRALTY.indexOf(b.reliability) ? a.reliability : b.reliability,
    credibility: (a.credibility >= b.credibility ? a.credibility : b.credibility) as Grading['credibility']
  };
}

/** The grade a claim may be stored with, given who wrote it: what was claimed, capped at AGENT_CEILING unless a person wrote it. */
export function withinCeiling(grading: Grading | undefined, origin: KnowledgeOrigin): Grading | undefined {
  if (!grading) return undefined;
  return origin === 'interaction' ? grading : weakerGrade(grading, AGENT_CEILING);
}

/** Ungraded evidence is the weakest there is, so it can never outweigh a graded belief. */
const UNGRADED: Grading = { reliability: 'F', credibility: 6 };

/** Whether a claim stands at least as strong as the belief it would retire, on BOTH axes. Ungraded counts as the weakest grade. */
const atLeastAsStrong = (incoming: Grading | undefined, outgoing: Grading | undefined): boolean => {
  const a = incoming ?? UNGRADED;
  const b = outgoing ?? UNGRADED;
  return ADMIRALTY.indexOf(a.reliability) <= ADMIRALTY.indexOf(b.reliability) && a.credibility <= b.credibility;
};

/**
 * The same graph with every grade an agent wrote held to AGENT_CEILING. A graph written before the ceiling existed (0.4.18) can hold an agent's A1; it is
 * brought down when it is read and when it is merged, so no stored grade outranks the rule however old the file is. Pure: returns a copy.
 */
export function heldToCeiling(graph: TeamKnowledge): TeamKnowledge {
  const fact = (entry: KnowledgeFact): KnowledgeFact => {
    const grading = withinCeiling(entry.grading, entry.origin);
    return { ...entry, ...(grading ? { grading } : {}) };
  };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const grading = withinCeiling(node.grading, node.origin);
      return { ...node, functions: [...node.functions], facts: node.facts.map(fact), ...(node.history ? { history: node.history.map(fact) } : {}), ...(grading ? { grading } : {}) };
    }),
    edges: graph.edges.map((edge) => {
      const grading = withinCeiling(edge.grading, edge.origin);
      return { ...edge, ...(grading ? { grading } : {}) };
    })
  };
}

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
    const key = normalise(fact.text);
    const known = byText.get(key);
    if (!known) { byText.set(key, { text: fact.text, ...(fact.grading ? { grading: fact.grading } : {}), ...(fact.since ? { since: fact.since } : {}), ...(fact.source ? { source: fact.source } : {}) }); continue; }
    if (!known.source && fact.source) known.source = fact.source;
    if (!known.grading && fact.grading) known.grading = fact.grading;
  }
  return [...byText.values()];
}

const normalise = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

export const emptyKnowledge = (team: string, at: string): TeamKnowledge => ({ version: 1, team, nodes: [], edges: [], updatedAt: at });

/**
 * A fact's source as text. A source that is not a string (an object `{url: ...}`, a number) used to be dropped by the tool, which lost the citation; it is
 * flattened to text instead so the person reading the graph can still see where the claim came from.
 */
export function sourceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') { try { return JSON.stringify(value) ?? ''; } catch { return ''; } }
  return String(value);
}

/**
 * Merges what an agent learned into the team's graph. Adding the same thing twice does not duplicate it: a node is keyed by its label, so a second
 * mention adds its facts (without repeating one already there), a mention count, and a later `lastSeen`. An edge is keyed by its two ends and its kind,
 * and a measured tension replaces an unmeasured one but never the other way round, so a later vague mention cannot erase a measured strength.
 *
 * Trust is two rules, applied here so every path into the graph obeys them:
 *   - the ceiling: nothing an agent writes is stored above AGENT_CEILING (see withinCeiling), and an older graph is brought under it first;
 *   - grades only fall: a later mention can lower a stored grade, never raise it, so a second path cannot launder a grade back up. A mention lowers it by
 *     what it CLAIMS, so an agent that grades a fact D5 lowers it to D5, while an agent repeating a fact a person verified at A1 leaves it at A1: the
 *     ceiling limits what an agent can store, not what a person decided.
 *
 * Belief changes without deleting anything (owner, 2026-11-08): a fact a later claim contradicts moves to the actor's `history` with why and when, but only
 * when the new claim is at least as strong as what it retires, so a weaker claim cannot push a stronger belief out. An unsourced echo of a refuted fact is not
 * re-learned; a re-assertion that cites a source brings it back.
 */
export function mergeKnowledge(base: TeamKnowledge, addition: KnowledgeAddition): TeamKnowledge {
  const start = heldToCeiling(base);
  const nodes = new Map(start.nodes.map((node) => [node.id, node]));
  const labelToId = new Map(start.nodes.map((node) => [node.label.trim().toLowerCase(), node.id]));
  const stored = (fact: { text: string; source?: string; since?: string }, grading: Grading | undefined): KnowledgeFact =>
    ({ text: fact.text, origin: addition.origin, since: fact.since ?? addition.at, ...(fact.source ? { source: fact.source } : {}), ...(grading ? { grading } : {}) });
  for (const incoming of addition.nodes) {
    const label = incoming.label.trim();
    if (!label) continue;
    const id = labelToId.get(label.toLowerCase()) ?? nodeId(label);
    labelToId.set(label.toLowerCase(), id);
    const grading = withinCeiling(incoming.grading, addition.origin);
    // A fact carries its own grade when it has one, and the actor's otherwise; either way within the ceiling when it is stored new.
    const factGrading = (fact: { grading?: Grading }): Grading | undefined => withinCeiling(fact.grading ?? incoming.grading, addition.origin);
    const existing = nodes.get(id);
    if (!existing) {
      nodes.set(id, {
        id, label, kind: incoming.kind ?? 'actor', functions: [...new Set(incoming.functions ?? [])],
        facts: dedupeFacts(incoming.facts ?? []).map((fact) => stored(fact, factGrading(fact))),
        origin: addition.origin, ...(grading ? { grading } : {}), firstSeen: addition.at, lastSeen: addition.at, mentions: 1
      });
      continue;
    }
    for (const fn of incoming.functions ?? []) if (!existing.functions.includes(fn)) existing.functions.push(fn);
    for (const incomingFact of dedupeFacts(incoming.facts ?? [])) {
      const text = normalise(incomingFact.text);
      const claimed = factGrading(incomingFact);
      // Already believed: fill in a missing source, and let the grade only fall.
      const known = existing.facts.find((old) => normalise(old.text) === text);
      if (known) {
        if (!known.source && incomingFact.source) known.source = incomingFact.source;
        const said = incomingFact.grading ?? incoming.grading;
        if (said) known.grading = known.grading ? weakerGrade(known.grading, said) : claimed;
        continue;
      }
      // Already refuted: an echo with no source of its own is not re-learned, because a team that read a retraction should not forget that it did.
      const refuted = (existing.history ?? []).find((old) => normalise(old.text) === text);
      if (refuted && !incomingFact.source) continue;
      // A new claim, or a refuted one re-asserted with a source. Whatever current belief it contradicts is retired, but only by a claim at least as strong.
      const why = incomingFact.source ? `${incomingFact.text} (${incomingFact.source})` : incomingFact.text;
      for (const current of existing.facts.filter((old) => isContradicted(old.text, incomingFact.text))) {
        if (atLeastAsStrong(claimed, current.grading)) retire(existing, current, why, addition.at);
      }
      if (refuted) existing.history = (existing.history ?? []).filter((old) => old !== refuted);
      existing.facts.push(stored(incomingFact, claimed));
    }
    if (incoming.grading) existing.grading = existing.grading ? weakerGrade(existing.grading, incoming.grading) : grading;
    existing.lastSeen = addition.at;
    existing.mentions += 1;
  }
  const edges = new Map(start.edges.map((edge) => [edge.id, edge]));
  for (const incoming of addition.edges) {
    const from = labelToId.get(incoming.from.trim().toLowerCase());
    const to = labelToId.get(incoming.to.trim().toLowerCase());
    // An edge whose ends are not in the graph (neither before nor in this addition) is dropped rather than kept dangling.
    if (!from || !to || from === to) continue;
    const kind = incoming.kind ?? 'related';
    const id = edgeId(from, to, kind);
    const tension = clampTension(incoming.tension);
    const grading = withinCeiling(incoming.grading, addition.origin);
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, { id, from, to, kind, tension, ...(incoming.basis ? { basis: incoming.basis } : {}), origin: addition.origin, ...(grading ? { grading } : {}), lastSeen: addition.at, mentions: 1 });
      continue;
    }
    if (existing.tension === null && tension !== null) existing.tension = tension;
    if (!existing.basis && incoming.basis) existing.basis = incoming.basis;
    if (incoming.grading) existing.grading = existing.grading ? weakerGrade(existing.grading, incoming.grading) : grading;
    existing.lastSeen = addition.at;
    existing.mentions += 1;
  }
  // There is NO ceiling on the number of nodes or relations, deliberately (owner, 2026-11-08): a graph is meant to accumulate, and a silent truncation makes a
  // team forget what it learned. The one exception is integrity, not memory: an edge whose end is gone names nothing and is dropped.
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

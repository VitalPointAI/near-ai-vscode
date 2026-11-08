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

export interface KnowledgeNode {
  /** A stable key, derived from the label so the same actor mentioned twice is one node. */
  id: string;
  label: string;
  kind: NodeKind;
  /** What this actor does or provides, each a short phrase. */
  functions: string[];
  /** What is known about it, one sentence each, with where it came from. */
  facts: Array<{ text: string; origin: KnowledgeOrigin; grading?: Grading; source?: string }>;
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

export interface TeamKnowledge {
  version: 1;
  /** The team slug this belongs to; a team's graph never mixes with another's. */
  team: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  updatedAt: string;
}

/** What an agent proposes to add: the raw shape, before it is merged, which is what makes adding idempotent. */
export interface KnowledgeAddition {
  nodes: Array<{ label: string; kind?: NodeKind; functions?: string[]; facts?: Array<{ text: string; source?: string }>; grading?: Grading }>;
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

/** A tension outside -1 to 1 is clamped rather than rejected: an agent that says 2 means "very strong". */
export function clampTension(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(-1, Math.min(1, value));
}

/**
 * The same fact stated twice in one addition, kept once, and with its source: the first mention may have none and the second one may, so a plain
 * "first wins" or "last wins" both lose a source. An agent's own duplicate should never cost it the citation.
 */
function dedupeFacts(facts: ReadonlyArray<{ text: string; source?: string }>): Array<{ text: string; source?: string }> {
  const byText = new Map<string, { text: string; source?: string }>();
  for (const fact of facts) {
    const key = fact.text.trim().toLowerCase();
    const known = byText.get(key);
    if (!known) { byText.set(key, { text: fact.text, ...(fact.source ? { source: fact.source } : {}) }); continue; }
    if (!known.source && fact.source) known.source = fact.source;
  }
  return [...byText.values()];
}

export const emptyKnowledge = (team: string, at: string): TeamKnowledge => ({ version: 1, team, nodes: [], edges: [], updatedAt: at });

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
    const existing = nodes.get(id);
    if (!existing) {
      nodes.set(id, {
        id, label, kind: incoming.kind ?? 'actor', functions: [...new Set(incoming.functions ?? [])],
        // A new actor's facts are deduplicated too: an agent that states the same fact twice in one addition should not store it twice.
        facts: dedupeFacts(incoming.facts ?? []).map((fact) => ({ text: fact.text, origin: addition.origin, ...(fact.source ? { source: fact.source } : {}), ...(incoming.grading ? { grading: incoming.grading } : {}) })),
        origin: addition.origin, ...(incoming.grading ? { grading: incoming.grading } : {}), firstSeen: addition.at, lastSeen: addition.at, mentions: 1
      });
      continue;
    }
    for (const fn of incoming.functions ?? []) if (!existing.functions.includes(fn)) existing.functions.push(fn);
    for (const incomingFact of incoming.facts ?? []) {
      // Deduplicated against the graph AND against what this same addition already added, so one Learn that mentions a fact twice stores it once.
      const known = existing.facts.find((old) => old.text.trim().toLowerCase() === incomingFact.text.trim().toLowerCase());
      if (known) { if (!known.source && incomingFact.source) known.source = incomingFact.source; continue; }
      existing.facts.push({ text: incomingFact.text, origin: addition.origin, ...(incomingFact.source ? { source: incomingFact.source } : {}), ...(incoming.grading ? { grading: incoming.grading } : {}) });
    }
    if (incoming.grading) existing.grading = incoming.grading;
    existing.lastSeen = addition.at;
    existing.mentions += 1;
  }
  const edges = new Map(base.edges.map((edge) => [edge.id, { ...edge }]));
  for (const incoming of addition.edges) {
    const from = labelToId.get(incoming.from.trim().toLowerCase());
    const to = labelToId.get(incoming.to.trim().toLowerCase());
    // An edge whose ends are not in the graph (neither before nor in this addition) is dropped rather than kept dangling.
    if (!from || !to || from === to) continue;
    const kind = incoming.kind ?? 'related';
    const id = edgeId(from, to, kind);
    const tension = clampTension(incoming.tension);
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, { id, from, to, kind, tension, ...(incoming.basis ? { basis: incoming.basis } : {}), origin: addition.origin, ...(incoming.grading ? { grading: incoming.grading } : {}), lastSeen: addition.at, mentions: 1 });
      continue;
    }
    if (existing.tension === null && tension !== null) existing.tension = tension;
    if (!existing.basis && incoming.basis) existing.basis = incoming.basis;
    if (incoming.grading) existing.grading = incoming.grading;
    existing.lastSeen = addition.at;
    existing.mentions += 1;
  }
  return { version: 1, team: base.team, nodes: [...nodes.values()], edges: [...edges.values()], updatedAt: addition.at };
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

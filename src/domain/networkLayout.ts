// Where the nodes of a team's knowledge graph go on a drawing (owner, 2026-11-08: "visualize its context graph in an interactive network graph ... see
// suitable animations depicting all its relationships, additional detail cards, admiralty of sources").
//
// The layout is deterministic on purpose: the same graph always draws the same way, so a person can learn where things are and a screenshot means
// something. Nodes are placed in rings by how connected they are (the most connected at the centre), and each ring is spread evenly, which needs no
// simulation and cannot jitter between renders.
//
// Pure: no DOM, no clock.
import type { TeamKnowledge } from './teamKnowledge';

export interface PlacedNode { id: string; label: string; x: number; y: number; radius: number; ring: number; degree: number; kind: string }
export interface PlacedEdge { id: string; from: string; to: string; kind: string; tension: number | null; width: number; positive: boolean; neutral: boolean }
export interface NetworkLayout { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[]; rings: number }

/**
 * Lays the graph out in rings. Radius grows with how many relations a node has, so an actor everything touches is visibly bigger, and the edge's width
 * grows with the absolute tension, so the strongest relations are the ones that catch the eye. An unmeasured relation is drawn thin and dashed by the
 * page, never as a weak one.
 */
export function layoutNetwork(graph: TeamKnowledge, options: { width?: number; height?: number } = {}): NetworkLayout {
  const width = options.width ?? 720;
  const height = options.height ?? 520;
  const centreX = width / 2;
  const centreY = height / 2;
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const ordered = [...graph.nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label));
  const count = ordered.length;
  if (!count) return { width, height, nodes: [], edges: [], rings: 0 };
  // Ring sizes: 1 at the centre, then 6, then 12, then the rest, which keeps labels from crowding at small sizes.
  const capacities = [1, 6, 12, Math.max(12, count)];
  const rings: string[][] = [];
  let at = 0;
  for (const capacity of capacities) {
    if (at >= count) break;
    rings.push(ordered.slice(at, at + capacity).map((node) => node.id));
    at += capacity;
  }
  const maxRadius = Math.min(width, height) / 2 - 46;
  const ringStep = rings.length > 1 ? maxRadius / rings.length : 0;
  const degreeMax = Math.max(1, ...degree.values());
  const nodes: PlacedNode[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  rings.forEach((ids, ringIndex) => {
    const ringRadius = ringIndex === 0 ? 0 : ringStep * ringIndex;
    ids.forEach((id, indexInRing) => {
      const node = byId.get(id);
      if (!node) return;
      const angle = ids.length === 1 ? 0 : (indexInRing / ids.length) * Math.PI * 2 - Math.PI / 2;
      const links = degree.get(id) ?? 0;
      nodes.push({
        id, label: node.label,
        x: Math.round(centreX + Math.cos(angle) * ringRadius),
        y: Math.round(centreY + Math.sin(angle) * ringRadius),
        // 5 to 11 pixels: big enough for the most connected actor to stand out, small enough to leave room for labels.
        radius: 5 + Math.round((links / degreeMax) * 6),
        ring: ringIndex, degree: links, kind: node.kind
      });
    });
  });
  const edges: PlacedEdge[] = graph.edges.map((edge) => ({
    id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, tension: edge.tension,
    width: edge.tension === null ? 1 : 1 + Math.abs(edge.tension) * 3,
    positive: edge.tension !== null && edge.tension > 0,
    neutral: edge.tension === null
  }));
  return { width, height, nodes, edges, rings: rings.length };
}

/**
 * What the page highlights when a node is selected: the node, everything it touches, and the relations in between. The rest is dimmed rather than hidden,
 * so the shape of the whole graph is still visible while one part is examined.
 */
export function highlight(layout: NetworkLayout, id: string | null): { nodes: Set<string>; edges: Set<string> } | undefined {
  if (!id) return undefined;
  const nodes = new Set<string>([id]);
  const edges = new Set<string>();
  for (const edge of layout.edges) {
    if (edge.from === id) { nodes.add(edge.to); edges.add(edge.id); }
    else if (edge.to === id) { nodes.add(edge.from); edges.add(edge.id); }
  }
  return { nodes, edges };
}

/** The order the highlight spreads in, so the page can animate the relations in one after another. */
export function highlightOrder(layout: NetworkLayout, id: string): Array<{ edgeId: string; otherId: string; delayMs: number }> {
  const found = layout.edges
    .filter((edge) => edge.from === id || edge.to === id)
    .map((edge) => ({ edgeId: edge.id, otherId: edge.from === id ? edge.to : edge.from, tension: Math.abs(edge.tension ?? 0) }))
    .sort((a, b) => b.tension - a.tension || a.edgeId.localeCompare(b.edgeId));
  // The strongest relation is drawn first, 60ms apart, so the eye follows strength rather than geometry.
  return found.map((entry, index) => ({ edgeId: entry.edgeId, otherId: entry.otherId, delayMs: index * 60 }));
}

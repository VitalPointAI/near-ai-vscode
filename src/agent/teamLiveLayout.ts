// Where each card of the Team Live view goes (0.4.28). Pure: no DOM, no I/O. The page multiplies these slots by its card size, and the tests check the
// shape rather than the drawing.
//
// The algorithm is the simple "tidy tree" of Wetherell and Shannon (1979, "Tidy drawings of trees", IEEE Transactions on Software Engineering 5(5)), in
// the subtree-width form the research for this view chose: a post-order pass gives every subtree a width (one slot for a leaf, the sum of its children's
// widths otherwise), and a pre-order pass lays each subtree's children side by side from its left edge and centres the parent over its first and last
// child. Every card has the same width, so packing subtrees by width (rather than by contour, as Reingold and Tilford 1981 and Buchheim, Junger and
// Leipert 2002 do, the algorithm behind d3-hierarchy's tree()) never overlaps two cards; it can only leave some extra room beside a narrow subtree, which a
// team of at most 12 members can afford. No code was taken from any of them.
//
// The tree holds the lead and the team's members only: those are known before the run starts, so their places never change while it runs. Agents that
// are not members ("guests") are not part of it: the page lists them in a band under the tree, in the order they appeared, so a new one never moves a card.

export interface TreeItem {
  id: string;
  /** The item this one hangs under; missing, unknown, or itself: a root. */
  parent?: string;
}

export interface TreePlace {
  id: string;
  /** The centre of the card, in slots from the left edge (a slot is one card plus its gap). */
  x: number;
  /** Rows from the top (the lead is 0). */
  depth: number;
}

export interface TreeLayout {
  places: TreePlace[];
  /** Slots across and rows down the whole drawing. */
  width: number;
  rows: number;
  /** Depth-first order with each item's depth: the narrow view's indented list, and the keyboard order. */
  order: Array<{ id: string; depth: number }>;
}

/** Lays the items out as a tidy tree, roots side by side in the order given, children in the order given. Every item is placed exactly once. */
export function tidyTree(items: TreeItem[]): TreeLayout {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const item of items) {
    if (children.has(item.id)) continue;
    children.set(item.id, []);
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.parent && item.parent !== item.id && ids.has(item.parent)) children.get(item.parent)!.push(item.id);
    else roots.push(item.id);
  }
  // A loop (a reports to b reports to a) reaches no root: its first item becomes one, so the walk ends and nothing is dropped.
  const reached = new Set<string>();
  const reach = (id: string) => { if (reached.has(id)) return; reached.add(id); for (const child of children.get(id) ?? []) reach(child); };
  roots.forEach(reach);
  for (const item of items) {
    if (reached.has(item.id)) continue;
    for (const list of children.values()) { const at = list.indexOf(item.id); if (at >= 0) list.splice(at, 1); }
    roots.push(item.id);
    reach(item.id);
  }
  const widths = new Map<string, number>();
  const widthOf = (id: string): number => {
    const known = widths.get(id);
    if (known !== undefined) return known;
    const kids = children.get(id) ?? [];
    const width = kids.length ? kids.reduce((sum, child) => sum + widthOf(child), 0) : 1;
    widths.set(id, width);
    return width;
  };
  const places = new Map<string, TreePlace>();
  const order: Array<{ id: string; depth: number }> = [];
  let rows = 0;
  const place = (id: string, left: number, depth: number): number => {
    order.push({ id, depth });
    rows = Math.max(rows, depth + 1);
    const kids = children.get(id) ?? [];
    let x: number;
    if (!kids.length) x = left + 0.5;
    else {
      let cursor = left;
      const centres = kids.map((child) => { const centre = place(child, cursor, depth + 1); cursor += widthOf(child); return centre; });
      x = (centres[0] + centres[centres.length - 1]) / 2;
    }
    places.set(id, { id, x, depth });
    return x;
  };
  let left = 0;
  for (const root of roots) { place(root, left, 0); left += widthOf(root); }
  return { places: items.filter((item, index) => items.findIndex((other) => other.id === item.id) === index).map((item) => places.get(item.id)!), width: left, rows, order };
}

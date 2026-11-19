// Label placement for the SVG maps (UX concept 12.4; WP-COP): one routine, loaded before the two scripts that draw an SVG map, the COP map component
// (media/staff/copMap.js) and the Staff Room's map (media/staffRoom/staffMap.js). Both read it from window.nearDeclutter, so the two maps place names
// the same way and there is one copy to change. The page loads it with its own nonce like its other scripts (src/services/staffRoomPanel.ts), so the
// content security policy needs no new source. Pure: no DOM, no timer, no request.
(function () {
  'use strict';

  /** Where a label may go around its anchor, tried in order: right, left, above, below, then the four corners. */
  const LABEL_OFFSETS = [[1, 0, 'start'], [-1, 0, 'end'], [0, -1, 'middle'], [0, 1, 'middle'], [1, -1, 'start'], [1, 1, 'start'], [-1, -1, 'end'], [-1, 1, 'end']];

  function overlaps(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

  /** A shorter form of a name for a crowded spot: the first word and an ellipsis, or the first four letters. Undefined when nothing shorter helps. */
  function shortName(text) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (words.length > 1) return words[0] + '\u2026';
    return String(text).length > 5 ? String(text).slice(0, 4) + '\u2026' : undefined;
  }

  /**
   * Greedy, deterministic label placement. `labels`: { id, x, y (the anchor), w, h (the label's size), gap (space between anchor and label), prio,
   * text, size (font size, to size a shortened name), first ([dx, dy, anchor]: its usual spot, tried first), fixed (only its usual spot), rings (how
   * many rings of spots around the anchor it may try, 1 by default; a place name may go a little further out than a unit's designation) }.
   * `obstacles`: boxes { x, y, w, h, owner } no label may cover, except the label of the symbol that owns the box. Higher priority places first, ties
   * by id. Each label tries its usual spot, then LABEL_OFFSETS, then the same spots with its shortened name, and takes the first that overlaps nothing
   * placed; a label with no free spot is hidden.
   * Returns { [id]: { hidden: false, x, y, anchor, box, text } | { hidden: true } }, where (x, y) is the text's start, end or middle point on its baseline.
   */
  function declutter(labels, obstacles) {
    const placed = [];
    const out = {};
    const order = labels.slice().sort(function (a, b) { return (b.prio || 0) - (a.prio || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    for (const label of order) {
      const gap = label.gap || 0;
      let spots = label.first ? [label.first] : [];
      for (let ring = 1; !label.fixed && ring <= (label.rings || 1); ring += 1) {
        const reach = gap * (ring === 1 ? 1 : 1 + ring);
        spots = spots.concat(LABEL_OFFSETS.map(function (o) { return [o[0] * reach, o[1] * (reach + label.h / 2), o[2]]; }));
      }
      const short = label.text !== undefined && label.size ? shortName(label.text) : undefined;
      const tries = [{ text: label.text, w: label.w }];
      if (short !== undefined) tries.push({ text: short, w: Math.ceil(short.length * label.size * 0.64) + 2 });
      let found;
      for (const attempt of tries) {
        for (const spot of spots) {
          const cx = label.x + spot[0];
          const cy = label.y + spot[1];
          const left = spot[2] === 'start' ? cx : spot[2] === 'end' ? cx - attempt.w : cx - attempt.w / 2;
          const box = { x: left, y: cy - label.h / 2, w: attempt.w, h: label.h };
          const blocked = placed.some(function (other) { return overlaps(box, other); }) || (obstacles || []).some(function (other) { return other.owner !== label.id && overlaps(box, other); });
          if (!blocked) { found = { hidden: false, x: cx, y: cy + label.h * 0.32, anchor: spot[2], box: box, text: attempt.text }; break; }
        }
        if (found) break;
      }
      if (found) { placed.push(found.box); out[label.id] = found; } else out[label.id] = { hidden: true };
    }
    return out;
  }

  window.nearDeclutter = { version: 1, declutter: declutter, shortName: shortName, LABEL_OFFSETS: LABEL_OFFSETS };
})();

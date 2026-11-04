// Team Board timeline (62.1-UI-SPEC, D-02, D-04): the board's second view, one timeline for the whole project. Milestones are bands, phases are
// segments inside them and every card is a dot in dependency order, from the host's model.timeline (src/domain/team/timeline.ts). This script plugs
// into board.js through window.NearAiBoard like menu.js and detail.js; the toolbar, banners, live region, Move to... menu and detail drawer stay the
// board's. Plain browser JavaScript in one strict IIFE: every text node is set with textContent and every attribute with setAttribute, positions only
// with style.setProperty, no markup strings and no network. The page never decides permissions and posts no message the board does not already post.
// What it draws here is the screen reader structure (ordered lists of milestones, phases and dots); 62.1-04 draws it on the canvas.
(function () {
  'use strict';
  // The page's own words (the timeline's sentences come from the model). The plain-language scan reads this file.
  const T = Object.freeze({
    region: 'Team Board timeline',
    milestones: 'Milestones',
    phasesIn: (title) => 'Phases in ' + title,
    cardsIn: (name) => 'Cards in ' + name + ', in order',
    phase: (number) => 'Phase ' + number
  });

  const board = window.NearAiBoard;
  if (!board) return;

  // ---- small helpers -------------------------------------------------------------------------------------------------------------------------
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
  const attr = (n, k, v) => { if (v === null || v === undefined || v === false) { if (n.getAttribute(k) !== null) n.removeAttribute(k); } else if (n.getAttribute(k) !== String(v)) n.setAttribute(k, String(v)); };
  /** Puts exactly these nodes, in this order, into the parent. Nodes already there are kept (so focus survives), others are moved or removed. */
  function place(parent, nodes) {
    let i = 0;
    for (const n of nodes) { const cur = parent.children[i]; if (cur !== n) parent.insertBefore(n, cur || null); i += 1; }
    while (parent.children.length > nodes.length) parent.children[parent.children.length - 1].remove();
  }
  // The main appearance of a dot (UI-SPEC "State colours"): blocked, then on hold, then the column.
  const stateOf = (c) => (c.blocked ? 'blocked' : c.held ? 'held' : c.column);

  // ---- the screen reader structure (UI-SPEC "Screen Reader Structure") ------------------------------------------------------------------------
  const scroll = el('div', 'tl-scroll');
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', T.region);
  const list = el('ol', 'tl-milestones');
  list.setAttribute('aria-label', T.milestones);
  scroll.appendChild(list);
  const bandEls = new Map();
  const groupEls = new Map();
  const dotEls = new Map();

  function bandEl(band) {
    let b = bandEls.get(band.id);
    if (!b) {
      const li = el('li', 'tl-milestone');
      li.setAttribute('data-milestone', band.id);
      const head = el('div', 'tl-ms-head');
      const h2 = el('h2', 'tl-ms-title');
      head.appendChild(h2);
      const phases = el('ol', 'tl-phases');
      li.append(head, phases);
      b = { li, h2, phases };
      bandEls.set(band.id, b);
    }
    setText(b.h2, band.heading);
    attr(b.phases, 'aria-label', T.phasesIn(band.title));
    return b;
  }
  // A phase's list entry, or the entry of the dots with no phase in their band (the cards added on the board), named after the band.
  function groupEl(band, group) {
    const key = band.id + '|' + group.key;
    let g = groupEls.get(key);
    if (!g) {
      const li = el('li', 'tl-phase');
      li.setAttribute('data-phase', group.key);
      const h3 = el('h3', 'tl-phase-label');
      const dots = el('ol', 'tl-dots');
      li.append(h3, dots);
      g = { li, h3, dots };
      groupEls.set(key, g);
    }
    setText(g.h3, group.phase ? group.phase.heading : band.title);
    attr(g.dots, 'aria-label', T.cardsIn(group.phase ? T.phase(group.phase.number) : band.title));
    return g;
  }
  function dotEl(dot, card) {
    let d = dotEls.get(dot.cardId);
    if (!d) {
      const li = el('li');
      const b = el('button', 'tl-dot');
      b.setAttribute('type', 'button');
      b.setAttribute('data-id', dot.cardId);
      li.appendChild(b);
      d = { li, button: b };
      dotEls.set(dot.cardId, d);
    }
    attr(d.button, 'data-step', dot.step);
    attr(d.button, 'data-slot', dot.slot);
    attr(d.button, 'data-state', stateOf(card));
    attr(d.button, 'aria-label', dot.label);
    attr(d.button, 'aria-current', board.selected() === dot.cardId ? 'true' : null);
    return d;
  }
  // The phases of a band in the model's order (first step, then phase number), each with its dots in sequence order (step, then slot); dots whose
  // phase is not one of the band's go in one entry placed by its first step.
  function groupsOf(band, dots) {
    const groups = band.phases.map((phase) => ({ key: phase.id, phase, first: phase.firstStep, dots: [] }));
    const byId = new Map(groups.map((g) => [g.key, g]));
    let loose;
    for (const dot of dots) {
      const g = dot.phaseId !== undefined ? byId.get(dot.phaseId) : undefined;
      if (g) g.dots.push(dot);
      else { if (!loose) loose = { key: 'none', phase: undefined, first: dot.step, dots: [] }; loose.dots.push(dot); }
    }
    if (loose) {
      const at = groups.findIndex((g) => g.first > loose.first);
      groups.splice(at < 0 ? groups.length : at, 0, loose);
    }
    return groups;
  }

  function render(container, shown) {
    const model = board.model();
    const timeline = model && model.timeline;
    const cards = new Map((model ? model.cards : []).map((c) => [c.id, c]));
    const shownIds = new Set(shown.map((c) => c.id));
    const byBand = new Map();
    for (const dot of timeline ? timeline.dots : []) {
      if (!shownIds.has(dot.cardId) || !cards.has(dot.cardId)) continue;
      if (!byBand.has(dot.milestoneId)) byBand.set(dot.milestoneId, []);
      byBand.get(dot.milestoneId).push(dot);
    }
    const usedBands = new Set();
    const usedGroups = new Set();
    const usedDots = new Set();
    place(list, (timeline ? timeline.milestones : []).map((band) => {
      usedBands.add(band.id);
      const b = bandEl(band);
      place(b.phases, groupsOf(band, byBand.get(band.id) || []).map((group) => {
        usedGroups.add(band.id + '|' + group.key);
        const g = groupEl(band, group);
        place(g.dots, group.dots.map((dot) => { usedDots.add(dot.cardId); return dotEl(dot, cards.get(dot.cardId)).li; }));
        return g.li;
      }));
      return b.li;
    }));
    for (const [k] of bandEls) if (!usedBands.has(k)) bandEls.delete(k);
    for (const [k] of groupEls) if (!usedGroups.has(k)) groupEls.delete(k);
    for (const [k] of dotEls) if (!usedDots.has(k)) dotEls.delete(k);
    // One tab stop for the dots: the selected card's dot when it is shown, else the first (the arrow keys come with 62.1-05).
    const order = Array.from(list.querySelectorAll('button.tl-dot'));
    const stop = order.find((b) => b.getAttribute('data-id') === board.selected()) || order[0];
    for (const b of order) attr(b, 'tabindex', b === stop ? 0 : -1);
    place(container, [scroll]);
  }

  board.registerView('timeline', { render });
})();

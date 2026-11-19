// The map's layer drawer (owner direction, D-48 of 0.4.34: "a better layer chooser that is a drawer slideout, so the layers aren't taking up so much
// of the map room"). One routine for both maps that draw layers, the COP map component (media/staff/copMap.js) and the Staff Room's SVG map
// (media/staffRoom/staffMap.js), read from window.nearLayerDrawer, so the two look and behave the same and there is one copy to change. The page loads
// it with its own nonce like its other scripts (src/services/staffRoomPanel.ts), so the content security policy needs no new source.
//
//   const drawer = nearLayerDrawer.create(host, { motion, onToggle(id, on), title, footnote });
//   drawer.button                     // the compact "Layers" button with how many layers are on; the caller places it over the map
//   drawer.setGroups(groups)          // [{ id, title, items: [{ id, title, count, on, sim, owner, note, separate }] }]; empty groups are left out
//   drawer.open() / drawer.close(returnFocus) / drawer.isOpen() / drawer.destroy()
//
// The drawer slides in from the map's right edge as a dialog. Escape, its close button, the Layers button and a click outside close it; while it is
// open Tab and Shift+Tab stay inside it; closing it with the keyboard puts focus back on the Layers button. Only transform and opacity animate, through
// the Web Animations API, and nothing moves when motion() is false (reduced motion, Calm). Every text goes in with textContent.
(function () {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const EASE = 'cubic-bezier(.2,0,0,1)';
  const FOCUSABLE = { button: true, input: true, select: true, textarea: true, a: true };
  let seq = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** The stacked-sheets glyph of the Layers button. */
  function icon() {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'ld-icon');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3');
    svg.appendChild(path);
    return svg;
  }

  /** Whether `node` is `root` or inside it. */
  function within(root, node) {
    for (let at = node; at; at = at.parentNode) if (at === root) return true;
    return false;
  }

  /** The controls inside `root` that take focus, in document order (hidden branches and disabled controls left out). */
  function focusables(root) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || node.childNodes || []) {
        if (!child || child.hidden) continue;
        const tag = String(child.tagName || child.tag || '').toLowerCase();
        if ((FOCUSABLE[tag] && !child.disabled) || (typeof child.tabIndex === 'number' && child.tabIndex >= 0 && tag !== 'svg' && child.getAttribute && child.getAttribute('tabindex') !== null)) out.push(child);
        walk(child);
      }
    };
    walk(root);
    return out;
  }

  function create(host, options) {
    options = options || {};
    const motion = typeof options.motion === 'function' ? options.motion : function () { return false; };
    seq += 1;
    const id = 'near-layers-' + seq;
    const button = el('button', 'ld-button');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);
    button.setAttribute('aria-haspopup', 'dialog');
    const word = el('span', 'ld-word', 'Layers');
    const count = el('span', 'ld-count', '0');
    count.setAttribute('aria-hidden', 'true');
    button.appendChild(icon()); button.appendChild(word); button.appendChild(count);

    const panel = el('div', 'ld-panel');
    panel.id = id;
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', id + '-title');
    const head = el('div', 'ld-head');
    const title = el('h2', 'ld-title', options.title || 'Map layers');
    title.id = id + '-title';
    const summary = el('span', 'ld-summary', '');
    const close = el('button', 'ld-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the layer list');
    close.title = 'Close (Escape)';
    head.appendChild(title); head.appendChild(summary); head.appendChild(close);
    const body = el('div', 'ld-body');
    const foot = el('p', 'ld-foot', options.footnote || '');
    foot.hidden = !options.footnote;
    panel.appendChild(head); panel.appendChild(body); panel.appendChild(foot);
    host.appendChild(panel);

    let open = false;
    let running;
    let groups = [];

    function animate(frames, duration) {
      if (!motion() || typeof panel.animate !== 'function') return null;
      try { return panel.animate(frames, { duration: duration, easing: EASE }); } catch (error) { return null; }
    }

    function counts() {
      let on = 0, all = 0;
      for (const group of groups) for (const item of group.items) { all += 1; if (item.on) on += 1; }
      return { on: on, all: all };
    }

    function render() {
      const focused = document.activeElement && within(panel, document.activeElement) && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-layer') : undefined;
      while (body.firstChild) body.removeChild(body.firstChild);
      let refocus;
      for (const group of groups) {
        if (!group.items.length) continue;
        const section = el('section', 'ld-group ld-group-' + group.id);
        section.setAttribute('aria-labelledby', id + '-' + group.id);
        const groupHead = el('div', 'ld-group-head');
        const name = el('h3', 'ld-group-title', group.title);
        name.id = id + '-' + group.id;
        const on = group.items.filter(function (item) { return item.on; }).length;
        groupHead.appendChild(name);
        const tally = el('span', 'ld-tally', on + ' of ' + group.items.length + ' on');
        groupHead.appendChild(tally);
        if (group.items.some(function (item) { return item.sim; })) {
          const sim = el('span', 'ld-sim', 'SIM');
          sim.title = 'Simulated exercise data feeds at least one layer here';
          groupHead.appendChild(sim);
        }
        section.appendChild(groupHead);
        const list = el('ul', 'ld-list');
        for (const item of group.items) {
          const row = el('li', 'ld-row' + (item.on ? ' on' : '') + (item.separate ? ' ld-separate' : ''));
          const toggle = el('button', 'ld-switch');
          toggle.type = 'button';
          toggle.setAttribute('role', 'switch');
          toggle.setAttribute('aria-checked', item.on ? 'true' : 'false');
          toggle.setAttribute('data-layer', item.id);
          const words = item.title + ', ' + item.count + (item.sim ? ', simulated' : '') + (item.owner ? ', written by ' + item.owner : '');
          toggle.setAttribute('aria-label', words);
          const knob = el('span', 'ld-knob');
          knob.setAttribute('aria-hidden', 'true');
          toggle.appendChild(knob);
          toggle.addEventListener('click', function () { if (options.onToggle) options.onToggle(item.id, !item.on); });
          const label = el('span', 'ld-name', item.title);
          const number = el('span', 'ld-n', String(item.count));
          number.setAttribute('aria-hidden', 'true');
          row.appendChild(toggle); row.appendChild(label); row.appendChild(number);
          if (item.sim) { const sim = el('span', 'ld-sim', 'SIM'); sim.setAttribute('aria-hidden', 'true'); row.appendChild(sim); }
          const note = (item.owner ? 'By ' + item.owner + '. ' : '') + (item.note || '');
          if (note) row.title = note;
          list.appendChild(row);
          if (focused && focused === item.id) refocus = toggle;
        }
        section.appendChild(list);
        body.appendChild(section);
      }
      const n = counts();
      count.textContent = String(n.on);
      summary.textContent = n.on + ' of ' + n.all + ' on';
      button.setAttribute('aria-label', 'Layers, ' + n.on + ' of ' + n.all + ' on');
      button.title = 'Choose the map layers (' + n.on + ' of ' + n.all + ' on)';
      button.disabled = n.all === 0;
      if (refocus && typeof refocus.focus === 'function') refocus.focus();
    }

    function show() {
      if (open || button.disabled) return;
      open = true;
      if (running && running.cancel) running.cancel();
      running = undefined;
      panel.hidden = false;
      panel.classList.add('ld-open');
      button.setAttribute('aria-expanded', 'true');
      animate([{ transform: 'translateX(24px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], 220);
      const first = focusables(panel).filter(function (node) { return node !== close; })[0] || close;
      if (first && typeof first.focus === 'function') first.focus();
      if (options.onOpen) options.onOpen(true);
    }

    function hide(returnFocus) {
      if (!open) return;
      open = false;
      button.setAttribute('aria-expanded', 'false');
      panel.classList.remove('ld-open');
      const done = function () { running = undefined; if (!open) panel.hidden = true; };
      running = animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(24px)', opacity: 0 }], 160);
      if (running) running.onfinish = done; else done();
      if (returnFocus && typeof button.focus === 'function') button.focus();
      if (options.onOpen) options.onOpen(false);
    }

    button.addEventListener('click', function () { if (open) hide(true); else show(); });
    close.addEventListener('click', function () { hide(true); });
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        hide(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const list = focusables(panel);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !within(panel, active))) { if (event.preventDefault) event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !within(panel, active))) { if (event.preventDefault) event.preventDefault(); first.focus(); }
    });
    // A click anywhere outside the drawer and its button closes it, without moving focus (the person chose where to go).
    const outside = function (event) { if (open && event && event.target && !within(panel, event.target) && !within(button, event.target)) hide(false); };
    if (typeof document.addEventListener === 'function') document.addEventListener('pointerdown', outside, true);

    return {
      button: button, panel: panel,
      setGroups: function (next) {
        groups = (next || []).map(function (group) { return { id: String(group.id), title: String(group.title), items: (group.items || []).slice() }; });
        render();
      },
      open: show,
      close: hide,
      isOpen: function () { return open; },
      destroy: function () {
        if (typeof document.removeEventListener === 'function') document.removeEventListener('pointerdown', outside, true);
        if (panel.parentNode) panel.parentNode.removeChild(panel);
        if (button.parentNode) button.parentNode.removeChild(button);
      }
    };
  }

  /** The drawer's group for a COP picture layer: what the staff wrote and the feeds, the ground and its weather, or the scenario for reference. */
  function groupOf(layer) {
    if (layer.kind === 'environment' || layer.id === 'cop-terrain-layer') return 'environment';
    if (layer.kind === 'reference') return 'reference';
    return 'picture';
  }

  const GROUPS = [['picture', 'Picture'], ['environment', 'Environment'], ['reference', 'Reference']];

  /** Layers sorted into the drawer's three groups, keeping their order inside each group. */
  function grouped(items) {
    return GROUPS.map(function (entry) { return { id: entry[0], title: entry[1], items: items.filter(function (item) { return item.group === entry[0]; }) }; });
  }

  window.nearLayerDrawer = { version: 1, create: create, focusables: focusables, within: within, groupOf: groupOf, grouped: grouped };
})();

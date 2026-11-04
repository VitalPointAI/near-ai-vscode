// Team Board drag and drop (62-UI-SPEC "Pointer path"): the pointer way to move a card in the kanban. Offered columns of the card's own row light up, an
// offered drop sends one move request, and the host decides. The page never decides whether a move is allowed; it only shows what the model offers.
// Plain browser JavaScript in an IIFE that plugs into board.js through window.NearAiBoard. Text nodes only, attributes with setAttribute, no markup.
(function () {
  'use strict';
  const board = window.NearAiBoard;
  const area = document.getElementById('board');
  if (!board || !area) return;
  const TYPE = 'application/x-near-ai-card';
  // The other-row sentences (62-23): grouped by member a row is a person, so the way to hand a card over is Assign to; any other grouping keeps to the row.
  const OTHER_ROW = 'This card stays in its own row. Drop it in another column of the same row.';
  const OTHER_PERSON = 'This card stays in its own row. To give it to someone else, use Assign to in its Move to... menu. Nothing was moved.';

  // The drag in progress: { id, lane, state: 'active' | 'dropped' }. It outlives the drop until dragend so the end of the drag can tell a drop from a cancel.
  let session;
  // Moves this script sent that the host has not answered: item id -> { column, key }. Only these refusals are drawn here, because the menu and the form
  // post their own requests and show their own refusals.
  const awaiting = {};

  const stateKey = (c) => JSON.stringify([c.column, !!c.blocked, c.held]);
  const down = (model) => ['offline', 'paused', 'removed'].indexOf(model.status.kind) >= 0;
  const columnLabel = (key) => {
    const model = board.model();
    const found = model && key ? model.columns.find((c) => c.key === key) : undefined;
    return found ? found.label : '';
  };
  const hasType = (e) => !!e.dataTransfer && !!e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, TYPE) >= 0;
  const asElement = (node) => (node && node.closest ? node : node && node.parentNode && node.parentNode.closest ? node.parentNode : null);
  const cellOf = (node) => { const n = asElement(node); return n ? n.closest('.cell') : null; };
  const cardOfNode = (node) => { const n = asElement(node); return n ? n.closest('.card') : null; };

  /** What dropping the dragged card on this cell means right now: 'own' (nothing), 'ok' (a move), or 'no' (a reason to show). */
  function verdict(cell, s) {
    const c = board.cardData(s.id);
    const column = cell.getAttribute('data-column');
    if (!c) return { kind: 'no', column, text: 'This card is no longer on the board. Nothing was moved.' };
    if (cell.getAttribute('data-lane') !== s.lane) return { kind: 'no', column, text: board.groupBy && board.groupBy() === 'member' ? OTHER_PERSON : OTHER_ROW };
    if (column === c.column) return { kind: 'own', column };
    const move = c.moves.find((m) => m.column === column);
    if (move) return { kind: 'ok', column, move };
    return { kind: 'no', column, text: (c.refusals && c.refusals[column]) || 'This card cannot be moved there. Nothing was moved.' };
  }

  // ---- what can be dragged ---------------------------------------------------------------------------------------------------------------------
  function canDrag(c, model) {
    return c.moves.length > 0 && (model.viewer.role === 'owner' || model.viewer.role === 'lead') && !down(model);
  }
  function syncDraggable() {
    const model = board.model();
    if (!model) return;
    const on = board.layout() === 'kanban';
    for (const c of model.cards) {
      const li = board.cardElement(c.id);
      if (!li) continue;
      if (on && canDrag(c, model)) { if (li.getAttribute('draggable') !== 'true') li.setAttribute('draggable', 'true'); } else if (li.getAttribute('draggable') !== null) li.removeAttribute('draggable');
    }
  }

  // ---- highlights ------------------------------------------------------------------------------------------------------------------------------
  const add = (node, cls) => node.classList.add(cls);
  const remove = (node, cls) => node.classList.remove(cls);
  // The transient "Can't drop here" caption inside the cell the pointer is over (a refused cell). It never takes a pointer event, so it cannot cause a dragleave.
  let hover;
  function hideHover() {
    if (!hover) return;
    hover.caption.remove();
    remove(hover.cell, 'drop-no');
    hover = undefined;
  }
  function showHover(cell, reason) {
    if (hover && hover.cell === cell && hover.caption.isConnected) return;
    hideHover();
    const caption = document.createElement(cell.localName === 'ul' ? 'li' : 'div');
    caption.className = 'drop-caption';
    caption.setAttribute('role', 'presentation');
    caption.setAttribute('aria-hidden', 'true');
    caption.style.setProperty('pointer-events', 'none');
    caption.textContent = "Can't drop here: " + reason;
    cell.appendChild(caption);
    add(cell, 'drop-no');
    hover = { cell, caption };
  }
  function clearMarks() {
    hideHover();
    for (const c of area.querySelectorAll('.cell')) { remove(c, 'drop-ok'); remove(c, 'drop-no'); }
    for (const n of area.querySelectorAll('.lane')) remove(n, 'drag-active');
    for (const n of area.querySelectorAll('.column')) remove(n, 'drag-active');
  }
  function mark(s) {
    clearMarks();
    const offered = new Set();
    for (const c of area.querySelectorAll('.cell')) {
      if (verdict(c, s).kind === 'ok') { add(c, 'drop-ok'); offered.add(c.getAttribute('data-column')); }
    }
    for (const n of area.querySelectorAll('.lane')) if (n.getAttribute('data-lane') === s.lane) add(n, 'drag-active');
    for (const n of area.querySelectorAll('.column')) if (offered.has(n.getAttribute('data-column'))) add(n, 'drag-active');
  }

  // ---- the e2e drag log (62-23) ------------------------------------------------------------------------------------------------------------------
  // What the browser's own drag events did, kept by board.js only on a page marked for the extension-host tests. One dragenter per cell entered.
  let lastEntered;
  function log(event, cell, verdictWord) {
    if (!board.logDrag) return;
    board.logDrag({ event, column: cell ? cell.getAttribute('data-column') || '' : '', lane: cell ? cell.getAttribute('data-lane') || '' : '', verdict: verdictWord });
  }
  function logCard(event, s, verdictWord) {
    const c = board.cardData(s.id);
    if (board.logDrag) board.logDrag({ event, column: c ? c.column : '', lane: s.lane, verdict: verdictWord });
  }

  // ---- the drag --------------------------------------------------------------------------------------------------------------------------------
  area.addEventListener('dragstart', (e) => {
    const li = cardOfNode(e.target);
    if (!li || board.layout() !== 'kanban') return;
    const id = li.getAttribute('data-id');
    const model = board.model();
    const c = board.cardData(id);
    const source = cellOf(li);
    if (!model || !c || !source || !canDrag(c, model) || li.getAttribute('aria-busy') === 'true') { log('dragstart', source, 'refused'); e.preventDefault(); return; }
    e.dataTransfer.setData(TYPE, id);
    e.dataTransfer.effectAllowed = 'move';
    session = { id, lane: source.getAttribute('data-lane'), state: 'active' };
    lastEntered = undefined;
    // No render moves the dragged card until the drag ends (62-23): Chromium cancels a drag whose source leaves the page.
    board.setDragging(true);
    add(li, 'dragging');
    mark(session);
    log('dragstart', source, 'started');
    if (!reduced()) lastRects = snapshot(model);
  });

  // Every cell accepts the drop, so a refused drop can say why instead of the browser flying the card back with no word.
  function accepts(e) { return !!session && session.state === 'active' && hasType(e) && !!cellOf(e.target); }
  function hint(e) {
    const target = cellOf(e.target);
    const v = verdict(target, session);
    if (v.kind === 'no') showHover(target, v.text); else hideHover();
  }
  area.addEventListener('dragenter', (e) => {
    const target = cellOf(e.target);
    if (session && session.state === 'active' && target && target !== lastEntered) { lastEntered = target; log('dragenter', target, accepts(e) ? verdict(target, session).kind : 'ignored'); }
    if (!accepts(e)) return;
    e.preventDefault();
    hint(e);
  });
  area.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    hint(e);
  });
  area.addEventListener('dragleave', (e) => {
    const target = cellOf(e.target);
    if (!hover || hover.cell !== target) return;
    const into = asElement(e.relatedTarget);
    if (into && target.contains(into)) return;
    hideHover();
  });

  area.addEventListener('drop', (e) => {
    const s = session;
    if (!s || s.state !== 'active' || !hasType(e)) { if (s) log('drop', cellOf(e.target), 'ignored'); return; }
    const target = cellOf(e.target);
    if (!target || e.dataTransfer.getData(TYPE) !== s.id) { log('drop', target, 'ignored'); return; }
    e.preventDefault();
    s.state = 'dropped';
    clearMarks();
    const li = board.cardElement(s.id);
    if (li) remove(li, 'dragging');
    const v = verdict(target, s);
    log('drop', target, v.kind);
    if (v.kind === 'own') return;
    // A refused drop never posts and never moves anything: the card keeps its place and shows and announces the reason.
    if (v.kind === 'no') {
      board.showRefusal(s.id, columnLabel(v.column), v.text);
      // The reason line makes the card taller; it is brought into view so the person sees why (62-23: in a real window it fell below the edge).
      const shown = board.cardElement(s.id);
      if (shown && shown.isConnected && typeof shown.scrollIntoView === 'function') shown.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    const c = board.cardData(s.id);
    awaiting[s.id] = { column: columnLabel(v.column), key: stateKey(c) };
    board.setPending(s.id, 'Moving to ' + columnLabel(v.column) + '...');
    board.post({ type: 'move', itemId: s.id, target: v.move.key });
  });
  // The drag is over once it is dropped: a render held back during it may run now (a dragend that never reaches the board cannot freeze it).
  area.addEventListener('drop', () => { if (session && session.state === 'dropped') board.setDragging(false); });

  /** A drag that ended without a drop (Escape, or dropped somewhere the board does not take): nothing changed, and the person is told so. */
  function cancel(s) {
    s.state = 'cancelled';
    board.setDragging(false);
    const li = board.cardElement(s.id);
    if (li) remove(li, 'dragging');
    clearMarks();
    const c = board.cardData(s.id);
    board.announce(c ? 'Move cancelled. The card is still in ' + c.stateLabel + '.' : 'Move cancelled.');
  }
  area.addEventListener('dragend', () => {
    const s = session;
    session = undefined;
    lastEntered = undefined;
    if (!s) return;
    logCard('dragend', s, s.state === 'active' ? 'cancelled' : s.state);
    if (s.state === 'active') { cancel(s); return; }
    const li = board.cardElement(s.id);
    if (li) remove(li, 'dragging');
    clearMarks();
    board.setDragging(false);
  });
  // Browsers cancel a native drag on Escape themselves and then send dragend; this covers a host that reports the key instead.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && session && session.state === 'active') cancel(session); });

  // ---- motion ----------------------------------------------------------------------------------------------------------------------------------
  // A card that changes column glides from where it was to where it is (FLIP) over 150 ms. Under prefers-reduced-motion nothing is animated at all; the
  // card simply appears at its destination. The 3 second changed outline belongs to board.js and is not motion.
  let lastRects = new Map();
  let lastColumns = new Map();
  const slides = new Map();
  function reduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (err) { return false; }
  }
  function snapshot(model) {
    const out = new Map();
    for (const c of model.cards) {
      const li = board.cardElement(c.id);
      if (!li || !li.isConnected) continue;
      const r = li.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) out.set(c.id, { left: r.left, top: r.top });
    }
    return out;
  }
  function slide(id, dx, dy) {
    const li = board.cardElement(id);
    if (!li || (dx === 0 && dy === 0)) return;
    clearTimeout(slides.get(id));
    li.style.setProperty('transition', 'none');
    li.style.setProperty('transform', 'translate(' + dx + 'px, ' + dy + 'px)');
    li.getBoundingClientRect(); // makes the browser take the starting position before the transition is switched on
    li.style.setProperty('transition', 'transform 150ms ease-out');
    li.style.setProperty('transform', 'translate(0px, 0px)');
    slides.set(id, setTimeout(() => { li.style.removeProperty('transform'); li.style.removeProperty('transition'); slides.delete(id); }, 150));
  }
  function glide() {
    const model = board.model();
    if (!model || board.layout() !== 'kanban' || reduced()) { lastRects = new Map(); lastColumns = new Map(); return; }
    const now = snapshot(model);
    for (const c of model.cards) {
      const was = lastRects.get(c.id);
      const at = now.get(c.id);
      const before = lastColumns.get(c.id);
      if (was && at && before !== undefined && before !== c.column) slide(c.id, was.left - at.left, was.top - at.top);
    }
    lastRects = now;
    lastColumns = new Map(model.cards.map((c) => [c.id, c.column]));
  }

  board.onRender(() => {
    syncDraggable();
    if (session && session.state === 'active') {
      const li = board.cardElement(session.id);
      if (li) add(li, 'dragging');
      mark(session);
    }
    glide();
  });

  // The host answered a request from a drop. A reason is shown on the card and announced once; an empty reason is a dismissed prompt, which board.js
  // already cleared silently.
  board.onMessage('refused', (m) => {
    const wait = awaiting[m.itemId];
    if (!wait) return;
    delete awaiting[m.itemId];
    if (m.reason) board.showRefusal(m.itemId, wait.column, m.reason);
  });
  // A state that shows the move happened ends the wait.
  board.onMessage('state', () => {
    for (const id of Object.keys(awaiting)) {
      const c = board.cardData(id);
      if (!c || stateKey(c) !== awaiting[id].key) delete awaiting[id];
    }
  });

  syncDraggable();
}());

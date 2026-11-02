// Team Board drag and drop (62-UI-SPEC "Pointer path"): the pointer way to move a card in the kanban. Offered columns of the card's own row light up, an
// offered drop sends one move request, and the host decides. The page never decides whether a move is allowed; it only shows what the model offers.
// Plain browser JavaScript in an IIFE that plugs into board.js through window.NearAiBoard. Text nodes only, attributes with setAttribute, no markup.
(function () {
  'use strict';
  const board = window.NearAiBoard;
  const area = document.getElementById('board');
  if (!board || !area) return;
  const TYPE = 'application/x-near-ai-card';

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
    if (!c) return { kind: 'no', column, text: 'That card is no longer on the board. Nothing was moved.' };
    if (cell.getAttribute('data-lane') !== s.lane) return { kind: 'no', column, text: 'This card stays in its own row. Drop it in another column of the same row.' };
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
  function clearMarks() {
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

  // ---- the drag --------------------------------------------------------------------------------------------------------------------------------
  area.addEventListener('dragstart', (e) => {
    const li = cardOfNode(e.target);
    if (!li || board.layout() !== 'kanban') return;
    const id = li.getAttribute('data-id');
    const model = board.model();
    const c = board.cardData(id);
    const source = cellOf(li);
    if (!model || !c || !source || !canDrag(c, model) || li.getAttribute('aria-busy') === 'true') { e.preventDefault(); return; }
    e.dataTransfer.setData(TYPE, id);
    e.dataTransfer.effectAllowed = 'move';
    session = { id, lane: source.getAttribute('data-lane'), state: 'active' };
    add(li, 'dragging');
    mark(session);
  });

  area.addEventListener('dragenter', (e) => { if (session && session.state === 'active' && hasType(e) && cellOf(e.target)) e.preventDefault(); });
  area.addEventListener('dragover', (e) => {
    if (!session || session.state !== 'active' || !hasType(e) || !cellOf(e.target)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  area.addEventListener('drop', (e) => {
    const s = session;
    if (!s || s.state !== 'active' || !hasType(e)) return;
    const target = cellOf(e.target);
    if (!target || e.dataTransfer.getData(TYPE) !== s.id) return;
    e.preventDefault();
    s.state = 'dropped';
    clearMarks();
    const li = board.cardElement(s.id);
    if (li) remove(li, 'dragging');
    const v = verdict(target, s);
    if (v.kind !== 'ok') return;
    const c = board.cardData(s.id);
    awaiting[s.id] = { column: columnLabel(v.column), key: stateKey(c) };
    board.setPending(s.id, 'Moving to ' + columnLabel(v.column) + '...');
    board.post({ type: 'move', itemId: s.id, target: v.move.key });
  });

  area.addEventListener('dragend', () => {
    const li = session ? board.cardElement(session.id) : null;
    if (li) remove(li, 'dragging');
    clearMarks();
    session = undefined;
  });

  board.onRender(() => {
    syncDraggable();
    if (session && session.state === 'active') {
      const li = board.cardElement(session.id);
      if (li) add(li, 'dragging');
      mark(session);
    }
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

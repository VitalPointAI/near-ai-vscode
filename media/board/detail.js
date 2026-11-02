// Team Board card detail (62-UI-SPEC "Card Detail"). Opening a card asks the host for its detail and draws it in the shared aside#detail: a non-modal
// drawer in the kanban, a drill-in page in the list. The page formats nothing it can take from the host's message. Plain browser JavaScript in an IIFE
// that plugs into board.js through window.NearAiBoard. Text nodes only, attributes with setAttribute, no markup strings.
(function () {
  'use strict';
  const board = window.NearAiBoard;
  if (!board) return;
  const drawer = board.drawer();
  const COLUMN_ICONS = { backlog: 'circle-outline', ready: 'play-circle', claimed: 'person', 'in-progress': 'sync', 'in-review': 'eye', integrating: 'git-merge', done: 'pass', cancelled: 'circle-slash' };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function button(cls, label, onClick, name) {
    const b = el('button', cls);
    b.setAttribute('type', 'button');
    if (name) b.appendChild(board.icon(name));
    if (label) b.appendChild(el('span', 'label', label));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  const iconText = (cls, name, word) => { const s = el('span', cls); s.append(board.icon(name), el('span', 'label', word)); return s; };

  // The title block is built once so focus on the heading or a button survives every refresh of the detail.
  const heading = el('h2');
  heading.setAttribute('tabindex', '-1');
  const stateLine = el('div', 'detail-state');
  const closeBtn = button('secondary detail-close', 'Close details', () => close(true), 'close');
  const head = el('div', 'detail-head');
  const actions = el('div', 'detail-actions');
  actions.appendChild(closeBtn);
  head.append(stateLine, heading, actions);
  const body = el('div', 'detail-body');
  drawer.append(head, body);

  let current; // { id, opener, originId, detail }

  const timeText = (at) => {
    const d = new Date(at);
    return isNaN(d.getTime()) ? String(at) : d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  function timeNode(at) {
    const t = el('time', '', timeText(at));
    t.setAttribute('datetime', String(at));
    return t;
  }

  function section(title, ...nodes) {
    const s = el('section', 'detail-section');
    s.appendChild(el('h3', '', title));
    for (const n of nodes) s.appendChild(n);
    return s;
  }
  function list(tag, rows, cls) {
    const l = el(tag, cls);
    for (const row of rows) l.appendChild(row);
    return l;
  }

  function renderHead(d) {
    const column = d ? d.column : (board.cardData(current.id) || {}).column;
    const word = d ? d.stateLabel : (board.cardData(current.id) || {}).stateLabel;
    const displayId = d ? d.displayId : (board.cardData(current.id) || {}).displayId;
    stateLine.replaceChildren(board.icon(COLUMN_ICONS[column] || 'circle-outline'), el('span', 'label', word || ''), el('span', 'did', displayId || ''));
  }

  function renderBody(d) {
    const sections = [];
    const facts = d.facts || {};
    const rows = [];
    const fact = (label, value) => { if (value !== undefined && value !== '') rows.push(el('dt', '', label), el('dd', '', String(value))); };
    fact('Phase', facts.phase);
    fact('Milestone', facts.milestone);
    fact('Wave', facts.wave);
    fact('Kind', d.kindLabel);
    fact('Created by', facts.createdBy);
    fact('Estimate', facts.estimate);
    fact('In this state for', facts.age);
    fact('Source', facts.source);
    sections.push(section('Facts', list('dl', rows)));
    if (d.mustHaves.length > 0) sections.push(section('Must-haves', list('ul', d.mustHaves.map((t) => el('li', '', t)))));
    if (d.requirements.length > 0) sections.push(section('Requirements', list('ul', d.requirements.map((id) => el('li', '', id)))));
    if (d.files.length > 0) sections.push(section('Files', list('ul', d.files.map((f) => el('li', '', f)), 'files')));
    if (d.tasks.total > 0) {
      const items = d.tasks.items.map((t) => {
        const li = el('li', 'task');
        li.append(board.icon(t.done ? 'pass' : 'circle-outline'), el('span', 'task-word', t.done ? 'Done' : 'To do'), el('span', 'task-title', ' ' + t.title));
        return li;
      });
      sections.push(section('Tasks', el('p', 'task-summary', d.tasks.summary), list('ul', items, 'tasks')));
    }
    if (d.history.length > 0) {
      const items = d.history.map((entry) => { const li = el('li', 'history-row'); li.append(timeNode(entry.at), el('span', '', ' ' + entry.text)); return li; });
      sections.push(section('History', list('ol', items, 'history')));
    }
    body.replaceChildren(...sections);
  }

  function open(id, opener) {
    const c = board.cardData(id);
    if (!c) return;
    const fromInside = !!opener && drawer.contains(opener);
    const previous = current;
    current = { id, opener: fromInside && previous ? previous.opener : opener, originId: fromInside && previous ? previous.originId : id, detail: undefined };
    heading.textContent = c.title;
    renderHead(undefined);
    body.replaceChildren();
    drawer.hidden = false;
    board.post({ type: 'detail', itemId: id });
    heading.focus();
    syncSelection();
  }

  function close(restore) {
    if (!current) return;
    const { opener, originId } = current;
    current = undefined;
    drawer.hidden = true;
    body.replaceChildren();
    syncSelection();
    if (restore) {
      if (opener && opener.isConnected && !opener.hidden) opener.focus();
      if (!opener || document.activeElement !== opener) board.focusCard(originId);
    }
  }

  /** aria-current and the selected look belong to the card whose detail is open, and to no other. */
  function syncSelection() {
    const model = board.model();
    if (!model) return;
    for (const c of model.cards) {
      const li = board.cardElement(c.id);
      if (!li) continue;
      const on = !!current && current.id === c.id;
      if (!on && !li.classList.contains('selected')) continue;
      const main = li.querySelector('.card-main');
      if (main) { if (on) main.setAttribute('aria-current', 'true'); else main.removeAttribute('aria-current'); }
      li.classList.toggle('selected', on);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    const menu = document.getElementById('menu');
    if ((menu && !menu.hidden) || document.querySelector('.dragging')) return;
    e.preventDefault();
    close(true);
  });

  board.onRender(() => { syncSelection(); });

  board.onMessage('detail', (m) => {
    if (!current || m.itemId !== current.id) return;
    current.detail = m;
    heading.textContent = m.title;
    renderHead(m);
    renderBody(m);
  });

  window.NearAiBoard.registerDetail(open);
}());

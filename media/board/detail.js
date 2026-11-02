// Team Board card detail (62-UI-SPEC "Card Detail"). Opening a card asks the host for its detail and draws it in the shared aside#detail: a non-modal
// drawer in the kanban, a drill-in page with Back to list in the list. The page formats nothing it can take from the host's message. Plain browser
// JavaScript in an IIFE that plugs into board.js through window.NearAiBoard. Text nodes only, attributes with setAttribute, no markup strings.
(function () {
  'use strict';
  const board = window.NearAiBoard;
  if (!board) return;
  const drawer = board.drawer();
  const FILES_SHOWN = 8;
  const HISTORY_SHOWN = 50;
  const COLUMN_ICONS = { backlog: 'circle-outline', ready: 'play-circle', claimed: 'person', 'in-progress': 'sync', 'in-review': 'eye', integrating: 'git-merge', done: 'pass', cancelled: 'circle-slash' };
  const T = {
    close: 'Close details', back: 'Back to list', moveTo: 'Move to...', edit: 'Edit', gone: 'That card is no longer on the board.', loading: 'Loading details...',
    imported: 'This comes from the project plans. Change the plan files and the board updates.', noTasks: 'This plan has no tasks listed.',
    noHistory: 'No changes recorded since this window opened.', historyCap: 'Showing the latest 50 changes.'
  };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function button(cls, label, onClick, name) {
    const b = el('button', cls);
    b.setAttribute('type', 'button');
    if (name) b.appendChild(board.icon(name));
    if (label) b.appendChild(el('span', 'label', label));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const isDown = () => { const m = board.model(); return !!m && ['offline', 'paused', 'removed'].indexOf(m.status.kind) >= 0; };
  const scroller = () => document.scrollingElement || document.documentElement;

  // The title block is built once and updated in place, so focus on the heading or a button survives every refresh of the detail.
  const heading = el('h2');
  heading.setAttribute('tabindex', '-1');
  const stateLine = el('div', 'detail-state');
  const badges = el('div', 'detail-badges');
  const moveBtn = button('secondary move-btn detail-move', T.moveTo, () => {
    if (current && moveBtn.getAttribute('aria-disabled') !== 'true') board.openMenu(current.id, moveBtn);
  }, 'arrow-swap');
  moveBtn.setAttribute('aria-haspopup', 'menu');
  moveBtn.setAttribute('aria-controls', 'menu');
  moveBtn.setAttribute('aria-expanded', 'false');
  const editBtn = button('secondary detail-edit', T.edit, () => { if (current) board.openForm(current.id); });
  const closeBtn = button('secondary detail-close', '', () => close(true));
  const actions = el('div', 'detail-actions');
  actions.append(moveBtn, closeBtn); // Edit is put in only while the viewer may edit this board item (updateActions)
  const note = el('p', 'detail-note');
  const refusalEl = el('p', 'detail-refusal');
  const head = el('div', 'detail-head');
  head.append(stateLine, heading, badges, actions, note, refusalEl);
  const body = el('div', 'detail-body');
  drawer.append(head, body);
  moveBtn.hidden = true;
  note.hidden = true;
  refusalEl.hidden = true;

  let current; // { id, opener, originId, detail, detailSig, sig, allFiles, scroll }

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
  const badge = (name, word, cls) => { const s = el('span', 'badge ' + cls); s.append(board.icon(name), el('span', 'label', word)); return s; };

  // ---- the title block ---------------------------------------------------------------------------------------------------------------------
  function renderHead() {
    const d = current.detail;
    const c = board.cardData(current.id) || {};
    const column = d ? d.column : c.column;
    stateLine.replaceChildren(board.icon(COLUMN_ICONS[column] || 'circle-outline'), el('span', 'label', (d ? d.stateLabel : c.stateLabel) || ''), el('span', 'did', (d ? d.displayId : c.displayId) || ''));
    const blocked = d ? d.blocked : c.blocked;
    const held = d ? d.held : c.held;
    const doneInGsd = d ? d.doneInGsd : c.doneInGsd;
    const out = [];
    if (blocked) out.push(badge('lock', 'Blocked', 'badge-blocked'));
    if (held) out.push(badge('debug-pause', 'On hold', 'badge-hold'));
    if (doneInGsd) out.push(badge('info', 'Done in GSD, confirm', 'badge-info'));
    if (column === 'cancelled') out.push(badge('circle-slash', 'Cancelled', 'badge-cancelled'));
    badges.replaceChildren(...out);
    badges.hidden = out.length === 0;
    updateActions();
  }

  /** Move to... follows the card exactly: owners and leads only, with at least one offered move, disabled while the board cannot be changed. */
  function updateActions() {
    if (!current) return;
    const model = board.model();
    const c = board.cardData(current.id);
    const d = current.detail;
    const down = isDown();
    const canMove = !!c && !!model && c.moves.length > 0 && (model.viewer.role === 'owner' || model.viewer.role === 'lead') && (down || model.viewer.canWrite);
    moveBtn.hidden = !canMove;
    if (c) moveBtn.setAttribute('aria-label', 'Move to... ' + (c.kind === 'plan' ? 'plan ' : '') + c.displayId + ', ' + c.title);
    if (down) moveBtn.setAttribute('aria-disabled', 'true'); else moveBtn.removeAttribute('aria-disabled');
    const boardItem = !!d && (d.facts.createdBy !== undefined || d.facts.source === 'Added on the board');
    // Edit exists only for a board item the viewer may edit (UI-SPEC title block); imported items get the note instead, and nobody gets a hidden Edit.
    const canEdit = boardItem && d.editable === true && !down;
    if (canEdit && editBtn.parentNode !== actions) actions.insertBefore(editBtn, closeBtn);
    else if (!canEdit && editBtn.parentNode) editBtn.remove();
    note.hidden = !(d && !boardItem);
    note.textContent = note.hidden ? '' : T.imported;
    const wantBack = board.layout() === 'list';
    const want = wantBack ? T.back : T.close;
    if (closeBtn.textContent !== want) closeBtn.replaceChildren(board.icon(wantBack ? 'arrow-left' : 'close'), el('span', 'label', want));
  }

  function setRefusal(reason) {
    refusalEl.replaceChildren(...(reason ? [board.icon('error'), el('span', 'refusal-line', reason)] : []));
    refusalEl.hidden = !reason;
  }

  // ---- the sections ------------------------------------------------------------------------------------------------------------------------
  function dependencyRow(dep) {
    const li = el('li', 'dep');
    if (!dep.onBoard) { li.textContent = dep.label; return li; }
    const word = dep.stateLabel || '';
    const state = board.icon(dep.done ? 'pass' : 'circle-outline');
    if (board.cardData(dep.id)) {
      const b = button('link', '', () => board.openDetail(dep.id, b));
      b.append(state, el('span', 'label', dep.label), el('span', 'dep-state', ' ' + word));
      b.setAttribute('aria-label', dep.label + ', ' + word);
      b.setAttribute('data-focus', 'dep:' + dep.id);
      li.appendChild(b);
    } else li.append(state, el('span', 'label', dep.label), el('span', 'dep-state', ' ' + word));
    return li;
  }

  function filesSection(files) {
    const shown = current.allFiles ? files : files.slice(0, FILES_SHOWN);
    const nodes = [list('ul', shown.map((f) => el('li', '', f)), 'files')];
    if (shown.length < files.length) {
      const more = button('link', 'Show all ' + files.length, () => {
        current.allFiles = true;
        renderBody();
        const rows = body.querySelectorAll('.files li');
        const first = rows[FILES_SHOWN];
        if (first) { first.setAttribute('tabindex', '-1'); first.focus(); }
        board.announce('Showing all ' + plural(files.length, 'file', 'files') + '.');
      });
      more.setAttribute('data-focus', 'files-more');
      nodes.push(more);
    }
    return section('Files', ...nodes);
  }

  function renderBody() {
    const d = current.detail;
    if (!d) { body.replaceChildren(el('p', 'detail-loading', T.loading)); return; }
    const active = document.activeElement;
    const focusKey = active && body.contains(active) ? active.getAttribute('data-focus') : null;
    const out = [];
    if (d.blocked) {
      const notice = el('div', 'blocked-notice');
      notice.append(board.icon('lock'), el('span', '', 'Blocked by ' + d.blocked.byName + ': ' + d.blocked.reason + ' '), timeNode(d.blocked.since));
      out.push(notice);
    }
    if (d.notReady.length > 0) out.push(section('Why this is not ready', list('ul', d.notReady.map((t) => el('li', '', t)))));
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
    out.push(section('Facts', list('dl', rows)));
    if (d.description) out.push(section('Description', ...d.description.split(/\n+/).filter(Boolean).map((line) => el('p', '', line))));
    if (d.mustHaves.length > 0) out.push(section('Must-haves', list('ul', d.mustHaves.map((t) => el('li', '', t)))));
    if (d.requirements.length > 0) {
      out.push(section('Requirements', list('ul', d.requirements.map((id) => {
        const b = button('link', id, () => board.setFilter('requirement', id));
        b.setAttribute('aria-label', 'Filter the board by ' + id);
        b.setAttribute('data-focus', 'req:' + id);
        const li = el('li');
        li.appendChild(b);
        return li;
      }))));
    }
    if (d.dependencies.length > 0) out.push(section('Dependencies', list('ul', d.dependencies.map(dependencyRow))));
    if (d.files.length > 0) out.push(filesSection(d.files));
    if (d.kind === 'plan' || d.tasks.total > 0) {
      if (d.tasks.total === 0) out.push(section('Tasks', el('p', 'empty', T.noTasks)));
      else {
        const items = d.tasks.items.map((t) => {
          const li = el('li', 'task');
          li.append(board.icon(t.done ? 'pass' : 'circle-outline'), el('span', 'task-word', t.done ? 'Done' : 'To do'), el('span', 'task-title', ' ' + t.title));
          return li;
        });
        out.push(section('Tasks', el('p', 'task-summary', d.tasks.summary), list('ul', items, 'tasks')));
      }
    }
    const entries = d.history.slice(0, HISTORY_SHOWN);
    if (entries.length === 0) out.push(section('History', el('p', 'empty', T.noHistory)));
    else {
      const items = entries.map((entry) => { const li = el('li', 'history-row'); li.append(timeNode(entry.at), el('span', '', ' ' + entry.text)); return li; });
      const nodes = [list('ol', items, 'history')];
      if (d.history.length >= HISTORY_SHOWN) nodes.push(el('p', 'history-note', T.historyCap));
      out.push(section('History', ...nodes));
    }
    body.replaceChildren(...out);
    if (focusKey) {
      const again = body.querySelectorAll('[data-focus]').find((n) => n.getAttribute('data-focus') === focusKey);
      if (again) again.focus(); else heading.focus();
    }
  }

  // ---- open and close ----------------------------------------------------------------------------------------------------------------------
  function open(id, opener) {
    const c = board.cardData(id);
    if (!c) return;
    const previous = current;
    const fromInside = !!previous && !!opener && drawer.contains(opener);
    if (previous && previous.id === id) { heading.focus(); return; }
    current = {
      id, opener: fromInside ? previous.opener : opener, originId: fromInside ? previous.originId : id, detail: undefined, detailSig: '', sig: JSON.stringify(c), allFiles: false,
      scroll: fromInside ? previous.scroll : undefined
    };
    if (!fromInside) {
      if (board.layout() === 'list') { current.scroll = scroller().scrollTop; scroller().scrollTop = 0; }
      drawer.scrollTop = 0;
    }
    heading.textContent = c.title;
    setRefusal('');
    renderHead();
    renderBody();
    drawer.hidden = false;
    board.post({ type: 'detail', itemId: id });
    heading.focus();
    syncSelection();
  }

  function close(restore) {
    if (!current) return;
    const { opener, originId, scroll } = current;
    current = undefined;
    drawer.hidden = true;
    body.replaceChildren();
    moveBtn.setAttribute('aria-expanded', 'false');
    syncSelection();
    if (scroll !== undefined && board.layout() === 'list') scroller().scrollTop = scroll;
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

  // The model changed under an open detail: follow the card, ask the host again when it changed, and let go when it left the board.
  board.onRender(() => {
    if (current) {
      const c = board.cardData(current.id);
      if (!c) {
        close(false);
        board.announce(T.gone);
        const first = document.querySelector('.card-main');
        if (first) first.focus();
        return;
      }
      const sig = JSON.stringify(c);
      if (sig !== current.sig) {
        current.sig = sig;
        setRefusal('');
        board.post({ type: 'detail', itemId: current.id });
      }
      renderHead();
    }
    syncSelection();
  });

  board.onMessage('detail', (m) => {
    if (!current || m.itemId !== current.id) return;
    const sig = JSON.stringify(m);
    if (sig === current.detailSig) return;
    current.detailSig = sig;
    current.detail = m;
    heading.textContent = m.title;
    renderHead();
    renderBody();
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected) heading.focus();
  });

  // The host refused something about the open card (the detail itself, or a move started from the Move to... button here).
  board.onMessage('refused', (m) => {
    if (!current || m.itemId !== current.id) return;
    const reason = typeof m.reason === 'string' ? m.reason : '';
    setRefusal(reason);
    if (reason && !current.detail) body.replaceChildren();
  });

  window.NearAiBoard.registerDetail(open);
}());

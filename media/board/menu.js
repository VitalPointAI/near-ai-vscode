// Team Board Move to... menu (62-UI-SPEC "Moving Cards"): lists exactly the moves the host offered for a card, sends one move request and shows the
// pending line. The page never decides whether a move is allowed; the host checks it again on fresh state. Plain browser JavaScript in an IIFE that
// plugs into board.js through window.NearAiBoard. Text nodes only, attributes with setAttribute, no markup strings.
(function () {
  'use strict';
  const board = window.NearAiBoard;
  if (!board) return;
  const SEPARATED = ['block', 'unblock'];

  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);

  let current; // { id, opener, sig }
  // Moves this menu sent that the host has not answered: item id -> { column, key, opener }. Only these refusals are drawn here, because the
  // drop handler and the form post their own requests and show their own refusals.
  const awaiting = {};
  const signature = (moves) => moves.map((m) => m.key + ':' + m.label).join('|');
  const stateKey = (c) => JSON.stringify([c.column, !!c.blocked, c.held]);

  const columnLabel = (key) => {
    const model = board.model();
    const found = model && key ? model.columns.find((c) => c.key === key) : undefined;
    return found ? found.label : '';
  };
  const itemNodes = () => Array.from(menu.querySelectorAll('[role="menuitem"]'));
  const isOpen = () => !menu.hidden && !!current;

  function mark(opener, expanded) {
    if (opener && opener.classList && opener.classList.contains('move-btn')) opener.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function position(opener) {
    const rect = opener.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const width = window.innerWidth || 0;
    const height = window.innerHeight || 0;
    let left = rect.left;
    let top = rect.bottom + 2;
    if (width && box.width && left + box.width > width - 8) left = Math.max(8, width - box.width - 8);
    if (height && box.height && top + box.height > height - 8 && rect.top - box.height - 2 >= 0) top = rect.top - box.height - 2;
    menu.style.setProperty('left', Math.max(0, left) + 'px');
    menu.style.setProperty('top', Math.max(0, top) + 'px');
  }

  /** Closes the menu. With restore the focus goes back to the control that opened it (or to the card when that control is gone). */
  function close(restore) {
    if (!current) return;
    const { id, opener } = current;
    current = undefined;
    menu.hidden = true;
    menu.replaceChildren();
    mark(opener, false);
    if (restore) refocus(id, opener);
  }

  function refocus(id, opener) {
    if (opener && opener.isConnected && !opener.hidden) opener.focus();
    else board.focusCard(id);
  }

  function choose(move) {
    if (!current) return;
    const { id, opener } = current;
    close(true);
    const label = columnLabel(move.column);
    const c = board.cardData(id);
    awaiting[id] = { column: label, key: c ? stateKey(c) : '', opener };
    board.setPending(id, move.column && label ? 'Moving to ' + label + '...' : 'Saving...');
    board.post({ type: 'move', itemId: id, target: move.key });
  }

  function open(id, opener) {
    const c = board.cardData(id);
    const model = board.model();
    if (!c || !model || c.moves.length === 0 || ['offline', 'paused', 'removed'].indexOf(model.status.kind) >= 0) return;
    if (current && current.id === id && current.opener === opener) { close(true); return; }
    close(false);
    const nodes = [];
    c.moves.forEach((move, index) => {
      if (index > 0 && SEPARATED.indexOf(move.key) >= 0 && SEPARATED.indexOf(c.moves[index - 1].key) < 0) {
        const bar = document.createElement('div');
        bar.setAttribute('role', 'separator');
        nodes.push(bar);
      }
      const item = document.createElement('button');
      item.setAttribute('type', 'button');
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      item.setAttribute('data-key', move.key);
      item.textContent = move.label;
      item.addEventListener('click', () => choose(move));
      nodes.push(item);
    });
    menu.setAttribute('aria-label', 'Move ' + c.displayId + ' to');
    menu.replaceChildren(...nodes);
    current = { id, opener, sig: signature(c.moves) };
    mark(opener, true);
    menu.hidden = false;
    position(opener);
    itemNodes()[0].focus();
  }

  function step(delta) {
    const list = itemNodes();
    const at = list.indexOf(document.activeElement);
    list[(at + delta + list.length) % list.length].focus();
  }

  menu.addEventListener('keydown', (e) => {
    if (!isOpen() || e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); step(1); break;
      case 'ArrowUp': e.preventDefault(); step(-1); break;
      case 'Home': e.preventDefault(); itemNodes()[0].focus(); break;
      case 'End': e.preventDefault(); itemNodes()[itemNodes().length - 1].focus(); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break;
      // Focus goes to the opener first and the key is left alone, so the browser carries on from the opener to the next element in page order.
      case 'Tab': close(true); break;
      default: if (e.key.length === 1 && e.key !== ' ') { e.preventDefault(); jump(e.key); } break;
    }
  });

  /** Moves focus to the next item that starts with the letter, after the focused one and wrapping round. */
  function jump(letter) {
    const list = itemNodes();
    const at = list.indexOf(document.activeElement);
    const wanted = letter.toLowerCase();
    for (let i = 1; i <= list.length; i += 1) {
      const item = list[(at + i + list.length) % list.length];
      if (item.textContent.charAt(0).toLowerCase() === wanted) { item.focus(); return; }
    }
  }

  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    const target = e.target;
    if (menu.contains(target) || (current.opener && current.opener.contains(target))) return;
    close(false);
  });

  // The list can change under an open menu (a teammate moved the card, or it left the board): never offer moves the model no longer has.
  board.onRender(() => {
    if (!isOpen()) return;
    const c = board.cardData(current.id);
    if (!c || c.moves.length === 0 || signature(c.moves) !== current.sig) { close(!!c && c.moves.length > 0); return; }
    position(current.opener);
  });

  // The host answered a request from this menu. A reason is shown on the card and announced once; an empty reason is a dismissed prompt, which
  // board.js already cleared silently.
  board.onMessage('refused', (m) => {
    const wait = awaiting[m.itemId];
    if (!wait) return;
    delete awaiting[m.itemId];
    if (m.reason) {
      board.showRefusal(m.itemId, wait.column, m.reason);
      refocus(m.itemId, wait.opener && wait.opener.classList && wait.opener.classList.contains('move-btn') ? wait.opener : cardButton(m.itemId));
    } else if (document.activeElement === document.body) refocus(m.itemId, wait.opener);
  });
  // A state that shows the move happened ends the wait.
  board.onMessage('state', () => {
    for (const id of Object.keys(awaiting)) {
      const c = board.cardData(id);
      if (!c || stateKey(c) !== awaiting[id].key) delete awaiting[id];
    }
  });
  function cardButton(id) {
    const li = board.cardElement(id);
    return li ? li.querySelector('.move-btn') : undefined;
  }

  window.NearAiBoard.registerMenu(open);
}());

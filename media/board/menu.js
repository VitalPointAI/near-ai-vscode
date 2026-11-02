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

  let current; // { id, opener, moves }

  const columnLabel = (key) => {
    const model = board.model();
    const found = model && key ? model.columns.find((c) => c.key === key) : undefined;
    return found ? found.label : '';
  };
  const itemNodes = () => menu.querySelectorAll('[role="menuitem"]');
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
    const { id } = current;
    close(true);
    const label = columnLabel(move.column);
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
    current = { id, opener, moves: c.moves };
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
      default: break;
    }
  });

  window.NearAiBoard.registerMenu(open);
}());

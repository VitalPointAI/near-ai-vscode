// Sidebar Team section (G-61-5). The host sends {type:'team-state', model} with the heading, one status line, the buttons to show and an optional board
// line; this script draws them with createElement and textContent only and posts {type:'team-action', action} for a fixed list of action ids. It posts
// through chat.js's window.nearChat (the page's one VS Code API), never stores page state and adds no animation. The extension-host tests (and only
// they: the host sends the probe only under NEAR_AI_E2E=1) ask with {type:'team-e2e', id, click?} what is drawn, and may click a drawn button.
// The section is drawn only while the project has a working NEAR AI profile (61-25, G-61-7): readiness.js (window.nearReadiness) is the one rule,
// read from the profile-status messages the host sends. Until then the latest model is kept but nothing team-related can be seen or clicked.
(function () {
  'use strict';

  // The only action ids a click may post, the same list as TEAM_ACTION_IDS in src/domain/team/teamSection.ts (a test keeps the two equal).
  const ACTIONS = Object.freeze(['turn-on', 'join', 'share', 'invite', 'members', 'board', 'link', 'check']);
  const NOT_SHOWN = 'That action is not shown in the Team section.';
  // The probe's answer to a click while the whole section is hidden.
  const HIDDEN = 'hidden';
  const STATUS_ID = 'team-status';
  const chat = window.nearChat;
  const section = document.getElementById('team');
  if (!section || !chat || typeof chat.post !== 'function') return;
  // The readiness rule; when it is missing the profile counts as not working.
  const readiness = window.nearReadiness && typeof window.nearReadiness.current === 'function' ? window.nearReadiness : null;

  // The parts of the section, built on the first model and dropped when the host sends null.
  let parts = null;
  // Drawn buttons by action id, so an update changes them in place and focus is not lost.
  let drawn = new Map();
  // The latest model from the host, drawn while the profile works.
  let latest = null;

  function profileState() {
    const state = readiness ? readiness.current() : undefined;
    return typeof state === 'string' ? state : null;
  }

  // Hides the section; focus that was on one of its buttons moves to the message box instead of being lost.
  function conceal() {
    const focused = document.activeElement;
    const hadFocus = Boolean(focused) && focused !== section && section.contains(focused);
    section.hidden = true;
    if (!hadFocus) return;
    const input = document.getElementById('input');
    if (input && typeof input.focus === 'function') input.focus();
  }

  // Draws the latest model while the profile works, and hides the section otherwise.
  function show() {
    if (profileState() === 'ready' && latest) render(latest);
    else if (latest) conceal();
    else render(null);
  }

  function receive(model) {
    latest = model && typeof model === 'object' ? model : null;
    show();
  }

  function text(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = typeof value === 'string' ? value : '';
    return node;
  }

  function build() {
    const heading = text('h2', 'team-heading', '');
    const status = text('p', 'team-status', '');
    status.id = STATUS_ID;
    status.setAttribute('aria-live', 'polite');
    const board = text('p', 'team-board', '');
    const row = document.createElement('div');
    row.className = 'team-actions';
    section.replaceChildren(heading, status, row);
    return { heading, status, board, row };
  }

  // The id a button posts comes from ACTIONS itself, bound in this closure when the button is made, never from the element or a later message.
  function makeButton(id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-action', id);
    const label = text('span', 'team-label', '');
    const badge = text('span', 'team-badge', '');
    button.append(label);
    button.addEventListener('click', () => { chat.post({ type: 'team-action', action: id }); });
    return { id, button, label, badge };
  }

  function update(entry, action) {
    const label = typeof action.label === 'string' ? action.label : '';
    const badge = typeof action.badge === 'string' ? action.badge : '';
    const primary = action.primary === true;
    entry.label.textContent = label;
    entry.badge.textContent = badge;
    if (badge) {
      if (entry.badge.parentNode !== entry.button) entry.button.append(entry.badge);
      entry.button.setAttribute('aria-label', label + ', ' + badge);
    } else {
      entry.badge.remove();
      entry.button.removeAttribute('aria-label');
    }
    if (typeof action.hint === 'string' && action.hint) entry.button.title = action.hint;
    else entry.button.removeAttribute('title');
    entry.button.className = primary ? 'team-action primary' : 'team-action';
    if (primary) entry.button.setAttribute('aria-describedby', STATUS_ID);
    else entry.button.removeAttribute('aria-describedby');
    entry.primary = primary;
  }

  function render(model) {
    if (!model || typeof model !== 'object') {
      if (!section.hidden) conceal();
      section.replaceChildren();
      section.hidden = true;
      parts = null;
      drawn = new Map();
      return;
    }
    if (parts === null || parts.heading.parentNode !== section) parts = build();
    const compact = model.compact === true;
    section.classList.toggle('compact', compact);
    parts.heading.textContent = typeof model.heading === 'string' ? model.heading : '';
    parts.heading.hidden = compact;
    parts.status.textContent = typeof model.status === 'string' ? model.status : '';

    const board = model.board && typeof model.board === 'object' && typeof model.board.text === 'string' ? model.board.text : '';
    if (board) {
      parts.board.textContent = board;
      if (parts.board.parentNode !== section) section.insertBefore(parts.board, parts.row);
    } else {
      parts.board.remove();
    }

    // Known ids only, each once, the primary one first.
    const next = new Map();
    const list = Array.isArray(model.actions) ? model.actions : [];
    for (const action of list) {
      if (!action || typeof action !== 'object') continue;
      const at = ACTIONS.indexOf(action.id);
      if (at === -1 || next.has(ACTIONS[at])) continue;
      const entry = drawn.get(ACTIONS[at]) || makeButton(ACTIONS[at]);
      update(entry, action);
      next.set(entry.id, entry);
    }
    const ordered = [...next.values()].sort((a, b) => Number(b.primary) - Number(a.primary));
    const current = Array.from(parts.row.children);
    const same = current.length === ordered.length && ordered.every((entry, index) => current[index] === entry.button);
    if (!same) {
      const focused = document.activeElement;
      parts.row.replaceChildren(...ordered.map((entry) => entry.button));
      const kept = ordered.find((entry) => entry.button === focused);
      if (kept) kept.button.focus();
    }
    drawn = next;
    section.hidden = false;
  }

  // What the section shows, read from the drawn elements.
  function describe() {
    if (parts === null || section.hidden) return { heading: '', status: '', actions: [], hidden: true, profile: profileState() };
    const actions = [];
    for (const button of Array.from(parts.row.children)) {
      const entry = [...drawn.values()].find((candidate) => candidate.button === button);
      if (!entry) continue;
      const fact = { id: entry.id, label: entry.label.textContent };
      if (entry.badge.parentNode === button && entry.badge.textContent) fact.badge = entry.badge.textContent;
      actions.push(fact);
    }
    return { heading: parts.heading.textContent, status: parts.status.textContent, actions, hidden: false, profile: profileState() };
  }

  function probe(message) {
    if (typeof message.id !== 'number' || !Number.isFinite(message.id)) return;
    let error;
    if (message.click !== undefined) {
      const entry = typeof message.click === 'string' && !section.hidden ? drawn.get(message.click) : undefined;
      if (section.hidden) error = HIDDEN;
      else if (entry && entry.button.isConnected) entry.button.click();
      else error = NOT_SHOWN;
    }
    const facts = Object.assign({ type: 'team-e2e-facts', id: message.id }, describe());
    if (error) facts.error = error;
    chat.post(facts);
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'team-state') receive(message.model);
    else if (message.type === 'team-e2e') probe(message);
  });

  if (readiness && typeof readiness.onChange === 'function') readiness.onChange(show);

  window.nearTeam = Object.freeze({ render: receive });
})();

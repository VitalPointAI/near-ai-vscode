// Sidebar Team section (G-61-5). The host sends {type:'team-state', model} with the heading, one status line, the buttons to show and an optional board
// line; this script draws them with createElement and textContent only and posts {type:'team-action', action} for a fixed list of action ids. It posts
// through chat.js's window.nearChat (the page's one VS Code API), never stores page state and adds no animation. The extension-host tests (and only
// they: the host sends the probe only under NEAR_AI_E2E=1) ask with {type:'team-e2e', id, click?} what is drawn, and may click a drawn button.
// The section is drawn only while the project has a working NEAR AI profile (61-25, G-61-7): readiness.js (window.nearReadiness) is the one rule,
// read from the profile-status messages the host sends. Until then the latest model is kept but nothing team-related can be seen or clicked.
// After Just me for now (61-26, G-61-8) the model's placement is empty-chat-line: the section is hidden and its status and actions are one quiet line
// (p.team-solo) inside #welcome, the empty chat's welcome that chat.js hides during a conversation, so the line is never shown there.
// While no profile works (61-30, G-61-9) the model's connect part is the team way in on the Connect screen: with PR #7's Connect panel
// (#welcome-connect, 0.4.14) on the page, one div.team-connect group is added inside it and none of the panel's own elements is touched; without
// it (this branch), one small Connect block (section#team-connect) inside #welcome has the panel's title, a new profile, a saved profile and the
// team buttons. Set up a new profile and Use a saved profile post the chat's own open-setup and select-profile messages.
(function () {
  'use strict';

  // The only action ids a click may post, the same list as TEAM_ACTION_IDS in src/domain/team/teamSection.ts (a test keeps the two equal).
  const ACTIONS = Object.freeze(['invite', 'join', 'ask', 'solo', 'share', 'members', 'board', 'link', 'check']);
  const LINE_PLACEMENT = 'empty-chat-line';
  const NOT_SHOWN = 'That action is not shown in the Team section.';
  // The probe's answer to a click while the whole section is hidden.
  const HIDDEN = 'hidden';
  const STATUS_ID = 'team-status';
  // PR #7's Connect panel and its own profile choice (read only), and the id of the Connect block drawn when the panel is not on the page.
  const PANEL_ID = 'welcome-connect';
  const PANEL_CHOICE_ID = 'welcome-choose-profile';
  const BLOCK_ID = 'team-connect';
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
  // The quiet empty-chat line: its paragraph, text and link buttons by action id; null while it is not drawn.
  let line = null;
  // The Connect part: its node (the group inside PR #7's panel, or the Connect block), its status, its row and team buttons by action id, and the
  // two profile buttons; null while it is not drawn.
  let connect = null;

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

  // Draws the latest model while the profile works, and hides the section and the line otherwise. The Connect part is the other way round.
  function show() {
    showConnect();
    const ready = profileState() === 'ready';
    if (ready && latest && latest.placement === LINE_PLACEMENT) {
      render(null);
      drawLine(latest);
      return;
    }
    removeLine();
    if (ready && latest) render(latest);
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

  // The quiet line inside the empty chat's welcome: the status text, then each action as a link-styled button with the same closure-bound click.
  function drawLine(model) {
    const welcome = document.getElementById('welcome');
    if (!welcome) {
      removeLine();
      return;
    }
    if (line === null) {
      const node = document.createElement('p');
      node.className = 'team-solo';
      line = { node, text: text('span', 'team-solo-text', ''), drawn: new Map() };
    }
    if (line.node.parentNode !== welcome) welcome.append(line.node);
    line.text.textContent = typeof model.status === 'string' ? model.status : '';
    const next = new Map();
    const list = Array.isArray(model.actions) ? model.actions : [];
    for (const action of list) {
      if (!action || typeof action !== 'object') continue;
      const at = ACTIONS.indexOf(action.id);
      if (at === -1 || next.has(ACTIONS[at])) continue;
      const entry = line.drawn.get(ACTIONS[at]) || makeButton(ACTIONS[at]);
      update(entry, action);
      entry.button.className = 'link team-solo-action';
      entry.button.removeAttribute('aria-describedby');
      next.set(entry.id, entry);
    }
    const children = [line.text];
    for (const entry of next.values()) children.push(' ', entry.button);
    const focused = document.activeElement;
    line.node.replaceChildren(...children);
    const kept = [...next.values()].find((entry) => entry.button === focused);
    if (kept) kept.button.focus();
    line.drawn = next;
  }

  function removeLine() {
    if (line === null) return;
    const focused = document.activeElement;
    const hadFocus = Boolean(focused) && line.node.contains(focused);
    line.node.remove();
    line = null;
    if (!hadFocus) return;
    const input = document.getElementById('input');
    if (input && typeof input.focus === 'function') input.focus();
  }

  // Whether a node is on the page and neither it nor an element above it is hidden (the welcome is hidden during a conversation). The walk stops at the
  // Document: its hidden is the page visibility (true while another window covers this one), not a hidden element, and it never puts the line away.
  function shown(node) {
    if (!node.isConnected) return false;
    for (let at = node; at && at.nodeType === 1; at = at.parentNode) if (at.hidden === true) return false;
    return true;
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

  // ---- the Connect screen (61-30) ----

  function words(value) {
    return typeof value === 'string' ? value : '';
  }

  // Only while the profile state is known and not working, with a folder open and a connect part from the host.
  function showConnect() {
    const state = profileState();
    const part = latest && latest.connect && typeof latest.connect === 'object' ? latest.connect : null;
    if (part === null || state === null || state === 'ready' || state === 'no-folder') {
      removeConnect();
      return;
    }
    drawConnect(part);
  }

  // A profile button: the message it posts is fixed here, in this closure, never read from the element or a message.
  function profileButton(className, message) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.addEventListener('click', () => { chat.post({ type: message }); });
    return button;
  }

  function buildConnect(inPanel) {
    const status = text('p', 'team-connect-status', '');
    status.setAttribute('aria-live', 'polite');
    const row = document.createElement('div');
    row.className = 'team-connect-actions';
    const saved = profileButton('text-button', 'select-profile');
    if (inPanel) {
      const node = document.createElement('div');
      node.className = 'team-connect';
      node.append(status, row);
      return { node, inPanel, status, row, drawn: new Map(), saved };
    }
    const node = document.createElement('section');
    node.id = BLOCK_ID;
    node.className = 'team-connect-block';
    node.setAttribute('role', 'region');
    node.setAttribute('aria-labelledby', BLOCK_ID + '-title');
    const title = text('h2', '', '');
    title.id = BLOCK_ID + '-title';
    const body = text('p', 'team-connect-body', '');
    const setup = profileButton('text-button primary', 'open-setup');
    node.append(title, body, status, row);
    return { node, inPanel, status, row, drawn: new Map(), saved, title, body, setup };
  }

  function drawConnect(part) {
    const panel = document.getElementById(PANEL_ID);
    const place = panel || document.getElementById('welcome');
    if (!place) {
      removeConnect();
      return;
    }
    const inPanel = Boolean(panel);
    if (connect !== null && connect.inPanel !== inPanel) removeConnect();
    if (connect === null) connect = buildConnect(inPanel);
    if (connect.node.parentNode !== place) {
      if (inPanel) place.append(connect.node);
      else place.prepend(connect.node);
    }
    const fallback = part.fallback && typeof part.fallback === 'object' ? part.fallback : {};
    if (!inPanel) {
      connect.title.textContent = words(fallback.title);
      connect.body.textContent = words(fallback.body);
      connect.setup.textContent = words(fallback.setupLabel);
    }
    connect.saved.textContent = words(fallback.savedLabel);
    const status = words(part.status);
    connect.status.textContent = status;
    connect.status.hidden = status === '';

    // Known ids only, each once, in the host's order.
    const next = new Map();
    const list = Array.isArray(part.actions) ? part.actions : [];
    for (const action of list) {
      if (!action || typeof action !== 'object') continue;
      const at = ACTIONS.indexOf(action.id);
      if (at === -1 || next.has(ACTIONS[at])) continue;
      const entry = connect.drawn.get(ACTIONS[at]) || makeButton(ACTIONS[at]);
      update(entry, Object.assign({}, action, { primary: false }));
      entry.button.className = 'text-button team-connect-action';
      entry.button.removeAttribute('aria-describedby');
      next.set(entry.id, entry);
    }
    // Use a saved profile: always in the Connect block; in PR #7's panel only while the panel shows no profile choice of its own.
    const choice = inPanel ? document.getElementById(PANEL_CHOICE_ID) : null;
    const offerSaved = !inPanel || !choice || choice.hidden === true;
    const team = [...next.values()].map((entry) => entry.button);
    const children = inPanel ? team.concat(offerSaved ? [connect.saved] : []) : [connect.setup, connect.saved].concat(team);
    const current = Array.from(connect.row.children);
    const same = current.length === children.length && children.every((child, index) => current[index] === child);
    if (!same) {
      const focused = document.activeElement;
      connect.row.replaceChildren(...children);
      if (children.includes(focused)) focused.focus();
    }
    connect.drawn = next;
  }

  function removeConnect() {
    if (connect === null) return;
    const focused = document.activeElement;
    const hadFocus = Boolean(focused) && connect.node.contains(focused);
    connect.node.remove();
    connect = null;
    if (!hadFocus) return;
    const input = document.getElementById('input');
    if (input && typeof input.focus === 'function') input.focus();
  }

  // Whether a node takes up space on the screen (a hidden or empty one does not).
  function laidOut(node) {
    if (!node || node.hidden === true || typeof node.getBoundingClientRect !== 'function') return false;
    const box = node.getBoundingClientRect();
    return Boolean(box) && box.height > 0;
  }

  // 61-32: the space in whole pixels above the team group, for the real-window check. Inside PR #7's panel the group is measured from the element
  // before it; in this branch's Connect block the status (or the row, while there is no status) is measured from the element before it. Null when
  // nothing is laid out.
  function gapAbove() {
    const first = connect.inPanel ? connect.node : [connect.status, connect.row].find(laidOut);
    if (!laidOut(first) || !first.parentNode) return null;
    const siblings = Array.from(first.parentNode.children);
    let above = null;
    for (let at = siblings.indexOf(first) - 1; at >= 0 && above === null; at -= 1) if (laidOut(siblings[at])) above = siblings[at];
    if (above === null) return null;
    return Math.round(first.getBoundingClientRect().top - above.getBoundingClientRect().bottom);
  }

  // What the Connect part shows, or null when it is not drawn or not shown, by the same rule as a click on it.
  function describeConnect() {
    if (connect === null || !shown(connect.node)) return null;
    const actions = [];
    for (const entry of connect.drawn.values()) actions.push({ id: entry.id, label: entry.label.textContent });
    return { status: connect.status.textContent, actions, inPanel: connect.inPanel, gapAbovePx: gapAbove() };
  }

  // What the quiet empty-chat line shows, or null when it is not drawn or not shown: the same rule as a click on it, so a line the facts report
  // can be clicked.
  function describeLine() {
    if (line === null || !shown(line.node)) return null;
    const actions = [];
    for (const entry of line.drawn.values()) actions.push({ id: entry.id, label: entry.label.textContent });
    return { text: line.text.textContent, actions };
  }

  // What the section shows, read from the drawn elements.
  function describe() {
    if (parts === null || section.hidden) return { heading: '', status: '', actions: [], hidden: true, profile: profileState(), soloLine: describeLine(), connect: describeConnect() };
    const actions = [];
    for (const button of Array.from(parts.row.children)) {
      const entry = [...drawn.values()].find((candidate) => candidate.button === button);
      if (!entry) continue;
      const fact = { id: entry.id, label: entry.label.textContent };
      if (entry.badge.parentNode === button && entry.badge.textContent) fact.badge = entry.badge.textContent;
      actions.push(fact);
    }
    const facts = { heading: parts.heading.textContent, status: parts.status.textContent, actions, hidden: false, profile: profileState(), soloLine: describeLine(), connect: describeConnect() };
    // The board line, only while it is drawn.
    if (parts.board.parentNode === section && parts.board.textContent) facts.board = parts.board.textContent;
    return facts;
  }

  function probe(message) {
    if (typeof message.id !== 'number' || !Number.isFinite(message.id)) return;
    let error;
    if (message.click !== undefined) {
      const id = typeof message.click === 'string' ? message.click : undefined;
      const entry = id !== undefined && !section.hidden ? drawn.get(id) : undefined;
      // An action of the quiet line is clicked only while a person could see it (not during a conversation).
      const inLine = id !== undefined && line !== null ? line.drawn.get(id) : undefined;
      // And a team action of the Connect part, while it is shown.
      const inConnect = id !== undefined && connect !== null ? connect.drawn.get(id) : undefined;
      if (entry && entry.button.isConnected) entry.button.click();
      else if (inLine && shown(inLine.button)) inLine.button.click();
      else if (inConnect && shown(inConnect.button)) inConnect.button.click();
      else if (section.hidden) error = HIDDEN;
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
    // Drawn again after chat.js (loaded before this script) has handled the same profile-status, so PR #7's panel already shows its own
    // profile choice or not when the group decides whether to offer Use a saved profile.
    else if (message.type === 'profile-status') show();
  });

  if (readiness && typeof readiness.onChange === 'function') readiness.onChange(show);

  window.nearTeam = Object.freeze({ render: receive });
})();

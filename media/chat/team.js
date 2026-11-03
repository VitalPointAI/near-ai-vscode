// Sidebar Team section (G-61-5). The host sends {type:'team-state', model} with the heading, one status line and the buttons to show; this script draws
// them with createElement and textContent only and posts {type:'team-action', action} for a fixed list of action ids. It posts through chat.js's
// window.nearChat (the page's one VS Code API) and never stores page state.
(function () {
  'use strict';

  // The only action ids a click may post, the same list as TEAM_ACTION_IDS in src/domain/team/teamSection.ts.
  const ACTIONS = Object.freeze(['turn-on', 'join', 'share', 'invite', 'members', 'board', 'link', 'check']);
  const chat = window.nearChat;
  const section = document.getElementById('team');
  if (!section || !chat || typeof chat.post !== 'function') return;

  const STATUS_ID = 'team-status';

  function text(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = typeof value === 'string' ? value : '';
    return node;
  }

  // The id a button posts comes from ACTIONS itself, bound in this closure, never from the element or the message.
  function actionButton(action) {
    const at = ACTIONS.indexOf(action.id);
    if (at === -1) return null;
    const id = ACTIONS[at];
    const button = text('button', action.primary === true ? 'team-action primary' : 'team-action', action.label);
    button.type = 'button';
    button.setAttribute('data-action', id);
    if (action.primary === true) button.setAttribute('aria-describedby', STATUS_ID);
    button.addEventListener('click', () => { chat.post({ type: 'team-action', action: id }); });
    return button;
  }

  function render(model) {
    if (!model || typeof model !== 'object') {
      section.replaceChildren();
      section.hidden = true;
      return;
    }
    const status = text('p', 'team-status', model.status);
    status.id = STATUS_ID;
    const row = document.createElement('div');
    row.className = 'team-actions';
    const actions = Array.isArray(model.actions) ? model.actions : [];
    for (const action of actions) {
      const button = action && typeof action === 'object' ? actionButton(action) : null;
      if (button) row.append(button);
    }
    section.replaceChildren(text('h2', 'team-heading', model.heading), status, row);
    section.hidden = false;
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'team-state') render(message.model);
  });
})();

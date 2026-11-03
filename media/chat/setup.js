// The "no team yet" card at the top of an empty chat. The host decides when it shows (a working
// profile, no project team, not dismissed); this only draws it and reports the click.
(function (root) {
  'use strict';

  const TEXT = {
    title: 'This project has no team yet',
    body: 'A project team is the set of agents that work on this project and the models they use. Setting it up takes a minute.',
    team: 'Set up your project team',
    later: 'Not now',
    menu: 'All setup steps'
  };

  /**
   * Shows the card at the top of `container` (the empty chat's welcome section) when `show` is
   * true, and removes it otherwise. `post` sends the choice to the host; `afterDismiss` puts focus
   * back in the message box when the card goes away under it. Returns the card or undefined.
   */
  function renderSetupNudge(doc, container, show, post, afterDismiss) {
    const existing = doc.getElementById('setup-nudge');
    if (!show) {
      if (existing) {
        // Focus on one of its buttons moves to the message box instead of being lost.
        const hadFocus = Boolean(doc.activeElement) && existing.contains(doc.activeElement);
        existing.remove();
        if (hadFocus && afterDismiss) afterDismiss();
      }
      return undefined;
    }
    if (existing) return existing;
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (label, className, action) => {
      const node = make('button', className, label);
      node.type = 'button';
      node.addEventListener('click', () => {
        if (action === 'later') { card.remove(); if (afterDismiss) afterDismiss(); }
        post({ type: 'setup-nudge', action: action });
      });
      return node;
    };
    const card = make('section', 'setup-nudge');
    card.id = 'setup-nudge';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-labelledby', 'setup-nudge-title');
    const title = make('h3', '', TEXT.title);
    title.id = 'setup-nudge-title';
    const actions = make('div', 'setup-nudge-actions');
    actions.append(button(TEXT.team, 'text-button primary', 'team'), button(TEXT.later, 'text-button', 'later'), button(TEXT.menu, 'link', 'menu'));
    card.append(title, make('p', '', TEXT.body), actions);
    container.prepend(card);
    return card;
  }

  const api = { renderSetupNudge, TEXT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearSetup = api;
})(typeof window === 'undefined' ? globalThis : window);

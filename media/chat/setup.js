// The empty chat's welcome: the Connect NEAR AI panel until the project has a working profile,
// and the "no team yet" card at the top of the usual welcome. The host decides when the card shows
// (a working profile, no project team, not dismissed); this only draws it and reports the click.
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

  /**
   * Which welcome the empty chat shows, from the host's profile-status value: 'ready' with a
   * working profile (its key checked), 'choose' when profiles exist but none works, 'connect'
   * when there is none.
   */
  function welcomeState(value) {
    const profiles = (value && Array.isArray(value.profiles)) ? value.profiles : [];
    const active = profiles.find((item) => item && item.profileId === value.activeProfileId);
    if (active && active.validation && active.validation.status === 'valid') return 'ready';
    return profiles.length ? 'choose' : 'connect';
  }

  /**
   * Shows the welcome for `state`: the Connect NEAR AI panel (with Choose a profile and its reason
   * only for 'choose'), or the usual welcome with its suggestion cards. Elements by id:
   * welcome-ready, welcome-connect, welcome-connect-reason, welcome-choose-profile,
   * welcome-new-profile. Returns the button to focus: the primary one, the first time the Connect
   * panel appears, and only when the person is not typing a message.
   */
  function applyWelcomeState(doc, state, memory) {
    const byId = (id) => doc.getElementById(id);
    const connecting = state !== 'ready';
    const ready = byId('welcome-ready');
    const connect = byId('welcome-connect');
    if (ready) ready.hidden = connecting;
    if (connect) connect.hidden = !connecting;
    const reason = byId('welcome-connect-reason');
    const choose = byId('welcome-choose-profile');
    if (reason) reason.hidden = state !== 'choose';
    if (choose) choose.hidden = state !== 'choose';
    if (!connecting || memory.connectShown) return undefined;
    memory.connectShown = true;
    const active = doc.activeElement;
    const typing = Boolean(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && Boolean(active.value);
    return typing ? undefined : byId('welcome-new-profile') || undefined;
  }

  const api = { renderSetupNudge, welcomeState, applyWelcomeState, TEXT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearSetup = api;
})(typeof window === 'undefined' ? globalThis : window);

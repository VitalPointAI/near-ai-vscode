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

  /** What the welcome's Connect panel says in each state. */
  const WELCOME = {
    'no-folder': { title: 'Open a folder to start', body: 'NEAR AI works in a project folder. Open the folder you want to work on, then connect NEAR AI.' },
    connect: { title: 'Connect NEAR AI to start', body: 'Connect NEAR AI to use private models in this project. Your key stays in VS Code\'s secure storage, never in your project files.' },
    choose: { title: 'Connect NEAR AI to start', body: 'Connect NEAR AI to use private models in this project. Your key stays in VS Code\'s secure storage, never in your project files.', reason: 'Your saved profile needs its key checked again.' },
    select: { title: 'Connect NEAR AI to start', body: 'Connect NEAR AI to use private models in this project. Your key stays in VS Code\'s secure storage, never in your project files.', reason: 'Choose which saved profile this project uses.' }
  };

  /**
   * Which welcome the empty chat shows, from the host's profile-status value:
   * - 'no-folder': no folder is open, so there is nothing to set up yet;
   * - 'ready': the selected profile works (its key was checked);
   * - 'choose': a saved profile needs its key checked again;
   * - 'select': saved profiles all work, but none is selected for this project;
   * - 'connect': no saved profile.
   */
  function welcomeState(value) {
    if (value && value.noWorkspace === true) return 'no-folder';
    const profiles = (value && Array.isArray(value.profiles)) ? value.profiles.filter(Boolean) : [];
    const works = (item) => Boolean(item.validation) && item.validation.status === 'valid';
    const active = profiles.find((item) => item.profileId === value.activeProfileId);
    if (active) return works(active) ? 'ready' : 'choose';
    if (!profiles.length) return 'connect';
    return profiles.every(works) ? 'select' : 'choose';
  }

  /** True when focus must not move: the window is in the background, or a text box or list (the message box, even empty, or the model picker) has focus. */
  function focusBusy(doc) {
    if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return true;
    const active = doc.activeElement;
    return Boolean(active) && /^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName || '');
  }

  /**
   * Shows the welcome for `state`: the Connect panel (its words, buttons and reason follow the
   * state), or the usual welcome with its suggestion cards. Elements by id: welcome-ready,
   * welcome-connect, welcome-connect-title, welcome-connect-body, welcome-connect-reason,
   * welcome-new-profile, welcome-choose-profile, welcome-open-folder, input.
   * Returns the element to focus, if any: the panel's main button the first time the panel shows
   * (never while focus is busy), or the message box when the panel goes away under the focus.
   */
  function applyWelcomeState(doc, state, memory) {
    const byId = (id) => doc.getElementById(id);
    const connecting = state !== 'ready';
    const ready = byId('welcome-ready');
    const connect = byId('welcome-connect');
    const focusInPanel = Boolean(connect) && !connect.hidden && Boolean(doc.activeElement) && connect.contains(doc.activeElement);
    const focused = focusInPanel ? doc.activeElement : undefined;
    if (ready) ready.hidden = connecting;
    if (connect) connect.hidden = !connecting;
    if (!connecting) return focusInPanel ? byId('input') || undefined : undefined;
    const words = WELCOME[state] || WELCOME.connect;
    const title = byId('welcome-connect-title');
    const body = byId('welcome-connect-body');
    const reason = byId('welcome-connect-reason');
    if (title) title.textContent = words.title;
    if (body) body.textContent = words.body;
    if (reason) { reason.hidden = !words.reason; reason.textContent = words.reason || ''; }
    const newProfile = byId('welcome-new-profile');
    const choose = byId('welcome-choose-profile');
    const openFolder = byId('welcome-open-folder');
    if (newProfile) newProfile.hidden = state === 'no-folder';
    if (choose) choose.hidden = state !== 'choose' && state !== 'select';
    if (openFolder) openFolder.hidden = state !== 'no-folder';
    const main = state === 'no-folder' ? openFolder : newProfile;
    // A button that just hid while it had focus hands it to the one now shown.
    if (focused && focused.hidden) return main || undefined;
    if (memory.connectShown) return undefined;
    memory.connectShown = true;
    return focusBusy(doc) ? undefined : main || undefined;
  }

  const api = { renderSetupNudge, welcomeState, applyWelcomeState, focusBusy, TEXT, WELCOME };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearSetup = api;
})(typeof window === 'undefined' ? globalThis : window);

// The empty chat's welcome: the provider setup panel until the project has a working profile,
// and the "no team yet" card at the top of the usual welcome. The host decides when the card shows
// (a working profile, no project team, not dismissed); this only draws it and reports the click.
(function (root) {
  'use strict';

  const TEXT = {
    title: 'This project has no team yet',
    body: 'A project team is the set of agents that work on this project and the models they use. Setting it up takes a minute.',
    team: 'Set up your project team',
    staff: 'Set up a staff team',
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
    // A military staff project starts from "Set up a staff team" (J2, J5, J3, J4), so it is offered here too, not only in the command palette.
    actions.append(button(TEXT.team, 'text-button primary', 'team'), button(TEXT.staff, 'text-button', 'staff'), button(TEXT.later, 'text-button', 'later'), button(TEXT.menu, 'link', 'menu'));
    card.append(title, make('p', '', TEXT.body), actions);
    container.prepend(card);
    return card;
  }

  const STAFF_TEXT = {
    title: 'Staff teams',
    body: 'Each staff section set up in this project has its own team. Task one to put its command in the message box; nothing is sent until you send it.',
    task: 'Task',
    setUp: 'Set up',
    setUpAnother: 'Set up another section',
    setUpAgain: 'Set up again',
    link: 'Link',
    missing: 'Missing from your teams: it was deleted or renamed.',
    none: 'Set up a section',
    found: 'Found in your teams but not linked to this project: ',
    problem: 'The staff settings could not be read: '
  };
  const SECTIONS = ['j2', 'j5', 'j3', 'j4'];
  const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

  /**
   * The host's list, checked before anything is drawn: only the four sections, each in a known state, and team names in the library's form. A section
   * not set up keeps only the library teams it could link (`candidates`) that are strings in that form, at most two; anything else in that field (not an
   * array, a number, a name not in the form) is dropped, so the renderer only ever sees an array of team names.
   */
  function staffModel(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.sections)) return undefined;
    const sections = value.sections.filter((entry) => entry && typeof entry === 'object' && SECTIONS.includes(entry.section)
      && ['ready', 'missing', 'none'].includes(entry.state) && typeof entry.code === 'string' && typeof entry.role === 'string'
      && (entry.state === 'none' || (typeof entry.team === 'string' && TEAM_NAME.test(entry.team))))
      .map((entry) => ({ ...entry, candidates: entry.state === 'none' && Array.isArray(entry.candidates)
        ? entry.candidates.filter((team) => typeof team === 'string' && TEAM_NAME.test(team)).slice(0, 2) : [] }));
    return { sections, problem: typeof value.problem === 'string' ? value.problem : '' };
  }

  /**
   * The "Staff teams" card of a staff project, in place of the "no team yet" card: each section with its team and a Task button that puts
   * `/team:<name> ` in the message box (`fill`, nothing sent), a missing team with "Set up again", and sections not set up yet with "Set up" (or "Link"
   * for a matching team already in the library, which the host confirms first). `model` undefined removes the card. Returns the card or undefined.
   */
  function renderStaffTeams(doc, container, value, post, fill) {
    const existing = doc.getElementById('staff-teams');
    const model = staffModel(value);
    const focusedKey = existing && doc.activeElement && existing.contains(doc.activeElement) && doc.activeElement.getAttribute ? doc.activeElement.getAttribute('data-key') : undefined;
    if (!model) { if (existing) existing.remove(); return undefined; }
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const keyed = [];
    const button = (label, className, key, onClick, aria) => {
      const node = make('button', className, label);
      node.type = 'button';
      node.setAttribute('data-key', key);
      if (aria) node.setAttribute('aria-label', aria);
      node.addEventListener('click', onClick);
      keyed.push(node);
      return node;
    };
    const card = make('section', 'setup-nudge staff-teams');
    card.id = 'staff-teams';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-labelledby', 'staff-teams-title');
    const title = make('h3', '', STAFF_TEXT.title);
    title.id = 'staff-teams-title';
    card.append(title, make('p', '', STAFF_TEXT.body));
    if (model.problem) card.append(make('p', 'staff-teams-problem', STAFF_TEXT.problem + model.problem));
    const list = make('ul', 'staff-teams-list');
    const notSetUp = [];
    for (const entry of model.sections) {
      const name = entry.code + ' ' + entry.role.toLowerCase();
      if (entry.state === 'none' && !entry.candidates.length) { notSetUp.push(entry); continue; }
      const item = make('li', 'staff-team s-' + entry.state);
      item.append(make('strong', '', entry.code));
      if (entry.state === 'ready') {
        item.append(make('span', 'staff-team-name', entry.team));
        if (typeof entry.title === 'string' && entry.title) item.append(make('span', 'staff-team-title', entry.title));
        const command = '/team:' + entry.team;
        item.append(button(STAFF_TEXT.task, 'text-button primary', 'task-' + entry.section, () => fill(command), 'Task the ' + name + ' team, ' + entry.team));
      } else if (entry.state === 'missing') {
        item.append(make('span', 'staff-team-name', entry.team), make('span', 'staff-team-missing', STAFF_TEXT.missing));
        item.append(button(STAFF_TEXT.setUpAgain, 'text-button', 'setup-' + entry.section, () => post({ type: 'staff-teams', action: 'set-up', section: entry.section }), 'Set up the ' + name + ' team again'));
      } else {
        const candidates = entry.candidates;
        item.append(make('span', 'staff-team-missing', STAFF_TEXT.found + candidates.join(', ')));
        for (const team of candidates) item.append(button(STAFF_TEXT.link + ' ' + team, 'text-button', 'link-' + entry.section + '-' + team, () => post({ type: 'staff-teams', action: 'link', section: entry.section, team: team }), 'Link ' + team + ' as this project\'s ' + name + ' team'));
        item.append(button(STAFF_TEXT.setUp, 'link', 'setup-' + entry.section, () => post({ type: 'staff-teams', action: 'set-up', section: entry.section }), 'Set up a new ' + name + ' team'));
      }
      list.append(item);
    }
    card.append(list);
    if (notSetUp.length) {
      const actions = make('div', 'setup-nudge-actions');
      const first = notSetUp.length === model.sections.length;
      actions.append(make('span', 'staff-teams-none', (first ? STAFF_TEXT.none : STAFF_TEXT.setUpAnother) + ':'));
      for (const entry of notSetUp) actions.append(button(entry.code + ' ' + entry.role.toLowerCase(), 'link', 'setup-' + entry.section, () => post({ type: 'staff-teams', action: 'set-up', section: entry.section }), STAFF_TEXT.setUp + ' the ' + entry.code + ' ' + entry.role.toLowerCase() + ' team'));
      card.append(actions);
    }
    if (existing) existing.remove();
    container.prepend(card);
    // A redraw keeps the keyboard focus on the same button.
    const again = focusedKey ? keyed.find((node) => node.getAttribute('data-key') === focusedKey) : undefined;
    if (again) again.focus();
    return card;
  }

  /** What the welcome's Connect panel says in each state. */
  const WELCOME = {
    'no-folder': { title: 'Open a folder to start', body: 'Open the folder you want to work on, then choose an AI provider.' },
    connect: { title: 'Connect AI to start', body: 'Choose a model provider for this project. Your choices include local models and NEAR AI Cloud.' },
    choose: { title: 'Connect AI to start', body: 'Choose a model provider for this project. Your choices include local models and NEAR AI Cloud.', reason: 'Your saved profile needs its connection checked again.' },
    select: { title: 'Connect AI to start', body: 'Choose a model provider for this project. Your choices include local models and NEAR AI Cloud.', reason: 'Choose which saved profile this project uses.' }
  };

  /**
   * Which welcome the empty chat shows, from the host's profile-status value:
   * - 'no-folder': no folder is open, so there is nothing to set up yet;
   * - 'ready': the selected profile passed validation and can be used with its current credentials;
   * - 'choose': a saved profile needs its connection checked again;
   * - 'select': saved profiles all work, but none is selected for this project;
   * - 'connect': no saved profile.
   */
  function welcomeState(value) {
    if (value && value.noWorkspace === true) return 'no-folder';
    const profiles = (value && Array.isArray(value.profiles)) ? value.profiles.filter(Boolean) : [];
    const works = (item) => Boolean(item.validation) && item.validation.status === 'valid';
    const active = profiles.find((item) => item.profileId === value.activeProfileId);
    if (active) return works(active) && (active.provider === 'local' || value.configured === true) ? 'ready' : 'choose';
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

  const api = { renderSetupNudge, renderStaffTeams, welcomeState, applyWelcomeState, focusBusy, TEXT, STAFF_TEXT, WELCOME };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearSetup = api;
})(typeof window === 'undefined' ? globalThis : window);

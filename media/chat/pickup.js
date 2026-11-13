// "Pick up where you left off" (D-03, SYNC-07): the card the empty chat shows when the project's last chat was continued in another editor or on
// another computer. The host decides when it shows and what it says; this only draws it and reports the click.
// Every word of data (a chat title, a phase name) is set with textContent, never as HTML. The two buttons are real buttons. Opening the chat only
// reopens it: nothing is resumed or run, and nothing is spent. A run that was cut off keeps its own Resume button inside the reopened chat.
(function (root) {
  'use strict';

  const TEXT = {
    title: 'Pick up where you left off',
    open: 'Open chat',
    later: 'Not now',
    locked: 'Locked on this device: enter your recovery code to open it',
    checking: 'Checking for updates…',
    runs: {
      finished: 'The last run finished.',
      'cut-off': 'The last run was cut off. Open the chat to see it. It only resumes when you press Resume there.',
      waiting: 'The last run is waiting for your answer in another editor.',
      'running-elsewhere': 'The last run is still going in another editor.'
    }
  };

  /** The sync control module's invitation, when it is loaded (in the page it is on `window`; in tests it is the module next to this one). */
  function syncControlKit() {
    if (root.nearSyncControl) return root.nearSyncControl;
    return typeof module === 'object' && module.exports && typeof require === 'function' ? require('./syncControl.js') : undefined;
  }

  /** The first-run invitation steps aside while this card carries one, and comes back when the card goes. */
  function refreshInvitation(doc) {
    const kit = syncControlKit();
    if (kit && kit.refreshSyncPrompt) kit.refreshSyncPrompt(doc);
  }

  /** How a time reads on the card: the panel's one display-time formatter (shared with the sync control), so the same instant reads the same. Empty when it is not valid or the helper is missing. */
  function when(iso) {
    const kit = syncControlKit();
    return kit && typeof kit.shortTime === 'function' ? kit.shortTime(iso, Date.now()) : '';
  }

  /**
   * Shows the card at the top of `container` when `model.show` is true, and removes it otherwise. `post` sends the choice to the host;
   * `afterDismiss` puts focus back in the message box when the card goes away under it. Returns the card or undefined.
   */
  function renderPickupCard(doc, container, model, post, afterDismiss) {
    const card = drawPickupCard(doc, container, model, post, afterDismiss);
    refreshInvitation(doc);
    return card;
  }

  function drawPickupCard(doc, container, model, post, afterDismiss) {
    const existing = doc.getElementById('pickup-card');
    const hadFocus = Boolean(existing) && Boolean(doc.activeElement) && existing.contains(doc.activeElement);
    if (existing) existing.remove();
    // The card also shows while the pull on open runs (D-17), even when there is nothing to pick up yet.
    const shows = Boolean(model) && (model.show === true || model.checking === true);
    if (!shows) {
      if (hadFocus && afterDismiss) afterDismiss();
      return undefined;
    }
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const card = make('section', 'setup-nudge pickup-card');
    card.id = 'pickup-card';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-labelledby', 'pickup-card-title');
    const title = make('h3', '', TEXT.title);
    title.id = 'pickup-card-title';
    card.append(title);
    const chat = model.show === true ? model.lastChat : undefined;
    const canOpen = Boolean(chat) && chat.locked !== true && typeof chat.id === 'string';
    if (chat && chat.locked === true) card.append(make('p', 'pickup-line', TEXT.locked));
    else if (chat) {
      const time = when(chat.at);
      card.append(make('p', 'pickup-line', 'Last chat: ' + (chat.title || 'Conversation') + (time ? ' (' + time + ')' : '')));
    }
    const run = model.show === true ? model.lastRun : undefined;
    if (run && TEXT.runs[run.state]) card.append(make('p', 'pickup-line', TEXT.runs[run.state]));
    const phase = model.show === true ? model.phase : undefined;
    if (phase && typeof phase.number === 'number') {
      card.append(make('p', 'pickup-line', 'Phase ' + phase.number + (phase.name ? ': ' + phase.name : '')));
      if (phase.nextStep && typeof phase.nextStep.text === 'string') card.append(make('p', 'pickup-line', phase.nextStep.text));
    }
    if (model.checking === true) card.append(make('p', 'pickup-line pickup-checking', TEXT.checking));
    // D-16: before sync is on the card carries the invitation too; the standalone one on the first-run screen steps aside (its id differs).
    const kit = model.syncPrompt === true ? syncControlKit() : undefined;
    const invitation = kit ? kit.buildSyncPrompt(doc, post, 'pickup-sync-prompt') : undefined;
    if (invitation) card.append(invitation);
    const actions = make('div', 'setup-nudge-actions');
    if (canOpen) {
      const open = make('button', 'text-button primary', TEXT.open);
      open.type = 'button';
      open.setAttribute('aria-label', TEXT.open + ': ' + (chat.title || 'Conversation'));
      open.addEventListener('click', () => {
        post({ type: 'pickup-card', action: 'open', id: chat.id });
        card.remove();
      });
      actions.append(open);
    }
    const later = make('button', 'text-button', TEXT.later);
    later.type = 'button';
    later.addEventListener('click', () => {
      card.remove();
      refreshInvitation(doc);
      if (afterDismiss) afterDismiss();
      post({ type: 'pickup-card', action: 'later' });
    });
    actions.append(later);
    card.append(actions);
    container.prepend(card);
    return card;
  }

  const api = { renderPickupCard, when, TEXT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearPickup = api;
})(typeof window === 'undefined' ? globalThis : window);

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
    runs: {
      finished: 'The last run finished.',
      'cut-off': 'The last run was cut off. Open the chat to see it. It only resumes when you press Resume there.',
      waiting: 'The last run is waiting for your answer in another editor.',
      'running-elsewhere': 'The last run is still going in another editor.'
    }
  };

  /** How a time reads on the card: the time today, the date and time otherwise. Empty for a time that is not valid. */
  function when(iso, now) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const today = new Date(now === undefined ? Date.now() : now);
    return at.toDateString() === today.toDateString()
      ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /**
   * Shows the card at the top of `container` when `model.show` is true, and removes it otherwise. `post` sends the choice to the host;
   * `afterDismiss` puts focus back in the message box when the card goes away under it. Returns the card or undefined.
   */
  function renderPickupCard(doc, container, model, post, afterDismiss) {
    const existing = doc.getElementById('pickup-card');
    const hadFocus = Boolean(existing) && Boolean(doc.activeElement) && existing.contains(doc.activeElement);
    if (existing) existing.remove();
    if (!model || model.show !== true) {
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
    const chat = model.lastChat;
    const canOpen = Boolean(chat) && chat.locked !== true && typeof chat.id === 'string';
    if (chat && chat.locked === true) card.append(make('p', 'pickup-line', TEXT.locked));
    else if (chat) {
      const time = when(chat.at);
      card.append(make('p', 'pickup-line', 'Last chat: ' + (chat.title || 'Conversation') + (time ? ' (' + time + ')' : '')));
    }
    const run = model.lastRun;
    if (run && TEXT.runs[run.state]) card.append(make('p', 'pickup-line', TEXT.runs[run.state]));
    const phase = model.phase;
    if (phase && typeof phase.number === 'number') {
      card.append(make('p', 'pickup-line', 'Phase ' + phase.number + (phase.name ? ': ' + phase.name : '')));
      if (phase.nextStep && typeof phase.nextStep.text === 'string') card.append(make('p', 'pickup-line', phase.nextStep.text));
    }
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

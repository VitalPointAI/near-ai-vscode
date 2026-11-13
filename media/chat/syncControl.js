// The chat panel's sync control (D-16) and the "Keep this project on your other machines" invitation. The host works out what to say (the model) and
// what a click does; this only draws it and reports the click. Every word is set with textContent, never as HTML. The control is a real button with an
// accessible name that includes its state; it stays focusable in every state and uses aria-disabled, not disabled, while a sync runs.
(function (root) {
  'use strict';

  const TEXT = {
    promptLine: 'Keep this project on your other machines',
    turnOn: 'Turn on sync',
    dismiss: 'Don\'t ask again'
  };

  /** The host's placeholder for the time in a label, name and tooltip (SYNC_TIME_SLOT in syncStatus.ts); the panel replaces it with shortTime. */
  const TIME_SLOT = '{time}';

  /**
   * The one formatter for a time shown to the person, in the panel so it follows their clock and locale (not the editor host's, which can run in a container).
   * The time of day when it is today, the short month, day and time on another day; empty for a missing or invalid time. The pick-up card uses it too.
   */
  function shortTime(iso, now) {
    if (!iso) return '';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const today = new Date(now === undefined ? Date.now() : now);
    const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
    const options = sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return new Intl.DateTimeFormat(undefined, options).format(at);
  }

  /** Puts the panel's time where the host left the slot. Text only: the result is set with textContent and setAttribute. */
  function withTime(text, time) {
    return typeof text === 'string' ? text.split(TIME_SLOT).join(time) : text;
  }

  const ACTIONS = ['turn-on', 'set-up-home', 'show-details', 'sync-now'];

  /** Per button: the state the live region last announced, and the action a click starts now. */
  const memory = new WeakMap();

  /**
   * Draws `model` ({ state, label, action, ariaLabel, title, busy, detail }) on `button`, replacing what was there (one button, never a second one). A click posts
   * { type: 'sync-control', action } unless the action is 'none'. The polite live region beside the button (#sync-live) says the new state when it
   * changes; the first render says nothing. Returns the button.
   */
  function renderSyncControl(doc, button, model, post) {
    if (!button || !model) return button;
    let known = memory.get(button);
    const first = known === undefined;
    if (first) {
      known = { label: undefined, action: 'none' };
      memory.set(button, known);
      // The click handler is installed once and reads the action the last render set, so a re-render never stacks listeners.
      button.addEventListener('click', () => {
        if (ACTIONS.includes(known.action)) post({ type: 'sync-control', action: known.action });
      });
    }
    const time = shortTime(model.at, Date.now());
    const label = withTime(model.label, time);
    button.textContent = label;
    button.setAttribute('aria-label', withTime(model.ariaLabel, time));
    button.setAttribute('title', withTime(model.title, time));
    button.setAttribute('data-state', model.state);
    button.setAttribute('aria-busy', model.busy ? 'true' : 'false');
    // A running sync is not a disabled button: it stays reachable with Tab and keeps its name.
    button.setAttribute('aria-disabled', model.busy ? 'true' : 'false');
    const changed = known.label !== undefined && known.label !== label;
    known.label = label;
    known.action = model.action;
    const region = doc.getElementById('sync-live');
    if (region && changed) region.textContent = 'Project sync: ' + label;
    // A problem's plain sentence is visible text under the control, and the button is described by it; in every other state it is empty, hidden and unlinked.
    const detail = doc.getElementById('sync-detail');
    const sentence = typeof model.detail === 'string' ? model.detail : '';
    if (detail) {
      detail.textContent = sentence;
      detail.hidden = sentence === '';
    }
    if (detail && sentence) button.setAttribute('aria-describedby', 'sync-detail');
    else button.removeAttribute('aria-describedby');
    return button;
  }

  /**
   * The invitation as a node (with `id`, default 'sync-prompt'). `post` reports the two clicks:
   * { type: 'sync-control', action: 'turn-on' } and { type: 'sync-control', action: 'dismiss-prompt' }. The invitation opens no dialog by itself.
   */
  function buildSyncPrompt(doc, post, id) {
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const box = make('div', 'sync-prompt');
    box.id = id || 'sync-prompt';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', TEXT.promptLine);
    const turnOn = make('button', 'text-button primary', TEXT.turnOn);
    turnOn.type = 'button';
    turnOn.setAttribute('aria-label', TEXT.promptLine + ': ' + TEXT.turnOn);
    turnOn.addEventListener('click', () => post({ type: 'sync-control', action: 'turn-on' }));
    const dismiss = make('button', 'text-button', TEXT.dismiss);
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => {
      box.remove();
      post({ type: 'sync-control', action: 'dismiss-prompt' });
    });
    const actions = make('div', 'setup-nudge-actions');
    actions.append(turnOn, dismiss);
    box.append(make('p', 'pickup-line', TEXT.promptLine), actions);
    return box;
  }

  /** What the last render asked for, so the invitation can be worked out again when the pick-up card (which carries its own) comes or goes. */
  const lastPrompt = { container: undefined, post: undefined, wanted: false };

  /**
   * Shows the invitation at the top of `container` (the first-run screen) when `wanted` is true and the pick-up card does not already carry one, and removes
   * it otherwise. Idempotent by id. Returns the node or undefined.
   */
  function renderSyncPrompt(doc, container, post, wanted) {
    lastPrompt.container = container;
    lastPrompt.post = post;
    lastPrompt.wanted = wanted === true;
    const existing = doc.getElementById('sync-prompt');
    if (!(wanted === true) || doc.getElementById('pickup-sync-prompt')) {
      if (existing) existing.remove();
      return undefined;
    }
    if (existing) return existing;
    const node = buildSyncPrompt(doc, post);
    container.prepend(node);
    return node;
  }

  /** Works the first-run invitation out again from the last request: the pick-up card calls this when it shows or goes. */
  function refreshSyncPrompt(doc) {
    if (!lastPrompt.container) return undefined;
    return renderSyncPrompt(doc, lastPrompt.container, lastPrompt.post, lastPrompt.wanted);
  }

  const api = { shortTime, renderSyncControl, renderSyncPrompt, refreshSyncPrompt, buildSyncPrompt, TEXT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearSyncControl = api;
})(typeof window === 'undefined' ? globalThis : window);

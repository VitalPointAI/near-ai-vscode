// The trust badge under each cloud answer (CLAS-08). The host chooses the state and every word (trustBadgeFor in src/domain/gate/trustBadge.ts); this
// only draws it. Every word is set with textContent, never as HTML. The badge is a real button whose accessible name says its state; the state is also
// given by its words and an icon, never by colour alone. A click opens its details: why it says what it says, what was not checked, Check again and Show
// full attestation (a reopened chat's badge has neither, D-51 and plan 27). Escape closes the details and returns focus to the badge.
(function (root) {
  'use strict';

  const STATES = ['verified-private', 'model-verified', 'not-verified'];
  const ICONS = { 'verified-private': '✓', 'model-verified': '◑', 'not-verified': '✗' };
  const TEXT = {
    checkAgain: 'Check again',
    checking: 'Checking again…',
    showFull: 'Show full attestation',
    notChecked: 'Not checked in the editor: ',
    fullCheck: 'For a full check use cloud.near.ai/verify or NEAR’s nearai-cloud-verifier.',
    keptWhileOpen: 'The full attestation is kept only while the window that checked it is open.'
  };

  /** Per container: the badge's wrapper, button and details, so a later message updates the one badge rather than adding a second. */
  const drawn = new WeakMap();

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function textButton(doc, label, onClick) {
    const button = el(doc, 'button', 'trust-action', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  /** A badge the page can draw: one of the three states with a title in words. Anything else draws nothing. */
  function valid(badge) {
    return Boolean(badge) && typeof badge === 'object' && STATES.includes(badge.state) && typeof badge.title === 'string' && badge.title.length > 0;
  }

  function strings(list) {
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.length > 0) : [];
  }

  /** Opens or closes the details; closing by Escape returns focus to the badge. */
  function setExpanded(known, expanded, refocus) {
    known.expanded = expanded;
    known.button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    known.details.hidden = !expanded;
    if (!expanded && refocus && typeof known.button.focus === 'function') known.button.focus();
  }

  /** The details' words and buttons, drawn again on each update so they always match the badge. */
  function drawDetails(doc, known) {
    const badge = known.badge;
    const parts = [];
    if (typeof badge.explanation === 'string') parts.push(el(doc, 'p', 'trust-explanation', badge.explanation));
    const reasons = strings(badge.reasons);
    if (reasons.length) {
      const list = el(doc, 'ul', 'trust-reasons');
      for (const reason of reasons) list.append(el(doc, 'li', '', reason));
      parts.push(list);
    }
    if (typeof badge.helpers === 'string') parts.push(el(doc, 'p', 'trust-helpers', badge.helpers));
    const notChecked = strings(badge.notChecked);
    if (notChecked.length) parts.push(el(doc, 'p', 'trust-not-checked', TEXT.notChecked + notChecked.join(', ') + '. ' + TEXT.fullCheck));
    if (badge.replayed === true) {
      parts.push(el(doc, 'p', 'trust-kept', TEXT.keptWhileOpen));
    } else {
      const actions = el(doc, 'div', 'trust-actions');
      const again = textButton(doc, TEXT.checkAgain, () => {
        again.textContent = TEXT.checking;
        again.setAttribute('aria-disabled', 'true');
        known.post({ type: 'verify-response', runId: known.runId });
      });
      actions.append(again, textButton(doc, TEXT.showFull, () => known.post({ type: 'trust-details', runId: known.runId })));
      parts.push(actions);
    }
    known.details.replaceChildren(...parts);
  }

  /**
   * Draws `badge` ({ state, title, explanation, reasons, helpers, notChecked, replayed }) under the answer in `container`, creating the badge the first
   * time and updating it after (an open details box stays open). Returns the badge button, or undefined when the badge is not one the page can draw.
   */
  function renderTrustBadge(doc, container, badge, post, runId) {
    if (!container || !valid(badge)) return undefined;
    let known = drawn.get(container);
    if (!known) {
      const wrap = el(doc, 'div', 'trust');
      const button = el(doc, 'button', 'trust-badge');
      button.type = 'button';
      const details = el(doc, 'div', 'trust-details');
      details.id = 'trust-details-' + String(runId || '');
      details.hidden = true;
      button.setAttribute('aria-controls', details.id);
      button.setAttribute('aria-expanded', 'false');
      // Its words must be read whole: the layout check reports a badge whose title is cut off.
      button.setAttribute('data-must-read', '');
      wrap.append(button, details);
      container.append(wrap);
      known = { wrap, button, details, expanded: false };
      drawn.set(container, known);
      // Installed once; they read the latest badge, so an update never stacks listeners.
      button.addEventListener('click', () => setExpanded(known, !known.expanded, false));
      const onKey = (event) => {
        if (event && event.key === 'Escape' && known.expanded) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setExpanded(known, false, true);
        }
      };
      button.addEventListener('keydown', onKey);
      details.addEventListener('keydown', onKey);
    }
    known.badge = badge;
    known.post = typeof post === 'function' ? post : () => undefined;
    known.runId = runId;
    const button = known.button;
    if (button.dataset) button.dataset.state = badge.state;
    button.setAttribute('data-state', badge.state);
    button.setAttribute('aria-label', 'Trust: ' + badge.title + '. Show details');
    const icon = el(doc, 'span', 'trust-icon', ICONS[badge.state]);
    icon.setAttribute('aria-hidden', 'true');
    button.replaceChildren(icon, el(doc, 'span', 'trust-title', badge.title));
    drawDetails(doc, known);
    return button;
  }

  const api = { renderTrustBadge, STATES, TEXT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearTrustBadge = api;
})(typeof window === 'undefined' ? globalThis : window);

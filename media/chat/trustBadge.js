// The trust badge under each cloud answer (CLAS-08). The host chooses the state and every word (trustBadgeFor in src/domain/gate/trustBadge.ts); this
// only draws it. Every word is set with textContent, never as HTML. The badge is a real button whose accessible name says its state; the state is also
// given by its words and an icon, never by colour alone.
(function (root) {
  'use strict';

  const STATES = ['verified-private', 'model-verified', 'not-verified'];
  const ICONS = { 'verified-private': '✓', 'model-verified': '◑', 'not-verified': '✗' };

  /** Per container: the badge's wrapper and button, so a later message updates the one badge rather than adding a second. */
  const drawn = new WeakMap();

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** A badge the page can draw: one of the three states with a title in words. Anything else draws nothing. */
  function valid(badge) {
    return Boolean(badge) && typeof badge === 'object' && STATES.includes(badge.state) && typeof badge.title === 'string' && badge.title.length > 0;
  }

  /**
   * Draws `badge` ({ state, title, explanation, reasons, helpers, notChecked, replayed }) under the answer in `container`, creating the badge the first
   * time and updating it after. Returns the badge button, or undefined when the badge is not one the page can draw.
   */
  function renderTrustBadge(doc, container, badge, post, runId) {
    if (!container || !valid(badge)) return undefined;
    let known = drawn.get(container);
    if (!known) {
      const wrap = el(doc, 'div', 'trust');
      const button = el(doc, 'button', 'trust-badge');
      button.type = 'button';
      button.setAttribute('aria-expanded', 'false');
      wrap.append(button);
      container.append(wrap);
      known = { wrap, button, badge };
      drawn.set(container, known);
    }
    known.badge = badge;
    const button = known.button;
    if (button.dataset) button.dataset.state = badge.state;
    button.setAttribute('data-state', badge.state);
    button.setAttribute('aria-label', 'Trust: ' + badge.title + '. Show details');
    const icon = el(doc, 'span', 'trust-icon', ICONS[badge.state]);
    icon.setAttribute('aria-hidden', 'true');
    const title = el(doc, 'span', 'trust-title', badge.title);
    button.replaceChildren(icon, title);
    return button;
  }

  const api = { renderTrustBadge, STATES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearTrustBadge = api;
})(typeof window === 'undefined' ? globalThis : window);

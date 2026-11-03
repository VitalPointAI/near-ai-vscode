// Keeps chat tables steady while a reply streams. The view rebuilds a reply's markup on every
// frame, so each table's sideways scroll and keyboard focus are saved before and put back after,
// by the table's position in the reply. Only a table that is wider than its box is a Tab stop.
// Works on anything shaped like a DOM element, so the node tests can check it without a browser.
(function (root) {
  'use strict';

  const WRAP = '.table-wrap';

  const wrapsOf = (target) => Array.from(target.querySelectorAll(WRAP));

  function overflows(wrap) {
    return wrap.scrollWidth - wrap.clientWidth > 1;
  }

  /**
   * Makes a table box a Tab stop only when it scrolls sideways, so keyboard users can reach the
   * hidden columns without stepping through every small table. A box that has focus keeps it.
   */
  function syncTabStop(wrap, active) {
    if (overflows(wrap)) {
      if (wrap.getAttribute('tabindex') !== '0') wrap.setAttribute('tabindex', '0');
    } else if (wrap.hasAttribute('tabindex') && wrap !== active) {
      wrap.removeAttribute('tabindex');
    }
  }

  /** Saves each table's sideways scroll and which table (if any) holds focus. */
  function capture(target, active) {
    const wraps = wrapsOf(target);
    const focused = active ? wraps.findIndex((wrap) => wrap === active || wrap.contains(active)) : -1;
    return { wraps, scroll: wraps.map((wrap) => wrap.scrollLeft), focused };
  }

  /** Puts saved scroll and focus back on the rebuilt tables and sets their Tab stops. */
  function restore(target, saved) {
    const wraps = wrapsOf(target);
    wraps.forEach((wrap, index) => {
      if (saved && saved.scroll[index]) wrap.scrollLeft = saved.scroll[index];
      syncTabStop(wrap);
    });
    const focus = saved && saved.focused >= 0 ? wraps[saved.focused] : undefined;
    if (focus) {
      // Focus needs a Tab stop; it is kept while the table has focus even if it stops overflowing.
      if (!focus.hasAttribute('tabindex')) focus.setAttribute('tabindex', '0');
      focus.focus({ preventScroll: true });
    }
    return wraps;
  }

  const api = { capture, restore, syncTabStop };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearTables = api;
})(typeof window === 'undefined' ? globalThis : window);

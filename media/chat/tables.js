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

  // What can hold focus inside a table: links today, anything focusable to be safe.
  const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]';

  /**
   * Saves each table's sideways scroll, which table (if any) holds focus, and which link or other
   * focusable part of it holds focus, by position, so the same part gets focus back.
   */
  function capture(target, active) {
    const wraps = wrapsOf(target);
    const focused = active ? wraps.findIndex((wrap) => wrap === active || wrap.contains(active)) : -1;
    const inner = focused >= 0 && wraps[focused] !== active
      ? Array.from(wraps[focused].querySelectorAll(FOCUSABLE)).indexOf(active)
      : -1;
    return { wraps, scroll: wraps.map((wrap) => wrap.scrollLeft), focused, inner };
  }

  /** Puts saved scroll and focus back on the rebuilt tables and sets their Tab stops. */
  function restore(target, saved) {
    const wraps = wrapsOf(target);
    wraps.forEach((wrap, index) => {
      if (saved && saved.scroll[index]) wrap.scrollLeft = saved.scroll[index];
      syncTabStop(wrap);
    });
    const box = saved && saved.focused >= 0 ? wraps[saved.focused] : undefined;
    if (!box) return wraps;
    // Focus goes back to the same link in the table, so keyboard users can stay on it or Tab on.
    const part = saved.inner >= 0 ? box.querySelectorAll(FOCUSABLE)[saved.inner] : undefined;
    if (part) {
      part.focus({ preventScroll: true });
      return wraps;
    }
    // Focus on the box needs a Tab stop; it is kept while the box has focus even if it stops overflowing.
    if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '0');
    box.focus({ preventScroll: true });
    return wraps;
  }

  /** When focus leaves a table, a box that does not overflow stops being a Tab stop again. */
  function focusLeft(event) {
    const from = event && event.target;
    const wrap = from && typeof from.closest === 'function' ? from.closest(WRAP) : null;
    if (!wrap) return;
    const to = event.relatedTarget;
    if (to && (to === wrap || wrap.contains(to))) return;
    syncTabStop(wrap, null);
  }

  /**
   * Watches table boxes and their tables for size changes, so a box becomes a Tab stop when it gets
   * wider than the chat and stops being one when the chat is widened again. A box that has left
   * the page is let go on its next size change, and `reset` lets go of every box at once when the
   * conversation is cleared, so removed replies can be freed. Without ResizeObserver it does nothing.
   */
  function watchSizes(Observer, activeElement) {
    if (typeof Observer !== 'function') return { observe() {}, release() {}, reset() {} };
    const observer = new Observer((entries) => entries.forEach((entry) => {
      const node = entry.target;
      if (!node.isConnected) { observer.unobserve(node); return; }
      const wrap = node.closest(WRAP);
      if (wrap) syncTabStop(wrap, activeElement());
    }));
    const each = (wraps, act) => Array.from(wraps).forEach((wrap) => {
      act(wrap);
      if (wrap.firstElementChild) act(wrap.firstElementChild);
    });
    return {
      observe(wraps) { each(wraps, (node) => observer.observe(node)); },
      release(wraps) { each(wraps, (node) => observer.unobserve(node)); },
      reset() { observer.disconnect(); }
    };
  }

  const api = { capture, restore, syncTabStop, focusLeft, watchSizes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearTables = api;
})(typeof window === 'undefined' ? globalThis : window);

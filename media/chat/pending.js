// Prompts waiting for the user (approvals, questions, choices), pinned above the composer until
// answered. Pure state and wording, so the node tests can check it without a DOM.
(function (root) {
  'use strict';

  /** Oldest first; one is shown at a time and the user can step between them. */
  function createPendingQueue() {
    const items = [];
    let selected = 0;
    const indexOf = (id) => items.findIndex((item) => item.id === id);
    return {
      /** Adds a prompt; false when it is already waiting (a replay after the view reloads). */
      add(item) {
        if (!item || !item.id || indexOf(item.id) !== -1) return false;
        items.push(item);
        return true;
      },
      /** Removes a prompt and returns it, or undefined when it was not waiting. */
      resolve(id) {
        const index = indexOf(id);
        if (index === -1) return undefined;
        const [item] = items.splice(index, 1);
        if (index < selected) selected -= 1;
        selected = Math.max(0, Math.min(selected, items.length - 1));
        return item;
      },
      has(id) { return indexOf(id) !== -1; },
      get size() { return items.length; },
      /** The prompt on show, or undefined when nothing is waiting. */
      current() { return items[selected]; },
      /** 1-based position of the shown prompt. */
      position() { return items.length ? selected + 1 : 0; },
      select(id) { const index = indexOf(id); if (index !== -1) selected = index; return index !== -1; },
      /** Moves to the previous (-1) or next (+1) prompt, wrapping around. */
      step(delta) { if (items.length) selected = (selected + delta + items.length) % items.length; return items[selected]; },
      list() { return items.slice(); },
      /** Empties the queue and returns what was waiting, oldest first. */
      clear() { const all = items.splice(0); selected = 0; return all; }
    };
  }

  /** The heading over the pinned prompt: who is asking, and how many wait. */
  function headerText(item, position, size) {
    const who = (item && item.agent) || 'NEAR AI';
    const what = item && item.kind === 'approval' ? who + ' needs your approval' : who + ' is asking you';
    return size > 1 ? what + ' · ' + position + ' of ' + size + ' waiting' : what;
  }

  /** The transcript line while the prompt waits. */
  function waitingText(item) {
    if (item.kind === 'approval') return 'Waiting for your approval: ' + item.title;
    if (item.kind === 'questions') return 'Waiting for your answer: ' + item.title;
    return 'Waiting for your choice: ' + item.title;
  }

  /** The one-line record left in the transcript once the prompt is settled. */
  function outcomeText(item, outcome, detail) {
    const title = item.title;
    switch (outcome) {
      case 'allow': return 'Approved: ' + title;
      case 'allow-run': return 'Approved for this run: ' + title;
      case 'deny': return 'Declined: ' + title;
      case 'expired': return (detail !== undefined && detail !== '' ? 'Expired after ' + detail + ' min' : 'Expired') + ', declined: ' + title;
      case 'answered': return 'Answered: ' + (detail || title);
      case 'cancelled': return 'Cancelled, the run stopped: ' + title;
      case 'closed': return 'No longer waiting: ' + title;
      default: return title;
    }
  }

  const api = { createPendingQueue, headerText, waitingText, outcomeText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearPending = api;
})(typeof window === 'undefined' ? globalThis : window);

// Composer edits that must not lose what the user typed. Pure, so the node tests can check it
// without a DOM.
(function (root) {
  'use strict';

  /**
   * Puts a slash command ("Use in chat") into the composer without wiping a draft: an empty
   * composer gets the command; a draft that starts with a slash command has only that command
   * replaced; any other draft keeps its text after the command. The caret goes right after the
   * command and its space, ready for arguments.
   */
  function insertCommand(draft, command) {
    const cmd = String(command || '').trim();
    const text = String(draft || '');
    if (!cmd) return { text, caret: text.length };
    if (!text.trim()) return { text: cmd + ' ', caret: cmd.length + 1 };
    const leading = /^\s*\/\S+/.exec(text);
    const rest = leading ? text.slice(leading[0].length) : text.replace(/^\s+/, '');
    const joined = leading ? cmd + (/^\s/.test(rest) ? rest : ' ' + rest) : cmd + ' ' + rest;
    return { text: joined, caret: joined[cmd.length] === ' ' ? cmd.length + 1 : cmd.length };
  }

  const api = { insertCommand };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nearComposer = api;
})(typeof window === 'undefined' ? globalThis : window);

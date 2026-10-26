// Minimal Markdown renderer for model output. Every character of input is HTML-escaped
// before any markup is added, so model text can never inject elements or attributes.
(function (root) {
  'use strict';

  function escapeHtml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inline(text) {
    const codeSpans = [];
    let html = escapeHtml(text).replace(/`([^`\n]+)`/g, (_match, code) => {
      codeSpans.push(code);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });
    html = html
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" title="$2">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
    return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${codeSpans[Number(index)]}</code>`);
  }

  /** Returns blocks: { type: 'html', html } or { type: 'code', lang, code } so callers can add code-block chrome. */
  function parse(source) {
    const blocks = [];
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list;
    const flushParagraph = () => {
      if (paragraph.length) blocks.push({ type: 'html', html: `<p>${paragraph.map(inline).join('<br>')}</p>` });
      paragraph = [];
    };
    const flushList = () => {
      if (list) blocks.push({ type: 'html', html: `<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>` });
      list = undefined;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph();
        flushList();
        const code = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
        blocks.push({ type: 'code', lang: fence[1] || '', code: code.join('\n') });
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(heading[1].length + 2, 6);
        blocks.push({ type: 'html', html: `<h${level}>${inline(heading[2])}</h${level}>` });
      } else if (bullet || ordered) {
        flushParagraph();
        const tag = bullet ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        list = list || { tag, items: [] };
        list.items.push((bullet || ordered)[1]);
      } else if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        flushList();
        blocks.push({ type: 'html', html: `<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>` });
      } else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        flushParagraph();
        flushList();
        blocks.push({ type: 'html', html: '<hr>' });
      } else if (!line.trim()) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushList();
    return blocks;
  }

  const api = { escapeHtml, inline, parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.nearMarkdown = api;
})(this);

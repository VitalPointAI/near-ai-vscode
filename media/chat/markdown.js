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
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
    return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${codeSpans[Number(index)]}</code>`);
  }

  // Splits a table row into raw cell texts. `\|` is a literal pipe, and a pipe inside a code span
  // does not end the cell. Leading and trailing pipes are optional.
  function splitRow(line) {
    const text = line.trim();
    const cells = [];
    let cell = '';
    let endedWithPipe = false;
    for (let index = 0; index < text.length;) {
      const char = text[index];
      endedWithPipe = false;
      if (char === '\\' && text[index + 1] === '|') {
        cell += '|';
        index += 2;
      } else if (char === '`') {
        let run = 1;
        while (text[index + run] === '`') run += 1;
        const close = text.indexOf('`'.repeat(run), index + run);
        const end = close === -1 ? index + run : close + run;
        cell += close === -1 ? text.slice(index, end) : text.slice(index, end).replace(/\\\|/g, '|');
        index = end;
      } else if (char === '|') {
        cells.push(cell);
        cell = '';
        endedWithPipe = true;
        index += 1;
      } else {
        cell += char;
        index += 1;
      }
    }
    cells.push(cell);
    if (text.startsWith('|')) cells.shift();
    if (endedWithPipe && cells.length) cells.pop();
    return cells.map((value) => value.trim());
  }

  const isRow = (line) => line.includes('|') && !/^\s*>/.test(line) && !/^\s*```/.test(line);

  function alignments(line) {
    if (!line.includes('|')) return undefined;
    const cells = splitRow(line);
    if (!cells.length || !cells.every((cell) => /^:?-+:?$/.test(cell))) return undefined;
    return cells.map(alignOf);
  }

  function alignOf(cell) {
    const left = cell.startsWith(':');
    const right = cell.length > 1 && cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  }

  // While a reply streams, its delimiter row may not have arrived yet. A trailing row that starts
  // with a pipe, alone or followed by an incomplete delimiter row, shows as a table header instead
  // of flashing up as a paragraph of pipes. The final render applies the strict rules.
  function pendingTableEnd(lines, index) {
    const line = lines[index];
    if (!isRow(line)) return 0;
    if (index === lines.length - 1) return /^\s*\|/.test(line) ? 1 : 0;
    const next = lines[index + 1];
    const started = next.includes('|') || (!next.trim() && /^\s*\|/.test(line));
    if (index === lines.length - 2 && started && /^[\s|:-]*$/.test(next) && splitRow(next).length <= splitRow(line).length) return 2;
    return 0;
  }

  function renderTable(header, aligns, rows) {
    // A table whose first header cell is empty uses its first column as row labels.
    const rowHeaders = header.length > 1 && !header[0];
    const attrs = (column) => (aligns[column] ? ` class="align-${aligns[column]}"` : '');
    const head = header.map((cell, column) => `<th scope="col"${attrs(column)}>${inline(cell)}</th>`).join('');
    const body = rows.map((row) => `<tr>${header.map((_cell, column) => {
      const tag = rowHeaders && column === 0 ? 'th' : 'td';
      const scope = tag === 'th' ? ' scope="row"' : '';
      return `<${tag}${scope}${attrs(column)}>${inline(row[column] || '')}</${tag}>`;
    }).join('')}</tr>`).join('');
    return `<div class="table-wrap" role="region" aria-label="Table" tabindex="0"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>`;
  }

  function renderQuote(lines) {
    const paragraphs = [];
    let current = [];
    for (const line of lines) {
      if (line.trim()) current.push(line);
      else if (current.length) { paragraphs.push(current); current = []; }
    }
    if (current.length) paragraphs.push(current);
    return `<blockquote>${paragraphs.map((group) => `<p>${group.map(inline).join('<br>')}</p>`).join('')}</blockquote>`;
  }

  /**
   * Returns blocks: { type: 'html', html } or { type: 'code', lang, code } so callers can add code-block chrome.
   * Pass { partial: true } while text is still streaming in, so an unfinished table does not flicker.
   */
  function parse(source, options) {
    const partial = Boolean(options && options.partial);
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
      const aligns = isRow(line) && index + 1 < lines.length ? alignments(lines[index + 1]) : undefined;
      const header = aligns ? splitRow(line) : undefined;
      if (header && header.length === aligns.length) {
        flushParagraph();
        flushList();
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim() && isRow(lines[index])) { rows.push(splitRow(lines[index])); index += 1; }
        index -= 1;
        blocks.push({ type: 'html', html: renderTable(header, aligns, rows) });
        continue;
      }
      const pending = partial ? pendingTableEnd(lines, index) : 0;
      if (pending) {
        flushParagraph();
        flushList();
        const cells = splitRow(line);
        if (cells.length) blocks.push({ type: 'html', html: renderTable(cells, pending === 2 ? splitRow(lines[index + 1]).map(alignOf) : [], []) });
        break;
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
      } else if (/^\s*>/.test(line)) {
        flushParagraph();
        flushList();
        const quoted = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) { quoted.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
        index -= 1;
        blocks.push({ type: 'html', html: renderQuote(quoted) });
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

  const api = { escapeHtml, inline, parse, splitRow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.nearMarkdown = api;
})(this);

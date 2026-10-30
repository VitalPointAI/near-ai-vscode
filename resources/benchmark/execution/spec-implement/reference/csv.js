function parse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inRow = false;
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' && field === '') {
      const startedOn = line;
      i += 1;
      for (;;) {
        if (i >= text.length) throw new Error('Unclosed quoted field starting on line ' + startedOn);
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        if (text[i] === '\n') line += 1;
        field += text[i];
        i += 1;
      }
      inRow = true;
      continue;
    }
    if (char === ',') { row.push(field); field = ''; inRow = true; i += 1; continue; }
    if (char === '\r' && text[i + 1] === '\n') { i += 1; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; inRow = false; line += 1; i += 1; continue; }
    field += char;
    inRow = true;
    i += 1;
  }
  if (inRow) { row.push(field); rows.push(row); }
  return rows;
}

module.exports = { parse };

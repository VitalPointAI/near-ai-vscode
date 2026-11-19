// A small strict XML reader for tests only: well-formedness (one root, balanced tags, quoted unique attributes, only the five predefined entities and
// character references, no document type declaration), so a test can say "this parses as XML" without a dependency. Not used by the extension.
export interface XmlElement { readonly name: string; readonly attrs: Readonly<Record<string, string>>; readonly children: XmlElement[]; text: string }

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[a-z]+);|&/g, (whole, entity: string | undefined) => {
    if (entity === undefined) throw new Error('A bare & in XML text.');
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (!(entity in named)) throw new Error(`Unknown entity ${whole}.`);
    return named[entity];
  });
}

export function parseXml(source: string): XmlElement {
  let at = 0;
  const skipSpace = (): void => { while (at < source.length && /\s/.test(source[at])) at += 1; };
  if (source.startsWith('<?xml')) {
    const end = source.indexOf('?>');
    if (end < 0) throw new Error('Unclosed XML declaration.');
    at = end + 2;
  }
  skipSpace();
  if (source.startsWith('<!DOCTYPE', at)) throw new Error('Document type declarations are refused.');
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  while (at < source.length) {
    if (source[at] !== '<') {
      const next = source.indexOf('<', at);
      const raw = source.slice(at, next < 0 ? source.length : next);
      if (stack.length === 0) { if (raw.trim() !== '') throw new Error('Text outside the root element.'); } else stack[stack.length - 1].text += decode(raw);
      at = next < 0 ? source.length : next;
      continue;
    }
    if (source.startsWith('<!--', at)) { const end = source.indexOf('-->', at); if (end < 0) throw new Error('Unclosed comment.'); at = end + 3; continue; }
    if (source.startsWith('<!', at) || source.startsWith('<?', at)) throw new Error('Unexpected markup.');
    if (source[at + 1] === '/') {
      at += 2;
      const name = NAME.exec(source.slice(at))?.[0];
      const open = stack.pop();
      if (!name || !open || open.name !== name) throw new Error(`Mismatched closing tag ${name ?? ''}.`);
      at += name.length;
      skipSpace();
      if (source[at] !== '>') throw new Error('Bad closing tag.');
      at += 1;
      continue;
    }
    at += 1;
    const name = NAME.exec(source.slice(at))?.[0];
    if (!name) throw new Error('Bad tag name.');
    at += name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      skipSpace();
      if (source.startsWith('/>', at) || source[at] === '>') break;
      const attr = NAME.exec(source.slice(at))?.[0];
      if (!attr) throw new Error(`Bad attribute in ${name}.`);
      at += attr.length;
      skipSpace();
      if (source[at] !== '=') throw new Error(`Attribute ${attr} has no value.`);
      at += 1;
      skipSpace();
      const quote = source[at];
      if (quote !== '"' && quote !== "'") throw new Error(`Attribute ${attr} is not quoted.`);
      const end = source.indexOf(quote, at + 1);
      if (end < 0) throw new Error('Unclosed attribute.');
      const value = source.slice(at + 1, end);
      if (value.includes('<')) throw new Error('< in an attribute.');
      if (attr in attrs) throw new Error(`Duplicate attribute ${attr}.`);
      attrs[attr] = decode(value);
      at = end + 1;
    }
    const element: XmlElement = { name, attrs, children: [], text: '' };
    if (stack.length > 0) stack[stack.length - 1].children.push(element);
    else if (root) throw new Error('More than one root element.');
    else root = element;
    if (source.startsWith('/>', at)) { at += 2; } else { at += 1; stack.push(element); }
  }
  if (stack.length > 0 || !root) throw new Error('Unclosed element.');
  return root;
}

export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((entry) => entry.name === name);
}

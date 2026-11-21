export const MIN_LIMITATION_PREFIX = 40;
export interface KnownLimitation { readonly limitation: string; readonly plan: string }
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Parses the Limitation and Plan rows under SECURITY.md's Known limitations heading. */
export function parseKnownLimitations(markdown: string): KnownLimitation[] {
  const heading = /^## Known limitations\s*$/m.exec(markdown);
  if (!heading || heading.index === undefined) throw new Error('Known limitations heading is missing');
  const section = markdown.slice(heading.index + heading[0].length).split(/^## /m, 1)[0];
  return section.split('\n').flatMap((line) => {
    const cells = line.trim().split('|').map(normalize).filter((cell) => cell !== '');
    if (cells.length !== 2 || cells[0] === 'Limitation' || /^-+$/.test(cells[0])) return [];
    return [{ limitation: cells[0], plan: cells[1] }];
  });
}

/** Matches a declared limitation only when its normalized prefix uniquely names one SECURITY table row. */
export function matchLimitation(text: string, rows: readonly KnownLimitation[]): KnownLimitation {
  const prefix = normalize(text);
  if (prefix.length < MIN_LIMITATION_PREFIX) throw new Error(`A limitation needs at least ${MIN_LIMITATION_PREFIX} characters to match SECURITY.md.`);
  const matches = rows.filter((row) => normalize(row.limitation).startsWith(prefix));
  if (matches.length === 0) throw new Error('This limitation does not match a Known limitations row in SECURITY.md.');
  if (matches.length > 1) throw new Error('This limitation matches more than one Known limitations row in SECURITY.md.');
  return matches[0];
}

import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { newCatalog, newControl, newGroup, statementPart } from './lib/oscalBuild.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type GeneratedCatalog = { catalog: { metadata: Record<string, unknown>; groups: Array<{ id: string; title: string; controls: unknown[] }> } };
const TITLES_URL = 'https://www.ecfr.gov/api/versioner/v1/titles.json';
const NOTICE = 'Unofficial editorial compilation as of the listed date; the official CFR governs.';

export const ITAR_REQUIREMENTS = [
  ['itar-120.50', 22, '120', '120.50', '(a)'], ['itar-120.54-a5', 22, '120', '120.54', '(a)(5)'], ['itar-120.55', 22, '120', '120.55', '(a)'], ['itar-120.56-a', 22, '120', '120.56', '(a)'], ['itar-120.56-b', 22, '120', '120.56', '(b)'], ['itar-122.1', 22, '122', '122.1', '(a)'], ['itar-122.5', 22, '122', '122.5', '(a)'], ['itar-126.1', 22, '126', '126.1', '(a)'], ['itar-126.5', 22, '126', '126.5', '(a)'], ['itar-126.18', 22, '126', '126.18', '(a)'], ['itar-127.12', 22, '127', '127.12', '(a)'],
  ['ear-734.13', 15, '734', '734.13', '(a)'], ['ear-734.15', 15, '734', '734.15', '(a)'], ['ear-734.18-a5', 15, '734', '734.18', '(a)(5)']
] as const;

export const sectionRequestUrl = (date: string, title: number, part: string, section: string) => `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${title}.xml?part=${part}&section=${section}`;
const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const textOf = (node: Node): string => ('value' in node ? node.value : children(node).map(textOf).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string): string | undefined => node.attrs.find((item) => item.name === name)?.value;
function section(node: Node, number: string): Element | undefined { const pending = [node]; while (pending.length) { const candidate = pending.shift()!; if (isElement(candidate) && candidate.tagName === 'section' && attr(candidate, 'n') === number) return candidate; pending.push(...children(candidate)); } return undefined; }
function paragraph(node: Element, marker: string): string | undefined { const pending: Node[] = [node]; while (pending.length) { const candidate = pending.shift()!; if (isElement(candidate) && candidate.tagName === 'p') { const value = textOf(candidate); if (value.startsWith(marker)) return value; } pending.push(...children(candidate)); } return undefined; }
function page(context: { readonly offlinePages?: Readonly<Record<string, string>> }, url: string, requirement: string): string { const found = context.offlinePages?.[url]; if (!found) throw new Error(`missing source page for ${requirement}: ${url}`); return found; }
function titleDates(context: { readonly offlinePages?: Readonly<Record<string, string>> }): Record<number, string> { const body = page(context, TITLES_URL, 'titles'); const entries = JSON.parse(body).titles as Array<{ number: number; up_to_date_as_of: string }>; return Object.fromEntries(entries.map((entry) => [entry.number, entry.up_to_date_as_of])); }

/** Reads eCFR versioned title text with the title's advertised as-of date. */
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>> } = {}) {
  const dates = titleDates(context);
  const catalog = newCatalog({ sourceId: 'ecfr-title-22', title: 'ITAR and EAR requirements', version: '0.1.0', retrievedAt: new Date().toISOString() }) as unknown as GeneratedCatalog;
  catalog.catalog.metadata.remarks = `${NOTICE} Title 22: ${dates[22]}; Title 15: ${dates[15]}.`;
  const groups = new Map([['itar', newGroup('itar', 'International Traffic in Arms Regulations')], ['ear', newGroup('ear', 'Export Administration Regulations')]]);
  for (const [id, title, part, sectionNumber, marker] of ITAR_REQUIREMENTS) {
    const date = dates[title]; if (!date) throw new Error(`missing as-of date for Title ${title}`);
    const url = sectionRequestUrl(date, title, part, sectionNumber);
    const selected = section(parse(page(context, url, id)), sectionNumber);
    const prose = selected && paragraph(selected, marker);
    if (!prose) throw new Error(`missing required paragraph ${id}`);
    groups.get(id.startsWith('ear-') ? 'ear' : 'itar')!.controls.push({ ...newControl({ id, title: id.toUpperCase(), label: id.toUpperCase() }), links: [{ href: url, rel: 'reference' }], parts: [statementPart([prose])] });
  }
  catalog.catalog.groups.push(groups.get('itar')!, groups.get('ear')!);
  return {
    sourceId: 'ecfr-title-22', file: 'catalogs/itar/catalog.json', catalog,
    reportFile: 'import-reports/itar.json', report: { titleAsOf: { '15': dates[15], '22': dates[22] } }
  };
}

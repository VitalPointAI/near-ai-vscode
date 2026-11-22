import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { newCatalog, newControl, newGroup, statementPart } from './lib/oscalBuild.ts';
import { createFetcher, type Fetcher } from './lib/fetch.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type GeneratedCatalog = { catalog: { metadata: Record<string, unknown>; groups: Array<{ id: string; title: string; controls: unknown[] }> } };
const TITLES_URL = 'https://www.ecfr.gov/api/versioner/v1/titles.json';
const NOTICE = 'Unofficial editorial compilation as of the listed date; the official CFR governs.';
const RETRIEVED_AT = '2026-11-21T00:00:00Z';

export const ITAR_REQUIREMENTS = [
  ['itar-120.50', 22, '120', '120.50', '(a)'], ['itar-120.54-a5', 22, '120', '120.54', '(a)(5)'], ['itar-120.55', 22, '120', '120.55', undefined], ['itar-120.56-a', 22, '120', '120.56', '(a)'], ['itar-120.56-b', 22, '120', '120.56', '(b)'], ['itar-122.1', 22, '122', '122.1', '(a)'], ['itar-122.5', 22, '122', '122.5', '(a)'], ['itar-126.1', 22, '126', '126.1', '(a)'], ['itar-126.5', 22, '126', '126.5', '(a)'], ['itar-126.18', 22, '126', '126.18', '(a)'], ['itar-127.12', 22, '127', '127.12', '(a)'],
  ['ear-734.13', 15, '734', '734.13', '(a)'], ['ear-734.15', 15, '734', '734.15', '(a)'], ['ear-734.18-a5', 15, '734', '734.18', '(a)(5)']
] as const;

export const sectionRequestUrl = (date: string, title: number, part: string, section: string) => `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${title}.xml?part=${part}&section=${section}`;
const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const textOf = (node: Node): string => ('value' in node ? node.value : children(node).map(textOf).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string): string | undefined => node.attrs.find((item) => item.name === name)?.value;
const isSection = (node: Element, number: string): boolean => attr(node, 'n') === number && (node.tagName === 'section' || (node.tagName.startsWith('div') && attr(node, 'type') === 'SECTION'));
function section(node: Node, number: string): Element | undefined { const pending = [node]; while (pending.length) { const candidate = pending.shift()!; if (isElement(candidate) && isSection(candidate, number)) return candidate; pending.push(...children(candidate)); } return undefined; }
function paragraph(node: Element, marker: string | undefined): string | undefined {
  if (marker === undefined) {
    const pending: Node[] = [node];
    while (pending.length) {
      const candidate = pending.shift()!;
      if (isElement(candidate) && candidate.tagName === 'p') return textOf(candidate);
      pending.push(...children(candidate));
    }
    return undefined;
  }
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = new RegExp(`^${escaped}(?=\\s|$)`);
  const markerParts = [...marker.matchAll(/\([a-z0-9]+\)/gi)].map((part) => part[0]);
  const outer = markerParts.length === 2 ? markerParts[0] : undefined;
  const inner = markerParts.length === 2 ? markerParts[1] : undefined;
  const innerLabel = inner && new RegExp(`^${inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
  let activeOuter: string | undefined;
  const pending: Node[] = [node];
  while (pending.length) {
    const candidate = pending.shift()!;
    if (isElement(candidate) && candidate.tagName === 'p') {
      // eCFR separates an initial legal label from inline markup such as <I>.
      // Use the first direct text node, which preserves the label boundary.
      const firstText = children(candidate).find((child): child is DefaultTreeAdapterTypes.TextNode => 'value' in child && typeof child.value === 'string');
      if (firstText) {
        const raw = firstText.value.trimStart();
        if (label.test(raw)) return textOf(candidate);
        const outerLabel = raw.match(/^\([a-z]\)/i)?.[0];
        if (outerLabel) activeOuter = outerLabel;
        if (outer && innerLabel && activeOuter === outer && innerLabel.test(raw)) return textOf(candidate);
      }
    }
    pending.push(...children(candidate));
  }
  return undefined;
}
async function page(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher }, url: string, requirement: string): Promise<string> {
  const found = context.offlinePages?.[url];
  if (found) return found;
  if (context.offlinePages) throw new Error(`missing source page for ${requirement}: ${url}`);
  try {
    return (await (context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any })).get(url, { accept: 'application/json, application/xml, text/xml' })).body.toString('utf8');
  } catch (error) {
    throw new Error(`could not fetch source page for ${requirement}: ${url}`, { cause: error });
  }
}

async function titleDates(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher }): Promise<Record<number, string>> {
  const body = await page(context, TITLES_URL, 'titles');
  const entries = JSON.parse(body).titles as Array<{ number: number; up_to_date_as_of: string }>;
  return Object.fromEntries(entries.map((entry) => [entry.number, entry.up_to_date_as_of]));
}

/** Reads eCFR versioned title text with the title's advertised as-of date. */
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher } = {}) {
  const dates = await titleDates(context);
  const catalog = newCatalog({ sourceId: 'ecfr-title-22', title: 'ITAR and EAR requirements', version: '0.1.0', retrievedAt: RETRIEVED_AT }) as unknown as GeneratedCatalog;
  catalog.catalog.metadata.remarks = `${NOTICE} Title 22: ${dates[22]}; Title 15: ${dates[15]}.`;
  const groups = new Map([['itar', newGroup('itar', 'International Traffic in Arms Regulations')], ['ear', newGroup('ear', 'Export Administration Regulations')]]);
  const documents = new Map<string, Node>();
  for (const [id, title, part, sectionNumber] of ITAR_REQUIREMENTS) {
    const date = dates[title]; if (!date) throw new Error(`missing as-of date for Title ${title}`);
    const url = sectionRequestUrl(date, title, part, sectionNumber);
    if (!documents.has(url)) documents.set(url, parse(await page(context, url, id)));
  }
  for (const [id, title, part, sectionNumber, marker] of ITAR_REQUIREMENTS) {
    const date = dates[title]; if (!date) throw new Error(`missing as-of date for Title ${title}`);
    const url = sectionRequestUrl(date, title, part, sectionNumber);
    const selected = section(documents.get(url)!, sectionNumber);
    const prose = selected && paragraph(selected, marker);
    if (!prose) throw new Error(`missing required paragraph ${id}`);
    groups.get(id.startsWith('ear-') ? 'ear' : 'itar')!.controls.push({ ...newControl({ id, title: id.toUpperCase(), label: id.toUpperCase() }), links: [{ href: url, rel: 'reference' }], parts: [statementPart(id, [prose])] });
  }
  catalog.catalog.groups.push(groups.get('itar')!, groups.get('ear')!);
  return {
    sourceId: 'ecfr-title-22', file: 'catalogs/itar/catalog.json', catalog,
    reportFile: 'import-reports/itar.json', report: { titleAsOf: { '15': dates[15], '22': dates[22] } }
  };
}

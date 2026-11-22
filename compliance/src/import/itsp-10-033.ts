import { createHash } from 'node:crypto';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { mainOf, parseHtml, controlSections } from './lib/cyberHtml.ts';
import { createFetcher, type Fetcher } from './lib/fetch.ts';
import { newCatalog, newGroup } from './lib/oscalBuild.ts';
import { controlFromSection, pairFrench, type ParsedControl } from './lib/itspControl.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Lang = 'en' | 'fr' | 'both';
const sourceId = 'itsp-10-033';
const landing = 'https://www.cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/itsp10033';
const frenchLanding = 'https://www.cyber.gc.ca/fr/orientation/gestion-risques-lies-cybersecurite-risques-datteinte-vie-privee/itsp10033';
const element = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const text = (node: Node): string => ('value' in node ? node.value : children(node).map(text).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value;

export interface ImportContext { readonly offlinePages?: Readonly<Record<string, string>>; readonly lang?: Lang; readonly fetcher?: Fetcher; }
export interface ImportReport { readonly retrievedAt: string; readonly pages: readonly { url: string; lang: 'en' | 'fr'; sha256: string; dateModified: string }[]; readonly families: readonly { id: string; controls: number; activities: number; enhancements: number; canadaSpecific: number }[]; readonly unrecognizedEnhancements: readonly { family: string; position: number; text: string }[]; readonly frenchOnly: readonly string[]; readonly englishOnly: readonly string[]; readonly frenchFailures: readonly { page: string; reason: string }[]; }

function normalPage(html: string): string { return text(mainOf(parseHtml(html))).replace(/\s+/g, ' ').trim(); }
type PageReader = (url: string) => Promise<string>;
function pageReader(context: ImportContext): PageReader {
  if (context.offlinePages) return async (url) => {
    const value = context.offlinePages?.[url];
    if (!value) throw new Error(`offline page missing: ${url}`);
    return value;
  };
  const fetcher = context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any });
  return async (url) => (await fetcher.get(url, { accept: 'text/html' })).body.toString('utf8');
}
function links(html: string, url: string): string[] { const out: string[] = []; const walk = (node: Node) => { if (element(node) && node.tagName === 'a') { const href = attr(node, 'href'); if (href) out.push(new URL(href, url).toString()); } children(node).forEach(walk); }; walk(mainOf(parseHtml(html))); return [...new Set(out)]; }
function familyLinks(html: string, landingPage: string): string[] {
  const base = new URL(landingPage); const prefix = `${base.pathname.replace(/\/$/, '')}/`;
  const excluded = new Set(['foreword-overview-introduction', 'avant-propos-vue-densmble-introduction', 'concepts-structure', 'controls-assurance-activities-families', 'controles-activites-dassurance']);
  return links(html, landingPage).filter((url) => {
    const candidate = new URL(url);
    const suffix = candidate.pathname.startsWith(prefix) ? candidate.pathname.slice(prefix.length) : '';
    return candidate.origin === base.origin && (/\/(?:family|famille)-/i.test(candidate.pathname) || (Boolean(suffix) && !suffix.includes('/') && !excluded.has(suffix)));
  });
}
function dateModified(html: string): string { let date = ''; const walk = (node: Node) => { if (element(node) && node.tagName === 'time' && attr(node, 'property') === 'dateModified') date = text(node); children(node).forEach(walk); }; walk(mainOf(parseHtml(html))); return date || 'unknown'; }
function familyId(control: ParsedControl): string { return control.id.split('-')[0]; }

async function readEnglish(page: PageReader) {
  const landingHtml = await page(landing);
  const urls = familyLinks(landingHtml, landing);
  const pages = [{ url: landing, lang: 'en' as const, sha256: createHash('sha256').update(normalPage(landingHtml)).digest('hex'), dateModified: 'unknown' }];
  const controls: ParsedControl[] = [];
  for (const url of urls) { const html = await page(url); controls.push(...controlSections(mainOf(parseHtml(html))).map((section) => controlFromSection(section, 'en'))); pages.push({ url, lang: 'en', sha256: createHash('sha256').update(normalPage(html)).digest('hex'), dateModified: dateModified(html) }); }
  return { controls, pages };
}

async function readFrench(page: PageReader) {
  const landingHtml = await page(frenchLanding);
  const urls = familyLinks(landingHtml, frenchLanding);
  const pages = [{ url: frenchLanding, lang: 'fr' as const, sha256: createHash('sha256').update(normalPage(landingHtml)).digest('hex'), dateModified: 'unknown' }];
  const controls: ParsedControl[] = [];
  const failures: { page: string; reason: string }[] = [];
  for (const url of urls) try {
    const html = await page(url);
    const sections = controlSections(mainOf(parseHtml(html)));
    if (!sections.length) throw new Error('French page has no control headings');
    controls.push(...sections.map((section) => controlFromSection(section, 'fr')));
    pages.push({ url, lang: 'fr', sha256: createHash('sha256').update(normalPage(html)).digest('hex'), dateModified: dateModified(html) });
  } catch (error) { failures.push({ page: url, reason: error instanceof Error ? error.message : String(error) }); }
  return { controls, pages, failures };
}

function addFrenchParts(english: ParsedControl, french: ParsedControl): void {
  const target = english.control;
  const translated = french.control;
  const parts = target.parts as Record<string, unknown>[];
  const frenchParts = translated.parts as Record<string, unknown>[];
  const prop = { name: 'lang', ns: 'urn:near-ai-vscode:compliance', value: 'fr' };
  parts.push({ id: `${english.id}_fr_title`, name: 'title', ns: 'urn:near-ai-vscode:compliance', prose: translated.title, props: [prop] });
  parts.push(...frenchParts.map((part, index) => ({ ...part, id: `${english.id}_fr_${index}`, props: [...(part.props as Record<string, unknown>[] ?? []), prop] })));
}

/** Imports the official-shaped ITSP.10.033 pages without letting markup become rendered HTML. */
export async function importSource(context: ImportContext) {
  if (context.lang === 'fr') throw new Error('French import requires authoritative English text');
  const page = pageReader(context);
  const english = await readEnglish(page);
  let french: Awaited<ReturnType<typeof readFrench>> = { controls: [], pages: [], failures: [] };
  if (context.lang === 'both') {
    try { french = await readFrench(page); }
    catch (error) { french = { controls: [], pages: [], failures: [{ page: frenchLanding, reason: error instanceof Error ? error.message : String(error) }] }; }
  }
  const pairing = pairFrench(english.controls, french.controls);
  pairing.pairs.forEach(({ english: base, french: translated }) => addFrenchParts(base, translated));
  const version = english.pages.find((entry) => entry.dateModified !== 'unknown')?.dateModified ?? 'unknown';
  const catalog = newCatalog({ sourceId, title: 'ITSP.10.033 catalogue', version, retrievedAt: '2026-11-21T00:00:00Z' });
  const groups = new Map<string, ReturnType<typeof newGroup>>();
  for (const parsed of english.controls) { const family = familyId(parsed); const group = groups.get(family) ?? newGroup(family, family.toUpperCase()); group.controls.push(parsed.control); groups.set(family, group); }
  (catalog.catalog.groups as unknown[]).push(...[...groups.values()]);
  const report: ImportReport = { retrievedAt: '2026-11-21T00:00:00Z', pages: [...english.pages, ...french.pages], families: [...groups].map(([id, group]) => { const parsed = english.controls.filter((control) => familyId(control) === id); return { id, controls: group.controls.filter((control: any) => control.class === 'control').length, activities: group.controls.filter((control: any) => control.class === 'activity').length, enhancements: parsed.reduce((count, control) => count + control.enhancements, 0), canadaSpecific: parsed.reduce((count, control) => count + control.canadaSpecific, 0) }; }), unrecognizedEnhancements: english.controls.flatMap((control) => control.unknownEnhancements.map((value, position) => ({ family: familyId(control), position, text: value }))), frenchOnly: pairing.frenchOnly, englishOnly: pairing.englishOnly, frenchFailures: french.failures };
  return { sourceId, catalog, file: 'catalogs/itsp-10-033/catalog.json', reports: [{ file: 'import-reports/itsp-10-033.json', content: report }] };
}

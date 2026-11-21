import { createHash } from 'node:crypto';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { mainOf, parseHtml, controlSections } from './lib/cyberHtml.ts';
import { newCatalog, newGroup } from './lib/oscalBuild.ts';
import { controlFromSection, type ParsedControl } from './lib/itspControl.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Lang = 'en' | 'fr' | 'both';
const sourceId = 'itsp-10-033';
const landing = 'https://www.cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/itsp10033';
const element = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const text = (node: Node): string => ('value' in node ? node.value : children(node).map(text).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value;

export interface ImportContext { readonly offlinePages?: Readonly<Record<string, string>>; readonly lang?: Lang; }
export interface ImportReport { readonly retrievedAt: string; readonly pages: readonly { url: string; lang: 'en' | 'fr'; sha256: string; dateModified: string }[]; readonly families: readonly { id: string; controls: number; activities: number; enhancements: number; canadaSpecific: number }[]; readonly unrecognizedEnhancements: readonly { family: string; position: number; text: string }[]; readonly frenchOnly: readonly string[]; readonly englishOnly: readonly string[]; readonly frenchFailures: readonly { page: string; reason: string }[]; }

function normalPage(html: string): string { return text(mainOf(parseHtml(html))).replace(/\s+/g, ' ').trim(); }
function page(context: ImportContext, url: string): string { const value = context.offlinePages?.[url]; if (!value) throw new Error(`offline page missing: ${url}`); return value; }
function links(html: string, url: string): string[] { const out: string[] = []; const walk = (node: Node) => { if (element(node) && node.tagName === 'a') { const href = attr(node, 'href'); if (href) out.push(new URL(href, url).toString()); } children(node).forEach(walk); }; walk(mainOf(parseHtml(html))); return [...new Set(out)]; }
function dateModified(html: string): string { let date = ''; const walk = (node: Node) => { if (element(node) && node.tagName === 'time' && attr(node, 'property') === 'dateModified') date = text(node); children(node).forEach(walk); }; walk(mainOf(parseHtml(html))); return date || 'unknown'; }
function familyId(control: ParsedControl): string { return control.id.split('-')[0]; }

function readEnglish(context: ImportContext) {
  const landingHtml = page(context, landing);
  const urls = links(landingHtml, landing).filter((url) => /family-/i.test(url));
  const pages = [{ url: landing, lang: 'en' as const, sha256: createHash('sha256').update(normalPage(landingHtml)).digest('hex'), dateModified: 'unknown' }];
  const controls: ParsedControl[] = [];
  for (const url of urls) { const html = page(context, url); controls.push(...controlSections(mainOf(parseHtml(html))).map((section) => controlFromSection(section, 'en'))); pages.push({ url, lang: 'en', sha256: createHash('sha256').update(normalPage(html)).digest('hex'), dateModified: dateModified(html) }); }
  return { controls, pages };
}

/** Imports the official-shaped ITSP.10.033 pages without letting markup become rendered HTML. */
export async function importSource(context: ImportContext) {
  if (context.lang === 'fr') throw new Error('French import requires authoritative English text');
  const english = readEnglish(context);
  const version = english.pages.find((entry) => entry.dateModified !== 'unknown')?.dateModified ?? 'unknown';
  const catalog = newCatalog({ sourceId, title: 'ITSP.10.033 catalogue', version, retrievedAt: '2026-11-21T00:00:00Z' });
  const groups = new Map<string, ReturnType<typeof newGroup>>();
  for (const parsed of english.controls) { const family = familyId(parsed); const group = groups.get(family) ?? newGroup(family, family.toUpperCase()); group.controls.push(parsed.control); groups.set(family, group); }
  (catalog.catalog.groups as unknown[]).push(...[...groups.values()]);
  const report: ImportReport = { retrievedAt: '2026-11-21T00:00:00Z', pages: english.pages, families: [...groups].map(([id, group]) => { const parsed = english.controls.filter((control) => familyId(control) === id); return { id, controls: group.controls.filter((control: any) => control.class === 'control').length, activities: group.controls.filter((control: any) => control.class === 'activity').length, enhancements: parsed.reduce((count, control) => count + control.enhancements, 0), canadaSpecific: parsed.reduce((count, control) => count + control.canadaSpecific, 0) }; }), unrecognizedEnhancements: english.controls.flatMap((control) => control.unknownEnhancements.map((value, position) => ({ family: familyId(control), position, text: value }))), frenchOnly: [], englishOnly: [], frenchFailures: [] };
  return { sourceId, catalog, file: 'catalogs/itsp-10-033/catalog.json', reports: [{ file: 'import-reports/itsp-10-033.json', content: report }] };
}

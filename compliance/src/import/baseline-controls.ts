import { mainOf, parseHtml } from './lib/cyberHtml.ts'; import { newCatalog } from './lib/oscalBuild.ts'; import { createFetcher, type Fetcher } from './lib/fetch.ts';
type Node = { tagName?: string; childNodes?: readonly Node[]; value?: string; attrs?: readonly { name: string; value: string }[] };
const blockTags = new Set(['h2', 'h3', 'h4', 'p', 'ol', 'ul', 'table']);
function rawText(node: Node): string {
  const css = node.attrs?.find(({ name }) => name === 'class')?.value.split(/\s+/) ?? [];
  if (css.includes('wb-inv')) return '';
  const footnote = node.tagName === 'sup' && node.attrs?.find(({ name }) => name === 'id')?.value.match(/^fn(\d+)-rf$/);
  if (footnote) return ` [Footnote ${footnote[1]}]`;
  const content = node.value ?? (node.childNodes ?? []).map(rawText).join('');
  return node.tagName === 'li' || node.tagName === 'br' ? ` ${content} ` : content;
}
const text = (node: Node): string => rawText(node).replace(/\s+/g, ' ').trim();
const headingAndContentNodes = (node: Node): Node[] => blockTags.has(node.tagName ?? '')
  ? [node]
  : (node.childNodes ?? []).flatMap(headingAndContentNodes);
/** Baseline v1.2 headings deliberately define stable ids; no third-party ids are invented. */
export function parseBaselineControls(html: string): any {
  const catalog = newCatalog({ sourceId: 'baseline-controls-v1-2', title: 'Baseline cyber security controls for small and medium organizations v1.2', version: '1.2', retrievedAt: '2026-11-21T00:00:00Z' }) as any;
  const groups = [{ id: 'steps', title: 'Organizational steps', controls: [] as any[] }, { id: 'controls', title: 'Baseline controls', controls: [] as any[] }];
  const nodes = headingAndContentNodes(mainOf(parseHtml(html)) as unknown as Node); let current: any | undefined;
  for (let index = 0; index < nodes.length; index += 1) { const node = nodes[index]; if (node.tagName === 'h2') { current = /^2\b/.test(text(node)) ? groups[0] : /^3\b/.test(text(node)) ? groups[1] : undefined; continue; } if (node.tagName !== 'h3' || !current) continue; const match = /^(\d+\.\d+)\s+(.+)$/.exec(text(node)); if (!match) continue; const prose: string[] = []; for (let next = index + 1; next < nodes.length && !['h2', 'h3'].includes(nodes[next].tagName ?? ''); next += 1) if (text(nodes[next])) prose.push(text(nodes[next])); current.controls.push({ id: `bcc-${match[1]}`, title: match[2], props: [{ name: 'label', value: match[1] }], parts: [{ id: `bcc-${match[1]}_smt`, name: 'statement', prose: prose.join(' ') }] }); }
  catalog.catalog.groups = groups; return catalog;
}
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher }): Promise<{ sourceId: string; catalog: unknown; file: string }> { const html = context.offlinePages?.baseline ?? (await (context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any })).get('https://www.cyber.gc.ca/en/guidance/baseline-cyber-security-controls-small-and-medium-organizations', { accept: 'text/html' })).body.toString('utf8'); return { sourceId: 'baseline-controls-v1-2', catalog: parseBaselineControls(html), file: 'catalogs/baseline-controls/catalog.json' }; }

import { mainOf, parseHtml } from './lib/cyberHtml.ts'; import { newCatalog } from './lib/oscalBuild.ts';
type Node = { tagName?: string; childNodes?: readonly Node[]; value?: string };
const text = (node: Node): string => (node.value ?? (node.childNodes ?? []).map(text).join('')).replace(/\s+/g, ' ').trim();
/** Baseline v1.2 headings deliberately define stable ids; no third-party ids are invented. */
export function parseBaselineControls(html: string): any {
  const catalog = newCatalog({ sourceId: 'baseline-controls-v1-2', title: 'Baseline cyber security controls for small and medium organizations v1.2', version: '1.2', retrievedAt: '2026-11-21T00:00:00Z' }) as any;
  const groups = [{ id: 'steps', title: 'Organizational steps', controls: [] as any[] }, { id: 'controls', title: 'Baseline controls', controls: [] as any[] }];
  const nodes = (mainOf(parseHtml(html)).childNodes ?? []) as unknown as readonly Node[]; let current: any = groups[0];
  for (let index = 0; index < nodes.length; index += 1) { const node = nodes[index]; if (node.tagName === 'h2') { current = /^3\./.test(text(node)) ? groups[1] : groups[0]; continue; } if (node.tagName !== 'h3') continue; const match = /^(\d+\.\d+)\s+(.+)$/.exec(text(node)); if (!match) continue; const prose: string[] = []; for (let next = index + 1; next < nodes.length && !['h2', 'h3'].includes(nodes[next].tagName ?? ''); next += 1) if (text(nodes[next])) prose.push(text(nodes[next])); current.controls.push({ id: `bcc-${match[1]}`, title: match[2], props: [{ name: 'label', value: match[1] }], parts: [{ id: `bcc-${match[1]}_smt`, name: 'statement', prose: prose.join(' ') }] }); }
  catalog.catalog.groups = groups; return catalog;
}
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>> }): Promise<{ sourceId: string; catalog: unknown; file: string }> { if (!context.offlinePages?.baseline) throw new Error('baseline-controls importer requires an offline baseline page'); return { sourceId: 'baseline-controls-v1-2', catalog: parseBaselineControls(context.offlinePages.baseline), file: 'catalogs/baseline-controls/catalog.json' }; }

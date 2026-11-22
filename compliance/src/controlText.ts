import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mayStoreText } from './import/lib/licence.ts';
import { SOURCE_REGISTRY, type SourceEntry } from './import/lib/sourceRegistry.ts';
import { NS } from './model.ts';
import { loadJson, validateOurs } from './validate.ts';

type Json = Record<string, unknown>;
type SourceSnapshot = Omit<SourceEntry, 'pages'> & { readonly retrievedAt: string; readonly pages: readonly { readonly url: string; readonly sha256?: string }[] };
type ControlText = { id: string; label: string; title: string; parts: ReturnType<typeof controlParts> };
const record = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const objects = (value: unknown): Json[] => Array.isArray(value) ? value.filter(record) : [];
const children = (value: Json): Json[] => [...objects(value.controls).flatMap((control) => [control, ...children(control)]), ...objects(value.groups).flatMap(children)];
const prop = (props: unknown, name: string, namespace?: string) => objects(props).find((item) => item.name === name && item.ns === namespace)?.value;
const text = (value: unknown, fallback: string): string => typeof value === 'string' && value ? value : fallback;

function controlParts(items: unknown, inheritedLang = 'en'): { name: string; prose: string; lang: string }[] {
  return objects(items).flatMap((part) => {
    const lang = text(prop(part.props, 'lang', NS), inheritedLang);
    return [
      ...(typeof part.prose === 'string' && part.prose.trim() ? [{ name: text(part.name, 'part'), prose: part.prose, lang }] : []),
      ...controlParts(part.parts, lang),
    ];
  });
}

// Each mixed-source overlay is split by the importer group so its text keeps its own attribution.
const CATALOGUES = [
  { file: 'itsp-10-033/catalog.json', source: 'itsp-10-033', pathPart: '/itsp10033', levels: ['unclassified', 'protected-a', 'protected-b'] },
  { file: 'itsp-10-171/catalog.json', source: 'itsp-10-171', pathPart: 'itsp10171', levels: ['itsp-10-171', 'cpcsc-level-1'] },
  { file: 'itsg-33/annex-3a.json', source: 'itsg-33', pathPart: 'annex-3a-security-control-catalogue-itsg-33', levels: ['classified'] },
  { file: 'cgp/catalog.json', source: 'defence-production-act', pathPart: '/D-1/section-37.html', levels: ['overlay-cgp'], group: 'dpa', rootSource: 'defence-production-act' },
  { file: 'cgp/catalog.json', source: 'controlled-goods-regulations', pathPart: '/SOR-2001-32/FullText.html', levels: ['overlay-cgp'], group: 'cgr', rootSource: 'defence-production-act' },
  { file: 'itar/catalog.json', source: 'ecfr-title-22', pathPart: '/versioner/v1/titles.json', levels: ['overlay-itar'], group: 'itar', rootSource: 'ecfr-title-22' },
  { file: 'itar/catalog.json', source: 'ecfr-15-734', pathPart: '/versioner/v1/titles.json', levels: ['overlay-itar'], group: 'ear', rootSource: 'ecfr-title-22' },
] as const;

export function writeControlText(outDir: string, sourceRoot: string) {
  const { sources } = loadJson(path.join(sourceRoot, 'sources.json')) as { sources: SourceSnapshot[] };
  const index: { catalog: string; family: string; file: string }[] = [];
  const byLevel = new Map<string, Map<string, { label: string; title: string; textFile: string }>>();
  for (const spec of CATALOGUES) {
    const { catalog } = loadJson(path.join(sourceRoot, 'catalogs', spec.file)) as { catalog: Json };
    const metadata = record(catalog.metadata) ? catalog.metadata : {};
    const source = sources.find((item) => item.id === spec.source);
    const registryEntry = SOURCE_REGISTRY.find((item) => item.id === spec.source);
    const url = source?.pages.find((page) => page.sha256 && page.url.includes(spec.pathPart))?.url;
    if (!source || !registryEntry || !url || prop(metadata.props, 'source-id', NS) !== ('rootSource' in spec ? spec.rootSource : spec.source)) {
      throw new Error(`missing verified catalogue attribution for ${spec.source}`);
    }
    const cataloguePart = 'group' in spec ? objects(catalog.groups).find((group) => group.id === spec.group) : catalog;
    if (!cataloguePart) throw new Error(`missing catalogue group for ${spec.source}`);
    const licensed = mayStoreText(source) && mayStoreText(registryEntry) && source.licence === registryEntry.licence;
    const families = new Map<string, ControlText[]>();
    const summaries = new Map<string, { label: string; title: string; textFile: string }>();
    for (const control of children(cataloguePart)) {
      const id = control.id;
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(id)) throw new Error(`invalid control identifier in ${spec.source}`);
      const family = id.split('-')[0];
      const label = text(prop(control.props, 'label'), id.toUpperCase());
      const title = text(control.title, id);
      const entry = { id, label, title, parts: licensed ? controlParts(control.parts) : [] };
      const entries = families.get(family) ?? [];
      entries.push(entry);
      families.set(family, entries);
      summaries.set(id, { label, title, textFile: `text/${spec.source}/${family}.json` });
    }
    for (const [family, controls] of families) {
      const file = `text/${spec.source}/${family}.json`;
      const document = { catalog: spec.source, family, attribution: { source: source.title, url, licence: source.licence, retrievedAt: source.retrievedAt, notice: 'Unofficial representation of the source. Consult the official publication.' }, controls };
      const valid = validateOurs(document, 'control-text');
      if (!valid.ok) throw new Error(`invalid control text ${file}: ${valid.errors.join('; ')}`);
      const target = path.join(outDir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
      index.push({ catalog: spec.source, family, file });
    }
    for (const level of spec.levels) {
      const existing = byLevel.get(level);
      if (existing) for (const [id, summary] of summaries) {
        if (existing.has(id)) throw new Error(`duplicate text attribution for ${level}/${id}`);
        existing.set(id, summary);
      }
      else byLevel.set(level, new Map(summaries));
    }
  }
  return { index: index.sort((a, b) => a.file.localeCompare(b.file)), byLevel };
}

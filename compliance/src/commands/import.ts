import path from 'node:path';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { SOURCE_REGISTRY } from '../import/lib/sourceRegistry.ts';
import type { Fetcher } from '../import/lib/fetch.ts';
import { writeImportResult } from '../import/lib/write.ts';

const IMPORT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  cgp: 'cgp',
  itar: 'itar',
  'nist-oscal-content-v1-6-0': 'nist-800-53',
});

interface ImportResult {
  readonly sourceId: string;
  readonly catalog: unknown;
  readonly file?: string;
  readonly rawBytes?: Buffer;
  readonly reports?: readonly { readonly file: string; readonly content: unknown }[];
  readonly reportFile?: string;
  readonly report?: unknown;
}

/** Dispatches a future per-source importer while keeping all writes behind writeImportResult. */
export async function run(argv: readonly string[], context: { readonly fetcher?: Fetcher } = {}): Promise<number> {
  const [source, ...options] = argv;
  if (!source || !/^[a-z0-9-]+$/.test(source)) return 2;
  const isAlias = Object.hasOwn(IMPORT_ALIASES, source);
  const moduleName = isAlias ? IMPORT_ALIASES[source] : source;
  if (!isAlias && !SOURCE_REGISTRY.some((entry) => entry.id === source)) return 2;
  const outIndex = options.indexOf('--out-root');
  const offlineIndex = options.indexOf('--offline');
  const langIndex = options.indexOf('--lang');
  const outRoot = outIndex === -1 ? 'compliance' : options[outIndex + 1];
  const lang = langIndex === -1 ? 'both' : options[langIndex + 1];
  if (!outRoot || (offlineIndex !== -1 && !options[offlineIndex + 1]) || !['en', 'fr', 'both'].includes(lang)) return 2;
  const importer = await import(`../import/${moduleName}.ts`) as { importSource?: (context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly lang?: 'en' | 'fr' | 'both'; readonly fetcher?: Fetcher }) => Promise<ImportResult> };
  if (!importer.importSource) return 2;
  const offlinePages = offlineIndex === -1 ? undefined : JSON.parse(readFileSync(path.join(options[offlineIndex + 1], 'pages.json'), 'utf8')) as Record<string, string>;
  const result = await importer.importSource({ offlinePages, lang: lang as 'en' | 'fr' | 'both', fetcher: context.fetcher });
  writeImportResult(outRoot, result, SOURCE_REGISTRY);
  if (result.rawBytes) writeRawResult(outRoot, result.file ?? path.join('catalogs', `${result.sourceId}.json`), result.rawBytes);
  const reports = result.reports ?? (result.reportFile ? [{ file: result.reportFile, content: result.report }] : []);
  writeReports(outRoot, reports);
  return 0;
}

/** Replaces the checked catalogue serialization with verified importer bytes without a JSON round-trip. */
export function writeRawResult(outRoot: string, file: string, bytes: Buffer): void {
  mkdirSync(outRoot, { recursive: true });
  const root = realpathSync(outRoot);
  if (path.isAbsolute(file)) throw new Error('import output must be relative');
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('import output escapes its root');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes, { mode: 0o644 });
}

/** Writes source-neutral importer reports under the same lexical output boundary as catalogues. */
function writeReports(outRoot: string, reports: readonly { readonly file: string; readonly content: unknown }[]): void {
  mkdirSync(outRoot, { recursive: true });
  const root = realpathSync(outRoot);
  for (const report of reports) {
    if (path.isAbsolute(report.file)) throw new Error('import report must be relative');
    const target = path.resolve(root, report.file);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('import report escapes its root');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(report.content, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  }
}

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { SOURCE_REGISTRY } from '../import/lib/sourceRegistry.ts';
import { writeImportResult } from '../import/lib/write.ts';

/** Dispatches a future per-source importer while keeping all writes behind writeImportResult. */
export async function run(argv: readonly string[]): Promise<number> {
  const [source, ...options] = argv;
  if (!source || !/^[a-z0-9-]+$/.test(source) || !SOURCE_REGISTRY.some((entry) => entry.id === source)) return 2;
  const outIndex = options.indexOf('--out-root');
  const offlineIndex = options.indexOf('--offline');
  const outRoot = outIndex === -1 ? 'compliance' : options[outIndex + 1];
  if (!outRoot || (offlineIndex !== -1 && !options[offlineIndex + 1])) return 2;
  try {
    const importer = await import(`../import/${source}.ts`) as { importSource?: (context: { readonly offlinePages?: Readonly<Record<string, string>> }) => Promise<{ sourceId: string; catalog: unknown; file?: string }> };
    if (!importer.importSource) return 2;
    const offlinePages = offlineIndex === -1 ? undefined : JSON.parse(readFileSync(path.join(options[offlineIndex + 1], 'pages.json'), 'utf8')) as Record<string, string>;
    const result = await importer.importSource({ offlinePages });
    writeImportResult(outRoot, result, SOURCE_REGISTRY);
    return 0;
  } catch { return 2; }
}

import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFetcher, type Fetcher } from '../import/lib/fetch.ts';
import { normalizedHash } from '../import/lib/normalize.ts';
import { buildNotice } from '../import/lib/notice.ts';
import { SOURCE_REGISTRY } from '../import/lib/sourceRegistry.ts';

type SourcePageSnapshot = { readonly url: string; readonly lang?: 'en' | 'fr'; readonly sha256?: string; readonly error?: string };
type SourceSnapshot = (typeof SOURCE_REGISTRY)[number] & { readonly retrievedAt: string; readonly sha256: string; readonly pages: readonly SourcePageSnapshot[] };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const pageHash = (value: string) => { try { return normalizedHash(value); } catch { return sha256(value); } };
const retrievalDay = () => `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
const safeWrite = (root: string, relative: string, content: string) => { mkdirSync(root, { recursive: true }); const canonical = realpathSync(root); const target = path.resolve(canonical, relative); if (!target.startsWith(`${canonical}${path.sep}`)) throw new Error('source snapshot output escapes its root'); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content, 'utf8'); };

/** Captures page hashes and licence evidence separately from imports so a data PR has reproducible provenance. */
export async function run(argv: readonly string[], context: { readonly fetcher?: Fetcher; readonly retrievedAt?: string } = {}): Promise<number> {
  const index = argv.indexOf('--out-root'); const outRoot = index === -1 ? 'compliance' : argv[index + 1];
  if (!outRoot || (index !== -1 && index !== argv.length - 2)) throw new Error('usage: sources [--out-root <directory>]');
  const fetcher = context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any }); const retrievedAt = context.retrievedAt ?? retrievalDay();
  const sources: SourceSnapshot[] = [];
  for (const source of SOURCE_REGISTRY) {
    const pages: SourcePageSnapshot[] = [];
    for (const page of source.pages) {
      try { const result = await fetcher.get(page.url, { browserAgent: source.browserAgent }); const text = result.body.toString('utf8'); pages.push({ url: result.url, ...(page.lang ? { lang: page.lang } : {}), sha256: pageHash(text) }); }
      catch (error) { pages.push({ url: page.url, ...(page.lang ? { lang: page.lang } : {}), error: error instanceof Error ? error.message : String(error) }); }
    }
    sources.push({ ...source, retrievedAt, sha256: sha256(pages.map((page) => page.sha256 ?? `ERROR:${page.error}`).join('\n')), pages });
  }
  safeWrite(outRoot, 'sources.json', `${JSON.stringify({ sources }, null, 2)}\n`);
  safeWrite(outRoot, 'catalogs/NOTICE', buildNotice(sources));
  return 0;
}

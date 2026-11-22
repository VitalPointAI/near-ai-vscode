import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createFetcher } from '../import/lib/fetch.ts';
import { normalizedHash } from '../import/lib/normalize.ts';
import { SOURCE_REGISTRY } from '../import/lib/sourceRegistry.ts';

type SourceObservation = { id: string; url: string; result: 'moved' | 'failed' | 'unchanged' | 'changed'; sha256?: string; previous?: string };
type StoredSource = { id: string; pages?: { url: string; sha256?: string }[] };

function pageHash(body: string): string {
  try { return normalizedHash(body); } catch { return createHash('sha256').update(body).digest('hex'); }
}

export async function run(argv: readonly string[], context: { fetchText?: (url: string) => Promise<{ status: number; body: string }>; now?: () => Date } = {}): Promise<number> {
  const out = argv[0] === '--out' ? argv[1] : undefined;
  const stored: { sources?: StoredSource[] } = existsSync('compliance/sources.json')
    ? JSON.parse(readFileSync('compliance/sources.json', 'utf8')) : {};
  const report = { checkedAt: (context.now?.() ?? new Date()).toISOString(), sources: [] as SourceObservation[] };
  const fetcher = createFetcher({ fetchImpl: globalThis.fetch });
  for (const source of SOURCE_REGISTRY) {
    for (const { url } of source.pages) {
      const identity = { id: source.id, url };
      try {
        const got = context.fetchText ? await context.fetchText(url) : await fetcher.get(url, { browserAgent: source.browserAgent, allowNotFound: true });
        if (got.status === 404) {
          report.sources.push({ ...identity, result: 'moved' });
        } else if (got.status >= 200 && got.status < 300) {
          const sha256 = pageHash(got.body.toString());
          const previous = stored.sources?.find((s) => s.id === source.id)?.pages?.find((p) => p.url === url || ('url' in got && p.url === got.url))?.sha256;
          report.sources.push({ ...identity, result: previous === sha256 ? 'unchanged' : 'changed', sha256, ...(previous ? { previous } : {}) });
        } else {
          report.sources.push({ ...identity, result: 'failed' });
        }
      } catch {
        report.sources.push({ ...identity, result: 'failed' });
      }
    }
  }
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
  return 0;
}

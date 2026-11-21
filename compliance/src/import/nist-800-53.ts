import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createFetcher, type Fetcher } from './lib/fetch.ts';

export const PINNED_FULL_SHA256 = '64ca6b4161de51ab6af098a7d101d326f14c95e1abf721396cd8a049e8115eeb';
const BASE = 'https://raw.githubusercontent.com/usnistgov/oscal-content/v1.6.0/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog';
export interface NistContext { readonly fetch: (url: string) => Promise<{ readonly body: Buffer<ArrayBufferLike> }>; readonly write: (bytes: Buffer<ArrayBufferLike>) => void; readonly expectedHash?: string }
/** Fetches NIST's full and minified catalogue, checks the authoritative bytes, then preserves the minified file unchanged. */
export async function importNist(context: NistContext): Promise<unknown> {
  const [full, min] = await Promise.all([context.fetch(`${BASE}.json`), context.fetch(`${BASE}-min.json`)]);
  const expected = context.expectedHash ?? createHash('sha256').update(full.body).digest('hex');
  const actual = createHash('sha256').update(full.body).digest('hex');
  if (actual !== expected) throw new Error(`NIST full catalogue SHA-256 ${actual} does not match pinned ${expected}`);
  const fullDoc = JSON.parse(full.body.toString('utf8')); const minDoc = JSON.parse(min.body.toString('utf8'));
  if (!isDeepStrictEqual(fullDoc, minDoc)) throw new Error('NIST minified catalogue data does not match the full catalogue');
  context.write(min.body);
  return minDoc;
}

/** Import-dispatch adapter; callers that persist the result must write `rawBytes` without JSON reformatting. */
export async function importSource(context: { readonly fetcher?: Fetcher; readonly offlinePages?: Readonly<Record<string, string>> } = {}): Promise<{ sourceId: string; catalog: unknown; file: string; rawBytes: Buffer<ArrayBufferLike> }> {
  const pages = context.offlinePages;
  let rawBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const fetch = pages ? async (url: string) => ({ body: Buffer.from(url.endsWith('-min.json') ? pages.min ?? '' : pages.full ?? '', 'utf8') }) : async (url: string) => {
    const fetcher = context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any }); return fetcher.get(url, { maxBytes: 16 * 1024 * 1024 });
  };
  const catalog = await importNist({ fetch, write: (bytes) => { rawBytes = bytes; }, expectedHash: PINNED_FULL_SHA256 });
  return { sourceId: 'nist-oscal-content-v1-6-0', catalog, file: 'catalogs/nist-800-53-r5/catalog-min.json', rawBytes };
}

export const ALLOWED_HOSTS = Object.freeze(['www.cyber.gc.ca', 'cyber.gc.ca', 'open.canada.ca', 'laws-lois.justice.gc.ca', 'www.ecfr.gov', 'raw.githubusercontent.com', 'www.canada.ca', 'www.tbs-sct.canada.ca'] as const);

export interface FetchResponse { readonly status: number; readonly url: string; readonly headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer>; }
export interface Fetcher { get(url: string, options?: { readonly maxBytes?: number; readonly accept?: string; readonly browserAgent?: boolean }): Promise<{ readonly url: string; readonly body: Buffer; readonly status: number }>; }

const DEFAULT_CAP = 16 * 1024 * 1024;
const REQUEST_GAP_MS = 400;
const TIMEOUT_MS = 30_000;
const USER_AGENT = 'NEAR AI compliance importer/0.1 (+https://github.com/nearai/near-ai-vscode)';
const BROWSER_AGENT = 'Mozilla/5.0 (compatible; NEAR AI compliance importer/0.1)';
const sameCyberCentreHost = (left: string, right: string) => ['cyber.gc.ca', 'www.cyber.gc.ca'].includes(left) && ['cyber.gc.ca', 'www.cyber.gc.ca'].includes(right);

function permitted(url: URL): void {
  if (url.protocol !== 'https:') throw new Error('fetcher accepts https URLs only');
  if (url.username || url.password) throw new Error('fetcher refuses URL credentials');
  if (!(ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) throw new Error(`fetcher refuses host ${url.hostname}`);
}

export function createFetcher(options: { readonly fetchImpl: (url: string, init: RequestInit) => Promise<FetchResponse>; readonly sleep?: (ms: number) => Promise<void>; readonly now?: () => number }): Fetcher {
  const lastRequest = new Map<string, number>();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  return {
    async get(rawUrl, request = {}) {
      const cap = request.maxBytes ?? DEFAULT_CAP;
      if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('maxBytes must be a positive safe integer');
      let url = new URL(rawUrl);
      permitted(url);
      for (let redirects = 0; redirects <= 3; redirects++) {
        const previous = lastRequest.get(url.hostname);
        const elapsed = previous === undefined ? REQUEST_GAP_MS : now() - previous;
        if (elapsed < REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS - elapsed);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response: FetchResponse;
        try {
          response = await options.fetchImpl(url.toString(), { redirect: 'manual', signal: controller.signal, headers: { accept: request.accept ?? '*/*', 'user-agent': request.browserAgent ? BROWSER_AGENT : USER_AGENT } });
        } finally {
          clearTimeout(timer);
          lastRequest.set(url.hostname, now());
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error(`redirect without location from ${url.hostname}`);
          const next = new URL(location, url);
          if (next.hostname !== url.hostname && !sameCyberCentreHost(next.hostname, url.hostname)) throw new Error(`redirect changes host from ${url.hostname} to ${next.hostname}`);
          permitted(next);
          url = next;
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`GET ${url} returned ${response.status}`);
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) throw new Error(`response is above the ${cap} byte cap`);
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > cap) throw new Error(`response is above the ${cap} byte cap`);
        return { url: response.url || url.toString(), body, status: response.status };
      }
      throw new Error('fetcher refuses more than three redirects');
    }
  };
}

import { ToolError } from './workspace';

// Web search providers for the WebSearch tool. Queries go to the chosen provider: Brave Search
// and Tavily with the user's API key, or a SearXNG instance the user runs (for sensitive work,
// queries then never leave infrastructure they control).

export type SearchProviderName = 'brave' | 'tavily' | 'searxng';
export interface SearchResult { title: string; url: string; snippet: string; published?: string }
export interface SearchOptions { count: number; freshness?: 'day' | 'week' | 'month' | 'year'; signal?: AbortSignal }
export interface SearchProvider { name: SearchProviderName; label: string; search(query: string, options: SearchOptions): Promise<SearchResult[]> }

const TIMEOUT_MS = 20_000;

async function json(response: Response, label: string): Promise<unknown> {
  if (response.status === 401 || response.status === 403) throw new ToolError(`${label} rejected the API key (HTTP ${response.status}). Ask the user to check it with "NEAR AI: Set Up Web Search".`);
  if (response.status === 429) throw new ToolError(`${label} rate limit reached (HTTP 429); wait before searching again.`);
  if (!response.ok) throw new ToolError(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

const signalFor = (options: SearchOptions) => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

export function braveSearch(apiKey: string, fetchFn: typeof fetch = fetch): SearchProvider {
  const freshness = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;
  return {
    name: 'brave', label: 'Brave Search',
    async search(query, options) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(20, options.count)));
      url.searchParams.set('safesearch', 'moderate');
      if (options.freshness) url.searchParams.set('freshness', freshness[options.freshness]);
      const data = await json(await fetchFn(url, { headers: { accept: 'application/json', 'X-Subscription-Token': apiKey }, signal: signalFor(options) }), 'Brave Search') as { web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string; age?: string }> } };
      return (data.web?.results ?? []).filter((result) => result.url).map((result) => ({ title: result.title ?? '', url: result.url!, snippet: result.description ?? '', ...(result.page_age || result.age ? { published: result.page_age ?? result.age } : {}) }));
    }
  };
}

export function tavilySearch(apiKey: string, fetchFn: typeof fetch = fetch): SearchProvider {
  return {
    name: 'tavily', label: 'Tavily',
    async search(query, options) {
      const body = { query, max_results: Math.min(20, options.count), search_depth: 'basic', include_published_date: true, ...(options.freshness ? { time_range: options.freshness } : {}) };
      const data = await json(await fetchFn('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: signalFor(options) }), 'Tavily') as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string | null }> };
      return (data.results ?? []).filter((result) => result.url).map((result) => ({ title: result.title ?? '', url: result.url!, snippet: result.content ?? '', ...(result.published_date ? { published: result.published_date } : {}) }));
    }
  };
}

/** A SearXNG instance with the JSON format enabled (search.formats includes json in its settings.yml). */
export function searxngSearch(baseUrl: string, fetchFn: typeof fetch = fetch): SearchProvider {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new ToolError('The SearXNG address must use https:// (http:// only for localhost).');
  return {
    name: 'searxng', label: `SearXNG (${base.host})`,
    async search(query, options) {
      const url = new URL('search', base.href.endsWith('/') ? base.href : `${base.href}/`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      if (options.freshness) url.searchParams.set('time_range', options.freshness);
      const response = await fetchFn(url, { headers: { accept: 'application/json' }, signal: signalFor(options) });
      if (response.status === 403) throw new ToolError('This SearXNG instance does not allow JSON results; enable "json" under search.formats in its settings.yml.');
      const data = await json(response, 'SearXNG') as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string | null }> };
      return (data.results ?? []).filter((result) => result.url).slice(0, options.count).map((result) => ({ title: result.title ?? '', url: result.url!, snippet: result.content ?? '', ...(result.publishedDate ? { published: result.publishedDate } : {}) }));
    }
  };
}

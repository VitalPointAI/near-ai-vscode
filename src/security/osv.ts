import type { Component, Ecosystem } from './lockfiles';

// Known vulnerabilities for exact package versions, from OSV.dev (Google's open database that
// aggregates GitHub Security Advisories, PyPA, Go, RustSec, and others). Only package names and
// versions are sent.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface Vulnerability {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  score?: number;
  vector?: string;
  published?: string;
  modified?: string;
  url: string;
  cwes: string[];
  /** Versions that fix it for this package, lowest first. */
  fixed: string[];
}

export interface PackageFinding { component: Component; vulnerabilities: Vulnerability[] }

type Fetch = typeof fetch;
type OsvVuln = {
  id: string; summary?: string; details?: string; aliases?: string[]; modified?: string; published?: string; withdrawn?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string; cwe_ids?: string[] };
  affected?: Array<{ package?: { ecosystem?: string; name?: string }; ranges?: Array<{ type: string; events: Array<Record<string, string>> }>; versions?: string[]; ecosystem_specific?: { severity?: string } }>;
};

const API = 'https://api.osv.dev/v1';
const BATCH = 500;
const DETAIL_CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;
const detailCache = new Map<string, OsvVuln>();

async function post(fetchFn: Fetch, url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'NEAR-AI-VSCode' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OSV.dev returned HTTP ${response.status}.`);
  return response.json();
}

async function vulnerabilityDetails(fetchFn: Fetch, id: string, modified: string | undefined, signal?: AbortSignal): Promise<OsvVuln> {
  const key = `${id}@${modified ?? ''}`;
  const cached = detailCache.get(key);
  if (cached) return cached;
  const response = await fetchFn(`${API}/vulns/${encodeURIComponent(id)}`, { headers: { 'user-agent': 'NEAR-AI-VSCode' }, signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OSV.dev returned HTTP ${response.status} for ${id}.`);
  const vuln = await response.json() as OsvVuln;
  if (detailCache.size > 5_000) detailCache.clear();
  detailCache.set(key, vuln);
  return vuln;
}

/** Queries OSV.dev for every component and returns those with known, non-withdrawn vulnerabilities. */
export async function queryOsv(components: Component[], options: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<PackageFinding[]> {
  const fetchFn = options.fetch ?? fetch;
  const ids = new Map<number, Array<{ id: string; modified?: string }>>();
  for (let start = 0; start < components.length; start += BATCH) {
    const chunk = components.slice(start, start + BATCH);
    let queries = chunk.map((component, offset) => ({ index: start + offset, query: { package: { purl: component.purl } } as Record<string, unknown> }));
    while (queries.length) {
      const result = await post(fetchFn, `${API}/querybatch`, { queries: queries.map((item) => item.query) }, options.signal) as { results?: Array<{ vulns?: Array<{ id: string; modified?: string }>; next_page_token?: string }> };
      const next: typeof queries = [];
      (result.results ?? []).forEach((entry, position) => {
        const item = queries[position];
        if (!item) return;
        if (entry.vulns?.length) ids.set(item.index, [...(ids.get(item.index) ?? []), ...entry.vulns]);
        if (entry.next_page_token) next.push({ index: item.index, query: { ...item.query, page_token: entry.next_page_token } });
      });
      queries = next;
    }
  }
  const unique = new Map<string, string | undefined>();
  for (const list of ids.values()) for (const vuln of list) unique.set(vuln.id, vuln.modified);
  const details = new Map<string, OsvVuln>();
  const pending = [...unique.entries()];
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, pending.length) }, async () => {
    for (let item = pending.shift(); item; item = pending.shift()) details.set(item[0], await vulnerabilityDetails(fetchFn, item[0], item[1], options.signal));
  }));
  const findings: PackageFinding[] = [];
  for (const [index, list] of ids) {
    const component = components[index];
    const vulnerabilities = list.map((entry) => details.get(entry.id)).filter((vuln): vuln is OsvVuln => Boolean(vuln && !vuln.withdrawn)).map((vuln) => describe(vuln, component)).sort((a, b) => rank(b.severity) - rank(a.severity));
    if (vulnerabilities.length) findings.push({ component, vulnerabilities });
  }
  return findings.sort((a, b) => rank(b.vulnerabilities[0].severity) - rank(a.vulnerabilities[0].severity) || a.component.purl.localeCompare(b.component.purl));
}

export const rank = (severity: Severity) => ({ critical: 4, high: 3, medium: 2, low: 1, unknown: 0 })[severity];

function describe(vuln: OsvVuln, component: Component): Vulnerability {
  const v3 = vuln.severity?.find((entry) => entry.type === 'CVSS_V3')?.score;
  const score = v3 ? cvss3Score(v3) : undefined;
  const label = (vuln.database_specific?.severity ?? vuln.affected?.find((entry) => entry.ecosystem_specific?.severity)?.ecosystem_specific?.severity ?? '').toLowerCase();
  const severity: Severity = score !== undefined ? severityOf(score) : label === 'critical' ? 'critical' : label === 'high' ? 'high' : label === 'moderate' || label === 'medium' ? 'medium' : label === 'low' ? 'low' : 'unknown';
  const fixed = [...new Set((vuln.affected ?? []).filter((entry) => matches(entry.package, component)).flatMap((entry) => (entry.ranges ?? []).flatMap((range) => range.events.map((event) => event.fixed).filter((value): value is string => Boolean(value)))))].sort(compareVersions);
  const relevant = fixed.filter((version) => compareVersions(version, component.version) > 0);
  return {
    id: vuln.id,
    aliases: vuln.aliases ?? [],
    summary: (vuln.summary || vuln.details?.split('\n')[0] || vuln.id).slice(0, 300),
    severity,
    ...(score !== undefined ? { score, vector: v3 } : {}),
    ...(vuln.published ? { published: vuln.published } : {}),
    ...(vuln.modified ? { modified: vuln.modified } : {}),
    url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
    cwes: vuln.database_specific?.cwe_ids ?? [],
    fixed: relevant.length ? relevant : fixed
  };
}

const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: 'npm', PyPI: 'PyPI', Go: 'Go', 'crates.io': 'crates.io', Packagist: 'Packagist', RubyGems: 'RubyGems', NuGet: 'NuGet', Maven: 'Maven' };
function matches(pkg: { ecosystem?: string; name?: string } | undefined, component: Component): boolean {
  if (!pkg?.name) return true;
  const normalize = (name: string) => component.ecosystem === 'PyPI' ? name.toLowerCase().replace(/[-_.]+/g, '-') : component.ecosystem === 'NuGet' ? name.toLowerCase() : name;
  return (!pkg.ecosystem || pkg.ecosystem.split(':')[0] === OSV_ECOSYSTEM[component.ecosystem]) && normalize(pkg.name) === normalize(component.name);
}

export const severityOf = (score: number): Severity => score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'unknown';

/** Orders dotted versions numerically (v-prefix and build metadata ignored; a pre-release sorts first). */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => { const [core, pre] = value.replace(/^v/, '').split('+')[0].split(/-(.*)/s); return { parts: core.split(/[._]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part)), pre }; };
  const left = parse(a); const right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const x = left.parts[index] ?? 0; const y = right.parts[index] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y), undefined, { numeric: true });
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return (left.pre ?? '').localeCompare(right.pre ?? '', undefined, { numeric: true });
}

/** CVSS v3.0/3.1 base score from a vector string (FIRST's specification), or undefined if invalid. */
export function cvss3Score(vector: string): number | undefined {
  const metrics = Object.fromEntries(vector.split('/').slice(1).map((part) => part.split(':') as [string, string]));
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.AV];
  const AC = { L: 0.77, H: 0.44 }[metrics.AC];
  const UI = { N: 0.85, R: 0.62 }[metrics.UI];
  const scope = metrics.S;
  const PR = scope === 'C' ? { N: 0.85, L: 0.68, H: 0.5 }[metrics.PR] : { N: 0.85, L: 0.62, H: 0.27 }[metrics.PR];
  const impact = (key: string) => ({ H: 0.56, L: 0.22, N: 0 } as Record<string, number>)[metrics[key]];
  const [C, I, A] = [impact('C'), impact('I'), impact('A')];
  if (!/^CVSS:3\.[01]\//.test(vector) || [AV, AC, UI, PR, C, I, A].some((value) => value === undefined) || (scope !== 'U' && scope !== 'C')) return undefined;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impactScore = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impactScore <= 0) return 0;
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;
  const roundUp = (value: number) => { const integer = Math.round(value * 100_000); return integer % 10_000 === 0 ? integer / 100_000 : (Math.floor(integer / 10_000) + 1) / 10; };
  return roundUp(Math.min(scope === 'U' ? impactScore + exploitability : 1.08 * (impactScore + exploitability), 10));
}

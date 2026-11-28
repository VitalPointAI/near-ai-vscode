// Output-only copy lint. Kept import-free so docs CI can run it with Node alone.
export const COMPLIANCE_CLAIMS = Object.freeze([
  'ITAR compliant', 'ITAR certified', 'CGP compliant', 'CGP approved', 'export compliant', 'controlled goods approved', 'fully sovereign', '100% sovereign',
  '100% Canadian', 'sovereign by default', 'sovereignty certified', 'certified sovereign', 'compliant', 'accredited', 'certified'
]);
export const NEGATION = /(?<![A-Za-z0-9_])(?:not|never|no|cannot|without|isn['\u2019]t|doesn['\u2019]t)(?![A-Za-z0-9_])/i;
export const SENTENCE_BREAK = /[.!?]\s+|\n/;
export const OUR_TEXT_FIELDS = Object.freeze(['rows.reasonText', 'rows.components.statement', 'rows.components.limitation', 'gaps.title', 'gaps.remediation', 'matrix.weProvide', 'matrix.youDo', 'levels.notes.text']);
export const OFFICIAL_TEXT_FIELDS = Object.freeze(['rows.title', 'controls.parts.prose', 'controls.title']);
export type WordLintHit = Readonly<{ path: string; phrase: string; rule: 'compliance-claim' | 'em-dash' | 'provider-organization' }>;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRegex = (phrase: string) => new RegExp(`(?<![A-Za-z0-9_])${escape(phrase)}(?![A-Za-z0-9_])`, 'gi');
const sentenceBefore = (text: string, index: number) => text.slice(0, index).split(SENTENCE_BREAK).pop() ?? '';

export function lintText(text: string, path = '$'): WordLintHit[] {
  const hits: WordLintHit[] = [];
  const claimed: Array<{ start: number; end: number }> = [];
  for (const phrase of [...COMPLIANCE_CLAIMS].sort((a, b) => b.length - a.length)) for (const match of text.matchAll(phraseRegex(phrase))) {
    const start = match.index ?? 0; const end = start + match[0].length;
    // Phase 41's literal NEGATION remains parity-checked; "Nothing ... makes" is its equivalent sentence form in generated prose.
    if (claimed.some((item) => start >= item.start && end <= item.end) || NEGATION.test(sentenceBefore(text, start)) || /\bnothing\b/i.test(sentenceBefore(text, start))) continue;
    claimed.push({ start, end }); hits.push({ path, phrase, rule: 'compliance-claim' });
  }
  if (text.includes('\u2014')) hits.push({ path, phrase: '\u2014', rule: 'em-dash' });
  if (/NEAR AI\s+organization/i.test(text)) hits.push({ path, phrase: 'NEAR AI organization', rule: 'provider-organization' });
  return hits;
}

function official(path: string): boolean { return /\.rows\[\d+\]\.title$/.test(path) || /\.controls\[\d+\](?:\.parts\[\d+\])?\.(?:title|prose)$/.test(path); }
/** Lint our fields and every new string by default, while explicitly excluding quoted official text. */
export function lintDashboard(dashboard: unknown): WordLintHit[] {
  const hits: WordLintHit[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') { if (!official(path)) hits.push(...lintText(value, path)); return; }
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}.${key}`);
  };
  walk(dashboard, '$'); return hits;
}

/** Remove Markdown metadata, imports, and examples before scanning reader-facing prose. */
export function lintPage(page: string, path = '$'): WordLintHit[] {
  let body = page.replace(/^---[\s\S]*?---\s*/u, '');
  body = body.replace(/^\s*import\s.+$/gmu, '').replace(/^\s*```[\s\S]*?^\s*```\s*$/gmu, '');
  return lintText(body, path);
}

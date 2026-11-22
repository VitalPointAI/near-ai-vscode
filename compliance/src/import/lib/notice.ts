import type { SourceEntry } from './sourceRegistry.ts';

type NoticeSource = Omit<SourceEntry, 'pages'> & { readonly retrievedAt?: string; readonly sha256?: string; readonly pages: readonly { readonly url: string; readonly sha256?: string }[] };
export function buildNotice(sources: readonly NoticeSource[]): string {
  const lines = sources.flatMap((source) => [
    `## ${source.title}`, (source.pages.find(page => page.sha256) ?? source.pages[0]).url, `Licence: ${source.licence}`,
    source.retrievedAt ? `Retrieved: ${source.retrievedAt}` : '', source.sha256 ? `SHA-256: ${source.sha256}` : '',
    source.licence === 'ca-ogl-lgo' ? 'Contains information licensed under the Open Government Licence - Canada.' : '',
    source.publisher.includes('Cyber') ? 'Unofficial representation, not reviewed or endorsed by the Cyber Centre.' : '',
    source.id.includes('nist') ? 'NIST content is acknowledged; changes are marked.' : '',
    source.licence === 'reproduction-of-federal-law-order' ? 'Accurate reproduction, not the official version.' : '',
    source.id === 'ecfr-title-22' ? 'eCFR is unofficial and recorded as of its retrieval date.' : '',
    source.use === 'ids-and-links' ? 'Identifiers and links only; no source text is stored.' : '', ''
  ].filter(Boolean));
  return ['# Source notices', '', ...lines].join('\n') + '\n';
}

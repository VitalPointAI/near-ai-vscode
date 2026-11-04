import type { Finding, Severity } from '../domain/cyber';
import type { CyberEvidenceStore } from './cyberLedgerStore';

// D-27 evidence kind 4: visual captures rendered into the report. No SVG library, no canvas, no
// browser: the SVG is assembled as text from values already stored as evidence, so it renders the
// same bytes on every machine and its hash is a stable member of the chain. A true browser
// screenshot needs a host browser, and that requirement is stated rather than pretended.

export const SCREENSHOT_ABSENT_NOTE = 'A true browser screenshot requires a host browser (Chromium, Playwright, or Puppeteer), and none was available to this run; the SVG text captures below are the recorded visuals.';

export type CaptureKind = 'http-exchange' | 'terminal-transcript' | 'findings-by-severity';

export interface HttpExchange {
  method: string;
  path: string;
  status: string;
  headers: Array<[string, string]>;
  bodyExcerpt: string;
  evidenceHash: string;
}

export interface TerminalTranscript {
  lines: string[];
  provenance: { tool: string; argv: string[]; exitCode: number | null };
  evidenceHash: string;
}

export interface FindingsBar {
  findings: Array<{ severity: Severity; title: string }>;
  evidenceHash: string;
}

export interface CaptureInput {
  'http-exchange'?: HttpExchange;
  'terminal-transcript'?: TerminalTranscript;
  'findings-by-severity'?: FindingsBar;
}

export interface RenderedCapture { kind: CaptureKind; fileName: string; svgText: string }

export interface CaptureDeps {
  evidence: CyberEvidenceStore;
  findings: Finding[];
  exchanges?: HttpExchange[];
  transcripts?: TerminalTranscript[];
  /** The findings-bar capture's source hash; the caller stores the findings list as evidence first. */
  findingsEvidenceHash?: string;
}

export interface CaptureForRun {
  captures: Array<{ kind: CaptureKind; fileName: string; evidenceHash: string; svgText: string }>;
  screenshot: { status: 'absent'; reason: string };
}

const FONT = 'DejaVu Sans, Menlo, Consolas, monospace';
const WIDTH = 720;
const LINE = 18;
const PAD = 16;

/** XML text escaping; the only way a value reaches the SVG. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const cap = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function frame(title: string, caption: string, height: number, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    '<rect width="100%" height="100%" fill="#0f1419"/>',
    `<text x="${PAD}" y="${PAD + 12}" fill="#e6edf3" font-family="${FONT}" font-size="14" font-weight="600">${escapeXml(title)}</text>`,
    ...body,
    `<text x="${PAD}" y="${height - 8}" fill="#7d8590" font-family="${FONT}" font-size="10">${escapeXml(caption)}</text>`,
    '</svg>'
  ].join('\n');
}

/** An annotated request/response panel, with the evidence hash in the caption. */
export function renderHttpExchange(input: HttpExchange): string {
  const rows = [
    `> ${input.method} ${input.path}`,
    `< ${input.status}`,
    '',
    ...input.headers.slice(0, 12).map(([name, value]) => `${name}: ${value}`),
    '',
    ...cap(input.bodyExcerpt, 400).split('\n').slice(0, 8)
  ];
  const height = PAD + 26 + rows.length * LINE + 20;
  const body = rows.map((row, index) => `<text x="${PAD}" y="${PAD + 34 + index * LINE}" fill="#a5d6ff" font-family="${FONT}" font-size="12">${escapeXml(cap(row, 96))}</text>`);
  return frame(`HTTP exchange — ${cap(input.method, 8)} ${cap(input.path, 40)}`, `evidence ${input.evidenceHash}`, height, body);
}

/** A terminal card: the captured lines, with the provenance line beneath. */
export function renderTerminalTranscript(input: TerminalTranscript): string {
  const lines = input.lines.slice(0, 24).map((line) => cap(line, 96));
  const provenance = `${input.provenance.tool} ${input.provenance.argv.join(' ')} (exit ${input.provenance.exitCode ?? 'n/a'})`;
  const rows = [`$ ${input.provenance.argv.join(' ')}`, '', ...lines];
  const height = PAD + 26 + rows.length * LINE + 20;
  const body = rows.map((row, index) => `<text x="${PAD}" y="${PAD + 34 + index * LINE}" fill="${index === 0 ? '#7ee787' : '#e6edf3'}" font-family="${FONT}" font-size="12">${escapeXml(cap(row, 96))}</text>`);
  return frame('Terminal transcript', `evidence ${input.evidenceHash} — ${cap(provenance, 60)}`, height, body);
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_FILL: Record<Severity, string> = { critical: '#f85149', high: '#ff8c42', medium: '#e3b341', low: '#58a6ff', info: '#8b949e' };

/** Findings by severity, as bars whose text label carries the count (never colour alone). */
export function renderFindingsBySeverity(input: FindingsBar): string {
  const counts = SEVERITY_ORDER.map((severity) => ({ severity, count: input.findings.filter((finding) => finding.severity === severity).length }));
  const max = Math.max(1, ...counts.map((entry) => entry.count));
  const barWidth = 360;
  const rows = counts.map((entry, index) => {
    const width = Math.round((entry.count / max) * barWidth);
    const y = PAD + 34 + index * 34;
    return [
      `<text x="${PAD}" y="${y + 12}" fill="#e6edf3" font-family="${FONT}" font-size="12">${escapeXml(entry.severity)}</text>`,
      `<rect x="${PAD + 90}" y="${y}" width="${width}" height="16" fill="${SEVERITY_FILL[entry.severity]}"/>`,
      `<text x="${PAD + 90 + Math.max(width, 0) + 8}" y="${y + 12}" fill="#e6edf3" font-family="${FONT}" font-size="12">${entry.count}</text>`
    ].join('\n');
  });
  const height = PAD + 34 + counts.length * 34 + 20;
  return frame(`Findings by severity (${input.findings.length} total)`, `evidence ${input.evidenceHash}`, height, rows);
}

/** The deterministic filename: the kind plus the first 12 characters of the evidence hash. */
export function captureFileName(kind: CaptureKind, evidenceHash: string): string {
  return `${kind}-${evidenceHash.slice(0, 12)}.svg`;
}

export function renderEvidenceVisual(kind: CaptureKind, input: CaptureInput): string {
  if (kind === 'http-exchange') {
    if (!input['http-exchange']) throw new Error('The http-exchange capture needs an exchange.');
    return renderHttpExchange(input['http-exchange']);
  }
  if (kind === 'terminal-transcript') {
    if (!input['terminal-transcript']) throw new Error('The terminal-transcript capture needs a transcript.');
    return renderTerminalTranscript(input['terminal-transcript']);
  }
  if (!input['findings-by-severity']) throw new Error('The findings-by-severity capture needs a findings list.');
  return renderFindingsBySeverity(input['findings-by-severity']);
}

/**
 * Renders every applicable capture, stores each SVG's bytes as evidence (so the picture is on the
 * same chain as the data it shows), and reports the browser screenshot as absent with its reason.
 */
export async function captureForRun(runId: string, deps: CaptureDeps): Promise<CaptureForRun> {
  const captures: CaptureForRun['captures'] = [];
  const add = async (kind: CaptureKind, input: CaptureInput) => {
    const svgText = renderEvidenceVisual(kind, input);
    const evidenceHash = await deps.evidence.put(runId, Buffer.from(svgText, 'utf8'));
    captures.push({ kind, fileName: captureFileName(kind, evidenceHash), evidenceHash, svgText });
  };
  for (const exchange of deps.exchanges ?? []) await add('http-exchange', { 'http-exchange': exchange });
  for (const transcript of deps.transcripts ?? []) await add('terminal-transcript', { 'terminal-transcript': transcript });
  if (deps.findings.length) {
    const hash = deps.findingsEvidenceHash ?? (await deps.evidence.put(runId, JSON.stringify(deps.findings.map((finding) => ({ checkId: finding.checkId, severity: finding.severity, title: finding.title })))));
    await add('findings-by-severity', { 'findings-by-severity': { findings: deps.findings.map((finding) => ({ severity: finding.severity, title: finding.title })), evidenceHash: hash } });
  }
  return { captures, screenshot: { status: 'absent', reason: SCREENSHOT_ABSENT_NOTE } };
}

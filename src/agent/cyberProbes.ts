import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { resolve4, resolve6, resolveMx, resolveTxt } from 'node:dns/promises';
import * as path from 'node:path';
import type { AgentTool } from './tools';
import { fenceUntrusted } from './untrusted';
import { ToolError } from './workspace';
import { redactSecrets } from '../domain/redaction';
import type { Finding, ResolvedScope } from '../domain/cyber';
import { cvss31Vector, hardeningAdvice, WSTG_MAP } from '../domain/cyber';
import { cvss3Score, type Severity } from '../security/osv';
import type { ScanReport } from '../security/scan';
import { scanProject } from '../security/scan';
import { hashBlob } from '../domain/cyberLedger';
import { lineAt, readScannable, walkWorkspace, type WorkspaceFile } from './cyberFiles';
import type { SecurityAccess } from './securityTool';

// Built-in probes: no host binary is required, so the harness has a floor that works everywhere
// (D-12). Target responses are outside content, so the tool is marked untrusted and everything it
// returns is fenced and redacted before it reaches the model or a hash.

export interface HttpCapture {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Round trip in milliseconds. */
  durationMs: number;
  bodyExcerpt: string;
}

export interface CyberProbeDeps {
  /** True when the URL is inside the engagement's resolved scope (T-25-09). */
  inScope(url: string, scope?: ResolvedScope): boolean;
  scope?: ResolvedScope;
  /** Injected so the probe can run without a live network in tests that do not need one. */
  fetchCapture?: (url: string, signal?: AbortSignal) => Promise<HttpCapture>;
  /** The dependency check reuses the existing consent-gated OSV scan rather than re-implementing it. */
  security?: SecurityAccess;
  /** Runs the OSV scan for a folder; tests inject a fake, production uses scanProject. */
  scan?: (root: string) => Promise<ScanReport>;
  /** Injected DNS resolver, so the DNS probe runs offline when the test supplies one. */
  dns?: DnsResolvers;
  /** Injected TLS handshake, so the TLS probe's findings test does not need a listener. */
  tlsPeer?: (host: string, port: number) => Promise<TlsPeer>;
  /** Structured findings go to the ledger and the report through this callback (25-05). */
  onFindings?: (findings: Finding[]) => void;
  now?: () => Date;
}

/** Finding severity is the harness's own ladder; OSV reports an extra 'unknown'. */
function normaliseSeverity(severity: Severity): Finding['severity'] {
  return severity === 'unknown' ? 'info' : severity;
}

interface FindingInput {
  checkId: string;
  title: string;
  severity: Finding['severity'];
  target: string;
  vector: string;
  cwes: string[];
  evidence: string;
  reproductionCommand: string;
  reason?: string;
  verdict?: Finding['verdict'];
}

/** One structured finding with its evidence hashed and redacted before it can reach a transcript. */
export function makeFinding(input: FindingInput): Finding {
  const evidence = redactSecrets(input.evidence);
  const score = cvss3Score(input.vector);
  return {
    id: `${input.checkId}-${hashBlob(`${input.target}:${evidence}`).slice(0, 12)}`,
    checkId: input.checkId,
    title: input.title,
    severity: input.severity,
    verdict: input.verdict ?? 'could_not_determine',
    cvssVector: input.vector,
    ...(score === undefined ? {} : { cvssScore: score }),
    cwes: input.cwes,
    wstg: WSTG_MAP[input.checkId] ?? [],
    evidenceExcerpt: evidence.slice(0, 900),
    evidenceHash: hashBlob(evidence),
    reproductionCommand: input.reproductionCommand,
    remediation: hardeningAdvice(input.checkId),
    ...(input.reason ? { reason: input.reason } : {}),
    target: input.target
  };
}

const bySeverity = (findings: Finding[]): Finding[] => [...findings].sort((a, b) => (b.cvssScore ?? 0) - (a.cvssScore ?? 0) || a.title.localeCompare(b.title));

/** The one-line-per-finding summary every probe returns above its fenced evidence. */
function summarise(findings: Finding[], empty = 'No finding from this check.'): string {
  const ordered = bySeverity(findings);
  return ordered.length
    ? ordered.map((finding) => `${finding.severity.toUpperCase()}: ${finding.title} — ${finding.target} (${finding.wstg.join(', ') || 'no WSTG id'}; CVSS ${finding.cvssScore ?? 'n/a'})`).join('\n')
    : empty;
}

/** Shell-quotes for a reproduction command, so a path with a space still runs. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface HttpProbeInput { url: string; checks: string[] }

const BODY_EXCERPT_BYTES = 2_048;
const DEFAULT_TIMEOUT_MS = 15_000;

/** One GET, recording status, every header, and the timing, through node:http(s) directly. */
export function captureHttp(url: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HttpCapture> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, { method: 'GET', timeout: timeoutMs }, (response) => {
      const started = Date.now();
      const chunks: Buffer[] = [];
      let captured = 0;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      response.on('data', (chunk: Buffer) => {
        if (captured < BODY_EXCERPT_BYTES) { chunks.push(chunk.subarray(0, BODY_EXCERPT_BYTES - captured)); captured += chunk.length; }
      });
      response.on('end', () => {
        resolve({ url, status: response.statusCode ?? 0, statusText: response.statusMessage ?? '', headers, durationMs: Date.now() - started, bodyExcerpt: Buffer.concat(chunks).toString('utf8').slice(0, BODY_EXCERPT_BYTES) });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => { request.destroy(new ToolError(`No response from ${parsed.host} within ${timeoutMs} ms.`)); });
    request.on('error', (error) => reject(error instanceof ToolError ? error : new ToolError(`Could not reach ${parsed.host}: ${error.message}`)));
    if (signal) {
      if (signal.aborted) { request.destroy(new DOMException('The operation was aborted.', 'AbortError')); return; }
      signal.addEventListener('abort', () => request.destroy(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
    }
    request.end();
  });
}

interface HeaderRule {
  checkId: string;
  title: string;
  /** Absent header, or a header value that fails the rule. */
  test: (headers: Record<string, string>) => boolean;
  severity: Finding['severity'];
  vector: string;
  detail: string;
}

const HEADER_RULES: HeaderRule[] = [
  { checkId: 'missing-hsts', title: 'Strict-Transport-Security header is missing', severity: 'medium', vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'L', A: 'N' }), test: (headers) => !headers['strict-transport-security'], detail: 'Responses can be downgraded to plain HTTP.' },
  { checkId: 'missing-x-content-type-options', title: 'X-Content-Type-Options header is missing', severity: 'low', vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'N', A: 'N' }), test: (headers) => !headers['x-content-type-options'], detail: 'Browsers may sniff a response into a type it was not served as.' },
  { checkId: 'missing-x-frame-options', title: 'X-Frame-Options header is missing', severity: 'low', vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'L', A: 'N' }), test: (headers) => !headers['x-frame-options'] && !(headers['content-security-policy'] ?? '').includes('frame-ancestors'), detail: 'The page can be framed, enabling clickjacking.' },
  { checkId: 'server-version-disclosure', title: 'The Server header discloses a version', severity: 'info', vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'N', A: 'N' }), test: (headers) => /\d+\.\d+/.test(headers.server ?? ''), detail: 'An exact version tells an attacker which exploits apply.' }
];

/** A curl command that reproduces exactly the request this probe made (CYBER-12). */
function reproductionCommand(url: string, checkId: string): string {
  const quoted = `'${url.replace(/'/g, `'\\''`)}'`;
  return checkId === 'missing-hsts' ? `curl -sS -D - -o /dev/null ${quoted}` : `curl -sS -I ${quoted}`;
}

/** Credentials in a URL's userinfo are never recorded or hashed. */
function withoutUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch { return url; }
}

/** Turns one capture into findings for the header checks the caller asked for. */
export function headerFindings(capture: HttpCapture, checks: string[]): Finding[] {
  const wanted = new Set(checks.length ? checks : HEADER_RULES.map((rule) => rule.checkId));
  const findings: Finding[] = [];
  for (const rule of HEADER_RULES) {
    if (!wanted.has(rule.checkId)) continue;
    if (!rule.test(capture.headers)) continue;
    const evidence = redactSecrets(`${capture.status} ${capture.statusText}\n${Object.entries(capture.headers).map(([name, value]) => `${name}: ${value}`).join('\n')}`);
    const score = cvss3Score(rule.vector);
    findings.push({
      id: `${rule.checkId}-${hashBlob(capture.url).slice(0, 12)}`,
      checkId: rule.checkId,
      title: rule.title,
      severity: rule.severity,
      // A missing header is confirmed by the capture, but no exploitation was attempted, so the
      // finding never claims verified access it does not have (D-24).
      verdict: 'could_not_determine',
      cvssVector: rule.vector,
      ...(score === undefined ? {} : { cvssScore: score }),
      cwes: [],
      wstg: WSTG_MAP[rule.checkId] ?? [],
      evidenceExcerpt: evidence.slice(0, 900),
      evidenceHash: hashBlob(evidence),
      reproductionCommand: reproductionCommand(capture.url, rule.checkId),
      remediation: hardeningAdvice(rule.checkId),
      reason: `${rule.detail} No exploitation was attempted in this profile.`,
      target: capture.url
    });
  }
  return findings;
}

export function cyberProbes(deps: CyberProbeDeps): AgentTool<any>[] {
  const httpProbe: AgentTool<HttpProbeInput> = {
    name: 'CyberHttpProbe',
    description: 'Fetch one URL in the engagement\'s resolved scope and evaluate its response headers (HSTS, X-Content-Type-Options, X-Frame-Options, Server version disclosure). Returns the capture with timings and a compact finding summary. Target responses are outside content.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'The absolute http(s) URL to probe; must be inside the engagement\'s scope.' }, checks: { type: 'array', items: { type: 'string' }, description: 'Check ids to evaluate; empty runs all header checks.' } }, required: ['url'], additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => {
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!url) throw new ToolError('Parameter "url" is required.');
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new ToolError(`"${url}" is not an absolute URL.`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ToolError(`Only http and https URLs are probed; "${parsed.protocol}" was given.`);
      const checks = Array.isArray(raw.checks) ? raw.checks.filter((value): value is string => typeof value === 'string') : [];
      return { url, checks };
    },
    title: (input) => `Probe ${withoutUserinfo(input.url)}`,
    sensitive: (input) => (input.url.includes('@') ? `${withoutUserinfo(input.url)} carries credentials in its URL, which would be sent as part of the request.` : undefined),
    async run(input, context) {
      if (!deps.inScope(input.url, deps.scope)) throw new ToolError(`${withoutUserinfo(input.url)} is outside the engagement's resolved scope.`);
      const capture = await (deps.fetchCapture ?? ((url, signal) => captureHttp(url, signal)))(input.url, context.signal);
      const findings = headerFindings({ ...capture, url: withoutUserinfo(capture.url) }, input.checks);
      deps.onFindings?.(findings);
      const summary = [
        `${capture.status} ${capture.statusText} in ${capture.durationMs} ms`,
        ...findings.map((finding) => `${finding.severity}: ${finding.title} (${finding.wstg.join(', ') || 'no WSTG id'}; ${finding.cvssScore ?? 'no score'})`)
      ].join('\n');
      const raw = `HTTP ${capture.status}\n${Object.entries(capture.headers).map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${capture.bodyExcerpt}`;
      const fenced = fenceUntrusted(withoutUserinfo(input.url), redactSecrets(raw));
      if (fenced.warnings.length) context.onSecurity?.({ kind: 'injection', source: withoutUserinfo(input.url), detail: fenced.warnings.join('; ') });
      return `${redactSecrets(summary)}\n\n${fenced.text}`;
    }
  };
  return [
    httpProbe,
    tlsProbe(deps),
    dnsProbe(deps),
    tcpProbe(deps),
    robotsProbe(deps),
    secretsProbe(deps),
    iacProbe(deps),
    dependencyProbe(deps),
    fingerprintProbe(deps)
  ];
}

// ---- Fingerprint -------------------------------------------------------------------------------

export interface Fingerprint {
  title: string;
  server?: string;
  poweredBy?: string;
  technologies: string[];
  /** Response shapes worth trying an exploit against, in the order they were observed. */
  hints: string[];
}

/** Reads a page's title and framework hints from headers and body, without trusting either. */
export function fingerprintOf(capture: HttpCapture): Fingerprint {
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(capture.bodyExcerpt)?.[1]?.trim() ?? '';
  const technologies = new Set<string>();
  const hints: string[] = [];
  const server = capture.headers.server;
  const poweredBy = capture.headers['x-powered-by'];
  if (/express/i.test(String(poweredBy ?? '')) || /express/i.test(String(server ?? ''))) technologies.add('Express');
  if (/nginx/i.test(String(server ?? ''))) technologies.add('nginx');
  if (/apache/i.test(String(server ?? ''))) technologies.add('Apache');
  if (/php/i.test(String(poweredBy ?? ''))) technologies.add('PHP');
  if (/asp\.net/i.test(String(poweredBy ?? ''))) technologies.add('ASP.NET');
  if (capture.bodyExcerpt.includes('ng-version') || capture.bodyExcerpt.includes('ng-app')) technologies.add('Angular');
  if (capture.bodyExcerpt.includes('__NEXT_DATA__')) technologies.add('Next.js');
  if (/<form[^>]*action=["'][^"']*login/i.test(capture.bodyExcerpt) || /name=["']password["']/i.test(capture.bodyExcerpt)) hints.push('login form');
  if (/\$\(|jquery/i.test(capture.bodyExcerpt)) hints.push('jQuery');
  if (/wp-content|wordpress/i.test(capture.bodyExcerpt)) { technologies.add('WordPress'); hints.push('WordPress content paths'); }
  if (capture.headers['set-cookie'] && !/httponly/i.test(capture.headers['set-cookie'])) hints.push('cookie without HttpOnly');
  return { title, ...(server ? { server } : {}), ...(poweredBy ? { poweredBy } : {}), technologies: [...technologies], hints };
}

interface FingerprintProbeInput { url: string }

/** Evidence the offensive path plans an exploit from (D-23's fingerprint step). */
function fingerprintProbe(deps: CyberProbeDeps): AgentTool<FingerprintProbeInput> {
  return {
    name: 'CyberFingerprintProbe',
    description: 'Fetch a target\'s root page and report what it appears to run: page title, Server and X-Powered-By headers, framework hints, and response shapes worth trying an exploit against (a login form, a CMS, a cookie without HttpOnly). Target responses are untrusted data.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'The absolute http(s) URL to fingerprint; must be inside the resolved scope.' } }, required: ['url'], additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => {
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!url) throw new ToolError('Parameter "url" is required.');
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new ToolError(`"${url}" is not an absolute URL.`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ToolError(`Only http and https URLs are fingerprinted; "${parsed.protocol}" was given.`);
      return { url };
    },
    title: (input) => `Fingerprint ${withoutUserinfo(input.url)}`,
    async run(input, context) {
      if (!deps.inScope(input.url, deps.scope)) throw new ToolError(`${withoutUserinfo(input.url)} is outside the engagement's resolved scope.`);
      const capture = await (deps.fetchCapture ?? ((url, signal) => captureHttp(url, signal)))(input.url, context.signal);
      const fingerprint = fingerprintOf(capture);
      const text = [
        `title: ${fingerprint.title || '(none)'}`,
        `server: ${fingerprint.server ?? '(none)'}`,
        `x-powered-by: ${fingerprint.poweredBy ?? '(none)'}`,
        `technologies: ${fingerprint.technologies.join(', ') || '(none identified)'}`,
        `hints: ${fingerprint.hints.join('; ') || '(none)'}`
      ].join('\n');
      const fenced = fenceUntrusted(withoutUserinfo(input.url), redactSecrets(text));
      if (fenced.warnings.length) context.onSecurity?.({ kind: 'injection', source: withoutUserinfo(input.url), detail: fenced.warnings.join('; ') });
      // A fingerprint is not a finding on its own: it is the evidence the exploit step plans from.
      return `${redactSecrets(text)}\n\n${fenced.text}`;
    }
  };
}

// ---- TLS ---------------------------------------------------------------------------------------

export interface TlsPeer {
  protocol: string;
  cipher: string;
  /** True when the handshake chain verifies against the system store. */
  authorised: boolean;
  certificate: { subject: string; issuer: string; validFrom?: string; validTo?: string };
}

/** node:tls types a certificate name as string | string[]; a finding only needs the first value. */
const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? '' : value ?? '');

/** One handshake; trust is not required, because the point is to inspect the certificate. */
export function inspectTls(host: string, port: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<TlsPeer> {
  return new Promise((resolve, reject) => {
    const options = { host, port, rejectUnauthorized: false };
    const socket: TLSSocket = tlsConnect(options, () => {
      const certificate = socket.getPeerCertificate() as PeerCertificate;
      resolve({
        protocol: socket.getProtocol() ?? '',
        cipher: socket.getCipher()?.name ?? '',
        authorised: socket.authorized,
        certificate: {
          subject: first(certificate?.subject?.CN),
          issuer: first(certificate?.issuer?.CN),
          validFrom: certificate?.valid_from,
          validTo: certificate?.valid_to
        }
      });
      socket.end();
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new ToolError(`The TLS handshake with ${host}:${port} did not finish within ${timeoutMs} ms.`));
    });
    socket.once('error', (error: Error) => reject(error instanceof ToolError ? error : new ToolError(`Could not complete a TLS handshake with ${host}:${port}: ${error.message}`)));
  });
}

interface TlsProbeInput { url: string }

function tlsProbe(deps: CyberProbeDeps): AgentTool<TlsProbeInput> {
  return {
    name: 'CyberTlsProbe',
    description: 'Complete a TLS handshake with an https target in the resolved scope and report the negotiated protocol, cipher, and peer certificate dates. Flags an expired or not-yet-valid certificate and a protocol older than TLS 1.2. The certificate is target-supplied data.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'The absolute https URL whose host and port are probed.' } }, required: ['url'], additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => {
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!url) throw new ToolError('Parameter "url" is required.');
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new ToolError(`"${url}" is not an absolute URL.`); }
      if (parsed.protocol !== 'https:') throw new ToolError(`The TLS probe needs an https URL; "${parsed.protocol}" was given.`);
      return { url };
    },
    title: (input) => `Inspect TLS of ${withoutUserinfo(input.url)}`,
    async run(input, context) {
      if (!deps.inScope(input.url, deps.scope)) throw new ToolError(`${withoutUserinfo(input.url)} is outside the engagement's resolved scope.`);
      const parsed = new URL(input.url);
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      const port = parsed.port ? Number(parsed.port) : 443;
      const peer = deps.tlsPeer ? await deps.tlsPeer(host, port) : await inspectTls(host, port);
      const target = `${host}:${port}`;
      const now = (deps.now?.() ?? new Date()).getTime();
      const findings: Finding[] = [];
      const validTo = peer.certificate.validTo ? Date.parse(peer.certificate.validTo) : Number.NaN;
      const validFrom = peer.certificate.validFrom ? Date.parse(peer.certificate.validFrom) : Number.NaN;
      const dates = `notBefore=${peer.certificate.validFrom ?? 'unknown'} notAfter=${peer.certificate.validTo ?? 'unknown'}`;
      const repro = `openssl s_client -connect ${target} -servername ${shellQuote(host)} </dev/null 2>/dev/null | openssl x509 -noout -dates -subject -issuer`;

      if (Number.isFinite(validTo) && validTo < now) {
        findings.push(makeFinding({ checkId: 'tls-certificate-expired', title: 'The TLS certificate has expired', severity: 'medium', target, vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'L', A: 'N' }), cwes: ['CWE-298'], evidence: `subject=${peer.certificate.subject} issuer=${peer.certificate.issuer} ${dates} protocol=${peer.protocol}`, reproductionCommand: repro, reason: `The certificate stopped being valid on ${peer.certificate.validTo}.` }));
      } else if (Number.isFinite(validFrom) && validFrom > now) {
        findings.push(makeFinding({ checkId: 'tls-certificate-expired', title: 'The TLS certificate is not valid yet', severity: 'low', target, vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'L', A: 'N' }), cwes: ['CWE-298'], evidence: `subject=${peer.certificate.subject} ${dates}`, reproductionCommand: repro, reason: `The certificate does not become valid until ${peer.certificate.validFrom}.` }));
      }
      const weak = /SSLv[23]|TLSv1(?:\.0|\.1)?$/.test(peer.protocol);
      if (weak) {
        findings.push(makeFinding({ checkId: 'tls-weak-protocol', title: `The server negotiated ${peer.protocol}`, severity: 'medium', target, vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'C', C: 'H', I: 'L', A: 'N' }), cwes: ['CWE-326'], evidence: `protocol=${peer.protocol} cipher=${peer.cipher}`, reproductionCommand: `openssl s_client -connect ${target} -tls1_1 </dev/null 2>/dev/null | head -5` }));
      }
      if (!peer.authorised) {
        // A private or fixture CA is a normal deployment, so "not in the system store" alone is not
        // reported (it would make every private-CA target dirty). A self-signed leaf is.
        const selfSigned = peer.certificate.issuer !== '' && peer.certificate.issuer === peer.certificate.subject;
        if (selfSigned) findings.push(makeFinding({ checkId: 'tls-untrusted-chain', title: 'The TLS certificate is self-signed', severity: 'low', target, vector: cvss31Vector({ AV: 'N', AC: 'H', PR: 'N', UI: 'R', S: 'U', C: 'L', I: 'L', A: 'N' }), cwes: ['CWE-295'], evidence: `subject=${peer.certificate.subject} issuer=${peer.certificate.issuer} ${dates}`, reproductionCommand: repro, reason: 'A client that verifies certificates would not trust a leaf that signs itself.' }));
      }
      deps.onFindings?.(findings);

      const raw = `protocol=${peer.protocol}\ncipher=${peer.cipher}\nauthorised=${peer.authorised}\nsubject=${peer.certificate.subject}\nissuer=${peer.certificate.issuer}\n${dates}`;
      const fenced = fenceUntrusted(target, redactSecrets(raw));
      if (fenced.warnings.length) context.onSecurity?.({ kind: 'injection', source: target, detail: fenced.warnings.join('; ') });
      return `${redactSecrets(summarise(findings, `TLS ${peer.protocol} with ${peer.cipher} on ${target}; no certificate finding.`))}\n\n${fenced.text}`;
    }
  };
}

// ---- DNS ---------------------------------------------------------------------------------------

export interface DnsRecords { a: string[]; aaaa: string[]; mx: string[]; /** Each TXT record, chunks joined. */ txt: string[] }

export interface DnsResolvers {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(hostname: string): Promise<string[][]>;
}

const SYSTEM_DNS: DnsResolvers = {
  resolve4: (hostname) => resolve4(hostname),
  resolve6: (hostname) => resolve6(hostname),
  resolveMx: (hostname) => resolveMx(hostname),
  resolveTxt: (hostname) => resolveTxt(hostname)
};

/** Records for a name; a missing record type is an empty list, never an error (NXDOMAIN aside). */
export async function lookupRecords(hostname: string, resolvers: DnsResolvers = SYSTEM_DNS): Promise<DnsRecords> {
  const soft = <T>(run: () => Promise<T>, fallback: T): Promise<T> => run().catch(() => fallback);
  const [a, aaaa, mx, txt] = await Promise.all([
    soft<string[]>(() => resolvers.resolve4(hostname), []),
    soft<string[]>(() => resolvers.resolve6(hostname), []),
    soft<Array<{ exchange: string; priority: number }>>(() => resolvers.resolveMx(hostname), []),
    soft<string[][]>(() => resolvers.resolveTxt(hostname), [])
  ]);
  return { a, aaaa, mx: mx.map((entry) => `${entry.priority} ${entry.exchange}`), txt: txt.map((chunks) => chunks.join('')) };
}

interface DnsProbeInput { hostname: string }

function dnsProbe(deps: CyberProbeDeps): AgentTool<DnsProbeInput> {
  return {
    name: 'CyberDnsProbe',
    description: 'Read the A, AAAA, MX, and TXT records of a host in the resolved scope, and flag a domain that publishes no SPF or DMARC policy. Record data is target-supplied.',
    parameters: { type: 'object', properties: { hostname: { type: 'string', description: 'A hostname inside the engagement' + "'" + 's resolved scope.' } }, required: ['hostname'], additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => {
      const hostname = typeof raw.hostname === 'string' ? raw.hostname.trim().replace(/\.$/, '') : '';
      if (!hostname) throw new ToolError('Parameter "hostname" is required.');
      if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new ToolError(`"${hostname}" is not a hostname.`);
      return { hostname };
    },
    title: (input) => `Resolve ${input.hostname}`,
    async run(input, context) {
      const inScope = deps.scope ? deps.scope.hosts.map((host) => host.toLowerCase()).includes(input.hostname.toLowerCase()) : deps.inScope(`http://${input.hostname}/`, deps.scope);
      if (!inScope) throw new ToolError(`${input.hostname} is outside the engagement's resolved scope.`);
      const records = await lookupRecords(input.hostname, deps.dns);
      const findings: Finding[] = [];
      const repro = (type: string, name: string) => `dig +short ${type} ${shellQuote(name)}`;
      // Only a mail-bearing domain is expected to publish mail policy; a bare fixture host is not
      // reported for having no MX and therefore no SPF, which would be a false positive (CYBER-07).
      const mailDomain = records.mx.length > 0;
      const spf = records.txt.some((entry) => entry.toLowerCase().startsWith('v=spf1'));
      if (mailDomain && !spf) {
        findings.push(makeFinding({ checkId: 'dns-missing-spf', title: 'The domain publishes no SPF record', severity: 'medium', target: input.hostname, vector: cvss31Vector({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'C', C: 'L', I: 'L', A: 'N' }), cwes: ['CWE-290'], evidence: `mx=${records.mx.join(', ')} txt=${records.txt.join(' | ') || '(none)'}`, reproductionCommand: repro('TXT', input.hostname), reason: 'Without SPF any host may claim to send mail for this domain.' }));
      }
      if (mailDomain) {
        const dmarc = await lookupRecords(`_dmarc.${input.hostname}`, deps.dns).catch(() => ({ a: [], aaaa: [], mx: [], txt: [] }) as DnsRecords);
        if (!dmarc.txt.some((entry) => entry.toLowerCase().startsWith('v=dmarc1'))) {
          findings.push(makeFinding({ checkId: 'dns-missing-dmarc', title: 'The domain publishes no DMARC policy', severity: 'medium', target: input.hostname, vector: cvss31Vector({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'C', C: 'L', I: 'L', A: 'N' }), cwes: ['CWE-290'], evidence: `_dmarc.${input.hostname} txt=${dmarc.txt.join(' | ') || '(none)'}`, reproductionCommand: repro('TXT', `_dmarc.${input.hostname}`) }));
        }
      }
      deps.onFindings?.(findings);

      const raw = [`a=${records.a.join(', ') || '(none)'}`, `aaaa=${records.aaaa.join(', ') || '(none)'}`, `mx=${records.mx.join(', ') || '(none)'}`, `txt=${records.txt.join(' | ') || '(none)'}`].join('\n');
      const fenced = fenceUntrusted(input.hostname, redactSecrets(raw));
      if (fenced.warnings.length) context.onSecurity?.({ kind: 'injection', source: input.hostname, detail: fenced.warnings.join('; ') });
      return `${redactSecrets(summarise(findings, `${input.hostname}: ${records.a.length + records.aaaa.length} address record(s), ${records.mx.length} MX, ${records.txt.length} TXT; no mail-policy finding.`))}\n\n${fenced.text}`;
    }
  };
}

// ---- TCP ---------------------------------------------------------------------------------------

interface TcpProbeInput { host: string; ports: number[] }

const MAX_PORTS_PER_CALL = 32;

/** True when something accepts a TCP connection within the timeout. */
export function probePort(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = netConnect({ host, port });
    const done = (open: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function tcpProbe(deps: CyberProbeDeps): AgentTool<TcpProbeInput> {
  return {
    name: 'CyberTcpProbe',
    description: 'Check whether TCP ports are open on a host in the resolved scope, one connection per port with a short timeout. The port list is capped to the engagement scope and to 32 ports per call.',
    parameters: { type: 'object', properties: { host: { type: 'string', description: 'Host or literal IP inside the resolved scope.' }, ports: { type: 'array', items: { type: 'number' }, description: 'Ports to try; at most 32, and inside the resolved scope when the scope names ports.' } }, required: ['host', 'ports'], additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => {
      const host = typeof raw.host === 'string' ? raw.host.trim() : '';
      if (!host) throw new ToolError('Parameter "host" is required.');
      const ports = Array.isArray(raw.ports) ? raw.ports.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0 && value < 65_536) : [];
      if (!ports.length) throw new ToolError('Parameter "ports" needs at least one port number.');
      if (ports.length > MAX_PORTS_PER_CALL) throw new ToolError(`At most ${MAX_PORTS_PER_CALL} ports are probed per call; ${ports.length} were given.`);
      return { host, ports: [...new Set(ports)] };
    },
    title: (input) => `Check ${input.ports.length} port(s) on ${input.host}`,
    async run(input) {
      const scope = deps.scope;
      const allowedHosts = scope?.hosts.map((host) => host.toLowerCase()) ?? [];
      if (scope && allowedHosts.length && !allowedHosts.includes(input.host.toLowerCase())) throw new ToolError(`${input.host} is outside the engagement's resolved scope.`);
      // T-25-47: a scope that names ports bounds the sweep, so a model cannot widen it per call.
      if (scope?.ports.length) {
        const outside = input.ports.filter((port) => !scope.ports.includes(port));
        if (outside.length) throw new ToolError(`Port(s) ${outside.join(', ')} are outside the engagement's resolved scope (${scope.ports.join(', ')}).`);
      }
      const open: number[] = [];
      const results: string[] = [];
      for (const port of input.ports) {
        const isOpen = await probePort(input.host, port);
        results.push(`${port}: ${isOpen ? 'open' : 'closed'}`);
        if (isOpen) open.push(port);
      }
      const findings = open.map((port) => makeFinding({ checkId: 'open-port', title: `TCP port ${port} is open`, severity: port === 22 || port === 23 || port === 3389 ? 'medium' : 'info', target: `${input.host}:${port}`, vector: cvss31Vector({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'L', I: 'N', A: 'N' }), cwes: ['CWE-1327'], evidence: `A TCP connection to ${input.host}:${port} was accepted.`, reproductionCommand: port === 443 ? `curl -sS -o /dev/null -w '%{http_code}\\n' https://${input.host}:${port}/` : `nc -vz ${input.host} ${port}` }));
      deps.onFindings?.(findings);
      return `${summarise(findings, `No open port among ${input.ports.join(', ')} on ${input.host}.`)}\n\n${results.join('\n')}`;
    }
  };
}

// ---- robots / sitemap --------------------------------------------------------------------------

interface RobotsProbeInput { url: string }

function robotsProbe(deps: CyberProbeDeps): AgentTool<RobotsProbeInput> {
  return {
    name: 'CyberRobotsProbe',
    description: 'Fetch robots.txt and sitemap.xml for a site in the resolved scope and report every Disallow path as an exposed path an attacker would try. The file contents are target-supplied.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Any absolute http(s) URL on the site; its origin is used.' } }, required: ['url'], additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => {
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!url) throw new ToolError('Parameter "url" is required.');
      try { new URL(url); } catch { throw new ToolError(`"${url}" is not an absolute URL.`); }
      return { url };
    },
    title: (input) => `Read robots.txt for ${withoutUserinfo(input.url)}`,
    async run(input, context) {
      const origin = new URL(input.url).origin;
      const robotsUrl = `${origin}/robots.txt`;
      if (!deps.inScope(robotsUrl, deps.scope)) throw new ToolError(`${withoutUserinfo(input.url)} is outside the engagement's resolved scope.`);
      const capture = await (deps.fetchCapture ?? ((url: string, signal?: AbortSignal) => captureHttp(url, signal)))(robotsUrl, context.signal);
      const body = capture.status >= 400 ? '' : capture.bodyExcerpt;
      const disallowed = [...new Set(body.split(/\r?\n/).map((line) => /^\s*Disallow:\s*(\S+)/i.exec(line)?.[1]).filter((value): value is string => Boolean(value) && value !== '/'))];
      const findings = capture.status >= 400 ? [] : disallowed.map((entry) => makeFinding({
        checkId: 'robots-disallowed-path',
        title: `robots.txt hides ${entry}`,
        severity: entry === '/backup/' || /backup|admin|private|internal|db|sql/i.test(entry) ? 'medium' : 'low',
        target: `${origin}${entry.startsWith('/') ? entry : `/${entry}`}`,
        vector: cvss31Vector({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'L', I: 'N', A: 'N' }),
        cwes: ['CWE-538'],
        evidence: `${robotsUrl} returned ${capture.status}:\n${body.split(/\r?\n/).filter((line) => /Disallow/i.test(line)).join('\n')}`,
        reproductionCommand: `curl -sS ${shellQuote(robotsUrl)}`,
        reason: 'robots.txt is public, so a Disallow line advertises the path rather than protecting it.'
      }));
      deps.onFindings?.(findings);
      const fenced = fenceUntrusted(robotsUrl, redactSecrets(`HTTP ${capture.status}\n${body || '(no robots.txt)'}`));
      if (fenced.warnings.length) context.onSecurity?.({ kind: 'injection', source: robotsUrl, detail: fenced.warnings.join('; ') });
      return `${redactSecrets(summarise(findings, `robots.txt returned ${capture.status}; no Disallow path was reported.`))}\n\n${fenced.text}`;
    }
  };
}

// ---- committed secrets -------------------------------------------------------------------------

interface SecretPattern { name: string; regex: RegExp; checkId?: string }

/** Pattern names are the vocabulary a report uses; values are always redacted (T-25-33). */
const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'OpenAI-style key', regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'assigned credential', regex: /\b(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|SECRET_KEY|PASSWORD|TOKEN)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+=]{8,})/ }
];

const SKIP_SECRET_FILES = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.map|.*\.min\.js|.*\.lock)$/;

interface SecretsProbeInput { root: string }

interface SecretHit { file: string; line: number; pattern: string; prefix: string; evidence: string }

/** Line-scans the workspace for credential shapes; the matched value is truncated to four characters. */
export async function scanSecrets(root: string, files?: WorkspaceFile[]): Promise<SecretHit[]> {
  const candidates = files ?? await walkWorkspace(root);
  const hits: SecretHit[] = [];
  for (const file of candidates) {
    if (SKIP_SECRET_FILES.test(file.relative)) continue;
    const text = await readScannable(file);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    const seen = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || line.length > 4_000) continue;
      for (const pattern of SECRET_PATTERNS) {
        const match = pattern.regex.exec(line);
        if (!match) continue;
        const value = match[1] ?? match[0];
        const key = `${pattern.name}:${index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Only the first four characters survive into the finding; the rest is redacted away.
        hits.push({ file: file.relative, line: index + 1, pattern: pattern.name, prefix: value.slice(0, 4), evidence: line.replace(match[0], `${value.slice(0, 4)}…`).slice(0, 160) });
        break;
      }
    }
  }
  return hits;
}

function secretsProbe(deps: CyberProbeDeps): AgentTool<SecretsProbeInput> {
  return {
    name: 'CyberSecretsProbe',
    description: 'Scan the workspace for committed credentials: private key blocks, GitHub and AWS key ids, and assigned API keys, tokens, and passwords. Each finding cites file:line, names the pattern, and shows only the first four characters of the value. File contents are untrusted.',
    parameters: { type: 'object', properties: { root: { type: 'string', description: 'Workspace folder to scan; defaults to the engagement scope path.' } }, additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => {
      const root = typeof raw.root === 'string' && raw.root.trim() ? raw.root.trim() : '';
      return { root };
    },
    title: (input) => `Scan ${input.root || 'the workspace'} for committed secrets`,
    async run(input) {
      const root = path.resolve(input.root || deps.scope?.paths[0] || '.');
      const hits = await scanSecrets(root);
      const findings = hits.map((hit) => makeFinding({
        checkId: 'committed-secret',
        title: `${hit.pattern} committed in ${hit.file}`,
        severity: hit.pattern === 'private key block' || hit.pattern === 'AWS access key id' || hit.pattern === 'GitHub token' || hit.pattern === 'OpenAI-style key' ? 'high' : 'medium',
        target: `${hit.file}:${hit.line}`,
        vector: cvss31Vector({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'H', I: 'N', A: 'N' }),
        cwes: ['CWE-798'],
        evidence: `${hit.file}:${hit.line}\n${hit.evidence}`,
        reproductionCommand: `sed -n '${hit.line}p' ${shellQuote(hit.file)}`,
        reason: `${hit.pattern} (value begins ${hit.prefix}…). Rotate it and remove it from history.`
      }));
      deps.onFindings?.(findings);
      return `${summarise(findings, `No credential shape matched in ${hits.length ? 'the scanned files' : root}.`)}\n\nScanned ${root} for ${SECRET_PATTERNS.length} credential patterns.`;
    }
  };
}

// ---- infrastructure as code --------------------------------------------------------------------

type IacKind = 'terraform' | 'cloudformation' | 'kubernetes' | 'dockerfile' | 'workflow';

const IAC_KIND_LABEL: Record<IacKind, string> = { terraform: 'Terraform', cloudformation: 'CloudFormation', kubernetes: 'Kubernetes', dockerfile: 'Dockerfile', workflow: 'CI workflow' };

export function iacKindOf(relative: string, text: string): IacKind | undefined {
  const base = path.posix.basename(relative);
  if (/\.tf$/i.test(base)) return 'terraform';
  if (/(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/i.test(relative) || /\.dockerfile$/i.test(base)) return 'dockerfile';
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(relative) || /(?:^|\/)\.gitlab-ci\.ya?ml$/i.test(relative)) return 'workflow';
  if (/\.template\.(?:json|ya?ml)$/i.test(base) || /\bAWS::[A-Za-z:]+/.test(text)) return 'cloudformation';
  if (/^\s*apiVersion\s*:/m.test(text) && /^\s*kind\s*:/m.test(text)) return 'kubernetes';
  return undefined;
}

export interface IacCheckResult { checkId: string; cwe: string; title: string; severity: Finding['severity']; line: number; evidence: string }

/** Lines with their 1-based numbers, full-line comments removed so prose can never self-match. */
function codeLines(text: string, comment: '#' | '//' | 'both'): Array<{ line: number; text: string }> {
  return text.split(/\r?\n/).map((value, index) => ({ line: index + 1, text: value })).filter(({ text: value }) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if ((comment === '#' || comment === 'both') && trimmed.startsWith('#')) return false;
    if ((comment === '//' || comment === 'both') && trimmed.startsWith('//')) return false;
    return true;
  });
}

const DOCKERFILE_SECRET = /^\s*(?:ENV|ARG)\s+([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)[=\s]+(.+)$/i;

function dockerfileChecks(text: string): IacCheckResult[] {
  const lines = codeLines(text, '#');
  const out: IacCheckResult[] = [];
  const user = lines.filter(({ text: value }) => /^\s*USER\s+\S+/i.test(value));
  const rootUser = user.find(({ text: value }) => /^\s*USER\s+(?:root|0)\s*$/i.test(value));
  if (rootUser) out.push({ checkId: 'iac-container-root', cwe: 'CWE-250', title: 'The container runs as root', severity: 'high', line: rootUser.line, evidence: rootUser.text.trim() });
  else if (!user.length) {
    const from = lines.find(({ text: value }) => /^\s*FROM\s/i.test(value));
    out.push({ checkId: 'iac-container-root', cwe: 'CWE-250', title: 'The image sets no USER, so it runs as root', severity: 'high', line: from?.line ?? 1, evidence: from?.text.trim() ?? '(no FROM line)' });
  }
  for (const { line, text: value } of lines) {
    const secret = DOCKERFILE_SECRET.exec(value);
    if (!secret) continue;
    const literal = secret[2].trim();
    if (/^\$\{?[A-Za-z0-9_]+/.test(literal) && !/fixture-|DO-NOT-USE/.test(literal)) continue;
    out.push({ checkId: 'iac-hardcoded-secret', cwe: 'CWE-798', title: `A literal value is baked into the image for ${secret[1]}`, severity: 'high', line, evidence: value.trim().slice(0, 160) });
  }
  for (const { line, text: value } of lines) {
    const from = /^\s*FROM\s+(\S+)/i.exec(value);
    if (!from) continue;
    const image = from[1];
    if (image === 'scratch' || image.includes('$')) continue;
    const tag = image.includes('@') ? undefined : image.split(':')[1];
    if (!image.includes('@') && (!tag || tag === 'latest')) out.push({ checkId: 'iac-unpinned-image', cwe: 'CWE-829', title: `The base image ${image} is not pinned to a fixed version`, severity: 'low', line, evidence: value.trim() });
  }
  return out;
}

function terraformChecks(text: string): IacCheckResult[] {
  const lines = codeLines(text, '#');
  const out: IacCheckResult[] = [];
  for (const { line, text: value } of lines) {
    const publicRange = /(?:cidr_blocks|ipv6_cidr_blocks|cidr_block)\s*=\s*\[?\s*"(0\.0\.0\.0\/0|::\/0)"/i.exec(value);
    if (publicRange) out.push({ checkId: 'iac-public-ingress', cwe: 'CWE-284', title: `An ingress rule admits ${publicRange[1]}`, severity: 'high', line, evidence: value.trim() });
    const publicAcl = /acl\s*=\s*"(?:public-read|public-read-write)"/i.exec(value);
    if (publicAcl) out.push({ checkId: 'iac-public-ingress', cwe: 'CWE-284', title: 'A bucket ACL makes the contents public', severity: 'high', line, evidence: value.trim() });
  }
  // A bucket is encrypted when anything in the file enables encryption for it: the modern separate
  // resource or the older nested block. Absence of both is the finding, reported at the bucket line.
  const encryption = lines.some(({ text: value }) => /server_side_encryption|sse_algorithm|kms_key_id|aws_s3_bucket_server_side_encryption_configuration/i.test(value));
  const buckets = lines.filter(({ text: value }) => /^\s*resource\s+"aws_(?:s3_bucket|s3_bucket_acl|ebs_volume|rds_cluster|dynamodb_table)"\s+"([^"]+)"/.test(value));
  if (!encryption && buckets.length) {
    for (const bucket of buckets.filter(({ text: value }) => /aws_s3_bucket"/.test(value) || /aws_ebs_volume"/.test(value))) {
      out.push({ checkId: 'iac-unencrypted-storage', cwe: 'CWE-311', title: `Storage declared at ${bucket.text.trim().slice(0, 60)} is not encrypted`, severity: 'high', line: bucket.line, evidence: bucket.text.trim() });
    }
  }
  return out;
}

function workflowChecks(text: string): IacCheckResult[] {
  const lines = codeLines(text, '#');
  const out: IacCheckResult[] = [];
  for (const { line, text: value } of lines) {
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/i.exec(value);
    if (uses && !/^\.\//.test(uses[1]) && !uses[1].includes('@') ) out.push({ checkId: 'iac-unpinned-action', cwe: 'CWE-829', title: `The action ${uses[1]} is not pinned to a commit`, severity: 'medium', line, evidence: value.trim() });
    else if (uses) {
      const [action, ref] = uses[1].split('@');
      if (action.includes('/') && !/^[0-9a-f]{40}$/i.test(ref)) out.push({ checkId: 'iac-unpinned-action', cwe: 'CWE-829', title: `The action ${action} is pinned to ${ref}, not a commit SHA`, severity: 'medium', line, evidence: value.trim() });
    }
    const inline = /^\s*([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Za-z0-9_]*)\s*:\s*(.+)$/i.exec(value);
    if (inline && !/\$\{\{/.test(inline[2]) && !/^\s*$/.test(inline[2]) && inline[2].length >= 8) out.push({ checkId: 'iac-hardcoded-secret', cwe: 'CWE-798', title: `${inline[1]} is written in plaintext in the workflow`, severity: 'high', line, evidence: value.trim().slice(0, 160) });
  }
  return out;
}

function kubernetesChecks(text: string): IacCheckResult[] {
  const lines = codeLines(text, '#');
  const out: IacCheckResult[] = [];
  for (const { line, text: value } of lines) if (/privileged:\s*true/i.test(value)) out.push({ checkId: 'iac-privileged-container', cwe: 'CWE-250', title: 'A container runs privileged', severity: 'high', line, evidence: value.trim() });
  const containers = lines.filter(({ text: value }) => /^\s*-?\s*name:\s*\S+/.test(value));
  const nonRoot = lines.some(({ text: value }) => /runAsNonRoot:\s*true/i.test(value));
  if (containers.length && !nonRoot) {
    out.push({ checkId: 'iac-missing-run-as-non-root', cwe: 'CWE-272', title: 'No container sets runAsNonRoot', severity: 'medium', line: containers[0].line, evidence: containers[0].text.trim() });
  }
  return out;
}

function cloudFormationChecks(text: string): IacCheckResult[] {
  const lines = codeLines(text, '//');
  const out: IacCheckResult[] = [];
  for (const { line, text: value } of lines) {
    if (/"?(?:CidrIp|CidrBlock)"?\s*:\s*"0\.0\.0\.0\/0"/i.test(value)) out.push({ checkId: 'iac-public-ingress', cwe: 'CWE-284', title: 'A security group admits 0.0.0.0/0', severity: 'high', line, evidence: value.trim() });
    if (/"?Encrypted"?\s*:\s*false/i.test(value)) out.push({ checkId: 'iac-unencrypted-storage', cwe: 'CWE-311', title: 'Storage is declared unencrypted', severity: 'high', line, evidence: value.trim() });
  }
  return out;
}

export function iacChecks(kind: IacKind, text: string): IacCheckResult[] {
  switch (kind) {
    case 'terraform': return terraformChecks(text);
    case 'dockerfile': return dockerfileChecks(text);
    case 'workflow': return workflowChecks(text);
    case 'kubernetes': return kubernetesChecks(text);
    case 'cloudformation': return cloudFormationChecks(text);
  }
}

interface IacProbeInput { root: string }

function iacProbe(deps: CyberProbeDeps): AgentTool<IacProbeInput> {
  return {
    name: 'CyberIacProbe',
    description: 'Inspect Terraform, CloudFormation, Kubernetes manifests, Dockerfiles, and CI workflows under a folder for misconfiguration: public ingress, unencrypted storage, a container running as root, a hardcoded credential, an unpinned image or action, and a privileged container. Each finding cites file:line, a CWE id, and a command that prints the offending line.',
    parameters: { type: 'object', properties: { root: { type: 'string', description: 'Folder to scan; defaults to the engagement scope path.' } }, additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => ({ root: typeof raw.root === 'string' && raw.root.trim() ? raw.root.trim() : '' }),
    title: (input) => `Inspect infrastructure as code in ${input.root || 'the workspace'}`,
    async run(input) {
      const root = path.resolve(input.root || deps.scope?.paths[0] || '.');
      const files = await walkWorkspace(root);
      const findings: Finding[] = [];
      const present = new Map<IacKind, number>();
      const unreadable: string[] = [];
      for (const file of files) {
        // Cheap name-first filter: only a few extensions can be IaC, and the content sniff runs only
        // for those, so a large tree is not read twice.
        if (!/\.(?:tf|template\.(?:json|ya?ml)|ya?ml|yml|json)$/i.test(file.relative) && !/(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/i.test(file.relative) && !/\.dockerfile$/i.test(file.relative)) continue;
        const text = await readScannable(file);
        if (text === undefined) { unreadable.push(file.relative); continue; }
        const kind = iacKindOf(file.relative, text);
        if (!kind) continue;
        present.set(kind, (present.get(kind) ?? 0) + 1);
        for (const check of iacChecks(kind, text)) {
          findings.push(makeFinding({
            checkId: check.checkId,
            title: `${check.title} (${file.relative})`,
            severity: check.severity,
            target: `${file.relative}:${check.line}`,
            vector: cvss31Vector({ AV: 'N', AC: 'L', PR: 'L', UI: 'N', S: 'U', C: 'H', I: 'L', A: 'N' }),
            cwes: [check.cwe],
            evidence: `${file.relative}:${check.line}\n${check.evidence}`,
            reproductionCommand: `sed -n '${check.line}p' ${shellQuote(file.relative)}`,
            reason: `${IAC_KIND_LABEL[kind]} check ${check.checkId}.`
          }));
        }
      }
      deps.onFindings?.(findings);

      // Absence is reported, never silent: "no Dockerfile found" is a different statement from
      // "the Dockerfile is clean", and an empty result must not read as the latter (CYBER-12).
      const coverage = (Object.keys(IAC_KIND_LABEL) as IacKind[]).map((kind) => present.get(kind) ? `${IAC_KIND_LABEL[kind]}: ${present.get(kind)} file(s) checked` : `No ${IAC_KIND_LABEL[kind]} files found under ${root}`);
      const lines = [...coverage, ...unreadable.map((file) => `${file} could not be read and was skipped`)];
      return `${findings.length ? summarise(findings) : `No infrastructure-as-code misconfiguration found under ${root}.`}\n\n${lines.join('\n')}`;
    }
  };
}

// ---- dependencies ------------------------------------------------------------------------------

interface DependencyProbeInput { root: string }

/** The register securityTool.ts uses, so a not-checked result never reads as clean. */
const NOT_CONSENTED = 'Vulnerability checks are not enabled for this project. Ask the user to run "NEAR AI: Scan Dependencies for Vulnerabilities" once to allow them. Until then, dependencies were not checked.';

function dependencyProbe(deps: CyberProbeDeps): AgentTool<DependencyProbeInput> {
  return {
    name: 'CyberDependencyProbe',
    description: 'Check the project\'s locked dependencies for known vulnerabilities by reusing the consent-gated OSV.dev scan. Reports each CVE with severity, CWE ids where the advisory has them, the lockfile it came from, and an osv-scanner command that reproduces it. When the scan is not enabled, says so instead of reporting the project clean.',
    parameters: { type: 'object', properties: { root: { type: 'string', description: 'Project folder whose lockfiles are checked; defaults to the engagement scope path.' } }, additionalProperties: false },
    capability: 'read',
    untrusted: true,
    parse: (raw) => ({ root: typeof raw.root === 'string' && raw.root.trim() ? raw.root.trim() : '' }),
    title: (input) => `Check dependencies in ${input.root || 'the workspace'}`,
    async run(input) {
      const root = path.resolve(input.root || deps.scope?.paths[0] || '.');
      if (deps.security && !deps.security.consented()) return NOT_CONSENTED;
      const report = deps.scan ? await deps.scan(root) : deps.security ? await deps.security.scan() : await scanProject(root, { write: 'never' });
      if (!report) return 'The dependency check could not run, so dependencies were not checked.';
      const findings: Finding[] = [];
      for (const packageFinding of report.packages) {
        for (const vulnerability of packageFinding.vulnerabilities) {
          const source = packageFinding.component.source || 'a lockfile';
          findings.push(makeFinding({
            checkId: 'vulnerable-dependency',
            title: `${packageFinding.component.name} ${packageFinding.component.version} has ${vulnerability.id}`,
            severity: normaliseSeverity(vulnerability.severity),
            target: source,
            vector: vulnerability.vector ?? cvss31Vector({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'H', I: 'H', A: 'H' }),
            cwes: vulnerability.cwes,
            evidence: `component=${packageFinding.component.purl}\n${vulnerability.id}${vulnerability.aliases.length ? ` (${vulnerability.aliases.join(', ')})` : ''}: ${vulnerability.summary}${vulnerability.fixed.length ? `\nFixed in ${vulnerability.fixed[0]}.` : ''}`,
            reproductionCommand: `npx --yes osv-scanner --lockfile=${shellQuote(source)}`,
            reason: vulnerability.summary
          }));
        }
      }
      deps.onFindings?.(findings);
      const notes = [...report.notes, ...report.errors];
      const header = findings.length ? summarise(findings) : report.errors.length ? 'No vulnerability was reported, but the dependency check was incomplete.' : `No known vulnerable dependency in ${report.components.length} component(s) from ${report.lockfiles.join(', ') || 'no lockfile'}.`;
      return `${header}\n\n${[...notes.map((note) => `Note: ${note}`), report.lockfiles.length ? '' : 'No lockfile was found, so dependencies could not be checked.'].filter(Boolean).join('\n')}`.trimEnd();
    }
  };
}

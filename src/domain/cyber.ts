import { lookup as dnsLookup } from 'node:dns/promises';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

// Pure domain for the cybersecurity harness: targets and the scope they resolve to, engagements
// and runs, findings with their standards mapping, and the depth profiles. No `vscode` import and
// no side effects beyond the injectable lookups, so it runs under plain `node --test`.

export type TargetKind = 'url' | 'workspace' | 'cidr' | 'container' | 'git';

export interface Target { kind: TargetKind; value: string }

export interface ResolvedScope {
  hosts: string[];
  ports: number[];
  paths: string[];
  exclusions: string[];
  /** Something about the scope the user must read before a run: unresolved container IPs, a git path caveat. */
  note?: string;
}

/** Four verdicts (D-24); a failed exploit attempt is never rendered as "clean". */
export type Verdict = 'verified_access' | 'exploit_failed' | 'could_not_determine' | 'not_vulnerable';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** The one declaration of the legal acceptance record; every plan in this phase imports it from here. */
export interface DisclaimerAcceptance {
  /** The legal name or organization the acceptor typed (D-17). */
  acceptor: string;
  osUser: string;
  machine: string;
  extensionVersion: string;
  /** Version of the regional statement that was accepted, so a new text forces re-acceptance (D-18). */
  textVersion: string;
  region: string;
  acceptedAt: string;
}

export type CyberMode = 'passive' | 'active' | 'intrusive';

export type SandboxTier = 'container' | 'tempFolder' | 'disabled';

export interface Engagement {
  id: string;
  /** The workspace this engagement belongs to; globalStorage is keyed by it (D-06). */
  workspace: string;
  target: Target;
  resolvedScope: ResolvedScope;
  region: string;
  authorizationStatement: string;
  allowedModes: CyberMode[];
  window?: { start: string; end: string };
  rateLimit?: { opsPerMinute: number };
  exclusions: string[];
  sandbox: { tier: SandboxTier; reason?: string };
  acceptedDisclaimer: DisclaimerAcceptance;
  createdAt: string;
  /** Set when the first run starts; from then on the frozen fields cannot change (CYBER-02). */
  frozen: boolean;
}

export type RunOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'budget-exhausted';

export interface EngagementRun {
  id: string;
  engagementId: string;
  startedAt: string;
  finishedAt?: string;
  depth: DepthProfile;
  model?: string;
  /** The ledger this run appends to, relative to the engagement directory. */
  ledgerPath: string;
  outcome: RunOutcome;
}

export interface Finding {
  id: string;
  /** The check that produced it, e.g. `missing-hsts`; the key into WSTG_MAP and hardeningAdvice. */
  checkId: string;
  title: string;
  severity: Severity;
  verdict: Verdict;
  cvssVector: string;
  cvssScore?: number;
  cwes: string[];
  wstg: string[];
  /** The evidence excerpt shown in the report; already redacted. */
  evidenceExcerpt: string;
  /** SHA-256 of the full evidence blob, which is stored separately (D-28). */
  evidenceHash: string;
  reproductionCommand: string;
  remediation: string;
  /** Why the verdict is what it is, when the evidence does not decide it. */
  reason?: string;
  target?: string;
}

/** OWASP WSTG v4.2 ids per check (D-26). */
export const WSTG_MAP: Record<string, string[]> = {
  'missing-hsts': ['WSTG-CONF-02'],
  'missing-x-content-type-options': ['WSTG-CONF-07'],
  'missing-x-frame-options': ['WSTG-CONF-07'],
  'server-version-disclosure': ['WSTG-INFO-02'],
  'weak-tls': ['WSTG-INFO-09', 'WSTG-CRYPTO-01'],
  'insecure-cookie': ['WSTG-SESS-02'],
  'directory-listing': ['WSTG-CONF-04'],
  'exposed-admin-path': ['WSTG-CONF-05'],
  'xss-reflected': ['WSTG-INJ-01'],
  'sql-injection': ['WSTG-INJ-05'],
  'committed-secret': ['WSTG-CONF-06'],
  'tls-certificate-expired': ['WSTG-CRYPTO-01'],
  'tls-weak-protocol': ['WSTG-CRYPTO-01', 'WSTG-CRYPTO-02'],
  'tls-untrusted-chain': ['WSTG-CRYPTO-01', 'WSTG-CRYPTO-02'],
  'dns-missing-spf': ['WSTG-CONF-02'],
  'dns-missing-dmarc': ['WSTG-CONF-02'],
  'open-port': ['WSTG-INFO-04'],
  'robots-disallowed-path': ['WSTG-INFO-03', 'WSTG-CONF-04'],
  'iac-public-ingress': ['WSTG-CONF-07'],
  'iac-unencrypted-storage': ['WSTG-CONF-07'],
  'iac-container-root': ['WSTG-CONF-07'],
  'iac-hardcoded-secret': ['WSTG-CONF-06'],
  'iac-unpinned-image': ['WSTG-CONF-07'],
  'iac-unpinned-action': ['WSTG-CONF-07'],
  'iac-privileged-container': ['WSTG-CONF-07'],
  'iac-missing-run-as-non-root': ['WSTG-CONF-07'],
  'vulnerable-dependency': ['WSTG-INFO-02']
};

export const HARDENING_ADVICE: Record<string, string> = {
  'missing-hsts': 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains on every HTTPS response.',
  'missing-x-content-type-options': 'Send X-Content-Type-Options: nosniff so browsers stop guessing content types.',
  'missing-x-frame-options': 'Send X-Frame-Options: DENY (or a frame-ancestors Content-Security-Policy) to stop clickjacking.',
  'server-version-disclosure': 'Remove the version from the Server header, or front the service with a proxy that rewrites it.',
  'weak-tls': 'Disable TLS 1.0/1.1 and the CBC cipher suites; serve only TLS 1.2 and 1.3.',
  'insecure-cookie': 'Set Secure, HttpOnly, and SameSite on every session cookie.',
  'committed-secret': 'Move the secret out of the repository and rotate it.',
  'tls-certificate-expired': 'Replace the certificate before it expires and automate renewal.',
  'tls-weak-protocol': 'Serve TLS 1.2 and 1.3 only; disable TLS 1.0, 1.1, and NULL/EXPORT ciphers.',
  'dns-missing-spf': 'Publish a TXT record beginning v=spf1 for the domain, ending in -all once the senders are listed.',
  'dns-missing-dmarc': 'Publish a _dmarc TXT record (v=DMARC1; p=quarantine; rua=mailto:…) to stop sender spoofing.',
  'open-port': 'Close the port or restrict it to the addresses that need it.',
  'robots-disallowed-path': 'Treat disallowed paths as suggestions only: remove the path, or protect it with authentication.',
  'iac-public-ingress': 'Restrict the ingress range to the addresses that need it (a /32 or the office CIDR).',
  'iac-unencrypted-storage': 'Enable server-side encryption on the bucket or volume.',
  'iac-container-root': 'Add a non-root USER to the image and run the process as it.',
  'iac-hardcoded-secret': 'Read the value from the environment or a secret store; keep it out of the image and the workflow.',
  'iac-unpinned-image': 'Tag the base image with an exact version and digest.',
  'iac-unpinned-action': 'Pin the action to a full commit SHA, with the version in a comment.',
  'iac-privileged-container': 'Drop privileged mode; add only the capabilities the container needs.',
  'iac-missing-run-as-non-root': 'Set runAsNonRoot: true in the pod security context.',
  'vulnerable-dependency': 'Upgrade the dependency to a fixed version, or pin a patched release.'
};

export function hardeningAdvice(checkId: string): string {
  return HARDENING_ADVICE[checkId] ?? 'Remove or configure the exposed weakness reported by the check above.';
}

export type DepthProfile = 'quick' | 'standard' | 'deep';

/** What a depth profile runs, not only how long it may run (D-25). */
export interface ProfileContent {
  budgetMs: number;
  checks: string[];
  exploitsAttempted: number;
  sourceScan: boolean;
  portSweep: boolean;
  cveSweep: boolean;
}

const QUICK_CHECKS = ['recon', 'http-headers', 'tls'];

// Standard and deep extend the previous list rather than re-listing it, so a quick check can never
// be missing from standard, and the subset ordering the profile test asserts is structural.
const STANDARD_CHECKS = [...QUICK_CHECKS, 'dns', 'exposed-paths', 'committed-secrets', 'dependency-scan', 'source-scan'];
const DEEP_CHECKS = [...STANDARD_CHECKS, 'iac-probe'];

export const PROFILE_CONTENT: Record<DepthProfile, ProfileContent> = {
  quick: { budgetMs: 5 * 60_000, checks: QUICK_CHECKS, exploitsAttempted: 0, sourceScan: false, portSweep: false, cveSweep: false },
  standard: { budgetMs: 15 * 60_000, checks: STANDARD_CHECKS, exploitsAttempted: 1, sourceScan: true, portSweep: false, cveSweep: false },
  deep: { budgetMs: 45 * 60_000, checks: DEEP_CHECKS, exploitsAttempted: 3, sourceScan: true, portSweep: true, cveSweep: true }
};

export function profileChecks(depth: DepthProfile): string[] {
  const content = PROFILE_CONTENT[depth];
  if (!content) throw new Error(`Unknown depth profile "${String(depth)}".`);
  return [...content.checks];
}

const CHECK_KINDS: Record<string, TargetKind[]> = {
  recon: ['url', 'workspace', 'cidr', 'container', 'git'],
  'http-headers': ['url'],
  tls: ['url'],
  dns: ['url'],
  'exposed-paths': ['url'],
  'committed-secrets': ['workspace', 'git'],
  'dependency-scan': ['workspace', 'git'],
  'source-scan': ['workspace', 'git'],
  'iac-probe': ['workspace', 'git'],
  'port-sweep': ['url', 'cidr', 'container']
};

/** The checks a profile enables for this target kind, in profile order. */
export function enabledChecksFor(depth: DepthProfile, kind: TargetKind): string[] {
  const checks = profileChecks(depth);
  if (PROFILE_CONTENT[depth].portSweep) checks.push('port-sweep');
  return checks.filter((check) => (CHECK_KINDS[check] ?? [kind]).includes(kind));
}

// ---- CVSS 3.1 ---------------------------------------------------------------------------------

export interface Cvss31Metrics {
  AV: 'N' | 'A' | 'L' | 'P';
  AC: 'L' | 'H';
  PR: 'N' | 'L' | 'H';
  UI: 'N' | 'R';
  S: 'U' | 'C';
  C: 'H' | 'L' | 'N';
  I: 'H' | 'L' | 'N';
  A: 'H' | 'L' | 'N';
}

/** The base vector in CVSS 3.1's fixed metric order; the score comes from cvss3Score. */
export function cvss31Vector(metrics: Cvss31Metrics): string {
  return `CVSS:3.1/AV:${metrics.AV}/AC:${metrics.AC}/PR:${metrics.PR}/UI:${metrics.UI}/S:${metrics.S}/C:${metrics.C}/I:${metrics.I}/A:${metrics.A}`;
}

// ---- Target resolution ------------------------------------------------------------------------

export class ScopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export interface ResolveDeps {
  /** Resolves a hostname to addresses; injected so resolution stays offline and testable. */
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
  exists?: (candidate: string) => Promise<boolean>;
  /** Most addresses a CIDR may expand to; beyond it resolution fails with a reason (D-09 budget). */
  cidrBudget?: number;
}

const DEFAULT_CIDR_BUDGET = 4_096;
const WORKSPACE_EXCLUSIONS = ['.git', 'node_modules', 'dist'];
/** Cloud metadata; resolving it as a target is an SSRF to the host itself (T-25-07). */
const METADATA_PREFIX = '169.254.';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const isIpv4Literal = (value: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
const isIpv6Literal = (value: string): boolean => value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value);

function parseIpv4(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  let address = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    address = ((address << 8) | octet) >>> 0;
  }
  return address;
}

const formatIpv4 = (address: number): string => [(address >>> 24) & 255, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join('.');

function parseIpv6(value: string): bigint | undefined {
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const groups = (text: string): string[] => (text ? text.split(':') : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1] ?? '');
  const filled = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (filled.length !== 8) return undefined;
  let address = 0n;
  for (const group of filled) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    address = (address << 16n) | BigInt(parseInt(group, 16));
  }
  return address;
}

function expandCidr(value: string, budget: number): string[] {
  const [address, prefixText] = value.split('/');
  if (address === undefined || address === '') throw new ScopeError(`"${value}" is not an address range.`);
  if (isIpv4Literal(address)) {
    const base = parseIpv4(address)!;
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new ScopeError(`"${value}" has an IPv4 prefix outside 0-32.`);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (base & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const first = prefix <= 30 ? network + 1 : network;
    const last = prefix <= 30 ? broadcast - 1 : broadcast;
    const count = last - first + 1;
    if (count > budget) throw new ScopeError(`${value} covers ${count.toLocaleString('en-US')} hosts, more than the ${budget.toLocaleString('en-US')}-host budget. Narrow the range.`);
    const hosts: string[] = [];
    for (let current = first; current <= last; current += 1) hosts.push(formatIpv4(current >>> 0));
    return hosts;
  }
  const base = parseIpv6(address);
  if (base === undefined) throw new ScopeError(`"${value}" is not an IPv4 or IPv6 address range.`);
  const prefix = prefixText === undefined ? 128 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) throw new ScopeError(`"${value}" has an IPv6 prefix outside 0-128.`);
  const hostBits = BigInt(128 - prefix);
  const count = Number(1n << hostBits);
  if (count > budget) throw new ScopeError(`${value} covers ${count.toLocaleString('en-US')} addresses, more than the ${budget.toLocaleString('en-US')}-address budget. Narrow the range.`);
  const network = (base >> hostBits) << hostBits;
  const hosts: string[] = [];
  for (let offset = 0; offset < count; offset += 1) hosts.push(formatIpv6(network + BigInt(offset)));
  return hosts;
}

function formatIpv6(address: bigint): string {
  return Array.from({ length: 8 }, (_value, index) => ((address >> BigInt((7 - index) * 16)) & 0xffffn).toString(16)).join(':');
}

async function resolveHosts(hostname: string, deps: ResolveDeps): Promise<string[]> {
  if (isIpv4Literal(hostname) || isIpv6Literal(hostname)) return [hostname.toLowerCase()];
  const lookup = deps.lookup ?? (async (name: string) => (await dnsLookup(name, { all: true })).map((entry) => entry.address));
  const addresses = [...new Set((await lookup(hostname)).map((address) => address.toLowerCase()).filter(Boolean))];
  if (!addresses.length) throw new ScopeError(`${hostname} did not resolve to an address.`);
  return addresses;
}

/** Metadata and loopback are refused unless the target names one literally, so a resolved name cannot point the harness at the host itself. */
function refuseSelfTarget(hostname: string, addresses: string[]): void {
  if (addresses.some((address) => address.startsWith(METADATA_PREFIX)) && !hostname.startsWith(METADATA_PREFIX)) {
    throw new ScopeError(`${hostname} resolves to the cloud metadata range (${addresses.join(', ')}); naming it literally is required.`);
  }
  if (addresses.some((address) => LOOPBACK.has(address)) && !LOOPBACK.has(hostname.toLowerCase())) {
    throw new ScopeError(`${hostname} resolves to this machine (${addresses.join(', ')}); naming the loopback address literally is required.`);
  }
}

export async function resolveTarget(target: Target, deps: ResolveDeps = {}): Promise<ResolvedScope> {
  const value = target.value.trim();
  if (!value) throw new ScopeError(`A ${target.kind} target needs a value.`);
  const exists = deps.exists ?? (async (candidate: string) => Boolean(await stat(candidate).catch(() => undefined)));

  switch (target.kind) {
    case 'url': {
      let parsed: URL;
      try { parsed = new URL(value.includes('://') ? value : `https://${value}`); } catch { throw new ScopeError(`"${value}" is not a URL, host, or IP address.`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ScopeError(`Only http and https targets are supported; "${parsed.protocol}" was given.`);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!hostname) throw new ScopeError(`"${value}" names no host.`);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      const addresses = await resolveHosts(hostname, deps);
      refuseSelfTarget(hostname, addresses);
      return { hosts: [...new Set([hostname, ...addresses])], ports: [port], paths: [parsed.pathname || '/'], exclusions: [] };
    }
    case 'workspace': {
      const root = path.resolve(value);
      if (!(await exists(root))) throw new ScopeError(`The workspace folder ${root} does not exist.`);
      return { hosts: [], ports: [], paths: [root], exclusions: [...WORKSPACE_EXCLUSIONS] };
    }
    case 'cidr':
      return { hosts: expandCidr(value, deps.cidrBudget ?? DEFAULT_CIDR_BUDGET), ports: [], paths: [], exclusions: [] };
    case 'container':
      return { hosts: [value], ports: [], paths: [], exclusions: [], note: 'Container addresses are resolved at run time by the sandbox service.' };
    case 'git': {
      if (/^(?:[a-z]+:\/\/|git@)/i.test(value)) throw new ScopeError('cloning arbitrary remotes is out of scope this phase');
      const root = path.resolve(value);
      if (!(await exists(root))) throw new ScopeError('cloning arbitrary remotes is out of scope this phase');
      return { hosts: [], ports: [], paths: [root], exclusions: ['.git'] };
    }
    default:
      throw new ScopeError(`Unknown target kind "${String(target.kind)}".`);
  }
}

/** Whether a URL is inside a resolved scope: its host is one of the scope's, and its port is allowed. */
export function urlInScope(scope: ResolvedScope, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!scope.hosts.map((host) => host.toLowerCase()).includes(hostname)) return false;
  if (!scope.ports.length) return true;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return scope.ports.includes(port);
}

/** ISO 8601 without sub-second precision, the format every record and ledger entry uses. */
export function isoTimestamp(value: Date | string = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('A valid date is required.');
  return `${date.toISOString().slice(0, 19)}Z`;
}

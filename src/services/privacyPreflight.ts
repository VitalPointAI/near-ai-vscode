import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ActionCapability } from '../domain/policy';
import { redactSecrets } from '../domain/redaction';
import type {
  DataClass, PrivacyAuditRecord, PrivacyDecision, PrivacyOverride, PrivacyPreflightResult,
  PrivacyRule, PreflightFinding, ProviderRequest, RedactedPreview, SovereigntyMode
} from '../domain/privacy';

const SECRET_PATTERNS = [
  /bearer\s+[^\s,;]+/i,
  /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i
];
const PRIVATE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials?|secrets?|private|id_[^/]+|.*\.pem|.*\.key|.*\.p12|.*\.pfx)(?:$|\/)/i;
const NEAR_CREDENTIAL_PATH = /(?:^|\/)(?:\.near-credentials)(?:\/|$)/i;
const PERSONAL_DATA = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:phone|address|ssn|social security)\b/i;

export interface PrivacyPreflightOptions {
  mode?: SovereigntyMode;
  rules?: PrivacyRule[];
  now?: () => number;
}

interface PendingOverride extends PrivacyOverride { consumed: boolean; }

export class PrivacyPreflight {
  private readonly mode: SovereigntyMode;
  private readonly rules: PrivacyRule[];
  private readonly now: () => number;
  private readonly overrides = new Map<string, PendingOverride>();
  private readonly audits: PrivacyAuditRecord[] = [];

  public constructor(options: PrivacyPreflightOptions = {}) {
    this.mode = options.mode ?? 'standard';
    this.rules = options.rules ?? [];
    this.now = options.now ?? Date.now;
  }

  public issueOverride(request: ProviderRequest, expiresInMs = 60_000): PrivacyOverride {
    const evaluation = this.evaluate(request);
    const override: PendingOverride = {
      token: `privacy-${randomUUID()}`,
      provider: request.provider,
      providerBoundary: request.providerBoundary,
      paths: normalizePaths(request.paths ?? []),
      classifications: evaluation.classifications,
      requestFingerprint: fingerprint(request),
      expiresAt: this.now() + Math.max(1, expiresInMs),
      consumed: false
    };
    this.overrides.set(override.token, override);
    return { ...override };
  }

  public preflight(request: ProviderRequest, overrideToken?: string): PrivacyPreflightResult {
    const evaluation = this.evaluate(request);
    const override = overrideToken ? this.overrides.get(overrideToken) : undefined;
    const validOverride = this.validOverride(override, request, evaluation.classifications);
    const outcome = this.outcome(request, evaluation.classifications, validOverride);
    const decision: PrivacyDecision = {
      outcome,
      reason: this.reason(request, evaluation.classifications, validOverride),
      provider: request.provider,
      providerBoundary: request.providerBoundary,
      sovereigntyMode: this.mode,
      classifications: evaluation.classifications,
      dispatchToken: outcome === 'allow' ? `dispatch-${randomUUID()}` : undefined,
      overrideUsed: validOverride
    };
    if (validOverride && override) override.consumed = true;
    const audit: PrivacyAuditRecord = {
      id: `privacy-audit-${randomUUID()}`,
      timestamp: new Date(this.now()).toISOString(),
      provider: request.provider,
      providerBoundary: request.providerBoundary,
      sovereigntyMode: this.mode,
      capabilities: request.capability ? [request.capability] : [],
      paths: normalizePaths(request.paths ?? []),
      classifications: evaluation.classifications,
      outcome,
      reason: decision.reason,
      overrideUsed: validOverride,
      preview: evaluation.preview
    };
    this.audits.push(audit);
    return { preview: evaluation.preview, decision, audit };
  }

  public getAuditRecords(): PrivacyAuditRecord[] { return this.audits.map((record) => structuredClone(record)); }

  private evaluate(request: ProviderRequest): { classifications: DataClass[]; preview: RedactedPreview } {
    const paths = normalizePaths(request.paths ?? []);
    const findings = new Map<DataClass, PreflightFinding>();
    const add = (dataClass: DataClass, reason: string, path = '') => {
      const existing = findings.get(dataClass) ?? { dataClass, count: 0, paths: [], reason };
      existing.count += 1;
      if (path && existing.paths.length < 12 && !existing.paths.includes(path)) existing.paths.push(path);
      findings.set(dataClass, existing);
    };
    for (const path of paths) {
      if (NEAR_CREDENTIAL_PATH.test(path) || PRIVATE_PATH.test(path)) add('privateFile', 'credential or private file path', path);
      if (NEAR_CREDENTIAL_PATH.test(path)) add('secret', 'NEAR credential path', path);
      if (path.includes('..') || isAbsolute(path) || path.startsWith('~')) add('scopeExpansion', 'path is not a workspace-relative path', path);
    }
    const context = request.context ?? '';
    if (SECRET_PATTERNS.some((pattern) => pattern.test(context))) add('secret', 'credential-like context detected');
    if (PERSONAL_DATA.test(context)) add('personalData', 'personal data pattern detected');
    if (request.scope && /(?:all files|entire workspace|outside workspace|home directory)/i.test(request.scope)) add('scopeExpansion', 'requested scope exceeds the proposed paths');
    if (request.attachmentIds?.some((id) => !/^attachment-[a-z0-9]{20}$/.test(id))) add('scopeExpansion', 'attachment reference is not an opaque host ID');
    if (findings.size === 0 && paths.length === 0 && !context && !request.scope) add('unknown', 'no supported classification signal was provided');
    const classificationList = [...findings.keys()].sort();
    const preview: RedactedPreview = {
      provider: request.provider,
      providerBoundary: request.providerBoundary,
      teeStatus: request.teeStatus ?? (request.providerBoundary === 'tee' ? 'unknown' : 'not-applicable'),
      paths: paths.map((path) => redactPath(path)),
      context: redactPreview(context),
      findings: [...findings.values()].map((finding) => ({ ...finding, paths: finding.paths.map(redactPath) }))
    };
    return { classifications: classificationList, preview };
  }

  private outcome(request: ProviderRequest, classes: DataClass[], override: boolean): PrivacyDecision['outcome'] {
    if (override) return 'allow';
    if (this.mode === 'local-only' && request.providerBoundary !== 'local') return 'block';
    if (this.mode === 'tee-only' && request.providerBoundary !== 'tee' && request.providerBoundary !== 'local') return 'block';
    let result: PrivacyDecision['outcome'] = 'allow';
    for (const dataClass of classes) {
      const rule = this.ruleFor(request, dataClass);
      const mode = rule?.mode ?? (dataClass === 'secret' || dataClass === 'privateFile' || dataClass === 'scopeExpansion' || dataClass === 'unknown' ? 'block' : 'warn-and-confirm');
      if (mode === 'block' || (mode === 'local-only' && request.providerBoundary !== 'local')) return 'block';
      if (mode === 'warn-and-confirm') result = 'warn-and-confirm';
    }
    return result;
  }

  private ruleFor(request: ProviderRequest, dataClass: DataClass): PrivacyRule | undefined {
    const paths = normalizePaths(request.paths ?? []);
    return this.rules.find((rule) => rule.dataClass === dataClass && (!rule.pathPattern || paths.some((path) => safePattern(rule.pathPattern!, path))))
      ?? this.rules.find((rule) => rule.dataClass === dataClass && !rule.pathPattern)
      ?? this.rules.find((rule) => !rule.dataClass && rule.pathPattern && paths.some((path) => safePattern(rule.pathPattern!, path)))
      ?? this.rules.find((rule) => !rule.dataClass && !rule.pathPattern);
  }

  private validOverride(override: PendingOverride | undefined, request: ProviderRequest, classes: DataClass[]): boolean {
    return Boolean(override && !override.consumed && override.expiresAt > this.now() && override.provider === request.provider
      && override.providerBoundary === request.providerBoundary && override.requestFingerprint === fingerprint(request)
      && sameValues(override.classifications, classes));
  }

  private reason(request: ProviderRequest, classes: DataClass[], override: boolean): string {
    if (override) return 'explicit one-time override accepted for the exact provider, scope, and classification';
    if (this.mode === 'local-only' && request.providerBoundary !== 'local') return 'local-only mode blocks non-local provider or network boundary';
    if (this.mode === 'tee-only' && request.providerBoundary !== 'tee' && request.providerBoundary !== 'local') return 'TEE-only mode blocks models that NEAR forwards to another provider';
    return classes.length ? `policy evaluated classifications: ${classes.join(', ')}` : 'policy evaluated without findings';
  }
}

function fingerprint(request: ProviderRequest): string {
  return createHash('sha256').update(JSON.stringify({
    provider: request.provider,
    providerBoundary: request.providerBoundary,
    capability: request.capability,
    workspaceRoot: request.workspaceRoot,
    paths: normalizePaths(request.paths ?? []),
    attachmentIds: [...new Set(request.attachmentIds ?? [])].sort(),
    rawContentAuthorized: request.rawContentAuthorized === true,
    approvalFingerprint: request.approvalFingerprint ?? '',
    context: request.context ?? '',
    scope: request.scope ?? ''
  })).digest('hex');
}

function normalizePaths(paths: string[]): string[] { return [...new Set(paths.map((path) => path.replaceAll('\\', '/').trim()).filter(Boolean))].sort(); }

function redactPreview(value: string): string {
  const redacted = redactSecrets(value).replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gi, '[PRIVATE KEY REDACTED]');
  return redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[PERSONAL DATA REDACTED]').replace(/private prompt|raw context|tool output|command\s*[:=].*/gi, '[SENSITIVE CONTENT REDACTED]').slice(0, 500);
}

function redactPath(path: string): string {
  if (NEAR_CREDENTIAL_PATH.test(path)) return '[NEAR CREDENTIAL PATH REDACTED]';
  return path.replace(/(^|\/)([^/]*)(\.pem|\.key|\.p12|\.pfx)$/i, '$1[PRIVATE FILE REDACTED]$3');
}

function safePattern(pattern: string, value: string): boolean { try { return new RegExp(pattern, 'i').test(value); } catch { return false; } }
function sameValues(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

/** Read-only containment helper used by callers before presenting a path to preflight. */
export function isWorkspacePath(workspaceRoot: string, candidate: string): boolean {
  if (!workspaceRoot || !candidate || candidate.includes('\0') || isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) return false;
  try {
    const root = realpathSync(resolve(workspaceRoot));
    const resolved = realpathSync(resolve(root, candidate));
    const relativePath = relative(root, resolved);
    return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath) && lstatSync(resolved).isFile();
  } catch { return false; }
}


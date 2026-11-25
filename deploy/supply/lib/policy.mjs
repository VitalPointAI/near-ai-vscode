// The intake's policy (48.3-01; D-02, D-03, D-04, D-16): what each gate decides about one artefact, from facts the two intake stages collected.
// Pure: node:crypto only, no network, no tools, no files; `now` (a Date) is always passed in.
//
// The facts shape (later plans fill it; a new field comes with a test in deploy/test/supply-policy.test.mjs, never silently):
//   ecosystem           'npm' | 'image' | 'go' | 'maven' | 'pypi' | 'rpm' (other OCI kinds such as 'chart', 'tool', 'database' are gated as images)
//   name, version, purl the artefact's identity (purl for package ecosystems; an image's digest is its integrity)
//   integrity           what the bytes hash to (npm: the tarball's sha512 SRI; OCI: the digest; others: sha256:<hex> or the Go h1: sum)
//   integrityExpected   what upstream says they hash to (npm: the packument's dist.integrity; Go: go.sum; PyPI: the requirements hash);
//                       absent when only the hash recorded at intake exists (Maven, G520)
//   registrySignature   'valid' | 'invalid' | 'missing': npm's registry signature against npm's pinned keys (required for npm); an RPM's GPG
//                       signature; absent where the ecosystem has none
//   publishedAt         ISO time upstream published the version (absent for an image without a creation date)
//   gatheredAt          ISO time the gather host fetched it (the age falls back to it, with the digest pinned)
//   scripts             the tarball package.json's `scripts` (npm); hasInstallScript: the packument's flag
//   licence             the SPDX expression (string) or null; separateComponent: true when the component is unmodified and loaded separately
//   approvedNames       names approved before in this ecosystem (the name gates compare against them and the policy's popular list)
//   publisher           the account that published this version; previous: { publisher, provenance (boolean), repository } of the
//                       previous approved version, or null for a new name
//   provenance          { present, verified, repository } of this version (verified on the gather host only, G524)
//   mal                 OSV MAL- ids matched on the signing host
//   findings            [{ id, severity, kev, fixAvailable }] from Grype on the SBOM
//   source              { kind: 'registry' | 'git' | 'http' | 'file', url }
//   fastLane            { reason (the advisory id the version fixes), requestedBy (a Keycloak subject) } for a younger version asked for early
//
// The result: { outcome: 'checks-passed' | 'waiting' | 'in-review' | 'refused', flags, approversNeeded, releaseAt?, refusedBy?, licence?, fastLane? }.
import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;
const NPM_NAME_LIMIT = 214;
const NAME_LIMIT = 255;
const EXPRESSION_LIMIT = 1000;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
const FINDING_CATEGORIES = {
  kev: (f) => f.kev === true,
  'critical-with-fix': (f) => severity(f) === 'critical' && f.fixAvailable === true,
  critical: (f) => severity(f) === 'critical',
  'high-with-fix': (f) => severity(f) === 'high' && f.fixAvailable === true,
  high: (f) => severity(f) === 'high',
  medium: (f) => severity(f) === 'medium',
};
const severity = (finding) => String(finding.severity ?? '').toLowerCase();

/** JSON with every object's keys sorted, so the same policy always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The SHA-256 (hex) of the policy's canonical JSON; the promotion record carries it. */
export function policyHash(policy) {
  return createHash('sha256').update(canonical(policy)).digest('hex');
}

// --- Licences (D-04) ---------------------------------------------------------------------------------------------------------------------

function tokenize(text) {
  const tokens = [];
  const pattern = /\s*(\(|\)|[A-Za-z0-9.+:-]+)\s*/y;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) tokens.push(match[1]);
  if (pattern.lastIndex !== text.length && text.trim() !== '') return null;
  return tokens;
}

/** Parses an SPDX expression into a tree; throws on anything malformed (the caller turns that into "unparseable"). */
function parse(tokens) {
  let at = 0;
  const peek = () => tokens[at]?.toUpperCase();
  const isOperator = (t) => ['AND', 'OR', 'WITH'].includes(t?.toUpperCase());
  const atom = () => {
    if (tokens[at] === '(') {
      at += 1;
      const inner = or();
      if (tokens[at] !== ')') throw new Error('unbalanced');
      at += 1;
      return inner;
    }
    const id = tokens[at];
    if (id === undefined || id === ')' || isOperator(id)) throw new Error('expected a licence');
    at += 1;
    if (peek() === 'WITH') {
      at += 1;
      const exception = tokens[at];
      if (exception === undefined || exception === '(' || exception === ')' || isOperator(exception)) throw new Error('expected an exception');
      at += 1;
      return { id, exception };
    }
    return { id };
  };
  const and = () => {
    const parts = [atom()];
    while (peek() === 'AND') { at += 1; parts.push(atom()); }
    return parts.length === 1 ? parts[0] : { and: parts };
  };
  const or = () => {
    const parts = [and()];
    while (peek() === 'OR') { at += 1; parts.push(and()); }
    return parts.length === 1 ? parts[0] : { or: parts };
  };
  const tree = or();
  if (at !== tokens.length) throw new Error('trailing tokens');
  return tree;
}

/**
 * Whether an SPDX expression passes D-04's list: 'pass', 'review' or 'unparseable'. Every branch of an AND must pass and one branch of an OR;
 * a `WITH` exception passes when the licence before it does; the separate-component list passes only with `separateComponent: true`.
 */
export function licenceAllowed(expression, policy, { separateComponent = false } = {}) {
  if (typeof expression !== 'string' || expression.trim() === '' || expression.length > EXPRESSION_LIMIT) return 'review';
  const allow = new Set(policy.licences.allow.map((l) => l.toLowerCase()));
  const separate = new Set((policy.licences.separateComponent ?? []).map((l) => l.toLowerCase()));
  const tokens = tokenize(expression);
  if (!tokens) return 'unparseable';
  let tree;
  try { tree = parse(tokens); } catch { return 'unparseable'; }
  const passes = (node) => {
    if (node.and) return node.and.every(passes);
    if (node.or) return node.or.some(passes);
    const id = node.id.toLowerCase();
    return allow.has(id) || (separateComponent && separate.has(id));
  };
  return passes(tree) ? 'pass' : 'review';
}

// --- Names --------------------------------------------------------------------------------------------------------------------------------

const bareName = (name) => (name.startsWith('@') && name.includes('/') ? name.slice(name.indexOf('/') + 1) : name);

/** Levenshtein distance, giving up (returning limit + 1) once it must exceed `limit`. */
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

function nameFlags(facts, policy) {
  const flags = [];
  const approved = facts.approvedNames ?? [];
  if (approved.includes(facts.name)) return flags;
  flags.push('new-name');
  const known = new Set([...approved, ...(facts.ecosystem === 'npm' ? policy.nameSimilarity.popular : [])]);
  known.delete(facts.name);
  const bare = bareName(facts.name);
  const max = policy.nameSimilarity.maxDistance;
  let similar = false;
  let scope = false;
  for (const other of known) {
    const d = distance(bare, bareName(other), max);
    if (d === 0 && facts.ecosystem === 'npm') scope = true;
    else if (d >= 1 && d <= max) similar = true;
  }
  if (similar) flags.push('similar-name');
  if (scope) flags.push('scope-mismatch');
  return flags;
}

// --- The gates (D-16) ---------------------------------------------------------------------------------------------------------------------

const refused = (refusedBy, extra = {}) => ({ outcome: 'refused', flags: [], approversNeeded: 0, refusedBy, ...extra });

function hostOf(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.hostname : null; } catch { return null; }
}

/** The first hard gate the facts fail, or null (D-16's order: name, integrity and signature, malware, vulnerabilities, source form). */
function refusal(facts, policy) {
  const limit = facts.ecosystem === 'npm' ? NPM_NAME_LIMIT : NAME_LIMIT;
  if (typeof facts.name !== 'string' || facts.name.length === 0 || facts.name.length > limit) return 'name';
  if (facts.ecosystem === 'npm' && (!facts.integrity || !facts.integrityExpected)) return 'integrity';
  if (facts.integrityExpected != null && facts.integrity !== facts.integrityExpected) return 'integrity';
  if (facts.ecosystem === 'npm' && facts.registrySignature !== 'valid') return 'registry-signature';
  if (facts.registrySignature != null && facts.registrySignature !== 'valid') return 'registry-signature';
  if ((facts.mal ?? []).length > 0) return 'malware';
  for (const category of policy.vulnerabilities.refuse) {
    if ((facts.findings ?? []).some(FINDING_CATEGORIES[category])) return category;
  }
  const source = facts.source ?? {};
  if (source.kind !== 'registry') return 'source-form';
  const hosts = policy.registryHosts?.[facts.ecosystem];
  if (hosts && !hosts.includes(hostOf(source.url))) return 'source-form';
  return null;
}

/** What the policy decides for one artefact (see the result shape at the top of this file). */
export function evaluate(facts, policy, now) {
  const isImage = !['npm', 'go', 'maven', 'pypi', 'rpm'].includes(facts.ecosystem);
  const licence = isImage ? 'recorded' : licenceAllowed(facts.licence, policy, { separateComponent: facts.separateComponent === true });
  const hard = refusal(facts, policy);
  if (hard) return refused(hard, { licence });

  const since = Date.parse(facts.publishedAt ?? facts.gatheredAt ?? '');
  if (Number.isNaN(since)) return refused('age', { licence });
  const releaseAt = new Date(since + policy.minAgeDays * DAY_MS).toISOString();
  const flags = [];
  let fastLane;
  if (now.getTime() < Date.parse(releaseAt)) {
    const reason = typeof facts.fastLane?.reason === 'string' ? facts.fastLane.reason.trim() : '';
    if (!reason) return { outcome: 'waiting', flags: [], approversNeeded: 0, releaseAt, licence };
    flags.push('fast-lane');
    fastLane = { reason, requestedBy: facts.fastLane.requestedBy ?? null };
  }

  flags.push(...nameFlags(facts, policy));
  const scripts = facts.scripts ?? {};
  if (facts.hasInstallScript === true || INSTALL_SCRIPTS.some((s) => Object.hasOwn(scripts, s))) flags.push('install-script');
  if (licence !== 'pass' && licence !== 'recorded') flags.push('licence');
  const previous = facts.previous ?? null;
  const provenance = facts.provenance ?? {};
  if (previous?.provenance === true && provenance.present !== true) flags.push('provenance-regression');
  if (provenance.present === true && provenance.verified !== true) flags.push('provenance-unverified');
  if (provenance.present === true && previous?.repository && provenance.repository && provenance.repository !== previous.repository) flags.push('repository-changed');
  if (previous?.publisher && facts.publisher && facts.publisher !== previous.publisher) flags.push('publisher-change');
  for (const category of policy.vulnerabilities.review) {
    if ((facts.findings ?? []).some(FINDING_CATEGORIES[category])) flags.push(`${category}-finding`);
  }

  const needs = (flag) => (flag === 'install-script' ? policy.approvers.installScript : flag === 'fast-lane' ? policy.fastLane.approvers : policy.approvers.flagged);
  const approversNeeded = flags.reduce((most, flag) => Math.max(most, needs(flag)), 0);
  const result = { outcome: flags.length > 0 ? 'in-review' : 'checks-passed', flags, approversNeeded, licence };
  if (fastLane) Object.assign(result, { fastLane, releaseAt });
  return result;
}

// --- Your organization's site policy (tighten only) ----------------------------------------------------------------------------------------

const PREFIX = "Your organization's supply policy may only tighten the defaults:";
const looser = (field, value, dflt) => new Error(`${PREFIX} ${field} ${value} is looser than ${dflt}.`);

function wholeNumber(field, value) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${PREFIX} ${field} must be a whole number, not ${JSON.stringify(value)}.`);
  return value;
}
const atLeast = (field, value, dflt) => { if (wholeNumber(field, value) < dflt) throw looser(field, value, dflt); return value; };
const atMost = (field, value, dflt) => { if (wholeNumber(field, value) > dflt || value < 1) throw looser(field, value, dflt); return value; };
function subset(field, value, dflt) {
  if (!Array.isArray(value)) throw new Error(`${PREFIX} ${field} must be a list.`);
  const extra = value.find((v) => !dflt.includes(v));
  if (extra !== undefined) throw looser(field, extra, 'the default list');
  return [...value];
}
function knownCategories(field, value) {
  if (!Array.isArray(value)) throw new Error(`${PREFIX} ${field} must be a list.`);
  const unknown = value.find((v) => !Object.hasOwn(FINDING_CATEGORIES, v));
  if (unknown !== undefined) throw new Error(`${PREFIX} ${field} ${unknown} is not a finding category (${Object.keys(FINDING_CATEGORIES).join(', ')}).`);
  return [...value];
}
function onlyKeys(field, value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${PREFIX} ${field} must be a mapping.`);
  const extra = Object.keys(value).find((k) => !keys.includes(k));
  if (extra !== undefined) throw new Error(`${PREFIX} ${field ? `${field}.` : ''}${extra} cannot be set by your organization.`);
}

/** The defaults with your organization's site policy (`supply.policy`) applied; any looser value throws a plain message. */
export function mergePolicy(defaults, site) {
  const merged = structuredClone(defaults);
  if (site === undefined || site === null) return merged;
  onlyKeys('', site, ['minAgeDays', 'fastLane', 'approvers', 'licences', 'vulnerabilities', 'review', 'nameSimilarity', 'registryHosts']);
  if (site.minAgeDays !== undefined) merged.minAgeDays = atLeast('minAgeDays', site.minAgeDays, defaults.minAgeDays);
  if (site.fastLane !== undefined) {
    onlyKeys('fastLane', site.fastLane, ['approvers', 'needsReason']);
    if (site.fastLane.approvers !== undefined) merged.fastLane.approvers = atLeast('fastLane.approvers', site.fastLane.approvers, defaults.fastLane.approvers);
    if (site.fastLane.needsReason !== undefined) {
      if (site.fastLane.needsReason !== true && defaults.fastLane.needsReason === true) throw looser('fastLane.needsReason', site.fastLane.needsReason, true);
      merged.fastLane.needsReason = site.fastLane.needsReason;
    }
  }
  if (site.approvers !== undefined) {
    onlyKeys('approvers', site.approvers, ['flagged', 'installScript']);
    for (const key of ['flagged', 'installScript']) {
      if (site.approvers[key] !== undefined) merged.approvers[key] = atLeast(`approvers.${key}`, site.approvers[key], defaults.approvers[key]);
    }
  }
  if (site.licences !== undefined) {
    onlyKeys('licences', site.licences, ['allow', 'separateComponent']);
    if (site.licences.allow !== undefined) merged.licences.allow = subset('licences.allow', site.licences.allow, defaults.licences.allow);
    if (site.licences.separateComponent !== undefined) {
      merged.licences.separateComponent = subset('licences.separateComponent', site.licences.separateComponent, defaults.licences.separateComponent);
    }
  }
  if (site.vulnerabilities !== undefined) {
    onlyKeys('vulnerabilities', site.vulnerabilities, ['refuse', 'review']);
    const refuse = site.vulnerabilities.refuse === undefined ? defaults.vulnerabilities.refuse : knownCategories('vulnerabilities.refuse', site.vulnerabilities.refuse);
    const review = site.vulnerabilities.review === undefined ? defaults.vulnerabilities.review : knownCategories('vulnerabilities.review', site.vulnerabilities.review);
    const dropped = defaults.vulnerabilities.refuse.find((c) => !refuse.includes(c));
    if (dropped) throw looser('vulnerabilities.refuse', `without ${dropped}`, defaults.vulnerabilities.refuse.join(', '));
    const unreviewed = defaults.vulnerabilities.review.find((c) => !review.includes(c) && !refuse.includes(c));
    if (unreviewed) throw looser('vulnerabilities.review', `without ${unreviewed}`, defaults.vulnerabilities.review.join(', '));
    merged.vulnerabilities = { refuse: [...refuse], review: [...review] };
  }
  if (site.review !== undefined) {
    onlyKeys('review', site.review, ['dueWorkingDays', 'urgentDueWorkingDays']);
    for (const key of ['dueWorkingDays', 'urgentDueWorkingDays']) {
      if (site.review[key] !== undefined) merged.review[key] = atMost(`review.${key}`, site.review[key], defaults.review[key]);
    }
  }
  if (site.nameSimilarity !== undefined) {
    onlyKeys('nameSimilarity', site.nameSimilarity, ['maxDistance', 'popular']);
    if (site.nameSimilarity.maxDistance !== undefined) {
      merged.nameSimilarity.maxDistance = atLeast('nameSimilarity.maxDistance', site.nameSimilarity.maxDistance, defaults.nameSimilarity.maxDistance);
    }
    if (site.nameSimilarity.popular !== undefined) {
      if (!Array.isArray(site.nameSimilarity.popular)) throw new Error(`${PREFIX} nameSimilarity.popular must be a list.`);
      merged.nameSimilarity.popular = [...new Set([...defaults.nameSimilarity.popular, ...site.nameSimilarity.popular])];
    }
  }
  if (site.registryHosts !== undefined) {
    onlyKeys('registryHosts', site.registryHosts, Object.keys(defaults.registryHosts ?? {}));
    for (const [ecosystem, hosts] of Object.entries(site.registryHosts)) {
      merged.registryHosts[ecosystem] = subset(`registryHosts.${ecosystem}`, hosts, defaults.registryHosts[ecosystem]);
    }
  }
  return merged;
}

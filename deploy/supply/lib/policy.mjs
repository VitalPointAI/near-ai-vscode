// The intake's policy (48.3-01; D-02, D-03, D-04, D-16): what each gate decides about one artefact, from facts the two intake stages collected.
// Pure: node:crypto only, no network, no tools, no files; `now` is always passed in.
//
// The facts shape (later plans fill it; a new field comes with a test in deploy/test/supply-policy.test.mjs):
//   ecosystem           'npm' | 'image' | 'go' | 'maven' | 'pypi' | 'rpm' (or another OCI kind: 'chart', 'tool', 'database')
//   name, version, purl the artefact's identity (purl for package ecosystems; images use name and the digest in integrity)
//   integrity           what the bytes hash to (npm: the tarball's sha512 SRI; OCI: the digest; others: sha256:<hex>)
//   integrityExpected   what upstream says they hash to (npm: the packument's dist.integrity); absent when only a recorded hash exists
//   registrySignature   'valid' | 'invalid' | 'missing' (npm: the registry signature against npm's pinned keys; others when they have one)
//   publishedAt         ISO time upstream published the version (absent for an image without a creation date)
//   gatheredAt          ISO time the gather host fetched it (the age falls back to it)
import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;

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

/** What the policy decides for one artefact: { outcome, flags, approversNeeded, releaseAt?, refusedBy? }. */
export function evaluate(facts, policy, now) {
  const since = Date.parse(facts.publishedAt ?? facts.gatheredAt);
  const releaseAt = new Date(since + policy.minAgeDays * DAY_MS);
  if (now.getTime() < releaseAt.getTime()) return { outcome: 'waiting', flags: [], approversNeeded: 0, releaseAt: releaseAt.toISOString() };
  return { outcome: 'checks-passed', flags: [], approversNeeded: 0 };
}


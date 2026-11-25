// What another site's user import reads, from that site's own signed evidence (47-21; 47 D-69, 32.1 D-62, 32.1 D-67). Before a user export
// names a guest, users.mjs checks that the target site's newest signed site evidence export says its import reads guests@1; without that the
// export writes nothing, so a guest never reaches a site that would make them an ordinary member (T-47-125).
//
// The envelope check is a copy of compliance/src/signed.ts (verifyEnvelope and what it needs), because the offline bundle packs deploy/ only;
// deploy/test/federation.test.mjs checks that both accept and refuse the same envelopes. An export counts only when it verifies for purpose
// site-evidence-export with the target site's own listed key, names that site, was generated at its signing time, is at most 7 days old and is
// schema 2 (48-11, 48 D-28) with facts.sterling.reads. Only facts.sterling is read; the deployment collector judges the rest. Until a site's
// install records reads.users (47-32) and its export carries it (48-11), the site counts as not reading guests, which is the safe side.
// Node built-ins only.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const PAYLOAD_DOMAIN = 'near-ai-vscode/signed-payload/v1';
export const PAYLOAD_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_DEPTH = 16;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const SITE_EXPORT_PURPOSE = 'site-evidence-export';
/** The schema of a site export that carries the site's release and what it reads (48-11). */
export const SITE_EXPORT_SCHEMA_WITH_RELEASE = 2;
/** The deployment collector's window: an older export says nothing about the site today (32.1 D-62, V2). */
export const SITE_EVIDENCE_MAX_AGE_DAYS = 7;
/** A site id (48-02's SITE_ID). */
export const SITE_ID = /^[a-z0-9][a-z0-9._/@:-]{0,127}$/;
const FEATURE_ID = /^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;
const MAX_FILE_BYTES = 2 * MAX_PAYLOAD_BYTES;
const DAY_MS = 86_400_000;

function write(value, depth) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (Object.is(value, -0) || !Number.isSafeInteger(value)) throw new Error('not canonical');
      return String(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new Error('not canonical');
      return JSON.stringify(value);
    case 'object': {
      if (depth + 1 > MAX_DEPTH) throw new Error('not canonical');
      if (Array.isArray(value)) {
        const parts = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) throw new Error('not canonical');
          parts.push(write(value[index], depth + 1));
        }
        return `[${parts.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error('not canonical');
      const parts = [];
      for (const key of Object.keys(value).sort()) {
        if (LONE_SURROGATE.test(key) || value[key] === undefined) throw new Error('not canonical');
        parts.push(`${JSON.stringify(key)}:${write(value[key], depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default: throw new Error('not canonical');
  }
}
/** Canonical JSON as the extension signs it: sorted keys, no whitespace, whole numbers only. */
export const canonicalize = (value) => write(value, 0);
export const fingerprintOf = (rawPublicKey) => `dev-${createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 32)}`;
function isStrictBase64url(value, byteLength) {
  if (typeof value !== 'string' || value.length !== Math.ceil((byteLength * 4) / 3) || !BASE64URL_ALPHABET.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === byteLength && decoded.toString('base64url') === value;
}
const signingInput = (purpose, { sig: _sig, ...rest }) => Buffer.concat([Buffer.from(`${PAYLOAD_DOMAIN}\n${purpose}\n`, 'utf8'), Buffer.from(canonicalize(rest), 'utf8')]);
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

/** verifyEnvelope of compliance/src/signed.ts: { ok: true, payload, signer, signedAt } or { ok: false, reason }. Never throws. */
export function verifyEnvelope(envelope, { purpose: expected, keys, now, maxBytes = MAX_PAYLOAD_BYTES }) {
  const refuse = (reason) => ({ ok: false, reason });
  try {
    let text;
    try { text = canonicalize(envelope); } catch { return refuse('malformed'); }
    const parsed = JSON.parse(text);
    if (!record(parsed)) return refuse('malformed');
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v !== PAYLOAD_VERSION) return refuse('unsupported-version');
    if (parsed.v !== PAYLOAD_VERSION || !exactKeys(parsed, ['v', 'purpose', 'signer', 'signedAt', 'payload', 'sig'])) return refuse('malformed');
    const { purpose, signer, signedAt, payload, sig } = parsed;
    if (typeof purpose !== 'string' || typeof signedAt !== 'string' || typeof sig !== 'string') return refuse('malformed');
    if (!record(signer) || !exactKeys(signer, ['fingerprint', 'publicKey'], ['memberId'])) return refuse('malformed');
    if (typeof signer.fingerprint !== 'string' || typeof signer.publicKey !== 'string' || (signer.memberId !== undefined && typeof signer.memberId !== 'string')) return refuse('malformed');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return refuse('too-large');
    if (purpose !== expected) return refuse('wrong-purpose');
    if (!isStrictBase64url(signer.publicKey, PUBLIC_KEY_BYTES)) return refuse('malformed');
    if (fingerprintOf(Buffer.from(signer.publicKey, 'base64url')) !== signer.fingerprint) return refuse('key-mismatch');
    const at = Date.parse(signedAt);
    if (Number.isNaN(at) || new Date(at).toISOString() !== signedAt) return refuse('malformed');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return refuse('malformed');
    if (at > now.getTime() + FUTURE_TOLERANCE_MS) return refuse('signed-in-future');
    let valid = false;
    try {
      valid = isStrictBase64url(sig, SIGNATURE_BYTES) && edVerify(null, signingInput(purpose, parsed),
        createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(signer.publicKey, 'base64url')]), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64url'));
    } catch { valid = false; }
    if (!valid) return refuse('bad-signature');
    const trusted = keys.find((key) => key.fingerprint === signer.fingerprint && key.publicKey === signer.publicKey);
    if (!trusted) return refuse('unknown-key');
    return { ok: true, payload, signer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey }, signedAt };
  } catch {
    return refuse('malformed');
  }
}

/** Your organization's sites file (32.1 D-62): { sites: [{ id, name, role, publicKey, fingerprint }] }. Returns the sites or throws a sentence. */
export function parseSitesFile(value) {
  const sites = record(value) && exactKeys(value, ['sites']) && Array.isArray(value.sites) ? value.sites : null;
  if (!sites) throw new Error('The sites file must be { "sites": [...] }, each site with id, name, role, publicKey and fingerprint.');
  const ids = new Set();
  const keys = new Set();
  for (const site of sites) {
    if (!record(site) || !exactKeys(site, ['id', 'name', 'role', 'publicKey', 'fingerprint']) || !SITE_ID.test(String(site.id))) throw new Error(`The sites file has an entry that is not a site: ${JSON.stringify(site).slice(0, 120)}.`);
    if (!isStrictBase64url(site.publicKey, PUBLIC_KEY_BYTES) || fingerprintOf(Buffer.from(site.publicKey, 'base64url')) !== site.fingerprint) throw new Error(`The fingerprint of site ${site.id} does not match its key in the sites file.`);
    if (ids.has(site.id) || keys.has(site.fingerprint)) throw new Error(`Site ${site.id} or its key is listed twice in the sites file.`);
    ids.add(site.id);
    keys.add(site.fingerprint);
  }
  return sites;
}

/**
 * The target site's newest export that counts (see the top of this file) from every *.json in the exports folder: { release, reads } with
 * reads the export's facts.sterling.reads, or { refusal } with one sentence naming the site and what it lacks.
 */
export function newestSiteEvidence({ site, sites, exportsDir, now = Date.now() }) {
  const entry = sites.find((candidate) => candidate.id === site);
  if (!entry) return { refusal: `${site} is not in your sites file, so its signed evidence cannot be checked.` };
  const keys = [{ fingerprint: entry.fingerprint, publicKey: entry.publicKey }];
  let newest = null;
  for (const name of readdirSync(exportsDir).filter((file) => file.endsWith('.json')).sort()) {
    const file = path.join(exportsDir, name);
    if (statSync(file).size > MAX_FILE_BYTES) continue;
    let envelope;
    try { envelope = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const verdict = verifyEnvelope(envelope, { purpose: SITE_EXPORT_PURPOSE, keys, now: new Date(now) });
    if (!verdict.ok || !record(verdict.payload) || verdict.payload.site !== site || verdict.payload.generatedAt !== verdict.signedAt) continue;
    if (Date.parse(verdict.signedAt) < now - SITE_EVIDENCE_MAX_AGE_DAYS * DAY_MS) continue;
    if (!newest || Date.parse(verdict.signedAt) > Date.parse(newest.signedAt)) newest = verdict;
  }
  if (!newest) return { refusal: `${site} has no signed evidence export from the last ${SITE_EVIDENCE_MAX_AGE_DAYS} days, so what its user import reads is unknown. Ask its administrator for a fresh site evidence export.` };
  const sterling = newest.payload.facts?.sterling;
  if (newest.payload.schema !== SITE_EXPORT_SCHEMA_WITH_RELEASE || !record(sterling) || typeof sterling.release !== 'string' || !record(sterling.reads)) {
    return { refusal: `${site}'s newest export does not say which release it runs or what it reads (it is schema ${JSON.stringify(newest.payload.schema)}), so its user import counts as not reading guest records. Ask its administrator to update the site and send a fresh export.` };
  }
  const reads = Object.fromEntries(Object.entries(sterling.reads).map(([format, ids]) => [format, Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && FEATURE_ID.test(id)) : []]));
  return { release: sterling.release, reads, signedAt: newest.signedAt };
}

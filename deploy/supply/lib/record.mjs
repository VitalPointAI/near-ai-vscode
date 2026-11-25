// The promotion record (48.3-05; D-17): what an approval says, as an in-toto statement whose predicate is `sterling-supply-record/1`. The
// signature over it is made and checked by cosign (key mode with a file key, or the site key in the HSM through the attach path spike S-A
// recorded in 48.3-02-SUMMARY.md); this module only builds the content and checks it after cosign has verified the signature. Node built-ins
// only, no network.
import { sufficient } from './approvals.mjs';

export const PREDICATE_TYPE = 'urn:near-ai-vscode:supply-record:1';
export const FORMAT = 'sterling-supply-record/1';
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
/** How far in the future a record or database time may be before the record is refused (clock skew between hosts). */
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const SHA256 = /^sha256:([0-9a-f]{64})$/;

/** The in-toto digest set for an OCI digest (sha256:<hex>) or an SRI integrity (sha512-<base64>). */
function digestSet(subject) {
  const oci = SHA256.exec(subject.digest ?? subject.integrity ?? '');
  if (oci) return { sha256: oci[1] };
  const sri = /^sha512-([A-Za-z0-9+/=]+)$/.exec(subject.integrity ?? '');
  if (sri) return { sha512: Buffer.from(sri[1], 'base64').toString('hex') };
  throw new Error(`A record's subject needs an OCI digest (sha256:<hex>) or an integrity (sha512-<base64>), not ${JSON.stringify(subject.digest ?? subject.integrity)}.`);
}

/**
 * The statement for one artefact. `subject` is { name, digest } for OCI content, or { name, purl, integrity } for a package; the other fields
 * are D-17's: origin { host, country }, gates [{ gate, result, evidence }], state, approvals [{ subject, entity, at }], requester,
 * policySha256, grypeDb { built, schemaVersion, checksum }, osvDb { date }, recordedAt. The predicate's keys are always in this order.
 */
export function buildStatement(input) {
  const { subject } = input;
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: subject.name, digest: digestSet(subject) }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      format: FORMAT,
      subject: { name: subject.name, ...(subject.digest ? { digest: subject.digest } : {}), ...(subject.purl ? { purl: subject.purl } : {}), ...(subject.integrity ? { integrity: subject.integrity } : {}) },
      origin: { host: input.origin?.host ?? 'unknown', country: input.origin?.country ?? 'unknown' },
      gates: (input.gates ?? []).map((gate) => ({ ...gate })),
      state: input.state,
      approvals: (input.approvals ?? []).map((approval) => ({ subject: approval.subject, entity: approval.entity, at: approval.at })),
      requester: input.requester ?? null,
      policySha256: input.policySha256,
      databases: {
        grype: { built: input.grypeDb?.built ?? null, schemaVersion: input.grypeDb?.schemaVersion ?? null, checksum: input.grypeDb?.checksum ?? null },
        osv: { date: input.osvDb?.date ?? null },
      },
      recordedAt: input.recordedAt,
    },
  };
}

const future = (value, now) => typeof value === 'string' && Date.parse(value) > now.getTime() + FUTURE_SLACK_MS;

/**
 * Checks a record's content against what the caller knows: { digest } (or { purl, integrity }), the listed approvers, approversNeeded, now,
 * and optionally requester and fastLane. Returns { ok, problems } with plain sentences; never throws on bad input.
 */
export function checkRecord(statement, expected) {
  const problems = [];
  try {
    if (!statement || typeof statement !== 'object') return { ok: false, problems: ['This is not a record.'] };
    if (statement.predicateType !== PREDICATE_TYPE) problems.push(`This statement is a ${JSON.stringify(statement.predicateType)}, not a supply record.`);
    const predicate = statement.predicate ?? {};
    if (predicate.format !== FORMAT) problems.push(`The record's format is ${JSON.stringify(predicate.format)}, not ${FORMAT}.`);
    const wanted = expected.digest ? digestSet({ digest: expected.digest }) : digestSet({ integrity: expected.integrity });
    const [algorithm, hex] = Object.entries(wanted)[0];
    const subjects = Array.isArray(statement.subject) ? statement.subject : [];
    if (subjects.length !== 1 || subjects[0]?.digest?.[algorithm] !== hex) {
      const have = subjects[0]?.digest ?? {};
      const shown = have.sha256 ? `sha256:${have.sha256}` : have.sha512 ? `sha512 ${have.sha512.slice(0, 16)}...` : 'no digest';
      problems.push(`This record is for ${shown}, not for ${expected.digest ?? expected.integrity}.`);
    }
    if (expected.purl && predicate.subject?.purl !== expected.purl) problems.push(`This record is for ${predicate.subject?.purl ?? 'no package'}, not for ${expected.purl}.`);
    if (predicate.state !== 'approved') problems.push(`The record says ${predicate.state}, not approved.`);
    const approvals = Array.isArray(predicate.approvals) ? predicate.approvals : [];
    problems.push(...sufficient(approvals, expected).problems);
    const now = expected.now;
    for (const [what, value] of [['recorded time', predicate.recordedAt], ['Grype database time', predicate.databases?.grype?.built], ...approvals.map((a) => [`approval time of ${a.subject}`, a.at])]) {
      if (future(value, now)) problems.push(`The record's ${what} (${value}) is in the future.`);
    }
    if (typeof predicate.policySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(predicate.policySha256)) problems.push('The record names no policy hash.');
  } catch (error) {
    problems.push(`The record could not be read: ${error.message}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The statements in `cosign download attestation` output: one JSON value per line, either a Sigstore bundle v0.3 (the referrer form, with
 * `dsseEnvelope`) or a bare DSSE envelope (the legacy tag form); each payload is a base64 in-toto statement. Throws on a line that is neither.
 */
export function parseCosignAttestations(text) {
  return String(text).split('\n').map((line, index) => [line.trim(), index + 1]).filter(([line]) => line !== '').map(([line, number]) => {
    try {
      const value = JSON.parse(line);
      const envelope = value.dsseEnvelope ?? value;
      if (envelope.payloadType !== 'application/vnd.in-toto+json' || typeof envelope.payload !== 'string') throw new Error('no in-toto payload');
      const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
      if (typeof statement.predicateType !== 'string' || !Array.isArray(statement.subject)) throw new Error('no statement');
      return statement;
    } catch {
      throw new Error(`line ${number} of the cosign output is not an attestation`);
    }
  });
}

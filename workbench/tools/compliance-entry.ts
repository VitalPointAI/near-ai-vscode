// The compliance engine the workbench backend calls (48.2-01, 48.2-04, 48.2-08): the status engine's judgement (rejudge, the freshness rules
// and the release evidence manifest check), the cosign key-mode Sigstore bundle verifier, and the site evidence verification, the same code
// the compliance package runs, bundled by tools/build-engine.mjs into engine/compliance.cjs and loaded by the evidence service on first use
// (D-11, D-19). The site collector (bin/collect-site-evidence.mjs, 48.2-09) builds and checks its live feed with the same exports.
// EXCHANGE_IDS is the release's own exchange register (compliance/hosted/exchanges.json), which site agreements must name.
import register from '../../compliance/hosted/exchanges.json' with { type: 'json' };

export * from '../../compliance/src/judgement.ts';
export { publicKeyFingerprint, verifySigstoreBundle } from '../../compliance/src/sigstoreBundle.ts';
export {
  attachLiveSignature, buildLiveFeed, collectorKeyVersion, liveSigningInput, parseLiveFeed, parseTrustDocument, SITE_LIVE_PURPOSE, verifySiteEvidence
} from '../../compliance/src/siteEvidence.ts';
export { readKyvernoPolicies, readPolicyReports } from '../../compliance/src/kyvernoImages.ts';
export { fingerprintOf, verifyEnvelope } from '../../compliance/src/signed.ts';

export const EXCHANGE_IDS: readonly string[] = Object.freeze((register as { exchanges: { id: string }[] }).exchanges.map(({ id }) => id));

// The compliance engine the workbench backend calls (48.2-01, 48.2-04, 48.2-08): the status engine's judgement (rejudge, the freshness rules
// and the release evidence manifest check), the cosign key-mode Sigstore bundle verifier, and the site evidence verification, the same code
// the compliance package runs, bundled by tools/build-engine.mjs into engine/compliance.cjs and loaded by the evidence service on first use
// (D-11, D-19). EXCHANGE_IDS is the release's own exchange register (compliance/hosted/exchanges.json), which site agreements must name.
import register from '../../compliance/hosted/exchanges.json' with { type: 'json' };

export * from '../../compliance/src/judgement.ts';
export { publicKeyFingerprint, verifySigstoreBundle } from '../../compliance/src/sigstoreBundle.ts';
export { verifySiteEvidence } from '../../compliance/src/siteEvidence.ts';

export const EXCHANGE_IDS: readonly string[] = Object.freeze((register as { exchanges: { id: string }[] }).exchanges.map(({ id }) => id));

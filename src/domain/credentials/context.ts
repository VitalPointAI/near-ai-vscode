// The two @context values every credential carries, in this order, and nothing else (Phase 71, D-05, VCRD-02; owner item 3). Pure, no import.
// Verification never fetches a context and no JSON-LD runs at run time: a credential is read by exact keys, so the context list is only compared.
// OUR_CONTEXT_DOCUMENT is what will be registered at the URL before the first real credential, and what tests' static document loaders serve to the
// reference library. Term names are permanent once a credential is issued (types.ts); the context only gains terms, a change of meaning is a new URL.

export const VC_V2_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
export const OUR_CONTEXT_URL = 'https://w3id.org/sterling/credentials/v1';
export const CREDENTIAL_CONTEXTS: readonly string[] = Object.freeze([VC_V2_CONTEXT, OUR_CONTEXT_URL]);

/** Where our terms are defined. A fragment namespace beside the context, so a term IRI is never confused with the context URL itself. */
export const OUR_VOCABULARY = 'https://w3id.org/sterling/credentials#';

/** Every type and claim name our credentials use, beyond what the VC 2.0 context already defines (types.ts holds the shapes). */
export const OUR_TERMS: readonly string[] = Object.freeze([
  'MembershipCredential', 'ClearanceCredential', 'CompartmentCredential', 'ServiceCredential', 'NationalityCredential', 'AffiliationCredential',
  'ExportEligibilityCredential', 'AccessAgreementCredential', 'VisitClearanceCredential', 'ObserverAccessCredential', 'IssuerRoleCredential',
  'SecurityContactCredential', 'ReleaseAuthorityCredential', 'ClassificationAuthorityCredential', 'RoleCredential', 'DeviceBindingCredential',
  'organization', 'scale', 'atLeast', 'compartment', 'serves', 'nationality', 'regime', 'basis', 'agreement', 'scope', 'request', 'site', 'from',
  'until', 'project', 'position', 'cells', 'credentialType', 'upTo', 'compartments', 'regimes', 'role', 'device', 'class', 'version'
]);

function contextDocument(): Readonly<Record<string, unknown>> {
  const terms: Record<string, unknown> = { '@protected': true };
  for (const term of OUR_TERMS) terms[term] = `${OUR_VOCABULARY}${term}`;
  return Object.freeze({ '@context': Object.freeze(terms) });
}

/** The frozen JSON-LD context document for OUR_CONTEXT_URL. */
export const OUR_CONTEXT_DOCUMENT: Readonly<Record<string, unknown>> = contextDocument();

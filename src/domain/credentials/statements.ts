// What SECURITY.md and README say about verified credentials (Phase 71, D-08, D-21, O11; 71-14). The docs carry these sentences word for word
// (gateDocs.test.ts), and each one says only what the code named beside it does. Plain short sentences, "your organization", no figures.

/** D-12, D-19: credentials@1 makes credentials the one source (gate/clearances.ts clearancesInForce, credentials/evidence.ts checkEvidence). */
export const CREDENTIALS_ONLY_SOURCE_TEXT =
  'When your organization\'s rules include credential rules, verified credentials are the only source of access attributes: clearance, compartments, nationality, export eligibility and how a person serves.';

/** D-18: the session backend and the hub read only who signed in (workbench token-facts.ts; the token-claims test). */
export const SIGN_IN_ONLY_TEXT =
  'Keycloak only signs people in. The session reads who signed in and how recently they confirmed it, and nothing else in a sign-in token grants access.';

/** D-07: a structural rule of the checker (credentials/issuerAuthority.ts). */
export const NEVER_ISSUE_TEXT =
  'Only people issue credentials: your organization\'s root, in an offline ceremony, and the officers it names, who sign with their own key after confirming with a passkey or security key. Agents and devices never issue.';

/** D-09: credentials/evidence.ts checkEvidence decides from cited data only. */
export const EVIDENCE_BY_HASH_TEXT =
  'A shared entry that relies on a credential cites it and the status lists it was checked against by hash, so every copy of the project reaches the same answer.';

/** D-11, D-18: credentials/freshness.ts checkFreshness at the hub (hub/src/append/evidencePep.ts) and staff/replica/keyRelease.ts in the session. */
export const FRESHNESS_AT_ACTION_TEXT =
  'Freshness is checked at the moment of action: by your organization\'s server when it stores an entry it can read, and by the session before it opens a part of a shared project.';

/** G426's third limit: the hub opens only a project's base part (hub/src/append/evidencePep.ts); other parts are checked by the fold on each reader. */
export const HUB_CHECKS_WHAT_IT_READS_TEXT =
  'Your organization\'s server can read only the base part of a shared project, so it checks cited evidence there. Entries in other parts are checked on the computers of the people who read them.';

/** O6: credentials/freshness.ts, an edge's per-level maximum offline age, counted from each list's own validFrom. */
export const MAX_OFFLINE_AGE_TEXT =
  'Your organization\'s rules set a maximum offline age for each level. Past it, a check at that level refuses until newer status lists arrive.';

/** Research pitfall 2: keys already on a computer stay there (staff/replica/keyring.ts). */
export const OFFLINE_TRUST_TEXT =
  'A computer that holds keys offline is trusted until its next contact with your organization\'s server. This is not a key access server: a key already on a computer cannot be taken back.';

/** D-21: the gate is a control against mistakes. */
export const NOT_ACCREDITATION_TEXT =
  'These checks help prevent mistakes. They do not accredit a computer, a person or a deployment.';

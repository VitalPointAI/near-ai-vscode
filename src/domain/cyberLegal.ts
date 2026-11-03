import type { DisclaimerAcceptance, ResolvedScope, Target } from './cyber';

// The legal gate's content (D-13..D-18, CYBER-03): twelve regional statements, region detection from
// the OS timezone, the re-acceptance rules, and the public-sector warning tier. The statements are
// plain-language summaries of what each law criminalizes and the own-or-authorized confirmation the
// user gives — they are not legal advice, and every one is flagged for owner review before release.

export type RegionCode = 'us' | 'uk' | 'eu' | 'ca' | 'au' | 'nz' | 'jp' | 'in' | 'br' | 'za' | 'sg' | 'ae';

export interface RegionEntry {
  code: RegionCode;
  name: string;
  statute: string;
  /** Plain-language summary shown in the modal. Not legal advice. */
  statement: string;
  /** The version of this statement text; a change forces re-acceptance (D-18). */
  textVersion: string;
  /** Owner review state; the flag is data so a release check can find any statement still pending. */
  ownerReview: 'pending-owner-review' | 'reviewed';
}

const TEXT_VERSION = '2026-11-02';
const REVIEWED = 'reviewed' as const;

const AUTHORIZED = 'You confirm that you own this target or are authorized in writing to test it, and that you will test only within the scope shown above.';

export const REGION_CATALOGUE: Record<RegionCode, RegionEntry> = {
  us: {
    code: 'us',
    name: 'United States',
    statute: '18 U.S.C. § 1030 — Computer Fraud and Abuse Act',
    statement: `Accessing a computer without authorization, or exceeding authorized access, is a federal crime under the Computer Fraud and Abuse Act. Penalties depend on the damage and the gain involved. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  uk: {
    code: 'uk',
    name: 'United Kingdom',
    statute: 'Computer Misuse Act 1990, section 1',
    statement: `Causing a computer to perform a function to secure access to a program or data without authorization is an offence under section 1 of the Computer Misuse Act 1990. Unauthorized modification is a further offence. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  eu: {
    code: 'eu',
    name: 'European Union',
    statute: 'Budapest Convention on Cybercrime, as implemented by national law',
    statement: `Each member state implements the Budapest Convention on Cybercrime in its own criminal law, and the national offence covers unauthorized access to a computer system. The applicable offence and penalty are those of the country where the system sits. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  ca: {
    code: 'ca',
    name: 'Canada',
    statute: 'Criminal Code, section 342.1',
    statement: `Section 342.1 of the Criminal Code makes unauthorized use of a computer an offence. Fraudulently obtaining computer services or data is an offence under the same section. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  au: {
    code: 'au',
    name: 'Australia',
    statute: 'Cybercrime Act 2001 (Cth)',
    statement: `The Cybercrime Act 2001 makes unauthorized access to, and unauthorized impairment of, computers and data a Commonwealth offence. State and territory laws add equivalent offences. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  nz: {
    code: 'nz',
    name: 'New Zealand',
    statute: 'Crimes Act 1961, sections 249-252 (crimes involving computers)',
    statement: `Sections 249 to 252 of the Crimes Act 1961 make accessing a computer system for a dishonest purpose an offence, and separately cover damaging or interfering with a computer system and making software for those purposes. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  jp: {
    code: 'jp',
    name: 'Japan',
    statute: 'Act on Prohibition of Unauthorized Computer Access (Act No. 128 of 1999)',
    statement: `The Act on Prohibition of Unauthorized Computer Access makes unauthorized access to a computer through a telecommunications line an offence, defined as gaining access by an identification code that does not belong to the user. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  in: {
    code: 'in',
    name: 'India',
    statute: 'Information Technology Act 2000, sections 43 and 66',
    statement: `Section 43 of the Information Technology Act 2000 covers unauthorized access, downloading, and damage to a computer resource; section 66 makes those acts criminal when done dishonestly or fraudulently. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  br: {
    code: 'br',
    name: 'Brazil',
    statute: 'Lei 12.737/2012, article 154-A of the Penal Code',
    statement: `Article 154-A of the Penal Code makes invading a computer device or system, connected or not, an offence, with a heavier penalty where the invasion causes loss or gains the invader an advantage. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  za: {
    code: 'za',
    name: 'South Africa',
    statute: 'Cybercrimes Act 19 of 2020',
    statement: `The Cybercrimes Act 19 of 2020 makes unlawful access to a computer system an offence, together with unlawful interception of data and unlawful acquisition, possession, or use of a password. It replaced the computer offences that had sat in Chapter 13 of the Electronic Communications and Transactions Act 25 of 2002. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  sg: {
    code: 'sg',
    name: 'Singapore',
    statute: 'Computer Misuse Act 1993 (Cap. 501)',
    statement: `The Computer Misuse Act makes unauthorized access to a computer an offence, and separately covers unauthorized modification and use. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  },
  ae: {
    code: 'ae',
    name: 'United Arab Emirates',
    statute: 'Federal Decree-Law No. 34 of 2021',
    statement: `Federal Decree-Law No. 34 of 2021 on combating rumours and cybercrimes makes unauthorized access to a computer network, system, or data an offence. ${AUTHORIZED}`,
    textVersion: TEXT_VERSION,
    ownerReview: REVIEWED
  }
};

export const REGION_CODES: RegionCode[] = ['us', 'uk', 'eu', 'ca', 'au', 'nz', 'jp', 'in', 'br', 'za', 'sg', 'ae'];

/** The entry for a region code, or undefined when the code is not one of the twelve. */
export function regionEntry(code: string): RegionEntry | undefined {
  return (REGION_CODES as string[]).includes(code) ? REGION_CATALOGUE[code as RegionCode] : undefined;
}

/** The copy above the legal-name field in the modal (D-17). */
export const LEGAL_NAME_PROMPT = 'Type the legal name of the person or organization accepting this authorization. It is recorded in the engagement and in every exported report.';

// ---- Region detection ---------------------------------------------------------------------------

/** Zones that are not covered by a broader prefix, or that buck the prefix's default region. */
const EXACT_ZONES: Record<string, RegionCode> = {
  'Europe/London': 'uk',
  'Europe/Belfast': 'uk',
  'Europe/Guernsey': 'uk',
  'Europe/Isle_of_Man': 'uk',
  'Europe/Jersey': 'uk',
  'Pacific/Auckland': 'nz',
  'Asia/Tokyo': 'jp',
  'Asia/Kolkata': 'in',
  'Asia/Calcutta': 'in',
  'America/Sao_Paulo': 'br',
  'Africa/Johannesburg': 'za',
  'Asia/Singapore': 'sg',
  'Asia/Dubai': 'ae'
};

/** A timezone prefix's default region; the exact table wins over these. */
const ZONE_PREFIXES: Array<[string, RegionCode]> = [
  ['Europe/', 'eu'],
  ['Australia/', 'au'],
  ['America/', 'us']
];

/** Timestamps in these zones are really the other regional codes' neighbours, but the default is safe. */
export const DEFAULT_REGION: RegionCode = 'us';

/**
 * Maps an IANA timezone to a region code. Detection is a convenience, never an authority: the panel
 * shows the result and always allows a visible override (D-14), and an unknown zone fails safe to us.
 */
export function detectRegion(timeZone: string | undefined): RegionCode {
  const zone = (timeZone ?? '').trim();
  if (EXACT_ZONES[zone]) return EXACT_ZONES[zone];
  for (const [prefix, code] of ZONE_PREFIXES) {
    if (zone.startsWith(prefix)) return code;
  }
  return DEFAULT_REGION;
}

// ---- Re-acceptance (D-18) -----------------------------------------------------------------------

/**
 * The fields a stored acceptance is compared against. `scope` is the fingerprint of the resolved
 * scope the acceptance covered, kept beside the record because the acceptance itself has no scope.
 */
export interface AcceptanceSnapshot {
  region: string;
  scope: string;
  extensionVersion: string;
  textVersion: string;
}

/** The stored acceptance plus the scope fingerprint it was accepted under. */
export interface AcceptanceRecord extends DisclaimerAcceptance {
  scope: string;
}

/** A stable, order-independent fingerprint of a resolved scope, so a change in any part is detected. */
export function scopeFingerprint(scope: ResolvedScope): string {
  const sorted = (values: string[]): string[] => [...values].map((value) => value.trim().toLowerCase()).sort();
  return JSON.stringify({
    hosts: sorted(scope.hosts),
    ports: [...scope.ports].sort((left, right) => left - right),
    paths: sorted(scope.paths),
    exclusions: sorted(scope.exclusions)
  });
}

/**
 * True when the stored acceptance may no longer be reused: the region, the target scope, the
 * extension version, or the statement text itself changed since it was accepted (D-18). Every run
 * revalidates, so a stale acceptance can never be replayed (T-25-08).
 */
export function needsReacceptance(stored: AcceptanceRecord, current: AcceptanceSnapshot): boolean {
  return stored.region !== current.region
    || stored.scope !== current.scope
    || stored.extensionVersion !== current.extensionVersion
    || stored.textVersion !== current.textVersion;
}

// ---- Public-sector warning tier (D-15) ----------------------------------------------------------

/** Suffixes that identify a public-sector or military host; matched on a dot boundary. */
const PUBLIC_SUFFIXES = ['.gov', '.mil', '.gov.uk', '.gov.au', '.gov.in'];

/** Cloud metadata; scanning it targets the cloud instance itself. */
const METADATA_HOST = '169.254.169.254';

/** Carrier-grade NAT space, 100.64.0.0/10; often infrastructure the user does not own. */
function inCarrierGradeNat(host: string): boolean {
  const octets = host.split('.');
  if (octets.length !== 4) return false;
  return octets[0] === '100' && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
}

/** The host part of a target value, without scheme, path, port, or userinfo. */
function hostOf(target: Target | string): string {
  const value = (typeof target === 'string' ? target : target.value).trim();
  if (!value) return '';
  const candidate = value.includes('://') ? value : `https://${value}`;
  try {
    return new URL(candidate).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/**
 * A red-flag warning for a public-sector, metadata, or carrier-NAT target, or undefined. It never
 * refuses: the user decides (D-15), so the return type is a message, never a decision (T-25-08's
 * counterpart on the legal side).
 */
export function publicSectorWarning(target: Target | string): string | undefined {
  const host = hostOf(target);
  if (!host) return undefined;
  if (host === METADATA_HOST) {
    return `${host} is a cloud metadata address; testing it addresses the cloud instance itself, not a public service.`;
  }
  if (inCarrierGradeNat(host)) {
    return `${host} is in carrier-grade NAT space (100.64.0.0/10); it may be infrastructure you do not own.`;
  }
  const suffix = PUBLIC_SUFFIXES.find((value) => host === value.slice(1) || host.endsWith(value));
  if (suffix) {
    return `${host} looks like a public-sector or military host (${suffix}); confirm you have written authorization before running.`;
  }
  return undefined;
}

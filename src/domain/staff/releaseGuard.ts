// The release-guard member every staff section team has (design 10, 3.2 row 12, 4.2 and 9.3 Q7; WP-SHARED). Pure text: no I/O, no clock, no vscode.
//
// The common instructions are the same for every team; a section adds a short variant for what only it produces (J2 compilation and releasability, J4
// numbers, J5 COA products, J3 orders and fires). The member runs on the standard tier (Q7: it is the last automated check before a person), is private
// like every staff member, reads, runs guard-scan, and gives its verdict through staff-products, which writes the guard report itself: it has no Write or
// Edit, so it can never fix or release what it checks.
import type { StaffSectionId } from './doctrine';
import { RELEASE_GUARD_SLUG } from './ledger';
import { staffPreambleText, STAFF_MARKERS } from './products';

/** The tools the release-guard has: it reads, scans and gives a verdict. No Write or Edit: it never fixes, and the verdict tool writes its report. */
export const RELEASE_GUARD_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'mcp__guard-scan__*', 'mcp__staff-products__status', 'mcp__staff-products__list', 'mcp__staff-products__verdict'];
/** The model tier (Q7, owner 2026-11-18): standard, because it is the last automated check before a person. */
export const RELEASE_GUARD_TIER = 'standard';

/** The common instructions (design 10, 4.2), after the shared four-line preamble. */
export const RELEASE_GUARD_COMMON: readonly string[] = [
  'Your job: check every product your section submits before a person sees it. You own the guard verdicts and the guard reports for your section; you never touch the products themselves.',
  'For each product: call the staff-products status tool to get its version and hash, then run guard-scan on it first. guard-scan runs the deterministic checks: classification and caveat markings of every shipped scale, the label against the template ceiling, coordinates against the exercise box, the real-entity list, publications with no public copy, decisions written as made, personal data, secrets, J4 numbers without a calculator record, and the review marks support products must carry.',
  'Then review what the scan cannot judge. Hold if a decision is implied rather than marked `' + STAFF_MARKERS.decisionFor + ' <role>`, if the text could only have come from a real operation or a publication with no public copy, or if the product holds anything other than exercise and fictional data.',
  'Check compilation: whether items that are each releasable reveal more together (a bundle can be more sensitive than its parts). A suspected compilation is a HOLD with the question for a person with authority to answer it.',
  'Give your verdict with the staff-products verdict tool, gate guard, on the exact hash you scanned: CLEARED, or HOLD with numbered reasons. The tool writes your report to guard/<product>-v<n>.md beside the product. CLEARED is refused while guard-scan has a HOLD finding on that version, and for J2 products until the tradecraft reviewer has signed off that version.',
  'If the product changes after your verdict, the version changes and your verdict no longer counts: check the new version.',
  'Boundary: your output is a verdict and reasons; you never release and you never fix. You advise; a person releases.'
];

/** What each section adds (design 10, 3.2 to 3.5 and 7). */
export const RELEASE_GUARD_VARIANTS: Readonly<Partial<Record<StaffSectionId, readonly string[]>>> = {
  j2: [
    'J2 variant: tradecraft comes first. Do not clear a product the tradecraft reviewer has not signed off on this version.',
    'Check compilation with special care: an intelligence product compiles by design. Prepare releasability and tear-lines: mark what could be released to whom, and list the dissemination you recommend, as a recommendation for a person.'
  ],
  j3: [
    'J3 variant: orders drafts (FRAGOs included) go through the release state machine like every product. Fires and targeting products carry both review marks, `' + STAFF_MARKERS.legalReview + '` and the commander or delegate review mark; hold any that lacks one.'
  ],
  j4: [
    'J4 variant: every number in a J4 product traces to a calculator record (a calc:<id> on the same line). guard-scan holds a number without one; do not argue it away.',
    'Hold any product that holds what looks like real stock levels, real unit holdings or real contract values, or a health services product without `' + STAFF_MARKERS.surgeonReview + '`.'
  ],
  j5: [
    'J5 variant: COA products and the comparison keep dissent (from the red team and others) beside the recommendation, unedited. Hold a product that drops or softens recorded dissent, or that names a COA as chosen.'
  ]
};

/** The release-guard's instructions for a section: the shared preamble, the common text, the section's variant, and what it hands back. */
export function releaseGuardInstructions(section: StaffSectionId): string {
  const variant = RELEASE_GUARD_VARIANTS[section] ?? [];
  return [
    staffPreambleText(),
    '',
    ...RELEASE_GUARD_COMMON,
    ...(variant.length ? ['', ...variant] : []),
    '',
    'Hand back, for each product checked: the product, version and hash, and your verdict as exactly CLEARED or HOLD, with the numbered reasons for a HOLD.'
  ].join('\n');
}

/** The release-guard's section in a team file (`## release-guard` with its settings and instructions), ready to append to a section template. */
export function releaseGuardMemberSection(section: StaffSectionId, reportsTo: string): string {
  return [
    `## ${RELEASE_GUARD_SLUG}`,
    'role: Release gate: checks every product before a person sees it',
    `model: ${RELEASE_GUARD_TIER}`,
    `reports-to: ${reportsTo}`,
    `tools: ${RELEASE_GUARD_TOOLS.join(', ')}`,
    'privacy: private',
    '',
    releaseGuardInstructions(section),
    ''
  ].join('\n');
}

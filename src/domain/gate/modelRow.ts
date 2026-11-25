// The words of one model row (74.1 D-21, 74.1-UI-SPEC S1, S4, S5): where it runs, where it comes from, its family and what it is approved for. One helper
// for the chat picker, the model directory and the research workspace, so they can never disagree (T-74.1-48). Pure: the caller passes the time, the
// resolved passport, its state and the session's use.
import { dateShown, familyShown, originShown, placeShown } from './placeWords';
import type { PassportState } from './passportState';
import type { ModelsSection, ResolvedPassport, UseTier } from './models';
import { USE_TIERS, resolvePassport } from './models';
import { passportState } from './passportState';

/** The row words (74.1-UI-SPEC S4). Placeholders in braces are filled by code. */
export const MODEL_ROW_TEXT = Object.freeze({
  group: 'Runs on {place}',
  nearPlace: 'NEAR AI private hardware (checked each time it is used)',
  approved: 'Approved for {use} until {date}',
  approvedNoDate: 'Approved for {use}',
  researchOnly: 'Research only',
  allowedBy: 'Allowed for chat you review by {name} until {date}',
  ended: 'Approval ended {date}; research only',
  withdrawn: 'Withdrawn by your organization',
  greyed: '{approval}; this chat is {use}',
  reportOutside: '{approval}; outside your organization\'s model policy (report only)',
  reportOutsideOwn: '{approval}; outside your rules for models (report only)',
  pickerSavedForbidden: '{model} is not approved for this chat\'s use, so this chat uses {default} instead.'
});

/** The short use words rows use (74.1-UI-SPEC "Use words in rows"); refusals keep USE_TIER_WORDS. */
export const ROW_USE_WORDS: Readonly<Record<UseTier, string>> = Object.freeze({ T0: 'research only', T1: 'chat you review', T2: 'agent work', T3: 'operational work' });

/** The order of the picker's groups (74.1-UI-SPEC S4); a group not listed sorts last. */
export const ROW_PLACE_ORDER = Object.freeze(['local', 'org-plain', 'org-tee', 'vendor', 'nearai-tee', 'outside', 'unknown'] as const);

/** What the catalogue says about where a model runs. */
export interface CatalogPlace {
  readonly privacyBoundary?: string;
  readonly forwardedTo?: string;
  readonly provider?: string;
}

export interface ModelRowInput {
  readonly id: string;
  readonly place: CatalogPlace;
  readonly resolved?: ResolvedPassport;
  readonly state: PassportState;
  /** A verified exception for chat you review covering this model now (D-20): the named person and the end date (ISO). */
  readonly allowedBy?: { readonly name: string; readonly until: string };
  /** The session's use: rows the use forbids are greyed under enforce, or marked in report mode. Absent: the directory, which greys nothing. */
  readonly use?: UseTier;
  readonly mode: 'report' | 'enforce';
  readonly organization: boolean;
}

export interface ModelRow {
  /** The group the row sits in, its order index and its label ("Runs on ..."). */
  readonly groupKey: (typeof ROW_PLACE_ORDER)[number];
  readonly group: string;
  /** `{short name} · {origin} · {family} · {approval}`, with the reason when greyed or outside the policy. */
  readonly text: string;
  /** `Runs on {place} · {origin} · {family} · {approval}` (S1 and S5 facts line). */
  readonly facts: string;
  /** The full row with the full model id, for the option's title. */
  readonly title: string;
  readonly approval: string;
  /** The use the row's approval covers: T0 for research only, ended, withdrawn or unknown. */
  readonly covers: UseTier;
  readonly disabled: boolean;
}

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole);
const rank = (tier: UseTier): number => USE_TIERS.indexOf(tier);

function placeOf(place: CatalogPlace): { key: ModelRow['groupKey']; words: string } {
  if (place.privacyBoundary === 'local') return { key: 'local', words: placeShown({ class: 'local', region: 'unstated' }) };
  if (place.privacyBoundary === 'tee') return { key: 'nearai-tee', words: MODEL_ROW_TEXT.nearPlace };
  if (place.privacyBoundary === 'cloud' || place.forwardedTo !== undefined) {
    return { key: 'outside', words: placeShown({ class: 'forwarded', region: 'unstated', ...(place.forwardedTo === undefined ? {} : { forwardedTo: place.forwardedTo }) }) };
  }
  return { key: 'unknown', words: placeShown({ class: 'unknown', region: 'unstated' }) };
}

/** The approval words and the use they cover. */
function approvalOf(input: ModelRowInput): { words: string; covers: UseTier } {
  const state = input.state;
  if (state.state === 'revoked') return { words: MODEL_ROW_TEXT.withdrawn, covers: 'T0' };
  if (state.state === 'expired') return { words: fill(MODEL_ROW_TEXT.ended, { date: dateShown(input.resolved?.passport.expiresAt ?? '') }), covers: 'T0' };
  if (state.state === 'unknown' || state.maxTier === 'T0') {
    if (input.allowedBy !== undefined) return { words: fill(MODEL_ROW_TEXT.allowedBy, { name: input.allowedBy.name, date: dateShown(input.allowedBy.until) }), covers: 'T1' };
    return { words: MODEL_ROW_TEXT.researchOnly, covers: 'T0' };
  }
  const use = ROW_USE_WORDS[state.maxTier];
  const until = input.resolved?.passport.expiresAt;
  return { words: until === undefined ? fill(MODEL_ROW_TEXT.approvedNoDate, { use }) : fill(MODEL_ROW_TEXT.approved, { use, date: dateShown(until) }), covers: state.maxTier };
}

/** The short name a row starts with: the last part of the id. */
export function shortModelName(id: string): string {
  return id.split('/').filter((part) => part !== '').pop() ?? id;
}

/** One model row's words. */
export function modelRow(input: ModelRowInput): ModelRow {
  const place = placeOf(input.place);
  const passport = input.resolved?.passport;
  const origin = originShown(passport?.origin);
  const family = familyShown(passport?.lineage.family);
  const approval = approvalOf(input);
  const below = input.use !== undefined && rank(approval.covers) < rank(input.use);
  const disabled = below && input.mode === 'enforce';
  const shown = !below ? approval.words
    : disabled ? fill(MODEL_ROW_TEXT.greyed, { approval: approval.words, use: ROW_USE_WORDS[input.use as UseTier] })
      : fill(input.organization ? MODEL_ROW_TEXT.reportOutside : MODEL_ROW_TEXT.reportOutsideOwn, { approval: approval.words });
  const parts = (name: string) => [name, origin, family, shown].join(' · ');
  return Object.freeze({
    groupKey: place.key,
    group: fill(MODEL_ROW_TEXT.group, { place: place.words }),
    text: parts(shortModelName(input.id)),
    facts: [fill(MODEL_ROW_TEXT.group, { place: place.words }), origin, family, approval.words].join(' · '),
    title: parts(input.id),
    approval: approval.words,
    covers: approval.covers,
    disabled
  });
}

/** Rows grouped in the picker's order of places, each group's rows in the order given. Empty groups are left out. */
export function groupedRows<T extends { readonly row: ModelRow }>(rows: readonly T[]): Array<{ readonly label: string; readonly rows: readonly T[] }> {
  const groups = new Map<string, { label: string; order: number; rows: T[] }>();
  for (const entry of rows) {
    const key = entry.row.group;
    const found = groups.get(key) ?? { label: key, order: ROW_PLACE_ORDER.indexOf(entry.row.groupKey), rows: [] };
    found.rows.push(entry);
    groups.set(key, found);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)).map((group) => ({ label: group.label, rows: group.rows }));
}

/**
 * The rows of a catalogue: each model's passport resolved from the effective models section (the shipped passports without one) and its state at `now`.
 * The mode is the section's (report when absent). `use` greys or marks rows as modelRow does; absent, nothing is greyed (the directory, the research
 * workspace).
 */
export function catalogRows(
  catalog: ReadonlyArray<CatalogPlace & { readonly id: string }>, section: ModelsSection | undefined, now: number,
  options: { readonly use?: UseTier; readonly organization: boolean; readonly allowedBy?: (id: string) => ModelRowInput['allowedBy'] }
): Array<{ readonly id: string; readonly row: ModelRow }> {
  return catalog.map((model) => {
    const resolved = resolvePassport(section, model.id, now);
    const allowedBy = options.allowedBy?.(model.id);
    return {
      id: model.id,
      row: modelRow({
        id: model.id, place: model, ...(resolved === undefined ? {} : { resolved }), state: passportState(resolved, {}, now),
        ...(allowedBy === undefined ? {} : { allowedBy }), ...(options.use === undefined ? {} : { use: options.use }),
        mode: section?.mode ?? 'report', organization: options.organization
      })
    };
  });
}

/** Insert at cursor on an answer (74.1 D-21, P4, 74.1-UI-SPEC S6). Placeholders in braces are filled by code. */
export const APPLY_TEXT = Object.freeze({
  applyBlocked: '{model} is approved only for {use}, so its answer cannot be applied to a file. You can copy the text.',
  applyReportOnly: '{model} is approved only for {use}. Applying its answer to a file is outside your organization\'s model policy (report only).'
});

/** The approval an answer's trust facts carry: a model approval's use, an exception's chat you review, or research only. */
export interface ApplyFacts {
  readonly allowedBy: ReadonlyArray<{ readonly kind: string; readonly passport?: string; readonly maxTier?: UseTier; readonly authorizationKind?: string }>;
  readonly wouldRefuse?: readonly string[];
}

/**
 * Whether Insert at cursor may write an answer into a file (74.1 D-21, P4, Q1): yes when the answer's model is approved for agent work; in report mode
 * yes, with the line that it is outside the policy; under enforce no, with the reason (only a surface whose use is chat you review can show such an
 * answer). Copy always stays.
 */
export function applyAllowed(facts: ApplyFacts, model: string): { readonly allowed: boolean; readonly reason?: string } {
  const approval = facts.allowedBy.find((record) => record.kind === 'model-approval');
  const exception = facts.allowedBy.some((record) => record.kind === 'authorization' && record.authorizationKind === 't1-risk');
  const reported = facts.wouldRefuse?.includes('route.passport') === true;
  // No approval step ran for this answer (no policy, or an older path): there is nothing to say and nothing to refuse here.
  if (approval === undefined && !exception && !reported) return { allowed: true };
  const approved: UseTier = approval?.maxTier ?? 'T0';
  const covers: UseTier = exception && rank(approved) < rank('T1') ? 'T1' : approved;
  if (rank(covers) >= rank('T2')) return { allowed: true };
  const name = approval?.passport ?? model;
  const use = covers === 'T1' ? ROW_USE_WORDS.T1 : 'research';
  if (reported) return { allowed: true, reason: fill(APPLY_TEXT.applyReportOnly, { model: name, use }) };
  return { allowed: false, reason: fill(APPLY_TEXT.applyBlocked, { model: name, use }) };
}

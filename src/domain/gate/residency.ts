// Residency (FND-05, D-33): whether a place may receive a request's content given the regions your organization's rules name, for every request
// (`required`) and per label (`byLevel`). Pure: no I/O, no clock, no vscode, no package.
// A place satisfies the rule only when its stated region is in every list that applies; `unstated` never does; this computer always does. A
// `residency-exception` authorization naming the place, the project and every label of the request lets it go anyway, and is returned as what allowed it.
// authorizationCovers is called only inside a function, never at module load, so the cycle through routing.ts stays safe.
import { authorizationCovers } from './authorizations';
import type { EndpointRegion } from './endpoints';
import { labelKey } from './labels';
import type { Label } from './labels';
import type { RouteEndpoint, VerifiedAuthorization } from './routing';
import type { ResidencySection } from './sections';

/** A list from `byLevel` by own property only, so a key such as `__proto__` reads as nothing. */
function byLevelOf(residency: ResidencySection, key: string): readonly EndpointRegion[] | undefined {
  const table = residency.byLevel;
  if (table === undefined || !Object.prototype.hasOwnProperty.call(table, key)) return undefined;
  const list: unknown = table[key];
  return Array.isArray(list) ? (list as readonly EndpointRegion[]) : undefined;
}

/**
 * The regions a request carrying these labels may go to: the intersection of `required` and the `byLevel` list of each label that has one, sorted.
 * Undefined when no list applies (no section, or neither `required` nor a list for any of the labels). An empty answer means no region can satisfy it.
 */
export function allowedRegions(residency: ResidencySection | undefined, labels: readonly Pick<Label, 'scale' | 'level'>[]): readonly EndpointRegion[] | undefined {
  if (residency === undefined) return undefined;
  const lists: Array<readonly EndpointRegion[]> = [];
  if (residency.required !== undefined) lists.push(residency.required);
  for (const label of labels) {
    const list = byLevelOf(residency, labelKey(label));
    if (list !== undefined) lists.push(list);
  }
  const [first, ...rest] = lists;
  if (first === undefined) return undefined;
  const out = first.filter((region) => region !== 'unstated' && rest.every((list) => list.includes(region)));
  return Object.freeze([...new Set(out)].sort());
}

export interface ResidencyQuestion {
  /** The place the request would go to; undefined for a place your rules do not name, which counts as region unstated with no id. */
  readonly endpoint: Pick<RouteEndpoint, 'id' | 'class' | 'region'> | undefined;
  /** Every label of the request (the mark, or the default label for an empty mark). */
  readonly labels: readonly Pick<Label, 'scale' | 'level'>[];
  readonly residency?: ResidencySection;
  readonly authorizations: readonly VerifiedAuthorization[];
  /** The project of the request; absent, an exception scoped to projects covers nothing (D-54). */
  readonly project?: string;
  /** The lowercase use token of the request; absent, an exception scoped to uses covers nothing. */
  readonly use?: string;
  readonly now: number;
}

export type ResidencyAnswer =
  | { readonly ok: true; readonly exception?: VerifiedAuthorization }
  | { readonly ok: false; readonly allowed: readonly EndpointRegion[] };

/**
 * Whether residency lets the request go (D-33): no list applies, allowed; this computer, allowed; the place's stated region in the list (never
 * `unstated`), allowed; a `residency-exception` authorization covering the place's id, the project and every label, allowed with that record; otherwise
 * refused with the regions that would have satisfied it.
 */
export function residencyAllows(question: ResidencyQuestion): ResidencyAnswer {
  const allowed = allowedRegions(question.residency, question.labels);
  if (allowed === undefined) return { ok: true };
  const endpoint = question.endpoint;
  if (endpoint?.class === 'local') return { ok: true };
  if (endpoint !== undefined && endpoint.region !== 'unstated' && allowed.includes(endpoint.region)) return { ok: true };
  const id = endpoint?.id;
  if (id !== undefined) {
    const covers = (candidate: VerifiedAuthorization, label: string | undefined): boolean => authorizationCovers(candidate.body, {
      kind: 'residency-exception', subject: { endpoint: id }, project: question.project, label, use: question.use
    }, question.now);
    // With no label the record is still asked once, so its kind, place, dates and scope are always checked.
    const exception = question.authorizations.find((candidate) => (question.labels.length === 0
      ? covers(candidate, undefined)
      : question.labels.every((label) => covers(candidate, labelKey(label)))));
    if (exception !== undefined) return { ok: true, exception };
  }
  return { ok: false, allowed };
}

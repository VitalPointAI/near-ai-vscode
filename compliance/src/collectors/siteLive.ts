// The live site feed's fact groups and their checks (48.2-06, D-20, D-21). The site collector (48.2-09) gathers in-cluster facts every few
// minutes; each group carries its own collectedAt and only ids, counts, hashes, booleans and named values, never a pass field: the session's
// checks decide, here, and a fact the deployment export also carries is judged by the deployment collector's own thresholds.
import type { Observation } from '../model.ts';
import { MAX_UNSIGNED_IMAGE_RESULTS, MIN_ENFORCING_IMAGE_POLICIES, MIN_NODES, REQUIRED_SEAL_TYPE, SEAL_TYPES } from './deploymentChecks.ts';

/** The collector name of every live site observation. */
export const SITE_LIVE_COLLECTOR = 'site-live';

/**
 * The alerts whose firing makes the audit trail or OpenBao untrustworthy: the `openbao` and `audit-shipping` groups of the site's alert rules
 * as code (deploy/values/prometheus-alerts.yaml, 48.1-02). siteEvidence.test.ts holds this list equal to that file.
 */
export const WATCHED_ALERTS: readonly string[] = Object.freeze([
  'OpenBaoSealed', 'OpenBaoAuditDeviceFailing', 'OpenBaoMetricsTargetDown', 'OpenBaoMetricsMissing', 'OpenBaoSealSeriesMissing',
  'FluentBitOutputFailing', 'AuditRecordsNotReachingStore', 'FluentBitMetricsTargetDown', 'FluentBitMetricsMissing',
  // 71-12 (D-26, G467): OpenBao's rate limit on computer place claims fired. Watched so the audit observation reads not quiet while a burst of
  // claims is under way, failing closed like every other alert of the openbao group.
  'ComputerPlaceClaimsLimited',
]);

type Leaf = 'time' | 'count' | 'boolean' | 'seal' | 'digest' | 'alerts';
/** The allow-list: each group and its exact keys. Anything else, a pass field included, refuses the whole feed. */
export const LIVE_GROUPS: Readonly<Record<string, Readonly<Record<string, Leaf>>>> = Object.freeze({
  prometheus: { collectedAt: 'time', ruleGroups: 'count', unhealthyRuleGroups: 'count', staleRules: 'count', firingAlerts: 'alerts' },
  admission: { collectedAt: 'time', enforcingImagePolicies: 'count', refusedImageResults: 'count' },
  openbao: { collectedAt: 'time', sealed: 'boolean', type: 'seal' },
  nodes: { collectedAt: 'time', count: 'count' },
  release: { collectedAt: 'time', appDefinitionImage: 'digest', recordImage: 'digest' },
});
/** The order groups are checked and their observations listed. */
export const LIVE_GROUP_ORDER = Object.freeze(['prometheus', 'admission', 'openbao', 'nodes', 'release'] as const);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALERT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_ALERTS = 256;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function leafOk(leaf: Leaf, value: unknown): boolean {
  switch (leaf) {
    case 'time': return typeof value === 'string' && ISO_TIME.test(value) && new Date(value).toISOString() === value;
    case 'count': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'boolean': return typeof value === 'boolean';
    case 'seal': return typeof value === 'string' && (SEAL_TYPES as readonly string[]).includes(value);
    case 'digest': return typeof value === 'string' && DIGEST.test(value);
    case 'alerts': return Array.isArray(value) && value.length <= MAX_ALERTS && value.every((name) => typeof name === 'string' && ALERT_NAME.test(name));
  }
}

/** Checks the groups of a live feed against the allow-list; throws one plain line when anything is outside it. */
export function checkLiveGroups(groups: unknown): asserts groups is Record<string, Record<string, unknown> & { collectedAt: string }> {
  if (!isRecord(groups) || Object.keys(groups).length === 0) throw new Error('the live feed has no fact groups');
  for (const [name, group] of Object.entries(groups)) {
    const shape = Object.hasOwn(LIVE_GROUPS, name) ? LIVE_GROUPS[name] : undefined;
    if (!shape) throw new Error('the live feed holds a group outside the allow-list');
    if (!isRecord(group)) throw new Error(`the live group ${name} is not an object`);
    for (const key of Object.keys(group)) if (!Object.hasOwn(shape, key)) throw new Error(`the live group ${name} holds a fact outside the allow-list`);
    for (const [key, leaf] of Object.entries(shape)) if (!leafOk(leaf, group[key])) throw new Error(`the live group ${name} lacks ${key} or has the wrong type`);
  }
}

const bit = (value: boolean): number => (value ? 1 : 0);

/** The observations of checked groups, each dated at its own group's collectedAt. */
export function liveObservations(groups: Record<string, Record<string, unknown> & { collectedAt: string }>): Observation[] {
  const observations: Observation[] = [];
  const add = (subject: string, collectedAt: string, passed: boolean, counts: Record<string, number>, hash?: string) =>
    observations.push({ collector: SITE_LIVE_COLLECTOR, subject, passed, collectedAt, counts, ...(hash ? { hash } : {}) });
  for (const name of LIVE_GROUP_ORDER) {
    const group = groups[name];
    if (!group) continue;
    const at = group.collectedAt;
    if (name === 'prometheus') {
      const { ruleGroups, unhealthyRuleGroups, staleRules, firingAlerts } = group as unknown as { ruleGroups: number; unhealthyRuleGroups: number; staleRules: number; firingAlerts: string[] };
      add('prometheus-rules-healthy', at, ruleGroups >= 1 && unhealthyRuleGroups === 0 && staleRules === 0, { 'rule-groups': ruleGroups, 'unhealthy-groups': unhealthyRuleGroups, 'stale-rules': staleRules });
      const watched = new Set(firingAlerts.filter((alert) => WATCHED_ALERTS.includes(alert)));
      add('audit-alerts-quiet', at, watched.size === 0, { 'watched-firing': watched.size, firing: new Set(firingAlerts).size });
    } else if (name === 'admission') {
      const { enforcingImagePolicies, refusedImageResults } = group as unknown as { enforcingImagePolicies: number; refusedImageResults: number };
      add('image-admission-enforced', at, enforcingImagePolicies >= MIN_ENFORCING_IMAGE_POLICIES && refusedImageResults <= MAX_UNSIGNED_IMAGE_RESULTS,
        { 'enforcing-policies': enforcingImagePolicies, 'refused-results': refusedImageResults });
    } else if (name === 'openbao') {
      const { sealed, type } = group as unknown as { sealed: boolean; type: string };
      add('openbao-sealed', at, !sealed && type === REQUIRED_SEAL_TYPE, { sealed: bit(sealed), 'not-pkcs11': bit(type !== REQUIRED_SEAL_TYPE) });
    } else if (name === 'nodes') {
      const { count } = group as unknown as { count: number };
      add('nodes', at, count >= MIN_NODES, { nodes: count });
    } else {
      const { appDefinitionImage, recordImage } = group as unknown as { appDefinitionImage: string; recordImage: string };
      add('release-record', at, appDefinitionImage === recordImage, { 'differs-from-record': bit(appDefinitionImage !== recordImage) }, appDefinitionImage.slice('sha256:'.length));
    }
  }
  return observations;
}

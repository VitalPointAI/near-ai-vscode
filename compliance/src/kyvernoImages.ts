// The Kyverno image policy readers (48-02, moved here unchanged in 48.2-09): how many image-verifying policies enforce, and how many of their
// results in the policy reports failed. The operator's site export (siteExport.ts) and the live site collector (workbench/bin/
// collect-site-evidence.mjs, through the engine bundle) read Kyverno with these one definitions. Node built-ins only, no loader.
import type { SiteFacts } from './collectors/deploymentChecks.ts';

/** A reader's refusal; `source` names the collected file. The message never quotes the file's content. */
export class SiteExportError extends Error {
  public readonly source: string;
  public constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = 'SiteExportError';
    this.source = source;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value: unknown, source: string, what: string): unknown[] => {
  if (!Array.isArray(value)) throw new SiteExportError(source, `${what} is not a list`);
  return value;
};
const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

export interface ImagePolicies {
  readonly enforcingImagePolicies: number;
  /** The names of every image-verifying policy, enforcing or not, to find their results in the reports. */
  readonly names: ReadonlySet<string>;
}

const enforces = (action: unknown): boolean => typeof action === 'string' && action.toLowerCase() === 'enforce';

/**
 * An ImageValidatingPolicy enforces when its validation actions include Deny; a ClusterPolicy when a rule with verifyImages fails as Enforce
 * (the entry's failureAction, else the policy's validationFailureAction, whose default is Audit). A failure policy of Ignore never enforces.
 */
export function readKyvernoPolicies(doc: unknown, source = 'kyverno-clusterpolicies.json'): ImagePolicies {
  if (!isRecord(doc)) throw new SiteExportError(source, 'expected a list with items');
  const names = new Set<string>();
  let enforcing = 0;
  for (const item of listOf(doc.items, source, 'items')) {
    if (!isRecord(item) || !isRecord(item.spec)) continue;
    const spec = item.spec;
    let image = false;
    let enforced = false;
    if (item.kind === 'ImageValidatingPolicy') {
      image = true;
      enforced = Array.isArray(spec.validationActions) && spec.validationActions.includes('Deny');
    } else if (item.kind === 'ClusterPolicy' && Array.isArray(spec.rules)) {
      for (const rule of spec.rules) {
        if (!isRecord(rule) || !nonEmpty(rule.verifyImages)) continue;
        image = true;
        if ((rule.verifyImages as unknown[]).some((entry) => isRecord(entry) && enforces(entry.failureAction ?? spec.validationFailureAction))) enforced = true;
      }
    }
    if (!image) continue;
    const name = isRecord(item.metadata) ? item.metadata.name : undefined;
    if (typeof name !== 'string' || name === '') throw new SiteExportError(source, 'an image policy has no name');
    names.add(name);
    if (enforced && spec.failurePolicy !== 'Ignore') enforcing += 1;
  }
  return { enforcingImagePolicies: enforcing, names };
}

const REPORT_RESULTS = Object.freeze(['pass', 'fail', 'warn', 'error', 'skip']);

/** Counts the failed or errored results of the image policies across every PolicyReport and ClusterPolicyReport. */
export function readPolicyReports(doc: unknown, policies: ImagePolicies, source = 'kyverno-policyreports.json'): Pick<SiteFacts['registry'], 'unsignedImageResults'> {
  if (!isRecord(doc)) throw new SiteExportError(source, 'expected a list with items');
  let unsigned = 0;
  for (const report of listOf(doc.items, source, 'items')) {
    if (!isRecord(report) || (report.kind !== 'PolicyReport' && report.kind !== 'ClusterPolicyReport')) throw new SiteExportError(source, 'an item is not a policy report');
    if (report.results === undefined || report.results === null) continue;
    for (const result of listOf(report.results, source, 'results')) {
      if (!isRecord(result) || typeof result.policy !== 'string' || typeof result.result !== 'string' || !REPORT_RESULTS.includes(result.result)) throw new SiteExportError(source, 'a result has no policy or a result outside pass, fail, warn, error and skip');
      if (policies.names.has(result.policy) && (result.result === 'fail' || result.result === 'error')) unsigned += 1;
    }
  }
  return { unsignedImageResults: unsigned };
}

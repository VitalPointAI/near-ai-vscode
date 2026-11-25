// The trust export and import on the hub (Phase 71, 71-11; D-11, D-17). At HQ, --trust-export <file> writes every DID log, the newest copy of
// every status list and your organization's signed rules from this hub into one .near-trust-export file. At an edge, --trust-import <file> keeps
// what readTrustExport takes: each object verifies on its own and is newer than what the edge holds, a list never replaces a newer one or clears a
// revocation, and each refused object is reported in one line. Nothing is signed here. The edge's own rules stay the ones its configuration names
// (HUB_ORGANIZATION_POLICY): newer rules in the file are reported, never written, so a site's values remain the one source of its rules.
import { buildTrustExport, readTrustExport } from '@ext/domain/credentials/trustExport';
import type { HeldTrust } from '@ext/domain/credentials/trustExport';
import type { StatusListState } from '@ext/domain/credentials/statusList';
import { verifyOrganizationLayer } from '@ext/domain/gate/enrolment';
import type { OrganizationSource, TrustStore } from './store/trustStore';

export const TRANSFER_TEXT = {
  'no-policy': 'This hub has no valid copy of your organization\'s rules with credentials, so nothing could be exported or imported.',
  empty: 'This hub holds no identities or status lists yet, so there is nothing to export.',
  'nothing-taken': 'Nothing in the file was newer than what this hub holds, or everything was refused.',
  'newer-rules': 'The file holds newer rules of your organization than this hub\'s configuration. Ask your administrator to install them.',
} as const;

export type ExportResult = { ok: true; text: string; logs: number; lists: number } | { ok: false; message: string };

/** The export file's text from this hub's trust store, at `now`. */
export function exportTrust(trust: TrustStore, organization: OrganizationSource, now: number): ExportResult {
  if (!trust.policy(now).ok || organization.text === undefined) return { ok: false, message: TRANSFER_TEXT['no-policy'] };
  const logs = trust.allLogs();
  const lists = trust.newestLists();
  if (logs.length === 0 && lists.length === 0) return { ok: false, message: TRANSFER_TEXT.empty };
  const text = buildTrustExport({
    policyLayer: JSON.parse(organization.text) as unknown,
    logs: logs.map((log) => ({ path: log.path, log: log.log, ...(log.witness === undefined ? {} : { witness: log.witness }) })),
    lists: lists.map((list) => JSON.parse(list.body) as unknown),
    exportedAt: new Date(now).toISOString(),
  });
  return { ok: true, text, logs: logs.length, lists: lists.length };
}

export interface ImportReport {
  taken: { logs: number; lists: number };
  /** One plain line per refused object, naming its place in the file and why. */
  lines: string[];
}

/** Keeps what the file's objects allow at this hub, and reports the rest. */
export function importTrust(trust: TrustStore, organization: OrganizationSource, text: string, now: number): { ok: true; report: ImportReport } | { ok: false; message: string } {
  const policy = trust.policy(now);
  if (!policy.ok || organization.text === undefined || organization.key === undefined) return { ok: false, message: TRANSFER_TEXT['no-policy'] };
  const layer = verifyOrganizationLayer(organization.text, { issuerPublicKey: organization.key, now });
  if (!layer.ok) return { ok: false, message: TRANSFER_TEXT['no-policy'] };

  const lists: Record<string, StatusListState> = {};
  for (const entry of policy.section.statusLists) {
    const held = trust.heldListState(entry);
    if (held !== undefined) lists[entry.uri] = held;
  }
  const logs: Record<string, { log: string; scid: string }> = {};
  for (const log of trust.allLogs()) logs[log.path] = { log: log.log, scid: log.scid };
  const held: HeldTrust = { issuerPublicKey: organization.key, policy: { section: policy.section, issuedAt: layer.issuedAt }, lists, logs };

  const read = readTrustExport(text, held, now);
  const lines = read.refused.map((item) => `Object ${item.index + 1} (${item.kind}): ${item.message}`);
  if (read.take.policyLayer !== undefined && read.take.policyLayer.issuedAt > layer.issuedAt) lines.push(TRANSFER_TEXT['newer-rules']);
  let takenLists = 0;
  for (const list of read.take.lists) {
    const entry = policy.section.statusLists.find((item) => item.uri === list.id);
    if (entry === undefined) continue;
    const stored = trust.putStatusList(entry, list.value, JSON.stringify(list.value), now, { exactNext: false });
    if (stored.ok && stored.stored) takenLists += 1;
    else if (!stored.ok) lines.push(`A status list was not kept: ${stored.message}`);
  }
  let takenLogs = 0;
  for (const log of read.take.logs) {
    const stored = trust.putLog(log.path, log.log, log.witness, now);
    if (stored.ok && stored.stored) takenLogs += 1;
    else if (!stored.ok) lines.push(`An identity log was not kept: ${stored.message}`);
  }
  return { ok: true, report: { taken: { logs: takenLogs, lists: takenLists }, lines } };
}

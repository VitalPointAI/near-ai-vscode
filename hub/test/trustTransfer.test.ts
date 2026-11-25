import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkFreshness } from '@ext/domain/credentials/freshness';
import { REVOCATIONS, SUSPENSIONS, list } from '@ext/test/helpers/credentialWorld';
import type { SignedList } from '@ext/test/helpers/credentialWorld';
import type { StatusListPolicy } from '@ext/domain/gate/credentialsSection';
import { hostPathOf } from '../src/store/trustStore';
import type { OrganizationSource, TrustStore } from '../src/store/trustStore';
import { TRANSFER_TEXT, exportTrust, importTrust } from '../src/trustTransfer';
import { withHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { launchHub, within } from './helpers/hubProcess';
import { createHubWorld } from './helpers/hubWorld';
import { DAY, REVOCATION_ROUTE, isoAt, makeTrustWorld } from './helpers/trustWorld';
import type { TrustWorld } from './helpers/trustWorld';

// Phase 71, plan 11, task 2 (D-11, D-17): the HQ hub writes its identities, status lists and your organization's rules into one
// .near-trust-export file, and an edge hub keeps what verifies and is newer than what it holds, reporting each refused object in one line. Offline
// age at the edge counts from each list's own validFrom. The hubs run at the real clock here, because the export and import commands do. All
// names, DIDs and keys are fictional and made at run time.

const NOW = Date.now();
const HOUR = 3_600_000;

interface Lists { revocations: SignedList; suspensions: SignedList }

async function listsAt(trust: TrustWorld, version: number, validFrom: number, revoked: number[] = []): Promise<Lists> {
  const window = { version, validFrom: isoAt(validFrom), validUntil: isoAt(validFrom + 6 * DAY) };
  return {
    revocations: await list(trust.world.revocationKey, REVOCATIONS, 'revocation', revoked, window),
    suspensions: await list(trust.world.suspensionKey, SUSPENSIONS, 'suspension', [], window),
  };
}

function hold(store: TrustStore, trust: TrustWorld, lists: Lists, people: ReadonlyArray<'root' | 'officer' | 'member'> = ['root', 'officer', 'member']): void {
  const section = store.policy(NOW);
  if (!section.ok) throw new Error('the trust world\'s rules do not verify');
  for (const who of people) assert.ok(store.putLog(hostPathOf(trust.world[who].did) as string, trust.world[who].log, undefined, NOW).ok);
  for (const signed of [lists.revocations, lists.suspensions]) {
    const entry: StatusListPolicy | undefined = section.section.statusLists.find((item) => item.uri === signed.id);
    assert.ok(entry !== undefined);
    const stored = store.putStatusList(entry, signed.credential, JSON.stringify(signed.credential), NOW, { exactNext: false });
    assert.ok(stored.ok, stored.ok ? '' : stored.message);
  }
}

const withTwoHubs = (body: (hq: Hub, edge: Hub, trust: TrustWorld) => Promise<void>) => async (): Promise<void> => {
  const trust = await makeTrustWorld({}, NOW);
  await withHub({ now: NOW, organization: trust.organization }, (hq) => withHub({ now: NOW, organization: trust.organization }, (edge) => body(hq, edge, trust)));
};

test('an HQ hub with nothing to export says so; with no rules it says that instead', withTwoHubs(async (hq, _edge, trust) => {
  const empty = exportTrust(hq.trust, trust.organization, NOW);
  assert.deepEqual(empty, { ok: false, message: TRANSFER_TEXT.empty });
  const none: OrganizationSource = { text: undefined, key: undefined };
  assert.equal(exportTrust(hq.trust, none, NOW).ok, false);
}));

test('tracer: the HQ export imported at an empty edge is served by the edge\'s trust routes', withTwoHubs(async (hq, edge, trust) => {
  const lists = await listsAt(trust, 1, NOW - HOUR);
  hold(hq.trust, trust, lists);
  const made = exportTrust(hq.trust, trust.organization, NOW);
  assert.ok(made.ok);
  assert.equal(made.logs, 3);
  assert.equal(made.lists, 2);
  const imported = importTrust(edge.trust, trust.organization, made.text, NOW);
  assert.ok(imported.ok);
  assert.deepEqual(imported.report.taken, { logs: 3, lists: 2 });
  assert.deepEqual(imported.report.lines, []);

  const world = createHubWorld();
  world.admitHub(edge.identity);
  assert.equal((await edge.enrolProject(world))?.status, 201);
  const lead = await edge.openSession(world.lead, world.project);
  const served = await lead.connection.get(`/v1/trust/did/${hostPathOf(trust.world.officer.did) as string}/did.jsonl`, lead.token);
  assert.equal(served.text, trust.world.officer.log);
  assert.deepEqual((await lead.connection.get(REVOCATION_ROUTE, lead.token)).json(), lists.revocations.credential);
}));

test('an edge holding a newer list version refuses the older one in the file, in one line, and takes the rest', withTwoHubs(async (hq, edge, trust) => {
  hold(hq.trust, trust, await listsAt(trust, 1, NOW - 2 * HOUR));
  const newer = await listsAt(trust, 2, NOW - HOUR, [5]);
  hold(edge.trust, trust, newer, []);
  const made = exportTrust(hq.trust, trust.organization, NOW);
  assert.ok(made.ok);
  const imported = importTrust(edge.trust, trust.organization, made.text, NOW);
  assert.ok(imported.ok);
  assert.deepEqual(imported.report.taken, { logs: 3, lists: 0 });
  assert.equal(imported.report.lines.length, 2);
  for (const line of imported.report.lines) assert.match(line, /^Object \d+ \(status-list\): This status list is not newer than the copy here/);
  assert.equal(edge.trust.newestList(REVOCATIONS)?.version, 2, 'the newer list stays');
}));

test('a tampered list in the file is refused and named; the other objects are taken', withTwoHubs(async (hq, edge, trust) => {
  hold(hq.trust, trust, await listsAt(trust, 1, NOW - HOUR));
  const made = exportTrust(hq.trust, trust.organization, NOW);
  assert.ok(made.ok);
  const file = JSON.parse(made.text) as { objects: Array<Record<string, any>> };
  const target = file.objects.find((object) => object.kind === 'status-list' && object.list.id === REVOCATIONS);
  assert.ok(target !== undefined);
  target.list.validUntil = isoAt(NOW + 30 * DAY);
  const imported = importTrust(edge.trust, trust.organization, JSON.stringify(file), NOW);
  assert.ok(imported.ok);
  assert.deepEqual(imported.report.taken, { logs: 3, lists: 1 });
  assert.equal(imported.report.lines.length, 1);
  assert.match(imported.report.lines[0] as string, /\(status-list\): This status list does not verify/);
  assert.equal(edge.trust.newestList(REVOCATIONS), undefined);
}));

test('offline age at the edge counts from the imported list\'s own validFrom: a Protected B citation past 72 hours is refused', withTwoHubs(async (hq, edge, trust) => {
  const lists = await listsAt(trust, 1, NOW - 73 * HOUR);
  hold(hq.trust, trust, lists, []);
  const made = exportTrust(hq.trust, trust.organization, NOW);
  assert.ok(made.ok);
  assert.ok(importTrust(edge.trust, trust.organization, made.text, NOW).ok);
  const policy = edge.trust.policy(NOW);
  assert.ok(policy.ok);
  const citation = { evidence: [], status: [{ list: REVOCATIONS, hash: lists.revocations.hash, validFrom: lists.revocations.validFrom }] };
  const old = checkFreshness(citation, edge.trust.newest(NOW), 'ca-protected/Protected B', policy.section, NOW, 'edge');
  assert.equal(old.ok ? 'ok' : old.reason, 'offline-too-long');
  const recent = await listsAt(trust, 2, NOW - HOUR);
  const fresh = checkFreshness({ evidence: [], status: [{ list: REVOCATIONS, hash: recent.revocations.hash, validFrom: recent.revocations.validFrom }] }, edge.trust.newest(NOW), 'ca-protected/Protected B', policy.section, NOW, 'edge');
  assert.equal(fresh.ok, true);
}));

test('the hub binary writes the export with --trust-export and refuses a bare --trust-import without starting', withTwoHubs(async (hq, _edge, trust) => {
  hold(hq.trust, trust, await listsAt(trust, 1, NOW - HOUR));
  const outside = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-trust-'));
  const rules = path.join(outside, 'organization.near-org-rules');
  writeFileSync(rules, trust.organization.text as string, { mode: 0o600 });
  const out = path.join(outside, 'hq.near-trust-export');
  const run = launchHub({ args: ['--trust-export', out], stateDir: hq.dir, env: { HUB_ORGANIZATION_POLICY: rules, HUB_ORGANIZATION_KEY: trust.organization.key as string } });
  try {
    const exit = await within(run.exited, 30_000, 'the export');
    assert.equal(exit.code, 0, run.stdout() + run.stderr());
    assert.match(run.stdout(), /Wrote hq\.near-trust-export: 3 identity logs and 2 status lists\./);
    assert.ok(existsSync(out));
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).format, 'near-trust-export/1');
  } finally {
    run.cleanup();
  }
  const bare = launchHub({ args: ['--trust-import'] });
  try {
    const exit = await within(bare.exited, 30_000, 'the usage refusal');
    assert.equal(exit.code, 1);
    assert.match(bare.stdout(), /usage: --trust-export <file>, or --trust-import <file>/);
  } finally {
    bare.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
}));

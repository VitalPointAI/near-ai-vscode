// Grant pages (33.2-03 Task 1; 33.2-CONTEXT D-04, D-12): a cell-wrap/v2 epoch grant may span several signed pages. The founding page carries the
// sealed label and the sorted hashes of the other pages, so the founding entry's grant hash commits to every page. Wraps here only need the wire
// shape (the grant never opens them), so they are fictional bytes of the right size and version.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GRANT_MAX_BYTES, MAX_GRANT_WRAPS, MAX_LABEL_SEALED_CHARS, WRAP_BYTES, buildGrant, grantHash, readGrant, wrapEpochKey } from '../domain/replica/cellKeys';
import type { CellGrant, GrantWrap } from '../domain/replica/cellKeys';
import { WRAP_V2_BYTES } from '../domain/replica/cellWrapV2';
import { GRANT_PAGE_REFUSALS, MAX_WRAPS_PER_V2_PAGE, buildGrantPages, readGrantPages } from '../domain/replica/grantPages';
import { canonicalBytes } from '../domain/team/canonical';
import { payloadSigningInput, signPayload } from '../domain/team/signedPayload';
import type { SignOptions, SignedPayload } from '../domain/team/signedPayload';
import { accessPermitBytes, accessRevisionId } from '../domain/replica/rotationProof';
import { REPLICA_SIGNED_AT } from '../domain/replica/entry';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import { granteesAt } from '../domain/replica/rosterCells';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld, rosterDevice } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import type { Written } from './helpers/replicaWorld';
import { fixedSigner, streamId } from './helpers/replicaWorld';
import { createFinishGrantScope, createFinishIntent } from '../staff/replica/managedFinishSigning';

const LEAD = rosterDevice('PAGES-LEAD', 'mbr-lead');
const CELL = streamId('pages-cell');
const ROSTER = 'b'.repeat(64);
const LABEL = 'L'.repeat(64);
const writerAt = (index: number): string => index.toString(16).padStart(64, '0');
const v2Wrap = (index: number): string => {
  const wire = Buffer.alloc(WRAP_V2_BYTES, index % 251);
  wire[0] = 2;
  return wire.toString('base64url');
};
const v1Wrap = (index: number): string => Buffer.alloc(WRAP_BYTES, index % 251).toString('base64url');
const wraps = (count: number, make: (index: number) => string = v2Wrap): GrantWrap[] => Array.from({ length: count }, (_, index) => ({ writer: writerAt(index + 1), wrap: make(index) }));
const input = (count: number, overrides: Partial<CellGrant> = {}): CellGrant => ({ cell: CELL, epoch: 3, roster: ROSTER, labelSealed: LABEL, wraps: wraps(count), ...overrides });
type Page = SignedPayload<CellGrant>;
const reasonOf = (result: { ok: boolean; reason?: string }): string => (result.ok ? 'ok' : (result.reason as string));

test('hosted Finish forwards only the exact approved grant envelope in child and founding order', async () => {
  const draft = input(MAX_WRAPS_PER_V2_PAGE * 2 + 1);
  const context = {
    project: CELL, writer: LEAD.writer, predecessor: ROSTER, accessEntry: 'c'.repeat(64), accessRoot: 'd'.repeat(64),
    oldEpoch: 2, reason: 'clearance-lowered' as const, evidence: 'e'.repeat(64), policy: null,
    recipients: draft.wraps.map(({ writer }) => ({ writer, format: 2 as const })), continuity: []
  };
  const intent = createFinishIntent(context, draft);
  assert.ok(intent);
  const approved = intent.actionBytes();
  const altered = createFinishIntent(context, { ...draft, labelSealed: 'M'.repeat(64) });
  assert.ok(altered && !altered.actionBytes().equals(approved));
  draft.wraps[0].wrap = v2Wrap(90);
  assert.equal(intent.actionBytes().equals(approved), true);

  const [founding, ...children] = buildGrantPages(LEAD.signer, input(MAX_WRAPS_PER_V2_PAGE * 2 + 1));
  const exact = payloadSigningInput(children[0]);
  const ids: string[] = [];
  let current = true;
  let valid = true;
  let invalidateAfterReply = false;
  let badSignature = false;
  const action = 'fictional-finish-action';
  const signer = {
    ...LEAD.signer,
    canSignAction: (id: string, bytes: Uint8Array) => valid && id === action && approved.equals(bytes),
    async sign(bytes: Buffer, options?: SignOptions) {
      ids.push(options?.action ?? '');
      const result = badSignature ? LEAD.signer.sign(Buffer.from('different bytes')) : LEAD.signer.sign(bytes);
      bytes.fill(0);
      if (invalidateAfterReply) valid = false;
      return result;
    }
  };
  const scope = createFinishGrantScope(intent, signer, action, async () => current);
  const rejected = async (role: 'child' | 'founding', index: number, bytes: Buffer, count: number) => {
    assert.equal(typeof await scope.signerFor(role, index).sign(bytes), 'object');
    assert.equal(ids.length, count);
  };
  await rejected('founding', 0, payloadSigningInput(founding), 0);
  await rejected('child', 1, payloadSigningInput(children[1]), 0);
  await rejected('child', 0, payloadSigningInput({ ...children[0], purpose: 'staff-invite' }), 0);
  current = false;
  await rejected('child', 0, exact, 0);
  current = true;
  valid = false;
  await rejected('child', 0, exact, 0);
  valid = true;
  assert.equal(await scope.signerFor('child', 0).sign(exact), children[0].sig);
  assert.equal(exact.equals(payloadSigningInput(children[0])), true, 'the signer received a private copy');
  await rejected('child', 0, exact, 1);
  await rejected('child', 1, exact, 1);
  invalidateAfterReply = true;
  await rejected('child', 1, payloadSigningInput(children[1]), 2);
  invalidateAfterReply = false;
  valid = true;
  badSignature = true;
  await rejected('child', 1, payloadSigningInput(children[1]), 3);
  badSignature = false;
  assert.equal(await scope.signerFor('child', 1).sign(payloadSigningInput(children[1])), children[1].sig);
  await rejected('founding', 0, payloadSigningInput({ ...founding, payload: { ...founding.payload, pages: [] } }), 4);
  assert.equal(await scope.signerFor('founding', 0).sign(payloadSigningInput(founding)), founding.sig);
  await rejected('founding', 0, payloadSigningInput(founding), 5);
  assert.deepEqual(ids, Array.from({ length: 5 }, () => action));
});

test('hosted Finish fixes the unpaged envelope and rejects an unrelated approval before dispatch', async () => {
  const grant = input(1, { wraps: wraps(1, v1Wrap) });
  const intent = createFinishIntent({
    project: CELL, writer: LEAD.writer, predecessor: ROSTER, accessEntry: 'c'.repeat(64), accessRoot: 'd'.repeat(64),
    oldEpoch: 2, reason: 'device-revoked', evidence: 'e'.repeat(64), policy: null,
    recipients: grant.wraps.map(({ writer }) => ({ writer, format: 1 })), continuity: []
  }, grant);
  assert.ok(intent);
  const [page] = buildGrantPages(LEAD.signer, grant);
  const ids: string[] = [];
  const signer = { ...LEAD.signer, canSignAction: (id: string, bytes: Uint8Array) => id === 'reviewed-finish' && intent.actionBytes().equals(bytes),
    async sign(bytes: Buffer, options?: SignOptions) { ids.push(options?.action ?? ''); return LEAD.signer.sign(bytes); } };
  const other = createFinishGrantScope(intent, signer, 'reviewed-removal', async () => true);
  assert.equal(typeof await other.signerFor('founding', 0).sign(payloadSigningInput(page)), 'object');
  assert.deepEqual(ids, []);
  const reviewed = createFinishGrantScope(intent, signer, 'reviewed-finish', async () => true);
  assert.equal(await reviewed.signerFor('founding', 0).sign(payloadSigningInput(page)), page.sig);
  assert.deepEqual(ids, ['reviewed-finish']);
});

test('hosted Finish permits are fixed by the verified grant hash and selected session bindings', async () => {
  const grant = input(1, { wraps: wraps(1, v1Wrap) });
  const writer = grant.wraps[0].writer;
  const sessionKey = fixedSigner('hosted-finish-permit-session');
  const session = { writer: sessionKey.writer, device: writer, hash: '1'.repeat(64), sessionKey: sessionKey.publicKey,
    slot: 1, member: 'mbr-reader', notAfter: '2026-11-26T00:00:00.000Z', roster: ROSTER };
  const priorRevision = '2'.repeat(64);
  const context = {
    project: CELL, writer: LEAD.writer, predecessor: ROSTER, accessEntry: 'c'.repeat(64), accessRoot: 'd'.repeat(64),
    priorRevision, oldEpoch: 2, reason: 'device-revoked' as const, evidence: 'e'.repeat(64), policy: null,
    recipients: [{ writer, format: 1 as const }],
    continuity: [{ cell: CELL, epoch: grant.epoch, devices: [writer], sessions: [session] }]
  };
  const intent = createFinishIntent(context, grant);
  assert.ok(intent);
  const [page] = buildGrantPages(LEAD.signer, grant);
  const operation = { cell: grant.cell, epoch: grant.epoch, grant: grantHash(page), reason: context.reason };
  const revision = accessRevisionId(CELL, priorRevision, ROSTER, 'cell.rekey', operation);
  const direct = { project: CELL, revision, predecessor: ROSTER, cell: CELL, epoch: grant.epoch, authority: LEAD.writer, writer, device: writer, certificate: null };
  const certified = { ...direct, writer: session.writer, certificate: session.hash };
  const calls: string[] = [];
  const signer = { ...LEAD.signer, canSignAction: (_id: string, bytes: Uint8Array) => intent.actionBytes().equals(bytes),
    async sign(bytes: Buffer, options?: SignOptions) { calls.push(options?.action ?? ''); return LEAD.signer.sign(bytes); } };
  let current = true;
  const scope = createFinishGrantScope(intent, signer, 'reviewed-finish', async () => current);
  const permit = (index: number) => scope.signerFor('permit', index);
  const refuse = async (index: number, bytes: Buffer, count: number) => {
    assert.equal(typeof await permit(index).sign(bytes), 'object');
    assert.equal(calls.length, count);
  };
  await refuse(0, accessPermitBytes(direct), 0);
  assert.equal(scope.permitDrafts(), undefined);
  assert.equal(await scope.signerFor('founding', 0).sign(payloadSigningInput(page)), page.sig);
  assert.deepEqual(scope.permitDrafts(), [direct, certified]);
  assert.equal(scope.verifiedRekey(), undefined);
  await refuse(1, accessPermitBytes(certified), 1);
  await refuse(0, accessPermitBytes({ ...direct, revision: ROSTER }), 1);
  await refuse(0, accessPermitBytes({ ...direct, authority: writer }), 1);
  assert.equal(await permit(0).sign(accessPermitBytes(direct)), LEAD.signer.sign(accessPermitBytes(direct)));
  await refuse(0, accessPermitBytes(direct), 2);
  await refuse(1, accessPermitBytes({ ...certified, certificate: ROSTER }), 2);
  current = false;
  await refuse(1, accessPermitBytes(certified), 2);
  current = true;
  assert.equal(await permit(1).sign(accessPermitBytes(certified)), LEAD.signer.sign(accessPermitBytes(certified)));
  await refuse(1, accessPermitBytes(certified), 3);
  assert.deepEqual(calls, ['reviewed-finish', 'reviewed-finish', 'reviewed-finish']);
  assert.deepEqual(scope.verifiedRekey()?.operation, operation);
  assert.equal(scope.verifiedRekey()?.revision, revision);
});

test('tracer: 2,000 v2 wraps make four signed pages, each within GRANT_MAX_BYTES, and readGrantPages gives back all 2,000 and the label', () => {
  const pages = buildGrantPages(LEAD.signer, input(2000));
  assert.equal(pages.length, 4);
  for (const page of pages) assert.ok(canonicalBytes(page).length <= GRANT_MAX_BYTES);
  const [founding, ...others] = pages;
  assert.deepEqual(founding.payload.pages, others.map((page) => grantHash(page)).sort());
  for (const page of others) {
    assert.equal(page.payload.labelSealed, '');
    assert.deepEqual(page.payload.pages, []);
  }
  const read = readGrantPages(founding, [...others].reverse());
  assert.equal(reasonOf(read), 'ok');
  if (!read.ok) return;
  assert.equal(read.grant.wraps.length, 2000);
  assert.deepEqual(new Set(read.grant.wraps.map((wrap) => wrap.writer)).size, 2000);
  assert.equal(read.grant.labelSealed, LABEL);
  assert.equal(read.hash, grantHash(founding));
});

test('MAX_WRAPS_PER_V2_PAGE comes from GRANT_MAX_BYTES, the v2 wrap size and the longest label, and a full page with the longest label fits', () => {
  assert.equal(MAX_WRAPS_PER_V2_PAGE, 607);
  const longest = 'L'.repeat(MAX_LABEL_SEALED_CHARS);
  const [page] = buildGrantPages(LEAD.signer, input(MAX_WRAPS_PER_V2_PAGE, { labelSealed: longest }));
  assert.ok(canonicalBytes(page).length <= GRANT_MAX_BYTES);
  assert.equal(buildGrantPages(LEAD.signer, input(MAX_WRAPS_PER_V2_PAGE + 1)).length, 2);
});

test('400 v2 wraps make one page with an empty pages list, which readGrant reads as a grant', () => {
  const pages = buildGrantPages(LEAD.signer, input(400));
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].payload.pages, []);
  const read = readGrant(pages[0]);
  assert.equal(read.ok && read.grant.wraps.length, 400);
  assert.equal(reasonOf(readGrantPages(pages[0], [])), 'ok');
});

test('4,000 v1 wraps still make one v1 grant, exactly as buildGrant makes it, read exactly as today', () => {
  const grant = input(4000, { wraps: wraps(4000, v1Wrap) });
  const pages = buildGrantPages(LEAD.signer, grant);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], buildGrant(LEAD.signer, grant));
  assert.equal(Object.prototype.hasOwnProperty.call(pages[0].payload, 'pages'), false);
  const read = readGrant(pages[0]);
  assert.equal(read.ok && read.grant.wraps.length, 4000);
  assert.equal(read.ok && Object.prototype.hasOwnProperty.call(read.grant, 'pages'), false);
});

test('a v1 grant without pages still refuses a v2 wrap, so a v2 wrap only ever travels in a page', () => {
  const v1Shaped = signPayload(LEAD.signer, 'staff-cell-grant', input(2), { now: () => new Date(REPLICA_SIGNED_AT), maxBytes: GRANT_MAX_BYTES });
  assert.equal(reasonOf(readGrant(v1Shaped)), 'malformed');
  assert.ok(MAX_GRANT_WRAPS >= 2000);
});

test('a page changed after signing is refused page-bad-signature', () => {
  const [founding, second] = buildGrantPages(LEAD.signer, input(1000));
  const changed = JSON.parse(JSON.stringify(second)) as Page;
  changed.payload.wraps[0].wrap = v2Wrap(99);
  assert.equal(reasonOf(readGrantPages(founding, [changed])), 'page-bad-signature');
});

test('a page the founding page does not list is refused page-not-listed, and a listed page not given is page-missing', () => {
  const [founding, second] = buildGrantPages(LEAD.signer, input(1000));
  const [, stray] = buildGrantPages(LEAD.signer, input(1000, { wraps: wraps(1000).map((wrap, index) => ({ ...wrap, writer: writerAt(index + 5000) })) }));
  assert.equal(reasonOf(readGrantPages(founding, [second, stray])), 'page-not-listed');
  assert.equal(reasonOf(readGrantPages(founding, [])), 'page-missing');
});

test('a page from another epoch or another cell is refused page-other-epoch', () => {
  const [founding] = buildGrantPages(LEAD.signer, input(1000));
  const [, otherEpoch] = buildGrantPages(LEAD.signer, input(1000, { epoch: 4 }));
  const [, otherCell] = buildGrantPages(LEAD.signer, input(1000, { cell: streamId('another-cell') }));
  assert.equal(reasonOf(readGrantPages(forgeList(founding, otherEpoch), [otherEpoch])), 'page-other-epoch');
  assert.equal(reasonOf(readGrantPages(forgeList(founding, otherCell), [otherCell])), 'page-other-epoch');
});

// A founding page re-signed by the lead to list the given page, so the page's own fields are what is checked.
function forgeList(founding: Page, page: Page): Page {
  return signPayload(LEAD.signer, 'staff-cell-grant', { ...founding.payload, pages: [grantHash(page)] }, { now: () => new Date(REPLICA_SIGNED_AT), maxBytes: GRANT_MAX_BYTES });
}

test('the founding page\'s grant hash is stable: the same grant built twice gives the same hash, which is what a founding entry cites', () => {
  const first = buildGrantPages(LEAD.signer, input(1300));
  const second = buildGrantPages(LEAD.signer, input(1300));
  assert.equal(grantHash(first[0]), grantHash(second[0]));
  const read = readGrantPages(first[0], first.slice(1));
  assert.equal(read.ok && read.hash, grantHash(first[0]));
  for (const reason of Object.values(GRANT_PAGE_REFUSALS)) assert.ok(reason.length > 0);
});

// ---- the roster fold (Task 2) ----

const CELL_P = streamId('paged-cell');

interface PagedScene { world: RosterWorld; pat: RosterDevice; quinn: RosterDevice; founding: Page; page: Page; create: Written }

// The lead admits Pat and Quinn, then creates cell P with a two-page founding grant: the lead and Pat on the founding page, Quinn on the second.
// The pages are made directly with buildGrant so a small grant can span two pages; buildGrantPages splits only past MAX_WRAPS_PER_V2_PAGE.
function pagedScene(): PagedScene {
  const world = createRosterWorld();
  const pat = world.device('PAT-LAPTOP', 'mbr-pat');
  const quinn = world.device('QUINN-LAPTOP', 'mbr-quinn');
  const { entry: genesis } = world.genesis();
  let head = genesis.hash;
  for (const [device, slot] of [[pat, 2], [quinn, 3]] as const) {
    const id = `inv-${device.member}`;
    const invite = world.rosterEntry(world.lead, 'member.invite', { invite: id, name: 'Fictional Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret()) }, head);
    head = world.rosterEntry(world.lead, 'member.admit', { member: device.member, invite: id, name: 'Fictional Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: device.descriptor(slot), agentSeats: [] }, invite.hash).hash;
  }
  const key = world.epochKeyOf(CELL_P, 1);
  const wrapTo = (device: RosterDevice): GrantWrap => ({ writer: device.writer, wrap: wrapEpochKey({ cell: CELL_P, epoch: 1, writer: device.writer, recipient: device.x25519, epochKey: key }) });
  const page = buildGrant(world.lead.signer, { cell: CELL_P, epoch: 1, roster: head, labelSealed: '', wraps: [wrapTo(quinn)], pages: [] });
  const founding = buildGrant(world.lead.signer, { cell: CELL_P, epoch: 1, roster: head, labelSealed: LABEL, wraps: [wrapTo(world.lead), wrapTo(pat)], pages: [grantHash(page)] });
  const create = world.rosterEntry(world.lead, 'cell.create', { cell: CELL_P, epoch: 1, grant: grantHash(founding) }, head);
  return { world, pat, quinn, founding, page, create };
}

const granteesOf = (scene: PagedScene, grants: readonly unknown[]): readonly string[] | undefined => {
  const state = scene.world.foldRoster({ grants: [...scene.world.grants, ...grants] });
  return granteesAt(state.cells, CELL_P, state.positionOf.get(scene.create.hash) as number, () => true);
};

test('the fold places a cell.create whose grant hash is a founding page, with every page it lists: all three devices hold the epoch', () => {
  const scene = pagedScene();
  assert.deepEqual([...(granteesOf(scene, [scene.page, scene.founding]) ?? [])].sort(), [scene.world.lead.writer, scene.pat.writer, scene.quinn.writer].sort());
});

test('a page that has not arrived holds the founding grant missing-blob, and the epoch resolves once the page arrives', () => {
  const scene = pagedScene();
  const state = scene.world.foldRoster({ grants: [...scene.world.grants, scene.founding] });
  assert.ok(state.held.some((item) => item.hash === grantHash(scene.founding) && item.reason === 'missing-blob'));
  assert.equal(granteesOf(scene, [scene.founding]), undefined);
  assert.ok(granteesOf(scene, [scene.founding, scene.page])?.includes(scene.quinn.writer));
});

test('a changed page is refused and the founding grant is not placed', () => {
  const scene = pagedScene();
  const changed = JSON.parse(JSON.stringify(scene.page)) as Page;
  changed.payload.wraps[0].writer = scene.pat.writer;
  const state = scene.world.foldRoster({ grants: [...scene.world.grants, scene.founding, changed] });
  assert.ok(state.refused.some((item) => item.kind === 'grant' && item.reason === 'bad-signature'));
  assert.equal(granteesAt(state.cells, CELL_P, state.positionOf.get(scene.create.hash) as number, () => true), undefined);
});

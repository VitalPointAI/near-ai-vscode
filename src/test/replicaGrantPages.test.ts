// Grant pages (33.2-03 Task 1; 33.2-CONTEXT D-04, D-12): a cell-wrap/v2 epoch grant may span several signed pages. The founding page carries the
// sealed label and the sorted hashes of the other pages, so the founding entry's grant hash commits to every page. Wraps here only need the wire
// shape (the grant never opens them), so they are fictional bytes of the right size and version.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GRANT_MAX_BYTES, MAX_GRANT_WRAPS, MAX_LABEL_SEALED_CHARS, WRAP_BYTES, buildGrant, grantHash, readGrant } from '../domain/replica/cellKeys';
import type { CellGrant, GrantWrap } from '../domain/replica/cellKeys';
import { WRAP_V2_BYTES } from '../domain/replica/cellWrapV2';
import { GRANT_PAGE_REFUSALS, MAX_WRAPS_PER_V2_PAGE, buildGrantPages, readGrantPages } from '../domain/replica/grantPages';
import { canonicalBytes } from '../domain/team/canonical';
import { signPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { REPLICA_SIGNED_AT } from '../domain/replica/entry';
import { rosterDevice } from './helpers/replicaRosterWorld';
import { streamId } from './helpers/replicaWorld';

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

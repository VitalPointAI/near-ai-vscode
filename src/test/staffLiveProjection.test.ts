// The live projector (33-06 Task 3): product files that are not open follow the fold, written only over the text this device last projected, and a
// write that lands at any point while the projector writes is kept. Nothing is deleted.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { staffProductPath } from '../domain/staff/writeLimits';
import { appendProductEntry, proposeVersion } from '../staff/replica/labelCells';
import { lastProjectedFile, LAST_PROJECTED_FILE, projectLive } from '../staff/replica/liveProjection';
import { projectionInputOf } from '../staff/replica/migrate';
import { PROJECTION_LEFT_REASONS, productBodyOf, type ProjectionInput } from '../staff/replica/projection';
import { setCasProbe, type CasProbe } from '../staff/staffFiles';
import { leadWith } from './helpers/labelCellWorld';

const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
const RELATIVE = staffProductPath('j4', PRODUCT);

/** A shared product with a proposed first version and live text; `type` adds text the way another person's typing reaches this device. */
async function world() {
  const lead = await leadWith();
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? undefined : created.message);
  const { roster } = await lead.p.state();
  const clientId = clientIdOf(roster.members.devices.get(lead.writer)?.[0]?.slot ?? 1, 0);
  assert.ok((await appendProductEntry(lead.host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } })).ok);
  const doc = createLocalDoc(clientId);
  const type = async (text: string): Promise<void> => {
    const update = Buffer.from(localInsert(doc, docText(doc).length, text)).toString('base64url');
    assert.ok((await appendProductEntry(lead.host, 'doc.update', { product: PRODUCT, update })).ok);
  };
  await type('Fuel for three days.');
  const proposed = await proposeVersion(lead.host, {
    product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc)
  });
  assert.ok(proposed.ok, proposed.ok ? undefined : proposed.message);
  const options = { globalStorageDir: lead.at.global, project: lead.p.projectId };
  const file = path.join(lead.at.root, ...RELATIVE.split('/'));
  const input = (): Promise<ProjectionInput> => projectionInputOf(lead.p, lead.at.deps);
  const project = async (extra: { bound?: ReadonlySet<string> } = {}) => projectLive(lead.at.root, await input(), { ...options, ...extra });
  return { lead, type, input, options, file, project };
}

/** The same input with the product's live text output changed (text or problem), as a fold that read it so would give it. */
function withText(input: ProjectionInput, change: Partial<ProductTextOutput>): ProjectionInput {
  const docs = (input.fold.families.doc as ProductTextOutput[]).map((item) => (item.product === PRODUCT ? { ...item, ...change } : item));
  return { ...input, fold: { ...input.fold, families: { ...input.fold.families, doc: docs } } };
}

function onlyAt(point: Parameters<CasProbe>[0], act: (file: string) => Promise<void> | void): () => void {
  let done = false;
  setCasProbe(async (at, file) => { if (!done && at === point) { done = true; await act(file); } });
  return () => setCasProbe(undefined);
}

const leftovers = (file: string): string[] => readdirSync(path.dirname(file)).filter((name) => /\.(tmp|aside)$/.test(name));

test('tracer: another person\'s text reaches a product file that is not open, and the record names the text written', async () => {
  const { file, project, type, options } = await world();
  const first = await project();
  assert.deepEqual(first, { written: [RELATIVE], unchanged: [], left: [] });
  assert.equal(productBodyOf(readFileSync(file, 'utf8')), 'Fuel for three days.');
  await type(' Water for two.');
  const second = await project();
  assert.deepEqual(second, { written: [RELATIVE], unchanged: [], left: [] });
  assert.equal(productBodyOf(readFileSync(file, 'utf8')), 'Fuel for three days. Water for two.');
  assert.deepEqual(await project(), { written: [], unchanged: [RELATIVE], left: [] });
  const record = JSON.parse(readFileSync(lastProjectedFile(options.globalStorageDir, options.project), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['products', 'project', 'v']);
  assert.equal(record.project, options.project);
  assert.deepEqual(Object.keys(record.products as object), [PRODUCT]);
  assert.deepEqual(leftovers(file), []);
});

test('the record is a private file beside the server address and holds only hashes', async () => {
  const { project, options, file } = await world();
  await project();
  const recordFile = lastProjectedFile(options.globalStorageDir, options.project);
  assert.equal(path.basename(recordFile), LAST_PROJECTED_FILE);
  const text = readFileSync(recordFile, 'utf8');
  assert.doesNotMatch(text, /Fuel/);
  assert.match(text, /"[0-9a-f]{64}"/);
  if (process.platform !== 'win32') assert.equal(statSync(recordFile).mode & 0o777, 0o600);
  // A damaged record reads as empty: an unchanged file is still recognised, and the record is written again.
  writeFileSync(recordFile, '{not json');
  assert.deepEqual(await project(), { written: [], unchanged: [RELATIVE], left: [] });
  assert.ok(JSON.parse(readFileSync(recordFile, 'utf8')));
  assert.ok(existsSync(file));
});

test('a file edited outside a bound editor is left with the edit in it and listed', async () => {
  const { file, project, type } = await world();
  await project();
  const edited = `${readFileSync(file, 'utf8')}\nA note made in another editor.\n`;
  writeFileSync(file, edited);
  await type(' Water for two.');
  assert.deepEqual(await project(), { written: [], unchanged: [], left: [{ path: RELATIVE, reason: PROJECTION_LEFT_REASONS['text-changed'] }] });
  assert.equal(readFileSync(file, 'utf8'), edited);
});

test('with no record, only a header change is written (the Phase 30 rule); a different body is left', async () => {
  const { file, project } = await world();
  await project();
  const projected = readFileSync(file, 'utf8');
  // No record on this device (the conversion wrote the file): a file whose body is the fold's text and whose header is older is written.
  const fresh = await world();
  await mkdir(path.dirname(fresh.file), { recursive: true });
  const older = projected.replace(/^state: .*$/m, 'state: withdrawn');
  assert.notEqual(older, projected);
  writeFileSync(fresh.file, older);
  assert.deepEqual(await fresh.project(), { written: [RELATIVE], unchanged: [], left: [] });
  assert.equal(productBodyOf(readFileSync(fresh.file, 'utf8')), 'Fuel for three days.');
  const other = await world();
  await mkdir(path.dirname(other.file), { recursive: true });
  writeFileSync(other.file, 'A body this device never projected.\n');
  assert.deepEqual(await other.project(), { written: [], unchanged: [], left: [{ path: RELATIVE, reason: PROJECTION_LEFT_REASONS['text-changed'] }] });
  assert.equal(readFileSync(other.file, 'utf8'), 'A body this device never projected.\n');
});

test('a bound product is skipped, an incomplete text is left, and an empty product with no file stays without one', async () => {
  const { file, project, input, lead, options } = await world();
  assert.deepEqual(await project({ bound: new Set([PRODUCT]) }), { written: [], unchanged: [], left: [] });
  assert.equal(existsSync(file), false);
  const incomplete = await projectLive(lead.at.root, withText(await input(), { problem: 'missing-structs' } as Partial<ProductTextOutput>), options);
  assert.deepEqual(incomplete, { written: [], unchanged: [], left: [{ path: RELATIVE, reason: PROJECTION_LEFT_REASONS['text-incomplete'] }] });
  assert.deepEqual(await projectLive(lead.at.root, withText(await input(), { text: '' }), options), { written: [], unchanged: [], left: [] });
  assert.equal(existsSync(file), false);
});

test('a file replaced after the last comparison is put back, never written over', async () => {
  const { file, project, type } = await world();
  await project();
  await type(' Water for two.');
  const theirs = 'Their own text, saved by replacing the file.\n';
  const restore = onlyAt('before-rename', (target) => writeFile(target, theirs));
  try {
    assert.deepEqual(await project(), { written: [], unchanged: [], left: [{ path: RELATIVE, reason: PROJECTION_LEFT_REASONS.raced }] });
  } finally {
    restore();
  }
  assert.equal(readFileSync(file, 'utf8'), theirs);
  assert.deepEqual(leftovers(file), []);
});

test('a file created while the old one is aside stands, and a write into the old file after the swap is restored', async () => {
  const { file, project, type } = await world();
  await project();
  await type(' Water for two.');
  const created = 'A file another program created at that moment.\n';
  let restore = onlyAt('after-aside', (target) => writeFile(target, created, { flag: 'wx' }));
  try {
    assert.deepEqual((await project()).left, [{ path: RELATIVE, reason: PROJECTION_LEFT_REASONS.raced }]);
  } finally {
    restore();
  }
  assert.equal(readFileSync(file, 'utf8'), created);
  assert.deepEqual(leftovers(file), []);

  // A write through a handle opened before the swap lands in the old file, now held aside: it goes back over the new text.
  const second = await world();
  await second.project();
  await second.type(' Water for two.');
  const late = 'Saved through a handle opened before the swap.\n';
  restore = onlyAt('after-install', (target) => {
    const aside = readdirSync(path.dirname(target)).find((name) => name.endsWith('.aside'));
    assert.ok(aside);
    return writeFile(path.join(path.dirname(target), aside), late);
  });
  try {
    assert.deepEqual((await second.project()).left, [{ path: RELATIVE, reason: PROJECTION_LEFT_REASONS.raced }]);
  } finally {
    restore();
  }
  assert.equal(readFileSync(second.file, 'utf8'), late);
  assert.deepEqual(leftovers(second.file), []);
});

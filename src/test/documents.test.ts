import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { prepareAttachments, stageAttachment } from '../agent/attachments';
import { documentText } from '../agent/documents';

// Attached PDFs and Office files are read on this machine; only their text goes on.

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'documents');
const fixture = (name: string) => path.join(FIXTURES, name);

test('a PDF\'s text layer is read page by page', async () => {
  const staged = await stageAttachment(fixture('report.pdf'));
  assert.equal(staged.kind, 'document');
  assert.match(staged.text ?? '', /\[Page 1\]\nQuarterly Report\nThe project codename is HERON-2291\./);
  assert.match(staged.text ?? '', /North 1200/);
  assert.equal(staged.note, undefined);
});

test('a scanned PDF with no text layer says so instead of passing on nothing', async () => {
  const staged = await stageAttachment(fixture('scanned.pdf'));
  assert.equal(staged.text, '');
  assert.match(staged.note ?? '', /scanned\.pdf has no text layer/);
  const prepared = await prepareAttachments([staged], { client: {} as never, model: 'm', models: [], visionModel: 'v', transcriptionModel: 't', question: 'q' });
  assert.match(prepared.text, /<attachment name="scanned\.pdf" kind="document">\n\(No text could be read\. scanned\.pdf has no text layer/);
  assert.deepEqual(prepared.notes, [staged.note]);
});

test('Word documents keep paragraphs and table rows', async () => {
  const staged = await stageAttachment(fixture('report.docx'));
  assert.equal(staged.text, 'Quarterly Report\nThe project codename is HERON-2291.\nRevenue grew & costs fell.\nRegion | Units\nNorth | 1200\nSouth | 875');
});

test('Excel workbooks give every sheet by name, with cells in their columns', async () => {
  const staged = await stageAttachment(fixture('sales.xlsx'));
  assert.equal(staged.text, '## Sheet: Q3\nProduct\tUnits\nWidget\t42\nGadget\t7.5\n\n## Sheet: Notes\nAudit code KESTREL-7740');
});

test('PowerPoint decks give slides in order with their speaker notes', async () => {
  const staged = await stageAttachment(fixture('deck.pptx'));
  assert.equal(staged.text, '## Slide 1\nLaunch plan\nShip date is March 3\n\nNotes: Speaker note: mention ALBATROSS-3306\n\n## Slide 2\nRisks and owners');
});

/** A one-entry zip archive, as Office files are. */
function zip(entry: string, content: Buffer): Buffer {
  const data = deflateRawSync(content);
  const name = Buffer.from(entry);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const directoryOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test('a document that unpacks to more than 50 MB is refused rather than inflated', async () => {
  const bomb = zip('word/document.xml', Buffer.alloc(60 * 1024 * 1024, 0x20));
  assert.ok(bomb.length < 1024 * 1024, 'the archive itself is small');
  await assert.rejects(() => documentText(bomb, 'docx', 'bomb.docx'), /too large when unpacked/);
});

test('XML entities and character references are decoded, and damaged files fail clearly', async () => {
  const docx = zip('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>A &amp; B &lt;ok&gt; &#169; &#x263A;</w:t></w:r></w:p></w:body></w:document>'));
  assert.equal((await documentText(docx, 'docx', 'x.docx')).text, 'A & B <ok> © ☺');
  await assert.rejects(() => documentText(Buffer.from('not a zip at all'), 'xlsx', 'broken.xlsx'), /broken\.xlsx is not a valid Office file/);
  await assert.rejects(() => documentText(docx, 'xlsx', 'wrong.xlsx'), /wrong\.xlsx is missing xl\/workbook\.xml/);
  await assert.rejects(() => documentText(Buffer.from('%PDF-1.7 garbage'), 'pdf', 'broken.pdf'), /broken\.pdf could not be read as a PDF/);
});

test('old binary Office formats are refused with what to do instead', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-docs-'));
  for (const [file, modern] of [['budget.xls', '.xlsx'], ['memo.doc', '.docx'], ['talk.ppt', '.pptx']]) {
    await writeFile(path.join(dir, file), 'binary');
    await assert.rejects(() => stageAttachment(path.join(dir, file)), new RegExp(`old binary .* Save it as \\${modern}`));
  }
});

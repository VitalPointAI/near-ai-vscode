import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { RunCheckpoints } from '../agent/checkpoints';
import { documentText } from '../agent/documents';
import { createPresentation, decodeImage, imageSize, renderSvg, vectorize } from '../agent/graphics';
import { presentationTool, renderSvgTool, vectorizeTool } from '../agent/graphicsTools';
import { ShellSession } from '../agent/shell';
import type { ToolContext } from '../agent/tools';
import { readZip } from '../agent/zip';

// SVG rendering, image tracing, and .pptx decks, all made on this machine with vendored code.

const MEDIA = path.join(__dirname, '..', '..', 'test', 'fixtures', 'media');
const run = promisify(execFile);
const LOGO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="#1d4ed8"/><text x="100" y="115" font-size="40" font-family="Arial" text-anchor="middle" fill="white" font-weight="bold">NEAR</text></svg>');
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** Mean absolute difference per channel (0-255) between two same-size RGBA images. */
function difference(a: Uint8Array, b: Uint8Array): number {
  assert.equal(a.length, b.length);
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index] - b[index]);
  return total / a.length;
}

test('image sizes come from PNG, JPEG, GIF, and SVG headers', async () => {
  for (const [file, format] of [['build-code.png', 'png'], ['build-code.jpg', 'jpeg'], ['build-code.gif', 'gif']]) {
    assert.deepEqual(imageSize(await readFile(path.join(MEDIA, file))), { width: 640, height: 240, format }, file);
  }
  assert.deepEqual(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"></svg>')), { width: 48, height: 24, format: 'svg' });
  assert.throws(() => imageSize(Buffer.from('plain text')), /Not a PNG, JPEG, GIF, WebP, or SVG/);
});

test('SVG renders to PNG at the requested width, and text is drawn with the bundled font', async () => {
  const rendered = await renderSvg(LOGO, 400);
  assert.deepEqual([rendered.width, rendered.height], [400, 400]);
  assert.deepEqual([...rendered.png.subarray(0, 4)], PNG_MAGIC);
  const withoutText = await renderSvg(Buffer.from(LOGO.toString().replace(/<text[\s\S]*<\/text>/, '')), 400);
  assert.notDeepEqual(rendered.png, withoutText.png, 'the text changed the image, so a font was found');
  await assert.rejects(() => renderSvg(LOGO, 40_000), /over 50 megapixels/);
});

test('a traced image matches the original closely when rendered back', async () => {
  const original = await readFile(path.join(MEDIA, 'build-code.png'));
  const traced = await vectorize(original, { colors: 8 });
  assert.match(traced.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="640" height="240" viewBox="0 0 \d+ \d+">/);
  assert.ok(traced.paths > 20, `${traced.paths} shapes`);
  const before = await decodeImage(original);
  const after = await decodeImage((await renderSvg(Buffer.from(traced.svg), before.width)).png);
  const score = difference(before.pixels, after.pixels);
  assert.ok(score < 6, `mean channel difference ${score.toFixed(2)} should be small`);
  for (const file of ['build-code.jpg', 'build-code.gif']) assert.ok((await vectorize(await readFile(path.join(MEDIA, file)), { colors: 4, detail: 'low' })).paths > 5, file);
  await assert.rejects(() => vectorize(LOGO), /already an SVG/);
});

test('a deck keeps slides, text, notes, and SVG with a real PNG fallback', async () => {
  const deck = await createPresentation({
    title: 'Probe', theme: { accent: '#0f766e' },
    slides: [
      { title: 'Launch plan', subtitle: 'Q3 review' },
      { title: 'Plan', bullets: ['Ship March 3', { text: 'Owners named', level: 1 }], image: 'logo.svg', caption: 'Our logo', notes: 'Mention ALBATROSS' },
      { layout: 'image', title: 'Photo', image: 'shot.png' },
      { layout: 'two-column', title: 'Compare', columns: [{ heading: 'Before', bullets: ['slow'] }, { heading: 'After', bullets: ['fast'] }] }
    ]
  }, new Map([['logo.svg', { bytes: LOGO, name: 'logo.svg' }], ['shot.png', { bytes: await readFile(path.join(MEDIA, 'build-code.png')), name: 'shot.png' }]]));
  assert.equal(deck.slides, 4);
  assert.equal((await documentText(deck.bytes, 'pptx', 'deck.pptx')).text, '## Slide 1\nLaunch plan\nQ3 review\n\n## Slide 2\nPlan\nShip March 3\nOwners named\nOur logo\n\nNotes: Mention ALBATROSS\n\n## Slide 3\nPhoto\n\n## Slide 4\nCompare\nBefore\nslow\nAfter\nfast');
  const media = [...readZip(deck.bytes, 'deck')].filter(([name]) => name.startsWith('ppt/media/') && !name.endsWith('/'));
  assert.ok(media.some(([name]) => name.endsWith('.svg')), 'the SVG is embedded as SVG');
  for (const [name, read] of media.filter(([entry]) => entry.endsWith('.png'))) assert.deepEqual([...read().subarray(0, 4)], PNG_MAGIC, `${name} is a real PNG`);
  await assert.rejects(() => createPresentation({ slides: [{ image: 'missing.png' }] }, new Map()), /missing\.png was not loaded/);
});

test('LibreOffice opens the generated deck with every slide', { skip: existsSync('/usr/bin/soffice') ? false : 'LibreOffice is not installed', timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-deck-'));
  const deck = await createPresentation({ slides: [{ title: 'One' }, { title: 'Two', bullets: ['a', 'b'], image: 'logo.svg' }, { title: 'Three', text: 'end' }] }, new Map([['logo.svg', { bytes: LOGO, name: 'logo.svg' }]]));
  await writeFile(path.join(dir, 'deck.pptx'), deck.bytes);
  await run('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'deck.pptx')], { timeout: 170_000 });
  const pdf = await readFile(path.join(dir, 'deck.pdf'));
  assert.equal((await documentText(pdf, 'pdf', 'deck.pdf')).pages, 3);
});

function toolContext(root: string): ToolContext {
  return { root, checkpoints: new RunCheckpoints(`gfx-${Date.now()}`), shell: new ShellSession(root), readFiles: new Set(), signal: new AbortController().signal, onTodos: () => undefined };
}

test('the tools read and write only inside the workspace, ask before protected writes, and can be reverted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gfx-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', 'logo.png'), await readFile(path.join(MEDIA, 'build-code.png')));
  await writeFile(path.join(root, 'assets', 'mark.svg'), LOGO);
  const context = toolContext(root);
  try {
    assert.match(await vectorizeTool.run(vectorizeTool.parse({ image_path: 'assets/logo.png', output_path: 'assets/logo.svg', colors: 4 }), context), /Saved assets\/logo\.svg: 640×240/);
    assert.match(await renderSvgTool.run(renderSvgTool.parse({ svg_path: 'assets/mark.svg', output_path: 'assets/mark.png', width: 64 }), context), /Saved assets\/mark\.png: 64×64 PNG/);
    const deck = presentationTool.parse({ output_path: 'deck.pptx', slides: [{ title: 'Hello', image: 'assets/logo.svg' }] });
    assert.match(await presentationTool.run(deck, context), /Saved deck\.pptx: 1 slides/);
    const preview = await presentationTool.preview!(deck, context);
    assert.match(preview.kind === 'note' ? preview.text : '', /1\. Hello \[assets\/logo\.svg\]/);
    await assert.rejects(() => vectorizeTool.run(vectorizeTool.parse({ image_path: '../outside.png', output_path: 'x.svg' }), context), /outside the workspace/);
    assert.throws(() => vectorizeTool.parse({ image_path: 'a.png', output_path: 'a.png' }), /must end in \.svg/);
    assert.match(String(await renderSvgTool.sensitive!(renderSvgTool.parse({ svg_path: 'assets/mark.svg', output_path: '.git/hooks/x.png' }), context)), /inside \.git/);
    assert.equal(await renderSvgTool.sensitive!(renderSvgTool.parse({ svg_path: 'assets/mark.svg', output_path: 'out.png' }), context), undefined);
    await context.checkpoints.revert();
    for (const file of ['assets/logo.svg', 'assets/mark.png', 'deck.pptx']) assert.equal(existsSync(path.join(root, file)), false, `${file} is removed by Revert`);
  } finally {
    context.shell.dispose();
  }
});

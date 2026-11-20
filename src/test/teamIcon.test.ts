import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTeamIcon, decodeIconBase64, iconDataUri, iconPixelProblem, iconReference, iconSourceProblem, iconSourceSize, iconSourceType, MAX_TEAM_ICON_BYTES, teamIconPrompt, withIconReference } from '../agent/teamIcon';
import { draftFromMarkdown, teamMarkdown } from '../agent/teamMarkdown';
import { parseTeam, renderTeam, TeamLibrary } from '../agent/teams';
import { parseFrontmatter } from '../gsd/library';
import { JPEG, jpegOfSize, png, SVG, WEBP, webpOfSize } from './iconFixtures';

// Team icons (0.4.30, owner 2026-11-17: "give user ability to upload or AI generate an icon for the team. Ensure there's a default icon available if none
// are selected/generated"). An icon is a 128 x 128 PNG beside the team's Markdown, named from its front matter; the host checks every byte it writes.

test('a team icon is exactly a 128 x 128 PNG of at most 64 KB, undamaged, with nothing in it but the picture', () => {
  assert.equal(checkTeamIcon(png()), undefined);
  assert.equal(checkTeamIcon(png(128, 128, { extra: [['sRGB', Buffer.from([0])], ['pHYs', Buffer.alloc(9)]] })), undefined, 'colour and size notes are fine');
  assert.match(checkTeamIcon(JPEG)!, /not a PNG/);
  assert.match(checkTeamIcon(SVG)!, /not a PNG/);
  assert.match(checkTeamIcon(Buffer.alloc(0))!, /not a PNG/);
  assert.match(checkTeamIcon(png(64, 64))!, /64 x 64 pixels; a team icon is 128 x 128/);
  assert.match(checkTeamIcon(png(128, 96))!, /128 x 96 pixels/);
  const big = png(128, 128, { noise: true });
  assert.ok(big.length > MAX_TEAM_ICON_BYTES, 'noise does not compress');
  assert.match(checkTeamIcon(big)!, /larger than 64 KB/);
  assert.match(checkTeamIcon(png(128, 128, { extra: [['tEXt', Buffer.from('Comment\0hello')]] }))!, /carries data other than the picture/);
  assert.match(checkTeamIcon(png(128, 128, { extra: [['eXIf', Buffer.alloc(8)]] }))!, /carries data other than the picture/);
  const damaged = Buffer.from(png()); damaged[damaged.length - 20] ^= 0xff;
  assert.match(checkTeamIcon(damaged)!, /damaged/);
  assert.match(checkTeamIcon(Buffer.concat([png(), Buffer.from('<script>')]))!, /damaged/, 'nothing after the end');
  assert.match(checkTeamIcon(png().subarray(0, 60))!, /damaged/, 'cut short');
});

test('an uploaded image is recognised by its bytes: PNG, JPEG and WebP only, so an SVG (which can carry script) is never accepted', () => {
  assert.equal(iconSourceType(png()), 'image/png');
  assert.equal(iconSourceType(JPEG), 'image/jpeg');
  assert.equal(iconSourceType(WEBP), 'image/webp');
  assert.equal(iconSourceType(SVG), undefined);
  assert.equal(iconSourceType(Buffer.from('GIF89a......')), undefined);
  assert.equal(iconSourceType(Buffer.from('not an image')), undefined);
});

test('the page sends an icon as strict base64 within the size cap, and the page is sent it as a PNG data URI', () => {
  const bytes = png();
  assert.deepEqual(decodeIconBase64(bytes.toString('base64')), bytes);
  for (const bad of [undefined, 42, '', 'not base64!', 'aGVsbG8=\n', `${'A'.repeat(MAX_TEAM_ICON_BYTES * 2)}`]) assert.equal(decodeIconBase64(bad), undefined, String(bad).slice(0, 20));
  assert.equal(iconDataUri(bytes), `data:image/png;base64,${bytes.toString('base64')}`);
});

test('the AI prompt is built from the team\'s name and purpose only, made plain and capped', () => {
  const prompt = teamIconPrompt({ name: 'Web team', description: 'Builds pages <script>' });
  assert.match(prompt, /"Web team"/);
  assert.match(prompt, /Builds pages ‹script›/);
  assert.match(prompt, /No text, letters or numbers/);
  assert.ok(teamIconPrompt({ name: 'x'.repeat(500), description: 'y'.repeat(5000) }).length < 800);
  assert.doesNotMatch(teamIconPrompt({ name: 'A\nB', description: 'C\u2028D' }), /[\n\u2028]/);
});

const TEAM = renderTeam('Web team', 'Builds pages', [{ name: 'dev', instructions: 'Build it.' }]);

test('the icon line in the front matter: added after the description, replaced, removed, every other byte kept; older versions still read the team', () => {
  const withIcon = withIconReference(TEAM, 'web-team.icon.png');
  assert.match(withIcon, /^---\nname: Web team\ndescription: Builds pages\nicon: web-team\.icon\.png\n---\n/);
  assert.equal(withIcon.replace('icon: web-team.icon.png\n', ''), TEAM);
  assert.equal(withIconReference(withIcon, 'web-team.icon.png'), withIcon, 'unchanged when it already says so');
  assert.equal(withIconReference(withIconReference(withIcon, 'other.icon.png'), undefined), TEAM);
  assert.equal(withIconReference(TEAM, undefined), TEAM);
  const crlf = TEAM.replace(/\n/g, '\r\n');
  assert.equal(withIconReference(crlf, 'a.icon.png'), withIcon.replace('web-team', 'a').replace(/\n/g, '\r\n'));
  // A build that knows nothing of icons reads the same team, and the studio's save keeps the line.
  assert.deepEqual(parseTeam(withIcon, '/t/web-team.md'), parseTeam(TEAM, '/t/web-team.md'));
  const draft = draftFromMarkdown(withIcon, '/t/web-team.md');
  assert.match(teamMarkdown({ ...draft, description: 'Builds and tests pages' }, withIcon), /\nicon: web-team\.icon\.png\n/);
});

async function library() {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-icons-'));
  const lib = new TeamLibrary(path.join(base, 'global'));
  return { base, lib };
}

test('library: an icon is a PNG beside the team file, named in its front matter; changing or removing one keeps the old one in its history', async () => {
  const { lib } = await library();
  const file = await lib.create('Web team', TEAM);
  assert.equal(await lib.readIcon(file), undefined, 'no icon yet');
  const first = png(128, 128, { seed: 1 });
  const set = await lib.setIcon(file, first);
  assert.equal(set.textChanged, true);
  assert.equal(TeamLibrary.iconName(file), 'web-team.icon.png');
  assert.deepEqual(await readFile(path.join(lib.directory, 'web-team.icon.png')), first);
  assert.match(await readFile(file, 'utf8'), /\nicon: web-team\.icon\.png\n/);
  assert.equal((await lib.versions(file)).length, 2, 'the team file\'s change is a version, as every save is');
  assert.deepEqual(await lib.readIcon(file), first);
  assert.deepEqual(await lib.iconVersions(file), [], 'nothing replaced yet');
  // A second icon: the first is kept in the history.
  const second = png(128, 128, { extra: [['sRGB', Buffer.from([0])]] });
  assert.equal((await lib.setIcon(file, second)).textChanged, false, 'the reference already names it');
  assert.deepEqual(await lib.readIcon(file), second);
  const history = await lib.iconVersions(file);
  assert.equal(history.length, 1);
  assert.deepEqual(await readFile(history[0]!), first);
  // Remove: the default again, the team file without the line, and the icon kept in the history.
  const removed = await lib.removeIcon(file);
  assert.equal(removed.removed, true);
  assert.equal(await lib.readIcon(file), undefined);
  assert.equal(existsSync(path.join(lib.directory, 'web-team.icon.png')), false);
  assert.doesNotMatch(await readFile(file, 'utf8'), /icon:/);
  assert.equal((await lib.iconVersions(file)).length, 2);
  // Restore an earlier one by its name in the history.
  await lib.restoreIcon(file, path.basename(history[0]!));
  assert.deepEqual(await lib.readIcon(file), first);
  await assert.rejects(() => lib.restoreIcon(file, '../web-team.md'), /no such icon/i);
  // The library still lists exactly its team files.
  assert.deepEqual((await lib.list()).map((entry) => path.basename(entry.file)), ['web-team.md']);
  // An invalid icon is refused before anything is written.
  await assert.rejects(() => lib.setIcon(file, png(64, 64)), /64 x 64/);
  assert.deepEqual(await lib.readIcon(file), first);
});

test('library: only the team\'s own icon file is ever read; a reference to another file, a path, or a damaged file shows the default', async () => {
  const { lib } = await library();
  const file = await lib.create('Web team', TEAM);
  const other = await lib.create('Other team', renderTeam('Other team', 'x', [{ name: 'dev', instructions: 'Do.' }]));
  await lib.setIcon(other, png());
  for (const reference of ['other-team.icon.png', '../other-team.icon.png', '/etc/passwd', 'web-team.icon.png/../other-team.icon.png']) {
    await writeFile(file, withIconReference(TEAM, reference));
    assert.equal(await lib.readIcon(file), undefined, reference);
  }
  await writeFile(file, withIconReference(TEAM, 'web-team.icon.png'));
  await writeFile(path.join(lib.directory, 'web-team.icon.png'), Buffer.from('<svg onload="x"/>'));
  assert.equal(await lib.readIcon(file), undefined, 'not a PNG');
  await writeFile(path.join(lib.directory, 'web-team.icon.png'), png(256, 256));
  assert.equal(await lib.readIcon(file), undefined, 'not 128 x 128');
});

test('library: the project team\'s icon sits beside .planning/.near-ai/team.md, with its own history', async () => {
  const { base, lib } = await library();
  const root = path.join(base, 'project');
  const file = TeamLibrary.projectTeamFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, TEAM);
  await lib.setIcon(file, png(128, 128, { seed: 3 }));
  assert.ok(existsSync(path.join(root, '.planning', '.near-ai', 'team.icon.png')));
  assert.match(await readFile(file, 'utf8'), /\nicon: team\.icon\.png\n/);
  await lib.setIcon(file, png());
  assert.equal((await lib.iconVersions(file)).length, 1);
  const library2 = await lib.create('team', TEAM);
  assert.deepEqual(await lib.iconVersions(library2), [], 'a library team named "team" has its own history');
});

test('library: archive moves the icon with the team (renaming its reference when the archive renames the team), restore brings it back, and duplicate copies it', async () => {
  const { lib } = await library();
  const icon = png(128, 128, { seed: 9 });
  const first = await lib.create('Web team', TEAM);
  await lib.setIcon(first, icon);
  const archived = await lib.archive(first);
  assert.equal(path.basename(archived), 'web-team.md');
  assert.deepEqual(await lib.readIcon(archived), icon, 'the archived team keeps its icon');
  assert.equal(existsSync(path.join(lib.directory, 'web-team.icon.png')), false);
  // A second team of the same name is archived as web-team-2: its icon and reference move with it.
  const second = await lib.create('Web team', TEAM);
  const otherIcon = png(128, 128, { extra: [['sRGB', Buffer.from([0])]] });
  await lib.setIcon(second, otherIcon);
  const archived2 = await lib.archive(second);
  assert.equal(path.basename(archived2), 'web-team-2.md');
  assert.match(await readFile(archived2, 'utf8'), /\nicon: web-team-2\.icon\.png\n/);
  assert.deepEqual(await lib.readIcon(archived2), otherIcon);
  assert.deepEqual(await lib.readIcon(archived), icon, 'the first archived team still has its own');
  const restored = await lib.restore(archived);
  assert.deepEqual(await lib.readIcon(restored), icon);
  const copy = await lib.duplicate(restored, 'Web copy');
  assert.deepEqual(await lib.readIcon(copy), icon, 'a duplicate has the same icon');
  assert.match(await readFile(copy, 'utf8'), /\nicon: web-copy\.icon\.png\n/);
  assert.deepEqual((await readdir(lib.directory)).filter((name) => name.endsWith('.png')).sort(), ['web-copy.icon.png', 'web-team.icon.png']);
});

// ---------- PR #82 review ----------

test('the icon line: one parser picks the first icon: line for reading and writing, and writing leaves exactly one', () => {
  const lines = (text: string) => text.split('\n').filter((line) => line.startsWith('icon:'));
  // Zero lines.
  assert.equal(iconReference(TEAM), undefined);
  assert.deepEqual(lines(withIconReference(TEAM, 'a.icon.png')), ['icon: a.icon.png']);
  // One line.
  const one = withIconReference(TEAM, 'a.icon.png');
  assert.equal(iconReference(one), 'a.icon.png');
  assert.deepEqual(lines(withIconReference(one, 'b.icon.png')), ['icon: b.icon.png']);
  assert.deepEqual(lines(withIconReference(one, undefined)), []);
  // Two lines (a hand edit): the first is the reference, and any write leaves one line.
  const two = one.replace('icon: a.icon.png\n', 'icon: a.icon.png\nicon: stale.icon.png\n');
  assert.equal(iconReference(two), 'a.icon.png', 'the first line, for reading as for writing');
  assert.deepEqual(lines(withIconReference(two, 'a.icon.png')), ['icon: a.icon.png'], 'normalised even when the first already says so');
  assert.deepEqual(lines(withIconReference(two, 'b.icon.png')), ['icon: b.icon.png']);
  assert.deepEqual(lines(withIconReference(two, undefined)), []);
  assert.equal(withIconReference(two, undefined), TEAM);
});

test('library: a failed team-file write puts the icon back as it was; a failed put-back says exactly what is left', async () => {
  const { lib } = await library();
  const file = await lib.create('Web team', TEAM);
  const patched = lib as unknown as { setReference: (...args: unknown[]) => Promise<unknown>; restoreIconFile: (...args: unknown[]) => Promise<unknown> };
  const realReference = patched.setReference.bind(lib);
  patched.setReference = async () => { throw new Error('disk full'); };
  // No icon before: none after.
  await assert.rejects(() => lib.setIcon(file, png()), /disk full/);
  assert.equal(existsSync(path.join(lib.directory, 'web-team.icon.png')), false);
  assert.deepEqual(await lib.iconVersions(file), []);
  // An icon before (named in the file): it is still there, and nothing was added to History.
  patched.setReference = realReference;
  const first = png(128, 128, { seed: 21 });
  await lib.setIcon(file, first);
  patched.setReference = async () => { throw new Error('disk full'); };
  await assert.rejects(() => lib.removeIcon(file), /disk full/);
  assert.deepEqual(await lib.readIcon(file), first, 'Remove that failed leaves the icon');
  assert.deepEqual(await lib.iconVersions(file), []);
  // The put-back fails too: the error says what is on disk now.
  patched.setReference = realReference;
  await writeFile(file, withIconReference(await readFile(file, 'utf8'), undefined));
  patched.setReference = async () => { throw new Error('disk full'); };
  patched.restoreIconFile = async () => { throw new Error('gone'); };
  await assert.rejects(() => lib.setIcon(file, png(128, 128, { seed: 22 })), (error: Error) => error.name === 'TeamIconPartialError' && /The new icon file was written, but the team file could not be changed to name it, and the earlier icon file could not be put back/.test(error.message));
});

// ---------- PR #82 review, round 2: the icon line never lands inside a value ----------

test('the icon line goes after a one-line description, never inside a block or quoted value, and the team reads the same', () => {
  const body = '\n## dev\n\nBuild it.\n';
  const cases: Array<[string, string]> = [
    ['one line', '---\nname: Web team\ndescription: Builds pages\nowner: me\n---\n'],
    ['a literal block', '---\nname: Web team\ndescription: |\n  Builds pages\n  and tests them\nowner: me\n---\n'],
    ['a folded block', '---\nname: Web team\ndescription: >-\n  Builds pages\n  and tests them\n---\n'],
    ['a quoted value over two lines', '---\nname: Web team\ndescription: "Builds pages\n  and tests them"\nowner: me\n---\n'],
    ['a plain value over two lines', '---\nname: Web team\ndescription: Builds pages\n  and tests them\n---\n'],
    ['no description', '---\nname: Web team\nowner: me\n---\n']
  ];
  for (const [what, head] of cases) {
    const text = `${head}${body}`;
    const after = withIconReference(text, 'web-team.icon.png');
    assert.equal(iconReference(after), 'web-team.icon.png', what);
    const { icon, ...rest } = parseFrontmatter(after).data;
    assert.equal(icon, 'web-team.icon.png', what);
    assert.deepEqual(rest, parseFrontmatter(text).data, `${what}: every other key reads the same`);
    assert.deepEqual(parseTeam(after, '/t/web-team.md'), parseTeam(text, '/t/web-team.md'), what);
    // The lines of the description's value stay together, with the icon line outside them.
    const lines = after.split('\n');
    const at = lines.indexOf('icon: web-team.icon.png');
    assert.ok(at > 0, what);
    assert.doesNotMatch(lines[at + 1] ?? '', /^\s+\S/, `${what}: no indented value line follows the icon line`);
    const described = lines.findIndex((line) => line.startsWith('description:'));
    if (described >= 0 && /^description: \S[^"|>]*$/.test(lines[described]!) && !/^\s/.test(lines[described + 1] ?? '')) assert.equal(at, described + 1, `${what}: right after a one-line description`);
    assert.equal(withIconReference(after, undefined), text, `${what}: removing it gives back the file`);
  }
});

// ---------- follow-up after 0.4.35: PR #82 review leftovers ----------

/** A PNG header that states `width` x `height` (a few bytes can state a huge picture): enough for the size check, which reads only the header. */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12, 'latin1'); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  header[24] = 8; header[25] = 6;
  return header;
}

test('a picture\'s pixel size is read from its header and capped before the page ever decodes it (a decompression bomb is refused)', () => {
  assert.deepEqual(iconSourceSize(png(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(iconSourceSize(JPEG), { width: 16, height: 16 });
  assert.deepEqual(iconSourceSize(jpegOfSize(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(iconSourceSize(WEBP), { width: 16, height: 16 });
  assert.deepEqual(iconSourceSize(webpOfSize(1792, 1024)), { width: 1792, height: 1024 });
  // A phone photo and an image model's picture are fine.
  for (const ok of [png(300, 200), JPEG, jpegOfSize(4032, 3024), webpOfSize(1792, 1024), webpOfSize(4096, 4096)]) assert.equal(iconSourceProblem(ok), undefined);
  // A tiny file stating a huge picture is refused, by pixels and by its longest side.
  for (const bomb of [pngHeader(50_000, 50_000), jpegOfSize(65_000, 65_000), webpOfSize(16_000, 16_000), pngHeader(5000, 5000), pngHeader(10_000, 10)]) {
    assert.ok(bomb.length < 100);
    assert.match(iconSourceProblem(bomb)!, /too large to make an icon from/);
  }
  // A header with no size it states (cut short, zero, or a frame that never comes) is refused as damaged, never decoded.
  for (const damaged of [png().subarray(0, 20), pngHeader(0, 10), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(18)])]) {
    assert.match(iconPixelProblem(damaged)!, /damaged/);
  }
});

test('library: when the new icon cannot be put in place, the old one stays the team\'s and History gets no copy of it (PR #82 review)', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a folder this user cannot write to' : false }, async () => {
  const { lib } = await library();
  const file = await lib.create('Web team', TEAM);
  const first = png(128, 128, { seed: 31 });
  const second = png(128, 128, { seed: 32 });
  await lib.setIcon(file, first);
  await lib.setIcon(file, second);
  const history = await lib.iconVersions(file);
  assert.equal(history.length, 1, 'the first icon is in History');
  // The team's folder can no longer be written to: the new icon file cannot be written, though History (its own folder) still can.
  await chmod(lib.directory, 0o555);
  try {
    await assert.rejects(() => lib.placeIcon(file, png(128, 128, { seed: 33 })));
  } finally { await chmod(lib.directory, 0o755); }
  assert.deepEqual(await lib.iconVersions(file), history, 'no copy of the icon that is still in place');
  assert.deepEqual(await lib.readIcon(file), second);
  assert.deepEqual((await readdir(lib.directory)).filter((name) => name.endsWith('.tmp')), [], 'no half-written file');
});

test('library: Duplicate makes the copy even when its icon cannot be copied, and says it has the default icon (PR #82 review)', async () => {
  const { lib } = await library();
  const file = await lib.create('Web team', TEAM);
  await lib.setIcon(file, png(128, 128, { seed: 41 }));
  const patched = lib as unknown as { setIcon: (...args: unknown[]) => Promise<unknown> };
  const real = patched.setIcon.bind(lib);
  patched.setIcon = async () => { throw new Error('disk full'); };
  const copied = await lib.duplicateTeam(file, 'Web copy');
  patched.setIcon = real;
  assert.equal(copied.icon, 'default');
  assert.ok(existsSync(copied.file));
  assert.equal(await lib.readIcon(copied.file), undefined, 'the copy shows the default icon');
  assert.equal(iconReference(await readFile(copied.file, 'utf8')), undefined);
  assert.equal((await lib.duplicateTeam(file, 'Web copy two')).icon, 'copied');
  assert.equal((await lib.duplicateTeam(copied.file, 'Plain copy')).icon, 'none');
});

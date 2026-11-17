import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTeamIcon, decodeIconBase64, iconDataUri, iconSourceType, MAX_TEAM_ICON_BYTES, teamIconPrompt, withIconReference } from '../agent/teamIcon';
import { draftFromMarkdown, teamMarkdown } from '../agent/teamMarkdown';
import { parseTeam, renderTeam, TeamLibrary } from '../agent/teams';
import { JPEG, png, SVG, WEBP } from './iconFixtures';

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

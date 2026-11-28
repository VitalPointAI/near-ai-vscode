// The Get Started page and the right-hand rail from the Defence preview, in a real browser against the built image (test/e2e/get-started.spec.ts),
// opened at 127.0.0.1 as the owner opens it. On an image that bundles the NEAR AI extension (the release target), the Team Studio and Chat
// shortcuts must show the extension's pages in their webviews, and a work-area page's Create button also creates a work area: the spec
// drives it, and this suite checks what was written to the workspace. The Release workflow runs it against the archived release image.
// Run it with `npm run test:container`; it is not part of `npm test`. Hygiene: test/helpers/docker.ts.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { containerName, freePort, mustRun, removeOwn, runContainer, runPlaywright, testImage, waitHealthy } from '../helpers/docker';

let image = '';

before(async () => {
  image = await testImage();
});

after(async () => {
  await removeOwn();
});

test('the rail shortcuts and the Get Started work-area cards are present and open their pages', async () => {
  const port = await freePort();
  const started = await runContainer('get-started', ['-d', '-p', `127.0.0.1:${port}:3000`,
    '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept', image]);
  assert.equal(started.code, 0, started.stderr);
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy('get-started', url);
  const name = containerName('get-started');
  const manifest = JSON.parse((await mustRun('docker', ['exec', name, 'node', '-e', `
    const fs = require('node:fs');
    const file = '/plugins/extension/package.json';
    console.log(JSON.stringify(fs.existsSync(file) ? { version: JSON.parse(fs.readFileSync(file, 'utf8')).version } : null));
  `])).stdout) as { version?: unknown } | null;
  const bundled = manifest !== null;
  const version = bundled ? manifest.version : '';
  assert.ok(typeof version === 'string' && (!bundled || version.length > 0), 'The bundled extension must declare a version.');
  // A hand-edited shared value must neither control Get Started nor suppress live User updates.
  const sharedSettings = ['/home/sterling/workspace/.theia/settings.json', '/home/sterling/workspace/.vscode/settings.json'];
  const sharedFixture = '{"sterling.displayLanguage":"fr-CA"}\n';
  await mustRun('docker', ['exec', name, 'node', '-e', `
    const fs = require('node:fs'), path = require('node:path');
    const [file, content] = process.argv.slice(1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: 'wx' });
  `, sharedSettings[0], sharedFixture]);
  const sharedSnapshot = async (): Promise<string> => (await mustRun('docker', ['exec', name, 'node', '-e', `
    const fs = require('node:fs');
    console.log(JSON.stringify(process.argv.slice(1).map(file => fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null)));
  `, ...sharedSettings])).stdout.trim();
  const beforeLanguageJourney = await sharedSnapshot();
  const title = 'Winter exercise';
  const result = await runPlaywright('get-started.spec.ts', {
    WORKBENCH_URL: url, STERLING_BUNDLED_EXTENSION: bundled ? '1' : '0',
    STERLING_BUNDLED_VERSION: version, STERLING_WORK_AREA_TITLE: title
  });
  assert.equal(result.code, 0, `Playwright failed:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  assert.equal(await sharedSnapshot(), beforeLanguageJourney, 'User language changes leave the shared preference files byte-for-byte intact.');
  if (!bundled) {
    assert.match(result.stdout, /\b5 passed\b/);
    assert.match(result.stdout, /\b3 skipped\b/, 'the development image skips the release webviews, Team Studio staff setup and work-area creation');
    return;
  }
  assert.match(result.stdout, /\b8 passed\b/);
  // On disk: one new work-area-<hex> folder in the workspace and nothing else, holding only the marker and its .gitignore, with the kind
  // and the title the person typed.
  const listing = await mustRun('docker', ['exec', name, 'node', '-e', `
    const fs = require('fs'), path = require('path');
    const root = '/home/sterling/workspace';
    const top = fs.readdirSync(root).filter((entry) => !entry.startsWith('.theia'));
    const area = path.join(root, top[0] ?? '');
    const near = path.join(area, '.planning', '.near-ai');
    console.log(JSON.stringify({ top, planning: fs.readdirSync(path.join(area, '.planning')), near: fs.readdirSync(near).sort(),
      marker: JSON.parse(fs.readFileSync(path.join(near, 'work-area.json'), 'utf8')) }));`]);
  const found = JSON.parse(listing.stdout) as { top: string[]; planning: string[]; near: string[]; marker: unknown };
  assert.equal(found.top.length, 1, `the workspace holds only the new work area: ${found.top.join(', ')}`);
  assert.match(found.top[0], /^work-area-[0-9a-f]{16}$/);
  assert.deepEqual(found.planning, ['.near-ai']);
  assert.deepEqual(found.near, ['.gitignore', 'work-area.json']);
  assert.deepEqual(found.marker, { version: 1, kind: 'training', title });
});

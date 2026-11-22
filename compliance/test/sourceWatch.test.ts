import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; import { test } from 'node:test'; import { normalizedHash } from '../src/import/lib/normalize.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
const read=(name:string)=>readFileSync(new URL('./fixtures/import/'+name,import.meta.url),'utf8');

test('watch CLI fetches registered sources and writes the report into a new directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'compliance-watch-'));
  const out = join(dir, 'nested', 'watch.json');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await main(['watch', '--out', out]), 0);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(report.sources.length > 0);
  assert.equal(fetch.mock.callCount(), report.sources.length);
  assert.ok(report.sources.every(({ result }: { result: string }) => result === 'moved'));
});
test('same main hashes across redeploy',()=>assert.equal(normalizedHash(read('family-page.html')),normalizedHash(read('family-page-redeployed.html')))); test('edited main changes hash',()=>assert.notEqual(normalizedHash(read('family-page.html')),normalizedHash(read('family-page-edited.html')))); test('hash has sha256 form',()=>assert.match(normalizedHash(read('family-page.html')),/^[a-f0-9]{64}$/)); test('normalization excludes server state',()=>assert.equal(normalizedHash('<main><script id="serverApp-state">a</script>x</main>'),normalizedHash('<main><script id="serverApp-state">b</script>x</main>'))); test('normalization retains changed text',()=>assert.notEqual(normalizedHash('<main>a</main>'),normalizedHash('<main>b</main>')));

import assert from 'node:assert/strict'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { test } from 'node:test'; import { isDirectInvocation, main } from '../src/cli.ts';
test('unknown command exits two',async()=>assert.equal(await main(['nosuch']),2)); test('missing command exits two',async()=>assert.equal(await main([]),2)); test('invalid command names exit two',async()=>assert.equal(await main(['../licence-check']),2)); test('registered cross-check validates its required paths', async()=>assert.equal(await main(['cross-check']),2));
test('direct TypeScript CLI invocation is recognized without import.meta.main', () => { const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const entry = path.join(root, 'src/cli.ts'); assert.equal(isDirectInvocation([process.execPath, entry, 'nosuch'], entry), true); assert.equal(isDirectInvocation([process.execPath, 'src/other.ts'], entry), false); });
test('resolve-check is a registered command', async () => {
  const profiles = fileURLToPath(new URL('../profiles/', import.meta.url));
  assert.equal(await main(['resolve-check', '--profiles', profiles, '--resolved', profiles]), 0);
});

#!/usr/bin/env node
// Writes the synthetic environment pack of a bundled scenario (WP-ENV): a DEM, a coastline and a weather forecast for its exercise frame, made
// deterministically from a seed by src/domain/staff/env/synthetic.ts. Needs no GDAL and no network. Run `npm run compile` first.
//
//   node scripts/generate-env-pack.mjs                  write resources/staff/env/iron-lantern/ with the bundled seed
//   node scripts/generate-env-pack.mjs --seed 7         another seed (a different pack; the manifest records the seed)
//   node scripts/generate-env-pack.mjs --check          write nothing; fail if the committed pack differs from what the seed makes
//
// The pack format is documented in docs/staff-env-packs.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const DIST = path.join(ROOT, 'dist', 'domain', 'staff');
if (!existsSync(path.join(DIST, 'env', 'synthetic.js'))) {
  console.error('Run `npm run compile` first: this script uses the compiled generator in dist/.');
  process.exit(2);
}
const { syntheticEnvPack, IRON_LANTERN_SEED, readEnvPack } = require(path.join(DIST, 'env', 'index.js'));
const { parseScenarioText } = require(path.join(DIST, 'scenario.js'));

const args = process.argv.slice(2);
const check = args.includes('--check');
const seedAt = args.indexOf('--seed');
const seed = seedAt >= 0 ? Number(args[seedAt + 1]) : IRON_LANTERN_SEED;
if (!Number.isSafeInteger(seed)) { console.error('--seed takes a whole number.'); process.exit(2); }

const scenarioId = 'iron-lantern';
const parsed = parseScenarioText(readFileSync(path.join(ROOT, 'resources', 'staff', 'scenarios', `${scenarioId}.json`), 'utf8'));
if (!parsed.ok) { console.error(`The bundled scenario did not load: ${JSON.stringify(parsed.errors ?? parsed).slice(0, 300)}`); process.exit(1); }
const files = syntheticEnvPack(parsed.value, { seed });
if (!files) { console.error('The scenario has no frame or outline to generate a pack for.'); process.exit(1); }

const out = path.join(ROOT, 'resources', 'staff', 'env', scenarioId);
const bytes = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
const valid = readEnvPack(bytes, { frame: parsed.value.region.frame, scenario: scenarioId });
if (!valid.ok) { console.error(`The generated pack does not validate:\n${valid.problems.join('\n')}`); process.exit(1); }

if (check) {
  const differ = Object.keys(files).filter((name) => !existsSync(path.join(out, name)) || readFileSync(path.join(out, name), 'utf8') !== files[name]);
  if (differ.length) { console.error(`The committed pack differs from seed ${seed}: ${differ.join(', ')}. Run node scripts/generate-env-pack.mjs and commit the result.`); process.exit(1); }
  console.log(`The committed pack matches seed ${seed}.`);
} else {
  mkdirSync(out, { recursive: true });
  let total = 0;
  for (const [name, text] of Object.entries(files)) { writeFileSync(path.join(out, name), text); total += Buffer.byteLength(text); }
  console.log(`Wrote ${Object.keys(files).length} files (${total.toLocaleString('en-US')} bytes) to ${path.relative(ROOT, out)} with seed ${seed}.`);
}

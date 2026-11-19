// Military symbols on the COP (WP-COP): every force in the starter scenario gets a code the vendored milsymbol draws as valid, with the frame of its
// affiliation and the standard light fills (UX concept 5.10), and a small set renders exactly as recorded (snapshots by hash). The vendored files match
// their recorded hashes and carry their licences.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildSidc, describeSymbol, FORCE_KIND_SYMBOLS, forceSidc, parseSidc, SYMBOL_ENTITIES } from '../domain/staff/cop';
import { parseScenarioText } from '../domain/staff/scenario';

const REPO = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(REPO, 'media', 'vendor');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ms = require(path.join(VENDOR, 'milsymbol', 'milsymbol.js')) as { Symbol: new (sidc: string, options?: Record<string, unknown>) => { isValid(): boolean; asSVG(): string; getMetadata(): { affiliation: string } } };

function starter() {
  const parsed = parseScenarioText(readFileSync(path.join(REPO, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}

/** The options the COP draws with (media/staff/copMap.js symbolOptions): the standard light fills by affiliation, never the civilian purple. */
const COP = { size: 30, civilianColor: false };
const FILLS: Record<string, string> = { Friend: 'rgb(128,224,255)', Hostile: 'rgb(255,128,128)', Neutral: 'rgb(170,255,170)', Unknown: 'rgb(255,255,128)' };

test('every force in the starter scenario has a symbol code that milsymbol draws as valid, in the frame and fill of its affiliation', () => {
  const scenario = starter();
  const sides = new Map(scenario.parties.map((party) => [party.id, party.side] as const));
  const expected = { friendly: 'Friend', 'host-nation': 'Friend', adversary: 'Hostile', neutral: 'Neutral', unknown: 'Unknown' } as const;
  for (const force of scenario.forces) {
    assert.ok(FORCE_KIND_SYMBOLS[force.kind], `${force.id}: kind "${force.kind}" has a symbol`);
    const side = sides.get(force.party)!;
    const sidc = forceSidc(force, side)!;
    const parsed = parseSidc(sidc);
    assert.ok(parsed.ok, `${force.id} ${sidc}`);
    if (force.echelon) assert.equal(parsed.ok && parsed.value.echelon, force.echelon, `${force.id} echelon`);
    const symbol = new ms.Symbol(sidc, COP);
    assert.equal(symbol.isValid(), true, `${force.id} ${sidc} is a symbol milsymbol knows`);
    const affiliation = symbol.getMetadata().affiliation;
    assert.equal(affiliation, expected[side], `${force.id} affiliation`);
    assert.ok(symbol.asSVG().includes(`fill="${FILLS[affiliation]}"`), `${force.id} has the ${affiliation} fill`);
  }
});

test('a small set of symbols renders exactly as recorded', () => {
  const snapshots: Record<string, string> = {
    '10031000161211020000': '487744c7dca34743d67b73fe93a184bf989726ea79ed38ce4333e41b58fa0984', // friend mechanized infantry battalion
    '10061002181100000000': '8b4e908437d48f834ebb2b2d55dff6bf9f6f2d5498bef5f9101d6f7399540215', // hostile brigade headquarters
    '10043000001401010000': 'f73f3b1487c416f6472a923e921e8567d12cc6ed447b87254e99173637fc0d33', // neutral cargo ship
    '10013000000000000000': '2ead9b8c33bb9a7fd9ce5d48acefc0a4f9295036d62ddf2be8f60684185e2ea3', // unknown surface contact
    '10031010161211010000': '7c23e1acfef70a331234abdd3834ad98d5ff75aee5beda2923d50823bad3999a' // planned friend amphibious battalion (dashed)
  };
  for (const [sidc, hash] of Object.entries(snapshots)) {
    const svg = new ms.Symbol(sidc, COP).asSVG();
    assert.equal(createHash('sha256').update(svg).digest('hex'), hash, `${sidc} renders as recorded`);
  }
  assert.match(new ms.Symbol('10031010161211010000', COP).asSVG(), /stroke-dasharray/, 'an anticipated symbol has a dashed frame');
});

test('every entity in the table draws as valid, codes round trip through words, and a code outside the table is refused', () => {
  for (const [set, entities] of Object.entries(SYMBOL_ENTITIES) as [keyof typeof SYMBOL_ENTITIES, Record<string, string>][]) {
    for (const entity of Object.keys(entities)) {
      const sidc = buildSidc({ identity: 'friend', set, entity });
      assert.equal(new ms.Symbol(sidc).isValid(), true, `${set} ${entity}`);
      const parsed = parseSidc(sidc);
      assert.ok(parsed.ok && parsed.value.entity === entity);
    }
  }
  assert.equal(describeSymbol({ identity: 'hostile', set: 'land-unit', entity: '121102', echelon: 'battalion' }), 'Hostile land unit, infantry, armoured or mechanized, battalion');
  // Joker and faker are the only exercise-context codes: a hostile in exercise context would draw as a friendly faker.
  assert.equal(buildSidc({ identity: 'faker', set: 'land-unit', entity: '121100' }).slice(2, 4), '16');
  assert.equal(buildSidc({ identity: 'hostile', set: 'land-unit', entity: '121100' }).slice(2, 4), '06');
  for (const bad of ['10261000161211000000', '10031000161211001200', '1003100016121100000', '13031000161211000000', '10031000991211000000', '10033000161205000000']) {
    assert.equal(parseSidc(bad).ok, false, bad);
  }
});

test('the vendored libraries match their recorded hashes, at exact versions, with their licences', () => {
  const vendored = JSON.parse(readFileSync(path.join(VENDOR, 'VENDORED.json'), 'utf8')) as { packages: Array<{ name: string; version: string; license: string; licenseFile: string }>; files: Record<string, string> };
  assert.deepEqual(vendored.packages.map((entry) => `${entry.name}@${entry.version} ${entry.license}`), ['maplibre-gl@6.16.0 BSD-3-Clause', 'milsymbol@3.0.5 MIT']);
  for (const [file, hash] of Object.entries(vendored.files)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(VENDOR, file))).digest('hex'), hash, `${file} is unchanged`);
  }
  assert.match(readFileSync(path.join(VENDOR, 'maplibre-gl', 'LICENSE.txt'), 'utf8'), /Redistribution and use in source and binary forms/);
  assert.match(readFileSync(path.join(VENDOR, 'milsymbol', 'LICENSE'), 'utf8'), /The MIT License/);
  assert.match(readFileSync(path.join(VENDOR, 'maplibre-gl', 'maplibre-gl.mjs'), 'utf8'), /@license 3-Clause BSD[\s\S]{0,120}v6\.16\.0/);
});

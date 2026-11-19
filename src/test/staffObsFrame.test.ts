// The exercise frame and the corrected IRON LANTERN geography (research note 11, 6.5; WP-OBS0): the frame sits over empty ocean near Point Nemo, the
// transform round trips, grid references read and write the same squares, the guard-scan box follows the frame, scenario version 2 carries the frame
// beside version 1, and with northings growing northward every "north of", "east of" and reach statement in the starter scenario now holds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { insidePolygon } from '../domain/staff/guardScan';
import {
  formatGridReference, FRAME_MAX_FROM_NEMO_KM, frameBox, frameProblem, greatCircleKm, gridCentre, gridErrorMetres, gridReferencesIn, gridToWgs84, insideFrame,
  parseGridReference, POINT_NEMO, POINT_NEMO_NEAREST_LAND_KM, wgs84ToGrid
} from '../domain/staff/obs/frame';
import type { ExerciseFrame, GridMetres } from '../domain/staff/obs/frame';
import { parseScenario, parseScenarioText, SCENARIO_FAILURES, scenarioFiles, scenarioJson } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';

const STARTER_TEXT = readFileSync(path.join(__dirname, '..', '..', 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8');

function starter(): Scenario {
  const parsed = parseScenarioText(STARTER_TEXT);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}
function edited(edit: (value: Record<string, any>) => void): Record<string, any> {
  const value = JSON.parse(STARTER_TEXT) as Record<string, any>;
  edit(value);
  return value;
}
function refusedWith(value: unknown, reason: keyof typeof SCENARIO_FAILURES, at?: string): void {
  const parsed = parseScenario(value);
  assert.equal(parsed.ok, false, 'expected a refusal');
  if (parsed.ok) return;
  assert.equal(parsed.reason, reason, parsed.message);
  if (at !== undefined) assert.equal(parsed.path, at);
}

function frameOf(scenario: Scenario): ExerciseFrame {
  assert.ok(scenario.region.frame, 'the starter scenario has a frame');
  return scenario.region.frame;
}

test('the starter frame sits over empty ocean with its centre on Point Nemo and a declared northward axis', () => {
  const frame = frameOf(starter());
  assert.equal(frame.grid, 'KQ');
  assert.equal(frame.axis, 'northings-increase-north');
  assert.equal(frameProblem(frame, 'KQ'), undefined);
  const centre = gridToWgs84(frame, { eastingMetres: 50_000, northingMetres: 50_000 });
  assert.ok(greatCircleKm(centre, POINT_NEMO) < 0.01, 'the frame centre is on Point Nemo');
  for (const corner of frameBox(frame)) {
    const km = greatCircleKm({ longitude: corner[0], latitude: corner[1] }, POINT_NEMO);
    assert.ok(km < 100, `corner ${km} km from Nemo`);
    assert.ok(POINT_NEMO_NEAREST_LAND_KM - km > 2000, 'well over 2,000 km of water to any land');
  }
});

test('the frame transform round trips both ways, and grid distance matches true distance within one percent', () => {
  const frame = frameOf(starter());
  for (let e = 0; e <= 100_000; e += 12_500) {
    for (let n = 0; n <= 100_000; n += 12_500) {
      const back = wgs84ToGrid(frame, gridToWgs84(frame, { eastingMetres: e, northingMetres: n }));
      assert.ok(Math.abs(back.eastingMetres - e) < 1e-6 && Math.abs(back.northingMetres - n) < 1e-6, `${e},${n}`);
    }
  }
  const point = { latitude: -48.9, longitude: -123.5 };
  const again = gridToWgs84(frame, wgs84ToGrid(frame, point));
  assert.ok(Math.abs(again.latitude - point.latitude) < 1e-12 && Math.abs(again.longitude - point.longitude) < 1e-12);
  const pairs: Array<[GridMetres, GridMetres]> = [
    [{ eastingMetres: 0, northingMetres: 0 }, { eastingMetres: 100_000, northingMetres: 0 }],
    [{ eastingMetres: 0, northingMetres: 0 }, { eastingMetres: 0, northingMetres: 100_000 }],
    [{ eastingMetres: 43_500, northingMetres: 15_500 }, { eastingMetres: 46_500, northingMetres: 36_500 }]
  ];
  for (const [a, b] of pairs) {
    const grid = Math.hypot(b.eastingMetres - a.eastingMetres, b.northingMetres - a.northingMetres) / 1000;
    const real = greatCircleKm(gridToWgs84(frame, a), gridToWgs84(frame, b));
    assert.ok(Math.abs(real - grid) / grid < 0.01, `${grid} km on the grid, ${real} km on the globe`);
  }
});

test('a frame is refused off the ocean, on another grid, with a bad square or too large', () => {
  const frame = frameOf(starter());
  assert.equal(frameProblem({ ...frame, origin: { latitude: 45.4, longitude: -75.7 } }, 'KQ'), 'not-ocean');
  assert.equal(frameProblem({ ...frame, origin: { latitude: POINT_NEMO.latitude + 10, longitude: POINT_NEMO.longitude } }, 'KQ'), 'not-ocean');
  assert.ok(FRAME_MAX_FROM_NEMO_KM < POINT_NEMO_NEAREST_LAND_KM);
  assert.equal(frameProblem(frame, 'ZZ'), 'wrong-grid');
  assert.equal(frameProblem({ ...frame, squareMetres: 0 }, 'KQ'), 'bad-square');
  assert.equal(frameProblem({ ...frame, squareMetres: 1.5 }, 'KQ'), 'bad-square');
  assert.equal(frameProblem({ ...frame, extent: { eastings: 0, northings: 10 } }, 'KQ'), 'bad-extent');
  assert.equal(frameProblem({ ...frame, extent: { eastings: 600, northings: 10 } }, 'KQ'), 'bad-extent');
  assert.equal(frameProblem({ ...frame, origin: { latitude: Number.NaN, longitude: 0 } }, 'KQ'), 'bad-origin');
});

test('grid references read four to ten figures, write back the same square, and carry their own error', () => {
  const frame = frameOf(starter());
  assert.deepEqual(parseGridReference('KQ 4614', 'KQ', 1000), { grid: 'KQ', eastingMetres: 46_000, northingMetres: 14_000, precisionMetres: 1000 });
  assert.deepEqual(parseGridReference('KQ 461142', 'KQ', 1000), { grid: 'KQ', eastingMetres: 46_100, northingMetres: 14_200, precisionMetres: 100 });
  assert.deepEqual(parseGridReference('KQ 461 142', 'KQ', 1000), parseGridReference('KQ 461142', 'KQ', 1000));
  assert.equal(parseGridReference('KQ 4614', 'ZZ', 1000), undefined);
  assert.equal(parseGridReference('KQ 46140', 'KQ', 1000), undefined);
  assert.equal(parseGridReference('KQ 46 1422', 'KQ', 1000), undefined);
  assert.equal(parseGridReference('KQ 48', 'KQ', 1000), undefined);
  for (const text of ['KQ 4614', 'KQ 461142', 'KQ 46121427', 'KQ 4612314271']) {
    const reference = parseGridReference(text, 'KQ', 1000)!;
    const figures = text.replace(/\D/g, '').length as 4 | 6 | 8 | 10;
    assert.equal(formatGridReference(frame, gridCentre(reference), figures), text);
  }
  assert.ok(Math.abs(gridErrorMetres(parseGridReference('KQ 4614', 'KQ', 1000)!) - 707.1) < 0.1);
  assert.deepEqual(gridReferencesIn('Beach AMBER, KQ 4136 to KQ 4336; the sea at KQ 48', 'KQ', 1000).map((r) => r.eastingMetres), [41_000, 43_000]);
});

test('the guard-scan box follows the frame: positions in the frame pass, a real place fails', () => {
  const frame = frameOf(starter());
  const box = frameBox(frame);
  const portCalder = gridToWgs84(frame, { eastingMetres: 46_500, northingMetres: 36_500 });
  assert.ok(insidePolygon([portCalder.longitude, portCalder.latitude], box));
  assert.ok(!insidePolygon([-75.7, 45.4], box));
  assert.ok(insideFrame(frame, { eastingMetres: 99_999, northingMetres: 0 }));
  assert.ok(!insideFrame(frame, { eastingMetres: 100_001, northingMetres: 0 }));
});

test('scenario version 2 carries the frame beside version 1, and both round trip', () => {
  const scenario = starter();
  assert.equal(scenarioJson(scenario).version, 2);
  const again = parseScenarioText(JSON.stringify(scenarioJson(scenario)));
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.value, scenario);
  const v1 = edited((value) => { value.version = 1; delete value.region.frame; });
  const read = parseScenario(v1);
  assert.ok(read.ok, read.ok ? '' : read.message);
  if (read.ok) {
    assert.equal(read.value.region.frame, undefined);
    assert.equal(scenarioJson(read.value).version, 1);
  }
  refusedWith(edited((value) => { value.version = 1; }), 'unknown-field', 'region.frame');
  refusedWith(edited((value) => { value.version = 3; }), 'wrong-format');
  refusedWith(edited((value) => { value.region.frame.axis = 'northings-increase-south'; }), 'unknown-value', 'region.frame.axis');
  refusedWith(edited((value) => { value.region.frame.origin = { latitude: 45.4, longitude: -75.7 }; }), 'frame', 'region.frame');
  refusedWith(edited((value) => { value.region.frame.grid = 'ZZ'; }), 'frame', 'region.frame');
  refusedWith(edited((value) => { value.region.frame.extent = { eastings: 40, northings: 100 }; }), 'outside-frame');
  refusedWith(edited((value) => { value.region.frame.extent.northings = 20; }), 'outside-frame', 'region.features[3].location');
  const region = scenarioFiles(scenario).find((file) => file.path.endsWith('region.md'))!.content;
  assert.match(region, /placed over empty ocean/);
  assert.ok(!/-?\d{1,3}\.\d{3,}/.test(region), 'region.md carries no coordinates');
});

// ---- The corrected geography ----------------------------------------------------------------------------------------------------------------

function places(scenario: Scenario): Map<string, GridMetres[]> {
  const frame = frameOf(scenario);
  const out = new Map<string, GridMetres[]>();
  const add = (id: string, location: string) => out.set(id, gridReferencesIn(location, frame.grid, frame.squareMetres).map(gridCentre));
  for (const feature of scenario.region.features) add(feature.id, feature.location);
  for (const force of scenario.forces) add(force.id, force.location);
  for (const measure of scenario.controlMeasures) add(measure.id, measure.location);
  return out;
}

test('with northings growing northward, every direction in the starter scenario holds', () => {
  const at = places(starter());
  const one = (id: string, index = 0): GridMetres => {
    const point = at.get(id)?.[index];
    assert.ok(point, `${id} has a grid reference`);
    return point;
  };
  const northOf = (a: string, b: string) => assert.ok(one(a).northingMetres > one(b).northingMetres, `${a} is north of ${b}`);
  const southOf = (a: string, b: string) => assert.ok(one(a).northingMetres < one(b).northingMetres, `${a} is south of ${b}`);
  const eastOf = (a: string, b: string) => assert.ok(one(a).eastingMetres > one(b).eastingMetres, `${a} is east of ${b}`);
  const westOf = (a: string, b: string) => assert.ok(one(a).eastingMetres < one(b).eastingMetres, `${a} is west of ${b}`);

  // AA OAK is "north of Saltmere": the finding of note 11, 6.5.
  northOf('aa-oak', 'saltmere');
  // Route IRON runs north from Saltmere through Ashby Ford to Port Calder, the north end.
  const route = at.get('route-iron')!;
  assert.equal(route.length, 3);
  assert.ok(route[0].northingMetres < route[1].northingMetres && route[1].northingMetres < route[2].northingMetres, 'Route IRON runs north');
  assert.deepEqual(route, [one('saltmere'), one('ashby-ford'), one('port-calder')]);
  // 1-41 MECH is along PL COPPER, 4 km south of Port Calder, north of Ashby Ford.
  northOf('e-1-41', 'ashby-ford');
  assert.ok(Math.abs(one('port-calder').northingMetres - 4000 - one('e-1-41').northingMetres) <= 1000, '1-41 MECH is about 4 km south of Port Calder');
  // The RECCE screen is south of the Brenn at the ford; the strait and Gull Island are north of the coast.
  southOf('f-recce', 'ashby-ford');
  northOf('gull-island', 'port-calder');
  northOf('n-orla', 'port-calder');
  eastOf('n-orla', 'port-calder');
  // East of Port Calder: the brigade headquarters, the hides and the coastal battery. East of Saltmere: 2 INF.
  for (const id of ['e-41', 'e-2-41', 'e-41-cstl-bty']) eastOf(id, 'port-calder');
  eastOf('f-2inf', 'saltmere');
  westOf('f-beacon', 'saltmere');
  // 41 ARTY is south of Kell; Kell is at the north-east end of Harrow Ridge, which runs south-west to north-east.
  southOf('e-41-arty', 'kell');
  const ridge = at.get('harrow-ridge')!;
  assert.ok(ridge[1].eastingMetres > ridge[0].eastingMetres && ridge[1].northingMetres > ridge[0].northingMetres, 'Harrow Ridge runs south-west to north-east');
  assert.ok(Math.hypot(one('kell').eastingMetres - ridge[1].eastingMetres, one('kell').northingMetres - ridge[1].northingMetres) <= 1500, 'Kell is at the north-east end');
  assert.deepEqual(one('kell'), one('kell-bridge'));
  // OBJ KITE and 3-41 ARMD are on the south spur, the south-west end of the ridge; the EW detachment is on the crest line.
  assert.deepEqual(one('obj-kite'), ridge[0]);
  assert.deepEqual(one('e-3-41'), ridge[0]);
  const [a, b] = ridge;
  const p = one('e-41-ew');
  const cross = Math.abs((b.eastingMetres - a.eastingMetres) * (p.northingMetres - a.northingMetres) - (b.northingMetres - a.northingMetres) * (p.eastingMetres - a.eastingMetres));
  assert.ok(cross / Math.hypot(b.eastingMetres - a.eastingMetres, b.northingMetres - a.northingMetres) <= 500, 'the EW detachment is on the crest');
  // Beach AMBER is 3 to 5 km west of Port Calder and about 2 km long; LA AMBER is the beach.
  const beach = at.get('beach-amber')!;
  for (const end of beach) {
    const west = one('port-calder').eastingMetres - end.eastingMetres;
    assert.ok(west >= 3000 && west <= 5000, `Beach AMBER end ${west} m west of Port Calder`);
  }
  assert.equal(Math.abs(beach[1].eastingMetres - beach[0].eastingMetres), 2000);
  assert.deepEqual(at.get('la-amber'), beach);
  assert.deepEqual(one('obj-falcon'), one('port-calder'));
  assert.deepEqual(one('aa-oak'), one('f-anvil'));
  // The Brenn marshes lie south of the river at the ford, and west of it.
  for (const end of at.get('brenn-marsh')!) {
    assert.ok(end.northingMetres < one('ashby-ford').northingMetres, 'the marshes are south of the Brenn at the ford');
    assert.ok(end.eastingMetres < one('ashby-ford').eastingMetres, 'the marshes are west of the ford');
  }
});

test('the reach statements hold: FD REGT covers Ashby Ford and not Port Calder; 41 ARTY covers the ford, Beach AMBER and the harbour', () => {
  const at = places(starter());
  const km = (a: GridMetres, b: GridMetres) => Math.hypot(a.eastingMetres - b.eastingMetres, a.northingMetres - b.northingMetres) / 1000;
  const first = (id: string) => at.get(id)![0];
  assert.ok(km(first('f-fdregt'), first('ashby-ford')) <= 25, 'FD REGT reaches Ashby Ford');
  assert.ok(km(first('f-fdregt'), first('port-calder')) > 25, 'FD REGT does not reach Port Calder');
  assert.ok(km(first('e-41-arty'), first('ashby-ford')) <= 20);
  for (const end of at.get('beach-amber')!) assert.ok(km(first('e-41-arty'), end) <= 20);
  assert.ok(km(first('e-41-arty'), first('port-calder')) <= 20);
});

test('every grid reference in the starter scenario lies inside its frame', () => {
  const scenario = starter();
  const frame = frameOf(scenario);
  let count = 0;
  for (const points of places(scenario).values()) {
    for (const point of points) {
      count += 1;
      assert.ok(insideFrame(frame, point));
      assert.ok(greatCircleKm(gridToWgs84(frame, point), POINT_NEMO) < 100);
    }
  }
  assert.ok(count >= 30, `${count} positions`);
});

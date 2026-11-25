// Phase 33 plan 30 (D-24, D-35, D-60, D-65; P9; criteria 1 to 3): two people, each in their own built Sterling workbench with their own OpenBao
// identity and workspace, share one staff project through one real hub container, in two real browsers. The world is test/helpers/staff-world.ts;
// the browser steps are test/e2e/staff-live.spec.ts, run once as one serial Playwright run, so the two sessions carry from step to step.
//
// The spec asks this process for sign-in tokens while it runs (a small token desk on 127.0.0.1), because a decision needs a sign-in fresh at the
// moment it is made (D-60) and the step-up checks need one that is too old. The desk signs only for the two test people, with the test key the dev
// OpenBao trusts.
//
//   diagnostic   co-edit, cursor names, own undo, the status entry and the offline banner (D-65: recorded, fixed in the owning plan's files)
//   blocking     the person-key step-up and nothing secret on the wire (authorization contracts). The contested card and changed while deciding
//                need a decision the native Staff Room cannot yet make (no decider role, submit or approve on a version in the native workbench);
//                they are open conditions of 33-30, not run here.
//
// After the run: no refused outbound connection in either workbench, and no token, key or JWT in either log.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mustRun, removeOwn, run, runPlaywright, suffix, testImage } from '../helpers/docker';
import { SECRET_MARKER, SECRET_PRODUCT, SEED_PRODUCT, startStaffWorld, type StaffPersonKey, type StaffWorld } from '../helpers/staff-world';
import { staffProductPath } from '../../../src/domain/staff/writeLimits.ts';

let world: StaffWorld;
let desk: http.Server;
let deskUrl = '';
let ownHubImage: string | undefined;
let report: Array<{ title: string; status: string; error?: string }> = [];
const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-staff-live-'));

/** The hub image: STERLING_HUB_TEST_IMAGE when set, otherwise built once from the repository root and removed after. */
async function hubImage(): Promise<string> {
  const given = process.env.STERLING_HUB_TEST_IMAGE?.trim();
  if (given) {
    await mustRun('docker', ['image', 'inspect', given]);
    return given;
  }
  ownHubImage = `sterling-hub:test-${suffix}`;
  await mustRun('docker', ['build', '-f', path.join('hub', 'Dockerfile'), '-t', ownHubImage, '.']);
  return ownHubImage;
}

before(async () => {
  world = await startStaffWorld({ image: await testImage(), hubImage: await hubImage(), portsFrom: Number(process.env.STAFF_WORLD_PORTS_FROM ?? 18900) });
  // GET /token?person=a|b&age=<seconds>&stepUp=0|1: a sign-in for that person, that many seconds old.
  desk = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    // POST /hub-stop and /hub-start: your organization's server goes away and comes back with its state.
    if (request.method === 'POST' && (url.pathname === '/hub-stop' || url.pathname === '/hub-start')) {
      void (url.pathname === '/hub-stop' ? world.stopHub() : world.startHub()).then(() => response.writeHead(204).end(), () => response.writeHead(500).end());
      return;
    }
    const key = url.searchParams.get('person');
    if (request.method !== 'GET' || url.pathname !== '/token' || (key !== 'a' && key !== 'b')) {
      response.writeHead(404).end();
      return;
    }
    const signed = world[key as StaffPersonKey].signedIn({ authAgeSeconds: Number(url.searchParams.get('age') ?? 0), stepUp: url.searchParams.get('stepUp') !== '0' });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(signed.headers));
  });
  await new Promise<void>((resolve) => desk.listen(0, '127.0.0.1', resolve));
  deskUrl = `http://127.0.0.1:${(desk.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (desk === undefined ? resolve() : desk.close(() => resolve())));
  // STAFF_WORLD_KEEP=1 leaves the world running for a person to look at after a failure; they remove it with docker rm and docker network rm.
  if (process.env.STAFF_WORLD_KEEP === '1') return;
  await world?.stop();
  await removeOwn();
  if (ownHubImage !== undefined) await run('docker', ['image', 'rm', '-f', ownHubImage]);
  rmSync(scratch, { recursive: true, force: true });
});

test('the staff-live browser run: co-edit, cursors, own undo, status, invitation step-up and nothing secret on the wire', { timeout: 1_800_000 }, async () => {
  const reportFile = path.join(scratch, 'report.json');
  const result = await runPlaywright('staff-live.spec.ts', {
    STAFF_A_URL: world.a.url, STAFF_B_URL: world.b.url, STAFF_TOKEN_DESK: deskUrl, STAFF_HUB_FILE: world.hubFile,
    STAFF_PRODUCT_PATH: staffProductPath(SEED_PRODUCT.section, SEED_PRODUCT.product),
    STAFF_SECRET_PATH: staffProductPath(SECRET_PRODUCT.section, SECRET_PRODUCT.product), STAFF_MARKER: SECRET_MARKER,
    STAFF_SECRETS: JSON.stringify(world.secrets), STAFF_DOWNLOADS: scratch,
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
  }, ['--reporter=list,json']);
  report = flatten(JSON.parse(readFileSync(reportFile, 'utf8')) as PlaywrightJson);
  assert.ok(report.length >= 6, `the staff-live spec ran ${report.length} tests:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-2000)}`);
  assert.equal(result.code, 0, `Playwright staff-live.spec.ts failed:\n${result.stdout.slice(-8000)}\n${result.stderr.slice(-3000)}`);
});

test('included authorization checks ran and passed: invitation step-up and nothing secret on the wire', () => {
  for (const name of ['invitation step-up', 'blocking: nothing secret']) {
    const found = report.find((item) => item.title.startsWith(name));
    assert.ok(found, `the blocking test "${name}" is in the report`);
    assert.equal(found.status, 'passed', `${name}: ${found.error ?? ''}`);
  }
});

test('nothing called out and nothing leaked: no refused connection, and no token, key or JWT in either workbench log', async () => {
  for (const person of [world.a, world.b]) {
    const { log, hook } = await world.logsOf(person);
    assert.ok(hook.some((line) => line.startsWith('allowed ')), `the hook was loaded in ${person.key}'s workbench`);
    assert.deepEqual(hook.filter((line) => line.startsWith('refused ')), [], `refused connections in ${person.key}'s workbench`);
    for (const secret of world.secrets) assert.ok(!log.includes(secret), `${person.key}'s log holds no token, key or JWT`);
    assert.doesNotMatch(log, /\b(?:s|hvs)\.[A-Za-z0-9]{20,}/, `${person.key}'s log holds no OpenBao token`);
  }
});

interface PlaywrightJson { suites?: PlaywrightSuite[] }
interface PlaywrightSuite { suites?: PlaywrightSuite[]; specs?: Array<{ title: string; tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }> }> }

function flatten(json: PlaywrightJson): Array<{ title: string; status: string; error?: string }> {
  const out: Array<{ title: string; status: string; error?: string }> = [];
  const walk = (suite: PlaywrightSuite): void => {
    for (const spec of suite.specs ?? []) {
      const last = spec.tests[0]?.results.at(-1);
      out.push({ title: spec.title, status: last?.status ?? 'missing', ...(last?.error?.message === undefined ? {} : { error: last.error.message }) });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of json.suites ?? []) walk(suite);
  return out;
}

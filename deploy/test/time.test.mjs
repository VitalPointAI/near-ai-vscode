// Time for air-gapped sites (D-71; AU-8, AU-8(1), SC-45). The chrony.conf every node gets from the site file, the refusals of bad time settings,
// and the clock verdict, which must be the same from Node (clockProblems, used on the import host) and from the node script (check-time.sh,
// sh and awk): both read the same `chronyc -c tracking` lines, three captured from a real chronyd on the air-gapped lab VM (47-22) and one derived.
// check-time.sh runs with a fake chronyc first on PATH; no test needs root or the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkHostClock, checkTimeSettings, chronyConf, clockProblems, parseTracking } from '../bundle/lib/clock.mjs';
import { loadSite } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const CI = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const withTime = (time) => ({ ...CI, time: { ...CI.time, ...time } });
const FIXTURES = ['synced', 'unsynced', 'local', 'far'];
const tracking = (name) => read(`deploy/test/fixtures/chrony/${name}.csv`).trim();
const LIMIT = { maxClockErrorMs: 1000 };

test('chronyConf on the CI site names exactly the site servers with iburst, and no pool or allow directive', () => {
  const conf = chronyConf(CI);
  const directives = conf.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(directives.filter((line) => line.startsWith('server ')), ['server time1.site.example iburst', 'server time2.site.example iburst']);
  for (const line of ['minsources 2', 'makestep 1 3', 'rtcsync', 'cmdport 0', 'driftfile /var/lib/chrony/drift']) assert.ok(directives.includes(line), line);
  assert.equal(directives.filter((line) => /^(pool|allow|peer|local|ntstrustedcerts)\b/.test(line)).length, 0, 'clients of the site sources only');
  assert.match(conf, /^# Generated from the site file/);
  // One source: no minsources 2, which a single source could never meet.
  assert.doesNotMatch(chronyConf(withTime({ servers: ['time1.site.example'] })), /minsources/);
  assert.match(chronyConf(withTime({ servers: [], refclocks: ['PHC /dev/ptp0 poll 2'] })), /^refclock PHC \/dev\/ptp0 poll 2$/m);
});

test('nts true adds the nts option to every server and trusts the site CA; nts false adds neither', () => {
  const on = chronyConf(withTime({ nts: true }));
  assert.deepEqual(on.split('\n').filter((line) => line.startsWith('server ')), ['server time1.site.example iburst nts', 'server time2.site.example iburst nts']);
  assert.match(on, /^ntstrustedcerts \/etc\/chrony-site-ca\.crt$/m);
  const off = chronyConf(withTime({ nts: false }));
  assert.doesNotMatch(off, /\bnts\b|ntstrustedcerts/);
});

test('bad time settings are refused: no source, a malformed server, a refclock outside PHC, SHM or SOCK, a non-positive limit', () => {
  assert.deepEqual(checkTimeSettings(CI), []);
  const none = checkTimeSettings(withTime({ servers: [], refclocks: [] }));
  assert.equal(none.length, 1);
  assert.match(none[0], /names no time source.*GNSS-disciplined NTP appliance or a stratum-1 server.*never an internet pool/);
  assert.throws(() => chronyConf(withTime({ servers: [], refclocks: [] })), /names no time source/);
  const { time: _time, ...noTime } = CI;
  assert.ok(checkTimeSettings(noTime).some((problem) => /names no time source/.test(problem)), 'a site file with no time object');
  for (const server of ['time1 site', '-bad.example', '999.1.1.1', 'pool.ntp.org; allow', 42]) {
    assert.ok(checkTimeSettings(withTime({ servers: [server] })).some((problem) => /is not a host name or an IP address/.test(problem)), String(server));
  }
  for (const server of ['192.0.2.10', '2001:db8::10', 'ntp-1.site.example']) assert.deepEqual(checkTimeSettings(withTime({ servers: [server] })), [], server);
  for (const refclock of ['PPS /dev/pps0', 'PHC /dev/sda', 'SOCK /tmp/chrony.sock', 'SOCK /run/../etc/x', 'SHM 0 refid GPS', 'PHC /dev/ptp0 poll 2; local']) {
    assert.ok(checkTimeSettings(withTime({ refclocks: [refclock] })).some((problem) => /is not allowed/.test(problem)), refclock);
  }
  for (const refclock of ['PHC /dev/ptp0', 'SHM 0 poll 3', 'SOCK /run/chrony.ttyS0.sock']) assert.deepEqual(checkTimeSettings(withTime({ refclocks: [refclock] })), [], refclock);
  for (const maxClockErrorMs of [0, -5, 1.5, '1000', undefined]) {
    assert.ok(checkTimeSettings(withTime({ maxClockErrorMs })).some((problem) => /maxClockErrorMs must be a positive whole number/.test(problem)), String(maxClockErrorMs));
  }
});

test('the captured lines parse; clockProblems accepts synced and refuses unsynced, local and far with the measured bound', () => {
  const synced = parseTracking(tracking('synced'));
  assert.deepEqual({ refId: synced.refId, refName: synced.refName, stratum: synced.stratum, leap: synced.leap }, { refId: '50484330', refName: 'PHC0', stratum: 1, leap: 'Normal' });
  assert.deepEqual(clockProblems(synced, LIMIT), []);
  const reasons = (name) => clockProblems(parseTracking(tracking(name)), LIMIT).join(' ');
  assert.match(reasons('unsynced'), /not synchronised to any time source \(.*bound 1500\.000 ms\)/);
  assert.match(reasons('local'), /follows its own local clock, not a site time source \(reference 7F7F0101, stratum 10, bound 0\.000 ms\)/);
  assert.match(reasons('far'), /The clock error bound is 2500\.019 ms, above the site limit of 1000 ms/);
  assert.deepEqual(clockProblems(parseTracking(tracking('far')), { maxClockErrorMs: 3000 }), [], 'the limit is the site\'s');
  assert.throws(() => parseTracking('506,PHC0,1'), /unexpected line/);
  // The import host check: a missing chronyc is a plain problem, and the captured line goes through the same verdict.
  assert.match(checkHostClock({ run: () => ({ error: Object.assign(new Error('spawn chronyc ENOENT'), { code: 'ENOENT' }) }), ...LIMIT })[0],
    /chronyc is not installed.*site's own OS repository/);
  assert.deepEqual(checkHostClock({ run: (command, args) => (command === 'chronyc' && args.join(' ') === '-c tracking'
    ? { status: 0, stdout: `${tracking('synced')}\n` } : { status: 1, stdout: '' }), ...LIMIT }), []);
});

/** Runs check-time.sh with a fake chronyc that prints `line` for -c tracking and succeeds for waitsync. */
function checkTime(line, { max = '1000' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-time-'));
  writeFileSync(path.join(dir, 'clock.env'), `MAX_CLOCK_ERROR_MS=${max}\n`);
  writeFileSync(path.join(dir, 'tracking.csv'), `${line}\n`);
  writeFileSync(path.join(dir, 'chronyc'), `#!/bin/sh\ncase "$1" in\n  waitsync) exit 0 ;;\n  -c) cat "${path.join(dir, 'tracking.csv')}" ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(path.join(dir, 'chronyc'), 0o755);
  return spawnSync('sh', [path.join(ROOT, 'deploy/rke2/check-time.sh'), dir], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
}

test('check-time.sh gives the same verdict as clockProblems on every fixture', () => {
  for (const name of FIXTURES) {
    const run = checkTime(tracking(name));
    const refused = clockProblems(parseTracking(tracking(name)), LIMIT).length > 0;
    assert.equal(run.status, refused ? 1 : 0, `${name}: check-time.sh exit ${run.status}, clockProblems ${refused ? 'refuses' : 'accepts'}\n${run.stderr}`);
    assert.match(run.stderr, refused ? /^check-time: refusing: / : /^check-time: clock synchronised: reference PHC0, stratum 1, bound 0\.019 ms \(limit 1000 ms\)/, name);
  }
  assert.match(checkTime(tracking('far')).stderr, /bound 2500\.019 ms/);
  assert.equal(checkTime(tracking('far'), { max: '3000' }).status, 0, 'the limit comes from clock.env');
  assert.equal(checkTime(tracking('synced'), { max: '1e3' }).status, 1, 'a limit that is not digits is refused');
  assert.equal(spawnSync('sh', [path.join(ROOT, 'deploy/rke2/check-time.sh')], { encoding: 'utf8' }).status, 2, 'no folder is a usage error');
});

test('install-node.sh requires the clock files and runs check-time.sh before the etcd user, the RPM and RKE2', () => {
  const script = read('deploy/rke2/install-node.sh');
  assert.match(script, /^for name in chrony\.conf clock\.env check-time\.sh; do$/m);
  const at = (pattern) => {
    const index = script.split('\n').findIndex((line) => !line.trimStart().startsWith('#') && pattern.test(line));
    assert.ok(index >= 0, String(pattern));
    return index;
  };
  const check = at(/sh "\$DIR\/check-time\.sh" "\$DIR"/);
  assert.ok(at(/install -m 0644 "\$DIR\/chrony\.conf" \/etc\/chrony\.conf/) < check);
  assert.ok(at(/systemctl restart chronyd/) < check);
  for (const later of [/useradd .* etcd/, /rpm -i/, /tar -xzf .*rke2\.linux-amd64\.tar\.gz/, /systemctl enable --now rke2-server/]) assert.ok(check < at(later), String(later));
});

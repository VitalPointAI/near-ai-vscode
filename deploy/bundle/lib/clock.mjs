#!/usr/bin/env node
// Time for air-gapped sites (D-71; AU-8, AU-8(1), SC-45). A disconnected site has no internet time, so it provides its own authoritative source
// (a GNSS-disciplined NTP appliance or a stratum-1 server on the site network), and every node and the import host follow it through chrony from
// the site's own OS repository. This module turns the site file's `time` settings into each node's chrony.conf, and gives the clock verdict on
// `chronyc -c tracking` that deploy/rke2/check-time.sh applies on the nodes (which have no Node.js) with the same four rules. Node built-ins only.
//
//   node deploy/bundle/lib/clock.mjs --site <site file> --out <dir>      write the node clock files: chrony.conf, clock.env, check-time.sh
//   node deploy/bundle/lib/clock.mjs --check-host --site <site file>     check this host's clock; exit 1 on any problem
//
// The verdict: refuse a clock that is not synchronised, follows chrony's own local clock (reference id 7F7F0101), has a stratum of 0 or 16 and
// above, or whose error bound is above time.maxClockErrorMs. The bound is chrony's own: the absolute system time offset plus the root dispersion
// plus half the root delay.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from './render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The node clock check that install-node.sh runs, copied beside each node's chrony.conf. */
export const CHECK_TIME_SCRIPT = path.resolve(HERE, '../../rke2/check-time.sh');
/** Where install-node.sh puts the site CA for chrony's NTS trust (a public certificate, readable by the chrony user). */
export const CHRONY_SITE_CA = '/etc/chrony-site-ca.crt';
/** chrony's reference id for its own local clock (the `local` directive): never an authoritative source. */
export const LOCAL_CLOCK_REF_ID = '7F7F0101';

const SOURCE_MESSAGE = 'The site file names no time source (time.servers and time.refclocks are both empty). A disconnected site must provide its own '
  + 'authoritative time source on the site network, a GNSS-disciplined NTP appliance or a stratum-1 server (two or more recommended), never an internet '
  + 'pool, and list it in time.servers.';
const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const REFCLOCK = /^(PHC \/dev\/ptp[0-9]+|SHM [0-9]+|SOCK \/run\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)( poll -?[0-9]+)?$/;

const isHostName = (value) => value.length <= 253 && value.split('.').every((label) => HOST_LABEL.test(label)) && !/^[0-9.]+$/.test(value);

/** The site's time settings, or an empty object when the site file has none. */
const timeOf = (site) => (site && typeof site.time === 'object' && site.time !== null ? site.time : {});

/** Plain problems with the site file's `time` settings; empty when they are usable. */
export function checkTimeSettings(site) {
  const time = timeOf(site);
  const problems = [];
  const servers = time.servers ?? [];
  const refclocks = time.refclocks ?? [];
  if (!Array.isArray(servers)) problems.push('time.servers must be a list of host names or IP addresses.');
  if (!Array.isArray(refclocks)) problems.push('time.refclocks must be a list of chrony reference clocks.');
  if (Array.isArray(servers) && Array.isArray(refclocks) && servers.length === 0 && refclocks.length === 0) problems.push(SOURCE_MESSAGE);
  for (const server of Array.isArray(servers) ? servers : []) {
    if (typeof server !== 'string' || !(isIP(server) || isHostName(server))) {
      problems.push(`time.servers: ${JSON.stringify(server)} is not a host name or an IP address.`);
    }
  }
  for (const refclock of Array.isArray(refclocks) ? refclocks : []) {
    if (typeof refclock !== 'string' || !REFCLOCK.test(refclock) || refclock.includes('/..')) {
      problems.push(`time.refclocks: ${JSON.stringify(refclock)} is not allowed; a reference clock is "PHC /dev/ptpN", "SHM N" or "SOCK /run/...", `
        + 'with an optional "poll N".');
    }
  }
  if (time.nts !== undefined && typeof time.nts !== 'boolean') problems.push('time.nts must be true or false.');
  if (!Number.isInteger(time.maxClockErrorMs) || time.maxClockErrorMs <= 0) {
    problems.push('time.maxClockErrorMs must be a positive whole number of milliseconds: the largest clock error bound a node or the import host may '
      + 'have (AU-8(1), set by your organization; 1000 is the shipped default).');
  }
  return problems;
}

/** The chrony.conf text for every node of the site: the site's own sources only, clients only. Throws with the settings problems if any. */
export function chronyConf(site) {
  const problems = checkTimeSettings(site);
  if (problems.length) throw new Error(problems.join('\n'));
  const { servers = [], refclocks = [], nts = false } = timeOf(site);
  const lines = [
    '# Generated from the site file\'s time settings by deploy/bundle/lib/clock.mjs (D-71). Do not edit on the node: change the site file and',
    '# write the node files again. The node is a client of the site\'s own time sources only: no pool, no allow, no command port.',
  ];
  for (const server of servers) lines.push(`server ${server} iburst${nts ? ' nts' : ''}`);
  for (const refclock of refclocks) lines.push(`refclock ${refclock}`);
  if (servers.length + refclocks.length >= 2) lines.push('minsources 2');
  lines.push('driftfile /var/lib/chrony/drift', 'makestep 1 3', 'rtcsync', 'cmdport 0');
  if (nts) lines.push(`ntstrustedcerts ${CHRONY_SITE_CA}`);
  return `${lines.join('\n')}\n`;
}

/** Writes the node clock files into `outDir`: chrony.conf, clock.env and a copy of check-time.sh. Returns their paths. */
export function writeClockFiles(site, outDir) {
  const conf = chronyConf(site);
  mkdirSync(outDir, { recursive: true });
  const files = { chronyConf: path.join(outDir, 'chrony.conf'), clockEnv: path.join(outDir, 'clock.env'), checkTime: path.join(outDir, 'check-time.sh') };
  writeFileSync(files.chronyConf, conf, { mode: 0o644 });
  writeFileSync(files.clockEnv, `MAX_CLOCK_ERROR_MS=${timeOf(site).maxClockErrorMs}\n`, { mode: 0o644 });
  copyFileSync(CHECK_TIME_SCRIPT, files.checkTime);
  return files;
}

/** One `chronyc -c tracking` line as { refId, refName, stratum, offsetSeconds, rootDelaySeconds, rootDispersionSeconds, leap }. */
export function parseTracking(line) {
  const fields = String(line).trim().split(',');
  if (fields.length < 14) throw new Error(`chronyc tracking printed an unexpected line (${fields.length} fields, 14 expected): ${String(line).trim()}`);
  const number = (index, name) => {
    const value = Number(fields[index]);
    if (fields[index] === '' || !Number.isFinite(value)) throw new Error(`chronyc tracking: the ${name} field is not a number (${fields[index]}).`);
    return value;
  };
  return {
    refId: fields[0].toUpperCase(),
    refName: fields[1],
    stratum: number(2, 'stratum'),
    offsetSeconds: number(4, 'system time offset'),
    rootDelaySeconds: number(10, 'root delay'),
    rootDispersionSeconds: number(11, 'root dispersion'),
    leap: fields[13],
  };
}

/** chrony's bound on the clock error, in milliseconds. */
export const errorBoundMs = (tracking) => (Math.abs(tracking.offsetSeconds) + tracking.rootDispersionSeconds + tracking.rootDelaySeconds / 2) * 1000;

/** Plain reasons to refuse this clock; empty when it follows a real source within the limit. */
export function clockProblems(tracking, { maxClockErrorMs }) {
  const bound = errorBoundMs(tracking);
  const measured = `reference ${tracking.refName || tracking.refId}, stratum ${tracking.stratum}, bound ${bound.toFixed(3)} ms`;
  const problems = [];
  if (tracking.leap === 'Not synchronised') problems.push(`The clock is not synchronised to any time source (${measured}).`);
  if (tracking.refId === LOCAL_CLOCK_REF_ID) problems.push(`The clock follows its own local clock, not a site time source (${measured}).`);
  if (tracking.stratum === 0 || tracking.stratum >= 16) problems.push(`The reference stratum ${tracking.stratum} is not a usable time source (${measured}).`);
  if (bound > maxClockErrorMs) problems.push(`The clock error bound is ${bound.toFixed(3)} ms, above the site limit of ${maxClockErrorMs} ms (time.maxClockErrorMs; ${measured}).`);
  return problems;
}

const defaultRun = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });

/** Checks this host's clock through `chronyc -c tracking` (run with no shell). Returns plain problems; empty when the clock is good. */
export function checkHostClock({ run = defaultRun, maxClockErrorMs }) {
  const result = run('chronyc', ['-c', 'tracking']);
  if (result.error?.code === 'ENOENT') {
    return ['chronyc is not installed on this host. Install chrony from the site\'s own OS repository and configure it with the site\'s time sources.'];
  }
  if (result.error || result.status !== 0) {
    return [`chronyc tracking failed (${result.error?.message || (result.stderr || '').trim() || `exit ${result.status}`}); is chronyd running?`];
  }
  try {
    return clockProblems(parseTracking(String(result.stdout).split('\n')[0]), { maxClockErrorMs });
  } catch (error) {
    return [error.message];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const siteFile = option('--site');
  const out = option('--out');
  const checkHost = argv.includes('--check-host');
  if (!siteFile || (!out && !checkHost) || (out && checkHost) || argv.includes('--help')) {
    console.error('usage: clock.mjs --site <site file> --out <dir>  |  clock.mjs --check-host --site <site file>');
    process.exit(2);
  }
  try {
    const site = loadSite(siteFile);
    const settings = checkTimeSettings(site);
    if (settings.length) throw new Error(settings.join('\n'));
    if (out) {
      const files = writeClockFiles(site, out);
      console.log(`clock: wrote ${Object.values(files).map((file) => path.basename(file)).join(', ')} in ${out}`);
    } else {
      const problems = checkHostClock({ maxClockErrorMs: site.time.maxClockErrorMs });
      if (problems.length) {
        for (const problem of problems) console.error(`clock: ${problem}`);
        process.exit(1);
      }
      console.log('clock: this host follows a site time source within the limit.');
    }
  } catch (error) {
    console.error(`clock: ${error.message}`);
    process.exit(1);
  }
}

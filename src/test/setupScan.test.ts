import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoverySection } from '../domain/gate/sections';
import { cidrContains, hostCount, hostsOf, parseCidr } from '../domain/setup/cidr';
import { discoveryWays } from '../domain/setup/network';
import { MODEL_SERVER_PORTS } from '../domain/setup/servers';
import { planScan, runScan, SCAN_CONFIRM_TEXT, type ScanPlan } from '../services/setup/scan';
import { parseDarwinDns, parseDarwinRoute, parseLinuxRoute, parseResolvConf, parseWindowsNetwork,
  readNetworkFacts, WINDOWS_NETWORK_COMMAND, type NetworkFactsDeps } from '../services/setup/networkFacts';

const ROUTE = [
  'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
  'eth0 00000000 0102000A 0003 0 0 100 00000000 0 0 0',
  'eth0 0002000A 00000000 0001 0 0 100 00FFFFFF 0 0 0'
].join('\n');
const RESOLVER = 'search CORP.example.org. lab.example.org\ndomain corp.example.org\nnameserver 192.0.2.53\n';
const MAC_ROUTE = '   route to: default\ndestination: default\n    gateway: 192.0.2.1\n  interface: en0\n';
const MAC_DNS = 'resolver #1\n  search domain[0] : Corp.Example.Org.\n  search domain[1] : lab.example.org\n  domain : supplemental.example.org\n';
const WINDOWS = '{ "dnsSearch": ["corp.example.org.", "Lab.Example.org"], "gateway": "198.51.100.1" }';
const UNKNOWN = { dnsSearch: [], source: 'unknown' };
const discovery: DiscoverySection = {
  networks: [{ id: 'office', dnsSuffix: 'corp.example.org' }], announce: true,
  scanRanges: [{ cidr: '192.0.2.0/30', network: 'office' }], personalApprovals: false
};

function fixture(platform: string, overrides: Partial<NetworkFactsDeps> = {}): NetworkFactsDeps {
  return {
    platform, tmpdir: () => '/fixture-scratch',
    readFile: async () => assert.fail('unexpected file read'),
    execFile: async () => assert.fail('unexpected process'),
    ...overrides
  };
}

test('Linux reads only the routing and resolver files, with no process calls', async () => {
  const paths: string[] = [];
  const result = await readNetworkFacts(fixture('linux', { async readFile(file, options) {
    paths.push(file);
    assert.equal(options.encoding, 'utf8');
    assert.ok(options.signal instanceof AbortSignal);
    return file === '/proc/net/route' ? ROUTE : RESOLVER;
  } }));
  assert.deepEqual(paths, ['/proc/net/route', '/etc/resolv.conf']);
  assert.deepEqual(result, { gateway: '10.0.2.1', dnsSearch: ['corp.example.org', 'lab.example.org'], source: 'linux' });
  assert.equal(discoveryWays(discovery, result).network?.id, 'office');
});

test('Linux ignores inactive routes and refuses tied default gateways', () => {
  const alternate = 'eth1 00000000 010000C0 0003 0 0 10 00000000 0 0 0';
  const inactive = 'eth2 00000000 010000C6 0002 0 0 1 00000000 0 0 0';
  assert.equal(parseLinuxRoute([ROUTE, alternate, inactive].join('\n')), '192.0.0.1');
  assert.equal(parseLinuxRoute([ROUTE, alternate.replace(' 10 ', ' 100 ')].join('\n')), undefined);
});

test('resolver parsing validates and normalizes only search and domain entries', () => {
  assert.deepEqual(parseResolvConf(RESOLVER + 'search -bad.example bad-.example bad_label.example # ignored.example\n'),
    ['corp.example.org', 'lab.example.org']);
});

test('macOS reads the default gateway and indexed DNS search domains', async () => {
  assert.equal(parseDarwinRoute(MAC_ROUTE), '192.0.2.1');
  assert.deepEqual(parseDarwinDns(MAC_DNS), ['corp.example.org', 'lab.example.org']);
  const calls: Array<Parameters<NetworkFactsDeps['execFile']>> = [];
  const result = await readNetworkFacts(fixture('darwin', { async execFile(...call) {
    calls.push(call);
    return { stdout: call[0] === '/sbin/route' ? MAC_ROUTE : MAC_DNS };
  } }));
  assert.deepEqual(calls.map(([file, args]) => [file, args]), [
    ['/sbin/route', ['-n', 'get', 'default']], ['/usr/sbin/scutil', ['--dns']]
  ]);
  assert.deepEqual(result, { gateway: '192.0.2.1', dnsSearch: ['corp.example.org', 'lab.example.org'], source: 'darwin' });
  for (const [, , options] of calls) {
    assert.deepEqual({ ...options, signal: undefined }, {
      shell: false, timeout: 3000, maxBuffer: 65536, cwd: '/fixture-scratch', windowsHide: true, signal: undefined
    });
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('fixed executable fallback is used only when the absolute executable is missing', async () => {
  const calls: string[] = [];
  const facts = await readNetworkFacts(fixture('darwin', { async execFile(file) {
    calls.push(file);
    if (file === '/sbin/route') throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return { stdout: file === 'route' ? MAC_ROUTE : MAC_DNS };
  } }));
  assert.ok(calls.includes('route'));
  assert.equal(facts.gateway, '192.0.2.1');
  const deniedCalls: string[] = [];
  assert.deepEqual(await readNetworkFacts(fixture('darwin', { async execFile(file) {
    deniedCalls.push(file);
    throw Object.assign(new Error('denied fixture'), { code: 'EACCES' });
  } })), UNKNOWN);
  assert.deepEqual(deniedCalls.sort(), ['/sbin/route', '/usr/sbin/scutil']);
});

test('Windows runs one fixed command and parses the bounded object it returns', async () => {
  assert.deepEqual(parseWindowsNetwork(WINDOWS), { gateway: '198.51.100.1', dnsSearch: ['corp.example.org', 'lab.example.org'], source: 'win32' });
  const calls: Array<Parameters<NetworkFactsDeps['execFile']>> = [];
  const facts = await readNetworkFacts(fixture('win32', { async execFile(...call) {
    calls.push(call);
    return { stdout: WINDOWS };
  } }));
  assert.equal(calls.length, 1);
  const [file, args, options] = calls[0];
  assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_NETWORK_COMMAND]);
  assert.match(WINDOWS_NETWORK_COMMAND, /Get-DnsClientGlobalSetting/);
  assert.match(WINDOWS_NETWORK_COMMAND, /Get-NetRoute/);
  assert.equal(options.shell, false);
  assert.deepEqual(facts, parseWindowsNetwork(WINDOWS));
});

test('bad outputs and missing inputs do not enable discovery', async () => {
  const scenarios = [
    fixture('freebsd'),
    fixture('linux', { async readFile(file) {
      if (file === '/proc/net/route') throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
      return RESOLVER;
    } }),
    fixture('linux', { readFile: async () => RESOLVER + ' '.repeat(65536) }),
    fixture('darwin', { execFile: async () => ({ stdout: ' '.repeat(65537) }) }),
    fixture('win32', { execFile: async () => ({ stdout: '{"dnsSearch":["corp.example.org"],"gateway":"not-an-ip"}' }) }),
    fixture('win32', { execFile: async () => ({ stdout: 'not json' }) })
  ];
  for (const deps of scenarios) {
    const facts = await readNetworkFacts(deps);
    assert.deepEqual(facts, UNKNOWN);
    const ways = discoveryWays(discovery, facts);
    assert.equal(ways.announce, false);
    assert.deepEqual(ways.scanRanges, []);
  }
});

test('cancellation works even when a fixture reader never completes', async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const deps = fixture('linux', { readFile(_file, { signal }) {
    signals.push(signal);
    return new Promise(() => undefined);
  } });
  const result = readNetworkFacts(deps, controller.signal);
  await Promise.resolve();
  assert.equal(signals.length, 2);
  controller.abort();
  assert.deepEqual(await result, UNKNOWN);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('a failed fact read aborts the sibling read before returning unknown', async () => {
  let pending: AbortSignal | undefined;
  const deps = fixture('linux', { async readFile(file, { signal }) {
    if (file === '/proc/net/route') throw new Error('fixture read failed');
    pending = signal;
    return new Promise(() => undefined);
  } });
  assert.deepEqual(await readNetworkFacts(deps), UNKNOWN);
  assert.ok(pending?.aborted);
});

const office = { dnsSearch: ['corp.example.org'], source: 'linux' } as const;
const ways = discoveryWays(discovery, office);
const noNetwork = discoveryWays(discovery, { dnsSearch: [], source: 'unknown' });

function offer() {
  const result = planScan({ ways });
  assert.ok(result.ok);
  return result.plan;
}

class VirtualScanClock {
  private time = 0;
  private readonly timers = new Map<object, { at: number; run: () => void }>();

  now = () => this.time;

  setTimeout(run: () => void, delay: number) {
    const handle = {};
    this.timers.set(handle, { run, at: this.time + delay });
    return handle;
  }

  clearTimeout(handle: unknown) {
    if (typeof handle === 'object' && handle !== null) this.timers.delete(handle);
  }

  async drain<T>(result: Promise<T>): Promise<T> {
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    for (let tick = 0; !settled && tick < 1000; tick++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (settled) break;
      const next = [...this.timers.entries()].sort(([, a], [, b]) => a.at - b.at)[0];
      assert.ok(next, 'the run must settle or leave a timer');
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].run();
    }
    assert.ok(settled, 'virtual run reached its tick cap');
    return result;
  }
}

test('CIDRs normalize the base and handle /31 and /32 without losing usable addresses', () => {
  const subnet = parseCidr('192.0.2.2/30');
  assert.ok(subnet);
  assert.deepEqual([...hostsOf(subnet, 2)], ['192.0.2.1', '192.0.2.2']);
  assert.equal(hostCount(subnet), 2);
  assert.equal(cidrContains(subnet, '192.0.2.0'), true);
  assert.equal(cidrContains(subnet, '192.0.2.4'), false);
  const pointToPoint = parseCidr('255.255.255.255/31');
  const single = parseCidr('255.255.255.255/32');
  assert.ok(pointToPoint && single);
  assert.deepEqual([...hostsOf(pointToPoint, 2)], ['255.255.255.254', '255.255.255.255']);
  assert.deepEqual([...hostsOf(single, 1)], ['255.255.255.255']);
  for (const invalid of ['192.0.2.1/15', '192.0.2.1/33', '192.0.2.999/24', '::1/32']) assert.equal(parseCidr(invalid), undefined);
});

test('planning requires the current network and exact requested ranges and model-server ports', () => {
  assert.deepEqual(planScan({ ways: noNetwork }), { ok: false, reason: 'not-listed-network' });
  assert.deepEqual(planScan({ ways: { ...ways, scanRanges: [] } }), { ok: false, reason: 'no-ranges' });
  assert.deepEqual(planScan({ ways, requested: ['192.0.2.1/30'] }), { ok: false, reason: 'range-not-listed' });
  assert.deepEqual(planScan({ ways, ports: [443] }), { ok: false, reason: 'port-not-allowed' });
  assert.deepEqual(planScan({ ways, ports: [] }), { ok: false, reason: 'port-not-allowed' });
  assert.deepEqual(planScan({ ways: { ...ways, scanRanges: [{ cidr: '192.0.2.0/30', network: 'other' }] } }),
    { ok: false, reason: 'no-ranges' });
  const large = { ...ways, scanRanges: [{ cidr: '192.0.0.0/16' }, { cidr: '198.51.0.0/16' }] };
  assert.deepEqual(planScan({ ways: large }), { ok: false, reason: 'too-many-hosts' });
  const allowed = planScan({ ways: large, requested: ['192.0.0.0/16'] });
  assert.ok(allowed.ok);
  assert.equal(allowed.plan.hosts, 65534);
  assert.equal(allowed.plan.estimatedSeconds, 1311);
  assert.match(SCAN_CONFIRM_TEXT, /your network team may see this as a scan/i);
});

test('a confirmed /30 offers two hosts and only model ports with start and end audit events', async () => {
  const plan = offer();
  const clock = new VirtualScanClock();
  const expectedCalls = ['192.0.2.1', '192.0.2.2'].flatMap((host) => MODEL_SERVER_PORTS.map((port) => [host, port]));
  const calls: Array<readonly [string, number]> = [];
  const events: string[] = [];
  const candidates: string[] = [];
  assert.equal(plan.hosts, 2);
  const result = await clock.drain(runScan({
    plan, confirmed: true, ways: () => ways, clock, signal: new AbortController().signal,
    async connect(host, port, timeout, signal) {
      assert.deepEqual(events, ['start']);
      assert.equal(timeout, 800);
      assert.equal(signal.aborted, false);
      calls.push([host, port]);
      return host === '192.0.2.1' && port === 11434;
    },
    onFound(candidate) {
      assert.equal(candidate.foundBy, 'scanned');
      assert.equal(candidate.target.scheme, 'https');
      candidates.push(candidate.target.host);
    },
    onProgress() {},
    record(phase, detail) {
      assert.deepEqual(detail.ranges, ['192.0.2.0/30']);
      assert.deepEqual(detail.ports, MODEL_SERVER_PORTS);
      assert.equal(detail.found, phase === 'start' ? 0 : 1);
      events.push(phase);
    }
  }));
  assert.deepEqual(result, { found: 1, stopped: false });
  assert.deepEqual(calls, expectedCalls);
  assert.deepEqual(candidates, ['192.0.2.1']);
  assert.deepEqual(events, ['start', 'end']);
});

test('an unconfirmed, stale, or forged plan starts no connections and no audit run', async () => {
  const plan = offer();
  for (const [scan, confirmed, current] of [
    [plan, false, ways],
    [plan, true, noNetwork],
    [{ ...plan, ports: [443] }, true, ways],
    [{ ...plan, ports: Array(1) }, true, ways],
    [{ ...plan, ports: undefined }, true, ways],
    [{ ...plan, hosts: 1 }, true, ways],
    [{ ...plan, ranges: ['198.51.100.0/30'] }, true, ways]
  ] as const) {
    assert.deepEqual(await runScan({
      plan: scan as ScanPlan, confirmed: confirmed as true, ways: () => current, clock: new VirtualScanClock(),
      signal: new AbortController().signal, connect: async () => assert.fail('unexpected connection'),
      onFound() {}, onProgress() {}, record: () => assert.fail('unexpected audit')
    }), { found: 0, stopped: true });
  }
});

test('pacing enforces 50 hosts in every rolling second without overlapping connection attempts', async () => {
  const clock = new VirtualScanClock();
  const wider = { ...ways, scanRanges: [{ cidr: '192.0.2.0/24' }, { cidr: '192.0.2.0/30' }] };
  const offer = planScan({ ways: wider, ports: [11434] });
  assert.ok(offer.ok);
  assert.equal(offer.plan.hosts, 254);
  const hosts = new Set<string>();
  const attempts: number[] = [];
  let inFlight = false;
  const result = await clock.drain(runScan({
    plan: offer.plan, confirmed: true, ways: () => wider, clock, signal: new AbortController().signal,
    async connect(host) {
      assert.equal(inFlight, false);
      assert.equal(hosts.has(host), false);
      hosts.add(host);
      attempts.push(clock.now());
      inFlight = true;
      await new Promise<void>((resolve) => clock.setTimeout(resolve, 10));
      inFlight = false;
      return false;
    },
    onFound() {}, onProgress() {}, record() {}
  }));
  assert.deepEqual(result, { found: 0, stopped: false });
  assert.equal(hosts.size, 254);
  for (const at of attempts) assert.ok(attempts.filter((time) => time >= at && time < at + 1000).length <= 50);
});

test('a live network or policy change stops the run before the next port or reporting the old result', async () => {
  const clock = new VirtualScanClock();
  const events: string[] = [];
  const result = await clock.drain(runScan({
    plan: offer(), confirmed: true, ways: () => events.includes('connect') ? noNetwork : ways,
    clock, signal: new AbortController().signal,
    async connect() { events.push('connect'); return true; },
    onFound: () => assert.fail('stale result'),
    onProgress() {}, record: (phase) => { events.push(phase); }
  }));
  assert.deepEqual(result, { found: 0, stopped: true });
  assert.deepEqual(events, ['start', 'connect', 'end']);
});

test('Stop and a hung connection both abort the transport and leave an end audit record', async () => {
  for (const stop of ['user', 'timeout'] as const) {
    const clock = new VirtualScanClock();
    const events: string[] = [];
    const controller = new AbortController();
    let transport: AbortSignal | undefined;
    const result = await clock.drain(runScan({
      plan: offer(), confirmed: true, ways: () => ways, clock, signal: controller.signal,
      connect(_host, _port, _timeout, signal) {
        transport = signal;
        events.push('connect');
        if (stop === 'user') clock.setTimeout(() => controller.abort(), 15);
        return new Promise(() => undefined);
      },
      onFound() {}, onProgress() {}, record: (phase) => { events.push(phase); }
    }));
    assert.equal(transport?.aborted, true);
    assert.deepEqual(result, { found: 0, stopped: true });
    assert.deepEqual(events, ['start', 'connect', 'end']);
    assert.equal(clock.now(), stop === 'user' ? 15 : 800);
  }
});

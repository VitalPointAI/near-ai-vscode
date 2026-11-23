import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoverySection } from '../domain/gate/sections';
import { discoveryWays } from '../domain/setup/network';
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

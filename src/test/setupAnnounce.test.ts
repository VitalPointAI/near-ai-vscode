import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeMessage } from '../domain/setup/dnsWire';
import { discoveryWays } from '../domain/setup/network';
import { browseAnnounced } from '../services/setup/mdns';
import { lookupAnnouncedSrv } from '../services/setup/srv';

const service = '_near-ai-models._tcp.local';
const network = { id: 'office', dnsSuffix: 'corp.example.org' };
const policy = { announce: true, networks: [network], scanRanges: [], personalApprovals: false };
const ways = discoveryWays(policy, { source: 'linux', dnsSearch: [network.dnsSuffix] });

class VirtualClock {
  private time = 0;
  private readonly timers = new Set<{ at: number; run: () => void }>();

  now = () => this.time;

  setTimeout(run: () => void, ms: number): unknown {
    const timer = { at: this.time + ms, run };
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    for (const timer of this.timers) {
      if (timer === handle) this.timers.delete(timer);
    }
  }

  advance(ms: number): void {
    this.time += ms;
    for (const timer of this.timers) {
      if (timer.at <= this.time) {
        this.timers.delete(timer);
        timer.run();
      }
    }
  }
}

class FakeDatagram {
  readonly calls: unknown[][] = [];
  private listener?: (bytes: Uint8Array) => void;
  private errorListener?: (error: Error) => void;

  bind(port: number, ready?: () => void): void {
    this.calls.push(['bind', port]);
    ready?.();
  }

  send(bytes: Uint8Array, port: number, address: string): void {
    this.calls.push(['send', port, address, bytes]);
  }

  on(event: 'message', listener: (bytes: Uint8Array) => void): void {
    this.calls.push([event]);
    this.listener = listener;
  }

  addListener(event: 'error', listener: (error: Error) => void): void {
    this.calls.push([event]);
    this.errorListener = listener;
  }

  close(): void {
    this.calls.push(['close']);
  }

  address(): { port: number } {
    return { port: 49152 };
  }

  addMembership(): void {
    this.calls.push(['addMembership']);
  }

  reply(bytes: Uint8Array): void {
    this.listener?.(bytes);
  }

  fail(): void {
    this.errorListener?.(new Error('bind failed'));
  }
}

function name(value: string): number[] {
  return [...value.split('.').flatMap(label => [Buffer.byteLength(label), ...Buffer.from(label)]), 0];
}

function record(owner: string, type: number, data: number[]): number[] {
  return [...name(owner), 0, type, 0, 1, 0, 0, 0, 120, 0, data.length, ...data];
}

function reply({ owner = service, octet = 10, hasAddress = true, instance = 'example-gpu' } = {}): Uint8Array {
  const instanceName = `${instance}.${owner}`;
  return Uint8Array.from([
    0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, hasAddress ? 2 : 1,
    ...record(owner, 12, name(instanceName)),
    ...record(instanceName, 33, [0, 0, 0, 0, 0x2c, 0xaa, ...name('gpu.local')]),
    ...(hasAddress ? record('gpu.local', 1, [192, 0, 2, octet]) : []),
  ]);
}

test('D-44: one-shot question uses an ephemeral port and requests unicast', async () => {
  const clock = new VirtualClock();
  const socket = new FakeDatagram();
  const result = browseAnnounced({ ways, createSocket: () => socket, clock, windowMs: 10 });
  clock.advance(10);
  await result;

  assert.deepEqual(socket.calls.map(([event]) => event), ['error', 'message', 'bind', 'send', 'close']);
  assert.deepEqual(socket.calls[2], ['bind', 0]);
  assert.deepEqual(socket.calls[3].slice(0, 3), ['send', 5353, '224.0.0.251']);
  const query = decodeMessage(socket.calls[3][3] as Uint8Array);
  assert.ok(query.ok);
  assert.deepEqual(query.message.questions, [{ name: service, type: 'PTR', unicastResponse: true }]);
});

test('a reply becomes a candidate for the signature request', async () => {
  const clock = new VirtualClock();
  const socket = new FakeDatagram();
  const result = browseAnnounced({ ways, createSocket: () => socket, clock, windowMs: 10 });
  clock.advance(3);
  socket.reply(reply());
  clock.advance(7);
  assert.deepEqual(await result, [{
    target: { host: '192.0.2.10', port: 11434, scheme: 'https', source: 'announced' },
    foundBy: 'announced', name: 'example-gpu', foundAt: 3,
  }]);
  assert.deepEqual(socket.calls.at(-1), ['close']);
});

test('D-12: an unlisted network means no socket', async () => {
  const unlisted = discoveryWays(policy, { source: 'linux', dnsSearch: [] });
  assert.deepEqual(await browseAnnounced({
    ways: unlisted,
    createSocket: () => assert.fail('unexpected socket'),
    clock: new VirtualClock(),
  }), []);
});

test('mDNS ignores unrelated, addressless and malformed replies', async () => {
  const socket = new FakeDatagram();
  const clock = new VirtualClock();
  const result = browseAnnounced({ ways, createSocket: () => socket, clock });
  socket.reply(reply({ owner: '_other._tcp.local' }));
  socket.reply(reply({ hasAddress: false }));
  socket.reply(reply().subarray(0, 30));
  const query = reply();
  query[2] = 0;
  socket.reply(query);
  clock.advance(2000);
  assert.deepEqual(await result, []);
});

test('mDNS retains distinct endpoints once and closes at the candidate cap', async () => {
  const socket = new FakeDatagram();
  const clock = new VirtualClock();
  const result = browseAnnounced({ ways, createSocket: () => socket, clock });
  socket.reply(reply({ octet: 1, instance: 'example-1' }));
  socket.reply(reply({ octet: 1, instance: 'example-duplicate' }));
  for (let index = 2; index <= 100; index++) {
    socket.reply(reply({ octet: index, instance: `example-${index}` }));
  }
  assert.deepEqual(socket.calls.at(-1), ['close']);
  clock.advance(2000);
  const candidates = await result;
  assert.deepEqual(candidates.map(({ target }) => target.host), Array.from({ length: 32 }, (_, i) => `192.0.2.${i + 1}`));
  assert.equal(socket.calls.filter(([event]) => event === 'close').length, 1);
});

test('mDNS closes at the default deadline and ignores subsequent replies', async () => {
  const socket = new FakeDatagram();
  const clock = new VirtualClock();
  const result = browseAnnounced({ ways, createSocket: () => socket, clock });
  clock.advance(1999);
  socket.reply(reply());
  clock.advance(1);
  assert.deepEqual(socket.calls.at(-1), ['close']);
  socket.reply(reply({ octet: 20, instance: 'example-late' }));
  assert.deepEqual((await result).map(({ target }) => target.host), ['192.0.2.10']);
});

test('mDNS abort closes the socket even before bind completes', async () => {
  const socket = new FakeDatagram();
  const controller = new AbortController();
  let ready: (() => void) | undefined;
  socket.bind = (_port, callback) => { ready = callback; };
  const result = browseAnnounced({ ways, createSocket: () => socket, clock: new VirtualClock(), signal: controller.signal });
  controller.abort();
  ready?.();
  assert.deepEqual(await result, []);
  assert.deepEqual(socket.calls.map(([event]) => event), ['error', 'message', 'close']);
});

test('mDNS socket errors close discovery without waiting for the window', async () => {
  const socket = new FakeDatagram();
  const result = browseAnnounced({ ways, createSocket: () => socket, clock: new VirtualClock() });
  socket.fail();
  assert.deepEqual(await result, []);
  assert.deepEqual(socket.calls.at(-1), ['close']);
});

const srvAnswer = (name: string, port = 11434, priority = 0, weight = 0) => ({ name, port, priority, weight });

test('D-09: SRV looks up just the local listed suffix and orders HTTPS candidates', async () => {
  const calls: string[] = [];
  const candidates = await lookupAnnouncedSrv({
    ways, networks: [network, { id: 'other', dnsSuffix: 'other.example.org' }], clock: new VirtualClock(),
    resolver: {
      async resolveSrv(query) {
        calls.push(query);
        return [srvAnswer('gpu-b.corp.example.org', 11434, 2), srvAnswer('GPU-A.corp.example.org.', 11434, 1, 1)];
      },
    },
  });
  assert.deepEqual(calls, ['_near-ai-models._tcp.corp.example.org']);
  assert.deepEqual(candidates.map(({ target, foundBy }) => [target.host, target.port, target.scheme, target.source, foundBy]), [
    ['gpu-a.corp.example.org', 11434, 'https', 'announced', 'announced'],
    ['gpu-b.corp.example.org', 11434, 'https', 'announced', 'announced'],
  ]);
});

test('SRV does not query when announce is off, the suffix is absent or the policy changed', async () => {
  const gateway = { id: 'gateway', gateway: '192.0.2.1' };
  const gatewayWays = discoveryWays({ ...policy, networks: [gateway] }, {
    source: 'linux', dnsSearch: [], gateway: gateway.gateway,
  });
  const calls: string[] = [];
  const resolver = { async resolveSrv(query: string) { calls.push(query); return []; } };
  for (const input of [
    { ways: { ...ways, announce: false }, networks: [network] },
    { ways: gatewayWays, networks: [gateway] },
    { ways, networks: [{ ...network, dnsSuffix: 'other.example.org' }] },
  ]) {
    assert.deepEqual(await lookupAnnouncedSrv({ ...input, resolver, clock: new VirtualClock() }), []);
  }
  assert.deepEqual(calls, []);
});

test('SRV drops invalid hosts and ports, deduplicates and stops at the candidate cap', async () => {
  const candidates = await lookupAnnouncedSrv({
    ways, networks: [network], clock: new VirtualClock(),
    resolver: {
      async resolveSrv() {
        return [
          srvAnswer('.'), srvAnswer('bad/host.example.org'), srvAnswer('127.1'), srvAnswer('K.example.org'),
          srvAnswer('bad-port.example.org', 0), srvAnswer('bad-port.example.org', 65536),
          srvAnswer('bad-port.example.org', 1.5), srvAnswer('GPU-1.example.org.', 11434, 0, 1),
          ...Array.from({ length: 100 }, (_, index) => srvAnswer(`gpu-${index + 1}.example.org`, 11434, 0, index + 2)),
        ];
      },
    },
  });
  assert.deepEqual(candidates.map(({ target }) => target.host), Array.from({ length: 32 }, (_, i) => `gpu-${i + 1}.example.org`));
});

test('SRV handles resolver rejection', async () => {
  const rejected = await lookupAnnouncedSrv({
    ways, networks: [network], clock: new VirtualClock(),
    resolver: { async resolveSrv() { throw new Error('example resolver unavailable'); } },
  });
  assert.deepEqual(rejected, []);
});

test('SRV stops waiting at three seconds and ignores late answers', async () => {
  const clock = new VirtualClock();
  let finish!: (answers: ReturnType<typeof srvAnswer>[]) => void;
  const lookup = lookupAnnouncedSrv({
    ways, networks: [network], clock,
    resolver: { resolveSrv: () => new Promise(resolve => { finish = resolve; }) },
  });
  let settled = false;
  void lookup.then(() => { settled = true; });
  clock.advance(2999);
  await Promise.resolve();
  assert.equal(settled, false);
  clock.advance(1);
  assert.deepEqual(await lookup, []);
  finish([srvAnswer('late.example.org')]);
});

test('SRV abort releases the caller while resolution is pending', async () => {
  const controller = new AbortController();
  const lookup = lookupAnnouncedSrv({
    ways, networks: [network], clock: new VirtualClock(), signal: controller.signal,
    resolver: { resolveSrv: () => new Promise(() => {}) },
  });
  controller.abort();
  assert.deepEqual(await lookup, []);
});

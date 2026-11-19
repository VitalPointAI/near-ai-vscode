// The loopback emitters (WP-SIM; research note 11, 4.7 and 8.2): every server binds to 127.0.0.1 and nothing else (a spy on every listen and on any
// UDP socket), the streams carry the timeline's messages as CoT lines, AIS sentences, RSS documents and MCP results that a real MCP client reads, the
// HTTP side refuses other host names and other origins, and a whole session starts, plays and stops on the real clock.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { request } from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { SIM_BADGE, SIM_MARKING, SIM_TITLE_PREFIX } from '../domain/staff/sim/formats';
import type { SimPerson, SimScheduler } from '../domain/staff/sim/player';
import type { AisMessage, CotMessage, SimMessage, SimTimeline } from '../domain/staff/sim/timeline';
import { assertLoopback, LOOPBACK_HOST, PARTNER_TOOL, SimServers } from '../staff/sim/simServers';
import { feedPictureText, loadSimTimeline, SimSession, simStatusText } from '../staff/sim/simSession';
import { child, parseXml } from './simXml';

const PERSON: SimPerson = { kind: 'person', name: 'Test Presenter', role: 'Exercise control', deviceFingerprint: 'test-device' };

/** Records every listen and refuses any UDP socket while `run` runs. */
async function spyOnBinds<T>(run: () => Promise<T>): Promise<{ result: T; binds: unknown[][] }> {
  const binds: unknown[][] = [];
  const listen = net.Server.prototype.listen;
  const createSocket = dgram.createSocket;
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) { binds.push(args); return (listen as (...a: unknown[]) => net.Server).apply(this, args); } as typeof listen;
  (dgram as { createSocket: unknown }).createSocket = () => { throw new Error('the simulator must not open a UDP socket'); };
  try {
    return { result: await run(), binds };
  } finally {
    net.Server.prototype.listen = listen;
    (dgram as { createSocket: unknown }).createSocket = createSocket;
  }
}

function connectLines(url: string, eol: string, want: number): Promise<string[]> {
  const { hostname, port } = new URL(url.replace('tcp://', 'http://'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(eol).filter((line) => line !== '');
      if (lines.length >= want) { socket.destroy(); resolve(lines.slice(0, want)); }
    });
    socket.on('error', reject);
  });
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

let cached: SimTimeline | undefined;
async function timeline(): Promise<SimTimeline> {
  cached ??= (await loadSimTimeline()).timeline;
  return cached;
}

test('assertLoopback refuses every address but 127.0.0.1', () => {
  assert.doesNotThrow(() => assertLoopback('127.0.0.1'));
  for (const host of ['0.0.0.0', '', '::', 'localhost', '192.168.1.10', '::ffff:127.0.0.1', '239.2.3.1']) assert.throws(() => assertLoopback(host), /binds only/);
  assert.equal(LOOPBACK_HOST, '127.0.0.1');
});

test('every server binds to 127.0.0.1 only, and no UDP socket is opened', async () => {
  const servers = new SimServers(await timeline());
  const { binds } = await spyOnBinds(() => servers.start());
  try {
    assert.equal(binds.length, 4, 'two CoT streams, one AIS stream and one HTTP server');
    for (const args of binds) assert.equal(args[1], '127.0.0.1');
    for (const address of servers.addresses()) assert.equal(address.address, '127.0.0.1');
    const endpoints = servers.endpoints();
    for (const url of [endpoints.cotOwn, endpoints.cotIntel, endpoints.ais, endpoints.partnerMcp, ...Object.values(endpoints.rss)]) assert.equal(new URL(url.replace('tcp://', 'http://')).hostname, '127.0.0.1');
  } finally {
    await servers.stop();
  }
});

test('the streams carry CoT lines, AIS sentences and RSS documents, and a late client gets the latest of every track', async () => {
  const line = await timeline();
  const servers = new SimServers(line);
  const endpoints = await servers.start();
  try {
    const cotOf = (stream: 'cot-own' | 'cot-intel') => line.messages.find((m) => m.stream === stream) as CotMessage;
    const cot = cotOf('cot-own');
    const ais = line.messages.find((m) => m.stream === 'ais') as AisMessage;
    const rss = line.messages.filter((m): m is Extract<SimMessage, { stream: 'rss' }> => m.stream === 'rss' && m.channel === 'calder-courier');
    servers.publish(cot);
    servers.publish(ais);
    for (const item of rss) servers.publish(item);
    // A client that connects after the publish gets the latest message of each track at once.
    const [cotLine] = await connectLines(endpoints.cotOwn, '\n', 1);
    assert.equal(cotLine, cot.xml);
    assert.equal(parseXml(cotLine).attrs.opex, 's-IRON LANTERN');
    const aisLines = await connectLines(endpoints.ais, '\r\n', ais.sentences.length);
    assert.deepEqual(aisLines, ais.sentences);
    // A connected client gets new messages live.
    const live = connectLines(endpoints.cotIntel, '\n', 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const spot = cotOf('cot-intel');
    servers.publish(spot);
    assert.equal((await live)[0], spot.xml);

    const doc = await httpGet(endpoints.rss['calder-courier']);
    assert.equal(doc.status, 200);
    assert.match(String(doc.headers['content-type']), /application\/rss\+xml/);
    assert.equal(doc.headers['x-exercise-marking'], SIM_MARKING);
    const channel = child(parseXml(doc.body), 'channel')!;
    const titles = channel.children.filter((c) => c.name === 'item').map((item) => child(item, 'title')!.text);
    assert.equal(titles.length, rss.length);
    assert.equal(titles[0], `${SIM_TITLE_PREFIX} ${rss[rss.length - 1].item.title}`, 'newest first');
    for (const title of titles) assert.ok(title.startsWith(SIM_TITLE_PREFIX));
    assert.equal((await httpGet(endpoints.rss['calder-courier'].replace('calder-courier', 'nowhere'))).status, 404);
  } finally {
    await servers.stop();
  }
});

test('the HTTP side refuses other host names and other origins', async () => {
  const servers = new SimServers(await timeline());
  const endpoints = await servers.start();
  try {
    const url = endpoints.rss['calder-courier'];
    assert.equal((await httpGet(url, { Host: 'attacker.example' })).status, 403);
    assert.equal((await httpGet(url, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await httpGet(url, { Origin: `http://127.0.0.1:${new URL(url).port}` })).status, 200);
    assert.equal((await httpGet(endpoints.partnerMcp)).status, 405);
  } finally {
    await servers.stop();
  }
});

test('the mock partner server is a working MCP server whose reports are all marked SIM and routed local-only', async () => {
  const line = await timeline();
  const servers = new SimServers(line);
  const endpoints = await servers.start();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as { Client: new (info: object, options: object) => any };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as { StreamableHTTPClientTransport: new (url: URL) => any };
  const client = new Client({ name: 'sim-test', version: '1.0.0' }, { capabilities: {} });
  try {
    for (const message of line.messages) if (message.stream === 'partner') servers.publish(message);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoints.partnerMcp)));
    assert.match(client.getInstructions() ?? '', /EXERCISE \/\/ SIM/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name), [PARTNER_TOOL]);
    assert.ok(tools[0].description.startsWith(SIM_MARKING));
    assert.equal(tools[0].annotations.readOnlyHint, true);
    const all = await client.callTool({ name: PARTNER_TOOL, arguments: {} });
    assert.notEqual(all.isError, true);
    const reports = (all.structuredContent as { reports: Array<Record<string, unknown>> }).reports;
    assert.equal(reports.length, line.messages.filter((m) => m.stream === 'partner').length);
    for (const report of reports) {
      assert.equal(report.marking, SIM_MARKING);
      assert.equal(report.simulated, true);
      assert.deepEqual(report.handling, ['local-only']);
    }
    assert.deepEqual(JSON.parse(all.content[0].text).reports, reports);
    const humint = await client.callTool({ name: PARTNER_TOOL, arguments: { discipline: 'HUMINT' } });
    assert.ok((humint.structuredContent as { reports: Array<{ discipline: string }> }).reports.every((r) => r.discipline === 'HUMINT'));
    const bad = await client.callTool({ name: PARTNER_TOOL, arguments: { discipline: 'OSINT' } });
    assert.equal(bad.isError, true);
    await assert.rejects(client.callTool({ name: 'something_else', arguments: {} }));
  } finally {
    await client.close().catch(() => undefined);
    await servers.stop();
  }
});

test('a whole session starts, holds at the mid-demo report, resumes at 4x, finishes and stops with every source SIM and retired', async () => {
  // A clock that runs 1000 times faster than real time, so the quarter-hour demo plays in about a second.
  const start = Date.now();
  const fast: SimScheduler = {
    now: () => start + (Date.now() - start) * 1000,
    setTimeout: (run, ms) => setTimeout(run, ms / 1000),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  const session = new SimSession(await timeline(), PERSON, fast);
  const seen: SimMessage[] = [];
  session.onMessage((message) => seen.push(message));
  const { binds } = await spyOnBinds(() => session.start());
  try {
    for (const args of binds) assert.equal(args[1], '127.0.0.1');
    for (let wait = 0; wait < 200 && session.status().state === 'running'; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const held = session.status();
    assert.equal(held.state, 'paused');
    assert.equal(held.pausedFor, 'hold');
    assert.equal(held.beat?.beat, 5);
    assert.match(simStatusText(held), new RegExp(`${SIM_BADGE} held D-3 0400`));
    assert.ok(session.player.setSpeed(4).ok);
    assert.ok(session.player.resume().ok);
    for (let wait = 0; wait < 200 && session.status().state !== 'finished'; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(session.status().state, 'finished');
    assert.equal(seen.length, session.timeline.messages.length);
    const text = feedPictureText(session);
    for (const feed of session.feeds()) assert.ok(text.includes(`[${SIM_BADGE}] ${feed.title}`), feed.title);
    assert.ok(!text.includes('[LIVE]'));
  } finally {
    await session.stop();
  }
  assert.ok(session.picture().sources.every((source) => source.simulated && source.state === 'retired'));
  assert.equal(session.status().state, 'stopped');
});

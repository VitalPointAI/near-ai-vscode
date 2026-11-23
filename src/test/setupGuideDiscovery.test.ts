import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { PolicyEndpoint } from '../domain/gate/endpoints';
import { composeLayers } from '../domain/gate/layers';
import type { DiscoverySection } from '../domain/gate/sections';
import { NOT_LISTED_NETWORK_TEXT, type NetworkFacts } from '../domain/setup/network';
import { parseGuideInbound } from '../domain/setup/guideMessages';
import { readGuidePolicy, type GuidePolicy } from '../domain/setup/policy';
import { MODEL_SERVER_PORTS } from '../domain/setup/servers';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { projectLogKey } from '../gate/decisionLog';
import { SETUP_AUDIT_DIR } from '../gate/setupAuditLog';
import { peerFingerprint } from '../services/connectionBinding';
import { createGuideDiscovery, type GuideDiscoveryDeps } from '../services/setup/guideDiscovery';
import { SCAN_STOPPED_TEXT } from '../services/setup/scan';
import { setup } from './helpers/getStartedHostFixture';
import { recordingPolicyEditor } from './helpers/policyEditorFake';
import { deviceKey, policyDocumentFor } from './helpers/policyFixtures';

const SERVICE = '_near-ai-models._tcp.local';
const HOST = '127.0.0.1';
const FOUND = '192.0.2.11';
const PORT = 11434;
const network = { id: 'office', dnsSuffix: 'corp.example.org' };
const section: DiscoverySection = { networks: [network], announce: true, scanRanges: [], personalApprovals: false };
const listedFacts: NetworkFacts = { dnsSearch: [network.dnsSuffix], source: 'linux' };
const certificate = new X509Certificate(readFileSync(path.resolve(__dirname, '../../test/fixtures/cyber/certs/patched/server.pem')));
const expectedPin = peerFingerprint({ raw: certificate.raw }, 'public-key-sha256');

function dnsName(value: string): number[] {
  return [...value.split('.').flatMap((label) => [Buffer.byteLength(label), ...Buffer.from(label)]), 0];
}

function record(owner: string, type: number, data: number[]): number[] {
  return [...dnsName(owner), 0, type, 0, 1, 0, 0, 0, 120, 0, data.length, ...data];
}

function announcement(ipv6 = false, address = HOST): Uint8Array {
  const instance = 'Fixture Ollama.' + SERVICE;
  return Uint8Array.from([
    0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 2,
    ...record(SERVICE, 12, dnsName(instance)),
    ...record(instance, 33, [0, 0, 0, 0, PORT >> 8, PORT & 255, ...dnsName('fixture.local')]),
    ...record('fixture.local', ipv6 ? 28 : 1, ipv6 ? [...Array<number>(15).fill(0), 1] : address.split('.').map(Number))
  ]);
}

function policy(discovery: DiscoverySection | undefined = section): GuidePolicy {
  const effective = policyDocumentFor({ key: deviceKey() });
  return readGuidePolicy({
    effective: { ...effective, onboarding: { v: 1, contacts: [], locked: {}, kindsOfWork: ['analysis'], discovery } },
    organization: 'none', startingRules: false, issuedHere: false
  });
}

function fixture(overrides: Partial<GuideDiscoveryDeps> = {}, address = HOST) {
  let currentPolicy = policy();
  const calls: string[] = [];
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const deps: GuideDiscoveryDeps = {
    policy: () => currentPolicy, endpoints: () => [], organization: { present: false, issuedHere: false },
    async networkFacts() { calls.push('facts'); return listedFacts; },
    createSocket() {
      calls.push('datagram');
      let receive: (bytes: Uint8Array) => void;
      return {
        bind(_port, ready) { ready?.(); },
        send() { calls.push('advertisement-query'); receive(announcement(false, address)); receive(announcement(false, address)); },
        on(_event, handler) { receive = handler; },
        address() { return { port: 49152 }; },
        close() { calls.push('close-datagram'); }
      };
    },
    resolver: { async resolveSrv(name) { calls.push(name); return []; } },
    tlsConnect(options) {
      assert.equal(options.host, address);
      assert.equal(options.port, PORT);
      calls.push('handshake');
      const socket = new EventEmitter();
      queueMicrotask(() => socket.emit('secureConnect'));
      return Object.assign(socket, {
        getPeerCertificate() { return { raw: certificate.raw }; },
        destroy() { calls.push('close-tls'); socket.emit('close'); }
      });
    },
    fetchForPin(pin) {
      assert.equal(pin, expectedPin);
      calls.push('pin');
      return async (input, options) => {
        calls.push('signature');
        requests.push({ url: String(input), options });
        return Response.json({ version: '0.12.3' });
      };
    },
    clock: { now: () => 1000, setTimeout: (callback) => setImmediate(callback),
      clearTimeout: (handle) => { if (handle) clearImmediate(handle as NodeJS.Immediate); } },
    ...overrides
  };
  return { guide: createGuideDiscovery(deps), calls, requests, setPolicy(value: GuidePolicy) { currentPolicy = value; } };
}

test('listed announcements yield an unapproved Ollama row after just one pinned signature check', async () => {
  const { guide, calls, requests } = fixture();
  let raised = 0;
  const listener = guide.onDidChange(() => { raised++; });
  await guide.refresh(new AbortController().signal);
  listener.dispose();
  assert.deepEqual(guide.rows(), [{
    id: 'found-127-0-0-1-11434', name: 'Fixture Ollama', host: HOST, port: PORT, state: 'found',
    kind: 'ollama', version: '0.12.3', action: 'approve'
  }]);
  assert.equal(raised, 1);
  assert.deepEqual(calls.slice(-4), ['handshake', 'close-tls', 'pin', 'signature']);
  assert.deepEqual(requests.map(({ url }) => url), ['https://127.0.0.1:11434/api/version']);
  assert.equal(requests[0].options?.method, 'GET');
  assert.equal(requests[0].options?.credentials, 'omit');
  assert.equal(requests[0].options?.redirect, 'manual');
  assert.equal(requests[0].options?.body, undefined);
  assert.deepEqual([...new Headers(requests[0].options?.headers)], [['accept', 'application/json']]);
  assert.equal(await guide.approve(guide.rows()[0].id), 'not-allowed');
});

test('a host already listed in policy produces no discovery row or follow-up requests', async () => {
  const endpoint: PolicyEndpoint = { id: 'local-service', host: HOST, class: 'local', scheme: 'https', tlsPins: [],
    region: 'unstated', maxLabel: ['org/Public'] };
  const { guide, calls } = fixture({ endpoints: () => [endpoint] });
  await guide.refresh(new AbortController().signal);
  assert.deepEqual(guide.rows(), []);
  assert.equal(calls.includes('handshake'), false);
  assert.equal(calls.includes('pin'), false);
  assert.equal(calls.includes('signature'), false);
});

test('the AAAA loopback announcement uses an IPv6 URL and a bare TLS host', async () => {
  const handshakes: Array<string | undefined> = [];
  const run = fixture({
    createSocket() {
      let receive: (bytes: Uint8Array) => void;
      return {
        bind(_port, ready) { ready?.(); },
        send() { receive(announcement(true)); },
        on(_event, handler) { receive = handler; },
        address() { return { port: 49152 }; },
        close() {}
      };
    },
    tlsConnect(options) {
      handshakes.push(options.host);
      const socket = new EventEmitter();
      queueMicrotask(() => socket.emit('secureConnect'));
      return Object.assign(socket, {
        getPeerCertificate() { return { raw: certificate.raw }; },
        destroy() { socket.emit('close'); }
      });
    }
  });
  await run.guide.refresh(new AbortController().signal);
  assert.deepEqual(handshakes, ['::1']);
  assert.equal(run.guide.rows()[0]?.host, '[::1]');
  assert.deepEqual(run.requests.map(({ url }) => url), ['https://[::1]:11434/api/version']);
});

test('a single listed DNS suffix is queried and duplicate SRV answers use one pinned transport', async () => {
  const names: string[] = [];
  const handshakes: string[] = [];
  const fetched: string[] = [];
  const host = 'fixture.corp.example.org';
  const run = fixture({
    endpoints: () => [{ id: 'local', host: HOST, class: 'local', scheme: 'https', tlsPins: [], region: 'unstated', maxLabel: ['org/Public'] }],
    resolver: { async resolveSrv(name) {
      names.push(name);
      return [{
        name: host, port: PORT, priority: 0, weight: 1
      }, {
        name: host.toUpperCase() + '.', port: PORT, priority: 1, weight: 1
      }];
    } },
    tlsConnect(options) {
      handshakes.push(options.host!);
      const socket = new EventEmitter();
      queueMicrotask(() => socket.emit('secureConnect'));
      return Object.assign(socket, {
        getPeerCertificate() { return { raw: certificate.raw }; },
        destroy() { socket.emit('close'); }
      });
    },
    fetchForPin(pin) {
      assert.equal(pin, expectedPin);
      return async (input) => {
        fetched.push(String(input));
        return Response.json({ version: '0.12.3' });
      };
    }
  });
  await run.guide.refresh(new AbortController().signal);
  assert.deepEqual(names, ['_near-ai-models._tcp.corp.example.org']);
  assert.deepEqual(handshakes, [host]);
  assert.deepEqual(fetched, ['https://' + host + ':11434/api/version']);
  assert.deepEqual(run.guide.rows().map((row) => row.host), [host]);
});

test('a failed or disabled policy leaves every source untouched', async () => {
  for (const denied of [
    { state: 'failed-closed', sentence: 'Fixture policy failed', contacts: [] } as const,
    policy({ ...section, announce: false }), policy({ ...section, networks: [] })
  ]) {
    const { guide, calls, setPolicy } = fixture();
    setPolicy(denied);
    await guide.refresh(new AbortController().signal);
    assert.deepEqual(calls, []);
    assert.deepEqual(guide.rows(), []);
  }
});

test('unlisted network facts prevent both announcement sources and all follow-up requests', async () => {
  let factReads = 0;
  const { guide, calls } = fixture({ async networkFacts() {
    factReads++;
    return { source: 'linux', dnsSearch: ['unlisted.example.org'] };
  } });
  await guide.refresh(new AbortController().signal);
  assert.equal(factReads, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(guide.rows(), []);
});

test('an organization without delegated authority offers Ask and hides old rows on policy change', async () => {
  const { guide, setPolicy } = fixture({ organization: { present: true, issuedHere: false } });
  await guide.refresh(new AbortController().signal);
  assert.equal(guide.rows()[0]?.action, 'ask');
  setPolicy(policy({ ...section, announce: false }));
  assert.deepEqual(guide.rows(), []);
});

test('pin failure never calls the signature transport', async () => {
  const { guide, calls } = fixture({ tlsConnect() { throw new Error('Fixture TLS unavailable'); } });
  await guide.refresh(new AbortController().signal);
  assert.equal(guide.rows()[0]?.state, 'no-tls');
  assert.equal(guide.rows()[0]?.action, 'none');
  assert.equal(calls.includes('pin'), false);
  assert.equal(calls.includes('signature'), false);
});

test('revocation while reading the pin prevents identification of the stale candidate', async () => {
  let setPolicy!: (value: GuidePolicy) => void;
  const run = fixture({ tlsConnect() {
    const socket = new EventEmitter();
    queueMicrotask(() => {
      setPolicy(policy({ ...section, announce: false }));
      socket.emit('secureConnect');
    });
    return Object.assign(socket, {
      getPeerCertificate() { return { raw: certificate.raw }; },
      destroy() { socket.emit('close'); }
    });
  } });
  setPolicy = run.setPolicy;
  await run.guide.refresh(new AbortController().signal);
  assert.deepEqual(run.guide.rows(), []);
  assert.equal(run.calls.includes('pin'), false);
  assert.equal(run.calls.includes('signature'), false);
});

test('revocation while binding prevents a stale announcement query', async () => {
  let setPolicy!: (value: GuidePolicy) => void;
  let sent = 0;
  const run = fixture({ createSocket() {
    return {
      bind(_port, ready) {
        setPolicy(policy({ ...section, announce: false }));
        ready?.();
      },
      send() { sent++; },
      on() {},
      address() { return { port: 49152 }; },
      close() {}
    };
  } });
  setPolicy = run.setPolicy;
  await run.guide.refresh(new AbortController().signal);
  assert.deepEqual(run.guide.rows(), []);
  assert.deepEqual(run.calls, ['facts']);
  assert.equal(sent, 0);
});

function editorFixture(outcome: Parameters<typeof recordingPolicyEditor>[0] = 'discarded') {
  const editor = recordingPolicyEditor(outcome);
  editor.register({
    state: () => undefined, directionOf: () => undefined,
    applyPersonal: async () => assert.fail('the guide must not apply any policy'),
    signer: () => undefined, reset: async () => assert.fail('no reset'),
    showStored: async () => {}, record() {}, onDidChange: () => ({ dispose() {} })
  });
  return editor;
}

test('Approve checks the pin again, opens one pinned proposal and records its editor outcome without changing policy', async () => {
  const { root, storage, host, audit } = await setup();
  const editor = editorFixture();
  const before = host.policyLayers().personal;
  assert.ok(before);
  const run = fixture({ editor, audit }, FOUND);
  await run.guide.refresh(new AbortController().signal);
  const id = run.guide.rows()[0].id;
  const first = run.guide.approve(id);
  assert.equal(await run.guide.approve(id), 'not-allowed');
  assert.equal(await first, 'opened');
  assert.equal(run.guide.rows()[0]?.state, 'proposed');
  assert.equal(editor.proposed.length, 1);
  assert.equal(editor.proposed[0].target, 'personal');
  const proposed = editor.proposed[0].next(before.document);
  assert.deepEqual(proposed.endpoints, [{
    id, host: FOUND, class: 'org-plain', scheme: 'https', tlsPins: [expectedPin],
    region: 'unstated', maxLabel: ['org/Public'], provider: 'ollama'
  }]);
  assert.equal(host.policyLayers().personal?.hash, before.hash);
  assert.equal(host.policyLayers().effective?.endpoints, undefined);
  assert.equal(run.calls.filter((call) => call === 'handshake').length, 2);
  assert.equal(run.requests.length, 1);
  const verified = await audit.verify();
  assert.ok(verified.ok);
  assert.equal(verified.head?.seq, 1);
  const file = path.join(storage, GATE_DIR_NAME, SETUP_AUDIT_DIR, projectLogKey(root) + '.jsonl');
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.event, 'setup.discovery.approved-proposal');
  assert.match(record.body.proposalId, /^[a-z0-9-]+$/);
  assert.deepEqual(record.body, { endpointId: id, serverKind: 'ollama', pin: expectedPin,
    proposalId: record.body.proposalId, outcome: 'discarded' });
});

test('an authorized organization proposal uses Internal and a delegated personal proposal preserves inherited endpoints', async () => {
  const { audit } = await setup();
  const editor = editorFixture('exported');
  const inherited: PolicyEndpoint = { id: 'existing', host: 'owned.corp.example.org', class: 'org-plain', scheme: 'https',
    tlsPins: ['a'.repeat(64)], region: 'CA', maxLabel: ['org/Internal'] };
  const personal = policyDocumentFor({ key: deviceKey() });
  const organization = { ...policyDocumentFor({ key: deviceKey(), layer: 'organization' }),
    endpoints: [inherited], requires: [...new Set([...personal.requires, 'endpoints@1' as const, 'onboarding@1' as const])].sort(),
    onboarding: { v: 1 as const, contacts: [], locked: {}, kindsOfWork: ['analysis' as const],
      discovery: { ...section, personalApprovals: true } } };
  const run = fixture({ editor, audit, organization: { present: true, issuedHere: true }, endpoints: () => [inherited] }, FOUND);
  await run.guide.refresh(new AbortController().signal);
  assert.equal(await run.guide.approve(run.guide.rows()[0].id), 'opened');
  assert.equal(editor.proposed[0].target, 'organization');
  assert.deepEqual(editor.proposed[0].next(organization).endpoints?.find(({ host }) => host === FOUND)?.maxLabel, ['org/Internal']);

  const delegated = fixture({ editor, audit, organization: { present: true, issuedHere: false }, endpoints: () => [inherited] }, FOUND);
  delegated.setPolicy(policy({ ...section, personalApprovals: true }));
  await delegated.guide.refresh(new AbortController().signal);
  assert.equal(await delegated.guide.approve(delegated.guide.rows()[0].id), 'opened');
  const change = editor.proposed[1];
  assert.equal(change.target, 'personal');
  const changed = change.next(personal);
  const composed = composeLayers({ organization, personal: changed }).effective.endpoints;
  assert.deepEqual(composed?.find(({ id }) => id === inherited.id), inherited);
  assert.deepEqual(composed?.find(({ host }) => host === FOUND)?.maxLabel, ['org/Public']);
  assert.deepEqual(change.next({ ...personal, endpoints: [] }).endpoints?.map(({ host }) => host), [FOUND]);
});

test('approval rejects an Ask row, a missing editor and an unavailable pin without opening a proposal', async () => {
  const { audit } = await setup();
  const editor = editorFixture();
  const ask = fixture({ editor, audit, organization: { present: true, issuedHere: false } }, FOUND);
  const noEditor = fixture({ audit }, FOUND);
  const noTls = fixture({ editor, audit, tlsConnect() { throw new Error('unavailable TLS'); } }, FOUND);
  for (const [run, outcome] of [[ask, 'not-allowed'], [noEditor, 'failed'], [noTls, 'not-allowed']] as const) {
    await run.guide.refresh(new AbortController().signal);
    const before = run.calls.length;
    assert.equal(await run.guide.approve(run.guide.rows()[0].id), outcome);
    assert.equal(run.calls.length, before);
  }
  assert.equal(editor.proposed.length, 0);
});

test('a changed pin or current network invalidates an earlier discovery result', async () => {
  const { audit } = await setup();
  const editor = editorFixture();
  const other = new X509Certificate(readFileSync(path.resolve(__dirname, '../../test/fixtures/cyber/certs/vulnerable/server.pem')));
  let handshakes = 0;
  const changed = fixture({ editor, audit, tlsConnect() {
    const selected = ++handshakes === 1 ? certificate : other;
    const socket = new EventEmitter();
    queueMicrotask(() => socket.emit('secureConnect'));
    return Object.assign(socket, { getPeerCertificate: () => ({ raw: selected.raw }), destroy() { socket.emit('close'); } });
  } }, FOUND);
  await changed.guide.refresh(new AbortController().signal);
  assert.equal(await changed.guide.approve(changed.guide.rows()[0].id), 'not-allowed');
  assert.equal(handshakes, 2);
  assert.equal(changed.requests.length, 1);

  let reads = 0;
  const moved = fixture({ editor, audit, async networkFacts() {
    return ++reads === 1 ? listedFacts : { source: 'unknown', dnsSearch: [] };
  } }, FOUND);
  await moved.guide.refresh(new AbortController().signal);
  assert.equal(await moved.guide.approve(moved.guide.rows()[0].id), 'not-allowed');
  assert.equal(moved.calls.filter((call) => call === 'handshake').length, 1);
  assert.equal(editor.proposed.length, 0);
  const verified = await audit.verify();
  assert.ok(verified.ok);
  assert.equal(verified.head, undefined);
});

test('revoking delegated approval during the pin recheck prevents the editor from opening', async () => {
  const { audit } = await setup();
  const editor = editorFixture();
  let handshakes = 0;
  const run = fixture({ editor, audit, organization: { present: true, issuedHere: false }, tlsConnect() {
    const socket = new EventEmitter();
    queueMicrotask(() => {
      if (++handshakes === 2) run.setPolicy(policy(section));
      socket.emit('secureConnect');
    });
    return Object.assign(socket, { getPeerCertificate: () => ({ raw: certificate.raw }), destroy() { socket.emit('close'); } });
  } }, FOUND);
  run.setPolicy(policy({ ...section, personalApprovals: true }));
  await run.guide.refresh(new AbortController().signal);
  assert.equal(await run.guide.approve(run.guide.rows()[0].id), 'not-allowed');
  assert.equal(handshakes, 2);
  assert.deepEqual(run.guide.rows(), []);
  assert.deepEqual(editor.proposed, []);
});

const scanRange = FOUND + '/32';
const scanPolicy = { ...section, announce: false, scanRanges: [{ cidr: scanRange, network: 'office' }] };

function waitForScan(guide: ReturnType<typeof createGuideDiscovery>) {
  return new Promise<void>((resolve) => {
    const watcher = guide.onDidChange(() => {
      if (!guide.scanOffer().running) { watcher.dispose(); resolve(); }
    });
  });
}

async function scanAudit({ root, storage }: Awaited<ReturnType<typeof setup>>) {
  const file = path.join(storage, GATE_DIR_NAME, SETUP_AUDIT_DIR, projectLogKey(root) + '.jsonl');
  return (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

test('the offer quotes the exact ranges and ports and stays off where the network is unlisted', async () => {
  const { audit } = await setup();
  const run = fixture({ audit, hostKind: 'container', tcpConnect: async () => assert.fail('offer alone cannot connect') });
  run.setPolicy(policy(scanPolicy));
  await run.guide.refresh(new AbortController().signal);
  const offer = run.guide.scanOffer();
  assert.equal(offer.offered, true);
  assert.deepEqual(offer.ranges, [scanRange]);
  assert.ok(offer.confirmText?.includes(scanRange));
  for (const port of MODEL_SERVER_PORTS) assert.ok(offer.confirmText?.includes(String(port)));
  assert.match(offer.confirmText ?? '', /about 1 minute.*network team may see this as a scan/i);
  assert.deepEqual(run.calls, ['facts']);
  const event = parseGuideInbound({ type: 'scan-confirm', ranges: offer.ranges });
  assert.deepEqual(event, { type: 'scan-confirm', ranges: [scanRange] });

  const unlisted = fixture({ audit, hostKind: 'container', tcpConnect: async () => assert.fail('unlisted scope'),
    networkFacts: async () => ({ source: 'unknown', dnsSearch: [network.dnsSuffix] }) });
  unlisted.setPolicy(policy({ ...scanPolicy, announce: true }));
  await unlisted.guide.refresh(new AbortController().signal);
  assert.deepEqual(unlisted.calls, []);
  assert.equal(unlisted.guide.scanOffer().offered, false);
  assert.equal(unlisted.guide.scanOffer().reasonOff, NOT_LISTED_NETWORK_TEXT);
});

test('exact confirmation starts a background scan, shows progress and audits one pinned candidate', { timeout: 3000 }, async () => {
  const store = await setup();
  const ports: number[] = [];
  let finishFirst!: (open: boolean) => void;
  let entered!: () => void;
  const enteredFirst = new Promise<void>((resolve) => { entered = resolve; });
  const run = fixture({ audit: store.audit, hostKind: 'container', tcpConnect(host, port) {
    assert.equal(host, FOUND);
    ports.push(port);
    if (ports.length !== 1) return Promise.resolve(port === PORT);
    entered();
    return new Promise((resolve) => { finishFirst = resolve; });
  }, clock: { now: () => 1000, setTimeout: (callback) => setTimeout(callback, 100),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) } }, FOUND);
  run.setPolicy(policy(scanPolicy));
  const progress: Array<number | undefined> = [];
  run.guide.onDidChange(() => { if (run.guide.scanOffer().running) progress.push(run.guide.scanOffer().done); });
  await run.guide.refresh(new AbortController().signal);
  const done = waitForScan(run.guide);
  await run.guide.startScan(run.guide.scanOffer().ranges);
  assert.equal(run.guide.scanOffer().running, true);
  await enteredFirst;
  finishFirst(false);
  await done;
  assert.deepEqual(ports, MODEL_SERVER_PORTS);
  assert.ok(progress.includes(1));
  assert.equal(run.guide.rows()[0]?.state, 'found');
  assert.equal(run.guide.rows()[0]?.host, FOUND);
  assert.deepEqual(run.requests.map(({ url }) => url), ['https://' + FOUND + ':11434/api/version']);
  const log = await scanAudit(store);
  assert.deepEqual(log.map(({ event, body }) => [event, body]), ['start', 'end'].map((phase) => [
    'setup.discovery.scan', { phase, ranges: [scanRange], ports: MODEL_SERVER_PORTS, found: phase === 'start' ? 0 : 1, hostKind: 'container' }
  ]));
  const verdict = await store.audit.verify();
  assert.ok(verdict.ok);
  assert.equal(verdict.head?.seq, 2);
  await run.guide.startScan([scanRange]);
  assert.deepEqual(ports, MODEL_SERVER_PORTS);
});

test('a forged, partial or obsolete confirmation reaches no transport and writes no audit record', async () => {
  const store = await setup();
  let calls = 0;
  const run = fixture({ audit: store.audit, hostKind: 'container', async tcpConnect() { calls++; return false; } });
  run.setPolicy(policy({ ...scanPolicy, scanRanges: [...scanPolicy.scanRanges, { cidr: '192.0.2.12/32', network: 'office' }] }));
  await run.guide.startScan([scanRange, '192.0.2.12/32']);
  await run.guide.refresh(new AbortController().signal);
  await run.guide.startScan(['198.51.100.0/24']);
  await run.guide.startScan([scanRange]);
  const offered = run.guide.scanOffer().ranges;
  run.setPolicy(policy(scanPolicy));
  await run.guide.startScan(offered);
  assert.equal(calls, 0);
  const verdict = await store.audit.verify();
  assert.ok(verdict.ok);
  assert.equal(verdict.head, undefined);
});

test('Stop and policy revocation close the active run without publishing stale candidates', { timeout: 3000 }, async () => {
  for (const mode of ['stop', 'revoke', 'cancel'] as const) {
    const store = await setup();
    let transport: AbortSignal | undefined;
    let invoked!: () => void;
    const opened = new Promise<void>((resolve) => { invoked = resolve; });
    const parent = new AbortController();
    const run = fixture({ audit: store.audit, hostKind: 'container', tcpConnect(_host, _port, _timeout, signal) {
      transport = signal;
      invoked();
      if (mode === 'revoke') {
        run.setPolicy(policy({ ...scanPolicy, scanRanges: [] }));
        return Promise.resolve(true);
      }
      return new Promise(() => undefined);
    } }, FOUND);
    run.setPolicy(policy(scanPolicy));
    await run.guide.refresh(parent.signal);
    const done = waitForScan(run.guide);
    await run.guide.startScan(run.guide.scanOffer().ranges);
    await opened;
    if (mode === 'stop') run.guide.stopScan();
    if (mode === 'cancel') parent.abort();
    await done;
    assert.deepEqual(run.guide.rows(), []);
    assert.equal(run.calls.includes('handshake'), false);
    if (mode !== 'revoke') assert.equal(transport?.aborted, true);
    if (mode === 'stop') assert.equal(run.guide.scanOffer().reasonOff, SCAN_STOPPED_TEXT);
    const log = await scanAudit(store);
    assert.deepEqual(log.map(({ body }) => [body.phase, body.found]), [['start', 0], ['end', 0]]);
  }
});

test('confirmation rechecks the network and refuses to connect if the start record cannot be saved', { timeout: 3000 }, async () => {
  for (const denied of ['network', 'audit'] as const) {
    let facts = 0;
    const records: string[] = [];
    let connected = 0;
    const run = fixture({
      hostKind: 'container',
      async networkFacts() {
        return ++facts === 1 || denied === 'audit' ? listedFacts : { source: 'unknown', dnsSearch: [] };
      },
      audit: { async append(event) {
        records.push(event);
        return { ok: false, reason: 'Fixture audit failure' };
      } },
      async tcpConnect() { connected++; return false; }
    });
    run.setPolicy(policy(scanPolicy));
    await run.guide.refresh(new AbortController().signal);
    const done = waitForScan(run.guide);
    await run.guide.startScan(run.guide.scanOffer().ranges);
    await done;
    assert.equal(facts, 2);
    assert.equal(connected, 0);
    assert.deepEqual(records, denied === 'audit' ? ['setup.discovery.scan'] : []);
    assert.equal(run.guide.scanOffer().reasonOff, denied === 'audit' ? SCAN_STOPPED_TEXT : NOT_LISTED_NETWORK_TEXT);
  }
});

test('moving to an unlisted network during a scan prevents later connects and candidate requests', { timeout: 3000 }, async () => {
  const store = await setup();
  let moved = false;
  const ports: number[] = [];
  const run = fixture({
    audit: store.audit, hostKind: 'container',
    async networkFacts() {
      return moved ? { source: 'linux', dnsSearch: ['unlisted.example.org'] } : listedFacts;
    },
    async tcpConnect(_host, port) {
      assert.equal(moved, false);
      ports.push(port);
      moved = true;
      return true;
    }
  }, FOUND);
  run.setPolicy(policy(scanPolicy));
  await run.guide.refresh(new AbortController().signal);
  const done = waitForScan(run.guide);
  await run.guide.startScan(run.guide.scanOffer().ranges);
  await done;
  assert.deepEqual(ports, [MODEL_SERVER_PORTS[0]]);
  assert.equal(run.calls.includes('handshake'), false);
  assert.deepEqual(run.requests, []);
  assert.deepEqual(run.guide.rows(), []);
  assert.equal(run.guide.scanOffer().reasonOff, NOT_LISTED_NETWORK_TEXT);
  const log = await scanAudit(store);
  assert.deepEqual(log.map(({ body }) => body.phase), ['start', 'end']);
});

test('a network change during the candidate handshake prevents the pinned signature request', { timeout: 3000 }, async () => {
  const store = await setup();
  let moved = false;
  let handshakes = 0;
  const run = fixture({
    audit: store.audit, hostKind: 'container',
    async networkFacts() {
      return moved ? { source: 'unknown', dnsSearch: [] } : listedFacts;
    },
    async tcpConnect(_host, port) { return port === PORT; },
    tlsConnect() {
      const socket = new EventEmitter();
      queueMicrotask(() => socket.emit('secureConnect'));
      return Object.assign(socket, {
        getPeerCertificate() { handshakes++; moved = true; return { raw: certificate.raw }; },
        destroy() { socket.emit('close'); }
      });
    }
  }, FOUND);
  run.setPolicy(policy(scanPolicy));
  await run.guide.refresh(new AbortController().signal);
  const done = waitForScan(run.guide);
  await run.guide.startScan(run.guide.scanOffer().ranges);
  await done;
  assert.equal(handshakes, 1);
  assert.deepEqual(run.requests, []);
  assert.deepEqual(run.guide.rows(), []);
  assert.equal(run.guide.scanOffer().reasonOff, NOT_LISTED_NETWORK_TEXT);
});

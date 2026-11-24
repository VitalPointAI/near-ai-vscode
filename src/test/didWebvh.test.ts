// did:webvh v1.0 logs verified from a cached copy (Phase 71 plan 04 Task 2; D-13, DLGT-01). The DIF test suite's vectors (test/fixtures/did/webvh,
// Apache-2.0, read as data only) and our own fictional logs for Example Organization. Test keys are generated at run time.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { createProof } from '../domain/credentials/dataIntegrity';
import { encodePublicKeyMultibase } from '../domain/credentials/multibase';
import type { CredentialSigner } from '../domain/credentials/dataIntegrity';
import {
  MAX_LOG_BYTES, WEBVH_FAILURES, buildGenesisEntry, buildUpdateEntry, buildWitnessProof, isSha256Multihash, methodsAt, multihashBase58, nextKeyHash,
  parseWebvhDid, verifyWebvhLog, versionAt
} from '../domain/did/didWebvh';
import type { WebvhState, WitnessConfig } from '../domain/did/didWebvh';

const VECTORS = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'did', 'webvh', 'vectors.json'), 'utf8')) as { files: Record<string, string> };
const FILES = VECTORS.files;
const NOW = Date.UTC(2026, 10, 24, 12);

interface TestKey { multikey: string; did: string; signer: CredentialSigner }

function newKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const multikey = encodePublicKeyMultibase('Ed25519', new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
  const did = `did:key:${multikey}`;
  return { multikey, did, signer: { verificationMethod: `${did}#${multikey}`, suite: 'eddsa-jcs-2022', sign: async (bytes) => new Uint8Array(cryptoSign(null, bytes, privateKey)) } };
}

function documentFor(assertionKey: string): (did: string) => Record<string, unknown> {
  return (did) => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    controller: did,
    verificationMethod: [{ id: `${did}#issuing`, type: 'Multikey', controller: did, publicKeyMultibase: assertionKey }],
    authentication: [`${did}#issuing`],
    assertionMethod: [`${did}#issuing`]
  });
}

function ok(result: ReturnType<typeof verifyWebvhLog>): WebvhState {
  assert.equal(result.ok, true, result.ok ? '' : `${result.reason} at entry ${String(result.entry)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.state;
}

function reason(result: ReturnType<typeof verifyWebvhLog>): string {
  return result.ok ? 'ok' : result.reason;
}

// ---- The DIF vectors ----

function scenarios(): Array<{ folder: string; negative: boolean }> {
  const out: Array<{ folder: string; negative: boolean }> = [];
  for (const file of Object.keys(FILES)) {
    if (!file.endsWith('/did.jsonl')) continue;
    out.push({ folder: file.slice(0, -'/did.jsonl'.length), negative: file.startsWith('negative-') });
  }
  return out;
}

function withoutEmptyLists(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmptyLists);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => !(Array.isArray(child) && child.length === 0)).map(([key, child]) => [key, withoutEmptyLists(child)]));
}

// Resolvers add the implicit #files and #whois services (did:webvh 1.0, DID URL Resolution) to what they return; the log does not hold them, and
// some implementations also add empty relationship lists. Both sides are compared without those.
function comparable(document: unknown): unknown {
  const copy = { ...(document as Record<string, unknown>) };
  if (Array.isArray(copy.service)) {
    const explicit = copy.service.filter((service) => !/#(files|whois)$/.test(String((service as { id?: unknown }).id)));
    if (explicit.length === 0) delete copy.service;
    else copy.service = explicit;
  }
  return withoutEmptyLists(copy);
}

function compareResolution(state: WebvhState, resultText: string, versionNumber: number | undefined, where: string): void {
  const result = JSON.parse(resultText) as { didDocument?: unknown; didDocumentMetadata?: Record<string, unknown> };
  let version = versionNumber === undefined ? state.versions[state.versions.length - 1] : state.versions[versionNumber - 1];
  assert.ok(version, where);
  const metadata = result.didDocumentMetadata ?? {};
  // The Python resolver answers a request for an earlier version with the latest one (document and metadata), so a result is compared with the
  // version its own metadata names.
  if (typeof metadata.versionId === 'string') {
    const named = state.versions.find((entry) => entry.versionId === metadata.versionId);
    assert.ok(named, `${where} versionId names a verified version`);
    if (typeof metadata.versionTime === 'string') assert.equal(named.versionTime, metadata.versionTime, `${where} versionTime`);
    version = named;
  }
  if (typeof metadata.scid === 'string') assert.equal(state.scid, metadata.scid, `${where} scid`);
  if (typeof metadata.deactivated === 'boolean') assert.equal(version.deactivated, metadata.deactivated, `${where} deactivated`);
  if (versionNumber === undefined && Array.isArray(metadata.updateKeys)) assert.deepEqual([...state.parameters.updateKeys], metadata.updateKeys, `${where} updateKeys`);
  if (result.didDocument !== null && result.didDocument !== undefined && !version.deactivated) {
    assert.deepEqual(comparable(version.document), comparable(result.didDocument), `${where} document`);
  }
}

test('DIF vectors: every happy-path log of every implementation verifies, and its document and core metadata match the suite\'s resolution results', () => {
  let logs = 0;
  let compared = 0;
  for (const { folder, negative } of scenarios()) {
    if (negative) continue;
    const log = FILES[`${folder}/did.jsonl`] as string;
    const witnessFile = FILES[`${folder}/did-witness.json`];
    const state = ok(verifyWebvhLog(log, { now: NOW, ...(witnessFile === undefined ? {} : { witnessFile }) }));
    logs += 1;
    for (const [file, text] of Object.entries(FILES)) {
      const match = new RegExp(`^${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/resolutionResult(?:\\.(\\d+))?\\.json$`).exec(file);
      if (match === null) continue;
      compareResolution(state, text, match[1] === undefined ? undefined : Number(match[1]), file);
      compared += 1;
    }
  }
  assert.equal(logs, 82, 'all 82 happy-path logs ran; none was skipped');
  assert.ok(compared >= 82, `every log was compared with its resolution result (${String(compared)})`);
});

// The reason each log-level negative vector is refused with, pinned so a refusal for the wrong reason is caught.
const NEGATIVE_REASONS: Readonly<Record<string, string>> = {
  'negative-cross-did-witness-replay/ts': 'witness-threshold',
  'negative-did-key-body-fragment-mismatch/ts': 'unauthorized-key',
  'negative-duplicate-witness-ids/ts': 'bad-parameters',
  'negative-portable-scid-swap/ts': 'bad-state',
  'negative-pre-rotation-omit-updatekeys/ts': 'pre-rotation',
  'negative-scid-mismatch-genesis/ts': 'bad-scid',
  'negative-unknown-method-version/ts': 'unknown-method',
  'negative-versiontime-future/ts': 'version-time-future',
  'negative-versiontime-non-monotonic/ts': 'bad-version-time',
  'negative-witness-update-threshold-not-met/ts': 'witness-threshold',
  'negative-wrong-cryptosuite/ts': 'bad-proof',
  'negative-zero-witness-threshold/ts': 'bad-parameters'
};

test('DIF vectors: every negative log is refused with its named reason, and every DID of the parser-level negative vectors is refused', () => {
  const seen: string[] = [];
  let parserDids = 0;
  for (const { folder, negative } of scenarios()) {
    if (!negative) continue;
    const log = FILES[`${folder}/did.jsonl`] as string;
    if (log.trim().length === 0) continue;
    const witnessFile = FILES[`${folder}/did-witness.json`];
    const result = verifyWebvhLog(log, { now: NOW, ...(witnessFile === undefined ? {} : { witnessFile }) });
    assert.equal(reason(result), NEGATIVE_REASONS[folder] ?? 'refused', folder);
    seen.push(folder);
  }
  assert.deepEqual(seen.sort(), Object.keys(NEGATIVE_REASONS).sort(), 'every log-level negative vector ran');
  for (const [file, text] of Object.entries(FILES)) {
    if (!file.startsWith('negative-') || !file.endsWith('/script.yaml')) continue;
    for (const match of text.matchAll(/^\s+did: "([^"]+)"$/gm)) {
      assert.equal(parseWebvhDid(match[1]).ok, false, `${file}: ${match[1] as string}`);
      parserDids += 1;
    }
  }
  assert.equal(parserDids, 12, 'all parser-level DIDs ran');
});

test('parseWebvhDid reads the SCID, the host, a port and path segments, and gives the log location', () => {
  const scid = 'QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ';
  const person = parseWebvhDid(`did:webvh:${scid}:hq.example.org:people:x7k2p9`);
  assert.equal(person.ok, true);
  if (person.ok) {
    assert.deepEqual([...person.value.path], ['people', 'x7k2p9']);
    assert.equal(person.value.logUrl, 'https://hq.example.org/people/x7k2p9/did.jsonl');
  }
  const root = parseWebvhDid(`did:webvh:${scid}:hq.example.org%3A8443`);
  assert.equal(root.ok && root.value.logUrl, 'https://hq.example.org:8443/.well-known/did.jsonl');
  for (const bad of [`did:webvh:${scid}`, `did:webvh:${scid}:localhost`, `did:webvh:${scid}:example.org%3A0`, `did:webvh:${scid}:example.org:`, `did:webvh:short:example.org`, `did:webvh:${scid}:example.org/x`]) {
    assert.equal(parseWebvhDid(bad).ok, false, bad);
  }
});

// ---- Our own logs ----

async function rootLog(): Promise<{ log: string; did: string; keys: { current: TestKey; next: TestKey; issuing: TestKey }; state: WebvhState }> {
  const current = newKey();
  const next = newKey();
  const issuing = newKey();
  const genesis = await buildGenesisEntry({
    domain: 'hq.example.org', path: ['org'], updateKeys: [current.multikey], nextKeyHashes: [nextKeyHash(next.multikey)], portable: true,
    versionTime: '2026-11-24T00:00:00Z', document: documentFor(issuing.multikey)
  }, current.signer);
  const log = `${genesis.line}\n`;
  return { log, did: genesis.did, keys: { current, next, issuing }, state: ok(verifyWebvhLog(log, { now: NOW, did: genesis.did })) };
}

test('buildGenesisEntry makes a root DID with pre-rotation on that verifies; its SCID and entry hash are SHA-256 multihashes', async () => {
  const { did, state } = await rootLog();
  assert.match(did, /^did:webvh:Qm[1-9A-HJ-NP-Za-km-z]{44}:hq\.example\.org:org$/);
  assert.ok(isSha256Multihash(state.scid));
  assert.equal(state.parameters.nextKeyHashes.length, 1);
  assert.equal(state.parameters.portable, true);
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.versions[0]?.document));
});

test('a rotation with a pre-committed key verifies; an update signed by a key outside the previous nextKeyHashes is refused', async () => {
  const { log, keys, state } = await rootLog();
  const after = newKey();
  const rotated = await buildUpdateEntry(state, {
    parameters: { updateKeys: [keys.next.multikey], nextKeyHashes: [nextKeyHash(after.multikey)] }, versionTime: '2026-11-25T00:00:00Z', document: documentFor(keys.issuing.multikey)
  }, keys.next.signer);
  ok(verifyWebvhLog(`${log}${rotated.line}\n`, { now: NOW + 86_400_000 }));
  const stranger = newKey();
  const hijack = await buildUpdateEntry(state, {
    parameters: { updateKeys: [stranger.multikey], nextKeyHashes: [] }, versionTime: '2026-11-25T00:00:00Z', document: documentFor(stranger.multikey)
  }, stranger.signer);
  assert.equal(reason(verifyWebvhLog(`${log}${hijack.line}\n`, { now: NOW + 86_400_000 })), 'pre-rotation');
  const withOldKey = await buildUpdateEntry(state, {
    parameters: { updateKeys: [keys.current.multikey], nextKeyHashes: [] }, versionTime: '2026-11-25T00:00:00Z', document: documentFor(keys.issuing.multikey)
  }, keys.current.signer);
  assert.equal(reason(verifyWebvhLog(`${log}${withOldKey.line}\n`, { now: NOW + 86_400_000 })), 'pre-rotation', 'the spent key cannot keep control');
});

async function personLog(): Promise<{ lines: string[]; key: TestKey; states: WebvhState[]; did: string }> {
  const key = newKey();
  const first = newKey();
  const second = newKey();
  const genesis = await buildGenesisEntry({ domain: 'hq.example.org', path: ['people', 'x7k2p9'], updateKeys: [key.multikey], portable: true, versionTime: '2026-11-01T00:00:00Z', document: documentFor(first.multikey) }, key.signer);
  const lines = [genesis.line];
  const states = [ok(verifyWebvhLog(`${lines.join('\n')}\n`, { now: NOW }))];
  const update = await buildUpdateEntry(states[0] as WebvhState, { parameters: {}, versionTime: '2026-11-10T00:00:00Z', document: documentFor(second.multikey) }, key.signer);
  lines.push(update.line);
  states.push(ok(verifyWebvhLog(`${lines.join('\n')}\n`, { now: NOW })));
  const deactivate = await buildUpdateEntry(states[1] as WebvhState, { parameters: { deactivated: true, updateKeys: [] }, versionTime: '2026-11-20T00:00:00Z', document: documentFor(second.multikey) }, key.signer);
  lines.push(deactivate.line);
  states.push(ok(verifyWebvhLog(`${lines.join('\n')}\n`, { now: NOW })));
  return { lines, key, states, did: genesis.did };
}

test('methodsAt gives the assertion key in force at a time: the first key before the rotation, the second after, none after deactivation or before creation', async () => {
  const { states } = await personLog();
  const state = states[2] as WebvhState;
  const keyAt = (iso: string): string | undefined => methodsAt(state, Date.parse(iso))[0]?.publicKeyMultibase;
  const firstKey = (state.versions[0]?.document.verificationMethod as Array<{ publicKeyMultibase: string }>)[0]?.publicKeyMultibase;
  const secondKey = (state.versions[1]?.document.verificationMethod as Array<{ publicKeyMultibase: string }>)[0]?.publicKeyMultibase;
  assert.equal(keyAt('2026-10-31T00:00:00Z'), undefined);
  assert.equal(keyAt('2026-11-05T00:00:00Z'), firstKey);
  assert.equal(keyAt('2026-11-15T00:00:00Z'), secondKey);
  assert.equal(keyAt('2026-11-21T00:00:00Z'), undefined, 'deactivated');
  assert.equal(versionAt(state, Date.parse('2026-11-21T00:00:00Z'))?.deactivated, true);
  assert.deepEqual(methodsAt(state, Date.parse('2026-11-05T00:00:00Z'), 'authentication').map((method) => method.publicKeyMultibase), [firstKey]);
});

test('nothing may follow a deactivation entry', async () => {
  const { lines, key, states } = await personLog();
  const after = await buildUpdateEntry(states[2] as WebvhState, { parameters: {}, versionTime: '2026-11-22T00:00:00Z', document: documentFor(key.multikey) }, key.signer);
  assert.equal(reason(verifyWebvhLog(`${[...lines, after.line].join('\n')}\n`, { now: NOW })), 'deactivated');
});

test('resuming from a cached verified state checks only the new entries and gives the same state as a full verification', async () => {
  const { lines, states } = await personLog();
  const full = verifyWebvhLog(`${lines.join('\n')}\n`, { now: NOW });
  const resumed = verifyWebvhLog(`${lines.join('\n')}\n`, { now: NOW, cached: states[0] });
  assert.equal(resumed.ok && resumed.checked, 2);
  assert.equal(full.ok && full.checked, 3);
  assert.deepEqual(resumed.ok && resumed.state, full.ok && full.state);
  assert.equal(reason(verifyWebvhLog(`${lines.join('\n')}`, { now: NOW, cached: states[2] })), 'ok', 'a copy without the last newline is the same log');
  const otherHistory = await personLog();
  assert.equal(reason(verifyWebvhLog(`${otherHistory.lines.join('\n')}\n`, { now: NOW, cached: states[0] })), 'cache-mismatch');
});

test('a changed entry, a broken chain, a wrong SCID and a move without portability are each refused with a named reason', async () => {
  const { lines } = await personLog();
  const entries = lines.map((line) => JSON.parse(line) as Record<string, any>);
  const changed = structuredClone(entries);
  changed[1].state.controller = 'did:webvh:QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ:example.org';
  assert.equal(reason(verifyWebvhLog(changed.map((entry) => JSON.stringify(entry)).join('\n'), { now: NOW })), 'bad-proof');
  const reordered = [entries[0], entries[2], entries[1]];
  assert.equal(reason(verifyWebvhLog(reordered.map((entry) => JSON.stringify(entry)).join('\n'), { now: NOW })), 'bad-version-id');
  const dropped = [entries[0], entries[2]];
  assert.equal(reason(verifyWebvhLog(dropped.map((entry) => JSON.stringify(entry)).join('\n'), { now: NOW })), 'bad-version-id');
  const key = newKey();
  const forged = await buildGenesisEntry({ domain: 'hq.example.org', path: ['people', 'x7k2p9'], updateKeys: [key.multikey], portable: false, versionTime: '2026-11-01T00:00:00Z', document: documentFor(key.multikey) }, key.signer);
  // A chosen SCID, with the entry re-chained and re-signed by the real key: only the self-certification can tell.
  const chosen = 'QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ';
  const { proof: _proof, ...unsigned } = JSON.parse(forged.line.split(forged.scid).join(chosen)) as Record<string, unknown>;
  const rechained = { ...unsigned, versionId: `1-${multihashBase58(canonicalBytes({ ...unsigned, versionId: chosen }))}` };
  const resigned = { ...rechained, proof: [await createProof(rechained, { proofPurpose: 'assertionMethod', created: '2026-11-01T00:00:00Z' }, key.signer)] };
  assert.equal(reason(verifyWebvhLog(JSON.stringify(resigned), { now: NOW })), 'bad-scid');
  const fixed = ok(verifyWebvhLog(`${forged.line}\n`, { now: NOW }));
  const moved = await buildUpdateEntry(fixed, { parameters: {}, versionTime: '2026-11-02T00:00:00Z', document: (did) => documentFor(key.multikey)(did.replace('hq.example.org', 'edge1.example.org')) }, key.signer);
  assert.equal(reason(verifyWebvhLog(`${forged.line}\n${moved.line}\n`, { now: NOW })), 'bad-state', 'portable was not set at creation');
});

test('a person moved to an edge site keeps the SCID when portable was set at creation and the new document names the old DID', async () => {
  const key = newKey();
  const genesis = await buildGenesisEntry({ domain: 'hq.example.org', path: ['people', 'm1'], updateKeys: [key.multikey], portable: true, versionTime: '2026-11-01T00:00:00Z', document: documentFor(key.multikey) }, key.signer);
  const first = ok(verifyWebvhLog(genesis.line, { now: NOW }));
  const moved = await buildUpdateEntry(first, {
    parameters: {}, versionTime: '2026-11-02T00:00:00Z',
    document: (did) => ({ ...documentFor(key.multikey)(did.replace('hq.example.org', 'edge1.example.org')), alsoKnownAs: [did] })
  }, key.signer);
  // alsoKnownAs is not part of our minimal document, so the moved version names no method of ours until the next entry drops it.
  const state = ok(verifyWebvhLog(`${genesis.line}\n${moved.line}\n`, { now: NOW, did: genesis.did }));
  assert.equal(state.scid, first.scid);
  assert.match(state.did, /:edge1\.example\.org:people:m1$/);
  assert.deepEqual(methodsAt(state, Date.parse('2026-11-03T00:00:00Z')), []);
  const settled = await buildUpdateEntry(state, { parameters: {}, versionTime: '2026-11-04T00:00:00Z', document: documentFor(key.multikey) }, key.signer);
  const after = ok(verifyWebvhLog(`${genesis.line}\n${moved.line}\n${settled.line}\n`, { now: NOW, cached: state }));
  assert.equal(methodsAt(after, Date.parse('2026-11-05T00:00:00Z'))[0]?.controller, after.did);
});

test('witnesses: an entry needs proofs from the threshold of distinct witnesses; one witness proof below a threshold of two is refused', async () => {
  const controller = newKey();
  const hubA = newKey();
  const hubB = newKey();
  const witness: WitnessConfig = { threshold: 2, witnesses: [hubA.did, hubB.did] };
  const genesis = await buildGenesisEntry({ domain: 'hq.example.org', path: ['people', 'w1'], updateKeys: [controller.multikey], portable: true, witness, versionTime: '2026-11-01T00:00:00Z', document: documentFor(controller.multikey) }, controller.signer);
  const versionId = (genesis.entry.versionId as string);
  const both = JSON.stringify([{ versionId, proof: [...(await buildWitnessProof(versionId, hubA.signer, '2026-11-01T00:00:01Z')).proof, ...(await buildWitnessProof(versionId, hubB.signer, '2026-11-01T00:00:01Z')).proof] }]);
  const one = JSON.stringify([await buildWitnessProof(versionId, hubA.signer, '2026-11-01T00:00:01Z')]);
  const twiceTheSame = JSON.stringify([{ versionId, proof: [...JSON.parse(one)[0].proof, ...JSON.parse(one)[0].proof] }]);
  const stranger = JSON.stringify([await buildWitnessProof(versionId, newKey().signer, '2026-11-01T00:00:01Z'), await buildWitnessProof(versionId, hubA.signer, '2026-11-01T00:00:01Z')]);
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW, witnessFile: both })), 'ok');
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW, witnessFile: one })), 'witness-threshold');
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW, witnessFile: twiceTheSame })), 'witness-threshold', 'one witness counts once');
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW, witnessFile: stranger })), 'witness-threshold', 'a proof by a key not in the list is discarded');
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW })), 'witness-threshold', 'no witness file');
});

test('limits and clocks: a log above the size cap is refused before parsing; an entry ahead of the clock is "not yet", not invalid', async () => {
  assert.equal(reason(verifyWebvhLog('x'.repeat(MAX_LOG_BYTES + 1), { now: NOW })), 'too-large');
  const key = newKey();
  const genesis = await buildGenesisEntry({ domain: 'hq.example.org', path: ['people', 'late'], updateKeys: [key.multikey], portable: true, versionTime: '2026-11-24T12:10:00Z', document: documentFor(key.multikey) }, key.signer);
  const early = verifyWebvhLog(genesis.line, { now: NOW });
  assert.equal(reason(early), 'version-time-future');
  if (!early.ok) assert.match(early.message, /not accepted yet/);
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW + 6 * 60 * 1000 })), 'ok');
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW, did: 'did:webvh:QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ:example.org' })), 'version-time-future');
  assert.equal(reason(verifyWebvhLog(genesis.line, { now: NOW + 6 * 60 * 1000, did: 'did:webvh:QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ:example.org' })), 'did-not-in-log');
  assert.equal(reason(verifyWebvhLog(`${genesis.line}\n\n${genesis.line}`, { now: NOW + 6 * 60 * 1000 })), 'bad-log');
  for (const sentence of Object.values(WEBVH_FAILURES)) assert.doesNotMatch(sentence, /did:[a-z]+:[A-Za-z0-9]|z6Mk/, 'no sentence quotes a DID or a key');
});

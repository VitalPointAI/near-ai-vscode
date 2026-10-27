import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { keccak256, recoverPersonalSignAddress, verifyTdxQuote } from '../services/attestation';
import { NearAiClient, type UsageMetadata } from '../services/nearAiClient';

// Vectors produced with ethers 5.7.2, the library NEAR's reference verifier uses.
const SIGNER = '0x1563915e194d8cfba1943570603f7606a3115508';
const REQUEST = '{"model":"z-ai/glm-5.3","messages":[{"role":"user","content":"hi"}],"stream":true,"stream_options":{"include_usage":true}}';
const RESPONSE = 'data: {"id":"chatcmpl-abc123","choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"id":"chatcmpl-abc123","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
const SIGNED_TEXT = 'a3a857ed80fa1ba58bdb26a07333623b08b42245562e36dd8004d84f0c4fa0d8:7c179c988290cfb148188195d6100f7e17f8d1dca2f49cb4468bd78edfcaba1d';
const SIGNATURE = '0x3a770bba95a77d397d25523360f73900399737145bc30dfa0bd3b9c8aff76054704daac9963e60950096840b0af9d6a3c12496838807b7ab12c5efcdf31b4e0f1c';

test('keccak-256 and personal_sign recovery match ethers', () => {
  assert.equal(keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(Buffer.from('abc')).toString('hex'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256(Buffer.from('a'.repeat(200))).toString('hex'), '96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d', 'input longer than one block');
  assert.equal(recoverPersonalSignAddress('abc123:def456', '0x8cd4f5dae737e0e7fa6fead93b832e7233b76175f2f6d6859b8108d37d51d4d46aa5f32530a2cacec071ed728f6eafd7756bb45e012ad2e1fe22445b77d89a591b'), '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a');
  assert.equal(recoverPersonalSignAddress(SIGNED_TEXT, SIGNATURE), SIGNER);
  assert.notEqual(recoverPersonalSignAddress(`${SIGNED_TEXT}0`, SIGNATURE), SIGNER, 'a changed message recovers a different key');
});

const FIXTURES = path.resolve(__dirname, '../../test/fixtures/tdx');
const TEST_CHAIN = readFileSync(path.join(FIXTURES, 'test-chain.pem'), 'utf8');
const TEST_ROOT = new X509Certificate(TEST_CHAIN.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!.at(-1)!).fingerprint256;
const TEST_PCK_KEY = createPrivateKey(readFileSync(path.join(FIXTURES, 'test-pck-key.pem')));

/** A v4 TDX quote with the given report_data, signed the way Intel hardware signs one, but chained to the test CA. */
function testQuote(reportData: Buffer, options: { chain?: string } = {}): string {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const attestationKey = Buffer.concat([Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const header = Buffer.alloc(48); header.writeUInt16LE(4, 0); header.writeUInt16LE(2, 2); header.writeUInt32LE(0x81, 4);
  const body = Buffer.alloc(584); reportData.copy(body, 520);
  const signed = Buffer.concat([header, body]);
  const qeAuth = Buffer.alloc(32, 9);
  const qeReport = Buffer.alloc(384); createHash('sha256').update(attestationKey).update(qeAuth).digest().copy(qeReport, 320);
  const qeSignature = sign('sha256', qeReport, { key: TEST_PCK_KEY, dsaEncoding: 'ieee-p1363' });
  const chain = Buffer.from(options.chain ?? TEST_CHAIN);
  const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
  const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const certBody = Buffer.concat([qeReport, qeSignature, u16(qeAuth.length), qeAuth, u16(5), u32(chain.length), chain]);
  const auth = Buffer.concat([sign('sha256', signed, { key: privateKey, dsaEncoding: 'ieee-p1363' }), attestationKey, u16(6), u32(certBody.length), certBody]);
  return Buffer.concat([signed, u32(auth.length), auth]).toString('hex');
}

test('a real Intel TDX quote verifies against Intel\'s root CA, and any change to it is caught', () => {
  const quote = readFileSync(path.join(FIXTURES, 'intel-sample-quote.bin'));
  const now = new Date('2026-10-26T00:00:00Z');
  const parsed = verifyTdxQuote(quote.toString('hex'), { now });
  assert.equal(parsed.reportData.toString('hex').slice(0, 32), '9a9d48e7f6799642d3d1b34e1e5e1742', 'matches the reference parser');
  assert.equal(parsed.mrTd.toString('hex').slice(0, 32), '91eb2b44d141d4ece09f0c75c2c53d24');
  for (const offset of [100, 600, 700]) {
    const tampered = Buffer.from(quote); tampered[offset] ^= 1;
    assert.throws(() => verifyTdxQuote(tampered.toString('hex'), { now }), /invalid|vouch/, `byte ${offset}`);
  }
});

test('a quote chained to any CA other than the pinned root is rejected', () => {
  const quote = testQuote(Buffer.alloc(64, 1));
  assert.throws(() => verifyTdxQuote(quote), /does not end at Intel's root CA/);
  assert.ok(verifyTdxQuote(quote, { trustedRoot: TEST_ROOT }).reportData.equals(Buffer.alloc(64, 1)));
  const [pck, , root] = TEST_CHAIN.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
  assert.throws(() => verifyTdxQuote(testQuote(Buffer.alloc(64), { chain: `${pck}\n${root}` }), { trustedRoot: TEST_ROOT }), /chain is broken/, 'a missing intermediate breaks the chain');
  assert.throws(() => verifyTdxQuote(quote.replace(/^0400/, '0300')), /unsupported quote version/);
});

const TRUST = { trustedRoot: TEST_ROOT };

function nearFake(options: { quoteNonce?: (nonce: string) => string; signer?: string; response?: string; forgedQuote?: boolean; placement?: 'model' | 'gateway' | 'missing' } = {}) {
  const requests: string[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url));
    requests.push(`${init?.method ?? 'GET'} ${target.pathname}${target.search}`);
    if (target.pathname.endsWith('/chat/completions')) {
      assert.equal(init?.body, REQUEST, 'the hashed request is the exact body sent');
      return new Response(options.response ?? RESPONSE);
    }
    if (target.pathname === '/v1/signature/chatcmpl-abc123') return Response.json({ text: SIGNED_TEXT, signature: SIGNATURE, signing_address: options.signer ?? SIGNER, signing_algo: 'ecdsa' });
    if (target.pathname === '/v1/attestation/report') {
      const nonce = target.searchParams.get('nonce')!;
      const reportData = Buffer.alloc(64);
      Buffer.from(SIGNER.slice(2), 'hex').copy(reportData, 0);
      Buffer.from(options.quoteNonce ? options.quoteNonce(nonce) : nonce, 'hex').copy(reportData, 32);
      const quote = options.forgedQuote ? (() => { const forged = Buffer.from(testQuote(reportData), 'hex'); forged[600] ^= 1; return forged.toString('hex'); })() : testQuote(reportData);
      const ours = { signing_address: SIGNER, signing_algo: 'ecdsa', intel_quote: quote, nvidia_payload: JSON.stringify({ nonce }) };
      const other = { signing_address: '0x' + '7'.repeat(40), signing_algo: 'ecdsa', intel_quote: testQuote(Buffer.alloc(64)) };
      if (options.placement === 'gateway') return Response.json({ gateway_attestation: { ...ours, nvidia_payload: undefined }, model_attestations: [other] });
      if (options.placement === 'missing') return Response.json({ gateway_attestation: other, model_attestations: [other] });
      return Response.json({ model_attestations: [ours] });
    }
    return new Response('{}', { status: 404 });
  };
  return { client: new NearAiClient({ baseUrl: 'https://cloud-api.near.ai/v1', apiKey: 'k', fetchFn: fetchFn as typeof fetch, maxRetries: 0 }), requests };
}

async function complete(client: NearAiClient): Promise<UsageMetadata> {
  let usage: UsageMetadata | undefined;
  for await (const event of client.streamCompletion('z-ai/glm-5.3', [{ role: 'user', content: 'hi' }], [])) if (event.type === 'done') usage = event.usage;
  return usage!;
}

test('a streamed completion keeps hashes of the exact request and raw response, and verifies end to end', async () => {
  const { client, requests } = nearFake();
  const usage = await complete(client);
  assert.deepEqual(usage.evidence, { chatId: 'chatcmpl-abc123', requestHash: SIGNED_TEXT.split(':')[0], responseHash: SIGNED_TEXT.split(':')[1] });
  const result = await client.verifyResponse('z-ai/glm-5.3', usage.evidence!, undefined, TRUST);
  assert.equal(result.outcome, 'signed', result.summary);
  assert.deepEqual(result.checks, { requestHash: true, responseHash: true, signature: true, genuineQuote: true, addressInQuote: true, nonceInQuote: true, gpuNonce: true });
  assert.match(result.summary, /Signed by the model's key 0x1563.*genuine Intel TDX quote, fresh for this check, binds that key, with matching GPU evidence/);
  assert.deepEqual(result.notChecked, ['platform TCB status and certificate revocation (Intel collateral)', 'which code the enclave runs (measurements)', 'NVIDIA GPU attestation verdict'], 'the result says what the editor did not check');
  const untrusted = await client.verifyResponse('z-ai/glm-5.3', usage.evidence!);
  assert.equal(untrusted.outcome, 'failed', 'a quote not rooted at Intel is never reported as signed');
  assert.match(untrusted.summary, /not genuine: the certificate chain does not end at Intel's root CA/);
  assert.match(requests[1], /^GET \/v1\/signature\/chatcmpl-abc123\?model=z-ai%2Fglm-5\.3&signing_algo=ecdsa$/);
  assert.match(requests[2], /^GET \/v1\/attestation\/report\?model=z-ai%2Fglm-5\.3&nonce=[0-9a-f]{64}&signing_algo=ecdsa&signing_address=0x1563/);
});

test('verification fails when the response differs, the signer differs, or the quote replays an old nonce', async () => {
  const tampered = nearFake({ response: RESPONSE.replace('Hello', 'Hellp') });
  const tamperedResult = await tampered.client.verifyResponse('z-ai/glm-5.3', (await complete(tampered.client)).evidence!, undefined, TRUST);
  assert.equal(tamperedResult.outcome, 'failed');
  assert.match(tamperedResult.summary, /response hash does not match/);

  const impostor = nearFake({ signer: '0x' + '9'.repeat(40) });
  const impostorResult = await impostor.client.verifyResponse('z-ai/glm-5.3', (await complete(impostor.client)).evidence!, undefined, TRUST);
  assert.equal(impostorResult.outcome, 'failed');
  assert.match(impostorResult.summary, /signature does not match/);

  const replay = nearFake({ quoteNonce: () => '00'.repeat(32) });
  const replayResult = await replay.client.verifyResponse('z-ai/glm-5.3', (await complete(replay.client)).evidence!, undefined, TRUST);
  assert.equal(replayResult.checks.genuineQuote, true);
  assert.equal(replayResult.outcome, 'failed');
  assert.match(replayResult.summary, /fresh nonce/);

  const forged = nearFake({ forgedQuote: true });
  const forgedResult = await forged.client.verifyResponse('z-ai/glm-5.3', (await complete(forged.client)).evidence!, undefined, TRUST);
  assert.equal(forgedResult.outcome, 'failed', 'a server that edits its quote to bind its own key is caught');
  assert.match(forgedResult.summary, /quote is not genuine: the quote signature is invalid/);
});

test('a provider without signatures reports unavailable instead of verified', async () => {
  const client = new NearAiClient({ baseUrl: 'https://cloud-api.near.ai/v1', apiKey: 'k', maxRetries: 0, fetchFn: (async () => new Response('{}', { status: 404 })) as typeof fetch });
  const result = await client.verifyResponse('m', { chatId: 'chatcmpl-x', requestHash: 'a', responseHash: 'b' });
  assert.equal(result.outcome, 'unavailable');
});

test('the chat offers Verify only for TEE-private cloud answers, and verifies through the client', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { AgentConversation } = await import('../services/agentSession');
  const { DEFAULT_RULES } = await import('../agent/permissions');
  const evidence = { chatId: 'chatcmpl-1', requestHash: 'a', responseHash: 'b' };
  const verified: string[] = [];
  const client = {
    async *streamCompletion() { yield { type: 'done' as const, message: { role: 'assistant' as const, content: 'ok' }, finishReason: 'stop', usage: { verificationStatus: 'unknown' as const, latencyMs: 1, evidence } }; },
    async actualCostsUsd() { return undefined; },
    async verifyResponse(model: string, given: typeof evidence) { verified.push(`${model}:${given.chatId}`); return { outcome: 'signed' as const, summary: 'Signed by 0xabc.', checks: {}, notChecked: [] }; }
  };
  const cases: Array<[string, boolean | undefined, boolean]> = [['Private · runs in NEAR TEE', undefined, true], ['Not private · forwarded', undefined, false], ['Local · runs on this machine', true, false]];
  for (const [privacy, local, offered] of cases) {
    const root = await mkdtemp(path.join(tmpdir(), 'near-ai-verify-'));
    const posted: Array<{ type: string; runId?: string }> = [];
    const conversation = new AgentConversation(root, (message) => posted.push(message as never), path.join(root, '.ckpt'));
    await conversation.send({ text: 'hi', client: client as never, model: 'z-ai/glm-5.3', privacy, local, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
    const offer = posted.find((message) => message.type === 'response-verifiable');
    assert.equal(Boolean(offer), offered, privacy);
    if (offer) assert.equal((await conversation.verifyRun(offer.runId!)).outcome, 'signed');
  }
  assert.deepEqual(verified, ['z-ai/glm-5.3:chatcmpl-1']);
});

test('a response signed by NEAR\'s gateway key verifies against the gateway attestation, and a miss says what the report held', async () => {
  const gateway = nearFake({ placement: 'gateway' });
  const result = await gateway.client.verifyResponse('z-ai/glm-5.3', (await complete(gateway.client)).evidence!, undefined, TRUST);
  assert.equal(result.outcome, 'signed', result.summary);
  assert.equal(result.signer, 'gateway');
  assert.match(result.summary, /^Signed by NEAR AI's gateway key 0x1563/);

  const missing = nearFake({ placement: 'missing' });
  const miss = await missing.client.verifyResponse('z-ai/glm-5.3', (await complete(missing.client)).evidence!, undefined, TRUST);
  assert.equal(miss.outcome, 'failed');
  assert.match(miss.summary, /report fields: gateway_attestation, model_attestations; keys attested: model 0x7{40}, gateway 0x7{40}/);
});

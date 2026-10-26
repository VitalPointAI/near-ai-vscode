import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ExternalWalletAuthorizationBridge, UnavailableWalletAuthorization } from '../services/walletAuthorization';

test('external wallet callback is state-bound, expires, and rejects replay without exposing signing material', async () => {
  let state = '';
  let signCalls = 0;
  const bridge = new ExternalWalletAuthorizationBridge({
    async authorize(request) { state = request.state; return { state: request.state, accountId: 'alice.test', networkId: 'verified-test-network', authorizedAt: '2026-10-25T12:00:00.000Z', expiresAt: '2026-10-25T12:30:00.000Z' }; },
    async disconnect() {},
    async signAndSend({ preview }) { signCalls += 1; return { status: 'submitted', accountId: preview.signer, networkId: preview.networkId, validatorAccount: preview.validatorAccount, operation: preview.operation, amountYocto: preview.amountYocto, timestamp: '2026-10-25T12:01:00.000Z' }; }
  }, () => Date.parse('2026-10-25T12:00:00.000Z'));
  const session = await bridge.connect();
  assert.equal(session.accountId, 'alice.test');
  assert.throws(() => bridge.completeAuthorization({ state, accountId: 'alice.test', networkId: 'verified-test-network', authorizedAt: '2026-10-25T12:00:00.000Z', expiresAt: '2026-10-25T12:30:00.000Z' }), /expired|unknown/i);
  assert.equal(signCalls, 0);
});

test('default wallet bridge has no local credential-file operation and fails closed', async () => {
  const source = await readFile('src/services/walletAuthorization.ts', 'utf8');
  assert.doesNotMatch(source, /from ['"]node:fs|readFile|writeFile|privateKey|seedPhrase|accessKey/i);
  const wallet = new UnavailableWalletAuthorization();
  await assert.rejects(wallet.connect(), /unavailable/i);
});

test('wallet bridge rejects forged preview payloads before the external adapter is called', async () => {
  let signCalls = 0;
  const bridge = new ExternalWalletAuthorizationBridge({
    async authorize() { throw new Error('not used'); },
    async disconnect() {},
    async signAndSend() { signCalls += 1; throw new Error('must not be called'); }
  });
  await assert.rejects(bridge.signAndSend({ version: 1, previewId: 'stake-preview-aaaaaaaaaaaaaaaa', fingerprint: 'b'.repeat(64), operation: 'stake', signer: 'alice.test', receiver: 'verified.pool.test', method: 'verified_stake', serializedArguments: '{"apiKey":"secret"}', amountYocto: '1', gasYocto: '1', attachedDepositYocto: '0', expectedFeeYocto: '1', networkId: 'verified-test-network', validatorAccount: 'verified.pool.test', configurationDigest: 'a'.repeat(64), expiresAt: '2026-10-25T12:30:00.000Z', approvalPreviewId: 'approval-1', approvalState: 'approved' }, { version: 1, accountId: 'alice.test', networkId: 'verified-test-network', authorizedAt: '2026-10-25T12:00:00.000Z', expiresAt: '2026-10-25T12:30:00.000Z' }), /invalid/i);
  assert.equal(signCalls, 0);
});

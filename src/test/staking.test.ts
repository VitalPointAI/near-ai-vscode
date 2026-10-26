import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { VerifiedStakingConfig, WalletSession, WalletTransactionOutcome } from '../domain/staking';
import { StakingDeniedError, StakingService } from '../services/stakingService';
import type { WalletAuthorizationPort } from '../services/walletAuthorization';

const nowStart = Date.parse('2026-10-25T12:00:00.000Z');
const config = (): VerifiedStakingConfig => ({
  version: 1,
  networkId: 'verified-test-network',
  rpcEndpoint: 'https://rpc.verified.test',
  validatorAccount: 'verified.pool.test',
  entitlementEndpoint: 'https://entitlement.verified.test/status',
  configurationDigest: 'a'.repeat(64),
  source: 'verified-injected',
  expiresAt: '2026-10-25T13:00:00.000Z',
  operations: {
    stake: { method: 'verified_stake', gasYocto: '1000000000000', attachedDepositYocto: '1', expectedFeeYocto: '1', buildArguments: ({ signerId, amountYocto }) => ({ account_id: signerId, amount: amountYocto }) },
    unstake: { method: 'verified_unstake', gasYocto: '1000000000000', attachedDepositYocto: '0', expectedFeeYocto: '1', buildArguments: ({ signerId, amountYocto }) => ({ account_id: signerId, amount: amountYocto }) },
    withdraw: { method: 'verified_withdraw', gasYocto: '1000000000000', attachedDepositYocto: '0', expectedFeeYocto: '1', buildArguments: ({ signerId }) => ({ account_id: signerId }) }
  }
});

function session(): WalletSession { return { version: 1, accountId: 'alice.test', networkId: 'verified-test-network', authorizedAt: '2026-10-25T12:00:00.000Z', expiresAt: '2026-10-25T12:30:00.000Z' }; }
function wallet(calls: { connect: number; sign: number }): WalletAuthorizationPort {
  return { async connect() { calls.connect += 1; return session(); }, async disconnect() {}, async signAndSend(preview) { calls.sign += 1; return { status: 'submitted', accountId: preview.signer, networkId: preview.networkId, validatorAccount: preview.validatorAccount, operation: preview.operation, amountYocto: preview.amountYocto, transactionId: 'tx-1', timestamp: '2026-10-25T12:01:00.000Z', outcome: 'submitted' }; } };
}
function reads() {
  return {
    async readNativeBalance() { return { accountId: 'alice.test', networkId: 'verified-test-network', liquidYocto: '100' }; },
    async readPoolBalance() { return { accountId: 'alice.test', networkId: 'verified-test-network', validatorAccount: 'verified.pool.test', stakedYocto: '20', unstakedYocto: '3' }; }
  };
}
function entitlement() { return { async read() { return { accountId: 'alice.test', networkId: 'verified-test-network', validatorAccount: 'verified.pool.test', source: 'verified entitlement read' }; } }; }

test('missing verified configuration is explicit unavailable and cannot authorize or submit a wallet transaction', async () => {
  const calls = { connect: 0, sign: 0 };
  const service = new StakingService({ wallet: wallet(calls), rpc: reads(), entitlement: entitlement() });
  const status = service.getStatus();
  assert.equal(status.freshness, 'unavailable');
  assert.equal(status.writesEnabled, false);
  assert.match(status.message, /unavailable|disabled/i);
  await assert.rejects(service.connectWallet(), /disabled|unavailable/i);
  await assert.rejects(service.createPreview('stake', '1'), /disabled|unavailable/i);
  assert.deepEqual(calls, { connect: 0, sign: 0 });
});

test('verified read-only status rejects wrong identity and preserves stale last-known values without fabricating credit', async () => {
  let time = nowStart;
  const calls = { connect: 0, sign: 0 };
  const service = new StakingService({ config: config(), wallet: wallet(calls), rpc: reads(), entitlement: entitlement(), now: () => time, freshnessTtlMs: 1000 });
  await service.connectWallet();
  const fresh = await service.refreshStatus();
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(fresh.balances?.liquidYocto, '100');
  assert.equal(fresh.credit?.balance, undefined);
  time += 2000;
  assert.equal(service.getStatus().freshness, 'stale');
  assert.equal(service.getStatus().writesEnabled, false);

  const wrongNetwork = new StakingService({ config: config(), wallet: wallet({ connect: 0, sign: 0 }), rpc: { ...reads(), async readNativeBalance() { return { accountId: 'alice.test', networkId: 'wrong-network', liquidYocto: '999999' }; } }, entitlement: entitlement(), now: () => nowStart });
  await wrongNetwork.connectWallet();
  const unavailable = await wrongNetwork.refreshStatus();
  assert.equal(unavailable.freshness, 'unavailable');
  assert.equal(unavailable.balances, undefined);
  assert.doesNotMatch(JSON.stringify(unavailable), /999999/);
});

test('exact preview requires fresh approval, explicit confirmation, and one immutable wallet call', async () => {
  const calls = { connect: 0, sign: 0 };
  let approvalAllowed = false;
  const service = new StakingService({ config: config(), wallet: wallet(calls), rpc: reads(), entitlement: entitlement(), now: () => nowStart, approval: { async preview() { return { previewId: 'approval-1' }; }, async dispatch() { return { allowed: approvalAllowed, reason: 'Approval missing.' }; } } });
  await service.connectWallet();
  const preview = await service.createPreview('stake', '42');
  assert.equal(preview.signer, 'alice.test');
  assert.equal(preview.receiver, 'verified.pool.test');
  assert.equal(preview.method, 'verified_stake');
  assert.equal(preview.amountYocto, '42');
  assert.equal(preview.confirmationRequired, true);
  assert.equal(JSON.stringify(preview).includes('api-key'), false);
  await assert.rejects(service.confirmPreview(preview.previewId, { explicit: true, fingerprint: '0'.repeat(64) }), StakingDeniedError);
  await assert.rejects(service.confirmPreview(preview.previewId, { explicit: true, fingerprint: preview.fingerprint }), /Approval missing/);
  assert.equal(calls.sign, 0);
  approvalAllowed = true;
  const outcome = await service.confirmPreview(preview.previewId, { explicit: true, fingerprint: preview.fingerprint });
  assert.equal(outcome.status, 'submitted');
  assert.equal(calls.sign, 1);
});

test('wallet payload, status, and source contain no local credential path, key, seed, profile, prompt, or context material', async () => {
  const [serviceSource, walletSource] = await Promise.all([readFile('src/services/stakingService.ts', 'utf8'), readFile('src/services/walletAuthorization.ts', 'utf8')]);
  assert.doesNotMatch(serviceSource, /from ['"]node:fs|readFile|writeFile/);
  assert.doesNotMatch(walletSource, /from ['"]node:fs|readFile|writeFile/);
  const service = StakingService.unavailable();
  const serialized = JSON.stringify(service.getStatus());
  assert.doesNotMatch(serialized, /api[_ -]?key|refresh[-_ ]?token|seed phrase|private key|project profile|private prompt|raw context/i);
});

test('history is bounded to safe wallet facts and forged transaction status is rejected', async () => {
  const calls = { connect: 0, sign: 0 };
  const service = new StakingService({ config: config(), wallet: wallet(calls), rpc: { ...reads(), async readTransactionStatus() { return { status: 'confirmed', accountId: 'mallory.test', networkId: 'verified-test-network', validatorAccount: 'verified.pool.test', operation: 'stake', amountYocto: '1', timestamp: '2026-10-25T12:00:00.000Z' } as WalletTransactionOutcome; } }, entitlement: entitlement(), now: () => nowStart, approval: { async preview() { return { previewId: 'approval-1' }; }, async dispatch() { return { allowed: true, reason: 'approved' }; } } });
  await service.connectWallet();
  const preview = await service.createPreview('stake', '1');
  await service.cancelPreview(preview.previewId);
  assert.equal((await service.history()).length, 1);
  await assert.rejects(service.transactionStatus('tx-1'), /mismatched|match/i);
  assert.doesNotMatch(JSON.stringify(await service.history()), /api[_ -]?key|refresh[-_ ]?token|seed|private|prompt|context|profile/i);
});

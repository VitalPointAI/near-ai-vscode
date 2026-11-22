// Generates the public signed-parity fixture from the extension's compiled signer. It never writes private key material.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { signPayload } = require('../../../../dist/domain/team/signedPayload.js');
const seed = createHash('sha256').update('compliance-signed-parity').digest();
const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const signer = {
  publicKey: Buffer.from(raw).toString('base64url'),
  fingerprint: `dev-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`,
  sign: (bytes) => edSign(null, bytes, privateKey).toString('base64url')
};
const envelope = signPayload(signer, 'policy-authorization', { kind: 'compliance-signed-parity', note: 'This fixture proves the verifier reads extension envelopes.' }, { now: () => new Date('2026-11-21T12:00:00.000Z') });
process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);

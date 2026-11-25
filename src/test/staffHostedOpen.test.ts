// A shared project opened in a hosted session (Phase 33 plan 24; D-60, D-61). The person key (your organization's key store) is the device, the opened
// X25519 key opens the grants, and the session key signs ordinary writes and the store's own marks. Nothing makes or reads a device key: the hosted
// session's secret store stays without any private key. A later session with a new session key opens the same folder and its earlier record.
// Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nextClientId } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { writerIdOf } from '../domain/replica/entry';
import { sessionCertifyData } from '../domain/replica/sessionKeys';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import type { AsyncPayloadSigner, PayloadSigner } from '../domain/team/signedPayload';
import { appendProductEntry } from '../staff/replica/labelCells';
import { loadOrCreateEncryptionKey, loadOrCreateKemKeys } from '../staff/replica/keyring';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import type { ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { identityDir } from '../team/identity';
import { MemorySecrets, hostOf, leadWith } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';
import { fixedSigner } from './helpers/replicaWorld';

const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
// In a hosted session the mark's trust is the person's own key store path; any session key may sign it.
const SESSION_KEYS: KeyStatusLookup = () => ({ state: 'active' });

function asyncOf(signer: PayloadSigner): AsyncPayloadSigner & { calls: number } {
  const wrapped = {
    calls: 0,
    fingerprint: signer.fingerprint,
    publicKey: signer.publicKey,
    sign: async (bytes: Buffer): Promise<string> => { wrapped.calls += 1; return signer.sign(bytes); }
  };
  return wrapped;
}

interface Hosted { deps: ReplicaProjectDeps; secrets: MemorySecrets; session: PayloadSigner; person: AsyncPayloadSigner & { calls: number } }

/** The lead's device certifies a session key; the hosted deps use a fresh secret store, the lead's key as the person key and its X25519 key, opened. */
async function hostedFor(lead: Seat, label: string): Promise<Hosted> {
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.writer)?.find((record) => record.slot !== undefined)?.slot as number;
  const session = fixedSigner(label);
  const notAfter = new Date(lead.at.clock.now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const data = sessionCertifyData({ project: lead.p.projectId, member: lead.member, device: lead.writer, sessionKey: session.publicKey, slot, notAfter }, (bytes) => session.signer.sign(bytes));
  const certified = await lead.p.appendOwn('session.certify', data);
  assert.ok('ok' in certified, 'ok' in certified ? undefined : certified.message);
  const encryption = await loadOrCreateEncryptionKey(lead.at.secrets, { identityDir: identityDir(lead.at.global), identity: lead.p.signer });
  // The person's post-quantum keys, as the session's envelope holds them (33.2-04): new shared work starts post-quantum (33.2-06).
  const kem = await loadOrCreateKemKeys(lead.at.secrets, { identityDir: identityDir(lead.at.global) });
  const secrets = new MemorySecrets();
  const person = asyncOf(lead.p.signer);
  const deps: ReplicaProjectDeps = {
    ...lead.at.deps, secrets, keyStatus: () => Promise.resolve(SESSION_KEYS), sessionSigner: session.signer, personSigner: person,
    hosted: { personPublicKey: lead.p.signer.publicKey, encryption, kem: { publicKeys: kem.publicKeys, privateKeys: kem.privateKeys } }
  };
  return { deps, secrets, session: session.signer, person };
}

async function opened(deps: ReplicaProjectDeps, root: string): Promise<ReplicaProject> {
  const value = await ReplicaProject.open(root, deps);
  assert.ok(value instanceof ReplicaProject, `the hosted project opens (${isProjectRefused(value) ? value.message : String(value)})`);
  return value;
}

test('a hosted open: the person key is the device, the session key writes, and no private key enters the session\'s secret store', async () => {
  const lead = await leadWith({ roles: ['member', 'section_lead:j4'] });
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? undefined : created.message);
  const h = await hostedFor(lead, 'HOSTED-SESSION-1');
  const hosted = await opened(h.deps, lead.at.root);
  assert.equal(hosted.deviceWriter, lead.writer, 'the person key is this device');
  assert.equal(hosted.signerOf('doc.update'), h.session);
  assert.equal(hosted.signerOf('version.decide'), h.person);

  const { roster } = await hosted.state();
  const slot = roster.sessions.get(writerIdOf(h.session.publicKey))?.slot as number;
  const clientId = nextClientId(slot, new Set()) as number;
  const doc = createLocalDoc(clientId);
  const host = hostOf(hosted, lead.at);
  assert.ok((await appendProductEntry(host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } })).ok);
  const typed = await appendProductEntry(host, 'doc.update', { product: PRODUCT, update: Buffer.from(localInsert(doc, 0, 'Fuel for three days.')).toString('base64url') });
  assert.ok(typed.ok, typed.ok ? undefined : typed.message);
  const product = (await hosted.state()).fold.families.doc as Array<{ product: string; text: string; attribution: Array<{ member: string }> }>;
  const text = product.find((item) => item.product === PRODUCT);
  assert.equal(text?.text, 'Fuel for three days.');
  assert.ok(text?.attribution.every((span) => span.member === lead.member), 'the session key\'s typing is the person\'s');
  assert.equal(h.person.calls, 0, 'typing never asks the person key');
  // No device key, encryption key or key history was made in the session's own store.
  assert.ok([...h.secrets.values.keys()].every((name) => !name.startsWith('nearAi.identity.')), [...h.secrets.values.keys()].join(', '));
  await hosted.close();

  // The next session: a new session key opens the same folder, and the earlier session's record and entries still read.
  const next = await hostedFor(lead, 'HOSTED-SESSION-2');
  const again = await opened({ ...next.deps, secrets: h.secrets }, lead.at.root);
  const later = (await again.state()).fold.families.doc as Array<{ product: string; text: string }>;
  assert.equal(later.find((item) => item.product === PRODUCT)?.text, 'Fuel for three days.');
  await again.close();
});

test('hosted deps without a session key are refused before anything is read or made', async () => {
  const lead = await leadWith();
  const h = await hostedFor(lead, 'HOSTED-SESSION-3');
  const { sessionSigner: _unused, ...withoutSession } = h.deps;
  await assert.rejects(ReplicaProject.open(lead.at.root, withoutSession), /only with its session key/);
  assert.equal(h.secrets.values.size, 0);
});

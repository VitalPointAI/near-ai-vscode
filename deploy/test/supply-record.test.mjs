// The promotion record and its approvals (48.3-05; D-17, D-18, D-27, D-28): the record's content and checks, an approver proven by an OpenBao
// jwt login (against a fake OpenBao on 127.0.0.1), and cosign 3.1.4's real attestation output (spike S-A's fixture). The signature itself is
// cosign's and is not checked here.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PREDICATE_TYPE, buildStatement, checkRecord, parseCosignAttestations } from '../supply/lib/record.mjs';
import { approverFromLogin, reconcile, sufficient } from '../supply/lib/approvals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = new Date('2026-11-25T12:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ADA = '0a1b2c3d-0000-4000-8000-000000000001';
const BEN = '0a1b2c3d-0000-4000-8000-000000000002';

/** A fake OpenBao: jwt login for one role, then lookup-self with the entity and the mapped claims. */
async function fakeBao({ role = 'supply-approver', sub = ADA, authTime = Math.floor(NOW.getTime() / 1000) - 30, loginStatus = 200 } = {}) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, token: request.headers['x-vault-token'] ?? null, body: body ? JSON.parse(body) : null });
      const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
      if (request.method === 'POST' && request.url === '/v1/auth/jwt/login') {
        const parsed = JSON.parse(body);
        if (loginStatus !== 200 || parsed.role !== role || parsed.jwt !== 'device-grant-token') return send(loginStatus === 200 ? 400 : loginStatus, { errors: ['permission denied'] });
        return send(200, { auth: { client_token: 's.approver', entity_id: 'entity-ada', metadata: { role, sub, auth_time: String(authTime) } } });
      }
      if (request.method === 'GET' && request.url === '/v1/auth/token/lookup-self' && request.headers['x-vault-token'] === 's.approver') {
        return send(200, { data: { entity_id: 'entity-ada', meta: { role, sub, auth_time: String(authTime) }, policies: ['supply-approver'] } });
      }
      return send(403, { errors: ['permission denied'] });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { addr: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

const record = (overrides = {}) => buildStatement({
  subject: { name: 'registry.example/approved/left-pad', digest: DIGEST },
  origin: { host: 'registry.npmjs.org', country: 'US' },
  gates: [{ gate: 'age', result: 'pass', evidence: { publishedAt: '2026-11-10T00:00:00.000Z' } }],
  state: 'approved',
  approvals: [{ subject: ADA, entity: 'entity-ada', at: '2026-11-25T11:59:30.000Z' }],
  requester: 'intake',
  policySha256: 'b'.repeat(64),
  grypeDb: { built: '2026-11-25T03:00:00Z', schemaVersion: 'v6.1.4', checksum: `sha256:${'c'.repeat(64)}` },
  osvDb: { date: '2026-11-25' },
  recordedAt: '2026-11-25T11:59:45.000Z',
  ...overrides,
});

test('one approval end to end', async () => {
  const bao = await fakeBao();
  try {
    const approval = await approverFromLogin({ baoAddr: bao.addr, jwt: 'device-grant-token', role: 'supply-approver' });
    assert.deepEqual(approval, { subject: ADA, entity: 'entity-ada', at: new Date((Math.floor(NOW.getTime() / 1000) - 30) * 1000).toISOString() });
    assert.deepEqual(bao.calls.map((c) => `${c.method} ${c.url}`), ['POST /v1/auth/jwt/login', 'GET /v1/auth/token/lookup-self']);
    assert.equal(bao.calls[0].token, null, 'the login carries no token of ours');
    assert.equal(bao.calls[1].token, 's.approver');
    const statement = record({ approvals: [approval] });
    assert.equal(statement.predicateType, PREDICATE_TYPE);
    assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
    assert.deepEqual(statement.subject, [{ name: 'registry.example/approved/left-pad', digest: { sha256: 'a'.repeat(64) } }]);
    assert.equal(statement.predicate.format, 'sterling-supply-record/1');
    assert.deepEqual(Object.keys(statement.predicate), ['format', 'subject', 'origin', 'gates', 'state', 'approvals', 'requester', 'policySha256', 'databases', 'recordedAt']);
    const checked = checkRecord(statement, { digest: DIGEST, approvers: [ADA], approversNeeded: 1, now: NOW });
    assert.deepEqual(checked, { ok: true, problems: [] });
  } finally {
    await bao.close();
  }
});

test('an approver OpenBao does not confirm is refused', async () => {
  const bao = await fakeBao({ loginStatus: 403 });
  try {
    await assert.rejects(approverFromLogin({ baoAddr: bao.addr, jwt: 'device-grant-token', role: 'supply-approver' }), { message: 'OpenBao did not confirm this approver: 403' });
  } finally {
    await bao.close();
  }
  const noSub = await fakeBao({ sub: '' });
  try {
    await assert.rejects(approverFromLogin({ baoAddr: noSub.addr, jwt: 'device-grant-token', role: 'supply-approver' }), /did not return the approver's subject/);
  } finally {
    await noSub.close();
  }
});

test('real cosign output', () => {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, 'deploy/test/fixtures/supply/cosign-3.1.4-attestations.json'), 'utf8'));
  const text = `${fixture.attestations.map((a) => JSON.stringify(a)).join('\n')}\n`;
  const statements = parseCosignAttestations(text);
  assert.equal(statements.length, 4);
  assert.deepEqual(statements.map((s) => s.predicateType), [
    'https://cyclonedx.org/bom', 'https://cosign.sigstore.dev/attestation/vuln/v1', 'https://openvex.dev/ns', PREDICATE_TYPE,
  ]);
  for (const statement of statements) assert.equal(`sha256:${statement.subject[0].digest.sha256}`, fixture.digest);
  // The legacy tag form (a bare DSSE envelope per line) reads the same way.
  const bare = fixture.attestations.map((a) => JSON.stringify(a.dsseEnvelope)).join('\n');
  assert.equal(parseCosignAttestations(bare).length, 4);
  assert.throws(() => parseCosignAttestations('{"not":"an attestation"}\n'), /line 1 of the cosign output is not an attestation/);
});

test('wrong digest', () => {
  const result = checkRecord(record(), { digest: `sha256:${'d'.repeat(64)}`, approvers: [ADA], approversNeeded: 1, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [`This record is for sha256:${'a'.repeat(64)}, not for sha256:${'d'.repeat(64)}.`]);
});

test('not approved', () => {
  const result = checkRecord(record({ state: 'in-review' }), { digest: DIGEST, approvers: [ADA], approversNeeded: 1, now: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('The record says in-review, not approved.'), result.problems.join(' | '));
});

// Task 3: the remaining approval rules (D-03, D-18, D-28) and the reconciliation (D-27).
const CAL = '0a1b2c3d-0000-4000-8000-000000000003';
const approval = (subject, at = '2026-11-25T11:00:00.000Z') => ({ subject, entity: `entity-${subject.slice(-1)}`, at });

test('repeated subject', () => {
  const result = sufficient([approval(ADA), approval(ADA, '2026-11-25T11:30:00.000Z')], { approversNeeded: 2, approvers: [ADA, BEN] });
  assert.deepEqual([result.ok, result.missing], [false, 1]);
  assert.match(result.problems.join(' '), /1 more approval from a different listed approver is needed/);
  assert.equal(sufficient([approval(ADA), approval(BEN)], { approversNeeded: 2, approvers: [ADA, BEN] }).ok, true);
  const checked = checkRecord(record({ approvals: [approval(ADA), approval(ADA)] }), { digest: DIGEST, approvers: [ADA, BEN], approversNeeded: 2, now: NOW });
  assert.equal(checked.ok, false, 'checkRecord applies the same rule');
});

test('an approver your organization does not list does not count', () => {
  const result = sufficient([approval(ADA), approval(CAL)], { approversNeeded: 2, approvers: [ADA, BEN] });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes(`${CAL} is not one of your organization's listed approvers.`));
});

test('fast lane requester', () => {
  const fastLane = { reason: 'GHSA-xxxx-yyyy-zzzz', requestedBy: ADA };
  const own = sufficient([approval(ADA), approval(BEN)], { approversNeeded: 2, approvers: [ADA, BEN, CAL], fastLane });
  assert.deepEqual([own.ok, own.missing], [false, 1]);
  assert.ok(own.problems.includes(`${ADA} asked for the fast lane and cannot approve it.`));
  assert.equal(sufficient([approval(BEN), approval(CAL)], { approversNeeded: 2, approvers: [ADA, BEN, CAL], fastLane }).ok, true);
  // Outside the fast lane the requester is just another approver.
  assert.equal(sufficient([approval(ADA)], { approversNeeded: 1, approvers: [ADA], requester: ADA }).ok, true);
});

test('a VEX not_affected needs two approvers for a KEV match or a critical with a fix, one otherwise', () => {
  const vex = (finding, approvals) => sufficient(approvals, { kind: 'vex-not-affected', finding, approvers: [ADA, BEN] });
  assert.equal(vex({ id: 'CVE-2026-1', kev: true }, [approval(ADA)]).ok, false);
  assert.equal(vex({ id: 'CVE-2026-1', kev: true }, [approval(ADA), approval(BEN)]).ok, true);
  assert.equal(vex({ id: 'CVE-2026-2', severity: 'critical', fixAvailable: true }, [approval(ADA)]).missing, 1);
  assert.equal(vex({ id: 'CVE-2026-3', severity: 'critical', fixAvailable: false }, [approval(ADA)]).ok, true);
  assert.equal(vex({ id: 'CVE-2026-4', severity: 'high' }, [approval(ADA)]).ok, true);
  assert.equal(vex({ id: 'CVE-2026-4', severity: 'high' }, []).ok, false);
});

test('reconcile lists every site-key signature with no record of the same digest and key', () => {
  const D1 = `sha256:${'1'.repeat(64)}`;
  const D2 = `sha256:${'2'.repeat(64)}`;
  const signatures = [{ digest: D1, keyId: 'site', at: '2026-11-25T10:00:00Z' }, { digest: D2, keyId: 'site', at: '2026-11-25T10:05:00Z' }];
  assert.deepEqual(reconcile(signatures, [{ digest: D1, keyId: 'site' }, { digest: D2, keyId: 'site' }]), []);
  assert.deepEqual(reconcile(signatures, [{ digest: D1, keyId: 'site' }]), [signatures[1]]);
  assert.deepEqual(reconcile(signatures, [{ digest: D1, keyId: 'site' }, { digest: D2, keyId: 'other' }]), [signatures[1]], 'a record under another key does not match');
  assert.deepEqual(reconcile([], []), []);
});

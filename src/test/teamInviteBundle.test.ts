// The invite bundle format and the repo URL cleaner (Phase 61 plan 07, D-05, D-06). The bundle is pasted from chat or email, so the parser is
// tested with hostile text, and no failure message may repeat what was pasted. Secret-shaped inputs are built at run time, never as literals.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUNDLE_PREFIX, InviteBundleError, MAX_BUNDLE_BYTES, cleanRepoUrl, encodeInviteBundle, parseInviteBundle } from '../team/inviteBundle';
import type { InviteBundle } from '../team/inviteBundle';
import { newMemberId, newTeamId } from '../team/identity';
import { generateInviteCode, parseInviteCode } from '../team/inviteCode';
import { makeCanaries } from './helpers/teamCanary';

// 20 zero bytes shown as 32 Crockford characters. Not a secret: it is the all-zero value.
const ZERO_CODE = '0'.repeat(32);
const TEAM = `team-${'0123456789abcdef'.repeat(2)}`;
const MEMBER = 'mbr-0123456789abcdef';
const REF = 'refs/heads/near-ai/coordination';
const REPO = 'https://example.invalid/team.git';

function vector(): InviteBundle {
  return { v: 1, repo: REPO, team: TEAM, ref: REF, member: MEMBER, code: ZERO_CODE };
}

// The frozen v1 spelling of vector(): canonical JSON (sorted keys, no spaces) in base64url without padding. Written out here, not computed,
// so a change to the encoder cannot move it. Bundles already handed out must keep parsing (D-05).
const FROZEN = 'near-ai-invite-v1.eyJjb2RlIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJtZW1iZXIiOiJtYnItMDEyMzQ1Njc4OWFiY2RlZiIsInJlZiI6InJlZnMvaGVhZHMvbmVhci1haS9jb29yZGluYXRpb24iLCJyZXBvIjoiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQvdGVhbS5naXQiLCJ0ZWFtIjoidGVhbS0wMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsInYiOjF9';
const FROZEN_WITH_NEAR = 'near-ai-invite-v1.eyJjb2RlIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJtZW1iZXIiOiJtYnItMDEyMzQ1Njc4OWFiY2RlZiIsIm5lYXIiOnsib3JnYW5pemF0aW9uSWQiOiJvcmctMSIsIndvcmtzcGFjZUlkIjoid3MtMSJ9LCJyZWYiOiJyZWZzL2hlYWRzL25lYXItYWkvY29vcmRpbmF0aW9uIiwicmVwbyI6Imh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3RlYW0uZ2l0IiwidGVhbSI6InRlYW0tMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJ2IjoxfQ';

function textOf(fields: Record<string, unknown>): string {
  return `${BUNDLE_PREFIX}${Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url')}`;
}

function rawTextOf(json: string): string {
  return `${BUNDLE_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

function fields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, repo: REPO, team: TEAM, ref: REF, member: MEMBER, code: ZERO_CODE, ...overrides };
}

// The same bytes spelled a second way: the last character of a payload whose length is not a multiple of 3 carries unused bits, and changing
// only those bits decodes to identical JSON. Only the decode and encode round trip can tell the two spellings apart.
function nonCanonicalTail(): string {
  const base = JSON.stringify(fields());
  let json = base;
  while (Buffer.byteLength(json, 'utf8') % 3 !== 1) json += ' ';
  const payload = Buffer.from(json, 'utf8').toString('base64url');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(payload.slice(-1));
  const sibling = alphabet.charAt((last & ~0x0f) | ((last + 1) & 0x0f));
  const spelled = `${payload.slice(0, -1)}${sibling}`;
  assert.notEqual(spelled, payload);
  assert.equal(Buffer.from(spelled, 'base64url').toString('utf8'), json, 'the other spelling decodes to the same JSON');
  return `${BUNDLE_PREFIX}${spelled}`;
}

function refusal(text: string): InviteBundleError {
  try {
    parseInviteBundle(text);
  } catch (error) {
    assert.ok(error instanceof InviteBundleError, 'a refusal is an InviteBundleError');
    return error;
  }
  assert.fail('the bundle was accepted');
}

test('frozen v1 vector: the fixed bundle encodes to the exact string and parses back to the same object', () => {
  assert.deepEqual(parseInviteCode(ZERO_CODE), Buffer.alloc(20), 'the vector code is 20 zero bytes');
  assert.equal(encodeInviteBundle(vector()), FROZEN);
  assert.deepEqual(parseInviteBundle(FROZEN), vector());
  const withNear: InviteBundle = { ...vector(), near: { organizationId: 'org-1', workspaceId: 'ws-1' } };
  assert.equal(encodeInviteBundle(withNear), FROZEN_WITH_NEAR);
  assert.deepEqual(parseInviteBundle(FROZEN_WITH_NEAR), withNear);
  // A paste usually brings a trailing newline or spaces along.
  assert.deepEqual(parseInviteBundle(`  ${FROZEN}\n`), vector());
});

test('hostile bundles are refused: prefix, alphabet, padding, size, shape, version, ids, ref and code', () => {
  const canaries = makeCanaries();
  const valid = Buffer.from(JSON.stringify(fields()), 'utf8').toString('base64url');
  const cases: Array<[string, string]> = [
    ['no prefix', valid],
    ['wrong prefix', `near-ai-invite-v0.${valid}`],
    ['v2 prefix', `near-ai-invite-v2.${valid}`],
    ['upper-case prefix', `NEAR-AI-INVITE-V1.${valid}`],
    ['empty payload', BUNDLE_PREFIX],
    ['non-base64url characters', `${BUNDLE_PREFIX}${valid.slice(0, 20)}+/${valid.slice(22)}`],
    ['padding', `${BUNDLE_PREFIX}${valid}=`],
    ['spaces inside', `${BUNDLE_PREFIX}${valid.slice(0, 10)} ${valid.slice(10)}`],
    ['truncated payload', `${BUNDLE_PREFIX}${Buffer.from('{"v":1}', 'utf8').toString('base64url').slice(0, -1)}`],
    ['non-canonical tail (same bytes, different spelling)', nonCanonicalTail()],
    ['more than 4 KB', `${BUNDLE_PREFIX}${'A'.repeat(MAX_BUNDLE_BYTES)}`],
    ['JSON array', rawTextOf('[1,2,3]')],
    ['JSON string', rawTextOf('"text"')],
    ['JSON number', rawTextOf('7')],
    ['JSON null', rawTextOf('null')],
    ['not JSON', rawTextOf('not json at all')],
    ['invalid UTF-8', `${BUNDLE_PREFIX}${Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString('base64url')}`],
    ['v 2 inside a v1 prefix', textOf(fields({ v: 2 }))],
    ['v as text', textOf(fields({ v: '1' }))],
    ['no v', textOf(Object.fromEntries(Object.entries(fields()).filter(([key]) => key !== 'v')))],
    ['team id of the wrong shape', textOf(fields({ team: 'team-123' }))],
    ['member id of the wrong shape', textOf(fields({ member: 'member-1' }))],
    ['ref outside refs/heads and refs/near-ai', textOf(fields({ ref: 'refs/tags/near-ai/coordination' }))],
    ['ref that climbs out', textOf(fields({ ref: 'refs/heads/../secret' }))],
    ['code of 31 characters', textOf(fields({ code: ZERO_CODE.slice(1) }))],
    ['code of 33 characters', textOf(fields({ code: `${ZERO_CODE}0` }))],
    ['lower-case code', textOf(fields({ code: 'a'.repeat(32) }))],
    ['code with a letter outside the alphabet', textOf(fields({ code: `U${ZERO_CODE.slice(1)}` }))],
    ['code as a number', textOf(fields({ code: 7 }))],
    ['repo with userinfo', textOf(fields({ repo: `https://canaryuser:${canaries.urlPassword}@example.invalid/team.git` }))],
    ['repo with a query', textOf(fields({ repo: 'https://example.invalid/team.git?x=1' }))],
    ['repo that is a local path', textOf(fields({ repo: '/tmp/team.git' }))],
    ['repo missing', textOf(Object.fromEntries(Object.entries(fields()).filter(([key]) => key !== 'repo')))],
    ['near that is not an object', textOf(fields({ near: 'org-1' }))],
    ['near with a bad organization id', textOf(fields({ near: { organizationId: 'org 1', workspaceId: 'ws-1' } }))],
    ['near missing the workspace', textOf(fields({ near: { organizationId: 'org-1' } }))]
  ];
  for (const [label, text] of cases) {
    const error = refusal(text);
    assert.ok(error.message.length > 0, label);
  }
});

test('an unknown key is ignored, and a __proto__ key does not reach the result or the prototype chain', () => {
  const extra = parseInviteBundle(textOf(fields({ futureField: { nested: true }, another: 3 })));
  assert.deepEqual(extra, vector());
  assert.equal(Object.keys(extra).includes('futureField'), false);

  const base = JSON.stringify(fields());
  const polluted = parseInviteBundle(rawTextOf(`${base.slice(0, -1)},"__proto__":{"isAdmin":true,"repo":"https://evil.invalid/x.git"}}`));
  assert.deepEqual(polluted, vector());
  assert.equal(Object.getPrototypeOf(polluted), Object.prototype);
  assert.equal((polluted as unknown as Record<string, unknown>)['isAdmin'], undefined);
  assert.equal(({} as Record<string, unknown>)['isAdmin'], undefined, 'Object.prototype is untouched');

  // A __proto__ key on the nested near object changes nothing either.
  const nearJson = `${base.slice(0, -1)},"near":{"organizationId":"org-1","workspaceId":"ws-1","__proto__":{"isAdmin":true}}}`;
  const withNear = parseInviteBundle(rawTextOf(nearJson));
  assert.deepEqual(withNear.near, { organizationId: 'org-1', workspaceId: 'ws-1' });
  assert.equal((withNear.near as unknown as Record<string, unknown>)['isAdmin'], undefined);
});

test('no refusal message repeats the pasted text, the repo URL or the code', () => {
  const canaries = makeCanaries();
  const secretUrl = `https://canaryuser:${canaries.urlPassword}@example.invalid/team.git`;
  const code = 'ZYXWVTSRQPNMKJHGFEDCBA9876543210'.slice(0, 32);
  const hostile = [
    textOf(fields({ repo: secretUrl, code })),
    textOf(fields({ code, team: 'team-bad' })),
    textOf(fields({ code, member: `${canaries.apiKey}` })),
    rawTextOf(`{"code":"${code}","note":"${canaries.refreshToken}","v":`),
    `${BUNDLE_PREFIX}${canaries.apiKey}`,
    `near-ai-invite-v2.${canaries.apiKey}`,
    canaries.reportingToken,
    `${BUNDLE_PREFIX}${'A'.repeat(MAX_BUNDLE_BYTES)}${canaries.urlPassword}`
  ];
  const secrets = [secretUrl, canaries.urlPassword, canaries.apiKey, canaries.refreshToken, canaries.reportingToken, code, 'example.invalid', 'team-bad'];
  for (const text of hostile) {
    const error = refusal(text);
    const shown = `${error.message}\n${error.stack ?? ''}\n${String(error)}\n${JSON.stringify(error)}`;
    assert.equal(shown.includes(text), false, 'the pasted text');
    assert.equal(shown.includes(text.slice(BUNDLE_PREFIX.length)), false, 'the payload');
    for (const secret of secrets) assert.equal(shown.includes(secret), false, 'a secret-shaped value or the URL');
  }
});

test('size cap: a bundle just under 4 KB is accepted, one over is refused, and encode never emits what parse would refuse', () => {
  const path = (length: number): string => `https://example.invalid/${'a'.repeat(length)}.git`;
  const fits = (length: number): InviteBundle => ({ ...vector(), repo: path(length) });
  let longest = 0;
  for (let length = 2000; length < 4000; length += 1) {
    try {
      encodeInviteBundle(fits(length));
      longest = length;
    } catch (error) {
      assert.ok(error instanceof InviteBundleError);
      break;
    }
  }
  assert.ok(longest >= 2000 && longest < 3999, 'a limit was found');
  const text = encodeInviteBundle(fits(longest));
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_BUNDLE_BYTES);
  assert.ok(Buffer.byteLength(text, 'utf8') > MAX_BUNDLE_BYTES - 8, 'the largest bundle that fits is within a few bytes of the cap');
  assert.equal(parseInviteBundle(text).repo, path(longest));
  assert.throws(() => encodeInviteBundle(fits(longest + 5)), InviteBundleError);
  assert.throws(() => parseInviteBundle(`${text}AAAA`.padEnd(MAX_BUNDLE_BYTES + 10, 'A')), InviteBundleError);

  const canaries = makeCanaries();
  assert.throws(() => encodeInviteBundle({ ...vector(), repo: `https://canaryuser:${canaries.urlPassword}@example.invalid/team.git` }), InviteBundleError);
  assert.throws(() => encodeInviteBundle({ ...vector(), code: 'short' }), InviteBundleError);
});

test('cleanRepoUrl on http and https drops userinfo and refuses a query or fragment', () => {
  const canaries = makeCanaries();
  const ok = (input: string, expected: string): void => assert.deepEqual(cleanRepoUrl(input), { ok: true, url: expected });
  ok(`https://canaryuser:${canaries.urlPassword}@example.invalid/team.git`, REPO);
  ok(`https://${canaries.apiKey.replace('sk-', 'tok')}@example.invalid/team.git`, REPO);
  ok(REPO, REPO);
  ok('http://example.invalid/team.git', 'http://example.invalid/team.git');
  ok('https://example.invalid:8443/org/team.git', 'https://example.invalid:8443/org/team.git');
  ok('  https://example.invalid/team.git  ', REPO);
  for (const bad of ['https://example.invalid/team.git?token=abc', 'https://example.invalid/team.git#frag', 'https://example.invalid/team.git?', `https://u:${canaries.urlPassword}@example.invalid/t.git?x=1`]) {
    const result = cleanRepoUrl(bad);
    assert.equal(result.ok, false, bad.replace(canaries.urlPassword, 'x'));
    if (!result.ok) {
      assert.match(result.reason, /query or fragment/);
      assert.equal(result.reason.includes(canaries.urlPassword), false);
      assert.equal(result.reason.includes('example.invalid'), false);
    }
  }
  // A cleaned URL is a fixed point: cleaning it again changes nothing, which is what the parser relies on.
  const once = cleanRepoUrl(`https://canaryuser:${canaries.urlPassword}@Example.INVALID:443/team.git`);
  assert.equal(once.ok, true);
  if (once.ok) assert.deepEqual(cleanRepoUrl(once.url), once);
});

test('cleanRepoUrl on ssh and scp-style addresses keeps a plain user and refuses anything that holds a credential', () => {
  const canaries = makeCanaries();
  const ok = (input: string, expected: string): void => assert.deepEqual(cleanRepoUrl(input), { ok: true, url: expected });
  ok(`ssh://git:${canaries.urlPassword}@host.invalid/org/x.git`, 'ssh://git@host.invalid/org/x.git');
  ok('ssh://git@host.invalid:2222/org/x.git', 'ssh://git@host.invalid:2222/org/x.git');
  ok('ssh://host.invalid/org/x.git', 'ssh://host.invalid/org/x.git');
  ok('git@github.com:org/repo.git', 'git@github.com:org/repo.git');
  ok('github.com:org/repo.git', 'github.com:org/repo.git');
  const refused: string[] = [
    'ssh://Bad User@host.invalid/x.git',
    'ssh://BadUser@host.invalid/x.git',
    `user:${canaries.urlPassword}@host.invalid:org/repo.git`,
    'we!rd@host.invalid:org/repo.git',
    '-oProxyCommand@host.invalid:org/repo.git',
    `git@host.invalid:org/repo.git?token=${canaries.urlPassword}`,
    'ssh://host.invalid/x.git#frag',
    'ssh:///x.git'
  ];
  for (const bad of refused) {
    const result = cleanRepoUrl(bad);
    assert.equal(result.ok, false, 'a refused address');
    if (!result.ok) {
      assert.equal(result.reason.includes(canaries.urlPassword), false);
      assert.equal(result.reason.includes('host.invalid'), false);
    }
  }
});

test('cleanRepoUrl refuses local paths, file URLs, other schemes and empty text with a reason that never holds the input', () => {
  const locals = ['file:///tmp/team.git', 'FILE:///tmp/team.git', '/tmp/team.git', './team.git', '../team.git', '~/team.git', 'C:\\work\\team.git', 'C:/work/team.git', 'team.git'];
  for (const local of locals) {
    const result = cleanRepoUrl(local);
    assert.equal(result.ok, false, local);
    if (!result.ok) {
      assert.match(result.reason, /local path cannot be shared with a teammate/);
      assert.equal(result.reason.includes('/tmp/team.git'), false);
    }
  }
  for (const other of ['git://host.invalid/x.git', 'ftp://host.invalid/x.git', 'javascript://host.invalid/%0Aalert(1)']) {
    assert.equal(cleanRepoUrl(other).ok, false, other);
  }
  for (const empty of ['', '   ']) assert.equal(cleanRepoUrl(empty).ok, false);
  assert.equal(cleanRepoUrl('https://exam ple.invalid/x.git').ok, false, 'whitespace inside');
  assert.equal(cleanRepoUrl('https://example.invalid/x\n.git').ok, false, 'a control character');
});

test('cleanRepoUrl refuses an address that still matches a secret detector after cleaning', () => {
  const canaries = makeCanaries();
  for (const bad of [`https://example.invalid/${canaries.apiKey}/team.git`, `ssh://git@host.invalid/${canaries.refreshToken}.git`, `git@host.invalid:${canaries.reportingToken}/x.git`]) {
    const result = cleanRepoUrl(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /still looks like it holds a secret/);
      for (const secret of [canaries.apiKey, canaries.refreshToken, canaries.reportingToken]) assert.equal(result.reason.includes(secret), false);
    }
  }
});

// T-61-64: a repo URL from a bundle can reach VS Code's git.clone. Git reads `<transport>::<address>` as a remote helper (ext:: runs a
// command when protocol.ext.allow is set, fd:: uses a file descriptor, hg:: and others run installed helpers), and an ssh host that starts
// with a dash becomes an ssh option such as -oProxyCommand. None of these may go into an invite or come out of one.
test('T-61-64: cleanRepoUrl refuses git remote-helper addresses and ssh or scp hosts that start with a dash, and the parser refuses them in a bundle', () => {
  const hostile = [
    'ext::sh -c touch% /tmp/pwned', 'ext::sh', 'fd::3', 'fd::3,4', 'hg::https://example.invalid/repo', 'testgit::/tmp/x', 'git-remote-x::anything',
    'https::example.invalid/repo', 'EXT::sh', 'x.y+z::addr',
    'ssh://-oProxyCommand=touch%20pwned/x', 'ssh://git@-oProxyCommand=x/repo.git', 'ssh://-host.example.invalid/repo.git', 'https://-host.example.invalid/repo.git',
    '-oProxyCommand=x:repo', 'git@-host:repo.git'
  ];
  for (const url of hostile) {
    const cleaned = cleanRepoUrl(url);
    assert.equal(cleaned.ok, false, url);
    if (!cleaned.ok) assert.equal(cleaned.reason.includes(url), false, 'the reason never repeats the address');
  }
  // Plain addresses, including an ssh URL with an IPv6 host in brackets (which has "::" inside the brackets), still work.
  for (const url of ['https://example.invalid/org/repo.git', 'git@example.invalid:org/repo.git', 'ssh://git@example.invalid/org/repo.git', 'ssh://git@[::1]/org/repo.git']) {
    const cleaned = cleanRepoUrl(url);
    assert.equal(cleaned.ok, true, url);
  }
  // A bundle written by hand around a helper address is refused by the parser, which runs the same cleaning.
  const forged = `near-ai-invite-v1.${Buffer.from(JSON.stringify({ v: 1, repo: 'ext::sh', team: newTeamId(), ref: 'refs/heads/near-ai/coordination', member: newMemberId(), code: generateInviteCode().text }), 'utf8').toString('base64url')}`;
  assert.throws(() => parseInviteBundle(forged), InviteBundleError);
});

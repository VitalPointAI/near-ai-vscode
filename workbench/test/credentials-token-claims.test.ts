// Phase 71, plan 13, task 1 (D-18; research 4.1; T-71-51): tokens only authenticate. Credential code in the session backend reads sub, acr,
// auth_time and exp from the sign-in token and nothing else, so a token with groups, roles or profile attributes gives exactly the decisions of one
// without them: for issuing (the step-up guard before OpenBao's login), for key release and for the session's credential state. A static check
// refuses any read of another claim under workbench/extension/src/node/credentials/. Fictional people; keys made at run time. Flat file (H-71-01).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tokenClaimsOf, tokenFactsOf } from '../extension/src/node/credentials/token-facts.ts';
import { subjectOf } from '../extension/src/node/credentials/device-slots.ts';
import { openBaoIssuerLogin, type IssuerSessionSource } from '../extension/src/node/credentials/issuer-service.ts';
import { createCredentialCache, type CredentialEngine } from '../extension/src/node/credentials/credential-cache.ts';
import { loadStaffEngine } from '../extension/src/node/staff/staff-engine.ts';
import { makeTestSigner } from './helpers/test-jwt.ts';

const workbenchRoot = fileURLToPath(new URL('../..', import.meta.url));
const CREDENTIALS_DIR = path.join(workbenchRoot, 'extension', 'src', 'node', 'credentials');
const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const ALLOWED = ['sub', 'acr', 'auth_time', 'exp'] as const;

const signer = makeTestSigner();
const base = { sub: 'f1e2d3c4-0000-4000-8000-000000000001', acr: 'gold', auth_time: NOW / 1000 - 60, exp: NOW / 1000 + 3600 };
const minimal = signer.sign(base);
// Everything a Keycloak token might also carry, written to grant access if anything read it.
const rich = signer.sign({
  ...base, groups: ['/security-officers', '/top-secret'], realm_access: { roles: ['admin', 'credential-issuer'] }, resource_access: { workbench: { roles: ['officer'] } },
  nationality: 'CAN', serves: 'regular-force', organization: 'Example Organization', clearance: 'Top Secret', email: 'alex@example.org',
  preferred_username: 'alex', given_name: 'Alex', family_name: 'Example', scope: 'openid profile', azp: 'sterling-workbench',
});

test('the token facts of a token with extra claims equal those of one with only sub, acr, auth_time and exp, and hold nothing else', () => {
  const facts = tokenFactsOf(rich);
  assert.deepEqual(facts, tokenFactsOf(minimal));
  assert.deepEqual(Object.keys(facts ?? {}).sort(), ['acr', 'authTime', 'exp', 'sub']);
  assert.deepEqual(tokenClaimsOf(rich), tokenClaimsOf(minimal));
  assert.equal(subjectOf(rich), subjectOf(minimal));
  assert.equal(tokenFactsOf('not.a.token'), undefined);
});

test('issuing, key release and the session\'s credential state decide the same for both tokens', async () => {
  // Issuing: the backend's own step-up guard before OpenBao's login reads acr and auth_time only; OpenBao gets the token itself and decides.
  const decisions: unknown[] = [];
  for (const jwt of [minimal, rich]) {
    const facts = tokenFactsOf(jwt);
    assert.ok(facts !== undefined);
    const logins: unknown[] = [];
    const session: IssuerSessionSource = {
      forwardedToken: jwt, ...(facts.acr === undefined ? {} : { acr: facts.acr }), ...(facts.authTime === undefined ? {} : { authTime: facts.authTime }),
      client: { async request(_method, _path, options) { logins.push(options?.body); throw Object.assign(new Error('denied'), { kind: 'refused' }); } },
      config: { jwtMount: 'jwt', kvMount: 'kv', transitMount: 'transit', stepUpAcr: 'gold', stepUpMaxAgeSeconds: 300 },
    };
    const login = await openBaoIssuerLogin(() => session, 'status-list-site', 'sterling-issuer-stepup', () => NOW)();
    const stale = await openBaoIssuerLogin(() => session, 'status-list-site', 'sterling-issuer-stepup', () => NOW + 3600 * 1000)();

    // Key release and the credential state, from a cache whose session carries this token's facts (no rules here, so both release everything).
    const engine = loadStaffEngine<CredentialEngine>(workbenchRoot);
    const cache = createCredentialCache({
      engine: () => engine, rules: () => undefined, kv: { read: async () => undefined, list: async () => [] },
      session: () => ({ token: facts, entityId: '3a9e7c1b-5d2f-4e8a-9b6c-0d1e2f3a4b5c' }), holder: async () => undefined, hub: () => undefined, now: () => NOW,
    });
    await cache.start();
    const release = cache.keyRelease().check('cell', { scale: 'ca-classified', level: 'Top Secret', compartments: [], releasability: [], handling: [] });
    decisions.push({ login, stale, logins: logins.length, release, state: cache.state() });
  }
  assert.deepEqual(decisions[1], decisions[0]);
  assert.deepEqual((decisions[0] as { login: unknown }).login, 'not-officer', 'OpenBao decided, not a claim');
  assert.deepEqual((decisions[0] as { stale: unknown }).stale, 'step-up');
});

test('static: credential code reads no token claim but sub, acr, auth_time and exp, and decodes a token in one place only', () => {
  const files = readdirSync(CREDENTIALS_DIR).filter((name) => name.endsWith('.ts'));
  assert.ok(files.includes('token-facts.ts') && files.includes('credential-cache.ts'), 'the folder holds the credential code');
  const code = (name: string): string => readFileSync(path.join(CREDENTIALS_DIR, name), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join('\n');
  // Claim names of OIDC and Keycloak tokens that carry attributes. None may appear in code here (comments aside).
  const attributeClaims = /\b(realm_access|resource_access|groups|preferred_username|given_name|family_name|email|email_verified|upn|clearance_level|nationality_claim)\b/;
  for (const name of files) {
    const text = code(name);
    assert.doesNotMatch(text, attributeClaims, `${name} names a token attribute claim`);
    // Decoding a token's payload (base64url JSON of a dotted token) happens only in token-facts.ts.
    if (name !== 'token-facts.ts') {
      assert.doesNotMatch(text, /JSON\.parse\(\s*Buffer\.from\([^)]*base64url/, `${name} decodes a token payload itself`);
      assert.doesNotMatch(text, /\bauth_time\b/, `${name} reads auth_time from a token instead of TokenFacts`);
    }
    // The raw token goes only to OpenBao's login (as jwt) or to tokenFactsOf / subjectOf; nothing else reads it.
    for (const use of text.matchAll(/forwardedToken\b[^\n]*/g)) {
      assert.match(use[0], /^forwardedToken(: string;|\)|\s*\}|,)/, `${name}: the token is used only by name, passed on whole: ${use[0].slice(0, 80)}`);
    }
  }
  // In token-facts.ts the payload is destructured into exactly the four claims.
  const facts = code('token-facts.ts');
  const destructured = /const \{([^}]*)\} = payload as/.exec(facts);
  assert.ok(destructured !== null, 'token-facts.ts destructures the payload once');
  const names = destructured[1].split(',').map((part) => part.split(':')[0].trim()).filter((part) => part !== '').sort();
  assert.deepEqual(names, [...ALLOWED].sort());
  assert.equal((facts.match(/payload\./g) ?? []).length, 0, 'no other property of the payload is read');
});

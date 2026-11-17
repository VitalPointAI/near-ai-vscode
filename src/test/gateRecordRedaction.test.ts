// A decision record never keeps a credential a command carries in its arguments (PR #70 review carry-over). The record names a shell call by its command's
// first line, and SECURITY.md said secrets are removed from records while only known token shapes were: `curl -u user:pass` survived whole. Each class of
// credential argument is removed by where it sits, whatever its value looks like; what is not removed is named in SECURITY.md, and checked here as not
// removed, so the docs and the code cannot drift apart.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool } from '../agent/tools';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { redactCredentialArguments, redactSecrets } from '../domain/redaction';
import { testGateRuntime } from './helpers/gatedRuns';

/** A value no token pattern knows, so only the class rule can remove it. */
const SECRET = 'plain-Value-42';

function redacted(text: string): string {
  return redactSecrets(redactCredentialArguments(text));
}

function assertGone(command: string, keep: readonly string[] = []): string {
  const out = redactCredentialArguments(command);
  assert.ok(!out.includes(SECRET), `${command} -> ${out}`);
  assert.ok(out.includes('[REDACTED]'), `${command} -> ${out}`);
  for (const part of keep) assert.ok(out.includes(part), `${command} keeps ${part}: ${out}`);
  assert.equal(redactCredentialArguments(out), out, 'applying it again changes nothing');
  assert.equal(redacted(redacted(command)), redacted(command), 'with the token shapes too, applying it again changes nothing');
  return out;
}

// PR #74 review round 2: a numeric user and group (`docker run --user 1000:1000`) holds no password, so the command is kept whole; anything else with a
// colon after these options is still removed, including a numeric user with a non-numeric password and a number-only password after a name.
test('-u and --user keep a numeric user and group, and still drop every other value with a colon', () => {
  for (const command of ['docker run --user 1000:1000 node:20 npm test', 'docker run -u 0:0 alpine id', 'docker exec --user=1000:1000 app ls',
    'docker run --user "1000:1000" img', "podman run -u '33:33' img", 'docker run -u1000:1000 img']) {
    assert.equal(redactCredentialArguments(command), command, `${command}: a numeric user and group is kept`);
    assert.equal(redacted(command), command, `${command}: and no token rule touches it`);
  }
  assertGone(`curl -u 1000:${SECRET} https://api.example.test`, ['curl -u ']);
  assertGone('curl -u bob:123456 https://api.example.test'.replace('123456', `${SECRET}`));
  const numericPassword = redactCredentialArguments('curl -u bob:123456 https://api.example.test');
  assert.ok(!numericPassword.includes('123456'), `a number-only password after a name is removed: ${numericPassword}`);
  const userAndNumber = redactCredentialArguments('curl --user 1000:1000x https://api.example.test');
  assert.ok(!userAndNumber.includes('1000x'), `only digits on both sides are kept: ${userAndNumber}`);
});

test('the user part of a URL is removed, a password or a token alone', () => {
  assertGone(`git clone https://alice:${SECRET}@git.example.test/repo.git`, ['https://', '@git.example.test/repo.git']);
  assertGone(`git push https://${SECRET}@git.example.test/repo.git main`, ['@git.example.test']);
  assertGone(`psql postgres://app:${SECRET}@db.example.test:5432/app`, ['postgres://', '@db.example.test']);
  assert.equal(redactCredentialArguments('curl https://example.test/a?b=c@d'), 'curl https://example.test/a?b=c@d', 'an @ after the path is not a user part');
});

test('-u, --user, --proxy-user and -U drop a value that holds a colon, quoted, attached or after =', () => {
  assertGone(`curl -u bob:${SECRET} https://api.example.test`, ['curl -u ', 'https://api.example.test']);
  assertGone(`curl -ubob:${SECRET} https://api.example.test`);
  assertGone(`curl --user "bob:${SECRET}" https://api.example.test`, ['--user "']);
  assertGone(`curl --user='bob:${SECRET}' https://api.example.test`);
  assertGone(`curl --proxy-user bob:${SECRET} https://api.example.test`);
  assertGone(`curl -U bob:${SECRET} https://api.example.test`);
  for (const command of ['git push -u origin main', 'sort -u names.txt', 'ps -u root']) assert.equal(redactCredentialArguments(command), command, `${command}: no colon, no password`);
});

test('an option named for a password, passphrase, token, secret, API key or credential loses its value; one naming where a credential is kept does not', () => {
  assertGone(`mysql --password=${SECRET} app`, ['--password=']);
  assertGone(`gh api --token ${SECRET} /user`, ['/user']);
  assertGone(`tool --api-key "${SECRET}" run`, ['--api-key "', 'run']);
  assertGone(`tool --client-secret=${SECRET}`);
  assertGone(`keytool -list -storepass ${SECRET} -keystore app.jks`, ['-keystore app.jks']);
  assertGone(`tool --db-pass ${SECRET}`);
  assertGone(`http --auth ${SECRET} example.test`);
  assertGone(`tool --github-token=${SECRET}`);
  assertGone(`tool --passphrase '${SECRET}'`);
  for (const command of ['tool --token-file secrets/token.txt', 'docker login --password-stdin', 'tool --secret-name prod-db', 'npm run build --verbose', 'git commit -m done']) {
    assert.equal(redactCredentialArguments(command), command, command);
  }
});

test('a credential header loses its value: Authorization (any scheme), Proxy-Authorization, Cookie, Private-Token and X-...-Token or -Key', () => {
  assertGone(`curl -H "Authorization: Basic ${SECRET}" https://api.example.test`, ['Authorization: ', '" https://api.example.test']);
  assertGone(`curl -H 'Authorization: token ${SECRET}' https://api.example.test`);
  assertGone(`curl -H "Authorization: Bearer ${SECRET}" https://api.example.test`);
  assertGone(`curl -H "Proxy-Authorization: Basic ${SECRET}" https://api.example.test`);
  assertGone(`curl -H "Cookie: session=${SECRET}" https://api.example.test`);
  assertGone(`curl --header "PRIVATE-TOKEN: ${SECRET}" https://gitlab.example.test`);
  assertGone(`curl -H "X-Api-Key: ${SECRET}" https://api.example.test`);
  assertGone(`curl -H "X-Auth-Token: ${SECRET}" https://api.example.test`);
  assert.equal(redactCredentialArguments('curl -H "Accept: application/json" https://api.example.test'), 'curl -H "Accept: application/json" https://api.example.test');
});

test('an environment assignment or a query parameter named for a credential loses its value; a reference to another variable is kept', () => {
  assertGone(`GITHUB_TOKEN=${SECRET} gh pr list`, ['gh pr list']);
  assertGone(`export NPM_TOKEN="${SECRET}"`, ['export NPM_TOKEN="']);
  assertGone(`PGPASSWORD=${SECRET} psql app`);
  assertGone(`env AWS_SECRET_ACCESS_KEY=${SECRET} aws s3 ls`);
  assertGone(`docker run -e API_KEY=${SECRET} app`);
  assertGone(`docker run --env=DB_PASS=${SECRET} app`);
  assertGone(`set SERVICE_AUTH=${SECRET}`);
  assertGone(`curl "https://api.example.test/v1?api_key=${SECRET}&q=x"`, ['&q=x']);
  for (const command of ['GH_TOKEN=$GITHUB_TOKEN gh pr list', 'TOKEN=${CI_TOKEN} make', 'NODE_ENV=production npm start', 'MONKEY=1 run', 'curl https://example.test/?q=hello']) {
    assert.equal(redactCredentialArguments(command), command, command);
  }
});

test('what is not removed, as SECURITY.md says: a plain positional password, a password run by a script, and one built by command substitution', () => {
  for (const command of [`sshpass -p ${SECRET} ssh host`, `mysql -p${SECRET} app`, `htpasswd -b users alice ${SECRET}`, `./deploy.sh ${SECRET}`, 'curl -u "$(cat creds)" https://api.example.test']) {
    assert.equal(redactCredentialArguments(command), command, command);
  }
});

function shellRecord(command: string): DecisionRecord {
  return buildDecisionRecord({
    recordId: 'r', sequence: 0, time: 1_700_000_000_000, productVersion: '0.0.0-test', actor: { kind: 'agent', deviceFingerprint: 'd', sessionId: 's' },
    callId: 'c', capability: { verb: 'shell', cwd: 'workspace' }, resource: { name: command, type: 'command' }, outcome: 'asked', rule: 'settings.mode.other',
    reason: `Runs ${command}`, bundleHash: ''
  });
}

test('a record built for a command keeps none of its credential arguments, in its resource name or its reason', () => {
  const command = `curl -u bob:${SECRET} -H "Authorization: Basic ${SECRET}" https://alice:${SECRET}@api.example.test --token ${SECRET}`;
  const record = shellRecord(command);
  assert.ok(!JSON.stringify(record).includes(SECRET), JSON.stringify(record.resources));
  assert.equal(validateDecisionRecord(record).ok, true);
});

test('the record check refuses a record that still carries a credential argument, so no writer can skip the redaction', () => {
  const record = shellRecord('ls');
  const raw = { ...record, resources: [{ name: `curl -u bob:${SECRET} https://api.example.test`, type: 'command' }] };
  const checked = validateDecisionRecord(raw);
  assert.equal(checked.ok, false);
  assert.equal(checked.ok ? '' : checked.path, 'credential-argument');
});

test('through the gate: a Bash call\'s record names its command with the password removed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-redact-'));
  const runtime = testGateRuntime();
  const command = `curl -u bob:${SECRET} https://api.example.test/status`;
  await gateToolCall(runtime, {
    tool: bashTool, raw: { command }, root, callId: 'c1', command, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(),
    shell: { cwd: root }, buildAuto: async () => undefined
  });
  assert.equal(runtime.records.length, 1);
  const name = runtime.records[0]!.resources[0]!.name;
  assert.equal(name, 'curl -u [REDACTED] https://api.example.test/status');
});

// PR #74 review round 7: a credential right after a quote (`curl -d "password=..."`, `'token=...'`) or after `,` was kept. A quote, `&`, `?`, `;` and `,`
// all start a name=value now, and the closing quote stays where it was.
test('a credential assignment right after a quote, an ampersand, a comma or a semicolon is removed, and the quotes around it are kept', () => {
  const kept = (command: string, out: string): void => assert.equal(redactCredentialArguments(command), out, command);
  kept(`curl -d "password=${SECRET}" https://api.example.test`, 'curl -d "password=[REDACTED]" https://api.example.test');
  kept(`curl -d 'token=${SECRET}' https://api.example.test`, "curl -d 'token=[REDACTED]' https://api.example.test");
  kept(`curl -d "user=alice&password=${SECRET}" https://api.example.test`, 'curl -d "user=alice&password=[REDACTED]" https://api.example.test');
  kept(`tool --data "a=1,secret=${SECRET}"`, 'tool --data "a=1,secret=[REDACTED]"');
  kept(`tool --data "a=1;api_key=${SECRET};b=2"`, 'tool --data "a=1;api_key=[REDACTED];b=2"');
  for (const command of [`curl -d "password=${SECRET}" x`, `curl -d 'token=${SECRET}' x`, `tool --data "a=1,secret=${SECRET}"`]) assertGone(command);
  // Names that are not credentials stay, quoted or not.
  for (const command of ['curl -d "user=alice&page=2" https://api.example.test', "tool --data 'mode=fast,level=3'"]) assert.equal(redactCredentialArguments(command), command, command);
});

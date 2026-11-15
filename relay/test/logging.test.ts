import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crashFields } from '../src/main';
import { Logger } from '../src/log/logger';
import { isSensitiveKey, Redactor, SENSITIVE_KEYS, uniqueFieldName } from '../src/log/redact';

// Phase 68, plan 02 (RELAY-04, D-11, Pitfall 10): the redaction rules, the logger's line format, and a source guard that fails the suite if
// any other output path appears in relay/src.

const RELAY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

function keyed(key: Buffer = KEY_A): Redactor {
  const redactor = new Redactor();
  redactor.setPseudonymKey(key);
  return redactor;
}

function capture(redactor: Redactor, now: () => number = () => Date.UTC(2026, 10, 14, 12, 0, 0)): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new Logger(redactor, (line) => lines.push(line), now), lines };
}

test('a registered value inside a longer string becomes [secret:NAME]', () => {
  const redactor = new Redactor();
  redactor.register('teams-client-secret', 'supersecret-value-123');
  assert.equal(redactor.text('call failed for supersecret-value-123 at the gateway'), 'call failed for [secret:teams-client-secret] at the gateway');
  assert.equal(redactor.text('supersecret-value-123 and supersecret-value-123'), '[secret:teams-client-secret] and [secret:teams-client-secret]');
  assert.equal(redactor.fields({ detail: 'x supersecret-value-123 y' }).detail, 'x [secret:teams-client-secret] y');
});

test('registering a value shorter than 8 characters throws, and an 8-character value is accepted', () => {
  const redactor = new Redactor();
  assert.throws(() => redactor.register('short', '1234567'));
  assert.doesNotThrow(() => redactor.register('exact', '12345678'));
});

test('a secret that contains another registered secret is masked as a whole', () => {
  const redactor = new Redactor();
  redactor.register('inner', 'abcdefgh');
  redactor.register('outer', 'abcdefgh-and-more');
  assert.equal(redactor.text('value abcdefgh-and-more end'), 'value [secret:outer] end');
});

test('authorization, x-api-key, text and prompt keys are dropped and replaced by their length', () => {
  const output = new Redactor().fields({ authorization: 'Bearer abc.def', 'x-api-key': 'k-12345678', text: 'hello there', prompt: 'do the thing' });
  assert.deepEqual(output, { authorizationLength: 14, xapikeyLength: 10, textLength: 11, promptLength: 12 });
});

test('two fields whose output names collide are both kept, under a numbered name, instead of one overwriting the other', () => {
  const redactor = new Redactor();
  // Two sensitive keys that normalise alike.
  assert.deepEqual(redactor.fields({ Authorization: 'Bearer abc', authorization: 'Bearer abcdef', 'Proxy-Authorization': 'x' }), {
    authorizationLength: 10,
    'authorizationLength#2': 13,
    proxyauthorizationLength: 1,
  });
  // A sensitive key next to a plain field that already carries its derived name, in either order.
  assert.deepEqual(redactor.fields({ textLength: 3, text: 'hello' }), { textLength: 3, 'textLength#2': 5 });
  assert.deepEqual(redactor.fields({ text: 'hello', textLength: 3 }), { textLength: 5, 'textLength#2': 3 });
  // Plain keys that become one name once the registered secret values in them are masked.
  redactor.register('teams', 'value-one-1234');
  redactor.register('teams', 'value-two-5678');
  assert.deepEqual(redactor.fields({ 'k-value-one-1234': 'a', 'k-value-two-5678': 'b' }), { 'k-[secret:teams]': 'a', 'k-[secret:teams]#2': 'b' });
  // A third collision takes the next free number.
  assert.deepEqual(redactor.fields({ token: 'aa', TOKEN: 'bbb', Token: 'c' }), { tokenLength: 2, 'tokenLength#2': 3, 'tokenLength#3': 1 });
  // A numbered name that is already taken is skipped too.
  assert.equal(uniqueFieldName({ a: 1, 'a#2': 2 }, 'a'), 'a#3');
  assert.equal(uniqueFieldName({ b: 1 }, 'a'), 'a');
});

test('every sensitive key is dropped in any case and punctuation, and a non-string value gives length 0', () => {
  const redactor = new Redactor();
  for (const key of SENSITIVE_KEYS) {
    const output = redactor.fields({ [key.toUpperCase()]: 'hidden-value' });
    assert.deepEqual(Object.keys(output), [`${key}Length`], key);
    assert.equal(output[`${key}Length`], 12);
  }
  assert.deepEqual(redactor.fields({ Set_Cookie: 'a=b', Proxy_Authorization: 'x', body: { nested: true }, token: null }), {
    setcookieLength: 3,
    proxyauthorizationLength: 1,
    bodyLength: 0,
    tokenLength: 0,
  });
});

test('a key that contains a credential word anywhere is dropped, so run-time tokens that were never registered cannot be logged', () => {
  // Written out here rather than derived from the redactor's lists, so a word missing from those lists fails this test.
  const value = 'eyJhbGciOiJSUzI1NiJ9.fake-unregistered-token';
  const credentialKeys = [
    'accessToken',
    'refresh_token',
    'idToken',
    'bearerToken',
    'clientSecret',
    'botSecret',
    'client-secret',
    'apiKey',
    'api_key',
    'X-Api-Key',
    'nearAiApiKey',
    'jwt',
    'teamsJwt',
    'credential',
    'credentials',
    'privateKey',
    'private_key',
    'dbPassword',
    'passwd',
    'passphrase',
    'Proxy-Authorization',
    'sessionCookie',
    'Set-Cookie',
    'bearer',
    'webhookSignature',
  ];
  const redactor = new Redactor();
  for (const key of credentialKeys) {
    assert.ok(isSensitiveKey(key), `${key} must be treated as sensitive`);
    const output = redactor.fields({ [key]: value });
    assert.deepEqual(Object.values(output), [value.length], `${key} kept only the length`);
    assert.ok(!JSON.stringify(output).includes('fake-unregistered-token'), `${key} leaked its value`);
  }
});

test('ids, counts and verdicts whose names only resemble message words are still logged', () => {
  const fields = { messageId: 'm-1', contentType: 'application/json', bodyLength: 12, textLength: 3, tenantId: 'acme', runId: 'r-1', keyName: 'NEAR_AI_KEY_ACME', signal: 'SIGTERM', durationMs: 42 };
  for (const key of Object.keys(fields)) assert.equal(isSensitiveKey(key), false, key);
  assert.deepEqual(new Redactor().fields(fields), fields);
});

test('a value that is not a flat value becomes [dropped:type]', () => {
  const output = new Redactor().fields({ activity: { id: 1 }, items: [1, 2], handler: () => 1, missing: undefined, big: 10n });
  assert.deepEqual(output, { activity: '[dropped:object]', items: '[dropped:object]', handler: '[dropped:function]', missing: '[dropped:undefined]', big: '[dropped:bigint]' });
});

test('strings, numbers, booleans and null pass through', () => {
  assert.deepEqual(new Redactor().fields({ route: 'unknown', status: 404, ok: false, none: null }), { route: 'unknown', status: 404, ok: false, none: null });
});

test('a 600-character string is cut to 500 characters ending in three dots', () => {
  const output = new Redactor().fields({ detail: 'x'.repeat(600) }).detail as string;
  assert.equal(output.length, 500);
  assert.ok(output.endsWith('...'));
  assert.equal(output.slice(0, 497), 'x'.repeat(497));
  assert.equal(new Redactor().text('y'.repeat(500)), 'y'.repeat(500));
});

test('a secret cut in half by the 500-character limit is masked before the cut', () => {
  const redactor = new Redactor();
  redactor.register('boundary', 'SECRETSECRETSECRET');
  const output = redactor.text(`${'x'.repeat(490)}SECRETSECRETSECRET`);
  assert.ok(!output.includes('SECRET'), 'part of the secret survived the cut');
});

test('a plus-prefixed phone number is phone:unlabelled before a key is set', () => {
  assert.equal(new Redactor().text('call +1 (555) 010-0199 now'), 'call phone:unlabelled now');
});

test('the same phone number gets the same phone:{8 hex} label under one key and a different label under another', () => {
  const first = keyed(KEY_A);
  const label = first.text('+1 (555) 010-0199');
  assert.match(label, /^phone:[0-9a-f]{8}$/);
  assert.equal(first.text('+1 (555) 010-0199'), label);
  assert.equal(first.text('+1.555.010.0199'), label, 'separators do not change the label');
  assert.notEqual(first.text('+1 (555) 010-0100'), label, 'a different number gets a different label');
  assert.notEqual(keyed(KEY_B).text('+1 (555) 010-0199'), label);
});

test('dates and bare digit ids are unchanged', () => {
  const redactor = keyed();
  assert.equal(redactor.text('2026-11-14'), '2026-11-14');
  assert.equal(redactor.text('4815162342'), '4815162342');
  assert.equal(redactor.text('run 2026-11-14 id 4815162342 done'), 'run 2026-11-14 id 4815162342 done');
  assert.deepEqual(redactor.fields({ day: '2026-11-14', id: '4815162342' }), { day: '2026-11-14', id: '4815162342' });
});

test('a field whose name contains phone is always labelled, with or without a plus sign', () => {
  const redactor = keyed();
  const label = redactor.text('+15550100199');
  const output = redactor.fields({ callerPhone: '15550100199', 'phone-number': '+1 555 010 0199', recipientPhone: 15550100199 });
  assert.equal(output.callerPhone, label);
  assert.equal(output['phone-number'], label);
  assert.equal(output.recipientPhone, label);
  assert.equal(new Redactor().fields({ callerPhone: '15550100199' }).callerPhone, 'phone:unlabelled');
});

test('an event name with a space, an upper-case letter or a newline becomes invalid-event', () => {
  const { logger, lines } = capture(new Redactor());
  logger.info('bad event');
  logger.info('Bad.Event');
  logger.info('relay.listening\nforged');
  logger.info('relay.ok-1_x');
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { event: string }).event), ['invalid-event', 'invalid-event', 'invalid-event', 'relay.ok-1_x']);
});

test('every logger call writes exactly one JSON line with time, level and event first', () => {
  const { logger, lines } = capture(new Redactor());
  logger.info('relay.listening', { port: 8080 });
  logger.warn('http.rejected', { route: 'unknown', status: 404 });
  logger.error('relay.crashed', { detail: 'line one\nline two\r\n{"event":"forged"}' });
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(!line.includes('\n') && !line.includes('\r'), 'a raw line break inside one log line');
    JSON.parse(line);
  }
  assert.deepEqual(Object.keys(JSON.parse(lines[0] as string)), ['time', 'level', 'event', 'port']);
  assert.deepEqual(JSON.parse(lines[0] as string), { time: '2026-11-14T12:00:00.000Z', level: 'info', event: 'relay.listening', port: 8080 });
  assert.equal((JSON.parse(lines[1] as string) as { level: string }).level, 'warn');
  assert.equal((JSON.parse(lines[2] as string) as { level: string }).level, 'error');
  assert.equal((JSON.parse(lines[2] as string) as { event: string }).event, 'relay.crashed');
});

test('a field named time, level or event cannot overwrite the line envelope', () => {
  const { logger, lines } = capture(new Redactor());
  logger.info('relay.listening', { time: 'forged', level: 'error', event: 'forged.event' });
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(parsed.time, '2026-11-14T12:00:00.000Z');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.event, 'relay.listening');
  assert.equal(parsed.field_event, 'forged.event');
});

test('fields named __proto__, constructor and prototype are kept as ordinary fields, in the redactor output and on the log line', () => {
  // JSON.parse (like a computed key) gives an own __proto__ property, the way a field name from outside would arrive.
  const fields = JSON.parse('{"__proto__":"p","constructor":"c","prototype":"t","hasOwnProperty":"h"}') as Record<string, unknown>;
  const output = new Redactor().fields(fields);
  assert.equal(Object.getPrototypeOf(output), Object.prototype, 'the redactor output prototype is not replaced');
  assert.deepEqual(Object.keys(output), ['__proto__', 'constructor', 'prototype', 'hasOwnProperty']);
  assert.equal(Object.getOwnPropertyDescriptor(output, '__proto__')?.value, 'p');
  assert.equal(Object.getOwnPropertyDescriptor(output, 'constructor')?.value, 'c');
  assert.equal(Object.getOwnPropertyDescriptor(output, 'prototype')?.value, 't');

  const { logger, lines } = capture(new Redactor());
  logger.info('relay.listening', fields);
  assert.equal(lines.length, 1);
  const line = lines[0] as string;
  assert.match(line, /"__proto__":"p"/, 'the __proto__ field reaches the log line');
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['time', 'level', 'event', '__proto__', 'constructor', 'prototype', 'hasOwnProperty']);
  assert.equal(Object.getOwnPropertyDescriptor(parsed, 'constructor')?.value, 'c');
  assert.equal(Object.getOwnPropertyDescriptor(parsed, 'prototype')?.value, 't');
  // A second __proto__ under its collision name still keeps both.
  assert.equal(uniqueFieldName(new Map([['__proto__', 1]]), '__proto__'), '__proto__#2');
});

test('a renamed envelope field does not overwrite a field that already carries the new name', () => {
  const { logger, lines } = capture(new Redactor());
  logger.info('relay.listening', { field_time: 'first', time: 'forged' });
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(parsed.time, '2026-11-14T12:00:00.000Z');
  assert.equal(parsed.field_time, 'first');
  assert.equal(parsed['field_time#2'], 'forged');
});

test('the logger redacts before the sink: secrets, tokens, message text and phone numbers never reach it', () => {
  const redactor = keyed();
  redactor.register('signal-token', 'sig-secret-value-42');
  const { logger, lines } = capture(redactor);
  logger.error('relay.crashed', {
    detail: 'upstream said sig-secret-value-42 for +1 555 010 0199',
    authorization: 'Bearer sig-secret-value-42',
    message: 'please read my private note',
    activity: { text: 'private note' },
  });
  const line = lines[0] as string;
  for (const forbidden of ['sig-secret-value-42', '555 010', 'private note', 'Bearer']) assert.ok(!line.includes(forbidden), `${forbidden} reached the sink`);
  assert.match(line, /\[secret:signal-token\]/);
  assert.match(line, /phone:[0-9a-f]{8}/);
});

test('a sink that throws never throws into the caller', () => {
  const logger = new Logger(new Redactor(), () => { throw new Error('EPIPE'); });
  assert.doesNotThrow(() => logger.info('relay.listening'));
});

test('crashFields gives the error name, code and message, and a plain description for a value that is not an Error', () => {
  const error = Object.assign(new RangeError('out of range'), { code: 'ERR_X' });
  assert.deepEqual(crashFields(error), { name: 'RangeError', code: 'ERR_X', detail: 'out of range' });
  assert.deepEqual(crashFields(new Error('plain')), { name: 'Error', code: null, detail: 'plain' });
  assert.deepEqual(crashFields({ secret: 'x' }), { name: 'NonError', code: null, detail: 'object' });
  assert.deepEqual(crashFields('boom'), { name: 'NonError', code: null, detail: 'boom' });
});

// The output-path guard (D-11): every relay line goes through the Logger. Only log/logger.ts may write to stdout, only bin.ts may write to
// stderr (its fixed version sentence), and nothing calls the console object or writes to file descriptor 1 or 2 directly.
const OUTPUT_RULES: { pattern: RegExp; allowedIn: string | null; what: string }[] = [
  { pattern: /\bconsole\s*[.[]/, allowedIn: null, what: 'a console method' },
  { pattern: /\bprocess\s*\.\s*stdout\b/, allowedIn: 'src/log/logger.ts', what: 'process.stdout' },
  { pattern: /\bprocess\s*\.\s*stderr\b/, allowedIn: 'src/bin.ts', what: 'process.stderr' },
  { pattern: /\bwriteSync\s*\(\s*[12]\s*,/, allowedIn: null, what: 'a write to file descriptor 1 or 2' },
];

function findOutputViolations(relativeFile: string, text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const code = line.trim().startsWith('//') ? '' : line;
    for (const rule of OUTPUT_RULES) {
      if (rule.pattern.test(code) && rule.allowedIn !== relativeFile) found.push(`${relativeFile}:${index + 1} uses ${rule.what}`);
    }
  });
  return found;
}

test('the output guard reports a console call, a stdout write outside the logger and a stderr write outside the guard entry', () => {
  assert.equal(findOutputViolations('src/main.ts', "console.log('x');").length, 1);
  assert.equal(findOutputViolations('src/main.ts', "console['error']('x');").length, 1);
  assert.equal(findOutputViolations('src/main.ts', "process.stdout.write('x');").length, 1);
  assert.equal(findOutputViolations('src/main.ts', "process.stderr.write('x');").length, 1);
  assert.equal(findOutputViolations('src/log/logger.ts', "process.stderr.write('x');").length, 1);
  assert.equal(findOutputViolations('src/bin.ts', "process.stdout.write('x');").length, 1);
  assert.equal(findOutputViolations('src/main.ts', 'writeSync(1, data);').length, 1);
  assert.deepEqual(findOutputViolations('src/log/logger.ts', "process.stdout.write('x');"), []);
  assert.deepEqual(findOutputViolations('src/bin.ts', "process.stderr.write('x');"), []);
  assert.deepEqual(findOutputViolations('src/main.ts', '// uses console.log and process.stdout in prose'), []);
});

test('under relay/src only log/logger.ts writes to stdout and only bin.ts writes to stderr, and no file calls console methods', () => {
  const violations: string[] = [];
  const files = globSync('src/**/*.ts', { cwd: RELAY_ROOT });
  assert.ok(files.length >= 8, 'the guard found too few source files to be scanning the right directory');
  for (const relative of files) {
    const normalised = relative.split(path.sep).join('/');
    violations.push(...findOutputViolations(normalised, readFileSync(path.join(RELAY_ROOT, relative), 'utf8')));
  }
  assert.deepEqual(violations, []);
});

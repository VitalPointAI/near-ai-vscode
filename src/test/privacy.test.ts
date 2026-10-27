import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isSecretVariable, ShellSession } from '../agent/shell';
import { Transcript, TranscriptStore, transcriptKey } from '../services/transcripts';

// Privacy safeguards on this machine: credentials stay out of the agent's shell, and saved
// conversations are encrypted at rest.

test('credential-like environment variables never reach the agent\'s shell unless allowed by name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-env-'));
  const planted: Record<string, string> = { NEAR_AI_API_KEY: 'near-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', GITHUB_TOKEN: 'gh-secret', DATABASE_URL: 'postgres://u:p@h/db', HARMLESS_LOOKING: 'sk-abcdefghijklmnopqrstuvwxyz', MY_COLOR: 'blue' };
  Object.assign(process.env, planted);
  const shell = new ShellSession(root, undefined, { CLAUDE_CONFIG_DIR: '/gsd' }, ['GITHUB_TOKEN']);
  try {
    const output = (await shell.run('env')).output;
    for (const secret of ['near-secret', 'aws-secret', 'postgres://', 'sk-abcdef']) assert.ok(!output.includes(secret), `${secret} leaked`);
    assert.match(output, /^GITHUB_TOKEN=gh-secret$/m, 'an allowed variable passes');
    assert.match(output, /^MY_COLOR=blue$/m);
    assert.match(output, /^CLAUDE_CONFIG_DIR=\/gsd$/m, 'variables the extension sets are kept');
    assert.match(output, /^PATH=/m);
  } finally {
    shell.dispose();
    for (const name of Object.keys(planted)) delete process.env[name];
  }
  for (const name of ['OPENAI_API_KEY', 'STRIPE_SECRET', 'npm_config__authToken', 'SLACK_BOT_TOKEN', 'MY_PAT', 'DB_PASSWORD', 'SESSION_KEY']) assert.ok(isSecretVariable(name, 'x'), name);
  for (const name of ['PATH', 'HOME', 'LANG', 'EDITOR', 'NODE_ENV', 'TOKENIZERS_PARALLELISM']) assert.ok(!isSecretVariable(name, 'x'), name);
});

const sample = (id: string): Transcript => ({ id, title: 'Plan', model: 'm', updatedAt: '2026-10-27T12:00:00Z', turns: 1, messages: [{ role: 'user', content: 'The password in config.ts is hunter2' }] });

test('saved conversations are encrypted on disk, refuse tampering, and old plain files are migrated', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-transcripts-'));
  const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); } };
  const store = new TranscriptStore(storage, '/project', transcriptKey(secrets));
  await store.save(sample('conv-aaaaaa'));
  const dir = path.join(storage, 'transcripts', (await readdir(path.join(storage, 'transcripts')))[0]);
  const raw = await readFile(path.join(dir, 'conv-aaaaaa.json'), 'utf8');
  assert.doesNotMatch(raw, /hunter2|Plan/);
  assert.equal(JSON.parse(raw).enc, 'aes-256-gcm');
  assert.equal((await store.load('conv-aaaaaa'))?.messages[0].content, 'The password in config.ts is hunter2');
  assert.equal(Buffer.from(values.get('nearAi.transcripts.key')!, 'base64').length, 32);
  const tampered = JSON.parse(raw);
  tampered.data = Buffer.from(Buffer.from(tampered.data, 'base64').map((byte, index) => (index === 0 ? byte ^ 1 : byte))).toString('base64');
  await writeFile(path.join(dir, 'conv-aaaaaa.json'), JSON.stringify(tampered));
  assert.equal(await store.load('conv-aaaaaa'), undefined, 'a modified file does not load');
  assert.equal(await new TranscriptStore(storage, '/project', transcriptKey({ get: async () => undefined, store: async () => undefined })).load('conv-aaaaaa'), undefined, 'another key cannot read it');
  await writeFile(path.join(dir, 'conv-bbbbbb.json'), JSON.stringify(sample('conv-bbbbbb')));
  assert.equal((await store.load('conv-bbbbbb'))?.title, 'Plan');
  assert.doesNotMatch(await readFile(path.join(dir, 'conv-bbbbbb.json'), 'utf8'), /hunter2/, 'a plain file is re-saved encrypted when read');
});

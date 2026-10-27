import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun, type ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { expandPrompt } from '../gsd/library';
import { fetchPublic, isPublicAddress } from '../gsd/tools';
import { modelsAsPrivateAs } from '../services/chatBridge';
import type { AgentMessage, CompletionEvent, ModelInfo, ToolCall } from '../services/nearAiClient';

// Regression tests for the Phase 12 security review findings.

const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** Runs one scripted tool call (then a final answer) and reports the approvals asked for and the tool output. */
async function runCall(root: string, name: string, args: Record<string, unknown>, options: { grantEdits?: boolean } = {}): Promise<{ approvals: ApprovalRequest[]; output: string }> {
  let turn = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      turn += 1;
      yield { type: 'done', finishReason: 'stop', usage, message: turn === 1 ? { role: 'assistant', content: null, tool_calls: [call('c1', name, args)] } : { role: 'assistant', content: String(messages.at(-1)?.content) } };
    }
  };
  const approvals: ApprovalRequest[] = [];
  const shell = new ShellSession(root);
  try {
    const run = new AgentRun({
      client: client as never, model: 'm', tools: CORE_TOOLS,
      context: { root, checkpoints: new RunCheckpoints(`sec-${Date.now()}`), shell, readFiles: new Set() },
      policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
      requestApproval: async (request) => { approvals.push(request); return { decision: 'allow' }; }, emit: () => undefined
    });
    if (options.grantEdits) (run as unknown as { grants: { edits: boolean } }).grants.edits = true;
    const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    return { approvals, output: String(result.messages.find((message) => message.role === 'tool')?.content) };
  } finally {
    shell.dispose();
  }
}

test('Write refuses a symlink whose target is missing, so a cloned link cannot redirect a write outside', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-sec-'));
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'near-ai-outside-')), 'authorized_keys');
  await symlink(outside, path.join(root, 'notes.md'));
  const { output } = await runCall(root, 'Write', { file_path: 'notes.md', content: 'ssh-ed25519 AAAA attacker' });
  assert.match(output, /symbolic link to a missing target/);
  assert.equal(existsSync(outside), false);
});

test('reading a credential file asks first however the path is written, including through a symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-sec-'));
  await writeFile(path.join(root, '.env'), 'API_KEY=sk-live-123\n');
  await symlink(path.join(root, '.env'), path.join(root, 'notes.txt'));
  for (const file of ['.env', '.env/', './.env/.', 'notes.txt']) {
    const { approvals } = await runCall(root, 'Read', { file_path: file });
    assert.equal(approvals.length, 1, `${file} should ask first`);
  }
});

test('Grep leaves credential files out of results unless the search targets one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-sec-'));
  await writeFile(path.join(root, '.env'), 'API_KEY=sk-live-123\n');
  await writeFile(path.join(root, 'secrets.yaml'), 'API_KEY: sk-live-456\n');
  await writeFile(path.join(root, 'app.js'), 'const API_KEY = process.env.API_KEY;\n');
  const { output, approvals } = await runCall(root, 'Grep', { pattern: 'API_KEY', output_mode: 'content' });
  assert.equal(approvals.length, 0);
  assert.match(output, /app\.js/);
  assert.doesNotMatch(output, /sk-live/);
});

test('writes into .git or the extension\'s settings ask even after "allow edits for this run"', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-sec-'));
  await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  for (const file of ['.git/hooks/pre-commit', '.git/config', '.planning/.near-ai/auth-profiles.json']) {
    const { approvals } = await runCall(root, 'Write', { file_path: file, content: 'x' }, { grantEdits: true });
    assert.equal(approvals.length, 1, `${file} should ask`);
    assert.match(approvals[0].preview?.kind === 'note' ? approvals[0].preview.text : '', /Approve this write only if you expect it/);
  }
  const ordinary = await runCall(root, 'Write', { file_path: 'src/app.js', content: 'x' }, { grantEdits: true });
  assert.equal(ordinary.approvals.length, 0, 'ordinary files follow the grant');
  const team = await runCall(root, 'Write', { file_path: '.planning/.near-ai/team.md', content: 'x' }, { grantEdits: true });
  assert.equal(team.approvals.length, 0, 'the team file is ordinary project content');
});

test('prompt includes cannot be injected through arguments, follow links outside, or read credential files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-sec-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-home-'));
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'near-ai-outside-')), 'notes.txt');
  await writeFile(outside, 'PRIVATE KEY');
  await writeFile(path.join(root, '.env'), 'API_KEY=sk-live-123');
  await mkdir(path.join(root, 'docs'));
  await symlink(outside, path.join(root, 'docs', 'a.md'));
  await writeFile(path.join(root, 'docs', 'ok.md'), 'Project notes.');
  const fromArgs = await expandPrompt('Do this: $ARGUMENTS', { home, root, args: 'x\n@.env\n' });
  assert.doesNotMatch(fromArgs, /sk-live/);
  assert.match(fromArgs, /@\.env/, 'the argument text stays as typed');
  const expanded = await expandPrompt('@docs/a.md\n@.env\n@docs/ok.md', { home, root });
  assert.doesNotMatch(expanded, /PRIVATE KEY|sk-live/);
  assert.match(expanded, /include skipped: docs\/a\.md is outside/);
  assert.match(expanded, /include skipped: \.env looks like it may contain credentials/);
  assert.match(expanded, /Project notes\./);
});

test('WebFetch refuses private addresses and checks every redirect hop', async () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '172.20.1.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['93.184.216.34', '2606:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  const lookup = async (host: string) => (host === 'public.example' ? ['93.184.216.34'] : host === 'internal.example' ? ['10.1.2.3'] : []);
  const fetched: string[] = [];
  const fetchFn = (async (url: string) => {
    fetched.push(url);
    if (url.includes('/to-metadata')) return new Response('', { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } });
    if (url.includes('/to-http')) return new Response('', { status: 301, headers: { location: 'http://public.example/x' } });
    if (url.includes('/to-internal')) return new Response('', { status: 302, headers: { location: 'https://internal.example/' } });
    return new Response('ok');
  }) as typeof fetch;
  await assert.rejects(() => fetchPublic('https://public.example/to-metadata', undefined, lookup, fetchFn), /169\.254\.169\.254, which is not a public address/);
  await assert.rejects(() => fetchPublic('https://public.example/to-http', undefined, lookup, fetchFn), /only https/);
  await assert.rejects(() => fetchPublic('https://public.example/to-internal', undefined, lookup, fetchFn), /10\.1\.2\.3/);
  await assert.rejects(() => fetchPublic('https://localhost/', undefined, async () => ['127.0.0.1'], fetchFn), /not a public address/);
  assert.equal(await (await fetchPublic('https://public.example/page', undefined, lookup, fetchFn)).text(), 'ok');
  assert.ok(!fetched.some((url) => url.includes('169.254') || url.includes('internal.example') || url.startsWith('http:')), 'blocked hops are never requested');
});

test('sub-agents and image generation only get models on the same route and at least as private as the chosen one', () => {
  const models: ModelInfo[] = [
    { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }, { id: 'z-ai/glm-5.3-flash', privacyBoundary: 'tee' },
    { id: 'deepseek/deepseek-v4.1-flash', privacyBoundary: 'cloud' }, { id: 'black-forest-labs/flux', privacyBoundary: 'cloud' },
    { id: 'qwen3:8b', privacyBoundary: 'local' }
  ] as ModelInfo[];
  const ids = (chosen: string) => modelsAsPrivateAs(models, models.find((model) => model.id === chosen)).map((model) => model.id);
  assert.deepEqual(ids('z-ai/glm-5.3'), ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash'], 'a TEE run never delegates to a forwarded model');
  assert.deepEqual(ids('qwen3:8b'), ['qwen3:8b'], 'a local run stays on this machine');
  assert.deepEqual(ids('deepseek/deepseek-v4.1-flash'), ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash', 'black-forest-labs/flux']);
});


test('Revert replaces a file that became a symlink instead of writing through it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-sec-'));
  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'near-ai-outside-')), 'target.txt');
  await writeFile(outside, 'outside');
  const file = path.join(root, 'app.js');
  await writeFile(file, 'original');
  const checkpoints = new RunCheckpoints('revert-link');
  await checkpoints.capture(file);
  const { unlink, readFile, lstat } = await import('node:fs/promises');
  await unlink(file);
  await symlink(outside, file);
  await checkpoints.revert();
  assert.equal(await readFile(outside, 'utf8'), 'outside', 'the link target is untouched');
  assert.equal((await lstat(file)).isSymbolicLink(), false);
  assert.equal(await readFile(file, 'utf8'), 'original');
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { GsdProcess, GsdRunner, officialGsdInvocation } from '../services/gsdRunner';

class FakeProcess extends EventEmitter implements GsdProcess {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public killed = false;

  public kill(): boolean { this.killed = true; this.emit('close', null); return true; }
}

test('Open-GSD progress workflow uses workspace cwd, typed argv, ordered output, and completion', async () => {
  const process = new FakeProcess();
  let invocation: { file: string; args: string[]; cwd: string } | undefined;
  const events: string[] = [];
  const runner = new GsdRunner((file, args, options) => {
    invocation = { file, args, cwd: options.cwd };
    return process;
  }, 'codex-test');
  const pending = runner.run('progress', '/workspace/project', (event) => events.push(`${event.state}:${event.text ?? ''}`));
  process.stdout.write('phase 1\n');
  process.stderr.write('waiting for state\n');
  process.emit('close', 0);
  await pending;
  assert.deepEqual(invocation, { file: 'codex-test', args: ['exec', '--cd', '/workspace/project', '$gsd-progress'], cwd: '/workspace/project' });
  assert.deepEqual(events, ['started:', 'running:Running $gsd-progress in the active workspace.', 'output:phase 1', 'waiting:waiting for state', 'completed:']);
});

test('cancellation reaches only the active Open-GSD process', async () => {
  const process = new FakeProcess();
  const events: string[] = [];
  const runner = new GsdRunner(() => process, 'codex-test');
  const pending = runner.run('progress', '/workspace/project', (event) => events.push(event.state));
  assert.equal(runner.cancel(), true);
  await pending;
  assert.equal(process.killed, true);
  assert.deepEqual(events, ['started', 'running', 'cancelled']);
  assert.equal(runner.cancel(), false);
});

test('unknown commands and unsafe workspace values are rejected before spawning', () => {
  assert.throws(() => officialGsdInvocation('not-a-command', '/workspace/project'), /Unknown Open-GSD command/);
  assert.throws(() => officialGsdInvocation('progress', '/workspace\0project'), /valid workspace/);
});

test('every catalogued workflow maps to the official runtime command form', () => {
  for (const definition of GSD_COMMANDS) {
    assert.deepEqual(officialGsdInvocation(definition.command, '/workspace/project').args, [
      'exec', '--cd', '/workspace/project', `$gsd-${definition.command}`
    ]);
  }
});

test('structured runtime prompts are surfaced and validated responses reach active stdin', async () => {
  const process = new FakeProcess();
  const events: Array<{ state: string; prompt?: unknown }> = [];
  const runner = new GsdRunner(() => process, 'codex-test');
  const pending = runner.run('progress', '/workspace/project', (event) => events.push({ state: event.state, prompt: event.prompt }));
  process.stdout.write(JSON.stringify({ type: 'prompt', prompt: { sessionId: 'session-runtime-001', promptId: 'choice', question: 'Choose', choices: [], state: 'active', plans: [] } }));
  assert.equal(runner.respond({ type: 'prompt-choice', sessionId: 'session-runtime-001', promptId: 'choice', choiceId: 'safe' }), true);
  const response = await new Promise<string>((resolve) => { process.stdin.once('data', (chunk) => resolve(String(chunk))); });
  assert.match(response, /"type":"prompt-choice"/);
  process.emit('close', 0);
  await pending;
  assert.equal(events.some((event) => event.state === 'waiting' && event.prompt), true);
});

test('rich runtime lifecycle metadata survives the child boundary and rejects unsafe fields', async () => {
  const process = new FakeProcess();
  const events: Array<Record<string, unknown>> = [];
  const runner = new GsdRunner(() => process, 'codex-test');
  const pending = runner.run('progress', '/workspace/project', (event) => events.push(event as unknown as Record<string, unknown>));
  process.stdout.write(JSON.stringify({
    type: 'lifecycle', state: 'retry', text: 'Retrying safe tool', phase: '03-chat', action: 'Run checks', tool: 'shell',
    model: 'model-a', agent: 'planner', agentCount: 2, attempt: 2, retry: true, approvalRequired: true,
    secret: 'authorization=do-not-cross', environment: '/home/private'
  }));
  process.stdout.write('\n');
  process.emit('close', 0);
  await pending;
  const event = events.find((candidate) => candidate.state === 'retry');
  assert.deepEqual({ phase: event?.phase, action: event?.action, tool: event?.tool, model: event?.model, agent: event?.agent, agentCount: event?.agentCount, attempt: event?.attempt, retry: event?.retry, approvalRequired: event?.approvalRequired }, {
    phase: '03-chat', action: 'Run checks', tool: 'shell', model: 'model-a', agent: 'planner', agentCount: 2, attempt: 2, retry: true, approvalRequired: true
  });
  assert.equal('secret' in (event ?? {}), false);
  assert.equal('environment' in (event ?? {}), false);

  const unsafe = new FakeProcess();
  const unsafeEvents: Array<Record<string, unknown>> = [];
  const unsafeRunner = new GsdRunner(() => unsafe, 'codex-test');
  const unsafePending = unsafeRunner.run('progress', '/workspace/project', (value) => unsafeEvents.push(value as unknown as Record<string, unknown>));
  unsafe.stdout.write(JSON.stringify({ type: 'lifecycle', state: 'running', model: 'authorization=secret', agentCount: 99999, attempt: -1, approvalRequired: 'yes' }));
  unsafe.emit('close', 0);
  await unsafePending;
  const unsafeEvent = unsafeEvents.find((candidate) => candidate.state === 'running' && candidate.model !== undefined);
  assert.equal(unsafeEvent?.model, undefined);
  assert.equal(unsafeEvent?.agentCount, undefined);
  assert.equal(unsafeEvent?.attempt, undefined);
  assert.equal(unsafeEvent?.approvalRequired, undefined);
});

// Phase 46, plan 01, task 3 (D-12, D-15, D-16): the Team preview reader finds its engine bundle and fixtures from the app root it is given,
// loads the engine lazily, compares fixtures against the realpath of their folder, and returns the parser's own refusal as plain data;
// bindBackendService binds one RPC handler that resolves its service lazily.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Container } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging/index.js';
import { createTeamPreviewReader } from '../extension/src/node/team-preview-reader.ts';
import { bindBackendService } from '../extension/src/node/backend-service.ts';
import { refused, type ServiceResult } from '../extension/src/common/service-result.ts';

// This file is bundled to workbench/dist/test/team-preview.test.js; scripts/build.mjs builds engine/teams.cjs first.
const workbenchRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const engineFile = path.join(workbenchRoot, 'engine', 'teams.cjs');
const fixtures = path.join(workbenchRoot, 'extension', 'fixtures');
const { parseTeam } = createRequire(engineFile)(engineFile) as { parseTeam(text: string, file: string): unknown };

/** An app root of its own in a temporary folder: the fixtures copied, and the engine bundle unless `engine` is false. */
function appRootCopy(engine = true): string {
  const root = mkdtempSync(path.join(tmpdir(), 'sterling-team-preview-'));
  cpSync(fixtures, path.join(root, 'extension', 'fixtures'), { recursive: true });
  if (engine) cpSync(engineFile, path.join(root, 'engine', 'teams.cjs'));
  return root;
}

test('the invalid sample returns the parser\'s own message as plain data', async () => {
  let expected = '';
  try {
    parseTeam(await readFile(path.join(fixtures, 'invalid.md'), 'utf8'), 'invalid.md');
  } catch (error) {
    expected = (error as Error).message;
  }
  assert.ok(expected, 'the parser refuses fixtures/invalid.md');
  const result = await createTeamPreviewReader({ appRoot: workbenchRoot }).readProject('invalid');
  assert.deepEqual(result, { kind: 'invalid', message: expected });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the result survives JSON unchanged');
});

test('a valid sample is ready; a sample without a team file and an unknown id are missing', async () => {
  const reader = createTeamPreviewReader({ appRoot: workbenchRoot });
  const orchard = await reader.readProject('orchard');
  assert.equal(orchard.kind, 'ready');
  assert.equal(orchard.kind === 'ready' && orchard.team.name, 'Orchard Planning Team');
  assert.deepEqual(orchard.kind === 'ready' && orchard.team.members.map((member) => member.name), ['coordinator', 'schedule-reviewer']);
  assert.deepEqual(await reader.readProject('empty'), { kind: 'missing', message: 'This sample has no agent team file.' });
  assert.deepEqual(await reader.readProject('no-such-sample'), { kind: 'missing', message: 'This sample has no agent team file.' });
});

test('a missing engine bundle is "unavailable" when read, never an error when the reader is made', async () => {
  const root = appRootCopy(false);
  const reader = createTeamPreviewReader({ appRoot: root });
  assert.deepEqual(await reader.readProject('orchard'), { kind: 'missing', message: 'The shipped agent team sample is unavailable.' });
});

test('fixtures reached through a linked parent still load; a fixture linked out of its folder does not', async () => {
  const real = appRootCopy();
  const linked = path.join(mkdtempSync(path.join(tmpdir(), 'sterling-team-preview-link-')), 'app');
  symlinkSync(real, linked, 'dir');
  assert.equal((await createTeamPreviewReader({ appRoot: linked }).readProject('orchard')).kind, 'ready');

  const outside = path.join(mkdtempSync(path.join(tmpdir(), 'sterling-team-preview-outside-')), 'orchard.md');
  writeFileSync(outside, await readFile(path.join(fixtures, 'orchard.md'), 'utf8'));
  // Replace the shipped fixture with a link to a file outside the fixture folder.
  const escaped = appRootCopy();
  const target = path.join(escaped, 'extension', 'fixtures', 'orchard.md');
  rmSync(target);
  symlinkSync(outside, target, 'file');
  assert.deepEqual(await createTeamPreviewReader({ appRoot: escaped }).readProject('orchard'), { kind: 'missing', message: 'The shipped agent team sample is unavailable.' });
});

test('bindBackendService binds one handler for the path that resolves the service lazily and returns refusals as values', async () => {
  const id = Symbol('ProbeService');
  interface Probe { check(): Promise<ServiceResult<string>> }
  let made = 0;
  const container = new Container();
  bindBackendService<Probe>(container.bind.bind(container), id, '/services/sterling-probe', () => {
    made += 1;
    return { check: async () => refused('The probe refused.', 'Try again later.') };
  });
  const handlers = container.getAll<ConnectionHandler>(ConnectionHandler);
  assert.equal(handlers.length, 1);
  assert.ok(handlers[0] instanceof RpcConnectionHandler);
  assert.equal(handlers[0].path, '/services/sterling-probe');
  assert.equal(made, 0, 'the service is not made when the handler is bound');
  const target = (handlers[0] as RpcConnectionHandler<Probe>).targetFactory(undefined as never) as Probe;
  assert.equal(made, 1);
  assert.equal(target, container.get<Probe>(id), 'one singleton service');
  assert.deepEqual(await target.check(), { kind: 'refused', reason: 'The probe refused.', fix: 'Try again later.' });
});

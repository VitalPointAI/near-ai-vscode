import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AuditStore } from '../services/auditStore';
import { hostAttribution } from '../domain/activity';

const event = (id: string, type: 'route' | 'completed' = 'route') => ({ version: 1 as const, id, timestamp: '2026-01-01T00:00:00.000Z', type, sessionId: 's1', projectId: 'p1', phase: '04', agentRole: 'tester', reason: 'bearer super-secret command: rm -rf / context: private prompt', metadata: { apiKey: 'should-not-export', safe: true } });

test('audit store persists, filters, bounds, and exports only operational redacted metadata', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-audit-')); const first = new AuditStore(workspace); await first.append(event('one')); await first.append({ ...event('two', 'completed'), sessionId: 's2' });
  const second = new AuditStore(workspace); assert.equal((await second.list({ sessionId: 's1' })).length, 1); const exported = await second.export({ projectId: 'p1' }); assert.equal(exported.includes('super-secret'), false); assert.equal(exported.includes('should-not-export'), false); assert.equal(exported.includes('private prompt'), false);
  for (let index = 0; index < 550; index += 1) await second.append({ ...event(`bounded-${index}`), timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z` }); assert.equal((await second.list()).length, 500);
});

test('corrupt audit data recovers as empty without throwing', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-audit-corrupt-')); const file = path.join(workspace, '.planning', '.near-ai', 'audit.json'); await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file), { recursive: true })); await writeFile(file, '{not-json', 'utf8'); const store = new AuditStore(workspace); assert.deepEqual(await store.list(), []);
});

test('audit attribution is allowlisted, filterable, and legacy rows remain explicitly unknown', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-audit-attribution-')); const attribution = hostAttribution('project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Workspace A', 'profile-company-a', 'Company A');
  const store = new AuditStore(workspace);
  await store.append({ ...event('attributed'), attribution, requestId: 'req-a', reason: 'Completed safely', metadata: { apiKey: 'secret', refreshToken: 'secret', safe: true } });
  const filtered = await store.list({ organizationProfileId: attribution.organizationProfileId, projectId: attribution.projectId });
  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0]?.attribution, attribution);
  const reloaded = new AuditStore(workspace); const persisted = await reloaded.list();
  assert.equal(persisted[0]?.attribution?.organizationProfileId, 'profile-company-a');
  assert.doesNotMatch(await reloaded.export(), /secret|private prompt|raw context|command\s*[:=]/i);

  const legacy = new AuditStore(); await legacy.append(event('legacy'));
  const legacyEvent = (await legacy.list())[0];
  assert.equal(legacyEvent?.attribution?.status, 'legacy-unknown');
  await legacy.append({ ...event('corrupt'), type: 'not-a-real-event' as never, attribution: { version: 1, status: 'attributed', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectLabel: 'Workspace A', organizationProfileId: 'profile-company-a', organizationDisplayName: 'Company A' } });
  assert.equal((await legacy.list()).length, 1);
});

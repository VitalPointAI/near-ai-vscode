import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ResumableExecution } from '../services/resumableExecution';

const snapshot = { sessionId: 's1', projectId: 'p1', phase: '04', agents: [{ id: 'agent-1', role: 'implementer', status: 'paused' as const, model: 'local', costUsd: 0.5 }], pendingApprovalIds: ['preview-1'], budgets: { project: { limitUsd: 10, spentUsd: 1, reservedUsd: 0, remainingUsd: 9, status: 'ok' as const, warningAtUsd: 8 } }, lastSafeEvent: { id: 'event-1', type: 'pause', timestamp: '2026-01-01T00:00:00.000Z' }, nextAction: { kind: 'request-approval' as const, id: 'preview-1', summary: 'Review the next tool action.' } };

test('resume snapshot persists ledger and pending approval without executable command data', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-resume-')); const first = new ResumableExecution(workspace); const saved = await first.save(snapshot); assert.equal(saved.requiresFreshPolicy, true); assert.equal(JSON.stringify(saved).includes('command'), false);
  const restored = await new ResumableExecution(workspace).restore(); assert.equal(restored?.pendingApprovalIds[0], 'preview-1'); assert.equal(restored?.agents[0].status, 'paused'); assert.equal(restored?.requiresFreshApproval, true);
});

test('resume never replays or silently authorizes a pending action', async () => {
  const execution = new ResumableExecution(); await execution.save(snapshot); assert.equal((await execution.prepareResume()).allowed, false); const prepared = await execution.prepareResume('preview-1'); assert.equal(prepared.allowed, true); if (prepared.allowed) assert.equal(prepared.snapshot.requiresFreshPolicy, true);
  await execution.markSafeEvent({ id: 'event-2', type: 'resume' }); const again = await execution.prepareResume('wrong'); assert.equal(again.allowed, false);
});

test('resume restore tolerates corrupt state', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'near-ai-resume-corrupt-')); const fs = await import('node:fs/promises'); await fs.mkdir(path.join(workspace, '.planning', '.near-ai'), { recursive: true }); await fs.writeFile(path.join(workspace, '.planning', '.near-ai', 'resume.json'), 'not-json', 'utf8'); assert.equal(await new ResumableExecution(workspace).restore(), undefined);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultActionPolicy } from '../domain/policy';
import { ApprovalService } from '../services/approvalService';
import { AuditStore } from '../services/auditStore';
import { PrivacyPreflight } from '../services/privacyPreflight';
import { PolicyGate } from '../services/policyGate';
import { hostAttribution } from '../domain/activity';

const request = (overrides: Partial<Parameters<ApprovalService['preview']>[0]> = {}) => ({ requestId: 'req-1', sessionId: 'session-1', projectId: 'project-1', capability: 'shell' as const, action: 'Run a tool', targetScope: 'workspace/src', provider: 'local', providerBoundary: 'local' as const, context: 'private prompt bearer secret-token', paths: ['src/index.ts'], estimated: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 1, currency: 'USD' as const }, reversible: false, ...overrides });
const service = (audit?: AuditStore, now = () => 1_700_000_000_000) => new ApprovalService(new PolicyGate(defaultActionPolicy(), new PrivacyPreflight()), { audit, now, requestLimitUsd: 2, sessionLimitUsd: 3, projectLimitUsd: 4 });

test('approval preview shows scope/provider/data/cost and redacts sensitive input', async () => {
  const audit = new AuditStore(); const preview = await service(audit).preview(request());
  assert.equal(preview.requiresApproval, true); assert.equal(preview.providerBoundary, 'local'); assert.equal(preview.estimated.totalTokens, 30); assert.equal(preview.budgetAfter.project.status, 'ok');
  const serialized = JSON.stringify(preview); assert.equal(serialized.includes('secret-token'), false); assert.equal(serialized.includes('private prompt'), false); assert.match(preview.riskExplanation, /approval|policy/i);
  const events = await audit.list(); assert.deepEqual(events.map((event) => event.type), ['preflight', 'preview']);
});

test('risky action requires one exact approval and preserves estimated versus actual cost', async () => {
  const audit = new AuditStore(); const approvals = service(audit); const preview = await approvals.preview(request());
  assert.equal((await approvals.dispatch(preview.previewId)).allowed, false);
  assert.equal((await approvals.decide(preview.previewId, 'approved')).decision, 'approved');
  const result = await approvals.dispatch(preview.previewId, { costUsd: 1.25, tokens: 45 }); assert.equal(result.allowed, true);
  assert.equal((await audit.list({ type: 'dispatch' }))[0].estimatedCostUsd, 1); assert.equal((await audit.list({ type: 'dispatch' }))[0].actualCostUsd, 1.25);
});

test('budget warning and hard stop prevent new work while emergency stop is auditable', async () => {
  const audit = new AuditStore(); const approvals = service(audit); const first = await approvals.preview(request({ requestId: 'req-2', estimated: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 1.7, currency: 'USD' } })); assert.equal(first.budgetAfter.request.status, 'warning');
  await approvals.decide(first.previewId, 'approved'); assert.equal((await approvals.dispatch(first.previewId)).allowed, true);
  const second = await approvals.preview(request({ requestId: 'req-3', estimated: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 1.7, currency: 'USD' } })); assert.equal(second.budgetAfter.session.status, 'hard-stop'); assert.equal((await approvals.dispatch(second.previewId)).allowed, false);
  approvals.emergencyStop('project-1'); const third = await approvals.preview(request({ requestId: 'req-4' })); assert.equal((await approvals.dispatch(third.previewId)).allowed, false); assert.equal(approvals.isStopped('project-1'), true); assert.ok((await audit.list({ type: 'emergency-stop' })).length >= 1);
});

test('stale or denied decisions cannot authorize dispatch', async () => {
  let time = 1_700_000_000_000; const approvals = service(undefined, () => time); const preview = await approvals.preview(request()); await approvals.decide(preview.previewId, 'denied', 'not in scope'); assert.equal((await approvals.dispatch(preview.previewId)).allowed, false);
  const next = await approvals.preview(request({ requestId: 'req-5' })); await approvals.decide(next.previewId, 'approved'); time += 6 * 60_000; assert.equal((await approvals.dispatch(next.previewId)).allowed, false);
});

test('approval and budget audit events retain the preview attribution after a later profile switch', async () => {
  const audit = new AuditStore(); const companyA = hostAttribution('project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Workspace A', 'profile-company-a', 'Company A');
  const approvals = service(audit); const preview = await approvals.preview(request({ projectId: companyA.projectId, attribution: companyA, requestId: 'req-attributed' }));
  assert.deepEqual(preview.attribution, companyA);
  await approvals.decide(preview.previewId, 'approved');
  await approvals.recordLifecycle(preview.previewId, 'budget', { outcome: 'warning', estimatedTokens: 30 });
  await approvals.dispatch(preview.previewId, { costUsd: 0.75, tokens: 28 });
  const events = await audit.list({ organizationProfileId: companyA.organizationProfileId });
  assert.ok(events.length >= 4);
  assert.equal(events.every((event) => event.attribution?.organizationProfileId === 'profile-company-a' && event.attribution.projectId === companyA.projectId), true);
  assert.equal(events.some((event) => event.type === 'budget'), true);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /api[_ -]?key|refresh[-_ ]?token|private prompt|raw context|command\s*[:=]/i);
});

test('forged or stale attribution is never accepted as a credential-shaped owner', async () => {
  const audit = new AuditStore(); const approvals = service(audit);
  const preview = await approvals.preview(request({ attribution: { version: 1, status: 'attributed', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectLabel: 'apiKey=secret', organizationProfileId: 'profile-company-a', organizationDisplayName: 'refresh-token=secret' } }));
  assert.equal(preview.attribution.status, 'legacy-unknown');
  assert.doesNotMatch(JSON.stringify(preview), /apiKey=secret|refresh-token=secret/);
  await approvals.decide(preview.previewId, 'approved');
  const result = await approvals.dispatch(preview.previewId);
  assert.equal(result.allowed, true);
  assert.equal((await audit.list())[0]?.attribution?.status, 'legacy-unknown');
});

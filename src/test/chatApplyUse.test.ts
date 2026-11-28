// Insert at cursor only for answers whose model may write (74.1-12 Task 2, D-21, P4, Q1, 74.1-UI-SPEC S6), and the team words (S7): an answer from a
// model approved for agent work keeps Insert; in report mode an answer outside the policy keeps it and says so; under enforce, on a surface whose use is
// chat you review, Insert is disabled with the reason and Copy stays; team files say "private models only".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parsePrivacy, parseTeamPrivacy, renderTeam } from '../agent/teams';
import { trustBadgeFor } from '../domain/gate/trustBadge';
import type { TrustFacts } from '../domain/gate/trust';
import { APPLY_TEXT, applyAllowed } from '../services/chatBridge';

const REPO = path.resolve(__dirname, '..', '..');
const approval = (maxTier: 'T0' | 'T1' | 'T2', passport = 'openai/gpt-oss') => ({ kind: 'model-approval', passport, maxTier, expiresAt: '2027-11-20T00:00:00Z' });
const exception = { kind: 'authorization', authorizationKind: 't1-risk', id: 'ra-1', name: 'Avery Chen', expiresAt: '2026-12-25T00:00:00Z', selfSigned: false };

test('D-21: an answer from a model approved for agent work keeps Insert at cursor, with nothing to say', () => {
  assert.deepEqual(applyAllowed({ allowedBy: [approval('T2')] }, 'openai/gpt-oss-120b'), { allowed: true });
});

test('P4: under enforce, an answer allowed only for chat you review cannot be applied, and the reason says Copy still works', () => {
  const found = applyAllowed({ allowedBy: [approval('T0', 'z-ai/glm'), exception] }, 'z-ai/glm-5.3');
  assert.deepEqual(found, { allowed: false, reason: 'z-ai/glm is approved only for chat you review, so its answer cannot be applied to a file. You can copy the text.' });
  assert.equal(applyAllowed({ allowedBy: [approval('T0', 'some/model')] }, 'some/model').reason, 'some/model is approved only for research, so its answer cannot be applied to a file. You can copy the text.');
  assert.deepEqual(applyAllowed({ allowedBy: [] }, 'some/model'), { allowed: true }, 'no approval step ran (no policy): nothing to say');
});

test('Q1: in report mode an answer outside the policy keeps Insert, and says it is outside your organization\'s model policy', () => {
  const found = applyAllowed({ allowedBy: [approval('T0', 'z-ai/glm')], wouldRefuse: ['route.passport'] }, 'z-ai/glm-5.3');
  assert.equal(found.allowed, true);
  assert.equal(found.reason, 'z-ai/glm is approved only for research. Applying its answer to a file is outside your organization\'s model policy (report only).');
  assert.equal(APPLY_TEXT.applyReportOnly.startsWith('{model} is approved only for {use}.'), true);
});

test('the answer\'s badge carries the rule from its trust facts, and none when Insert is allowed with nothing to say', () => {
  const base = { route: 'near' as const, nearEndpoint: true, boundary: 'tee' as const, hasEvidence: true, verification: { outcome: 'unavailable' as const }, connectionFresh: false, earlierCheckFailed: false };
  const trust = (allowedBy: unknown[], wouldRefuse: string[] = []): TrustFacts => ({ place: { class: 'nearai-tee', region: 'unstated' }, verification: 'not-checked', allowedBy: allowedBy as TrustFacts['allowedBy'], wouldRefuse: wouldRefuse as TrustFacts['wouldRefuse'] });
  assert.equal(trustBadgeFor({ ...base, trust: trust([approval('T2')]) } as never)?.apply, undefined);
  assert.deepEqual(trustBadgeFor({ ...base, trust: trust([approval('T0', 'z-ai/glm'), exception]) } as never)?.apply, { allowed: false, reason: 'z-ai/glm is approved only for chat you review, so its answer cannot be applied to a file. You can copy the text.' });
  assert.equal(trustBadgeFor({ ...base, trust: trust([approval('T0', 'z-ai/glm')], ['route.passport']) } as never)?.apply?.allowed, true);
});

test('S6: the page keeps Insert focusable but does nothing while it is aria-disabled, and Copy has no such rule', () => {
  const page = readFileSync(path.join(REPO, 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(page, /const insert = iconButton\('insert', 'Insert at cursor', \(\) => \{ if \(insert\.getAttribute\('aria-disabled'\) !== 'true'\) post\(\{ type: 'insert-code'/);
  assert.match(page, /button\.setAttribute\('aria-disabled', 'true'\); button\.setAttribute\('aria-describedby', line\.id\)/);
  assert.doesNotMatch(page.slice(page.indexOf("const copy = iconButton('copy'"), page.indexOf("const copy = iconButton('copy'") + 300), /aria-disabled/);
});

test('S7, D-21: team files say "private models only": verified private hardware or this computer; no NEAR TEE in user-facing team text', () => {
  assert.throws(() => parseTeamPrivacy('secret'), { message: 'The agent team has "privacy: secret"; use privacy: private (private models only: verified private hardware or this computer) or privacy: any.' });
  assert.throws(() => parsePrivacy('secret', 'writer'), { message: 'Member writer has "privacy: secret"; use privacy: private (verified private hardware or this computer) or privacy: any.' });
  assert.match(renderTeam('Example', 'An example', []), /privacy \(private: private models only, which means verified private hardware or this computer; any: whatever the run may use\)/);
  const source = readFileSync(path.join(REPO, 'src', 'agent', 'teams.ts'), 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n');
  assert.equal((source.match(/NEAR TEE/g) ?? []).length, 0);
});

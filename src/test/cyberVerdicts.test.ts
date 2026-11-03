// The four-verdict domain type (D-24, CYBER-09): each verdict has exactly one report sentence, the
// two failure verdicts are refused without a reason, SARIF levels distinguish access from failure, and
// no rendering ever claims the target is "clean".

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Verdict } from '../domain/cyber';
import { renderVerdict, requiresReason, VERDICT_LANGUAGE, verdictSummary, verdictToSarifLevel, VerdictError } from '../domain/cyberVerdicts';

const VERDICTS: Verdict[] = ['not_vulnerable', 'exploit_failed', 'could_not_determine', 'verified_access'];

const finding = (verdict: Verdict, reason?: string) => ({ verdict, checkId: 'sql-injection', title: 'Login accepts an injected predicate', ...(reason ? { reason } : {}) });

test('each verdict renders its own sentence shape', () => {
  assert.equal(renderVerdict(finding('not_vulnerable')), 'Target is not vulnerable to sql-injection');
  assert.equal(renderVerdict(finding('exploit_failed', 'the payload returned 401')), 'Exploit attempt failed — the payload returned 401');
  assert.equal(renderVerdict(finding('could_not_determine', 'the sandbox tier was disabled')), 'Unable to determine — the sandbox tier was disabled');
  assert.equal(renderVerdict(finding('verified_access', 'HTTP 200 with {"result":"ok"}'), { evidence: 'HTTP 200 with {"result":"ok"}' }), 'Verified access — HTTP 200 with {"result":"ok"}');
  for (const verdict of VERDICTS) assert.ok(VERDICT_LANGUAGE[verdict].length > 0, `${verdict} has language`);
});

test('only the two failure verdicts require a reason', () => {
  assert.equal(requiresReason('exploit_failed'), true);
  assert.equal(requiresReason('could_not_determine'), true);
  assert.equal(requiresReason('verified_access'), false);
  assert.equal(requiresReason('not_vulnerable'), false);
});

test('a failure verdict without a reason is refused rather than rendered with an empty slot', () => {
  assert.throws(() => renderVerdict(finding('exploit_failed')), (error: Error) => error instanceof VerdictError && /needs a reason/.test(error.message));
  assert.throws(() => renderVerdict(finding('could_not_determine', '   ')), VerdictError);
  // A verdict that does not need one still renders.
  assert.match(renderVerdict(finding('verified_access', 'a shell was returned')), /Verified access/);
});

test('SARIF levels distinguish access from a failed attempt from a pass', () => {
  assert.equal(verdictToSarifLevel('verified_access'), 'error');
  assert.equal(verdictToSarifLevel('exploit_failed'), 'note');
  assert.equal(verdictToSarifLevel('could_not_determine'), 'note');
  assert.equal(verdictToSarifLevel('not_vulnerable'), 'pass');
  for (const verdict of VERDICTS) assert.ok(verdictToSarifLevel(verdict));
});

test('no verdict rendering ever claims the target is clean, and failures always carry their reason', () => {
  const rendered: string[] = [];
  for (const verdict of VERDICTS) {
    const reason = requiresReason(verdict) ? `a ${verdict} reason` : undefined;
    const line = renderVerdict(finding(verdict, reason), { evidence: 'captured output' });
    rendered.push(line);
    assert.doesNotMatch(line, /\bclean\b/i, `${verdict} must not render as clean`);
    if (reason) assert.ok(line.includes(reason), `${verdict} must carry its reason`);
  }
  // The summary renders every finding's own line, with no slots left empty.
  const summary = verdictSummary([finding('not_vulnerable'), finding('exploit_failed', 'why'), finding('could_not_determine', 'why'), finding('verified_access', 'a shell was returned')]);
  assert.equal(summary.length, 4);
  assert.equal(summary[1], 'Exploit attempt failed — why');
  assert.equal(summary[3], 'Verified access — a shell was returned');
  assert.ok(summary.every((line) => !/\bclean\b/i.test(line)));
});

// PR #74 review round 5: a floor card a person approved late ("allowed once") is used up by the next decision of that exact call, whatever that decision is,
// and it expires: after FLOOR_APPROVAL_TTL_MS, and when the run's turn ends. Before, it was used up only when the call was again a floor ask, so a call
// decided otherwise in between (the emergency stop, a deny rule, any refusal) left it waiting, and a much later identical call could run with no card.
// Every folder here is under the test run's temporary folder; nothing runs: the gate only decides.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approveFloorCallLate, endFloorApprovals, FLOOR_APPROVAL_TTL_MS, floorApprovalsOnce, floorCallKey, gateToolCall } from '../agent/gateAdapter';
import type { GateCallInput } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { writeTool } from '../agent/tools';
import { failedClosed } from '../domain/gate/bundle';
import type { GateRuntime } from '../domain/gate/decide';
import { testGateRuntime } from './helpers/gatedRuns';

const START = Date.parse('2026-11-17T10:00:00.000Z');

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-late-'));
  let now = START;
  const runtime: GateRuntime & { records: unknown[] } = { ...testGateRuntime(), clock: () => now };
  const grants = new RunGrants();
  const raw = { file_path: '.git/hooks/pre-commit', content: '#!/bin/sh\nexit 0\n' };
  const input = (extra: Partial<GateCallInput> = {}): GateCallInput => ({
    tool: writeTool, raw, root, callId: `c-${Math.random()}`, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants,
    buildAuto: async () => undefined, ...extra
  });
  const key = floorCallKey(input());
  return { runtime, grants, input, key, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('approved once, late: the next identical call runs with no card, and the one after asks again', async () => {
  const { runtime, grants, input, key } = setup();
  floorApprovalsOnce(grants).add(key, START);
  const first = await gateToolCall(runtime, input());
  assert.equal(first.approvedOnce, true);
  const second = await gateToolCall(runtime, input());
  assert.equal(second.approvedOnce, undefined, 'not reusable twice');
  assert.equal(second.decision.outcome, 'ask');
});

test('the approval is used up by a refusal of that exact call: the emergency stop, or the caller\'s own refusal', async () => {
  for (const [name, refuse] of [
    ['emergency stop', (input: (extra?: Partial<GateCallInput>) => GateCallInput) => input({ policy: { mode: 'fully-autonomous', emergencyStop: true } })],
    ['caller refusal', (input: (extra?: Partial<GateCallInput>) => GateCallInput) => input()]
  ] as const) {
    const { runtime, grants, input, key } = setup();
    floorApprovalsOnce(grants).add(key, START);
    const refused = name === 'caller refusal'
      ? await gateToolCall(runtime, refuse(input), { refusal: { rule: 'settings.tool-forbidden', reason: 'Refused by the tool.' } })
      : await gateToolCall(runtime, refuse(input));
    assert.equal(refused.decision.outcome, 'deny', name);
    const later = await gateToolCall(runtime, input());
    assert.equal(later.approvedOnce, undefined, `${name}: the approval did not outlive the refused call`);
    assert.equal(later.decision.outcome, 'ask', name);
  }
});

test('the approval is used up when the policy itself refuses that exact call (a failed-closed bundle)', async () => {
  const { runtime, grants, input, key } = setup();
  floorApprovalsOnce(grants).add(key, START);
  const state = failedClosed('unavailable');
  const closed: GateRuntime = { ...runtime, bundleState: () => state };
  const refused = await gateToolCall(closed, input());
  assert.equal(refused.decision.outcome, 'deny');
  const later = await gateToolCall(runtime, input());
  assert.equal(later.approvedOnce, undefined);
});

test('the approval expires after FLOOR_APPROVAL_TTL_MS', async () => {
  const { runtime, grants, input, key, advance } = setup();
  assert.ok(FLOOR_APPROVAL_TTL_MS > 0 && FLOOR_APPROVAL_TTL_MS <= 10 * 60_000, 'a few minutes');
  floorApprovalsOnce(grants).add(key, START);
  advance(FLOOR_APPROVAL_TTL_MS + 1);
  const late = await gateToolCall(runtime, input());
  assert.equal(late.approvedOnce, undefined, 'expired');
  assert.equal(late.decision.outcome, 'ask');
  // Just inside the window it is still good.
  const fresh = setup();
  floorApprovalsOnce(fresh.grants).add(fresh.key, START);
  fresh.advance(FLOOR_APPROVAL_TTL_MS - 1);
  assert.equal((await gateToolCall(fresh.runtime, fresh.input())).approvedOnce, true);
});

test('the approvals end with the run\'s turn: none is kept, and one given after the end is not taken', async () => {
  const { runtime, grants, input, key } = setup();
  floorApprovalsOnce(grants).add(key, START);
  endFloorApprovals(grants);
  assert.equal((await gateToolCall(runtime, input())).approvedOnce, undefined, 'cleared at the end');
  floorApprovalsOnce(grants).add(key, START);
  assert.equal(floorApprovalsOnce(grants).has(key, START), false, 'an approval after the end is not kept');
  assert.equal((await gateToolCall(runtime, input())).approvedOnce, undefined);
});

// PR #74 review round 6 (nit): an approval is stamped and checked with the same clock, the runtime's, never the machine's own: a runtime whose clock is a day
// ahead of the machine still honours an approval given through it, and one given a TTL ago by that clock has expired.
test('a late approval is stamped with the runtime\'s clock, the one the gate checks it with', async () => {
  const { runtime, grants, input, key, advance } = setup();
  advance(24 * 60 * 60_000); // the runtime's clock is a day past the fixed start, far from the machine's
  approveFloorCallLate(grants, key, runtime.clock!);
  assert.equal(floorApprovalsOnce(grants).has(key, runtime.clock!()), true);
  assert.equal((await gateToolCall(runtime, input())).approvedOnce, true, 'honoured by the gate, which reads the same clock');
  approveFloorCallLate(grants, key, runtime.clock!);
  advance(FLOOR_APPROVAL_TTL_MS);
  assert.equal((await gateToolCall(runtime, input())).approvedOnce, undefined, 'expired by that clock');
});

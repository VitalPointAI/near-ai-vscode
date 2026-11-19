// Staff write limits (WP-J5): a staff team's red team may write only its critique and its release guard only its verdicts. The limit is compared after
// the path is resolved, so `..`, an absolute path or a near-miss folder name cannot step out of it, and Write and Edit refuse (never ask) everything else.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { editTool, writeTool } from '../agent/tools';
import type { ToolContext } from '../agent/tools';
import type { StaffTeamBlock } from '../domain/staff/teamBlock';
import { RED_TEAM_PRODUCT, staffGuardFolder, staffProductPath, staffWriteLimit, writeAllowedBy } from '../domain/staff/writeLimits';

const CRITIQUE = staffProductPath('j5', RED_TEAM_PRODUCT);

test('the limits: the red team its critique in its own section, the guard its verdict folder, nobody else, and nothing without a staff block', () => {
  const block = (section: StaffTeamBlock['section']): StaffTeamBlock => ({ section, steps: {}, products: [], layers: [] });
  assert.deepEqual(staffWriteLimit(block('j5'), 'red-team'), [CRITIQUE]);
  assert.deepEqual(staffWriteLimit(block('special-staff'), 'red-team'), ['.planning/staff/products/special-staff/red-team-critique.md']);
  assert.deepEqual(staffWriteLimit(block('j2'), 'release-guard'), ['.planning/staff/products/j2/guard/']);
  assert.equal(staffWriteLimit(block('j5'), 'lead-planner'), undefined);
  assert.equal(staffWriteLimit(undefined, 'red-team'), undefined);
});

test('the write limit: exact files and folders only, compared after resolving, so no path steps out of it', () => {
  assert.equal(writeAllowedBy([CRITIQUE], CRITIQUE), true);
  assert.equal(writeAllowedBy([CRITIQUE], staffProductPath('j5', 'coa-a')), false);
  assert.equal(writeAllowedBy([CRITIQUE], `${CRITIQUE}.bak`), false);
  assert.equal(writeAllowedBy([staffGuardFolder('j5')], `${staffGuardFolder('j5')}coa-a-v1.md`), true);
  assert.equal(writeAllowedBy([staffGuardFolder('j5')], staffGuardFolder('j5')), false);
  assert.equal(writeAllowedBy([staffGuardFolder('j5')], '.planning/staff/products/j5/guardian/x.md'), false);
  assert.equal(writeAllowedBy([staffGuardFolder('j5')], `${staffGuardFolder('j5')}../coa-a.md`), false);
  assert.equal(writeAllowedBy([CRITIQUE], `/${CRITIQUE}`), false);
});

test('Write and Edit refuse a red team write to any plan file, however the path is spelled, and allow its critique', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-j5-'));
  await mkdir(path.join(root, '.planning', 'staff', 'products', 'j5'), { recursive: true });
  await writeFile(path.join(root, staffProductPath('j5', 'coa-a')), 'COA A\n');
  const context = { root, writeOnly: [CRITIQUE], readFiles: new Set<string>() } as unknown as ToolContext;
  const plans = [staffProductPath('j5', 'coa-a'), staffProductPath('j5', 'conops'), `${CRITIQUE}/../coa-a.md`, path.join(root, staffProductPath('j5', 'coa-a')), '.planning/.near-ai/team.md', 'AGENTS.md', '../outside.md'];
  for (const target of plans) {
    assert.ok(await writeTool.forbidden!({ path: target, content: 'x' }, context), `Write ${target} is refused`);
    assert.ok(await editTool.forbidden!({ path: target, oldString: 'COA', newString: 'X', replaceAll: false }, context), `Edit ${target} is refused`);
  }
  assert.equal(await writeTool.forbidden!({ path: CRITIQUE, content: 'findings' }, context), undefined);
  assert.equal(await writeTool.forbidden!({ path: staffProductPath('j5', 'coa-a'), content: 'x' }, { ...context, writeOnly: undefined } as ToolContext), undefined, 'an agent with no limit is unaffected');
  assert.match(String(await writeTool.forbidden!({ path: staffProductPath('j5', 'coa-a'), content: 'x' }, context)), /plan files included/);
  assert.equal(readFileSync(path.join(root, staffProductPath('j5', 'coa-a')), 'utf8'), 'COA A\n');
});


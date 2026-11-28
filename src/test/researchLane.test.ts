// The research workspace's rules (74.1-07 Task 1, D-17): no tools, attachments only from its own folder after symlinks and '..' are resolved, the
// copy-out header added once, and `lane: t0` on every record of a request in the lane (and on no other record).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import { RESEARCH_TEXT, RESEARCH_USE, copyOutHeader, laneAttachmentAllowed, laneToolAllowed, projectFolderOf, recordLaneOf, withCopyOutHeader } from '../domain/gate/researchLane';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import { useTierFor } from '../domain/gate/useTier';
import { routeRecordFor, sessionRouteFrom } from '../gate/sessionMark';
import { testGateRuntime } from './helpers/gatedRuns';

const GLM = 'z-ai/glm-5.3';
const facts = { clientRoute: 'near' as const, host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: { id: GLM, privacyBoundary: 'tee' as const }, attestationFailed: false };
const context = { mark: [], defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: '', routing: DEFAULT_ROUTING };

function folders(): { root: string; lane: string; project: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'lane-')));
  const lane = path.join(root, 'research');
  const project = path.join(root, 'project');
  mkdirSync(lane);
  mkdirSync(project);
  writeFileSync(path.join(lane, 'notes.txt'), 'notes');
  writeFileSync(path.join(project, 'secret.ts'), 'secret');
  return { root, lane, project };
}

test('D-17: the lane offers no tool at all, whatever its name', () => {
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'mcp__github__create_issue', 'Agent', 'read_file', '']) {
    assert.equal(laneToolAllowed(name), false, name);
  }
});

test('D-17: a file inside the lane folder may be attached as it is', () => {
  const { lane } = folders();
  assert.equal(laneAttachmentAllowed(path.join(lane, 'notes.txt'), lane, realpathSync), true);
});

test('D-17: a project file, or any file outside the lane folder, may not be attached directly', () => {
  const { lane, project, root } = folders();
  assert.equal(laneAttachmentAllowed(path.join(project, 'secret.ts'), lane, realpathSync), false);
  assert.equal(laneAttachmentAllowed(path.join(root, 'elsewhere.txt'), lane, realpathSync), false, 'a path that cannot be resolved is refused');
});

test('D-17: \'..\' out of the lane folder is resolved before the check', () => {
  const { lane } = folders();
  assert.equal(laneAttachmentAllowed(path.join(lane, '..', 'project', 'secret.ts'), lane, realpathSync), false);
  assert.equal(laneAttachmentAllowed(`${lane}/../research/notes.txt`, lane, realpathSync), true);
});

test('D-17: a symlink inside the lane folder that points into a project is judged by where it points', () => {
  const { lane, project } = folders();
  const link = path.join(lane, 'looks-local.ts');
  symlinkSync(path.join(project, 'secret.ts'), link);
  assert.equal(laneAttachmentAllowed(link, lane, realpathSync), false);
  assert.equal(projectFolderOf(link, [project], realpathSync), project, 'Q2: the linked file is a project file');
});

test('Q2: a file in an open project is found as the project\'s; a file elsewhere is not', () => {
  const { project, root } = folders();
  writeFileSync(path.join(root, 'download.pdf'), 'x');
  assert.equal(projectFolderOf(path.join(project, 'secret.ts'), [project], realpathSync), project);
  const projectNotes = path.join(project, '..notes');
  mkdirSync(projectNotes);
  writeFileSync(path.join(projectNotes, 'notes.txt'), 'project notes');
  assert.equal(projectFolderOf(path.join(projectNotes, 'notes.txt'), [project], realpathSync), project);
  assert.equal(projectFolderOf(root, [project], realpathSync), undefined, 'the parent is outside the project');
  assert.equal(projectFolderOf(path.join(root, 'download.pdf'), [project], realpathSync), undefined);
  assert.equal(projectFolderOf(path.join(root, 'project-two', 'x.ts'), [project], realpathSync), undefined, 'a sibling folder whose name starts the same is not the project');
});

test('D-17: text copied out starts with the header line, then a blank line, and the header is added once', () => {
  assert.equal(copyOutHeader(GLM), 'From the research workspace, model z-ai/glm-5.3, untrusted');
  const once = withCopyOutHeader(GLM, 'The answer.');
  assert.equal(once, 'From the research workspace, model z-ai/glm-5.3, untrusted\n\nThe answer.');
  assert.equal(withCopyOutHeader(GLM, once), once);
});

test('P21: the lane notice names project files, commands and tools, and the banner is the UI-SPEC\'s', () => {
  assert.equal(RESEARCH_TEXT.laneNotice, 'This is the research workspace. It cannot open project files, run commands or use tools.');
  assert.equal(RESEARCH_TEXT.banner, 'Research workspace. Adversary models allowed. No project data.');
  assert.equal(RESEARCH_TEXT.command, 'Open Research Workspace');
});

test('D-17: the lane use is research only whatever else is set, and its record lane is t0', () => {
  assert.equal(useTierFor({ ...RESEARCH_USE, tools: true, context: 'unattended' }), 'T0');
  assert.equal(recordLaneOf(RESEARCH_USE), 't0');
  assert.equal(recordLaneOf({ tools: true }), undefined);
  assert.equal(recordLaneOf(undefined), undefined);
});

test('D-17, D-23: a record of a request in a lane route says lane t0; a record outside the lane has no lane field', () => {
  const lane = routeRecordFor(sessionRouteFrom(testGateRuntime(), { use: RESEARCH_USE }), { allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' }, facts, { model: GLM }, context);
  assert.equal(lane.unmapped.nearAi.lane, 't0');
  assert.equal(validateDecisionRecord(lane).ok, true);
  const plain = routeRecordFor(sessionRouteFrom(testGateRuntime()), { allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' }, facts, { model: GLM }, context);
  assert.equal(Object.prototype.hasOwnProperty.call(plain.unmapped.nearAi, 'lane'), false);
  assert.equal(validateDecisionRecord(plain).ok, true);
});

test('D-23: the reader refuses a record whose lane is anything but t0', () => {
  const record = buildDecisionRecord({
    recordId: 'r1', sequence: 1, time: 1_700_000_000_000, productVersion: '0.4.39', actor: { kind: 'person', deviceFingerprint: 'device', sessionId: 's' },
    callId: 'infer', capability: { verb: 'infer', tier: 'any-cloud', provider: 'near-ai', model: GLM } as never, resource: { name: GLM, type: 'model' },
    outcome: 'allowed', rule: 'route.any-cloud', bundleHash: '', lane: 't0'
  });
  assert.equal(validateDecisionRecord(record).ok, true);
  for (const lane of ['t1', 'research', 0, null]) {
    const found = validateDecisionRecord({ ...record, unmapped: { nearAi: { ...record.unmapped.nearAi, lane } } });
    assert.equal(found.ok, false, String(lane));
    if (!found.ok) assert.equal(found.path, 'unmapped.nearAi.lane');
  }
});

// Whether a workflow carries on by itself (owner, 2026-11-06): GSD stopped between discuss, plan and execution even in Auto, because NEAR AI never set
// the project flags Open-GSD reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTO_ADVANCE_TEXT, autoAdvanceFlags, carriesOn } from '../domain/autoAdvance';

test('Auto and fully autonomous carry on; the asking modes stop at a boundary', () => {
  assert.equal(carriesOn('auto'), true);
  assert.equal(carriesOn('fully-autonomous'), true);
  assert.equal(carriesOn('approve-risky'), false);
  assert.equal(carriesOn('mostly-autonomous'), false);
});

test('the flags Open-GSD reads are turned on for Auto and off otherwise, and only changed when they differ', () => {
  // A project that never set them: Auto turns both on.
  assert.deepEqual(autoAdvanceFlags('auto', {}), { _auto_chain_active: true, auto_advance: true });
  // Already on: nothing to write, so the file is not rewritten on every flip.
  assert.deepEqual(autoAdvanceFlags('auto', { _auto_chain_active: true, auto_advance: true }), {});
  // Turning Auto off clears the chain flag, and leaves the person's own `auto_advance` alone unless the caller says the extension owns it (0.4.18
  // review: writing `auto_advance: false` over a value somebody chose by hand is wrong).
  assert.deepEqual(autoAdvanceFlags('approve-risky', { _auto_chain_active: true, auto_advance: true }), { _auto_chain_active: false });
  assert.deepEqual(autoAdvanceFlags('approve-risky', { _auto_chain_active: true, auto_advance: true }, { ownsAutoAdvance: true }), { _auto_chain_active: false, auto_advance: false });
  // A mode that already stops writes nothing.
  assert.deepEqual(autoAdvanceFlags('approve-risky', { _auto_chain_active: false, auto_advance: false }), {});
  // The two flags are judged separately, so a half-set project is repaired rather than skipped.
  assert.deepEqual(autoAdvanceFlags('auto', { _auto_chain_active: true, auto_advance: false }), { auto_advance: true });
});

test('the switch says what it does in plain words', () => {
  assert.match(AUTO_ADVANCE_TEXT.on, /starts the next one without asking/);
  assert.match(AUTO_ADVANCE_TEXT.off, /asks before it starts the next one/);
  for (const text of Object.values(AUTO_ADVANCE_TEXT)) assert.equal(/[\u2013\u2014]/.test(text), false, text);
});

test('the project flags are written for Auto and cleared for an asking mode, keeping every other setting', async () => {
  const { mkdir, mkdtemp, readFile, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { planningConfigFile, syncAutoAdvance } = await import('../services/autoAdvanceConfig');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-advance-'));
  await mkdir(path.join(root, '.planning'), { recursive: true });
  const original = { mode: 'yolo', workflow: { plan_check: true, verifier: true, auto_advance: false, node_repair: true }, hooks: { a: 1 } };
  await writeFile(planningConfigFile(root), JSON.stringify(original, null, 2));

  const on = await syncAutoAdvance('auto', root);
  assert.equal(on, AUTO_ADVANCE_TEXT.on, 'the person is told the workflow will carry on');
  const afterAuto = JSON.parse(await readFile(planningConfigFile(root), 'utf8'));
  assert.equal(afterAuto.workflow.auto_advance, true);
  assert.equal(afterAuto.workflow._auto_chain_active, true);
  // Nothing else is disturbed: the settings the person and Open-GSD own stay exactly as they were.
  assert.equal(afterAuto.workflow.plan_check, true);
  assert.equal(afterAuto.workflow.node_repair, true);
  assert.equal(afterAuto.mode, 'yolo');
  assert.deepEqual(afterAuto.hooks, { a: 1 });

  const off = await syncAutoAdvance('approve-risky', root);
  assert.equal(off, AUTO_ADVANCE_TEXT.off);
  const afterManual = JSON.parse(await readFile(planningConfigFile(root), 'utf8'));
  assert.equal(afterManual.workflow._auto_chain_active, false, 'the chain flag the extension owns is cleared');
  // The person's own auto_advance is left as it is, unless the caller says the extension owns it.
  assert.equal(afterManual.workflow.auto_advance, true, 'auto_advance is not overwritten when Auto is turned off');

  // A project without Open-GSD, and a file that cannot be parsed, are both said plainly and never throw.
  assert.equal(await syncAutoAdvance('auto', await mkdtemp(path.join(tmpdir(), 'near-ai-advance-none-'))), undefined);
  await writeFile(planningConfigFile(root), '{ not json');
  assert.match((await syncAutoAdvance('auto', root)) ?? '', /could not be read/);
  assert.equal(await readFile(planningConfigFile(root), 'utf8'), '{ not json', 'a broken file is left exactly as it was');
});

test('the chat shows the carrying-on switch beside the approval picker, and clicking it flips the mode', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const page = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  const markup = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  // One button, right after the approval picker, hidden until the host says what it means.
  assert.match(markup, /id="policy"[^>]*>Approval…<\/button>\s*<button id="advance"/s);
  assert.match(page, /advanceButton\.textContent = state\.on \? 'Carrying on' : 'Stops each step'/);
  assert.match(page, /postFor\(\{ type: 'set-action-policy', mode: /, 'the click goes through the same picker message');
  assert.match(page, /case 'action-policy': renderPolicy\(m\); renderAdvance\(m\);/);
});

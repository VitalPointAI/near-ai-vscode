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
  // Both are cleared together, because Open-GSD carries on only when both are true: clearing one alone would leave the switch doing nothing.
  assert.deepEqual(autoAdvanceFlags('approve-risky', { _auto_chain_active: true, auto_advance: true }), { _auto_chain_active: false, auto_advance: false });
  // A caller that must leave the person's own setting alone can say so.
  assert.deepEqual(autoAdvanceFlags('approve-risky', { _auto_chain_active: true, auto_advance: true }, { ownsAutoAdvance: false }), { _auto_chain_active: false });
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
  // Both are cleared, so Open-GSD really stops at its boundary when a person turns the switch off.
  assert.equal(afterManual.workflow._auto_chain_active, false);
  assert.equal(afterManual.workflow.auto_advance, false);

  // A project without Open-GSD, and a file that cannot be parsed, are both said plainly and never throw.
  assert.equal(await syncAutoAdvance('auto', await mkdtemp(path.join(tmpdir(), 'near-ai-advance-none-'))), undefined);
  await writeFile(planningConfigFile(root), '{ not json');
  assert.match((await syncAutoAdvance('auto', root)) ?? '', /could not be read/);
  assert.equal(await readFile(planningConfigFile(root), 'utf8'), '{ not json', 'a broken file is left exactly as it was');
});

test('the between-steps choice is a picker styled like the approval picker, and offers every way back to asking', () => {
  // Owner, 2026-11-06: "I don't like how Carrying On is shown as a button with white background - and clicking it doesn't let me toggle or choose to go
  // back to asking me between phases. It should blend in and be styled like the auto approval picker."
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const page = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  const markup = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  // A picker beside the approval picker, with its own listbox, like the one it sits next to.
  assert.match(markup, /id="advance"[^>]*aria-haspopup="listbox"[^>]*aria-controls="advance-menu"/);
  assert.match(markup, /id="advance-menu" role="listbox"/);
  // It shares the picker styling rather than sitting there as a bare button.
  assert.match(css, /#model, #policy, #advance \{/);
  assert.match(css, /#advance \{ max-width: 34%; flex: 0 3 auto; text-align: left; \}/);
  // It offers carrying on AND a way back to asking each step, so a person chooses rather than toggles.
  assert.match(page, /optionRow\(CARRY_ON, 'Carry on by itself'/);
  assert.match(page, /'Stop between steps: ' \+ option.label/);
  // Choosing posts the same message the approval picker posts, so the two cannot disagree.
  assert.match(page, /post\(\{ type: 'set-action-policy', mode \}\)/);
});

test('the project scratch folder counts as scratch, so a run can run the helper it just wrote there', async () => {
  const { classifyCommand } = await import('../agent/commandSafety');
  const root = '/work/app';
  const ctx = { root, cwd: root, home: '/home/dev', writtenScratch: [`${root}/.near-ai/scratch/verify.py`] };
  // The run is told to keep helpers here, so following that instruction must not ask.
  assert.equal(classifyCommand('python3 .near-ai/scratch/verify.py', ctx).verdict, 'safe');
  // A script there the run did not write still asks, like anywhere else.
  assert.equal(classifyCommand('python3 .near-ai/scratch/other.py', ctx).verdict, 'unknown');
});

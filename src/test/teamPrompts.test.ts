// The one prompts module of Team Mode (src/services/team/teamPrompts.ts): every input box, pick and message goes to VS Code, except under the
// extension-host tests (NEAR_AI_E2E exactly '1') with a script set, where the script answers and every prompt is recorded (T-61-79).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const promptsModule = require('../services/team/teamPrompts') as typeof import('../services/team/teamPrompts');
test.after(() => { uninstall(); });
const { promptTap, teamPrompts } = promptsModule;

const ORIGINAL_E2E = process.env.NEAR_AI_E2E;

function resetStub(): void {
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.notificationOptions.length = 0;
  stub.inputAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.messageAnswers.length = 0;
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
}

// Runs `work` with NEAR_AI_E2E set to `value` (undefined removes it) and a fresh tap, then puts everything back.
async function withEnv(value: string | undefined, script: Array<{ match: string; answer: string | undefined }> | undefined, work: () => Promise<void>): Promise<void> {
  resetStub();
  if (value === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = value;
  if (script === undefined) delete promptTap.script; else promptTap.script = script;
  promptTap.shown.length = 0;
  try {
    await work();
  } finally {
    if (ORIGINAL_E2E === undefined) delete process.env.NEAR_AI_E2E; else process.env.NEAR_AI_E2E = ORIGINAL_E2E;
    delete promptTap.script;
    promptTap.shown.length = 0;
  }
}

test('without NEAR_AI_E2E exactly 1 every prompt reaches VS Code even when a script is set, and nothing is recorded', async () => {
  for (const value of [undefined, '', '0', 'true', ' 1']) {
    const script = [
      { match: 'Team name', answer: 'From the script' },
      { match: 'Which organization', answer: 'Team Org' },
      { match: 'Connect', answer: 'Connect NEAR AI' },
      { match: 'Shared', answer: 'Show details' }
    ];
    await withEnv(value, script, async () => {
      stub.inputAnswers.push('From VS Code');
      stub.quickPickAnswers.push('Other Org');
      stub.messageAnswers.push(undefined, 'Show details');
      const typed = await teamPrompts.input({ title: 'Enable Team Mode', prompt: 'Team name' });
      const picked = await teamPrompts.pick([{ label: 'Team Org' }, { label: 'Other Org' }], { placeHolder: 'Which organization?' });
      const modal = await teamPrompts.message('warn', 'Connect NEAR AI first', { modal: true, detail: 'Why' }, 'Connect NEAR AI');
      const plain = await teamPrompts.message('info', 'Shared with your team.', undefined, 'Show details');
      assert.equal(typed, 'From VS Code', `input answered by VS Code (NEAR_AI_E2E=${String(value)})`);
      assert.equal(picked?.label, 'Other Org', 'pick answered by VS Code');
      assert.equal(modal, undefined, 'the modal was answered by VS Code (dismissed)');
      assert.equal(plain, 'Show details', 'the message was answered by VS Code');
      assert.equal(stub.inputRequests.length, 1, 'the input box was shown');
      assert.equal(stub.quickPickRequests.length, 1, 'the pick was shown');
      assert.deepEqual(stub.notifications.map((entry) => [entry.level, entry.message]), [['warn', 'Connect NEAR AI first'], ['info', 'Shared with your team.']]);
      assert.deepEqual(stub.notificationOptions[0], { modal: true, detail: 'Why' }, 'the modal flag and detail reach VS Code');
      assert.equal(stub.notificationOptions[1], undefined, 'no options object is invented for a plain message');
      assert.deepEqual(stub.notificationActions, [['Connect NEAR AI'], ['Show details']]);
      assert.deepEqual(promptTap.shown, [], 'nothing is recorded');
      assert.equal(promptTap.script?.length, 4, 'no step was used');
    });
  }
});

test('with NEAR_AI_E2E=1 and a script, an input step answers its prompt, is used up, and VS Code sees nothing', async () => {
  await withEnv('1', [{ match: 'Team name', answer: 'Script team' }, { match: 'Team name', answer: 'Second' }], async () => {
    const first = await teamPrompts.input({ title: 'Enable Team Mode', prompt: 'Team name', value: 'a' });
    const second = await teamPrompts.input({ title: 'Enable Team Mode', prompt: 'Team name', value: 'a' });
    assert.equal(first, 'Script team');
    assert.equal(second, 'Second', 'the first unused step answers, in order');
    assert.equal(promptTap.script?.length, 0, 'both steps were used up');
    assert.equal(stub.inputRequests.length, 0, 'VS Code was not asked');
    assert.deepEqual(promptTap.shown[0], { kind: 'input', text: 'Team name', modal: false, choices: [], answer: 'Script team' });
  });
});

test('a scripted input still passes validateInput: a refusal is recorded as unanswered and resolves undefined', async () => {
  await withEnv('1', [{ match: 'Team name', answer: '   ' }], async () => {
    const required = (value: string): string | undefined => (value.trim() === '' ? 'Enter a value to continue.' : undefined);
    const answer = await teamPrompts.input({ prompt: 'Team name', validateInput: required });
    assert.equal(answer, undefined);
    assert.equal(promptTap.shown[0]?.unanswered, true);
    assert.equal(stub.inputRequests.length, 0);
  });
});

test('the answer to a password input is recorded as hidden, never as the value', async () => {
  await withEnv('1', [{ match: 'Paste the invite', answer: 'secret-invite-value' }], async () => {
    const answer = await teamPrompts.input({ prompt: 'Paste the invite your lead sent you', password: true });
    assert.equal(answer, 'secret-invite-value', 'the code under test still gets the value');
    assert.equal(promptTap.shown[0]?.answer, 'hidden');
    assert.equal(JSON.stringify(promptTap.shown).includes('secret-invite-value'), false, 'the value is nowhere in the record');
  });
});

test('a pick step chooses the first item whose label contains the answer, and a step can match an offered choice', async () => {
  await withEnv('1', [{ match: 'Other Org', answer: 'Other' }], async () => {
    const items = [{ label: 'Team Org', id: 1 }, { label: 'Other Org', id: 2 }, { label: 'Other Org two', id: 3 }];
    const picked = await teamPrompts.pick(items, { title: 'Link Your Organization', placeHolder: 'Which organization pays for the team?' });
    assert.equal(picked?.id, 2, 'the first item whose label contains the answer, as the same object');
    assert.equal(stub.quickPickRequests.length, 0);
    assert.deepEqual(promptTap.shown[0], { kind: 'pick', text: 'Link Your Organization', detail: 'Which organization pays for the team?', modal: false, choices: ['Team Org', 'Other Org', 'Other Org two'], answer: 'Other' });
  });
});

test('a modal message step returns its button, and the record keeps the level, text, detail, modal flag and choices', async () => {
  await withEnv('1', [{ match: 'Connect NEAR AI', answer: 'Connect NEAR AI' }], async () => {
    const answer = await teamPrompts.message('warn', 'NEAR AI is not connected in this project yet.', { modal: true, detail: 'Connecting takes a minute.' }, 'Connect NEAR AI');
    assert.equal(answer, 'Connect NEAR AI');
    assert.deepEqual(promptTap.shown[0], {
      kind: 'message', level: 'warn', text: 'NEAR AI is not connected in this project yet.', detail: 'Connecting takes a minute.', modal: true, choices: ['Connect NEAR AI'], answer: 'Connect NEAR AI'
    });
    assert.equal(stub.notifications.length, 0, 'VS Code showed nothing');
  });
});

test('with a script, an unmatched modal, input or pick resolves undefined as unanswered, and an unmatched plain message is only recorded', async () => {
  await withEnv('1', [{ match: 'something else entirely', answer: 'x' }], async () => {
    assert.equal(await teamPrompts.message('warn', 'Teammates cannot reach this project yet.', { modal: true }, 'Turn on anyway', 'Not now'), undefined);
    assert.equal(await teamPrompts.input({ prompt: 'Team name' }), undefined);
    assert.equal(await teamPrompts.pick([{ label: 'A' }], { placeHolder: 'Pick one' }), undefined);
    assert.equal(await teamPrompts.message('info', 'Team Mode is on for Alpha.', undefined), undefined);
    assert.deepEqual(promptTap.shown.map((record) => [record.kind, record.text, record.unanswered === true]), [
      ['message', 'Teammates cannot reach this project yet.', true],
      ['input', 'Team name', true],
      ['pick', 'Pick one', true],
      ['message', 'Team Mode is on for Alpha.', false]
    ]);
    assert.deepEqual(promptTap.shown[0]?.choices, ['Turn on anyway', 'Not now']);
    assert.equal(promptTap.script?.length, 1, 'the unrelated step is still there');
    assert.equal(stub.notifications.length + stub.inputRequests.length + stub.quickPickRequests.length, 0, 'VS Code saw nothing');
  });
});

test('a step whose answer is undefined dismisses the prompt without counting it as unanswered', async () => {
  await withEnv('1', [{ match: 'Team name', answer: undefined }], async () => {
    assert.equal(await teamPrompts.input({ prompt: 'Team name' }), undefined);
    assert.equal(promptTap.shown[0]?.unanswered, undefined);
    assert.equal(promptTap.script?.length, 0);
  });
});

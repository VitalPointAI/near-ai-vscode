import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentWorkDefault, AGENT_WORK_ANSWERS, KIND_OF_WORK_ANSWERS, parseGuideAnswers } from '../domain/setup/answers';
import { useFor } from '../domain/setup/map';
import * as words from '../domain/setup/words';
import { countHits } from './helpers/copyLintScan';

test('GUIDE-01: Q4 determines the use and Q1 supplies its default', () => {
  assert.deepEqual(AGENT_WORK_ANSWERS.map((agentWork) => useFor({ data: ['public'], agentWork })), ['T2', 'T1', 'T2']);
  for (const [kindOfWork, answer] of [
    ['software', 'agents'], ['analysis', 'answers-only'], ['writing', 'answers-only'], ['staff', 'not-sure'],
  ] as const) {
    assert.equal(agentWorkDefault(kindOfWork), answer);
  }
});

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}

test('D-32, D-43: guide copy uses plain words and leaves a slot for the contact', () => {
  const text = Object.entries(words).filter(([name]) => name.endsWith('_TEXT')).flatMap(([, value]) => strings(value));
  for (const sentence of text) assert.doesNotMatch(sentence, /\b[a-z][a-z\d-]*\/[A-Z]/);
  assert.deepEqual(countHits(text.map((entry) => ({ text: entry })), 'src/domain/setup/words.ts'), {});
  assert.match(words.STOP_CLASSIFIED_TEXT, /\{contact\}/);
});

test('D-50: the four work areas are answers the guide keeps and words', () => {
  assert.equal(parseGuideAnswers({ data: [], kindOfWork: 'resource-management' })?.kindOfWork, 'resource-management');
  assert.equal(parseGuideAnswers({ data: [], kindOfWork: 'operations' }), undefined);
  const choices: Readonly<Record<string, string>> = words.QUESTION_TEXT.q1.choices;
  assert.deepEqual(Object.keys(choices).sort(), [...KIND_OF_WORK_ANSWERS].sort());
  assert.equal(KIND_OF_WORK_ANSWERS.length, 10);
  assert.equal(choices['capability-development'], 'Capability development: programs, products and projects');
  assert.equal(choices.planning, 'Planning: operational or administrative');
  assert.equal(choices['resource-management'], 'Resource management');
  assert.equal(choices['exercises-training'], 'Exercises and training');
  for (const text of Object.values(choices)) assert.doesNotMatch(text, /—/);
});

test('owner D10, D-59: the Defence edition names the folder by its work area, and nothing outside it', () => {
  assert.equal(words.folderNoun('ca-defence', 'planning'), 'plan');
  assert.equal(words.folderNoun('ca-defence', 'resource-management'), 'inventory');
  assert.equal(words.folderNoun('ca-defence', 'exercises-training'), 'exercise or training');
  assert.equal(words.folderNoun('ca-defence', 'capability-development'), 'program, product or project');
  for (const kind of ['software', 'staff', 'something-else', 'folder', 'toString', undefined]) {
    assert.equal(words.folderNoun('ca-defence', kind), 'folder', String(kind));
  }
  for (const kind of ['planning', 'capability-development', undefined]) assert.equal(words.folderNoun(undefined, kind), undefined);
});

test('D-59: folder phrases are rewritten whole, user text only', () => {
  const apply = words.applyFolderWords;
  assert.equal(apply("What will this project's work touch?", 'plan'), "What will this plan's work touch?");
  assert.equal(apply("What will this project's work touch?", 'program, product or project'), "What will this folder's work touch?");
  assert.equal(apply('Set by this project', 'plan'), 'Set by this plan');
  assert.equal(apply('Recommended for this project', 'program, product or project'), 'Recommended for this program, product or project');
  assert.equal(apply('Open a project folder', 'inventory'), 'Open a folder');
  assert.equal(apply('Project label: set to {label}.', 'inventory'), 'Inventory label: set to {label}.');
  assert.equal(apply('Project mode: {name}.', 'exercise or training'), 'Folder mode: {name}.');
  assert.equal(apply('{change} Waits for the next update: shared project settings.', 'plan'), '{change} Waits for the next update: shared settings.');
  assert.equal(apply('Your key is never saved in your project files.', 'plan'), 'Your key is never saved in the files in this folder.');
  assert.equal(apply('This project is already labelled {label}.', 'folder'), 'This folder is already labelled {label}.');
  assert.equal(apply('Set up your project team', 'folder'), 'Set up your software team');
  assert.equal(apply('Plan or manage capital projects', 'plan'), 'Plan or manage capital projects');
  assert.equal(apply('No phrase here.', 'plan'), 'No phrase here.');
  // One pass: the noun's own "project" is never rewritten again.
  assert.equal(apply('this project and the project', 'program, product or project'),
    'this program, product or project and the program, product or project');
});

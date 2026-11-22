import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import type { OptionCard } from '../domain/setup/cards';
import { parseGuideInbound, type GuideInbound, type GuideOutbound } from '../domain/setup/guideMessages';
import { GET_STARTED_BODY, SCREEN_TEXT, type GuideScreenModel } from '../domain/setup/screens';
import { scanPage } from './helpers/a11yScan';
import { FakeDocument, type FakeNode } from './helpers/fakeDom';

const root = path.join(__dirname, '..', '..');
const asset = (name: string) => path.join(root, 'media', 'getStarted', name);
const scripts = ['getStarted.js', 'getStartedScreens.js'];
const base = { heading: 'Step 1 of 3: Kind of work', whoToAsk: 'Who to ask: security@example.org',
  steps: [], completedText: SCREEN_TEXT.completed, pauseText: SCREEN_TEXT.pause } as const;
const question = { ...base, kind: 'question', screen: 'kind-of-work', nextText: SCREEN_TEXT.next,
  choices: [{ value: 'software', text: 'Software' }, { value: 'staff', text: 'Staff work' }],
  fields: [{ key: 'kindOfWork', kind: 'radio', selected: [],
    choices: [{ value: 'software', text: 'Software' }, { value: 'staff', text: 'Staff work' }] }],
  canContinue: false } satisfies GuideScreenModel;

function page() {
  const doc = Object.assign(new FakeDocument(), { title: '' });
  doc.getElementById = (id) => doc.body.find(node => node.getAttribute('id') === id);
  // The committed body has only static scaffolding, with every element inside main a direct child.
  let parent = doc.body;
  for (const [, tag, attrs] of GET_STARTED_BODY.matchAll(/<([a-z][a-z0-9]*) ([^>]+)>/g)) {
    const node = doc.createElement(tag);
    for (const [, key, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(key, value);
    node.id = node.getAttribute('id') ?? '';
    parent.append(node);
    if (tag === 'main') parent = node;
  }
  const content = doc.getElementById('content')!;
  Object.assign(content, { querySelectorAll(selector: string) {
    assert.equal(selector, '[aria-expanded="true"]');
    return content.all(node => node.getAttribute('aria-expanded') === 'true');
  } });
  const messages: GuideInbound[] = [];
  const listeners: ((event: { data: unknown }) => void)[] = [];
  const readyCallbacks: (() => void)[] = [];
  const window = { addEventListener(type: string, callback: (event: { data: unknown }) => void) {
    if (type === 'message') listeners.push(callback);
    if (type === 'DOMContentLoaded') readyCallbacks.push(() => callback({ data: undefined }));
  } };
  const context = createContext({ window, document: doc, acquireVsCodeApi: () => ({
    postMessage(value: unknown) {
      const wire: unknown = JSON.parse(JSON.stringify(value));
      const parsed = parseGuideInbound(wire);
      assert.ok(parsed, JSON.stringify(wire));
      assert.deepEqual(wire, parsed);
      messages.push(parsed);
    },
  }) });
  for (const script of scripts) {
    assert.ok(existsSync(asset(script)), `${script} is required to load the guide`);
    runInContext(readFileSync(asset(script), 'utf8'), context, { filename: script });
  }
  for (const callback of readyCallbacks) callback();
  const send = (data: GuideOutbound | null) => listeners.forEach(listener => listener({ data }));
  const show = (screen: GuideScreenModel) => send({ type: 'screen', screen });
  const get = (id: string) => doc.getElementById(id)!;
  const button = (text: string) => doc.body.find(node => node.tagName === 'button' && node.textContent === text)!;
  const inputs = (type: string) => doc.body.all(node => node.getAttribute('type') === type && node.tagName === 'input');
  return { doc, messages, send, show, get, button, inputs };
}

function textOf(node: FakeNode): string {
  return [node.textContent, ...node.children.map(textOf)].join(' ');
}

function edit(doc: FakeDocument, node: FakeNode, value: string): void {
  node.value = value;
  doc.dispatch('change', node);
}

test('ready and the first screen focus the heading and label the question radios', () => {
  const { doc, messages, show, get, inputs } = page();
  assert.deepEqual(messages, [{ type: 'ready' }]);
  show(question);
  const heading = get('heading');
  assert.equal(doc.activeElement, heading);
  assert.equal(doc.title, heading.textContent);
  assert.match(heading.textContent, /^Step 1 of 3:/);
  const radios = inputs('radio');
  assert.equal(radios.length, 2);
  const field = get('content').find(node => node.tagName === 'fieldset')!;
  assert.equal(field.children[0].textContent, heading.textContent);
  for (const radio of radios) assert.ok(field.find(node => node.getAttribute('for') === radio.getAttribute('id')));
});

test('answer and next use the strict bridge and gate Continue on the host model', () => {
  const { doc, messages, show, inputs, button } = page();
  show(question);
  assert.equal(button(question.nextText).getAttribute('disabled'), '');
  doc.dispatch('change', inputs('radio')[0]);
  show({ ...question, canContinue: true });
  button(question.nextText).click();
  assert.deepEqual(messages.slice(1), [{ type: 'answer', key: 'kindOfWork', value: 'software' }, { type: 'next' }]);
});

test('textContent only keeps host strings as literal text', () => {
  const { show, get } = page();
  const contact = '<a href="https://example.org">Example</a>';
  show({ ...question, whoToAsk: contact });
  assert.equal(get('who-to-ask').textContent, contact);
  for (const script of scripts) assert.doesNotMatch(readFileSync(asset(script), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('checkbox answers post the selected values including when the last tick is cleared', () => {
  const { doc, show, inputs, messages } = page();
  const choices = [{ value: 'internal', text: 'Internal' }];
  show({ ...question, screen: 'data', choices, fields: [{ key: 'data', kind: 'checkbox', choices, selected: [] }] });
  const box = inputs('checkbox')[0];
  Object.assign(box, { checked: true });
  doc.dispatch('change', box);
  Object.assign(box, { checked: false });
  doc.dispatch('change', box);
  assert.deepEqual(messages.slice(1), [
    { type: 'answer', key: 'data', value: ['internal'] }, { type: 'answer', key: 'data', value: [] },
  ]);
});

function card(id: string, outcome: OptionCard['outcome'], extra: Partial<OptionCard> = {}): OptionCard {
  return { optionId: id, kind: 'near-private', title: id, outcome, describedById: 'reason-' + id,
    lines: { where: 'Example device', who: 'Example Organization', proven: 'Connection checked',
      notProven: 'Approval pending', cost: 'No charge per use', speed: 'Fast' },
    approvalNote: 'Approval note', ...extra };
}

const options = { ...base, kind: 'options', heading: SCREEN_TEXT.options, whyText: SCREEN_TEXT.why,
  recommended: [card('near-private', 'recommended', { trustLine: 'Verified' })],
  available: [card('near-all', 'available', { trustLine: 'Allowed' })],
  ruledOut: [card('vendor-tee', 'ruled-out', { outcomeText: 'Not for this work', reason: 'Rules prevent this option.' })],
  notAvailable: [card('org-server:example', 'not-available', { reason: 'Server missing.', fix: { action: 'retry', label: 'Try again' } }),
    card('this-computer', 'not-available', { reason: 'No local service.' })],
  reason: 'The connection matches your answers.', notAvailableText: SCREEN_TEXT.notAvailable,
  checkedOn: 'Checked on: Example device', needsReason: false, canReview: false, reviewText: SCREEN_TEXT.review,
  cardLabels: SCREEN_TEXT.cardLabels, candidatesHeading: SCREEN_TEXT.foundHeading,
  candidates: [
    { id: 'server-one', name: 'Example server', host: 'example.org', port: 443, state: 'found',
      action: 'approve', actionText: 'Approve', stateText: 'Found' },
    { id: 'server-two', name: 'Other server', host: '192.0.2.2', port: 443, state: 'found',
      action: 'ask', actionText: 'Ask your organization.', stateText: 'Found' },
  ],
  scan: { offered: true, ranges: ['192.0.2.0/24'], running: false, label: SCREEN_TEXT.scan,
    confirmText: 'Check the listed addresses?', confirmLabel: SCREEN_TEXT.scanNow, stopLabel: SCREEN_TEXT.scanStop },
} satisfies GuideScreenModel;

test('owner D1 groups the recommendation first and explains ruled-out choices', () => {
  const { show, inputs, get, button } = page();
  show(options);
  assert.equal(get('heading').textContent, options.heading);
  const [recommended, available, ruledOut] = inputs('radio');
  assert.deepEqual(inputs('radio').map(node => node.value), ['near-private', 'near-all', 'vendor-tee']);
  const group = get('content').find(node => node.tagName === 'fieldset')!;
  for (const radio of [recommended, available, ruledOut]) assert.ok(group.contains(radio));
  const cards = group.all(node => node.tagName === 'article');
  assert.deepEqual(cards.slice(0, 2).map(node => node.children.at(-1)?.textContent), ['Verified', 'Allowed']);
  assert.ok(textOf(cards[0]).includes(options.reason));
  assert.equal(ruledOut.getAttribute('aria-disabled'), 'true');
  assert.equal(ruledOut.getAttribute('disabled'), null);
  const reason = get(ruledOut.getAttribute('aria-describedby')!);
  assert.match(textOf(reason), /Not for this work.*Rules prevent this option/);
  const unavailable = button(options.notAvailableText);
  const panel = get(unavailable.getAttribute('aria-controls')!);
  assert.equal(unavailable.getAttribute('aria-expanded'), 'false');
  assert.ok(panel.hidden);
  unavailable.click();
  assert.ok(!panel.hidden);
  assert.match(textOf(panel), /Server missing.*No local service/);
  assert.ok(panel.contains(button('Try again')));
});

test('choosing sends only viable cards and captures a bounded reason', () => {
  const { doc, show, inputs, messages } = page();
  show(options);
  const [, available, ruledOut] = inputs('radio');
  doc.dispatch('change', available);
  assert.ok(doc.dispatch('click', ruledOut).defaultPrevented);
  assert.ok(doc.dispatch('keydown', ruledOut, ' ').defaultPrevented);
  doc.dispatch('change', ruledOut);
  const reasonPrompt = SCREEN_TEXT.reasonPrompt;
  const selected = { ...options, chosen: available.value, needsReason: true, reasonPrompt };
  show(selected);
  inputs('text')[0].focus();
  inputs('text')[0].value = 'The other service is closer.';
  show(selected);
  const reason = inputs('text')[0];
  assert.equal(doc.activeElement, reason);
  assert.equal(reason.value, 'The other service is closer.');
  assert.equal(reason.getAttribute('maxlength'), '200');
  assert.equal(doc.body.find(node => node.getAttribute('for') === reason.getAttribute('id'))?.textContent, reasonPrompt);
  edit(doc, reason, 'The other service is closer.');
  assert.deepEqual(messages.slice(1), [{ type: 'choose', optionId: 'near-all' },
    { type: 'reason', text: 'The other service is closer.' }]);
});

test('fixes and found servers post only offered actions', () => {
  const { show, button, get, messages } = page();
  show(options);
  button(options.notAvailableText).click();
  button('Try again').click();
  button('Approve').click();
  assert.equal(button('Ask your organization.'), undefined);
  assert.match(textOf(get('content')), /Ask your organization/);
  assert.match(textOf(get('content')), /Check the listed addresses/);
  button(options.scan.confirmLabel).click();
  show({ ...options, scan: { ...options.scan, running: true } });
  button(options.scan.stopLabel).click();
  assert.deepEqual(messages.slice(1), [
    { type: 'fix', optionId: 'org-server:example', action: 'retry' }, { type: 'approve-candidate', candidateId: 'server-one' },
    { type: 'scan-confirm', ranges: options.scan.ranges }, { type: 'scan-stop' },
  ]);
});

test('Escape closes Why from inside its facts and restores focus', () => {
  const { doc, show, get, button } = page();
  show(options);
  let why = button(options.whyText);
  assert.equal(why.getAttribute('aria-expanded'), 'false');
  why.click();
  show(options);
  why = button(options.whyText);
  const panel = get(why.getAttribute('aria-controls')!);
  assert.ok(panel.find(node => node.tagName === 'li'));
  assert.equal(why.getAttribute('aria-expanded'), 'true');
  doc.dispatch('keydown', panel, 'Escape');
  assert.equal(why.getAttribute('aria-expanded'), 'false');
  assert.ok(panel.hidden);
  assert.equal(doc.activeElement, why);
});

const changes = (['added', 'changed', 'removed'] as const).map(group => ({
  id: group, group, area: 'connection' as const, text: 'Example change for ' + group, effect: 'apply' as const,
}));
const check = { ...base, kind: 'check', heading: SCREEN_TEXT.check, applyText: SCREEN_TEXT.apply, canApply: true, changes,
  groups: changes.map(item => ({ title: SCREEN_TEXT.groups[item.group], items: [item] })),
  answers: [
    { key: 'kindOfWork', label: 'Kind of work', value: ['Software'], screen: 'kind-of-work',
      changeText: 'Change', changeLabel: 'Change the kind of work' },
    { key: 'canada', label: 'Work in Canada', value: ['Yes'], source: 'Set by your organization' },
  ],
} satisfies GuideScreenModel;

test('check page offers named changes and renders grouped settings before Apply', () => {
  const { show, get, button, messages } = page();
  show(check);
  const headings = get('content').all(node => /^h[2-6]$/.test(node.tagName));
  for (const group of check.groups) assert.ok(headings.some(node => node.textContent === group.title));
  assert.match(textOf(get('content')), /Set by your organization/);
  assert.equal(button('Change').getAttribute('aria-label'), check.answers[0].changeLabel);
  button('Change').click();
  button(check.applyText).click();
  assert.deepEqual(messages.slice(1), [{ type: 'change', screen: 'kind-of-work' }, { type: 'apply' }]);
});

test('Apply requires an explicit removal confirmation when the host requests it', () => {
  const { show, doc, inputs, button, messages } = page();
  show({ ...check, confirmRemovalText: SCREEN_TEXT.confirmRemoval });
  assert.equal(button(check.applyText).getAttribute('disabled'), '');
  const confirm = inputs('checkbox')[0];
  Object.assign(confirm, { checked: true });
  doc.dispatch('change', confirm);
  button(check.applyText).click();
  assert.deepEqual(messages.slice(1), [{ type: 'apply', confirmRemoval: true }]);
});

test('stopped, applying, done and fix render with the actions the host offers', () => {
  const { show, inputs, get, doc, button, messages } = page();
  show({ ...base, kind: 'stopped', heading: SCREEN_TEXT.stopped, nextText: SCREEN_TEXT.next, sentence: 'Ask before continuing.' });
  assert.match(textOf(get('content')), /Ask before continuing/);
  assert.equal(get('who-to-ask').textContent, base.whoToAsk);
  assert.deepEqual(inputs('radio'), []);
  show({ ...base, kind: 'applying', heading: SCREEN_TEXT.applying, pauseText: undefined });
  assert.equal(doc.activeElement, get('heading'));
  assert.deepEqual(get('actions').children, []);
  show({ ...base, kind: 'done', heading: SCREEN_TEXT.partial, pauseText: undefined, doneHeading: 'Done',
    notDoneHeading: 'Still to do', done: [{ id: 'done', text: 'Saved your answers.' }],
    notDone: [{ id: 'pending', text: 'Check the connection.', message: 'Server unavailable.' }],
    landing: { target: 'chat', checklist: [], note: 'Open Chat to start.' }, restartText: SCREEN_TEXT.retry });
  assert.match(textOf(get('content')), /Open Chat to start.*Done.*Saved your answers.*Still to do.*Check the connection.*Server unavailable/);
  button(SCREEN_TEXT.retry).click();
  assert.deepEqual(messages.at(-1), { type: 'change-answers' });
  show({ ...base, kind: 'fix', heading: SCREEN_TEXT.fix, pauseText: undefined, sentence: 'Check with security.' });
  assert.match(textOf(get('content')), /Check with security/);
  assert.equal(get('who-to-ask').textContent, base.whoToAsk);
  assert.deepEqual(doc.body.all(node => node.tagName === 'a' || node.tagName === 'button'), []);
});

test('stepper and live region track current, completed and progress text', () => {
  const { show, send, get, doc } = page();
  show({ ...question, steps: [
    { screen: 'kind-of-work', text: 'Kind of work', state: 'completed' },
    { screen: 'data', text: 'Information', state: 'current' },
  ] });
  const stepper = get('stepper');
  assert.equal(stepper.tagName, 'ol');
  assert.equal(stepper.children[1].getAttribute('aria-current'), 'step');
  assert.equal(stepper.children[0].children[0].className, 'visually-hidden');
  assert.match(textOf(stepper.children[0]), /^\s*Completed:\s+Kind of work/);
  show({ ...base, kind: 'checking', heading: SCREEN_TEXT.checking, checkedOn: options.checkedOn,
    progress: 'Checked 0 of 6', slow: ['Still checking a service.'], continueText: SCREEN_TEXT.continueWithoutSlow });
  assert.match(textOf(get('content')), /Still checking a service/);
  send({ type: 'progress', text: 'Checked 4 of 6' });
  assert.equal(get('live').textContent, 'Checked 4 of 6');
  send(null);
  send({ type: 'announce', text: 'Check complete.' });
  assert.equal(get('live').textContent, 'Check complete.');
  assert.equal(doc.body.all(node => node.getAttribute('aria-live') === 'polite').length, 1);
});

test('keyboard walk reaches Apply in reading order using native controls', () => {
  const { doc, show, messages } = page();
  function press(key: 'Tab' | ' ' | 'Enter') {
    const focused = doc.activeElement!;
    const event = doc.dispatch('keydown', focused, key);
    assert.ok(!event.defaultPrevented);
    // FakeDocument bubbles events. Supply the browser defaults for the native controls used here.
    if (key === 'Tab') {
      const nodes = doc.body.all(() => true);
      const next = nodes.slice(nodes.indexOf(focused) + 1).find(node => {
        for (let parent: FakeNode | undefined = node; parent; parent = parent.parent) if (parent.hidden) return false;
        return (node.tagName === 'input' || node.tagName === 'button') && node.getAttribute('disabled') === null;
      });
      assert.ok(next);
      next.focus();
    } else if (key === ' ' && focused.getAttribute('type') === 'radio') doc.dispatch('change', focused);
    else if (key === 'Enter' && focused.tagName === 'button') focused.click();
  }
  for (const [screen, key, kind, value] of [
    ['kind-of-work', 'kindOfWork', 'radio', 'software'], ['data', 'data', 'checkbox', 'internal'], ['canada', 'canada', 'radio', 'no'],
  ] as const) {
    const choices = [{ value, text: value }];
    const model = { ...question, screen, choices, fields: [{ key, kind, choices, selected: [] }], pauseText: undefined };
    show(model);
    press('Tab');
    if (kind === 'checkbox') {
      assert.ok(!doc.dispatch('keydown', doc.activeElement!, ' ').defaultPrevented);
      Object.assign(doc.activeElement!, { checked: true });
      doc.dispatch('change', doc.activeElement!);
    } else press(' ');
    show({ ...model, canContinue: true, fields: [{ key, kind, choices, selected: [value] }] });
    press('Tab');
    press('Enter');
    assert.deepEqual(messages.at(-1), { type: 'next' });
  }
  const model = { ...options, pauseText: undefined, available: [], ruledOut: [], notAvailable: [], candidates: [],
    scan: { ...options.scan, offered: false } };
  show(model);
  press('Tab');
  press(' ');
  assert.deepEqual(messages.at(-1), { type: 'choose', optionId: 'near-private' });
  show({ ...model, chosen: 'near-private', canReview: true });
  press('Tab');
  press('Tab');
  press('Enter');
  assert.deepEqual(messages.at(-1), { type: 'review' });
  show({ ...check, pauseText: undefined, answers: [] });
  press('Tab');
  press('Enter');
  assert.deepEqual(messages.at(-1), { type: 'apply' });
});

test('the kit scan finds no page accessibility issues', () => {
  page();
  assert.deepEqual(scanPage({ html: GET_STARTED_BODY, script: scripts.map(name => readFileSync(asset(name), 'utf8')).join('\n'),
    css: readFileSync(asset('getStarted.css'), 'utf8'), baseCss: readFileSync(path.join(root, 'media/shared/base.css'), 'utf8'),
    title: 'Get Started' }), []);
});

test('reduced motion keeps all guide controls still', () => {
  assert.ok(existsSync(asset('getStarted.css')));
  const css = readFileSync(asset('getStarted.css'), 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /(?:animation|transition)\s*:\s*(?!none\s*;)[^\s;]/);
});

test('narrow panels stack the cards and wrap the sticky footer', () => {
  assert.ok(existsSync(asset('getStarted.css')));
  const css = readFileSync(asset('getStarted.css'), 'utf8');
  assert.match(css, /#actions\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /@media\s*\(max-width: 480px\)\s*\{[^]*?\.cards\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(css, /#actions\s*\{[^}]*flex-wrap:\s*wrap/);
});
